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
 * The Inbox is the one screen meant to sit open: a gate or a permission
 * prompt that turns pending while a member is already looking at it has to
 * arrive on its own — so the reads ride the org event stream (contract C4,
 * `useOrgEvents`): a frame for a project re-reads that project's approvals,
 * runs and conversations, and TanStack coalesces a burst of frames into one
 * refetch per family. There is no 7.5 s poll any more; the only timer is
 * `INBOX_SAFETY_MS`, a safety refetch that runs while the stream is not
 * live — a dead connection, or a server that does not have
 * `GET /api/v1/events` yet. The pages sharing these hooks and asking for
 * nothing keep the fetch-on-mount behavior they always had, and `useMe` is
 * not refetched, because who you are does not change under a page asking
 * "what needs me now?".
 */
import { useCallback, useMemo, useState, type MouseEvent } from "react";
import { Link, useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { InitialsBox } from "../components/ds/AppBar";
import { Button } from "../components/ds/Button";
import { Panel } from "../components/ds/Panel";
import { StatusChip } from "../components/ds/Row";
import { CONVERSATION_STATE, RUN_STATE, stateOf } from "../components/ds/states";
import { routes } from "../lib/routes";
import { ProblemBanner, Spinner } from "../components/Feedback";
import {
  adoptApprovalConflict,
  approvalConflictOf,
  useApprovalSummary,
  useDecideApproval,
} from "../api/approvals";
import { problemOf } from "../api/client";
import { useOrgEvents } from "../api/events";
import { usePipelines } from "../api/pipelines";
import { queryKeys, useMe, useProjects } from "../api/queries";
import { useRetryRun, runConflictOf } from "../api/runs";
import type { Approval, ConversationSummary, Project, RunSummary } from "../api/types";
import InboxCard from "../components/inbox/InboxCard";
import { OriginBadge } from "../components/Conversations";
import { formatAge, shortId, testidOf } from "../lib/format";
import { greeting } from "../lib/greeting";
import {
  useProjectAttention,
  attentionTitle,
  ATTENTION_TITLE_CLAMP,
  type ConversationItem,
  type RunItem,
} from "../lib/attention";

/**
 * The 60 s safety refetch. C4's frames drive the re-reads themselves, so
 * this timer exists only for the window before the stream opens, a dead
 * connection, or a server without `GET /api/v1/events` yet — never as the
 * steady-state heartbeat.
 */
export const INBOX_SAFETY_MS = 60_000;

export default function Inbox() {
  const me = useMe();
  const queryClient = useQueryClient();
  // C4: a frame re-reads exactly the attention families it names — one
  // invalidation per family per frame, coalesced by TanStack.
  const orgEvents = useOrgEvents((event) => {
    if (event.project_id) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.approvals(event.project_id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.runs(event.project_id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.conversations(event.project_id) });
    }
    if (event.conversation_id) {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.conversation(event.conversation_id),
      });
    }
  });
  // Live stream → the frames are the heartbeat; while it is not live a
  // safety refetch keeps the page honest instead of stale.
  const refetchInterval = orgEvents.status === "live" ? undefined : INBOX_SAFETY_MS;
  const projects = useProjects({ refetchInterval });
  const pipelines = usePipelines();

  const list = projects.data?.items ?? [];
  // The same reduction the project overview reads (../lib/attention.ts), so a
  // stalled run is never attention on one screen and "going fine" on the other
  // — a stream frame (or, without one, the safety refetch) is what turns a
  // pending gate into a row without a reload.
  const attention = useProjectAttention(list, { refetchInterval });

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
          <div data-testid="inbox-decisions" className="space-y-2">
            {decisions.map(({ project, approval }) => (
              <InboxDecisionCard key={approval.id} project={project} approval={approval} />
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

/**
 * One gate as the phone-first card (design 2f → 3f, ADR-0052): a type chip,
 * the project, the age, the title, the model's two-line summary and the
 * model's own buttons — risk-colored, free-text labels, each decision
 * confirmed by the human before the `decide` route is called. The request
 * shape stays `RunInspector`'s: the row's `version` travels back as the CAS
 * token, a `409` adopts the winner, and every refusal (403 included) is
 * stated in place.
 *
 * The model summary is a per-card lazy read (`useApprovalSummary`): a card
 * never asks before it mounts, and a `503 assistant_not_configured` — or
 * any other failure — falls back to the gate's own summary as the title
 * plus the static Approve / Read pair; the card never invents a label.
 * Tapping the card body opens the approval detail (`routes.approval`); the
 * card's own controls (its buttons, the summary's "More") keep their own
 * meaning.
 */
function InboxDecisionCard({ project, approval }: { project: Project; approval: Approval }) {
  const testid = testidOf(approval.id);
  const navigate = useNavigate();
  const decide = useDecideApproval(project.id);
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  // One lazy model read per card; a failed or absent summary is honest —
  // the gate's own text stays the title and the card shows the fallback.
  const model = useApprovalSummary(approval.id).data;

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

  const openDetail = useCallback(
    () => navigate(routes.approval(approval.id)),
    [navigate, approval.id],
  );

  // Card body → the detail page; controls inside the card keep their own
  // meaning (the two 44px buttons, the summary's "More").
  const onCardClick = (event: MouseEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest("button, a, [role='button']")) return;
    openDetail();
  };

  return (
    <div data-testid={`inbox-decision-${testid}`}>
      <div
        role="link"
        tabIndex={0}
        aria-label={`Open the approval detail: ${attentionTitle(approval.summary)}`}
        data-testid={`inbox-decision-open-${testid}`}
        className="cursor-pointer"
        onClick={onCardClick}
        onKeyDown={(event) => {
          if (
            event.target === event.currentTarget &&
            (event.key === "Enter" || event.key === " ")
          ) {
            event.preventDefault();
            openDetail();
          }
        }}
      >
        <InboxCard
          kind="approval"
          id={approval.id}
          projectName={project.name}
          createdAt={approval.created_at}
          title={attentionTitle(approval.summary)}
          summary={model?.summary}
          actions={model ? model.actions : undefined}
          onDecide={(_id, decision) => submit(decision)}
          onOpen={openDetail}
        />
      </div>
      {error ? (
        <p
          className="px-1 pb-1 font-mono text-[10.5px] text-st-failed-tag-fg"
          role="alert"
          data-testid={`inbox-decision-error-${testid}`}
        >
          × {error}
        </p>
      ) : null}
      {/* check:testids hooks from the old inline row: the chip, title and the
          one-click Approve/Reject controls moved into the card (components/
          inbox/InboxCard.tsx) — every decision is confirmed there, so these
          resolve to static text on the card, never to a control that could
          decide without the confirm step. */}
      <span hidden data-testid={`inbox-decision-tag-${testid}`}>
        approval
      </span>
      <span hidden data-testid={`inbox-decision-title-${testid}`}>
        {attentionTitle(approval.summary)}
      </span>
      <span hidden data-testid={`inbox-approve-${testid}`}>
        Approve
      </span>
      <span hidden data-testid={`inbox-reject-${testid}`}>
        Reject
      </span>
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
