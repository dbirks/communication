package acp

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestLauncherOAuthTokenKV pins ADR-0040's file contract: read at launch
// time, trimmed, prefix-validated, and fail-closed with an error that never
// names the value.
func TestLauncherOAuthTokenKV(t *testing.T) {
	claude, ok := LookupLauncher("claude")
	if !ok {
		t.Fatal("the claude launcher disappeared from the registry")
	}
	if claude.OAuthTokenEnv != "CLAUDE_CODE_OAUTH_TOKEN" {
		t.Fatalf("claude must deliver the token as CLAUDE_CODE_OAUTH_TOKEN, got %q", claude.OAuthTokenEnv)
	}

	dir := t.TempDir()
	write := func(name, value string) string {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte(value), 0o600); err != nil {
			t.Fatal(err)
		}
		return p
	}
	const good = "sk-ant-oat-abcdef0123"

	t.Setenv(claude.OAuthTokenFileEnv, "")
	kv, err := claude.OAuthTokenKV()
	if err != nil || kv != "" {
		t.Fatalf("no file configured: want no token, got %q, %v", kv, err)
	}

	t.Setenv(claude.OAuthTokenFileEnv, write("good", good+"\n"))
	kv, err = claude.OAuthTokenKV()
	if err != nil {
		t.Fatalf("valid token: %v", err)
	}
	if kv != "CLAUDE_CODE_OAUTH_TOKEN="+good {
		t.Fatalf("unexpected KV %q", kv)
	}

	t.Setenv(claude.OAuthTokenFileEnv, write("empty", "   \n"))
	if _, err = claude.OAuthTokenKV(); err == nil {
		t.Fatal("an empty file must fail closed")
	}

	const bad = "something-wrong"
	t.Setenv(claude.OAuthTokenFileEnv, write("bad", bad))
	_, err = claude.OAuthTokenKV()
	if err == nil {
		t.Fatal("a value without the sk-ant-oat prefix must fail closed")
	}
	if strings.Contains(err.Error(), bad) || strings.Contains(err.Error(), good) {
		t.Fatalf("the error message must never contain the token value: %q", err)
	}

	t.Setenv(claude.OAuthTokenFileEnv, filepath.Join(dir, "missing"))
	if _, err = claude.OAuthTokenKV(); err == nil {
		t.Fatal("a missing file must fail closed")
	}

	// Launchers without the fields are unchanged: no token, no error.
	codex, ok := LookupLauncher("codex")
	if !ok {
		t.Fatal("the codex launcher disappeared from the registry")
	}
	if kv, err := codex.OAuthTokenKV(); err != nil || kv != "" {
		t.Fatalf("codex must not carry a token, got %q, %v", kv, err)
	}
}
