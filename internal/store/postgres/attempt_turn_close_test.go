package postgres

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/dbirks/communication/internal/worker"
)

// Contract § 4 step 10 pairs step 6's turn row with step 12's event: EVERY
// terminal attempt write (succeeded, failed, cancelled, interrupted) closes
// its paired non-terminal turn with the matching conversation.turn.<terminal>
// in the SAME fenced transaction. Live lab evidence: a failed agent.acp
// attempt left its turn 'running', and conversation_turns_one_active_idx then
// refused every retry's turn enqueue (agentturn_seams.go's refusal named this
// writer as the debtor). These tests run against a REAL Postgres 18 that ran
// 00005 — the refusal is a DB constraint, so only the DB can prove it gone.

// atcCase is a running agent attempt that owns its conversation turn.
type atcCase struct {
	ctx      context.Context
	f        *m4Fixture
	store    *AttemptStore
	sessions *AttemptSessions
	c        worker.AttemptClaim
	workerID string
	runID    string
	nodeID   string
	convID   string
	turnID   string
}

// atcSetup drives the real seams end to end: pin a plan carrying prompt+
// profile, claim and begin an attempt, then let ConversationFor stamp the
// conversation and the attempt's own turn row (§ 4 step 6 as it actually
// happens, not as a hand-written INSERT).
func atcSetup(t *testing.T, tag string) *atcCase {
	t.Helper()
	ctx := testCtx(t)
	f, store := awSetup(t)
	sessions := &AttemptSessions{Runs: f.runs}
	profile := fmt.Sprintf("atc-%s-%s", tag, migFixtureToken(t))
	atsProfile(t, ctx, f, f.orgID, profile, "claude", "ask", false)
	runID := f.m4QueuedRun(t, ctx, "", 0)
	atsPlan(t, ctx, f, runID, profile)
	nodeID, _ := f.m4WorkerNode(t, ctx, runID, "/implement")
	workerID := m4Worker(t, ctx, f.pool, tag, 1)
	atsConversationSweep(t, f)
	c := atsClaimRunning(t, ctx, f, store, workerID)
	conv, ok, err := sessions.ConversationFor(ctx, c)
	if err != nil || !ok || conv.ConversationID == "" || conv.TurnID == "" {
		t.Fatalf("ConversationFor = (%+v, %v, %v), want a stamped pair", conv, ok, err)
	}
	return &atcCase{ctx: ctx, f: f, store: store, sessions: sessions,
		c: c, workerID: workerID, runID: runID, nodeID: nodeID,
		convID: conv.ConversationID, turnID: conv.TurnID}
}

func (a *atcCase) turnStatus(t *testing.T) (string, bool) {
	t.Helper()
	var status string
	var finished bool
	if err := a.f.pool.QueryRow(a.ctx, `
		SELECT status, finished_at IS NOT NULL FROM conversation_turns WHERE id = $1::uuid`,
		a.turnID).Scan(&status, &finished); err != nil {
		t.Fatalf("read paired turn: %v", err)
	}
	return status, finished
}

// terminalEvents lists every conversation.turn.<terminal> kind with a live row.
func (a *atcCase) terminalEvents(t *testing.T) map[string]int {
	t.Helper()
	rows, err := a.f.pool.Query(a.ctx, `
		SELECT type, count(*) FROM domain_events
		WHERE conversation_id = $1::uuid AND type IN (
			'conversation.turn.completed', 'conversation.turn.failed',
			'conversation.turn.cancelled', 'conversation.turn.interrupted')
		GROUP BY type`, a.convID)
	if err != nil {
		t.Fatalf("count turn terminals: %v", err)
	}
	defer rows.Close()
	out := map[string]int{}
	for rows.Next() {
		var typ string
		var n int
		if err := rows.Scan(&typ, &n); err != nil {
			t.Fatalf("scan turn terminals: %v", err)
		}
		out[typ] = n
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate turn terminals: %v", err)
	}
	return out
}

// TestAttemptTurnCloseEveryTerminalArm: for each terminal kind, the attempt's
// terminal write leaves the paired turn terminal with EXACTLY ONE matching
// conversation.turn.<terminal> and no other terminal on it (§ 4 step 12's
// pairing generalized to every arm, not just the shutdown one).
func TestAttemptTurnCloseEveryTerminalArm(t *testing.T) {
	arms := []struct {
		name       string
		turnStatus string
		eventType  string
		closeFn    func(*testing.T, *atcCase) error
	}{
		{"succeeded", "completed", "conversation.turn.completed",
			func(t *testing.T, a *atcCase) error {
				return a.store.CompleteAttempt(a.ctx, a.c, map[string]any{"exit_code": 0},
					m4Digest("outs"), []any{}, "passed", worker.AttemptCheckpoint{
						InputsDigest: m4Digest("ins"), OutputsDigest: m4Digest("outs"),
						WorkspaceID: m4Workspace(t, a.ctx, a.f, a.runID), VolumeID: "vol-arm",
					})
			}},
		{"failed", "failed", "conversation.turn.failed",
			func(t *testing.T, a *atcCase) error {
				return a.store.FailAttempt(a.ctx, a.c, worker.ErrorClassInfra, "agent process died", nil)
			}},
		{"cancelled", "cancelled", "conversation.turn.cancelled",
			func(t *testing.T, a *atcCase) error {
				return a.store.CancelAttemptOwn(a.ctx, a.c, worker.CancelReasonACPAck)
			}},
		{"interrupted", "interrupted", "conversation.turn.interrupted",
			func(t *testing.T, a *atcCase) error {
				return a.store.InterruptAttemptOwn(a.ctx, a.c, worker.InterruptReasonWorkerShutdown)
			}},
	}
	for _, arm := range arms {
		t.Run(arm.name, func(t *testing.T) {
			a := atcSetup(t, "arm-"+arm.name[:4])
			before := a.terminalEvents(t)
			if len(before) != 0 {
				t.Fatalf("conversation.turn.* terminals before the close = %v, want none", before)
			}
			if err := arm.closeFn(t, a); err != nil {
				t.Fatalf("terminal write (%s): %v", arm.name, err)
			}
			status, finished := a.turnStatus(t)
			if status != arm.turnStatus || !finished {
				t.Errorf("paired turn = (%s, finished=%v), want (%s, finished=true) — a turn never outlives the attempt that owns it",
					status, finished, arm.turnStatus)
			}
			got := a.terminalEvents(t)
			if got[arm.eventType] != 1 {
				t.Errorf("%s rows = %d, want exactly 1 (the pair is journalled, not just written) — all: %v",
					arm.eventType, got[arm.eventType], got)
			}
			for typ, n := range got {
				if typ != arm.eventType && n != 0 {
					t.Errorf("%s rows = %d beside %s, want the arm's OWN terminal only", typ, n, arm.eventType)
				}
			}
			var attStatus string
			if err := a.f.pool.QueryRow(a.ctx, `SELECT status FROM attempts WHERE id = $1::uuid`, a.c.AttemptID).
				Scan(&attStatus); err != nil {
				t.Fatal(err)
			}
			if attStatus != arm.name {
				t.Errorf("attempt = %s, want %s", attStatus, arm.name)
			}
		})
	}
}

// TestAttemptTurnCloseRetryEnqueuesAfterFailure is the live lab regression:
// attempt 1 FAILS (the sample pipeline's agent node), and the retry's turn
// enqueue used to be refused by conversation_turns_one_active_idx because the
// failed attempt left its turn non-terminal. The close now rides the failure
// transaction, so the retry rides the same conversation with a fresh turn.
func TestAttemptTurnCloseRetryEnqueuesAfterFailure(t *testing.T) {
	arms := []struct {
		name    string
		closeFn func(*testing.T, *atcCase) error
	}{
		{"failed", func(t *testing.T, a *atcCase) error {
			return a.store.FailAttempt(a.ctx, a.c, worker.ErrorClassAgentError, "plan rejected the input", nil)
		}},
		// Only the arms that return the NODE to 'ready' can be retried (ADR-0023
		// § 5): a succeeded or cancelled attempt terminalizes the node, so the
		// ADVANCER never queues an attempt 2 on it — those two arms are covered
		// by TestAttemptTurnCloseEveryTerminalArm's row-state assertions.
		{"interrupted", func(t *testing.T, a *atcCase) error {
			return a.store.InterruptAttemptOwn(a.ctx, a.c, worker.InterruptReasonWorkerShutdown)
		}},
	}
	for _, arm := range arms {
		t.Run(arm.name, func(t *testing.T) {
			a := atcSetup(t, "retry-"+arm.name[:4])
			if err := arm.closeFn(t, a); err != nil {
				t.Fatalf("close attempt 1 (%s): %v", arm.name, err)
			}
			a2, err := a.f.runs.QueueAttempt(a.ctx, NewAttempt{
				NodeExecutionID: a.c.NodeExecutionID, AttemptNumber: 2,
			})
			if err != nil {
				t.Fatalf("queue attempt 2: %v", err)
			}
			c2 := atsClaimRunning(t, a.ctx, a.f, a.store, a.workerID)
			if c2.AttemptID != a2.ID {
				t.Fatalf("claimed %s, want attempt 2 %s", c2.AttemptID, a2.ID)
			}
			conv2, ok, err := a.sessions.ConversationFor(a.ctx, c2)
			if err != nil || !ok {
				t.Fatalf("retry ConversationFor = (%+v, %v, %v), want the node's conversation with NO enqueue refusal: %v",
					conv2, ok, err, err)
			}
			if conv2.ConversationID != a.convID {
				t.Errorf("retry conversation = %s, want %s", conv2.ConversationID, a.convID)
			}
			if conv2.TurnID == a.turnID {
				t.Error("retry reused attempt 1's closed turn row; each attempt owns its turn")
			}
			var live int
			if err := a.f.pool.QueryRow(a.ctx, `
				SELECT count(*) FROM conversation_turns
				WHERE conversation_id = $1::uuid AND status IN ('queued','leased','running')`, a.convID).
				Scan(&live); err != nil {
				t.Fatal(err)
			}
			if live != 1 {
				t.Errorf("non-terminal turns = %d after the retry stamped its own, want 1 (attempt 1's is terminal)", live)
			}
		})
	}
}

// TestAttemptTurnCloseStaleFenceWritesNeither proves the fence still guards
// BOTH halves: a stolen lease lands neither the attempt's terminal row nor the
// turn's, and journals no conversation.turn.<terminal> (12 case 3).
func TestAttemptTurnCloseStaleFenceWritesNeither(t *testing.T) {
	a := atcSetup(t, "stale-close")
	thief := m4Worker(t, a.ctx, a.f.pool, "thief-close", 1)
	if _, err := a.f.pool.Exec(a.ctx, `
		UPDATE attempts SET fencing_token = fencing_token + 1, worker_id = $2::uuid
		WHERE id = $1::uuid`, a.c.AttemptID, thief); err != nil {
		t.Fatalf("simulate the re-claim: %v", err)
	}
	if err := a.store.FailAttempt(a.ctx, a.c, worker.ErrorClassInfra, "late writer", nil); !errors.Is(err, worker.ErrLeaseLost) {
		t.Fatalf("stale FailAttempt = %v, want ErrLeaseLost", err)
	}
	status, finished := a.turnStatus(t)
	if finished || status == "failed" {
		t.Errorf("paired turn = (%s, finished=%v) after a stale write, want it untouched", status, finished)
	}
	if got := a.terminalEvents(t); len(got) != 0 {
		t.Errorf("stale write journalled turn terminals %v, want NOTHING", got)
	}
	var attStatus string
	if err := a.f.pool.QueryRow(a.ctx, `SELECT status FROM attempts WHERE id = $1::uuid`, a.c.AttemptID).
		Scan(&attStatus); err != nil {
		t.Fatal(err)
	}
	if attStatus == "failed" {
		t.Error("the stale writer terminalized the attempt anyway")
	}
}
