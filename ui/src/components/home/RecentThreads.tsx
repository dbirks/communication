/**
 * The briefing's recent threads (artboard 2a): one-off conversations
 * (`origin === "manual"`, ADR-0043) across every visible project, at most
 * five, newest first. The wire carries no thread *body*, so a row shows
 * what it carries — title, project, the agent profile it was started
 * with, age — and nothing invented.
 */
import { useState } from "react";
import { Link } from "react-router";
import { Row } from "../ds/Row";
import { Panel } from "../ds/Panel";
import { STATES, CONVERSATION_STATE, stateOf } from "../ds/states";
import NewConversationDialog from "../NewConversationDialog";
import type { ConversationSummary } from "../../api/types";
import { formatAge, testidOf } from "../../lib/format";
import { routes } from "../../lib/routes";

/** How many threads the briefing renders before pointing at /threads. */
export const THREADS_MAX = 5;

export interface RecentThreadsProps {
  /** `origin === "manual"` rows only, newest first (the page filters). */
  threads: ConversationSummary[];
  /** `project_id` → display name (the cross-project list carries ids). */
  projectNames: ReadonlyMap<string, string>;
  /** `agent_profile_id` → display name. */
  profileNames: ReadonlyMap<string, string>;
}

export function RecentThreads({ threads, projectNames, profileNames }: RecentThreadsProps) {
  const [newOpen, setNewOpen] = useState(false);
  const rows = threads.slice(0, THREADS_MAX);

  if (rows.length === 0) {
    return (
      <Panel
        title="RECENT THREADS"
        headingId="home-threads-heading"
        headingLevel={2}
        meta="one-off, no workflow"
      >
        <div className="space-y-2 bg-surface p-3" data-testid="home-threads-empty">
          <p className="text-[13px] text-muted">No one-off threads yet.</p>
          <button
            type="button"
            className="ds-btn ds-btn--secondary inline-flex h-[26px] items-center rounded-[4px] px-3"
            data-testid="home-new-thread"
            onClick={() => setNewOpen(true)}
          >
            New thread
          </button>
          <NewConversationDialog open={newOpen} onClose={() => setNewOpen(false)} />
        </div>
      </Panel>
    );
  }

  return (
    <Panel
      title="RECENT THREADS"
      headingId="home-threads-heading"
      headingLevel={2}
      meta={
        <Link to={routes.threads()} className="underline" data-testid="home-all-threads">
          all threads ›
        </Link>
      }
    >
      <ul className="space-y-[5px] bg-surface p-2" data-testid="home-threads">
        {rows.map((thread) => {
          const state = stateOf(CONVERSATION_STATE[thread.status]);
          const profile = profileNames.get(thread.agent_profile_id);
          const project = projectNames.get(thread.project_id);
          return (
            <li key={thread.id}>
              <Row to={routes.thread(thread.id)} data-testid={`home-thread-${testidOf(thread.id)}`}>
                <span aria-hidden="true" className="w-3 text-center text-[11px]">
                  {STATES[state].glyph}
                </span>
                <span className="sr-only">{STATES[state].word}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-semibold" title={thread.title}>
                    {thread.title}
                  </span>
                  <span className="block truncate font-mono text-[10.5px] text-muted">
                    {project ?? thread.project_id.slice(0, 8)}
                    {profile ? ` · ${profile}` : ""}
                  </span>
                </span>
                <span className="font-mono text-[10.5px] text-faint">
                  {formatAge(thread.updated_at)}
                </span>
              </Row>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
