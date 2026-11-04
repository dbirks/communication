package postgres

// Closing the orphaned paired turn when the lease pass reclaims an expired
// attempt (ADR-0074; lab evidence run 41766977189, 2026-11-04).
//
// ADR-0023 § 4's two-lease rule keeps an attempt's lease and its paired
// conversation turn's lease renewed together — so when the worker stops
// speaking for the attempt, the attempt's lease dies FIRST or at the same
// moment as the turn's, and § 5.4 pass 1 (this store's ReconcileLeases) is
// the component that takes the attempt over: it interrupts the attempt and
// the advancer re-queues the retry, whose claim stamps a NEW turn on the
// SAME conversation (contract § 4 step 6's retry continuity). Before this
// file, the reclaim terminalized the attempt without touching its turn,
// leaving the orphaned turn to the M3 turn-lease reconciler's lease arm —
// a second, separate loop on its own interval — while the retry claim
// waited out every 23505 from conversation_turns_one_active_idx. The turn
// terminal must ride the takeover transaction, the way every other attempt
// terminal closes its pair (closeAttemptTurnTx): the retry claim must be
// able to open its turn the moment the reclaim commits, and the transcript
// must show one honest system line — conversation.turn.interrupted
// {lease_expired} — saying the worker lost the turn, spoken by the deadline
// that decided, exactly as the M3 reconciler speaks for human turns.

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/dbirks/communication/internal/events"
	"github.com/dbirks/communication/internal/worker"
)

// closeReclaimedAttemptTurnsTx closes the live paired conversation turn of
// each attempt this transaction just re-claimed (the lease pass's
// interrupted{lease_expired} terminals), in the SAME transaction as the
// attempt's terminal row. A turn nobody else has already answered for lands
// interrupted with a journaled conversation.turn.interrupted {lease_expired};
// a turn the M3 reconciler or the old worker beat to is left untouched, and
// no second terminal is ever journalled.
//
// The close is UNFENCED on purpose: the re-claim is what makes the old
// triple stale, so no fence can carry the new authority here — the
// takeover's own write is the authority, and its guard is the row lock plus
// the live-status re-check, the same shape the M3 reconciler's interrupt
// uses. Only the turn stamped with the re-claimed attempt's node_attempt_id
// is ever touched: a human's own turn on the same conversation belongs to
// M2's turn loop, and a non-agent attempt owns no turn at all (no-op).
func closeReclaimedAttemptTurnsTx(ctx context.Context, tx pgx.Tx, runID string, attemptIDs []string) error {
	for _, attemptID := range attemptIDs {
		var (
			turnID, convID, workerID, orgID, projectID string
			token                                      int64
		)
		err := tx.QueryRow(ctx, `
			SELECT t.id::text, COALESCE(t.conversation_id::text, ''),
			       COALESCE(t.worker_id::text, ''), t.fencing_token,
			       r.organization_id::text, r.project_id::text
			FROM conversation_turns t
			JOIN attempts a2 ON a2.id = t.node_attempt_id
			JOIN runs r ON r.id = a2.run_id
			WHERE t.node_attempt_id = $1::uuid
			  AND t.status IN ('queued', 'leased', 'running')
			FOR UPDATE OF t`, attemptID).Scan(
			&turnID, &convID, &workerID, &token, &orgID, &projectID)
		switch {
		case errors.Is(err, pgx.ErrNoRows):
			// No live paired turn: a non-agent node, or somebody already
			// answered for it — nothing to close, nothing to journal.
			continue
		case err != nil:
			return fmt.Errorf("postgres: find orphaned turn for reclaimed attempt %s: %w", attemptID, err)
		}
		tag, err := tx.Exec(ctx, `
			UPDATE conversation_turns
			SET status = 'interrupted', finished_at = now()
			WHERE id = $1::uuid AND status IN ('queued', 'leased', 'running')`, turnID)
		if err != nil {
			return fmt.Errorf("postgres: interrupt orphaned turn %s of reclaimed attempt %s: %w", turnID, attemptID, err)
		}
		if tag.RowsAffected() == 0 {
			// Lost the race with the M3 reconciler's lease arm or the
			// old worker's own close: its terminal stands, and the pair
			// it journalled is the one and only honest word for it.
			continue
		}
		if convID == "" {
			continue
		}
		if _, err := trnAppendTx(ctx, tx, orgID, projectID, convID, worker.TurnEvent{
			Type:      events.TypeConversationTurnInterrupted,
			ActorKind: events.ActorKindSystem,
			ActorID:   "system",
			Payload: events.TurnInterruptedPayload{
				ConversationID: convID,
				TurnID:         turnID,
				WorkerID:       workerID,
				FencingToken:   token,
				// The M2 vocabulary's word for "a deadline decided this
				// turn was lost" — the same reason the M3 reconciler
				// journals for a turn it finds expired on its own.
				Reason: events.InterruptLeaseExpired,
			},
		}); err != nil {
			return err
		}
	}
	return nil
}
