/**
 * StudioCanvas.tsx — the interactive React Flow canvas of the Workflow
 * Studio: the step graph with its scope boxes, the "+" affordances (edge
 * midpoints, trailing terminal steps, empty scope bodies, empty canvas),
 * drag-to-insert with edge hit-testing, connect refusal reporting, and the
 * accessible steps list under the canvas.
 *
 * Presentational by contract: it owns no draft state and never applies a
 * graph op itself — every gesture is a callback into the Studio page
 * (`onSelect`, `onMove`, `onInsertOnEdge`, `onAddAfter`, `onConnect`,
 * `onDelete`). The YAML text in `graphDoc.ts` stays the source of truth.
 */
import "@xyflow/react/dist/style.css";
import {
  Background,
  ReactFlow,
  ReactFlowProvider,
  SelectionMode,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeMouseHandler,
} from "@xyflow/react";
import {
  findNode,
  scopeKey,
  type GraphEdge,
  type GraphModel,
  type ScopePath,
} from "../../lib/pipeline/graphDoc";
import { nearestEdge, stepLabel, toFlow, type FlowModel } from "./flowModel";
import {
  ErrorEdge,
  InsertableEdge,
  type ErrorEdgeRender,
  type InsertableEdgeRender,
} from "./edges";
import { ScopeNode, StepNode, type ScopeNodeRender, type StepNodeRender } from "./nodes";
import { NodeMenu } from "./NodeMenu";
import { StepPicker } from "./StepPicker";
import { PALETTE_DRAG_TYPE } from "./StudioPalette";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";

export type UiLayout = { nodes?: Record<string, { x: number; y: number }> };

export interface StudioCanvasProps {
  model: GraphModel;
  /** The parsed JS document (for `layoutDefinition`). */
  document: unknown;
  /** Saved positions keyed by node id; override the dagre positions. */
  layout: UiLayout;
  selectedId: string | null;
  /** Multi-selection ids (Shift+click, Shift+drag box, the outline's
   * checkboxes). `[]`/absent = the single `selectedId` drives the ring. */
  selectedIds?: string[];
  /** Fired whenever React Flow's selection set changes. */
  onSelectionChange?(ids: string[]): void;
  /** No handles, no + buttons, no drag-to-insert, no delete. */
  readOnly: boolean;
  /** YAML currently invalid: render greyed with `staleMessage`. */
  stale: boolean;
  staleMessage?: string;
  /** Node ids to ring with `data-highlight="assistant-proposed"`. */
  highlight?: string[];
  /** Render a text+icon badge on the matching step. */
  statusOverlay?: Record<string, { state: string; label: string }>;
  onSelect(id: string | null): void;
  onMove?(id: string, pos: { x: number; y: number }): void;
  onInsertOnEdge?(edge: GraphEdge, kind: string): void;
  /** + after terminal step / empty canvas / empty scope body. */
  onAddAfter?(afterId: string | null, scope: ScopePath, kind: string): void;
  /** A definition node id to centre in view once it is on the canvas
   * (the Workbench deep link's `?node=`); the canvas honours it until the
   * reader pans/zooms, then the reader's viewport wins. */
  focusNodeId?: string | null;
  onConnect?(from: string, to: string): void;
  onDelete?(ids: string[]): void;
  /** Duplicate a step — the selected node's context/selection menu calls it
   * with the definition node id (the Studio page wires it to its undoable op). */
  onDuplicate?: (id: string) => void;
  canConnect?(from: string, to: string): { ok: true } | { ok: false; reason: string };
  /**
   * Design 1g pass 2 #8: the Studio drops the `steps list` strip under the
   * canvas (the status bar already counts the steps). The Run Workbench
   * keeps it — it is that page's accessible definition table.
   */
  hideStepList?: boolean;
}

// ---------------------------------------------------------------------------
// Palette → canvas drag registry.
//
// HTML5 drag events expose the dataTransfer *value* only on drop, so the
// dragged kind travels through this module state: the palette reports
// dragstart/dragend, the canvas mirrors it to render the drop preview.
// ---------------------------------------------------------------------------

type DragKindListener = (kind: string | null) => void;
const dragListeners = new Set<DragKindListener>();

export function setPaletteDragKind(kind: string | null): void {
  for (const listener of dragListeners) listener(kind);
}

function subscribeDragKind(listener: DragKindListener): () => void {
  dragListeners.add(listener);
  return () => {
    dragListeners.delete(listener);
  };
}

export function StudioCanvas(props: StudioCanvasProps) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}

/**
 * The connect decision, factored out so the refusal path is testable without
 * driving a handle drag in jsdom: refused reasons surface in the toast
 * (`connect-refused`) and `onConnect` is not called.
 */
export function evaluateConnect(
  canConnect: StudioCanvasProps["canConnect"],
  from: string,
  to: string,
): { refused: string | null; proceed: boolean } {
  if (canConnect) {
    const result = canConnect(from, to);
    if (!result.ok) return { refused: result.reason, proceed: false };
  }
  return { refused: null, proceed: true };
}

const nodeTypes = {
  step: StepNode,
  scope: ScopeNode,
};

const edgeTypes = {
  insertable: InsertableEdge,
  error: ErrorEdge,
};

/** The pointer must be within this many px of the segment to count as an
 * "insert here" drop (design doc §3.2). The smooth-step path bows well off the
 * straight segment in a tight top-to-bottom layout (a short hop with a rank
 * offset bows ~30px at its midpoint), and the drop preview is drawn AT the
 * path midpoint — so the radius must comfortably clear the bow, not just the
 * 24px the doc names for a straight edge. */
const DROP_EDGE_RADIUS_PX = 48;

/** Width the node menu is measured at for the fits-on-the-right check
 * (design 1g: a two-item menu, ~80–110px wide). */
const MENU_WIDTH_PX = 110;

/* ------------------------------------------------------------------ the
 * viewport-fit guards.
 *
 * The live Workbench went blank mid-run (issue #2): nodes sat in the DOM
 * while the pane showed nothing. Two failure modes were proven from the
 * acceptance trace:
 *   1. a fit ran while nodes were still unmeasured / the pane was
 *      transiently 0×0 — React Flow's `getViewportForBounds` divides by
 *      zero bounds and the resulting wrong (or NaN) transform sticks, and
 *      nothing refits afterwards;
 *   2. React Flow's internal diff machinery (the fitView queue flush, the
 *      "Fit View" control) reports `add`/`remove` changes through
 *      onNodesChange/onEdgesChange; applying them shrank the canvas's
 *      controlled mirror until 16 of 17 nodes were gone.
 * The helpers below make both safe and are unit-tested directly. */

/** Smallest pane (CSS px) a fit or centre will run against. */
export const MIN_FIT_PANE_PX = 48;

function isPositiveFinite(n: number | undefined): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

/** Fit the graph's boxes into the pane. Returns the viewport to apply,
 * or null when the fit must NOT run: a zero/transient pane, degenerate
 * boxes, or any non-finite result (a fit against unmeasured/zero-size
 * inputs is exactly what blanked the canvas). */
export function computeFitViewport(
  boxes: { x: number; y: number; width: number; height: number }[],
  paneWidth: number,
  paneHeight: number,
  minZoom = 0.4,
  // Design 1g pass 2 #1: the fit never magnifies past 100% — a 200×52 step
  // fits at its designed size, not the 250×65 a 1.25 cap rendered (the
  // "nodes are too big, name ~16px" observation was this cap).
  maxZoom = 1,
  padding = 0.08,
): { x: number; y: number; zoom: number } | null {
  if (!isPositiveFinite(paneWidth) || !isPositiveFinite(paneHeight)) return null;
  if (paneWidth < MIN_FIT_PANE_PX || paneHeight < MIN_FIT_PANE_PX) return null;
  if (boxes.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const box of boxes) {
    if (
      !Number.isFinite(box.x) ||
      !Number.isFinite(box.y) ||
      !isPositiveFinite(box.width) ||
      !isPositiveFinite(box.height)
    ) {
      return null; // an unmeasured/degenerate box: refuse rather than fit wrong
    }
    minX = Math.min(minX, box.x);
    minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + box.width);
    maxY = Math.max(maxY, box.y + box.height);
  }
  const bounds = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  const p = padding;
  const xZoom = (paneWidth - p * 2 * paneWidth) / bounds.width;
  const yZoom = (paneHeight - p * 2 * paneHeight) / bounds.height;
  const zoom = Math.min(xZoom, yZoom);
  const clampedZoom = Number.isFinite(zoom) ? Math.min(Math.max(zoom, minZoom), maxZoom) : NaN;
  const x = paneWidth / 2 - (bounds.x + bounds.width / 2) * clampedZoom;
  const y = paneHeight / 2 - (bounds.y + bounds.height / 2) * clampedZoom;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(clampedZoom)) return null;
  return { x, y, zoom: clampedZoom };
}

/** Centre `box` in the pane at `zoom` (the user's current zoom, clamped
 * into the 0.4→1.25 band). Null when inputs are degenerate. */
export function centerOnBox(
  box: { x: number; y: number; width: number; height: number },
  paneWidth: number,
  paneHeight: number,
  zoom: number,
  minZoom = 0.4,
  maxZoom = 1.25,
): { x: number; y: number; zoom: number } | null {
  if (!isPositiveFinite(paneWidth) || !isPositiveFinite(paneHeight)) return null;
  if (paneWidth < MIN_FIT_PANE_PX || paneHeight < MIN_FIT_PANE_PX) return null;
  if (!Number.isFinite(box.x) || !Number.isFinite(box.y)) return null;
  if (!isPositiveFinite(box.width) || !isPositiveFinite(box.height)) return null;
  const z = Number.isFinite(zoom) && zoom > 0 ? Math.min(Math.max(zoom, minZoom), maxZoom) : 1;
  const x = paneWidth / 2 - (box.x + box.width / 2) * z;
  const y = paneHeight / 2 - (box.y + box.height / 2) * z;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y, zoom: z };
}

/** Parse a rendered `.react-flow__viewport` transform. Null when absent or
 * non-finite — React Flow writes NaN straight into the style when a fit
 * ran against a zero-size pane, and a corrupt store leaves interaction
 * dead even when the browser kept a stale style value. */
export function parseViewportTransform(
  style: string | null | undefined,
): { x: number; y: number; zoom: number } | null {
  if (!style) return null;
  const m = /translate\(([-\d.]+)px,\s*([\d.-]+)px\)\s*scale\(([-\d.]+)\)/.exec(style);
  if (!m) return null;
  const x = Number(m[1]);
  const y = Number(m[2]);
  const zoom = Number(m[3]);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(zoom)) return null;
  return { x, y, zoom };
}

/** The canvas OWNS the element set: the structural rebuild (the page's
 * model changed) is the only thing that may add or remove nodes/edges.
 * React Flow's internal diff machinery reports `add`/`remove` changes
 * through onNodesChange/onEdgesChange (its fitView queue flush, the
 * "Fit View" control) — applying them is how nodes silently vanished from
 * the live Workbench. Deletions the page intends arrive through the model
 * (`onDelete` → structural rebuild), so the mirror swallows add/remove and
 * keeps every other change (position, dimensions, select, replace). */
export function mirrorOwnedChanges<T extends { type: string }>(changes: readonly T[]): T[] {
  return changes.filter((change) => change.type !== "add" && change.type !== "remove");
}

function isMeasuredBox(box: { width: number | undefined; height: number | undefined }): boolean {
  return isPositiveFinite(box.width) && isPositiveFinite(box.height);
}

/** The node's own config object from the parsed document, for the canvas
 * node's one key fact (design 1g) — the kind's model / command / approver /
 * artifact. Empty when the id is unknown or the doc has no such node. */
function nodeConfigOf(
  document: unknown,
  model: GraphModel,
  nodeId: string,
): Record<string, unknown> {
  const node = findNode(model, nodeId);
  if (!node) return {};
  let cur: unknown = document;
  for (const part of node.pointer.split("/")) {
    if (part === "") continue;
    cur = Array.isArray(cur) ? cur[Number(part)] : (cur as Record<string, unknown> | null)?.[part];
    if (cur === null || cur === undefined) return {};
  }
  if (cur === null || typeof cur !== "object" || Array.isArray(cur)) return {};
  const cfg = (cur as Record<string, unknown>).config;
  return cfg && typeof cfg === "object" && !Array.isArray(cfg)
    ? (cfg as Record<string, unknown>)
    : {};
}

function CanvasInner({
  model,
  document,
  layout,
  selectedId,
  selectedIds,
  onSelectionChange,
  readOnly,
  stale,
  staleMessage,
  highlight,
  statusOverlay,
  onSelect,
  onMove,
  onInsertOnEdge,
  onAddAfter,
  onConnect,
  onDelete,
  onDuplicate,
  canConnect,
  focusNodeId,
  hideStepList = false,
}: StudioCanvasProps) {
  const { setViewport, zoomIn, zoomOut } = useReactFlow();
  const canvasRef = useRef<HTMLDivElement | null>(null);
  /** The pane the graph fills — observed so a dock drag/collapse refits. */
  const paneRef = useRef<HTMLDivElement | null>(null);
  const base: FlowModel = useMemo(() => toFlow(model, document, layout), [model, document, layout]);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [dragKind, setDragKind] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ edgeId: string; label: string } | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const [canvasPickerOpen, setCanvasPickerOpen] = useState(false);
  const [stepsOpen, setStepsOpen] = useState(false);

  // The page's callbacks are NOT stable (the page re-creates `handleAddAfter`
  // and the inline `onInsertOnEdge` arrow on every render). The rebuild effect
  // must not depend on their identity, or it re-runs on every page render and
  // re-pushes a fresh node array into the store on every selection change —
  // which is what ping-ponged the selection into "Maximum update depth
  // exceeded". Read them through refs so the rebuild's dependency array stays
  // structural (model/layout/presentation) only.
  const onSelectRef = useRef(onSelect);
  const onAddAfterRef = useRef(onAddAfter);
  const onInsertOnEdgeRef = useRef(onInsertOnEdge);
  const onDuplicateRef = useRef(onDuplicate);
  onSelectRef.current = onSelect;
  onAddAfterRef.current = onAddAfter;
  onInsertOnEdgeRef.current = onInsertOnEdge;
  onDuplicateRef.current = onDuplicate;

  // The node content's click handler calls `onSelect` unconditionally (it has
  // no access to the event). While Shift is held, React Flow's own click
  // handling already adds the node to the multi-selection and reports it via
  // `onSelectionChange` — the page's single-select must stay out of the way,
  // or every Shift+click collapses the multi-selection back to one.
  const shiftHeld = useRef(false);
  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.key === "Shift") shiftHeld.current = true;
    };
    const up = (event: KeyboardEvent) => {
      if (event.key === "Shift") shiftHeld.current = false;
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  const flowIdToNode = useMemo(() => new Map(base.nodes.map((n) => [n.id, n.data.nodeId])), [base]);

  // Palette dragstart/dragend live in another component tree (the Studio
  // page owns the palette), so mirror the module registry into state.
  useEffect(
    () =>
      subscribeDragKind((kind) => {
        setDragKind(kind);
        if (kind === null) setPreview(null);
      }),
    [],
  );

  // Escape cancels an in-flight drag-to-insert (clears the preview).
  useEffect(() => {
    if (!dragKind) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setPreview(null);
        setDragKind(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dragKind]);

  const edgeQuery = useMemo(
    () =>
      base.edges
        .filter((e) => e.type === "insertable")
        .map((e) => ({ id: e.id, from: e.source, to: e.target })),
    [base],
  );
  const nodeBoxes = useMemo(() => {
    // Hit-testing runs in ABSOLUTE flow coordinates (screenToFlowPosition),
    // while a scope child's `position` is relative to its group — add the
    // parent's offset back, or every drop inside a scope misses by the
    // group's whole displacement.
    const absolute = new Map<string, { x: number; y: number }>();
    for (const node of base.nodes) {
      const parent = node.parentId ? absolute.get(node.parentId) : null;
      absolute.set(node.id, {
        x: node.position.x + (parent?.x ?? 0),
        y: node.position.y + (parent?.y ?? 0),
      });
    }
    return Object.fromEntries(
      base.nodes.map((n) => [
        n.id,
        { x: absolute.get(n.id)!.x, y: absolute.get(n.id)!.y, width: n.width, height: n.height },
      ]),
    );
  }, [base]);

  // The selected node's context/selection menu (design 1g): a small menu to
  // the RIGHT of the single selected step, TOP-ALIGNED with it, 8px gap —
  // Duplicate / Delete — plus the same actions on right-click (context menu
  // at the pointer). The menu is kept in FLOW coordinates: it must track the
  // node through any pan/zoom, so its screen position is re-derived from the
  // rendered viewport transform every time that transform changes.
  const [menu, setMenu] = useState<{
    fx: number;
    fy: number;
    /** The node's left/bottom edges in flow coords — below-node fallback. */
    fLeft: number;
    fBottom: number;
    nodeId: string;
  } | null>(null);
  const [menuScreen, setMenuScreen] = useState<{ x: number; y: number } | null>(null);
  const menuFocusRef = useRef<HTMLElement | null>(null);

  const selectedMenuNodeId = useMemo(() => {
    if (readOnly || stale) return null;
    if (selectedId === null) return null;
    if (selectedIds !== undefined && selectedIds.length > 1) return null;
    const node = base.nodes.find((n) => n.data.nodeId === selectedId);
    return node && node.type === "step" ? node.data.nodeId : null;
  }, [readOnly, stale, selectedId, selectedIds, base]);

  const selectedMenuBox = useMemo(() => {
    const node = base.nodes.find((n) => n.data.nodeId === selectedId);
    if (!node) return null;
    return nodeBoxes[node.id] ?? null;
  }, [base, nodeBoxes, selectedId]);

  // Re-clicking the ALREADY-selected step re-opens the menu that a
  // click-away closed: the selection prop never changes, so the effect below
  // does not re-fire — the canvas answers the click itself.
  const selectedMenuBoxRef = useRef(selectedMenuBox);
  selectedMenuBoxRef.current = selectedMenuBox;
  const reopenMenuFor = useCallback(
    (id: string) => {
      if (selectedMenuNodeId === null || id !== selectedMenuNodeId) return;
      const box = selectedMenuBoxRef.current;
      if (!box) return;
      setMenu({
        fx: box.x + box.width,
        fy: box.y,
        fLeft: box.x,
        fBottom: box.y + box.height,
        nodeId: id,
      });
    },
    [selectedMenuNodeId],
  );
  const reopenMenuRef = useRef(reopenMenuFor);
  reopenMenuRef.current = reopenMenuFor;

  useEffect(() => {
    if (selectedMenuNodeId === null) {
      setMenu(null);
      setMenuScreen(null);
      return;
    }
    const box = selectedMenuBox;
    if (!box) return;
    // Remember what had focus before the menu took it, so closing hands it back.
    // `globalThis.document` — the component's own `document` prop shadows
    // the global.
    const active = globalThis.document.activeElement;
    if (active instanceof HTMLElement) {
      menuFocusRef.current = active;
    }
    // Design 1g: right of the node with an 8px gap, top-aligned with it. The
    // box is stored at the node's RIGHT EDGE and BOTTOM; the 8px gap is added
    // in SCREEN pixels so it stays 8px at any zoom.
    setMenu({
      fx: box.x + box.width,
      fy: box.y,
      fLeft: box.x,
      fBottom: box.y + box.height,
      nodeId: selectedMenuNodeId,
    });
  }, [selectedMenuNodeId, selectedMenuBox]);

  const closeMenu = useCallback(() => {
    setMenu(null);
    const el = menuFocusRef.current;
    menuFocusRef.current = null;
    if (el instanceof HTMLElement) el.focus();
  }, []);

  const openMenuAt = useCallback((x: number, y: number, nodeId: string) => {
    const active = globalThis.document.activeElement;
    menuFocusRef.current = active instanceof HTMLElement ? active : null;
    // A pointer menu opens AT the pointer; it has no node box, so the
    // below-fallback (if the pointer hugs the right edge) drops it under the
    // click point, left-aligned there.
    setMenu({ fx: x, fy: y, fLeft: x, fBottom: y, nodeId });
  }, []);

  // Standard controlled pattern: apply every change (position, dimensions,
  // select, …) so the `nodes` state tracks React Flow's internal store —
  // including the `selected` flag, which the rebuild carries forward so a
  // structural rebuild never wipes the current selection. Selection itself is
  // owned by React Flow's internal store; the page's `selectedIds` is a mirror
  // (kept in sync in `onSelectionChange` below) and programmatic changes are
  // pushed once through the apply effect — not re-derived here, which is what
  // used to ping-pong the store into "Maximum update depth exceeded".
  // Apply every change React Flow reports (position, dimensions, and
  // `select`) so the local `nodes` array mirrors the store exactly —
  // EXCEPT `add`/`remove`: the canvas owns the element set (see
  // mirrorOwnedChanges), and the store's diff machinery reporting removals
  // is what emptied the live Workbench's canvas mid-run.
  const onNodesChange = useCallback(
    (changes: NodeChange[]) =>
      setNodes((current) => applyNodeChanges(mirrorOwnedChanges(changes), current)),
    [],
  );
  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) =>
      setEdges((current) => applyEdgeChanges(mirrorOwnedChanges(changes), current)),
    [],
  );

  const onNodeDragStop = useCallback(
    (_event: unknown, node: Node) => {
      // The rebuild effect's data carries the pipeline node id as `id`
      // (not `nodeId`): a dropped drag used to store its position under the
      // key "undefined", so the layout never matched a real node and the
      // next rebuild snapped it back to its dagre place.
      const data = node.data as unknown as { id: string };
      onMove?.(data.id, node.position);
    },
    [onMove],
  );

  // The hit test needs the pointer in FLOW coordinates. React Flow's
  // `screenToFlowPosition` reads the store transform, which lags the DOM
  // viewport transform (observed: it returned a stale offset while the pane
  // was already panned). The DOM transform is the source of truth for what
  // is on screen, so derive the mapping from the rendered `.react-flow__viewport`.
  const clientToFlow = useCallback((clientX: number, clientY: number) => {
    const pane = canvasRef.current?.querySelector<HTMLElement>(".react-flow__pane");
    const viewport = canvasRef.current?.querySelector<HTMLElement>(".react-flow__viewport");
    if (!pane || !viewport) return { x: clientX, y: clientY };
    const rect = pane.getBoundingClientRect();
    const m = /translate\(([-\d.]+)px,\s*([\d.-]+)px\)\s*scale\(([-\d.]+)\)/.exec(
      viewport.style.transform,
    );
    if (!m) return { x: clientX - rect.left, y: clientY - rect.top };
    const tx = Number(m[1]);
    const ty = Number(m[2]);
    const zoom = Number(m[3]) || 1;
    return {
      x: (clientX - rect.left - tx) / zoom,
      y: (clientY - rect.top - ty) / zoom,
    };
  }, []);

  const hitAt = useCallback(
    (clientX: number, clientY: number) =>
      nearestEdge(nodeBoxes, edgeQuery, clientToFlow(clientX, clientY), DROP_EDGE_RADIUS_PX),
    [nodeBoxes, edgeQuery, clientToFlow],
  );

  const onNodeContextMenu: NodeMouseHandler<Node> = useCallback(
    (event, node) => {
      if (readOnly) return;
      const id = (node.data as { id?: string }).id;
      if (typeof id !== "string") return;
      const flow = clientToFlow(event.clientX, event.clientY);
      openMenuAt(flow.x, flow.y, id);
    },
    [readOnly, clientToFlow, openMenuAt],
  );

  const onDragOver = useCallback(
    (event: DragEvent) => {
      const types = event.dataTransfer?.types ?? [];
      if (!types.includes(PALETTE_DRAG_TYPE) || !dragKind) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      const hit = hitAt(event.clientX, event.clientY);
      setPreview(hit ? { edgeId: hit.edgeId, label: stepLabel(dragKind) } : null);
    },
    [dragKind, hitAt],
  );

  const onDrop = useCallback(
    (event: DragEvent) => {
      const kind = event.dataTransfer?.getData(PALETTE_DRAG_TYPE);
      event.preventDefault();
      setPreview(null);
      setDragKind(null);
      setPaletteDragKind(null);
      if (!kind) return;
      const hit = hitAt(event.clientX, event.clientY);
      if (hit) {
        const hitEdge = base.edges.find((e) => e.id === hit.edgeId);
        if (hitEdge) {
          onInsertOnEdge?.(hitEdge.data.edge, kind);
          return;
        }
      }
      onAddAfter?.(selectedId ?? null, [], kind);
    },
    [base.edges, hitAt, onAddAfter, onInsertOnEdge, selectedId],
  );

  // Store-originated selection (clicks, Shift+click, the Shift+drag box)
  // mirrored to the page. One-way: the page reads the selection, it does not
  // push it back (see the rebuild + onNodesChange comments). The callback
  // identity must be STABLE — an inline arrow makes React Flow's
  // SelectionListener re-run its report effect on every canvas render,
  // re-reporting a selection that lags the store's last push by one round
  // trip, which is how the mirror used to feed stale values back into the
  // page. With a stable callback the effect only re-fires when the store's
  // selection genuinely changed, and the page's functional equality guard
  // (`selectMany`) bails out when it already holds that selection.
  const handleSelectionChange = useCallback(
    (selection: { nodes: Node[] } | undefined) => {
      if (!selection) return;
      const ids = selection.nodes.map((n) => (n.data as { id?: string }).id ?? "").filter(Boolean);
      onSelectionChange?.(ids);
    },
    [onSelectionChange],
  );

  const handleConnect = useCallback(
    (connection: Connection) => {
      const from = flowIdToNode.get(connection.source);
      const to = flowIdToNode.get(connection.target);
      if (!from || !to) return;
      const verdict = evaluateConnect(canConnect, from, to);
      if (!verdict.proceed) {
        setRefused(verdict.refused);
        return;
      }
      setRefused(null);
      onConnect?.(from, to);
    },
    [canConnect, flowIdToNode, onConnect],
  );

  const deleteGuarded = useCallback(
    (ids: string[]) => {
      const active = globalThis.document.activeElement;
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;
      onDelete?.(ids);
    },
    [onDelete],
  );

  // The page's current selection, read (through a ref) only by the
  // structural-rebuild path below — deliberately NOT an effect dependency:
  // making the rebuild depend on the selection would re-push the node array
  // on every selection change, the page→store path that used to ping-pong
  // the store into "Maximum update depth exceeded".
  const pageSelRef = useRef<string[]>([]);
  pageSelRef.current =
    selectedIds !== undefined && selectedIds.length > 0
      ? selectedIds
      : selectedId !== null
        ? [selectedId]
        : [];
  const lastBaseRef = useRef(base);

  // Rebuild the React Flow graph when the model, the layout, or a
  // presentation input changes — the canvas owns no other node state.
  // Two rebuild flavors, two selection rules:
  //  • structural (the `base` graph changed — an op or a YAML edit): the old
  //    flow ids are stale (a wrap re-qualifies its children as
  //    until/process, …), so carry-forward would silently DROP the
  //    selection; the cleared store selection would then echo back through
  //    the mirror and clobber the page's post-op selection (e.g. the new
  //    scope after a wrap). A structural rebuild therefore adopts the
  //    page's current selection (the post-op state), filtered to ids that
  //    still exist in the new graph.
  //  • non-structural (preview/highlight/stale churn): carry the local
  //    nodes' current `selected` flags forward — they mirror the store's own
  //    gesture selection — so a rebuild never wipes or changes it.
  useEffect(() => {
    const structural = lastBaseRef.current !== base;
    lastBaseRef.current = base;
    const aliveSelection = structural
      ? new Set(pageSelRef.current.filter((id) => base.nodes.some((n) => n.data.nodeId === id)))
      : null;
    const prevSelected = new Map(nodes.map((n) => [n.id, n.selected === true]));
    // Carry each node's measured size across the rebuild. A rebuilt node
    // object without `measured` makes React Flow's adoptUserNodes reset the
    // store's measurement, and React Flow renders unmeasured nodes with
    // `visibility: hidden` — the node elements keep their size, so their
    // ResizeObserver never re-fires and the canvas would go BLANK for the
    // rest of the run (observed live: mid-run rebuilds left 17/17 nodes
    // hidden; a fresh open re-measured and recovered). Fresh nodes (not in
    // `prevMeasured`) start unmeasured and get measured on first paint.
    const prevMeasured = new Map(nodes.map((n) => [n.id, n.measured]));
    const rfNodes: Node[] = base.nodes.map((b) => {
      const scope = b.data;
      const data: StepNodeRender & Partial<ScopeNodeRender> = {
        id: scope.nodeId,
        kind: scope.kind,
        label: scope.label,
        kindWord: scope.kindWord,
        deferred: scope.deferred,
        when: scope.when,
        terminal: scope.terminal,
        readOnly,
        stale,
        highlight: highlight?.includes(scope.nodeId) ?? false,
        status: statusOverlay?.[scope.nodeId] ?? null,
        onSelect: () => {
          // Shift+click: React Flow multi-selects and reports via
          // onSelectionChange; the page's single-select would clobber it.
          if (shiftHeld.current) return;
          reopenMenuRef.current(scope.nodeId);
          onSelectRef.current?.(scope.nodeId);
        },
        onAddAfter: b.data.terminal
          ? (kind: string) => onAddAfterRef.current?.(scope.nodeId, scope.scope, kind)
          : null,
        emptyBody: scope.emptyBody,
        headerText: scope.headerText ?? `${scope.label} · ${scope.nodeId}`,
        loopNote: scope.loopNote,
        config: nodeConfigOf(document, model, scope.nodeId),
        onAddInside: scope.emptyBody
          ? (kind: string) => onAddAfterRef.current?.(scope.nodeId, scope.scope, kind)
          : null,
      };
      const node: Node = {
        id: b.id,
        type: b.type,
        position: b.position,
        data,
        style: { width: b.width, height: b.height },
        measured: prevMeasured.get(b.id),
        // Structural: the page's (post-op) selection; otherwise the store's
        // own current selection, carried across unchanged.
        selected: aliveSelection
          ? aliveSelection.has(scope.nodeId)
          : (prevSelected.get(b.id) ?? false),
      };
      if (b.type === "scope") {
        node.zIndex = 0;
      } else if (b.parentId) {
        node.parentId = b.parentId;
        node.extent = "parent";
      }
      return node;
    });
    const rfEdges: Edge[] = base.edges.map((b) => {
      const data: InsertableEdgeRender & ErrorEdgeRender = {
        edge: b.data.edge,
        readOnly,
        stale,
        label: b.label,
        labelTitle: b.labelTitle,
        // Collision-checked label anchor (flowModel pre-computes it in absolute
        // flow coords); null lets the edge fall back to the path midpoint.
        labelAnchor: b.labelX !== null && b.labelY !== null ? { x: b.labelX, y: b.labelY } : null,
        preview: preview?.edgeId === b.id ? preview.label : null,
        onInsert: (kind: string) => onInsertOnEdgeRef.current?.(b.data.edge, kind),
        // The routing geometry: the edge draws `routeEdge(sourceBox, targetBox,
        // axis)` — the same path the label anchor was checked against.
        sourceBox: b.sourceBox,
        targetBox: b.targetBox,
        axis: b.axis,
      };
      return { id: b.id, source: b.source, target: b.target, type: b.type, data };
    });
    setNodes(rfNodes);
    setEdges(rfEdges);
  }, [base, readOnly, stale, highlight, statusOverlay, preview]);

  /* --------------------------------------------- viewport fitting & repair
   * The canvas owns its own fit — React Flow's mount-time `fitView` prop is
   * gone: it resolves while nodes are still unmeasured and the pane may be
   * transiently 0×0, and the resulting wrong (or NaN) transform then
   * sticks (this is how the live Workbench went blank mid-run). Instead
   * the fit is computed from the layout's absolute boxes into the pane's
   * REAL current size, refused outright when either is degenerate
   * (computeFitViewport), and applied only when finite.
   *
   * Refit triggers (nothing else — a manual user pan/zoom is never
   * clobbered afterwards):
   *   • the graph's node set changes (structural rebuild, first fit),
   *   • the pane transitions from zero to a real size.
   * A MutationObserver sentinel repairs anything that still ends up blank
   * or non-finite: restore the last good transform, or re-fit when every
   * node sits outside the pane and the reader has not moved the view. */
  const nodeSetKey = useMemo(() => base.nodes.map((n) => n.id).join("\u0000"), [base]);
  const baseRef = useRef(base);
  baseRef.current = base;
  const nodeBoxesRef = useRef(nodeBoxes);
  nodeBoxesRef.current = nodeBoxes;
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const allMeasured =
    base.nodes.length > 0 &&
    nodes.length === base.nodes.length &&
    nodes.every(
      (n) =>
        n.measured !== undefined &&
        isMeasuredBox({ width: n.measured.width, height: n.measured.height }),
    );
  const allMeasuredRef = useRef(allMeasured);
  allMeasuredRef.current = allMeasured;
  const userMovedRef = useRef(false);
  const lastGoodRef = useRef<{ x: number; y: number; zoom: number } | null>(null);
  const lastFittedSetRef = useRef<string | null>(null);
  const paneSizeRef = useRef({ w: 0, h: 0 });
  const pendingRealSizeRef = useRef(false);
  const focusedRef = useRef<string | null>(null);
  const [paneReal, setPaneReal] = useState(0); // tick: zero → real size

  const viewportEl = useCallback(
    () => canvasRef.current?.querySelector<HTMLElement>(".react-flow__viewport") ?? null,
    [],
  );

  // The menu's pane-absolute position, re-derived from the rendered viewport
  // transform (flow → screen). While the menu is open, a MutationObserver on
  // the viewport re-derives it on every pan/zoom, so the menu never drifts
  // from its node.
  const updateMenuScreen = useCallback(() => {
    if (menu === null) return;
    const t = parseViewportTransform(viewportEl()?.style.transform ?? null);
    const zoom = t?.zoom ?? 1;
    const tx = t?.x ?? 0;
    const ty = t?.y ?? 0;
    const right = { x: menu.fx * zoom + tx + 8, y: menu.fy * zoom + ty };
    // Phone (design pass 2 #6): when the menu would be cut off at the pane's
    // right edge, it sits BELOW the node instead, left-aligned to it, same
    // 8px gap.
    const paneWidth = paneRef.current?.clientWidth ?? 0;
    if (paneWidth > 0 && right.x + MENU_WIDTH_PX > paneWidth - 8) {
      setMenuScreen({ x: menu.fLeft * zoom + tx, y: menu.fBottom * zoom + ty + 8 });
      return;
    }
    setMenuScreen(right);
  }, [menu, viewportEl]);

  useEffect(() => {
    if (menu === null) return;
    updateMenuScreen();
    const el = viewportEl();
    if (!el || typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(updateMenuScreen);
    observer.observe(el, { attributes: true, attributeFilter: ["style"] });
    return () => observer.disconnect();
  }, [menu, updateMenuScreen, viewportEl]);

  // Click-away closes the menu WITHOUT swallowing the gesture: an invisible
  // overlay over the whole pane used to make the canvas inert whenever a
  // step was selected (the menu is open by selection) — edge "+"s, nodes and
  // drags all hit the overlay first. A capture-phase pointerdown outside the
  // menu closes it and lets the click through to its real target.
  useEffect(() => {
    if (menu === null) return;
    const onPointerDown = (event: Event) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest?.("[data-testid='studio-node-menu']")) return;
      // The dismissing click owns focus from here on; do not steal it back.
      menuFocusRef.current = null;
      setMenu(null);
      setMenuScreen(null);
    };
    globalThis.document.addEventListener("pointerdown", onPointerDown, true);
    return () => globalThis.document.removeEventListener("pointerdown", onPointerDown, true);
  }, [menu]);

  /** Fit the graph into the pane. Returns false when the guard refused
   * (zero-size pane, unmeasured boxes) — the caller retries on the next
   * trigger; a non-finite viewport is never applied. */
  const safeFit = useCallback(() => {
    const pane = paneRef.current;
    if (!pane) return false;
    const rect = pane.getBoundingClientRect();
    // Fit with the MEASURED sizes when known (React Flow's own fit uses the
    // same inputs), falling back to the layout's estimates. Both `nodeBoxes`
    // and the local `nodes` state are keyed by the same flow id.
    const measuredById = new Map(nodesRef.current.map((n) => [n.id, n.measured]));
    const boxes = Object.entries(nodeBoxesRef.current).map(([id, box]) => {
      const mw = measuredById.get(id)?.width;
      const mh = measuredById.get(id)?.height;
      const w = mw !== undefined && Number.isFinite(mw) && mw > 0 ? mw : box.width;
      const h = mh !== undefined && Number.isFinite(mh) && mh > 0 ? mh : box.height;
      return { x: box.x, y: box.y, width: w, height: h };
    });
    const vp = computeFitViewport(boxes, rect.width, rect.height);
    if (vp === null) return false;
    setViewport(vp, { duration: 0 });
    lastGoodRef.current = vp;
    return true;
  }, [setViewport]);
  const safeFitRef = useRef(safeFit);
  safeFitRef.current = safeFit;

  // Structural (first) fit + the pane's zero→real transition.
  useEffect(() => {
    if (base.nodes.length === 0) return;
    if (!allMeasured) return; // unmeasured nodes: fit later, never wrong
    const structural = lastFittedSetRef.current !== nodeSetKey;
    const realSizeJustArrived = pendingRealSizeRef.current;
    if (!structural && !realSizeJustArrived) return;
    pendingRealSizeRef.current = false;
    if (safeFit()) lastFittedSetRef.current = nodeSetKey;
  }, [nodeSetKey, allMeasured, paneReal, base.nodes.length, safeFit]);

  // The pane's size: detect the zero→real transition only (ordinary
  // resizes keep the reader's current zoom/pan).
  useEffect(() => {
    const pane = paneRef.current;
    if (!pane || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const r = pane.getBoundingClientRect();
      const wasZero =
        paneSizeRef.current.w < MIN_FIT_PANE_PX || paneSizeRef.current.h < MIN_FIT_PANE_PX;
      paneSizeRef.current = { w: r.width, h: r.height };
      if (wasZero && r.width >= MIN_FIT_PANE_PX && r.height >= MIN_FIT_PANE_PX) {
        pendingRealSizeRef.current = true;
        setPaneReal((tick) => tick + 1);
      }
    });
    observer.observe(pane);
    return () => {
      observer.disconnect();
    };
  }, []);

  // A wheel over the canvas is a manual zoom (zoomOnScroll) — mark the view
  // reader-owned so the sentinel never refits over it.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = () => {
      userMovedRef.current = true;
    };
    el.addEventListener("wheel", onWheel, { passive: true });
    return () => {
      el.removeEventListener("wheel", onWheel);
    };
  }, []);

  // The sentinel: watch the rendered transform. A non-finite one (a NaN
  // fit) is repaired to the last good transform; a finite one that leaves
  // every node outside the pane — while the reader has not moved the view
  // and everything is measured — is re-fit.
  useEffect(() => {
    const el = viewportEl();
    if (!el || typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(() => {
      const t = parseViewportTransform(el.style.transform);
      if (t === null) {
        if (lastGoodRef.current) setViewport(lastGoodRef.current, { duration: 0 });
        return;
      }
      lastGoodRef.current = t;
      if (userMovedRef.current) return;
      if (baseRef.current.nodes.length === 0 || !allMeasuredRef.current) return;
      const pane = paneRef.current?.getBoundingClientRect();
      if (!pane || pane.width < MIN_FIT_PANE_PX || pane.height < MIN_FIT_PANE_PX) return;
      const anyInside = [...el.querySelectorAll<HTMLElement>(".react-flow__node")].some((n) => {
        const r = n.getBoundingClientRect();
        return (
          r.left < pane.left + pane.width &&
          r.right > pane.left &&
          r.top < pane.top + pane.height &&
          r.bottom > pane.top
        );
      });
      if (anyInside) return;
      // Blank canvas: re-fit one frame later (the transform may still be
      // mid-update), but only if it is still blank and nothing moved.
      requestAnimationFrame(() => {
        if (userMovedRef.current) return;
        const still = parseViewportTransform(viewportEl()?.style.transform ?? null);
        if (still === null) return;
        const paneNow = paneRef.current?.getBoundingClientRect();
        if (!paneNow || paneNow.width < MIN_FIT_PANE_PX) return;
        const stillBlank = [
          ...(viewportEl()?.querySelectorAll<HTMLElement>(".react-flow__node") ?? []),
        ].every((n) => {
          const r = n.getBoundingClientRect();
          return !(
            r.left < paneNow.left + paneNow.width &&
            r.right > paneNow.left &&
            r.top < paneNow.top + paneNow.height &&
            r.bottom > paneNow.top
          );
        });
        if (stillBlank) safeFitRef.current();
      });
    });
    observer.observe(el, { attributes: true, attributeFilter: ["style"] });
    return () => {
      observer.disconnect();
    };
  }, [setViewport, viewportEl]);

  // The deep link's node: centre it once it is on the canvas and measured —
  // until the reader pans/zooms (userMovedRef), after which their viewport
  // wins and the canvas never moves it again.
  useEffect(() => {
    const defNode = base.nodes.find((n) => n.data.nodeId === focusNodeId);
    const box = defNode ? nodeBoxes[defNode.id] : null;
    const pane = paneRef.current?.getBoundingClientRect();
    if (!focusNodeId || userMovedRef.current) return;
    if (focusedRef.current === focusNodeId) return;
    if (!allMeasured) return;
    if (!box) return;
    if (!pane || pane.width < MIN_FIT_PANE_PX || pane.height < MIN_FIT_PANE_PX) return;
    focusedRef.current = focusNodeId;
    const current = parseViewportTransform(viewportEl()?.style.transform ?? null) ?? {
      x: 0,
      y: 0,
      zoom: 1,
    };
    const vp = centerOnBox(box, pane.width, pane.height, current.zoom);
    if (vp) {
      setViewport(vp, { duration: 0 });
      lastGoodRef.current = vp;
    }
  }, [focusNodeId, allMeasured, nodeSetKey, base, nodeBoxes, paneReal, setViewport, viewportEl]);

  // Backspace/Delete removes the selected steps (design 1g: the ⌫ action).
  // One window handler is the canvas's only key-delete path — React Flow's
  // own deleteKeyCode would double-delete through onNodesDelete.
  useEffect(() => {
    if (readOnly) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Backspace" && event.key !== "Delete") return;
      const ids = pageSelRef.current;
      if (ids.length === 0) return;
      event.preventDefault();
      deleteGuarded(ids);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [readOnly, deleteGuarded]);

  return (
    <div
      ref={canvasRef}
      className="studio-canvas flex h-full min-h-0 flex-col border border-line bg-paper"
      data-testid="studio-canvas"
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {/* The React Flow edge layer paints under the node layer (DOM order in
       * the viewport), so scope group backgrounds would swallow the edges.
       * Lift the edges above the nodes and the labels above the edges — the
       * edge "+" buttons must stay clickable. */}
      <style>
        {
          ".studio-canvas .react-flow__edges{z-index:1}.studio-canvas .react-flow__edgelabel-renderer{z-index:2}"
        }
      </style>
      <div
        ref={paneRef}
        className="relative min-h-0 flex-1"
        style={stale ? { opacity: 0.55, filter: "grayscale(1)" } : undefined}
      >
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          minZoom={0.4}
          maxZoom={1.25}
          onlyRenderVisibleElements={false}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeDragStop={onNodeDragStop}
          onConnect={handleConnect}
          onMoveStart={() => {
            userMovedRef.current = true;
          }}
          // Multi-selection: Shift+click adds a step to the selection (the
          // store's default multiSelectionKeyCode is Control — without this a
          // Shift+click just replaces the selection). The Shift+drag selection
          // box comes from the default selectionKeyCode=Shift.
          selectionMode={SelectionMode.Partial}
          multiSelectionKeyCode="Shift"
          onSelectionChange={handleSelectionChange}
          onNodesDelete={(deleted) =>
            deleteGuarded(deleted.map((n) => (n.data as { id?: string }).id ?? "").filter(Boolean))
          }
          onEdgesDelete={(deleted) => deleteGuarded(deleted.map((e) => e.id))}
          onNodeContextMenu={onNodeContextMenu}
          nodesDraggable={!readOnly && !stale}
          nodesConnectable={!readOnly && !stale}
        >
          <Background />
          {/* Design 1g canvas chrome: the React Flow default Controls (and
              the "Map" minimap toggle / lock) are replaced by one compact
              bottom-right group: − + fit (mono, ink border). `fit` runs the
              canvas' own guarded fit, never React Flow's unguarded one. The
              "React Flow" attribution stays: hiding it needs a Pro licence
              we do not hold. */}
          <div
            className="absolute bottom-[10px] right-[10px] z-10 flex overflow-hidden rounded-[3px] border border-line-strong bg-surface"
            data-testid="canvas-controls"
          >
            <button
              type="button"
              aria-label="Zoom out"
              data-testid="canvas-zoom-out"
              onClick={() => zoomOut({ duration: 200 })}
              className="h-[26px] w-[28px] border-r border-line text-[13px] leading-none text-ink hover:bg-fill"
            >
              −
            </button>
            <button
              type="button"
              aria-label="Zoom in"
              data-testid="canvas-zoom-in"
              onClick={() => zoomIn({ duration: 200 })}
              className="h-[26px] w-[28px] border-r border-line text-[13px] leading-none text-ink hover:bg-fill"
            >
              +
            </button>
            <button
              type="button"
              aria-label="Fit the graph to the pane"
              data-testid="canvas-fit"
              onClick={() => {
                userMovedRef.current = false;
                safeFit();
              }}
              className="h-[26px] px-[8px] font-mono text-[10.5px] leading-none text-ink hover:bg-fill"
            >
              fit
            </button>
          </div>
          <span
            className="pointer-events-none absolute bottom-[14px] left-[16px] z-10 font-mono text-[10.5px] text-faint"
            data-testid="canvas-caption"
          >
            always top to bottom · lines leave the bottom and enter the top
          </span>
        </ReactFlow>
        {stale && (
          <div
            role="alert"
            data-testid="canvas-stale-banner"
            className="absolute left-1/2 top-3 z-10 -translate-x-1/2 rounded-md border border-st-waiting-pale-edge bg-st-waiting-pale-body px-3 py-1.5 text-[12px] text-st-waiting-pale-fg"
          >
            {staleMessage ??
              "YAML has errors — the canvas shows the last valid version; graph editing is paused."}
          </div>
        )}
        {base.nodes.length === 0 && !stale && (
          <div className="absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2">
            <button
              type="button"
              data-testid="canvas-add-first"
              className="rounded-md border border-dashed border-line-strong bg-surface px-3 py-1.5 text-[13px] text-ink-2 hover:border-accent hover:text-accent"
              onClick={() => setCanvasPickerOpen(true)}
            >
              + Add first step
            </button>
            {canvasPickerOpen && (
              <div className="absolute left-0 top-full mt-1">
                <StepPicker
                  title="Add the first step"
                  onPick={(kind) => {
                    setCanvasPickerOpen(false);
                    onAddAfter?.(null, [], kind);
                  }}
                  onClose={() => setCanvasPickerOpen(false)}
                />
              </div>
            )}
          </div>
        )}
        {refused && (
          <div
            role="status"
            data-testid="connect-refused"
            className="absolute bottom-[44px] left-3 z-10 max-w-sm rounded-md border border-st-failed-pale-edge bg-st-failed-pale-body px-3 py-1.5 text-[12px] text-st-failed-pale-fg"
          >
            {refused}
          </div>
        )}
        {menu && menuScreen !== null && (
          <NodeMenu
            x={menuScreen.x}
            y={menuScreen.y}
            nodeId={menu.nodeId}
            onDuplicate={onDuplicate}
            onDelete={(ids) => onDelete?.(ids)}
            onClose={closeMenu}
          />
        )}
      </div>

      {/* Design 1g: the accessible steps list is a collapsed one-line mono
          disclosure (`steps list · N`), never a panel eating canvas height.
          Pass 2 #8 drops it entirely from the Studio — the status bar counts
          the steps there; the Run Workbench keeps the definition table. */}
      {hideStepList ? null : (
        <section className="border-t border-line bg-surface" data-testid="canvas-step-list">
          <button
            type="button"
            aria-expanded={stepsOpen}
            aria-controls="studio-canvas-steps"
            onClick={() => setStepsOpen((open) => !open)}
            className="w-full px-3 py-1 text-left font-mono text-[10.5px] text-muted hover:bg-fill"
          >
            {stepsOpen ? "▾" : "▸"} steps list · {model.nodes.length}
          </button>
          {/* The rows stay in the DOM behind the disclosure (they are the
            accessible name list the Workbench reads); the disclosure just
            hides them visually, so they never eat canvas height. */}
          <ol
            id="studio-canvas-steps"
            className={`max-h-48 overflow-y-auto px-3 pb-2 ${stepsOpen ? "" : "hidden"}`}
          >
            {model.nodes.map((node) => (
              <li key={`${scopeKey(node.scope)}\u0000${node.id}`}>
                <button
                  type="button"
                  data-testid={`canvas-step-row-${node.id}`}
                  onClick={() => onSelect(node.id)}
                  className={[
                    "w-full rounded-md px-2 py-1 text-left text-[12px] hover:bg-fill",
                    selectedId === node.id ||
                    (selectedIds !== undefined && selectedIds.includes(node.id))
                      ? "bg-accent-wash text-accent"
                      : "text-ink",
                  ].join(" ")}
                >
                  <span className="font-medium">{node.label}</span>{" "}
                  <span className="font-mono text-[11px] text-muted">{node.id}</span>
                  {node.dependsOn.length > 0 && (
                    <span className="text-faint"> after {node.dependsOn.join(", ")}</span>
                  )}
                </button>
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}
