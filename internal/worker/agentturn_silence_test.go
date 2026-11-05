package worker

// Offline (no-ACP) pins for the silence-vs-bad-answer rule (ADR-0023 § 7).
//
// Actions run 42079149686, issue #344: the github-loop /implement attempt died
// error_class=invalid_output ("agent reply is not a JSON object;
// structuredOutput extraction failed") while the journal shows the agent never
// answered at all — the ONLY agent text was pi's start-up banner, the harness
// spent the turn printing its own provider-retry series, and the session ended
// with the process gone:
//
//	E174 conversation.message.agent "pi v1.4.0\n---\n"
//	E175-177 conversation.notice kind=agent_retry (1/3, 2/3, 3/3)
//	E178 conversation.notice "Retry finished, resuming."
//	E179 agent.session.disconnected reason=process_exited
//	E183 node.attempt.failed error_class=invalid_output
//
// invalid_output is permanent (the loop's /implement node lists
// [infra, interrupted, timeout, agent_error] — not it), so a transient model
// gateway outage failed the whole run. Issue #345, same loop, same minute, went
// green end to end (draft PR #346): the loop works; the CLASSIFICATION lied.
// These rows pin what the executor says instead, and the classifier's own
// boundary so a real reply is never rescued by the rule.
//
// usage: go test ./internal/worker/ -run 'TestAgentTurnSilence|TestChatterOnly'

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/dbirks/communication/internal/domain"
)

// piBannerChunk is launcher pi's start-up banner exactly as the journal saw it:
// one message chunk, the version line and the rule under it.
const piBannerChunk = "pi v1.4.0\n---\n"

// piRetrySeries is the transport-retry series as pi-acp streams it: one whole
// line per agent message chunk, closed by its own resume line (pi_retry.go).
var piRetrySeries = []string{
	"Retrying (attempt 1/3, waiting 2s)…",
	"Retrying (attempt 2/3, waiting 4s)...",
	"Retrying (attempt 3/3, waiting 8s)…",
	"Retry finished, resuming.",
}

// runSilhouette streams the given chunks, answers with stop, and returns the
// attempt result the executor produced with the peer-state answer set to
// peerGone (the harness exits after every turn on the lab's pi-acp, so
// peerGone alone must never decide anything by itself).
func runSilhouette(t *testing.T, chunks []string, peerGone bool) AttemptResult {
	t.Helper()
	f := newAgentTurnFixture(t, domain.EnforceDisabled)
	sess := newAgentSessionStub(domain.SessionInfo{})
	sess.peerGone = peerGone
	sess.stderr = "api error: upstream gateway 502 (try 3/3)"
	sess.promptFn = func(_ context.Context, s *agentSessionStub, _ string) (domain.StopReason, error) {
		for _, c := range chunks {
			if retryStatusLine(c) != "" {
				s.sendRetryLine(c)
				continue
			}
			s.sendChunk(c)
		}
		return domain.StopEndTurn, nil
	}
	f.spawn.queue(sess)
	res, err := f.turn.Execute(context.Background(), f.claim(agentCfg("implement the plan")), f.sink)
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	return res
}

// TestAgentTurnSilenceIsNotInvalidOutput covers the two evidence paths out of
// the observed outage: the exited harness and the retry series. Both say
// `infra` — the class the seed /implement node retries — and both keep the
// evidence a later reader needs.
func TestAgentTurnSilenceIsNotInvalidOutput(t *testing.T) {
	t.Run("banner-only reply over an exited harness is infra", func(t *testing.T) {
		res := runSilhouette(t, []string{piBannerChunk}, true)
		if res.Status != AttemptStatusFailed || res.ErrorClass != ErrorClassInfra {
			t.Fatalf("res = %+v, want failed/infra — a silence with no harness left is not an agent verdict", res)
		}
		for _, want := range []string{"no substantive reply", "transport was gone"} {
			if !strings.Contains(res.Detail, want) {
				t.Errorf("detail %q must name the silence and its evidence (want %q)", res.Detail, want)
			}
		}
		if !strings.Contains(res.Detail, "502") {
			t.Errorf("detail %q must still carry the agent's last stderr (the gateway's own words)", res.Detail)
		}
		raw, err := json.Marshal(res.OutputErrors)
		if err != nil {
			t.Fatal(err)
		}
		if len(res.OutputErrors) != 0 {
			t.Errorf("output_errors = %s, want none: an infra close has no schema refusal to carry", raw)
		}
	})

	t.Run("banner-only + agent_retry notices is infra", func(t *testing.T) {
		chunks := append([]string{piBannerChunk}, piRetrySeries...)
		res := runSilhouette(t, chunks, false) // the harness is still alive: the retries are the evidence
		if res.Status != AttemptStatusFailed || res.ErrorClass != ErrorClassInfra {
			t.Fatalf("res = %+v, want failed/infra — the harness reported its provider failing and never answered", res)
		}
		for _, want := range []string{"no substantive reply", "4 provider-retry status line(s)"} {
			if !strings.Contains(res.Detail, want) {
				t.Errorf("detail %q must count the retry series (want %q)", res.Detail, want)
			}
		}
	})

	t.Run("the retry lines never reach the answer or its rows", func(t *testing.T) {
		// The harness's status lines are the launcher speaking, so neither the
		// extraction input nor the conversation's agent rows quote them
		// (pi_retry.go's rule, now the answer buffer's too).
		chunks := append([]string{piBannerChunk}, piRetrySeries...)
		res := runSilhouette(t, chunks, false)
		blob, err := json.Marshal(res)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(blob), "Retrying (attempt") {
			t.Errorf("the attempt result quotes the harness's retry status: %s", blob)
		}
	})

	t.Run("a banner-only turn with a live harness and no retries is still invalid_output", func(t *testing.T) {
		// No transport evidence at all: nothing was killed, nothing reported a
		// failing provider, so the silence is the agent's own non-answer.
		res := runSilhouette(t, []string{piBannerChunk}, false)
		if res.Status != AttemptStatusFailed || res.ErrorClass != ErrorClassInvalidOutput {
			t.Fatalf("res = %+v, want failed/invalid_output — the transient arm needs an observed transport fact", res)
		}
	})
}

// TestChatterOnlyIsAnchoredOnLauncherBoilerplate pins the classifier's own
// boundary: it takes the shapes a launcher streams about itself and NOTHING
// that could be the agent's answer — the rescue must never swallow a real
// reply that failed extraction.
func TestChatterOnlyIsAnchoredOnLauncherBoilerplate(t *testing.T) {
	chatter := []string{
		"",
		"   \n\t\n",
		"pi v1.4.0\n---\n",
		"pi v1.4.0\n---\nRetrying (attempt 1/3, waiting 2s)…\nRetrying (attempt 2/3, waiting 4s)…\nRetry finished, resuming.\n",
		"pi-acp v0.0.34 (npm)\n===\n",
	}
	for _, text := range chatter {
		if !chatterOnly(text) {
			t.Errorf("chatterOnly(%q) = false, want true (launcher boilerplate only)", text)
		}
	}

	answers := []string{
		`{"summary":"done"}`,
		"I could not do it",
		"I'll summarize the JSON after the model reco", // the truncated C1c reply
		"pi v1.4.0\n---\nWorking on it",
		"pi v1.4.0\n---\nRetrying (attempt 1/3, waiting 2s)…\nHere is my answer, honestly.",
		"- item",
		"42",
	}
	for _, text := range answers {
		if chatterOnly(text) {
			t.Errorf("chatterOnly(%q) = true, want false: an agent answer is never boilerplate", text)
		}
	}
}
