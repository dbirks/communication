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
)

// TestMigrate0005RunShape proves 01 invariant 1's structural columns and the
// runs CHECK set: a parented root, an orphaned child, a failed run with no
// cause, a paused run with no reason, and a terminal row with no timestamp
// are all unrepresentable on a database that ran 00005.
func TestMigrate0005RunShape(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)

	// A legal root run: the parent for the disagreement cases.
	var parent string
	if err := f.pool.QueryRow(ctx, `
		INSERT INTO runs (organization_id, project_id, pipeline_id, pipeline_revision_id,
		                  revision_digest, plan_digest, plan_snapshot, policies_snapshot)
		VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, '{}'::jsonb, '{}'::jsonb)
		RETURNING id`, f.orgID, f.projectID, f.pipelineID, f.revisionID, f.digest, f.planDigest).
		Scan(&parent); err != nil {
		t.Fatalf("insert root run: %v", err)
	}

	// depth=0 WITH a parent, and depth>0 WITHOUT one: runs_root_is_unparented
	// is an equality, so both arms fail.
	if _, err := f.pool.Exec(ctx, `
		INSERT INTO runs (organization_id, project_id, pipeline_id, pipeline_revision_id,
		                  revision_digest, plan_digest, plan_snapshot, policies_snapshot,
		                  depth, parent_run_id)
		VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, '{}'::jsonb, '{}'::jsonb, 0, $7::uuid)`,
		f.orgID, f.projectID, f.pipelineID, f.revisionID, f.digest, f.planDigest, parent); err == nil {
		t.Error("depth=0 run with a parent_run_id accepted")
	} else if code := migPgCode(t, err); code != "23514" {
		t.Errorf("parented root code = %s, want 23514", code)
	}
	if _, err := f.pool.Exec(ctx, `
		INSERT INTO runs (organization_id, project_id, pipeline_id, pipeline_revision_id,
		                  revision_digest, plan_digest, plan_snapshot, policies_snapshot,
		                  depth, parent_run_id)
		VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, '{}'::jsonb, '{}'::jsonb, 1, NULL)`,
		f.orgID, f.projectID, f.pipelineID, f.revisionID, f.digest, f.planDigest); err == nil {
		t.Error("depth=1 run without a parent accepted")
	} else if code := migPgCode(t, err); code != "23514" {
		t.Errorf("orphaned child code = %s, want 23514", code)
	}
	// A third-level child is beyond the engine ceiling (ADR-0023 § 7's
	// maxChildDepth ≤ 2, made a DB CHECK).
	if _, err := f.pool.Exec(ctx, `
		INSERT INTO runs (organization_id, project_id, pipeline_id, pipeline_revision_id,
		                  revision_digest, plan_digest, plan_snapshot, policies_snapshot,
		                  depth, parent_run_id)
		VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, '{}'::jsonb, '{}'::jsonb, 3, $7::uuid)`,
		f.orgID, f.projectID, f.pipelineID, f.revisionID, f.digest, f.planDigest, parent); err == nil {
		t.Error("depth=3 run accepted")
	} else if code := migPgCode(t, err); code != "23514" {
		t.Errorf("depth=3 code = %s, want 23514", code)
	}

	// The status/timestamp/cause lies, each as its own INSERT:
	//   failed without failed_cause        → runs_terminal_cause
	//   paused_reason on a non-paused run  → runs_paused_reasoned (the DDL's
	//     direction: the reason may exist only while paused; a paused row
	//     without one is refused by SetRunStatus in Go, which the check below
	//     also proves — the contract's CHECK cannot express that arm)
	//   completed without finished_at      → runs_terminal_timestamped
	//   running WITH finished_at           → runs_terminal_timestamped (equality again)
	lies := []struct {
		name  string
		cols  string
		vals  string
		args  []any
		extra []any
	}{
		{"failed without cause", "status, failed_cause", "$7, NULL",
			[]any{"failed"}, nil},
		{"paused_reason on a running run", "status, paused_reason", "$7, 'manual'",
			[]any{"running"}, nil},
		{"completed without finished_at", "status, finished_at", "$7, NULL",
			[]any{"completed"}, nil},
		{"running with finished_at", "status, finished_at", "$7, now()",
			[]any{"running"}, nil},
	}
	for _, l := range lies {
		sql := `INSERT INTO runs (organization_id, project_id, pipeline_id, pipeline_revision_id,
			revision_digest, plan_digest, plan_snapshot, policies_snapshot, ` + l.cols + `)
			VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, '{}'::jsonb, '{}'::jsonb, ` +
			l.vals + `)`
		args := append([]any{f.orgID, f.projectID, f.pipelineID, f.revisionID, f.digest, f.planDigest}, l.args...)
		args = append(args, l.extra...)
		if _, err := f.pool.Exec(ctx, sql, args...); err == nil {
			t.Errorf("%s accepted", l.name)
		} else if code := migPgCode(t, err); code != "23514" {
			t.Errorf("%s code = %s, want 23514", l.name, code)
		}
	}

	// runs_affinity_is_a_pair needs a real worker; the half-pair is refused.
	w := m4Worker(t, ctx, f.pool, "affinity", 1)
	if _, err := f.pool.Exec(ctx, `
		INSERT INTO runs (organization_id, project_id, pipeline_id, pipeline_revision_id,
		                  revision_digest, plan_digest, plan_snapshot, policies_snapshot,
		                  worker_affinity, worker_volume_id)
		VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, '{}'::jsonb, '{}'::jsonb, $7::uuid, NULL)`,
		f.orgID, f.projectID, f.pipelineID, f.revisionID, f.digest, f.planDigest, w); err == nil {
		t.Error("worker_affinity without worker_volume_id accepted")
	} else if code := migPgCode(t, err); code != "23514" {
		t.Errorf("affinity-without-volume code = %s, want 23514", code)
	}

	// The store refuses the same shapes before Postgres sees them.
	if _, err := f.runs.SetRunStatus(ctx, parent, RunStatusInput{Status: "paused"}); err == nil ||
		!errors.Is(err, ErrRunNotTransitionable) {
		t.Errorf("SetRunStatus(paused) without a reason = %v, want ErrRunNotTransitionable", err)
	}
}

// TestMigrate0005AttemptLeaseLies is ADR-0016's turn lies retold on the
// attempts table, plus 01 invariant 4, the error_class enum, and the
// composite-FK disagreement (23503) that carries 09's triple uniqueness.
func TestMigrate0005AttemptLeaseLies(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)
	runID := f.m4QueuedRun(t, ctx, "", 0)
	nodeID, _ := f.m4WorkerNode(t, ctx, runID, "/implement")
	w := m4Worker(t, ctx, f.pool, "attempt-lie", 4)

	// Same node + attempt number twice: 23505.
	if _, err := f.pool.Exec(ctx, `
		INSERT INTO attempts (node_execution_id, run_id, attempt_number)
		VALUES ($1::uuid, $2::uuid, 1)`, nodeID, runID); err == nil {
		t.Error("attempt 1 for one node execution inserted twice")
	} else if code := migPgCode(t, err); code != "23505" {
		t.Errorf("duplicate attempt_number code = %s, want 23505", code)
	}
	// An attempt whose run_id disagrees with its node execution: the
	// composite FK refuses it (23503) — together with the two UNIQUEs this
	// IS 09's UNIQUE (run_id, node_instance_key, attempt_number).
	otherRun := f.m4QueuedRun(t, ctx, "", 0)
	if _, err := f.pool.Exec(ctx, `
		INSERT INTO attempts (node_execution_id, run_id, attempt_number)
		VALUES ($1::uuid, $2::uuid, 7)`, nodeID, otherRun); err == nil {
		t.Error("attempt with a disagreeing run_id accepted")
	} else if code := migPgCode(t, err); code != "23503" {
		t.Errorf("run disagreement code = %s, want 23503", code)
	}
	// queued with an owner: 23514.
	if _, err := f.pool.Exec(ctx, `
		INSERT INTO attempts (node_execution_id, run_id, attempt_number, worker_id)
		VALUES ($1::uuid, $2::uuid, 2, $3::uuid)`, nodeID, runID, w); err == nil {
		t.Error("queued attempt carrying a worker_id accepted")
	} else if code := migPgCode(t, err); code != "23514" {
		t.Errorf("queued-with-owner code = %s, want 23514", code)
	}
	// leased missing any member of the triple (deadline omitted): 23514.
	if _, err := f.pool.Exec(ctx, `
		INSERT INTO attempts (node_execution_id, run_id, attempt_number, status, worker_id, fencing_token)
		VALUES ($1::uuid, $2::uuid, 3, 'leased', $3::uuid, 5)`, nodeID, runID, w); err == nil {
		t.Error("leased attempt without lease_expires_at accepted")
	} else if code := migPgCode(t, err); code != "23514" {
		t.Errorf("leased-without-deadline code = %s, want 23514", code)
	}
	// succeeded without outputs, and failed without a class: 01 invariant 4.
	if _, err := f.pool.Exec(ctx, `
		INSERT INTO attempts (node_execution_id, run_id, attempt_number, status,
		                      worker_id, lease_expires_at, fencing_token, finished_at)
		VALUES ($1::uuid, $2::uuid, 4, 'succeeded', $3::uuid, now(), 9, now())`,
		nodeID, runID, w); err == nil {
		t.Error("succeeded attempt with NULL outputs accepted")
	} else if code := migPgCode(t, err); code != "23514" {
		t.Errorf("succeeded-without-outputs code = %s, want 23514", code)
	}
	if _, err := f.pool.Exec(ctx, `
		INSERT INTO attempts (node_execution_id, run_id, attempt_number, status,
		                      worker_id, lease_expires_at, fencing_token, finished_at)
		VALUES ($1::uuid, $2::uuid, 5, 'failed', $3::uuid, now(), 9, now())`,
		nodeID, runID, w); err == nil {
		t.Error("failed attempt without error_class accepted")
	} else if code := migPgCode(t, err); code != "23514" {
		t.Errorf("failed-without-class code = %s, want 23514", code)
	}
	// An error_class outside ADR-0023 § 7's enum: 23514.
	if _, err := f.pool.Exec(ctx, `
		INSERT INTO attempts (node_execution_id, run_id, attempt_number, status, error_class, finished_at)
		VALUES ($1::uuid, $2::uuid, 6, 'failed', 'cosmic_ray', now())`,
		nodeID, runID); err == nil {
		t.Error("error_class outside the enum accepted")
	} else if code := migPgCode(t, err); code != "23514" {
		t.Errorf("bad error_class code = %s, want 23514", code)
	}
	// attempts_agent_turn_pair: a turn without its conversation, and the
	// reverse.
	projID, userID, profileID := migM2Fixture(t, ctx, f.pool)
	convID := migM2BareConversation(t, ctx, f.pool, projID, userID, profileID, "attempt pair")
	var turnID string
	if err := f.pool.QueryRow(ctx, `
		INSERT INTO conversation_turns (conversation_id, prompt, submitted_by)
		VALUES ($1, 'pair turn', $2) RETURNING id`, convID, userID).Scan(&turnID); err != nil {
		t.Fatalf("insert turn: %v", err)
	}
	// Unlink both sides of the attempts<->turns cross-reference before the
	// M2 fixture's own cleanup (registered earlier, so it runs later) tries
	// to drop the turns. LIFO makes this the first thing torn down.
	t.Cleanup(func() {
		bg := context.Background()
		if _, err := f.pool.Exec(bg,
			`UPDATE conversation_turns SET node_attempt_id = NULL WHERE conversation_id = $1::uuid`,
			convID); err != nil {
			t.Errorf("unlink turn stamps: %v", err)
		}
		if _, err := f.pool.Exec(bg,
			`DELETE FROM attempts WHERE conversation_id = $1::uuid OR turn_id = $2::uuid`,
			convID, turnID); err != nil {
			t.Errorf("unlink attempts: %v", err)
		}
	})
	if _, err := f.pool.Exec(ctx, `
		INSERT INTO attempts (node_execution_id, run_id, attempt_number, turn_id)
		VALUES ($1::uuid, $2::uuid, 8, $3::uuid)`, nodeID, runID, turnID); err == nil {
		t.Error("attempt with a turn_id but no conversation_id accepted")
	} else if code := migPgCode(t, err); code != "23514" {
		t.Errorf("turn-without-conversation code = %s, want 23514", code)
	}
	if _, err := f.pool.Exec(ctx, `
		INSERT INTO attempts (node_execution_id, run_id, attempt_number, conversation_id)
		VALUES ($1::uuid, $2::uuid, 9, $3::uuid)`, nodeID, runID, convID); err == nil {
		t.Error("attempt with a conversation_id but no turn_id accepted")
	} else if code := migPgCode(t, err); code != "23514" {
		t.Errorf("conversation-without-turn code = %s, want 23514", code)
	}
	// The M2→M4 cross-link exists and accepts a stamp (01 invariant 3 across
	// both leases of an agent attempt).
	var linked string
	if err := f.pool.QueryRow(ctx, `
		INSERT INTO attempts (node_execution_id, run_id, attempt_number, conversation_id, turn_id)
		VALUES ($1::uuid, $2::uuid, 10, $3::uuid, $4::uuid) RETURNING id`,
		nodeID, runID, convID, turnID).Scan(&linked); err != nil {
		t.Fatalf("insert agent-turn attempt: %v", err)
	}
	if _, err := f.pool.Exec(ctx, `
		UPDATE conversation_turns SET node_attempt_id = $1::uuid WHERE id = $2::uuid`,
		linked, turnID); err != nil {
		t.Errorf("stamping conversation_turns.node_attempt_id failed: %v", err)
	}
}

// TestMigrate0005ClaimRace is `12` case 2's storage half on one real
// database: two workers, one queue, FOR UPDATE SKIP LOCKED handing each
// claim to exactly one owner with strictly monotonic tokens; capacity, run
// status and affinity in the predicate; the stale token rejecting (case 3)
// and capacity accounting closing on the terminal write. The capacity gate
// itself is exercised under a real race: two claims by the capacity-1
// worker start on a barrier (two pools) and together may win exactly one
// attempt — the workers-row FOR UPDATE, not the predicate read, is what
// guarantees that.
func TestMigrate0005ClaimRace(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)
	runA := f.m4QueuedRun(t, ctx, "", 0)
	runB := f.m4QueuedRun(t, ctx, "", 0)
	_, a1 := f.m4WorkerNode(t, ctx, runA, "/implement")
	_, b1 := f.m4WorkerNode(t, ctx, runB, "/implement")

	online1 := m4Worker(t, ctx, f.pool, "race-one", 2)
	online2 := m4Worker(t, ctx, f.pool, "race-two", 1)

	// online2 has capacity 1. The race it must survive is two claims by the
	// SAME worker in flight at once: the workers-row FOR UPDATE in
	// ClaimAttempts (attempts.go) serializes them, so the pair wins exactly
	// ONE attempt together. Without that lock both could read
	// active_attempts = 0 under READ COMMITTED and each lease one — the
	// intermittent CI flake "capacity-1 worker claimed 2 attempts". The old
	// version of this test only ever claimed sequentially, so it could never
	// have observed that race; the barrier below makes the two claims truly
	// concurrent. Two pools make the race un-optimizable (house pattern from
	// TestAttemptWorkerConcurrentClaimsOneLeaseEach).
	pool2, err := Open(ctx, mustMigrate(t))
	if err != nil {
		t.Fatalf("second pool: %v", err)
	}
	t.Cleanup(pool2.Close)
	store2 := &RunStore{Pool: pool2}

	var (
		wg     sync.WaitGroup
		mu     sync.Mutex
		claims []AttemptClaim
	)
	start := make(chan struct{})
	for _, run := range []func() ([]AttemptClaim, error){
		func() ([]AttemptClaim, error) { return f.runs.ClaimAttempts(ctx, online2, 5) },
		func() ([]AttemptClaim, error) { return store2.ClaimAttempts(ctx, online2, 5) },
	} {
		wg.Add(1)
		go func(run func() ([]AttemptClaim, error)) {
			defer wg.Done()
			<-start
			cs, err := run()
			if err != nil {
				t.Errorf("racing claim for worker 2: %v", err)
				return
			}
			mu.Lock()
			claims = append(claims, cs...)
			mu.Unlock()
		}(run)
	}
	close(start)
	wg.Wait()

	if len(claims) != 1 {
		t.Fatalf("capacity-1 worker claimed %d attempts across two raced claims, want 1 (workers.capacity is load-bearing)", len(claims))
	}
	first := claims[0]
	if first.FencingToken <= 0 {
		t.Fatalf("claim drew fencing_token %d, want > 0", first.FencingToken)
	}
	if first.AttemptID != a1 && first.AttemptID != b1 {
		t.Fatalf("claimed attempt %s is not one of the queued pair", first.AttemptID)
	}
	// A third, sequential claim while the first is live still refuses.
	if again, err := f.runs.ClaimAttempts(ctx, online2, 5); err != nil {
		t.Fatalf("third claim for worker 2: %v", err)
	} else if len(again) != 0 {
		t.Errorf("capacity-1 worker claimed %d more attempts while its first was live", len(again))
	}

	// The other worker takes the remaining one — never the leased row.
	claims1, err := f.runs.ClaimAttempts(ctx, online1, 5)
	if err != nil {
		t.Fatalf("claim for worker 1: %v", err)
	}
	if len(claims1) != 1 {
		t.Fatalf("worker 1 claimed %d attempts, want the one remaining", len(claims1))
	}
	taken := claims1[0]
	if taken.AttemptID == first.AttemptID {
		t.Fatal("both workers hold the SAME attempt: SKIP LOCKED is not a queue")
	}
	if taken.FencingToken <= first.FencingToken {
		t.Fatalf("tokens %d then %d: attempt_fencing_seq must be strictly monotonic per claim",
			first.FencingToken, taken.FencingToken)
	}

	// The claimed node moved to leased with its attempt counted.
	node, err := f.runs.GetNodeExecution(ctx, taken.NodeExecutionID)
	if err != nil {
		t.Fatalf("read claimed node: %v", err)
	}
	if node.Status != "leased" || node.AttemptCount != 1 {
		t.Errorf("claimed node = (%s, attempts %d), want (leased, 1)", node.Status, node.AttemptCount)
	}

	// Case 3: a stale writer lands nothing.
	stale := first
	stale.FencingToken = first.FencingToken + 1000
	if err := f.runs.FinishAttempt(ctx, stale, AttemptFinish{
		Status: "succeeded", Outputs: json.RawMessage(`{}`),
	}); !errors.Is(err, ErrLeaseLost) {
		t.Errorf("fenced finish on a stale token = %v, want ErrLeaseLost", err)
	}

	// The true owner closes it honestly, checkpoint and correlated event
	// included.
	wsID := m4Workspace(t, ctx, f, first.RunID)
	if err := f.runs.FinishAttempt(ctx, first, AttemptFinish{
		Status:        "succeeded",
		Outputs:       json.RawMessage(`{"exit_code":0}`),
		OutputsDigest: m4Digest("outs/" + first.AttemptID),
		NodeOutcome:   "passed",
		Checkpoint: &NewCheckpoint{
			InputsDigest: m4Digest("ins"), OutputsDigest: m4Digest("outs"),
			WorkspaceID: wsID, VolumeID: m4Digest("volume"), PlanDigest: f.planDigest,
		},
		Events: []RunEvent{{
			Type: "node.attempt.completed", ActorKind: "worker", ActorID: first.WorkerID,
			Payload: map[string]any{"attempt_number": first.AttemptNumber},
		}},
	}); err != nil {
		t.Fatalf("FinishAttempt: %v", err)
	}
	// Correlation columns on the journal row (contract § 1), not only payload.
	var nodeCorr, attemptCorr string
	if err := f.pool.QueryRow(ctx, `
		SELECT COALESCE(node_execution_id::text, ''), COALESCE(attempt_id::text, '')
		FROM domain_events WHERE run_id = $1::uuid AND type = 'node.attempt.completed'`,
		first.RunID).Scan(&nodeCorr, &attemptCorr); err != nil {
		t.Fatalf("read correlated event: %v", err)
	}
	if nodeCorr != first.NodeExecutionID || attemptCorr != first.AttemptID {
		t.Errorf("event correlation = (%s, %s), want (%s, %s)",
			nodeCorr, attemptCorr, first.NodeExecutionID, first.AttemptID)
	}
	// One checkpoint per successful node execution; a second is a PK clash.
	var cpCount int
	if err := f.pool.QueryRow(ctx,
		`SELECT count(*) FROM run_checkpoints WHERE node_execution_id = $1::uuid`,
		first.NodeExecutionID).Scan(&cpCount); err != nil {
		t.Fatalf("count checkpoints: %v", err)
	}
	if cpCount != 1 {
		t.Errorf("checkpoint rows for the node = %d, want 1", cpCount)
	}
	var active int
	if err := f.pool.QueryRow(ctx,
		`SELECT active_attempts FROM workers WHERE id = $1::uuid`, first.WorkerID).Scan(&active); err != nil {
		t.Fatalf("read worker accounting: %v", err)
	}
	if active != 0 {
		t.Errorf("worker active_attempts = %d after the terminal write, want 0", active)
	}

	// Affinity is the one-way door: the first setter binds, a re-bind is a
	// refusal, and the unbound worker cannot claim the bound run's work.
	boundRun, unboundWorker := runB, online2
	if first.RunID == runB {
		boundRun, unboundWorker = runA, online1
	}
	if ok, err := f.runs.SetRunAffinity(ctx, boundRun, online1, m4Digest("vol-bound")); err != nil || !ok {
		t.Fatalf("SetRunAffinity: ok=%v err=%v", ok, err)
	}
	if ok, err := f.runs.SetRunAffinity(ctx, boundRun, unboundWorker, m4Digest("vol-other")); err != nil || ok {
		t.Errorf("affinity re-bind succeeded; want the one-way door closed (ok=%v err=%v)", ok, err)
	}
	// The bound run's still-queued attempt (if any) stays out of reach of
	// the wrong worker.
	claims3, err := f.runs.ClaimAttempts(ctx, unboundWorker, 5)
	if err != nil {
		t.Fatalf("post-affinity claim: %v", err)
	}
	for _, c := range claims3 {
		if c.RunID == boundRun && c.WorkerID != online1 {
			t.Errorf("worker %s claimed a run bound by affinity to %s", c.WorkerID, online1)
		}
	}

	// Plan shape — the over-claim fix (claim-race2): the candidate
	// selection must be a one-shot 'CTE Scan on picked', not a derived
	// table a nested loop could re-execute per row of the UPDATE (with
	// SKIP LOCKED each re-execution can hand a different row to the same
	// LIMIT, so one claim leased more attempts than its LIMIT — the CI
	// flake a workers-row lock cannot explain). EXPLAIN does not execute,
	// so this has no effect on the claims above.
	plan := explainPlanLines(t, f.pool, runClaimSQL, online2, 300.0, 1)
	if !strings.Contains(plan, "CTE Scan on picked") {
		t.Errorf("claim plan lacks the one-shot 'CTE Scan on picked' node; candidate selection may re-execute:\n%s", plan)
	}
	t.Logf("claim plan (MATERIALIZED picked CTE):\n%s", plan)
}

// m4Workspace seeds a run-scope workspace row (run_checkpoints references
// workspaces, so a checkpoint write needs M3's table populated).
func m4Workspace(t *testing.T, ctx context.Context, f *m4Fixture, runID string) string {
	t.Helper()
	var worker string
	if err := f.pool.QueryRow(ctx, `
		SELECT id FROM workers WHERE capacity > 0 ORDER BY started_at LIMIT 1`).Scan(&worker); err != nil {
		t.Fatalf("find a worker for the workspace: %v", err)
	}
	var id string
	if err := f.pool.QueryRow(ctx, `
		INSERT INTO workspaces (organization_id, project_id, scope_kind, run_id, worker_id,
		                        volume_id, root_path, state, ready_at)
		VALUES ($1::uuid, $2::uuid, 'run', $3::uuid, $4::uuid, $5, '/workspaces/run/' || $3 || '/',
		        'ready', now())
		RETURNING id`,
		f.orgID, f.projectID, runID, worker, m4Digest("volume")).Scan(&id); err != nil {
		t.Fatalf("insert workspace: %v", err)
	}
	return id
}

// TestMigrate0005ApprovalsAndInvocations proves the gate and child-run
// constraint rows from the contract table: one live gate per node execution,
// the decided-consistency shape, the approval CAS, shared children, one
// child per node execution, self-invocation, and the capacity bounds.
func TestMigrate0005ApprovalsAndInvocations(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)
	runID := f.m4QueuedRun(t, ctx, "", 0)
	nodeID, _ := f.m4WorkerNode(t, ctx, runID, "/approve")

	deadline := time.Now().Add(time.Hour)
	approval, err := f.runs.InsertApproval(ctx, NewApproval{
		OrganizationID: f.orgID, ProjectID: f.projectID, RunID: runID,
		NodeExecutionID: nodeID, Summary: "ship it?",
		ApproverRoles: []string{"maintainer"}, DeadlineAt: deadline,
	})
	if err != nil {
		t.Fatalf("InsertApproval: %v", err)
	}
	// One live gate per node execution.
	if _, err := f.runs.InsertApproval(ctx, NewApproval{
		OrganizationID: f.orgID, ProjectID: f.projectID, RunID: runID,
		NodeExecutionID: nodeID, Summary: "again?", DeadlineAt: deadline,
	}); !errors.Is(err, ErrConflict) {
		t.Errorf("second gate on one node execution = %v, want ErrConflict", err)
	}
	// The CHECK arms, at the DB: 'decided' with no decision, 'expired' with
	// a decided_at, 'denied' with a decision.
	for _, lie := range []struct {
		name string
		set  string
	}{
		{"decided without decision", "state = 'decided', decision = NULL, decided_by = NULL, decided_at = now()"},
		{"expired with decided_at", "state = 'expired', decision = NULL, decided_by = NULL, decided_at = now()"},
		{"denied with decision", "state = 'denied', decision = 'rejected', decided_by = NULL, decided_at = now()"},
	} {
		if _, err := f.pool.Exec(ctx, `UPDATE approval_requests SET `+lie.set+` WHERE id = $1::uuid`,
			approval.ID); err == nil {
			t.Errorf("%s accepted", lie.name)
		} else if code := migPgCode(t, err); code != "23514" {
			t.Errorf("%s code = %s, want 23514", lie.name, code)
		}
	}
	// The CAS decide: winner wins, loser gets ErrConflict and the winner's row.
	decided, err := f.runs.DecideApproval(ctx, approval.ID, "approved", "lgtm", 1, f.userID, nil)
	if err != nil {
		t.Fatalf("DecideApproval: %v", err)
	}
	if decided.State != "decided" || decided.Decision != "approved" || decided.Version != 2 {
		t.Errorf("decided gate = (%s, %s, v%d), want (decided, approved, v2)",
			decided.State, decided.Decision, decided.Version)
	}
	if loser, err := f.runs.DecideApproval(ctx, approval.ID, "rejected", "", 1, f.userID, nil); !errors.Is(err, ErrConflict) {
		t.Errorf("losing CAS decide = %v, want ErrConflict carrying the winner", err)
	} else if loser.Decision != "approved" {
		t.Errorf("loser got decision %q, want the winner's %q", loser.Decision, "approved")
	}

	// Invocations: a child run, keyed by node execution, never shared, never
	// self.
	childID := f.m4QueuedRun(t, ctx, runID, 1)
	if _, err := f.runs.InsertInvocation(ctx, NewInvocation{
		RunID: runID, NodeExecutionID: nodeID, ChildRunID: childID,
		ChildProjectID: f.projectID, PipelineID: f.pipelineID,
		ResolvedRevisionID: f.revisionID, Depth: 1,
	}); err != nil {
		t.Fatalf("InsertInvocation: %v", err)
	}
	// A second node execution reaching the same child: UNIQUE (child_run_id).
	secondNode := func() string {
		n, err := f.runs.InsertNodeExecution(ctx, NewNodeExecution{
			RunID: runID, NodeID: "invoke_other", Kind: "pipeline.invoke",
			NodeInstanceKey: "/invoke_other", ExecutionLocation: "control_plane",
		})
		if err != nil {
			t.Fatalf("insert second invoke node: %v", err)
		}
		return n.ID
	}()
	if _, err := f.pool.Exec(ctx, `
		INSERT INTO pipeline_invocations
			(run_id, node_execution_id, child_run_id, child_project_id, pipeline_id,
			 resolved_revision_id, depth)
		VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, 1)`,
		runID, secondNode, childID, f.projectID, f.pipelineID, f.revisionID); err == nil {
		t.Error("two invocations sharing one child accepted")
	} else if code := migPgCode(t, err); code != "23505" {
		t.Errorf("shared child code = %s, want 23505", code)
	}
	// One node execution cannot spawn two children.
	secondChild := f.m4QueuedRun(t, ctx, runID, 1)
	if _, err := f.runs.InsertInvocation(ctx, NewInvocation{
		RunID: runID, NodeExecutionID: nodeID, ChildRunID: secondChild,
		ChildProjectID: f.projectID, PipelineID: f.pipelineID,
		ResolvedRevisionID: f.revisionID, Depth: 1,
	}); !errors.Is(err, ErrConflict) {
		t.Errorf("second invocation from one node execution = %v, want ErrConflict", err)
	}
	// Self-invocation is refused (in Go, naming the CHECK it mirrors).
	if _, err := f.runs.InsertInvocation(ctx, NewInvocation{
		RunID: runID, NodeExecutionID: secondNode, ChildRunID: runID,
		ChildProjectID: f.projectID, PipelineID: f.pipelineID,
		ResolvedRevisionID: f.revisionID, Depth: 1,
	}); err == nil || !strings.Contains(err.Error(), "child_is_not_self") {
		t.Errorf("self-invocation = %v, want the named refusal", err)
	}
	// Depth 3 is refused by the invocation CHECK as loudly as by runs'.
	if _, err := f.pool.Exec(ctx, `
		INSERT INTO pipeline_invocations
			(run_id, node_execution_id, child_run_id, child_project_id, pipeline_id,
			 resolved_revision_id, depth)
		VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, 3)`,
		runID, secondNode, secondChild, f.projectID, f.pipelineID, f.revisionID); err == nil {
		t.Error("depth-3 invocation accepted")
	} else if code := migPgCode(t, err); code != "23514" {
		t.Errorf("depth-3 invocation code = %s, want 23514", code)
	}

	// workers.capacity bounds: 0 and 17 are both CHECK violations.
	for _, cap := range []int{0, 17} {
		if _, err := f.pool.Exec(ctx, `
			INSERT INTO workers (name, hostname, version, status, capacity)
			VALUES ('m4-cap-' || $2 || '-' || $3, 'lab', 'ct', 'online', $1)`,
			cap, migFixtureToken(t), fmt.Sprint(cap)); err == nil {
			t.Errorf("capacity %d accepted", cap)
		} else if code := migPgCode(t, err); code != "23514" {
			t.Errorf("capacity %d code = %s, want 23514", cap, code)
		}
	}
	// Assignment uniqueness: one pipeline per project.
	if _, err := f.pipelines.CreateAssignment(ctx, NewAssignment{
		ProjectID: f.projectID, PipelineID: f.pipelineID,
		PinnedRevisionID: f.revisionID, CreatedBy: f.userID,
	}); err != nil {
		t.Fatalf("CreateAssignment: %v", err)
	}
	if _, err := f.pipelines.CreateAssignment(ctx, NewAssignment{
		ProjectID: f.projectID, PipelineID: f.pipelineID,
		PinnedRevisionID: f.revisionID, CreatedBy: f.userID,
	}); !errors.Is(err, ErrConflict) {
		t.Errorf("second assignment of one pipeline = %v, want ErrConflict", err)
	}
}

// TestMigrate0005RunIdempotency is `12` case 1's storage rule through the
// adapter: same key + same request hash replays the stored run, a different
// body is ErrIdempotencyMismatch and never touches the stored run, and the
// key shape is a CHECK.
func TestMigrate0005RunIdempotency(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)

	template := NewRun{
		OrganizationID: f.orgID, ProjectID: f.projectID, PipelineID: f.pipelineID,
		PipelineRevisionID: f.revisionID, RevisionDigest: f.digest, PlanDigest: f.planDigest,
		PlanSnapshot:     json.RawMessage(`{"nodes":[]}`),
		PoliciesSnapshot: json.RawMessage(`{}`),
		TriggeredBy:      f.userID,
		Key:              "idem-" + migFixtureToken(t),
		RequestSHA:       m4Hex("body-a"),
		Inputs:           map[string]RunInput{"goal": {Value: json.RawMessage(`"ship it"`)}},
	}
	run, created, err := f.runs.CreateRun(ctx, template)
	if err != nil || !created {
		t.Fatalf("first CreateRun: created=%v err=%v", created, err)
	}
	replay, created, err := f.runs.CreateRun(ctx, template)
	if err != nil {
		t.Fatalf("replay CreateRun: %v", err)
	}
	if created || replay.ID != run.ID {
		t.Errorf("replay returned run %s (created=%v), want the stored run %s untouched",
			replay.ID, created, run.ID)
	}
	mismatch := template
	mismatch.RequestSHA = m4Hex("body-b")
	if _, _, err := f.runs.CreateRun(ctx, mismatch); !errors.Is(err, ErrIdempotencyMismatch) {
		t.Errorf("same key, different body = %v, want ErrIdempotencyMismatch", err)
	}
	// Input rows landed for the winner and only once.
	var inputs int
	if err := f.pool.QueryRow(ctx,
		`SELECT count(*) FROM run_inputs WHERE run_id = $1::uuid`, run.ID).Scan(&inputs); err != nil {
		t.Fatalf("count inputs: %v", err)
	}
	if inputs != 1 {
		t.Errorf("run_inputs rows = %d, want exactly 1 for the stored run", inputs)
	}
	// The key shape is a CHECK too: spaces are not idempotency keys.
	if _, err := f.pool.Exec(ctx, `
		INSERT INTO run_idempotency_keys (project_id, key, run_id, request_sha256)
		VALUES ($1::uuid, 'bad key', $2::uuid, $3)`, f.projectID, run.ID, m4Hex("x")); err == nil {
		t.Error("idempotency key outside the shape CHECK accepted")
	} else if code := migPgCode(t, err); code != "23514" {
		t.Errorf("bad key shape code = %s, want 23514", code)
	}
}
