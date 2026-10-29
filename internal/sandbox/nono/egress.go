package nono

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	// egressAuditTimeout bounds every audit read (list and show). It is short on
	// purpose: the audit surface is consulted AFTER a turn has answered, so the
	// worst case it can create is a missing label — never a stuck run. ADR-0035.
	egressAuditTimeout = 2 * time.Second

	// auditListRecent is how many sessions `nono audit list` is asked for when
	// attributing a run. The marker match is exact, so a busy worker only loses
	// the label (fail-closed) if more than this many sessions finished inside one
	// turn's window.
	auditListRecent = 50
)

// NetworkEnforcement is the network axis of a Communication policy, and it is
// a property of the profile bytes, not of a flag.
//
// ADR-0019 D3 shipped this axis as a bool — "egress denied" or "open" —
// because there were only two policies and the middle one did not exist.
// ADR-0035 adds the middle: nono 0.80's proxy allowlist (measured in
// docs/design/agent-egress.md: a profile carrying
// `network.allow_domain: ["example.com","api.anthropic.com"]` returned
// `http=200` for the allowed host and `ERR Request was cancelled.` for
// example.org, in the same sandboxed child, with the filesystem grant intact).
// A bool cannot name that state honestly: it is neither "enforced = everything
// is blocked" nor "unenforced = anything goes".
type NetworkEnforcement string

const (
	// NetworkOpen is no egress policy at all: the agent reaches any host.
	// This is what every M3/M4 turn has run under, and what
	// `network_enforced: false` reports.
	NetworkOpen NetworkEnforcement = "open"
	// NetworkAllowlisted is the proxy allowlist: CONNECT to a listed host
	// tunnels, everything else is refused by the proxy (measured: `CONNECT
	// example.org:443` → `HTTP/1.1 403 Forbidden: host example.org:443 is not
	// in the allowlist`). Raw sockets are refused by the kernel regardless
	// (`net.connect(443, 93.184.216.34)` → EACCES) and DNS does not resolve
	// (`EAI_AGAIN`), so the allowlist needs no CA — hostname entries are
	// tunnels, not MITM.
	NetworkAllowlisted NetworkEnforcement = "allowlisted"
	// NetworkDenied is `--block-net`: every egress attempt fails. It is the
	// command profile's and the case-13 profile's claim, unchanged by
	// ADR-0035, and it is mutually exclusive with an allowlist at nono's own
	// config parser ("--block-net and --allow-domain are contradictory:
	// domain filtering requires proxy mode").
	NetworkDenied NetworkEnforcement = "denied"
)

// defaultEgressHosts is the shipped agent-turn allowlist. It is **provisional**
// (ADR-0035): api.anthropic.com is the one host the lab has measured a real
// request against (`https://api.anthropic.com/v1/messages` → `http=405`, i.e.
// the real API answered a GET), and no live `claude-agent-acp` turn has yet
// been run under an allowlist, so the full set Claude Code actually needs is
// unproven. A worker overrides it with its own configuration
// (COMMUNICATION_AGENT_EGRESS_ALLOW); a pipeline document never can.
var defaultEgressHosts = []string{"api.anthropic.com"}

// DefaultEgressHosts returns the shipped agent-turn allowlist, so the worker,
// `doctor`, and a test all read the same provisional list rather than three
// copies of it.
func DefaultEgressHosts() []string { return append([]string(nil), defaultEgressHosts...) }

// defaultAPMEgressHosts is the shipped apm-resolve allowlist (ADR-0054 §B.2,
// ADR-0035): the GitHub source hosts a pinned package ref is fetched from.
// github.com is the git endpoint, api.github.com the API, and the
// objects.githubusercontent.com / raw.githubusercontent.com hosts the git
// smart-HTTP / raw-content transports answer on; apm 0.34's measured needs are
// covered by this set, and any future source host has to be added here (a worker
// override rides the same allowlist field).
var defaultAPMEgressHosts = []string{
	"github.com",
	"api.github.com",
	"codeload.github.com",
	"objects.githubusercontent.com",
	"raw.githubusercontent.com",
}

// DefaultAPMEgressHosts returns the shipped apm-resolve allowlist, so the
// worker, `doctor`, and a test all read the same host set rather than three
// copies of it.
func DefaultAPMEgressHosts() []string { return append([]string(nil), defaultAPMEgressHosts...) }

// NormalizeEgressHosts validates and canonicalizes an allowlist.
//
// The rules are fail-closed on purpose: a mistyped entry in an egress policy
// is not a cosmetic error, it is a host that silently never connects (a
// degraded turn) or a pattern that silently matches nothing. So anything that
// is not a plain hostname, a leading-`*.` wildcard, or an origin (`scheme://`
// plus optional port) is refused before the profile is written, and the launch
// fails honestly instead.
//
// A URL with a path glob is deliberately NOT accepted here: measured, a glob
// entry switches nono to TLS interception (`NODE_EXTRA_CA_CERTS`/`SSL_CERT_FILE`
// point at a generated CA under the session state dir), which is a different
// claim — and a different CA — from the hostname tunnels this policy ships.
func NormalizeEgressHosts(hosts []string) ([]string, error) {
	seen := map[string]bool{}
	var out []string
	for _, raw := range hosts {
		h := strings.ToLower(strings.TrimSpace(raw))
		if h == "" {
			continue
		}
		if err := checkEgressHost(h); err != nil {
			return nil, err
		}
		if seen[h] {
			continue
		}
		seen[h] = true
		out = append(out, h)
	}
	sort.Strings(out)
	return out, nil
}

// checkEgressHost is the per-entry half of NormalizeEgressHosts.
func checkEgressHost(h string) error {
	if strings.ContainsAny(h, " \t/\\@,:") {
		return fmt.Errorf("sandbox: egress allowlist entry %q is not a hostname: a scheme, path, userinfo, port or list separator is not accepted here (a URL with a path glob switches nono to its intercept CA rather than a hostname tunnel, and a malformed entry silently matches nothing)", h)
	}
	if strings.HasPrefix(h, ".") || strings.HasSuffix(h, ".") {
		return fmt.Errorf("sandbox: egress allowlist entry %q has an empty label", h)
	}
	body := h
	if strings.HasPrefix(body, "*.") {
		body = body[2:]
	}
	for _, label := range strings.Split(body, ".") {
		if label == "" {
			return fmt.Errorf("sandbox: egress allowlist entry %q has an empty label", h)
		}
		for _, r := range label {
			ok := (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-' || r == '_'
			if !ok {
				return fmt.Errorf("sandbox: egress allowlist entry %q contains %q, which is not a hostname character", h, string(r))
			}
		}
	}
	return nil
}

// EgressDenial is one refused connection from nono's own audit journal — the
// evidence that an allowlist was actually exercised during a run, and the only
// thing that entitles `sandbox.verified` to say "allowlisted".
//
// The shape is the measured one (`nono audit show <id> --json`):
//
//	{"mode":"connect","decision":"deny","denial_category":"host_denied",
//	 "target":"example.org","port":443,"reason":"host example.org:443 is not in the allowlist"}
//
// `--diagnostics-json` records `denials: []` for the same run, so it is NOT the
// surface to read (docs/design/agent-egress.md, measured fact "Fail-closed +
// observability").
type EgressDenial struct {
	Target   string `json:"target"`
	Port     int    `json:"port"`
	Mode     string `json:"mode"`
	Category string `json:"denial_category"`
	Reason   string `json:"reason"`
}

// auditDocument is the slice of `nono audit show --json` this adapter reads.
// Unknown fields are ignored on purpose: the audit journal is nono's surface,
// and an added field must not stop a turn from being reportable.
type auditDocument struct {
	NetworkEvents []struct {
		Decision string `json:"decision"`
		Mode     string `json:"mode"`
		Target   string `json:"target"`
		Port     int    `json:"port"`
		Category string `json:"denial_category"`
		Reason   string `json:"reason"`
	} `json:"network_events"`
}

// AuditEgressDenials extracts the deny decisions from one audit document.
//
// It returns an error rather than an empty list on unparsable input: "no
// denials" is a claim that a run reached the network freely, and it must not be
// the fallback for a truncated JSON blob.
func AuditEgressDenials(data []byte) ([]EgressDenial, error) {
	obs, err := AuditEgressObservation(data)
	if err != nil {
		return nil, err
	}
	return obs.Denials, nil
}

// EgressObservation is what one launched session's OWN audit journal said about
// its egress: the allow/deny counts and the refused targets. It is the object a
// turn needs to earn ADR-0035's `allowlisted:<hosts>` label, and it is never
// built from configuration — only from `nono audit show <id> --json`.
type EgressObservation struct {
	// SessionID is the nono audit session this came from, empty when the run
	// could not be attributed to one (which is an error, not a zero observation).
	SessionID string
	// Allows counts the `decision:"allow"` network events — the evidence that
	// the proxy carried traffic rather than sat unused.
	Allows int
	// Denials are the `decision:"deny"` events, in journal order.
	Denials []EgressDenial
}

// DeniedHosts is the event-safe half of the observation: the distinct hostnames
// this run was refused, sorted. Audit `target` values are reduced to hostnames
// here and nowhere else, because the journal is browser-visible and a URL
// entry (or a glob-URL interception denial) would smuggle a path and a query
// string into an event whose whole purpose is naming a host.
func (o EgressObservation) DeniedHosts() []string {
	out := make([]string, 0, len(o.Denials))
	seen := map[string]bool{}
	for _, d := range o.Denials {
		h := EgressHostOf(d.Target)
		if h == "" || seen[h] {
			continue
		}
		seen[h] = true
		out = append(out, h)
	}
	sort.Strings(out)
	return out
}

// EgressHostOf reduces one audit target to a bare hostname: scheme, userinfo,
// port, path, query and fragment are all stripped, and anything that is not a
// hostname after that (an IPv6 literal, a blank, a target with whitespace) is
// dropped rather than journalled. A dropped target is still counted in the
// denial total — the count is evidence, the host list is presentation.
func EgressHostOf(target string) string {
	h := strings.ToLower(strings.TrimSpace(target))
	if h == "" || strings.HasPrefix(h, "[") {
		return ""
	}
	if i := strings.Index(h, "://"); i >= 0 {
		h = h[i+3:]
	}
	for _, sep := range []string{"/", "?", "#"} {
		if i := strings.Index(h, sep); i >= 0 {
			h = h[:i]
		}
	}
	if i := strings.LastIndex(h, "@"); i >= 0 {
		h = h[i+1:]
	}
	if i := strings.LastIndex(h, ":"); i >= 0 {
		// One colon is host:port; two or more is an IPv6 literal, which is not a
		// hostname and does not belong in an allowlist-shaped event field.
		if strings.Contains(h[:i], ":") {
			return ""
		}
		h = h[:i]
	}
	if h == "" || strings.ContainsAny(h, " \t\\%") || strings.HasPrefix(h, ".") || strings.HasSuffix(h, ".") {
		return ""
	}
	return h
}

// AuditEgressObservation parses one `nono audit show <id> --json` document into
// the run's allow/deny evidence.
//
// Like AuditEgressDenials it refuses unparsable or empty input with an error:
// "zero allows, zero denials" is a sentence about a run that reached the
// network freely, and it must never be the fallback for a truncated blob.
func AuditEgressObservation(data []byte) (EgressObservation, error) {
	if len(strings.TrimSpace(string(data))) == 0 {
		return EgressObservation{}, fmt.Errorf("sandbox: empty audit output: refusing to read 'no egress denials' out of nothing (an unreported run must fail closed)")
	}
	var doc auditDocument
	if err := json.Unmarshal(data, &doc); err != nil {
		return EgressObservation{}, fmt.Errorf("sandbox: audit output is not the JSON this adapter understands: %w", err)
	}
	return observationFromAudit(doc), nil
}

func observationFromAudit(doc auditDocument) EgressObservation {
	var out EgressObservation
	for _, ev := range doc.NetworkEvents {
		switch {
		case strings.EqualFold(ev.Decision, "deny"):
			out.Denials = append(out.Denials, EgressDenial{
				Target: ev.Target, Port: ev.Port, Mode: ev.Mode,
				Category: ev.Category, Reason: ev.Reason,
			})
		case strings.EqualFold(ev.Decision, "allow"):
			out.Allows++
		}
	}
	return out
}

// EgressReport is the run-level egress claim, and it is deliberately weaker
// than the profile's own claim.
//
// The profile digest commits to a host list (NetworkEnforced=allowlisted), but
// a list that was never exercised proves nothing about the running process: the
// proxy could have been bypassed, misconfigured, or simply unused because the
// turn made no call. So `sandbox.verified` may say `allowlisted:<hosts>` only
// when THIS run's audit journal shows a denial — design A's rule, and the same
// discipline that keeps ADR-0019's `network_enforced` honest:
//
//   - denied profile  -> "denied" (the flag is in the argv we recorded)
//   - allowlisted profile, a denial observed this run -> "allowlisted:<hosts>"
//   - allowlisted profile, no observed denial         -> "open" + enforced=false
//
// The third row is the important one: an unexercised allowlist is reported as
// unenforced, exactly as it was before ADR-0035, and no config default flips it.
func (r *VerificationResult) EgressReport() (network string, enforced bool) {
	if r == nil {
		return string(NetworkOpen), false
	}
	switch r.NetworkEnforced {
	case NetworkDenied:
		return string(NetworkDenied), true
	case NetworkAllowlisted:
		if r.EgressDenialObserved() {
			return string(NetworkAllowlisted) + ":" + strings.Join(r.EgressHosts, ","), true
		}
		return string(NetworkOpen), false
	default:
		return string(NetworkOpen), false
	}
}

// EgressDenialObserved reports whether this run's own audit journal recorded a
// refused connection. Nothing sets it during Verify: the audit surface is read
// after the child has run (Launcher.AuditEgress), and a run that never reads it
// keeps saying "not enforced".
func (r *VerificationResult) EgressDenialObserved() bool {
	return r != nil && len(r.EgressDenials) > 0
}

// AuditEgress runs `nono audit show <sessionID> --json` and returns the egress
// denials it recorded. It is the read side of design A's rule, and the shape a
// turn that already knows its session id uses.
func (l *Launcher) AuditEgress(ctx context.Context, sessionID string) ([]EgressDenial, error) {
	obs, err := l.AuditSession(ctx, sessionID)
	if err != nil {
		return nil, err
	}
	return obs.Denials, nil
}

// AuditSession reads one session's audit document and returns its egress
// evidence. Every read is bounded by egressAuditTimeout, never by the 30 s
// verification budget: this runs after a turn has answered, and a slow or
// missing audit surface must cost a label, not a turn.
func (l *Launcher) AuditSession(ctx context.Context, sessionID string) (EgressObservation, error) {
	if strings.TrimSpace(sessionID) == "" {
		return EgressObservation{}, fmt.Errorf("sandbox: no nono session id to read the egress audit for")
	}
	bin, err := l.resolveBinary()
	if err != nil {
		return EgressObservation{}, err
	}
	out, err := l.run(ctx, egressAuditTimeout, "", l.launcherEnv(LaunchSpec{}), bin, "audit", "show", sessionID, "--json")
	if err != nil {
		return EgressObservation{}, fmt.Errorf("sandbox: nono audit show %s failed: %v (%s)", sessionID, err, out.ErrLine())
	}
	// stdout only: 0.80.0 prints the update notice on stderr, and a notice in
	// front of the document is not a document (see nonoOutput).
	obs, err := AuditEgressObservation([]byte(out.Machine()))
	if err != nil {
		return EgressObservation{}, err
	}
	obs.SessionID = sessionID
	return obs, nil
}

// auditListingEntry is one row of `nono audit list --json`. The measured shape
// (docs/design/agent-egress.md, re-observed on nono 0.80.0) records the child's
// FULL argv, including the `env` hop's KEY=VALUE entries, which is what makes a
// Communication-launched session findable without adding a flag to the argv that
// ADR-0035 pinned: measured, `command: ["env","COMMUNICATION_ATTEMPT_ID=…","…"]`.
type auditListingEntry struct {
	SessionID string   `json:"session_id"`
	Command   []string `json:"command"`
}

// FindSessionByMarker returns the newest audited session whose recorded command
// line carries `marker` as one whole argv entry.
func (l *Launcher) FindSessionByMarker(ctx context.Context, marker string) (string, error) {
	if strings.TrimSpace(marker) == "" {
		return "", fmt.Errorf("sandbox: no launch marker to attribute an egress audit to")
	}
	bin, err := l.resolveBinary()
	if err != nil {
		return "", err
	}
	out, err := l.run(ctx, egressAuditTimeout, "", l.launcherEnv(LaunchSpec{}),
		bin, "audit", "list", "--json", "--recent", strconv.Itoa(auditListRecent))
	if err != nil {
		return "", fmt.Errorf("sandbox: nono audit list failed: %v (%s)", err, out.ErrLine())
	}
	var entries []auditListingEntry
	if err := json.Unmarshal([]byte(out.Machine()), &entries); err != nil {
		return "", fmt.Errorf("sandbox: nono audit list is not the JSON this adapter understands: %w", err)
	}
	for _, e := range entries { // newest first, as measured
		for _, arg := range e.Command {
			if arg == marker && strings.TrimSpace(e.SessionID) != "" {
				return e.SessionID, nil
			}
		}
	}
	return "", fmt.Errorf("sandbox: none of the last %d audited sessions carries the launch marker %q: this run's egress audit is unattributable, and an audit borrowed from another run would buy a network claim this run never earned", auditListRecent, marker)
}

// AuditSessionEgress is the end-of-turn read: locate THIS launch's audit session
// by the marker its own argv carried, and return that session's egress evidence.
func (l *Launcher) AuditSessionEgress(ctx context.Context, marker string) (EgressObservation, error) {
	sessionID, err := l.FindSessionByMarker(ctx, marker)
	if err != nil {
		return EgressObservation{}, err
	}
	return l.AuditSession(ctx, sessionID)
}
