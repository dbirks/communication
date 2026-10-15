package runtimetest

import (
	"errors"
	"reflect"
	"testing"
	"time"

	pevents "github.com/dbirks/communication/internal/pipelines/events"
	"github.com/dbirks/communication/internal/pipelines/runtime"
)

// DualFactory is an optional Factory capability: OpenPair opens ONE run in
// TWO independent store instances over the SAME database. The MemStore
// factory does not implement it — there is exactly one in-memory store to
// have — so the dual-instance subtest parameterizes itself off and MemStore
// conformance is untouched (docs/m4-contract.md § 5: the run's truth lives
// in the ledger, and two API replicas must settle the same run without a
// lost update). A store that keeps the authoritative state in one process
// cannot pass this: the second instance acts on rows the first instance
// committed, and every assertion below is a place where a live mirror
// diverges, double-claims, or last-settle-overwrites.
type DualFactory interface {
	Factory
	OpenPair(t *testing.T, cfg Config) (Session, Session)
}

// dualInstanceTests interleaves Advance / Claim / Start / Decide /
// reconciler passes from two instances on one run and demands: zero lost
// updates (the two hydrations agree after every step), and a journal that
// is exactly the union of the steps in commit order — both sessions read
// the journal from the ledger, so agreement on the full event list is the
// union claim.
func dualInstanceTests(t *testing.T, f DualFactory) {
	t.Run("WorkerRace_Reconcile_Complete", func(t *testing.T) { dualWorkerRace(t, f) })
	t.Run("Gate_Decide_From_The_Non_Deciding_Instance", func(t *testing.T) { dualGate(t, f) })
}

// dualWorkerRace: instance A arms and claims; instance B must find nothing
// to claim (12 case 2 across replicas), must see A's lease as its own row
// set, must lose its stale fence presentation, must run the reconciler
// pass whose interrupt the other instance then acts on, and the completion
// one instance writes must be the state BOTH instances agree on.
func dualWorkerRace(t *testing.T, f DualFactory) {
	s1, s2 := f.OpenPair(t, Config{Pipeline: PipelineRetry})

	if err := s1.Advance(); err != nil { // A arms the DAG: the attempt row is minted here
		t.Fatalf("instance A advance: %v", err)
	}
	if err := s2.Advance(); err != nil { // B's pass over A's rows must change nothing (§ 5.1 idempotence across processes)
		t.Fatalf("instance B advance: %v", err)
	}
	if evA, evB := s1.Events(t), s2.Events(t); len(evA) != len(evB) || !reflect.DeepEqual(evA, evB) {
		t.Fatalf("after two instances armed one run, the journals differ (%d vs %d rows) — the arm double-took work", len(evA), len(evB))
	}

	a1, err := s1.Claim(WorkerA)
	if err != nil || a1 == nil {
		t.Fatalf("instance A claim: attempt=%v err=%v", a1, err)
	}
	if again, err := s2.Claim(WorkerB); err != nil || again != nil {
		t.Fatalf("instance B claimed what instance A already holds (attempt=%v err=%v) — the lease is not the row, it is a memory", again, err)
	}
	mustConverge(t, "after cross-instance claim", s1, s2)
	if err := s2.Start(a1.ID, WorkerB, a1.FencingToken); !errors.As(err, new(runtime.StaleOwner)) {
		t.Fatalf("cross-instance stale-owner start: err=%v, want StaleOwner", err)
	}
	if err := s1.Start(a1.ID, WorkerA, a1.FencingToken); err != nil {
		t.Fatalf("instance A start: %v", err)
	}
	mustConverge(t, "after start", s1, s2)

	// The clock is the deployment's wall; both instances share it. The
	// reconciler pass runs on the instance that does NOT own the lease —
	// exactly the API-replica shape of contract § 5.4 pass 1.
	s1.SetNow(s1.Now().Add(DefaultLease + time.Second))
	if err := s2.ReconcileLeases(); err != nil {
		t.Fatalf("instance B reconcile: %v", err)
	}
	mustConverge(t, "after cross-instance lease interrupt", s1, s2)
	if st := s1.State(t); attemptByID(st, a1.ID).Status != runtime.AttemptInterrupted {
		t.Fatalf("instance A's hydration lost instance B's interrupt: %s", attemptByID(st, a1.ID).Status)
	}
	// The advancer's replacement (queued by B's pass, from rows) must be
	// claimable through A, with a strictly greater token drawn from the
	// shared ledger sequence, not per-process counters (ADR-0016 § 3).
	if due, ok := s1.NextDue(); ok && due.After(s1.Now()) {
		s1.SetNow(due)
	}
	a2, err := s1.Claim(WorkerB)
	if err != nil || a2 == nil {
		t.Fatalf("replacement attempt (queued by instance B) not claimable through instance A: %v", err)
	}
	if a2.FencingToken <= a1.FencingToken {
		t.Fatalf("cross-instance token ordering broken: new %d !> dead %d", a2.FencingToken, a1.FencingToken)
	}

	// A stale write arriving through the OTHER instance refuses without
	// moving the journal a single row.
	before := s2.Events(t)
	if err := s2.Complete(a2.ID, WorkerA, a1.FencingToken, Completion{
		Outputs: map[string]any{"note": "zombie"}, OutputsDigest: BoundaryDigest,
		ArtifactRefs: []any{}, Checkpoint: NewCheckpoint(WorkerA),
	}); !errors.As(err, new(runtime.StaleOwner)) {
		t.Fatalf("stale cross-instance complete: err=%v, want StaleOwner", err)
	}
	if after := s2.Events(t); len(after) != len(before) || !reflect.DeepEqual(before, after[:len(before)]) {
		t.Fatalf("the refused cross-instance write touched the journal (%d → %d)", len(before), len(after))
	}

	// The boundary lands through one instance and IS the state the other
	// instance hydrates (no last-settle-wins, no shadow rows).
	if err := s1.Complete(a2.ID, WorkerB, a2.FencingToken, Completion{
		Outputs: map[string]any{"note": "done"}, OutputsDigest: BoundaryDigest,
		ArtifactRefs: []any{"art:1"}, Outcome: "success", Checkpoint: NewCheckpoint(WorkerB),
	}); err != nil {
		t.Fatalf("instance A complete: %v", err)
	}
	mustConverge(t, "after cross-instance boundary", s1, s2)
	if st := s2.State(t); st.Run.Status != runtime.RunCompleted {
		t.Fatalf("instance B never saw the run complete: %s", st.Run.Status)
	}

	// The journal is exactly the union of both instances' steps in commit
	// order. Both sessions read domain_events back from the ledger, so
	// deep-equality of the two full lists plus the expected counts IS the
	// union claim (a mirror store either misses the other instance's rows
	// or double-appends its own).
	evA, evB := s1.Events(t), s2.Events(t)
	if !reflect.DeepEqual(evA, evB) {
		t.Fatalf("the two instances' journals disagree — the union is not one journal")
	}
	wantCounts := map[string]int{
		string(pevents.TypeNodeAttemptStarted):        1, // only a1 ever started
		string(pevents.TypeNodeAttemptInterrupted):    1, // lease_expired through instance B
		string(pevents.TypeNodeAttemptRetryScheduled): 1, // the replacement, queued from rows
		string(pevents.TypeNodeAttemptCompleted):      1, // instance A's boundary
		string(pevents.TypeRunCheckpointSaved):        1,
		string(pevents.TypeRunCompleted):              1,
	}
	for typ, want := range wantCounts {
		if got := countType(evA, typ); got != want {
			t.Fatalf("journal has %d %s rows, want exactly %d (union in commit order: %v)", got, typ, want, typeList(evA))
		}
	}
	if evA[len(evA)-1].Type != pevents.TypeRunCompleted {
		t.Fatalf("the journal does not end at run.completed: %s", evA[len(evA)-1].Type)
	}
}

// dualGate: a gate materialized by instance A is decided through instance B;
// the CAS winner is final across processes and the losing presentation
// touches nothing (12 case 9's shape at the replica boundary).
func dualGate(t *testing.T, f DualFactory) {
	s1, s2 := f.OpenPair(t, Config{Pipeline: PipelineGate})
	if err := s1.Advance(); err != nil { // A mints the approval row
		t.Fatalf("instance A advance: %v", err)
	}
	mustConverge(t, "after gate materialization", s1, s2)
	st2 := s2.State(t)
	if len(st2.Approvals) != 1 {
		t.Fatalf("instance B never hydrated instance A's gate row: %d approvals", len(st2.Approvals))
	}
	ap := st2.Approvals[0]
	wantVersion := ap.Version // capture: the view merges forward into this pointer

	before := s1.Events(t)
	if err := s2.Decide(GateDecision{ApprovalID: ap.ID, Decision: "approved",
		Decider: "bob", Version: ap.Version + 5, Authorize: allowAll}); !errors.As(err, new(runtime.ErrApprovalConflict)) {
		t.Fatalf("stale-version cross-instance decide: err=%v, want ErrApprovalConflict", err)
	}
	if after := s1.Events(t); len(after) != len(before) {
		t.Fatalf("the refused cross-instance decide appended %d journal rows", len(after)-len(before))
	}

	if err := s1.Decide(GateDecision{ApprovalID: ap.ID, Decision: "approved", Comments: "ship it",
		Decider: "alice", Version: ap.Version, Authorize: allowAll}); err != nil {
		t.Fatalf("instance A decides: %v", err)
	}
	mustConverge(t, "after decide", s1, s2)
	// The decision arrived from the OTHER instance: instance B must present
	// the decided row, at the new version, through its own hydration — a
	// live mirror still holds its stale pending gate and either re-decides
	// (lost update) or asserts the wrong version.
	apB := attempt2Approval(t, s2, ap.ID)
	if apB.State != runtime.ApprovalDecided || apB.Version != wantVersion+1 || apB.Decision != "approved" {
		t.Fatalf("instance B's gate after instance A's decide: %+v", apB)
	}
	mark := s2.Events(t)
	if err := s2.Decide(GateDecision{ApprovalID: ap.ID, Decision: "rejected", Comments: "too late",
		Decider: "bob", Version: apB.Version, Authorize: allowAll}); err == nil {
		t.Fatal("the losing decider RE-DECIDED a gate instance A already decided — last-settle-wins")
	}
	if after := s2.Events(t); len(after) != len(mark) {
		t.Fatalf("the losing decide touched the journal across instances (%d → %d)", len(mark), len(after))
	}
	if n := s1.State(t).Node("/gate"); n.Status != runtime.NodeSucceeded {
		t.Fatalf("the decided gate node ended %s through instance A", n.Status)
	}
	if got := countType(s1.Events(t), string(pevents.TypeApprovalDecided)); got != 1 {
		t.Fatalf("%d approval.decided rows — one gate, one decision, across any number of instances", got)
	}
}

// mustConverge asserts the two instances' hydrations agree after every
// interleaved step: the rows ARE the state, so two fresh reads of one run
// must return one row set (lost updates and shadow rows both diverge).
func mustConverge(t *testing.T, what string, s1, s2 Session) {
	t.Helper()
	a, b := s1.State(t), s2.State(t)
	if a.Run.Status != b.Run.Status {
		t.Fatalf("%s: run diverged across instances: %s vs %s", what, a.Run.Status, b.Run.Status)
	}
	if !reflect.DeepEqual(nodeStatuses(a), nodeStatuses(b)) {
		t.Fatalf("%s: node rows diverged across instances: %v vs %v", what, nodeStatuses(a), nodeStatuses(b))
	}
	if !reflect.DeepEqual(attemptRows(a), attemptRows(b)) {
		t.Fatalf("%s: attempt rows diverged across instances (lost update): %+v vs %+v", what, attemptRows(a), attemptRows(b))
	}
	if !reflect.DeepEqual(approvalRows(a), approvalRows(b)) {
		t.Fatalf("%s: gate rows diverged across instances", what)
	}
	if len(a.Checkpoints) != len(b.Checkpoints) {
		t.Fatalf("%s: boundary records diverged: %d vs %d", what, len(a.Checkpoints), len(b.Checkpoints))
	}
	if !reflect.DeepEqual(a.Events, b.Events) {
		t.Fatalf("%s: the journals disagree (%d vs %d rows)", what, len(a.Events), len(b.Events))
	}
}

func nodeStatuses(st *runtime.State) map[string]string {
	out := map[string]string{}
	for _, n := range st.Nodes {
		out[n.InstanceKey] = n.Status + "|" + n.Outcome
	}
	return out
}

func attemptRows(st *runtime.State) []runtime.Attempt {
	out := make([]runtime.Attempt, 0, len(st.Attempts))
	for _, a := range st.Attempts {
		row := *a
		row.Outputs = nil // decoded payloads compare by the other fields; the digest pins the envelope
		out = append(out, row)
	}
	return out
}

func approvalRows(st *runtime.State) []runtime.Approval {
	out := make([]runtime.Approval, 0, len(st.Approvals))
	for _, ap := range st.Approvals {
		out = append(out, *ap)
	}
	return out
}

func attempt2Approval(t *testing.T, s Session, id string) *runtime.Approval {
	t.Helper()
	for _, ap := range s.State(t).Approvals {
		if ap.ID == id {
			return ap
		}
	}
	t.Fatalf("approval %s vanished from the ledger", id)
	return nil
}

func typeList(events []pevents.Record) []string {
	out := make([]string, 0, len(events))
	for _, e := range events {
		out = append(out, e.Type)
	}
	return out
}
