package main

// The startup gate for the agent-turn TCP probe (docs/compatibility/SANDBOX.md,
// Talos EPERM finding) withholds the agent.acp executor, not the worker: when
// the probe reports EPERM under af_unix_mediation=pathname, runWorker passes a
// nil agentTurn to newAttemptExecutors — the same shape model.chat gets with no
// endpoint — and every non-agent kind keeps working. This test drives the
// exact wiring the worker builds at boot.

import (
	"context"
	"testing"

	"github.com/dbirks/communication/internal/worker"
)

func TestAttemptExecutorsKeepNonAgentKindsWhenAgentTurnsAreWithheld(t *testing.T) {
	chain := attemptChain{
		prepare: func(context.Context, worker.AttemptClaim) error { return nil },
		boundary: func(context.Context, worker.AttemptClaim) (worker.RestoreBoundary, bool, error) {
			return worker.RestoreBoundary{}, false, nil
		},
		git: &chainGit{order: &[]string{}},
	}
	inner := &chainProbe{name: "exec", order: &[]string{}}

	// The EPERM outcome: the startup probe withheld agent turns, so
	// runWorker hands a nil agentTurn.
	execs := newAttemptExecutors(chain, inner, nil, inner, nil)
	if _, ok := execs[worker.NodeKindAgentACP]; ok {
		t.Fatal("agent.acp registered although the startup probe withheld agent turns")
	}
	// The worker keeps serving the kinds it can run.
	for _, kind := range []string{worker.NodeKindProcessExec, worker.NodeKindArtifactPublish} {
		if execs[kind] == nil {
			t.Fatalf("kind %s must keep working while agent turns are withheld", kind)
		}
	}

	// The ok outcome: agent.acp registers.
	if newAttemptExecutors(chain, inner, inner, inner, nil)[worker.NodeKindAgentACP] == nil {
		t.Fatal("agent.acp missing although the startup probe passed")
	}
}

// TestPtraceScopeValue never fails on a healthy host: it reads a kernel file
// and reports "unreadable" when the file is not there. The log line must never
// refuse to name its source.
func TestPtraceScopeValue(t *testing.T) {
	got := ptraceScopeValue()
	if got == "" {
		t.Fatal("ptraceScopeValue returned the empty string; the log line would name an empty source")
	}
	t.Logf("kernel.yama.ptrace_scope=%s", got)
}
