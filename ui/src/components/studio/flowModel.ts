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
  measureText,
  type DefinitionGraphLayout,
  type GraphGroupView,
  type GraphNodeView,
} from "../../lib/pipeline/layout";
import { readGoal, type GoalSpec } from "./wrap/wrapModel";

/** A canvas sticky note (README “Note N”): text pinned to a flow point. It
 * lives in `ui_layout.notes`, beside the node positions, and is a plain JSON
 * field: it is never a definition node, never reaches `document_yaml`'s spec,
 * and cannot be connected (it has no handles). */
export interface CanvasNote {
  id: string;
  x: number;
  y: number;
  /** Box width; the height follows the text. */
  width: number;
  text: string;
}

/** The canvas grid every note snaps to — the same 20px the steps snap to. */
export const NOTE_GRID_PX = 20;
export const NOTE_DEFAULT_WIDTH = 200;
export const NOTE_MIN_WIDTH = 140;
export const NOTE_MAX_WIDTH = 360;
/** The note box's floor: one 13/18 line plus the 8px padding, top and bottom. */
export const NOTE_MIN_HEIGHT = 56;

export function snapToNoteGrid(value: number): number {
  const snapped = Math.round(value / NOTE_GRID_PX) * NOTE_GRID_PX;
  // A note at the origin snaps to `-0` in JS; the block gets written as JSON,
  // where a signed zero is noise (and would be a needless diff on save).
  return snapped === 0 ? 0 : snapped;
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** `ui_layout.notes` off the wire: malformed entries are dropped, a missing
 * width takes the design's 200px default, and coordinates stay as authored. */
export function normalizeNotes(value: unknown): CanvasNote[] {
  if (!Array.isArray(value)) return [];
  const notes: CanvasNote[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const raw = entry as Record<string, unknown>;
    if (typeof raw.id !== "string" || raw.id.length === 0 || seen.has(raw.id)) continue;
    if (typeof raw.text !== "string") continue;
    seen.add(raw.id);
    const width = finiteNumber(raw.width, NOTE_DEFAULT_WIDTH);
    notes.push({
      id: raw.id,
      x: snapToNoteGrid(finiteNumber(raw.x, 0)),
      y: snapToNoteGrid(finiteNumber(raw.y, 0)),
      width: Math.min(NOTE_MAX_WIDTH, Math.max(NOTE_MIN_WIDTH, Math.round(width))),
      text: raw.text,
    });
  }
  return notes;
}

/** `note-1`, `note-2`, … — the first id the canvas does not already hold. */
export function nextNoteId(notes: CanvasNote[]): string {
  const taken = new Set(notes.map((note) => note.id));
  for (let n = 1; ; n += 1) {
    const id = `note-${n}`;
    if (!taken.has(id)) return id;
  }
}

export interface LayoutOverrides {
  nodes?: Record<string, { x: number; y: number }>;
  notes?: CanvasNote[];
}

/** Static payload of a step or scope node — the canvas adds handlers on top. */
export interface FlowNodeData {
  /** The definition node id (the name an expression may refer to). */
  nodeId: string;
  kind: string;
  /** Approachable name from the step library. */
  label: string;
  kindWord: string;
  /** Words for a kind the runtime refuses (`kind_not_implemented`): the plain
   * "not available yet", never the internal build milestone the data map
   * carries — a person reading a canvas cannot decode `M5`. */
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
  /** Structured goal for `until` scopes that `readGoal` understands. */
  goal: GoalSpec | null;
  /** Synthetic trigger node subline (never serialized). */
  triggerSubline?: string;
  /** Set on a canvas note: the note itself, as `ui_layout` holds it. */
  note?: CanvasNote;
}

export interface FlowNodeBase {
  /** Scope-qualified id — unique even when two scopes share a node id. */
  id: string;
  type: "step" | "scope" | "trigger" | "note";
  position: { x: number; y: number };
  width: number;
  height: number;
  /** Flow id of the enclosing scope group, or null at the root. */
  parentId: string | null;
  data: FlowNodeData;
  /** The node's z within the node layer: notes sit under steps and above the
   * goal frames' fill; steps and the trigger sit on top. Absent = the library
   * default, which every step carried until the notes arrived. */
  zIndex?: number;
}

/** The flow id of a canvas note — namespaced so it can never collide with a
 * definition node id. */
export function noteFlowId(noteId: string): string {
  return `${NOTE_FLOW_PREFIX}${noteId}`;
}
const NOTE_FLOW_PREFIX = "__note__:";

export interface FlowEdgeBase {
  id: string;
  source: string;
  target: string;
  /** Handle ids the edge is pinned to (every step/scope renders both). */
  sourceHandle: string;
  targetHandle: string;
  type: "insertable" | "error" | "trigger";
  /** "on error" for error routes, the short route value for guarded edges. */
  label: string | null;
  /** The full `when` expression behind a guarded label (tooltip). */
  labelTitle: string | null;
  /**
   * The collision-checked label anchor in absolute flow coordinates, or null
   * when the edge has no label (or nothing cleared). The edges draw their pill
   * centred there instead of at the raw path midpoint, which in a dense
   * top-to-bottom cut can sit on a neighbour group's box (label∩node in
   * `.canvas-check.mjs`) — and on the "+" that owns the midpoint (see
   * `EDGE_ADD_LABEL_OFFSET_PX`).
   */
  labelX: number | null;
  labelY: number | null;
  /** The absolute flow boxes of both endpoints (layout overrides applied);
   * `null` when the endpoint has no dagre box to measure. */
  sourceBox: EdgeBox | null;
  targetBox: EdgeBox | null;
  /** The routing axis (see `edgeAxis`) the renderer and anchor both use. */
  axis: EdgeAxis;
  data: { edge: GraphEdge };
}

export interface FlowModel {
  nodes: FlowNodeBase[];
  edges: FlowEdgeBase[];
}

/** An absolute flow-coordinate box (a node or a scope group). */
export interface EdgeBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The routing axis an edge is drawn on:
 * `"v"` exits the source bottom-centre and enters the target top-centre;
 * `"h"` exits/enters the facing side centres (the short connector between
 * two adjacent boxes). */
export type EdgeAxis = "h" | "v";

/**
 * The edge path for a given routing axis, from the endpoint boxes — the
 * same geometry both the edge renderer and the label anchor use, so the
 * label always sits on the path it labels. `v` is orthogonal: down from the
 * source's bottom edge to the target's top edge, across to the target's
 * centre (edges entering a scope box attach at the scope's TOP, leaving at
 * the BOTTOM); `h` is the single-bend connector between the facing sides —
 * a short hop between siblings laid out side by side in a scope body, not
 * a loop that crosses the group border.
 */
export function routeEdge(
  source: EdgeBox,
  target: EdgeBox,
  axis: EdgeAxis,
): { path: string; x: number; y: number } {
  const sx = axis === "v" ? source.x + source.width / 2 : source.x + source.width;
  const sy = axis === "v" ? source.y + source.height : source.y + source.height / 2;
  const tx = axis === "v" ? target.x + target.width / 2 : target.x;
  const ty = axis === "v" ? target.y : target.y + target.height / 2;
  const path =
    axis === "v"
      ? `M ${sx} ${sy} C ${sx} ${(sy + ty) / 2}, ${tx} ${(sy + ty) / 2}, ${tx} ${ty}`
      : `M ${sx} ${sy} C ${(sx + tx) / 2} ${sy}, ${(sx + tx) / 2} ${ty}, ${tx} ${ty}`;
  return { path, x: (sx + tx) / 2, y: (sy + ty) / 2 };
}

/**
 * Which axis an edge routes on. An edge that touches a scope GROUP box
 * (enters or leaves the scope) always attaches at the scope's top/bottom —
 * the group border is where the connection belongs. A step-to-step edge takes
 * the axis its endpoints actually sit on: siblings side by side in a scope
 * body (the layout lays scope bodies out OPPOSITE to the graph) are
 * horizontal neighbours, and a horizontal smooth-step between adjacent
 * boxes is a short single-bend connector, not the downward loop a
 * bottom→top cut would draw around the group.
 */
export function edgeAxis(
  source: EdgeBox,
  target: EdgeBox,
  touchesScope: boolean,
  direction: "LR" | "TB",
): EdgeAxis {
  if (touchesScope) return direction === "TB" ? "v" : "h";
  const dx = Math.abs(target.x + target.width / 2 - (source.x + source.width / 2));
  const dy = Math.abs(target.y + target.height / 2 - (source.y + source.height / 2));
  return dx > dy ? "h" : "v";
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

/**
 * The rendered step box (design 1g): 200×52, radius 6, every step centred on
 * one vertical axis in a straight chain. dagre is fed the TRUE rendered
 * width (the dense cut's `nodeMin` floors at this 200px — see
 * `LAYOUT_SPACING.dense`), sizing only larger for ids that need it (up to
 * `NODE_MAX_WIDTH`) or a `when` row; the canvas renders a fixed 200×52 box,
 * so the flow normalises every step box to 200×52 RE-CENTRED on the dagre
 * box — the chain's axis stays where the layout put it, and the edge router
 * (which reads these boxes) attaches to the node the user actually sees.
 * Fed-96 boxes were what let two same-rank siblings' rendered cards
 * intersect; `graphOverlap.test.tsx` pins that away.
 */
export const STEP_BOX = { width: 168, height: 56 } as const;

function recenter(box: { x: number; y: number; width: number; height: number }) {
  return {
    x: box.x + (box.width - STEP_BOX.width) / 2,
    y: box.y + (box.height - STEP_BOX.height) / 2,
    width: STEP_BOX.width,
    height: STEP_BOX.height,
  };
}

/**
 * The read-only Overview card (design 1e) shares the Studio's rule — the box
 * re-centred on the dagre box's own centre, so every step of a chain keeps
 * the axis dagre gave the rank no matter how wide its id made the dagre box
 * (drift-free) — but never shrinks a box dagre sized larger than the card
 * floor, because the Overview card grows to fit a long id rather than
 * ellipsize. Exported so the Overview reuses ONE re-centring rule.
 */
export function stepCardBox(box: { x: number; y: number; width: number; height: number }): EdgeBox {
  const width = Math.max(STEP_BOX.width, box.width);
  const height = Math.max(STEP_BOX.height, box.height);
  return {
    x: box.x + (box.width - width) / 2,
    y: box.y + (box.height - height) / 2,
    width,
    height,
  };
}

/** The pill the edge label draws: 10px mono text, `px-1.5` each side, one row.
 * Over-estimated on purpose — the anchor clears more room than the pill needs,
 * and an under-clearance is exactly the overlap the check exists to forbid. */
const EDGE_LABEL_PX = { height: 24, padX: 12 };

/** The REAL box of the insert "+" the canvas draws centred on an insertable
 * edge's routed midpoint (`edges.tsx`'s 44px target wearing a 22px circle). */
export const EDGE_ADD_TARGET_PX = 44;
/** How far out from the line's midpoint a label STARTS when it sits beside the
 * "+": the target's edge plus slack, so a pill centred half its own width past
 * this line cannot reach the target even if the width estimate runs thin. The
 * design measures its 9px gap from the 22px CIRCLE (ink ends at +11); the hit
 * box reaches +22, so the gap has to be taken off the box, not the ink. */
export const EDGE_ADD_LABEL_OFFSET_PX = EDGE_ADD_TARGET_PX / 2 + 4;

export function labelBoxSize(label: string): { width: number; height: number } {
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
 * (the same pattern as the anchor registry) that the edge bodies read via
 * `edgeLabelAnchor`.
 */
export function clearLabelAnchor(
  label: string,
  source: AnchorBox,
  target: AnchorBox,
  boxes: AnchorBox[],
  direction: "LR" | "TB" = "TB",
  axis: EdgeAxis | "auto" = "auto",
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
  // The pill is drawn at the ROUTED PATH's label point (edges.tsx draws the
  // same `routeEdge` path), not at the box centres — for a short edge into a
  // scope box those differ by the whole pill, which is exactly where the
  // overlap crept in. Reproduce that point here, from the same endpoint
  // geometry the renderer routes with.
  const a: EdgeAxis = axis === "auto" ? (direction === "TB" ? "v" : "h") : axis;
  const s =
    a === "v"
      ? { x: source.x + source.width / 2, y: source.y + source.height }
      : {
          x:
            target.x + target.width / 2 >= source.x + source.width / 2
              ? source.x + source.width
              : source.x,
          y: source.y + source.height / 2,
        };
  const t =
    a === "v"
      ? { x: target.x + target.width / 2, y: target.y }
      : {
          x:
            target.x + target.width / 2 >= source.x + source.width / 2
              ? target.x
              : target.x + target.width,
          y: target.y + target.height / 2,
        };
  const routed = routeEdge(source, target, a);
  const pathLabel = { x: routed.x, y: routed.y };
  if (clears(pathLabel)) return null;
  // Slide along the endpoint line, closest-to-path-point first: the pill
  // follows the edge it labels instead of jumping to a perpendicular spot.
  for (const k of [0.25, -0.25, 0.125, -0.125, 0.375, -0.375, 0.5, -0.5, 0.75, -0.75]) {
    const candidate = {
      x: (s.x + t.x) / 2 + (t.x - s.x) * k,
      y: (s.y + t.y) / 2 + (t.y - s.y) * k,
    };
    if (clears(candidate)) return candidate;
  }
  // The edge is too short to slide along, or the whole endpoint corridor is
  // blocked (boxes stacked against a neighbour scope): spiral out from the
  // path point in both axes until the pill clears every box.
  for (const m of [16, 24, 32, 48, 64, 80, 96, 128, 160, 200, 256, 320]) {
    const candidates = [
      { x: pathLabel.x + m, y: pathLabel.y },
      { x: pathLabel.x - m, y: pathLabel.y },
      { x: pathLabel.x, y: pathLabel.y + m },
      { x: pathLabel.x, y: pathLabel.y - m },
    ];
    for (const candidate of candidates) {
      if (clears(candidate)) return candidate;
    }
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
 * The authoring canvas layout. The Studio is ALWAYS top-to-bottom (design
 * 1g): the dense TB cut is the only authoring layout, a scope body runs TB
 * inside its group too (`subgraphRankdir: "same"`), and the handles / the edge
 * router ride that constant. `toFlow` no longer picks a direction per graph.
 */
export function canvasLayout(
  document: unknown,
): { laid: DefinitionGraphLayout; direction: "TB" } | null;
export function canvasLayout(
  document: unknown,
  direction: "LR" | "TB",
): { laid: DefinitionGraphLayout; direction: "LR" | "TB" } | null;
export function canvasLayout(
  document: unknown,
  direction: "LR" | "TB" = "TB",
): { laid: DefinitionGraphLayout; direction: "LR" | "TB" } | null {
  if (document == null) return null;
  const tb = layoutDefinition(document as DefinitionDocument, {
    spacing: "dense",
    rankdir: direction,
    subgraphRankdir: direction === "LR" ? "opposite" : "same",
  });
  if (!tb) return null;
  return { laid: tb, direction };
}

function rawNodeAtPointer(document: unknown, pointer: string): Record<string, unknown> | null {
  let cur: unknown = document;
  for (const part of pointer.split("/")) {
    if (part === "") continue;
    cur = Array.isArray(cur) ? cur[Number(part)] : (cur as Record<string, unknown> | null)?.[part];
    if (cur === null || cur === undefined) return null;
  }
  return cur !== null && typeof cur === "object" && !Array.isArray(cur)
    ? (cur as Record<string, unknown>)
    : null;
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
  opts: {
    addButtons?: boolean;
    direction?: "LR" | "TB";
    trigger?: { subline: string } | null;
  } = {},
): FlowModel {
  // A missing document (draft not read yet, broken YAML with no last-good)
  // yields an empty flow — the canvas then shows its empty-canvas affordance.
  const canvas = canvasLayout(document, opts.direction ?? "TB");
  if (!canvas) return { nodes: [], edges: [] };
  const { laid, direction } = canvas;

  const nodeByPointer = new Map(laid.nodes.map((n) => [n.pointer, n]));
  const groupByPointer = new Map(laid.groups.map((g) => [g.pointer, g]));
  const overridden = (id: string) => layout.nodes?.[id] ?? null;

  /** Absolute box of every node or group, before overrides. */
  const abs = new Map<
    string,
    { node: GraphNode; x: number; y: number; width: number; height: number; goal: GoalSpec | null }
  >();

  for (const node of model.nodes) {
    const group: GraphGroupView | undefined = node.isScope
      ? groupByPointer.get(node.pointer)
      : undefined;
    const box: GraphNodeView | undefined = node.isScope
      ? undefined
      : nodeByPointer.get(node.pointer);
    const goal =
      node.isScope && node.kind === "until"
        ? readGoal(rawNodeAtPointer(document, node.pointer))
        : null;
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
        : recenter(box);
    }
    if (!size) continue;
    abs.set(flowId(node.scope, node.id), {
      node,
      x: size.x,
      y: size.y,
      width: size.width,
      height: size.height,
      goal,
    });
  }

  // A scope GROUP box is grown until it contains every direct child box.
  // GoalFrame scopes reserve extra top/bottom padding so the goal header and
  // round footer never overlap child step cards.
  const GROUP_PAD = 8;
  // The header is 10px padding, the 18px kind line, a 4px gap, one 18px row
  // per wrapped line of the quoted goal and 10px padding; the first step then
  // starts 28px under it. The quote wraps in the frame width less 44px (14px
  // left, 30px right for the edit affordance), at ~6.6px a character for the
  // 13px UI face and ~7.8px for mono (command / contains goals).
  const goalTopPad = (goal: GoalSpec, width: number): number => {
    const charPx = goal.kind === "judge" ? 6.6 : 7.8;
    const perLine = Math.max(1, Math.floor((width - 44) / charPx));
    const lines = Math.max(1, Math.ceil((goal.text.length + 2) / perLine));
    return 10 + 18 + 4 + 18 * lines + 10 + 28;
  };
  // Terminal steps inside a GoalFrame render a 10px dashed stub + 44px hit
  // button below the card (~53px) above the 32px footer ("up to N rounds · …").
  // 88px preserves clear separation between the terminal + target and footer.
  const GOAL_BOTTOM_PAD = 88;
  const GOAL_SIDE_PAD = 22;
  // Deepest scopes first, so a nested group is expanded before its parent.
  const scopes = [...abs.values()]
    .filter((e) => e.node.isScope)
    .sort((a, b) => b.node.scope.length - a.node.scope.length);
  for (const group of scopes) {
    const parentKey = flowId(group.node.scope, group.node.id);
    const isGoal = group.goal !== null;
    const sidePad = isGoal ? GOAL_SIDE_PAD : GROUP_PAD;
    const bottomPad = isGoal ? GOAL_BOTTOM_PAD : GROUP_PAD;
    let minChildY = Infinity;
    for (const entry of abs.values()) {
      if (entry === group) continue;
      const parent = parentFlowId(entry.node.scope);
      if (parent !== parentKey) continue;
      const ov = !entry.node.isScope ? overridden(entry.node.id) : null;
      const ex = ov ? ov.x : entry.x;
      const ey = ov ? ov.y : entry.y;
      minChildY = Math.min(minChildY, ey);
      const overLeft = group.x - (ex - sidePad);
      if (overLeft > 0) {
        group.x -= overLeft;
        group.width += overLeft;
      }
      group.width = Math.max(group.width, ex + entry.width + sidePad - group.x);
      group.height = Math.max(group.height, ey + entry.height - group.y + bottomPad);
    }
    if (group.goal !== null && Number.isFinite(minChildY)) {
      group.width = Math.max(group.width, 224);
      const targetTop = minChildY - goalTopPad(group.goal, group.width);
      if (targetTop < group.y) {
        group.height += group.y - targetTop;
        group.y = targetTop;
      }
    }
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
        deferred: node.kind in DEFERRED_KINDS ? "not available yet" : null,
        when: node.when,
        scope: node.scope,
        terminal: !isScope && hasNoDependents(model, node),
        emptyBody: isScope && groupByPointer.get(node.pointer) === undefined,
        headerText: headerTextFor(node, groupByPointer.get(node.pointer)),
        loopNote: groupByPointer.get(node.pointer)?.loopNote ?? null,
        goal: entry.goal,
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
  // The endpoint geometry of one edge, from the boxes as the renderer will
  // draw them (a moved node rides its override).
  const geometryOf = (edge: GraphEdge) => {
    const boxOf = (fid: string, nodeId: string): EdgeBox | null => {
      const e = abs.get(fid);
      if (!e) return null;
      const o = overridden(nodeId);
      return o ? { x: o.x, y: o.y, width: e.width, height: e.height } : e;
    };
    const sourceBox = boxOf(flowId(edge.scope, edge.from), edge.from);
    const targetBox = boxOf(flowId(edge.scope, edge.to), edge.to);
    const touchesScope =
      (abs.get(flowId(edge.scope, edge.from))?.node.isScope ?? false) ||
      (abs.get(flowId(edge.scope, edge.to))?.node.isScope ?? false);
    const axis: EdgeAxis =
      sourceBox && targetBox ? edgeAxis(sourceBox, targetBox, touchesScope, direction) : "v";
    return { sourceBox, targetBox, axis };
  };
  // Every "+" square the canvas is about to draw, at its edge's ROUTED
  // midpoint — the same point `edges.tsx` centres its 44px target on. A route
  // label is a painted box like any other, and a "+" owns the midpoint it sits
  // on, so the label placement below clears these: its own (the label never
  // prints over its own "+") and its siblings' (in a fan-out the sibling
  // midpoints sit closer together than a wide label is long — observed on a
  // `ok` / `needs attention` twin, where the 104px pill reached 42px into the
  // neighbour's target). A read-only canvas draws no "+", so nothing to clear.
  const addBoxes = new Map<string, AnchorBox>();
  if (opts.addButtons !== false) {
    for (const edge of model.edges) {
      if (edge.kind === "error") continue;
      const g = geometryOf(edge);
      if (!g.sourceBox || !g.targetBox) continue;
      const mid = routeEdge(g.sourceBox, g.targetBox, g.axis);
      addBoxes.set(edge.id, {
        x: mid.x - EDGE_ADD_TARGET_PX / 2,
        y: mid.y - EDGE_ADD_TARGET_PX / 2,
        width: EDGE_ADD_TARGET_PX,
        height: EDGE_ADD_TARGET_PX,
      });
    }
  }
  const edges: FlowEdgeBase[] = model.edges.map((edge) => {
    // Pinned to the handles every step/scope node renders (hidden in
    // read-only, present in the DOM for the geometry): without explicit
    // handle ids React Flow drops the edge ("Couldn't create edge for
    // source handle id: null") as soon as a node has more than one handle
    // or the default resolution changes.
    const guardedWhen = edge.kind === "guarded" ? (edgeWhen(model, edge) ?? null) : null;
    const label = edge.kind === "error" ? "on error" : guardedWhen ? routeLabel(guardedWhen) : null;
    // The boxes are computed here, where the whole graph's absolute boxes are
    // in one map; the edge renderer only draws. A node a draft override has
    // moved is re-boxed at the override's position (the override replaces
    // the dagre position in `nodes` above, so routing follows the move).
    const { sourceBox, targetBox, axis } = geometryOf(edge);
    let labelX: number | null = null;
    let labelY: number | null = null;
    if (label && sourceBox && targetBox) {
      // Everything the pill must miss: the drawn node boxes and every "+"
      // square except its own (its own is handled by the seat below, which
      // starts a full offset past the target's edge).
      const blockers: AnchorBox[] = [
        ...abs.values(),
        ...[...addBoxes.entries()].filter(([id]) => id !== edge.id).map(([, box]) => box),
      ];
      const size = labelBoxSize(label);
      const clears = (center: { x: number; y: number }) =>
        blockers.every(
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
      // Design 1g: the "+" owns the line's midpoint, so the label sits BESIDE
      // it — the design's own gap, taken off the 44px target rather than the
      // 22px ink. Right first (the reading side), left when a neighbour's "+",
      // a node or the pane edge stands there, and only then the old slide/spiral
      // along the line.
      const mid = routeEdge(sourceBox, targetBox, axis);
      const seat = EDGE_ADD_LABEL_OFFSET_PX + size.width / 2;
      // A read-only canvas draws no "+", so nothing owns the midpoint and the
      // label keeps its seat centred on the line.
      const beside =
        opts.addButtons === false
          ? undefined
          : [
              { x: mid.x + seat, y: mid.y },
              { x: mid.x - seat, y: mid.y },
            ].find(clears);
      const anchor =
        beside ?? clearLabelAnchor(label, sourceBox, targetBox, blockers, direction, axis);
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
      sourceBox,
      targetBox,
      axis,
      data: { edge },
    } as FlowEdgeBase;
  });

  // Optional synthetic trigger node connected to root entry steps (never serialized).
  if (opts.trigger && nodes.length > 0) {
    const entryNodes = model.nodes
      .filter((n) => n.scope.length === 0 && n.dependsOn.length === 0)
      .map((n) => byFlowId.get(flowId(n.scope, n.id)))
      .filter((n): n is FlowNodeBase => Boolean(n));
    if (entryNodes.length > 0) {
      const minX = Math.min(...entryNodes.map((n) => n.position.x));
      const minY = Math.min(...entryNodes.map((n) => n.position.y));
      const avgY =
        entryNodes.reduce((sum, n) => sum + n.position.y + n.height / 2, 0) / entryNodes.length -
        STEP_BOX.height / 2;
      const avgX =
        entryNodes.reduce((sum, n) => sum + n.position.x + n.width / 2, 0) / entryNodes.length -
        STEP_BOX.width / 2;
      // Review-1 rx-rv-editor-editor-1280: the trigger card sits BESIDE the
      // entry step (LR) or above it (TB), and its CENTRE must land on the
      // entry's centre line. Snapping the centre coordinate to the 20px grid
      // is what pushed it ~8px off: the grid orders the box's CORNER, and a
      // 56px card's centre is never on a grid line (0 + 28 ≠ 20k). Only the
      // offset axis — the one that places the card in the free lane — snaps.
      const trigPos =
        direction === "LR"
          ? {
              x: Math.round((minX - STEP_BOX.width - 72) / NOTE_GRID_PX) * NOTE_GRID_PX,
              y: avgY,
            }
          : {
              x: avgX,
              y: Math.round((minY - STEP_BOX.height - 64) / NOTE_GRID_PX) * NOTE_GRID_PX,
            };
      const trigBox: EdgeBox = {
        x: trigPos.x,
        y: trigPos.y,
        width: STEP_BOX.width,
        height: STEP_BOX.height,
      };
      const trigNode: FlowNodeBase = {
        id: "__trigger__",
        type: "trigger",
        position: trigPos,
        width: STEP_BOX.width,
        height: STEP_BOX.height,
        parentId: null,
        data: {
          nodeId: "__trigger__",
          kind: "trigger",
          label: "Trigger",
          kindWord: "trigger",
          deferred: null,
          when: null,
          scope: [],
          terminal: false,
          emptyBody: false,
          headerText: null,
          loopNote: null,
          goal: null,
          triggerSubline: opts.trigger.subline,
        },
      };
      nodes.unshift(trigNode);
      for (const target of entryNodes) {
        const targetBox: EdgeBox = {
          x: target.position.x,
          y: target.position.y,
          width: target.width,
          height: target.height,
        };
        edges.push({
          id: `__trigger__->${target.id}`,
          source: "__trigger__",
          target: target.id,
          sourceHandle: "out",
          targetHandle: "in",
          type: "trigger",
          label: null,
          labelTitle: null,
          labelX: null,
          labelY: null,
          sourceBox: trigBox,
          targetBox,
          axis: direction === "LR" ? "h" : "v",
          data: {
            edge: {
              id: `__trigger__->${target.id}`,
              from: "__trigger__",
              to: target.data.nodeId,
              scope: [],
              kind: "depends",
              reasons: [],
            },
          },
        });
      }
    }
  }

  // Canvas notes last, so a structural sort never moves them ahead of a step:
  // they are pure decoration of the authoring surface, not graph members.
  for (const note of normalizeNotes(layout.notes)) {
    nodes.push({
      id: noteFlowId(note.id),
      type: "note",
      position: { x: note.x, y: note.y },
      width: note.width,
      height: NOTE_MIN_HEIGHT,
      parentId: null,
      data: {
        nodeId: note.id,
        kind: NOTE_KIND,
        label: "Note",
        kindWord: "note",
        deferred: null,
        when: null,
        scope: [],
        terminal: false,
        emptyBody: false,
        headerText: null,
        loopNote: null,
        goal: null,
        note,
      },
      zIndex: NOTE_Z,
    });
  }

  return { nodes, edges };
}

/** The note's marker `kind` — never a definition kind, so anything that maps
 * canvas nodes back to steps (inspector, run projection) can filter it out. */
export const NOTE_KIND = "canvas.note";
/** Notes paint UNDER the step cards and ABOVE the goal frames' fill (0). */
export const NOTE_Z = 1;

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
 * → left-centre otherwise (the authoring canvas is always top-to-bottom).
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

/** Clear saved placements so the next render uses the automatic layout. */
export function tidyLayout(layout: LayoutOverrides): LayoutOverrides {
  return { ...layout, nodes: {} };
}
