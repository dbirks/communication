/**
 * The gate card (ALERT-K in the waiting set) — the one panel in the run
 * inspector where a royal button is correct, because royal means *you can act*.
 *
 * Three arms, all of them the server's facts:
 *   - pending and you are a designated approver  → the decision form;
 *   - pending and you are not                    → the card, no buttons, and
 *     the reason in words (`10` J3, `docs/m4-contract.md` § 7.2 W3/C9b);
 *   - decided / expired / denied                 → the outcome, who, when, and
 *     for a denied gate the reason the approver set stopped applying.
 *
 * The decision posts the row's `version` as a CAS token: a concurrent decision
 * is a *conflict*, stated as one, never a silent overwrite. And a `rejected`
 * decision is a business outcome, NOT an execution failure
 * (`docs/m4-contract.md` § 5.3, C9e; `03`:49's success/fail split applied to
 * gates): the gate row closes `succeeded` with outcome `rejected`, the
 * dependants its graph guards on the decision don't run, and the run settles
 * on the pipeline's terms — only an unanswered DEADLINE fails the node
 * (`approval_expired`). The copy below says exactly that; the old
 * "rejecting fails this run" promise contradicted the engine and is gone.
 */
import { useState } from "react";
import type { ApprovalDecision, ApprovalDetail } from "../../lib/pipeline/contract";
import { deciderLabel, fallbackName } from "../../api/actors";
import { Panel } from "../ds/Panel";
import { Button } from "../ds/Button";
import { Field, Textarea } from "../ds/Field";
import { StatusChip } from "../ds/Row";
import { APPROVAL_STATE, SHORT_WORD, stateOf } from "../ds/states";
import { formatAge, formatRemaining, formatTime } from "../../lib/format";
import { PlanView, splitPlanText } from "./PlanView";

export interface ApprovalCardProps {
  approval: ApprovalDetail;
  /** Server-told, never guessed from a role name: the API is the decider about
   * who may decide (route 35's approver arrays plus the caller's own identity). */
  canDecide: boolean;
  /** `version` travels back as the CAS token; the caller owns the POST. */
  onDecide?: (input: {
    approvalId: string;
    decision: ApprovalDecision;
    comments: string;
    version: number;
  }) => void;
  pending?: boolean;
  /** A 409 from a concurrent decision, shown in place rather than as a toast. */
  conflictError?: string | null;
  /** Wall clock for the countdown; injectable so a test can freeze it. */
  now?: () => number;
  headingId?: string;
  className?: string;
  /**
   * Words for the person who decided, from the app's actor directory
   * (`api/actors.ts` — the same lookup the transcript and the timeline use).
   * A gate's `decided_by` is a user id, and a uuid is unreadable in a decision
   * record: the pass-2 review read `01a18c3e-5347-…` where it should have read
   * a name. A screen without a directory still says `someone (2d22c36)`, never
   * a bare uuid (`names.ts`'s rule).
   */
  nameOf?: (userId: string) => string;
}

export function ApprovalCard({
  approval,
  canDecide,
  onDecide,
  pending = false,
  conflictError = null,
  now = Date.now,
  headingId = "approval-card-heading",
  className = "",
  nameOf = fallbackName,
}: ApprovalCardProps) {
  const [comments, setComments] = useState("");
  const state = stateOf(APPROVAL_STATE[approval.state]);
  // A summary can be prose, or a title line with the planner's JSON document
  // glued to it. The JSON is decoded rather than printed (`PlanView`).
  const summary = splitPlanText(approval.summary);
  const open = approval.state === "pending";
  const deadline = new Date(approval.deadline_at).valueOf();
  const remainingMs = Number.isNaN(deadline) ? null : deadline - now();
  const deadlineExact = formatTime(approval.deadline_at);
  /** A closed gate's deadline, in the same relative words: it says whether the
   * gate closed inside its own deadline or after it, and by how much — never a
   * countdown to a deadline already behind (the copy rules refuse that
   * optimistic render), never an ISO string. The exact instant is the `title`. */
  const closedDeadlineWords = Number.isNaN(deadline)
    ? deadlineExact
    : deadline < now()
      ? `passed ${formatAge(approval.deadline_at, now())} ago`
      : approval.decided_at && Date.parse(approval.decided_at) < deadline
        ? `closed with ${formatRemaining(approval.deadline_at, Date.parse(approval.decided_at))}`
        : approval.state === "expired"
          ? "the deadline passed"
          : "closed before its deadline";

  return (
    <Panel
      title={approval.kind === "promotion_deferred" ? "DEFERRED PROMOTION" : "GATE"}
      headingId={headingId}
      headingLevel={3}
      state={open && canDecide ? "waiting" : state === "failed" ? "failed" : undefined}
      // An OPEN gate says the design's own call to action; a CLOSED one says its
      // state in the app's SHORT_WORD (identity rule 06: the same word the strip,
      // the tree, the graph node and the pane header use for that colour), never
      // the wire's `decided` / `expired` / `cancelled` token. WHO decided and WHAT
      // they said is the decision record below, which carries the difference the
      // short word folds.
      meta={
        <StatusChip
          state={state}
          label={open ? "needs your decision" : SHORT_WORD[state]}
          labelProps={{ "data-testid": "approval-state" }}
        />
      }
      className={className}
    >
      <div className="space-y-[10px] p-[10px]">
        <div data-testid="approval-summary">
          {summary.title ? (
            <p className="text-[13.5px] leading-[20px]" data-testid="approval-summary-title">
              {summary.title}
            </p>
          ) : null}
          <PlanView text={summary.body} className="mt-[2px]" />
        </div>

        <dl className="grid gap-x-6 gap-y-1 font-mono text-[11px] text-ink-2 sm:grid-cols-2">
          <div className="flex gap-2">
            <dt className="text-muted">node</dt>
            <dd data-testid="approval-node">{approval.node_instance_key}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-muted">approver roles</dt>
            <dd data-testid="approval-roles">
              {approval.approver_roles.join(", ") || "named users only"}
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-muted">on timeout</dt>
            <dd data-testid="approval-on-timeout">{timeoutWords(approval.on_timeout)}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-muted">deadline</dt>
            {/* The handoff's time rule (`docs/design/handoff-projects/README.md`
                § 1 copy — “Times are relative; never show ISO strings”): the
                one number a waiting gate is about is the time LEFT, so the
                countdown is the visible text and the exact instant it counts
                down to rides in the title. A closed gate has no countdown;
                it says how far behind (or ahead of) the deadline it closed,
                same title. */}
            <dd data-testid="approval-deadline" title={deadlineExact}>
              {open && remainingMs !== null ? (
                <span data-testid="approval-countdown">
                  {formatRemaining(approval.deadline_at, now())}
                </span>
              ) : (
                <span>{closedDeadlineWords}</span>
              )}
            </dd>
          </div>
          {approval.re_requested ? (
            <div className="flex gap-2">
              <dt className="text-muted">re-requested</dt>
              <dd data-testid="approval-re-requested">
                yes — this gate was asked for again after an earlier one closed
              </dd>
            </div>
          ) : null}
        </dl>

        {approval.artifact_refs.length > 0 ? (
          <div>
            <p className="font-mono text-[10px] font-semibold tracking-[.04em] text-muted uppercase">
              evidence to read before deciding
            </p>
            <ul className="mt-[4px] space-y-[4px]" data-testid="approval-evidence">
              {approval.artifact_refs.map((artifact) => (
                <li key={artifact.id} className="flex items-center gap-[8px]">
                  <span className="text-[12.5px] font-semibold">{artifact.name}</span>
                  <span className="font-mono text-[10.5px] text-muted">{artifact.kind}</span>
                  <span className="font-mono text-[10.5px] text-faint">
                    {artifact.sensitivity === "restricted"
                      ? "restricted — metadata only"
                      : artifact.sensitivity}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="font-mono text-[10.5px] text-muted" data-testid="approval-no-evidence">
            the gate carries no artifacts — decide from the run itself
          </p>
        )}

        {open && canDecide ? (
          <div className="space-y-[8px]" data-testid="approval-decision-form">
            <Field
              id="approval-comments"
              label="comments (optional)"
              hint="Recorded with the decision and shown to anyone who can read the run."
            >
              <Textarea
                id="approval-comments"
                rows={2}
                value={comments}
                data-testid="approval-comment"
                onChange={(event) => setComments(event.target.value)}
              />
            </Field>
            <div className="flex flex-wrap items-center gap-[8px]">
              <Button
                variant="primary"
                data-testid="approval-approve"
                disabled={pending}
                onClick={() =>
                  onDecide?.({
                    approvalId: approval.id,
                    decision: "approved",
                    comments,
                    version: approval.version,
                  })
                }
              >
                {pending ? "Posting…" : "Approve"}
              </Button>
              <Button
                variant="secondary"
                data-testid="approval-reject"
                disabled={pending}
                onClick={() =>
                  onDecide?.({
                    approvalId: approval.id,
                    decision: "rejected",
                    comments,
                    version: approval.version,
                  })
                }
              >
                Reject
              </Button>
              <span
                className="font-mono text-[10.5px] text-faint"
                data-testid="approval-cas-version"
              >
                rejecting records the decision · version {approval.version}
              </span>
            </div>
            <p className="font-mono text-[10.5px] text-muted" data-testid="approval-consequence">
              approving lets the loop start; it does not merge anything, and it is not a review of
              the code — it is the gate the pipeline definition asked for. Rejecting records the
              decision as a business outcome: steps that need approval won't run, and the run
              finishes on the graph's terms — only an unanswered deadline fails the node.
            </p>
          </div>
        ) : null}

        {open && !canDecide ? (
          // W3's arm: the card is readable, the buttons are absent, and the
          // reason is in words rather than a disabled control.
          <p className="text-[12.5px] text-muted" data-testid="approval-not-approver">
            you are not a designated approver for this gate —{" "}
            {approval.approver_roles.length > 0
              ? `it is held by ${approval.approver_roles.join(", ")}`
              : "it names specific approvers"}
            . Nothing here can be decided by you.
          </p>
        ) : null}

        {!open ? (
          <div
            className="flex flex-wrap items-center gap-[8px] rounded-[3px] border border-line bg-paper p-[8px]"
            data-testid="approval-decided"
          >
            <StatusChip
              state={approval.decision === "rejected" ? "failed" : "done"}
              label={approval.decision ?? approval.state}
            />
            <span className="font-mono text-[11px] text-ink-2">
              {approval.decided_by ? (
                <>
                  {/* The person, in words — and a policy pseudo-id (`profile_policy:deny`,
                   * ADR-0039) is not a person, so `deciderLabel` reads it first. */}
                  <span data-testid="approval-decided-by">
                    {deciderLabel(approval.decided_by, nameOf)}
                  </span>{" "}
                  ·{" "}
                </>
              ) : null}
              {approval.decided_at ? formatTime(approval.decided_at) : "no timestamp served"}
            </span>
            {approval.state === "denied" ? (
              <span
                className="font-mono text-[11px] text-st-failed-tag-fg"
                data-testid="approval-denied-reason"
              >
                × the gate stopped applying — the approver set no longer admits anyone who can
                decide it
              </span>
            ) : null}
            {approval.state === "expired" ? (
              <span
                className="font-mono text-[11px] text-st-failed-tag-fg"
                data-testid="approval-expired-reason"
              >
                × the deadline passed; on_timeout was “{timeoutWords(approval.on_timeout)}”
              </span>
            ) : null}
            {approval.comments ? (
              <p
                className="w-full text-[12.5px] leading-[18px]"
                data-testid="approval-decision-comments"
              >
                <span className="font-mono text-[10.5px] text-muted">comments </span>
                {approval.comments}
              </p>
            ) : null}
          </div>
        ) : null}

        {conflictError ? (
          <p
            className="font-mono text-[11px] text-st-failed-tag-fg"
            role="alert"
            data-testid="approval-error"
          >
            × {conflictError}
          </p>
        ) : null}
      </div>
    </Panel>
  );
}

function timeoutWords(onTimeout: string): string {
  if (onTimeout === "fail") return "fail the node when the deadline passes";
  if (onTimeout === "cancel_run") return "cancel the run when the deadline passes";
  return "expire the request and re-ask on the next iteration";
}
