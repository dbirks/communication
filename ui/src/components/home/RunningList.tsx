/**
 * RunningList — the redesigned Home's "RUNNING" block (handoff README §2):
 * the runs actually in flight across the reader's projects, from the one
 * board read Home already holds (`useBoardRuns`, filtered to `running` —
 * the narrower filter the section's own word promises; the queued, waiting
 * and failed rows are counted by FACTORY HEALTH instead).
 *
 * One row per run: "● " + the workflow's name 13.5/600 in the running tag
 * colour (#0f5e96), then project · current step · age, 12px muted, linking
 * to the run's workbench (`routes.run`) — the same destination
 * `components/home/RunningNow.tsx` links to.
 */
import { Link } from "react-router";
import { SectionLabel } from "./SectionLabel";
import type { CrossProjectRunSummary, CrossProjectRunStep } from "../../api/home";
import { formatAge } from "../../lib/format";
import { routes } from "../../lib/routes";

export interface RunningListProps {
  /** The board's run rows (the page's own `useBoardRuns` read). */
  runs: CrossProjectRunSummary[];
}

/** The current step's node id: the first step that is not done, as
 * `RunningNow` computes it ("—" when the plan decodes to nothing). */
export function currentStepLabel(steps: CrossProjectRunStep[]): string {
  const done = (step: CrossProjectRunStep) =>
    step.state === "succeeded" || step.state === "skipped";
  const current = steps.find((step) => !done(step));
  return current ? current.node_id : "—";
}

export function RunningList({ runs }: RunningListProps) {
  const running = runs.filter((run) => run.status === "running");
  return (
    <section data-testid="running-list">
      <SectionLabel>Running</SectionLabel>
      {running.length === 0 ? (
        <p data-testid="running-list-empty" className="text-[13.5px] text-muted">
          Nothing is running.
        </p>
      ) : (
        <div className="flex flex-col gap-[8px]" data-testid="running-list-rows">
          {running.map((run) => (
            <Link
              key={run.id}
              to={routes.run(run.id)}
              data-testid={`running-row-${run.id}`}
              className="block focus-visible:outline-2 focus-visible:outline-accent"
            >
              <span
                className="block text-[13.5px] font-semibold text-st-running-tag-fg"
                title={run.title ?? run.pipeline_display_name}
              >
                ● {run.title ?? run.pipeline_display_name}
              </span>
              <span className="block truncate text-[12px] text-muted">
                {[run.project_name, currentStepLabel(run.steps), formatAge(run.created_at)]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}

export default RunningList;
