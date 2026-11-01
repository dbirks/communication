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
 * The design's row at `md` and up (pass-1 review, this brief): one line of
 * glyph · title · `repo · agent` · age, with the title taking everything the
 * short mono cells do not need (`minmax(0,1fr)`), so it ellipsises only when
 * the row really runs out. The old five-column grid gave the agent's last line
 * a `2fr` middle cell, which cut the title at ~140px ("run 01a19709 /plan a…")
 * while most of the row sat empty — the row's name is the title, not the
 * preview, so the preview moved to a second line of its own, aligned under the
 * title.
 *
 * Below `md` the cells do not share any line at all — an earlier pass-2
 * review: at 390 one line truncated every cell to noise (`run 01a1… · app ·
 * m4… · 22s`). So the row stacks: the title line (glyph · title · age), then
 * the agent's last line, then the mono `repo · agent` meta — the 1g list
 * rows' order, in this panel's 12.5px rows. The title is ink 600, not the
 * link's blue: it is the row's name, and the whole row is the link.
 *
 * One DOM grid serves both: three columns at the phone widths (glyph · body ·
 * age) and four from `md` up, with each cell's column/row re-parked at the
 * breakpoint — so no element is ever rendered twice for a test or a reader to
 * find two of.
 */
import { Link } from "react-router";
import { useAgentProfiles, useConversations } from "../../api/queries";
import type { Project } from "../../api/types";
import { Panel } from "../ds/Panel";
import { Button } from "../ds/Button";
import { CONVERSATION_STATE, STATES, stateOf } from "../ds/states";
import { ProblemBanner, Spinner } from "../Feedback";
import { formatAge, testidOf } from "../../lib/format";
import { previewLine } from "../../lib/preview";
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
            <ProblemBanner
              error={threads.error}
              fallback="Threads could not be loaded."
              subject="this project's threads"
              retry={{
                onClick: () => void threads.refetch(),
                pending: threads.isFetching,
                testid: "recent-threads-retry",
              }}
            />
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
            // The served line is the agent's own text; its markdown markers
            // are stripped by the ONE shared preview helper (a bullet leaking
            // into the row read as markup, pass-1 review). Markup-only lines
            // preview as nothing, and the row then omits the line honestly.
            const preview = previewLine(thread.last_agent_line);
            // ADR-0065: the served repository wins; a null (unbound thread,
            // or a server predating the fields) falls back to what the live
            // workspaces say, exactly as before.
            const repo = thread.repository_name ?? repoSegment(repos.reposForThread(thread.id));
            return (
              <li key={thread.id}>
                <Link
                  to={routes.thread(thread.id)}
                  className="grid min-h-[38px] grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-[10px] gap-y-[2px] px-[12px] py-[6px] hover:bg-accent-wash focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent md:grid-cols-[auto_minmax(0,1fr)_auto_auto]"
                  data-testid={`project-thread-${testidOf(thread.id)}`}
                >
                  <span
                    className="col-start-1 row-start-1 shrink-0 text-center font-mono text-[11px]"
                    aria-hidden="true"
                  >
                    {STATES[state].glyph}
                  </span>
                  <span className="sr-only">{STATES[state].word}</span>
                  {/* The title: the design's `flex:1; min-width:0` cell — it
                      ellipsises only once the row truly runs out, because the
                      cells beside it (mono meta, age) take only their own
                      words. */}
                  <span
                    className="col-start-2 row-start-1 min-w-0 truncate text-[12.5px] font-semibold text-ink"
                    title={thread.title}
                  >
                    {thread.title}
                  </span>
                  {/* Phone: the third column of the title line. `md`: the
                      line's last cell, clear of the meta. */}
                  <span className="col-start-3 row-start-1 shrink-0 font-mono text-[10.5px] text-faint md:col-start-4">
                    {formatAge(thread.updated_at)}
                  </span>
                  {/* The agent's last line: under the title at both widths —
                      its own second row at `md`, never a cell that competes
                      with the title for the first line. */}
                  {preview ? (
                    <span
                      className="col-start-2 row-start-2 min-w-0 truncate text-[12.5px] text-muted"
                      title={preview}
                      data-testid={`project-thread-last-line-${testidOf(thread.id)}`}
                    >
                      {preview}
                    </span>
                  ) : null}
                  {/* Phone: the stacked mono line under the preview. `md`: a
                      cell of the first line, between the title and the age. */}
                  <span
                    className={`col-start-2 min-w-0 truncate font-mono text-[10.5px] text-muted md:col-start-3 md:row-start-1 ${
                      preview ? "row-start-3" : "row-start-2"
                    }`}
                  >
                    {threadMeta(
                      repo,
                      profiles.data?.items.find((p) => p.id === thread.agent_profile_id)?.name ??
                        null,
                    )}
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
