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
 * it — UNLESS the shared query cache already shows the gate decided elsewhere
 * (finding 04: the live `approval.decided` frame must never be answered by a
 * silent 409). During the hold the bar watches the caches that hold its row —
 * any cached list or row carrying this approval id — and if the gate leaves
 * `pending` there, the hold is cancelled, NOTHING is posted, and the conflict
 * sentence takes the bar's place. When the watch sees only the disappearance
 * (a briefing list that no longer carries the gate), the sentence still owes a
 * name, so the gate row is read once to fill in the decider and the age.
 * A `409 approval_already_decided` adopts the winner (`adoptApproval
 * Conflict`) and states who beat the click; any other error restores the bar
 * with an inline line ending in a Try-again action.
 *
 * The conflict is STICKY and the host owns it: every transition into the
 * conflict state reports a `DecisionConflict` through `onConflict` (the
 * 409 arm and the watched-cache arm alike), so a host whose row leaves its
 * pending list can keep the sentence on screen (rendered back through
 * `initialConflict`) until the person dismisses it. The sentence itself
 * never dies with an unmounting bar.
 *
 * Two honesty rules this component owns, and hosts must not work around:
 *   - **`done` means the server said so.** The recorded line renders only
 *     after the POST resolved. A host that injects `submit` and swallows the
 *     rejection therefore makes the bar lie, so hosts rethrow after their own
 *     cache adoption — see `ApprovalCard`'s `onDecide` contract.
 *   - **The conflict names a person.** The 409 body carries `decided_by`, a
 *     user id, never a name; the sentence resolves it through the directory the
 *     app already reads (`GET /api/v1/users`, the same entry `api/actors.ts`
 *     keys) and says `Someone` only for an id that directory cannot name. The
 *     read happens *when a name is owed* — a bar that decided cleanly, or a
 *     fixture surface that promises zero fetches, asks the network nothing.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { adoptApprovalConflict, approvalConflictOf, useDecideApproval } from "../../api/approvals";
import { apiFetch, problemOf } from "../../api/client";
import { queryKeys } from "../../api/queries";
import { nameLookup } from "../../api/names";
import type { NameHint, NameLookup } from "../../api/names";
import type { Approval, ApprovalDecide, MemberList, Me, UserList } from "../../api/types";
import { formatAge } from "../../lib/format";
import { routes } from "../../lib/routes";
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
  /** The run this gate is waiting on. With it the conflict line can offer
   * `See the run` (finding 12: every error ends in an action); a host whose row
   * carries no run id gets the sentence with no link rather than a dead end.
   * The conflict body itself carries none — the 409 summary is the gate row. */
  run_id?: string;
}

/** The facts of a decision the viewer lost, in the shape a host stores to keep
 * the sentence sticky after its own list drops the row. `deciderId`/`decidedAt`
 * are null when the cache only proved the gate left `pending` without saying
 * who moved it — the bar then reads the gate row once to fill the sentence in. */
export interface DecisionConflict {
  approvalId: string;
  verb: DecisionWord;
  deciderId: string | null;
  decidedAt: string | null;
}

/** The decide body as the bar builds it; the version rides along when known. */
export type DecisionBody = Omit<ApprovalDecide, "version"> & { version?: number };

export type DecisionWord = "approved" | "rejected";

export interface DecisionBarProps {
  approval: DecisionBarApproval;
  /** Notified once the decision is actually posted (the hold expired). */
  onDecided?: (decision: DecisionWord) => void;
  /** Every transition into the conflict state (a 409, or the watched cache
   * showing the gate decided elsewhere) reports here, so the host can keep
   * the sentence rendered even after the row leaves its pending list. */
  onConflict?: (conflict: DecisionConflict) => void;
  /** Boot the bar straight into the sticky conflict sentence — the shape a
   * host renders from its own "recently lost" list while the gate sits
   * outside the pending query. No buttons, no POST, no watching. */
  initialConflict?: DecisionConflict | null;
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
  /** The winner's facts, not a finished sentence: the name arrives with the
   * directory read, so the words are assembled at render time. */
  | {
      kind: "conflict";
      verb: DecisionWord;
      deciderId: string | null;
      decidedAt: string | null;
    };

/** The status line's leading word for a held decision. */
function holdWord(decision: DecisionWord, comments?: string): string {
  if (decision === "approved") return "Approved";
  return comments ? "Changes requested" : "Rejected";
}

/**
 * The conflict's age in the reading voice finding 12 asked for. `formatAge` is
 * the compact column format (`20s`, `4m`) built for a scannable table; the
 * conflict line is a sentence that answers "when did this happen", and
 * `20s ago` reads like a log line, so a sub-minute age is spelled out
 * (`20 seconds ago`). From a minute up the compact form stays — a dense row
 * and the sentence under it must not print the same number two ways.
 */
function conflictAge(decidedAt: string | null): string {
  if (!decidedAt) return "a moment ago";
  const at = new Date(decidedAt).valueOf();
  const seconds = Number.isNaN(at) ? -1 : Math.round((Date.now() - at) / 1000);
  if (seconds < 0 || seconds >= 60) return `${formatAge(decidedAt)} ago`;
  return `${seconds} second${seconds === 1 ? "" : "s"} ago`;
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** The decided-state fields a cached copy of the gate may carry (the shared
 * row, or the same row inside any list the app caches). */
type GateFacts = {
  state: string;
  decision?: string | null;
  decided_by?: unknown;
  decided_at?: unknown;
  updated_at?: unknown;
};

function gateRowFacts(value: unknown, id: string): GateFacts | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (row.id !== id || typeof row.state !== "string") return null;
  return row as unknown as GateFacts;
}

/** Find this gate inside one cached query's data: the row itself, or an entry
 * of its `approvals`/`items` array. Keys are never inspected — the id match
 * plus a `state` field is the whole contract, so a new list shape that
 * carries the row is watched for free. */
function findGateInData(data: unknown, id: string): GateFacts | null {
  const direct = gateRowFacts(data, id);
  if (direct) return direct;
  if (!data || typeof data !== "object") return null;
  const bag = data as Record<string, unknown>;
  for (const key of ["approvals", "items"]) {
    const list = bag[key];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const hit = gateRowFacts(entry, id);
      if (hit) return hit;
    }
  }
  return null;
}

/** Run `effect` at most once per mount, on the first commit where `armed` is
 * true (a conflict that owes the winner's facts arms exactly once). */
function useEffectOnce(armed: boolean, effect: () => void): void {
  const ranRef = useRef(false);
  useEffect(() => {
    if (!armed || ranRef.current) return;
    ranRef.current = true;
    effect();
    // The effect closes over the CURRENT props/phase; it only ever runs on
    // the commit where `armed` first turns true, which is exactly the
    // arming the caller computes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [armed]);
}

/** Upper-case the first letter: the subject opens the sentence, and a display
 * name arrives however its owner typed it. */
function sentenceStart(words: string): string {
  return words.length === 0 ? words : words[0].toUpperCase() + words.slice(1);
}

/**
 * Who won the click, in words. A gate's `decided_by` is a user id — a uuid in a
 * sentence nobody can read — so it goes through the directory the app already
 * reads. A policy pseudo-id (`profile_policy:deny`, ADR-0039) names no person,
 * and the last honest word for an id the directory cannot name is `Someone`.
 */
function conflictSubject(deciderId: string | null, lookup: NameLookup): string {
  if (!deciderId || deciderId.includes(":")) return "Someone";
  return sentenceStart(lookup(deciderId) ?? "Someone");
}

export default function DecisionBar({
  approval,
  onDecided,
  onConflict,
  initialConflict = null,
  compact = false,
  submit,
}: DecisionBarProps) {
  const decide = useDecideApproval(approval.project_id ?? "");
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<Phase>(() =>
    initialConflict
      ? {
          kind: "conflict",
          verb: initialConflict.verb,
          deciderId: initialConflict.deciderId,
          decidedAt: initialConflict.decidedAt,
        }
      : { kind: "idle" },
  );
  // The latest phase and the latest host callback, readable from the cache
  // subscription and the unmount flush (both fire outside the render).
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const onConflictRef = useRef(onConflict);
  onConflictRef.current = onConflict;
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
            | {
                decision?: string | null;
                decided_by?: unknown;
                decided_at?: unknown;
                updated_at?: unknown;
              }
            | undefined;
          const verb: DecisionWord = winner?.decision === "rejected" ? "rejected" : "approved";
          const winnerId =
            typeof winner?.decided_by === "string" && winner.decided_by.length > 0
              ? winner.decided_by
              : null;
          // The conflict body is a summary; the timestamp it serves (either
          // one) is what the age is measured from.
          const decidedAt =
            typeof winner?.decided_at === "string"
              ? winner.decided_at
              : typeof winner?.updated_at === "string"
                ? winner.updated_at
                : null;
          setPhase({ kind: "conflict", verb, deciderId: winnerId, decidedAt });
          onConflictRef.current?.({
            approvalId: approval.id,
            verb,
            deciderId: winnerId,
            decidedAt,
          });
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
    // Finding 04: navigating away still posts the held decision — but not
    // when the cache already shows the gate decided elsewhere. The live
    // `approval.decided` frame that removed this row must not be answered
    // with a silent 409; `detectElsewhere` cancels and reports instead.
    if (detectRef.current()) return;
    const held = holdRef.current;
    holdRef.current = null;
    void postRef.current(held.decision, held.comments);
  };
  // DECLARED BEFORE the watch effect so its cleanup runs first on unmount:
  // the flush below still needs the watch's baseline of which caches carried
  // this gate. (React runs a component's cleanup functions in declaration
  // order.)
  useEffect(
    () => () => {
      // Unmount during the hold: post immediately rather than dropping the
      // decision. (An unmount after the POST already went out has no
      // holdRef left, so nothing fires twice.)
      flushRef.current();
    },
    [],
  );

  // ---- The watched approval (finding 04) --------------------------------
  // While a hold is open the bar watches every cached query that carries its
  // gate — the shared `queryKeys.approval(id)` row (patched by a conflict
  // adoption, refetched by `useApproval`), the pending-list caches the hosts
  // read (`useHomeApprovals`, `useProjectApprovals`) — through the query
  // cache itself, so a frame that moved the gate moves the bar with no
  // extra network. Two signals end the hold WITHOUT posting:
  //   - a cached copy of the row says `state !== "pending"` → its fields
  //     carry the winner; or
  //   - a cache that carried the gate at hold start no longer carries it →
  //     the gate left the pending set; the name arrives from one row read
  //     (below), so the sentence still names a person.
  const seenRef = useRef<Set<string> | null>(null);
  const detectRef = useRef<() => boolean>(() => false);
  detectRef.current = () => {
    const held = phaseRef.current;
    if (held.kind !== "hold") return false;
    const present = new Set<string>();
    let facts: GateFacts | null = null;
    for (const query of queryClient.getQueryCache().getAll()) {
      const hit = findGateInData(query.state.data, approval.id);
      if (!hit) continue;
      present.add(JSON.stringify(query.queryKey));
      if (hit.state !== "pending" && facts === null) facts = hit;
    }
    let gone = false;
    const seen = seenRef.current;
    if (seen !== null) {
      for (const key of seen) if (!present.has(key)) gone = true;
      for (const key of present) seen.add(key);
    }
    if (facts !== null) return lostTo(facts, held);
    if (gone) return lostTo(null, held);
    return false;
  };

  const lostTo = (facts: GateFacts | null, held: { kind: "hold"; decision: DecisionWord }) => {
    clearTimer();
    holdRef.current = null;
    const me = queryClient.getQueryData<Me>(queryKeys.me);
    const deciderId =
      typeof facts?.decided_by === "string" && facts.decided_by.length > 0
        ? facts.decided_by
        : null;
    const decidedAt =
      typeof facts?.decided_at === "string"
        ? facts.decided_at
        : typeof facts?.updated_at === "string"
          ? facts.updated_at
          : null;
    const verb: DecisionWord =
      facts?.decision === "rejected"
        ? "rejected"
        : facts?.decision === "approved"
          ? "approved"
          : held.decision;
    // The same person deciding from another tab IS recorded — say `done`,
    // not "wasn't recorded". Only a decider who is not the viewer loses.
    if (deciderId !== null && me !== undefined && deciderId === me.id) {
      setPhase({ kind: "done", decision: verb });
      return true;
    }
    setPhase({ kind: "conflict", verb, deciderId, decidedAt });
    onConflictRef.current?.({ approvalId: approval.id, verb, deciderId, decidedAt });
    return true;
  };

  const watching = phase.kind === "hold";
  useEffect(() => {
    if (!watching) return;
    if (seenRef.current === null) {
      const seed = new Set<string>();
      for (const query of queryClient.getQueryCache().getAll()) {
        if (findGateInData(query.state.data, approval.id)) {
          seed.add(JSON.stringify(query.queryKey));
        }
      }
      seenRef.current = seed;
    }
    if (detectRef.current()) return;
    const unsubscribe = queryClient.getQueryCache().subscribe(() => {
      detectRef.current();
    });
    return () => {
      unsubscribe();
      seenRef.current = null;
    };
    // The baseline must reset whenever the hold opens or closes; the
    // detection itself reads everything else through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watching, approval.id]);

  // When the watch proved only the disappearance, the sentence still owes a
  // name and an age: read the gate row ONCE (`queryKeys.approval(id)`, the
  // key the whole app shares, so a host (or the sticky re-render of this
  // bar) already holding the row answers from cache and pays nothing). This
  // fires only for a watched-away conflict — never for a clean decision,
  // never for a 409 body that named its winner.
  const factsOwed = phase.kind === "conflict" && phase.deciderId === null;
  useEffectOnce(factsOwed, () => {
    if (!factsOwed) return;
    void queryClient
      .fetchQuery({
        queryKey: queryKeys.approval(approval.id),
        queryFn: () => apiFetch<Approval>(`/api/v1/approvals/${approval.id}`),
        retry: false,
      })
      .then((fetched) => {
        const row = fetched as unknown as GateFacts & { decision?: string | null };
        const decider = typeof row.decided_by === "string" ? row.decided_by : null;
        const at =
          typeof row.decided_at === "string"
            ? row.decided_at
            : typeof row.updated_at === "string"
              ? row.updated_at
              : null;
        const verb: DecisionWord = row.decision === "rejected" ? "rejected" : "approved";
        const me = queryClient.getQueryData<Me>(queryKeys.me);
        if (decider !== null && me !== undefined && decider === me.id) {
          setPhase({ kind: "done", decision: verb });
          return;
        }
        setPhase({ kind: "conflict", verb, deciderId: decider, decidedAt: at });
        onConflictRef.current?.({
          approvalId: approval.id,
          verb,
          deciderId: decider,
          decidedAt: at,
        });
      })
      .catch(() => {
        // The row could not be read: the sentence keeps `Someone` and
        // `a moment ago` — honest words for facts nobody served.
      });
  });

  // The hold's Undo link takes focus the moment the bar folds into the
  // status line, so keyboard users land on the escape hatch they just bought.
  useEffect(() => {
    if (phase.kind === "hold") undoRef.current?.focus();
    if (phase.kind === "changes") changesRef.current?.focus();
  }, [phase.kind]);

  // A conflict names a person, and the 409 body only carries their id, so the
  // directory is read when a name is OWED — never to draw the bar: a clean
  // decision asks the network nothing, and the fixture surface (`M4Preview`,
  // whose whole promise is zero fetches) must keep that. Both keys are ones
  // `api/actors.ts` reads, so a live surface pays no extra request.
  const deciderId = phase.kind === "conflict" ? phase.deciderId : null;
  const owesAName = deciderId !== null && !deciderId.includes(":");
  const users = useQuery({
    queryKey: queryKeys.users,
    queryFn: () => apiFetch<UserList>("/api/v1/users"),
    enabled: owesAName,
    retry: false,
  });
  const members = useQuery({
    queryKey: queryKeys.members(approval.project_id ?? ""),
    queryFn: () => apiFetch<MemberList>(`/api/v1/projects/${approval.project_id}/members`),
    enabled: owesAName && Boolean(approval.project_id),
    retry: false,
  });
  const lookup = useMemo<NameLookup>(() => {
    const me = queryClient.getQueryData<Me>(queryKeys.me);
    const hints: NameHint[] = [
      ...(users.data?.items ?? []).map((user) => [user.id, user.display_name] satisfies NameHint),
      ...(members.data?.items ?? []).map(
        (member) => [member.user_id, member.display_name] satisfies NameHint,
      ),
      // The caller is the commonest decider on the screen, and every live
      // surface already holds their own row.
      ...(me ? ([[me.id, me.display_name]] satisfies NameHint[]) : []),
    ];
    return nameLookup(hints);
  }, [users.data, members.data, queryClient]);

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
          × {conflictSubject(phase.deciderId, lookup)} {phase.verb} this{" "}
          {conflictAge(phase.decidedAt)}. Your decision wasn&apos;t recorded.{" "}
          {approval.run_id ? (
            /* Finding 12: the sentence says the click did not land; this is the way
               to the decision that did. A plain anchor, not a router `Link`: this bar
               renders on fixture surfaces that mount no router, and a full document
               load from a conflict line is cheaper than a crash. */
            <a
              href={routes.run(approval.run_id)}
              className="ml-[4px] font-medium text-accent-text underline decoration-accent-mid"
              data-testid="decision-conflict-run"
            >
              See the run
            </a>
          ) : null}
        </p>
      )}
    </div>
  );
}
