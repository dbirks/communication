package worker

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
)

// attempt leg of the peer-exit-at-start repro (worker-stall-2, lab run
// 41921504494): the agent.acp executor must fail the attempt honestly within
// the bound instead of parking the attempt loop, when the peer dies at
// session start. It lives in the internal test package because the fixture
// (newAgentTurnFixture) is internal; the conversation-turn legs live in
// peer_exit_start_test.go (worker_test).

// exitBeforeInitScriptInternal exits right after launch, before replying to
// anything. (Mirrors the worker_test constant; test packages cannot share.
// )
const exitBeforeInitScriptInternal = `#!/bin/bash
exec 2>/dev/null
sleep 0.05
exit 1
`

// exitBeforeNewScriptInternal answers initialize, then exits before replying
// to the next request (session/load or session/new).
const exitBeforeNewScriptInternal = `#!/bin/bash
exec 2>/dev/null
read -r line
echo '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentCapabilities":{"loadSession":true},"agentInfo":{"name":"fake","version":"0.1"}}}'
sleep 0.05
exit 1
`

// planFactoryInternal mirrors worker_test.planFactory for the internal legs.
type planFactoryInternal struct {
	inner *acp.Factory
	plan  acp.LaunchPlan
}

func (p *planFactoryInternal) NewSession(ctx context.Context, req domain.SessionRequest) (domain.AgentSession, error) {
	return p.inner.NewSession(acp.WithLaunchPlan(ctx, p.plan), req)
}

func newExitAtStartSpawnInternal(t *testing.T, script string) *planFactoryInternal {
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
	return &planFactoryInternal{
		inner: &acp.Factory{
			Runtime: &acp.Runtime{},
			Lookup:  func(string) (acp.Launcher, bool) { return launcher, true },
		},
		plan: acp.LaunchPlan{Path: "/bin/bash", Args: []string{path},
			Env: []string{"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"}, Dir: dir},
	}
}

// runPeerExitAtStartAttempt drives the real agent.acp executor against a real
// ACP child that dies at session start and asserts the attempt lands an
// honest failed terminal within the bound.
func runPeerExitAtStartAttempt(t *testing.T, script string) {
	t.Helper()
	spawn := newExitAtStartSpawnInternal(t, script)
	f := newAgentTurnFixture(t, domain.EnforceDisabled)
	f.turn.Spawn = spawn
	f.turn.Profiles = &profilesStub{ok: true, prof: AgentProfile{
		AgentProfileID: "m4-implementer", LauncherID: "fake", PermissionMode: "deny",
	}}
	f.turn.AskModeID = func(string) string { return "default" }
	f.turn.Logger = slog.New(slog.NewTextHandler(io.Discard, nil))

	type result struct {
		res AttemptResult
		err error
	}
	done := make(chan result, 1)
	go func() {
		res, err := f.turn.Execute(context.Background(), f.claim(agentCfg("hello")), f.sink)
		done <- result{res, err}
	}()

	select {
	case r := <-done:
		if r.err != nil {
			t.Fatalf("Execute: %v", r.err)
		}
		if r.res.Status != AttemptStatusFailed {
			t.Fatalf("res = %+v, want failed (the peer died at session start)", r.res)
		}
	case <-time.After(60 * time.Second):
		t.Fatal("the attempt never reached its terminal within the bound of the peer dying at session start; the attempt loop is parked")
	}
}

// TestAgentTurnPeerExitsBeforeInitializeFailsInternal: the attempt path, peer
// dead before initialize.
func TestAgentTurnPeerExitsBeforeInitializeFailsInternal(t *testing.T) {
	runPeerExitAtStartAttempt(t, exitBeforeInitScriptInternal)
}

// TestAgentTurnPeerExitsBeforeSessionNewFailsInternal: the attempt path, peer
// dead after initialize but before session/new.
func TestAgentTurnPeerExitsBeforeSessionNewFailsInternal(t *testing.T) {
	runPeerExitAtStartAttempt(t, exitBeforeNewScriptInternal)
}
