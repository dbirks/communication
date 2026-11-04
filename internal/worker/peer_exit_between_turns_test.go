package worker_test

import (
	"bytes"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/dbirks/communication/internal/agent/acp"
	"github.com/dbirks/communication/internal/events"
	"github.com/dbirks/communication/internal/worker"
)

// peer-exit-between-turns repro for worker-stall-2: the lab shape (run
// 41921504494) is a conversation turn that completes, the agent process
// exiting moments later (pi-acp exits after its turn), and the SAME
// conversation claimed again — on a worker whose live-session map still holds
// the dead session. The loop must not ride the dead session into a second
// turn claiming `reused`: it must notice the process is gone, close the
// session honestly, and start a fresh one for the next turn.

// completeThenDieScript answers the whole handshake and the prompt
// (stop_reason end_turn), then touches its exit marker and exits — like the
// lab's pi-acp. The marker lets the test order the second claim AFTER the
// process is gone, which is the between-turns shape under test (not the
// mid-turn death).
const completeThenDieScript = `#!/bin/bash
exec 2>/dev/null
read -r line
echo '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentCapabilities":{},"agentInfo":{"name":"fake","version":"0.1"}}}'
read -r line
echo '{"jsonrpc":"2.0","id":2,"result":{"sessionId":"fake-session"}}'
read -r line
echo '{"jsonrpc":"2.0","id":3,"result":{}}'
read -r line
echo '{"jsonrpc":"2.0","id":4,"result":{"stopReason":"end_turn"}}'
# Touch the exit marker, then die: the marker proves the process is gone.
if [ -n "$FAKE_ACP_EXIT_MARKER" ]; then touch "$FAKE_ACP_EXIT_MARKER"; fi
exit 0
`

func newCompleteThenDieSpawn(t *testing.T) (*planFactory, func() bool) {
	t.Helper()
	dir := t.TempDir()
	script := filepath.Join(dir, "fake-acp.sh")
	if err := os.WriteFile(script, []byte(completeThenDieScript), 0o755); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(dir, "exited")
	launcher := acp.Launcher{
		ID: "fake", DisplayName: "fake", Executable: "/bin/bash",
		Args: []string{script}, Version: "0.1",
	}
	return &planFactory{
		inner: &acp.Factory{
			Runtime: &acp.Runtime{},
			Lookup:  func(string) (acp.Launcher, bool) { return launcher, true },
		},
		plan: acp.LaunchPlan{Path: "/bin/bash", Args: []string{script},
			Env: []string{"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "FAKE_ACP_EXIT_MARKER=" + marker}, Dir: dir},
	}, func() bool {
		_, err := os.Stat(marker)
		return err == nil
	}
}

// TestTurnLoopSessionDiesBetweenTurnsRetiresHonest: turn one completes and the
// agent exits; the next claim on the same conversation must end honestly and
// bounded — riding a dead session must neither park the loop nor claim a
// `reused` origin for a process that is gone.
func TestTurnLoopSessionDiesBetweenTurnsRetiresHonest(t *testing.T) {
	spawn, peerExited := newCompleteThenDieSpawn(t)

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
	// The between-turns shape: the first claim hands out immediately, and
	// every later claim is held until the peer process is gone (its exit
	// marker) — the reuse decision is made against a known-dead session, not
	// mid-race.
	var served int32
	st.claimGate = func() error {
		if atomic.AddInt32(&served, 1) > 1 {
			deadline := time.Now().Add(30 * time.Second)
			for !peerExited() {
				if time.Now().After(deadline) {
					return errors.New("timed out waiting for the peer to exit")
				}
				time.Sleep(5 * time.Millisecond)
			}
		}
		return nil
	}

	buf := &bytes.Buffer{}
	logger := &captureLog{buf: buf}
	l, err := worker.NewTurnLoop(cfg, st, spawn, &fakeWork{dir: t.TempDir()}, func() string {
		return "worker-1"
	}, worker.WithTurnLogger(slog.New(slog.NewTextHandler(logger, &slog.HandlerOptions{Level: slog.LevelInfo}))))
	if err != nil {
		t.Fatalf("NewTurnLoop: %v", err)
	}
	startLoop(t, l)

	// First turn completes on the live session.
	select {
	case out := <-st.finishing:
		if out.Status != events.TurnStatusCompleted {
			t.Fatalf("first terminal = %+v, want completed", out)
		}
	case <-time.After(60 * time.Second):
		t.Fatal("first turn never reached a terminal")
	}

	// The peer process is now gone; give its reap a moment to land.
	// The fixed behavior: the second turn must COMPLETE — the loop retires
	// the dead session at reuse (binding closed, conversation idle,
	// agent.session.disconnected process_exited) and starts a fresh agent in
	// the prepared workspace, instead of riding a closed connection into a
	// failed turn (worker-stall-2, lab run 41921504494).
	select {
	case out := <-st.finishing:
		t.Logf("second terminal: %s %s", out.Status, out.Message)
		if out.Status != events.TurnStatusCompleted {
			t.Fatalf("second terminal = %+v, want completed on a fresh session", out)
		}
	case <-time.After(120 * time.Second):
		t.Fatalf("the loop parked after the session's process exited between turns\nlog:\n%s", logger.text())
	}

	// Honesty of the retirement: the binding closed with the process-exited
	// reason, and the conversation was moved back to idle for the fresh
	// session's own connected event.
	select {
	case cb := <-st.closedBinds:
		if cb.conversation != claim.ConversationID || cb.reason != "process_exited" {
			t.Fatalf("binding close = %+v, want conversation %s reason process_exited", cb, claim.ConversationID)
		}
	case <-time.After(10 * time.Second):
		t.Fatalf("the dead session's binding was never closed\nlog:\n%s", logger.text())
	}
	logged := logger.text()
	if strings.Contains(logged, "panic") {
		t.Fatalf("loop panicked:\n%s", logged)
	}
}
