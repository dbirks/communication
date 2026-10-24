package git

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// ADR-0061 Decision 4, verified at the Runner.Spawn seam: the mirror's
// clone/fetch and nothing else may carry the credential, and only through
// the environment. No git binary and no network are involved; the real-git
// proof that the env does not break git lives in
// TestRealGitMirrorWithCredentialEnvAtPrepare.

const (
	credToken      = "tok_01cred_abcdefgh-secret-42"
	credGitHubURL  = "https://github.com/acme/backend.git"
	credHelperKey  = "credential.https://github.com.helper"
	credHelperForm = "!f() { echo username=x-access-token; echo password=$COMM_GIT_TOKEN; }; f"
)

// cmdRecorder is the Spawn seam: it records every prepared Command (argv and
// from-scratch env) and answers with canned success, so these tests assert
// the credential plumbing exactly the way a real run would shape it.
type cmdRecorder struct {
	cmds []Command
	// failIdx (index into cmds) makes that command fail with failOut on
	// stderr; -1 means every command succeeds.
	failIdx int
	failOut string
}

func (cr *cmdRecorder) spawn(_ context.Context, c Command) (Result, error) {
	cr.cmds = append(cr.cmds, c)
	if cr.failIdx >= 0 && cr.failIdx == len(cr.cmds)-1 {
		return Result{Stderr: cr.failOut}, errors.New("recorded failure")
	}
	// Canned success. refCommit / startPoint parse a commit id out of the
	// answer, so a sha is returned for every command; clone/fetch/worktree
	// answers are ignored.
	return Result{Stdout: strings.Repeat("a", 40) + "\n"}, nil
}

func recorderManager(t *testing.T, cr *cmdRecorder, root string) *Manager {
	t.Helper()
	runner := &Runner{
		Home:       filepath.Join(root, "home"),
		NeutralDir: filepath.Join(root, "neutral"),
		LookPath:   func(string) (string, error) { return "/usr/bin/git", nil },
		Spawn:      cr.spawn,
	}
	return &Manager{Git: runner, locks: newMirrorLocks()}
}

func envMap(c Command) map[string]string {
	m := make(map[string]string, len(c.Env))
	for _, kv := range c.Env {
		if k, v, ok := strings.Cut(kv, "="); ok {
			m[k] = v
		}
	}
	return m
}

func findCmd(t *testing.T, cmds []Command, want string) (Command, int) {
	t.Helper()
	for i, c := range cmds {
		for _, a := range c.Argv {
			if a == want {
				return c, i
			}
		}
	}
	t.Fatalf("no recorded git command with subcommand %q in %v", want, cmds)
	return Command{}, -1
}

// requireCredentialEnv asserts the full ADR-0061 credential set is present.
func requireCredentialEnv(t *testing.T, c Command, token string) {
	t.Helper()
	env := envMap(c)
	if env["GIT_TERMINAL_PROMPT"] != "0" {
		t.Errorf("%s env lacks GIT_TERMINAL_PROMPT=0", c.Argv)
	}
	if env["GIT_CONFIG_COUNT"] != "1" {
		t.Errorf("%s env: GIT_CONFIG_COUNT = %q, want 1", c.Argv, env["GIT_CONFIG_COUNT"])
	}
	if env["GIT_CONFIG_KEY_0"] != credHelperKey {
		t.Errorf("%s env: GIT_CONFIG_KEY_0 = %q, want %q", c.Argv, env["GIT_CONFIG_KEY_0"], credHelperKey)
	}
	if env["GIT_CONFIG_VALUE_0"] != credHelperForm {
		t.Errorf("%s env: GIT_CONFIG_VALUE_0 = %q, want %q", c.Argv, env["GIT_CONFIG_VALUE_0"], credHelperForm)
	}
	if env["COMM_GIT_TOKEN"] != token {
		t.Errorf("%s env: COMM_GIT_TOKEN is set to %q, want the token", c.Argv, env["COMM_GIT_TOKEN"])
	}
}

func requireNoCredentialEnv(t *testing.T, c Command) {
	t.Helper()
	env := envMap(c)
	for _, name := range []string{"COMM_GIT_TOKEN", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"} {
		if v, ok := env[name]; ok {
			t.Errorf("git %s env carries %s=%q — the credential must stay on the mirror clone/fetch only", c.Argv, name, v)
		}
	}
}

func requireArgvHasNoToken(t *testing.T, c Command) {
	t.Helper()
	for _, a := range c.Argv {
		if strings.Contains(a, credToken) {
			t.Errorf("git argv carries the token (%s = %q) — argv must stay token-free", strings.Join(c.Argv, " "), a)
		}
	}
}

func TestMirrorCloneAndFetchCarryCredentialEnv(t *testing.T) {
	spec := RepoSpec{Name: "backend", GitURL: credGitHubURL, DefaultBranch: "main", Token: credToken}
	ctx := context.Background()

	t.Run("clone --mirror carries the env, argv stays token-free", func(t *testing.T) {
		root := t.TempDir()
		cr := &cmdRecorder{failIdx: -1}
		m := recorderManager(t, cr, root)
		mirror := Mirror{Name: "backend", Path: filepath.Join(root, "project", "backend.git")}

		created, err := m.ensureMirror(ctx, mirror, spec)
		if err != nil {
			t.Fatalf("ensureMirror (clone path): %v", err)
		}
		if !created {
			t.Fatal("ensureMirror did not report creating the mirror")
		}
		clone, cloneIdx := findCmd(t, cr.cmds, "clone")
		if !contains(clone.Argv, "--mirror") {
			t.Fatalf("clone argv %v is not a mirror clone", clone.Argv)
		}
		requireCredentialEnv(t, clone, credToken)
		requireArgvHasNoToken(t, clone)
		// The refspec pinning (config) runs on the ordinary Runner: no env.
		for i, c := range cr.cmds {
			if i != cloneIdx {
				requireNoCredentialEnv(t, c)
			}
		}
	})

	t.Run("fetch --quiet --prune origin carries the env, argv stays token-free", func(t *testing.T) {
		root := t.TempDir()
		cr := &cmdRecorder{failIdx: -1}
		m := recorderManager(t, cr, root)
		mirror := Mirror{Name: "backend", Path: filepath.Join(root, "project", "backend.git")}
		if err := os.MkdirAll(mirror.Path, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(mirror.Path, "HEAD"), []byte("ref: refs/heads/main\n"), 0o644); err != nil {
			t.Fatal(err)
		}

		created, err := m.ensureMirror(ctx, mirror, spec)
		if err != nil {
			t.Fatalf("ensureMirror (fetch path): %v", err)
		}
		if created {
			t.Fatal("ensureMirror reported creating an existing mirror")
		}
		fetch, fetchIdx := findCmd(t, cr.cmds, "fetch")
		requireCredentialEnv(t, fetch, credToken)
		requireArgvHasNoToken(t, fetch)
		for i, c := range cr.cmds {
			if i != fetchIdx {
				requireNoCredentialEnv(t, c)
			}
		}
	})
}

func TestWorkspaceLinkCommandsInheritNoCredential(t *testing.T) {
	spec := RepoSpec{Name: "backend", GitURL: credGitHubURL, DefaultBranch: "main", Token: credToken}
	ctx := context.Background()

	t.Run("worktree add gets nothing", func(t *testing.T) {
		root := t.TempDir()
		cr := &cmdRecorder{failIdx: -1}
		m := recorderManager(t, cr, root)
		mirror := Mirror{Name: "backend", Path: filepath.Join(root, "project", "backend.git")}
		checkout := filepath.Join(root, "workspaces", "conversation", testConvA, "repos", "backend")

		if err := m.ensureCheckout(ctx, mirror, testConvA, spec, checkout, "worktree"); err != nil {
			t.Fatalf("ensureCheckout (worktree): %v", err)
		}
		wt, _ := findCmd(t, cr.cmds, "worktree")
		if !contains(wt.Argv, "add") {
			t.Fatalf("worktree argv %v is not an add", wt.Argv)
		}
		requireNoCredentialEnv(t, wt)
		requireArgvHasNoToken(t, wt)
		for _, c := range cr.cmds {
			requireNoCredentialEnv(t, c)
		}
	})

	t.Run("clone --no-local into the workspace gets nothing", func(t *testing.T) {
		root := t.TempDir()
		cr := &cmdRecorder{failIdx: -1}
		m := recorderManager(t, cr, root)
		mirror := Mirror{Name: "backend", Path: filepath.Join(root, "project", "backend.git")}
		checkout := filepath.Join(root, "workspaces", "conversation", testConvA, "repos", "backend")

		if err := m.ensureCheckout(ctx, mirror, testConvA, spec, checkout, "clone"); err != nil {
			t.Fatalf("ensureCheckout (clone): %v", err)
		}
		clone, _ := findCmd(t, cr.cmds, "clone")
		if !contains(clone.Argv, "--no-local") {
			t.Fatalf("clone argv %v is not the no-local workspace clone", clone.Argv)
		}
		requireNoCredentialEnv(t, clone)
		requireArgvHasNoToken(t, clone)
		for _, c := range cr.cmds {
			requireNoCredentialEnv(t, c)
		}
	})
}

func TestAnonymousSpecCarriesNoCredentialEnv(t *testing.T) {
	spec := RepoSpec{Name: "backend", GitURL: credGitHubURL, DefaultBranch: "main"}
	ctx := context.Background()

	root := t.TempDir()
	cr := &cmdRecorder{failIdx: -1}
	m := recorderManager(t, cr, root)
	mirror := Mirror{Name: "backend", Path: filepath.Join(root, "project", "backend.git")}
	if _, err := m.ensureMirror(ctx, mirror, spec); err != nil {
		t.Fatalf("ensureMirror (anonymous): %v", err)
	}
	if len(cr.cmds) == 0 {
		t.Fatal("no git command was recorded")
	}
	for _, c := range cr.cmds {
		requireNoCredentialEnv(t, c)
		requireArgvHasNoToken(t, c)
	}
}

func TestFailingCloneErrorOmitsTheToken(t *testing.T) {
	spec := RepoSpec{Name: "backend", GitURL: credGitHubURL, DefaultBranch: "main", Token: credToken}
	ctx := context.Background()

	root := t.TempDir()
	cr := &cmdRecorder{
		failIdx: 0, // the clone is the first command on the create path
		failOut: "fatal: repository '" + credGitHubURL + "/' not found",
	}
	m := recorderManager(t, cr, root)
	mirror := Mirror{Name: "backend", Path: filepath.Join(root, "project", "backend.git")}

	_, err := m.ensureMirror(ctx, mirror, spec)
	if err == nil {
		t.Fatal("ensureMirror succeeded; the recorded clone failure must surface")
	}
	got := err.Error()
	if strings.Contains(got, credToken) {
		t.Errorf("clone error contains the token: %s", got)
	}
	if strings.Contains(got, "COMM_GIT_TOKEN") {
		t.Errorf("clone error names the credential env: %s", got)
	}
	// The error must still name the token-free URL and the mirror path —
	// what an operator needs to fix the repo, without what they must not see.
	if !strings.Contains(got, credGitHubURL) {
		t.Errorf("clone error lost the repository URL: %s", got)
	}
	clone := cr.cmds[0]
	requireArgvHasNoToken(t, clone)
}

// TestRealGitMirrorWithCredentialEnvAtPrepare is the offline proof the env
// does not break git: a local bare repository served over file:// must still
// prepare end to end with a Token set. The credential helper is scoped to
// https://github.com, so for a file:// remote it is a no-op — the env must
// ride along harmlessly on clone, on the later fetch, and on the worktree
// that links into the mirror.
func TestRealGitMirrorWithCredentialEnvAtPrepare(t *testing.T) {
	m, root := newTestManager(t)
	url := newOrigin(t, root, "credrepo")
	vols := measure(t, m)
	token := "tok_real-git-proof-9876"

	prep, err := m.Prepare(context.Background(), PrepareRequest{
		ScopeKind:         "conversation",
		ScopeID:           testConvA,
		ProjectID:         testProjectA,
		WorkspaceVolumeID: vols[RootKindWorkspaces].ID,
		MirrorVolumeID:    vols[RootKindRepos].ID,
		Repos:             []RepoSpec{{RepositoryID: testConvC, Name: "credrepo", GitURL: url, DefaultBranch: "main", Token: token}},
	})
	if err != nil {
		t.Fatalf("Prepare with Token set on a file:// remote: %v", err)
	}
	repo := prep.Repos[0]

	remoteURL := run(t, repo.MirrorPath, "config", "remote.origin.url")
	if remoteURL != url {
		t.Errorf("mirror remote URL = %q, want the token-free GitURL %q", remoteURL, url)
	}
	if strings.Contains(remoteURL, token) || strings.Contains(remoteURL, "COMM_GIT_TOKEN") {
		t.Errorf("mirror remote URL carries the credential: %q", remoteURL)
	}

	// Turn two exercises the fetch path with the credential env.
	again, err := m.Prepare(context.Background(), PrepareRequest{
		ScopeKind:         "conversation",
		ScopeID:           testConvA,
		ProjectID:         testProjectA,
		WorkspaceVolumeID: vols[RootKindWorkspaces].ID,
		MirrorVolumeID:    vols[RootKindRepos].ID,
		Repos:             []RepoSpec{{RepositoryID: testConvC, Name: "credrepo", GitURL: url, DefaultBranch: "main", Token: token}},
	})
	if err != nil {
		t.Fatalf("second Prepare (mirror fetch) with Token set: %v", err)
	}
	if again.Repos[0].HeadCommit != repo.HeadCommit {
		t.Errorf("second prepare moved the head: %s vs %s", again.Repos[0].HeadCommit, repo.HeadCommit)
	}
}
