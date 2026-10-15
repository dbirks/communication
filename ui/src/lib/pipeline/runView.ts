/**
 * Projections from run rows (`node_executions`) onto the definition graph and
 * the stage strip. Both need the same two answers — which definition node a row
 * belongs to, and what one node means when it has many rows — and the answers
 * have to be identical in both places or the strip and the graph disagree about
 * the same run.
 */
import type { NodeExecutionSummary } from "./contract";

/**
 * The definition node an instance row belongs to: `node_instance_key` without
 * the loop suffix. `/build_until_verified[2]/review` → `build_until_verified/review`.
 * A key with no suffix is already one.
 */
export function definitionKeyOf(instanceKey: string): string {
  return instanceKey.replace(/\[\d+\]/g, "");
}

/**
 * The parent of an instance key: `/build_until_verified[1]/implement` →
 * `/build_until_verified[1]`, `/verify_each[3]` → `/verify_each`, `/plan` → `/`.
 * The `[n]` suffix rides on the node segment it belongs to, so removing it is
 * what moves up one level — which is why the tree's shape can be read out of the
 * keys alone (01 invariant 6) instead of a `scope_key` that only names a row.
 */
export function parentKeyOf(instanceKey: string): string {
  const leaf = instanceKey.split("/").filter(Boolean).pop() ?? "";
  const suffix = /\[\d+\]$/.exec(leaf);
  if (suffix) return instanceKey.slice(0, instanceKey.length - suffix[0].length);
  const parts = instanceKey.split("/").filter(Boolean);
  parts.pop();
  return parts.length > 0 ? `/${parts.join("/")}` : "/";
}

/**
 * The iteration a row belongs to, or `null` when it is not a loop body row.
 * The suffix rides on the *scope* segment (`/x[2]/review`), so it is read from
 * the leaf first and then from the scope that contains it — one rule, shared by
 * the tree label, the attempt panel and the graph.
 */
export function iterationOf(instanceKey: string): number | null {
  const parts = instanceKey.split("/").filter(Boolean);
  const leaf = parts[parts.length - 1] ?? "";
  const source = parts.length > 1 ? (parts[parts.length - 2] ?? "") : leaf;
  const match = /\[(\d+)\]$/.exec(leaf.includes("[") ? leaf : source);
  return match ? Number(match[1]) : null;
}

/**
 * One state per definition node, for the graph's current-node marker.
 *
 * A body node has one row per iteration, so "worst of them all" would be a lie:
 * a loop that failed its first pass and passed its second has moved on, and a
 * node painted `failed` would say the run is somewhere it is not. The rule is
 * therefore the loop's own (03 § 3 — an iteration ends, the next begins):
 *
 * 1. if any iteration is still open (`pending`…`waiting`), the node is there, and
 *    the worst of those open states wins, because two open iterations differ in
 *    what is blocked;
 * 2. otherwise the **highest iteration** speaks — the loop's live edge — and a
 *    node outside a scope has exactly one row anyway.
 *
 * The states are the wire enum verbatim (`09`'s node_executions.status): there is
 * no `blocked` or `waiting_human` at node level, and inventing one would put a
 * state on the graph the API can never send.
 */
export function rollupStatuses(
  nodes: readonly NodeExecutionSummary[],
): Record<string, NodeExecutionSummary["status"]> {
  const byKey = new Map<string, NodeExecutionSummary[]>();
  for (const node of nodes) {
    const key = definitionKeyOf(node.node_instance_key);
    const rows = byKey.get(key);
    if (rows) rows.push(node);
    else byKey.set(key, [node]);
  }

  const out: Record<string, NodeExecutionSummary["status"]> = {};
  for (const [key, rows] of byKey) {
    const open = rows.filter((row) => OPEN_STATUSES.has(row.status));
    if (open.length > 0) {
      out[key] = open.reduce(
        (worst, row) => worse(worst, row.status),
        open[0]?.status ?? "pending",
      );
      continue;
    }
    const latest = rows.reduce(
      (ahead, row) =>
        (iterationOf(row.node_instance_key) ?? 0) > (iterationOf(ahead.node_instance_key) ?? 0)
          ? row
          : ahead,
      rows[0] as NodeExecutionSummary,
    );
    out[key] = latest.status;
  }
  return out;
}

/** A node that has not reached an end state — the run is still at it. */
const OPEN_STATUSES = new Set<NodeExecutionSummary["status"]>([
  "pending",
  "ready",
  "leased",
  "running",
  "waiting",
]);

/** Worst first: of two open iterations, the more blocked one describes the node. */
const PRIORITY: readonly NodeExecutionSummary["status"][] = [
  "waiting",
  "running",
  "leased",
  "ready",
  "pending",
  "succeeded",
  "failed",
  "interrupted",
  "cancelled",
  "skipped",
];

function worse(
  a: NodeExecutionSummary["status"],
  b: NodeExecutionSummary["status"],
): NodeExecutionSummary["status"] {
  return PRIORITY.indexOf(a) <= PRIORITY.indexOf(b) ? a : b;
}
