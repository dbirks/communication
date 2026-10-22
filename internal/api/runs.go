package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/dbirks/communication/internal/authz"
	"github.com/dbirks/communication/internal/events"
)

// The M4 execution surface: assignments, runs, node executions, checkpoints,
// the child-run tree, attempts and the run-scoped event stream
// (docs/m4-contract.md § 2.1 routes 17–33, api/openapi.yaml v0.4.0-m4,
// ADR-0023).
//
// The rules that shape every handler here:
//
//   - A run PINS. revision_digest, plan_digest and the snapshots are copied
//     at creation in one transaction; nothing on this surface re-resolves
//     them (12 case 11), so every digest the API echoes is stored truth.
//   - Lease machinery is invisible. worker_id, fencing_token and
//     lease_expires_at do not exist on any view type in this file — a
//     browser cannot participate in lease arbitration (ADR-0016 § 8), and
//     placement is the boolean {scheduled, reason} view of ADR-0023 § 5.
//   - Lifecycle actions nudge the advancer, they never do its work. pause/
//     resume/cancel/retry and the run-creating POST commit state + journal
//     in the store and then fire M4Trigger; the advancer re-derives every
//     readiness fact from rows, so a dropped trigger costs latency, never
//     correctness (the reconciler's backstop pass is the proof).

// M4Trigger nudges the advancer for one run after a route changed state it
// must react to (run creation, pause/resume/cancel/retry, an approval
// decision). The serve wave injects the real implementation; tests pass a
// recording fake. A nil trigger is legal: every route's state write is
// complete without it (the reconciler re-derives), the trigger only bounds
// latency.
type M4Trigger func(ctx context.Context, runID string)

// Errors the run/assignment handlers understand; store adapters map their
// own errors onto these (the same indirection keeps this package free of
// any driver dependency).
var (
	// ErrRunNotFound is also "you may not know this run/node/attempt
	// exists": a row of a project the caller cannot see answers 404 with
	// the same bytes as nonsense (12 case 15's rule, extended by route
	// W9's UI legs).
	ErrRunNotFound = errors.New("api: run object not found")
	// ErrAssignmentNotFound covers assignments on every assignment route.
	ErrAssignmentNotFound = errors.New("api: assignment not found")
	// ErrAssignmentConflict is the UNIQUE (project_id, pipeline_id) refusal
	// — an assignment is re-pinned through PATCH, never replaced.
	ErrAssignmentConflict = errors.New("api: assignment already exists for this pipeline")
	// ErrBudgetOverridesRaise is the § 2.1 route 18 refusal: an assignment
	// is a governor, not an upgrade path (07 "Budget/limit layers"). The
	// comparison against the pinned revision's declared budgets happens in
	// the store, next to the plan; the API renders the 400.
	ErrBudgetOverridesRaise = errors.New("api: budget_overrides_may_only_lower")
	// ErrRunSourceProjectMismatch (ADR-0053): the source conversation is
	// visible but lives in another project than the URL claims — a 422
	// refusal (the caller names two visible objects; the claim is false).
	ErrRunSourceProjectMismatch = errors.New("api: the source conversation belongs to a different project")
	// ErrRunSourceArtifactTaken (ADR-0053): the named artifact is already
	// attached to another run — a 422 refusal; re-attach through that run,
	// never a second attachment.
	ErrRunSourceArtifactTaken = errors.New("api: the named artifact is already attached to another run")
	// ErrNodeExecutionNotFound is route 31's 404: the retry body named a
	// `node_instance_keys[]` entry that is not a node execution of the run.
	// The client asked to act on a row that does not exist — a client error,
	// never a 500, and nothing is reset (the engine validates every target
	// before any row moves).
	ErrNodeExecutionNotFound = errors.New("api: node execution not found in run")
)

// Run-conflict kinds: the § 2.1 route vocabulary for lifecycle refusals.
const (
	RunConflictNotRetriable          = "run_not_retriable"
	RunConflictCheckpointUnavailable = "checkpoint_unavailable"
	RunConflictState                 = "run_state_conflict"
	RunConflictIdempotencyMismatch   = "idempotency_key_mismatch"
)

// RunConflictError is a refused run lifecycle action that must answer 409
// with the run's current status so the client can re-read cheaply
// (RunConflictProblem). Idempotency and pre-run refusals carry no RunID:
// they render as the plain typed 409, because a RunConflictProblem without
// a run is a lie about what exists.
type RunConflictError struct {
	Kind      string
	Detail    string
	RunID     string
	RunStatus string
}

func (e *RunConflictError) Error() string {
	return fmt.Sprintf("api: run conflict (%s): %s", e.Kind, e.Detail)
}

// NodeExecutionNotFound names the offending target so the 404 body can point
// at it (`node_instance_key`): the client already knows the run it addressed,
// what it does not know is that its key is not one of that run's nodes.
type NodeExecutionNotFound struct {
	NodeInstanceKey string
}

func (e *NodeExecutionNotFound) Error() string {
	return fmt.Sprintf("api: no node execution %q in this run", e.NodeInstanceKey)
}

// Unwrap keeps the plain sentinel working for stores that cannot name the key.
func (e *NodeExecutionNotFound) Unwrap() error { return ErrNodeExecutionNotFound }

// RunInputsInvalid is the POST /runs 422: the submitted inputs failed
// validation against the pinned revision's spec.inputs, reported in the
// § 2.2 unit shape so one client-side renderer covers editors and runners
// (ValidateProblem).
type RunInputsInvalid struct {
	Detail string
	Errors []ValidateError
}

func (e *RunInputsInvalid) Error() string { return "api: run inputs failed validation: " + e.Detail }

// --- views (api/openapi.yaml schemas) --------------------------------------

// RunSummaryView is the RunSummary schema. The digests ride the list row on
// purpose: "which revision is this run executing?" is a first-glance
// question with pinned, immutable data as its answer.
type RunSummaryView struct {
	ID                 string     `json:"id"`
	ProjectID          string     `json:"project_id"`
	PipelineID         string     `json:"pipeline_id"`
	PipelineRevisionID string     `json:"pipeline_revision_id"`
	AssignmentID       *string    `json:"assignment_id"`
	RevisionDigest     string     `json:"revision_digest"`
	PlanDigest         string     `json:"plan_digest"`
	Status             string     `json:"status"`
	FailedCause        *string    `json:"failed_cause"`
	Depth              int        `json:"depth"`
	ParentRunID        *string    `json:"parent_run_id"`
	TriggeredBy        *string    `json:"triggered_by"`
	Priority           int        `json:"priority"`
	CreatedAt          time.Time  `json:"created_at"`
	StartedAt          *time.Time `json:"started_at"`
	FinishedAt         *time.Time `json:"finished_at"`
	// Trigger (ADR-0056) is how this run was started: manual, schedule, issue
	// or thread, with the trigger's own identifier in Ref (the schedule id, the
	// `owner/repo#<number>`, or null for a manual/thread start — the thread is
	// the trigger context, ADR-0053).
	Trigger *RunTriggerView `json:"trigger"`
}

// RunTriggerView is the run JSON's `trigger` member (ADR-0056): the kind how
// the run was started and the trigger's own identifier. `ref` is null for a
// 'manual' or 'thread' start — the context is the thread itself — and names
// the schedule id or `owner/repo#<number>` for a 'schedule' or 'issue' start.
type RunTriggerView struct {
	Kind string  `json:"kind"`
	Ref  *string `json:"ref"`
}

// runTriggerKinds is the ADR-0056 trigger vocabulary the run lists accept as
// the `trigger` filter (and the run JSON's kind field).
var runTriggerKinds = map[string]bool{
	"manual":   true,
	"schedule": true,
	"issue":    true,
	"thread":   true,
}

// RunSummaryListView is the RunSummaryList envelope.
type RunSummaryListView struct {
	Runs []RunSummaryView `json:"runs"`
}

// RunPlacementView is RunPlacement: the honest scheduling answer, never the
// worker id (ADR-0023 § 4/§ 5). scheduled=false on a queued run says
// "waiting for the run's worker" in data.
type RunPlacementView struct {
	Scheduled bool    `json:"scheduled"`
	Reason    *string `json:"reason"`
}

// RunInputValueView is RunInputValue: the value bindings read, plus where
// it came from (submitted/default/override), so "what did the loop actually
// receive?" is answerable from the row.
type RunInputValueView struct {
	Name   string          `json:"name"`
	Value  json.RawMessage `json:"value"`
	Origin string          `json:"origin"`
}

// RunRepoSnapshotView is RunRepoSnapshot: a commit identity, never a path.
type RunRepoSnapshotView struct {
	RepositoryID string `json:"repository_id"`
	BaseCommit   string `json:"base_commit"`
}

// RunSourceBaseRepoView is one repository's honest base answer in the create
// response (ADR-0053, artboard 5d's CARRIES OVER panel): whether the thread
// branch carried commits and, when it did, the pinned commit. BaseCommit is
// null in default_branch mode — there is no pinned identity to name.
type RunSourceBaseRepoView struct {
	RepositoryID string  `json:"repository_id"`
	Mode         string  `json:"mode"` // thread_branch | default_branch
	BaseCommit   *string `json:"base_commit"`
	Reason       string  `json:"reason"`
}

// RunSourceBaseView is the create response's `base` member: one row per
// repository of the project, in name order.
type RunSourceBaseView struct {
	Repositories []RunSourceBaseRepoView `json:"repositories"`
}

// RunView is the Run schema (RunSummary plus the pause/cancellation facts,
// the placement view, the validated inputs and the expression counter).
// MyRole travels for the mutation gates and is never serialized.
type RunView struct {
	RunSummaryView
	DigestScope           string                `json:"digest_scope"`
	ExpressionEvaluations int                   `json:"expression_evaluations"`
	Placement             RunPlacementView      `json:"placement"`
	PausedReason          *string               `json:"paused_reason"`
	CancelRequestedAt     *time.Time            `json:"cancel_requested_at"`
	Inputs                []RunInputValueView   `json:"inputs"`
	RepoSnapshot          []RunRepoSnapshotView `json:"repo_snapshot"`
	// SourceConversationID (ADR-0053) is the thread this run was started
	// from; nil for an ordinary run. SourceBase is the create response's
	// honest per-repository base answer — set by CreateRun only, never a
	// stored field.
	SourceConversationID *string            `json:"source_conversation_id"`
	SourceBase           *RunSourceBaseView `json:"source_base,omitempty"`

	MyRole string `json:"-"`
}

// RunCreateResponse is the 201 (and the idempotent 200): the run is queued
// and pinned; every later fact arrives through GET /runs or its stream.
// Base (ADR-0053) is present only when the request carried source:
// per-repository answers to "does the thread branch carry anything?".
type RunCreateResponse struct {
	RunID  string             `json:"run_id"`
	Status string             `json:"status"`
	Base   *RunSourceBaseView `json:"base,omitempty"`
}

// RunSourceInput is the validated shape of RunCreate.source (ADR-0053):
// the thread the run starts from, the optional handoff summary and the
// artifact ids attached to the run by reference. Nil = an ordinary run.
type RunSourceInput struct {
	ConversationID string
	Summary        string // "" ⇒ no handoff_summary input
	ArtifactIDs    []string
}

const (
	// RunBaseThreadBranch: the run bases on the thread branch's recorded
	// head commit, pinned into repo_snapshot at creation.
	RunBaseThreadBranch = "thread_branch"
	// RunBaseDefaultBranch: the thread branch carried no recorded commits
	// beyond its base for this repository; the run starts from the
	// repository's default branch (today's startPoint).
	RunBaseDefaultBranch = "default_branch"
)

// NodeExecutionView is the NodeExecution schema: one execution of one node
// at one place in the run's tree of scopes, keyed by the text path
// (01 invariant 6). iterations/items appear on control-plane scope nodes
// only; an absent pointer serializes as absent, never as a wrong zero.
type NodeExecutionView struct {
	ID                string          `json:"id"`
	RunID             string          `json:"run_id"`
	NodeID            string          `json:"node_id"`
	Kind              string          `json:"kind"`
	NodeInstanceKey   string          `json:"node_instance_key"`
	ScopeKey          string          `json:"scope_key"`
	ExecutionLocation string          `json:"execution_location"`
	Status            string          `json:"status"`
	Outcome           *string         `json:"outcome"`
	ErrorClass        *string         `json:"error_class"`
	FailedCause       *string         `json:"failed_cause"`
	Outputs           json.RawMessage `json:"outputs"`
	ArtifactRefs      json.RawMessage `json:"artifact_refs"`
	DependsOn         json.RawMessage `json:"depends_on"`
	AttemptCount      int             `json:"attempt_count"`
	AttemptLimit      int             `json:"attempt_limit"`
	InFlight          int             `json:"in_flight"`
	WaitingReason     *string         `json:"waiting_reason"`
	Iterations        *int            `json:"iterations,omitempty"`
	Items             *int            `json:"items,omitempty"`
	CreatedAt         time.Time       `json:"created_at"`
	ReadyAt           *time.Time      `json:"ready_at"`
	FinishedAt        *time.Time      `json:"finished_at"`

	MyRole string `json:"-"`
}

// NodeExecutionListView is the NodeExecutionList envelope.
type NodeExecutionListView struct {
	NodeExecutions []NodeExecutionView `json:"node_executions"`
}

// CelEnvelopeView is the CelEnvelope schema: the object a nodes.<id>
// expression reads, published for every declared node including
// unscheduled ones — which is what makes a when/skipped decision
// explainable after the fact (ADR-0022 § 3).
type CelEnvelopeView struct {
	Status       string          `json:"status"`
	Outcome      *string         `json:"outcome"`
	Outputs      json.RawMessage `json:"outputs"`
	ArtifactRefs json.RawMessage `json:"artifact_refs"`
}

// AttemptView is the Attempt schema. There is deliberately no worker_id,
// fencing_token or lease_expires_at FIELD on this struct: the fence keeps
// stale writers out because the server asserts it, not because clients can
// see it (ADR-0016 § 8).
type AttemptView struct {
	ID              string          `json:"id"`
	NodeExecutionID string          `json:"node_execution_id"`
	RunID           string          `json:"run_id"`
	AttemptNumber   int             `json:"attempt_number"`
	Status          string          `json:"status"`
	ErrorClass      *string         `json:"error_class"`
	Detail          *string         `json:"detail"`
	OutputErrors    json.RawMessage `json:"output_errors"`
	ScheduledAt     time.Time       `json:"scheduled_at"`
	DeadlineAt      *time.Time      `json:"deadline_at"`
	Overrides       json.RawMessage `json:"overrides"`
	RetryContext    json.RawMessage `json:"retry_context"`
	ArtifactRefs    json.RawMessage `json:"artifact_refs"`
	Outputs         json.RawMessage `json:"outputs"`
	OutputsDigest   *string         `json:"outputs_digest"`
	ConversationID  *string         `json:"conversation_id"`
	TurnID          *string         `json:"turn_id"`
	CreatedAt       time.Time       `json:"created_at"`
	StartedAt       *time.Time      `json:"started_at"`
	FinishedAt      *time.Time      `json:"finished_at"`

	MyRole string `json:"-"`
}

// RunCheckpointView is the RunCheckpoint schema — D-009's durable boundary
// record. volume_id + workspace_id are M3's honest identity; absolute paths
// are absent by construction, and worker_id is browser-visible exactly as
// far as M3 already made it (fleet identity, not lease machinery).
type RunCheckpointView struct {
	RunID           string          `json:"run_id"`
	NodeExecutionID string          `json:"node_execution_id"`
	AttemptID       string          `json:"attempt_id"`
	NodeInstanceKey string          `json:"node_instance_key"`
	InputsDigest    string          `json:"inputs_digest"`
	OutputsDigest   string          `json:"outputs_digest"`
	RepoStates      json.RawMessage `json:"repo_states"`
	ArtifactRefs    json.RawMessage `json:"artifact_refs"`
	WorkspaceID     string          `json:"workspace_id"`
	VolumeID        string          `json:"volume_id"`
	WorkerID        string          `json:"worker_id"`
	PlanDigest      string          `json:"plan_digest"`
	CreatedAt       time.Time       `json:"created_at"`
}

// RunCheckpointListView is the RunCheckpointList envelope.
type RunCheckpointListView struct {
	Checkpoints []RunCheckpointView `json:"checkpoints"`
}

// NodeExecutionDetailView is the NodeExecutionDetail schema: the execution,
// its full append-only attempt history, its boundary checkpoint when one
// exists, and the CEL envelope expressions against it actually saw.
type NodeExecutionDetailView struct {
	NodeExecutionView
	Attempts    []AttemptView      `json:"attempts"`
	Checkpoint  *RunCheckpointView `json:"checkpoint"`
	CelEnvelope CelEnvelopeView    `json:"cel_envelope"`
}

// RunTreeView is the RunTree schema: a run and the child runs its
// pipeline_invocations produced, recursively (root depth 0, ceiling 2 —
// a third level is refused by the compiler AND a DB CHECK).
type RunTreeView struct {
	Run             RunSummaryView `json:"run"`
	NodeInstanceKey *string        `json:"node_instance_key"`
	WaitPolicy      *string        `json:"wait_policy"`
	Depth           *int           `json:"depth"`
	Children        []RunTreeView  `json:"children"`
}

// AssignmentView is the Assignment schema: a pin plus budgets — not a
// rollout channel and not a promotion workflow (all M6).
type AssignmentView struct {
	ID                   string          `json:"id"`
	ProjectID            string          `json:"project_id"`
	PipelineID           string          `json:"pipeline_id"`
	PinnedRevisionID     string          `json:"pinned_revision_id"`
	PinnedRevisionDigest string          `json:"pinned_revision_digest"`
	PinnedVersionLabel   *string         `json:"pinned_version_label"`
	MaxConcurrentRuns    int             `json:"max_concurrent_runs"`
	BudgetOverrides      json.RawMessage `json:"budget_overrides"`
	EffectiveBudgets     json.RawMessage `json:"effective_budgets"`
	Enabled              bool            `json:"enabled"`
	Version              int             `json:"version"`
	CreatedAt            time.Time       `json:"created_at"`
	UpdatedAt            time.Time       `json:"updated_at"`

	MyRole string `json:"-"`
}

// AssignmentListView is the AssignmentList envelope.
type AssignmentListView struct {
	Assignments []AssignmentView `json:"assignments"`
}

// --- store interfaces (implemented by the serve-wave postgres adapter) -----

// RunStore is the execution ledger's read/write face behind the API. Every
// method enforces the caller's project visibility itself — a run, node
// execution, checkpoint or attempt of an invisible project answers
// ErrRunNotFound, the same bytes a random uuid produces — and every
// mutation writes state + its § 3 journal row(s) in ONE transaction
// (run.created, run.paused, run.resumed, run.cancel_requested, run.retried;
// the events' payload shapes are owned by internal/events, this store
// appends them).
type RunStore interface {
	// CreateRun resolves the pin (assignment → its pinned revision, or the
	// direct pipeline_revision_id), copies revision_digest, plan_digest,
	// plan_snapshot, policies_snapshot (the assignment's budget overrides
	// applied to the declared budgets) and repo_snapshot (starting base
	// commits, 03 step 2), validates Inputs against spec.inputs (defaulting
	// absent optionals and recording each input's origin), enforces
	// assignments.max_concurrent_runs, and appends run.created — all in one
	// transaction, so after the 201 no library edit can reach this run
	// (12 case 11). The bool reports first creation vs idempotent replay:
	// a replay returns the STORED run with Created=false and touches no row
	// (12 case 1). Same key + different body is ErrIdempotencyMismatch as a
	// *RunConflictError (kind idempotency_key_mismatch, no RunID).
	CreateRun(ctx context.Context, c Caller, in RunCreateInput) (RunView, bool, error)
	// GetRun is route 23: the run detail with inputs, repo_snapshot and the
	// placement view. The adapter derives Placement from the run's affinity
	// and its worker's state (§ 5.2): queued + affinity worker
	// offline/draining/full ⇒ {scheduled:false,
	// reason:"volume_affinity_unsatisfied"}; this layer never re-derives it
	// from a memory and never names the worker.
	GetRun(ctx context.Context, c Caller, runID string) (RunView, error)
	ListProjectRuns(ctx context.Context, c Caller, projectID string) ([]RunSummaryView, error)
	// ListProjectRunsFiltered is route 21's ADR-0056 read: the project's runs,
	// optionally kept only to the started-by trigger kind (validated by the
	// handler before it reaches the store).
	ListProjectRunsFiltered(ctx context.Context, c Caller, projectID string, trigger string) ([]RunSummaryView, error)
	// ListRunNodes returns every node execution ordered by
	// node_instance_key (route 24).
	ListRunNodes(ctx context.Context, c Caller, runID string) ([]NodeExecutionView, error)
	// GetRunNode enforces the (runId, nodeExecutionId) pair: a node of
	// another run answers ErrRunNotFound even when the caller may see both
	// rows — the URL is a claim about a relationship, and a route that
	// ignores half of it leaks across it.
	GetRunNode(ctx context.Context, c Caller, runID, nodeExecutionID string) (NodeExecutionDetailView, error)
	GetRunTree(ctx context.Context, c Caller, runID string) (RunTreeView, error)
	ListRunCheckpoints(ctx context.Context, c Caller, runID string) ([]RunCheckpointView, error)
	// PauseRun sets status=paused, paused_reason=manual and stops FUTURE
	// scheduling only: live attempts keep their leases and report their
	// real outcomes (§ 5.3 / route 28). waiting_human, already-paused and
	// terminal runs refuse with *RunConflictError (kind
	// run_state_conflict); run.paused names the in_flight_attempts that
	// continued past the pause.
	PauseRun(ctx context.Context, c Caller, runID string) (RunView, error)
	// ResumeRun moves paused → queued; the advancer re-derives readiness
	// from rows afterwards (trigger). run.resumed names the paused_reason
	// it cleared — including human_takeover (§ 5.3).
	ResumeRun(ctx context.Context, c Caller, runID string) (RunView, error)
	// CancelRun sets cancel_requested_at (a REQUEST, not a stop: the
	// advancer cascades queued/ready rows, marks live attempts
	// cancel-requested and recurses into children, § 5.5 / route 30). A
	// terminal run refuses; run.cancel_requested carries cascade+children.
	CancelRun(ctx context.Context, c Caller, runID string) (RunView, error)
	// RetryRun re-queues the targeted (default: every non-succeeded
	// terminal) node executions with retry_context, recomputing scope
	// bookkeeping so an until restarts its dead iteration, not the loop
	// (§ 6). A node declaring restore_checkpoint additionally requires
	// every repo committed at that boundary — otherwise
	// checkpoint_unavailable and NOTHING is reset (12 C6d: a destructive
	// default would be a data-loss bug wearing a feature badge). running /
	// completed / cancelled-successfully runs refuse with
	// run_not_retriable. When a target is a human.approval gate the reopen
	// RE-ARMS that node's existing approval_requests row — its decision and
	// deadline reset, its CAS version bumps, its created_at stays, and
	// re_requested marks the re-ask — because ADR-0023 § 9 admits ONE gate
	// row per node execution; a gate whose row carries a decision or a
	// recorded refusal cannot be re-asked and answers the same
	// run_not_retriable, never a 500. Retry-time Inputs are recorded as run
	// inputs; run.override.applied stays reserved (ADR-0024 § 3).
	RetryRun(ctx context.Context, c Caller, runID string, in RunRetryInput) (RunView, error)
	// GetAttempt is route 32 (openapi numbering: /attempts/{attemptId});
	// the view type has no lease columns to leak.
	GetAttempt(ctx context.Context, c Caller, attemptID string) (AttemptView, error)
	// RecordDenied writes the audit row for a refused run-family request;
	// the adapter resolves the owning project from the resource id where
	// one exists (audit_events.project_id is nullable).
	RecordDenied(ctx context.Context, c Caller, resourceID, action string) error
}

// AssignmentStore is the assignment CRUD behind routes 17–20, each method
// enforcing the caller's visibility (a cross-organization assignment is
// ErrAssignmentNotFound) and appending assignment.created /
// assignment.updated (with the before/after pair) in its transaction.
type AssignmentStore interface {
	ListAssignments(ctx context.Context, c Caller, projectID string) ([]AssignmentView, error)
	// CreateAssignment validates the pin (the revision must be published,
	// of pipeline_id, and in this organization — 404 otherwise) and the
	// budget layering (ErrBudgetOverridesRaise when an override RAISES a
	// declared ceiling).
	CreateAssignment(ctx context.Context, c Caller, projectID string, in AssignmentCreateInput) (AssignmentView, error)
	GetAssignment(ctx context.Context, c Caller, assignmentID string) (AssignmentView, error)
	// UpdateAssignment applies a PATCH; re-pinning takes effect at NEW run
	// creation only — queued and running runs keep their snapshot (ADR-0002).
	UpdateAssignment(ctx context.Context, c Caller, assignmentID string, in AssignmentPatchInput) (AssignmentView, error)
	// DeleteAssignment removes the row; existing runs keep their pinned
	// revision and policies_snapshot because they reference the revision,
	// not the assignment, for everything that executes — the adapter
	// detaches referencing runs' assignment_id (SET NULL) rather than
	// refusing, which is what makes route 20's promise true.
	DeleteAssignment(ctx context.Context, c Caller, assignmentID string) error
	RecordDenied(ctx context.Context, c Caller, resourceID, action string) error
}

// RunEventStream is the journal read behind the run SSE stream. The adapter
// resolves the run's project in SQL behind the caller's membership (the
// committed postgres RunEventsAfter's read, filtered by the
// domain_events.run_id partial index), so a caller removed mid-stream
// starts answering ErrRunNotFound — the stream's stop signal — and never
// delivers a foreign row.
type RunEventStream interface {
	// RunEventsAfter returns up to limit envelopes for one run with
	// global_seq strictly greater than afterSeq, oldest first.
	RunEventsAfter(ctx context.Context, c Caller, runID string, afterSeq int64, limit int) ([]events.Envelope, error)
	// Watch is the same shared wake-up source as the project and
	// conversation streams (ADR-0014 § 6: notification is an optimization;
	// the handler re-queries by sequence).
	Watch(ctx context.Context) (<-chan struct{}, func(), error)
}

// --- inputs (handler → store) -----------------------------------------------

// RunCreateInput is a validated-for-shape POST /runs request: the handler
// has checked the pin exclusivity, the idempotency key grammar, and computed
// RequestSHA over the exact request bytes.
type RunCreateInput struct {
	ProjectID          string
	AssignmentID       string
	PipelineRevisionID string
	Inputs             map[string]json.RawMessage
	Key                string
	RequestSHA         string
	TriggeredBy        string
	// Source (ADR-0053): the thread this run is handed from; nil = ordinary run.
	Source *RunSourceInput
}

// RunRetryInput is the retry request; empty NodeInstanceKeys means "every
// non-succeeded terminal node execution".
type RunRetryInput struct {
	NodeInstanceKeys []string
	Inputs           map[string]json.RawMessage
	Reason           string
	RequestedBy      string
}

// AssignmentCreateInput is route 18's body after shape validation.
type AssignmentCreateInput struct {
	PipelineID        string
	PinnedRevisionID  string
	MaxConcurrentRuns int // 0 ⇒ server default 1
	BudgetOverrides   json.RawMessage
}

// AssignmentPatchInput is route 19's body; nil members do not move.
type AssignmentPatchInput struct {
	PinnedRevisionID  *string
	MaxConcurrentRuns *int
	BudgetOverrides   *json.RawMessage
	Enabled           *bool
}

// --- request bodies ----------------------------------------------------------

type rnRunSourceBody struct {
	ConversationID string   `json:"conversation_id"`
	Summary        *string  `json:"summary"`
	ArtifactIDs    []string `json:"artifact_ids"`
}

type rnRunCreateBody struct {
	AssignmentID       string                     `json:"assignment_id,omitempty"`
	PipelineRevisionID string                     `json:"pipeline_revision_id,omitempty"`
	Inputs             map[string]json.RawMessage `json:"inputs,omitempty"`
	Idempotency        string                     `json:"idempotency,omitempty"`
	Source             *rnRunSourceBody           `json:"source,omitempty"`
}

type rnRetryBody struct {
	NodeInstanceKeys *[]string                  `json:"node_instance_keys,omitempty"`
	Inputs           map[string]json.RawMessage `json:"inputs,omitempty"`
	Reason           string                     `json:"reason,omitempty"`
}

type rnAssignmentCreateBody struct {
	PipelineID        string          `json:"pipeline_id"`
	PinnedRevisionID  string          `json:"pinned_revision_id"`
	MaxConcurrentRuns int             `json:"max_concurrent_runs,omitempty"`
	BudgetOverrides   json.RawMessage `json:"budget_overrides,omitempty"`
}

type rnAssignmentPatchBody struct {
	PinnedRevisionID  *string          `json:"pinned_revision_id,omitempty"`
	MaxConcurrentRuns *int             `json:"max_concurrent_runs,omitempty"`
	BudgetOverrides   *json.RawMessage `json:"budget_overrides,omitempty"`
	Enabled           *bool            `json:"enabled,omitempty"`
}

var m4IdempotencyKeyPattern = regexp.MustCompile(`^[A-Za-z0-9._-]{1,128}$`)

// RegisterRuns mounts routes 17–33. projects is used for the role gates on
// the project-prefixed routes and mutation role checks; the run/approval
// views carry the caller's role (never serialized) so the resource-scoped
// routes gate without a second lookup. trigger may be nil (see M4Trigger).
func RegisterRuns(s *Server, store RunStore, assignments AssignmentStore, projects ProjectStore, stream RunEventStream, trigger M4Trigger) {
	// The run stream's catch-up batch is 500 events per flush (§ 6); the
	// heartbeat and poll stay on ADR-0014's values.
	registerRuns(s, store, assignments, projects, stream, trigger,
		evtTiming{heartbeat: 15 * time.Second, poll: 2 * time.Second, batch: 500})
}

func registerRuns(s *Server, store RunStore, assignments AssignmentStore, projects ProjectStore,
	stream RunEventStream, trigger M4Trigger, timing evtTiming) {
	h := &rnHandlers{store: store, assignments: assignments, projects: projects,
		stream: stream, trigger: trigger, srv: s, timing: timing}

	s.HandleAuthed("GET /api/v1/projects/{projectId}/assignments", http.HandlerFunc(h.listAssignments))
	s.HandleAuthed("POST /api/v1/projects/{projectId}/assignments", http.HandlerFunc(h.createAssignment))
	s.HandleAuthed("PATCH /api/v1/assignments/{assignmentId}", http.HandlerFunc(h.patchAssignment))
	s.HandleAuthed("DELETE /api/v1/assignments/{assignmentId}", http.HandlerFunc(h.deleteAssignment))

	s.HandleAuthed("GET /api/v1/projects/{projectId}/runs", http.HandlerFunc(h.listRuns))
	s.HandleAuthed("POST /api/v1/projects/{projectId}/runs", http.HandlerFunc(h.createRun))
	s.HandleAuthed("GET /api/v1/runs/{runId}", http.HandlerFunc(h.getRun))
	s.HandleAuthed("GET /api/v1/runs/{runId}/nodes", http.HandlerFunc(h.listRunNodes))
	s.HandleAuthed("GET /api/v1/runs/{runId}/nodes/{nodeExecutionId}", http.HandlerFunc(h.getRunNode))
	s.HandleAuthed("GET /api/v1/runs/{runId}/tree", http.HandlerFunc(h.getRunTree))
	s.HandleAuthed("GET /api/v1/runs/{runId}/checkpoints", http.HandlerFunc(h.listRunCheckpoints))
	s.HandleAuthed("POST /api/v1/runs/{runId}/pause", http.HandlerFunc(h.pauseRun))
	s.HandleAuthed("POST /api/v1/runs/{runId}/resume", http.HandlerFunc(h.resumeRun))
	s.HandleAuthed("POST /api/v1/runs/{runId}/cancel", http.HandlerFunc(h.cancelRun))
	s.HandleAuthed("POST /api/v1/runs/{runId}/retry", http.HandlerFunc(h.retryRun))
	s.HandleAuthed("GET /api/v1/attempts/{attemptId}", http.HandlerFunc(h.getAttempt))
	s.HandleAuthed("GET /api/v1/runs/{runId}/events", http.HandlerFunc(h.streamRunEvents))
}

type rnHandlers struct {
	store       RunStore
	assignments AssignmentStore
	projects    ProjectStore
	stream      RunEventStream
	trigger     M4Trigger
	srv         *Server
	timing      evtTiming
}

// --- assignment handlers (routes 17–20) --------------------------------------

func (h *rnHandlers) listAssignments(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	projectID := r.PathValue("projectId")
	if !h.requireProjectRole(w, r, c, projectID, "assignment.list", rnView) {
		return
	}
	items, err := h.assignments.ListAssignments(r.Context(), c, projectID)
	if err != nil {
		h.fail(w, r, c, projectID, "assignment.list", err)
		return
	}
	if items == nil {
		items = []AssignmentView{}
	}
	for i := range items {
		items[i] = normalizeAssignmentView(items[i])
	}
	WriteJSON(w, http.StatusOK, AssignmentListView{Assignments: items})
}

func (h *rnHandlers) createAssignment(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	projectID := r.PathValue("projectId")
	if !h.requireProjectRole(w, r, c, projectID, "assignment.create", rnManage) {
		return
	}
	var body rnAssignmentCreateBody
	if err := DecodeJSON(r, &body); err != nil {
		h.badRequest(w, r, err)
		return
	}
	if !validUUID(body.PipelineID) || !validUUID(body.PinnedRevisionID) {
		rnInvalid(w, "pipeline_id and pinned_revision_id must be uuids.")
		return
	}
	if body.MaxConcurrentRuns < 0 || body.MaxConcurrentRuns > 8 {
		rnInvalid(w, "max_concurrent_runs must be between 1 and 8 (or omitted for the default 1).")
		return
	}
	if len(body.BudgetOverrides) > 0 && !json.Valid(body.BudgetOverrides) {
		rnInvalid(w, "budget_overrides must be a JSON object of ceilings.")
		return
	}
	item, err := h.assignments.CreateAssignment(r.Context(), c, projectID, AssignmentCreateInput{
		PipelineID:        body.PipelineID,
		PinnedRevisionID:  body.PinnedRevisionID,
		MaxConcurrentRuns: body.MaxConcurrentRuns,
		BudgetOverrides:   body.BudgetOverrides,
	})
	if err != nil {
		h.fail(w, r, c, projectID, "assignment.create", err)
		return
	}
	WriteJSON(w, http.StatusCreated, normalizeAssignmentView(item))
}

func (h *rnHandlers) patchAssignment(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	assignmentID := r.PathValue("assignmentId")
	current, err := h.assignments.GetAssignment(r.Context(), c, assignmentID)
	if err != nil {
		h.fail(w, r, c, assignmentID, "assignment.update", err)
		return
	}
	if !h.requireAssignmentManage(w, r, c, current, "assignment.update") {
		return
	}
	var body rnAssignmentPatchBody
	if err := DecodeJSON(r, &body); err != nil {
		h.badRequest(w, r, err)
		return
	}
	if body.PinnedRevisionID == nil && body.MaxConcurrentRuns == nil &&
		body.BudgetOverrides == nil && body.Enabled == nil {
		rnInvalid(w, "at least one of pinned_revision_id, max_concurrent_runs, budget_overrides or enabled is required.")
		return
	}
	if body.PinnedRevisionID != nil && !validUUID(*body.PinnedRevisionID) {
		rnInvalid(w, "pinned_revision_id must be a uuid.")
		return
	}
	if body.MaxConcurrentRuns != nil && (*body.MaxConcurrentRuns < 1 || *body.MaxConcurrentRuns > 8) {
		rnInvalid(w, "max_concurrent_runs must be between 1 and 8.")
		return
	}
	item, err := h.assignments.UpdateAssignment(r.Context(), c, assignmentID, AssignmentPatchInput{
		PinnedRevisionID:  body.PinnedRevisionID,
		MaxConcurrentRuns: body.MaxConcurrentRuns,
		BudgetOverrides:   body.BudgetOverrides,
		Enabled:           body.Enabled,
	})
	if err != nil {
		h.fail(w, r, c, assignmentID, "assignment.update", err)
		return
	}
	WriteJSON(w, http.StatusOK, normalizeAssignmentView(item))
}

func (h *rnHandlers) deleteAssignment(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	assignmentID := r.PathValue("assignmentId")
	current, err := h.assignments.GetAssignment(r.Context(), c, assignmentID)
	if err != nil {
		h.fail(w, r, c, assignmentID, "assignment.delete", err)
		return
	}
	if !h.requireAssignmentManage(w, r, c, current, "assignment.delete") {
		return
	}
	if err := h.assignments.DeleteAssignment(r.Context(), c, assignmentID); err != nil {
		h.fail(w, r, c, assignmentID, "assignment.delete", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// --- run handlers (routes 21–31, 33) -----------------------------------------

func (h *rnHandlers) listRuns(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	projectID := r.PathValue("projectId")
	if !h.requireProjectRole(w, r, c, projectID, "run.list", rnView) {
		return
	}
	// ADR-0056: the run-list trigger filter (manual|schedule|issue|thread),
	// validated here so a malformed probe never reaches SQL.
	trigger := r.URL.Query().Get("trigger")
	if trigger != "" && !runTriggerKinds[trigger] {
		WriteProblem(w, http.StatusBadRequest, "Bad Request",
			"invalid_trigger: trigger must be one of manual, schedule, issue, thread.")
		return
	}
	items, err := h.store.ListProjectRunsFiltered(r.Context(), c, projectID, trigger)
	if err != nil {
		h.fail(w, r, c, projectID, "run.list", err)
		return
	}
	if items == nil {
		items = []RunSummaryView{}
	}
	WriteJSON(w, http.StatusOK, RunSummaryListView{Runs: items})
}

// createRun is route 22 (openapi POST /projects/{projectId}/runs). The
// pinning, input validation, concurrency enforcement and run.created
// append all happen inside CreateRun's single transaction — this handler
// owns only the request shape, the role gate, and the Idempotency-Key
// precedence rule (the header wins over the body member).
func (h *rnHandlers) createRun(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	projectID := r.PathValue("projectId")
	if !h.requireProjectRole(w, r, c, projectID, "run.create", rnContribute) {
		return
	}

	var body rnRunCreateBody
	raw, err := rnDecodeBody(r, &body)
	if err != nil {
		h.decodeError(w, r, err)
		return
	}

	pins := 0
	if body.AssignmentID != "" {
		pins++
	}
	if body.PipelineRevisionID != "" {
		pins++
	}
	if pins != 1 {
		rnInvalid(w, "exactly one of assignment_id or pipeline_revision_id is required.")
		return
	}
	if body.AssignmentID != "" && !validUUID(body.AssignmentID) {
		rnInvalid(w, "assignment_id must be a uuid.")
		return
	}
	if body.PipelineRevisionID != "" && !validUUID(body.PipelineRevisionID) {
		rnInvalid(w, "pipeline_revision_id must be a uuid.")
		return
	}

	key := strings.TrimSpace(r.Header.Get("Idempotency-Key"))
	if key == "" {
		key = strings.TrimSpace(body.Idempotency)
	}
	if key != "" && !m4IdempotencyKeyPattern.MatchString(key) {
		rnInvalid(w, "idempotency key must match "+m4IdempotencyKeyPattern.String()+".")
		return
	}

	var source *RunSourceInput
	if body.Source != nil {
		if !validUUID(body.Source.ConversationID) {
			rnInvalid(w, "source.conversation_id must be a uuid.")
			return
		}
		for _, id := range body.Source.ArtifactIDs {
			if !validUUID(id) {
				rnInvalid(w, "source.artifact_ids entries must be uuids.")
				return
			}
		}
		source = &RunSourceInput{ConversationID: body.Source.ConversationID, ArtifactIDs: body.Source.ArtifactIDs}
		if body.Source.Summary != nil {
			source.Summary = *body.Source.Summary
		}
	}

	run, created, err := h.store.CreateRun(r.Context(), c, RunCreateInput{
		ProjectID:          projectID,
		AssignmentID:       body.AssignmentID,
		PipelineRevisionID: body.PipelineRevisionID,
		Inputs:             body.Inputs,
		Key:                key,
		RequestSHA:         m4SHA256(raw),
		TriggeredBy:        c.UserID,
		Source:             source,
	})
	if err != nil {
		h.fail(w, r, c, projectID, "run.create", err)
		return
	}
	if created {
		h.nudge(r.Context(), run.ID)
		w.Header().Set("Location", "/api/v1/runs/"+run.ID)
		WriteJSON(w, http.StatusCreated, RunCreateResponse{RunID: run.ID, Status: "queued", Base: run.SourceBase})
		return
	}
	// Idempotent replay: the stored run is the answer, 200 — a retried
	// click is not a second run (12 case 1) and never re-triggers (the
	// original create already did; the advancer would only shrug).
	WriteJSON(w, http.StatusOK, RunCreateResponse{RunID: run.ID, Status: "queued", Base: run.SourceBase})
}

func (h *rnHandlers) getRun(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	runID := r.PathValue("runId")
	run, err := h.store.GetRun(r.Context(), c, runID)
	if err != nil {
		h.fail(w, r, c, runID, "run.get", err)
		return
	}
	if !h.requireRunRole(w, r, c, run, "run.get", authz.CanView) {
		return
	}
	WriteJSON(w, http.StatusOK, normalizeRunView(run))
}

func (h *rnHandlers) listRunNodes(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	runID := r.PathValue("runId")
	items, err := h.store.ListRunNodes(r.Context(), c, runID)
	if err != nil {
		h.fail(w, r, c, runID, "run.nodes.list", err)
		return
	}
	if items == nil {
		items = []NodeExecutionView{}
	}
	for i := range items {
		items[i] = normalizeNodeView(items[i])
	}
	WriteJSON(w, http.StatusOK, NodeExecutionListView{NodeExecutions: items})
}

func (h *rnHandlers) getRunNode(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	runID := r.PathValue("runId")
	nodeID := r.PathValue("nodeExecutionId")
	detail, err := h.store.GetRunNode(r.Context(), c, runID, nodeID)
	if err != nil {
		h.fail(w, r, c, runID, "run.node.get", err)
		return
	}
	if !h.requireRunRole(w, r, c, RunView{
		RunSummaryView: RunSummaryView{ID: detail.RunID},
		MyRole:         detail.MyRole,
	}, "run.node.get", authz.CanView) {
		return
	}
	detail.NodeExecutionView = normalizeNodeView(detail.NodeExecutionView)
	if detail.Attempts == nil {
		detail.Attempts = []AttemptView{}
	}
	for i := range detail.Attempts {
		detail.Attempts[i] = normalizeAttemptView(detail.Attempts[i])
	}
	detail.CelEnvelope.Outputs = m4OrEmptyJSON(detail.CelEnvelope.Outputs)
	detail.CelEnvelope.ArtifactRefs = m4OrEmptyJSONArray(detail.CelEnvelope.ArtifactRefs)
	if detail.Checkpoint != nil {
		cp := normalizeCheckpointView(*detail.Checkpoint)
		detail.Checkpoint = &cp
	}
	WriteJSON(w, http.StatusOK, detail)
}

func (h *rnHandlers) getRunTree(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	runID := r.PathValue("runId")
	tree, err := h.store.GetRunTree(r.Context(), c, runID)
	if err != nil {
		h.fail(w, r, c, runID, "run.tree", err)
		return
	}
	WriteJSON(w, http.StatusOK, normalizeTree(tree))
}

func (h *rnHandlers) listRunCheckpoints(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	runID := r.PathValue("runId")
	items, err := h.store.ListRunCheckpoints(r.Context(), c, runID)
	if err != nil {
		h.fail(w, r, c, runID, "run.checkpoints", err)
		return
	}
	if items == nil {
		items = []RunCheckpointView{}
	}
	for i := range items {
		items[i] = normalizeCheckpointView(items[i])
	}
	WriteJSON(w, http.StatusOK, RunCheckpointListView{Checkpoints: items})
}

// lifecycle runs the three state moves whose handler shape is identical:
// role-gate on a fresh read of the run, one store mutation (whose
// transaction also writes the § 3 event), then the advancer nudge. The
// store re-checks the transition under the run's row lock, so the read
// here is for the ROLE decision only, never for the state decision.
func (h *rnHandlers) lifecycle(w http.ResponseWriter, r *http.Request, action string,
	fn func(context.Context, Caller, string) (RunView, error)) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	runID := r.PathValue("runId")
	before, err := h.store.GetRun(r.Context(), c, runID)
	if err != nil {
		h.fail(w, r, c, runID, action, err)
		return
	}
	if !h.requireRunRole(w, r, c, before, action, rnCanContribute) {
		return
	}
	run, err := fn(r.Context(), c, runID)
	if err != nil {
		h.fail(w, r, c, runID, action, err)
		return
	}
	h.nudge(r.Context(), run.ID)
	WriteJSON(w, http.StatusOK, normalizeRunView(run))
}

func (h *rnHandlers) pauseRun(w http.ResponseWriter, r *http.Request) {
	h.lifecycle(w, r, "run.pause", h.store.PauseRun)
}

func (h *rnHandlers) resumeRun(w http.ResponseWriter, r *http.Request) {
	h.lifecycle(w, r, "run.resume", h.store.ResumeRun)
}

// cancelRun answers 202, not 200: the response is a request, not proof
// anything stopped — the run reaches `cancelled` only when every branch is
// terminal, and the stream says when (route 30).
func (h *rnHandlers) cancelRun(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	runID := r.PathValue("runId")
	before, err := h.store.GetRun(r.Context(), c, runID)
	if err != nil {
		h.fail(w, r, c, runID, "run.cancel", err)
		return
	}
	if !h.requireRunRole(w, r, c, before, "run.cancel", rnCanContribute) {
		return
	}
	run, err := h.store.CancelRun(r.Context(), c, runID)
	if err != nil {
		h.fail(w, r, c, runID, "run.cancel", err)
		return
	}
	h.nudge(r.Context(), run.ID)
	WriteJSON(w, http.StatusAccepted, normalizeRunView(run))
}

// retryRun is route 31. The body is OPTIONAL (openapi requestBody.required
// is false): an empty request targets every non-succeeded terminal node
// execution.
func (h *rnHandlers) retryRun(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	runID := r.PathValue("runId")
	before, err := h.store.GetRun(r.Context(), c, runID)
	if err != nil {
		h.fail(w, r, c, runID, "run.retry", err)
		return
	}
	if !h.requireRunRole(w, r, c, before, "run.retry", rnCanContribute) {
		return
	}
	// The retry body is optional (openapi requestBody.required is false):
	// "no body at all" is the default retry, not a malformed one.
	var body rnRetryBody
	if _, err := rnDecodeBody(r, &body); err != nil && !errors.Is(err, ErrBodyEmpty) {
		h.decodeError(w, r, err)
		return
	}
	if len(body.Reason) > 512 {
		rnInvalid(w, "reason must be at most 512 characters.")
		return
	}
	var keys []string
	if body.NodeInstanceKeys != nil {
		keys = *body.NodeInstanceKeys
		if len(keys) == 0 {
			// minItems 1: an explicit empty array says "target nothing",
			// which is not a retry — the omission (or null-less default)
			// is what means "every non-succeeded terminal target".
			rnInvalid(w, "node_instance_keys must have at least one entry (omit it to target every failed terminal node execution).")
			return
		}
	}
	run, err := h.store.RetryRun(r.Context(), c, runID, RunRetryInput{
		NodeInstanceKeys: keys,
		Inputs:           body.Inputs,
		Reason:           body.Reason,
		RequestedBy:      c.UserID,
	})
	if err != nil {
		h.fail(w, r, c, runID, "run.retry", err)
		return
	}
	h.nudge(r.Context(), run.ID)
	WriteJSON(w, http.StatusOK, normalizeRunView(run))
}

// getAttempt is the attempt read (route 32 § 2.1 numbering): the view type
// has no worker/lease fields, so leaking them is unrepresentable here, not
// merely filtered.
func (h *rnHandlers) getAttempt(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	attemptID := r.PathValue("attemptId")
	attempt, err := h.store.GetAttempt(r.Context(), c, attemptID)
	if err != nil {
		h.fail(w, r, c, attemptID, "attempt.get", err)
		return
	}
	if !h.requireRunRole(w, r, c, RunView{
		RunSummaryView: RunSummaryView{ID: attempt.RunID},
		MyRole:         attempt.MyRole,
	}, "attempt.get", authz.CanView) {
		return
	}
	WriteJSON(w, http.StatusOK, normalizeAttemptView(attempt))
}

// --- run event stream (route 33 § 2.1 / GET /runs/{runId}/events) -----------

// streamRunEvents is the run-scoped SSE stream. The framing, global_seq
// resume, Last-Event-ID-beats-?after= rule and heartbeat are ADR-0014 § 5
// verbatim — the read goes through the committed store cursor (RunEvent-
// After's journal filter on domain_events.run_id), so this handler cannot
// fork the gap argument, only reuse it. Authorization is the run's project
// membership, re-checked at subscribe and before every flush and heartbeat
// (the removed-member rule: the stream stops mid-flight, never leaks).
func (h *rnHandlers) streamRunEvents(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	runID := r.PathValue("runId")

	after, ok := evtResumeCursor(w, r)
	if !ok {
		return
	}

	// Connect-time authorization: a non-member gets the same 404 (plus
	// audit row) every run route gives, never an open stream.
	run, err := h.store.GetRun(r.Context(), c, runID)
	if err != nil {
		h.fail(w, r, c, runID, "run.stream", err)
		return
	}
	if !h.requireRunRole(w, r, c, run, "run.stream", authz.CanView) {
		return
	}

	flusher := http.NewResponseController(w)

	ctx := r.Context()
	wake, stopWatch, err := h.stream.Watch(ctx)
	if err != nil {
		h.serverError(w, r, runID, "run.stream", err)
		return
	}
	defer stopWatch()

	evtStreamHeaders(w)
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	log := h.log(r)
	log.InfoContext(ctx, "run event stream opened",
		"run_id", runID, "after", after, "user_id", c.UserID)

	heartbeat := time.NewTicker(h.timing.heartbeat)
	defer heartbeat.Stop()
	poll := time.NewTicker(h.timing.poll)
	defer poll.Stop()

	cursor := after
	for {
		for {
			// The read is authorized too (the adapter resolves the run's
			// project behind membership), so a caller removed mid-stream
			// answers not-found here even if the explicit check below
			// happens to fall between frames.
			batch, err := h.stream.RunEventsAfter(ctx, c, runID, cursor, h.timing.batch)
			if err != nil {
				if errors.Is(err, ErrRunNotFound) || errors.Is(err, ErrProjectNotFound) {
					log.WarnContext(ctx, "run event stream closed: access lost",
						"run_id", runID, "user_id", c.UserID)
					return
				}
				log.ErrorContext(ctx, "run event stream read failed",
					"run_id", runID, "request_id", RequestIDFrom(r), "error", err.Error())
				return
			}
			if len(batch) == 0 {
				break
			}
			if _, err := h.store.GetRun(ctx, c, runID); err != nil {
				log.WarnContext(ctx, "run event stream closed: authorization lost",
					"run_id", runID, "user_id", c.UserID, "error", err.Error())
				return
			}
			for _, env := range batch {
				if err := evtWriteEvent(w, env); err != nil {
					log.DebugContext(ctx, "run event stream write failed (client gone?)",
						"run_id", runID, "error", err.Error())
					return
				}
				cursor = env.GlobalSeq
				_ = flusher.Flush()
			}
			if len(batch) < h.timing.batch {
				break
			}
		}

		select {
		case <-ctx.Done():
			return
		case _, open := <-wake:
			if !open {
				return
			}
		case <-poll.C:
			// Wake-ups are an optimization; the poll bounds a lost
			// notification's cost (ADR-0014 § 6).
		case <-heartbeat.C:
			if _, err := h.store.GetRun(ctx, c, runID); err != nil {
				log.WarnContext(ctx, "run event stream closed: authorization lost",
					"run_id", runID, "user_id", c.UserID, "error", err.Error())
				return
			}
			if err := evtWriteComment(w, flusher, "heartbeat"); err != nil {
				return
			}
		}
	}
}

// --- shared plumbing ----------------------------------------------------------

// role levels for requireProjectRole, ordered so the gate is one compare.
const (
	rnView = iota
	rnContribute
	rnManage
)

func (h *rnHandlers) caller(w http.ResponseWriter, r *http.Request) (Caller, bool) {
	p, ok := PrincipalFrom(r.Context())
	if !ok {
		h.serverError(w, r, "", "no action", errors.New("api: no principal in context"))
		return Caller{}, false
	}
	return Caller{UserID: p.UserID, OrganizationID: p.OrganizationID, IsOrgAdmin: p.IsOrgAdmin}, true
}

// nudge fires the advancer trigger if one is wired. It runs AFTER the
// store transaction committed, so the advancer only ever sees durable
// state (or none at all if the request failed).
func (h *rnHandlers) nudge(ctx context.Context, runID string) {
	if h.trigger != nil && runID != "" {
		h.trigger(ctx, runID)
	}
}

// requireProjectRole gates a project-prefixed route through the one
// ProjectStore read: not seeing the project at all is the 404 (audit row
// included), being a member below the bar is the 403.
func (h *rnHandlers) requireProjectRole(w http.ResponseWriter, r *http.Request, c Caller,
	projectID, action string, level int) bool {
	project, err := h.projects.GetProject(r.Context(), c, projectID)
	if err != nil {
		h.fail(w, r, c, projectID, action, err)
		return false
	}
	role := authz.Role(project.MyRole)
	switch level {
	case rnManage:
		if authz.CanManage(c.IsOrgAdmin, role) {
			return true
		}
	case rnContribute:
		if rnCanContribute(c.IsOrgAdmin, role) {
			return true
		}
	default:
		if authz.CanView(c.IsOrgAdmin, role) {
			return true
		}
	}
	// The project IS visible here (GetProject succeeded), so the audit
	// belongs to the project store — the same path projects.go uses.
	if err := h.projects.RecordDenied(r.Context(), c, projectID, action); err != nil {
		h.log(r).ErrorContext(r.Context(), "could not write audit denial",
			slog.String("action", action), slog.String("project_id", projectID),
			slog.String("request_id", RequestIDFrom(r)), slog.Any("error", err))
	}
	h.log(r).WarnContext(r.Context(), "project role denied",
		slog.String("action", action), slog.String("user_id", c.UserID),
		slog.String("project_id", projectID),
		slog.String("request_id", RequestIDFrom(r)))
	WriteProblem(w, http.StatusForbidden, "Forbidden",
		"Your project role is not sufficient for this operation.")
	return false
}

// requireAssignmentManage gates the resource-scoped assignment routes on
// the caller's role IN THE ASSIGNMENT'S PROJECT (carried on the view).
func (h *rnHandlers) requireAssignmentManage(w http.ResponseWriter, r *http.Request,
	c Caller, view AssignmentView, action string) bool {
	if authz.CanManage(c.IsOrgAdmin, authz.Role(view.MyRole)) {
		return true
	}
	h.denied(w, r, c, view.ProjectID, action, "assignment project role is not maintainer")
	WriteProblem(w, http.StatusForbidden, "Forbidden",
		"Your project role is read-only for this assignment; a maintainer is required.")
	return false
}

// requireRunRole gates the resource-scoped run routes on the caller's role
// in the run's project (carried on the view). A role that cannot even see
// the row answers the uniform 404 — the store predicate should have caught
// it first; this is the belt to that braces.
func (h *rnHandlers) requireRunRole(w http.ResponseWriter, r *http.Request, c Caller,
	run RunView, action string, may func(bool, authz.Role) bool) bool {
	role := authz.Role(run.MyRole)
	if may(c.IsOrgAdmin, role) {
		return true
	}
	if !authz.CanView(c.IsOrgAdmin, role) {
		h.denied(w, r, c, run.ID, action, "no such run, or it is not visible to you")
		WriteProblem(w, http.StatusNotFound, "Not Found", "No such run.")
		return false
	}
	h.denied(w, r, c, run.ID, action, "project role is read-only")
	WriteProblem(w, http.StatusForbidden, "Forbidden",
		"Your project role is read-only; a contributor is required to change a run.")
	return false
}

// rnCanContribute is "contributor or above" (the run-lifecycle and run-
// create gate, m4-contract § 2.1 routes 22/28–31); authz has no such
// predicate of its own yet, so it is spelled here as artifacts.go does.
func rnCanContribute(isOrgAdmin bool, role authz.Role) bool {
	if isOrgAdmin {
		return true
	}
	return role == authz.RoleMaintainer || role == authz.RoleContributor
}

// fail maps a run-surface store error onto the HTTP contract.
func (h *rnHandlers) fail(w http.ResponseWriter, r *http.Request, c Caller, resourceID, action string, err error) {
	var conflict *RunConflictError
	if errors.As(err, &conflict) {
		h.denied(w, r, c, resourceID, action, conflict.Kind)
		m4WriteRunConflict(w, conflict)
		return
	}
	var invalid *RunInputsInvalid
	if errors.As(err, &invalid) {
		m4WriteValidateProblem(w, invalid)
		return
	}
	switch {
	case errors.Is(err, ErrRunNotFound), errors.Is(err, ErrAssignmentNotFound),
		errors.Is(err, ErrPipelineNotFound):
		h.denied(w, r, c, resourceID, action, "no such object, or it is not visible to you")
		WriteProblem(w, http.StatusNotFound, "Not Found", "No such "+m4NounFor(action)+".")
	case errors.Is(err, ErrProjectNotFound):
		// ADR-0014 § 3: a non-member sees exactly what an unknown project
		// sees — the same 404 GET /projects/{id} answers — never a 500 that
		// says "this project exists and you are not allowed near it". The gate
		// error is the project store's own, so its audit arm is too.
		h.projectDenied(w, r, c, resourceID, action)
		WriteProblem(w, http.StatusNotFound, "Not Found", "No such project.")
	case errors.Is(err, ErrNodeExecutionNotFound):
		var named *NodeExecutionNotFound
		key := ""
		if errors.As(err, &named) {
			key = named.NodeInstanceKey
		}
		m4WriteNodeExecutionNotFound(w, key)
	case errors.Is(err, ErrConversationNotFound):
		// ADR-0053: a source conversation the caller may not see answers the
		// same 404 the conversation route gives — no existence is disclosed.
		h.denied(w, r, c, resourceID, action, "no such conversation, or it is not visible to you")
		WriteProblem(w, http.StatusNotFound, "Not Found", "No such conversation.")
	case errors.Is(err, ErrArtifactNotFound):
		h.denied(w, r, c, resourceID, action, "no such artifact, or it is not visible to you")
		WriteProblem(w, http.StatusNotFound, "Not Found", "No such artifact.")
	case errors.Is(err, ErrRunSourceProjectMismatch):
		m4WriteTypedProblem(w, http.StatusUnprocessableEntity, "source-project-mismatch",
			"Source project mismatch",
			"The source conversation belongs to a different project than the run's; start the run in the conversation's project.")
	case errors.Is(err, ErrRunSourceArtifactTaken):
		m4WriteTypedProblem(w, http.StatusUnprocessableEntity, "source-artifact-taken",
			"Artifact already attached",
			"The named artifact is already attached to another run; it cannot ride two runs at once.")
	case errors.Is(err, ErrAssignmentConflict):
		m4WriteTypedProblem(w, http.StatusConflict, "assignment-already-exists",
			"Assignment already exists",
			"This project already assigns that pipeline; re-pin it through PATCH, never a second row.")
	case errors.Is(err, ErrBudgetOverridesRaise):
		m4WriteTypedProblem(w, http.StatusBadRequest, "budget-overrides-may-only-lower",
			"Budget overrides may only lower ceilings",
			ErrBudgetOverridesRaise.Error()[len("api: "):]+
				": an assignment is a governor, not an upgrade path.")
	default:
		h.serverError(w, r, resourceID, action, err)
	}
}

// m4WriteNodeExecutionNotFound renders route 31's unknown-target 404: the
// stable code `node-execution-not-found` with the key the client named. The
// key is the caller's own input, so echoing it discloses nothing (unlike the
// 404 for an invisible run, which names no resource at all — W9's rule).
func m4WriteNodeExecutionNotFound(w http.ResponseWriter, key string) {
	detail := "No node execution of this run has that instance key; " +
		"GET /api/v1/runs/{runId}/nodes lists the targets a retry may name."
	if key == "" {
		m4WriteTypedProblem(w, http.StatusNotFound, "node-execution-not-found",
			"No Such Node Execution", detail)
		return
	}
	m4WriteTypedProblemExtra(w, http.StatusNotFound, "node-execution-not-found",
		"No Such Node Execution", detail,
		struct {
			NodeInstanceKey string `json:"node_instance_key"`
		}{NodeInstanceKey: key})
}

// m4NounFor picks the 404 noun from the action's family so the body never
// names a resource the caller may not see (W9's rule: no project names,
// no digests, no node names in a refusal).
func m4NounFor(action string) string {
	switch {
	case strings.HasPrefix(action, "assignment."):
		return "assignment"
	case strings.HasPrefix(action, "attempt."):
		return "attempt"
	default:
		return "run"
	}
}

func (h *rnHandlers) denied(w http.ResponseWriter, r *http.Request, c Caller, resourceID, action, reason string) {
	target := resourceID
	if err := h.recordDenied(r.Context(), c, action, target); err != nil {
		h.log(r).ErrorContext(r.Context(), "could not write audit denial",
			slog.String("action", action),
			slog.String("resource_id", target),
			slog.String("request_id", RequestIDFrom(r)),
			slog.Any("error", err))
		return
	}
	h.log(r).WarnContext(r.Context(), "run access denied",
		slog.String("action", action),
		slog.String("user_id", c.UserID),
		slog.String("resource_id", target),
		slog.String("reason", reason),
		slog.String("request_id", RequestIDFrom(r)))
}

// recordDenied routes the audit write to the store that owns the resource
// family (each resolves its owning project from the id where one exists).
func (h *rnHandlers) recordDenied(ctx context.Context, c Caller, action, id string) error {
	if strings.HasPrefix(action, "assignment.") {
		return h.assignments.RecordDenied(ctx, c, id, action)
	}
	return h.store.RecordDenied(ctx, c, id, action)
}

// projectDenied audits a refusal raised by the project gate itself (the
// project read or the project-prefixed list/write behind it), which is the
// only store that can resolve the id the caller typed in the URL.
func (h *rnHandlers) projectDenied(w http.ResponseWriter, r *http.Request, c Caller, projectID, action string) {
	if err := h.projects.RecordDenied(r.Context(), c, projectID, action); err != nil {
		h.log(r).ErrorContext(r.Context(), "could not write audit denial",
			slog.String("action", action), slog.String("project_id", projectID),
			slog.String("request_id", RequestIDFrom(r)), slog.Any("error", err))
		return
	}
	h.log(r).WarnContext(r.Context(), "project access denied",
		slog.String("action", action), slog.String("user_id", c.UserID),
		slog.String("project_id", projectID), slog.String("request_id", RequestIDFrom(r)))
}

func (h *rnHandlers) serverError(w http.ResponseWriter, r *http.Request, resourceID, action string, err error) {
	h.log(r).ErrorContext(r.Context(), "run store failure",
		slog.String("action", action),
		slog.String("resource_id", resourceID),
		slog.String("request_id", RequestIDFrom(r)),
		slog.Any("error", err))
	WriteProblem(w, http.StatusInternalServerError, "Internal Server Error",
		"The server could not complete the request. Use the request id when reporting it.")
}

func (h *rnHandlers) badRequest(w http.ResponseWriter, r *http.Request, err error) {
	status, title := http.StatusBadRequest, "Invalid Request Body"
	switch {
	case errors.Is(err, ErrBodyTooLarge):
		status, title = http.StatusRequestEntityTooLarge, "Request Body Too Large"
	case errors.Is(err, ErrBodyEmpty):
		status, title = http.StatusBadRequest, "Request Body Required"
	}
	WriteProblem(w, status, title, "The request body must be a JSON object matching this endpoint's schema.")
	h.log(r).WarnContext(r.Context(), "rejected request body",
		slog.String("path", r.URL.Path),
		slog.String("request_id", RequestIDFrom(r)),
		slog.Any("error", err))
}

// decodeError is the body-decode refusal arm shared by the POST /runs and
// retry handlers (rnDecodeBody surfaces problem.go's sentinels).
func (h *rnHandlers) decodeError(w http.ResponseWriter, r *http.Request, err error) {
	h.badRequest(w, r, err)
}

func (h *rnHandlers) log(r *http.Request) *slog.Logger {
	if h.srv != nil {
		return h.srv.logger
	}
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// rnInvalid writes the shared 422 problem+json.
func rnInvalid(w http.ResponseWriter, detail string) {
	WriteProblem(w, http.StatusUnprocessableEntity, "Validation Failed", detail)
}

// rnDecodeBody reads the request body under problem.go's cap, strict-decodes
// it into dst, and returns the exact bytes for the request_sha256 the
// idempotency ledger stores (hashing the decoded-then-re-marshalled form
// would make a key replay depend on Go's map ordering instead of the
// bytes the client actually sent).
func rnDecodeBody(r *http.Request, dst any) (raw []byte, err error) {
	if r.Body == nil {
		return nil, ErrBodyEmpty
	}
	raw, err = io.ReadAll(io.LimitReader(r.Body, MaxJSONBodyBytes+1))
	if err != nil {
		return nil, fmt.Errorf("api: read request body: %w", err)
	}
	if int64(len(raw)) > MaxJSONBodyBytes {
		return nil, ErrBodyTooLarge
	}
	if len(bytes.TrimSpace(raw)) == 0 {
		// The retry body is optional; POST /runs checks emptiness itself
		// through ErrBodyEmpty when the route requires one.
		return raw, ErrBodyEmpty
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return raw, fmt.Errorf("api: decode request body: %w", err)
	}
	if err := dec.Decode(new(json.RawMessage)); !errors.Is(err, io.EOF) {
		return raw, ErrBodyTrailingData
	}
	return raw, nil
}

// normalize* make the "array/object never null" schema rules true on the
// way out regardless of what an adapter left unset.
func normalizeRunView(v RunView) RunView {
	if v.Inputs == nil {
		v.Inputs = []RunInputValueView{}
	}
	if v.RepoSnapshot == nil {
		v.RepoSnapshot = []RunRepoSnapshotView{}
	}
	return v
}

func normalizeNodeView(v NodeExecutionView) NodeExecutionView {
	v.ArtifactRefs = m4OrEmptyJSONArray(v.ArtifactRefs)
	v.DependsOn = m4OrEmptyJSONArray(v.DependsOn)
	return v
}

func normalizeAttemptView(v AttemptView) AttemptView {
	v.OutputErrors = m4OrEmptyJSONArray(v.OutputErrors)
	v.ArtifactRefs = m4OrEmptyJSONArray(v.ArtifactRefs)
	v.Outputs = m4OrNULL(v.Outputs)
	v.Overrides = m4OrNULL(v.Overrides)
	v.RetryContext = m4OrNULL(v.RetryContext)
	return v
}

func normalizeCheckpointView(v RunCheckpointView) RunCheckpointView {
	v.RepoStates = m4OrEmptyJSONArray(v.RepoStates)
	v.ArtifactRefs = m4OrEmptyJSONArray(v.ArtifactRefs)
	return v
}

func normalizeAssignmentView(v AssignmentView) AssignmentView {
	v.BudgetOverrides = m4OrEmptyJSON(v.BudgetOverrides)
	v.EffectiveBudgets = m4OrEmptyJSON(v.EffectiveBudgets)
	return v
}

func normalizeTree(t RunTreeView) RunTreeView {
	if t.Children == nil {
		t.Children = []RunTreeView{}
	}
	for i := range t.Children {
		t.Children[i] = normalizeTree(t.Children[i])
	}
	return t
}

// m4WriteRunConflict renders RunConflictProblem: a Problem plus the run's
// current id and status so the client can re-read cheaply. A conflict that
// predates any run (an idempotency mismatch) has no run to name and
// renders the plain typed 409 instead.
func m4WriteRunConflict(w http.ResponseWriter, conflict *RunConflictError) {
	code := strings.ReplaceAll(conflict.Kind, "_", "-")
	title := m4RunConflictTitles[conflict.Kind]
	if title == "" {
		title = "Run Conflict"
	}
	detail := conflict.Detail
	if detail == "" {
		detail = "The request conflicts with the run's current state."
	}
	if conflict.RunID == "" {
		m4WriteTypedProblem(w, http.StatusConflict, code, title, detail)
		return
	}
	extra := struct {
		RunID     string `json:"run_id"`
		RunStatus string `json:"run_status"`
	}{RunID: conflict.RunID, RunStatus: conflict.RunStatus}
	m4WriteTypedProblemExtra(w, http.StatusConflict, code, title, detail, extra)
}

var m4RunConflictTitles = map[string]string{
	RunConflictNotRetriable:          "Run Not Retriable",
	RunConflictCheckpointUnavailable: "Checkpoint Unavailable",
	RunConflictState:                 "Run State Conflict",
	RunConflictIdempotencyMismatch:   "Idempotency Key Mismatch",
}

// m4WriteValidateProblem renders the ValidateProblem schema: a 422 that
// speaks the § 2.2 vocabulary, so one client-side renderer covers editors
// and runners (today: run-input failure on POST /runs).
func m4WriteValidateProblem(w http.ResponseWriter, invalid *RunInputsInvalid) {
	errs := invalid.Errors
	if errs == nil {
		errs = []ValidateError{}
	}
	detail := invalid.Detail
	if detail == "" {
		detail = "The submitted inputs failed validation against the pinned revision's spec.inputs."
	}
	extra := struct {
		Valid  bool            `json:"valid"`
		Errors []ValidateError `json:"errors"`
	}{Valid: false, Errors: errs}
	m4WriteTypedProblemExtra(w, http.StatusUnprocessableEntity, "validation-failed",
		"Run inputs invalid", detail, extra)
}
