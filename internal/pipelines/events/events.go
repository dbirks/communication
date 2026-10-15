// Package events models the M4 run/node/attempt/approval/pipeline/assignment
// payload shapes named in docs/m4-contract.md § 3, so the advancer, the
// worker, the API and the Postgres adapter emit one shape rather than each
// inventing one (ADR-0016's rule for the types that cross a process boundary).
//
// This package deliberately does NOT touch internal/events: M3 integration is
// editing that file, and the two merge later. What lives here is the payload
// side of the M4 vocabulary plus the correlation members § 1's new
// domain_events columns carry (run_id, node_execution_id, attempt_id, D4).
//
// The rules from § 3 hold for every struct below: each payload is an object
// carrying project_id plus the ids it correlates on, and no payload carries a
// secret value, a prompt body, an absolute host path, a fencing token or a
// lease deadline. CEL failure text is admitted only as PredicateErrorDetail,
// truncated to 512 bytes (ADR-0022 Security).
package events

import (
	"fmt"
	"regexp"
	"time"
)

// TypeName is one domain event type. The envelope schema pins the grammar
// (api/schemas/event-envelope.schema.json: ^[a-z]+(\.[a-z_]+)+$), so a typo in
// a constant below fails TestTypeNamesSatisfyTheEnvelopeGrammar rather than
// reaching a browser.
type TypeName = string

// M4 event types (contract § 3 rows 1-36: the ones the runtime, the worker
// and the API write). Row numbers in the comments point at § 3's table. The
// Type prefix keeps the names distinct from the payload structs below, which
// carry § 3's names verbatim (one shape per row).
const (
	// Run lifecycle (§ 3 rows 1-14). TypeRunCreated is emitted by the API in
	// the POST /runs transaction (row 1) — listed for completeness; the
	// runtime never writes it.
	TypeRunCreated            TypeName = "run.created"
	TypeRunStarted            TypeName = "run.started"          // 2
	TypeRunPaused             TypeName = "run.paused"           // 3
	TypeRunResumed            TypeName = "run.resumed"          // 4
	TypeRunWaitingHuman       TypeName = "run.waiting_human"    // 5
	TypeRunRetried            TypeName = "run.retried"          // 6
	TypeRunCheckpointSaved    TypeName = "run.checkpoint_saved" // 7
	TypeRunCheckpointRestored TypeName = "run.checkpoint_restored"
	TypeRunCompleted          TypeName = "run.completed"        // 9
	TypeRunFailed             TypeName = "run.failed"           // 10
	TypeRunCancelRequested    TypeName = "run.cancel_requested" // 11
	TypeRunCancelled          TypeName = "run.cancelled"        // 12
	TypeRunInterrupted        TypeName = "run.interrupted"      // 13

	// Node executions and scopes (§ 3 rows 14-19).
	TypeNodeExecutionSkipped   TypeName = "node.execution_skipped"
	TypeNodeExecutionCancelled TypeName = "node.execution_cancelled"
	TypeNodeScopeStarted       TypeName = "node.scope.started"
	TypeNodeScopeIteration     TypeName = "node.scope.iteration"
	TypeNodeScopeCompleted     TypeName = "node.scope.completed"
	TypeNodeScopeFailed        TypeName = "node.scope.failed"

	// Attempts (§ 3 rows 20-25).
	TypeNodeAttemptStarted        TypeName = "node.attempt.started"
	TypeNodeAttemptCompleted      TypeName = "node.attempt.completed"
	TypeNodeAttemptFailed         TypeName = "node.attempt.failed"
	TypeNodeAttemptInterrupted    TypeName = "node.attempt.interrupted"
	TypeNodeAttemptCancelled      TypeName = "node.attempt.cancelled"
	TypeNodeAttemptRetryScheduled TypeName = "node.attempt.retry_scheduled"

	// Gates (§ 3 rows 26-30).
	TypeApprovalRequested TypeName = "approval.requested"
	TypeApprovalDecided   TypeName = "approval.decided"
	TypeApprovalExpired   TypeName = "approval.expired"
	TypeApprovalDenied    TypeName = "approval.denied"
	TypeApprovalCancelled TypeName = "approval.cancelled"

	// Pipeline library and assignments (§ 3 rows 31-36): API-emitted, never
	// runtime rows, but they share the journal so they share this vocabulary.
	TypePipelineCreated            TypeName = "pipeline.created"             // 31
	TypePipelineDraftUpdated       TypeName = "pipeline.draft.updated"       // 32
	TypePipelineDraftValidated     TypeName = "pipeline.draft.validated"     // 33
	TypePipelineRevisionPublished  TypeName = "pipeline.revision.published"  // 34
	TypePipelineRevisionDeprecated TypeName = "pipeline.revision.deprecated" // 35

	TypeAssignmentCreated TypeName = "assignment.created" // 36
	TypeAssignmentUpdated TypeName = "assignment.updated" // 36
)

// ReservedTypes names § 3 row 37: the type exists so M5 can land it without
// renaming the wire, and M4 has no emitter. It is listed here, not emitted.
var ReservedTypes = []TypeName{"run.override.applied"}

// typePattern is the envelope schema's pattern for the `type` member.
var typePattern = regexp.MustCompile(`^[a-z]+(\.[a-z_]+)+$`)

// ValidTypeName reports whether t satisfies the envelope grammar.
func ValidTypeName(t string) bool { return typePattern.MatchString(t) }

// § 1's CHECK patterns, restated so a payload's Validate refuses at the
// boundary the shapes the migration would only catch at insert time.
var (
	digestPattern       = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
	sha256HexPattern    = regexp.MustCompile(`^[0-9a-f]{64}$`)
	slugPattern         = regexp.MustCompile(`^[a-z][a-z0-9.-]{0,127}$`)
	versionLabelPattern = regexp.MustCompile(`^\d+\.\d+\.\d+$`)
)

// Validator is implemented by payload structs that check their own members.
// Record.Validate dispatches to it, so a payload cannot reach the journal in
// a shape § 1's CHECKs would reject (the run/node/approval payloads predate
// the hook and are checked by the reflection tests instead).
type Validator interface {
	Validate() error
}

// Actor kinds (internal/events' enumeration, restated here so this package
// stays standalone until the two merge). A reconciler row is always system.
const (
	ActorKindSystem = "system"
	ActorKindWorker = "worker"
	ActorKindHuman  = "human"
)

// Record is one event the runtime wants appended: the type, the payload, and
// the three correlation ids § 1 adds to domain_events. The Postgres adapter
// sets the columns AND serialises Payload; the in-memory store keeps Records
// verbatim so a test can assert the sequence.
type Record struct {
	Type    TypeName
	Payload any
	// OrganizationID and ProjectID are the authorization scope; every M4
	// payload carries project_id in its body too (§ 3).
	OrganizationID string
	ProjectID      string
	RunID          string
	// NodeExecutionID may exist with AttemptID NULL: control-plane rows have
	// no attempts (ADR-0023 § 3, § 3's correlation rule).
	NodeExecutionID string
	AttemptID       string
	ConversationID  string
	ActorKind       string
	ActorID         string
	Timestamp       time.Time
}

// ErrInvalid is returned by Validate.
func (r Record) Validate() error {
	if !ValidTypeName(r.Type) {
		return fmt.Errorf("events: type %q does not satisfy the envelope grammar", r.Type)
	}
	if r.Payload == nil {
		return fmt.Errorf("events: %s carries no payload", r.Type)
	}
	if r.ProjectID == "" {
		return fmt.Errorf("events: %s carries no project_id", r.Type)
	}
	switch r.ActorKind {
	case ActorKindSystem, ActorKindWorker, ActorKindHuman:
	default:
		return fmt.Errorf("events: %s has actor kind %q", r.Type, r.ActorKind)
	}
	if v, ok := r.Payload.(Validator); ok {
		if err := v.Validate(); err != nil {
			return err
		}
	}
	return nil
}

// ---------------------------------------------------------------- run payloads

// RunStarted is § 3 row 2. The repo snapshot is the starting base commits
// (03 step 2); it names commits, never paths.
type RunStarted struct {
	ProjectID             string `json:"project_id"`
	RunID                 string `json:"run_id"`
	WorkerAffinityPresent bool   `json:"worker_affinity_present"`
	RepoSnapshot          []any  `json:"repo_snapshot"`
}

// RunPaused is § 3 row 3: pause stops future scheduling only, so the honest
// payload names what is still in flight.
type RunPaused struct {
	ProjectID        string   `json:"project_id"`
	RunID            string   `json:"run_id"`
	PausedReason     string   `json:"paused_reason"`
	InFlightAttempts []string `json:"in_flight_attempts"`
	RequestedBy      string   `json:"requested_by,omitempty"`
}

// RunResumed is § 3 row 4.
type RunResumed struct {
	ProjectID    string `json:"project_id"`
	RunID        string `json:"run_id"`
	PausedReason string `json:"paused_reason"`
}

// RunWaitingHuman is § 3 row 5, emitted when a gate row is inserted.
type RunWaitingHuman struct {
	ProjectID       string    `json:"project_id"`
	RunID           string    `json:"run_id"`
	ApprovalID      string    `json:"approval_id"`
	NodeInstanceKey string    `json:"node_instance_key"`
	DeadlineAt      time.Time `json:"deadline_at"`
	ApproverRoles   []string  `json:"approver_roles"`
}

// RunRetried is § 3 row 6.
type RunRetried struct {
	ProjectID         string            `json:"project_id"`
	RunID             string            `json:"run_id"`
	RequestedBy       string            `json:"requested_by"`
	Targets           []string          `json:"targets"`
	InputNames        []string          `json:"input_names"`
	WorkspacePolicies map[string]string `json:"workspace_policies"`
}

// Checkpoint is the boundary record's visible shape (§ 3 row 7) — digests and
// refs only, never a path (ADR-0017's volume identity is the honest address).
type Checkpoint struct {
	NodeInstanceKey string      `json:"node_instance_key"`
	InputsDigest    string      `json:"inputs_digest"`
	OutputsDigest   string      `json:"outputs_digest"`
	RepoStates      []RepoState `json:"repo_states"`
	ArtifactRefs    []any       `json:"artifact_refs"`
	VolumeID        string      `json:"volume_id"`
}

// RepoState is one repository's state at a boundary: commits, not paths.
type RepoState struct {
	RepositoryID          string `json:"repository_id"`
	BaseCommit            string `json:"base_commit"`
	HeadCommit            string `json:"head_commit"`
	ModifiedPathsArtifact string `json:"modified_paths_artifact,omitempty"`
}

// RunCheckpointSaved is § 3 row 7, written by the worker in the attempt's
// success transaction (ADR-0023 § 6).
type RunCheckpointSaved struct {
	ProjectID  string     `json:"project_id"`
	RunID      string     `json:"run_id"`
	Checkpoint Checkpoint `json:"checkpoint"`
}

// RunCheckpointRestored is § 3 row 8: emitted ONLY under
// retry.workspacePolicy: restore_checkpoint. Its absence beside a retry is
// what proves the run used continue_workspace (contract D5's honest seam).
type RunCheckpointRestored struct {
	ProjectID       string   `json:"project_id"`
	RunID           string   `json:"run_id"`
	NodeInstanceKey string   `json:"node_instance_key"`
	FromCommit      string   `json:"from_commit"`
	DiscardedPaths  []string `json:"discarded_paths"`
}

// RunCompleted is § 3 row 9. completed means the configured acceptance passed,
// not that anything merged (01).
type RunCompleted struct {
	ProjectID       string         `json:"project_id"`
	RunID           string         `json:"run_id"`
	ResultBindings  map[string]any `json:"result_bindings"`
	ArtifactRefs    []any          `json:"artifact_refs"`
	IterationTotals map[string]int `json:"iteration_totals"`
}

// RunFailed is § 3 row 10. FailedCause names the budget when a budget caused
// the failure (ADR-0023 § 7).
type RunFailed struct {
	ProjectID         string `json:"project_id"`
	RunID             string `json:"run_id"`
	FailedCause       string `json:"failed_cause"`
	ErrorClass        string `json:"error_class"`
	NodeInstanceKey   string `json:"node_instance_key,omitempty"`
	Budget            string `json:"budget,omitempty"`
	EvidenceArtifacts []any  `json:"evidence_artifacts"`
}

// RunCancelRequested is § 3 row 11.
type RunCancelRequested struct {
	ProjectID   string   `json:"project_id"`
	RunID       string   `json:"run_id"`
	Cascade     bool     `json:"cascade"`
	Children    []string `json:"children"`
	RequestedBy string   `json:"requested_by,omitempty"`
}

// RunCancelled is § 3 row 12, emitted once every branch is terminal.
type RunCancelled struct {
	ProjectID               string   `json:"project_id"`
	RunID                   string   `json:"run_id"`
	CancelledNodeExecutions []string `json:"cancelled_node_executions"`
	CancelledAttempts       []string `json:"cancelled_attempts"`
}

// RunInterrupted is § 3 row 13 — reconciler only, never the dead process.
type RunInterrupted struct {
	ProjectID        string   `json:"project_id"`
	RunID            string   `json:"run_id"`
	Reason           string   `json:"reason"`
	ErrorClass       string   `json:"error_class"`
	NodeInstanceKeys []string `json:"node_instance_keys"`
}

// ------------------------------------------------------------- node payloads

// NodeExecutionSkipped is § 3 row 14. Reason is one of dependency_skipped,
// condition_default, case_not_selected, for_each_zero_items_body_unreached.
type NodeExecutionSkipped struct {
	ProjectID       string `json:"project_id"`
	RunID           string `json:"run_id"`
	NodeInstanceKey string `json:"node_instance_key"`
	Reason          string `json:"reason"`
}

// NodeExecutionCancelled is § 3 row 15: cascade, on_child_failure_stop or
// run_cancelled.
type NodeExecutionCancelled struct {
	ProjectID       string `json:"project_id"`
	RunID           string `json:"run_id"`
	NodeInstanceKey string `json:"node_instance_key"`
	Reason          string `json:"reason"`
}

// NodeScopeStarted is § 3 row 16.
type NodeScopeStarted struct {
	ProjectID       string `json:"project_id"`
	RunID           string `json:"run_id"`
	ScopeKey        string `json:"scope_key"`
	NodeInstanceKey string `json:"node_instance_key"`
	Kind            string `json:"kind"`
	Iteration       int    `json:"iteration,omitempty"`
	Items           int    `json:"items,omitempty"`
}

// NodeScopeIteration is § 3 row 17: 12 case 7's per-iteration evidence and
// case 8's fan-out accounting. PassWhenResult is nil when the iteration failed
// before a predicate could be evaluated; PredicateErrorDetail is the only place
// CEL text enters the journal, bounded and redaction-scanned.
type NodeScopeIteration struct {
	ProjectID            string `json:"project_id"`
	RunID                string `json:"run_id"`
	ScopeKey             string `json:"scope_key"`
	NodeInstanceKey      string `json:"node_instance_key"`
	Iteration            int    `json:"iteration,omitempty"`
	Items                int    `json:"items,omitempty"`
	PassWhenResult       *bool  `json:"pass_when_result,omitempty"`
	PredicateErrorDetail string `json:"predicate_error_detail,omitempty"`
}

// NodeScopeCompleted is § 3 row 18 (03's zero-item edge case emits items: 0).
type NodeScopeCompleted struct {
	ProjectID       string         `json:"project_id"`
	RunID           string         `json:"run_id"`
	ScopeKey        string         `json:"scope_key"`
	NodeInstanceKey string         `json:"node_instance_key"`
	Kind            string         `json:"kind"`
	Iterations      int            `json:"iterations,omitempty"`
	Items           int            `json:"items"`
	ResultBindings  map[string]any `json:"result_bindings"`
}

// NodeScopeFailed is § 3 row 19. FailedCause is until_exhausted, child_failed,
// predicate_error or child_run_failed.
type NodeScopeFailed struct {
	ProjectID       string `json:"project_id"`
	RunID           string `json:"run_id"`
	ScopeKey        string `json:"scope_key"`
	NodeInstanceKey string `json:"node_instance_key"`
	Kind            string `json:"kind"`
	FailedCause     string `json:"failed_cause"`
	Evidence        []any  `json:"evidence"`
	Iterations      int    `json:"iterations_stopped,omitempty"`
}

// NodeAttemptStarted is § 3 row 20.
type NodeAttemptStarted struct {
	ProjectID       string `json:"project_id"`
	RunID           string `json:"run_id"`
	NodeInstanceKey string `json:"node_instance_key"`
	AttemptNumber   int    `json:"attempt_number"`
	ErrorClass      string `json:"error_class"`
	WorkerAffinity  bool   `json:"worker_affinity"`
	SandboxVerified bool   `json:"sandbox_verified"`
	SessionResumed  *bool  `json:"session_resumed,omitempty"`
}

// NodeAttemptCompleted is § 3 row 21. Outputs is the bounded inline copy; the
// digest is what another process can verify.
type NodeAttemptCompleted struct {
	ProjectID       string `json:"project_id"`
	RunID           string `json:"run_id"`
	NodeInstanceKey string `json:"node_instance_key"`
	AttemptNumber   int    `json:"attempt_number"`
	OutputsDigest   string `json:"outputs_digest"`
	Outputs         any    `json:"outputs,omitempty"`
	ArtifactRefs    []any  `json:"artifact_refs"`
	CheckpointSaved bool   `json:"checkpoint_saved"`
}

// NodeAttemptFailed is § 3 row 22.
type NodeAttemptFailed struct {
	ProjectID         string     `json:"project_id"`
	RunID             string     `json:"run_id"`
	NodeInstanceKey   string     `json:"node_instance_key"`
	AttemptNumber     int        `json:"attempt_number"`
	ErrorClass        string     `json:"error_class"`
	Detail            string     `json:"detail"`
	OutputErrors      []any      `json:"output_errors"`
	NextAttemptNumber int        `json:"next_attempt_number,omitempty"`
	ScheduledAt       *time.Time `json:"scheduled_at,omitempty"`
}

// NodeAttemptInterrupted is § 3 row 23. Reason is lease_expired, worker_gone,
// worker_shutdown, process_group_kill_timeout or human_takeover — never a
// claim of resume-without-loss.
type NodeAttemptInterrupted struct {
	ProjectID       string `json:"project_id"`
	RunID           string `json:"run_id"`
	NodeInstanceKey string `json:"node_instance_key"`
	AttemptNumber   int    `json:"attempt_number"`
	Reason          string `json:"reason"`
}

// NodeAttemptCancelled is § 3 row 24.
type NodeAttemptCancelled struct {
	ProjectID       string `json:"project_id"`
	RunID           string `json:"run_id"`
	NodeInstanceKey string `json:"node_instance_key"`
	AttemptNumber   int    `json:"attempt_number"`
	Reason          string `json:"reason"`
}

// NodeAttemptRetryScheduled is § 3 row 25: 12 case 5's visible half — the
// backoff landing time is persisted, not recomputed from a memory.
type NodeAttemptRetryScheduled struct {
	ProjectID         string    `json:"project_id"`
	RunID             string    `json:"run_id"`
	NodeInstanceKey   string    `json:"node_instance_key"`
	AttemptNumber     int       `json:"attempt_number"`
	NextAttemptNumber int       `json:"next_attempt_number"`
	ErrorClass        string    `json:"error_class"`
	DelaySeconds      int       `json:"delay_seconds"`
	ScheduledAt       time.Time `json:"scheduled_at"`
}

// ---------------------------------------------------------------- approvals

// ApprovalRequested is § 3 row 26. The summary is digested, never copied: the
// gate's text may embed another node's output (contract C11's vector).
type ApprovalRequested struct {
	ProjectID       string    `json:"project_id"`
	RunID           string    `json:"run_id"`
	ApprovalID      string    `json:"approval_id"`
	NodeInstanceKey string    `json:"node_instance_key"`
	SummaryDigest   string    `json:"summary_digest"`
	ArtifactRefs    []any     `json:"artifact_refs"`
	DeadlineAt      time.Time `json:"deadline_at"`
	OnTimeout       string    `json:"on_timeout"`
	ApproverRoles   []string  `json:"approver_roles"`
	ApproverUserIDs []string  `json:"approver_user_ids"`
}

// ApprovalDecided is § 3 row 27. CommentsPresent is the honest boolean: the
// comment body is not journal material (05's rule for a decision on evidence).
type ApprovalDecided struct {
	ProjectID       string `json:"project_id"`
	RunID           string `json:"run_id"`
	ApprovalID      string `json:"approval_id"`
	Decision        string `json:"decision"`
	CommentsPresent bool   `json:"comments_present"`
	Version         int    `json:"version"`
	DecidedBy       string `json:"decided_by"`
}

// ApprovalExpired is § 3 row 28.
type ApprovalExpired struct {
	ProjectID   string `json:"project_id"`
	RunID       string `json:"run_id"`
	ApprovalID  string `json:"approval_id"`
	OnTimeout   string `json:"on_timeout"`
	ReRequested bool   `json:"re_requested"`
}

// ApprovalDenied is § 3 row 29: approver_lost_access,
// not_a_designated_approver, already_decided or run_terminal.
type ApprovalDenied struct {
	ProjectID  string `json:"project_id"`
	RunID      string `json:"run_id"`
	ApprovalID string `json:"approval_id"`
	Reason     string `json:"reason"`
}

// ApprovalCancelled is § 3 row 30 (run_cancelled or superseded).
type ApprovalCancelled struct {
	ProjectID  string `json:"project_id"`
	RunID      string `json:"run_id"`
	ApprovalID string `json:"approval_id"`
	Reason     string `json:"reason"`
}

// ------------------------------------------------- pipeline library payloads

// PipelineCreated is § 3 row 31. The slug is the pipeline's identity inside
// the organization, so the payload carries the § 1 CHECK shape, verbatim.
type PipelineCreated struct {
	ProjectID  string `json:"project_id"`
	PipelineID string `json:"pipeline_id"`
	Slug       string `json:"slug"`
}

// Validate enforces § 3 row 31.
func (p PipelineCreated) Validate() error {
	if p.ProjectID == "" {
		return fmt.Errorf("events: pipeline.created carries no project_id")
	}
	if p.PipelineID == "" {
		return fmt.Errorf("events: pipeline.created carries no pipeline_id")
	}
	if !slugPattern.MatchString(p.Slug) {
		return fmt.Errorf("events: pipeline.created slug %q violates § 1's CHECK", p.Slug)
	}
	return nil
}

// PipelineDraftUpdated is § 3 row 32 — the audit trail for editor churn:
// hashes and versions, never the document body.
type PipelineDraftUpdated struct {
	ProjectID    string `json:"project_id"`
	DraftID      string `json:"draft_id"`
	Version      int    `json:"version"`
	SourceSHA256 string `json:"source_sha256"`
	EditedBy     string `json:"edited_by"`
	Kind         string `json:"kind"`
}

// Validate enforces § 3 row 32 against § 1's pipeline_drafts CHECKs.
func (p PipelineDraftUpdated) Validate() error {
	if p.ProjectID == "" {
		return fmt.Errorf("events: pipeline.draft.updated carries no project_id")
	}
	if p.DraftID == "" {
		return fmt.Errorf("events: pipeline.draft.updated carries no draft_id")
	}
	if p.EditedBy == "" {
		return fmt.Errorf("events: pipeline.draft.updated carries no edited_by")
	}
	if p.Version < 1 {
		return fmt.Errorf("events: pipeline.draft.updated version %d is below 1 (§ 1's CHECK)", p.Version)
	}
	if !sha256HexPattern.MatchString(p.SourceSHA256) {
		return fmt.Errorf("events: pipeline.draft.updated source_sha256 %q is not 64 hex characters", p.SourceSHA256)
	}
	switch p.Kind {
	case "manual", "yaml_import", "assistant", "clone":
	default:
		return fmt.Errorf("events: pipeline.draft.updated kind %q is outside § 1's source_kind enum", p.Kind)
	}
	return nil
}

// PipelineDraftValidated is § 3 row 33: codes only, so the journal records
// *what* failed without cloning the editor's payload (§ 2.2's body).
type PipelineDraftValidated struct {
	ProjectID      string   `json:"project_id"`
	DraftID        string   `json:"draft_id"`
	Valid          bool     `json:"valid"`
	RevisionDigest string   `json:"revision_digest,omitempty"`
	PlanDigest     string   `json:"plan_digest,omitempty"`
	ErrorCount     int      `json:"error_count"`
	ErrorCodes     []string `json:"error_codes"`
}

// Validate enforces § 3 row 33. Valid means § 2.2's success arm: both
// digests written and no errors; an invalid row must name at least one.
func (p PipelineDraftValidated) Validate() error {
	if p.ProjectID == "" {
		return fmt.Errorf("events: pipeline.draft.validated carries no project_id")
	}
	if p.DraftID == "" {
		return fmt.Errorf("events: pipeline.draft.validated carries no draft_id")
	}
	if p.ErrorCount < 0 || len(p.ErrorCodes) > p.ErrorCount {
		return fmt.Errorf("events: pipeline.draft.validated reports %d errors across %d codes", p.ErrorCount, len(p.ErrorCodes))
	}
	if p.Valid {
		if p.ErrorCount != 0 {
			return fmt.Errorf("events: pipeline.draft.validated is valid with %d errors", p.ErrorCount)
		}
		if !digestPattern.MatchString(p.RevisionDigest) || !digestPattern.MatchString(p.PlanDigest) {
			return fmt.Errorf("events: pipeline.draft.validated is valid without both digests (§ 2.2 writes them on success)")
		}
		return nil
	}
	if p.ErrorCount == 0 {
		return fmt.Errorf("events: pipeline.draft.validated is invalid without a single error")
	}
	if p.RevisionDigest != "" && !digestPattern.MatchString(p.RevisionDigest) {
		return fmt.Errorf("events: pipeline.draft.validated revision_digest %q is not sha256:<64 hex>", p.RevisionDigest)
	}
	if p.PlanDigest != "" && !digestPattern.MatchString(p.PlanDigest) {
		return fmt.Errorf("events: pipeline.draft.validated plan_digest %q is not sha256:<64 hex>", p.PlanDigest)
	}
	return nil
}

// PipelineRevisionPublished is § 3 row 34 — 09's name, kept. Every digest is
// a § 1 CHECK shape: these are the values a run pins (ADR-0002).
type PipelineRevisionPublished struct {
	ProjectID      string `json:"project_id"`
	PipelineID     string `json:"pipeline_id"`
	RevisionID     string `json:"revision_id"`
	RevisionNumber int    `json:"revision_number"`
	VersionLabel   string `json:"version_label"`
	RevisionDigest string `json:"revision_digest"`
	PlanDigest     string `json:"plan_digest"`
	DigestScope    string `json:"digest_scope"`
	SchemaDigest   string `json:"schema_digest"`
	CelEnvDigest   string `json:"cel_env_digest"`
}

// Validate enforces § 3 row 34 against § 1's pipeline_revisions CHECKs.
func (p PipelineRevisionPublished) Validate() error {
	if p.ProjectID == "" {
		return fmt.Errorf("events: pipeline.revision.published carries no project_id")
	}
	if p.PipelineID == "" || p.RevisionID == "" {
		return fmt.Errorf("events: pipeline.revision.published carries no pipeline or revision id")
	}
	if p.RevisionNumber < 1 {
		return fmt.Errorf("events: pipeline.revision.published revision_number %d is below 1", p.RevisionNumber)
	}
	if !versionLabelPattern.MatchString(p.VersionLabel) {
		return fmt.Errorf("events: pipeline.revision.published version_label %q is not semver (§ 1's CHECK)", p.VersionLabel)
	}
	if p.DigestScope == "" {
		return fmt.Errorf("events: pipeline.revision.published carries no digest_scope")
	}
	for name, d := range map[string]string{
		"revision_digest": p.RevisionDigest,
		"plan_digest":     p.PlanDigest,
		"schema_digest":   p.SchemaDigest,
		"cel_env_digest":  p.CelEnvDigest,
	} {
		if !digestPattern.MatchString(d) {
			return fmt.Errorf("events: pipeline.revision.published %s %q is not sha256:<64 hex", name, d)
		}
	}
	return nil
}

// PipelineRevisionDeprecated is § 3 row 35: the digest pins WHICH revision,
// so the journal survives a later publish shadowing the id.
type PipelineRevisionDeprecated struct {
	ProjectID      string `json:"project_id"`
	RevisionID     string `json:"revision_id"`
	RevisionDigest string `json:"revision_digest"`
}

// Validate enforces § 3 row 35.
func (p PipelineRevisionDeprecated) Validate() error {
	if p.ProjectID == "" {
		return fmt.Errorf("events: pipeline.revision.deprecated carries no project_id")
	}
	if p.RevisionID == "" {
		return fmt.Errorf("events: pipeline.revision.deprecated carries no revision_id")
	}
	if !digestPattern.MatchString(p.RevisionDigest) {
		return fmt.Errorf("events: pipeline.revision.deprecated revision_digest %q is not sha256:<64 hex", p.RevisionDigest)
	}
	return nil
}

// -------------------------------------------------------- assignment payloads

// validateAssignmentShape checks the members § 3 row 36 gives BOTH of its
// payloads; the bounds are assignments' § 1 CHECKs (1..8, the digest shape).
func validateAssignmentShape(typ, projectID, assignmentID, pipelineID, pinnedRevisionID, revisionDigest string, maxConcurrentRuns int, budgetOverrides map[string]any) error {
	switch {
	case projectID == "":
		return fmt.Errorf("events: %s carries no project_id", typ)
	case assignmentID == "":
		return fmt.Errorf("events: %s carries no assignment_id", typ)
	case pipelineID == "":
		return fmt.Errorf("events: %s carries no pipeline_id", typ)
	case pinnedRevisionID == "":
		return fmt.Errorf("events: %s carries no pinned_revision_id", typ)
	case !digestPattern.MatchString(revisionDigest):
		return fmt.Errorf("events: %s revision_digest %q is not sha256:<64 hex", typ, revisionDigest)
	case maxConcurrentRuns < 1 || maxConcurrentRuns > 8:
		return fmt.Errorf("events: %s max_concurrent_runs %d is outside 1..8 (§ 1's CHECK)", typ, maxConcurrentRuns)
	case budgetOverrides == nil:
		return fmt.Errorf("events: %s budget_overrides must be an object", typ)
	}
	return nil
}

// AssignmentCreated is § 3 row 36: the pin plus the ceilings, the whole M4
// assignment (channels and promotes stay M6).
type AssignmentCreated struct {
	ProjectID         string         `json:"project_id"`
	AssignmentID      string         `json:"assignment_id"`
	PipelineID        string         `json:"pipeline_id"`
	PinnedRevisionID  string         `json:"pinned_revision_id"`
	RevisionDigest    string         `json:"revision_digest"`
	MaxConcurrentRuns int            `json:"max_concurrent_runs"`
	BudgetOverrides   map[string]any `json:"budget_overrides"`
}

// Validate enforces § 3 row 36 (created).
func (a AssignmentCreated) Validate() error {
	return validateAssignmentShape("assignment.created", a.ProjectID, a.AssignmentID, a.PipelineID,
		a.PinnedRevisionID, a.RevisionDigest, a.MaxConcurrentRuns, a.BudgetOverrides)
}

// AssignmentUpdated is § 3 row 36: before{}/after{} carry only the changed
// members, so the journal answers "what did that PATCH do?" without a diff.
type AssignmentUpdated struct {
	ProjectID         string         `json:"project_id"`
	AssignmentID      string         `json:"assignment_id"`
	PipelineID        string         `json:"pipeline_id"`
	PinnedRevisionID  string         `json:"pinned_revision_id"`
	RevisionDigest    string         `json:"revision_digest"`
	MaxConcurrentRuns int            `json:"max_concurrent_runs"`
	BudgetOverrides   map[string]any `json:"budget_overrides"`
	Before            map[string]any `json:"before"`
	After             map[string]any `json:"after"`
}

// Validate enforces § 3 row 36 (updated): the created shape plus both
// before/after snapshots.
func (a AssignmentUpdated) Validate() error {
	if err := validateAssignmentShape("assignment.updated", a.ProjectID, a.AssignmentID, a.PipelineID,
		a.PinnedRevisionID, a.RevisionDigest, a.MaxConcurrentRuns, a.BudgetOverrides); err != nil {
		return err
	}
	if a.Before == nil || a.After == nil {
		return fmt.Errorf("events: assignment.updated carries no before{}/after{} snapshot")
	}
	return nil
}
