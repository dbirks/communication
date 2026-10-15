// Package runtime implements the M4 execution model — the Run / NodeExecution
// / Attempt state machines, the advancer, retry policy and checkpoint decisions
// — as pure logic over a compiled plan (internal/pipelines/compiler).
//
// It has no database, no HTTP, no workspace and no process: docs/m4-contract.md
// § 5 makes the advancer a writer whose every step is "re-derive from rows", and
// the only way to test that claim hermetically is for the derivation to be a
// function. The Postgres adapter implements Store; the in-memory store here is
// the reference implementation the unit, scenario and property tests run
// against (AGENTS.md: a mocked green test never substitutes for the real
// integration layer — the mock layer is still required, and this is it).
//
// Authority: ADR-0023 (execution model), ADR-0024 (which kinds M4 executes),
// communication-spec/01-domain-model.md (state machines + invariants 1/3/4/6),
// docs/m4-contract.md § 3 (events), § 4-§ 5 (worker/advancer duties), § 5
// (checkpoints), § 6 (caps), § 9.3 (the sample pipeline), § 10 (D1-D16).
//
// The transition functions below are the same rules contract § 1's DDL encodes
// as CHECK constraints. That duplication is deliberate and is stated once: the
// DB constraint is the last line of defence against a writer that is not this
// package; this package is the first line of defence against a design that is
// not the ADR. Each guard names the constraint it mirrors.
package runtime

import (
	"fmt"
	"time"
)

// Run statuses (communication-spec/01 "Run", mirrored by runs.status's CHECK).
const (
	RunQueued       = "queued"
	RunPreparing    = "preparing"
	RunRunning      = "running"
	RunWaitingHuman = "waiting_human"
	RunPaused       = "paused"
	RunCompleted    = "completed"
	RunFailed       = "failed"
	RunCancelled    = "cancelled"
	RunInterrupted  = "interrupted"
)

// RunPausedReasons are runs.paused_reason's three admitted values.
const (
	PausedHumanTakeover     = "human_takeover"
	PausedManual            = "manual"
	PausedWorkerUnavailable = "worker_unavailable"
)

// Node execution statuses (01 "Node execution", refined by ADR-0023 § 3: a
// control-plane row moves pending → ready → succeeded inside the advancer and
// never enters leased or running).
const (
	NodePending     = "pending"
	NodeReady       = "ready"
	NodeLeased      = "leased"
	NodeRunning     = "running"
	NodeSucceeded   = "succeeded"
	NodeFailed      = "failed"
	NodeSkipped     = "skipped"
	NodeWaiting     = "waiting"
	NodeCancelled   = "cancelled"
	NodeInterrupted = "interrupted"
)

// NodeWaitingReasons are node_executions.waiting_reason's admitted values.
const (
	WaitingApproval     = "approval"
	WaitingChildRun     = "child_run"
	WaitingJoinDeferred = "join_deferred"
)

// Attempt statuses (attempts.status's CHECK).
const (
	AttemptQueued      = "queued"
	AttemptLeased      = "leased"
	AttemptRunning     = "running"
	AttemptSucceeded   = "succeeded"
	AttemptFailed      = "failed"
	AttemptCancelled   = "cancelled"
	AttemptInterrupted = "interrupted"
)

// ErrorClass is ADR-0023 § 7's enum, one value per writer.
const (
	ErrInfra                    = "infra"
	ErrInterrupted              = "interrupted"
	ErrTimeout                  = "timeout"
	ErrAgentError               = "agent_error"
	ErrInvalidOutput            = "invalid_output"
	ErrPredicate                = "predicate_error"
	ErrSandboxEnforcementFailed = "sandbox_enforcement_failed"
	ErrWorkspaceLost            = "workspace_lost"
	ErrBinding                  = "binding_error"
	ErrApprovalExpired          = "approval_expired"
	ErrCancelled                = "cancelled"
)

// errorClasses is the attempts.error_class CHECK set, as data so a test can
// assert the table rather than re-list it.
var errorClasses = map[string]bool{
	ErrInfra: true, ErrInterrupted: true, ErrTimeout: true, ErrAgentError: true,
	ErrInvalidOutput: true, ErrPredicate: true, ErrSandboxEnforcementFailed: true,
	ErrWorkspaceLost: true, ErrBinding: true, ErrApprovalExpired: true, ErrCancelled: true,
}

// ValidErrorClass reports whether class is one of ADR-0023 § 7's names.
func ValidErrorClass(class string) bool { return errorClasses[class] }

// Terminal predicates. 01's machines have exactly one direction: once terminal,
// a row never moves again, which is what makes "repeated attempts append, not
// overwrite" (01) checkable.
func RunTerminal(status string) bool {
	switch status {
	case RunCompleted, RunFailed, RunCancelled, RunInterrupted:
		return true
	}
	return false
}

func NodeTerminal(status string) bool {
	switch status {
	case NodeSucceeded, NodeFailed, NodeSkipped, NodeCancelled, NodeInterrupted:
		return true
	}
	return false
}

func AttemptTerminal(status string) bool {
	switch status {
	case AttemptSucceeded, AttemptFailed, AttemptCancelled, AttemptInterrupted:
		return true
	}
	return false
}

// ---------------------------------------------------------------- transitions

// IllegalTransition is the error every guarded mutation returns. It is a typed
// value rather than a string so a caller can tell "this row already moved" from
// a genuine bug (the advancer's idempotence depends on that distinction).
type IllegalTransition struct {
	What string
	From string
	To   string
	Why  string
}

func (e IllegalTransition) Error() string {
	if e.Why != "" {
		return fmt.Sprintf("%s: illegal transition %s → %s (%s)", e.What, e.From, e.To, e.Why)
	}
	return fmt.Sprintf("%s: illegal transition %s → %s", e.What, e.From, e.To)
}

// runTransitions is 01's Run machine. The set is stated as an adjacency table
// because a switch would hide which edges are deliberate:
//   - queued → preparing is the workspace step (ADR-0017), queued → running is
//     the arm where the run's workspace already exists (a retry, or a plan with
//     no worker node yet to prepare for).
//   - interrupted → queued is the retry arm 01 names ("may transition to retry
//     queue or terminal failure according to policy"); interrupted → failed is
//     the budget refusing it.
var runTransitions = map[string][]string{
	RunQueued:       {RunPreparing, RunRunning, RunPaused, RunCompleted, RunFailed, RunCancelled, RunInterrupted},
	RunPreparing:    {RunRunning, RunPaused, RunFailed, RunCancelled, RunInterrupted},
	RunRunning:      {RunWaitingHuman, RunPaused, RunCompleted, RunFailed, RunCancelled, RunInterrupted},
	RunWaitingHuman: {RunRunning, RunWaitingHuman, RunPaused, RunFailed, RunCancelled, RunInterrupted},
	RunPaused:       {RunQueued, RunRunning, RunWaitingHuman, RunFailed, RunCancelled, RunInterrupted},
	RunInterrupted:  {RunQueued, RunRunning, RunFailed, RunCancelled},
	RunCompleted:    {},
	RunFailed:       {},
	RunCancelled:    {},
}

// CanRunTransition reports whether from → to is an edge of 01's machine.
func CanRunTransition(from, to string) bool {
	for _, t := range runTransitions[from] {
		if t == to {
			return true
		}
	}
	return false
}

// nodeTransitions is 01's NodeExecution machine plus ADR-0023 § 5's "retry
// returns execution to ready with a new attempt" edge (leased/running → ready).
var nodeTransitions = map[string][]string{
	NodePending:   {NodeReady, NodeSkipped, NodeCancelled, NodeFailed},
	NodeReady:     {NodeLeased, NodeSucceeded, NodeFailed, NodeSkipped, NodeWaiting, NodeCancelled, NodeInterrupted},
	NodeLeased:    {NodeRunning, NodeReady, NodeSucceeded, NodeFailed, NodeWaiting, NodeCancelled, NodeInterrupted},
	NodeRunning:   {NodeSucceeded, NodeFailed, NodeReady, NodeWaiting, NodeCancelled, NodeInterrupted},
	NodeWaiting:   {NodeSucceeded, NodeFailed, NodeReady, NodeCancelled, NodeInterrupted},
	NodeSucceeded: {},
	NodeFailed:    {NodeReady},
	NodeSkipped:   {},
	// A run-level retry (contract route 31) targets "failed/interrupted/
	// cancelled" executions — so a cancelled row may reopen; every other
	// terminal is absolute (01's append-only history).
	NodeCancelled:   {NodeReady},
	NodeInterrupted: {NodeReady},
}

func CanNodeTransition(from, to string) bool {
	for _, t := range nodeTransitions[from] {
		if t == to {
			return true
		}
	}
	return false
}

var attemptTransitions = map[string][]string{
	AttemptQueued:  {AttemptLeased, AttemptCancelled},
	AttemptLeased:  {AttemptRunning, AttemptSucceeded, AttemptFailed, AttemptCancelled, AttemptInterrupted},
	AttemptRunning: {AttemptSucceeded, AttemptFailed, AttemptCancelled, AttemptInterrupted},
}

func CanAttemptTransition(from, to string) bool {
	for _, t := range attemptTransitions[from] {
		if t == to {
			return true
		}
	}
	return false
}

// ---------------------------------------------------------------- the run row

// Run is one run: 01's Run, plus the pins ADR-0023 § 1/§ 2 require (a run
// executes a plan snapshot, never a live revision — 12 case 11).
type Run struct {
	ID             string
	OrganizationID string
	ProjectID      string
	PipelineID     string
	RevisionID     string
	AssignmentID   string
	RevisionDigest string
	PlanDigest     string
	Status         string
	FailedCause    string
	PausedReason   string

	CancelRequestedAt *time.Time
	Depth             int
	ParentRunID       string
	TriggeredBy       string

	WorkerAffinity string
	WorkerVolumeID string
	Priority       int

	ExpressionEvaluations int
	NodeExecutionCount    int

	CreatedAt  time.Time
	StartedAt  time.Time
	FinishedAt time.Time

	// Inputs is the validated run_inputs set: the values bindings read
	// (contract § 1: run_inputs.value is what the CEL `inputs` root resolves).
	Inputs map[string]any
}

// MoveRun applies 01's Run machine with the timestamp rules contract § 1's
// runs_terminal_timestamped / runs_paused_reasoned / runs_terminal_cause CHECKs
// add on top of the status enum.
func (r *Run) MoveRun(to, failedCause, pausedReason string, at time.Time) error {
	if r.Status == to {
		return nil
	}
	if !CanRunTransition(r.Status, to) {
		return IllegalTransition{What: "run " + r.ID, From: r.Status, To: to}
	}
	switch to {
	case RunCompleted, RunFailed, RunCancelled, RunInterrupted:
		if at.IsZero() {
			return IllegalTransition{What: "run " + r.ID, From: r.Status, To: to,
				Why: "runs_terminal_timestamped: a terminal run carries finished_at"}
		}
		if to == RunFailed || to == RunInterrupted {
			if failedCause == "" {
				return IllegalTransition{What: "run " + r.ID, From: r.Status, To: to,
					Why: "runs_terminal_cause: failed and interrupted name a cause"}
			}
		}
		r.FailedCause = failedCause
		r.FinishedAt = at
		r.PausedReason = ""
	default:
		if to == RunPaused {
			if pausedReason == "" {
				return IllegalTransition{What: "run " + r.ID, From: r.Status, To: to,
					Why: "runs_paused_reasoned: paused names a reason"}
			}
			r.PausedReason = pausedReason
		} else {
			r.PausedReason = ""
		}
		r.FinishedAt = time.Time{}
	}
	if r.StartedAt.IsZero() && (to == RunRunning || to == RunWaitingHuman) {
		r.StartedAt = at
	}
	r.Status = to
	return nil
}

// ReopenForRetry resets a run's terminal row for a retry request (01:
// interrupted may transition to the retry queue). Only a failed, interrupted
// or cancelled run is eligible, and the caller must hold the run's advancer
// lock.
func (r *Run) ReopenForRetry() error {
	switch r.Status {
	case RunFailed, RunInterrupted, RunCancelled:
	default:
		return IllegalTransition{What: "run " + r.ID, From: r.Status, To: RunQueued,
			Why: "run_not_retriable: only a failed, interrupted or cancelled run reopens"}
	}
	r.Status = RunQueued
	r.FailedCause = ""
	r.PausedReason = ""
	r.FinishedAt = time.Time{}
	r.CancelRequestedAt = nil
	return nil
}

// ------------------------------------------------------- the node execution row

// NodeExecution is 01's NodeExecution: one row per *runtime occurrence*, keyed
// by ADR-0023 § 1's text path (/build_until_verified[2]/review), never by a
// position index (01 invariant 6).
type NodeExecution struct {
	ID          string
	RunID       string
	NodeID      string
	Kind        string
	InstanceKey string
	ScopeKey    string
	// Location is compiler.LocationWorker or LocationControlPlane, copied at
	// creation: ADR-0023 § 3 names the path in the row rather than inferring it
	// from the kind at read time.
	Location    string
	Status      string
	Outcome     string
	Outputs     any
	ErrorClass  string
	FailedCause string
	Waiting     string

	ArtifactRefs []any
	DependsOn    []string

	AttemptCount int
	AttemptLimit int
	InFlight     int

	// ScopeInstance carries the composite's own bookkeeping (contract § 5.1
	// step 6). Iteration is derived from the child rows that exist, so a crash
	// mid-loop restarts the same iteration rather than the loop (ADR-0023 § 6).
	Scope *ScopeState

	CreatedAt  time.Time
	ReadyAt    time.Time
	FinishedAt time.Time

	// SkipReason and CancelReason keep the § 3 rows 14/15 payloads honest.
	SkipReason   string
	CancelReason string
}

// Move applies a node transition under every rule contract § 1 encodes as a
// CHECK: the status enum, the two timestamp rules, and ADR-0023 § 3's
// node_executions_control_plane_never_leased.
func (n *NodeExecution) Move(to string, at time.Time) error {
	if n.Status == to {
		return nil
	}
	if !CanNodeTransition(n.Status, to) {
		return IllegalTransition{What: "node execution " + n.InstanceKey, From: n.Status, To: to}
	}
	if n.Location == "control_plane" && (to == NodeLeased || to == NodeRunning) {
		return IllegalTransition{What: "node execution " + n.InstanceKey, From: n.Status, To: to,
			Why: "node_executions_control_plane_never_leased: control-plane work holds no lease (ADR-0023 § 3)"}
	}
	switch {
	case NodeTerminal(to):
		if at.IsZero() {
			return IllegalTransition{What: "node execution " + n.InstanceKey, From: n.Status, To: to,
				Why: "node_executions_terminal_timestamped: a terminal node carries finished_at"}
		}
		n.FinishedAt = at
		n.Waiting = ""
	default:
		if to == NodeReady && n.ReadyAt.IsZero() {
			n.ReadyAt = at
		}
		if NodeTerminal(n.Status) {
			n.FinishedAt = time.Time{}
		}
	}
	n.Status = to
	return nil
}

// ------------------------------------------------------------------ attempt row

// Attempt is ADR-0023 § 4's single claim unit for worker work. The lease triple
// (worker, deadline, token) and the timestamp rules are 01 invariant 3's shape
// in Go; contract § 1's attempts_queued_unowned / attempts_lease_is_a_triple /
// attempts_succeeded_has_outputs / attempts_failed_has_class /
// attempts_agent_turn_pair CHECKs are the same rules in SQL.
type Attempt struct {
	ID              string
	NodeExecutionID string
	RunID           string
	AttemptNumber   int
	Status          string
	ErrorClass      string
	Detail          string
	OutputErrors    []any

	WorkerID        string
	LeaseExpiresAt  time.Time
	FencingToken    int64
	ScheduledAt     time.Time
	DeadlineAt      time.Time
	CancelRequested *time.Time

	Outputs       any
	OutputsDigest string
	ArtifactRefs  []any

	// Overrides is the retry-time input override set (run.override.applied is
	// reserved and NOT emitted, ADR-0024 § 3 — the attempt row is the visible
	// record of an override).
	Overrides map[string]any
	// RetryContext is what a retry inherits under continue_workspace (ADR-0023
	// § 6): {attempt, error_class, head_commit, modified_path_count}.
	RetryContext map[string]any

	ConversationID string
	TurnID         string

	CreatedAt  time.Time
	StartedAt  time.Time
	FinishedAt time.Time
}

// Check runs the attempt's constraint set as it stands. Every mutation calls it
// before returning, so an invalid row cannot exist even transiently in memory.
func (a *Attempt) Check() error {
	if a.AttemptNumber < 1 {
		return fmt.Errorf("attempt %s: attempt_number must be >= 1", a.ID)
	}
	if a.Status != AttemptQueued && a.Status != AttemptLeased && a.Status != AttemptRunning &&
		!AttemptTerminal(a.Status) {
		return fmt.Errorf("attempt %s: status %q is outside the attempts.status CHECK", a.ID, a.Status)
	}
	if a.ErrorClass != "" && !ValidErrorClass(a.ErrorClass) {
		return fmt.Errorf("attempt %s: error_class %q is outside ADR-0023 § 7", a.ID, a.ErrorClass)
	}
	switch a.Status {
	case AttemptQueued:
		// attempts_queued_unowned
		if a.WorkerID != "" || !a.LeaseExpiresAt.IsZero() || a.FencingToken != 0 ||
			!a.StartedAt.IsZero() || !a.FinishedAt.IsZero() {
			return IllegalTransition{What: "attempt " + a.ID, From: a.Status, To: a.Status,
				Why: "attempts_queued_unowned: a queued attempt is owned by nobody"}
		}
	case AttemptLeased, AttemptRunning:
		// attempts_lease_is_a_triple
		if a.WorkerID == "" || a.LeaseExpiresAt.IsZero() || a.FencingToken <= 0 {
			return IllegalTransition{What: "attempt " + a.ID, From: a.Status, To: a.Status,
				Why: "attempts_lease_is_a_triple: a leased attempt names owner, deadline and token"}
		}
		if !a.FinishedAt.IsZero() {
			return IllegalTransition{What: "attempt " + a.ID, From: a.Status, To: a.Status,
				Why: "attempts_terminal_timestamped: a live attempt has no finished_at"}
		}
	default:
		if a.FinishedAt.IsZero() {
			return IllegalTransition{What: "attempt " + a.ID, From: a.Status, To: a.Status,
				Why: "attempts_terminal_timestamped: a terminal attempt carries finished_at"}
		}
		// attempts_terminal_timestamped names the only terminal timestamp rule;
		// an owner is NOT required — a before-claim cancellation was never
		// owned (contract § 3 row 24's before_claim reason), and the DB has no
		// CHECK demanding one on a terminal row.
	}
	if a.Status == AttemptSucceeded && a.Outputs == nil {
		// 01 invariant 4: a succeeded attempt HAS validated outputs, possibly {}.
		return IllegalTransition{What: "attempt " + a.ID, From: a.Status, To: a.Status,
			Why: "attempts_succeeded_has_outputs: success without an output envelope is a lie"}
	}
	if a.Status == AttemptFailed && a.ErrorClass == "" {
		return IllegalTransition{What: "attempt " + a.ID, From: a.Status, To: a.Status,
			Why: "attempts_failed_has_class: a failure names its class"}
	}
	if a.Status == AttemptInterrupted || a.Status == AttemptCancelled {
		switch a.ErrorClass {
		case "", ErrInterrupted, ErrCancelled, ErrWorkspaceLost:
		default:
			return IllegalTransition{What: "attempt " + a.ID, From: a.Status, To: a.Status,
				Why: "attempts_terminal_reasoned: interrupted/closed attempts carry interrupted, cancelled or workspace_lost"}
		}
	}
	// attempts_agent_turn_pair
	if (a.ConversationID == "") != (a.TurnID == "") {
		return IllegalTransition{What: "attempt " + a.ID, From: a.Status, To: a.Status,
			Why: "attempts_agent_turn_pair: a turn without a conversation is half a lease"}
	}
	return nil
}

// Claim moves queued → leased under the fence: the token must come from the
// caller's sequence and must be greater than any token this node execution has
// ever carried (01 invariant 3 — a monotonic token is what makes a stale write
// rejectable rather than merely unlikely).
func (a *Attempt) Claim(workerID string, token int64, now time.Time, lease time.Duration) error {
	if workerID == "" {
		return fmt.Errorf("attempt %s: a claim names its owner", a.ID)
	}
	if token <= 0 {
		return fmt.Errorf("attempt %s: a claim draws a fencing token greater than zero (01 invariant 3)", a.ID)
	}
	if err := a.Move(AttemptLeased, now); err != nil {
		return err
	}
	a.WorkerID = workerID
	a.FencingToken = token
	a.LeaseExpiresAt = now.Add(lease)
	a.StartedAt = time.Time{}
	return a.Check()
}

// Start moves leased → running and records the deadline (node timeoutSeconds).
func (a *Attempt) Start(now time.Time, timeout time.Duration) error {
	if err := a.Move(AttemptRunning, now); err != nil {
		return err
	}
	if timeout > 0 {
		a.DeadlineAt = now.Add(timeout)
	}
	a.StartedAt = now
	return a.Check()
}

// Renew extends the lease. A renewal is the same statement as the turn renewal
// in the real store (ADR-0023 § 4: a turn lease can never outlive its attempt);
// here it is the same guard.
func (a *Attempt) Renew(owner string, token int64, now time.Time, lease time.Duration) error {
	if a.Status != AttemptLeased && a.Status != AttemptRunning {
		return IllegalTransition{What: "attempt " + a.ID, From: a.Status, To: a.Status,
			Why: "only a live attempt renews"}
	}
	if a.WorkerID != owner || a.FencingToken != token {
		return StaleOwner{AttemptID: a.ID, Have: a.FencingToken, Asked: token, Owner: a.WorkerID}
	}
	a.LeaseExpiresAt = now.Add(lease)
	return a.Check()
}

// StaleOwner is the fence refusing a write from a dead owner. The worker treats
// it as "I am dead": stop writing, stop renewing, exit the attempt loop
// (contract § 4 step 10, 12 case 3).
type StaleOwner struct {
	AttemptID string
	Have      int64
	Asked     int64
	Owner     string
}

func (e StaleOwner) Error() string {
	return fmt.Sprintf("attempt %s: stale owner (lease held by %s at token %d, write arrived with %d)",
		e.AttemptID, e.Owner, e.Have, e.Asked)
}

// Verify is the fence check every state write goes through: the writer must
// present the owner and token the row currently carries.
func (a *Attempt) Verify(owner string, token int64) error {
	if a.WorkerID != owner || a.FencingToken != token {
		return StaleOwner{AttemptID: a.ID, Have: a.FencingToken, Asked: token, Owner: a.WorkerID}
	}
	return nil
}

// Move applies an attempt transition. at is required for a terminal status
// (attempts_terminal_timestamped).
func (a *Attempt) Move(to string, at time.Time) error {
	if a.Status == to {
		return nil
	}
	if !CanAttemptTransition(a.Status, to) {
		return IllegalTransition{What: "attempt " + a.ID, From: a.Status, To: to}
	}
	if AttemptTerminal(to) && at.IsZero() {
		// Validate before mutating: an illegal transition must leave the row
		// exactly as it was, or "re-derive from rows" becomes a lie.
		return IllegalTransition{What: "attempt " + a.ID, From: a.Status, To: to,
			Why: "attempts_terminal_timestamped"}
	}
	a.Status = to
	switch to {
	case AttemptSucceeded, AttemptFailed, AttemptCancelled, AttemptInterrupted:
		a.FinishedAt = at
		a.LeaseExpiresAt = time.Time{}
	default:
		a.FinishedAt = time.Time{}
	}
	return nil
}

// Succeed closes an attempt with its validated output envelope. outputs must be
// non-nil (01 invariant 4): an empty object is honest, a NULL is not.
func (a *Attempt) Succeed(owner string, token int64, at time.Time, outputs any, digest string, refs []any) error {
	if err := a.Verify(owner, token); err != nil {
		return err
	}
	if outputs == nil {
		return fmt.Errorf("attempt %s: a succeeded attempt must carry an output envelope (01 invariant 4)", a.ID)
	}
	if err := a.Move(AttemptSucceeded, at); err != nil {
		return err
	}
	a.Outputs = outputs
	a.OutputsDigest = digest
	a.ArtifactRefs = refs
	a.ErrorClass = ""
	return a.Check()
}

// Fail closes an attempt with an error class (attempts_failed_has_class).
func (a *Attempt) Fail(owner string, token int64, at time.Time, class, detail string, outputErrors []any) error {
	if err := a.Verify(owner, token); err != nil {
		return err
	}
	if !ValidErrorClass(class) {
		return fmt.Errorf("attempt %s: error_class %q is outside ADR-0023 § 7", a.ID, class)
	}
	if len(detail) > 512 {
		// attempts.detail's CHECK plus contract § 6's redaction rule.
		detail = detail[:512]
	}
	if err := a.Move(AttemptFailed, at); err != nil {
		return err
	}
	a.ErrorClass = class
	a.Detail = detail
	a.OutputErrors = outputErrors
	a.Outputs = nil
	a.OutputsDigest = ""
	return a.Check()
}

// Interrupt is the honest terminal: written by the reconciler (lease_expired,
// worker_gone) or by a worker closing its own attempt (worker_shutdown,
// human_takeover), never by a process that died, and never a claim of
// resume-without-loss (02 "Execution recovery semantics").
func (a *Attempt) Interrupt(at time.Time, class string) error {
	if class == "" {
		class = ErrInterrupted
	}
	if a.Status == AttemptQueued {
		// A queued attempt was never owned: nothing was interrupted, so the
		// honest terminal is cancelled (contract § 3 row 24's before_claim).
		return IllegalTransition{What: "attempt " + a.ID, From: a.Status, To: AttemptInterrupted,
			Why: "a queued attempt was never owned: cancel it instead"}
	}
	if err := a.Move(AttemptInterrupted, at); err != nil {
		return err
	}
	a.ErrorClass = class
	a.Detail = ""
	return a.Check()
}

// CancelBeforeClaim closes an unclaimed attempt (the fan-out stop path: queued
// siblings are cancelled, completed ones are preserved — 12 case 8).
func (a *Attempt) CancelBeforeClaim(at time.Time, reason string) error {
	if a.Status != AttemptQueued {
		return IllegalTransition{What: "attempt " + a.ID, From: a.Status, To: AttemptCancelled,
			Why: "a live attempt is cancelled by its owner, not by the advancer"}
	}
	if err := a.Move(AttemptCancelled, at); err != nil {
		return err
	}
	a.ErrorClass = ErrCancelled
	a.Detail = reason
	return a.Check()
}

// ------------------------------------------------------------ approvals (gates)

// Approval is a pipeline gate (ADR-0023 § 9): durable, holding no worker and no
// lease, decided through the API by an authorized approver.
type Approval struct {
	ID              string
	RunID           string
	NodeExecutionID string
	Kind            string
	Summary         string
	ArtifactRefs    []any
	ApproverRoles   []string
	ApproverUserIDs []string
	DeadlineAt      time.Time
	OnTimeout       string
	ReRequested     bool
	State           string
	Decision        string
	Comments        string
	DecidedBy       string
	Version         int
	CreatedAt       time.Time
	DecidedAt       time.Time
}

// Approval states (approval_requests.state's CHECK).
const (
	ApprovalPending   = "pending"
	ApprovalDecided   = "decided"
	ApprovalDenied    = "denied"
	ApprovalExpired   = "expired"
	ApprovalCancelled = "cancelled"
)

// Check mirrors approvals_decided_consistency.
func (ap *Approval) Check() error {
	switch ap.State {
	case ApprovalPending:
		if ap.Decision != "" || ap.DecidedBy != "" || !ap.DecidedAt.IsZero() {
			return IllegalTransition{What: "approval " + ap.ID, From: ap.State, To: ap.State,
				Why: "approvals_decided_consistency: a pending gate has no decision"}
		}
	case ApprovalDecided:
		if (ap.Decision != "approved" && ap.Decision != "rejected") || ap.DecidedAt.IsZero() {
			return IllegalTransition{What: "approval " + ap.ID, From: ap.State, To: ap.State,
				Why: "approvals_decided_consistency: a decided gate carries a decision and a timestamp"}
		}
	case ApprovalDenied:
		if ap.Decision != "" || ap.DecidedAt.IsZero() {
			return IllegalTransition{What: "approval " + ap.ID, From: ap.State, To: ap.State,
				Why: "approvals_decided_consistency: a denial is a refusal to decide, not a decision"}
		}
	case ApprovalExpired, ApprovalCancelled:
		if ap.Decision != "" || !ap.DecidedAt.IsZero() {
			return IllegalTransition{What: "approval " + ap.ID, From: ap.State, To: ap.State,
				Why: "approvals_decided_consistency: expired/cancelled carries no decision"}
		}
	default:
		return fmt.Errorf("approval %s: state %q is outside the CHECK", ap.ID, ap.State)
	}
	if ap.Version < 1 {
		return fmt.Errorf("approval %s: version must be >= 1 for CAS", ap.ID)
	}
	return nil
}

// ErrApprovalConflict is the CAS arm: 409 approval_already_decided carries the
// winner, and a denial never mutates the gate (12 case 9's "a refusal is not a
// decision").
type ErrApprovalConflict struct {
	ApprovalID string
	State      string
	Version    int
	Decision   string
	Reason     string
}

func (e ErrApprovalConflict) Error() string {
	return fmt.Sprintf("approval %s: %s (%s) at version %d", e.ApprovalID, e.State, e.Reason, e.Version)
}

// Decide applies the CAS decision. version is the caller's read; a mismatch is
// the conflict, and the caller must have been authorized *at this moment*
// (ADR-0023 § 9: authorization is evaluated at decision time, so a stale grant
// cannot decide a gate).
func (ap *Approval) Decide(version int, decision, comments, decidedBy string, at time.Time) error {
	if ap.State != ApprovalPending {
		return ErrApprovalConflict{ApprovalID: ap.ID, State: ap.State, Version: ap.Version,
			Decision: ap.Decision, Reason: "already_decided"}
	}
	if version != ap.Version {
		return ErrApprovalConflict{ApprovalID: ap.ID, State: ap.State, Version: ap.Version,
			Decision: ap.Decision, Reason: "stale_version"}
	}
	if decision != "approved" && decision != "rejected" {
		return fmt.Errorf("approval %s: decision %q is neither approved nor rejected", ap.ID, decision)
	}
	ap.State = ApprovalDecided
	ap.Decision = decision
	if comments != "" {
		if len(comments) > 8192 {
			comments = comments[:8192] // approval_requests.comments CHECK
		}
		ap.Comments = comments
	}
	ap.DecidedBy = decidedBy
	ap.DecidedAt = at
	ap.Version++
	return ap.Check()
}

// Expire applies the reconciler's deadline arm. on_timeout=expire re-requests
// exactly once, which the re_requested flag records (contract § 5.4 pass 2).
func (ap *Approval) Expire(at time.Time) (reRequest bool, err error) {
	if ap.State != ApprovalPending {
		return false, ErrApprovalConflict{ApprovalID: ap.ID, State: ap.State, Version: ap.Version,
			Reason: "already_decided"}
	}
	if ap.OnTimeout == "expire" && !ap.ReRequested {
		// The re-request is a NEW ask: it gets the SAME window the first
		// deadline carried (contract § 5.4 pass 2 — exactly one, and the
		// approver is not failed for a second they were already granted).
		window := ap.DeadlineAt.Sub(ap.CreatedAt)
		ap.ReRequested = true
		ap.DeadlineAt = at.Add(window)
		ap.Version++
		return true, ap.Check()
	}
	ap.State = ApprovalExpired
	ap.DeadlineAt = at
	return false, ap.Check()
}

// ---------------------------------------------------------- checkpoints (D-009)

// CheckpointRecord is D-009's durable boundary record: one row per successful
// node execution, and the answer to "what does a retry inherit?" (contract § 1's
// run_checkpoints). It carries volume + workspace identity rather than any path,
// because D-024 stays Open: a checkpoint is only readable as a same-volume
// record.
type CheckpointRecord struct {
	RunID           string
	NodeExecutionID string
	AttemptID       string
	InputsDigest    string
	OutputsDigest   string
	ArtifactRefs    []any
	RepoStates      []RepoState
	WorkspaceID     string
	VolumeID        string
	WorkerID        string
	PlanDigest      string
	CreatedAt       time.Time
}

// RepoState is one repository at a boundary: commits, never paths.
type RepoState struct {
	RepositoryID          string
	BaseCommit            string
	HeadCommit            string
	ModifiedPathsArtifact string
	// ModifiedPathCount is the ADR-0017 D8 capture's number, carried so a
	// retry's continue_workspace context can name it (C5e's
	// modified_path_count) without re-reading the manifest artifact.
	ModifiedPathCount int64
	// Committed is whether the repository had no uncommitted changes at the
	// boundary: restore_checkpoint is only legal when every repo is committed
	// (ADR-0023 § 6), which is why the flag is part of the record and not a
	// guess made at retry time.
	Committed bool
}

// Check enforces run_checkpoints_volume_required.
func (c CheckpointRecord) Check() error {
	if c.VolumeID == "" {
		return fmt.Errorf("checkpoint %s/%s: volume_id is required — a checkpoint that names no volume promises a restore nobody can perform (D-024)",
			c.RunID, c.NodeExecutionID)
	}
	if c.WorkspaceID == "" || c.WorkerID == "" {
		return fmt.Errorf("checkpoint %s/%s: workspace and worker identity are required", c.RunID, c.NodeExecutionID)
	}
	if c.InputsDigest == "" || c.OutputsDigest == "" {
		return fmt.Errorf("checkpoint %s/%s: both digests are required", c.RunID, c.NodeExecutionID)
	}
	return nil
}

// ------------------------------------------------------------ child invocations

// Invocation is the parent's record of a child run (ADR-0023 § 10): keyed by
// the node execution that owns it, never by an attempt, because pipeline.invoke
// is control-plane work that creates no attempt row (contract § 9.1 row 20).
type Invocation struct {
	ID                 string
	RunID              string
	NodeExecutionID    string
	ChildRunID         string
	ChildProjectID     string
	PipelineID         string
	ResolvedRevisionID string
	WaitPolicy         string
	Depth              int
	CreatedAt          time.Time
}

func (iv Invocation) Check() error {
	if iv.ChildRunID == iv.RunID {
		return fmt.Errorf("invocation %s: a run may not invoke itself", iv.ID)
	}
	if iv.Depth < 1 || iv.Depth > 2 {
		return fmt.Errorf("invocation %s: depth %d is outside runs_depth_check (1..2)", iv.ID, iv.Depth)
	}
	if iv.WaitPolicy != "completion" {
		return fmt.Errorf("invocation %s: wait_policy %q is not implemented (ADR-0023 § 10: completion only)",
			iv.ID, iv.WaitPolicy)
	}
	return nil
}
