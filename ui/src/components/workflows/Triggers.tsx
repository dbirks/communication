/**
 * The "Triggers" section of a workflow page (`/workflows/:pipelineId`) — the
 * product owner's "add as a trigger to this whole workflow … a certain time, cron"
 * plus the ADR-0056 part-2 "when an issue shows up" half: a schedule fires on a
 * cron, an issue trigger fires on a GitHub issue.
 *
 * A schedule belongs to a project ASSIGNMENT (ADR-0032), not to a pipeline
 * directly, so the section reads the same per-project fan-out the workflows
 * index rows already share — one assignments read per project the caller
 * belongs to, then the schedules of every project that pins this pipeline —
 * and groups the rows by project. Adding, pausing and editing go through the
 * ADR-0032 routes; the server stays the authority for the cron grammar and the
 * fixed run inputs, and its `422 invalid_cron` / `409 …` answers surface inline
 * rather than being dressed up as a saved state.
 *
 * An issue trigger answers the same assignment question through the
 * ADR-0056 part-2 routes (`GET/POST /projects/{id}/issue-triggers`,
 * `PATCH /issue-triggers/{id}`): one intent per (assignment, repository),
 * `opened` vs `labeled` with an any-of label set, polled every 60 s.
 */
import { useState } from "react";
import { Link } from "react-router";
import { useQueries } from "@tanstack/react-query";
import { Alert } from "../ds/Alert";
import { Button } from "../ds/Button";
import { StatusChip } from "../ds/Row";
import { ProblemBanner, Spinner } from "../Feedback";
import { apiFetch, ApiError, problemOf } from "../../api/client";
import { queryKeys, useProjects } from "../../api/queries";
import { usePatchSchedule, schedulesQueryOptions, type Schedule } from "../../api/pipelines";
import type {
  Assignment,
  AssignmentList,
  Project,
  Repository,
  RepositoryList,
} from "../../api/types";
import { cronInWords } from "../../lib/cronText";
import { formatClock, formatRemaining } from "../../lib/format";
import { routes } from "../../lib/routes";
import { shortId } from "../../api/names";
import { IssueTriggerRow } from "./IssueTriggerRow";
import { TriggersDialog } from "./TriggersDialog";
import { IssueTriggerDialog } from "./IssueTriggerDialog";
import type { IssueTrigger, IssueTriggerList } from "../../api/useIssueTriggers";

/** One project that pins this workflow, with the schedules its assignment
 * carries. `canManage` is the caller-side read of `assignment.create`
 * (Maintainer+) — the toggle and the edit affordances live only there. */
export interface TriggerGroup {
  project: Project;
  assignment: Assignment;
  schedules: Schedule[];
  /** The issue-trigger intents this assignment carries (ADR-0056 part 2). */
  issueTriggers: IssueTrigger[];
  /** The project's repositories — the issue rows name the watched repo by
   * `owner/repo`. */
  repositories: Repository[];
  canManage: boolean;
}

export function WorkflowTriggers({ pipelineId }: { pipelineId: string }) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<{ group: TriggerGroup; schedule: Schedule } | null>(null);
  const [issueDialogOpen, setIssueDialogOpen] = useState(false);
  const [issueEditing, setIssueEditing] = useState<{
    group: TriggerGroup;
    trigger: IssueTrigger;
  } | null>(null);

  const projects = useProjects();
  const projectItems = projects.data?.items ?? [];
  const assignmentLists = useQueries({
    queries: projectItems.map((project) => ({
      queryKey: queryKeys.assignments(project.id),
      queryFn: () => apiFetch<AssignmentList>(`/api/v1/projects/${project.id}/assignments`),
    })),
  });
  const scheduleLists = useQueries({
    queries: projectItems.map((project, index) =>
      schedulesQueryOptions(
        project.id,
        (assignmentLists[index]?.data?.assignments ?? []).some(
          (candidate) => candidate.pipeline_id === pipelineId,
        ),
      ),
    ),
  });
  const repoLists = useQueries({
    queries: projectItems.map((project) => ({
      queryKey: queryKeys.repos(project.id),
      queryFn: () => apiFetch<RepositoryList>(`/api/v1/projects/${project.id}/repos`),
    })),
  });
  const issueTriggerLists = useQueries({
    queries: projectItems.map((project, index) => ({
      queryKey: ["project", project.id, "issue-triggers"] as const,
      queryFn: () => apiFetch<IssueTriggerList>(`/api/v1/projects/${project.id}/issue-triggers`),
      enabled: (assignmentLists[index]?.data?.assignments ?? []).some(
        (candidate) => candidate.pipeline_id === pipelineId,
      ),
    })),
  });

  // Groups: one per project that pins this pipeline, in the caller's own
  // project order. A list that has not arrived yet contributes nothing — the
  // pending gate below keeps an unarrived list from reading as "not assigned".
  const groups: TriggerGroup[] = [];
  projectItems.forEach((project, index) => {
    const list = assignmentLists[index]?.data;
    const assignment =
      list?.assignments.find((candidate) => candidate.pipeline_id === pipelineId) ?? null;
    if (!assignment) return;
    groups.push({
      project,
      assignment,
      schedules: scheduleLists[index]?.data?.schedules ?? [],
      issueTriggers: (issueTriggerLists[index]?.data?.issue_triggers ?? []).filter(
        (candidate) => candidate.assignment_id === assignment.id,
      ),
      repositories: repoLists[index]?.data?.items ?? [],
      canManage: project.my_role === "maintainer",
    });
  });
  const manageable = groups.filter((group) => group.canManage);

  const assignmentsPending = projectItems.some((_, index) => assignmentLists[index]?.isPending);
  const assignmentsError = projectItems.some((_, index) => assignmentLists[index]?.isError);
  const issueTriggersPending = projectItems.some((_, index) => issueTriggerLists[index]?.isPending);
  const issueTriggersError = projectItems.some((_, index) => issueTriggerLists[index]?.isError);

  return (
    <section data-testid="workflow-triggers" className="space-y-[6px]">
      <div className="flex items-center justify-between gap-2">
        <h2
          id="workflow-triggers-heading"
          className="font-mono text-[11px] font-semibold uppercase tracking-[.04em] text-muted"
        >
          Triggers
        </h2>
        <Button
          variant="secondary"
          compact
          data-testid="trigger-add-schedule"
          onClick={() => {
            setEditing(null);
            setDialogOpen(true);
          }}
        >
          Add schedule
        </Button>
      </div>
      {projects.isPending ? <Spinner label="Loading schedules" /> : null}
      {projects.isError ? (
        <ProblemBanner error={projects.error} fallback="The schedules could not be read." />
      ) : null}
      {!projects.isPending && !projects.isError && assignmentsPending ? (
        <Spinner label="Loading schedules" />
      ) : null}
      {!projects.isPending && !projects.isError && assignmentsError ? (
        <ProblemBanner
          error={assignmentLists.find((result) => result?.isError)?.error}
          fallback="The schedules could not be read."
        />
      ) : null}
      {!assignmentsPending && !assignmentsError && groups.length === 0 ? (
        <p className="text-[12.5px] text-muted" data-testid="triggers-empty">
          No schedules for this workflow yet — assign this workflow to a project first, then a cron
          can fire it.
        </p>
      ) : null}
      {groups.map((group) => (
        <div
          key={group.assignment.id}
          className="space-y-[2px]"
          data-testid={`trigger-group-${group.assignment.id}`}
        >
          <span className="block font-mono text-[10.5px] font-semibold uppercase tracking-[.04em] text-muted">
            {group.project.name}
          </span>
          <ul
            className="divide-y divide-line"
            data-testid={`trigger-schedules-${group.assignment.id}`}
          >
            {group.schedules.map((schedule) => (
              <ScheduleRow
                key={schedule.id}
                group={group}
                schedule={schedule}
                onEdit={() => {
                  setEditing({ group, schedule });
                  setDialogOpen(true);
                }}
              />
            ))}
          </ul>
          {group.schedules.length === 0 ? (
            <p
              className="px-[10px] py-[6px] font-mono text-[11px] text-muted"
              data-testid={`triggers-none-${group.assignment.id}`}
            >
              Never scheduled — every run of this pipeline was started by a person.
            </p>
          ) : null}
        </div>
      ))}
      <div data-testid="workflow-issue-triggers">
        <div className="flex items-center justify-between gap-2">
          <h3
            id="workflow-issue-triggers-heading"
            className="font-mono text-[11px] font-semibold uppercase tracking-[.04em] text-muted"
          >
            Issue triggers
          </h3>
          <Button
            variant="secondary"
            compact
            data-testid="trigger-add-issue"
            onClick={() => {
              setIssueDialogOpen(true);
            }}
          >
            Add issue trigger
          </Button>
        </div>
        {issueTriggersPending ? <Spinner label="Loading issue triggers" /> : null}
        {issueTriggersError ? (
          <ProblemBanner
            error={
              projectItems
                .map((_, index) => issueTriggerLists[index]?.error)
                .find((error): error is Error => error !== undefined) ?? null
            }
            fallback="The issue triggers could not be read."
          />
        ) : null}
        {!issueTriggersPending &&
        !issueTriggersError &&
        groups.every((group) => group.issueTriggers.length === 0) ? (
          <div data-testid="trigger-issue-placeholder">
            <span className="block font-mono text-[11px] text-faint">
              No issue triggers yet — watch a GitHub repository for an issue to fire this workflow.
            </span>
          </div>
        ) : null}
        {groups.flatMap((group) =>
          group.issueTriggers.map((trigger) => (
            <div
              key={trigger.id}
              className="space-y-[2px]"
              data-testid={`trigger-issue-group-${group.assignment.id}`}
            >
              <span className="block font-mono text-[10.5px] font-semibold uppercase tracking-[.04em] text-muted">
                {group.project.name}
              </span>
              <ul
                className="divide-y divide-line"
                data-testid={`trigger-issue-rows-${group.assignment.id}`}
              >
                <IssueTriggerRow
                  group={group}
                  trigger={trigger}
                  onEdit={(edited) => {
                    setIssueEditing({ group, trigger: edited });
                    setIssueDialogOpen(true);
                  }}
                />
              </ul>
            </div>
          )),
        )}
        <p className="font-mono text-[10.5px] text-faint" data-testid="trigger-issue-note">
          Checked every minute · public GitHub repositories only
        </p>
      </div>
      <TriggersDialog
        open={dialogOpen}
        onClose={() => {
          setDialogOpen(false);
          setEditing(null);
        }}
        assignments={manageable}
        editing={editing}
      />
      <IssueTriggerDialog
        open={issueDialogOpen}
        onClose={() => {
          setIssueDialogOpen(false);
          setIssueEditing(null);
        }}
        assignments={manageable}
        editing={issueEditing}
      />
    </section>
  );
}

/** One schedule row: the cron expression in mono, its plain-English reading,
 * the next fire, the last run's link, and — for a caller who may write — the
 * enabled toggle and the edit action. */
function ScheduleRow({
  group,
  schedule,
  onEdit,
}: {
  group: TriggerGroup;
  schedule: Schedule;
  onEdit: () => void;
}) {
  const patch = usePatchSchedule(group.project.id);
  const stateText = schedule.enabled ? "on" : "paused";
  const nextFire = nextFireText(schedule);
  const words = cronInWords(schedule.cron_expr);
  const cronRaw = schedule.cron_expr.trim();
  const cronEnglish = words.trim() === cronRaw ? cronRaw : words.trim();
  return (
    <li
      className="flex flex-wrap items-center gap-[10px]"
      data-testid={`trigger-row-${schedule.id}`}
    >
      <code
        className="rounded-[3px] border border-line bg-fill px-[6px] py-[1px] font-mono text-[11.5px] text-ink"
        data-testid={`trigger-cron-${schedule.id}`}
      >
        {schedule.cron_expr}
      </code>
      <span
        className="font-mono text-[11px] text-ink-2"
        data-testid={`trigger-cron-words-${schedule.id}`}
      >
        {cronEnglish}
      </span>
      <span
        className="font-mono text-[11px] text-faint"
        data-testid={`trigger-next-${schedule.id}`}
      >
        {nextFire}
      </span>
      {schedule.last_run_id ? (
        <Link
          to={routes.run(schedule.last_run_id)}
          className="font-mono text-[11px] text-accent"
          data-testid={`trigger-last-run-${schedule.id}`}
        >
          last run {shortId(schedule.last_run_id)}
        </Link>
      ) : (
        <span className="font-mono text-[11px] text-faint">never run</span>
      )}
      {group.canManage ? (
        <label className="flex items-center gap-[6px] font-mono text-[11px] text-ink">
          <input
            type="checkbox"
            className="size-3 accent-accent"
            checked={schedule.enabled}
            aria-label={`schedule ${schedule.id} enabled`}
            data-testid={`trigger-enabled-${schedule.id}`}
            onChange={(event) =>
              patch.mutate({
                scheduleId: schedule.id,
                body: { version: schedule.version, enabled: event.target.checked },
              })
            }
          />
          <span data-testid={`trigger-state-${schedule.id}`}>{stateText}</span>
        </label>
      ) : (
        <StatusChip
          state={schedule.enabled ? "info" : "interrupted"}
          label={stateText}
          labelProps={{ "data-testid": `trigger-state-${schedule.id}` }}
        />
      )}
      {group.canManage ? (
        <Button
          variant="secondary"
          compact
          data-testid={`trigger-edit-${schedule.id}`}
          onClick={onEdit}
        >
          Edit
        </Button>
      ) : null}
      {patch.isError ? (
        <Alert state="failed" label="FAILED" role="alert" testid={`trigger-error-${schedule.id}`}>
          {patchErrorText(patch.error)}
        </Alert>
      ) : null}
    </li>
  );
}

/** The next fire, in the one form that is true for the schedule's state:
 * relative (`next 3h left`) plus the absolute UTC landing time. A paused
 * schedule keeps its last `next_run_at` (ADR-0032 never backfills missed
 * slots), so it says `paused` rather than promising a countdown. */
function nextFireText(schedule: Schedule, now = Date.now()): string {
  if (!schedule.enabled) return "paused";
  const remaining = formatRemaining(schedule.next_run_at, now);
  const at = formatClock(schedule.next_run_at);
  if (remaining === "passed") return `due now · ${at}`;
  if (remaining === "unknown") return `unknown · ${at}`;
  return `next ${remaining} · ${at}`;
}

/** The toggle/edit failure line: a version-stale 409 says the schedule moved
 * under the caller and to re-read; anything else keeps the server's own words. */
export function patchErrorText(error: unknown): string {
  if (error instanceof ApiError && error.status === 409) {
    const detail = error.detail ? ` ${error.detail}` : "";
    return `changed elsewhere, reload —${detail}`;
  }
  const problem = problemOf(error);
  return problem.detail ? `${problem.title}: ${problem.detail}` : problem.title;
}
