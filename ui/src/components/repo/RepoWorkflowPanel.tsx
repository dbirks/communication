/**
 * WORKFLOWS · n — the repo page's side-panel workflow list (design 3a).
 *
 * One row per use of a library workflow in this repository (the ADR-0060
 * assignments: this repo's pins plus the whole-project ones), each carrying
 * exactly what the 3a row draws and nothing else:
 * - the name (12.5/600, linking to the workflow's library page);
 * - ONE trigger line — `GitHub · issue labeled <label>` / `Schedule · <cron
 *   in words>` / `By hand` — never an inline STARTS WHEN box;
 * - the latest result line (mono 10, state color, glyph + word per handoff
 *   rule 06): `● 1 running · ! 1 needs you` while runs are live, else
 *   `✓ last 6h ago` / `× last failed 1d ago` for the newest finished run;
 * - a `Run` button that opens the page's run-start form.
 *
 * Triggers are EDITED from the row's `⋯` menu, which opens today's
 * TriggerDialog (add or edit) — the same dialog the 2e panel used, only
 * reached from a menu instead of an inline box. `+ add` in the bar opens the
 * same "use a library workflow" dialog (`RepoLibraryPicker`) the page has
 * always used.
 *
 * Honesty: the row claims no trigger before both trigger reads have landed
 * (a failure says "triggers unavailable", never "By hand"), and no result
 * before the run list has; ages come from the run's own timestamps.
 */
import { useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { MoreHorizontal } from "lucide-react";
import type { Assignment, Project, Repository, RunSummary } from "../../api/types";
import { useAssignments, usePipelines, useSchedules, type Schedule } from "../../api/pipelines";
import { useIssueTriggers, type IssueTrigger } from "../../api/useIssueTriggers";
import { Panel } from "../ds/Panel";
import { Button } from "../ds/Button";
import { Menu, type MenuEntry } from "../ds/Menu";
import { ProblemBanner, Spinner } from "../Feedback";
import { TriggerDialog, type TriggerEditing } from "../workflows/TriggerDialog";
import { RepoLibraryPicker } from "../workflows/RepoWorkflows";
import { cronInWords } from "../../lib/cronText";
import { formatAge, testidOf } from "../../lib/format";
import { routes } from "../../lib/routes";

/** The statuses after which a run is no longer live (the terminal arms of
 * `RunStatus`; `interrupted` stopped with the outcome unknown). */
const TERMINAL_RUN_STATUSES = new Set<string>(["completed", "failed", "cancelled", "interrupted"]);

export interface RepoWorkflowPanelProps {
  projectId: string;
  project: Project;
  repository: Repository;
  /** The project's runs (the page's one read) — the rows take their latest
   * result from here, attributed through `run.assignment_id`. */
  runs: readonly RunSummary[] | undefined;
  runsPending: boolean;
  runsError: unknown;
  /** Opens the page's run-start form (the same one for every row). */
  onRun: () => void;
}

export function RepoWorkflowPanel({
  projectId,
  project,
  repository,
  runs,
  runsPending,
  runsError,
  onRun,
}: RepoWorkflowPanelProps) {
  const assignments = useAssignments(projectId);
  const schedules = useSchedules(projectId);
  const issueTriggers = useIssueTriggers(projectId);
  const pipelines = usePipelines();

  const canManage = project.my_role === "maintainer";
  const [pickerOpen, setPickerOpen] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{
    assignment: Assignment;
    workflowLabel: string;
    editing: TriggerEditing | null;
  } | null>(null);

  // ADR-0060: this repo's own pins plus the whole-project ones.
  const usable = useMemo(
    () =>
      (assignments.data?.assignments ?? []).filter(
        (assignment) =>
          assignment.repository_id === repository.id ||
          assignment.repository_id == null ||
          assignment.repository_id === undefined,
      ),
    [assignments.data, repository.id],
  );

  const names = useMemo(
    () =>
      new Map(
        (pipelines.data?.pipelines ?? []).map((pipeline) => [
          pipeline.id,
          pipeline.display_name || pipeline.slug,
        ]),
      ),
    [pipelines.data],
  );

  // A trigger read that has not arrived is not "no triggers"; one that
  // FAILED is not "By hand" either.
  const triggerReadsReady = !schedules.isPending && !issueTriggers.isPending;
  const triggerReadsFailed = schedules.isError || issueTriggers.isError;

  return (
    <>
      <Panel
        id="repo-workflows"
        title={assignments.data ? `WORKFLOWS\u00A0\u00B7\u00A0${usable.length}` : "WORKFLOWS"}
        headingId="repo-workflows-heading"
        headingLevel={2}
        className="min-w-0"
        meta={
          canManage ? (
            <button
              type="button"
              onClick={() => setPickerOpen(true)}
              className="font-mono text-[10.5px] font-normal normal-case text-accent-text hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
              data-testid="repo-workflow-library"
            >
              + add
            </button>
          ) : undefined
        }
      >
        <div className="p-[10px]" data-testid="repo-workflows">
          {assignments.isPending ? <Spinner label="Loading workflows" /> : null}
          {assignments.isError ? (
            <ProblemBanner
              error={assignments.error}
              fallback="The project's assignments could not be read."
              subject="the workflows on this repository"
              retry={{
                onClick: () => void assignments.refetch(),
                pending: assignments.isFetching,
                testid: "repo-workflows-retry",
              }}
            />
          ) : null}
          {assignments.data && usable.length === 0 ? (
            <p className="text-[12.5px] text-muted" data-testid="repo-workflows-empty">
              This repository uses no workflow yet — + add gives it one.
            </p>
          ) : null}
          <ul className="divide-y divide-line-soft" data-testid="repo-workflows-list">
            {usable.map((assignment) => (
              <RepoWorkflowSideRow
                key={assignment.id}
                assignment={assignment}
                name={names.get(assignment.pipeline_id) ?? null}
                schedules={(schedules.data?.schedules ?? []).filter(
                  (schedule) => schedule.assignment_id === assignment.id,
                )}
                issueTriggers={(issueTriggers.data?.issue_triggers ?? []).filter(
                  (trigger) => trigger.assignment_id === assignment.id,
                )}
                triggerReadsReady={triggerReadsReady}
                triggerReadsFailed={triggerReadsFailed}
                runs={runs}
                runsPending={runsPending}
                runsError={runsError}
                canManage={canManage}
                menuOpen={menuFor === assignment.id}
                onOpenMenu={() => setMenuFor(assignment.id)}
                onCloseMenu={() => setMenuFor(null)}
                onRun={onRun}
                onAddTrigger={() =>
                  setDialog({
                    assignment,
                    workflowLabel: names.get(assignment.pipeline_id) ?? assignment.pipeline_id,
                    editing: null,
                  })
                }
                onEdit={(editing) =>
                  setDialog({
                    assignment,
                    workflowLabel: names.get(assignment.pipeline_id) ?? assignment.pipeline_id,
                    editing,
                  })
                }
              />
            ))}
          </ul>
        </div>
      </Panel>
      <RepoLibraryPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        projectId={projectId}
        repository={repository}
        usedHere={
          new Set(
            (assignments.data?.assignments ?? [])
              .filter((assignment) => assignment.repository_id === repository.id)
              .map((assignment) => assignment.pipeline_id),
          )
        }
      />
      {dialog ? (
        <TriggerDialog
          open
          onClose={() => setDialog(null)}
          project={{ id: project.id, name: project.name }}
          repository={repository}
          assignment={dialog.assignment}
          workflowLabel={dialog.workflowLabel}
          editing={dialog.editing}
        />
      ) : null}
    </>
  );
}

interface RepoWorkflowSideRowProps {
  assignment: Assignment;
  name: string | null;
  schedules: Schedule[];
  issueTriggers: IssueTrigger[];
  triggerReadsReady: boolean;
  triggerReadsFailed: boolean;
  runs: readonly RunSummary[] | undefined;
  runsPending: boolean;
  runsError: unknown;
  canManage: boolean;
  menuOpen: boolean;
  onOpenMenu: () => void;
  onCloseMenu: () => void;
  onRun: () => void;
  onAddTrigger: () => void;
  onEdit: (editing: TriggerEditing) => void;
}

function RepoWorkflowSideRow({
  assignment,
  name,
  schedules,
  issueTriggers,
  triggerReadsReady,
  triggerReadsFailed,
  runs,
  runsPending,
  runsError,
  canManage,
  menuOpen,
  onOpenMenu,
  onCloseMenu,
  onRun,
  onAddTrigger,
  onEdit,
}: RepoWorkflowSideRowProps) {
  const key = testidOf(assignment.id);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const menuItems: MenuEntry[] = [
    {
      id: "add",
      label: "+ Add trigger",
      onSelect: () => {
        onCloseMenu();
        onAddTrigger();
      },
      testId: `repo-workflow-menu-add-${key}`,
    },
    ...(schedules.length + issueTriggers.length > 0 ? ([{ separator: true }] as MenuEntry[]) : []),
    ...issueTriggers.map((trigger) => ({
      id: trigger.id,
      label: `Edit trigger: ${issueTriggerWords(trigger)}`,
      onSelect: () => {
        onCloseMenu();
        onEdit({ kind: "issue" as const, trigger });
      },
      testId: `repo-workflow-menu-issue-${testidOf(trigger.id)}`,
    })),
    ...schedules.map((schedule) => ({
      id: schedule.id,
      label: `Edit trigger: ${scheduleWords(schedule)}`,
      onSelect: () => {
        onCloseMenu();
        onEdit({ kind: "schedule" as const, schedule });
      },
      testId: `repo-workflow-menu-schedule-${testidOf(schedule.id)}`,
    })),
  ];

  return (
    <li className="py-[10px] first:pt-0" data-testid={`repo-workflow-row-${key}`}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1 space-y-[2px]">
          {name ? (
            <Link
              to={routes.workflow(assignment.pipeline_id)}
              className="block truncate text-[12.5px] font-semibold text-ink hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
              data-testid={`repo-workflow-name-${key}`}
            >
              {name}
            </Link>
          ) : (
            <span
              className="block font-mono text-[10px] text-muted"
              data-testid={`repo-workflow-name-${key}`}
            >
              · loading
            </span>
          )}
          <p
            className="min-w-0 break-words font-mono text-[10.5px] text-muted"
            data-testid={`repo-workflow-triggers-${key}`}
          >
            {triggerReadsFailed
              ? "triggers unavailable"
              : triggerReadsReady
                ? triggerLine(issueTriggers, schedules)
                : "· loading"}
          </p>
          <LatestResult
            runs={runs}
            runsPending={runsPending}
            runsError={runsError}
            assignmentId={assignment.id}
            testid={`repo-workflow-result-${key}`}
          />
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <Button
            variant="secondary"
            compact
            onClick={onRun}
            data-testid={`repo-workflow-run-${key}`}
          >
            Run
          </Button>
          {canManage ? (
            <button
              ref={triggerRef}
              type="button"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label={`${name ?? "This workflow"} triggers`}
              onClick={onOpenMenu}
              className="icon-hit shrink-0 rounded-[3px] text-ink-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
              data-testid={`repo-workflow-menu-${key}`}
            >
              <MoreHorizontal size={14} strokeWidth={2} aria-hidden />
            </button>
          ) : null}
        </div>
      </div>
      {canManage ? (
        <Menu
          open={menuOpen}
          onClose={onCloseMenu}
          triggerRef={triggerRef}
          side="bottom"
          align="end"
          width={220}
          ariaLabel="Workflow triggers"
          data-testid="repo-workflow-row-menu"
          items={menuItems}
        />
      ) : null}
    </li>
  );
}

/* The trigger and result copy ------------------------------------------------ */

/** The row's ONE trigger line: `GitHub · issue labeled factory`,
 * `Schedule · daily at 02:00`, … — several triggers join with ` · `, none
 * means `By hand`. Paused triggers keep their words (2e's copy rule: a
 * switch-off is not a deletion), marked with a mono `(off)`. */
function triggerLine(issueTriggers: IssueTrigger[], schedules: Schedule[]): string {
  const parts: string[] = [
    ...issueTriggers.map(
      (trigger) => `GitHub · ${issueTriggerWords(trigger)}${trigger.enabled ? "" : " (off)"}`,
    ),
    ...schedules.map(
      (schedule) => `Schedule · ${scheduleWords(schedule)}${schedule.enabled ? "" : " (off)"}`,
    ),
  ];
  return parts.length > 0 ? parts.join(" · ") : "By hand";
}

function issueTriggerWords(trigger: IssueTrigger): string {
  const event = trigger.event === "opened" ? "issue opened" : "issue labeled";
  return trigger.labels.length > 0 ? `${event} ${trigger.labels.join(", ")}` : event;
}

function scheduleWords(schedule: Schedule): string {
  const raw = schedule.cron_expr.trim();
  const words = cronInWords(raw).trim();
  return words === "" || words === raw ? raw : words;
}

/** One line under the triggers: the newest word the runs say about this
 * workflow. Live runs count by state (each piece in its own state color,
 * glyph AND word — handoff rule 06); otherwise the newest finished run
 * reports itself. Never an invention: pending says so, a failed read says
 * so. */
function LatestResult({
  runs,
  runsPending,
  runsError,
  assignmentId,
  testid,
}: {
  runs: readonly RunSummary[] | undefined;
  runsPending: boolean;
  runsError: unknown;
  assignmentId: string;
  testid: string;
}) {
  if (runsError) {
    return (
      <p className="font-mono text-[10px] text-st-failed-tag-fg" data-testid={testid}>
        runs unavailable
      </p>
    );
  }
  if (runsPending || !runs) {
    return (
      <p className="font-mono text-[10px] text-muted" data-testid={testid}>
        · loading
      </p>
    );
  }
  const mine = runs.filter(
    (run) => run.depth === 0 && run.assignment_id != null && run.assignment_id === assignmentId,
  );
  const live = mine.filter((run) => !TERMINAL_RUN_STATUSES.has(run.status));
  const waiting = live.filter((run) => run.status === "waiting_human" || run.status === "paused");
  const running = live.filter(
    (run) => run.status === "queued" || run.status === "preparing" || run.status === "running",
  );
  if (live.length > 0) {
    return (
      <p className="flex flex-wrap items-center gap-x-1 font-mono text-[10px]" data-testid={testid}>
        {running.length > 0 ? (
          <span className="text-st-running-tag-fg">
            <span aria-hidden="true">{`● ${running.length} running`}</span>
            <span className="sr-only">{`${running.length} running`}</span>
          </span>
        ) : null}
        {running.length > 0 && waiting.length > 0 ? <span aria-hidden="true">·</span> : null}
        {waiting.length > 0 ? (
          <span className="text-st-waiting-tag-fg">
            <span aria-hidden="true">{`! ${waiting.length} needs you`}</span>
            <span className="sr-only">{`${waiting.length} need you`}</span>
          </span>
        ) : null}
      </p>
    );
  }
  const latest = mine[0];
  if (!latest) {
    return (
      <p className="font-mono text-[10px] text-muted" data-testid={testid}>
        no runs yet
      </p>
    );
  }
  const at = latest.finished_at ?? latest.created_at;
  const age = `last ${formatAge(at)} ago`;
  if (latest.status === "completed") {
    return (
      <p className="font-mono text-[10px] text-st-done-tag-fg" data-testid={testid}>
        <span aria-hidden="true">{`✓ ${age}`}</span>
        <span className="sr-only">{`done ${age}`}</span>
      </p>
    );
  }
  const state = latest.status === "failed" ? "failed" : "interrupted";
  const word = latest.status === "failed" ? "failed" : "stopped";
  return (
    <p
      className={`font-mono text-[10px] ${
        state === "failed" ? "text-st-failed-tag-fg" : "text-st-interrupted-tag-fg"
      }`}
      data-testid={testid}
    >
      <span aria-hidden="true">{`${latest.status === "failed" ? "×" : "⊘"} ${word} ${age}`}</span>
      <span className="sr-only">{`${word} ${age}`}</span>
    </p>
  );
}
