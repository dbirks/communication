package assistant

// The draft-edit contract the model actually has to work with: a rejected
// draft.apply returns the fix TO THE MODEL (kind "approval" ->
// "human.approval") so the loop can retry within the same turn, and
// draft.get carries every node id of a 13-node draft inside the tool's
// own cap.

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

// TestDraftApplyRefusalNamesTheFixAndRetries is the acceptance journey:
// the model inserts a human approval step but writes kind "approval"; the
// first apply is refused and the tool result shown to the model names the
// wrong value, the closest valid kind and the valid set; the corrected
// retry executes and the change is recorded undoable.
func TestDraftApplyRefusalNamesTheFixAndRetries(t *testing.T) {
	bad := toolCall("draft.apply", map[string]any{
		"draft_id": "d-1", "version": "1", "op": "insert_on_edge",
		"from": "plan", "to": "check", "kind": "approval", "id": "journey_check",
	})
	good := toolCall("draft.apply", map[string]any{
		"draft_id": "d-1", "version": "1", "op": "insert_on_edge",
		"from": "plan", "to": "check", "kind": "human.approval", "id": "journey_check",
		"config": `{"summary":"approve the change before it proceeds"}`,
	})
	model := newFakeModel(t,
		step{toolCalls: []toolCallRequest{bad}},
		step{toolCalls: []toolCallRequest{good}},
		step{text: "Added the approval step journey_check."},
	)
	draft := newFakeDraftService()
	r := newMatrixRunner(t, model, draft, nil)
	res := runOne(t, r, TrustNoAsk)

	if model.bodyCount() != 3 {
		t.Fatalf("model calls = %d, want 3 (refused apply, retried apply, answer)", model.bodyCount())
	}

	// The second request carries the tool result the model was shown after
	// the refusal: it must name the wrong value, the closest kind and the
	// valid set, so a same-turn retry is possible.
	second := userMessages(model.seen(1))
	if !strings.Contains(second, `kind \"approval\" is not a node kind`) ||
		!strings.Contains(second, `did you mean \"human.approval\"`) ||
		!strings.Contains(second, "valid kinds") {
		t.Fatalf("the refusal shown to the model does not name the fix:\n%s", second)
	}

	// The refused call is recorded (not executed); the retry executed
	// against the version-checked PUT and the change is undoable.
	calls := res.Answer.ToolCalls
	if len(calls) != 2 || calls[0].OK || calls[0].Reason != "proposal_invalid" || !calls[1].OK {
		t.Fatalf("tool calls = %+v, want a refused first apply and an ok retry", calls)
	}
	if len(res.Changes) != 1 || res.Changes[0].Kind != "draft_edit" || res.Changes[0].UndoPayload == nil {
		t.Fatalf("changes = %+v, want one undoable draft_edit", res.Changes)
	}
	if draft.replaceCalls != 1 || draft.version != 2 {
		t.Fatalf("writes = %d, version = %d, want one write to version 2", draft.replaceCalls, draft.version)
	}
}

// userMessages joins the user-role message bodies of one model request.
func userMessages(req chatRequest) string {
	var sb strings.Builder
	for _, m := range req.Messages {
		if m.Role == "user" && m.Content != nil {
			sb.WriteString(*m.Content)
			sb.WriteString("\n")
		}
	}
	return sb.String()
}

// TestDraftApplyRefusalNamesUnknownNodeIDs is the other half of the same
// failure: an unknown anchor id must be answered with the draft's own node
// ids so the model can anchor without another read.
func TestDraftApplyRefusalNamesUnknownNodeIDs(t *testing.T) {
	bad := toolCall("draft.apply", map[string]any{
		"draft_id": "d-1", "version": "1", "op": "insert_on_edge",
		"from": "plan", "to": "nope", "kind": "model.chat", "id": "x1",
	})
	model := newFakeModel(t,
		step{toolCalls: []toolCallRequest{bad}},
		step{text: "I used a node id that does not exist."},
	)
	r := newMatrixRunner(t, model, newFakeDraftService(), nil)
	runOne(t, r, TrustNoAsk)

	second := userMessages(model.seen(1))
	if !strings.Contains(second, `node \"nope\" is not in the draft`) ||
		!strings.Contains(second, `this draft's node ids are: plan, check`) {
		t.Fatalf("the refusal shown to the model does not name the draft's node ids:\n%s", second)
	}
}

// thirteenNodeYAML is a schema-valid 13-node draft: a linear chain, so the
// structural view of draft.get carries 13 ids, 13 kinds and 12 edges.
func thirteenNodeYAML() string {
	var sb strings.Builder
	sb.WriteString(`apiVersion: communication.dev/v1alpha1
kind: Pipeline
metadata:
  name: thirteen
spec:
  inputs: {type: object}
  nodes:
`)
	for i := 1; i <= 13; i++ {
		fmt.Fprintf(&sb, "  - id: n%02d\n    kind: agent.acp\n", i)
		if i > 1 {
			fmt.Fprintf(&sb, "    dependsOn: [n%02d]\n", i-1)
		}
		sb.WriteString("    config: {profile: planner, prompt: do step}\n")
	}
	return sb.String()
}

// TestDraftGetReturnsEveryNodeIDWithinCap is the cap side of the fix: a
// 13-node pipeline's ids must ALL reach the model inside the draft.get
// tool's cap, and the YAML joins the view only while it fits.
func TestDraftGetReturnsEveryNodeIDWithinCap(t *testing.T) {
	draft := newFakeDraftService()
	draft.doc = []byte(thirteenNodeYAML())
	r := newMatrixRunner(t, newFakeModel(t, step{text: "done"}), draft, nil)

	out := r.execDraftGet(context.Background(), testCaller,
		toolCall("draft.get", map[string]any{"draft_id": "d-1"}), "draft.get")
	if !out.call.OK {
		t.Fatalf("draft.get refused: %+v", out.call)
	}
	if len(out.payload) > maxDraftGetBytes {
		t.Fatalf("payload is %d bytes, over the %d byte cap", len(out.payload), maxDraftGetBytes)
	}

	// The payload travels to the model verbatim inside the tool-result
	// message: every id must be visible there.
	msg := toolResultMessage([]toolOutcome{{call: out.call, payload: out.payload}})
	var shown string
	if msg.Content != nil {
		shown = *msg.Content
	}
	var body struct {
		Version  int             `json:"version"`
		Nodes    []draftNodeView `json:"nodes"`
		Document string          `json:"document"`
		Note     string          `json:"document_note"`
	}
	if err := json.Unmarshal(out.payload, &body); err != nil {
		t.Fatalf("payload is not a json object: %v", err)
	}
	if len(body.Nodes) != 13 {
		t.Fatalf("nodes = %d, want 13 (every node of the draft)", len(body.Nodes))
	}
	for i := 1; i <= 13; i++ {
		id := fmt.Sprintf("n%02d", i)
		if !strings.Contains(shown, `"`+id+`"`) {
			t.Fatalf("node id %s does not reach the model:\n%s", id, shown)
		}
	}
	if body.Version != 1 || body.Document == "" {
		t.Fatalf("version = %d, document present = %t, want version 1 and the full YAML while it fits",
			body.Version, body.Document != "")
	}
	if body.Note != "" {
		t.Fatalf("a fitting draft carries no omission note: %q", body.Note)
	}
}

// TestDraftGetOmitsYAMLHonestNoteWhenItDoesNotFit is the honest side of
// the same cap: when the YAML cannot fit next to the view, the model gets
// the COMPLETE structural view plus a note, never a truncated document.
func TestDraftGetOmitsYAMLHonestNoteWhenItDoesNotFit(t *testing.T) {
	var sb strings.Builder
	for i := 1; i <= 13; i++ {
		fmt.Fprintf(&sb, "  - id: n%02d\n    kind: agent.acp\n", i)
		if i > 1 {
			fmt.Fprintf(&sb, "    dependsOn: [n%02d]\n", i-1)
		}
		fmt.Fprintf(&sb, "    config: {profile: planner, prompt: %s}\n",
			strings.Repeat("a", 1500))
	}
	doc := DraftDoc{
		Document: []byte("apiVersion: communication.dev/v1alpha1\nkind: Pipeline\nmetadata:\n  name: big\nspec:\n  inputs: {type: object}\n  nodes:\n" + sb.String()),
		Version:  7,
	}
	payload := draftGetPayload("d-1", doc)
	if len(payload) > maxDraftGetBytes {
		t.Fatalf("payload is %d bytes, over the %d byte cap", len(payload), maxDraftGetBytes)
	}
	var body struct {
		Nodes    []draftNodeView `json:"nodes"`
		Document string          `json:"document"`
		Note     string          `json:"document_note"`
	}
	if err := json.Unmarshal(payload, &body); err != nil {
		t.Fatalf("payload is not a json object: %v", err)
	}
	if len(body.Nodes) != 13 {
		t.Fatalf("nodes = %d, want 13 (the view is complete even when the YAML does not fit)", len(body.Nodes))
	}
	if body.Document != "" {
		t.Fatalf("the YAML does not fit: %d bytes of document still travelled", len(body.Document))
	}
	if body.Note == "" || !strings.Contains(body.Note, "does not fit") {
		t.Fatalf("missing the honest omission note: %q", body.Note)
	}
}
