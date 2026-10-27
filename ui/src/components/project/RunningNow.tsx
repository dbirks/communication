/**
 * RUNNING NOW (Projects Review design 1b): the runs of THIS project that are
 * queued, running or paused, one 44px row each, over a one-line footer of what
 * finished today.
 *
 * Data is `useBoardRuns({ projectId })` — `GET /api/v1/runs?project_id=…`, the
 * board's and Home's own read (ADR-0047), which is the only run list the app
 * calls that embeds each run's pinned-revision steps. That embedding is what
 * the segmented bar needs; the project-scoped `GET /projects/{id}/runs` carries
 * no steps at all, and inventing a progress bar from the run's status alone is
 * not on the table. A server build that predates that read says so (the
 * `notAvailable` line) rather than showing an empty panel.
 *
 * The read is the newest 200 runs (the board's own bound): a project with more
 * than 200 runs since midnight would undercount the footer — the same limit the
 * board itself lives with, and the reason the panel says "all runs ›" rather
 * than pretending to be the whole list.
 *
 * Honesty rules, same as Home's section and `pages/ProjectRuns.tsx`: the wire
 * carries each run's own `title` and repository since ADR-0064 — a row shows
 * the design's "Add saved cards to checkout" when the run has it, and falls
 * back to the workflow's display name and short id (plus the workspace-derived
 * repository segment, `useProjectRepoIndex`) when it does not, which is the
 * honest answer for a run nobody named or a server build predating the field;
 * and the bar is one segment per step of the pinned revision, never per
 * execution (a loop collapses into its step, ADR-0047 § 4). Status is glyph +
 * word always (rule 06).
 */
import { Link } from "react-router";
import { problemOf } from "../../api/client";
import { useBoardRuns } from "../../api/board";
import type { Project } from "../../api/types";
import { Panel } from "../ds/Panel";
import { StatusChip } from "../ds/Row";
import { RUN_STATE, SHORT_WORD, stateOf } from "../ds/states";
import { ProblemBanner, Spinner } from "../Feedback";
import {
  currentStep,
  isDoneToday,
  localMidnight,
  progressAriaLabel,
  STEP_SEGMENT_CLASS,
  type CrossProjectRun,
  type CrossProjectRunStep,
} from "../board/columns";
import { formatAge, shortId, testidOf } from "../../lib/format";
import { routes } from "../../lib/routes";
import { repoSegment, useProjectRepoIndex, type ProjectRepoIndex } from "./useProjectRepoIndex";

/** The states the section lists: work that has not finished and is not sitting
 * on a decision (a `waiting_human` run is a callout, not a progress row). */
export const RUNNING_NOW_STATES: readonly string[] = ["queued", "preparing", "running", "paused"];

/** `preparing` is the run's own word for "claimed, workspace coming up"; the
 * chip spells it as the queue state it reads as. */
function chipWord(run: CrossProjectRun): string {
  if (run.status === "preparing") return "running";
  if (run.status === "queued") return "queued";
  return SHORT_WORD[stateOf(RUN_STATE[run.status])];
}

export interface RunningNowProps {
  project: Project;
  /** Rows rendered before the "all runs" link takes the rest. */
  limit?: number;
}

export function RunningNow({ project, limit = 6 }: RunningNowProps) {
  // Run → repository, from the project's workspace read: the only read that
  // connects a run to a repository at all.
  const repos = useProjectRepoIndex(project.id);
  const runs = useBoardRuns({ projectId: project.id });
  const rows = (runs.data?.runs ?? []).filter(
    (run) => run.depth === 0 && RUNNING_NOW_STATES.includes(run.status),
  );
  const settled = runs.data !== undefined;
  const notFound = problemOf(runs.error).status === 404;

  const now = new Date();
  const finished = runs.data?.runs.filter((run) => isDoneToday(run, now)) ?? [];
  const cancelled =
    runs.data?.runs.filter(
      (run) =>
        run.status === "cancelled" &&
        new Date(run.finished_at ?? run.created_at).getTime() >= localMidnight(now).getTime(),
    ) ?? [];

  return (
    <Panel
      id="running-now"
      title={settled ? `RUNNING NOW · ${rows.length}` : "RUNNING NOW"}
      headingId="running-now-heading"
      headingLevel={2}
      meta={
        <Link
          to={routes.projectTab(project.id, "runs")}
          className="font-mono text-[10.5px] normal-case"
          data-testid="recent-runs-all"
        >
          all runs ›
        </Link>
      }
    >
      <div className="space-y-[6px] bg-surface">
        {runs.isPending ? (
          <div className="p-[10px]">
            <Spinner label="Loading runs" />
          </div>
        ) : null}
        {runs.isError && !notFound ? (
          <div className="p-[10px]">
            <ProblemBanner error={runs.error} fallback="Runs could not be loaded." />
          </div>
        ) : null}
        {notFound ? (
          <p
            className="p-[10px] font-mono text-[11px] text-muted"
            data-testid="running-now-unavailable"
          >
            · step progress is not available — this server build predates the cross-project run read
            this panel reads.{" "}
            <Link to={routes.projectTab(project.id, "runs")} className="underline">
              all runs ›
            </Link>
          </p>
        ) : null}
        {/* Two different nothings, each with its own line: a project that has
            never run at all, and one whose runs have all finished. */}
        {settled && rows.length === 0 && runs.data.runs.length === 0 ? (
          <p className="p-[10px] text-[12.5px] text-muted" data-testid="recent-runs-empty">
            No runs yet — this project has never started a workflow.
          </p>
        ) : null}
        {settled && rows.length === 0 && runs.data.runs.length > 0 ? (
          <p className="p-[10px] text-[12.5px] text-muted" data-testid="running-now-empty">
            Nothing is queued or running.
          </p>
        ) : null}
        {/* `recent-run-*` stays the id of a project's run row: the panel this
          project page showed (RECENT RUNS) narrowed to the runs that are
          running now, and the tests that pinned those rows pin this list. */}
        <ul className="divide-y divide-line-soft" data-testid="running-now-list">
          {rows.slice(0, limit).map((run) => (
            <RunRow key={run.id} run={run} repos={repos} />
          ))}
        </ul>
        {rows.length > limit ? (
          <p className="px-[12px] pb-[8px] font-mono text-[10.5px] text-faint">
            {`${rows.length - limit} more — `}
            <Link to={routes.projectTab(project.id, "runs")} className="underline">
              all runs ›
            </Link>
          </p>
        ) : null}
        {/* A footer of two zeros is noise, not information: it appears when the
            day has actually produced something. */}
        {settled && finished.length + cancelled.length > 0 ? (
          <p className="border-t border-line-soft px-[12px] py-[8px] font-mono text-[10.5px] text-muted">
            <span aria-hidden="true">✓ </span>
            <span data-testid="running-now-finished-today">
              {finished.length} finished today · {cancelled.length} cancelled
            </span>
          </p>
        ) : null}
      </div>
    </Panel>
  );
}

/** One run: chip · display name over `slug · #id · on <step>` · segments ·
 * age. The four columns stack into two rows below `sm` so 390px never scrolls
 * sideways. */
function RunRow({ run, repos }: { run: CrossProjectRun; repos: ProjectRepoIndex }) {
  const key = testidOf(run.id);
  const step = currentStep(run.steps);
  return (
    <li>
      <Link
        to={routes.run(run.id)}
        className="flex flex-wrap items-center gap-x-[12px] gap-y-[4px] px-[12px] py-[8px] hover:bg-accent-wash focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent sm:grid sm:grid-cols-[92px_minmax(0,1fr)_120px_40px] sm:py-0 sm:min-h-[44px]"
        data-testid={`recent-run-${key}`}
      >
        <StatusChip
          state={stateOf(RUN_STATE[run.status])}
          label={chipWord(run)}
          labelProps={{ "data-testid": `recent-run-status-${key}`, role: "status" }}
        />
        <span className="min-w-0 flex-1">
          <span
            className="block truncate text-[12.5px] font-semibold"
            title={run.title ?? run.pipeline_display_name}
          >
            {run.title ?? run.pipeline_display_name}
          </span>
          <StepLine run={run} step={step} repo={repoSegment(repos.reposForRun(run.id))} />
        </span>
        <StepSegments steps={run.steps} runKey={key} />
        <span className="ml-auto font-mono text-[10.5px] text-faint sm:ml-0 sm:text-right">
          {formatAge(run.created_at)}
        </span>
      </Link>
    </li>
  );
}

/** The mono line: slug, the run's own short id and the step it is on. The
 * title and repository are the run's own (ADR-0064) when the server carries
 * them and are never guessed when it does not. */
function StepLine({
  run,
  step,
  repo,
}: {
  run: CrossProjectRun;
  step: CrossProjectRunStep | undefined;
  repo: string | null;
}) {
  const parts = [run.pipeline_slug];
  // The design's middle segment: the run's own repository first (ADR-0064);
  // else the only other honest answer — a workspace that holds this run's
  // checkout; else nothing, which is what a queued unnamed run really has.
  const repoName = run.repository_name ?? repo;
  if (repoName) parts.push(repoName);
  parts.push(`#${shortId(run.id)}`);
  if (step) parts.push(`on ${step.node_id}`);
  else if (run.steps.length === 0) parts.push("steps unreadable");
  return (
    <span className="block truncate font-mono text-[10.5px] text-muted">{parts.join(" · ")}</span>
  );
}

/** Seven-pixel segments, one per pinned-revision step, in definition order.
 * The bar is an image to assistive tech with the counts spelled out in its
 * label — color never carries the state alone (rule 06). */
function StepSegments({ steps, runKey }: { steps: CrossProjectRunStep[]; runKey: string }) {
  if (steps.length === 0) {
    return (
      <span
        className="font-mono text-[10.5px] text-faint"
        data-testid={`running-now-progress-${runKey}`}
      >
        —
      </span>
    );
  }
  return (
    <span
      role="img"
      aria-label={progressAriaLabel(steps)}
      className="flex h-[7px] w-full gap-[2px] overflow-hidden rounded-[1px] border border-line bg-surface"
      data-testid={`running-now-progress-${runKey}`}
    >
      {steps.map((step) => (
        <span
          key={step.node_id}
          className={`h-full flex-1 rounded-[1px] ${STEP_SEGMENT_CLASS[step.state]}`}
        />
      ))}
    </span>
  );
}
