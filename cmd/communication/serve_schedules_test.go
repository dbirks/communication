package main

// Tests for ADR-0032 part 2's serve-side tick: the COMMUNICATION_SCHEDULE_TICK
// cadence, the decision that the tick starts exactly where the pipeline
// driver starts (one flag, one answer — serve_scheduler_test.go's idiom), and
// the loop's logging. All hermetic: the tickers are recorders and the ticker
// loop runs against a fake scheduleTicker, never a database.

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dbirks/communication/internal/api"
	"github.com/dbirks/communication/internal/api/auth"
)

func TestServeScheduleTickParse(t *testing.T) {
	for _, tt := range []struct {
		raw     string
		want    time.Duration
		wantErr string
	}{
		{"", defaultScheduleTick, ""}, // unset: the 30 s default
		{"   ", defaultScheduleTick, ""},
		{"30s", 30 * time.Second, ""},
		{"1m", time.Minute, ""},
		{"500ms", 500 * time.Millisecond, ""},
		{"0", 0, "must be positive"},
		{"-5s", 0, "must be positive"},
		{"hourly", 0, envScheduleTick},
	} {
		got, err := serveScheduleTick(func(string) string { return tt.raw })
		if tt.wantErr != "" {
			if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
				t.Errorf("%s=%q -> error %v, want it to name %s", envScheduleTick, tt.raw, err, tt.wantErr)
			}
			continue
		}
		if err != nil {
			t.Errorf("%s=%q -> error %v, want none", envScheduleTick, tt.raw, err)
			continue
		}
		if got != tt.want {
			t.Errorf("%s=%q -> %s, want %s", envScheduleTick, tt.raw, got, tt.want)
		}
	}
}

// TestRunServeRejectsGarbageScheduleTick: the typo exits 2 naming the
// variable before the pool opens — same rule as every other serve duration.
func TestRunServeRejectsGarbageScheduleTick(t *testing.T) {
	t.Setenv("COMMUNICATION_DATABASE_URL", "postgres://communication@postgres:5432/communication?sslmode=disable")
	t.Setenv("COMMUNICATION_PUBLIC_URL", "http://localhost:18080")
	t.Setenv("COMMUNICATION_OIDC_ISSUER", "http://oidc:8080/default")
	t.Setenv("COMMUNICATION_OIDC_CLIENT_ID", "communication-dev")
	t.Setenv(envScheduleTick, "every-minute")

	var stdout, stderr bytes.Buffer
	if got := runServe(context.Background(), nil, &stdout, &stderr); got != 2 {
		t.Fatalf("runServe() = %d, want 2", got)
	}
	if !strings.Contains(stderr.String(), envScheduleTick) {
		t.Errorf("stderr = %q, want it to name %s", stderr.String(), envScheduleTick)
	}
}

// TestServeUsageDocumentsScheduleTick: the variable and its coupling to
// COMMUNICATION_PIPELINE_SCHEDULER are readable in --help.
func TestServeUsageDocumentsScheduleTick(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if got := runServe(context.Background(), []string{"--help"}, &stdout, &stderr); got != 0 {
		t.Fatalf("runServe(--help) = %d, want 0", got)
	}
	for _, want := range []string{envScheduleTick, "30s", envPipelineScheduler} {
		if !strings.Contains(stdout.String(), want) {
			t.Errorf("usage text missing %q", want)
		}
	}
}

// TestServeStackStartsScheduleTickerOnlyWhenOn proves the schedule tick shares
// the pipeline scheduler's decision: with the flag off the recorder is never
// started, with it on it is. The pool is unreachable on purpose — nothing in
// the stack queries it while the tickers are replaced.
func TestServeStackStartsScheduleTickerOnlyWhenOn(t *testing.T) {
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
		_, closeStack, err := serveStack(serveStackDeps{
			Pool:                 pool,
			DatabaseURL:          "postgres://invalid.invalid:5432/communication",
			PipelineSchedulerOff: tt.off,
			ScheduleTick:         50 * time.Millisecond,
			Auth: auth.Config{
				Issuer:    "http://oidc:8080/default",
				ClientID:  "communication-dev",
				PublicURL: "http://localhost:18080",
			},
			API:            api.Config{ReplicaName: "api-test", Version: "test", PublicURL: "http://localhost:18080"},
			Logger:         slog.New(slog.NewJSONHandler(&logs, nil)),
			m4DriverRunner: func(context.Context) error { return nil },
			scheduleTickRunner: func(context.Context) error {
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
			t.Errorf("scheduler off=%v: schedule ticker started=%v, want %v", tt.off, ran, tt.wantRun)
		}
		closeStack()
	}
}

// fakeTicker records calls and replays canned results; the loop under test
// must survive an error and log INFO only for fired runs.
type fakeTicker struct {
	mu   sync.Mutex
	hits int
	res  []int // results per beat; <0 means "that beat errors"
	err  error
	done chan struct{}
}

// calls reads the beat count under the same lock TickSchedules updates it
// with; a bare f.hits read from the test goroutine races the loop's last beat.
func (f *fakeTicker) calls() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.hits
}

func (f *fakeTicker) TickSchedules(context.Context, time.Time) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := len(f.res)
	i := f.hits
	f.hits++
	if i < n && f.res[i] < 0 {
		if f.err != nil {
			return 0, f.err
		}
		return 0, context.DeadlineExceeded
	}
	if i < n {
		if i == n-1 {
			close(f.done)
		}
		return f.res[i], nil
	}
	return 0, nil
}

func TestRunScheduleTickerLoggingAndErrorRetry(t *testing.T) {
	var logs syncBuffer
	log := slog.New(slog.NewJSONHandler(&logs, nil))
	f := &fakeTicker{res: []int{2, -1, 0, 1}, err: context.DeadlineExceeded, done: make(chan struct{})}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		_ = runScheduleTicker(ctx, f, 5*time.Millisecond, log)
	}()

	select {
	case <-f.done:
	case <-time.After(3 * time.Second):
		t.Fatal("ticker loop stopped beating before the canned results ran out")
	}
	cancel()

	text := logs.String()
	if !strings.Contains(text, `"msg":"schedules fired"`) || !strings.Contains(text, `"runs_created":2`) {
		t.Errorf("want an INFO line naming the fired count, got %s", text)
	}
	if !strings.Contains(text, "schedule tick failed") {
		t.Errorf("a failed tick must be logged and retried, got %s", text)
	}
	var quiet []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(text), "\n") {
		var rec map[string]any
		if json.Unmarshal([]byte(line), &rec) == nil {
			quiet = append(quiet, rec)
		}
	}
	for _, rec := range quiet {
		if rec["msg"] == "schedules fired" && rec["runs_created"].(float64) == 0 {
			t.Errorf("a zero-fire beat must not log INFO: %s", text)
		}
	}
	if hits := f.calls(); hits < 4 {
		t.Errorf("the loop stopped after %d beats; an error must not end it", hits)
	}
}

func TestRunScheduleTickerNilStoreRefuses(t *testing.T) {
	err := runScheduleTicker(context.Background(), nil, time.Minute, nil)
	if err == nil || !strings.Contains(err.Error(), "no store") {
		t.Fatalf("runScheduleTicker(nil) = %v, want a refusal naming the missing store", err)
	}
}
