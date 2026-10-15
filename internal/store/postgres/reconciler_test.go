package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dbirks/communication/internal/events"
)

// The reconciler is the only component in M2 that writes state *because time
// passed*, so every test here manufactures the past — an expired lease, a worker
// whose heartbeat is older than the liveness window, a prompt whose deadline is
// behind us — and then asks what the durable record looks like.
//
// The properties that matter are not "did a counter move": an interrupted turn
// must carry no stop reason, the reason must name a deadline rather than a
// decision-maker, the fencing token must be reported so a late worker can be
// identified as stale, and a worker that renewed in time must be left alone.

func TestReconcilerInterruptsExpiredLease(t *testing.T) {
	f := cnvSetup(t)
	chat := f.cnvCreate(t, f.alice, "Worker died mid-turn", "do the thing")
	ctx := f.ctx()
	turn := f.mustActiveTurn(t, chat.ID)
	token := f.cnvClaim(t, turn, f.worker, time.Minute)
	f.cnvRunning(t, turn)
	f.cnvAttachBinding(t, chat.ID, f.worker, "acp-session-1", "")

	// Push the deadline into the past the way a dead worker's clock would: the
	// lease was real, nobody renewed it, and time is the only thing that changed.
	f.exec(t, `
		UPDATE conversation_turns SET lease_expires_at = now() - interval '20 seconds'
		WHERE id = $1::uuid`, turn)

	r := NewReconciler(f.pool, ReconcilerConfig{
		LeaseSafety:     time.Second,
		WorkerHeartbeat: time.Hour, // this pass must not fire: the worker is alive
		Logger:          discardLog(),
	})
	res, err := r.Pass(ctx)
	if err != nil {
		t.Fatalf("Pass: %v", err)
	}
	if !res.Acquired || res.TurnsInterrupted != 1 {
		t.Fatalf("result = %+v, want one interrupted turn", res)
	}
	if res.SessionsDisconnected != 0 {
		t.Errorf("sessions disconnected = %d, want 0: a live worker keeps its binding", res.SessionsDisconnected)
	}

	row := f.read(t, `
		SELECT status, stop_reason, finished_at IS NOT NULL AS finished, lease_expires_at IS NOT NULL AS has_lease
		FROM conversation_turns WHERE id = $1::uuid`, turn)
	if row["status"] != events.TurnStatusInterrupted {
		t.Fatalf("status = %v, want interrupted", row["status"])
	}
	if row["stop_reason"] != nil {
		t.Errorf("stop_reason = %v, want NULL: nothing reported an outcome, and the schema agrees", row["stop_reason"])
	}
	if row["finished"] != true {
		t.Errorf("finished_at is null on a terminal turn (conversation_turn_terminal_is_timestamped)")
	}

	// The transcript says who was running it and which token died with them, so
	// a worker that wakes up late can be recognised as stale by anyone reading.
	var payload events.TurnInterruptedPayload
	rows := f.journalRows(t, chat.ID)
	last := rows[len(rows)-1]
	if last.typ != events.TypeConversationTurnInterrupted {
		t.Fatalf("last journal row = %s, want conversation.turn.interrupted", last.typ)
	}
	if err := json.Unmarshal(last.payload, &payload); err != nil {
		t.Fatalf("decode interrupted payload: %v", err)
	}
	if payload.Reason != events.InterruptLeaseExpired {
		t.Errorf("reason = %q, want %q", payload.Reason, events.InterruptLeaseExpired)
	}
	if payload.WorkerID != f.worker || payload.FencingToken != token {
		t.Errorf("payload = %+v, want worker %s and token %d", payload, f.worker, token)
	}
	if payload.ConversationID != chat.ID || payload.TurnID != turn {
		t.Errorf("payload scope = %+v, want this conversation and turn", payload)
	}

	// The conversation is disconnected, not idle: an owner with a turn still open
	// went away, and idle would claim the transcript was at rest.
	status := f.read(t, `SELECT status FROM conversations WHERE id = $1::uuid`, chat.ID)
	if status["status"] != "disconnected" {
		t.Errorf("conversation status = %v, want disconnected", status["status"])
	}

	// The actor is the system, because a deadline decided this and not any human
	// or agent (ADR-0016 §4).
	var actorKind, actorID string
	f.queryRow(t, `
		SELECT actor_kind, actor_id FROM domain_events
		WHERE conversation_id = $1::uuid AND type = 'conversation.turn.interrupted'`, chat.ID).
		into(t, &actorKind, &actorID)
	if actorKind != events.ActorKindSystem || actorID != "system" {
		t.Errorf("actor = %s/%s, want system/system", actorKind, actorID)
	}
}

func TestReconcilerLeavesRenewedLeaseAlone(t *testing.T) {
	f := cnvSetup(t)
	chat := f.cnvCreate(t, f.alice, "Worker is fine", "keep going")
	ctx := f.ctx()
	turn := f.mustActiveTurn(t, chat.ID)
	f.cnvClaim(t, turn, f.worker, 45*time.Second)
	f.cnvRunning(t, turn)

	// The scan would see this row: its deadline was, a moment ago, inside the
	// safety margin. The worker then renewed — the re-check inside the
	// transaction is what must notice.
	r := NewReconciler(f.pool, ReconcilerConfig{
		LeaseSafety:     60 * time.Second, // every live lease looks expired to the scan
		WorkerHeartbeat: time.Hour,
		Logger:          discardLog(),
	})
	pass := make(chan struct{})
	go func() {
		// Renew while the pass is between its scan and its write. There is no hook
		// to synchronise on, so race it deliberately: whichever order the two
		// statements land in, exactly one answer must be true afterwards — the
		// turn is either untouched and running, or interrupted with a journal row.
		time.Sleep(1 * time.Millisecond)
		if _, err := f.pool.Exec(context.Background(), `
			UPDATE conversation_turns SET lease_expires_at = now() + interval '45 seconds'
			WHERE id = $1::uuid`, turn); err != nil {
			t.Errorf("renew: %v", err)
		}
		close(pass)
	}()
	res, err := r.Pass(ctx)
	if err != nil {
		t.Fatalf("Pass: %v", err)
	}
	<-pass

	row := f.read(t, `
		SELECT status, count(*) OVER () AS n FROM conversation_turns WHERE id = $1::uuid`, turn)
	if row["status"] == events.TurnStatusInterrupted {
		// The reconciler won the race; then it must have written the honest event
		// and nothing may claim the turn silently vanished.
		var n int
		f.queryRow(t, `
			SELECT count(*) FROM domain_events
			WHERE conversation_id = $1::uuid AND type = 'conversation.turn.interrupted'`, chat.ID).into(t, &n)
		if n != 1 {
			t.Fatalf("turn interrupted with %d journal rows: a state change with no event is a gap in the transcript", n)
		}
		return
	}
	if row["status"] != events.TurnStatusRunning {
		t.Fatalf("status = %v, want running or interrupted", row["status"])
	}
	if res.TurnsInterrupted != 0 {
		t.Errorf("result = %+v although the worker renewed in time", res)
	}
}

func TestReconcilerDisconnectsSessionOfDeadWorker(t *testing.T) {
	f := cnvSetup(t)
	chat := f.cnvCreate(t, f.alice, "Worker vanished", "hello")
	ctx := f.ctx()
	binding := f.cnvAttachBinding(t, chat.ID, f.worker, "acp-session-2", "")

	// The worker stopped heartbeating: not offline by request, just silent for
	// more than three intervals, which is the same liveness rule the worker
	// listing applies.
	f.exec(t, `
		UPDATE workers SET last_heartbeat_at = now() - interval '5 minutes' WHERE id = $1::uuid`, f.worker)

	r := NewReconciler(f.pool, ReconcilerConfig{
		LeaseSafety:     time.Hour, // no turn lease is involved in this pass
		WorkerHeartbeat: 10 * time.Second,
		Logger:          discardLog(),
	})
	res, err := r.Pass(ctx)
	if err != nil {
		t.Fatalf("Pass: %v", err)
	}
	if res.SessionsDisconnected != 1 {
		t.Fatalf("result = %+v, want one disconnected session", res)
	}

	row := f.read(t, `
		SELECT status, disconnected_at IS NOT NULL AS cut FROM acp_session_bindings WHERE id = $1::uuid`, binding)
	if row["status"] != "disconnected" || row["cut"] != true {
		t.Fatalf("binding = %+v, want disconnected with disconnected_at set", row)
	}

	var payload events.SessionDisconnectedPayload
	rows := f.journalRows(t, chat.ID)
	last := rows[len(rows)-1]
	if last.typ != events.TypeAgentSessionDisconnected {
		t.Fatalf("last journal row = %s, want agent.session.disconnected", last.typ)
	}
	if err := json.Unmarshal(last.payload, &payload); err != nil {
		t.Fatalf("decode disconnected payload: %v", err)
	}
	if payload.Reason != events.InterruptWorkerGone || payload.BindingID != binding || payload.ACPSessionID != "acp-session-2" {
		t.Errorf("payload = %+v, want worker_gone for this binding and session", payload)
	}

	// The unique partial index that means "one live agent per conversation" is
	// released, so a replacement worker can attach — the resume path the ADR
	// describes is now reachable rather than blocked by a phantom session.
	var live int
	f.queryRow(t, `
		SELECT count(*) FROM acp_session_bindings
		WHERE conversation_id = $1::uuid AND status = 'connected'`, chat.ID).into(t, &live)
	if live != 0 {
		t.Errorf("live bindings = %d, want 0", live)
	}
	status := f.read(t, `SELECT status FROM conversations WHERE id = $1::uuid`, chat.ID)
	if status["status"] != "disconnected" {
		t.Errorf("conversation status = %v, want disconnected", status["status"])
	}

	// A second pass finds nothing: the pass is idempotent against its own output.
	again, err := r.Pass(ctx)
	if err != nil {
		t.Fatalf("second Pass: %v", err)
	}
	if again.SessionsDisconnected != 0 {
		t.Errorf("second pass disconnected %d sessions, want 0", again.SessionsDisconnected)
	}
}

func TestReconcilerExpiresUnansweredPermission(t *testing.T) {
	f := cnvSetup(t)
	chat := f.cnvCreate(t, f.alice, "Nobody answered", "go")
	ctx := f.ctx()
	turn := f.mustActiveTurn(t, chat.ID)
	f.cnvClaim(t, turn, f.worker, time.Hour)
	requestID := f.cnvAskPermission(t, f.orgID, f.project, chat.ID, turn, "acp-9", 30*time.Second)

	r := NewReconciler(f.pool, ReconcilerConfig{
		LeaseSafety:     time.Hour,
		WorkerHeartbeat: time.Hour,
		Logger:          discardLog(),
	})
	// The deadline has to be in the past for the pass to see it.
	f.exec(t, `UPDATE permission_requests SET deadline_at = now() - interval '1 second' WHERE id = $1::uuid`, requestID)
	res, err := r.Pass(ctx)
	if err != nil {
		t.Fatalf("Pass: %v", err)
	}
	if res.PermissionsExpired != 1 {
		t.Fatalf("result = %+v, want one expired prompt", res)
	}

	// permission_request_decision_is_answered forbids a decided_by on an expired
	// row, so "nobody answered" is enforced by the schema, not by this code's
	// good intentions.
	row := f.read(t, `
		SELECT status, decided_by, decision_option_id FROM permission_requests WHERE id = $1::uuid`, requestID)
	if row["status"] != events.PermissionStatusExpired {
		t.Fatalf("status = %v, want expired", row["status"])
	}
	if row["decided_by"] != nil || row["decision_option_id"] != nil {
		t.Errorf("expired prompt carries a decision: %+v", row)
	}

	var payload events.PermissionDecidedPayload
	rows := f.journalRows(t, chat.ID)
	last := rows[len(rows)-1]
	if last.typ != events.TypeConversationPermissionDecided {
		t.Fatalf("last row = %s, want permission.decided", last.typ)
	}
	if err := json.Unmarshal(last.payload, &payload); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if payload.Status != events.PermissionStatusExpired || payload.DecidedBy != "" || payload.DecisionOptionID != "" {
		t.Errorf("payload = %+v, want status expired with no answer in it", payload)
	}

	// An expired prompt is no longer answerable: the controller who finally
	// arrives must be refused rather than resurrecting a closed request.
	if _, err := f.store.DecidePermission(ctx, f.caller(f.alice), chat.ID, requestID, "allow_once"); err == nil {
		t.Errorf("an expired permission was answered")
	} else if !errors.Is(err, ErrConversationNotFound) {
		var cf *CnvConflict
		if !errors.As(err, &cf) || cf.Kind != ConflictPermissionNotPending {
			t.Errorf("answering an expired prompt = %v, want permission_not_pending", err)
		}
	}
}

// TestReconcilerRunsOnePassAtATimeAcrossReplicas is why the advisory lock is a
// session lock taken around the pass: two replicas ticking together must not
// both write, and the one that is locked out must say so by doing nothing.
func TestReconcilerRunsOnePassAtATimeAcrossReplicas(t *testing.T) {
	f := cnvSetup(t)
	chat := f.cnvCreate(t, f.alice, "Two replicas", "go")
	ctx := f.ctx()
	turn := f.mustActiveTurn(t, chat.ID)
	f.cnvClaim(t, turn, f.worker, time.Minute)
	f.exec(t, `UPDATE conversation_turns SET lease_expires_at = now() - interval '10 seconds' WHERE id = $1::uuid`, turn)

	cfg := ReconcilerConfig{LeaseSafety: time.Second, WorkerHeartbeat: time.Hour, Logger: discardLog()}
	a := NewReconciler(f.pool, cfg)
	b := NewReconciler(f.pool, cfg)
	_ = a

	// Hold the lock on a dedicated connection, as a third replica would.
	conn, err := f.pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	defer conn.Release()
	held, err := rcnTryLock(ctx, conn.Conn())
	if err != nil || !held {
		t.Fatalf("take lock: %v / %v", err, held)
	}

	res, err := b.Pass(ctx)
	if err != nil {
		t.Fatalf("locked-out Pass: %v", err)
	}
	if res.Acquired || res.TurnsInterrupted != 0 {
		t.Fatalf("locked-out result = %+v, want nothing done at all", res)
	}
	if n := f.countEvents(t, chat.ID, events.TypeConversationTurnInterrupted); n != 0 {
		t.Fatalf("the locked-out replica wrote %d journal rows", n)
	}
	if _, err := rcnUnlock(ctx, conn.Conn()); err != nil {
		t.Fatalf("unlock: %v", err)
	}

	// Now the same replica's next pass works: the lock is re-takeable, and one
	// pass still writes exactly one interrupted turn.
	res, err = b.Pass(ctx)
	if err != nil {
		t.Fatalf("Pass after release: %v", err)
	}
	if !res.Acquired || res.TurnsInterrupted != 1 {
		t.Fatalf("result after release = %+v", res)
	}
	if n := f.countEvents(t, chat.ID, events.TypeConversationTurnInterrupted); n != 1 {
		t.Errorf("interrupted rows = %d, want 1", n)
	}

	// Health reports a holder while one exists, because "is anything reconciling
	// this database at all?" is the question an operator actually has, and a
	// pass that has finished is not a holder.
	if held, err := rcnTryLock(ctx, conn.Conn()); err != nil || !held {
		t.Fatalf("hold the lock for the health probe: %v / %v", err, held)
	}
	if leader, err := a.ReconcilerHealth(ctx); err != nil {
		t.Fatalf("ReconcilerHealth: %v", err)
	} else if !leader {
		t.Errorf("health reported no leader while a session held the lock")
	}
	if _, err := rcnUnlock(ctx, conn.Conn()); err != nil {
		t.Fatalf("release for the next phase: %v", err)
	}
	gate := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		<-gate
		// A pass that finds the lock held by another connection must skip rather
		// than block: a reconciler that queues up behind its leader would be a
		// second writer waiting to happen.
		other := NewReconciler(f.pool, cfg)
		res, err := other.Pass(context.Background())
		if err != nil {
			t.Errorf("contended Pass: %v", err)
			return
		}
		if res.Acquired {
			t.Errorf("both replicas acquired the reconciler lock")
		}
	}()
	if _, err := rcnTryLock(ctx, conn.Conn()); err != nil {
		t.Fatalf("re-take lock: %v", err)
	}
	close(gate)
	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the locked-out reconciler blocked instead of skipping its tick")
	}
	if _, err := rcnUnlock(ctx, conn.Conn()); err != nil {
		t.Fatalf("final unlock: %v", err)
	}

	// Between passes nobody holds the lock, and health must say so rather than
	// claiming a leader that is not there — the false positive is the one that
	// makes an operator stop looking.
	leader, err := a.ReconcilerHealth(ctx)
	if err != nil {
		t.Fatalf("ReconcilerHealth: %v", err)
	}
	if leader {
		t.Errorf("health reported a leader with no holder anywhere")
	}
}

func TestReconcilerTickInterruptsWhatTheClockFound(t *testing.T) {
	f := cnvSetup(t)
	chat := f.cnvCreate(t, f.alice, "The tick, not the pass", "go")
	ctx := f.ctx()
	turn := f.mustActiveTurn(t, chat.ID)
	f.cnvClaim(t, turn, f.worker, time.Minute)
	f.exec(t, `UPDATE conversation_turns SET lease_expires_at = now() - interval '10 seconds' WHERE id = $1::uuid`, turn)

	run, cancel := context.WithCancel(ctx)
	defer cancel()
	r := NewReconciler(f.pool, ReconcilerConfig{
		Interval:        10 * time.Millisecond,
		LeaseSafety:     time.Second,
		WorkerHeartbeat: time.Hour,
		Logger:          discardLog(),
	})
	go func() {
		if _, err := r.Run(run); err != nil {
			t.Errorf("Run: %v", err)
		}
	}()

	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if f.countEvents(t, chat.ID, events.TypeConversationTurnInterrupted) == 1 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	row := f.read(t, `SELECT status FROM conversation_turns WHERE id = $1::uuid`, turn)
	if row["status"] != events.TurnStatusInterrupted {
		t.Fatalf("status after Run = %v, want interrupted", row["status"])
	}
	// One tick's worth of work: the same turn cannot be interrupted twice, so a
	// long-running reconciler does not rewrite history every 5 s.
	if n := f.countEvents(t, chat.ID, events.TypeConversationTurnInterrupted); n != 1 {
		t.Errorf("interrupted rows = %d, want exactly 1", n)
	}
	cancel()
}

func TestReconcilerBatchDrainsABacklogWithoutStarving(t *testing.T) {
	f := cnvSetup(t)
	ctx := f.ctx()
	var turns []string
	for i := 0; i < 5; i++ {
		chat := f.cnvCreate(t, f.alice, fmt.Sprintf("Backlog %d", i), "go")
		turn := f.mustActiveTurn(t, chat.ID)
		f.cnvClaim(t, turn, f.worker, time.Minute)
		f.exec(t, `UPDATE conversation_turns SET lease_expires_at = now() - interval '10 seconds' WHERE id = $1::uuid`, turn)
		turns = append(turns, chat.ID)
	}

	r := NewReconciler(f.pool, ReconcilerConfig{
		LeaseSafety:     time.Second,
		WorkerHeartbeat: time.Hour,
		Batch:           2,
		Logger:          discardLog(),
	})
	total := 0
	for i := 0; i < 3; i++ {
		res, err := r.Pass(ctx)
		if err != nil {
			t.Fatalf("pass %d: %v", i, err)
		}
		if res.TurnsInterrupted > 2 {
			t.Fatalf("pass %d touched %d turns, want at most the batch size 2", i, res.TurnsInterrupted)
		}
		total += res.TurnsInterrupted
	}
	if total != 5 {
		t.Errorf("interrupted %d of 5 expired turns over three passes", total)
	}
	var still []string
	rows, err := f.pool.Query(ctx, `
		SELECT id::text FROM conversation_turns WHERE status IN ('queued','leased','running')`)
	if err != nil {
		t.Fatalf("read live turns: %v", err)
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			t.Fatalf("scan: %v", err)
		}
		still = append(still, id)
	}
	if len(still) != 0 {
		t.Errorf("turns still live after the backlog drained: %v", still)
	}
	// Every one of them is in the transcript, per conversation, once.
	for _, conv := range turns {
		if n := f.countEvents(t, conv, events.TypeConversationTurnInterrupted); n != 1 {
			t.Errorf("conversation %s has %d interrupted rows, want 1", conv, n)
		}
	}
}

// TestReconcilerNeverInventsASuccessfulTurn is the ADR's honesty rule read from
// the other side: whatever the reconciler does, the transcript must not end up
// claiming the agent finished, and the words it uses must be the ones the
// compatibility documents reserve for observed failure.
func TestReconcilerNeverInventsASuccessfulTurn(t *testing.T) {
	f := cnvSetup(t)
	chat := f.cnvCreate(t, f.alice, "Dead worker, tidy log", "go")
	ctx := f.ctx()
	turn := f.mustActiveTurn(t, chat.ID)
	f.cnvClaim(t, turn, f.worker, time.Minute)
	f.cnvRunning(t, turn)
	f.cnvAttachBinding(t, chat.ID, f.worker, "acp-session-3", "")
	f.exec(t, `
		UPDATE conversation_turns SET lease_expires_at = now() - interval '10 seconds' WHERE id = $1::uuid`, turn)
	f.exec(t, `UPDATE workers SET last_heartbeat_at = now() - interval '5 minutes' WHERE id = $1::uuid`, f.worker)

	r := NewReconciler(f.pool, ReconcilerConfig{
		LeaseSafety:     time.Second,
		WorkerHeartbeat: 10 * time.Second,
		Logger:          discardLog(),
	})
	if _, err := r.Pass(ctx); err != nil {
		t.Fatalf("Pass: %v", err)
	}

	types := cnvTypes(f.journalRows(t, chat.ID))
	joined := strings.Join(types, " ")
	for _, forbidden := range []string{
		events.TypeConversationTurnCompleted,
		events.TypeConversationMessageAgent,
		"resumed",
	} {
		if strings.Contains(joined, forbidden) {
			t.Errorf("journal = %v: %q appears although nobody reported it", types, forbidden)
		}
	}
	if !strings.Contains(joined, events.TypeConversationTurnInterrupted) {
		t.Errorf("journal = %v, want the honest terminal state", types)
	}
	// Exactly one terminal turn event closes a turn, even with two passes firing
	// at once: the interrupt is the terminal one and the disconnect only reports
	// the session.
	terminals := 0
	for _, typ := range types {
		if strings.Contains(typ, ".completed") || strings.Contains(typ, ".failed") ||
			strings.Contains(typ, ".cancelled") || strings.Contains(typ, ".interrupted") {
			terminals++
		}
	}
	if terminals != 1 {
		t.Errorf("terminal turn events = %d in %v, want exactly 1", terminals, types)
	}
}

func (f *cnvFixture) countEvents(t *testing.T, conversationID, typ string) int {
	t.Helper()
	var n int
	f.queryRow(t, `
		SELECT count(*) FROM domain_events WHERE conversation_id = $1::uuid AND type = $2`,
		conversationID, typ).into(t, &n)
	return n
}

func discardLog() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

// rcnIsShutdown is the difference between "the reconciler could not do its job"
// and "somebody stopped it", and the two used to be reported identically: a tick
// cut short by a cancel came back as `turn-lease reconciler gave up after N
// failing passes`, which is both false and — because every Run in a test ends
// that way — a flake. The M2 integrated lab run hit exactly this: the whole
// suite under -race failed this test while the focused re-run passed it.
func TestReconcilerShutdownIsNotAFailingPass(t *testing.T) {
	f := cnvSetup(t)
	chat := f.cnvCreate(t, f.alice, "Stopped, not broken", "go")
	ctx := f.ctx()

	dead, err := Open(ctx, mustMigrate(t))
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	dead.Close() // every Pass now fails with "pool has been closed"
	r := NewReconciler(dead, ReconcilerConfig{
		Interval: 5 * time.Millisecond, LeaseSafety: time.Second,
		WorkerHeartbeat: time.Hour, Logger: discardLog(),
	})

	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := r.Run(cancelled); err != nil {
		t.Errorf("Run over a cancelled context = %v, want nil: a reconciler that was "+
			"stopped did not give up on anything", err)
	}

	// The other half, on the same dead pool: failing passes with a live context
	// are a real problem and must still be reported, with their count.
	running, stop := context.WithTimeout(ctx, 120*time.Millisecond)
	defer stop()
	if _, err := r.Run(running); err == nil {
		t.Error("Run over a dead pool with a live context returned nil, want a report")
	} else if !strings.Contains(err.Error(), "failing passes") {
		t.Errorf("Run error = %v, want the failing-pass report", err)
	}

	if n := f.countEvents(t, chat.ID, events.TypeConversationTurnInterrupted); n != 0 {
		t.Errorf("journal rows = %d, want 0: neither reconciler here had a working pool", n)
	}
}
