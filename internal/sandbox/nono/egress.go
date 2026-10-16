package nono

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
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
	if len(strings.TrimSpace(string(data))) == 0 {
		return nil, fmt.Errorf("sandbox: empty audit output: refusing to read 'no egress denials' out of nothing (an unreported run must fail closed)")
	}
	var doc auditDocument
	if err := json.Unmarshal(data, &doc); err != nil {
		return nil, fmt.Errorf("sandbox: audit output is not the JSON this adapter understands: %w", err)
	}
	var out []EgressDenial
	for _, ev := range doc.NetworkEvents {
		if !strings.EqualFold(ev.Decision, "deny") {
			continue
		}
		out = append(out, EgressDenial{
			Target: ev.Target, Port: ev.Port, Mode: ev.Mode,
			Category: ev.Category, Reason: ev.Reason,
		})
	}
	return out, nil
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
// denials it recorded. It is the read side of design A's rule; the live lab turn
// is what wires it into a run and earns the `allowlisted` label.
func (l *Launcher) AuditEgress(ctx context.Context, sessionID string) ([]EgressDenial, error) {
	if strings.TrimSpace(sessionID) == "" {
		return nil, fmt.Errorf("sandbox: no nono session id to read the egress audit for")
	}
	bin, err := l.resolveBinary()
	if err != nil {
		return nil, err
	}
	out, err := l.run(ctx, verifyTimeout, "", l.launcherEnv(LaunchSpec{}), bin, "audit", "show", sessionID, "--json")
	if err != nil {
		return nil, fmt.Errorf("sandbox: nono audit show %s failed: %v (%s)", sessionID, err, firstLine(out))
	}
	return AuditEgressDenials([]byte(out))
}
