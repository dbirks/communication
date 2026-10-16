package worker

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"testing"

	"github.com/dbirks/communication/internal/domain"
	"github.com/dbirks/communication/internal/secrets"
)

// Contract § 4 step 4 at attempt scope: an agent.acp attempt materializes the
// `node_attempt` arm through the *same* SecretMaterializer seam the M3 turn unit
// drives, and the env-delivered values reach exactly one place — the live agent
// process environment. The allowlist itself is the resolver's question (it lives
// in internal/store/postgres/unit_secrets_test.go); what this file pins is that
// the worker asks it with the attempt's own identity, and that nothing else
// about the launch changes.

// agentSecretsStub is a worker.AttemptSecrets that behaves like the resolver:
// it hands the value to the one agent profile its allowlist names and to no
// other, and records every request it was asked to answer.
type agentSecretsStub struct {
	mu       sync.Mutex
	requests []MaterializeRequest
	repos    []MaterializeRepo
	// allowlist is the agent-profile ids the "secret" is mounted for — the
	// stand-in for secret_metadata.allowed_profile_ids.
	allowlist map[string]bool
	value     string
	envName   string
	files     []string
	err       error
	doneCalls int
	redacted  int
}

func (s *agentSecretsStub) Materialize(_ context.Context, req MaterializeRequest) (Materialized, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.requests = append(s.requests, req)
	if s.err != nil {
		return Materialized{}, s.err
	}
	// The lifecycle/attempt pair the contract fixes: only the node_attempt arm,
	// always naming the attempt it belongs to.
	if req.Lifecycle != LifecycleNodeAttempt || req.AttemptID == "" {
		return Materialized{}, errFake("agentSecretsStub: request is not a node_attempt delivery")
	}
	if !s.allowlist[req.AgentProfileID] {
		// Not allowlisted: the resolver refuses, and the unit sees no mounts —
		// which is what "appears in exactly one place" means for a profile that
		// was never granted the value.
		return Materialized{}, nil
	}
	out := Materialized{
		Env:   []string{s.envName + "=" + s.value},
		Files: append([]string(nil), s.files...),
		Done: func(context.Context) error {
			s.mu.Lock()
			defer s.mu.Unlock()
			s.doneCalls++
			return nil
		},
	}
	return out, nil
}

func (s *agentSecretsStub) ReposForWorkspace(context.Context, string) ([]MaterializeRepo, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]MaterializeRepo(nil), s.repos...), nil
}

func (s *agentSecretsStub) snapshot() ([]MaterializeRequest, int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]MaterializeRequest(nil), s.requests...), s.doneCalls
}

// TestAgentTurnNodeAttemptSecretEnvIsTheAllowlistedProfileOnly is the exit-gate
// C2 shape at the unit level: the value is in the launched agent's environment
// for the profile the mount allowlists and absent for every other, the request
// carries the attempt identity the ledger row needs, and the cleanup hook runs
// at the attempt boundary (contract § 4 step 4).
func TestAgentTurnNodeAttemptSecretEnvIsTheAllowlistedProfileOnly(t *testing.T) {
	const secretValue = "postgres://lab:secret@db.internal:5432/delivery"
	secrets := &agentSecretsStub{
		envName: "DATABASE_URL", value: secretValue,
		allowlist: map[string]bool{"m4-implementer": true},
		repos:     []MaterializeRepo{{ID: "repo-1", Name: "registry"}},
	}
	f := newAgentTurnFixture(t, domain.EnforceDisabled)
	f.turn.Secrets = secrets
	f.spawn.queue(newAgentSessionStub(domain.SessionInfo{}))

	res, err := f.turn.Execute(context.Background(), f.claim(agentCfg("work")), f.sink)
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
	if !containsString(plan.Env, "DATABASE_URL="+secretValue) {
		t.Errorf("the authorized attempt's launch env lacks the mounted value; env = %v", redactedEnv(plan.Env))
	}
	reqs, doneCalls := secrets.snapshot()
	if len(reqs) != 1 {
		t.Fatalf("materialize calls = %d, want one per attempt", len(reqs))
	}
	if reqs[0].AttemptID != fakeAttemptID {
		t.Errorf("request attempt id = %q, want %q (the ledger row must name the attempt)", reqs[0].AttemptID, fakeAttemptID)
	}
	if reqs[0].AgentProfileID != "m4-implementer" {
		t.Errorf("request profile = %q, want the attempt's own resolved profile", reqs[0].AgentProfileID)
	}
	if reqs[0].TurnID != "turn-1" || reqs[0].ConversationID != "conv-1" {
		t.Errorf("request conversation/turn = %q/%q, want the § 4 step 6 stamped pair",
			reqs[0].ConversationID, reqs[0].TurnID)
	}
	if doneCalls != 1 {
		t.Errorf("cleanup Done calls = %d, want 1 at the attempt boundary", doneCalls)
	}

	// The same mount, an unallowlisted profile: nothing lands in the child
	// environment and nothing is refused — the value simply is not this agent's.
	other := &agentSecretsStub{
		envName: "DATABASE_URL", value: secretValue,
		allowlist: map[string]bool{"someone-else": true},
		repos:     []MaterializeRepo{{ID: "repo-1", Name: "registry"}},
	}
	f2 := newAgentTurnFixture(t, domain.EnforceDisabled)
	f2.turn.Secrets = other
	f2.spawn.queue(newAgentSessionStub(domain.SessionInfo{}))
	if res, err := f2.turn.Execute(context.Background(), f2.claim(agentCfg("work")), f2.sink); err != nil ||
		res.Status != AttemptStatusSucceeded {
		t.Fatalf("Execute for the unallowlisted profile = %+v, %v", res, err)
	}
	plan2, ok := f2.spawn.lastCtxPlan()
	if !ok {
		t.Fatal("no launch plan reached the session factory (second profile)")
	}
	for _, kv := range plan2.Env {
		if strings.HasPrefix(kv, "DATABASE_URL=") {
			t.Errorf("an unallowlisted profile was launched with the mounted value: %v", redactedEnv(plan2.Env))
		}
	}
	if _, doneCalls := other.snapshot(); doneCalls != 0 {
		t.Errorf("cleanup ran for a unit that materialized nothing")
	}
}

// TestAgentTurnSecretRefusalFailsTheAttemptBeforeLaunch is ADR-0018 D4's rule at
// attempt scope: a mount that cannot be delivered means no child process and no
// partial set, with the reason kept in the journal rather than the detail.
func TestAgentTurnSecretRefusalFailsTheAttemptBeforeLaunch(t *testing.T) {
	f := newAgentTurnFixture(t, domain.EnforceDisabled)
	f.turn.Secrets = &agentSecretsStub{err: errFake("secret materialization refused")}
	f.spawn.queue(newAgentSessionStub(domain.SessionInfo{}))

	res, err := f.turn.Execute(context.Background(), f.claim(agentCfg("work")), f.sink)
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if res.Status != AttemptStatusFailed {
		t.Fatalf("res = %+v, want failed", res)
	}
	if f.spawn.calls() != 0 {
		t.Errorf("spawn calls = %d, want none: a refused mount must not launch a child", f.spawn.calls())
	}
	if strings.Contains(res.Detail, "/") {
		t.Errorf("the failure detail carries a path: %q", res.Detail)
	}
}

func containsString(hay []string, needle string) bool {
	for _, s := range hay {
		if s == needle {
			return true
		}
	}
	return false
}

// redactedEnv keeps a failing plan dump from printing the very values the test
// is about: names only, values replaced.
func redactedEnv(env []string) []string {
	out := make([]string, 0, len(env))
	for _, kv := range env {
		name, _, _ := strings.Cut(kv, "=")
		out = append(out, name+"=<elided>")
	}
	return out
}

// TestAgentTurnNotAuthorizedMountIsSkippedNotFailed is contract § 4 step 4's
// authorization answer seen from the worker: the materializer's ErrNotAuthorized
// means "this profile was never granted that secret", which is a mount the
// attempt does not have — not a delivery that failed. The attempt launches, with
// no value, no ledger row to close, and no infra failure; the refusal that DOES
// belong to the attempt (the test above) still fails it before launch.
func TestAgentTurnNotAuthorizedMountIsSkippedNotFailed(t *testing.T) {
	f := newAgentTurnFixture(t, domain.EnforceDisabled)
	f.turn.Secrets = &agentSecretsStub{
		err: fmt.Errorf("agentSecretsStub: profile is not on the mount's allowlist: %w",
			secrets.ErrNotAuthorized),
	}
	f.spawn.queue(newAgentSessionStub(domain.SessionInfo{}))

	res, err := f.turn.Execute(context.Background(), f.claim(agentCfg("work")), f.sink)
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if res.Status != AttemptStatusSucceeded {
		t.Fatalf("res = %+v, want succeeded: a mount this profile was never granted is skipped, not a failure", res)
	}
	if f.spawn.calls() != 1 {
		t.Errorf("spawn calls = %d, want 1: the attempt must launch without the mount it was not granted",
			f.spawn.calls())
	}
	if plan, ok := f.spawn.lastCtxPlan(); ok {
		for _, kv := range plan.Env {
			if strings.HasPrefix(kv, "DATABASE_URL=") {
				t.Errorf("the unauthorized value reached the child environment: %v", redactedEnv(plan.Env))
			}
		}
	}
	if _, doneCalls := f.turn.Secrets.(*agentSecretsStub).snapshot(); doneCalls != 0 {
		t.Errorf("cleanup ran for a unit that materialized nothing")
	}
}
