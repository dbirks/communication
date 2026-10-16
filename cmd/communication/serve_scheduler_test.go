package main

// Tests for ADR-0023's rollback switch (COMMUNICATION_PIPELINE_SCHEDULER).
// docs/m4-live-findings.md P2: the variable used to exist only in
// compose.m4.yml, so `off` was inert and contract § 7.1 C14c unmeasurable.
// These are hermetic: an unreachable pool is never queried because the driver
// loop is replaced by a recorder (serveStackDeps.m4DriverRunner).

import (
	"bytes"
	"context"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dbirks/communication/internal/api"
	"github.com/dbirks/communication/internal/api/auth"
	"github.com/dbirks/communication/internal/store/postgres"
)

func TestServePipelineSchedulerParse(t *testing.T) {
	for _, tt := range []struct {
		raw     string
		wantOff bool
		wantErr string
	}{
		{"", false, ""},    // default: engine on
		{"   ", false, ""}, // whitespace-only is unset, not garbage
		{"on", false, ""},
		{"off", true, ""},
		{"Off", true, ""},   // case-insensitive
		{" On ", false, ""}, // trimmed
		{"true", false, envPipelineScheduler},
		{"0", false, envPipelineScheduler},
		{"disabled", false, envPipelineScheduler},
		{"on,off", false, envPipelineScheduler},
	} {
		off, err := servePipelineScheduler(func(string) string { return tt.raw })
		if tt.wantErr != "" {
			if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
				t.Errorf("%s=%q -> error %v, want it to name %s", envPipelineScheduler, tt.raw, err, tt.wantErr)
			}
			continue
		}
		if err != nil {
			t.Errorf("%s=%q -> error %v, want none", envPipelineScheduler, tt.raw, err)
			continue
		}
		if off != tt.wantOff {
			t.Errorf("%s=%q -> off=%v, want %v", envPipelineScheduler, tt.raw, off, tt.wantOff)
		}
	}
}

// TestRunServeRejectsGarbagePipelineScheduler: the typo is exit code 2 naming
// the variable, before the pool opens — not a replica that kept the engine on.
func TestRunServeRejectsGarbagePipelineScheduler(t *testing.T) {
	t.Setenv("COMMUNICATION_DATABASE_URL", "postgres://communication@postgres:5432/communication?sslmode=disable")
	t.Setenv("COMMUNICATION_PUBLIC_URL", "http://localhost:18080")
	t.Setenv("COMMUNICATION_OIDC_ISSUER", "http://oidc:8080/default")
	t.Setenv("COMMUNICATION_OIDC_CLIENT_ID", "communication-dev")
	t.Setenv(envPipelineScheduler, "Enabled")

	var stdout, stderr bytes.Buffer
	if got := runServe(context.Background(), nil, &stdout, &stderr); got != 2 {
		t.Fatalf("runServe() = %d, want 2", got)
	}
	if !strings.Contains(stderr.String(), envPipelineScheduler) {
		t.Errorf("stderr = %q, want it to name %s", stderr.String(), envPipelineScheduler)
	}
}

// TestServeUsageDocumentsPipelineScheduler: operators read the help text to
// learn what `off` actually stops, including that the worker's claim loop is a
// different process.
func TestServeUsageDocumentsPipelineScheduler(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if got := runServe(context.Background(), []string{"--help"}, &stdout, &stderr); got != 0 {
		t.Fatalf("runServe(--help) = %d, want 0", got)
	}
	for _, want := range []string{envPipelineScheduler, "\"on\" (default)", "worker mode"} {
		if !strings.Contains(stdout.String(), want) {
			t.Errorf("usage text missing %q", want)
		}
	}
}

func TestPipelineSchedulerDecision(t *testing.T) {
	if startPipelineDriver(false) != true || startPipelineDriver(true) != false {
		t.Fatal("startPipelineDriver must mirror the flag exactly")
	}
	drv := postgres.NewM4Driver(nil, nil, nil)
	if got := m4RunTrigger(drv, true); got != nil {
		t.Error("an off replica must register no advancer trigger")
	}
	if got := m4RunTrigger(drv, false); got == nil {
		t.Error("an on replica must register the driver's trigger")
	}
	var _ api.M4Trigger = m4RunTrigger(drv, false)
}

// TestServeStackStartsPipelineDriverOnlyWhenOn proves the skipped start itself:
// the recorder below stands in for driver.Run, so "never called" is an
// observation rather than an inference from a log line.
func TestServeStackStartsPipelineDriverOnlyWhenOn(t *testing.T) {
	for _, tt := range []struct {
		off     bool
		wantRun bool
	}{
		{off: false, wantRun: true},
		{off: true, wantRun: false},
	} {
		pool, err := pgxpool.New(context.Background(), "postgres://invalid.invalid:5432/communication")
		if err != nil {
			t.Fatalf("pgxpool.New: %v", err)
		}
		t.Cleanup(pool.Close)

		started := make(chan struct{}, 1)
		var logs syncBuffer
		handler, closeStack, err := serveStack(serveStackDeps{
			Pool:                 pool,
			DatabaseURL:          "postgres://invalid.invalid:5432/communication",
			PipelineSchedulerOff: tt.off,
			Auth: auth.Config{
				Issuer:    "http://oidc:8080/default",
				ClientID:  "communication-dev",
				PublicURL: "http://localhost:18080",
			},
			API:    api.Config{ReplicaName: "api-test", Version: "test", PublicURL: "http://localhost:18080"},
			Logger: slog.New(slog.NewJSONHandler(&logs, nil)),
			m4DriverRunner: func(context.Context) error {
				select {
				case started <- struct{}{}:
				default:
				}
				return nil
			},
		})
		if err != nil {
			t.Fatalf("serveStack: %v", err)
		}

		ran := false
		select {
		case <-started:
			ran = true
		case <-time.After(200 * time.Millisecond):
		}
		if ran != tt.wantRun {
			t.Errorf("scheduler off=%v: driver started=%v, want %v", tt.off, ran, tt.wantRun)
		}
		const want = "pipeline scheduler disabled on this replica (COMMUNICATION_PIPELINE_SCHEDULER=off)"
		if got := strings.Contains(logs.String(), want); got != tt.off {
			t.Errorf("scheduler off=%v: log line present=%v, want %v (%s)", tt.off, got, tt.off, logs.String())
		}
		_ = handler
		closeStack()
	}
}
