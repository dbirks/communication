package postgres

import (
	"context"
	"errors"
	"time"

	"github.com/dbirks/communication/internal/api"
)

// APIWorkerStore exposes the workers registry through the interface
// internal/api's GET /api/v1/workers handler depends on. Like APIProjectStore
// and APIEventStream it lives here because package api must not import this
// one (AGENTS.md dependency rule: adapters depend on interfaces, never the
// reverse).
//
// The read itself is WorkerRegistry's, including its liveness rule: a row
// whose heartbeat went stale is reported offline whatever its stored status
// says, so the listing cannot be lied to by a worker that died mid-heartbeat.
type APIWorkerStore struct {
	R *WorkerRegistry

	// HeartbeatInterval is the worker's configured heartbeat period; zero uses
	// the registry default. It sets how much silence is tolerated before a
	// worker is reported offline.
	HeartbeatInterval time.Duration
}

var (
	_ api.WorkerStore = APIWorkerStore{}
	_ api.WorkerStore = (*APIWorkerStore)(nil)
)

// ListWorkers implements api.WorkerStore.
func (a APIWorkerStore) ListWorkers(ctx context.Context) ([]api.WorkerView, error) {
	if a.R == nil || a.R.Pool == nil {
		return nil, errors.New("postgres: worker store has no pool")
	}
	workers, err := a.R.ListWorkersWithLiveness(ctx, a.HeartbeatInterval)
	if err != nil {
		return nil, err
	}
	out := make([]api.WorkerView, 0, len(workers))
	for _, wk := range workers {
		out = append(out, wklAPIWorker(wk))
	}
	return out, nil
}

// wklAPIWorker turns a workers row into the API view. Only the contracted
// fields are exposed: DBStatus and the liveness window are operator detail
// that api/openapi.yaml does not define.
func wklAPIWorker(wk Worker) api.WorkerView {
	return api.WorkerView{
		ID:              wk.ID,
		Name:            wk.Name,
		Hostname:        wk.Hostname,
		Version:         wk.Version,
		Status:          wk.Status,
		StartedAt:       wk.StartedAt.UTC(),
		LastHeartbeatAt: wk.LastHeartbeatAt.UTC(),
	}
}
