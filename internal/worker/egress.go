package worker

import (
	"fmt"
	"net/url"
	"os"
	"strings"

	"github.com/dbirks/communication/internal/agent/acp"
	"github.com/dbirks/communication/internal/sandbox/nono"
)

// EnvAgentEgressAllow is the worker-owned agent egress allowlist:
// a comma-separated list of hostnames (or `*.domain` wildcards) the agent-turn
// profile publishes into `network.allow_domain`.
//
// It is a worker environment variable and nothing else. The allowlist decides
// which hosts a sandboxed agent may reach, so it cannot come from a pipeline
// document, an agent profile row, or anything a project member edits: the
// execution worker's own operator configures it, the same way they configure
// COMMUNICATION_SANDBOX_ENFORCEMENT (ADR-0035; `05`'s "the worker owns the
// sandbox"). A pipeline that needs a host it cannot reach fails honestly — a
// proxy `403 … is not in the allowlist` in its own transcript — rather than
// widening its own boundary.
const EnvAgentEgressAllow = "COMMUNICATION_AGENT_EGRESS_ALLOW"

// egressOpenValues opt out of the allowlist entirely, back to ADR-0019 D3's
// open-network agent profile. They are explicit words, not an empty string: an
// empty value is a mis-set variable, and a mis-set variable must not silently
// remove an egress boundary.
var egressOpenValues = map[string]bool{"open": true, "none": true, "off": true, "unrestricted": true}

// agentEgressAllow resolves the agent-turn network axis for this worker: the
// field if it was set, else the environment, else "" meaning "apply the
// profile kind's shipped default" (allowlisted with nono.DefaultEgressHosts()).
// It returns the enforcement and the list separately because "open" and "no
// opinion" are different answers that both carry no hosts.
//
// ADR-0069: whatever list resolves, the launcher registry's *operator-configured*
// provider hosts (launcherProviderEgressHosts) join it whenever the axis is or
// defaults to allowlisted — they are worker operator config like this
// environment variable is, and a launcher configured to talk to a gateway must
// be able to reach it or the turn can only egress-fail. An explicit `open`
// needs no addition.
func agentEgressAllow(configured []string) (nono.NetworkEnforcement, []string, error) {
	providers, err := launcherProviderEgressHosts()
	if err != nil {
		return "", nil, err
	}
	if len(configured) > 0 {
		hosts, err := nono.NormalizeEgressHosts(append(append([]string(nil), configured...), providers...))
		if err != nil {
			return "", nil, err
		}
		return nono.NetworkAllowlisted, hosts, nil
	}
	raw, ok := os.LookupEnv(EnvAgentEgressAllow)
	if !ok {
		if len(providers) == 0 {
			return "", nil, nil
		}
		// No operator allowlist, but a provider host was configured: publish
		// the shipped default *plus* the provider host explicitly, so the
		// digest says exactly what the profile carries.
		hosts, err := nono.NormalizeEgressHosts(append(nono.DefaultEgressHosts(), providers...))
		if err != nil {
			return "", nil, err
		}
		return nono.NetworkAllowlisted, hosts, nil
	}
	net, hosts, err := ParseEgressAllow(raw)
	if err != nil {
		return "", nil, err
	}
	if net == nono.NetworkAllowlisted && len(providers) > 0 {
		hosts, err = nono.NormalizeEgressHosts(append(append([]string(nil), hosts...), providers...))
		if err != nil {
			return "", nil, err
		}
	}
	return net, hosts, nil
}

// launcherProviderEgressHosts returns the hosts implied by the launcher
// registry's operator-configured provider base URLs (ADR-0059: pi's
// COMMUNICATION_PI_BASE_URL). A base URL the operator named is operator
// configuration, not node content: ADR-0035's rule that the allowlist cannot
// come from a pipeline document or a profile row is untouched — nothing an
// agent or a project author edits reaches this list. A configured-but-malformed
// base URL fails closed (the host a turn is supposed to reach must not be a
// silent miss).
func launcherProviderEgressHosts() ([]string, error) {
	var out []string
	for _, l := range acp.KnownLaunchers() {
		if l.ApiBaseURL == "" {
			continue
		}
		raw := strings.TrimSpace(os.Getenv(l.ApiBaseURL))
		if raw == "" {
			continue
		}
		host, err := providerURLHostname(raw)
		if err != nil {
			return nil, fmt.Errorf("worker: %s: %w", l.ApiBaseURL, err)
		}
		out = append(out, host)
	}
	return out, nil
}

// providerURLHostname extracts the lowercase hostname of a provider base URL
// (scheme required, path/port ignored — the allowlist entry is the hostname
// tunnel, ADR-0035).
func providerURLHostname(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return "", fmt.Errorf("%q is not a parseable provider base URL", raw)
	}
	host := strings.ToLower(u.Hostname())
	if host == "" {
		return "", fmt.Errorf("%q names no host", raw)
	}
	return host, nil
}

// ParseEgressAllow reads one raw allowlist value ("api.anthropic.com,*.example.com").
//
// Exported because the worker's own startup path and any operator-facing report
// of "the policy this process will launch under" must read the value the same
// way: two parsers that disagree would print a digest no run ever carried.
func ParseEgressAllow(raw string) (nono.NetworkEnforcement, []string, error) {
	v := strings.ToLower(strings.TrimSpace(raw))
	if v == "" {
		return "", nil, fmt.Errorf("worker: %s is set but empty: an empty allowlist is a mistake, not a policy. List comma-separated hosts, or set it to %q to run the agent with egress unrestricted as ADR-0019 D3 did", EnvAgentEgressAllow, "open")
	}
	if egressOpenValues[v] {
		return nono.NetworkOpen, nil, nil
	}
	hosts, err := nono.NormalizeEgressHosts(strings.Split(v, ","))
	if err != nil {
		return "", nil, fmt.Errorf("worker: %s: %w", EnvAgentEgressAllow, err)
	}
	if len(hosts) == 0 {
		return "", nil, fmt.Errorf("worker: %s %q contains no host", EnvAgentEgressAllow, raw)
	}
	return nono.NetworkAllowlisted, hosts, nil
}
