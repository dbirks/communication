package assistant

// The workflow.draft read tool: "what is the open draft of workflow X?"
// in one read fan — the lab evidence for it is the acceptance journey
// that spent turns hunting the draft id through palette.search before it
// reached draft.get / draft.apply.

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// TestWorkflowDraftToolClassifiedRead: the closed table names the tool
// read, and the trust gate never gates a read (even ask_all).
func TestWorkflowDraftToolClassifiedRead(t *testing.T) {
	c, ok := ClassOf("workflow.draft")
	if !ok {
		t.Fatalf("workflow.draft is not in the closed tool-class table")
	}
	if c != ClassRead {
		t.Fatalf("workflow.draft class = %v, want ClassRead", c)
	}
	if NormalizeTrustLevel(TrustAskAll).Gates(c) {
		t.Fatalf("ask_risky's stricter level gates a read tool")
	}
}

// offeredToolNames is the wire names the runner announced on its first
// model call.
func offeredToolNames(t *testing.T, model *fakeModel) map[string]bool {
	t.Helper()
	if len(model.requests) == 0 {
		t.Fatalf("no model request was captured")
	}
	out := map[string]bool{}
	for _, spec := range model.requests[0].Tools {
		out[spec.Function.Name] = true
	}
	return out
}

// TestWorkflowDraftOfferedAndExecuted: the tool is announced when the
// draft service carries the locator face, and a turn under the strictest
// trust level executes it (no approval card) and hands the model the
// open draft's id, version and the latest revision.
func TestWorkflowDraftOfferedAndExecuted(t *testing.T) {
	draft := newFakeDraftService()
	draft.locatorRef = "feature-development"
	draft.locatorView = PipelineDraftView{
		PipelineID:  "pl-1",
		Slug:        "feature-development",
		DisplayName: "Feature Development",
		Draft:       &OpenDraft{DraftID: "d-1", Version: 3, Status: "draft", UpdatedAt: time.Now().UTC()},
		LatestRev:   &PublishedRevision{Number: 2, VersionLabel: "v2.0"},
	}
	model := newFakeModel(t,
		step{toolCalls: []toolCallRequest{toolCall("workflow.draft", map[string]any{"pipeline": "feature-development"})}},
		step{text: "The open draft is d-1."},
	)
	r := newMatrixRunner(t, model, draft, nil)
	res := runOne(t, r, TrustAskAll) // the strictest level: a read must still run
	if res.Approval != nil {
		t.Fatalf("a read tool was gated: %v", res.Approval)
	}
	if !offeredToolNames(t, model)["workflow_draft"] {
		t.Fatalf("workflow_draft was not announced: %v", offeredToolNames(t, model))
	}
	tcs := res.Answer.ToolCalls
	if len(tcs) != 1 {
		t.Fatalf("tool calls = %+v, want one", tcs)
	}
	if !tcs[0].OK || tcs[0].Name != "workflow.draft" {
		t.Fatalf("call = %+v, want an ok workflow.draft", tcs[0])
	}
	// The model-facing payload carries the draft id the next call anchors on.
	var payload struct {
		PipelineID  string `json:"pipeline_id"`
		Slug        string `json:"slug"`
		DisplayName string `json:"display_name"`
		Draft       *struct {
			DraftID   string `json:"draft_id"`
			Version   int    `json:"version"`
			Status    string `json:"status"`
			UpdatedAt string `json:"updated_at"`
		} `json:"draft"`
		LatestRevision *struct {
			Number       int    `json:"number"`
			VersionLabel string `json:"version_label"`
		} `json:"latest_revision"`
	}
	raw, ok := lastToolPayload(t, model, "workflow.draft")
	if !ok {
		t.Fatalf("no workflow.draft payload was recorded")
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		t.Fatalf("payload does not decode: %v (%s)", err, raw)
	}
	if payload.PipelineID != "pl-1" || payload.Slug != "feature-development" || payload.DisplayName != "Feature Development" {
		t.Fatalf("payload = %+v, want the resolved workflow", payload)
	}
	if payload.Draft == nil || payload.Draft.DraftID != "d-1" || payload.Draft.Version != 3 || payload.Draft.Status != "draft" {
		t.Fatalf("payload.draft = %+v, want the open draft", payload.Draft)
	}
	if payload.LatestRevision == nil || payload.LatestRevision.Number != 2 || payload.LatestRevision.VersionLabel != "v2.0" {
		t.Fatalf("payload.latest_revision = %+v, want the latest published revision", payload.LatestRevision)
	}
}

// TestWorkflowDraftNoDraftHint: a workflow with no open draft answers a
// null draft plus the honest hint at the create-from-latest-revision
// behaviour, not a fabricated draft id.
func TestWorkflowDraftNoDraftHint(t *testing.T) {
	draft := newFakeDraftService()
	draft.locatorView = PipelineDraftView{
		PipelineID: "pl-1",
		Slug:       "feature-development",
		LatestRev:  &PublishedRevision{Number: 1, VersionLabel: "v1.0"},
	}
	model := newFakeModel(t,
		step{toolCalls: []toolCallRequest{toolCall("workflow.draft", map[string]any{"pipeline": "pl-1"})}},
		step{text: "There is no open draft yet."},
	)
	r := newMatrixRunner(t, model, draft, nil)
	res := runOne(t, r, TrustAskRisky)
	tcs := res.Answer.ToolCalls
	if len(tcs) != 1 || !tcs[0].OK {
		t.Fatalf("tool calls = %+v, want one ok call", tcs)
	}
	raw, ok := lastToolPayload(t, model, "workflow.draft")
	if !ok {
		t.Fatalf("no workflow.draft payload was recorded")
	}
	var payload struct {
		Hint string `json:"hint"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		t.Fatalf("payload does not decode: %v (%s)", err, raw)
	}
	// An explicit null (not an absent key): the model sees "no draft",
	// never a missing field it might read as "not checked".
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		t.Fatalf("payload does not decode: %v (%s)", err, raw)
	}
	d, present := fields["draft"]
	if !present || string(d) != "null" {
		t.Fatalf("payload.draft = %v (present=%v), want an explicit null", d, present)
	}
	if payload.Hint == "" {
		t.Fatalf("no hint on a workflow without an open draft (%s)", raw)
	}
}

// TestWorkflowDraftNotFound: a reference the caller cannot see is the
// not-found refusal — no rows, no name (the 404 rule).
func TestWorkflowDraftNotFound(t *testing.T) {
	draft := newFakeDraftService()
	draft.locatorRef = "pl-1" // anything else is invisible
	model := newFakeModel(t,
		step{toolCalls: []toolCallRequest{toolCall("workflow.draft", map[string]any{"pipeline": "other-org-pipeline"})}},
		step{text: "I cannot see that workflow."},
	)
	r := newMatrixRunner(t, model, draft, nil)
	res := runOne(t, r, TrustAskRisky)
	tcs := res.Answer.ToolCalls
	if len(tcs) != 1 {
		t.Fatalf("tool calls = %+v, want one", tcs)
	}
	if tcs[0].OK || tcs[0].Reason != "not_found" {
		t.Fatalf("call = %+v, want a not_found refusal", tcs[0])
	}
}

// TestWorkflowDraftAbsentService: a draft service without the locator
// face keeps the tool out of the announced set, so the model never asks
// for it (the honest-degradation rule).
func TestWorkflowDraftAbsentService(t *testing.T) {
	model := newFakeModel(t, step{text: "Nothing to do."})
	b := newTestBroker(t, model, newFakeStore())
	r := NewConversationRunner(ConversationRunnerDeps{Broker: b, Draft: bareDraftService{}, Actions: nil})
	if _, f := r.RunTurn(context.Background(), TurnRequest{Caller: testCaller, Text: "hi", TrustLevel: TrustAskRisky}); f != nil {
		t.Fatalf("RunTurn failed: code=%s detail=%s", f.Code, f.Detail)
	}
	if offeredToolNames(t, model)["workflow_draft"] {
		t.Fatalf("workflow_draft was announced without the locator face")
	}
}

// lastToolPayload recovers the model-facing payload of one executed call
// from the tool-results message the runner sent back to the model (the
// "  data: <json>" line under the call's record line).
func lastToolPayload(t *testing.T, model *fakeModel, name string) (json.RawMessage, bool) {
	t.Helper()
	if len(model.requests) < 2 {
		t.Fatalf("no follow-up model request was captured")
	}
	for _, m := range model.requests[1].Messages {
		if m.Role != "user" || m.Content == nil || !strings.Contains(*m.Content, "TOOL RESULTS") {
			continue
		}
		lines := strings.Split(*m.Content, "\n")
		for i, line := range lines {
			if strings.HasPrefix(line, "- "+name+" ") && i+1 < len(lines) {
				if data, ok := strings.CutPrefix(lines[i+1], "  data: "); ok {
					return json.RawMessage(strings.TrimSpace(data)), true
				}
			}
		}
	}
	return nil, false
}

// bareDraftService is a DraftService without the DraftLocator face.
type bareDraftService struct{}

func (bareDraftService) GetDocument(context.Context, Caller, string) (DraftDoc, error) {
	return DraftDoc{}, ErrNotFound
}

func (bareDraftService) ReplaceDocument(context.Context, Caller, string, []byte, int) (int, error) {
	return 0, ErrNotFound
}
