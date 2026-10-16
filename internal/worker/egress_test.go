package worker

import (
	"context"
	"strings"
	"testing"

	"github.com/dbirks/communication/internal/domain"
	"github.com/dbirks/communication/internal/events"
	"github.com/dbirks/communication/internal/sandbox/nono"
)

// TestParseEgressAllow covers the operator-facing shape of ADR-0035's config:
// a comma-separated host list, an explicit word to opt out, and a refusal for
// every shape that would silently mean something other than what was written.
func TestParseEgressAllow(t *testing.T) {
	cases := []struct {
		raw      string
		wantNet  nono.NetworkEnforcement
		wantHost string
		wantErr  string
	}{
		{raw: "api.anthropic.com", wantNet: nono.NetworkAllowlisted, wantHost: "api.anthropic.com"},
		{raw: " B.example.com , a.example.com ", wantNet: nono.NetworkAllowlisted, wantHost: "a.example.com,b.example.com"},
		{raw: "*.example.com,example.com", wantNet: nono.NetworkAllowlisted, wantHost: "*.example.com,example.com"},
		{raw: "OPEN", wantNet: nono.NetworkOpen},
		{raw: "", wantErr: "set but empty"},
		{raw: ",", wantErr: "contains no host"},
		{raw: "https://example.com/allowed/**", wantErr: "not a hostname"},
		{raw: "a.com,bad..host", wantErr: "empty label"},
	}
	for _, tc := range cases {
		t.Run(tc.raw, func(t *testing.T) {
			net, hosts, err := ParseEgressAllow(tc.raw)
			if tc.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("err = %v, want it to mention %q", err, tc.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("ParseEgressAllow(%q): %v", tc.raw, err)
			}
			if net != tc.wantNet {
				t.Errorf("enforcement = %q, want %q", net, tc.wantNet)
			}
			if strings.Join(hosts, ",") != tc.wantHost {
				t.Errorf("hosts = %v, want %v", hosts, tc.wantHost)
			}
		})
	}
}

// TestAgentTurnProfileCarriesTheWorkersAllowlist is the ownership rule: the host
// set comes from this process's configuration (a field here, or
// COMMUNICATION_AGENT_EGRESS_ALLOW), and the profile the launch is verified
// against is the one that carries it.
func TestAgentTurnProfileCarriesTheWorkersAllowlist(t *testing.T) {
	f := newAgentTurnFixture(t, domain.EnforceRequired)
	fake := &recordingSandbox{}
	f.turn.Sandbox = fake
	f.turn.EgressAllow = []string{"registry.npmjs.org", "api.anthropic.com"}
	f.spawn.queue(newAgentSessionStub(domain.SessionInfo{}))
	t.Setenv(EnvAgentEgressAllow, "ignored-when-configured.example")

	if _, err := f.turn.Execute(context.Background(), f.claim(agentCfg("x")), f.sink); err != nil {
		t.Fatalf("Execute: %v", err)
	}
	prof := fake.lastSpec().Profile
	if prof.NetworkEnforced != nono.NetworkAllowlisted {
		t.Fatalf("profile network = %q, want %q", prof.NetworkEnforced, nono.NetworkAllowlisted)
	}
	if got := strings.Join(prof.EgressHosts, ","); got != "api.anthropic.com,registry.npmjs.org" {
		t.Errorf("profile hosts = %q, want the worker's own list (sorted), never the env var's", got)
	}
	if fake.lastSpec().BlockNet {
		t.Error("an allowlisted agent turn must never be launched with --block-net (nono refuses the pair)")
	}
}

// TestAgentTurnProfileFallsBackToTheEnvironment is the other half of the same
// rule: with no field set, the worker's environment is the authority.
func TestAgentTurnProfileFallsBackToTheEnvironment(t *testing.T) {
	t.Setenv(EnvAgentEgressAllow, "api.anthropic.com")
	f := newAgentTurnFixture(t, domain.EnforceRequired)
	fake := &recordingSandbox{}
	f.turn.Sandbox = fake
	f.spawn.queue(newAgentSessionStub(domain.SessionInfo{}))
	if _, err := f.turn.Execute(context.Background(), f.claim(agentCfg("x")), f.sink); err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if got := strings.Join(fake.lastSpec().Profile.EgressHosts, ","); got != "api.anthropic.com" {
		t.Errorf("hosts = %q, want the environment's list", got)
	}

	t.Setenv(EnvAgentEgressAllow, "open")
	f2 := newAgentTurnFixture(t, domain.EnforceRequired)
	fake2 := &recordingSandbox{}
	f2.turn.Sandbox = fake2
	f2.spawn.queue(newAgentSessionStub(domain.SessionInfo{}))
	if _, err := f2.turn.Execute(context.Background(), f2.claim(agentCfg("x")), f2.sink); err != nil {
		t.Fatalf("Execute (open): %v", err)
	}
	if got := fake2.lastSpec().Profile.NetworkEnforced; got != nono.NetworkOpen {
		t.Errorf("profile network = %q, want %q (ADR-0019 D3's shape, reachable only by this word)", got, nono.NetworkOpen)
	}

	// A bad value fails the attempt rather than quietly widening or narrowing it.
	t.Setenv(EnvAgentEgressAllow, "http://api.anthropic.com")
	f3 := newAgentTurnFixture(t, domain.EnforceRequired)
	f3.turn.Sandbox = &recordingSandbox{}
	f3.spawn.queue(newAgentSessionStub(domain.SessionInfo{}))
	res, err := f3.turn.Execute(context.Background(), f3.claim(agentCfg("x")), f3.sink)
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if res.Status == AttemptStatusSucceeded || !strings.Contains(res.Detail, EnvAgentEgressAllow) {
		t.Errorf("res = %+v, want the attempt to fail naming %s", res, EnvAgentEgressAllow)
	}
}

// TestVerifiedPayloadOnlyClaimsAllowlistedWithAnObservedDenial is ADR-0035's
// reporting rule at the journal boundary. The sandbox chain reports the
// profile's claim; the EVENT may only say "allowlisted:<hosts>" once this run's
// own audit journal recorded a refusal. Same profile, same digest, two different
// honest sentences.
func TestVerifiedPayloadOnlyClaimsAllowlistedWithAnObservedDenial(t *testing.T) {
	chain := func(denied bool) *nono.VerificationResult {
		res := &nono.VerificationResult{
			Backend: "nono", Version: nono.PinnedVersion, PolicyDigest: "sha256:fake",
			PolicyRef: nono.ProfileAgentTurn, AfUnixMediation: "pathname",
			NetworkEnforced: nono.NetworkAllowlisted, EgressHosts: nono.DefaultEgressHosts(),
			Verified: true,
		}
		if denied {
			res.EgressDenials = []nono.EgressDenial{{
				Target: "example.org", Port: 443, Mode: "connect", Category: "host_denied",
			}}
		}
		return res
	}
	f := newAgentTurnFixture(t, domain.EnforceRequired)
	f.turn.Sandbox = &recordingSandbox{result: chain(false)}
	f.spawn.queue(newAgentSessionStub(domain.SessionInfo{}))
	if _, err := f.turn.Execute(context.Background(), f.claim(agentCfg("x")), f.sink); err != nil {
		t.Fatalf("Execute: %v", err)
	}
	got := sandboxVerifiedPayload(t, f)
	if got.NetworkEnforced || got.Network != string(nono.NetworkOpen) {
		t.Errorf("unexercised allowlist journalled network_enforced=%v network=%q, want false/open (config never buys the claim)", got.NetworkEnforced, got.Network)
	}

	f2 := newAgentTurnFixture(t, domain.EnforceRequired)
	f2.turn.Sandbox = &recordingSandbox{result: chain(true)}
	f2.spawn.queue(newAgentSessionStub(domain.SessionInfo{}))
	if _, err := f2.turn.Execute(context.Background(), f2.claim(agentCfg("x")), f2.sink); err != nil {
		t.Fatalf("Execute: %v", err)
	}
	got2 := sandboxVerifiedPayload(t, f2)
	if !got2.NetworkEnforced || got2.Network != "allowlisted:"+strings.Join(nono.DefaultEgressHosts(), ",") {
		t.Errorf("exercised allowlist journalled network_enforced=%v network=%q, want true/allowlisted:<hosts>", got2.NetworkEnforced, got2.Network)
	}
}

func sandboxVerifiedPayload(t *testing.T, f *agentTurnFixture) events.SandboxVerifiedPayload {
	t.Helper()
	for _, ev := range f.sink.events {
		if p, ok := ev.Payload.(events.SandboxVerifiedPayload); ok {
			return p
		}
	}
	t.Fatalf("no sandbox.verified payload was journalled")
	return events.SandboxVerifiedPayload{}
}

// fakeEgressAudit is nono's audit journal as a test can hold it: the observation
// one launched session produced, or the reason it could not be read.
type fakeEgressAudit struct {
	obs    nono.EgressObservation
	err    error
	calls  int
	marker string
}

func (f *fakeEgressAudit) AuditSessionEgress(_ context.Context, marker string) (nono.EgressObservation, error) {
	f.calls++
	f.marker = marker
	if f.err != nil {
		return nono.EgressObservation{}, f.err
	}
	return f.obs, nil
}

func allowlistedChain() *nono.VerificationResult {
	return &nono.VerificationResult{
		Backend: "nono", Version: nono.PinnedVersion, PolicyDigest: "sha256:fake",
		PolicyRef: nono.ProfileAgentTurn, AfUnixMediation: "pathname",
		NetworkEnforced: nono.NetworkAllowlisted, EgressHosts: nono.DefaultEgressHosts(),
		Verified: true,
	}
}

func egressObservedEvent(t *testing.T, f *agentTurnFixture) events.SandboxEgressObservedPayload {
	t.Helper()
	for _, ev := range f.sink.events {
		if p, ok := ev.Payload.(events.SandboxEgressObservedPayload); ok {
			return p
		}
	}
	t.Fatalf("no sandbox.egress_observed was journalled among %d events", len(f.sink.events))
	return events.SandboxEgressObservedPayload{}
}

// TestEgressAuditIsWhatEarnsTheAllowlistedLabel is ADR-0035 § 3 wired end to
// end at the attempt boundary: the sandbox chain is verified (so the profile
// claims an allowlist), the turn runs, and only the run's OWN audit decides the
// sentence the journal may say. A denial observed -> allowlisted:<hosts>; none
// -> open; an unread audit -> the turn still succeeds and says it could not look.
func TestEgressAuditIsWhatEarnsTheAllowlistedLabel(t *testing.T) {
	oneDenial := nono.EgressObservation{
		SessionID: "run000000000002", Allows: 1,
		Denials: []nono.EgressDenial{{
			Target: "example.org", Port: 443, Mode: "connect", Category: "host_denied",
			Reason: "host example.org:443 is not in the allowlist",
		}},
	}
	cases := []struct {
		name         string
		audit        *fakeEgressAudit
		wantStatus   string
		wantNetwork  string
		wantEnforced bool
		wantHosts    string
		wantDenied   int
		wantDetail   string
	}{
		{
			name: "no denials proves nothing", audit: &fakeEgressAudit{},
			wantStatus: events.EgressAuditStatusObserved, wantNetwork: string(nono.NetworkOpen),
			wantEnforced: false, wantHosts: "", wantDenied: 0,
		},
		{
			name: "one denial earns the label", audit: &fakeEgressAudit{obs: oneDenial},
			wantStatus:   events.EgressAuditStatusObserved,
			wantNetwork:  "allowlisted:" + strings.Join(nono.DefaultEgressHosts(), ","),
			wantEnforced: true, wantHosts: "example.org", wantDenied: 1,
		},
		{
			name: "an unread audit is not evidence", audit: &fakeEgressAudit{err: context.DeadlineExceeded},
			wantStatus: events.EgressAuditStatusUnavailable, wantNetwork: string(nono.NetworkOpen),
			wantEnforced: false, wantHosts: "", wantDenied: 0,
			wantDetail: "deadline exceeded",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newAgentTurnFixture(t, domain.EnforceRequired)
			f.turn.Sandbox = &recordingSandbox{result: allowlistedChain()}
			f.turn.Egress = tc.audit
			f.spawn.queue(newAgentSessionStub(domain.SessionInfo{}))
			res, err := f.turn.Execute(context.Background(), f.claim(agentCfg("x")), f.sink)
			if err != nil {
				t.Fatalf("Execute: %v", err)
			}
			if res.Status != AttemptStatusSucceeded {
				t.Fatalf("turn status = %q (%s): an audit read may cost a label, never the turn", res.Status, res.ErrorClass)
			}
			got := egressObservedEvent(t, f)
			if got.Status != tc.wantStatus || got.Network != tc.wantNetwork || got.NetworkEnforced != tc.wantEnforced {
				t.Errorf("egress row = status %q network %q enforced %v, want %q/%q/%v",
					got.Status, got.Network, got.NetworkEnforced, tc.wantStatus, tc.wantNetwork, tc.wantEnforced)
			}
			if hosts := strings.Join(got.DeniedHosts, ","); hosts != tc.wantHosts {
				t.Errorf("denied_hosts = %q, want %q", hosts, tc.wantHosts)
			}
			if tc.wantDetail != "" && !strings.Contains(got.Detail, tc.wantDetail) {
				t.Errorf("detail = %q, want it to say %q: an unavailable audit must be diagnosable from the journal", got.Detail, tc.wantDetail)
			}
			if got.Denied != tc.wantDenied {
				t.Errorf("denied = %d, want %d", got.Denied, tc.wantDenied)
			}
			if got.ProjectID != "p-1" || got.WorkerID != "worker-1" || got.PolicyDigest != "sha256:fake" {
				t.Errorf("row does not identify its run: %+v", got)
			}
			if tc.audit.calls != 1 {
				t.Errorf("audit calls = %d, want exactly 1 per turn", tc.audit.calls)
			}
			if want := "COMMUNICATION_ATTEMPT_ID=" + fakeAttemptID; tc.audit.marker != want {
				t.Errorf("audit marker = %q, want %q: the run must read ITS OWN session's journal", tc.audit.marker, want)
			}
			// sandbox.verified was written before the child ran, so it keeps
			// saying what the chain alone supported (ADR-0035 § 2).
			if v := sandboxVerifiedPayload(t, f); v.Network != string(nono.NetworkOpen) || v.NetworkEnforced {
				t.Errorf("sandbox.verified retro-claimed %q/%v from a post-turn audit", v.Network, v.NetworkEnforced)
			}
		})
	}
}

// TestNoEgressAuditRowWithoutAnAllowlistedProfile keeps the new event scoped to
// the state it exists for: an unsandboxed turn has no audit to read, and a
// --block-net profile is already labelled by the argv sandbox.verified recorded.
func TestNoEgressAuditRowWithoutAnAllowlistedProfile(t *testing.T) {
	audit := &fakeEgressAudit{}
	f := newAgentTurnFixture(t, domain.EnforceDisabled)
	f.turn.Egress = audit
	f.spawn.queue(newAgentSessionStub(domain.SessionInfo{}))
	if _, err := f.turn.Execute(context.Background(), f.claim(agentCfg("x")), f.sink); err != nil {
		t.Fatalf("Execute: %v", err)
	}
	for _, ev := range f.sink.events {
		if _, ok := ev.Payload.(events.SandboxEgressObservedPayload); ok {
			t.Fatal("journalled an egress audit for a run that launched no sandbox")
		}
	}
	if audit.calls != 0 {
		t.Errorf("audit calls = %d, want 0 under a disabled enforcement mode", audit.calls)
	}
}

// TestEgressAuditWithoutASurfaceSaysSoCovers covers the sandbox backend that has
// no audit read at all: the run still completes, the label stays unearned, and
// the journal names the missing surface instead of silently omitting the row.
func TestEgressAuditWithoutASurfaceSaysSo(t *testing.T) {
	f := newAgentTurnFixture(t, domain.EnforceRequired)
	f.turn.Sandbox = &recordingSandbox{result: allowlistedChain()} // not an EgressAuditor
	f.spawn.queue(newAgentSessionStub(domain.SessionInfo{}))
	res, err := f.turn.Execute(context.Background(), f.claim(agentCfg("x")), f.sink)
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if res.Status != AttemptStatusSucceeded {
		t.Fatalf("turn status = %q: a backend without an audit surface may not fail the turn", res.Status)
	}
	got := egressObservedEvent(t, f)
	if got.Status != events.EgressAuditStatusUnavailable || !strings.Contains(got.Detail, "no egress audit surface") {
		t.Errorf("row = status %q detail %q, want unavailable + the missing surface named", got.Status, got.Detail)
	}
	if got.NetworkEnforced || got.Network != string(nono.NetworkOpen) {
		t.Errorf("unaudited run claimed %q/%v", got.Network, got.NetworkEnforced)
	}
}
