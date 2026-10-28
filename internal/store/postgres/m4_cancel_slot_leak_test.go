package postgres

// TestCancelSlot*: exit gate C9a against a real Postgres — a worker's
// active_attempts must equal the ledger of that worker's non-terminal
// attempts after EVERY step of a cancel cascade, not just at rest.
//
// The m4 acceptance (accept/20261027-180007-6641071, C9a after C8g's
// mid-fan-out cancel) found worker-a with active_attempts=1 while
// attempts_by_status read all-zero: one attempt reached a terminal state
// without releasing its slot. The leak is a race, not a missing arm: the
// cancel cascade is an engine pass (lock run -> hydrate -> advance ->
// write back), and RunStore.ClaimAttempts never takes the run lock. An
// attempt that is `queued` in the pass's hydration snapshot can be claimed
// (+1 slot, worker_id stamped) before the pass's write-back lands; the
// write-back then terminalises the row from its stale snapshot and NULLs
// the worker_id the claim wrote, so the diff-based release — which joins
// the attempt row it just overwrote — matches no worker and releases
// nothing. The owner's fenced close is refused (the row is terminal), so
// nobody ever gives the slot back. The mirror interleaving (the owner's
// FinishAttempt lands between hydrate and write-back) releases a slot the
// pass still believes is live: a double release that the `active_attempts
// > 0` backstop only hides by stealing a DIFFERENT live attempt's slot.
//
// The invariant under test: release rides the transaction that makes the
// attempt terminal, keyed on the LIVE row's (status, worker_id), exactly
// once — whichever of the two writers lands first.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dbirks/communication/internal/api"
	"github.com/dbirks/communication/internal/pipelines/runtime"
	"github.com/dbirks/communication/internal/worker"
)

// assertSlotsMatchLedger is the C9a invariant for the named workers:
// workers.active_attempts equals the count of that worker's non-terminal
// (queued/leased/running) attempts. Call it after every step of an
// attempt/cancel/reconcile scenario, never only at the end: active_attempts
// > ledger is a leaked slot (the worker's capacity is muted until it
// re-registers), active_attempts < ledger is a double release (it steals
// capacity from live work and the `> 0` backstop lets it go silently
// negative against the ledger).
func assertSlotsMatchLedger(t *testing.T, ctx context.Context, pool *pgxpool.Pool, step string, workerIDs ...string) {
	t.Helper()
	for _, id := range workerIDs {
		var active, ledger int
		if err := pool.QueryRow(ctx,
			`SELECT active_attempts FROM workers WHERE id = $1::uuid`, id).Scan(&active); err != nil {
			t.Fatalf("after %s: read active_attempts for worker %s: %v", step, id, err)
		}
		if err := pool.QueryRow(ctx, `
			SELECT count(*) FROM attempts
			WHERE worker_id = $1::uuid AND status IN ('queued', 'leased', 'running')`, id).
			Scan(&ledger); err != nil {
			t.Fatalf("after %s: read the live-attempt ledger for worker %s: %v", step, id, err)
		}
		if active != ledger {
			verdict := "slot LEAK: a terminal attempt never gave its slot back"
			if active < ledger {
				verdict = "slot UNDERFLOW: a double release stole a live attempt's slot"
			}
			t.Fatalf("after %s: worker %s active_attempts=%d but ledger of live attempts=%d — %s",
				step, id, active, ledger, verdict)
		}
	}
}

// cancelSlotFixture is one published probe pipeline, one driver-shaped
// RuntimeStore, one registered worker, and runs created on demand — each in
// the state the real deployment reaches after one advance: /plan ready with
// one queued attempt.
type cancelSlotFixture struct {
	f            *m4Fixture
	runs         *RunStore
	store        *AttemptStore
	rt           *RuntimeStore
	runAPI       APIRunStore
	caller       api.Caller
	workerID     string
	assignmentID string
	created      int
}

func cancelSlotSetup(t *testing.T) *cancelSlotFixture {
	t.Helper()
	ctx := testCtx(t)
	f := m4Setup(t)
	_, planJSON := m4LifecyclePlan(t)
	pipelineID, revisionID := m4LifecyclePublished(t, f, planJSON)
	x := &cancelSlotFixture{
		f:      f,
		runs:   &RunStore{Pool: f.pool, LeaseTTL: 2 * time.Second},
		caller: api.Caller{UserID: f.userID, OrganizationID: f.orgID, IsOrgAdmin: true},
	}
	as, err := APIAssignmentStore{S: f.pipelines}.CreateAssignment(ctx, x.caller, f.projectID,
		api.AssignmentCreateInput{PipelineID: pipelineID, PinnedRevisionID: revisionID,
			MaxConcurrentRuns: 4})
	if err != nil {
		t.Fatalf("CreateAssignment: %v", err)
	}
	x.assignmentID = as.ID
	children := &M4Children{Runs: x.runs}
	x.rt = NewRuntimeStore(f.pool, &runtime.Advancer{Deps: runtime.AdvancerDeps{Children: children}})
	children.Runtime = x.rt
	x.runAPI = APIRunStore{Runs: x.runs, Runtime: x.rt}
	x.store = &AttemptStore{Runs: x.runs}
	x.workerID = m4Worker(t, ctx, f.pool, "cancel-slot", 4)
	return x
}

// newRun creates one running probe run and advances it until /plan's attempt
// is queued and claimable (the pre-cancel state of C8g's child runs).
func (x *cancelSlotFixture) newRun(t *testing.T, ctx context.Context) string {
	t.Helper()
	x.created++
	f := x.f
	key := fmt.Sprintf("cancel-slot-%s-%d", migFixtureToken(t), x.created)
	view, created, err := x.runAPI.CreateRun(ctx, x.caller, api.RunCreateInput{
		ProjectID: f.projectID, AssignmentID: x.assignmentID,
		Inputs: map[string]json.RawMessage{
			"goal":                json.RawMessage(`"leak a slot on the cancel cascade"`),
			"repository":          json.RawMessage(`"repo-a"`),
			"acceptance_criteria": json.RawMessage(`"tests pass"`),
			"fanout":              json.RawMessage(`false`),
			"fanout_count":        json.RawMessage(`0`),
		},
		Key:         key,
		RequestSHA:  m4Hex("body/" + key),
		TriggeredBy: f.userID,
	})
	if err != nil || !created {
		t.Fatalf("CreateRun = (%v, %v)", created, err)
	}
	if err := x.rt.Advance(ctx, view.ID); err != nil {
		t.Fatalf("advance: %v", err)
	}
	if n := cancelSlotCount(t, ctx, f.pool,
		`SELECT count(*) FROM attempts WHERE run_id = $1::uuid AND status = 'queued'`, view.ID); n != 1 {
		t.Fatalf("fresh run has %d queued attempts, want 1 (/plan)", n)
	}
	return view.ID
}

func cancelSlotCount(t *testing.T, ctx context.Context, pool *pgxpool.Pool, query string, args ...any) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(ctx, query, args...).Scan(&n); err != nil {
		t.Fatalf("count (%s): %v", query, err)
	}
	return n
}

func cancelSlotRow(t *testing.T, ctx context.Context, pool *pgxpool.Pool, query string, args ...any) string {
	t.Helper()
	var s string
	if err := pool.QueryRow(ctx, query, args...).Scan(&s); err != nil {
		t.Fatalf("query (%s): %v", query, err)
	}
	return s
}

// TestCancelSlotQueuedAttemptCancelsCleanly is the no-race arm: the cascade
// terminalises a never-claimed (queued) attempt, which held no slot, and the
// invariant holds trivially.
func TestCancelSlotQueuedAttemptCancelsCleanly(t *testing.T) {
	ctx := testCtx(t)
	x := cancelSlotSetup(t)
	runID := x.newRun(t, ctx)
	if _, err := x.runAPI.CancelRun(ctx, x.caller, runID); err != nil {
		t.Fatalf("CancelRun: %v", err)
	}
	if err := x.rt.Advance(ctx, runID); err != nil {
		t.Fatalf("advance the cancel: %v", err)
	}
	assertSlotsMatchLedger(t, ctx, x.f.pool, "queued cascade", x.workerID)
	if st := cancelSlotRow(t, ctx, x.f.pool,
		`SELECT status FROM runs WHERE id = $1::uuid`, runID); st != "cancelled" {
		t.Fatalf("run = %s, want cancelled", st)
	}
	if n := cancelSlotCount(t, ctx, x.f.pool, `
		SELECT count(*) FROM attempts WHERE run_id = $1::uuid
		  AND status = 'cancelled'`, runID); n != 1 {
		t.Fatalf("%d cancelled attempts, want 1 (before_claim)", n)
	}
}

// TestCancelSlotClaimedDuringCancelPass is the C9a reproduction. The
// production claim (RunStore.ClaimAttempts, the SQL the worker loop rides)
// lands between the cancel pass's hydrate and its write-back — exactly the
// interleaving a 25-way fan-out cancel hits sometimes. The pass terminalises
// the row it still believes is queued; the slot the claim paid must ride
// that same transaction back.
func TestCancelSlotClaimedDuringCancelPass(t *testing.T) {
	ctx := testCtx(t)
	x := cancelSlotSetup(t)
	runID := x.newRun(t, ctx)
	attemptID := cancelSlotRow(t, ctx, x.f.pool,
		`SELECT id::text FROM attempts WHERE run_id = $1::uuid AND status = 'queued'`, runID)
	assertSlotsMatchLedger(t, ctx, x.f.pool, "fresh run", x.workerID)

	if _, err := x.runAPI.CancelRun(ctx, x.caller, runID); err != nil {
		t.Fatalf("CancelRun: %v", err)
	}

	var claim *AttemptClaim
	err := x.rt.Transact(ctx, runID, func(*runtime.Tx) error {
		// Inside the settle pass, AFTER its hydrate and BEFORE its write-back:
		// the run row is still 'running' to this second connection, so the
		// claim wins the attempt the pass has already snapshotted as queued.
		// This is the raw RunStore claim — the exact SQL the worker loop rides
		// (the AttemptStore wrapper's binding-resolution bump writes the run
		// row after its commit, which no pass can overlap).
		claims, cerr := x.runs.ClaimAttempts(ctx, x.workerID, 4)
		if cerr != nil {
			return cerr
		}
		if len(claims) == 1 {
			c := claims[0]
			claim = &c
		}
		return nil
	})
	if err != nil {
		t.Fatalf("cancel pass: %v", err)
	}
	if claim == nil || claim.AttemptID != attemptID {
		t.Fatalf("mid-pass claim won %+v, want the run's one queued attempt %s — "+
			"the race window was not exercised", claim, attemptID)
	}
	// The pass's write-back closed the row it snapshotted as queued.
	if st := cancelSlotRow(t, ctx, x.f.pool,
		`SELECT status FROM attempts WHERE id = $1::uuid`, attemptID); st != "cancelled" {
		t.Fatalf("mid-pass attempt = %s, want cancelled by the cascade", st)
	}
	if st := cancelSlotRow(t, ctx, x.f.pool,
		`SELECT status FROM runs WHERE id = $1::uuid`, runID); st != "cancelled" {
		t.Fatalf("run = %s, want cancelled", st)
	}
	// C9a, right here: the claim's slot must have come back in the
	// transaction that cancelled the attempt.
	assertSlotsMatchLedger(t, ctx, x.f.pool, "mid-pass cancel", x.workerID)

	// The stale owner's own terminal write is refused by the fence and must
	// release nothing a second time.
	if err := x.runs.FinishAttempt(ctx, *claim, AttemptFinish{
		Status: "cancelled", ErrorClass: "cancelled", NodeStatus: "cancelled",
	}); !errors.Is(err, ErrLeaseLost) {
		t.Fatalf("FinishAttempt after the cascade = %v, want ErrLeaseLost", err)
	}
	assertSlotsMatchLedger(t, ctx, x.f.pool, "refused owner close", x.workerID)
}

// TestCancelSlotLeasedNotStarted covers the ordinary leased-at cancel: the
// pass leaves a live attempt to its owner (slot held, ledger agrees), and
// the owner's cancelled write is what returns the slot.
func TestCancelSlotLeasedNotStarted(t *testing.T) {
	ctx := testCtx(t)
	x := cancelSlotSetup(t)
	runID := x.newRun(t, ctx)
	claims, err := x.store.ClaimAttempts(ctx, x.workerID, 4)
	if err != nil || len(claims) != 1 {
		t.Fatalf("claim = (%d, %v), want one", len(claims), err)
	}
	assertSlotsMatchLedger(t, ctx, x.f.pool, "claim", x.workerID)

	if _, err := x.runAPI.CancelRun(ctx, x.caller, runID); err != nil {
		t.Fatalf("CancelRun: %v", err)
	}
	if err := x.rt.Advance(ctx, runID); err != nil {
		t.Fatalf("advance the cancel: %v", err)
	}
	// Still owned, still one slot — a cancel request is not a terminal.
	assertSlotsMatchLedger(t, ctx, x.f.pool, "cancel over a leased attempt", x.workerID)

	if err := x.store.CancelAttemptOwn(ctx, claims[0], worker.CancelReasonProcessTerminated); err != nil {
		t.Fatalf("CancelAttemptOwn: %v", err)
	}
	assertSlotsMatchLedger(t, ctx, x.f.pool, "owner's cancelled write", x.workerID)
	if err := x.rt.Advance(ctx, runID); err != nil {
		t.Fatalf("advance after the close: %v", err)
	}
	if st := cancelSlotRow(t, ctx, x.f.pool,
		`SELECT status FROM runs WHERE id = $1::uuid`, runID); st != "cancelled" {
		t.Fatalf("run = %s, want cancelled", st)
	}
	assertSlotsMatchLedger(t, ctx, x.f.pool, "run cancelled", x.workerID)
}

// TestCancelSlotRunning is the same invariant with the attempt already
// running (BeginAttempt crossed the leased->running boundary; the slot
// belongs to the attempt, not to the transition).
func TestCancelSlotRunning(t *testing.T) {
	ctx := testCtx(t)
	x := cancelSlotSetup(t)
	runID := x.newRun(t, ctx)
	claims, err := x.store.ClaimAttempts(ctx, x.workerID, 4)
	if err != nil || len(claims) != 1 {
		t.Fatalf("claim = (%d, %v), want one", len(claims), err)
	}
	if err := x.store.BeginAttempt(ctx, claims[0]); err != nil {
		t.Fatalf("BeginAttempt: %v", err)
	}
	if _, err := x.runAPI.CancelRun(ctx, x.caller, runID); err != nil {
		t.Fatalf("CancelRun: %v", err)
	}
	if err := x.rt.Advance(ctx, runID); err != nil {
		t.Fatalf("advance the cancel: %v", err)
	}
	assertSlotsMatchLedger(t, ctx, x.f.pool, "cancel over a running attempt", x.workerID)
	if err := x.store.CancelAttemptOwn(ctx, claims[0], worker.CancelReasonACPAck); err != nil {
		t.Fatalf("CancelAttemptOwn: %v", err)
	}
	assertSlotsMatchLedger(t, ctx, x.f.pool, "running attempt closed", x.workerID)
}

// TestCancelSlotDoubleTerminalReleasesOnce is the mirror interleaving: the
// pass hydrates the attempt LEASED (its lease expired), and the owner's
// fenced terminal write lands between the pass's hydrate and its write-back
// — same transaction pair as the leak, opposite winner. The owner's commit
// already released the slot; the pass's diff (leased→interrupted, worker_id
// re-stamped from its own snapshot) must NOT release a second time, because
// the second decrement is charged to whatever slot the worker holds NEXT:
// here a legitimately live claim on a second run. That is the double release
// the `active_attempts > 0` backstop hides only when the worker happens to
// be at zero.
func TestCancelSlotDoubleTerminalReleasesOnce(t *testing.T) {
	ctx := testCtx(t)
	x := cancelSlotSetup(t)
	reclaimed := x.newRun(t, ctx)
	holder := x.newRun(t, ctx)

	claims, err := x.store.ClaimAttempts(ctx, x.workerID, 4)
	if err != nil || len(claims) != 2 {
		t.Fatalf("claim = (%d, %v), want the two queued attempts", len(claims), err)
	}
	var victim, kept worker.AttemptClaim
	for _, c := range claims {
		if c.RunID == reclaimed {
			victim = c
		} else {
			kept = c
		}
	}
	if victim.AttemptID == "" || kept.AttemptID == "" || victim.RunID != reclaimed || kept.RunID != holder {
		t.Fatalf("claims do not split across the two runs: %+v", claims)
	}
	assertSlotsMatchLedger(t, ctx, x.f.pool, "two claims", x.workerID) // 2 == 2

	// The reclaimed run's lease is past (the dead-owner shape the reconciler
	// pass exists for); the other claim stays healthy and is the slot a
	// double release would steal.
	if _, err := x.f.pool.Exec(ctx,
		`UPDATE attempts SET lease_expires_at = now() - interval '30 seconds' WHERE id = $1::uuid`,
		victim.AttemptID); err != nil {
		t.Fatalf("expire the victim lease: %v", err)
	}

	// The owner is not dead after all: its boundary write commits AFTER the
	// pass hydrated and BEFORE its write-back — fired on the pass's own
	// clock read, the seam between those two halves.
	realNow := x.rt.Now
	fired := false
	x.rt.Now = func() time.Time {
		if !fired {
			fired = true
			if err := x.store.FailAttempt(ctx, victim, worker.ErrorClassAgentError, "closed mid-pass", nil); err != nil {
				t.Errorf("mid-pass FailAttempt: %v", err)
			}
		}
		return realNow()
	}
	err = x.rt.ReconcileLeases(ctx, reclaimed)
	x.rt.Now = realNow
	if err != nil {
		t.Fatalf("ReconcileLeases: %v", err)
	}
	if !fired {
		t.Fatal("the reconcile pass never read the clock — the interleaving was not exercised")
	}
	// The pass must see the owner's terminal and release nothing: the
	// holder's live claim keeps exactly its one slot.
	assertSlotsMatchLedger(t, ctx, x.f.pool, "mid-pass owner terminal + lease reclaim", x.workerID)

	// Wind the holder run down cleanly.
	if _, err := x.runAPI.CancelRun(ctx, x.caller, holder); err != nil {
		t.Fatalf("CancelRun (holder): %v", err)
	}
	if err := x.rt.Advance(ctx, holder); err != nil {
		t.Fatalf("advance (holder): %v", err)
	}
	if err := x.store.CancelAttemptOwn(ctx, kept, worker.CancelReasonACPAck); err != nil {
		t.Fatalf("close the holder's attempt: %v", err)
	}
	assertSlotsMatchLedger(t, ctx, x.f.pool, "everything terminal", x.workerID)
}
