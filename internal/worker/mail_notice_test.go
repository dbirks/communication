package worker_test

// The shape ADR-0072 § 12's transcript line must have. The line exists because
// the stamped `ask` mode is not what a never-asks launch ran, so the journal has
// to say so — but it is the *worker* speaking, and this turn's
// conversation.message.agent chunks are quoted verbatim to the asking chat as
// the answer (ADR-0072 § 7, internal/store/postgres/mail.go trnTurnAnswerText).
// A note journalled as one of those chunks therefore becomes the agent's own
// words on the wire: the UI can hide it, the data is still wrong.

import (
	"strings"
	"testing"

	"github.com/dbirks/communication/internal/events"
	"github.com/dbirks/communication/internal/worker"
)

// TestMailedTurnNoteIsASystemNoticeNotAgentText: the read-only explanation is
// journalled as exactly one conversation.notice row of the mail kind, scoped to
// this conversation and turn, and no agent-message chunk carries it.
func TestMailedTurnNoteIsASystemNoticeNotAgentText(t *testing.T) {
	asked := worker.MailRepoAccess{Asked: true}
	_, _, _, _, appended := runMailedTurn(t, &asked, nil, "pi")

	notices := 0
	for _, ev := range appended {
		p, ok := ev.Payload.(events.NoticePayload)
		if !ok {
			continue
		}
		if ev.Type != events.TypeConversationNotice {
			t.Errorf("conversation.notice payload journalled under type %q", ev.Type)
			continue
		}
		if p.Kind != events.NoticeKindMailReadOnly {
			t.Errorf("notice kind = %q, want %q", p.Kind, events.NoticeKindMailReadOnly)
		}
		if !events.ValidNoticeKind(p.Kind) {
			t.Errorf("notice kind %q is not a legal transcript kind", p.Kind)
		}
		if p.TurnID == "" {
			t.Error("the read-only notice names no turn: a reader cannot tie it to a launch")
		}
		if p.ConversationID == "" {
			t.Error("the read-only notice names no conversation")
		}
		if p.Truncated {
			t.Error("the read-only notice was truncated: the sentence that explains the mount must arrive whole")
		}
		notices++
	}
	if notices != 1 {
		t.Fatalf("journalled %d read-only notices, want exactly 1 (appended types: %d rows)", notices, len(appended))
	}

	// The negative half, which is the bug: the worker's line must not ride an
	// agent chunk, because those chunks ARE the mail answer.
	for _, ev := range appended {
		if ev.Type != events.TypeConversationMessageAgent {
			continue
		}
		if p, ok := ev.Payload.(events.MessageAgentPayload); ok {
			if agentChunkCarriesNote(p.Text) {
				t.Errorf("agent-message chunk carries the worker's note: %q", p.Text)
			}
		}
	}
}

// agentChunkCarriesNote is the note's own vocabulary — wording no agent answer
// in these fixtures produces.
func agentChunkCarriesNote(text string) bool {
	for _, probe := range []string{"mounted read-only", "another chat's mail", "the sandbox is the boundary"} {
		if strings.Contains(text, probe) {
			return true
		}
	}
	return false
}
