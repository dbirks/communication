package postgres

// The serve-side M4 driver (docs/m4-contract.md § 5.1 + § 5.4).
//
// It owns NO execution semantics. The advancer, the lease pass and the
// deadline pass are the committed engine behind RuntimeStore
// (runtimestore.go), certified by the runtimetest conformance suite over
// real Postgres; re-implementing any of that here would be a second source
// of truth, which is exactly what ADR-0023 § 5 forbids. M4Driver only
// decides WHEN the engine runs:
//
//   - Trigger is api.M4Trigger — the "after every event that can change
//     readiness" nudge the handlers fire (contract § 5.1). It never blocks
//     the handler beyond the advance transaction itself, never panics and
//     never returns an error to an HTTP path: a dropped trigger costs
//     latency, never correctness, because the next pass re-derives from
//     rows.
//   - Tick is § 5.4's backstop: one advisory-locked pass over a capped
//     batch of non-terminal runs, in ADR-0023 § 11's order — leases
//     first, then deadlines, then the advance. Many replicas are safe
//     (the loser of pg_try_advisory_lock answers 0), zero replicas only
//     delay detection.
//   - Run is the ticker that keeps Tick happening.
//
// The advisory lock is session-scoped and taken around the per-run
// transactions rather than inside them, exactly like the M3 turn-lease
// reconciler (reconciler.go): a transaction-scoped lock would be released
// after the first run and let a second replica interleave with the first.
// It is keyed separately from that reconciler's key and from the per-run
// advancer lock (runtimestore.go's advancerLockPrefix) — one mechanism
// (ADR-0014 § 9), three key spaces.

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dbirks/communication/internal/pipelines/runtime"
)

// m4DriverBatch is how many runs one backstop pass may touch: enough that a
// normal deployment drains in a tick, small enough that the lock is never
// held for an unbounded time (contract § 5.4's "capped batch").
const m4DriverBatch = 200

// m4DriverAdvisoryLockKey is the driver's advisory-lock namespace. It is
// hashed the same way the reconciler's and the journal's are, so the
// mechanism is shared without sharing a key space.
const m4DriverAdvisoryLockKey = "communication/m4-reconciler"

// m4NonTerminalRunStatuses is runs.status's live half of the 00005 CHECK —
// the arm runs_status_idx is partial over. Terminal means terminal: the
// driver never re-opens one, and the batch is ordered by age so a backlog
// drains oldest-first across ticks.
var m4NonTerminalRunStatuses = []string{
	runtime.RunQueued, runtime.RunPreparing, runtime.RunRunning,
	runtime.RunWaitingHuman, runtime.RunPaused,
}

// M4Driver advances runs from the serve process: the trigger the API
// handlers call, and the reconciler tick that catches everything a dropped
// trigger missed. Safe for concurrent use; run one per replica.
type M4Driver struct {
	pool *pgxpool.Pool
	rs   *RuntimeStore
	log  *slog.Logger

	// advance is the engine call a pass ends with; it is a field only so a
	// test can observe the exact instant the lock is held (Tick is otherwise
	// a fast transaction and the exclusion would be raced rather than
	// proven). nil means d.rs.Advance, and production never sets it.
	advance func(ctx context.Context, runID string) error

	mu sync.Mutex
	// lastHeld mirrors Reconciler.noteLeadership: log the acquisition once
	// per transition, not once per tick, and word it as the event it is —
	// leadership alternates when every replica ticks, so two replicas both
	// claiming "active" would read as two leaders to an operator.
	lastHeld bool
}

// NewM4Driver wires the driver to a pool and the RuntimeStore whose engine
// it drives. A nil logger discards lines rather than writing to stderr in
// somebody else's test output.
func NewM4Driver(pool *pgxpool.Pool, rs *RuntimeStore, log *slog.Logger) *M4Driver {
	if log == nil {
		log = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	return &M4Driver{pool: pool, rs: rs, log: log}
}

// Trigger satisfies api.M4Trigger: advance exactly one run, now. The
// advance IS the runtime transaction (the § 5.1 advancer lock plus the run
// row lock are taken inside RuntimeStore.settle, so a concurrent replica
// advancing the same run queues behind it rather than corrupting it); this
// method adds only the refusal to let that failure surface as an HTTP
// error. An unknown run id is logged the same way — a stale trigger is a
// latency observation, not an incident.
func (d *M4Driver) Trigger(ctx context.Context, runID string) {
	if d == nil || d.rs == nil {
		return
	}
	if err := d.rs.Advance(ctx, runID); err != nil {
		d.log.ErrorContext(ctx, "m4 trigger: advancer pass failed",
			slog.String("run_id", runID),
			slog.String("error", err.Error()))
	}
}

// Tick runs one backstop pass. It returns how many runs it touched; a nil
// error with 0 is the normal answer on a replica that lost the lock, and a
// run whose pass failed is counted (it was touched — the error says so)
// while the rest of the batch still runs. One dead run must not stall the
// reconciler for every other project on the instance.
func (d *M4Driver) Tick(ctx context.Context) (int, error) {
	if d == nil || d.pool == nil {
		return 0, errors.New("postgres: m4 driver has no pool")
	}
	if d.rs == nil {
		return 0, errors.New("postgres: m4 driver has no runtime store")
	}

	conn, err := d.pool.Acquire(ctx)
	if err != nil {
		return 0, fmt.Errorf("postgres: acquire m4 driver connection: %w", err)
	}
	defer conn.Release()

	held, err := m4DriverTryLock(ctx, conn.Conn())
	if err != nil {
		return 0, err
	}
	d.noteLeadership(held)
	if !held {
		return 0, nil
	}
	defer func() {
		if _, err := m4DriverUnlock(ctx, conn.Conn()); err != nil {
			d.log.WarnContext(ctx, "could not release m4 driver lock",
				slog.String("error", err.Error()))
		}
	}()

	ids, err := m4DriverBatchRuns(ctx, conn.Conn())
	if err != nil {
		return 0, err
	}

	var errs []error
	advance := d.advance
	if advance == nil {
		advance = d.rs.Advance
	}
	for _, runID := range ids {
		if ctx.Err() != nil {
			// Shutdown mid-batch: the rows already committed stand, and the
			// next tick (on any replica) re-derives the rest from rows.
			break
		}
		// ADR-0023 § 11's order: expired leases first (pass 1), so a dead
		// worker's attempt is interrupted before the deadline pass looks at
		// it, then deadlines (pass 3), then the advance that re-derives
		// readiness from whatever those two just wrote.
		err := d.rs.ReconcileLeases(ctx, runID)
		if err == nil {
			err = d.rs.ReconcileDeadlines(ctx, runID)
		}
		if err == nil {
			err = advance(ctx, runID)
		}
		if err != nil {
			errs = append(errs, fmt.Errorf("run %s: %w", runID, err))
			d.log.ErrorContext(ctx, "m4 reconciler pass failed for one run; continuing",
				slog.String("run_id", runID),
				slog.String("error", err.Error()))
		}
	}

	if len(ids) > 0 {
		d.log.DebugContext(ctx, "m4 reconciler pass",
			slog.Int("runs_touched", len(ids)),
			slog.Int("failures", len(errs)))
	}
	return len(ids), errors.Join(errs...)
}

// Run ticks every `every` until ctx is done, returning the last pass error
// (nil when every pass was clean). It is the serve lifecycle's goroutine
// body, not a library timer: the caller owns shutdown.
func (d *M4Driver) Run(ctx context.Context, every time.Duration) error {
	if d == nil || d.pool == nil {
		return errors.New("postgres: m4 driver has no pool")
	}
	if every <= 0 {
		every = 5 * time.Second
	}
	ticker := time.NewTicker(every)
	defer ticker.Stop()

	var lastErr error
	for {
		select {
		case <-ctx.Done():
			return lastErr
		case <-ticker.C:
			if _, err := d.Tick(ctx); err != nil {
				lastErr = err
				d.log.ErrorContext(ctx, "m4 driver tick failed; retrying next tick",
					slog.String("error", err.Error()))
			}
		}
	}
}

func (d *M4Driver) noteLeadership(held bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if held && !d.lastHeld {
		d.log.Info("m4 driver acquired the advisory lock")
	}
	if !held && d.lastHeld {
		d.log.Debug("m4 driver skipped a pass: another replica holds the lock")
	}
	d.lastHeld = held
}

// m4DriverTryLock / m4DriverUnlock take and release the session-scoped
// advisory lock on the driver's own pooled connection (reconciler.go's
// rcnTryLock shape and wording).
func m4DriverTryLock(ctx context.Context, conn *pgx.Conn) (bool, error) {
	var held bool
	if err := conn.QueryRow(ctx,
		`SELECT pg_try_advisory_lock(hashtextextended($1, 0))`, m4DriverAdvisoryLockKey).Scan(&held); err != nil {
		return false, fmt.Errorf("postgres: try m4 driver lock: %w", err)
	}
	return held, nil
}

func m4DriverUnlock(ctx context.Context, conn *pgx.Conn) (int64, error) {
	var freed int64
	if err := conn.QueryRow(ctx,
		`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, m4DriverAdvisoryLockKey).Scan(&freed); err != nil {
		return 0, fmt.Errorf("postgres: unlock m4 driver lock: %w", err)
	}
	return freed, nil
}

// m4DriverBatchRuns selects the capped batch of live runs, oldest first. It
// reads only ids: the passes themselves hydrate from the authoritative
// rows, so a run that finished between this SELECT and its advance is
// refused by the engine's own terminal guard, not by a stale snapshot here.
func m4DriverBatchRuns(ctx context.Context, conn *pgx.Conn) ([]string, error) {
	rows, err := conn.Query(ctx, `
		SELECT id::text FROM runs
		WHERE status = ANY($1::text[])
		ORDER BY created_at, id
		LIMIT $2`, m4NonTerminalRunStatuses, m4DriverBatch)
	if err != nil {
		return nil, fmt.Errorf("postgres: select m4 reconciler batch: %w", err)
	}
	defer rows.Close()

	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("postgres: scan m4 reconciler batch: %w", err)
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("postgres: read m4 reconciler batch: %w", err)
	}
	return ids, nil
}
