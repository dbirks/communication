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

// TestAgentTurnProviderErrorIsInfra covers the other half of the outage: the
// harness stayed alive and never printed its retry series, but it said out
// loud that its provider failed (pi-acp@0.0.34 prints its own error sentences,
// and pi composes provider errors as `"<prefix> (<status>): <body>"` —
// pi-ai's formatProviderError). A reply that is NOTHING but that line is not
// an agent answer to judge, and the shapes in our own evidence (Actions run
// 42126595292: a 15-second attempt, att 1, invalid_output, no retry) are the
// ones a retry must be allowed to eat.
func TestAgentTurnProviderErrorIsInfra(t *testing.T) {
	t.Run("banner + an explicit gateway 502 line is infra", func(t *testing.T) {
		res := runSilhouette(t, []string{piBannerChunk, "Error: 502 Bad Gateway\n"}, false)
		if res.Status != AttemptStatusFailed || res.ErrorClass != ErrorClassInfra {
			t.Fatalf("res = %+v, want failed/infra — a spoken provider failure is the transport's, not an agent verdict", res)
		}
		for _, want := range []string{"no substantive reply", "1 provider-failure line(s)", "502 Bad Gateway"} {
			if !strings.Contains(res.Detail, want) {
				t.Errorf("detail %q must name the spoken failure (want %q)", res.Detail, want)
			}
		}
		if len(res.OutputErrors) != 0 {
			t.Errorf("output_errors = %v, want none: an infra close has no schema refusal to carry", res.OutputErrors)
		}
	})

	t.Run("pi-acp's composed provider error and its bare retry status are both non-speech", func(t *testing.T) {
		for _, chunk := range []string{
			"OpenAI API error (429): too many requests\n",
			"429: Too Many Requests\n",
			"Proxy error: 502 Bad Gateway\n",
			"Retrying…\n",
		} {
			res := runSilhouette(t, []string{piBannerChunk, chunk}, false)
			if res.ErrorClass != ErrorClassInfra {
				t.Errorf("chunk %q: res = %+v, want infra", chunk, res)
			}
		}
	})

	t.Run("prose that merely mentions a status stays the agent's own bad answer", func(t *testing.T) {
		for _, chunk := range []string{
			"The README documents Error: 502 handling in the gateway module.",
			"I could not summarize it.",
			"Error: 502 is what the gateway module documents.",
		} {
			res := runSilhouette(t, []string{piBannerChunk, chunk}, false)
			if res.ErrorClass != ErrorClassInvalidOutput {
				t.Errorf("chunk %q: res = %+v, want invalid_output — ordinary prose is a reply to judge", chunk, res)
			}
		}
	})
}

// TestProviderErrorLineShape pins the recognizer's own boundary at the line
// level — the executor's extraction is not part of the question. Every
// accepted line is a harness error sentence or pi-ai's composed
// `"<status>: <body>"`; every refused one is something a person or a model
// wrote, including prose that merely mentions an outage.
func TestProviderErrorLineShape(t *testing.T) {
	harness := []string{
		"Error: 502 Bad Gateway",
		"Error: upstream provider returned 429 Too Many Requests",
		"OpenAI API error (502): {\"error\":{\"type\":\"overloaded_error\"}}",
		"Proxy error: 503 Service Unavailable",
		"500: <html><body>Bad Gateway</body></html>",
		"error: request timed out after 60s",
		"Error: connect ECONNRESET 10.0.0.1:443",
	}
	for _, line := range harness {
		if providerErrorLine(line) == "" {
			t.Errorf("providerErrorLine(%q) = \"\", want the harness's own failure line", line)
		}
	}
	answers := []string{
		"Error: 502 is what the gateway module documents in README.md, and the retry policy behind it is the interesting part of the design.",
		"I could not answer",
		"The API returned an error: see the logs",
		"Here is the summary: it covers rate limiting and timeouts in the gateway.",
		"42",
		"- item",
		"",
		"   ",
	}
	for _, line := range answers {
		if got := providerErrorLine(line); got != "" {
			t.Errorf("providerErrorLine(%q) = %q, want \"\": ordinary prose is the agent's answer", line, got)
		}
	}
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
		"pi v1.4.0\n---\nError: 502 Bad Gateway\n",
		"OpenAI API error (429): too many requests\n",
		"503: service unavailable\nRetrying…\n",
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
		"pi v1.4.0\n---\nThe gateway answered Error: 502 once and I recovered.",
		"Error: the fixture is missing the reviewer field",
		"- item",
		"42",
	}
	for _, text := range answers {
		if chatterOnly(text) {
			t.Errorf("chatterOnly(%q) = true, want false: an agent answer is never boilerplate", text)
		}
	}
}
