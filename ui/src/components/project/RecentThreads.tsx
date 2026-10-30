/**
 * RECENT THREADS (Projects Review design 1b): the three newest threads of this
 * project, as a pointer into the Threads tab.
 *
 * The row is the wire's own: glyph + word (`CONVERSATION_STATE`, never color
 * alone), the title, the age, and a mono line naming the agent profile — the
 * design's `storefront · Claude Code` also names a repository, and
 * `ConversationSummary` now serves one: ADR-0065's `repository_name` decides,
 * and a null (an unbound thread, or an older server) falls back to what the
 * project's workspaces say (`useProjectRepoIndex`). An agent profile id is
 * never printed as a uuid: the profile list is a separate read, so until it
 * lands the line says so. When the wire serves one, the row also carries
 * `last_agent_line` — never an invented line.
 *
 * ONE line per row at `md` and up, like the design: glyph · title · last line ·
 * `repo · agent` · age, each truncating with an ellipsis and a full `title`
 * tooltip. It used to stack the title, the last line and the mono line as three
 * `block` lines, so a row that had all three wrapped to two/three lines at 1280
 * and the panel read as paragraphs, not the design's one-line rows (pass-2
 * review).
 *
 * Below `md` those five cells do not fit one line at all — the same review's
 * second half: at 390 every cell had truncated to noise (`run 01a1… · app · m4…
 * · 22s`). So the row stacks: the title line (glyph · title · age), then the
 * agent's last line, then the mono `repo · agent` meta — the 1g list rows'
 * order, in this panel's 12.5px rows. The title is ink 600, not the link's
 * blue: it is the row's name, and the whole row is the link.
 *
 * One DOM serves both: a flex column at the phone widths, a five-column grid
 * from `md` up (`md:contents` dissolves the two grouping wrappers into the
 * grid), so no element is ever rendered twice for a test or a reader to find
 * two of.
 */
import { Link } from "react-router";
import { useAgentProfiles, useConversations } from "../../api/queries";
import type { Project } from "../../api/types";
import { Panel } from "../ds/Panel";
import { Button } from "../ds/Button";
import { CONVERSATION_STATE, STATES, stateOf } from "../ds/states";
import { ProblemBanner, Spinner } from "../Feedback";
import { formatAge, testidOf } from "../../lib/format";
import { routes } from "../../lib/routes";
import { repoSegment, useProjectRepoIndex } from "./useProjectRepoIndex";

/** Rows the overview shows before the Threads tab takes the rest. */
export const RECENT_THREADS_MAX = 3;

/** Newest first by the server's own `updated_at` (the list's order is kept when
 * the server already gave it). */
export function byUpdatedDesc<T extends { updated_at: string }>(threads: T[]): T[] {
  return [...threads].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

/** The mono line: `repo · agent`, or `agent` alone, or `agent unread` — never a
 * uuid, and never a repository nobody reported for the thread. `repo` arrives
 * from the served `repository_name` (ADR-0065) or, when that is null, from
 * the project's workspace index — this line never guesses. */
export function threadMeta(repo: string | null, profile: string | null): string {
  const parts: string[] = [];
  if (repo) parts.push(repo);
  parts.push(profile ?? "agent unread");
  return parts.join(" · ");
}

export interface RecentThreadsProps {
  project: Project;
  /** Opens the shared "New thread" dialog; offered only in the empty state. */
  onNewThread?: () => void;
  /** Whether the caller may start one (contributor or maintainer). */
  canStartThread?: boolean;
}

export function RecentThreads({
  project,
  onNewThread,
  canStartThread = false,
}: RecentThreadsProps) {
  // Same keys the header's tab count and the attention read use, mounted in the
  // same commit — TanStack dedupes them into one request.
  const threads = useConversations(project.id);
  const repos = useProjectRepoIndex(project.id);
  const profiles = useAgentProfiles();
  const rows = byUpdatedDesc(threads.data?.items ?? []).slice(0, RECENT_THREADS_MAX);

  return (
    <Panel
      id="recent-threads"
      title="RECENT THREADS"
      headingId="recent-threads-heading"
      headingLevel={2}
      meta={
        <Link
          to={routes.projectTab(project.id, "conversations")}
          className="font-mono text-[10.5px] normal-case"
          data-testid="project-all-threads"
        >
          all threads ›
        </Link>
      }
    >
      <div className="bg-surface">
        {threads.isPending ? (
          <div className="p-[10px]">
            <Spinner label="Loading threads" />
          </div>
        ) : null}
        {threads.isError ? (
          <div className="p-[10px]">
            <ProblemBanner error={threads.error} fallback="Threads could not be loaded." />
          </div>
        ) : null}
        {threads.data && rows.length === 0 ? (
          <div className="space-y-[6px] p-[10px]">
            <p className="text-[12.5px] text-muted" data-testid="project-threads-empty">
              No threads in this project yet.
            </p>
            {canStartThread && onNewThread ? (
              <Button
                variant="secondary"
                compact
                onClick={onNewThread}
                data-testid="project-threads-new"
              >
                New thread
              </Button>
            ) : null}
          </div>
        ) : null}
        <ul className="divide-y divide-line-soft" data-testid="project-threads">
          {rows.map((thread) => {
            const state = stateOf(CONVERSATION_STATE[thread.status]);
            // ADR-0065: the served repository wins; a null (unbound thread,
            // or a server predating the fields) falls back to what the live
            // workspaces say, exactly as before.
            const repo = thread.repository_name ?? repoSegment(repos.reposForThread(thread.id));
            return (
              <li key={thread.id}>
                <Link
                  to={routes.thread(thread.id)}
                  className="flex min-h-[38px] flex-col gap-[2px] px-[12px] py-[6px] hover:bg-accent-wash focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent md:grid md:grid-cols-[auto_minmax(0,1fr)_minmax(0,2fr)_minmax(0,1fr)_auto] md:items-center md:gap-x-[10px]"
                  data-testid={`project-thread-${testidOf(thread.id)}`}
                >
                  {/* Phone: the title line. `md`: dissolved into the grid, so
                      glyph, title and age are cells 1, 2 and 5. */}
                  <span className="flex min-w-0 items-center gap-[10px] md:contents">
                    <span className="shrink-0 text-center font-mono text-[11px]" aria-hidden="true">
                      {STATES[state].glyph}
                    </span>
                    <span className="sr-only">{STATES[state].word}</span>
                    <span
                      className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-ink"
                      title={thread.title}
                    >
                      {thread.title}
                    </span>
                    <span className="shrink-0 font-mono text-[10.5px] text-faint md:col-start-5">
                      {formatAge(thread.updated_at)}
                    </span>
                  </span>
                  {/* Phone: the stacked lines under the title, indented clear
                      of the glyph. `md`: cells 3 and 4 of the one line. */}
                  <span className="flex min-w-0 flex-col gap-[2px] pl-[21px] md:contents md:pl-0">
                    {thread.last_agent_line ? (
                      <span
                        className="min-w-0 truncate text-[12.5px] text-muted md:col-start-3"
                        title={thread.last_agent_line}
                        data-testid={`project-thread-last-line-${testidOf(thread.id)}`}
                      >
                        {thread.last_agent_line}
                      </span>
                    ) : null}
                    <span className="min-w-0 truncate font-mono text-[10.5px] text-muted md:col-start-4">
                      {threadMeta(
                        repo,
                        profiles.data?.items.find((p) => p.id === thread.agent_profile_id)?.name ??
                          null,
                      )}
                    </span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </Panel>
  );
}
