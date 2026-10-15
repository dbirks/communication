package postgres

// The turn-lease reconciler (ADR-0016 §4).
//
// It exists because a worker that dies cannot report its own outcome, and
// communication-spec/02-system-architecture.md refuses to let anybody else
// claim that it did. So this writes the *honest* terminal state — `interrupted`,
// no stop reason, a reason string naming who decided (a deadline, not the dead
// process) — and nothing else: it never completes, never retries, never
// re-attaches a session. Re-attaching is what the *next* turn does, visibly.
//
// It runs inside `communication serve`, one replica at a time, guarded by a
// Postgres session advisory lock taken with pg_try_advisory_lock on a dedicated
// connection. A replica that cannot take the lock skips the tick: many replicas
// are therefore safe, and zero replicas only delay detection — they cannot lose
// data, because every input to a pass is a row with a deadline already past.
//
// The lock is session-scoped and taken explicitly *around* the per-turn
// transactions rather than inside them, which is what the ADR means by "held for
// the duration of the pass": a transaction-scoped lock would be released after
// the first turn and let a second replica interleave with the first.

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

	"github.com/dbirks/communication/internal/events"
)

// ReconcilerConfig configures a Reconciler. Zero values select the ADR's
// numbers, so production wiring cannot accidentally invent its own timing.
type ReconcilerConfig struct {
	// Interval is how often a pass runs. ADR-0016 §4 pins 5 s.
	Interval time.Duration
	// LeaseSafety is how much slack a lease deadline gets before the turn is
	// declared expired. It exists because the reconciler and a renewing worker
	// race by design: a deadline 30 s out and a pass that reads it 1 ms early is
	// still a 30 s lease. Zero selects the default.
	LeaseSafety time.Duration
	// WorkerHeartbeat is the workers' heartbeat interval; a bound session whose
	// worker has been silent for 3 of them is gone (the same liveness rule
	// internal/store/postgres/worker_registry.go applies to reads).
	WorkerHeartbeat time.Duration
	// Batch caps how many rows one pass touches, so a backlog drains over
	// several ticks instead of holding the lock indefinitely.
	Batch int
	// Logger receives one line per pass; nil discards them.
	Logger *slog.Logger
	// Now is the clock seam for tests; nil means time.Now.
	Now func() time.Time
}

const (
	rcnDefaultInterval         = 5 * time.Second
	rcnDefaultLeaseSafety      = 5 * time.Second
	rcnDefaultWorkerHeartbeat  = 10 * time.Second
	rcnDefaultBatch            = 50
	rcnWorkerLivenessIntervals = 3
)

// rcnAdvisoryLockKey is the ADR-pinned namespace of the reconciler's advisory
// lock. It is hashed the same way the journal's append lock is, so both use one
// mechanism (ADR-0014 §9) without sharing a key space.
const rcnAdvisoryLockKey = "communication.reconciler.turn_leases"

// Reconciler turns expired leases, vanished workers and unanswered prompts into
// durable, honest state. A *Reconciler is safe for one goroutine; run it once
// per replica.
type Reconciler struct {
	pool *pgxpool.Pool
	cfg  ReconcilerConfig
	log  *slog.Logger

	mu sync.Mutex
	// lastHeld records whether this replica has ever taken the lock, so the log
	// says "locked out" once per transition instead of once per tick.
	lastHeld bool
}

// ReconcileResult reports what one pass changed. It exists for tests and for the
// log line, and it is deliberately not exported to any API: an operator reads
// the events it produced, not a counter endpoint that would drift from them.
type ReconcileResult struct {
	// Acquired is false when another replica holds the advisory lock and the
	// pass was skipped.
	Acquired bool
	// TurnsInterrupted counts leased/running turns whose lease had expired.
	TurnsInterrupted int
	// SessionsDisconnected counts live bindings whose worker went silent.
	SessionsDisconnected int
	// PermissionsExpired counts prompts nobody answered in time.
	PermissionsExpired int
}

// NewReconciler builds a reconciler over an open pool.
func NewReconciler(pool *pgxpool.Pool, cfg ReconcilerConfig) *Reconciler {
	if cfg.Interval <= 0 {
		cfg.Interval = rcnDefaultInterval
	}
	if cfg.LeaseSafety <= 0 {
		cfg.LeaseSafety = rcnDefaultLeaseSafety
	}
	if cfg.WorkerHeartbeat <= 0 {
		cfg.WorkerHeartbeat = rcnDefaultWorkerHeartbeat
	}
	if cfg.Batch <= 0 {
		cfg.Batch = rcnDefaultBatch
	}
	log := cfg.Logger
	if log == nil {
		log = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	return &Reconciler{pool: pool, cfg: cfg, log: log}
}

// rcnIsShutdown reports whether a failing pass was really just the tick losing
// the race with shutdown. A pass cut short by a cancelled context or a closing
// pool has not failed at anything: the database did not refuse the work, the
// process asked for it to stop. Reporting it as a failing pass would tell an
// operator "the reconciler gave up after N failing passes" at the exact moment
// they shut it down on purpose — and it made the M2 lab's own tick test flaky.
func rcnIsShutdown(ctx context.Context, err error) bool {
	if ctx.Err() != nil {
		return true
	}
	return errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded)
}

// Run passes every configured interval until ctx ends, and returns the number of
// passes that actually acquired the lock — which lets a shutdown log line tell
// "this replica was locked out the whole time" from "this replica found nothing
// to do", a difference an operator otherwise reads backwards.
//
// A failing pass is logged and retried on the next tick rather than ending Run.
// The reason is the nature of the work: every input to a pass is a row whose
// deadline has already passed, so a database that refuses one tick has not made
// the reconciliation wrong, only late — and a reconciler that exited on a blip
// would leave expired leases uninterruptible until someone restarted the
// replica, which is precisely the silent hole ADR-0016 §4 exists to close. The
// error still escalates: consecutive failures are reported with their count, so
// a permanent problem is visible as a rising number instead of as silence.
func (r *Reconciler) Run(ctx context.Context) (int, error) {
	if r == nil || r.pool == nil {
		return 0, errors.New("postgres: reconciler has no pool")
	}
	ticker := time.NewTicker(r.cfg.Interval)
	defer ticker.Stop()

	ran, failed := 0, 0
	for {
		select {
		case <-ctx.Done():
			if failed > 0 {
				return ran, fmt.Errorf("postgres: turn-lease reconciler gave up after %d failing passes", failed)
			}
			return ran, nil
		case <-ticker.C:
			res, err := r.Pass(ctx)
			if err != nil {
				if rcnIsShutdown(ctx, err) {
					// Shutdown, not a failing pass: exit with whatever the earlier
					// ticks really did or really did not do.
					if failed > 0 {
						return ran, fmt.Errorf("postgres: turn-lease reconciler gave up after %d failing passes", failed)
					}
					return ran, nil
				}
				failed++
				r.log.ErrorContext(ctx, "turn-lease reconciler pass failed; retrying next tick",
					slog.Int("consecutive_failures", failed),
					slog.String("error", err.Error()))
				continue
			}
			failed = 0
			if res.Acquired {
				ran++
				if res.TurnsInterrupted+res.SessionsDisconnected+res.PermissionsExpired > 0 {
					r.log.InfoContext(ctx, "turn-lease reconciler pass",
						slog.Int("turns_interrupted", res.TurnsInterrupted),
						slog.Int("sessions_disconnected", res.SessionsDisconnected),
						slog.Int("permissions_expired", res.PermissionsExpired))
				}
			}
		}
	}
}

// Pass runs one reconciler pass under the advisory lock. A nil error with
// Acquired == false is the normal answer on a replica that is not the leader.
func (r *Reconciler) Pass(ctx context.Context) (ReconcileResult, error) {
	var out ReconcileResult
	if r == nil || r.pool == nil {
		return out, errors.New("postgres: reconciler has no pool")
	}

	conn, err := r.pool.Acquire(ctx)
	if err != nil {
		return out, fmt.Errorf("postgres: acquire reconciler connection: %w", err)
	}
	defer conn.Release()

	held, err := rcnTryLock(ctx, conn.Conn())
	if err != nil {
		return out, err
	}
	r.noteLeadership(held)
	if !held {
		return out, nil
	}
	defer func() {
		if _, err := rcnUnlock(ctx, conn.Conn()); err != nil {
			r.log.WarnContext(ctx, "could not release reconciler lock",
				slog.String("error", err.Error()))
		}
	}()

	out.Acquired = true
	var errs []error
	n, err := r.interruptExpiredTurns(ctx, conn.Conn())
	out.TurnsInterrupted = n
	errs = append(errs, err)
	n, err = r.disconnectStaleBindings(ctx, conn.Conn())
	out.SessionsDisconnected = n
	errs = append(errs, err)
	n, err = r.expireStalePermissions(ctx, conn.Conn())
	out.PermissionsExpired = n
	errs = append(errs, err)
	return out, errors.Join(errs...)
}

func (r *Reconciler) noteLeadership(held bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	// Wording matters: both replicas log this line, because leadership moves as
	// each pass releases the lock. It claims only what happened — this replica
	// got the lock at least once — and "standing down" is the matching half.
	// One line per acquisition *transition*, worded as the event it is. Both
	// replicas will log it: the lock is released at the end of every pass, so
	// leadership alternates, and a message claiming "active" on each of them
	// would read as two leaders to an operator.
	if held && !r.lastHeld {
		r.log.Info("turn-lease reconciler acquired the advisory lock",
			slog.String("interval", r.cfg.Interval.String()),
			slog.String("lease_safety", r.cfg.LeaseSafety.String()))
	}
	if !held && r.lastHeld {
		r.log.Debug("turn-lease reconciler skipped a pass: another replica holds the lock")
	}
	r.lastHeld = held
}

// rcnTryLock takes the session-scoped advisory lock on this connection.
func rcnTryLock(ctx context.Context, conn *pgx.Conn) (bool, error) {
	var held bool
	if err := conn.QueryRow(ctx,
		`SELECT pg_try_advisory_lock(hashtextextended($1, 0))`, rcnAdvisoryLockKey).Scan(&held); err != nil {
		return false, fmt.Errorf("postgres: try reconciler lock: %w", err)
	}
	return held, nil
}

// rcnUnlock releases the lock. The connection is only returned to the pool by
// the caller's defer, and pgx resets session state on release, so a lock that
// outlived a crash could only ever be held by a live connection.
func rcnUnlock(ctx context.Context, conn *pgx.Conn) (int64, error) {
	var freed bool
	if err := conn.QueryRow(ctx,
		`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, rcnAdvisoryLockKey).Scan(&freed); err != nil {
		return 0, fmt.Errorf("postgres: unlock reconciler lock: %w", err)
	}
	if !freed {
		return 0, fmt.Errorf("postgres: reconciler unlock: the lock was not held")
	}
	return 1, nil
}

// --- pass 1: expired turn leases ---------------------------------------

// rcnExpiredTurnsSQL selects leased/running turns whose lease is past, plus the
// scope the journal row needs. The safety margin is applied here rather than in
// Go so the decision is made by the clock that the deadline was written with.
const rcnExpiredTurnsSQL = `
	SELECT t.id, t.conversation_id, c.project_id, p.organization_id,
	       COALESCE(t.worker_id::text, ''), t.fencing_token, t.status
	FROM conversation_turns t
	JOIN conversations c ON c.id = t.conversation_id
	JOIN projects p ON p.id = c.project_id
	WHERE t.status IN ('leased', 'running')
	  AND t.lease_expires_at IS NOT NULL
	  AND t.lease_expires_at < now() - make_interval(secs => $1::double precision)
	ORDER BY t.lease_expires_at, t.id
	LIMIT $2::int`

// interruptExpiredTurns marks each expired turn interrupted, in its own
// transaction with its own journal row (ADR-0016 §4: one transaction per
// affected turn). The final UPDATE re-checks status and deadline, so a worker
// that renewed at the last moment keeps its turn: the reconciler only ever
// writes state it can prove, and a lost race means it did nothing.
func (r *Reconciler) interruptExpiredTurns(ctx context.Context, conn *pgx.Conn) (int, error) {
	type expired struct {
		turnID, conversationID, projectID, orgID, workerID, status string
		token                                                      int64
	}
	secs := r.cfg.LeaseSafety.Seconds()
	rows, err := conn.Query(ctx, rcnExpiredTurnsSQL, secs, r.cfg.Batch)
	if err != nil {
		return 0, fmt.Errorf("postgres: scan expired turns: %w", err)
	}
	var found []expired
	for rows.Next() {
		var e expired
		if err := rows.Scan(&e.turnID, &e.conversationID, &e.projectID, &e.orgID,
			&e.workerID, &e.token, &e.status); err != nil {
			rows.Close()
			return 0, fmt.Errorf("postgres: read expired turn: %w", err)
		}
		found = append(found, e)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, fmt.Errorf("postgres: expired turn scan: %w", err)
	}

	done := 0
	for _, e := range found {
		if ctx.Err() != nil {
			return done, ctx.Err()
		}
		marked, err := r.withTx(ctx, conn, func(tx pgx.Tx) (bool, error) {
			var status string
			err := tx.QueryRow(ctx, `
				SELECT status FROM conversation_turns WHERE id = $1::uuid FOR UPDATE`, e.turnID).Scan(&status)
			if errors.Is(err, pgx.ErrNoRows) {
				return false, nil
			}
			if err != nil {
				return false, fmt.Errorf("postgres: lock turn: %w", err)
			}
			if status != events.TurnStatusLeased && status != events.TurnStatusRunning {
				return false, nil
			}
			tag, err := tx.Exec(ctx, `
				UPDATE conversation_turns
				SET status = 'interrupted', finished_at = now()
				WHERE id = $1::uuid
				  AND status IN ('leased', 'running')
				  AND lease_expires_at < now() - make_interval(secs => $2::double precision)`,
				e.turnID, secs)
			if err != nil {
				return false, fmt.Errorf("postgres: interrupt turn: %w", err)
			}
			if tag.RowsAffected() == 0 {
				// The lease was renewed between the scan and the lock. Saying so
				// is the difference between a reconciler that guesses and one
				// that proves.
				return false, nil
			}
			if _, err := AppendEvent(ctx, tx, events.New{
				Type:           events.TypeConversationTurnInterrupted,
				OrganizationID: e.orgID,
				ProjectID:      e.projectID,
				ConversationID: e.conversationID,
				// The reconciler acts for nobody: 'system' is the only honest actor
				// for a write whose author is a deadline.
				Actor: events.Actor{Kind: events.ActorKindSystem, ID: "system"},
				Payload: events.TurnInterruptedPayload{
					ConversationID: e.conversationID,
					TurnID:         e.turnID,
					WorkerID:       e.workerID,
					FencingToken:   e.token,
					Reason:         events.InterruptLeaseExpired,
				},
			}); err != nil {
				return false, err
			}
			// A conversation whose worker vanished is disconnected, not idle:
			// the transcript's owner is gone with a turn still open (ADR-0016 §4.2
			// records the same transition for the binding pass; a turn whose
			// lease died deserves it even if no binding row survived).
			if _, err := tx.Exec(ctx, `
				UPDATE conversations
				SET status = CASE WHEN status = 'active' THEN 'disconnected' ELSE status END,
				    updated_at = now()
				WHERE id = $1::uuid`, e.conversationID); err != nil {
				return false, fmt.Errorf("postgres: mark conversation disconnected: %w", err)
			}
			r.log.InfoContext(ctx, "turn lease expired",
				slog.String("turn_id", e.turnID),
				slog.String("conversation_id", e.conversationID),
				slog.String("worker_id", e.workerID),
				slog.Int64("fencing_token", e.token))
			return true, nil
		})
		if err != nil {
			return done, err
		}
		if marked {
			done++
		}
	}
	return done, nil
}

// --- pass 2: workers that stopped proving they are alive ---------------

// rcnStaleBindingsSQL selects live session bindings whose worker heartbeat is
// older than 3 intervals, which is the read-side liveness rule of
// WorkerRegistry.ListWorkersWithLiveness restated as a predicate.
const rcnStaleBindingsSQL = `
	SELECT b.id, b.conversation_id, b.worker_id, COALESCE(b.acp_session_id, ''),
	       c.project_id, p.organization_id
	FROM acp_session_bindings b
	JOIN workers w ON w.id = b.worker_id
	JOIN conversations c ON c.id = b.conversation_id
	JOIN projects p ON p.id = c.project_id
	WHERE b.status = 'connected'
	  AND (w.status = 'offline'
	       OR w.last_heartbeat_at < now() - make_interval(secs => $1::double precision))
	ORDER BY b.last_seen_at, b.id
	LIMIT $2::int`

func (r *Reconciler) disconnectStaleBindings(ctx context.Context, conn *pgx.Conn) (int, error) {
	type stale struct {
		bindingID, conversationID, workerID, sessionID, projectID, orgID string
	}
	window := r.cfg.WorkerHeartbeat * rcnWorkerLivenessIntervals
	rows, err := conn.Query(ctx, rcnStaleBindingsSQL, window.Seconds(), r.cfg.Batch)
	if err != nil {
		return 0, fmt.Errorf("postgres: scan stale bindings: %w", err)
	}
	var found []stale
	for rows.Next() {
		var s stale
		if err := rows.Scan(&s.bindingID, &s.conversationID, &s.workerID, &s.sessionID,
			&s.projectID, &s.orgID); err != nil {
			rows.Close()
			return 0, fmt.Errorf("postgres: read stale binding: %w", err)
		}
		found = append(found, s)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, fmt.Errorf("postgres: stale binding scan: %w", err)
	}

	done := 0
	for _, s := range found {
		if ctx.Err() != nil {
			return done, ctx.Err()
		}
		marked, err := r.withTx(ctx, conn, func(tx pgx.Tx) (bool, error) {
			tag, err := tx.Exec(ctx, `
				UPDATE acp_session_bindings
				SET status = 'disconnected', disconnected_at = now(), last_seen_at = now()
				WHERE id = $1::uuid AND status = 'connected'`, s.bindingID)
			if err != nil {
				return false, fmt.Errorf("postgres: disconnect binding: %w", err)
			}
			if tag.RowsAffected() == 0 {
				return false, nil
			}
			if _, err := AppendEvent(ctx, tx, events.New{
				Type:           events.TypeAgentSessionDisconnected,
				OrganizationID: s.orgID,
				ProjectID:      s.projectID,
				ConversationID: s.conversationID,
				Actor:          events.Actor{Kind: events.ActorKindSystem, ID: "system"},
				Payload: events.SessionDisconnectedPayload{
					ConversationID: s.conversationID,
					BindingID:      s.bindingID,
					WorkerID:       s.workerID,
					ACPSessionID:   s.sessionID,
					Reason:         events.InterruptWorkerGone,
				},
			}); err != nil {
				return false, err
			}
			if _, err := tx.Exec(ctx, `
				UPDATE conversations
				SET status = CASE WHEN status IN ('active', 'idle') THEN 'disconnected' ELSE status END,
				    updated_at = now()
				WHERE id = $1::uuid`, s.conversationID); err != nil {
				return false, fmt.Errorf("postgres: mark conversation disconnected: %w", err)
			}
			r.log.InfoContext(ctx, "agent session lost with its worker",
				slog.String("binding_id", s.bindingID),
				slog.String("conversation_id", s.conversationID),
				slog.String("worker_id", s.workerID))
			return true, nil
		})
		if err != nil {
			return done, err
		}
		if marked {
			done++
		}
	}
	return done, nil
}

// --- pass 3: prompts nobody will answer anymore ------------------------

const rcnExpiredPermissionsSQL = `
	SELECT pr.id, pr.conversation_id, pr.turn_id, c.project_id, p.organization_id
	FROM permission_requests pr
	JOIN conversations c ON c.id = pr.conversation_id
	JOIN projects p ON p.id = c.project_id
	WHERE pr.status = 'pending'
	  AND pr.deadline_at IS NOT NULL
	  AND pr.deadline_at < now()
	ORDER BY pr.deadline_at, pr.id
	LIMIT $1::int`

// expireStalePermissions closes prompts whose deadline passed. The row becomes
// `expired` and the event carries neither decided_by nor decision_option_id:
// nobody answered, and permission_request_decision_is_answered makes any other
// shape a constraint violation rather than a bug (ADR-0016 Security).
func (r *Reconciler) expireStalePermissions(ctx context.Context, conn *pgx.Conn) (int, error) {
	type prompt struct {
		id, conversationID, turnID, projectID, orgID string
	}
	rows, err := conn.Query(ctx, rcnExpiredPermissionsSQL, r.cfg.Batch)
	if err != nil {
		return 0, fmt.Errorf("postgres: scan expired permissions: %w", err)
	}
	var found []prompt
	for rows.Next() {
		var p prompt
		if err := rows.Scan(&p.id, &p.conversationID, &p.turnID, &p.projectID, &p.orgID); err != nil {
			rows.Close()
			return 0, fmt.Errorf("postgres: read expired permission: %w", err)
		}
		found = append(found, p)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, fmt.Errorf("postgres: expired permission scan: %w", err)
	}

	done := 0
	for _, p := range found {
		if ctx.Err() != nil {
			return done, ctx.Err()
		}
		marked, err := r.withTx(ctx, conn, func(tx pgx.Tx) (bool, error) {
			tag, err := tx.Exec(ctx, `
				UPDATE permission_requests
				SET status = 'expired'
				WHERE id = $1::uuid AND status = 'pending'`, p.id)
			if err != nil {
				return false, fmt.Errorf("postgres: expire permission request: %w", err)
			}
			if tag.RowsAffected() == 0 {
				return false, nil
			}
			if _, err := AppendEvent(ctx, tx, events.New{
				Type:           events.TypeConversationPermissionDecided,
				OrganizationID: p.orgID,
				ProjectID:      p.projectID,
				ConversationID: p.conversationID,
				Actor:          events.Actor{Kind: events.ActorKindSystem, ID: "system"},
				Payload: events.PermissionDecidedPayload{
					ConversationID:      p.conversationID,
					TurnID:              p.turnID,
					PermissionRequestID: p.id,
					Status:              events.PermissionStatusExpired,
				},
			}); err != nil {
				return false, err
			}
			r.log.InfoContext(ctx, "permission request expired",
				slog.String("permission_request_id", p.id),
				slog.String("turn_id", p.turnID))
			return true, nil
		})
		if err != nil {
			return done, err
		}
		if marked {
			done++
		}
	}
	return done, nil
}

// --- plumbing -----------------------------------------------------------

// withTx runs fn in a transaction on conn — the same connection that holds the
// session advisory lock. That is not an optimization: the lock protects the
// pass only while every write of the pass is attributable to the locked session,
// and a transaction from the general pool could run on a connection this replica
// locked a moment ago and a moment later does not.
func (r *Reconciler) withTx(ctx context.Context, conn *pgx.Conn, fn func(tx pgx.Tx) (bool, error)) (bool, error) {
	tx, err := conn.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return false, fmt.Errorf("postgres: begin reconciler transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	done, err := fn(tx)
	if err != nil {
		return false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return false, fmt.Errorf("postgres: commit reconciler transaction: %w", err)
	}
	return done, nil
}

// ReconcilerHealth answers the one question an operator actually has — is a
// reconciler lease-holder anywhere in this deployment? — by trying to take the
// lock on a throwaway connection: if the attempt succeeds, nobody was holding
// it (and the probe immediately releases it again).
//
// This deliberately does not read pg_locks. An advisory key taken with the
// one-argument form is stored as an (classid, objid) pair of 32-bit oids, so a
// query that compares a 64-bit hashtextextended result against objid fails
// outright with "OID out of range", and a query that split the key correctly
// would still only see this database instance's locks. Asking Postgres the
// question in the same language the reconciler uses cannot drift from it.
func (r *Reconciler) ReconcilerHealth(ctx context.Context) (leaderPresent bool, err error) {
	if r == nil || r.pool == nil {
		return false, errors.New("postgres: reconciler has no pool")
	}
	conn, err := r.pool.Acquire(ctx)
	if err != nil {
		return false, fmt.Errorf("postgres: acquire health probe connection: %w", err)
	}
	defer conn.Release()

	held, err := rcnTryLock(ctx, conn.Conn())
	if err != nil {
		return false, err
	}
	if !held {
		return true, nil
	}
	if _, err := rcnUnlock(ctx, conn.Conn()); err != nil {
		return false, err
	}
	return false, nil
}
