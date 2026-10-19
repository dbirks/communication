/**
 * graphDoc.ts — pure document operations over canonical pipeline YAML text.
 *
 * The YAML text is the source of truth. Every op takes the document text and
 * returns new YAML text (doc.toString()), preserving comments and every
 * untouched node. No JSON round-trips are ever used for writing.
 */
import { Document, isMap, isSeq, parseDocument, YAMLMap, type YAMLSeq } from "yaml";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** [] = spec.nodes; ["loop"] = body of node "loop"; ["par","1"] = parallel branch 1 */
export type ScopePath = string[];

export interface GraphNode {
  id: string;
  kind: string;
  scope: ScopePath;
  /** e.g. /spec/nodes/2/config/body/nodes/0 */
  pointer: string;
  dependsOn: string[];
  when: string | null;
  isScope: boolean;
  /** approachable name */
  label: string;
}

export interface GraphEdge {
  /** `${scopeKey}:${from}->${to}` */
  id: string;
  from: string;
  to: string;
  scope: ScopePath;
  kind: "depends" | "guarded" | "error";
  /** why inserting here is not plain; empty when safe */
  reasons: string[];
}

export interface GraphModel {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export type ParseResult =
  | { ok: true; model: GraphModel }
  | { ok: false; error: string; line: number | null };

export type OpResult =
  | { ok: true; text: string; changed: string[] }
  | { ok: false; error: string }
  | { ok: false; ambiguous: true; reasons: string[] };

// ---------------------------------------------------------------------------
// Step library + skeletons
// ---------------------------------------------------------------------------

/** The schema's identifier pattern (pipeline-v1alpha1.schema.json `$defs.identifier`). */
export const IDENTIFIER_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;

export function isValidId(id: string): boolean {
  return IDENTIFIER_PATTERN.test(id);
}

const ID_MESSAGE = "ids use lowercase letters, digits and _ (start with a letter)";

export const STEP_LIBRARY: {
  kind: string;
  label: string;
  description: string;
  runnable: boolean;
}[] = [
  {
    kind: "agent.acp",
    label: "Coding agent",
    description: "Run a coding-agent session (ACP) in the run workspace.",
    runnable: true,
  },
  {
    kind: "model.chat",
    label: "Ask a model",
    description: "Send messages to a chat model and capture its reply.",
    runnable: true,
  },
  {
    kind: "process.exec",
    label: "Run command / tests",
    description: "Execute a command in the workspace and extract outputs.",
    runnable: true,
  },
  {
    kind: "human.approval",
    label: "Human approval",
    description: "Pause the run until a human approves or rejects.",
    runnable: true,
  },
  {
    kind: "condition",
    label: "Condition",
    description: "Route the run by matching a CEL case or falling to a default route.",
    runnable: true,
  },
  {
    kind: "until",
    label: "Repeat until",
    description: "Repeat a body until the pass condition holds or limits are reached.",
    runnable: true,
  },
  {
    kind: "for_each",
    label: "For each",
    description: "Run a body once per item of a bound list.",
    runnable: true,
  },
  {
    kind: "pipeline.invoke",
    label: "Call pipeline",
    description: "Invoke another pipeline as a child run.",
    runnable: true,
  },
  {
    kind: "artifact.publish",
    label: "Publish artifact",
    description: "Publish a workspace file or node output as an artifact.",
    runnable: true,
  },
  {
    kind: "parallel",
    label: "Parallel",
    description: "Run independent branches (not runnable yet: M5).",
    runnable: false,
  },
  {
    kind: "join",
    label: "Join",
    description: "Wait for parallel branches (not runnable yet: M5).",
    runnable: false,
  },
  {
    kind: "gate",
    label: "Gate",
    description: "Barrier step (not runnable yet: M5).",
    runnable: false,
  },
  {
    kind: "git.commit",
    label: "Git commit",
    description: "Commit workspace changes (not runnable yet: M6).",
    runnable: false,
  },
  {
    kind: "git.publish",
    label: "Git publish",
    description: "Publish commits as a branch or PR (not runnable yet: M6).",
    runnable: false,
  },
  {
    kind: "integration.query",
    label: "Integration query",
    description: "Query an external system (not runnable yet: M6).",
    runnable: false,
  },
  {
    kind: "integration.action",
    label: "Integration action",
    description: "Act on an external system (not runnable yet: M6).",
    runnable: false,
  },
];

function labelFor(kind: string): string {
  return STEP_LIBRARY.find((s) => s.kind === kind)?.label ?? kind.replaceAll(".", " ");
}

/**
 * Minimal per-kind config that the schema accepts where possible.
 * Keys come from pipeline-v1alpha1.schema.json required lists.
 */
export function skeletonNode(kind: string): Record<string, unknown> {
  switch (kind) {
    case "agent.acp":
      return { profile: "", prompt: "" };
    case "model.chat":
      return { model: "", messages: [{ role: "user", content: "" }] };
    case "process.exec":
      return { executable: "sh", args: [] };
    case "human.approval":
      return { summary: "Approve?" };
    case "condition":
      return { cases: [{ when: "true", route: "yes" }], default: "no" };
    case "until":
      return { maxIterations: 3, passWhen: "true", body: { nodes: [] } };
    case "for_each":
      return { items: "${{ [] }}", body: { nodes: [] } };
    case "pipeline.invoke":
      return { pipeline: "" };
    case "artifact.publish":
      return { name: "artifact.md", mediaType: "text/markdown" };
    default:
      return {};
  }
}

/** review, review_2, review_3 … — unique across the whole document (all scopes). */
export function uniqueId(model: GraphModel, base: string): string {
  const taken = new Set(model.nodes.map((n) => n.id));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i += 1) {
    const candidate = `${base}_${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

// ---------------------------------------------------------------------------
// Errors + small helpers
// ---------------------------------------------------------------------------

class OpError extends Error {}
class AmbiguousOp extends Error {
  constructor(public reasons: string[]) {
    super(reasons.join("; "));
  }
}

export function scopeKey(scope: ScopePath): string {
  return scope.join("/");
}

function seqStrings(value: unknown): string[] {
  if (value == null) return [];
  const seq = value as YAMLSeq;
  if (!isSeq(seq)) return [];
  return seq.items.map((i) => String(i));
}

/** Line of a YAML error, if it reports one (1-based). */
function errorLine(err: unknown): number | null {
  const linePos = (err as { linePos?: { line: number }[] })?.linePos;
  if (Array.isArray(linePos) && linePos[0] && typeof linePos[0].line === "number") {
    return linePos[0].line + 1;
  }
  const m = String(err).match(/line (\d+)/);
  return m ? Number(m[1]) : null;
}

function parseDoc(text: string): Document | { error: string; line: number | null } {
  let doc: Document;
  try {
    doc = parseDocument(text);
  } catch (e) {
    return { error: String(e), line: errorLine(e) };
  }
  if (doc.errors.length > 0) {
    return { error: doc.errors[0].message, line: errorLine(doc.errors[0]) };
  }
  return doc;
}

// ---------------------------------------------------------------------------
// Traversal
// ---------------------------------------------------------------------------

function rootNodes(doc: Document): YAMLSeq | null {
  const root = doc.contents;
  if (!isMap(root) || root.get("kind") !== "Pipeline") return null;
  const spec = root.get("spec");
  if (!isMap(spec)) return null;
  const nodes = spec.get("nodes");
  return isSeq(nodes) ? nodes : null;
}

/** Walk the scope from spec.nodes to the node list at `scope`. */
function listAt(
  doc: Document,
  scope: ScopePath,
): { list: YAMLSeq; prefix: string } | { error: string } {
  const root = rootNodes(doc);
  if (!root) return { error: "document is not a Pipeline with spec.nodes" };
  let list: YAMLSeq = root;
  let prefix = "/spec/nodes";
  let i = 0;
  while (i < scope.length) {
    const id = scope[i];
    i += 1;
    const idx = list.items.findIndex((item) => isMap(item) && item.get("id") === id);
    if (idx < 0)
      return {
        error: `node ${id} not found in scope ${scopeKey(scope.slice(0, i - 1)) || "(root)"}`,
      };
    const node = list.items[idx] as YAMLMap;
    const cfg = node.get("config");
    if (!isMap(cfg)) return { error: `node ${id} has no config` };
    const pointer = `${prefix}/${idx}`;
    if (i < scope.length) {
      const bi = Number(scope[i]);
      i += 1;
      const branches = cfg.get("branches");
      if (!isSeq(branches) || !Number.isInteger(bi) || bi < 0 || bi >= branches.items.length) {
        return { error: `branch ${bi} of ${id} not found` };
      }
      const branch = branches.items[bi];
      if (!isMap(branch) || !isSeq(branch.get("nodes"))) {
        return { error: `branch ${bi} of ${id} has no nodes list` };
      }
      list = branch.get("nodes") as YAMLSeq;
      prefix = `${pointer}/config/branches/${bi}/nodes`;
    } else {
      const body = cfg.get("body");
      if (!isMap(body) || !isSeq(body.get("nodes"))) {
        return { error: `node ${id} has no body` };
      }
      list = body.get("nodes") as YAMLSeq;
      prefix = `${pointer}/config/body/nodes`;
    }
  }
  return { list, prefix };
}

function walk(
  list: YAMLSeq,
  scope: ScopePath,
  prefix: string,
  model: GraphModel,
  items: YAMLMap[],
): void {
  list.items.forEach((item, i) => {
    if (!isMap(item)) return;
    items.push(item);
    const id = String(item.get("id") ?? "");
    const kind = String(item.get("kind") ?? "");
    const dependsOn = seqStrings(item.get("dependsOn"));
    const when = item.get("when") != null ? String(item.get("when")) : null;
    const pointer = `${prefix}/${i}`;
    const cfg = item.get("config");
    const body = isMap(cfg) ? cfg.get("body") : undefined;
    const branches = isMap(cfg) ? cfg.get("branches") : undefined;
    const isScope =
      ((kind === "until" || kind === "for_each") && isMap(body) && isSeq(body.get("nodes"))) ||
      (kind === "parallel" && isSeq(branches));

    model.nodes.push({ id, kind, scope, pointer, dependsOn, when, isScope, label: labelFor(kind) });
    const nodeText = item.toString();

    for (const dep of dependsOn) {
      const from = model.nodes.find(
        (n) =>
          n.id === dep &&
          n.scope.length === scope.length &&
          n.scope.every((s, j) => s === scope[j]),
      );
      const kindEdge: GraphEdge["kind"] =
        from?.kind === "condition" || when ? "guarded" : "depends";
      const reasons: string[] = [];
      if (when) reasons.push(`${id} only runs when ${when}`);
      if (from?.kind === "condition") reasons.push(`${dep} is a condition; this edge is its route`);
      if (kindEdge === "depends" && nodeText.includes(`nodes.${dep}.`))
        reasons.push(`${id} reads nodes.${dep}.*`);
      model.edges.push({
        id: `${scopeKey(scope)}:${dep}->${id}`,
        from: dep,
        to: id,
        scope,
        kind: kindEdge,
        reasons,
      });
    }

    const onFailure = item.get("onFailure");
    if (isMap(onFailure) && onFailure.get("errorRoute") != null) {
      model.edges.push({
        id: `${scopeKey(scope)}:${id}->${String(onFailure.get("errorRoute"))}`,
        from: id,
        to: String(onFailure.get("errorRoute")),
        scope,
        kind: "error",
        reasons: ["error route"],
      });
    }

    if ((kind === "until" || kind === "for_each") && isMap(body) && isSeq(body.get("nodes"))) {
      walk(
        body.get("nodes") as YAMLSeq,
        [...scope, id],
        `${pointer}/config/body/nodes`,
        model,
        items,
      );
    } else if (kind === "parallel" && isSeq(branches)) {
      branches.items.forEach((branch, bi) => {
        if (isMap(branch) && isSeq(branch.get("nodes"))) {
          walk(
            branch.get("nodes") as YAMLSeq,
            [...scope, id, String(bi)],
            `${pointer}/config/branches/${bi}/nodes`,
            model,
            items,
          );
        }
      });
    }
  });
}

function modelOf(doc: Document): GraphModel | { error: string } {
  const root = rootNodes(doc);
  if (!root) return { error: "document is not a Pipeline with spec.nodes" };
  const model: GraphModel = { nodes: [], edges: [] };
  walk(root, [], "/spec/nodes", model, []);
  return model;
}

function collectItems(doc: Document, items: YAMLMap[] = []): YAMLMap[] | { error: string } {
  const root = rootNodes(doc);
  if (!root) return { error: "document is not a Pipeline with spec.nodes" };
  walk(root, [], "/spec/nodes", { nodes: [], edges: [] }, items);
  return items;
}

function nodeItem(doc: Document, id: string): YAMLMap | { error: string } {
  const items = collectItems(doc);
  if ("error" in items) return items;
  const found = items.find((item) => item.get("id") === id);
  return found ?? { error: `no node with id ${id}` };
}

export function findNode(model: GraphModel, id: string): GraphNode | undefined {
  return model.nodes.find((n) => n.id === id);
}

// ---------------------------------------------------------------------------
// parseGraph
// ---------------------------------------------------------------------------

export function parseGraph(text: string): ParseResult {
  const doc = parseDoc(text);
  if ("error" in doc) return { ok: false, error: doc.error, line: doc.line };
  const model = modelOf(doc);
  if ("error" in model) return { ok: false, error: model.error, line: null };
  return { ok: true, model };
}

// ---------------------------------------------------------------------------
// Document operations
// ---------------------------------------------------------------------------

function withDoc(text: string, fn: (doc: Document) => string[]): OpResult {
  const doc = parseDoc(text);
  if ("error" in doc) return { ok: false, error: doc.error };
  const model = modelOf(doc);
  if ("error" in model) return { ok: false, error: model.error };
  try {
    const changed = fn(doc);
    return { ok: true, text: doc.toString(), changed };
  } catch (e) {
    if (e instanceof AmbiguousOp) return { ok: false, ambiguous: true, reasons: e.reasons };
    if (e instanceof OpError) return { ok: false, error: e.message };
    throw e;
  }
}

/**
 * Append a node to the scope's node list. With `after`, the new node gets
 * dependsOn: [after] (no other node is rewired). The `after` node's own
 * scope wins over `opts.scope`: callers such as the palette pass the root
 * scope for whatever node is selected, and a selected node may live inside
 * a scope body — appending it to the root list instead would be wrong.
 */
export function addNode(
  text: string,
  opts: { kind: string; id?: string; scope: ScopePath; after?: string | null },
): OpResult {
  const base = opts.id ?? opts.kind.split(".")[0];
  return withDoc(text, (doc) => {
    const model = modelOf(doc);
    if ("error" in model) throw new OpError(model.error);
    const id = opts.id ?? uniqueId(model, base);
    if (!isValidId(id)) throw new OpError(ID_MESSAGE);
    if (model.nodes.some((n) => n.id === id)) throw new OpError(`node id ${id} is already used`);
    let scope = opts.scope;
    if (opts.after) {
      const afters = model.nodes.filter((n) => n.id === opts.after);
      if (afters.length === 0) throw new OpError(`no node with id ${opts.after}`);
      if (afters.length > 1)
        throw new AmbiguousOp([`node id ${opts.after} is not unique in the document`]);
      scope = afters[0].scope;
    }
    const at = listAt(doc, scope);
    if ("error" in at) throw new OpError(at.error);
    if (opts.after) {
      const exists = at.list.items.some((item) => isMap(item) && item.get("id") === opts.after);
      if (!exists)
        throw new OpError(`node ${opts.after} not found in scope ${scopeKey(scope) || "(root)"}`);
    }
    const node: Record<string, unknown> = { id, kind: opts.kind };
    if (opts.after) node.dependsOn = [opts.after];
    const config = skeletonNode(opts.kind);
    if (Object.keys(config).length > 0) node.config = config;
    at.list.add(doc.createNode(node) as YAMLMap);
    return [id];
  });
}

/**
 * Remove a node. Every sibling that depended on it inherits the deleted
 * node's own dependsOn (deduped). Refuses when another node's when/config
 * text references `nodes.<id>.` (the report names the offenders).
 */
export function deleteNode(text: string, id: string): OpResult {
  return withDoc(text, (doc) => {
    const model = modelOf(doc);
    if ("error" in model) throw new OpError(model.error);
    const found = model.nodes.filter((n) => n.id === id);
    if (found.length === 0) throw new OpError(`no node with id ${id}`);
    if (found.length > 1) throw new AmbiguousOp([`node id ${id} is not unique in the document`]);
    const items = collectItems(doc);
    if ("error" in items) throw new OpError(items.error);
    const referrers = items
      .filter((item) => String(item.get("id")) !== id && item.toString().includes(`nodes.${id}.`))
      .map((item) => String(item.get("id")));
    if (referrers.length > 0) {
      throw new OpError(
        `cannot delete ${id}: its outputs are referenced by ${referrers.join(", ")}`,
      );
    }
    const errorRouters = items.filter(
      (item) =>
        String(item.get("id")) !== id &&
        isMap(item.get("onFailure")) &&
        (item.get("onFailure") as YAMLMap).get("errorRoute") === id,
    );
    if (errorRouters.length > 0) {
      throw new OpError(
        `cannot delete ${id}: it is the error route of ${errorRouters.map((i) => String(i.get("id"))).join(", ")}`,
      );
    }

    const node = found[0];
    const at = listAt(doc, node.scope);
    if ("error" in at) throw new OpError(at.error);
    const idx = at.list.items.findIndex((item) => isMap(item) && item.get("id") === id);
    const removed = at.list.items[idx] as YAMLMap;
    const ownDeps = seqStrings(removed.get("dependsOn"));
    at.list.delete(idx);

    const changed: string[] = [id];
    for (const item of at.list.items) {
      if (!isMap(item)) continue;
      const deps = item.get("dependsOn");
      if (!isSeq(deps) || !deps.items.some((d) => String(d) === id)) continue;
      const next = [...new Set([...deps.items.map(String).filter((d) => d !== id), ...ownDeps])];
      if (next.length > 0) item.set("dependsOn", doc.createNode(next));
      else item.delete("dependsOn");
      changed.push(String(item.get("id")));
    }
    return changed;
  });
}

/** Sets/replaces keys under the node's `config` (value undefined deletes the key). */
export function updateConfig(text: string, id: string, patch: Record<string, unknown>): OpResult {
  return withDoc(text, (doc) => {
    const item = nodeItem(doc, id);
    if ("error" in item) throw new OpError(item.error);
    let cfg = item.get("config") as YAMLMap | undefined;
    if (!isMap(cfg)) {
      cfg = new YAMLMap();
      item.set("config", cfg);
    }
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) cfg.delete(key);
      else cfg.set(key, doc.createNode(value));
    }
    return [id];
  });
}

const NODE_FIELDS = new Set(["timeoutSeconds", "retry", "onFailure", "when", "outputs"]);

/** Sets/replaces top-level node fields (timeoutSeconds, retry, onFailure, when, outputs). */
export function updateNodeFields(
  text: string,
  id: string,
  patch: Record<string, unknown>,
): OpResult {
  return withDoc(text, (doc) => {
    const item = nodeItem(doc, id);
    if ("error" in item) throw new OpError(item.error);
    for (const [key, value] of Object.entries(patch)) {
      if (!NODE_FIELDS.has(key)) throw new OpError(`not a node field: ${key}`);
      if (value === undefined) item.delete(key);
      else item.set(key, doc.createNode(value));
    }
    return [id];
  });
}

/**
 * Rename a node. Rewrites the id, every dependsOn entry and
 * onFailure.errorRoute pointing at it, plus condition route values equal to
 * it. Refuses when `nodes.<id>.` appears in any expression (reports which
 * nodes).
 */
export function renameNode(text: string, id: string, next: string): OpResult {
  if (id === next) return { ok: true, text, changed: [] };
  return withDoc(text, (doc) => {
    const model = modelOf(doc);
    if ("error" in model) throw new OpError(model.error);
    if (!model.nodes.some((n) => n.id === id)) throw new OpError(`no node with id ${id}`);
    if (!isValidId(next)) throw new OpError(ID_MESSAGE);
    if (model.nodes.some((n) => n.id === next))
      throw new OpError(`node id ${next} is already used`);
    const items = collectItems(doc);
    if ("error" in items) throw new OpError(items.error);
    const referrers = items
      .filter((item) => item.toString().includes(`nodes.${id}.`))
      .map((item) => String(item.get("id")));
    if (referrers.length > 0) {
      throw new OpError(
        `cannot rename ${id}: nodes.${id}. is referenced in ${referrers.join(", ")}`,
      );
    }
    const changed: string[] = [];
    for (const item of items) {
      const itemId = String(item.get("id"));
      if (itemId === id) {
        item.set("id", next);
        changed.push(id);
      }
      const deps = item.get("dependsOn");
      if (isSeq(deps) && deps.items.some((d) => String(d) === id)) {
        item.set(
          "dependsOn",
          doc.createNode(deps.items.map((d) => (String(d) === id ? next : String(d)))),
        );
        changed.push(itemId);
      }
      const onFailure = item.get("onFailure");
      if (isMap(onFailure) && String(onFailure.get("errorRoute")) === id) {
        onFailure.set("errorRoute", next);
        changed.push(itemId);
      }
      const cfg = item.get("config");
      if (isMap(cfg)) {
        const cases = cfg.get("cases");
        if (isSeq(cases)) {
          for (const c of cases.items) {
            if (isMap(c) && String(c.get("route")) === id) {
              c.set("route", next);
              changed.push(itemId);
            }
          }
        }
        if (cfg.get("default") != null && String(cfg.get("default")) === id) {
          cfg.set("default", next);
          changed.push(itemId);
        }
      }
    }
    return changed;
  });
}

// ---------------------------------------------------------------------------
// Edge insertion / connect / scope wrapping
// ---------------------------------------------------------------------------

function sameScope(a: ScopePath, b: ScopePath): boolean {
  return a.length === b.length && a.every((s, j) => s === b[j]);
}

/** DFS along dependsOn edges: does `start` reach `goal` within `scope`? */
function reaches(
  model: GraphModel,
  start: string,
  goal: string,
  scope: ScopePath,
): string[] | null {
  const visited = new Set<string>();
  const dfs = (cur: string, trail: string[]): string[] | null => {
    if (cur === goal) return trail;
    if (visited.has(cur)) return null;
    visited.add(cur);
    const n = findNode(model, cur);
    if (!n || !sameScope(n.scope, scope)) return null;
    for (const dep of n.dependsOn) {
      const found = dfs(dep, [...trail, dep]);
      if (found) return found;
    }
    return null;
  };
  return dfs(start, [start]);
}

/**
 * Split an edge A→B: A→NEW→B. NEW.dependsOn = [A]; in B.dependsOn, A is
 * replaced by NEW at the same index. B's `when` and any bindings are never
 * touched. Refuses error-route edges; reports the edge's reasons as
 * ambiguity unless `acceptAmbiguity` is set.
 */
export function insertOnEdge(
  text: string,
  edge: { from: string; to: string },
  node: { kind: string; id?: string },
  opts?: { acceptAmbiguity?: boolean },
): OpResult {
  return withDoc(text, (doc) => {
    const model = modelOf(doc);
    if ("error" in model) throw new OpError(model.error);
    const src = findNode(model, edge.from);
    if (!src) throw new OpError(`no node with id ${edge.from}`);
    const edges = model.edges.filter(
      (e) => e.from === edge.from && e.to === edge.to && sameScope(e.scope, src.scope),
    );
    if (edges.length === 0) throw new OpError(`no edge ${edge.from} -> ${edge.to}`);
    if (edges.some((e) => e.kind === "error")) {
      throw new OpError("error routes cannot be split — edit the failure route in the inspector");
    }
    const target = model.nodes.find((n) => n.id === edge.to && sameScope(n.scope, src.scope));
    if (!target) throw new OpError(`no node with id ${edge.to}`);
    if (edges[0].reasons.length > 0 && !opts?.acceptAmbiguity) {
      throw new AmbiguousOp(edges[0].reasons);
    }
    const id = node.id ?? uniqueId(model, node.kind.split(".")[0]);
    if (!isValidId(id)) throw new OpError(ID_MESSAGE);
    if (model.nodes.some((n) => n.id === id)) throw new OpError(`node id ${id} is already used`);
    const at = listAt(doc, src.scope);
    if ("error" in at) throw new OpError(at.error);
    const tIdx = at.list.items.findIndex((item) => isMap(item) && item.get("id") === edge.to);
    if (tIdx < 0) throw new OpError(`no node with id ${edge.to}`);
    const targetItem = at.list.items[tIdx] as YAMLMap;
    const deps = targetItem.get("dependsOn");
    if (!isSeq(deps)) throw new OpError(`no edge ${edge.from} -> ${edge.to}`);
    const depIdx = deps.items.findIndex((d) => String(d) === edge.from);
    if (depIdx < 0) throw new OpError(`no edge ${edge.from} -> ${edge.to}`);
    deps.items[depIdx] = doc.createNode(id);
    const value: Record<string, unknown> = { id, kind: node.kind, dependsOn: [edge.from] };
    const config = skeletonNode(node.kind);
    if (Object.keys(config).length > 0) value.config = config;
    at.list.items.splice(tIdx, 0, doc.createNode(value) as YAMLMap);
    return [id, edge.to];
  });
}

/**
 * "+ after a terminal step": NEW.dependsOn = [after]. Refuses when `after`
 * already has downstream steps — the caller must pick a specific edge.
 */
export function insertAfter(
  text: string,
  after: string,
  node: { kind: string; id?: string },
): OpResult {
  return withDoc(text, (doc) => {
    const model = modelOf(doc);
    if ("error" in model) throw new OpError(model.error);
    const src = findNode(model, after);
    if (!src) throw new OpError(`no node with id ${after}`);
    const dependents = [
      ...new Set(
        model.edges
          .filter((e) => e.from === after && e.kind !== "error" && sameScope(e.scope, src.scope))
          .map((e) => e.to),
      ),
    ];
    if (dependents.length > 0) {
      throw new OpError(
        `${after} still runs into ${dependents.join(", ")} — use insertOnEdge on a specific edge`,
      );
    }
    const id = node.id ?? uniqueId(model, node.kind.split(".")[0]);
    if (!isValidId(id)) throw new OpError(ID_MESSAGE);
    if (model.nodes.some((n) => n.id === id)) throw new OpError(`node id ${id} is already used`);
    const at = listAt(doc, src.scope);
    if ("error" in at) throw new OpError(at.error);
    const idx = at.list.items.findIndex((item) => isMap(item) && item.get("id") === after);
    if (idx < 0) throw new OpError(`no node with id ${after}`);
    const value: Record<string, unknown> = { id, kind: node.kind, dependsOn: [after] };
    const config = skeletonNode(node.kind);
    if (Object.keys(config).length > 0) value.config = config;
    at.list.items.splice(idx + 1, 0, doc.createNode(value) as YAMLMap);
    return [id];
  });
}

export type ConnectCheck = { ok: true } | { ok: false; reason: string };

/** Why (not) a new edge from→to can be added. Each refusal names the cause. */
export function canConnect(model: GraphModel, from: string, to: string): ConnectCheck {
  const src = findNode(model, from);
  if (!src) return { ok: false, reason: `no node with id ${from}` };
  if (to === from) return { ok: false, reason: `a step cannot depend on itself (${from})` };
  const dst = model.nodes.find((n) => n.id === to);
  if (!dst) return { ok: false, reason: `no node with id ${to}` };
  if (!sameScope(dst.scope, src.scope)) {
    return {
      ok: false,
      reason: "steps in different scopes cannot depend on each other — connect the scope itself",
    };
  }
  if (dst.dependsOn.includes(from)) {
    return { ok: false, reason: `${from} -> ${to} is already connected` };
  }
  const path = reaches(model, from, to, src.scope);
  if (path) return { ok: false, reason: `would create a cycle: ${path.join(" -> ")}` };
  return { ok: true };
}

/** Add edge from→to by appending `from` to to.dependsOn. */
export function connect(text: string, from: string, to: string): OpResult {
  return withDoc(text, (doc) => {
    const model = modelOf(doc);
    if ("error" in model) throw new OpError(model.error);
    const check = canConnect(model, from, to);
    if (!check.ok) throw new OpError(check.reason);
    const item = nodeItem(doc, to);
    if ("error" in item) throw new OpError(item.error);
    const deps = item.get("dependsOn");
    if (isSeq(deps)) deps.add(doc.createNode(from));
    else item.set("dependsOn", doc.createNode([from]));
    return [to];
  });
}

/** Remove edge from→to by deleting `from` from to.dependsOn (key deleted when empty). */
export function disconnect(text: string, from: string, to: string): OpResult {
  return withDoc(text, (doc) => {
    const model = modelOf(doc);
    if ("error" in model) throw new OpError(model.error);
    const src = findNode(model, from);
    if (!src) throw new OpError(`no node with id ${from}`);
    const dst = model.nodes.find((n) => n.id === to && sameScope(n.scope, src.scope));
    if (!dst) throw new OpError(`no node with id ${to}`);
    if (!dst.dependsOn.includes(from)) throw new OpError(`no edge ${from} -> ${to}`);
    const item = nodeItem(doc, to);
    if ("error" in item) throw new OpError(item.error);
    const deps = item.get("dependsOn");
    if (!isSeq(deps)) throw new OpError(`no edge ${from} -> ${to}`);
    const idx = deps.items.findIndex((d) => String(d) === from);
    if (idx < 0) throw new OpError(`no edge ${from} -> ${to}`);
    deps.items.splice(idx, 1);
    if (deps.items.length === 0) item.delete("dependsOn");
    return [to];
  });
}

/**
 * Wrap sibling steps into a new `until`/`for_each` scope. The members (their
 * YAML nodes, so comments travel) move into the scope's body.nodes; edges
 * INTO the set from outside move onto the scope node; outside dependents of
 * members now depend on the scope. Refuses non-siblings, disconnected sets
 * and any outside `nodes.<member>.` reference (results of a step inside a
 * loop are only visible through the loop's resultBindings).
 */
export function wrapInScope(
  text: string,
  ids: string[],
  scope: { kind: "until" | "for_each"; id?: string },
): OpResult {
  return withDoc(text, (doc) => {
    const model = modelOf(doc);
    if ("error" in model) throw new OpError(model.error);
    if (ids.length === 0) throw new OpError("no steps to wrap");
    if (new Set(ids).size !== ids.length) throw new OpError("duplicate step ids");
    const found: GraphNode[] = [];
    for (const rawId of ids) {
      const n = model.nodes.find((n) => n.id === rawId);
      if (!n) throw new OpError(`no node with id ${rawId}`);
      if (found.length > 0 && !sameScope(n.scope, found[0].scope)) {
        throw new OpError("cannot wrap steps from different scopes in one scope");
      }
      if (n.isScope) throw new OpError(`${rawId} is itself a scope and cannot be wrapped`);
      found.push(n);
    }
    const idSet = new Set(ids);
    const adj = new Map<string, string[]>(ids.map((i) => [i, [] as string[]]));
    for (const e of model.edges) {
      if (e.kind === "error" || !idSet.has(e.from) || !idSet.has(e.to)) continue;
      adj.get(e.from)!.push(e.to);
      adj.get(e.to)!.push(e.from);
    }
    const seen = new Set([ids[0]]);
    const stack = [ids[0]];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      for (const next of adj.get(cur) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
      }
    }
    if (seen.size !== idSet.size) {
      throw new OpError("the steps to wrap are not connected to each other");
    }
    const id = scope.id ?? uniqueId(model, scope.kind.split(".")[0]);
    if (!isValidId(id)) throw new OpError(ID_MESSAGE);
    if (model.nodes.some((n) => n.id === id)) throw new OpError(`node id ${id} is already used`);
    const items = collectItems(doc);
    if ("error" in items) throw new OpError(items.error);
    const referrers = items
      .filter((item) => {
        const itemId = String(item.get("id"));
        if (idSet.has(itemId) || itemId === id) return false;
        const nodeText = item.toString();
        return ids.some((memberId) => nodeText.includes(`nodes.${memberId}.`));
      })
      .map((item) => String(item.get("id")));
    if (referrers.length > 0) {
      throw new OpError(
        `cannot wrap into ${scope.kind}: ${referrers.join(", ")} reference nodes.<member>. — ` +
          "results of a step inside a loop are only visible through the loop's resultBindings",
      );
    }
    const at = listAt(doc, found[0].scope);
    if ("error" in at) throw new OpError(at.error);
    const firstIdx = Math.min(
      ...ids.map((i) => at.list.items.findIndex((item) => isMap(item) && item.get("id") === i)),
    );
    if (firstIdx < 0) throw new OpError("no node with id " + ids[0]);
    // members in list order, so body order matches the YAML
    const members: YAMLMap[] = [];
    at.list.items.forEach((item, idx) => {
      if (isMap(item) && idSet.has(String(item.get("id")))) members.push(item);
      void idx;
    });
    if (members.length !== idSet.size) throw new OpError("not all wrapped steps were found");
    const scopeVal: Record<string, unknown> = {
      id,
      kind: scope.kind,
      config: skeletonNode(scope.kind),
    };
    const scopeItem = doc.createNode(scopeVal) as YAMLMap;
    const body = (scopeItem.get("config") as YAMLMap).get("body") as YAMLMap;
    const bodyNodes = body.get("nodes") as YAMLSeq;
    const changed: string[] = [id];
    // collect outside deps (before rewriting members), then move members in
    const outerDeps: string[] = [];
    for (const member of members) {
      const deps = member.get("dependsOn");
      if (isSeq(deps)) {
        for (const d of deps.items) {
          const s = String(d);
          if (!idSet.has(s) && !outerDeps.includes(s)) outerDeps.push(s);
        }
      }
      changed.push(String(member.get("id")));
    }
    for (const member of members) {
      const deps = member.get("dependsOn");
      if (isSeq(deps)) {
        const kept = deps.items.filter((d) => idSet.has(String(d)));
        if (kept.length < deps.items.length) {
          if (kept.length > 0) member.set("dependsOn", doc.createNode(kept));
          else member.delete("dependsOn");
        }
      }
    }
    if (outerDeps.length > 0) scopeItem.set("dependsOn", doc.createNode(outerDeps));
    // move the members into the body (in list order), then out of the outer list
    for (const member of members) bodyNodes.add(member);
    for (const member of members) {
      const idx = at.list.items.indexOf(member);
      if (idx >= 0) at.list.delete(idx);
    }
    at.list.items.splice(firstIdx, 0, scopeItem);
    // outside nodes that depended on a member now depend on the scope
    for (const item of at.list.items) {
      if (!isMap(item)) continue;
      const deps = item.get("dependsOn");
      if (!isSeq(deps) || !deps.items.some((d) => idSet.has(String(d)))) continue;
      const next = [...new Set(deps.items.map((d) => (idSet.has(String(d)) ? id : String(d))))];
      item.set("dependsOn", doc.createNode(next));
      changed.push(String(item.get("id")));
    }
    return changed;
  });
}

/**
 * Inverse of wrapInScope: the body's nodes return to the parent scope.
 * Entry nodes (no dependsOn in the body) inherit the scope's dependsOn;
 * outside dependents of the scope now depend on the body's exit nodes.
 * Refuses an empty body and any `nodes.<scopeId>.` reference.
 */
export function unwrapScope(text: string, scopeId: string): OpResult {
  return withDoc(text, (doc) => {
    const model = modelOf(doc);
    if ("error" in model) throw new OpError(model.error);
    const node = model.nodes.find((n) => n.id === scopeId);
    if (!node) throw new OpError(`no node with id ${scopeId}`);
    if (!(node.kind === "until" || node.kind === "for_each") || !node.isScope) {
      throw new OpError(`${scopeId} is not a repeat-until / for-each scope`);
    }
    const items = collectItems(doc);
    if ("error" in items) throw new OpError(items.error);
    const referrers = items
      .filter(
        (item) =>
          String(item.get("id")) !== scopeId && item.toString().includes(`nodes.${scopeId}.`),
      )
      .map((item) => String(item.get("id")));
    if (referrers.length > 0) {
      throw new OpError(
        `cannot unwrap ${scopeId}: its outputs are referenced by ${referrers.join(", ")}`,
      );
    }
    const parent = listAt(doc, node.scope);
    if ("error" in parent) throw new OpError(parent.error);
    const sIdx = parent.list.items.findIndex((i) => isMap(i) && i.get("id") === scopeId);
    if (sIdx < 0) throw new OpError(`no node with id ${scopeId}`);
    const scopeItem = parent.list.items[sIdx] as YAMLMap;
    let sPos = sIdx;
    const cfg = scopeItem.get("config");
    if (!isMap(cfg)) throw new OpError(`${scopeId} has no config`);
    const body = cfg.get("body");
    if (!isMap(body) || !isSeq(body.get("nodes"))) throw new OpError(`${scopeId} has no body`);
    const bodyNodes = body.get("nodes") as YAMLSeq;
    const members = bodyNodes.items.filter((i) => isMap(i));
    if (members.length === 0) throw new OpError(`cannot unwrap ${scopeId}: its body is empty`);
    const scopeDeps = seqStrings(scopeItem.get("dependsOn"));
    const depended = new Set<string>();
    for (const member of members) {
      for (const d of seqStrings(member.get("dependsOn"))) depended.add(d);
    }
    const exitIds = members
      .filter((m) => !depended.has(String(m.get("id"))))
      .map((m) => String(m.get("id")));
    const moved = [...members];
    bodyNodes.items.length = 0;
    for (const item of moved) {
      parent.list.items.splice(sPos, 0, item);
      sPos += 1;
    }
    parent.list.delete(sPos);
    const changed: string[] = [scopeId];
    for (const item of moved) {
      if (!isMap(item)) continue;
      changed.push(String(item.get("id")));
      if (seqStrings(item.get("dependsOn")).length === 0 && scopeDeps.length > 0) {
        item.set("dependsOn", doc.createNode(scopeDeps));
      }
    }
    // outside dependents of the scope now depend on the body's exit nodes
    for (const item of parent.list.items) {
      if (!isMap(item)) continue;
      const deps = item.get("dependsOn");
      if (!isSeq(deps) || !deps.items.some((d) => String(d) === scopeId)) continue;
      const flat: string[] = [];
      for (const d of deps.items) {
        if (String(d) === scopeId) flat.push(...exitIds);
        else flat.push(String(d));
      }
      item.set("dependsOn", doc.createNode([...new Set(flat)]));
      changed.push(String(item.get("id")));
    }
    return changed;
  });
}

/**
 * Move a node into a scope's body. Only allowed for a node with no edges in
 * its current scope (and nothing referencing nodes.<id>.), so no rewiring
 * is needed.
 */
export function moveIntoScope(text: string, id: string, scopeId: string): OpResult {
  return withDoc(text, (doc) => {
    const model = modelOf(doc);
    if ("error" in model) throw new OpError(model.error);
    const node = model.nodes.find((n) => n.id === id);
    if (!node) throw new OpError(`no node with id ${id}`);
    const target = model.nodes.find((n) => n.id === scopeId);
    if (!target) throw new OpError(`no node with id ${scopeId}`);
    if (!(target.kind === "until" || target.kind === "for_each") || !target.isScope) {
      throw new OpError(`${scopeId} is not a repeat-until / for-each scope`);
    }
    const edges = model.edges.filter(
      (e) => (e.from === id || e.to === id) && sameScope(e.scope, node.scope),
    );
    if (edges.length > 0) {
      throw new OpError(
        `${id} still has edges in its current scope (${edges
          .map((e) => `${e.from} -> ${e.to}`)
          .join("; ")}) — only an isolated step can be moved`,
      );
    }
    const items = collectItems(doc);
    if ("error" in items) throw new OpError(items.error);
    const referrers = items
      .filter((item) => String(item.get("id")) !== id && item.toString().includes(`nodes.${id}.`))
      .map((item) => String(item.get("id")));
    if (referrers.length > 0) {
      throw new OpError(`cannot move ${id}: its outputs are referenced by ${referrers.join(", ")}`);
    }
    const from = listAt(doc, node.scope);
    if ("error" in from) throw new OpError(from.error);
    const idx = from.list.items.findIndex((i) => isMap(i) && i.get("id") === id);
    if (idx < 0) throw new OpError(`no node with id ${id}`);
    const item = from.list.items[idx] as YAMLMap;
    const to = listAt(doc, [...target.scope, target.id]);
    if ("error" in to) throw new OpError(to.error);
    if (to.list.items.some((i) => isMap(i) && i.get("id") === id)) {
      throw new OpError(`the body of ${scopeId} already has a node with id ${id}`);
    }
    from.list.delete(idx);
    to.list.add(item);
    return [id];
  });
}
