package worker

// ADR-0029's worker half: what the claim carries is what the endpoint receives.
// The control plane resolves a message's ${{ … }} at claim time (ADR-0027) and
// the worker forwards the messages verbatim — it never evaluates, never rewrites
// role, and never drops the interpolated text. The test is the wire check of
// that handoff, in the same fake-endpoint style as the rest of this file.

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

// TestModelChatSendsResolvedMessageContent drives one node whose user message
// was authored as `Goal: ${{ inputs.goal }}` and arrives resolved.
func TestModelChatSendsResolvedMessageContent(t *testing.T) {
	srv := newMCServer(t)
	srv.send(mcReply{status: 200, body: mcChatReply(`{"verdict":"approve"}`)})
	cfg := map[string]any{
		"model": "gpt-test",
		"messages": []any{
			map[string]any{"role": "system", "content": "Reply with a numbered plan."},
			map[string]any{"role": "user", "content": "Goal: ship the nightly report\nFiles: README.md\nmain.go"},
		},
	}
	res, err := mcExecutor(srv.srv.URL).Execute(context.Background(), mcClaim(cfg), nil)
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if res.Status != AttemptStatusSucceeded {
		t.Fatalf("status = %s/%s detail=%s, want succeeded", res.Status, res.ErrorClass, res.Detail)
	}
	if srv.requests() != 1 {
		t.Fatalf("requests = %d, want 1", srv.requests())
	}
	msgs, ok := srv.lastRequest()["messages"].([]any)
	if !ok || len(msgs) != 2 {
		t.Fatalf("wire messages = %#v, want the two authored messages", srv.lastRequest()["messages"])
	}
	want := []map[string]any{
		{"role": "system", "content": "Reply with a numbered plan."},
		{"role": "user", "content": "Goal: ship the nightly report\nFiles: README.md\nmain.go"},
	}
	for i, w := range want {
		got, isObj := msgs[i].(map[string]any)
		if !isObj || got["role"] != w["role"] || got["content"] != w["content"] {
			t.Errorf("messages[%d] = %#v, want %#v", i, got, w)
		}
	}
	// The whole point of ADR-0027/ADR-0029 read off the wire: the model is not
	// handed the author's expression syntax.
	body, _ := json.Marshal(srv.lastRequest())
	if strings.Contains(string(body), "${{") {
		t.Errorf("the request body still holds binding syntax: %s", body)
	}
}

// TestModelChatRefusesUnresolvedMessageContent: content is a binding position as
// of ADR-0029, so a claim whose config the control plane could not hydrate still
// carries its $unresolved marker (ADR-0027 rule 4). The executor refuses it as a
// visible binding_error — the worker never evaluates (§ 4 step 14) and an
// unevaluated expression must never reach the endpoint as a prompt.
func TestModelChatRefusesUnresolvedMessageContent(t *testing.T) {
	marker := map[string]any{"$unresolved": true, "expr_ids": []any{"e1"},
		"template": "Goal: ${{ inputs.goal }}"}
	cases := map[string][]any{
		"content is the marker": {map[string]any{"role": "user", "content": marker}},
		"message is the marker": {marker},
	}
	for name, msgs := range cases {
		srv := newMCServer(t)
		cfg := map[string]any{"model": "gpt-test", "messages": msgs}
		res, err := mcExecutor(srv.srv.URL).Execute(context.Background(), mcClaim(cfg), nil)
		if err != nil {
			t.Fatalf("%s: execute: %v", name, err)
		}
		if res.Status != AttemptStatusFailed || res.ErrorClass != ErrorClassBindingError {
			t.Errorf("%s: status = %s/%s, want failed/binding_error", name, res.Status, res.ErrorClass)
		}
		if !strings.Contains(res.Detail, "unresolved") {
			t.Errorf("%s: detail should name the unresolved binding: %s", name, res.Detail)
		}
		if srv.requests() != 0 {
			t.Errorf("%s: %d requests made with an unresolved message in the config", name, srv.requests())
		}
	}
}

// TestModelChatRefusesMessageShapeFacts: a role outside the ADR-0029 enum and an
// empty content are facts about the node, so they close invalid_output before any
// byte leaves the process — the schema is the first line of defence, the executor
// is the one standing in front of the socket.
func TestModelChatRefusesMessageShapeFacts(t *testing.T) {
	cases := map[string][]any{
		"unknown role":  {map[string]any{"role": "tool", "content": "hi"}},
		"empty content": {map[string]any{"role": "user", "content": ""}},
		"no content":    {map[string]any{"role": "user"}},
	}
	for name, msgs := range cases {
		srv := newMCServer(t)
		cfg := map[string]any{"model": "gpt-test", "messages": msgs}
		res, _ := mcExecutor(srv.srv.URL).Execute(context.Background(), mcClaim(cfg), nil)
		if res.Status != AttemptStatusFailed || res.ErrorClass != ErrorClassInvalidOutput {
			t.Errorf("%s: status = %s/%s, want failed/invalid_output", name, res.Status, res.ErrorClass)
		}
		if srv.requests() != 0 {
			t.Errorf("%s: %d requests made for a malformed message", name, srv.requests())
		}
	}
}
