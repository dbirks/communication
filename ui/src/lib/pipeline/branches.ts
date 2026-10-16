/**
 * The branch grid's data: one branch per item of a `for_each` scope (or per
 * iteration of an `until` scope), each with the ordered history of every node
 * execution that ran inside it.
 *
 * The identity of a branch is textual, exactly as `01` invariant 6 defines it:
 * the `[n]` suffix riding on the scope segment of `node_instance_key`. All
 * scope parsing goes through `runView.ts`'s helpers (`definitionKeyOf`,
 * `iterationOf`, `parentKeyOf`) so the grid, the stage strip and the tree never
 * disagree about which loop a row belongs to.
 *
 * States are the shared `NODE_EXECUTION_STATE` set, never a local colour:
 * handoff rule 06 (a colour always carries its glyph and its word).
 */
import { NODE_EXECUTION_STATE, type StateName } from "../../components/ds/states";
import { definitionKeyOf, iterationOf } from "./runView";
import type { NodeExecutionSummary } from "./contract";

/** One chip in the selected branch's history strip. */
export interface BranchStep {
  /** The execution this chip reports, verbatim — the caller keys React on it. */
  key: string;
  /** Definition node id (the key's leaf without its loop suffix): `implement`. */
  nodeId: string;
  state: StateName;
  /** Which pass of a loop nested inside the branch this row is (1 = first). */
  pass: number;
  /** True when `pass` must be spelled out on the chip (`impl #2`). */
  repeated: boolean;
  /** Short reason a failed chip shows next to its glyph, or null. */
  reason: string | null;
  /** Rows carry `attempt_count`; the strip's "att 2" reads it off the branch. */
  attempts: number;
}

/** One branch = one `[n]` place of the scope. */
export interface Branch {
  /** 1-based item index — the number in the cell. */
  index: number;
  /** The place key `/verify_each[14]`, present or inferred. */
  key: string;
  state: StateName;
  /** Needs a person: `waiting` or `failed` (see `STUCK_STATES`). */
  stuck: boolean;
  /** Attempts across the branch's rows — the table's "ATT" column. */
  attempts: number;
  /** Every body execution, in the order the branch ran them. */
  steps: BranchStep[];
}

/** Cell order: the design's `stuck first | by number` toggle. */
export type BranchSort = "stuck" | "number";

/** A branch that has not finished and cannot proceed on its own. */
const STUCK_STATES = new Set<StateName>(["waiting", "failed"]);

/** Roll-up precedence: the state a person must act on names the branch. */
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

/**
 * Split `key` into the branch it belongs to under `scope` and the path inside
 * that branch: `/verify_each[14]/invoke` → `{ index: 14, rest: '/invoke' }`.
 * `rest` is `''` for the place row itself. Null when the row is not inside the
 * scope at all.
 */
export function branchPlaceOf(key: string, scope: string): { index: number; rest: string } | null {
  const prefix = `${scope}[`;
  if (!key.startsWith(prefix)) return null;
  const close = key.indexOf("]", prefix.length);
  if (close < 0) return null;
  const index = Number(key.slice(prefix.length, close));
  if (!Number.isInteger(index) || index < 1) return null;
  return { index, rest: key.slice(close + 1) };
}

/** The innermost `[n]` of the path *inside* a branch — a nested loop's pass. */
function passOfRest(rest: string): number {
  // The suffix lives on the segment that repeats, so `iterationOf`'s own rule
  // (leaf first, then the scope containing it) reads it once the branch's own
  // suffix has been taken off the front.
  const iteration = iterationOf(rest.replace(/^\//, ""));
  return iteration === null || iteration < 1 ? 1 : iteration;
}

/** The failed chip's short reason: why, in as few words as the row knows. */
function reasonOf(row: NodeExecutionSummary): string | null {
  if (NODE_EXECUTION_STATE[row.status] !== "failed") return null;
  return row.failed_cause ?? row.error_class ?? null;
}

/**
 * Branches of `scope` (a scope node's `node_instance_key`, e.g.
 * `/verify_each`), in index order.
 *
 * A branch exists for every index the rows show *and* for every index the scope
 * declared but has not reached (`items`/`iterations`) — those are `queued` with
 * no history, which is the honest answer for branch 24 of 25 rather than a cell
 * that is not drawn at all.
 */
export function branchesOf(
  nodes: readonly NodeExecutionSummary[],
  scope: string,
  definitionOrder?: readonly string[],
): Branch[] {
  const grouped = new Map<number, NodeExecutionSummary[]>();
  for (const row of nodes) {
    const place = branchPlaceOf(row.node_instance_key, scope);
    if (!place) continue;
    const rows = grouped.get(place.index) ?? [];
    rows.push(row);
    grouped.set(place.index, rows);
  }

  const head = nodes.find((row) => row.node_instance_key === scope);
  const declared = Math.max(head?.items ?? 0, head?.iterations ?? 0);
  const indexes = [...new Set([...grouped.keys(), ...range(1, declared)])].sort((a, b) => a - b);

  return indexes.map((index) => {
    const rows = grouped.get(index) ?? [];
    const states = rows.map((row) => NODE_EXECUTION_STATE[row.status] ?? "queued");
    const body = rows.filter((row) => branchPlaceOf(row.node_instance_key, scope)?.rest !== "");
    const passes = new Map<string, number>();
    const steps = body
      .map((row) => {
        const rest = branchPlaceOf(row.node_instance_key, scope)?.rest ?? "";
        const nodeId = definitionKeyOf(rest).split("/").filter(Boolean).pop() ?? row.node_id;
        const pass = passOfRest(rest);
        passes.set(nodeId, Math.max(passes.get(nodeId) ?? 1, pass));
        return { row, nodeId, pass };
      })
      .sort(
        (a, b) =>
          a.pass - b.pass ||
          rankOf(a.nodeId, definitionOrder) - rankOf(b.nodeId, definitionOrder) ||
          a.row.node_instance_key.localeCompare(b.row.node_instance_key),
      )
      .map(({ row, nodeId, pass }): BranchStep => ({
        key: row.node_instance_key,
        nodeId,
        state: NODE_EXECUTION_STATE[row.status] ?? "queued",
        pass,
        repeated: (passes.get(nodeId) ?? 1) > 1 && pass > 1,
        reason: reasonOf(row),
        attempts: row.attempt_count,
      }));
    // A branch nobody has started has no rows at all — `queued` is the honest
    // answer, and the `items`/`iterations` count is what puts the cell there.
    const state = PRECEDENCE.find((candidate) => states.includes(candidate)) ?? "queued";
    return {
      index,
      key: `${scope}[${index}]`,
      state,
      stuck: STUCK_STATES.has(state),
      attempts: rows.reduce((max, row) => Math.max(max, row.attempt_count), 0),
      steps,
    };
  });
}

/** `1..count`, empty when the scope declared nothing. */
function range(from: number, to: number): number[] {
  return Array.from({ length: Math.max(0, to - from + 1) }, (_, offset) => from + offset);
}

/** Definition position; an unknown node sorts last, never first. */
function rankOf(nodeId: string, order?: readonly string[]): number {
  if (!order) return Number.MAX_SAFE_INTEGER;
  const at = order.indexOf(nodeId);
  return at < 0 ? order.length : at;
}

/** Counts per state in `PRECEDENCE` order — the header's `15 ✓ · 5 ● …` line. */
export function branchCounts(branches: readonly Branch[]): { state: StateName; count: number }[] {
  const counts = new Map<StateName, number>();
  for (const branch of branches) counts.set(branch.state, (counts.get(branch.state) ?? 0) + 1);
  return PRECEDENCE.filter((state) => counts.has(state)).map((state) => ({
    state,
    count: counts.get(state) ?? 0,
  }));
}

/**
 * Cell order. `stuck` puts branches a person must act on first (the design's
 * default), keeping index order inside each group; `number` is plain index.
 */
export function sortBranches(branches: readonly Branch[], mode: BranchSort): Branch[] {
  return [...branches].sort(
    (a, b) => (mode === "stuck" ? Number(b.stuck) - Number(a.stuck) : 0) || a.index - b.index,
  );
}

/** The branch with `index`, or null when nothing is selected. */
export function findBranch(branches: readonly Branch[], index: number | null): Branch | null {
  if (index === null) return null;
  return branches.find((branch) => branch.index === index) ?? null;
}
