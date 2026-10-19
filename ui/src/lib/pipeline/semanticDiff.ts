/**
 * The readable semantic diff between a published revision and a draft.
 *
 * The server has no diff route: the revision serves `canonical_document`
 * (JSON) and the draft carries YAML text, so the diff is computed here from
 * the two parsed trees. The diff is *semantic*, not textual — key order is
 * irrelevant, node identity is its `id`, and `metadata.ui` is layout
 * metadata that never enters the revision digest, so it never enters this
 * diff either (`layoutOnly` says so when it is the *only* difference).
 *
 * Edges come from `dependsOn` alone (there are no edge objects in the
 * schema); an `onFailure.errorRoute` shows as `from -> to (error)`.
 */

export interface FieldChange {
  /** Dotted path inside the node (`config.prompt`, `retry.maxAttempts`). */
  path: string;
  before: unknown;
  after: unknown;
}

export interface NodeChange {
  id: string;
  /** `""` at top level, else the scope chain of scope-node ids (`loop/inner`). */
  scope: string;
  kind: string;
  change: "added" | "removed" | "changed" | "moved";
  fields: FieldChange[];
}

export interface EdgeChange {
  from: string;
  /** `to` carries a ` (error)` suffix for `onFailure.errorRoute` edges. */
  to: string;
  change: "added" | "removed";
}

export interface PipelineChange {
  /** Dotted path at the document level (`spec.policies.maxDurationSeconds`). */
  path: string;
  before: unknown;
  after: unknown;
}

export interface DiffResult {
  nodes: NodeChange[];
  edges: EdgeChange[];
  pipeline: PipelineChange[];
  /** True when the only differences are under `metadata.ui`. */
  layoutOnly: boolean;
  /** True when there is no difference at all — not even `metadata.ui`. */
  empty: boolean;
}

/* ------------------------------------------------------------------ nodes */

/** One node anywhere in the tree, with the scope path that contains it. */
interface NodeRecord {
  id: string;
  scope: string;
  kind: string;
  raw: Record<string, unknown>;
}

function isPlain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Every node of the document, keyed by id. `dependsOn` never crosses a scope
 * boundary, so a global id is unique within one document and is the match
 * key across the two trees (a node moved into a scope keeps its id).
 */
function indexNodes(document: unknown): Map<string, NodeRecord> {
  const out = new Map<string, NodeRecord>();
  const spec = isPlain(document) ? document.spec : undefined;
  const nodes = isPlain(spec) && Array.isArray(spec.nodes) ? spec.nodes : [];
  walkList(nodes, "", out);
  return out;
}

function walkList(list: unknown[], scope: string, out: Map<string, NodeRecord>): void {
  for (const entry of list) {
    if (!isPlain(entry) || typeof entry.id !== "string") continue;
    const kind = typeof entry.kind === "string" ? entry.kind : "";
    const here = scope === "" ? "" : `${scope}/${entry.id}`;
    if (!out.has(entry.id)) {
      out.set(entry.id, { id: entry.id, scope, kind, raw: entry });
    }
    const children: unknown[][] = [];
    const config = isPlain(entry.config) ? entry.config : undefined;
    if (kind === "until" || kind === "for_each") {
      const body = isPlain(config?.body) ? config.body : undefined;
      children.push(Array.isArray(body?.nodes) ? (body?.nodes as unknown[]) : []);
    } else if (kind === "parallel") {
      const branches = Array.isArray(config?.branches) ? (config?.branches as unknown[]) : [];
      for (const branch of branches) {
        if (isPlain(branch) && Array.isArray(branch.nodes)) children.push(branch.nodes);
      }
    }
    for (const body of children) walkList(body, here || entry.id, out);
  }
}

/**
 * The node's own fields — everything except `id` and the child-node
 * containers (`config.body.nodes`, `config.branches[].nodes`), whose content
 * is accounted for as the children's own changes (a move or a change), never
 * as one giant field of the scope node.
 */
function ownFields(node: Record<string, unknown>): Record<string, unknown> {
  const { id: _id, ...rest } = node;
  const config = isPlain(rest.config) ? rest.config : undefined;
  if (!config) return rest;
  const stripped = { ...config };
  const body = stripped.body;
  if (isPlain(body)) stripped.body = { ...body, nodes: undefined };
  if (Array.isArray(stripped.branches)) {
    stripped.branches = stripped.branches.map((branch) =>
      isPlain(branch) ? { ...branch, nodes: undefined } : branch,
    );
  }
  return { ...rest, config: stripped };
}

/* ------------------------------------------------------------------ diff */

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  }
  if (isPlain(a) && isPlain(b)) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    return (
      keysA.length === keysB.length &&
      keysA.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]))
    );
  }
  return false;
}

/**
 * Recurse into plain objects (key order is irrelevant), otherwise record one
 * change for the whole value — arrays included, so `dependsOn: [a] -> [b]`
 * reads as one field change plus the two edge changes the caller derives.
 */
function deepDiff(before: unknown, after: unknown, path: string, out: FieldChange[]): void {
  if (deepEqual(before, after)) return;
  if (isPlain(before) && isPlain(after)) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      deepDiff(
        Object.hasOwn(before, key) ? before[key] : undefined,
        Object.hasOwn(after, key) ? after[key] : undefined,
        path === "" ? key : `${path}.${key}`,
        out,
      );
    }
    return;
  }
  out.push({ path, before, after });
}

/* ----------------------------------------------------------------- edges */

interface Edge {
  from: string;
  to: string;
  error: boolean;
}

function edgeKey(edge: Edge): string {
  return `${edge.from}\u0000${edge.to}\u0000${edge.error ? "e" : "d"}`;
}

/**
 * The edge set of a tree: one edge per `dependsOn` entry, plus the
 * `onFailure.errorRoute` edges marked as error edges.
 */
function edgeSet(nodes: Map<string, NodeRecord>): Map<string, Edge> {
  const out = new Map<string, Edge>();
  for (const record of nodes.values()) {
    const push = (from: string, to: string, error: boolean) => {
      const edge = { from, to, error };
      out.set(edgeKey(edge), edge);
    };
    // the edge runs prerequisite -> dependent, so `dependsOn: [a]` on node b
    // is the edge a -> b; an error route runs from the failing node
    const dependsOn = Array.isArray(record.raw.dependsOn) ? record.raw.dependsOn : [];
    for (const dep of dependsOn) if (typeof dep === "string") push(dep, record.id, false);
    const onFailure = record.raw.onFailure;
    if (isPlain(onFailure) && typeof onFailure.errorRoute === "string") {
      push(record.id, onFailure.errorRoute, true);
    }
  }
  return out;
}

/* ------------------------------------------------- pipeline-level fields */

/** `metadata` without `ui` — the layout never enters the digest, so never the diff. */
function metadataMinusUi(document: unknown): unknown {
  if (!isPlain(document) || !isPlain(document.metadata)) {
    return isPlain(document) ? document.metadata : undefined;
  }
  const { ui: _ui, ...rest } = document.metadata;
  return rest;
}

/** `spec` without `nodes` — nodes are diffed by identity, not by position. */
function specMinusNodes(document: unknown): unknown {
  const spec = isPlain(document) ? document.spec : undefined;
  if (!isPlain(spec)) return spec;
  const { nodes: _nodes, ...rest } = spec;
  return rest;
}

/* ------------------------------------------------------------------ API */

/**
 * Diff `base` (the revision's `canonical_document`, or `null` when nothing is
 * published yet) against `next` (the draft parsed from its YAML text).
 */
export function semanticDiff(base: unknown | null, next: unknown): DiffResult {
  const baseNodes = indexNodes(base);
  const nextNodes = indexNodes(next);

  const nodes: NodeChange[] = [];
  for (const [id, record] of nextNodes) {
    const before = baseNodes.get(id);
    if (!before) {
      nodes.push({ id, scope: record.scope, kind: record.kind, change: "added", fields: [] });
      continue;
    }
    const fields: FieldChange[] = [];
    deepDiff(ownFields(before.raw), ownFields(record.raw), "", fields);
    if (before.scope !== record.scope) {
      nodes.push({ id, scope: record.scope, kind: record.kind, change: "moved", fields });
    } else if (fields.length > 0) {
      nodes.push({ id, scope: record.scope, kind: record.kind, change: "changed", fields });
    }
  }
  for (const [id, record] of baseNodes) {
    if (!nextNodes.has(id)) {
      nodes.push({ id, scope: record.scope, kind: record.kind, change: "removed", fields: [] });
    }
  }

  const baseEdges = edgeSet(baseNodes);
  const nextEdges = edgeSet(nextNodes);
  const edges: EdgeChange[] = [];
  for (const [key, edge] of nextEdges) {
    if (!baseEdges.has(key)) {
      edges.push({
        from: edge.from,
        to: edge.error ? `${edge.to} (error)` : edge.to,
        change: "added",
      });
    }
  }
  for (const [key, edge] of baseEdges) {
    if (!nextEdges.has(key)) {
      edges.push({
        from: edge.from,
        to: edge.error ? `${edge.to} (error)` : edge.to,
        change: "removed",
      });
    }
  }

  const pipeline: PipelineChange[] = [];
  deepDiff(metadataMinusUi(base), metadataMinusUi(next), "metadata", pipeline);
  deepDiff(specMinusNodes(base), specMinusNodes(next), "spec", pipeline);

  const semanticCount = nodes.length + edges.length + pipeline.length;
  // pipeline[] already covers metadata (minus ui) and spec (minus nodes):
  // when it is empty, the only remaining place a difference can hide is
  // metadata.ui — the layout metadata that never enters the digest
  const metadataEqual = deepEqual(metadataOf(base), metadataOf(next));
  const layoutOnly = semanticCount === 0 && !metadataEqual;
  const empty = semanticCount === 0 && metadataEqual;
  return { nodes, edges, pipeline, layoutOnly, empty };
}

/** The document's `metadata`, for the layout-only check (ui included). */
function metadataOf(document: unknown): unknown {
  return isPlain(document) ? document.metadata : undefined;
}
