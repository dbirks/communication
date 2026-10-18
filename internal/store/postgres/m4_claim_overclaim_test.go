package postgres

// claim-race2: the CI over-claim flake came from a SINGLE ClaimAttempts call
// (LIMIT clamped to 1 by the worker FOR UPDATE) that returned 2 rows — the
// workers-row lock cannot prevent that. The root cause is plan shape: in
// `UPDATE ... FROM (SELECT ... LIMIT n) w` the planner may place the derived
// table on the inner side of a nested loop and RE-EXECUTE it per outer row;
// with FOR UPDATE SKIP LOCKED and concurrent activity each execution can
// hand a different row to the same LIMIT. The fix (attempts.go) is a
// `WITH picked AS MATERIALIZED (...)` CTE, which Postgres runs exactly once.
// These tests pin the behaviour and the plan on a real database.

import (
	"context"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

// explainPlanLines runs EXPLAIN (COSTS OFF) on a single statement against the
// real database and returns the plan as one string (the house idiom from
// migrate_test.go's transcript-read EXPLAIN). EXPLAIN plans without
// executing, so runClaimSQL's nextval and FOR UPDATE SKIP LOCKED have no
// side effects here.
func explainPlanLines(t *testing.T, pool *pgxpool.Pool, sql string, args ...any) string {
	t.Helper()
	ctx := testCtx(t)
	rows, err := pool.Query(ctx, "EXPLAIN (COSTS OFF) "+sql, args...)
	if err != nil {
		t.Fatalf("EXPLAIN: %v", err)
	}
	defer rows.Close()
	var plan strings.Builder
	for rows.Next() {
		var line string
		if err := rows.Scan(&line); err != nil {
			t.Fatalf("scan EXPLAIN line: %v", err)
		}
		plan.WriteString(line + "\n")
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("read EXPLAIN: %v", err)
	}
	return plan.String()
}

// TestClaimSQLPlanPinsMaterializedCTE EXPLAINs the real claim statement and
// pins the plan the over-claim fix requires: the candidate selection and
// the token draw each appear as a one-shot CTE Scan. A derived-table
// subquery would instead plan as a subplan a nested loop can re-execute per
// row of the UPDATE.
func TestClaimSQLPlanPinsMaterializedCTE(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)
	w := m4Worker(t, ctx, f.pool, "explain-claim", 2)
	plan := explainPlanLines(t, f.pool, runClaimSQL, w, 300.0, 1)
	for _, want := range []string{"CTE Scan on picked", "CTE Scan on tok"} {
		if !strings.Contains(plan, want) {
			t.Errorf("claim plan lacks %q; candidate selection or token draw is no longer one-shot:\n%s", want, plan)
		}
	}
	t.Logf("claim plan:\n%s", plan)
}

// TestClaimAttemptsNeverExceedsLimit is the over-claim regression in
// behaviour form: a SINGLE ClaimAttempts call whose LIMIT was clamped by
// worker capacity must lease at most that many attempts, no matter how many
// are queued. The exact CI failure shape is the first block: capacity 1
// (LIMIT clamped to 1), a single call, three attempts available.
func TestClaimAttemptsNeverExceedsLimit(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)

	// Three claimable attempts across three runs.
	for i, key := range []string{"/one", "/two", "/three"} {
		run := f.m4QueuedRun(t, ctx, "", 0)
		f.m4WorkerNode(t, ctx, run, key) // (nodeID, attemptID); fatals on error
		_ = i
	}

	// Capacity 1: ClaimAttempts clamps the LIMIT to 1. One single call
	// must lease exactly one of the three — the CI failure returned two.
	w1 := m4Worker(t, ctx, f.pool, "overclaim-cap1", 1)
	cs, err := f.runs.ClaimAttempts(ctx, w1, 5)
	if err != nil {
		t.Fatalf("claim (LIMIT clamped to 1): %v", err)
	}
	if len(cs) != 1 {
		t.Fatalf("single claim with LIMIT 1 leased %d attempts, want 1 (candidate selection re-ran)", len(cs))
	}
	if active := workerActiveAttempts(t, ctx, f.pool, w1); active != 1 {
		t.Fatalf("worker active_attempts = %d after a 1-claim, want 1", active)
	}

	// Capacity 2: exactly two of the remaining two, and never the leased
	// one.
	w2 := m4Worker(t, ctx, f.pool, "overclaim-cap2", 2)
	cs2, err := f.runs.ClaimAttempts(ctx, w2, 5)
	if err != nil {
		t.Fatalf("claim (LIMIT clamped to 2): %v", err)
	}
	if len(cs2) != 2 {
		t.Fatalf("single claim with LIMIT 2 leased %d attempts, want 2 (candidate selection re-ran)", len(cs2))
	}
	for _, c := range cs2 {
		if c.AttemptID == cs[0].AttemptID {
			t.Fatalf("second claim re-leased the already-leased attempt %s", c.AttemptID)
		}
	}
	if active := workerActiveAttempts(t, ctx, f.pool, w2); active != 2 {
		t.Fatalf("worker active_attempts = %d after a 2-claim, want 2", active)
	}

	// Nothing left: the last claim is empty, not an error.
	w3 := m4Worker(t, ctx, f.pool, "overclaim-empty", 2)
	cs3, err := f.runs.ClaimAttempts(ctx, w3, 5)
	if err != nil {
		t.Fatalf("claim on empty queue: %v", err)
	}
	if len(cs3) != 0 {
		t.Fatalf("empty queue claimed %d attempts, want 0", len(cs3))
	}
}

func workerActiveAttempts(t *testing.T, ctx context.Context, pool *pgxpool.Pool, workerID string) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(ctx,
		"SELECT active_attempts FROM workers WHERE id = $1::uuid", workerID).Scan(&n); err != nil {
		t.Fatalf("read worker accounting: %v", err)
	}
	return n
}
