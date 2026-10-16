package worker

import (
	"context"
	"time"
)

// attemptTranscript wires M2's turn sink over one attempt's fence, so an
// agent.acp attempt journals its conversation exactly as a chat turn does —
// docs/m4-contract.md § 4 step 6: "transcript coalescing rules unchanged from
// M2".
//
// Before this the attempt path read sess.Events() only to coalesce the final
// answer for structured-output extraction (agentText) and dropped every other
// update: the attempt's conversation held one conversation.turn.completed row
// and no transcript at all, so neither the conversation page nor the run
// inspector's attempt pane could show what the agent said or which tools it
// called (observed in the M4 lab, run 01a143ee /plan attempt 1). The
// conversation-turn seam is the same journal the M2 path writes, scoped by
// conversation_id (api/openapi.yaml's conversation-events route: "the
// transcript *is* the journal"), so the fix is to write the same rows here —
// not a second transcript store, and not an artifact.
//
// The append rides AttemptSink, which means:
//
//   - it is fenced on the attempt's own triple (attemptloop.go's attemptSink):
//     a stale writer stops by ErrLeaseLost instead of appending, and the loop —
//     not the sink — still owns the terminal write;
//   - the store stamps run_id/node_execution_id/attempt_id (contract § 3's
//     correlation rule) and, for these types, the attempt's conversation_id
//     (run_journal.go's attemptConversationTx reads it from the attempt row, so
//     an executor cannot name a conversation the claim did not stamp);
//   - redaction is already applied: executeAttempt rebinds `sink` to
//     redactingAttemptSink at step 4, before this sink is built, so the
//     materializer's black box covers these payloads exactly as it covers every
//     other attempt row. A second hook here would redact twice, so this writer
//     deliberately carries none.
func (a *AgentTurn) attemptTranscript(ctx context.Context, c AttemptClaim, conv AttemptConversation, sink AttemptSink) *turnSink {
	return &turnSink{
		w: sinkWriter{
			cfg:   a.transcriptCfg(),
			clock: a.sinkClock(),
			write: func(ctx context.Context, ev TurnEvent) error {
				return sink.AppendEvent(ctx, AttemptEvent{
					Type: ev.Type, ActorKind: ev.ActorKind, ActorID: ev.ActorID, Payload: ev.Payload,
				})
			},
		},
		claim: Claim{
			ConversationID: conv.ConversationID,
			TurnID:         conv.TurnID,
			WorkerID:       c.WorkerID,
		},
		log: a.logger(),
		// The attempt's own context bounds a live append: a cancelled
		// attempt stops streaming into the journal, and closeTranscript
		// detaches only the final flush.
		ctx:       ctx,
		updateSeq: map[string]int{},
	}
}

// transcriptCfg is the M2 cadence: the same chunk and preview bounds, so an
// attempt's transcript rows are bounded exactly like a conversation's.
func (a *AgentTurn) transcriptCfg() TurnConfig {
	return a.Transcript.normalise()
}

func (a *AgentTurn) sinkClock() Clock {
	if a.Clock != nil {
		return a.Clock
	}
	return realClock{}
}

// closeTranscript flushes whatever the stream left buffered and marks the last
// agent chunk final. It runs on a detached, bounded context because a
// cancelled attempt still owes its transcript the lines it actually streamed —
// the same reason the session teardown below detaches (runner.go's finish path
// is the precedent).
func (a *AgentTurn) closeTranscript(base context.Context, sink *turnSink, completed bool) {
	if sink == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(base), agentJournalTimeout)
	defer cancel()
	sink.finish(ctx, completed)
}

// agentJournalTimeout bounds one detached transcript flush; it matches the
// session-teardown append's budget in executeAttempt.
const agentJournalTimeout = 10 * time.Second
