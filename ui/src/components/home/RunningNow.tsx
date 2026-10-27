/**
 * The briefing's "running now" section (artboard 2a): the caller's active
 * runs across every project they belong to, one 38px row each.
 *
 * Honesty rules are `pages/ProjectRuns.tsx`'s: the wire carries each run's
 * own `title` since ADR-0064, so a row names its run by that title and falls
 * back — for a run nobody named or a server that predates the field — to the
 * workflow's display name (the cross-project list embeds it, ADR-0047) and
 * its short id; nothing is invented. The segmented bar is one 7px segment per
 * step of the pinned revision (never per execution: a loop collapses into its
 * step, ADR-0047 §4), and the state always carries its glyph and its word.
 */
import { Link } from "react-router";
import { Panel } from "../ds/Panel";
import { StatusChip } from "../ds/Row";
import { RUN_STATE, SEGMENT_COLOR } from "../ds/states";
import type { CrossProjectRunStep, CrossProjectRunSummary } from "../../api/home";
import { formatAge, shortId, testidOf } from "../../lib/format";
import { routes } from "../../lib/routes";

/** A step's seven wire states onto the segment palette (`states.ts`).
 * `skipped` reads as done (neutral, complete); `cancelled` as interrupted —
 * a stop, never a failure. */
const STEP_SEGMENT: Record<CrossProjectRunStep["state"], keyof typeof SEGMENT_COLOR> = {
  succeeded: "done",
  skipped: "done",
  running: "running",
  waiting: "waiting",
  failed: "failed",
  cancelled: "interrupted",
  pending: "open",
};

/** The run status word a chip can carry: the run-level spelling of the
 * state set (a `preparing` run is queued work, a `cancelled` one stopped). */
const RUN_CHIP_LABEL: Record<string, string> = {
  queued: "queued",
  preparing: "queued",
  running: "running",
  waiting_human: "need you",
  paused: "need you",
  failed: "failed",
  cancelled: "stopped",
  interrupted: "stopped",
};

export interface RunningNowProps {
  runs: CrossProjectRunSummary[];
  /** Rows rendered; the newest active ones, already sliced by the caller. */
  limit?: number;
}

export function RunningNow({ runs, limit = 8 }: RunningNowProps) {
  const rows = runs.slice(0, limit);
  return (
    <Panel
      title="RUNNING NOW"
      headingId="home-running-heading"
      headingLevel={2}
      meta={
        <Link to={routes.board()} data-testid="home-open-board" className="underline">
          open board ›
        </Link>
      }
    >
      <ul className="space-y-[6px] bg-surface p-2">
        {rows.map((run) => (
          <RunRow key={run.id} run={run} />
        ))}
      </ul>
    </Panel>
  );
}

function RunRow({ run }: { run: CrossProjectRunSummary }) {
  const state = RUN_STATE[run.status] ?? "queued";
  const steps = run.steps;
  const isDone = (step: CrossProjectRunStep) =>
    step.state === "succeeded" || step.state === "skipped";
  const current = steps.find((step) => !isDone(step));
  const currentLabel =
    current === undefined
      ? steps.length > 0
        ? "done"
        : "—"
      : `${current.node_id} · ${steps.indexOf(current) + 1}/${steps.length}`;

  return (
    <li>
      <Link
        to={routes.run(run.id)}
        data-testid={`home-run-${testidOf(run.id)}`}
        className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[3px] border border-line px-3 py-[5px] hover:border-line-strong sm:grid sm:h-[38px] sm:grid-cols-[92px_minmax(0,1fr)_120px_110px_36px] sm:py-0"
      >
        <StatusChip state={state} label={RUN_CHIP_LABEL[run.status] ?? run.status} />
        <span className="min-w-[160px] flex-1">
          <span
            className="block truncate text-[13px] font-semibold"
            title={run.title ?? run.pipeline_display_name}
          >
            {run.title ?? run.pipeline_display_name}
          </span>
          <span className="block truncate font-mono text-[10.5px] text-muted">
            {run.pipeline_slug} #{shortId(run.id)} · {run.project_name}
          </span>
        </span>
        <span className="w-full sm:w-[120px]">
          <StepSegments steps={steps} runId={run.id} />
        </span>
        <span
          className="hidden font-mono text-[10.5px] text-muted sm:block sm:w-[110px] truncate"
          data-testid={`home-run-step-${testidOf(run.id)}`}
        >
          {currentLabel}
        </span>
        <span className="ml-auto font-mono text-[10.5px] text-faint sm:ml-0 sm:w-[36px] sm:text-right">
          {formatAge(run.created_at)}
        </span>
      </Link>
    </li>
  );
}

/** "2 of 8 steps done, 1 waiting" — the counts a segment color can never
 * say on its own (waiting before running: the gate holds the step, the
 * running one is inside it). */
function progressLabel(steps: readonly CrossProjectRunStep[]): string {
  const count = (states: readonly CrossProjectRunStep["state"][]) =>
    steps.filter((step) => states.includes(step.state)).length;
  const done = count(["succeeded", "skipped"]);
  let label = `${done} of ${steps.length} steps done`;
  const waiting = count(["waiting"]);
  if (waiting > 0) label += `, ${waiting} waiting`;
  const running = count(["running"]);
  if (running > 0) label += `, ${running} running`;
  const failed = count(["failed"]);
  if (failed > 0) label += `, ${failed} failed`;
  return label;
}

/** One 7px segment per step of the pinned revision (definition order):
 * equal-width segments filling the 120px column with a 2px gap between
 * them (the gap is each segment's transparent 1px edges, so the bar's
 * border line is what a pending white segment keeps its outline by). */
function StepSegments({ steps, runId }: { steps: CrossProjectRunStep[]; runId: string }) {
  if (steps.length === 0) {
    return (
      <span
        className="font-mono text-[10.5px] text-faint"
        data-testid={`home-run-progress-${testidOf(runId)}`}
      >
        —
      </span>
    );
  }
  return (
    <span
      role="img"
      aria-label={progressLabel(steps)}
      className="flex h-[7px] w-full overflow-hidden rounded-[2px] border border-line"
      data-testid={`home-run-progress-${testidOf(runId)}`}
    >
      {steps.map((step, index) => (
        <span
          key={index}
          className={`${SEGMENT_COLOR[STEP_SEGMENT[step.state]]} h-full border-x border-transparent`}
          style={{ flexGrow: 1, flexBasis: 0 }}
        />
      ))}
    </span>
  );
}
