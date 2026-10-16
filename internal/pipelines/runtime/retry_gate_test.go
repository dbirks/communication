package runtime_test

import (
	"errors"
	"strings"
	"testing"
	"time"

	pevents "github.com/dbirks/communication/internal/pipelines/events"
	"github.com/dbirks/communication/internal/pipelines/runtime"
)

// expireGate drives a gate past its deadline to its honest expiry: the run is
// terminal and the node execution is a route-31 target. on_timeout=expire gets
// its one re-request first (contract § 5.4 pass 2), so both deadlines pass.
func expireGate(t *testing.T, dv *driver, onTimeout string) *runtime.State {
	t.Helper()
	dv.pump(30)
	st := dv.state()
	if len(st.Approvals) != 1 || st.Approvals[0].State != runtime.ApprovalPending {
		t.Fatalf("gate not open: %+v", st.Approvals)
	}
	dv.now = dv.now.Add(61 * time.Second)
	dv.advance()
	st = dv.state()
	if onTimeout == "expire" {
		if !st.Approvals[0].ReRequested || st.Approvals[0].State != runtime.ApprovalPending {
			t.Fatalf("fixture must be on the expire arm's second window: %+v", st.Approvals[0])
		}
		dv.now = dv.now.Add(61 * time.Second)
		dv.advance()
		st = dv.state()
	}
	if st.Approvals[0].State != runtime.ApprovalExpired {
		t.Fatalf("gate = %s, want expired", st.Approvals[0].State)
	}
	if st.Run.Status != runtime.RunFailed {
		t.Fatalf("run = %s/%s, want failed on the expired gate", st.Run.Status, st.Run.FailedCause)
	}
	return st
}

// TestRetryOfAnExpiredGateRearmsTheSameApprovalRow is the live-lab gate
// deadlock (api-a request_id 4128cffa494a6f9f8ced9cc23f86e538, 2026-10-16):
// retry of a run whose retriable node is a human.approval gate answered 500 on
// approval_requests_node_execution_id_key, because the reopened gate asked for
// a FRESH row and the table admits one per node execution — so an
// unanswered-then-expired gate was a dead end. approval_requests UNIQUE
// (node_execution_id) is the model (ADR-0023 § 9): the retry re-arms the SAME
// row — its decision and deadline reset, its version bumps for the CAS, its
// created_at stays — and the run comes back to waiting_human.
func TestRetryOfAnExpiredGateRearmsTheSameApprovalRow(t *testing.T) {
	plan := loadPlan(t, "testdata/gate_expire.yaml") // onTimeout: expire
	dv := newDriver(t, plan, map[string]any{"goal": "expire me, then retry me"})
	st := expireGate(t, dv, "expire")
	first := *st.Approvals[0]
	if first.Version < 2 {
		t.Fatalf("the re-requested gate's version = %d, want the expire arm to have bumped it", first.Version)
	}
	keysBefore := strings.Join(st.RunKeys(), ",")

	if err := dv.ms.Retry(dv.run.ID, "alice", nil, nil); err != nil {
		t.Fatalf("retry of a run whose retriable node is an expired gate: %v", err)
	}
	st = dv.state()
	if len(st.Approvals) != 1 {
		t.Fatalf("approval rows = %d, want exactly 1 (approval_requests UNIQUE (node_execution_id) "+
			"— a reopened gate re-arms the row, it never inserts a second one)", len(st.Approvals))
	}
	ap := st.Approvals[0]
	if ap.ID != first.ID {
		t.Errorf("re-armed gate = %s, want the SAME row %s", ap.ID, first.ID)
	}
	if ap.State != runtime.ApprovalPending {
		t.Errorf("re-armed gate state = %s, want pending", ap.State)
	}
	if ap.Version <= first.Version {
		t.Errorf("re-armed gate version = %d, want > %d (the CAS must invalidate a decide posted against the expired gate)",
			ap.Version, first.Version)
	}
	if !ap.DeadlineAt.After(dv.now) {
		t.Errorf("re-armed gate deadline = %v, want a live window after %v", ap.DeadlineAt, dv.now)
	}
	if !ap.CreatedAt.Equal(first.CreatedAt) {
		t.Errorf("re-armed gate created_at = %v, want the row's original %v", ap.CreatedAt, first.CreatedAt)
	}
	if ap.Decision != "" || ap.DecidedBy != "" || !ap.DecidedAt.IsZero() {
		t.Errorf("re-armed gate carries a decision: %+v (approvals_decided_consistency: a pending gate has none)", ap)
	}
	if !ap.ReRequested {
		t.Errorf("re-armed gate re_requested = false: the retry re-asked this row and re_requested is the " +
			"only re-request marker approval_requests carries")
	}
	if err := ap.Check(); err != nil {
		t.Errorf("re-armed gate violates the table's CHECK: %v", err)
	}
	if keysBefore != strings.Join(st.RunKeys(), ",") {
		t.Errorf("retry changed the key set: %s → %s (C6e)", keysBefore, st.RunKeys())
	}
	if g := st.Node("/gate"); g.Status != runtime.NodeWaiting || g.Waiting != runtime.WaitingApproval {
		t.Errorf("/gate = %s/%s, want waiting/approval", g.Status, g.Waiting)
	}
	if st.Run.Status != runtime.RunWaitingHuman {
		t.Errorf("run after the retry = %s/%s, want waiting_human with the gate live again",
			st.Run.Status, st.Run.FailedCause)
	}
	req := lastRecord(t, st, pevents.TypeApprovalRequested).Payload.(pevents.ApprovalRequested)
	if req.ApprovalID != first.ID {
		t.Errorf("approval.requested names %s, want the re-armed row %s", req.ApprovalID, first.ID)
	}

	// The dead end is gone: the re-armed row is decidable at its new version,
	// and the run finishes.
	dv.gate = func(a *runtime.Approval) (string, string) { return "approved", "" }
	dv.pump(30)
	st = dv.state()
	if st.Run.Status != runtime.RunCompleted {
		t.Fatalf("run after deciding the re-armed gate = %s/%s, want completed", st.Run.Status, st.Run.FailedCause)
	}
	if c := countType(st, pevents.TypeApprovalRequested); c != 2 {
		t.Errorf("approval.requested = %d, want the first ask and the retry's re-ask", c)
	}
}

// TestRetryOfAFailedGateWithASiblingRearmsInPlace is the same reopen on the
// on_timeout=fail arm beside a running sibling: only the gate row moves, the
// sibling's completed history stays append-only, and the dependant reads the
// re-armed gate's decision (contract § 5.3 — the scope waits, not the run).
func TestRetryOfAFailedGateWithASiblingRearmsInPlace(t *testing.T) {
	plan := loadPlan(t, "testdata/gate_sibling.yaml") // onTimeout: fail
	dv := newDriver(t, plan, map[string]any{"goal": "fail the deadline"})
	dv.script("/sibling", step{outputs: map[string]any{"ok": true}})
	st := expireGate(t, dv, "fail")
	first := *st.Approvals[0]

	if err := dv.ms.Retry(dv.run.ID, "alice", []string{"/gate"}, nil); err != nil {
		t.Fatalf("retry(/gate): %v", err)
	}
	st = dv.state()
	if len(st.Approvals) != 1 || st.Approvals[0].ID != first.ID {
		t.Fatalf("approval rows = %+v, want the one row %s re-armed", st.Approvals, first.ID)
	}
	ap := st.Approvals[0]
	if ap.State != runtime.ApprovalPending || ap.OnTimeout != "fail" {
		t.Errorf("re-armed gate = %s/%s, want pending/fail (the authored arm survives the reopen)",
			ap.State, ap.OnTimeout)
	}
	if !ap.ReRequested || first.ReRequested {
		t.Errorf("re-armed gate re_requested = %v (first %v), want the retry's re-ask marked",
			ap.ReRequested, first.ReRequested)
	}
	if ap.Summary != first.Summary || len(ap.ApproverRoles) != len(first.ApproverRoles) {
		t.Errorf("re-armed gate lost its ask: %q vs %q", ap.Summary, first.Summary)
	}
	if s := st.Node("/sibling"); s.Status != runtime.NodeSucceeded {
		t.Errorf("/sibling = %s after the reopen, want its success untouched", s.Status)
	}
	if st.Run.Status != runtime.RunWaitingHuman {
		t.Errorf("run = %s/%s, want waiting_human", st.Run.Status, st.Run.FailedCause)
	}
	dv.gate = func(a *runtime.Approval) (string, string) { return "approved", "" }
	dv.pump(30)
	st = dv.state()
	if st.Run.Status != runtime.RunCompleted {
		t.Fatalf("run = %s/%s after the re-armed gate was approved, want completed",
			st.Run.Status, st.Run.FailedCause)
	}
	if a := st.Node("/after"); a.Status != runtime.NodeSucceeded {
		t.Errorf("/after = %s, want the dependant ran off the re-armed gate", a.Status)
	}
}

// TestRetryOfAGateClosedByADenialRefusesWithoutMovingRows is the honest 4xx
// arm: a gate closed by a recorded refusal is not a re-armable ask (the denial
// is a fact with an author and a timestamp), and the retry answers the typed
// run_not_retriable instead of the 500 the second-row insert used to be.
// Validate-then-mutate: the refusal resets nothing.
func TestRetryOfAGateClosedByADenialRefusesWithoutMovingRows(t *testing.T) {
	plan := loadPlan(t, "testdata/gate_expire.yaml")
	dv := newDriver(t, plan, map[string]any{"goal": "deny me"})
	st := expireGate(t, dv, "expire")
	ap := st.Approvals[0]
	ap.State = runtime.ApprovalDenied
	ap.DecidedBy = "carol"
	ap.DecidedAt = dv.now
	ap.Version++
	before := strings.Join(st.RunKeys(), ",") + "|" + st.Run.Status + "|" + ap.State

	err := dv.ms.Retry(dv.run.ID, "alice", nil, nil)
	var notRearm runtime.ErrGateNotRearmable
	if !errors.As(err, &notRearm) {
		t.Fatalf("retry of a denied gate = %v, want ErrGateNotRearmable (never a 500)", err)
	}
	if notRearm.ApprovalID != ap.ID || notRearm.NodeInstanceKey != "/gate" {
		t.Errorf("refusal = %+v, want the denied row and its node named", notRearm)
	}
	st = dv.state()
	if before != strings.Join(st.RunKeys(), ",")+"|"+st.Run.Status+"|"+st.Approvals[0].State {
		t.Fatal("a run_not_retriable refusal must move nothing (validate-then-mutate)")
	}
}

// TestRetryOfACancelledGateRearmsItToo covers route 31's OTHER reopen target
// beside the expired one: "cancelled". Cancelling a run waiting on a gate
// closes the gate (§ 3 row 30, approval.cancelled), and the retried run must
// find its gate live again rather than the unique key — the same dead end, one
// state earlier.
func TestRetryOfACancelledGateRearmsItToo(t *testing.T) {
	plan := loadPlan(t, "testdata/gate_sibling.yaml")
	dv := newDriver(t, plan, map[string]any{"goal": "cancel, then come back"})
	dv.pump(30)
	st := dv.state()
	if len(st.Approvals) != 1 || st.Approvals[0].State != runtime.ApprovalPending {
		t.Fatalf("gate not open: %+v", st.Approvals)
	}
	if err := dv.ms.RequestCancel(dv.run.ID, "alice"); err != nil {
		t.Fatal(err)
	}
	dv.pump(30)
	st = dv.state()
	if st.Run.Status != runtime.RunCancelled {
		t.Fatalf("run = %s, want cancelled", st.Run.Status)
	}
	first := *st.Approvals[0]
	if first.State != runtime.ApprovalCancelled {
		t.Fatalf("gate = %s, want cancelled with its node (§ 3 row 30)", first.State)
	}

	if err := dv.ms.Retry(dv.run.ID, "alice", nil, nil); err != nil {
		t.Fatalf("retry of the cancelled gate: %v", err)
	}
	st = dv.state()
	if len(st.Approvals) != 1 || st.Approvals[0].ID != first.ID {
		t.Fatalf("approval rows = %+v, want the one row %s re-armed", st.Approvals, first.ID)
	}
	ap := st.Approvals[0]
	if ap.State != runtime.ApprovalPending || ap.Version <= first.Version || !ap.DeadlineAt.After(dv.now) {
		t.Errorf("re-armed gate = %s v%d deadline %v, want pending, a newer version and a live window",
			ap.State, ap.Version, ap.DeadlineAt)
	}
	if st.Run.Status != runtime.RunWaitingHuman {
		t.Errorf("run = %s/%s, want waiting_human", st.Run.Status, st.Run.FailedCause)
	}
	dv.gate = func(*runtime.Approval) (string, string) { return "rejected", "" }
	dv.pump(30)
	if st = dv.state(); st.Node("/gate").Status != runtime.NodeSucceeded ||
		st.Node("/gate").Outcome != "rejected" {
		t.Errorf("/gate = %+v, want the re-armed gate to answer rejected as a business outcome",
			st.Node("/gate"))
	}
}
