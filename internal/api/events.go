package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/dbirks/communication/internal/events"
)

// EventStream is everything the SSE handler needs from the durable journal.
// The wake-up channel is a hint only: the handler always re-queries by
// sequence, so a lost, duplicated or never-sent notification cannot make a
// stream wrong (communication-spec/02-system-architecture.md: "LISTEN/NOTIFY
// is only a wake-up optimization", ADR-0014 §6).
//
// Implementations must return only rows that are safe to emit — see
// internal/store/postgres/events.go and ADR-0014 §9 — and must answer
// ErrProjectNotFound for a project the caller may not see.
type EventStream interface {
	// EventsAfter returns up to limit envelopes for one project with
	// global_seq strictly greater than afterSeq, oldest first.
	EventsAfter(ctx context.Context, c Caller, projectID string, afterSeq int64, limit int) ([]events.Envelope, error)

	// Watch returns a channel signalled whenever the journal may have gained
	// rows, plus a function that ends the subscription. A closed channel means
	// the wake-up source is gone (replica shutting down) and the stream must
	// stop. A nil channel means "poll only".
	Watch(ctx context.Context) (<-chan struct{}, func(), error)
}

// evtTiming groups the three knobs that decide how a stream behaves over time.
// They are per-handler rather than package globals so a test can run on a
// millisecond scale without mutating anything a live handler is reading — a
// stream is long-lived, and a shared variable a test can move under it is both
// a data race and a source of flaky timing.
type evtTiming struct {
	// heartbeat is how often an idle stream emits `: heartbeat` (openapi.yaml
	// and ADR-0014 §5 pin it at 15 s — the value proxies are documented for).
	heartbeat time.Duration
	// poll is the safety-net re-query interval: a wake-up is an optimization,
	// so the interval bounds the latency of a lost notification (ADR-0014 §6)
	// and is also the moment a withheld row's snapshot advances (§9).
	poll time.Duration
	// batch is how many journal rows one read may return.
	batch int
}

// evtProductionTiming is what every replica runs with.
func evtProductionTiming() evtTiming {
	return evtTiming{heartbeat: 15 * time.Second, poll: 2 * time.Second, batch: 100}
}

// RegisterEvents mounts GET /api/v1/projects/{projectId}/events.
//
// Authorization is the same as every other project route: it is checked with
// the ProjectStore before a single byte of stream is written, a non-member is
// answered 404 with an audit row, and it is re-checked whenever the stream is
// about to deliver events and on every heartbeat — so a member who is removed
// mid-stream stops receiving events (ADR-0014 §5,
// communication-spec/06-collaboration-identity.md).
func RegisterEvents(s *Server, projects ProjectStore, stream EventStream) {
	registerEvents(s, projects, stream, evtProductionTiming())
}

// registerEvents is RegisterEvents with the timing made explicit; production
// always goes through RegisterEvents.
func registerEvents(s *Server, projects ProjectStore, stream EventStream, timing evtTiming) {
	if timing.heartbeat <= 0 {
		timing.heartbeat = evtProductionTiming().heartbeat
	}
	if timing.poll <= 0 {
		timing.poll = evtProductionTiming().poll
	}
	if timing.batch <= 0 {
		timing.batch = evtProductionTiming().batch
	}
	h := &evtHandlers{projects: projects, journal: stream, srv: s, timing: timing}
	s.HandleAuthed("GET /api/v1/projects/{projectId}/events", http.HandlerFunc(h.handleStream))
}

type evtHandlers struct {
	projects ProjectStore
	journal  EventStream
	srv      *Server
	timing   evtTiming
}

// stream serves one SSE connection: replay from the resume cursor, then the
// live tail, then heartbeat while it waits.
func (h *evtHandlers) handleStream(w http.ResponseWriter, r *http.Request) {
	prj := &prjHandlers{store: h.projects, srv: h.srv}
	c, ok := prj.caller(w, r)
	if !ok {
		return
	}
	projectID := r.PathValue("projectId")

	after, ok := evtResumeCursor(w, r)
	if !ok {
		return
	}

	// Connect-time authorization: 404 (never 403) plus an audit row for a
	// project this caller may not see, before the response becomes a stream.
	if _, err := h.projects.GetProject(r.Context(), c, projectID); err != nil {
		prj.fail(w, r, c, projectID, "event.stream", prjNoConflict, err)
		return
	}

	flusher := http.NewResponseController(w)

	ctx := r.Context()
	wake, stopWatch, err := h.journal.Watch(ctx)
	if err != nil {
		prj.serverError(w, r, projectID, "event.stream", err)
		return
	}
	defer stopWatch()

	evtStreamHeaders(w)
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	log := prj.log(r)
	log.InfoContext(ctx, "event stream opened",
		"project_id", projectID, "after", after, "user_id", c.UserID)

	heartbeat := time.NewTicker(h.timing.heartbeat)
	defer heartbeat.Stop()
	poll := time.NewTicker(h.timing.poll)
	defer poll.Stop()

	cursor := after
	for {
		// Drain the journal first: everything safe to emit, oldest first.
		for {
			batch, err := h.journal.EventsAfter(ctx, c, projectID, cursor, h.timing.batch)
			if err != nil {
				if errors.Is(err, ErrProjectNotFound) {
					// Revoked or deleted mid-stream: stop delivering, no gap.
					log.WarnContext(ctx, "event stream closed: access lost",
						"project_id", projectID, "user_id", c.UserID)
					return
				}
				log.ErrorContext(ctx, "event stream read failed",
					"project_id", projectID, "request_id", RequestIDFrom(r), "error", err.Error())
				return
			}
			if len(batch) == 0 {
				break
			}
			// Delivering proves the caller is still allowed to see the project;
			// re-check on the delivery path so a revoked member stops at once.
			if _, err := h.projects.GetProject(ctx, c, projectID); err != nil {
				log.WarnContext(ctx, "event stream closed: authorization lost",
					"project_id", projectID, "user_id", c.UserID, "error", err.Error())
				return
			}
			for _, env := range batch {
				if err := evtWriteEvent(w, env); err != nil {
					log.DebugContext(ctx, "event stream write failed (client gone?)",
						"project_id", projectID, "error", err.Error())
					return
				}
				cursor = env.GlobalSeq
				// One flush per event: a batch must not sit in the server's buffer
				// while the browser waits for the first thing it asked to see.
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
			// cost latency instead of a gap. It is also the moment the reader's
			// snapshot advances past a row it had to withhold (ADR-0014 §9).
		case <-heartbeat.C:
			if _, err := h.projects.GetProject(ctx, c, projectID); err != nil {
				log.WarnContext(ctx, "event stream closed: authorization lost",
					"project_id", projectID, "user_id", c.UserID, "error", err.Error())
				return
			}
			if err := evtWriteComment(w, flusher, "heartbeat"); err != nil {
				return
			}
		}
	}
}

// evtResumeCursor resolves the replay position: the Last-Event-ID header the
// browser sets automatically wins over an explicit ?after= (ADR-0014 §5).
// It reports false when a malformed value has already been answered.
func evtResumeCursor(w http.ResponseWriter, r *http.Request) (int64, bool) {
	raw := r.Header.Get("Last-Event-ID")
	source := "Last-Event-ID"
	if raw == "" {
		raw = r.URL.Query().Get("after")
		source = "after"
	}
	if raw == "" {
		return 0, true
	}
	v, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || v < 0 {
		WriteProblem(w, http.StatusUnprocessableEntity, "Validation Failed",
			source+" must be a non-negative integer.")
		return 0, false
	}
	return v, true
}

// evtStreamHeaders sets what SSE clients and intermediaries need: the media
// type, no caching, and no buffering by a reverse proxy that does not honour
// X-Accel-Buffering (Caddy is configured with flush_interval -1).
func evtStreamHeaders(w http.ResponseWriter) {
	h := w.Header()
	h.Set("Content-Type", "text/event-stream; charset=utf-8")
	h.Set("Cache-Control", "no-store")
	h.Set("X-Accel-Buffering", "no")
}

// evtWriteEvent writes one SSE frame: id is the durable global_seq, event is
// the type and data is the envelope exactly as the journal stored it.
func evtWriteEvent(w http.ResponseWriter, env events.Envelope) error {
	data, err := json.Marshal(env)
	if err != nil {
		return fmt.Errorf("api: encode event %d: %w", env.GlobalSeq, err)
	}
	// json.Marshal escapes <, > and & so the payload can never terminate the
	// frame or smuggle a script tag; it also guarantees a single line.
	if _, err := fmt.Fprintf(w, "id: %d\nevent: %s\ndata: %s\n\n", env.GlobalSeq, env.Type, data); err != nil {
		return err
	}
	return nil
}

// evtWriteComment emits an SSE comment line (`: heartbeat`) and flushes it,
// which is what keeps an idle stream alive across proxies.
func evtWriteComment(w io.Writer, f *http.ResponseController, text string) error {
	if _, err := fmt.Fprintf(w, ": %s\n\n", text); err != nil {
		return err
	}
	return f.Flush()
}
