package nono

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

// TestAgentProfileAuthorsTheEgressAllowlist is design A's first half: the
// shipped agent-turn profile carries nono's proxy allowlist in the file, so the
// policy digest commits to a host set (ADR-0035 amending ADR-0019 D3).
func TestAgentProfileAuthorsTheEgressAllowlist(t *testing.T) {
	dir := t.TempDir()
	prof, err := WriteProfile(dir, ProfileAgentTurn)
	if err != nil {
		t.Fatalf("WriteProfile: %v", err)
	}
	if prof.NetworkEnforced != NetworkAllowlisted {
		t.Fatalf("profile claims %q, want %q", prof.NetworkEnforced, NetworkAllowlisted)
	}
	if strings.Join(prof.EgressHosts, ",") != strings.Join(DefaultEgressHosts(), ",") {
		t.Errorf("hosts = %v, want the shipped default %v", prof.EgressHosts, DefaultEgressHosts())
	}
	if err := prof.AssertOwnBytes(); err != nil {
		t.Fatalf("AssertOwnBytes: %v", err)
	}
	data, err := json.Marshal(readProfileMap(t, prof.Path))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), `"allow_domain"`) || !strings.Contains(string(data), "api.anthropic.com") {
		t.Errorf("the profile file carries no allow_domain list: %s", data)
	}
	if strings.Contains(string(data), `"block"`) {
		t.Errorf("the agent profile carries a `block` member: block-plus-allowlist is the contradiction nono's parser aborts on, and --block-net stays the egress-denied kinds' mechanism")
	}
}

// TestAllowlistChangesTheDigest is the point of putting the host list in the
// file: a recorded policy_digest must identify WHICH hosts were allowed, not
// just that some list existed.
func TestAllowlistChangesTheDigest(t *testing.T) {
	type policy struct {
		net   NetworkEnforcement
		hosts []string
	}
	cases := []policy{
		{net: NetworkOpen},
		{net: NetworkAllowlisted, hosts: []string{"api.anthropic.com"}},
		{net: NetworkAllowlisted, hosts: []string{"api.openai.com"}},
		{net: NetworkAllowlisted, hosts: []string{"api.anthropic.com", "registry.npmjs.org"}},
	}
	seen := map[string]string{}
	for _, c := range cases {
		prof, err := WriteProfileNetwork(t.TempDir(), ProfileAgentTurn, c.net, c.hosts)
		if err != nil {
			t.Fatalf("WriteProfileNetwork(%v): %v", c.hosts, err)
		}
		if got := strings.Join(prof.EgressHosts, ","); got != strings.Join(sortedCopy(c.hosts), ",") {
			t.Errorf("hosts = %q, want %q", got, strings.Join(sortedCopy(c.hosts), ","))
		}
		if err := prof.AssertOwnBytes(); err != nil {
			t.Fatalf("AssertOwnBytes(%v): %v", c.hosts, err)
		}
		if prev, dup := seen[prof.Digest]; dup {
			t.Errorf("policies %v and %v share digest %s: the digest would hide a host-set change", prev, c.hosts, prof.Digest)
		}
		seen[prof.Digest] = strings.Join(c.hosts, ",")
	}
}

// TestProfileBuilderRefusesUnreadableEgressPolicies covers the silent-degradation
// cases: an allowlist that resolves to nothing, a host list on a denied policy,
// a scheme/path entry (which switches nono to its intercept CA), and the
// open-network shape on a kind whose whole contract is egress denied.
func TestProfileBuilderRefusesUnreadableEgressPolicies(t *testing.T) {
	cases := []struct {
		name    string
		kind    string
		net     NetworkEnforcement
		hosts   []string
		wantSub string
	}{
		{"empty allowlist", ProfileAgentTurn, NetworkAllowlisted, nil, "no host"},
		{"allowlist on the command kind", ProfileCommand, NetworkAllowlisted, []string{"example.com"}, "egress-denied policy"},
		{"hosts with block", ProfileCommand, NetworkDenied, []string{"example.com"}, "contradictory"},
		{"url entry", ProfileAgentTurn, NetworkAllowlisted, []string{"https://example.com/allowed/**"}, "not a hostname"},
		{"sneaked separator", ProfileAgentTurn, NetworkAllowlisted, []string{"a.com b.com"}, "not a hostname"},
		{"open command kind", ProfileCommand, NetworkOpen, nil, "cannot be authored with network"},
		{"unknown kind", "communication-bogus", NetworkAllowlisted, []string{"example.com"}, "unknown profile kind"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := WriteProfileNetwork(t.TempDir(), tc.kind, tc.net, tc.hosts)
			if err == nil {
				t.Fatalf("accepted %v hosts under %s/%s", tc.hosts, tc.kind, tc.net)
			}
			if !strings.Contains(err.Error(), tc.wantSub) {
				t.Errorf("error = %v, want it to mention %q", err, tc.wantSub)
			}
		})
	}
}

// TestAllowlistedAgentTurnLaunchesWithoutBlockNet is the launch-plan half of
// design A: an allowlisted agent turn is NOT the BlockNet-open shape any more,
// and it does not grow new flags either — the host set is in the profile file,
// so argv stays `run -s -p <path> <grants> -- env … <adapter> …`.
func TestAllowlistedAgentTurnLaunchesWithoutBlockNet(t *testing.T) {
	dir := t.TempDir()
	prof, err := WriteProfile(dir, ProfileAgentTurn)
	if err != nil {
		t.Fatal(err)
	}
	plan, launcherHome := assetPlan(t)
	base := LaunchSpec{
		Profile: prof, Plan: plan, LauncherHome: launcherHome,
		AdapterPath: "/bin/true", AdapterArgs: []string{"--stdio"},
		AdapterEnv: []string{"PATH=/bin"},
	}
	argv, err := base.BuildLaunchArgv()
	if err != nil {
		t.Fatalf("BuildLaunchArgv: %v", err)
	}
	joined := strings.Join(argv, " ")
	for _, forbidden := range []string{"--block-net", "--allow-domain", "--deny-domain", "--proxy-port", "--sandbox-policy", "--allow-cwd"} {
		if strings.Contains(joined, forbidden) {
			t.Errorf("argv carries %s: %s (ADR-0035 keeps the argv shape: the allowlist travels in the profile file)", forbidden, joined)
		}
	}
	if !strings.Contains(joined, "-p "+prof.Path) {
		t.Errorf("argv does not reference the profile that carries the allowlist: %s", joined)
	}
	// The contradiction nono itself refuses must be refused here first, so a
	// mis-wired launch never reaches a kernel at all.
	blocked := base
	blocked.BlockNet = true
	if _, err := blocked.BuildLaunchArgv(); err == nil {
		t.Error("accepted --block-net under an allowlisted agent-turn profile")
	} else if !strings.Contains(err.Error(), "contradiction") {
		t.Errorf("error = %v, want it to name the contradiction", err)
	}
	// And an allowlisted Profile with no hosts in it cannot launch either.
	empty := *prof
	empty.EgressHosts = nil
	lying := base
	lying.Profile = &empty
	if _, err := lying.BuildLaunchArgv(); err == nil {
		t.Error("launched a Profile claiming allowlisted with an empty host list")
	}
}

// TestEgressReportNeedsAnObservedDenial is design A's rule as a test: the
// allowlisted label is earned by this run's audit journal, never by its
// configuration.
func TestEgressReportNeedsAnObservedDenial(t *testing.T) {
	allowlisted := &VerificationResult{
		NetworkEnforced: NetworkAllowlisted,
		EgressHosts:     []string{"api.anthropic.com"},
	}
	if claim, enforced := allowlisted.EgressReport(); enforced || claim != string(NetworkOpen) {
		t.Errorf("without an observed denial: (%q, %v), want (%q, false) — network: allowlisted must NOT be reported on config alone", claim, enforced, NetworkOpen)
	}
	withDenial := &VerificationResult{
		NetworkEnforced: NetworkAllowlisted,
		EgressHosts:     []string{"api.anthropic.com"},
		EgressDenials:   []EgressDenial{{Target: "example.com", Port: 443, Mode: "connect", Category: "host_denied"}},
	}
	claim, enforced := withDenial.EgressReport()
	if !enforced || claim != "allowlisted:api.anthropic.com" {
		t.Errorf("with an observed denial: (%q, %v), want (\"allowlisted:api.anthropic.com\", true)", claim, enforced)
	}
	denied := &VerificationResult{NetworkEnforced: NetworkDenied}
	if claim, enforced := denied.EgressReport(); !enforced || claim != "denied" {
		t.Errorf("the egress-denied profile reports (%q, %v), want (\"denied\", true)", claim, enforced)
	}
	open := &VerificationResult{NetworkEnforced: NetworkOpen}
	if claim, enforced := open.EgressReport(); enforced || claim != "open" {
		t.Errorf("the open profile reports (%q, %v), want (\"open\", false)", claim, enforced)
	}
	var none *VerificationResult
	if claim, enforced := none.EgressReport(); enforced || claim != "open" {
		t.Errorf("a nil chain reports (%q, %v), want (\"open\", false) — absence is never enforcement", claim, enforced)
	}
}

// TestAuditEgressDenialsReadsTheMeasuredShape locks the parser to the observed
// `nono audit show --json` records (docs/design/agent-egress.md), including that
// allows are not denials and that nothing-to-parse is an error rather than a
// quiet "no denials".
func TestAuditEgressDenialsReadsTheMeasuredShape(t *testing.T) {
	const measured = `{"network_events":[` +
		`{"decision":"allow","mode":"connect","target":"example.com","port":443,"method":"CONNECT"},` +
		`{"decision":"deny","denial_category":"host_denied","target":"example.org","port":443,"reason":"host example.org:443 is not in the allowlist"}]}`
	got, err := AuditEgressDenials([]byte(measured))
	if err != nil {
		t.Fatalf("AuditEgressDenials: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("denials = %+v, want exactly the one deny line out of two events", got)
	}
	if got[0].Target != "example.org" || got[0].Port != 443 || got[0].Category != "host_denied" {
		t.Errorf("denial = %+v, want the measured example.org/443/host_denied", got[0])
	}
	if _, err := AuditEgressDenials([]byte("")); err == nil {
		t.Error("empty audit output parsed as \"no denials\": that is how an unreported run would claim free egress")
	}
	if _, err := AuditEgressDenials([]byte("{truncated")); err == nil {
		t.Error("unparsable audit output parsed as \"no denials\"")
	}
}

func readProfileMap(t *testing.T, path string) map[string]any {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read profile: %v", err)
	}
	var out map[string]any
	if err := json.Unmarshal(data, &out); err != nil {
		t.Fatalf("profile is not JSON: %v", err)
	}
	return out
}

func sortedCopy(in []string) []string {
	out, err := NormalizeEgressHosts(in)
	if err != nil {
		panic(err)
	}
	return out
}
