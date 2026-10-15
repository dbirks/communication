/**
 * Shapes from `docs/m4-contract.md` § 2 (routes) and § 3 (events).
 *
 * These are **not** OpenAPI-generated: the M4 routes are not in
 * `api/openapi.yaml` yet (that file is M1–M3 and is edited by the M4 backend
 * worker, not by UI work). The rule in `docs/design/README.md` ("Contract
 * gaps") is that the UI reads the contract's shapes verbatim rather than
 * inventing its own, so every member name below is the contract's snake_case
 * wire name and every enum is copied from the contract's DDL/§ 2 tables.
 * When the routes land in `api/openapi.yaml` these types become
 * `components["schemas"][...]` renames in `src/api/types.ts` and this file is
 * deleted — nothing else should change.
 */

/* ------------------------------------------------------- § 2 definitions */

/** `GET /api/v1/pipelines` (route 1). */
export interface PipelineSummary {
  id: string;
  slug: string;
  display_name: string;
  description?: string;
  latest_revision_number: number | null;
  revision_count: number;
  archived: boolean;
}

export type RevisionStatus = "published" | "deprecated";

/** `GET /api/v1/pipelines/{pipelineId}/revisions` (route 5). Never a body. */
export interface PipelineRevisionSummary {
  id: string;
  revision_number: number;
  version_label: string;
  revision_digest: string;
  plan_digest: string;
  digest_scope: string;
  published_at: string;
  published_by: string;
  status: RevisionStatus;
}

export type DraftStatus = "draft" | "validating" | "valid" | "invalid" | "published";

/** `GET /api/v1/pipelines/{pipelineId}/drafts` (route 6). */
export interface PipelineDraftSummary {
  id: string;
  status: DraftStatus;
  version: number;
  updated_at: string;
  edited_by: string;
}

export type ValidationSource = "loader" | "schema" | "compiler";

/** One unit of the § 2.2 validate body. `source` is ordered, never merged. */
export interface ValidationIssue {
  code: string;
  source: ValidationSource;
  message: string;
  /** JSON pointer into the document, e.g. `/spec/nodes/2/config/passWhen`. */
  instance_location: string | null;
  schema_location: string | null;
  hint?: string | null;
}

/** `POST /api/v1/drafts/{draftId}/validate` (§ 2.2), verbatim. */
export interface ValidateBody {
  valid: boolean;
  revision_digest: string | null;
  plan_digest: string | null;
  digest_scope: string;
  errors: ValidationIssue[];
  notes: string[];
}

/** `GET /api/v1/drafts/{draftId}` (route 8). */
export interface DraftDocument {
  document_yaml: string;
  ui_layout: Record<string, unknown>;
  status: DraftStatus;
  version: number;
  /** The last validate body, served verbatim so a reload need not revalidate. */
  validation: ValidateBody | null;
}

/** `GET /api/v1/revisions/{digestOrId}` (route 13). */
export interface RevisionRecord extends PipelineRevisionSummary {
  canonical_document: unknown;
  document_text: string;
  schema_digest: string;
  cel_env_digest: string;
}

/**
 * Channel labels are `07` "Version rollout" (M6): they are *labels on an
 * assignment target*, resolved to a pinned revision at run creation. A
 * channel that has never been set is absent, and the library renders the
 * absence rather than implying "latest".
 */
export interface AssignmentChannelLabel {
  channel: "stable" | "beta";
  revision_digest: string;
  version_label: string;
}

/** `GET /api/v1/projects/{projectId}/assignments` (route 17). */
export interface AssignmentSummary {
  id: string;
  project_id: string;
  pipeline_id: string;
  pinned_revision_id: string;
  revision_digest: string;
  version_label: string;
  max_concurrent_runs: number;
  budget_overrides: Record<string, number>;
  enabled: boolean;
  channels?: AssignmentChannelLabel[];
}

/* ------------------------------------------------------------- § 2 runs */

/** `runs.status` (contract § 1 CHECK). */
export type RunStatus =
  | "queued"
  | "preparing"
  | "running"
  | "waiting_human"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export type RunPausedReason = "human_takeover" | "manual" | "worker_unavailable";

/** `GET /api/v1/runs/{runId}` (route 23). */
export interface RunDetail {
  id: string;
  project_id: string;
  pipeline_id: string;
  pipeline_revision_id: string;
  assignment_id: string | null;
  revision_digest: string;
  plan_digest: string;
  digest_scope: string;
  status: RunStatus;
  failed_cause: string | null;
  paused_reason: RunPausedReason | null;
  cancel_requested_at: string | null;
  depth: number;
  parent_run_id: string | null;
  /** The honest placement answer: a boolean view, never a worker id. */
  placement: { scheduled: boolean; reason?: "volume_affinity_unsatisfied" };
  expression_evaluations: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  /** The revision this run started with; a newer published revision is a
   * notice, never a re-pin (12 case 11). */
  latest_revision_number?: number | null;
}

/** `node_executions.status` (contract § 1 CHECK). */
export type NodeExecutionStatus =
  | "pending"
  | "ready"
  | "leased"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped"
  | "waiting"
  | "cancelled"
  | "interrupted";

/** `attempts.error_class` (ADR-0023 § 7). */
export type ErrorClass =
  | "infra"
  | "interrupted"
  | "timeout"
  | "agent_error"
  | "invalid_output"
  | "predicate_error"
  | "sandbox_enforcement_failed"
  | "workspace_lost"
  | "binding_error"
  | "approval_expired"
  | "cancelled";

export type WaitingReason = "approval" | "child_run" | "join_deferred";

export interface ArtifactRef {
  id: string;
  name: string;
  kind: string;
  /** `sha256:…` — the artifact's own digest, not the revision's. */
  sha256?: string;
  size_bytes?: number;
  sensitivity?: "standard" | "internal" | "restricted" | "secret";
}

/** `GET /api/v1/runs/{runId}/nodes` (route 24). */
export interface NodeExecutionSummary {
  id: string;
  run_id: string;
  node_id: string;
  /** Text path of ids and `[n]` suffixes — the loop/fan-out identity (01 invariant 6). */
  node_instance_key: string;
  /** `'/'` or the parent scope key. */
  scope_key: string;
  kind: string;
  execution_location: "worker" | "control_plane";
  status: NodeExecutionStatus;
  /** Business outcome, a separate column from status (03's result envelope). */
  outcome: string | null;
  error_class: ErrorClass | null;
  failed_cause: string | null;
  attempt_count: number;
  attempt_limit: number;
  in_flight: number;
  waiting_reason: WaitingReason | null;
  artifact_refs: ArtifactRef[];
  /** Present on control-plane scope nodes only. */
  iterations?: number | null;
  items?: number | null;
  ready_at: string | null;
  finished_at: string | null;
}

/** `attempts.status` (contract § 1 CHECK). */
export type AttemptStatus =
  | "queued"
  | "leased"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted";

/**
 * An attempt row. Route 32 refuses `worker_id`, `fencing_token` and
 * `lease_expires_at`, so they are not in the type at all: a UI cannot render
 * what it cannot receive (ADR-0016 § 8).
 */
export interface AttemptDetail {
  id: string;
  node_execution_id: string;
  run_id: string;
  attempt_number: number;
  status: AttemptStatus;
  error_class: ErrorClass | null;
  /** ≤ 512 bytes, redaction-scanned. */
  detail: string | null;
  output_errors: { path?: string; message?: string }[];
  scheduled_at: string;
  deadline_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  outputs: Record<string, unknown> | null;
  outputs_digest: string | null;
  artifact_refs: ArtifactRef[];
  overrides: Record<string, unknown> | null;
  /** ADR-0023 § 6's inheritance record; `mode` is the honest retry arm. */
  retry_context: Record<string, unknown> | null;
  conversation_id: string | null;
  turn_id: string | null;
}

/** A `run_checkpoints` row (route 27). `volume_id` + `workspace_id`, never a path. */
export interface RunCheckpoint {
  node_instance_key: string;
  inputs_digest: string;
  outputs_digest: string;
  artifact_refs: ArtifactRef[];
  repo_states: {
    repository_id: string;
    base_commit: string;
    head_commit: string;
    modified_paths_artifact?: ArtifactRef | null;
  }[];
  volume_id: string;
  created_at: string;
}

/** `GET /api/v1/runs/{runId}/tree` (route 26). */
export interface RunTreeChild {
  /** The `pipeline_invocations` row id. The frozen wire joins the child run's
   * summary in place and does not name the invocation row, so live mode may
   * leave it absent (`api/runs.ts` maps `RunTree` onto this view). */
  invocation_id?: string;
  /** Null on the tree root; a child names the invocation that created it. */
  node_instance_key: string | null;
  child_run_id: string;
  pipeline_slug: string;
  revision_digest: string;
  depth: number;
  /** Absent means `completion` — the compiled default (`03`), not a guess. */
  wait_policy: "completion" | "started" | "detach";
  status: RunStatus;
  expression_evaluations?: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  /** `cancelPolicy: detach` is refused in M4; a visible label is kept anyway
   * so a detached child is never silently missing (03's edge case). */
  detached?: boolean;
  children?: RunTreeChild[];
}

export interface RunTreeRoot {
  run_id: string;
  status: RunStatus;
  depth: number;
  children: RunTreeChild[];
}

/* -------------------------------------------------------- § 2 approvals */

export type ApprovalState = "pending" | "decided" | "expired" | "cancelled" | "denied";
export type ApprovalDecision = "approved" | "rejected";
export type ApprovalOnTimeout = "fail" | "cancel_run" | "expire";

/** `GET /api/v1/approvals/{approvalId}` (route 35). */
export interface ApprovalDetail {
  id: string;
  project_id: string;
  run_id: string;
  node_execution_id: string;
  node_instance_key: string;
  kind: "pipeline_gate" | "promotion_deferred";
  summary: string;
  artifact_refs: ArtifactRef[];
  approver_roles: string[];
  approver_user_ids: string[];
  deadline_at: string;
  on_timeout: ApprovalOnTimeout;
  re_requested: boolean;
  state: ApprovalState;
  decision: ApprovalDecision | null;
  comments: string | null;
  decided_by: string | null;
  decided_at: string | null;
  /** CAS token for `POST /approvals/{id}/decide` (route 36). */
  version: number;
  created_at: string;
}

/* ------------------------------------------------------------ § 3 events */

/** The subset of the run event vocabulary the run inspector renders. */
export type RunEventType =
  | "run.created"
  | "run.started"
  | "run.paused"
  | "run.resumed"
  | "run.waiting_human"
  | "run.checkpoint_saved"
  | "run.checkpoint_restored"
  | "run.retried"
  | "run.cancel_requested"
  | "run.cancelled"
  | "run.completed"
  | "run.failed"
  | "run.interrupted"
  | "node.scope.started"
  | "node.scope.iteration"
  | "node.scope.completed"
  | "node.scope.failed"
  | "node.execution_skipped"
  | "node.execution_cancelled"
  | "node.attempt.started"
  | "node.attempt.completed"
  | "node.attempt.failed"
  | "node.attempt.interrupted"
  | "node.attempt.cancelled"
  | "node.attempt.retry_scheduled"
  | "approval.requested"
  | "approval.decided"
  | "approval.expired"
  | "approval.denied"
  | "approval.cancelled";

/**
 * An event as the run stream delivers it: the envelope's three new optional
 * members (contract D4) plus the payload members of § 3. Only the members a
 * screen reads are typed; `payload` stays open because unknown members must
 * be ignored, not rejected (envelope schema note).
 */
export interface RunEvent {
  global_seq: number;
  type: RunEventType;
  occurred_at: string;
  run_id: string;
  node_execution_id?: string | null;
  attempt_id?: string | null;
  payload: {
    project_id?: string;
    attempt_number?: number;
    next_attempt_number?: number;
    error_class?: ErrorClass | null;
    reason?: string;
    detail?: string;
    scheduled_at?: string;
    delay_seconds?: number;
    node_instance_key?: string;
    iteration?: number;
    items?: number;
    pass_when_result?: boolean | null;
    outputs_digest?: string;
    checkpoint_saved?: boolean;
    failed_cause?: string;
    approval_id?: string;
    decision?: ApprovalDecision;
    [key: string]: unknown;
  };
}
