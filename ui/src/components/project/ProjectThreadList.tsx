/**
 * THREADS (Projects Review design 1b, tab 3): this project's threads, as the
 * list rows the Threads page already draws (design 1g) — not a second card
 * style invented for the project tab.
 *
 * A row is: the state glyph, the title, the relative age, and one mono line
 * naming what the person scanning actually wants — the repository and the agent
 * profile driving it (`RecentThreads`'s `threadMeta`, the same words the
 * overview prints), then wherever the wire serves it the last line the agent
 * wrote. The status is never a raw wire value: the glyph carries it and the
 * words exist only for the two states whose name is the news (`disconnected`,
 * `archived`), exactly as `components/threads/ThreadListPane` does it.
 *
 * What the tab keeps from the panel it replaces (`components/Conversations`,
 * ADR-0043): the debounced title search and the All/Manual/From-runs filter
 * travel to the list route as `q` and `origin`, and a run-origin row still
 * carries `OriginBadge` — the deep link into the Run Workbench at the node that
 * opened the thread. Those affordances stay here because the tab is where a
 * project's threads are read; the 1g pane is a different surface (it walks a
 * cross-project keyset page and names every project on every row).
 *
 * 390 reflow: a row is a flex column of truncating lines — the title, the last
 * line, the mono meta line with its badge — and the age is the only fixed-width
 * thing in it. Nothing clips: the old row put the status chip, the origin badge
 * and a long mono sentence on ONE line inside a 34px `Row`, so at 390 the badge
 * ate the row and "run 01a18abe…" was the whole sentence.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { useAgentProfiles, useConversations } from "../../api/queries";
import type { ConversationSummary, Project } from "../../api/types";
import { Button } from "../ds/Button";
import { Input } from "../ds/Field";
import { Panel } from "../ds/Panel";
import { CONVERSATION_STATE, STATES, stateOf, type StateName } from "../ds/states";
import { ProblemBanner, Spinner } from "../Feedback";
import { OriginBadge, titleSlug } from "../Conversations";
import { formatAge } from "../../lib/format";
import { routes } from "../../lib/routes";
import { byUpdatedDesc, threadMeta } from "./RecentThreads";
import { repoSegment, useProjectRepoIndex } from "./useProjectRepoIndex";

/** The origin filter, in the tab's own words ("all" is the unfiltered read). */
const ORIGIN_FILTERS = [
  { value: "all", label: "all", testid: "conversation-filter-all" },
  { value: "manual", label: "manual", testid: "conversation-filter-manual" },
  { value: "run", label: "from runs", testid: "conversation-filter-run" },
] as const;

type OriginFilter = (typeof ORIGIN_FILTERS)[number]["value"];

/** The one-line words a status gets: only the states whose name IS the news. */
const ROW_STATUS_WORDS: Partial<Record<ConversationSummary["status"], string>> = {
  disconnected: "disconnected",
  archived: "archived",
};

/**
 * Who may answer the agent, in plain words. The wire calls this the
 * `control` and the old row printed `controller: a pipeline run` — a field
 * label and a noun phrase (design review finding 2). Note the row does NOT
 * say it for a run: the badge beside it already names the run that opened
 * the thread and links to it, so repeating it would say one fact twice.
 */
function driverWords(conversation: ConversationSummary): string | null {
  if (conversation.control.kind === "none") return "nobody is driving it";
  if (conversation.control.kind === "run_attempt") return null;
  return `${conversation.control.display_name ?? "a member"} is driving it`;
}

export interface ProjectThreadListProps {
  project: Project;
  /** Whether the reader may start one (contributor or maintainer). */
  canStartThread?: boolean;
  /** Opens the shared "New thread" dialog fixed to this project (the frame's). */
  onNewThread?: () => void;
}

/** A project's threads, newest activity first. */
export function ProjectThreadList({
  project,
  canStartThread = false,
  onNewThread,
}: ProjectThreadListProps) {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [originFilter, setOriginFilter] = useState<OriginFilter>("all");

  // Debounced so a title is not re-fetched per keystroke (the panel it replaces
  // did the same; the list route's `q` is a server-side match).
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  const threads = useConversations(project.id, {
    origin: originFilter === "all" ? undefined : originFilter,
    q: debouncedQuery,
  });
  const profiles = useAgentProfiles();
  const repos = useProjectRepoIndex(project.id);
  const rows = byUpdatedDesc(threads.data?.items ?? []);
  // An active filter or search narrows an empty answer to "nothing matches";
  // only an unfiltered empty list may say the project has no threads yet.
  const filtered = debouncedQuery.trim() !== "" || originFilter !== "all";

  const profileName = (thread: ConversationSummary) =>
    profiles.data?.items.find((profile) => profile.id === thread.agent_profile_id)?.name ?? null;

  return (
    <Panel
      id="project-threads"
      title={threads.data ? `THREADS · ${rows.length}` : "THREADS"}
      headingId="project-conversations-heading"
      headingLevel={2}
      meta={
        canStartThread && onNewThread ? (
          <Button
            variant="secondary"
            compact
            onClick={onNewThread}
            data-testid="conversations-new-open"
          >
            + new thread
          </Button>
        ) : undefined
      }
    >
      <div className="bg-surface">
        <div className="flex flex-wrap items-center gap-[5px] border-b border-line px-[12px] py-[8px]">
          <div
            role="group"
            aria-label="Thread filters"
            className="flex flex-wrap items-center gap-[5px]"
            data-testid="conversation-filters"
          >
            {ORIGIN_FILTERS.map((filter) => (
              <button
                key={filter.value}
                type="button"
                aria-pressed={originFilter === filter.value}
                aria-label={`show ${filter.label} threads`}
                data-testid={filter.testid}
                onClick={() => setOriginFilter(filter.value)}
                className={`rounded-[2px] border px-[7px] py-[2px] font-mono text-[10.5px] ${
                  originFilter === filter.value
                    ? "border-ink bg-ink text-paper"
                    : "border-line-strong bg-surface text-muted hover:text-ink"
                }`}
              >
                {filter.label}
              </button>
            ))}
          </div>
          <Input
            id="project-threads-search"
            data-testid="conversation-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search threads"
            aria-label="Search threads by title"
            className="ml-auto w-[11rem] rounded-[2px] border border-line-strong bg-surface px-[6px] py-[2px] font-mono text-[10.5px] text-ink placeholder:text-faint focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
          />
        </div>

        {threads.isPending ? (
          <div className="p-[10px]">
            <Spinner label="Loading threads" />
          </div>
        ) : null}
        {threads.isError ? (
          // The pane on `/threads` says a failed read in one quiet line; this
          // page owns the loud banner, because here the list IS the page.
          <div className="p-[10px]">
            <ProblemBanner error={threads.error} fallback="Threads could not be loaded." />
          </div>
        ) : null}

        {threads.data ? (
          rows.length === 0 ? (
            filtered ? (
              <p
                className="px-[12px] py-[10px] text-[12.5px] text-muted"
                data-testid="conversation-list-nomatch"
              >
                No threads match this search or filter.
              </p>
            ) : (
              <div className="space-y-[6px] px-[12px] py-[10px]">
                <p className="text-[12.5px] text-muted" data-testid="conversation-list-empty">
                  No threads in this project yet.
                </p>
                {canStartThread ? (
                  <p className="text-[12.5px] text-muted">
                    <button
                      type="button"
                      className="text-accent-text underline hover:text-ink"
                      onClick={onNewThread}
                    >
                      Start one
                    </button>{" "}
                    — the dialog opens with this project already fixed.
                  </p>
                ) : null}
              </div>
            )
          ) : (
            <ul className="divide-y divide-line-soft" data-testid="conversation-list">
              {rows.map((thread) => (
                <ThreadRow
                  key={thread.id}
                  thread={thread}
                  profile={profileName(thread)}
                  repo={
                    thread.repository_name ?? repoSegment(repos.reposForThread(thread.id)) ?? null
                  }
                />
              ))}
            </ul>
          )
        ) : null}

        {canStartThread ? null : (
          <p className="border-t border-line px-[12px] py-[8px] text-[12.5px] text-muted">
            Only project contributors and maintainers can start a thread; anybody who can read the
            project can see this list.
          </p>
        )}
        <p className="border-t border-line px-[12px] py-[8px] font-mono text-[10.5px] text-faint">
          Every row opens the thread. A thread a run started says which one, and its badge goes to
          that run:{" "}
          <Link to={routes.threads()} className="text-accent-text hover:text-ink">
            all threads ›
          </Link>
        </p>
      </div>
    </Panel>
  );
}

/**
 * One 1g row: glyph, title, age; the mono `repo · agent` line; the last line the
 * agent wrote when the wire serves one (never an invented line). The glyph is
 * decorative, so the state word is spelled out for the screen reader.
 */
function ThreadRow({
  thread,
  repo,
  profile,
}: {
  thread: ConversationSummary;
  repo: string | null;
  profile: string | null;
}) {
  const state: StateName = stateOf(CONVERSATION_STATE[thread.status]);
  const spec = STATES[state];
  const word = ROW_STATUS_WORDS[thread.status];
  const driver = driverWords(thread);
  return (
    <li>
      <Link
        to={routes.thread(thread.id)}
        data-testid={`conversation-row-${titleSlug(thread.title, thread.id)}`}
        className="flex min-w-0 items-start gap-[10px] px-[12px] py-[8px] hover:bg-accent-wash focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
      >
        <span
          aria-hidden="true"
          className={`mt-[1px] shrink-0 font-mono text-[11px] ${spec.tagFg}`}
        >
          {spec.glyph}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-semibold text-ink" title={thread.title}>
            {thread.title}
          </span>
          {thread.last_agent_line ? (
            <span
              className="block truncate text-[12px] text-muted"
              data-testid={`conversation-last-line-${titleSlug(thread.title, thread.id)}`}
            >
              {thread.last_agent_line}
            </span>
          ) : null}
          <span className="mt-[1px] flex min-w-0 flex-wrap items-center gap-x-[6px] font-mono text-[10.5px] text-muted">
            <span className="truncate">
              {threadMeta(repo, profile)}
              {thread.has_active_turn ? " · a turn is open" : ""}
              {word ? ` · ${word}` : ""}
              {driver ? ` · ${driver}` : ""}
            </span>
            <OriginBadge conversation={thread} />
          </span>
        </span>
        <span className="shrink-0 font-mono text-[10.5px] text-faint">
          {formatAge(thread.updated_at)}
        </span>
        <span className="sr-only">{spec.word}</span>
      </Link>
    </li>
  );
}
