package worker_test

import (
	"context"
	"strings"
	"testing"

	"github.com/dbirks/communication/internal/domain"
	"github.com/dbirks/communication/internal/events"
	"github.com/dbirks/communication/internal/worker"
)

// piCfg is fastCfg with the prompting-mode table extended to launcher pi:
// the fake harness verifies one prompting mode, "default", for the launcher
// under test, so a deny/ask claim on pi does not fail on mode resolution.
func piCfg() worker.TurnConfig {
	cfg := fastCfg()
	cfg.AskModeID = func(id string) string {
		if id == "claude" || id == "pi" {
			return "default"
		}
		return ""
	}
	return cfg
}

// The retry series the launcher streams, in the lab's own spelling
// (e900d34): one whole status line per agent message chunk.
var piRetrySeries = []string{
	"Retrying (attempt 1/3, waiting 2s)…",
	"Retrying (attempt 2/3, waiting 4s)…",
	"Retrying (attempt 3/3, waiting 8s)…",
	"Retry finished, resuming.",
}

// TestPiRetryStatusRidesANoticeNotAgentText proves the sink routes the whole
// retry series to conversation.notice (kind agent_retry) and never lets it
// ride a conversation.message.agent row — the rows every "what the agent
// said" consumer quotes: the transcript answer, the thread-list preview and
// the mail answer (ADR-0072 § 7). A completed turn whose only stream was the
// series ends with the honest no_reply line, not a blank turn.
func TestPiRetryStatusRidesANoticeNotAgentText(t *testing.T) {
	st := newFakeStore()
	claim := testClaim()
	claim.PermissionMode = "deny"
	claim.LauncherID = "pi"
	st.claims = []worker.Claim{claim}

	sess := newFakeSession(domain.SessionInfo{ACPSessionID: "acp-1", Origin: "new", LauncherID: "pi"})
	// The fake session's prompt is the seam that owns the stream: the status
	// lines are sent from it so they land on the live sink route, exactly as
	// the dispatcher delivers them.
	sess.promptFn = func(_ context.Context, s *fakeSession) (domain.StopReason, error) {
		for _, line := range piRetrySeries {
			s.send(domain.ConversationEvent{Kind: "message_chunk", Text: line})
		}
		return domain.StopEndTurn, nil
	}
	ff := &fakeFactory{sessions: []*fakeSession{sess}}
	l := newLoop(t, piCfg(), st, ff)
	startLoop(t, l)
	out := recv(t, st.finishing, "the turn's terminal outcome")

	if out.Status != events.TurnStatusCompleted || out.StopReason != "end_turn" {
		t.Fatalf("outcome = %+v, want completed/end_turn: the retry series must not fail the turn", out)
	}

	var notices, noReply []events.NoticePayload
	agentRows := 0
	for _, ev := range st.snapshotAppends() {
		switch p := ev.Payload.(type) {
		case events.MessageAgentPayload:
			agentRows++
			if line := retrySeriesWord(p.Text); line != "" {
				t.Fatalf("agent-message row %d carries retry status text: %q — that is the defect", agentRows, p.Text)
			}
		case events.NoticePayload:
			switch p.Kind {
			case events.NoticeKindAgentRetry:
				notices = append(notices, p)
			case events.NoticeKindNoReply:
				noReply = append(noReply, p)
			default:
				t.Errorf("unexpected notice kind %q in a retry-only turn: %+v", p.Kind, p)
			}
		}
	}
	if agentRows != 0 {
		t.Fatalf("journalled %d agent-message rows for a retry-only turn; want 0 (the series is harness noise)", agentRows)
	}
	if len(notices) != len(piRetrySeries) {
		t.Fatalf("journalled %d agent_retry notices, want %d (one per status line)", len(notices), len(piRetrySeries))
	}
	for i, n := range notices {
		if n.Text != piRetrySeries[i] {
			t.Errorf("agent_retry notice %d text = %q, want the worker line %q", i, n.Text, piRetrySeries[i])
		}
		if n.TurnID == "" || n.ConversationID == "" {
			t.Errorf("agent_retry notice %d misses its scope: %+v", i, n)
		}
	}
	if len(noReply) != 1 {
		t.Fatalf("journalled %d no_reply notices, want exactly 1 (the turn ended with no answer)", len(noReply))
	}
	if got := noReply[0].Text; !strings.Contains(got, "didn't reply") {
		t.Errorf("no_reply line = %q, want the honest 'the agent didn't reply' word", got)
	}
	if !events.ValidNoticeKind(events.NoticeKindAgentRetry) || !events.ValidNoticeKind(events.NoticeKindNoReply) {
		t.Error("the new notice kinds are not legal transcript kinds")
	}
}

// TestPiRetrySeriesLeavesTheRealAnswerIntact: the launcher's retry status
// lines stream BEFORE the model resumes and answers ("Retry finished,
// resuming." is the line that means the model is about to speak). Every
// status line is routed out of the words, and the real answer that follows is
// untouched — exactly what the agent said, still final, still whole.
func TestPiRetrySeriesLeavesTheRealAnswerIntact(t *testing.T) {
	st := newFakeStore()
	claim := testClaim()
	claim.PermissionMode = "deny"
	claim.LauncherID = "pi"
	st.claims = []worker.Claim{claim}

	sess := newFakeSession(domain.SessionInfo{ACPSessionID: "acp-1", Origin: "new", LauncherID: "pi"})
	sess.promptFn = func(_ context.Context, s *fakeSession) (domain.StopReason, error) {
		for _, line := range piRetrySeries {
			s.send(domain.ConversationEvent{Kind: "message_chunk", Text: line})
		}
		s.send(domain.ConversationEvent{Kind: "message_chunk", Text: "Reply: OK"})
		return domain.StopEndTurn, nil
	}
	ff := &fakeFactory{sessions: []*fakeSession{sess}}
	l := newLoop(t, piCfg(), st, ff)
	startLoop(t, l)
	out := recv(t, st.finishing, "the turn's terminal outcome")
	if out.Status != events.TurnStatusCompleted {
		t.Fatalf("outcome = %+v, want completed", out)
	}

	var notices []events.NoticePayload
	var msgs []events.MessageAgentPayload
	for _, ev := range st.snapshotAppends() {
		switch p := ev.Payload.(type) {
		case events.NoticePayload:
			if p.Kind == events.NoticeKindAgentRetry {
				notices = append(notices, p)
			} else if p.Kind == events.NoticeKindNoReply {
				t.Fatalf("no_reply notice on a turn that answered %q: the answer is there", p.Text)
			}
		case events.MessageAgentPayload:
			msgs = append(msgs, p)
		}
	}
	if len(notices) != len(piRetrySeries) {
		t.Fatalf("journalled %d agent_retry notices, want %d (every status line, including the resume line)", len(notices), len(piRetrySeries))
	}
	if len(msgs) != 1 {
		t.Fatalf("journalled %d agent-message rows, want exactly 1: %v", len(msgs), msgs)
	}
	if msgs[0].Text != "Reply: OK" || !msgs[0].Final {
		t.Errorf("answer row = %+v, want the untouched 'Reply: OK' marked final", msgs[0])
	}
}

// retrySeriesWord names the vocabulary of the lab's series for the negative
// assertion: no agent row may carry any of it.
func retrySeriesWord(text string) string {
	for _, probe := range []string{"Retrying (attempt", "Retry finished, resuming"} {
		if strings.Contains(text, probe) {
			return probe
		}
	}
	return ""
}
