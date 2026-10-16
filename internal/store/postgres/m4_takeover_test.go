package postgres

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/dbirks/communication/internal/api"
	"github.com/dbirks/communication/internal/events"
	"github.com/dbirks/communication/internal/pipelines/runtime"
	"github.com/dbirks/communication/internal/worker"
)

// m4TakeoverLease is the attempt lease the worker-facing store hands out.
const m4TakeoverLease = 2 * time.Second

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

// ---------------------------------------------------------------------------
// TestM4TakeoverResumesRunToClaimable — the executable-plan half of § 5.3.
// TestM4Takeover proves the takeover bookkeeping on a hand-pinned plan
// snapshot; the plan it pins is not something the advancer can program, so
// after return-control the run sits 'queued' and no worker can ever pick the
// handback attempt up. Here the pipeline is published through
// APIPipelineStore from a real document, so the run's pinned snapshot is the
// real compiled plan: takeover -> human turn -> return-control -> advance must
// leave the run 'running' with a claimable handback attempt carrying the
// intervention. Observed here: with a real pinned plan the resume's own
// follow-up advance (runtime.MemStore.ResumeFromHumanTakeover step 3) already
// lands the run running and its node ready, so the attempt is claimable before
// the reconciler's next advance — the § 5.3 claim needs no engine fix, only a
// plan the advancer can program.

// m4TakeoverDoc is the smallest document that programs a worker-side agent
// node: one agent.acp node, one required input, one retry-eligible error
// class. It is validated by PipelineDefinitions before anything uses it.
func m4TakeoverDoc(t *testing.T, profile string) string {
	t.Helper()
	return `apiVersion: communication.dev/v1alpha1
kind: Pipeline
metadata:
  name: takeover-resume
  description: One agent node, used to prove a takeover resumes to a claimable attempt.
spec:
  inputs:
    type: object
    required: [goal]
    properties:
      goal: {type: string, minLength: 1}
  policies:
    maxConcurrentNodes: 1
    workspaceMode: worktree
    cancelPolicy: cascade
  nodes:
  - id: implement
    kind: agent.acp
    timeoutSeconds: 900
    retry:
      maxAttempts: 3
      backoff: {baseSeconds: 5, multiplier: 2, maxSeconds: 120, jitter: false}
      retriableErrors: [infra, interrupted, timeout, agent_error, invalid_output]
    config:
      profile: ` + profile + `
      sessionMode: new
      prompt: |
        Goal: ${{ inputs.goal }}
        Reply with JSON {summary}.
`
}

// m4TakeoverValidate runs the same definition-service Validate the UI calls
// before a draft can be recorded, and refuses to go further without a real
// compiled plan — the bytes the run will pin.
func m4TakeoverValidate(t *testing.T, ctx context.Context, c api.Caller, doc string) api.ValidationOutcome {
	t.Helper()
	defs, err := NewPipelineDefinitions()
	if err != nil {
		t.Fatalf("NewPipelineDefinitions: %v", err)
	}
	outcome, err := defs.Validate(ctx, c, doc)
	if err != nil {
		t.Fatalf("PipelineDefinitions.Validate: %v", err)
	}
	if !outcome.Body.Valid {
		t.Fatalf("the takeover document did not validate: %+v", outcome.Body)
	}
	if len(outcome.CompiledPlan) == 0 || outcome.PlanDigest == "" {
		t.Fatalf("validate returned no compiled plan: %+v", outcome)
	}
	return outcome
}

// m4TakeoverPublished validates doc with the serve-wired definition service
// and publishes it through APIPipelineStore, returning pipeline + revision ids.
func m4TakeoverPublished(t *testing.T, f *m4Fixture, doc string, outcome api.ValidationOutcome) (string, string) {
	t.Helper()
	ctx := testCtx(t)
	c := api.Caller{UserID: f.userID, OrganizationID: f.orgID, IsOrgAdmin: true}
	token := migFixtureToken(t)

	store := APIPipelineStore{S: f.pipelines, ExtractUI: ExtractPipelineUI}
	pipe, err := store.CreatePipeline(ctx, c, "ato-pipe-"+token, "takeover resume pipe", "")
	if err != nil {
		t.Fatalf("CreatePipeline: %v", err)
	}
	t.Cleanup(func() { m4LifecycleMop(t, f, pipe.ID) })
	draft, err := store.CreateDraft(ctx, c, pipe.ID, api.DraftCreateInput{
		DocumentYAML: doc, SourceKind: "manual", SourceSHA256: m4Hex("ato/src/" + token),
	})
	if err != nil {
		t.Fatalf("CreateDraft: %v", err)
	}
	validated, err := store.RecordValidation(ctx, c, draft.ID, api.DraftValidationRecord{
		Status:            "valid",
		Body:              outcome.Body,
		CanonicalDocument: outcome.CanonicalDocument,
		RevisionDigest:    outcome.RevisionDigest,
		CompiledPlan:      outcome.CompiledPlan,
		PlanDigest:        outcome.PlanDigest,
		DigestScope:       outcome.DigestScope,
	})
	if err != nil {
		t.Fatalf("RecordValidation: %v", err)
	}
	rev, err := store.PublishDraft(ctx, c, draft.ID, api.DraftPublishInput{
		ExpectedVersion: validated.Version, VersionLabel: "1.0.0", DocumentText: doc,
		SchemaDigest: m4Digest("ato-schema"), CelEnvDigest: m4Digest("ato-celenv"),
	})
	if err != nil {
		t.Fatalf("PublishDraft: %v", err)
	}
	return pipe.ID, rev.ID
}

func TestM4TakeoverResumesRunToClaimable(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)
	token := migFixtureToken(t)
	profile := fmt.Sprintf("ato-prof-%s", token)
	atsProfile(t, ctx, f, f.orgID, profile, "claude", "ask", false)

	doc := m4TakeoverDoc(t, profile)
	caller := api.Caller{UserID: f.userID, OrganizationID: f.orgID, IsOrgAdmin: true}
	pipelineID, revisionID := m4TakeoverPublished(t, f, doc, m4TakeoverValidate(t, ctx, caller, doc))

	// --- the run, created and advanced exactly as serve does --------------
	as, err := APIAssignmentStore{S: f.pipelines}.CreateAssignment(ctx, caller, f.projectID,
		api.AssignmentCreateInput{PipelineID: pipelineID, PinnedRevisionID: revisionID, MaxConcurrentRuns: 1})
	if err != nil {
		t.Fatalf("CreateAssignment: %v", err)
	}
	runStore := &RunStore{Pool: f.pool, LeaseTTL: m4TakeoverLease}
	children := &M4Children{Runs: runStore}
	rt := NewRuntimeStore(f.pool, &runtime.Advancer{Deps: runtime.AdvancerDeps{Children: children}})
	children.Runtime = rt
	driver := NewM4Driver(f.pool, rt, nil)

	view, created, err := APIRunStore{Runs: runStore, Runtime: rt}.CreateRun(ctx, caller,
		api.RunCreateInput{
			ProjectID:    f.projectID,
			AssignmentID: as.ID,
			Inputs:       map[string]json.RawMessage{"goal": json.RawMessage(`"add a lookup table"`)},
			Key:          "ato-run-" + token,
			RequestSHA:   m4Hex("ato/body/" + token),
			TriggeredBy:  f.userID,
		})
	if err != nil || !created || view.ID == "" {
		t.Fatalf("CreateRun = (%+v, %v, %v)", view, created, err)
	}
	runID := view.ID
	driver.Trigger(ctx, runID)

	// --- a real worker claims the agent attempt ---------------------------
	workerID := m4Worker(t, ctx, f.pool, "ato", 2)
	// Registered AFTER the worker: cleanups run LIFO, so the turn rows must
	// lose their worker reference before m4Worker's own sweep deletes it.
	t.Cleanup(func() {
		if _, err := f.pool.Exec(context.Background(),
			`UPDATE conversation_turns SET worker_id = NULL WHERE worker_id = $1`, workerID); err != nil {
			t.Errorf("clear turn worker stamps: %v", err)
		}
	})
	atsConversationSweep(t, f)
	ats := &AttemptStore{Runs: runStore}
	sessions := &AttemptSessions{Runs: f.runs}
	if err := rt.Advance(ctx, runID); err != nil {
		t.Fatalf("advance after create: %v", err)
	}
	if s := m4TakeoverRow(t, f, `SELECT status FROM runs WHERE id = $1::uuid`, runID); s != "running" {
		t.Fatalf("run status before the takeover = %s, want running", s)
	}
	claims, err := ats.ClaimAttempts(ctx, workerID, 1)
	if err != nil || len(claims) != 1 {
		t.Fatalf("first claim = (%v, %v), want one attempt", claims, err)
	}
	c := claims[0]
	if err := ats.BeginAttempt(ctx, c); err != nil {
		t.Fatalf("BeginAttempt: %v", err)
	}
	conv, ok, err := sessions.ConversationFor(ctx, c)
	if err != nil || !ok || conv.ConversationID == "" {
		t.Fatalf("ConversationFor = (%v, %v, %v), want a stamped pair", conv, ok, err)
	}
	if kind := m4TakeoverRow(t, f, `SELECT controller_kind FROM conversation_control WHERE conversation_id = $1::uuid`, conv.ConversationID); kind != events.ControllerKindRunAttempt {
		t.Fatalf("control kind = %s, want run_attempt before the takeover", kind)
	}
	t.Logf("run status straight after return-control = %s", m4TakeoverDrive(t, f, ctx, c.AttemptID, conv.ConversationID, conv.TurnID))

	// --- the handback attempt is claimable -------------------------------
	if err := rt.Advance(ctx, runID); err != nil {
		t.Fatalf("advance after return-control: %v", err)
	}
	driver.Trigger(ctx, runID)
	if status, reason := func() (string, string) {
		var s, r string
		if err := f.pool.QueryRow(ctx, `SELECT status, coalesce(paused_reason, '') FROM runs WHERE id = $1::uuid`, runID).Scan(&s, &r); err != nil {
			t.Fatal(err)
		}
		return s, r
	}(); status != runtime.RunRunning || reason != "" {
		t.Errorf("run = (%s, %s) after the post-return advance, want (%s, no pause)",
			status, reason, runtime.RunRunning)
	}
	var newAttempt, newNum, newStatus, newCtx, nodeID string
	if err := f.pool.QueryRow(ctx, `
		SELECT a.id::text, a.attempt_number::text, a.status,
		       coalesce(a.retry_context::text, ''), ne.node_id
		FROM attempts a JOIN node_executions ne ON ne.id = a.node_execution_id
		WHERE ne.run_id = $1::uuid
		ORDER BY a.attempt_number DESC LIMIT 1`, runID).
		Scan(&newAttempt, &newNum, &newStatus, &newCtx, &nodeID); err != nil {
		t.Fatalf("read the handback attempt: %v", err)
	}
	if newAttempt == c.AttemptID || nodeID != "implement" {
		t.Fatalf("handback attempt = (id %s, node %s), want a fresh attempt on the interrupted implement node", newAttempt, nodeID)
	}
	// The number is above the interrupted attempt's but not necessarily its +1:
	// the worker's own claim already bumped node_executions.attempt_count
	// (ADR-0023 § 4 step 6), which is the count the handback is numbered from.
	if newNum == "1" {
		t.Errorf("handback attempt number = %s, want a number above the interrupted attempt's", newNum)
	}
	if newStatus != runtime.AttemptQueued {
		t.Errorf("handback attempt status = %s, want %s", newStatus, runtime.AttemptQueued)
	}
	var ctxMap map[string]any
	if err := json.Unmarshal([]byte(newCtx), &ctxMap); err != nil {
		t.Fatalf("handback retry_context is not json: %q (%v)", newCtx, err)
	}
	takeover, ok := ctxMap["human_takeover"].(map[string]any)
	if !ok {
		t.Fatalf("handback retry_context %q does not name the human takeover", newCtx)
	}
	if turns, _ := takeover["turns"].([]any); len(turns) != 1 {
		t.Errorf("retry_context.human_takeover.turns = %v, want the one intervention", takeover["turns"])
	}
	if cls, _ := ctxMap["error_class"].(string); cls != "interrupted" {
		t.Errorf("retry_context.error_class = %v, want interrupted (ADR-0023 § 6 shape)", ctxMap["error_class"])
	}
	// Exactly one handback attempt exists — the advance after the resume must
	// not queue a second one.
	if n := awCount(t, ctx, f, `SELECT count(*) FROM attempts a JOIN node_executions ne ON ne.id = a.node_execution_id WHERE ne.run_id = $1::uuid AND a.attempt_number > 1`, runID); n != 1 {
		t.Errorf("attempts after the handback = %d rows numbered >1, want exactly the one handback attempt", n)
	}
	if st := m4TakeoverRow(t, f, `SELECT status FROM node_executions WHERE id = $1::uuid`, c.NodeExecutionID); st != runtime.NodeReady {
		t.Errorf("node status before the second claim = %s, want %s", st, runtime.NodeReady)
	}
	claims2, err := ats.ClaimAttempts(ctx, workerID, 1)
	if err != nil {
		t.Fatalf("second claim: %v", err)
	}
	if len(claims2) != 1 {
		t.Fatalf("second claim = %d attempts (%v), want the handback attempt claimable", len(claims2), claims2)
	}
	if claims2[0].AttemptID != newAttempt || claims2[0].NodeExecutionID != c.NodeExecutionID {
		t.Errorf("second claim = (%s, node %s), want (%s, node %s)",
			claims2[0].AttemptID, claims2[0].NodeExecutionID, newAttempt, c.NodeExecutionID)
	}
	if claims2[0].AttemptNumber < 2 {
		t.Errorf("second claim attempt_number = %d, want above the interrupted attempt's", claims2[0].AttemptNumber)
	}
}

// m4TakeoverDrive is the human's stretch of § 5.3 as the API calls it: take
// control, drive one turn of their own, hand the wheel back.
func m4TakeoverDrive(t *testing.T, f *m4Fixture, ctx context.Context, attemptID, conversationID, turnID string) string {
	t.Helper()
	cnv := &CnvStore{Pool: f.pool}
	// A plain project member — no org-admin shortcut — is who takes the wheel.
	// The m4 fixture's project carries no membership row, so state it.
	if _, err := f.pool.Exec(ctx, `
		INSERT INTO memberships (project_id, user_id, role)
		VALUES ($1::uuid, $2::uuid, 'maintainer')
		ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
		f.projectID, f.userID); err != nil {
		t.Fatalf("seed the takeover member's membership: %v", err)
	}
	t.Cleanup(func() {
		if _, err := f.pool.Exec(context.Background(),
			`DELETE FROM memberships WHERE project_id = $1 AND user_id = $2`,
			f.projectID, f.userID); err != nil {
			t.Errorf("cleanup membership: %v", err)
		}
	})
	c := Caller{UserID: f.userID, OrganizationID: f.orgID}
	version := 0
	if err := f.pool.QueryRow(ctx, `SELECT version FROM conversation_control WHERE conversation_id = $1::uuid`, conversationID).Scan(&version); err != nil {
		t.Fatalf("read control version: %v", err)
	}
	if _, err := cnv.TakeControl(ctx, c, conversationID, version); err != nil {
		t.Fatalf("TakeControl: %v", err)
	}
	if st := m4TakeoverRow(t, f, `
		SELECT r.status FROM runs r
		JOIN node_executions ne ON ne.run_id = r.id
		JOIN attempts a ON a.node_execution_id = ne.id
		WHERE a.id = $1::uuid`, attemptID); st != runtime.RunPaused {
		t.Fatalf("run status during the takeover = %s, want %s", st, runtime.RunPaused)
	}
	// The worker acknowledges the cancel and closes its turn; only then can
	// the human's own turn exist (one live turn per conversation).
	if _, err := f.pool.Exec(ctx, `
		UPDATE conversation_turns SET status = 'interrupted', finished_at = now()
		WHERE id = $1::uuid AND status IN ('leased', 'running')`, turnID); err != nil {
		t.Fatalf("close the taken-over turn as the worker would: %v", err)
	}
	if _, err := f.pool.Exec(ctx, `
		INSERT INTO conversation_turns (conversation_id, prompt, submitted_by)
		VALUES ($1::uuid, $2, $3::uuid)`, conversationID, "use a lookup table instead", c.UserID); err != nil {
		t.Fatalf("record the human's intervention: %v", err)
	}
	if err := f.pool.QueryRow(ctx, `SELECT version FROM conversation_control WHERE conversation_id = $1::uuid`, conversationID).Scan(&version); err != nil {
		t.Fatalf("read control version: %v", err)
	}
	if _, err := cnv.ReturnControl(ctx, c, conversationID, version); err != nil {
		t.Fatalf("ReturnControl: %v", err)
	}
	return m4TakeoverRow(t, f, `SELECT status FROM runs r WHERE r.id = (
		SELECT ne.run_id FROM node_executions ne JOIN attempts a ON a.node_execution_id = ne.id WHERE a.id = $1::uuid)`, attemptID)
}
