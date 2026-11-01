package postgres

// C8g's intermittent FAIL against a real Postgres (m4 acceptance 38 @ fd678d3:
//
//	PASS  C8g cancel the parent -> run.cancel_requested{cascade:true} (children listed)
//	FAIL  C8g every child reaches a terminal state — child statuses=['cancelled', 'completed', 'running']
//	PASS  C8g run ends cancelled with cancelled_attempts[] populated
//
// — it had passed ~8 earlier runs, i.e. a race, not a missing arm).
//
// The race is a commit-ordering one, and every actor involved is correct on its
// own: POST /runs/{id}/cancel (route 30) sets `cancel_requested_at` under the run
// lock and journals run.cancel_requested from the invocation rows; the fan-out's
// advancer pass holds that same run row FOR UPDATE for its whole transaction, so
// a pass that armed `pipeline.invoke` rows before the cancel committed simply
// never saw the flag. What was wrong is the SECOND half: runtime.settleRun's
// cancel arm terminalised each still-`waiting` invoke row in the same breath that
// it asked the child to stop (cancelNode → M4Children.CancelChild, a REQUEST), so
// the parent wrote `run.cancelled` while its children were still `running`, and
// the exit gate — which reads the children once, after the parent is terminal —
// caught it whenever the children had not converged yet.
//
// The invariant these tests hold: while a run is cancelling, the parent holds its
// terminal until every booked child run reports terminal, and every live child is
// asked again on every pass (M4Children.CancelChild is idempotent per request, so
// re-asking costs a read, not a journal row). A child booked UNDER a
// cancel-requested parent is born cancel-requested (ADR-0023 § 10 as amended).
//
// Everything here is deterministic: convergence is driven by explicit advancer
// passes, never by a sleep.

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dbirks/communication/internal/api"
	"github.com/dbirks/communication/internal/pipelines/runtime"
)

// cascadeChildRows lists (child_run_id, status, cancel_requested_at IS NOT NULL).
// `from` takes one row per parent run, whether or not the parent's advancer pass
// has booked the pipeline_invocations row yet (a CreateChild called outside a
// pass resolves the target but writes no booking — the parent's own transaction
// owns that row).
type cascadeChildRow struct {
	id        string
	status    string
	requested bool
}

func cascadeChildren(ctx context.Context, t *testing.T, pool *pgxpool.Pool, parentID string) []cascadeChildRow {
	t.Helper()
	return cascadeRows(ctx, t, pool, `
		SELECT c.id::text, c.status, c.cancel_requested_at IS NOT NULL
		FROM pipeline_invocations i JOIN runs c ON c.id = i.child_run_id
		WHERE i.run_id = $1::uuid
		ORDER BY c.id`, parentID)
}

// cascadeRunsByParent is the same read by parent_run_id (no booking required).
func cascadeRunsByParent(ctx context.Context, t *testing.T, pool *pgxpool.Pool, parentID string) []cascadeChildRow {
	t.Helper()
	return cascadeRows(ctx, t, pool, `
		SELECT id::text, status, cancel_requested_at IS NOT NULL
		FROM runs WHERE parent_run_id = $1::uuid
		ORDER BY id`, parentID)
}

func cascadeRows(ctx context.Context, t *testing.T, pool *pgxpool.Pool, query, parentID string) []cascadeChildRow {
	t.Helper()
	rows, err := pool.Query(ctx, query, parentID)
	if err != nil {
		t.Fatalf("children of %s: %v", parentID, err)
	}
	defer rows.Close()
	var out []cascadeChildRow
	for rows.Next() {
		var r cascadeChildRow
		if err := rows.Scan(&r.id, &r.status, &r.requested); err != nil {
			t.Fatalf("scan child row: %v", err)
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate children of %s: %v", parentID, err)
	}
	return out
}

func cascadeRunStatus(ctx context.Context, t *testing.T, pool *pgxpool.Pool, runID string) string {
	t.Helper()
	var s string
	if err := pool.QueryRow(ctx, `SELECT status FROM runs WHERE id = $1::uuid`, runID).Scan(&s); err != nil {
		t.Fatalf("status of %s: %v", runID, err)
	}
	return s
}

func cascadeEventCount(ctx context.Context, t *testing.T, pool *pgxpool.Pool, runID, typ string) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM domain_events WHERE run_id = $1::uuid AND type = $2`, runID, typ).
		Scan(&n); err != nil {
		t.Fatalf("count %s rows for %s: %v", typ, runID, err)
	}
	return n
}

func cascadeItems(n int) string {
	out := "["
	for i := 1; i <= n; i++ {
		if i > 1 {
			out += ","
		}
		out += `{"number":` + string(rune('0'+i)) + `,"title":"issue ` + string(rune('0'+i)) + `"}`
	}
	return out + "]"
}

// TestM4CancelCascadeWaitsForEveryChildRun is C8g at the store: cancel the parent
// while its fan-out has children in flight, and prove (a) the cascade reaches
// EVERY booked child, (b) the parent does NOT terminalise over a child that is
// still live, and (c) the run ends `cancelled` once they have all closed.
func TestM4CancelCascadeWaitsForEveryChildRun(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)
	token := migFixtureToken(t)
	childSlug := "issue-implementation-" + token
	m4InvokePublish(t, f, childSlug, m4InvokeChildDoc(childSlug))
	parentPipeID, parentRevID := m4InvokePublish(t, f, "fanout-parent-"+token,
		m4InvokeParentDoc(childSlug))
	m4Runtime := m4InvokeDriver(f)
	caller := api.Caller{UserID: f.userID, OrganizationID: f.orgID, IsOrgAdmin: true}
	runAPI := APIRunStore{Runs: f.runs, Runtime: m4Runtime}

	// Three items at maxConcurrency 3: the fan-out books three child runs in the
	// first advance, none of them claimed by a worker (this test has none), which
	// is C8g's mid-fan-out moment without needing one.
	runID := m4InvokeRun(t, f, m4Runtime, parentPipeID, parentRevID, cascadeItems(3))
	if err := m4Runtime.Advance(ctx, runID); err != nil {
		t.Fatalf("arming advance of %s: %v", runID, err)
	}
	kids := cascadeChildren(ctx, t, f.pool, runID)
	if len(kids) != 3 {
		t.Fatalf("booked children = %d, want 3", len(kids))
	}
	for _, k := range kids {
		if runtime.RunTerminal(k.status) {
			t.Fatalf("child %s is %s before the cancel — the fixture has nothing to cascade", k.id, k.status)
		}
		if k.requested {
			t.Fatalf("child %s was already cancel-requested before the parent was cancelled", k.id)
		}
	}

	// Route 30, the same call the exit driver posts.
	if _, err := runAPI.CancelRun(ctx, caller, runID); err != nil {
		t.Fatalf("CancelRun %s: %v", runID, err)
	}
	if err := m4Runtime.Advance(ctx, runID); err != nil {
		t.Fatalf("cancel-cascade advance of %s: %v", runID, err)
	}

	after := cascadeChildren(ctx, t, f.pool, runID)
	if len(after) != 3 {
		t.Fatalf("children after the cascade = %d, want 3", len(after))
	}
	live := 0
	for _, k := range after {
		if !k.requested {
			t.Errorf("child %s escaped the cascade: cancel_requested_at IS NULL", k.id)
		}
		if !runtime.RunTerminal(k.status) {
			live++
		}
	}
	if live == 0 {
		t.Fatalf("the children were already terminal; the wait was never exercised")
	}
	if s := cascadeRunStatus(ctx, t, f.pool, runID); runtime.RunTerminal(s) {
		t.Errorf("run went %s while %d booked children were still live — C8g's race (%v)", s, live, after)
	}
	// The parent's local cascade DID happen: its own rows are all terminal, so
	// the only thing holding the run open is the children.
	var openNodes int
	if err := f.pool.QueryRow(ctx, `
		SELECT count(*) FROM node_executions
		WHERE run_id = $1::uuid AND status NOT IN
		  ('succeeded','failed','skipped','cancelled','interrupted')`, runID).
		Scan(&openNodes); err != nil {
		t.Fatalf("open node rows of %s: %v", runID, err)
	}
	if openNodes != 0 {
		t.Errorf("the cancel cascade left %d of the parent's own node rows non-terminal", openNodes)
	}
	// Re-asking a child that already carries the request must not spam its
	// journal: one run.cancel_requested row per child, however many passes the
	// parent waits.
	if n := cascadeEventCount(ctx, t, f.pool, runID, "run.cancel_requested"); n != 1 {
		t.Errorf("parent run.cancel_requested rows = %d, want exactly 1", n)
	}

	// The backstop advances the CHILDREN (that is § 5.4's job), which is what
	// closes them; the parent may then state its terminal.
	for _, k := range after {
		if runtime.RunTerminal(k.status) {
			continue
		}
		if err := m4Runtime.Advance(ctx, k.id); err != nil {
			t.Fatalf("advance of child %s: %v", k.id, err)
		}
		if st := cascadeRunStatus(ctx, t, f.pool, k.id); !runtime.RunTerminal(st) {
			t.Errorf("child %s advanced under a cancel request is still %s", k.id, st)
		}
		if n := cascadeEventCount(ctx, t, f.pool, k.id, "run.cancel_requested"); n != 1 {
			t.Errorf("child %s run.cancel_requested rows = %d, want exactly 1", k.id, n)
		}
	}
	if err := m4Runtime.Advance(ctx, runID); err != nil {
		t.Fatalf("settling advance of %s: %v", runID, err)
	}
	if s := cascadeRunStatus(ctx, t, f.pool, runID); s != runtime.RunCancelled {
		t.Errorf("run = %s, want cancelled once every child closed", s)
	}
	for _, k := range cascadeChildren(ctx, t, f.pool, runID) {
		if !runtime.RunTerminal(k.status) {
			t.Errorf("run.cancelled landed with child %s still %s", k.id, k.status)
		}
	}
}

// TestM4ChildBookedUnderCancelledParentIsBornCancelRequested is the other half of
// "a child created after the parent's cancel_requested_at must be born cancelled
// or be cancelled by the cascade": the fan-out keeps arming inside a cancelling
// pass (the approval on_timeout: cancel_run arm sets the flag and the scope
// advances before settleRun runs), so the child must arrive already told.
func TestM4ChildBookedUnderCancelledParentIsBornCancelRequested(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)
	token := migFixtureToken(t)
	childSlug := "issue-implementation-" + token
	m4InvokePublish(t, f, childSlug, m4InvokeChildDoc(childSlug))
	parentPipeID, parentRevID := m4InvokePublish(t, f, "fanout-parent-"+token,
		m4InvokeParentDoc(childSlug))
	m4Runtime := m4InvokeDriver(f)
	caller := api.Caller{UserID: f.userID, OrganizationID: f.orgID, IsOrgAdmin: true}

	runID := m4InvokeRun(t, f, m4Runtime, parentPipeID, parentRevID, `[]`)
	if _, err := (APIRunStore{Runs: f.runs, Runtime: m4Runtime}).CancelRun(ctx, caller, runID); err != nil {
		t.Fatalf("CancelRun %s: %v", runID, err)
	}
	children := &M4Children{Runs: &RunStore{Pool: f.pool}}
	out, err := children.CreateChild(ctx, runtime.ChildRequest{
		ParentRunID: runID, ParentProjectID: f.projectID, OrganizationID: f.orgID,
		NodeExecutionID: "ne7", NodeInstanceKey: "/fan_out[1]/invoke",
		Target: childSlug, Inputs: map[string]any{"number": 1, "title": "late"},
		Depth: 1,
	})
	if err != nil {
		t.Fatalf("CreateChild under a cancelled parent: %v", err)
	}
	kids := cascadeRunsByParent(ctx, t, f.pool, runID)
	if len(kids) != 1 || kids[0].id != out.ChildRunID {
		t.Fatalf("children of %s = %+v, want the one booked child %s", runID, kids, out.ChildRunID)
	}
	if !kids[0].requested {
		t.Errorf("child %s was booked under a cancel-requested parent and is NOT born cancel-requested", out.ChildRunID)
	}
	if n := cascadeEventCount(ctx, t, f.pool, out.ChildRunID, "run.cancel_requested"); n != 1 {
		t.Errorf("born-cancelled child %s run.cancel_requested rows = %d, want exactly 1", out.ChildRunID, n)
	}
	// The parent's own marker still names exactly one run.cancel_requested too.
	if n := cascadeEventCount(ctx, t, f.pool, runID, "run.cancel_requested"); n != 1 {
		t.Errorf("parent run.cancel_requested rows = %d, want exactly 1", n)
	}
	// And the child, driven once like the backstop would, closes — which is what
	// lets the parent terminalise at all.
	if err := m4Runtime.Advance(ctx, out.ChildRunID); err != nil {
		t.Fatalf("advance of the born-cancelled child: %v", err)
	}
	if st := cascadeRunStatus(ctx, t, f.pool, out.ChildRunID); st != runtime.RunCancelled {
		t.Errorf("born-cancelled child = %s, want cancelled", st)
	}
}
