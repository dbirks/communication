package git

// TestPreparePinnedBaseCommit: ADR-0053's worker half, against real git.
// A conversation scope ("the thread") commits on its per-scope ref; a run
// scope pinned to that commit must branch from it exactly (base_commit
// equals the thread commit, the worktree carries the thread's file), and a
// pinned commit the mirror does not contain is refused — never a guess,
// never a silent fall-back to the default branch.

import (
	"context"
	"os"
	"strings"
	"testing"
)

// readFile is the fixture's read-back: the worktree is the evidence.
func readFile(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(data)
}

func TestPreparePinnedBaseCommit(t *testing.T) {
	m, root := newTestManager(t)
	url := newOrigin(t, root, "backend")
	vols := measure(t, m)

	// The thread prepares and commits one edit on its per-scope ref.
	thread, err := m.Prepare(context.Background(), PrepareRequest{
		ScopeKind: "conversation", ScopeID: testConvA, ProjectID: testProjectA,
		WorkspaceVolumeID: vols[RootKindWorkspaces].ID, MirrorVolumeID: vols[RootKindRepos].ID,
		Repos: []RepoSpec{{RepositoryID: testConvC, Name: "backend", GitURL: url, DefaultBranch: "main"}},
	})
	if err != nil {
		t.Fatalf("thread Prepare: %v", err)
	}
	dir := thread.Repos[0].CheckoutPath
	writeFile(t, dir+"/ci.yml", "jobs: [ci]\n")
	run(t, dir, "add", "ci.yml")
	run(t, dir, "commit", "-qm", "thread's ci edit")
	threadHead := run(t, dir, "rev-parse", "HEAD")
	if threadHead == thread.Repos[0].BaseCommit {
		t.Fatalf("fixture: the thread commit did not move the head")
	}

	// The run scope pins the thread head: its worktree must start exactly
	// there, and base_commit must be the pinned identity.
	runScopeID := "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
	prep, err := m.Prepare(context.Background(), PrepareRequest{
		ScopeKind: "run", ScopeID: runScopeID, ProjectID: testProjectA,
		WorkspaceVolumeID: vols[RootKindWorkspaces].ID, MirrorVolumeID: vols[RootKindRepos].ID,
		Repos: []RepoSpec{{RepositoryID: testConvC, Name: "backend", GitURL: url, DefaultBranch: "main", BaseCommit: threadHead}},
	})
	if err != nil {
		t.Fatalf("run Prepare with pinned base: %v", err)
	}
	repo := prep.Repos[0]
	if repo.BaseCommit != threadHead {
		t.Errorf("run base_commit = %s, want the pinned thread head %s", repo.BaseCommit, threadHead)
	}
	if got := run(t, repo.CheckoutPath, "rev-parse", "HEAD"); got != threadHead {
		t.Errorf("run worktree HEAD = %s, want the pinned %s", got, threadHead)
	}
	data := readFile(t, repo.CheckoutPath+"/ci.yml")
	if !strings.Contains(data, "jobs: [ci]") {
		t.Errorf("thread's committed file is not in the run worktree: %q", data)
	}
	// The run branch is its own ref, off the thread's — the thread's branch
	// is untouched (the run never moves the thread's head).
	if got := run(t, repo.CheckoutPath, "rev-parse", "--abbrev-ref", "HEAD"); got != runScopeID+"/backend" {
		t.Errorf("run branch = %s, want %s", got, runScopeID+"/backend")
	}
	if got := run(t, thread.Repos[0].MirrorPath, "rev-parse", "--verify", "refs/heads/"+testConvA+"/backend"); got != threadHead {
		t.Errorf("thread ref moved: %s vs %s", got, threadHead)
	}

	// Re-prepare the same run scope (a retried attempt): the existing run ref
	// resumes from itself — the pin is not re-applied over committed work.
	again, err := m.Prepare(context.Background(), PrepareRequest{
		ScopeKind: "run", ScopeID: runScopeID, ProjectID: testProjectA,
		WorkspaceVolumeID: vols[RootKindWorkspaces].ID, MirrorVolumeID: vols[RootKindRepos].ID,
		Repos: []RepoSpec{{RepositoryID: testConvC, Name: "backend", GitURL: url, DefaultBranch: "main", BaseCommit: threadHead}},
	})
	if err != nil {
		t.Fatalf("run re-Prepare: %v", err)
	}
	if got := run(t, again.Repos[0].CheckoutPath, "rev-parse", "HEAD"); got != threadHead {
		t.Errorf("resumed run HEAD = %s, want %s", got, threadHead)
	}

	// A pinned commit the mirror does not contain is a named refusal —
	// prepare fails, no branch is created, and the error names the commit.
	missing := strings.Repeat("f", 40)
	_, err = m.Prepare(context.Background(), PrepareRequest{
		ScopeKind: "run", ScopeID: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", ProjectID: testProjectA,
		WorkspaceVolumeID: vols[RootKindWorkspaces].ID, MirrorVolumeID: vols[RootKindRepos].ID,
		Repos: []RepoSpec{{RepositoryID: testConvC, Name: "backend", GitURL: url, DefaultBranch: "main", BaseCommit: missing}},
	})
	if err == nil {
		t.Fatalf("Prepare with an unknown pinned base succeeded: the run would have started somewhere the pin does not point")
	}
	if !strings.Contains(err.Error(), "pinned base commit") || !strings.Contains(err.Error(), missing[:7]) {
		t.Errorf("refusal %q does not name the pinned commit %s", err, missing[:7])
	}
	if got := runOK(t, thread.Repos[0].MirrorPath, "rev-parse", "--verify", "--quiet",
		"refs/heads/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee/backend"); got != "" {
		t.Errorf("a branch was created for the refused pin: %q", got)
	}

	// An empty BaseCommit keeps today's default-branch startPoint (the
	// ordinary run is unchanged by the ADR).
	plain, err := m.Prepare(context.Background(), PrepareRequest{
		ScopeKind: "run", ScopeID: "ffffffff-ffff-4fff-8fff-ffffffffffff", ProjectID: testProjectA,
		WorkspaceVolumeID: vols[RootKindWorkspaces].ID, MirrorVolumeID: vols[RootKindRepos].ID,
		Repos: []RepoSpec{{RepositoryID: testConvC, Name: "backend", GitURL: url, DefaultBranch: "main"}},
	})
	if err != nil {
		t.Fatalf("plain Prepare: %v", err)
	}
	if got := run(t, plain.Repos[0].CheckoutPath, "rev-parse", "HEAD"); got == threadHead {
		t.Errorf("an unpinned run started on the thread head: the pin must come from the request, not from the mirror's stray refs")
	}
}
