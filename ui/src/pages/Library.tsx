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
 *   `channels: []` and read "no channel set".
 * - A draft's state is the server's `status` column, never a client-side guess
 *   — which is why Publish is gated in `DraftEditor`, not here.
 * - Authoring controls (new pipeline, new draft, the editor) appear only for
 *   the library role: `01` gives definition-reading to every org member and
 *   publishing to org admins alone.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { useQueries } from "@tanstack/react-query";
import { Panel } from "../components/ds/Panel";
import { Row, StatusChip } from "../components/ds/Row";
import { Button } from "../components/ds/Button";
import { Field, Input } from "../components/ds/Field";
import { DRAFT_STATE, REVISION_STATE, stateOf } from "../components/ds/states";
import { ProblemBanner, Spinner } from "../components/Feedback";
import { DefinitionGraph } from "../components/m4/DefinitionGraph";
import { DraftEditor } from "../components/m4/DraftEditor";
import { PipelineLibrary, type PipelineLibraryRow } from "../components/m4/PipelineLibrary";
import { YamlView } from "../components/m4/YamlView";
import { problemOf } from "../api/client";
import { useMe } from "../api/queries";
import {
  pipelineDraftsQueryOptions,
  pipelineQueryOptions,
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
import type { DefinitionDocument } from "../lib/pipeline/definition";
import { shortDigest } from "../lib/pipeline/yamlPointer";

/* ------------------------------------------------------------- /library */

export function LibraryPage() {
  const navigate = useNavigate();
  const me = useMe();
  const pipelines = usePipelines();
  const canAuthor = me.data?.is_org_admin === true;
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
          canCreate={canAuthor}
          onNew={() => document.getElementById("library-new-slug")?.focus()}
          headingId="library-rows-heading"
          onOpen={(pipeline) => navigate(`/library/${pipeline.id}`)}
        />
      ) : null}
    </div>
  );
}

/** `POST /pipelines` — the logical definition only (ADR-0002): a slug and a
 * name create nothing that runs, because a pipeline has no revision until a
 * draft validates and publishes. */
function NewPipelineForm() {
  const create = useCreatePipeline();
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");

  async function submit() {
    if (slug.trim() === "") return;
    try {
      await create.mutateAsync({ slug: slug.trim(), display_name: name.trim() || undefined });
      setSlug("");
      setName("");
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
        <Button
          type="submit"
          variant="primary"
          disabled={create.isPending || slug.trim() === ""}
          data-testid="library-new-submit"
        >
          {create.isPending ? "Creating…" : "Create pipeline"}
        </Button>
      </form>
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
  const me = useMe();
  const pipeline = usePipeline(pipelineId);
  const revisions = usePipelineRevisions(pipelineId);
  const drafts = usePipelineDrafts(pipelineId);
  const createDraft = useCreateDraft(pipelineId);
  const canAuthor = me.data?.is_org_admin === true;

  const [revisionKey, setRevisionKey] = useState<string | null>(null);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [draftCreating, setDraftCreating] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);

  // Server order is newest-first (`GET /pipelines/{id}/revisions`); nothing is
  // re-sorted here, and a pipeline that never published honestly has none.
  const revisionRows = useMemo(
    () => (revisions.data?.revisions ?? []).map(viewRevisionSummary),
    [revisions.data],
  );
  const draftRows = useMemo(() => (drafts.data?.drafts ?? []).map(viewDraftSummary), [drafts.data]);
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

  return (
    <div
      className="grid min-h-full grid-cols-[minmax(16rem,20rem)_minmax(0,1fr)]"
      data-testid="pipeline-page"
    >
      <aside className="min-w-0 space-y-4 border-r border-line px-3 py-3">
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
              <span className="font-mono text-[10px] font-normal">
                authoring needs the library role
              </span>
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
            {draftRows.map((row) => (
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
                  </button>
                </Row>
              </li>
            ))}
          </ul>
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
      </div>
    </div>
  );
}

export default LibraryPage;
