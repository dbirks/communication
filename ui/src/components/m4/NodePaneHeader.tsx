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
import { NODE_EXECUTION_STATE, SHORT_WORD, stateOf } from "../ds/states";
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

/**
 * The node's state in the app's SHORT_WORD, not the wire token spelled out:
 * `waiting` reads **need you** (identity rule 06 — the same word the stage
 * strip, the tree row and the graph node use for the same colour) and
 * `succeeded` reads **done**. Where two statuses share a state set the word
 * carries the difference, so the two cases the short table would flatten keep
 * their own word: a `skipped` node says `skipped` (it was never pending), and
 * a node that ran and failed its check says what it ran into
 * (`done · failed_check`) rather than a bare ✓.
 */
export function nodeStateWord(node: Pick<NodeExecutionSummary, "status" | "outcome">): string {
  const state = stateOf(NODE_EXECUTION_STATE[node.status]);
  if (node.status === "skipped") return "skipped";
  if (node.status === "succeeded" && node.outcome && node.outcome !== "passed") {
    return `${SHORT_WORD[state]} \u00b7 ${node.outcome}`;
  }
  return SHORT_WORD[state];
}

/** Does the instance key say more than the crumb already said? A node outside
 * every scope has the key `/<node_id>` — the crumb's own word with a slash in
 * front of it — so the key line there is a repeat, not an identity. */
function instanceKeyAddsInfo(node: NodeExecutionSummary): boolean {
  return node.node_instance_key !== `/${node.node_id}`;
}

export function NodePaneHeader({
  node,
  nodes = [],
  attemptNumber = null,
  className = "",
}: NodePaneHeaderProps) {
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
          state={stateOf(NODE_EXECUTION_STATE[node.status])}
          label={nodeStateWord(node)}
          labelProps={{ "data-testid": "node-pane-status", role: "status" }}
        />
        {/* The instance key is the node's real identity, so it prints — but only
            where it says MORE than the crumb above it. For a node outside every
            scope `node_instance_key` is just `/<node_id>`, and the pass-7 review
            counted the gate pane printing that same `/approve` four times over
            (crumb, key line, dock title, gate card). One node line is the rule;
            a fanned row's `/scope[2]/leaf` is kept, because the crumb's
            `task 2` is not the same fact. */}
        {instanceKeyAddsInfo(node) ? (
          <code
            className="min-w-0 truncate font-mono text-[10.5px] text-faint"
            data-testid="node-pane-key"
            title={node.node_instance_key}
          >
            {node.node_instance_key}
          </code>
        ) : null}
      </div>
    </div>
  );
}
