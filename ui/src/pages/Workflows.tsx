/**
 * The org **Workflows** index (`/workflows`): the library, the filter row,
 * and the authoring surface that hangs off it — the new-pipeline form and
 * the starter template list.
 *
 * Honesty rules (docs/design/handoff-app-shell/gaps/library.md § 5),
 * unchanged from the old library page:
 * - A row is built from the same two reads the project page fans
 *   (`GET /pipelines/{id}` + its drafts list); nothing is invented beyond
 *   what the wire serves.
 * - `channels` is M6 rollout vocabulary; the wire serves none, so the
 *   revision chip is a single `✓ PUBLISHED r{n} {digest6}` — no amber
 *   BETA/STABLE dual chip, and never "by assistant" (no assistant identity
 *   is persisted on drafts).
 * - Duplicate is the client-side three writes the gap analysis settles on
 *   (U1) until a backend endpoint exists: GET the latest revision's
 *   regenerated document → POST a new pipeline `<slug>-copy[-n]` → POST one
 *   draft under it, then land on that draft.
 * - Authoring controls (new workflow, import, duplicate) appear only for
 *   the library role: `01` gives definition-reading to every org member and
 *   publishing to org admins alone.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useQueries } from "@tanstack/react-query";
import { Panel } from "../components/ds/Panel";
import { Button } from "../components/ds/Button";
import { Field, Input, Select } from "../components/ds/Field";
import { ProblemBanner, Spinner } from "../components/Feedback";
import { apiFetch, problemOf } from "../api/client";
import { useActorNames } from "../api/actors";
import { queryKeys, useMe, useProjects } from "../api/queries";
import {
  pipelineDraftsQueryOptions,
  pipelineQueryOptions,
  revisionQueryOptions,
  schedulesQueryOptions,
  useCreateDraft,
  useCreatePipeline,
  useDuplicatePipeline,
  usePipelines,
  UNFILED_FOLDER,
  distinctFolders,
  folderLabel,
  workflowRowFacts,
} from "../api/pipelines";
import type { AssignmentList, PipelineSummary } from "../api/types";
import { isDefinitionDocument } from "../lib/pipeline/definition";
import { routes } from "../lib/routes";
import { useLayoutPrefs } from "../lib/prefs";
import { WorkflowRow, MoveToFolderDialog } from "../components/workflows/WorkflowRow";
import { ImportYamlDialog } from "../components/workflows/ImportYamlDialog";
import { hasLibraryRole, LIBRARY_ROLE_LABEL } from "../lib/pipeline/authoring";
import {
  PIPELINE_TEMPLATES,
  templateById,
  withMetadataName,
  type PipelineTemplate,
  type TemplateId,
} from "../lib/pipeline/templates";

/* ------------------------------------------------------------- /workflows */

/** The 3a filter row's toggle chip: a pressed state a screen reader hears
 * (`aria-pressed`) and a keyboard can reach (the ds focus ring). */
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

export function LibraryPage() {
  const navigate = useNavigate();
  const me = useMe();
  const actors = useActorNames();
  const pipelines = usePipelines();
  const projects = useProjects();
  const canAuthor = hasLibraryRole(me.data);
  const { prefs } = useLayoutPrefs();
  // ADR-0049 § 8: grouping is a display preference; the `?folder=` param the
  // sidebar's folder links set is the page's source of truth for the filter.
  const showFolders = prefs.showWorkflowFolders;
  const [searchParams, setSearchParams] = useSearchParams();
  const folderFilter = searchParams.get("folder") ?? "";
  const [filter, setFilter] = useState<"all" | "has-draft">("all");
  const [usedInProject, setUsedInProject] = useState("");
  const [importOpen, setImportOpen] = useState(false);
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

  // The filter select and the move dialog's picker share the same names: the
  // wire's distinct folder values (alphabetical), the Unfiled label last.
  const folderNames = useMemo(() => {
    const names = distinctFolders(items);
    if (items.some((pipeline) => !pipeline.folder || pipeline.folder.length === 0)) {
      names.push(UNFILED_FOLDER);
    }
    return names;
  }, [items]);

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
      drafts: draftsList[index]?.data?.drafts ?? [],
      facts: workflowRowFacts(
        projectItems,
        assignmentsFan.map((entry) => entry?.data),
        schedulesFan.map((entry) => entry?.data),
        pipeline.id,
      ),
    };
  });

  const visible = rows.filter((row) => {
    // A `?folder=` value the list no longer carries (its last row moved away)
    // filters nothing: the select falls back to `all folders` and so does
    // the page, rather than hiding rows behind a stale param.
    const effectiveFolderFilter =
      folderFilter && folderNames.includes(folderFilter) ? folderFilter : "";
    if (
      showFolders &&
      effectiveFolderFilter &&
      folderLabel(row.pipeline.folder) !== effectiveFolderFilter
    ) {
      return false;
    }
    if (filter === "has-draft" && !row.drafts.some((draft) => draft.status !== "published")) {
      return false;
    }
    if (usedInProject && !row.facts.assigned.some((entry) => entry.project.id === usedInProject)) {
      return false;
    }
    return true;
  });

  // The grouped view (ADR-0049 § 8): one section per folder, Unfiled last;
  // a group only renders while its rows survive the other filters.
  const groups = folderNames
    .map((name) => ({
      name,
      rows: visible.filter((row) =>
        name === UNFILED_FOLDER
          ? !row.pipeline.folder || row.pipeline.folder.length === 0
          : row.pipeline.folder === name,
      ),
    }))
    .filter((group) => group.rows.length > 0);

  const rowNode = (row: (typeof rows)[number]) => (
    <WorkflowRow
      key={row.pipeline.id}
      pipeline={row.pipeline}
      definitionReady={row.ready}
      revisions={row.revisions}
      document={row.document}
      drafts={row.drafts}
      nameOf={actors.nameOf}
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
      onMoveToFolder={canAuthor ? () => setMoveTarget(row.pipeline) : undefined}
    />
  );

  const fanBroke =
    definitions.some((entry) => entry.isError) || assignmentsFan.some((entry) => entry.isError);

  return (
    <div className="min-h-full space-y-4 px-4 py-4" data-testid="library-page">
      <div className="flex items-center justify-between">
        <h1 className="text-[19px] font-bold" id="library-heading">
          Workflows
        </h1>
        {canAuthor ? (
          <Button
            variant="secondary"
            onClick={() => setImportOpen(true)}
            data-testid="workflows-import-yaml"
          >
            Import YAML
          </Button>
        ) : null}
      </div>
      {me.isError ? (
        <ProblemBanner error={me.error} fallback="Your identity could not be read." />
      ) : null}
      {canAuthor ? <NewPipelineForm /> : null}
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
          <FilterChip
            active={filter === "all"}
            onClick={() => setFilter("all")}
            testid="workflows-filter-all"
          >
            all
          </FilterChip>
          <FilterChip
            active={filter === "has-draft"}
            onClick={() => setFilter("has-draft")}
            testid="workflows-filter-draft"
          >
            has open draft
          </FilterChip>
          <Select
            id="workflows-filter-project"
            aria-label="used in project"
            value={usedInProject}
            onChange={(event) => setUsedInProject(event.target.value)}
            className="font-mono text-[10.5px]"
            data-testid="workflows-filter-project"
          >
            <option value="">used in any project</option>
            {projectItems.map((project) => (
              <option key={project.id} value={project.id}>
                {`used in ${project.name}`}
              </option>
            ))}
          </Select>
          {showFolders ? (
            <Select
              id="workflows-filter-folder"
              aria-label="folder"
              value={folderFilter && folderNames.includes(folderFilter) ? folderFilter : ""}
              onChange={(event) => {
                const next = new URLSearchParams(searchParams);
                if (event.target.value === "") {
                  next.delete("folder");
                } else {
                  next.set("folder", event.target.value);
                }
                setSearchParams(next, { replace: true });
              }}
              className="font-mono text-[10.5px]"
              data-testid="workflows-filter-folder"
            >
              <option value="">all folders</option>
              {folderNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </Select>
          ) : null}
        </div>
      ) : null}
      {pipelines.data && visible.length === 0 ? (
        <p className="text-[12.5px] text-muted" data-testid="workflows-empty">
          {rows.length === 0
            ? "No workflows yet — one is created with `New workflow` below."
            : "No workflow matches the current filter."}
        </p>
      ) : null}
      {pipelines.data && visible.length > 0 ? (
        showFolders ? (
          // ADR-0049 § 8: collapsible folder headers, each with its count
          // (the group's own rows — never an invented number), Unfiled last.
          <div className="space-y-2" data-testid="workflows-list">
            {groups.map((group) => {
              const open = collapsed[group.name] !== true;
              const slug =
                group.name
                  .toLowerCase()
                  .replace(/[^a-z0-9]+/g, "-")
                  .replace(/^-+|-+$/g, "") || "folder";
              return (
                <section key={group.name}>
                  <button
                    type="button"
                    aria-expanded={open}
                    onClick={() => setCollapsed((current) => ({ ...current, [group.name]: open }))}
                    className="flex w-full items-center gap-[6px] rounded-[3px] border border-line bg-paper px-[8px] py-[5px] font-mono text-[10.5px] font-semibold text-ink hover:border-line-strong focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-ring"
                    data-testid={`workflow-folder-header-${slug}`}
                  >
                    <span aria-hidden="true">{open ? "▾" : "▸"}</span>
                    <span className="min-w-0 truncate">{group.name}</span>
                    <span className="ml-auto shrink-0 font-normal text-muted">
                      {group.rows.length}
                    </span>
                  </button>
                  {open ? <ul className="divide-y-0">{group.rows.map(rowNode)}</ul> : null}
                </section>
              );
            })}
          </div>
        ) : (
          <ul className="divide-y-0" data-testid="workflows-list">
            {visible.map(rowNode)}
          </ul>
        )
      ) : null}
      <ImportYamlDialog open={importOpen} onClose={() => setImportOpen(false)} />
      {moveTarget ? (
        <MoveToFolderDialog
          pipeline={moveTarget}
          folders={folderNames}
          onClose={() => setMoveTarget(null)}
        />
      ) : null}
      {/* Below the definitions, never above them: the templates are the same
          vetted samples the authoring form offers, and a reader without the
          library role has no picker to find them behind. */}
      <PipelineTemplateList canCreate={canAuthor} />
    </div>
  );
}
/**
 * `POST /pipelines` — the logical definition only (ADR-0002): a slug and a
 * name create nothing that runs, because a pipeline has no revision until a
 * draft validates and publishes.
 *
 * "Start from" is the exception that proves the rule: a template never
 * invents a revision either. It posts the **second** write the click path
 * already required by hand (New pipeline → New draft → paste the sample) —
 * `POST /pipelines/{id}/drafts` with one of the two `docs/samples/home/`
 * documents, whose single `metadata.name` line is rewritten to the new slug so
 * the document agrees with the definition just created. Blank does the same
 * with the minimal skeleton document (`BLANK_SKELETON_YAML`): a draft is
 * allowed to be invalid — Validate is what judges it — so a Blank pipeline is
 * no longer a dead end with no first draft. When a template's draft
 * lands, the page opens at `/library/:id?draft=<id>` with that draft selected,
 * so the author sees the YAML they can now Validate and Publish. A failed
 * template post does not retry the pipeline (that would be a `409` on a slug
 * the server already accepted) — it re-posts only the draft.
 */
function NewPipelineForm() {
  const navigate = useNavigate();
  const create = useCreatePipeline();
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [templateId, setTemplateId] = useState<TemplateId>("blank");
  // The pipeline exists and its draft does not yet — set only after the
  // definition POST resolves, and the input for the draft hook's pipeline id.
  // `run` counts attempts: a failed post is retried only by the explicit
  // button, never by a re-render (the mutation object is new every render, and
  // an effect keyed on it would hammer the drafts endpoint forever).
  const [seed, setSeed] = useState<{
    pipelineId: string;
    documentYaml: string;
    run: number;
  } | null>(null);
  const [seedFailure, setSeedFailure] = useState<unknown>(null);
  const template = templateById(templateId);
  const createDraft = useCreateDraft(seed?.pipelineId ?? "");

  /** The last attempt this render has already fired; see `run` above. */
  const startedRun = useRef(0);
  useEffect(() => {
    if (!seed || startedRun.current === seed.run) return;
    startedRun.current = seed.run;
    createDraft
      .mutateAsync({ document_yaml: seed.documentYaml })
      .then((draft) => navigate(`/library/${seed.pipelineId}/drafts/${draft.id}`))
      .catch((error: unknown) => setSeedFailure(error));
  }, [seed, createDraft, navigate]);

  async function submit() {
    if (slug.trim() === "") return;
    // Every template carries a document (Blank: the skeleton), so the second
    // write always follows the definition — there is no document-less path.
    const documentYaml = template?.documentYaml;
    if (!documentYaml) return;
    try {
      const pipeline = await create.mutateAsync({
        slug: slug.trim(),
        display_name: name.trim() || undefined,
      });
      setSeedFailure(null);
      setSeed({
        pipelineId: pipeline.id,
        documentYaml: withMetadataName(documentYaml, slug.trim()),
        run: startedRun.current + 1,
      });
    } catch {
      // the problem renders below; a duplicate slug is the server's `409`
    }
  }

  return (
    <Panel
      title="NEW PIPELINE"
      headingId="library-new-pipeline-heading"
      headingLevel={2}
      meta={
        <span className="font-mono text-[10px] font-normal">definition only — no revision</span>
      }
    >
      <form
        className="flex flex-wrap items-end gap-[10px] p-[10px]"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        data-testid="library-new-pipeline"
      >
        <Field
          id="library-new-slug"
          label="slug"
          hint="unique in the organization; a duplicate is a 409"
          error={
            create.isError
              ? problemOf(create.error).detail || problemOf(create.error).title
              : undefined
          }
          className="min-w-[16rem] flex-1"
        >
          <Input
            id="library-new-slug"
            value={slug}
            onChange={(event) => setSlug(event.target.value)}
            className="font-mono"
            data-testid="library-new-slug-input"
          />
        </Field>
        <Field
          id="library-new-name"
          label="name"
          hint="optional display name"
          className="min-w-[14rem] flex-1"
        >
          <Input
            id="library-new-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            data-testid="library-new-name-input"
          />
        </Field>
        <Field
          id="library-new-template"
          label="start from"
          hint={<span data-testid="library-new-template-hint">{template?.description}</span>}
          className="min-w-[16rem] flex-1"
        >
          <Select
            id="library-new-template"
            value={templateId}
            onChange={(event) => setTemplateId(event.target.value as TemplateId)}
            className="font-ui"
            data-testid="library-new-template-select"
          >
            {PIPELINE_TEMPLATES.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>
        <Button
          type="submit"
          variant="primary"
          disabled={create.isPending || Boolean(seed) || slug.trim() === ""}
          data-testid="library-new-submit"
        >
          {create.isPending || seed ? "Creating…" : "Create pipeline"}
        </Button>
      </form>
      {seedFailure ? (
        <div className="flex flex-wrap items-center gap-[8px] px-[10px] pb-[10px]">
          <ProblemBanner
            error={seedFailure}
            fallback="The pipeline was created, but its template draft was not."
            testid="library-new-template-failure"
          />
          <Button
            variant="secondary"
            onClick={() => {
              setSeedFailure(null);
              setSeed((current) => (current ? { ...current, run: current.run + 1 } : current));
            }}
            data-testid="library-new-template-retry"
          >
            Retry the template draft
          </Button>
        </div>
      ) : null}
    </Panel>
  );
}
/**
 * The starter workflows, shown as a list: the same vetted starting points the
 * "start from" select inside `NewPipelineForm` offers, readable at a glance —
 * name, one-line description, the number of steps the Studio canvas will
 * draw (`stepCount`, from the same parser the canvas uses), and for the
 * library role a "Use template" button. That button runs the same two writes
 * the form runs — `POST /pipelines` with the template id as the slug, then
 * `POST /pipelines/{id}/drafts` with the template's document, `name:`
 * rewritten to that slug — and lands on the Studio route: a usable graph,
 * no YAML textarea in between.
 *
 * The slug is the template id, so a second "Use template" in the same org
 * is a `409` the server already knows how to say; the banner names it and
 * points at the form above, where a different slug goes. A draft-post
 * failure is retried by the explicit button only, never by a re-render —
 * the same `run`-counted one-shot as `NewPipelineForm`.
 */
function PipelineTemplateList({ canCreate }: { canCreate: boolean }) {
  const navigate = useNavigate();
  const createPipeline = useCreatePipeline();
  const [pipelineFailure, setPipelineFailure] = useState<unknown>(null);
  const [seed, setSeed] = useState<{
    pipelineId: string;
    templateId: TemplateId;
    documentYaml: string;
    run: number;
  } | null>(null);
  const [seedFailure, setSeedFailure] = useState<unknown>(null);
  const createDraft = useCreateDraft(seed?.pipelineId ?? "");
  /** The last attempt this render has already fired; see `run` above. */
  const startedRun = useRef(0);
  useEffect(() => {
    if (!seed || startedRun.current === seed.run) return;
    startedRun.current = seed.run;
    createDraft
      .mutateAsync({ document_yaml: seed.documentYaml })
      .then((draft) => navigate(`/library/${seed.pipelineId}/drafts/${draft.id}`))
      .catch((error: unknown) => setSeedFailure(error));
  }, [seed, createDraft, navigate]);

  async function startTemplate(template: PipelineTemplate) {
    setPipelineFailure(null);
    setSeedFailure(null);
    try {
      const pipeline = await createPipeline.mutateAsync({
        slug: template.id,
        display_name: template.label,
      });
      setSeed({
        pipelineId: pipeline.id,
        templateId: template.id,
        documentYaml: withMetadataName(template.documentYaml, template.id),
        run: startedRun.current + 1,
      });
    } catch (error) {
      // A slug the organization already has is a `409` — the form above is
      // where a different slug goes; the banner says so below.
      setPipelineFailure(error);
    }
  }

  return (
    <Panel
      title="STARTER WORKFLOWS"
      headingId="library-templates-heading"
      headingLevel={2}
      meta={
        <span className="font-mono text-[10px] font-normal" data-testid="library-templates-note">
          {canCreate
            ? 'starter workflows — "Use template" creates the pipeline and its first draft, then opens the Studio canvas'
            : `read-only — creating a pipeline from one needs ${LIBRARY_ROLE_LABEL}`}
        </span>
      }
    >
      <ul className="divide-y divide-line" data-testid="library-templates">
        {PIPELINE_TEMPLATES.map((template) => (
          <li
            key={template.id}
            className="px-[10px] py-[8px]"
            data-testid={`library-template-${template.id}`}
          >
            <span className="flex flex-wrap items-baseline gap-[6px]">
              <span className="text-[12.5px] font-semibold">{template.label}</span>
              <span className="font-mono text-[10px] text-faint">{template.source}</span>
            </span>
            <span className="block text-[12px] text-muted">{template.description}</span>
            <span className="mt-[6px] flex flex-wrap items-center gap-[8px]">
              {template.stepCount === null ? null : (
                <span
                  className="font-mono text-[10px] text-faint"
                  data-testid={`template-${template.id}-steps`}
                >
                  {template.stepCount} {template.stepCount === 1 ? "step" : "steps"}
                </span>
              )}
              {canCreate ? (
                <Button
                  variant="secondary"
                  compact
                  onClick={() => void startTemplate(template)}
                  disabled={createPipeline.isPending || seed !== null || seedFailure !== null}
                  data-testid={`template-${template.id}-use`}
                >
                  {seed?.templateId === template.id ? "Creating…" : "Use template"}
                </Button>
              ) : null}
              {canCreate ? null : (
                // The exact verb that is missing, on the row it would apply to.
                <span
                  className="font-mono text-[10px]"
                  data-testid={`library-template-${template.id}-needs-role`}
                >
                  needs {LIBRARY_ROLE_LABEL} to create
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>
      {pipelineFailure ? (
        <p
          className="px-[10px] pb-[8px] font-mono text-[10.5px] text-muted"
          data-testid="template-use-pipeline-failure"
        >
          {problemOf(pipelineFailure).detail || problemOf(pipelineFailure).title} — a different slug
          goes in the form above
        </p>
      ) : null}
      {seedFailure ? (
        <div className="flex flex-wrap items-center gap-[8px] px-[10px] pb-[10px]">
          <ProblemBanner
            error={seedFailure}
            fallback="The pipeline was created, but its template draft was not."
            testid="template-use-draft-failure"
          />
          <Button
            variant="secondary"
            onClick={() => {
              setSeedFailure(null);
              setSeed((current) => (current ? { ...current, run: current.run + 1 } : current));
            }}
            data-testid="template-use-draft-retry"
          >
            Retry the template draft
          </Button>
        </div>
      ) : null}
    </Panel>
  );
}

export default LibraryPage;
