/**
 * HAPPENING NOW on the project home (redesign R2, README §2): the three cards
 * that say what this project is doing at this second — the runs of its
 * workflows and the chats whose agent is still answering.
 *
 * Two reads, both already mounted by the project screens this page replaces:
 * `useBoardRuns({ projectId })` (the only run list that embeds the pinned
 * revision's steps, so the "on implement" line is the run's own step, never a
 * guess) and `useConversations(projectId)` (whose `has_active_turn` is the
 * wire's word for an open turn, and whose `last_agent_line` is the agent's own
 * last line, trimmed by the server).
 *
 * Honesty: a run card shows the run's own title when the wire carries one and
 * the workflow's display name when it does not (ADR-0064); a chat card shows
 * the agent's last line only when the wire served one — a thread whose agent
 * has not spoken has no last line, and the card says nothing rather than
 * something invented. Empty is one sentence, never an empty grid.
 */
import { Link } from "react-router";
import { useBoardRuns } from "../../api/board";
import { useConversations } from "../../api/queries";
import type { CrossProjectRun } from "../board/columns";
import { currentStep } from "../board/columns";
import { previewLine } from "../../lib/preview";
import { shortId } from "../../lib/format";
import { routes } from "../../lib/routes";
import { SectionLabel } from "./SectionLabel";

/** The card ceiling of one glance: three, in a row (README §2). */
export const HAPPENING_NOW_MAX = 3;

/** The run states that read as "happening": claimed or moving, not sitting on
 * a person and not finished. */
export const HAPPENING_NOW_RUN_STATES: readonly string[] = ["queued", "preparing", "running"];

/** A conversation is "happening" while its agent has an open turn. */
export function hasOpenTurn(thread: { has_active_turn?: boolean }): boolean {
  return thread.has_active_turn === true;
}

/** The run card's step line: the pinned revision's own current step, else
 * nothing — a run whose plan snapshot did not decode has no step to name. */
export function happeningRunStep(run: CrossProjectRun): string | null {
  const step = currentStep(run.steps);
  return step ? `on ${step.node_id}` : null;
}

export interface HappeningNowProps {
  projectId: string;
}

export function HappeningNow({ projectId }: HappeningNowProps) {
  const runs = useBoardRuns({ projectId });
  const threads = useConversations(projectId);

  // One row of at most three cards, runs first: a glance at the floor leads
  // with the work a workflow is doing, then the chats whose agent is talking.
  const liveRuns = (runs.data?.runs ?? [])
    .filter((run) => run.depth === 0 && HAPPENING_NOW_RUN_STATES.includes(run.status))
    .slice(0, HAPPENING_NOW_MAX);
  const openThreads = (threads.data?.items ?? [])
    .filter((thread) => thread.status !== "archived" && hasOpenTurn(thread))
    .slice(0, Math.max(HAPPENING_NOW_MAX - liveRuns.length, 0));
  const cards = liveRuns.length + openThreads.length;

  return (
    <section className="min-w-0" aria-label="Happening now" data-testid="happening-now">
      <SectionLabel testid="happening-now-label" glyph="●" tone="running">
        Happening now
      </SectionLabel>
      {cards === 0 ? (
        <p className="m-0 text-[13.5px] text-muted" data-testid="happening-now-empty">
          {runs.isPending || threads.isPending
            ? "Reading what this project is doing."
            : "Nothing is happening right now."}
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-[12px] min-[900px]:grid-cols-3">
          {liveRuns.map((run) => (
            <Link
              key={run.id}
              to={routes.run(run.id)}
              className="flex min-w-0 flex-col gap-[6px] rounded-[10px] border border-st-running-pale-edge bg-st-running-pale-body px-[14px] py-[12px] hover:border-st-running-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              data-testid={`happening-run-${shortId(run.id)}`}
            >
              <span className="font-mono text-[11px] text-st-running-tag-fg">
                <span aria-hidden="true">● </span>running
              </span>
              <span className="min-w-0 truncate text-[13.5px] font-semibold text-ink">
                {run.title ?? run.pipeline_display_name}
              </span>
              <span className="min-w-0 truncate text-[12.5px] text-muted">
                {happeningRunStep(run) ?? `#${shortId(run.id)}`}
              </span>
            </Link>
          ))}
          {openThreads.map((thread) => (
            <Link
              key={thread.id}
              to={routes.chat(thread.id, projectId)}
              className="flex min-w-0 flex-col gap-[6px] rounded-[10px] border border-line bg-surface px-[14px] py-[12px] hover:border-line-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              data-testid={`happening-chat-${shortId(thread.id)}`}
            >
              <span className="font-mono text-[11px] text-muted">
                <span aria-hidden="true">● </span>chat
              </span>
              <span className="min-w-0 truncate text-[13.5px] font-semibold text-ink">
                {thread.title}
              </span>
              {previewLine(thread.last_agent_line) ? (
                <span className="min-w-0 truncate text-[12.5px] text-muted">
                  {previewLine(thread.last_agent_line)}
                </span>
              ) : null}
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}

export default HappeningNow;
