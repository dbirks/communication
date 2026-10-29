package nono

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

// nono 0.81.0 was released; the pinned 0.80.0 binary prints a release notice to
// STDERR in front of every command's output:
//
//	  update 0.81.0 available (current: 0.80.0)
//	  $ cargo install nono-cli
//	  https://github.com/always-further/nono/releases/tag/v0.81.0
//
// Measured on /tmp/nono-bin/nono (0.80.0):
//
//	$ HOME=<launcher> nono audit list --json 2>/dev/null      →  []
//	$ HOME=<launcher> nono audit list --json 2>&1 1>/dev/null →  the three lines
//
// Reading the two streams as one blob therefore broke the worker's real egress
// audit — `invalid character 'u' looking for beginning of value` — every time
// nono announced a release. These tests pin the contract with a fake nono that
// reproduces the notice verbatim, with no kernel and no real binary involved.

// updateNoticeLines is the notice byte for byte as 0.80.0 emits it (the leading
// two spaces are nono's own indentation).
const updateNoticeLines = `  update 0.81.0 available (current: 0.80.0)
  $ cargo install nono-cli
  https://github.com/always-further/nono/releases/tag/v0.81.0`

// fakeNonoWithUpdateNotice answers every surface the adapter parses and prints
// the release notice on stderr FIRST, like the pinned binary does once a newer
// release is cached. The `audit list` row also echoes back the two opt-out
// variables it was launched with (as argv entries, so they arrive inside the
// JSON the adapter parses), which is how the launcher-env test proves the
// variables reach nono without writing anything to disk.
const fakeNonoWithUpdateNotice = `
notice() { printf '%s\n' '  update 0.81.0 available (current: 0.80.0)' '  $ cargo install nono-cli' '  https://github.com/always-further/nono/releases/tag/v0.81.0' >&2; }
case "$1 ${2:-}" in
  "--version ")
    notice
    echo "nono 0.80.0"
    exit 0 ;;
  "setup --check-only")
    notice
    echo "[2/4] Testing sandbox support..."
    echo "  * Landlock V6"
    echo "  * Linux AF_UNIX mediation: off by default"
    echo "  * Filesystem ruleset creation verified"
    echo "  * TCP network rule support verified"
    exit 0 ;;
  "audit list")
    notice
    printf '[{"session_id":"old000000000001","command":["env","COMMUNICATION_ATTEMPT_ID=someone-elses","node","adapter.js"]},{"session_id":"run000000000002","command":["env","COMMUNICATION_ATTEMPT_ID=attempt-1","nono_update_check=%s","nono_pack_hints=%s","HOME=/w/home","node","adapter.js"]}]\n' "${NONO_NO_UPDATE_CHECK:-unset}" "${NONO_NO_PACK_UPDATE_HINTS:-unset}"
    exit 0 ;;
  "audit show")
    notice
    echo '{"session_id":"'"$3"'","network_events":[` +
		`{"decision":"allow","mode":"connect","target":"api.anthropic.com","port":443,"method":"CONNECT"},` +
		`{"decision":"deny","mode":"connect","denial_category":"host_denied","target":"example.org","port":443,"reason":"host example.org:443 is not in the allowlist"}]}'
    exit 0 ;;
  "profile show")
    notice
    echo "nono profile: profile 'communication-agent-turn'"
    echo "  Linux AF_UNIX mediation: pathname"
    exit 0 ;;
esac
exit 7
`

func newNoticeLauncher(t *testing.T) *Launcher {
	t.Helper()
	return &Launcher{Binary: writeFake(t, fakeNonoWithUpdateNotice), Home: t.TempDir()}
}

// TestEgressAuditReadsSurviveTheUpdateNotice is the product bug: with a newer
// release published, every real worker's egress audit read died on the notice
// standing in front of the document.
func TestEgressAuditReadsSurviveTheUpdateNotice(t *testing.T) {
	l := newNoticeLauncher(t)
	ctx := context.Background()

	sessionID, err := l.FindSessionByMarker(ctx, "COMMUNICATION_ATTEMPT_ID=attempt-1")
	if err != nil {
		t.Fatalf("FindSessionByMarker with the notice on stderr: %v", err)
	}
	if sessionID != "run000000000002" {
		t.Fatalf("session = %q, want the marker's own session", sessionID)
	}

	obs, err := l.AuditSession(ctx, sessionID)
	if err != nil {
		t.Fatalf("AuditSession with the notice on stderr: %v", err)
	}
	if obs.Allows != 1 || len(obs.Denials) != 1 {
		t.Fatalf("allows=%d denials=%d, want 1/1 (%+v)", obs.Allows, len(obs.Denials), obs.Denials)
	}
	if got := strings.Join(obs.DeniedHosts(), ","); got != "example.org" {
		t.Errorf("denied hosts = %q, want example.org", got)
	}

	// And the combined end-of-turn read the worker actually calls.
	obs, err = l.AuditSessionEgress(ctx, "COMMUNICATION_ATTEMPT_ID=attempt-1")
	if err != nil {
		t.Fatalf("AuditSessionEgress with the notice on stderr: %v", err)
	}
	if obs.SessionID != sessionID || len(obs.Denials) != 1 {
		t.Fatalf("observation = %+v, want session %s with its one denial", obs, sessionID)
	}
}

// TestLauncherEnvOptsOutOfTheUpdateNotice is the belt-and-braces half: the
// adapter no longer reads a contaminated blob, and it also asks nono not to
// contaminate it. Both variables are nono's own, observed in the pinned
// binary's string table next to its `update-check.json` cache, its
// `pack-update-hints.json` cache and its CI-detection list (`GITHUB_ACTIONS`,
// `GITLAB_CI`, … `CIgeneric`, `NONO_NO_UPDATE_CHECK`), and measured live: with
// the variable set, `nono audit list --json` prints the document on stdout and
// nothing on stderr.
func TestLauncherEnvOptsOutOfTheUpdateNotice(t *testing.T) {
	l := newNoticeLauncher(t)
	out, err := l.run(context.Background(), egressAuditTimeout, "", l.launcherEnv(LaunchSpec{}),
		l.Binary, "audit", "list", "--json", "--recent", "50")
	if err != nil {
		t.Fatalf("audit list: %v (%s)", err, out.ErrLine())
	}
	var entries []auditListingEntry
	if err := json.Unmarshal([]byte(out.Machine()), &entries); err != nil {
		t.Fatalf("audit listing is not JSON: %v (stderr %q)", err, out.stderr)
	}
	want := []string{"nono_update_check=1", "nono_pack_hints=1"}
	for _, w := range want {
		found := false
		for _, e := range entries {
			for _, arg := range e.Command {
				if arg == w {
					found = true
				}
			}
		}
		if !found {
			t.Errorf("launcherEnv did not deliver %q to nono: %s", w, out.Machine())
		}
	}

	// The self-test / TCP-probe environment carries the same opt-out, and the
	// doctor path (no configured home) inherits and opts out too.
	for name, env := range map[string][]string{
		"nonoEnv":     nonoEnv(l),
		"launcherEnv": l.launcherEnv(LaunchSpec{}),
		"inherit":     (&Launcher{}).launcherEnv(LaunchSpec{}),
	} {
		for _, kv := range []string{"NONO_NO_UPDATE_CHECK=1", "NONO_NO_PACK_UPDATE_HINTS=1"} {
			if !containsEnv(env, kv) {
				t.Errorf("%s lost %s (belt and braces): %v", name, kv, briefEnv(env))
			}
		}
	}
}

func containsEnv(env []string, want string) bool {
	for _, kv := range env {
		if kv == want {
			return true
		}
	}
	return false
}

// briefEnv keeps a failure message about an environment readable when that
// environment is the inherited one (which can be long).
func briefEnv(env []string) []string {
	var out []string
	for _, kv := range env {
		if strings.HasPrefix(kv, "NONO_") || strings.HasPrefix(kv, "PATH=") || strings.HasPrefix(kv, "HOME=") {
			out = append(out, kv)
		}
	}
	return out
}

// TestProbeReadsMachineOutputFromStdoutOnly covers the version and
// setup --check-only parses: the notice must not become the version, and the
// capability verdict must come from the report.
func TestProbeReadsMachineOutputFromStdoutOnly(t *testing.T) {
	l := newNoticeLauncher(t)
	caps, err := l.Probe(context.Background())
	if err != nil {
		t.Fatalf("Probe with the notice on stderr: %v", err)
	}
	if caps.Version != "0.80.0" {
		t.Errorf("version = %q, want 0.80.0 (the notice must not parse as a version)", caps.Version)
	}
	if !caps.Filesystem || !caps.Network {
		t.Errorf("filesystem=%v network=%v, want the check report's verdicts (notes: %v)", caps.Filesystem, caps.Network, caps.Notes)
	}
	joined := strings.Join(caps.Notes, "; ")
	if !strings.Contains(joined, "Landlock ABI v6") {
		t.Errorf("notes lost the ABI line: %q", joined)
	}
	if strings.Contains(joined, "0.81.0") || strings.Contains(joined, "cargo install") {
		t.Errorf("notes swallowed the update notice: %q", joined)
	}
}

// TestErrorsQuoteNonosComplaintNotItsNotice keeps a refusal readable: with the
// old combined read, an error quoted the release notice for a command that
// failed for a different reason entirely.
func TestErrorsQuoteNonosComplaintNotItsNotice(t *testing.T) {
	body := "printf '  update 0.81.0 available (current: 0.80.0)\\n  $ cargo install nono-cli\\n  https://github.com/always-further/nono/releases/tag/v0.81.0\\n' >&2\n" +
		"echo '' >&2\n" +
		"printf '\\033[2m2026-10-29T19:45:15.306762Z\\033[0m \\033[32m INFO\\033[0m Using built-in profile: default\\n' >&2\n" +
		"echo 'nono: Session not found: nope' >&2\n" +
		"exit 1\n"
	l := &Launcher{Binary: writeFake(t, body), Home: t.TempDir()}
	_, err := l.AuditSession(context.Background(), "run000000000002")
	if err == nil {
		t.Fatal("a failing audit show returned no error")
	}
	if !strings.Contains(err.Error(), "Session not found") {
		t.Errorf("error does not carry nono's own complaint: %v", err)
	}
	for _, noise := range []string{"update 0.81.0 available", "cargo install", "INFO"} {
		if strings.Contains(err.Error(), noise) {
			t.Errorf("error quoted %q instead of the failure: %v", noise, err)
		}
	}
}

// TestParseGrantsIgnoresTheNoticeAndStillSeesTheStderrTable documents the one
// surface that is NOT stdout: measured, the verbose dry-run prints its whole rule
// table on stderr and nothing on stdout, so N-d must keep reading both streams —
// and the notice must not be mistaken for a grant.
func TestParseGrantsIgnoresTheNoticeAndStillSeesTheStderrTable(t *testing.T) {
	dryRun := "  nono v0.80.0\n" + updateNoticeLines + "\n" +
		"  Capabilities:\n  ------------------------------------------------------------\n" +
		"   r   /usr/bin (dir) [group:system_read_linux_core]\n" +
		"  r+w  /workspace/work (dir) [user]\n" +
		"  r+w  /workspace/home (dir) [user]\n" +
		"   net  outbound allowed\n"
	grants, err := parseGrants(dryRun)
	if err != nil {
		t.Fatalf("parseGrants on a dry-run table carrying the release notice: %v", err)
	}
	user := 0
	for _, g := range grants {
		if g.source == sourceUser {
			user++
		}
		if strings.Contains(g.path, "releases") || strings.Contains(g.path, "cargo") {
			t.Errorf("the update notice was parsed as a grant: %+v", g)
		}
	}
	if user != 2 {
		t.Fatalf("user grants = %d from %d rules, want 2: %+v", user, len(grants), grants)
	}
}

// TestTCPProbeClassifiesTheChildNotTheChatter is the same rule on the TCP leg:
// the child's marker is read from stdout, so stderr noise — including a notice —
// cannot turn a reachable network into a seccomp finding, or hide one.
func TestTCPProbeClassifiesTheChildNotTheChatter(t *testing.T) {
	classification, errno, ok := ClassifyTCPProbeOutput(tcpProbeOKMarker+"\n", nil)
	if classification != TCPProbeOK || !ok || errno != "" {
		t.Fatalf("classification = %q/%q/%v, want ok on the child's own marker", classification, errno, ok)
	}
	if c, _, ok := ClassifyTCPProbeOutput(updateNoticeLines+"\n", nil); ok || c != TCPProbeOther {
		t.Fatalf("notice-only output classified as %q/%v, want other/not-ok", c, ok)
	}
}

// TestAFUnixMediationReadsProfileShowStdout covers N-c's parse the same way, and
// checks the fake is honest about which stream is which.
func TestAFUnixMediationReadsProfileShowStdout(t *testing.T) {
	l := newNoticeLauncher(t)
	out, err := l.run(context.Background(), probeTimeout, "", l.launcherEnv(LaunchSpec{}), l.Binary, "profile", "show", "/does/not/matter.toml")
	if err != nil {
		t.Fatalf("profile show: %v", err)
	}
	mediation, ok := afUnixMediation(out.Machine())
	if !ok || mediation != "pathname" {
		t.Fatalf("mediation = %q/%v from stdout, want pathname", mediation, ok)
	}
	if strings.Contains(out.Machine(), "0.81.0") {
		t.Error("the release notice arrived on stdout: the fake is lying about nono's streams")
	}
	if !strings.Contains(out.stderr, "0.81.0") {
		t.Error("the fake did not print the notice on stderr at all")
	}
}
