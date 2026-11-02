package worker

// ADR-0069 (P5's egress half): the launcher registry's *operator-configured*
// provider base URL (COMMUNICATION_PI_BASE_URL for pi) is a host the worker's
// own operator named, so it joins the resolved agent-turn allowlist whenever
// the axis is or defaults to allowlisted. Without it a launched pi reaches
// for its gateway and eats a proxy 403 — the exact fail SANDBOX.md P5
// predicted. Pipeline documents and profile rows still cannot touch any of
// this (ADR-0035), and an explicit `open` needs no addition.

import (
	"os"
	"testing"

	"github.com/dbirks/communication/internal/sandbox/nono"
)

const providerTestHost = "llm-collective.e-gineering.com"

func piBaseURLEnv(t *testing.T) {
	t.Helper()
	t.Setenv("COMMUNICATION_PI_BASE_URL", "https://"+providerTestHost+"/v1")
	t.Setenv("COMMUNICATION_PI_MODEL", "flint")
}

func TestLauncherProviderHostJoinsTheResolvedAllowlist(t *testing.T) {
	piBaseURLEnv(t)

	t.Run("field allowlist plus the provider host", func(t *testing.T) {
		net, hosts, err := agentEgressAllow([]string{"github.com"})
		if err != nil {
			t.Fatalf("agentEgressAllow: %v", err)
		}
		if net != nono.NetworkAllowlisted {
			t.Fatalf("net = %q, want allowlisted", net)
		}
		if !hostAllowed(hosts, "github.com") || !hostAllowed(hosts, providerTestHost) {
			t.Errorf("hosts = %v, want the operator list AND the provider host", hosts)
		}
	})

	t.Run("explicit env list plus the provider host", func(t *testing.T) {
		t.Setenv(EnvAgentEgressAllow, "api.anthropic.com,github.com")
		net, hosts, err := agentEgressAllow(nil)
		if err != nil {
			t.Fatalf("agentEgressAllow: %v", err)
		}
		if net != nono.NetworkAllowlisted || !hostAllowed(hosts, providerTestHost) {
			t.Errorf("net=%q hosts=%v, want allowlisted containing %s", net, hosts, providerTestHost)
		}
	})

	t.Run("open stays open: nothing is added to an unbounded axis", func(t *testing.T) {
		t.Setenv(EnvAgentEgressAllow, "open")
		net, hosts, err := agentEgressAllow(nil)
		if err != nil {
			t.Fatalf("open: %v", err)
		}
		if net != nono.NetworkOpen || len(hosts) != 0 {
			t.Errorf("net=%q hosts=%v, want open with no list", net, hosts)
		}
	})
}

func TestLauncherProviderHostWithoutOperatorEnvIsDefaultPlusProvider(t *testing.T) {
	if _, ok := os.LookupEnv(EnvAgentEgressAllow); ok {
		t.Skipf("%s is set in this test environment; the no-configuration arm needs it unset", EnvAgentEgressAllow)
	}
	piBaseURLEnv(t)
	net, hosts, err := agentEgressAllow(nil)
	if err != nil {
		t.Fatalf("agentEgressAllow: %v", err)
	}
	if net != nono.NetworkAllowlisted {
		t.Fatalf("net = %q, want allowlisted (the shipped default made explicit)", net)
	}
	if !hostAllowed(hosts, providerTestHost) {
		t.Errorf("hosts = %v, want the provider host present", hosts)
	}
	for _, h := range nono.DefaultEgressHosts() {
		if !hostAllowed(hosts, h) {
			t.Errorf("hosts = %v, want the shipped default (%v) kept", hosts, h)
		}
	}
}

func TestLauncherProviderHostWithoutProviderEnvIsNoChange(t *testing.T) {
	t.Setenv("COMMUNICATION_PI_BASE_URL", "")
	t.Setenv("COMMUNICATION_PI_MODEL", "")
	net, hosts, err := agentEgressAllow(nil)
	if err != nil {
		t.Fatalf("agentEgressAllow: %v", err)
	}
	if net != "" || hosts != nil {
		t.Errorf("no provider config must leave the resolution untouched, got net=%q hosts=%v", net, hosts)
	}
	net, hosts, err = agentEgressAllow([]string{"api.anthropic.com"})
	if err != nil {
		t.Fatal(err)
	}
	if net != nono.NetworkAllowlisted || len(hosts) != 1 || hosts[0] != "api.anthropic.com" {
		t.Errorf("without a provider config the list must not move: %v", hosts)
	}
}

func TestMalformedProviderBaseURLFailsClosed(t *testing.T) {
	t.Setenv("COMMUNICATION_PI_BASE_URL", "not a url")
	t.Setenv("COMMUNICATION_PI_MODEL", "flint")
	if _, _, err := agentEgressAllow([]string{"github.com"}); err == nil {
		t.Fatal("a configured-but-unusable provider base URL must fail closed, not silently drop its host")
	}
}
