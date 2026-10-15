// Package worker implements the execution worker's control-plane loop:
// registration, heartbeat and graceful drain
// (communication-spec/02-system-architecture.md: "`communication worker`:
// registers, heartbeats, claims execution attempts…; independent rollout and
// lifetime").
//
// Claiming work is milestone M2; this package deliberately contains only the
// lifetime half of the loop, expressed against a narrow Registry port so the
// loop's state transitions are testable without a database and so no store
// type leaks into worker semantics (AGENTS.md dependency rule).
package worker

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"
)

// Worker lifecycle statuses, mirroring the workers.status CHECK constraint in
// internal/store/postgres/migrations/00001_m1_core.sql.
const (
	StatusOnline   = "online"
	StatusDraining = "draining"
	StatusOffline  = "offline"
)

// Defaults for the cadence knobs; cmd/communication overrides them from
// COMMUNICATION_WORKER_HEARTBEAT.
const (
	// DefaultHeartbeat is how often an online worker refreshes
	// last_heartbeat_at.
	DefaultHeartbeat = 10 * time.Second

	// DefaultDrainTimeout bounds the whole shutdown path — marking itself
	// draining, releasing work, marking itself offline — so a wedged
	// database cannot keep a terminated worker pretending to be alive.
	DefaultDrainTimeout = 15 * time.Second
)

// ErrInvalidConfig reports a Config that cannot be normalised into a working
// worker; callers surface it as a configuration failure (exit 2).
var ErrInvalidConfig = errors.New("worker: invalid configuration")

// Registry is the persistence port the loop needs. It is implemented by
// *postgres.WorkerRegistry; the worker package must not know that exists.
//
// All methods are keyed by worker name, which is the stable identity across
// restarts (the workers.name column is unique).
type Registry interface {
	// Register upserts the worker row and returns its id. A restart keeps the
	// same row with a fresh started_at, last_heartbeat_at and online status.
	Register(ctx context.Context, name, hostname, version string) (id string, err error)

	// Heartbeat refreshes last_heartbeat_at for an online worker.
	Heartbeat(ctx context.Context, name string) error

	// SetStatus moves the worker between the lifecycle statuses.
	SetStatus(ctx context.Context, name, status string) error
}

// Clock makes the heartbeat cadence injectable so tests drive transitions
// deterministically instead of sleeping.
type Clock interface {
	// After returns a channel that receives once after d.
	After(d time.Duration) <-chan time.Time
}

// realClock is the production Clock.
type realClock struct{}

func (realClock) After(d time.Duration) <-chan time.Time { return time.After(d) }

// Config is a worker's identity and cadence. Hostname and Version are
// reported verbatim in the workers table.
type Config struct {
	Name         string
	Hostname     string
	Version      string
	Heartbeat    time.Duration
	DrainTimeout time.Duration
}

// normalised fills in zero-valued knobs and rejects what cannot work.
func (c Config) normalised() (Config, error) {
	out := c
	if out.Name == "" {
		return out, fmt.Errorf("%w: worker name is required", ErrInvalidConfig)
	}
	if out.Heartbeat <= 0 {
		out.Heartbeat = DefaultHeartbeat
	}
	if out.DrainTimeout <= 0 {
		out.DrainTimeout = DefaultDrainTimeout
	}
	// maxDrainTimeout is the ceiling on the shutdown path: compose stop_grace_period
	// is 20s, so a longer drain would be killed by the runtime instead of
	// finishing (02 §"Worker graceful rollout").
	const maxDrainTimeout = 20 * time.Second
	if out.DrainTimeout > maxDrainTimeout {
		return out, fmt.Errorf("%w: drain timeout %s exceeds the %s ceiling",
			ErrInvalidConfig, out.DrainTimeout, maxDrainTimeout)
	}
	if out.Hostname == "" {
		out.Hostname = out.Name
	}
	if out.Version == "" {
		out.Version = "dev"
	}
	return out, nil
}

// Worker runs the registration/heartbeat/drain loop for one worker process.
// It is not safe for concurrent Run calls; one process owns one Worker.
type Worker struct {
	cfg   Config
	reg   Registry
	clock Clock
	log   *slog.Logger

	// idMu guards the id assigned by Register: ID() may be read from another
	// goroutine while the loop is running.
	idMu sync.Mutex
	id   string

	// Drain runs between marking the worker draining and marking it offline.
	// M1 has nothing to drain — no attempts are claimed yet — so it is nil by
	// default. M2 sets it to the lease-releasing walk (02 §"Worker graceful
	// rollout": stop claiming; drain or cancel per deadline).
	Drain func(context.Context) error

	// Registered, when set, runs on a goroutine owned by Run immediately
	// after Register succeeds — M2 starts the turn loop here so claiming can
	// never begin before the worker row (and with it the id claims are keyed
	// by) exists.
	Registered func(ctx context.Context, workerID string)
}

// Option customises a Worker.
type Option func(*Worker)

// WithClock replaces the heartbeat clock (tests).
func WithClock(c Clock) Option {
	return func(w *Worker) {
		if c != nil {
			w.clock = c
		}
	}
}

// WithLogger replaces the structured logger; nil keeps the default no-op-ish
// logger writing at Info to stderr.
func WithLogger(l *slog.Logger) Option {
	return func(w *Worker) {
		if l != nil {
			w.log = l
		}
	}
}

// New validates cfg and returns a Worker bound to reg.
func New(cfg Config, reg Registry, opts ...Option) (*Worker, error) {
	if reg == nil {
		return nil, fmt.Errorf("%w: registry is required", ErrInvalidConfig)
	}
	norm, err := cfg.normalised()
	if err != nil {
		return nil, err
	}
	w := &Worker{cfg: norm, reg: reg, clock: realClock{}, log: slog.Default()}
	for _, opt := range opts {
		opt(w)
	}
	return w, nil
}

// ID returns the worker id assigned by the most recent successful Register
// call; it is empty until Run has registered.
func (w *Worker) ID() string {
	w.idMu.Lock()
	defer w.idMu.Unlock()
	return w.id
}

// Run registers the worker, heartbeats until ctx is cancelled, then drains:
// status draining immediately, status offline before returning. It returns
// nil after a clean shutdown and a non-nil error only when registration (or
// the process itself) failed.
func (w *Worker) Run(ctx context.Context) error {
	if ctx == nil {
		return errors.New("worker: Run requires a context")
	}

	id, err := w.reg.Register(ctx, w.cfg.Name, w.cfg.Hostname, w.cfg.Version)
	if err != nil {
		return fmt.Errorf("worker: register %q: %w", w.cfg.Name, err)
	}
	w.idMu.Lock()
	w.id = id
	w.idMu.Unlock()
	w.log.Info("worker registered",
		slog.String("worker", w.cfg.Name),
		slog.String("worker_id", id),
		slog.String("hostname", w.cfg.Hostname),
		slog.String("version", w.cfg.Version),
		slog.String("heartbeat", w.cfg.Heartbeat.String()),
	)
	if w.Registered != nil {
		go w.Registered(ctx, id)
	}

	for {
		select {
		case <-ctx.Done():
			w.drain()
			return nil
		case <-w.clock.After(w.cfg.Heartbeat):
			if err := w.reg.Heartbeat(ctx, w.cfg.Name); err != nil {
				// A heartbeat miss is a database blip, not a reason to die:
				// the next tick retries, and the read side's liveness window
				// (3 intervals) absorbs it.
				w.log.Warn("heartbeat failed",
					slog.String("worker", w.cfg.Name),
					slog.String("error", err.Error()),
				)
			}
		}
	}
}

// drain performs the shutdown transitions on a context detached from the
// already-cancelled run context, bounded by DrainTimeout. Failures are
// logged, never returned: the process is exiting either way, and the read
// side will report the row offline once its heartbeat goes stale.
func (w *Worker) drain() {
	dctx, cancel := context.WithTimeout(context.Background(), w.cfg.DrainTimeout)
	defer cancel()

	w.log.Info("draining",
		slog.String("worker", w.cfg.Name),
		slog.String("deadline", w.cfg.DrainTimeout.String()),
	)
	if err := w.reg.SetStatus(dctx, w.cfg.Name, StatusDraining); err != nil {
		w.log.Error("mark draining failed",
			slog.String("worker", w.cfg.Name), slog.String("error", err.Error()))
	}

	if w.Drain != nil {
		if err := w.Drain(dctx); err != nil {
			w.log.Error("drain hook failed",
				slog.String("worker", w.cfg.Name), slog.String("error", err.Error()))
		}
	}

	if err := w.reg.SetStatus(dctx, w.cfg.Name, StatusOffline); err != nil {
		w.log.Error("mark offline failed",
			slog.String("worker", w.cfg.Name), slog.String("error", err.Error()))
		return
	}
	w.log.Info("worker offline", slog.String("worker", w.cfg.Name))
}
