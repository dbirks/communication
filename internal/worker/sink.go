package worker

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/dbirks/communication/internal/domain"
	"github.com/dbirks/communication/internal/events"
)

// turnSink turns one turn's normalized agent stream into journal rows:
//
//   - agent text and thought chunks are coalesced (flushed after IdleFlush
//     ms of stream silence, when any non-chunk event arrives, and at turn
//     end) into readable conversation.message.agent / conversation.thought
//     rows instead of one row per token;
//   - tool calls/updates are written as previews bounded by MaxPreviewBytes,
//     flushing pending text first so the transcript order matches what a
//     human watched;
//   - every write is fenced: an ErrLeaseLost from the store calls onLost
//     once and the sink then refuses further work.
//
// Sink methods are called from two directions — the session dispatcher
// goroutine (emit) and the turn goroutine (note/finish) — so all mutable
// state lives under mu.
type turnSink struct {
	loop   *TurnLoop
	claim  Claim
	log    *slog.Logger
	onLost func()
	// ctx bounds live appends; the finish flush swaps in a detached
	// context so a drained turn can still close its transcript.
	ctx context.Context

	mu         sync.Mutex
	msg        strings.Builder
	thought    strings.Builder
	msgSeq     int
	thoughtSeq int
	flushGen   uint64
	updateSeq  map[string]int
	closed     bool
	lost       bool
}

func (l *TurnLoop) newSink(c Claim, ctx context.Context, onLost func()) *turnSink {
	return &turnSink{
		loop:      l,
		claim:     c,
		log:       l.log,
		onLost:    onLost,
		ctx:       ctx,
		updateSeq: map[string]int{},
	}
}

// emit accepts one normalized event from the session dispatcher. It never
// blocks the dispatcher: everything here is a buffer append or a spawn.
func (s *turnSink) emit(ev domain.ConversationEvent) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed || s.lost {
		return
	}
	switch ev.Kind {
	case "message_chunk":
		s.msg.WriteString(ev.Text)
		if s.msg.Len() >= s.loop.cfg.MaxChunkBytes {
			s.flushMsgLocked(false)
			s.armIdleLocked()
			return
		}
		s.armIdleLocked()
	case "thought_chunk":
		// Order is transcript order: thoughts and messages cannot share a
		// buffer, so a stream switch flushes the other one first.
		s.flushMsgLocked(false)
		s.thought.WriteString(ev.Text)
		if s.thought.Len() >= s.loop.cfg.MaxChunkBytes {
			s.flushThoughtLocked()
			s.armIdleLocked()
			return
		}
		s.armIdleLocked()
	case "tool_call":
		s.flushAllLocked()
		input := s.redact(ev.Input)
		s.appendLocked(TurnEvent{
			Type:      events.TypeConversationToolCall,
			ActorKind: events.ActorKindWorker,
			ActorID:   s.claim.WorkerID,
			Payload: events.ToolCallPayload{
				ConversationID: s.claim.ConversationID,
				TurnID:         s.claim.TurnID,
				ToolCallID:     ev.ToolCallID,
				Title:          bounded(s.redact(ev.Text), 200),
				Kind:           ev.ToolKind,
				Status:         orDefault(ev.ToolStatus, "pending"),
				InputPreview:   bounded(input, s.loop.cfg.MaxPreviewBytes),
				Truncated:      len(input) > s.loop.cfg.MaxPreviewBytes,
			},
		})
	case "tool_call_update":
		s.flushAllLocked()
		n := s.updateSeq[ev.ToolCallID] + 1
		s.updateSeq[ev.ToolCallID] = n
		output := s.redact(ev.Output)
		s.appendLocked(TurnEvent{
			Type:      events.TypeConversationToolUpdate,
			ActorKind: events.ActorKindWorker,
			ActorID:   s.claim.WorkerID,
			Payload: events.ToolUpdatePayload{
				ConversationID: s.claim.ConversationID,
				TurnID:         s.claim.TurnID,
				ToolCallID:     ev.ToolCallID,
				Status:         orDefault(ev.ToolStatus, "in_progress"),
				Title:          bounded(s.redact(ev.Text), 200),
				OutputPreview:  bounded(output, s.loop.cfg.MaxPreviewBytes),
				Truncated:      len(output) > s.loop.cfg.MaxPreviewBytes,
				UpdateSeq:      n,
			},
		})
	default:
		// permission_request is bridged durably by the decider, and plan/
		// unknown kinds have no M2 event type — dropping them is honest;
		// inventing types is not (ADR-0016 §7).
	}
}

// redact applies the live unit's secret-redaction hook to text about to enter
// the journal, and is a pass-through when the unit materialized nothing. The
// hook is a black box owned by the materializer (which alone knows the values):
// this package replaces occurrences it is not told about with a marker without
// ever learning what it replaced (12-test-strategy case 12: an agent that cats
// its own materialized .env must still not put the value in the journal).
//
// Redaction runs at flush time, on the coalesced buffer, so a sentinel split
// across stream chunks is matched on the whole text. A sentinel split across
// two *flushes* (idle boundary in the middle of the value) is the known limit
// of a streaming transcript; the exclusion set and the download path are what
// case 12 asserts against, and neither can carry a file's content.
func (s *turnSink) redact(text string) string {
	if text == "" {
		return text
	}
	u := s.loop.unitFor(s.claim.ConversationID)
	if u == nil || u.Materialized == nil || u.Materialized.Redact == nil {
		return text
	}
	out, n := u.Materialized.Redact(text)
	if n > 0 && s.log != nil {
		// The count, never the value: the log is operator-visible, the journal
		// is browser-visible, and neither gets plaintext.
		s.log.Info("journal text redacted for materialized secrets",
			slog.String("turn_id", s.claim.TurnID), slog.Int("occurrences", n))
	}
	return out
}

// note records a human-readable workspace note (clone failures) as a
// message chunk: the transcript stays the single place a member learns
// what happened, and a failed clone must not be fatal.
func (s *turnSink) note(text string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed || s.lost {
		return
	}
	s.flushMsgLocked(false)
	text = s.redact("workspace: " + text)
	s.appendLocked(TurnEvent{
		Type:      events.TypeConversationMessageAgent,
		ActorKind: events.ActorKindWorker,
		ActorID:   s.claim.WorkerID,
		Payload: events.MessageAgentPayload{
			ConversationID: s.claim.ConversationID,
			TurnID:         s.claim.TurnID,
			ChunkSeq:       s.nextMsgSeq(),
			Text:           bounded(text, s.loop.cfg.MaxChunkBytes),
			Truncated:      false,
		},
	})
}

// finish flushes everything and closes the sink on the caller's (detached)
// context. When completed, the last agent-text chunk carries final=true
// (ADR-0016 §7: "final ends it").
func (s *turnSink) finish(ctx context.Context, completed bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return
	}
	if ctx != nil {
		s.ctx = ctx
	}
	s.flushThoughtLocked()
	s.flushMsgLocked(completed)
	s.closed = true
}

// nextMsgSeq returns the chunk sequence for the next agent message. Caller
// holds mu.
func (s *turnSink) nextMsgSeq() int { s.msgSeq++; return s.msgSeq }

// armIdleLocked schedules one coalescing flush; a newer chunk bumps the
// generation so the older timer becomes a no-op.
func (s *turnSink) armIdleLocked() {
	if s.msg.Len() == 0 && s.thought.Len() == 0 {
		return
	}
	s.flushGen++
	gen := s.flushGen
	clock, idle := s.loop.clock, s.loop.cfg.IdleFlush
	go func() {
		<-clock.After(idle)
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.closed || s.lost || s.flushGen != gen {
			return
		}
		s.flushAllLocked()
	}()
}

func (s *turnSink) flushAllLocked() {
	s.flushThoughtLocked()
	s.flushMsgLocked(false)
}

// flushMsgLocked writes the buffered agent text as ordered, bounded chunks.
func (s *turnSink) flushMsgLocked(final bool) {
	text := s.redact(s.msg.String())
	s.msg.Reset()
	if text == "" {
		return
	}
	max := s.loop.cfg.MaxChunkBytes
	for {
		if len(text) <= max {
			s.appendLocked(TurnEvent{
				Type:      events.TypeConversationMessageAgent,
				ActorKind: events.ActorKindWorker,
				ActorID:   s.claim.WorkerID,
				Payload: events.MessageAgentPayload{
					ConversationID: s.claim.ConversationID,
					TurnID:         s.claim.TurnID,
					ChunkSeq:       s.nextMsgSeq(),
					Text:           text,
					Truncated:      false,
					Final:          final,
				},
			})
			return
		}
		// Split on a rune boundary; a split chunk is by definition a cut.
		cut := max
		for cut > 0 && text[cut]&0xC0 == 0x80 {
			cut--
		}
		chunk, rest := text[:cut], text[cut:]
		s.appendLocked(TurnEvent{
			Type:      events.TypeConversationMessageAgent,
			ActorKind: events.ActorKindWorker,
			ActorID:   s.claim.WorkerID,
			Payload: events.MessageAgentPayload{
				ConversationID: s.claim.ConversationID,
				TurnID:         s.claim.TurnID,
				ChunkSeq:       s.nextMsgSeq(),
				Text:           chunk,
				Truncated:      true,
			},
		})
		text = rest
	}
}

func (s *turnSink) flushThoughtLocked() {
	text := s.redact(s.thought.String())
	s.thought.Reset()
	if text == "" {
		return
	}
	s.thoughtSeq++
	max := s.loop.cfg.MaxChunkBytes
	truncated := false
	if len(text) > max {
		cut := max
		for cut > 0 && text[cut]&0xC0 == 0x80 {
			cut--
		}
		text, truncated = text[:cut], true
	}
	s.appendLocked(TurnEvent{
		Type:      events.TypeConversationThought,
		ActorKind: events.ActorKindWorker,
		ActorID:   s.claim.WorkerID,
		Payload: events.ThoughtPayload{
			ConversationID: s.claim.ConversationID,
			TurnID:         s.claim.TurnID,
			ChunkSeq:       s.thoughtSeq,
			Text:           text,
			Truncated:      truncated,
		},
	})
}

// appendLocked performs the fenced journal write; a lost lease stops the
// sink permanently and notifies the turn once.
func (s *turnSink) appendLocked(ev TurnEvent) {
	if s.lost {
		return
	}
	ctx := s.ctx
	if ctx == nil {
		ctx = context.Background()
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	err := s.loop.store.AppendTurnEvent(ctx, s.claim, ev)
	if errors.Is(err, ErrLeaseLost) {
		s.lost = true
		if s.onLost != nil {
			go s.onLost()
		}
		return
	}
	if err != nil {
		// A journal write that is not a fencing rejection (database down,
		// bad payload) must not silently drop transcript rows the reader
		// will never see: log loudly, keep the turn honest.
		s.log.Error("transcript append failed",
			slog.String("turn_id", s.claim.TurnID),
			slog.String("type", ev.Type),
			slog.String("error", err.Error()))
	}
}

func orDefault(s, def string) string {
	if s == "" {
		return def
	}
	return s
}
