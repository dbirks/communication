package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dbirks/communication/internal/api"
	wsgit "github.com/dbirks/communication/internal/workspace/git"
)

// Audit F6: both halves of the worker's file:// gate — the environment it
// parses at startup, and the dev mode that defaults it open.

func TestWorkerOptionsAllowFileGitURLs(t *testing.T) {
	env := func(kv map[string]string) func(string) string {
		base := map[string]string{
			"COMMUNICATION_DATABASE_URL":        "postgres://communication@postgres:5432/communication",
			"COMMUNICATION_SANDBOX_ENFORCEMENT": "disabled",
		}
		for k, v := range kv {
			base[k] = v
		}
		return func(k string) string { return base[k] }
	}
	t.Run("default false", func(t *testing.T) {
		o, err := workerOptionsFromEnv(env(nil))
		if err != nil {
			t.Fatalf("workerOptionsFromEnv: %v", err)
		}
		if o.allowFileGitURLs {
			t.Error("allowFileGitURLs = true, want the false default")
		}
	})
	t.Run("true", func(t *testing.T) {
		o, err := workerOptionsFromEnv(env(map[string]string{
			"COMMUNICATION_DATABASE_URL":        "postgres://communication@postgres:5432/communication",
			"COMMUNICATION_ALLOW_FILE_GIT_URLS": " true ",
		}))
		if err != nil {
			t.Fatalf("workerOptionsFromEnv: %v", err)
		}
		if !o.allowFileGitURLs {
			t.Error("allowFileGitURLs = false, want true")
		}
	})
	t.Run("unparseable refuses startup", func(t *testing.T) {
		_, err := workerOptionsFromEnv(env(map[string]string{
			"COMMUNICATION_ALLOW_FILE_GIT_URLS": "please",
		}))
		if err == nil || !strings.Contains(err.Error(), api.EnvAllowFileGitURLs) {
			t.Fatalf("err = %v, want it to name %s", err, api.EnvAllowFileGitURLs)
		}
	})
}

func TestDevDefaultAllowFileGitURLs(t *testing.T) {
	t.Run("unset becomes true and is cleaned up", func(t *testing.T) {
		if v, ok := os.LookupEnv(api.EnvAllowFileGitURLs); ok {
			t.Setenv(api.EnvAllowFileGitURLs, v) // arrange: the case needs it unset
			if err := os.Unsetenv(api.EnvAllowFileGitURLs); err != nil {
				t.Fatal(err)
			}
			defer func() {
				if got := os.Getenv(api.EnvAllowFileGitURLs); got != v {
					t.Errorf("left %q, want the saved %q", got, v)
				}
			}()
		}
		restore := devDefaultAllowFileGitURLs()
		if got := os.Getenv(api.EnvAllowFileGitURLs); got != "true" {
			t.Errorf("env during dev = %q, want true", got)
		}
		restore()
		if _, ok := os.LookupEnv(api.EnvAllowFileGitURLs); ok {
			t.Error("restore must unset what the default set")
		}
	})
	t.Run("explicit false survives", func(t *testing.T) {
		t.Setenv(api.EnvAllowFileGitURLs, "false")
		restore := devDefaultAllowFileGitURLs()
		defer restore()
		if got := os.Getenv(api.EnvAllowFileGitURLs); got != "false" {
			t.Errorf("env = %q, want the explicit false to win", got)
		}
	})
}

// The M4 run-workspace preparer and the M3 unit service share
// newWorkspaceManager; this proves the same COMMUNICATION_ALLOW_FILE_GIT_URLS
// the worker parses at startup reaches those mirrors — refused when off (the
// manager is built refusing), threading-on proven by the flag riding the
// manager when the env says true (the lab compose stacks set exactly that for
// the worker services, and it is the same process env these constructors
// read).
func TestNewWorkspaceManagerThreadsFileGate(t *testing.T) {
	env := func(kv map[string]string) func(string) string {
		base := map[string]string{
			"COMMUNICATION_DATABASE_URL":        "postgres://communication@postgres:5432/communication",
			"COMMUNICATION_SANDBOX_ENFORCEMENT": "disabled",
		}
		for k, v := range kv {
			base[k] = v
		}
		return func(k string) string { return base[k] }
	}
	t.Run("default off refuses a file:// prepare", func(t *testing.T) {
		o, err := workerOptionsFromEnv(env(nil))
		if err != nil {
			t.Fatalf("workerOptionsFromEnv: %v", err)
		}
		o.workspaceRoot, o.reposRoot = fileGateScratchRoots(t)
		mgr, err := newWorkspaceManager(o)
		if err != nil {
			t.Fatalf("newWorkspaceManager: %v", err)
		}
		if mgr.AllowFileGitURLs {
			t.Error("manager AllowFileGitURLs = true, want the false default")
		}
		// The refusal is behavioral here: ensureMirror refuses a file://
		// spec before ever invoking git, so no git binary is required.
		vols, err := mgr.Measure()
		if err != nil {
			t.Fatalf("Measure: %v", err)
		}
		_, err = mgr.Prepare(context.Background(), wsgit.PrepareRequest{
			ScopeKind: "conversation", ScopeID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			ProjectID:         "11111111-1111-4111-8111-111111111111",
			WorkspaceVolumeID: vols[wsgit.RootKindWorkspaces].ID,
			MirrorVolumeID:    vols[wsgit.RootKindRepos].ID,
			Repos: []wsgit.RepoSpec{{
				RepositoryID: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", Name: "app",
				GitURL: "file:///srv/fixtures/app.git", DefaultBranch: "main",
			}},
		})
		if err == nil || !strings.Contains(err.Error(), api.EnvAllowFileGitURLs) {
			t.Fatalf("file:// prepare with the flag off = %v, want a refusal naming %s", err, api.EnvAllowFileGitURLs)
		}
	})
	t.Run("on threads to the manager", func(t *testing.T) {
		o, err := workerOptionsFromEnv(env(map[string]string{
			api.EnvAllowFileGitURLs: "true",
		}))
		if err != nil {
			t.Fatalf("workerOptionsFromEnv: %v", err)
		}
		o.workspaceRoot, o.reposRoot = fileGateScratchRoots(t)
		mgr, err := newWorkspaceManager(o)
		if err != nil {
			t.Fatalf("newWorkspaceManager: %v", err)
		}
		if !mgr.AllowFileGitURLs {
			t.Error("manager AllowFileGitURLs = false, want true from the env")
		}
	})
}

// fileGateScratchRoots returns legal (non-temp) workspace/repos roots under
// the lab scratch convention, or skips when the location is refused.
func fileGateScratchRoots(t *testing.T) (string, string) {
	t.Helper()
	base := os.Getenv("COMMUNICATION_LAB_SCRATCH")
	if base == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			t.Skipf("no home directory for lab scratch: %v", err)
		}
		base = filepath.Join(home, ".cache", "communication-lab", "go-test")
	}
	dir, err := os.MkdirTemp(base, "FileGate-")
	if err != nil {
		if err := os.MkdirAll(base, 0o755); err != nil {
			t.Fatalf("create lab scratch %s: %v", base, err)
		}
		if dir, err = os.MkdirTemp(base, "FileGate-"); err != nil {
			t.Fatalf("create lab scratch dir: %v", err)
		}
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	ws := filepath.Join(dir, "workspaces")
	repos := filepath.Join(dir, "repos")
	if _, err := wsgit.NewManager(ws, repos, nil); err != nil {
		t.Skipf("lab scratch %s refused as a workspace root: %v", dir, err)
	}
	for _, d := range []string{ws, repos} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	return ws, repos
}
