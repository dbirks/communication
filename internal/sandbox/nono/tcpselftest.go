package nono

// The agent-turn TCP-reachability self-test.
//
// Why this exists: the filesystem self-test (selftest.go) proves Landlock
// enforcement, and on a host that can enforce Landlock it passes. But the
// agent-turn profile (af_unix_mediation = "pathname") also installs
// seccomp-notify mediation of AF_UNIX connect, and nono's supervisor uses
// process inspection to decide each connect. On a node with Yama
// /proc/sys/kernel/yama/ptrace_scope = 2 the supervisor cannot inspect the
// child's sockaddr, so EVERY TCP connect from the child — including a
// localhost connect nono explicitly opened with --open-port — fails with
// EPERM, and the agent cannot reach its own API. Measured on a live Talos
// node (Talos v1.13.6, kernel 6.18.38-talos, Landlock V6, nono 0.80.0,
// ptrace_scope 2): anthropic fetch through nono's proxy and a direct
// 1.1.1.1:443 both EPERM under the agent profile, while the SAME profile
// with only af_unix_mediation removed behaves exactly as the lab measured
// (docs/compatibility/SANDBOX.md rows 8a/8b). The worker therefore has to
// probe this axis at startup, under the real agent profile, or it will
// spend minutes on an agent turn that dies "Unable to connect to API
// (EPERM)" and journal it as an infra error.
//
// The probe: the parent process opens a TCP listener on 127.0.0.1 (it is
// outside the sandbox and needs no grant), materializes the shipped
// agent-turn profile (WriteProfile, the same bytes the worker ships to
// /sandbox-policy/communication-agent.json), and launches a child through
// nono exactly as an agent turn launches: `nono run -s --profile
// <agent-profile> --open-port <port> -- node -e <connect script>`.
// Classification of the child's report:
//
//	connects             → ok (the --open-port grant works, turns can reach
//	                                localhost services the way a real turn
//	                                reaches them)
//	child errored EPERM  → seccomp-notify connect mediation unavailable
//	                     (AF_UNIX pathname mediation is refusing what the
//	                     supervisor cannot inspect — the agent API is
//	                     unreachable for every turn on this host)
//	anything else       → other, reported verbatim (a new failure shape
//	                                is a finding, not a guess)

import (
	"context"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Classifications of the agent-turn TCP-reachability probe.
const (
	// TCPProbeOK: the sandboxed child completed a localhost TCP connect that
	// nono opened with --open-port.
	TCPProbeOK = "ok"
	// TCPProbeEperm: the child's connect failed with EPERM. Under the
	// agent-turn profile this is seccomp-notify AF_UNIX mediation that
	// cannot inspect the child's connect (host kernel.yama.ptrace_scope > 1)
	// — every TCP connection from the child is impossible, agent or not.
	TCPProbeEperm = "seccomp-notify-connect-mediation-unavailable"
	// TCPProbeOther: the probe ran but reported something neither a connect
	// nor EPERM. It is reported verbatim by the caller, never classified away.
	TCPProbeOther = "other"
)

// TCPProbeResult is what the startup TCP-reachability probe observed. It is
// an observation, not an assumption: Detail is the child's combined output,
// verbatim (bounded), so a new failure shape reaches the log unchanged.
type TCPProbeResult struct {
	// Classification is TCPProbeOK, TCPProbeEperm or TCPProbeOther.
	Classification string
	// OK is true only for TCPProbeOK.
	OK bool
	// Errno is the error code the child observed (e.g. "EPERM", "TIMEOUT"),
	// empty when the connect succeeded.
	Errno string
	// Detail is the child's combined output, verbatim and bounded.
	Detail string
	// Port is the 127.0.0.1 port the probe listened on and opened.
	Port int
	// Profile is the agent-turn profile path the child launched under, and
	// ProfileDigest its content identity — the same profile a real turn runs.
	Profile       string
	ProfileDigest string
	ProbedAt      time.Time
}

// probeMarkers is the child's report protocol. The child prints exactly one
// marker line; the probe classifies that line, not the child's exit code,
// because nono's own exec failures (exit 126, refusals) are the "other"
// class this test exists to catch.
const (
	tcpProbeOKMarker    = "nono-tcp-ok"
	tcpProbeErrMarker   = "nono-tcp-err"
	tcpProbeDetailBound = 1024
)

// ClassifyTCPProbeOutput decides the classification from the child's own report
// (its STDOUT, as nonoOutput.Machine returns it — nono's stderr chatter must not
// be able to produce or hide a marker) and the exec result. It is pure so the
// decision is unit-testable with a fake launcher result: no kernel, no nono, no
// node involved.
//
// The rule is asymmetric on purpose: a successful probe must be corroborated
// by the child's own marker (a process that exited 0 without connecting says
// nothing), while a failed one is classified by the error code the child
// observed — EPERM is the finding, and anything else is passed through
// verbatim so the log carries the new shape instead of hiding it.
func ClassifyTCPProbeOutput(out string, err error) (classification, errno string, ok bool) {
	if strings.Contains(out, tcpProbeOKMarker) {
		return TCPProbeOK, "", true
	}
	code := extractProbeErrno(out)
	if code == "EPERM" {
		return TCPProbeEperm, code, false
	}
	return TCPProbeOther, code, false
}

// extractProbeErrno pulls the code after the child's error marker ("nono-tcp-err
// EPERM"). It returns "" when the child printed no marker line at all —
// e.g. nono itself refused to launch — which the caller keeps verbatim.
func extractProbeErrno(out string) string {
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, tcpProbeErrMarker) {
			fields := strings.Fields(line)
			if len(fields) >= 2 {
				return fields[1]
			}
			return ""
		}
	}
	return ""
}

// boundDetail caps the verbatim output the result carries: a log line is a
// report, not a paste.
func boundDetail(out string) string {
	s := strings.TrimSpace(out)
	if len(s) > tcpProbeDetailBound {
		return s[:tcpProbeDetailBound] + "…"
	}
	return s
}

// TCPConnectSelfTest runs the agent-turn TCP-reachability probe described
// above. scratchRoot must not be under $HOME (nono's state root derives from
// HOME and a grant overlapping it is refused permanently — the same C-H1
// guard the filesystem self-test applies) and must not be nono's own home
// for this launcher.
func (l *Launcher) TCPConnectSelfTest(ctx context.Context, scratchRoot string, timeout time.Duration) (TCPProbeResult, error) {
	res := TCPProbeResult{ProbedAt: time.Now().UTC()}
	if scratchRoot == "" {
		return res, fmt.Errorf("sandbox: TCP probe needs a scratch root that is not nono's home")
	}
	if err := refuseNonoStateRoot(scratchRoot); err != nil {
		return res, err
	}
	bin, err := l.resolveBinary()
	if err != nil {
		return res, err
	}
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	// The child is the same interpreter the agent-turn image ships (node:22
	// base, worker/Dockerfile) — the probe must run under the program a real
	// turn would run, because seccomp-notify sees the child it execs.
	nodeBin, err := exec.LookPath("node")
	if err != nil {
		return res, fmt.Errorf("sandbox: TCP probe needs node on PATH (the agent-turn image is node-based); the probe cannot claim what it cannot launch: %w", err)
	}
	dir, err := os.MkdirTemp(scratchRoot, "nono-tcp-selftest-")
	if err != nil {
		return res, fmt.Errorf("sandbox: TCP probe scratch under %s: %w", scratchRoot, err)
	}
	defer func() { _ = os.RemoveAll(dir) }()
	// The shipped agent-turn profile, canonical bytes: af_unix_mediation =
	// "pathname", sandbox_policy = landlock, egress allowlisted through
	// nono's proxy. This is the profile a real agent turn launches under,
	// written with the same writer (WriteProfile) that the worker uses.
	profile, err := WriteProfile(dir, ProfileAgentTurn)
	if err != nil {
		return res, fmt.Errorf("sandbox: TCP probe could not materialize the agent-turn profile: %w", err)
	}
	res.Profile = profile.Path
	res.ProfileDigest = profile.Digest
	// The parent's listener, outside the sandbox.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return res, fmt.Errorf("sandbox: TCP probe listener on 127.0.0.1: %w", err)
	}
	defer func() { _ = ln.Close() }()
	res.Port = ln.Addr().(*net.TCPAddr).Port
	// Accept what the child sends so a successful probe is observed by both
	// ends (backlog would complete the handshake either way; the accept is
	// the parent's half of the proof).
	accepted := make(chan struct{})
	go func() {
		defer close(accepted)
		c, err := ln.Accept()
		if err == nil {
			_ = c.Close()
		}
	}()
	// The child connects and reports. It is exec'd directly by nono (no env
	// hop: the marker is the observation, and the probe must not inherit the
	// worker's environment the way nonoEnv keeps it out).
	script := "const n=require('net'),s=n.connect(" + strconv.Itoa(res.Port) + ",'127.0.0.1');" +
		"s.setTimeout(8000);" +
		"s.on('connect',()=>{console.log('" + tcpProbeOKMarker + "');process.exit(0)});" +
		"s.on('timeout',()=>{console.log('" + tcpProbeErrMarker + " TIMEOUT');process.exit(2)});" +
		"s.on('error',e=>{console.log('" + tcpProbeErrMarker + " '+(e.code||String(e)));process.exit(1)});"
	argv := []string{bin, "run", "-s", "--profile", profile.Path,
		"--allow", dir,
		"--read", filepath.Dir(nodeBin),
		"--open-port", strconv.Itoa(res.Port),
		"--", nodeBin, "-e", script}
	out, err := l.run(ctx, timeout, dir, nonoEnv(l), argv...)
	// The child's marker arrives on stdout; nono's chatter (banner, tracing,
	// release notice) is stderr, so the classification reads stdout and cannot be
	// steered by a notice, while Detail keeps both streams verbatim for the log.
	res.Classification, res.Errno, res.OK = ClassifyTCPProbeOutput(out.Machine(), err)
	res.Detail = boundDetail(out.Text())
	if res.Classification == TCPProbeOK {
		// The marker proves the connect; the parent's accept is the second
		// witness. A race that missed it is an environment fact, and the
		// parent must not turn a real connect into a fabricated failure —
		// but it must not pretend either, so wait briefly and report.
		select {
		case <-accepted:
		case <-time.After(500 * time.Millisecond):
		}
	}
	return res, nil
}
