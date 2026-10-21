package assistant

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
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
