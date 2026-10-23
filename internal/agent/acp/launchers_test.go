package acp

import "testing"

func TestLookupLauncherHit(t *testing.T) {
	want := map[string][3]string{
		"claude": {"claude-agent-acp", "0.90.0", "default"},
		"codex":  {"codex-acp", "2.2.2", "read-only"},
		"pi":     {"pi-acp", "0.0.34", ""},
	}
	for id, w := range want {
		l, ok := LookupLauncher(id)
		if !ok {
			t.Fatalf("LookupLauncher(%q) not found", id)
		}
		if l.Executable != w[0] || l.Version != w[1] {
			t.Errorf("LookupLauncher(%q) = %q@%q, want %q@%q", id, l.Executable, l.Version, w[0], w[1])
		}
		// The ask-mode ids are the observed prompting modes; a change here
		// is a compatibility-matrix event, not a refactor (ACP.md).
		if l.AskModeID != w[2] {
			t.Errorf("LookupLauncher(%q).AskModeID = %q, want %q", id, l.AskModeID, w[2])
		}
		if l.ID != id {
			t.Errorf("ID = %q, want %q", l.ID, id)
		}
		if l.Package == "" || l.DisplayName == "" {
			t.Errorf("entry %q has empty Package or DisplayName: %+v", id, l)
		}
	}
}

func TestLookupLauncherMiss(t *testing.T) {
	for _, id := range []string{"", "gemini", "Claude", "unknown-xyz"} {
		if l, ok := LookupLauncher(id); ok {
			t.Errorf("LookupLauncher(%q) = %+v, want not found", id, l)
		}
	}
}

func TestKnownLaunchersRegistry(t *testing.T) {
	ls := KnownLaunchers()
	if len(ls) != 3 {
		t.Fatalf("KnownLaunchers() returned %d entries, want exactly 2: %+v", len(ls), ls)
	}
	for i, l := range ls {
		if l.ID == "" || l.Executable == "" {
			t.Errorf("entry %d has empty ID or Executable: %+v", i, l)
		}
		if _, ok := LookupLauncher(l.ID); !ok {
			t.Errorf("entry %q is not resolvable via LookupLauncher", l.ID)
		}
	}
	// Mutating the result must not affect the registry.
	ls[0].ID = "tampered"
	if again := KnownLaunchers(); again[0].ID == "tampered" {
		t.Error("KnownLaunchers returns an alias of the registry; mutation leaked")
	}
}
