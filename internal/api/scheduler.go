package api

import (
	"context"
	"io"
	"log/slog"
	"net/http"
)

// GET /api/v1/system/scheduler (docs/m4-contract.md § 2.1 route 37,
// api/openapi.yaml SchedulerStatus): ADR-0023 Consequences' counters, so
// "is the engine wedged, and where?" is answerable without reading code.
// Session required, no membership check — this matches GET /api/v1/workers:
// an operator has to see the queue before anyone trusts it. No prompt text,
// no secret material, no user names in any field (`02` Observability), and
// no per-project content: every number here is fleet-wide aggregate.

// SchedulerStore is the ops-counter read. The adapter answers it from the
// attempt/run/worker tables (queued-oldest-age from attempts_claim_idx,
// lease expirations counted since replica start from the reconciler's pass-1
// counter, queued_unbindable_runs from § 5.2's honest affinity test).
type SchedulerStore interface {
	SchedulerStatus(ctx context.Context) (SchedulerStatusView, error)
}

// SchedulerAttemptsView is the attempts_by_status member (the three live
// statuses — terminal history is a run-list question, not a queue one).
type SchedulerAttemptsView struct {
	Queued  int `json:"queued"`
	Leased  int `json:"leased"`
	Running int `json:"running"`
}

// SchedulerWorkerLoadView is SchedulerWorkerLoad: the same pair the claim
// predicate compares (active_attempts < capacity), shown as the SQL sees it.
type SchedulerWorkerLoadView struct {
	WorkerID       string `json:"worker_id"`
	Name           string `json:"name"`
	Capacity       int    `json:"capacity"`
	ActiveAttempts int    `json:"active_attempts"`
}

// SchedulerStatusView is the SchedulerStatus schema.
type SchedulerStatusView struct {
	AttemptsByStatus       SchedulerAttemptsView     `json:"attempts_by_status"`
	OldestQueuedAgeSeconds *float64                  `json:"oldest_queued_age_seconds"`
	LeaseExpirations       int                       `json:"lease_expirations"`
	MaxRetryLoopDepth      int                       `json:"max_retry_loop_depth"`
	WaitingApprovals       int                       `json:"waiting_approvals"`
	QueuedUnbindableRuns   int                       `json:"queued_unbindable_runs"`
	Workers                []SchedulerWorkerLoadView `json:"workers"`
}

// RegisterScheduler mounts the ops read.
func RegisterScheduler(s *Server, store SchedulerStore) {
	h := &schedHandlers{store: store, srv: s}
	s.HandleAuthed("GET /api/v1/system/scheduler", http.HandlerFunc(h.status))
}

type schedHandlers struct {
	store SchedulerStore
	srv   *Server
}

func (h *schedHandlers) status(w http.ResponseWriter, r *http.Request) {
	view, err := h.store.SchedulerStatus(r.Context())
	if err != nil {
		h.log(r).ErrorContext(r.Context(), "scheduler counters read failed",
			slog.String("request_id", RequestIDFrom(r)),
			slog.Any("error", err))
		WriteProblem(w, http.StatusInternalServerError, "Internal Server Error",
			"The server could not read the scheduler counters. Use the request id when reporting it.")
		return
	}
	if view.Workers == nil {
		view.Workers = []SchedulerWorkerLoadView{}
	}
	WriteJSON(w, http.StatusOK, view)
}

func (h *schedHandlers) log(r *http.Request) *slog.Logger {
	if h.srv != nil {
		return h.srv.logger
	}
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}
