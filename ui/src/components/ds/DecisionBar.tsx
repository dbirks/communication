/**
 * DecisionBar — the ONE workflow-gate decision bar (finding 04). Every gate
 * surface (Today, Inbox, the Approval page, the run workbench) renders this
 * same component with the same FIXED verbs: `Approve` (primary), `Request
 * changes` (secondary) and `Reject` (danger). Model-written labels never
 * appear on these buttons — model text belongs in the summary ABOVE the bar,
 * owned by the caller. There is no confirm step: a click holds the POST for
 * ~5 seconds behind an Undo link, which is the safety the old confirm step
 * bought without teaching people to click through a second prompt.
 *
 * Wire mapping (`POST /api/v1/approvals/{id}/decide`, `{decision,
 * comments?, version}`): the API only knows `approved` | `rejected`, so
 *   - Approve          → `{decision: "approved", version}`
 *   - Reject           → `{decision: "rejected", version}`
 *   - Request changes  → `{decision: "rejected", version, comments: <text>}`
 *     — the textarea is required and capped at 8 KiB; the note IS the
 *     difference between a plain reject and "change this, then re-ask".
 *
 * The hold window: clicking a verb replaces the bar IN PLACE with a
 * `role="status"` line (`Approved. The run continues in 5s.`, counting down)
 * and an Undo link-button that receives focus. Undo cancels the hold and
 * sends nothing. If the bar unmounts mid-hold the decision is flushed
 * immediately — the person decided; navigating away must not silently drop
 * it. A `409 approval_already_decided` adopts the winner (`adoptApproval
 * Conflict`) and states who beat the click; any other error restores the bar
 * with an inline line ending in a Try-again action.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { adoptApprovalConflict, approvalConflictOf, useDecideApproval } from "../../api/approvals";
import { problemOf } from "../../api/client";
import type { ApprovalDecide } from "../../api/types";
import { formatAge } from "../../lib/format";
import { Button } from "./Button";

/** How long the Undo window stays open before the decision is posted. */
export const DECISION_HOLD_SECONDS = 5;

/** The "Request changes" note cap: 8 KiB of UTF-8, the server's comment cap. */
export const MAX_COMMENTS_BYTES = 8 * 1024;

/** The row fields the bar needs; `Approval` and the run-view projection both
 * satisfy it. `version` is the CAS token — required when the bar owns the
 * POST; a presentational host injecting `submit` may omit it (its parent
 * re-reads the row and sends the real token). `project_id` is likewise only
 * needed by the default POST path. */
export interface DecisionBarApproval {
  id: string;
  version?: number;
  project_id?: string;
}

/** The decide body as the bar builds it; the version rides along when known. */
export type DecisionBody = Omit<ApprovalDecide, "version"> & { version?: number };

export type DecisionWord = "approved" | "rejected";

export interface DecisionBarProps {
  approval: DecisionBarApproval;
  /** Notified once the decision is actually posted (the hold expired). */
  onDecided?: (decision: DecisionWord) => void;
  /** 26px inline buttons for dense surfaces (Today, Inbox). */
  compact?: boolean;
  /**
   * Host-owned POST for presentational hosts (the Inbox card) whose parent
   * already owns the decide mutation. It receives the exact wire body; when
   * it rejects with the server's error the bar handles 409s like its own.
   * Omit to let the bar post `POST /approvals/{id}/decide` itself — that
   * path needs `approval.version` and `approval.project_id`.
   */
  submit?: (body: DecisionBody) => Promise<unknown> | unknown;
}

type Phase =
  | { kind: "idle" }
  | { kind: "changes" }
  | { kind: "hold"; decision: DecisionWord; comments?: string; remaining: number }
  | { kind: "posting"; decision: DecisionWord }
  | { kind: "done"; decision: DecisionWord }
  | { kind: "conflict"; sentence: string };

/** The status line's leading word for a held decision. */
function holdWord(decision: DecisionWord, comments?: string): string {
  if (decision === "approved") return "Approved";
  return comments ? "Changes requested" : "Rejected";
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

export default function DecisionBar({
  approval,
  onDecided,
  compact = false,
  submit,
}: DecisionBarProps) {
  const decide = useDecideApproval(approval.project_id ?? "");
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [changesText, setChangesText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const undoRef = useRef<HTMLButtonElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const changesRef = useRef<HTMLTextAreaElement | null>(null);

  const post = useCallback(
    async (decision: DecisionWord, comments?: string) => {
      const body: DecisionBody = {
        decision,
        ...(comments ? { comments } : {}),
        ...(approval.version !== undefined ? { version: approval.version } : {}),
      };
      setPhase({ kind: "posting", decision });
      try {
        if (submit) await submit(body);
        else if (approval.version !== undefined)
          await decide.mutateAsync({
            approvalId: approval.id,
            body: { decision, ...(comments ? { comments } : {}), version: approval.version },
          });
        else
          throw new Error("DecisionBar: approval.version is required when the bar owns the POST");
        setPhase({ kind: "done", decision });
        onDecided?.(decision);
      } catch (cause) {
        const conflict = approvalConflictOf(cause);
        if (conflict) {
          adoptApprovalConflict(queryClient, cause);
          const winner = conflict.approval as
            | { decision?: string | null; decided_by_name?: unknown; decided_at?: unknown }
            | undefined;
          const verb = winner?.decision === "rejected" ? "rejected" : "approved";
          const name =
            typeof winner?.decided_by_name === "string" && winner.decided_by_name.length > 0
              ? winner.decided_by_name
              : "Someone";
          const decidedAt = typeof winner?.decided_at === "string" ? winner.decided_at : null;
          const age = decidedAt ? `${formatAge(decidedAt)} ago` : "a moment ago";
          setPhase({ kind: "conflict", sentence: `${name} ${verb} this ${age}.` });
        } else {
          const problem = problemOf(cause);
          setError(problem.detail || problem.title || "The decision could not be posted.");
          setPhase({ kind: "idle" });
        }
      }
    },
    [approval.id, approval.version, decide, onDecided, queryClient, submit],
  );

  // The hold timer: one tick per second; at zero the decision posts. Held in
  // a ref so the unmount flush below always sees the live closure.
  const postRef = useRef(post);
  postRef.current = post;
  const holdRef = useRef<{ decision: DecisionWord; comments?: string } | null>(null);

  const clearTimer = () => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  const startHold = (decision: DecisionWord, comments?: string) => {
    setError(null);
    holdRef.current = { decision, comments };
    setPhase({ kind: "hold", decision, comments, remaining: DECISION_HOLD_SECONDS });
    let remaining = DECISION_HOLD_SECONDS;
    timerRef.current = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        clearTimer();
        const held = holdRef.current;
        holdRef.current = null;
        if (held) void postRef.current(held.decision, held.comments);
      } else {
        setPhase({ kind: "hold", decision, comments, remaining });
      }
    }, 1000);
  };

  // Undo and unmount both go through the same cancel path; the unmount one
  // flushes instead (the decision stands — only the undo cancels it).
  const undo = () => {
    clearTimer();
    holdRef.current = null;
    setPhase({ kind: "idle" });
  };

  const flushRef = useRef<() => void>(() => {});
  flushRef.current = () => {
    if (!holdRef.current) return;
    clearTimer();
    const held = holdRef.current;
    holdRef.current = null;
    void postRef.current(held.decision, held.comments);
  };
  useEffect(
    () => () => {
      // Unmount during the hold: post immediately rather than dropping the
      // decision. (An unmount after the POST already went out has no
      // holdRef left, so nothing fires twice.)
      flushRef.current();
    },
    [],
  );

  // The hold's Undo link takes focus the moment the bar folds into the
  // status line, so keyboard users land on the escape hatch they just bought.
  useEffect(() => {
    if (phase.kind === "hold") undoRef.current?.focus();
    if (phase.kind === "changes") changesRef.current?.focus();
  }, [phase.kind]);

  const canSendChanges =
    changesText.trim().length > 0 && utf8Bytes(changesText) <= MAX_COMMENTS_BYTES;

  const buttonSize = compact ? { compact: true } : {};

  return (
    <div data-testid="decision-bar">
      {phase.kind === "idle" || phase.kind === "changes" ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              {...buttonSize}
              data-testid="decision-approve"
              onClick={() => startHold("approved")}
            >
              Approve
            </Button>
            <Button
              variant="secondary"
              {...buttonSize}
              data-testid="decision-request-changes"
              onClick={() => setPhase({ kind: "changes" })}
            >
              Request changes
            </Button>
            <Button
              variant="danger"
              {...buttonSize}
              data-testid="decision-reject"
              onClick={() => startHold("rejected")}
            >
              Reject
            </Button>
          </div>
          {phase.kind === "changes" ? (
            <div className="mt-2">
              <textarea
                ref={changesRef}
                rows={2}
                className="w-full"
                placeholder="What should change?"
                aria-label="What should change?"
                data-testid="decision-changes-text"
                value={changesText}
                onChange={(event) => setChangesText(event.target.value)}
              />
              <div className="mt-1 flex items-center gap-2">
                <Button
                  variant="primary"
                  {...buttonSize}
                  disabled={!canSendChanges}
                  data-testid="decision-changes-send"
                  onClick={() => {
                    if (!canSendChanges) return;
                    const comments = changesText.trim();
                    setChangesText("");
                    startHold("rejected", comments);
                  }}
                >
                  Send
                </Button>
                <Button variant="ghost" {...buttonSize} onClick={() => setPhase({ kind: "idle" })}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : null}
          {error ? (
            <p
              className="mt-[6px] font-mono text-[10.5px] text-st-failed-tag-fg"
              role="alert"
              data-testid="decision-error"
            >
              × {error}{" "}
              <button
                type="button"
                className="font-medium text-accent-text underline decoration-accent-mid"
                onClick={() => setError(null)}
              >
                Try again.
              </button>
            </p>
          ) : null}
        </>
      ) : phase.kind === "hold" ? (
        <p
          className="flex flex-wrap items-center gap-2 font-mono text-[11.5px] text-ink"
          role="status"
          data-testid="decision-status"
        >
          {holdWord(phase.decision, phase.comments)}. The run continues in {phase.remaining}s.{" "}
          <button
            ref={undoRef}
            type="button"
            className="font-semibold text-accent-text underline decoration-accent-mid"
            data-testid="decision-undo"
            onClick={undo}
          >
            Undo
          </button>
        </p>
      ) : phase.kind === "posting" ? (
        <p
          className="font-mono text-[11.5px] text-muted"
          role="status"
          data-testid="decision-status"
        >
          {holdWord(phase.decision)} — posting…
        </p>
      ) : phase.kind === "done" ? (
        <p
          className="font-mono text-[11.5px] text-muted"
          role="status"
          data-testid="decision-status"
        >
          {holdWord(phase.decision)}. Your decision is recorded.
        </p>
      ) : (
        <p
          className="mt-[2px] font-mono text-[11px] text-st-failed-tag-fg"
          role="alert"
          data-testid="decision-conflict"
        >
          × {phase.sentence} Your decision wasn&apos;t recorded.
        </p>
      )}
    </div>
  );
}
