package runtime

import (
	"context"
	"fmt"
	"sort"
	"sync"
	"time"

	pevents "github.com/dbirks/communication/internal/pipelines/events"
)

// Store is the storage-agnostic seam the Postgres adapter will implement
// after M3 lands (contract § 5: every state change is one transaction with
// its events). A transaction is per run: the real store takes the advisory
// lock communication/advancer/<run-id> plus row locks; the in-memory store
// takes a mutex. Either way the rule is the same — fn's mutations and every
// Record it appends land atomically or not at all, and the advancer re-runs
// after each committed mutation because a mocked-green memory that drifts
// from that shape would test nothing.
type Store interface {
	// Transact holds the run's lock for fn, then runs the advancer pass
	// (AdvanceRun-after-every-event, contract § 5.1).
	Transact(ctx context.Context, runID string, fn func(tx *Tx) error) error
}

// Tx is one run-locked transaction.
type Tx struct {
	st *State
}

// State exposes the run's rows inside the transaction.
func (t *Tx) State() *State { return t.st }

// MemStore is a Store, compile-first.
var _ Store = (*MemStore)(nil)

// MemStore is the in-memory Store: the reference implementation the unit,
// scenario and property tests run against. It is honest about what it is —
// the contract's § 7 exit gate is a real Postgres + worker run, and no
// quantity of green here substitutes for it (AGENTS.md).
type MemStore struct {
	mu   sync.Mutex
	runs map[string]*State
	// Adv is the advancer every transaction triggers afterwards.
	Adv *Advancer
	// Now is the clock the tests drive (deadline arms and backoff become
	// observable without sleeping).
	Now func() time.Time
	// Lease is the attempt lease duration (ADR-0023 § 4: 30 s).
	Lease time.Duration
	// FenceSeq is attempt_fencing_seq's twin: monotonic store-wide, drawn once
	// per claim — a replacement attempt always carries a strictly greater
	// token (12 case 3's provable rejection, C4c).
	FenceSeq int64
}

// NewMemStore wires an advancer into the store; every mutating op triggers
// exactly one pass afterwards, inside the same lock.
func NewMemStore(adv *Advancer) *MemStore {
	return &MemStore{
		runs:  map[string]*State{},
		Adv:   adv,
		Now:   func() time.Time { return time.Now() },
		Lease: defaultLease,
	}
}

// defaultLease is ADR-0023 § 4's 30 s attempt lease.
const defaultLease = 30 * time.Second

// AddRun registers a run's initial rows (the POST /runs transaction's
// outcome: run row + inputs; node executions are materialized by the first
// advance).
func (ms *MemStore) AddRun(st *State) {
	ms.mu.Lock()
	defer ms.mu.Unlock()
	ms.runs[st.Run.ID] = st
}

// Peek returns the live state pointer (tests assert on it; production callers
// go through Transact).
func (ms *MemStore) Peek(runID string) (*State, bool) {
	ms.mu.Lock()
	defer ms.mu.Unlock()
	st, ok := ms.runs[runID]
	return st, ok
}

// Transact implements Store.
func (ms *MemStore) Transact(ctx context.Context, runID string, fn func(tx *Tx) error) error {
	ms.mu.Lock()
	defer ms.mu.Unlock()
	st, ok := ms.runs[runID]
	if !ok {
		return fmt.Errorf("runtime: unknown run %s", runID)
	}
	tx := &Tx{st: st}
	if err := fn(tx); err != nil {
		return err
	}
	if ms.Adv != nil {
		return ms.Adv.Advance(st, ms.Now())
	}
	return nil
}

func (ms *MemStore) now() time.Time { return ms.Now() }

// NextDue reports the earliest future moment anything in the run is waiting
// for — a retry backoff or a gate deadline. The real deployment gets this
// from the API reconciler's poll loop; the hermetic tests use it to move a
// deterministic clock to the next event instead of spinning.
func (ms *MemStore) NextDue(runID string) (time.Time, bool) {
	ms.mu.Lock()
	defer ms.mu.Unlock()
	st, ok := ms.runs[runID]
	if !ok {
		return time.Time{}, false
	}
	next := time.Time{}
	set := func(t time.Time) {
		if t.IsZero() {
			return
		}
		if next.IsZero() || t.Before(next) {
			next = t
		}
	}
	for _, a := range st.Attempts {
		if a.Status == AttemptQueued {
			set(a.ScheduledAt)
		}
	}
	for _, ap := range st.Approvals {
		if ap.State == ApprovalPending {
			set(ap.DeadlineAt)
		}
	}
	if next.IsZero() {
		return time.Time{}, false
	}
	return next, true
}

// Advance is the explicit trigger the reconciler uses as a backstop
// (contract § 5.1: called after every event that can change readiness, and
// by the reconciler regardless).
func (ms *MemStore) Advance(runID string) error {
	return ms.Transact(context.Background(), runID, func(*Tx) error { return nil })
}

// ------------------------------------------------------------- worker-side ops

// Claim implements ADR-0023 § 4's claim as an atomic pick: queued, due, the
// run live, the node not terminal; tie-break (priority, scheduled_at, id).
// The fencing token is drawn from the store-wide monotonic sequence, once per
// claim — never per row (ADR-0016 § 3), so a replacement attempt always
// carries a strictly greater token (12 case 3/C4c).
func (ms *MemStore) Claim(runID, workerID string) (*Attempt, error) {
	ms.mu.Lock()
	defer ms.mu.Unlock()
	st, ok := ms.runs[runID]
	if !ok {
		return nil, fmt.Errorf("runtime: unknown run %s", runID)
	}
	now := ms.now()
	if RunTerminal(st.Run.Status) || st.Run.Status == RunPaused {
		return nil, nil // claim predicate: the run must be live
	}
	var best *Attempt
	for _, a := range st.Attempts {
		if a.Status != AttemptQueued || a.ScheduledAt.After(now) {
			continue
		}
		n := st.nodeByExecID(a.NodeExecutionID)
		if n == nil || n.Status != NodeReady {
			// Worker-facing claim SQL says `AND status = 'ready'` (contract
			// § 5.1 step 4): a retry arms attempts for rows whose dependencies
			// have not settled yet, and those wait for the advancer to re-ready
			// them — they are not claimable work.
			continue
		}
		if best == nil || a.ScheduledAt.Before(best.ScheduledAt) ||
			(a.ScheduledAt.Equal(best.ScheduledAt) && a.ID < best.ID) {
			best = a
		}
	}
	if best == nil {
		return nil, nil
	}
	n := st.nodeByExecID(best.NodeExecutionID)
	ms.FenceSeq++
	if err := best.Claim(workerID, ms.FenceSeq, now, ms.Lease); err != nil {
		return nil, err
	}
	if err := n.Move(NodeLeased, now); err != nil {
		return nil, err
	}
	return best, nil
}

// Start leases→runs and stamps the node's timeout deadline (attempts.
// deadline_at is launch-relative, contract § 1).
func (ms *MemStore) Start(runID, attemptID, workerID string, token int64) error {
	ms.mu.Lock()
	defer ms.mu.Unlock()
	st := ms.runs[runID]
	a := st.attempt(attemptID)
	if a == nil {
		return fmt.Errorf("runtime: unknown attempt %s", attemptID)
	}
	if err := a.Verify(workerID, token); err != nil {
		return err
	}
	n := st.nodeByExecID(a.NodeExecutionID)
	timeout := ms.timeoutOf(n)
	if err := a.Start(ms.now(), timeout); err != nil {
		return err
	}
	if err := n.Move(NodeRunning, ms.now()); err != nil {
		return err
	}
	st.event(ms.now(), ms.actorWorker(workerID), pevents.Record{
		Type: pevents.TypeNodeAttemptStarted, RunID: runID,
		NodeExecutionID: n.ID, AttemptID: a.ID,
		Payload: pevents.NodeAttemptStarted{
			ProjectID: st.Run.ProjectID, RunID: runID, NodeInstanceKey: n.InstanceKey,
			AttemptNumber: a.AttemptNumber, ErrorClass: "",
			WorkerAffinity: st.Run.WorkerAffinity != "", SandboxVerified: true,
		},
	})
	if ms.Adv != nil {
		return ms.Adv.Advance(st, ms.now())
	}
	return nil
}

func (ms *MemStore) timeoutOf(n *NodeExecution) time.Duration {
	if ms.Adv == nil || n == nil || ms.Adv.Prog == nil {
		return 0
	}
	if pn, ok := ms.Adv.Prog.Plan().FindNode(trimInstanceSuffixes(n.ScopeKey), n.NodeID); ok {
		return time.Duration(pn.TimeoutSeconds) * time.Second
	}
	return 0
}

// Renew extends a live attempt's lease (same guard as the turn renewal: a
// turn lease can never outlive its attempt — ADR-0023 § 4).
func (ms *MemStore) Renew(runID, attemptID, workerID string, token int64) error {
	ms.mu.Lock()
	defer ms.mu.Unlock()
	st := ms.runs[runID]
	a := st.attempt(attemptID)
	if a == nil {
		return fmt.Errorf("runtime: unknown attempt %s", attemptID)
	}
	return a.Renew(workerID, token, ms.now(), ms.Lease)
}

// Complete is the boundary transaction (contract § 4 step 10): fenced, it
// writes outputs + digest + artifact_refs + the checkpoint row + the two
// events, and only then does the advancer move. ckpt is REQUIRED for worker
// work: a succeeded node without its durable boundary is a skipped
// checkpoint, which the property test treats as a bug (ADR-0023 § 6).
func (ms *MemStore) Complete(runID, attemptID, workerID string, token int64,
	outputs any, outputsDigest string, artifactRefs []any, outcome string, ckpt CheckpointRecord) error {

	ms.mu.Lock()
	defer ms.mu.Unlock()
	st := ms.runs[runID]
	a := st.attempt(attemptID)
	if a == nil {
		return fmt.Errorf("runtime: unknown attempt %s", attemptID)
	}
	n := st.nodeByExecID(a.NodeExecutionID)
	// The boundary transaction refuses a dishonest success: an envelope the
	// plan's outputs schema would not accept closes as invalid_output, never
	// as succeeded (01 invariant 4, contract § 4 step 8).
	if ms.Adv != nil && ms.Adv.Prog != nil {
		if pn := ms.Adv.Prog.PlanNode(n.scopeRef(), n.NodeID); pn != nil {
			if verr := ms.Adv.Prog.ValidateOutputs(n, pn, outputs); verr != nil {
				return ms.failLocked(st, runID, a, n, workerID, token, ErrInvalidOutput, verr.Error(), nil)
			}
		}
	}
	if err := a.Succeed(workerID, token, ms.now(), outputs, outputsDigest, nz(artifactRefs)); err != nil {
		return err
	}
	if err := n.Move(NodeSucceeded, ms.now()); err != nil {
		return err
	}
	n.Outputs = outputs
	n.ArtifactRefs = nz(artifactRefs)
	n.Outcome = outcome // 03's business outcome arrives from the worker (exit-code
	// mapping, reviewer verdict); the runtime never invents one.
	n.InFlight--
	ckpt.RunID = runID
	ckpt.NodeExecutionID = n.ID
	ckpt.AttemptID = a.ID
	ckpt.CreatedAt = ms.now()
	if ckpt.PlanDigest == "" {
		ckpt.PlanDigest = st.Run.PlanDigest
	}
	if err := ckpt.Check(); err != nil {
		return err
	}
	st.Checkpoints = append(st.Checkpoints, ckpt)
	st.event(ms.now(), ms.actorWorker(workerID), pevents.Record{
		Type: pevents.TypeNodeAttemptCompleted, RunID: runID,
		NodeExecutionID: n.ID, AttemptID: a.ID,
		Payload: pevents.NodeAttemptCompleted{
			ProjectID: st.Run.ProjectID, RunID: runID, NodeInstanceKey: n.InstanceKey,
			AttemptNumber: a.AttemptNumber, OutputsDigest: outputsDigest,
			Outputs: outputs, ArtifactRefs: nz(artifactRefs), CheckpointSaved: true,
		},
	})
	st.event(ms.now(), ms.actorWorker(workerID), pevents.Record{
		Type: pevents.TypeRunCheckpointSaved, RunID: runID,
		NodeExecutionID: n.ID, AttemptID: a.ID,
		Payload: pevents.RunCheckpointSaved{
			ProjectID: st.Run.ProjectID, RunID: runID,
			Checkpoint: ckptEvent(n, ckpt),
		},
	})
	if ms.Adv != nil {
		return ms.Adv.Advance(st, ms.now())
	}
	return nil
}

func ckptEvent(n *NodeExecution, c CheckpointRecord) pevents.Checkpoint {
	rst := make([]pevents.RepoState, 0, len(c.RepoStates))
	for _, r := range c.RepoStates {
		rst = append(rst, pevents.RepoState{
			RepositoryID: r.RepositoryID, BaseCommit: r.BaseCommit,
			HeadCommit: r.HeadCommit, ModifiedPathsArtifact: r.ModifiedPathsArtifact,
		})
	}
	return pevents.Checkpoint{
		NodeInstanceKey: n.InstanceKey, InputsDigest: c.InputsDigest,
		OutputsDigest: c.OutputsDigest, RepoStates: rst,
		ArtifactRefs: nz(c.ArtifactRefs), VolumeID: c.VolumeID,
	}
}

// Fail closes an attempt as failed (the worker's fenced write; the retry
// decision is the advancer's, from rows).
func (ms *MemStore) Fail(runID, attemptID, workerID string, token int64, class, detail string, outputErrors []any) error {
	ms.mu.Lock()
	defer ms.mu.Unlock()
	st := ms.runs[runID]
	a := st.attempt(attemptID)
	if a == nil {
		return fmt.Errorf("runtime: unknown attempt %s", attemptID)
	}
	if err := a.Verify(workerID, token); err != nil {
		return err
	}
	n := st.nodeByExecID(a.NodeExecutionID)
	return ms.failLocked(st, runID, a, n, workerID, token, class, detail, outputErrors)
}

// failLocked closes a failed attempt with the mutex already held (Complete's
// invalid_output arm reuses it).
func (ms *MemStore) failLocked(st *State, runID string, a *Attempt, n *NodeExecution,
	workerID string, token int64, class, detail string, outputErrors []any) error {
	// A terminal closes an attempt exactly once (append-only ledger, § 5). The
	// same-status no-op in Move would otherwise let a repeat fail from the
	// still-valid owner double the node.attempt.failed event and reopen the
	// failed node through failLocked's ready-step without route 31's
	// run.retried journal row (exposed by runtimetest's pass-3 subtest).
	if a.Status == AttemptFailed {
		return IllegalTransition{What: "attempt " + a.ID, From: a.Status, To: AttemptFailed,
			Why: "attempt_already_failed: a terminal attempt closes exactly once (contract § 5)"}
	}
	if err := a.Fail(workerID, token, ms.now(), class, detail, outputErrors); err != nil {
		return err
	}
	// The node returns to ready and the ADVANCER decides retry vs terminal
	// (ADR-0023 § 5: re-derive from rows, including "is there a next
	// attempt?"). in_flight drops with the attempt.
	if err := n.Move(NodeReady, ms.now()); err != nil {
		return err
	}
	n.InFlight--
	last := a
	st.event(ms.now(), ms.actorWorker(workerID), pevents.Record{
		Type: pevents.TypeNodeAttemptFailed, RunID: runID,
		NodeExecutionID: n.ID, AttemptID: a.ID,
		Payload: pevents.NodeAttemptFailed{
			ProjectID: st.Run.ProjectID, RunID: runID, NodeInstanceKey: n.InstanceKey,
			AttemptNumber: last.AttemptNumber, ErrorClass: class,
			Detail: a.Detail, OutputErrors: nz(outputErrors),
		},
	})
	if ms.Adv != nil {
		return ms.Adv.Advance(st, ms.now())
	}
	return nil
}

// Interrupt is the reconciler's honest terminal (lease expired, worker gone)
// — or, with workerID "", a worker closing its own attempt
// (worker_shutdown/human_takeover arms, contract § 3 row 23). It never
// claims resume-without-loss.
func (ms *MemStore) Interrupt(runID, attemptID, reason string) error {
	ms.mu.Lock()
	defer ms.mu.Unlock()
	st := ms.runs[runID]
	a := st.attempt(attemptID)
	if a == nil {
		return fmt.Errorf("runtime: unknown attempt %s", attemptID)
	}
	n := st.nodeByExecID(a.NodeExecutionID)
	if err := a.Interrupt(ms.now(), ErrInterrupted); err != nil {
		return err
	}
	if err := n.Move(NodeReady, ms.now()); err != nil {
		return err
	}
	n.InFlight--
	actor := pevents.ActorKindSystem
	st.event(ms.now(), actor, pevents.Record{
		Type: pevents.TypeNodeAttemptInterrupted, RunID: runID,
		NodeExecutionID: n.ID, AttemptID: a.ID,
		Payload: pevents.NodeAttemptInterrupted{
			ProjectID: st.Run.ProjectID, RunID: runID, NodeInstanceKey: n.InstanceKey,
			AttemptNumber: a.AttemptNumber, Reason: reason,
		},
	})
	if ms.Adv != nil {
		return ms.Adv.Advance(st, ms.now())
	}
	return nil
}

// CancelAttempt is the worker's honest close of a cancel-requested attempt
// (contract § 4 step 11): acp_cancel_ack or process_group_terminated, then
// the node terminal.
func (ms *MemStore) CancelAttempt(runID, attemptID, workerID string, token int64, reason string) error {
	ms.mu.Lock()
	defer ms.mu.Unlock()
	st := ms.runs[runID]
	a := st.attempt(attemptID)
	if a == nil {
		return fmt.Errorf("runtime: unknown attempt %s", attemptID)
	}
	if err := a.Verify(workerID, token); err != nil {
		return err
	}
	n := st.nodeByExecID(a.NodeExecutionID)
	if err := a.Move(AttemptCancelled, ms.now()); err != nil {
		return err
	}
	a.ErrorClass = ErrCancelled
	a.Detail = reason
	n.InFlight--
	if err := n.Move(NodeCancelled, ms.now()); err != nil {
		return err
	}
	n.CancelReason = reasonFromCancel("run_cancelled")
	st.event(ms.now(), ms.actorWorker(workerID), pevents.Record{
		Type: pevents.TypeNodeAttemptCancelled, RunID: runID,
		NodeExecutionID: n.ID, AttemptID: a.ID,
		Payload: pevents.NodeAttemptCancelled{
			ProjectID: st.Run.ProjectID, RunID: runID, NodeInstanceKey: n.InstanceKey,
			AttemptNumber: a.AttemptNumber, Reason: reason,
		},
	})
	st.event(ms.now(), ms.actorWorker(workerID), pevents.Record{
		Type: pevents.TypeNodeExecutionCancelled, RunID: runID,
		NodeExecutionID: n.ID,
		Payload: pevents.NodeExecutionCancelled{
			ProjectID: st.Run.ProjectID, RunID: runID, NodeInstanceKey: n.InstanceKey,
			Reason: "run_cancelled",
		},
	})
	if ms.Adv != nil {
		return ms.Adv.Advance(st, ms.now())
	}
	return nil
}

// ----------------------------------------------------------- reconciler ops

// ReconcileLeases is pass 1 of contract § 5.4: expire leases, interrupt the
// attempt, and let the advancer's retry decision (with the persisted backoff)
// be the visible other half of 12 case 5.
func (ms *MemStore) ReconcileLeases(runID string) error {
	ms.mu.Lock()
	defer ms.mu.Unlock()
	st := ms.runs[runID]
	now := ms.now()
	for _, a := range st.LiveAttempts() {
		if a.LeaseExpiresAt.IsZero() || a.LeaseExpiresAt.After(now) {
			continue
		}
		n := st.nodeByExecID(a.NodeExecutionID)
		if err := a.Interrupt(now, ErrInterrupted); err != nil {
			return err
		}
		if err := n.Move(NodeReady, now); err != nil {
			return err
		}
		n.InFlight--
		st.event(now, pevents.ActorKindSystem, pevents.Record{
			Type: pevents.TypeNodeAttemptInterrupted, RunID: runID,
			NodeExecutionID: n.ID, AttemptID: a.ID,
			Payload: pevents.NodeAttemptInterrupted{
				ProjectID: st.Run.ProjectID, RunID: runID, NodeInstanceKey: n.InstanceKey,
				AttemptNumber: a.AttemptNumber, Reason: "lease_expired",
			},
		})
	}
	if ms.Adv != nil {
		return ms.Adv.Advance(st, now)
	}
	return nil
}

// ReconcileDeadlines is pass 3: a deadline with a still-beating worker sets
// cancel_requested_at and lets the owner close the attempt (§ 5.4 — the
// reconciler never writes the terminal of a live, healthy worker's attempt).
func (ms *MemStore) ReconcileDeadlines(runID string) error {
	ms.mu.Lock()
	defer ms.mu.Unlock()
	st := ms.runs[runID]
	now := ms.now()
	for _, a := range st.LiveAttempts() {
		if a.DeadlineAt.IsZero() || a.DeadlineAt.After(now) || a.CancelRequested != nil {
			continue
		}
		t := now
		a.CancelRequested = &t
	}
	return nil
}

// InterruptWorkspaceLost is pass 5's evidence seam: the caller reports what the
// rows say (this run's workspace is gone) and the advancer — which owns the
// rule — turns that into the honest terminal (advance.go's
// interruptLostWorkspace). Nothing here re-implements the state machine, so
// both stores share one implementation.
//
// No auto-retry follows, and that is the point: ADR-0023 § 7 keeps
// workspace_lost out of retry.retriableErrors, so the run stays interrupted
// until a human retries it (route 31).
func (ms *MemStore) InterruptWorkspaceLost(runID string) error {
	ms.mu.Lock()
	defer ms.mu.Unlock()
	st := ms.runs[runID]
	if st == nil {
		return fmt.Errorf("runtime: unknown run %s", runID)
	}
	st.Run.WorkspaceLost = true
	if ms.Adv != nil {
		return ms.Adv.Advance(st, ms.now())
	}
	return nil
}

// ------------------------------------------------------------- approval ops

// AuthorizeFunc evaluates the approver's grant AT DECISION TIME (12 case 9:
// a grant revoked between gate-open and decide must refuse, never silently
// accept). ok=false must name its reason (§ 3 row 29's enum).
type AuthorizeFunc func(ap *Approval, decider string) (ok bool, reason string)

// Decide applies a gate decision through CAS.
func (ms *MemStore) Decide(runID, approvalID, decision, comments, decider string, version int, authorize AuthorizeFunc) error {
	ms.mu.Lock()
	defer ms.mu.Unlock()
	st := ms.runs[runID]
	var ap *Approval
	for _, x := range st.Approvals {
		if x.ID == approvalID {
			ap = x
		}
	}
	if ap == nil {
		return fmt.Errorf("runtime: unknown approval %s", approvalID)
	}
	if authorize != nil {
		if ok, reason := authorize(ap, decider); !ok {
			// A refusal is not a decision: the gate keeps waiting (C9b).
			st.event(ms.now(), pevents.ActorKindSystem, pevents.Record{
				Type: pevents.TypeApprovalDenied, RunID: runID,
				NodeExecutionID: ap.NodeExecutionID,
				Payload: pevents.ApprovalDenied{
					ProjectID: st.Run.ProjectID, RunID: runID, ApprovalID: ap.ID, Reason: reason,
				},
			})
			return ErrApprovalConflict{ApprovalID: ap.ID, State: ap.State, Version: ap.Version, Reason: reason}
		}
	}
	before := ap.Version
	if err := ap.Decide(version, decision, comments, decider, ms.now()); err != nil {
		return err
	}
	present := comments != ""
	st.event(ms.now(), pevents.ActorKindHuman, pevents.Record{
		Type: pevents.TypeApprovalDecided, RunID: runID,
		NodeExecutionID: ap.NodeExecutionID,
		ActorID:         decider,
		Payload: pevents.ApprovalDecided{
			ProjectID: st.Run.ProjectID, RunID: runID, ApprovalID: ap.ID,
			Decision: decision, CommentsPresent: present, Version: before + 1, DecidedBy: decider,
		},
	})
	if ms.Adv != nil {
		return ms.Adv.Advance(st, ms.now())
	}
	return nil
}

// ------------------------------------------------------------------- helpers

func (st *State) attempt(id string) *Attempt {
	for _, a := range st.Attempts {
		if a.ID == id {
			return a
		}
	}
	return nil
}

func (st *State) nodeByExecID(id string) *NodeExecution {
	for _, n := range st.Nodes {
		if n.ID == id {
			return n
		}
	}
	return nil
}

func (st *State) event(at time.Time, actorKind string, rec pevents.Record) {
	rec.ActorKind = actorKind
	rec.Timestamp = at
	if rec.OrganizationID == "" {
		rec.OrganizationID = st.Run.OrganizationID
	}
	if rec.ProjectID == "" {
		rec.ProjectID = st.Run.ProjectID
	}
	if err := rec.Validate(); err != nil {
		// An invalid journal row is a bug in the emitter, not a runtime
		// condition: fail loudly at the source.
		panic("runtime: invalid event record: " + err.Error())
	}
	st.AppendEvent(rec)
}

func (ms *MemStore) actorWorker(workerID string) string {
	if workerID == "" {
		return pevents.ActorKindSystem
	}
	return pevents.ActorKindWorker
}

// SortedEvents is a test convenience: events in append order (they already
// are — the journal is append-only; this just documents the expectation as
// code where the property tests use it).
func (st *State) SortedEvents() []pevents.Record {
	out := append([]pevents.Record{}, st.Events...)
	sort.SliceStable(out, func(i, j int) bool { return false })
	return out
}
