/**
 * flowModel.ts — pure translation from the graph model + dagre layout to
 * React Flow graph shapes, plus the drag-to-insert hit test.
 *
 * `toFlow` never mutates anything: positions come from `layoutDefinition`
 * (the one dagre source of truth), and the draft's `ui_layout` overrides
 * replace them by node id. Children of a scope group carry positions
 * RELATIVE to the group, as React Flow expects for `parentId` children.
 */
import { DEFERRED_KINDS, kindWord, type DefinitionDocument } from "../../lib/pipeline/definition";
import {
  scopeKey,
  STEP_LIBRARY,
  type GraphModel,
  type GraphNode,
  type GraphEdge,
  type ScopePath,
} from "../../lib/pipeline/graphDoc";
import {
  layoutDefinition,
  type GraphGroupView,
  type GraphNodeView,
} from "../../lib/pipeline/layout";

export interface LayoutOverrides {
  nodes?: Record<string, { x: number; y: number }>;
}

/** Static payload of a step or scope node — the canvas adds handlers on top. */
export interface FlowNodeData {
  /** The definition node id (the name an expression may refer to). */
  nodeId: string;
  kind: string;
  /** Approachable name from the step library. */
  label: string;
  kindWord: string;
  /** Milestone word for deferred kinds, e.g. "not runnable yet: M5". */
  deferred: string | null;
  /** The `when` CEL guard, for labels and steps-list prose. */
  when: string | null;
  scope: ScopePath;
  /** No non-error dependents in this node's scope → a trailing "+" makes sense. */
  terminal: boolean;
  /** Scope group whose body holds no nodes yet → "+ Add step inside". */
  emptyBody: boolean;
  /** The layout's whole group bar string ("Repeat until … · max 4"). */
  headerText: string | null;
  loopNote: string | null;
}

export interface FlowNodeBase {
  /** Scope-qualified id — unique even when two scopes share a node id. */
  id: string;
  type: "step" | "scope";
  position: { x: number; y: number };
  width: number;
  height: number;
  /** Flow id of the enclosing scope group, or null at the root. */
  parentId: string | null;
  data: FlowNodeData;
}

export interface FlowEdgeBase {
  id: string;
  source: string;
  target: string;
  type: "insertable" | "error";
  /** "on error" for error routes, short `when` text for guarded edges. */
  label: string | null;
  data: { edge: GraphEdge };
}

export interface FlowModel {
  nodes: FlowNodeBase[];
  edges: FlowEdgeBase[];
}

/** `${scope}/id` — the flow's node ids are scope-qualified so two scopes may
 * share a node id without colliding (the m4 sample has `implement` twice). */
export function flowId(scope: ScopePath, id: string): string {
  return scope.length > 0 ? `${scopeKey(scope)}/${id}` : id;
}

/** The enclosing scope group's flow id for a node at `scope` (null at root). */
function parentFlowId(scope: ScopePath): string | null {
  if (scope.length === 0) return null;
  return flowId(scope.slice(0, -1), scope[scope.length - 1]);
}

function labelFor(kind: string): string {
  const entry = STEP_LIBRARY.find((s) => s.kind === kind);
  return entry?.label ?? kind.replaceAll(".", " ");
}

function shortWhen(when: string): string {
  const flat = when.replaceAll(/\s+/g, " ").trim();
  return flat.length > 44 ? `${flat.slice(0, 43)}…` : flat;
}

const scopeScopeKey = (n: GraphNode): string => JSON.stringify(n.scope);

/**
 * Build the React Flow graph from the parsed model and the dagre layout.
 * Scope nodes become group nodes ("scope" type); `ui_layout` overrides
 * replace the dagre positions by node id. Child positions are made relative
 * to the enclosing group here, because React Flow adds a `parentId` child's
 * position to its parent's.
 */
export function toFlow(
  model: GraphModel,
  document: unknown,
  layout: LayoutOverrides = {},
): FlowModel {
  const laid = layoutDefinition(document as DefinitionDocument);
  if (!laid) return { nodes: [], edges: [] };

  const nodeByPointer = new Map(laid.nodes.map((n) => [n.pointer, n]));
  const groupByPointer = new Map(laid.groups.map((g) => [g.pointer, g]));
  const overridden = (id: string) => layout.nodes?.[id] ?? null;

  /** Absolute box of every node or group, before overrides. */
  const abs = new Map<
    string,
    { node: GraphNode; x: number; y: number; width: number; height: number }
  >();

  for (const node of model.nodes) {
    const group: GraphGroupView | undefined = node.isScope
      ? groupByPointer.get(node.pointer)
      : undefined;
    const box: GraphNodeView | undefined = node.isScope
      ? undefined
      : nodeByPointer.get(node.pointer);
    let size: { x: number; y: number; width: number; height: number } | null = null;
    if (group) {
      size = { x: group.x, y: group.y, width: group.width, height: group.height };
    } else if (box) {
      // An empty body has no dagre cluster, so the scope renders as a group
      // sized off its own node box (the layout degrades to a plain node).
      size = {
        x: box.x,
        y: box.y,
        width: Math.max(box.width, 208),
        height: Math.max(box.height, 96),
      };
    }
    if (!size) continue;
    abs.set(flowId(node.scope, node.id), {
      node,
      x: size.x,
      y: size.y,
      width: size.width,
      height: size.height,
    });
  }

  const nodes: FlowNodeBase[] = [];
  const byFlowId = new Map<string, FlowNodeBase>();
  for (const node of model.nodes) {
    const entry = abs.get(flowId(node.scope, node.id));
    if (!entry) continue;
    const override = overridden(node.id);
    const position = override ?? { x: entry.x, y: entry.y };
    const isScope = node.isScope;
    const base: FlowNodeBase = {
      id: flowId(node.scope, node.id),
      type: isScope ? "scope" : "step",
      position,
      width: entry.width,
      height: entry.height,
      parentId: parentFlowId(node.scope),
      data: {
        nodeId: node.id,
        kind: node.kind,
        label: node.label,
        kindWord: kindWord(node.kind),
        deferred:
          node.kind in DEFERRED_KINDS
            ? (DEFERRED_KINDS[node.kind as keyof typeof DEFERRED_KINDS] ?? "not runnable yet")
            : null,
        when: node.when,
        scope: node.scope,
        terminal: !isScope && hasNoDependents(model, node),
        emptyBody: isScope && groupByPointer.get(node.pointer) === undefined,
        headerText: headerTextFor(node, groupByPointer.get(node.pointer)),
        loopNote: groupByPointer.get(node.pointer)?.loopNote ?? null,
      },
    };
    nodes.push(base);
    byFlowId.set(base.id, base);
  }

  // Children ride on their group: React Flow adds a child's position to the
  // group's, so store the offset — not the absolute dagre coordinate.
  for (const base of nodes) {
    if (!base.parentId) continue;
    const parent = byFlowId.get(base.parentId);
    if (!parent) continue;
    base.position = {
      x: base.position.x - parent.position.x,
      y: base.position.y - parent.position.y,
    };
  }

  const edges: FlowEdgeBase[] = model.edges.map((edge) => ({
    id: edge.id,
    source: flowId(edge.scope, edge.from),
    target: flowId(edge.scope, edge.to),
    type: edge.kind === "error" ? "error" : "insertable",
    label:
      edge.kind === "error"
        ? "on error"
        : edge.kind === "guarded" && edgeWhen(model, edge)
          ? shortWhen(edgeWhen(model, edge) as string)
          : null,
    data: { edge },
  }));

  return { nodes, edges };
}

/** No sibling in the node's own scope depends on it (error routes don't count:
 * a step inserted after the target still reads the same outputs). */
function hasNoDependents(model: GraphModel, node: GraphNode): boolean {
  return !model.nodes.some(
    (other) =>
      other !== node &&
      scopeScopeKey(other) === scopeScopeKey(node) &&
      other.dependsOn.includes(node.id),
  );
}

function edgeWhen(model: GraphModel, edge: GraphEdge): string | null {
  const target = model.nodes.find((n) => n.scope === edge.scope && n.id === edge.to);
  return target?.when ?? null;
}

/** The group bar from the layout, or a plain fallback for an empty body (the
 * layout renders that as a plain node, so there is no group to read). */
function headerTextFor(node: GraphNode, group: GraphGroupView | undefined): string {
  if (group?.headerText) return group.headerText;
  const word = kindWord(node.kind).toLowerCase();
  const pass =
    node.kind === "until"
      ? "until the pass condition holds"
      : node.kind === "for_each"
        ? "once per item"
        : "";
  return [word, node.id, pass].filter(Boolean).join(" · ");
}

export function stepLabel(kind: string): string {
  return labelFor(kind);
}

/** Point-to-segment distance in flow coordinates. */
export function pointSegmentDistance(
  p: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const len2 = abx * abx + aby * aby;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2));
  return Math.hypot(p.x - (a.x + t * abx), p.y - (a.y + t * aby));
}

export interface NearestEdgeQuery {
  id: string;
  from: string;
  to: string;
}

/**
 * The nearest edge within `maxDistance` of the pointer, measured to the
 * straight segment between the source's exit point and the target's entry
 * point — bottom-centre → top-centre for a mostly-vertical hop, right-centre
 * → left-centre otherwise (the layout is left-to-right).
 */
export function nearestEdge(
  nodeBoxes: Record<string, { x: number; y: number; width: number; height: number }>,
  edges: NearestEdgeQuery[],
  point: { x: number; y: number },
  maxDistance: number,
): { edgeId: string; distance: number } | null {
  let best: { edgeId: string; distance: number } | null = null;
  for (const edge of edges) {
    const s = nodeBoxes[edge.from];
    const t = nodeBoxes[edge.to];
    if (!s || !t) continue;
    const scx = s.x + s.width / 2;
    const scy = s.y + s.height / 2;
    const tcx = t.x + t.width / 2;
    const tcy = t.y + t.height / 2;
    let a: { x: number; y: number };
    let b: { x: number; y: number };
    if (Math.abs(tcy - scy) >= Math.abs(tcx - scx)) {
      a = { x: scx, y: s.y + s.height };
      b = { x: tcx, y: t.y };
    } else {
      a = { x: s.x + s.width, y: scy };
      b = { x: t.x, y: tcy };
    }
    const distance = pointSegmentDistance(point, a, b);
    if (distance <= maxDistance && (!best || distance < best.distance)) {
      best = { edgeId: edge.id, distance };
    }
  }
  return best;
}
