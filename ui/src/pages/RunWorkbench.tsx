/**
 * The graph-first Run Workbench — `/projects/:projectId/runs/:runId`
 * (ADR-0043, design §6). The default view is the pinned revision's definition
 * topology with the run's status folded on as overlays; the agent's live
 * conversation sits in the right dock, not inside the attempt detail. The
 * old inspector is preserved whole as the Diagnostics tab; Timeline and the
 * Execution tree ride on their own tabs.
 *
 * URL state (ADR-0043 decision 6): `?view=graph|timeline|tree|diagnostics&
 * node=<definitionNodeId>&instance=<nodeExecutionId>&attempt=<n>&
 * scopes=<defKey>=<n>,…` — selection changes replace, never push, so the
 * back button leaves the run, and a link to a node is shareable. Old
 * inspector links stay valid: `?tab=timeline|execution|definition` maps to
 * the new view, and a `?node=` that names a node execution (not a definition
 * node) is rewritten to `node=` + `instance=` on first data. The tab row is
 * Graph / Timeline / Artifacts / Diagnostics; the Execution tree rides a
 * toggle inside the Graph view (the tree view's `?view=tree` stays valid and
 * the toggle keeps the old tab's testid), and the Artifacts tab lists the
 * run's referenced artifacts — the client-side sum over the steps'
 * `artifact_refs`, never a guess (gap U1).
 *
 * Live-data honesty: the overlays and the dock read the execution journal
 * (`/runs/{id}/nodes` + the SSE stream); the auto-select rule fires once,
 * before the reader clicks anything, and never again (ADR-0043 decision 4).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { usePipelines, usePipelineRevisions, useRevision } from "../api/pipelines";
import { useRepositories } from "../api/queries";
import { useActorNames } from "../api/actors";
import { useRun, useRunNodes, useRunTree } from "../api/runs";
import { useRunEvents } from "../api/runEvents";
import { viewNodeExecution, viewRun, viewRunTree } from "../api/m4view";
import { projectRun } from "../lib/pipeline/runEvents";
import { parseGraph } from "../lib/pipeline/graphDoc";
import {
  isScopeKind,
  scopeBody,
  type DefinitionDocument,
  type DefinitionNode,
} from "../lib/pipeline/definition";
import {
  graphRingStyle,
  overlays,
  parseWorkbenchUrl,
  workbenchSearch,
  type ScopeSelection,
  type WorkbenchUrlState,
} from "../lib/pipeline/workbench";
import { branchesOf, findBranch } from "../lib/pipeline/branches";
import { NewRevisionNotice, RunHeader, RunHeaderLoading } from "../components/workbench/RunHeader";
import { WorkbenchDock } from "../components/workbench/WorkbenchDock";
import { InstancePicker, scopeInstances } from "../components/workbench/InstancePicker";
import { StepStrip, buildStepCells, type StepStripStep } from "../components/workbench/StepStrip";
import { StudioCanvas, type UiLayout } from "../components/studio/StudioCanvas";
import {
  attentionNodeId,
  newerRevisionNotice,
  RunExecutionTab,
  RunTimelineTab,
} from "../pages/RunInspector";
import RunInspector from "../pages/RunInspector";
import { shortId } from "../lib/format";
import { routes } from "../lib/routes";
import type { ArtifactRef, NodeExecutionSummary } from "../lib/pipeline/contract";

type View = "graph" | "timeline" | "tree" | "artifacts" | "diagnostics";

const WORKBENCH_TABS: readonly { id: View; label: string }[] = [
  { id: "graph", label: "Graph" },
  { id: "timeline", label: "Timeline" },
  { id: "artifacts", label: "Artifacts" },
  { id: "diagnostics", label: "Diagnostics" },
];

/** The view a URL names — and the old inspector's `?tab=` mapped onto it, so
 * links written before the workbench keep reading the same view. `?view=tree`
 * (and `?tab=execution`) still resolve: the tree view is reached through the
 * toggle inside the Graph view, not through a fifth tab. */
export function readWorkbenchView(params: URLSearchParams): View {
  const view = params.get("view");
  if (
    view === "graph" ||
    view === "timeline" ||
    view === "tree" ||
    view === "artifacts" ||
    view === "diagnostics"
  )
    return view;
  const tab = params.get("tab");
  if (tab === "timeline") return "timeline";
  if (tab === "execution") return "tree";
  return "graph";
}

/** The URL's workbench fields (`node`, `instance`, `attempt`, `view` and
 * `scope=/a:2,/b/c:14`, the library's canonical spelling) rewritten from a
 * state, while parameters the workbench state does not own (the tree's
 * `branch=`, an old link's `tab=`) are left exactly where the URL left them. */
function withWorkbenchState(current: URLSearchParams, state: WorkbenchUrlState): URLSearchParams {
  const next = new URLSearchParams(current);
  for (const key of ["node", "instance", "attempt", "view", "scope"]) next.delete(key);
  // `view=artifacts` is the page's own vocabulary (the workbench state model
  // knows graph/timeline/tree/diagnostics): every rewrite must carry it
  // through, or a selection change flips the reader back onto the graph.
  if (current.get("view") === "artifacts") next.set("view", "artifacts");
  const query = workbenchSearch(state);
  if (query !== "") {
    for (const [key, value] of new URLSearchParams(query)) next.set(key, value);
  }
  return next;
}

/** The scope selections a row's `[n]` suffixes pin: `/loop[2]/fan[3]` reads
 * as `loop=2` and `loop/fan=3` — the exact instances the row lives in. */
export function scopeSelectionOfKey(key: string): ScopeSelection {
  const segments = key.split("/").filter(Boolean);
  const out: ScopeSelection = {};
  const ids: string[] = [];
  for (const segment of segments) {
    const match = /^(.*)\[(\d+)\]$/.exec(segment);
    ids.push(match ? match[1] : segment);
    if (match) out[`/${ids.join("/")}`] = Number(match[2]);
  }
  return out;
}

/** One scope of the pinned definition, in definition-key form. */
interface ScopeInfo {
  defKey: string;
  id: string;
  kind: string;
}

function scopeWalk(document: DefinitionDocument | null): ScopeInfo[] {
  if (!document?.spec?.nodes) return [];
  const walk = (nodes: DefinitionNode[], prefix: string): ScopeInfo[] =>
    nodes.flatMap((node) => {
      if (!isScopeKind(node.kind)) return [];
      const defKey = `${prefix}${node.id}`;
      return [{ defKey, id: node.id, kind: node.kind }, ...walk(scopeBody(node), `${defKey}/`)];
    });
  return walk(document.spec.nodes, "/");
}

/** The revision's nodes by id, scopes and body alike — the dock's labels. */
function nodesById(document: DefinitionDocument | null): Map<string, DefinitionNode> {
  const out = new Map<string, DefinitionNode>();
  if (!document?.spec?.nodes) return out;
  const walk = (nodes: DefinitionNode[]) => {
    for (const node of nodes) {
      out.set(node.id, node);
      walk(scopeBody(node));
    }
  };
  walk(document.spec.nodes);
  return out;
}

/** The pinned revision's node ids in document order — the tree's order. */
function definitionOrderOf(document: DefinitionDocument | null): string[] | undefined {
  if (!document?.spec?.nodes) return undefined;
  const walk = (nodes: DefinitionNode[]): string[] =>
    nodes.flatMap((node) => [node.id, ...walk(scopeBody(node))]);
  return walk(document.spec.nodes);
}

/** The branch's latest node execution — the cell stands for that row. */
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

const DOCK_MIN = 320;
const DOCK_MAX = 720;
const clampDock = (width: number) => Math.min(DOCK_MAX, Math.max(DOCK_MIN, Math.round(width)));

/**
 * A stable object for a revision with no saved `ui_layout`. A fresh `{}` on
 * every render would give the canvas a new `layout` identity per render,
 * re-running `toFlow` and a structural node rebuild on every SSE frame — the
 * churn this page's rebuild path must not pay for no reason.
 */
const NO_UI_LAYOUT = {} as UiLayout;

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(
    () => typeof window !== "undefined" && window.innerWidth < 1024,
  );
  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < 1024);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return narrow;
}

export default function RunWorkbench({ projectId: projectIdProp }: { projectId?: string } = {}) {
  const routeParams = useParams();
  // The project-less deep link (`/runs/:runId`) resolves the project from the
  // run itself and passes it here; the legacy path keeps reading it from the URL.
  const projectId = projectIdProp ?? routeParams.projectId ?? "";
  const runId = routeParams.runId ?? "";
  const [params, setParams] = useSearchParams();
  const view = readWorkbenchView(params);
  const narrow = useNarrow();
  // Full-screen transcript (design 5c): `?full=1` folds the graph into the
  // step strip and centres the transcript; the param rides alongside the
  // ADR-0043 fields and is left alone by every selection rewrite.
  const fullScreen = params.get("full") === "1";

  /* ---------------------------------------------------------- the reads */
  const runQuery = useRun(runId);
  const nodesQuery = useRunNodes(runId);
  const treeQuery = useRunTree(runId);
  const pipelines = usePipelines();
  const stream = useRunEvents(runId, projectId);

  const baseRun = useMemo(() => (runQuery.data ? viewRun(runQuery.data) : null), [runQuery.data]);
  // The "a newer revision was published" notice needs the pipeline's list:
  // the run carries only the pinned digest (W4, docs § 7.2 row 1).
  const revisions = usePipelineRevisions(baseRun?.pipeline_id ?? "");
  const revisionNotice = useMemo(
    () => (baseRun ? newerRevisionNotice(baseRun, revisions.data) : null),
    [baseRun, revisions.data],
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
  const tree = useMemo(
    () => (treeQuery.data ? viewRunTree(treeQuery.data, (id) => slugsById.get(id) ?? id) : null),
    [treeQuery.data, slugsById],
  );

  // The run's own goal input, when the API serves it — the honest title.
  const goal = useMemo(() => {
    const found = runQuery.data?.inputs?.find((input) => input.name === "goal");
    return typeof found?.value === "string" ? found.value : null;
  }, [runQuery.data]);

  // The Artifacts tab's rows: every step's `artifact_refs`, named by the step
  // that references it. The count is this sum — "referenced" artifacts, the
  // same artifact named by two steps counts twice (there is no run-level
  // artifact endpoint to dedupe against, and a guess would be a lie).
  const artifactRefs = useMemo(() => {
    const rows: { ref: ArtifactRef; nodeKey: string }[] = [];
    for (const node of projection.nodes) {
      for (const ref of node.artifact_refs) rows.push({ ref, nodeKey: node.node_instance_key });
    }
    return rows;
  }, [projection.nodes]);

  // The header's "started by <name>": only when a `run.created` / `run.started`
  // frame with an actor is in the journal buffer this page holds — never
  // invented, and never a worker name (ADR-0016 § 8).
  const { actorLabel } = useActorNames(projectId);
  const startedBy = useMemo(() => {
    for (const frame of stream.events) {
      if (frame.type !== "run.created" && frame.type !== "run.started") continue;
      return actorLabel(frame.actor);
    }
    return null;
  }, [stream.events, actorLabel]);

  // The header's repo segment: a project with exactly one repository names it
  // unambiguously; with several, the run's data does not say which one it ran
  // in, so the segment is omitted rather than guessed.
  const repositories = useRepositories(projectId);
  const repoName = useMemo(() => {
    const items = repositories.data?.items ?? [];
    return items.length === 1 ? items[0].name : null;
  }, [repositories.data]);

  /* ------------------------------------------ the pinned revision, read-once */
  const revisionRecord = useRevision(baseRun?.pipeline_revision_id ?? "");
  const definitionDocument = (revisionRecord.data?.canonical_document ??
    null) as unknown as DefinitionDocument | null;
  const graphModel = useMemo(() => {
    const text = revisionRecord.data?.document_text;
    if (!text) return null;
    const parsed = parseGraph(text);
    return parsed.ok ? parsed.model : null;
  }, [revisionRecord.data]);
  const definitionNodes = useMemo(() => nodesById(definitionDocument), [definitionDocument]);
  const definitionOrder = useMemo(
    () => definitionOrderOf(definitionDocument),
    [definitionDocument],
  );
  const scopePickers = useMemo(() => {
    const scopesInDefinition = scopeWalk(definitionDocument);
    return scopesInDefinition
      .map((scope) => ({ ...scope, instances: scopeInstances(projection.nodes, scope.defKey) }))
      .filter((scope) => scope.instances.length > 1);
  }, [definitionDocument, projection.nodes]);

  /* -------------------------------------------------- the URL state */
  const urlState = useMemo(() => parseWorkbenchUrl(params), [params]);
  const scopes = urlState.scopes;
  const selectedDefId = urlState.node;
  const instanceParam = urlState.instance;
  const selectedExecution = useMemo(
    () => projection.nodes.find((node) => node.id === instanceParam) ?? null,
    [projection.nodes, instanceParam],
  );
  const branchParam = params.get("branch");
  const selectedBranch =
    branchParam && Number.isInteger(Number(branchParam)) ? Number(branchParam) : null;
  const attemptNumber = urlState.attempt;

  const statusOverlay = useMemo(
    () => overlays(projection.nodes, scopes),
    [projection.nodes, scopes],
  );

  /** Full screen (`?full=1`) sets and clears one param — the ADR-0043
   * selection fields are never touched, so a deep link to a step survives
   * the round trip through the strip. */
  const setFull = useCallback(
    (value: boolean) =>
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          if (value) next.set("full", "1");
          else next.delete("full");
          return next;
        },
        { replace: true },
      ),
    [setParams],
  );

  // Esc leaves full screen — unless the reader is typing in a field.
  useEffect(() => {
    if (!fullScreen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
      )
        return;
      setFull(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullScreen, setFull]);

  /** The full-screen strip's cells: the pinned definition's TOP-LEVEL steps
   * in document order, wearing the graph boxes' own overlays. Before the
   * revision answers, the journal's top-level rows stand in — never steps
   * the run has not named. */
  const topSteps = useMemo<StepStripStep[]>(() => {
    if (definitionDocument?.spec?.nodes)
      return definitionDocument.spec.nodes.map((node) => ({ id: node.id, kind: node.kind }));
    const seen = new Set<string>();
    const order: StepStripStep[] = [];
    for (const row of projection.nodes) {
      const root = row.node_instance_key.split(/[/[]/)[0];
      if (root === row.node_id && !seen.has(row.node_id)) {
        seen.add(row.node_id);
        order.push({ id: row.node_id, kind: row.kind });
      }
    }
    return order;
  }, [definitionDocument, projection.nodes]);
  const stripCells = useMemo(
    () => buildStepCells(topSteps, statusOverlay),
    [topSteps, statusOverlay],
  );

  // The discipline: once the reader clicks, the page never moves the
  // selection again — events update overlays and counts only (ADR-0043/4).
  const userSelected = useRef(false);
  const autoDone = useRef(false);
  const remapped = useRef(false);
  // A `?node=` that was in the URL when the page loaded is a deep link (the
  // reader asked to see that node): the canvas centres it once, then a
  // manual pan/zoom takes over. A node selected later (auto-select, a
  // click) must NOT move the viewport — only the dock follows it.
  const deepLinkNodeRef = useRef<string | null>(params.get("node"));

  const setView = (next: View) =>
    setParams(
      (current) => {
        const updated = new URLSearchParams(current);
        updated.set("view", next);
        updated.delete("tab");
        return updated;
      },
      { replace: true },
    );

  /** The graph selects by definition node id; the dock then opens the run's
   * instance the current scope selection resolves to. */
  const selectDefinition = (id: string | null) => {
    userSelected.current = true;
    setParams(
      (current) => {
        const state = parseWorkbenchUrl(current);
        if (!id) {
          state.node = null;
          state.instance = null;
          state.attempt = null;
          return withWorkbenchState(current, state);
        }
        const overlay = overlays(projection.nodes, state.scopes)[id];
        const fallback =
          projection.nodes.find(
            (node) => node.node_id === id && node.node_instance_key === `/${id}`,
          )?.id ?? null;
        state.node = id;
        state.instance = overlay?.executionId ?? fallback;
        state.attempt = null;
        return withWorkbenchState(current, state);
      },
      { replace: true },
    );
  };

  /** The timeline and the tree select by execution id or instance key. */
  const selectHandle = (handle: string | null) => {
    userSelected.current = true;
    setParams(
      (current) => {
        const state = parseWorkbenchUrl(current);
        if (!handle) {
          state.node = null;
          state.instance = null;
          state.attempt = null;
          return withWorkbenchState(current, state);
        }
        const row =
          projection.nodes.find((node) => node.id === handle) ??
          projection.nodes.find((node) => node.node_instance_key === handle) ??
          projection.nodes.find((node) => node.node_id === handle) ??
          projection.nodes.find(
            (node) => node.node_instance_key.replace(/\[\d+\]/g, "") === handle,
          ) ??
          null;
        if (!row) return current;
        state.node = row.node_id;
        state.instance = row.id;
        state.attempt = null;
        Object.assign(state.scopes, scopeSelectionOfKey(row.node_instance_key));
        return withWorkbenchState(current, state);
      },
      { replace: true },
    );
  };

  /** A branch cell: the cell stands for the branch's latest node execution. */
  const selectBranch = (scope: string, index: number) => {
    userSelected.current = true;
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.set("branch", String(index));
        const row = branchTargetNode(projection.nodes, scope, index);
        if (row) {
          next.set("node", row.node_id);
          next.set("instance", row.id);
        }
        return next;
      },
      { replace: true },
    );
  };

  /** An instance chip / row: the box and the dock both follow the pick. */
  const selectScope = (defKey: string, index: number | null) => {
    userSelected.current = true;
    setParams(
      (current) => {
        const state = parseWorkbenchUrl(current);
        if (index === null) delete state.scopes[defKey];
        else state.scopes[defKey] = index;
        const selectedRow = state.instance
          ? (projection.nodes.find((node) => node.id === state.instance) ?? null)
          : null;
        const overlay = selectedRow
          ? overlays(projection.nodes, state.scopes)[selectedRow.node_id]
          : null;
        state.instance = overlay?.executionId ?? null;
        return withWorkbenchState(current, state);
      },
      { replace: true },
    );
  };

  const onAttemptChange = (attempt: number | null) => {
    userSelected.current = true;
    setParams(
      (current) => {
        const state = parseWorkbenchUrl(current);
        state.attempt = attempt === null ? null : attempt;
        return withWorkbenchState(current, state);
      },
      { replace: true },
    );
  };

  /* ------------------------------------- auto-select: on the first data,
   * select what the run needs attention on — and latch only once a node was
   * actually selected. First data with nothing needing attention yet (the
   * gate not open, the run still queuing) must leave the door open, or a
   * run that parks at its gate after the page loaded sits on "select a node
   * on the graph" forever. One follow-up move while the reader has not
   * clicked: the run parking at an approval gate overrides the node
   * auto-selected earlier — the dock points at the thing the reader owes an
   * answer to. After the reader clicks anything, never again (ADR-0043
   * decision 4). */
  const autoSelectedId = useRef<string | null>(null);
  useEffect(() => {
    if (userSelected.current || projection.nodes.length === 0) return;
    const id = attentionNodeId(projection.nodes);
    if (!id) return;
    const row = projection.nodes.find((node) => node.id === id);
    if (!row) return;
    if (!autoDone.current) {
      if (params.get("node") || params.get("instance")) return;
      autoDone.current = true;
      autoSelectedId.current = row.id;
    } else {
      // An approval gate the reader must answer moves the dock; anything
      // else leaves the earlier auto-pick in place (the overlay still shows
      // the state, and one click by the reader takes full control).
      if (autoSelectedId.current === id) return;
      if (!(row.status === "waiting" && row.waiting_reason === "approval")) return;
      if (autoSelectedId.current !== params.get("instance")) return;
    }
    setParams(
      (current) => {
        const state = parseWorkbenchUrl(current);
        state.node = row.node_id;
        state.instance = row.id;
        Object.assign(state.scopes, scopeSelectionOfKey(row.node_instance_key));
        return withWorkbenchState(current, state);
      },
      { replace: true },
    );
  }, [projection.nodes, params, setParams]);

  /* ---------------------------- old inspector links: `?tab=` and a `?node=`
   * that names a node execution. Rewritten once, on first data. */
  useEffect(() => {
    if (remapped.current || projection.nodes.length === 0) return;
    remapped.current = true;
    const tab = params.get("tab");
    const nodeParam = params.get("node");
    const execution = nodeParam
      ? (projection.nodes.find((node) => node.id === nodeParam) ?? null)
      : null;
    if (!tab && !execution) return;
    setParams(
      (current) => {
        const state = parseWorkbenchUrl(current);
        if (execution) {
          state.instance = execution.id;
          state.node = execution.node_id;
          Object.assign(state.scopes, scopeSelectionOfKey(execution.node_instance_key));
        }
        if (tab && !current.get("view")) {
          state.view = tab === "timeline" ? "timeline" : tab === "execution" ? "tree" : "graph";
        }
        const next = withWorkbenchState(current, state);
        next.delete("tab");
        return next;
      },
      { replace: true },
    );
  }, [projection.nodes, params, setParams]);

  /* ------------------------------------------------- the dock, sized and
   * resized by the reader (ADR-0043 decision 3): 440px default, clamped,
   * a keyboard-operable separator, collapsible; under 1024px it sits below
   * the graph at full width instead. */
  const [dockWidth, setDockWidth] = useState(440);
  const [dockCollapsed, setDockCollapsed] = useState(false);
  const resizing = useRef<{ startX: number; startWidth: number } | null>(null);
  const graphTopRef = useRef<HTMLDivElement | null>(null);

  /* The step list under the canvas opens by default (StudioCanvas is shared
   * with the Studio); on desktop the workbench starts with it collapsed so
   * the graph owns the space. One click, once the header is mounted. Skipped
   * where the workbench testid or a real canvas size is absent (component
   * tests render the canvas without the page's frame). */
  const [stepsTidied, setStepsTidied] = useState(false);
  useEffect(() => {
    if (narrow || fullScreen || view !== "graph" || stepsTidied) return;
    let cancelled = false;
    let timer: number | undefined;
    const tryTidy = () => {
      if (!document.querySelector('[data-testid="workbench"]')) {
        if (!cancelled) timer = window.setTimeout(tryTidy, 75);
        return;
      }
      const pane = document.querySelector(
        "[data-testid='studio-canvas'] > div",
      ) as HTMLElement | null;
      if (pane && pane.getBoundingClientRect().height < 100) {
        if (!cancelled) timer = window.setTimeout(tryTidy, 75);
        return;
      }
      const button = document.querySelector<HTMLButtonElement>(
        'button[aria-controls="studio-canvas-steps"]',
      );
      if (!button) {
        if (!cancelled) timer = window.setTimeout(tryTidy, 75);
        return;
      }
      if (button.getAttribute("aria-expanded") === "true") {
        button.click();
        setStepsTidied(true);
        return;
      }
      if (!cancelled) timer = window.setTimeout(tryTidy, 75);
    };
    tryTidy();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [narrow, fullScreen, view, stepsTidied]);

  const startResize = (event: { clientX: number; pointerId: number; target: unknown }) => {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    resizing.current = { startX: event.clientX, startWidth: dockWidth };
    target.setPointerCapture(event.pointerId);
  };
  const onResize = (event: { clientX: number }) => {
    const current = resizing.current;
    if (!current) return;
    setDockWidth(clampDock(current.startWidth + event.clientX - current.startX));
  };
  const endResize = () => {
    resizing.current = null;
  };
  const onSeparatorKey = (event: { key: string; preventDefault(): void }) => {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setDockWidth((width) => clampDock(width - 20));
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      setDockWidth((width) => clampDock(width + 20));
    }
  };

  const loading = (
    <RunHeaderLoading
      runError={runQuery.error ?? null}
      nodesError={nodesQuery.error ?? null}
      pending={runQuery.isPending || !projection.run}
      runId={runId}
    />
  );
  if (runQuery.error || nodesQuery.error || runQuery.isPending || !projection.run) return loading;
  const run = projection.run;
  const slug = slugsById.get(run.pipeline_id) ?? run.pipeline_id;
  const revisionNumber = revisionRecord.data?.revision_number ?? null;
  const definitionNode = selectedDefId ? (definitionNodes.get(selectedDefId) ?? null) : null;
  const uiLayout = (revisionRecord.data?.ui_layout ?? NO_UI_LAYOUT) as unknown as UiLayout;

  /* The canvas clears React Flow's internal selection whenever its inputs
   * rebuild (shared component; the Studio rebuilds too), so the ring for the
   * URL's selected node is drawn here, with the tokens' accent variables —
   * the same visual as a clicked node. Scope children carry a qualified
   * flow id (`scope/id`), so the ring must reach them there too. */
  const ringStyle = graphRingStyle(selectedDefId);

  /* ------------------------------------------------------------- the views */
  /** The Graph/Timeline/Artifacts/Diagnostics row is the workbench's tab set
   * (gap U1); the Execution tree no longer rides it — the toggle below lives
   * inside the Graph view, and the tree view carries the toggle back. Both
   * keep the old tab's `workbench-tab-tree` testid, so a bookmarked selector
   * finds the tree either way. */
  const treeToggle = (target: "tree" | "graph") => (
    <button
      type="button"
      data-testid="workbench-tab-tree"
      aria-pressed={view === "tree"}
      onClick={() => setView(target)}
      className="shrink-0 self-start rounded-[3px] border border-line px-2 py-[3px] font-mono text-[10.5px] text-muted hover:border-line-strong hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
    >
      {target === "tree" ? "execution tree »" : "« back to graph"}
    </button>
  );

  const graphView = (
    <div data-testid="workbench-graph-view">
      <div className="flex items-center justify-end gap-2 pb-2">{treeToggle("tree")}</div>
      {ringStyle ? <style>{ringStyle}</style> : null}
      {scopePickers.length > 0 ? (
        <div className="space-y-[6px] pb-2">
          {scopePickers.map((scope) => (
            <InstancePicker
              key={scope.defKey}
              scopeId={scope.id}
              defKey={scope.defKey}
              kind={scope.kind === "for_each" ? "for_each" : "until"}
              instances={scope.instances}
              selected={scopes[scope.defKey] ?? null}
              onSelect={(index) => selectScope(scope.defKey, index)}
            />
          ))}
        </div>
      ) : null}
      {revisionRecord.data && graphModel ? (
        <div
          data-testid="workbench-graph-frame"
          className="h-[calc(100vh-300px)] min-h-[480px] w-full min-w-0 overflow-hidden rounded-[3px] border border-line bg-surface [&>div]:h-full"
        >
          <StudioCanvas
            model={graphModel}
            document={definitionDocument}
            layout={uiLayout}
            selectedId={selectedDefId}
            readOnly
            stale={false}
            statusOverlay={statusOverlay}
            onSelect={selectDefinition}
            focusNodeId={deepLinkNodeRef.current ?? undefined}
          />
        </div>
      ) : (
        <p className="font-mono text-[11px] text-muted" data-testid="workbench-graph-pending">
          Reading the pinned revision — the boxes below appear as soon as it answers. The run stays
          on the revision it started with.
        </p>
      )}
    </div>
  );

  const timelineView = (
    <RunTimelineTab
      runId={runId}
      projectId={projectId}
      events={stream.events}
      nodes={projection.nodes}
      selectedExecutionId={selectedExecution?.id ?? null}
      onSelect={selectHandle}
    />
  );

  const treeView = (
    <div data-testid="workbench-tree-view">
      <div className="flex items-center justify-end gap-2 pb-2">{treeToggle("graph")}</div>
      <RunExecutionTab
        nodes={projection.nodes}
        tree={tree}
        definitionOrder={definitionOrder}
        selectedKey={selectedExecution?.node_instance_key ?? null}
        selectedBranch={selectedBranch}
        onSelect={selectHandle}
        onSelectBranch={selectBranch}
      />
    </div>
  );

  /** The Artifacts tab: the client-side list of the run's referenced
   * artifacts (sum of the steps' `artifact_refs`, labelled "referenced") with
   * the honest empty state when no step has referenced one. */
  const artifactsView = (
    <div data-testid="workbench-artifacts-view">
      {artifactRefs.length > 0 ? (
        <>
          <p className="font-mono text-[11px] text-muted">
            {artifactRefs.length} referenced artifact{artifactRefs.length === 1 ? "" : "s"} across
            the run's steps — the client-side sum of the steps' artifact references, so an artifact
            named by two steps counts twice.
          </p>
          <ul
            className="divide-y divide-line overflow-x-auto rounded-[3px] border border-line bg-surface"
            data-testid="workbench-artifacts-list"
          >
            {artifactRefs.map((row, index) => (
              <li
                key={`${row.ref.id}:${index}`}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2"
              >
                <Link
                  to={`/artifacts/${row.ref.id}`}
                  className="text-[12.5px] font-semibold text-ink underline-offset-2 hover:underline hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
                  data-testid={`workbench-artifact-link-${index}`}
                >
                  {row.ref.name || shortId(row.ref.id)}
                </Link>
                <span className="font-mono text-[10.5px] text-faint">{row.ref.kind}</span>
                {row.ref.sensitivity ? (
                  <span className="font-mono text-[10.5px] text-faint">{row.ref.sensitivity}</span>
                ) : null}
                <span className="ml-auto font-mono text-[10.5px] text-muted">
                  referenced by {row.nodeKey}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="font-mono text-[11px] text-muted" data-testid="workbench-artifacts-empty">
          No step of this run has referenced an artifact yet. The{" "}
          <Link
            to={routes.projectTab(projectId, "artifacts")}
            className="underline-offset-2 text-ink-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
            data-testid="workbench-artifacts-project-link"
          >
            project's artifacts
          </Link>{" "}
          page lists what it has stored.
        </p>
      )}
    </div>
  );

  const dock = (
    <WorkbenchDock
      run={run}
      projectId={projectId}
      definitionNode={definitionNode ? { id: definitionNode.id, kind: definitionNode.kind } : null}
      execution={selectedExecution}
      attemptNumber={attemptNumber}
      onAttemptChange={onAttemptChange}
      nodes={projection.nodes}
      frames={stream.events}
      tree={tree}
      fullScreen={fullScreen}
      onToggleFullScreen={() => setFull(!fullScreen)}
    />
  );

  return (
    <div
      className="flex min-h-full flex-col bg-paper"
      data-testid="workbench"
      ref={(node) => {
        graphTopRef.current = node;
      }}
    >
      <div className="px-4 pt-3">
        <RunHeader
          projectId={projectId}
          run={run}
          goal={goal}
          slug={slug}
          streamStatus={stream.status}
          repoName={repoName}
          startedBy={startedBy}
          revision={
            revisionNumber === null
              ? null
              : {
                  revision_number: revisionNumber,
                  revision_digest: revisionRecord.data?.revision_digest ?? run.revision_digest,
                }
          }
          nodes={projection.nodes}
        />
        {revisionNotice ? (
          <NewRevisionNotice
            notice={revisionNotice}
            slug={slug}
            pipelineId={run.pipeline_id}
            revisionDigest={run.revision_digest}
          />
        ) : null}

        {/* The tab row belongs to the split presentation; in full screen
         * (design 5c) the step strip takes its place. */}
        {!fullScreen ? (
          <div className="flex gap-1 py-3">
            <div
              role="tablist"
              aria-label="Workbench views"
              className="flex max-w-full gap-1 overflow-x-auto"
            >
              {WORKBENCH_TABS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={view === item.id}
                  data-testid={`workbench-tab-${item.id}`}
                  onClick={() => setView(item.id)}
                  className={`shrink-0 whitespace-nowrap rounded-[3px] border px-3 py-[5px] text-[12.5px] font-semibold ${
                    view === item.id
                      ? "border-ink bg-ink text-paper"
                      : "border-line text-muted hover:border-line-strong hover:text-ink"
                  } focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent`}
                >
                  {item.label}
                  {item.id === "artifacts" && artifactRefs.length > 0 ? (
                    <span
                      data-testid="workbench-artifacts-badge"
                      className="ml-1.5 rounded-[3px] bg-paper/15 px-1 font-mono text-[10.5px] font-normal"
                    >
                      {artifactRefs.length}
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
            {!narrow ? (
              <button
                type="button"
                data-testid="workbench-dock-collapse"
                aria-label={dockCollapsed ? "Show the node detail" : "Hide the node detail"}
                onClick={() => setDockCollapsed((value) => !value)}
                className="ml-auto self-center rounded-[3px] border border-line px-2 py-[3px] font-mono text-[10.5px] text-muted hover:border-line-strong hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
              >
                {dockCollapsed ? "detail »" : "« detail"}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="flex min-h-0 flex-1">
        {fullScreen ? (
          /* Full-screen transcript (design 5c): the graph is the strip of
           * step cells across the top; the transcript is centred at 760px. */
          <main className="min-w-0 flex-1 px-4 pb-4">
            <div className="flex flex-col items-center gap-3">
              <div className="flex w-full min-w-0 items-center gap-2">
                <button
                  type="button"
                  data-testid="workbench-show-graph"
                  onClick={() => setFull(false)}
                  className="shrink-0 rounded-[3px] border border-line px-2.5 py-[5px] text-[12px] font-semibold text-ink hover:border-line-strong focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
                >
                  ⤡ show graph
                </button>
                <div className="min-w-0 flex-1">
                  <StepStrip
                    cells={stripCells}
                    selectedId={selectedDefId}
                    onSelect={selectDefinition}
                  />
                </div>
              </div>
              <div className="w-full max-w-[760px]" data-testid="workbench-fullscreen-transcript">
                {dock}
              </div>
            </div>
          </main>
        ) : (
          <>
            <main className="min-w-0 flex-1 px-4 pb-4">
              {view === "graph" ? graphView : null}
              {view === "timeline" ? timelineView : null}
              {view === "tree" ? treeView : null}
              {view === "artifacts" ? artifactsView : null}
              {view === "diagnostics" ? <RunInspector embedded /> : null}
            </main>
            {!narrow && !dockCollapsed ? (
              <aside className="flex min-w-0 border-l border-line bg-surface">
                <div
                  role="separator"
                  aria-orientation="vertical"
                  aria-valuemin={DOCK_MIN}
                  aria-valuemax={DOCK_MAX}
                  aria-valuenow={dockWidth}
                  aria-label="Resize the node detail"
                  tabIndex={0}
                  data-testid="workbench-dock-resizer"
                  onPointerDown={startResize}
                  onPointerMove={onResize}
                  onPointerUp={endResize}
                  onPointerCancel={endResize}
                  onKeyDown={onSeparatorKey}
                  className="w-[6px] shrink-0 cursor-col-resize border-r border-line hover:border-accent focus-visible:outline-2 focus-visible:outline-accent"
                />
                <div
                  className="w-full overflow-y-auto px-3 py-3"
                  style={{ width: dockWidth }}
                  data-testid="workbench-dock-pane"
                >
                  {dock}
                </div>
              </aside>
            ) : null}
          </>
        )}
      </div>

      {narrow && !fullScreen ? (
        <section
          className="border-t border-line bg-surface px-4 py-3"
          data-testid="workbench-dock-panel"
        >
          <div className="flex items-center justify-between border-b border-line pb-2">
            <span className="font-mono text-[10px] font-semibold tracking-[.04em] text-muted uppercase">
              node detail
            </span>
            <button
              type="button"
              data-testid="workbench-dock-back"
              onClick={() => graphTopRef.current?.scrollIntoView({ block: "start" })}
              className="rounded-[3px] border border-line px-2 py-[3px] font-mono text-[10.5px] text-ink-2 hover:border-line-strong hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
            >
              Back to graph
            </button>
          </div>
          <div className="pt-3">{dock}</div>
        </section>
      ) : null}
    </div>
  );
}
