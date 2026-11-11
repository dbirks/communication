package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/dbirks/communication/internal/domain"
	"github.com/dbirks/communication/internal/sandbox/k8s"
	"github.com/dbirks/communication/internal/sandbox/nono"
)

// podSandboxProber is the slice of `nono.Launcher` the in-pod gate uses. It is an
// interface for the same reason the worker's own gate is testable: the verdict
// logic must be checkable without a kernel that enforces anything.
type podSandboxProber interface {
	Probe(ctx context.Context) (domain.SandboxCapabilities, error)
	SelfTest(ctx context.Context, scratchRoot string, timeout time.Duration) (nono.SelfTestResult, error)
	TCPConnectSelfTest(ctx context.Context, scratchRoot string, timeout time.Duration) (nono.TCPProbeResult, error)
}

// runPodVerify is the in-pod half of ADR-0082 Decision 3. The worker execs it in
// an attempt pod and refuses the session unless the answer is "enforced", so the
// pod reports exactly the two facts the worker's own startup gate reports — a real
// child was denied a write, and a real TCP connect completed under the agent
// profile — as ONE machine-readable line.
//
// The output contract is narrow on purpose: stdout carries the single JSON line
// (k8s.Verdict) and nothing else; anything that must be said to a human goes to
// stderr, where the worker's exec does not look for a verdict. Exit 0 means the
// verdict passed k8s.Verdict.Check, so `kubectl exec` alone tells an operator
// whether this pod may host a turn.
func runPodVerify(stdout, stderr io.Writer) int {
	home := strings.TrimSpace(os.Getenv("COMMUNICATION_SANDBOX_HOME"))
	scratch := strings.TrimSpace(os.Getenv("COMMUNICATION_SANDBOX_SELFTEST_DIR"))
	if scratch == "" {
		base, err := os.MkdirTemp("", "communication-pod-verify-")
		if err != nil {
			fmt.Fprintf(stderr, "pod-verify: no scratch root: %v\n", err)
			return writeVerdict(stdout, k8s.Verdict{Detail: "no scratch root: " + err.Error()})
		}
		defer func() { _ = os.RemoveAll(base) }()
		scratch = filepath.Join(base, "scratch")
	}
	v := podVerify(context.Background(), &nono.Launcher{Binary: nonoPath(), Home: home}, scratch, 30*time.Second, stderr)
	return writeVerdict(stdout, v)
}

// writeVerdict prints the one line and maps the verdict onto an exit code.
func writeVerdict(stdout io.Writer, v k8s.Verdict) int {
	if _, err := stdout.Write(k8s.MarshalVerdict(v)); err != nil {
		return 1
	}
	if err := v.Check(); err != nil {
		return 1
	}
	return 0
}

// podVerify runs the same enforcement observations the worker's startup gate runs
// (cmd/communication/worker.go's `required` block: Probe → SelfTest →
// TCPConnectSelfTest) and folds them into the verdict the worker will credit.
//
// The fail-closed rules it carries over:
//   - a probe that cannot run, or that reports no Landlock filesystem support, is
//     a refusal (worker.go's `required` mode refuses to start on the same thing);
//   - the filesystem leg must OBSERVE a denial, not infer one — `SelfTest` is the
//     only thing here that proves a child could not write;
//   - the TCP leg withholds rather than weakens: only the measured `ok`
//     classification sets TCP, and EPERM/other are reported verbatim in Detail
//     (docs/compatibility/SANDBOX.md is full of shapes that looked like success).
func podVerify(ctx context.Context, p podSandboxProber, scratch string, timeout time.Duration, stderr io.Writer) k8s.Verdict {
	v := k8s.Verdict{}
	if p == nil {
		v.Detail = "no sandbox backend to probe"
		return v
	}
	if err := os.MkdirAll(scratch, 0o700); err != nil {
		v.Detail = "sandbox self-test scratch " + scratch + ": " + err.Error()
		return v
	}
	caps, err := p.Probe(ctx)
	if err != nil {
		v.Detail = "sandbox probe: " + err.Error()
		return v
	}
	v.LandlockABI = landlockABI(caps.Notes)
	if !caps.Filesystem {
		v.Detail = "probe reports no Landlock filesystem support: " + strings.Join(caps.Notes, "; ")
		return v
	}
	observed, err := p.SelfTest(ctx, scratch, timeout)
	if err != nil {
		v.Detail = "sandbox enforcement self-test: " + err.Error()
		return v
	}
	if !observed.FilesystemLive {
		v.Detail = "sandbox enforcement self-test did not observe a live denial"
		return v
	}
	tcp, err := p.TCPConnectSelfTest(ctx, scratch, timeout)
	if err != nil {
		v.Detail = "agent-turn TCP probe could not run: " + err.Error()
		return v
	}
	v.TCP = tcp.OK && tcp.Classification == nono.TCPProbeOK
	if !v.TCP {
		// Reported, never classified away — the worker's own gate logs the same
		// three shapes and withholds agent turns for each.
		v.Detail = "agent-turn TCP probe: classification=" + tcp.Classification + " errno=" + tcp.Errno + " detail=" + boundedOneLine(tcp.Detail)
		return v
	}
	v.Verified = true
	v.Detail = fmt.Sprintf("nono %s; landlock abi v%d; filesystem denial observed; tcp ok", caps.Version, v.LandlockABI)
	return v
}

// landlockABIs is the note the probe writes ("Landlock ABI v6 reported by nono
// setup --check-only", internal/sandbox/nono/launcher.go) — the only place our
// code records the kernel's ABI number.
var landlockABIs = regexp.MustCompile(`Landlock ABI v(\d+)`)

// landlockABI reads the ABI number back out of the probe's notes. Zero means the
// probe never named one, which k8s.Verdict.Check refuses.
func landlockABI(notes []string) int {
	for _, n := range notes {
		m := landlockABIs.FindStringSubmatch(n)
		if m == nil {
			continue
		}
		code := 0
		for _, r := range m[1] {
			code = code*10 + int(r-'0')
		}
		return code
	}
	return 0
}

// boundedOneLine keeps a backend's verbatim detail on the verdict's single line
// and out of the JSON's structure.
func boundedOneLine(s string) string {
	s = strings.Join(strings.Fields(s), " ")
	if len(s) > 400 {
		return s[:400] + "…"
	}
	return s
}
