package acp

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/dbirks/communication/internal/domain"
)

// TestFactoryResolvesLauncher: the registry, not the caller, decides the
// executable and pinned version; unknown launchers and missing executables
// fail before any process is spawned.
func TestFactoryResolvesLauncher(t *testing.T) {
	f := &Factory{
		Lookup: func(id string) (Launcher, bool) {
			if id == "claude" {
				return Launcher{ID: "claude", Executable: "definitely-not-on-path-xyz", Version: "0.90.0", AskModeID: "default"}, true
			}
			return Launcher{}, false
		},
		LookPath: func(file string) (string, error) { return "/fake/" + file, nil },
	}
	if _, err := f.NewSession(context.Background(), domain.SessionRequest{LauncherID: "nope"}); err == nil ||
		!strings.Contains(err.Error(), "unknown launcher") {
		t.Fatalf("unknown launcher error = %v", err)
	}
	if _, err := f.NewSession(context.Background(), domain.SessionRequest{
		LauncherID: "claude", WorkDir: t.TempDir(),
	}); err == nil || !strings.Contains(err.Error(), "definitely-not-on-path-xyz") {
		t.Fatalf("missing executable error = %v", err)
	}

	// A LookPath failure is reported with the launcher id so operators can
	// map it to the pinned package.
	f2 := &Factory{
		Lookup:   func(string) (Launcher, bool) { return Launcher{ID: "codex", Executable: "codex-acp"}, true },
		LookPath: func(string) (string, error) { return "", errors.New("not found") },
	}
	if _, err := f2.NewSession(context.Background(), domain.SessionRequest{LauncherID: "codex"}); err == nil ||
		!strings.Contains(err.Error(), "codex") {
		t.Fatalf("lookpath error = %v, want it to name launcher codex", err)
	}
}

// TestFactoryCarriesSessionOptions is covered by startInProcessOpts in
// session_test.go: the factory's own contract ends at building the spec —
// plumbing exec.Cmd in a unit test would assert nothing the handshake tests
// do not already pin.
