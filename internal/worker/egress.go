package worker

import (
	"fmt"
	"os"
	"strings"

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
func agentEgressAllow(configured []string) (nono.NetworkEnforcement, []string, error) {
	if len(configured) > 0 {
		hosts, err := nono.NormalizeEgressHosts(configured)
		if err != nil {
			return "", nil, err
		}
		return nono.NetworkAllowlisted, hosts, nil
	}
	raw, ok := os.LookupEnv(EnvAgentEgressAllow)
	if !ok {
		return "", nil, nil
	}
	return ParseEgressAllow(raw)
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
