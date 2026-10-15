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
	"strings"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dbirks/communication/internal/api"
	"github.com/dbirks/communication/internal/api/auth"
	"github.com/dbirks/communication/internal/store/postgres"
	"github.com/dbirks/communication/ui"
)

const serveUsage = `usage: communication serve

runs the control plane HTTP API and the embedded UI on the same origin
(communication-spec/02-system-architecture.md, ADR-0007, ADR-0012).

environment:
  COMMUNICATION_DATABASE_URL            required, postgres connection string
  COMMUNICATION_LISTEN_ADDR             listen address (default ":8080")
  COMMUNICATION_PUBLIC_URL              required, browser-facing base URL
  COMMUNICATION_REPLICA_NAME            replica id (default: hostname)
  COMMUNICATION_OIDC_ISSUER             required, issuer used for discovery/tokens
  COMMUNICATION_OIDC_BROWSER_ISSUER     issuer prefix browsers are redirected to
  COMMUNICATION_OIDC_CLIENT_ID          required, OAuth2 client id
  COMMUNICATION_OIDC_CLIENT_SECRET      optional; empty means public + PKCE
  COMMUNICATION_BOOTSTRAP_ADMIN_SUBJECTS  OIDC subjects that become org admins
  COMMUNICATION_COOKIE_SECURE           Secure cookie flag (default "true")
  COMMUNICATION_WORKER_HEARTBEAT        optional; must match the workers' own
                                        heartbeat interval, because it sets how
                                        long a worker may be silent before
                                        GET /api/v1/workers reports it offline
                                        (default "10s", same as worker mode)

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
	authCfg, err := auth.ConfigFromEnv()
	if err != nil {
		// The login path cannot work without these, and a replica that starts
		// and then 503s every sign-in is harder to diagnose than one that
		// refuses to start (ADR-0012 §2).
		fmt.Fprintln(stderr, err)
		return 2
	}
	workerHeartbeat, err := serveWorkerHeartbeat(os.Getenv)
	if err != nil {
		// A heartbeat the read side cannot parse would silently fall back to the
		// default window and report live workers as offline.
		fmt.Fprintln(stderr, err)
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

	handler, closeStack, err := serveStack(serveStackDeps{
		Pool:            pool,
		DatabaseURL:     databaseURL,
		Auth:            authCfg,
		WorkerHeartbeat: workerHeartbeat,
		API: api.Config{
			ReplicaName: replica,
			Version:     version,
			PublicURL:   publicURL,
			Logger:      log,
		},
		Readiness: dbReadiness{pool: pool, url: databaseURL},
		UI:        webUI,
		Logger:    log,
	})
	if err != nil {
		stop()
		log.Error("server configuration failed", slog.String("error", err.Error()))
		return 2
	}
	defer closeStack()

	srv := &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: readHeaderTimeout,
	}
	// A graceful shutdown must not wait on SSE streams that only end when their
	// client leaves: closing the wake-up source ends every open stream, which is
	// also how a restarting replica hands its browsers to another replica (they
	// reconnect with Last-Event-ID and lose nothing).
	srv.RegisterOnShutdown(closeStack)

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

// serveStackDeps is everything a serving replica needs: an open pool, the
// identity configuration and the API/HTTP configuration. It is a struct so a
// test can build the exact handler production runs without opening a socket.
type serveStackDeps struct {
	Pool        *pgxpool.Pool
	DatabaseURL string
	Auth        auth.Config
	API         api.Config
	Readiness   api.Readiness
	UI          fs.FS
	Logger      *slog.Logger

	// WorkerHeartbeat is the workers' heartbeat interval, used only to decide
	// when GET /api/v1/workers reports a silent worker as offline. Zero uses the
	// store default, which matches worker mode's own default.
	WorkerHeartbeat time.Duration
}

// serveWorkerHeartbeat reads the same environment variable worker mode uses,
// because the read side's patience has to be derived from the write side's
// cadence: with a 60s heartbeat and the 10s default here, a perfectly healthy
// worker is reported offline after 30s of silence. An unset value is not an
// error — the store default applies.
func serveWorkerHeartbeat(getenv func(string) string) (time.Duration, error) {
	raw := strings.TrimSpace(getenv("COMMUNICATION_WORKER_HEARTBEAT"))
	if raw == "" {
		return 0, nil
	}
	d, err := time.ParseDuration(raw)
	if err != nil {
		return 0, fmt.Errorf("COMMUNICATION_WORKER_HEARTBEAT %q is not a duration: %w", raw, err)
	}
	if d <= 0 {
		return 0, fmt.Errorf("COMMUNICATION_WORKER_HEARTBEAT must be positive, got %s", d)
	}
	return d, nil
}

// serveStack builds the HTTP handler for one replica and returns it with a
// function that releases its background resources.
//
// Every route in the M1 contract is registered here, and the session store is
// the Authenticator — there is no placeholder left to fail closed behind:
//
//	auth.Service          /auth/login, /auth/callback, /auth/logout,
//	                      /api/v1/me, /api/v1/users (and the cookie
//	                      session Authenticator)
//	api.RegisterProjects  projects, repositories, members
//	api.RegisterEvents    GET /api/v1/projects/{projectId}/events (SSE)
//	api.RegisterWorkers   GET /api/v1/workers
//
// No database work happens while building: a replica whose database is briefly
// unreachable still serves health and readiness, and the first request that
// needs the identity provider performs discovery (internal/api/auth).
func serveStack(d serveStackDeps) (http.Handler, func(), error) {
	if d.Pool == nil {
		return nil, nil, errors.New("serve: no database pool")
	}
	if err := d.Auth.Validate(); err != nil {
		return nil, nil, err
	}
	log := d.Logger
	if log == nil {
		log = slog.New(slog.NewTextHandler(io.Discard, nil))
	}

	identity := &postgres.IdentityStore{Pool: d.Pool}
	authenticator := auth.New(d.Auth, identity, log)

	projectStore := &postgres.ProjectStore{Pool: d.Pool}
	apiProjects := postgres.APIProjectStore{S: projectStore}
	wakes := postgres.NewEventWake(d.DatabaseURL, log)

	handler := api.New(d.API, d.Readiness, authenticator, d.UI)
	authenticator.Register(handler)
	api.RegisterProjects(handler, apiProjects)
	api.RegisterEvents(handler, apiProjects,
		postgres.APIEventStream{S: projectStore, Wakes: wakes})
	api.RegisterWorkers(handler, postgres.APIWorkerStore{
		R:                 &postgres.WorkerRegistry{Pool: d.Pool},
		HeartbeatInterval: d.WorkerHeartbeat,
	})

	return handler, wakes.Close, nil
}

// compile-time proof that the OIDC service is usable as the API's
// Authenticator: "serve uses the auth service" means this assignment, not a
// stub that has to be remembered later.
var _ api.Authenticator = (*auth.Service)(nil)
