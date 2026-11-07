package main

import (
	"strings"
	"testing"

	"github.com/dbirks/communication/internal/api"
)

func envOf(kv map[string]string) func(string) string {
	return func(k string) string { return kv[k] }
}

func TestServeRateLimitsDefaults(t *testing.T) {
	got, err := serveRateLimits(envOf(map[string]string{}))
	if err != nil {
		t.Fatalf("empty environment: %v", err)
	}
	want := api.RateLimits{
		Auth:      api.LimitSpec{PerMinute: 10, Burst: 20},
		Assistant: api.LimitSpec{PerMinute: 30, Burst: 10},
		Issues:    api.LimitSpec{PerMinute: 60, Burst: 30},
		// ADR-0077 defaults.
		MaxStreamsPerPrincipal: 16,
	}
	if got != want {
		t.Fatalf("defaults = %+v, want %+v", got, want)
	}
}

func TestServeRateLimitsZeroDisables(t *testing.T) {
	got, err := serveRateLimits(envOf(map[string]string{
		"COMMUNICATION_RATE_AUTH_PER_MIN":      "0",
		"COMMUNICATION_RATE_ASSISTANT_PER_MIN": "0",
		"COMMUNICATION_RATE_ISSUES_PER_MIN":    "0",
		"COMMUNICATION_RATE_MAX_STREAMS":       "0",
		"COMMUNICATION_TRUSTED_PROXY_HOPS":     "1",
	}))
	if err != nil {
		t.Fatalf("lab override environment: %v", err)
	}
	if got.Auth.PerMinute != 0 || got.Assistant.PerMinute != 0 || got.Issues.PerMinute != 0 {
		t.Fatalf("a 0 rate still throttles: %+v", got)
	}
	if got.MaxStreamsPerPrincipal != 0 {
		t.Fatalf("MaxStreamsPerPrincipal = %d, want the configured 0", got.MaxStreamsPerPrincipal)
	}
	if got.TrustedProxyHops != 1 {
		t.Fatalf("TrustedProxyHops = %d, want 1", got.TrustedProxyHops)
	}
}

func TestServeRateLimitsOverrides(t *testing.T) {
	got, err := serveRateLimits(envOf(map[string]string{
		"COMMUNICATION_RATE_AUTH_PER_MIN":      "5",
		"COMMUNICATION_RATE_AUTH_BURST":        "7",
		"COMMUNICATION_RATE_ASSISTANT_PER_MIN": "1",
		"COMMUNICATION_RATE_ASSISTANT_BURST":   "2",
		"COMMUNICATION_RATE_ISSUES_PER_MIN":    "120",
		"COMMUNICATION_RATE_ISSUES_BURST":      "40",
		"COMMUNICATION_RATE_MAX_STREAMS":       "3",
	}))
	if err != nil {
		t.Fatalf("custom environment: %v", err)
	}
	if got.Auth != (api.LimitSpec{PerMinute: 5, Burst: 7}) {
		t.Fatalf("Auth = %+v", got.Auth)
	}
	if got.Assistant != (api.LimitSpec{PerMinute: 1, Burst: 2}) {
		t.Fatalf("Assistant = %+v", got.Assistant)
	}
	if got.Issues != (api.LimitSpec{PerMinute: 120, Burst: 40}) {
		t.Fatalf("Issues = %+v", got.Issues)
	}
	if got.MaxStreamsPerPrincipal != 3 {
		t.Fatalf("MaxStreamsPerPrincipal = %d", got.MaxStreamsPerPrincipal)
	}
}

func TestServeRateLimitsRejectsBadValues(t *testing.T) {
	for name, kv := range map[string]map[string]string{
		"auth per-minute unparseable": {"COMMUNICATION_RATE_AUTH_PER_MIN": "ten"},
		"auth burst negative":         {"COMMUNICATION_RATE_AUTH_BURST": "-1"},
		"assistant unparseable":       {"COMMUNICATION_RATE_ASSISTANT_PER_MIN": "30/min"},
		"issues burst unparseable":    {"COMMUNICATION_RATE_ISSUES_BURST": "thirty"},
		"streams negative":            {"COMMUNICATION_RATE_MAX_STREAMS": "-1"},
		"proxy hops negative":         {"COMMUNICATION_TRUSTED_PROXY_HOPS": "-2"},
		"proxy hops unparseable":      {"COMMUNICATION_TRUSTED_PROXY_HOPS": "yes"},
	} {
		_, err := serveRateLimits(envOf(kv))
		if err == nil {
			t.Fatalf("%s: accepted, want a startup refusal", name)
		}
		if !strings.Contains(err.Error(), "COMMUNICATION_") {
			t.Fatalf("%s: error %q must name the variable", name, err)
		}
	}
}
