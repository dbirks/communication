/**
 * M4 *wire* fixtures: responses exactly as the frozen OpenAPI 0.4.0-m4 schema
 * serializes them (the generated `components["schemas"]` types), NOT the
 * contract-shaped view models in the sibling fixture files.
 *
 * The distinction is the seam under test. `fixtures/m4/runs.ts` and friends
 * feed the components in fixture mode; everything here feeds the hooks and the
 * `api/m4view.ts` mapping in live mode. A wire fixture therefore carries the
 * members the wire actually has (`depends_on`, `outputs`, the CEL envelope,
 * `{ … }` artifact records) and omits what it does not serve (no `id` on a
 * revision summary, no `pipeline_slug` on a child run) — mapping tests catch
 * any drift between the two halves.
 */
import type {
  Approval,
  ApprovalList,
  AssignmentList,
  Attempt,
  DraftSummaryList,
  EventEnvelope,
  NodeExecution,
  NodeExecutionDetail,
  NodeExecutionList,
  Pipeline,
  PipelineList,
  PipelineRevision,
  Run,
  RunCheckpoint,
  RunSummary,
  RunSummaryList,
  RunTree,
} from "../../../api/types";
import { artifactId, envelopeFixture, meFixture, projectFixture } from "../../../test/fakes";
import { samplePipelineDocument, samplePipelineYaml } from "./samplePipeline";

export const wireProjectId = projectFixture.id;
export const wireUserId = meFixture.id;

export const WIRE_RUN_ID = "01987b11-2b5b-7e4c-8f20-3d4e5f6a7b8c";
export const WIRE_PIPELINE_ID = "01987b20-0000-7000-8000-abcdef012345";
export const WIRE_CHILD_PIPELINE_ID = "01987b20-0001-7000-8000-abcdef012345";
export const WIRE_REVISION_ID = "01987b21-0000-7000-8000-abcdef012345";
export const WIRE_ASSIGNMENT_ID = "01987b22-0000-7000-8000-abcdef012345";
export const WIRE_DRAFT_ID = "01987b23-0000-7000-8000-abcdef012345";
export const WIRE_NODE_PLAN = "01987b24-0000-7000-8000-abcdef012345";
export const WIRE_NODE_LOOP = "01987b24-0001-7000-8000-abcdef012345";
export const WIRE_NODE_IMPLEMENT = "01987b24-0002-7000-8000-abcdef012345";
export const WIRE_ATTEMPT_1 = "01987b25-0000-7000-8000-abcdef012345";
export const WIRE_APPROVAL_ID = "01987b26-0000-7000-8000-abcdef012345";
export const WIRE_CHILD_RUN_ID = "01987b27-0000-7000-8000-abcdef012345";

const REVISION_DIGEST = `sha256:${"3f2f".repeat(32)}`;
const PLAN_DIGEST = `sha256:${"0d0c".repeat(32)}`;

/* --------------------------------------------------------- definitions */

export const wirePipelineList: PipelineList = {
  pipelines: [
    {
      id: WIRE_PIPELINE_ID,
      slug: "feature-development",
      display_name: "Feature development",
      latest_revision_number: 7,
      revision_count: 7,
      archived: false,
    },
    {
      id: WIRE_CHILD_PIPELINE_ID,
      slug: "module-check",
      display_name: "Module check",
      latest_revision_number: 1,
      revision_count: 1,
      archived: false,
    },
  ],
};

/** `GET /pipelines/{id}` — revision summaries, and the wire has no row `id`
 * on a summary (route 5; the digest is the resolvable identity). */
export const wirePipeline: Pipeline = {
  id: WIRE_PIPELINE_ID,
  slug: "feature-development",
  display_name: "Feature development",
  description: "Plan, approve, implement, test, review, loop until verified.",
  created_by: wireUserId,
  created_at: "2026-07-01T10:00:00Z",
  latest_revision_number: 7,
  revision_count: 7,
  archived: false,
  revisions: [
    {
      revision_number: 7,
      version_label: "7.0.0",
      revision_digest: REVISION_DIGEST,
      plan_digest: PLAN_DIGEST,
      digest_scope: "v1alpha1-canonical-1",
      published_at: "2026-07-29T18:40:00Z",
      published_by: wireUserId,
      status: "published",
    },
  ],
};

/** `GET /revisions/{digestOrId}` — the full immutable record. */
export const wireRevision: PipelineRevision = {
  id: WIRE_REVISION_ID,
  pipeline_id: WIRE_PIPELINE_ID,
  draft_id: WIRE_DRAFT_ID,
  revision_number: 7,
  version_label: "7.0.0",
  api_version: "communication.dev/v1alpha1",
  canonical_document: samplePipelineDocument as unknown as Record<string, unknown>,
  document_text: samplePipelineYaml,
  ui_layout: {},
  revision_digest: REVISION_DIGEST,
  digest_scope: "v1alpha1-canonical-1",
  compiled_plan: {},
  plan_digest: PLAN_DIGEST,
  schema_digest: `sha256:${"5a5a".repeat(32)}`,
  cel_env_digest: `sha256:${"6b6b".repeat(32)}`,
  status: "published",
  published_by: wireUserId,
  published_at: "2026-07-29T18:40:00Z",
};

export const wireDraftSummaries: DraftSummaryList = {
  drafts: [
    {
      id: WIRE_DRAFT_ID,
      status: "invalid",
      version: 12,
      updated_at: "2026-07-31T08:12:00Z",
      edited_by: wireUserId,
    },
  ],
};

export const wireAssignmentList: AssignmentList = {
  assignments: [
    {
      id: WIRE_ASSIGNMENT_ID,
      project_id: wireProjectId,
      pipeline_id: WIRE_PIPELINE_ID,
      pinned_revision_id: WIRE_REVISION_ID,
      pinned_revision_digest: REVISION_DIGEST,
      pinned_version_label: "7.0.0",
      max_concurrent_runs: 1,
      budget_overrides: {},
      effective_budgets: {},
      enabled: true,
      version: 1,
      created_at: "2026-07-30T09:00:00Z",
      updated_at: "2026-07-30T09:00:00Z",
    },
  ],
};

/* -------------------------------------------------------------- runs */

export const wireRun: Run = {
  id: WIRE_RUN_ID,
  project_id: wireProjectId,
  pipeline_id: WIRE_PIPELINE_ID,
  pipeline_revision_id: WIRE_REVISION_ID,
  assignment_id: WIRE_ASSIGNMENT_ID,
  revision_digest: REVISION_DIGEST,
  plan_digest: PLAN_DIGEST,
  status: "running",
  failed_cause: null,
  depth: 0,
  parent_run_id: null,
  triggered_by: wireUserId,
  priority: 0,
  created_at: "2026-07-31T10:02:11Z",
  started_at: "2026-07-31T10:02:14Z",
  finished_at: null,
  digest_scope: "v1alpha1-canonical-1",
  paused_reason: null,
  cancel_requested_at: null,
  placement: { scheduled: true },
  expression_evaluations: 96,
  inputs: [{ name: "goal", value: "ship M4", origin: "submitted" }],
};

export const wireRunList: RunSummaryList = {
  runs: [{ ...wireRun } satisfies RunSummary] as RunSummary[],
};

const ref = (name: string) => ({ id: artifactId, name, kind: "json", size_bytes: 2048 });

/** A run mid-loop: the gate decided, iteration 1 in flight. */
export const wireNodeExecutions: NodeExecution[] = [
  {
    id: WIRE_NODE_PLAN,
    run_id: WIRE_RUN_ID,
    node_id: "plan",
    kind: "agent.acp",
    node_instance_key: "/plan",
    scope_key: "/",
    execution_location: "worker",
    status: "succeeded",
    outcome: null,
    failed_cause: null,
    outputs: { summary: "a four-file plan" },
    artifact_refs: [ref("plan.md")],
    depends_on: [],
    attempt_count: 1,
    attempt_limit: 2,
    in_flight: 0,
    waiting_reason: null,
    created_at: "2026-07-31T10:02:12Z",
    ready_at: "2026-07-31T10:02:12Z",
    finished_at: "2026-07-31T10:10:00Z",
  },
  {
    id: WIRE_NODE_LOOP,
    run_id: WIRE_RUN_ID,
    node_id: "build_until_verified",
    kind: "until",
    node_instance_key: "/build_until_verified",
    scope_key: "/",
    execution_location: "control_plane",
    status: "running",
    outcome: null,
    failed_cause: null,
    artifact_refs: [],
    depends_on: ["approve"],
    attempt_count: 1,
    attempt_limit: 1,
    in_flight: 1,
    waiting_reason: null,
    iterations: 2,
    created_at: "2026-07-31T10:10:00Z",
    ready_at: "2026-07-31T10:10:00Z",
    finished_at: null,
  },
  {
    id: WIRE_NODE_IMPLEMENT,
    run_id: WIRE_RUN_ID,
    node_id: "implement",
    kind: "agent.acp",
    node_instance_key: "/build_until_verified[1]/implement",
    scope_key: "/build_until_verified[1]",
    execution_location: "worker",
    status: "running",
    outcome: null,
    failed_cause: null,
    artifact_refs: [],
    depends_on: [],
    attempt_count: 1,
    attempt_limit: 2,
    in_flight: 1,
    waiting_reason: null,
    created_at: "2026-07-31T10:10:05Z",
    ready_at: "2026-07-31T10:10:05Z",
    finished_at: null,
  },
];

export const wireNodeList: NodeExecutionList = { node_executions: wireNodeExecutions };

export const wireAttempt: Attempt = {
  id: WIRE_ATTEMPT_1,
  node_execution_id: WIRE_NODE_IMPLEMENT,
  run_id: WIRE_RUN_ID,
  attempt_number: 1,
  status: "running",
  detail: null,
  output_errors: [],
  scheduled_at: "2026-07-31T10:10:05Z",
  deadline_at: "2026-07-31T10:25:05Z",
  overrides: null,
  retry_context: null,
  artifact_refs: [],
  outputs: null,
  outputs_digest: null,
  conversation_id: null,
  turn_id: null,
  created_at: "2026-07-31T10:10:05Z",
  started_at: "2026-07-31T10:10:09Z",
  finished_at: null,
};

export const wireCheckpoint: RunCheckpoint = {
  run_id: WIRE_RUN_ID,
  node_execution_id: WIRE_NODE_IMPLEMENT,
  attempt_id: WIRE_ATTEMPT_1,
  node_instance_key: "/build_until_verified[1]/implement",
  inputs_digest: `sha256:${"1111".repeat(32)}`,
  outputs_digest: `sha256:${"2222".repeat(32)}`,
  repo_states: [
    {
      repository_id: "01987b28-0000-7000-8000-abcdef012345",
      base_commit: "4f2a1c8d".padEnd(40, "0"),
      head_commit: "9b3d7e1f".padEnd(40, "0"),
      modified_paths_artifact: artifactId,
    },
  ],
  artifact_refs: [ref("implement-summary.json")],
  workspace_id: "01987b29-0000-7000-8000-abcdef012345",
  volume_id: `sha256:${"7c1f".repeat(32)}`,
  worker_id: "01987b2a-0000-7000-8000-abcdef012345",
  plan_digest: PLAN_DIGEST,
  created_at: "2026-07-31T10:41:19Z",
};

export const wireNodeDetail: NodeExecutionDetail = {
  ...wireNodeExecutions[2],
  attempts: [wireAttempt],
  checkpoint: wireCheckpoint,
  cel_envelope: { status: "running", outcome: null, outputs: {}, artifact_refs: [] },
};

const childRunSummary: RunSummary = {
  id: WIRE_CHILD_RUN_ID,
  project_id: wireProjectId,
  pipeline_id: WIRE_CHILD_PIPELINE_ID,
  pipeline_revision_id: WIRE_REVISION_ID,
  assignment_id: null,
  revision_digest: REVISION_DIGEST,
  plan_digest: PLAN_DIGEST,
  status: "running",
  failed_cause: null,
  depth: 1,
  parent_run_id: WIRE_RUN_ID,
  triggered_by: null,
  priority: 0,
  created_at: "2026-07-31T12:01:00Z",
  started_at: "2026-07-31T12:01:30Z",
  finished_at: null,
};

/** The wire's tree: a child *is* a run summary; there is no `pipeline_slug`
 * member anywhere (§ 2 route 26), which is what `viewRunTree` must survive. */
export const wireTree: RunTree = {
  run: { ...wireRun },
  node_instance_key: null,
  wait_policy: null,
  depth: 0,
  children: [
    {
      run: childRunSummary,
      node_instance_key: "/build_until_verified[1]/implement",
      wait_policy: null,
      depth: 1,
      children: [],
    },
  ],
};

/* ---------------------------------------------------------- approvals */

export const wireApproval: Approval = {
  id: WIRE_APPROVAL_ID,
  project_id: wireProjectId,
  run_id: WIRE_RUN_ID,
  node_execution_id: WIRE_NODE_PLAN,
  node_instance_key: "/approve",
  kind: "pipeline_gate",
  summary: "The plan is ready — approving starts the loop; rejecting records the decision.",
  artifact_refs: [ref("plan.md")],
  approver_roles: ["maintainer"],
  approver_user_ids: [wireUserId],
  deadline_at: "2026-08-01T10:44:02Z",
  on_timeout: "fail",
  re_requested: false,
  state: "pending",
  decision: null,
  comments: null,
  decided_by: null,
  decided_at: null,
  version: 1,
  created_at: "2026-07-31T10:44:02Z",
};

export const wireApprovalList: ApprovalList = { approvals: [wireApproval] };

/* ------------------------------------------------------------ events */

let wireSeq = 9000;

/**
 * One journal frame for the run stream, `event_id` unique per call: replay
 * and duplicate tolerance (ADR-0014) is only observable when a fixture would
 * otherwise reuse identifiers and hide the bug.
 */
export function wireRunEvent(
  type: string,
  payload: Record<string, unknown> = {},
  overrides: Partial<EventEnvelope> = {},
): EventEnvelope {
  const seq = typeof overrides.global_seq === "number" ? overrides.global_seq : ++wireSeq;
  return envelopeFixture({
    event_id: `01987c00-${String(seq).padStart(4, "0")}-7000-8000-abcdef012345`,
    type,
    global_seq: seq,
    project_id: wireProjectId,
    conversation_id: null,
    run_id: WIRE_RUN_ID,
    actor: { kind: "system", id: "system" },
    payload: { project_id: wireProjectId, run_id: WIRE_RUN_ID, ...payload },
    ...overrides,
  });
}
