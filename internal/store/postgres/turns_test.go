package postgres

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dbirks/communication/internal/domain"
	"github.com/dbirks/communication/internal/events"
	"github.com/dbirks/communication/internal/worker"
)

// Integration tests for the worker's fenced turn store against a real
// database (migrations 00001..00003 applied). They prove the two properties
// ADR-0016 says the worker must not fake: exactly-one claim under
// contention, and provably-stale writers rejected — no partial writes, no
// terminal event, nothing.

type trnFixture struct {
	ProjectID, UserID, ProfileID, ConvID string
	WorkerA, WorkerB                     string
	Store                                *TurnStore
}

func trnSetup(t *testing.T) (*pgxpool.Pool, trnFixture) {
	t.Helper()
	ctx := testCtx(t)
	pool, err := Open(ctx, mustMigrate(t))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(pool.Close)
	f := trnFixture{Store: &TurnStore{Pool: pool}}
	f.ProjectID, f.UserID, f.ProfileID = migM2Fixture(t, ctx, pool)
	f.WorkerA = migM2Worker(t, ctx, pool, "trn-a")
	f.WorkerB = migM2Worker(t, ctx, pool, "trn-b")
	f.ConvID = migM2Conversation(t, ctx, pool, f.ProjectID, f.UserID, f.ProfileID, "trn "+fmt.Sprint(time.Now().UnixNano()))
	// Registered last so it runs FIRST (LIFO): cascade the rows this
	// package's tests create — outbox references events; permissions and
	// turns reference workers — so the generic helper cleanups finish.
	convID := f.ConvID
	t.Cleanup(func() {
		bg := context.Background()
		for _, q := range []string{
			"DELETE FROM outbox WHERE global_seq IN (SELECT global_seq FROM domain_events WHERE conversation_id = $1)",
			"DELETE FROM domain_events WHERE conversation_id = $1",
			"DELETE FROM permission_requests WHERE conversation_id = $1",
			"DELETE FROM acp_session_bindings WHERE conversation_id = $1",
			"DELETE FROM conversation_turns WHERE conversation_id = $1",
		} {
			if _, err := pool.Exec(bg, q, convID); err != nil {
				t.Errorf("trn cleanup %q: %v", q, err)
			}
		}
	})
	return pool, f
}

func (f trnFixture) queueTurn(t *testing.T, prompt string) string {
	t.Helper()
	var id string
	if err := f.Store.Pool.QueryRow(context.Background(), `
		INSERT INTO conversation_turns (conversation_id, prompt, submitted_by)
		VALUES ($1, $2, $3) RETURNING id::text`, f.ConvID, prompt, f.UserID).Scan(&id); err != nil {
		t.Fatalf("queue turn: %v", err)
	}
	return id
}

func trnSession(origin string) domain.SessionInfo {
	return domain.SessionInfo{
		ACPSessionID: "acp-e2e-1", ProtocolVersion: 1,
		AgentCapabilities: map[string]any{"loadSession": true},
		LauncherID:        "claude", LauncherVersion: "0.90.0",
		Origin: origin,
	}
}

// TestTurnsClaimContention: two worker loops race for one queued turn over
// a real database; exactly one claim wins (FOR UPDATE SKIP LOCKED), and the
// loser's claim is not an error.
func TestTurnsClaimContention(t *testing.T) {
	pool, f := trnSetup(t)
	ctx := testCtx(t)
	turnID := f.queueTurn(t, "contended prompt")

	var wg sync.WaitGroup
	var wins atomic.Int32
	owners := make(chan string, 2)
	start := make(chan struct{})
	for _, w := range []string{f.WorkerA, f.WorkerB} {
		wg.Add(1)
		go func(workerID string) {
			defer wg.Done()
			<-start
			claim, ok, err := f.Store.ClaimTurn(ctx, workerID)
			if err != nil {
				t.Errorf("ClaimTurn(%s): %v", workerID, err)
				return
			}
			if ok {
				wins.Add(1)
				owners <- workerID
				if claim.TurnID != turnID || claim.Prompt != "contended prompt" || claim.FencingToken <= 0 {
					t.Errorf("claim = %+v", claim)
				}
			}
		}(w)
	}
	close(start)
	wg.Wait()

	var dbOwner string
	var tok int64
	if err := pool.QueryRow(ctx,
		`SELECT worker_id::text, fencing_token FROM conversation_turns WHERE id = $1`, turnID).
		Scan(&dbOwner, &tok); err != nil {
		t.Fatalf("read turn row: %v", err)
	}
	if wins.Load() != 1 {
		close(owners)
		var observed []string
		for o := range owners {
			observed = append(observed, o)
		}
		t.Fatalf("%d workers reported claiming one turn (%v; row owner %s token %d)",
			wins.Load(), observed, dbOwner, tok)
	}
	if w := <-owners; w != dbOwner {
		t.Errorf("claimer %s is not the row owner %s", w, dbOwner)
	}
}

// TestTurnsStaleFenceRejected proves obligation 2 fail-closed end to end:
// after a second claim draws a higher token, the first holder's renew,
// transcript append, cancel poll, terminal write and permission open are
// all ErrLeaseLost, and none of them wrote anything.
func TestTurnsStaleFenceRejected(t *testing.T) {
	pool, f := trnSetup(t)
	ctx := testCtx(t)
	turnID := f.queueTurn(t, "fenced prompt")

	stale, ok, err := f.Store.ClaimTurn(ctx, f.WorkerA)
	if err != nil || !ok {
		t.Fatalf("first claim: ok=%v err=%v", ok, err)
	}
	if err := f.Store.BeginTurn(ctx, stale, "b-1", trnSession("new")); err != nil {
		t.Fatalf("BeginTurn: %v", err)
	}
	// The contract invalidates a stale holder by drawing a higher fencing
	// token (a reclaim) or by the reconciler interrupting the turn; here we
	// take the token path directly, which is what the fenced writes check.
	var newTok int64
	if err := pool.QueryRow(ctx, `
		UPDATE conversation_turns
		SET fencing_token = fencing_token + 1,
		    worker_id = $2,
		    lease_expires_at = now() + interval '30 seconds'
		WHERE id = $1 RETURNING fencing_token`, turnID, f.WorkerB).Scan(&newTok); err != nil {
		t.Fatalf("reclaim: %v", err)
	}
	fresh := stale
	fresh.WorkerID = f.WorkerB
	fresh.FencingToken = newTok
	if fresh.FencingToken <= stale.FencingToken {
		t.Fatalf("fencing token not monotonic: %d then %d", stale.FencingToken, fresh.FencingToken)
	}

	before := trnCountEvents(ctx, t, pool, f.ConvID)

	if err := f.Store.RenewLease(ctx, stale); !errors.Is(err, worker.ErrLeaseLost) {
		t.Errorf("stale RenewLease err = %v, want ErrLeaseLost", err)
	}
	if _, _, err := f.Store.CancelRequested(ctx, stale); !errors.Is(err, worker.ErrLeaseLost) {
		t.Errorf("stale CancelRequested err = %v, want ErrLeaseLost", err)
	}
	err = f.Store.AppendTurnEvent(ctx, stale, worker.TurnEvent{
		Type: events.TypeConversationMessageAgent, ActorKind: events.ActorKindWorker, ActorID: f.WorkerA,
		Payload: events.MessageAgentPayload{ConversationID: f.ConvID, TurnID: turnID, ChunkSeq: 1, Text: "ghost"},
	})
	if !errors.Is(err, worker.ErrLeaseLost) {
		t.Errorf("stale AppendTurnEvent err = %v, want ErrLeaseLost", err)
	}
	err = f.Store.FinishTurn(ctx, stale, worker.TurnOutcome{Status: events.TurnStatusCompleted, StopReason: "end_turn"})
	if !errors.Is(err, worker.ErrLeaseLost) {
		t.Errorf("stale FinishTurn err = %v, want ErrLeaseLost", err)
	}
	_, err = f.Store.OpenPermission(ctx, stale, worker.PermissionOpen{ACPRequestID: "ghost", Title: "x"})
	if !errors.Is(err, worker.ErrLeaseLost) {
		t.Errorf("stale OpenPermission err = %v, want ErrLeaseLost", err)
	}
	if _, err := pool.Exec(ctx,
		`UPDATE conversation_turns SET cancel_requested_at = now() WHERE id = $1 AND worker_id = $2`,
		turnID, f.WorkerB); err != nil {
		t.Fatalf("set cancel: %v", err)
	}
	if err := f.Store.FinishTurn(ctx, stale, worker.TurnOutcome{Status: events.TurnStatusCancelled}); !errors.Is(err, worker.ErrLeaseLost) {
		t.Errorf("stale FinishTurn(cancelled) err = %v, want ErrLeaseLost", err)
	}

	if after := trnCountEvents(ctx, t, pool, f.ConvID); after != before {
		t.Errorf("stale writes added %d journal rows (before %d after %d)", after-before, before, after)
	}
	var status string
	if err := pool.QueryRow(ctx, `SELECT status FROM conversation_turns WHERE id = $1`, turnID).Scan(&status); err != nil {
		t.Fatalf("read status: %v", err)
	}
	if status != events.TurnStatusRunning {
		t.Errorf("turn status after stale writes = %q, want running (fresh owner untouched)", status)
	}

	// The fresh owner still works normally.
	if err := f.Store.RenewLease(ctx, fresh); err != nil {
		t.Errorf("fresh RenewLease: %v", err)
	}
	if err := f.Store.FinishTurn(ctx, fresh, worker.TurnOutcome{Status: events.TurnStatusCompleted, StopReason: "end_turn"}); err != nil {
		t.Fatalf("fresh FinishTurn: %v", err)
	}
	var found bool
	rows, err := pool.Query(ctx, `
		SELECT 1 FROM domain_events WHERE conversation_id = $1 AND type = $2`,
		f.ConvID, events.TypeConversationTurnCompleted)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	for rows.Next() {
		found = true
	}
	if !found {
		t.Error("completed turn wrote no conversation.turn.completed with conversation_id")
	}
}

func trnCountEvents(ctx context.Context, t *testing.T, pool *pgxpool.Pool, convID string) int64 {
	t.Helper()
	var n int64
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM domain_events WHERE conversation_id = $1`, convID).Scan(&n); err != nil {
		t.Fatalf("count events: %v", err)
	}
	return n
}

// TestTurnsTranscriptAndBindingsRoundtrip proves the worker writes the
// contract's rows: begin appends turn.started + message.user under the
// conversation scope, RecordBinding closes a stale live binding, the
// permission open→decide→read flow works, cancel is visible to the owner,
// and the transcript order matches the turn lifecycle.
func TestTurnsTranscriptAndBindingsRoundtrip(t *testing.T) {
	pool, f := trnSetup(t)
	ctx := testCtx(t)
	turnID := f.queueTurn(t, "tell me about repo x")

	claim, ok, err := f.Store.ClaimTurn(ctx, f.WorkerA)
	if err != nil || !ok {
		t.Fatalf("claim: %v %v", ok, err)
	}
	if claim.LauncherID != "claude" || claim.PermissionMode != "ask" || claim.SubmittedBy != f.UserID {
		t.Fatalf("claim detail = %+v", claim)
	}
	if claim.ProjectID != f.ProjectID {
		t.Fatalf("claim project = %q, want %q", claim.ProjectID, f.ProjectID)
	}

	// A stale connected binding from a previous (dead) session of this same
	// worker is closed by RecordBinding; the new row becomes the single
	// live binding.
	var staleBinding string
	if err := pool.QueryRow(ctx, `
		INSERT INTO acp_session_bindings (conversation_id, worker_id, acp_session_id, protocol_version, launcher_id)
		VALUES ($1, $2, 'old-acp-session', 1, 'claude') RETURNING id::text`, f.ConvID, f.WorkerA).
		Scan(&staleBinding); err != nil {
		t.Fatalf("seed stale binding: %v", err)
	}
	bindingID, closedPrior, err := f.Store.RecordBinding(ctx, claim, trnSession("new"))
	if err != nil {
		t.Fatalf("RecordBinding: %v", err)
	}
	if len(closedPrior) != 1 || closedPrior[0] != staleBinding {
		t.Fatalf("closedPrior = %v, want [%s]", closedPrior, staleBinding)
	}
	var liveCount int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM acp_session_bindings WHERE conversation_id = $1 AND status = 'connected'`,
		f.ConvID).Scan(&liveCount); err != nil {
		t.Fatal(err)
	}
	if liveCount != 1 {
		t.Errorf("live bindings = %d, want exactly 1", liveCount)
	}

	if err := f.Store.BeginTurn(ctx, claim, bindingID, trnSession("new")); err != nil {
		t.Fatalf("BeginTurn: %v", err)
	}
	var convStatus string
	if err := pool.QueryRow(ctx, `SELECT status FROM conversations WHERE id = $1`, f.ConvID).Scan(&convStatus); err != nil {
		t.Fatal(err)
	}
	if convStatus != "active" {
		t.Errorf("conversation status = %q, want active", convStatus)
	}

	if err := f.Store.AppendTurnEvent(ctx, claim, worker.TurnEvent{
		Type: events.TypeConversationMessageAgent, ActorKind: events.ActorKindWorker, ActorID: f.WorkerA,
		Payload: events.MessageAgentPayload{ConversationID: f.ConvID, TurnID: turnID, ChunkSeq: 1, Text: "hello there"},
	}); err != nil {
		t.Fatalf("AppendTurnEvent: %v", err)
	}

	permID, err := f.Store.OpenPermission(ctx, claim, worker.PermissionOpen{
		ACPRequestID: "tc-9-1", ToolCallID: "tc-9", Title: "Write hello.txt", Kind: "edit",
		Options:  []events.PermissionOption{{OptionID: "allow-once", Label: "Yes", Kind: "allow_once"}},
		Deadline: time.Now().Add(time.Minute),
	})
	if err != nil {
		t.Fatalf("OpenPermission: %v", err)
	}
	// The controller decides out of band (here: plain SQL, exactly as the
	// no-API test plan resolves prompts).
	if _, err := pool.Exec(ctx, `
		UPDATE permission_requests SET status = 'decided', decided_by = $2, decision_option_id = 'allow-once', decided_at = now()
		WHERE id = $1`, permID, f.UserID); err != nil {
		t.Fatalf("decide permission: %v", err)
	}
	st, err := f.Store.PermissionState(ctx, permID)
	if err != nil {
		t.Fatalf("PermissionState: %v", err)
	}
	if st.Status != events.PermissionStatusDecided || st.OptionID != "allow-once" || st.DecidedBy != f.UserID {
		t.Fatalf("permission state after decision = %+v", st)
	}
	// A late expiry attempt must not rewrite the decision.
	final, closedNow, err := f.Store.ClosePermission(ctx, claim, permID, events.PermissionStatusExpired)
	if err != nil {
		t.Fatalf("ClosePermission: %v", err)
	}
	if closedNow || final.Status != events.PermissionStatusDecided || final.OptionID != "allow-once" {
		t.Fatalf("ClosePermission rewrote a decision: closed=%v final=%+v", closedNow, final)
	}

	// Cancel becomes visible to its owner.
	if _, err := pool.Exec(ctx, `UPDATE conversation_turns SET cancel_requested_at = now() WHERE id = $1`, turnID); err != nil {
		t.Fatalf("request cancel: %v", err)
	}
	at, wanted, err := f.Store.CancelRequested(ctx, claim)
	if err != nil || !wanted || at.IsZero() {
		t.Fatalf("CancelRequested = %v %v %v", at, wanted, err)
	}

	// Honest terminal.
	if err := f.Store.FinishTurn(ctx, claim, worker.TurnOutcome{Status: events.TurnStatusCancelled, StopReason: "cancelled", RequestedBy: f.UserID}); err != nil {
		t.Fatalf("FinishTurn: %v", err)
	}
	var status, stop string
	var finished bool
	if err := pool.QueryRow(ctx,
		`SELECT status, stop_reason, finished_at IS NOT NULL FROM conversation_turns WHERE id = $1`, turnID).
		Scan(&status, &stop, &finished); err != nil {
		t.Fatal(err)
	}
	if status != "cancelled" || stop != "cancelled" || !finished {
		t.Errorf("turn row = (%q,%q,%v)", status, stop, finished)
	}

	// The transcript is the journal, conversation-scoped and in order.
	want := []string{
		events.TypeConversationTurnStarted, events.TypeConversationMessageUser,
		events.TypeConversationMessageAgent, events.TypeConversationPermissionRequested,
		events.TypeConversationTurnCancelled,
	}
	rows, err := pool.Query(ctx, `
		SELECT type FROM domain_events WHERE conversation_id = $1 ORDER BY global_seq`, f.ConvID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var gotSeq []string
	for rows.Next() {
		var ty string
		if err := rows.Scan(&ty); err != nil {
			t.Fatal(err)
		}
		gotSeq = append(gotSeq, ty)
	}
	if strings.Join(gotSeq, ",") != strings.Join(want, ",") {
		t.Errorf("transcript order = %v, want %v", gotSeq, want)
	}

	// Every conversation event also carries the project (superset rule).
	var missing int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM domain_events WHERE conversation_id = $1 AND project_id IS DISTINCT FROM $2::uuid`,
		f.ConvID, f.ProjectID).Scan(&missing); err != nil {
		t.Fatal(err)
	}
	if missing != 0 {
		t.Errorf("%d conversation events lack the project scope", missing)
	}
}

// TestTurnsResumableSession proves resume info is only offered when the
// recorded capabilities advertised loadSession, and only to the worker that
// held the session.
func TestTurnsResumableSession(t *testing.T) {
	pool, f := trnSetup(t)
	ctx := testCtx(t)

	if _, ok, err := f.Store.ResumableSession(ctx, f.ConvID, f.WorkerA); ok || err != nil {
		t.Fatalf("resumable with no binding: ok=%v err=%v", ok, err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO acp_session_bindings (conversation_id, worker_id, acp_session_id, protocol_version, agent_capabilities, launcher_id)
		VALUES ($1, $2, 'resume-me', 1, '{"loadSession": true}', 'claude')`, f.ConvID, f.WorkerA); err != nil {
		t.Fatalf("seed binding: %v", err)
	}
	info, ok, err := f.Store.ResumableSession(ctx, f.ConvID, f.WorkerA)
	if err != nil || !ok || info.ACPSessionID != "resume-me" {
		t.Fatalf("resumable = %+v %v %v", info, ok, err)
	}
	if _, ok, _ := f.Store.ResumableSession(ctx, f.ConvID, f.WorkerB); ok {
		t.Error("worker B was offered worker A's session to resume")
	}
	if _, err := pool.Exec(ctx, `UPDATE acp_session_bindings SET status = 'closed', disconnected_at = now() WHERE conversation_id = $1`,
		f.ConvID); err != nil {
		t.Fatalf("close bindings: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO acp_session_bindings (conversation_id, worker_id, acp_session_id, protocol_version, agent_capabilities, launcher_id)
		VALUES ($1, $2, 'no-load', 1, '{}', 'claude')`, f.ConvID, f.WorkerB); err != nil {
		t.Fatalf("seed binding: %v", err)
	}
	if _, ok, _ := f.Store.ResumableSession(ctx, f.ConvID, f.WorkerB); ok {
		t.Error("a binding without an advertised loadSession was offered for resume")
	}
}

// TestTurnsSessionEventsCarryConversationScope proves the unfenced-but-
// scoped conversation append used by agent.session.* events resolves org and
// project from the conversation itself.
func TestTurnsSessionEventsCarryConversationScope(t *testing.T) {
	pool, f := trnSetup(t)
	ctx := testCtx(t)
	err := f.Store.AppendConversationEvent(ctx, f.ConvID, worker.TurnEvent{
		Type: events.TypeAgentSessionConnected, ActorKind: events.ActorKindWorker, ActorID: f.WorkerA,
		Payload: events.SessionConnectedPayload{
			ConversationID: f.ConvID, BindingID: "b-1", WorkerID: f.WorkerA,
			ACPSessionID: "s-1", ProtocolVersion: 1, LauncherID: "claude", SessionOrigin: "new",
		},
	})
	if err != nil {
		t.Fatalf("AppendConversationEvent: %v", err)
	}
	var project, conv string
	if err := pool.QueryRow(ctx, `
		SELECT COALESCE(project_id::text,''), COALESCE(conversation_id::text,'')
		FROM domain_events WHERE type = $1 AND actor_id = $2`,
		events.TypeAgentSessionConnected, f.WorkerA).Scan(&project, &conv); err != nil {
		t.Fatalf("read session event: %v", err)
	}
	if project != f.ProjectID || conv != f.ConvID {
		t.Errorf("session event scoped to project=%q conversation=%q, want %q/%q", project, conv, f.ProjectID, f.ConvID)
	}
}
