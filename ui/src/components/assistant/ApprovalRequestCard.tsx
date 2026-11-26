import { IconCheck, IconShieldExclamation } from "@tabler/icons-react";
import { Button } from "../ds/Button";
import { approvalArgsOf, reasonOf } from "../../api/assistant";
import type { AssistantApprovalRequestPayload } from "./types";

/**
 * The approval gate (2a "Approval card", 4d §2; ADR-0050 Decision 4) — and,
 * for the two creating tools, handoff A7's PROPOSAL card.
 *
 * Under a gated trust level the server stops the turn without executing the
 * risky tool and appends an `approval_request` row; this card is the only
 * actable surface for it. `Create project`/`Retry` posts `{"confirm": <id>}`,
 * `Not now` posts `{"dismiss": <id>}` — the caller maps those to the messages
 * POST. Buttons exist only while `state === "pending"`; once decided the card
 * keeps its place in the history with the outcome, status as banner + text,
 * never colour alone.
 *
 * Two faces, one row of truth shared by both: WHY it asks (CONTRACT §3) — the
 * judge's reason, the fixed table's "Creates real state.", the trust level's
 * own line. A person deciding on a create is entitled to know what made it
 * worth asking about, not only that it is risky.
 */

/** The tools whose approval is a proposal: one create, everything filled in
 * (handoff A7 "one proposal card (project, repo @ branch, credential,
 * workflow, why it asks)"). */
const PROPOSAL_TOOLS: readonly string[] = ["project.create", "repo.add"];

/** CONTRACT §3's fixed-table reason, used when the row carries none. */
const DEFAULT_REASON = "Creates real state.";

/**
 * The primary button NAMES the action it runs — a person deciding has to see
 * what they are saying yes to, not a bare verb that could be anything. One
 * table for both cards; a tool the design has no words for falls back to
 * "Confirm" (never "Retry", which is the OTHER action's word — a retry of a
 * step is named by `run.retry` below).
 */
const CONFIRM_LABELS: Record<string, string> = {
  "run.start": "Start run",
  "run.retry": "Retry step",
  "run.cancel": "Cancel run",
  "pipeline.publish": "Publish",
  "assignment.set": "Assign",
  "schedule.create": "Create schedule",
  "repo.add": "Connect repository",
  "project.create": "Create project",
};

/** The confirm button's wording for one gated tool. */
export function approvalConfirmLabel(action: string): string {
  return CONFIRM_LABELS[action] ?? "Confirm";
}

export interface ApprovalRequestCardProps {
  /** The transcript row's id — what confirm/dismiss name. */
  messageId: string;
  request: AssistantApprovalRequestPayload;
  onConfirm: (messageId: string) => void;
  onDismiss: (messageId: string) => void;
  /** `"quick"` applies Quick chat's radius-10, shadowless styling. */
  variant?: "default" | "quick";
}

/** `github.com/dbirks/home-lab` or its URL → the `owner/repo` the row names. */
function repoSlug(url: string | undefined): string | null {
  if (!url) return null;
  let slug = url.trim();
  slug = slug.replace(/^[a-z]+:\/\//i, "").replace(/^www\./i, "");
  slug = slug.replace(/^(github\.com|gitlab\.com|bitbucket\.org)\//i, "");
  slug = slug.replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "");
  return slug.length > 0 ? slug : null;
}

export function ApprovalRequestCard({
  messageId,
  request,
  onConfirm,
  onDismiss,
  variant = "default",
}: ApprovalRequestCardProps) {
  const pending = request.state === "pending";
  const reason = reasonOf(request) ?? DEFAULT_REASON;
  const proposal = PROPOSAL_TOOLS.includes(request.action);
  const quick = variant === "quick";
  return proposal ? (
    <ProposalCard
      messageId={messageId}
      request={request}
      reason={reason}
      pending={pending}
      quick={quick}
      onConfirm={onConfirm}
      onDismiss={onDismiss}
    />
  ) : (
    <GateCard
      messageId={messageId}
      request={request}
      reason={reason}
      pending={pending}
      quick={quick}
      onConfirm={onConfirm}
      onDismiss={onDismiss}
    />
  );
}

/** The banner strip: the card's state in mono caps, never colour alone. */
function Banner({ tone, children }: { tone: "waiting" | "done" | "quiet"; children: string }) {
  return (
    <p
      data-testid="assistant-approval-header"
      // §6: the waiting band is the design's PALE wash (mock L306:
      // #fdf6e4 body / #e8cf94 rule / #5c3d00 text = the `st-waiting` pale
      // tokens), never the saturated tag amber. `border-b border-transparent`
      // keeps every tone the same height.
      className={`m-0 flex items-center gap-[6px] border-b border-transparent px-[9px] py-[6px] font-mono text-[10px] font-semibold tracking-[.06em] ${
        tone === "waiting"
          ? "bg-st-waiting-pale-body border-st-waiting-pale-edge text-st-waiting-pale-fg"
          : tone === "done"
            ? "bg-st-done-tag text-st-done-tag-fg"
            : "bg-fill text-muted"
      }`}
    >
      {tone === "waiting" ? (
        <IconShieldExclamation size={12} stroke={2} aria-hidden className="shrink-0" />
      ) : null}
      {children}
    </p>
  );
}

/** One `label · value` row of the proposal card's grid. */
function ProposalRow({
  label,
  value,
  testid,
  mono = false,
  note,
  bold = false,
}: {
  label: string;
  value: string;
  testid: string;
  mono?: boolean;
  note?: string;
  bold?: boolean;
}) {
  return (
    <>
      <span className="text-muted">{label}</span>
      {/* Only the Project value is bold (design L306–340): the mono rows and
          the plain Workflow / Why-it-asks values stay regular weight. */}
      <span
        data-testid={testid}
        className={`min-w-0 break-words ${mono ? "font-mono text-[11px] text-ink" : bold ? "font-semibold text-ink" : "text-ink"}`}
      >
        {value}
        {note ? <span className="font-normal text-muted"> {note}</span> : null}
      </span>
    </>
  );
}

/**
 * The proposal card (handoff A7 §6, mock L293–340): `project.create` /
 * `repo.add` shown as the ONE create it is — Project, Repository @ branch,
 * Credential, Workflow, and Why it asks. Nothing here is editable (A7:
 * "nothing is editable in v1"); the two buttons answer with the same
 * confirm/dismiss the gate uses.
 */
function ProposalCard({
  messageId,
  request,
  reason,
  pending,
  quick,
  onConfirm,
  onDismiss,
}: {
  messageId: string;
  request: AssistantApprovalRequestPayload;
  reason: string;
  pending: boolean;
  quick: boolean;
  onConfirm: (messageId: string) => void;
  onDismiss: (messageId: string) => void;
}) {
  const args = approvalArgsOf(request);
  const project = args.name ?? args.project_id ?? "";
  const repo = repoSlug(args.repo_url);
  const branch = args.default_branch ?? "";
  return (
    <div
      data-testid="assistant-approval"
      data-proposal={request.action}
      role="group"
      aria-label={`Proposal: ${request.summary}`}
      className={
        quick
          ? "overflow-hidden rounded-[10px] border border-line-strong bg-surface px-0 py-0"
          : "my-[2px] mx-[10px] overflow-hidden rounded-[4px] border border-ink bg-surface px-0 py-0"
      }
    >
      <Banner tone={pending ? "waiting" : request.state === "confirmed" ? "done" : "quiet"}>
        {pending
          ? "NEEDS YOUR OK · CREATES REAL STATE"
          : request.state === "confirmed"
            ? "CONFIRMED"
            : "DISMISSED"}
      </Banner>
      <div className="grid grid-cols-[76px_1fr] gap-x-[8px] gap-y-[4px] px-[9px] py-[8px] text-[12px] leading-[1.45]">
        <ProposalRow
          label="Project"
          value={project}
          testid="assistant-proposal-project"
          note="(new)"
          bold
        />
        <ProposalRow
          label="Repository"
          value={repo === null ? request.summary : branch.length > 0 ? `${repo} @ ${branch}` : repo}
          testid="assistant-proposal-repository"
          mono
        />
        <ProposalRow
          label="Credential"
          value={args.credential ?? "none"}
          testid="assistant-proposal-credential"
          mono
        />
        <ProposalRow label="Workflow" value="none yet" testid="assistant-proposal-workflow" />
        <ProposalRow label="Why it asks" value={reason} testid="assistant-approval-reason" />
      </div>
      {pending ? (
        <div className="flex flex-wrap gap-[8px] px-[9px] pb-[9px]">
          {quick ? (
            <>
              <button
                type="button"
                data-testid="assistant-approval-confirm"
                onClick={() => onConfirm(messageId)}
                className="cursor-pointer rounded-[8px] border-none bg-accent px-[12px] py-[6px] text-[12.5px] font-semibold text-surface hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
              >
                {approvalConfirmLabel(request.action)}
              </button>
              <button
                type="button"
                data-testid="assistant-approval-dismiss"
                onClick={() => onDismiss(messageId)}
                className="cursor-pointer rounded-[8px] border-none bg-transparent px-[10px] py-[6px] text-[12.5px] font-semibold text-accent-text hover:bg-fill focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
              >
                Not now
              </button>
            </>
          ) : (
            <>
              <Button
                variant="primary"
                compact
                data-testid="assistant-approval-confirm"
                onClick={() => onConfirm(messageId)}
              >
                {approvalConfirmLabel(request.action)}
              </Button>
              <Button
                variant="ghost"
                compact
                data-testid="assistant-approval-dismiss"
                onClick={() => onDismiss(messageId)}
              >
                Not now
              </Button>
            </>
          )}
        </div>
      ) : request.state === "confirmed" ? (
        <p className="m-0 flex items-center gap-[6px] px-[9px] pb-[9px] font-mono text-[10.5px] text-st-done-pale-fg">
          created · can't be undone from here
        </p>
      ) : (
        <p className="m-0 px-[9px] pb-[9px] font-mono text-[10.5px] text-faint">not created</p>
      )}
    </div>
  );
}

/** The gate card for every other gated tool (2a/4d §2): the summary, its risk
 * line, and the Why it asks row the handoff adds above the buttons. */
function GateCard({
  messageId,
  request,
  reason,
  pending,
  quick,
  onConfirm,
  onDismiss,
}: {
  messageId: string;
  request: AssistantApprovalRequestPayload;
  reason: string;
  pending: boolean;
  quick: boolean;
  onConfirm: (messageId: string) => void;
  onDismiss: (messageId: string) => void;
}) {
  const confirmed = !pending && request.state === "confirmed";
  const headerText = pending ? "! NEEDS APPROVAL" : confirmed ? "· CONFIRMED" : "· DISMISSED";
  // The full id of the entity the action targets: the summary shows a short
  // id, so this attribute is how a test names THIS card among older ones.
  const args = approvalArgsOf(request);
  const ref =
    args.draft_id ?? args.run_id ?? args.pipeline_id ?? args.project_id ?? args.approval_id ?? "";

  return (
    <div
      data-testid="assistant-approval"
      data-approval-ref={ref || undefined}
      role="group"
      aria-label={`Needs approval: ${request.summary}`}
      className={
        quick
          ? "inline-block max-w-full overflow-hidden rounded-[10px] border border-st-waiting-pale-edge bg-st-waiting-pale-body px-[10px] py-[8px]"
          : "overflow-hidden px-[10px] py-[8px]"
      }
      style={
        quick
          ? undefined
          : {
              border: "1px solid var(--color-st-waiting-pale-edge)",
              borderRadius: 4,
              background: "var(--color-st-waiting-pale-body)",
              display: "inline-block",
              maxWidth: "100%",
            }
      }
    >
      <p
        data-testid="assistant-approval-header"
        className="m-0 font-mono text-[10px] font-semibold tracking-wide"
        style={{
          background: "var(--color-st-waiting-pale-bar)",
          color: "var(--color-st-waiting-pale-fg)",
          padding: "4px 8px",
          margin: "-8px -10px 8px",
        }}
      >
        {confirmed ? (
          <span className="inline-flex items-center gap-[4px]">
            <IconCheck size={10} stroke={2} aria-hidden className="shrink-0" />
            {headerText}
          </span>
        ) : (
          headerText
        )}
      </p>
      <p className="m-0 whitespace-pre-wrap text-[13px] leading-[1.45] text-ink">
        {request.summary}
      </p>
      {request.risk ? (
        <p className="m-0 mt-[4px] whitespace-pre-wrap text-[11px] leading-[1.4] text-muted">
          {request.risk}
        </p>
      ) : null}
      <p
        data-testid="assistant-approval-reason"
        className="m-0 mt-[4px] whitespace-pre-wrap text-[11px] leading-[1.4] text-muted"
      >
        <span className="text-faint">Why it asks · </span>
        {reason}
      </p>
      {pending ? (
        <div className="mt-[8px] flex gap-[8px]">
          {quick ? (
            <>
              <button
                type="button"
                data-testid="assistant-approval-confirm"
                onClick={() => onConfirm(messageId)}
                className="cursor-pointer rounded-[8px] border-none bg-accent px-[12px] py-[6px] text-[12.5px] font-semibold text-surface hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
              >
                {approvalConfirmLabel(request.action)}
              </button>
              <button
                type="button"
                data-testid="assistant-approval-dismiss"
                onClick={() => onDismiss(messageId)}
                className="cursor-pointer rounded-[8px] border border-line bg-surface px-[10px] py-[6px] text-[12.5px] font-semibold text-ink hover:bg-fill focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
              >
                Not now
              </button>
            </>
          ) : (
            <>
              <Button
                variant="primary"
                compact
                data-testid="assistant-approval-confirm"
                onClick={() => onConfirm(messageId)}
              >
                {approvalConfirmLabel(request.action)}
              </Button>
              <Button
                variant="secondary"
                compact
                data-testid="assistant-approval-dismiss"
                onClick={() => onDismiss(messageId)}
              >
                Not now
              </Button>
            </>
          )}
        </div>
      ) : request.state === "confirmed" ? (
        <p className="m-0 mt-[6px] font-mono text-[10.5px] text-st-done-pale-fg">
          confirmed · the action ran once as you
        </p>
      ) : (
        <p className="m-0 mt-[6px] font-mono text-[10.5px] text-faint">dismissed · nothing ran</p>
      )}
    </div>
  );
}

export default ApprovalRequestCard;
