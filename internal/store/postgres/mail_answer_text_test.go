package postgres

// ADR-0072 § 7's answer is *the agent's words*: trnTurnAnswerText folds the
// answered turn's conversation.message.agent chunks into conversation_links
// .answer and both conversation.mail.answered rows. The worker also writes
// system lines on that turn — the ADR-0072 § 12 read-only explanation, a
// workspace note — and those are conversation.notice rows, not agent chunks.
// This is the test that keeps them out of the answer at the source: the UI can
// hide a note, the API must not serve one as the agent's answer.

import (
	"strings"
	"testing"

	"github.com/dbirks/communication/internal/events"
	"github.com/dbirks/communication/internal/worker"
)

// mailReadOnlyNote is the § 12 line, quoted from internal/worker/turnloop.go:
// whatever the worker journals as a notice, this test proves does not reach the
// answer.
const mailReadOnlyNote = "this chat is answering another chat's mail: its repository is " +
	"mounted read-only in the sandbox, and it runs without asking because the sandbox is the " +
	"boundary (ADR-0072 § 12). A person's approval lifts the mount to read-write."

func TestMailAnswerExcludesWorkerSystemNotices(t *testing.T) {
	f := cnvSetup(t)
	amRepo(t, f, "web")
	amRepo(t, f, "api")
	amSetEnabled(t, f, true)
	st := amStore(f)

	chatA := amChat(t, f, f.alice, "search chat", "how is search wired?", "web")
	claimA := amClaim(t, f, chatA.ActiveTurn.ID)
	results, err := st.DispatchMail(f.ctx(), claimA, []worker.MailAsk{{Repo: "api", Question: "where is search wired?"}})
	if err != nil || results[0].State != events.MailStateAsked {
		t.Fatalf("DispatchMail: %+v err=%v", results, err)
	}
	linkID := results[0].LinkID
	var toConv, targetTurn string
	f.queryRow(t, `
		SELECT l.to_conversation_id::text, t.id::text
		FROM conversation_links l
		JOIN conversation_turns t ON t.mail_link_id = l.id
		WHERE l.id = $1::uuid`, linkID).into(t, &toConv, &targetTurn)
	if err := st.FinishTurn(f.ctx(), claimA, worker.TurnOutcome{Status: events.TurnStatusCompleted, StopReason: "end_turn"}); err != nil {
		t.Fatalf("FinishTurn asking: %v", err)
	}

	// The answering turn, exactly as the sink writes it: the system notice
	// first (notes are journalled before the stream starts), then the agent's
	// own chunks.
	claimT := amClaim(t, f, targetTurn)
	if err := st.AppendTurnEvent(f.ctx(), claimT, worker.TurnEvent{
		Type: events.TypeConversationNotice, ActorKind: events.ActorKindWorker, ActorID: f.worker,
		Payload: events.NoticePayload{ConversationID: toConv, TurnID: targetTurn, Kind: events.NoticeKindWorkspace, Text: "workspace: clone of web failed: boom"},
	}); err != nil {
		t.Fatalf("AppendTurnEvent notice: %v", err)
	}
	if err := st.AppendTurnEvent(f.ctx(), claimT, worker.TurnEvent{
		Type: events.TypeConversationNotice, ActorKind: events.ActorKindWorker, ActorID: f.worker,
		Payload: events.NoticePayload{ConversationID: toConv, TurnID: targetTurn, Kind: events.NoticeKindMailReadOnly, Text: mailReadOnlyNote},
	}); err != nil {
		t.Fatalf("AppendTurnEvent read-only notice: %v", err)
	}
	const answer = "handlers/search.go wires the endpoint."
	for i, chunk := range []string{"handlers/search.go ", "wires the endpoint."} {
		if err := st.AppendTurnEvent(f.ctx(), claimT, worker.TurnEvent{
			Type: events.TypeConversationMessageAgent, ActorKind: events.ActorKindWorker, ActorID: f.worker,
			Payload: events.MessageAgentPayload{ConversationID: toConv, TurnID: targetTurn, ChunkSeq: i + 1, Text: chunk, Final: i == 1},
		}); err != nil {
			t.Fatalf("AppendTurnEvent: %v", err)
		}
	}
	if err := st.FinishTurn(f.ctx(), claimT, worker.TurnOutcome{Status: events.TurnStatusCompleted, StopReason: "end_turn"}); err != nil {
		t.Fatalf("FinishTurn target: %v", err)
	}

	// The link's answer is the agent's words and nothing else.
	state, linkAnswer, reason := amLinkState(t, f, linkID)
	if state != events.MailStateAnswered || reason != "" {
		t.Fatalf("link after answer: state=%q reason=%q", state, reason)
	}
	if linkAnswer != answer {
		t.Errorf("link answer = %q, want exactly the agent's words %q", linkAnswer, answer)
	}

	// Both conversation.mail.answered payloads carry the same clean answer, and
	// the asking chat's follow-up prompt too.
	for _, conv := range []string{chatA.ID, toConv} {
		var payload string
		f.queryRow(t, `
			SELECT payload::text FROM domain_events
			WHERE conversation_id = $1::uuid AND type = $2`,
			conv, events.TypeConversationMailAnswered).into(t, &payload)
		if payload == "" {
			t.Fatalf("conversation %s has no mail.answered row", conv)
		}
		if !strings.Contains(payload, answer) {
			t.Errorf("conversation %s mail.answered payload lost the answer: %s", conv, payload)
		}
		for _, probe := range []string{"mounted read-only", "the sandbox is the boundary", "clone of web failed"} {
			if strings.Contains(payload, probe) {
				t.Errorf("conversation %s mail.answered payload carries the worker's system notice (%s): %s", conv, probe, payload)
			}
		}
	}
	var followup string
	f.queryRow(t, `
		SELECT prompt FROM conversation_turns
		WHERE conversation_id = $1::uuid AND status = 'queued' AND id <> $2`,
		chatA.ID, chatA.ActiveTurn.ID).into(t, &followup)
	if followup == "" {
		t.Fatal("the asking chat got no follow-up turn")
	}
	if !strings.Contains(followup, answer) {
		t.Errorf("asking chat follow-up = %q, want it to deliver the answer", followup)
	}
	for _, probe := range []string{"mounted read-only", "clone of web failed"} {
		if strings.Contains(followup, probe) {
			t.Errorf("asking chat follow-up carries the worker's system notice (%s): %q", probe, followup)
		}
	}

	// The notices are still there for the asked chat's own transcript — the
	// § 12 promise is that the line is readable *in that chat*, it just is not
	// part of the answer.
	if n := amEventCount(t, f, toConv, events.TypeConversationNotice); n != 2 {
		t.Errorf("asked chat conversation.notice rows = %d, want 2 (the note must stay in its own transcript)", n)
	}
}
