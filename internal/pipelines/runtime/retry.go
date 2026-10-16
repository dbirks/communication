package runtime

import (
	"fmt"
	"sort"
	"time"

	pevents "github.com/dbirks/communication/internal/pipelines/events"
)

// Workspace modes (ADR-0023 § 6) — the two spellings the schema's
// retry.workspacePolicy enum admits, and the only two a plan can carry: the
// compiler defaults an unauthored node to continue_workspace (§ 6) and refuses
// anything else at validate. restore_checkpoint is the destructive arm, so it
// is the one this package must prove safe (ErrCheckpointUnavailable).
const (
	WorkspaceContinue = "continue_workspace"
	WorkspaceRestore  = "restore_checkpoint"
)

// ErrCheckpointUnavailable is contract route 31's 409 checkpoint_unavailable:
// restore_checkpoint is only legal when every repository is committed at the
// boundary — refusing is what stops "a destructive default wearing a feature
// badge" (C6d).
type ErrCheckpointUnavailable struct {
	NodeInstanceKey string
	Reason          string
}

func (e ErrCheckpointUnavailable) Error() string {
	return fmt.Sprintf("runtime: checkpoint_unavailable for %s: %s", e.NodeInstanceKey, e.Reason)
}

// ErrNodeExecutionNotFound says a named node execution instance key is not a
// row of the run at all. It is a typed error, not a bare fmt.Errorf, because
// the API must tell it apart from a store failure: contract route 31's caller
// named a target that does not exist in that run, which is their error (404
// node-execution-not-found), never a 500.
type ErrNodeExecutionNotFound struct {
	InstanceKey string
	RunID       string
}

func (e ErrNodeExecutionNotFound) Error() string {
	return fmt.Sprintf("runtime: no node execution %s in run %s", e.InstanceKey, e.RunID)
}

// RetryDecision answers "what does a retry inherit?" (contract route 27's
// purpose sentence) for one node execution, purely from rows.
type RetryDecision struct {
	NodeInstanceKey string
	Mode            string // WorkspaceContinue | WorkspaceRestore
	Context         map[string]any
	Checkpoint      *CheckpointRecord // last valid boundary (may be nil at the run's first node)
	// FromCommit is the boundary the restore would reset to (restore mode only).
	FromCommit string
}

// RetryPlan computes the decision for one node execution. mode is the node's
// compiled workspace policy; repoCommitted comes from the checkpoint's own
// recorded states (the flag is part of the record, "never a guess made at
// retry time" — see CheckpointRecord.RepoState).
func RetryPlan(st *State, prog *Program, instanceKey string) (RetryDecision, error) {
	row := st.Node(instanceKey)
	if row == nil {
		return RetryDecision{}, ErrNodeExecutionNotFound{InstanceKey: instanceKey, RunID: st.Run.ID}
	}
	if prog == nil {
		return RetryDecision{}, fmt.Errorf("%w: retry of node %s", ErrNoProgram, instanceKey)
	}
	pn, ok := prog.Plan().FindNode(trimInstanceSuffixes(row.ScopeKey), row.NodeID)
	if !ok {
		return RetryDecision{}, fmt.Errorf("runtime: node %s is not in the pinned plan", instanceKey)
	}
	mode := WorkspaceContinue
	if pn.Retry.WorkspacePolicy == WorkspaceRestore {
		mode = WorkspaceRestore
	}
	// The boundary the retry inherits: the newest checkpoint in the run that
	// precedes this node — the last COMPLETED node, which continue_workspace
	// honours fully (ADR-0023 § 6: "02's checkpoint sentence is about where
	// the durable record boundary is").
	var last *CheckpointRecord
	for i, c := range st.Checkpoints {
		if c.NodeExecutionID == row.ID {
			continue // a retry of THIS node inherits the boundary before it
		}
		if last == nil || st.Checkpoints[i].CreatedAt.After(last.CreatedAt) ||
			(st.Checkpoints[i].CreatedAt.Equal(last.CreatedAt) && c.NodeExecutionID > last.NodeExecutionID) {
			cc := st.Checkpoints[i]
			last = &cc
		}
	}
	d := RetryDecision{NodeInstanceKey: instanceKey, Mode: mode, Context: map[string]any{}, Checkpoint: last}
	if a := st.LastAttempt(row.ID); a != nil {
		d.Context["attempt"] = int64(a.AttemptNumber)
		if a.ErrorClass != "" {
			d.Context["error_class"] = a.ErrorClass
		}
	}
	if last != nil {
		for _, r := range last.RepoStates {
			// continue_workspace facts (ADR-0023 § 6): the commit the retry
			// resumes from, and — only where a capture measured it — how much of
			// the interrupted attempt was uncommitted.
			if head := r.CommitIdentity(); head != "" {
				if d.Context["head_commit"] == nil {
					d.Context["head_commit"] = head
				}
			}
			if r.CaptureRecorded || r.ModifiedPathCount > 0 {
				d.Context["modified_path_count"] = r.ModifiedPathCount
			}
		}
	}
	if mode == WorkspaceRestore {
		if last == nil {
			return d, ErrCheckpointUnavailable{NodeInstanceKey: instanceKey,
				Reason: "no completed boundary exists to restore to"}
		}
		for _, r := range last.RepoStates {
			if r.CaptureRecorded && !r.Committed {
				return d, ErrCheckpointUnavailable{NodeInstanceKey: instanceKey,
					Reason: "repository " + r.RepositoryID + " has uncommitted changes at the boundary"}
			}
			if !r.CaptureRecorded {
				// ADR-0023 § 6 admits the reset only when every repo is provably
				// committed; an un-captured boundary cannot prove it, and a
				// destructive default is the failure mode C6d names.
				return d, ErrCheckpointUnavailable{NodeInstanceKey: instanceKey,
					Reason: "repository " + r.RepositoryID + " was not captured at the boundary: " +
						"its committed state is unrecorded, so nothing may be reset away"}
			}
		}
		if len(last.RepoStates) > 0 {
			d.FromCommit = last.RepoStates[0].CommitIdentity()
		}
	}
	return d, nil
}

// RetryRun is contract route 31's engine half: re-target the failed,
// interrupted or cancelled node executions, reopen them (and the cancelled or
// skipped descendants they re-arm) to PENDING so the advancer re-derives their
// readiness from dependency state, re-queue attempts with retry_context, and
// reopen the run itself. Idempotence rule C6d honoured first: every target's
// plan is validated BEFORE any row moves, so a checkpoint_unavailable refusal
// resets nothing.
//
// An `until` whose iteration 2 died restarts iteration 2, not the loop
// (ADR-0023 § 6) — because the composite's ScopeState was never rolled back
// and reopen only touches the iteration's own rows.
func (ms *MemStore) Retry(runID, requestedBy string, targets []string, inputOverrides map[string]any) error {
	ms.mu.Lock()
	defer ms.mu.Unlock()
	st := ms.runs[runID]
	if st == nil {
		return fmt.Errorf("runtime: unknown run %s", runID)
	}
	if ms.Adv == nil {
		return fmt.Errorf("runtime: no advancer wired")
	}
	prog := ms.Adv.Prog
	// Resolve targets: named keys, or every non-succeeded terminal row.
	var rows []*NodeExecution
	if len(targets) == 0 {
		for _, n := range st.Nodes {
			if n.Status == NodeFailed || n.Status == NodeInterrupted || n.Status == NodeCancelled {
				rows = append(rows, n)
			}
		}
	} else {
		for _, key := range targets {
			n := st.Node(key)
			if n == nil {
				return ErrNodeExecutionNotFound{InstanceKey: key, RunID: runID}
			}
			if n.Status != NodeFailed && n.Status != NodeInterrupted && n.Status != NodeCancelled {
				return fmt.Errorf("runtime: %s is %s, not retriable", key, n.Status)
			}
			rows = append(rows, n)
		}
	}
	if len(rows) == 0 {
		return fmt.Errorf("runtime: run_not_retriable: no target is in a retriable state")
	}
	// Validate every plan first (validate-then-mutate: a refusal must leave
	// the rows exactly as they were).
	decisions := make([]RetryDecision, 0, len(rows))
	reopen := map[string]*NodeExecution{}
	for _, n := range rows {
		d, err := RetryPlan(st, prog, n.InstanceKey)
		if err != nil {
			return err // ErrCheckpointUnavailable carries the 409 code
		}
		decisions = append(decisions, d)
		reopen[n.InstanceKey] = n
		// The branch downstream of a reopened target comes back too: whatever
		// the stopped-branch cascade cancelled, and whatever a `continue`
		// route skipped. Both are re-DERIVED rather than trusted — see Reopen.
		for _, other := range st.Nodes {
			if (other.Status == NodeCancelled || other.Status == NodeSkipped) &&
				sameScopeInstance(other, n) && dependsOnTransitively(prog, other, n) {
				reopen[other.InstanceKey] = other
			}
		}
	}
	// The gate arm of validate-then-mutate, stated BEFORE any row moves: a
	// reopened human.approval re-arms its own approval_requests row (UNIQUE
	// (node_execution_id) admits no second one), and a gate closed by a
	// recorded refusal has nothing left to re-arm — that is the typed
	// run_not_retriable, not a unique-violation 500.
	for _, key := range sortedKeys(reopen) {
		if err := checkGateRetry(st, reopen[key]); err != nil {
			return err
		}
	}
	at := ms.now()
	for _, key := range sortedKeys(reopen) {
		if err := reopen[key].Reopen(at); err != nil {
			return err
		}
	}
	// Re-queue one attempt per reopened WORKER row with the decision's
	// context; control-plane rows re-derive inside the advancer. The order is
	// the sorted key order, not map order: attempt ids (and therefore the
	// claim tie-break) must be deterministic across processes, or a retried
	// run's attempt ledger is a coin flip (route 31 / C6e's append-only
	// ordering claim).
	for _, key := range sortedKeys(reopen) {
		n := reopen[key]
		if n.Location != "worker" {
			continue
		}
		d, has := decisionFor(decisions, n.InstanceKey)
		if !has {
			d = RetryDecision{Context: map[string]any{}, Mode: WorkspaceContinue}
		}
		a := &Attempt{
			ID: st.NewID("at"), NodeExecutionID: n.ID, RunID: runID,
			AttemptNumber: n.AttemptCount + 1, Status: AttemptQueued,
			ScheduledAt: at, RetryContext: d.Context,
			Overrides: filterOverrides(inputOverrides, n.NodeID),
			CreatedAt: at,
		}
		if err := a.Check(); err != nil {
			return err
		}
		n.AttemptCount++
		n.InFlight++
		st.Attempts = append(st.Attempts, a)
		_ = prog
		// No run.checkpoint_restored here, deliberately: queueing a
		// restore_checkpoint retry resets nothing. ADR-0023 § 6 and contract
		// § 3 row 8 make that event the WORKER's alone — the proof the
		// unsandboxed reset actually happened before anything launched. The
		// policy a target was queued under is stated in run.retried's
		// workspace_policies below; a restore that never ran (the C6d
		// refusal, a worker that never claims) then leaves zero
		// checkpoint_restored rows, which is what "nothing was destroyed"
		// is supposed to look like in the journal.
	}
	if st.Run.Status == RunCancelled || st.Run.Status == RunFailed || st.Run.Status == RunInterrupted {
		if err := st.Run.ReopenForRetry(); err != nil {
			return err
		}
	}
	st.event(at, pevents.ActorKindHuman, pevents.Record{
		Type: pevents.TypeRunRetried, RunID: runID, ActorID: requestedBy,
		Payload: pevents.RunRetried{
			ProjectID: st.Run.ProjectID, RunID: runID, RequestedBy: requestedBy,
			Targets: sortedTargetKeys(rows), InputNames: sortedInputNames(inputOverrides),
			WorkspacePolicies: workspacePoliciesByTarget(decisions),
		},
	})
	if ms.Adv != nil {
		return ms.Adv.Advance(st, at)
	}
	return nil
}

// checkGateRetry is route 31's gate arm of validate-then-mutate: the reopened
// human.approval row RE-ARMS its own approval_requests row (UNIQUE
// (node_execution_id) admits no second one — ADR-0023 § 9's one live gate per
// node execution), and only a closed, unanswered gate can be re-asked. A gate
// whose row carries a decision or a recorded refusal is a fact, not a wait, so
// the retry names it with the typed run_not_retriable the API already maps to
// 409 — never the unique-violation 500 this route used to answer.
func checkGateRetry(st *State, n *NodeExecution) error {
	var row *Approval
	for _, ap := range st.Approvals {
		if ap.NodeExecutionID == n.ID {
			row = ap
		}
	}
	if row == nil {
		return nil // the advancer opens a fresh gate on this pass
	}
	switch row.State {
	case ApprovalPending, ApprovalDecided, ApprovalExpired, ApprovalCancelled:
		return nil
	}
	reason := "only a closed, unanswered gate re-arms; approval_requests.state " + row.State +
		" is not"
	if row.State == ApprovalDenied {
		reason = "the row carries a recorded refusal, not an unanswered ask"
	}
	return ErrGateNotRearmable{ApprovalID: row.ID, NodeInstanceKey: n.InstanceKey,
		State: row.State, Reason: reason}
}

// workspacePoliciesByTarget states, inside run.retried's own payload
// (contract § 3 row 6's workspace_policies{}), which workspace policy each
// retried target was QUEUED under. It is the queue-time fact the removed
// queue-time run.checkpoint_restored used to fake: "a restore was requested"
// belongs to the retry event; "a restore happened" belongs to the worker.
func workspacePoliciesByTarget(ds []RetryDecision) map[string]string {
	out := make(map[string]string, len(ds))
	for _, d := range ds {
		out[d.NodeInstanceKey] = d.Mode
	}
	return out
}

func decisionFor(ds []RetryDecision, key string) (RetryDecision, bool) {
	for _, d := range ds {
		if d.NodeInstanceKey == key {
			return d, true
		}
	}
	return RetryDecision{}, false
}

func sortedTargetKeys(rows []*NodeExecution) []string {
	out := make([]string, 0, len(rows))
	for _, r := range rows {
		out = append(out, r.InstanceKey)
	}
	sort.Strings(out)
	return out
}

func sortedInputNames(m map[string]any) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func filterOverrides(m map[string]any, nodeID string) map[string]any {
	if len(m) == 0 {
		return nil
	}
	return m
}

func sameScopeInstance(a, b *NodeExecution) bool {
	return a.ScopeKey == b.ScopeKey
}

// dependsOnTransitively reports whether `other` (same scope instance) depends
// on `target` through declared dependsOn edges.
func dependsOnTransitively(prog *Program, other, target *NodeExecution) bool {
	scope := trimInstanceSuffixes(other.ScopeKey)
	byID := map[string][]string{}
	for _, n := range prog.ScopeNodes(scope) {
		byID[n.ID] = n.DependsOn
	}
	seen := map[string]bool{}
	var walk func(id string) bool
	walk = func(id string) bool {
		for _, dep := range byID[id] {
			if dep == target.NodeID {
				return true
			}
			if !seen[dep] {
				seen[dep] = true
				if walk(dep) {
					return true
				}
			}
		}
		return false
	}
	return walk(other.NodeID)
}

func sortedKeys(m map[string]*NodeExecution) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// PauseRequest/ResumeRequest are contract routes 28/29's engine effect:
// pause stops FUTURE scheduling only (in-flight attempts finish honestly),
// and resume lets the advancer re-derive readiness from rows — never from a
// memory (route 29's sentence is the whole design of this package).
func (ms *MemStore) Pause(runID, reason, requestedBy string) error {
	ms.mu.Lock()
	defer ms.mu.Unlock()
	st := ms.runs[runID]
	if st == nil {
		return fmt.Errorf("runtime: unknown run %s", runID)
	}
	var inFlight []string
	for _, a := range st.LiveAttempts() {
		inFlight = append(inFlight, a.ID)
	}
	if err := st.Run.MoveRun(RunPaused, "", reason, ms.now()); err != nil {
		return err
	}
	st.event(ms.now(), pevents.ActorKindHuman, pevents.Record{
		Type: pevents.TypeRunPaused, RunID: runID, ActorID: requestedBy,
		Payload: pevents.RunPaused{
			ProjectID: st.Run.ProjectID, RunID: runID, PausedReason: reason,
			InFlightAttempts: inFlight, RequestedBy: requestedBy,
		},
	})
	return nil
}

func (ms *MemStore) Resume(runID, requestedBy string) error {
	ms.mu.Lock()
	defer ms.mu.Unlock()
	st := ms.runs[runID]
	if st == nil {
		return fmt.Errorf("runtime: unknown run %s", runID)
	}
	if st.Run.Status != RunPaused {
		return fmt.Errorf("runtime: run %s is %s, not paused", runID, st.Run.Status)
	}
	cleared := st.Run.PausedReason
	if err := st.Run.MoveRun(RunQueued, "", "", ms.now()); err != nil {
		return err
	}
	st.event(ms.now(), pevents.ActorKindHuman, pevents.Record{
		Type: pevents.TypeRunResumed, RunID: runID, ActorID: requestedBy,
		Payload: pevents.RunResumed{ProjectID: st.Run.ProjectID, RunID: runID, PausedReason: cleared},
	})
	// The advance that follows re-derives everything from rows.
	if ms.Adv != nil {
		return ms.Adv.Advance(st, ms.now())
	}
	return nil
}

// RequestCancel is route 30's write: the flag only. The advancer cascades
// (ADR-0023 § 10), which is why cancel and cascade are separate steps with an
// observable event between them.
func (ms *MemStore) RequestCancel(runID, requestedBy string) error {
	ms.mu.Lock()
	defer ms.mu.Unlock()
	st := ms.runs[runID]
	if st == nil {
		return fmt.Errorf("runtime: unknown run %s", runID)
	}
	if RunTerminal(st.Run.Status) {
		return nil
	}
	at := ms.now()
	st.Run.CancelRequestedAt = &at
	_ = requestedBy
	return nil
}

// MarkCancelledByHumanTakeover is ADR-0023 § 9's takeover arm at the run
// level: the attempt closes interrupted{human_takeover} and the run pauses
// with that reason (the conversation-control machinery itself is M2's,
// unchanged — this is only the run-state side of the handoff). requestedBy is
// the human whose CAS on the control row caused the move: run.paused is a
// human-actor event and an actor-less one is a lie about who did it.
func (ms *MemStore) MarkCancelledByHumanTakeover(runID, attemptID, requestedBy string) error {
	// Pause FIRST: the interrupt's follow-up advance must not schedule a
	// retry for the attempt the human is taking over (pause stops future
	// scheduling; the interrupt still writes the honest attempt terminal).
	if err := ms.Pause(runID, PausedHumanTakeover, requestedBy); err != nil {
		return err
	}
	// The event reason names WHY the attempt stopped (§ 5.3 / C9g:
	// node.attempt.interrupted{reason:'human_takeover'}); the attempt's
	// error_class stays the honest 'interrupted' Interrupt itself writes.
	return ms.Interrupt(runID, attemptID, PausedHumanTakeover)
}

// ResumeFromHumanTakeover is the return half of ADR-0016 § 5 / contract § 5.3:
// the pause MarkCancelledByHumanTakeover installed is lifted, and the node the
// human interrupted is re-queued ONCE with the recorded intervention folded
// into its retry_context (C9g: "the next attempt's retry_context names the
// intervention"). The conversation-control move itself stays M2's — this is
// only the run-state side of the handback, and the caller installs the
// controller row in the same store transaction that calls it.
//
// The re-queue is explicit rather than left to the advancer's retry decision:
// a takeover is not an execution failure, so it must not inherit the retry
// budget (a node out of retries would otherwise reach its terminal on resume)
// nor wait out a backoff the human just cancelled by handing the wheel back.
func (ms *MemStore) ResumeFromHumanTakeover(runID, attemptID, requestedBy string, intervention any) error {
	ms.mu.Lock()
	defer ms.mu.Unlock()
	st := ms.runs[runID]
	if st == nil {
		return fmt.Errorf("runtime: unknown run %s", runID)
	}
	if st.Run.Status != RunPaused || st.Run.PausedReason != PausedHumanTakeover {
		return fmt.Errorf("runtime: run %s is %s (paused_reason %q), not paused for human takeover",
			runID, st.Run.Status, st.Run.PausedReason)
	}
	a := st.attempt(attemptID)
	if a == nil {
		return fmt.Errorf("runtime: unknown attempt %s", attemptID)
	}
	n := st.nodeByExecID(a.NodeExecutionID)
	if n == nil {
		return fmt.Errorf("runtime: attempt %s has no node execution", attemptID)
	}
	at := ms.now()

	// 1. Lift the takeover pause — route 29's transition and event, unchanged.
	if err := st.Run.MoveRun(RunQueued, "", "", at); err != nil {
		return err
	}
	st.event(at, pevents.ActorKindHuman, pevents.Record{
		Type: pevents.TypeRunResumed, RunID: runID, ActorID: requestedBy,
		Payload: pevents.RunResumed{
			ProjectID: st.Run.ProjectID, RunID: runID, PausedReason: PausedHumanTakeover,
		},
	})

	// 2. The next attempt inherits exactly what a continue_workspace retry
	// would inherit (ADR-0023 § 6: attempt, error_class, and the last durable
	// boundary's repo facts — never a memory), plus the intervention.
	ctx := map[string]any{}
	if last := st.LastAttempt(n.ID); last != nil {
		ctx["attempt"] = int64(last.AttemptNumber)
		if last.ErrorClass != "" {
			ctx["error_class"] = last.ErrorClass
		}
	}
	if ms.Adv != nil && ms.Adv.Prog != nil {
		if d, err := RetryPlan(st, ms.Adv.Prog, n.InstanceKey); err == nil {
			for k, v := range d.Context {
				ctx[k] = v
			}
		}
	}
	if intervention != nil {
		ctx["human_takeover"] = intervention
	}
	if err := ms.queueTakeoverAttempt(st, n, at, ctx); err != nil {
		return err
	}

	// 3. The advance that follows re-derives readiness from rows, as every
	// resume does (§ 5.1: the run is never driven from a memory).
	if ms.Adv != nil {
		return ms.Adv.Advance(st, at)
	}
	return nil
}

// queueTakeoverAttempt appends the handback attempt with the same accounting
// queueAttempt does (attempt_count/in_flight are the ledger the advancer reads
// readiness from), so the advance immediately after cannot double-queue it.
func (ms *MemStore) queueTakeoverAttempt(st *State, n *NodeExecution, at time.Time, retryCtx map[string]any) error {
	a := &Attempt{
		ID:              st.NewID("at"),
		NodeExecutionID: n.ID,
		RunID:           st.Run.ID,
		AttemptNumber:   n.AttemptCount + 1,
		Status:          AttemptQueued,
		ScheduledAt:     at,
		RetryContext:    retryCtx,
		CreatedAt:       at,
	}
	if err := a.Check(); err != nil {
		return err
	}
	n.AttemptCount++
	n.InFlight++
	st.Attempts = append(st.Attempts, a)
	return nil
}

// RunKeys lists every node execution key — a test/ops helper naming the
// "same node_instance_key set" the exit test compares (C1i/C5g: a retry
// appends, never rewrites history).
func (st *State) RunKeys() []string {
	out := make([]string, 0, len(st.Nodes))
	for _, n := range st.Nodes {
		out = append(out, n.InstanceKey)
	}
	sort.Strings(out)
	return out
}
