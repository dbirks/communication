/**
 * One pipeline: its revisions (read-only, immutable) and its drafts (mutable,
 * the only authoring surface). Selecting a draft, or creating a new one,
 * navigates to the Workflow Studio route (`/library/:pipelineId/drafts/:draftId`)
 * — the page that owns the editor since issue #2; a revision read stays here
 * (regenerated canonical document + definition graph).
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
import { apiFetch } from "../api/client";
import { useActorNames } from "../api/actors";
import { queryKeys, useMe, useProjects } from "../api/queries";
import { formatAge } from "../lib/format";
import { viewDraftSummary, viewPipelineSummary, viewRevisionSummary } from "../api/m4view";
import type { Assignment, AssignmentList, Project } from "../api/types";
import type { DefinitionDocument } from "../lib/pipeline/definition";
import {
  useCreateAssignment,
  useCreateDraft,
  usePipeline,
  usePipelineDrafts,
  usePipelineRevisions,
  useRevision,
  useRevisionDocument,
} from "../api/pipelines";
import { BLANK_SKELETON_YAML, withMetadataName } from "../lib/pipeline/templates";
import { WorkflowTriggers } from "../components/workflows/Triggers";
import { hasLibraryRole, LIBRARY_AUTHORING_HINT } from "../lib/pipeline/authoring";
import { shortDigest } from "../lib/pipeline/yamlPointer";

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
  // column is ~64rem, and a YAML viewer plus a graph squeezed into it clips
  // every line at ~20 characters. This page bleeds out to the shell's content
  // column — `<main>`'s parent: the flex-1 region right of the 240px sticky
  // sidebar (the full width below `md`, where the sidebar is a drawer) —
  // never under the sidebar. The old `marginLeft: -left, width: viewport`
  // assumed the top-bar layout where content started at x=0; with the sidebar
  // it parked this page's 300px rail under the sticky column and its controls
  // were unclickable.
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [bleed, setBleed] = useState<{ offset: number; width: number } | null>(null);
  const measureBleed = useCallback(() => {
    const el = rootRef.current;
    const parent = el?.parentElement;
    if (!el || !parent) return;
    const main = el.closest("main");
    const column = main?.parentElement ?? null;
    const staticLeft =
      parent.getBoundingClientRect().left +
      parseFloat(window.getComputedStyle(parent).paddingLeft || "0");
    const offset = column ? staticLeft - column.getBoundingClientRect().left : 0;
    const columnStyle = column ? window.getComputedStyle(column) : null;
    const columnWidth = column
      ? column.clientWidth -
        parseFloat(columnStyle?.paddingLeft || "0") -
        parseFloat(columnStyle?.paddingRight || "0")
      : 0;
    const width =
      columnWidth > 0
        ? columnWidth
        : document.documentElement.clientWidth || window.innerWidth || el.offsetWidth;
    // Equal values do not re-render: this runs from a ref callback, and a new
    // object every time would be a render loop with a measurement in it.
    setBleed((current) =>
      current && current.offset === offset && current.width === width ? current : { offset, width },
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
          ? { width: bleed.width || undefined, marginLeft: -bleed.offset, maxWidth: "none" }
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
        <WorkflowTriggers pipelineId={pipelineId} />
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
