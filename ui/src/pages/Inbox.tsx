/**
 * `/inbox` — the org-level attention inbox (design 6a): one prioritized list
 * across every project the caller belongs to, acted on inline.
 *
 * Honesty rules are `pages/ProjectRuns.tsx`'s: the wire carries no run *name*
 * and no approval *title*, so a row shows the gate's `summary`, its
 * `node_instance_key`, the pipeline slug from the library and the short ids the
 * server actually serves. Nothing is invented.
 *
 * 6a's CONVERSATIONS section reads `listConversations`, whose row carries no
 * pending-permission field — only `getConversation`'s `pending_permissions`
 * does. A prompt can only be pending while a turn is in flight, so that detail
 * is read for the conversations reporting `has_active_turn` and nobody else: a
 * PERMISSION tag is always an observed pending row, and every other row wears
 * the status word the wire serves. No "needs you" signal is composed here.
 *
 * The Inbox is the one screen meant to sit open: a gate or a permission prompt
 * that turns pending while a member is already looking at it has to arrive on
 * its own. So its reads poll on `INBOX_POLL_MS` — the same mechanism as
 * `useHealth`'s 15s ticker (no SSE feed exists for attention yet) — while the
 * pages sharing these hooks and asking for nothing keep the fetch-on-mount
 * behavior they always had. TanStack's default `refetchIntervalInBackground:
 * false` means the ticker only runs while the tab is visible; `useMe` is not
 * polled, because who you are does not change under a page asking "what needs
 * me now?".
 */
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { InitialsBox } from "../components/ds/AppBar";
import { Button } from "../components/ds/Button";
import { Panel } from "../components/ds/Panel";
import { StatusChip } from "../components/ds/Row";
import { CONVERSATION_STATE, RUN_STATE, stateOf } from "../components/ds/states";
import { routes } from "../lib/routes";
import { ProblemBanner, Spinner } from "../components/Feedback";
import { adoptApprovalConflict, approvalConflictOf, useDecideApproval } from "../api/approvals";
import { problemOf } from "../api/client";
import { usePipelines } from "../api/pipelines";
import { useRetryRun, runConflictOf } from "../api/runs";
import { useMe, useProjects } from "../api/queries";
import type { Approval, ConversationSummary, Project, RunSummary } from "../api/types";
import { OriginBadge } from "../components/Conversations";
import { formatAge, shortId, testidOf } from "../lib/format";
import {
  useProjectAttention,
  attentionTitle,
  ATTENTION_TITLE_CLAMP,
  type ConversationItem,
  type RunItem,
} from "../lib/attention";

/** How often an open Inbox re-reads what asks something of you. */
export const INBOX_POLL_MS = 7_500;

export default function Inbox() {
  const me = useMe();
  const projects = useProjects({ refetchInterval: INBOX_POLL_MS });
  const pipelines = usePipelines();

  const list = projects.data?.items ?? [];
  // The same reduction the project overview reads (../lib/attention.ts), so a
  // stalled run is never attention on one screen and "going fine" on the other
  // — polled here so a prompt that turns pending shows up without a reload.
  const attention = useProjectAttention(list, { refetchInterval: INBOX_POLL_MS });

  const slugs = useMemo(
    () =>
      new Map((pipelines.data?.pipelines ?? []).map((pipeline) => [pipeline.id, pipeline.slug])),
    [pipelines.data],
  );

  if (projects.isPending) {
    // A div, not a p element: the Spinner renders a <p> itself.
    return (
      <div data-testid="inbox-loading">
        <Spinner label="Reading your projects" />
      </div>
    );
  }
  if (projects.isError) {
    return <ProblemBanner error={projects.error} fallback="Your projects could not be read." />;
  }

  const { decisions, stalled, conversations, running, unread } = attention;
  const summary = `Across ${list.length} ${list.length === 1 ? "project" : "projects"}: ${decisions.length} ${decisions.length === 1 ? "decision" : "decisions"}, ${stalled.length} stalled ${stalled.length === 1 ? "run" : "runs"}, ${conversations.length} ${conversations.length === 1 ? "conversation" : "conversations"}. ${running.length} ${running.length === 1 ? "run is" : "runs are"} going fine.`;

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h1 className="text-[22px] leading-[28px] font-semibold" data-testid="inbox-greeting">
          {greeting(new Date(), me.data?.display_name)}
        </h1>
        <p className="text-[13px] text-muted" data-testid="inbox-summary">
          {summary}
        </p>
      </header>

      {unread.length > 0 ? (
        <ul className="space-y-1" data-testid="inbox-unread">
          {unread.map(({ project, title }) => (
            <li key={project.id} className="font-mono text-[10.5px] text-st-failed-tag-fg">
              × {project.name}: {title}
            </li>
          ))}
        </ul>
      ) : null}

      {decisions.length === 0 &&
      stalled.length === 0 &&
      conversations.length === 0 &&
      running.length === 0 ? (
        <p className="text-[13px] text-muted" data-testid="inbox-empty">
          Nothing needs you.
        </p>
      ) : null}

      {decisions.length > 0 ? (
        <Panel
          title={`NEEDS YOUR DECISION · ${decisions.length}`}
          headingId="inbox-decisions-heading"
          headingLevel={2}
          state="waiting"
        >
          <div data-testid="inbox-decisions">
            {decisions.map(({ project, approval }) => (
              <DecisionRow key={approval.id} project={project} approval={approval} />
            ))}
          </div>
        </Panel>
      ) : null}

      {stalled.length > 0 ? (
        <Panel
          title={`STALLED · ${stalled.length}`}
          headingId="inbox-stalled-heading"
          headingLevel={2}
        >
          <div data-testid="inbox-stalled">
            {stalled.map(({ project, run }) => (
              <StalledRow key={run.id} project={project} run={run} slugs={slugs} />
            ))}
          </div>
        </Panel>
      ) : null}

      {conversations.length > 0 ? (
        <Panel
          title={`CONVERSATIONS · ${conversations.length}`}
          headingId="inbox-conversations-heading"
          headingLevel={2}
        >
          <div data-testid="inbox-conversations">
            {conversations.map((item) => (
              <ConversationRow key={item.conversation.id} item={item} />
            ))}
          </div>
        </Panel>
      ) : null}

      {running.length > 0 ? <RunningStrip items={running} slugs={slugs} /> : null}
    </div>
  );
}

/** "Good morning|afternoon|evening, <first name>" — the wall clock's, not the
 * server's (the wire carries no greeting). */
export function greeting(now: Date, displayName: string | undefined | null): string {
  const hour = now.getHours();
  const part = hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
  const first = displayName?.trim().split(/\s+/)[0];
  return `Good ${part}, ${first || "there"}`;
}

/**
 * One gate, decided inline. The request shape is `RunInspector`'s: the row's
 * `version` travels back as the CAS token, a `409` adopts the winner rather
 * than overwriting it, and every refusal (403 included) is stated in place.
 */
function DecisionRow({ project, approval }: { project: Project; approval: Approval }) {
  const decide = useDecideApproval(project.id);
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const run = shortId(approval.run_id);

  const submit = (decision: "approved" | "rejected") => {
    setError(null);
    decide.mutate(
      { approvalId: approval.id, body: { decision, version: approval.version } },
      {
        onSuccess: () => setError(null),
        onError: (err) => {
          if (approvalConflictOf(err)) {
            adoptApprovalConflict(queryClient, err);
            setError("someone decided this gate first — what you see now is the winner's");
          } else {
            setError(problemOf(err).detail || problemOf(err).title);
          }
        },
      },
    );
  };

  return (
    <div
      className="border-b border-line last:border-b-0"
      data-testid={`inbox-decision-${testidOf(approval.id)}`}
    >
      <div className="flex items-center gap-[10px] px-[10px] py-[8px]">
        <InitialsBox name={project.name} />
        <StatusChip
          state="waiting"
          label="approval"
          labelProps={{ "data-testid": `inbox-decision-tag-${testidOf(approval.id)}` }}
        />
        <div className="min-w-0 flex-1">
          <p
            className={`text-[13.5px] font-semibold ${ATTENTION_TITLE_CLAMP}`}
            data-testid={`inbox-decision-title-${testidOf(approval.id)}`}
            title={approval.summary}
          >
            {attentionTitle(approval.summary)}
          </p>
          <p className="font-mono text-[10.5px] text-muted">
            {project.name} · run {run} · {approval.node_instance_key}
          </p>
        </div>
        <span className="font-mono text-[10.5px] text-faint">{formatAge(approval.created_at)}</span>
        <Button
          variant="primary"
          compact
          disabled={decide.isPending}
          data-testid={`inbox-approve-${testidOf(approval.id)}`}
          onClick={() => submit("approved")}
        >
          {decide.isPending ? "Posting…" : "Approve"}
        </Button>
        <Button
          variant="secondary"
          compact
          disabled={decide.isPending}
          data-testid={`inbox-reject-${testidOf(approval.id)}`}
          onClick={() => submit("rejected")}
        >
          Reject
        </Button>
      </div>
      {error ? (
        <p
          className="px-[10px] pb-[8px] font-mono text-[10.5px] text-st-failed-tag-fg"
          role="alert"
          data-testid={`inbox-decision-error-${testidOf(approval.id)}`}
        >
          × {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * A run that stopped without finishing. The wire carries no run title, so the
 * row names the run by its short id and, when the server gave one, its
 * `failed_cause` — never an invented reason.
 */
function StalledRow({
  project,
  run,
  slugs,
}: {
  project: Project;
  run: RunSummary;
  slugs: ReadonlyMap<string, string>;
}) {
  const retry = useRetryRun(run.id);
  const [error, setError] = useState<string | null>(null);
  const slug = slugs.get(run.pipeline_id);

  return (
    <div
      className="border-b border-line last:border-b-0"
      data-testid={`inbox-stalled-${testidOf(run.id)}`}
    >
      <div className="flex items-center gap-[10px] px-[10px] py-[8px]">
        <InitialsBox name={project.name} />
        <StatusChip
          state={stateOf(RUN_STATE[run.status])}
          label={run.status}
          labelProps={{ "data-testid": `inbox-stalled-status-${testidOf(run.id)}` }}
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13.5px] font-semibold">
            Run {shortId(run.id)}
            {run.failed_cause ? ` — ${run.failed_cause}` : ""}
          </p>
          <p className="font-mono text-[10.5px] text-muted">
            {project.name} · {slug ?? `run ${shortId(run.id)}`} · {run.status}
          </p>
        </div>
        <span className="font-mono text-[10.5px] text-faint">{formatAge(run.created_at)}</span>
        <Link
          to={routes.run(run.id)}
          className="ds-btn ds-btn--secondary inline-flex h-[26px] items-center rounded-[4px] px-[10px]"
          data-testid={`inbox-open-run-${testidOf(run.id)}`}
        >
          Open run
        </Link>
        {run.status === "failed" ? (
          <Button
            variant="secondary"
            compact
            disabled={retry.isPending}
            data-testid={`inbox-retry-${testidOf(run.id)}`}
            onClick={() => {
              setError(null);
              retry.mutate(
                {},
                {
                  onSuccess: () => setError(null),
                  onError: (err) => {
                    const conflict = runConflictOf(err);
                    setError(
                      conflict
                        ? `not retriable — the run is ${conflict.run_status}`
                        : problemOf(err).detail || problemOf(err).title,
                    );
                  },
                },
              );
            }}
          >
            {retry.isPending ? "Retrying…" : "Retry"}
          </Button>
        ) : null}
      </div>
      {error ? (
        <p
          className="px-[10px] pb-[8px] font-mono text-[10.5px] text-st-failed-tag-fg"
          role="alert"
          data-testid={`inbox-retry-error-${testidOf(run.id)}`}
        >
          × {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * A conversation someone can still work in. The wire gives the list row a
 * title, a status and a controller and nothing else, so those are the whole
 * row: a PERMISSION tag only when `getConversation` reported a pending prompt,
 * the status word otherwise. The only action offered is opening it — answering
 * a prompt and taking control live on `pages/Conversation.tsx`, and deciding
 * them from a list would mean duplicating their CAS from here.
 */
function ConversationRow({ item }: { item: ConversationItem }) {
  const { project, conversation, pendingPermissions } = item;
  const needsPermission = pendingPermissions > 0;
  const title = conversation.title.trim() || `conversation ${shortId(conversation.id)}`;

  return (
    <div
      className="border-b border-line last:border-b-0"
      data-testid={`inbox-conversation-${testidOf(conversation.id)}`}
    >
      <div className="flex items-center gap-[10px] px-[10px] py-[8px]">
        <InitialsBox name={project.name} />
        <StatusChip
          state={needsPermission ? "waiting" : stateOf(CONVERSATION_STATE[conversation.status])}
          label={needsPermission ? "permission" : conversation.status}
          labelProps={{ "data-testid": `inbox-conversation-tag-${testidOf(conversation.id)}` }}
        />
        <div className="min-w-0 flex-1">
          <p className={`text-[13.5px] font-semibold ${ATTENTION_TITLE_CLAMP}`} title={title}>
            {title}
          </p>
          <p className="font-mono text-[10.5px] text-muted">
            <OriginBadge conversation={conversation} /> {project.name} · controller{" "}
            {controllerName(conversation)} · {conversation.status}
            {conversation.has_active_turn ? " · turn open" : ""}
          </p>
        </div>
        <span className="font-mono text-[10.5px] text-faint">
          {formatAge(conversation.updated_at)}
        </span>
        <Link
          to={routes.thread(conversation.id)}
          className="ds-btn ds-btn--secondary inline-flex h-[26px] items-center rounded-[4px] px-[10px]"
          data-testid={`inbox-open-conversation-${testidOf(conversation.id)}`}
        >
          {needsPermission ? "Open" : "Open conversation"}
        </Link>
      </div>
    </div>
  );
}

/** Who is driving, in as few words as the control row allows. The same reading
 * `components/Conversations.tsx` gives: a name when the server resolved one,
 * the kind when it did not, never a bare uuid. */
function controllerName(conversation: ConversationSummary): string {
  if (conversation.control.kind === "none") return "nobody";
  if (conversation.control.kind === "run_attempt") return "a pipeline run";
  return conversation.control.display_name ?? "a member";
}

/**
 * PROGRESS-style dashed strip: work that is going fine gets one quiet line
 * rather than a section of rows, because nothing here asks anything of you.
 */
function RunningStrip({
  items,
  slugs,
}: {
  items: readonly RunItem[];
  slugs: ReadonlyMap<string, string>;
}) {
  return (
    <div
      className="flex flex-wrap items-center gap-x-[12px] gap-y-[6px] rounded-[3px] border border-dashed border-line-strong bg-surface px-[10px] py-[7px]"
      data-testid="inbox-running"
    >
      <span className="font-mono text-[10px] font-semibold tracking-[.04em] text-faint uppercase">
        running fine · {items.length}
      </span>
      {items.map(({ project, run }) => (
        <span
          key={run.id}
          className="inline-flex items-center gap-[6px] font-mono text-[10.5px] text-ink-2"
          data-testid={`inbox-running-${testidOf(run.id)}`}
        >
          <span aria-hidden="true" className="text-muted">
            {initialsOf(project.name)}
          </span>
          <Link to={routes.run(run.id)} className="text-accent-text">
            {shortId(run.id)}
          </Link>
          <span>{slugs.get(run.pipeline_id) ?? "pipeline"}</span>
          <span className="text-muted">{run.status}</span>
        </span>
      ))}
    </div>
  );
}

/** The same two-letter reading `InitialsBox` gives, in inline mono. */
function initialsOf(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? "")
      .join("") || "?"
  );
}
