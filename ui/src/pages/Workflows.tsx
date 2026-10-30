/**
 * The org **Workflows** index (`/workflows`) — design 1b:
 * - Header: H1 `Workflows` + the mono count the list read carries,
 *   `Import YAML` (secondary) + `New workflow` (primary).
 * - Three starter cards above the filters: `START BLANK` (dashed border)
 *   and one card per vetted template, each showing the canvas step count
 *   the Studio will draw and the document's own top-level step chain.
 *   Clicking a card opens the New workflow dialog (1c) with that starter
 *   preselected.
 * - Filters: a 240px search field + chips `all` / `has open draft` /
 *   `used in <project>` — one chip per project whose assignments fan
 *   actually pins an indexed workflow; real data only, so the chips wait
 *   for the fan to settle.
 * - Folder groups (ADR-0049 § 8): each folder a panel whose header holds an
 *   SVG chevron, the name in mono caps and the group's own count; the rows
 *   keep the `220px 1fr 180px 120px` grid (`WorkflowRow`). Unfiled rows
 *   render below the folder panels without a header.
 *
 * The 1a inline `NEW PIPELINE` form and the bottom `STARTER WORKFLOWS`
 * panel are gone: creation lives in `NewWorkflowDialog` (1c), which runs
 * the same two writes the inline form ran (pipeline first, draft second —
 * ADR-0002's logical create, then its first draft) and lands on the
 * Studio route.
 *
 * Honesty rules (gaps/library.md § 5), unchanged from the old page:
 * - A row is built from the same two reads the project page fans
 *   (`GET /pipelines/{id}` + its drafts list); nothing is invented beyond
 *   what the wire serves.
 * - The revision chip is the server's own `latest` summary — `✓ r{n}`
 *   (the digest moved to the workflow page) or `· draft · not published`.
 * - Duplicate is the client-side three writes the gap analysis settles on
 *   (U1) until a backend endpoint exists.
 * - Authoring controls (`New workflow`, the cards, import, duplicate)
 *   appear only for the library role: `01` gives definition-reading to
 *   every org member and publishing to org admins alone. Read-only users
 *   still see the cards, disabled, with the one-line reason.
 */
import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useQueries } from "@tanstack/react-query";
import { Button } from "../components/ds/Button";
import { Input } from "../components/ds/Field";
import { ProblemBanner, Spinner } from "../components/Feedback";
import { apiFetch } from "../api/client";
import { queryKeys, useMe, useProjects } from "../api/queries";
import {
  pipelineDraftsQueryOptions,
  pipelineQueryOptions,
  revisionQueryOptions,
  schedulesQueryOptions,
  useDuplicatePipeline,
  usePipelines,
  UNFILED_FOLDER,
  distinctFolders,
  folderLabel,
  workflowRowFacts,
} from "../api/pipelines";
import type { AssignmentList, Draft, PipelineSummary } from "../api/types";
import { isDefinitionDocument } from "../lib/pipeline/definition";
import { routes } from "../lib/routes";
import { useLayoutPrefs } from "../lib/prefs";
import { WorkflowRow, MoveToFolderDialog } from "../components/workflows/WorkflowRow";
import { ImportYamlDialog } from "../components/workflows/ImportYamlDialog";
import { NewWorkflowDialog } from "../components/workflows/NewWorkflowDialog";
import { hasLibraryRole, LIBRARY_ROLE_LABEL } from "../lib/pipeline/authoring";
import { PIPELINE_TEMPLATES, templateChain, type TemplateId } from "../lib/pipeline/templates";

/* ------------------------------------------------------------- /workflows */

/** The filter chip: a pressed state a screen reader hears (`aria-pressed`)
 * and a keyboard can reach (the ds focus ring). */
function FilterChip({
  active,
  onClick,
  testid,
  children,
}: {
  active: boolean;
  onClick: () => void;
  testid: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={
        active
          ? "rounded-[3px] border border-ink bg-ink px-[8px] py-[3px] font-mono text-[10.5px] text-surface"
          : "rounded-[3px] border border-line bg-surface px-[8px] py-[3px] font-mono text-[10.5px] text-ink hover:border-line-strong"
      }
      data-testid={testid}
    >
      {children}
    </button>
  );
}

/**
 * One folder group: a panel whose header holds the SVG chevron (the
 * handoff's `M3 4.5l3 3 3-3` path — it rotates to point right when the
 * group is collapsed), the folder name in mono caps, and the group's own
 * count. The header is the collapse toggle.
 */
function FolderGroup({
  name,
  count,
  open,
  onToggle,
  children,
}: {
  name: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "folder";
  return (
    <section className="overflow-hidden rounded-[3px] border border-line-strong bg-surface">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex w-full items-center gap-[6px] border-b border-line-strong bg-fill px-[10px] py-[7px] font-mono text-[10px] font-semibold tracking-[.04em] uppercase text-ink-2 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent-ring"
        data-testid={`workflow-folder-header-${slug}`}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 12 12"
          aria-hidden="true"
          className={`shrink-0 ${open ? "" : "-rotate-90"}`}
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
        <span className="min-w-0 truncate">{name}</span>
        <span className="ml-auto shrink-0 font-normal text-faint">{count}</span>
      </button>
      {open ? <ul className="px-3">{children}</ul> : null}
    </section>
  );
}

export function LibraryPage() {
  const navigate = useNavigate();
  const me = useMe();
  const pipelines = usePipelines();
  const projects = useProjects();
  const canAuthor = hasLibraryRole(me.data);
  const { prefs } = useLayoutPrefs();
  // ADR-0049 § 8: grouping is a display preference; the `?folder=` param the
  // sidebar's folder links set is the page's source of truth for the filter.
  const showFolders = prefs.showWorkflowFolders;
  const [searchParams, setSearchParams] = useSearchParams();
  const folderFilter = searchParams.get("folder") ?? "";
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "has-draft">("all");
  const [usedInProject, setUsedInProject] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [newWorkflow, setNewWorkflow] = useState<{ open: boolean; preset: TemplateId | null }>({
    open: false,
    preset: null,
  });
  const [moveTarget, setMoveTarget] = useState<PipelineSummary | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const items = pipelines.data?.pipelines ?? [];
  const ids = items.map((pipeline) => pipeline.id);
  // One fan keyed exactly like the single-read hooks (as the project page does).
  const definitions = useQueries({ queries: ids.map(pipelineQueryOptions) });
  const draftsList = useQueries({ queries: ids.map(pipelineDraftsQueryOptions) });

  // The step chain needs the latest revision's canonical document: route 13
  // resolves a digest, so the fan keys on each row's newest summary digest.
  const latestDigests = items.map(
    (_pipeline, index) => definitions[index]?.data?.revisions[0]?.revision_digest ?? "",
  );
  const revisionFan = useQueries({ queries: latestDigests.map(revisionQueryOptions) });

  // Folders (ADR-0049 § 8): the wire's own `folder` values, grouped
  // client-side; a `null`/empty renders as the Unfiled group, last. The
  // counts are the list read's own rows — nothing is invented.

  // The assignments fan the rows share: every project the caller belongs to,
  // keyed exactly like the project page's reads so the cache is shared. The
  // schedules fan arms only for projects that actually pin an indexed
  // workflow — a `manual` trigger costs one assignments read, not two.
  const projectItems = projects.data?.items ?? [];
  const indexIds = new Set(ids);
  const assignmentsFan = useQueries({
    queries: projectItems.map((project) => ({
      queryKey: queryKeys.assignments(project.id),
      queryFn: () => apiFetch<AssignmentList>(`/api/v1/projects/${project.id}/assignments`),
    })),
  });
  const schedulesFan = useQueries({
    queries: projectItems.map((project, index) =>
      schedulesQueryOptions(
        project.id,
        (assignmentsFan[index]?.data?.assignments ?? []).some((assignment) =>
          indexIds.has(assignment.pipeline_id),
        ),
      ),
    ),
  });

  const duplicate = useDuplicatePipeline(items.map((pipeline) => pipeline.slug));

  // Both dialog folder pickers take the wire's distinct REAL folder values
  // (alphabetical) — never the `Unfiled` sentinel, which is a group LABEL:
  // `Move to folder…` owns the one Unfiled quick-pick and writes `null` (#27).
  // `folderNames` keeps the label, because there a label IS a group: the
  // `?folder=` filter the sidebar's folder links set.
  const realFolderNames = useMemo(() => distinctFolders(items), [items]);
  const folderNames = useMemo(() => {
    const names = [...realFolderNames];
    if (items.some((pipeline) => !pipeline.folder || pipeline.folder.length === 0)) {
      names.push(UNFILED_FOLDER);
    }
    return names;
  }, [realFolderNames, items]);
  const effectiveFolderFilter =
    folderFilter && folderNames.includes(folderFilter) ? folderFilter : "";

  // `used in <project>` chips: only projects whose assignments fan actually
  // pins an indexed workflow — and only once the fan has settled, so a
  // still-reading fan never reads as "nothing is used anywhere".
  const assignmentsData = assignmentsFan.map((entry) => entry?.data);
  const assignmentsSettled =
    projectItems.length === 0 ||
    (assignmentsData.every((data) => data !== undefined) &&
      assignmentsFan.every((entry) => !entry?.isError));
  const usedByProjects = projectItems.filter((_project, index) =>
    (assignmentsData[index]?.assignments ?? []).some((assignment) =>
      indexIds.has(assignment.pipeline_id),
    ),
  );

  // A draft-only row's step chain reads its newest un-published draft's own
  // document — the same `GET /drafts/{id}` the draft editor uses. Rows with a
  // revision read the revision's canonical document, so the fan is armed
  // only for rows that have nothing else to read.
  const openDrafts = items.map((_pipeline, index) => {
    if ((definitions[index]?.data?.revisions ?? []).length > 0) return null;
    const drafts = draftsList[index]?.data?.drafts ?? [];
    return (
      [...drafts]
        .filter((draft) => draft.status !== "published")
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0] ?? null
    );
  });
  const draftFan = useQueries({
    queries: openDrafts.map((draft) => ({
      queryKey: queryKeys.draft(draft?.id ?? ""),
      queryFn: () => apiFetch<Draft>(`/api/v1/drafts/${draft?.id ?? ""}`),
      enabled: draft !== null,
    })),
  });

  const rows = items.map((pipeline, index) => {
    const definition = definitions[index]?.data;
    const ready = definition !== undefined && !definitions[index]?.isError;
    const revision = revisionFan[index]?.data;
    const document =
      revision && isDefinitionDocument(revision.canonical_document)
        ? revision.canonical_document
        : null;
    return {
      pipeline,
      ready,
      revisions: definition?.revisions ?? [],
      document,
      // `Export YAML` downloads the latest revision's regenerated YAML text;
      // the wire's draft list carries no document text, so no revision → null.
      exportDocument: revision?.document_text ?? null,
      drafts: draftsList[index]?.data?.drafts ?? [],
      openDraftDocument: draftFan[index]?.data?.document_yaml ?? null,
      facts: workflowRowFacts(
        projectItems,
        assignmentsFan.map((entry) => entry?.data),
        schedulesFan.map((entry) => entry?.data),
        pipeline.id,
      ),
    };
  });

  const query = search.trim().toLowerCase();
  const visible = rows.filter((row) => {
    if (
      query &&
      !row.pipeline.slug.toLowerCase().includes(query) &&
      !row.pipeline.display_name.toLowerCase().includes(query)
    ) {
      return false;
    }
    // A `?folder=` value the list no longer carries (its last row moved away)
    // filters nothing: the chip clears itself rather than hiding rows behind
    // a stale param.
    if (showFolders && effectiveFolderFilter) {
      if (folderLabel(row.pipeline.folder) !== effectiveFolderFilter) return false;
    }
    if (filter === "has-draft" && !row.drafts.some((draft) => draft.status !== "published")) {
      return false;
    }
    if (usedInProject && !row.facts.assigned.some((entry) => entry.project.id === usedInProject)) {
      return false;
    }
    return true;
  });

  // The grouped view (ADR-0049 § 8): one panel per folder, Unfiled last —
  // as the rows without a header, never a panel with one.
  const groups = realFolderNames
    .map((name) => ({
      name,
      rows: visible.filter((row) => row.pipeline.folder === name),
    }))
    .filter((group) => group.rows.length > 0);
  const unfiledRows = visible.filter(
    (row) => !row.pipeline.folder || row.pipeline.folder.length === 0,
  );

  const rowNode = (row: (typeof rows)[number]) => (
    <WorkflowRow
      key={row.pipeline.id}
      pipeline={row.pipeline}
      definitionReady={row.ready}
      revisions={row.revisions}
      document={row.document}
      openDraftDocument={row.openDraftDocument}
      assigned={row.facts.assigned}
      assignmentsResolved={row.facts.resolved}
      canAuthor={canAuthor}
      duplicating={duplicate.isPending && duplicate.variables === row.pipeline.id}
      onDuplicate={() =>
        duplicate.mutate(row.pipeline.id, {
          onSuccess: ({ pipeline, draft }) => navigate(routes.draft(pipeline.id, draft.id)),
        })
      }
      onOpen={() => navigate(routes.workflow(row.pipeline.id))}
      // No use-in-a-repo dialog exists on the index yet, so that item is not
      // offered; Export YAML is only offered when the row has a document.
      exportDocument={row.exportDocument}
      onMoveToFolder={canAuthor ? () => setMoveTarget(row.pipeline) : undefined}
    />
  );

  const fanBroke =
    definitions.some((entry) => entry.isError) || assignmentsFan.some((entry) => entry.isError);

  return (
    <div className="min-h-full space-y-4 px-7 py-[22px]" data-testid="library-page">
      {/* header: H1 + the list read's own count, then the authoring actions
          (they wrap below the H1 at phone width) */}
      <div className="flex flex-wrap items-center gap-x-[10px] gap-y-[8px]">
        <h1 className="text-[22px] leading-[28px] font-semibold" id="library-heading">
          Workflows
        </h1>
        {pipelines.data ? (
          <span className="font-mono text-[11px] text-faint" data-testid="workflows-count">
            {items.length}
          </span>
        ) : null}
        <div className="flex flex-wrap items-center gap-[8px] min-[900px]:ml-auto">
          {canAuthor ? (
            <Button
              variant="secondary"
              onClick={() => setImportOpen(true)}
              data-testid="workflows-import-yaml"
            >
              Import YAML
            </Button>
          ) : null}
          <Button
            variant="primary"
            disabled={!canAuthor}
            onClick={() => setNewWorkflow({ open: true, preset: null })}
            data-testid="workflows-new-workflow"
          >
            New workflow
          </Button>
        </div>
      </div>
      {me.isError ? (
        <ProblemBanner error={me.error} fallback="Your identity could not be read." />
      ) : null}
      {/* The starter cards: the dialog's own three starting points, so a card
          click preselects what `New workflow` would otherwise start from. */}
      <div
        className="grid grid-cols-1 gap-3 min-[900px]:grid-cols-3"
        data-testid="workflow-starters"
      >
        <button
          type="button"
          disabled={!canAuthor}
          onClick={() => setNewWorkflow({ open: true, preset: "blank" })}
          className="flex min-h-[76px] flex-col gap-1 rounded-[3px] border border-dashed border-line bg-surface p-3 text-left focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-ring disabled:cursor-not-allowed disabled:opacity-60"
          data-testid="workflow-starter-blank"
        >
          <span className="font-mono text-[10px] tracking-[.06em] text-faint">START BLANK</span>
          <span className="text-[13px] font-semibold text-ink">Empty canvas</span>
          <span className="text-[12px] text-muted">One agent step to start from.</span>
        </button>
        {PIPELINE_TEMPLATES.filter((template) => template.id !== "blank").map((template) => (
          <button
            key={template.id}
            type="button"
            disabled={!canAuthor}
            onClick={() => setNewWorkflow({ open: true, preset: template.id })}
            className="flex min-h-[76px] flex-col gap-1 rounded-[3px] border border-line bg-surface p-3 text-left focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-ring disabled:cursor-not-allowed disabled:opacity-60"
            data-testid={`workflow-starter-${template.id}`}
          >
            <span className="font-mono text-[10px] tracking-[.06em] text-faint">
              {template.stepCount === null
                ? "TEMPLATE"
                : `TEMPLATE · ${template.stepCount} ${template.stepCount === 1 ? "STEP" : "STEPS"}`}
            </span>
            <span className="text-[13px] font-semibold text-ink">{template.label}</span>
            {templateChain(template) ? (
              <span className="font-mono text-[10.5px] text-ink-2">{templateChain(template)}</span>
            ) : (
              <span className="text-[12px] text-muted">{template.description}</span>
            )}
          </button>
        ))}
      </div>
      {/* The reason the cards are inert — only once `me` has been read:
          loading is not authoring, and an admin is never flashed the refusal. */}
      {me.isSuccess && !canAuthor ? (
        <p
          className="-mt-2 font-mono text-[10px] text-faint"
          data-testid="workflow-starters-need-role"
        >
          {`needs ${LIBRARY_ROLE_LABEL} to create`}
        </p>
      ) : null}
      {pipelines.isPending ? <Spinner label="Loading the workflow library" /> : null}
      {pipelines.isError ? (
        <ProblemBanner error={pipelines.error} fallback="The workflow library could not be read." />
      ) : null}
      {projects.isError ? (
        <ProblemBanner
          error={projects.error}
          fallback="Your projects could not be read — assignment cells stay honest about it."
        />
      ) : null}
      {fanBroke ? (
        <ProblemBanner
          error={undefined}
          fallback="Some rows could not be read in full — their cells stay empty rather than invented."
        />
      ) : null}
      {pipelines.data ? (
        <div className="flex flex-wrap items-center gap-[6px]" data-testid="workflows-filters">
          <Input
            id="workflows-search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search workflows"
            aria-label="Search workflows"
            className="w-full min-[600px]:w-[240px]"
            data-testid="workflows-search"
          />
          <FilterChip
            active={filter === "all" && usedInProject === "" && search === ""}
            onClick={() => {
              setFilter("all");
              setUsedInProject("");
              setSearch("");
            }}
            testid="workflows-filter-all"
          >
            all
          </FilterChip>
          <FilterChip
            active={filter === "has-draft"}
            onClick={() => setFilter((current) => (current === "has-draft" ? "all" : "has-draft"))}
            testid="workflows-filter-draft"
          >
            has open draft
          </FilterChip>
          {assignmentsSettled
            ? usedByProjects.map((project) => (
                <FilterChip
                  key={project.id}
                  active={usedInProject === project.id}
                  onClick={() =>
                    setUsedInProject((current) => (current === project.id ? "" : project.id))
                  }
                  testid={`workflows-used-in-${project.id}`}
                >
                  {`used in ${project.name}`}
                </FilterChip>
              ))
            : null}
          {effectiveFolderFilter ? (
            <FilterChip
              active
              onClick={() => {
                const next = new URLSearchParams(searchParams);
                next.delete("folder");
                setSearchParams(next, { replace: true });
              }}
              testid="workflows-filter-folder"
            >
              {`in ${folderLabel(effectiveFolderFilter)}`}
            </FilterChip>
          ) : null}
        </div>
      ) : null}
      {pipelines.data && visible.length === 0 ? (
        <p className="text-[12.5px] text-muted" data-testid="workflows-empty">
          {rows.length === 0
            ? "No workflows yet. Start from a card above or New workflow."
            : "No workflow matches the current filter."}
        </p>
      ) : null}
      {pipelines.data && visible.length > 0 ? (
        showFolders ? (
          <div className="space-y-2" data-testid="workflows-list">
            {groups.map((group) => (
              <FolderGroup
                key={group.name}
                name={group.name}
                count={group.rows.length}
                open={collapsed[group.name] !== true}
                onToggle={() =>
                  setCollapsed((current) => ({
                    ...current,
                    [group.name]: current[group.name] !== true,
                  }))
                }
              >
                {group.rows.map(rowNode)}
              </FolderGroup>
            ))}
            {unfiledRows.length > 0 ? (
              <ul
                className="rounded-[3px] border border-line-strong bg-surface px-3"
                data-testid="workflow-unfiled-group"
              >
                {unfiledRows.map(rowNode)}
              </ul>
            ) : null}
          </div>
        ) : (
          <ul
            className="rounded-[3px] border border-line-strong bg-surface px-3"
            data-testid="workflows-list"
          >
            {visible.map(rowNode)}
          </ul>
        )
      ) : null}
      <ImportYamlDialog open={importOpen} onClose={() => setImportOpen(false)} />
      <NewWorkflowDialog
        open={newWorkflow.open}
        onClose={() => setNewWorkflow((current) => ({ ...current, open: false }))}
        canCreate={canAuthor}
        presetTemplateId={newWorkflow.preset}
        folders={realFolderNames}
      />
      {moveTarget ? (
        <MoveToFolderDialog
          pipeline={moveTarget}
          folders={realFolderNames}
          onClose={() => setMoveTarget(null)}
        />
      ) : null}
    </div>
  );
}

export default LibraryPage;
