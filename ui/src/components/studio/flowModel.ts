/**
 * flowModel.ts — pure translation from the graph model + dagre layout to
 * React Flow graph shapes, plus the drag-to-insert hit test.
 *
 * `toFlow` never mutates anything: positions come from `layoutDefinition`
 * (the one dagre source of truth), and the draft's `ui_layout` overrides
 * replace them by node id. Children of a scope group carry positions
 * RELATIVE to the group, as React Flow expects for `parentId` children.
 */
import { getSmoothStepPath } from "@xyflow/react";
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
  measureText,
  type DefinitionGraphLayout,
  type GraphGroupView,
  type GraphNodeView,
} from "../../lib/pipeline/layout";

export interface LayoutOverrides {
  nodes?: Record<string, { x: number; y: number }>;
}

/**
 * The direction the most recent `toFlow` run laid the graph out in.
 * The canvas builds its render-data object field by field (so the node
 * bodies can stay dumb); until that wiring carries `direction` through, the
 * handle positions read the layout's own last choice from here. `toFlow` is
 * the only writer and it runs synchronously in the canvas's memo before the
 * render that consumes it, so the value is always the one for the current
 * graph. Prefer `data.direction` whenever the canvas passes it.
 */
let lastCanvasDirection: "LR" | "TB" = "LR";

export function canvasDirection(): "LR" | "TB" {
  return lastCanvasDirection;
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
  /**
   * The dagre direction the layout ran in — the handles ride it: `LR` puts
   * the source on the right and the target on the left, `TB` on bottom and
   * top. Edges resolve against these handle positions, so a graph laid out
   * in one direction rendered with the other's handles would connect
   * corners.
   */
  direction: "LR" | "TB";
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
  /** Handle ids the edge is pinned to (every step/scope renders both). */
  sourceHandle: string;
  targetHandle: string;
  type: "insertable" | "error";
  /** "on error" for error routes, the short route value for guarded edges. */
  label: string | null;
  /** The full `when` expression behind a guarded label (tooltip). */
  labelTitle: string | null;
  /**
   * The collision-checked label anchor in absolute flow coordinates, or null
   * when the edge has no label. The edges draw their pill there instead of
   * the raw path midpoint, which in a dense top-to-bottom cut can sit on a
   * neighbour group's box (label∩node in `.canvas-check.mjs`).
   */
  labelX: number | null;
  labelY: number | null;
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

/**
 * The few words the edge label carries instead of the whole CEL expression
 * ("nodes.verdict.outputs.route == 'verified'" → "verified"). A string-literal
 * comparison wins ("…state == 'ready'" → "ready"), then `inputs.NAME == …` →
 * NAME, then any other bare literal; only a genuinely unreadable guard falls
 * back to the full (truncated) text. The full expression stays available as
 * the label's title tooltip.
 */
export function routeLabel(when: string): string {
  const literal = (re: RegExp) => {
    const m = re.exec(when);
    return m ? m[1] : null;
  };
  return (
    literal(/\broute\s*==\s*'([^']*)'/) ??
    literal(/\broute\s*==\s*"([^"]*)"/) ??
    literal(/(?<![!=])==\s*'([^']*)'/) ??
    literal(/(?<![!=])==\s*"([^"]*)"/) ??
    literal(/\binputs\.([A-Za-z_][A-Za-z0-9_]*)\s*==/) ??
    literal(/(?<![!=])==\s*(true|false|\b[A-Za-z_][A-Za-z0-9_.]*)/) ??
    fallbackWhen(when)
  );
}

/** Last resort for a guard no rule understands: the flattened expression. */
function fallbackWhen(when: string): string {
  const flat = when.replaceAll(/\s+/g, " ").trim();
  return flat.length > 44 ? `${flat.slice(0, 43)}…` : flat;
}

const scopeScopeKey = (n: GraphNode): string => JSON.stringify(n.scope);

/** The pill the edge label draws: 10px mono text, `px-1.5` each side, one row.
 * Over-estimated on purpose — the anchor clears more room than the pill needs,
 * and an under-clearance is exactly the overlap the check exists to forbid. */
const EDGE_LABEL_PX = { height: 18, padX: 12 };

function labelBoxSize(label: string): { width: number; height: number } {
  return {
    width: Math.ceil(measureText(label, 10, "mono")) + EDGE_LABEL_PX.padX * 2,
    height: EDGE_LABEL_PX.height,
  };
}

interface AnchorBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

function boxHits(a: AnchorBox, b: AnchorBox): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/**
 * The collision-checked label anchor, in ABSOLUTE flow coordinates. The edges
 * draw the label pill there instead of the raw path midpoint, which in the
 * dense top-to-bottom cut can sit on a neighbour scope's box (label∩node in
 * `.canvas-check.mjs`). `null` (the common case) keeps the raw midpoint.
 * The canvas builds its edge render-data field by field and does not forward
 * this, so `toFlow` also publishes it in a module registry keyed by edge id
 * (the same pattern as `lastCanvasDirection`) that the edge bodies read via
 * `edgeLabelAnchor`.
 */
export function clearLabelAnchor(
  label: string,
  source: AnchorBox,
  target: AnchorBox,
  boxes: AnchorBox[],
  direction: "LR" | "TB" = "TB",
): { x: number; y: number } | null {
  const size = labelBoxSize(label);
  // Every box counts, the edge's own endpoints included: the pill is opaque
  // (`bg-surface`) and the canvas check forbids it covering ANY node, not
  // just neighbours. (A pill that still grazes its own corner after every
  // candidate fails is the fallback below, not the normal case.)
  const clears = (center: { x: number; y: number }) =>
    boxes.every(
      (box) =>
        !boxHits(
          {
            x: center.x - size.width / 2,
            y: center.y - size.height / 2,
            width: size.width,
            height: size.height,
          },
          box,
        ),
    );
  // The pill is drawn at the SMOOTH-STEP PATH's label point (edges.tsx asks
  // `getSmoothStepPath` for it), not at the box centres — for a short edge
  // into a scope box those differ by the whole pill, which is exactly where
  // the overlap crept in. Reproduce that point here, from the same handles
  // (source `out`, target `in`) the edges pin to.
  const s =
    direction === "TB"
      ? { x: source.x + source.width / 2, y: source.y + source.height }
      : { x: source.x + source.width, y: source.y + source.height / 2 };
  const t =
    direction === "TB"
      ? { x: target.x + target.width / 2, y: target.y }
      : { x: target.x, y: target.y + target.height / 2 };
  const [, lx, ly] = getSmoothStepPath({
    sourceX: s.x,
    sourceY: s.y,
    sourcePosition: (direction === "TB" ? "bottom" : "right") as never,
    targetX: t.x,
    targetY: t.y,
    targetPosition: (direction === "TB" ? "top" : "left") as never,
    borderRadius: 6,
  });
  const pathLabel = { x: lx, y: ly };
  if (clears(pathLabel)) return null;
  // Slide along the handle line, closest-to-path-point first: the pill
  // follows the edge it labels instead of jumping to a perpendicular spot.
  for (const k of [0.25, -0.25, 0.125, -0.125, 0.375, -0.375]) {
    const candidate = {
      x: (s.x + t.x) / 2 + (t.x - s.x) * k,
      y: (s.y + t.y) / 2 + (t.y - s.y) * k,
    };
    if (clears(candidate)) return candidate;
  }
  // The edge is too short to slide along (boxes nearly touching, e.g. the
  // `fan_out` scope hugging `emit_items`): step the pill sideways,
  // perpendicular to the edge axis, until it clears every box.
  for (const off of [20, -20, 40, -40, 60, -60, 80, -80, 100, -100, 120, -120]) {
    const candidate =
      direction === "TB"
        ? { x: pathLabel.x + off, y: pathLabel.y }
        : { x: pathLabel.x, y: pathLabel.y + off };
    if (clears(candidate)) return candidate;
  }
  return null;
}

/**
 * Edge id → shifted label anchor. Rebuilt by every `toFlow` call; the edge
 * bodies read it by id because the canvas's per-field edge data does not
 * carry the anchor (StudioCanvas is built field by field).
 */
const labelAnchors = new Map<string, { x: number; y: number }>();

/** The shifted anchor for an edge id, or `null` when the raw path midpoint is safe. */
export function edgeLabelAnchor(id: string): { x: number; y: number } | null {
  return labelAnchors.get(id) ?? null;
}

/**
 * The panes a canvas graph is fitted into. The Workbench run view with the
 * dock open (≈1020×610) and the Studio (≈920×776). Orientation is chosen
 * against both, not one: a graph that fits the wider pane can still land
 * under zoom 1.0 in the other, and the canvas has both lives.
 */
export const CANVAS_PANES: readonly { width: number; height: number }[] = [
  { width: 1020, height: 610 },
  { width: 920, height: 776 },
];

/**
 * Which dagre direction the canvas should use for a graph it has laid out
 * both ways: the one whose *worst* fit-to-pane zoom across the known canvas
 * panes is the higher (fit zoom = min(paneW/W, paneH/H) — the graph is drawn
 * at exactly that scale before the canvas's maxZoom clamp). Ties stay `LR`:
 * the historic direction, whose handles and edge routing the canvas was
 * built around. A graph that is much wider than it is tall relative to the
 * pane aspect loses here — that is exactly when `TB` wins.
 */
export function chooseCanvasOrientation(
  laid: { LR: DefinitionGraphLayout; TB: DefinitionGraphLayout },
  panes: readonly { width: number; height: number }[] = CANVAS_PANES,
): "LR" | "TB" {
  const worst = (direction: "LR" | "TB") =>
    Math.min(
      ...panes.map((p) =>
        Math.min(p.width / laid[direction].width, p.height / laid[direction].height),
      ),
    );
  const tb = worst("TB");
  const lr = worst("LR");
  return tb > lr ? "TB" : "LR";
}

/**
 * The canvas layout: dense spacing, scope clusters laid out opposite to the
 * graph (a scope body is a chain — sideways inside the group, not stacked),
 * and the direction picked per graph (see `chooseCanvasOrientation`): the
 * dense LR cut alone left the twin 12-node graph width-bound at zoom ≈ 0.6
 * in the Workbench — the generous rank gap was the price of edge-label room
 * at 1:1, and the pane is far wider than it is tall. `null` means the
 * document cannot be read as a pipeline (the canvas shows the YAML).
 */
export function canvasLayout(document: unknown): {
  laid: DefinitionGraphLayout;
  direction: "LR" | "TB";
} | null {
  if (document == null) return null;
  const options = { spacing: "dense" as const, subgraphRankdir: "opposite" as const };
  const lr = layoutDefinition(document as DefinitionDocument, { ...options, rankdir: "LR" });
  if (!lr) return null;
  const tb = layoutDefinition(document as DefinitionDocument, { ...options, rankdir: "TB" });
  const direction: "LR" | "TB" = tb ? chooseCanvasOrientation({ LR: lr, TB: tb }) : "LR";
  const laid = direction === "TB" ? (tb as DefinitionGraphLayout) : lr;
  // The node bodies read the handle positions off the layout's direction;
  // the canvas wiring carries `direction` through its render data only once
  // StudioCanvas forwards it (see `canvasDirection`).
  lastCanvasDirection = direction;
  return { laid, direction };
}

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
  // A missing document (draft not read yet, broken YAML with no last-good)
  // yields an empty flow — the canvas then shows its empty-canvas affordance.
  const canvas = canvasLayout(document);
  if (!canvas) return { nodes: [], edges: [] };
  const { laid, direction } = canvas;

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
      // The step box is EXACTLY what dagre placed it as — the canvas pins the
      // node to these dimensions, so layout and render can never diverge
      // (divergent sizes were the node-overlap bug). A scope with no dagre
      // cluster (empty body) degrades to a group sized off its own node box,
      // floored so the "+ Add step inside" affordance fits.
      size = node.isScope
        ? {
            x: box.x,
            y: box.y,
            width: Math.max(box.width, 208),
            height: Math.max(box.height, 96),
          }
        : { x: box.x, y: box.y, width: box.width, height: box.height };
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
        direction,
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

  // React Flow requires a group node to appear in the `nodes` array BEFORE
  // any node whose `parentId` points at it — a child emitted first lands in a
  // `parentLookup` with no parent ("Parent node X not found"), its position
  // is never corrected, and the graph can blank out. Document order already
  // puts a scope before its body, so this stable depth sort (root → deepest
  // scope, siblings untouched) is a guard against a future op emitting the
  // children first after a wrap.
  nodes.sort((a, b) => a.data.scope.length - b.data.scope.length);

  // The anchor registry is rebuilt per draft: a stale anchor from a previous
  // toFlow call would float a label over the wrong place.
  labelAnchors.clear();
  const edges: FlowEdgeBase[] = model.edges.map((edge) => {
    // Pinned to the handles every step/scope node renders (hidden in
    // read-only, present in the DOM for the geometry): without explicit
    // handle ids React Flow drops the edge ("Couldn't create edge for
    // source handle id: null") as soon as a node has more than one handle
    // or the default resolution changes.
    const guardedWhen = edge.kind === "guarded" ? (edgeWhen(model, edge) ?? null) : null;
    const label = edge.kind === "error" ? "on error" : guardedWhen ? routeLabel(guardedWhen) : null;
    // The anchor is computed here, where the whole graph's absolute boxes are
    // in one map; the edge renderer only draws. A node a draft override has
    // moved has no fresh box in `abs` — anchors read the dagre box, which is
    // the honest fallback (the label was anchored to the laid-out graph).
    const sourceBox = abs.get(flowId(edge.scope, edge.from));
    const targetBox = abs.get(flowId(edge.scope, edge.to));
    let labelX: number | null = null;
    let labelY: number | null = null;
    if (label && sourceBox && targetBox) {
      const anchor = clearLabelAnchor(
        label,
        sourceBox,
        targetBox,
        [...abs.values()].map((box) => box),
        direction,
      );
      if (anchor) {
        labelX = anchor.x;
        labelY = anchor.y;
        labelAnchors.set(edge.id, anchor);
      }
    }
    return {
      id: edge.id,
      source: flowId(edge.scope, edge.from),
      target: flowId(edge.scope, edge.to),
      sourceHandle: "out",
      targetHandle: "in",
      type: edge.kind === "error" ? "error" : "insertable",
      label,
      labelTitle: edge.kind === "error" ? null : guardedWhen,
      labelX,
      labelY,
      data: { edge },
    } as FlowEdgeBase;
  });

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
