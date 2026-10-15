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
  isScopeKind,
  nodeBindings,
  scopeBody,
  scopeBoundLabel,
  scopeEntryNodes,
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

export const NODE_SIZE = { width: 200, height: 60 };
export const GROUP_BAR = 22;
export const GROUP_PAD = 12;

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
    nodesep: 20,
    ranksep: 56,
    marginx: 16,
    marginy: 16,
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
      height: box.height + GROUP_PAD * 2 + GROUP_BAR,
      depth: placement.depth,
    };
    boxes.set(view.key, { x: view.x, y: view.y, width: view.width, height: view.height });
    groupViews.set(view.key, view);
  }

  const nodes: GraphNodeView[] = all
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
      };
    });

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
      points: (label?.points ?? []).map((point) => ({ x: point.x ?? 0, y: point.y ?? 0 })),
    };
  });

  return {
    width: graph.graph().width ?? 0,
    height: graph.graph().height ?? 0,
    nodes,
    groups: [...groupViews.values()].sort((a, b) => a.depth - b.depth),
    edges,
  };
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
