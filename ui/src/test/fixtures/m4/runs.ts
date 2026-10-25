/**
 * Run fixtures shaped like contract § 2 routes 23–33 and § 3 events.
 *
 * The identity rule comes from `01` invariant 6 and the `node_executions`
 * CHECK in contract § 1: `node_instance_key` is a text path of node ids with
 * `[n]` iteration/index suffixes (`/plan`, `/build_until_verified[2]/review`),
 * never a position index. Every key below satisfies that regex, and the
 * attempt lists carry the retry arms ADR-0023 § 6/§ 8 defines — including the
 * `interrupted` attempt whose `retry_context` says what the next attempt
 * inherits, which is the honest content W11 asserts.
 */
import type {
  AttemptDetail,
  NodeExecutionSummary,
  RunCheckpoint,
  RunDetail,
  RunEvent,
  NodeExecutionStatus,
  RunTreeRoot,
} from "../../../lib/pipeline/contract";

const REVISION = "sha256:3f2f6e6a7ad1b1d8f4f3f4e4f9dfaf2b6bb2f43f4e4b41d8e4f4d2f4f4d4f4ab";
const PLAN = "sha256:0d0c7b3a6a5b4f2e1d0c9b8a7f6e5d4c3b2a190817161514131211100f0e0d0c";

export const featureRun: RunDetail = {
  id: "01J8RUNFEATURE0000000000A",
  project_id: "prj_01J8ACME",
  pipeline_id: "pl_01J8FEATUREDEV",
  pipeline_revision_id: "rev_01J8A",
  assignment_id: "as_01J8A",
  revision_digest: REVISION,
  plan_digest: PLAN,
  digest_scope: "v1alpha1-canonical-1",
  // The gate is *behind* this run: `approve` precedes the loop in § 9.3, so a run
  // with loop rows cannot also be waiting on that gate. The waiting run is
  // `gateRun` below — one narrative per run, no impossible mid-states.
  status: "running",
  failed_cause: null,
  paused_reason: null,
  cancel_requested_at: null,
  depth: 0,
  parent_run_id: null,
  placement: { scheduled: true },
  expression_evaluations: 96,
  created_at: "2026-07-31T10:02:11Z",
  started_at: "2026-07-31T10:02:14Z",
  finished_at: null,
  // W4: a newer revision exists; the run stays pinned and says so.
  latest_revision_number: 8,
};

/**
 * A run of the same revision still sitting at its gate — the run `pendingApproval`
 * belongs to. § 9.3 puts `approve` before the loop, so this is the only shape in
 * which `waiting_human` and a live gate coexist.
 */
export const gateRun: RunDetail = {
  ...featureRun,
  id: "01J8RUNGATE000000000000",
  status: "waiting_human",
  started_at: "2026-07-31T10:44:02Z",
};

/**
 * The gate answered `rejected`, and the run later failed DOWNSTREAM on its
 * own terms: a rejection is a business outcome, not an execution failure
 * (`docs/m4-contract.md` § 5.3, C9e), so the cause names the node that
 * actually failed — never `/approve`.
 */
export const decidedRun: RunDetail = {
  ...gateRun,
  id: "01J8RUNREJECTED000000000",
  status: "failed",
  failed_cause: "node_execution_failed:/verify",
  finished_at: "2026-07-31T14:02:19Z",
};

/** A run interrupted by a dead worker (W5/W6's arm). */
export const interruptedRun: RunDetail = {
  ...featureRun,
  id: "01J8RUNINTERRUPT00000000B",
  status: "interrupted",
  failed_cause: "worker_lease_expired",
  placement: { scheduled: false, reason: "volume_affinity_unsatisfied" },
  finished_at: null,
};

/** A ref as the API serializes one: an id, a name, and the artifact's own
 * digest (never the revision's — the UI must not confuse them). */
const DIGESTS: Record<string, string> = {
  "test-result.json": "sha256:7d7d7d7d0b8c0a2e4d6b8c0a2e4d6b8c0a2e4d6b8c0a2e4d6b8c0a2e4d6b8c0a",
  "implement-summary.json": "sha256:9c1f7a2e4d6b8c0a2e4d6b8c0a2e4d6b8c0a2e4d6b8c0a2e4d6b8c0a2e4d6b",
  "modified-paths.json": "sha256:2a2a2a2a4d6b8c0a2e4d6b8c0a2e4d6b8c0a2e4d6b8c0a2e4d6b8c0a2e4d6b8c",
};

const evidence = (name: string, id: string) => ({
  id,
  name,
  kind: "json",
  sha256:
    DIGESTS[name] ??
    `sha256:000000000000000000000000000000000000000000000000000000000000${id.slice(-2)}`,
  size_bytes: 4096,
  sensitivity: "standard" as const,
});

type Row = Partial<NodeExecutionSummary> & {
  node_instance_key: string;
  node_id: string;
  kind: string;
};

const rows = (input: Row[]): NodeExecutionSummary[] =>
  input.map((row, index) => ({
    id: `01J8NODE${String(index).padStart(6, "0")}`,
    run_id: featureRun.id,
    execution_location:
      row.kind === "human.approval" || row.kind === "until" || row.kind === "condition"
        ? "control_plane"
        : "worker",
    status: "succeeded",
    outcome: null,
    error_class: null,
    failed_cause: null,
    attempt_count: 1,
    attempt_limit: row.kind === "agent.acp" ? 2 : 1,
    in_flight: 0,
    waiting_reason: null,
    artifact_refs: [],
    scope_key:
      row.node_instance_key.lastIndexOf("/") <= 0
        ? "/"
        : row.node_instance_key.slice(0, row.node_instance_key.lastIndexOf("/")),
    ready_at: "2026-07-31T10:02:12Z",
    finished_at: "2026-07-31T10:40:00Z",
    ...row,
  })) as NodeExecutionSummary[];

/** The § 9.3 pipeline run once, looping twice before the reviewer approved. */
export const featureNodes: NodeExecutionSummary[] = rows([
  { node_id: "plan", node_instance_key: "/plan", kind: "agent.acp", attempt_count: 1 },
  {
    node_id: "approve",
    node_instance_key: "/approve",
    kind: "human.approval",
    execution_location: "control_plane",
    attempt_limit: 1,
  },
  // The loop's own row is one composite row per scope *node*, carrying its
  // iteration count; the `[n]` suffix belongs to the body instances (C1d's key
  // set), not to a row per iteration.
  {
    node_id: "build_until_verified",
    node_instance_key: "/build_until_verified",
    kind: "until",
    execution_location: "control_plane",
    scope_key: "/",
    status: "running",
    iterations: 2,
    in_flight: 1,
  },
  {
    node_id: "implement",
    node_instance_key: "/build_until_verified[1]/implement",
    kind: "agent.acp",
    scope_key: "/build_until_verified[1]",
    attempt_count: 2,
  },
  {
    node_id: "test",
    node_instance_key: "/build_until_verified[1]/test",
    kind: "process.exec",
    scope_key: "/build_until_verified[1]",
    outcome: "failed",
    error_class: null,
    artifact_refs: [evidence("test-result.json", "art_01")],
  },
  {
    node_id: "review",
    node_instance_key: "/build_until_verified[1]/review",
    kind: "agent.acp",
    scope_key: "/build_until_verified[1]",
    outcome: "approved",
  },
  // Iteration 2 — the same definition nodes, suffixed, never duplicated. Its
  // `implement` lost a worker mid-attempt and the retry inherited the boundary:
  // the *node* succeeded, the *attempt* is where the interruption lives, so the
  // graph must not paint this node interrupted (W5).
  {
    node_id: "implement",
    node_instance_key: "/build_until_verified[2]/implement",
    kind: "agent.acp",
    scope_key: "/build_until_verified[2]",
    attempt_count: 2,
  },
  {
    node_id: "test",
    node_instance_key: "/build_until_verified[2]/test",
    kind: "process.exec",
    scope_key: "/build_until_verified[2]",
    status: "running",
    in_flight: 1,
  },
  {
    node_id: "review",
    node_instance_key: "/build_until_verified[2]/review",
    kind: "agent.acp",
    scope_key: "/build_until_verified[2]",
    status: "pending",
    ready_at: null,
  },
  {
    node_id: "verdict",
    node_instance_key: "/verdict",
    kind: "condition",
    status: "pending",
    ready_at: null,
    finished_at: null,
  },
  // Not reached yet: `pending`, because nothing skipped — a node that never ran
  // cannot claim a decision was made about it.
  {
    node_id: "publish_verified",
    node_instance_key: "/publish_verified",
    kind: "artifact.publish",
    status: "pending",
    ready_at: null,
    finished_at: null,
  },
  {
    node_id: "publish_needs_attention",
    node_instance_key: "/publish_needs_attention",
    kind: "artifact.publish",
    status: "pending",
    ready_at: null,
    finished_at: null,
  },
]);

/** The two rows `gateRun` has: a finished plan, and the gate holding everything. */
export const gateNodes: NodeExecutionSummary[] = rows([
  {
    node_id: "plan",
    node_instance_key: "/plan",
    kind: "agent.acp",
    attempt_count: 1,
    artifact_refs: [evidence("plan.md", "art_01J8PLAN")],
  },
  {
    node_id: "approve",
    node_instance_key: "/approve",
    kind: "human.approval",
    execution_location: "control_plane",
    status: "waiting",
    waiting_reason: "approval",
    attempt_limit: 1,
    attempt_count: 0,
  },
]).map((node) => ({ ...node, run_id: gateRun.id }));

/**
 * `interruptedRun`'s rows: the same run stopped at the same node, but here the
 * interruption is the node's **current** state — the worker's lease expired and
 * no attempt after it succeeded. This is the arm where the tree may say
 * "interrupted — outcome unknown", and the reason that wording belongs to a node
 * state rather than to `featureNodes`' history of attempts.
 */
export const interruptedNodes: NodeExecutionSummary[] = rows([
  { node_id: "plan", node_instance_key: "/plan", kind: "agent.acp", attempt_count: 1 },
  {
    node_id: "approve",
    node_instance_key: "/approve",
    kind: "human.approval",
    execution_location: "control_plane",
    attempt_limit: 1,
  },
  {
    node_id: "build_until_verified",
    node_instance_key: "/build_until_verified",
    kind: "until",
    execution_location: "control_plane",
    scope_key: "/",
    status: "interrupted",
    error_class: "interrupted",
    failed_cause: "worker_lease_expired",
    iterations: 2,
    in_flight: 0,
  },
  {
    node_id: "implement",
    node_instance_key: "/build_until_verified[1]/implement",
    kind: "agent.acp",
    scope_key: "/build_until_verified[1]",
    attempt_count: 1,
  },
  {
    node_id: "test",
    node_instance_key: "/build_until_verified[1]/test",
    kind: "process.exec",
    scope_key: "/build_until_verified[1]",
    outcome: "failed",
  },
  {
    node_id: "review",
    node_instance_key: "/build_until_verified[1]/review",
    kind: "agent.acp",
    scope_key: "/build_until_verified[1]",
    outcome: "approved",
  },
  {
    node_id: "implement",
    node_instance_key: "/build_until_verified[2]/implement",
    kind: "agent.acp",
    scope_key: "/build_until_verified[2]",
    status: "interrupted",
    error_class: "interrupted",
    failed_cause: "worker_lease_expired",
    attempt_count: 1,
  },
  {
    node_id: "test",
    node_instance_key: "/build_until_verified[2]/test",
    kind: "process.exec",
    scope_key: "/build_until_verified[2]",
    status: "pending",
    ready_at: null,
    finished_at: null,
  },
  {
    node_id: "review",
    node_instance_key: "/build_until_verified[2]/review",
    kind: "agent.acp",
    scope_key: "/build_until_verified[2]",
    status: "pending",
    ready_at: null,
    finished_at: null,
  },
  {
    node_id: "verdict",
    node_instance_key: "/verdict",
    kind: "condition",
    status: "pending",
    ready_at: null,
    finished_at: null,
  },
  {
    node_id: "publish_verified",
    node_instance_key: "/publish_verified",
    kind: "artifact.publish",
    status: "pending",
    ready_at: null,
    finished_at: null,
  },
  {
    node_id: "publish_needs_attention",
    node_instance_key: "/publish_needs_attention",
    kind: "artifact.publish",
    status: "pending",
    ready_at: null,
    finished_at: null,
  },
]).map((node) => ({ ...node, run_id: interruptedRun.id }));

/** Iteration 2's `implement`: attempt 1 interrupted, attempt 2 succeeded. */
export const implementAttempts: AttemptDetail[] = [
  {
    id: "01J8ATTEMPT00000000000001",
    node_execution_id: "01J8NODE000007",
    run_id: featureRun.id,
    attempt_number: 1,
    status: "interrupted",
    error_class: "interrupted",
    detail: "the worker stopped answering its lease while the agent was mid-turn",
    output_errors: [],
    scheduled_at: "2026-07-31T10:21:04Z",
    deadline_at: "2026-07-31T10:36:04Z",
    started_at: "2026-07-31T10:21:09Z",
    finished_at: "2026-07-31T10:33:47Z",
    outputs: null,
    outputs_digest: null,
    artifact_refs: [],
    overrides: null,
    retry_context: {
      mode: "continue_workspace",
      prior_conversation_id: "cnv_01J8A",
      prior_turn_id: "trn_01J8A",
      session_mode: "resume_if_supported",
      resolved_session_mode: "new",
      workspace_policy: "keep",
    },
    conversation_id: "cnv_01J8A",
    turn_id: "trn_01J8A",
  },
  {
    id: "01J8ATTEMPT00000000000002",
    node_execution_id: "01J8NODE000007",
    run_id: featureRun.id,
    attempt_number: 2,
    status: "succeeded",
    error_class: null,
    detail: null,
    output_errors: [],
    scheduled_at: "2026-07-31T10:34:47Z",
    deadline_at: "2026-07-31T10:49:47Z",
    started_at: "2026-07-31T10:34:52Z",
    finished_at: "2026-07-31T10:41:19Z",
    outputs: {
      summary: "Implemented the approved plan across 4 files",
      files_changed: ["a.go", "b.go"],
    },
    outputs_digest: "sha256:9c1f7a2e4d6b8c0a2e4d6b8c0a2e4d6b8c0a2e4d6b8c0a2e4d6b8c0a2e4d6b8c",
    artifact_refs: [evidence("implement-summary.json", "art_02")],
    overrides: null,
    retry_context: {
      mode: "continue_workspace",
      prior_conversation_id: "cnv_01J8A",
      prior_turn_id: "trn_01J8A",
      session_mode: "resume_if_supported",
      resolved_session_mode: "new",
      workspace_policy: "keep",
    },
    conversation_id: "cnv_01J8B",
    turn_id: "trn_01J8B",
  },
];

/** A `workspace_lost` attempt — the arm that must offer no auto-retry (W6). */
export const workspaceLostAttempt: AttemptDetail = {
  id: "01J8ATTEMPT00000000000003",
  node_execution_id: "01J8NODE000008",
  run_id: interruptedRun.id,
  attempt_number: 1,
  status: "failed",
  error_class: "workspace_lost",
  detail: "the run volume is not present on any reachable worker; the workspace cannot be reopened",
  output_errors: [],
  scheduled_at: "2026-07-31T11:02:00Z",
  deadline_at: "2026-07-31T11:17:00Z",
  started_at: null,
  finished_at: "2026-07-31T11:02:04Z",
  outputs: null,
  outputs_digest: null,
  artifact_refs: [],
  overrides: null,
  // Nothing is inherited: there is no workspace to keep and no turn to resume.
  retry_context: { mode: "none", workspace_policy: "lost" },
  conversation_id: null,
  turn_id: null,
};

export const featureCheckpoints: RunCheckpoint[] = [
  {
    node_instance_key: "/build_until_verified[2]/implement",
    inputs_digest: "sha256:1111a2e4d6b8c0a2e4d6b8c0a2e4d6b8c0a2e4d6b8c0a2e4d6b8c0a2e4d6b8c",
    outputs_digest: "sha256:9c1f7a2e4d6b8c0a2e4d6b8c0a2e4d6b8c0a2e4d6b8c0a2e4d6b8c0a2e4d6b8c",
    artifact_refs: [evidence("implement-summary.json", "art_02")],
    repo_states: [
      {
        repository_id: "repo_01J8APP",
        base_commit: "4f2a1c8",
        head_commit: "9b3d7e1",
        modified_paths_artifact: evidence("modified-paths.json", "art_03"),
      },
    ],
    volume_id: "vol_01J8A",
    created_at: "2026-07-31T10:41:19Z",
  },
];

/* ------------------------------------------------- the fan-out run (W7) */

export const fanOutRun: RunDetail = {
  id: "01J8RUNFANOUT0000000000C",
  project_id: "prj_01J8ACME",
  pipeline_id: "pl_01J8MODULECHECK",
  pipeline_revision_id: "rev_01J8D",
  assignment_id: "as_01J8B",
  revision_digest: "sha256:ee001f2f3f4f5f6f7f8f9f0f1f2f3f4f5f6f7f8f9f0f1f2f3f4f5f6f7f8f9f0f",
  plan_digest: "sha256:ff001f2f3f4f5f6f7f8f9f0f1f2f3f4f5f6f7f8f9f0f1f2f3f4f5f6f7f8f9f0f",
  digest_scope: "v1alpha1-canonical-1",
  status: "running",
  failed_cause: null,
  paused_reason: null,
  cancel_requested_at: null,
  depth: 0,
  parent_run_id: null,
  placement: { scheduled: true },
  expression_evaluations: 41,
  created_at: "2026-07-31T12:00:00Z",
  started_at: "2026-07-31T12:00:03Z",
  finished_at: null,
};

const moduleNames = [
  "scheduler",
  "runtime",
  "compiler",
  "schema",
  "scheduler_lease",
  "acp_adapter",
  "apm_adapter",
  "git_workspace",
  "secret_materializer",
  "events_log",
  "api_http",
  "api_sse",
  "authz",
  "audit",
  "artifacts",
  "assistant",
  "sandbox_nono",
  "sandbox_none",
  "worker_loop",
  "worker_probe",
  "pipeline_registry",
  "budget_meter",
  "idempotency",
  "reconciler",
  "advancer",
];

/** 25 child runs under `/verify_each[i]` — C8's case: one iteration row, one
 * invocation row and one child run per item, all three identities distinct. */
export const fanOutNodes: NodeExecutionSummary[] = [
  ...rows([
    { node_id: "inventory", node_instance_key: "/inventory", kind: "process.exec" },
    {
      node_id: "verify_each",
      node_instance_key: "/verify_each",
      kind: "for_each",
      status: "running",
      items: 25,
      in_flight: 3,
      attempt_limit: 1,
    },
    {
      node_id: "collect",
      node_instance_key: "/collect",
      kind: "artifact.publish",
      status: "pending",
      ready_at: null,
      finished_at: null,
    },
  ]),
  ...moduleNames.flatMap((_name, index): NodeExecutionSummary[] => {
    const status: NodeExecutionStatus =
      index < 18 ? "succeeded" : index < 21 ? "running" : index === 21 ? "failed" : "pending";
    const finished = status === "succeeded" || status === "failed";
    const invocation = (
      nodeId: string,
      key: string,
      scopeKey: string,
      extra: Partial<NodeExecutionSummary>,
    ): NodeExecutionSummary => ({
      id: `01J8FANODE${nodeId}${String(index).padStart(3, "0")}`,
      run_id: fanOutRun.id,
      node_id: nodeId,
      node_instance_key: key,
      scope_key: scopeKey,
      kind: nodeId === "verify_each" ? "for_each" : "pipeline.invoke",
      execution_location: "control_plane" as const,
      status,
      outcome: status === "succeeded" ? "passed" : null,
      error_class: status === "failed" ? ("agent_error" as const) : null,
      failed_cause: status === "failed" ? "node_execution_failed" : null,
      attempt_count: status === "pending" ? 0 : 1,
      attempt_limit: 1,
      in_flight: status === "running" ? 1 : 0,
      waiting_reason: null,
      artifact_refs: [],
      ready_at: status === "pending" ? null : "2026-07-31T12:01:00Z",
      finished_at: finished ? "2026-07-31T12:09:00Z" : null,
      ...extra,
    });
    return [
      invocation(
        "verify_each",
        `/verify_each[${index + 1}]`,
        "/",
        index === 24 ? { status: "pending", attempt_count: 0, in_flight: 0, ready_at: null } : {},
      ),
      invocation(
        "invoke",
        `/verify_each[${index + 1}]/invoke`,
        `/verify_each[${index + 1}]`,
        index === 24 ? { status: "pending", attempt_count: 0, in_flight: 0, ready_at: null } : {},
      ),
    ];
  }),
];

export const fanOutTree: RunTreeRoot = {
  run_id: fanOutRun.id,
  status: "running",
  depth: 0,
  children: moduleNames.map((_name, index) => ({
    invocation_id: `01J8INVOCATION${String(index).padStart(4, "0")}`,
    node_instance_key: `/verify_each[${index + 1}]/invoke`,
    child_run_id: `01J8CHILD${String(index).padStart(10, "0")}`,
    pipeline_slug: "module-check",
    revision_digest: `sha256:child${String(index).padStart(3, "0")}f3f4f5f6f7f8f9f0f1f2f3f4f5f6f7f8f9f0f1f2f3f4f5f6f7f8f9f0f`,
    depth: 1,
    wait_policy: "completion",
    status: index < 18 ? "completed" : index < 21 ? "running" : index === 21 ? "failed" : "queued",
    expression_evaluations: 3 + (index % 5),
    created_at: "2026-07-31T12:01:00Z",
    started_at: index < 21 ? "2026-07-31T12:01:30Z" : null,
    finished_at: index < 18 ? "2026-07-31T12:09:00Z" : null,
    detached: false,
    children:
      index === 21
        ? [
            {
              invocation_id: "01J8INVOCATIONDEEP",
              node_instance_key: "/build_until_verified[1]/implement",
              child_run_id: "01J8GRANDCHILD0000000001",
              pipeline_slug: "feature-development",
              revision_digest: REVISION,
              depth: 2,
              wait_policy: "completion",
              status: "running",
              expression_evaluations: 7,
              created_at: "2026-07-31T12:04:00Z",
              started_at: "2026-07-31T12:04:20Z",
              finished_at: null,
              detached: false,
            },
          ]
        : [],
  })),
};

/* ------------------------------------------------------ § 3 event stream */

/** W5's sequence: an interrupted attempt, then the retry, then success. */
export const runEvents: RunEvent[] = [
  {
    global_seq: 4181,
    type: "run.created",
    occurred_at: "2026-07-31T10:02:11Z",
    run_id: featureRun.id,
    payload: {
      project_id: featureRun.project_id,
      pipeline_id: featureRun.pipeline_id,
      revision_digest: REVISION,
      plan_digest: PLAN,
      digest_scope: "v1alpha1-canonical-1",
      depth: 0,
      input_names: ["goal", "repository"],
    },
  },
  {
    global_seq: 4196,
    type: "node.attempt.started",
    occurred_at: "2026-07-31T10:21:09Z",
    run_id: featureRun.id,
    node_execution_id: "01J8NODE000007",
    attempt_id: "01J8ATTEMPT00000000000001",
    payload: {
      project_id: featureRun.project_id,
      attempt_number: 1,
      node_instance_key: "/build_until_verified[2]/implement",
    },
  },
  {
    global_seq: 4203,
    type: "node.attempt.interrupted",
    occurred_at: "2026-07-31T10:33:47Z",
    run_id: featureRun.id,
    node_execution_id: "01J8NODE000007",
    attempt_id: "01J8ATTEMPT00000000000001",
    payload: {
      project_id: featureRun.project_id,
      attempt_number: 1,
      reason: "worker_lease_expired",
      node_instance_key: "/build_until_verified[2]/implement",
    },
  },
  {
    global_seq: 4204,
    type: "node.attempt.retry_scheduled",
    occurred_at: "2026-07-31T10:34:47Z",
    run_id: featureRun.id,
    node_execution_id: "01J8NODE000007",
    attempt_id: "01J8ATTEMPT00000000000001",
    payload: {
      project_id: featureRun.project_id,
      attempt_number: 1,
      next_attempt_number: 2,
      scheduled_at: "2026-07-31T10:34:47Z",
      delay_seconds: 10,
      error_class: "interrupted",
    },
  },
  {
    global_seq: 4210,
    type: "run.checkpoint_saved",
    occurred_at: "2026-07-31T10:41:19Z",
    run_id: featureRun.id,
    node_execution_id: "01J8NODE000007",
    attempt_id: "01J8ATTEMPT00000000000002",
    payload: {
      project_id: featureRun.project_id,
      node_instance_key: "/build_until_verified[2]/implement",
      outputs_digest: "sha256:9c1f7a2e4d6b8c0a2e4d6b8c0a2e4d6b8c0a2e4d6b8c0a2e4d6b8c0a2e4d6b8c",
    },
  },
  {
    global_seq: 4214,
    type: "run.waiting_human",
    occurred_at: "2026-07-31T10:44:02Z",
    run_id: featureRun.id,
    node_execution_id: "01J8NODE000001",
    payload: {
      project_id: featureRun.project_id,
      approval_id: "01J8APPROVAL0000000000A",
      node_instance_key: "/approve",
      deadline_at: "2026-08-01T10:44:02Z",
      approver_roles: ["maintainer"],
    },
  },
  {
    global_seq: 4220,
    type: "node.scope.iteration",
    occurred_at: "2026-07-31T10:45:00Z",
    run_id: featureRun.id,
    node_execution_id: "01J8NODE000006",
    payload: {
      project_id: featureRun.project_id,
      node_instance_key: "/build_until_verified[2]",
      iteration: 2,
      pass_when_result: false,
    },
  },
];
