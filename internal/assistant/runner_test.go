package assistant

// ADR-0050 part 2 (decisions 3–5): the multi-turn tool-loop runner's
// behaviour against a scripted fake model — the trust matrix (3 levels x
// 4 tool classes), the confirm path, the question shape, and the
// draft-edit change record with its closed inverse undo.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
)

// --- the fake draft service (the version-checked PUT path) --------------

// fakeDraftService is the DraftService the runner edits through: reads
// return the current document and version, writes are a CAS (a stale
// expected version refuses, never a silent overwrite).
// runnerYAML is a schema-valid two-node draft (spec.inputs is required by
// the pipeline schema, which the edited document is re-validated against
// before it may reach the version-checked PUT).
const runnerYAML = `apiVersion: communication.dev/v1alpha1
kind: Pipeline
metadata:
  name: runner-fixture
spec:
  inputs: {type: object}
  nodes:
  - id: plan
    kind: agent.acp
    config: {profile: planner, prompt: plan the change}
  - id: check
    kind: model.chat
    dependsOn: [plan]
    config:
      model: test-model
      messages:
      - role: user
        content: inspect the plan
`

type fakeDraftService struct {
	mu           sync.Mutex
	doc          []byte
	version      int
	replaceCalls int
	getErr       error
	replaceErr   error
	project      string // "" when the service cannot name a project
}

func newFakeDraftService() *fakeDraftService {
	return &fakeDraftService{doc: []byte(runnerYAML), version: 1, project: "p-1"}
}

func (f *fakeDraftService) GetDocument(_ context.Context, _ Caller, draftID string) (DraftDoc, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.getErr != nil {
		return DraftDoc{}, f.getErr
	}
	if draftID != "d-1" {
		return DraftDoc{}, fmt.Errorf("no such draft %s", draftID)
	}
	return DraftDoc{Document: append([]byte(nil), f.doc...), Version: f.version, ProjectID: f.project}, nil
}

func (f *fakeDraftService) ReplaceDocument(_ context.Context, _ Caller, draftID string, document []byte, want int) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.replaceErr != nil {
		return 0, f.replaceErr
	}
	f.replaceCalls++
	if draftID != "d-1" || want != f.version {
		return 0, fmt.Errorf("the draft moved (want %d, have %d)", want, f.version)
	}
	f.doc = document
	f.version++
	return f.version, nil
}

// current loads the service's document as a node tree.
func (f *fakeDraftService) current(t *testing.T) *Doc {
	t.Helper()
	f.mu.Lock()
	doc := append([]byte(nil), f.doc...)
	ver := f.version
	f.mu.Unlock()
	d, err := LoadDraftDoc(doc)
	if err != nil {
		t.Fatalf("current document does not load (version %d): %v", ver, err)
	}
	return d
}

// newMatrixRunner wires one runner over a fresh broker + store + draft
// service + action map.
func newMatrixRunner(t *testing.T, model *fakeModel, draft *fakeDraftService,
	actions map[string]ActionExecutor) *ConversationRunner {
	t.Helper()
	b := newTestBroker(t, model, newFakeStore())
	return NewConversationRunner(ConversationRunnerDeps{Broker: b, Draft: draft, Actions: actions})
}

// runOne runs one turn as the test caller and refuses a failed turn.
func runOne(t *testing.T, r *ConversationRunner, trust TrustLevel) *TurnResult {
	t.Helper()
	res, f := r.RunTurn(context.Background(), TurnRequest{
		Caller: testCaller, Text: "go", TrustLevel: trust,
	})
	if f != nil {
		t.Fatalf("RunTurn failed: code=%s detail=%s", f.Code, f.Detail)
	}
	return res
}

// --- the trust matrix (decision 4: 3 levels x 4 classes) ----------------

func TestRunnerTrustMatrix(t *testing.T) {
	draftApply := toolCall("draft.apply", map[string]any{
		"draft_id": "d-1", "version": "1", "op": "insert_on_edge",
		"from": "plan", "to": "check", "kind": "agent.acp", "id": "extra",
		"config": `{"profile":"planner","prompt":"extra"}`,
	})
	for _, trust := range []TrustLevel{TrustAskAll, TrustAskRisky, TrustNoAsk} {
		t.Run(string(trust), func(t *testing.T) {
			t.Run("read_never_gated", func(t *testing.T) {
				model := newFakeModel(t,
					step{toolCalls: []toolCallRequest{toolCall("run.list", map[string]any{"project_id": "p-1"})}},
					step{text: "Here are the runs."},
				)
				r := newMatrixRunner(t, model, newFakeDraftService(), nil)
				res := runOne(t, r, trust)
				if res.Approval != nil {
					t.Fatalf("a read tool was gated: %v", res.Approval)
				}
				if model.bodyCount() != 2 || len(res.Changes) != 0 {
					t.Fatalf("read turn: %d model calls, %d changes; want 2 and 0",
						model.bodyCount(), len(res.Changes))
				}
				if len(res.Answer.ToolCalls) != 1 || !res.Answer.ToolCalls[0].OK {
					t.Fatalf("read tool call = %v, want one ok call", res.Answer.ToolCalls)
				}
			})
			t.Run("navigate_never_gated_and_logged", func(t *testing.T) {
				model := newFakeModel(t,
					step{toolCalls: []toolCallRequest{toolCall("ui.navigate", map[string]any{"route": "/inbox"})}},
					step{text: "Opening the inbox."},
				)
				r := newMatrixRunner(t, model, newFakeDraftService(), nil)
				res := runOne(t, r, trust)
				if res.Approval != nil {
					t.Fatalf("navigate was gated: %v", res.Approval)
				}
				if len(res.Changes) != 1 || res.Changes[0].Kind != "navigate" ||
					res.Changes[0].TargetRef != "/inbox" || res.Changes[0].UndoPayload != nil {
					t.Fatalf("navigate change = %+v, want one logged, not-undoable row", res.Changes)
				}
				if len(res.Answer.Links) != 1 || res.Answer.Links[0].Href != "/inbox" {
					t.Fatalf("navigate links = %v, want the app route link", res.Answer.Links)
				}
			})
			t.Run("draft_edit_gated_only_by_ask_all", func(t *testing.T) {
				model := newFakeModel(t, step{toolCalls: []toolCallRequest{draftApply}}, step{text: "done"})
				draft := newFakeDraftService()
				r := newMatrixRunner(t, model, draft, nil)
				res := runOne(t, r, trust)
				if trust == TrustAskAll {
					if res.Approval == nil || res.Approval.Tool != "draft.apply" {
						t.Fatalf("gated draft edit: approval = %+v, want the draft.apply card", res.Approval)
					}
					if draft.replaceCalls != 0 || len(res.Changes) != 0 {
						t.Fatalf("a gated edit executed: %d writes, %d changes", draft.replaceCalls, len(res.Changes))
					}
					if model.bodyCount() != 1 {
						t.Fatalf("a gated turn made %d model calls, want 1 (the turn stops)", model.bodyCount())
					}
					// The card carries the args the confirm path re-runs.
					if res.Approval.Args["draft_id"] != "d-1" || res.Approval.Args["op"] != "insert_on_edge" {
						t.Fatalf("approval args = %v, want the replayable edit args", res.Approval.Args)
					}
					return
				}
				if res.Approval != nil {
					t.Fatalf("draft edit gated at %s: %+v", trust, res.Approval)
				}
				if draft.replaceCalls != 1 || len(res.Changes) != 1 ||
					res.Changes[0].Kind != "draft_edit" || res.Changes[0].UndoPayload == nil {
					t.Fatalf("ungated edit: %d writes, changes = %+v, want one undoable draft_edit",
						draft.replaceCalls, res.Changes)
				}
			})
			t.Run("risky_gated_except_no_ask", func(t *testing.T) {
				model := newFakeModel(t,
					step{toolCalls: []toolCallRequest{toolCall("run.start", map[string]any{
						"project_id": "p-1", "pipeline_id": "pl-1"})}},
					step{text: "The run is on its way."},
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
				res := runOne(t, r, trust)
				if trust == TrustNoAsk {
					if execCalls != 1 {
						t.Fatalf("no_ask run.start executed %d times, want 1", execCalls)
					}
					if len(res.Changes) != 1 || res.Changes[0].Kind != "run_start" {
						t.Fatalf("no_ask change = %+v, want the run_start row", res.Changes)
					}
					if res.Changes[0].UndoPayload != nil {
						t.Fatalf("a started run recorded an inverse: %s", res.Changes[0].UndoPayload)
					}
					return
				}
				if res.Approval == nil || res.Approval.Tool != "run.start" {
					t.Fatalf("gated run.start: approval = %+v", res.Approval)
				}
				if execCalls != 0 {
					t.Fatalf("a gated action executed %d times", execCalls)
				}
				if model.bodyCount() != 1 {
					t.Fatalf("a gated turn made %d model calls, want 1", model.bodyCount())
				}
			})
		})
	}
}

// The same table, at the gate function itself (the pure decision):
// class x level -> gates or not.
func TestTrustGatesTable(t *testing.T) {
	levels := []TrustLevel{TrustAskAll, TrustAskRisky, TrustNoAsk}
	classes := []ToolClass{ClassRead, ClassNavigate, ClassDraftEdit, ClassRisky}
	want := map[TrustLevel]map[ToolClass]bool{
		TrustAskAll:   {ClassRead: false, ClassNavigate: false, ClassDraftEdit: true, ClassRisky: true},
		TrustAskRisky: {ClassRead: false, ClassNavigate: false, ClassDraftEdit: false, ClassRisky: true},
		TrustNoAsk:    {ClassRead: false, ClassNavigate: false, ClassDraftEdit: false, ClassRisky: false},
	}
	for _, l := range levels {
		for _, c := range classes {
			if got := l.Gates(c); got != want[l][c] {
				t.Errorf("Gates(%s, %v) = %v, want %v", l, c, got, want[l][c])
			}
		}
	}
	if got := NormalizeTrustLevel(""); got != TrustAskRisky {
		t.Errorf("NormalizeTrustLevel(\"\") = %s, want the ask_risky default", got)
	}
	if got := NormalizeTrustLevel("noisy-garbage"); got != TrustAskRisky {
		t.Errorf("NormalizeTrustLevel(garbage) = %s, want ask_risky (never no_ask)", got)
	}
}

// --- the confirm path (decision 4: exactly once, re-checked as the caller)

func TestExecuteActionConfirmPath(t *testing.T) {
	execCalls := 0
	actions := map[string]ActionExecutor{
		"run.start": func(_ context.Context, _ Caller, _ string, args map[string]string) (string, *ChangeRecord, error) {
			execCalls++
			if args["pipeline_id"] != "pl-1" {
				return "", nil, errors.New("the executor got different args")
			}
			return "Started run r-1", &ChangeRecord{
				Kind: "run_start", TargetRef: "run:r-1", Summary: "Started run r-1",
			}, nil
		},
	}
	draft := newFakeDraftService()
	model := newFakeModel(t, step{text: "unused"})
	r := newMatrixRunner(t, model, draft, actions)

	// One confirm executes exactly once; the change row is the run_start
	// audit with no inverse (a started run is not undoable).
	ack, ch, err := r.ExecuteAction(context.Background(), testCaller, "run.start",
		map[string]string{"project_id": "p-1", "pipeline_id": "pl-1"})
	if err != nil || execCalls != 1 || ch == nil || ch.Kind != "run_start" || ch.UndoPayload != nil {
		t.Fatalf("confirm run.start: ack=%q calls=%d change=%+v err=%v", ack, execCalls, ch, err)
	}
	// A denial keeps the request pending at the route: the error propagates.
	denied := &ConversationRunner{}
	_ = denied
	r2 := newMatrixRunner(t, newFakeModel(t, step{text: "unused"}), newFakeDraftService(),
		map[string]ActionExecutor{
			"run.retry": func(_ context.Context, _ Caller, _ string, _ map[string]string) (string, *ChangeRecord, error) {
				return "", nil, ErrActionDenied
			},
		})
	if _, _, err := r2.ExecuteAction(context.Background(), testCaller, "run.retry",
		map[string]string{"run_id": "r-1"}); !errors.Is(err, ErrActionDenied) {
		t.Fatalf("denied action err = %v, want ErrActionDenied (the request stays pending)", err)
	}
	// The gated draft-edit card's args replay through ExecuteAction: the
	// first confirm applies it (CAS at version 1), a stale replay after the
	// write is refused as a moved draft.
	args := map[string]string{
		"draft_id": "d-1", "version": "1", "op": "update_prompt",
		"node": "plan", "prompt": "plan twice as carefully",
	}
	_, ch, err = r.ExecuteAction(context.Background(), testCaller, "draft.apply", args)
	if err != nil || ch == nil || ch.Kind != "draft_edit" || ch.UndoPayload == nil {
		t.Fatalf("confirm draft.apply: change=%+v err=%v", ch, err)
	}
	if _, ch, err := r.ExecuteAction(context.Background(), testCaller, "draft.apply", args); err == nil {
		t.Fatalf("a stale replay executed on a moved draft (change %+v)", ch)
	}
	// An unknown tool is refused, never guessed.
	if _, _, err := r.ExecuteAction(context.Background(), testCaller, "run.delete", nil); err == nil {
		t.Fatal("an unregistered tool was executed")
	}
}

// --- questions (decision 3: 2-4 options, free text always on) ------------

func TestRunnerQuestionShape(t *testing.T) {
	options := `[{"label":"New issues only","value":"new_only"},{"label":"New + pending","value":"both"}]`
	model := newFakeModel(t,
		step{toolCalls: []toolCallRequest{toolCall("ui.question", map[string]any{
			"prompt": "Use this beta for new issues only, or also replace pending ones?", "options": options})}},
		step{text: "unused after the question"},
	)
	r := newMatrixRunner(t, model, newFakeDraftService(), nil)
	res := runOne(t, r, TrustAskRisky)
	if res.Approval != nil {
		t.Fatalf("a question was gated: %+v", res.Approval)
	}
	q := res.Question
	if q == nil || len(q.Options) != 2 || !q.AllowFreeText || q.Prompt == "" {
		t.Fatalf("question = %+v, want the prompt, both options and free text on", q)
	}
	if q.Options[0].Label != "New issues only" || q.Options[0].Value != "new_only" {
		t.Fatalf("option 0 = %+v", q.Options[0])
	}
	if model.bodyCount() != 1 {
		t.Fatalf("a question turn made %d model calls, want 1 (the turn stops)", model.bodyCount())
	}
	// The options are shape-validated: one option is refused, as are
	// duplicate values — the turn falls through to the model's text.
	for name, bad := range map[string]string{
		"one_option": `[{"label":"Only","value":"only"}]`,
		"dup_value":  `[{"label":"A","value":"same"},{"label":"B","value":"same"}]`,
	} {
		model := newFakeModel(t,
			step{toolCalls: []toolCallRequest{toolCall("ui.question", map[string]any{
				"prompt": "Pick", "options": bad})}},
			step{text: "Tell me which one."},
		)
		r := newMatrixRunner(t, model, newFakeDraftService(), nil)
		res := runOne(t, r, TrustAskRisky)
		if res.Question != nil {
			t.Fatalf("%s: a malformed question was accepted: %+v", name, res.Question)
		}
		if len(res.Answer.ToolCalls) != 1 || res.Answer.ToolCalls[0].OK ||
			res.Answer.ToolCalls[0].Reason != "bad_arguments" {
			t.Fatalf("%s: tool call = %+v, want ok=false bad_arguments", name, res.Answer.ToolCalls)
		}
	}
}

// --- draft edit: the change record and the closed inverse undo ----------

func TestDraftEditChangeAndUndo(t *testing.T) {
	model := newFakeModel(t,
		step{toolCalls: []toolCallRequest{toolCall("draft.apply", map[string]any{
			"draft_id": "d-1", "version": "1", "op": "insert_on_edge",
			"from": "plan", "to": "check", "kind": "agent.acp", "id": "extra",
			"config": `{"profile":"planner","prompt":"extra"}`})}},
		step{text: "The node is in."},
	)
	draft := newFakeDraftService()
	r := newMatrixRunner(t, model, draft, nil)
	res := runOne(t, r, TrustNoAsk)
	if len(res.Changes) != 1 {
		t.Fatalf("changes = %+v, want one draft_edit row", res.Changes)
	}
	ch := res.Changes[0]
	if ch.Kind != "draft_edit" || ch.TargetRef != "draft:d-1" || ch.UndoPayload == nil {
		t.Fatalf("change = %+v, want the undoable draft_edit row", ch)
	}
	var rec draftUndoPayload
	if err := json.Unmarshal(ch.UndoPayload, &rec); err != nil {
		t.Fatalf("undo payload does not parse: %v", err)
	}
	if rec.DraftID != "d-1" || rec.Inverse.Op != "delete_node" || rec.Inverse.Node != "extra" {
		t.Fatalf("inverse = %+v, want delete_node extra on draft d-1", rec)
	}
	// The edge split landed: check now depends on the inserted node.
	doc := draft.current(t)
	n, _ := doc.Find("check")
	if !contains(n.DependsOn, "extra") || contains(n.DependsOn, "plan") {
		t.Fatalf("check dependsOn = %v, want the split edge [extra]", n.DependsOn)
	}

	// The undo: the inverse applies to the draft's CURRENT version through
	// the version-checked PUT, and the split edge is rewired back.
	err := DraftEditUndoer{Draft: draft}.UndoChange(context.Background(), testCaller, "chg-1", ch.UndoPayload)
	if err != nil {
		t.Fatalf("UndoChange: %v", err)
	}
	doc = draft.current(t)
	if doc.HasID("extra") {
		t.Fatal("the undo left the inserted node in the draft")
	}
	n, _ = doc.Find("check")
	if !contains(n.DependsOn, "plan") || contains(n.DependsOn, "extra") {
		t.Fatalf("after undo, check dependsOn = %v, want the original [plan]", n.DependsOn)
	}

	// A structural refusal: the inserted node is no longer in the draft
	// (the draft moved around it) — the inverse refuses, draft untouched.
	model2 := newFakeModel(t,
		step{toolCalls: []toolCallRequest{toolCall("draft.apply", map[string]any{
			"draft_id": "d-1", "version": "3", "op": "insert_on_edge",
			"from": "plan", "to": "check", "kind": "agent.acp", "id": "second",
			"config": `{"profile":"planner","prompt":"again"}`})}},
		step{text: "done"},
	)
	r2 := newMatrixRunner(t, model2, draft, nil)
	res2 := runOne(t, r2, TrustNoAsk)
	if len(res2.Changes) != 1 || res2.Changes[0].UndoPayload == nil {
		t.Fatalf("second edit change = %+v", res2.Changes)
	}
	// Simulate the draft moving: the inserted node was deleted by a human.
	fresh, _ := draft.GetDocument(context.Background(), testCaller, "d-1")
	stripped := strings.ReplaceAll(string(fresh.Document), "second", "deleted-by-human")
	_, _ = draft.ReplaceDocument(context.Background(), testCaller, "d-1",
		[]byte(stripped), fresh.Version)
	err = DraftEditUndoer{Draft: draft}.UndoChange(context.Background(), testCaller,
		"chg-2", res2.Changes[0].UndoPayload)
	if !errors.Is(err, ErrInverseNotApplicable) {
		t.Fatalf("a moved draft refused the wrong way: %v, want structurally inapplicable", err)
	}

	// Stale version on the edit itself: the model read v1, the draft is at
	// v2 — the call is reported as a moved draft, nothing is written.
	model3 := newFakeModel(t,
		step{toolCalls: []toolCallRequest{toolCall("draft.apply", map[string]any{
			"draft_id": "d-1", "version": "1", "op": "update_prompt",
			"node": "plan", "prompt": "stale edit"})}},
		step{text: "I will re-read the draft."},
	)
	r3 := newMatrixRunner(t, model3, draft, nil)
	res3 := runOne(t, r3, TrustNoAsk)
	if len(res3.Changes) != 0 {
		t.Fatalf("a stale-version edit recorded a change: %+v", res3.Changes)
	}
	if len(res3.Answer.ToolCalls) != 1 || res3.Answer.ToolCalls[0].OK ||
		res3.Answer.ToolCalls[0].Reason != "draft_moved" {
		t.Fatalf("stale edit tool call = %+v, want ok=false draft_moved", res3.Answer.ToolCalls)
	}
}

// The change row's project id follows the draft service: org-scoped
// drafts name no project (""), so the row carries a NULL project id —
// the old code pinned &"" on every draft_edit row, and an empty-string
// uuid fails the insert against real Postgres.
func TestDraftEditChangeProjectID(t *testing.T) {
	for _, tc := range []struct {
		name, project string
		wantNil       bool
	}{
		{name: "org_scoped_nil", project: "", wantNil: true},
		{name: "project_named", project: "p-1", wantNil: false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			model := newFakeModel(t,
				step{toolCalls: []toolCallRequest{toolCall("draft.apply", map[string]any{
					"draft_id": "d-1", "version": "1", "op": "update_prompt",
					"node": "plan", "prompt": "plan twice as carefully"})}},
				step{text: "done"},
			)
			draft := newFakeDraftService()
			draft.project = tc.project
			r := newMatrixRunner(t, model, draft, nil)
			res := runOne(t, r, TrustNoAsk)
			if len(res.Changes) != 1 {
				t.Fatalf("changes = %+v, want one draft_edit row", res.Changes)
			}
			ch := res.Changes[0]
			if tc.wantNil {
				if ch.ProjectID != nil {
					t.Fatalf("ProjectID = %q, want nil (org-scoped draft)", *ch.ProjectID)
				}
			} else if ch.ProjectID == nil || *ch.ProjectID != tc.project {
				t.Fatalf("ProjectID = %v, want %q", ch.ProjectID, tc.project)
			}
		})
	}
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}
