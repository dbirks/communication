package assistant

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

// payload renders a test message payload the way the store would have
// written it.
func userPayload(t *testing.T, text string) json.RawMessage {
	t.Helper()
	blob, err := json.Marshal(map[string]any{"kind": "user", "text": text})
	if err != nil {
		t.Fatalf("payload: %v", err)
	}
	return blob
}

func assistantPayload(t *testing.T, answer string) json.RawMessage {
	t.Helper()
	blob, err := json.Marshal(map[string]any{"kind": "assistant", "answer_markdown": answer})
	if err != nil {
		t.Fatalf("payload: %v", err)
	}
	return blob
}

// TestFoldHistoryKeepsTheNewestTwenty — older rows are dropped before the
// byte budget is even consulted.
func TestFoldHistoryKeepsTheNewestTwenty(t *testing.T) {
	var history []HistoryMessage
	for i := 1; i <= 30; i++ {
		history = append(history, HistoryMessage{
			Kind:    "user",
			Payload: userPayload(t, "message "+fmt.Sprint(i)),
		})
	}
	block := foldHistory(history)
	if strings.Contains(block, "message 5\n") || strings.HasPrefix(block, "User: message 5") {
		t.Fatalf("fold kept an over-cap row:\n%s", block)
	}
	if !strings.Contains(block, "message 11") || !strings.Contains(block, "message 30") {
		t.Fatalf("fold lost rows: wants 11..30, got:\n%s", block)
	}
	// Oldest-first: the first line is message 11, the last is message 30.
	lines := strings.Split(block, "\n")
	if lines[0] != "User: message 11" || lines[len(lines)-1] != "User: message 30" {
		t.Fatalf("ordering = %q .. %q, want message 11 first and message 30 last",
			lines[0], lines[len(lines)-1])
	}
}

// TestFoldHistoryDropsOldestOnTheByteBudget — with 12 KB and ~996-byte
// lines, at most 12 lines survive, and they are the NEWEST ones.
func TestFoldHistoryDropsOldestOnTheByteBudget(t *testing.T) {
	long := strings.Repeat("x", 990)
	var history []HistoryMessage
	for i := 1; i <= 16; i++ {
		history = append(history, HistoryMessage{
			Kind:    "user",
			Payload: userPayload(t, "r"+fmt.Sprint(i)+"·"+long),
		})
	}
	block := foldHistory(history)
	lines := strings.Split(block, "\n")
	if len(lines) > 12 {
		t.Fatalf("fold kept %d lines over the 12 KB budget", len(lines))
	}
	// The oldest rows (1..4) are the ones dropped; the newest survive.
	for i := 1; i <= 4; i++ {
		if strings.Contains(block, "r"+fmt.Sprint(i)+"·"+long) {
			t.Fatalf("fold kept row %d that the 12 KB budget must drop", i)
		}
	}
	if !strings.Contains(block, "r16·"+long) || !strings.Contains(block, "r15·"+long) {
		t.Fatalf("fold dropped the newest rows")
	}
}

func TestFoldHistorySkipsUnknownKinds(t *testing.T) {
	history := []HistoryMessage{
		{Kind: "user", Payload: userPayload(t, "hi")},
		{Kind: "bogus", Payload: json.RawMessage(`{"kind":"bogus"}`)},
		{Kind: "assistant", Payload: assistantPayload(t, "there")},
		{Kind: "change", Payload: json.RawMessage(`{"kind":"change","summary":"inserted node"}`)},
		{Kind: "approval_request", Payload: json.RawMessage(`{"kind":"approval_request","summary":"retry","state":"pending"}`)},
		{Kind: "question", Payload: json.RawMessage(`{"kind":"question","prompt":"which one?"}`)},
	}
	block := foldHistory(history)
	for want := range map[string]bool{
		"User: hi":                    true,
		"Assistant: there":            true,
		"Change: inserted node":       true,
		"Approval (pending): retry":   true,
		"Assistant asked: which one?": true,
	} {
		if !strings.Contains(block, want) {
			t.Fatalf("fold missing %q:\n%s", want, block)
		}
	}
	if strings.Contains(block, "bogus") {
		t.Fatalf("fold echoed an unknown kind:\n%s", block)
	}
}

func TestValidateTurnContextDropsOffAllowlistParts(t *testing.T) {
	in := TurnContext{
		Route:     "https://evil.example/x",
		ProjectID: "  01JABC  ",
		Entity:    &TurnContextEntity{Kind: "run", ID: " run-1 "},
	}
	out := ValidateTurnContext(in)
	if out.Route != "" {
		t.Fatalf("off-allowlist route survived: %q", out.Route)
	}
	if out.ProjectID != "01JABC" {
		t.Fatalf("project id = %q, want trimmed", out.ProjectID)
	}
	if out.Entity == nil || out.Entity.Kind != "run" || out.Entity.ID != "run-1" {
		t.Fatalf("entity = %+v, want run/run-1", out.Entity)
	}
	if !out.Empty() == false && out.Route == "" && out.ProjectID == "" {
		t.Fatalf("Empty misreported a non-empty context")
	}

	bad := ValidateTurnContext(TurnContext{
		Route:  "https://evil.example/x",
		Entity: &TurnContextEntity{Kind: "secret", ID: "x"},
	})
	if bad.Entity != nil {
		t.Fatalf("off-kind entity survived: %+v", bad.Entity)
	}
	if !bad.Empty() {
		t.Fatalf("Empty = false, want true for a fully dropped context")
	}
}

func TestTruncateTitleClipsAtEightyRunes(t *testing.T) {
	short := "short title"
	if got := TruncateTitle(short); got != short {
		t.Fatalf("short title changed: %q", got)
	}
	long := strings.Repeat("a", 120)
	if got := TruncateTitle(long); len([]rune(got)) != 80 {
		t.Fatalf("title = %d runes, want 80", len([]rune(got)))
	}
	// A rune boundary must not be split.
	mixed := strings.Repeat("e", 79) + "€" + strings.Repeat("b", 50)
	if got := TruncateTitle(mixed); len([]rune(got)) != 80 {
		t.Fatalf("rune title = %d runes, want 80", len([]rune(got)))
	}
}

// TestRunTurnFoldsHistoryAndContextIntoTheBrokerQuestion — the fake model
// echoes the question back, so the test reads exactly what the broker put
// in front of the model.
func TestRunTurnFoldsHistoryAndContextIntoTheBrokerQuestion(t *testing.T) {
	model := newFakeModel(t, step{echo: true})
	broker := newTestBroker(t, model, newFakeStore())
	runner := NewBrokerTurnRunner(broker)

	history := []HistoryMessage{
		{Kind: "user", Payload: userPayload(t, "what nodes does the run have?")},
		{Kind: "assistant", Payload: assistantPayload(t, "it has three.")},
	}
	result, bad := runner.RunTurn(context.Background(), TurnRequest{
		Caller: testCaller,
		Text:   "and which one failed?",
		Context: TurnContext{
			Route:     "/projects/p-1/runs/r-1",
			ProjectID: "p-1",
			Entity:    &TurnContextEntity{Kind: "draft", ID: "draft-9"},
		},
		History: history,
	})
	if bad != nil {
		t.Fatalf("RunTurn failed: %v", bad)
	}
	if result == nil || result.Answer == nil || strings.TrimSpace(result.Answer.AnswerMarkdown) == "" {
		t.Fatalf("no answer: %+v", result)
	}
	if len(model.requests) != 1 {
		t.Fatalf("model requests = %d, want 1", len(model.requests))
	}
	req := model.requests[0]
	last := req.Messages[len(req.Messages)-1]
	if last.Role != "user" || last.Content == nil {
		t.Fatalf("last message = %+v, want the user question", last)
	}
	body := *last.Content
	for _, want := range []string{
		"what nodes does the run have?",
		"it has three.",
		"and which one failed?",
		"draft draft-9",
		"Project on screen has id: p-1",
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("question missing %q:\n%s", want, body)
		}
	}
}

func TestRunTurnRefusals(t *testing.T) {
	runner := NewBrokerTurnRunner(nil)
	if _, bad := runner.RunTurn(context.Background(), TurnRequest{Caller: testCaller, Text: "hi"}); bad == nil || bad.Code != "assistant_not_configured" || bad.Status != 503 {
		t.Fatalf("nil broker failure = %+v, want assistant_not_configured/503", bad)
	}

	model := newFakeModel(t, step{text: "ok"})
	broker := newTestBroker(t, model, newFakeStore())
	runner = NewBrokerTurnRunner(broker)
	if _, bad := runner.RunTurn(context.Background(), TurnRequest{Caller: testCaller, Text: "  "}); bad == nil || bad.Status != 400 {
		t.Fatalf("empty message failure = %+v, want 400", bad)
	}
	big := strings.Repeat("a", MaxMessageRunes+1)
	if _, bad := runner.RunTurn(context.Background(), TurnRequest{Caller: testCaller, Text: big}); bad == nil || bad.Status != 400 {
		t.Fatalf("oversized message failure = %+v, want 400", bad)
	}
	// Secret-shaped material is refused before a single byte is sent
	// (ADR-0018): zero model egress.
	secret := "token=" + strings.Repeat("a", 20)
	if _, bad := runner.RunTurn(context.Background(), TurnRequest{Caller: testCaller, Text: secret}); bad == nil || bad.Status != 400 || bad.Code != "secret_in_request" {
		t.Fatalf("secret message failure = %+v, want 400 secret_in_request", bad)
	}
	if len(model.requests) != 0 {
		t.Fatalf("model egress = %d, want 0 for a refused turn", len(model.requests))
	}
}
