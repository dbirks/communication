/**
 * The run-stream projection (`docs/m4-contract.md` § 3, ADR-0014 § 5/§ 8).
 *
 * Like the conversation transcript, the run screen folds journal frames over
 * the rows it fetched: a `node.attempt.completed` repaints its node the moment
 * the frame arrives, and the next `GET /runs/{id}/nodes` is the authority that
 * confirms it. Nothing invented here: every patch names a field the event
 * itself carries, and a frame about a row the screen has never seen is a no-op
 * (the invalidation, not this fold, brings the new row).
 *
 * Gap-safety per ADR-0014: `EventSource` replays from `Last-Event-ID`, so the
 * same `global_seq` or `event_id` can arrive twice, and a frame can land out of
 * arrival order after a reconnect. `normalizeRunFrames` dedupes on both ids and
 * sorts by the journal cursor, so the fold is order-independent — the same
 * argument `projectTranscript` makes for the conversation stream.
 */
import type { EventEnvelope } from "../../api/types";
import type {
  ApprovalDetail,
  ApprovalState,
  AttemptDetail,
  AttemptStatus,
  NodeExecutionSummary,
  RunDetail,
  RunEvent,
  RunEventType,
  RunStatus,
} from "./contract";

/**
 * Run-scoped types, spelled exactly as `internal/pipelines/events` emits them
 * (the § 3 table): `run.*`, `node.*`, `approval.*`. A consumer must ignore the
 * types it does not know (ADR-0014 § 8), so this list bounds what the run
 * stream *subscribes*, not what the journal contains.
 */
export const M4_RUN_EVENT_TYPES = [
  "run.created",
  "run.started",
  "run.paused",
  "run.resumed",
  "run.waiting_human",
  "run.retried",
  "run.checkpoint_saved",
  "run.checkpoint_restored",
  "run.completed",
  "run.failed",
  "run.cancel_requested",
  "run.cancelled",
  "run.interrupted",
  "node.execution_skipped",
  "node.execution_cancelled",
  "node.scope.started",
  "node.scope.iteration",
  "node.scope.completed",
  "node.scope.failed",
  "node.attempt.started",
  "node.attempt.completed",
  "node.attempt.failed",
  "node.attempt.interrupted",
  "node.attempt.cancelled",
  "node.attempt.retry_scheduled",
  "approval.requested",
  "approval.decided",
  "approval.expired",
  "approval.denied",
  "approval.cancelled",
] as const satisfies readonly RunEventType[];

/** Definition-library types (§ 3's last block) — project-stream vocabulary. */
export const M4_PIPELINE_EVENT_TYPES = [
  "pipeline.created",
  "pipeline.draft.updated",
  "pipeline.draft.validated",
  "pipeline.revision.published",
  "pipeline.revision.deprecated",
  "assignment.created",
  "assignment.updated",
] as const;

/** Everything M4 adds to the project scope. */
export const M4_PROJECT_EVENT_TYPES = [...M4_RUN_EVENT_TYPES, ...M4_PIPELINE_EVENT_TYPES] as const;

export function isRunEventType(type: string): type is RunEventType {
  return (M4_RUN_EVENT_TYPES as readonly string[]).includes(type);
}

/**
 * An envelope → the `RunEvent` shape the components read. Frames whose `type`
 * is outside M4's run vocabulary (a reused M2/M3 conversation or workspace row)
 * project to null: the screen renders what it has words for and ignores the
 * rest, which is exactly ADR-0014 § 8's consumer rule.
 */
export function toRunEvent(event: EventEnvelope): RunEvent | null {
  if (!isRunEventType(event.type) || !event.run_id) return null;
  return {
    global_seq: event.global_seq,
    type: event.type,
    occurred_at: event.occurred_at,
    run_id: event.run_id,
    ...(event.node_execution_id !== undefined
      ? { node_execution_id: event.node_execution_id }
      : {}),
    ...(event.attempt_id !== undefined ? { attempt_id: event.attempt_id } : {}),
    payload: (event.payload ?? {}) as RunEvent["payload"],
  };
}

/**
 * Dedupe by `event_id` *and* `global_seq`, then order by the journal cursor.
 * Replays and out-of-order arrivals fold exactly once — the two tolerances
 * ADR-0014 § 5 grants a gap-safe consumer.
 */
export function normalizeRunFrames(events: readonly EventEnvelope[]): EventEnvelope[] {
  const seenEvent = new Set<string>();
  const seenSeq = new Set<number>();
  const frames: EventEnvelope[] = [];
  for (const event of events) {
    if (seenEvent.has(event.event_id) || seenSeq.has(event.global_seq)) continue;
    seenEvent.add(event.event_id);
    seenSeq.add(event.global_seq);
    frames.push(event);
  }
  return frames.sort((a, b) => a.global_seq - b.global_seq);
}

function num(payload: Record<string, unknown>, key: string): number | null {
  const value = payload[key];
  return typeof value === "number" ? value : null;
}

function str(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" ? value : null;
}

/** `/build_until_verified[2]` → `/build_until_verified`: a scope's own row. */
function scopeRowOf(key: string): string {
  return key.replace(/\[\d+\]$/, "");
}

/** `run.*` terminal/lifecycle arms — the run machine, `01`, event-for-column.
 * `run.resumed` is deliberately absent: the frame names the park it clears in
 * its `paused_reason` member, and the destination state differs by park — a
 * gate's park ends `waiting_human → running` while a manual pause ends
 * `paused → queued`. The fold's own arm for the frame reads that member.
 */
const RUN_STATUS_BY_TYPE: Partial<Record<RunEventType, RunStatus>> = {
  "run.started": "running",
  "run.paused": "paused",
  "run.waiting_human": "waiting_human",
  "run.completed": "completed",
  "run.failed": "failed",
  "run.cancelled": "cancelled",
  "run.interrupted": "interrupted",
};

/**
 * The gate rows that end a gate's claim on a human (`01`, `docs/m4-contract.md`
 * § 5.3). Deciding, denying, expiring or cancelling a gate is the *only* thing
 * the journal records for the run leaving `waiting_human`: the decide path
 * flips `runs.status` in the same commit as `approval.decided` and lets the
 * advancer re-derive readiness, and the advancer itself moves the run
 * `waiting_human → running` and journals a `run.resumed` whose
 * `paused_reason` is `waiting_human` when the last pending gate ends
 * (`runtime`'s `resumeIfNoGates`). The manual pause/resume and retry arms
 * journal the same type for `paused → queued`. Folding a gate's end as
 * "no longer parked on a human" is therefore what the stream actually says,
 * and it is what keeps the run header honest.
 */
const GATE_ENDED_TYPES: ReadonlySet<RunEventType> = new Set<RunEventType>([
  "approval.decided",
  "approval.denied",
  "approval.expired",
  "approval.cancelled",
]);

/** Frames that prove work is moving again under the run row. */
const WORK_IN_FLIGHT_TYPES: ReadonlySet<RunEventType> = new Set<RunEventType>([
  "node.attempt.started",
  "node.scope.started",
]);

/** The run machine as the server enforces it (`runtime`'s `runTransitions`,
 * `01`): which status may follow which — terminal rows go nowhere. The fold
 * uses it, and only it, to judge a journal frame's destination against the
 * refetched API row: a frame may move the run status only *forward* from the
 * baseline it was folded onto, because a frame journaled before the fetch is
 * already reflected in that row. `queued` in particular is reachable only
 * from `paused` (or the retry arm off `interrupted`) — never from
 * `running`, which is exactly how a stale takeover-return `run.resumed`
 * (`paused → queued`, with no `run.*` frame for the run starting to execute
 * again) would otherwise pin `queued` over a fresh API `running`. */
const RUN_STATUS_FORWARD: Readonly<Record<RunStatus, ReadonlySet<RunStatus>>> = {
  queued: new Set<RunStatus>([
    "preparing",
    "running",
    "paused",
    "completed",
    "failed",
    "cancelled",
    "interrupted",
  ]),
  preparing: new Set<RunStatus>([
    "running",
    "paused",
    "completed",
    "failed",
    "cancelled",
    "interrupted",
  ]),
  running: new Set<RunStatus>([
    "waiting_human",
    "paused",
    "completed",
    "failed",
    "cancelled",
    "interrupted",
  ]),
  waiting_human: new Set<RunStatus>([
    "running",
    "waiting_human",
    "paused",
    "completed",
    "failed",
    "cancelled",
    "interrupted",
  ]),
  paused: new Set<RunStatus>([
    "queued",
    "running",
    "waiting_human",
    "completed",
    "failed",
    "cancelled",
    "interrupted",
  ]),
  interrupted: new Set<RunStatus>(["queued", "running", "failed", "cancelled"]),
  completed: new Set<RunStatus>(),
  failed: new Set<RunStatus>(),
  cancelled: new Set<RunStatus>(),
};

const APPROVAL_STATE_BY_TYPE: Partial<Record<RunEventType, ApprovalState>> = {
  "approval.requested": "pending",
  "approval.decided": "decided",
  "approval.expired": "expired",
  "approval.denied": "denied",
  "approval.cancelled": "cancelled",
};

const ATTEMPT_STATUS_BY_TYPE: Partial<Record<RunEventType, AttemptStatus>> = {
  "node.attempt.started": "running",
  "node.attempt.completed": "succeeded",
  "node.attempt.failed": "failed",
  "node.attempt.interrupted": "interrupted",
  "node.attempt.cancelled": "cancelled",
};

/**
 * A worker attempt is *live* work under a node row: the node moved with it.
 * `retry_scheduled` keeps the node running-in-place (the next attempt is
 * already owed); the node's own terminal rows arrive as `node.execution_*` or
 * a later attempt event, which is why `failed` below never claims the node
 * finally failed — only the refetched row may say that.
 */
const NODE_STATUS_BY_ATTEMPT_TYPE: Partial<Record<RunEventType, NodeExecutionSummary["status"]>> = {
  "node.attempt.started": "running",
  "node.attempt.completed": "succeeded",
  "node.attempt.failed": "failed",
  "node.attempt.interrupted": "interrupted",
  "node.attempt.cancelled": "cancelled",
  "node.attempt.retry_scheduled": "running",
};

export interface RunBaseline {
  run?: RunDetail | null;
  nodes?: readonly NodeExecutionSummary[];
  attempts?: readonly AttemptDetail[];
  approvals?: readonly ApprovalDetail[];
}

export interface RunProjection {
  /** Frames folded, in journal order, each once. */
  frames: EventEnvelope[];
  run: RunDetail | null;
  nodes: NodeExecutionSummary[];
  attempts: AttemptDetail[];
  approvals: ApprovalDetail[];
}

/**
 * Fold run-stream frames over the fetched rows. Every array identity changes
 * only when its rows changed, so React Query + the components repaint the
 * minimum. A frame naming a row this screen never received is ignored —
 * inventing a row from an event would be drawing state the API did not serve.
 */
export function projectRun(baseline: RunBaseline, events: readonly EventEnvelope[]): RunProjection {
  const frames = normalizeRunFrames(events);
  let run = baseline.run ?? null;
  let nodes = [...(baseline.nodes ?? [])];
  let attempts = [...(baseline.attempts ?? [])];
  let approvals = [...(baseline.approvals ?? [])];

  for (const event of frames) {
    if (!isRunEventType(event.type)) continue;
    const type: RunEventType = event.type;
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const key = str(payload, "node_instance_key");

    // 1. The run row.
    const runStatus = RUN_STATUS_BY_TYPE[type];
    if (run && run.id === (event.run_id ?? run.id)) {
      const patch: Partial<RunDetail> = {};
      if (runStatus) patch.status = runStatus;
      // A run parked `waiting_human` with no gate left to answer is not parked.
      // The frames arrive in journal order, so a *later* `run.waiting_human`
      // (the advancer parking the run on the next gate) re-applies the park
      // over this un-park — the fold never has to guess which came first.
      if (run.status === "waiting_human" && !runStatus)
        if (GATE_ENDED_TYPES.has(type) || WORK_IN_FLIGHT_TYPES.has(type)) patch.status = "running";

      if (type === "run.started") patch.started_at = event.occurred_at;
      if (type === "run.paused") {
        const reason = str(payload, "paused_reason");
        if (reason === "manual" || reason === "human_takeover" || reason === "worker_unavailable")
          patch.paused_reason = reason;
      }
      if (type === "run.resumed") {
        // One type, two destinations: the member names the park the frame
        // clears. A gate's park (the advancer leaves `waiting_human` for the
        // run's next work) must not read "queued" in the header while the API
        // row says `running` — and the fold replays the journal's whole tail
        // over every refetched baseline, so a wrong mapping on the last
        // lifecycle frame would win forever.
        const reason = str(payload, "paused_reason");
        patch.status =
          reason === "waiting_human" || run.status === "waiting_human" ? "running" : "queued";
        patch.paused_reason = null;
      }
      // `cancel_requested_at` is the request, not the stop — the run stays in
      // its live state until `run.cancelled` proves otherwise.
      if (type === "run.cancel_requested") patch.cancel_requested_at = event.occurred_at;
      if (type === "run.failed") patch.failed_cause = str(payload, "failed_cause") ?? null;
      if (type === "run.interrupted") patch.failed_cause = str(payload, "reason") ?? null;
      if (type === "run.cancelled") patch.finished_at = event.occurred_at;
      if (type === "run.completed" || type === "run.failed") patch.finished_at = event.occurred_at;
      if (Object.keys(patch).length > 0) run = { ...run, ...patch };
    }

    // 2. A node execution row: envelope id first (the correlation rule — a
    // worker row that touches a node sets all three ids), then the payload key.
    const nodeIndex = findNode(nodes, event, key);
    if (nodeIndex >= 0) {
      const node = nodes[nodeIndex];
      const patch: Partial<NodeExecutionSummary> = {};
      if (type === "node.execution_skipped") patch.status = "skipped";
      if (type === "node.execution_cancelled") patch.status = "cancelled";
      if (type === "node.scope.started") patch.status = "running";
      if (type === "node.scope.completed") {
        patch.status = "succeeded";
        patch.finished_at = event.occurred_at;
      }
      if (type === "node.scope.failed") {
        patch.status = "failed";
        patch.failed_cause = str(payload, "failed_cause") ?? node.failed_cause;
        patch.finished_at = event.occurred_at;
      }
      const iteration = num(payload, "iteration");
      if (iteration !== null && (node.kind === "until" || type === "node.scope.iteration"))
        patch.iterations = Math.max(node.iterations ?? 0, iteration);
      const items = num(payload, "items");
      if (items !== null && type === "node.scope.completed")
        patch.items = Math.max(node.items ?? 0, items);
      const nodeStatus = NODE_STATUS_BY_ATTEMPT_TYPE[type];
      if (nodeStatus && event.attempt_id) {
        patch.status = nodeStatus;
        const attemptNumber = num(payload, "next_attempt_number") ?? num(payload, "attempt_number");
        if (attemptNumber !== null)
          patch.attempt_count = Math.max(node.attempt_count, attemptNumber);
        if (nodeStatus === "failed" || nodeStatus === "interrupted") {
          const errorClass = str(payload, "error_class");
          if (errorClass) patch.error_class = errorClass as NodeExecutionSummary["error_class"];
        }
        if (nodeStatus === "succeeded") patch.finished_at = event.occurred_at;
      }
      if (Object.keys(patch).length > 0)
        nodes = nodes.map((row, index) => (index === nodeIndex ? { ...row, ...patch } : row));
    }

    // 3. An attempt row — envelope `attempt_id` is the join (§ 3's correlation
    // rule: a worker row that touches an attempt sets the column, not only the
    // payload copy).
    if (event.attempt_id) {
      const attemptStatus = ATTEMPT_STATUS_BY_TYPE[type];
      attempts = attempts.map((attempt) => {
        if (attempt.id !== event.attempt_id) return attempt;
        const patch: Partial<AttemptDetail> = {};
        if (attemptStatus) patch.status = attemptStatus;
        if (type === "node.attempt.started") patch.started_at = event.occurred_at;
        if (type === "node.attempt.failed" || type === "node.attempt.interrupted") {
          patch.error_class =
            (str(payload, "error_class") as AttemptDetail["error_class"]) ??
            (type === "node.attempt.interrupted" ? "interrupted" : attempt.error_class);
          patch.detail = str(payload, "detail") ?? attempt.detail;
        }
        if (type === "node.attempt.completed") {
          patch.outputs_digest = str(payload, "outputs_digest") ?? attempt.outputs_digest;
          patch.finished_at = event.occurred_at;
        }
        if (type === "node.attempt.failed" || type === "node.attempt.cancelled")
          patch.finished_at = event.occurred_at;
        return { ...attempt, ...patch };
      });
    }

    // 4. An approval row. `approval.requested` for a gate this screen has
    // never seen is *not* fabricated from the digest-carrying journal — the
    // invalidation refetches `GET /projects/{id}/approvals` for the full text.
    const approvalId = str(payload, "approval_id");
    const approvalState = APPROVAL_STATE_BY_TYPE[type];
    if (approvalId && approvalState) {
      approvals = approvals.map((approval) => {
        if (approval.id !== approvalId) return approval;
        const patch: Partial<ApprovalDetail> = { state: approvalState };
        if (type === "approval.decided") {
          patch.decision = str(payload, "decision") as ApprovalDetail["decision"];
          patch.decided_by = str(payload, "decided_by") ?? approval.decided_by;
          patch.decided_at = event.occurred_at;
          const version = num(payload, "version");
          if (version !== null) patch.version = version;
        }
        return { ...approval, ...patch };
      });
    }
  }

  // The fold replays the journal's whole tail over *every* refetched baseline
  // (the buffer is not trimmed to frames since the fetch — the same frame
  // may have arrived before or after it), so the final status is checked
  // against the row the API served: a journal frame may only move the run
  // status FORWARD from that baseline along the run machine. Anything else
  // is a frame the fetch already saw committed, and the refetched row wins.
  const base = baseline.run;
  if (run && base && run.status !== base.status && !RUN_STATUS_FORWARD[base.status].has(run.status))
    run = { ...run, status: base.status, paused_reason: base.paused_reason };

  return { frames, run, nodes, attempts, approvals };
}

/** Envelope-id join wins; then the payload key; then the scope row a `[n]`
 * key is a place inside (`/x[2]` events report against `/x`'s composite row). */
function findNode(
  nodes: readonly NodeExecutionSummary[],
  event: EventEnvelope,
  key: string | null,
): number {
  if (event.node_execution_id) {
    const byId = nodes.findIndex((node) => node.id === event.node_execution_id);
    if (byId >= 0) return byId;
  }
  if (key) {
    const byKey = nodes.findIndex((node) => node.node_instance_key === key);
    if (byKey >= 0) return byKey;
    const byScope = nodes.findIndex((node) => node.node_instance_key === scopeRowOf(key));
    if (byScope >= 0) return byScope;
  }
  return -1;
}
