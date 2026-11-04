package worker_test

import (
	"context"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/dbirks/communication/internal/agent/acp"
	"github.com/dbirks/communication/internal/domain"
	"github.com/dbirks/communication/internal/events"
	"github.com/dbirks/communication/internal/worker"
)

// peer-exit-at-start repro for worker-stall-2 (lab run 41921504494, commit
// 056d28b): the ACP peer's process exits ~immediately after launch, before it
// has answered the protocol steps the worker is waiting for. Two shapes:
//
//   - "before-init": the process exits before replying to initialize;
//   - "before-new":  it answers initialize, then exits before replying to
//     session/new (and before session/load would answer, on the resume path).
//
// Both must end the turn as an honest failed terminal within a bounded time,
// and the loop must keep claiming — a peer that dies at session start must
// never park the worker's claim loop.

// peerExitBound is how long a turn may take to reach its honest terminal
// after the peer died at session start. The teardown ladder is a few seconds;
// minutes mean a parked loop, not a slow wait.
const peerExitBound = 60 * time.Second

// exitBeforeInitScript exits right after launch, before replying to anything.
const exitBeforeInitScript = `#!/bin/bash
exec 2>/dev/null
sleep 0.05
exit 1
`

// exitBeforeNewScript answers initialize, then exits before replying to the
// next request (session/load or session/new).
const exitBeforeNewScript = `#!/bin/bash
exec 2>/dev/null
read -r line
echo '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentCapabilities":{"loadSession":true},"agentInfo":{"name":"fake","version":"0.1"}}}'
sleep 0.05
exit 1
`

func newExitAtStartSpawn(t *testing.T, script string) *planFactory {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "fake-acp.sh")
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	launcher := acp.Launcher{
		ID: "fake", DisplayName: "fake", Executable: "/bin/bash",
		Args: []string{path}, Version: "0.1",
	}
	return &planFactory{
		inner: &acp.Factory{
			Runtime: &acp.Runtime{},
			Lookup:  func(string) (acp.Launcher, bool) { return launcher, true },
		},
		plan: acp.LaunchPlan{Path: "/bin/bash", Args: []string{path},
			Env: []string{"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"}, Dir: dir},
	}
}

// runPeerExitAtStart asserts the conversation turn loop ends the claimed turn
// as a failed terminal within the bound and keeps claiming, for a peer that
// dies at session start. resume adds a resumable binding so the loop takes the
// session/load → session/new fallback path.
func runPeerExitAtStart(t *testing.T, script string, resume bool) {
	t.Helper()
	spawn := newExitAtStartSpawn(t, script)

	cfg := fastCfg()
	cfg.AskModeID = func(id string) string {
		if id == "fake" {
			return "default"
		}
		return ""
	}

	claim := testClaim()
	claim.LauncherID = "fake"
	second := testClaim()
	second.TurnID = "turn-2"
	second.LauncherID = "fake"
	st := newFakeStore()
	st.claims = []worker.Claim{claim, second}
	if resume {
		st.resumableOK = true
		st.resumable = domain.SessionInfo{ACPSessionID: "old-session", Origin: "new"}
	}

	l, err := worker.NewTurnLoop(cfg, st, spawn, &fakeWork{dir: t.TempDir()}, func() string {
		return "worker-1"
	})
	if err != nil {
		t.Fatalf("NewTurnLoop: %v", err)
	}
	startLoop(t, l)

	// The first turn must reach an honest failed terminal quickly (bounded,
	// not forever): the peer is gone at session start.
	select {
	case out := <-st.finishing:
		if out.Status != events.TurnStatusFailed {
			t.Fatalf("first terminal = %+v, want failed (the peer died at session start)", out)
		}
	case <-time.After(peerExitBound):
		t.Fatal("the turn never reached a terminal within the bound of the peer dying at session start; the claim loop is parked")
	}

	// The loop must keep working: a second claim is claimed and run.
	select {
	case out := <-st.finishing:
		if out.Status != events.TurnStatusFailed {
			t.Fatalf("second terminal = %+v, want failed", out)
		}
	case <-time.After(peerExitBound):
		t.Fatal("the loop did not claim the next turn after the peer died at session start")
	}
}

// TestTurnLoopPeerExitsBeforeInitializeKeepsWorking: the process exits before
// replying to initialize.
func TestTurnLoopPeerExitsBeforeInitializeKeepsWorking(t *testing.T) {
	runPeerExitAtStart(t, exitBeforeInitScript, false)
}

// TestTurnLoopPeerExitsBeforeSessionNewKeepsWorking: the process answers
// initialize, then exits before replying to session/new.
func TestTurnLoopPeerExitsBeforeSessionNewKeepsWorking(t *testing.T) {
	runPeerExitAtStart(t, exitBeforeNewScript, false)
}

// TestTurnLoopPeerExitsBeforeSessionLoadFallbackKeepsWorking: the resume shape
// — a resumable binding exists, session/load must fail (the peer is gone) and
// the fallback to session/new must also fail; the turn ends failed and the
// loop keeps claiming.
func TestTurnLoopPeerExitsBeforeSessionLoadFallbackKeepsWorking(t *testing.T) {
	runPeerExitAtStart(t, exitBeforeNewScript, true)
}

// The attempt-path legs live in peer_exit_start_internal_test.go (package
// worker), because the agent.acp executor fixture is internal.

var _ = context.Background
var _ = io.Discard
var _ = slog.Default
