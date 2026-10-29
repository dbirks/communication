/**
 * `/projects/:projectId/runs/:runId` — the run inspector as a real route, laid
 * out like the design's run view (references 3b/3d/4a): runs column on the
 * left, header + Definition | Execution | Timeline panes in the middle, the
 * selected node's detail on the right.
 *
 * Everything here is live: the same hooks the `/__m4-preview?source=live`
 * seam proved (`api/runs.ts`, `api/pipelines.ts`, `api/approvals.ts`,
 * `api/runEvents.ts`) mapped through `api/m4view.ts` onto the components in
 * `components/m4/`. Node selection lives in `?node=<nodeExecutionId>` so a
 * pane is linkable from anywhere — including the § 7 W-legs.
 *
 * Honesty: an unreadable run answers 404 and renders a 404, never an empty
 * inspector; frames from the event stream paint but the reads confirm them;
 * Pause/Resume/Cancel are requests with receipts, so the button reflects the
 * run the server last reported, not the one just asked for.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Alert } from "../components/ds/Alert";
import { Button } from "../components/ds/Button";
import { ApprovalCard } from "../components/m4/ApprovalCard";
import { ProblemBanner, Spinner } from "../components/Feedback";
import { AttemptDetail, AttemptAgentWork } from "../components/m4/AttemptDetail";
import { BranchGrid } from "../components/m4/BranchGrid";
import { branchPlaceOf, branchesOf, findBranch } from "../lib/pipeline/branches";
import { useActorNames } from "../api/actors";
import { DefinitionGraph } from "../components/m4/DefinitionGraph";
import { NodePaneHeader } from "../components/m4/NodePaneHeader";
import { RunStageStrip } from "../components/m4/RunStageStrip";
import { RunTree } from "../components/m4/RunTree";
import { usePipelineRevisions, usePipelines, useRevision } from "../api/pipelines";
import {
  adoptApprovalConflict,
  approvalConflictOf,
  useDecideApproval,
  useProjectApprovals,
} from "../api/approvals";
import {
  runConflictOf,
  useCancelRun,
  usePauseRun,
  useResumeRun,
  useRetryRun,
  useRun,
  useRunNode,
  useRunNodes,
  useRunTree,
} from "../api/runs";
import { useRunEvents } from "../api/runEvents";
import { problemOf } from "../api/client";
import { useMe, useProject } from "../api/queries";
import {
  viewApproval,
  viewAttempt,
  viewNodeExecution,
  viewRun,
  viewRunCheckpoint,
  viewRunTree,
} from "../api/m4view";
import { normalizeRunFrames, projectRun, toRunEvent } from "../lib/pipeline/runEvents";
import { formatTime, shortCommit } from "../lib/format";
import {
  isScopeKind,
  scopeBody,
  type DefinitionDocument,
  type DefinitionNode,
} from "../lib/pipeline/definition";
import type {
  NodeExecutionStatus,
  NodeExecutionSummary,
  RunDetail,
  RunEvent,
  RunEventType,
  RunTreeRoot,
} from "../lib/pipeline/contract";
import type { EventActor, EventEnvelope, PipelineRevisionSummaryList } from "../api/types";
import {
  ProjectSectionNav,
  RunStatusChip,
  RunsListColumn,
  shortDigest,
  shortId,
} from "./ProjectRuns";
import { routes } from "../lib/routes";
import { NewRevisionNotice } from "../components/workbench/RunHeader";

type Tab = "definition" | "execution" | "timeline";
const TABS: readonly { id: Tab; label: string }[] = [
  { id: "definition", label: "Definition" },
  { id: "execution", label: "Execution" },
  { id: "timeline", label: "Timeline" },
];

/* ------------------------------------------- the diagnostics grid's columns */

/** Three panes sit side by side once their own ceilings fit with room for the
 * middle one: the runs column reads at 13–15rem, the node detail at 22.5–26rem
 * (the run view's drawn width) and a stage strip, a definition graph or a
 * branch grid under ~19rem is a caption rather than a work surface. 1040px —
 * the workbench `<main>` with its dock CLOSED at 1280 — clears it with 384px
 * left for the panes, which is the look the run view was drawn at, unchanged. */
export const DIAGNOSTICS_PANES_MIN = 960;
/** Two panes — the runs list beside the strip/graph/tree, the node detail
 * under them across the full width — need the runs column's 15rem ceiling plus
 * that same middle pane. 593px — the workbench `<main>` with the 440px dock
 * OPEN at 1280 — clears it and leaves the middle pane 353px, the width the
 * stage strip says it is drawn for. */
export const DIAGNOSTICS_SPLIT_MIN = 540;

/** What the grid does at a measured width: all three panes across, the runs
 * column across with the detail below it, or one stacked column (the 390
 * reflow, which is also the answer when nothing has been measured yet). */
export type DiagnosticsTier = "panes" | "split" | "stacked";

export function diagnosticsTierFor(width: number): DiagnosticsTier {
  if (width >= DIAGNOSTICS_PANES_MIN) return "panes";
  if (width >= DIAGNOSTICS_SPLIT_MIN) return "split";
  return "stacked";
}

/** How the runs list reads at each tier: the collapse control still reaches it,
 * so the collapsed rail is its own template rather than a hidden column.
 *
 * Every class here is written OUT in full, never built from pieces: Tailwind
 * scans the source as text, so an interpolated `grid-cols-[${nav}_${PANES}]`
 * compiles to no rule at all and the grid silently falls back to one implicit
 * column per child — the failure this page is about, only harder to see. Each
 * template is `minmax` floors with an `fr` middle, so no tier can ask for more
 * than its host has and paint the difference under the workbench dock. */
const LAYOUT: Record<DiagnosticsTier, { open: string; shut: string }> = {
  panes: {
    open: "grid-cols-[minmax(13rem,15rem)_minmax(0,1fr)_minmax(22.5rem,26rem)]",
    shut: "grid-cols-[2.25rem_minmax(0,1fr)_minmax(22.5rem,26rem)]",
  },
  split: {
    open: "grid-cols-[minmax(13rem,15rem)_minmax(0,1fr)]",
    shut: "grid-cols-[2.25rem_minmax(0,1fr)]",
  },
  stacked: { open: "grid-cols-1", shut: "grid-cols-1" },
};

export interface DiagnosticsLayout {
  /** which tier the width cleared */
  tier: DiagnosticsTier;
  /** the grid element's own column classes (replaces the `xl:` template) */
  grid: string;
  /** the runs column's separating border */
  nav: string;
  /** the node detail's placement and separating border */
  detail: string;
}

export function diagnosticsLayoutFor(width: number, navOpen: boolean): DiagnosticsLayout {
  const tier = diagnosticsTierFor(width);
  const grid = navOpen ? LAYOUT[tier].open : LAYOUT[tier].shut;
  if (tier === "panes")
    return { tier, grid, nav: "border-r border-line", detail: "border-l border-line" };
  if (tier === "split")
    return {
      tier,
      grid,
      nav: "border-r border-line",
      // The detail is the whole run of the row under the other two panes.
      detail: "col-span-2 border-t border-line",
    };
  return { tier, grid, nav: "border-b border-line", detail: "border-t border-line" };
}

export default function RunInspector({
  embedded = false,
}: {
  /** The Run Workbench's Diagnostics tab hosts the inspector whole, under the
   * workbench's own header — `embedded` hides the page's header (and the
   * revision notice that rides under it, since the workbench header shows the
   * same one). Behaviour is otherwise unchanged. */
  embedded?: boolean;
}) {
  const { projectId = "", runId = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = readTab(params.get("tab"));
  const selectedNodeId = params.get("node");
  const selectedBranch = readBranchIndex(params.get("branch"));
  // The run view owns the whole viewport: the shell's centred reading column is
  // about 64rem wide, and a graph squeezed into what is left of it shows one
  // node. So this page measures the shell's content column — `<main>`'s parent:
  // the flex-1 region right of the 240px sticky sidebar (the full width below
  // `md`, where the sidebar is a drawer) — and bleeds out to its edges, never
  // under the sidebar. The old `marginLeft: -left, width: viewport` assumed
  // the top-bar layout where content started at x=0 and parked this page
  // under the sticky column.
  //
  // Embedded in the Run Workbench there is nothing outside `<main>` to bleed
  // out to: its parent is the flex row that ALSO carries the node-detail dock,
  // and measuring that row (as this page did) made the grid 1040px wide inside
  // a 593px column, so the node detail and the right pixel of every stage cell
  // painted underneath the dock. Embedded, the measured column is `<main>`'s own
  // box — 593px with the 440px dock open at 1280, 1040px with it collapsed and
  // 390px on a phone — and that width picks the column tier
  // (`diagnosticsLayoutFor`) instead of the viewport.
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [bleed, setBleed] = useState<{ offset: number; width: number } | null>(null);
  const [navOpen, setNavOpen] = useState(true);
  /** Measure from the parent, never from the element itself: the parent's
   * content-box left is the child's static position and does not move when the
   * child's own negative margin does. */
  const measureBleed = useCallback(() => {
    const el = rootRef.current;
    const parent = el?.parentElement;
    if (!el || !parent) return;
    const main = el.closest("main");
    const column = embedded ? main : (main?.parentElement ?? null);
    const columnStyle = column ? window.getComputedStyle(column) : null;
    const padding = column
      ? parseFloat(columnStyle?.paddingLeft || "0") + parseFloat(columnStyle?.paddingRight || "0")
      : 0;
    // Standalone the shell column keeps its own gutter, so its content box is
    // the bleed. Embedded `<main>`'s padding is the workbench header's gutter
    // and the grid has always run into it: its border box is the space.
    const columnWidth = column ? column.clientWidth - (embedded ? 0 : padding) : 0;
    const staticLeft =
      parent.getBoundingClientRect().left +
      parseFloat(window.getComputedStyle(parent).paddingLeft || "0");
    const offset = column ? staticLeft - column.getBoundingClientRect().left : 0;
    // An embedded grid that has not been measured yet takes the narrow answer
    // — stacking is never wrong, painting under the dock is — while the
    // standalone page falls back to the viewport, which is the column it bleeds
    // to once it is mounted.
    const width =
      columnWidth > 0
        ? columnWidth
        : embedded
          ? 0
          : document.documentElement.clientWidth || window.innerWidth || el.offsetWidth;
    // Equal values do not re-render: this runs from a ref callback, and a new
    // object every time would be a render loop with a measurement in it.
    setBleed((current) =>
      current && current.offset === offset && current.width === width ? current : { offset, width },
    );
  }, [embedded]);
  // A ref callback rather than an effect: the page is a loading skeleton for its
  // first paint, and an effect that ran once would have measured nothing and
  // never come back. It stays stable across renders for the same reason — a new
  // callback identity every render would re-attach the ref on every commit.
  // Embedded, it also watches `<main>` itself: the workbench dock is resized
  // with the pointer and collapsed with a button, and neither is a window
  // resize, so a window listener alone would leave the columns on the width
  // the host had when the page first painted.
  const spaceWatcher = useRef<ResizeObserver | null>(null);
  const attachRoot = useCallback(
    (node: HTMLDivElement | null) => {
      rootRef.current = node;
      spaceWatcher.current?.disconnect();
      spaceWatcher.current = null;
      if (!node) return;
      measureBleed();
      const column = embedded ? node.closest("main") : null;
      if (column && typeof ResizeObserver !== "undefined") {
        const watcher = new ResizeObserver(() => measureBleed());
        watcher.observe(column);
        spaceWatcher.current = watcher;
      }
    },
    [embedded, measureBleed],
  );
  useEffect(
    () => () => {
      spaceWatcher.current?.disconnect();
      spaceWatcher.current = null;
    },
    [],
  );
  useEffect(() => {
    window.addEventListener("resize", measureBleed);
    return () => window.removeEventListener("resize", measureBleed);
  }, [measureBleed]);

  const runQuery = useRun(runId);
  // The canonical run page is `/runs/:runId` — the workbench's deep link
  // (ADR-0043): `RunDeepLink` resolves the project off the run read and hands
  // it to `RunWorkbench` as a prop, so on this page `useParams` carries no
  // `projectId` at all. Every project-scoped read here is `enabled` on a
  // non-empty id, so passing the empty string left them `isPending` forever
  // without ever issuing a request — that is how the Diagnostics Runs column
  // sat on "Loading runs…" with all-zero counts over a project with runs.
  // The run's own read names its project; fall back to it.
  const scopedProjectId = projectId || runQuery.data?.project_id || "";
  const nodesQuery = useRunNodes(runId);
  const treeQuery = useRunTree(runId);
  const pipelines = usePipelines();
  const stream = useRunEvents(runId, scopedProjectId);

  const baseRun = useMemo(() => (runQuery.data ? viewRun(runQuery.data) : null), [runQuery.data]);
  // W4 (`docs/m4-contract.md` § 7.2): the revisions list is what turns "a new
  // revision was published while this run lived" into a visible notice. The
  // run itself carries only the pinned digest, so the pinned number is read
  // off the same list; the reads are polled with the page, not just the stream.
  const revisionsQuery = usePipelineRevisions(baseRun?.pipeline_id ?? "");
  const revisionNotice = useMemo(
    () => (baseRun ? newerRevisionNotice(baseRun, revisionsQuery.data) : null),
    [baseRun, revisionsQuery.data],
  );
  const baseNodes = useMemo(
    () => (nodesQuery.data?.node_executions ?? []).map(viewNodeExecution),
    [nodesQuery.data],
  );
  // Frames paint first; the invalidated reads confirm (ADR-0014).
  const projection = useMemo(
    () => projectRun({ run: baseRun, nodes: baseNodes }, stream.events),
    [baseRun, baseNodes, stream.events],
  );

  const slugsById = useMemo(
    () => new Map((pipelines.data?.pipelines ?? []).map((p) => [p.id, p.slug])),
    [pipelines.data],
  );
  // 4a draws the stage strip as a compact header across the run, not as
  // content that hides behind a tab — so the page itself owns the read. Same
  // cached revision as the Definition tab: one request, two readers.
  const stripRevision = useRevision(baseRun?.revision_digest ?? "");
  const definitionOrder = useMemo(
    () =>
      stripRevision.data
        ? definitionOrderOf(stripRevision.data.canonical_document as unknown as DefinitionDocument)
        : undefined,
    [stripRevision.data],
  );
  const tree = useMemo(
    () => (treeQuery.data ? viewRunTree(treeQuery.data, (id) => slugsById.get(id) ?? id) : null),
    [treeQuery.data, slugsById],
  );

  const selectedNode =
    projection.nodes.find((node) => node.id === selectedNodeId) ??
    projection.nodes.find((node) => node.id === attentionNodeId(projection.nodes)) ??
    null;
  /** The graph keys a node by its instance key without iteration suffixes, the
   * tree keys a row by the full instance key; the URL carries the execution id
   * and both handles are derived from it. */
  const graphKey = selectedNode ? graphKeyOf(selectedNode.node_instance_key) : null;
  const instanceKey = selectedNode?.node_instance_key ?? null;

  const selectNodeById = (id: string | null) =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (id) next.set("node", id);
        else next.delete("node");
        return next;
      },
      { replace: true },
    );
  /** The three panes select by different handles — the graph and the tree by
   * instance key, the strip by definition node id — and the URL carries one
   * thing: the node execution id. */
  const selectNode = (handle: string | null) => {
    if (!handle) return selectNodeById(null);
    const exact = projection.nodes.find(
      (node) => node.id === handle || node.node_instance_key === handle,
    );
    const byGraph = projection.nodes.find(
      (node) => graphKeyOf(node.node_instance_key) === graphKeyOf(handle),
    );
    const byNodeId = projection.nodes.find(
      (node) => node.node_id === handle || node.node_instance_key === `/${handle}`,
    );
    selectNodeById((exact ?? byGraph ?? byNodeId)?.id ?? null);
  };
  /**
   * A branch cell click. `?branch=` carries the index so the grid view is
   * linkable on its own, and `?node=` moves to that branch's latest node
   * execution, so the right pane shows the work the cell stands for. A branch
   * the run has not started has no row yet — the index is still the truth the
   * reader asked for, so only `?branch=` changes.
   */
  const selectBranch = (scope: string, index: number) => {
    const target = branchTargetNode(projection.nodes, scope, index);
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.set("branch", String(index));
        if (target) next.set("node", target.id);
        return next;
      },
      { replace: true },
    );
  };
  const setTab = (next: Tab) =>
    setParams(
      (current) => {
        const withTab = new URLSearchParams(current);
        withTab.set("tab", next);
        return withTab;
      },
      { replace: true },
    );

  /* ---------------------------------------------------------- error states */

  if (runQuery.isError) {
    const problem = problemOf(runQuery.error);
    if (problem.status === 404) {
      return (
        <div className="px-4 py-6" data-testid="run-not-found">
          <Alert state="info" label="NOT FOUND" barTone="neutral" role="status">
            Run <code className="font-mono">{runId}</code> is not visible to you, or does not exist.
            The control plane answered 404 — this page shows no scaffold for a run it cannot see.
          </Alert>
        </div>
      );
    }
    return (
      <div className="px-4 py-6">
        <ProblemBanner error={runQuery.error} fallback="This run could not be loaded." />
      </div>
    );
  }
  if (nodesQuery.isError) {
    return (
      <div className="px-4 py-6">
        <ProblemBanner error={nodesQuery.error} fallback="Node executions could not be loaded." />
      </div>
    );
  }
  if (runQuery.isPending || !projection.run) {
    return (
      <div className="px-4 py-6">
        <Spinner label="Loading run" />
      </div>
    );
  }

  const run = projection.run;
  const slug = slugsById.get(run.pipeline_id) ?? run.pipeline_id;
  // Runs column on the left (collapsible), the panes flexible in the middle —
  // never less than about 60% of what is left — and the node's detail on the
  // right at the 360–420px the run view is drawn at.
  //
  // As its own route the page bleeds to the shell's whole content column, so
  // the viewport and the grid's width are the same number and `xl:` is honest.
  // In the workbench's Diagnostics tab it is not: `<main>` is 593px wide with
  // the 440px dock open at 1280 and 1040px with it collapsed, so the tiers are
  // read off the measured width (`diagnosticsLayoutFor`) instead of the
  // viewport — the one template the viewport offers is the wide one, and drawn
  // into 593px it put the node detail under the dock.
  const paneLayout = embedded ? diagnosticsLayoutFor(bleed?.width ?? 0, navOpen) : null;
  const tracks = navOpen
    ? "xl:grid-cols-[minmax(13rem,15rem)_minmax(0,1fr)_minmax(22.5rem,26rem)]"
    : "xl:grid-cols-[2.25rem_minmax(0,1fr)_minmax(22.5rem,26rem)]";
  const columns = paneLayout ? paneLayout.grid : `grid-cols-1 ${tracks}`;

  return (
    <div
      ref={attachRoot}
      data-testid="run-inspector"
      data-full-width={
        bleed === null || (embedded && bleed.width === 0) ? "unmeasured" : bleed.width
      }
      data-diagnostics-tier={paneLayout ? paneLayout.tier : "route"}
      className={`grid min-h-full ${columns} border-y border-line bg-paper`}
      style={
        bleed
          ? { width: bleed.width || undefined, marginLeft: -bleed.offset, maxWidth: "none" }
          : { maxWidth: "none" }
      }
    >
      <aside
        className={`min-w-0 ${paneLayout ? paneLayout.nav : "border-b border-line xl:border-b-0 xl:border-r"}`}
        data-testid="run-inspector-nav"
      >
        {navOpen ? (
          <>
            <div className="border-b border-line px-3 py-2">
              <ProjectSectionNav projectId={scopedProjectId} active="runs" />
            </div>
            <RunsListColumn projectId={scopedProjectId} selectedRunId={runId} />
          </>
        ) : (
          <div className="flex justify-center border-b border-line py-2">
            <button
              type="button"
              data-testid="run-nav-expand"
              aria-label="Show the runs list"
              onClick={() => setNavOpen(true)}
              className="grid h-[22px] w-[22px] place-items-center rounded-[2px] border border-line bg-surface font-mono text-[11px] text-muted hover:border-line-strong hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
            >
              {"\u203a"}
            </button>
          </div>
        )}
      </aside>

      <main className="min-w-0 px-4 py-3">
        {embedded ? null : (
          /* Width honesty, identical to `RunHeader`: the meta/title column is
           * `grow` with a 20rem flex-basis FLOOR, not `flex-1`'s zero basis, and
           * the header wraps at the right edge. A zero basis made that column
           * whatever the actions column left, so its width was a property of the
           * buttons — a completed run whose `Retry` reason sentence is showing
           * measured ~930px of actions out of 1008px at 1280, which left the meta
           * line and the title a ~54–66px column. Below the floor the actions
           * column drops to its own line and `justify-end` keeps it against the
           * right edge exactly where it sat when it shared the line, so a header
           * that already fits side by side renders unchanged and one that did not
           * gets its meta line back at full width. */
          <header className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2 border-b border-line pb-3">
            <div className="min-w-0 grow basis-[20rem]" data-testid="run-inspector-title">
              <p
                className="truncate font-mono text-[11px] text-muted"
                data-testid="run-inspector-meta"
              >
                {slug} · pinned {shortDigest(run.revision_digest)} · {stream.events.length} frames
                folded
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-[19px] font-bold" data-testid="run-title">
                  Run #{shortId(run.id)}
                </h1>
                <RunStatusChip status={run.status} testid="run-header-status" />
                {!run.placement.scheduled &&
                run.placement.reason === "volume_affinity_unsatisfied" ? (
                  <span className="text-[11.5px] text-muted" data-testid="run-waiting-for-worker">
                    waiting for its worker
                  </span>
                ) : null}
                <span className="font-mono text-[11px] text-faint" data-testid="run-stream-status">
                  {stream.status}
                </span>
              </div>
            </div>
            <RunActions runId={runId} status={run.status} nodes={projection.nodes} />
          </header>
        )}

        {/* The same notice the workbench header shows, reused verbatim — the
            one copy that wraps cleanly at 390px (see RunHeader.tsx). */}
        {!embedded && revisionNotice ? (
          <NewRevisionNotice
            notice={revisionNotice}
            slug={slug}
            pipelineId={run.pipeline_id}
            revisionDigest={run.revision_digest}
          />
        ) : null}

        {/* The strip rides above every tab, as in 4a: it is how a reader
            orients in the run, and selecting from it works from any tab. */}
        <div className="pb-3">
          <RunStageStrip
            nodes={projection.nodes}
            definitionOrder={definitionOrder}
            selectedNodeId={selectedNode?.node_id ?? null}
            onSelectNode={selectNode}
            headingId="run-stage-strip-heading"
          />
        </div>

        {/* Same width honesty as the header above: the tablist keeps its three
            tabs on one line and the runs-column verb drops BELOW them when the
            host is too narrow to hold both, instead of the row pushing its
            right edge past the host (the workbench at its widest dock leaves
            this column ~280px, where the verb stuck out by 5px). */}
        <div className="flex flex-wrap items-center gap-1 py-3">
          {/* The tablist holds only its tab children (axe aria-required-
           * children); the collapse control sits beside it. */}
          <div role="tablist" aria-label="Run views" className="flex gap-1">
            {TABS.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={tab === item.id}
                data-testid={`run-tab-${item.id}`}
                onClick={() => setTab(item.id)}
                className={`rounded-[3px] border px-3 py-[5px] text-[12.5px] font-semibold ${
                  tab === item.id
                    ? "border-ink bg-ink text-paper"
                    : "border-line text-muted hover:border-line-strong hover:text-ink"
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
          {navOpen ? (
            <button
              type="button"
              data-testid="run-nav-collapse"
              aria-label="Hide the runs list"
              onClick={() => setNavOpen(false)}
              className="ml-auto self-center rounded-[3px] border border-line px-2 py-[3px] font-mono text-[10.5px] text-muted hover:border-line-strong hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
            >
              runs {"\u2039"}
            </button>
          ) : null}
        </div>

        {tab === "definition" ? (
          <RunDefinitionTab
            digest={run.revision_digest}
            nodes={projection.nodes}
            selectedKey={graphKey}
            onSelectKey={selectNode}
          />
        ) : null}
        {tab === "execution" ? (
          <RunExecutionTab
            nodes={projection.nodes}
            tree={tree}
            definitionOrder={definitionOrder}
            selectedKey={instanceKey}
            selectedBranch={selectedBranch}
            onSelect={selectNode}
            onSelectBranch={selectBranch}
          />
        ) : null}
        {tab === "timeline" ? (
          <RunTimelineTab
            runId={runId}
            projectId={scopedProjectId}
            events={stream.events}
            nodes={projection.nodes}
            selectedExecutionId={selectedNode?.id ?? null}
            onSelect={selectNode}
          />
        ) : null}
      </main>

      <aside
        className={`min-w-0 bg-surface px-3 py-3 ${
          paneLayout ? paneLayout.detail : "border-t border-line xl:border-l xl:border-t-0"
        }`}
        data-testid="run-inspector-detail"
      >
        <RunNodeDetail
          runId={runId}
          projectId={scopedProjectId}
          node={selectedNode}
          nodes={projection.nodes}
          frames={stream.events}
        />
      </aside>
    </div>
  );
}

/* ------------------------------------------------------------- actions */

/**
 * Route 31's retriability, read off the rows the server reads. `POST
 * /runs/{id}/retry` re-queues node executions in `failed`, `interrupted` or
 * `cancelled` (`docs/m4-contract.md` route 31); a run whose every node came
 * back `succeeded` or `skipped` has no target and the API answers `409
 * run_not_retriable` (`internal/store/postgres/m4api_runs_write.go`). A
 * **rejected gate is a business outcome, not an execution failure** (contract
 * § 5.3, C9e): the gate row is `succeeded` with `outcome: rejected`, so the
 * honest UI is a disabled Retry that says why — not a button that 409s.
 */
export type RetryVerdict = { show: boolean; available: boolean; reason: string };

const RETRIABLE_NODE_STATUSES: readonly string[] = ["failed", "interrupted", "cancelled"];
const TERMINAL_RUN_STATUSES: readonly string[] = ["completed", "failed", "cancelled"];

export function retryVerdict(status: string, nodes: readonly NodeExecutionSummary[]): RetryVerdict {
  // Only a terminal run is offered a way back: a live or paused run's next
  // step is its own (route 31 refuses a `running` run outright).
  if (!TERMINAL_RUN_STATUSES.includes(status)) {
    return { show: false, available: false, reason: "" };
  }
  const targets = nodes.filter((n) => RETRIABLE_NODE_STATUSES.includes(n.status));
  if (targets.length > 0) {
    const lost = targets.filter((n) => n.error_class === "workspace_lost");
    return {
      show: true,
      available: true,
      reason:
        `Re-runs ${targets.length} ${targets.length === 1 ? "node" : "nodes"}: ${targets
          .map((n) => n.node_instance_key)
          .join(", ")}` +
        // § 7.2 W6: the ENGINE never retries a lost workspace (ADR-0023 § 7), so this
        // control is only ever the operator's own rerun — and it says what that can and
        // cannot bring back, rather than implying the edits come along with it. The
        // words the reader sees cite no contract internals; `copy-spec-speak`.
        (lost.length
          ? " — manual rerun: no automatic retry is offered for a lost " +
            "workspace, so prior edits lost, rerun required from this " +
            "node's inputs."
          : ""),
    };
  }
  const gate = nodes.find((n) => n.kind === "human.approval" && n.outcome === "rejected");
  if (gate) {
    return {
      show: true,
      available: false,
      reason:
        `${gate.node_instance_key} answered rejected — a rejection is a business outcome, ` +
        "not an execution failure. No node failed, was interrupted or " +
        "cancelled, so Retry has no target; start a new run to go down another path.",
    };
  }
  return {
    show: true,
    available: false,
    reason: "Nothing failed, was interrupted or was cancelled, so there is nothing to retry.",
  };
}

/** The run's verbs, and the sentence explaining a verb that is not offered.
 *
 * Layout: a column with the buttons in their own wrapping row, so the reason is
 * a line UNDER the verbs rather than a `w-full` flex item beside them. In a
 * single non-wrapping row, `w-full` on that sentence asks the row for 100% of
 * the header's width on top of the buttons, which is what forced the title/meta
 * column to collapse: the sentence's own length became the actions column's
 * demanded width. `max-w-full` lets it take the column's width and wrap inside
 * it instead. A run with no reason to show — the normal side-by-side case — has
 * one child in this column and renders exactly where it rendered before. */
export function RunActions({
  runId,
  status,
  nodes,
}: {
  runId: string;
  status: string;
  nodes: readonly NodeExecutionSummary[];
}) {
  const pause = usePauseRun(runId);
  const resume = useResumeRun(runId);
  const cancel = useCancelRun(runId);
  const retry = useRetryRun(runId);
  const [conflict, setConflict] = useState<string | null>(null);
  const terminal = TERMINAL_RUN_STATUSES.includes(status);
  const verdict = retryVerdict(status, nodes);
  const report = (error: unknown) => {
    const clash = runConflictOf(error);
    setConflict(clash ? `refused — the run is ${clash.run_status}` : problemOf(error).title);
  };
  const pauseRun = () =>
    pause.mutate(undefined, { onSuccess: () => setConflict(""), onError: report });
  const resumeRun = () =>
    resume.mutate(undefined, { onSuccess: () => setConflict(""), onError: report });
  const cancelRun = () =>
    cancel.mutate(undefined, { onSuccess: () => setConflict(""), onError: report });
  const retryRun = () => retry.mutate({}, { onSuccess: () => setConflict(""), onError: report });

  return (
    <div className="flex min-w-0 flex-col items-end gap-2" data-testid="run-actions">
      <div className="flex flex-wrap items-center justify-end gap-2">
        {status === "paused" ? (
          <Button
            variant="primary"
            disabled={resume.isPending}
            data-testid="run-resume"
            onClick={resumeRun}
          >
            Resume
          </Button>
        ) : (
          <Button
            variant="secondary"
            disabled={terminal || pause.isPending}
            title="In-flight attempts finish honestly — this is a request, not a stop"
            data-testid="run-pause"
            onClick={pauseRun}
          >
            Pause
          </Button>
        )}
        <Button
          variant="danger"
          disabled={terminal || cancel.isPending}
          data-testid="run-cancel"
          onClick={cancelRun}
        >
          Cancel
        </Button>
        {verdict.show ? (
          <Button
            variant="secondary"
            disabled={!verdict.available || retry.isPending}
            title={verdict.reason}
            data-testid="run-retry"
            onClick={retryRun}
          >
            {retry.isPending ? "Retrying…" : "Retry"}
          </Button>
        ) : null}
      </div>
      {verdict.show && !verdict.available ? (
        <p className="max-w-full font-mono text-[11px] text-faint" data-testid="run-retry-reason">
          {verdict.reason}
        </p>
      ) : null}
      {conflict ? (
        <p className="max-w-full font-mono text-[11px] text-failed" data-testid="run-action-error">
          {conflict}
        </p>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------- definition tab */

function RunDefinitionTab({
  digest,
  nodes,
  selectedKey,
  onSelectKey,
}: {
  digest: string;
  nodes: NodeExecutionSummary[];
  selectedKey: string | null;
  onSelectKey: (key: string | null) => void;
}) {
  const revision = useRevision(digest);
  if (revision.isError) {
    return (
      <ProblemBanner
        error={revision.error}
        fallback={`The pinned revision ${shortDigest(digest)} could not be read.`}
      />
    );
  }
  const record = revision.data;
  if (!record) {
    return (
      <p className="font-mono text-[11px] text-muted" data-testid="run-definition-pending">
        Reading the pinned revision {shortDigest(digest)} — the run stays on this digest whatever
        the library publishes next.
      </p>
    );
  }
  const document = record.canonical_document as unknown as DefinitionDocument;
  const statuses: Record<string, NodeExecutionStatus> = {};
  for (const node of nodes) statuses[graphKeyOf(node.node_instance_key)] = node.status;
  return (
    <DefinitionGraph
      document={document}
      label={`pinned r${record.revision_number} · ${shortDigest(record.revision_digest)} · states from this run`}
      statuses={statuses}
      selectedKey={selectedKey}
      onSelectKey={onSelectKey}
      headingId="run-definition-heading"
    />
  );
}

/* -------------------------------------------------------- execution tab */

export function RunExecutionTab({
  nodes,
  tree,
  definitionOrder,
  selectedKey,
  selectedBranch,
  onSelect,
  onSelectBranch,
}: {
  nodes: NodeExecutionSummary[];
  tree: RunTreeRoot | null;
  /** The pinned revision's node ids in document order, read once by the page
   * for the strip, the grids and the tree. */
  definitionOrder: string[] | undefined;
  selectedKey: string | null;
  /** `?branch=` — which fan-out branch the reader picked, or null. */
  selectedBranch: number | null;
  onSelect: (handle: string | null) => void;
  onSelectBranch: (scope: string, index: number) => void;
}) {
  const [expanded, setExpanded] = useState<string[]>([]);
  // One grid per fan-out / loop scope the run actually has a row for, under the
  // strip: the strip says which stage the run is in, the grid says which of its
  // items a person owes attention to. `parallel` scopes are left out — they
  // have no item index, so there is no branch to select.
  const scopes = nodes.filter((node) => BRANCH_SCOPE_KINDS.has(node.kind));
  // With two grids on screen only the one the selected row lives inside raises
  // a cell, so the outline always names the node the right pane shows.
  const branchOwner = branchOwnerOf(scopes, selectedKey);
  return (
    <div className="space-y-[10px]">
      {scopes.map((scope) => (
        <BranchGrid
          key={scope.node_instance_key}
          scope={scope.node_instance_key}
          nodes={nodes}
          selectedBranch={
            branchOwner === null || branchOwner === scope.node_instance_key ? selectedBranch : null
          }
          onSelectBranch={(index) => onSelectBranch(scope.node_instance_key, index)}
          definitionOrder={definitionOrder}
          headingId={`run-branch-grid-heading-${scope.node_instance_key.replaceAll(/\W+/g, "-")}`}
        />
      ))}
      <RunTree
        nodes={nodes}
        definitionOrder={definitionOrder}
        tree={tree}
        expandedKeys={expanded}
        onToggle={(key) =>
          setExpanded((current) =>
            current.includes(key) ? current.filter((item) => item !== key) : [...current, key],
          )
        }
        selectedKey={selectedKey}
        onSelect={onSelect}
        runPath={(child) => routes.run(child)}
        headingId="run-tree-heading"
      />
    </div>
  );
}

/* ---------------------------------------------------------- timeline tab */

/** The filter chips' vocabulary: `all`, the two fixed lenses, one per stage. */
type TimelineFilter = "all" | "failures" | "human" | `stage:${string}`;

/** One journal frame as the timeline draws it (`10` line 49: events correlated
 * by run/node/attempt, filtered by failure, actor and stage). */
interface TimelineRow {
  seq: number;
  type: RunEventType;
  occurredAt: string;
  actor: string;
  actorKind: EventActor["kind"];
  /** What `?node=` takes for this row — the execution id when the run has that
   * row, else the instance key the event names. */
  handle: string | null;
  nodeKey: string | null;
  stage: string | null;
  /** `att N` — only ever a real attempt number, never an id fragment. */
  attempt: string | null;
  /** The boundary a `run.checkpoint_saved`/`_restored` frame names, spelled as
   * such so a digest prefix cannot be misread as an attempt number. */
  boundary: string | null;
  detail: string | null;
  /** The contract's own sentence for the two frames a dead worker writes (W5). */
  copy: string | null;
  failure: boolean;
  human: boolean;
}

/** `failure` and `human` are read off the frame, never guessed from prose. */
function isFailureFrame(type: RunEventType, payload: Record<string, unknown>): boolean {
  return (
    type.endsWith(".failed") ||
    type.endsWith(".interrupted") ||
    payload.error_class !== undefined ||
    payload.failed_cause !== undefined
  );
}

/** A person did it, or a person is owed the answer: approval traffic,
 * `run.waiting_human`, anything a human actor wrote, and a human takeover. */
function isHumanFrame(
  type: RunEventType,
  actorKind: EventActor["kind"],
  payload: Record<string, unknown>,
): boolean {
  if (type.startsWith("approval.") || type === "run.waiting_human") return true;
  if (actorKind === "human") return true;
  return type === "run.paused" && payload.paused_reason === "human_takeover";
}

/**
 * The boundary a checkpoint frame names. `10`'s timeline shows *what happened*,
 * so a `run.checkpoint_saved` row is labelled with the checkpoint it saved —
 * never with `att …`, which is the attempt slot's word: the frame correlates on
 * `attempt_id` (a uuid whose tail is random), and rendering that tail as
 * `att 8cce` read as "attempt #8cce" in browser QA. Nothing is guessed here:
 * no digest, no line.
 */
function boundaryOf(type: RunEventType, payload: Record<string, unknown>): string | null {
  const nested =
    payload.checkpoint && typeof payload.checkpoint === "object"
      ? (payload.checkpoint as Record<string, unknown>)
      : null;
  const digest = (value: unknown): string | null =>
    typeof value === "string" && value ? shortDigest(value) : null;
  const saved = digest(nested?.outputs_digest) ?? digest(payload.outputs_digest);
  if (type === "run.checkpoint_saved" && saved) return `checkpoint ${saved}`;
  if (type === "run.checkpoint_restored") {
    const commit = nested?.from_commit ?? payload.from_commit;
    return typeof commit === "string" && commit
      ? `checkpoint ${shortCommit(commit)}`
      : "checkpoint";
  }
  if (type === "run.checkpoint_saved") return "checkpoint";
  return null;
}

/**
 * W5 (`docs/m4-contract.md` § 7.2): the two frames a worker's death writes get
 * their contract wording in the timeline, not just the type name —
 * `node.attempt.interrupted` reads *interrupted — the worker disappeared
 * mid-node*, and `node.attempt.retry_scheduled` reads as the countdown, whose
 * moment is the frame's own `scheduled_at`. Nothing here may imply the work
 * carried on by itself: "resumed", "restored" and "no data lost" are the words
 * `10` J7 forbids on this page.
 */
function timelineCopy(type: RunEventType, payload: Record<string, unknown>): string | null {
  if (type === "node.attempt.interrupted") return "interrupted — the worker disappeared mid-node";
  if (type === "node.attempt.retry_scheduled") {
    const scheduledAt = payload.scheduled_at;
    if (typeof scheduledAt !== "string" || !scheduledAt) return "retry scheduled";
    const delay = payload.delay_seconds;
    return `retry scheduled — next attempt at ${formatTime(scheduledAt)}${
      typeof delay === "number" ? ` (in ${delay}s)` : ""
    }`;
  }
  return null;
}

/** `/build_until_verified[2]/implement` → `implement` — the stage an event
 * about a place inside a loop still belongs to. */
function leafOf(key: string | null): string | null {
  if (!key) return null;
  const leaf = key.split("/").filter(Boolean).pop() ?? null;
  if (!leaf) return null;
  return leaf.replace(/\[\d+\]$/, "");
}

export function RunTimelineTab({
  runId,
  projectId,
  events,
  nodes,
  selectedExecutionId,
  onSelect,
}: {
  runId: string;
  projectId: string;
  events: readonly EventEnvelope[];
  nodes: NodeExecutionSummary[];
  selectedExecutionId: string | null;
  onSelect: (handle: string | null) => void;
}) {
  const { actorLabel } = useActorNames(projectId);
  const [filter, setFilter] = useState<TimelineFilter>("all");
  const [query, setQuery] = useState("");

  // Journal order, deduped on `event_id`/`global_seq` — the same gap-safety
  // fold the projection uses, so a replay paints one row, not two.
  const rows = useMemo<TimelineRow[]>(() => {
    return normalizeRunFrames(events).reduce<TimelineRow[]>((out, envelope) => {
      const event = toRunEvent(envelope);
      if (!event) return out; // a type this screen has no words for (ADR-0014 § 8)
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      const known =
        nodes.find((node) => node.id === event.node_execution_id) ??
        nodes.find((node) => node.node_instance_key === payload.node_instance_key);
      const nodeKey =
        known?.node_instance_key ?? (payload.node_instance_key as string | undefined) ?? null;
      const attemptNumber = payload.attempt_number ?? payload.next_attempt_number;
      out.push({
        seq: event.global_seq,
        type: event.type,
        occurredAt: event.occurred_at,
        actor: actorLabel(envelope.actor),
        actorKind: envelope.actor.kind,
        handle: known?.id ?? nodeKey,
        nodeKey,
        stage: known?.node_id ?? leafOf(nodeKey),
        // The attempt slot is the attempt number or nothing. `attempt_id` is a
        // uuid (its last four hex are random), so it is never an attempt label.
        attempt: typeof attemptNumber === "number" ? `att ${attemptNumber}` : null,
        boundary: boundaryOf(event.type, payload),
        detail:
          (payload.detail as string | undefined) ??
          (payload.reason as string | undefined) ??
          (payload.failed_cause as string | undefined) ??
          null,
        copy: timelineCopy(event.type, payload),
        failure: isFailureFrame(event.type, payload),
        human: isHumanFrame(event.type, envelope.actor.kind, payload),
      });
      return out;
    }, []);
  }, [events, nodes, actorLabel]);

  // Stage chips are the stages the frames actually name, in first-seen order —
  // a chip that filters to nothing would be a button that lies.
  const stages = useMemo(() => {
    const seen: string[] = [];
    for (const row of rows) if (row.stage && !seen.includes(row.stage)) seen.push(row.stage);
    return seen;
  }, [rows]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rows.filter((row) => {
      if (filter === "failures" && !row.failure) return false;
      if (filter === "human" && !row.human) return false;
      if (filter !== "all" && filter.startsWith("stage:") && row.stage !== filter.slice(6))
        return false;
      if (!needle) return true;
      return `${row.type} ${row.nodeKey ?? ""} ${row.stage ?? ""} ${row.actor} ${row.detail ?? ""} ${
        row.copy ?? ""
      }`
        .toLowerCase()
        .includes(needle);
    });
  }, [rows, filter, query]);

  if (rows.length === 0) {
    return (
      <p className="font-mono text-[11px] text-muted" data-testid="run-timeline-empty">
        No run events yet on the stream for {runId} — this list is the journal, not a guess.
      </p>
    );
  }
  const chip = (value: TimelineFilter, label: string, testid: string, name?: string) => (
    <button
      key={value}
      type="button"
      aria-pressed={filter === value}
      // A stage chip says its node id and nothing else; said aloud, "build_until_verified"
      // is indistinguishable from the stage-strip cell for the same node. The name
      // says what pressing it does.
      aria-label={name}
      data-testid={testid}
      onClick={() => setFilter(value)}
      className={`rounded-[2px] border px-[7px] py-[2px] font-mono text-[10.5px] ${
        filter === value
          ? "border-ink bg-ink text-paper"
          : "border-line-strong bg-surface text-muted hover:text-ink"
      }`}
    >
      {label}
    </button>
  );
  return (
    <div className="space-y-[6px]">
      <div
        role="group"
        aria-label="Timeline filters"
        className="flex flex-wrap items-center gap-[5px]"
        data-testid="run-timeline-filters"
      >
        {chip("all", "all", "run-timeline-filter-all")}
        {chip("failures", "failures", "run-timeline-filter-failures")}
        {chip("human", "human", "run-timeline-filter-human")}
        {stages.map((stage) =>
          chip(`stage:${stage}`, stage, `run-timeline-stage-${stage}`, `filter to stage ${stage}`),
        )}
        <input
          type="search"
          aria-label="Search timeline events"
          placeholder="search"
          value={query}
          data-testid="run-timeline-search"
          onChange={(event) => setQuery(event.target.value)}
          className="ml-auto w-[11rem] rounded-[2px] border border-line-strong bg-surface px-[6px] py-[2px] font-mono text-[10.5px] text-ink placeholder:text-faint focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
        />
      </div>
      <p className="font-mono text-[10.5px] text-faint" data-testid="run-timeline-count">
        {visible.length} of {rows.length} events
      </p>
      {visible.length === 0 ? (
        <p className="font-mono text-[11px] text-muted" data-testid="run-timeline-none">
          No events match this filter — the journal holds {rows.length}, none of them named here.
        </p>
      ) : (
        <ol className="space-y-[2px]" data-testid="run-timeline">
          {visible.map((row) => (
            <li
              key={`${row.seq}`}
              className="border-b border-line px-1 py-[3px] font-mono text-[11.5px]"
              data-testid={`run-timeline-item-${row.seq}`}
            >
              <button
                type="button"
                data-testid={`run-timeline-row-${row.seq}`}
                aria-current={row.handle && row.handle === selectedExecutionId ? "true" : undefined}
                onClick={() => onSelect(row.handle)}
                className="flex w-full flex-wrap items-baseline gap-2 text-left hover:bg-fill focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
              >
                <span className="text-faint">{row.occurredAt.slice(11, 19)}</span>
                <span className="font-semibold">{row.type}</span>
                {row.nodeKey ? <code className="text-muted">{row.nodeKey}</code> : null}
                {row.attempt ? <span className="text-faint">{row.attempt}</span> : null}
                {row.boundary ? (
                  <span className="text-faint" data-testid={`run-timeline-boundary-${row.seq}`}>
                    {row.boundary}
                  </span>
                ) : null}
                <span className="text-muted">{row.actor}</span>
                {row.failure ? (
                  <span aria-hidden className="text-st-failed-tag-fg">
                    !
                  </span>
                ) : null}
                {row.detail ? <span className="text-muted">{row.detail}</span> : null}
                {row.copy ? (
                  <span className="text-ink-2" data-testid={`run-timeline-copy-${row.seq}`}>
                    {row.copy}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/* --------------------------------------------------- right pane: the node */

function RunNodeDetail({
  runId,
  projectId,
  node,
  nodes,
  frames,
}: {
  runId: string;
  projectId: string;
  node: NodeExecutionSummary | null;
  /** The run's rows — the pane header reads the scope a `[n]` belongs to. */
  nodes: readonly NodeExecutionSummary[];
  frames: readonly EventEnvelope[];
}) {
  const nodeId = node?.id ?? null;
  const detail = useRunNode(runId, nodeId ?? "");
  const approvalsQuery = useProjectApprovals(projectId);
  const decide = useDecideApproval(projectId);
  const queryClient = useQueryClient();
  const me = useMe();
  const project = useProject(projectId);
  const [conflict, setConflict] = useState<string | null>(null);

  // Every attempt of the node, in the order they happened. W5's page has to
  // read *attempt 1 interrupted, then the retry, then attempt 2*: a pane that
  // keeps only its newest row hides the fact the journal just recorded, which
  // is the one thing the honesty rule (`10` J7) says must stay visible.
  const attemptViews = useMemo(
    () =>
      (detail.data?.attempts ?? [])
        .map(viewAttempt)
        .sort((a, b) => a.attempt_number - b.attempt_number),
    [detail.data],
  );
  const lastAttempt = attemptViews.at(-1) ?? null;
  // Frames grouped by the attempt they name. The retry countdown belongs to the
  // attempt that was interrupted, not to the one that replaced it, so the
  // newest attempt's slice is not the only one read.
  const eventsByAttempt = useMemo(() => {
    const grouped = new Map<string, RunEvent[]>();
    for (const frame of frames) {
      const event = toRunEvent(frame);
      if (!event?.attempt_id) continue;
      const list = grouped.get(event.attempt_id);
      if (list) list.push(event);
      else grouped.set(event.attempt_id, [event]);
    }
    return grouped;
  }, [frames]);
  const gate = (approvalsQuery.data?.approvals ?? [])
    .map(viewApproval)
    .find((approval) => approval.node_execution_id === nodeId);

  /** One copy of the gate card: a control-plane gate has no attempts, so both
   * the with-attempt and the no-attempt paths below render this same block. */
  const gateCard = gate ? (
    <ApprovalCard
      approval={gate}
      canDecide={canDecide(
        gate.approver_roles,
        gate.approver_user_ids,
        me.data,
        project.data?.my_role,
      )}
      pending={decide.isPending}
      conflictError={conflict}
      onDecide={({ approvalId, decision, comments, version }) =>
        decide.mutate(
          { approvalId, body: { decision, version, ...(comments ? { comments } : {}) } },
          {
            onSuccess: () => setConflict(null),
            onError: (error) => {
              if (approvalConflictOf(error)) {
                adoptApprovalConflict(queryClient, error);
                setConflict("someone decided this gate first — what you see now is the winner's");
              } else {
                setConflict(problemOf(error).title);
              }
            },
          },
        )
      }
      headingId={`run-approval-heading-${gate.id}`}
    />
  ) : null;

  if (!node || !nodeId) {
    return (
      <p className="font-mono text-[11px] text-muted" data-testid="run-detail-none">
        Select a node — in the definition graph, a stage cell or the execution tree — to read its
        attempts, artifacts and gates here.
      </p>
    );
  }
  if (detail.isError) {
    return <ProblemBanner error={detail.error} fallback="This node execution could not be read." />;
  }
  // A gate has no attempts, so an absent attempt is a fact, not a loading
  // state: only the live queries hold the pane. Approvals are checked too so a
  // gate does not flash "No attempts yet" before its card can appear.
  if (detail.isPending || (!lastAttempt && approvalsQuery.isPending)) {
    return (
      <div className="space-y-[10px]">
        {node ? (
          <NodePaneHeader
            node={node}
            nodes={nodes}
            attemptNumber={node.attempt_count > 0 ? node.attempt_count : null}
          />
        ) : null}
        <p className="font-mono text-[11px] text-muted" data-testid="run-detail-pending">
          Reading attempts for <code className="font-mono">{node.node_instance_key}</code>…
        </p>
      </div>
    );
  }
  if (!lastAttempt) {
    return (
      <div className="space-y-[10px]">
        <NodePaneHeader
          node={node}
          nodes={nodes}
          attemptNumber={node.attempt_count > 0 ? node.attempt_count : null}
        />
        {gateCard}
        {gate ? null : (
          <p className="font-mono text-[11px] text-muted" data-testid="run-detail-no-attempts">
            No attempts yet for <code className="font-mono">{node.node_instance_key}</code> — status{" "}
            {node.status}
          </p>
        )}
      </div>
    );
  }
  return (
    <div className="space-y-[10px]">
      <NodePaneHeader node={node} nodes={nodes} attemptNumber={lastAttempt.attempt_number} />
      {attemptViews.map((attempt) => {
        const isLatest = attempt.id === lastAttempt?.id;
        return (
          <AttemptDetail
            key={attempt.id}
            attempt={attempt}
            node={node}
            // The node serves one boundary record — the newest attempt's. An
            // older attempt is not shown a checkpoint it never saved.
            checkpoint={
              isLatest && detail.data?.checkpoint ? viewRunCheckpoint(detail.data.checkpoint) : null
            }
            events={eventsByAttempt.get(attempt.id) ?? []}
            // The live agent work is the newest attempt's conversation; a
            // superseded attempt keeps its facts, not a second streaming pane.
            work={
              isLatest ? (
                <AttemptAgentWork attempt={attempt} projectId={projectId} node={node} />
              ) : null
            }
            headingId={`run-attempt-heading-${attempt.attempt_number}`}
          />
        );
      })}
      {gateCard}
    </div>
  );
}

/** The server-told answer: the gate's approver arrays plus the caller's own
 * identity, never a role guessed from a display. */
function canDecide(
  approverRoles: string[],
  approverUserIds: string[],
  me: { id: string } | undefined,
  myRole: string | null | undefined,
): boolean {
  if (!me) return false;
  if (approverUserIds.includes(me.id)) return true;
  return myRole !== null && myRole !== undefined && approverRoles.includes(myRole);
}

/** `/build_until_verified[2]/review` → `/build_until_verified/review`: the
 * graph's key is the instance key without its iteration suffixes. */
function graphKeyOf(key: string): string {
  return key.replaceAll(/\[\d+\]/g, "");
}

/**
 * What the run is stopped on, in the order a reader cares about: the gate a
 * human owes an answer at, then a failure, then the work in flight. A run that
 * is waiting on somebody must not open on an empty pane, so the inspector
 * pre-selects it before anyone clicks. A scope row (`until`, `for each`) is
 * skipped — it owns no attempt of its own, so its children are what the reader
 * can act on. Declaration order breaks ties, so the pick is stable.
 */
export function attentionNodeId(
  nodes: readonly Pick<NodeExecutionSummary, "id" | "kind" | "status" | "waiting_reason">[],
): string | null {
  const work = nodes.filter((node) => !isScopeKind(node.kind));
  const gate = work.find(
    (node) =>
      node.status === "waiting" &&
      (node.kind === "human.approval" || node.waiting_reason === "approval"),
  );
  if (gate) return gate.id;
  return (
    (
      work.find((node) => node.status === "failed") ??
      work.find((node) => node.status === "running")
    )?.id ?? null
  );
}

/** The scope kinds whose rows carry a 1-based `[n]` item/iteration index. */
const BRANCH_SCOPE_KINDS = new Set(["for_each", "until"]);

/**
 * The row a branch cell selects: the branch's latest node execution — the last
 * step `branchesOf` ordered — falling back to the branch's own place row
 * (`/verify_each[14]`) when nothing inside it has run yet.
 */
function branchTargetNode(
  nodes: readonly NodeExecutionSummary[],
  scope: string,
  index: number,
): NodeExecutionSummary | null {
  const branch = findBranch(branchesOf(nodes, scope), index);
  if (!branch) return null;
  const last = branch.steps.at(-1);
  const step = last ? nodes.find((node) => node.node_instance_key === last.key) : undefined;
  return step ?? nodes.find((node) => node.node_instance_key === branch.key) ?? null;
}

/** Which scope a selected row's `[n]` belongs to — the innermost one, so a loop
 * nested inside a branch does not steal the highlight from its own grid. */
function branchOwnerOf(
  scopes: readonly NodeExecutionSummary[],
  selectedKey: string | null,
): string | null {
  if (!selectedKey) return null;
  let owner: string | null = null;
  for (const scope of scopes) {
    if (!branchPlaceOf(selectedKey, scope.node_instance_key)) continue;
    if (owner === null || scope.node_instance_key.length > owner.length) {
      owner = scope.node_instance_key;
    }
  }
  return owner;
}

/** `?branch=` is a 1-based index or nothing — a junk value reads as "none". */
function readBranchIndex(value: string | null): number | null {
  if (!value) return null;
  const index = Number(value);
  return Number.isInteger(index) && index >= 1 ? index : null;
}

/** Definition is the tab a run opens on: the reader orients on the graph the run
 * is pinned to before they read what happened in it. */
function readTab(value: string | null): Tab {
  return value === "execution" || value === "timeline" ? value : "definition";
}

/** The revision's node ids in the order the document declares them, scopes
 * listed before the body nodes inside them — the order the graph draws. */
function definitionOrderOf(document: DefinitionDocument | null | undefined): string[] {
  if (!document?.spec?.nodes) return [];
  const walk = (nodes: DefinitionNode[]): string[] =>
    nodes.flatMap((node) => [node.id, ...walk(scopeBody(node))]);
  return walk(document.spec.nodes);
}

/**
 * W4's notice arithmetic (§ 7.2 row W4, `12` case 11 made visible): compare
 * the newest published revision of the run's pipeline against the revision
 * this run is pinned to. The run carries only the pinned digest, so the
 * pinned number is the summary whose digest matches; when the pin is absent
 * from the list the page stays silent rather than invent a comparison.
 */
export function newerRevisionNotice(
  run: Pick<RunDetail, "revision_digest">,
  revisions: PipelineRevisionSummaryList | undefined,
): { newest: number; pinned: number } | null {
  const list = revisions?.revisions ?? [];
  const pinned = list.find((revision) => revision.revision_digest === run.revision_digest);
  if (!pinned) return null;
  const newest = Math.max(...list.map((revision) => revision.revision_number));
  return newest > pinned.revision_number ? { newest, pinned: pinned.revision_number } : null;
}
