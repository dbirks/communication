package postgres

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dbirks/communication/internal/api"
)

// APILauncherStore backs GET /api/v1/launchers (ADR-0051). It reuses the
// WorkerRegistry's liveness rule: the launcher list and /workers must never
// disagree about which workers are live.
type APILauncherStore struct {
	Pool *pgxpool.Pool

	// HeartbeatInterval is the workers' configured heartbeat period; zero
	// uses the registry default.
	HeartbeatInterval time.Duration
}

var (
	_ api.LauncherStore = APILauncherStore{}
	_ api.LauncherStore = (*APILauncherStore)(nil)
)

// CountLaunchWorkers implements api.LauncherStore. The count is fleet-level
// on purpose (ADR-0051 §2): a worker's registration carries its sandbox
// state — backend, version, enforcement, verified — but never the set of
// launchers it can run (ADR-0019 D5), so "required sandbox enforcement with
// a verified launch" is the only per-launcher number that is not invented.
//
// The liveness rule is the exact CASE rule
// WorkerRegistry.ListWorkersWithLiveness applies: a stored online row whose
// heartbeat went stale counts as offline, so a worker that died without
// writing its offline row cannot inflate the count.
func (a APILauncherStore) CountLaunchWorkers(ctx context.Context) (int, error) {
	if a.Pool == nil {
		return 0, errors.New("postgres: launcher store has no pool")
	}
	interval := a.HeartbeatInterval
	if interval <= 0 {
		interval = regDefaultHeartbeat
	}
	window := interval * regLivenessIntervals
	var n int
	err := a.Pool.QueryRow(ctx, `
		SELECT count(*) FROM workers
		 WHERE status <> 'offline'
		   AND NOT (status = 'online' AND last_heartbeat_at < now() - $1::interval)
		   AND sandbox_enforcement = 'required'
		   AND sandbox_verified`, regIntervalString(window)).Scan(&n)
	if err != nil {
		return 0, fmt.Errorf("postgres: count launch workers: %w", err)
	}
	return n, nil
}
