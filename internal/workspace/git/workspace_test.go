package git

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// These tests drive the real git binary: the whole point of the package is the
// behaviour of `git worktree` against a mirror, which no fake can tell us
// (AGENTS.md: a mocked green test never substitutes for a real integration
// test). Everything lives under t.TempDir(), and no fixture is under a temp
// *path prefix* the package forbids — see newTempRoot for how that is squared.

const (
	testProjectA = "11111111-1111-4111-8111-111111111111"
	testProjectB = "22222222-2222-4222-8222-222222222222"
	testConvA    = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	testConvB    = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	testConvC    = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
)

func requireGit(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skipf("git not available: %v", err)
	}
}

// labDir returns a scratch directory outside /tmp, /var/tmp and /dev/shm —
// the three prefixes ADR-0017 D5 forbids workspaces to live under, and which
// this package enforces on its own roots. The lab convention
// ($HOME/.cache/communication-lab) is what the probe suite uses for the same
// reason; TMPDIR is honoured only when it already points somewhere legal.
func labDir(t *testing.T) string {
	t.Helper()
	base := os.Getenv("COMMUNICATION_LAB_SCRATCH")
	if base == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			t.Skipf("no home directory for scratch: %v", err)
		}
		base = filepath.Join(home, ".cache", "communication-lab", "go-test")
	}
	if err := RefuseTempPath(base); err != nil {
		t.Skipf("lab scratch %s is refused as a workspace root: %v", base, err)
	}
	dir, err := os.MkdirTemp(base, t.Name()+"-")
	if err != nil {
		// A missing parent is a setup detail, not a test failure: create it.
		if err := os.MkdirAll(base, 0o755); err != nil {
			t.Fatalf("create lab scratch %s: %v", base, err)
		}
		if dir, err = os.MkdirTemp(base, filepath.Base(t.Name())+"-"); err != nil {
			t.Fatalf("mkdtemp under %s: %v", base, err)
		}
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	return dir
}

// gitEnv is the identity the fixture commits under — per-process env only, so
// a developer's global git config is never touched.
func setGitIdentity(t *testing.T) {
	t.Helper()
	t.Setenv("GIT_AUTHOR_NAME", "communication-test")
	t.Setenv("GIT_AUTHOR_EMAIL", "test@communication.invalid")
	t.Setenv("GIT_COMMITTER_NAME", "communication-test")
	t.Setenv("GIT_COMMITTER_EMAIL", "test@communication.invalid")
	t.Setenv("GIT_CONFIG_GLOBAL", filepath.Join(t.TempDir(), "nonexistent-gitconfig"))
	t.Setenv("GIT_CONFIG_SYSTEM", "/dev/null")
}

// runOK is `run` for commands whose non-zero exit is an answer rather than a
// failure (`git config --get` of an absent key, `git check-ignore` of an
// unignored path).
func runOK(t *testing.T, dir string, argv ...string) string {
	t.Helper()
	cmd := exec.Command("git", argv...) //nolint:gosec // test fixture argv
	cmd.Dir = dir
	out, _ := cmd.CombinedOutput()
	return strings.TrimSpace(string(out))
}

func run(t *testing.T, dir string, argv ...string) string {
	t.Helper()
	cmd := exec.Command("git", argv...) //nolint:gosec // test fixture argv
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(argv, " "), err, out)
	}
	return strings.TrimSpace(string(out))
}

// newOrigin seeds a repository with two files and returns a bare clone's
// file:// URL, which is what a repositories.git_url row holds in the lab
// (docs/m3-contract.md § 6: local paths, no credentials, no network).
func newOrigin(t *testing.T, root, name string) string {
	t.Helper()
	seed := filepath.Join(root, "origins", name)
	if err := os.MkdirAll(seed, 0o755); err != nil {
		t.Fatal(err)
	}
	run(t, seed, "init", "-q", "-b", "main", seed)
	writeFile(t, filepath.Join(seed, "README.md"), "# "+name+"\n")
	writeFile(t, filepath.Join(seed, "app.txt"), name+" line one\n")
	run(t, seed, "add", "-A")
	run(t, seed, "commit", "-qm", "seed "+name)
	bare := filepath.Join(root, "origins", name+".git")
	run(t, root, "clone", "--bare", "-q", seed, bare)
	return "file://" + bare
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func newTestManager(t *testing.T) (*Manager, string) {
	t.Helper()
	requireGit(t)
	setGitIdentity(t)
	root := labDir(t)
	wsRoot := filepath.Join(root, "workspaces")
	reposRoot := filepath.Join(root, "repos")
	for _, d := range []string{wsRoot, reposRoot} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	m, err := NewManager(wsRoot, reposRoot, &Runner{Home: filepath.Join(root, "launcher-home")})
	if err != nil {
		t.Fatalf("NewManager: %v", err)
	}
	return m, root
}

func measure(t *testing.T, m *Manager) map[string]Volume {
	t.Helper()
	vols, err := m.Measure()
	if err != nil {
		t.Fatalf("Measure: %v", err)
	}
	return vols
}

func TestPrepareRealGitWorktreeAndMirror(t *testing.T) {
	m, root := newTestManager(t)
	url := newOrigin(t, root, "backend")
	vols := measure(t, m)

	prep, err := m.Prepare(context.Background(), PrepareRequest{
		ScopeKind:         "conversation",
		ScopeID:           testConvA,
		ProjectID:         testProjectA,
		WorkspaceVolumeID: vols[RootKindWorkspaces].ID,
		MirrorVolumeID:    vols[RootKindRepos].ID,
		Repos:             []RepoSpec{{RepositoryID: testConvC, Name: "backend", GitURL: url, DefaultBranch: "main"}},
		ExcludedPaths:     []string{".env.test.local", "apm_modules"},
	})
	if err != nil {
		t.Fatalf("Prepare: %v", err)
	}
	if len(prep.Repos) != 1 {
		t.Fatalf("want 1 repo, got %d", len(prep.Repos))
	}
	repo := prep.Repos[0]

	t.Run("mirror is per project", func(t *testing.T) {
		want := filepath.Join(root, "repos", testProjectA, "backend.git")
		if repo.MirrorPath != want {
			t.Errorf("mirror path = %s, want %s", repo.MirrorPath, want)
		}
		if _, err := os.Stat(filepath.Join(want, "HEAD")); err != nil {
			t.Errorf("mirror not created: %v", err)
		}
	})

	t.Run("worktree is on the per-scope branch", func(t *testing.T) {
		got := run(t, repo.CheckoutPath, "rev-parse", "--abbrev-ref", "HEAD")
		if want := testConvA + "/backend"; got != want {
			t.Errorf("branch = %s, want %s", got, want)
		}
		if repo.RunRef != testConvA+"/backend" {
			t.Errorf("RunRef = %s", repo.RunRef)
		}
		if len(repo.BaseCommit) != 40 {
			t.Errorf("BaseCommit = %q, want a sha", repo.BaseCommit)
		}
		if repo.HeadCommit != repo.BaseCommit {
			t.Errorf("HeadCommit %q != BaseCommit %q on a fresh worktree", repo.HeadCommit, repo.BaseCommit)
		}
	})

	t.Run("admin dir is read back, not constructed", func(t *testing.T) {
		// ADR-0017 P1: the admin dir name is git's choice, so the value in the
		// row must be the one git actually used.
		got := run(t, repo.CheckoutPath, "rev-parse", "--absolute-git-dir")
		if got != repo.AdminDir {
			t.Errorf("AdminDir = %s, git says %s", repo.AdminDir, got)
		}
		if !strings.Contains(repo.AdminDir, "worktrees") {
			t.Errorf("AdminDir %q is not a worktree admin directory", repo.AdminDir)
		}
	})

	t.Run("reflog namespace exists before any commit", func(t *testing.T) {
		for _, d := range []string{
			filepath.Join(repo.MirrorPath, "refs", "heads", testConvA),
			filepath.Join(repo.MirrorPath, "logs", "refs", "heads", testConvA),
		} {
			if st, err := os.Stat(d); err != nil || !st.IsDir() {
				t.Errorf("pre-created dir %s missing (probe P7): %v", d, err)
			}
		}
	})

	t.Run("declared exclusions are honored by git", func(t *testing.T) {
		writeFile(t, filepath.Join(repo.CheckoutPath, ".env.test.local"), "DATABASE_URL=SENTINEL-not-a-secret\n")
		if out := run(t, repo.CheckoutPath, "status", "--porcelain"); strings.Contains(out, ".env.test.local") {
			t.Errorf("excluded file is visible to git status: %q", out)
		}
		if err := exec.Command("git", "-C", repo.CheckoutPath, "check-ignore", "-q", ".env.test.local").Run(); err != nil {
			t.Errorf("check-ignore refused the declared exclusion: %v", err)
		}
		// The exclusion lives in the mirror's shared file, which is the only
		// place git honors it in this layout (probes X1/X2).
		data, err := os.ReadFile(filepath.Join(repo.MirrorPath, "info", "exclude"))
		if err != nil {
			t.Fatalf("read info/exclude: %v", err)
		}
		if !strings.Contains(string(data), ".env.test.local") {
			t.Errorf("info/exclude does not name the exclusion: %s", data)
		}
	})

	t.Run("prepare is idempotent", func(t *testing.T) {
		again, err := m.Prepare(context.Background(), PrepareRequest{
			ScopeKind:         "conversation",
			ScopeID:           testConvA,
			ProjectID:         testProjectA,
			WorkspaceVolumeID: vols[RootKindWorkspaces].ID,
			MirrorVolumeID:    vols[RootKindRepos].ID,
			Repos:             []RepoSpec{{RepositoryID: testConvC, Name: "backend", GitURL: url, DefaultBranch: "main"}},
			ExcludedPaths:     []string{".env.test.local", "apm_modules"},
		})
		if err != nil {
			t.Fatalf("second Prepare: %v", err)
		}
		if again.Repos[0].AdminDir != repo.AdminDir || again.Repos[0].BaseCommit != repo.BaseCommit {
			t.Errorf("re-prepare changed topology: %s/%s vs %s/%s",
				again.Repos[0].AdminDir, again.Repos[0].BaseCommit, repo.AdminDir, repo.BaseCommit)
		}
	})

	t.Run("agent home is 0700 with a git identity", func(t *testing.T) {
		st, err := os.Stat(prep.Layout.Home)
		if err != nil {
			t.Fatal(err)
		}
		if st.Mode().Perm() != 0o700 {
			t.Errorf("home mode = %v, want 0700", st.Mode().Perm())
		}
		data, err := os.ReadFile(filepath.Join(prep.Layout.Home, ".gitconfig"))
		if err != nil {
			t.Fatalf("seed .gitconfig missing (probe P6 makes an ungranted HOME fatal for git): %v", err)
		}
		if !strings.Contains(string(data), "[user]") {
			t.Errorf("seed .gitconfig has no identity: %s", data)
		}
	})
}

// TestDeclareExclusionsSkipsTrackedPaths is the apm.lock.yaml case (apm 0.33
// probe A5): a pinned project *commits* its lockfile, and `install --frozen`
// rewrites it in place. An exclude file can never hide tracked content, and
// `check-ignore` honestly says so — declaring such a path used to fail the
// whole prepare at the confirmation step. Tracked declarations are skipped;
// untracked generated paths beside them must still be confirmed.
func TestDeclareExclusionsSkipsTrackedPaths(t *testing.T) {
	m, root := newTestManager(t)
	seed := filepath.Join(root, "origins", "apm-app")
	if err := os.MkdirAll(seed, 0o755); err != nil {
		t.Fatal(err)
	}
	run(t, seed, "init", "-q", "-b", "main", seed)
	writeFile(t, filepath.Join(seed, "README.md"), "# apm-app\n")
	writeFile(t, filepath.Join(seed, "apm.lock.yaml"), "lockfile_version: '1'\n")
	run(t, seed, "add", "-A")
	run(t, seed, "commit", "-qm", "seed apm-app")
	bare := filepath.Join(root, "origins", "apm-app.git")
	run(t, root, "clone", "--bare", "-q", seed, bare)
	vols := measure(t, m)

	prep, err := m.Prepare(context.Background(), PrepareRequest{
		ScopeKind:         "conversation",
		ScopeID:           testConvA,
		ProjectID:         testProjectA,
		WorkspaceVolumeID: vols[RootKindWorkspaces].ID,
		MirrorVolumeID:    vols[RootKindRepos].ID,
		Repos:             []RepoSpec{{RepositoryID: testConvC, Name: "apm-app", GitURL: "file://" + bare, DefaultBranch: "main"}},
	})
	if err != nil {
		t.Fatalf("Prepare: %v", err)
	}
	repo := &prep.Repos[0]
	// What a frozen install leaves behind: the tracked lock rewritten, plus
	// untracked generated trees.
	writeFile(t, filepath.Join(repo.CheckoutPath, "apm.lock.yaml"), "lockfile_version: '1'\nrewritten: true\n")
	if err := os.MkdirAll(filepath.Join(repo.CheckoutPath, ".claude", "skills"), 0o755); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(repo.CheckoutPath, ".claude", "skills", "alpha.md"), "alpha\n")

	declared, err := m.DeclareExclusions(context.Background(), repo, []string{"apm.lock.yaml", ".claude"})
	if err != nil {
		t.Fatalf("DeclareExclusions with a tracked path in the set: %v", err)
	}
	if len(declared) == 0 {
		t.Fatal("declared set is empty")
	}
	exclude := filepath.Join(repo.MirrorPath, "info", "exclude")
	data, err := os.ReadFile(exclude)
	if err != nil {
		t.Fatalf("read %s: %v", exclude, err)
	}
	if !strings.Contains(string(data), ".claude") {
		t.Errorf("untracked generated path missing from %s: %s", exclude, data)
	}
	// The untracked path must be genuinely ignored in the checkout (the same
	// confirmation the refuse-on-failure path performs).
	if out, err := exec.Command("git", "-c", "safe.directory=*", "-C", repo.CheckoutPath,
		"check-ignore", ".claude").Output(); err != nil || strings.TrimSpace(string(out)) != ".claude" {
		t.Errorf("check-ignore .claude = %q, err %v", out, err)
	}
}

// TestPrepareSameRepoTwoScopes is ADR-0017 P1 measured through this package:
// two worktrees of one repository collide on basename and git auto-suffixes the
// admin directory, so the two rows must name *different* admin dirs.
func TestPrepareSameRepoTwoScopes(t *testing.T) {
	m, root := newTestManager(t)
	url := newOrigin(t, root, "backend")
	vols := measure(t, m)
	req := func(id string) PrepareRequest {
		return PrepareRequest{
			ScopeKind: "conversation", ScopeID: id, ProjectID: testProjectA,
			WorkspaceVolumeID: vols[RootKindWorkspaces].ID, MirrorVolumeID: vols[RootKindRepos].ID,
			Repos: []RepoSpec{{RepositoryID: testConvC, Name: "backend", GitURL: url, DefaultBranch: "main"}},
		}
	}
	one, err := m.Prepare(context.Background(), req(testConvA))
	if err != nil {
		t.Fatalf("prepare run-1: %v", err)
	}
	two, err := m.Prepare(context.Background(), req(testConvB))
	if err != nil {
		t.Fatalf("prepare run-2: %v", err)
	}
	if one.Repos[0].AdminDir == two.Repos[0].AdminDir {
		t.Fatalf("both scopes report the same admin dir %s; the commit grant would then be one namespace shared by two runs", one.Repos[0].AdminDir)
	}
	if filepath.Base(one.Repos[0].AdminDir) == filepath.Base(two.Repos[0].AdminDir) {
		t.Fatalf("admin basenames identical: %s vs %s", one.Repos[0].AdminDir, two.Repos[0].AdminDir)
	}

	// Case 17 / WORKSPACES W2: a commit in one checkout leaves the other clean
	// and unchanged.
	writeFile(t, filepath.Join(one.Repos[0].CheckoutPath, "app.txt"), "edited by run-1\n")
	run(t, one.Repos[0].CheckoutPath, "add", "app.txt")
	run(t, one.Repos[0].CheckoutPath, "commit", "-qm", "run-1 edit")
	if out := run(t, two.Repos[0].CheckoutPath, "status", "--porcelain"); out != "" {
		t.Errorf("run-2 is dirty after run-1 committed: %q", out)
	}
	if got := run(t, two.Repos[0].CheckoutPath, "log", "--oneline", "-1"); strings.Contains(got, "run-1 edit") {
		t.Errorf("run-2 sees run-1's commit: %q", got)
	}
	if head, err := m.HeadCommit(context.Background(), one.Repos[0].CheckoutPath); err != nil || head == one.Repos[0].BaseCommit {
		t.Errorf("HeadCommit after a real commit = %q (base %q), err %v", head, one.Repos[0].BaseCommit, err)
	}

	// W6: releasing one run must not disturb the other.
	if ok := m.RemoveWorktrees(context.Background(), one.Layout, one.Repos); !ok {
		t.Errorf("RemoveWorktrees reported incomplete pruning")
	}
	if _, err := os.Stat(two.Repos[0].CheckoutPath); err != nil {
		t.Errorf("run-2's checkout disappeared when run-1 was released: %v", err)
	}
}

// TestConcurrentPrepareOneMirror is probe G10 turned into a regression test:
// six parallel prepares against one mirror used to fail on
// `could not lock config file <mirror>/config: File exists` on git 2.39.5.
// Per-mirror serialization is the remedy this package implements.
func TestConcurrentPrepareOneMirror(t *testing.T) {
	m, root := newTestManager(t)
	url := newOrigin(t, root, "backend")
	vols := measure(t, m)

	const n = 6
	ids := make([]string, n)
	for i := range ids {
		// Valid distinct uuids; LayoutOf refuses anything else.
		ids[i] = fmt.Sprintf("%08d-0000-4000-8000-000000000000", i+1)
	}
	var wg sync.WaitGroup
	errs := make([]error, n)
	for i, id := range ids {
		wg.Add(1)
		go func(i int, id string) {
			defer wg.Done()
			_, err := m.Prepare(context.Background(), PrepareRequest{
				ScopeKind: "conversation", ScopeID: id, ProjectID: testProjectA,
				WorkspaceVolumeID: vols[RootKindWorkspaces].ID, MirrorVolumeID: vols[RootKindRepos].ID,
				Repos: []RepoSpec{{RepositoryID: testConvC, Name: "backend", GitURL: url, DefaultBranch: "main"}},
			})
			errs[i] = err
		}(i, id)
	}
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Errorf("concurrent prepare %d failed (probe G10): %v", i, err)
		}
	}
}

func TestPrepareRefusals(t *testing.T) {
	m, root := newTestManager(t)
	url := newOrigin(t, root, "backend")
	vols := measure(t, m)
	base := PrepareRequest{
		ScopeKind: "conversation", ScopeID: testConvA, ProjectID: testProjectA,
		WorkspaceVolumeID: vols[RootKindWorkspaces].ID, MirrorVolumeID: vols[RootKindRepos].ID,
		Repos: []RepoSpec{{RepositoryID: testConvC, Name: "backend", GitURL: url}},
	}

	t.Run("no volume identity", func(t *testing.T) {
		req := base
		req.WorkspaceVolumeID = ""
		if _, err := m.Prepare(context.Background(), req); err == nil {
			t.Error("want ErrVolumeUnknown, got nil")
		}
	})
	t.Run("scope id that is not a uuid", func(t *testing.T) {
		req := base
		req.ScopeID = "../../etc"
		if _, err := m.Prepare(context.Background(), req); err == nil {
			t.Error("want traversal refusal, got nil")
		}
	})
	t.Run("repository name that is not a safe directory", func(t *testing.T) {
		req := base
		req.Repos = []RepoSpec{{RepositoryID: testConvC, Name: "../escape", GitURL: url}}
		if _, err := m.Prepare(context.Background(), req); err == nil {
			t.Error("want unsafe-name refusal, got nil")
		}
	})
	t.Run("unknown mode", func(t *testing.T) {
		req := base
		req.Mode = "symlink"
		if _, err := m.Prepare(context.Background(), req); err == nil {
			t.Error("want mode refusal, got nil")
		}
	})
	t.Run("temp-root manager", func(t *testing.T) {
		if _, err := NewManager("/tmp/workspaces", "/repos", nil); err == nil {
			t.Error("want temp-path refusal for the workspace root, got nil")
		}
		if _, err := NewManager("/workspaces", "/var/tmp/repos", nil); err == nil {
			t.Error("want temp-path refusal for the mirror root, got nil")
		}
	})
	t.Run("absolute exclusion path", func(t *testing.T) {
		req := base
		req.ExcludedPaths = []string{"/etc/passwd"}
		if _, err := m.Prepare(context.Background(), req); err == nil {
			t.Error("want exclusion-path refusal, got nil")
		}
	})
}

// TestStatusSubtractsDeclaredExclusions is ADR-0017 D6's defense in depth:
// the manifest the checkpoint is built from must filter the exclusion set in
// code, so a git-level exclusion is never the only thing between a .env and an
// artifact.
func TestStatusSubtractsDeclaredExclusions(t *testing.T) {
	m, root := newTestManager(t)
	url := newOrigin(t, root, "backend")
	vols := measure(t, m)
	prep, err := m.Prepare(context.Background(), PrepareRequest{
		ScopeKind: "conversation", ScopeID: testConvA, ProjectID: testProjectA,
		WorkspaceVolumeID: vols[RootKindWorkspaces].ID, MirrorVolumeID: vols[RootKindRepos].ID,
		Repos:         []RepoSpec{{RepositoryID: testConvC, Name: "backend", GitURL: url}},
		ExcludedPaths: []string{".env.test.local"},
	})
	if err != nil {
		t.Fatalf("Prepare: %v", err)
	}
	dir := prep.Repos[0].CheckoutPath
	writeFile(t, filepath.Join(dir, ".env.test.local"), "DATABASE_URL=SENTINEL-not-a-secret\n")
	writeFile(t, filepath.Join(dir, "app.txt"), "an edit\n")

	sum, err := m.Status(context.Background(), dir, prep.Repos[0].ExcludedPaths)
	if err != nil {
		t.Fatalf("Status: %v", err)
	}
	if !sum.Dirty {
		t.Error("want Dirty with a tracked edit")
	}
	for _, p := range sum.Paths {
		if strings.Contains(p, ".env.test.local") {
			t.Errorf("manifest leaked the excluded path: %v", sum.Paths)
		}
	}
	if !contains(sum.Paths, "app.txt") {
		t.Errorf("manifest lost the real edit: %v", sum.Paths)
	}

	// The real defense-in-depth proof: strip the exclusion from git's own
	// ignore state, confirm git now shows the file, and check that Status
	// still drops it because the *declared* set is the filter.
	exclude := filepath.Join(prep.Repos[0].MirrorPath, "info", "exclude")
	if err := os.WriteFile(exclude, []byte("# emptied by test\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if out := run(t, dir, "status", "--porcelain"); !strings.Contains(out, ".env.test.local") {
		t.Fatalf("precondition: git should now show the file, got %q", out)
	}
	sum2, err := m.Status(context.Background(), dir, []string{".env.test.local"})
	if err != nil {
		t.Fatalf("Status: %v", err)
	}
	if contains(sum2.Paths, ".env.test.local") {
		t.Errorf("Status trusted git's ignore state and leaked the excluded path: %v", sum2.Paths)
	}
}

// TestMirrorRefetchKeepsRunRefs is the bug this package actually hit. A
// `git clone --mirror` mirror sets `remote.origin.mirror=true` with refspec
// `+refs/*:refs/*`, so `git fetch --prune` (ADR-0017 D2's update path) deletes
// every ref the remote lacks — including the run branch D4 hands the agent as
// its commit grant. Before the refspec was pinned, the second prepare pruned
// the first run's branch out from under its own worktree.
func TestMirrorRefetchKeepsRunRefs(t *testing.T) {
	m, root := newTestManager(t)
	url := newOrigin(t, root, "backend")
	vols := measure(t, m)
	req := PrepareRequest{
		ScopeKind: "conversation", ScopeID: testConvA, ProjectID: testProjectA,
		WorkspaceVolumeID: vols[RootKindWorkspaces].ID, MirrorVolumeID: vols[RootKindRepos].ID,
		Repos: []RepoSpec{{RepositoryID: testConvC, Name: "backend", GitURL: url, DefaultBranch: "main"}},
	}
	prep, err := m.Prepare(context.Background(), req)
	if err != nil {
		t.Fatalf("Prepare: %v", err)
	}
	dir := prep.Repos[0].CheckoutPath
	mirror := prep.Repos[0].MirrorPath
	// `config --get` exits 1 when the key is absent, which is the point.
	if out := runOK(t, mirror, "config", "--get", "remote.origin.mirror"); strings.TrimSpace(out) == "true" {
		t.Fatalf("mirror still has remote.origin.mirror=true: a prune would delete the run branches")
	}
	if out := runOK(t, mirror, "config", "--get", "remote.origin.fetch"); !strings.Contains(out, "refs/remotes/origin/") {
		t.Fatalf("mirror fetch refspec is %q; without a remote-tracking destination, `fetch --prune` overwrites or prunes the run branches", out)
	}

	// The agent commits on the run branch…
	writeFile(t, filepath.Join(dir, "app.txt"), "the agent's work\n")
	run(t, dir, "add", "app.txt")
	run(t, dir, "commit", "-qm", "agent work")
	committed := run(t, dir, "rev-parse", "HEAD")

	// …and the next prepare fetches the same mirror (an origin that moved on).
	run(t, filepath.Join(root, "origins", "backend"), "commit", "--allow-empty", "-qm", "upstream moved")
	if _, err := m.Prepare(context.Background(), req); err != nil {
		t.Fatalf("Prepare after an upstream move: %v", err)
	}
	if got := run(t, mirror, "rev-parse", "--verify", "refs/heads/"+testConvA+"/backend"); got != committed {
		t.Errorf("run branch after re-prepare = %q, want the agent's commit %q — the fetch pruned it", got, committed)
	}
	if got := run(t, dir, "rev-parse", "HEAD"); got != committed {
		t.Errorf("worktree HEAD moved under the run: %q vs %q", got, committed)
	}
	// Upstream is visible as a remote-tracking ref, which is where a rebase or
	// an update would read it from — not by overwriting the run branch.
	if out := run(t, mirror, "rev-parse", "--verify", "refs/remotes/origin/main"); len(out) != 40 {
		t.Errorf("mirror has no refs/remotes/origin/main to compare against: %q", out)
	}
}

func TestVolumeIdentityRules(t *testing.T) {
	dir := labDir(t)
	root := filepath.Join(dir, "root")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	v, err := MeasureVolume(RootKindWorkspaces, root)
	if err != nil {
		t.Fatalf("MeasureVolume: %v", err)
	}
	if !strings.HasPrefix(v.ID, "sha256:") || len(v.ID) != 7+64 {
		t.Errorf("volume id %q is not a sha256-prefixed digest", v.ID)
	}
	if v.Path != root {
		t.Errorf("path %q != %q", v.Path, root)
	}
	again, err := MeasureVolume(RootKindWorkspaces, root)
	if err != nil || again.ID != v.ID {
		t.Errorf("identity is not stable across measurements: %q vs %q (%v)", v.ID, again.ID, err)
	}
	// Probe V3: a *different* volume at the same path differs in inode, and an
	// identity built on st_dev alone would call the two the same.
	other := VolumeID(v.StDev, v.StIno+1, v.Path)
	if other == v.ID {
		t.Error("identity ignores st_ino: a replaced named volume would read as the same one (probe V3)")
	}
	if VolumeID(v.StDev, v.StIno, "/elsewhere") == v.ID {
		t.Error("identity ignores the root path")
	}
	// Probe V5b: two roots, one device, different inodes → two identities.
	if VolumeID(30, 100, "/workspaces") == VolumeID(30, 101, "/repos") {
		t.Error("one identity cannot name two storage roots")
	}
	// A missing root must not read as "unknown volume".
	if _, err := MeasureVolume(RootKindRepos, filepath.Join(dir, "nope")); err == nil {
		t.Error("want an error for a missing storage root")
	}
	if _, err := MeasureVolume("nonsense", root); err == nil {
		t.Error("want an error for an unknown root kind")
	}
	if _, err := MeasureVolume(RootKindWorkspaces, "/tmp/x"); err == nil {
		t.Error("want an error for a temp-tree storage root")
	}
}

func TestCheckGrantPath(t *testing.T) {
	dir := labDir(t)
	exists := filepath.Join(dir, "exists")
	if err := os.MkdirAll(exists, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{"", "relative/x", "/tmp/sbx", "/var/tmp/sbx", "/dev/shm/sbx", "/a/../b", "/a//b", "/nope"} {
		err := CheckGrantPath(bad)
		if err == nil {
			t.Errorf("CheckGrantPath(%q) accepted a path it must refuse", bad)
			continue
		}
		if bad == "/nope" && !strings.Contains(err.Error(), "probe C-FC3") {
			t.Errorf("a nonexistent grant must be refused with the C-FC3 reason, got %v", err)
		}
	}
	if err := CheckGrantPath(exists); err != nil {
		t.Errorf("CheckGrantPath(%q) = %v", exists, err)
	}
}

func contains(hay []string, needle string) bool {
	for _, s := range hay {
		if s == needle {
			return true
		}
	}
	return false
}

// TestRePrepareAfterReleaseResumesTheRunRef is the turn-two case, and it was not
// covered until a live compose run failed on it.
//
// A released workspace deliberately keeps its run refs (ADR-0017 D1: the ref is
// what makes the next turn on a conversation continue from what the last one
// committed rather than restarting from the branch head). So on the second turn
// the branch exists and the worktree does not — and `git worktree add -b <name>`
// answers "fatal: a branch named '<run-ref>' already exists". A prepare that
// cannot survive its own release path makes every resumed conversation
// permanently unstartable, which is a bug that cannot be observed on turn one and
// therefore cannot be caught by a test that only ever prepares once.
func TestRePrepareAfterReleaseResumesTheRunRef(t *testing.T) {
	ctx := context.Background()
	m, root := newTestManager(t)
	url := newOrigin(t, root, "backend")
	vols := measure(t, m)
	req := func(id string) PrepareRequest {
		return PrepareRequest{
			ScopeKind: "conversation", ScopeID: id, ProjectID: testProjectA,
			WorkspaceVolumeID: vols[RootKindWorkspaces].ID, MirrorVolumeID: vols[RootKindRepos].ID,
			Repos: []RepoSpec{{RepositoryID: testConvC, Name: "backend", GitURL: url, DefaultBranch: "main"}},
		}
	}

	first, err := m.Prepare(ctx, req(testConvA))
	if err != nil {
		t.Fatalf("prepare turn-1: %v", err)
	}
	repo := first.Repos[0]

	// Turn one commits something, so there is a real history to resume onto.
	writeFile(t, filepath.Join(repo.CheckoutPath, "TURN1.md"), "from turn one\n")
	run(t, repo.CheckoutPath, "add", "TURN1.md")
	run(t, repo.CheckoutPath, "commit", "-qm", "turn-1 edit")
	committed := run(t, repo.CheckoutPath, "rev-parse", "HEAD")

	if ok := m.RemoveWorktrees(ctx, first.Layout, first.Repos); !ok {
		t.Fatalf("release reported incomplete pruning")
	}
	if _, err := os.Stat(repo.CheckoutPath); err == nil {
		t.Fatalf("the checkout survived its release")
	}

	second, err := m.Prepare(ctx, req(testConvA))
	if err != nil {
		t.Fatalf("prepare turn-2 (a resumed conversation must be preparable): %v", err)
	}
	resumed := second.Repos[0]

	// The resumed HEAD is turn one's commit, not the branch head: a worktree
	// created from `startPoint` would silently discard the conversation's own
	// history while reporting a successful prepare.
	if resumed.BaseCommit != committed {
		t.Fatalf("resumed base = %q, want turn-1's %q: the run's history was dropped on resume", resumed.BaseCommit, committed)
	}
	if got := run(t, resumed.CheckoutPath, "show", "--stat", "--oneline", "-s", "HEAD"); !strings.Contains(got, "turn-1 edit") {
		t.Fatalf("resumed checkout does not contain turn one's commit: %q", got)
	}
	if _, err := os.ReadFile(filepath.Join(resumed.CheckoutPath, "TURN1.md")); err != nil {
		t.Fatalf("turn-1's file is missing from the resumed workspace: %v", err)
	}

	// The run ref is one ref, not two: a second branch for the same scope would
	// give the next checkpoint a different target than the last one wrote.
	refs := run(t, "", "--git-dir="+resumed.MirrorPath, "for-each-ref", "refs/heads/"+testConvA+"/")
	if n := len(strings.Split(strings.TrimSpace(refs), "\n")); n != 1 {
		t.Fatalf("run refs under %s/ = %d, want 1:\n%s", testConvA, n, refs)
	}
}
