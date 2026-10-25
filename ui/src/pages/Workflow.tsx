/**
 * The workflow page (`/workflows/:pipelineId`, design 1e/2a/2d).
 *
 * A library workflow is a reusable template: it never runs by itself. A repo
 * uses it (an ADR-0060 assignment pinned to a revision), and runs and triggers
 * belong to that use — so this page has **no Start run and no trigger
 * editing**. It opens on the graph (top-to-bottom, read-only) with the right
 * rail that answers draft / used-in / inputs / last-runs; YAML, Used in and
 * History are their own routes, not fragments:
 *
 *   /workflows/:pipelineId            Overview
 *   /workflows/:pipelineId/yaml       the selected revision's block YAML (2d)
 *   /workflows/:pipelineId/used-in    every repo that uses it (2a)
 *   /workflows/:pipelineId/history    the REVISIONS and DRAFTS panels (1e)
 *
 * `Use in a repo…` pins the newest published revision to a repo (or the whole
 * project); `Edit workflow` is the one primary verb — it reopens the newest
 * open draft in the Studio, or creates a draft from the newest revision (the
 * old page's “Customize” logic, unchanged).
 *
 * Header/tabs/body follow the handoff's Shared page pattern: a white band
 * with a 22px H1 and tab links that sit on the band's bottom border, and a
 * `22px 28px` body whose two columns `minmax(0,1fr) 300px` stack below 1024px.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import { Button } from "../components/ds/Button";
import { StatusChip } from "../components/ds/Row";
import { REVISION_STATE, stateOf } from "../components/ds/states";
import { ProblemBanner, Spinner } from "../components/Feedback";
import { ApiError } from "../api/client";
import { UseInRepoDialog } from "../components/workflows/UseInRepoDialog";
import { UsedInPanel } from "../components/workflows/UsedIn";
import { useActorNames } from "../api/actors";
import { useMe } from "../api/queries";
import { viewDraftSummary, viewPipelineSummary, viewRevisionSummary } from "../api/m4view";
import {
  useCreateDraft,
  usePipeline,
  usePipelineDrafts,
  usePipelineRevisions,
  useRevision,
} from "../api/pipelines";
import { hasLibraryRole, LIBRARY_AUTHORING_HINT } from "../lib/pipeline/authoring";
import { BLANK_SKELETON_YAML, withMetadataName } from "../lib/pipeline/templates";
import { routes, type WorkflowTab } from "../lib/routes";
import { WorkflowHistoryTab } from "./workflow/HistoryTab";
import { WorkflowOverview } from "./workflow/Overview";
import { WorkflowYamlTab } from "./workflow/YamlTab";
import { usePipelineRuns, useUsedIn } from "./workflow/useUsedIn";

/** The header tabs, in design order. Counts trail the label where the count
 * means something (the Used-in n). */
const TABS: { key: WorkflowTab; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "yaml", label: "YAML" },
  { key: "used-in", label: "Used in" },
  { key: "history", label: "History" },
];

/**
 * One pipeline: graph-first Overview, YAML, Used in, History — the page the
 * Workflows Review handoff picked (1e + 2a + 2d).
 */
export function PipelinePage() {
  const { pipelineId = "" } = useParams();
  const location = useLocation();
  // The old URL shape stays valid: `/library/:id?draft=<id>` replace-navigates
  // to the Studio route, which owns the editor; the legacy `/library/:id`
  // paths arrive here through the App.tsx redirects.
  const [draftParams] = useSearchParams();
  const navigate = useNavigate();
  const redirectDraft = draftParams.get("draft");
  useEffect(() => {
    if (redirectDraft) {
      // Keep the caller's own base prefix: in the app `/library/:id?draft=`
      // arrives only through the App.tsx redirect (so this is `/workflows`),
      // while a direct `/library` mount (Studio's legacy-URL test) stays on
      // the prefix it was mounted under.
      const base = location.pathname.startsWith("/library") ? "library" : "workflows";
      navigate(
        `/${base}/${encodeURIComponent(pipelineId)}/drafts/${encodeURIComponent(redirectDraft)}`,
        { replace: true },
      );
    }
  }, [redirectDraft, pipelineId, navigate, location.pathname]);

  // The tab is the route: the third path segment (works under both
  // `/workflows/:id/…` and a direct `/library/:id` mount).
  const segments = location.pathname.split("/").filter(Boolean);
  const tab: WorkflowTab =
    segments[2] === "yaml" || segments[2] === "used-in" || segments[2] === "history"
      ? segments[2]
      : "overview";

  // Same bleed as `pages/RunInspector.tsx`: the shell's centred reading
  // column is ~64rem, and a graph plus a 300px rail squeezed into it clips
  // everything. This page bleeds out to the shell's content column —
  // `<main>`'s parent: the flex-1 region right of the 240px sticky sidebar —
  // never under the sidebar.
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

  const me = useMe();
  const actors = useActorNames();
  // The one role rule, in the one place the UI states it.
  const canAuthor = hasLibraryRole(me.data);

  const pipeline = usePipeline(pipelineId);
  // Sub-resource reads ride on the pipeline read: a missing id gets exactly
  // one honest 404 (the refusal this page renders), not a `/revisions` and a
  // `/drafts` 404 beside it (the emulator counts every undeclared failure).
  const revisions = usePipelineRevisions(pipelineId, pipeline.isSuccess);
  const drafts = usePipelineDrafts(pipelineId, pipeline.isSuccess);
  const createDraft = useCreateDraft(pipelineId);

  // Server order is newest-first (`GET /pipelines/{id}/revisions`); nothing is
  // re-sorted here, and a pipeline that never published honestly has none.
  const revisionRows = useMemo(
    () => (revisions.data?.revisions ?? []).map(viewRevisionSummary),
    [revisions.data],
  );
  const draftRows = useMemo(() => (drafts.data?.drafts ?? []).map(viewDraftSummary), [drafts.data]);
  // Newest first by the server's own `updated_at`.
  const sortedDrafts = useMemo(
    () => [...draftRows].sort((a, b) => b.updated_at.localeCompare(a.updated_at)),
    [draftRows],
  );
  // The newest draft that is not yet a revision — the one `Edit workflow`
  // reopens and the rail's OPEN DRAFT card names.
  const openDraft = useMemo(
    () => sortedDrafts.find((draft) => draft.status !== "published") ?? null,
    [sortedDrafts],
  );

  // The graph and the rail read the newest revision (the YAML tab can select
  // another one itself).
  const selectedRevisionKey = revisionRows[0]?.id ?? null;
  const revision = useRevision(selectedRevisionKey ?? "");

  // First `published` in newest-first order — the pin `Use in a repo…`
  // creates and the Used-in rows compare against for `· latest`.
  const newestPublished = revisionRows.find((row) => row.status === "published") ?? null;
  // The summary route carries no uuid (ADR-0021 § 5); the pin POST and the
  // re-pin PATCH need one, so the digest → id resolution rides route 13.
  const newestPublishedRevision = useRevision(newestPublished?.revision_digest ?? "");

  const usedIn = useUsedIn(pipelineId);
  const runs = usePipelineRuns(pipelineId);

  const [useDialogOpen, setUseDialogOpen] = useState(false);
  const [draftCreating, setDraftCreating] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);

  // The clone is a one-shot: a ref, not `isPending`, because the mutation
  // object is new every render and would re-fire the effect. With zero
  // revisions there is nothing to clone, so the draft is seeded from the
  // blank skeleton instead — named for this pipeline's slug — and the wait on
  // the revisions and pipeline reads keeps the decision from racing the
  // queries.
  const creating = useRef(false);
  useEffect(() => {
    if (!draftCreating || creating.current) return;
    const cloneDocument = revision.data?.document_text;
    if (cloneDocument === undefined) {
      if (revisions.data === undefined || pipeline.data === undefined) return;
      if (revisionRows.length > 0) return;
    }
    creating.current = true;
    const documentYaml =
      cloneDocument ?? withMetadataName(BLANK_SKELETON_YAML, pipeline.data?.slug ?? pipelineId);
    createDraft
      .mutateAsync({ document_yaml: documentYaml })
      .then((draft) => navigate(routes.draft(pipelineId, draft.id)))
      .catch((error: unknown) => setFailure(error))
      .finally(() => {
        creating.current = false;
        setDraftCreating(false);
      });
  }, [
    draftCreating,
    revision.data,
    revisions.data,
    pipeline.data,
    revisionRows.length,
    pipelineId,
    createDraft,
    navigate,
  ]);

  // A pipeline the reader cannot open is not a page that renders the id as a
  // title: the read itself decides what the page says (design 1e; the
  // Repository/Conversation pattern). A 404 is an honest not-found, any other
  // failure quotes the server and offers a retry, and both carry the way back
  // to the index. All hooks have run by this point.
  if (pipeline.isPending) return <Spinner label="Loading workflow" />;
  if (pipeline.isError) {
    const notFound = pipeline.error instanceof ApiError && pipeline.error.status === 404;
    return (
      <div data-testid="pipeline-page" className="min-h-[calc(100dvh-44px)] bg-paper">
        <section
          aria-labelledby="pipeline-load-error-heading"
          className="px-[22px] py-[22px] md:px-[28px]"
        >
          <h1 id="pipeline-load-error-heading" className="text-[22px] leading-[28px] font-semibold">
            Workflow
          </h1>
          <div className="mt-[12px] max-w-[70ch]">
            <ProblemBanner
              error={pipeline.error}
              fallback={
                notFound
                  ? "Workflow not found or you do not have access."
                  : "The workflow could not be loaded."
              }
              testid="pipeline-page-failure"
            />
          </div>
          <div className="mt-[12px] flex flex-wrap items-center gap-[8px]">
            {notFound ? null : (
              <Button
                variant="secondary"
                compact
                className="h-[30px]"
                onClick={() => void pipeline.refetch()}
                disabled={pipeline.isFetching}
                data-testid="workflow-load-retry"
              >
                {pipeline.isFetching ? "Retrying…" : "Retry"}
              </Button>
            )}
            <Link
              to={routes.workflows()}
              className="ds-btn ds-btn--secondary h-[30px]"
              data-testid="workflow-back-to-list"
            >
              ← Back to workflows
            </Link>
          </div>
        </section>
      </div>
    );
  }

  const summary = pipeline.data ? viewPipelineSummary(pipeline.data) : null;
  const usedInRevisions = revisionRows.map((row) => ({
    id: row.id,
    revision_number: row.revision_number,
    revision_digest: row.revision_digest,
    version_label: row.version_label,
    status: row.status,
  }));

  /** `Edit workflow`: the newest open draft in the Studio, else a fresh draft
   * from the newest revision (or the blank skeleton when there is none). */
  function editWorkflow() {
    if (openDraft) {
      navigate(routes.draft(pipelineId, openDraft.id));
      return;
    }
    setFailure(null);
    setDraftCreating(true);
  }

  return (
    <div
      ref={attachRoot}
      data-testid="pipeline-page"
      data-full-width={bleed ? bleed.width : "unmeasured"}
      className="flex min-h-[calc(100dvh-44px)] flex-col bg-paper md:min-h-dvh"
      style={
        bleed
          ? { width: bleed.width || undefined, marginLeft: -bleed.offset, maxWidth: "none" }
          : { maxWidth: "none" }
      }
    >
      {/* ------------------------------------------------------- header band */}
      <header className="flex flex-col gap-[12px] border-b border-line-strong bg-surface px-[28px] pt-[20px]">
        {/* Header rows stack on phones (390px): breadcrumb, title + chip,
            description, then the actions in their own row — never beside the
            title, which squeezed the description into a 100px column. */}
        <div
          className="flex flex-col gap-[12px] md:flex-row md:flex-wrap md:items-start md:gap-[16px]"
          data-testid="workflow-header-top"
        >
          <div className="flex min-w-0 flex-1 flex-col gap-[4px]">
            <nav
              aria-label="Breadcrumb"
              className="font-mono text-[11px] text-muted"
              data-testid="workflow-breadcrumb"
            >
              <Link
                to={routes.workflows()}
                className="text-accent-text hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
              >
                Workflows
              </Link>
              {pipeline.data?.folder ? (
                <>
                  {" / "}
                  <Link
                    to={`${routes.workflows()}?folder=${encodeURIComponent(pipeline.data.folder)}`}
                    className="text-accent-text hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
                  >
                    {pipeline.data.folder}
                  </Link>
                </>
              ) : null}
              {" /"}
            </nav>
            <div className="flex flex-wrap items-center gap-[10px]">
              <h1 className="text-[22px] leading-[28px] font-semibold" id="pipeline-heading">
                {summary?.display_name ?? pipeline.data?.slug ?? "Workflow"}
              </h1>
              {revisionRows[0] ? (
                <StatusChip
                  state={stateOf(REVISION_STATE[revisionRows[0].status])}
                  label={`${revisionRows[0].status} r${revisionRows[0].revision_number}`}
                  labelProps={{ "data-testid": "workflow-revision-chip" }}
                />
              ) : (
                <span
                  className="font-mono text-[10.5px] text-muted"
                  data-testid="workflow-revision-chip"
                >
                  · draft · not published
                </span>
              )}
            </div>
            {/* One subtitle, two sources (2a/1e): the workflow's own
                description when it has one (the design shows the description
                — two lines max), the library sentence only when it does not. */}
            <p
              className="line-clamp-2 max-w-[70ch] text-[13px] text-muted"
              data-testid="workflow-kind-line"
            >
              {pipeline.data?.description ||
                "Library workflow. It runs only in the repos that use it, and triggers are set up there."}
            </p>
            <p className="font-mono text-[11px] text-muted" data-testid="pipeline-header-meta">
              {pipeline.data?.slug ?? pipelineId} ·{" "}
              {pipeline.data?.revision_count === 1
                ? "1 revision"
                : `${pipeline.data?.revision_count ?? 0} revisions`}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-[8px]">
            {newestPublished ? (
              <Button
                variant="secondary"
                compact
                className="h-[30px]"
                onClick={() => {
                  setFailure(null);
                  setUseDialogOpen(true);
                }}
                data-testid="assign-open"
                title="Pin the newest published revision to a repo (or a whole project)"
              >
                Use in a repo…
              </Button>
            ) : null}
            {canAuthor ? (
              // The one primary verb (1e): reopen the open draft, or create one
              // from the newest revision — the old “Customize”, named for what
              // it does now. The test id stays for the e2e suites.
              <Button
                variant="primary"
                compact
                className="h-[30px]"
                onClick={editWorkflow}
                disabled={createDraft.isPending || draftCreating}
                data-testid="pipeline-customize"
                title={
                  openDraft
                    ? "continue the newest open draft in the Studio"
                    : "new draft from the newest revision — opens the Studio canvas"
                }
              >
                {createDraft.isPending || draftCreating ? "Opening…" : "Edit workflow"}
              </Button>
            ) : (
              <span
                className="font-mono text-[10.5px] text-faint"
                data-testid="workflow-author-hint"
              >
                {LIBRARY_AUTHORING_HINT}
              </span>
            )}
          </div>
        </div>
        {/* Header tabs are routes: links that sit on the band's bottom border
            (13px, `6px 12px 7px`; the active one gets the ink border, paper
            bottom, `bg-paper`, weight 600). `overflow-x-auto` keeps them
            scrollable inside their own row at 390px. */}
        <nav
          aria-label="Workflow page"
          className="-mb-px flex gap-[4px] overflow-x-auto"
          data-testid="workflow-tabs"
        >
          {TABS.map(({ key, label }) => {
            const active = tab === key;
            return (
              <Link
                key={key}
                to={routes.workflowTab(pipelineId, key)}
                aria-current={active ? "page" : undefined}
                className={`shrink-0 whitespace-nowrap rounded-t-[3px] border px-[12px] pt-[6px] pb-[7px] text-[13px] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent ${
                  active
                    ? "border-ink border-b-paper bg-paper font-semibold text-ink"
                    : "border-transparent text-muted"
                }`}
                data-testid={`workflow-tab-${key}`}
              >
                {label}
                {/* Only the Used-in count means something (shared page
                    pattern): the design's tab row is
                    `Overview YAML Used in 2 History`. */}
                {key === "used-in" && !usedIn.loading ? (
                  <span className="ml-[4px] font-mono text-[10.5px]">{` ${usedIn.groups.length}`}</span>
                ) : null}
              </Link>
            );
          })}
        </nav>
      </header>

      {/* -------------------------------------------------------------- body */}
      {/* The failure banner rides above every tab. Overview is edge to edge
          (the dotted canvas runs to the rail, the rail to the page edge —
          design 1e); the other tabs keep the pattern's `22px 28px` padding. */}
      {failure ? (
        <div className="px-[22px] pt-[10px] md:px-[28px]">
          <ProblemBanner
            error={failure}
            fallback="The draft could not be created."
            testid="pipeline-page-failure"
          />
        </div>
      ) : null}
      {/* Overview body: block-level wrapper on purpose (pass-3) — a row
          flex would content-size the grid and collapse the canvas to the
          dagre box width. As a block child the grid fills the page column:
          canvas = flex-1, rail = 285px. */}
      {tab === "overview" ? (
        <div className="flex min-w-0 flex-1 flex-col">
          <WorkflowOverview
            pipelineId={pipelineId}
            revision={revision.data}
            revisionLoading={revision.isPending && selectedRevisionKey !== null}
            revisionError={revision.isError ? revision.error : null}
            groups={usedIn.groups}
            usedInLoading={usedIn.loading}
            runs={runs}
            openDraft={openDraft}
            actorName={actors.nameOf}
            onAssign={() => {
              setFailure(null);
              setUseDialogOpen(true);
            }}
          />
        </div>
      ) : null}
      {tab !== "overview" ? (
        <div className="flex-1 px-[22px] py-[22px] md:px-[28px]">
          {tab === "yaml" ? (
            <WorkflowYamlTab slug={pipeline.data?.slug ?? pipelineId} revisions={usedInRevisions} />
          ) : null}
          {tab === "used-in" ? (
            <div className="max-w-[980px]">
              <UsedInPanel
                pipelineId={pipelineId}
                groups={usedIn.groups}
                loading={usedIn.loading}
                error={usedIn.error}
                revisions={usedInRevisions}
                newestPublished={
                  newestPublished
                    ? (usedInRevisions.find((r) => r.id === newestPublished.id) ?? null)
                    : null
                }
                newestPublishedId={newestPublishedRevision.data?.id ?? null}
              />
            </div>
          ) : null}
          {tab === "history" ? (
            <WorkflowHistoryTab
              pipelineId={pipelineId}
              revisionRows={revisionRows}
              revisionsPending={revisions.isPending}
              revisionsError={revisions.isError ? revisions.error : null}
              sortedDrafts={sortedDrafts}
              draftsPending={drafts.isPending}
              draftsError={drafts.isError ? drafts.error : null}
              canAuthor={canAuthor}
              createDraftPending={createDraft.isPending || draftCreating}
              actorName={actors.nameOf}
              onNewDraft={() => {
                setFailure(null);
                setDraftCreating(true);
              }}
            />
          ) : null}
        </div>
      ) : null}

      <UseInRepoDialog
        open={useDialogOpen}
        onClose={() => setUseDialogOpen(false)}
        pipelineId={pipelineId}
        newestPublished={
          newestPublished
            ? (usedInRevisions.find((row) => row.id === newestPublished.id) ?? null)
            : null
        }
        revisions={usedInRevisions}
        onAssigned={() => navigate(routes.workflowTab(pipelineId, "used-in"))}
      />
    </div>
  );
}
