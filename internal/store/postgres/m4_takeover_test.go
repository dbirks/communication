package postgres

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/dbirks/communication/internal/events"
	"github.com/dbirks/communication/internal/worker"
)

// TestM4Takeover is contract § 5.3 / C9g over real Postgres: a human takes the
// wheel from a live agent.acp attempt and the conversation move, the turn
// cancel-request, the attempt interrupt and the run pause are ONE transaction;
// giving the wheel back resumes the run and the next attempt carries the
// recorded intervention as retry_context.

func m4TakeoverAttempt(t *testing.T) (*m4Fixture, *AttemptStore, string, worker.AttemptClaim, string, string) {
	t.Helper()
	ctx := testCtx(t)
	f, store := awSetup(t)
	sessions := &AttemptSessions{Runs: f.runs}
	profile := fmt.Sprintf("ats-takeover-%s", migFixtureToken(t))
	atsProfile(t, ctx, f, f.orgID, profile, "claude", "ask", false)
	runID := f.m4QueuedRun(t, ctx, "", 0)
	atsPlan(t, ctx, f, runID, profile)
	_, _ = f.m4WorkerNode(t, ctx, runID, "/implement")
	workerID := m4Worker(t, ctx, f.pool, "takeover", 1)
	atsConversationSweep(t, f)
	c := atsClaimRunning(t, ctx, f, store, workerID)
	// The claim above is the WORKER store's (§ 4 step 3); the node row's
	// engine-owned bookkeeping — status and in_flight — is what
	// RuntimeStore.Claim would have moved in a real deployment. Seed it to the
	// same honest values so the ledger hydrates as the engine left it.
	if _, err := f.pool.Exec(ctx, `
		UPDATE node_executions SET status = 'running', in_flight = 1
		WHERE id = $1::uuid`, c.NodeExecutionID); err != nil {
		t.Fatalf("record the claim on the node row: %v", err)
	}
	conv, ok, err := sessions.ConversationFor(ctx, c)
	if err != nil || !ok || conv.ConversationID == "" {
		t.Fatalf("ConversationFor = (%v, %v, %v), want a stamped pair", conv, ok, err)
	}
	return f, store, runID, c, conv.ConversationID, conv.TurnID
}

func m4TakeoverRow(t *testing.T, f *m4Fixture, query string, args ...any) string {
	t.Helper()
	var s string
	if err := f.pool.QueryRow(context.Background(), query, args...).Scan(&s); err != nil {
		t.Fatalf("query %q: %v", query, err)
	}
	return s
}

func m4TakeoverEvents(t *testing.T, f *m4Fixture, runID string) map[string]int {
	t.Helper()
	rows, err := f.pool.Query(context.Background(), `
		SELECT type, count(*) FROM domain_events WHERE run_id = $1::uuid GROUP BY type`, runID)
	if err != nil {
		t.Fatalf("read run events: %v", err)
	}
	defer rows.Close()
	out := map[string]int{}
	for rows.Next() {
		var typ string
		var n int
		if err := rows.Scan(&typ, &n); err != nil {
			t.Fatalf("scan run events: %v", err)
		}
		out[typ] = n
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("read run events: %v", err)
	}
	return out
}

func TestM4Takeover(t *testing.T) {
	f, _, runID, claim, conversationID, turnID := m4TakeoverAttempt(t)
	caller := Caller{UserID: f.userID, OrganizationID: f.orgID, IsOrgAdmin: true}
	cnv := &CnvStore{Pool: f.pool}
	ctx := testCtx(t)

	// The attempt holds the conversation as controller_kind='run_attempt'.
	if kind := m4TakeoverRow(t, f, `SELECT controller_kind FROM conversation_control WHERE conversation_id = $1::uuid`, conversationID); kind != events.ControllerKindRunAttempt {
		t.Fatalf("control kind = %s, want run_attempt before the takeover", kind)
	}
	version := 0
	if err := f.pool.QueryRow(ctx, `SELECT version FROM conversation_control WHERE conversation_id = $1::uuid`, conversationID).Scan(&version); err != nil {
		t.Fatalf("read control version: %v", err)
	}

	// --- take control ------------------------------------------------------
	if _, err := cnv.TakeControl(ctx, caller, conversationID, version); err != nil {
		t.Fatalf("TakeControl: %v", err)
	}
	if kind := m4TakeoverRow(t, f, `SELECT controller_kind FROM conversation_control WHERE conversation_id = $1::uuid`, conversationID); kind != events.ControllerKindHuman {
		t.Errorf("control kind = %s after take-control, want human", kind)
	}
	if at := m4TakeoverRow(t, f, `SELECT coalesce(cancel_requested_at::text, '') FROM conversation_turns WHERE id = $1::uuid`, turnID); at == "" {
		t.Error("the live turn was not cancel-requested by the takeover")
	}
	if st := m4TakeoverRow(t, f, `SELECT status FROM attempts WHERE id = $1::uuid`, claim.AttemptID); st != "interrupted" {
		t.Errorf("attempt status = %s, want interrupted", st)
	}
	if class := m4TakeoverRow(t, f, `SELECT coalesce(error_class, '') FROM attempts WHERE id = $1::uuid`, claim.AttemptID); class != "interrupted" {
		t.Errorf("attempt error_class = %s, want interrupted", class)
	}
	if status, reason := func() (string, string) {
		var s, r string
		if err := f.pool.QueryRow(ctx, `SELECT status, coalesce(paused_reason, '') FROM runs WHERE id = $1::uuid`, runID).Scan(&s, &r); err != nil {
			t.Fatal(err)
		}
		return s, r
	}(); status != "paused" || reason != "human_takeover" {
		t.Errorf("run = (%s, %s), want (paused, human_takeover)", status, reason)
	}
	evs := m4TakeoverEvents(t, f, runID)
	if evs["node.attempt.interrupted"] != 1 {
		t.Errorf("node.attempt.interrupted count = %d, want exactly 1: %+v", evs["node.attempt.interrupted"], evs)
	}
	if evs["run.paused"] != 1 {
		t.Errorf("run.paused count = %d, want exactly 1: %+v", evs["run.paused"], evs)
	}
	if n := m4TakeoverRow(t, f, `
		SELECT count(*)::text FROM domain_events
		WHERE run_id = $1::uuid AND type = 'node.attempt.interrupted'
		  AND payload->>'reason' = 'human_takeover'`, runID); n != "1" {
		t.Errorf("node.attempt.interrupted{human_takeover} rows = %s, want 1", n)
	}
	// --- the human drives -------------------------------------------------
	// The worker acknowledges the cancel and closes its own turn (M2's
	// machinery); only then may the human's own turn exist, because
	// conversation_turns_one_active_idx admits one live turn per conversation.
	if _, err := f.pool.Exec(ctx, `
		UPDATE conversation_turns SET status = 'interrupted', finished_at = now()
		WHERE id = $1::uuid AND status IN ('leased', 'running')`, turnID); err != nil {
		t.Fatalf("close the taken-over turn as the worker would: %v", err)
	}
	if _, err := f.pool.Exec(ctx, `
		INSERT INTO conversation_turns (conversation_id, prompt, submitted_by)
		VALUES ($1::uuid, $2, $3::uuid)`, conversationID, "use a lookup table instead", f.userID); err != nil {
		t.Fatalf("record the human's intervention: %v", err)
	}

	// --- return control ---------------------------------------------------
	version = 0
	if err := f.pool.QueryRow(ctx, `SELECT version FROM conversation_control WHERE conversation_id = $1::uuid`, conversationID).Scan(&version); err != nil {
		t.Fatalf("read control version: %v", err)
	}
	if _, err := cnv.ReturnControl(ctx, caller, conversationID, version); err != nil {
		t.Fatalf("ReturnControl: %v", err)
	}
	// The resume lands the run 'queued' exactly as route 29's own ResumeRun
	// does (the advancer/driver takes it running from the rows); what must NOT
	// survive is the takeover pause.
	status := m4TakeoverRow(t, f, `SELECT status FROM runs WHERE id = $1::uuid`, runID)
	if status != "queued" && status != "running" {
		t.Errorf("run status after return-control = %s, want queued or running (un-paused)", status)
	}
	if reason := m4TakeoverRow(t, f, `SELECT coalesce(paused_reason, '') FROM runs WHERE id = $1::uuid`, runID); reason != "" {
		t.Errorf("paused_reason after return-control = %q, want cleared", reason)
	}
	var newAttempt, newAttemptNum string
	if err := f.pool.QueryRow(ctx, `
		SELECT id::text, attempt_number::text FROM attempts
		WHERE node_execution_id = (SELECT node_execution_id FROM attempts WHERE id = $1::uuid)
		ORDER BY attempt_number DESC LIMIT 1`, claim.AttemptID).Scan(&newAttempt, &newAttemptNum); err != nil {
		t.Fatalf("read the handback attempt: %v", err)
	}
	if newAttemptNum != "2" || newAttempt == claim.AttemptID {
		t.Fatalf("next attempt = (%s, number %s), want a fresh attempt numbered 2", newAttempt, newAttemptNum)
	}
	if st := m4TakeoverRow(t, f, `SELECT status FROM attempts WHERE id = $1::uuid`, newAttempt); st != "queued" {
		t.Errorf("next attempt status = %s, want queued", st)
	}
	rc := m4TakeoverRow(t, f, `SELECT coalesce(retry_context::text, '') FROM attempts WHERE id = $1::uuid`, newAttempt)
	t.Logf("retry_context = %s", rc)
	var ctxMap map[string]any
	if err := json.Unmarshal([]byte(rc), &ctxMap); err != nil {
		t.Fatalf("retry_context is not json: %q (%v)", rc, err)
	}
	takeover, ok := ctxMap["human_takeover"].(map[string]any)
	if !ok {
		t.Fatalf("retry_context %q does not name the human takeover", rc)
	}
	if by, _ := takeover["returned_by"].(string); by != f.userID {
		t.Errorf("retry_context.human_takeover.returned_by = %v, want %s", takeover["returned_by"], f.userID)
	}
	if n, _ := takeover["turn_count"].(float64); n != 1 {
		t.Fatalf("retry_context.human_takeover.turn_count = %v, want 1", takeover["turn_count"])
	}
	turn, _ := takeover["turns"].([]any)
	if len(turn) != 1 {
		t.Fatalf("retry_context.human_takeover.turns = %v, want one entry", takeover["turns"])
	}
	if got, _ := turn[0].(map[string]any)["prompt"].(string); got != "use a lookup table instead" {
		t.Errorf("retry_context intervention = %v, want the human's prompt verbatim", turn[0])
	}
	if cls, _ := ctxMap["error_class"].(string); cls != "interrupted" {
		t.Errorf("retry_context.error_class = %v, want interrupted (ADR-0023 § 6 shape)", ctxMap["error_class"])
	}
	// Control goes back to the RUN, and to the attempt that will actually
	// drive it — not to the human and not to the dead attempt.
	if kind, holder := func() (string, string) {
		var k, h string
		if err := f.pool.QueryRow(ctx, `
			SELECT controller_kind, coalesce(controller_run_attempt_id::text, '')
			FROM conversation_control WHERE conversation_id = $1::uuid`, conversationID).Scan(&k, &h); err != nil {
			t.Fatal(err)
		}
		return k, h
	}(); kind != events.ControllerKindRunAttempt || holder != newAttempt {
		t.Errorf("control after return = (%s, %s), want (run_attempt, %s)", kind, holder, newAttempt)
	}
	evs = m4TakeoverEvents(t, f, runID)
	if evs["run.resumed"] != 1 {
		t.Errorf("run.resumed count = %d, want exactly 1: %+v", evs["run.resumed"], evs)
	}
	if n := m4TakeoverRow(t, f, `
		SELECT count(*)::text FROM domain_events
		WHERE conversation_id = $1::uuid AND type = 'conversation.control.transferred'`, conversationID); n != "2" {
		t.Errorf("conversation.control.transferred count = %s, want 2 (taken + returned)", n)
	}
}

// TestM4TakeoverFinishedAttemptIsPlainM2 is the fencing rule of § 5.3: the
// attempt already reached its terminal, so nothing about the run is live to
// interrupt — taking the conversation is ADR-0016 § 5's plain human takeover.
func TestM4TakeoverFinishedAttemptIsPlainM2(t *testing.T) {
	f, store, runID, claim, conversationID, _ := m4TakeoverAttempt(t)
	ctx := testCtx(t)

	if err := store.InterruptAttemptOwn(ctx, claim, worker.InterruptReasonWorkerShutdown); err != nil {
		t.Fatalf("worker closes its own attempt: %v", err)
	}
	caller := Caller{UserID: f.userID, OrganizationID: f.orgID, IsOrgAdmin: true}
	cnv := &CnvStore{Pool: f.pool}
	version := 0
	if err := f.pool.QueryRow(ctx, `SELECT version FROM conversation_control WHERE conversation_id = $1::uuid`, conversationID).Scan(&version); err != nil {
		t.Fatalf("read control version: %v", err)
	}
	if _, err := cnv.TakeControl(ctx, caller, conversationID, version); err != nil {
		t.Fatalf("TakeControl over a finished attempt: %v", err)
	}
	if status, reason := func() (string, string) {
		var s, r string
		if err := f.pool.QueryRow(ctx, `SELECT status, coalesce(paused_reason, '') FROM runs WHERE id = $1::uuid`, runID).Scan(&s, &r); err != nil {
			t.Fatal(err)
		}
		return s, r
	}(); status != "running" || reason != "" {
		t.Errorf("run = (%s, %s) after taking a finished attempt's conversation, want (running, no pause)", status, reason)
	}
	if n := m4TakeoverRow(t, f, `
		SELECT count(*)::text FROM domain_events
		WHERE run_id = $1::uuid AND type = 'run.paused'`, runID); n != "0" {
		t.Errorf("run.paused count = %s, want 0 (no run change)", n)
	}
	if kind := m4TakeoverRow(t, f, `SELECT controller_kind FROM conversation_control WHERE conversation_id = $1::uuid`, conversationID); kind != events.ControllerKindHuman {
		t.Errorf("control kind = %s, want human (the takeover still moved)", kind)
	}
}
