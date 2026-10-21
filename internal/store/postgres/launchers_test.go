package postgres

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// APILauncherStore is the fleet-level count behind GET /api/v1/launchers'
// workers_online (ADR-0051 §2). These tests pin its liveness rule against a
// real PostgreSQL: stale heartbeats must count offline, and only
// required-enforcement workers with a verified launch may count at all.

func lchFixture(t *testing.T) (*pgxpool.Pool, *APILauncherStore) {
	t.Helper()
	url := testDatabaseURL(t)
	mustMigrate(t)

	ctx := testCtx(t)
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatalf("pgxpool.New: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool, &APILauncherStore{Pool: pool}
}

// lchInsertWorker inserts one workers row. required + verified are the two
// registration facts the count demands; the sandbox columns are the
// ADR-0019 D5 registration data the worker writes after its startup gate.
// The row is deleted after the test.
func lchInsertWorker(t *testing.T, pool *pgxpool.Pool, name string, required, verified bool, heartbeatAge time.Duration) {
	t.Helper()
	enforcement := "disabled"
	if required {
		enforcement = "required"
	}
	_, err := pool.Exec(testCtx(t), `
		INSERT INTO workers
			(name, hostname, version, status,
			 last_heartbeat_at,
			 sandbox_backend, sandbox_version, sandbox_enforcement, sandbox_verified)
		VALUES ($1, $1, 'test', 'online',
		        now() - make_interval(secs => $2),
		        'nono', '0.80.0', $3, $4)`,
		name, heartbeatAge.Seconds(), enforcement, verified)
	if err != nil {
		t.Fatalf("insert worker %q: %v", name, err)
	}
	t.Cleanup(func() {
		if _, err := pool.Exec(context.Background(),
			`DELETE FROM workers WHERE name = $1`, name); err != nil {
			t.Errorf("cleanup worker %q: %v", name, err)
		}
	})
}

func TestLauncherStoreCountAgainstRealPostgres(t *testing.T) {
	pool, store := lchFixture(t)
	ctx := testCtx(t)

	// Nothing registered: 0.
	n, err := store.CountLaunchWorkers(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("count = %d, want 0 with no qualifying rows", n)
	}

	counts := func() int {
		t.Helper()
		n, err := store.CountLaunchWorkers(ctx)
		if err != nil {
			t.Fatalf("CountLaunchWorkers: %v", err)
		}
		return n
	}

	// required + verified + live heartbeat: counts.
	lchInsertWorker(t, pool, "lch-w-live-req", true, true, 0)
	if got := counts(); got != 1 {
		t.Fatalf("count = %d, want 1", got)
	}

	// Same but permissive-dev: must not count — the UI's amber chip and this
	// number agree: a permissive worker cannot run a required-mode launcher.
	lchInsertWorker(t, pool, "lch-w-live-dev", false, false, 0)
	// required but never verified: must not count (the green-check ban).
	lchInsertWorker(t, pool, "lch-w-live-unverified", true, false, 0)
	// verified but disabled: must not count.
	lchInsertWorker(t, pool, "lch-w-live-disabled", false, true, 0)
	if got := counts(); got != 1 {
		t.Fatalf("count = %d, want 1 with three non-qualifying rows", got)
	}

	// A stale heartbeat (older than the liveness window, 3 × default 10 s)
	// must count offline even while the stored status says online — the same
	// rule /workers applies.
	lchInsertWorker(t, pool, "lch-w-stale", true, true, 45*time.Second)
	if got := counts(); got != 1 {
		t.Fatalf("count = %d, want 1 with a stale row", got)
	}
	// An explicit offline row must not count either.
	if _, err := pool.Exec(ctx,
		`UPDATE workers SET status = 'offline' WHERE name = $1`, "lch-w-live-req"); err != nil {
		t.Fatal(err)
	}
	if got := counts(); got != 0 {
		t.Fatalf("count = %d, want 0 after the only qualifying row went offline", got)
	}
}
