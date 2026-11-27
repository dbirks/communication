/**
 * RunCard — inline workflow run status card inside a chat thread (redesign R3,
 * v2r one-row layout).
 *
 * One row: factory icon, then a column with the workflow name + the run state
 * said once (glyph + word, plus " · <step>" while it runs) above a step strip
 * of one segment per step, then the "Open in Factory" link to `/runs/:runId`.
 * Card colours follow the run state.
 */
import { IconBuildingFactory2 } from "@tabler/icons-react";
import { Link } from "react-router";
import { usePipelines } from "../../api/pipelines";
import { useRun, useRunNodes } from "../../api/runs";
import type { NodeExecution } from "../../api/types";

type NodeExecutionStatus = NodeExecution["status"];
import { shortId } from "../../lib/format";
import { stepWordOf } from "../../lib/pipeline/runView";
import { routes } from "../../lib/routes";

export type RunCardSegmentState = "done" | "running" | "waiting" | "failed" | "todo";

const SEGMENT_CLASS: Record<RunCardSegmentState, string> = {
  done: "bg-seg-done",
  running: "bg-st-running-strong",
  waiting: "bg-st-waiting-strong",
  failed: "bg-st-failed-strong",
  todo: "bg-surface",
};

const NODE_TO_SEGMENT: Record<NodeExecutionStatus, RunCardSegmentState> = {
  succeeded: "done",
  skipped: "done",
  running: "running",
  leased: "running",
  ready: "running",
  waiting: "waiting",
  failed: "failed",
  cancelled: "failed",
  interrupted: "failed",
  pending: "todo",
};

const BUCKET_PRIORITY: readonly RunCardSegmentState[] = [
  "failed",
  "waiting",
  "running",
  "todo",
  "done",
];

function mergeSegmentStates(states: readonly RunCardSegmentState[]): RunCardSegmentState {
  for (const candidate of BUCKET_PRIORITY) {
    if (states.includes(candidate)) return candidate;
  }
  return "todo";
}

/**
 * Map node executions to at most `maxSegments` (default 5) progress segments.
 * Runs with ≤ 5 steps render one segment per step; runs with > 5 steps
 * compress proportionally into 5 buckets.
 */
export function compressRunSegments(
  nodes: readonly Pick<NodeExecution, "status" | "created_at">[],
  maxSegments = 5,
): RunCardSegmentState[] {
  if (nodes.length === 0) {
    return Array.from({ length: maxSegments }, () => "todo");
  }
  const ordered = [...nodes].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const raw = ordered.map((node) => NODE_TO_SEGMENT[node.status] ?? "todo");
  if (raw.length <= maxSegments) return raw;

  const out: RunCardSegmentState[] = [];
  for (let b = 0; b < maxSegments; b += 1) {
    const start = Math.floor((b * raw.length) / maxSegments);
    const end = Math.floor(((b + 1) * raw.length) / maxSegments);
    out.push(mergeSegmentStates(raw.slice(start, Math.max(start + 1, end))));
  }
  return out;
}

export interface RunCardStateMeta {
  glyph: string;
  word: "running" | "waiting" | "done" | "failed" | "interrupted";
  textClass: string;
}

export function runCardState(status: string | undefined): RunCardStateMeta {
  switch (status) {
    case "waiting_human":
    case "paused":
      return { glyph: "!", word: "waiting", textClass: "text-st-waiting-tag-fg" };
    case "completed":
      return { glyph: "✓", word: "done", textClass: "text-st-done-tag-fg" };
    case "failed":
      return { glyph: "×", word: "failed", textClass: "text-st-failed-tag-fg" };
    case "cancelled":
    case "interrupted":
      return { glyph: "⊘", word: "interrupted", textClass: "text-st-interrupted-tag-fg" };
    default:
      return { glyph: "●", word: "running", textClass: "text-st-running-pale-fg" };
  }
}

/** Card and icon colours per run state (the pale pair for that state). */
const CARD_CLASS: Record<RunCardStateMeta["word"], { card: string; icon: string }> = {
  running: {
    card: "border-st-running-pale-edge bg-st-running-pale-body",
    icon: "text-st-running-pale-fg",
  },
  waiting: {
    card: "border-st-waiting-pale-edge bg-st-waiting-pale-body",
    icon: "text-st-waiting-pale-fg",
  },
  failed: {
    card: "border-st-failed-pale-edge bg-st-failed-pale-body",
    icon: "text-st-failed-pale-fg",
  },
  done: {
    card: "border-st-done-pale-edge bg-st-done-pale-body",
    icon: "text-st-done-pale-fg",
  },
  interrupted: {
    card: "border-st-interrupted-pale-edge bg-st-interrupted-pale-body",
    icon: "text-st-interrupted-pale-fg",
  },
};

function currentStepLabel(nodes: readonly NodeExecution[], runStatus: string | undefined): string {
  const ordered = [...nodes].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const active =
    ordered.find((n) => n.status === "waiting") ??
    ordered.find((n) => n.status === "running" || n.status === "leased" || n.status === "ready") ??
    ordered.find(
      (n) => n.status === "failed" || n.status === "interrupted" || n.status === "cancelled",
    ) ??
    ordered.find((n) => n.status === "pending");
  if (active) return stepWordOf(active.node_instance_key);
  if (runStatus === "completed") return "done";
  if (ordered.length > 0) return stepWordOf(ordered[ordered.length - 1].node_instance_key);
  return runStatus === "queued" || runStatus === "preparing" ? "queued" : "—";
}

export interface RunCardProps {
  runId: string;
  workflowName?: string;
}

export function RunCard({ runId, workflowName }: RunCardProps) {
  const run = useRun(runId);
  const nodesQuery = useRunNodes(runId);
  const pipelines = usePipelines();

  const pipeline = run.data
    ? (pipelines.data?.pipelines ?? []).find((p) => p.id === run.data?.pipeline_id)
    : undefined;
  const displayName =
    workflowName ??
    pipeline?.display_name ??
    pipeline?.slug ??
    run.data?.title ??
    `run #${shortId(runId)}`;

  const state = runCardState(run.data?.status);
  const palette = CARD_CLASS[state.word];
  const nodes = nodesQuery.data?.node_executions ?? [];
  const segments = compressRunSegments(nodes, 5);
  const stepText = run.isError
    ? "Run details unavailable"
    : currentStepLabel(nodes, run.data?.status);
  const showStep = state.word === "running";

  return (
    <div
      data-testid={`run-card-${runId}`}
      className={`flex items-center gap-[14px] rounded-[12px] border px-[16px] py-[12px] max-md:flex-wrap ${palette.card}`}
    >
      <IconBuildingFactory2
        size={18}
        stroke={1.5}
        aria-hidden="true"
        className={`shrink-0 ${palette.icon}`}
      />

      <div className="flex min-w-0 flex-1 flex-col gap-[7px]">
        <div className="flex items-baseline justify-between gap-[12px]">
          <span className="min-w-0 truncate text-[13.5px] font-semibold text-ink">
            {displayName}
          </span>
          <span
            data-testid={`run-card-state-${runId}`}
            className={`shrink-0 font-mono text-[11px] ${state.textClass}`}
          >
            <span aria-hidden="true">{state.glyph} </span>
            {state.word}
            {showStep ? (
              <>
                {" · "}
                <span data-testid="run-card-step">{stepText}</span>
              </>
            ) : null}
          </span>
        </div>

        <div
          data-testid="run-card-strip"
          role="img"
          aria-label={`${segments.filter((s) => s === "done").length} of ${segments.length} steps done`}
          className="flex h-[5px] gap-[2px]"
        >
          {segments.map((seg, index) => (
            <span
              key={index}
              data-testid={`run-card-segment-${index}`}
              data-segment-state={seg}
              className={`flex-1 rounded-[2px] ${SEGMENT_CLASS[seg]}`}
            />
          ))}
        </div>
      </div>

      <Link
        to={routes.run(runId)}
        data-testid="run-card-open"
        className="shrink-0 text-[12.5px] font-semibold text-accent-text hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent max-md:min-h-[44px] max-md:inline-flex max-md:items-center"
      >
        Open in Factory
      </Link>
    </div>
  );
}
