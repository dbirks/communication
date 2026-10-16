package postgres

// The store half of the process.exec node-boundary capture (ADR-0023 § 6:
// the checkpoint row carries "the same capture ADR-0017 D8 already produces
// for a turn, now attached to a node boundary"). The worker reads the ref
// after the command exits and records it here through RunWorkspaces — the
// same workspace_repos write, and therefore the same
// run_checkpoints.repo_states derivation (runWorkspaceRepoStates), as the
// agent turn's boundary. Without this write every command boundary hydrates
// `committed: null` and restore_checkpoint refuses forever (lab live18).
// Integration layer: every assertion reads rows a real Postgres wrote.

import (
	"context"
	"testing"

	"github.com/dbirks/communication/internal/worker"
)

func TestRunWorkspaceBoundaryCapture(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)
	store := &RunWorkspaces{Pool: f.pool}
	workspaces := &WorkspaceStore{Pool: f.pool}

	runID := f.m4QueuedRun(t, ctx, "", 0)
	m4Worker(t, ctx, f.pool, "bcap", 1) // m4Workspace needs a capacity-bearing worker row
	wsID := m4Workspace(t, ctx, f, runID)
	repoID := runWorkspaceRepo(t, ctx, f.pool, f)
	// Registered last, it runs first (LIFO): workspace_repos has an FK to
	// workspaces without a cascade, and the fixture's project cleanup cannot
	// outrun it.
	t.Cleanup(func() {
		_, _ = f.pool.Exec(context.Background(),
			`DELETE FROM workspace_repos WHERE workspace_id = $1`, wsID)
	})

	// Prepare's shape at the boundary the worker sees: rows exist, head is
	// NULL, so the ref is un-captured — restore_checkpoint must refuse it.
	if err := workspaces.RecordRepos(ctx, wsID, []worker.WorkspaceRepo{{
		WorkspaceID: wsID, OrganizationID: f.orgID, ProjectID: f.projectID,
		RepositoryID: repoID, CheckoutPath: "/workspaces/run/" + runID + "/work/repos/backend",
		MirrorPath: "/repos/" + f.projectID + "/backend.git", MirrorVolumeID: m4Digest("mirror/bcap"),
		AdminDir: "/workspaces/run/" + runID + "/meta/admin", RunRef: runID + "/backend",
		BaseCommit: "aaaa1111",
	}}, false); err != nil {
		t.Fatalf("RecordRepos: %v", err)
	}
	ref, ok, err := store.RunWorkspace(ctx, runID)
	if !ok || err != nil || len(ref.Repos) != 1 {
		t.Fatalf("RunWorkspace = (%+v, %v, %v), want the boundary repo", ref.Repos, ok, err)
	}
	b := ref.Repos[0]
	if b.RowID == "" || b.CheckoutPath == "" || b.RunRef == "" || b.BaseCommit != "aaaa1111" ||
		b.RecordedHead != "" {
		t.Fatalf("boundary repo = %+v, want the capture identity with an un-captured head", b)
	}
	if len(ref.RepoStates) != 1 || ref.RepoStates[0].Committed != nil {
		t.Fatalf("repo_states = %+v, want un-captured before any capture", ref.RepoStates)
	}

	// The worker read HEAD back after the command exited: record it. This is
	// the write the agent path already performs at a turn boundary.
	if err := store.RecordBoundaryCommit(ctx, worker.CommitRecord{
		RowID: b.RowID, WorkspaceID: wsID, OrganizationID: f.orgID, ProjectID: f.projectID,
		RepositoryID: repoID, RunRef: b.RunRef, HeadCommit: "bbbb2222",
	}); err != nil {
		t.Fatalf("RecordBoundaryCommit: %v", err)
	}
	ref, _, err = store.RunWorkspace(ctx, runID)
	if err != nil {
		t.Fatalf("RunWorkspace after capture: %v", err)
	}
	st := ref.RepoStates[0]
	if st.HeadCommit != "bbbb2222" {
		t.Fatalf("head_commit = %q, want the captured ref", st.HeadCommit)
	}
	if st.Committed == nil || !*st.Committed {
		t.Fatalf("committed = %v, want a captured true (restore_checkpoint's licence, § 6)", st.Committed)
	}
	if st.ModifiedPathCount == nil || *st.ModifiedPathCount != 0 {
		t.Fatalf("modified_path_count = %v, want a captured 0", st.ModifiedPathCount)
	}
	// workspace.committed travels with the write — the same event the turn
	// capture journals, so a command node's commit is as observable as an
	// agent's.
	var events int
	if err := f.pool.QueryRow(ctx, `
		SELECT count(*) FROM domain_events WHERE type = 'workspace.committed'
		AND payload->>'workspace_id' = $1`, wsID).Scan(&events); err != nil || events != 1 {
		t.Fatalf("workspace.committed = %d (err %v), want one", events, err)
	}

	// A later capture of a dirty tree: same ref, manifest with paths — the
	// boundary says uncommitted, which is exactly what keeps restore from
	// destroying work (§ 6, C6d).
	if err := store.RecordBoundaryCommit(ctx, worker.CommitRecord{
		RowID: b.RowID, WorkspaceID: wsID, OrganizationID: f.orgID, ProjectID: f.projectID,
		RepositoryID: repoID, RunRef: b.RunRef, HeadCommit: "bbbb2222",
		ModifiedPaths: []string{"a.txt", "b.txt"},
	}); err != nil {
		t.Fatalf("RecordBoundaryCommit (dirty): %v", err)
	}
	ref, _, _ = store.RunWorkspace(ctx, runID)
	st = ref.RepoStates[0]
	if st.Committed == nil || *st.Committed {
		t.Fatalf("committed = %v, want a captured false for a dirty manifest", st.Committed)
	}
	if st.ModifiedPathCount == nil || *st.ModifiedPathCount != 2 {
		t.Fatalf("modified_path_count = %v, want 2", st.ModifiedPathCount)
	}

	// A row that is gone is reported, not invented.
	if err := store.RecordBoundaryCommit(ctx, worker.CommitRecord{
		RowID: "00000000-0000-4000-8000-000000000000", WorkspaceID: wsID,
		OrganizationID: f.orgID, ProjectID: f.projectID, RepositoryID: repoID,
		HeadCommit: "cccc3333",
	}); err == nil {
		t.Fatal("RecordBoundaryCommit on a missing row succeeded, want not-found")
	}
}
