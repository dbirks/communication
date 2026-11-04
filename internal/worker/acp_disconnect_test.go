package worker_test

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dbirks/communication/internal/agent/acp"
	"github.com/dbirks/communication/internal/domain"
	"github.com/dbirks/communication/internal/events"
	"github.com/dbirks/communication/internal/worker"
)

// fakeACPScript is a minimal stdio ACP agent. It answers initialize,
// session/new and session/set_mode, streams one chunk on session/prompt and
// then either dies (die) or closes its stdout while keeping its process tree
// alive (pipeclose). The pipeclose flavor is the lab-41789603709 shape: the
// peer is gone but the harness is not, and its grandchild still holds the
// stderr pipe, so a teardown that only kills the direct process wedges.
const fakeACPScript = `#!/bin/bash
if [ "$FAKE_STUBBORN" = "1" ]; then trap '' TERM; fi
read -r line
echo '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentCapabilities":{},"agentInfo":{"name":"fake","version":"0.1"}}}'
read -r line
echo '{"jsonrpc":"2.0","id":2,"result":{"sessionId":"fake-session"}}'
read -r line
echo '{"jsonrpc":"2.0","id":3,"result":{}}'
read -r line
echo '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"fake-session","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"working on it"}}}}'
if [ "$FAKE_PIPECLOSE" = "1" ]; then
  exec 1>&-
  sleep 300 &
  wait
else
  exit 7
fi
`

// planFactory wraps a real acp.Factory, attaching a launch plan to the spawn
// context (the unit path's job, done by hand here so the real ACP client
// speaks to a real subprocess over a real stdio pipe).
type planFactory struct {
	inner *acp.Factory
	plan  acp.LaunchPlan
}

func (p *planFactory) NewSession(ctx context.Context, req domain.SessionRequest) (domain.AgentSession, error) {
	return p.inner.NewSession(acp.WithLaunchPlan(ctx, p.plan), req)
}

// captureLog is a locked writer that records everything a slog text handler
// emits, so a test can assert a WARN actually reached the worker logger.
type captureLog struct {
	mu  sync.Mutex
	buf *bytes.Buffer
}

func (c *captureLog) Write(p []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.buf.Write(p)
}
func (c *captureLog) text() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.buf.String()
}

// newPeerCloseSpawn builds a real ACP spawn whose child is the fake script.
// pipeClose keeps the process tree alive after the peer closes its stdio;
// stubborn makes the whole tree ignore SIGTERM (forcing the SIGKILL rung).
func newPeerCloseSpawn(t *testing.T, pipeClose, stubborn bool) *planFactory {
	t.Helper()
	dir := t.TempDir()
	script := filepath.Join(dir, "fake-acp.sh")
	if err := os.WriteFile(script, []byte(fakeACPScript), 0o755); err != nil {
		t.Fatal(err)
	}
	env := []string{"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"}
	if pipeClose {
		env = append(env, "FAKE_PIPECLOSE=1")
	}
	if stubborn {
		env = append(env, "FAKE_STUBBORN=1")
	}
	launcher := acp.Launcher{
		ID: "fake", DisplayName: "fake", Executable: "/bin/bash",
		Args: []string{script}, Version: "0.1",
	}
	return &planFactory{
		inner: &acp.Factory{
			Runtime: &acp.Runtime{},
			Lookup:  func(string) (acp.Launcher, bool) { return launcher, true },
		},
		plan: acp.LaunchPlan{Path: "/bin/bash", Args: []string{script}, Env: env, Dir: dir},
	}
}

// runPeerCloseTurnLoop drives the real conversation turn loop against a real
// ACP child that loses its connection mid-turn. It asserts the turn lands an
// honest terminal, the mid-turn death is WARNed with the turn id, and the loop
// keeps claiming — the whole point being that one dead session must not wedge
// the worker's main loop.
func runPeerCloseTurnLoop(t *testing.T, pipeClose, stubborn bool) {
	t.Helper()
	spawn := newPeerCloseSpawn(t, pipeClose, stubborn)

	cfg := fastCfg()
	cfg.AskModeID = func(id string) string {
		if id == "claude" || id == "fake" {
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

	buf := &bytes.Buffer{}
	logger := &captureLog{buf: buf}
	l, err := worker.NewTurnLoop(cfg, st, spawn, &fakeWork{dir: t.TempDir()}, func() string {
		return "worker-1"
	}, worker.WithTurnLogger(slog.New(slog.NewTextHandler(logger, &slog.HandlerOptions{Level: slog.LevelWarn}))))
	if err != nil {
		t.Fatalf("NewTurnLoop: %v", err)
	}
	startLoop(t, l)

	// The first turn must reach an honest failed terminal quickly: the peer is
	// gone, so the turn cannot complete and must not hang.
	out := recv(t, st.finishing, "first FinishTurn")
	if out.Status != events.TurnStatusFailed {
		t.Fatalf("first terminal = %+v, want failed (the peer died mid-turn)", out)
	}

	// The loop must keep working: a second claim is claimed and run, proving the
	// turn loop is not wedged behind the dead session.
	out2 := recvLong(t, st.finishing, "second FinishTurn")
	if out2.Status != events.TurnStatusFailed {
		t.Fatalf("second terminal = %+v, want failed", out2)
	}

	// The mid-turn death must be WARNed with the turn id so the next time this
	// happens it is greppable instead of silent.
	logged := logger.text()
	if !strings.Contains(logged, "died mid-turn") || !strings.Contains(logged, "turn-1") {
		t.Errorf("expected a mid-turn WARN naming turn-1, got log:\n%s", logged)
	}
	t.Logf("%v: first terminal=%v second=%v", t.Name(), out.Status, out2.Status)
}

// recvLong is recv with a longer ceiling for the stubborn-tree case, where the
// teardown ladder legitimately spends its SIGTERM window.
func recvLong[T any](t *testing.T, ch <-chan T, what string) T {
	t.Helper()
	select {
	case v := <-ch:
		return v
	case <-time.After(90 * time.Second):
		t.Fatalf("timed out waiting for %s", what)
		var zero T
		return zero
	}
}

// TestTurnLoopPeerDiesMidTurnKeepsWorking is the process-exit leg: the harness
// exits with a turn in flight; the turn fails honestly and the loop moves on.
func TestTurnLoopPeerDiesMidTurnKeepsWorking(t *testing.T) {
	runPeerCloseTurnLoop(t, false, false)
}

// TestTurnLoopPeerPipeClosesMidTurnKeepsWorking is the lab leg: the peer closes
// its stdio while the harness tree lives on. The turn fails honestly, and — the
// regression this fixes — the loop does NOT wedge behind the dead session.
func TestTurnLoopPeerPipeClosesMidTurnKeepsWorking(t *testing.T) {
	runPeerCloseTurnLoop(t, true, false)
}

// TestTurnLoopPeerPipeClosesStubbornTreeKeepsWorking is the worst leg: the
// harness tree ignores SIGTERM, forcing the SIGKILL rung and the WaitDelay
// backstop on a pipe held by an orphan. The loop still must not wedge.
func TestTurnLoopPeerPipeClosesStubbornTreeKeepsWorking(t *testing.T) {
	runPeerCloseTurnLoop(t, true, true)
}

var _ = io.Discard
var _ = fmt.Sprintf
