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

/** Narrower and taller than the first cut: the graph is drawn into a pane that
 * is far wider than it is tall, so width is the scarce axis and the one the
 * fit-to-pane scale is divided by. */
export const NODE_SIZE = { width: 108, height: 60 };
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
export function layoutDefinition(
  document: DefinitionDocument,
  options: { rankdir?: "LR" | "TB" } = {},
): DefinitionGraphLayout | null {
  const roots = document.spec?.nodes;
  if (!Array.isArray(roots) || roots.length === 0) return null;

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

  const flatten = (list: Placement[]): Placement[] =>
    list.flatMap((item) => [item, ...flatten(item.children)]);
  const all = flatten(tree);
  if (all.length === 0) return null;

  // 2. Graph: a scope node contributes its cluster and nothing else.
  const graph = new Graph({ compound: true });
  graph.setGraph({
    rankdir: options.rankdir ?? "LR",
    nodesep: 24,
    ranksep: 34,
    marginx: 12,
    marginy: 12,
    acyclicer: "greedy",
    ranker: "network-simplex",
  });
  graph.setDefaultEdgeLabel(() => ({}));

  for (const placement of all) {
    if (placement.clusterKey) {
      // Measured from its children; zero size keeps dagre from reserving room
      // for the box itself, which is what the observed behaviour wants.
      graph.setNode(placement.clusterKey, { width: 0, height: 0 });
      if (placement.groupKey) graph.setParent(placement.clusterKey, placement.groupKey);
      continue;
    }
    graph.setNode(placement.key, { ...NODE_SIZE });
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
    const box = childBox(graph, placement, boxes);
    const view: GraphGroupView = {
      key: placement.clusterKey as string,
      ownerId: placement.node.id,
      pointer: placement.pointer,
      kind: placement.node.kind,
      boundLabel: scopeBoundLabel(placement.node),
      x: box.x - GROUP_PAD,
      y: box.y - GROUP_PAD - GROUP_BAR,
      width: box.width + GROUP_PAD * 2,
      height: box.height + GROUP_PAD * 2 + GROUP_BAR + GROUP_FOOT,
      depth: placement.depth,
      word: kindWord(placement.node.kind),
      loopNote: scopeLoopNote(placement.node),
    };
    boxes.set(view.key, { x: view.x, y: view.y, width: view.width, height: view.height });
    groupViews.set(view.key, view);
  }

  const groups = [...groupViews.values()].sort((a, b) => a.depth - b.depth);
  const nodes = layoutNodes(graph, all);
  // 4. dagre spaced the children; the bar and foot belong to the group. Two
  // sibling scopes whose children fall in different ranks can end up with one
  // box's foot over the next box's label (`for each` over `until` in the
  // feature-development revision), so push siblings apart, deepest descendants
  // riding along with the box they live in.
  const moved = separateSiblingGroups(groups, nodes);
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
      // one routing rule for both cases beats a mix of two.
      points: moved
        ? routePoints(nodeByKey, edge.v, edge.w)
        : (label?.points ?? []).map((point) => ({ x: point.x ?? 0, y: point.y ?? 0 })),
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
    width: Math.max(graph.graph().width ?? 0, right + (graph.graph().marginx ?? 12)),
    height: Math.max(graph.graph().height ?? 0, bottom + (graph.graph().marginy ?? 12)),
    nodes,
    groups,
    edges,
  };
}

/** Placed boxes for every concrete node, in declaration order. */
function layoutNodes(graph: Graph, all: Placement[]): GraphNodeView[] {
  return all
    .filter((placement) => !placement.clusterKey)
    .map((placement) => {
      const box = graph.node(placement.key);
      return {
        key: placement.key,
        id: placement.node.id,
        pointer: placement.pointer,
        kind: placement.node.kind,
        groupKey: placement.groupKey,
        x: (box?.x ?? 0) - NODE_SIZE.width / 2,
        y: (box?.y ?? 0) - NODE_SIZE.height / 2,
        width: box?.width ?? NODE_SIZE.width,
        height: box?.height ?? NODE_SIZE.height,
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
    const width = node?.width ?? NODE_SIZE.width;
    const height = node?.height ?? NODE_SIZE.height;
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
export function separateSiblingGroups(groups: GraphGroupView[], nodes: GraphNodeView[]): boolean {
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
          if (lower.y >= upper.y + upper.height + GROUP_GAP) break;
          if (!overlaps(upper, lower, GROUP_GAP)) continue;
          const dy = upper.y + upper.height + GROUP_GAP - lower.y;
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
 * from the right rather than cutting through the boxes between them.
 */
function routePoints(
  nodes: Map<string, GraphNodeView>,
  from: string,
  to: string,
): { x: number; y: number }[] {
  const source = nodes.get(from);
  const target = nodes.get(to);
  if (!source || !target) return [];
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
