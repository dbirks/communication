/**
 * `/approvals/:approvalId` — the 4g approval detail: a full-width amber strip
 * with the deadline and the timeout policy, then the gate itself — the
 * model-written summary (or the gate's own summary when the server has no
 * assistant), the referenced plan artifact rendered inline, and an honest
 * "not available yet" for the files the plan will touch (no diff/manifest
 * API). The right rail carries who/then, the model's suggested buttons —
 * colored by risk via `riskStyle` — and "OR IN YOUR WORDS": a free-text
 * reply the model interprets into a PROPOSED decision and note.
 *
 * The model never decides. Every path — a suggested button, a proposed
 * interpretation, the fallback Approve/Reject pair — goes through the same
 * confirm step, and only the human's confirmed confirm calls the decide
 * route (with the CAS `version`).
 *
 * Honesty rules (gaps/inbox-ops.md § 5): a 503 `assistant_not_configured`
 * names the cause and falls back to the gate's own summary plus static
 * buttons; the file list is never invented; and a `404` — a gate the reader
 * cannot see or that does not exist (M4 contract § 7.2 W9) — renders the
 * honest not-found state, never a scaffold, never a project name.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useParams, Link } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  useApproval,
  useDecideApproval,
  useApprovalSummary,
  useInterpretApproval,
  useArtifactContent,
  adoptApprovalConflict,
  approvalConflictOf,
} from "../api/approvals";
import type { ApprovalSummary, ApprovalInterpretation } from "../api/approvals";
import { assistantNotConfigured } from "../api/assistant";
import { assistantTransientErrorLine, problemOf } from "../api/client";
import { useArtifacts, useProjects, useMe } from "../api/queries";
import { Button } from "../components/ds/Button";
import { Alert } from "../components/ds/Alert";
import { Panel } from "../components/ds/Panel";
import { Field, Textarea } from "../components/ds/Field";
import { ProblemBanner, Spinner } from "../components/Feedback";
import { attentionTitle } from "../lib/attention";
import { routes } from "../lib/routes";
import {
  formatAge,
  formatBytes,
  formatRemaining,
  formatTime,
  shortId,
  testidOf,
} from "../lib/format";
import {
  riskToVariant,
  actionDecision,
  type SuggestedActionRisk,
} from "../components/inbox/riskStyle";
import type { Approval } from "../api/types";

/** The 4g strip: a waiting gate is the amber ALERT-K; a closed one keeps its
 * state's own words (a decided gate is never amber). */
const ON_TIMEOUT_WORD: Record<Approval["on_timeout"], string> = {
  fail: "fail",
  cancel_run: "cancel the run",
  expire: "re-request once, then fail",
};

export default function ApprovalPage() {
  const { approvalId } = useParams<{ approvalId: string }>();
  const gate = useApproval(approvalId ?? "");

  if (gate.isPending) {
    return (
      <div data-testid="approval-detail-loading">
        <Spinner label="Reading the gate" />
      </div>
    );
  }
  if (gate.isError) {
    // The outsider's deep link (contract § 7.2 W9): the control plane answered
    // 404 for a gate they cannot see — say so in plain words, name no project,
    // show no scaffold, and offer the way back to their own Inbox.
    if (problemOf(gate.error).status === 404) {
      return (
        <section className="space-y-2 py-2" role="status" data-testid="approval-not-found">
          <h1 className="text-title-l font-bold">Approval not found</h1>
          <p className="text-[13.5px] text-muted">
            This approval doesn't exist, or you don't have access to it.
          </p>
          <p className="text-[13.5px]">
            <Link to={routes.inbox()} className="text-accent-text hover:text-ink">
              Back to Inbox
            </Link>
          </p>
        </section>
      );
    }
    return <ProblemBanner error={gate.error} fallback="The gate could not be read." />;
  }
  return <GateView approval={gate.data} />;
}

function GateView({ approval }: { approval: Approval }) {
  const testid = testidOf(approval.id);
  const me = useMe();
  const projects = useProjects();
  const summary = useApprovalSummary(approval.id);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [decideError, setDecideError] = useState<string | null>(null);

  const project = (projects.data?.items ?? []).find((p) => p.id === approval.project_id);
  const openConfirm = (request: ConfirmRequest) => {
    setDecideError(null);
    setConfirm(request);
  };

  return (
    <div className="space-y-4">
      <GateStrip approval={approval} />

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 space-y-4">
          <header className="space-y-1">
            <h1
              className="text-[22px] leading-[28px] font-semibold"
              title={approval.summary}
              data-testid={`approval-detail-title-${testid}`}
            >
              {attentionTitle(approval.summary)}
            </h1>
            <p className="font-mono text-[10.5px] text-faint">
              {project?.name ?? shortId(approval.project_id)} · run {shortId(approval.run_id)} ·{" "}
              {approval.node_instance_key ?? "unknown node"} · asked{" "}
              {formatAge(approval.created_at)}
            </p>
          </header>

          <SummaryCard approval={approval} summary={summary} testid={testid} />
          <PlanArtifact approval={approval} testid={testid} />
          <FilesItWillTouch testid={testid} />
        </div>

        <aside className="w-full space-y-4 lg:w-[360px]" aria-label="Decide">
          <WhoThenPanel approval={approval} meId={me.data?.id ?? null} />
          {approval.state === "pending" ? (
            <DecidePanel
              approval={approval}
              summary={summary.data ?? null}
              onConfirm={openConfirm}
              decideError={decideError}
            />
          ) : (
            <ClosedPanel approval={approval} testid={testid} />
          )}
        </aside>
      </div>

      {confirm ? (
        <ConfirmDialog
          request={confirm}
          approval={approval}
          onDecided={() => setConfirm(null)}
          onError={(message) => {
            setConfirm(null);
            setDecideError(message);
          }}
        />
      ) : null}
    </div>
  );
}

/** The full-width strip: `expires in 22h · on timeout: fail`, built only from
 * fields the wire carries. */
function GateStrip({ approval }: { approval: Approval }) {
  const testid = testidOf(approval.id);
  if (approval.state !== "pending") {
    const spec =
      approval.state === "decided"
        ? { state: "done" as const, label: "DECIDED" }
        : approval.state === "cancelled"
          ? { state: "interrupted" as const, label: "CANCELLED" }
          : { state: "failed" as const, label: approval.state.toUpperCase() };
    return (
      <Alert
        state={spec.state}
        label={spec.label}
        meta={
          approval.decision
            ? `${approval.decision} by ${shortId(approval.decided_by)} · ${formatAge(approval.decided_at)}`
            : formatAge(approval.decided_at)
        }
        testid={`approval-detail-strip-${testid}`}
      >
        No action needed — the gate has closed.
      </Alert>
    );
  }
  const parts: string[] = [];
  const remaining = formatRemaining(approval.deadline_at).replace(/ left$/, "");
  parts.push(`expires in ${remaining}`);
  if (approval.on_timeout) parts.push(`on timeout: ${ON_TIMEOUT_WORD[approval.on_timeout]}`);
  return (
    <Alert
      state="waiting"
      label="NEEDS YOUR DECISION"
      meta={parts.join(" · ")}
      testid={`approval-detail-strip-${testid}`}
    >
      The run is stopped at this node until a decision is made.
    </Alert>
  );
}

/**
 * The summary card. Loading is a skeleton; a 503 `assistant_not_configured`
 * names the cause and falls back to the gate's own summary labelled "from
 * the workflow"; any other failure prints the problem and still shows the
 * gate text (the decider must not be blocked from reading the gate).
 */
function SummaryCard({
  approval,
  summary,
  testid,
}: {
  approval: Approval;
  summary: ReturnType<typeof useApprovalSummary>;
  testid: string;
}) {
  const notConfigured = summary.isError && assistantNotConfigured(summary.error);

  if (summary.isPending) {
    return (
      <Panel title="SUMMARY" headingLevel={2}>
        <div
          className="space-y-2 p-3 animate-pulse"
          aria-hidden="true"
          data-testid={`approval-detail-summary-loading-${testid}`}
        >
          <div className="h-3 w-4/5 rounded-[3px] bg-fill" />
          <div className="h-3 w-3/5 rounded-[3px] bg-fill" />
        </div>
      </Panel>
    );
  }

  const data = summary.data ?? null;
  const notConfiguredNote = notConfigured ? (
    <p
      className="pt-2 text-[12px] text-muted"
      data-testid={`approval-detail-summary-unconfigured-${testid}`}
    >
      Model summaries not configured on this server — the gate's own text below.
    </p>
  ) : null;

  if (data) {
    return (
      <Panel title="SUMMARY · WRITTEN BY THE MODEL" headingLevel={2}>
        <p
          className="whitespace-pre-wrap p-3 text-[13.5px] leading-[1.5] text-ink"
          data-testid={`approval-detail-summary-${testid}`}
        >
          {data.summary}
        </p>
        <p className="border-t border-line-soft px-3 py-2 font-mono text-[10.5px] text-faint">
          summary by {data.model} · {formatTime(data.generated_at)}
        </p>
      </Panel>
    );
  }

  // 503 (or any failure): the gate's own summary, labelled honestly.
  return (
    <Panel
      title={notConfigured ? "SUMMARY · FROM THE WORKFLOW" : "SUMMARY"}
      headingLevel={2}
      state={notConfigured ? undefined : "failed"}
    >
      {!notConfigured && summary.isError ? (
        <p className="px-3 pt-2 text-[12px] text-st-failed-pale-fg">
          {assistantTransientErrorLine(summary.error) ?? problemText(summary.error)}
        </p>
      ) : null}
      <p
        className="whitespace-pre-wrap p-3 text-[13.5px] leading-[1.5] text-ink"
        title={approval.summary}
        data-testid={`approval-detail-summary-fallback-${testid}`}
      >
        {approval.summary}
      </p>
      {notConfiguredNote}
    </Panel>
  );
}

function problemText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `The summary could not be read: ${message}`;
}

/**
 * The referenced plan artifact, rendered inline. The gate's `artifact_refs`
 * carry names, not ids, so the row is matched against the project's artifact
 * list (preferring the gate's own run) and its bytes come from
 * `/artifacts/{id}/content`. Every miss is an honest line, never an invented
 * document.
 */
function PlanArtifact({ approval, testid }: { approval: Approval; testid: string }) {
  const ref = useMemo(
    () =>
      (approval.artifact_refs ?? []).find(
        (r) =>
          (typeof r.name === "string" && r.name.toLowerCase().endsWith(".md")) ||
          r.kind === "markdown",
      ),
    [approval.artifact_refs],
  );

  if (!ref) {
    return (
      <Panel title="PLAN" headingLevel={2}>
        <p className="p-3 text-[13px] text-muted" data-testid={`approval-detail-plan-${testid}`}>
          The gate names no plan artifact.
        </p>
      </Panel>
    );
  }

  return <PlanArtifactBody approval={approval} refName={String(ref.name)} testid={testid} />;
}

function PlanArtifactBody({
  approval,
  refName,
  testid,
}: {
  approval: Approval;
  refName: string;
  testid: string;
}) {
  const artifacts = useArtifacts(approval.project_id);
  const match =
    (artifacts.data?.artifacts ?? []).find(
      (a) => a.name === refName && a.run_id === approval.run_id,
    ) ?? (artifacts.data?.artifacts ?? []).find((a) => a.name === refName);

  const content = useArtifactContent(match?.id ?? null);

  const listLoading = artifacts.isPending || (artifacts.data === undefined && !artifacts.isError);
  if (listLoading) {
    return (
      <Panel title={refName.toUpperCase()} headingLevel={2}>
        <div
          className="space-y-2 p-3 animate-pulse"
          aria-hidden="true"
          data-testid={`approval-detail-plan-loading-${testid}`}
        >
          <div className="h-3 w-3/5 rounded-[3px] bg-fill" />
          <div className="h-3 w-2/5 rounded-[3px] bg-fill" />
        </div>
      </Panel>
    );
  }

  if (artifacts.isError) {
    return (
      <Panel title={refName.toUpperCase()} headingLevel={2}>
        <p className="p-3 text-[13px] text-muted" data-testid={`approval-detail-plan-${testid}`}>
          The project's artifact list could not be read, so the plan is not shown.
        </p>
      </Panel>
    );
  }

  if (!match) {
    return (
      <Panel title={refName.toUpperCase()} headingLevel={2}>
        <p className="p-3 text-[13px] text-muted" data-testid={`approval-detail-plan-${testid}`}>
          “{refName}” is named by the gate but not in this project's artifact list.
        </p>
      </Panel>
    );
  }

  const blocked =
    match.sensitivity === "secret"
      ? "this artifact is secret and has no download path"
      : match.sensitivity === "restricted"
        ? "restricted content needs a project maintainer"
        : null;

  if (blocked || content.isError) {
    return (
      <Panel title={refName.toUpperCase()} headingLevel={2}>
        <p className="p-3 text-[13px] text-muted" data-testid={`approval-detail-plan-${testid}`}>
          {blocked ?? `The plan's bytes could not be read: ${problemText(content.error)}`}
        </p>
      </Panel>
    );
  }

  if (!content.data) {
    return (
      <Panel title={refName.toUpperCase()} headingLevel={2}>
        <div
          className="space-y-2 p-3 animate-pulse"
          aria-hidden="true"
          data-testid={`approval-detail-plan-loading-${testid}`}
        >
          <div className="h-3 w-3/5 rounded-[3px] bg-fill" />
          <div className="h-3 w-2/5 rounded-[3px] bg-fill" />
        </div>
      </Panel>
    );
  }

  return (
    <Panel
      title={refName.toUpperCase()}
      meta={`${formatBytes(match.size_bytes)} · ${match.sensitivity}`}
      headingLevel={2}
    >
      {/* The plan inline: a focusable scroll region so keyboard users can
          scroll a long plan (axe scrollable-region-focusable). */}
      <div
        role="region"
        tabIndex={0}
        aria-label={`${refName} plan`}
        className="max-h-[480px] overflow-y-auto p-3 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
      >
        <PlanProse text={String(content.data)} testid={testid} />
      </div>
    </Panel>
  );
}

/**
 * The plan as prose without a markdown dependency: paragraphs on blank lines,
 * `#`-prefixed lines as headings, `` `code` `` spans in mono. The text is
 * never turned into HTML, so nothing the plan wrote can render as the app's
 * origin (the same rule as the assistant's `answer_markdown`).
 */
function PlanProse({ text, testid }: { text: string; testid: string }) {
  const blocks = text
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);
  return (
    <div className="space-y-3" data-testid={`approval-detail-plan-body-${testid}`}>
      {blocks.map((block, index) => {
        const heading = block.match(/^(#{1,4})\s+(.*)$/);
        if (heading) {
          const Heading = `h${Math.min(heading[1].length + 2, 5)}` as "h3" | "h4" | "h5";
          return (
            <Heading key={index} className="text-[13.5px] font-semibold text-ink">
              {heading[2]}
            </Heading>
          );
        }
        return (
          <p key={index} className="whitespace-pre-wrap text-[13px] leading-[1.5] text-ink">
            {block.split(/`([^`]+)`/g).map((part, i) =>
              i % 2 === 1 ? (
                <code
                  key={i}
                  className="rounded-[3px] bg-fill px-[3px] py-[1px] font-mono text-[11.5px] text-ink"
                >
                  {part}
                </code>
              ) : (
                part
              ),
            )}
          </p>
        );
      })}
    </div>
  );
}

/**
 * The 4g "FILES IT WILL TOUCH" list — the wire carries no diff or file
 * manifest for a gate (its `artifact_refs` are `{name, kind, sensitivity}`
 * only), so the section is the honest state, not a +/~ list invented from
 * nothing.
 */
function FilesItWillTouch({ testid }: { testid: string }) {
  return (
    <Panel title="FILES IT WILL TOUCH" headingLevel={2}>
      <p className="p-3 text-[13px] text-muted" data-testid={`approval-detail-files-${testid}`}>
        Not available yet — the API carries no diff or file manifest for this gate.
      </p>
    </Panel>
  );
}

/** Right rail, top: who decides and what happens on approval. */
function WhoThenPanel({ approval, meId }: { approval: Approval; meId: string | null }) {
  const roles = (approval.approver_roles ?? []).map(roleWord).join(" + ");
  const isYou = meId !== null && approval.approver_user_ids.includes(meId);
  return (
    <Panel title="WHO · THEN" headingLevel={2}>
      <dl className="space-y-2 p-3 text-[13px]">
        <div>
          <dt className="font-mono text-[10.5px] tracking-[.04em] text-faint">WHO</dt>
          <dd className="text-ink">
            {roles || "project maintainers"}
            {isYou ? " (you)" : ""}
          </dd>
        </div>
        <div>
          <dt className="font-mono text-[10.5px] tracking-[.04em] text-faint">THEN</dt>
          <dd className="text-ink" data-testid="approval-detail-then">
            the run continues from {approval.node_instance_key ?? "this node"}; rejecting records
            the decision as a business outcome — steps that need approval won't run
          </dd>
        </div>
      </dl>
    </Panel>
  );
}

function roleWord(role: Approval["approver_roles"][number]): string {
  switch (role) {
    case "maintainer":
      return "project maintainers";
    case "contributor":
      return "contributors";
    default:
      return "viewers";
  }
}

/** A closed gate: its decision, decider and note — nothing to act on. */
function ClosedPanel({ approval, testid }: { approval: Approval; testid: string }) {
  return (
    <Panel title="GATE" headingLevel={2}>
      <p
        className="p-3 text-[13px] leading-[1.5] text-ink"
        data-testid={`approval-detail-closed-${testid}`}
      >
        {approval.state === "decided" ? (
          <>
            Decided <strong className="font-semibold">{approval.decision}</strong>
            {approval.decided_by ? ` by ${shortId(approval.decided_by)}` : ""} ·{" "}
            {formatAge(approval.decided_at)}.
          </>
        ) : (
          <>The gate closed as {approval.state}.</>
        )}
        {approval.comments ? (
          <span className="mt-2 block whitespace-pre-wrap text-muted">“{approval.comments}”</span>
        ) : null}
      </p>
    </Panel>
  );
}

/** What a confirm step is asked to record. `decision` is `null` only for an
 * action whose intent is `other` — the step then offers the decision to the
 * human instead of guessing it. */
export interface ConfirmRequest {
  /** The label the step prints (a suggested action, a proposed reading). */
  label: string;
  decision: "approved" | "rejected" | null;
  /** The note prefilled into the step. */
  comments: string;
  /** One line of context above the label (e.g. the model's interpretation). */
  note?: string;
}

/**
 * The right-rail decide panel: SUGGESTED buttons (model actions colored by
 * risk; the static Approve/Reject pair when the model is not configured) and
 * "OR IN YOUR WORDS" — a free-text reply the model interprets into a
 * proposed decision + note. Nothing here decides: every path opens the
 * confirm step.
 */
function DecidePanel({
  approval,
  summary,
  onConfirm,
  decideError,
}: {
  approval: Approval;
  summary: ApprovalSummary | null;
  onConfirm: (request: ConfirmRequest) => void;
  decideError: string | null;
}) {
  const testid = testidOf(approval.id);
  const [reply, setReply] = useState("");
  const [proposal, setProposal] = useState<ApprovalInterpretation | null>(null);
  const [interpretError, setInterpretError] = useState<string | null>(null);
  const interpret = useInterpretApproval(approval.id);
  const replyRef = useRef<HTMLTextAreaElement | null>(null);

  const actions = (summary?.actions ?? []).slice(0, 4);
  const suggested: {
    label: string;
    risk: SuggestedActionRisk;
    decision: "approved" | "rejected" | null;
    intent: string;
  }[] =
    actions.length > 0
      ? actions.map((action) => ({
          label: action.label,
          risk: action.risk,
          decision: actionDecision(action.intent),
          intent: action.intent,
        }))
      : [
          { label: "Approve", risk: "proceed", decision: "approved" as const, intent: "approve" },
          { label: "Reject", risk: "refuse", decision: "rejected" as const, intent: "reject" },
        ];

  const send = () => {
    const text = reply.trim();
    if (text.length === 0) return;
    setInterpretError(null);
    interpret.mutate(text, {
      onSuccess: (data) => {
        setProposal(data);
        setReply("");
      },
      onError: (error) => {
        setProposal(null);
        setInterpretError(
          assistantNotConfigured(error)
            ? "The assistant isn't configured on this server — the suggested buttons above still work."
            : problemText(error),
        );
      },
    });
  };

  const proposalDecision = proposal?.proposed.decision;
  const proposeLabel = proposalDecision === "approve" ? "Approve with note" : "Reject with note";

  return (
    <Panel title="DECIDE" headingLevel={2}>
      <div className="space-y-3 p-3">
        <div>
          <div className="font-mono text-[10.5px] tracking-[.04em] text-faint">SUGGESTED</div>
          <div className="mt-2 grid gap-2" data-testid={`approval-detail-suggested-${testid}`}>
            {suggested.map((action) => (
              <Button
                key={action.label}
                variant={riskToVariant(action.risk)}
                className="justify-start"
                data-testid={`approval-detail-suggested-${testid}-${action.intent}`}
                onClick={() =>
                  onConfirm({ label: action.label, decision: action.decision, comments: "" })
                }
              >
                {action.label}
              </Button>
            ))}
          </div>
          {summary === null ? (
            <p className="mt-2 text-[11.5px] text-faint">
              Suggested actions are model-written; none are configured on this server, so these are
              the gate's own.
            </p>
          ) : null}
        </div>

        {decideError ? (
          <p
            className="text-[12.5px] text-st-failed-pale-fg"
            role="alert"
            data-testid={`approval-detail-decide-error-${testid}`}
          >
            {decideError}
          </p>
        ) : null}

        <div className="border-t border-line-soft pt-3">
          <div className="font-mono text-[10.5px] tracking-[.04em] text-faint">
            OR IN YOUR WORDS
          </div>
          <textarea
            ref={replyRef}
            rows={2}
            className="mt-2"
            placeholder="Approve with changes, or ask a question about the plan…"
            value={reply}
            aria-label="Reply in your own words"
            data-testid={`approval-detail-reply-${testid}`}
            onChange={(event) => setReply(event.target.value)}
          />
          <div className="mt-2 flex items-center gap-2">
            <Button
              variant="primary"
              className="h-[36px]"
              disabled={reply.trim().length === 0 || interpret.isPending}
              data-testid={`approval-detail-reply-send-${testid}`}
              onClick={send}
            >
              {interpret.isPending ? "Reading…" : "Send"}
            </Button>
          </div>
          {interpretError ? (
            <p
              className="mt-2 text-[12px] text-muted"
              role="status"
              data-testid={`approval-detail-interpret-error-${testid}`}
            >
              {interpretError}
            </p>
          ) : null}
          {proposal ? (
            <ProposalCard
              proposal={proposal}
              onConfirm={onConfirm}
              onChange={() => {
                setProposal(null);
                replyRef.current?.focus();
              }}
              testid={testid}
              proposeLabel={proposeLabel}
            />
          ) : null}
          <p className="mt-2 text-[11px] text-faint">you confirm whatever it proposes</p>
        </div>
      </div>
    </Panel>
  );
}

/** The model's reading of the approver's words, shown as a proposal. */
function ProposalCard({
  proposal,
  onConfirm,
  onChange,
  testid,
  proposeLabel,
}: {
  proposal: ApprovalInterpretation;
  onConfirm: (request: ConfirmRequest) => void;
  onChange: () => void;
  testid: string;
  proposeLabel: string;
}) {
  const decision = proposal.proposed.decision;
  return (
    <div
      className="mt-2 rounded-[3px] border border-line bg-fill p-2.5"
      data-testid={`approval-detail-proposal-${testid}`}
    >
      <p className="text-[12.5px] leading-[1.45] text-ink">
        <span className="font-mono text-[10.5px] tracking-[.04em] text-faint">PROPOSED · </span>
        {proposal.interpretation}
      </p>
      <p className="mt-1 text-[12px] text-muted">
        would record{" "}
        <code className="font-mono text-[11.5px] text-ink">
          {decision === "approve" ? "approved" : "rejected"}
        </code>
        {proposal.proposed.comments ? ` with the note: “${proposal.proposed.comments}”` : ""}
      </p>
      <div className="mt-2 flex gap-2">
        <Button variant="secondary" className="h-[36px] text-[12px]" onClick={onChange}>
          Change it
        </Button>
        <Button
          variant={decision === "approve" ? "primary" : "danger"}
          className="h-[36px] text-[12px]"
          data-testid={`approval-detail-proposal-confirm-${testid}`}
          onClick={() =>
            onConfirm({
              label: proposeLabel,
              decision: decision === "approve" ? "approved" : "rejected",
              comments: proposal.proposed.comments,
              note: proposal.interpretation,
            })
          }
        >
          {proposeLabel}
        </Button>
      </div>
    </div>
  );
}

const CONFIRM_FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The confirm step every decision goes through: an accessible modal (focus
 * trapped, Escape closes, focus returns to the opener) that names the label
 * and the wire decision it will record, prefills the note, and calls the
 * decide route only on the human's confirm.
 */
function ConfirmDialog({
  request,
  approval,
  onDecided,
  onError,
}: {
  request: ConfirmRequest;
  approval: Approval;
  onDecided: () => void;
  onError: (message: string) => void;
}) {
  const testid = testidOf(approval.id);
  const decide = useDecideApproval(approval.project_id);
  const queryClient = useQueryClient();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const openerRef = useRef<Element | null>(null);
  const [choice, setChoice] = useState<"approved" | "rejected" | null>(request.decision);
  const [comments, setComments] = useState(request.comments);

  useLayoutEffect(() => {
    openerRef.current = document.activeElement;
    const first = containerRef.current?.querySelector<HTMLElement>(CONFIRM_FOCUSABLE);
    first?.focus();
    return () => {
      const opener = openerRef.current;
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onDecided();
        return;
      }
      if (event.key !== "Tab") return;
      const container = containerRef.current;
      if (!container) return;
      const focusables = Array.from(container.querySelectorAll<HTMLElement>(CONFIRM_FOCUSABLE));
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !container.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onDecided]);

  const confirm = () => {
    if (choice === null) return;
    decide.mutate(
      {
        approvalId: approval.id,
        body: {
          decision: choice,
          comments: comments.trim().length > 0 ? comments.trim() : undefined,
          version: approval.version,
        },
      },
      {
        onSuccess: () => onDecided(),
        onError: (error) => {
          // A 409 means someone else decided first: adopt the winner's
          // row (the gate is now closed) instead of surfacing an error.
          if (approvalConflictOf(error)) {
            adoptApprovalConflict(queryClient, error);
            onDecided();
          } else {
            onError(problemText(error));
          }
        },
      },
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/25 p-4">
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`approval-detail-confirm-heading-${testid}`}
        className="w-full max-w-[440px] rounded-[3px] border border-line-strong bg-surface shadow-[0_8px_24px_rgba(30,29,26,.18)]"
        data-testid={`approval-detail-confirm-${testid}`}
      >
        <div className="border-b border-line px-4 py-2.5">
          <h2
            id={`approval-detail-confirm-heading-${testid}`}
            className="text-[15px] font-semibold text-ink"
          >
            Confirm the decision
          </h2>
        </div>
        <div className="space-y-3 p-4">
          <div className="rounded-[3px] border border-line bg-fill p-2.5">
            <p className="text-[13.5px] font-semibold text-ink">“{request.label}”</p>
            {request.note ? (
              <p className="mt-1 text-[12px] leading-[1.45] text-muted">{request.note}</p>
            ) : null}
          </div>

          {choice === null ? (
            <div data-testid={`approval-detail-confirm-choice-${testid}`}>
              <p className="text-[12.5px] text-ink">
                That label is not a decision word — choose what to record:
              </p>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <Button
                  variant="primary"
                  className="h-[36px]"
                  onClick={() => setChoice("approved")}
                >
                  Approve
                </Button>
                <Button variant="danger" className="h-[36px]" onClick={() => setChoice("rejected")}>
                  Reject
                </Button>
              </div>
            </div>
          ) : (
            <p className="text-[12.5px] text-ink">
              This records <code className="font-mono text-[11.5px] text-ink">{choice}</code> on the
              gate.
            </p>
          )}

          <Field label="Note for the record" id={`approval-detail-confirm-note-${testid}`}>
            <Textarea
              id={`approval-detail-confirm-note-${testid}`}
              rows={3}
              value={comments}
              onChange={(event) => setComments(event.target.value)}
            />
          </Field>

          <p className="text-[11px] text-faint">
            The note is a decider note; it never enters the journal.
          </p>

          <div className="flex justify-end gap-2">
            <Button variant="secondary" className="h-[36px]" onClick={onDecided}>
              Cancel
            </Button>
            <Button
              variant={choice === "approved" ? "primary" : "danger"}
              className="h-[36px]"
              disabled={choice === null || decide.isPending}
              data-testid={`approval-detail-confirm-go-${testid}`}
              onClick={confirm}
            >
              {decide.isPending
                ? "Deciding…"
                : choice === "approved"
                  ? "Approve with note"
                  : choice === "rejected"
                    ? "Reject with note"
                    : "Choose a decision"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
