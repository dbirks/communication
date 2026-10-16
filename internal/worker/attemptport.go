package worker

import (
	"context"
	"time"
)

// This file defines what the M4 attempt-execution loop consumes: the worker's
// persistence port over the `attempts` claim unit (docs/m4-contract.md § 4,
// ADR-0023 § 4). It mirrors port.go's vocabulary on purpose — same lease
// triple semantics, same ErrLeaseLost (that var lives in port.go and is
// reused verbatim), plain structs only, no store type reaching execution
// semantics (AGENTS.md dependency rule). The Postgres implementation arrives
// in a later wave; the SQL shapes below are the frozen contract it must
// satisfy, and the fake store in attemptloop_test.go is shaped by the same
// sentences.

// Attempt statuses — the attempts.status CHECK set (contract § 1). A claim
// unit moves queued → leased → running → one of the four terminals; the
// terminal a stale writer may not speak is somebody else's to write.
const (
	AttemptStatusQueued      = "queued"
	AttemptStatusLeased      = "leased"
	AttemptStatusRunning     = "running"
	AttemptStatusSucceeded   = "succeeded"
	AttemptStatusFailed      = "failed"
	AttemptStatusCancelled   = "cancelled"
	AttemptStatusInterrupted = "interrupted"
)

// ErrorClasses is ADR-0023 § 7's closed enum, verbatim from the
// attempts_error_class CHECK (contract § 1). Nothing outside this set may
// name an attempt's error_class; a failure with no class in the enum is a
// bug in the emitter, not a fifth status.
const (
	ErrorClassInfra                  = "infra"
	ErrorClassInterrupted            = "interrupted"
	ErrorClassTimeout                = "timeout"
	ErrorClassAgentError             = "agent_error"
	ErrorClassInvalidOutput          = "invalid_output"
	ErrorClassPredicateError         = "predicate_error"
	ErrorClassSandboxEnforcementFail = "sandbox_enforcement_failed"
	ErrorClassWorkspaceLost          = "workspace_lost"
	ErrorClassBindingError           = "binding_error"
	ErrorClassApprovalExpired        = "approval_expired"
	ErrorClassCancelled              = "cancelled"
)

// Terminal reasons the worker may write (contract § 3 rows 23–24). The
// reconciler owns lease_expired/worker_gone; the worker owns its honest
// shutdown/takeover arms and the two cancel-ack reasons.
const (
	InterruptReasonWorkerShutdown = "worker_shutdown"
	InterruptReasonHumanTakeover  = "human_takeover"
	CancelReasonACPAck            = "acp_cancel_ack"
	CancelReasonProcessTerminated = "process_group_terminated"
)

// AttemptClaim is one attempt won by ClaimAttempts: the lease triple
// (attempt id, worker id, fencing token) plus everything needed to run the
// attempt without re-reading mutable state — the same rule as Claim in
// port.go. Runs carry their pinned digests; a later wave reads nothing
// mutable between claim and boundary.
type AttemptClaim struct {
	AttemptID       string
	NodeExecutionID string
	RunID           string
	ProjectID       string
	OrganizationID  string
	WorkerID        string
	FencingToken    int64

	NodeID          string
	NodeInstanceKey string
	Kind            string // agent.acp | process.exec | model.chat | artifact.publish
	AttemptNumber   int

	// DeadlineAt is attempts.deadline_at (the node's timeoutSeconds arm).
	// Zero means no node deadline; the reconciler's pass 3 remains the
	// backstop either way.
	DeadlineAt time.Time

	// Config is the compiled node config with its bindings resolved (the
	// bindingText / argv / outputExtraction the executor dispatches on). The
	// real claim SQL hydrates it from the run's plan_snapshot plus the
	// advancer's per-attempt resolution; it is opaque to the loop and owned
	// by the executor for the kind.
	Config map[string]any
}

// AttemptEvent is one journal append made on behalf of an attempt. The store
// sets the run_id / node_execution_id / attempt_id correlation columns from
// the claim (contract § 3's correlation rule: a worker row that touches a
// node execution sets all three, not just the payload).
type AttemptEvent struct {
	Type      string
	ActorKind string
	ActorID   string
	Payload   any
}

// CheckpointRepoState is one repository at a checkpoint boundary: commits and
// a modified-paths artifact reference, never paths (contract § 1's
// run_checkpoints.repo_states shape, ADR-0017 D8).
//
// The json names are the wire names and they are load-bearing, twice over.
// They are the shape `api/openapi.yaml`'s CheckpointRepoState and contract
// § 9.1 row 304 publish (`repository_id, base_commit, head_commit,
// modified_paths_artifact`), and the same row is what the ENGINE hydrates back
// into `runtime.RepoState` to answer "what does this retry inherit?"
// (ADR-0023 § 6). A boundary written with Go field names hydrates as empty
// states, and an empty state silently drops `head_commit` from every
// continue_workspace retry_context (lab live13 C5e).
type CheckpointRepoState struct {
	RepositoryID          string `json:"repository_id"`
	BaseCommit            string `json:"base_commit"`
	HeadCommit            string `json:"head_commit"`
	ModifiedPathsArtifact string `json:"modified_paths_artifact,omitempty"`
	// ModifiedPathCount and Committed are the ADR-0017 D8 capture's bookkeeping,
	// part of the record so a retry names the working tree it inherits and
	// `restore_checkpoint` can refuse a dirty one. They are nil when no capture
	// ever recorded this repository: "nobody measured" must not be written as
	// `0`/`true`, because both of those are promises something destructive is
	// allowed to act on.
	ModifiedPathCount *int64 `json:"modified_path_count,omitempty"`
	Committed         *bool  `json:"committed,omitempty"`
}

// RepoStateCapture builds the two capture pointers for a boundary record from
// a manifest that a capture actually wrote. It returns pointers rather than
// plain values because the honest third state — "no capture had read this
// repository" — must be expressible as nil, and neither `0` nor `true` is a
// substitute for it.
func RepoStateCapture(paths int, committed bool) (*int64, *bool) {
	n := int64(paths)
	c := committed
	return &n, &c
}

// AttemptCheckpoint is the run_checkpoints row the boundary transaction
// inserts (contract § 4 step 10, D-009). The store fills the identity
// columns it already knows (run/node/attempt ids, created_at); VolumeID must
// be non-empty — a checkpoint that names no volume promises a restore nobody
// can perform (D-024 stays Open: same-volume only).
type AttemptCheckpoint struct {
	InputsDigest  string
	OutputsDigest string
	ArtifactRefs  []any
	RepoStates    []CheckpointRepoState
	WorkspaceID   string
	VolumeID      string
	WorkerID      string
	PlanDigest    string
}

// AttemptStore is the attempt loop's persistence port, implemented later by
// a Postgres adapter the same way *postgres.TurnStore implements TurnStore.
// Every method whose name takes an AttemptClaim must fail with ErrLeaseLost
// when the (attemptID, workerID, fencingToken) triple is not the current one
// (ADR-0016 § 9 obligation 2, contract § 4 step 10's "I am dead" typed
// error) and must write nothing in that case — fail closed, not partially.
//
// A worker never writes run- or node-execution-level state here: the
// advancer derives downstream `ready` rows from the rows this port's fenced
// transactions leave behind (contract § 4 step 14).
type AttemptStore interface {
	// ClaimAttempts wins up to `capacity` queued attempts in one transaction
	// (the caller passes its *free* slots: configured capacity minus
	// attempts in flight). The real implementation is ADR-0023 § 4's single
	// statement (contract § 4 step 2, frozen here):
	//
	//   * FOR UPDATE SKIP LOCKED over `attempts` joined to live runs and
	//     non-terminal node executions;
	//   * batch size = free capacity, i.e. `capacity` and never more;
	//   * predicate includes wr.active_attempts < wr.capacity — the worker's
	//     own slot arithmetic is an optimization, the DB column is the
	//     backstop two racing replicas cannot both outrun;
	//   * tie-break ORDER BY r.priority DESC, a2.scheduled_at, a2.id;
	//   * attempt_fencing_seq is drawn ONCE PER CLAIM (one nextval for the
	//     whole batch, not per row), so max(fencing_token) equals the claim
	//     count and a replacement claim always carries a strictly greater
	//     token (contract § 7 C3c, `12` case 3);
	//   * the same transaction sets status='leased', worker_id,
	//     lease_expires_at and bumps workers.active_attempts (§ 4 step 1).
	//
	// Control-plane work has no attempts row and is therefore unclaimable by
	// construction (§ 4 step 14).
	ClaimAttempts(ctx context.Context, workerID string, capacity int) ([]AttemptClaim, error)

	// RenewAttempt extends the attempt lease — and, in the SAME statement,
	// the lease of the turn this attempt owns when it has one (contract § 4
	// step 6: a turn lease can never outlive its attempt, ADR-0023 § 4's
	// two-lease rule). ErrLeaseLost when the triple no longer matches.
	RenewAttempt(ctx context.Context, c AttemptClaim) error

	// BeginAttempt moves leased→running and appends node.attempt.started in
	// the same transaction (contract § 3 row 20). The event's honesty fields
	// (sandbox_verified, session_resumed) are wired by the executor waves
	// that can actually observe them; the claim-fence is what this wave
	// proves.
	BeginAttempt(ctx context.Context, c AttemptClaim) error

	// AppendAttemptEvent is the fenced journal append for every event an
	// attempt body emits while it runs.
	AppendAttemptEvent(ctx context.Context, c AttemptClaim, ev AttemptEvent) error

	// CancelRequestedAttempt reads this attempt's cancel_requested_at
	// (written by the advancer's cascade or the reconciler's deadline pass,
	// § 5.4 pass 3); ErrLeaseLost when the triple is stale.
	CancelRequestedAttempt(ctx context.Context, c AttemptClaim) (time.Time, bool, error)

	// CompleteAttempt is the boundary transaction (contract § 4 step 10;
	// same argument set as runtime.MemStore.Complete at store.go:263):
	// validated outputs + outputs_digest + artifact_refs + the node's
	// business outcome + the run_checkpoints row, with node.attempt.completed
	// and run.checkpoint_saved appended in the same fenced transaction. The
	// store also decrements workers.active_attempts here — only after the
	// terminal write commits (§ 4 step 1). A succeeded attempt HAS outputs,
	// possibly empty (01 invariant 4); an oversize outputs envelope must
	// have travelled as a kind=json artifact before this call (§ 6 cap).
	CompleteAttempt(ctx context.Context, c AttemptClaim, outputs any, outputsDigest string, artifactRefs []any, outcome string, ckpt AttemptCheckpoint) error

	// FailAttempt closes the attempt failed with an ADR-0023 § 7 class and a
	// bounded (≤ 512 B, redaction-scanned) detail; outputErrors carries the
	// invalid_output evidence. The retry decision is the advancer's, from
	// rows — this call never schedules the next attempt.
	FailAttempt(ctx context.Context, c AttemptClaim, class, detail string, outputErrors []any) error

	// InterruptAttemptOwn is the worker closing ITS OWN attempt honestly
	// (contract § 3 row 23's worker_shutdown / human_takeover arms — fenced,
	// because "still able to speak" is exactly what the fence proves).
	// lease_expired and worker_gone belong to the reconciler, never here.
	InterruptAttemptOwn(ctx context.Context, c AttemptClaim, reason string) error

	// CancelAttemptOwn closes a cancel-requested attempt as cancelled after
	// the executor stopped (contract § 4 step 11: reason acp_cancel_ack or
	// process_group_terminated; if the ack never came, the honest close is
	// InterruptAttemptOwn instead, and this call is never made).
	CancelAttemptOwn(ctx context.Context, c AttemptClaim, reason string) error
}
