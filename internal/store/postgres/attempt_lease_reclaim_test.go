package postgres

// Lease-stuck lab regression (gh-loop 2026-10-25, run 01a17351-fa02, attempt
// 6902a939): an attempt was LEASED and never started — the worker's
// BeginAttempt parked forever on a wedged journal advisory lock while
// holding the attempt row's FOR UPDATE fence — and the fleet's only
// lease-expiry recovery (the m4 driver's ReconcileLeases pass) then blocked
// behind that same row lock for 85+ minutes, frozen while holding the
// driver's session advisory lock so no other replica could take the backstop
// either. The fix has two halves tested here against real Postgres:
//
//   - every RuntimeStore pass is bounded (RuntimeStore.PassTimeout), so one
//     wedged row can delay a pass but never freeze the fleet; and
//   - once the wedged holder is gone, the expired UNSTARTED lease is
//     reclaimed: the attempt lands interrupted{lease_expired}, the node is
//     back to ready, the worker's capacity slot comes back, and the retry
//     claim draws a strictly greater fencing token.

import (
	"testing"
	"time"
)

// TestExpiredUnstartedLeaseIsNeverReclaimedWhileTheLeaseIsLive pins the
// scan's honesty: ReconcileLeases only ever writes rows whose deadline the
// clock — not the operator — has passed.
func TestExpiredUnstartedLeaseIsNeverReclaimedWhileTheLeaseIsLive(t *testing.T) {
	ctx := testCtx(t)
	f, store := awSetup(t) // LeaseTTL = 2 s: a live lease, nobody renewing yet
	runID := f.m4QueuedRun(t, ctx, "", 0)
	if _, err := f.pool.Exec(ctx, `UPDATE runs SET plan_snapshot = '{}'::jsonb WHERE id = $1::uuid`, runID); err != nil {
		t.Fatalf("pin an empty plan snapshot: %v", err)
	}
	nodeID, attemptID := f.m4WorkerNode(t, ctx, runID, "/plan")
	workerID := m4Worker(t, ctx, f.pool, "lease-live", 1)
	if claims, err := store.ClaimAttempts(ctx, workerID, 1); err != nil || len(claims) != 1 {
		t.Fatalf("claim = (%v, %v), want one attempt", claims, err)
	}
	if _, err := f.pool.Exec(ctx, `UPDATE node_executions SET in_flight = 1 WHERE id = $1::uuid`, nodeID); err != nil {
		t.Fatalf("record the scheduling in_flight: %v", err)
	}

	rs := NewRuntimeStore(f.pool, nil)
	if err := rs.ReconcileLeases(ctx, runID); err != nil {
		t.Fatalf("ReconcileLeases: %v", err)
	}
	var status string
	var active int
	if err := f.pool.QueryRow(ctx, `SELECT status FROM attempts WHERE id = $1::uuid`, attemptID).Scan(&status); err != nil {
		t.Fatalf("read the attempt: %v", err)
	}
	if err := f.pool.QueryRow(ctx, `SELECT active_attempts FROM workers WHERE id = $1::uuid`, workerID).Scan(&active); err != nil {
		t.Fatalf("read the worker: %v", err)
	}
	if status != "leased" || active != 1 {
		t.Fatalf("a live lease was touched: attempt %s, active=%d — want leased/1", status, active)
	}
}

// TestExpiredUnstartedLeaseReclaimedAfterWedgedHolder is the lab test:
//
//  1. An external transaction holds the attempt row FOR UPDATE — the wedged
//     BeginAttempt fence that stood between the driver and the row for the
//     lab's entire 85 minutes.
//  2. ReconcileLeases must ANSWER, bounded by PassTimeout: a control-plane
//     pass may fail against a wedged row, it may never join it.
//  3. With the holder gone, the next pass reclaims the expired lease within
//     one bounded pass, and the row lands exactly where ADR-0023 § 11 pass
//     1 says: interrupted{lease_expired}, node ready, worker slot back, and
//     the replacement claim draws a strictly greater fencing token.
func TestExpiredUnstartedLeaseReclaimedAfterWedgedHolder(t *testing.T) {
	ctx := testCtx(t)
	f, store := awSetup(t)
	runID := f.m4QueuedRun(t, ctx, "", 0)
	if _, err := f.pool.Exec(ctx, `UPDATE runs SET plan_snapshot = '{}'::jsonb WHERE id = $1::uuid`, runID); err != nil {
		t.Fatalf("pin an empty plan snapshot: %v", err)
	}
	nodeID, attemptID := f.m4WorkerNode(t, ctx, runID, "/plan")
	workerID := m4Worker(t, ctx, f.pool, "lease-reclaim", 1)
	claims, err := store.ClaimAttempts(ctx, workerID, 1)
	if err != nil || len(claims) != 1 {
		t.Fatalf("claim = (%v, %v), want one attempt", claims, err)
	}
	staleClaim := claims[0]
	if _, err := f.pool.Exec(ctx, `UPDATE node_executions SET in_flight = 1 WHERE id = $1::uuid`, nodeID); err != nil {
		t.Fatalf("record the scheduling in_flight: %v", err)
	}
	// The lease expired the way the lab's did: nobody renewed it.
	if _, err := f.pool.Exec(ctx, `
		UPDATE attempts SET lease_expires_at = now() - interval '30 seconds' WHERE id = $1::uuid`, attemptID); err != nil {
		t.Fatalf("expire the lease: %v", err)
	}

	// (1) The wedged owner's fence: this transaction does nothing but hold
	// the attempt row — precisely what a parked BeginAttempt leaves behind.
	wedge, err := f.pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin wedged fence tx: %v", err)
	}
	if _, err := wedge.Exec(ctx, `SELECT id FROM attempts WHERE id = $1::uuid FOR UPDATE`, attemptID); err != nil {
		_ = wedge.Rollback(ctx)
		t.Fatalf("take the fence lock: %v", err)
	}

	// (2) Bounded under the wedge.
	rs := NewRuntimeStore(f.pool, nil)
	rs.PassTimeout = 300 * time.Millisecond
	done := make(chan error, 1)
	go func() { done <- rs.ReconcileLeases(ctx, runID) }()
	var passErr error
	select {
	case passErr = <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("ReconcileLeases joined the wedged row lock instead of bounding out at PassTimeout — one stuck row freezes the fleet's whole backstop")
	}
	if passErr == nil {
		_ = wedge.Rollback(ctx)
		t.Fatal("ReconcileLeases reported success while its write-back could not have touched the locked row")
	}
	var status string
	if err := f.pool.QueryRow(ctx, `SELECT status FROM attempts WHERE id = $1::uuid`, attemptID).Scan(&status); err != nil {
		t.Fatalf("read the attempt: %v", err)
	}
	if status != "leased" {
		_ = wedge.Rollback(ctx)
		t.Fatalf("the bounded pass wrote %s while its write-back was refused — the pass is not all-or-nothing", status)
	}

	// The wedged worker finally lets go (in the lab: its own bounded begin
	// times out; here: a rollback).
	if err := wedge.Rollback(ctx); err != nil {
		t.Fatalf("release the fence lock: %v", err)
	}

	// (3) One pass reclaims it.
	if err := rs.ReconcileLeases(ctx, runID); err != nil {
		t.Fatalf("ReconcileLeases after the holder let go: %v", err)
	}
	var started bool
	var finished bool
	var errClass string
	if err := f.pool.QueryRow(ctx, `
		SELECT status, started_at IS NOT NULL, finished_at IS NOT NULL, COALESCE(error_class, '')
		FROM attempts WHERE id = $1::uuid`, attemptID).
		Scan(&status, &started, &finished, &errClass); err != nil {
		t.Fatalf("read the reclaimed attempt: %v", err)
	}
	if status != "interrupted" || errClass != "interrupted" {
		t.Fatalf("attempt = (%s, %s), want (interrupted, interrupted)", status, errClass)
	}
	if started {
		t.Errorf("started_at is set on a lease that was reclaimed before BeginAttempt — the ledger would claim work that never started")
	}
	if !finished {
		t.Errorf("finished_at is NULL on a terminal attempt")
	}

	// The node went back to ready with its in_flight released, so the retry
	// has somewhere to land (ADR-0023 § 11 pass 1).
	var nodeStatus string
	var inFlight int
	if err := f.pool.QueryRow(ctx,
		`SELECT status, in_flight FROM node_executions WHERE id = $1::uuid`, nodeID).
		Scan(&nodeStatus, &inFlight); err != nil {
		t.Fatalf("read the node: %v", err)
	}
	if nodeStatus != "ready" || inFlight != 0 {
		t.Fatalf("node = (%s, in_flight=%d), want (ready, 0)", nodeStatus, inFlight)
	}

	// Exit gate C3's measure: the slot came back with the reclaim.
	var active int
	if err := f.pool.QueryRow(ctx,
		`SELECT active_attempts FROM workers WHERE id = $1::uuid`, workerID).Scan(&active); err != nil {
		t.Fatalf("read the worker: %v", err)
	}
	if active != 0 {
		t.Fatalf("active_attempts = %d after the reclaim, want 0", active)
	}

	// The retry path is open and its fence is newer: queue the next attempt
	// and claim it — the replacement claim must draw a strictly greater
	// fencing token than the wedged one (`12` case 3).
	if _, err := store.Runs.QueueAttempt(ctx, NewAttempt{NodeExecutionID: nodeID, AttemptNumber: 2}); err != nil {
		t.Fatalf("queue the retry attempt: %v", err)
	}
	again, err := store.ClaimAttempts(ctx, workerID, 1)
	if err != nil || len(again) != 1 {
		t.Fatalf("retry claim = (%v, %v), want one attempt", again, err)
	}
	if again[0].FencingToken <= staleClaim.FencingToken {
		t.Fatalf("replacement token %d not strictly greater than the wedged claim's %d", again[0].FencingToken, staleClaim.FencingToken)
	}

	// And the stale owner's next word on its dead triple lands NOTHING.
	if err := store.BeginAttempt(ctx, staleClaim); err == nil {
		t.Fatal("the wedged owner's late BeginAttempt wrote on a reclaimed attempt")
	}
}
