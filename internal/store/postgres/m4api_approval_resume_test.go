package postgres

// TestM4RunLifecycleApprovalResumesRun is the live-lab regression
// (/tmp/pi-tasks/evidence/stuck-after-approval.out): after the /approve gate
// is decided the advancer enqueued the next node, but runs.status stayed
// 'waiting_human', so the worker claim predicate (r.status = 'running',
// attempts.go's runClaimPredicate) never claimed the queued attempt — every
// pipeline with a gate stalled right after the gate and the UI header kept
// showing WAITING HUMAN. Contract § 5.3: the scope waits, not the run. This
// drives the real publish -> create -> complete-plan -> decide-approve path
// on Postgres and asserts the run is running AND the next attempt is
// claimable through the worker's own AttemptStore.ClaimAttempts, with the
// run.resumed journal row in the decision's transaction.

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/dbirks/communication/internal/api"
	"github.com/dbirks/communication/internal/pipelines/runtime"
)

func TestM4RunLifecycleApprovalResumesRun(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)
	_, planJSON := m4LifecyclePlan(t)
	pipelineID, revisionID := m4LifecyclePublished(t, f, planJSON)

	caller := api.Caller{UserID: f.userID, OrganizationID: f.orgID, IsOrgAdmin: true}
	runStore := &RunStore{Pool: f.pool}
	children := &M4Children{Runs: runStore}
	m4Runtime := NewRuntimeStore(f.pool, &runtime.Advancer{
		Deps: runtime.AdvancerDeps{Children: children},
	})
	children.Runtime = m4Runtime
	as, err := APIAssignmentStore{S: f.pipelines}.CreateAssignment(ctx, caller, f.projectID,
		api.AssignmentCreateInput{PipelineID: pipelineID, PinnedRevisionID: revisionID,
			MaxConcurrentRuns: 1})
	if err != nil {
		t.Fatalf("CreateAssignment: %v", err)
	}
	view, created, err := APIRunStore{Runs: runStore, Runtime: m4Runtime}.CreateRun(ctx, caller,
		api.RunCreateInput{
			ProjectID:    f.projectID,
			AssignmentID: as.ID,
			Inputs: map[string]json.RawMessage{
				"goal":                json.RawMessage(`"resume me after the gate"`),
				"repository":          json.RawMessage(`"repo-a"`),
				"acceptance_criteria": json.RawMessage(`"tests pass"`),
				"fanout":              json.RawMessage(`false`),
				"fanout_count":        json.RawMessage(`0`),
			},
			Key:         "m4-life-resume-1",
			RequestSHA:  m4Hex("body/m4-life-resume-1"),
			TriggeredBy: f.userID,
		})
	if err != nil || !created {
		t.Fatalf("CreateRun = (%v, %v)", created, err)
	}
	if err := m4Runtime.Advance(ctx, view.ID); err != nil {
		t.Fatalf("advance: %v", err)
	}

	// --- drive /plan to success the way a worker does: claim, start,
	// complete with a checkpoint (the retry test's proven shape).
	workerID := m4Worker(t, ctx, f.pool, "resume", 4)
	a, err := m4Runtime.Claim(ctx, view.ID, workerID)
	if err != nil || a == nil {
		t.Fatalf("claim plan attempt: a=%v err=%v", a, err)
	}
	if err := m4Runtime.Start(ctx, view.ID, a.ID, workerID, a.FencingToken); err != nil {
		t.Fatalf("start: %v", err)
	}
	var workspaceID string
	if err := f.pool.QueryRow(ctx, `
		INSERT INTO workspaces (organization_id, project_id, scope_kind, run_id, worker_id,
		                        volume_id, root_path, state, ready_at)
		VALUES ($1, $2, 'run', $3, $4, 'sha256:' || repeat('1', 64), '/workspaces/runs/resume', 'ready', now())
		RETURNING id`, f.orgID, f.projectID, view.ID, workerID).Scan(&workspaceID); err != nil {
		t.Fatalf("seed run workspace: %v", err)
	}
	ckpt := runtime.CheckpointRecord{
		InputsDigest: "sha256:" + strings.Repeat("1", 64), OutputsDigest: "sha256:" + strings.Repeat("2", 64),
		VolumeID: "sha256:" + strings.Repeat("1", 64), WorkspaceID: workspaceID, WorkerID: workerID,
	}
	if err := m4Runtime.Complete(ctx, view.ID, a.ID, workerID, a.FencingToken,
		m4LifecyclePlanOutputs(), "sha256:"+strings.Repeat("3", 64),
		nil, "", ckpt); err != nil {
		t.Fatalf("complete plan attempt: %v", err)
	}

	// The gate opened: node waiting, run parked, ONE pending gate row.
	st := m4LifeNodeStatuses(t, f, view.ID)
	if st["/approve"] != runtime.NodeWaiting {
		t.Fatalf("/approve = %s, want waiting (gate open); nodes=%v", st["/approve"], st)
	}
	assertRunStatus(t, ctx, f, view.ID, runtime.RunWaitingHuman)

	var approvalID string
	var gateVersion int
	if err := f.pool.QueryRow(ctx, `
		SELECT ar.id::text, ar.version FROM approval_requests ar
		JOIN node_executions ne ON ne.id = ar.node_execution_id
		WHERE ne.run_id = $1::uuid AND ne.node_instance_key = '/approve' AND ar.state = 'pending'`,
		view.ID).Scan(&approvalID, &gateVersion); err != nil {
		t.Fatalf("read pending gate: %v", err)
	}

	// --- decide approve through the API store (the handler's own path).
	approvals := APIApprovalStore{R: m4Runtime}
	got, err := approvals.DecideApproval(ctx, caller, approvalID, "approved", "ship it",
		gateVersion, func(api.ApprovalView, string) (bool, string) { return true, "" })
	if err != nil {
		t.Fatalf("DecideApproval: %v", err)
	}
	if got.State != "decided" {
		t.Fatalf("gate state after decide = %q, want decided", got.State)
	}

	// --- the bug: the run must leave waiting_human in the decision's own
	// transaction (contract § 5.3 — the scope waits, not the run).
	assertRunStatus(t, ctx, f, view.ID, runtime.RunRunning)

	// run.resumed names the reason cleared and rides in the same journal.
	var resumed int
	if err := f.pool.QueryRow(ctx,
		`SELECT count(*) FROM domain_events WHERE run_id = $1::uuid AND type = 'run.resumed'
		   AND payload->>'paused_reason' = 'waiting_human'`, view.ID).Scan(&resumed); err != nil {
		t.Fatalf("count run.resumed: %v", err)
	}
	if resumed != 1 {
		t.Fatalf("run.resumed rows = %d, want 1 naming waiting_human (§ 3 row 4); events=%v",
			resumed, m4LifeEvents(t, f, view.ID))
	}

	// The dependant's attempt exists and is CLAIMABLE by the worker's own
	// claim path (attempts.go's runClaimPredicate requires runs.status —
	// this is the assertion that fails on the unfixed code).
	if _, err := f.pool.Exec(ctx, `
		UPDATE attempts SET scheduled_at = now() - interval '1 minute'
		WHERE run_id = $1::uuid AND status = 'queued'`, view.ID); err != nil {
		t.Fatalf("age queued attempts: %v", err)
	}
	claims, err := (&AttemptStore{Runs: runStore}).ClaimAttempts(ctx, workerID, 4)
	if err != nil {
		t.Fatalf("ClaimAttempts: %v", err)
	}
	var claimed []string
	for _, cl := range claims {
		claimed = append(claimed, cl.NodeID)
	}
	t.Logf("claims after the decision: %v", claimed)
	if len(claims) == 0 {
		t.Fatalf("no attempt claimable after approving the gate — the stuck-"+
			"waiting_human bug (events=%v)", m4LifeEvents(t, f, view.ID))
	}
}

// assertRunStatus reads runs.status back from the ledger (never the in-memory
// mirror) and requires the expected value.
func assertRunStatus(t *testing.T, ctx context.Context, f *m4Fixture, runID, want string) {
	t.Helper()
	var status string
	if err := f.pool.QueryRow(ctx,
		`SELECT status FROM runs WHERE id = $1::uuid`, runID).Scan(&status); err != nil {
		t.Fatalf("read run status: %v", err)
	}
	if status != want {
		t.Fatalf("runs.status = %q, want %q", status, want)
	}
}
