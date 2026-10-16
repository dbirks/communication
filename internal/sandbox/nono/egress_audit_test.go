package nono

import (
	"context"
	"strings"
	"testing"
	"time"
)

// fakeAudit is the measured nono 0.80.0 audit surface: `audit list --json`
// records the child's full argv (including the `env` hop's KEY=VALUE entries),
// and `audit show <id> --json` carries the network_events the design document
// quotes verbatim.
const fakeAudit = `case "$1 $2" in
  "audit list")
    echo '[{"session_id":"old000000000001","command":["env","COMMUNICATION_ATTEMPT_ID=someone-elses","node","adapter.js"]},` +
	`{"session_id":"run000000000002","command":["env","COMMUNICATION_ATTEMPT_ID=attempt-1","node","adapter.js"]}]'
    exit 0 ;;
  "audit show")
    echo '{"session_id":"'"$3"'","network_events":[` +
	`{"decision":"allow","mode":"connect","target":"api.anthropic.com","port":443,"method":"CONNECT"},` +
	`{"decision":"deny","mode":"connect","denial_category":"host_denied","target":"example.org","port":443,"reason":"host example.org:443 is not in the allowlist"}]}'
    exit 0 ;;
esac
exit 7
`

// TestAuditSessionEgressIsScopedToItsOwnRun is design A's read side: the audit
// a turn may cite is the one its OWN launch produced, found by the marker in the
// argv it already carried — never the newest session in the journal, which on a
// busy worker is some other run's denials.
func TestAuditSessionEgressIsScopedToItsOwnRun(t *testing.T) {
	l := &Launcher{Binary: writeFake(t, fakeAudit), Home: t.TempDir()}
	obs, err := l.AuditSessionEgress(context.Background(), "COMMUNICATION_ATTEMPT_ID=attempt-1")
	if err != nil {
		t.Fatalf("AuditSessionEgress: %v", err)
	}
	if obs.SessionID != "run000000000002" {
		t.Fatalf("session = %q, want the one whose recorded command carried this launch's marker", obs.SessionID)
	}
	if obs.Allows != 1 || len(obs.Denials) != 1 {
		t.Fatalf("allows=%d denials=%d, want 1/1 from the measured document (%+v)", obs.Allows, len(obs.Denials), obs.Denials)
	}
	if got := strings.Join(obs.DeniedHosts(), ","); got != "example.org" {
		t.Errorf("denied hosts = %q, want example.org", got)
	}
}

// TestAuditSessionEgressRefusesAnUnattributableRun keeps the read fail-closed:
// no matching session is an error, not a quiet "no denials" a run could read as
// free egress — and definitely not another run's evidence.
func TestAuditSessionEgressRefusesAnUnattributableRun(t *testing.T) {
	l := &Launcher{Binary: writeFake(t, fakeAudit), Home: t.TempDir()}
	if _, err := l.AuditSessionEgress(context.Background(), "COMMUNICATION_ATTEMPT_ID=attempt-nobody"); err == nil {
		t.Fatal("accepted an audit the run cannot point at")
	}
	if _, err := l.AuditSessionEgress(context.Background(), ""); err == nil {
		t.Fatal("accepted an empty marker")
	}
	if _, err := l.AuditSession(context.Background(), " "); err == nil {
		t.Fatal("accepted an empty session id")
	}
}

// TestEgressAuditReadIsBounded proves the 2 s cap with a nono that never
// answers: the read is what costs time here, and a turn must not wait on it.
func TestEgressAuditReadIsBounded(t *testing.T) {
	// A busy loop rather than `sleep 30`: exec.CommandContext kills the process it
	// started, and a sleeping grandchild would keep the output pipe open past the
	// deadline — the hang we are bounding is nono itself not answering.
	script := `case "$1 $2" in
  "audit list") i=0; while [ $i -lt 100000000 ]; do i=$((i+1)); done; echo '[]' ;;
esac
exit 7
`
	l := &Launcher{Binary: writeFake(t, script), Home: t.TempDir()}
	start := time.Now()
	_, err := l.AuditSessionEgress(context.Background(), "COMMUNICATION_ATTEMPT_ID=attempt-1")
	elapsed := time.Since(start)
	if err == nil {
		t.Fatal("a hung nono audit list returned no error")
	}
	if elapsed > egressAuditTimeout+time.Second {
		t.Fatalf("audit read took %s; the audit surface may cost a label, never a turn", elapsed)
	}
}

// TestDeniedHostsAreHostnamesOnly is the privacy half of the event rule: the
// journal is browser-visible, so whatever nono recorded as a target, only the
// hostname leaves this package.
func TestDeniedHostsAreHostnamesOnly(t *testing.T) {
	obs := EgressObservation{Denials: []EgressDenial{
		{Target: "https://example.org/deep/path?a=b#c", Category: "host_denied"},
		{Target: "Example.ORG:8443", Category: "host_denied"},
		{Target: "user@[::1]:443", Category: "port_denied"},
		{Target: "93.184.216.34:443", Category: "port_denied"},
		{Target: "  ", Category: "host_denied"},
		{Target: "two words.example.com/x", Category: "host_denied"},
	}}
	got := obs.DeniedHosts()
	want := []string{"93.184.216.34", "example.org"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("denied hosts = %v, want %v (no scheme, port, path, query, fragment, userinfo or IPv6 literal, deduplicated and sorted)", got, want)
	}
	for _, h := range got {
		if strings.ContainsAny(h, "/?#:@") {
			t.Errorf("host %q is not a bare hostname", h)
		}
	}
}

func TestEgressHostOfShape(t *testing.T) {
	cases := map[string]string{
		"example.com":              "example.com",
		"example.com:443":          "example.com",
		"https://example.com/a":    "example.com",
		"http://u:p@x.example/p?q": "x.example",
		"[::1]:443":                "",
		"":                         "",
		".leading":                 "",
		"ok.example.com/":          "ok.example.com",
	}
	for in, want := range cases {
		if got := EgressHostOf(in); got != want {
			t.Errorf("EgressHostOf(%q) = %q, want %q", in, got, want)
		}
	}
}
