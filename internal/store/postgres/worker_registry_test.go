package postgres

import (
	"errors"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// These tests run against a real PostgreSQL: worker liveness is a SQL
// comparison against now(), the status CHECK constraint and the name-unique
// upsert are database semantics, and AGENTS.md forbids substituting a mock for
// the thing under test.

func regWorkerFixture(t *testing.T) (*WorkerRegistry, *pgxpool.Pool) {
	t.Helper()
	ctx := testCtx(t)
	pool, err := Open(ctx, mustMigrate(t))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(pool.Close)

	// Scoped to this file's own worker names: the store package's tests and
	// internal/worker's integration test share one lab database and run as
	// separate packages, so a TRUNCATE here would empty the other's table mid
	// flight.
	if _, err := pool.Exec(ctx,
		`DELETE FROM workers WHERE name IN ('worker-1', 'worker-online', 'worker-silent', 'worker-draining')`); err != nil {
		t.Fatalf("clear worker rows: %v", err)
	}
	return &WorkerRegistry{Pool: pool}, pool
}

// regStaleHeartbeat rewinds a worker's heartbeat past the 3-interval liveness
// window without touching the row's status, simulating a worker that vanished.
func regStaleHeartbeat(t *testing.T, pool *pgxpool.Pool, name string) {
	t.Helper()
	tag, err := pool.Exec(testCtx(t), `
		UPDATE workers SET last_heartbeat_at = now() - interval '1 hour' WHERE name = $1`, name)
	if err != nil {
		t.Fatalf("stale heartbeat: %v", err)
	}
	if tag.RowsAffected() != 1 {
		t.Fatalf("stale heartbeat affected %d rows, want 1", tag.RowsAffected())
	}
}

// regOnly narrows a liveness read to the workers a test created: the lab
// database is shared, and other test packages register their own workers at
// the same time.
func regOnly(t *testing.T, reg *WorkerRegistry, heartbeat time.Duration, names ...string) []Worker {
	t.Helper()
	items, err := reg.ListWorkersWithLiveness(testCtx(t), heartbeat)
	if err != nil {
		t.Fatalf("ListWorkersWithLiveness: %v", err)
	}
	want := map[string]bool{}
	for _, n := range names {
		want[n] = true
	}
	var out []Worker
	for _, w := range items {
		if want[w.Name] {
			out = append(out, w)
		}
	}
	if len(out) != len(names) {
		t.Fatalf("liveness read for %v = %+v, want one row each", names, out)
	}
	return out
}

// regByName returns the liveness row for one worker.
func regByName(t *testing.T, reg *WorkerRegistry, heartbeat time.Duration, name string) Worker {
	t.Helper()
	return regOnly(t, reg, heartbeat, name)[0]
}

func regLookup(t *testing.T, pool *pgxpool.Pool, name string) (status string, startedAt, heartbeatAt time.Time) {
	t.Helper()
	err := pool.QueryRow(testCtx(t),
		`SELECT status, started_at, last_heartbeat_at FROM workers WHERE name = $1`, name).
		Scan(&status, &startedAt, &heartbeatAt)
	if err != nil {
		t.Fatalf("lookup worker %q: %v", name, err)
	}
	return
}

func TestWorkerRegistryRegisterAndRead(t *testing.T) {
	ctx := testCtx(t)
	reg, pool := regWorkerFixture(t)

	id, err := reg.Register(ctx, "worker-1", "host-a", "0.1.0")
	if err != nil {
		t.Fatalf("Register: %v", err)
	}
	if id == "" || !strings.Contains(id, "-") {
		t.Fatalf("Register id = %q, want a uuid", id)
	}

	status, startedAt, heartbeatAt := regLookup(t, pool, "worker-1")
	if status != WorkerStatusOnline {
		t.Errorf("status = %q, want %q", status, WorkerStatusOnline)
	}
	if startedAt.IsZero() || heartbeatAt.IsZero() {
		t.Errorf("register must stamp both timestamps, got started %v heartbeat %v", startedAt, heartbeatAt)
	}

	got := regByName(t, reg, 10*time.Second, "worker-1")
	if got.ID != id || got.Name != "worker-1" || got.Hostname != "host-a" || got.Version != "0.1.0" {
		t.Errorf("row = %+v, want id %q worker-1 host-a 0.1.0", got, id)
	}
	if got.Status != WorkerStatusOnline || got.DBStatus != WorkerStatusOnline {
		t.Errorf("status = %q/%q, want online/online", got.Status, got.DBStatus)
	}
	if got.LivenessWindow != 30*time.Second {
		t.Errorf("LivenessWindow = %s, want 3 intervals = 30s", got.LivenessWindow)
	}
}

func TestWorkerRegistryHeartbeatAdvances(t *testing.T) {
	ctx := testCtx(t)
	reg, pool := regWorkerFixture(t)

	if _, err := reg.Register(ctx, "worker-1", "host-a", "0.1.0"); err != nil {
		t.Fatalf("Register: %v", err)
	}
	regStaleHeartbeat(t, pool, "worker-1")
	_, startedBefore, before := regLookup(t, pool, "worker-1")

	if err := reg.Heartbeat(ctx, "worker-1"); err != nil {
		t.Fatalf("Heartbeat: %v", err)
	}
	status, startedAt, after := regLookup(t, pool, "worker-1")

	if !after.After(before) {
		t.Errorf("last_heartbeat_at = %v, want it to advance past %v", after, before)
	}
	if !startedAt.Equal(startedBefore) {
		t.Errorf("Heartbeat moved started_at (%v -> %v); it must only touch the heartbeat", startedBefore, startedAt)
	}
	if status != WorkerStatusOnline {
		t.Errorf("status = %q, want %q (a heartbeat is not a state change)", status, WorkerStatusOnline)
	}

	// The same heartbeat that advanced the timestamp restores liveness.
	if w := regByName(t, reg, 10*time.Second, "worker-1"); w.Status != WorkerStatusOnline {
		t.Errorf("reported status = %q after a fresh heartbeat, want online", w.Status)
	}
}

func TestWorkerRegistryLivenessDowngradesSilentWorkers(t *testing.T) {
	ctx := testCtx(t)
	reg, pool := regWorkerFixture(t)

	for _, name := range []string{"worker-online", "worker-silent", "worker-draining"} {
		if _, err := reg.Register(ctx, name, "host-a", "0.1.0"); err != nil {
			t.Fatalf("Register %q: %v", name, err)
		}
	}
	if err := reg.SetStatus(ctx, "worker-draining", WorkerStatusDraining); err != nil {
		t.Fatalf("SetStatus draining: %v", err)
	}
	for _, name := range []string{"worker-silent", "worker-draining"} {
		regStaleHeartbeat(t, pool, name)
	}

	want := map[string][2]string{
		"worker-online": {WorkerStatusOnline, WorkerStatusOnline},
		// A worker that died without a graceful exit never writes its own
		// offline row; the read side must not show it online.
		"worker-silent": {WorkerStatusOffline, WorkerStatusOnline},
		// Draining is a deliberate state, so it survives a stale heartbeat.
		"worker-draining": {WorkerStatusDraining, WorkerStatusDraining},
	}
	for _, w := range regOnly(t, reg, 10*time.Second,
		"worker-online", "worker-silent", "worker-draining") {
		got, ok := want[w.Name]
		if !ok {
			t.Fatalf("unexpected worker %q", w.Name)
		}
		if w.Status != got[0] || w.DBStatus != got[1] {
			t.Errorf("%s reported status = %q (row says %q), want %q (row %q)",
				w.Name, w.Status, w.DBStatus, got[0], got[1])
		}
		delete(want, w.Name)
	}
	for name := range want {
		t.Errorf("worker %q missing from the read", name)
	}
}

func TestWorkerRegistryDrainThenOffline(t *testing.T) {
	ctx := testCtx(t)
	reg, pool := regWorkerFixture(t)

	if _, err := reg.Register(ctx, "worker-1", "host-a", "0.1.0"); err != nil {
		t.Fatalf("Register: %v", err)
	}

	if err := reg.SetStatus(ctx, "worker-1", WorkerStatusDraining); err != nil {
		t.Fatalf("SetStatus draining: %v", err)
	}
	if status, _, _ := regLookup(t, pool, "worker-1"); status != WorkerStatusDraining {
		t.Errorf("status = %q, want draining", status)
	}
	// Draining workers keep heartbeating so the API can show them as draining
	// rather than as silently lost.
	if err := reg.Heartbeat(ctx, "worker-1"); err != nil {
		t.Fatalf("Heartbeat while draining: %v", err)
	}

	if err := reg.SetStatus(ctx, "worker-1", WorkerStatusOffline); err != nil {
		t.Fatalf("SetStatus offline: %v", err)
	}
	status, _, _ := regLookup(t, pool, "worker-1")
	if status != WorkerStatusOffline {
		t.Errorf("status = %q, want offline", status)
	}
	if w := regByName(t, reg, 10*time.Second, "worker-1"); w.Status != WorkerStatusOffline {
		t.Errorf("reported status = %q, want offline", w.Status)
	}
	// An offline row is a dead worker: a late heartbeat must not resurrect it.
	_, _, heartbeatBefore := regLookup(t, pool, "worker-1")
	if err := reg.Heartbeat(ctx, "worker-1"); !errors.Is(err, ErrNotFound) {
		t.Errorf("Heartbeat on an offline worker error = %v, want ErrNotFound", err)
	}
	_, _, heartbeatAfter := regLookup(t, pool, "worker-1")
	if !heartbeatAfter.Equal(heartbeatBefore) {
		t.Errorf("offline worker's heartbeat moved from %v to %v", heartbeatBefore, heartbeatAfter)
	}
}

func TestWorkerRegistryRestartReusesTheRow(t *testing.T) {
	ctx := testCtx(t)
	reg, pool := regWorkerFixture(t)

	firstID, err := reg.Register(ctx, "worker-1", "host-a", "0.1.0")
	if err != nil {
		t.Fatalf("Register: %v", err)
	}
	_, startedBefore, _ := regLookup(t, pool, "worker-1")
	regStaleHeartbeat(t, pool, "worker-1")
	if err := reg.SetStatus(ctx, "worker-1", WorkerStatusOffline); err != nil {
		t.Fatalf("SetStatus offline: %v", err)
	}

	secondID, err := reg.Register(ctx, "worker-1", "host-b", "0.2.0")
	if err != nil {
		t.Fatalf("re-Register: %v", err)
	}
	if secondID != firstID {
		t.Errorf("restart id = %q, want the same row %q", secondID, firstID)
	}

	var count int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM workers WHERE name = 'worker-1'`).Scan(&count); err != nil {
		t.Fatalf("count: %v", err)
	}
	if count != 1 {
		t.Errorf("rows for worker-1 = %d, want 1 (registration upserts by name)", count)
	}

	status, startedAfter, heartbeatAfter := regLookup(t, pool, "worker-1")
	if status != WorkerStatusOnline {
		t.Errorf("status = %q after restart, want online", status)
	}
	if !startedAfter.After(startedBefore) {
		t.Errorf("started_at = %v, want a fresh start time after restart (was %v)", startedAfter, startedBefore)
	}
	if !heartbeatAfter.After(startedBefore) {
		t.Errorf("last_heartbeat_at = %v, want it refreshed by registration", heartbeatAfter)
	}

	var hostname, ver string
	if err := pool.QueryRow(ctx,
		`SELECT hostname, version FROM workers WHERE name = 'worker-1'`).Scan(&hostname, &ver); err != nil {
		t.Fatalf("lookup hostname/version: %v", err)
	}
	if hostname != "host-b" || ver != "0.2.0" {
		t.Errorf("hostname/version = %q/%q, want host-b/0.2.0", hostname, ver)
	}
}

func TestWorkerRegistryRejectsInvalidWrites(t *testing.T) {
	ctx := testCtx(t)
	reg, _ := regWorkerFixture(t)

	if _, err := reg.Register(ctx, "", "host", "0.1.0"); err == nil {
		t.Error("Register with an empty name = nil error, want a validation error")
	}
	if _, err := reg.Register(ctx, "worker-1", "", "0.1.0"); err == nil {
		t.Error("Register with an empty hostname = nil error, want a validation error")
	}
	if err := reg.Heartbeat(ctx, ""); err == nil {
		t.Error("Heartbeat with an empty name = nil error, want a validation error")
	}
	if err := reg.Heartbeat(ctx, "nobody"); !errors.Is(err, ErrNotFound) {
		t.Errorf("Heartbeat(unknown) error = %v, want ErrNotFound", err)
	}
	if err := reg.SetStatus(ctx, "worker-1", "exploded"); err == nil ||
		!strings.Contains(err.Error(), "unknown worker status") {
		t.Errorf("SetStatus(unknown status) error = %v, want an unknown-status error", err)
	}
	// A worker that never registered cannot change state.
	if err := reg.SetStatus(ctx, "nobody", WorkerStatusDraining); !errors.Is(err, ErrNotFound) {
		t.Errorf("SetStatus(unknown worker) error = %v, want ErrNotFound", err)
	}
	if _, err := reg.Register(ctx, "worker-1", "host", "0.1.0"); err != nil {
		t.Fatalf("Register: %v", err)
	}
	// online is only ever reached through Register, never by a status write.
	if err := reg.SetStatus(ctx, "worker-1", WorkerStatusOnline); err == nil ||
		!strings.Contains(err.Error(), "cannot set online") {
		t.Errorf("SetStatus(online) error = %v, want a refusal naming Register", err)
	}
	// offline -> draining is not a real lifecycle step either.
	if err := reg.SetStatus(ctx, "worker-1", WorkerStatusOffline); err != nil {
		t.Fatalf("SetStatus offline: %v", err)
	}
	if err := reg.SetStatus(ctx, "worker-1", WorkerStatusDraining); !errors.Is(err, ErrNotFound) {
		t.Errorf("SetStatus(offline -> draining) error = %v, want ErrNotFound", err)
	}
}

func TestWorkerRegistryNilPool(t *testing.T) {
	ctx := testCtx(t)
	var reg *WorkerRegistry
	if _, err := reg.Register(ctx, "w", "h", "v"); err == nil {
		t.Error("Register on a nil registry = nil error, want an error")
	}
	if err := reg.Heartbeat(ctx, "w"); err == nil {
		t.Error("Heartbeat on a nil registry = nil error, want an error")
	}
	if err := reg.SetStatus(ctx, "w", WorkerStatusOffline); err == nil {
		t.Error("SetStatus on a nil registry = nil error, want an error")
	}
	if _, err := reg.ListWorkers(ctx); err == nil {
		t.Error("ListWorkers on a nil registry = nil error, want an error")
	}
}

func TestWorkerRegistryLivenessWindowBoundary(t *testing.T) {
	ctx := testCtx(t)
	reg, pool := regWorkerFixture(t)

	if _, err := reg.Register(ctx, "worker-1", "host-a", "0.1.0"); err != nil {
		t.Fatalf("Register: %v", err)
	}
	// Three 10s intervals is the window: 25s stale is tolerated, 35s is not.
	for _, tc := range []struct {
		stale time.Duration
		want  string
	}{{25 * time.Second, WorkerStatusOnline}, {35 * time.Second, WorkerStatusOffline}} {
		if _, err := pool.Exec(ctx,
			`UPDATE workers SET last_heartbeat_at = now() - $1::interval WHERE name = 'worker-1'`,
			regIntervalString(tc.stale)); err != nil {
			t.Fatalf("rewind %s: %v", tc.stale, err)
		}
		if w := regByName(t, reg, 10*time.Second, "worker-1"); w.Status != tc.want {
			t.Errorf("stale %s reported %q, want %q", tc.stale, w.Status, tc.want)
		}
	}
}

func TestRegIntervalString(t *testing.T) {
	tests := []struct {
		in   time.Duration
		want string
	}{
		{0, "0 seconds"},
		{-time.Second, "0 seconds"},
		{500 * time.Millisecond, "1 seconds"},
		{10 * time.Second, "10 seconds"},
		{30 * time.Second, "30 seconds"},
		{90 * time.Second, "90 seconds"},
		{5 * time.Minute, "300 seconds"},
	}
	for _, tt := range tests {
		if got := regIntervalString(tt.in); got != tt.want {
			t.Errorf("regIntervalString(%v) = %q, want %q", tt.in, got, tt.want)
		}
	}

	// Postgres must parse what the helper emits, with the value intended.
	ctx := testCtx(t)
	pool, err := Open(ctx, mustMigrate(t))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer pool.Close()
	for _, d := range []time.Duration{0, 30 * time.Second, 5 * time.Minute} {
		var secs int64
		if err := pool.QueryRow(ctx,
			`SELECT EXTRACT(epoch FROM $1::interval)::bigint`, regIntervalString(d)).Scan(&secs); err != nil {
			t.Fatalf("postgres rejects %q: %v", regIntervalString(d), err)
		}
		if secs != int64(d.Seconds()) {
			t.Errorf("%q parsed as %ds, want %ds", regIntervalString(d), secs, int64(d.Seconds()))
		}
	}
}

func TestWorkerStatusConstantsMatchSchema(t *testing.T) {
	// migrations/00001_m1_core.sql constrains workers.status to exactly these
	// three values; a fourth constant would be a schema change needing an ADR.
	want := []string{"draining", "offline", "online"}
	got := []string{WorkerStatusOnline, WorkerStatusDraining, WorkerStatusOffline}
	slices.Sort(got)
	if !slices.Equal(got, want) {
		t.Errorf("status constants = %v, want %v", got, want)
	}

	ctx := testCtx(t)
	poolReg, pool := regWorkerFixture(t)
	if _, err := poolReg.Register(ctx, "worker-1", "host", "0.1.0"); err != nil {
		t.Fatalf("Register: %v", err)
	}
	if _, err := pool.Exec(ctx,
		`UPDATE workers SET status = 'sleepwalking' WHERE name = 'worker-1'`); err == nil {
		t.Error("the status CHECK constraint accepted an unknown value")
	}
}
