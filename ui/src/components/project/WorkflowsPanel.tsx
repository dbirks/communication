/**
 * WORKFLOWS (Projects Review design 1b): the workflows this project *uses*.
 *
 * The mental model the handoff settles (ADR-0060): a library workflow is a
 * template that never runs by itself; a project use is an assignment pinned to a
 * revision, and the triggers belong to that use. So this panel lists the
 * project's assignments — the pinned revision's number, what starts it, which
 * repository it runs in — and `Edit` goes to the workflow page.
 *
 * `+ assign` goes to the project's Workflows tab, which already owns the
 * assign/replace-pin form (`pages/ProjectRunsPipelines.tsx`); this page does not
 * grow a second copy of a write form.
 *
 * Honesty rules:
 * - A row prints nothing before its own reads have arrived: the `r{n}` chip
 *   waits for the pinned revision read, the trigger clause waits for BOTH
 *   trigger lists, and a failed trigger read says `triggers unavailable` rather
 *   than claiming the workflow is started by hand.
 * - A project-wide pin (null `repository_id`) is printed as `whole project`,
 *   which is what it means; a pinned revision that no longer resolves prints
 *   its short digest, never a guessed revision number.
 */
import { useMemo } from "react";
import { Link } from "react-router";
import { useQueries } from "@tanstack/react-query";
import {
  useSchedules,
  useAssignments,
  revisionQueryOptions,
  usePipelines,
} from "../../api/pipelines";
import { useIssueTriggers } from "../../api/useIssueTriggers";
import type { Project } from "../../api/types";
import { Panel } from "../ds/Panel";
import { StatusChip } from "../ds/Row";
import { ProblemBanner, Spinner } from "../Feedback";
import { cronInWords } from "../../lib/cronText";
import { shortDigest } from "../../lib/pipeline/yamlPointer";
import { routes } from "../../lib/routes";
import { testidOf } from "../../lib/format";

export interface WorkflowsPanelProps {
  project: Project;
}

/** What starts one use of a workflow, in the few words that fit a mono line.
 * The trigger vocabulary is ADR-0032 (schedules) and ADR-0056 (issue triggers);
 * anything else the server may learn to start a run with is not guessed at. */
export function triggerWords(
  schedules: { cron_expr: string }[],
  issueTriggers: { event: string; labels: string[] }[],
): string {
  const parts: string[] = [];
  for (const trigger of issueTriggers) {
    parts.push(
      trigger.event === "opened"
        ? "on issue opened"
        : `on issue labelled ${trigger.labels.length > 0 ? trigger.labels.map((l) => `“${l}”`).join(" / ") : "— any"}`,
    );
  }
  for (const schedule of schedules) {
    const words = cronInWords(schedule.cron_expr);
    parts.push(words === schedule.cron_expr.trim() ? `cron ${schedule.cron_expr}` : words);
  }
  return parts.length > 0 ? parts.join(" · ") : "started by hand";
}

export function WorkflowsPanel({ project }: WorkflowsPanelProps) {
  const assignments = useAssignments(project.id);
  const pipelines = usePipelines();
  const schedules = useSchedules(project.id);
  const issueTriggers = useIssueTriggers(project.id);

  const pins = assignments.data?.assignments ?? [];
  // The pinned revision's number is not on the assignment row (it carries the
  // digest and an optional label), so each row reads its own revision — the
  // same fan the repository page does, keyed identically so the cache is shared.
  const revisionFan = useQueries({
    queries: pins.map((pin) => revisionQueryOptions(pin.pinned_revision_digest)),
  });
  const slugs = useMemo(
    () =>
      new Map(
        (pipelines.data?.pipelines ?? []).map((pipeline) => [
          pipeline.id,
          { slug: pipeline.slug, name: pipeline.display_name },
        ]),
      ),
    [pipelines.data],
  );

  const triggersReady = !schedules.isPending && !issueTriggers.isPending;
  const triggersFailed = schedules.isError || issueTriggers.isError;

  return (
    <Panel
      id="project-workflows"
      title={assignments.data ? `WORKFLOWS · ${pins.length}` : "WORKFLOWS"}
      headingId="project-workflows-heading"
      headingLevel={2}
      meta={
        project.my_role === "maintainer" ? (
          <Link
            to={routes.projectTab(project.id, "pipelines")}
            className="font-mono text-[10.5px] normal-case text-accent-text hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
            data-testid="project-workflows-assign"
          >
            + assign
          </Link>
        ) : undefined
      }
    >
      <div className="bg-surface">
        {assignments.isPending ? (
          <div className="p-[10px]">
            <Spinner label="Loading workflows" />
          </div>
        ) : null}
        {assignments.isError ? (
          <div className="p-[10px]">
            <ProblemBanner
              error={assignments.error}
              fallback="The project's workflow assignments could not be read."
            />
          </div>
        ) : null}
        {assignments.data && pins.length === 0 ? (
          <div className="space-y-[4px] p-[10px]">
            <p className="text-[12.5px] text-muted" data-testid="project-workflows-empty">
              No workflows are used in this project yet.
            </p>
            <p className="text-[12.5px] text-muted">
              <Link to={routes.projectTab(project.id, "pipelines")} className="underline">
                Assign one from the library ›
              </Link>
            </p>
          </div>
        ) : null}
        <ul className="divide-y divide-line-soft" data-testid="project-workflows">
          {pins.map((pin, index) => {
            const key = testidOf(pin.id);
            const workflow = slugs.get(pin.pipeline_id);
            const revision = revisionFan[index]?.data;
            const pinSchedules = (schedules.data?.schedules ?? []).filter(
              (schedule) => schedule.assignment_id === pin.id,
            );
            const pinIssueTriggers = (issueTriggers.data?.issue_triggers ?? []).filter(
              (trigger) => trigger.assignment_id === pin.id,
            );
            const where = pin.repository_name ?? "whole project";
            const revisionWords = revision
              ? `r${revision.revision_number}`
              : revisionFan[index]?.isError
                ? `@${shortDigest(pin.pinned_revision_digest)}`
                : "· reading";
            return (
              <li
                key={pin.id}
                className="flex items-center gap-[8px] px-[12px] py-[8px]"
                data-testid={`project-workflow-row-${key}`}
              >
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-[6px]">
                    <Link
                      to={routes.workflow(pin.pipeline_id)}
                      className="truncate text-[12.5px] font-semibold text-ink hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
                      title={workflow?.name}
                      data-testid={`project-workflow-name-${key}`}
                    >
                      {workflow?.slug ?? "· reading"}
                    </Link>
                    {pin.enabled ? null : (
                      <StatusChip
                        state="interrupted"
                        label="paused"
                        className="h-[15px]"
                        labelProps={{ "data-testid": `project-workflow-enabled-${key}` }}
                      />
                    )}
                  </span>
                  <span
                    className="block truncate font-mono text-[10.5px] text-muted"
                    data-testid={`project-workflow-meta-${key}`}
                  >
                    {revisionWords} ·{" "}
                    {triggersFailed
                      ? "triggers unavailable"
                      : triggersReady
                        ? triggerWords(pinSchedules, pinIssueTriggers)
                        : "· reading"}{" "}
                    · {where}
                  </span>
                </span>
                <Link
                  to={routes.workflow(pin.pipeline_id)}
                  className="shrink-0 text-[12px] font-semibold text-accent-text hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
                  data-testid={`project-workflow-edit-${key}`}
                >
                  Edit
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </Panel>
  );
}
