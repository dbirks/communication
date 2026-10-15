package postgres

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Worker statuses stored in workers.status. They mirror
// internal/worker's Status* constants; the store keeps its own copies so the
// persistence layer does not depend on the worker package (AGENTS.md
// dependency rule: adapters depend on interfaces, never the reverse).
const (
	WorkerStatusOnline   = "online"
	WorkerStatusDraining = "draining"
	WorkerStatusOffline  = "offline"
)

// regLivenessIntervals is how many missed heartbeats the read side tolerates
// before reporting a worker offline: a worker that is merely mid-flight on a
// slow database round trip keeps its online status, one that is gone does not.
const regLivenessIntervals = 3

// regDefaultHeartbeat matches internal/worker.DefaultHeartbeat; the store may
// not import that package, so the default is mirrored and pinned by a test.
const regDefaultHeartbeat = 10 * time.Second

// Worker is a row of the workers table as the read side reports it: Status is
// the *effective* status, with a stale heartbeat downgraded to offline, and
// DBStatus is what the row itself says (02-system-architecture.md recovery
// table: a lost worker host must be visible without waiting for a write).
type Worker struct {
	ID              string
	Name            string
	Hostname        string
	Version         string
	Status          string
	DBStatus        string
	StartedAt       time.Time
	LastHeartbeatAt time.Time
	// LivenessWindow is the staleness bound this read applied, echoed so the
	// API can render "no heartbeat for X" without recomputing it.
	LivenessWindow time.Duration
}

// WorkerRegistry is the workers-table face of the store: it implements the
// registration, heartbeat and status writes the execution worker performs,
// and the liveness-aware read the API's GET /api/v1/workers will use.
// A *WorkerRegistry satisfies internal/worker.Registry.
type WorkerRegistry struct {
	Pool *pgxpool.Pool
}

// regWorkerColumns is the workers projection returned by every read.
const regWorkerColumns = `id::text, name, hostname, version, status,
	started_at, last_heartbeat_at`

// Register upserts the worker row keyed by name, so a restart keeps the same
// identity (and the history hanging off it) while refreshing hostname,
// version, started_at and last_heartbeat_at, and returns the row id.
//
// An interrupted worker that never reached its offline write comes back
// online here — its previous process is gone by definition, because the name
// is unique per worker.
func (r *WorkerRegistry) Register(ctx context.Context, name, hostname, version string) (string, error) {
	if r == nil || r.Pool == nil {
		return "", errors.New("postgres: worker registry has no pool")
	}
	if name == "" || hostname == "" || version == "" {
		return "", errors.New("postgres: Register requires name, hostname and version")
	}

	var id string
	err := r.Pool.QueryRow(ctx, `
		INSERT INTO workers (name, hostname, version, started_at, last_heartbeat_at, status)
		VALUES ($1, $2, $3, now(), now(), '`+WorkerStatusOnline+`')
		ON CONFLICT (name) DO UPDATE SET
			hostname          = EXCLUDED.hostname,
			version           = EXCLUDED.version,
			started_at        = now(),
			last_heartbeat_at = now(),
			status            = '`+WorkerStatusOnline+`'
		RETURNING id::text`, name, hostname, version).Scan(&id)
	if err != nil {
		return "", fmt.Errorf("postgres: register worker %q: %w", name, err)
	}
	return id, nil
}

// Heartbeat refreshes last_heartbeat_at. It touches no other column: a
// heartbeat must stay cheap enough to run every few seconds.
func (r *WorkerRegistry) Heartbeat(ctx context.Context, name string) error {
	if r == nil || r.Pool == nil {
		return errors.New("postgres: worker registry has no pool")
	}
	if name == "" {
		return errors.New("postgres: Heartbeat requires a worker name")
	}
	tag, err := r.Pool.Exec(ctx, `
		UPDATE workers SET last_heartbeat_at = now()
		WHERE name = $1 AND status <> '`+WorkerStatusOffline+`'`, name)
	if err != nil {
		return fmt.Errorf("postgres: heartbeat worker %q: %w", name, err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("postgres: heartbeat worker %q: %w", name, ErrNotFound)
	}
	return nil
}

// SetStatus moves a worker between the lifecycle statuses. Valid transitions
// are enforced in SQL, not by the caller: only the worker itself writes these
// rows and a bug must not be able to resurrect an offline worker as online
// without going through Register.
func (r *WorkerRegistry) SetStatus(ctx context.Context, name, status string) error {
	if r == nil || r.Pool == nil {
		return errors.New("postgres: worker registry has no pool")
	}
	from, ok := regAllowedStatusTransitions[status]
	if !ok {
		if status == WorkerStatusOnline {
			return errors.New("postgres: SetStatus cannot set online: only Register (an upsert) brings a worker online")
		}
		return fmt.Errorf("postgres: SetStatus unknown worker status %q", status)
	}
	if name == "" {
		return errors.New("postgres: SetStatus requires a worker name")
	}

	tag, err := r.Pool.Exec(ctx, `
		UPDATE workers SET status = $1
		WHERE name = $2 AND status = ANY($3)`, status, name, from)
	if err != nil {
		return fmt.Errorf("postgres: set worker status %q: %w", status, err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("postgres: set worker %q status %q: no matching row: %w", name, status, ErrNotFound)
	}
	return nil
}

// regAllowedStatusTransitions maps a target status to the statuses it may be
// reached from. online is deliberately absent: it is reachable only through
// Register's upsert, so no status write can revive a worker.
var regAllowedStatusTransitions = map[string][]string{
	WorkerStatusDraining: {WorkerStatusOnline, WorkerStatusDraining},
	WorkerStatusOffline:  {WorkerStatusOnline, WorkerStatusDraining, WorkerStatusOffline},
}

// ListWorkersWithLiveness returns every worker, reporting a row whose
// heartbeat is older than heartbeatInterval * 3 as offline even while its
// stored status still says online — a worker that died without a graceful
// exit never writes its own offline row. Workers in draining are reported as
// they are: draining is a deliberate state, not silence.
//
// A zero heartbeatInterval falls back to internal/worker's 10s default; the
// store does not import that package, so the number is repeated here and
// pinned by a test.
func (r *WorkerRegistry) ListWorkersWithLiveness(ctx context.Context, heartbeatInterval time.Duration) ([]Worker, error) {
	if r == nil || r.Pool == nil {
		return nil, errors.New("postgres: worker registry has no pool")
	}
	if heartbeatInterval <= 0 {
		heartbeatInterval = regDefaultHeartbeat
	}
	window := heartbeatInterval * regLivenessIntervals

	rows, err := r.Pool.Query(ctx, `
		SELECT `+regWorkerColumns+`,
			CASE
				WHEN status = '`+WorkerStatusOnline+`' AND last_heartbeat_at < now() - $1::interval THEN '`+WorkerStatusOffline+`'
				ELSE status
			END
		FROM workers
		ORDER BY name`, regIntervalString(window))
	if err != nil {
		return nil, fmt.Errorf("postgres: list workers: %w", err)
	}
	defer rows.Close()

	var out []Worker
	for rows.Next() {
		var w Worker
		if err := rows.Scan(&w.ID, &w.Name, &w.Hostname, &w.Version, &w.DBStatus,
			&w.StartedAt, &w.LastHeartbeatAt, &w.Status); err != nil {
			return nil, fmt.Errorf("postgres: scan worker: %w", err)
		}
		w.LivenessWindow = window
		out = append(out, w)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("postgres: list workers: %w", err)
	}
	return out, nil
}

// ListWorkers is ListWorkersWithLiveness at the default heartbeat interval.
func (r *WorkerRegistry) ListWorkers(ctx context.Context) ([]Worker, error) {
	return r.ListWorkersWithLiveness(ctx, regDefaultHeartbeat)
}

// regIntervalSecond is one second expressed as Postgres interval syntax, the
// unit regIntervalString multiplies.
const regIntervalSecond = 1000 * time.Millisecond

// regIntervalString renders a duration as a Postgres interval literal
// ("30 seconds", "235 seconds" — Postgres parses any count) because
// make_interval(secs => $1) would need a float8 and Postgres has no
// float8-to-interval cast. Durations here are whole seconds, and Round makes
// that explicit.
func regIntervalString(d time.Duration) string {
	if d < 0 {
		d = 0
	}
	return fmt.Sprintf("%d seconds", int64(d.Round(time.Second)/regIntervalSecond))
}
