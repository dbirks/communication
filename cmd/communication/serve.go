package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dbirks/communication/internal/api"
	"github.com/dbirks/communication/internal/store/postgres"
	"github.com/dbirks/communication/ui"
)

const serveUsage = `usage: communication serve

runs the control plane HTTP API and the embedded UI on the same origin
(communication-spec/02-system-architecture.md, ADR-0007, ADR-0012).

environment:
  COMMUNICATION_DATABASE_URL   required, postgres connection string
  COMMUNICATION_LISTEN_ADDR    listen address (default ":8080")
  COMMUNICATION_PUBLIC_URL     required, browser-facing base URL
  COMMUNICATION_REPLICA_NAME   replica id (default: hostname)

migrations are applied separately: communication migrate up
`

// Timing knobs for serve. The pool retry window exists so a replica started
// by compose alongside Postgres waits for the database instead of crash
// looping; readiness reports 503 for the whole window, so the load balancer
// keeps it out of rotation.
const (
	dbDialTimeout     = 60 * time.Second
	dbDialInterval    = 2 * time.Second
	shutdownTimeout   = 15 * time.Second
	readHeaderTimeout = 10 * time.Second
)

// runServe implements the "serve" mode. Exit codes: 0 clean shutdown,
// 2 configuration error, 1 runtime error.
func runServe(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	for _, a := range args {
		if a == "-h" || a == "--help" || a == "help" {
			fmt.Fprint(stdout, serveUsage)
			return 0
		}
	}

	databaseURL := os.Getenv("COMMUNICATION_DATABASE_URL")
	if databaseURL == "" {
		fmt.Fprintln(stderr, "COMMUNICATION_DATABASE_URL is not set")
		return 2
	}
	publicURL := os.Getenv("COMMUNICATION_PUBLIC_URL")
	if publicURL == "" {
		fmt.Fprintln(stderr, "COMMUNICATION_PUBLIC_URL is not set")
		return 2
	}
	listenAddr := os.Getenv("COMMUNICATION_LISTEN_ADDR")
	if listenAddr == "" {
		listenAddr = ":8080"
	}
	replica := os.Getenv("COMMUNICATION_REPLICA_NAME")
	if replica == "" {
		if host, err := os.Hostname(); err == nil && host != "" {
			replica = host
		} else {
			replica = "communication"
		}
	}

	// Structured JSON logs on stderr, every record labelled with the replica
	// so interleaved compose logs stay attributable.
	log := slog.New(slog.NewJSONHandler(stderr, nil)).With(slog.String("replica", replica))

	ctx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()

	pool, err := openPool(ctx, databaseURL, log)
	if err != nil {
		stop()
		log.Error("database unavailable", slog.String("error", err.Error()))
		return 1
	}
	defer pool.Close()

	ln, err := net.Listen("tcp", listenAddr)
	if err != nil {
		stop()
		log.Error("listen failed", slog.String("addr", listenAddr), slog.String("error", err.Error()))
		return 1
	}

	var webUI fs.FS
	if ui.Built() {
		webUI = ui.Dist()
	}

	handler := api.New(
		api.Config{
			ReplicaName: replica,
			Version:     version,
			PublicURL:   publicURL,
			Logger:      log,
		},
		dbReadiness{pool: pool, url: databaseURL},
		serveAuthenticator(),
		webUI,
	)

	srv := &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: readHeaderTimeout,
	}

	serveErr := make(chan error, 1)
	go func() {
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serveErr <- err
			return
		}
		serveErr <- nil
	}()
	log.Info("serving",
		slog.String("addr", listenAddr),
		slog.String("public_url", publicURL),
		slog.String("version", version),
		slog.Bool("ui_built", ui.Built()),
	)

	select {
	case err := <-serveErr:
		if err != nil {
			stop()
			log.Error("server stopped", slog.String("error", err.Error()))
			return 1
		}
		return 0
	case <-ctx.Done():
	}

	// Graceful shutdown: drain in-flight requests, then close the pool. The
	// deadline hangs off Background because ctx is already cancelled.
	log.Info("shutting down", slog.String("deadline", shutdownTimeout.String()))
	drainCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()
	if err := srv.Shutdown(drainCtx); err != nil {
		log.Error("shutdown incomplete", slog.String("error", err.Error()))
		stop()
		return 1
	}
	log.Info("stopped")
	return 0
}

// openPool opens the Postgres pool, retrying every dbDialInterval for up to
// dbDialTimeout so a replica can start alongside a still-initialising
// database. Warnings are one line each and never contain the connection
// string (postgres.Open scrubs it).
func openPool(ctx context.Context, databaseURL string, log *slog.Logger) (*pgxpool.Pool, error) {
	deadline := time.Now().Add(dbDialTimeout)
	for attempt := 1; ; attempt++ {
		pool, err := postgres.Open(ctx, databaseURL)
		if err == nil {
			if attempt > 1 {
				log.Info("database available", slog.Int("attempts", attempt))
			}
			return pool, nil
		}
		if ctxErr := ctx.Err(); ctxErr != nil {
			return nil, ctxErr
		}
		if time.Now().After(deadline) {
			return nil, errors.New("database unreachable after " + dbDialTimeout.String())
		}
		log.Warn("waiting for database",
			slog.Int("attempt", attempt),
			slog.String("error", err.Error()),
		)
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(dbDialInterval):
		}
	}
}

// dbReadiness adapts the connection pool to api.Readiness: liveness of the
// datastore comes from the pool, the schema version from a dedicated
// connection so a saturated pool cannot mask a pending migration.
type dbReadiness struct {
	pool *pgxpool.Pool
	url  string
}

// Ping reports whether the datastore is reachable.
func (d dbReadiness) Ping(ctx context.Context) error { return d.pool.Ping(ctx) }

// SchemaVersion returns the applied migration version, or an error when the
// database cannot be read.
func (d dbReadiness) SchemaVersion(ctx context.Context) (int64, error) {
	return postgres.SchemaVersion(ctx, d.url)
}

// ExpectedSchemaVersion returns the schema version this binary requires.
func (d dbReadiness) ExpectedSchemaVersion() int64 { return postgres.ExpectedSchemaVersion() }

// serveAuthenticator builds this replica's Authenticator.
//
// M1 wiring: replaced by internal/api/auth in the next task. Until session
// lookup exists every request is rejected as unauthenticated, so health and
// readiness are the only endpoints that answer.
func serveAuthenticator() api.Authenticator {
	return api.AuthenticatorFunc(func(*http.Request) (*api.Principal, error) {
		return nil, api.ErrUnauthenticated
	})
}
