package postgres

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// pingTimeout bounds the connectivity check performed by Open and by the
// migration helpers.
const pingTimeout = 5 * time.Second

// Open parses databaseURL, creates a pgx connection pool and verifies
// connectivity with a ping bounded by a 5 second timeout. Errors never
// include the connection string or its password.
func Open(ctx context.Context, databaseURL string) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, errors.New("postgres: invalid database URL")
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
