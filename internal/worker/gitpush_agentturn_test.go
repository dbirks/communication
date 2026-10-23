package worker

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dbirks/communication/internal/domain"
)

const gitPushTestToken = "ghp_gitpushtesttokenvalue0000000000"

// TestGitHubTokenDeliveryAgentTurnEnvOnly covers the pipeline-attempt path
// (AgentTurn): the authorized attempt's env carries the token under both names
// plus the git credential helper, and the argv stays clean.
func TestGitHubTokenDeliveryAgentTurnEnvOnly(t *testing.T) {
	f := newAgentTurnFixture(t, domain.EnforceDisabled)
	f.turn.Secrets = &agentSecretsStub{envName: "GH_TOKEN", value: gitPushTestToken, allowlist: map[string]bool{"m4-implementer": true}}
	f.spawn.queue(newAgentSessionStub(domain.SessionInfo{}))

	res, err := f.turn.Execute(context.Background(), f.claim(agentCfg("push the branch")), f.sink)
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if res.Status != AttemptStatusSucceeded {
		t.Fatalf("res = %+v, want succeeded", res)
	}
	plan, ok := f.spawn.lastCtxPlan()
	if !ok {
		t.Fatal("no launch plan reached the session factory")
	}
	envJoined := strings.Join(plan.Env, "\n")
	if !strings.Contains(envJoined, "GH_TOKEN="+gitPushTestToken) || !strings.Contains(envJoined, "GITHUB_TOKEN="+gitPushTestToken) {
		t.Fatalf("the authorized attempt's launch env lacks the token under both names: %v", plan.Env)
	}
	if !strings.Contains(envJoined, "GIT_CONFIG_COUNT=1") {
		t.Fatalf("the authorized attempt's launch env lacks the git credential helper: %v", plan.Env)
	}
	// ADR-0045 follow-up (2026-10-22, product owner decision): the GitHub CLI the
	// agent execs as its child gets a writable config dir under the agent's HOME
	// plus the non-interactive flags — same exec environment, never argv.
	if !strings.Contains(envJoined, "GH_CONFIG_DIR="+filepath.Join(f.layout.Home, "attempts", fakeAttemptID, ".config", "gh")) {
		t.Fatalf("the authorized attempt's launch env lacks the gh config dir: %v", plan.Env)
	}
	if !strings.Contains(envJoined, "GH_PROMPT_DISABLED=1") || !strings.Contains(envJoined, "GH_NO_UPDATE_NOTIFIER=1") {
		t.Fatalf("the authorized attempt's launch env lacks the gh non-interactive flags: %v", plan.Env)
	}
	argv := strings.Join(plan.Args, "\x00")
	if strings.Contains(argv, gitPushTestToken) || strings.Contains(argv, "GH_TOKEN=") || strings.Contains(argv, "GITHUB_TOKEN=") {
		t.Fatalf("the GitHub token reached the launch argv: %q", argv)
	}
}
