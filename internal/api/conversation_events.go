package api

import (
	"errors"
	"net/http"
	"time"
)

// The conversation transcript stream (ADR-0016, ADR-0014 §5/§9).
//
// It is the project stream's shape over a narrower scope, and it is a separate
// file rather than a fork of the project handler because the one thing that
// must not be duplicated is the *gap argument*: the rows come from the same
// domain_events journal, the cursor is the same global_seq, and the store read
// behind it keeps the tx_id snapshot filter (see
// internal/store/postgres/events.go). What the conversation adds is that
// authorization resolves through the conversation's *project*, on connect,
// before every delivery and on every heartbeat.

// registerConversationEvents mounts GET /api/v1/conversations/{conversationId}/events.
// Timing is explicit so a test can run on a millisecond scale; production goes
// through RegisterConversations, which passes evtProductionTiming().
func registerConversationEvents(s *Server, h *cnvHandlers, stream ConversationEventStream, timing evtTiming) {
	if timing.heartbeat <= 0 {
		timing.heartbeat = evtProductionTiming().heartbeat
	}
	if timing.poll <= 0 {
		timing.poll = evtProductionTiming().poll
	}
	if timing.batch <= 0 {
		timing.batch = evtProductionTiming().batch
	}
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h.handleConversationStream(w, r, stream, timing)
	})
	s.HandleAuthed("GET /api/v1/conversations/{conversationId}/events", handler)
}

// handleConversationStream serves one SSE connection: connect-time
// authorization, replay from the resume cursor, the live tail, and a heartbeat
// that is also an authorization check.
func (h *cnvHandlers) handleConversationStream(w http.ResponseWriter, r *http.Request, stream ConversationEventStream, timing evtTiming) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	conversationID := r.PathValue("conversationId")

	after, ok := evtResumeCursor(w, r)
	if !ok {
		return
	}

	// Nothing is written before the caller is known to be a member of the
	// conversation's project: a non-member gets the same 404 (plus audit row)
	// every other conversation route gives, not an open stream.
	if _, err := h.store.AuthorizeConversation(r.Context(), c, conversationID); err != nil {
		h.fail(w, r, c, cnvAtConversation("conversation.stream", conversationID), err)
		return
	}

	flusher := http.NewResponseController(w)

	ctx := r.Context()
	wake, stopWatch, err := stream.Watch(ctx)
	if err != nil {
		h.serverError(w, r, cnvAtConversation("conversation.stream", conversationID), err)
		return
	}
	defer stopWatch()

	evtStreamHeaders(w)
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	log := h.log(r)
	log.InfoContext(ctx, "conversation stream opened",
		"conversation_id", conversationID, "after", after, "user_id", c.UserID)

	heartbeat := time.NewTicker(timing.heartbeat)
	defer heartbeat.Stop()
	poll := time.NewTicker(timing.poll)
	defer poll.Stop()

	cursor := after
	for {
		for {
			// The read is authorized too (it resolves the conversation's project
			// in SQL), so a caller removed mid-stream stops here even if the
			// separate check below happens to fall between frames.
			batch, err := stream.ConversationEventsAfter(ctx, c, conversationID, cursor, timing.batch)
			if err != nil {
				if errors.Is(err, ErrConversationNotFound) {
					log.WarnContext(ctx, "conversation stream closed: access lost",
						"conversation_id", conversationID, "user_id", c.UserID)
					return
				}
				log.ErrorContext(ctx, "conversation stream read failed",
					"conversation_id", conversationID, "request_id", RequestIDFrom(r), "error", err.Error())
				return
			}
			if len(batch) == 0 {
				break
			}
			// Delivering proves the caller may still see the conversation; ask on
			// the delivery path so a revoked member stops at once (06 edge case).
			if _, err := h.store.AuthorizeConversation(ctx, c, conversationID); err != nil {
				log.WarnContext(ctx, "conversation stream closed: authorization lost",
					"conversation_id", conversationID, "user_id", c.UserID, "error", err.Error())
				return
			}
			for _, env := range batch {
				if err := evtWriteEvent(w, env); err != nil {
					log.DebugContext(ctx, "conversation stream write failed (client gone?)",
						"conversation_id", conversationID, "error", err.Error())
					return
				}
				cursor = env.GlobalSeq
				_ = flusher.Flush()
			}
			if len(batch) < timing.batch {
				break
			}
		}

		select {
		case <-ctx.Done():
			return
		case _, open := <-wake:
			if !open {
				// Wake-up source retired (this replica is shutting down): end so
				// the process can drain, and let the browser resume elsewhere.
				return
			}
		case <-poll.C:
			// A wake-up is an optimization; the poll bounds a lost notification's
			// cost and advances the reader's snapshot past a withheld row
			// (ADR-0014 §9).
		case <-heartbeat.C:
			if _, err := h.store.AuthorizeConversation(ctx, c, conversationID); err != nil {
				log.WarnContext(ctx, "conversation stream closed: authorization lost",
					"conversation_id", conversationID, "user_id", c.UserID, "error", err.Error())
				return
			}
			if err := evtWriteComment(w, flusher, "heartbeat"); err != nil {
				return
			}
		}
	}
}
