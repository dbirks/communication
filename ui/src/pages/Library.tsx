/**
 * The org pipeline library as a real route (`/library`) and one pipeline's
 * authoring surface (`/library/:pipelineId`).
 *
 * Honesty rules inherited from `pages/ProjectRunsPipelines.tsx`, unchanged:
 * - A row is built from `viewPipeline`/`viewPipelineSummary` over the same two
 *   reads the project page fans (`GET /pipelines/{id}` + its drafts list). The
 *   list route carries neither revisions nor drafts, so nothing here can be
 *   invented from it.
 * - `channels` is M6 rollout vocabulary; the wire serves none, so rows carry
 *   `channels: []`. At org scope the channel cell is omitted entirely — there
 *   is no project here for a channel to belong to.
 * - A draft's state is the server's `status` column, never a client-side guess
 *   — which is why Publish is gated in `DraftEditor`, not here.
 * - Authoring controls (new pipeline, new draft, the editor) appear only for
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
import { DraftEditor } from "../components/m4/DraftEditor";
import { PipelineLibrary, type PipelineLibraryRow } from "../components/m4/PipelineLibrary";
import { YamlView } from "../components/m4/YamlView";
import { apiFetch, problemOf } from "../api/client";
import { useActorNames } from "../api/actors";
import { queryKeys, useMe, useProjects } from "../api/queries";
import { formatAge } from "../lib/format";
import {
  pipelineDraftsQueryOptions,
  pipelineQueryOptions,
  useCreateAssignment,
  useCreateDraft,
  useCreatePipeline,
  usePipeline,
  usePipelineDrafts,
  usePipelineRevisions,
  usePipelines,
  useRevision,
  useRevisionDocument,
} from "../api/pipelines";
import {
  viewDraftSummary,
  viewPipeline,
  viewPipelineSummary,
  viewRevisionSummary,
} from "../api/m4view";
import type { Assignment, AssignmentList, Project } from "../api/types";
import type { DefinitionDocument } from "../lib/pipeline/definition";
import {
  hasLibraryRole,
  LIBRARY_AUTHORING_HINT,
  LIBRARY_ROLE_LABEL,
} from "../lib/pipeline/authoring";
import {
  PIPELINE_TEMPLATES,
  templateById,
  withMetadataName,
  type TemplateId,
} from "../lib/pipeline/templates";
import { shortDigest } from "../lib/pipeline/yamlPointer";

/* ------------------------------------------------------------- /library */

export function LibraryPage() {
  const navigate = useNavigate();
  const me = useMe();
  const actors = useActorNames();
  const pipelines = usePipelines();
  const canAuthor = hasLibraryRole(me.data);
  const ids = useMemo(
    () => (pipelines.data?.pipelines ?? []).map((pipeline) => pipeline.id),
    [pipelines.data],
  );
  // One fan keyed exactly like the single-read hooks (as the project page does).
  const definitions = useQueries({ queries: ids.map(pipelineQueryOptions) });
  const draftsList = useQueries({ queries: ids.map(pipelineDraftsQueryOptions) });

  const rows: PipelineLibraryRow[] = [];
  definitions.forEach((entry, index) => {
    const definition = entry.data;
    if (!definition) return;
    const view = viewPipeline(definition);
    rows.push({
      pipeline: { ...viewPipelineSummary(definition), description: definition.description },
      latest: view.revisions[0] ?? null,
      revisions: view.revisions,
      drafts: (draftsList[index]?.data?.drafts ?? []).map(viewDraftSummary),
      channels: [],
    });
  });

  return (
    <div className="min-h-full space-y-4 px-4 py-4" data-testid="library-page">
      <h1 className="text-[19px] font-bold" id="library-heading">
        Pipeline library
      </h1>
      {me.isError ? (
        <ProblemBanner error={me.error} fallback="Your identity could not be read." />
      ) : null}
      {canAuthor ? <NewPipelineForm /> : null}
      {pipelines.isPending ? <Spinner label="Loading the pipeline library" /> : null}
      {pipelines.isError ? (
        <ProblemBanner error={pipelines.error} fallback="The pipeline library could not be read." />
      ) : null}
      {rows.length > 0 || pipelines.data ? (
        <PipelineLibrary
          rows={rows}
          scope="org"
          nameOf={actors.nameOf}
          canCreate={canAuthor}
          onNew={() => document.getElementById("library-new-slug")?.focus()}
          headingId="library-rows-heading"
          onOpen={(pipeline) => navigate(`/library/${pipeline.id}`)}
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
 * the document agrees with the definition just created. Blank is the old
 * behavior exactly: one POST, no draft, no navigation. When a template's draft
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
      .then((draft) => navigate(`/library/${seed.pipelineId}?draft=${draft.id}`))
      .catch((error: unknown) => setSeedFailure(error));
  }, [seed, createDraft, navigate]);

  async function submit() {
    if (slug.trim() === "") return;
    const documentYaml = template?.documentYaml ?? null;
    try {
      const pipeline = await create.mutateAsync({
        slug: slug.trim(),
        display_name: name.trim() || undefined,
      });
      if (!documentYaml) {
        setSlug("");
        setName("");
        setTemplateId("blank");
        return;
      }
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
 * The vetted starting points, shown read-only.
 *
 * Before this panel the only place a template was mentioned was the "start
 * from" select inside `NewPipelineForm`, which is rendered for the library
 * role alone — so an org member looking at `/library` had no way to learn that
 * two working samples exist, and no way to name where they came from. The list
 * is the same `PIPELINE_TEMPLATES` the authoring form offers (one source of the
 * truth, one drift risk removed), and the same authoring predicate decides
 * whether it is an introduction or a dead end: `canCreate` says pick one above,
 * everyone else is told creating from one needs the library role.
 *
 * Nothing here writes. A template is a document waiting to be posted into a
 * draft (`07` "Sample pipelines"); the two YAMLs are the byte-identical copies
 * of `docs/samples/home/` that Go compiles in CI, which is what makes them
 * worth naming.
 */
function PipelineTemplateList({ canCreate }: { canCreate: boolean }) {
  return (
    <Panel
      title="PIPELINE TEMPLATES"
      headingId="library-templates-heading"
      headingLevel={2}
      meta={
        <span className="font-mono text-[10px] font-normal" data-testid="library-templates-note">
          {canCreate
            ? "New pipeline above starts a draft from one of these"
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
              <span className="font-mono text-[10px] text-faint">
                {template.documentYaml ? "docs/samples/home" : "no document posted"}
              </span>
            </span>
            <span className="block text-[12px] text-muted">{template.description}</span>
            {canCreate ? null : (
              // The exact verb that is missing, on the row it would apply to.
              <span
                className="block font-mono text-[10px]"
                data-testid={`library-template-${template.id}-needs-role`}
              >
                needs {LIBRARY_ROLE_LABEL} to create
              </span>
            )}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

/* --------------------------------------------------- /library/:pipelineId */

/**
 * One pipeline: its revisions (read-only, immutable) and its drafts (mutable,
 * the only authoring surface M5 has). Selecting a revision reads its regenerated
 * canonical document + `canonical_document` (ADR-0021 § 5 — what the author
 * typed is not stored on a revision); selecting a draft opens `DraftEditor`,
 * whose Publish gate is the server's `status`, never this page's opinion.
 */
export function PipelinePage() {
  const { pipelineId = "" } = useParams();
  // A template draft is opened by id: the library form creates the first draft
  // after the definition POST and lands on `/library/:id?draft=<id>` with it
  // selected. Read at mount only — the page owns selection from then on, and
  // the link stays reloadable.
  const [draftParams] = useSearchParams();
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
  const [draftId, setDraftId] = useState<string | null>(draftParams.get("draft"));
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
  // object is new every render and would re-fire the effect.
  const creating = useRef(false);
  useEffect(() => {
    if (!draftCreating || newestDocument.data === undefined || creating.current) return;
    creating.current = true;
    createDraft
      .mutateAsync({ document_yaml: newestDocument.data })
      .then((draft) => setDraftId(draft.id))
      .catch((error: unknown) => setFailure(error))
      .finally(() => {
        creating.current = false;
        setDraftCreating(false);
      });
  }, [draftCreating, newestDocument.data, createDraft]);

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
                    onClick={() => {
                      setRevisionKey(row.id);
                      setDraftId(null);
                    }}
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
                disabled={createDraft.isPending || !revisionRows[0]}
                data-testid="pipeline-new-draft"
                title={revisionRows[0] ? undefined : "nothing to clone — no published revision yet"}
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
                  selected={draftId === row.id}
                  className="h-auto flex-wrap cursor-pointer border-0 rounded-none px-[10px] py-[8px]"
                  data-testid={`draft-row-${row.id}`}
                >
                  <button
                    type="button"
                    className="flex flex-1 flex-wrap items-center gap-[6px] text-left focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
                    onClick={() => setDraftId(row.id)}
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
      </aside>
      <div className="min-w-0 space-y-4 px-4 py-4">
        {failure ? (
          <ProblemBanner
            error={failure}
            fallback="The draft could not be created."
            testid="pipeline-page-failure"
          />
        ) : null}
        {draftId ? (
          <DraftEditor
            pipelineId={pipelineId}
            draftId={draftId}
            canAuthor={canAuthor}
            headingId="pipeline-draft-editor-heading"
          />
        ) : null}
        {!draftId && revision.isError ? (
          <ProblemBanner
            error={revision.error}
            fallback="The selected revision could not be read."
          />
        ) : null}
        {!draftId && revision.data ? (
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
        {!draftId && revision.isPending && selectedRevisionKey ? (
          <Spinner label="Loading the revision document" />
        ) : null}
        {!draftId && newestPublished ? (
          <AssignToProjectPanel
            pipelineId={pipelineId}
            newestPublishedDigest={newestPublished.revision_digest}
          />
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
