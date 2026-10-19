/**
 * Definition-graph layout.
 *
 * `@dagrejs/dagre` 3.1.1 (MIT) computes a layered layout over a compound
 * graph; rendering stays ours — HTML nodes in an absolutely-positioned canvas
 * with one SVG layer for edges — because the identity's hairlines are CSS and
 * accessibility lives on real focusable elements. ADR-0025 records the
 * decision and what was rejected.
 *
 * Two behaviours of the pinned library are load-bearing and were observed,
 * not assumed (recorded in the ADR's verification note):
 *   1. An edge whose endpoint *is* a cluster fails the layout
 *      (`Cannot set properties of undefined (setting 'rank')`), so a scope
 *      dependency is wired to the body's entry/exit nodes instead — which is
 *      also what `03` says a scope dependency means.
 *   2. A cluster's box is exactly its children's bounding box, so a group's
 *      padding and title bar are added here, after layout, deepest-first.
 */
import { Graph, layout as dagreLayout } from "@dagrejs/dagre";
import {
  DEFERRED_KINDS,
  isGateKind,
  isScopeKind,
  kindWord,
  nodeBindings,
  scopeBody,
  scopeBoundLabel,
  scopeEntryNodes,
  scopeLoopNote,
  scopeExitNodes,
  type DefinitionDocument,
  type DefinitionNode,
  type NodeBinding,
} from "./definition";

export interface GraphNodeView {
  /** Scope-qualified identity, e.g. `plan` or `build_until_verified/implement`. */
  key: string;
  /** The definition node id — the only name an expression may refer to. */
  id: string;
  /** JSON pointer to this node in the document, e.g. `/spec/nodes/2`. */
  pointer: string;
  kind: string;
  groupKey: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
  bindings: NodeBinding[];
  /** ADR-0024 § 2: a `kind_not_implemented` node, with the milestone named. */
  deferredTo: string | null;
  when: string | null;
  dependsOn: string[];
  errorRoute: string | null;
  boundLabel: string;
  /** The few words the box can carry for this kind (`agent`, `gate`, …). */
  word: string;
  /** A `human.approval` / `gate` box is drawn as a gate. */
  gate: boolean;
}

export interface GraphGroupView {
  key: string;
  /** The composite node that owns this group. */
  ownerId: string;
  /** JSON pointer to the composite node, e.g. `/spec/nodes/4`. */
  pointer: string;
  kind: string;
  boundLabel: string;
  x: number;
  y: number;
  width: number;
  height: number;
  depth: number;
  /** The few words for the scope kind (`until`, `for each`, `parallel`). */
  word: string;
  /** The `↻ / ⊕ / ∥` line under the children — what repeats. */
  loopNote: string;
  /** The bar's whole string, and the width it may use before it wraps. The
   * bar's height was reserved from exactly this text, so the renderer draws
   * what the geometry measured rather than a second copy of the rule. */
  headerText: string;
  headerWidth: number;
  /** The foot's available width (same box, bottom-anchored). */
  noteWidth: number;
}

export interface GraphEdgeView {
  from: string;
  to: string;
  kind: "depends" | "error";
  points: { x: number; y: number }[];
}

export interface DefinitionGraphLayout {
  width: number;
  height: number;
  nodes: GraphNodeView[];
  /** Outermost first — the deepest group paints under its children. */
  groups: GraphGroupView[];
  edges: GraphEdgeView[];
}

/** A node box's floor: narrower than the first cut because the graph is drawn
 * into a pane far wider than it is tall (width is the scarce axis the fit-to-pane
 * scale divides by), and the size every box gets when its id is short. Not a
 * constant any more — see `nodeBoxFor`. */
export const NODE_SIZE = { width: 108, height: 60 };
/** Ceiling for a node box. Past it the id wraps onto a second row (and the box
 * grows) instead of clipping mid-word: the id is the only name an expression
 * may use, so a graph that shows `emit_ite…` shows a name that does not exist. */
export const NODE_MAX_WIDTH = 220;
export const GROUP_BAR = 20;
export const GROUP_PAD = 14;
/** Least clear space two sibling scope boxes may keep between them. dagre only
 * spaces the *children* (`nodesep`), so the title bar and the `↻ …` foot added
 * after layout belong to nobody — without this a lower scope's label sits under
 * the upper scope's foot. */
export const GROUP_GAP = 12;
/** Room under the children for the `↻ …` line, so the annotation never sits
 * behind a node. */
export const GROUP_FOOT = 18;
/** Row height the scope bar and foot are measured in (`text-[11px]` at the
 * line-height the renderer sets on those spans). */
export const GROUP_LABEL_PX = 11;
export const GROUP_LABEL_LINE = 14;
/** The bar's and foot's inset from the box edge. The renderer positions the text
 * with it and the layout measures wrapping against it, so a wider inset can
 * never leave the label sitting on a child again. */
export const GROUP_LABEL_INSET = 8;

/* ------------------------------------------------------- text measurement */

/** The two faces the canvas draws in: the humanist sans of `--font-ui` for a
 * node's id, monospace for kind/state and the scope bars. */
export type CanvasFace = "ui" | "mono";

const NARROW = "ijl.,:;'`|!()[]{}";
const LIGHT = 'frstz_-"';
const WIDE = "mMWw";

/**
 * Character advances as a ratio of font size, measured from the design's own
 * faces with `canvas.measureText` against the loaded fonts (Red Hat Text 600 for
 * `--font-ui`, Red Hat Mono for `--font-mono`, whose `600 11px` cell is 0.64em
 * plus the scope bar's `tracking-[0.04em]`). Each bucket is rounded *up*.
 *
 * Measured rather than guessed because the spread is 4x — `m`/`w` are 0.96em and
 * `i`/`l` 0.24em — and one flat ratio gets the wide names wrong, which are
 * exactly the long ones that used to clip. An over-estimate costs a few px of
 * box; an under-estimate is a clipped node id.
 */
const ADV_SPACE = 0.3;
const ADV_NARROW = 0.32;
const ADV_LIGHT = 0.55;
const ADV_DEFAULT = 0.7;
const ADV_CAP = 0.8;
const ADV_DIGIT = 0.78;
const ADV_WIDE = 1.05;
const ADV_MONO = 0.72;
/** Anything outside ASCII: the `↻ ⊕ ∥ ⇒ · ≤` the canvas draws. */
const ADV_GLYPH = 0.85;

function uiAdvance(ch: string): number {
  if (ch === " ") return ADV_SPACE;
  if ((ch.codePointAt(0) ?? 0) > 0x7f) return ADV_GLYPH;
  if (NARROW.includes(ch)) return ADV_NARROW;
  if (LIGHT.includes(ch)) return ADV_LIGHT;
  if (WIDE.includes(ch)) return ADV_WIDE;
  if (ch >= "0" && ch <= "9") return ADV_DIGIT;
  if (ch >= "A" && ch <= "Z") return ADV_CAP;
  return ADV_DEFAULT;
}

function monoAdvance(ch: string): number {
  return (ch.codePointAt(0) ?? 0) > 0x7f ? ADV_GLYPH : ADV_MONO;
}

/**
 * Estimate the width `text` occupies at `px` in one of the two faces the canvas
 * draws in. Layout stays a pure function (ADR-0025 rule 5) — measuring with the
 * DOM would make it depend on a mount — so these are the measured font metrics
 * applied by hand, biased to over-report: a box a few px wider than its words
 * costs nothing, while an under-report is the clipped label this stops. Verified
 * against `canvas.measureText` on the loaded fonts: every id measured (26→323px)
 * came in at or under the estimate, and no box was ever given fewer rows than
 * the browser used.
 */
export function measureText(text: string, px: number, face: CanvasFace = "ui"): number {
  let units = 0;
  for (const ch of text) units += face === "mono" ? monoAdvance(ch) : uiAdvance(ch);
  return Math.ceil(units * px);
}

/** How many rows `text` needs in a box `availablePx` wide. Greedy word wrapping
 * can cost a row over a uniform measure when one token alone is too wide to
 * split onto the previous line, so that case rounds up. */
export function wrappedLineCount(
  text: string,
  availablePx: number,
  px: number,
  face: CanvasFace = "mono",
): number {
  if (text.length === 0) return 0;
  if (availablePx <= 0) return 1;
  let lines = Math.ceil(measureText(text, px, face) / availablePx);
  const widest = text
    .split(/\s+/)
    .reduce((max, word) => Math.max(max, measureText(word, px, face)), 0);
  if (widest > availablePx) lines += 1;
  return Math.max(1, lines);
}

/* ------------------------------------------------------------ node sizing */

/** Line metrics inside a node box — the numbers `GraphNode` renders with
 * (`text-[12.5px]` id line, `text-[11px]` kind line, the gap between). */
const NODE_ID_PX = 12.5;
const NODE_ID_LINE = 16;
const NODE_KIND_LINE = 14;
const NODE_LINE_GAP = 3;
/** The box's own `pl-[11px] pr-[7px]` plus two 1px borders. */
const NODE_PAD_X = 20;
const NODE_PAD_Y = 20;
/** `<n>` and the gap before it, drawn in mono at 11px. */
const NODE_BINDING_CHIP = 26;

/**
 * The box a node needs: wide enough for its id on one line up to
 * `NODE_MAX_WIDTH`, then one row taller per wrapped id line. Only the id drives
 * width — the kind/state line below is allowed to ellipsize, a name is not.
 * The result is still a pure function of the document, which is what ADR-0025
 * rule 5's determinism needs: same document, same pixels, same edges.
 */
export function nodeBoxFor(
  id: string,
  bindings: number,
  extraLines = 0,
  min: { width: number; height: number } = NODE_SIZE,
): { width: number; height: number } {
  const chip = bindings > 0 ? NODE_BINDING_CHIP : 0;
  const text = measureText(id, NODE_ID_PX, "ui");
  const width = Math.round(Math.min(NODE_MAX_WIDTH, Math.max(min.width, text + chip + NODE_PAD_X)));
  const room = Math.max(48, width - chip - NODE_PAD_X);
  const lines = Math.max(1, Math.ceil(text / room));
  // `extraLines` is the content the id does not drive — the one-row `when`
  // guard the canvas renders — reserved the same way or the card overflows
  // the box dagre spaced around it.
  const height = Math.max(
    min.height,
    NODE_PAD_Y +
      (lines + extraLines) * (NODE_ID_LINE + NODE_LINE_GAP) -
      NODE_LINE_GAP +
      NODE_KIND_LINE,
  );
  return { width, height };
}

/* ---------------------------------------------------------- scope geometry */

/** The one string a scope bar draws. Built here so the geometry that reserves
 * room for it is measured from the same text the renderer puts in the DOM. */
export function scopeHeaderLabel(group: {
  word: string;
  ownerId: string;
  boundLabel: string;
}): string {
  return `${group.word} \u00b7 ${group.ownerId}${
    group.boundLabel ? ` \u00b7 ${group.boundLabel}` : ""
  }`;
}

/** Title-bar height: its own row per wrapped label line, so a narrow scope with
 * a long label ("for each · fan_out · ≤3") pushes its children down instead of
 * writing over them. */
export function scopeHeaderHeight(label: string, innerWidth: number): number {
  const rows = wrappedLineCount(label, innerWidth, GROUP_LABEL_PX, "mono");
  return GROUP_BAR + Math.max(0, rows - 1) * GROUP_LABEL_LINE;
}

/** Foot height under the children for the "↻ …" line, on the same rule. */
export function scopeFootHeight(note: string, innerWidth: number, base = GROUP_FOOT): number {
  if (note.length === 0) return 0;
  const rows = wrappedLineCount(note, innerWidth, GROUP_LABEL_PX, "mono");
  return base + Math.max(0, rows - 1) * GROUP_LABEL_LINE;
}

interface Placement {
  node: DefinitionNode;
  key: string;
  pointer: string;
  groupKey: string | null;
  depth: number;
  children: Placement[];
  /** Set for composite scope nodes: the cluster's graph id. */
  clusterKey: string | null;
}

/**
 * Lay a pipeline definition out. `null` means "I cannot read this as a
 * pipeline" — a draft that has not validated yet is allowed to be shapeless,
 * and the caller shows the YAML rather than a graph it invented.
 */
/**
 * Spacing sets for `layoutDefinition`. The defaults are the existing
 * DefinitionGraph metrics and must stay untouched; `dense` is the canvas
 * (Studio / Workbench) cut — a graph drawn into a pane that is far wider
 * than it is tall, where the fit-to-pane zoom is width-bound and the
 * generous rank gap the edge labels need at 1:1 is what keeps the same
 * graph at zoom 0.6. The edge labels still keep their own clear space:
 * the gap between two ranks is `ranksep`, and a guarded edge's short
 * route label is drawn at the segment midpoint, so `dense.ranksep`
 * floors at twice the widest label box (≈ 44px) it must host.
 */
export const LAYOUT_SPACING = {
  /** The DefinitionGraph default: unchanged. `edgesep` stays unset so dagre
   * keeps the exact default the existing graph has always rendered with. */
  standard: {
    nodesep: 24,
    ranksep: 84,
    edgesep: undefined,
    margin: 12,
    groupPad: GROUP_PAD,
    groupGap: GROUP_GAP,
    groupFoot: GROUP_FOOT,
    /** The floor every node box gets. */
    nodeMin: { width: NODE_SIZE.width, height: NODE_SIZE.height },
  },
  /** The canvas (Studio / Workbench) cut — dense. The graph fills a pane that
   * is far wider than it is tall, so the fit-to-pane zoom is what the
   * generous default rank gap and box floors spent; the floors shrink to
   * the content the box really holds (id line + kind line), and the rank
   * gap floors at the clear space the guarded-edge label box needs.
   */
  dense: {
    nodesep: 14,
    ranksep: 52,
    edgesep: 12,
    margin: 8,
    groupPad: 8,
    groupGap: 8,
    groupFoot: 10,
    nodeMin: { width: 96, height: 54 },
  },
} as const;

export type LayoutSpacingName = keyof typeof LAYOUT_SPACING;

type Spacing = (typeof LAYOUT_SPACING)[LayoutSpacingName];

export function layoutDefinition(
  document: DefinitionDocument,
  options: {
    rankdir?: "LR" | "TB";
    spacing?: LayoutSpacingName;
    /**
     * Lay each scope cluster's body in the opposite direction to the graph.
     * A scope's body is a chain, so in a `TB` graph the cluster becomes a
     * short wide box instead of a tall narrow one — the one move that keeps
     * the graph's total height from stacking every loop body vertically.
     * dagre 3.1.1 lays a cluster out as its own subgraph when the cluster
     * node carries its own `rankdir`; observed, not assumed.
     */
    subgraphRankdir?: "opposite";
  } = {},
): DefinitionGraphLayout | null {
  const roots = document.spec?.nodes;
  if (!Array.isArray(roots) || roots.length === 0) return null;

  const s: Spacing = LAYOUT_SPACING[options.spacing ?? "standard"];

  // 1. Placement tree: every scope node owns a group holding its body.
  const byKey = new Map<string, Placement>();
  const place = (
    nodes: DefinitionNode[],
    groupKey: string | null,
    depth: number,
    pointerPrefix: string,
  ): Placement[] =>
    nodes
      .filter((node) => typeof node?.id === "string" && node.id.length > 0)
      .map((node, index) => {
        // A group's cluster id carries a `#` so it cannot collide with a node
        // id; the node keys below it stay plain paths, which is the same shape
        // a runtime `node_instance_key` has (minus the `[n]` suffixes).
        // The key is the shape `node_instance_key` has on the wire minus the
        // `[n]` iteration suffix — leading `/` included — so a run's rows join
        // onto graph boxes without a translation layer to get wrong.
        const key = groupKey ? `${groupKey.replace(/^#/, "")}/${node.id}` : `/${node.id}`;
        const pointer = `${pointerPrefix}/${index}`;
        const placement: Placement = {
          node,
          key,
          pointer,
          groupKey,
          depth,
          children: [],
          clusterKey: null,
        };
        byKey.set(key, placement);
        // A scope with no body cannot be a box around nothing: `empty_body` is
        // a compiler error, and the renderer degrades to a plain node so a
        // draft's own shape stays visible.
        const body = isScopeKind(node.kind) ? scopeBody(node) : [];
        if (body.length > 0) {
          placement.clusterKey = `#${key}`;
          placement.children = place(
            body,
            placement.clusterKey,
            depth + 1,
            `${pointer}/config/body/nodes`,
          );
        }
        return placement;
      });
  const tree = place(roots, null, 0, "/spec/nodes");

  /** Every concrete node's box, keyed by node key — the one source of box size
   * for dagre, for the group boxes, and for the DOM. */
  const sizes = new Map<string, { width: number; height: number }>();

  const flatten = (list: Placement[]): Placement[] =>
    list.flatMap((item) => [item, ...flatten(item.children)]);
  const all = flatten(tree);
  if (all.length === 0) return null;

  // 2. Graph: a scope node contributes its cluster and nothing else.
  const graph = new Graph({ compound: true });
  const rankdir = options.rankdir ?? "LR";
  graph.setGraph({
    rankdir,
    nodesep: s.nodesep,
    ...(s.edgesep !== undefined ? { edgesep: s.edgesep } : {}),
    // The gap ranks keep for edge labels: a guarded edge draws its short
    // route value at the segment midpoint, and that label box must have
    // clear space of its own — it never rides on top of a node box.
    ranksep: s.ranksep,
    marginx: s.margin,
    marginy: s.margin,
    acyclicer: "greedy",
    ranker: "network-simplex",
  });
  graph.setDefaultEdgeLabel(() => ({}));

  for (const placement of all) {
    if (placement.clusterKey) {
      // Measured from its children; zero size keeps dagre from reserving room
      // for the box itself, which is what the observed behaviour wants. A
      // cluster's own `rankdir` makes dagre lay its body out as a subgraph in
      // that direction (ADR-0025: edges never point at the cluster id itself,
      // which is the one configuration that crashes the library).
      const attrs: { width: number; height: number; rankdir?: "LR" | "TB" } = {
        width: 0,
        height: 0,
      };
      if (options.subgraphRankdir === "opposite") {
        attrs.rankdir = rankdir === "TB" ? "LR" : "TB";
      }
      graph.setNode(placement.clusterKey, attrs);
      if (placement.groupKey) graph.setParent(placement.clusterKey, placement.groupKey);
      continue;
    }
    // A box sized to its own id: dagre spaces ranks by the width it is given,
    // so edges, group boxes and the canvas total all follow the same number the
    // renderer draws with.
    const size = nodeBoxFor(
      placement.node.id,
      nodeBindings(placement.node).length,
      typeof placement.node.when === "string" ? 1 : 0,
      s.nodeMin,
    );
    sizes.set(placement.key, size);
    graph.setNode(placement.key, size);
    if (placement.groupKey) graph.setParent(placement.key, placement.groupKey);
  }

  /** Where a reference *into* a node lands: a scope is entered at its body's entries. */
  const entryPoints = (placement: Placement): string[] => {
    if (!placement.clusterKey) return [placement.key];
    const body = placement.children.map((child) => child.node);
    const entries = new Set(scopeEntryNodes(body).map((node) => node.id));
    const keys = placement.children
      .filter((child) => entries.has(child.node.id))
      .map((child) => child.key);
    return keys.length > 0 ? keys : placement.children.map((child) => child.key);
  };

  /** Where a dependency *from* a node leaves: a scope exits at its body's exits. */
  const exitPoints = (placement: Placement): string[] => {
    if (!placement.clusterKey) return [placement.key];
    const body = placement.children.map((child) => child.node);
    const exits = new Set(scopeExitNodes(body).map((node) => node.id));
    const keys = placement.children
      .filter((child) => exits.has(child.node.id))
      .map((child) => child.key);
    return keys.length > 0 ? keys : placement.children.map((child) => child.key);
  };

  /**
   * A `dependsOn` name resolved in the referrer's scope, then at the document
   * root. A group's cluster id carries the `#` and its members' keys do not, so
   * the scope path is what a sibling reference is relative to.
   */
  const resolve = (ref: string, from: Placement): Placement | undefined => {
    // Nearest enclosing scope wins, then the document root — which is how
    // `dependsOn` resolves in the engine (03). A scope's body may hold a node
    // with the same id as a root node, and the inner one shadows the outer.
    const scope = from.groupKey ? from.groupKey.replace(/^#/, "") : "";
    return byKey.get(`${scope}/${ref}`) ?? byKey.get(`/${ref}`);
  };

  const seen = new Set<string>();
  const addEdge = (from: string, to: string, kind: "depends" | "error") => {
    if (from === to) return;
    // The kind is part of the identity: one pair of nodes can legitimately hold
    // both a dependency edge and an error route, and dropping the second would
    // hide a route the document declares.
    const id = `${from}\u0000${to}\u0000${kind}`;
    if (seen.has(id)) return;
    seen.add(id);
    graph.setEdge(from, to, { kind });
  };

  for (const placement of all) {
    for (const ref of placement.node.dependsOn ?? []) {
      const source = resolve(ref, placement);
      if (!source) continue;
      for (const from of exitPoints(source)) {
        for (const to of entryPoints(placement)) addEdge(from, to, "depends");
      }
    }
    const route = placement.node.onFailure?.errorRoute;
    if (typeof route === "string" && route.length > 0) {
      const target = resolve(route, placement);
      if (target) {
        // A scope leaves through its body's exits, exactly as a dependency does:
        // the composite's own key names a group, and dagre has no box to leave
        // from (03 § 3, and the cluster-edge crash ADR-0025 records).
        for (const from of exitPoints(placement)) {
          for (const to of entryPoints(target)) addEdge(from, to, "error");
        }
      }
    }
  }

  dagreLayout(graph);

  // 3. Groups back out, deepest first, each padded for its title bar.
  const groupViews = new Map<string, GraphGroupView>();
  const boxes = new Map<string, { x: number; y: number; width: number; height: number }>();
  const deepestFirst = [...all]
    .filter((placement) => placement.clusterKey)
    .sort((a, b) => b.depth - a.depth);

  for (const placement of deepestFirst) {
    const box = childBox(graph, placement, boxes, sizes);
    const word = kindWord(placement.node.kind);
    const boundLabel = scopeBoundLabel(placement.node);
    const loopNote = scopeLoopNote(placement.node);
    const width = box.width + s.groupPad * 2;
    // The label and the foot wrap inside the box, so the rows they need are the
    // box's own width less the bar's left/right inset.
    const inner = width - GROUP_LABEL_INSET * 2;
    const headerText = scopeHeaderLabel({ word, ownerId: placement.node.id, boundLabel });
    const header = scopeHeaderHeight(headerText, inner);
    const foot = scopeFootHeight(loopNote, inner, s.groupFoot);
    const view: GraphGroupView = {
      key: placement.clusterKey as string,
      ownerId: placement.node.id,
      pointer: placement.pointer,
      kind: placement.node.kind,
      boundLabel,
      x: box.x - s.groupPad,
      y: box.y - s.groupPad - header,
      width,
      height: box.height + s.groupPad * 2 + header + foot,
      depth: placement.depth,
      word,
      loopNote,
      headerText,
      headerWidth: inner,
      noteWidth: inner,
    };
    boxes.set(view.key, { x: view.x, y: view.y, width: view.width, height: view.height });
    groupViews.set(view.key, view);
  }

  const groups = [...groupViews.values()].sort((a, b) => a.depth - b.depth);
  const nodes = layoutNodes(graph, all, sizes);

  // A group's padding and (now) its multi-row bar reach outside where dagre put
  // its children, so a first-rank scope can spill past the canvas's top/left
  // edge — the one place a scroll container cannot reach. Slide the whole graph
  // back inside its margins instead of clipping the box.
  const marginX = graph.graph().marginx ?? s.margin;
  const marginY = graph.graph().marginy ?? s.margin;
  const shiftX = Math.max(
    0,
    marginX - Math.min(...nodes.map((node) => node.x), ...groups.map((group) => group.x)),
  );
  const shiftY = Math.max(
    0,
    marginY - Math.min(...nodes.map((node) => node.y), ...groups.map((group) => group.y)),
  );
  if (shiftX > 0 || shiftY > 0) {
    for (const node of nodes) {
      node.x += shiftX;
      node.y += shiftY;
    }
    for (const group of groups) {
      group.x += shiftX;
      group.y += shiftY;
    }
  }
  // 4. dagre spaced the children; the bar and foot belong to the group. Two
  // sibling scopes whose children fall in different ranks can end up with one
  // box's foot over the next box's label (`for each` over `until` in the
  // feature-development revision), so push siblings apart, deepest descendants
  // riding along with the box they live in.
  const moved = separateSiblingGroups(groups, nodes, s.groupGap);
  const nodeByKey = new Map(nodes.map((node) => [node.key, node]));

  const edges: GraphEdgeView[] = graph.edges().map((edge) => {
    const label = graph.edge(edge) as
      | { kind?: string; points?: { x?: number; y?: number }[] }
      | undefined;
    return {
      from: edge.v,
      to: edge.w,
      // The label's own kind and nothing else. Inferring "error" from "this
      // node has an error route somewhere" would paint every dependency leaving
      // that node as a failure path — a dashed red line the document never
      // declared (`onFailure.errorRoute` is one edge, not a property of a node).
      kind: label?.kind === "error" ? "error" : "depends",
      // Once a box has been pushed down the dagre polyline no longer touches
      // its endpoints, so every edge is re-run through the same elbow router —
      // one routing rule for both cases beats a mix of two. An unrouted
      // polyline only needs the graph-wide slide the group padding forced.
      points: moved
        ? routePoints(nodeByKey, edge.v, edge.w, options.rankdir ?? "LR")
        : (label?.points ?? []).map((point) => ({
            x: (point.x ?? 0) + shiftX,
            y: (point.y ?? 0) + shiftY,
          })),
    };
  });

  const bottom = Math.max(
    0,
    ...nodes.map((node) => node.y + node.height),
    ...groups.map((group) => group.y + group.height),
  );
  const right = Math.max(
    0,
    ...nodes.map((node) => node.x + node.width),
    ...groups.map((group) => group.x + group.width),
  );

  return {
    width: Math.max(graph.graph().width ?? 0, right + s.margin),
    height: Math.max(graph.graph().height ?? 0, bottom + s.margin),
    nodes,
    groups,
    edges,
  };
}

/** Placed boxes for every concrete node, in declaration order. */
function layoutNodes(
  graph: Graph,
  all: Placement[],
  sizes: Map<string, { width: number; height: number }>,
): GraphNodeView[] {
  return all
    .filter((placement) => !placement.clusterKey)
    .map((placement) => {
      const box = graph.node(placement.key);
      const size = sizes.get(placement.key) ?? NODE_SIZE;
      return {
        key: placement.key,
        id: placement.node.id,
        pointer: placement.pointer,
        kind: placement.node.kind,
        groupKey: placement.groupKey,
        x: (box?.x ?? 0) - size.width / 2,
        y: (box?.y ?? 0) - size.height / 2,
        width: size.width,
        height: size.height,
        bindings: nodeBindings(placement.node),
        deferredTo:
          (DEFERRED_KINDS as Record<string, string | undefined>)[placement.node.kind] ?? null,
        when: typeof placement.node.when === "string" ? placement.node.when : null,
        dependsOn: placement.node.dependsOn ?? [],
        errorRoute: placement.node.onFailure?.errorRoute ?? null,
        boundLabel: isScopeKind(placement.node.kind) ? scopeBoundLabel(placement.node) : "",
        word: kindWord(placement.node.kind),
        gate: isGateKind(placement.node.kind),
      };
    });
}

/** Bounding box of a group's placed children (nested groups included). */
function childBox(
  graph: Graph,
  placement: Placement,
  boxes: Map<string, { x: number; y: number; width: number; height: number }>,
  sizes: Map<string, { width: number; height: number }>,
): { x: number; y: number; width: number; height: number } {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  const grow = (x: number, y: number, width: number, height: number) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + width);
    maxY = Math.max(maxY, y + height);
  };

  for (const child of placement.children) {
    if (child.clusterKey) {
      const box = boxes.get(child.clusterKey);
      if (box) grow(box.x, box.y, box.width, box.height);
      continue;
    }
    const node = graph.node(child.key);
    const size = sizes.get(child.key) ?? NODE_SIZE;
    const width = size.width;
    const height = size.height;
    grow((node?.x ?? 0) - width / 2, (node?.y ?? 0) - height / 2, width, height);
  }

  if (!Number.isFinite(minX)) {
    return { x: 0, y: 0, width: NODE_SIZE.width, height: NODE_SIZE.height };
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The scope path a group key encodes: `#/build_until_verified` → `/build_until_verified`. */
function groupPath(key: string): string {
  return key.replace(/^#/, "");
}

/** The enclosing scope path of a group — `''` for a root-level one. */
function parentPath(key: string): string {
  const path = groupPath(key);
  const cut = path.lastIndexOf("/");
  return cut <= 0 ? "" : path.slice(0, cut);
}

/** Does `key` (a node key or a group path) live inside the scope `path`? */
function isInside(key: string, path: string): boolean {
  return key.startsWith(`${path}/`);
}

function overlaps(a: Box, b: Box, gap: number): boolean {
  return (
    a.x < b.x + b.width + gap &&
    b.x < a.x + a.width + gap &&
    a.y < b.y + b.height + gap &&
    b.y < a.y + a.height + gap
  );
}

/**
 * Push sibling scope boxes apart until no two of them — bar and foot included —
 * intersect. Moving a box moves everything inside it, and a box pushed down
 * once can collide with its own successor, hence the repeat until stable.
 * Returns whether anything moved, because a moved box invalidates the dagre
 * edge routing. Exported for its own test: the overlap it repairs is a geometry
 * dagre produced on a real revision, and a fixture that happens to reproduce a
 * library's ranking is not a proof of the rule.
 */
export function separateSiblingGroups(
  groups: GraphGroupView[],
  nodes: GraphNodeView[],
  gap = GROUP_GAP,
): boolean {
  const shift = (path: string, dy: number) => {
    for (const group of groups) {
      const own = groupPath(group.key);
      if (own === path || isInside(own, path)) group.y += dy;
    }
    for (const node of nodes) if (isInside(node.key, path)) node.y += dy;
  };

  let moved = false;
  for (let pass = 0; pass < 16; pass += 1) {
    let changed = false;
    const byParent = new Map<string, GraphGroupView[]>();
    for (const group of groups) {
      const parent = parentPath(group.key);
      const list = byParent.get(parent) ?? [];
      list.push(group);
      byParent.set(parent, list);
    }
    for (const list of byParent.values()) {
      list.sort((a, b) => a.y - b.y || a.x - b.x);
      for (let i = 0; i < list.length; i += 1) {
        for (let j = i + 1; j < list.length; j += 1) {
          const upper = list[i];
          const lower = list[j];
          // Sorted by y: once a box clears the gap, everything after it does.
          if (lower.y >= upper.y + upper.height + gap) break;
          if (!overlaps(upper, lower, gap)) continue;
          const dy = upper.y + upper.height + gap - lower.y;
          if (dy <= 0) continue;
          shift(groupPath(lower.key), dy);
          changed = true;
          moved = true;
        }
      }
    }
    if (!changed) break;
  }
  return moved;
}

/**
 * A three-segment elbow between two placed boxes. Used once any group has moved
 * (dagre's own polyline would no longer end on its node); the back-edge case —
 * a loop that returns to an earlier node — leaves to the right and comes back in
 * from the right rather than cutting through the boxes between them. In a
 * `TB` layout the same rule runs vertically: out of the source's bottom-centre
 * into the target's top-centre.
 */
function routePoints(
  nodes: Map<string, GraphNodeView>,
  from: string,
  to: string,
  rankdir: "LR" | "TB" = "LR",
): { x: number; y: number }[] {
  const source = nodes.get(from);
  const target = nodes.get(to);
  if (!source || !target) return [];
  if (rankdir === "TB") {
    const x1 = source.x + source.width / 2;
    const y1 = source.y + source.height;
    const x2 = target.x + target.width / 2;
    const y2 = target.y;
    const mid = y2 > y1 + 16 ? (y1 + y2) / 2 : Math.max(y1, target.y + target.height) + 14;
    return [
      { x: x1, y: y1 },
      { x: x1, y: mid },
      { x: x2, y: mid },
      { x: x2, y: y2 },
    ];
  }
  const x1 = source.x + source.width;
  const y1 = source.y + source.height / 2;
  const x2 = target.x;
  const y2 = target.y + target.height / 2;
  const mid = x2 > x1 + 16 ? (x1 + x2) / 2 : Math.max(x1, target.x + target.width) + 14;
  return [
    { x: x1, y: y1 },
    { x: mid, y: y1 },
    { x: mid, y: y2 },
    { x: x2, y: y2 },
  ];
}
