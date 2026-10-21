/**
 * The org **Workflows** index (`/workflows`) and one workflow's authoring
 * surface (`/workflows/:pipelineId`). The API vocabulary is unchanged — a
 * workflow is the spec's *pipeline*; only the UI wording moved (ADR-0043).
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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { useQueries } from "@tanstack/react-query";
import { Panel } from "../components/ds/Panel";
import { Row, StatusChip } from "../components/ds/Row";
import { Button } from "../components/ds/Button";
import { Field, Input, Select } from "../components/ds/Field";
import { DRAFT_STATE, REVISION_STATE, stateOf } from "../components/ds/states";
import { FormError, ProblemBanner, Spinner } from "../components/Feedback";
import { DefinitionGraph } from "../components/m4/DefinitionGraph";
import { YamlView } from "../components/m4/YamlView";
import { apiFetch, problemOf } from "../api/client";
import { useActorNames } from "../api/actors";
import { queryKeys, useMe, useProjects } from "../api/queries";
import { formatAge } from "../lib/format";
import {
  pipelineDraftsQueryOptions,
  pipelineQueryOptions,
  revisionQueryOptions,
  schedulesQueryOptions,
  useCreateAssignment,
  useCreateDraft,
  useCreatePipeline,
  useDuplicatePipeline,
  usePipeline,
  usePipelineDrafts,
  usePipelineRevisions,
  usePipelines,
  useRevision,
  useRevisionDocument,
  workflowRowFacts,
} from "../api/pipelines";
import { viewDraftSummary, viewPipelineSummary, viewRevisionSummary } from "../api/m4view";
import type { Assignment, AssignmentList, Project } from "../api/types";
import type { DefinitionDocument } from "../lib/pipeline/definition";
import { isDefinitionDocument } from "../lib/pipeline/definition";
import { routes } from "../lib/routes";
import { WorkflowRow } from "../components/workflows/WorkflowRow";
import { ImportYamlDialog } from "../components/workflows/ImportYamlDialog";
import {
  hasLibraryRole,
  LIBRARY_AUTHORING_HINT,
  LIBRARY_ROLE_LABEL,
} from "../lib/pipeline/authoring";
import {
  BLANK_SKELETON_YAML,
  PIPELINE_TEMPLATES,
  templateById,
  withMetadataName,
  type PipelineTemplate,
  type TemplateId,
} from "../lib/pipeline/templates";
import { shortDigest } from "../lib/pipeline/yamlPointer";

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
  const [filter, setFilter] = useState<"all" | "has-draft">("all");
  const [usedInProject, setUsedInProject] = useState("");
  const [importOpen, setImportOpen] = useState(false);

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

  // Folders: the pipeline carries no `folder` field yet (gaps/library.md § 6
  // U6c — needs a backend column + ADR), so the index is one flat list. The
  // `showWorkflowFolders` preference stays a display preference until then.

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
    if (filter === "has-draft" && !row.drafts.some((draft) => draft.status !== "published")) {
      return false;
    }
    if (usedInProject && !row.facts.assigned.some((entry) => entry.project.id === usedInProject)) {
      return false;
    }
    return true;
  });

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
        <ul className="divide-y-0" data-testid="workflows-list">
          {visible.map((row) => (
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
            />
          ))}
        </ul>
      ) : null}
      <ImportYamlDialog open={importOpen} onClose={() => setImportOpen(false)} />
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

/* --------------------------------------------------- /library/:pipelineId */

/**
 * One pipeline: its revisions (read-only, immutable) and its drafts (mutable,
 * the only authoring surface). Selecting a draft, or creating a new one,
 * navigates to the Workflow Studio route (`/library/:pipelineId/drafts/:draftId`)
 * — the page that owns the editor since issue #2; a revision read stays here
 * (regenerated canonical document + definition graph).
 */
export function PipelinePage() {
  const { pipelineId = "" } = useParams();
  // The old URL shape stays valid: `/library/:id?draft=<id>` replace-navigates
  // to the Studio route, which now owns the editor (issue #2). Read at mount
  // only — after the replace the query string is gone.
  const [draftParams] = useSearchParams();
  const navigate = useNavigate();
  const redirectDraft = draftParams.get("draft");
  useEffect(() => {
    if (redirectDraft) {
      navigate(`/library/${pipelineId}/drafts/${redirectDraft}`, { replace: true });
    }
  }, [redirectDraft, pipelineId, navigate]);
  const me = useMe();
  const actors = useActorNames();
  // Same bleed as `pages/RunInspector.tsx`: the shell's centred reading
  // column is ~64rem, and a YAML viewer plus a graph squeezed into what is
  // left of a 20rem sidebar clips every line at ~20 characters. This page
  // measures the column it was handed and bleeds out of it.
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [bleed, setBleed] = useState<{ left: number; width: number } | null>(null);
  const measureBleed = useCallback(() => {
    const el = rootRef.current;
    const parent = el?.parentElement;
    if (!el || !parent) return;
    const style = window.getComputedStyle(parent);
    const left = parent.getBoundingClientRect().left + parseFloat(style.paddingLeft || "0");
    const width = document.documentElement.clientWidth || window.innerWidth || el.offsetWidth;
    setBleed((current) =>
      current && current.left === left && current.width === width ? current : { left, width },
    );
  }, []);
  const attachRoot = useCallback(
    (node: HTMLDivElement | null) => {
      rootRef.current = node;
      if (node) measureBleed();
    },
    [measureBleed],
  );
  useEffect(() => {
    window.addEventListener("resize", measureBleed);
    return () => window.removeEventListener("resize", measureBleed);
  }, [measureBleed]);
  const pipeline = usePipeline(pipelineId);
  const revisions = usePipelineRevisions(pipelineId);
  const drafts = usePipelineDrafts(pipelineId);
  const createDraft = useCreateDraft(pipelineId);
  // The one role rule, in the one place the UI states it — the draft editor
  // takes the same answer rather than forming its own opinion about what a
  // member may type into a shared definition.
  const canAuthor = hasLibraryRole(me.data);

  const [revisionKey, setRevisionKey] = useState<string | null>(null);
  const [draftCreating, setDraftCreating] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);

  // Server order is newest-first (`GET /pipelines/{id}/revisions`); nothing is
  // re-sorted here, and a pipeline that never published honestly has none.
  const revisionRows = useMemo(
    () => (revisions.data?.revisions ?? []).map(viewRevisionSummary),
    [revisions.data],
  );
  const draftRows = useMemo(() => (drafts.data?.drafts ?? []).map(viewDraftSummary), [drafts.data]);
  // Newest first by the server's own `updated_at`, and the list collapses to
  // the newest five: test runs leave dozens of same-named rows behind, and a
  // flood of identical rows shows nothing.
  const DRAFT_WINDOW = 5;
  const sortedDrafts = useMemo(
    () => [...draftRows].sort((a, b) => b.updated_at.localeCompare(a.updated_at)),
    [draftRows],
  );
  const [draftsExpanded, setDraftsExpanded] = useState(false);
  const visibleDrafts = draftsExpanded ? sortedDrafts : sortedDrafts.slice(0, DRAFT_WINDOW);
  const selectedRevisionKey = revisionKey ?? revisionRows[0]?.id ?? null;

  const revision = useRevision(selectedRevisionKey ?? "");
  const revisionDocument = useRevisionDocument(selectedRevisionKey ?? "");
  const newestDocument = useRevisionDocument(revisionRows[0]?.id ?? "");

  // The clone is a one-shot: a ref, not `isPending`, because the mutation
  // object is new every render and would re-fire the effect. With zero
  // revisions there is nothing to clone, so the draft is seeded from the
  // blank skeleton instead — named for this pipeline's slug, the same
  // document the Blank template posts — and the wait on the revisions and
  // pipeline reads keeps the decision from racing the queries.
  const creating = useRef(false);
  useEffect(() => {
    if (!draftCreating || creating.current) return;
    const cloneDocument = newestDocument.data;
    if (cloneDocument === undefined) {
      // Zero published revisions (and the queries have settled on that).
      if (revisions.data === undefined || pipeline.data === undefined) return;
      if (revisionRows.length > 0) return;
    }
    creating.current = true;
    const documentYaml =
      cloneDocument ?? withMetadataName(BLANK_SKELETON_YAML, pipeline.data?.slug ?? pipelineId);
    createDraft
      .mutateAsync({ document_yaml: documentYaml })
      .then((draft) => navigate(`/library/${pipelineId}/drafts/${draft.id}`))
      .catch((error: unknown) => setFailure(error))
      .finally(() => {
        creating.current = false;
        setDraftCreating(false);
      });
  }, [
    draftCreating,
    newestDocument.data,
    revisions.data,
    pipeline.data,
    revisionRows.length,
    pipelineId,
    createDraft,
    navigate,
  ]);

  const summary = pipeline.data ? viewPipelineSummary(pipeline.data) : null;
  // First `published` in newest-first order — the one the assign form pins.
  const newestPublished = revisionRows.find((r) => r.status === "published");

  return (
    <div
      ref={attachRoot}
      data-testid="pipeline-page"
      data-full-width={bleed ? bleed.width : "unmeasured"}
      className="grid min-h-full grid-cols-1 border-y border-line bg-paper xl:grid-cols-[300px_minmax(0,1fr)]"
      style={
        bleed
          ? { width: bleed.width || undefined, marginLeft: -bleed.left, maxWidth: "none" }
          : { maxWidth: "none" }
      }
    >
      <aside className="min-w-0 space-y-4 border-b border-line px-3 py-3 xl:border-b-0 xl:border-r">
        <div>
          <h1 className="text-[17px] font-bold" id="pipeline-heading">
            {summary?.display_name ?? "Pipeline"}
          </h1>
          <p className="font-mono text-[11px] text-muted" data-testid="pipeline-header-meta">
            {pipeline.data?.slug ?? pipelineId} ·{" "}
            {pipeline.data?.revision_count === 1
              ? "1 revision"
              : `${pipeline.data?.revision_count ?? 0} revisions`}
          </p>
          {canAuthor ? (
            // "Customize": new draft from the newest revision, straight to
            // the Studio canvas — the issue #2 route for an existing
            // published pipeline. The DRAFTS panel keeps its own New draft
            // control; this one is the one a visitor sees first.
            <Button
              variant="secondary"
              compact
              className="mt-[6px]"
              onClick={() => {
                setFailure(null);
                setDraftCreating(true);
              }}
              disabled={createDraft.isPending || draftCreating}
              data-testid="pipeline-customize"
              title="New draft from the newest revision — opens the Studio canvas"
            >
              {createDraft.isPending || draftCreating ? "Customizing…" : "Customize"}
            </Button>
          ) : null}
        </div>
        <Panel title="REVISIONS" headingId="pipeline-revisions-heading" headingLevel={2}>
          {revisions.isPending ? <Spinner label="Loading revisions" /> : null}
          {revisions.isError ? (
            <ProblemBanner
              error={revisions.error}
              fallback="This pipeline's revisions could not be read."
            />
          ) : null}
          {revisionRows.length === 0 && revisions.data ? (
            <p className="p-[10px] font-mono text-[11px] text-muted" data-testid="revisions-empty">
              never published — a revision exists when a draft validates and publishes
            </p>
          ) : null}
          <ul className="divide-y divide-line" data-testid="revision-list">
            {revisionRows.map((row) => (
              <li key={row.id}>
                <Row
                  selected={selectedRevisionKey === row.id}
                  className="h-auto flex-wrap cursor-pointer border-0 rounded-none px-[10px] py-[8px]"
                  data-testid={`revision-row-${row.revision_number}`}
                >
                  <button
                    type="button"
                    className="flex flex-1 flex-wrap items-center gap-[6px] text-left focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
                    onClick={() => setRevisionKey(row.id)}
                  >
                    <StatusChip
                      state={stateOf(REVISION_STATE[row.status])}
                      label={`r${row.revision_number} ${row.version_label}`}
                    />
                    <span className="font-mono text-[10.5px] text-faint">
                      {shortDigest(row.revision_digest)}
                    </span>
                  </button>
                </Row>
              </li>
            ))}
          </ul>
        </Panel>
        <Panel
          title="DRAFTS"
          headingId="pipeline-drafts-heading"
          headingLevel={2}
          meta={
            canAuthor ? (
              <Button
                variant="secondary"
                compact
                onClick={() => {
                  setFailure(null);
                  setDraftCreating(true);
                }}
                disabled={createDraft.isPending}
                data-testid="pipeline-new-draft"
                title={
                  revisionRows[0]
                    ? "clone the newest published revision"
                    : "no published revision yet — starts from the blank skeleton"
                }
              >
                {createDraft.isPending ? "Creating…" : "New draft"}
              </Button>
            ) : (
              <span className="font-mono text-[10px] font-normal">{LIBRARY_AUTHORING_HINT}</span>
            )
          }
        >
          {drafts.isPending ? <Spinner label="Loading drafts" /> : null}
          {drafts.isError ? (
            <ProblemBanner
              error={drafts.error}
              fallback="This pipeline's drafts could not be read."
            />
          ) : null}
          {draftRows.length === 0 && drafts.data ? (
            <p className="p-[10px] font-mono text-[11px] text-muted" data-testid="drafts-empty">
              no drafts — nothing is being authored on this pipeline right now
            </p>
          ) : null}
          <ul className="divide-y divide-line" data-testid="draft-list">
            {visibleDrafts.map((row) => (
              <li key={row.id}>
                <Row
                  className="h-auto flex-wrap cursor-pointer border-0 rounded-none px-[10px] py-[8px]"
                  data-testid={`draft-row-${row.id}`}
                >
                  <button
                    type="button"
                    className="flex flex-1 flex-wrap items-center gap-[6px] text-left focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
                    onClick={() => navigate(`/library/${pipelineId}/drafts/${row.id}`)}
                  >
                    <StatusChip
                      state={stateOf(DRAFT_STATE[row.status])}
                      label={`draft v${row.version}`}
                      labelProps={{ "data-testid": `draft-status-${row.id}` }}
                    />
                    <span className="font-mono text-[10px] text-faint">{row.status}</span>
                    <span
                      className="font-mono text-[10px] text-faint"
                      data-testid={`draft-age-${row.id}`}
                    >
                      {formatAge(row.updated_at)}
                    </span>
                    <span
                      className="font-mono text-[10px] text-faint"
                      data-testid={`draft-edited-by-${row.id}`}
                    >
                      {actors.nameOf(row.edited_by)}
                    </span>
                  </button>
                </Row>
              </li>
            ))}
          </ul>
          {sortedDrafts.length > DRAFT_WINDOW ? (
            <button
              type="button"
              onClick={() => setDraftsExpanded((current) => !current)}
              className="block w-full px-[10px] py-[6px] text-left font-mono text-[11px] text-accent-text hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
              data-testid="draft-list-more"
            >
              {draftsExpanded
                ? `show fewer — ${sortedDrafts.length - DRAFT_WINDOW} hidden`
                : `show ${sortedDrafts.length - DRAFT_WINDOW} more of ${sortedDrafts.length} drafts`}
            </button>
          ) : null}
        </Panel>
        {/* In the rail, next to Customize, not under the YAML + graph: the
            one-click path to a runnable project is the page's next action and
            used to sit at the bottom of the reading column, below the fold,
            which is where the M5 journey stopped seeing it. It still mounts
            only once a PUBLISHED revision exists to pin. */}
        {newestPublished ? (
          <AssignToProjectPanel
            pipelineId={pipelineId}
            newestPublishedDigest={newestPublished.revision_digest}
          />
        ) : null}
      </aside>
      <div className="min-w-0 space-y-4 px-4 py-4">
        {failure ? (
          <ProblemBanner
            error={failure}
            fallback="The draft could not be created."
            testid="pipeline-page-failure"
          />
        ) : null}
        {revision.isError ? (
          <ProblemBanner
            error={revision.error}
            fallback="The selected revision could not be read."
          />
        ) : null}
        {revision.data ? (
          <>
            <YamlView
              text={revisionDocument.data ?? revision.data.document_text}
              label={`r${revision.data.revision_number} · ${revision.data.version_label} · ${shortDigest(revision.data.revision_digest)} · regenerated canonical`}
              headingId="pipeline-revision-yaml-heading"
            />
            <DefinitionGraph
              document={revision.data.canonical_document as unknown as DefinitionDocument}
              label={`r${revision.data.revision_number} · definition only, no run states`}
              headingId="pipeline-revision-graph-heading"
            />
          </>
        ) : null}
        {revision.isPending && selectedRevisionKey ? (
          <Spinner label="Loading the revision document" />
        ) : null}
      </div>
    </div>
  );
}

/**
 * "Assign to a project": the org library's one-click path from published
 * revision to runnable project. A maintainer of a project (my_role ===
 * "maintainer") can pin this pipeline's newest published revision to any
 * project they maintain that does NOT already have it assigned — the store's
 * UNIQUE constraint makes a second POST a 409, so we filter it client-side
 * (the same way `ProjectRunsPipelines.tsx` filters the assignable list; but
 * here the candidate set spans every maintainer project rather than one).
 *
 * The assignment pins an *id*, not a digest: route 5's summary carries no
 * uuid (ADR-0021 § 5), while route 18 rejects anything that is not one, so
 * the digest → id resolution goes through `useRevision` (route 13) and the
 * fetch is armed only while the form is open — exactly as `AssignPipelineRow`
 * does in `ProjectRunsPipelines.tsx`.
 *
 * After a successful assign the panel shows "Assigned to <name> — Start a run"
 * linking to the project's run list, which is where a maintainer goes next.
 *
 * The two dead ends say so instead of rendering a control that cannot be used:
 * no maintainer project at all (the button is never offered — a maintainer
 * assigns it from that project's own Pipelines page), and every project you
 * maintain already pinning it (the form gives way to the same line). Both link
 * to `/`, the projects list.
 */
function AssignToProjectPanel({
  pipelineId,
  newestPublishedDigest,
}: {
  pipelineId: string;
  newestPublishedDigest: string;
}) {
  const [open, setOpen] = useState(false);
  const [projectId, setProjectId] = useState("");
  const [maxConcurrentRuns, setMaxConcurrentRuns] = useState(1);
  const [assignedName, setAssignedName] = useState<string | null>(null);

  const projects = useProjects();
  // Fan-out: one assignments read per maintainer project — the same useQueries
  // style the inbox attention lists use (Inbox.tsx / lib/attention.ts), keyed
  // identically to `useAssignments` so a shared cache entry serves both reads.
  const maintainerProjects = useMemo(
    () => (projects.data?.items ?? []).filter((p) => p.my_role === "maintainer"),
    [projects.data],
  );
  const assignmentResults = useQueries({
    queries: maintainerProjects.map((project) => ({
      queryKey: queryKeys.assignments(project.id),
      queryFn: () => apiFetch<AssignmentList>(`/api/v1/projects/${project.id}/assignments`),
      enabled: open,
    })),
  });

  // A candidate is a maintainer project whose assignments list has arrived and
  // does not yet contain this pipeline. A project whose list is still loading
  // is absent from the select rather than shown as an unknown.
  const candidates = maintainerProjects.filter((_project, index) => {
    const list = assignmentResults[index]?.data;
    if (!list) return false;
    return !list.assignments.some((a) => a.pipeline_id === pipelineId);
  });

  // Every maintainer project's assignments list has arrived. An errored list is
  // never treated as loaded — better an empty select than a false "already
  // assigned" for a project whose read failed.
  const listsLoaded =
    maintainerProjects.length > 0 && assignmentResults.every((result) => result.data !== undefined);
  // Nothing left to assign: the honest end of the form, not a select with no
  // options and a Confirm that can never enable. It still names every project
  // and its state, because "already assigned" without saying *where* is the
  // answer that told M5 QA nothing about the assignment they could see.
  const nothingToAssign = open && listsLoaded && candidates.length === 0;

  /** Per-project assignment state, read off the lists that have arrived. */
  const states = maintainerProjects.map((project, index) => {
    const list = assignmentResults[index]?.data;
    return {
      project,
      loaded: list !== undefined,
      assignment: list?.assignments.find((a) => a.pipeline_id === pipelineId) ?? null,
    };
  });

  // Resolve the newest published revision digest → uuid (route 13). Armed only
  // while the form is open and a project is chosen.
  const resolvedRevision = useRevision(open && projectId ? newestPublishedDigest : "");
  const create = useCreateAssignment(projectId);

  function confirm() {
    const revisionId = resolvedRevision.data?.id;
    if (!revisionId || !projectId) return;
    const name = maintainerProjects.find((p) => p.id === projectId)?.name ?? projectId;
    create.mutate(
      {
        pipeline_id: pipelineId,
        pinned_revision_id: revisionId,
        max_concurrent_runs: maxConcurrentRuns,
      },
      { onSuccess: () => setAssignedName(name) },
    );
  }

  // Known, with no click spent: this viewer cannot assign anything here.
  if (projects.data && maintainerProjects.length === 0) {
    return (
      <AssignDeadEnd headingId="assign-no-project-heading" testid="assign-no-maintainer">
        You maintain no project — a project maintainer can assign this pipeline from the{" "}
        <Link
          to="/"
          className="font-mono text-[11.5px] text-accent-text"
          data-testid="assign-projects-link"
        >
          project&apos;s Pipelines page
        </Link>
      </AssignDeadEnd>
    );
  }

  if (!open) {
    return (
      <Button variant="secondary" compact data-testid="assign-open" onClick={() => setOpen(true)}>
        Assign to a project
      </Button>
    );
  }

  if (nothingToAssign && !assignedName) {
    return (
      <Panel title="ASSIGN TO A PROJECT" headingId="assign-every-heading" headingLevel={2}>
        <p className="p-[10px] text-[12.5px]" data-testid="assign-every-project">
          Already assigned to every project you maintain —{" "}
          <Link
            to="/"
            className="font-mono text-[11.5px] text-accent-text"
            data-testid="assign-projects-link"
          >
            your projects
          </Link>
        </p>
        <AssignProjectStateList states={states} newestPublishedDigest={newestPublishedDigest} />
      </Panel>
    );
  }

  if (assignedName) {
    const assignedProject = maintainerProjects.find((p) => p.name === assignedName);
    return (
      <Panel title="ASSIGNED" headingId="assign-success-heading" headingLevel={2}>
        <p className="p-[10px] text-[12.5px]" data-testid="assign-success-panel">
          <span data-testid="assign-success-label">Assigned to {assignedName}</span>
          {assignedProject ? (
            <Link
              to={`/projects/${assignedProject.id}/runs`}
              className="ml-1 font-mono text-[11.5px] text-accent-text"
              data-testid="assign-start-run-link"
            >
              — Start a run
            </Link>
          ) : null}
        </p>
      </Panel>
    );
  }

  return (
    <Panel title="ASSIGN TO A PROJECT" headingId="assign-form-heading" headingLevel={2}>
      <form
        className="space-y-[10px] p-[10px]"
        data-testid="assign-form"
        onSubmit={(event) => {
          event.preventDefault();
          confirm();
        }}
      >
        {projects.isPending ? <Spinner label="Loading projects" /> : null}
        {projects.isError ? (
          <ProblemBanner error={projects.error} fallback="Your projects could not be read." />
        ) : null}
        {assignmentResults.some((result) => result.isPending) ? (
          <Spinner label="Checking which projects already have this pipeline" />
        ) : null}
        {maintainerProjects.length > 0 ? (
          <AssignProjectStateList
            states={states}
            newestPublishedDigest={newestPublishedDigest}
            chosenProjectId={projectId}
            onPick={(picked) => setProjectId(picked)}
          />
        ) : null}
        {maintainerProjects.length > 0 ? (
          <Field
            id="assign-project-select"
            label="project"
            hint="projects you maintain that do not already have this pipeline assigned"
            className="min-w-[16rem] flex-1"
          >
            <Select
              id="assign-project-select"
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
              className="font-ui"
              data-testid="assign-project-select"
            >
              <option value="">— select a project —</option>
              {candidates.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
        <Field
          id="assign-ceiling"
          label="max concurrent runs"
          hint="1 is the wire default; the server caps it at 8"
          className="w-[12rem]"
        >
          <Input
            id="assign-ceiling"
            type="number"
            min={1}
            max={8}
            value={maxConcurrentRuns}
            onChange={(event) => setMaxConcurrentRuns(event.target.valueAsNumber || 1)}
            data-testid="assign-ceiling"
          />
        </Field>
        <div className="flex items-center gap-[8px]">
          <Button
            type="submit"
            variant="primary"
            compact
            disabled={!projectId || !resolvedRevision.data || create.isPending}
            data-testid="assign-confirm"
          >
            {create.isPending ? "Assigning…" : "Confirm"}
          </Button>
          <Button
            variant="ghost"
            compact
            data-testid="assign-cancel"
            onClick={() => setOpen(false)}
          >
            Cancel
          </Button>
        </div>
        {resolvedRevision.isPending && projectId ? (
          <Spinner label="Resolving the revision id" />
        ) : null}
        {resolvedRevision.isError ? (
          <ProblemBanner
            error={resolvedRevision.error}
            fallback="The newest published revision could not be read."
          />
        ) : null}
        {create.isError ? <FormError error={create.error} testid="assign-error" /> : null}
      </form>
    </Panel>
  );
}

/**
 * One row per project the caller maintains, saying what it pins today.
 *
 * The assign form used to answer "is it already assigned?" by hiding the
 * projects that were — a reader could not see the assignment they were looking
 * for, and an all-assigned caller saw a sentence about a set they could not
 * inspect (`lib | polish`). This is that set, stated per project: assigned (with
 * the pin the project actually runs) or not assigned (with the row's pick
 * feeding the existing form below). No new write path: `onPick` only chooses the
 * project the form posts for.
 */
function AssignProjectStateList({
  states,
  newestPublishedDigest,
  chosenProjectId = null,
  onPick,
}: {
  states: {
    project: Project;
    loaded: boolean;
    assignment: Assignment | null;
  }[];
  /** The revision this panel would pin, so an older pin can say so. */
  newestPublishedDigest: string;
  chosenProjectId?: string | null;
  onPick?: (projectId: string) => void;
}) {
  return (
    <ul className="divide-y divide-line border-y border-line" data-testid="assign-project-states">
      {states.map(({ project, loaded, assignment }) => (
        <li
          key={project.id}
          className="flex flex-wrap items-center gap-[6px] px-[10px] py-[7px]"
          data-testid={`assign-project-state-${project.id}`}
        >
          <span className="text-[12.5px] font-semibold">{project.name}</span>
          <span
            className="font-mono text-[10.5px]"
            data-testid={`assign-project-pin-${project.id}`}
          >
            {assignment
              ? `assigned · pins ${assignment.pinned_version_label ?? `r${shortDigest(assignment.pinned_revision_digest)}`}${
                  assignment.pinned_revision_digest === newestPublishedDigest
                    ? " (newest published)"
                    : " (an older revision)"
                }${assignment.enabled ? "" : " · disabled"}`
              : loaded
                ? "not assigned"
                : "checking…"}
          </span>
          {!assignment && loaded && onPick ? (
            <Button
              variant="secondary"
              compact
              data-testid={`assign-pick-${project.id}`}
              onClick={() => onPick(project.id)}
            >
              {chosenProjectId === project.id ? "picked — confirm below" : "Assign here"}
            </Button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * The honest end of the assign path: no usable target, stated in place of a
 * control that cannot be used, with the way out — the projects list (`/`),
 * where a maintainer assigns from that project's own Pipelines page.
 */
function AssignDeadEnd({
  headingId,
  testid,
  children,
}: {
  headingId: string;
  testid: string;
  children: ReactNode;
}) {
  return (
    <Panel title="ASSIGN TO A PROJECT" headingId={headingId} headingLevel={2}>
      <p className="p-[10px] text-[12.5px]" data-testid={testid}>
        {children}
      </p>
    </Panel>
  );
}

export default LibraryPage;
