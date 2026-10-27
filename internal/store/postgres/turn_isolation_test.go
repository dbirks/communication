package postgres

// Test isolation for the conversation-turn tests. TurnStore.ClaimTurn is a
// GLOBAL FIFO over every queued turn in the database (ADR-0016 §3 pins the
// claim statement; that is production semantics and stays). So a test that
// queues a turn and never claims it hands that turn to whichever test claims
// next — order- and filter-dependent failures. Two rules keep the package
// honest:
//
//   1. A test that queues a turn it never claims settles it in t.Cleanup
//     (settleQueuedTurns below), scoped to the rows that test created.
//   2. A test that claims turns asserts the claim is its own
//     (claimOwnTurn below) and fails loudly, naming the stray turn, rather
//     than silently skipping someone else's work.

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dbirks/communication/internal/worker"
)

// settleQueuedTurns registers cleanups that cancel every still-queued turn
// of the given conversations once the test ends, so nothing queued outlives
// the test that queued it. Rows this test already claimed, finished or
// deleted are untouched (status = 'queued' only). Call it right after
// queueing (e.g. a CreateConversation whose prompt enqueues a turn).
func settleQueuedTurns(t *testing.T, pool *pgxpool.Pool, conversationIDs ...string) {
	t.Helper()
	for _, convID := range conversationIDs {
		if convID == "" {
			continue
		}
		convID := convID
		t.Cleanup(func() {
			bg, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			tag, err := pool.Exec(bg, `
				UPDATE conversation_turns
				SET status = 'cancelled', stop_reason = 'cancelled',
				    cancel_requested_at = COALESCE(cancel_requested_at, now()),
				    finished_at = now()
				WHERE conversation_id = $1::uuid AND status = 'queued'`, convID)
			if err != nil {
				t.Errorf("settle queued turns of conversation %s: %v", convID, err)
			} else if tag.RowsAffected() > 0 {
				t.Logf("settled %d unclaimed queued turn(s) of conversation %s",
					tag.RowsAffected(), convID)
			}
		})
	}
}

// trnTurnSummary describes one turn for a stray-claim failure message: the
// prompt and conversation title are what identify the test that leaked it.
func trnTurnSummary(ctx context.Context, pool *pgxpool.Pool, turnID string) string {
	var prompt, convTitle string
	err := pool.QueryRow(ctx, `
		SELECT t.prompt, c.title
		FROM conversation_turns t
		JOIN conversations c ON c.id = t.conversation_id
		WHERE t.id = $1::uuid`, turnID).Scan(&prompt, &convTitle)
	if err != nil {
		return fmt.Sprintf("turn %s (row unreadable: %v)", turnID, err)
	}
	return fmt.Sprintf("turn %s prompt %q of conversation %q", turnID, prompt, convTitle)
}

// claimOwnTurn claims the next queued turn for workerID and requires it to be
// the turn this test queued (wantTurnID). A global-claim test that receives
// someone else's turn must fail with the stray turn's identity — the leaking
// test is the bug; looping past the stranger here would hide it.
func claimOwnTurn(t *testing.T, f trnFixture, workerID, wantTurnID string) worker.Claim {
	t.Helper()
	ctx := testCtx(t)
	claim, ok, err := f.Store.ClaimTurn(ctx, workerID)
	if err != nil || !ok {
		t.Fatalf("ClaimTurn(%s): ok=%v err=%v", workerID, ok, err)
	}
	if claim.TurnID != wantTurnID {
		t.Fatalf("ClaimTurn(%s) claimed the stray %s instead of this test's turn %s; "+
			"a test that queues a turn must claim it or settle it in cleanup",
			workerID, trnTurnSummary(ctx, f.Store.Pool, claim.TurnID), wantTurnID)
	}
	return claim
}
