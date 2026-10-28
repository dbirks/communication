package postgres

// Worker capacity release on a REAL Postgres 18 (docs/m4-contract.md § 4 step
// 1, exit gates C3/C9a). A claim takes one slot on workers.active_attempts;
// ONLY the attempt's terminal write gives it back — in the SAME transaction,
// exactly once. The M4 lab found worker-b pinned at active_attempts=1 with no
// non-terminal attempt to show for it: the decrement lived on the worker's own
// boundary commit alone, so every OTHER terminalization (the reconciler's
// lease interrupt, a run cancel, a human takeover's hand-off, a control-plane
// fail) muted the claim predicate `wr.active_attempts < wr.capacity` forever.
// These tests drive each of those paths end to end and read the ledger.

import (
	"context"
	"errors"
	"testing"

	"github.com/dbirks/communication/internal/worker"
)

// arWorkerName is the m4Worker tag every test in this file registers under.
const arWorkerName = "active-release"

// arSetup seeds a live run with one ready worker node and its queued attempt,
// then claims it through the WORKER store (§ 4 step 3) and starts it. The run
// pins an empty plan snapshot ('{}'), so the RuntimeStore's per-transaction
// advancer is deliberately absent: these tests observe one named engine pass,
// never an unrelated re-schedule. Returns the fixture, the attempt store, the
// claim triple, the runtime store the control-plane paths run through, and the
// node/attempt ids.
func arSetup(t *testing.T) (*m4Fixture, *AttemptStore, *RuntimeStore, worker.AttemptClaim, string, string, string) {
	t.Helper()
	ctx := testCtx(t)
	f, store := awSetup(t)
	runID := f.m4QueuedRun(t, ctx, "", 0)
	if _, err := f.pool.Exec(ctx, `UPDATE runs SET plan_snapshot = '{}'::jsonb WHERE id = $1::uuid`, runID); err != nil {
		t.Fatalf("pin an empty plan snapshot: %v", err)
	}
	nodeID, attemptID := f.m4WorkerNode(t, ctx, runID, "/implement")
	workerID := m4Worker(t, ctx, f.pool, arWorkerName, 1)

	claims, err := store.ClaimAttempts(ctx, workerID, 1)
	if err != nil || len(claims) != 1 {
		t.Fatalf("claim = (%v, %v), want one attempt", claims, err)
	}
	if err := store.BeginAttempt(ctx, claims[0]); err != nil {
		t.Fatalf("BeginAttempt: %v", err)
	}
	// The claim above is the worker store's; the node row's engine-owned
	// bookkeeping is what RuntimeStore.Claim would have moved in a real
	// deployment (same honesty as m4TakeoverAttempt).
	if _, err := f.pool.Exec(ctx, `
		UPDATE node_executions SET status = 'running', in_flight = 1 WHERE id = $1::uuid`, nodeID); err != nil {
		t.Fatalf("record the claim on the node row: %v", err)
	}
	return f, store, NewRuntimeStore(f.pool, nil), claims[0], nodeID, attemptID, workerID
}

// arActive reads the worker's accounting column.
func arActive(t *testing.T, ctx context.Context, f *m4Fixture, workerID string) int {
	t.Helper()
	var n int
	if err := f.pool.QueryRow(ctx,
		`SELECT active_attempts FROM workers WHERE id = $1::uuid`, workerID).Scan(&n); err != nil {
		t.Fatalf("read active_attempts: %v", err)
	}
	return n
}

// arLedger is exit gate C3's measure for one worker: the attempts that still
// hold a slot (non-terminal and owned — a queued attempt is unowned by
// construction and holds nothing).
func arLedger(t *testing.T, ctx context.Context, f *m4Fixture, workerID string) int {
	t.Helper()
	var n int
	if err := f.pool.QueryRow(ctx, `
		SELECT count(*) FROM attempts
		WHERE worker_id = $1::uuid AND status IN ('queued', 'leased', 'running')`, workerID).Scan(&n); err != nil {
		t.Fatalf("read the non-terminal attempt ledger: %v", err)
	}
	return n
}

// arGate asserts C3/C9a for one worker: the column equals the ledger, and never
// goes negative (the workers active_attempts CHECK would refuse it anyway). The
// match itself runs through assertSlotsMatchLedger — the same C9a invariant the
// cancel-cascade race tests check after every step.
func arGate(t *testing.T, ctx context.Context, f *m4Fixture, workerID string, want int) {
	t.Helper()
	assertSlotsMatchLedger(t, ctx, f.pool, t.Name()+" gate", workerID)
	active, ledger := arActive(t, ctx, f, workerID), arLedger(t, ctx, f, workerID)
	if active != want || ledger != want {
		t.Fatalf("worker gate: active_attempts = %d, non-terminal ledger = %d, want both %d",
			active, ledger, want)
	}
}

// arRow reads one scalar as text.
func arRow(t *testing.T, ctx context.Context, f *m4Fixture, query string, args ...any) string {
	t.Helper()
	var s string
	if err := f.pool.QueryRow(ctx, query, args...).Scan(&s); err != nil {
		t.Fatalf("query %q: %v", query, err)
	}
	return s
}

// arExpireLease pushes the claimed attempt's lease into the past, which is what
// a worker that died without renewing leaves behind.
func arExpireLease(t *testing.T, ctx context.Context, f *m4Fixture, attemptID string) {
	t.Helper()
	if _, err := f.pool.Exec(ctx, `
		UPDATE attempts SET lease_expires_at = now() - interval '30 seconds' WHERE id = $1::uuid`,
		attemptID); err != nil {
		t.Fatalf("expire the lease: %v", err)
	}
}

// TestActiveReleaseLeaseExpiryInterrupt is the M4 lab failure in miniature: the
// reconciler's pass 1 ends a dead owner's attempt, and the worker must be
// claimable again the moment that row is terminal. Before the fix the attempt
// went 'interrupted' and worker-b kept its active_attempts=1 forever.
func TestActiveReleaseLeaseExpiryInterrupt(t *testing.T) {
	ctx := testCtx(t)
	f, store, rs, claim, nodeID, attemptID, workerID := arSetup(t)
	arGate(t, ctx, f, workerID, 1)

	arExpireLease(t, ctx, f, attemptID)
	if err := rs.ReconcileLeases(ctx, claim.RunID); err != nil {
		t.Fatalf("ReconcileLeases: %v", err)
	}

	var status, class string
	if err := f.pool.QueryRow(ctx,
		`SELECT status, COALESCE(error_class, '') FROM attempts WHERE id = $1::uuid`, attemptID).
		Scan(&status, &class); err != nil {
		t.Fatalf("read the attempt: %v", err)
	}
	if status != "interrupted" || class != "interrupted" {
		t.Fatalf("attempt = (%s, %s), want (interrupted, interrupted)", status, class)
	}
	// The release rode in the SAME transaction as the status write.
	arGate(t, ctx, f, workerID, 0)

	// And the slot was the only thing muting the worker: a fresh attempt is
	// claimable immediately (exit gate C3's operational consequence).
	if _, err := f.runs.QueueAttempt(ctx, NewAttempt{NodeExecutionID: nodeID, AttemptNumber: 2}); err != nil {
		t.Fatalf("queue the retry attempt: %v", err)
	}
	claims, err := store.ClaimAttempts(ctx, workerID, 1)
	if err != nil {
		t.Fatalf("re-claim: %v", err)
	}
	if len(claims) != 1 {
		t.Fatalf("re-claim won %d attempts after the interrupt released the slot, want 1", len(claims))
	}
	arGate(t, ctx, f, workerID, 1)
}

// TestActiveReleaseRunCancel walks § 4 step 11's two writers: the control plane
// may only REQUEST a cancel on a live attempt (its owner still holds the slot
// and the ledger says so), and the owner's terminal write is what gives the
// capacity back.
func TestActiveReleaseRunCancel(t *testing.T) {
	ctx := testCtx(t)
	f, store, _, claim, nodeID, _, workerID := arSetup(t)
	arGate(t, ctx, f, workerID, 1)

	if _, err := f.runs.RequestCancel(ctx, claim.RunID, nil); err != nil {
		t.Fatalf("RequestCancel: %v", err)
	}
	if at := func() string {
		var s string
		if err := f.pool.QueryRow(ctx,
			`SELECT COALESCE(cancel_requested_at::text, '') FROM attempts WHERE id = $1::uuid`,
			claim.AttemptID).Scan(&s); err != nil {
			t.Fatalf("read the attempt: %v", err)
		}
		return s
	}(); at != "" {
		t.Fatalf("the control plane wrote the cancel flag on the attempt row (%s); the advancer owns that column", at)
	}
	// A cancel request is not a terminal: the attempt still occupies its slot.
	arGate(t, ctx, f, workerID, 1)

	if err := store.CancelAttemptOwn(ctx, claim, worker.CancelReasonACPAck); err != nil {
		t.Fatalf("CancelAttemptOwn: %v", err)
	}
	arGate(t, ctx, f, workerID, 0)

	// The cancelled attempt's own node went 'cancelled' with it, so it is not
	// re-claimable — but the WORKER is: a ready node elsewhere on the run takes
	// the released slot immediately. That is the difference between a capacity
	// leak and a scheduling decision.
	if st := arRow(t, ctx, f, `SELECT status FROM node_executions WHERE id = $1::uuid`, nodeID); st != "cancelled" {
		t.Fatalf("the cancelled attempt left its node %s, want cancelled", st)
	}
	f.m4WorkerNode(t, ctx, claim.RunID, "/publish")
	claims, err := store.ClaimAttempts(ctx, workerID, 1)
	if err != nil || len(claims) != 1 {
		t.Fatalf("re-claim after cancel = (%d claims, %v), want 1", len(claims), err)
	}
	arGate(t, ctx, f, workerID, 1)
}

// TestActiveReleaseTakeoverHandoff is § 5.3's other terminal writer: a human's
// TakeControl closes the run attempt inside the CONVERSATION transaction, which
// is neither RunStore.FinishAttempt nor the worker — the hand-off that leaked a
// slot before this helper existed.
func TestActiveReleaseTakeoverHandoff(t *testing.T) {
	ctx := testCtx(t)
	f, _, _, claim, conversationID, _ := m4TakeoverAttempt(t)
	workerID := m4TakeoverRow(t, f,
		`SELECT worker_id::text FROM attempts WHERE id = $1::uuid`, claim.AttemptID)
	arGate(t, ctx, f, workerID, 1)

	var version int
	if err := f.pool.QueryRow(ctx,
		`SELECT version FROM conversation_control WHERE conversation_id = $1::uuid`, conversationID).
		Scan(&version); err != nil {
		t.Fatalf("read control version: %v", err)
	}
	cnv := &CnvStore{Pool: f.pool}
	caller := Caller{UserID: f.userID, OrganizationID: f.orgID, IsOrgAdmin: true}
	if _, err := cnv.TakeControl(ctx, caller, conversationID, version); err != nil {
		t.Fatalf("TakeControl: %v", err)
	}
	if st := m4TakeoverRow(t, f,
		`SELECT status FROM attempts WHERE id = $1::uuid`, claim.AttemptID); st != "interrupted" {
		t.Fatalf("takeover left the attempt %s, want interrupted", st)
	}
	arGate(t, ctx, f, workerID, 0)
}

// TestActiveReleaseDoubleTransitionIsOneRelease pins the exactly-once half: a
// second pass, a stale owner's terminal write and a repeated interrupt attempt
// all give back nothing, and the `> 0` backstop keeps a mis-call from driving
// the column under the ledger.
func TestActiveReleaseDoubleTransitionIsOneRelease(t *testing.T) {
	ctx := testCtx(t)
	f, store, rs, claim, _, attemptID, workerID := arSetup(t)
	arGate(t, ctx, f, workerID, 1)

	arExpireLease(t, ctx, f, attemptID)
	if err := rs.ReconcileLeases(ctx, claim.RunID); err != nil {
		t.Fatalf("ReconcileLeases: %v", err)
	}
	arGate(t, ctx, f, workerID, 0)

	// Pass 1 again over an already-terminal row: it selects live attempts only,
	// so it writes nothing and releases nothing.
	for i := 0; i < 3; i++ {
		if err := rs.ReconcileLeases(ctx, claim.RunID); err != nil {
			t.Fatalf("second reconciler pass %d: %v", i, err)
		}
		if err := rs.Advance(ctx, claim.RunID); err != nil {
			t.Fatalf("advance after pass %d: %v", i, err)
		}
	}
	// The dead owner's own boundary write is REFUSED by the fence — a silent
	// accept would have been the double decrement.
	if err := store.InterruptAttemptOwn(ctx, claim, worker.InterruptReasonWorkerShutdown); !errors.Is(err, worker.ErrLeaseLost) {
		t.Fatalf("InterruptAttemptOwn on a terminal attempt = %v, want ErrLeaseLost", err)
	}
	if err := store.Runs.FinishAttempt(ctx, workerClaim(claim), AttemptFinish{Status: "cancelled", ErrorClass: "cancelled"}); !errors.Is(err, ErrLeaseLost) {
		t.Fatalf("FinishAttempt on a terminal attempt = %v, want ErrLeaseLost", err)
	}
	arGate(t, ctx, f, workerID, 0)

	// The backstop, measured inside one transaction: two releases for one
	// attempt leave the column at zero rather than -1.
	tx, err := f.pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	for i := 0; i < 2; i++ {
		if err := releaseWorkerSlotTx(ctx, tx, attemptID); err != nil {
			t.Fatalf("releaseWorkerSlotTx #%d: %v", i, err)
		}
	}
	var doubled int
	if err := tx.QueryRow(ctx,
		`SELECT active_attempts FROM workers WHERE id = $1::uuid`, workerID).Scan(&doubled); err != nil {
		t.Fatalf("read the double-released column: %v", err)
	}
	if doubled != 0 {
		t.Fatalf("two releases left active_attempts = %d, want the > 0 guard to hold it at 0", doubled)
	}
}
