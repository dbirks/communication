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
import { useCallback, useEffect, useMemo, useState, type DragEvent } from "react";

export type UiLayout = { nodes?: Record<string, { x: number; y: number }> };

export interface StudioCanvasProps {
  model: GraphModel;
  /** The parsed JS document (for `layoutDefinition`). */
  document: unknown;
  /** Saved positions keyed by node id; override the dagre positions. */
  layout: UiLayout;
  selectedId: string | null;
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
 * "insert here" drop (design doc §3.2). */
const DROP_EDGE_RADIUS_PX = 24;

function CanvasInner({
  model,
  document,
  layout,
  selectedId,
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
  const { screenToFlowPosition } = useReactFlow();
  const base: FlowModel = useMemo(() => toFlow(model, document, layout), [model, document, layout]);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [dragKind, setDragKind] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ edgeId: string; label: string } | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const [canvasPickerOpen, setCanvasPickerOpen] = useState(false);
  const [stepsOpen, setStepsOpen] = useState(true);

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
  const nodeBoxes = useMemo(
    () =>
      Object.fromEntries(
        base.nodes.map((n) => [
          n.id,
          { x: n.position.x, y: n.position.y, width: n.width, height: n.height },
        ]),
      ),
    [base],
  );

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
      const data = node.data as unknown as { nodeId: string };
      onMove?.(data.nodeId, node.position);
    },
    [onMove],
  );

  const hitAt = useCallback(
    (clientX: number, clientY: number) =>
      nearestEdge(
        nodeBoxes,
        edgeQuery,
        screenToFlowPosition({ x: clientX, y: clientY }),
        DROP_EDGE_RADIUS_PX,
      ),
    [nodeBoxes, edgeQuery, screenToFlowPosition],
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

  // Rebuild the React Flow graph when the model, the layout or any
  // presentation input changes — the canvas owns no other node state.
  useEffect(() => {
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
        onSelect: () => onSelect(scope.nodeId),
        onAddAfter: b.data.terminal
          ? (kind: string) => onAddAfter?.(scope.nodeId, scope.scope, kind)
          : null,
        emptyBody: scope.emptyBody,
        headerText: scope.headerText ?? `${scope.label} · ${scope.nodeId}`,
        loopNote: scope.loopNote,
        onAddInside: scope.emptyBody
          ? (kind: string) => onAddAfter?.(scope.nodeId, scope.scope, kind)
          : null,
      };
      const node: Node = {
        id: b.id,
        type: b.type,
        position: b.position,
        data,
        style: { width: b.width, height: b.height },
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
        preview: preview?.edgeId === b.id ? preview.label : null,
        onInsert: (kind: string) => onInsertOnEdge?.(b.data.edge, kind),
      };
      return { id: b.id, source: b.source, target: b.target, type: b.type, data };
    });
    setNodes(rfNodes);
    setEdges(rfEdges);
  }, [
    base,
    readOnly,
    stale,
    highlight,
    statusOverlay,
    onSelect,
    onAddAfter,
    onInsertOnEdge,
    preview,
  ]);

  const deleteKeys = readOnly ? null : ["Backspace", "Delete"];

  return (
    <div
      className="flex min-h-0 flex-col border border-line bg-paper"
      data-testid="studio-canvas"
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <div
        className="relative min-h-0 flex-1"
        style={stale ? { opacity: 0.55, filter: "grayscale(1)" } : undefined}
      >
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          fitView
          onlyRenderVisibleElements={false}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeDragStop={onNodeDragStop}
          onConnect={handleConnect}
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
                    selectedId === node.id ? "bg-accent-wash text-accent" : "text-ink",
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
