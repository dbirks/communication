package git

// Audit F6 (mirror half): the run-workspace / unit-service mirror path in this
// package clones and fetches repositories.git_url rows, so it carries the same
// file:// gate as the M2 conversation Workspace in internal/worker. These tests
// drive the real git binary against a local temp repo: refused when the flag is
// off, works when it is on, on both network-facing commands (the mirror clone
// and the mirror fetch).

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fileURLOrigin seeds a local bare repo and returns its file:// URL (the lab
// fixture shape: a repositories.git_url row pointing at a host-local path).
func fileURLOrigin(t *testing.T, root, name string) string {
	t.Helper()
	return newOrigin(t, root, name)
}

func fileURLPrepareRequest(conv, project, url string) PrepareRequest {
	return PrepareRequest{
		ScopeKind: "conversation",
		ScopeID:   conv,
		ProjectID: project,
		Repos:     []RepoSpec{{RepositoryID: conv, Name: "gate", GitURL: url, DefaultBranch: "main"}},
	}
}

func TestMirrorFileURLRefusedWhenNotAllowed(t *testing.T) {
	m, root := newTestManager(t)
	url := fileURLOrigin(t, root, "gate")
	m.AllowFileGitURLs = false // the worker default
	vols := measure(t, m)

	req := fileURLPrepareRequest(testConvA, testProjectA, url)
	req.WorkspaceVolumeID = vols[RootKindWorkspaces].ID
	req.MirrorVolumeID = vols[RootKindRepos].ID
	_, err := m.Prepare(context.Background(), req)
	if err == nil {
		t.Fatal("Prepare with a file:// GitURL succeeded; the worker must refuse it when the flag is off")
	}
	if !strings.Contains(err.Error(), "COMMUNICATION_ALLOW_FILE_GIT_URLS") {
		t.Errorf("refusal must name the switch that lifts it, got: %v", err)
	}
	if !strings.Contains(err.Error(), "file://") {
		t.Errorf("refusal must say the URL class is file://, got: %v", err)
	}
	// Nothing may be left behind: no mirror, no checkout.
	mirror := filepath.Join(root, "repos", testProjectA, "gate.git")
	if _, statErr := os.Stat(filepath.Join(mirror, "HEAD")); !os.IsNotExist(statErr) {
		t.Errorf("mirror %s was created despite the refusal (stat err: %v)", mirror, statErr)
	}
	checkout := filepath.Join(root, "workspaces", "conversation", testConvA, "work", "repos", "gate")
	if _, statErr := os.Stat(checkout); !os.IsNotExist(statErr) {
		t.Errorf("checkout %s was created despite the refusal (stat err: %v)", checkout, statErr)
	}
}

func TestMirrorFileURLWorksWhenAllowed(t *testing.T) {
	m, root := newTestManager(t)
	url := fileURLOrigin(t, root, "gate")
	m.AllowFileGitURLs = true // what the lab compose stacks set on the worker
	vols := measure(t, m)

	req := fileURLPrepareRequest(testConvA, testProjectA, url)
	req.WorkspaceVolumeID = vols[RootKindWorkspaces].ID
	req.MirrorVolumeID = vols[RootKindRepos].ID
	prep, err := m.Prepare(context.Background(), req)
	if err != nil {
		t.Fatalf("Prepare with the flag on must clone the file:// origin: %v", err)
	}
	mirror := filepath.Join(root, "repos", testProjectA, "gate.git")
	if _, err := os.Stat(filepath.Join(mirror, "HEAD")); err != nil {
		t.Errorf("mirror not created: %v", err)
	}
	if len(prep.Repos) != 1 || prep.Repos[0].HeadCommit == "" {
		t.Fatalf("want one prepared repo with a head commit, got %+v", prep.Repos)
	}
}

// A mirror created while the flag was on must not be silently *fetched* by a
// worker that has since turned it off — the fetch's `origin` is the same
// file:// remote the clone used. This mirrors internal/worker's rule that a
// previously-allowed shallow clone is re-refused, not re-used.
func TestMirrorFileURLFetchArmRefusedWhenNotAllowed(t *testing.T) {
	m, root := newTestManager(t)
	url := fileURLOrigin(t, root, "gate")
	vols := measure(t, m)

	req := fileURLPrepareRequest(testConvA, testProjectA, url)
	req.WorkspaceVolumeID = vols[RootKindWorkspaces].ID
	req.MirrorVolumeID = vols[RootKindRepos].ID
	if _, err := m.Prepare(context.Background(), req); err != nil {
		t.Fatalf("first prepare (flag on): %v", err)
	}
	mirror := filepath.Join(root, "repos", testProjectA, "gate.git")
	if _, err := os.Stat(filepath.Join(mirror, "HEAD")); err != nil {
		t.Fatalf("fixture: mirror missing after the first prepare: %v", err)
	}

	m.AllowFileGitURLs = false
	// A second scope under the same project: the mirror exists, so this is the
	// fetch arm, and it still refuses.
	fetchReq := fileURLPrepareRequest(testConvB, testProjectA, url)
	fetchReq.WorkspaceVolumeID = vols[RootKindWorkspaces].ID
	fetchReq.MirrorVolumeID = vols[RootKindRepos].ID
	_, err := m.Prepare(context.Background(), fetchReq)
	if err == nil || !strings.Contains(err.Error(), "COMMUNICATION_ALLOW_FILE_GIT_URLS") {
		t.Fatalf("second prepare (flag off) = %v, want a refusal naming COMMUNICATION_ALLOW_FILE_GIT_URLS", err)
	}
}

// The gate matches the M2 Workspace's exactly: the `file://` scheme prefix. A
// bare local path (git's own local-transport form) is a different shape the
// lab does not use in git_url rows, and refusing it here while M2 allows it
// would be a drift, not a tightening.
func TestMirrorBareLocalPathNotAffectedByFileGate(t *testing.T) {
	m, root := newTestManager(t)
	url := fileURLOrigin(t, root, "gate")
	m.AllowFileGitURLs = false
	vols := measure(t, m)

	req := fileURLPrepareRequest(testConvA, testProjectA, strings.TrimPrefix(url, "file://"))
	req.WorkspaceVolumeID = vols[RootKindWorkspaces].ID
	req.MirrorVolumeID = vols[RootKindRepos].ID
	if _, err := m.Prepare(context.Background(), req); err != nil {
		t.Fatalf("Prepare of a bare local path with the flag off: %v (the gate is the file:// scheme only)", err)
	}
}

// Clone mode (ADR-0010 D5) clones the checkout from the *mirror path*, not from
// the project URL: with the gate off there is no mirror to clone from, so the
// refusal still lands — and with it on, clone mode works over file://.
func TestMirrorFileURLCloneModeRespectsGate(t *testing.T) {
	m, root := newTestManager(t)
	url := fileURLOrigin(t, root, "gate")
	vols := measure(t, m)

	req := fileURLPrepareRequest(testConvA, testProjectA, url)
	req.WorkspaceVolumeID = vols[RootKindWorkspaces].ID
	req.MirrorVolumeID = vols[RootKindRepos].ID
	req.Mode = "clone"

	m.AllowFileGitURLs = false
	if _, err := m.Prepare(context.Background(), req); err == nil ||
		!strings.Contains(err.Error(), "COMMUNICATION_ALLOW_FILE_GIT_URLS") {
		t.Fatalf("clone-mode prepare (flag off) = %v, want a refusal naming COMMUNICATION_ALLOW_FILE_GIT_URLS", err)
	}

	m.AllowFileGitURLs = true
	prep, err := m.Prepare(context.Background(), req)
	if err != nil {
		t.Fatalf("clone-mode prepare (flag on): %v", err)
	}
	if len(prep.Repos) != 1 || prep.Repos[0].HeadCommit == "" {
		t.Fatalf("want one prepared clone-mode repo with a head commit, got %+v", prep.Repos)
	}
}
