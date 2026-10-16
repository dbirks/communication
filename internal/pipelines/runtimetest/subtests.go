package runtimetest

import (
	"encoding/json"
	"errors"
	"reflect"
	"testing"
	"time"

	pevents "github.com/dbirks/communication/internal/pipelines/events"
	"github.com/dbirks/communication/internal/pipelines/runtime"
)

// Every expectation below was pinned by OBSERVING MemStore (the reference
// Store) and is cited to the contract/spec case it enforces. Each subtest
// opens a fresh session (Factory.Open), so -count=2 and any adapter plug in
// unchanged.

// testHappyPath: claim→start→renew→complete across the fence, ending with
// the run completed (docs/m4-contract.md § 4 steps 6-10, ADR-0023 § 4).
func testHappyPath(t *testing.T, f Factory) {
	s := f.Open(t, Config{Pipeline: PipelineSingle})
	if err := s.Advance(); err != nil { // reconciler backstop arms the DAG
		t.Fatalf("advance: %v", err)
	}
	a, err := s.Claim(WorkerA)
	if err != nil || a == nil {
		t.Fatalf("claim: attempt=%v err=%v", a, err)
	}
	if a.Status != runtime.AttemptLeased || a.WorkerID != WorkerA || a.FencingToken <= 0 {
		t.Fatalf("claim left %s/%d/%s (ADR-0023 § 4: the lease is a triple)",
			a.Status, a.FencingToken, a.WorkerID)
	}
	if err := s.Start(a.ID, WorkerA, a.FencingToken); err != nil {
		t.Fatalf("start: %v", err)
	}
	st := s.State(t)
	if got := attemptByID(st, a.ID); got.Status != runtime.AttemptRunning {
		t.Fatalf("start left %s", got.Status)
	}
	if countType(st.Events, string(pevents.TypeNodeAttemptStarted)) != 1 {
		t.Fatalf("start must append exactly one node.attempt.started (contract § 3): %v", st.Events)
	}
	// Renew extends the lease to now+lease (ADR-0023 § 4).
	s.SetNow(s.Now().Add(10 * time.Second))
	if err := s.Renew(a.ID, WorkerA, a.FencingToken); err != nil {
		t.Fatalf("renew: %v", err)
	}
	if got := attemptByID(s.State(t), a.ID).LeaseExpiresAt; !got.After(s.Now()) {
		t.Fatalf("renew did not extend: expires=%s now=%s", got, s.Now())
	}
	err = s.Complete(a.ID, WorkerA, a.FencingToken, Completion{
		Outputs: map[string]any{"note": "done"}, OutputsDigest: BoundaryDigest,
		ArtifactRefs: []any{"art:1"}, Outcome: "success", Checkpoint: NewCheckpoint(WorkerA),
	})
	if err != nil {
		t.Fatalf("complete: %v", err)
	}
	st = s.State(t)
	if st.Run.Status != runtime.RunCompleted {
		t.Fatalf("run ended %s, want completed", st.Run.Status)
	}
	if n := st.Node("/work"); n.Status != runtime.NodeSucceeded {
		t.Fatalf("node ended %s", n.Status)
	}
	if got := attemptByID(st, a.ID); got.Status != runtime.AttemptSucceeded {
		t.Fatalf("attempt ended %s", got.Status)
	}
}

// testStaleTokenWritesNothing: 12-test-strategy case 3 at the Store level —
// a write presenting the wrong fence is refused with StaleOwner (state.go's
// Verify) and mutates NO row and NO journal row (contract § 4 step 10: the
// worker treats it as "I am dead").
func testStaleTokenWritesNothing(t *testing.T, f Factory) {
	s := f.Open(t, Config{Pipeline: PipelineSingle})
	_ = s.Advance()
	a, err := s.Claim(WorkerA)
	if err != nil || a == nil {
		t.Fatalf("claim: %v", err)
	}
	if err := s.Start(a.ID, WorkerA, a.FencingToken); err != nil {
		t.Fatalf("start: %v", err)
	}
	before := s.Events(t)
	st := s.State(t)
	attBefore := *attemptByID(st, a.ID)

	// Wrong token, right owner.
	err = s.Complete(a.ID, WorkerA, a.FencingToken+100, Completion{
		Outputs: map[string]any{"note": "x"}, OutputsDigest: BoundaryDigest,
		ArtifactRefs: []any{}, Checkpoint: NewCheckpoint(WorkerA),
	})
	if !errors.As(err, new(runtime.StaleOwner)) {
		t.Fatalf("stale-token complete: err=%v, want StaleOwner (state.go's fence, 12 case 3)", err)
	}
	// Right token, wrong owner (the thief shape of 12 case 2's "only one
	// valid fencing token can commit state").
	err = s.Complete(a.ID, WorkerB, a.FencingToken, Completion{
		Outputs: map[string]any{"note": "x"}, OutputsDigest: BoundaryDigest,
		ArtifactRefs: []any{}, Checkpoint: NewCheckpoint(WorkerB),
	})
	if !errors.As(err, new(runtime.StaleOwner)) {
		t.Fatalf("wrong-worker complete: err=%v, want StaleOwner", err)
	}
	after := s.State(t)
	hasPrefix(t, "stale complete", before, s.Events(t))
	if len(s.Events(t)) != len(before) {
		t.Fatalf("refused writes appended %d journal rows; contract § 5: one txn per state change, refusal = zero", len(s.Events(t))-len(before))
	}
	if got := attemptByID(after, a.ID); !sameAttempt(&attBefore, got) {
		t.Fatalf("refused complete rewrote the attempt row: %+v → %+v", attBefore, got)
	}
	if len(after.Checkpoints) != 0 {
		t.Fatalf("refused complete wrote a checkpoint")
	}
	if n := after.Node("/work"); n.Status != runtime.NodeRunning {
		t.Fatalf("refused complete moved the node to %s", n.Status)
	}
	// The refusal is the FENCE, not the payload: the honest owner still can.
	if err := s.Complete(a.ID, WorkerA, a.FencingToken, Completion{
		Outputs: map[string]any{"note": "done"}, OutputsDigest: BoundaryDigest,
		ArtifactRefs: []any{}, Checkpoint: NewCheckpoint(WorkerA),
	}); err != nil {
		t.Fatalf("owner's complete after refusals: %v", err)
	}
	if s.State(t).Run.Status != runtime.RunCompleted {
		t.Fatalf("run ended %s", s.State(t).Run.Status)
	}
}

// testTwoClaimRace: 12 case 2's shape at the Store level — two workers
// claiming one ready attempt; the second claim finds nothing and can commit
// nothing (claim is the atomic pick, ADR-0023 § 4; contract § 8's "the
// two-claim race").
func testTwoClaimRace(t *testing.T, f Factory) {
	s := f.Open(t, Config{Pipeline: PipelineSingle})
	_ = s.Advance()
	first, err := s.Claim(WorkerA)
	if err != nil || first == nil {
		t.Fatalf("worker-a claim: %v", err)
	}
	second, err := s.Claim(WorkerB)
	if err != nil {
		t.Fatalf("worker-b claim: %v", err)
	}
	if second != nil {
		t.Fatalf("both workers claimed the same attempt (%s) — exactly one must win (12 case 2)", second.ID)
	}
	// The loser cannot commit state under a forged token.
	if err := s.Start(first.ID, WorkerB, first.FencingToken); !errors.As(err, new(runtime.StaleOwner)) {
		t.Fatalf("loser start: err=%v, want StaleOwner", err)
	}
	// The winner can, and nothing else becomes claimable meanwhile.
	if err := s.Start(first.ID, WorkerA, first.FencingToken); err != nil {
		t.Fatalf("winner start: %v", err)
	}
	if again, err := s.Claim(WorkerB); err != nil || again != nil {
		t.Fatalf("running attempt was re-claimable: %v %v", again, err)
	}
}

// testInterruptAndLateComplete: 12 case 5 / case 3's reconciler arm (contract
// § 5.4 pass 1): the reconciler interrupts the dead lease, the ledger stays
// append-only, the replacement attempt carries a strictly greater token
// (ADR-0016 § 3, C4c), and every late write from the dead owner is refused
// without touching rows or journal.
//
// OBSERVED: MemStore refuses the late Complete with IllegalTransition (the
// interrupted row still names its old owner, so Verify passes and the
// terminal-machine guard fires). Any refusal that mutates nothing is the
// contract's demand; the suite pins "refused + nothing written", not one
// error spelling.
func testInterruptAndLateComplete(t *testing.T, f Factory) {
	s := f.Open(t, Config{Pipeline: PipelineRetry})
	_ = s.Advance()
	a1, err := s.Claim(WorkerA)
	if err != nil || a1 == nil {
		t.Fatalf("claim: %v", err)
	}
	if err := s.Start(a1.ID, WorkerA, a1.FencingToken); err != nil {
		t.Fatalf("start: %v", err)
	}
	history := s.Events(t)

	// Process death: the clock walks past the lease, reconciler pass 1 runs.
	s.SetNow(s.Now().Add(DefaultLease + time.Second))
	if err := s.ReconcileLeases(); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	st := s.State(t)
	dead := attemptByID(st, a1.ID)
	if dead.Status != runtime.AttemptInterrupted || dead.ErrorClass != runtime.ErrInterrupted {
		t.Fatalf("reconciler left %s/%s, want interrupted/interrupted", dead.Status, dead.ErrorClass)
	}
	if countType(st.Events, string(pevents.TypeNodeAttemptInterrupted)) != 1 {
		t.Fatalf("interrupt must append its honest event (contract § 3): %v", st.Events)
	}

	// Late writes from the dead owner: refused, journal untouched.
	for name, err := range map[string]error{
		"complete": s.Complete(a1.ID, WorkerA, a1.FencingToken, Completion{
			Outputs: map[string]any{"note": "zombie"}, OutputsDigest: BoundaryDigest,
			ArtifactRefs: []any{}, Checkpoint: NewCheckpoint(WorkerA),
		}),
		"renew": s.Renew(a1.ID, WorkerA, a1.FencingToken),
		"fail":  s.Fail(a1.ID, WorkerA, a1.FencingToken, runtime.ErrInfra, "late"),
	} {
		if err == nil {
			t.Fatalf("late %s from the dead owner was accepted", name)
		}
	}
	after := s.State(t)
	hasPrefix(t, "late writes", history, after.Events)
	if countType(after.Events, string(pevents.TypeNodeAttemptCompleted)) != 0 {
		t.Fatalf("a dead owner published success (12 case 3)")
	}
	if len(after.Checkpoints) != 0 {
		t.Fatalf("a dead owner wrote a checkpoint")
	}
	if got := attemptByID(after, a1.ID); got.Status != runtime.AttemptInterrupted {
		t.Fatalf("late writes moved the attempt to %s", got.Status)
	}

	// The advancer re-derives a replacement (contract § 5.1 step 4); its
	// token is strictly greater — once per claim, never per row (ADR-0016 § 3).
	if due, ok := s.NextDue(); ok && due.After(s.Now()) {
		s.SetNow(due) // the persisted backoff landing time, not a hint
	}
	a2, err := s.Claim(WorkerB)
	if err != nil || a2 == nil {
		t.Fatalf("replacement attempt never became claimable: %v", err)
	}
	if a2.FencingToken <= a1.FencingToken {
		t.Fatalf("replacement token %d !> dead token %d (C4c's provable rejection)",
			a2.FencingToken, a1.FencingToken)
	}
	// The old token cannot commit state on the new attempt (12 case 2's
	// "only one valid fencing token").
	if err := s.Complete(a2.ID, WorkerA, a1.FencingToken, Completion{
		Outputs: map[string]any{"note": "x"}, Checkpoint: NewCheckpoint(WorkerA),
	}); !errors.As(err, new(runtime.StaleOwner)) {
		t.Fatalf("old-token write on the replacement: err=%v, want StaleOwner", err)
	}
}

// testBoundaryAtomicity: the checkpoint boundary transaction (contract § 4
// step 10, § 5 one transaction per state change / ADR-0013, ADR-0023 § 6,
// D-009). Positive arm: outputs + digest + artifact refs + the checkpoint
// row + both events all land together. Negative arm: an envelope the plan
// rejects NEVER lands partially — the boundary converts to an
// invalid_output failure and no success record exists anywhere (01
// invariant 4, contract § 4 step 8).
//
// KNOWN DISCREPANCY (MemStore followed per the harness rule): a Complete
// whose CheckpointRecord fails Check() AFTER the rows moved (e.g. an empty
// volume_id) returns an error but leaves the attempt/node succeeded — the
// in-memory store has no rollback. The third arm below parameterizes on the
// AtomicBoundary capability so both facts are pinned: a store that does not
// claim § 5's all-or-nothing keeps the observed MemStore behaviour, and a
// store that does (the Postgres adapter) must roll the entire boundary back —
// attempt, node, checkpoint row and journal alike. The suite is not weakened
// by the split: every store faces the same error demand (Check refuses), and
// claiming the capability is what binds it to the rollback assertion.
func testBoundaryAtomicity(t *testing.T, f Factory) {
	t.Run("success-arms", func(t *testing.T) {
		s := f.Open(t, Config{Pipeline: PipelineSingle})
		_ = s.Advance()
		a, err := s.Claim(WorkerA)
		if err != nil || a == nil {
			t.Fatalf("claim: %v", err)
		}
		_ = s.Start(a.ID, WorkerA, a.FencingToken)
		ckpt := NewCheckpoint(WorkerA)
		ckpt.RepoStates[0].HeadCommit = "head-abc"
		before := s.Events(t)
		if err := s.Complete(a.ID, WorkerA, a.FencingToken, Completion{
			Outputs: map[string]any{"note": "done"}, OutputsDigest: BoundaryDigest,
			ArtifactRefs: []any{"art:1"}, Outcome: "success", Checkpoint: ckpt,
		}); err != nil {
			t.Fatalf("complete: %v", err)
		}
		st := s.State(t)
		att := attemptByID(st, a.ID)
		if att.OutputsDigest != BoundaryDigest || att.ArtifactRefs[0] != "art:1" {
			t.Fatalf("attempt boundary fields: %+v", att)
		}
		n := st.Node("/work")
		if n.Outputs == nil || n.ArtifactRefs[0] != "art:1" || n.Outcome != "success" {
			t.Fatalf("node boundary fields not persisted: %+v", n)
		}
		if len(st.Checkpoints) != 1 {
			t.Fatalf("checkpoints=%d, want 1 (ADR-0023 § 6: a succeeded node WITHOUT its durable boundary is a bug)", len(st.Checkpoints))
		}
		got := st.Checkpoints[0]
		if got.RunID != s.RunID() || got.NodeExecutionID != n.ID || got.AttemptID != a.ID ||
			got.PlanDigest == "" || got.CreatedAt.IsZero() {
			t.Fatalf("checkpoint row not back-filled by the txn: %+v", got)
		}
		// Both events, atomically, after the rows (contract § 3 rows 7 + the
		// completed event's checkpoint_saved flag).
		appended := st.Events[len(before):]
		if countType(appended, string(pevents.TypeNodeAttemptCompleted)) != 1 ||
			countType(appended, string(pevents.TypeRunCheckpointSaved)) != 1 {
			t.Fatalf("boundary must append completed+checkpoint_saved together: %v", appended)
		}
	})

	t.Run("invalid-output-lands-as-failure-not-partial-success", func(t *testing.T) {
		s := f.Open(t, Config{Pipeline: PipelineSingle})
		_ = s.Advance()
		a, err := s.Claim(WorkerA)
		if err != nil || a == nil {
			t.Fatalf("claim: %v", err)
		}
		_ = s.Start(a.ID, WorkerA, a.FencingToken)
		before := s.Events(t)
		if err := s.Complete(a.ID, WorkerA, a.FencingToken, Completion{
			Outputs: map[string]any{"wrong": 1}, OutputsDigest: BoundaryDigest,
			ArtifactRefs: []any{"art:1"}, Checkpoint: NewCheckpoint(WorkerA),
		}); err != nil {
			t.Fatalf("invalid-output complete returned %v; MemStore converts it to an attempt failure (nil error)", err)
		}
		st := s.State(t)
		att := attemptByID(st, a.ID)
		if att.Status != runtime.AttemptFailed || att.ErrorClass != runtime.ErrInvalidOutput {
			t.Fatalf("invalid envelope closed %s/%s, want failed/invalid_output (contract § 4 step 8)", att.Status, att.ErrorClass)
		}
		if n := st.Node("/work"); n.Outputs != nil || n.Status != runtime.NodeFailed {
			t.Fatalf("partial success leaked onto the node: %s outputs=%v", n.Status, n.Outputs)
		}
		if len(st.Checkpoints) != 0 {
			t.Fatalf("a node that never succeeded wrote a checkpoint")
		}
		appended := st.Events[len(before):]
		if countType(appended, string(pevents.TypeNodeAttemptCompleted)) != 0 ||
			countType(appended, string(pevents.TypeRunCheckpointSaved)) != 0 {
			t.Fatalf("success events appended for a refused envelope")
		}
	})

	// Arm 3, the contract § 5 boundary proper: a CheckpointRecord that
	// refuses (empty volume_id violates run_checkpoints_volume_required,
	// D-024) AFTER the rows have moved. MemStore's observed behaviour is the
	// error with the success half-written (deviation); the Postgres adapter
	// implements AtomicBoundary and must have rolled everything back.
	t.Run("invalid-checkpoint-boundary-rollback-or-observed-divergence", func(t *testing.T) {
		s := f.Open(t, Config{Pipeline: PipelineSingle})
		_ = s.Advance()
		a, err := s.Claim(WorkerA)
		if err != nil || a == nil {
			t.Fatalf("claim: %v", err)
		}
		_ = s.Start(a.ID, WorkerA, a.FencingToken)
		before := s.Events(t)
		attBefore := *attemptByID(s.State(t), a.ID)
		badCkpt := NewCheckpoint(WorkerA)
		badCkpt.VolumeID = "" // run_checkpoints_volume_required (D-024)
		err = s.Complete(a.ID, WorkerA, a.FencingToken, Completion{
			Outputs: map[string]any{"note": "done"}, OutputsDigest: BoundaryDigest,
			ArtifactRefs: []any{"art:1"}, Outcome: "success", Checkpoint: badCkpt,
		})
		if err == nil {
			t.Fatalf("a checkpoint without a volume_id was accepted (D-024's CHECK is a contract, not a hint)")
		}
		st := s.State(t)
		if !boundaryAtomic(s) {
			// OBSERVED MemStore divergence, kept honest rather than copied:
			// the rows moved before Check() refused. No checkpoint row and
			// no success events may exist either way — a boundary that says
			// "saved" without the record is the bug the CHECK exists for.
			if got := attemptByID(st, a.ID); got.Status != runtime.AttemptSucceeded {
				t.Fatalf("non-atomic store reported %v but left the attempt %s (the deviation is the point)", err, got.Status)
			}
			if len(st.Checkpoints) != 0 {
				t.Fatalf("a refused checkpoint was still stored")
			}
			appended := st.Events[len(before):]
			if countType(appended, string(pevents.TypeRunCheckpointSaved)) != 0 {
				t.Fatalf("checkpoint_saved appended for a checkpoint that refused (ADR-0023 § 6)")
			}
			return
		}
		// The atomic arm — contract § 5's all-or-nothing, asserted, not
		// implied: nothing moved, nothing appended, nothing stored.
		if got := attemptByID(st, a.ID); !sameAttempt(&attBefore, got) {
			t.Fatalf("refused boundary moved the attempt row: %+v → %+v (contract § 5: one transaction per state change)", attBefore, got)
		}
		if n := st.Node("/work"); n.Status != runtime.NodeRunning {
			t.Fatalf("refused boundary moved the node to %s", n.Status)
		}
		if len(st.Checkpoints) != 0 {
			t.Fatalf("refused boundary stored a checkpoint row")
		}
		after := s.Events(t)
		hasPrefix(t, "refused boundary", before, after)
		if len(after) != len(before) {
			t.Fatalf("refused boundary appended %d journal rows", len(after)-len(before))
		}
	})
}

// testDecideRefusalAndCAS: contract § 5.3 / ADR-0023 § 9 / 12 case 9 —
// authorization is evaluated AT DECISION TIME (a revoked grant refuses, and
// the refusal is not a decision: the gate keeps waiting, C9b), and a stale
// CAS version surfaces ErrApprovalConflict without mutating the gate.
func testDecideRefusalAndCAS(t *testing.T, f Factory) {
	s := f.Open(t, Config{Pipeline: PipelineGate})
	_ = s.Advance()
	st := s.State(t)
	if len(st.Approvals) != 1 {
		t.Fatalf("gate must materialize one approval, got %d", len(st.Approvals))
	}
	ap := st.Approvals[0]
	if st.Run.Status != runtime.RunWaitingHuman || ap.State != runtime.ApprovalPending {
		t.Fatalf("run=%s gate=%s (contract § 5.3: the scope waits, no lease)", st.Run.Status, ap.State)
	}
	before := s.Events(t)

	// authorize=false ⇒ ErrApprovalConflict naming its reason; gate untouched
	// except the approval.denied journal row (state.go's Decide denial arm).
	err := s.Decide(GateDecision{ApprovalID: ap.ID, Decision: "approved", Decider: "mallory",
		Version: ap.Version, Authorize: func(*runtime.Approval, string) (bool, string) {
			return false, "approver lost access"
		}})
	var conflict runtime.ErrApprovalConflict
	if !errors.As(err, &conflict) || conflict.Reason != "approver lost access" {
		t.Fatalf("unauthorized decide: err=%v, want ErrApprovalConflict{reason} (12 case 9, C9b)", err)
	}
	if ap.State != runtime.ApprovalPending || ap.Version != 1 || ap.Decision != "" {
		t.Fatalf("a refusal decided the gate: %+v (a refusal is not a decision)", ap)
	}
	if countType(s.Events(t)[len(before):], string(pevents.TypeApprovalDenied)) != 1 {
		t.Fatalf("the denial must be journaled (contract § 3 row 29)")
	}

	// CAS: wrong version ⇒ stale_version, nothing written at all.
	mark := s.Events(t)
	err = s.Decide(GateDecision{ApprovalID: ap.ID, Decision: "approved", Decider: "alice",
		Version: ap.Version + 7, Authorize: allowAll})
	if !errors.As(err, &conflict) || conflict.Reason != "stale_version" {
		t.Fatalf("CAS decide: err=%v, want ErrApprovalConflict{stale_version} (contract § 8 'approval CAS')", err)
	}
	if len(s.Events(t)) != len(mark) {
		t.Fatalf("a CAS conflict appended journal rows")
	}
	if ap.State != runtime.ApprovalPending {
		t.Fatalf("a CAS conflict moved the gate to %s", ap.State)
	}

	// The right version + live grant decides it: version bumps, the decision
	// is a business outcome read by the dependant (contract § 5.3).
	if err := s.Decide(GateDecision{ApprovalID: ap.ID, Decision: "approved", Comments: "ship it",
		Decider: "alice", Version: ap.Version, Authorize: allowAll}); err != nil {
		t.Fatalf("decide: %v", err)
	}
	if ap.State != runtime.ApprovalDecided || ap.Version != 2 {
		t.Fatalf("decided gate: %+v", ap)
	}
	if n := s.State(t).Node("/gate"); n.Status != runtime.NodeSucceeded {
		t.Fatalf("gate node after decision: %s", n.Status)
	}
}

// testDecideDouble: a second decision is refused as ErrApprovalConflict
// already_decided (OBSERVED: MemStore errors; it is not a silent no-op) and
// writes nothing.
func testDecideDouble(t *testing.T, f Factory) {
	s := f.Open(t, Config{Pipeline: PipelineGate})
	_ = s.Advance()
	ap := s.State(t).Approvals[0]
	if err := s.Decide(GateDecision{ApprovalID: ap.ID, Decision: "approved",
		Decider: "alice", Version: ap.Version, Authorize: allowAll}); err != nil {
		t.Fatalf("first decide: %v", err)
	}
	before := s.Events(t)
	err := s.Decide(GateDecision{ApprovalID: ap.ID, Decision: "rejected", Comments: "too late",
		Decider: "bob", Version: ap.Version, Authorize: allowAll})
	var conflict runtime.ErrApprovalConflict
	if !errors.As(err, &conflict) || conflict.Reason != "already_decided" {
		t.Fatalf("double decide: err=%v, want ErrApprovalConflict{already_decided}", err)
	}
	hasPrefix(t, "double decide", before, s.Events(t))
	if len(s.Events(t)) != len(before) {
		t.Fatalf("double decide appended journal rows")
	}
	if ap.Comments != "" || ap.Decision != "approved" {
		t.Fatalf("double decide overwrote the winner: %+v (contract § 5.3: the CAS winner is final)", ap)
	}
	if countType(s.Events(t), string(pevents.TypeApprovalDecided)) != 1 {
		t.Fatalf("exactly one approval.decided may exist")
	}
}

// testRetryAppendOnly: run-level retry at a failed node (contract route 31;
// 01's append-only history — the retry.go header's "C6e append-only" claim,
// and C1i/C5g's "a retry appends, never rewrites"). The failed attempt row
// and the whole prior journal must survive byte-identical; the node key set
// must not change; the retry reopens through a NEW attempt.
func testRetryAppendOnly(t *testing.T, f Factory) {
	s := f.Open(t, Config{Pipeline: PipelineSingle})
	_ = s.Advance()
	a1, err := s.Claim(WorkerA)
	if err != nil || a1 == nil {
		t.Fatalf("claim: %v", err)
	}
	_ = s.Start(a1.ID, WorkerA, a1.FencingToken)
	if err := s.Fail(a1.ID, WorkerA, a1.FencingToken, runtime.ErrInfra, "boom"); err != nil {
		t.Fatalf("fail: %v", err)
	}
	st := s.State(t)
	if st.Run.Status != runtime.RunFailed || st.Run.FailedCause != "node_execution_failed:/work" {
		t.Fatalf("authored stop arm: run=%s cause=%q (contract § 5.1 step 8)", st.Run.Status, st.Run.FailedCause)
	}
	history := s.Events(t)
	deadRow := *attemptByID(st, a1.ID)
	keys := st.RunKeys()

	if err := s.Retry("alice", nil, nil); err != nil {
		t.Fatalf("retry: %v", err)
	}
	st = s.State(t)
	hasPrefix(t, "retry", history, st.Events)
	if countType(st.Events, string(pevents.TypeRunRetried)) != 1 {
		t.Fatalf("retry must journal run.retried once (route 31)")
	}
	if got := attemptByID(st, a1.ID); !sameAttempt(&deadRow, got) {
		t.Fatalf("retry rewrote the failed attempt: %+v → %+v (01: repeated attempts append, not overwrite)", deadRow, got)
	}
	if len(st.Attempts) != 2 || st.Attempts[1].AttemptNumber != 2 ||
		st.Attempts[1].Status != runtime.AttemptQueued {
		t.Fatalf("retry did not append a fresh queued attempt: %+v", st.Attempts)
	}
	if got := st.RunKeys(); len(got) != len(keys) || got[0] != keys[0] {
		t.Fatalf("retry rewrote keys %v → %v", keys, got)
	}
	// The reopened run must reach completed through the NEW attempt — the
	// old failure stays in the ledger as history.
	if err := s.Advance(); err != nil {
		t.Fatalf("advance: %v", err)
	}
	a2, err := s.Claim(WorkerC)
	if err != nil || a2 == nil {
		t.Fatalf("retried attempt not claimable: %v", err)
	}
	_ = s.Start(a2.ID, WorkerC, a2.FencingToken)
	if err := s.Complete(a2.ID, WorkerC, a2.FencingToken, Completion{
		Outputs: map[string]any{"note": "ok"}, OutputsDigest: BoundaryDigest,
		ArtifactRefs: []any{}, Checkpoint: NewCheckpoint(WorkerC),
	}); err != nil {
		t.Fatalf("retry complete: %v", err)
	}
	if st = s.State(t); st.Run.Status != runtime.RunCompleted {
		t.Fatalf("retried run ended %s", st.Run.Status)
	}
	if !sameAttempt(&deadRow, attemptByID(st, a1.ID)) {
		t.Fatalf("the failed attempt was rewritten after the retried run completed")
	}
}

// testAdvanceIdempotence: contract § 5.1 step 7 / § 8's "advancer idempotence
// (advance twice, one effect)" — with no new inputs, every extra pass must
// be a journal no-op, mid-run and post-terminal.
func testAdvanceIdempotence(t *testing.T, f Factory) {
	s := f.Open(t, Config{Pipeline: PipelineSingle})
	_ = s.Advance()
	a, err := s.Claim(WorkerA)
	if err != nil || a == nil {
		t.Fatalf("claim: %v", err)
	}
	_ = s.Start(a.ID, WorkerA, a.FencingToken)
	for i := 0; i < 2; i++ {
		before := s.Events(t)
		if err := s.Advance(); err != nil {
			t.Fatalf("mid-run advance %d: %v", i, err)
		}
		if after := s.Events(t); len(after) != len(before) {
			t.Fatalf("mid-run advance pass %d appended %d journal rows (contract § 5.1: advance twice, one effect)",
				i, len(after)-len(before))
		}
	}
	_ = s.Complete(a.ID, WorkerA, a.FencingToken, Completion{
		Outputs: map[string]any{"note": "ok"}, OutputsDigest: BoundaryDigest,
		ArtifactRefs: []any{}, Checkpoint: NewCheckpoint(WorkerA),
	})
	end := s.Events(t)
	for i := 0; i < 2; i++ {
		if err := s.Advance(); err != nil {
			t.Fatalf("post-terminal advance %d: %v", i, err)
		}
	}
	after := s.State(t)
	hasPrefix(t, "post-terminal advance", end, after.Events)
	if len(after.Events) != len(end) {
		t.Fatalf("post-terminal advance appended %d rows", len(after.Events)-len(end))
	}
	if after.Run.Status != runtime.RunCompleted {
		t.Fatalf("advance moved a completed run to %s", after.Run.Status)
	}
}

// testSkipLedgerLegal is the permanent tripwire for the pending → terminal
// edge: a node gated false (when: false) and its dependency-skipped
// dependant go straight from pending to skipped, never visiting ready
// (contract § 9.1 row 14, § 5.1 step 5 — the sample pipeline's conditional
// arms). Contract § 1 encodes the row legality as TWO CHECKs:
// node_executions_terminal_timestamped (a terminal carries finished_at) AND
// node_executions_ready_timestamped (every NON-pending row carries
// ready_at). The Postgres adapter mirrors engine rows verbatim into the
// ledger, so an engine-made skipped row without ready_at is a 23514 CHECK
// violation on the real database — the engine is the reference
// implementation and must produce ledger-legal rows itself, stamping
// ready_at from the store's clock exactly as the pending → ready sibling
// does. Where MemStore's pre-fix observed behaviour (ReadyAt zero on a
// skipped row) disagreed with § 1, § 1 wins and the engine was fixed; this
// pin follows the contract, not the old deviation. The same rule covers
// pending → cancelled and pending → failed (state.go's Move is the single
// transition site), so the pins below check both timestamp columns on every
// row the skip pass terminates.
func testSkipLedgerLegal(t *testing.T, f Factory) {
	s := f.Open(t, Config{Pipeline: PipelineSkip})
	if err := s.Advance(); err != nil {
		t.Fatalf("advance: %v", err)
	}
	st := s.State(t)
	skipped := map[string]*runtime.NodeExecution{}
	for _, key := range []string{"/gated", "/downstream"} {
		n := st.Node(key)
		if n == nil {
			t.Fatalf("%s never materialized", key)
		}
		if n.Status != runtime.NodeSkipped {
			t.Fatalf("%s ended %s, want skipped", key, n.Status)
		}
		if n.FinishedAt.IsZero() {
			t.Errorf("%s: node_executions_terminal_timestamped — skipped row without finished_at", key)
		}
		if n.ReadyAt.IsZero() {
			t.Errorf("%s: node_executions_ready_timestamped — non-pending row without ready_at is a 23514 on the real ledger", key)
		}
		skipped[key] = n
	}
	if countType(st.Events, string(pevents.TypeNodeExecutionSkipped)) != 2 {
		t.Fatalf("both skip arms must journal node.execution_skipped (contract § 3): %v", st.Events)
	}
	for _, n := range skipped {
		for _, a := range st.AttemptsFor(n.ID) {
			t.Fatalf("skipped node %s got an attempt row %s (skipping is control-plane work, ADR-0023 § 3)", n.InstanceKey, a.ID)
		}
	}
	// The rest of the DAG is untouched by the skip: /work arms, claims, and
	// completes, and the terminal skip rows stay frozen append-only through
	// the completion — status semantics unchanged apart from the timestamp.
	work := st.Node("/work")
	if work == nil || work.Status != runtime.NodeReady {
		t.Fatalf("/work must be ready while its sibling skipped: %+v", work)
	}
	a, err := s.Claim(WorkerA)
	if err != nil || a == nil {
		t.Fatalf("claim /work: attempt=%v err=%v", a, err)
	}
	if err := s.Start(a.ID, WorkerA, a.FencingToken); err != nil {
		t.Fatalf("start: %v", err)
	}
	before := s.Events(t)
	if err := s.Complete(a.ID, WorkerA, a.FencingToken, Completion{
		Outputs: map[string]any{"note": "done"}, OutputsDigest: BoundaryDigest,
		ArtifactRefs: []any{}, Checkpoint: NewCheckpoint(WorkerA),
	}); err != nil {
		t.Fatalf("complete: %v", err)
	}
	st = s.State(t)
	if st.Run.Status != runtime.RunCompleted {
		t.Fatalf("skip plus one success must complete the run, ended %s", st.Run.Status)
	}
	if len(st.Events) == len(before) {
		t.Fatalf("completion appended no journal rows")
	}
	for key, was := range map[string]*runtime.NodeExecution{
		"/gated": skipped["/gated"], "/downstream": skipped["/downstream"],
	} {
		now := st.Node(key)
		if now.Status != runtime.NodeSkipped || !now.ReadyAt.Equal(was.ReadyAt) || !now.FinishedAt.Equal(was.FinishedAt) {
			t.Fatalf("%s: the completion rewrote the skip terminal (ready_at %s→%s, status %s→%s)",
				key, was.ReadyAt, now.ReadyAt, was.Status, now.Status)
		}
	}
}

// sameAttempt compares an attempt row by value (Attempt carries slices, so
// == is not available; DeepEqual is the row-identity check the ledger claims
// rely on).
func sameAttempt(a, b *runtime.Attempt) bool { return reflect.DeepEqual(*a, *b) }

var allowAll = func(*runtime.Approval, string) (bool, string) { return true, "" }

// testDecideResumesRun: after the LAST pending gate is decided, the run must
// leave waiting_human for running with a run.resumed journal row, and the
// dependant's queued attempt must be claimable (contract § 5.3: the scope
// waits, not the run; the worker claim predicate reads runs.status —
// live-lab evidence: a decided run stuck in waiting_human never gets picked
// up and the header shows WAITING HUMAN forever).
func testDecideResumesRun(t *testing.T, f Factory) {
	s := f.Open(t, Config{Pipeline: PipelineGate})
	_ = s.Advance()
	st := s.State(t)
	if len(st.Approvals) != 1 {
		t.Fatalf("gate must materialize one approval, got %d", len(st.Approvals))
	}
	ap := st.Approvals[0]
	if st.Run.Status != runtime.RunWaitingHuman {
		t.Fatalf("run=%s before the decision, want waiting_human", st.Run.Status)
	}
	// While a gate is pending the run KEEPS waiting_human: an advance with
	// the gate undecided must not resume it.
	if err := s.Advance(); err != nil {
		t.Fatalf("advance with a live gate: %v", err)
	}
	if st.Run.Status != runtime.RunWaitingHuman {
		t.Fatalf("run resumed while a gate was still pending: %s", st.Run.Status)
	}

	if err := s.Decide(GateDecision{ApprovalID: ap.ID, Decision: "approved",
		Decider: "alice", Version: ap.Version, Authorize: allowAll}); err != nil {
		t.Fatalf("decide approve: %v", err)
	}
	if got := s.State(t).Run.Status; got != runtime.RunRunning {
		t.Fatalf("run=%s after approving the last gate, want running "+
			"(contract § 5.3 — a decided run must leave waiting_human)", got)
	}
	// run.resumed names the reason cleared, exactly once, appended after
	// the decision's approval.decided (append-only journal).
	events := s.Events(t)
	if n := countType(events, string(pevents.TypeRunResumed)); n != 1 {
		t.Fatalf("run.resumed = %d after the decision, want 1 (§ 3 row 4)", n)
	}
	last := -1
	for i, e := range events {
		if e.Type == string(pevents.TypeApprovalDecided) {
			last = i
		}
	}
	resumedAfter := false
	for i, e := range events {
		if e.Type == string(pevents.TypeRunResumed) && i > last {
			resumedAfter = true
			// MemStore keeps the typed payload; an adapter that hydrates the
			// journal from domain_events returns the stored JSON (the runtimetest
			// Events seam), so accept either shape.
			switch p := e.Payload.(type) {
			case pevents.RunResumed:
				if p.PausedReason != runtime.RunWaitingHuman {
					t.Fatalf("run.resumed payload must name waiting_human as the reason cleared: %+v", e.Payload)
				}
			case json.RawMessage:
				var rr pevents.RunResumed
				if err := json.Unmarshal(p, &rr); err != nil || rr.PausedReason != runtime.RunWaitingHuman {
					t.Fatalf("run.resumed payload must name waiting_human as the reason cleared: %s (%v)", string(p), err)
				}
			default:
				t.Fatalf("unexpected run.resumed payload shape %T", e.Payload)
			}
		}
	}
	if !resumedAfter {
		t.Fatalf("run.resumed must be appended after approval.decided (journal order)")
	}

	// The dependant's attempt is CLAIMABLE: this is the whole point — the
	// worker's claim SQL requires runs.status='running'.
	a, err := s.Claim(WorkerA)
	if err != nil {
		t.Fatalf("claim after the decision must succeed: %v", err)
	}
	if a == nil {
		t.Fatalf("claim after the decision returned no attempt")
	}
}
