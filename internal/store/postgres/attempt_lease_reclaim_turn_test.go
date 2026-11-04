package postgres

// ADR-0074 / the lease-lost lab regression (lab-e2e run 41766977189,
// 2026-11-04, commit e3dcbc1): an agent.acp attempt lost its lease, the
// reaper re-claimed the attempt (interrupted{lease_expired}) and the retry
// came up, but the attempt's paired conversation turn was left non-terminal.
// conversation_turns_one_active_idx then refused the retry's turn — one
// 23505 a second in the Postgres log — and the node sat leased while the
// retry claim waited on a terminal that only a second, separate loop (the M3
// turn-lease reconciler) could have spoken. The re-claim is the takeover: the
// stale owner is fenced out of every write from the same commit, so the
// orphaned turn's terminal must ride the takeover transaction, not somebody
// else's later arrival.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/dbirks/communication/internal/events"
	"github.com/dbirks/communication/internal/worker"
)

// reclPlan is the pinned snapshot: one agent node with a literal prompt and
// profile (so the claim stamps a real conversation turn) and a retry budget
// that admits interrupted (so the re-claim's own advance re-queues the
// retry on the node's schedule — the path the lab's "attempt 2 never
// queued" failure waited on). The 30 s base pins a landing time long enough
// to assert without racing the clock; the test fast-forwards it.
const reclPlan = `{
	"version": "v1alpha1-plan-1",
	"scopes": [{
		"key": "/", "kind": "root", "expressionScope": "pipeline",
		"entryNodes": ["implement"], "terminalNodes": ["implement"],
		"topologicalOrder": ["implement"]
	}],
	"nodes": [{
		"id": "implement", "scope": "/", "path": ["implement"], "executionLocation": "worker",
		"retry": {"maxAttempts": 4, "retriableErrors": ["interrupted"], "baseSeconds": 30},
		"configBindings": [
			{"pointer": "/spec/nodes/0/config/prompt", "position": "literal", "literal": "document add()"},
			{"pointer": "/spec/nodes/0/config/profile", "position": "literal", "literal": %q}
		]
	}]
}`

func TestLeaseReclaimClosesOrphanedTurnInSameTransaction(t *testing.T) {
	ctx := testCtx(t)
	f, store := awSetup(t)
	sessions := &AttemptSessions{Runs: f.runs}
	profile := fmt.Sprintf("reclaim-turn-%s", migFixtureToken(t))
	atsProfile(t, ctx, f, f.orgID, profile, "claude", "ask", false)
	runID := f.m4QueuedRun(t, ctx, "", 0)
	if _, err := f.pool.Exec(ctx, `UPDATE runs SET plan_snapshot = $2 WHERE id = $1::uuid`, runID,
		fmt.Sprintf(reclPlan, profile)); err != nil {
		t.Fatalf("pin the plan: %v", err)
	}
	nodeID, attemptID := f.m4WorkerNode(t, ctx, runID, "/implement")
	if _, err := f.pool.Exec(ctx, `
		UPDATE node_executions SET in_flight = 1, attempt_limit = 4 WHERE id = $1::uuid`, nodeID); err != nil {
		t.Fatalf("record the scheduling in_flight and the retry budget: %v", err)
	}
	workerID := m4Worker(t, ctx, f.pool, "reclaim-turn", 1)
	atsConversationSweep(t, f)
	c := atsClaimRunning(t, ctx, f, store, workerID)
	conv, ok, err := sessions.ConversationFor(ctx, c)
	if err != nil || !ok || conv.ConversationID == "" || conv.TurnID == "" {
		t.Fatalf("ConversationFor = (%+v, %v, %v), want the stamped pair", conv, ok, err)
	}

	// The lease died the way the lab's did: the worker stopped renewing.
	// Expire the ATTEMPT's lease while the paired turn's lease stays FRESH —
	// no reconciler runs in this process, so only the re-claim itself can
	// close the orphan; a fix that leaned on the M3 turn-lease arm would wait
	// on a deadline this test never lets arrive.
	if _, err := f.pool.Exec(ctx, `
		UPDATE attempts SET lease_expires_at = now() - interval '30 seconds' WHERE id = $1::uuid`,
		attemptID); err != nil {
		t.Fatalf("expire the attempt lease: %v", err)
	}

	if err := NewRuntimeStore(f.pool, nil).ReconcileLeases(ctx, runID); err != nil {
		t.Fatalf("ReconcileLeases: %v", err)
	}

	// The attempt terminal is the lab's own: interrupted, honest class,
	// timestamped — and the paired turn closed in the SAME commit.
	var (
		status, errClass string
		finished         bool
	)
	if err := f.pool.QueryRow(ctx, `
		SELECT status, COALESCE(error_class, ''), finished_at IS NOT NULL
		FROM attempts WHERE id = $1::uuid`, attemptID).Scan(&status, &errClass, &finished); err != nil {
		t.Fatalf("read the reclaimed attempt: %v", err)
	}
	if status != "interrupted" || errClass != "interrupted" || !finished {
		t.Fatalf("attempt = (%s, %s, finished=%v), want (interrupted, interrupted, true)", status, errClass, finished)
	}
	var turnStatus, turnStop string
	var turnFinished bool
	if err := f.pool.QueryRow(ctx, `
		SELECT status, COALESCE(stop_reason, ''), finished_at IS NOT NULL
		FROM conversation_turns WHERE id = $1::uuid`, conv.TurnID).Scan(&turnStatus, &turnStop, &turnFinished); err != nil {
		t.Fatalf("read the paired turn: %v", err)
	}
	if turnStatus != events.TurnStatusInterrupted || turnStop != "" || !turnFinished {
		t.Fatalf("paired turn = (%s, stop=%q, finished=%v), want (interrupted, '', true): the turn must never outlive the attempt that owns it",
			turnStatus, turnStop, turnFinished)
	}

	// The transcript shows the honest system line: ONE
	// conversation.turn.interrupted, reason lease_expired, naming the worker
	// that lost the turn and the dead token, spoken by the deadline (system).
	rows, err := f.pool.Query(ctx, `
		SELECT payload::text, actor_kind, actor_id FROM domain_events
		WHERE conversation_id = $1::uuid AND type = 'conversation.turn.interrupted'`,
		conv.ConversationID)
	if err != nil {
		t.Fatalf("list turn terminals: %v", err)
	}
	defer rows.Close()
	n := 0
	for rows.Next() {
		n++
		var (
			payloadRaw []byte
			kind, id   string
		)
		if err := rows.Scan(&payloadRaw, &kind, &id); err != nil {
			t.Fatalf("scan turn terminal: %v", err)
		}
		if kind != events.ActorKindSystem || id != "system" {
			t.Errorf("actor = %s/%s, want system/system: a deadline decided this turn was lost", kind, id)
		}
		var p events.TurnInterruptedPayload
		if err := json.Unmarshal(payloadRaw, &p); err != nil {
			t.Fatalf("decode interrupted payload: %v", err)
		}
		if p.Reason != events.InterruptLeaseExpired {
			t.Errorf("reason = %q, want %q (the M2 vocabulary's word for a lost lease)", p.Reason, events.InterruptLeaseExpired)
		}
		if p.WorkerID != workerID || p.FencingToken != c.FencingToken {
			t.Errorf("payload = (worker %q, token %d), want the stale owner (%s, %d): the late writer must be recognisable",
				p.WorkerID, p.FencingToken, workerID, c.FencingToken)
		}
		if p.ConversationID != conv.ConversationID || p.TurnID != conv.TurnID {
			t.Errorf("payload scope = (%s, %s), want this conversation and its orphaned turn", p.ConversationID, p.TurnID)
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate turn terminals: %v", err)
	}
	if n != 1 {
		t.Fatalf("conversation.turn.interrupted rows = %d, want exactly one: the reclaim journals the close it performs, and no second word", n)
	}

	// The stale worker's capacity slot came back with the re-claim.
	var active int
	if err := f.pool.QueryRow(ctx, `SELECT active_attempts FROM workers WHERE id = $1::uuid`, workerID).Scan(&active); err != nil {
		t.Fatalf("read the worker: %v", err)
	}
	if active != 0 {
		t.Fatalf("active_attempts = %d after the reclaim, want 0", active)
	}

	// The stale owner's next word on its dead triple lands NOTHING — not on
	// the attempt, not on the conversation.
	if err := store.FailAttempt(ctx, c, worker.ErrorClassInfra, "late writer", nil); !errors.Is(err, worker.ErrLeaseLost) {
		t.Fatalf("stale FailAttempt = %v, want ErrLeaseLost", err)
	}
	if st := turnRowStatus(t, f, ctx, conv.TurnID); st != events.TurnStatusInterrupted {
		t.Fatalf("stale write touched the orphaned turn: %s", st)
	}

	// The retry claim rides the SAME conversation with a fresh turn — no
	// busy wait, no 23505, no dependence on the M3 arm. The engine's own
	// advance inside the re-claim already queued attempt 2 on the node's
	// schedule, with the COMPUTED backoff landing time persisted (ADR-0023
	// § 7); fast-forward that second the way the clock would.
	var (
		queued  int
		backoff bool
	)
	if err := f.pool.QueryRow(ctx, `
		SELECT count(*), count(*) FILTER (WHERE scheduled_at > now()) > 0
		FROM attempts WHERE node_execution_id = $1::uuid AND attempt_number = 2`,
		nodeID).Scan(&queued, &backoff); err != nil {
		t.Fatalf("count retry attempts: %v", err)
	}
	if queued != 1 {
		t.Fatalf("engine-queued attempt 2 = %d, want 1: the re-claim's advance re-queues on the retried schedule", queued)
	}
	if !backoff {
		t.Fatal("the engine-queued retry's scheduled_at is not in the future: the persisted backoff landing time is what a restart must honour (ADR-0023 § 7)")
	}
	if _, err := f.pool.Exec(ctx, `
		UPDATE attempts SET scheduled_at = now() - interval '1 second'
		WHERE node_execution_id = $1::uuid AND attempt_number = 2`, nodeID); err != nil {
		t.Fatalf("land the retry's backoff: %v", err)
	}
	claims, err := store.ClaimAttempts(ctx, workerID, 1)
	if err != nil || len(claims) != 1 {
		t.Fatalf("retry claim = (%v, %v), want the engine-queued attempt 2", claims, err)
	}
	if claims[0].AttemptNumber != 2 {
		t.Fatalf("claimed attempt number = %d, want 2", claims[0].AttemptNumber)
	}
	conv2, ok, err := sessions.ConversationFor(ctx, claims[0])
	if err != nil || !ok || conv2.ConversationID == "" || conv2.TurnID == "" {
		t.Fatalf("retry ConversationFor = (%+v, %v, %v), want the stamped pair with NO one-active-turn refusal: %v",
			conv2, ok, err, err)
	}
	if conv2.ConversationID != conv.ConversationID {
		t.Errorf("retry conversation = %s, want the node's existing conversation %s (retry continuity, contract § 4 step 6)",
			conv2.ConversationID, conv.ConversationID)
	}
	if conv2.TurnID == conv.TurnID {
		t.Error("retry reused the orphaned turn row; each attempt owns its own turn")
	}
	var live int
	if err := f.pool.QueryRow(ctx, `
		SELECT count(*) FROM conversation_turns
		WHERE conversation_id = $1::uuid AND status IN ('queued', 'leased', 'running')`,
		conv.ConversationID).Scan(&live); err != nil {
		t.Fatalf("count live turns: %v", err)
	}
	if live != 1 {
		t.Errorf("non-terminal turns = %d after the retry stamped its own, want 1 (the orphan is terminal)", live)
	}
}

// TestLeaseReclaimDoesNotDoubleJournalTheTurnTerminal proves the race the
// re-claim must win HONESTLY: the M3 turn-lease arm closes the SAME orphaned
// turn (its own lease finally expired), and the second closer finds a
// terminal row it must leave untouched — one journal row, not two.
func TestLeaseReclaimDoesNotDoubleJournalTheTurnTerminal(t *testing.T) {
	ctx := testCtx(t)
	f, store := awSetup(t)
	sessions := &AttemptSessions{Runs: f.runs}
	profile := fmt.Sprintf("reclaim-once-%s", migFixtureToken(t))
	atsProfile(t, ctx, f, f.orgID, profile, "claude", "ask", false)
	runID := f.m4QueuedRun(t, ctx, "", 0)
	if _, err := f.pool.Exec(ctx, `UPDATE runs SET plan_snapshot = $2 WHERE id = $1::uuid`, runID,
		fmt.Sprintf(reclPlan, profile)); err != nil {
		t.Fatalf("pin the plan: %v", err)
	}
	nodeID, attemptID := f.m4WorkerNode(t, ctx, runID, "/implement")
	if _, err := f.pool.Exec(ctx, `
		UPDATE node_executions SET in_flight = 1, attempt_limit = 4 WHERE id = $1::uuid`, nodeID); err != nil {
		t.Fatalf("record the scheduling in_flight and the retry budget: %v", err)
	}
	workerID := m4Worker(t, ctx, f.pool, "reclaim-once", 1)
	atsConversationSweep(t, f)
	c := atsClaimRunning(t, ctx, f, store, workerID)
	conv, ok, err := sessions.ConversationFor(ctx, c)
	if err != nil || !ok || conv.TurnID == "" {
		t.Fatalf("ConversationFor = (%+v, %v, %v), want the stamped pair", conv, ok, err)
	}

	// Both leases are past: the way the two arms meet in the lab.
	if _, err := f.pool.Exec(ctx, `
		UPDATE attempts SET lease_expires_at = now() - interval '30 seconds' WHERE id = $1::uuid`,
		attemptID); err != nil {
		t.Fatalf("expire the attempt lease: %v", err)
	}
	if _, err := f.pool.Exec(ctx, `
		UPDATE conversation_turns SET lease_expires_at = now() - interval '30 seconds' WHERE id = $1::uuid`,
		conv.TurnID); err != nil {
		t.Fatalf("expire the turn lease: %v", err)
	}

	// The M3 arm speaks first (the reconciler the lab has running in serve).
	r := NewReconciler(f.pool, ReconcilerConfig{
		LeaseSafety: time.Second, WorkerHeartbeat: time.Hour,
	})
	if _, err := r.Pass(ctx); err != nil {
		t.Fatalf("turn-lease pass: %v", err)
	}
	// Then the re-claim re-derives from the same rows it just committed.
	if err := NewRuntimeStore(f.pool, nil).ReconcileLeases(ctx, runID); err != nil {
		t.Fatalf("ReconcileLeases: %v", err)
	}

	var n int
	if err := f.pool.QueryRow(ctx, `
		SELECT count(*) FROM domain_events
		WHERE conversation_id = $1::uuid AND type = 'conversation.turn.interrupted'`,
		conv.ConversationID).Scan(&n); err != nil {
		t.Fatalf("count turn terminals: %v", err)
	}
	if n != 1 {
		t.Fatalf("conversation.turn.interrupted rows = %d, want exactly one: the second closer leaves the first word standing", n)
	}
	if st := turnRowStatus(t, f, ctx, conv.TurnID); st != events.TurnStatusInterrupted {
		t.Fatalf("turn = %s, want interrupted (unchanged by the later re-claim)", st)
	}
}

// turnStatus reads one turn's status row (the assertions above need only the
// status, not a fixture reader).
func turnRowStatus(t *testing.T, f *m4Fixture, ctx context.Context, turnID string) string {
	t.Helper()
	var status string
	if err := f.pool.QueryRow(ctx, `SELECT status FROM conversation_turns WHERE id = $1::uuid`, turnID).
		Scan(&status); err != nil {
		t.Fatalf("read the turn: %v", err)
	}
	return status
}
