package nono

import (
	"context"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

// The classifier is pure and is the decision a fake launcher result feeds
// the worker gate — no kernel, no nono, no node involved.
func TestClassifyTCPProbeOutput(t *testing.T) {
	cases := []struct {
		name      string
		out       string
		err       error
		want      string
		wantErrno string
		wantOK    bool
	}{
		{"ok marker", "nono-tcp-ok\n", nil, TCPProbeOK, "", true},
		{"ok marker with surrounding noise", "spurious banner\nnono-tcp-ok\ntrailing", nil, TCPProbeOK, "", true},
		{"eperm marker", "nono-tcp-err EPERM\n", errFake, TCPProbeEperm, "EPERM", false},
		{"econnrefused is other", "nono-tcp-err ECONNREFUSED\n", errFake, TCPProbeOther, "ECONNREFUSED", false},
		{"timeout is other", "nono-tcp-err TIMEOUT\n", errFake, TCPProbeOther, "TIMEOUT", false},
		{"no marker at all is other with no errno", "nono: profile rejected\n", errFake, TCPProbeOther, "", false},
		{"empty output is other", "", errFake, TCPProbeOther, "", false},
		{"exit zero without the marker is not ok", "child said nothing\n", nil, TCPProbeOther, "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, errno, ok := ClassifyTCPProbeOutput(tc.out, tc.err)
			if got != tc.want || errno != tc.wantErrno || ok != tc.wantOK {
				t.Fatalf("got (%q, %q, %v), want (%q, %q, %v)", got, errno, ok, tc.want, tc.wantErrno, tc.wantOK)
			}
		})
	}
}

var errFake = errTest{msg: "exit status 1"}

type errTest struct{ msg string }

func (e errTest) Error() string { return e.msg }

func TestBoundDetail(t *testing.T) {
	// Verbatim within the bound.
	if got := boundDetail("  nono-tcp-err EPERM\n"); got != "nono-tcp-err EPERM" {
		t.Fatalf("got %q", got)
	}
	// Bounded beyond it, with the marker still readable.
	long := "x\n" + tcpProbeErrMarker + " EPERM\n"
	for len(long) < tcpProbeDetailBound+64 {
		long += "noise noise noise noise noise noise noise noise noise\n"
	}
	got := boundDetail(long)
	if len(got) > tcpProbeDetailBound+3 { // +3: the "…" sentinel is 3 bytes
		t.Fatalf("detail not bounded: %d chars", len(got))
	}
	if got[:30] != long[:30] {
		t.Fatalf("verbatim prefix changed: %q", got[:30])
	}
}

// TestTCPConnectSelfTestRefusesHomeScratch asserts the C-H1 guard runs before
// any exec, so it needs no nono binary and is never skipped.
func TestTCPConnectSelfTestRefusesHomeScratch(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	l := &Launcher{}
	res, err := l.TCPConnectSelfTest(context.Background(), filepath.Join(home, "x"), time.Second)
	if err == nil {
		t.Fatal("expected the C-H1 refusal")
	}
	if res.Classification != "" {
		t.Fatalf("a refused probe must report nothing: %+v", res)
	}
	t.Logf("refused: %v", err)
}

// TestTCPConnectSelfTestOnRealNono runs the probe with the real binary and the
// real agent-turn profile. It must report ok on a host whose
// kernel.yama.ptrace_scope <= 1 (the lab's shape): the child completes the
// --open-port connect. Guarded like the filesystem self-test: skipped when no
// nono binary exists or when nono cannot establish a ruleset here.
func TestTCPConnectSelfTestOnRealNono(t *testing.T) {
	root, home := selftestScratch(t, "selftest-tcp")
	l := &Launcher{Home: home}
	requireRealNono(t, l)
	// The probe needs the node the agent-turn image ships.
	if _, err := exec.LookPath("node"); err != nil {
		t.Skipf("no node on PATH; the probe launches node: %v", err)
	}

	res, err := l.TCPConnectSelfTest(context.Background(), root, 60*time.Second)
	if err != nil {
		t.Fatalf("TCP probe: %v", err)
	}
	if !res.OK || res.Classification != TCPProbeOK {
		t.Fatalf("probe expected ok on this host (ptrace_scope <= 1), got %+v (detail: %s)", res, res.Detail)
	}
	if res.Port == 0 || res.Profile == "" || res.ProfileDigest == "" {
		t.Fatalf("result missing the probe identity: %+v", res)
	}
	t.Logf("ok: port=%d profile=%s digest=%s", res.Port, res.Profile, res.ProfileDigest)
}
