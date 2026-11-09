/**
 * `/approvals/:approvalId` — the 4g approval detail: a full-width amber strip
 * with the deadline and the timeout policy, then the gate itself — the
 * model-written summary (or the gate's own summary when the server has no
 * assistant), the referenced plan artifact rendered inline, and an honest
 * "not available yet" for the files the plan will touch (no diff/manifest
 * API). The right rail carries who/then and the decision itself,
 *
 * "OR IN YOUR WORDS": a free-text reply the model interprets; the reading
 * and its note are shown as TEXT above the bar — the model never decides
 * and never labels a verb. Deciding is the shared `DecisionBar` (finding
 * 04): Approve / Request changes / Reject, fixed verbs, a 5s undo hold
 * instead of a confirm step, posting to the decide route with the row's
 * CAS `version` ("Request changes" records `rejected` + the note).
 *
 * Honesty rules (gaps/inbox-ops.md § 5): a 503 `assistant_not_configured`
 * names the cause and falls back to the gate's own summary; the file list is
 * never invented; and a `404` — a gate the reader
 * cannot see or that does not exist (M4 contract § 7.2 W9) — renders the
 * honest not-found state, never a scaffold, never a project name.
 */
import { useMemo, useRef, useState } from "react";
import { useParams, Link } from "react-router";
import {
  useApproval,
  useApprovalSummary,
  useInterpretApproval,
  useArtifactContent,
} from "../api/approvals";
import type { ApprovalSummary, ApprovalInterpretation } from "../api/approvals";
import { assistantNotConfigured } from "../api/assistant";
import { assistantTransientErrorLine, problemOf } from "../api/client";
import { useArtifacts, useProjects, useMe } from "../api/queries";
import { Button } from "../components/ds/Button";
import { Alert } from "../components/ds/Alert";
import { Panel } from "../components/ds/Panel";
import DecisionBar from "../components/ds/DecisionBar";
import type { DecisionConflict } from "../components/ds/DecisionBar";
import { ProblemBanner, Spinner } from "../components/Feedback";
import Page from "../components/ds/Page";
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
    // show no scaffold, and offer the way back to Today (finding 03: the Inbox
    // is gone; `/inbox` only redirects).
    if (problemOf(gate.error).status === 404) {
      return (
        <Page layout="reading" title="Approval not found" testid="approval-not-found">
          <section className="space-y-2" role="status">
            <p className="text-[13.5px] text-muted">
              This approval doesn't exist, or you don't have access to it.
            </p>
            <p className="text-[13.5px]">
              <Link to={routes.home()} className="text-accent-text hover:text-ink">
                Back to Today
              </Link>
            </p>
          </section>
        </Page>
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
  // Finding 04 (gap b): when the viewer clicked and the gate turned out to
  // be decided by someone else (the bar's 409, or the shared cache moving
  // under the hold), the conflict sentence must outlive the bar that
  // reported it — the decide panel unmounts as soon as the row reads
  // decided. The row the page renders is adopted into `lost`, the sentence
  // replaces the decided summary's header, and Dismiss clears it.
  const [lost, setLost] = useState<DecisionConflict | null>(null);

  const project = (projects.data?.items ?? []).find((p) => p.id === approval.project_id);

  return (
    <Page
      layout="reading"
      title={
        <span title={approval.summary} data-testid={`approval-detail-title-${testid}`}>
          {attentionTitle(approval.summary)}
        </span>
      }
      subtitle={
        <>
          {project?.name ?? shortId(approval.project_id)} · run {shortId(approval.run_id)} ·{" "}
          {approval.node_instance_key ?? "unknown node"} · asked {formatAge(approval.created_at)}
        </>
      }
    >
      <div className="space-y-4">
        <GateStrip approval={approval} />

        <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="min-w-0 space-y-4">
            <SummaryCard approval={approval} summary={summary} testid={testid} />
            <PlanArtifact approval={approval} testid={testid} />
            <FilesItWillTouch testid={testid} />
          </div>

          <aside className="w-full space-y-4 lg:w-[360px]" aria-label="Decide">
            <WhoThenPanel approval={approval} meId={me.data?.id ?? null} />
            {approval.state === "pending" ? (
              <DecidePanel approval={approval} summary={summary.data ?? null} onLost={setLost} />
            ) : (
              <ClosedPanel
                approval={approval}
                testid={testid}
                lost={lost}
                onDismiss={() => setLost(null)}
              />
            )}
          </aside>
        </div>
      </div>
    </Page>
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

/** A closed gate: its decision, decider and note — nothing to act on. When
 * the viewer LOST the race to decide (finding 04), the conflict sentence
 * takes the header's place (`DecisionBar` renders it, sticky, from the facts
 * the lost bar reported) and the decided details — the note — stay below. */
function ClosedPanel({
  approval,
  testid,
  lost = null,
  onDismiss,
}: {
  approval: Approval;
  testid: string;
  lost?: DecisionConflict | null;
  onDismiss?: () => void;
}) {
  return (
    <Panel title="GATE" headingLevel={2}>
      {lost !== null ? (
        <div className="space-y-2 p-3" data-testid={`approval-detail-lost-${testid}`}>
          <DecisionBar
            approval={{
              id: approval.id,
              ...(approval.run_id ? { run_id: approval.run_id } : {}),
              ...(approval.project_id ? { project_id: approval.project_id } : {}),
            }}
            initialConflict={lost}
          />
          <Button
            variant="secondary"
            compact
            data-testid={`approval-detail-lost-dismiss-${testid}`}
            onClick={onDismiss}
          >
            Dismiss
          </Button>
        </div>
      ) : (
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
        </p>
      )}
      {approval.comments ? (
        <p
          className="px-3 pb-3 text-[13px] leading-[1.5] whitespace-pre-wrap text-muted"
          data-testid={`approval-detail-closed-comments-${testid}`}
        >
          “{approval.comments}”
        </p>
      ) : null}
    </Panel>
  );
}

/**
 * The right-rail decide panel (finding 04): the shared `DecisionBar` is the
 * only way to decide — fixed verbs (Approve / Request changes / Reject), a
 * 5s undo hold, the row's CAS `version`, no confirm step and no
 * "is not a decision word" fallback: a verb here is never model-written.
 * "OR IN YOUR WORDS" stays: a free-text reply the model interprets, and the
 * reading is shown as TEXT above the bar. The model proposes; it never
 * decides and never labels a verb.
 */
function DecidePanel({
  approval,
  summary,
  onLost,
}: {
  approval: Approval;
  summary: ApprovalSummary | null;
  /** Reported when the bar's decision loses the race (finding 04) — the page
   * keeps the sentence rendered after this panel unmounts with the pending
   * row. */
  onLost?: (conflict: DecisionConflict) => void;
}) {
  const testid = testidOf(approval.id);
  const [reply, setReply] = useState("");
  const [proposal, setProposal] = useState<ApprovalInterpretation | null>(null);
  const [interpretError, setInterpretError] = useState<string | null>(null);
  const interpret = useInterpretApproval(approval.id);
  const replyRef = useRef<HTMLTextAreaElement | null>(null);

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
            ? "The assistant isn't configured on this server — the decision bar above still works."
            : problemText(error),
        );
      },
    });
  };

  return (
    <Panel title="DECIDE" headingLevel={2}>
      <div className="space-y-3 p-3">
        <DecisionBar approval={approval} onConflict={onLost} />
        {summary === null ? (
          <p className="text-[11.5px] text-faint">
            The model summary is not configured on this server — the gate's own text is above.
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
            placeholder="Ask a question about the plan, or say what should change…"
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
            <div
              className="mt-2 rounded-[3px] border border-line bg-fill p-2.5"
              data-testid={`approval-detail-proposal-${testid}`}
            >
              <p className="text-[12.5px] leading-[1.45] text-ink">
                <span className="font-mono text-[10.5px] tracking-[.04em] text-faint">
                  READ AS ·{" "}
                </span>
                {proposal.interpretation}
              </p>
              <p className="mt-1 text-[12px] text-muted">
                reads like{" "}
                <code className="font-mono text-[11.5px] text-ink">
                  {proposal.proposed.decision === "approve" ? "approved" : "rejected"}
                </code>
                {proposal.proposed.comments
                  ? ` with the note: “${proposal.proposed.comments}”`
                  : ""}{" "}
                — the bar above decides, in your words if you like.
              </p>
              <div className="mt-2">
                <Button
                  variant="secondary"
                  className="h-[36px] text-[12px]"
                  onClick={() => {
                    setProposal(null);
                    replyRef.current?.focus();
                  }}
                >
                  Change it
                </Button>
              </div>
            </div>
          ) : null}
          <p className="mt-2 text-[11px] text-faint">the model only reads — you decide</p>
        </div>
      </div>
    </Panel>
  );
}
