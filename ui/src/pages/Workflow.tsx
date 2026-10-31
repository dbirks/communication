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
 * The YAML tab is also the home of contract § 7.2 row W8's "Validate" panel
 * (`components/m4/ValidatePanel`): the row's own words place it in "the YAML
 * viewer's 'Validate' panel", so it sits under the YAML block behind one
 * collapsed disclosure, pinned to this workflow and shown only to a caller with
 * the library role (the `Edit workflow` check).
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
import { ProjectUnavailable } from "../components/ProjectUnavailable";
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
import { ValidatePanel } from "../components/m4/ValidatePanel";
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

  // `metadata.description` of the revision the page draws — the document's own
  // words, which is where a starter workflow or a YAML import carries its
  // description when the library row left it blank. Read, never guessed: a
  // document with no such member contributes nothing.
  const documentDescription = useMemo(() => {
    const metadata = (
      revision.data?.canonical_document as { metadata?: unknown } | null | undefined
    )?.metadata;
    const value = (metadata as { description?: unknown } | null | undefined)?.description;
    return typeof value === "string" ? value.trim() : "";
  }, [revision.data]);

  // First `published` in newest-first order — the pin `Use in a repo…`
  // creates and the Used-in rows compare against for `· latest`.
  const newestPublished = revisionRows.find((row) => row.status === "published") ?? null;
  // The summary route carries no uuid (ADR-0021 § 5); the pin POST and the
  // re-pin PATCH need one, so the digest → id resolution rides route 13.
  const newestPublishedRevision = useRevision(newestPublished?.revision_digest ?? "");

  // The description, from whichever of the two places the workflow carries it:
  // the library row's own member, else the newest revision's document metadata
  // (the design's 1e subtitle is the template's own sentence, which lives in
  // the YAML). Nothing is invented: no source, no subtitle but the library
  // sentence.
  const workflowDescription =
    (pipeline.data?.description ?? "").trim() !== ""
      ? (pipeline.data?.description ?? "").trim()
      : documentDescription;

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
    if (notFound) {
      return (
        <div data-testid="pipeline-page" className="min-h-[calc(100dvh-44px)] bg-paper">
          <div className="px-[22px] pt-[20px] md:px-[28px]">
            <ProjectUnavailable
              heading="Workflow"
              headingId="pipeline-load-error-heading"
              testid="pipeline-page-failure"
              copy="Workflow not found or you do not have access."
              hint="Check the link, or go back to Workflows and open it from the library list — a workflow you cannot see reads exactly like one that is not there."
              back={{
                to: routes.workflows(),
                label: "Workflows",
                testid: "workflow-back-to-list",
              }}
            />
          </div>
        </div>
      );
    }
    return (
      <div data-testid="pipeline-page" className="min-h-[calc(100dvh-44px)] bg-paper">
        <section
          aria-labelledby="pipeline-load-error-heading"
          className="px-[22px] pt-[20px] md:px-[28px]"
        >
          <header className="flex flex-col gap-[6px] border-b border-line pb-[12px]">
            <nav aria-label="Breadcrumb" className="font-mono text-[11px] text-muted">
              <Link
                to={routes.workflows()}
                className="text-accent-text hover:text-ink"
                data-testid="workflow-load-breadcrumb"
              >
                Workflows
              </Link>
              <span aria-hidden="true" className="px-1.5">
                /
              </span>
            </nav>
            <h1
              id="pipeline-load-error-heading"
              className="text-[22px] leading-[28px] font-semibold"
            >
              Workflow
            </h1>
          </header>
          <div className="mt-[12px] max-w-[70ch]">
            <ProblemBanner
              error={pipeline.error}
              fallback="The workflow could not be loaded."
              subject="the workflow"
              hint="Nothing of it is drawn without the read — no graph, no revision, no draft."
              retry={{
                onClick: () => void pipeline.refetch(),
                pending: pipeline.isFetching,
                testid: "workflow-load-retry",
              }}
              back={{
                to: routes.workflows(),
                label: "← Back to workflows",
                testid: "workflow-back-to-list",
              }}
              testid="pipeline-page-failure"
            />
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
                in full — it caps nothing), the library sentence only when it
                does not.
                A workflow carries its words in two places — the library row,
                or the document's own `metadata.description` (what a YAML
                import or a starter workflow writes) — and the review's 1e
                item is exactly the second one: a workflow WITH a description
                showed the generic sentence because only the row was read. */}
            <p className="max-w-[70ch] text-[13px] text-muted" data-testid="workflow-kind-line">
              {workflowDescription ||
                "Library workflow. It runs only in the repos that use it, and triggers are set up there."}
            </p>
            {/* The header's one extra line is the workflow's id, in the words
                the New workflow dialog already uses for it (1c: `id: retry-
                payments-plan`). The `· 1 revision` half is gone (2026-10-30 copy
                review, 1e item 2): the `PUBLISHED R1` chip above already states
                it, and a count under the description said the same fact twice.
                The id itself stays because the two lab journeys identify the
                opened workflow by it (`pipeline-header-meta` is what
                issue2-studio and shell-journey wait on) and it is the name the
                document carries in its own `name:` line. */}
            <p className="font-mono text-[11px] text-muted" data-testid="pipeline-header-meta">
              {`id: ${pipeline.data?.slug ?? pipelineId}`}
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
              // 1e item 2 (2026-10-30 copy review): the reason used to be a mono
              // sentence floating beside `Use in a repo…`, which read as a note
              // pinned to the header rather than a fact about the verb. It is now
              // the tooltip on the disabled verb — the button stays where the
              // design puts it, and its title says why it cannot be pressed. The
              // same words stand behind it for assistive tech (a `title` alone is
              // unreachable by keyboard).
              <>
                <Button
                  variant="primary"
                  compact
                  className="h-[30px]"
                  disabled
                  data-testid="pipeline-customize"
                  title={LIBRARY_AUTHORING_HINT}
                  aria-describedby="workflow-author-hint"
                >
                  Edit workflow
                </Button>
                <span className="sr-only" data-testid="workflow-author-hint">
                  {LIBRARY_AUTHORING_HINT}
                </span>
              </>
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
                    `Overview YAML Used in 2 History`. A failed read is NOT a
                    count and not a question mark either — the tab simply says
                    `Used in`, because a `?` in a number's seat is still a value
                    the page never read, and `Used in 0` over a broken fan says
                    “nobody uses this” when the truth is “we could not tell”
                    (pass-2 + pass-7 reviews, 2a server-error). The FAILED banner
                    in the panel says the thing in words. */}
                {key === "used-in" && !usedIn.loading && !usedIn.error ? (
                  <span
                    className="ml-[4px] font-mono text-[10.5px]"
                    data-testid="workflow-used-in-count"
                  >
                    {` ${usedIn.groups.length}`}
                  </span>
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
            canEdit={canAuthor}
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
            <div className="space-y-[10px]">
              <WorkflowYamlTab
                slug={pipeline.data?.slug ?? pipelineId}
                revisions={usedInRevisions}
              />
              {/* W8’s home (contract § 7.2: “the YAML viewer’s ‘Validate’ panel”) —
                  the authoring surface, so only a caller with the library role
                  (the same check as `Edit workflow`) ever sees the line. */}
              {canAuthor ? (
                <YamlValidateDisclosure
                  pipelineId={pipelineId}
                  slug={pipeline.data?.slug ?? pipelineId}
                  displayName={summary?.display_name ?? pipeline.data?.slug ?? "Workflow"}
                  initialText={revision.data?.document_text ?? ""}
                />
              ) : null}
            </div>
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
        workflowName={summary?.display_name ?? pipeline.data?.slug ?? ""}
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

/**
 * The YAML tab's `Validate a YAML document` disclosure — the panel contract
 * § 7.2 row W8 names ("the YAML viewer's 'Validate' panel") in its new home.
 *
 * Design 2d is the YAML block alone, so the panel is collapsed by default and
 * ONE click on this line opens it. Opening also mounts it: a hidden textarea,
 * select-free form and button should not sit in the tab order of a page that
 * shows none of them, and the panel only talks to the server when its own
 * button is pressed, so nothing is asked while the line is closed.
 *
 * It is pinned to THIS workflow — one pipeline, no picker — so there is no
 * library list to wait for and the Validate button arms the moment the box
 * holds text. The box is seeded from the newest revision the page already has
 * (what the old pipelines-page mount did); the tab's own revision picker does
 * not re-seed it, because the box is where a person pastes the document they
 * want the server to judge. The panel keeps its honesty rules: a textarea plus
 * a button is not an editor, and in-browser authoring stays M5's.
 *
 * Only the caller who can author mounts it (the `Edit workflow` check, same
 * predicate); the panel's own no-role refusal stays behind that as the honest
 * fallback for any future caller that forgets to ask.
 */
function YamlValidateDisclosure({
  pipelineId,
  slug,
  displayName,
  initialText,
}: {
  pipelineId: string;
  slug: string;
  displayName: string;
  initialText: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div data-testid="yaml-validate-disclosure-block">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? "yaml-validate-panel" : undefined}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-[6px] rounded-[3px] border border-line bg-surface px-[10px] py-[6px] text-left font-mono text-[11px] text-muted hover:border-line-strong hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
        data-testid="yaml-validate-disclosure"
        title="paste YAML, get the server's verdict through a scratch draft of this workflow"
      >
        <span aria-hidden="true">{open ? "▾" : "▸"}</span>
        Validate a YAML document
      </button>
      {open ? (
        <div id="yaml-validate-panel" data-testid="yaml-validate-panel-open">
          <ValidatePanel
            pipelines={[{ id: pipelineId, slug, displayName }]}
            canValidate
            pinnedPipelineId={pipelineId}
            initialText={initialText}
            headingId="yaml-validate-heading"
          />
        </div>
      ) : null}
    </div>
  );
}
