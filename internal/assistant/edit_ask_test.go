package assistant

// ADR-0073 applied to the assistant conversation loop, and the leak it
// exposed (lab: shell journey f on flash-next — acceptance runs
// 41458760870 / 41560172301):
//
//  1. The model answers an explicit "add a step … to the draft" ask with
//     prose and no draft.apply call. Nothing changed, so the change chip
//     cannot render and the UI needs a human "make that change now."
//     follow-up. The runner now feeds the omission back once, in-turn,
//     and the corrected call lands the change.
//  2. A draft.apply lands and a LATER completion of the same turn fails.
//     The route stores nothing (ADR-0034), but until now the DRAFT stayed
//     mutated with no change row: invisible, un-undoable, and a false
//     "the change landed" for anyone checking the draft. A failed turn
//     now rolls its undoable edits back before answering 5xx.

import (
	"context"
	"strings"
	"testing"
)

// journeyEditAsk is the lab's exact journey-f ask; the nudge must fire on
// these words, not on a paraphrase of them.
const journeyEditAsk = "Add a human approval step named journey_check after journey_step in feature-development-deterministic's draft"

func editApplyCall() toolCallRequest {
	return toolCall("draft.apply", map[string]any{
		"draft_id": "d-1", "version": "1", "op": "insert_on_edge",
		"from": "plan", "to": "check", "kind": "agent.acp", "id": "journey_check",
		"config": `{"profile":"planner","prompt":"journey check"}`,
	})
}

// runAsk runs one turn with an explicit ask (runOne pins "go").
func runAsk(t *testing.T, r *ConversationRunner, trust TrustLevel, ask string) (*TurnResult, *Failure) {
	t.Helper()
	return r.RunTurn(context.Background(), TurnRequest{
		Caller: testCaller, Text: ask, TrustLevel: trust,
	})
}

// feedbackCount counts the runner's retry turns (user-role messages
// naming the omission) carried in one completion request.
func feedbackCount(req chatRequest) int {
	n := 0
	for _, m := range req.Messages {
		if m.Role == "user" && m.Content != nil &&
			strings.Contains(*m.Content, "no draft.apply call") {
			n++
		}
	}
	return n
}

// Mode 1, fixed: text-only answer to the edit ask → ONE feedback retry →
// the model calls draft.apply → the change is real and returned.
func TestRunnerNudgesAnEditTextAnswerIntoDraftApply(t *testing.T) {
	model := newFakeModel(t,
		step{text: "I found the draft: you could add journey_check after journey_step."},
		step{toolCalls: []toolCallRequest{editApplyCall()}},
		step{text: "Added journey_check after plan."},
	)
	draft := newFakeDraftService()
	r := newMatrixRunner(t, model, draft, nil)
	res, f := runAsk(t, r, TrustAskRisky, journeyEditAsk)
	if f != nil {
		t.Fatalf("the nudged turn failed: code=%s detail=%s", f.Code, f.Detail)
	}
	if got := model.bodyCount(); got != 3 {
		t.Fatalf("completions = %d, want 3 (the nudge costs exactly one)", got)
	}
	if n := feedbackCount(model.seen(1)); n != 1 {
		t.Fatalf("feedback turns in the retry request = %d, want 1", n)
	}
	if n := feedbackCount(model.seen(2)); n != 1 {
		t.Fatalf("feedback turns carried after the apply = %d, want the one nudge", n)
	}
	if len(res.Changes) != 1 || res.Changes[0].Kind != "draft_edit" {
		t.Fatalf("changes = %+v, want the nudged draft_edit row", res.Changes)
	}
	if res.Answer == nil || !strings.Contains(res.Answer.AnswerMarkdown, "journey_check") {
		t.Fatalf("answer = %+v, want the post-apply answer", res.Answer)
	}
	if doc := draft.current(t); !doc.HasID("journey_check") {
		t.Fatal("the nudged turn did not land the step in the draft")
	}
}

// The nudge is bounded at one: a model that answers text-only twice ships
// its second answer, and the turn makes exactly two completions.
func TestRunnerNudgesOnlyOnce(t *testing.T) {
	model := newFakeModel(t,
		step{text: "You can add it in the Studio editor."},
		step{text: "Sure — the draft editor has an Add step button."},
	)
	draft := newFakeDraftService()
	r := newMatrixRunner(t, model, draft, nil)
	res, f := runAsk(t, r, TrustAskRisky, journeyEditAsk)
	if f != nil {
		t.Fatalf("RunTurn failed: code=%s detail=%s", f.Code, f.Detail)
	}
	if got := model.bodyCount(); got != 2 {
		t.Fatalf("completions = %d, want 2 (one nudge, then the answer ships)", got)
	}
	if len(res.Changes) != 0 {
		t.Fatalf("a text-only turn recorded changes: %+v", res.Changes)
	}
	if res.Answer == nil || !strings.Contains(res.Answer.AnswerMarkdown, "Add step button") {
		t.Fatalf("answer = %+v, want the second text answer", res.Answer)
	}
	if doc := draft.current(t); doc.HasID("journey_check") {
		t.Fatal("the draft moved without a draft.apply call")
	}
}

// The follow-up the journey sends when a turn ended without acting is an
// edit ask too: “Please make that change now.” must nudge as well.
func TestRunnerNudgesAPlainMakeThatChangeFollowUp(t *testing.T) {
	model := newFakeModel(t,
		step{text: "What kind of change do you want?"},
		step{toolCalls: []toolCallRequest{editApplyCall()}},
		step{text: "Done."},
	)
	r := newMatrixRunner(t, model, newFakeDraftService(), nil)
	res, f := runAsk(t, r, TrustAskRisky, "Please make that change now.")
	if f != nil {
		t.Fatalf("RunTurn failed: code=%s detail=%s", f.Code, f.Detail)
	}
	if len(res.Changes) != 1 {
		t.Fatalf("changes = %+v, want the follow-up landed one", res.Changes)
	}
}

// Asks the nudge must NEVER touch: reads, the ambiguous “change the
// workflow” ask the question-card flow exists for, an interrogative edit
// ask, and the chat→workflow step-list turn.
func TestRunnerNeverNudgesAsksItShouldNot(t *testing.T) {
	for _, ask := range []string{
		"What steps does the draft have?",
		"change the workflow",
		"Can you add a step named tidy to the draft?",
		"turn this chat into a workflow",
		"Which approval gate should I add to the pipeline?",
	} {
		t.Run(ask, func(t *testing.T) {
			model := newFakeModel(t, step{text: "Here is what I found."})
			r := newMatrixRunner(t, model, newFakeDraftService(), nil)
			if _, f := runAsk(t, r, TrustAskRisky, ask); f != nil {
				t.Fatalf("RunTurn failed: %+v", f)
			}
			if got := model.bodyCount(); got != 1 {
				t.Fatalf("completions = %d, want 1 — the ask was nudged", got)
			}
		})
	}
}

// The nudge does not bypass the trust gate: under ask_all the nudged
// draft.apply is still carded, the draft is untouched, and no change row
// is recorded until the caller confirms.
func TestRunnerNudgeStillGatesUnderAskAll(t *testing.T) {
	model := newFakeModel(t,
		step{text: "I would add journey_check after plan."},
		step{toolCalls: []toolCallRequest{editApplyCall()}},
	)
	draft := newFakeDraftService()
	r := newMatrixRunner(t, model, draft, nil)
	res, f := runAsk(t, r, TrustAskAll, journeyEditAsk)
	if f != nil {
		t.Fatalf("RunTurn failed: %+v", f)
	}
	if res.Approval == nil {
		t.Fatal("ask_all must still gate the nudged draft.apply behind a confirm card")
	}
	if len(res.Changes) != 0 {
		t.Fatalf("the gated nudge recorded changes: %+v", res.Changes)
	}
	if doc := draft.current(t); doc.HasID("journey_check") {
		t.Fatal("the gated nudge wrote the draft")
	}
}

// Mode 2, fixed: the edit lands, the NEXT completion of the same turn
// fails. The turn refuses (nothing is stored) AND the draft comes back to
// the pre-turn state — the retried ask must not meet a leaked mutation
// with no chip to show for it (run 41560172301).
func TestFailedTurnRollsBackAppliedDraftEdits(t *testing.T) {
	model := newFakeModel(t,
		step{toolCalls: []toolCallRequest{editApplyCall()}},
		step{text: ""}, // the post-edit completion carried no answer: the turn fails
	)
	draft := newFakeDraftService()
	r := newMatrixRunner(t, model, draft, nil)
	res, f := runAsk(t, r, TrustNoAsk, journeyEditAsk)
	if f == nil || f.Code != FailBadModelResponse {
		t.Fatalf("failure = %+v, want %s", f, FailBadModelResponse)
	}
	if res != nil {
		t.Fatalf("a failed turn returned a result: %+v", res)
	}
	doc := draft.current(t)
	if doc.HasID("journey_check") {
		t.Fatal("the failed turn left its draft edit applied")
	}
	n, found := doc.Find("check")
	if !found || !contains(n.DependsOn, "plan") || contains(n.DependsOn, "journey_check") {
		t.Fatalf("after rollback, check dependsOn = %v, want the original [plan]", n.DependsOn)
	}
	if draft.replaceCalls != 2 {
		t.Fatalf("replace calls = %d, want 2 (the edit + its rollback)", draft.replaceCalls)
	}
}

// Same promise at the completion cap: twelve rounds after an applied edit
// still end in a refusal — and the edit must not survive the refusal.
func TestCapFailureRollsBackAppliedDraftEdits(t *testing.T) {
	steps := make([]step, 0, MaxRunnerModelCalls)
	steps = append(steps, step{toolCalls: []toolCallRequest{editApplyCall()}})
	for i := 1; i < MaxRunnerModelCalls; i++ {
		steps = append(steps, step{toolCalls: []toolCallRequest{
			toolCall("palette.search", map[string]any{"needle": "runs"}),
		}})
	}
	model := newFakeModel(t, steps...)
	draft := newFakeDraftService()
	r := newMatrixRunner(t, model, draft, nil)
	_, f := runAsk(t, r, TrustNoAsk, journeyEditAsk)
	if f == nil || f.Code != FailCallCap {
		t.Fatalf("failure = %+v, want %s", f, FailCallCap)
	}
	if doc := draft.current(t); doc.HasID("journey_check") {
		t.Fatal("the cap refusal left the applied draft edit in place")
	}
}
