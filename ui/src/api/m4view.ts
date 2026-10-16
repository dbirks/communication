/**
 * The live seam: OpenAPI wire types (`schema.d.ts`, via `./types`) mapped onto
 * the components' view models (`lib/pipeline/contract.ts`).
 *
 * This is the only module allowed to know both halves. The components keep
 * their prop shapes (the fixture tests are the contract of what a screen must
 * render); the hooks keep the frozen wire shapes; this file translates, and
 * nowhere else can a wire field creep into a component or a view field into a
 * request. Rules the mapping follows:
 *
 * - Unknown wire members are dropped, never rejected (ADR-0014 § 8).
 * - Members the wire does not serve are stated, not invented: each fallback
 *   below cites the § / spec that makes the default a fact, not a guess.
 * - Artifact refs are `{ … }` records on the wire; only the members the UI
 *   names (`id`, `name`, `kind`, `sha256`, `size_bytes`, `sensitivity`) are
 *   read, and a ref without an `id` is not a ref.
 */
import type {
  Approval as ApprovalWire,
  ApprovalList as ApprovalListWire,
  Assignment as AssignmentWire,
  Attempt as AttemptWire,
  Draft as DraftWire,
  DraftSummary as DraftSummaryWire,
  NodeExecution as NodeExecutionWire,
  Pipeline as PipelineWire,
  PipelineRevision as PipelineRevisionWire,
  PipelineRevisionSummary as RevisionSummaryWire,
  PipelineSummary as PipelineSummaryWire,
  Run as RunWire,
  RunCheckpoint as RunCheckpointWire,
  RunTree as RunTreeWire,
  ValidateResponse as ValidateResponseWire,
} from "./types";
import type {
  ApprovalDetail,
  ArtifactRef,
  AttemptDetail,
  AssignmentSummary,
  DraftDocument,
  NodeExecutionSummary,
  PipelineDraftSummary,
  ValidationIssue,
  PipelineRevisionSummary as RevisionSummaryView,
  PipelineSummary as PipelineSummaryView,
  RunCheckpoint,
  RunDetail,
  RunTreeChild,
  RunTreeRoot,
  ValidateBody,
} from "../lib/pipeline/contract";

function member(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberMember(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key];
  return typeof value === "number" ? value : undefined;
}

/** One artifact ref, read for the members the UI names. */
export function viewArtifactRef(ref: unknown): ArtifactRef | null {
  if (!ref || typeof ref !== "object") return null;
  const source = ref as Record<string, unknown>;
  const id = member(source, "id") ?? member(source, "artifact_id");
  if (!id) return null;
  const sensitivity = member(source, "sensitivity");
  return {
    id,
    name: member(source, "name") ?? id,
    kind: member(source, "kind") ?? "unknown",
    ...(member(source, "sha256") ? { sha256: member(source, "sha256")! } : {}),
    ...(numberMember(source, "size_bytes") !== undefined
      ? { size_bytes: numberMember(source, "size_bytes") }
      : {}),
    ...(sensitivity === "standard" ||
    sensitivity === "internal" ||
    sensitivity === "restricted" ||
    sensitivity === "secret"
      ? { sensitivity }
      : {}),
  };
}

export function viewArtifactRefs(refs: readonly unknown[]): ArtifactRef[] {
  return refs.flatMap((ref) => {
    const view = viewArtifactRef(ref);
    return view ? [view] : [];
  });
}

export function viewNodeExecution(node: NodeExecutionWire): NodeExecutionSummary {
  return {
    id: node.id,
    run_id: node.run_id,
    node_id: node.node_id,
    node_instance_key: node.node_instance_key,
    scope_key: node.scope_key,
    kind: node.kind,
    execution_location: node.execution_location,
    status: node.status,
    outcome: node.outcome ?? null,
    error_class: node.error_class ?? null,
    failed_cause: node.failed_cause ?? null,
    attempt_count: node.attempt_count,
    attempt_limit: node.attempt_limit,
    in_flight: node.in_flight,
    waiting_reason: node.waiting_reason ?? null,
    artifact_refs: viewArtifactRefs(node.artifact_refs),
    ...(node.iterations !== undefined ? { iterations: node.iterations } : {}),
    ...(node.items !== undefined ? { items: node.items } : {}),
    ready_at: node.ready_at ?? null,
    finished_at: node.finished_at ?? null,
  };
}

export function viewAttempt(attempt: AttemptWire): AttemptDetail {
  return {
    id: attempt.id,
    node_execution_id: attempt.node_execution_id,
    run_id: attempt.run_id,
    attempt_number: attempt.attempt_number,
    status: attempt.status,
    error_class: attempt.error_class ?? null,
    detail: attempt.detail ?? null,
    // The § 2 invalid-output units keep their validator wording; only `path`
    // and `message` are read, the rest travels untouched.
    output_errors: attempt.output_errors.flatMap((unit) => {
      if (!unit || typeof unit !== "object") return [];
      const source = unit as Record<string, unknown>;
      return [
        {
          ...(member(source, "path") ? { path: member(source, "path")! } : {}),
          ...(member(source, "message") ? { message: member(source, "message")! } : {}),
        },
      ];
    }),
    scheduled_at: attempt.scheduled_at,
    deadline_at: attempt.deadline_at ?? null,
    started_at: attempt.started_at ?? null,
    finished_at: attempt.finished_at ?? null,
    outputs: attempt.outputs ?? null,
    outputs_digest: attempt.outputs_digest ?? null,
    artifact_refs: viewArtifactRefs(attempt.artifact_refs),
    overrides: attempt.overrides ?? null,
    retry_context: attempt.retry_context ?? null,
    conversation_id: attempt.conversation_id ?? null,
    turn_id: attempt.turn_id ?? null,
  };
}

/**
 * The wire's checkpoint names its manifest by artifact *id*; the view shows a
 * ref. The label says what the record is (ADR-0023 § 6's `kind=json` manifest),
 * never a filename the server did not serve.
 */
export function viewRunCheckpoint(checkpoint: RunCheckpointWire): RunCheckpoint {
  return {
    node_instance_key: checkpoint.node_instance_key,
    inputs_digest: checkpoint.inputs_digest,
    outputs_digest: checkpoint.outputs_digest,
    artifact_refs: viewArtifactRefs(checkpoint.artifact_refs),
    repo_states: checkpoint.repo_states.map((state) => ({
      repository_id: state.repository_id,
      base_commit: state.base_commit,
      head_commit: state.head_commit,
      ...(state.modified_paths_artifact
        ? {
            modified_paths_artifact: {
              id: state.modified_paths_artifact,
              name: "checkpoint manifest",
              kind: "json",
            },
          }
        : {}),
    })),
    volume_id: checkpoint.volume_id,
    created_at: checkpoint.created_at,
  };
}

export function viewRun(run: RunWire): RunDetail {
  return {
    id: run.id,
    project_id: run.project_id,
    pipeline_id: run.pipeline_id,
    pipeline_revision_id: run.pipeline_revision_id,
    assignment_id: run.assignment_id ?? null,
    revision_digest: run.revision_digest,
    plan_digest: run.plan_digest,
    digest_scope: run.digest_scope,
    status: run.status,
    failed_cause: run.failed_cause ?? null,
    paused_reason: run.paused_reason ?? null,
    cancel_requested_at: run.cancel_requested_at ?? null,
    depth: run.depth,
    parent_run_id: run.parent_run_id ?? null,
    placement: { scheduled: run.placement.scheduled, reason: run.placement.reason ?? undefined },
    expression_evaluations: run.expression_evaluations,
    created_at: run.created_at,
    started_at: run.started_at ?? null,
    finished_at: run.finished_at ?? null,
  };
}

/**
 * `GET /runs/{runId}/tree` onto the tree the `RunTree` component draws. A child
 * is a run summary; the invocation facts ride beside it. `pipeline_slug` is not
 * on the wire (runs carry `pipeline_id` — `10`'s rule that a child run is a
 * run, not a label), so the caller supplies the library's own slug map and the
 * honest fallback is the id.
 */
export function viewRunTree(
  tree: RunTreeWire,
  slugOf: (pipelineId: string) => string = (id) => id,
): RunTreeRoot {
  const mapChild = (child: RunTreeWire, depth: number): RunTreeChild => ({
    child_run_id: child.run.id,
    node_instance_key: child.node_instance_key ?? null,
    pipeline_slug: slugOf(child.run.pipeline_id),
    revision_digest: child.run.revision_digest,
    depth: child.depth ?? depth,
    // Absent on a child means the invocation kept the compiled default
    // (`03`): `completion`. `detach` is refused at validate (ADR-0024 § 4).
    wait_policy: child.wait_policy ?? "completion",
    status: child.run.status,
    created_at: child.run.created_at,
    started_at: child.run.started_at ?? null,
    finished_at: child.run.finished_at ?? null,
    children: child.children.map((grand) => mapChild(grand, depth + 1)),
  });
  return {
    run_id: tree.run.id,
    status: tree.run.status,
    depth: tree.depth ?? 0,
    children: tree.children.map((child) => mapChild(child, 1)),
  };
}

export function viewApproval(approval: ApprovalWire): ApprovalDetail {
  return {
    id: approval.id,
    project_id: approval.project_id,
    run_id: approval.run_id,
    node_execution_id: approval.node_execution_id,
    node_instance_key: approval.node_instance_key ?? "",
    kind: approval.kind,
    summary: approval.summary,
    artifact_refs: viewArtifactRefs(approval.artifact_refs),
    approver_roles: [...approval.approver_roles],
    approver_user_ids: [...approval.approver_user_ids],
    deadline_at: approval.deadline_at,
    on_timeout: approval.on_timeout,
    re_requested: approval.re_requested,
    state: approval.state,
    decision: approval.decision ?? null,
    comments: approval.comments ?? null,
    decided_by: approval.decided_by ?? null,
    decided_at: approval.decided_at ?? null,
    version: approval.version,
    created_at: approval.created_at,
  };
}

export function viewApprovals(list: ApprovalListWire): ApprovalDetail[] {
  return list.approvals.map(viewApproval);
}

/**
 * One § 2.2 finding. An entry that is not a renderable finding — no `message`,
 * or a `source` outside the three-stage vocabulary — is dropped rather
 * guessed at (this module's rule: unknown wire members are dropped, never
 * rejected), because `VALIDATION_SOURCE_STATE` has no fourth stage and an
 * invented one would attribute the finding to a tool that did not speak.
 */
function viewValidateIssue(issue: unknown): ValidationIssue | null {
  if (!issue || typeof issue !== "object") return null;
  const source = issue as Record<string, unknown>;
  const code = member(source, "code");
  const message = member(source, "message");
  const stage = source.source;
  if (!code || !message) return null;
  if (stage !== "loader" && stage !== "schema" && stage !== "compiler") return null;
  const hint = member(source, "hint");
  return {
    code,
    source: stage,
    message,
    instance_location: member(source, "instance_location"),
    schema_location: member(source, "schema_location"),
    ...(hint ? { hint } : {}),
  };
}

function stringList(values: unknown): string[] {
  return Array.isArray(values) ? values.filter((v): v is string => typeof v === "string") : [];
}

/**
 * The validate body onto the editor's verdict. Total over everything the wire
 * may put where a validation goes: `Draft.validation` is "the last validate
 * body verbatim, null when never validated", so a draft that has not been
 * validated yet — or a row whose block arrived empty or with its arrays
 * missing — is *not validated*, never a crash (`.map` over an absent `errors`
 * blanked the whole pipeline page).
 *
 * A real body maps exactly as before; only the vacuous shapes (`null`,
 * `undefined`, `{}`) collapse to `null`, which is the state the editor calls
 * "not validated yet".
 */
export function viewValidate(
  body?: ValidateResponseWire | Record<string, unknown> | null,
): ValidateBody | null {
  if (!body || typeof body !== "object") return null;
  const source = body as Record<string, unknown>;
  const errorList = Array.isArray(source.errors) ? source.errors : [];
  const notes = stringList(source.notes);
  const valid = source.valid === true;
  // Nothing a verdict is made of: never validated, not validated-and-clean.
  if (typeof source.valid !== "boolean" && errorList.length === 0 && notes.length === 0) {
    return null;
  }
  return {
    valid,
    revision_digest: member(source, "revision_digest"),
    plan_digest: member(source, "plan_digest"),
    digest_scope: member(source, "digest_scope") ?? "",
    // Server order is a contract property (§ 2.2 stable sort), preserved.
    errors: errorList
      .map(viewValidateIssue)
      .filter((issue): issue is ValidationIssue => issue !== null),
    notes,
  };
}

export function viewDraft(draft: DraftWire): DraftDocument {
  return {
    document_yaml: draft.document_yaml,
    ui_layout: draft.ui_layout,
    status: draft.status,
    version: draft.version,
    validation: viewValidate(draft.validation),
  };
}

export function viewPipelineSummary(pipeline: PipelineSummaryWire): PipelineSummaryView {
  return {
    id: pipeline.id,
    slug: pipeline.slug,
    display_name: pipeline.display_name,
    latest_revision_number: pipeline.latest_revision_number,
    revision_count: pipeline.revision_count,
    archived: pipeline.archived,
  };
}

/**
 * The revision *summary* route serves identity without a row id — `GET
 * /revisions/{digestOrId}` resolves a digest or an id alike (route 13), so the
 * digest is the identity the list honestly offers, and it is what a pin links
 * by. The full record (`viewRevisionRecord`) carries the real id.
 */
export function viewRevisionSummary(revision: RevisionSummaryWire): RevisionSummaryView {
  return {
    id: revision.revision_digest,
    revision_number: revision.revision_number,
    version_label: revision.version_label,
    revision_digest: revision.revision_digest,
    plan_digest: revision.plan_digest,
    digest_scope: revision.digest_scope,
    published_at: revision.published_at,
    published_by: revision.published_by,
    status: revision.status,
  };
}

export function viewRevisionRecord(revision: PipelineRevisionWire): RevisionSummaryView {
  return {
    ...viewRevisionSummary(revision),
    id: revision.id,
  };
}

export function viewDraftSummary(draft: DraftSummaryWire): PipelineDraftSummary {
  return {
    id: draft.id,
    status: draft.status,
    version: draft.version,
    updated_at: draft.updated_at,
    edited_by: draft.edited_by,
  };
}

/**
 * `channels` is M6's rollout vocabulary (`07` "Version rollout"); the M4 wire
 * has no channel member, so live mode renders the honest absence ("no channel
 * set for this project") rather than implying "latest".
 */
export function viewAssignment(assignment: AssignmentWire): AssignmentSummary {
  return {
    id: assignment.id,
    project_id: assignment.project_id,
    pipeline_id: assignment.pipeline_id,
    pinned_revision_id: assignment.pinned_revision_id,
    revision_digest: assignment.pinned_revision_digest,
    version_label: assignment.pinned_version_label ?? "",
    max_concurrent_runs: assignment.max_concurrent_runs,
    budget_overrides: {},
    enabled: assignment.enabled,
  };
}

export function viewPipeline(pipeline: PipelineWire): {
  summary: PipelineSummaryView;
  revisions: RevisionSummaryView[];
} {
  return {
    summary: {
      id: pipeline.id,
      slug: pipeline.slug,
      display_name: pipeline.display_name,
      description: pipeline.description,
      latest_revision_number: pipeline.latest_revision_number,
      revision_count: pipeline.revision_count,
      archived: pipeline.archived,
    },
    revisions: pipeline.revisions.map(viewRevisionSummary),
  };
}
