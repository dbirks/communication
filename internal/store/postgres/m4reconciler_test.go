package postgres

// SQL-side reconciler tests for docs/m4-contract.md § 5.4 passes 5 and 6 —
// the two arms whose *selection* is a query rather than an engine rule.
// Pass 5's state machine (interrupt, never auto-retry) is certified for BOTH
// stores by the runtimetest conformance suite; what is certified here is that
// a real `workspaces` row in `lost` reaches that rule through the driver's
// tick, and that ADR-0023 § 11's "> 1 pass" debounce refuses a fresh loss.
// Pass 6 (the idempotency TTL) is pure SQL and lives only here.

import (
	"fmt"
	"strings"
	"testing"
)

// TestM4ReconcilerPass5LostWorkspaceInterruptsQueuedRun drives pass 5 the way
// serve does: the driver's tick, no engine call from the test.
func TestM4ReconcilerPass5LostWorkspaceInterruptsQueuedRun(t *testing.T) {
	f, rs, runID, _ := m4DriverRun(t)
	ctx := testCtx(t)

	workerName := fmt.Sprintf("m4-lost-worker-%s", runID[:8])
	if _, err := f.pool.Exec(ctx, `
		INSERT INTO workers (name, hostname, version, status, capacity)
		VALUES ($1, 'lab', 'test', 'online', 1)`, workerName); err != nil {
		t.Fatalf("seed worker: %v", err)
	}
	// Lost 30 s ago: older than one driver tick, so the debounce has expired.
	if _, err := f.pool.Exec(ctx, `
		INSERT INTO workspaces
			(organization_id, project_id, scope_kind, run_id, worker_id,
			 volume_id, root_path, state, ready_at, lost_at)
		SELECT $1::uuid, $2::uuid, 'run', $3::uuid, w.id,
		       $4, '/var/lib/communication/m4/lost', 'lost',
		       now() - interval '1 hour', now() - interval '30 seconds'
		FROM workers w WHERE w.name = $5`,
		f.orgID, f.projectID, runID, m4Digest("m4-lost-volume"), workerName); err != nil {
		t.Fatalf("seed lost workspace: %v", err)
	}

	d := NewM4Driver(f.pool, rs, nil)
	if _, err := d.Tick(ctx); err != nil {
		t.Fatalf("tick: %v", err)
	}

	var status, cause string
	if err := f.pool.QueryRow(ctx,
		`SELECT status, COALESCE(failed_cause, '') FROM runs WHERE id = $1::uuid`, runID).
		Scan(&status, &cause); err != nil {
		t.Fatalf("read run: %v", err)
	}
	if status != "interrupted" || cause != "workspace_lost" {
		t.Fatalf("pass 5 left run %s/%q, want interrupted/workspace_lost", status, cause)
	}

	var actor, payload string
	err := f.pool.QueryRow(ctx, `
		SELECT actor_kind, payload::text FROM domain_events
		WHERE run_id = $1::uuid AND type = 'run.interrupted'`, runID).Scan(&actor, &payload)
	if err != nil {
		t.Fatalf("run.interrupted missing from the journal (§ 3 row 13): %v", err)
	}
	if actor != "system" {
		t.Fatalf("pass 5 actor_kind = %q, want system (ADR-0023 § 11)", actor)
	}
	if !strings.Contains(strings.ReplaceAll(payload, " ", ""), `"error_class":"workspace_lost"`) {
		t.Fatalf("run.interrupted payload lost its class: %s", payload)
	}

	// No auto-retry, twice over: attempts were never queued, and the following
	// tick must leave the honest terminal untouched.
	var attempts int
	if err := f.pool.QueryRow(ctx,
		`SELECT count(*) FROM attempts WHERE run_id = $1::uuid`, runID).Scan(&attempts); err != nil {
		t.Fatalf("count attempts: %v", err)
	}
	if attempts != 0 {
		t.Fatalf("pass 5 queued %d attempts; workspace_lost never auto-retries (ADR-0023 § 7)", attempts)
	}
	if _, err := d.Tick(ctx); err != nil {
		t.Fatalf("second tick: %v", err)
	}
	if got := m4DriverRunStatus(t, f.pool, runID); got != "interrupted" {
		t.Fatalf("the second tick re-opened the run as %s", got)
	}
}

// TestM4ReconcilerPass5FreshLossIsDebounced pins ADR-0023 § 11's "> 1 pass":
// a loss reported on this very tick must not terminalise the run, because a
// worker still mid-report is not a dead workspace.
func TestM4ReconcilerPass5FreshLossIsDebounced(t *testing.T) {
	f, rs, runID, _ := m4DriverRun(t)
	ctx := testCtx(t)

	workerName := fmt.Sprintf("m4-fresh-worker-%s", runID[:8])
	if _, err := f.pool.Exec(ctx, `
		INSERT INTO workers (name, hostname, version, status, capacity)
		VALUES ($1, 'lab', 'test', 'online', 1)`, workerName); err != nil {
		t.Fatalf("seed worker: %v", err)
	}
	if _, err := f.pool.Exec(ctx, `
		INSERT INTO workspaces
			(organization_id, project_id, scope_kind, run_id, worker_id,
			 volume_id, root_path, state, ready_at, lost_at)
		SELECT $1::uuid, $2::uuid, 'run', $3::uuid, w.id,
		       $4, '/var/lib/communication/m4/fresh', 'lost',
		       now() - interval '1 hour', now()
		FROM workers w WHERE w.name = $5`,
		f.orgID, f.projectID, runID, m4Digest("m4-fresh-volume"), workerName); err != nil {
		t.Fatalf("seed fresh loss: %v", err)
	}

	d := NewM4Driver(f.pool, rs, nil)
	if _, err := d.Tick(ctx); err != nil {
		t.Fatalf("tick: %v", err)
	}
	if got := m4DriverRunStatus(t, f.pool, runID); got == "interrupted" {
		t.Fatalf("a loss reported this instant interrupted the run — the > 1 pass debounce is not held")
	}
}

// TestM4ReconcilerPass6SweepsExpiredIdempotencyKeys is ADR-0023 § 12's TTL:
// an expired key has no replay answer left to give, so it goes; a live one
// must survive the same sweep, or a client retrying POST /runs would create a
// second run (12 case 1).
func TestM4ReconcilerPass6SweepsExpiredIdempotencyKeys(t *testing.T) {
	f, rs, runID, _ := m4DriverRun(t)
	ctx := testCtx(t)

	for _, k := range []struct {
		key     string
		expires string
	}{
		{"m4-pass6-stale", "now() - interval '1 hour'"},
		{"m4-pass6-live", "now() + interval '23 hours'"},
	} {
		if _, err := f.pool.Exec(ctx, `
			INSERT INTO run_idempotency_keys (project_id, key, run_id, request_sha256, expires_at)
			VALUES ($1::uuid, $2, $3::uuid, $4, `+k.expires+`)`,
			f.projectID, k.key, runID, m4Hex("pass6/"+k.key)); err != nil {
			t.Fatalf("seed idempotency key %s: %v", k.key, err)
		}
	}

	d := NewM4Driver(f.pool, rs, nil)
	if _, err := d.Tick(ctx); err != nil {
		t.Fatalf("tick: %v", err)
	}

	var remaining []string
	rows, err := f.pool.Query(ctx, `
		SELECT key FROM run_idempotency_keys WHERE project_id = $1::uuid ORDER BY key`, f.projectID)
	if err != nil {
		t.Fatalf("read keys: %v", err)
	}
	defer rows.Close()
	for rows.Next() {
		var key string
		if err := rows.Scan(&key); err != nil {
			t.Fatalf("scan key: %v", err)
		}
		remaining = append(remaining, key)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("read keys: %v", err)
	}
	if len(remaining) != 1 || remaining[0] != "m4-pass6-live" {
		t.Fatalf("sweep left %v, want exactly [m4-pass6-live]", remaining)
	}
}
