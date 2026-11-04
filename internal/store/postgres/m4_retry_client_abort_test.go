package postgres

// Regression suite for the lab failure at commit 5b15443 (Actions run
// 41815322185, api-b request a6764060d10b264cf5d027a2ca07fdf0, 2026-11-04):
//
//	postgres: append run event (run.retried): context canceled
//	POST /api/v1/runs/{id}/retry status=500 duration_ms=25.4
//
// The retry's settle pass ran on the REQUEST's context. The browser (the
// m5-journey step "approve, watch the run fail, and retry the node that
// failed") clicked Retry and navigated to the run page a few milliseconds
// later; the navigation cancelled the in-flight POST, settle saw a cancelled
// context mid-pass and ROLLED BACK, and the run.retried row the request was
// authorized to apply never persisted — the timeline never shows run.retried
// and the run silently never retried. Every read and write of the pass now
// rides the pass's own bounded deadline (settle's WithTimeout over
// context.WithoutCancel): a cancel arriving mid-pass no longer un-applies an
// in-flight, authorized mutation; a cancel BEFORE the pass still refuses
// honestly. The journal append, the state write-back and the commit are all
// part of that one detached pass — none of them carries a captured or an
// earlier request's context.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/dbirks/communication/internal/api"
	"github.com/dbirks/communication/internal/pipelines/runtime"
)

// m4RetryDoc is the miniature of the m5-journey step 6: one worker step the
// fake worker completes, the maintainer's approval gate, then the step that
// fails on purpose — a failed run whose only non-succeeded terminal node is
// the retry's default target.
func m4RetryDoc(t *testing.T) string {
	t.Helper()
	return `apiVersion: communication.dev/v1alpha1
kind: Pipeline
metadata:
  name: m5-retry-mini
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
  - id: work
    kind: process.exec
    timeoutSeconds: 300
    config:
      executable: exit
      args: ["0"]
      workspace:
        mode: read_only
        repositories: []
      outputExtraction: {mode: none}
    outputs:
      type: object
      properties:
        ok: {type: string}
  - id: approve
    kind: human.approval
    dependsOn: [work]
    retry:
      maxAttempts: 1
    config:
      summary: |
        Approve ${{ inputs.goal }}
      approverRoles: [maintainer]
      deadlineSeconds: 86400
      onTimeout: fail
  - id: verify
    kind: process.exec
    dependsOn: [approve]
    timeoutSeconds: 300
    config:
      executable: exit
      args: ["0"]
      workspace:
        mode: read_only
        repositories: []
      outputExtraction: {mode: none}
    outputs:
      type: object
      properties:
        ok: {type: string}
`
}

// m4RetryDriveToFailed gates the mini run the way the lab's e2e does — the
// pre-gate step completes by the worker's own claim/start/complete, the gate
// is decided by the real approval route, the post-gate step fails by the
// worker's own Fail — and returns the API run store the retry legs drive.
func m4RetryDriveToFailed(t *testing.T, ctx context.Context, f *m4Fixture, rt *RuntimeStore,
	runStore *RunStore, caller api.Caller, runID, tag string) APIRunStore {
	t.Helper()
	runAPI := APIRunStore{Runs: runStore, Runtime: rt}
	approvals := APIApprovalStore{R: rt}

	// /work completes through the real worker trio, on a seeded run workspace
	// the checkpoint names (m4_pregate_drive_test.go's shape).
	workerID := m4Worker(t, ctx, f.pool, tag, 2)
	workspaceID := m4GateWorkspace(t, ctx, f, runID, workerID, tag)
	a, err := rt.Claim(ctx, runID, workerID)
	if err != nil || a == nil {
		t.Fatalf("claim /work attempt: a=%v err=%v (the graph did not ready /work)", a, err)
	}
	if err := rt.Start(ctx, runID, a.ID, workerID, a.FencingToken); err != nil {
		t.Fatalf("start /work attempt: %v", err)
	}
	ckpt := runtime.CheckpointRecord{
		InputsDigest:  "sha256:" + fmt.Sprintf("%064d", 1),
		OutputsDigest: "sha256:" + fmt.Sprintf("%064d", 2),
		VolumeID:      "sha256:" + fmt.Sprintf("%064d", 3),
		WorkspaceID:   workspaceID, WorkerID: workerID,
	}
	if err := rt.Complete(ctx, runID, a.ID, workerID, a.FencingToken,
		map[string]any{"ok": "done"}, "sha256:"+fmt.Sprintf("%064d", 4), nil, "", ckpt); err != nil {
		t.Fatalf("complete /work attempt: %v", err)
	}
	if statuses := m4LifeNodeStatuses(t, f, runID); statuses["/work"] != runtime.NodeSucceeded {
		t.Fatalf("/work = %v, want succeeded", statuses)
	}

	// The gate opens and the maintainer decides it through the real route.
	approvalID, version, _ := m4GateRow(t, ctx, f, runID)
	if _, err := approvals.DecideApproval(ctx, caller, approvalID, "approved", "the plan looks right",
		version, func(api.ApprovalView, string) (bool, string) { return true, "" }); err != nil {
		t.Fatalf("approve the gate: %v", err)
	}

	// /verify fails through the worker's own Fail (maxAttempts 1: the failure
	// is the node's terminal, and the run's).
	a, err = rt.Claim(ctx, runID, workerID)
	if err != nil || a == nil {
		t.Fatalf("claim /verify attempt: a=%v err=%v (the gate's decision did not ready /verify)", a, err)
	}
	if err := rt.Start(ctx, runID, a.ID, workerID, a.FencingToken); err != nil {
		t.Fatalf("start /verify attempt: %v", err)
	}
	if err := rt.Fail(ctx, runID, a.ID, workerID, a.FencingToken,
		"infra", "the plan describes a test suite the fixture repository does not have", nil); err != nil {
		t.Fatalf("fail /verify attempt: %v", err)
	}
	if status := m4TakeoverRow(t, f, `SELECT status FROM runs WHERE id = $1::uuid`, runID); status != runtime.RunFailed {
		t.Fatalf("run = %s after the failed /verify, want failed", status)
	}
	return runAPI
}

// TestM4RetryAfterApprovalGateFailure is the m5 sequence in miniature on the
// real database: approve the gate, watch the run fail, retry — the route
// answers the run (no error), the run reopens, and the journal carries
// exactly ONE run.retried, which is what the timeline the e2e asserts on
// renders.
func TestM4RetryAfterApprovalGateFailure(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)
	token := migFixtureToken(t)
	pipeID, revID := m4InvokePublish(t, f, "m4retry-mini-"+token, m4RetryDoc(t))

	caller := api.Caller{UserID: f.userID, OrganizationID: f.orgID, IsOrgAdmin: true}
	runStore := &RunStore{Pool: f.pool}
	children := &M4Children{Runs: runStore}
	rt := NewRuntimeStore(f.pool, &runtime.Advancer{Deps: runtime.AdvancerDeps{Children: children}})
	children.Runtime = rt

	as, err := APIAssignmentStore{S: f.pipelines}.CreateAssignment(ctx, caller, f.projectID,
		api.AssignmentCreateInput{PipelineID: pipeID, PinnedRevisionID: revID, MaxConcurrentRuns: 1})
	if err != nil {
		t.Fatalf("CreateAssignment: %v", err)
	}
	key := "m4retry-mini-" + token
	view, created, err := APIRunStore{Runs: runStore, Runtime: rt}.CreateRun(ctx, caller,
		api.RunCreateInput{
			ProjectID:    f.projectID,
			AssignmentID: as.ID,
			Inputs:       map[string]json.RawMessage{"goal": json.RawMessage(`"make the fixture honest"`)},
			Key:          key,
			RequestSHA:   m4Hex("body/" + key),
			TriggeredBy:  f.userID,
		})
	if err != nil || !created || view.ID == "" {
		t.Fatalf("CreateRun = (%+v, %v, %v)", view, created, err)
	}
	rt.Advance(ctx, view.ID)

	runAPI := m4RetryDriveToFailed(t, ctx, f, rt, runStore, caller, view.ID, "m4retry")

	updated, err := runAPI.RetryRun(ctx, caller, view.ID, api.RunRetryInput{RequestedBy: f.userID})
	if err != nil {
		t.Fatalf("retry of the failed run: %v — the reopen must land, exactly as the e2e's click must", err)
	}
	if updated.Status != runtime.RunQueued && updated.Status != runtime.RunRunning {
		t.Fatalf("run after the retry = %s, want reopened (queued/running)", updated.Status)
	}
	if n := m4RunsWriteCount(t, f, view.ID, "run.retried"); n != 1 {
		t.Fatalf("run.retried = %d, want 1 (the timeline's row, journaled with the state)", n)
	}
	var attempts, latestStatus string
	if err := f.pool.QueryRow(ctx, `
		SELECT count(*)::text,
		       (SELECT a2.status FROM attempts a2
		        WHERE a2.node_execution_id IN (
		            SELECT ne2.id FROM node_executions ne2
		            WHERE ne2.run_id = $1::uuid AND ne2.node_instance_key = '/verify')
		        ORDER BY a2.attempt_number DESC LIMIT 1)
		FROM attempts a1
		WHERE a1.node_execution_id IN (
		        SELECT ne3.id FROM node_executions ne3
		        WHERE ne3.run_id = $1::uuid AND ne3.node_instance_key = '/verify')`, view.ID).Scan(&attempts, &latestStatus); err != nil {
		t.Fatalf("read /verify attempts: %v", err)
	}
	if attempts != "2" {
		t.Errorf("/verify attempts = %s, want the failed one and the retry's fresh one", attempts)
	}
	if latestStatus != runtime.AttemptQueued {
		t.Errorf("the retry's /verify attempt = %s, want queued", latestStatus)
	}
}

// m4TakeoverRetryDoc is the takeover arm's pipeline: an agent.acp step the
// worker can take over (the conversation half of control) followed by the
// step that fails. No retry budget on /implement: the handback attempt the
// return-control queues is ADR-0023 § 9's explicit re-queue, not a budget
// spend, and the failure that follows it must be the node's terminal.
func m4TakeoverRetryDoc(profile string) string {
	return fmt.Sprintf(`apiVersion: communication.dev/v1alpha1
kind: Pipeline
metadata:
  name: takeover-retry-parent
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
    config:
      profile: %s
      sessionMode: new
      prompt: |
        Goal: ${{ inputs.goal }}
        Reply with JSON {summary}.
  - id: verify
    kind: process.exec
    dependsOn: [implement]
    timeoutSeconds: 300
    config:
      executable: exit
      args: ["0"]
      workspace:
        mode: read_only
        repositories: []
      outputExtraction: {mode: none}
    outputs:
      type: object
      properties:
        ok: {type: string}
`, profile)
}

// TestM4RetryAfterTakeoverReturnControl is the shared-state case from the
// brief: on the SAME store instance, the conversation-side return-control
// (takeoverRuntime() over the caller's transaction, 5b15443's wiring) lands
// first, then the run's own retry lands through the API's RuntimeStore —
// the run the human took over, drove, and gave back, then failed, still
// retries: no error from either mutation, one run.retried, the handback
// attempt superseded by the retry's fresh one.
func TestM4RetryAfterTakeoverReturnControl(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)
	token := migFixtureToken(t)
	profile := "m4tr-prof-" + token
	atsProfile(t, ctx, f, f.orgID, profile, "claude", "ask", false)
	pipeID, revID := m4InvokePublish(t, f, "m4tr-parent-"+token, m4TakeoverRetryDoc(profile))

	caller := api.Caller{UserID: f.userID, OrganizationID: f.orgID, IsOrgAdmin: true}
	runStore := &RunStore{Pool: f.pool, LeaseTTL: m4TakeoverLease}
	children := &M4Children{Runs: runStore}
	rt := NewRuntimeStore(f.pool, &runtime.Advancer{Deps: runtime.AdvancerDeps{Children: children}})
	children.Runtime = rt
	driver := NewM4Driver(f.pool, rt, nil)

	as, err := APIAssignmentStore{S: f.pipelines}.CreateAssignment(ctx, caller, f.projectID,
		api.AssignmentCreateInput{PipelineID: pipeID, PinnedRevisionID: revID, MaxConcurrentRuns: 1})
	if err != nil {
		t.Fatalf("CreateAssignment: %v", err)
	}
	key := "m4tr-run-" + token
	view, created, err := APIRunStore{Runs: runStore, Runtime: rt}.CreateRun(ctx, caller,
		api.RunCreateInput{
			ProjectID:    f.projectID,
			AssignmentID: as.ID,
			Inputs:       map[string]json.RawMessage{"goal": json.RawMessage(`"add a lookup table"`)},
			Key:          key,
			RequestSHA:   m4Hex("body/" + key),
			TriggeredBy:  f.userID,
		})
	if err != nil || !created || view.ID == "" {
		t.Fatalf("CreateRun = (%+v, %v, %v)", view, created, err)
	}
	runID := view.ID
	driver.Trigger(ctx, runID)

	// A real worker claims the agent attempt, the way the lab's journey does.
	workerID := m4Worker(t, ctx, f.pool, "m4tr", 2)
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
		t.Fatalf("claim the agent attempt = (%v, %v), want the one queued attempt", claims, err)
	}
	if err := ats.BeginAttempt(ctx, claims[0]); err != nil {
		t.Fatalf("BeginAttempt: %v", err)
	}
	conv, ok, err := sessions.ConversationFor(ctx, claims[0])
	if err != nil || !ok || conv.ConversationID == "" {
		t.Fatalf("ConversationFor = (%v, %v, %v), want the stamped pair", conv, ok, err)
	}
	convID, turnID := conv.ConversationID, conv.TurnID

	// The human's stretch: take control, drive one turn of their own.
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
	if st := m4TakeoverRow(t, f, `SELECT status FROM runs WHERE id = $1::uuid`, runID); st != runtime.RunPaused {
		t.Fatalf("run = %s during the takeover, want paused", st)
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

	// Return control — the conversation-side transaction, the 5b15443 wiring
	// (takeoverRuntime's M4Children over the caller's tx), lands FIRST.
	if err := f.pool.QueryRow(ctx, `SELECT version FROM conversation_control WHERE conversation_id = $1::uuid`, convID).Scan(&version); err != nil {
		t.Fatalf("read control version after the takeover: %v", err)
	}
	if _, err := cnv.ReturnControl(ctx, by, convID, version); err != nil {
		t.Fatalf("ReturnControl: %v — the resume's advance must land on this run's rows", err)
	}
	if st := m4TakeoverRow(t, f, `SELECT status FROM runs WHERE id = $1::uuid`, runID); st != runtime.RunRunning && st != runtime.RunQueued {
		t.Fatalf("run after return-control = %s, want running/queued (the pause is lifted)", st)
	}

	// The handback attempt fails (no budget: /implement's one attempt is
	// spent), the run fails, and the SAME store retries it.
	handback, err := rt.Claim(ctx, runID, workerID)
	if err != nil || handback == nil {
		t.Fatalf("claim the handback attempt: a=%v err=%v", handback, err)
	}
	if num := m4TakeoverRow(t, f,
		`SELECT attempt_number::text FROM attempts WHERE id = $1::uuid`, handback.ID); num != "2" {
		t.Fatalf("handback attempt number = %s, want 2 (the resume's explicit re-queue)", num)
	}
	if err := rt.Fail(ctx, runID, handback.ID, workerID, handback.FencingToken,
		"infra", "the resumed attempt found no checkout to work in", nil); err != nil {
		t.Fatalf("fail the handback attempt: %v", err)
	}
	if st := m4TakeoverRow(t, f, `SELECT status FROM runs WHERE id = $1::uuid`, runID); st != runtime.RunFailed {
		t.Fatalf("run after the failed handback = %s, want failed", st)
	}

	// Then the retry, through the API store on the same instance: it lands,
	// the run reopens, and the journal carries exactly one run.retried — the
	// return-control's resume journaled run.resumed, not run.retried.
	runAPI := APIRunStore{Runs: runStore, Runtime: rt}
	if _, err := runAPI.RetryRun(ctx, caller, runID, api.RunRetryInput{RequestedBy: f.userID}); err != nil {
		t.Fatalf("retry after the return-control: %v — the shared run rows must reopen", err)
	}
	if st := m4TakeoverRow(t, f, `SELECT status FROM runs WHERE id = $1::uuid`, runID); st != runtime.RunQueued && st != runtime.RunRunning {
		t.Fatalf("run after the retry = %s, want reopened", st)
	}
	if n := m4RunsWriteCount(t, f, runID, "run.retried"); n != 1 {
		t.Fatalf("run.retried = %d, want 1 (the resume journaled run.resumed; the retry journaled its own)", n)
	}
	if n := m4RunsWriteCount(t, f, runID, "run.resumed"); n != 1 {
		t.Fatalf("run.resumed = %d, want the return-control's one", n)
	}
}

// TestM4RetryPassSurvivesCancelledRequestContext is the lab failure itself:
// the retry request's context cancels while the settle pass is in flight
// (blocked on the run's advancer lock, the way the browser's navigation
// cancels it 25 ms into the POST). The pass must run to its own deadline
// and COMMIT the mutation — state, journal, commit — instead of rolling
// back on the cancelled request context and leaving the run unretried.
func TestM4RetryPassSurvivesCancelledRequestContext(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)
	token := migFixtureToken(t)
	pipeID, revID := m4InvokePublish(t, f, "m4retry-abort-"+token, m4RetryDoc(t))

	caller := api.Caller{UserID: f.userID, OrganizationID: f.orgID, IsOrgAdmin: true}
	runStore := &RunStore{Pool: f.pool}
	children := &M4Children{Runs: runStore}
	rt := NewRuntimeStore(f.pool, &runtime.Advancer{Deps: runtime.AdvancerDeps{Children: children}})
	children.Runtime = rt

	as, err := APIAssignmentStore{S: f.pipelines}.CreateAssignment(ctx, caller, f.projectID,
		api.AssignmentCreateInput{PipelineID: pipeID, PinnedRevisionID: revID, MaxConcurrentRuns: 1})
	if err != nil {
		t.Fatalf("CreateAssignment: %v", err)
	}
	key := "m4retry-abort-" + token
	view, created, err := APIRunStore{Runs: runStore, Runtime: rt}.CreateRun(ctx, caller,
		api.RunCreateInput{
			ProjectID:    f.projectID,
			AssignmentID: as.ID,
			Inputs:       map[string]json.RawMessage{"goal": json.RawMessage(`"make the fixture honest"`)},
			Key:          key,
			RequestSHA:   m4Hex("body/" + key),
			TriggeredBy:  f.userID,
		})
	if err != nil || !created || view.ID == "" {
		t.Fatalf("CreateRun = (%+v, %v, %v)", view, created, err)
	}
	runID := view.ID
	rt.Advance(ctx, runID)
	m4RetryDriveToFailed(t, ctx, f, rt, runStore, caller, runID, "m4abort")

	// Hold the run's advancer lock on a separate connection: every settle
	// pass for this run now blocks on it, so the retry below is provably
	// MID-PASS when its request context is cancelled.
	locker, err := f.pool.Begin(ctx)
	if err != nil {
		t.Fatalf("open the lock-holding transaction: %v", err)
	}
	defer func() { _ = locker.Rollback(context.Background()) }()
	if _, err := locker.Exec(ctx,
		`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, advancerLockPrefix+runID); err != nil {
		t.Fatalf("hold the advancer lock: %v", err)
	}

	// The retry, on a cancellable request context, racing the lock.
	reqCtx, cancelReq := context.WithCancel(context.Background())
	defer cancelReq()
	done := make(chan error, 1)
	go func() {
		_, err := APIRunStore{Runs: runStore, Runtime: rt}.RetryRun(reqCtx, caller, runID,
			api.RunRetryInput{RequestedBy: f.userID})
		done <- err
	}()

	// Wait until the retry's pass is the one WAITING on the lock — the
	// cancel below then lands in the pass, not before it. (PostgreSQL 18
	// dropped pg_stat_activity.waiting; a lock-waiting backend is the one
	// whose wait_event says advisory.)
	waited := time.Now()
	for time.Since(waited) < 30*time.Second {
		select {
		case err := <-done:
			t.Fatalf("the retry finished (%v) before it was blocked on the advancer lock: "+
				"the cancel would have landed where it does not belong", err)
		default:
		}
		var blocked bool
		if err := f.pool.QueryRow(ctx, `
			SELECT count(*) > 0 FROM pg_stat_activity
			WHERE state = 'active' AND wait_event_type = 'Lock'
			  AND query ILIKE '%pg_advisory_xact_lock%'
			  AND pid <> pg_backend_pid()`).Scan(&blocked); err == nil && blocked {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	// The browser's navigation: the request context dies mid-pass.
	cancelReq()
	// The wedged peer commits: the pass can now finish.
	if err := locker.Commit(ctx); err != nil {
		t.Fatalf("release the advancer lock: %v", err)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("retry whose request context cancelled mid-pass = %v: the authorized mutation "+
				"must still commit — rolling it back is the lab's 500 (run.retried never persisted)", err)
		}
	case <-time.After(30 * time.Second):
		t.Fatalf("the retry never finished after the lock released: the pass did not run to its bound")
	}

	// The mutation landed: the run reopens, the journal carries its one
	// run.retried, and /verify's second attempt is queued.
	if st := m4TakeoverRow(t, f, `SELECT status FROM runs WHERE id = $1::uuid`, runID); st != runtime.RunQueued && st != runtime.RunRunning {
		t.Fatalf("run = %s after the aborted retry, want reopened (the pass committed)", st)
	}
	if n := m4RunsWriteCount(t, f, runID, "run.retried"); n != 1 {
		t.Fatalf("run.retried = %d, want 1 — the row the cancelled request was authorized to apply", n)
	}
	var latestStatus string
	if err := f.pool.QueryRow(ctx, `
		SELECT a.status FROM attempts a
		WHERE a.node_execution_id IN (
			SELECT ne.id FROM node_executions ne
			WHERE ne.run_id = $1::uuid AND ne.node_instance_key = '/verify')
		ORDER BY a.attempt_number DESC LIMIT 1`, runID).Scan(&latestStatus); err != nil {
		t.Fatalf("read /verify's newest attempt: %v", err)
	}
	if latestStatus != runtime.AttemptQueued {
		t.Fatalf("/verify's retry attempt = %s, want queued", latestStatus)
	}
}

// TestM4RetryHonoursACancelledContextBeforeThePass is the honest half of the
// same rule: a request that cancels BEFORE its mutation starts is refused,
// and nothing — no state, no journal row — is applied for it.
func TestM4RetryHonoursACancelledContextBeforeThePass(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)
	token := migFixtureToken(t)
	pipeID, revID := m4InvokePublish(t, f, "m4retry-pre-"+token, m4RetryDoc(t))

	caller := api.Caller{UserID: f.userID, OrganizationID: f.orgID, IsOrgAdmin: true}
	runStore := &RunStore{Pool: f.pool}
	children := &M4Children{Runs: runStore}
	rt := NewRuntimeStore(f.pool, &runtime.Advancer{Deps: runtime.AdvancerDeps{Children: children}})
	children.Runtime = rt

	as, err := APIAssignmentStore{S: f.pipelines}.CreateAssignment(ctx, caller, f.projectID,
		api.AssignmentCreateInput{PipelineID: pipeID, PinnedRevisionID: revID, MaxConcurrentRuns: 1})
	if err != nil {
		t.Fatalf("CreateAssignment: %v", err)
	}
	key := "m4retry-pre-" + token
	view, created, err := APIRunStore{Runs: runStore, Runtime: rt}.CreateRun(ctx, caller,
		api.RunCreateInput{
			ProjectID:    f.projectID,
			AssignmentID: as.ID,
			Inputs:       map[string]json.RawMessage{"goal": json.RawMessage(`"make the fixture honest"`)},
			Key:          key,
			RequestSHA:   m4Hex("body/" + key),
			TriggeredBy:  f.userID,
		})
	if err != nil || !created || view.ID == "" {
		t.Fatalf("CreateRun = (%+v, %v, %v)", view, created, err)
	}
	runID := view.ID
	rt.Advance(ctx, runID)
	m4RetryDriveToFailed(t, ctx, f, rt, runStore, caller, runID, "m4pre")

	// The request is gone before the mutation starts: the honest refusal,
	// and no application at all.
	dead, cancel := context.WithCancel(context.Background())
	cancel()
	_, retryErr := APIRunStore{Runs: runStore, Runtime: rt}.RetryRun(dead, caller, runID,
		api.RunRetryInput{RequestedBy: f.userID})
	if retryErr == nil {
		t.Fatalf("retry on an already-cancelled context = success: the refusal must be honest")
	} else if !errors.Is(retryErr, context.Canceled) {
		t.Fatalf("retry on an already-cancelled context = %v, want context.Canceled", retryErr)
	}
	if st := m4TakeoverRow(t, f, `SELECT status FROM runs WHERE id = $1::uuid`, runID); st != runtime.RunFailed {
		t.Fatalf("run = %s after the refused retry, want failed (nothing applied)", st)
	}
	if n := m4RunsWriteCount(t, f, runID, "run.retried"); n != 0 {
		t.Fatalf("run.retried = %d, want 0 (a refused retry journals nothing)", n)
	}

	// The same refusal holds when the pass is reached DIRECTLY — with no
	// load read in front of it to fail first. This is the pre-check's real
	// job: without it, an already-cancelled caller's cancellation would be
	// stripped by the pass's WithoutCancel and the mutation would apply
	// anyway (the run reopens, a run.retried rows). The pre-check keeps an
	// absent request from spending its authorization.
	if err := rt.Retry(dead, runID, f.userID, nil, nil); err == nil {
		t.Fatalf("RuntimeStore.Retry on an already-cancelled context = success: the pre-check must refuse")
	} else if !errors.Is(err, context.Canceled) {
		t.Fatalf("RuntimeStore.Retry on an already-cancelled context = %v, want context.Canceled", err)
	}
	if st := m4TakeoverRow(t, f, `SELECT status FROM runs WHERE id = $1::uuid`, runID); st != runtime.RunFailed {
		t.Fatalf("run = %s after the directly-refused retry, want failed (the pre-check applied nothing)", st)
	}
	if n := m4RunsWriteCount(t, f, runID, "run.retried"); n != 0 {
		t.Fatalf("run.retried = %d, want 0 (the directly-refused retry journals nothing)", n)
	}
}
