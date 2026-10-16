/**
 * The run tree: node executions, iterations, fan-out children and child runs —
 * as an actual `role="tree"`, not a diagram.
 *
 * Three identities stay separate because the contract keeps them separate:
 * a **definition node** (`node_id`), its **executions** (`node_instance_key`
 * with `[n]` suffixes, `01` invariant 6) and its **child runs** (`/tree`, each
 * a run with its own identity). A loop therefore renders as one heading row
 * carrying repeat counts with its iterations nested under it — never as
 * duplicated definition nodes (`10` J7's honesty rule).
 *
 * Hundreds of rows are handled by *pagination per branch* rather than
 * virtualization: a virtualized `treeitem` list drops rows out of the
 * accessibility tree while they are conceptually present, and the run's own
 * budget (`maxNodeExecutions`) bounds a branch anyway. What is hidden is said
 * in words on the `+N more` row.
 */
import { useMemo } from "react";
import { iterationOf, parentKeyOf } from "../../lib/pipeline/runView";
import type {
  NodeExecutionSummary,
  RunStatus,
  RunTreeChild,
  RunTreeRoot,
} from "../../lib/pipeline/contract";
import { DEFERRED_KINDS, isNodeKind } from "../../lib/pipeline/definition";
import { shortId } from "../../lib/format";
import { Panel } from "../ds/Panel";
import { StatusChip } from "../ds/Row";
import { NODE_EXECUTION_STATE, RUN_STATE, SHORT_WORD, stateOf, type StateName } from "../ds/states";
import { KindChip } from "./KindChip";

export interface RunTreeRow {
  key: string;
  level: number;
  /** Identity text: a node id, an instance tail with its iteration, or a slug. */
  label: string;
  /** `null` for a synthetic loop/fan-out heading, which has no status of its own. */
  status: { state: StateName; word: string } | null;
  kind: string | null;
  /** Mono sub-line: the full instance key, or the child pipeline + depth. */
  detail: string;
  counts: string | null;
  expandable: boolean;
  expanded: boolean;
  setsize: number;
  posinset: number;
  href?: string;
  /** How many direct children this row owns (paged, not total). */
  childrenCount: number;
}

export interface RunTreeProps {
  nodes: NodeExecutionSummary[];
  tree?: RunTreeRoot | null;
  expandedKeys?: string[];
  onToggle?: (key: string) => void;
  selectedKey?: string | null;
  onSelect?: (key: string) => void;
  /** Direct children shown per branch before a `+N more` row. */
  pageSize?: number;
  /** The pinned revision's node ids in definition order, when the caller has
   * them — the tree then lists a run's work in the order the pipeline declares
   * it instead of the order the API sorted them into. */
  definitionOrder?: string[];
  /** Href builder for a child run's own inspector; omitted = not navigable. */
  runPath?: (runId: string) => string;
  headingId?: string;
  className?: string;
}

export function RunTree({
  nodes,
  tree = null,
  expandedKeys = [],
  onToggle,
  selectedKey = null,
  onSelect,
  pageSize = 10,
  runPath,
  definitionOrder,
  headingId = "run-tree-heading",
  className = "",
}: RunTreeProps) {
  const expanded = useMemo(() => new Set(expandedKeys), [expandedKeys]);
  const rows = useMemo(
    () => buildRows({ nodes, tree, expanded, pageSize, runPath, definitionOrder }),
    [nodes, tree, expanded, pageSize, runPath, definitionOrder],
  );

  return (
    <Panel
      title="EXECUTIONS"
      headingId={headingId}
      headingLevel={2}
      meta={
        <span className="font-mono text-[10.5px]" data-testid="run-tree-count">
          {nodes.length} node executions · {rows.length} rows shown
        </span>
      }
      className={className}
    >
      {rows.length === 0 ? (
        <p className="p-[10px] text-[12.5px] text-muted" data-testid="run-tree-empty">
          Nothing has executed yet — a queued run has no node executions to show.
        </p>
      ) : (
        <div
          role="tree"
          aria-label="Node executions, iterations and child runs"
          data-testid="run-tree"
          className="py-[4px]"
        >
          {rows.map((row) => (
            <RunTreeRowView
              key={row.key}
              row={row}
              selected={row.key === selectedKey}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </Panel>
  );
}

/* ------------------------------------------------------------- row view */

function RunTreeRowView({
  row,
  selected,
  onToggle,
  onSelect,
}: {
  row: RunTreeRow;
  selected: boolean;
  onToggle?: (key: string) => void;
  onSelect?: (key: string) => void;
}) {
  const indent = { paddingLeft: `calc(10px + var(--indent-step) * ${row.level})` };
  return (
    <div
      role="treeitem"
      aria-level={row.level + 1}
      aria-expanded={row.expandable ? row.expanded : undefined}
      aria-selected={selected}
      aria-setsize={row.setsize}
      aria-posinset={row.posinset}
      data-testid={`run-tree-row-${row.key}`}
      className={`flex h-[var(--row-condensed)] items-center gap-[7px] pr-[10px] ${
        selected ? "bg-tree-active shadow-(--shadow-raised)" : "hover:bg-accent-wash"
      }`}
      style={indent}
    >
      {row.expandable ? (
        <button
          type="button"
          aria-expanded={row.expanded}
          aria-label={`${row.expanded ? "collapse" : "expand"} ${row.label}`}
          data-testid={`run-tree-toggle-${row.key}`}
          onClick={() => onToggle?.(row.key)}
          className="grid h-[16px] w-[16px] shrink-0 place-items-center rounded-[2px] border border-line bg-surface font-mono text-[10px] leading-none text-muted hover:border-line-strong focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
        >
          {row.expanded ? "\u2212" : "+"}
        </button>
      ) : (
        // A leaf keeps the guide column, so depth stays readable at a glance.
        <span aria-hidden className="h-[16px] w-[16px] shrink-0 border-l border-tree-guide" />
      )}
      {row.kind ? (
        <KindChip
          kind={row.kind}
          deferredTo={isNodeKind(row.kind) ? (DEFERRED_KINDS[row.kind] ?? null) : null}
          compact
        />
      ) : null}
      {/* The row's identity is a control; a child run's is a link, because the
          contract gives it a run of its own with its own routes. */}
      {row.href ? (
        <a
          href={row.href}
          onClick={(event) => {
            // Select on an ordinary click; a modifier still opens the run.
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            onSelect?.(row.key);
          }}
          className="flex min-w-0 flex-1 items-center gap-[7px] text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
          data-testid={`run-tree-link-${row.key}`}
        >
          <RowLabel row={row} muted={row.status === null} />
        </a>
      ) : (
        <button
          type="button"
          onClick={() => onSelect?.(row.key)}
          className="flex min-w-0 flex-1 items-center gap-[7px] text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
        >
          <RowLabel row={row} muted={row.status === null} />
        </button>
      )}
    </div>
  );
}

/** Row content: identity, state chip, mono detail, counts right-aligned. */
function RowLabel({ row, muted }: { row: RunTreeRow; muted: boolean }) {
  return (
    <>
      <span
        className={`min-w-[3rem] shrink-0 truncate text-[12.5px] font-semibold ${muted ? "text-ink-2" : "text-ink"}`}
        data-testid={`run-tree-label-${row.key}`}
      >
        {row.label}
      </span>
      {row.status ? <StatusChip state={row.status.state} label={row.status.word} /> : null}
      <span className="truncate font-mono text-[10.5px] text-muted">{row.detail}</span>
      {row.counts ? (
        <span
          className="ml-auto shrink-0 font-mono text-[10.5px] text-faint tabular-nums"
          data-testid={`run-tree-counts-${row.key}`}
        >
          {row.counts}
        </span>
      ) : null}
    </>
  );
}

/* ---------------------------------------------------------- row building */

/**
 * Scope kinds whose body rows carry a `[n]` segment. `condition` is not one of
 * them (it picks a route, it does not iterate), and `parallel`/`join` are M5
 * kinds that cannot appear in an M4 run at all.
 */
const SCOPE_TREE_KINDS = new Set(["until", "for_each"]);

interface BuildArgs {
  nodes: NodeExecutionSummary[];
  tree: RunTreeRoot | null;
  expanded: Set<string>;
  pageSize: number;
  runPath?: (runId: string) => string;
  /** The pinned revision's node ids in definition order, when the caller has
   * them: the tree lists a run's work in the order the pipeline declares it. */
  definitionOrder?: string[];
}

/** The `[n]` on a key's own last segment, or null when it is not an iteration. */
function ownIteration(instanceKey: string): number | null {
  const leaf = instanceKey.split("/").filter(Boolean).pop() ?? "";
  const match = /\[(\d+)\]$/.exec(leaf);
  return match ? Number(match[1]) : null;
}

/**
 * The parent of an instance key lives in `lib/pipeline/runView` with the rest of
 * the key grammar, and is re-exported here so the tree's tests can read the same
 * function the tree does.
 */
export { parentKeyOf };

/** Build the visible rows, depth-first, respecting expansion and page size. */
export function buildRows(args: BuildArgs): RunTreeRow[] {
  return paged(args, childrenOf(args, "/", 0, false), "more:/", 0);
}

/** Rows whose parent key is `parentKey`, grouped by definition node. A row that
 * is a scope's own numbered place is left to `placeRows` — it is a place in a
 * repeat, not a repeat of a node. */
/**
 * Rows whose parent key is `parentKey`, grouped by definition node. A row that
 * is a scope's own numbered place is left to `placeRows` — it is a place in a
 * repeat, not a repeat of a node.
 */
function childrenOf(
  args: BuildArgs,
  parentKey: string,
  level: number,
  parentIsScope: boolean,
): RunTreeRow[][] {
  const groups = groupByDefinitionNode(
    args.nodes.filter(
      (node) =>
        parentKeyOf(node.node_instance_key) === parentKey &&
        // A numbered place belongs to the scope's own repeat list, drawn by
        // `placeRows`, so it is not also a "repeat of a node" under it.
        !(parentIsScope && ownIteration(node.node_instance_key) !== null),
    ),
    args.definitionOrder,
  );
  const chunks = groups.map(([nodeId, instances], index) =>
    instances.length === 1
      ? instanceRows(args, instances[0], level, groups.length, index + 1)
      : repeatHeadingRows(args, nodeId, instances, parentKey, level, groups.length, index + 1),
  );
  // Only the root carries the child runs. A nested child's `node_instance_key`
  // belongs to the child run's own keyspace, so comparing it to a parent's key
  // could only ever be a coincidence; nesting *between* child runs comes from
  // the tree's `children` array, which `childRunRows` walks.
  if (parentKey === "/") chunks.push(childRunSection(args, level));
  return chunks;
}

/** The tree's own branch: every child run `GET /runs/{id}/tree` reported. */
const CHILD_RUNS_KEY = "runs:child-runs";

/**
 * The child runs of THIS run, as one always-reachable branch (W11).
 *
 * A child run is a run with its own identity, so the `/tree` route is what
 * names it — and every child that route reports must be reachable in the page,
 * not parked behind the invocation that made it. Attaching a child to its
 * `node_instance_key` strands it two expansions deep inside a branch that is
 * itself paged, which is exactly how C8's fan-out children vanished from the
 * run page: 6 (then 25) children under `/fan_out[n]/invoke`, none of them
 * openable. So they get one heading, listing all of them, each with its own
 * status chip, its depth and a link to its own inspector; the invocation that
 * made it is named in the row (`instanceRows` counts it) and in the heading.
 *
 * The heading starts open — collapsing it is a request, never the default — and
 * the list is never paged: the run's own budget bounds child runs, and a hidden
 * child run is a run nobody can open.
 */
function childRunSection(args: BuildArgs, level: number): RunTreeRow[] {
  const children = args.tree?.children ?? [];
  if (children.length === 0) return [];
  const open = isOpen(args, CHILD_RUNS_KEY, true);
  const head: RunTreeRow = {
    key: CHILD_RUNS_KEY,
    level,
    label: "child runs",
    // The child runs have statuses; the branch that holds them has none of its
    // own, so it carries the count the route gave us and no invented chip.
    status: null,
    kind: null,
    detail: `${children.length} child run${children.length === 1 ? "" : "s"} of this run`,
    counts: null,
    expandable: true,
    expanded: open,
    setsize: 1,
    posinset: 1,
    childrenCount: children.length,
  };
  if (!open) return [head];
  // Deliberately not `paged`: see the doc comment.
  return [
    head,
    ...children
      .map((child, index) => childRunRows(args, child, level + 1, children.length, index + 1))
      .flat(),
  ];
}

/**
 * Expansion of one key. A branch that is open by default inverts the set: the
 * caller's `expandedKeys` records what a person *toggled*, and a default-open
 * branch is closed only once it appears there.
 */
function isOpen(args: BuildArgs, key: string, defaultOpen = false): boolean {
  return args.expanded.has(key) !== defaultOpen;
}

/**
 * Several executions of one definition node under one parent: a heading, then
 * the executions themselves. A fan-out stays ONE node in the reader's mind,
 * which is the thing `10` J7 says must not be faked.
 */
function repeatHeadingRows(
  args: BuildArgs,
  nodeId: string,
  instances: NodeExecutionSummary[],
  parentKey: string,
  level: number,
  setsize: number,
  posinset: number,
): RunTreeRow[] {
  // A root heading keeps the short id (`n:invoke`); inside a scope the heading
  // has to say which scope, or two scopes holding the same node id collide.
  const headingKey = parentKey === "/" ? `n:${nodeId}` : `n:${parentKey}>${nodeId}`;
  const head: RunTreeRow = {
    key: headingKey,
    level,
    label: nodeId,
    // The repeat itself has no server status — only its executions do — so the
    // heading carries counts, never a chip that would have to be invented.
    status: null,
    kind: instances[0].kind,
    detail: `${instances.length} ${instances[0].kind === "until" ? "iterations" : "executions"}`,
    counts: rollupCounts(instances),
    expandable: true,
    expanded: isOpen(args, headingKey),
    setsize,
    posinset,
    childrenCount: instances.length,
  };
  if (!head.expanded) return [head];
  return [
    head,
    ...paged(
      args,
      instances.map((node, index) =>
        instanceRows(args, node, level + 1, instances.length, index + 1),
      ),
      `more:${headingKey}`,
      level + 1,
    ),
  ];
}

/** One node execution, plus its iterations, its body nodes and its child runs. */
function instanceRows(
  args: BuildArgs,
  node: NodeExecutionSummary,
  level: number,
  setsize: number,
  posinset: number,
): RunTreeRow[] {
  const key = node.node_instance_key;
  const places = placeRows(args, node);
  const branches = childrenOf(args, key, level + 1, SCOPE_TREE_KINDS.has(node.kind));
  // The child runs this execution invoked live in the run's own `child runs`
  // branch (W11: every child the route reports must be reachable); the row that
  // invoked them says so in words rather than hiding them two levels down.
  const invokedByThis = (args.tree?.children ?? []).filter(
    (child) => child.node_instance_key === key,
  ).length;
  const siblingCount = places.length + branches.length;
  const self: RunTreeRow = {
    key,
    level,
    label: instanceLabel(key),
    status: { state: stateOf(NODE_EXECUTION_STATE[node.status]), word: statusWord(node) },
    kind: node.kind,
    detail: key,
    counts: summaryCounts(node, invokedByThis),
    expandable: siblingCount > 0,
    expanded: isOpen(args, key),
    setsize,
    posinset,
    childrenCount: siblingCount,
  };
  if (!self.expandable || !self.expanded) return [self];

  let position = 1;
  const childChunks = [
    // A place with a real row is rendered *as that row*, chip and all; a place
    // the server never sent is a named empty slot with counts of what is inside.
    ...places.map((place) =>
      place.row
        ? instanceRows(args, place.row, level + 1, siblingCount, position++)
        : expandPlace(args, place.place as RunTreeRow, level + 1, siblingCount, position++),
    ),
    ...branches,
  ];
  return [self, ...paged(args, childChunks, `more:${key}`, level + 1)];
}

/**
 * The numbered places inside a scope: an `until` calls them *iterations*, a
 * `for_each` calls them *branches*. A loop reports `iterations`, a fan-out
 * reports `items`, and neither is required to send a row per place (C1d's key
 * set has one composite row for the loop). So a place exists for every index
 * either declared or visible in the keys — and it carries the real row when the
 * server sent one, so a scope that reports per-branch rows shows their states
 * rather than a synthetic guess.
 */
function placeRows(args: BuildArgs, node: NodeExecutionSummary): Place[] {
  if (!SCOPE_TREE_KINDS.has(node.kind)) return [];
  const key = node.node_instance_key;
  const byKey = new Map(args.nodes.map((other) => [other.node_instance_key, other]));
  const seen = new Set<number>();
  for (const other of args.nodes) {
    if (parentKeyOf(other.node_instance_key) !== key) continue;
    const suffix = ownIteration(other.node_instance_key);
    if (suffix !== null) seen.add(suffix);
  }
  const count = Math.max(node.iterations ?? 0, node.items ?? 0, ...seen, 0);
  const places: Place[] = [];
  for (let iteration = 1; iteration <= count; iteration += 1) {
    const placeKey = `${key}[${iteration}]`;
    const row = byKey.get(placeKey);
    if (row) {
      places.push({ row, place: null });
      continue;
    }
    const members = args.nodes.filter((other) => parentKeyOf(other.node_instance_key) === placeKey);
    places.push({
      row: null,
      place: {
        key: placeKey,
        level: 0, // corrected by expandPlace: a place sits one level under its scope
        label: `${node.kind === "until" ? "iteration" : "branch"} ${iteration}`,
        // No chip: a place has no status of its own, only the nodes inside it do.
        status: null,
        kind: node.kind,
        detail: placeKey,
        counts: members.length > 0 ? rollupCounts(members) : null,
        expandable: members.length > 0,
        expanded: isOpen(args, placeKey),
        setsize: 1,
        posinset: iteration,
        childrenCount: members.length,
      },
    });
  }
  return places;
}

/** A numbered place inside a scope: either the server's own row, or a slot. */
interface Place {
  row: NodeExecutionSummary | null;
  place: RunTreeRow | null;
}

function expandPlace(
  args: BuildArgs,
  place: RunTreeRow,
  level: number,
  setsize: number,
  posinset: number,
): RunTreeRow[] {
  const self: RunTreeRow = { ...place, level, setsize, posinset };
  if (!self.expandable || !self.expanded) return [self];
  return [
    self,
    ...paged(args, childrenOf(args, self.key, level + 1, false), `more:${self.key}`, level + 1),
  ];
}

/**
 * One child run the `/tree` route reported, and its own children when expanded.
 * The sentence this row writes is the run's own identity: `child run <short id>
 * · depth <n> · waits for <policy> · status <status>` — id, depth, wait policy
 * and status are all the route's facts, never a guess — followed by the
 * invocation that made it.
 *
 * The status rides inside that sentence and not only on the chip, because the
 * chip is a separate box: whatever reads the row's identity line — a screen
 * reader, `find` in a browser, W11's DOM assertion — otherwise meets `child run
 * 4f15171c · depth 1 · waits for completion` with no word saying how that run
 * ended. A row whose route named no status says `status no status reported`
 * rather than printing a hole (`10`'s honesty rule).
 */
function childRunRows(
  args: BuildArgs,
  child: RunTreeChild,
  level: number,
  setsize: number,
  posinset: number,
): RunTreeRow[] {
  const key = `run:${child.child_run_id}`;
  const nested = child.children ?? [];
  const self: RunTreeRow = {
    key,
    level,
    label: child.pipeline_slug,
    status: { state: stateOf(RUN_STATE[child.status]), word: runStatusWord(child.status) },
    kind: null,
    detail: [
      `child run ${shortId(child.child_run_id)} · depth ${child.depth} · waits for ${child.wait_policy}`,
      `status ${childRunStatusWord(child.status)}`,
      child.node_instance_key ? `invoked by ${child.node_instance_key}` : null,
    ]
      .filter(Boolean)
      .join(" · "),
    counts: child.detached ? "detached" : null,
    expandable: nested.length > 0,
    expanded: isOpen(args, key),
    setsize,
    posinset,
    href: args.runPath?.(child.child_run_id),
    childrenCount: nested.length,
  };
  if (!self.expandable || !self.expanded) return [self];
  return [
    self,
    ...paged(
      args,
      nested.map((grand, index) => childRunRows(args, grand, level + 1, nested.length, index + 1)),
      `more:${key}`,
      level + 1,
    ),
  ];
}

/* --------------------------------------------------------------- helpers */

type Group = [nodeId: string, instances: NodeExecutionSummary[]];

/** Executions grouped by `node_id`: definition order when the caller named it,
 * the caller's own order otherwise. */
function groupByDefinitionNode(nodes: NodeExecutionSummary[], definitionOrder?: string[]): Group[] {
  const groups: Group[] = [];
  const index = new Map<string, number>();
  for (const node of nodes) {
    const at = index.get(node.node_id);
    if (at === undefined) {
      index.set(node.node_id, groups.length);
      groups.push([node.node_id, [node]]);
    } else {
      groups[at][1].push(node);
    }
  }
  if (definitionOrder) {
    // The API lists executions by instance key, which reads alphabetically; the
    // tree is read against the graph the run is pinned to, so the revision's own
    // order wins. A node the revision does not name keeps its place at the end.
    const rank = (nodeId: string) => {
      const at = definitionOrder.indexOf(nodeId);
      return at < 0 ? definitionOrder.length : at;
    };
    groups.sort((a, b) => rank(a[0]) - rank(b[0]));
  }
  return groups.map(([nodeId, instances]) => [
    nodeId,
    [...instances].sort((a, b) => a.node_instance_key.localeCompare(b.node_instance_key)),
  ]);
}

/**
 * Slice a branch to `pageSize` items, keeping each item's whole subtree with
 * it: rows come in per-item chunks, so slicing rows naively would orphan
 * children under a parent that is no longer on screen.
 */
/**
 * Slice a branch to `pageSize` items, keeping each item's whole subtree with
 * it: rows come in per-item chunks, so slicing rows naively would orphan
 * children under a parent that is no longer on screen.
 *
 * The `+N more` row is a real control, not a caption — a hidden branch that
 * cannot be opened strands whatever it holds (W11 counted children that were
 * past a page the UI had no way to turn). Expanding it shows the whole branch;
 * collapsing the parent hides it again.
 */
function paged(
  args: BuildArgs,
  chunks: RunTreeRow[][],
  moreKey: string,
  level: number,
): RunTreeRow[] {
  const pageSize = args.pageSize;
  if (chunks.length <= pageSize) return chunks.flat();
  if (isOpen(args, moreKey)) return chunks.flat();
  const visible = chunks.slice(0, pageSize).flat();
  const hidden = chunks.length - pageSize;
  return [
    ...visible,
    {
      key: moreKey,
      level,
      label: `${hidden} more`,
      status: null,
      kind: null,
      detail: "this branch is longer than one page",
      counts: null,
      // Expandable: the row exists to hand the rest of the branch back.
      expandable: true,
      expanded: false,
      setsize: chunks.length,
      posinset: pageSize + 1,
      childrenCount: hidden,
    },
  ];
}

/** `/build_until_verified[2]/review` → `review[2]`: the iteration travels with
 * the node it belongs to, which is what the key means. */
export function instanceLabel(key: string): string {
  const leaf = key.split("/").filter(Boolean).pop() ?? key;
  // When the leaf itself carries the suffix (`/verify_each[22]`) it is already in
  // the label; appending the iteration again would read `verify_each[22][22]`.
  if (/\[\d+\]$/.test(leaf)) return leaf;
  const iteration = iterationOf(key);
  return iteration === null ? leaf : `${leaf}[${iteration}]`;
}

/**
 * A run status as a word a person reads: the wire's own status with its
 * underscore for a space (`waiting_human` → `waiting human`), which is the
 * spelling `RunStatusChip` on the runs list uses — so a child run's chip on the
 * tree never reads differently from the same run's chip in a list.
 */
export function runStatusWord(status: RunStatus | null | undefined): string {
  const word = String(status ?? "")
    .replaceAll("_", " ")
    .trim();
  return word || "no status reported";
}

/**
 * The status word inside a child row's identity sentence: the wire's raw token
 * (`waiting_human`), mono like the instance key beside it. The chip carries the
 * human spelling; this line carries what `GET /runs/{id}/tree` actually said,
 * so a reader can compare the row to the route without a synonym in between.
 */
function childRunStatusWord(status: RunStatus | null | undefined): string {
  const word = String(status ?? "").trim();
  return word || "no status reported";
}

/** `outcome` is a column separate from `status` (`03`'s result envelope), so a
 * node that ran fine and failed its check shows both words, never a merged one. */ export function statusWord(
  node: NodeExecutionSummary,
): string {
  if (node.status === "succeeded" && node.outcome && node.outcome !== "passed") {
    return `ran fine · ${node.outcome}`;
  }
  if (node.status === "succeeded") return "succeeded";
  if (node.status === "waiting" && node.waiting_reason === "approval")
    return "waiting for approval";
  if (node.status === "waiting" && node.waiting_reason === "child_run")
    return "waiting for child run";
  if (node.status === "waiting") return "waiting";
  if (node.status === "interrupted") return "interrupted — outcome unknown";
  if (node.status === "failed" && node.error_class) return `failed · ${node.error_class}`;
  return node.status;
}

function summaryCounts(node: NodeExecutionSummary, invokedRuns = 0): string | null {
  const parts: string[] = [];
  if (node.attempt_count > 1) parts.push(`${node.attempt_count} attempts`);
  if (node.iterations != null) parts.push(`${node.iterations} iterations`);
  if (node.items != null) parts.push(`${node.items} items`);
  if (invokedRuns > 0) parts.push(`${invokedRuns} child run${invokedRuns === 1 ? "" : "s"}`);
  // `in_flight` is a live count: attempts a worker still holds. A row that has
  // reached a terminal state cannot hold work, so repeating the last number the
  // server happened to send would claim a failure is still running.
  const live = ["ready", "leased", "running", "waiting", "pending"].includes(node.status);
  if (node.in_flight > 0 && live) parts.push(`${node.in_flight} in flight`);
  if (node.artifact_refs.length > 0) parts.push(`${node.artifact_refs.length} artifacts`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** Counts in words, per state — the strip's and the tree's shared vocabulary. */
export function rollupCounts(instances: NodeExecutionSummary[]): string {
  const tally = new Map<string, number>();
  for (const node of instances) {
    const word = SHORT_WORD[stateOf(NODE_EXECUTION_STATE[node.status])];
    tally.set(word, (tally.get(word) ?? 0) + 1);
  }
  return [...tally.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([word, count]) => `${count} ${word}`)
    .join("  ");
}
