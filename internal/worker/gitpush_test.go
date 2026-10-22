package worker_test

import (
	"context"
	"strings"
	"sync"
	"testing"

	"github.com/dbirks/communication/internal/sandbox/nono"
	"github.com/dbirks/communication/internal/worker"
)

// The GitHub push delivery (ADR-0045) behind the agent-held token: a secret
// mounted for an authorized profile arrives as both accepted token names plus
// the git credential-helper configuration, and never through the launch argv.

const gitPushTestToken = "ghp_gitpushtesttokenvalue0000000000"

// gitPushSecretsStub is a SecretMaterializer that hands a delivered env entry
// to the one agent profile its allowlist names and to no other — the
// agentturn_secrets_test.go stub shape, narrowed to the GitHub token.
type gitPushSecretsStub struct {
	mu       sync.Mutex
	requests []worker.MaterializeRequest
	env      []string
	allow    map[string]bool
}

func (s *gitPushSecretsStub) Materialize(_ context.Context, req worker.MaterializeRequest) (worker.Materialized, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.requests = append(s.requests, req)
	if !s.allow[req.AgentProfileID] {
		return worker.Materialized{}, nil
	}
	return worker.Materialized{Env: append([]string(nil), s.env...), Files: []string{}}, nil
}

func (s *gitPushSecretsStub) ReposForWorkspace(context.Context, string) ([]worker.MaterializeRepo, error) {
	return nil, nil
}

// TestGitPushEnvDeliversBothTokenNamesAndGitConfig pins the delivery shape: a
// delivered GitHub token becomes both GH_TOKEN and GITHUB_TOKEN in the launch
// environment and wires git through GIT_CONFIG_* reading $GH_TOKEN.
func TestGitPushEnvDeliversBothTokenNamesAndGitConfig(t *testing.T) {
	got := worker.GitPushEnv([]string{"GH_TOKEN=" + gitPushTestToken})
	joined := strings.Join(got, "\n")
	if !strings.Contains(joined, "GH_TOKEN="+gitPushTestToken) {
		t.Fatalf("GitPushEnv lost the primary token name: %v", got)
	}
	if !strings.Contains(joined, "GITHUB_TOKEN="+gitPushTestToken) {
		t.Fatalf("GitPushEnv lost the GITHUB_TOKEN alias: %v", got)
	}
	if !strings.Contains(joined, "GIT_CONFIG_COUNT=1") {
		t.Fatalf("GitPushEnv lost the GIT_CONFIG_COUNT entry: %v", got)
	}
	if !strings.Contains(joined, "GIT_CONFIG_KEY_0=credential.https://github.com.helper") {
		t.Fatalf("GitPushEnv lost the credential helper key: %v", got)
	}
	if !strings.Contains(joined, "GIT_CONFIG_VALUE_0=") {
		t.Fatalf("GitPushEnv lost the credential helper value: %v", got)
	}
	if got := worker.GitPushEnv([]string{"DATABASE_URL=postgres://lab:secret@db.internal:5432/delivery"}); got != nil {
		t.Fatalf("GitPushEnv must be nil for a non-GitHub secret: %v", got)
	}
}

// TestGitHubTokenDeliveryAuthorizedProfileIsEnvOnly drives the conversation
// path's sandboxed launch: the authorized profile's GitHub token reaches the
// exec environment under both names plus the git credential helper, and never
// the argv the audit journal records verbatim (ADR-0040).
func TestGitHubTokenDeliveryAuthorizedProfileIsEnvOnly(t *testing.T) {
	fx := newUnitFixture(t)
	fx.svc.Secrets = &gitPushSecretsStub{env: []string{"GH_TOKEN=" + gitPushTestToken}, allow: map[string]bool{"m4-implementer": true}}
	fx.axes.AgentProfileID = "m4-implementer"
	unit := fx.preparedUnit(t)

	plan, err := unit.Verify(context.Background(), testLauncher())
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	envJoined := strings.Join(plan.Env, "\n")
	if !strings.Contains(envJoined, "GH_TOKEN="+gitPushTestToken) {
		t.Fatalf("the authorized attempt's launch env lacks GH_TOKEN: %v", plan.Env)
	}
	if !strings.Contains(envJoined, "GITHUB_TOKEN="+gitPushTestToken) {
		t.Fatalf("the authorized attempt's launch env lacks the GITHUB_TOKEN alias: %v", plan.Env)
	}
	if !strings.Contains(envJoined, "GIT_CONFIG_COUNT=1") {
		t.Fatalf("the authorized attempt's launch env lacks the git credential helper: %v", plan.Env)
	}
	argv := strings.Join(plan.Args, "\x00")
	if strings.Contains(argv, gitPushTestToken) {
		t.Fatalf("the GitHub token reached the launch argv: %q", argv)
	}
	if strings.Contains(argv, "GH_TOKEN=") || strings.Contains(argv, "GITHUB_TOKEN=") {
		t.Fatalf("the GitHub token variable reached the launch argv: %q", argv)
	}
	fx.sandbox.mu.Lock()
	specs := append([]nono.LaunchSpec(nil), fx.sandbox.specs...)
	fx.sandbox.mu.Unlock()
	if len(specs) != 1 {
		t.Fatalf("the sandbox saw %d specs, want 1: %v", len(specs), specs)
	}
	for _, kv := range specs[0].AdapterEnv {
		if strings.HasPrefix(kv, "GH_TOKEN=") || strings.HasPrefix(kv, "GITHUB_TOKEN=") {
			t.Fatalf("the GitHub token reached the argv-bound adapter env: %q", kv)
		}
	}
}

// TestGitHubTokenDeliveryUnauthorizedProfileIsAbsent pins the allowlist arm:
// a profile the secret was not granted the token for gets nothing, not even the
// git credential configuration.
func TestGitHubTokenDeliveryUnauthorizedProfileIsAbsent(t *testing.T) {
	fx := newUnitFixture(t)
	fx.svc.Secrets = &gitPushSecretsStub{env: []string{"GH_TOKEN=" + gitPushTestToken}, allow: map[string]bool{"m4-implementer": true}}
	fx.axes.AgentProfileID = "m4-reviewer"
	unit := fx.preparedUnit(t)

	plan, err := unit.Verify(context.Background(), testLauncher())
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if strings.Contains(strings.Join(plan.Env, "\n"), "GH_TOKEN="+gitPushTestToken) {
		t.Fatalf("an unauthorized profile received the GitHub token: %v", plan.Env)
	}
}
