package worker

import (
	"context"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/dbirks/communication/internal/domain"
	"github.com/dbirks/communication/internal/events"
	"github.com/dbirks/communication/internal/sandbox/nono"
)

// The real-sandbox proof for process.exec: an actual nono 0.80.0 launch
// under the communication-command profile, on this host's Landlock. A mocked
// green unit test never substitutes for this (12-test-strategy.md): the
// question is not whether the code ASKS for --block-net but whether a
// sandboxed command can actually reach a socket. Skips require a missing
// precondition (binary, pinned version, observed Landlock support), never
// the outcome.

// realProcExec builds the fixture with the REAL launcher behind the seam and
// the boundary resolver wired (the § 4 step 3 seam in its wired shape).
func realProcExec(t *testing.T) *procExecFixture {
	t.Helper()
	bin, err := exec.LookPath("nono")
	if err != nil {
		t.Skipf("nono binary required for the real-sandbox run: %v", err)
	}
	launcher := &nono.Launcher{Binary: bin, Home: procExecScratch(t, "procexec-nono-launcher")}
	caps, err := launcher.Probe(context.Background())
	if err != nil {
		t.Skipf("nono probe: %v", err)
	}
	if caps.Version != nono.PinnedVersion {
		t.Skipf("nono %s pinned, host has %s", nono.PinnedVersion, caps.Version)
	}
	if !caps.Filesystem {
		t.Skipf("no observed Landlock filesystem support (%v): the § 0 rule is that nothing depends on a sandbox this host did not show", caps.Notes)
	}
	f := newProcExecFixture(t, domain.EnforceRequired)
	f.proc.Sandbox = launcher
	f.proc.SandboxPath = bin
	f.proc.Checkpoints = stubCheckpoints{}
	f.launcher = launcher
	return f
}

// TestProcExecUnderRealNonoWritesInsideAndCannotReachOutside: the command
// runs, writes INSIDE its granted workspace (the filesystem half is real,
// not a claim), and an outbound TCP connect to a listener on loopback is
// DENIED — the listener records zero accepts, and the attempt closes with
// the denial in detail (§ 4 step 5: a network-hungry command fails honestly;
// the profile is not widened).
func TestProcExecUnderRealNonoWritesInsideAndCannotReachOutside(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer func() { _ = ln.Close() }()
	accepts := make(chan struct{}, 1)
	go func() {
		c, err := ln.Accept()
		if err == nil {
			accepts <- struct{}{}
			_ = c.Close()
		}
	}()

	t.Run("filesystem grant: a write inside the workspace lands", func(t *testing.T) {
		f := realProcExec(t)
		outFile := filepath.Join(f.layout.Scratch, "made-by-the-command.txt")
		res, err := f.proc.Execute(context.Background(), f.claim(map[string]any{
			"argv": []any{"/bin/sh", "-c", "printf written > made-by-the-command.txt && cat made-by-the-command.txt"},
			"cwd":  f.layout.Scratch,
		}), f.sink)
		if err != nil {
			t.Fatalf("Execute: %v", err)
		}
		if res.Status != AttemptStatusSucceeded {
			t.Fatalf("the sandboxed write failed: %s / %s", res.Status, res.Detail)
		}
		if b, rerr := os.ReadFile(outFile); rerr != nil || string(b) != "written" {
			t.Errorf("capture file = %q, %v — the command succeeded but its write did not land", b, rerr)
		}
		var verified *events.SandboxVerifiedPayload
		for _, ev := range f.sink.events {
			if ev.Type == events.TypeSandboxVerified {
				p, _ := ev.Payload.(events.SandboxVerifiedPayload)
				verified = &p
			}
		}
		if verified == nil || !verified.NetworkEnforced || !verified.Verified {
			t.Fatalf("sandbox.verified missing or understating the launch: %+v", verified)
		}
		if verified.PolicyDigest == "" {
			t.Error("the verified launch recorded no policy digest")
		}
		t.Logf("egress-honesty record: network_enforced=%v policy=%s backend=%s/%s grants=%d",
			verified.NetworkEnforced, verified.PolicyDigest[:min(len(verified.PolicyDigest), 19)],
			verified.Backend, verified.BackendVersion, len(verified.Grants))
	})

	t.Run("egress denied: a loopback connect cannot happen", func(t *testing.T) {
		f := realProcExec(t)
		bash, berr := exec.LookPath("bash")
		if berr != nil {
			t.Skipf("bash required for the /dev/tcp probe: %v", berr)
		}
		host, port, _ := net.SplitHostPort(ln.Addr().String())
		// bash's /dev/tcp opens the connect with no helper binary; bash here
		// is the COMMAND being run, not a shell wrapping one (argv-only
		// forbids the executor from spawning a shell, not from running one).
		res, err := f.proc.Execute(context.Background(), f.claim(map[string]any{
			"argv": []any{bash, "-c", "exec 3<>/dev/tcp/" + host + "/" + port},
			"cwd":  f.layout.Scratch,
		}), f.sink)
		if err != nil {
			t.Fatalf("Execute: %v", err)
		}
		if res.Status == AttemptStatusSucceeded {
			t.Fatalf("egress SUCCEEDED under the egress-denied command profile (outcome %s) — the profile is lying", res.Outcome)
		}
		select {
		case <-accepts:
			t.Fatal("the listener ACCEPTED a connection from inside the sandbox — egress is not denied")
		case <-time.After(250 * time.Millisecond):
			// The honest silence: nothing got out.
		}
		t.Logf("denied as observed: class=%s detail=%s", res.ErrorClass, res.Detail)
		if res.Status != AttemptStatusFailed || res.ErrorClass != ErrorClassInfra {
			t.Fatalf("res = %+v, want failed/infra with the denial in detail (§ 4 step 5)", res)
		}
		if !strings.Contains(strings.ToLower(res.Detail), "denied") {
			t.Errorf("detail lost the denial: %s", res.Detail)
		}
	})
}

// TestProcExecUnderRealNonoDeadlineKillsTheGroup: the node-deadline arm on a
// real launch — the process group (nono supervisor and its sandboxed child)
// must be gone within the grace window, and the honest class is timeout
// (§ 4 step 7's third arm, observed on a real process).
func TestProcExecUnderRealNonoDeadlineKillsTheGroup(t *testing.T) {
	f := realProcExec(t)
	// Long enough for the N-a…N-d chain to finish (seconds of nono helper
	// calls) and the sleep to actually be running when the arm trips —
	// the test is about killing a LIVE process group, not about racing
	// verification.
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	start := time.Now()
	res, err := f.proc.Execute(ctx, f.claim(map[string]any{
		"argv": []any{"/bin/sleep", "30"},
	}), f.sink)
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if res.Status != AttemptStatusFailed || res.ErrorClass != ErrorClassTimeout {
		t.Fatalf("res = %+v, want failed/timeout for the deadline arm", res)
	}
	if d := time.Since(start); d > 10*time.Second {
		t.Errorf("group teardown under real nono took %s, not the grace window", d)
	}
}
