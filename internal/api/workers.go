package api

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"time"
)

// WorkerView is the Worker schema of api/openapi.yaml: one execution worker
// registered with the control plane. Status is the *effective* status as the
// store computes it (a worker whose heartbeat went stale is reported offline
// even while its row still says online), so the UI's /ops page cannot be
// misled by a process that died without writing its last transition.
type WorkerView struct {
	ID              string    `json:"id"`
	Name            string    `json:"name"`
	Hostname        string    `json:"hostname"`
	Version         string    `json:"version"`
	Status          string    `json:"status"`
	StartedAt       time.Time `json:"started_at"`
	LastHeartbeatAt time.Time `json:"last_heartbeat_at"`
}

// WorkerStore reads the worker registry. Registration itself happens through
// the worker process and the database, never through this API
// (openapi.yaml listWorkers).
type WorkerStore interface {
	ListWorkers(ctx context.Context) ([]WorkerView, error)
}

// RegisterWorkers mounts GET /api/v1/workers: authenticated read-only listing
// of the workers this deployment knows about. It is not project-scoped, so it
// needs a session but no membership.
func RegisterWorkers(s *Server, store WorkerStore) {
	h := &wklHandlers{store: store, srv: s}
	s.HandleAuthed("GET /api/v1/workers", http.HandlerFunc(h.list))
}

type wklHandlers struct {
	store WorkerStore
	srv   *Server
}

func (h *wklHandlers) list(w http.ResponseWriter, r *http.Request) {
	if _, ok := PrincipalFrom(r.Context()); !ok {
		// Reachable only if the route were ever registered without RequireAuth;
		// the contract says 401, so it says 401 rather than leaking a nil caller
		// into the store.
		WriteProblem(w, http.StatusUnauthorized, "Unauthenticated",
			"A valid session is required.")
		return
	}
	workers, err := h.store.ListWorkers(r.Context())
	if err != nil {
		// The store error may name tables or connection details; the client gets
		// the request id to quote instead (ADR-0014 §2).
		h.log(r).ErrorContext(r.Context(), "worker list failed",
			"request_id", RequestIDFrom(r), "error", err.Error())
		WriteProblem(w, http.StatusInternalServerError, "Internal Server Error",
			"The server could not read the worker registry. Use the request id when reporting it.")
		return
	}
	if workers == nil {
		// Empty must be [] rather than null: a client should always be able to
		// iterate the collection without a nil check.
		workers = []WorkerView{}
	}
	WriteJSON(w, http.StatusOK, prjList[[]WorkerView]{Items: workers})
}

func (h *wklHandlers) log(r *http.Request) *slog.Logger {
	if h.srv != nil {
		return h.srv.logger
	}
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}
