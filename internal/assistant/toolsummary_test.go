package assistant

// ADR-0050 names tool_calls[].summary: a short server-supplied sentence on
// every tool call, on the one-shot /assistant/ask as on the conversation
// message payload. These tests assert the JSON on the wire (the field is
// omitempty, so a call that never got a summary would drop the key itself),
// plus the conversation link vocabulary {label, route}.

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

// wireToolCall is one tool_calls entry as the browser would see it: the
// routes serialize the []ToolCall records verbatim.
type wireToolCall struct {
	Name    string `json:"name"`
	OK      bool   `json:"ok"`
	Reason  string `json:"reason"`
	Summary string `json:"summary"`
}

// assertWireSummaries marshals the calls exactly the route does and refuses
// any entry without a non-empty summary on the wire.
func assertWireSummaries(t *testing.T, label string, calls []ToolCall) []wireToolCall {
	t.Helper()
	if len(calls) == 0 {
		t.Fatalf("%s: no tool calls at all, want at least one", label)
	}
	body, err := json.Marshal(calls)
	if err != nil {
		t.Fatalf("%s: tool_calls do not marshal: %v", label, err)
	}
	var out []wireToolCall
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatalf("%s: tool_calls do not unmarshal: %v", label, err)
	}
	for i, c := range out {
		if strings.TrimSpace(c.Summary) == "" {
			t.Fatalf("%s: tool_call %d (%s) has no summary on the wire: %s",
				label, i, c.Name, body)
		}
	}
	return out
}

// TestAskToolCallSummariesOnTheWire is the one-shot /assistant/ask side:
// every executed read and every refusal in the answer carries a summary
// written by the code from the call's arguments and result.
func TestAskToolCallSummariesOnTheWire(t *testing.T) {
	store := newFakeStore()
	store.projects = json.RawMessage(`[{"id":"01JPROJECTA","slug":"alpha","name":"Project A","my_role":"member"},
		{"id":"01JPROJECTB","slug":"beta","name":"Project B","my_role":"member"}]`)
	store.runs["p-1"] = json.RawMessage(`[{"id":"r-1","status":"failed"},{"id":"r-2","status":"pending"}]`)
	model := newFakeModel(t,
		step{toolCalls: []toolCallRequest{
			toolCall("project.list", nil),
			toolCall("run.list", map[string]any{"project_id": "p-1"}),
			// A write-shaped name the registry has no entry for: refused
			// with zero store calls, and the refusal still needs its line.
			toolCall("cancel_run", map[string]any{"run_id": "r-1"}),
		}},
		step{text: "Two runs; one failed."})
	b := newTestBroker(t, model, store)

	answer, bad := b.Ask(context.Background(), testCaller, "how do my runs look?", QuestionContext{})
	if bad != nil {
		t.Fatalf("Ask failed: %+v", bad)
	}
	if len(answer.ToolCalls) != 3 {
		t.Fatalf("tool_calls = %+v, want 3", answer.ToolCalls)
	}
	wire := assertWireSummaries(t, "ask", answer.ToolCalls)

	if wire[0].Summary != "Listed 2 projects" {
		t.Fatalf("project.list summary = %q", wire[0].Summary)
	}
	if wire[1].Summary != "Listed 2 runs for project p-1" {
		t.Fatalf("run.list summary = %q", wire[1].Summary)
	}
	if wire[2].OK || wire[2].Reason != "write_not_allowed" {
		t.Fatalf("third call = %+v, want the write refusal", wire[2])
	}
	if wire[2].Summary != "Not executed: write_not_allowed" {
		t.Fatalf("refusal summary = %q", wire[2].Summary)
	}
}

// TestConversationTurnToolCallSummariesOnTheWire is the conversation-message
// side: one turn exercising the read registry, navigation, the draft read,
// and a follow-up question — every row the turn stores carries a summary,
// and the stored links speak the ADR-0050 route vocabulary.
func TestConversationTurnToolCallSummariesOnTheWire(t *testing.T) {
	model := newFakeModel(t,
		step{toolCalls: []toolCallRequest{toolCall("project.list", nil)}},
		step{toolCalls: []toolCallRequest{toolCall("ui.navigate", map[string]any{"route": "/inbox"})}},
		step{toolCalls: []toolCallRequest{toolCall("draft.get", map[string]any{"draft_id": "d-1"})}},
		step{toolCalls: []toolCallRequest{toolCall("ui.question", map[string]any{
			"prompt":  "Fix the failed run, or the whole project?",
			"options": `[{"label":"Just the run","value":"run"},{"label":"The whole project","value":"project"}]`,
		})}},
	)
	draft := newFakeDraftService()
	store := newFakeStore()
	store.projects = json.RawMessage(`[{"id":"01JPROJECTA","slug":"alpha","name":"Project A","my_role":"member"}]`)
	b := newTestBroker(t, model, store)
	r := NewConversationRunner(ConversationRunnerDeps{Broker: b, Draft: draft, Actions: nil})

	res, f := r.RunTurn(context.Background(), TurnRequest{
		Caller: testCaller, Text: "go", TrustLevel: TrustAskRisky,
	})
	if f != nil {
		t.Fatalf("RunTurn failed: code=%s detail=%s", f.Code, f.Detail)
	}
	if len(res.Answer.ToolCalls) != 4 {
		t.Fatalf("tool_calls = %+v, want 4 (the question stops the turn)", res.Answer.ToolCalls)
	}
	wire := assertWireSummaries(t, "conversation", res.Answer.ToolCalls)

	if wire[0].Summary != "Listed 1 projects" {
		t.Fatalf("project.list summary = %q", wire[0].Summary)
	}
	if wire[1].Summary != "Navigated to /inbox" {
		t.Fatalf("ui.navigate summary = %q", wire[1].Summary)
	}
	if wire[2].Summary != "Read draft d-1 (version 1)" {
		t.Fatalf("draft.get summary = %q", wire[2].Summary)
	}
	if wire[3].Summary != "Asked a follow-up question with 2 options" {
		t.Fatalf("ui.question summary = %q", wire[3].Summary)
	}

	// ADR-0050 decision 3: the stored links use the real route vocabulary
	// ({label, route}); the one-shot ask's href never appears.
	linkBody, err := json.Marshal(MessageLinks(res.Answer.Links))
	if err != nil {
		t.Fatalf("links do not marshal: %v", err)
	}
	if len(res.Answer.Links) == 0 ||
		!strings.Contains(string(linkBody), `"route":"/inbox"`) ||
		strings.Contains(string(linkBody), "href") {
		t.Fatalf("conversation links = %s, want the {label, route} vocabulary", linkBody)
	}
}

// TestConversationGatedCallCarriesSummary: a gated (awaiting_approval) call
// is recorded on the wire with ok:false and its refusal line, not a blank.
func TestConversationGatedCallCarriesSummary(t *testing.T) {
	model := newFakeModel(t,
		step{toolCalls: []toolCallRequest{toolCall("run.start", map[string]any{
			"project_id": "p-1", "pipeline_id": "pl-1"})}},
	)
	execCalls := 0
	actions := map[string]ActionExecutor{
		"run.start": func(_ context.Context, _ Caller, _ string, _ map[string]string) (string, *ChangeRecord, error) {
			execCalls++
			return "Started run r-1", &ChangeRecord{
				Kind: "run_start", TargetRef: "run:r-1", Summary: "Started run r-1",
			}, nil
		},
	}
	r := newMatrixRunner(t, model, newFakeDraftService(), actions)
	res := runOne(t, r, TrustAskRisky)
	if res.Approval == nil {
		t.Fatalf("gated run.start: no approval card")
	}
	if execCalls != 0 {
		t.Fatalf("a gated action executed %d times", execCalls)
	}
	wire := assertWireSummaries(t, "gated", res.Answer.ToolCalls)
	if len(wire) != 1 || wire[0].OK || wire[0].Reason != "awaiting_approval" {
		t.Fatalf("gated tool_call = %+v, want ok:false awaiting_approval", wire[0])
	}
	if wire[0].Summary != "Not executed: awaiting_approval" {
		t.Fatalf("gated summary = %q", wire[0].Summary)
	}
}
