package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/dbirks/communication/internal/store/postgres"
	"github.com/dbirks/communication/internal/worker"
)

// env maps the named variables onto getenv, with "" meaning "unset" and every
// other value returned verbatim. Unlisted names come from the real process
// environment, which is why tests pin what they care about explicitly.
func env(pairs map[string]string) func(string) string {
	return func(k string) string {
		if v, ok := pairs[k]; ok {
			if v == "" {
				return ""
			}
			return v
		}
		return os.Getenv(k)
	}
}

func TestWorkerOptionsFromEnv(t *testing.T) {
	hostname, err := os.Hostname()
	if err != nil || hostname == "" {
		t.Skipf("hostname unavailable: %v", err)
	}

	opts, err := workerOptionsFromEnv(env(map[string]string{
		"COMMUNICATION_DATABASE_URL": "postgres://communication@postgres:5432/communication",
	}))
	if err != nil {
		t.Fatalf("workerOptionsFromEnv: %v", err)
	}
	if opts.cfg.Name != hostname {
		t.Errorf("Name = %q, want the hostname %q (COMMUNICATION_WORKER_NAME default)", opts.cfg.Name, hostname)
	}
	if opts.cfg.Heartbeat != 10*time.Second || worker.DefaultHeartbeat != 10*time.Second {
		t.Errorf("Heartbeat = %s (DefaultHeartbeat %s), want the 10s default", opts.cfg.Heartbeat, worker.DefaultHeartbeat)
	}
	if opts.cfg.DrainTimeout != worker.DefaultDrainTimeout {
		t.Errorf("DrainTimeout = %s, want %s", opts.cfg.DrainTimeout, worker.DefaultDrainTimeout)
	}
	if opts.cfg.Hostname != hostname || opts.cfg.Version != version {
		t.Errorf("identity = %+v, want hostname %q version %q", opts.cfg, hostname, version)
	}
}

func TestWorkerOptionsFromEnvOverrides(t *testing.T) {
	opts, err := workerOptionsFromEnv(env(map[string]string{
		"COMMUNICATION_DATABASE_URL":     "postgres://x",
		"COMMUNICATION_WORKER_NAME":      " worker-1 ",
		"COMMUNICATION_WORKER_HEARTBEAT": "250ms",
	}))
	if err != nil {
		t.Fatalf("workerOptionsFromEnv: %v", err)
	}
	if opts.cfg.Name != "worker-1" {
		t.Errorf("Name = %q, want %q (surrounding space trimmed)", opts.cfg.Name, "worker-1")
	}
	if opts.cfg.Heartbeat != 250*time.Millisecond {
		t.Errorf("Heartbeat = %s, want 250ms", opts.cfg.Heartbeat)
	}
}

func TestWorkerOptionsFromEnvRejectsBadConfig(t *testing.T) {
	tests := []struct {
		name string
		env  map[string]string
		want string
	}{
		{
			name: "no database",
			env:  map[string]string{"COMMUNICATION_DATABASE_URL": ""},
			want: "COMMUNICATION_DATABASE_URL is not set",
		},
		{
			name: "heartbeat not a duration",
			env: map[string]string{
				"COMMUNICATION_DATABASE_URL":     "postgres://x",
				"COMMUNICATION_WORKER_HEARTBEAT": "ten seconds",
			},
			want: "COMMUNICATION_WORKER_HEARTBEAT",
		},
		{
			name: "heartbeat zero",
			env: map[string]string{
				"COMMUNICATION_DATABASE_URL":     "postgres://x",
				"COMMUNICATION_WORKER_HEARTBEAT": "0s",
			},
			want: "must be positive",
		},
		{
			name: "heartbeat negative",
			env: map[string]string{
				"COMMUNICATION_DATABASE_URL":     "postgres://x",
				"COMMUNICATION_WORKER_HEARTBEAT": "-5s",
			},
			want: "must be positive",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := workerOptionsFromEnv(env(tt.env)); err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("workerOptionsFromEnv() error = %v, want substring %q", err, tt.want)
			}
		})
	}
}

func TestRunWorkerRequiresDatabaseURL(t *testing.T) {
	t.Setenv("COMMUNICATION_DATABASE_URL", "")

	var stdout, stderr bytes.Buffer
	if got := runWorker(context.Background(), nil, &stdout, &stderr); got != 2 {
		t.Fatalf("runWorker() = %d, want 2", got)
	}
	if want := "COMMUNICATION_DATABASE_URL is not set"; !strings.Contains(stderr.String(), want) {
		t.Errorf("stderr = %q, want substring %q", stderr.String(), want)
	}
}

func TestRunWorkerRejectsBadHeartbeat(t *testing.T) {
	t.Setenv("COMMUNICATION_DATABASE_URL", "postgres://communication@postgres:5432/communication")
	t.Setenv("COMMUNICATION_WORKER_HEARTBEAT", "1x")

	var stdout, stderr bytes.Buffer
	if got := runWorker(context.Background(), nil, &stdout, &stderr); got != 2 {
		t.Fatalf("runWorker() = %d, want 2 (no connection is attempted for a config error)", got)
	}
	if want := "COMMUNICATION_WORKER_HEARTBEAT"; !strings.Contains(stderr.String(), want) {
		t.Errorf("stderr = %q, want substring %q", stderr.String(), want)
	}
}

func TestRunWorkerHelp(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if got := runWorker(context.Background(), []string{"--help"}, &stdout, &stderr); got != 0 {
		t.Fatalf("runWorker(--help) = %d, want 0", got)
	}
	if want := "usage: communication worker"; !strings.Contains(stdout.String(), want) {
		t.Errorf("stdout = %q, want substring %q", stdout.String(), want)
	}
}

func TestWorkerSchemaCheck(t *testing.T) {
	ctx := context.Background()
	want := postgres.ExpectedSchemaVersion()

	run := func(got int64, err error) func(context.Context, string) (int64, error) {
		return func(context.Context, string) (int64, error) { return got, err }
	}

	// Current schema: accepted.
	if got, err := workerSchemaCheck(ctx, "postgres://x", run(want, nil)); err != nil || got != want {
		t.Errorf("workerSchemaCheck(current) = (%d, %v), want (%d, nil)", got, err, want)
	}

	// Behind: refuses, and tells the operator how to fix it.
	got, err := workerSchemaCheck(ctx, "postgres://x", run(want-1, nil))
	if err == nil {
		t.Fatal("workerSchemaCheck(behind) error = nil, want a refusal")
	}
	if got != want-1 {
		t.Errorf("workerSchemaCheck(behind) version = %d, want %d", got, want-1)
	}
	for _, phrase := range []string{fmt.Sprintf("version %d is behind", want-1), "communication migrate up"} {
		if !strings.Contains(err.Error(), phrase) {
			t.Errorf("workerSchemaCheck(behind) error = %q, want substring %q", err, phrase)
		}
	}

	// Ahead: accepted (forward-only migrations), but reported back so the
	// caller can warn.
	if got, err := workerSchemaCheck(ctx, "postgres://x", run(want+1, nil)); err != nil || got != want+1 {
		t.Errorf("workerSchemaCheck(ahead) = (%d, %v), want (%d, nil)", got, err, want+1)
	}

	// Unreadable schema version propagates.
	sentinel := errors.New("boom")
	if _, err := workerSchemaCheck(ctx, "postgres://x", run(0, sentinel)); !errors.Is(err, sentinel) {
		t.Errorf("workerSchemaCheck(error) error = %v, want the wrapped store error", err)
	}
}
