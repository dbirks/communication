/**
 * The Run Workbench's pure mapping from a run's node executions onto the
 * definition graph (ADR-0043, design §6).
 *
 * The graph draws the DEFINITION topology — one box per definition node — and
 * this module decides what each box says: which status overlay the box wears
 * and WHICH runtime instance (loop iteration, for_each item, attempt) the dock
 * should open. Runtime instances are never drawn as extra nodes; they are
 * chosen through a `ScopeSelection` keyed by the scope's definition key
 * (`/build_until_verified`, `/build_until_verified/fan_out` for a nested
 * loop).
 *
 * No new state vocabulary: every state comes from the shared
 * `NODE_EXECUTION_STATE` mapping and the `StateName` sets in `ds/states`, and
 * every key is parsed with `runView.ts`'s helpers. `branches.ts` supplies the
 * for_each item roll-ups.
 */
import { NODE_EXECUTION_STATE, STATES, type StateName } from "../../components/ds/states";
import { branchesOf } from "./branches";
import { definitionKeyOf } from "./runView";
import type { NodeExecutionSummary, RunTreeChild, RunTreeRoot } from "./contract";

/**
 * Which instance of each scope the dock and the overlays resolve to.
 * Keyed by the scope's DEFINITION key (the scope's instance key with no
 * `[n]` suffix); the value is a 1-based iteration/item. Absent means
 * "latest" for `until`, "all (aggregate)" for `for_each`.
 */
export interface ScopeSelection {
  [scopeDefinitionKey: string]: number;
}

/** What a definition node's graph box shows. */
export interface Overlay {
  /** The shared state set (identity rule 06: state + word, never color alone). */
  state: StateName;
  /** "running", "succeeded", "iteration 2 of 4", "25 items: …", "attempt 2 of 3 · …". */
  label: string;
  /** The node execution the dock opens for this box under the selection; null for
   * aggregates and for nodes that have not started. */
  executionId: string | null;
}

/** One selectable instance of a scope (iteration chip / item list row). */
export interface ScopeInstance {
  /** 1-based index. */
  index: number;
  /** The place key `/scope[2]`. */
  key: string;
  state: StateName;
  label: string;
}

/** The workbench's deep-linkable URL state (ADR-0043 decision 6). */
export interface WorkbenchUrlState {
  node: string | null;
  instance: string | null;
  attempt: number | null;
  view: "graph" | "timeline" | "tree" | "diagnostics";
  scopes: ScopeSelection;
}

/** The `for_each` roll-up precedence — the same order `branches.ts` uses, so
 * the box and the item grid can never disagree about who needs a person first. */
const PRECEDENCE: readonly StateName[] = [
  "failed",
  "waiting",
  "interrupted",
  "retrying",
  "running",
  "queued",
  "done",
  "info",
];

/** Scope kinds whose rows carry 1-based `[n]` iteration/item indexes. */
const SCOPE_KINDS = new Set(["until", "for_each", "parallel"]);

const VIEWS: readonly WorkbenchUrlState["view"][] = ["graph", "timeline", "tree", "diagnostics"];

/** One path segment: `build_until_verified[2]` → `{ id, index: 2 }`. */
interface Segment {
  id: string;
  index: number | null;
}

function parseKey(key: string): Segment[] {
  return key
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      const match = /^(.*)\[(\d+)\]$/.exec(segment);
      return match ? { id: match[1], index: Number(match[2]) } : { id: segment, index: null };
    });
}

/**
 * Every scope ancestor of an instance key, innermost last:
 * `/loop[2]/fan[3]/job` → `/loop` (2), `/loop/fan` (3).
 */
function scopeAncestors(key: string): { defKey: string; index: number }[] {
  const segments = parseKey(key);
  const out: { defKey: string; index: number }[] = [];
  const ids: string[] = [];
  for (const segment of segments) {
    ids.push(segment.id);
    if (segment.index !== null) out.push({ defKey: `/${ids.join("/")}`, index: segment.index });
  }
  return out;
}

/** The `[n]` index of a row's path under one scope's definition key, or null. */
function indexIn(key: string, defKey: string): number | null {
  return scopeAncestors(key).find((ancestor) => ancestor.defKey === defKey)?.index ?? null;
}

/** The scope's own kind. A nested scope never has a row keyed by its bare
 * definition key, so the kind is read from any of its rows (every row of a
 * node carries the node's kind). */
function scopeKindOf(nodes: readonly NodeExecutionSummary[], defKey: string): string | null {
  return nodes.find((row) => definitionKeyOf(row.node_instance_key) === defKey)?.kind ?? null;
}

/**
 * `/build_until_verified[2]/implement` → `implement`; `/fan_out[14]` →
 * `fan_out`: the last path segment without its loop suffix.
 */
export function definitionIdOfKey(instanceKey: string): string {
  const leaf = parseKey(instanceKey).at(-1);
  return leaf ? leaf.id : "";
}

/** The word the box carries for one row — the status itself where it reads
 * (a `skipped` node and a `queued` node are the same colour, different words);
 * `pending` has not started, `ready`/`leased` already read as running. */
function wordFor(row: NodeExecutionSummary): string {
  if (row.status === "pending") return "not started";
  if (row.status === "waiting")
    return row.waiting_reason === "approval" ? "waiting for approval" : "waiting";
  if (row.status === "ready" || row.status === "leased") return "running";
  return row.status;
}

/** "attempt k of m · …" when the row is past its first attempt, else the word. */
function labelOf(row: NodeExecutionSummary): string {
  return row.attempt_count > 1
    ? `attempt ${row.attempt_count} of ${row.attempt_limit} · ${wordFor(row)}`
    : wordFor(row);
}

function stateOfRow(row: NodeExecutionSummary): StateName {
  return NODE_EXECUTION_STATE[row.status] ?? "queued";
}

/** The newest row: an unfinished (live) row outranks finished ones — it is
 * the work's live edge — then `finished_at`, then `ready_at`, then the key,
 * so SSE and REST re-derive the same "latest". */
function newestOf(rows: readonly NodeExecutionSummary[]): NodeExecutionSummary | null {
  if (rows.length === 0) return null;
  return (
    [...rows]
      .sort(
        (a, b) =>
          (b.finished_at ?? b.ready_at ?? "\uffff").localeCompare(
            a.finished_at ?? a.ready_at ?? "\uffff",
          ) || a.node_instance_key.localeCompare(b.node_instance_key),
      )
      .at(-1) ?? null
  );
}

/** The overlay for one definition node's rows. */
function overlayFor(
  rows: readonly NodeExecutionSummary[],
  all: readonly NodeExecutionSummary[],
  selection: ScopeSelection,
): Overlay {
  const first = rows[0];
  if (first === undefined) return { state: "queued", label: "not started", executionId: null };
  return SCOPE_KINDS.has(first.kind)
    ? scopeOverlay(rows, all, selection)
    : bodyOverlay(rows, all, selection);
}

/**
 * A body node under zero or more scopes. Every scope ancestor resolves to an
 * index (selection, else the newest iteration for `until`); an unselected
 * `for_each` ancestor instead collapses to the aggregate box (counts by
 * state, no single instance). A node with no execution under the resolved
 * selection has not started.
 */
function bodyOverlay(
  rows: readonly NodeExecutionSummary[],
  all: readonly NodeExecutionSummary[],
  selection: ScopeSelection,
): Overlay {
  const sample = rows[0];
  if (sample === undefined) return { state: "queued", label: "not started", executionId: null };
  const ancestors = scopeAncestors(sample.node_instance_key);
  const resolved: { defKey: string; index: number }[] = [];
  let aggregate: { defKey: string } | null = null;
  for (const ancestor of ancestors) {
    if (scopeKindOf(all, ancestor.defKey) === "for_each") {
      const chosen = selection[ancestor.defKey];
      if (chosen === undefined) {
        aggregate = { defKey: ancestor.defKey };
        continue;
      }
      resolved.push({ defKey: ancestor.defKey, index: chosen });
      continue;
    }
    const chosen = selection[ancestor.defKey] ?? maxIndexIn(all, ancestor.defKey);
    if (chosen === null) continue;
    resolved.push({ defKey: ancestor.defKey, index: chosen });
  }

  const matches = (row: NodeExecutionSummary): boolean =>
    resolved.every((place) => indexIn(row.node_instance_key, place.defKey) === place.index);

  if (aggregate !== null) {
    const candidates = rows.filter(matches);
    const head = all.find((row) => row.node_instance_key === aggregate.defKey);
    const total = Math.max(
      head?.items ?? 0,
      ...candidates.map((row) => indexIn(row.node_instance_key, aggregate.defKey) ?? 0),
    );
    const counts = new Map<StateName, number>();
    for (const row of candidates)
      counts.set(stateOfRow(row), (counts.get(stateOfRow(row)) ?? 0) + 1);
    const parts = PRECEDENCE.filter((state) => counts.has(state)).map(
      (state) => `${counts.get(state)} ${STATES[state].glyph} ${STATES[state].word}`,
    );
    const state =
      PRECEDENCE.find((candidate) => candidates.some((row) => stateOfRow(row) === candidate)) ??
      "queued";
    return {
      state,
      label: candidates.length === 0 ? `${total} items` : `${total} items: ${parts.join(" · ")}`,
      executionId: null,
    };
  }

  const chosen = newestOf(rows.filter(matches));
  if (chosen === null) return { state: "queued", label: "not started", executionId: null };
  return { state: stateOfRow(chosen), label: labelOf(chosen), executionId: chosen.id };
}

/** The highest `[n]` index any row of this node carries under `defKey`, or null. */
function maxIndexIn(rows: readonly NodeExecutionSummary[], defKey: string): number | null {
  let max = 0;
  for (const row of rows) {
    const index = indexIn(row.node_instance_key, defKey);
    if (index !== null && index > max) max = index;
  }
  return max > 0 ? max : null;
}

/**
 * The scope box itself: `iteration i of max` (until) or `item i of N` /
 * `N items` (for_each). A nested scope has one row per outer context
 * (`/loop[1]/fan` and `/loop[2]/fan`), so the outer selection resolves which
 * context speaks; the box's state is the selected place row's state where the
 * journal has one, else the worst of the context's children, else the context
 * row's own status.
 */
function scopeOverlay(
  rows: readonly NodeExecutionSummary[],
  all: readonly NodeExecutionSummary[],
  selection: ScopeSelection,
): Overlay {
  const first = rows[0];
  if (first === undefined) return { state: "queued", label: "not started", executionId: null };
  const defKey = definitionKeyOf(first.node_instance_key);
  const scopeRows = rows.filter((row) => definitionKeyOf(row.node_instance_key) === defKey);

  // Outer contexts: the scope's own ancestors (everything except `defKey`),
  // resolved like a body node — selection first, else the newest until index.
  const outer = new Map<string, number>();
  for (const row of scopeRows)
    for (const ancestor of scopeAncestors(row.node_instance_key))
      if (ancestor.defKey !== defKey)
        outer.set(ancestor.defKey, Math.max(outer.get(ancestor.defKey) ?? 0, ancestor.index));
  const resolved: { defKey: string; index: number }[] = [...outer.entries()].map(
    ([defKeyKey, max]) => ({
      defKey: defKeyKey,
      index: selection[defKeyKey] ?? max,
    }),
  );
  const contextRows = scopeRows.filter((row) =>
    resolved.every((place) => indexIn(row.node_instance_key, place.defKey) === place.index),
  );
  const context = newestOf(contextRows);
  // Rows under this scope in this context: their key carries a `[n]` on the
  // scope segment (place rows and children alike).
  const children = all.filter(
    (row) =>
      indexIn(row.node_instance_key, defKey) !== null &&
      resolved.every((place) => indexIn(row.node_instance_key, place.defKey) === place.index),
  );
  const placeIndex = (index: number | null): NodeExecutionSummary | undefined =>
    index === null
      ? undefined
      : (contextRows.find((row) => indexIn(row.node_instance_key, defKey) === index) ??
        children.find((row) => indexIn(row.node_instance_key, defKey) === index));

  if (first.kind === "for_each") {
    const total = Math.max(
      context?.items ?? 0,
      ...children.map((row) => indexIn(row.node_instance_key, defKey) ?? 0),
    );
    const chosen = selection[defKey];
    // An item selected: the box describes that item; nothing selected: the
    // box describes the whole for_each (counts, worst state).
    const described =
      chosen !== undefined
        ? children.filter((row) => indexIn(row.node_instance_key, defKey) === chosen)
        : children;
    return {
      state: rollupOf(described.map(stateOfRow), context ? stateOfRow(context) : null),
      label: chosen !== undefined ? `item ${chosen} of ${total}` : `${total} items`,
      executionId: placeIndex(chosen)?.id ?? context?.id ?? null,
    };
  }

  const observed = Math.max(
    0,
    ...children.map((row) => indexIn(row.node_instance_key, defKey) ?? 0),
  );
  const maxIterations = Math.max(context?.iterations ?? 0, observed);
  const index = selection[defKey] ?? (observed > 0 ? observed : 1);
  const place = placeIndex(index);
  const iterationChildren = children.filter(
    (row) => indexIn(row.node_instance_key, defKey) === index,
  );
  return {
    state: rollupOf(
      place
        ? [stateOfRow(place), ...iterationChildren.map(stateOfRow)]
        : iterationChildren.map(stateOfRow),
      context ? stateOfRow(context) : null,
    ),
    label: `iteration ${index} of ${Math.max(maxIterations, index)}`,
    executionId: place?.id ?? context?.id ?? null,
  };
}

/** `PRECEDENCE` roll-up over states, falling back to the head row's state. */
function rollupOf(states: readonly StateName[], headState: StateName | null): StateName {
  const found = PRECEDENCE.find((state) => states.includes(state));
  return found ?? headState ?? "queued";
}

/**
 * One overlay per definition node id: the definition topology's boxes, each
 * resolved through `selection`.
 */
export function overlays(
  nodes: NodeExecutionSummary[],
  selection: ScopeSelection,
): Record<string, Overlay> {
  const byNode = new Map<string, NodeExecutionSummary[]>();
  for (const row of nodes) {
    const rows = byNode.get(row.node_id) ?? [];
    rows.push(row);
    byNode.set(row.node_id, rows);
  }
  const out: Record<string, Overlay> = {};
  for (const [nodeId, rows] of byNode) out[nodeId] = overlayFor(rows, nodes, selection);
  return out;
}

/**
 * The selector's options for a scope: iterations for `until`, items for
 * `for_each` (via `branchesOf` for a top-level scope, so the chips and the
 * item grid agree; nested scopes read their item indexes straight off the
 * keys). Declared `iterations`/`items` fill the gaps with `queued`.
 */
export function scopeInstances(
  nodes: NodeExecutionSummary[],
  scopeDefinitionKey: string,
): ScopeInstance[] {
  const scopeRows = nodes.filter(
    (row) => definitionKeyOf(row.node_instance_key) === scopeDefinitionKey,
  );
  const kind = scopeRows[0]?.kind ?? null;

  if (kind === "for_each") {
    const topHead = scopeRows.find((row) => row.node_instance_key === scopeDefinitionKey);
    if (topHead !== undefined) {
      const branches = branchesOf(nodes, scopeDefinitionKey);
      const total = Math.max(topHead.items ?? 0, branches.length);
      return branches.map((branch): ScopeInstance => ({
        index: branch.index,
        key: branch.key,
        state: branch.state,
        label: `item ${branch.index} of ${total}`,
      }));
    }
    const items = itemInstances(nodes, scopeDefinitionKey);
    const total = Math.max(...items.keys(), 0);
    const out: ScopeInstance[] = [];
    for (let index = 1; index <= total; index += 1)
      out.push({
        index,
        key: `${scopeDefinitionKey}[${index}]`,
        state: "queued",
        label: `item ${index} of ${total}`,
      });
    return out;
  }

  const out: ScopeInstance[] = [];
  const max = Math.max(
    ...scopeRows.map((row) => row.iterations ?? 0),
    ...nodes.map((row) => indexIn(row.node_instance_key, scopeDefinitionKey) ?? 0),
    0,
  );
  for (let index = 1; index <= max; index += 1) {
    const place = nodes.find((row) => indexIn(row.node_instance_key, scopeDefinitionKey) === index);
    const children = nodes.filter(
      (row) => indexIn(row.node_instance_key, scopeDefinitionKey) === index,
    );
    const state = rollupOf(children.map(stateOfRow), place ? stateOfRow(place) : null);
    out.push({
      index,
      key: `${scopeDefinitionKey}[${index}]`,
      state,
      label: `iteration ${index} of ${max}`,
    });
  }
  return out;
}

/** Every item index under a scope, with the roll-up state of that item's rows. */
function itemInstances(nodes: NodeExecutionSummary[], defKey: string): Map<number, StateName> {
  const items = new Map<number, StateName>();
  for (const row of nodes) {
    const index = indexIn(row.node_instance_key, defKey);
    if (index === null || index < 1) continue;
    const found = items.get(index);
    items.set(
      index,
      found === undefined ? stateOfRow(row) : rollupOf([found, stateOfRow(row)], null),
    );
  }
  return items;
}

/**
 * Every execution of one definition node across iterations/items, newest
 * first — the dock's instance list for a selected node.
 */
export function instancesOfNode(
  nodes: NodeExecutionSummary[],
  definitionNodeId: string,
): NodeExecutionSummary[] {
  return [...nodes]
    .filter((row) => row.node_id === definitionNodeId)
    .sort(
      (a, b) =>
        (b.finished_at ?? b.ready_at ?? "\uffff").localeCompare(
          a.finished_at ?? a.ready_at ?? "\uffff",
        ) || b.node_instance_key.localeCompare(a.node_instance_key),
    );
}

/**
 * The node to auto-select on load (ADR-0043 decision 4): an approval wait,
 * then a failure, then an interruption, then the running work — scope rows
 * are skipped because they own no attempt of their own. Returns the scope
 * selection that shows the pick (its instance's iteration/item indexes).
 */
export function attentionNode(
  nodes: NodeExecutionSummary[],
): { definitionNodeId: string; executionId: string; selection: ScopeSelection } | null {
  const work = nodes.filter((row) => !SCOPE_KINDS.has(row.kind));
  const pick =
    work.find(
      (row) =>
        row.status === "waiting" &&
        (row.kind === "human.approval" || row.waiting_reason === "approval"),
    ) ??
    work.find((row) => row.status === "failed") ??
    work.find((row) => row.status === "interrupted") ??
    work.find((row) => row.status === "running");
  if (!pick) return null;
  const selection: ScopeSelection = {};
  for (const ancestor of scopeAncestors(pick.node_instance_key))
    selection[ancestor.defKey] = ancestor.index;
  return { definitionNodeId: pick.node_id, executionId: pick.id, selection };
}

/**
 * The child run one invoking execution produced, through the run tree: the
 * row whose `node_instance_key` is the invocation's own key. The tree is a
 * recursive row list, so the search walks it; `null` until the invocation
 * has actually produced a child run (the dock says so instead of guessing).
 */
export function childRunOf(tree: RunTreeRoot | null, nodeInstanceKey: string): RunTreeChild | null {
  const find = (children: readonly RunTreeChild[]): RunTreeChild | null => {
    for (const child of children) {
      if (child.node_instance_key === nodeInstanceKey) return child;
      const deeper = find(child.children ?? []);
      if (deeper !== null) return deeper;
    }
    return null;
  };
  return tree ? find(tree.children) : null;
}

/** `?node=…&instance=…&attempt=…&view=…&scope=/a:2,/b/c:14` → state. */
export function parseWorkbenchUrl(search: URLSearchParams): WorkbenchUrlState {
  const attemptRaw = search.get("attempt");
  const attempt =
    attemptRaw !== null && attemptRaw !== "" && Number.isInteger(Number(attemptRaw))
      ? Number(attemptRaw)
      : null;
  const viewRaw = search.get("view");
  const view = VIEWS.includes(viewRaw as WorkbenchUrlState["view"])
    ? (viewRaw as WorkbenchUrlState["view"])
    : "graph";
  const scopes: ScopeSelection = {};
  const scopeRaw = search.get("scope");
  if (scopeRaw !== null) {
    for (const part of scopeRaw.split(",")) {
      const at = part.lastIndexOf(":");
      if (at <= 0) continue;
      const key = part.slice(0, at);
      const index = Number(part.slice(at + 1));
      if (!Number.isInteger(index) || index < 1) continue;
      scopes[key] = index;
    }
  }
  return {
    node: search.get("node"),
    instance: search.get("instance"),
    attempt,
    view,
    scopes,
  };
}

/** Inverse of `parseWorkbenchUrl`; omits defaults (`view=graph`, empty fields). */
export function workbenchSearch(state: WorkbenchUrlState): string {
  const parts: string[] = [];
  if (state.node !== null) parts.push(`node=${encodeURIComponent(state.node)}`);
  if (state.instance !== null) parts.push(`instance=${encodeURIComponent(state.instance)}`);
  if (state.attempt !== null) parts.push(`attempt=${state.attempt}`);
  if (state.view !== "graph") parts.push(`view=${state.view}`);
  const scopeParts = Object.entries(state.scopes)
    .filter(([, index]) => Number.isInteger(index) && index >= 1)
    .map(([key, index]) => `${encodeURIComponent(key)}:${index}`);
  if (scopeParts.length > 0) parts.push(`scope=${scopeParts.join(",")}`);
  return parts.join("&");
}
