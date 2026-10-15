package worker_test

import (
	"context"
	"fmt"
	"os"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dbirks/communication/internal/store/postgres"
	"github.com/dbirks/communication/internal/worker"
)

// The postgres registry must satisfy the port the loop is written against;
// this line is that compatibility proof, and it holds without a database.
var _ worker.Registry = (*postgres.WorkerRegistry)(nil)

// These tests run the real loop against a real PostgreSQL (the shared lab
// instance in its own database): what they assert is that the registration,
// heartbeat, drain and offline writes actually land in the workers table
// (AGENTS.md: a mocked green test never substitutes for an integration test).

func testDatabaseURL(t *testing.T) string {
	t.Helper()
	u := os.Getenv("COMMUNICATION_TEST_DATABASE_URL")
	if u == "" {
		t.Skip("COMMUNICATION_TEST_DATABASE_URL not set")
	}
	return u
}

func testCtx(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	t.Cleanup(cancel)
	return ctx
}

// spyRegistry records the calls the loop makes while writing through to the
// real store, so transition order can be asserted without racing the clock.
type spyRegistry struct {
	real    *postgres.WorkerRegistry
	mu      sync.Mutex
	calls   []string
	changed chan struct{}
}

func (s *spyRegistry) record(call string) {
	s.mu.Lock()
	s.calls = append(s.calls, call)
	s.mu.Unlock()
	select {
	case s.changed <- struct{}{}:
	default:
	}
}

func (s *spyRegistry) Calls() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.calls)
}

func (s *spyRegistry) count(want string) int {
	n := 0
	for _, c := range s.Calls() {
		if c == want {
			n++
		}
	}
	return n
}

func (s *spyRegistry) Register(ctx context.Context, name, hostname, version string) (string, error) {
	id, err := s.real.Register(ctx, name, hostname, version)
	s.record("register")
	return id, err
}

func (s *spyRegistry) Heartbeat(ctx context.Context, name string) error {
	err := s.real.Heartbeat(ctx, name)
	s.record("heartbeat")
	return err
}

func (s *spyRegistry) SetStatus(ctx context.Context, name, status string) error {
	err := s.real.SetStatus(ctx, name, status)
	s.record("status " + status)
	return err
}

// awaitCount blocks until call has been recorded n times (or the test fails).
func (s *spyRegistry) awaitCount(t *testing.T, call string, n int) {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		if s.count(call) >= n {
			return
		}
		select {
		case <-s.changed:
		case <-time.After(100 * time.Millisecond):
		}
	}
	t.Fatalf("call %q was not recorded %d times; calls so far = %v", call, n, s.Calls())
}

// await blocks until call has been recorded (or the test fails).
func (s *spyRegistry) await(t *testing.T, call string) {
	t.Helper()
	s.awaitCount(t, call, 1)
}

func workerRow(t *testing.T, pool *pgxpool.Pool, name string) (status string, startedAt, heartbeatAt time.Time) {
	t.Helper()
	err := pool.QueryRow(testCtx(t),
		`SELECT status, started_at, last_heartbeat_at FROM workers WHERE name = $1`, name).
		Scan(&status, &startedAt, &heartbeatAt)
	if err != nil {
		t.Fatalf("read worker %q: %v", name, err)
	}
	return
}

func TestWorkerLoopRegistersHeartbeatsDrainsAndGoesOffline(t *testing.T) {
	ctx := testCtx(t)
	url := testDatabaseURL(t)
	if err := postgres.Migrate(ctx, url); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	pool, err := postgres.Open(ctx, url)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer pool.Close()
	// Only this run's row is removed: the postgres package's tests share this
	// database and run concurrently as a separate package.
	name := fmt.Sprintf("worker-loop-%d", time.Now().UnixNano())
	if _, err := pool.Exec(ctx, `DELETE FROM workers WHERE name = $1`, name); err != nil {
		t.Fatalf("delete previous row: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM workers WHERE name = $1`, name)
	})

	spy := &spyRegistry{
		real:    &postgres.WorkerRegistry{Pool: pool},
		changed: make(chan struct{}, 64),
	}
	cfg := worker.Config{
		Name:      name,
		Hostname:  "lab",
		Version:   "test",
		Heartbeat: 200 * time.Millisecond,
	}

	start := func(t *testing.T) (*worker.Worker, context.CancelFunc, chan error) {
		t.Helper()
		w, err := worker.New(cfg, spy)
		if err != nil {
			t.Fatalf("worker.New: %v", err)
		}
		runCtx, cancel := context.WithCancel(ctx)
		done := make(chan error, 1)
		go func() { done <- w.Run(runCtx) }()
		return w, cancel, done
	}

	// --- first lifetime: register, then heartbeat past the row's own stamp
	w, cancel, done := start(t)
	spy.await(t, "register")

	status, startedAt, heartbeatAt := workerRow(t, pool, cfg.Name)
	if status != worker.StatusOnline {
		t.Fatalf("status after register = %q, want online", status)
	}
	if w.ID() == "" {
		t.Error("worker id was not captured from registration")
	}

	spy.await(t, "heartbeat")
	if _, _, advanced := workerRow(t, pool, cfg.Name); !advanced.After(heartbeatAt) {
		t.Errorf("last_heartbeat_at did not advance: %v -> %v", heartbeatAt, advanced)
	}

	items, err := spy.real.ListWorkersWithLiveness(ctx, cfg.Heartbeat)
	if err != nil {
		t.Fatalf("ListWorkersWithLiveness: %v", err)
	}
	online := 0
	for _, w := range items {
		if w.Name == cfg.Name {
			if w.Status != worker.StatusOnline {
				t.Fatalf("liveness read for %q = %+v, want online", cfg.Name, w)
			}
			online++
		}
	}
	if online != 1 {
		t.Fatalf("liveness read returned %d rows for %q, want exactly 1 (of %d workers)", online, cfg.Name, len(items))
	}

	// --- graceful drain: draining is observable while the process winds down
	if n := spy.count("heartbeat"); n < 1 {
		t.Errorf("heartbeats recorded = %d, want at least 1", n)
	}
	w.Drain = func(context.Context) error {
		if got, _, _ := workerRow(t, pool, cfg.Name); got != worker.StatusDraining {
			t.Errorf("status during the drain hook = %q, want draining", got)
		}
		return nil
	}
	cancel()

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Run() error = %v, want nil after cancel", err)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("Run did not return after cancel")
	}

	status, restartedAfterShutdown, _ := workerRow(t, pool, cfg.Name)
	if status != worker.StatusOffline {
		t.Errorf("status after shutdown = %q, want offline", status)
	}
	if !restartedAfterShutdown.Equal(startedAt) {
		t.Errorf("shutdown moved started_at %v -> %v", startedAt, restartedAfterShutdown)
	}

	// --- second lifetime on the same name: the same row, back to online
	w2, cancel2, done2 := start(t)
	spy.awaitCount(t, "register", 2)
	heartbeats := spy.count("heartbeat")
	spy.awaitCount(t, "heartbeat", heartbeats+1)
	if w2.ID() != w.ID() {
		t.Errorf("restart id = %q, want the original %q", w2.ID(), w.ID())
	}
	status, restartedAt, _ := workerRow(t, pool, cfg.Name)
	if status != worker.StatusOnline {
		t.Errorf("status after restart = %q, want online", status)
	}
	if !restartedAt.After(startedAt) {
		t.Errorf("restart did not refresh started_at: %v -> %v", startedAt, restartedAt)
	}
	var rows int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM workers WHERE name = $1`, cfg.Name).Scan(&rows); err != nil {
		t.Fatalf("count: %v", err)
	}
	if rows != 1 {
		t.Errorf("workers rows = %d, want 1 (registration upserts by name)", rows)
	}

	cancel2()
	if err := <-done2; err != nil {
		t.Fatalf("restart Run() error = %v", err)
	}

	var statuses []string
	for _, c := range spy.Calls() {
		if strings.HasPrefix(c, "status ") {
			statuses = append(statuses, c)
		}
	}
	wantStatuses := []string{"status draining", "status offline", "status draining", "status offline"}
	if !slices.Equal(statuses, wantStatuses) {
		t.Errorf("status writes = %v, want %v", statuses, wantStatuses)
	}
	if n := spy.count("heartbeat"); n < heartbeats+1 {
		t.Errorf("heartbeats recorded = %d, want at least %d", n, heartbeats+1)
	}
	items, err = spy.real.ListWorkersWithLiveness(ctx, cfg.Heartbeat)
	if err != nil {
		t.Fatalf("ListWorkersWithLiveness: %v", err)
	}
	for _, w := range items {
		if w.Name == cfg.Name && w.Status != worker.StatusOffline {
			t.Errorf("final liveness read for %q = %q, want offline", cfg.Name, w.Status)
		}
	}
}
