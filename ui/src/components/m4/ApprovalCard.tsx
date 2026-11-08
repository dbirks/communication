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
 * The decision posts the row's `version` as a CAS token through the shared
 * `DecisionBar` (finding 04): fixed verbs, a 5s undo hold in place of the
 * old comment box + Approve/Reject pair, and no confirm step. A concurrent
 * decision is a *conflict*, stated as one, never a silent overwrite. And a `rejected`
 * decision is a business outcome, NOT an execution failure
 * (`docs/m4-contract.md` § 5.3, C9e; `03`:49's success/fail split applied to
 * gates): the gate row closes `succeeded` with outcome `rejected`, the
 * dependants its graph guards on the decision don't run, and the run settles
 * on the pipeline's terms — only an unanswered DEADLINE fails the node
 * (`approval_expired`). The copy below says exactly that; the old
 * "rejecting fails this run" promise contradicted the engine and is gone.
 */
import { useId, useRef, useState } from "react";
import type { ApprovalDecision, ApprovalDetail } from "../../lib/pipeline/contract";
import { deciderLabel, fallbackName } from "../../api/actors";
import { Panel } from "../ds/Panel";
import { Button } from "../ds/Button";
import DecisionBar from "../ds/DecisionBar";
import type { DecisionConflict } from "../ds/DecisionBar";
import { StatusChip } from "../ds/Row";
import { APPROVAL_STATE, SHORT_WORD, stateOf } from "../ds/states";
import { formatAge, formatRemaining, formatTime } from "../../lib/format";
import { stepWordOf } from "../../lib/pipeline/runView";
import { PlanView, splitPlanText } from "./PlanView";

export interface ApprovalCardProps {
  approval: ApprovalDetail;
  /** Server-told, never guessed from a role name: the API is the decider about
   * who may decide (route 35's approver arrays plus the caller's own identity). */
  canDecide: boolean;
  /** `version` travels back as the CAS token; the caller owns the POST.
   *
   * **A host that rejects must reject the promise it returns.** `DecisionBar`
   * renders "Your decision is recorded" only when this resolves, so a host
   * that catches the POST error and swallows it makes the bar say the
   * opposite of the truth. The right shape is: adopt the winner into the
   * cache, then `throw` — the bar's own conflict/error arms then state the
   * refusal, and `conflictError` below is not needed for it. */
  onDecide?: (input: {
    approvalId: string;
    decision: ApprovalDecision;
    comments: string;
    version: number;
  }) => void | Promise<unknown>;
  /** @deprecated Legacy: the bar owns its posting now (the hold replaces a
   * disabled-while-posting pair); kept on the interface so hosts built
   * against the old shape still compile while they are updated. */
  pending?: boolean;
  /** A refusal the card itself was told about (not the decide POST's — the bar
   * renders those), shown in place rather than as a toast. */
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
  conflictError = null,
  now = Date.now,
  headingId = "approval-card-heading",
  className = "",
  nameOf = fallbackName,
}: ApprovalCardProps) {
  // Finding 04 (the workbench arm of the race rule): a held decision that
  // loses — the shared cache moves the gate while the hold is open, or the
  // POST returns 409 — reports here, and the card keeps the conflict
  // sentence rendered above the decision record until the reader dismisses
  // it. A clean self-decision never sets this.
  const [lost, setLost] = useState<DecisionConflict | null>(null);
  /** The decision form is the end of a card that can run past a screenful of
   * plan, so the card keeps a handle on it for the jump verb below. */
  const decisionFormRef = useRef<HTMLDivElement | null>(null);
  const decisionFormId = useId();
  const jumpToDecision = () => {
    const form = decisionFormRef.current;
    if (!form) return;
    // `scrollIntoView` is the only way to reach the target inside whichever pane
    // scrolls it (the dock on the workbench, the page on a small screen), and it
    // is missing from jsdom, so the focus below is what a test proves.
    if (typeof form.scrollIntoView === "function") {
      form.scrollIntoView({ block: "start", behavior: "smooth" });
    }
    // The form is the DecisionBar now (finding 04): the jump lands on its
    // first verb, the same control a sighted reader would click.
    form.querySelector<HTMLElement>("[data-testid='decision-approve']")?.focus();
  };
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
        {/* The plan a gate asks you to approve can be sixty-odd lines (the
         * pass-1 review measured `run-gate-waiting-1280.png`: Approve/Reject sat
         * ~1800px down, off the bottom of the card with nothing pinned). The
         * decision stays where the evidence ends — PlanView is not clamped, by
         * design — but the card says so at the top and puts one verb there to get
         * there: a click or a Enter/Space press lands the reader on the form. */}
        {open && canDecide ? (
          <div
            className="flex flex-wrap items-center gap-[8px] rounded-[3px] border border-accent-mid bg-accent-wash p-[8px]"
            data-testid="approval-decide-bar"
          >
            <p
              className="min-w-0 grow text-[12.5px] leading-[17px] text-ink-2"
              data-testid="approval-decide-hint"
            >
              The whole plan is below — the decision is at the end of it.
            </p>
            <button
              type="button"
              onClick={jumpToDecision}
              aria-controls={decisionFormId}
              className="shrink-0 rounded-[3px] border border-ink bg-surface px-[8px] py-[4px] text-[12px] font-semibold text-ink hover:bg-fill focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
              data-testid="approval-decide-jump"
            >
              Decide ↓
            </button>
          </div>
        ) : null}
        <div data-testid="approval-summary">
          {summary.title ? (
            <p className="text-[13.5px] leading-[20px]" data-testid="approval-summary-title">
              {summary.title}
            </p>
          ) : null}
          <PlanView text={summary.body} className="mt-[2px]" />
        </div>

        {/* Each pair stacks its key over its value (one of the fix shapes the
            pass-1 review of this brief allows): the card's pane is ~190px
            wide per column, and no side-by-side split left "fail the node
            when the deadline passes" under two lines there. A full-column
            value reads in one or two lines at 1280 and at 390. */}
        <dl className="grid gap-x-6 gap-y-1 font-mono text-[11px] text-ink-2 sm:grid-cols-2">
          <div className="flex flex-col">
            {/* The step's NAME, not the run's internal path identity: the
                round-2 review read `node /approve` where the reader wants the
                step. The full `node_instance_key` (with its scope segments and
                `[n]` iteration suffixes) stays in the value's `title`, and
                `stepWordOf` is the same leaf rule the graph and the tree use. */}
            <dt className="text-muted">step</dt>
            <dd data-testid="approval-node" title={approval.node_instance_key}>
              {stepWordOf(approval.node_instance_key)}
            </dd>
          </div>
          <div className="flex flex-col">
            <dt className="text-muted">approver roles</dt>
            <dd data-testid="approval-roles">
              {approval.approver_roles.join(", ") || "named users only"}
            </dd>
          </div>
          <div className="flex flex-col">
            <dt className="text-muted">on timeout</dt>
            <dd data-testid="approval-on-timeout">{timeoutWords(approval.on_timeout)}</dd>
          </div>
          <div className="flex flex-col">
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
            <div className="flex flex-col">
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
          <div
            id={decisionFormId}
            ref={decisionFormRef}
            className="space-y-[8px]"
            data-testid="approval-decision-form"
          >
            {/* Finding 04: the fixed-verb DecisionBar replaces the card's own
                comment box and Approve/Reject pair. A host that owns the
                decide mutation (the run inspector, the M4 previews) injects
                `onDecide` and the bar POSTs through it; a bare card posts
                itself with the row's CAS `version`. "Request changes" is the
                card's note path: `rejected` + the person's text. */}
            <DecisionBar
              approval={approval}
              compact
              onConflict={open ? setLost : undefined}
              submit={
                onDecide
                  ? (body) =>
                      onDecide({
                        approvalId: approval.id,
                        decision: body.decision,
                        comments: body.comments ?? "",
                        version: body.version ?? approval.version,
                      })
                  : undefined
              }
            />
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
            {lost !== null && lost.approvalId === approval.id ? (
              /* The lost race reads BEFORE the record: the sentence names
                 who beat the click, the details below stay (finding 04).
                 Dismiss clears the sentence, not the decision. */
              <div className="w-full space-y-[6px]" data-testid="approval-lost-race">
                <DecisionBar approval={approval} compact initialConflict={lost} />
                <Button
                  variant="secondary"
                  compact
                  data-testid="approval-lost-dismiss"
                  onClick={() => setLost(null)}
                >
                  Dismiss
                </Button>
              </div>
            ) : null}
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
              {/* The handoff's copy rule (`handoff-projects` § 1: “Times are relative
                  (`8m`, `2h`); never show ISO strings”) applied to the decision
              record (round-2 review): WHEN is a distance from now, and the exact
              instant the audit trail speaks lives in the value's `title`. */}
              <span
                data-testid="approval-decided-at"
                title={approval.decided_at ? formatTime(approval.decided_at) : undefined}
              >
                {approval.decided_at
                  ? `${formatAge(approval.decided_at, now())} ago`
                  : "no timestamp served"}
              </span>
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
