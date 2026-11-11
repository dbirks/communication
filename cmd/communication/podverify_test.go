package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/dbirks/communication/internal/domain"
	"github.com/dbirks/communication/internal/sandbox/k8s"
	"github.com/dbirks/communication/internal/sandbox/nono"
)

// The in-pod gate is the only thing standing between a Kubernetes-mode worker and
// an ACP session in a pod it never proved (ADR-0082 Decision 3, ADR-0019 D6), so
// these tests drive it with a fake backend rather than a kernel: what is under
// test is the decision, not Landlock.

type fakeProber struct {
	caps  domain.SandboxCapabilities
	capsE error
	self  nono.SelfTestResult
	selfE error
	tcp   nono.TCPProbeResult
	tcpE  error
	// calls records which legs ran: a leg that refuses must short-circuit the rest.
	calls []string
}

func (f *fakeProber) Probe(context.Context) (domain.SandboxCapabilities, error) {
	f.calls = append(f.calls, "probe")
	return f.caps, f.capsE
}

func (f *fakeProber) SelfTest(_ context.Context, _ string, _ time.Duration) (nono.SelfTestResult, error) {
	f.calls = append(f.calls, "selftest")
	return f.self, f.selfE
}

func (f *fakeProber) TCPConnectSelfTest(_ context.Context, _ string, _ time.Duration) (nono.TCPProbeResult, error) {
	f.calls = append(f.calls, "tcp")
	return f.tcp, f.tcpE
}

func enforcingCaps() domain.SandboxCapabilities {
	return domain.SandboxCapabilities{
		Backend:    "nono",
		Version:    "0.80.0",
		Filesystem: true,
		Network:    true,
		Notes:      []string{"Landlock ABI v6 reported by nono setup --check-only", "not verified"},
	}
}

func TestPodVerifyReportsTheEnforcementItObserved(t *testing.T) {
	p := &fakeProber{
		caps: enforcingCaps(),
		self: nono.SelfTestResult{Backend: "nono", Version: "0.80.0", FilesystemLive: true},
		tcp:  nono.TCPProbeResult{OK: true, Classification: nono.TCPProbeOK},
	}
	v := podVerify(context.Background(), p, t.TempDir()+"/scratch", time.Second, io.Discard)
	if !v.Verified || !v.TCP || v.LandlockABI != 6 {
		t.Errorf("verdict = %+v, want verified with ABI 6 and tcp", v)
	}
	if err := v.Check(); err != nil {
		t.Errorf("the worker must credit this pod: %v", err)
	}
	if strings.Join(p.calls, ",") != "probe,selftest,tcp" {
		t.Errorf("legs = %v, want all three", p.calls)
	}
}

func TestPodVerifyRefusesEveryUnprovenShape(t *testing.T) {
	live := nono.SelfTestResult{FilesystemLive: true}
	okTCP := nono.TCPProbeResult{OK: true, Classification: nono.TCPProbeOK}
	for _, tc := range []struct {
		name   string
		prober *fakeProber
		want   string
		legs   string
	}{
		{
			name:   "no backend",
			prober: &fakeProber{capsE: errors.New("nono: executable file not found")},
			want:   "sandbox probe",
			legs:   "probe",
		},
		{
			name: "no landlock filesystem support",
			prober: &fakeProber{caps: domain.SandboxCapabilities{
				Backend: "nono", Notes: []string{"Landlock ABI v6 reported by nono setup --check-only"},
			}},
			want: "no Landlock filesystem support",
			legs: "probe",
		},
		{
			name:   "self-test refuses",
			prober: &fakeProber{caps: enforcingCaps(), selfE: nono.ErrNotEnforced},
			want:   "self-test",
			legs:   "probe,selftest",
		},
		{
			name:   "self-test observed no denial",
			prober: &fakeProber{caps: enforcingCaps(), self: nono.SelfTestResult{}},
			want:   "did not observe a live denial",
			legs:   "probe,selftest",
		},
		{
			name:   "tcp probe cannot run",
			prober: &fakeProber{caps: enforcingCaps(), self: live, tcpE: errors.New("scratch is nono's home")},
			want:   "could not run",
			legs:   "probe,selftest,tcp",
		},
		{
			name: "tcp eperm: the ptrace_scope finding",
			prober: &fakeProber{caps: enforcingCaps(), self: live, tcp: nono.TCPProbeResult{
				Classification: nono.TCPProbeEperm, Errno: "EPERM", Detail: "connect: operation not permitted",
			}},
			want: "EPERM",
			legs: "probe,selftest,tcp",
		},
		{
			name: "tcp reports an unmeasured shape",
			prober: &fakeProber{caps: enforcingCaps(), self: live, tcp: nono.TCPProbeResult{
				Classification: nono.TCPProbeOther, Detail: "exit 126",
			}},
			want: "classification=other",
			legs: "probe,selftest,tcp",
		},
		{
			name:   "an abi the probe never named",
			prober: &fakeProber{caps: domain.SandboxCapabilities{Backend: "nono", Filesystem: true}, self: live, tcp: okTCP},
			want:   "",
			legs:   "probe,selftest,tcp",
		},
	} {
		v := podVerify(context.Background(), tc.prober, t.TempDir()+"/scratch", time.Second, io.Discard)
		if err := v.Check(); err == nil {
			t.Errorf("%s: the worker credited a pod that did not prove enforcement: %+v", tc.name, v)
		}
		if tc.want != "" && !strings.Contains(v.Detail, tc.want) {
			t.Errorf("%s: detail %q does not carry %q", tc.name, v.Detail, tc.want)
		}
		if got := strings.Join(tc.prober.calls, ","); got != tc.legs {
			t.Errorf("%s: legs = %q, want %q (a refusal must short-circuit, an unrun probe must not be credited)", tc.name, got, tc.legs)
		}
		if v.Verified && tc.name != "an abi the probe never named" {
			t.Errorf("%s: Verified set on an unproven shape", tc.name)
		}
	}
}

func TestPodVerifyOutputIsOneJSONLine(t *testing.T) {
	for _, tc := range []struct {
		name     string
		prober   *fakeProber
		wantExit int
	}{
		{
			name:   "enforced",
			prober: &fakeProber{caps: enforcingCaps(), self: nono.SelfTestResult{FilesystemLive: true}, tcp: nono.TCPProbeResult{OK: true, Classification: nono.TCPProbeOK}},
		},
		{
			name:     "refused",
			prober:   &fakeProber{capsE: errors.New("nono missing")},
			wantExit: 1,
		},
	} {
		var out bytes.Buffer
		v := podVerify(context.Background(), tc.prober, t.TempDir()+"/scratch", time.Second, io.Discard)
		code := writeVerdict(&out, v)
		if code != tc.wantExit {
			t.Errorf("%s: exit = %d, want %d", tc.name, code, tc.wantExit)
		}
		line := out.String()
		if strings.Count(line, "\n") != 1 || !strings.HasSuffix(line, "\n") {
			t.Fatalf("%s: stdout is not exactly one line: %q", tc.name, line)
		}
		var parsed k8s.Verdict
		if err := json.Unmarshal([]byte(line), &parsed); err != nil {
			t.Fatalf("%s: stdout is not the verdict JSON: %v (%s)", tc.name, err, line)
		}
		if parsed.Verified != (tc.wantExit == 0) {
			t.Errorf("%s: verdict.Verified = %t for exit %d", tc.name, parsed.Verified, code)
		}
		// The keys the worker parses are the struct's; assert the shape, not just
		// that some JSON came out.
		var keys map[string]json.RawMessage
		if err := json.Unmarshal([]byte(line), &keys); err != nil {
			t.Fatalf("re-decode: %v", err)
		}
		for _, want := range []string{"verified", "landlock_abi", "tcp", "detail"} {
			if _, ok := keys[want]; !ok {
				t.Errorf("%s: verdict JSON has no %q key: %s", tc.name, want, line)
			}
		}
	}
}

func TestLandlockABIReadsTheProbeNote(t *testing.T) {
	if got := landlockABI([]string{"af_unix mediation is asserted", "Landlock ABI v4 reported by nono setup --check-only"}); got != 4 {
		t.Errorf("landlockABI = %d, want 4", got)
	}
	if got := landlockABI([]string{"no abi here"}); got != 0 {
		t.Errorf("landlockABI = %d, want 0 when the probe never said", got)
	}
}

// TestRunPodVerifyPrintsAVerdictOrRefuses drives the real mode function: on a host
// with no nono it must still print exactly one parseable line and exit non-zero.
// On a host that has nono the verdict may go either way, which is the point: the
// contract under test is the line and the code, not this machine's kernel.
func TestRunPodVerifyPrintsAVerdictOrRefuses(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("COMMUNICATION_SANDBOX_HOME", filepath.Join(dir, "launcher-home"))
	t.Setenv("COMMUNICATION_SANDBOX_SELFTEST_DIR", filepath.Join(dir, "scratch"))
	if err := os.MkdirAll(filepath.Join(dir, "launcher-home"), 0o700); err != nil {
		t.Fatal(err)
	}
	var stdout, stderr bytes.Buffer
	code := runPodVerify(&stdout, &stderr)
	line := stdout.String()
	if strings.Count(line, "\n") != 1 {
		t.Fatalf("stdout = %q, want exactly one line", line)
	}
	v, err := k8s.ParseVerdict([]byte(line))
	if err != nil {
		t.Fatalf("the mode's stdout is not a verdict: %v (%s)", err, line)
	}
	if matches := (v.Check() == nil); matches != (code == 0) {
		t.Errorf("exit %d disagrees with the verdict it printed (%+v)", code, v)
	}
	if code != 0 && stderr.String() == "" && v.Detail == "" {
		t.Error("a refusal must say why, somewhere")
	}
	if _, err := os.Stat(filepath.Join(dir, "scratch")); err != nil && code == 0 {
		t.Errorf("the scratch root is the configured one: %v", err)
	}
}

func TestPodVerifyScratchDefaultIsCleanedUp(t *testing.T) {
	// No COMMUNICATION_SANDBOX_SELFTEST_DIR: the mode makes its own scratch and
	// removes it, so a pod that ran the probe leaves no debris in the workspace.
	t.Setenv("COMMUNICATION_SANDBOX_SELFTEST_DIR", "")
	t.Setenv("COMMUNICATION_SANDBOX_HOME", t.TempDir())
	before, err := filepath.Glob(filepath.Join(os.TempDir(), "communication-pod-verify-*"))
	if err != nil {
		t.Fatal(err)
	}
	var stdout, stderr bytes.Buffer
	_ = runPodVerify(&stdout, &stderr)
	after, err := filepath.Glob(filepath.Join(os.TempDir(), "communication-pod-verify-*"))
	if err != nil {
		t.Fatal(err)
	}
	if len(after) > len(before) {
		t.Errorf("temp scratch left behind: %v -> %v", before, after)
	}
	if stdout.Len() == 0 {
		t.Error("no verdict printed")
	}
}
