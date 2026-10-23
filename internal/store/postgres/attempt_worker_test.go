package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dbirks/communication/internal/worker"
)

// The worker-facing attempt port on a REAL Postgres 18 that ran 00005. A
// mocked green unit test never substitutes for these (`12-test-strategy.md`):
// the single fencing draw, the SKIP-LOCKED hand-out under two racing
// claimers (`12` case 2), the stale writer landing NOTHING (`12` case 3),
// and the killed owner's honest close with its late-success refusal
// (`12` case 5's fence half) are all statements about THIS database.

// awSetup wires the m4 fixture plus the adapter under test.
func awSetup(t *testing.T) (*m4Fixture, *AttemptStore) {
	t.Helper()
	f := m4Setup(t)
	return f, &AttemptStore{Runs: &RunStore{Pool: f.pool, LeaseTTL: 2 * time.Second}}
}

// awSeqValue counts how many times attempt_fencing_seq has ACTUALLY been
// drawn. Bare `last_value` is not a legal draw-counter at boot: a freshly
// created Postgres 18 sequence reports (last_value=1, is_called=false), and
// the first nextval returns exactly 1 while flipping is_called — so a bare
// read says "1→1" both when nothing was drawn and when the very first draw
// just happened. On a pristine database that mis-read made a correct +1
// claim look like +0 (the historical false-failure) and would equally let a
// guard-leaking empty claim pass unseen. The unstarted placeholder is the
// one value that has not been spent, so it is subtracted: with this helper
// the first honest nextval still counts as exactly one draw.
func awSeqValue(t *testing.T, ctx context.Context, f *m4Fixture) int64 {
	t.Helper()
	var v int64
	var called bool
	if err := f.pool.QueryRow(ctx, `SELECT last_value, is_called FROM attempt_fencing_seq`).Scan(&v, &called); err != nil {
		t.Fatalf("read attempt_fencing_seq: %v", err)
	}
	if !called {
		v--
	}
	return v
}

func awCount(t *testing.T, ctx context.Context, f *m4Fixture, query string, args ...any) int {
	t.Helper()
	var n int
	if err := f.pool.QueryRow(ctx, query, args...).Scan(&n); err != nil {
		t.Fatalf("count (%s): %v", query, err)
	}
	return n
}

// TestAttemptWorkerSingleFencingDrawPerClaim proves the claim SQL draws
// attempt_fencing_seq ONCE for a whole batch, not once per row: three
// attempts, one claim, one number, three holders of the same token, and the
// sequence advanced by exactly one. The MATERIALIZED guard is also proven
// from the other side: an empty claim spends nothing. The empty claim runs
// FIRST, before any attempt is seeded, so it meets the sequence in its
// pristine (last_value=1, is_called=false) placeholder — the one state a
// bare-last_value counter misreads, and the regression lock for the
// historical boot false-failure.
func TestAttemptWorkerSingleFencingDrawPerClaim(t *testing.T) {
	ctx := testCtx(t)
	f, store := awSetup(t)
	runID := f.m4QueuedRun(t, ctx, "", 0)
	workerID := m4Worker(t, ctx, f.pool, "draw", 3)

	// An empty claim (nothing is queued yet) must spend NOTHING: this is
	// what keeps max(fencing_token) == claim count observable in § 7 C3c,
	// and on a virgin database it is the first draw-counter read there is.
	emptyBefore := awSeqValue(t, ctx, f)
	if claims, err := store.ClaimAttempts(ctx, workerID, 3); err != nil || len(claims) != 0 {
		t.Fatalf("claim over an empty queue = (%d claims, %v), want none", len(claims), err)
	}
	if after := awSeqValue(t, ctx, f); after != emptyBefore {
		t.Fatalf("an empty claim drew the sequence %d→%d; the guard is the draw's only other word", emptyBefore, after)
	}

	for _, key := range []string{"/one", "/two", "/three"} {
		f.m4WorkerNode(t, ctx, runID, key)
	}
	before := awSeqValue(t, ctx, f)
	claims, err := store.ClaimAttempts(ctx, workerID, 3)
	if err != nil {
		t.Fatalf("ClaimAttempts: %v", err)
	}
	if len(claims) != 3 {
		t.Fatalf("claimed %d attempts, want the whole batch of 3", len(claims))
	}
	token := claims[0].FencingToken
	for _, c := range claims[1:] {
		if c.FencingToken != token {
			t.Fatalf("batch tokens %d/%d differ: one claim must draw ONE token (§ 4 step 2)", token, c.FencingToken)
		}
	}
	if after := awSeqValue(t, ctx, f); after != before+1 {
		t.Fatalf("attempt_fencing_seq moved %d→%d, want exactly +1 for one claim", before, after)
	}
	// And the capacity accounting rode in the same transaction (§ 4 step 1).
	var active int
	if err := f.pool.QueryRow(ctx, `SELECT active_attempts FROM workers WHERE id = $1::uuid`, workerID).Scan(&active); err != nil {
		t.Fatal(err)
	}
	if active != 3 {
		t.Errorf("active_attempts = %d after a 3-batch claim, want 3", active)
	}
}

// TestAttemptWorkerConcurrentClaimsOneLeaseEach is `12` case 2 through the
// adapter: two workers racing for one queue hand each attempt to exactly one
// owner — never both, never zero — and each claim carries its own token.
func TestAttemptWorkerConcurrentClaimsOneLeaseEach(t *testing.T) {
	ctx := testCtx(t)
	f, store := awSetup(t)
	runID := f.m4QueuedRun(t, ctx, "", 0)
	var wanted []string
	for _, key := range []string{"/a", "/b", "/c", "/d"} {
		_, att := f.m4WorkerNode(t, ctx, runID, key)
		wanted = append(wanted, att)
	}
	w1 := m4Worker(t, ctx, f.pool, "race-1", 2)
	w2 := m4Worker(t, ctx, f.pool, "race-2", 2)
	// Two pools so both claims truly run concurrently (one pool with two
	// conns would too, but two pools make the race un-optimizable).
	pool2, err := Open(ctx, mustMigrate(t))
	if err != nil {
		t.Fatalf("second pool: %v", err)
	}
	t.Cleanup(pool2.Close)
	store2 := &AttemptStore{Runs: &RunStore{Pool: pool2, LeaseTTL: 2 * time.Second}}

	start := make(chan struct{})
	var mu sync.Mutex
	type outcome struct {
		claims []worker.AttemptClaim
		err    error
	}
	results := make([]outcome, 2)
	var wg sync.WaitGroup
	for i, run := range []func() ([]worker.AttemptClaim, error){
		func() ([]worker.AttemptClaim, error) { return store.ClaimAttempts(ctx, w1, 2) },
		func() ([]worker.AttemptClaim, error) { return store2.ClaimAttempts(ctx, w2, 2) },
	} {
		wg.Add(1)
		go func(i int, run func() ([]worker.AttemptClaim, error)) {
			defer wg.Done()
			<-start
			// Retry until the queue empties or the batch fills, exactly as
			// the loop would: the race is per-claim, not per-process.
			for free := 2; free > 0; {
				cs, err := run()
				mu.Lock()
				results[i].claims = append(results[i].claims, cs...)
				mu.Unlock()
				if err != nil {
					mu.Lock()
					results[i].err = err
					mu.Unlock()
					return
				}
				if len(cs) == 0 {
					return
				}
				free -= len(cs)
			}
		}(i, run)
	}
	close(start)
	wg.Wait()
	for i := range results {
		if results[i].err != nil {
			t.Fatalf("racing claim %d: %v", i, results[i].err)
		}
	}

	owner := map[string]string{}
	claimed := 0
	for i, o := range results {
		seen := map[int64]int{}
		workerID := []string{w1, w2}[i]
		for _, c := range o.claims {
			claimed++
			if prev, dup := owner[c.AttemptID]; dup {
				t.Fatalf("attempt %s claimed twice: %s and %s — SKIP LOCKED is not a queue", c.AttemptID, prev, workerID)
			}
			owner[c.AttemptID] = workerID
			seen[c.FencingToken]++
		}
		if len(o.claims) > 1 {
			var distinct int
			for range seen {
				distinct++
			}
			if distinct != 1 {
				t.Fatalf("worker %d's batch carried %d distinct tokens, want one draw per claim", i, distinct)
			}
		}
	}
	if claimed != len(wanted) {
		t.Fatalf("claims across both workers = %d, want %d (each attempt exactly one lease)", claimed, len(wanted))
	}
	var leased int
	if err := f.pool.QueryRow(ctx, `SELECT count(*) FROM attempts WHERE status = 'leased'`).Scan(&leased); err != nil {
		t.Fatal(err)
	}
	if leased != len(wanted) {
		t.Errorf("leased rows = %d, want %d", leased, len(wanted))
	}
}

// TestAttemptWorkerStaleWritesLandNothing is `12` case 3 through every
// fenced port method: after the triple rotates, each call answers
// worker.ErrLeaseLost and the database is byte-for-byte the pre-refusal
// place — no attempt row, no node mirror, no checkpoint, no journal row.
func TestAttemptWorkerStaleWritesLandNothing(t *testing.T) {
	ctx := testCtx(t)
	f, store := awSetup(t)
	runID := f.m4QueuedRun(t, ctx, "", 0)
	nodeID, _ := f.m4WorkerNode(t, ctx, runID, "/implement")
	workerID := m4Worker(t, ctx, f.pool, "stale", 1)

	claims, err := store.ClaimAttempts(ctx, workerID, 1)
	if err != nil || len(claims) != 1 {
		t.Fatalf("claim = (%v, %v)", claims, err)
	}
	c := claims[0]
	if err := store.BeginAttempt(ctx, c); err != nil {
		t.Fatalf("BeginAttempt: %v", err)
	}
	thief := m4Worker(t, ctx, f.pool, "thief", 1)
	if _, err := f.pool.Exec(ctx, `
		UPDATE attempts SET fencing_token = fencing_token + 1, worker_id = $2::uuid
		WHERE id = $1::uuid`, c.AttemptID, thief); err != nil {
		t.Fatalf("simulate the re-claim: %v", err)
	}

	eventsBefore := awCount(t, ctx, f, `SELECT count(*) FROM domain_events WHERE attempt_id = $1::uuid`, c.AttemptID)
	checks := []struct {
		name string
		call func() error
	}{
		{"RenewAttempt", func() error { return store.RenewAttempt(ctx, c) }},
		{"AppendAttemptEvent", func() error {
			return store.AppendAttemptEvent(ctx, c, worker.AttemptEvent{Type: "node.attempt.progress", Payload: map[string]any{"x": 1}})
		}},
		{"CancelRequestedAttempt", func() error {
			_, _, err := store.CancelRequestedAttempt(ctx, c)
			return err
		}},
		{"CompleteAttempt", func() error {
			return store.CompleteAttempt(ctx, c, map[string]any{"exit_code": 0}, m4Digest("outs"),
				[]any{}, "passed", worker.AttemptCheckpoint{
					InputsDigest: m4Digest("ins"), OutputsDigest: m4Digest("outs"),
					WorkspaceID: m4Workspace(t, ctx, f, runID), VolumeID: "vol-stale",
				})
		}},
		{"FailAttempt", func() error { return store.FailAttempt(ctx, c, worker.ErrorClassInfra, "late", nil) }},
		{"InterruptAttemptOwn", func() error {
			return store.InterruptAttemptOwn(ctx, c, worker.InterruptReasonWorkerShutdown)
		}},
		{"CancelAttemptOwn", func() error {
			return store.CancelAttemptOwn(ctx, c, worker.CancelReasonProcessTerminated)
		}},
	}
	for _, ch := range checks {
		if err := ch.call(); !errors.Is(err, worker.ErrLeaseLost) {
			t.Errorf("%s with a stale triple = %v, want worker.ErrLeaseLost", ch.name, err)
		}
	}
	// Zero side effects — the words mean NOTHING unless the database agrees.
	var status, nodeStatus string
	var outputs *string
	if err := f.pool.QueryRow(ctx, `SELECT status, outputs::text FROM attempts WHERE id = $1::uuid`, c.AttemptID).
		Scan(&status, &outputs); err != nil {
		t.Fatal(err)
	}
	if status != "running" {
		t.Errorf("stale writes moved the attempt to %q; the fence is supposed to be silent", status)
	}
	if outputs != nil {
		t.Errorf("stale CompleteAttempt wrote outputs: %s", *outputs)
	}
	if err := f.pool.QueryRow(ctx, `SELECT status FROM node_executions WHERE id = $1::uuid`, nodeID).Scan(&nodeStatus); err != nil {
		t.Fatal(err)
	}
	// The claim leased the node; BeginAttempt touches the attempt row only,
	// so 'leased' is the untouched place the stale writes must not have left.
	if nodeStatus != "leased" {
		t.Errorf("node = %q on stale writes, want untouched 'leased'", nodeStatus)
	}
	if n := awCount(t, ctx, f, `SELECT count(*) FROM run_checkpoints WHERE attempt_id = $1::uuid`, c.AttemptID); n != 0 {
		t.Errorf("stale writes created %d checkpoint rows", n)
	}
	if n := awCount(t, ctx, f, `SELECT count(*) FROM domain_events WHERE attempt_id = $1::uuid`, c.AttemptID); n != eventsBefore {
		t.Errorf("journal rows for the attempt went %d→%d: a fenced refusal must append NOTHING (case 3)", eventsBefore, n)
	}
	// The claim itself wrote its started event earlier; the NEW owner is the
	// only writer from here.
	if err := store.BeginAttempt(ctx, c); !errors.Is(err, worker.ErrLeaseLost) {
		t.Errorf("second BeginAttempt = %v, want ErrLeaseLost (running→running is not this owner's)", err)
	}
}

// TestAttemptWorkerKilledOwnerInterruptThenLateComplete is the `12` case 5
// fence half: the owner dies mid-command, its shutdown close lands
// interrupted (paired turn closed AND journalled, node back to ready for the
// advancer), and its late CompleteAttempt — the exact resurrection a dead
// process must not get — is refused with zero side effects.
func TestAttemptWorkerKilledOwnerInterruptThenLateComplete(t *testing.T) {
	ctx := testCtx(t)
	f, store := awSetup(t)
	runID := f.m4QueuedRun(t, ctx, "", 0)
	nodeID, _ := f.m4WorkerNode(t, ctx, runID, "/implement")
	workerID := m4Worker(t, ctx, f.pool, "dead", 1)

	// A stamped agent turn, live under this attempt (the two-lease pair).
	profileID, userID := awProfile(t, ctx, f)
	convID := awConversation(t, ctx, f, profileID, userID)
	var turnID string
	if _, err := f.pool.Exec(ctx, `
		DELETE FROM conversation_turns WHERE conversation_id = $1::uuid`, convID); err != nil {
		t.Fatal(err)
	}
	// The triple the M2 CHECK demands of a live turn: the attempt's owner,
	// a token and a live lease — the two-lease pair ADR-0023 § 4 governs.
	if err := f.pool.QueryRow(ctx, `
		INSERT INTO conversation_turns (conversation_id, prompt, submitted_by, status,
		                                worker_id, fencing_token, lease_expires_at, node_attempt_id)
		SELECT $1, 'live for the attempt', $2, 'running', $3, 9, now() + interval '30 seconds',
		       (SELECT id FROM attempts WHERE run_id = $4::uuid LIMIT 1)
		RETURNING id`,
		convID, userID, workerID, runID).Scan(&turnID); err != nil {
		t.Fatalf("stamp a live turn: %v", err)
	}

	claims, err := store.ClaimAttempts(ctx, workerID, 1)
	if err != nil || len(claims) != 1 {
		t.Fatalf("claim = (%v, %v)", claims, err)
	}
	c := claims[0]
	if err := store.RenewAttempt(ctx, c); err != nil {
		t.Errorf("RenewAttempt: %v", err)
	}
	// The same-statement two-lease rule: renewing the attempt renewed the turn.
	var turnLease time.Time
	if err := f.pool.QueryRow(ctx, `SELECT lease_expires_at FROM conversation_turns WHERE id = $1`, turnID).Scan(&turnLease); err != nil {
		t.Fatal(err)
	}
	if time.Until(turnLease) <= 0 {
		t.Error("the paired turn's lease did not travel with the attempt renewal (ADR-0023 § 4)")
	}

	if err := store.InterruptAttemptOwn(ctx, c, worker.InterruptReasonWorkerShutdown); err != nil {
		t.Fatalf("InterruptAttemptOwn: %v", err)
	}
	var attStatus, attClass, nodeStatus string
	if err := f.pool.QueryRow(ctx, `SELECT status, COALESCE(error_class,'') FROM attempts WHERE id = $1::uuid`, c.AttemptID).
		Scan(&attStatus, &attClass); err != nil {
		t.Fatal(err)
	}
	if attStatus != "interrupted" || attClass != "interrupted" {
		t.Errorf("attempt = (%s, %s), want (interrupted, interrupted)", attStatus, attClass)
	}
	if err := f.pool.QueryRow(ctx, `SELECT status FROM node_executions WHERE id = $1::uuid`, nodeID).Scan(&nodeStatus); err != nil {
		t.Fatal(err)
	}
	if nodeStatus != "ready" {
		t.Errorf("node = %q after the interrupted close, want 'ready' for the ADVANCER to decide retry-vs-terminal (§ 5.1)", nodeStatus)
	}
	// § 4 step 12's pair, in the same transaction as the close.
	if n := awCount(t, ctx, f, `
		SELECT count(*) FROM domain_events
		WHERE attempt_id = $1::uuid AND type = 'node.attempt.interrupted'
		  AND payload->>'reason' = 'worker_shutdown'`, c.AttemptID); n != 1 {
		t.Errorf("node.attempt.interrupted rows = %d, want 1", n)
	}
	var turnStatus string
	if err := f.pool.QueryRow(ctx, `SELECT status FROM conversation_turns WHERE id = $1`, turnID).Scan(&turnStatus); err != nil {
		t.Fatal(err)
	}
	if turnStatus != "interrupted" {
		t.Errorf("paired turn = %q, want interrupted — a turn never outlives the attempt that owns it", turnStatus)
	}
	if n := awCount(t, ctx, f, `
		SELECT count(*) FROM domain_events
		WHERE conversation_id = $1::uuid AND type = 'conversation.turn.interrupted'`, convID); n != 1 {
		t.Errorf("conversation.turn.interrupted rows = %d, want 1 (the shutdown pair is journalled, not just written)", n)
	}
	var active int
	if err := f.pool.QueryRow(ctx, `SELECT active_attempts FROM workers WHERE id = $1::uuid`, workerID).Scan(&active); err != nil {
		t.Fatal(err)
	}
	if active != 0 {
		t.Errorf("active_attempts = %d after the terminal write, want 0 (decrement rides the terminal commit, § 4 step 1)", active)
	}

	// The dead owner wakes up and tries to report success. Fence. Zero.
	eventsBefore := awCount(t, ctx, f, `SELECT count(*) FROM domain_events WHERE attempt_id = $1::uuid`, c.AttemptID)
	err = store.CompleteAttempt(ctx, c, map[string]any{"exit_code": 0}, m4Digest("late"),
		[]any{}, "passed", worker.AttemptCheckpoint{
			InputsDigest: m4Digest("ins"), OutputsDigest: m4Digest("outs"),
			WorkspaceID: m4Workspace(t, ctx, f, runID), VolumeID: "vol-dead",
		})
	if !errors.Is(err, worker.ErrLeaseLost) {
		t.Fatalf("late CompleteAttempt = %v, want ErrLeaseLost", err)
	}
	var outputs *string
	if err := f.pool.QueryRow(ctx, `SELECT outputs::text FROM attempts WHERE id = $1::uuid`, c.AttemptID).Scan(&outputs); err != nil {
		t.Fatal(err)
	}
	if outputs != nil {
		t.Errorf("the dead owner wrote outputs anyway: %s", *outputs)
	}
	if n := awCount(t, ctx, f, `SELECT count(*) FROM domain_events WHERE attempt_id = $1::uuid`, c.AttemptID); n != eventsBefore {
		t.Errorf("late success attempt journalled %d extra rows (case 3 again: refused means NOTHING)", n-eventsBefore)
	}
	if n := awCount(t, ctx, f, `SELECT count(*) FROM run_checkpoints WHERE attempt_id = $1::uuid`, c.AttemptID); n != 0 {
		t.Errorf("late success wrote %d checkpoints", n)
	}
}

// TestAttemptWorkerCompleteBoundaryAllOrNothing proves the boundary write
// really is the transaction: outputs+digest, refs, outcome, the checkpoint
// row, the node mirror and both events land together or the row keeps none of
// them — asserted once from the success side and once from the refusal side
// (a checkpoint with no volume cannot half-write the completion either).
func TestAttemptWorkerCompleteBoundaryAllOrNothing(t *testing.T) {
	ctx := testCtx(t)
	f, store := awSetup(t)
	runID := f.m4QueuedRun(t, ctx, "", 0)
	nodeID, _ := f.m4WorkerNode(t, ctx, runID, "/test")
	workerID := m4Worker(t, ctx, f.pool, "boundary", 1)
	wsID := m4Workspace(t, ctx, f, runID)

	claims, err := store.ClaimAttempts(ctx, workerID, 1)
	if err != nil || len(claims) != 1 {
		t.Fatalf("claim = (%v, %v)", claims, err)
	}
	c := claims[0]
	if err := store.BeginAttempt(ctx, c); err != nil {
		t.Fatalf("BeginAttempt: %v", err)
	}
	digest := m4Digest("test-outs")
	ckpt := worker.AttemptCheckpoint{
		InputsDigest: m4Digest("test-ins"), OutputsDigest: digest,
		RepoStates:  []worker.CheckpointRepoState{{RepositoryID: "repo-1", BaseCommit: "a1", HeadCommit: "b2"}},
		WorkspaceID: wsID, VolumeID: "vol-bound",
	}
	// The refusal side first: no volume, no checkpoint — and NOTHING else
	// moves either (insertCheckpointTx fails before the commit).
	bad := ckpt
	bad.VolumeID = ""
	if err := store.CompleteAttempt(ctx, c, map[string]any{"exit_code": 0}, digest, nil, "passed", bad); err == nil {
		t.Fatal("volumeless checkpoint accepted (D-024's CHECK should refuse)")
	}
	var attStatus string
	if err := f.pool.QueryRow(ctx, `SELECT status FROM attempts WHERE id = $1::uuid`, c.AttemptID).Scan(&attStatus); err != nil {
		t.Fatal(err)
	}
	if attStatus != "running" {
		t.Fatalf("refused checkpoint left the attempt at %q, want still 'running' (all-or-nothing)", attStatus)
	}
	if n := awCount(t, ctx, f, `SELECT count(*) FROM domain_events WHERE attempt_id = $1::uuid`, c.AttemptID); n != 1 {
		t.Fatalf("journal rows after the refusal = %d, want only node.attempt.started", n)
	}

	// The success side: one transaction, everything true at once.
	if err := store.CompleteAttempt(ctx, c, map[string]any{"exit_code": 0, "passed": true}, digest,
		[]any{map[string]any{"kind": "json", "id": "art-1"}}, "passed", ckpt); err != nil {
		t.Fatalf("CompleteAttempt: %v", err)
	}
	var (
		outputs         json.RawMessage
		outputsDigest   string
		nodeStatus      string
		nodeOutcome     string
		cpCount         int
		artifact        json.RawMessage
		completedCorr   string
		checkpointSaved bool
	)
	if err := f.pool.QueryRow(ctx, `
		SELECT outputs, outputs_digest, COALESCE(artifact_refs::text,'')
		FROM attempts WHERE id = $1::uuid`, c.AttemptID).
		Scan(&outputs, &outputsDigest, &artifact); err != nil {
		t.Fatal(err)
	}
	if outputsDigest != digest || len(outputs) == 0 {
		t.Errorf("attempt outputs/digest = (%s, %s), want (%s, set)", outputs, outputsDigest, digest)
	}
	if !strings.Contains(string(artifact), "art-1") {
		t.Errorf("artifact_refs = %s, want the published ref", artifact)
	}
	if err := f.pool.QueryRow(ctx, `
		SELECT status, COALESCE(outcome,'') FROM node_executions WHERE id = $1::uuid`, nodeID).
		Scan(&nodeStatus, &nodeOutcome); err != nil {
		t.Fatal(err)
	}
	if nodeStatus != "succeeded" || nodeOutcome != "passed" {
		t.Errorf("node mirror = (%s, %s), want (succeeded, passed)", nodeStatus, nodeOutcome)
	}
	if err := f.pool.QueryRow(ctx, `
		SELECT count(*), COALESCE(string_agg(CASE WHEN type='node.attempt.completed'
		              AND node_execution_id = $2::uuid THEN 'y' END, ''))
		FROM domain_events WHERE attempt_id = $1::uuid`, c.AttemptID, nodeID).
		Scan(&cpCount, &completedCorr); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(completedCorr, "y") {
		t.Errorf("node.attempt.completed not correlated on attempt+node: %v", completedCorr)
	}
	if n := awCount(t, ctx, f, `SELECT count(*) FROM run_checkpoints WHERE attempt_id = $1::uuid`, c.AttemptID); n != 1 {
		t.Errorf("checkpoint rows = %d, want 1", n)
	}
	if err := f.pool.QueryRow(ctx, `
		SELECT count(*) > 0 FROM domain_events
		WHERE attempt_id = $1::uuid AND type = 'run.checkpoint_saved'
		  AND payload->'checkpoint'->>'volume_id' = 'vol-bound'`, c.AttemptID).
		Scan(&checkpointSaved); err != nil {
		t.Fatal(err)
	}
	if !checkpointSaved {
		t.Error("run.checkpoint_saved missing or lying about the volume")
	}
	var active int
	if err := f.pool.QueryRow(ctx, `SELECT active_attempts FROM workers WHERE id = $1::uuid`, workerID).Scan(&active); err != nil {
		t.Fatal(err)
	}
	if active != 0 {
		t.Errorf("active_attempts = %d after the boundary, want 0", active)
	}
}

// TestAttemptWorkerCapacityPublished covers § 4 step 1: Register writes the
// capacity and zeroes the accounting; Heartbeat re-publishes it; the M2
// default (zero field) touches neither column.
func TestAttemptWorkerCapacityPublished(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)
	reg := &WorkerRegistry{Pool: f.pool, Capacity: 3}
	id, err := reg.Register(ctx, "cap-test", "lab", "contract")
	if err != nil {
		t.Fatalf("Register: %v", err)
	}
	var capacity, active int
	if err := f.pool.QueryRow(ctx, `SELECT capacity, active_attempts FROM workers WHERE id = $1::uuid`, id).
		Scan(&capacity, &active); err != nil {
		t.Fatal(err)
	}
	if capacity != 3 || active != 0 {
		t.Fatalf("published (capacity, active) = (%d, %d), want (3, 0)", capacity, active)
	}
	// Simulate a claimed attempt, then a restart: Register zeroes the
	// accounting a dead process left, while the old leases stay fenced.
	if _, err := f.pool.Exec(ctx, `UPDATE workers SET active_attempts = 2 WHERE id = $1::uuid`, id); err != nil {
		t.Fatal(err)
	}
	reg.Capacity = 4
	if _, err := reg.Register(ctx, "cap-test", "lab", "contract"); err != nil {
		t.Fatalf("re-Register: %v", err)
	}
	if err := f.pool.QueryRow(ctx, `SELECT capacity, active_attempts FROM workers WHERE id = $1::uuid`, id).
		Scan(&capacity, &active); err != nil {
		t.Fatal(err)
	}
	if capacity != 4 || active != 0 {
		t.Errorf("after re-register (%d, %d), want (4, 0)", capacity, active)
	}
	// Heartbeat keeps the published number true.
	if err := reg.Heartbeat(ctx, "cap-test"); err != nil {
		t.Fatalf("Heartbeat: %v", err)
	}
	if err := f.pool.QueryRow(ctx, `SELECT capacity FROM workers WHERE id = $1::uuid`, id).Scan(&capacity); err != nil {
		t.Fatal(err)
	}
	if capacity != 4 {
		t.Errorf("Heartbeat let capacity drift to %d", capacity)
	}
	// Out-of-range capacities are named refusals, not CHECK violations.
	for _, bad := range []int{0 - 1, 17, 99} {
		r := &WorkerRegistry{Pool: f.pool, Capacity: bad}
		if _, err := r.Register(ctx, "cap-bad", "lab", "x"); err == nil {
			t.Errorf("capacity %d accepted at Register", bad)
		} else if !strings.Contains(err.Error(), "1..16") {
			t.Errorf("capacity %d error = %v, want the named CHECK bound", bad, err)
		}
	}
	// The M2 default publishes nothing: capacity stays the schema default.
	m2 := &WorkerRegistry{Pool: f.pool}
	m2id, err := m2.Register(ctx, "cap-m2", "lab", "x")
	if err != nil {
		t.Fatalf("M2 Register: %v", err)
	}
	if err := f.pool.QueryRow(ctx, `SELECT capacity FROM workers WHERE id = $1::uuid`, m2id).Scan(&capacity); err != nil {
		t.Fatal(err)
	}
	if capacity != 1 {
		t.Errorf("M2 registration capacity = %d, want the column default 1", capacity)
	}
}

// TestAttemptStoreRejectsUnknownClassesAndReasons keeps the worker's enum
// discipline out of Postgres's hands: a class outside ADR-0023 § 7 and a
// reason that belongs to the reconciler or the advancer are refused before
// the fence is even opened.
func TestAttemptStoreRejectsUnknownClassesAndReasons(t *testing.T) {
	ctx := testCtx(t)
	f, store := awSetup(t)
	runID := f.m4QueuedRun(t, ctx, "", 0)
	f.m4WorkerNode(t, ctx, runID, "/gate")
	workerID := m4Worker(t, ctx, f.pool, "enum", 1)
	claims, err := store.ClaimAttempts(ctx, workerID, 1)
	if err != nil || len(claims) != 1 {
		t.Fatalf("claim = (%v, %v)", claims, err)
	}
	c := claims[0]
	if err := store.FailAttempt(ctx, c, "not_a_class", "x", nil); err == nil ||
		!strings.Contains(err.Error(), "ADR-0023") {
		t.Errorf("unknown error class = %v, want the named enum refusal", err)
	}
	if err := store.InterruptAttemptOwn(ctx, c, "lease_expired"); err == nil ||
		!strings.Contains(err.Error(), "reconciler") {
		t.Errorf("reconciler reason from a live worker = %v, want a refusal", err)
	}
	if err := store.CancelAttemptOwn(ctx, c, "before_claim"); err == nil ||
		!strings.Contains(err.Error(), "advancer") {
		t.Errorf("advancer cancel reason from a live attempt = %v, want a refusal", err)
	}
	// Still live: none of the refusals wrote a terminal.
	var status string
	if err := f.pool.QueryRow(ctx, `SELECT status FROM attempts WHERE id = $1::uuid`, c.AttemptID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "leased" {
		t.Errorf("status = %q after refused vocabularies, want still 'leased'", status)
	}
	// Oversize inline outputs are the § 6 named failure, before the tx.
	big := map[string]any{"blob": strings.Repeat("x", MaxInlineOutputsBytes+10)}
	err = store.CompleteAttempt(ctx, c, big, m4Digest("o"), nil, "passed", worker.AttemptCheckpoint{
		InputsDigest: m4Digest("i"), OutputsDigest: m4Digest("o"),
		WorkspaceID: m4Workspace(t, ctx, f, runID), VolumeID: "v",
	})
	if !errors.Is(err, ErrOutputsTooLarge) {
		t.Errorf("oversize outputs = %v, want ErrOutputsTooLarge (§ 6)", err)
	}
}

// ------------------------------------------------------------- helpers

func awProfile(t *testing.T, ctx context.Context, f *m4Fixture) (profileID, userID string) {
	t.Helper()
	if err := f.pool.QueryRow(ctx, `
		INSERT INTO agent_profiles (organization_id, name, launcher_id)
		VALUES ($1, 'aw-profile-' || substr(md5(random()::text), 1, 8), 'claude')
		RETURNING id`, f.orgID).Scan(&profileID); err != nil {
		t.Fatalf("seed agent profile: %v", err)
	}
	t.Cleanup(func() {
		_, _ = f.pool.Exec(context.Background(), `DELETE FROM agent_profile_versions WHERE profile_id = $1`, profileID)
		_, _ = f.pool.Exec(context.Background(), `DELETE FROM agent_profiles WHERE id = $1`, profileID)
	})
	userID = f.userID
	return profileID, userID
}

func awConversation(t *testing.T, ctx context.Context, f *m4Fixture, profileID, userID string) string {
	t.Helper()
	var convID string
	if err := f.pool.QueryRow(ctx, `
		INSERT INTO conversations (project_id, agent_profile_id, title, created_by)
		VALUES ($1, $2, 'attempt-bound', $3) RETURNING id`,
		f.projectID, profileID, userID).Scan(&convID); err != nil {
		t.Fatalf("insert conversation: %v", err)
	}
	if _, err := f.pool.Exec(ctx, `
		INSERT INTO conversation_control (conversation_id, controller_kind, controller_user_id)
		VALUES ($1, 'human', $2)`, convID, userID); err != nil {
		t.Fatalf("insert control: %v", err)
	}
	bg := context.Background()
	t.Cleanup(func() {
		_, _ = f.pool.Exec(bg, `UPDATE attempts SET conversation_id = NULL, turn_id = NULL WHERE conversation_id = $1::uuid`, convID)
		_, _ = f.pool.Exec(bg, `DELETE FROM conversation_turns WHERE conversation_id = $1::uuid`, convID)
		_, _ = f.pool.Exec(bg, `DELETE FROM conversation_control WHERE conversation_id = $1::uuid`, convID)
		_, _ = f.pool.Exec(bg, `DELETE FROM conversations WHERE id = $1::uuid`, convID)
	})
	return convID
}

// TestConfigHydrationFromPinnedPlan proves the claim's Config comes from the
// run's IMMUTABLE plan_snapshot: literals hydrate into the nested value the
// executor dispatches on, and an expression-bound value arrives marked
// $unresolved — a claim the worker refuses honestly instead of evaluating
// (§ 4 step 14). The plan is re-read per claim from the pinned column, so
// mutating anything else in the database cannot change it (12 case 11).
func TestConfigHydrationFromPinnedPlan(t *testing.T) {
	ctx := testCtx(t)
	f, store := awSetup(t)

	// A run whose snapshot carries a process.exec node with argv literals and
	// a bindingText prompt still holding expression ids.
	plan := json.RawMessage(`{
		"version": "v1alpha1-plan-1",
		"nodes": [{
			"id": "build", "scope": "/",
			"configBindings": [
				{"pointer": "/spec/nodes/0/config/argv/0", "position": "literal", "literal": "/bin/sh"},
				{"pointer": "/spec/nodes/0/config/argv/1", "position": "literal", "literal": "-c"},
				{"pointer": "/spec/nodes/0/config/argv/2", "position": "literal", "literal": "make"},
				{"pointer": "/spec/nodes/0/config/outputExtraction", "position": "literal", "literal": "json_from_stdout"},
				{"pointer": "/spec/nodes/0/config/prompt", "position": "bindingText", "exprIds": ["e7"], "template": "run ${expr:e7}"}
			]
		}]
	}`)
	runID := f.m4QueuedRun(t, ctx, "", 0)
	if _, err := f.pool.Exec(ctx, `UPDATE runs SET plan_snapshot = $2 WHERE id = $1::uuid`, runID, plan); err != nil {
		t.Fatalf("pin the plan: %v", err)
	}
	nodeID, _ := f.m4WorkerNode(t, ctx, runID, "/build")
	_ = nodeID
	workerID := m4Worker(t, ctx, f.pool, "hydrated", 1)
	claims, err := store.ClaimAttempts(ctx, workerID, 1)
	if err != nil || len(claims) != 1 {
		t.Fatalf("claim = (%v, %v)", claims, err)
	}
	cfg := claims[0].Config
	argv, ok := cfg["argv"].([]any)
	if !ok || len(argv) != 3 || argv[2] != "make" {
		t.Fatalf("argv = %#v, want [/bin/sh -c make] hydrated from the plan", cfg["argv"])
	}
	if cfg["outputExtraction"] != "json_from_stdout" {
		t.Errorf("outputExtraction = %#v", cfg["outputExtraction"])
	}
	prompt, _ := cfg["prompt"].(map[string]any)
	if prompt == nil || prompt["$unresolved"] != true {
		t.Fatalf("prompt = %#v, want the $unresolved marker: the worker does not evaluate bindings (§ 4 step 14)", cfg["prompt"])
	}
	if ids := fmt.Sprintf("%v", prompt["expr_ids"]); !strings.Contains(ids, "e7") {
		t.Errorf("unresolved marker lost its expression ids: %#v", prompt)
	}
}
