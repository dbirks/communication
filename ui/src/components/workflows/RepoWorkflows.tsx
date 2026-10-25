/**
 * `WORKFLOWS ON THIS REPO` — the repository page's workflow panel (design 1e,
 * triggers per 2e).
 *
 * The mental model (ADR-0060): a library workflow is a template; a repository
 * *uses* it through a project assignment pinned to a revision. Triggers belong
 * to that use, so they are authored here — never on the library page. The
 * panel therefore lists the assignments that name THIS repository plus the
 * whole-project ones (`repository_id` null covers every repo of the project).
 *
 * Each row is collapsible (the handoff's SVG chevron `M3 4.5l3 3 3-3`):
 * - collapsed: name · pinned-revision chip (`✓ r3`, the number the server's
 *   own revision summary carries) · trigger summary ("started by hand", or a
 *   Lucide icon + sentence per trigger) · `+ Add trigger` · `Run`, over the
 *   mono step chain of the PINNED revision (loop scopes shaded);
 * - expanded: the `STARTS WHEN` box (indented 34px, `bg-accent-wash` header
 *   strip in accent mono caps with `+ Add trigger` on the right), one grid row
 *   per trigger (`18px 1fr 160px 80px 40px`, stacking below 900px so 390px
 *   never scrolls sideways), and the closing line "Or start it by hand with
 *   Run, or from an issue below."
 *
 * Honesty rules:
 * - Nothing renders before its read has arrived: the count, the chain and the
 *   revision chip wait for their own responses, and a failed read says so.
 * - The trigger routes are the ones that exist: ADR-0032 schedules and
 *   ADR-0056 issue triggers. An issue trigger's bookkeeping is the poller's
 *   (`last_polled_at` / `last_error`), never a guessed "last fired".
 * - `Run` opens the same `NewRunForm` the page already used for issue runs;
 *   the server picks the pinned revision, this panel never re-derives it.
 * - The toggle is the PATCH the route offers (`enabled`, optimistic on
 *   `version`); a stale-version `409` shows the server's own words.
 *
 * Panel header link: `+ use a library workflow` (Maintainer+) opens a picker
 * of the org library and creates the assignment for THIS project pinned to
 * that workflow's latest published revision with `repository_id` = this repo.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { useQueries } from "@tanstack/react-query";
import { Clock, Play } from "lucide-react";
import { Panel } from "../ds/Panel";
import { Button } from "../ds/Button";
import { StatusChip } from "../ds/Row";
import { Field, Input } from "../ds/Field";
import { FormError, ProblemBanner, Spinner } from "../Feedback";
import { NewRunForm } from "../m4/NewRunForm";
import { useRepositories } from "../../api/queries";
import {
  pipelineQueryOptions,
  revisionQueryOptions,
  useAssignments,
  useCreateAssignment,
  usePatchSchedule,
  usePipeline,
  usePipelines,
  useRevision,
  useSchedules,
} from "../../api/pipelines";
import type { Schedule } from "../../api/pipelines";
import { useIssueTriggers, usePatchIssueTrigger } from "../../api/useIssueTriggers";
import type { IssueTrigger } from "../../api/useIssueTriggers";
import type {
  Assignment,
  PipelineSummary,
  Project,
  Repository,
  RepositoryList,
} from "../../api/types";
import { cronInWords } from "../../lib/cronText";
import { formatAge, formatClock, formatRemaining, testidOf } from "../../lib/format";
import { shortId } from "../../api/names";
import { routes } from "../../lib/routes";
import { isDefinitionDocument } from "../../lib/pipeline/definition";
import { stepChain } from "./WorkflowRow";
import { repoRefOf } from "./IssueTriggerRow";
import { patchErrorText } from "./Triggers";
import { GithubIcon, TriggerDialog, type TriggerEditing } from "./TriggerDialog";

export interface RepoWorkflowsProps {
  projectId: string;
  /** The project the page is about — its name labels the dialog context and
   * its `my_role` decides who may write. */
  project: Project;
  repository: Repository;
}

/** One row's worth of truth: the assignment plus everything its own reads
 * returned for it. Nothing here is invented — a read that has not arrived
 * leaves its field `null` and the row renders the honest placeholder. */
interface RepoWorkflowRowData {
  assignment: Assignment;
  /** The library workflow's name (display name, else slug), null until read. */
  name: string | null;
  /** The pinned revision's number, null until read. */
  revisionNumber: number | null;
  /** The pinned revision's top-level step chain; null until it parses. */
  chain: ReturnType<typeof stepChain> | null;
  schedules: Schedule[];
  issueTriggers: IssueTrigger[];
}

export function RepoWorkflows({ projectId, project, repository }: RepoWorkflowsProps) {
  const assignments = useAssignments(projectId);
  const schedules = useSchedules(projectId);
  const issueTriggers = useIssueTriggers(projectId);
  const repositories = useRepositories(projectId);

  const canManage = project.my_role === "maintainer";
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [runOpen, setRunOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [dialog, setDialog] = useState<{
    assignment: Assignment;
    workflowLabel: string;
    editing: TriggerEditing | null;
  } | null>(null);

  // ADR-0060: this repo's own assignments, plus the whole-project pins
  // (`repository_id` null) that cover every repository of the project.
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

  // Two small fans, keyed exactly like the single-read hooks so the cache is
  // shared with the library and the workflow page: the pipeline read names
  // the row, the pinned revision read carries its number and its document.
  const definitionFan = useQueries({
    queries: usable.map((assignment) => pipelineQueryOptions(assignment.pipeline_id)),
  });
  const revisionFan = useQueries({
    queries: usable.map((assignment) => revisionQueryOptions(assignment.pinned_revision_digest)),
  });

  const rows: RepoWorkflowRowData[] = usable.map((assignment, index) => {
    const definition = definitionFan[index]?.data;
    const revision = revisionFan[index]?.data;
    const document =
      revision && isDefinitionDocument(revision.canonical_document)
        ? revision.canonical_document
        : null;
    return {
      assignment,
      name: definition ? definition.display_name || definition.slug : null,
      revisionNumber: revision?.revision_number ?? null,
      chain: document ? stepChain(document) : null,
      schedules: (schedules.data?.schedules ?? []).filter(
        (schedule) => schedule.assignment_id === assignment.id,
      ),
      issueTriggers: (issueTriggers.data?.issue_triggers ?? []).filter(
        (trigger) => trigger.assignment_id === assignment.id,
      ),
    };
  });

  // A trigger read that has not arrived is not "no triggers": the summary
  // stays a placeholder until both lists have landed. A trigger read that
  // FAILED is not "started by hand" either — the row says it cannot tell.
  const triggerReadsReady = !schedules.isPending && !issueTriggers.isPending;
  const triggerReadsFailed = schedules.isError || issueTriggers.isError;

  return (
    <Panel
      id="repo-workflows"
      title={
        assignments.data ? `WORKFLOWS ON THIS REPO · ${usable.length}` : "WORKFLOWS ON THIS REPO"
      }
      headingId="repo-workflows-heading"
      headingLevel={2}
      className="max-w-[900px]"
      meta={
        canManage ? (
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            className="font-mono text-[10.5px] normal-case text-accent-text hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
            data-testid="repo-workflow-library"
          >
            + use a library workflow
          </button>
        ) : undefined
      }
    >
      <div className="space-y-[6px] p-[10px]" data-testid="repo-workflows">
        {assignments.isPending ? <Spinner label="Loading workflows" /> : null}
        {assignments.isError ? (
          <ProblemBanner
            error={assignments.error}
            fallback="The project's assignments could not be read."
          />
        ) : null}
        {assignments.data && usable.length === 0 ? (
          <p className="text-[12.5px] text-muted" data-testid="repo-workflows-empty">
            This repository uses no workflow yet — use a library workflow to give it one.
          </p>
        ) : null}
        {rows.map((row) => (
          <RepoWorkflowRow
            key={row.assignment.id}
            projectId={projectId}
            repository={repository}
            repositoryNames={repositories.data}
            data={row}
            canManage={canManage}
            triggerReadsReady={triggerReadsReady}
            triggerReadsFailed={triggerReadsFailed}
            open={expanded[row.assignment.id] ?? false}
            onToggle={() =>
              setExpanded((current) => ({
                ...current,
                [row.assignment.id]: !(current[row.assignment.id] ?? false),
              }))
            }
            onAddTrigger={() =>
              setDialog({
                assignment: row.assignment,
                workflowLabel: row.name ?? row.assignment.pipeline_id,
                editing: null,
              })
            }
            onEdit={(editing) =>
              setDialog({
                assignment: row.assignment,
                workflowLabel: row.name ?? row.assignment.pipeline_id,
                editing,
              })
            }
            onRun={() => setRunOpen(true)}
          />
        ))}
        {runOpen ? (
          <Panel title="START A RUN" headingId="repo-workflow-run-heading" headingLevel={3}>
            <div className="p-[10px]">
              <NewRunForm projectId={projectId} onCancel={() => setRunOpen(false)} />
            </div>
          </Panel>
        ) : null}
      </div>
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
    </Panel>
  );
}

interface RepoWorkflowRowProps {
  projectId: string;
  repository: Repository;
  /** The project's repositories, once read (issue triggers on other repos). */
  repositoryNames: RepositoryList | undefined;
  data: RepoWorkflowRowData;
  canManage: boolean;
  triggerReadsReady: boolean;
  /** A schedule/issue-trigger read that failed: the row refuses to claim the
   * workflow is hand-started when it simply cannot tell. */
  triggerReadsFailed: boolean;
  open: boolean;
  onToggle: () => void;
  onAddTrigger: () => void;
  onEdit: (editing: TriggerEditing) => void;
  onRun: () => void;
}

function RepoWorkflowRow({
  projectId,
  repository,
  repositoryNames,
  data,
  canManage,
  triggerReadsReady,
  triggerReadsFailed,
  open,
  onToggle,
  onAddTrigger,
  onEdit,
  onRun,
}: RepoWorkflowRowProps) {
  const { assignment } = data;
  const key = testidOf(assignment.id);

  return (
    <li
      className="border-b border-line pb-[6px] last:border-b-0"
      data-testid={`repo-workflow-row-${key}`}
    >
      <div className="grid grid-cols-1 items-center gap-x-4 gap-y-[6px] min-[900px]:grid-cols-[minmax(0,1fr)_auto]">
        <div className="min-w-0 space-y-[5px]">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <button
              type="button"
              aria-expanded={open}
              aria-label={open ? "Collapse triggers" : "Expand triggers"}
              onClick={onToggle}
              className="shrink-0 rounded-[3px] text-ink-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
              data-testid={`repo-workflow-toggle-${key}`}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 12 12"
                aria-hidden="true"
                className={open ? "" : "-rotate-90"}
              >
                <path
                  d="M3 4.5l3 3 3-3"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
            {data.name ? (
              <Link
                to={routes.workflow(assignment.pipeline_id)}
                className="truncate text-[13.5px] font-semibold text-ink hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
                data-testid={`repo-workflow-name-${key}`}
              >
                {data.name}
              </Link>
            ) : (
              <span
                className="font-mono text-[10.5px] text-muted"
                data-testid={`repo-workflow-name-${key}`}
              >
                · loading
              </span>
            )}
            {data.revisionNumber !== null ? (
              <StatusChip
                state="done"
                label={`r${data.revisionNumber}`}
                labelProps={{ "data-testid": `repo-workflow-revision-${key}` }}
              />
            ) : (
              <span
                className="font-mono text-[10px] text-muted"
                data-testid={`repo-workflow-revision-${key}`}
              >
                · loading
              </span>
            )}
            {triggerReadsReady ? (
              <TriggerSummary
                schedules={data.schedules}
                issueTriggers={data.issueTriggers}
                failed={triggerReadsFailed}
                testid={`repo-workflow-summary-${key}`}
              />
            ) : (
              <span
                className="font-mono text-[10px] text-muted"
                data-testid={`repo-workflow-summary-${key}`}
              >
                · loading
              </span>
            )}
          </div>
          <div
            className="flex min-w-0 flex-wrap items-center gap-x-[6px] gap-y-[4px] pl-[22px]"
            data-testid={`repo-workflow-chain-${key}`}
          >
            {data.chain === null ? (
              <span className="font-mono text-[10.5px] text-muted">…</span>
            ) : data.chain.length === 0 ? (
              <span className="font-mono text-[10.5px] text-muted">—</span>
            ) : (
              data.chain.map((cell, index) => (
                <span key={index} className="flex items-center gap-[6px]">
                  {index > 0 ? (
                    <span aria-hidden="true" className="font-mono text-[10px] text-muted">
                      ›
                    </span>
                  ) : null}
                  <span
                    className={
                      cell.loop
                        ? "rounded-[3px] border border-line bg-paper px-[5px] py-[1px] font-mono text-[10.5px] text-ink-2"
                        : "font-mono text-[10.5px] text-ink-2"
                    }
                    data-testid={`repo-workflow-chain-${key}-${index}`}
                  >
                    {cell.label}
                  </span>
                </span>
              ))
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 min-[900px]:justify-end">
          {canManage ? (
            <button
              type="button"
              onClick={onAddTrigger}
              className="text-[12.5px] font-semibold text-accent-text hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
              data-testid={`repo-workflow-add-${key}`}
            >
              + Add trigger
            </button>
          ) : null}
          <Button
            variant="secondary"
            compact
            onClick={onRun}
            data-testid={`repo-workflow-run-${key}`}
          >
            Run
          </Button>
        </div>
      </div>

      {open ? (
        <div
          className="mb-[6px] ml-[34px] mt-[10px] overflow-hidden rounded-[3px] border border-line-strong"
          data-testid={`repo-workflow-starts-${key}`}
        >
          <div className="flex items-center gap-2 border-b border-accent-ring bg-accent-wash px-3 py-[6px] font-mono text-[10px] font-semibold uppercase tracking-[.04em] text-accent-text">
            <span>STARTS WHEN</span>
            {canManage ? (
              <button
                type="button"
                onClick={onAddTrigger}
                className="ml-auto font-ui text-[12px] font-semibold normal-case tracking-normal text-accent-text hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
                data-testid={`repo-workflow-add-box-${key}`}
              >
                + Add trigger
              </button>
            ) : null}
          </div>
          {data.schedules.map((schedule) => (
            <RepoScheduleRow
              key={schedule.id}
              projectId={projectId}
              schedule={schedule}
              canManage={canManage}
              onEdit={() => onEdit({ kind: "schedule", schedule })}
            />
          ))}
          {data.issueTriggers.map((trigger) => (
            <RepoIssueRow
              key={trigger.id}
              projectId={projectId}
              thisRepository={repository}
              trigger={trigger}
              repositoryNames={repositoryNames}
              canManage={canManage}
              onEdit={() => onEdit({ kind: "issue", trigger })}
            />
          ))}
          {!triggerReadsReady ? (
            <p
              className="px-3 py-[9px] font-mono text-[11px] text-muted"
              data-testid={`repo-workflow-loading-${key}`}
            >
              Reading this workflow's triggers…
            </p>
          ) : triggerReadsFailed ? (
            <p
              role="alert"
              className="px-3 py-[9px] font-mono text-[11px] text-st-failed-pale-fg"
              data-testid={`repo-workflow-triggers-unavailable-${key}`}
            >
              The trigger list could not be read — this row does not claim the workflow is
              hand-started.
            </p>
          ) : data.schedules.length === 0 && data.issueTriggers.length === 0 ? (
            <p
              className="px-3 py-[9px] font-mono text-[11px] text-muted"
              data-testid={`repo-workflow-none-${key}`}
            >
              Never triggered — every run of this workflow was started by a person.
            </p>
          ) : null}
          <div className="flex items-center gap-[10px] border-t border-line-soft px-3 py-[9px] text-[12px] text-muted">
            <Play size={14} strokeWidth={2} aria-hidden className="shrink-0 opacity-60" />
            <span>Or start it by hand with Run, or from an issue below.</span>
          </div>
        </div>
      ) : null}
    </li>
  );
}

/** The collapsed row's trigger summary: icons + sentences, or the honest
 * "started by hand" when the assignment carries no trigger at all. */
function TriggerSummary({
  schedules,
  issueTriggers,
  failed,
  testid,
}: {
  schedules: Schedule[];
  issueTriggers: IssueTrigger[];
  failed: boolean;
  testid: string;
}) {
  if (failed) {
    return (
      <span className="text-[12px] text-st-failed-pale-fg" data-testid={testid}>
        triggers unavailable
      </span>
    );
  }
  if (schedules.length === 0 && issueTriggers.length === 0) {
    return (
      <span className="flex items-center gap-[5px] text-[12px] text-muted" data-testid={testid}>
        <Play size={14} strokeWidth={2} aria-hidden className="shrink-0 opacity-60" />
        <span>started by hand</span>
      </span>
    );
  }
  return (
    <span
      className="flex min-w-0 flex-wrap items-center gap-x-[8px] gap-y-[2px] text-[12px] text-muted"
      data-testid={testid}
    >
      {issueTriggers.map((trigger) => (
        <span key={trigger.id} className="flex items-center gap-[5px]">
          <GithubIcon size={14} strokeWidth={2} aria-hidden className="shrink-0" />
          <span className={trigger.enabled ? "" : "line-through opacity-70"}>
            {issueTriggerSentence(trigger)}
          </span>
        </span>
      ))}
      {schedules.map((schedule) => (
        <span key={schedule.id} className="flex items-center gap-[5px]">
          <Clock size={14} strokeWidth={2} aria-hidden className="shrink-0" />
          <span className={schedule.enabled ? "" : "line-through opacity-70"}>
            {scheduleSentence(schedule)}
          </span>
        </span>
      ))}
    </span>
  );
}

/** The issue sentence, 13/600 in the box; labels render as mono chips. */
function issueTriggerSentence(trigger: IssueTrigger): string {
  return trigger.event === "opened" ? "An issue is opened" : "An issue is labeled";
}

/** The schedule's sentence: the plain-English reading of its own cron — the
 * raw expression stays in the mono detail line beneath it. */
function scheduleSentence(schedule: Schedule): string {
  const raw = schedule.cron_expr.trim();
  const words = cronInWords(raw).trim();
  return words === "" ? raw : words === raw ? raw : words;
}

/** The grid every trigger row uses: icon, the sentence over its mono detail
 * line, the bookkeeping column, the switch, the edit action. Below 900px the
 * five cells stack, so a 390px viewport never scrolls sideways. */
const TRIGGER_GRID =
  "grid grid-cols-1 items-center gap-x-[10px] gap-y-[4px] border-t border-line-soft px-3 py-[9px] min-[900px]:grid-cols-[18px_minmax(0,1fr)_160px_80px_40px]";

function ToggleSwitch({
  checked,
  testid,
  onChange,
}: {
  checked: boolean;
  testid: string;
  onChange: (next: boolean) => void;
}) {
  return (
    <span className="flex items-center gap-[6px]">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={checked ? "pause this trigger" : "turn this trigger on"}
        onClick={() => onChange(!checked)}
        className={`relative h-4 w-7 shrink-0 rounded-full border transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent ${
          checked ? "border-accent-edge bg-accent" : "border-line-strong bg-fill"
        }`}
        data-testid={testid}
      >
        <span
          aria-hidden="true"
          className={`absolute top-[2px] h-3 w-3 rounded-full bg-surface ${
            checked ? "left-[14px]" : "left-[2px]"
          }`}
        />
      </button>
      <span className="font-mono text-[11px] text-ink" data-testid={`${testid}-state`}>
        {checked ? "on" : "paused"}
      </span>
    </span>
  );
}

interface RepoScheduleRowProps {
  projectId: string;
  schedule: Schedule;
  canManage: boolean;
  onEdit: () => void;
}

function RepoScheduleRow({ projectId, schedule, canManage, onEdit }: RepoScheduleRowProps) {
  const patch = usePatchSchedule(projectId);
  const inputs = Object.entries(schedule.inputs ?? {});
  return (
    <div className={TRIGGER_GRID} data-testid={`repo-workflow-trigger-${testidOf(schedule.id)}`}>
      <Clock size={14} strokeWidth={2} aria-hidden className="shrink-0 text-ink-2" />
      <span className="min-w-0">
        <span className="block text-[13px] font-semibold text-ink">
          {scheduleSentence(schedule)}
        </span>
        <span
          className="block truncate font-mono text-[10.5px] text-muted"
          data-testid={`repo-workflow-trigger-detail-${testidOf(schedule.id)}`}
        >
          {schedule.cron_expr}
          {inputs.length > 0
            ? ` · ${inputs.map(([name, value]) => `${name}: ${formatInputValue(value)}`).join(" · ")}`
            : ""}
        </span>
      </span>
      <span
        className="font-mono text-[10.5px] text-muted"
        data-testid={`repo-workflow-trigger-meta-${testidOf(schedule.id)}`}
      >
        {scheduleNextText(schedule)}
        {schedule.last_run_id ? (
          <>
            {" · "}
            <Link
              to={routes.run(schedule.last_run_id)}
              className="text-accent-text hover:underline"
            >
              last {shortId(schedule.last_run_id)}
            </Link>
          </>
        ) : null}
      </span>
      {canManage ? (
        <ToggleSwitch
          checked={schedule.enabled}
          testid={`repo-workflow-trigger-enabled-${testidOf(schedule.id)}`}
          onChange={(next) =>
            patch.mutate({
              scheduleId: schedule.id,
              body: { version: schedule.version, enabled: next },
            })
          }
        />
      ) : (
        <StatusChip
          state={schedule.enabled ? "info" : "interrupted"}
          label={schedule.enabled ? "on" : "paused"}
          labelProps={{ "data-testid": `repo-workflow-trigger-state-${testidOf(schedule.id)}` }}
        />
      )}
      {canManage ? (
        <span className="min-[900px]:text-right">
          <Button
            variant="secondary"
            compact
            onClick={onEdit}
            data-testid={`repo-workflow-trigger-edit-${testidOf(schedule.id)}`}
          >
            Edit
          </Button>
        </span>
      ) : null}
      {patch.isError ? (
        <p
          role="alert"
          className="font-mono text-[11px] text-st-failed-pale-fg min-[900px]:col-span-5"
          data-testid={`repo-workflow-trigger-error-${testidOf(schedule.id)}`}
        >
          {patchErrorText(patch.error)}
        </p>
      ) : null}
    </div>
  );
}

interface RepoIssueRowProps {
  projectId: string;
  /** The repository page's own repository — the watched repo when the
   * repository list has not arrived yet (or never will, for a foreign id). */
  thisRepository: Repository;
  trigger: IssueTrigger;
  repositoryNames: RepositoryList | undefined;
  canManage: boolean;
  onEdit: () => void;
}

function RepoIssueRow({
  projectId,
  thisRepository,
  trigger,
  repositoryNames,
  canManage,
  onEdit,
}: RepoIssueRowProps) {
  const patch = usePatchIssueTrigger(projectId);
  const watched =
    repositoryNames?.items.find((candidate) => candidate.id === trigger.repository_id) ??
    (trigger.repository_id === thisRepository.id ? thisRepository : null);
  const repoRef = watched ? repoRefOf(watched) : "repository unavailable";
  return (
    <div className={TRIGGER_GRID} data-testid={`repo-workflow-trigger-${testidOf(trigger.id)}`}>
      <GithubIcon size={14} strokeWidth={2} aria-hidden className="shrink-0 text-ink-2" />
      <span className="min-w-0">
        <span className="flex flex-wrap items-center gap-[6px] text-[13px] font-semibold text-ink">
          {issueTriggerSentence(trigger)}
          {trigger.labels.length > 0 ? (
            trigger.labels.map((label) => (
              <span
                key={label}
                className="rounded-[3px] border border-line bg-fill px-[5px] py-[1px] font-mono text-[11px] font-medium text-ink-2"
                data-testid={`repo-workflow-trigger-label-${testidOf(trigger.id)}`}
              >
                {label}
              </span>
            ))
          ) : (
            <span className="font-normal text-muted">— any issue</span>
          )}
        </span>
        <span
          className="block truncate font-mono text-[10.5px] text-muted"
          data-testid={`repo-workflow-trigger-detail-${testidOf(trigger.id)}`}
        >
          {repoRef} · checked every minute
        </span>
      </span>
      <span
        className="font-mono text-[10.5px] text-muted"
        data-testid={`repo-workflow-trigger-meta-${testidOf(trigger.id)}`}
      >
        {trigger.last_polled_at
          ? `polled ${formatAge(trigger.last_polled_at)} ago`
          : "never polled"}
      </span>
      {canManage ? (
        <ToggleSwitch
          checked={trigger.enabled}
          testid={`repo-workflow-trigger-enabled-${testidOf(trigger.id)}`}
          onChange={(next) =>
            patch.mutate({
              issueTriggerId: trigger.id,
              body: { version: trigger.version, enabled: next },
            })
          }
        />
      ) : (
        <StatusChip
          state={trigger.enabled ? "info" : "interrupted"}
          label={trigger.enabled ? "on" : "paused"}
          labelProps={{ "data-testid": `repo-workflow-trigger-state-${testidOf(trigger.id)}` }}
        />
      )}
      {canManage ? (
        <span className="min-[900px]:text-right">
          <Button
            variant="secondary"
            compact
            onClick={onEdit}
            data-testid={`repo-workflow-trigger-edit-${testidOf(trigger.id)}`}
          >
            Edit
          </Button>
        </span>
      ) : null}
      {trigger.last_error ? (
        <p
          role="alert"
          className="font-mono text-[11px] text-st-failed-pale-fg min-[900px]:col-span-5"
          data-testid={`repo-workflow-trigger-last-error-${testidOf(trigger.id)}`}
        >
          <span aria-hidden="true">×</span> {trigger.last_error}
        </p>
      ) : null}
      {patch.isError ? (
        <p
          role="alert"
          className="font-mono text-[11px] text-st-failed-pale-fg min-[900px]:col-span-5"
          data-testid={`repo-workflow-trigger-error-${testidOf(trigger.id)}`}
        >
          {patchErrorText(patch.error)}
        </p>
      ) : null}
    </div>
  );
}

/** The next fire in the one form that is true for the schedule's state. A
 * paused schedule keeps its `next_run_at` (ADR-0032 never backfills), so the
 * line says `paused` instead of promising a countdown. */
function scheduleNextText(schedule: Schedule, now = Date.now()): string {
  if (!schedule.enabled) return "paused";
  const remaining = formatRemaining(schedule.next_run_at, now);
  if (remaining === "passed") return `due now · ${formatClock(schedule.next_run_at)}`;
  if (remaining === "unknown") return `unknown · ${formatClock(schedule.next_run_at)}`;
  return `next ${remaining}`;
}

/** A schedule's fixed input value, short enough to live on the mono line. */
function formatInputValue(value: unknown): string {
  if (typeof value === "string") {
    const flat = value.replace(/\s+/g, " ").trim();
    return flat.length > 24 ? `“${flat.slice(0, 24)}…”` : `“${flat}”`;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "…";
}

/* ------------------------------------------------------- library picker */

interface RepoLibraryPickerProps {
  open: boolean;
  onClose: () => void;
  projectId: string;
  repository: Repository;
  /** Pipelines this repo already uses (the row says `used here`, and the
   * server would answer `409` for the same pair anyway). */
  usedHere: ReadonlySet<string>;
}

/**
 * `+ use a library workflow`: pick one workflow of the org library and the
 * dialog creates the assignment for THIS project with `repository_id` = this
 * repo, pinned to that workflow's latest published revision (the
 * digest→uuid resolve route 13 supplies, then the one `POST /assignments`).
 * A refusal — the `409` "already assigned", a `404` revision — stays inline.
 */
function RepoLibraryPicker({
  open,
  onClose,
  projectId,
  repository,
  usedHere,
}: RepoLibraryPickerProps) {
  if (!open) return null;
  return (
    <RepoLibraryPickerBody
      onClose={onClose}
      projectId={projectId}
      repository={repository}
      usedHere={usedHere}
    />
  );
}

interface RepoLibraryPickerBodyProps {
  onClose: () => void;
  projectId: string;
  repository: Repository;
  usedHere: ReadonlySet<string>;
}

function RepoLibraryPickerBody({
  onClose,
  projectId,
  repository,
  usedHere,
}: RepoLibraryPickerBodyProps) {
  const pipelines = usePipelines();
  const [picking, setPicking] = useState<PipelineSummary | null>(null);
  const [search, setSearch] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<Element | null>(null);

  const definition = usePipeline(picking?.id ?? "");
  const latest =
    definition.data?.revisions.find((revision) => revision.status === "published") ??
    definition.data?.revisions[0] ??
    null;
  const resolved = useRevision(latest?.revision_digest ?? "");
  const create = useCreateAssignment(projectId);
  const started = useRef<string | null>(null);

  // One click = one create: the revision resolve's arrival arms it, and the
  // guard keeps a re-render from firing a second POST.
  useEffect(() => {
    if (!picking || !resolved.data || create.isPending) return;
    const key = `${picking.id}:${resolved.data.id}`;
    if (started.current === key) return;
    started.current = key;
    create.mutate(
      {
        pipeline_id: picking.id,
        pinned_revision_id: resolved.data.id,
        max_concurrent_runs: 1,
        repository_id: repository.id,
      },
      { onSuccess: () => onClose() },
    );
  }, [picking, resolved.data, create, repository.id, onClose]);

  useLayoutEffect(() => {
    openerRef.current = document.activeElement;
    containerRef.current?.querySelector<HTMLElement>("input, button")?.focus();
    return () => {
      const opener = openerRef.current;
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const container = containerRef.current;
      if (!container) return;
      const focusables = Array.from(
        container.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !container.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const query = search.trim().toLowerCase();
  const items = (pipelines.data?.pipelines ?? []).filter(
    (pipeline) =>
      !pipeline.archived &&
      (query === "" ||
        pipeline.slug.toLowerCase().includes(query) ||
        pipeline.display_name.toLowerCase().includes(query)),
  );

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-ink/25 p-4">
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="repo-library-title"
        className="w-[520px] max-w-full rounded-[4px] border border-ink bg-surface shadow-(--shadow-raised)"
        data-testid="repo-library-dialog"
      >
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 id="repo-library-title" className="text-[15px] font-semibold">
              Use a library workflow
            </h2>
            <span
              className="block truncate font-mono text-[10.5px] text-muted"
              data-testid="repo-library-context"
            >
              {`pinned to the latest revision · this assignment runs in ${repository.name}`}
            </span>
          </div>
          <span aria-hidden="true" className="font-mono text-[11px] text-faint">
            esc
          </span>
        </div>
        <div className="flex max-h-[calc(100vh-12rem)] flex-col gap-[10px] overflow-y-auto px-4 py-4">
          <Field id="repo-library-search" label="SEARCH">
            <Input
              id="repo-library-search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="filter the library…"
              data-testid="repo-library-search"
            />
          </Field>
          {pipelines.isPending ? <Spinner label="Loading the library" /> : null}
          {pipelines.isError ? (
            <ProblemBanner
              error={pipelines.error}
              fallback="The workflow library could not be read."
            />
          ) : null}
          {!pipelines.isPending && !pipelines.isError && items.length === 0 ? (
            <p className="text-[12.5px] text-muted" data-testid="repo-library-empty">
              The library has no workflow to use here.
            </p>
          ) : null}
          <ul className="divide-y divide-line" data-testid="repo-library-list">
            {items.map((pipeline) => (
              <li
                key={pipeline.id}
                className="flex items-center gap-3 py-[8px]"
                data-testid={`repo-library-row-${pipeline.slug}`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-semibold">
                    {pipeline.display_name || pipeline.slug}
                  </span>
                  <span className="block font-mono text-[10.5px] text-muted">
                    {pipeline.slug} · latest r{pipeline.latest_revision_number}
                  </span>
                </span>
                {usedHere.has(pipeline.id) ? (
                  <span
                    className="font-mono text-[10.5px] text-muted"
                    data-testid={`repo-library-used-${pipeline.slug}`}
                  >
                    used here
                  </span>
                ) : (
                  <Button
                    variant="secondary"
                    compact
                    disabled={picking !== null}
                    onClick={() => setPicking(pipeline)}
                    data-testid={`repo-library-use-${pipeline.slug}`}
                  >
                    Use
                  </Button>
                )}
              </li>
            ))}
          </ul>
          {definition.isPending && picking ? <Spinner label={`Reading ${picking.slug}`} /> : null}
          {definition.isError && picking ? (
            <ProblemBanner error={definition.error} fallback="That workflow could not be read." />
          ) : null}
          {create.isError ? <FormError error={create.error} testid="repo-library-error" /> : null}
          <div className="flex justify-end gap-2 border-t border-line pt-3">
            <Button variant="secondary" onClick={onClose} data-testid="repo-library-cancel">
              Cancel
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
