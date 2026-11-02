package worker_test

// An `ask` prompt on a chat nobody is driving (ADR-0072 § 2: a mailed chat is
// born with controller `none`) has no possible answer — the answer route is
// controller-only (ADR-0016 § 5). Parking it for the whole PermissionTTL
// anyway is what the design-3d leg looked like: a turn "started — a worker has
// the turn" for minutes, twice, before the asked agent finally answered a
// one-sentence question. The refusal IS the answer the design wants
// ("Nobody answers = the prompt expires = refusal"); saying it now, with the
// rule named, is what stops the chat looking wedged.
//
// The counterpart — a prompt with a controller who does not answer — stays
// covered by TestPermissionBridge's "deadline" leg: it waits, and the deadline
// closes it as `expired`.

import (
	"context"
	"testing"
	"time"

	"github.com/dbirks/communication/internal/domain"
	"github.com/dbirks/communication/internal/events"
	"github.com/dbirks/communication/internal/worker"
)

func TestAskPromptWithoutAControllerIsRefusedAtOnce(t *testing.T) {
	st := newFakeStore()
	st.claims = []worker.Claim{testClaim2(t, "ask")}
	st.controller = "" // control is held by none: nobody can answer this
	cfg := fastCfg()
	cfg.PermissionTTL = time.Hour // no test may pass by waiting two minutes
	sess := newFakeSession(domain.SessionInfo{})
	result := make(chan domain.PermissionChoice, 1)
	sess.promptFn = func(ctx context.Context, s *fakeSession) (domain.StopReason, error) {
		wait := make(chan struct{})
		go func() {
			defer close(wait)
			choice, _ := s.decider(ctx, domain.PermissionPrompt{
				ToolCallID: "tc-mail", Title: "git ls-files", Kind: "execute",
				Options: []domain.PermissionOption{
					{OptionID: "allow-once", Label: "Yes", Kind: "allow_once"},
					{OptionID: "reject", Label: "No", Kind: "reject_once"},
				},
			})
			result <- choice
		}()
		<-wait
		return domain.StopEndTurn, nil
	}
	ff := &fakeFactory{sessions: []*fakeSession{sess}}
	startLoop(t, newLoop(t, cfg, st, ff))
	recv(t, st.begun, "begin")

	open := recv(t, st.permOpens, "the prompt is visible before it is refused")
	if open.Title != "git ls-files" {
		t.Fatalf("permission open = %+v", open)
	}
	closed := recv(t, st.permClosed, "immediate refusal, not a two-minute wait")
	if closed.status != events.PermissionStatusDecided {
		t.Fatalf("closed as %q, want decided: the refusal is a real verdict", closed.status)
	}
	if closed.optionID != "reject" {
		t.Fatalf("option = %q, want the harness's reject_once option", closed.optionID)
	}
	if closed.policy != "ask_without_controller" {
		t.Fatalf("policy = %q, want the row to name the rule that refused", closed.policy)
	}
	if got := recv(t, result, "decider return"); got.OptionID != "reject" {
		t.Fatalf("choice = %+v, want the refusal handed back to the agent", got)
	}
	recv(t, st.finishing, "finish")
	if n := st.stateCalls(); n != 0 {
		t.Errorf("PermissionState polled %d times: an unanswerable prompt must never enter the wait loop", n)
	}
}

// A prompt the harness gives nothing to refuse with is still not allowed to
// hold the turn: it closes `cancelled` — the same honest "nobody said yes" the
// policy path already uses — rather than sitting out the TTL.
func TestAskPromptWithoutAControllerClosesWhenNoRejectOption(t *testing.T) {
	st := newFakeStore()
	st.claims = []worker.Claim{testClaim2(t, "ask")}
	st.controller = ""
	cfg := fastCfg()
	cfg.PermissionTTL = time.Hour
	sess := newFakeSession(domain.SessionInfo{})
	result := make(chan domain.PermissionChoice, 1)
	sess.promptFn = func(ctx context.Context, s *fakeSession) (domain.StopReason, error) {
		wait := make(chan struct{})
		go func() {
			defer close(wait)
			choice, _ := s.decider(ctx, domain.PermissionPrompt{
				ToolCallID: "tc-noreject", Title: "read a file",
				Options: []domain.PermissionOption{{OptionID: "allow-once", Kind: "allow_once"}},
			})
			result <- choice
		}()
		<-wait
		return domain.StopEndTurn, nil
	}
	ff := &fakeFactory{sessions: []*fakeSession{sess}}
	startLoop(t, newLoop(t, cfg, st, ff))
	recv(t, st.begun, "begin")

	closed := recv(t, st.permClosed, "the unanswerable prompt is closed")
	if closed.status != events.PermissionStatusCancelled {
		t.Fatalf("closed as %q, want cancelled (no option to fabricate)", closed.status)
	}
	if closed.optionID != "" {
		t.Fatalf("option = %q, want none", closed.optionID)
	}
	if got := recv(t, result, "decider return"); got.OptionID != "" {
		t.Fatalf("choice = %+v, want the empty answer: nobody said yes", got)
	}
	recv(t, st.finishing, "finish")
}
