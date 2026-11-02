/**
 * The repo page's activity list (design 3a): filter chips (All · Runs · Chats
 * · Mine) over ONE panel of runs and chats mixed, newest activity first.
 *
 * Row grid `16px 44px minmax(0,1fr) 120px 36px`: state glyph (states.ts —
 * glyph + sr-only word, never color alone) · kind (`RUN` muted / `CHAT` in
 * accent text, mono 10) · title + short status · the workflow name or the
 * chat's agent profile (mono 10.5) · age. A waiting row gets the waiting pale
 * body background. A running run shows the ds ProgressStrip under its title
 * ONLY when the run data really carries per-step states — nothing is ever
 * invented. Every row links to its run or thread.
 */
import { useState } from "react";
import type { ConversationSummary, RunSummary } from "../../api/types";
import { Link } from "react-router";
import { CONVERSATION_STATE, RUN_STATE, SHORT_WORD, STATES, type StateName } from "../ds/states";
import { ProgressStrip, type ProgressSegment } from "../ds/ProgressStrip";
import { ProblemBanner, Spinner } from "../Feedback";
import { formatAge, shortId, testidOf } from "../../lib/format";
import { routes } from "../../lib/routes";

export type ActivityFilter = "all" | "runs" | "chats" | "mine";

const FILTERS: { id: ActivityFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "runs", label: "Runs" },
  { id: "chats", label: "Chats" },
  { id: "mine", label: "Mine" },
];

/** The merged feed row: a run or a chat, with the moment of its last
 * activity. Runs fall back through `finished_at` → `started_at` → created;
 * chats carry their own `updated_at`. */
export interface ActivityRow {
  kind: "run" | "chat";
  at: string;
  run?: RunSummary;
  conversation?: ConversationSummary;
}

/** One run's last activity: the moment its story last moved. */
function runActivityAt(run: RunSummary): string {
  return run.finished_at ?? run.started_at ?? run.created_at;
}

export function buildActivityRows(
  runs: readonly RunSummary[],
  conversations: readonly ConversationSummary[],
): ActivityRow[] {
  return [
    ...runs.map((run) => ({ kind: "run" as const, at: runActivityAt(run), run })),
    ...conversations.map((conversation) => ({
      kind: "chat" as const,
      at: conversation.updated_at,
      conversation,
    })),
  ].sort((a, b) => b.at.localeCompare(a.at));
}

/** The row's state, from the served status and nothing else. */
function rowState(row: ActivityRow): StateName {
  if (row.kind === "run") return RUN_STATE[row.run?.status ?? ""] ?? "queued";
  return CONVERSATION_STATE[row.conversation?.status ?? ""] ?? "info";
}

const STEP_TO_SEGMENT: Record<string, ProgressSegment["kind"]> = {
  succeeded: "done",
  running: "running",
  waiting: "waiting",
  failed: "failed",
  cancelled: "interrupted",
  skipped: "open",
  pending: "open",
};

/**
 * The run's real per-step segments, or null. The project run list does not
 * carry `steps`; the cross-project row (ADR-0047) does. When the data has no
 * steps the caller omits the strip — a strip with made-up segments would
 * break the honesty rule the whole page is written under.
 */
export function runStepSegments(run: RunSummary): ProgressSegment[] | null {
  const steps = (run as { steps?: { state?: string }[] }).steps;
  if (!Array.isArray(steps) || steps.length === 0) return null;
  const counts = new Map<ProgressSegment["kind"], number>();
  for (const step of steps) {
    const kind = STEP_TO_SEGMENT[step?.state ?? ""];
    if (!kind) continue;
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  const order: ProgressSegment["kind"][] = ["done", "running", "waiting", "failed", "open"];
  return order
    .filter((kind) => counts.has(kind))
    .map((kind) => ({ kind, count: counts.get(kind) ?? 0 }));
}

export interface RepoActivityProps {
  rows: ActivityRow[];
  /** The pipeline's human name for a run row's fourth cell. */
  nameFor: (pipelineId: string) => string | null;
  /** The agent profile's name for a chat row's fourth cell. */
  profileNameFor: (agentProfileId: string) => string | null;
  /** The caller's user id — the `Mine` filter and nothing else. */
  meId: string | null;
  repositoryName: string;
  /** The `all ›` link's destination: the project's Runs tab. */
  projectId: string;
  /** The assignments read failed: the unnamed runs cannot be claimed for
   * this repository, and the panel says plainly that they are the project's. */
  showProjectNote?: boolean;
  runsPending: boolean;
  runsError: unknown;
  onRetryRuns: () => void;
  retryingRuns: boolean;
  chatsPending: boolean;
  chatsError: unknown;
  onRetryChats: () => void;
  retryingChats: boolean;
}

export function RepoActivity({
  rows,
  nameFor,
  profileNameFor,
  meId,
  repositoryName,
  projectId,
  showProjectNote = false,
  runsPending,
  runsError,
  onRetryRuns,
  retryingRuns,
  chatsPending,
  chatsError,
  onRetryChats,
  retryingChats,
}: RepoActivityProps) {
  const [filter, setFilter] = useState<ActivityFilter>("all");

  const visible = rows.filter((row) => {
    if (filter === "runs") return row.kind === "run";
    if (filter === "chats") return row.kind === "chat";
    if (filter === "mine") {
      if (!meId) return false;
      return row.kind === "run"
        ? row.run?.triggered_by === meId
        : row.conversation?.created_by === meId;
    }
    return true;
  });

  return (
    <div className="min-w-0 space-y-3" data-testid="repo-activity">
      <div className="flex flex-wrap items-center gap-2">
        <div
          className="flex items-center gap-2"
          role="group"
          aria-label="Filter activity"
          data-testid="repo-activity-filters"
        >
          {FILTERS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              aria-pressed={filter === entry.id}
              onClick={() => setFilter(entry.id)}
              className={`inline-flex h-6 items-center rounded-[2px] border px-[8px] text-[12px] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent ${
                filter === entry.id
                  ? "border-ink font-bold text-ink"
                  : "border-line-strong font-normal text-muted hover:bg-fill"
              }`}
              data-testid={`repo-filter-${entry.id}`}
            >
              {entry.label}
            </button>
          ))}
        </div>
        {/* The successor of RECENT RUNS' `all ›`: the full run list lives on the
            project's Runs tab. */}
        <Link
          to={routes.projectTab(projectId, "runs")}
          className="ml-auto font-mono text-[10.5px] text-accent-text hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
          data-testid="repo-runs-all"
        >
          all ›
        </Link>
      </div>
      <div
        className="overflow-hidden rounded-[3px] border border-line-strong bg-surface"
        data-testid="repo-runs"
      >
        {runsPending || chatsPending ? (
          <div className="p-[10px]">
            <Spinner label="Loading activity" />
          </div>
        ) : null}
        {runsError ? (
          <div className="p-[10px]">
            <ProblemBanner
              error={runsError}
              fallback="Runs could not be loaded."
              subject="this repository's runs"
              retry={{
                onClick: onRetryRuns,
                pending: retryingRuns,
                testid: "repo-runs-retry",
              }}
            />
          </div>
        ) : null}
        {chatsError ? (
          <div className="p-[10px]">
            <ProblemBanner
              error={chatsError}
              fallback="Conversations could not be loaded."
              subject="this repository's chats"
              retry={{
                onClick: onRetryChats,
                pending: retryingChats,
                testid: "repo-activity-chats-retry",
              }}
            />
          </div>
        ) : null}
        {!runsPending && !chatsPending && !runsError && !chatsError && visible.length === 0 ? (
          <p className="p-[10px] text-[12.5px] text-muted" data-testid="repo-activity-empty">
            <span data-testid="repo-runs-empty">
              No {filter === "chats" ? "chats" : filter === "runs" ? "runs" : "runs or chats"} in{" "}
              {repositoryName}
              {filter === "mine" ? " started by you" : ""} yet — say something in the chat box above
              and this page will have a first row.
            </span>
          </p>
        ) : null}
        <ul>
          {visible.map((row) => (
            <ActivityRowView
              key={`${row.kind}-${row.kind === "run" ? row.run?.id : row.conversation?.id}`}
              row={row}
              nameFor={nameFor}
              profileNameFor={profileNameFor}
            />
          ))}
        </ul>
        {showProjectNote ? (
          <p
            className="border-t border-line-soft px-3 py-[8px] text-[12px] leading-[16px] text-muted"
            data-testid="repo-runs-project-note"
          >
            These are the project's runs — this repository's own runs could not be told apart.
          </p>
        ) : null}
      </div>
    </div>
  );
}

const ROW_GRID =
  "grid grid-cols-[16px_44px_minmax(0,1fr)_120px_36px] items-center gap-x-2 border-t border-line-soft px-3 py-[8px] first:border-t-0 hover:bg-paper";

function ActivityRowView({
  row,
  nameFor,
  profileNameFor,
}: {
  row: ActivityRow;
  nameFor: (pipelineId: string) => string | null;
  profileNameFor: (agentProfileId: string) => string | null;
}) {
  const state = rowState(row);
  const spec = STATES[state];
  const waiting = state === "waiting";

  if (row.kind === "run" && row.run) {
    const run = row.run;
    const name = nameFor(run.pipeline_id);
    const segments = runStepSegments(run);
    return (
      <li>
        <Link
          to={routes.run(run.id)}
          title={run.id}
          className={`${ROW_GRID} ${waiting ? "bg-st-waiting-pale-body hover:bg-st-waiting-pale-body" : ""}`}
          data-testid={`repo-run-${testidOf(run.id)}`}
        >
          <span aria-hidden="true" className={`font-mono text-[11px] ${spec.tagFg}`}>
            {spec.glyph}
          </span>
          <span className="sr-only" data-testid={`repo-run-status-${testidOf(run.id)}`}>
            {SHORT_WORD[state]}
          </span>
          <span className="font-mono text-[10px] text-muted">RUN</span>
          <span className="min-w-0">
            <span className="block truncate text-[12.5px] text-ink">
              <span className="font-semibold">
                {run.title ?? name ?? `Run #${shortId(run.id)}`}
              </span>
              {` · ${SHORT_WORD[state]}`}
            </span>
            {state === "running" && segments ? (
              <ProgressStrip
                variant="J"
                stages={[{ label: "steps", active: true, segments }]}
                className="mt-[3px] max-w-[200px]"
              />
            ) : null}
          </span>
          <span className="min-w-0 truncate font-mono text-[10.5px] text-muted" title={name ?? ""}>
            {name ?? ""}
          </span>
          <span className="truncate text-right font-mono text-[10.5px] text-faint">
            {formatAge(runActivityAt(run))}
          </span>
        </Link>
      </li>
    );
  }

  const conversation = row.conversation;
  if (!conversation) return null;
  const agent = profileNameFor(conversation.agent_profile_id);
  return (
    <li>
      <Link
        to={routes.thread(conversation.id)}
        title={conversation.id}
        className={`${ROW_GRID} ${waiting ? "bg-st-waiting-pale-body hover:bg-st-waiting-pale-body" : ""}`}
        data-testid={`repo-chat-row-${testidOf(conversation.id)}`}
      >
        <span aria-hidden="true" className={`font-mono text-[11px] ${spec.tagFg}`}>
          {spec.glyph}
        </span>
        <span className="sr-only">{SHORT_WORD[state]}</span>
        <span className="font-mono text-[10px] font-semibold text-accent-text">CHAT</span>
        <span className="block min-w-0 truncate text-[12.5px] text-ink">
          <span className="font-semibold">{conversation.title}</span>
          {` · ${SHORT_WORD[state]}`}
        </span>
        <span
          className="min-w-0 truncate font-mono text-[10.5px] text-muted"
          title={agent ?? conversation.agent_profile_id}
        >
          {agent ?? ""}
        </span>
        <span className="truncate text-right font-mono text-[10.5px] text-faint">
          {formatAge(conversation.updated_at)}
        </span>
      </Link>
    </li>
  );
}
