package api

import (
	"context"
	"net/http"
	"time"

	"github.com/dbirks/communication/internal/events"
)

// OrgEventStream is everything the org-level SSE handler (GET /api/v1/events,
// ADR-0048) needs from the durable journal: the same rows the project stream
// serves, selected across every project the caller may see in one query.
//
// The wake-up channel is a hint only, exactly as on the project stream: the
// handler always re-queries by sequence, so a lost, duplicated or never-sent
// notification cannot make the stream wrong (ADR-0014 §6). The visibility
// predicate lives in the store (internal/store/postgres, ADR-0048 §4): rows
// from projects the caller cannot see are simply absent from a batch, and
// because the cursor only advances on delivered rows, membership that changes
// mid-stream is re-evaluated on the very next query.
type OrgEventStream interface {
	// OrgEventsAfter returns up to limit envelopes for every project the
	// caller may see with global_seq strictly greater than afterSeq, oldest
	// first.
	OrgEventsAfter(ctx context.Context, c Caller, afterSeq int64, limit int) ([]events.Envelope, error)

	// Watch returns a channel signalled whenever the journal may have gained
	// rows, plus a function that ends the subscription. A closed channel
	// means the wake-up source is gone (replica shutting down) and the stream
	// must stop; a nil channel means "poll only".
	Watch(ctx context.Context) (<-chan struct{}, func(), error)
}

// RegisterOrgEvents mounts GET /api/v1/events (ADR-0048): the same envelope,
// heartbeat, resume and backpressure behaviour as the project stream,
// multiplexed across the caller's projects.
func RegisterOrgEvents(s *Server, stream OrgEventStream) {
	registerOrgEvents(s, stream, evtProductionTiming())
}

// registerOrgEvents is RegisterOrgEvents with the timing made explicit;
// production always goes through RegisterOrgEvents.
func registerOrgEvents(s *Server, stream OrgEventStream, timing evtTiming) {
	if timing.heartbeat <= 0 {
		timing.heartbeat = evtProductionTiming().heartbeat
	}
	if timing.poll <= 0 {
		timing.poll = evtProductionTiming().poll
	}
	if timing.batch <= 0 {
		timing.batch = evtProductionTiming().batch
	}
	h := &orgEvtHandlers{journal: stream, srv: s, timing: timing}
	s.HandleAuthed("GET /api/v1/events", http.HandlerFunc(h.handleStream))
}

type orgEvtHandlers struct {
	journal OrgEventStream
	srv     *Server
	timing  evtTiming
}

// handleStream serves one org-level SSE connection: replay from the resume
// cursor, then the live tail, then heartbeat while it waits. It is the
// project stream with exactly one authorization difference (ADR-0048 §3):
// there is no GetProject re-check on the delivery or heartbeat path — the
// store's visibility predicate is re-evaluated by every batch read instead,
// so a member who is removed mid-stream stops receiving events at the next
// query, with no project id to 404 on.
func (h *orgEvtHandlers) handleStream(w http.ResponseWriter, r *http.Request) {
	prj := &prjHandlers{srv: h.srv}
	c, ok := prj.caller(w, r)
	if !ok {
		return
	}

	after, ok := evtResumeCursor(w, r)
	if !ok {
		return
	}

	flusher := http.NewResponseController(w)

	ctx := r.Context()
	wake, stopWatch, err := h.journal.Watch(ctx)
	if err != nil {
		prj.serverError(w, r, "", "org.event.stream", err)
		return
	}
	defer stopWatch()

	evtStreamHeaders(w)
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	log := prj.log(r)
	log.InfoContext(ctx, "org event stream opened", "after", after, "user_id", c.UserID)

	heartbeat := time.NewTicker(h.timing.heartbeat)
	defer heartbeat.Stop()
	poll := time.NewTicker(h.timing.poll)
	defer poll.Stop()

	cursor := after
	for {
		// Drain the journal first: everything safe to emit, oldest first.
		for {
			batch, err := h.journal.OrgEventsAfter(ctx, c, cursor, h.timing.batch)
			if err != nil {
				log.ErrorContext(ctx, "org event stream read failed",
					"request_id", RequestIDFrom(r), "error", err.Error())
				return
			}
			if len(batch) == 0 {
				break
			}
			for _, env := range batch {
				if err := evtWriteEvent(w, env); err != nil {
					log.DebugContext(ctx, "org event stream write failed (client gone?)",
						"user_id", c.UserID, "error", err.Error())
					return
				}
				// The cursor advances on delivered rows only: rows from a
				// project the caller stopped seeing were never in the batch,
				// so their sequences stay behind the cursor and cost neither
				// a gap nor a duplicate (ADR-0048 §3).
				cursor = env.GlobalSeq
				// One flush per event, as on the project stream.
				_ = flusher.Flush()
			}
			if len(batch) < h.timing.batch {
				break
			}
		}

		select {
		case <-ctx.Done():
			return
		case _, open := <-wake:
			if !open {
				// Wake-up source retired (shutdown): end so the replica can drain.
				return
			}
		case <-poll.C:
			// A wake-up is an optimization; the poll makes a lost notification
			// cost latency instead of a gap (ADR-0014 §6).
		case <-heartbeat.C:
			// The heartbeat is a comment: it carries no state, so it needs no
			// re-authorization — the next batch read settles membership.
			if err := evtWriteComment(w, flusher, "heartbeat"); err != nil {
				return
			}
		}
	}
}
