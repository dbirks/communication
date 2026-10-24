package acp

import (
	"strings"
	"testing"
)

// TestAuthEnvForNeverEmitsCredentialValueVars pins the 2026-10-24 M4 lab
// finding for launcher pi: pi declares OPENAI_API_KEY in AuthEnvVars AND as
// its ApiKeyEnv, and resolveLauncherApiKeys sources the gateway key into the
// worker process environment under exactly that name. AuthEnvFor's output is
// consumed as a list of credential LOCATIONS — the worker stats each one as a
// directory (internal/worker/unit.go credentialDirs, agentturn.go
// credentialAuth) and the sandbox launcher renders the entries into an
// `env NAME=value` hop that nono's audit journal records verbatim — so
// emitting a credential VALUE through it made the worker fail
// `os.Stat(<secret>)` and journal the key inside the error text
// (conversation.turn.failed: `launcher "pi" declares a credential directory
// at llmc_…`), violating ADR-0040/ADR-0059's delivery rule. Value variables —
// ApiKeyEnv, OAuthTokenEnv — are therefore never enumerated as locations.
func TestAuthEnvForNeverEmitsCredentialValueVars(t *testing.T) {
	const sentinel = "SENTINEL-not-a-path-8f2c"

	t.Run("pi key is not enumerated as a credential directory", func(t *testing.T) {
		pi, ok := LookupLauncher("pi")
		if !ok {
			t.Fatal("the pi launcher disappeared from the registry (ADR-0059)")
		}
		if pi.ApiKeyEnv == "" {
			t.Fatal("pi must declare an ApiKeyEnv for the file-delivered key")
		}
		got := AuthEnvFor(pi, []string{
			pi.ApiKeyEnv + "=" + sentinel,
			"PATH=/usr/bin",
		})
		for _, kv := range got {
			if strings.Contains(kv, sentinel) {
				t.Fatalf("AuthEnvFor leaked the API-key value as a credential location: %q — the worker would os.Stat it and journal the secret in the error", kv)
			}
		}
		if len(got) != 0 {
			t.Fatalf("pi's only auth var is its value-carrying ApiKeyEnv; nothing may be enumerated, got %v", got)
		}
	})

	t.Run("directory auth vars still resolve unchanged", func(t *testing.T) {
		claude, ok := LookupLauncher("claude")
		if !ok {
			t.Fatal("the claude launcher disappeared from the registry")
		}
		// CLAUDE_CONFIG_DIR is a location and must still be emitted; the
		// OAuthTokenEnv value (a secret) must never be, even if an operator
		// also names it in AuthEnvVars.
		clone := claude
		clone.AuthEnvVars = append(append([]string{}, claude.AuthEnvVars...), claude.OAuthTokenEnv)
		got := AuthEnvFor(clone, []string{
			"CLAUDE_CONFIG_DIR=/harness/claude",
			clone.OAuthTokenEnv + "=" + sentinel,
		})
		want := map[string]bool{}
		for _, kv := range got {
			if strings.Contains(kv, sentinel) {
				t.Fatalf("AuthEnvFor leaked the OAuth token value: %q", kv)
			}
			want[kv] = true
		}
		if !want["CLAUDE_CONFIG_DIR=/harness/claude"] {
			t.Fatalf("directory auth var disappeared: %v", got)
		}
	})

	t.Run("synthetic launcher splits location and value by the same name rules", func(t *testing.T) {
		l := Launcher{
			ID:          "synthetic",
			AuthEnvVars: []string{"SYNTH_HOME", "SYNTH_KEY"},
			ApiKeyEnv:   "SYNTH_KEY",
		}
		got := AuthEnvFor(l, []string{"SYNTH_HOME=/srv/synth", "SYNTH_KEY=" + sentinel})
		if len(got) != 1 || got[0] != "SYNTH_HOME=/srv/synth" {
			t.Fatalf("want only the directory entry, got %v", got)
		}
	})
}
