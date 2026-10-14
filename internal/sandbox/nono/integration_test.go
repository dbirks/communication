//go:build sandbox_integration

// Real-enforcement test for the nono adapter. It requires a Linux host with
// Landlock and the nono binary on PATH, and is skipped otherwise: capability
// claims come from observed execution only
// (communication-spec/12-test-strategy.md, docs/compatibility/SANDBOX.md).
//
// Run with:
//
//	go test -count=1 -tags sandbox_integration ./internal/sandbox/... -v
package nono

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/dbirks/communication/internal/domain"
)

// secretValue is a fixture marker, not a credential: it only has to be
// recognisable when it leaks into sandboxed output.
const secretValue = "M0-SANDBOX-PROBE-DENY-MARKER"

func TestNonoRequiredEnforcement(t *testing.T) {
	bin, err := exec.LookPath("nono")
	if err != nil {
		t.Skipf("nono not on PATH, skipping real enforcement test: %v", err)
	}

	fixture := t.TempDir()
	projA := filepath.Join(fixture, "projA")
	projB := filepath.Join(fixture, "projB")
	for _, d := range []string{projA, projB} {
		if err := os.Mkdir(d, 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", d, err)
		}
	}
	secretPath := filepath.Join(projB, "secret.txt")
	if err := os.WriteFile(secretPath, []byte(secretValue+"\n"), 0o600); err != nil {
		t.Fatalf("write secret: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()

	l := &Launcher{Binary: bin}
	caps, err := l.Probe(ctx)
	if err != nil {
		t.Skipf("nono probe failed on this host (%v), skipping", err)
	}
	t.Logf("probe: backend=%s version=%s filesystem=%v network=%v verified=%v notes=%q",
		caps.Backend, caps.Version, caps.Filesystem, caps.Network, caps.Verified, caps.Notes)
	if !caps.Filesystem {
		t.Skipf("nono reports no verified Landlock filesystem support on this host: %q", caps.Notes)
	}

	policy := domain.SandboxPolicy{
		FSReadWrite:   []string{projA},
		Network:       domain.NetworkDeny,
		RequiredLevel: domain.EnforceRequired,
	}

	sh := "/bin/sh"
	if p, err := exec.LookPath("sh"); err == nil {
		sh = p
	}

	// C1: writes inside the read-write grant are allowed.
	t.Run("C1_write_in_grant_allowed", func(t *testing.T) {
		out := filepath.Join(projA, "out.txt")
		h, err := l.Launch(ctx, policy, domain.CommandSpec{
			Path: sh,
			Args: []string{"-c", "echo ok > " + out},
			Dir:  projA,
		})
		if err != nil {
			t.Fatalf("Launch() error = %v", err)
		}
		if err := h.Wait(); err != nil {
			t.Fatalf("Wait() error = %v; stderr=%s", err, output(t, h))
		}
		data, err := os.ReadFile(out)
		if err != nil {
			t.Fatalf("read %s: %v", out, err)
		}
		if strings.TrimSpace(string(data)) != "ok" {
			t.Fatalf("out.txt = %q, want ok", data)
		}
	})

	// C2: a sibling project's file is invisible to the sandboxed child.
	t.Run("C2_read_outside_grant_denied", func(t *testing.T) {
		h, err := l.Launch(ctx, policy, domain.CommandSpec{
			Path: sh,
			Args: []string{"-c", "cat " + secretPath},
			Dir:  projA,
		})
		if err != nil {
			t.Fatalf("Launch() error = %v", err)
		}
		err = h.Wait()
		if err == nil {
			t.Fatalf("reading another project's file succeeded; output=%s", output(t, h))
		}
		if code := exitCode(t, h); code == 0 {
			t.Fatalf("exit code = 0, want non-zero (err=%v)", err)
		}
		if combined := output(t, h); strings.Contains(combined, secretValue) {
			t.Fatalf("secret leaked into sandboxed output: %s", combined)
		} else {
			t.Logf("denied as expected (exit %d): %s", exitCode(t, h), strings.TrimSpace(combined))
		}
	})

	// C6: outbound network is denied.
	t.Run("C6_network_denied", func(t *testing.T) {
		curl, err := exec.LookPath("curl")
		if err != nil {
			t.Skipf("curl not installed: %v", err)
		}
		if !caps.Network {
			t.Skipf("nono reports no verified Landlock TCP support on this host: %q", caps.Notes)
		}
		h, err := l.Launch(ctx, policy, domain.CommandSpec{
			Path: curl,
			Args: []string{"-sS", "--max-time", "5", "https://example.com"},
			Dir:  projA,
		})
		if err != nil {
			t.Fatalf("Launch() error = %v", err)
		}
		if err := h.Wait(); err == nil {
			t.Fatalf("network egress succeeded under --block-net; output=%s", output(t, h))
		} else {
			t.Logf("egress denied as expected: %v (%s)", err, strings.TrimSpace(output(t, h)))
		}
	})

	// The launcher process itself must be untouched: Landlock applies to the
	// child only (communication-spec/05 "NEVER install irreversible Landlock
	// restrictions in the main API/worker Go process").
	t.Run("C11_parent_unrestricted", func(t *testing.T) {
		data, err := os.ReadFile(secretPath)
		if err != nil {
			t.Fatalf("test process could not read %s after sandboxed runs (restriction leaked into the parent): %v", secretPath, err)
		}
		if !strings.Contains(string(data), secretValue) {
			t.Fatalf("test process read %q, want the fixture marker", data)
		}
	})
}

func output(t *testing.T, h domain.ProcessHandle) string {
	t.Helper()
	p, ok := h.(*Process)
	if !ok {
		return "<output not captured>"
	}
	return p.Stdout() + p.Stderr()
}

func exitCode(t *testing.T, h domain.ProcessHandle) int {
	t.Helper()
	p, ok := h.(*Process)
	if !ok {
		return -1
	}
	return p.ExitCode()
}
