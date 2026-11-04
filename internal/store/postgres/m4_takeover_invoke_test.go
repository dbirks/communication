package postgres

// TestM4TakeoverReturnControlWithWaitingInvoke is the advance-children-nil
// regression: return-control's resume advance must be able to POLL a waiting
// pipeline.invoke in the caller's own transaction. The lab (9fd86e7) proved
// the failure — the conversation-side transactions drove the engine through
// an advancer with no ChildResolver, and the resume's follow-up advance
// nil-dereferenced in pollInvoke, so the request 500'd, the control was never
// returned and the run sat paused. Here the run carries, beside its live
// agent attempt, an invoke node that has already booked its child and parks
// waiting on it: the takeover interrupts the agent attempt and pauses the
// run, the human drives one turn of their own, and return-control must land
// — the resume's advance polls the waiting child through M4Children (the same
// implementation the serve driver uses, riding the caller's transaction)
// instead of panicking — leaving the run un-paused, the invoke node still
// waiting, and the child run alive.

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/dbirks/communication/internal/api"
	"github.com/dbirks/communication/internal/events"
	"github.com/dbirks/communication/internal/pipelines/runtime"
)

// m4TCIChildDoc is the invoked pipeline: one published pipeline the parent's
// invoke names BY NAME (§ 5.5 resolves the newest published revision).
func m4TCIChildDoc(t *testing.T, slug string) string {
	t.Helper()
	return fmt.Sprintf(`apiVersion: communication.dev/v1alpha1
kind: Pipeline
metadata:
  name: %s
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
    kind: process.exec
    timeoutSeconds: 300
    config:
      executable: exit
      args: ["0"]
`, slug)
}

// m4TCIParentDoc is the takeover-side pipeline: an agent.acp node the worker
// can take over, and an INDEPENDENT pipeline.invoke that books its child on
// the first advance and then waits on it — so the takeover's resume advance
// must poll it while the agent side is paused for the human.
func m4TCIParentDoc(profile, childSlug string) string {
	return fmt.Sprintf(`apiVersion: communication.dev/v1alpha1
kind: Pipeline
metadata:
  name: takeover-invoke-parent
spec:
  inputs:
    type: object
    required: [goal]
    properties:
      goal: {type: string, minLength: 1}
  policies:
    maxConcurrentNodes: 2
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
      profile: %s
      sessionMode: new
      prompt: |
        Goal: ${{ inputs.goal }}
        Reply with JSON {summary}.
  - id: deploy
    kind: pipeline.invoke
    timeoutSeconds: 1800
    config:
      pipeline: %s
      waitFor: completion
      inputs:
        goal: ${{ inputs.goal }}
`, profile, childSlug)
}

func TestM4TakeoverReturnControlWithWaitingInvoke(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)
	token := migFixtureToken(t)
	profile := fmt.Sprintf("tci-prof-%s", token)
	atsProfile(t, ctx, f, f.orgID, profile, "claude", "ask", false)

	caller := api.Caller{UserID: f.userID, OrganizationID: f.orgID, IsOrgAdmin: true}
	childSlug := "tci-child-" + token
	childDoc := m4TCIChildDoc(t, childSlug)
	_, _ = m4InvokePublish(t, f, childSlug, childDoc)
	parentDoc := m4TCIParentDoc(profile, childSlug)
	parentPipeID, parentRevID := m4InvokePublish(t, f, "tci-pipe-"+token, parentDoc)

	// --- the run, created and advanced exactly as serve does --------------
	as, err := APIAssignmentStore{S: f.pipelines}.CreateAssignment(ctx, caller, f.projectID,
		api.AssignmentCreateInput{PipelineID: parentPipeID, PinnedRevisionID: parentRevID, MaxConcurrentRuns: 1})
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
			Key:          "tci-run-" + token,
			RequestSHA:   m4Hex("tci/body/" + token),
			TriggeredBy:  f.userID,
		})
	if err != nil || !created || view.ID == "" {
		t.Fatalf("CreateRun = (%+v, %v, %v)", view, created, err)
	}
	runID := view.ID
	driver.Trigger(ctx, runID)

	// The invoke node booked its child on the first advance and waits on it —
	// the exact row shape the lab's return-control landed on.
	if st := m4TakeoverRow(t, f, `
		SELECT coalesce(ne.status, '') FROM node_executions ne
		WHERE ne.run_id = $1::uuid AND ne.kind = 'pipeline.invoke'`, runID); st != "waiting" {
		t.Fatalf("invoke node status after the first advance = %q, want waiting", st)
	}
	childStatus := m4TakeoverRow(t, f,
		`SELECT coalesce(status, '') FROM runs WHERE parent_run_id = $1::uuid`, runID)
	if childStatus != "queued" {
		t.Fatalf("child run status = %q, want queued (the invoke's booking is live)", childStatus)
	}

	// --- a real worker claims the agent attempt ---------------------------
	workerID := m4Worker(t, ctx, f.pool, "tci", 2)
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
	claims, err := ats.ClaimAttempts(ctx, workerID, 1)
	if err != nil || len(claims) != 1 {
		t.Fatalf("first claim = (%v, %v), want the one agent attempt", claims, err)
	}
	c := claims[0]
	if err := ats.BeginAttempt(ctx, c); err != nil {
		t.Fatalf("BeginAttempt: %v", err)
	}
	conv, ok, err := sessions.ConversationFor(ctx, c)
	if err != nil || !ok || conv.ConversationID == "" {
		t.Fatalf("ConversationFor = (%v, %v, %v), want a stamped pair", conv, ok, err)
	}
	convID, turnID := conv.ConversationID, conv.TurnID

	// --- the human's stretch: take control, drive, return -----------------
	// A plain project member is who takes the wheel (m4TakeoverDrive's rule).
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
	cnv := &CnvStore{Pool: f.pool}
	by := Caller{UserID: f.userID, OrganizationID: f.orgID}
	version := 0
	if err := f.pool.QueryRow(ctx, `SELECT version FROM conversation_control WHERE conversation_id = $1::uuid`, convID).Scan(&version); err != nil {
		t.Fatalf("read control version: %v", err)
	}
	if _, err := cnv.TakeControl(ctx, by, convID, version); err != nil {
		t.Fatalf("TakeControl: %v", err)
	}
	if st, reason := func() (string, string) {
		var s, r string
		if err := f.pool.QueryRow(ctx, `SELECT status, coalesce(paused_reason, '') FROM runs WHERE id = $1::uuid`, runID).Scan(&s, &r); err != nil {
			t.Fatal(err)
		}
		return s, r
	}(); st != runtime.RunPaused || reason != "human_takeover" {
		t.Fatalf("run = (%s, %s) during the takeover, want (paused, human_takeover)", st, reason)
	}
	// The worker acknowledges the cancel and closes its own turn; only then
	// can the human's own turn exist (one live turn per conversation).
	if _, err := f.pool.Exec(ctx, `
		UPDATE conversation_turns SET status = 'interrupted', finished_at = now()
		WHERE id = $1::uuid AND status IN ('leased', 'running')`, turnID); err != nil {
		t.Fatalf("close the taken-over turn as the worker would: %v", err)
	}
	if _, err := f.pool.Exec(ctx, `
		INSERT INTO conversation_turns (conversation_id, prompt, submitted_by)
		VALUES ($1::uuid, $2, $3::uuid)`, convID, "use a lookup table instead", by.UserID); err != nil {
		t.Fatalf("record the human's intervention: %v", err)
	}

	// --- return control ---------------------------------------------------
	// THIS is the API-side advance that panicked in the lab: the resume's
	// follow-up advance lands on the waiting invoke and must poll it through
	// the wired ChildResolver in the caller's transaction — no panic, no 500.
	if err := f.pool.QueryRow(ctx, `SELECT version FROM conversation_control WHERE conversation_id = $1::uuid`, convID).Scan(&version); err != nil {
		t.Fatalf("read control version: %v", err)
	}
	if _, err := cnv.ReturnControl(ctx, by, convID, version); err != nil {
		t.Fatalf("ReturnControl: %v — the resume's advance must poll the waiting invoke, not die on it", err)
	}

	// The takeover pause is lifted and the run drives again.
	status, reason := func() (string, string) {
		var s, r string
		if err := f.pool.QueryRow(ctx, `SELECT status, coalesce(paused_reason, '') FROM runs WHERE id = $1::uuid`, runID).Scan(&s, &r); err != nil {
			t.Fatal(err)
		}
		return s, r
	}()
	if status != runtime.RunRunning && status != runtime.RunQueued {
		t.Errorf("run status after return-control = %s, want running (the resume re-derives it)", status)
	}
	if reason != "" {
		t.Errorf("paused_reason after return-control = %q, want cleared", reason)
	}

	// The waiting invoke is UNTOUCHED by the resume's pass: it still waits on
	// the same live child, which is exactly what a wired poll writes.
	if st := m4TakeoverRow(t, f, `
		SELECT coalesce(ne.status, '') FROM node_executions ne
		WHERE ne.run_id = $1::uuid AND ne.kind = 'pipeline.invoke'`, runID); st != runtime.NodeWaiting {
		t.Errorf("invoke node after return-control = %s, want %s (the poll only read the child)", st, runtime.NodeWaiting)
	}
	if cs := m4TakeoverRow(t, f,
		`SELECT coalesce(status, '') FROM runs WHERE parent_run_id = $1::uuid`, runID); cs == "" || cs == "completed" || cs == "failed" || cs == "cancelled" || cs == "interrupted" {
		t.Errorf("child run status after return-control = %q, want still live", cs)
	}

	// And the handback attempt exists with the intervention recorded.
	var newAttempt, newNum, newStatus string
	if err := f.pool.QueryRow(ctx, `
		SELECT a.id::text, a.attempt_number::text, a.status
		FROM attempts a
		WHERE a.run_id = $1::uuid
		ORDER BY a.attempt_number DESC LIMIT 1`, runID).Scan(&newAttempt, &newNum, &newStatus); err != nil {
		t.Fatalf("read the handback attempt: %v", err)
	}
	if newNum == "1" || newStatus != runtime.AttemptQueued {
		t.Errorf("handback attempt = (number %s, %s), want a fresh queued attempt", newNum, newStatus)
	}
	if kind := m4TakeoverRow(t, f, `
		SELECT controller_kind FROM conversation_control WHERE conversation_id = $1::uuid`, convID); kind != events.ControllerKindRunAttempt {
		t.Errorf("control after return = %s, want run_attempt", kind)
	}
	// The child the resume polled was NOT double-booked: one invocation row
	// for the one invoke node.
	if n := m4TakeoverRow(t, f, `
		SELECT count(*)::text FROM pipeline_invocations WHERE run_id = $1::uuid`, runID); n != "1" {
		t.Errorf("invocation rows = %s, want 1 (a retried pass answers from the booking)", n)
	}
}

// TestM4TakeoverRuntimeWiring is the wiring-time half of the same bug: the
// conversation-side transactions' runtime adapter must carry the child
// resolver — the same implementation the serve driver uses — so the bare
// per-pass advancer advancerForTx builds for it can poll a waiting
// pipeline.invoke instead of dying on one. Building the API's conversation
// store without a Children resolver is impossible through this constructor.
func TestM4TakeoverRuntimeWiring(t *testing.T) {
	rs := takeoverRuntime()
	if rs.Pool != nil {
		t.Fatalf("takeoverRuntime() carries a pool, want nil: the transaction is the caller's")
	}
	if rs.Adv != nil {
		t.Fatalf("takeoverRuntime() carries an advancer shell, want nil: 'no advancer' means this caller does not schedule (TestM4Takeover's hand-pinned plan relies on it)")
	}
	if rs.Children == nil {
		t.Fatalf("takeoverRuntime() built the API's conversation store without the ChildResolver — exactly the wiring the return-control panic proved missing")
	}
	if _, ok := rs.Children.(*M4Children); !ok {
		t.Fatalf("takeoverRuntime() resolver = %T, want the serve driver's M4Children", rs.Children)
	}
}

// TestM4TakeoverAdvancerForTxCarriesTheResolver pins the seam that used to
// drop the resolver: for a store that carries no advancer shell (the
// conversation-side shape), the bare per-pass advancer a row WITH a
// programmable snapshot hydrates must carry both the store's child resolver
// and the pass's transaction as its context — so a waiting invoke is
// pollable on the caller's own transaction.
func TestM4TakeoverAdvancerForTxCarriesTheResolver(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)
	token := migFixtureToken(t)
	// A real compiled plan, published through the ordinary path.
	_, revID := m4InvokePublish(t, f, "tci-adv-"+token, m4TCIParentDoc("some-profile", "tci-child-"+token))
	runID := f.m4QueuedRun(t, ctx, "", 0)
	if _, err := f.pool.Exec(ctx, `UPDATE runs SET plan_snapshot = r.compiled_plan
		FROM pipeline_revisions r WHERE runs.id = $1::uuid AND r.id = $2::uuid`, runID, revID); err != nil {
		t.Fatalf("pin the real compiled plan: %v", err)
	}
	rs := takeoverRuntime()
	tx, err := f.pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	adv, err := rs.advancerForTx(ctx, tx, runID)
	if err != nil {
		t.Fatalf("advancerForTx: %v", err)
	}
	if adv == nil {
		t.Fatalf("programmable snapshot with no advancer shell = nil, want the bare pass advancer (with the resolver)")
	}
	if adv.Prog == nil {
		t.Fatalf("pass advancer carries no program for a row that pins one")
	}
	if _, ok := adv.Deps.Children.(*M4Children); !ok {
		t.Fatalf("pass advancer resolver = %v, want the store's M4Children carried through", adv.Deps.Children)
	}
	if _, ok := passTx(adv.Deps.Context); !ok {
		t.Fatalf("pass advancer's context does not carry this transaction: the resolver would read off the pool")
	}
	// The no-scheduling meaning survives for rows without a program.
	if _, err := f.pool.Exec(ctx, `UPDATE runs SET plan_snapshot = '{}'::jsonb WHERE id = $1::uuid`, runID); err != nil {
		t.Fatalf("clear the snapshot: %v", err)
	}
	if adv, err := rs.advancerForTx(ctx, tx, runID); err != nil || adv != nil {
		t.Fatalf("unprogrammable row with no advancer shell = (%v, %v), want (nil, nil): no scheduling", adv, err)
	}
}
