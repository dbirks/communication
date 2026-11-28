/**
 * WORKFLOWS HERE on the project home (redesign R2, README §2): one line per
 * workflow this project has assigned — its name, then in plain English what
 * starts it ("fix-issue *when an issue gets 'ready'*"). The reviewer liked this
 * wording, so it is the SAME sentence the Factory index prints:
 * `triggerSentence` from `../factory/factoryData`, fed the same facts the old
 * project panel read (the project's assignments, its schedules, its issue
 * triggers). A second parser would eventually disagree.
 *
 * Honesty:
 * - A row prints its sentence only once BOTH trigger reads have answered, and a
 *   failed one says `triggers unavailable` rather than claiming the workflow is
 *   started by hand (the panel's own rule).
 * - A disabled schedule or issue trigger is not a trigger: only enabled ones
 *   reach the sentence, exactly as in the Factory's row facts.
 * - The workflow's name comes from the library read; a pin whose pipeline the
 *   library no longer names prints its short id, never a guessed display name.
 */
import { Link } from "react-router";
import { useAssignments, usePipelines, useSchedules } from "../../api/pipelines";
import { useIssueTriggers } from "../../api/useIssueTriggers";
import { shortId } from "../../lib/format";
import { routes } from "../../lib/routes";
import { triggerSentence } from "../factory/factoryData";
import { ColumnHeading } from "./SectionLabel";

export interface WorkflowsHereProps {
  projectId: string;
}

export function WorkflowsHere({ projectId }: WorkflowsHereProps) {
  const assignments = useAssignments(projectId);
  const pipelines = usePipelines();
  const schedules = useSchedules(projectId);
  const issueTriggers = useIssueTriggers(projectId);

  const pins = assignments.data?.assignments ?? [];
  const library = new Map(
    (pipelines.data?.pipelines ?? []).map((pipeline) => [pipeline.id, pipeline] as const),
  );
  const triggerReadFailed = schedules.error !== null || issueTriggers.error !== null;
  const triggersSettled = !schedules.isPending && !issueTriggers.isPending;

  return (
    <section className="min-w-0" aria-label="Workflows here" data-testid="workflows-here">
      <ColumnHeading testid="workflows-here-label">Workflows here</ColumnHeading>
      {pins.length === 0 ? (
        <p className="m-0 text-[13.5px] text-muted" data-testid="workflows-here-empty">
          {assignments.isPending ? "Reading this project's workflows." : "No workflows here yet."}
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-[9px] p-0">
          {pins.map((pin) => {
            const pipeline = library.get(pin.pipeline_id);
            const name =
              pipeline?.display_name ?? pipeline?.slug ?? `workflow ${shortId(pin.pipeline_id)}`;
            const enabledCrons = (schedules.data?.schedules ?? [])
              .filter((schedule) => schedule.assignment_id === pin.id && schedule.enabled)
              .map((schedule) => schedule.cron_expr);
            const enabledTriggers = (issueTriggers.data?.issue_triggers ?? []).filter(
              (trigger) => trigger.assignment_id === pin.id && trigger.enabled,
            );
            const sentence = triggerSentence(enabledCrons, enabledTriggers);
            return (
              <li
                key={pin.id}
                className="text-[13.5px] leading-[20px]"
                data-testid={`workflow-here-${shortId(pin.pipeline_id)}`}
              >
                <Link
                  to={routes.factoryWorkflow(pin.pipeline_id, projectId)}
                  className="font-semibold text-ink hover:text-accent-text focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
                >
                  {name}
                </Link>{" "}
                {triggerReadFailed ? (
                  <span data-trigger className="not-italic text-muted">
                    triggers unavailable
                  </span>
                ) : !triggersSettled ? (
                  <span data-trigger className="not-italic text-muted">
                    reading its triggers…
                  </span>
                ) : (
                  <span data-trigger className="not-italic text-muted">
                    {sentence.text}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {pins.length === 0 && !assignments.isPending ? (
        <Link
          to={routes.factory(projectId)}
          className="mt-[8px] inline-block text-[13px] text-accent-text hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
          data-testid="workflows-here-factory"
        >
          Open the Factory
        </Link>
      ) : null}
    </section>
  );
}

export default WorkflowsHere;
