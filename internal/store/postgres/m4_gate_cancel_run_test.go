package postgres

// TestM4GateCancelRun* : docs/m4-contract.md § 7.1 C9f's third arm over a real
// Postgres — "on_timeout=cancel_run cancels the run and cascades (C8g's path)".
// C8g's path is POST /runs/$RUN/cancel, and § 3 row 11 opens it with
// run.cancel_requested. The live lab caught the engine skipping that step
// (live19 C9f: runs.status='cancelled' with run.cancelled in the journal and no
// request row anywhere): the timeout arm set runs.cancel_requested_at and let
// the same pass's settleRun end the run, so nothing named the cancel, its
// cascade, or the children it owed. These are the rows that promise.

import (
	"testing"

	"github.com/dbirks/communication/internal/pipelines/runtime"
)

// m4GateCancelRun ages the live gate into the cancel_run arm the way pass 2
// reads it (the deadline_at is the fact, the wall clock is not — expireGate's
// idiom) and runs the advance the reconciler runs.
func m4GateCancelRun(t *testing.T, x *m4GateFixture, approvalID string) {
	t.Helper()
	ctx, f := testCtx(t), x.f
	if _, err := f.pool.Exec(ctx, `
		UPDATE approval_requests SET on_timeout = 'cancel_run',
		       deadline_at = now() - interval '1 minute'
		WHERE id = $1::uuid AND state = 'pending'`, approvalID); err != nil {
		t.Fatalf("arm the gate for cancel_run: %v", err)
	}
	if err := x.rt.Advance(ctx, x.run.ID); err != nil {
		t.Fatalf("advance past the deadline: %v", err)
	}
}

// TestM4GateCancelRunJournalsTheCancelRequestFirst is the regression: the run
// ends cancelled, no run.failed is ever written for a timeout that cancelled,
// and run.cancel_requested rides the SAME journal, ahead of run.cancelled,
// exactly once.
func TestM4GateCancelRunJournalsTheCancelRequestFirst(t *testing.T) {
	ctx := testCtx(t)
	x := m4GateRun(t)
	f, runID, approvalID := x.f, x.run.ID, x.approvalID
	if st, _, _, _, _, _ := m4GateState(t, ctx, f, approvalID); st != runtime.ApprovalPending {
		t.Fatalf("fixture gate state = %s, want pending", st)
	}
	m4GateCancelRun(t, x, approvalID)

	if st, _, _, _, _, ot := m4GateState(t, ctx, f, approvalID); st != runtime.ApprovalExpired ||
		ot != "cancel_run" {
		t.Fatalf("gate = %s/%s, want expired/cancel_run", st, ot)
	}
	var status, cause string
	if err := f.pool.QueryRow(ctx, `
		SELECT status, coalesce(failed_cause, '') FROM runs WHERE id = $1::uuid`, runID).
		Scan(&status, &cause); err != nil {
		t.Fatal(err)
	}
	if status != runtime.RunCancelled {
		t.Fatalf("run = %s/%s, want cancelled (C9f: cancel_run never fails the run)",
			status, cause)
	}

	var reqSeq, doneSeq, failed *int64
	if err := f.pool.QueryRow(ctx, `
		SELECT min(global_seq) FILTER (WHERE type = 'run.cancel_requested'),
		       min(global_seq) FILTER (WHERE type = 'run.cancelled'),
		       (SELECT count(*) FROM domain_events
		         WHERE run_id = $1::uuid AND type = 'run.failed')::int8
		FROM domain_events WHERE run_id = $1::uuid`, runID).
		Scan(&reqSeq, &doneSeq, &failed); err != nil {
		t.Fatal(err)
	}
	if reqSeq == nil {
		t.Fatal("run.cancel_requested never journalled — § 7.1 C9f routes cancel_run " +
			"down C8g's path, which opens with the request row (§ 3 row 11)")
	}
	if doneSeq == nil {
		t.Fatal("run.cancelled never journalled")
	}
	if *reqSeq >= *doneSeq {
		t.Errorf("run.cancel_requested seq %d must precede run.cancelled seq %d", *reqSeq, *doneSeq)
	}
	if n := m4RunEventCount(t, ctx, f, runID, "run.cancel_requested"); n != 1 {
		t.Errorf("run.cancel_requested rows = %d, want exactly 1 however many passes follow", n)
	}
	if failed != nil && *failed != 0 {
		t.Errorf("run.failed rows = %d, want 0: a timeout cancel is not an execution failure",
			*failed)
	}
	// The cascade is what makes the request worth journalling: everything the run
	// still held is cancelled with it.
	if n := m4RunEventCount(t, ctx, f, runID, "node.execution_cancelled"); n == 0 {
		t.Error("the cancel requested nothing — no node.execution_cancelled row behind it")
	}
}
