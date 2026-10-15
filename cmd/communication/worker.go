package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/dbirks/communication/internal/store/postgres"
	"github.com/dbirks/communication/internal/worker"
)

const workerUsage = `usage: communication worker

runs the execution worker: registers itself in Postgres, heartbeats, and marks
itself draining then offline on SIGTERM/SIGINT
(communication-spec/02-system-architecture.md, ADR-0001).

Claiming execution attempts arrives with milestone M2; until then a worker is
registered but idle.

environment:
  COMMUNICATION_DATABASE_URL     required, postgres connection string
  COMMUNICATION_WORKER_NAME      worker identity (default: hostname)
  COMMUNICATION_WORKER_HEARTBEAT heartbeat interval (default "10s")

migrations are applied separately: communication migrate up
`

// workerOptions is the resolved worker configuration.
type workerOptions struct {
	databaseURL string
	cfg         worker.Config
}

// workerOptionsFromEnv reads and validates the worker environment. getenv is
// injected so parsing is unit-testable without mutating the process env.
func workerOptionsFromEnv(getenv func(string) string) (workerOptions, error) {
	if getenv == nil {
		getenv = os.Getenv
	}
	var o workerOptions

	o.databaseURL = getenv("COMMUNICATION_DATABASE_URL")
	if o.databaseURL == "" {
		return o, errors.New("COMMUNICATION_DATABASE_URL is not set")
	}

	hostname, hostErr := os.Hostname()

	name := strings.TrimSpace(getenv("COMMUNICATION_WORKER_NAME"))
	if name == "" {
		if hostErr != nil || hostname == "" {
			return o, errors.New("COMMUNICATION_WORKER_NAME is not set and the hostname is unavailable")
		}
		name = hostname
	}

	interval := worker.DefaultHeartbeat
	if raw := strings.TrimSpace(getenv("COMMUNICATION_WORKER_HEARTBEAT")); raw != "" {
		d, err := time.ParseDuration(raw)
		if err != nil {
			return o, fmt.Errorf("COMMUNICATION_WORKER_HEARTBEAT %q is not a duration: %w", raw, err)
		}
		if d <= 0 {
			return o, fmt.Errorf("COMMUNICATION_WORKER_HEARTBEAT must be positive, got %s", d)
		}
		interval = d
	}

	o.cfg = worker.Config{
		Name:         name,
		Hostname:     hostname,
		Version:      version,
		Heartbeat:    interval,
		DrainTimeout: worker.DefaultDrainTimeout,
	}
	return o, nil
}

// workerSchemaCheck compares the applied schema against what this binary
// requires and returns the observed version. current is injectable
// (postgres.SchemaVersion in production) so the refusal is unit-testable: a
// worker must not run against a schema it does not understand, because the
// API and (from M2) the scheduler read the same rows.
//
// A schema *ahead* of this binary is worth only a warning — migrations are
// forward-only, so added columns do not break an older worker — while a schema
// behind it is fatal.
func workerSchemaCheck(ctx context.Context, databaseURL string,
	current func(context.Context, string) (int64, error)) (int64, error) {
	want := postgres.ExpectedSchemaVersion()
	got, err := current(ctx, databaseURL)
	if err != nil {
		return 0, err
	}
	if got < want {
		return got, fmt.Errorf("database schema version %d is behind this binary's %d: run `communication migrate up`", got, want)
	}
	return got, nil
}

// runWorker implements the "worker" mode. Exit codes: 0 clean shutdown,
// 2 configuration error, 1 runtime error.
func runWorker(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	for _, a := range args {
		if a == "-h" || a == "--help" || a == "help" {
			fmt.Fprint(stdout, workerUsage)
			return 0
		}
	}

	opts, err := workerOptionsFromEnv(os.Getenv)
	if err != nil {
		fmt.Fprintln(stderr, err.Error())
		return 2
	}

	// Structured JSON logs on stderr. The worker package labels every record it
	// writes with the worker name, so the handler adds no identity attribute of
	// its own — serve does the same with "replica".
	log := slog.New(slog.NewJSONHandler(stderr, nil))

	ctx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()

	pool, err := openPool(ctx, opts.databaseURL, log)
	if err != nil {
		stop()
		log.Error("database unavailable", slog.String("error", err.Error()))
		return 1
	}
	defer pool.Close()

	schema, err := workerSchemaCheck(ctx, opts.databaseURL, postgres.SchemaVersion)
	if err != nil {
		stop()
		log.Error("refusing to start", slog.String("error", err.Error()))
		return 1
	}
	if want := postgres.ExpectedSchemaVersion(); schema > want {
		log.Warn("database schema is newer than this binary",
			slog.Int64("schema_version", schema), slog.Int64("expected_schema_version", want))
	} else {
		log.Info("schema current", slog.Int64("schema_version", schema))
	}

	w, err := worker.New(opts.cfg, &postgres.WorkerRegistry{Pool: pool}, worker.WithLogger(log))
	if err != nil {
		stop()
		log.Error("invalid worker configuration", slog.String("error", err.Error()))
		return 2
	}

	log.Info("worker starting",
		slog.String("hostname", opts.cfg.Hostname),
		slog.String("version", version),
		slog.String("heartbeat", opts.cfg.Heartbeat.String()),
	)
	if err := w.Run(ctx); err != nil {
		stop()
		log.Error("worker stopped", slog.String("error", err.Error()))
		return 1
	}
	return 0
}
