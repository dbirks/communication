/**
 * `WORKFLOWS IN THIS PROJECT · n` — the project Workflows tab's one panel
 * (design 1b, trigger rows per 2e; pass review of `project-1b-workflows`).
 *
 * The review's defect was that the tab dumped legacy panels onto the page: a
 * library list, a YAML dump, a definition graph, a validate note and raw
 * digest/uuid strings everywhere. All of that lives on surfaces built for it —
 * the library index (`/workflows`), a workflow's own page (its YAML tab and
 * Studio carry the pinned document and the graph, and every row name here is
 * the link to it) and the repository page (2e's trigger authoring). What the
 * tab *owns*, per the handoff, is the cross-repo view: "triggers are created
 * and edited on the repo page (and listed on the project's Workflows tab
 * across all its repos)".
 *
 * So this is ONE panel, one row per workflow the project uses, in 2e's row
 * shape — chevron, name, `✓ rN` chip, trigger summary ("started by hand" or
 * icon + sentence per trigger), the pinned revision's step chain, and the
 * repository scope (`all repos` for a whole-project pin, else the repo's
 * name). Each row opens on the SAME `STARTS WHEN` treatment the repo page
 * uses: the rows are `RepoScheduleRow`/`RepoIssueRow` from
 * `components/workflows/RepoWorkflows` — shared so the switch, the detail
 * line and the PATCH live in exactly one place — listing the workflow's
 * triggers across every repository of the project. `+ Add trigger` opens the
 * same 2c dialog (`TriggerDialog`).
 *
 * The 2c dialog is repo-anchored by design (the project and the repo come
 * from where it was opened, so it has no selects for them). From a
 * whole-project row the repo is not given: a one-repository project opens it
 * for that repository; a multi-repository project picks the repository in the
 * box header first, so the dialog always says which repo the trigger is for.
 *
 * Honesty rules inherited from the repo page:
 * - Nothing renders before its read: the count, the chip, the chain and the
 *   summary wait for their own responses; a failed trigger read says
 *   `triggers unavailable` rather than claiming the workflow is hand-started.
 * - A revision number is the server's own `revision_number`, never a digest
 *   dressed as a number; no uuid or digest fragment appears on this tab.
 * - The pinned revision's document is a link away (the workflow page), not a
 *   second copy here.
 */
import { useState } from "react";
import { Link } from "react-router";
import { useQueries } from "@tanstack/react-query";
import { Play } from "lucide-react";
import { Panel } from "../../ds/Panel";
import { StatusChip } from "../../ds/Row";
import { ProblemBanner, Spinner } from "../../Feedback";
import {
  pipelineQueryOptions,
  revisionQueryOptions,
  useAssignments,
  useSchedules,
  type Schedule,
} from "../../../api/pipelines";
import { useIssueTriggers, type IssueTrigger } from "../../../api/useIssueTriggers";
import { useRepositories } from "../../../api/queries";
import type { Assignment, Project, Repository, RepositoryList } from "../../../api/types";
import { testidOf } from "../../../lib/format";
import { routes } from "../../../lib/routes";
import { isDefinitionDocument } from "../../../lib/pipeline/definition";
import { stepChain } from "../../workflows/WorkflowRow";
import { RepoIssueRow, RepoScheduleRow, TriggerSummary } from "../../workflows/RepoWorkflows";
import { TriggerDialog, type TriggerEditing } from "../../workflows/TriggerDialog";
import { ProjectUnavailable, projectAccessRefused } from "../../ProjectUnavailable";
import { UseWorkflowDialog } from "./UseWorkflowDialog";

export interface ProjectWorkflowsPanelProps {
  projectId: string;
  /** The project the tab is about: `my_role` decides who may write. */
  project: Project;
}

/** One row's worth of truth: the assignment plus everything its own reads
 * returned for it — the same shape `RepoWorkflows` builds, minus the
 * repository-page assumptions (the scope and the trigger repos are the whole
 * project's here). */
interface ProjectWorkflowRowData {
  assignment: Assignment;
  name: string | null;
  revisionNumber: number | null;
  chain: ReturnType<typeof stepChain> | null;
  schedules: Schedule[];
  issueTriggers: IssueTrigger[];
}

export function ProjectWorkflowsPanel({ projectId, project }: ProjectWorkflowsPanelProps) {
  const assignments = useAssignments(projectId);
  const schedules = useSchedules(projectId);
  const issueTriggers = useIssueTriggers(projectId);
  const repositories = useRepositories(projectId);

  const canManage = project.my_role === "maintainer";
  // 2e item 7: the row opens on its STARTS WHEN box — the triggers are why
  // the tab exists. The chevron collapses it for a reader who wants a list.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [pickerOpen, setPickerOpen] = useState(false);
  const [dialog, setDialog] = useState<{
    assignment: Assignment;
    workflowLabel: string;
    repository: Repository;
    editing: TriggerEditing | null;
  } | null>(null);
  // For a whole-project row: which repository the 2c dialog opens for (only
  // asked when the project has more than one — the dialog names the repo in
  // its context line and the issue arm watches exactly that repository).
  const [repoChoice, setRepoChoice] = useState<Record<string, string>>({});

  const rows: ProjectWorkflowRowData[] = (assignments.data?.assignments ?? []).map(
    (assignment) => ({
      assignment,
      name: null,
      revisionNumber: null,
      chain: null,
      schedules: (schedules.data?.schedules ?? []).filter(
        (schedule) => schedule.assignment_id === assignment.id,
      ),
      issueTriggers: (issueTriggers.data?.issue_triggers ?? []).filter(
        (trigger) => trigger.assignment_id === assignment.id,
      ),
    }),
  );

  // Two small fans, keyed exactly like the single-read hooks (as the repo page
  // does, so the cache is shared): the pipeline read names the row, the pinned
  // revision read carries its number and its step chain.
  const definitionFan = useQueries({
    queries: rows.map((row) => pipelineQueryOptions(row.assignment.pipeline_id)),
  });
  const revisionFan = useQueries({
    queries: rows.map((row) => revisionQueryOptions(row.assignment.pinned_revision_digest)),
  });
  rows.forEach((row, index) => {
    const definition = definitionFan[index]?.data;
    const revision = revisionFan[index]?.data;
    row.name = definition ? definition.display_name || definition.slug : null;
    row.revisionNumber = revision?.revision_number ?? null;
    const document =
      revision && isDefinitionDocument(revision.canonical_document)
        ? revision.canonical_document
        : null;
    row.chain = document ? stepChain(document) : null;
  });

  // A trigger read that has not arrived is not "no triggers", and a FAILED
  // one is not "started by hand" — the row says what it can actually tell.
  const triggerReadsReady = !schedules.isPending && !issueTriggers.isPending;
  const triggerReadsFailed = schedules.isError || issueTriggers.isError;

  // The assignments read is the tab's own. When it is refused, the rows below
  // would confirm more than the API chose to say, so the section says the
  // project's one sentence instead (the page's heading ids stay the tab's).
  if (projectAccessRefused(assignments.error)) {
    return (
      <ProjectUnavailable
        heading="Workflows"
        headingId="project-pipelines-heading"
        testid="project-pipelines-not-found"
        hint="The project's other tabs stay open — the workflows it uses are listed on none of them."
      />
    );
  }

  const items = repositories.data?.items ?? [];

  /** The repository the 2c dialog opens for. A repo-pinned row uses its own
   * repository (the list entry when it resolved, the row's own fields when
   * the list has not — it never guesses another repo's name). A whole-project
   * row uses the header pick, defaulting to the project's first repository;
   * with no repositories at all there is nothing to open it for, and the box
   * says so instead of the button. */
  function repositoryFor(assignment: Assignment): Repository | null {
    if (assignment.repository_id) {
      return (
        items.find((item) => item.id === assignment.repository_id) ??
        syntheticRepository(assignment.repository_id, assignment.repository_name, projectId)
      );
    }
    if (items.length === 0) return null;
    return items.find((item) => item.id === repoChoice[assignment.id]) ?? items[0];
  }

  function openAdd(assignment: Assignment, workflowLabel: string) {
    const repository = repositoryFor(assignment);
    if (!repository) return;
    setDialog({ assignment, workflowLabel, repository, editing: null });
  }

  function openEdit(assignment: Assignment, workflowLabel: string, editing: TriggerEditing) {
    const repository =
      editing.kind === "issue"
        ? (items.find((item) => item.id === editing.trigger.repository_id) ??
          syntheticRepository(editing.trigger.repository_id, "repository unavailable", projectId))
        : (repositoryFor(assignment) ??
          syntheticRepository("no-repository", "no repository yet", projectId));
    setDialog({ assignment, workflowLabel, repository, editing });
  }

  return (
    <>
      <Panel
        id="project-workflows-page"
        title={
          assignments.data
            ? `WORKFLOWS IN THIS PROJECT · ${assignments.data.assignments.length}`
            : "WORKFLOWS IN THIS PROJECT"
        }
        headingId="project-workflows-page-heading"
        headingLevel={2}
        meta={
          canManage ? (
            // One line at any width (the Repositories `+ add` / YamlView
            // `Copy · download` treatment, 390): below 560px the shell's phone
            // floor (tokens.css `APP-SHELL-PHONE`) makes every `main button`
            // 44px tall, and this bar grew to twice its siblings (53px against
            // the other panels' 23px). The wrapper holds the bar's line box and
            // clips the floor's growth, so the opener sits in the header exactly
            // like every other panel's meta slot; it stays a real button, keeps
            // its 44px box (only the bar's line shows) and its name.
            <span className="flex h-[14px] items-center overflow-hidden min-[560px]:h-auto min-[560px]:overflow-visible">
              <button
                type="button"
                onClick={() => setPickerOpen(true)}
                className="font-mono text-[10.5px] normal-case text-accent-text hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
                data-testid="project-workflow-library"
              >
                {/* One line at any width, same as the repo page: the full
                    honest label from 560px up, a shorter (still honest — it
                    opens the same library) one below it. */}
                <span className="hidden min-[560px]:inline">+ use a library workflow</span>
                <span className="min-[560px]:hidden">+ use workflow</span>
              </button>
            </span>
          ) : undefined
        }
      >
        <div className="space-y-[6px] p-[10px]" data-testid="project-workflows">
          {assignments.isPending ? <Spinner label="Loading workflows" /> : null}
          {assignments.isError && !projectAccessRefused(assignments.error) ? (
            <ProblemBanner
              error={assignments.error}
              fallback="The project's assignments could not be read."
              subject="the workflows in this project"
              retry={{
                onClick: () => void assignments.refetch(),
                pending: assignments.isFetching,
                testid: "project-workflows-retry",
              }}
            />
          ) : null}
          {assignments.data && rows.length === 0 ? (
            <p className="text-[12.5px] text-muted" data-testid="project-workflows-empty">
              No workflows are used in this project yet
              {canManage ? " — use a library workflow to give it one." : "."}
            </p>
          ) : null}
          {/* The rows are <li>s and must live in a list element (axe listitem
              rule); the panel-level states stay siblings of the <ul>. */}
          <ul className="space-y-[6px]" data-testid="project-workflows-list">
            {rows.map((row) => (
              <ProjectWorkflowRow
                key={row.assignment.id}
                projectId={projectId}
                data={row}
                repositoryNames={repositories.data}
                canManage={canManage}
                triggerReadsReady={triggerReadsReady}
                triggerReadsFailed={triggerReadsFailed}
                repositoriesRead={
                  repositories.isPending ? "pending" : repositories.isError ? "error" : "ready"
                }
                repoChoice={repoChoice[row.assignment.id] ?? items[0]?.id ?? null}
                onRepoChoice={(repositoryId) =>
                  setRepoChoice((current) => ({
                    ...current,
                    [row.assignment.id]: repositoryId,
                  }))
                }
                open={expanded[row.assignment.id] ?? true}
                onToggle={() =>
                  setExpanded((current) => ({
                    ...current,
                    // `?? true` — the default the row renders with: the
                    // chevron on an open row CLOSES it.
                    [row.assignment.id]: !(current[row.assignment.id] ?? true),
                  }))
                }
                onAddTrigger={() => openAdd(row.assignment, row.name ?? "this workflow")}
                onEdit={(editing) => openEdit(row.assignment, row.name ?? "this workflow", editing)}
              />
            ))}
          </ul>
        </div>
      </Panel>
      <UseWorkflowDialog
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        projectId={projectId}
        projectName={project.name}
      />
      {dialog ? (
        <TriggerDialog
          open
          onClose={() => setDialog(null)}
          project={{ id: projectId, name: project.name }}
          repository={dialog.repository}
          assignment={dialog.assignment}
          workflowLabel={dialog.workflowLabel}
          editing={dialog.editing}
        />
      ) : null}
    </>
  );
}

/** A `Repository` shape for a dialog that must name a repository the list
 * could not resolve. It carries the real id and the honest word for the
 * name — never another repository's identity. */
function syntheticRepository(
  id: string,
  name: string | null | undefined,
  projectId: string,
): Repository {
  return {
    id,
    project_id: projectId,
    name: name || "repository unavailable",
    git_url: "",
    default_branch: "",
    created_at: "",
  };
}

interface ProjectWorkflowRowProps {
  projectId: string;
  data: ProjectWorkflowRowData;
  repositoryNames: RepositoryList | undefined;
  canManage: boolean;
  triggerReadsReady: boolean;
  triggerReadsFailed: boolean;
  /** State of the project's repository read — what decides whether the row
   * may offer `+ Add trigger` (the 2c dialog is repo-anchored) or must say
   * why it cannot. */
  repositoriesRead: "pending" | "error" | "ready";
  /** The repository the whole-project row's dialog opens for (ignored by a
   * repo-pinned row, which always speaks for its own repository). */
  repoChoice: string | null;
  onRepoChoice(repositoryId: string): void;
  open: boolean;
  onToggle: () => void;
  onAddTrigger: () => void;
  onEdit: (editing: TriggerEditing) => void;
}

function ProjectWorkflowRow({
  projectId,
  data,
  repositoryNames,
  canManage,
  triggerReadsReady,
  triggerReadsFailed,
  repositoriesRead,
  repoChoice,
  onRepoChoice,
  open,
  onToggle,
  onAddTrigger,
  onEdit,
}: ProjectWorkflowRowProps) {
  const { assignment } = data;
  const key = testidOf(assignment.id);
  const wholeProject = !assignment.repository_id;
  const scope = assignment.repository_name ?? "all repos";
  // One fact, one place: the scope chip already names the repository on the
  // row, so the header only offers the pick when several repositories could
  // answer (a whole-project row of a one-repository project needs no asking).
  const offeredRepos = (repositoryNames?.items ?? []).map((item) => ({
    id: item.id,
    name: item.name,
  }));
  const needsRepoChoice = canManage && wholeProject && offeredRepos.length > 1;
  const addBlocked =
    wholeProject && (repositoriesRead === "pending" || repositoriesRead === "error");
  const noRepositories = wholeProject && repositoriesRead === "ready" && offeredRepos.length === 0;

  return (
    <li
      className="border-b border-line pb-[6px] last:border-b-0"
      data-testid={`project-workflow-row-${key}`}
    >
      <div className="grid grid-cols-1 items-center gap-x-4 gap-y-[6px] min-[900px]:grid-cols-[minmax(0,1fr)_auto]">
        <div className="min-w-0 space-y-[5px]">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <button
              type="button"
              aria-expanded={open}
              aria-label={open ? "Collapse triggers" : "Expand triggers"}
              onClick={onToggle}
              className="icon-hit shrink-0 rounded-[3px] text-ink-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
              data-testid={`project-workflow-toggle-${key}`}
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
                data-testid={`project-workflow-name-${key}`}
              >
                {data.name}
              </Link>
            ) : (
              <span
                className="font-mono text-[10.5px] text-muted"
                data-testid={`project-workflow-name-${key}`}
              >
                · loading
              </span>
            )}
            {data.revisionNumber !== null ? (
              <StatusChip
                state="done"
                label={`r${data.revisionNumber}`}
                labelProps={{ "data-testid": `project-workflow-revision-${key}` }}
              />
            ) : (
              <span
                className="font-mono text-[10px] text-muted"
                data-testid={`project-workflow-revision-${key}`}
              >
                · loading
              </span>
            )}
            {triggerReadsReady ? (
              <TriggerSummary
                schedules={data.schedules}
                issueTriggers={data.issueTriggers}
                failed={triggerReadsFailed}
                testid={`project-workflow-summary-${key}`}
              />
            ) : (
              <span
                className="font-mono text-[10px] text-muted"
                data-testid={`project-workflow-summary-${key}`}
              >
                · loading
              </span>
            )}
            {!assignment.enabled ? (
              <StatusChip
                state="interrupted"
                label="paused"
                className="h-[15px]"
                labelProps={{ "data-testid": `project-workflow-enabled-${key}` }}
              />
            ) : null}
            {/* Where this use runs, in the product's words — the row's scope,
                not a repository uuid. */}
            <span
              className="rounded-[3px] border border-line bg-fill px-[5px] py-[1px] font-mono text-[10px] text-muted"
              data-testid={`project-workflow-scope-${key}`}
            >
              {scope}
            </span>
          </div>
          <div
            className="flex min-w-0 flex-wrap items-center gap-x-[6px] gap-y-[4px] pl-[22px]"
            data-testid={`project-workflow-chain-${key}`}
          >
            {data.chain === null ? (
              <span className="font-mono text-[10.5px] text-muted">…</span>
            ) : data.chain.length === 0 ? (
              <span className="font-mono text-[10.5px] text-muted">—</span>
            ) : (
              data.chain.map((cell, index) => (
                <span key={index} className="flex items-baseline gap-[6px]">
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
                    data-testid={`project-workflow-chain-${key}-${index}`}
                  >
                    {cell.label}
                  </span>
                </span>
              ))
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 min-[900px]:justify-end">
          {/* 2e items 6 + 8 applied to the tab: ONE `+ Add trigger`, in the
              STARTS WHEN header while the box is open and in the row's own
              actions only while it is closed; no `Run` here (starting a run
              is the Runs tab's verb), no `Edit` (the name is the link). */}
          {canManage && !open && !noRepositories ? (
            <button
              type="button"
              onClick={onAddTrigger}
              disabled={addBlocked}
              className="text-[12.5px] font-semibold text-accent-text hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:text-faint disabled:no-underline"
              data-testid={`project-workflow-add-${key}`}
            >
              + Add trigger
            </button>
          ) : null}
        </div>
      </div>

      {open ? (
        <div
          className="mb-[6px] ml-[34px] mt-[10px] overflow-hidden rounded-[3px] border border-line-strong"
          data-testid={`project-workflow-starts-${key}`}
        >
          <div className="flex flex-wrap items-center gap-2 border-b border-accent-ring bg-accent-wash px-3 py-[6px] font-mono text-[10px] font-semibold uppercase tracking-[.04em] text-accent-text">
            <span>STARTS WHEN</span>
            {needsRepoChoice ? (
              /* The 2c dialog fixes its repository (by design). From a
                 whole-project row of a multi-repository project, the row asks
                 which one it should speak for. */
              <label className="ml-auto flex items-center gap-[6px] font-ui text-[11.5px] font-normal normal-case tracking-normal text-ink-2">
                for repo
                <select
                  value={repoChoice ?? undefined}
                  onChange={(event) => onRepoChoice(event.target.value)}
                  aria-label="repository the new trigger watches"
                  className="rounded-[3px] border border-line-strong bg-surface px-[6px] py-[1px] font-mono text-[11px] text-ink"
                  data-testid={`project-workflow-repo-choice-${key}`}
                >
                  {offeredRepos.map((repo) => (
                    <option key={repo.id} value={repo.id}>
                      {repo.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {canManage && open && !addBlocked && !noRepositories ? (
              <button
                type="button"
                onClick={onAddTrigger}
                className={`font-ui text-[12px] font-semibold normal-case tracking-normal text-accent-text hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent ${
                  needsRepoChoice ? "" : "ml-auto"
                }`}
                data-testid={`project-workflow-add-${key}`}
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
              trigger={trigger}
              repositoryNames={repositoryNames}
              canManage={canManage}
              onEdit={() => onEdit({ kind: "issue", trigger })}
            />
          ))}
          {!triggerReadsReady ? (
            <p
              className="px-3 py-[9px] font-mono text-[11px] text-muted"
              data-testid={`project-workflow-loading-${key}`}
            >
              Reading this workflow's triggers…
            </p>
          ) : triggerReadsFailed ? (
            <p
              role="alert"
              className="px-3 py-[9px] font-mono text-[11px] text-st-failed-pale-fg"
              data-testid={`project-workflow-triggers-unavailable-${key}`}
            >
              The trigger list could not be read — this row does not claim the workflow is
              hand-started.
            </p>
          ) : data.schedules.length === 0 && data.issueTriggers.length === 0 ? (
            <p
              className="px-3 py-[9px] font-mono text-[11px] text-muted"
              data-testid={`project-workflow-none-${key}`}
            >
              Never triggered — every run of this workflow was started by a person.
            </p>
          ) : null}
          {wholeProject && canManage && repositoriesRead === "error" ? (
            <p
              role="alert"
              className="px-3 py-[9px] font-mono text-[11px] text-st-failed-pale-fg"
              data-testid={`project-workflow-add-repos-unreadable-${key}`}
            >
              The project's repositories could not be read — adding a trigger needs one.
            </p>
          ) : null}
          {noRepositories ? (
            <p
              className="px-3 py-[9px] font-mono text-[11px] text-muted"
              data-testid={`project-workflow-add-needs-repo-${key}`}
            >
              Triggers are set up for a repository — add one to this project first.
            </p>
          ) : null}
          <div className="flex items-center gap-[10px] border-t border-line-soft px-3 py-[9px] text-[12px] text-muted">
            <Play size={14} strokeWidth={2} aria-hidden className="shrink-0 opacity-60" />
            <span>Or start it by hand from the project's Runs tab.</span>
          </div>
        </div>
      ) : null}
    </li>
  );
}
