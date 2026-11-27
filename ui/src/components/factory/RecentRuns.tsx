/**
 * RecentRuns — the "recent runs" list under the Factory cards (redesign R4).
 *
 * The Factory has no Runs tab (CONTRACT.md "What happens to the old app": the
 * project page's runs tab went away), so a run that finished last week had no
 * address a person could reach from here. This section is that address: the
 * scope's newest runs, finished and live, each a link to its workbench
 * (`routes.run`, the same destination `components/home/RunningList` uses).
 *
 * Data: one read, and it is the read the page already made.
 * `useFactoryWorkflows(scope)` calls `useBoardRuns(scope ? { projectId: scope }
 * : {})`; this section asks for the identical filter, so react-query answers it
 * from the same cache entry — no second request and no new endpoint. The board
 * list carries every status the server can place (`api/board.ts`
 * BOARD_RUN_STATUSES), which is exactly what a "recent" list needs: the live
 * rows AND the settled ones.
 *
 * Honesty:
 * - A child run (`depth > 0`) is a step of its parent's run, not a run a person
 *   went looking for; the list keeps root runs, the rule `HappeningNow` follows.
 * - The second line is the run's own `title` (ADR-0064) or, when it was never
 *   named, ADR-0056's trigger kind. A row with neither shows the workflow alone
 *   — no invented sentence, no raw uuid.
 * - While that read is in flight or failed, the section says nothing: the page
 *   owns its spinner and its banner, and "No runs yet." is a claim about data,
 *   not about a request that has not answered.
 * - Order and age come from the same moment (`finished_at ?? created_at`), so
 *   the newest row is the row whose age reads newest.
 */
import { useState } from "react";
import { Link } from "react-router";
import { useBoardRuns } from "../../api/board";
import type { CrossProjectRunSummary } from "../../api/home";
import { formatAge } from "../../lib/format";
import { routes } from "../../lib/routes";
import { RUN_STATE, STATES, stateOf } from "../ds/states";

/** Rows before the "Show more" button; each press reveals this many more. */
export const RECENT_RUN_PAGE = 10;

export interface RecentRunsProps {
  /** A project id in a project scope, null for All projects — the same scope
   * the page's cards are read with, so the run rows and the cards agree. */
  scope: string | null;
  /** Print each run's project beside its workflow. All-projects scope only:
   * in one project every row would repeat the same name. Defaults to
   * `scope === null`. */
  showProject?: boolean;
}

/** The moment a run counts as recent: when it ended, or, if it has not, when it
 * started — `COALESCE(finished_at, created_at)`, the server's own clock for
 * "changed since". */
export function runMoment(run: CrossProjectRunSummary): string {
  return run.finished_at ?? run.created_at;
}

/**
 * The rows the section prints: the scope's root runs, newest first. A page
 * that arrived out of order is put in order here, so the list and its age
 * column can never disagree about which run is newest.
 */
export function recentRuns(runs: readonly CrossProjectRunSummary[]): CrossProjectRunSummary[] {
  return runs
    .filter((run) => run.depth === 0)
    .slice()
    .sort((a, b) => runMoment(b).localeCompare(runMoment(a)));
}

/**
 * How the run was started, in the few words a row has room for (ADR-0056's
 * kinds). An issue start names the issue the trigger carries
 * (`owner/repo#<number>`); a schedule start does not name the schedule, whose
 * ref is a uuid and a raw id is never a label. A row that carries no trigger at
 * all says nothing rather than assuming a person started it.
 */
export function runTriggerWords(run: CrossProjectRunSummary): string {
  const trigger = run.trigger;
  if (!trigger?.kind) return "";
  switch (trigger.kind) {
    case "manual":
      return "started by hand";
    case "schedule":
      return "started on a schedule";
    case "issue":
      return trigger.ref ? `started from issue ${trigger.ref}` : "started from an issue";
    case "thread":
      return "started from a chat";
    default:
      return "";
  }
}

/** The heading's classes — CONTRACT.md's section label, with the spacing this
 * section sits at under the cards. */
const HEADING_CLASS =
  "mt-[32px] mb-[8px] font-mono text-[10.5px] font-semibold uppercase tracking-[.06em] text-muted";

/** One run: workflow (· project, in All scope) · title or how it started, then
 * its state as glyph + word in the state's colour, then its age. */
function RunRow({ run, showProject }: { run: CrossProjectRunSummary; showProject: boolean }) {
  const spec = STATES[stateOf(RUN_STATE[run.status])];
  const name = run.pipeline_display_name || run.pipeline_slug;
  const detail = run.title || runTriggerWords(run);
  return (
    <Link
      to={routes.run(run.id)}
      data-testid={`recent-run-${run.id}`}
      className="grid min-h-[40px] grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-[16px] border-b border-line-soft py-[6px] no-underline focus-visible:outline-2 focus-visible:outline-accent max-md:min-h-[44px]"
    >
      <span className="flex min-w-0 items-baseline gap-x-[8px]">
        <span
          className="min-w-0 truncate text-[13.5px] font-semibold text-ink"
          title={name}
          data-testid={`recent-run-name-${run.id}`}
        >
          {name}
        </span>
        {showProject ? (
          <span
            className="max-w-[140px] shrink-0 truncate font-mono text-[11px] text-accent-text"
            title={run.project_name}
            data-testid={`recent-run-project-${run.id}`}
          >
            {run.project_name}
          </span>
        ) : null}
        {detail ? (
          <span
            className="min-w-0 truncate text-[12.5px] text-muted"
            title={detail}
            data-testid={`recent-run-detail-${run.id}`}
          >
            {detail}
          </span>
        ) : null}
      </span>
      <span
        className={`shrink-0 whitespace-nowrap text-[12.5px] ${spec.tagFg}`}
        data-testid={`recent-run-state-${run.id}`}
      >
        <span aria-hidden="true">{`${spec.glyph} `}</span>
        {spec.word}
      </span>
      <span className="shrink-0 text-right font-mono text-[11px] text-muted">
        {formatAge(runMoment(run))}
      </span>
    </Link>
  );
}

export function RecentRuns({ scope, showProject = scope === null }: RecentRunsProps) {
  const runs = useBoardRuns(scope ? { projectId: scope } : {});
  const [visible, setVisible] = useState(RECENT_RUN_PAGE);
  const rows = recentRuns(runs.data?.runs ?? []);

  if (rows.length === 0) {
    // Loading or broken, the section has nothing to say — the page reports
    // both. Only a read that answered with nothing earns the empty sentence.
    if (runs.isPending || runs.isError) return null;
    return (
      <section data-testid="recent-runs" aria-label="Recent runs">
        <h3 className={HEADING_CLASS} data-testid="recent-runs-heading">
          Recent runs
        </h3>
        <p className="m-0 text-[13px] text-muted" data-testid="recent-runs-empty">
          No runs yet.
        </p>
      </section>
    );
  }

  const shown = rows.slice(0, visible);
  return (
    <section data-testid="recent-runs" aria-label="Recent runs">
      <h3 className={HEADING_CLASS} data-testid="recent-runs-heading">
        Recent runs
      </h3>
      <div data-testid="recent-run-rows">
        {shown.map((run) => (
          <RunRow key={run.id} run={run} showProject={showProject} />
        ))}
      </div>
      {rows.length > shown.length ? (
        <button
          type="button"
          data-testid="recent-runs-more"
          onClick={() => setVisible((count) => count + RECENT_RUN_PAGE)}
          className="ds-btn ds-btn--ghost ds-btn--compact mt-[8px]"
        >
          Show more
        </button>
      ) : null}
    </section>
  );
}

export default RecentRuns;
