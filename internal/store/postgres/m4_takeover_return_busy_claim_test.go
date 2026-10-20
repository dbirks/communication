package postgres

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/dbirks/communication/internal/events"
	"github.com/dbirks/communication/internal/worker"
)

// TestM4TakeoverReturnWithActiveHumanTurnDefersTheRetryClaim is the live
// lab journey that failed 2 of the last 3 takeovers (attempts failed
// error_class=infra: "conversation still carries a non-terminal turn"):
// the factory controls the conversation, the human takes control (the
// attempt's turn is cancel-requested and the worker closes it), the human
// QUEUES A PROMPT and returns the wheel before that prompt's turn reached
// its terminal — and the resumed retry's claim then stamps its own turn
// into the slot the human's still-active turn holds.
//
// The DB timeline proves the takeover path wrote attempt 1's terminal
// (conversation.turn.cancelled exists, the row is 'cancelled'): the
// non-terminal turn at claim time is the HUMAN's. ADR-0016 § 5 is the rule
// the fix follows: "Nobody may send a second prompt before that terminal
// event, and the DB will not allow one (one-active-turn index)" — so the
// one-active refusal is a deferral the retry claim waits out, not a
// failure: the seam names it worker.ErrAttemptConversationBusy and the
// executor (agentturn.conversationForReady) polls until the slot opens,
// with the attempt lease renewing underneath. return-control never cancels
// the human's turn (ADR-0016 § 5: "It never cancels a turn — stopping
// work is cancel's job"), so the test closes it as its own worker would:
// completed{end_turn}.
func TestM4TakeoverReturnWithActiveHumanTurnDefersTheRetryClaim(t *testing.T) {
	f, store, runID, claim, conversationID, _ := m4TakeoverAttempt(t)
	ctx := testCtx(t)
	caller := Caller{UserID: f.userID, OrganizationID: f.orgID, IsOrgAdmin: true}
	cnv := &CnvStore{Pool: f.pool}
	sessions := &AttemptSessions{Runs: f.runs}

	controlVersion := func() int {
		var v int
		if err := f.pool.QueryRow(ctx, `
			SELECT version FROM conversation_control WHERE conversation_id = $1::uuid`,
			conversationID).Scan(&v); err != nil {
			t.Fatalf("read control version: %v", err)
		}
		return v
	}

	// --- takeover: the attempt ends interrupted, its turn cancelled -------
	if _, err := cnv.TakeControl(ctx, caller, conversationID, controlVersion()); err != nil {
		t.Fatalf("TakeControl: %v", err)
	}
	// The worker's honest close of the taken-over turn (ADR-0016 § 5 makes
	// that terminal the worker's; the live journey's journal shows exactly
	// this write before the human's prompt exists).
	if err := store.CloseAttemptTurnCancelled(ctx, claim); err != nil {
		t.Fatalf("CloseAttemptTurnCancelled: %v", err)
	}

	// --- the human drives, then returns the wheel mid-prompt --------------
	if _, err := f.pool.Exec(ctx, `
		INSERT INTO conversation_turns (conversation_id, prompt, submitted_by)
		VALUES ($1::uuid, $2, $3::uuid)`, conversationID,
		"please also check the README mentions add()", f.userID); err != nil {
		t.Fatalf("queue the human's prompt: %v", err)
	}
	if _, err := cnv.ReturnControl(ctx, caller, conversationID, controlVersion()); err != nil {
		t.Fatalf("ReturnControl: %v", err)
	}
	if kind := m4TakeoverRow(t, f, `
		SELECT controller_kind FROM conversation_control WHERE conversation_id = $1::uuid`,
		conversationID); kind != events.ControllerKindRunAttempt {
		t.Fatalf("control kind after return = %s, want run_attempt", kind)
	}
	// The advancer takes the resumed run running; the retry attempt is what
	// the second worker claims.
	if _, err := f.pool.Exec(ctx, `
		UPDATE runs SET status = 'running' WHERE id = $1::uuid`, runID); err != nil {
		t.Fatalf("resume the run: %v", err)
	}
	worker2ID := m4Worker(t, ctx, f.pool, "takeover-return", 1)
	// This cleanup registers AFTER m4Worker's own, so it runs first (LIFO):
	// the claim's stamp may hold the turn's worker_id FK when the row goes,
	// and the fixture's conversation sweep (registered earlier) leaves later
	// than this worker's delete would need it to.
	t.Cleanup(func() {
		bg := context.Background()
		if _, err := f.pool.Exec(bg, `UPDATE attempts SET conversation_id = NULL, turn_id = NULL WHERE worker_id = $1::uuid`, worker2ID); err != nil {
			t.Errorf("cleanup attempt stamps by worker: %v", err)
		}
		if _, err := f.pool.Exec(bg, `DELETE FROM conversation_turns WHERE worker_id = $1::uuid`, worker2ID); err != nil {
			t.Errorf("cleanup turns by worker: %v", err)
		}
	})
	claims, err := store.ClaimAttempts(ctx, worker2ID, 1)
	if err != nil || len(claims) != 1 {
		t.Fatalf("retry claim = (%v, %v), want the handback attempt", claims, err)
	}
	if claims[0].AttemptNumber != 2 {
		t.Fatalf("claimed attempt number = %d, want 2 (the takeover retry)", claims[0].AttemptNumber)
	}

	// --- the claim's stamp hits the human's still-queued turn --------------
	// This is the refusal that failed the node in the live journey: before
	// the fix it came back as an untyped fatal (the worker failed the
	// attempt error_class=infra and the node went failed), now it is the
	// typed deferral the executor waits out.
	_, ok, stampErr := sessions.ConversationFor(ctx, claims[0])
	if !errors.Is(stampErr, worker.ErrAttemptConversationBusy) {
		t.Fatalf("stamp with the human's turn active = (%v, %v), want worker.ErrAttemptConversationBusy: %v",
			ok, stampErr == nil, stampErr)
	}
	// The refusal stamped nothing: the fenced transaction rolled back whole.
	if st := m4TakeoverRow(t, f, `
		SELECT coalesce(conversation_id::text, coalesce(turn_id::text, ''))
		FROM attempts WHERE id = $1::uuid`, claims[0].AttemptID); st != "" {
		t.Errorf("busy stamp left a partial pair on attempt 2: %q, want nothing stamped", st)
	}

	// --- the human's turn reaches its terminal on its own ------------------
	// The worker running it (or the reconciler's lease arm) closes it; the
	// claim never writes a turn vocabulary it does not own.
	if _, err := f.pool.Exec(ctx, `
		UPDATE conversation_turns
		SET status = 'completed', stop_reason = 'end_turn', finished_at = now()
		WHERE conversation_id = $1::uuid AND node_attempt_id IS NULL`, conversationID); err != nil {
		t.Fatalf("close the human's turn: %v", err)
	}

	// --- the retry claim re-derives the same stamp under the open slot -----
	conv, ok, err := sessions.ConversationFor(ctx, claims[0])
	if err != nil || !ok || conv.ConversationID == "" || conv.TurnID == "" {
		t.Fatalf("stamp after the slot opened = (%v, %v, %v), want the stamped pair", conv, ok, err)
	}
	if conv.ConversationID != conversationID {
		t.Errorf("retry stamped conversation %s, want the node's existing conversation %s (retry continuity, contract § 4 step 6)",
			conv.ConversationID, conversationID)
	}
	// The pair is stamped on the attempt row and the turn is the attempt's
	// own (node_attempt_id set, leased under the claim's triple) — and only
	// one active turn exists in the conversation, by the index.
	if n := m4TakeoverRow(t, f, `
		SELECT count(*)::text FROM conversation_turns
		WHERE conversation_id = $1::uuid AND status IN ('queued', 'leased', 'running')`,
		conversationID); n != "1" {
		t.Errorf("active turns after the stamp = %s, want exactly 1 (the attempt's own)", n)
	}
	if st := m4TakeoverRow(t, f, `
		SELECT status FROM conversation_turns WHERE id = $1::uuid`, conv.TurnID); st != "leased" {
		t.Errorf("attempt 2's turn status = %s, want leased (stamped on the claim's triple)", st)
	}
	if kind, holder := func() (string, string) {
		var k, h string
		if err := f.pool.QueryRow(ctx, `
			SELECT controller_kind, coalesce(controller_run_attempt_id::text, '')
			FROM conversation_control WHERE conversation_id = $1::uuid`,
			conversationID).Scan(&k, &h); err != nil {
			t.Fatal(err)
		}
		return k, h
	}(); kind != events.ControllerKindRunAttempt || holder != claims[0].AttemptID {
		t.Errorf("control after the stamp = (%s, %s), want (run_attempt, %s)", kind, holder, claims[0].AttemptID)
	}
	// And the retry_context the return recorded still names the human's
	// intervention — the wait changed nothing about what the retry sees.
	if rc := m4TakeoverRow(t, f, `
		SELECT coalesce(retry_context::text, '') FROM attempts WHERE id = $1::uuid`,
		claims[0].AttemptID); !strings.Contains(rc, "human_takeover") {
		t.Errorf("retry_context = %q, want the human_takeover intervention recorded", rc)
	}
}
