package postgres

// TestRestoreBoundary*: the read that makes internal/worker.CheckpointRestorer
// runnable (ADR-0023 § 6). Every assertion is against rows a real Postgres
// wrote — the policy is read from the run's PINNED plan_snapshot, the boundary
// from run_checkpoints, the paths from workspace_repos — because the decorator
// it feeds performs a destructive reset and may only ever be handed facts.
//
// The legs: a restore node gets the last completed boundary's states + this
// run's checkouts + its exclusions; a continue node gets NOTHING but its mode
// (no boundary lookup at all); a node absent from the snapshot defaults to
// continue; a run with no boundary reports ok=false; and a boundary recorded
// in a workspace the run no longer lives in is refused rather than followed
// into somebody else's tree.

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/dbirks/communication/internal/worker"
)

// restorePlan pins three plan nodes: one continue, one restore, and one with
// no retry block at all (the arm a hand-seeded or older snapshot presents).
const restorePlan = `{"nodes":[
	{"id":"build","kind":"process.exec","scope":"/","executionLocation":"worker",
	 "retry":{"maxAttempts":1,"workspacePolicy":"continue_workspace"}},
	{"id":"task","kind":"agent.acp","scope":"/","executionLocation":"worker",
	 "retry":{"maxAttempts":3,"workspacePolicy":"restore_checkpoint"}},
	{"id":"ghost","kind":"process.exec","scope":"/","executionLocation":"worker"}
]}`

// restoreSeedRun creates the run and its node executions, and returns the run
// id plus the two node ids the tests ask about.
func restoreSeedRun(t *testing.T, ctx context.Context, f *m4Fixture) (runID, buildNode, taskNode, ghostNode string) {
	t.Helper()
	run, _, err := f.runs.CreateRun(ctx, NewRun{
		OrganizationID: f.orgID, ProjectID: f.projectID, PipelineID: f.pipelineID,
		PipelineRevisionID: f.revisionID, RevisionDigest: f.digest, PlanDigest: f.planDigest,
		PlanSnapshot: json.RawMessage(restorePlan), PoliciesSnapshot: json.RawMessage(`{}`),
		TriggeredBy: f.userID,
	})
	if err != nil {
		t.Fatalf("CreateRun: %v", err)
	}
	if _, err := f.runs.SetRunStatus(ctx, run.ID, RunStatusInput{Status: "running"}); err != nil {
		t.Fatalf("start run: %v", err)
	}
	for _, spec := range []struct {
		id, kind, key string
		node          *string
	}{
		{"build", "process.exec", "/build", &buildNode},
		{"task", "agent.acp", "/task", &taskNode},
		{"ghost", "process.exec", "/ghost", &ghostNode},
	} {
		n, err := f.runs.InsertNodeExecution(ctx, NewNodeExecution{
			RunID: run.ID, NodeID: spec.id, Kind: spec.kind, NodeInstanceKey: spec.key,
			ScopeKey: "/", ExecutionLocation: "worker", AttemptLimit: 3,
		})
		if err != nil {
			t.Fatalf("insert node %s: %v", spec.id, err)
		}
		*spec.node = n.ID
	}
	return run.ID, buildNode, taskNode, ghostNode
}

// restoreCheckpoint seeds one boundary row for a completed node. repoStates is
// the run_checkpoints.repo_states jsonb verbatim.
func restoreCheckpoint(t *testing.T, ctx context.Context, f *m4Fixture, runID, nodeID, wsID, workerID,
	repoStates string) {
	t.Helper()
	var attempt string
	if err := f.pool.QueryRow(ctx, `
		SELECT id::text FROM attempts WHERE node_execution_id = $1::uuid
		ORDER BY attempt_number LIMIT 1`, nodeID).Scan(&attempt); err != nil {
		// The boundary needs an attempt: seed one for the completed node.
		a, err := f.runs.QueueAttempt(ctx, NewAttempt{NodeExecutionID: nodeID, AttemptNumber: 1})
		if err != nil {
			t.Fatalf("seed boundary attempt: %v", err)
		}
		attempt = a.ID
	}
	if _, err := f.pool.Exec(ctx, `
		INSERT INTO run_checkpoints
			(run_id, node_execution_id, attempt_id, inputs_digest, outputs_digest,
			 repo_states, workspace_id, volume_id, worker_id, plan_digest)
		VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::jsonb, $7::uuid, $8, $9::uuid, $10)`,
		runID, nodeID, attempt, m4Digest("ins/"+nodeID), m4Digest("outs/"+nodeID),
		repoStates, wsID, m4Digest("volume"), workerID, f.planDigest); err != nil {
		t.Fatalf("seed checkpoint: %v", err)
	}
	// The row is the fixture's to remove: m4Worker's cleanup only reaches
	// checkpoints whose ATTEMPT names the worker, and this boundary rides an
	// unclaimed attempt, so it would otherwise pin the workspace and the worker
	// row past every cleanup.
	t.Cleanup(func() {
		if _, err := f.pool.Exec(context.Background(),
			`DELETE FROM run_checkpoints WHERE run_id = $1::uuid AND node_execution_id = $2::uuid`,
			runID, nodeID); err != nil {
			t.Errorf("cleanup checkpoint: %v", err)
		}
	})
}

// restoreRepo seeds workspace_repos rows for the run's live workspace.
func restoreRepo(t *testing.T, ctx context.Context, f *m4Fixture, runID, wsID, repoID, name, excluded string) {
	t.Helper()
	if excluded == "" {
		excluded = `[]`
	}
	if _, err := f.pool.Exec(ctx, `
		INSERT INTO workspace_repos
			(workspace_id, repository_id, checkout_path, mirror_path, mirror_volume_id,
			 admin_dir, run_ref, base_commit, head_commit, excluded_paths)
		VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
		wsID, repoID, "/workspaces/run/"+runID+"/work/repos/"+name,
		"/repos/fixture/"+name+".git", m4Digest("repos-volume/"+name),
		"/workspaces/run/"+runID+"/meta/repos/"+name+"/git", "run/"+runID+"/"+name,
		"aaa1111", "bbb2222", excluded); err != nil {
		t.Fatalf("seed workspace_repos: %v", err)
	}
	// The rows are deleted here because workspace_repos pins both the
	// repository and the workspace, and no fixture cleanup unwinds it for a
	// run-seeded workspace. Registered after m4Worker's, so LIFO runs it first.
	t.Cleanup(func() {
		if _, err := f.pool.Exec(context.Background(),
			`DELETE FROM workspace_repos WHERE workspace_id = $1::uuid`, wsID); err != nil {
			t.Errorf("cleanup workspace_repos: %v", err)
		}
	})
}

// committedStates is a boundary every repository of the run passed § 6's
// precondition on: captured, committed, hex identities.
func committedStates(repoID string) string {
	return `[{"repository_id":"` + repoID + `","base_commit":"aaa1111","head_commit":"ccc3333",` +
		`"modified_path_count":0,"committed":true}]`
}

func TestRestoreBoundaryRestoresFromTheLastBoundary(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)
	runID, buildNode, taskNode, ghostNode := restoreSeedRun(t, ctx, f)
	w := m4Worker(t, ctx, f.pool, "restore-a", 2)
	repoID := runWorkspaceRepo(t, ctx, f.pool, f)
	wsID := m4Workspace(t, ctx, f, runID)
	restoreRepo(t, ctx, f, runID, wsID, repoID, "backend", `[".env","node_modules"]`)
	restoreCheckpoint(t, ctx, f, runID, buildNode, wsID, w, committedStates(repoID))

	store := &RunWorkspaces{Pool: f.pool}
	b, ok, err := store.RestoreBoundary(ctx, runID, taskNode)
	if err != nil || !ok {
		t.Fatalf("RestoreBoundary = (ok %v, err %v), want the recorded boundary", ok, err)
	}
	if b.Mode != worker.WorkspacePolicyRestore {
		t.Errorf("mode = %q, want %q read from the pinned plan", b.Mode, worker.WorkspacePolicyRestore)
	}
	if len(b.RepoStates) != 1 {
		t.Fatalf("repo states = %+v, want the one boundary record", b.RepoStates)
	}
	st := b.RepoStates[0]
	if st.RepositoryID != repoID || st.HeadCommit != "ccc3333" || st.Committed == nil || !*st.Committed {
		t.Errorf("boundary state = %+v, want repository %s at ccc3333 provably committed", st, repoID)
	}
	if got := b.Checkouts[repoID]; got != "/workspaces/run/"+runID+"/work/repos/backend" {
		t.Errorf("checkout = %q, want the recorded workspace_repos path", got)
	}
	if strings.Join(b.Excluded, ",") != ".env,node_modules" {
		t.Errorf("exclusions = %v, want the workspace's declared set", b.Excluded)
	}

	// continue_workspace asks for nothing: no states, no paths. § 6 leaves the
	// tree exactly as the interrupted attempt left it, and the read that would
	// hand the restorer a boundary to reset to is not performed at all.
	cont, ok, err := store.RestoreBoundary(ctx, runID, buildNode)
	if err != nil || !ok {
		t.Fatalf("continue read = (ok %v, err %v), want ok", ok, err)
	}
	if cont.Mode != worker.WorkspacePolicyContinue || len(cont.RepoStates) != 0 || len(cont.Checkouts) != 0 {
		t.Errorf("continue boundary = %+v, want the mode and nothing else", cont)
	}

	// A node with no entry in the snapshot has no destructive policy: the
	// non-destructive default is the answer, never a guess at restore.
	ghost, _, err := store.RestoreBoundary(ctx, runID, ghostNode)
	if err != nil {
		t.Fatalf("ghost read: %v", err)
	}
	if ghost.Mode != worker.WorkspacePolicyContinue {
		t.Errorf("ghost mode = %q, want continue_workspace", ghost.Mode)
	}
}

func TestRestoreBoundaryWithoutAnyBoundary(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)
	runID, _, taskNode, _ := restoreSeedRun(t, ctx, f)
	m4Worker(t, ctx, f.pool, "restore-c", 2)
	wsID := m4Workspace(t, ctx, f, runID)
	repoID := runWorkspaceRepo(t, ctx, f.pool, f)
	restoreRepo(t, ctx, f, runID, wsID, repoID, "backend", "")

	b, ok, err := (&RunWorkspaces{Pool: f.pool}).RestoreBoundary(ctx, runID, taskNode)
	if err != nil {
		t.Fatalf("RestoreBoundary: %v", err)
	}
	if ok {
		t.Errorf("boundary = %+v, want ok=false for a run with no completed node", b)
	}
	if b.Mode != worker.WorkspacePolicyRestore {
		t.Errorf("mode = %q, want the node's own policy reported beside the missing boundary", b.Mode)
	}
}

// TestRestoreBoundaryRefusesForeignWorkspace is the validate-then-mutate rule
// read from the store's side: a boundary recorded against a workspace the run
// no longer lives in (its released history) is not licence to reset the live
// tree, and the refusal says so instead of reporting a boundary.
func TestRestoreBoundaryRefusesForeignWorkspace(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)
	runID, buildNode, taskNode, _ := restoreSeedRun(t, ctx, f)
	w := m4Worker(t, ctx, f.pool, "restore-b", 2)
	repoID := runWorkspaceRepo(t, ctx, f.pool, f)
	liveWS := m4Workspace(t, ctx, f, runID)
	restoreRepo(t, ctx, f, runID, liveWS, repoID, "backend", "")

	var deadWS string
	if err := f.pool.QueryRow(ctx, `
		INSERT INTO workspaces (organization_id, project_id, scope_kind, run_id, worker_id,
		                        volume_id, root_path, state, ready_at)
		VALUES ($1::uuid, $2::uuid, 'run', $3::uuid, $4::uuid, $5, '/workspaces/run/' || $3 || '/old/',
		        'released', now())
		RETURNING id::text`,
		f.orgID, f.projectID, runID, w, m4Digest("volume/old")).Scan(&deadWS); err != nil {
		t.Fatalf("seed the released workspace: %v", err)
	}
	restoreCheckpoint(t, ctx, f, runID, buildNode, deadWS, w, committedStates(repoID))

	_, ok, err := (&RunWorkspaces{Pool: f.pool}).RestoreBoundary(ctx, runID, taskNode)
	if err == nil {
		t.Fatalf("RestoreBoundary of a boundary in workspace %s succeeded (ok %v), want a refusal", deadWS, ok)
	}
	if !strings.Contains(err.Error(), "no worktree was reset") {
		t.Errorf("err = %v, want a refusal that says nothing was reset", err)
	}
}

// TestRestoreBoundaryIncompleteArgsAndUnknownNode keeps the resolver honest
// about the claim it was handed: a claim with no ids, or a node execution that
// is not in that run, is an error the worker reports as infra — never a silent
// "no boundary" that would let a restore launch unrepaired.
func TestRestoreBoundaryIncompleteArgsAndUnknownNode(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)
	store := &RunWorkspaces{Pool: f.pool}
	if _, _, err := store.RestoreBoundary(ctx, "", ""); err == nil {
		t.Error("empty ids succeeded, want an error")
	}
	runID, _, taskNode, _ := restoreSeedRun(t, ctx, f)
	unknown := taskNode[:len(taskNode)-1] + "0"
	if unknown == taskNode {
		unknown = taskNode[:len(taskNode)-1] + "1"
	}
	if _, _, err := store.RestoreBoundary(ctx, runID, unknown); err == nil {
		t.Error("a node execution outside the run succeeded, want an error")
	} else if !strings.Contains(err.Error(), "not a row of run") {
		t.Errorf("err = %v, want the node-naming refusal", err)
	}
	if _, _, err := (&RunWorkspaces{}).RestoreBoundary(ctx, runID, taskNode); err == nil {
		t.Error("a store with no pool succeeded, want an error")
	}
}
