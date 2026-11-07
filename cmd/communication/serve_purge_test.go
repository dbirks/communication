package main

// Tests for audit F1's purge tick and audit F3's http.Server deadlines: the
// COMMUNICATION_SESSION_PURGE_INTERVAL / COMMUNICATION_SERVER_READ_TIMEOUT /
// COMMUNICATION_SERVER_IDLE_TIMEOUT parsers, the loop's error and panic
// survival, the decision that the tick starts exactly when the resolved
// interval is positive, and the server's timeout fields. All hermetic: the
// purgers are recorders, the ticker loop never touches a database, and the
// stack tests run against an unreachable pool with the runner replaced.

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dbirks/communication/internal/api"
	"github.com/dbirks/communication/internal/api/auth"
)

func TestServeSessionPurgeIntervalParse(t *testing.T) {
	for _, tt := range []struct {
		raw     string
		want    time.Duration
		wantErr string
	}{
		{"", defaultSessionPurgeInterval, ""}, // unset: the 10 min default
		{"   ", defaultSessionPurgeInterval, ""},
		{"5m", 5 * time.Minute, ""},
		{"1h", time.Hour, ""},
		{"0", 0, ""},           // 0 disables the tick
		{"0s", 0, ""},          // and so does the duration spelling
		{"-5s", 0, "positive"}, // negative is a refusal, not a disable
		{"hourly", 0, envSessionPurgeInterval},
	} {
		got, err := serveSessionPurgeInterval(func(string) string { return tt.raw })
		if tt.wantErr != "" {
			if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
				t.Errorf("%s=%q -> error %v, want it to contain %s", envSessionPurgeInterval, tt.raw, err, tt.wantErr)
			}
			continue
		}
		if err != nil {
			t.Errorf("%s=%q -> error %v, want none", envSessionPurgeInterval, tt.raw, err)
			continue
		}
		if got != tt.want {
			t.Errorf("%s=%q -> %s, want %s", envSessionPurgeInterval, tt.raw, got, tt.want)
		}
	}
}

func TestServeServerTimeoutParse(t *testing.T) {
	t.Run("read", func(t *testing.T) {
		for _, tt := range []struct {
			raw     string
			want    time.Duration
			wantErr string
		}{
			{"", 60 * time.Second, ""},
			{"30s", 30 * time.Second, ""},
			{"0", 0, "must be positive"}, // unlike the purge, 0 is not a knob here
			{"-1s", 0, "must be positive"},
			{"soon", 0, envServerReadTimeout},
		} {
			got, err := serveServerTimeout(func(string) string { return tt.raw }, envServerReadTimeout, defaultServerReadTimeout)
			if tt.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
					t.Errorf("%s=%q -> error %v, want it to contain %s", envServerReadTimeout, tt.raw, err, tt.wantErr)
				}
				continue
			}
			if err != nil || got != tt.want {
				t.Errorf("%s=%q -> %s, %v; want %s, nil", envServerReadTimeout, tt.raw, got, err, tt.want)
			}
		}
	})
	t.Run("idle", func(t *testing.T) {
		got, err := serveServerTimeout(func(string) string { return "" }, envServerIdleTimeout, defaultServerIdleTimeout)
		if err != nil || got != 120*time.Second {
			t.Errorf("unset %s -> %s, %v; want 120s, nil", envServerIdleTimeout, got, err)
		}
		if _, err := serveServerTimeout(func(string) string { return "3m" }, envServerIdleTimeout, defaultServerIdleTimeout); err != nil {
			t.Errorf("%s=3m -> error %v, want none", envServerIdleTimeout, err)
		}
	})
}

// TestRunServeRejectsGarbagePurgeAndTimeouts: a typo in any of the three new
// variables exits 2 naming it before the pool opens — the same rule every
// other serve duration follows.
func TestRunServeRejectsGarbagePurgeAndTimeouts(t *testing.T) {
	t.Setenv("COMMUNICATION_DATABASE_URL", "postgres://communication@postgres:5432/communication?sslmode=disable")
	t.Setenv("COMMUNICATION_PUBLIC_URL", "http://localhost:18080")
	t.Setenv("COMMUNICATION_OIDC_ISSUER", "http://oidc:8080/default")
	t.Setenv("COMMUNICATION_OIDC_CLIENT_ID", "communication-dev")
	for _, tt := range []struct{ env, raw string }{
		{envSessionPurgeInterval, "mishourly"},
		{envServerReadTimeout, "missoon"},
		{envServerIdleTimeout, "missoon"},
	} {
		t.Setenv(tt.env, tt.raw)
		var stdout, stderr bytes.Buffer
		if got := runServe(context.Background(), nil, &stdout, &stderr); got != 2 {
			t.Fatalf("runServe(%s=%s) = %d, want 2", tt.env, tt.raw, got)
		}
		if !strings.Contains(stderr.String(), tt.env) {
			t.Errorf("stderr = %q, want it to name %s", stderr.String(), tt.env)
		}
		t.Setenv(tt.env, "")
	}
}

// TestServeUsageDocumentsPurgeAndTimeouts: the three variables and their
// defaults are readable in --help.
func TestServeUsageDocumentsPurgeAndTimeouts(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if got := runServe(context.Background(), []string{"--help"}, &stdout, &stderr); got != 0 {
		t.Fatalf("runServe(--help) = %d, want 0", got)
	}
	for _, want := range []string{envSessionPurgeInterval, envServerReadTimeout, envServerIdleTimeout, "10m", "60s", "120s"} {
		if !strings.Contains(stdout.String(), want) {
			t.Errorf("usage text missing %q", want)
		}
	}
}

// TestNewServeServerTimeouts pins the F3 contract: ReadTimeout and
// IdleTimeout are settable, ReadHeaderTimeout survives, and WriteTimeout
// stays zero so SSE streams are never cut by the server-wide clock.
func TestNewServeServerTimeouts(t *testing.T) {
	srv := newServeServer(http.NewServeMux(), func() {}, 60*time.Second, 120*time.Second)
	if srv.ReadTimeout != 60*time.Second {
		t.Errorf("ReadTimeout = %s, want 60s", srv.ReadTimeout)
	}
	if srv.IdleTimeout != 120*time.Second {
		t.Errorf("IdleTimeout = %s, want 120s", srv.IdleTimeout)
	}
	if srv.ReadHeaderTimeout != readHeaderTimeout {
		t.Errorf("ReadHeaderTimeout = %s, want the %s constant", srv.ReadHeaderTimeout, readHeaderTimeout)
	}
	if srv.WriteTimeout != 0 {
		t.Errorf("WriteTimeout = %s, want 0 (it would kill SSE streams)", srv.WriteTimeout)
	}
}

// recordingPurger is the sessionPurger double: it counts calls, can fail and
// panic on schedule, and signals each call so a test never sleeps blindly.
type recordingPurger struct {
	mu     sync.Mutex
	calls  int
	errOn  map[int]error // call number (1-based) -> error to return
	panics map[int]bool  // call number -> panic instead of returning
	called chan struct{}
}

func newRecordingPurger() *recordingPurger {
	return &recordingPurger{
		errOn:  map[int]error{},
		panics: map[int]bool{},
		called: make(chan struct{}, 16),
	}
}

func (r *recordingPurger) PurgeExpired(ctx context.Context) error {
	r.mu.Lock()
	r.calls++
	n := r.calls
	r.mu.Unlock()
	select {
	case r.called <- struct{}{}:
	default:
	}
	if r.panics[n] {
		panic("purge exploded")
	}
	return r.errOn[n]
}

func (r *recordingPurger) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.calls
}

// TestRunSessionPurgerKeepsTickingThroughFailures: an error is logged and the
// next beat still purges; a panic is recovered, logged and retried too; ctx
// cancellation ends the loop cleanly. This is the whole F1 loop contract,
// against a recorder instead of a database.
func TestRunSessionPurgerKeepsTickingThroughFailures(t *testing.T) {
	var logs bytes.Buffer
	log := slog.New(slog.NewJSONHandler(&logs, nil))
	purger := newRecordingPurger()
	purger.errOn[1] = errors.New("database is having a day")
	purger.panics[2] = true

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- runSessionPurger(ctx, purger, 5*time.Millisecond, log) }()

	for i := 0; i < 3; i++ {
		select {
		case <-purger.called:
		case <-time.After(2 * time.Second):
			t.Fatalf("purge call %d never happened (calls=%d)", i+1, purger.count())
		}
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("runSessionPurger after cancel = %v, want nil", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("runSessionPurger did not return after cancel")
	}

	out := logs.String()
	if !strings.Contains(out, "session purge failed") {
		t.Errorf("logs lack the error line: %s", out)
	}
	if !strings.Contains(out, "session purge panicked") {
		t.Errorf("logs lack the panic line: %s", out)
	}
	if purger.count() < 3 {
		t.Errorf("purger called %d times, want it to keep ticking past the failure and the panic", purger.count())
	}
}

func TestRunSessionPurgerRefusesNilStore(t *testing.T) {
	err := runSessionPurger(context.Background(), nil, time.Minute, nil)
	if err == nil || !strings.Contains(err.Error(), "no store") {
		t.Fatalf("runSessionPurger(nil) = %v, want a refusal naming the missing store", err)
	}
}

// TestServeStackStartsSessionPurgerOnlyWhenPositive proves the gate: the tick
// starts when the resolved interval is positive and never when it is zero
// (which is how "0 disables" reaches the stack, and how every other stack
// test's zero value keeps the loop off an unreachable database). The pool is
// unreachable on purpose — the runner is replaced, so nothing queries it.
func TestServeStackStartsSessionPurgerOnlyWhenPositive(t *testing.T) {
	for _, tt := range []struct {
		name     string
		interval time.Duration
		wantRun  bool
	}{
		{"zero (default and 0-disabled)", 0, false},
		{"positive", 50 * time.Millisecond, true},
	} {
		t.Run(tt.name, func(t *testing.T) {
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
				SessionPurgeInterval: tt.interval,
				Auth: auth.Config{
					Issuer:    "http://oidc:8080/default",
					ClientID:  "communication-dev",
					PublicURL: "http://localhost:18080",
				},
				API:            api.Config{ReplicaName: "api-test", Version: "test", PublicURL: "http://localhost:18080"},
				Logger:         slog.New(slog.NewJSONHandler(&logs, nil)),
				m4DriverRunner: func(context.Context) error { return nil },
				sessionPurgeRunner: func(context.Context) error {
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
			closeStack()
			if ran != tt.wantRun {
				t.Fatalf("purge runner started = %v, want %v", ran, tt.wantRun)
			}
		})
	}
}
