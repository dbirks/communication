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
//   - worker-authored system lines go out as conversation.notice rows
//     (sink.notice), never as agent message chunks;
//   - tool calls/updates are written as previews bounded by MaxPreviewBytes,
//     flushing pending text first so the transcript order matches what a
//     human watched;
//   - every write is fenced: an ErrLeaseLost from the store calls onLost
//     once and the sink then refuses further work.
//
// Sink methods are called from two directions — the session dispatcher
// goroutine (emit) and the turn goroutine (notice/finish) — so all mutable
// state lives under mu.
type turnSink struct {
	w      sinkWriter
	claim  Claim
	log    *slog.Logger
	onLost func()
	// ctx bounds live appends; the finish flush swaps in a detached
	// context so a drained turn can still close its transcript.
	ctx context.Context

	mu      sync.Mutex
	msg     strings.Builder
	thought strings.Builder
	// full keeps the whole agent message text (bounded by MailScanCap) for
	// the end-of-turn agent-mail command scan (ADR-0072): the coalesced
	// journal chunks are what a human reads, but a mail command can straddle
	// a chunk boundary, so the scan needs the unsplit text.
	full       strings.Builder
	msgSeq     int
	thoughtSeq int
	flushGen   uint64
	updateSeq  map[string]int
	closed     bool
	lost       bool
}

// sinkWriter is the journal surface a turnSink writes through: the cadence it
// coalesces on, the clock its idle flush arms with, and the one fenced append.
// It exists so the M2 loop and an M4 agent.acp attempt share ONE transcript
// mechanism rather than two that drift: the coalescing, chunk bounds, preview
// bounds and redaction hook here are exactly the M2 behaviour that
// docs/m4-contract.md § 4 step 6 says an attempt keeps "unchanged from M2".
type sinkWriter struct {
	cfg   TurnConfig
	clock Clock
	// write performs the fenced append; ErrLeaseLost must come back verbatim
	// so the sink can stop writing and name the lost lease once.
	write func(ctx context.Context, ev TurnEvent) error
	// redact is the live materialized-secret hook, resolved at flush time
	// because the unit that owns the values may not exist when the sink is
	// built. nil is a pass-through.
	redact func(text string) (string, int)
}

func (l *TurnLoop) newSink(c Claim, ctx context.Context, onLost func()) *turnSink {
	return &turnSink{
		w: sinkWriter{
			cfg:    l.cfg,
			clock:  l.clock,
			write:  func(ctx context.Context, ev TurnEvent) error { return l.store.AppendTurnEvent(ctx, c, ev) },
			redact: l.unitRedact(c.ConversationID),
		},
		claim:     c,
		log:       l.log,
		onLost:    onLost,
		ctx:       ctx,
		updateSeq: map[string]int{},
	}
}

// unitRedact resolves the live unit's materialized-secret redactor once per
// flush: a turn's unit is created after its sink is, so the lookup has to be
// lazy (turnSink.redact documents why the hook is a black box).
func (l *TurnLoop) unitRedact(conversationID string) func(string) (string, int) {
	return func(text string) (string, int) {
		u := l.unitFor(conversationID)
		if u == nil || u.Materialized == nil || u.Materialized.Redact == nil {
			return text, 0
		}
		return u.Materialized.Redact(text)
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
		// The launcher's own transport retry status arrives as agent message
		// chunks (pi-acp streams "Retrying (attempt n/m, waiting xs)…"). It is
		// harness noise, not the agent's answer: route the whole status line
		// to a conversation.notice (kind agent_retry) so it never reaches the
		// answer, the thread-list preview or the mail, which all quote this
		// turn's conversation.message.agent rows (round-6 review defect).
		if line := retryStatusLine(ev.Text); line != "" {
			s.flushMsgLocked(false)
			s.retryNoticeLocked(line)
			return
		}
		s.msg.WriteString(ev.Text)
		if s.full.Len() < MailScanCap {
			s.full.WriteString(ev.Text)
		}
		if s.msg.Len() >= s.w.cfg.MaxChunkBytes {
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
		if s.thought.Len() >= s.w.cfg.MaxChunkBytes {
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
				InputPreview:   bounded(input, s.w.cfg.MaxPreviewBytes),
				Truncated:      len(input) > s.w.cfg.MaxPreviewBytes,
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
				OutputPreview:  bounded(output, s.w.cfg.MaxPreviewBytes),
				Truncated:      len(output) > s.w.cfg.MaxPreviewBytes,
				UpdateSeq:      n,
			},
		})
	default:
		// permission_request is bridged durably by the decider, and plan/
		// unknown kinds have no M2 event type — dropping them is honest;
		// inventing types is not (ADR-0016 §7).
	}
}

// fullText returns the whole coalesced agent message text this sink
// captured (bounded by MailScanCap), for the end-of-turn agent-mail scan
// (ADR-0072). Safe from any goroutine; after finish() it reflects the
// complete answer.
func (s *turnSink) fullText() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.full.String()
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
	if text == "" || s.w.redact == nil {
		return text
	}
	out, n := s.w.redact(text)
	if n > 0 && s.log != nil {
		// The count, never the value: the log is operator-visible, the journal
		// is browser-visible, and neither gets plaintext.
		s.log.Info("journal text redacted for materialized secrets",
			slog.String("turn_id", s.claim.TurnID), slog.Int("occurrences", n))
	}
	return out
}

// notice records one worker-authored system line (a workspace note, the
// ADR-0072 § 12 read-only explanation) as a conversation.notice row: the
// transcript stays the single place a member learns what happened, and a
// failed clone must not be fatal — but the line is not the agent's answer.
// Mail quotes the turn's conversation.message.agent chunks back to the asking
// chat (ADR-0072 § 7), so a note journalled as one of those chunks would be
// served to another chat as the agent's own words.
func (s *turnSink) notice(kind, text string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed || s.lost {
		return
	}
	s.flushMsgLocked(false)
	text = s.redact(text)
	s.appendLocked(TurnEvent{
		Type:      events.TypeConversationNotice,
		ActorKind: events.ActorKindWorker,
		ActorID:   s.claim.WorkerID,
		Payload: events.NoticePayload{
			ConversationID: s.claim.ConversationID,
			TurnID:         s.claim.TurnID,
			Kind:           kind,
			Text:           bounded(text, s.w.cfg.MaxChunkBytes),
			Truncated:      len(text) > s.w.cfg.MaxChunkBytes,
		},
	})
}

// retryNoticeLocked journals one launcher retry status line as a
// conversation.notice row (kind agent_retry) instead of agent message text.
// Caller holds mu; the plain notice() helper would deadlock on it.
func (s *turnSink) retryNoticeLocked(line string) {
	s.appendLocked(TurnEvent{
		Type:      events.TypeConversationNotice,
		ActorKind: events.ActorKindWorker,
		ActorID:   s.claim.WorkerID,
		Payload: events.NoticePayload{
			ConversationID: s.claim.ConversationID,
			TurnID:         s.claim.TurnID,
			Kind:           events.NoticeKindAgentRetry,
			Text:           s.redact(line),
		},
	})
}

// finish flushes everything and closes the sink on the caller's (detached)
// context. When completed, the last agent-text chunk carries final=true
// (ADR-0016 §7: "final ends it"). A completed turn that never said a word —
// its whole stream was the launcher's retry status, routed to notices — ends
// with an honest line instead of a blank: the transcript says so, and the
// mail resolution (which reads this journal for the answer) settles failed
// rather than "answered" with nothing.
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
	if completed && s.full.Len() == 0 {
		s.appendLocked(TurnEvent{
			Type:      events.TypeConversationNotice,
			ActorKind: events.ActorKindWorker,
			ActorID:   s.claim.WorkerID,
			Payload: events.NoticePayload{
				ConversationID: s.claim.ConversationID,
				TurnID:         s.claim.TurnID,
				Kind:           events.NoticeKindNoReply,
				Text:           "The agent didn't reply.",
			},
		})
	}
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
	clock, idle := s.w.clock, s.w.cfg.IdleFlush
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
	max := s.w.cfg.MaxChunkBytes
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
	max := s.w.cfg.MaxChunkBytes
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
	err := s.w.write(ctx, ev)
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
