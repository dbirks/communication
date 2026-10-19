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
  Controls,
  MiniMap,
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
} from "@xyflow/react";
import {
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
  onConnect?(from: string, to: string): void;
  onDelete?(ids: string[]): void;
  canConnect?(from: string, to: string): { ok: true } | { ok: false; reason: string };
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
 * straight segment in a tight left-to-right layout (a short hop with a rank
 * offset bows ~30px at its midpoint), and the drop preview is drawn AT the
 * path midpoint — so the radius must comfortably clear the bow, not just the
 * 24px the doc names for a straight edge. */
const DROP_EDGE_RADIUS_PX = 48;

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
  canConnect,
}: StudioCanvasProps) {
  const { fitView } = useReactFlow();
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
  const [stepsOpen, setStepsOpen] = useState(true);

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
  onSelectRef.current = onSelect;
  onAddAfterRef.current = onAddAfter;
  onInsertOnEdgeRef.current = onInsertOnEdge;

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

  // Standard controlled pattern: apply every change (position, dimensions,
  // select, …) so the `nodes` state tracks React Flow's internal store —
  // including the `selected` flag, which the rebuild carries forward so a
  // structural rebuild never wipes the current selection. Selection itself is
  // owned by React Flow's internal store; the page's `selectedIds` is a mirror
  // (kept in sync in `onSelectionChange` below) and programmatic changes are
  // pushed once through the apply effect — not re-derived here, which is what
  // used to ping-pong the store into "Maximum update depth exceeded".
  // Apply every change React Flow reports (position, dimensions, and
  // `select`) so the local `nodes` array mirrors the store exactly.
  // Selection is owned by React Flow's internal store; the page's
  // `selectedIds` is a one-way mirror of it (via `onSelectionChange` below)
  // and never writes selection flags back into the canvas. A page→store
  // selection writer is what ping-ponged the store into "Maximum update
  // depth exceeded": the page's mirror lagged the store by one push, every
  // re-apply re-pushed a stale selection, and the store and the page chased
  // each other until React aborted the update chain.
  const onNodesChange = useCallback(
    (changes: NodeChange[]) => setNodes((current) => applyNodeChanges(changes, current)),
    [],
  );
  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => setEdges((current) => applyEdgeChanges(changes, current)),
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
          onSelectRef.current?.(scope.nodeId);
        },
        onAddAfter: b.data.terminal
          ? (kind: string) => onAddAfterRef.current?.(scope.nodeId, scope.scope, kind)
          : null,
        emptyBody: scope.emptyBody,
        headerText: scope.headerText ?? `${scope.label} · ${scope.nodeId}`,
        loopNote: scope.loopNote,
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
      };
      return { id: b.id, source: b.source, target: b.target, type: b.type, data };
    });
    setNodes(rfNodes);
    setEdges(rfEdges);
  }, [base, readOnly, stale, highlight, statusOverlay, preview]);

  // Fit once when the first batch of nodes lands, and re-fit whenever the
  // pane itself resizes (a dock drag or collapse changes the space the
  // graph has to fill). padding 0.08 + the 0.4→1.25 zoom band keep the graph
  // filling the pane while staying readable at first render.
  const fit = useCallback(
    () => fitView({ padding: 0.08, duration: 0, minZoom: 0.4, maxZoom: 1.25 }),
    [fitView],
  );
  const fitted = useRef(false);
  useEffect(() => {
    if (fitted.current || base.nodes.length === 0) return;
    fitted.current = true;
    requestAnimationFrame(fit);
  }, [base, fit]);
  useEffect(() => {
    const pane = paneRef.current;
    if (!pane || typeof ResizeObserver === "undefined") return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fit);
    });
    observer.observe(pane);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [fit]);

  const deleteKeys = readOnly ? null : ["Backspace", "Delete"];

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
          fitView
          minZoom={0.4}
          maxZoom={1.25}
          onlyRenderVisibleElements={false}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeDragStop={onNodeDragStop}
          onConnect={handleConnect}
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
          nodesDraggable={!readOnly && !stale}
          nodesConnectable={!readOnly && !stale}
          deleteKeyCode={deleteKeys}
        >
          <Background />
          <Controls position="bottom-right" />
          <MiniMap position="bottom-left" className="hidden min-[1024px]:block" pannable zoomable />
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
            className="absolute bottom-3 left-3 z-10 max-w-sm rounded-md border border-st-failed-pale-edge bg-st-failed-pale-body px-3 py-1.5 text-[12px] text-st-failed-pale-fg"
          >
            {refused}
          </div>
        )}
      </div>

      <section className="border-t border-line bg-surface" data-testid="canvas-step-list">
        <button
          type="button"
          aria-expanded={stepsOpen}
          aria-controls="studio-canvas-steps"
          onClick={() => setStepsOpen((open) => !open)}
          className="w-full px-3 py-1.5 text-left text-[12px] font-semibold text-ink-2 hover:bg-fill"
        >
          {stepsOpen ? "▾" : "▸"} Steps list ({model.nodes.length})
        </button>
        {stepsOpen && (
          <ol id="studio-canvas-steps" className="max-h-48 overflow-y-auto px-3 pb-2">
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
        )}
      </section>
    </div>
  );
}
