package worker

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

// The unit tests below drive the lifetime loop with a fake clock and a fake
// registry: what is under test is the transition order (online → draining →
// offline) and the handling of heartbeat failures, neither of which is a
// database property. Register/heartbeat/drain against real Postgres is proven
// by registry_integration_test.go.

// fakeRegistry records every registry call in order.
type fakeRegistry struct {
	mu        sync.Mutex
	calls     []string
	ids       map[string]string
	registers int

	registerErr  error
	heartbeatErr error
	statusErr    error

	heartbeatDone chan struct{}
}

func newFakeRegistry() *fakeRegistry {
	return &fakeRegistry{
		ids:           map[string]string{},
		heartbeatDone: make(chan struct{}, 16),
	}
}

func (f *fakeRegistry) record(call string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, call)
}

func (f *fakeRegistry) Calls() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.calls)
}

func (f *fakeRegistry) Register(ctx context.Context, name, hostname, version string) (string, error) {
	f.record("register " + name + " " + hostname + " " + version)
	f.mu.Lock()
	f.registers++
	f.ids[name] = "worker-id-" + name
	f.mu.Unlock()
	return "worker-id-" + name, f.registerErr
}

func (f *fakeRegistry) Heartbeat(ctx context.Context, name string) error {
	f.record("heartbeat " + name)
	select {
	case f.heartbeatDone <- struct{}{}:
	default:
	}
	return f.heartbeatErr
}

func (f *fakeRegistry) SetStatus(ctx context.Context, name, status string) error {
	f.record("status " + name + " " + status)
	return f.statusErr
}

func (f *fakeRegistry) awaitHeartbeat(t *testing.T) {
	t.Helper()
	select {
	case <-f.heartbeatDone:
	case <-time.After(5 * time.Second):
		t.Fatal("no heartbeat observed")
	}
}

// fakeClock hands out one response channel per After call, so a tick only
// lands when the worker is actually waiting for it. The request channel is
// buffered because the worker calls After outside a select: a blocking After
// would make the worker unable to notice cancellation.
type fakeClock struct {
	reqs chan chan time.Time
}

func newFakeClock() *fakeClock { return &fakeClock{reqs: make(chan chan time.Time, 1)} }

func (c *fakeClock) After(d time.Duration) <-chan time.Time {
	ch := make(chan time.Time, 1)
	select {
	case c.reqs <- ch:
	default: // a previous tick was never consumed: the test drives one at a time
	}
	return ch
}

func (c *fakeClock) tick(t *testing.T) {
	t.Helper()
	select {
	case ch := <-c.reqs:
		ch <- time.Now()
	case <-time.After(5 * time.Second):
		t.Fatal("worker is not waiting for a heartbeat")
	}
}

func testConfig() Config {
	return Config{Name: "worker-1", Hostname: "host-a", Version: "1.2.3", Heartbeat: time.Second}
}

func quietLogger() Option {
	return WithLogger(slog.New(slog.NewTextHandler(io.Discard, nil)))
}

func TestRunRegistersThenDrains(t *testing.T) {
	reg := newFakeRegistry()
	clock := newFakeClock()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	w, err := New(testConfig(), reg, WithClock(clock), quietLogger())
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	done := make(chan error, 1)
	go func() { done <- w.Run(ctx) }()

	// Registration lands before the first heartbeat, so the first tick also
	// proves the worker is registered.
	clock.tick(t)
	reg.awaitHeartbeat(t)
	clock.tick(t)
	reg.awaitHeartbeat(t)

	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Run() error = %v, want nil after clean cancel", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not return after cancel")
	}

	want := []string{
		"register worker-1 host-a 1.2.3",
		"heartbeat worker-1",
		"heartbeat worker-1",
		"status worker-1 draining",
		"status worker-1 offline",
	}
	if got := reg.Calls(); !slices.Equal(got, want) {
		t.Errorf("call sequence =\n%v\nwant\n%v", got, want)
	}
	if w.ID() != "worker-id-worker-1" {
		t.Errorf("ID() = %q, want the id returned by Register", w.ID())
	}
}

func TestRunDrainHookRunsBetweenStatuses(t *testing.T) {
	reg := newFakeRegistry()
	clock := newFakeClock()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	w, err := New(testConfig(), reg, WithClock(clock), quietLogger())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	hookCalls := make(chan context.Context, 1)
	w.Drain = func(dctx context.Context) error {
		hookCalls <- dctx
		return errors.New("attempt still running")
	}

	done := make(chan error, 1)
	go func() { done <- w.Run(ctx) }()
	clock.tick(t)
	reg.awaitHeartbeat(t)
	cancel()

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Run() error = %v, want nil (a drain failure is logged, not fatal)", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not return after cancel")
	}

	select {
	case dctx := <-hookCalls:
		dl, ok := dctx.Deadline()
		if !ok {
			t.Error("drain hook got a context with no deadline; shutdown must be bounded")
		} else if remaining := time.Until(dl); remaining <= 0 || remaining > DefaultDrainTimeout {
			t.Errorf("drain deadline = %s, want within (0, %s]", remaining, DefaultDrainTimeout)
		}
	default:
		t.Fatal("drain hook did not run")
	}

	got := reg.Calls()
	if n := len(got); n < 2 || got[n-2] != "status worker-1 draining" || got[n-1] != "status worker-1 offline" {
		t.Errorf("expected draining then offline last, got %v", got)
	}
}

func TestRunSurvivesHeartbeatFailure(t *testing.T) {
	reg := newFakeRegistry()
	reg.heartbeatErr = errors.New("connection reset")
	clock := newFakeClock()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	w, err := New(testConfig(), reg, WithClock(clock), quietLogger())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	done := make(chan error, 1)
	go func() { done <- w.Run(ctx) }()

	clock.tick(t)
	reg.awaitHeartbeat(t)
	clock.tick(t)
	reg.awaitHeartbeat(t)
	cancel()

	if err := <-done; err != nil {
		t.Fatalf("Run() error = %v, want nil: a missed heartbeat must not kill the worker", err)
	}
	if n := strings.Count(strings.Join(reg.Calls(), "\n"), "heartbeat worker-1"); n != 2 {
		t.Errorf("heartbeats = %d, want 2 (retry on the next tick)", n)
	}
}

func TestRunReturnsRegisterError(t *testing.T) {
	reg := newFakeRegistry()
	reg.registerErr = errors.New("database down")

	w, err := New(testConfig(), reg, quietLogger())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	err = w.Run(context.Background())
	if err == nil || !strings.Contains(err.Error(), "register") {
		t.Fatalf("Run() error = %v, want a registration failure", err)
	}
	if w.ID() != "" {
		t.Errorf("ID() = %q after failed registration, want empty", w.ID())
	}
}

func TestRunStillMarksOfflineWhenDrainingWriteFails(t *testing.T) {
	reg := newFakeRegistry()
	clock := newFakeClock()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	w, err := New(testConfig(), reg, WithClock(clock), quietLogger())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	done := make(chan error, 1)
	go func() { done <- w.Run(ctx) }()
	clock.tick(t)
	reg.awaitHeartbeat(t)
	reg.statusErr = errors.New("database down")
	cancel()

	if err := <-done; err != nil {
		t.Fatalf("Run() error = %v, want nil", err)
	}
	got := strings.Join(reg.Calls(), "\n")
	if !strings.Contains(got, "status worker-1 draining") || !strings.Contains(got, "status worker-1 offline") {
		t.Errorf("both shutdown writes must be attempted even when the first fails, got %q", got)
	}
}

func TestNewValidatesConfig(t *testing.T) {
	reg := newFakeRegistry()

	if _, err := New(Config{}, reg); err == nil || !errors.Is(err, ErrInvalidConfig) {
		t.Errorf("New(empty) error = %v, want ErrInvalidConfig", err)
	}
	if _, err := New(testConfig(), nil); err == nil || !errors.Is(err, ErrInvalidConfig) {
		t.Errorf("New(nil registry) error = %v, want ErrInvalidConfig", err)
	}
	// A non-positive cadence means "unset" to this API (cmd/communication
	// rejects the real misconfiguration at env-parse time), so it falls back.
	fallback, err := New(Config{Name: "w", Heartbeat: -time.Second, DrainTimeout: -time.Second}, reg)
	if err != nil {
		t.Fatalf("New(non-positive cadence) error = %v, want defaults applied", err)
	}
	if fallback.cfg.Heartbeat != DefaultHeartbeat || fallback.cfg.DrainTimeout != DefaultDrainTimeout {
		t.Errorf("fallback cadence = %s / %s, want %s / %s",
			fallback.cfg.Heartbeat, fallback.cfg.DrainTimeout, DefaultHeartbeat, DefaultDrainTimeout)
	}
	if _, err := New(Config{Name: "w", DrainTimeout: time.Hour}, reg); !errors.Is(err, ErrInvalidConfig) {
		t.Errorf("New(1h drain) error = %v, want ErrInvalidConfig", err)
	}

	got, err := New(Config{Name: "w"}, reg)
	if err != nil {
		t.Fatalf("New(name only) error = %v", err)
	}
	if got.cfg.Heartbeat != DefaultHeartbeat || got.cfg.DrainTimeout != DefaultDrainTimeout {
		t.Errorf("defaults = heartbeat %s, drain %s; want %s / %s",
			got.cfg.Heartbeat, got.cfg.DrainTimeout, DefaultHeartbeat, DefaultDrainTimeout)
	}
	if got.cfg.Hostname != "w" || got.cfg.Version != "dev" {
		t.Errorf("fallbacks = hostname %q version %q, want the name and %q",
			got.cfg.Hostname, got.cfg.Version, "dev")
	}
}

func TestStatusConstantsMatchSchema(t *testing.T) {
	// workers.status is a CHECK constraint over exactly these three values.
	want := []string{"draining", "offline", "online"}
	got := []string{StatusOnline, StatusDraining, StatusOffline}
	slices.Sort(got)
	if !slices.Equal(got, want) {
		t.Errorf("statuses = %v, want %v", got, want)
	}
}
