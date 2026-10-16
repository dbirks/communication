package postgres

// The boundary record's wire shape is load-bearing twice: it is the published
// CheckpointRepoState (api/openapi.yaml requires repository_id / base_commit /
// head_commit) and it is the only source the engine reads retry_context's
// head_commit from (ADR-0023 § 6, contract § 7.1 C5e). Lab live13 found the
// worker's completion writing Go field names, which hydrated as empty states
// and silently dropped head_commit from every continue_workspace retry.

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/dbirks/communication/internal/worker"
)

// TestCheckpointRepoStatesWireShapeAndHydration: a completed attempt's
// repo_states row decodes back into runtime.RepoState — for a boundary with a
// recorded head AND for one whose only commit identity is its base.
func TestCheckpointRepoStatesWireShapeAndHydration(t *testing.T) {
	ctx := testCtx(t)
	f, store := awSetup(t)
	runID := f.m4QueuedRun(t, ctx, "", 0)
	f.m4WorkerNode(t, ctx, runID, "/test")
	workerID := m4Worker(t, ctx, f.pool, "stateshape", 1)
	wsID := m4Workspace(t, ctx, f, runID)

	claims, err := store.ClaimAttempts(ctx, workerID, 1)
	if err != nil || len(claims) != 1 {
		t.Fatalf("claim = (%v, %v)", claims, err)
	}
	c := claims[0]
	if err := store.BeginAttempt(ctx, c); err != nil {
		t.Fatalf("BeginAttempt: %v", err)
	}
	digest := m4Digest("stateshape-outs")
	count, committed := worker.RepoStateCapture(3, false)
	ckpt := worker.AttemptCheckpoint{
		InputsDigest: m4Digest("stateshape-ins"), OutputsDigest: digest,
		RepoStates: []worker.CheckpointRepoState{
			{RepositoryID: "repo-1", BaseCommit: "3acceb6285f2"},
			{RepositoryID: "repo-2", BaseCommit: "a1", HeadCommit: "b2",
				ModifiedPathCount: count, Committed: committed},
		},
		WorkspaceID: wsID, VolumeID: "vol-stateshape",
	}
	if err := store.CompleteAttempt(ctx, c, map[string]any{"exit_code": 0}, digest, nil, "passed", ckpt); err != nil {
		t.Fatalf("CompleteAttempt: %v", err)
	}

	var raw []byte
	if err := f.pool.QueryRow(ctx,
		`SELECT repo_states FROM run_checkpoints WHERE run_id = $1::uuid`, runID).Scan(&raw); err != nil {
		t.Fatalf("read checkpoint: %v", err)
	}
	var docs []map[string]any
	if err := json.Unmarshal(raw, &docs); err != nil || len(docs) != 2 {
		t.Fatalf("repo_states = %s (err %v), want two states", raw, err)
	}
	for _, d := range docs {
		for _, key := range []string{"repository_id", "base_commit", "head_commit"} {
			if _, ok := d[key]; !ok {
				t.Errorf("repo_states element %v has no %q — CheckpointRepoState's published names are the wire contract", d, key)
			}
		}
	}
	if _, ok := docs[0]["committed"]; ok {
		t.Errorf("un-captured repo wrote a committed flag: %v (nil must marshal away, not as false)", docs[0])
	}
	if docs[1]["modified_path_count"] != float64(3) || docs[1]["committed"] != false {
		t.Errorf("captured repo = %v, want modified_path_count=3 committed=false", docs[1])
	}

	states, err := rteRepoStates(raw)
	if err != nil {
		t.Fatalf("rteRepoStates: %v", err)
	}
	if len(states) != 2 || states[0].BaseCommit != "3acceb6285f2" {
		t.Fatalf("hydrated states = %+v, want the boundary echoed", states)
	}
	if got := states[0].CommitIdentity(); got != "3acceb6285f2" {
		t.Errorf("CommitIdentity of the head-less boundary = %q, want the base commit (C5e's HEAD_BEFORE)", got)
	}
	if states[0].CaptureRecorded {
		t.Error("an un-captured repository must not hydrate as captured")
	}
	if !states[1].CaptureRecorded || states[1].ModifiedPathCount != 3 || states[1].Committed {
		t.Errorf("captured repo hydrated as %+v, want count 3 / not committed", states[1])
	}
}

// TestRunWorkspaceRepoStatesCommitIdentity: reading a run workspace's repos
// names the commit a retry resumes FROM (the recorded HEAD, or the base commit
// when no capture has read one), and refuses to describe a working tree nobody
// measured.
func TestRunWorkspaceRepoStatesCommitIdentity(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)
	store := &RunWorkspaces{Pool: f.pool}
	runID := m4RunsReadSeedRun(t, ctx, f)
	w := m4Worker(t, ctx, f.pool, "rws-id", 2)
	vol := runWorkspaceVolume(t, ctx, f.pool, w, "rws-id")
	repoID := runWorkspaceRepo(t, ctx, f.pool, f)
	// This test writes workspace_repos rows, so it owns their deletion before
	// the repository cleanup runs (cleanups are LIFO).
	t.Cleanup(func() {
		if _, err := f.pool.Exec(context.Background(),
			`DELETE FROM workspace_repos WHERE workspace_id IN (SELECT id FROM workspaces WHERE run_id = $1)`, runID); err != nil {
			t.Errorf("cleanup workspace_repos: %v", err)
		}
	})

	prepared, err := store.Prepare(ctx, runID, w, vol,
		[]worker.CheckpointRepoState{{RepositoryID: repoID, BaseCommit: "3acceb6285f2"}})
	if err != nil {
		t.Fatalf("Prepare: %v", err)
	}
	// Prepare records no paths — the worker's RecordRepos owns the rows
	// (contract § 4 step 3). This is the state C5e's boundary is read from:
	// a row whose head_commit the git capture never wrote.
	if err := (&WorkspaceStore{Pool: f.pool}).RecordRepos(ctx, prepared.WorkspaceID,
		[]worker.WorkspaceRepo{{
			WorkspaceID: prepared.WorkspaceID, OrganizationID: f.orgID, ProjectID: f.projectID,
			RepositoryID: repoID, CheckoutPath: "/work/run/" + runID + "/work/repos/app",
			MirrorPath: "/repos/" + f.projectID + "/app.git", MirrorVolumeID: m4Digest("mirror/repoid"),
			AdminDir: "/work/run/" + runID + "/meta/admin", RunRef: runID + "/app", BaseCommit: "3acceb6285f2",
		}}, true); err != nil {
		t.Fatalf("RecordRepos: %v", err)
	}
	ref, ok, err := store.RunWorkspace(ctx, runID)
	if err != nil || !ok || len(ref.RepoStates) != 1 {
		t.Fatalf("RunWorkspace = (%v, %v, %v)", ref, ok, err)
	}
	st := ref.RepoStates[0]
	if st.HeadCommit != "3acceb6285f2" {
		t.Errorf("HeadCommit = %q, want the base commit echoed as the boundary identity (C5e)", st.HeadCommit)
	}
	if st.ModifiedPathCount != nil || st.Committed != nil {
		t.Errorf("uncaptured repo = %+v, want no count and no committed flag (an empty manifest is a column default, not a measurement)", st)
	}

	// A capture always writes its ref read beside the manifest (RecordCommit,
	// ADR-0017 D8). A ref with an EMPTY manifest is a measured clean tree —
	// committed:true, count 0 — the one state ADR-0023 § 6 lets
	// restore_checkpoint reset to.
	if _, err := f.pool.Exec(ctx, `
		UPDATE workspace_repos SET head_commit = 'b2', modified_paths = '[]'::jsonb
		WHERE workspace_id = $1::uuid AND repository_id = $2::uuid`, ref.WorkspaceID, repoID); err != nil {
		t.Fatalf("record a clean capture: %v", err)
	}
	ref, _, err = store.RunWorkspace(ctx, runID)
	if err != nil {
		t.Fatalf("RunWorkspace after clean capture: %v", err)
	}
	st = ref.RepoStates[0]
	if st.HeadCommit != "b2" || st.ModifiedPathCount == nil || *st.ModifiedPathCount != 0 ||
		st.Committed == nil || !*st.Committed {
		t.Errorf("clean capture = %+v, want head b2 / measured 0 / committed true", st)
	}

	// The same ref with paths in its manifest is a measured dirty tree (C6d's
	// refusal footing).
	if _, err := f.pool.Exec(ctx, `
		UPDATE workspace_repos SET head_commit = 'b2', modified_paths = '["a.go","b.go"]'::jsonb
		WHERE workspace_id = $1::uuid AND repository_id = $2::uuid`, ref.WorkspaceID, repoID); err != nil {
		t.Fatalf("record a capture: %v", err)
	}
	ref, _, err = store.RunWorkspace(ctx, runID)
	if err != nil {
		t.Fatalf("RunWorkspace after capture: %v", err)
	}
	st = ref.RepoStates[0]
	if st.HeadCommit != "b2" {
		t.Errorf("HeadCommit = %q, want the recorded ref read", st.HeadCommit)
	}
	if st.ModifiedPathCount == nil || *st.ModifiedPathCount != 2 {
		t.Errorf("ModifiedPathCount = %v, want 2", st.ModifiedPathCount)
	}
	if st.Committed == nil || *st.Committed {
		t.Errorf("Committed = %v, want a recorded false for a dirty boundary (C6d)", st.Committed)
	}
}
