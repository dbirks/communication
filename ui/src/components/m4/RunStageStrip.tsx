/**
 * The run's stage strip — PROGRESS-J by node, with counts.
 *
 * The loop is one stage, never three: `10` J7's honesty rule and
 * `docs/design/assistant-flow.md`'s "Iterations render as repeat counts on one
 * stage cell". Node executions are grouped by `node_id` (the definition node)
 * and each *instance* becomes one segment in that cell's bar, so
 * `build_until_verified` reads `× 3 · ● 1 · ✓ 8` across its twelve instances
 * rather than becoming twelve stages.
 *
 * Counts accompany every colour (identity rule 06), and the words come from
 * `ds/states.ts` — the same table the rest of the app uses, so a stage cell and
 * a tree row never disagree about what cerulean means.
 */
import { parentKeyOf } from "../../lib/pipeline/runView";
import type { NodeExecutionSummary } from "../../lib/pipeline/contract";
import { Panel } from "../ds/Panel";
import {
  NODE_EXECUTION_STATE,
  SEGMENT_COLOR,
  SHORT_WORD,
  STATES,
  stateOf,
  type StateName,
} from "../ds/states";

export interface StageCell {
  nodeId: string;
  kind: string;
  state: StateName;
  /** Counts per state, in a fixed order — the words a colour would rather hide. */
  counts: { state: StateName; word: string; count: number }[];
  instances: { key: string; state: StateName }[];
  /** Position of this definition node in the caller's list. */
  order: number;
}

/** Aggregate precedence: the state a person must act on wins the cell. */
const PRECEDENCE: StateName[] = [
  "failed",
  "interrupted",
  "waiting",
  "retrying",
  "running",
  "queued",
  "done",
  "info",
];

/** True when this row is a scope's numbered place rather than a node's own row. */
function isPlaceOfAnother(node: NodeExecutionSummary, byKey: Map<string, NodeExecutionSummary>) {
  const suffix = /\[\d+\]$/.exec(node.node_instance_key);
  if (!suffix) return false;
  const parent = byKey.get(node.node_instance_key.slice(0, -suffix[0].length));
  return parent !== undefined && SCOPE_STRIP_KINDS.has(parent.kind);
}

/**
 * One segment per execution of this node. A scope's rows are its places when the
 * server sent them; otherwise the place is named from the scope's own
 * `iterations`/`items` and takes the state rolled up from the body rows inside
 * it — so a loop that has run twice shows two segments, and neither segment's
 * colour is invented.
 */
function segmentsOf(
  node: NodeExecutionSummary,
  nodes: NodeExecutionSummary[],
  byKey: Map<string, NodeExecutionSummary>,
): { key: string; state: StateName }[] {
  const places = nodes.filter(
    (other) =>
      other.node_instance_key.startsWith(`${node.node_instance_key}[`) &&
      isPlaceOfAnother(other, byKey),
  );
  if (places.length > 0) {
    return places
      .sort((a, b) => a.node_instance_key.localeCompare(b.node_instance_key))
      .map((place) => ({
        key: place.node_instance_key,
        state: stateOf(NODE_EXECUTION_STATE[place.status]),
      }));
  }
  const declared = Math.max(node.iterations ?? 0, node.items ?? 0);
  if (!SCOPE_STRIP_KINDS.has(node.kind) || declared === 0) {
    return [{ key: node.node_instance_key, state: stateOf(NODE_EXECUTION_STATE[node.status]) }];
  }
  return Array.from({ length: declared }, (_, index) => index + 1).map((iteration) => {
    const placeKey = `${node.node_instance_key}[${iteration}]`;
    const inside = nodes.filter((other) => parentKeyOf(other.node_instance_key) === placeKey);
    const state =
      inside.length > 0
        ? (PRECEDENCE.find((candidate) =>
            inside.some((row) => stateOf(NODE_EXECUTION_STATE[row.status]) === candidate),
          ) ?? "queued")
        : "queued";
    return { key: placeKey, state };
  });
}

/** Kinds that repeat, so their `[n]` rows are places and not separate executions. */
const SCOPE_STRIP_KINDS = new Set(["until", "for_each"]);

export function stageCells(nodes: NodeExecutionSummary[], definitionOrder?: string[]): StageCell[] {
  const byKey = new Map(nodes.map((node) => [node.node_instance_key, node]));
  const byNode = new Map<string, NodeExecutionSummary[]>();
  const firstSeen = new Map<string, number>();
  nodes.forEach((node, index) => {
    if (!firstSeen.has(node.node_id)) firstSeen.set(node.node_id, index);
    const list = byNode.get(node.node_id) ?? [];
    list.push(node);
    byNode.set(node.node_id, list);
  });
  /**
   * Definition position. The caller who has the pinned revision passes its node
   * ids in document order, and a node the revision does not name (it should not
   * exist, but a draft run may) keeps its position at the end rather than
   * jumping to the front. Without the revision the caller's own order stands —
   * never the API's, which sorts by key and so reads alphabetically.
   */
  const position = (nodeId: string, fallback: number) => {
    if (!definitionOrder) return fallback;
    const at = definitionOrder.indexOf(nodeId);
    return at < 0 ? definitionOrder.length + fallback : at;
  };
  const cells: StageCell[] = [];
  for (const [nodeId, instances] of byNode) {
    // A numbered place (`/scope[3]`) is one execution of its scope, not of the
    // node it is named after: the strip counts places under their scope and
    // leaves them out of their own node's cell, or a 25-branch fan-out would
    // count 26 and the composite row would be one of them.
    const heads = instances.filter((node) => !isPlaceOfAnother(node, byKey));
    const segments = heads
      .sort((a, b) => a.node_instance_key.localeCompare(b.node_instance_key))
      .flatMap((node) => segmentsOf(node, nodes, byKey));
    const states = segments.map((segment) => segment.state);
    const counts = new Map<StateName, number>();
    for (const state of states) counts.set(state, (counts.get(state) ?? 0) + 1);
    const state = PRECEDENCE.find((candidate) => counts.has(candidate)) ?? "queued";
    cells.push({
      nodeId,
      kind: instances[0].kind,
      state,
      counts: [...counts.entries()]
        .sort((a, b) => PRECEDENCE.indexOf(a[0]) - PRECEDENCE.indexOf(b[0]))
        .map(([key, count]) => ({ state: key, word: wordFor(key, instances), count })),
      instances: segments.map((segment) => ({ key: segment.key, state: segment.state })),
      order: position(nodeId, firstSeen.get(nodeId) ?? 0),
    });
  }
  // Definition order, not completion order: a stage strip is read against the
  // graph the run is pinned to.
  return cells.sort((a, b) => a.order - b.order || a.nodeId.localeCompare(b.nodeId));
}

export interface RunStageStripProps {
  nodes: NodeExecutionSummary[];
  /** The pinned revision's node ids in definition order, when the caller has
   * them — the strip is read against the graph, not against an alphabetical
   * listing. */
  definitionOrder?: string[];
  selectedNodeId?: string | null;
  /** A cell click filters or jumps — the caller decides which; the cell is a
   * real button either way, so the strip is never canvas-only. */
  onSelectNode?: (nodeId: string) => void;
  headingId?: string;
  className?: string;
}

export function RunStageStrip({
  nodes,
  definitionOrder,
  selectedNodeId = null,
  onSelectNode,
  headingId = "run-stage-strip-heading",
  className = "",
}: RunStageStripProps) {
  const cells = stageCells(nodes, definitionOrder);

  return (
    <Panel title="STAGES" headingId={headingId} headingLevel={2} className={className}>
      <div
        role="group"
        aria-label="Run progress by definition node"
        data-testid="run-stage-strip"
        className="flex flex-wrap items-stretch divide-x divide-line rounded-b-[3px] border-t-0 bg-surface"
      >
        {cells.map((cell) => {
          const spec = STATES[cell.state];
          const selected = cell.nodeId === selectedNodeId;
          const label = `${cell.nodeId}, ${cell.counts.map((entry) => `${entry.count} ${entry.word}`).join(", ")}`;
          return (
            <button
              key={cell.nodeId}
              type="button"
              data-testid={`run-stage-cell-${cell.nodeId}`}
              aria-current={selected ? "true" : undefined}
              onClick={() => onSelectNode?.(cell.nodeId)}
              className={`min-w-[7rem] flex-1 px-[11px] py-[7px] text-left transition-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent ${
                selected ? "bg-accent-wash" : ""
              }`}
            >
              <span className="block truncate font-mono text-[10px] font-semibold tracking-[.04em] text-muted uppercase">
                {cell.nodeId}
              </span>
              <span className="mt-[2px] flex items-center gap-[5px] text-[12.5px] font-semibold">
                <span aria-hidden>{spec.glyph}</span>
                {spec.word}
              </span>
              {/* PROGRESS-J's counts-in-words line, kept on one line at every
                  width: 1280px must show 150 ✓ / 38 ● / 15 need you. */}
              <span
                className="mt-[2px] flex flex-wrap gap-x-[6px] font-mono text-[10.5px] text-muted tabular-nums"
                data-testid={`run-stage-counts-${cell.nodeId}`}
              >
                {cell.counts.map((entry) => (
                  <span key={entry.state} aria-hidden>
                    <span className={SEGMENT_COLOR[entry.state]}>&nbsp;&nbsp;</span> {entry.count}{" "}
                    {entry.word}
                  </span>
                ))}
              </span>
              <span className="sr-only">{label}</span>
              <span
                aria-hidden
                data-testid={`run-stage-segments-${cell.nodeId}`}
                className="mt-[4px] flex h-[6px] w-full gap-[1px] overflow-hidden rounded-[2px] bg-surface ring-[.5px] ring-ink"
              >
                {cell.instances.map((instance) => (
                  <span
                    key={instance.key}
                    title={`${instance.key}: ${instance.state}`}
                    className={`h-full flex-1 ${SEGMENT_COLOR[instance.state] ?? "bg-seg-open"}`}
                    style={{ minWidth: 3 }}
                  />
                ))}
              </span>
            </button>
          );
        })}
      </div>
      <p
        className="border-t border-line px-[10px] py-[6px] font-mono text-[10.5px] text-faint"
        data-testid="run-stage-note"
      >
        one cell per definition node; segments inside a cell are its iterations and fan-out
        instances — the loop is not duplicated as stages.
      </p>
    </Panel>
  );
}

/** Word counts carry: a `skipped` node and a `queued` node share the queued set
 * (docs/design/design-system.md's status table), so only the word tells them
 * apart — and the word must be the design's, not a local invention. */
function wordFor(state: StateName, instances: NodeExecutionSummary[]): string {
  if (state === "queued") {
    const skipped = instances.every((node) => node.status === "skipped");
    return skipped ? "skipped" : "pending";
  }
  if (state === "waiting") return SHORT_WORD.waiting;
  return SHORT_WORD[state];
}
