package postgres

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// pingTimeout bounds the connectivity check performed by Open and by the
// migration helpers.
const pingTimeout = 5 * time.Second

// The M4 lab wedge (gh-loop 2026-10-25) is the reason every connection this
// pool opens carries two server-side bounds. One serve replica parked a
// transaction — holding the per-project journal advisory lock, plus a
// FOR UPDATE row lock chain downstream — while its goroutine blocked in
// application code with no deadline: BeginAttempt writers, the m4 driver's
// lease-expiry pass and the issue-trigger tick all queued behind that pin
// for hours, and nothing in the process could cut the waiter loose.
//
//   - idle_in_transaction_session_timeout kills a transaction whose client
//     stopped speaking at all. No correct use of this pool holds a
//     transaction open idle for 30 s: every transaction here is a short,
//     scripted write, and the M4 spec's recovery rules (§ 02 recovery,
//     ADR-0016 § 4's "zero replicas only delay detection") all assume a
//     wedged writer eventually stops being one. 30 s is two orders of
//     magnitude above the slowest observed in-transaction gap and one below
//     the point where "eventually" stops meaning anything.
//   - statement_timeout bounds one statement, which includes every
//     lock-wait: the lab's reclaim UPDATE waited 90 minutes for a row lock.
//     Every caller treats a failed statement as retryable backstop work
//     (driver tick, reconciler pass, ticker loop), so a refused statement
//     delays reconciliation by one tick instead of ending it.
const (
	idleInTransactionTimeout = 30 * time.Second
	statementTimeout         = 60 * time.Second
)

// Open parses databaseURL, creates a pgx connection pool and verifies
// connectivity with a ping bounded by a 5 second timeout. Errors never
// include the connection string or its password.
func Open(ctx context.Context, databaseURL string) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, errors.New("postgres: invalid database URL")
	}
	// Server-side bounds on every connection, so a wedged client can never
	// pin a lock past its own liveness (see the constants above). An explicit
	// URL parameter (options=...-c statement_timeout=...) still wins: parse
	// only fills what is unset.
	if cfg.ConnConfig.RuntimeParams == nil {
		cfg.ConnConfig.RuntimeParams = map[string]string{}
	}
	if _, ok := cfg.ConnConfig.RuntimeParams["idle_in_transaction_session_timeout"]; !ok {
		cfg.ConnConfig.RuntimeParams["idle_in_transaction_session_timeout"] =
			strconv.FormatInt(idleInTransactionTimeout.Milliseconds(), 10)
	}
	if _, ok := cfg.ConnConfig.RuntimeParams["statement_timeout"]; !ok {
		cfg.ConnConfig.RuntimeParams["statement_timeout"] =
			strconv.FormatInt(statementTimeout.Milliseconds(), 10)
	}
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("postgres: create connection pool: %w", scrub(err, databaseURL))
	}
	pingCtx, cancel := context.WithTimeout(ctx, pingTimeout)
	defer cancel()
	if err := pool.Ping(pingCtx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("postgres: ping database: %w", scrub(err, databaseURL))
	}
	return pool, nil
}

// scrub removes the connection-string password from an error's message so
// wrapped errors are safe to log or return to operators.
func scrub(err error, databaseURL string) error {
	if err == nil {
		return nil
	}
	msg := err.Error()
	if u, parseErr := url.Parse(databaseURL); parseErr == nil && u.User != nil {
		if pw, has := u.User.Password(); has && pw != "" {
			msg = strings.ReplaceAll(msg, pw, "xxxxx")
		}
	}
	return errors.New(msg)
}
