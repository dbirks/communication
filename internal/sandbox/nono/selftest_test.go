package nono

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

// selftestScratch builds the three-directory layout the self-test needs outside
// any workspace and outside $HOME: a scratch root the grants live under, the
// launcher's own HOME (never a grant — probe C-H1's refusal is permanent), and
// the process HOME the test rides so the ambient login tree is never named.
func selftestScratch(t *testing.T, label string) (root, home string) {
	t.Helper()
	base := os.Getenv("COMMUNICATION_LAB_SCRATCH")
	if base == "" {
		homeDir, err := os.UserHomeDir()
		if err != nil || homeDir == "" {
			t.Skipf("no home to put lab scratch in (set COMMUNICATION_LAB_SCRATCH): %v", err)
		}
		base = filepath.Join(homeDir, ".cache", "communication-lab", "go-sandbox")
	}
	root = filepath.Join(base, label, time.Now().Format("150405.000"))
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(root) })
	home = filepath.Join(root, "launcher-home")
	if err := os.MkdirAll(home, 0o700); err != nil {
		t.Fatal(err)
	}
	ambient := filepath.Join(root, "ambient-home")
	if err := os.MkdirAll(ambient, 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", ambient)
	return root, home
}

// requireRealNono skips when *this host cannot run the test at all*, and says
// which fact it skipped on. There are exactly two, and they are different:
//
//	a. no nono binary on PATH — nothing to test. Install the pinned build from
//	   docs/compatibility/probes/sandbox/README.md to run it (CI does, and the
//	   go job prints `nono setup --check-only` so the runner's capability is on
//	   the record);
//	b. a nono that reports it cannot establish a Landlock filesystem ruleset
//	   here — a kernel without Landlock, or a seccomp filter that blocks the
//	   syscalls. The self-test would then fail on its *granted-write* leg,
//	   which is an environment fact, not the finding the test exists to make.
//
// What is deliberately NOT a skip: a host where the probe claims support and
// the self-test then disagrees. That is the discrepancy ADR-0019 D6's startup
// gate exists to catch, and the negative control in
// selftest_negative_test.go shows the assertion bites.
func requireRealNono(t *testing.T, l *Launcher) {
	t.Helper()
	bin, err := exec.LookPath(defaultBinary)
	if err != nil {
		t.Skipf("no %s binary on PATH, so real enforcement cannot be observed here; install the pinned build (docs/compatibility/probes/sandbox/README.md): %v", defaultBinary, err)
	}
	l.Binary = bin
	caps, err := l.Probe(context.Background())
	if err != nil {
		t.Skipf("%s cannot establish sandbox support on this host: %v", bin, err)
	}
	if !caps.Filesystem {
		t.Skipf("%s %s reports no Landlock filesystem support on this kernel, so there is nothing to enforce the self-test with: %q", bin, caps.Version, caps.Notes)
	}
	t.Logf("probe: backend=%s version=%s notes=%q", caps.Backend, caps.Version, caps.Notes)
}

func TestSelfTestPassesOnRealNono(t *testing.T) {
	root, home := selftestScratch(t, "selftest")
	l := &Launcher{Home: home}
	requireRealNono(t, l)

	res, err := l.SelfTest(context.Background(), root, 30*time.Second)
	if err != nil {
		t.Fatalf("self-test: %v", err)
	}
	if !res.FilesystemLive || res.GrantsVerified != 1 {
		t.Fatalf("result: %+v", res)
	}
	t.Logf("observed backend=%s version=%s", res.Backend, res.Version)
}

func TestSelfTestRefusesHomeScratch(t *testing.T) {
	// This one asserts the adapter's own refusal, which runs before any exec —
	// so it needs no nono binary and is not skipped when one is absent.
	home := t.TempDir()
	t.Setenv("HOME", home)
	l := &Launcher{}
	if _, err := l.SelfTest(context.Background(), filepath.Join(home, "x"), time.Second); err == nil {
		t.Fatal("expected the C-H1 refusal")
	} else {
		t.Logf("refused: %v", err)
	}
}
