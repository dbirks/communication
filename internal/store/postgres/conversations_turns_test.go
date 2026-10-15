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

	"github.com/dbirks/communication/internal/events"
)

// Turns, cancellation and permission decisions: the three places where a
// conversation's durable state and a running agent have to agree without
// talking to each other. Each test here is about what the *database* ends up
// holding after a request, because that is what a worker, a replica and a
// browser will all have to agree on later.

// --- one active turn ----------------------------------------------------

func TestSecondPromptWhileTurnActiveIsRejected(t *testing.T) {
	f := cnvSetup(t)
	chat := f.cnvCreate(t, f.alice, "One at a time", "first prompt")
	ctx := f.ctx()

	turn, err := f.store.PostMessage(ctx, f.caller(f.alice), chat.ID, "second prompt")
	if err == nil {
		t.Fatalf("second prompt accepted as %s; the first turn is still queued", turn.ID)
	}
	var cf *CnvConflict
	if !errors.As(err, &cf) || cf.Kind != ConflictTurnInProgress {
		t.Fatalf("err = %v, want turn_in_progress", err)
	}
	if cf.ActiveTurn == nil || cf.ActiveTurn.Prompt != "first prompt" {
		t.Errorf("conflict carried %+v, want the turn that is in the way", cf.ActiveTurn)
	}
	if cf.Control == nil || cf.Control.UserID != f.alice {
		t.Errorf("conflict carried control %+v, want the current controller", cf.Control)
	}

	// Only one queued turn exists, and it is the create's.
	var n int
	f.queryRow(t, `SELECT count(*) FROM conversation_turns WHERE conversation_id = $1::uuid`, chat.ID).into(t, &n)
	if n != 1 {
		t.Errorf("turn rows = %d, want 1", n)
	}
	// The rejection appended nothing: a refusal is not a transcript event.
	var appends int
	f.queryRow(t, `
		SELECT count(*) FROM domain_events
		WHERE conversation_id = $1::uuid AND type = 'conversation.message.user'`, chat.ID).into(t, &appends)
	if appends != 1 {
		t.Errorf("message.user rows = %d, want 1 (the create's prompt only)", appends)
	}
}

// TestConcurrentPromptsQueueExactlyOneTurn is the claim "never two prompts into
// one running turn" made against a real database: two transactions race, and the
// partial unique index — not a pre-read — decides.
func TestConcurrentPromptsQueueExactlyOneTurn(t *testing.T) {
	f := cnvSetup(t)
	chat := f.cnvCreate(t, f.alice, "Race the queue", "")
	// Control is needed; the creator holds it from the create.
	ctx := f.ctx()
	_ = ctx

	const racers = 6
	start := make(chan struct{})
	var wg sync.WaitGroup
	type result struct {
		err    error
		turnID string
	}
	results := make(chan result, racers)
	for i := 0; i < racers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			turn, err := f.store.PostMessage(context.Background(), f.caller(f.alice), chat.ID, "prompt")
			results <- result{err, turn.ID}
		}(i)
	}
	close(start)
	wg.Wait()
	close(results)

	var accepted, inProgress int
	seen := map[string]bool{}
	for r := range results {
		switch {
		case r.err == nil:
			accepted++
			if seen[r.turnID] {
				t.Fatalf("two callers got the same turn id %s", r.turnID)
			}
			seen[r.turnID] = true
		default:
			var cf *CnvConflict
			if !errors.As(r.err, &cf) || cf.Kind != ConflictTurnInProgress {
				t.Fatalf("racer got %v, want turn_in_progress", r.err)
			}
			inProgress++
		}
	}
	if accepted != 1 {
		t.Errorf("accepted prompts = %d, want exactly 1 (got %d rejections)", accepted, inProgress)
	}
	var n int
	f.queryRow(t, `SELECT count(*) FROM conversation_turns WHERE conversation_id = $1::uuid`, chat.ID).into(t, &n)
	if n != 1 {
		t.Errorf("turn rows = %d, want 1", n)
	}
}

// --- takeover cancels the running turn ----------------------------------

func TestTakeoverRequestsCancelOfRunningTurn(t *testing.T) {
	f := cnvSetup(t)
	chat := f.cnvCreate(t, f.alice, "Takeover", "go")
	ctx := f.ctx()
	turn := f.mustActiveTurn(t, chat.ID)

	f.cnvClaim(t, turn, f.worker, time.Minute)
	f.cnvRunning(t, turn)

	// Bob takes control. The ADR's answer is not "the turn stops now" — it is
	// "the worker is asked, in the same transaction that moved the lock".
	got, err := f.store.TakeControl(ctx, f.caller(f.bob), chat.ID, 1)
	if err != nil {
		t.Fatalf("bob takes control: %v", err)
	}
	if got.Control.UserID != f.bob {
		t.Fatalf("controller = %q, want bob", got.Control.UserID)
	}

	row := f.read(t, `
		SELECT status, cancel_requested_at IS NOT NULL AS cancel_requested,
		       finished_at IS NOT NULL AS finished
		FROM conversation_turns WHERE id = $1::uuid`, turn)
	if row["status"] != events.TurnStatusRunning {
		t.Errorf("turn status = %v, want running: a request is not a stop", row["status"])
	}
	if row["cancel_requested"] != true {
		t.Errorf("cancel_requested = %v, want true", row["cancel_requested"])
	}
	if row["finished"] == true {
		t.Errorf("turn finished at takeover: only the worker terminalises a turn it owns")
	}

	// The lease still belongs to the worker that holds it: takeover moves human
	// attention, not the process owning the agent.
	lease := f.read(t, `
		SELECT worker_id IS NOT NULL AS owned, fencing_token FROM conversation_turns WHERE id = $1::uuid`, turn)
	if lease["owned"] != true || fmt.Sprint(lease["fencing_token"]) == "0" {
		t.Errorf("lease after takeover = %+v, want the worker's lease untouched", lease)
	}

	// The transcript says who took it, from whom, and that a turn was involved.
	rows := f.journalRows(t, chat.ID)
	last := rows[len(rows)-1]
	if last.typ != events.TypeConversationControlTransferred {
		t.Fatalf("last journal row = %s, want the transfer", last.typ)
	}
	var payload events.ControlTransferredPayload
	if err := json.Unmarshal(last.payload, &payload); err != nil {
		t.Fatalf("decode transfer: %v", err)
	}
	if payload.Reason != events.TransferTaken || payload.FromUserID != f.alice || payload.ToUserID != f.bob {
		t.Errorf("payload = %+v, want taken/alice/bob", payload)
	}
	if payload.TurnID != turn {
		t.Errorf("payload turn_id = %q, want %s: the transcript should name the turn being displaced", payload.TurnID, turn)
	}
}

// TestTakeoverOfQueuedTurnDoesNotCancelIt draws the line the ADR draws between
// "ask the agent to stop" and "the prompt never ran": a queued turn has no
// worker to ask, and cancelling it here would silently discard a prompt nobody
// ran. The new controller sees it as the active turn and cancels it explicitly.
func TestTakeoverOfQueuedTurnDoesNotCancelIt(t *testing.T) {
	f := cnvSetup(t)
	chat := f.cnvCreate(t, f.alice, "Queued handover", "not started yet")
	ctx := f.ctx()

	if _, err := f.store.TakeControl(ctx, f.caller(f.bob), chat.ID, 1); err != nil {
		t.Fatalf("bob takes control: %v", err)
	}
	turn := f.mustActiveTurn(t, chat.ID)
	row := f.read(t, `
		SELECT status, cancel_requested_at FROM conversation_turns WHERE id = $1::uuid`, turn)
	if row["status"] != events.TurnStatusQueued {
		t.Errorf("status = %v, want queued", row["status"])
	}
	if row["cancel_requested_at"] != nil {
		t.Errorf("cancel_requested_at = %v, want null", row["cancel_requested_at"])
	}
	// Bob cannot prompt over it either — the queue is the lock's, not his.
	if _, err := f.store.PostMessage(ctx, f.caller(f.bob), chat.ID, "mine instead"); err == nil {
		t.Errorf("bob queued a second turn over alice's queued one")
	}
	// ...and the rejection names the turn he has to deal with first, which is
	// now the turn he inherited.
	_, err := f.store.PostMessage(ctx, f.caller(f.bob), chat.ID, "mine instead")
	var cf *CnvConflict
	if !errors.As(err, &cf) || cf.ActiveTurn == nil || cf.ActiveTurn.SubmittedBy != f.alice {
		t.Fatalf("err = %v, want a conflict naming alice's queued turn", err)
	}
}

// --- cancel -------------------------------------------------------------

func TestCancelOfQueuedTurnIsTerminal(t *testing.T) {
	f := cnvSetup(t)
	chat := f.cnvCreate(t, f.alice, "Cancel before start", "never runs")
	ctx := f.ctx()

	cancelled, err := f.store.CancelTurn(ctx, f.caller(f.alice), chat.ID)
	if err != nil {
		t.Fatalf("cancel: %v", err)
	}
	if cancelled.Status != events.TurnStatusCancelled {
		t.Errorf("status = %s, want cancelled", cancelled.Status)
	}
	if cancelled.FinishedAt == nil {
		t.Errorf("finished_at is nil: an unclaimed turn has nobody to ask, so cancel IS its end")
	}
	if cancelled.StopReason == nil || *cancelled.StopReason != "cancelled" {
		t.Errorf("stop_reason = %v, want cancelled", cancelled.StopReason)
	}

	row := f.read(t, `
		SELECT status, finished_at IS NOT NULL AS finished, stop_reason
		FROM conversation_turns WHERE conversation_id = $1::uuid`, chat.ID)
	if row["status"] != events.TurnStatusCancelled || row["finished"] != true {
		t.Errorf("turn row = %+v", row)
	}

	types := cnvTypes(f.journalRows(t, chat.ID))
	if !strings.HasSuffix(types[len(types)-1], ".cancelled") && !strings.HasSuffix(types[len(types)-1], events.TypeConversationTurnCancelled) {
		t.Errorf("journal = %v, want the cancellation last", types)
	}

	// The queue is free again, and the controller may prompt.
	if _, err := f.store.PostMessage(ctx, f.caller(f.alice), chat.ID, "instead do this"); err != nil {
		t.Errorf("prompt after cancel = %v, want the conversation usable", err)
	}
}

func TestCancelOfRunningTurnIsARequest(t *testing.T) {
	f := cnvSetup(t)
	chat := f.cnvCreate(t, f.alice, "Cancel mid-flight", "running now")
	ctx := f.ctx()
	turn := f.mustActiveTurn(t, chat.ID)
	f.cnvClaim(t, turn, f.worker, time.Minute)
	f.cnvRunning(t, turn)

	got, err := f.store.CancelTurn(ctx, f.caller(f.alice), chat.ID)
	if err != nil {
		t.Fatalf("cancel: %v", err)
	}
	if got.Status != events.TurnStatusRunning {
		t.Errorf("status = %s, want running: the worker terminalises its own turn", got.Status)
	}
	if got.CancelRequestedAt == nil {
		t.Fatalf("cancel_requested_at is nil: the worker would never learn")
	}
	// No transcript event yet, on purpose: api/openapi.yaml gives the cancel
	// *request* to the turn row and reserves `conversation.turn.cancelled` for
	// the worker that actually stopped the harness. Appending a terminal-looking
	// row here would tell every reader that work stopped when all that happened
	// is that somebody asked.
	types := cnvTypes(f.journalRows(t, chat.ID))
	for _, typ := range types {
		if strings.Contains(typ, ".cancelled") || strings.Contains(typ, "cancel_requested") {
			t.Errorf("journal = %v, want no cancellation row before the worker reports one", types)
		}
	}

	// A second cancel is not an error, does not move the deadline, and still
	// appends nothing.
	first := f.read(t, `
		SELECT cancel_requested_at FROM conversation_turns WHERE id = $1::uuid`, turn)
	if _, err := f.store.CancelTurn(ctx, f.caller(f.alice), chat.ID); err != nil {
		t.Errorf("second cancel = %v, want idempotent", err)
	}
	second := f.read(t, `
		SELECT cancel_requested_at FROM conversation_turns WHERE id = $1::uuid`, turn)
	if fmt.Sprint(first["cancel_requested_at"]) != fmt.Sprint(second["cancel_requested_at"]) {
		t.Errorf("cancel_requested_at moved from %v to %v on a repeat request", first, second)
	}
	types = cnvTypes(f.journalRows(t, chat.ID))
	for _, typ := range types {
		if strings.Contains(typ, "cancel") {
			t.Errorf("repeat cancel wrote a journal row: %v", types)
		}
	}
}

func TestCancelWithNoTurnIsRejected(t *testing.T) {
	f := cnvSetup(t)
	chat := f.cnvCreate(t, f.alice, "Nothing to cancel", "")
	ctx := f.ctx()
	_, err := f.store.CancelTurn(ctx, f.caller(f.alice), chat.ID)
	var cf *CnvConflict
	if !errors.As(err, &cf) || cf.Kind != ConflictNoActiveTurn {
		t.Fatalf("cancel with no turn = %v, want no_active_turn", err)
	}
}

func TestCancelByNonControllerIsRejected(t *testing.T) {
	f := cnvSetup(t)
	chat := f.cnvCreate(t, f.alice, "Not yours to stop", "go")
	ctx := f.ctx()
	if _, err := f.store.CancelTurn(ctx, f.caller(f.bob), chat.ID); err == nil {
		t.Fatalf("a non-controller cancelled alice's turn")
	} else {
		var cf *CnvConflict
		if !errors.As(err, &cf) || cf.Kind != ConflictNotController {
			t.Fatalf("err = %v, want not_controller", err)
		}
	}
	// Nothing moved.
	if row := f.mustActiveTurnRow(t, chat.ID); row["status"] != events.TurnStatusQueued || row["cancel_requested_at"] != nil {
		t.Errorf("turn after refused cancel = %+v, want an untouched queued turn", row)
	}
}

// --- permission decisions ------------------------------------------------

func TestPermissionDecisionIsTheControllersAlone(t *testing.T) {
	f := cnvSetup(t)
	chat := f.cnvCreate(t, f.alice, "May I write this file?", "go")
	ctx := f.ctx()
	turn := f.mustActiveTurn(t, chat.ID)
	f.cnvClaim(t, turn, f.worker, time.Hour)
	requestID := f.cnvAskPermission(t, f.orgID, f.project, chat.ID, turn, "acp-7", time.Hour)

	// A contributor who does not hold the lock may not answer for the agent.
	if _, err := f.store.DecidePermission(ctx, f.caller(f.bob), chat.ID, requestID, "allow_once"); err == nil {
		t.Fatalf("bob answered a prompt he was not shown")
	} else {
		var cf *CnvConflict
		if !errors.As(err, &cf) || cf.Kind != ConflictNotController {
			t.Fatalf("err = %v, want not_controller", err)
		}
	}
	// A viewer is refused on role, before control is ever consulted.
	if _, err := f.store.DecidePermission(ctx, f.caller(f.carl), chat.ID, requestID, "allow_once"); !errors.Is(err, ErrConversationForbidden) {
		t.Errorf("viewer decision = %v, want forbidden", err)
	}
	// An option the agent never offered is a 422: a client may not invent
	// approvals for a harness that did not propose them.
	if _, err := f.store.DecidePermission(ctx, f.caller(f.alice), chat.ID, requestID, "allow_forever"); !errors.Is(err, ErrConversationValidation) {
		t.Errorf("invented option = %v, want validation (422)", err)
	}
	// A prompt of another conversation is invisible, which is a 404.
	if _, err := f.store.DecidePermission(ctx, f.caller(f.alice), "00000000-0000-7000-8000-000000000009", requestID, "allow_once"); !errors.Is(err, ErrConversationNotFound) {
		t.Errorf("foreign conversation = %v, want not found", err)
	}

	decided, err := f.store.DecidePermission(ctx, f.caller(f.alice), chat.ID, requestID, "reject_once")
	if err != nil {
		t.Fatalf("controller decides: %v", err)
	}
	if decided.Status != events.PermissionStatusDecided || decided.DecisionOptionID != "reject_once" {
		t.Fatalf("decided = %+v", decided)
	}

	// The answer is durable and attributed, and the transcript carries it.
	row := f.read(t, `
		SELECT status, decided_by::text, decision_option_id FROM permission_requests WHERE id = $1::uuid`, requestID)
	if row["status"] != events.PermissionStatusDecided || row["decided_by"] != f.alice || row["decision_option_id"] != "reject_once" {
		t.Errorf("row = %+v, want decided/alice/reject_once", row)
	}
	var payload events.PermissionDecidedPayload
	rows := f.journalRows(t, chat.ID)
	last := rows[len(rows)-1]
	if last.typ != events.TypeConversationPermissionDecided {
		t.Fatalf("last row = %s, want permission.decided", last.typ)
	}
	if err := json.Unmarshal(last.payload, &payload); err != nil {
		t.Fatalf("decode decided payload: %v", err)
	}
	if payload.Status != events.PermissionStatusDecided || payload.DecidedBy != f.alice || payload.DecisionOptionID != "reject_once" {
		t.Errorf("payload = %+v", payload)
	}

	// A second answer is refused rather than silently re-decided: two humans
	// clicking the same prompt must produce one decision and one transcript line.
	if _, err := f.store.DecidePermission(ctx, f.caller(f.alice), chat.ID, requestID, "allow_once"); err == nil {
		var cf *CnvConflict
		if !errors.As(err, &cf) || cf.Kind != ConflictPermissionNotPending {
			t.Fatalf("second answer = %v, want permission_not_pending", err)
		}
	}
	var n int
	f.queryRow(t, `
		SELECT count(*) FROM domain_events
		WHERE conversation_id = $1::uuid AND type = 'conversation.permission.decided'`, chat.ID).into(t, &n)
	if n != 1 {
		t.Errorf("permission.decided rows = %d, want 1", n)
	}
}

// TestPermissionDecisionDoesNotTouchTheTurn keeps the two axes of "stop" apart:
// answering a prompt is not cancelling a turn, and the ADR refuses to blur them.
func TestPermissionDecisionDoesNotTouchTheTurn(t *testing.T) {
	f := cnvSetup(t)
	chat := f.cnvCreate(t, f.alice, "Answer, do not stop", "go")
	ctx := f.ctx()
	turn := f.mustActiveTurn(t, chat.ID)
	f.cnvClaim(t, turn, f.worker, time.Hour)
	requestID := f.cnvAskPermission(t, f.orgID, f.project, chat.ID, turn, "acp-8", time.Hour)

	if _, err := f.store.DecidePermission(ctx, f.caller(f.alice), chat.ID, requestID, "allow_once"); err != nil {
		t.Fatalf("decide: %v", err)
	}
	row := f.read(t, `
		SELECT status, cancel_requested_at FROM conversation_turns WHERE id = $1::uuid`, turn)
	if row["status"] != events.TurnStatusRunning {
		t.Errorf("turn status = %v, want running", row["status"])
	}
	if row["cancel_requested_at"] != nil {
		t.Errorf("cancel_requested_at = %v, want null", row["cancel_requested_at"])
	}
}

// --- helpers shared with reconciler_test.go -----------------------------

func (f *cnvFixture) mustActiveTurn(t *testing.T, conversationID string) string {
	t.Helper()
	var id string
	f.queryRow(t, `
		SELECT id::text FROM conversation_turns
		WHERE conversation_id = $1::uuid AND status IN ('queued','leased','running')
		ORDER BY created_at, id LIMIT 1`, conversationID).into(t, &id)
	return id
}

func (f *cnvFixture) mustActiveTurnRow(t *testing.T, conversationID string) map[string]any {
	t.Helper()
	return f.read(t, `
		SELECT status, cancel_requested_at, worker_id::text, fencing_token
		FROM conversation_turns
		WHERE conversation_id = $1::uuid AND status IN ('queued','leased','running')
		ORDER BY created_at, id LIMIT 1`, conversationID)
}
