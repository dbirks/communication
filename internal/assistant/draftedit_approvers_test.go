package assistant

// The approver contract of the closed draft-edit set (the ADR-0044/0050
// amendment behind shell-journey leg f): a human.approval insert CARRIES its
// approver roles in the same op (validated against the closed project-role
// set), update_approvers changes an existing approval step's roles, and
// every refusal the loop feeds back to the model names WHAT is invalid —
// the validator's field/value and the valid set — so the model corrects it
// in the same turn.

import (
	"encoding/json"
	"strings"
	"testing"
)

// gateFixtureYAML is a schema-valid two-node draft whose second node is a
// human.approval gate with a recorded approver role (contributor).
const gateFixtureYAML = `apiVersion: communication.dev/v1alpha1
kind: Pipeline
metadata:
  name: gate-fixture
spec:
  inputs: {type: object}
  nodes:
  - id: plan
    kind: agent.acp
    config: {profile: planner, prompt: plan the change}
  - id: approve
    kind: human.approval
    dependsOn: [plan]
    config:
      summary: approve the plan
      approverRoles: [contributor]
`

// TestDraftInsertHumanApprovalCarriesApprovers is the acceptance insert:
// the approval step lands WITH its approver roles in the same op, so the
// gate is decidable from the moment it is in the draft (no follow-up that
// cannot exist in the closed op set).
func TestDraftInsertHumanApprovalCarriesApprovers(t *testing.T) {
	apply := toolCall("draft.apply", map[string]any{
		"draft_id": "d-1", "version": "1", "op": "insert_on_edge",
		"from": "plan", "to": "check", "kind": "human.approval", "id": "journey_check",
		"config":         `{"summary":"approve the change before it proceeds"}`,
		"approver_roles": `["maintainer"]`,
	})
	model := newFakeModel(t,
		step{toolCalls: []toolCallRequest{apply}},
		step{text: "Added the approval step journey_check, approvable by maintainers."},
	)
	draft := newFakeDraftService()
	r := newMatrixRunner(t, model, draft, nil)
	res := runOne(t, r, TrustNoAsk)

	if !res.Answer.ToolCalls[0].OK {
		t.Fatalf("the insert with approver roles was refused: %+v", res.Answer.ToolCalls[0])
	}
	d := draft.current(t)
	node, ok := d.Find("journey_check")
	if !ok || node.Kind != "human.approval" {
		t.Fatalf("journey_check is not in the draft as a human.approval: %+v", d.byID)
	}
	if len(node.ApproverRoles) != 1 || node.ApproverRoles[0] != "maintainer" {
		t.Fatalf("approver roles = %v, want [maintainer] on the inserted node", node.ApproverRoles)
	}
	if !strings.Contains(string(draft.doc), "journey_check") || !strings.Contains(string(draft.doc), "approverRoles") {
		t.Fatalf("the draft YAML does not carry the new node with its approverRoles:\n%s", draft.doc)
	}
	// The change is undoable: the inverse is the delete_node of the whole
	// inserted step (roles included).
	if len(res.Changes) != 1 || res.Changes[0].UndoPayload == nil {
		t.Fatalf("changes = %+v, want one undoable draft_edit", res.Changes)
	}
}

// TestDraftApplyRefusalNamesMissingApprovers: an insert of human.approval
// WITHOUT roles is refused, and the tool result the model sees names the
// missing approver_roles AND the valid roles — the same-turn fix.
func TestDraftApplyRefusalNamesMissingApprovers(t *testing.T) {
	noRoles := toolCall("draft.apply", map[string]any{
		"draft_id": "d-1", "version": "1", "op": "insert_on_edge",
		"from": "plan", "to": "check", "kind": "human.approval", "id": "journey_check",
	})
	withRoles := toolCall("draft.apply", map[string]any{
		"draft_id": "d-1", "version": "1", "op": "insert_on_edge",
		"from": "plan", "to": "check", "kind": "human.approval", "id": "journey_check",
		"config":         `{"summary":"approve the change before it proceeds"}`,
		"approver_roles": `["maintainer"]`,
	})
	model := newFakeModel(t,
		step{toolCalls: []toolCallRequest{noRoles}},
		step{toolCalls: []toolCallRequest{withRoles}},
		step{text: "Added the approval step journey_check."},
	)
	draft := newFakeDraftService()
	r := newMatrixRunner(t, model, draft, nil)
	res := runOne(t, r, TrustNoAsk)

	if model.bodyCount() != 3 {
		t.Fatalf("model calls = %d, want 3 (refused insert, retried insert, answer)", model.bodyCount())
	}
	second := userMessages(model.seen(1))
	if !strings.Contains(second, "approver_roles") ||
		!strings.Contains(second, "maintainer") ||
		!strings.Contains(second, "contributor") {
		t.Fatalf("the refusal shown to the model does not name the missing argument and the valid roles:\n%s", second)
	}
	if !strings.Contains(second, "approver_missing") {
		t.Fatalf("the refusal shown to the model does not name its reason code:\n%s", second)
	}
	if !res.Answer.ToolCalls[1].OK || draft.replaceCalls != 1 {
		t.Fatalf("the corrected retry did not execute: calls = %+v, writes = %d", res.Answer.ToolCalls, draft.replaceCalls)
	}
}

// TestDraftApplyRefusalNamesUnknownRole: a role outside the closed
// project-role set is refused naming the offending role and the valid set.
func TestDraftApplyRefusalNamesUnknownRole(t *testing.T) {
	badRole := toolCall("draft.apply", map[string]any{
		"draft_id": "d-1", "version": "1", "op": "insert_on_edge",
		"from": "plan", "to": "check", "kind": "human.approval", "id": "journey_check",
		"approver_roles": `["wizard"]`,
	})
	model := newFakeModel(t,
		step{toolCalls: []toolCallRequest{badRole}},
		step{text: "I used a role that does not exist."},
	)
	draft := newFakeDraftService()
	r := newMatrixRunner(t, model, draft, nil)
	res := runOne(t, r, TrustNoAsk)

	second := userMessages(model.seen(1))
	if !strings.Contains(second, "wizard") ||
		!strings.Contains(second, "unknown_role") ||
		!strings.Contains(second, "maintainer") ||
		!strings.Contains(second, "contributor") {
		t.Fatalf("the refusal shown to the model does not name the bad role and the valid set:\n%s", second)
	}
	if draft.replaceCalls != 0 || len(res.Answer.ToolCalls) != 1 || res.Answer.ToolCalls[0].OK {
		t.Fatalf("the refused call must not execute: writes = %d, calls = %+v", draft.replaceCalls, res.Answer.ToolCalls)
	}
}

// TestApproversNotConfigNorOtherKind: the same two refusal sides —
// approverRoles hidden inside the config map, and approver_roles on a
// non-approval kind — each naming the fix.
func TestApproversNotConfigNorOtherKind(t *testing.T) {
	cases := []struct {
		name    string
		args    map[string]any
		wantFix string
	}{
		{"approverRoles inside config is the top-level argument", map[string]any{
			"draft_id": "d-1", "version": "1", "op": "insert_on_edge",
			"from": "plan", "to": "check", "kind": "human.approval", "id": "journey_check",
			"config": `{"summary":"approve","approverRoles":["maintainer"]}`,
		}, "approver_roles"},
		{"roles on a non-approval kind", map[string]any{
			"draft_id": "d-1", "version": "1", "op": "insert_on_edge",
			"from": "plan", "to": "check", "kind": "model.chat", "id": "chat_check",
			"approver_roles": `["maintainer"]`,
		}, "human.approval"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			apply := toolCall("draft.apply", tc.args)
			model := newFakeModel(t,
				step{toolCalls: []toolCallRequest{apply}},
				step{text: "I made an invalid call."},
			)
			draft := newFakeDraftService()
			r := newMatrixRunner(t, model, draft, nil)
			runOne(t, r, TrustNoAsk)

			second := userMessages(model.seen(1))
			if !strings.Contains(second, "proposal_invalid") || !strings.Contains(second, tc.wantFix) {
				t.Fatalf("the refusal shown to the model does not name the fix (%s):\n%s", tc.wantFix, second)
			}
			if draft.replaceCalls != 0 {
				t.Fatalf("the refused call wrote: %d writes", draft.replaceCalls)
			}
		})
	}
}

// TestUpdateApproversOpAndUndo: update_approvers replaces an existing
// approval step's roles, is recorded undoable with the PREVIOUS roles, and
// the closed inverse restores them byte for byte.
func TestUpdateApproversOpAndUndo(t *testing.T) {
	apply := toolCall("draft.apply", map[string]any{
		"draft_id": "d-1", "version": "1", "op": "update_approvers",
		"node": "approve", "approver_roles": `["maintainer","contributor"]`,
	})
	model := newFakeModel(t,
		step{toolCalls: []toolCallRequest{apply}},
		step{text: "The approval step is now approvable by maintainers and contributors."},
	)
	draft := newFakeDraftService()
	draft.doc = []byte(gateFixtureYAML)
	r := newMatrixRunner(t, model, draft, nil)
	res := runOne(t, r, TrustNoAsk)

	if len(res.Answer.ToolCalls) != 1 || !res.Answer.ToolCalls[0].OK {
		t.Fatalf("update_approvers was refused: %+v", res.Answer.ToolCalls)
	}
	d := draft.current(t)
	node, ok := d.Find("approve")
	if !ok {
		t.Fatalf("approve is not in the draft")
	}
	if len(node.ApproverRoles) != 2 || node.ApproverRoles[0] != "maintainer" || node.ApproverRoles[1] != "contributor" {
		t.Fatalf("approver roles = %v, want [maintainer contributor]", node.ApproverRoles)
	}
	// The change row carries the closed inverse with the PREVIOUS roles.
	if len(res.Changes) != 1 || res.Changes[0].UndoPayload == nil {
		t.Fatalf("changes = %+v, want one undoable draft_edit", res.Changes)
	}
	var rec draftUndoPayload
	if err := json.Unmarshal(res.Changes[0].UndoPayload, &rec); err != nil {
		t.Fatalf("undo payload does not parse: %v", err)
	}
	if rec.Inverse.Op != "update_approvers" || rec.Inverse.Node != "approve" ||
		len(rec.Inverse.ApproverRoles) != 1 || rec.Inverse.ApproverRoles[0] != "contributor" {
		t.Fatalf("inverse = %+v, want update_approvers on approve restoring [contributor]", rec.Inverse)
	}
	// The inverse restores the previous roles.
	out, err := applyInverse(draft.doc, rec.Inverse)
	if err != nil {
		t.Fatalf("the inverse was refused: %v", err)
	}
	back, err := LoadDraftDoc(out)
	if err != nil {
		t.Fatalf("the undone document does not load: %v", err)
	}
	restored, _ := back.Find("approve")
	if len(restored.ApproverRoles) != 1 || restored.ApproverRoles[0] != "contributor" {
		t.Fatalf("the inverse did not restore the previous roles: %v", restored.ApproverRoles)
	}
}

// TestUpdateApproversRefusalNamesWrongKind: update_approvers on a node
// that is not a human.approval is refused naming the node's real kind.
func TestUpdateApproversRefusalNamesWrongKind(t *testing.T) {
	apply := toolCall("draft.apply", map[string]any{
		"draft_id": "d-1", "version": "1", "op": "update_approvers",
		"node": "plan", "approver_roles": `["maintainer"]`,
	})
	model := newFakeModel(t,
		step{toolCalls: []toolCallRequest{apply}},
		step{text: "That node is an agent step, not an approval step."},
	)
	draft := newFakeDraftService()
	r := newMatrixRunner(t, model, draft, nil)
	runOne(t, r, TrustNoAsk)

	second := userMessages(model.seen(1))
	if !strings.Contains(second, `node \"plan\" is agent.acp`) {
		t.Fatalf("the refusal shown to the model does not name the node and its kind:\n%s", second)
	}
}

// TestDraftApplyArgumentErrorIsActionable: a proposal_invalid the model
// earns by its own argument shape (a version that is not an integer, a
// config that is not a JSON object) must name the fix — never the stale
// "the draft moved" story that tells it nothing it can do.
func TestDraftApplyArgumentErrorIsActionable(t *testing.T) {
	apply := toolCall("draft.apply", map[string]any{
		"draft_id": "d-1", "version": "one", "op": "insert_after",
		"after": "check", "kind": "model.chat", "id": "chat_step",
		"approver_roles": `["maintainer"]`,
	})
	model := newFakeModel(t,
		step{toolCalls: []toolCallRequest{apply}},
		step{text: "I sent a version that was not an integer."},
	)
	draft := newFakeDraftService()
	r := newMatrixRunner(t, model, draft, nil)
	runOne(t, r, TrustNoAsk)

	second := userMessages(model.seen(1))
	if !strings.Contains(second, "version") || strings.Contains(second, "the draft moved since it was read") {
		t.Fatalf("the refusal shown to the model does not name the version fix (or reports a stale draft):\n%s", second)
	}
}
