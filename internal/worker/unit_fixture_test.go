package worker_test

// Fixture plumbing for the unit-service tests: a real git repo to mirror, a real
// workspace manager pointed at lab scratch, and the small helpers those tests
// keep needing. The fixture is deliberately *real* on the git side — a mocked
// preparer would make every ordering assertion here vacuous, since the thing
// under test is what the ordering does to an actual tree.

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dbirks/communication/internal/agent/acp"
	wsgit "github.com/dbirks/communication/internal/workspace/git"
)

// labScratch returns a per-test scratch directory under the lab convention, and
// refuses to run the test if the location is one the contract rules out. Tests
// that need real filesystems use this rather than /tmp so the sandbox's own
// /tmp rules stay observable and so a crashed run cannot collide with another
// user's files.
func labScratch(t *testing.T, name string) string {
	t.Helper()
	base := os.Getenv("COMMUNICATION_LAB_SCRATCH")
	if base == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			t.Skipf("no home directory for lab scratch: %v", err)
		}
		base = filepath.Join(home, ".cache", "communication-lab", "go-test")
	}
	dir := filepath.Join(base, name, t.Name(), time.Now().Format("150405.000"))
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatalf("create lab scratch: %v", err)
	}
	if err := wsgit.RefuseTempPath(dir); err != nil {
		// A location the contract refuses is a setup detail (e.g. $HOME itself
		// is under /tmp), not a test failure: skip, as the workspace/git lab
		// helper does.
		t.Skipf("lab scratch location: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	return dir
}

// newWorkspaceManager builds a real Manager over lab scratch, with the real git
// binary. Nothing here is stubbed: an ordering guarantee about `info/exclude`
// or an admin dir read-back cannot be checked against a fake git.
func newWorkspaceManager(t *testing.T, root string) *wsgit.Manager {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skipf("git binary required: %v", err)
	}
	mgr, err := wsgit.NewManager(root+"/workspaces", root+"/repos", &wsgit.Runner{NeutralDir: root})
	if err != nil {
		t.Fatalf("workspace manager: %v", err)
	}
	return mgr
}

// seedBareRepo creates a bare repository with one commit on `main` and returns
// its path as a clone URL. The content is minimal but real: git will not fetch a
// directory, and the run-ref assertions need an actual object.
func seedBareRepo(t *testing.T, root string) string {
	t.Helper()
	// Built once per fixture and reused: f.request() is called several times by
	// some tests (and again by workspacePath()), and a second `git commit` in the
	// same seed tree answers "nothing to commit" — which reads like a workspace
	// bug and is only the fixture asking twice.
	if seed := filepath.Join(root, "seed.git"); dirExists(seed) {
		return seed
	}
	bare := filepath.Join(root, "seed.git")
	work := filepath.Join(root, "seed-work")
	for _, d := range []string{bare, work} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	run := func(dir string, args ...string) string {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=Seed", "GIT_AUTHOR_EMAIL=seed@communication.test",
			"GIT_COMMITTER_NAME=Seed", "GIT_COMMITTER_EMAIL=seed@communication.test")
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
		return string(out)
	}
	run(bare, "init", "--bare", "--initial-branch=main")
	// `git init` on a writable directory does not always mark it safe, and an
	// "unsafe repository" refusal inside a test is indistinguishable from a real
	// topology bug when it arrives as a fetch failure three layers away.
	run(bare, "config", "--global", "safe.directory", bare)
	t.Cleanup(func() {
		exec.Command("git", "config", "--global", "--unset-all", "safe.directory", bare).Run()
	})
	run(work, "init", "--initial-branch=main")
	// git refuses to commit with no identity at all, and the fixture must not
	// depend on the developer's global config: an operator without one would see
	// every workspace test fail for a reason that has nothing to do with the
	// code under test.
	run(work, "config", "user.name", "Seed")
	run(work, "config", "user.email", "seed@communication.test")
	if err := os.WriteFile(filepath.Join(work, "README.md"), []byte("# seed\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run(work, "add", "README.md")
	run(work, "commit", "-m", "seed")
	run(work, "remote", "add", "origin", bare)
	run(work, "push", "origin", "main")
	return bare
}

// nonoPath resolves the real nono binary, or skips the test when absent. A test
// that substitutes a stub for the launcher would assert nothing about argv
// semantics, so the ones that build argv require the real thing to exist and be
// the pinned version.
func nonoPath(t *testing.T) string {
	t.Helper()
	path, err := exec.LookPath("nono")
	if err != nil {
		t.Skipf("nono binary required to assert launch argv (ADR-0019's contract is about real argv): %v", err)
	}
	out, err := exec.Command(path, "--version").CombinedOutput()
	if err != nil {
		t.Skipf("nono --version failed: %v: %s", err, out)
	}
	if !strings.Contains(string(out), "0.80.0") {
		t.Skipf("nono 0.80.0 pinned, found: %s", strings.TrimSpace(string(out)))
	}
	return path
}

// testLauncher is the launcher the sandbox plan is built around. It is a real
// registry entry rather than a synthetic one: the argv the plan produces has to
// be the argv a real adapter would run with, and a made-up executable name would
// let a plan that could never launch pass.
func testLauncher() acp.Launcher {
	l, ok := acp.LookupLauncher("claude")
	if !ok {
		panic("the claude launcher disappeared from the registry")
	}
	return l
}

func marshalEvents(store *memStore) (string, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	raw, err := json.Marshal(store.events)
	if err != nil {
		return "", err
	}
	return string(raw), nil
}

func sha256sum(label string) string {
	sum := sha256.Sum256([]byte("communication-lab-" + label))
	return hex.EncodeToString(sum[:])
}

func dirExists(path string) bool {
	st, err := os.Stat(path)
	return err == nil && st.IsDir()
}

func writeFile(path string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, []byte("SECRET=materialized\n"), 0o600)
}

// uuidFor makes a stable 36-character id from a short label. The workspace
// layout refuses anything that is not canonical uuid text, so fixtures cannot
// pass "conv-1"; this keeps the derivation readable instead.
func uuidFor(label string) string {
	sum := sha256sum(label)
	return sum[0:8] + "-" + sum[8:12] + "-" + sum[12:16] + "-" + sum[16:20] + "-" + sum[20:32]
}

var fixtureLock sync.Mutex
