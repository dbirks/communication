package worker

import (
	"context"
	"strings"
	"testing"

	"github.com/dbirks/communication/internal/domain"
)

// The prompt-assembly half of the invalid_output retry loop (ADR-0073): the
// plan prompt never mentioned the machine-checked output schema, and every
// retry was handed the identical text — so a reply refused for
// `/plan/summary maxLength 600` was rejected three times running (lab live16:
// got 647, then 760, then 765). The claim now carries OutputsSchema and
// RetryContext, and the prompt the session sees must state the constraints up
// front and the previous refusal verbatim.

func planOutputsSchema() map[string]any {
	return map[string]any{
		"type":     "object",
		"required": []any{"plan"},
		"properties": map[string]any{"plan": map[string]any{
			"type":     "object",
			"required": []any{"summary", "kind"},
			"properties": map[string]any{
				"summary": map[string]any{"type": "string", "minLength": int64(1), "maxLength": int64(600)},
				"kind":    map[string]any{"type": "string", "enum": []any{"full", "sketch"}},
			},
		}},
	}
}

func retryCtxOverrun() map[string]any {
	return map[string]any{
		"attempt":     int64(1),
		"error_class": "invalid_output",
		"validation_errors": []any{map[string]any{
			"path": "/plan/summary", "rule": "maxLength",
			"got": "647", "want": "600",
			"message": "maxLength: got 647, want 600",
		}},
	}
}

// TestAgentTurnFirstPromptStatesOutputConstraints: the FIRST attempt's prompt
// must already say what the boundary will check — maxLength, enums, required
// names — and the maxLength states a safety margin, not just the limit: a
// model that writes TO "at most 600" lands at 699 (ac978e0's first attempt),
// while one that writes to a named sub-target clears the boundary.
func TestAgentTurnFirstPromptStatesOutputConstraints(t *testing.T) {
	f := newAgentTurnFixture(t, domain.EnforceDisabled)
	f.spawn.queue(newAgentSessionStub(domain.SessionInfo{}))
	base := "Plan the work."
	c := f.claim(agentCfg(base))
	c.AttemptNumber = 1
	c.OutputsSchema = planOutputsSchema()

	res, err := f.turn.Execute(context.Background(), c, f.sink)
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if res.Status != AttemptStatusSucceeded {
		t.Fatalf("res = %+v, want succeeded", res)
	}
	prompt := f.spawn.sessions[0].prompts[0]
	if !strings.HasPrefix(prompt, base) {
		t.Errorf("prompt does not lead with the plan text: %q", prompt)
	}
	for _, want := range []string{
		"plan.summary", "maxLength 600", "keep it under 450 characters", "minLength 1",
		"plan.kind", `one of ["full", "sketch"]`,
		"required", "invalid_output",
	} {
		if !strings.Contains(prompt, want) {
			t.Errorf("first-attempt prompt is missing %q. prompt was:\n%s", want, prompt)
		}
	}
	// Bounded: the decoration is a summary, not the schema dumped raw.
	if len(prompt)-len(base) > maxPromptDecoration+64 {
		t.Errorf("decoration is %d bytes over the plan prompt, cap %d", len(prompt)-len(base), maxPromptDecoration)
	}
}

// TestAgentTurnRetryPromptCarriesValidationError is the brief's headline: an
// attempt queued after invalid_output must be TOLD which field violated what,
// with the numbers — "Your previous reply was rejected: /plan/summary
// exceeded maxLength (got 647, want at most 600 — 47 characters over); cut it
// to at most 450 characters …". The feedback is DECISIVE: it names the exact
// overage and a target well under the limit, because repeating the limit is
// what a model trims a little each time and fails (ac978e0: 699 → 636 → 628).
func TestAgentTurnRetryPromptCarriesValidationError(t *testing.T) {
	f := newAgentTurnFixture(t, domain.EnforceDisabled)
	f.spawn.queue(newAgentSessionStub(domain.SessionInfo{}))
	c := f.claim(agentCfg("Plan the work."))
	c.AttemptNumber = 2
	c.RetryContext = retryCtxOverrun()
	c.OutputsSchema = planOutputsSchema()

	if _, err := f.turn.Execute(context.Background(), c, f.sink); err != nil {
		t.Fatalf("Execute: %v", err)
	}
	prompt := f.spawn.sessions[0].prompts[0]
	for _, want := range []string{
		"Your previous reply was rejected",
		"/plan/summary", "maxLength", "got 647", "want at most 600",
		"47 characters over", "cut it to at most 450 characters",
		"Reply again",
	} {
		if !strings.Contains(prompt, want) {
			t.Errorf("retry prompt is missing %q. prompt was:\n%s", want, prompt)
		}
	}
}

// TestAgentTurnNonOutputRetriesCarryNoFeedback keeps the note honest for the
// classes it is NOT about: a retry_context without validation_errors (e.g. an
// interrupted retry) must not make the prompt claim a rejection.
func TestAgentTurnNonOutputRetriesCarryNoFeedback(t *testing.T) {
	f := newAgentTurnFixture(t, domain.EnforceDisabled)
	f.spawn.queue(newAgentSessionStub(domain.SessionInfo{}))
	c := f.claim(agentCfg("Plan the work."))
	c.AttemptNumber = 2
	c.RetryContext = map[string]any{"attempt": int64(1), "error_class": "interrupted"}

	if _, err := f.turn.Execute(context.Background(), c, f.sink); err != nil {
		t.Fatalf("Execute: %v", err)
	}
	prompt := f.spawn.sessions[0].prompts[0]
	if strings.Contains(prompt, "rejected") {
		t.Errorf("interrupted retry claims a rejection it never had:\n%s", prompt)
	}
}

// TestAgentTurnFakeAgentOverrunsOnceThenComplies walks the two attempts the
// fix exists for: the fake agent over-runs summary on the prompt WITHOUT the
// refusal note and complies on the prompt WITH it — the worker half of the
// loop the engine proves in runtime TestFakeAgentOverrunsOnceThenComplies.
func TestAgentTurnFakeAgentOverrunsOnceThenComplies(t *testing.T) {
	f := newAgentTurnFixture(t, domain.EnforceDisabled)
	// The fake agent: an over-long summary unless the prompt names the
	// refusal; then a 600-character one.
	comply := func(text string) string {
		n := 647
		if strings.Contains(text, "Your previous reply was rejected") {
			n = 600
		}
		return `{"plan": {"summary": "` + strings.Repeat("x", n) + `", "kind": "full"}}`
	}
	s1, s2 := newAgentSessionStub(domain.SessionInfo{}), newAgentSessionStub(domain.SessionInfo{})
	s1.promptFn = func(_ context.Context, sess *agentSessionStub, text string) (domain.StopReason, error) {
		sess.sendChunk(comply(text))
		return domain.StopEndTurn, nil
	}
	s2.promptFn = s1.promptFn
	f.spawn.queue(s1, s2)

	c1 := f.claim(agentCfg("Plan the work."))
	c1.OutputsSchema = planOutputsSchema()
	res1, err := f.turn.Execute(context.Background(), c1, f.sink)
	if err != nil {
		t.Fatalf("execute attempt 1: %v", err)
	}
	if strings.Contains(s1.prompts[0], "Your previous reply was rejected") {
		t.Fatalf("attempt 1 claims a rejection: %s", s1.prompts[0])
	}
	// The § 4 step 8 boundary (runtime.CheckNodeOutputs, pinned by
	// TestFakeAgentOverrunsOnceThenComplies in the runtime suite) refuses this
	// 647-character summary; at this layer the reply itself is the evidence.
	if got := len(res1.Outputs.(map[string]any)["plan"].(map[string]any)["summary"].(string)); got != 647 {
		t.Fatalf("attempt 1 summary length = %d, want the over-run 647 (maxLength is 600)", got)
	}

	// Attempt 2 as the engine queues it: the SAME prompt plus the refusal.
	c2 := f.claim(agentCfg("Plan the work."))
	c2.AttemptNumber = 2
	c2.OutputsSchema = planOutputsSchema()
	c2.RetryContext = retryCtxOverrun()
	res2, err := f.turn.Execute(context.Background(), c2, f.sink)
	if err != nil {
		t.Fatalf("execute attempt 2: %v", err)
	}
	if !strings.Contains(s2.prompts[0], "/plan/summary") {
		t.Fatalf("attempt 2 was not told what broke: %s", s2.prompts[0])
	}
	if got := len(res2.Outputs.(map[string]any)["plan"].(map[string]any)["summary"].(string)); got > 600 {
		t.Fatalf("attempt 2 summary length = %d, want ≤ 600 — the refusal never reached the agent", got)
	}
	if res2.Status != AttemptStatusSucceeded {
		t.Fatalf("attempt 2 = %+v, want succeeded", res2)
	}
}

// TestAgentTurnFakeAgentOverrunsTwiceThenComplies is ac978e0's loop as a
// test: the fake agent trims a little on each refusal (699 → 636, both over
// the declared maxLength 600) and only complies once the retry feedback
// names a target well under the limit — "cut it to at most 450 characters".
// A retry that re-states only the limit is what the model trims toward;
// the overage plus the cut target is what it trims to.
func TestAgentTurnFakeAgentOverrunsTwiceThenComplies(t *testing.T) {
	f := newAgentTurnFixture(t, domain.EnforceDisabled)
	// The fake agent, exactly the shape of the observed over-runner:
	// first prompt answers 699; a refusal naming 699 trims a little to 636
	// (still over); a refusal naming 636 cuts to the target, 440.
	comply := func(text string) string {
		n := 699
		switch {
		case strings.Contains(text, "got 699"):
			n = 636
		case strings.Contains(text, "got 636"):
			n = 440
		}
		return `{"plan": {"summary": "` + strings.Repeat("x", n) + `", "kind": "full"}}`
	}
	s1, s2, s3 := newAgentSessionStub(domain.SessionInfo{}),
		newAgentSessionStub(domain.SessionInfo{}), newAgentSessionStub(domain.SessionInfo{})
	promptFn := func(_ context.Context, sess *agentSessionStub, text string) (domain.StopReason, error) {
		sess.sendChunk(comply(text))
		return domain.StopEndTurn, nil
	}
	s1.promptFn = promptFn
	s2.promptFn = promptFn
	s3.promptFn = promptFn
	f.spawn.queue(s1, s2, s3)

	// Attempt 1: the first prompt states the margin, the agent ignores it.
	c1 := f.claim(agentCfg("Plan the work."))
	c1.OutputsSchema = planOutputsSchema()
	res1, err := f.turn.Execute(context.Background(), c1, f.sink)
	if err != nil {
		t.Fatalf("execute attempt 1: %v", err)
	}
	if got := len(res1.Outputs.(map[string]any)["plan"].(map[string]any)["summary"].(string)); got != 699 {
		t.Fatalf("attempt 1 summary length = %d, want the over-run 699", got)
	}

	// Attempt 2 as the engine queues it after the 699 refusal: the same
	// prompt plus the rejection. The feedback must name the overage (99) and
	// the cut target (450) — that is the only thing that makes the next
	// attempt decisive, so the test reads them back out of the prompt.
	c2 := f.claim(agentCfg("Plan the work."))
	c2.AttemptNumber = 2
	c2.OutputsSchema = planOutputsSchema()
	c2.RetryContext = retryCtxOverrun() // the base attempt/error_class facts
	c2.RetryContext["validation_errors"] = []any{map[string]any{
		"path": "/plan/summary", "rule": "maxLength",
		"got": "699", "want": "600",
		"message": "maxLength: got 699, want 600",
	}}
	res2, err := f.turn.Execute(context.Background(), c2, f.sink)
	if err != nil {
		t.Fatalf("execute attempt 2: %v", err)
	}
	prompt2 := s2.prompts[0]
	for _, want := range []string{"got 699", "want at most 600", "99 characters over", "cut it to at most 450 characters"} {
		if !strings.Contains(prompt2, want) {
			t.Fatalf("attempt 2 prompt is missing %q. prompt was:\n%s", want, prompt2)
		}
	}
	if got := len(res2.Outputs.(map[string]any)["plan"].(map[string]any)["summary"].(string)); got != 636 {
		t.Fatalf("attempt 2 summary length = %d, want the small trim 636 (still over 600)", got)
	}

	// Attempt 3 after the 636 refusal: the agent cuts to the target and the
	// node's reply finally clears the boundary.
	c3 := f.claim(agentCfg("Plan the work."))
	c3.AttemptNumber = 3
	c3.OutputsSchema = planOutputsSchema()
	c3.RetryContext = retryCtxOverrun()
	c3.RetryContext["validation_errors"] = []any{map[string]any{
		"path": "/plan/summary", "rule": "maxLength",
		"got": "636", "want": "600",
		"message": "maxLength: got 636, want 600",
	}}
	res3, err := f.turn.Execute(context.Background(), c3, f.sink)
	if err != nil {
		t.Fatalf("execute attempt 3: %v", err)
	}
	prompt3 := s3.prompts[0]
	for _, want := range []string{"got 636", "36 characters over", "cut it to at most 450 characters"} {
		if !strings.Contains(prompt3, want) {
			t.Fatalf("attempt 3 prompt is missing %q. prompt was:\n%s", want, prompt3)
		}
	}
	if got := len(res3.Outputs.(map[string]any)["plan"].(map[string]any)["summary"].(string)); got != 440 {
		t.Fatalf("attempt 3 summary length = %d, want the compliant cut 440", got)
	}
	if res3.Status != AttemptStatusSucceeded {
		t.Fatalf("attempt 3 = %+v, want succeeded", res3)
	}
}
