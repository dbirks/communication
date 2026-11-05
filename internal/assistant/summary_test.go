package assistant

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
	"unicode/utf8"
)

// fakeSummaryModel stands up a scripted OpenAI-compatible endpoint that answers
// a chat/completions POST with the given raw content (the model's answer text).
func fakeSummaryModel(t *testing.T, content string) *Broker {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/chat/completions" {
			http.Error(w, "wrong path", http.StatusNotFound)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []map[string]any{{
				"message":       map[string]any{"role": "assistant", "content": content},
				"finish_reason": "stop",
			}},
		})
	}))
	t.Cleanup(srv.Close)
	b, err := NewTextOnly(Config{BaseURL: srv.URL, HTTPClient: srv.Client()})
	if err != nil {
		t.Fatalf("NewTextOnly: %v", err)
	}
	return b
}

func TestSummarizeApprovalCoercion(t *testing.T) {
	answer := `{
		"summary": "First sentence. Second sentence. Third sentence that must be dropped. Fourth too.",
		"actions": [
			{"label":"Approve","intent":"approve","risk":"proceed"},
			{"label":"` + strings.Repeat("A", 60) + `","intent":"maybe_snooze","risk":"explosive"},
			{"label":"","intent":"reject","risk":"refuse"},
			{"label":"Request changes","intent":"REQUEST_CHANGES","risk":"Other"}
		]
	}`
	b := fakeSummaryModel(t, answer)
	out, fail := b.SummarizeApproval(context.Background(), "gate summary", `{"name":"plan.md"}`)
	if fail != nil {
		t.Fatalf("completion: %v", fail)
	}
	// Summary clipped to two sentences.
	if strings.Contains(out.Summary, "Third") {
		t.Fatalf("summary not clipped to two sentences: %q", out.Summary)
	}
	if !strings.HasSuffix(out.Summary, "Second sentence.") {
		t.Fatalf("summary = %q", out.Summary)
	}
	// Three usable actions (the empty label is dropped), at most four.
	if len(out.Actions) != 3 {
		t.Fatalf("actions = %d: %+v", len(out.Actions), out.Actions)
	}
	// Unknown intent/risk coerced to other; uppercase normalized.
	if out.Actions[1].Intent != "other" || out.Actions[1].Risk != "other" {
		t.Fatalf("unknown members not coerced: %+v", out.Actions[1])
	}
	if utf8.RuneCountInString(out.Actions[1].Label) > SummaryLabelMax {
		t.Fatalf("label not capped: %q", out.Actions[1].Label)
	}
	if out.Actions[2].Intent != "request_changes" || out.Actions[2].Risk != "other" {
		t.Fatalf("normalization wrong: %+v", out.Actions[2])
	}
	// Caller fills model + generated_at.
	if out.Model == "" || out.GeneratedAt.IsZero() {
		t.Fatalf("model/generated_at not filled: %+v", out)
	}
}

func TestSummarizeApprovalSecretRefused(t *testing.T) {
	// A secret-shaped value smuggled into the model's OWN answer is refused and
	// never echoed back into a browser-visible detail.
	answer := `{"summary":"the key is sk-abcdef0123456789abcdef","actions":[
		{"label":"Approve","intent":"approve","risk":"proceed"},
		{"label":"Reject","intent":"reject","risk":"refuse"}]}`
	b := fakeSummaryModel(t, answer)
	_, fail := b.SummarizeApproval(context.Background(), "gate summary", "")
	if fail == nil {
		t.Fatal("expected a secret_in_response refusal")
	}
	if fail.Code != "secret_in_response" {
		t.Fatalf("code = %q", fail.Code)
	}
	if strings.Contains(fail.Detail, "sk-") {
		t.Fatalf("refusal must not echo the secret: %q", fail.Detail)
	}
}

func TestSummarizeApprovalMalformed(t *testing.T) {
	b := fakeSummaryModel(t, "not json at all")
	_, fail := b.SummarizeApproval(context.Background(), "gate", "")
	if fail == nil {
		t.Fatal("expected a malformed failure")
	}
	if fail.Code != FailBadModelResponse {
		t.Fatalf("code = %q", fail.Code)
	}
}

func TestSummarizeApprovalTooManyActions(t *testing.T) {
	var b strings.Builder
	b.WriteString(`{"summary":"One. Two.","actions":[`)
	for i := 0; i < 7; i++ {
		if i > 0 {
			b.WriteString(",")
		}
		b.WriteString(`{"label":"A` + string(rune('1'+i)) + `","intent":"other","risk":"other"}`)
	}
	b.WriteString(`]}`)
	fake := fakeSummaryModel(t, b.String())
	out, fail := fake.SummarizeApproval(context.Background(), "gate", "")
	if fail != nil {
		t.Fatalf("completion: %v", fail)
	}
	if len(out.Actions) != maxActions {
		t.Fatalf("actions = %d, want <= %d", len(out.Actions), maxActions)
	}
}

func TestNewTextOnlyNotConfigured(t *testing.T) {
	if _, err := NewTextOnly(Config{}); err != ErrNotConfigured {
		t.Fatalf("err = %v, want ErrNotConfigured", err)
	}
	if _, err := NewTextOnly(Config{BaseURL: "ftp://bad"}); err == nil {
		t.Fatal("expected a config validation error")
	}
}

func TestSummarizeApprovalRetriesTransientUntilSuccess(t *testing.T) {
	// The approval-summary text-only broker must go through the SAME retrying
	// completion the ask/proposal paths use (ADR-0034/ADR-0023 §7): a transient
	// upstream failure is retried within the broker's budget before the
	// failure is named. The lab's turn-killer was a 502 in the 300 ms range —
	// every transient class the policy names must survive here.
	summaryBody := `{"choices":[{"message":{"content":"{\"summary\":\"First. Second.\",\"actions\":[{\"label\":\"Approve\",\"intent\":\"approve\",\"risk\":\"proceed\"},{\"label\":\"Reject\",\"intent\":\"reject\",\"risk\":\"refuse\"}]}"},"finish_reason":"stop"}]}`
	for status, name := range map[int]string{
		http.StatusTooManyRequests:     "429 rate-limited",
		http.StatusInternalServerError: "500 internal error",
		http.StatusBadGateway:          "502 gateway blip",
		http.StatusServiceUnavailable:  "503 unavailable",
	} {
		t.Run(name, func(t *testing.T) {
			ep := newRetryEndpoint(t,
				retryOutcome{status: status, body: `{"error":{"message":"upstream blip"}}`},
				retryOutcome{status: http.StatusOK, body: summaryBody})
			b := retryBroker(t, ep, (&fakeSleeper{}).sleep)
			out, fail := b.SummarizeApproval(context.Background(), "gate summary", "")
			if fail != nil {
				t.Fatalf("SummarizeApproval after a transient retry (http %d): %v", status, fail)
			}
			if out.Summary != "First. Second." {
				t.Fatalf("summary = %q, want the retried completion's answer", out.Summary)
			}
			if got := atomic.LoadInt64(&ep.calls); got != 2 {
				t.Fatalf("model calls = %d, want 2 (one retry)", got)
			}
		})
	}
}

// TestSummarizeApprovalExhaustsTransientRetriesWithTheEgressFailure pins the
// terminal contract: after the budget is spent the summary path reports the
// SAME egress failure a single attempt would (model_unreachable / 503), not a
// new one and not a 502 that would blame the answer.
func TestSummarizeApprovalExhaustsTransientRetriesWithTheEgressFailure(t *testing.T) {
	ep := newRetryEndpoint(t)
	ep.outcomes = make([]retryOutcome, MaxAttempts)
	for i := range ep.outcomes {
		ep.outcomes[i] = retryOutcome{status: http.StatusBadGateway, body: `{"error":{"message":"upstream refused"}}`}
	}
	sleep := &fakeSleeper{}
	b := retryBroker(t, ep, sleep.sleep)

	_, fail := b.SummarizeApproval(context.Background(), "gate summary", "")
	if fail == nil {
		t.Fatal("expected the terminal failure after the retry budget")
	}
	if fail.Code != FailModelUnreachable || fail.Status != http.StatusServiceUnavailable {
		t.Fatalf("fail = %+v, want model_unreachable / http %d (the egress mapping, unchanged)", fail, http.StatusServiceUnavailable)
	}
	if got := atomic.LoadInt64(&ep.calls); got != int64(MaxAttempts) {
		t.Fatalf("model calls = %d, want %d", got, MaxAttempts)
	}
	sleep.mu.Lock()
	defer sleep.mu.Unlock()
	if len(sleep.delays) != MaxAttempts-1 {
		t.Fatalf("backoff waits = %v, want %d", sleep.delays, MaxAttempts-1)
	}
}

// TestSummarizeApprovalMalformedAnswerIsNotRetried pins the "never a re-ask"
// rule at the summary boundary: a structurally bad answer is a 502 after
// exactly ONE model call — it is an answer problem, not an egress one.
func TestSummarizeApprovalMalformedAnswerIsNotRetried(t *testing.T) {
	ep := newRetryEndpoint(t, retryOutcome{
		status: http.StatusOK,
		body:   `{"choices":[{"message":{"content":"not json at all"},"finish_reason":"stop"}]}`,
	})
	b := retryBroker(t, ep, (&fakeSleeper{}).sleep)

	_, fail := b.SummarizeApproval(context.Background(), "gate summary", "")
	if fail == nil {
		t.Fatal("expected a malformed failure")
	}
	if fail.Code != FailBadModelResponse || fail.Status != http.StatusBadGateway {
		t.Fatalf("fail = %+v, want malformed_completion / http %d", fail, http.StatusBadGateway)
	}
	if got := atomic.LoadInt64(&ep.calls); got != 1 {
		t.Fatalf("model calls = %d, want 1 (bad answers are never retried)", got)
	}
}

// TestSummarizeApprovalStopsRetryingOnContextCancel pins the deadline rule:
// once the request's context cancels mid-backoff, the summary path stops
// retrying immediately instead of firing the next attempt into the void.
func TestSummarizeApprovalStopsRetryingOnContextCancel(t *testing.T) {
	ep := newRetryEndpoint(t)
	ep.outcomes = make([]retryOutcome, MaxAttempts)
	for i := range ep.outcomes {
		ep.outcomes[i] = retryOutcome{status: http.StatusServiceUnavailable, body: `{"error":{"message":"upstream unavailable"}}`}
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	b := retryBroker(t, ep, (&blockingSleeper{}).sleep)
	go func() {
		time.Sleep(5 * time.Millisecond)
		cancel()
	}()

	_, fail := b.SummarizeApproval(ctx, "gate summary", "")
	if fail == nil {
		t.Fatal("expected a failure")
	}
	if got := atomic.LoadInt64(&ep.calls); got > 2 {
		t.Fatalf("retried after the context cancelled: %d calls", got)
	}
}
