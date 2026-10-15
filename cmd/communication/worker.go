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

	"github.com/dbirks/communication/internal/agent/acp"
	"github.com/dbirks/communication/internal/store/postgres"
	"github.com/dbirks/communication/internal/worker"
)

const workerUsage = `usage: communication worker

runs the execution worker: registers itself in Postgres, heartbeats, marks
itself draining then offline on SIGTERM/SIGINT, and (from M2) claims
conversation turns — leasing them with a fencing token, driving live ACP
agent sessions, streaming the transcript into the journal, and writing honest
terminal states before exit
(communication-spec/02-system-architecture.md, ADR-0001, ADR-0016).

environment:
  COMMUNICATION_DATABASE_URL     required, postgres connection string
  COMMUNICATION_WORKER_NAME      worker identity (default: hostname)
  COMMUNICATION_WORKER_HEARTBEAT heartbeat interval (default "10s")
  COMMUNICATION_WORKSPACE_ROOT   per-conversation workspace root
                                 (default "/var/lib/communication/workspaces")

migrations are applied separately: communication migrate up
`

// defaultWorkspaceRoot is where per-conversation workspaces live; the
// compose worker mounts a volume there (communication-spec/05 layout).
const defaultWorkspaceRoot = "/var/lib/communication/workspaces"

// workerOptions is the resolved worker configuration.
type workerOptions struct {
	databaseURL   string
	workspaceRoot string
	cfg           worker.Config
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

	o.workspaceRoot = strings.TrimSpace(getenv("COMMUNICATION_WORKSPACE_ROOT"))
	if o.workspaceRoot == "" {
		o.workspaceRoot = defaultWorkspaceRoot
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

	// M2 turn execution (ADR-0016): claims fenced leases, drives one live
	// ACP session per conversation, streams the coalesced transcript, and
	// bridges permission prompts to the durable controller decision. The
	// loop starts only after registration produced a worker id, and Drain
	// runs inside the M1 shutdown path (stop claiming → cancel in-flight
	// turns → honest terminal states) before the offline write.
	wakes := postgres.NewEventWake(opts.databaseURL, log)
	defer wakes.Close()
	loop, err := worker.NewTurnLoop(
		worker.TurnConfig{AskModeID: acpAskModeID},
		&postgres.TurnStore{Pool: pool},
		&acp.Factory{Runtime: &acp.Runtime{Logger: log}},
		&worker.Workspace{Root: opts.workspaceRoot},
		w.ID,
		worker.WithTurnLogger(log),
		worker.WithJournalWake(wakes.Watch),
	)
	if err != nil {
		stop()
		log.Error("invalid turn loop configuration", slog.String("error", err.Error()))
		return 2
	}
	w.Registered = func(ctx context.Context, _ string) {
		if err := loop.Start(ctx); err != nil {
			log.Warn("turn loop stopped", slog.String("error", err.Error()))
		}
	}
	w.Drain = loop.Drain

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

// acpAskModeID resolves the prompting mode for the launcher registry's
// ask-capable launchers (docs/compatibility/ACP.md "Permission modes"); an
// unknown launcher yields "" and the loop refuses the ask mode on it.
func acpAskModeID(launcherID string) string {
	l, ok := acp.LookupLauncher(launcherID)
	if !ok {
		return ""
	}
	return l.AskModeID
}
