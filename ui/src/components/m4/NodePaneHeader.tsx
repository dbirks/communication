/**
 * The right pane's header, as `run-view-4a` draws it: a breadcrumb line that
 * names *where in the run you are* — `implement · task 14 · attempt 2` — over
 * the node's real identity.
 *
 * Every part is read off data the run responses already carry:
 * - the stage word is the node execution's `node_id`;
 * - the place (`task n` / `iter n`) is the innermost `[n]` in the
 *   `node_instance_key`, labelled by what the scope row says that scope is
 *   (`for_each` fans out over items → "task", the BranchGrid's own word;
 *   `until` iterates → "iter"; an unknown scope says "branch", never a
 *   guessed item title — the wire carries no task names);
 * - the attempt number is the attempt being shown, or the node's own
 *   `attempt_count`.
 * The design's second line is a human title; there is none on the wire, so
 * the instance key stands in — the run's own name for the place, never an
 * invention.
 */
import { StatusChip } from "../ds/Row";
import { NODE_EXECUTION_STATE } from "../ds/states";
import type { NodeExecutionSummary } from "../../lib/pipeline/contract";

export interface NodePaneHeaderProps {
  node: NodeExecutionSummary;
  /** The run's rows, so the scope a `[n]` belongs to can say what it is. */
  nodes?: readonly NodeExecutionSummary[];
  /** The attempt the pane below shows; `null`/`0` draws no attempt crumb. */
  attemptNumber?: number | null;
  className?: string;
}

/**
 * `task 14` for a `for_each` item, `iter 2` for an `until` pass, `branch n`
 * when the scope row is not on hand to name itself. `null` for a node outside
 * any fan-out or loop — the crumb then says only what is true.
 */
export function placeCrumbOf(
  key: string,
  nodes: readonly Pick<NodeExecutionSummary, "node_instance_key" | "kind">[],
): string | null {
  const marks = [...key.matchAll(/\[(\d+)\]/g)];
  if (marks.length === 0) return null;
  const last = marks[marks.length - 1];
  const index = Number(last[1]);
  const scopeKey = key.slice(0, last.index);
  const kind = nodes.find((node) => node.node_instance_key === scopeKey)?.kind;
  const label = kind === "for_each" ? "task" : kind === "until" ? "iter" : "branch";
  return `${label} ${index}`;
}

export function NodePaneHeader({
  node,
  nodes = [],
  attemptNumber = null,
  className = "",
}: NodePaneHeaderProps) {
  const state = NODE_EXECUTION_STATE[node.status];
  const place = placeCrumbOf(node.node_instance_key, nodes);
  const attempt = attemptNumber !== null && attemptNumber >= 1 ? attemptNumber : null;
  const crumb = [node.node_id, place, attempt !== null ? `attempt ${attempt}` : null]
    .filter((part): part is string => part !== null)
    .join(" \u00b7 ");

  return (
    <div
      data-testid="node-pane-header"
      className={`rounded-[3px] border border-line-strong bg-fill px-[10px] py-[8px] ${className}`}
    >
      <p
        className="truncate font-mono text-[11.5px] text-muted"
        data-testid="node-pane-crumb"
        title={`${node.node_id} — ${node.node_instance_key}`}
      >
        {crumb}
      </p>
      <div className="mt-[4px] flex items-center gap-2">
        <StatusChip
          state={state}
          label={node.status.replaceAll("_", " ")}
          labelProps={{ "data-testid": "node-pane-status", role: "status" }}
        />
        <code
          className="min-w-0 truncate font-mono text-[10.5px] text-faint"
          data-testid="node-pane-key"
        >
          {node.node_instance_key}
        </code>
      </div>
    </div>
  );
}
