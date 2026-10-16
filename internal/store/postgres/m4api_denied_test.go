package postgres

// TestM4Denied*: the audit write behind every refused M4 read/mutation
// (docs/m4-contract.md § 5). The point under test is m4Denied's project
// resolution — the id the caller named must land on the owning project
// through a real SQL bind, and stay NULL for an id that names nothing. The
// run family is exercised through APIRunStore.RecordDenied, the method that
// used to duplicate the insert to dodge the unbound-parameter bug.
// Integration layer: every assertion reads rows a real Postgres wrote.

import (
	"context"
	"testing"

	"github.com/dbirks/communication/internal/api"
)

// m4DeniedAuditRow reads back the one denial row the test just wrote, keyed by
// the fixture's unique actor, and returns the (NOT NULL) project id it names —
// "" when the column is NULL.
func m4DeniedAuditRow(t *testing.T, ctx context.Context, f *m4Fixture, actor, action string) (int, string, string) {
	t.Helper()
	var rows int
	var projectID, detail string
	if err := f.pool.QueryRow(ctx, `
		SELECT count(*), COALESCE(max(project_id::text), ''), COALESCE(max(detail::text), '')
		FROM audit_events WHERE actor_id = $1 AND action = $2 AND outcome = 'denied'`,
		actor, action).Scan(&rows, &projectID, &detail); err != nil {
		t.Fatalf("read audit row for %s: %v", action, err)
	}
	t.Cleanup(func() {
		if _, err := f.pool.Exec(context.Background(),
			`DELETE FROM audit_events WHERE actor_id = $1 AND action = $2`, actor, action); err != nil {
			t.Errorf("cleanup audit rows: %v", err)
		}
	})
	return rows, projectID, detail
}

// TestM4DeniedRunAuditRow: a uuid resource id resolves to the run's project.
func TestM4DeniedRunAuditRow(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)
	caller := api.Caller{UserID: f.userID, OrganizationID: f.orgID}
	runID := m4RunsReadSeedRun(t, ctx, f)
	store := APIRunStore{Runs: f.runs}

	if err := store.RecordDenied(ctx, caller, runID, "run.get"); err != nil {
		t.Fatalf("RecordDenied(%s): %v", runID, err)
	}

	rows, projectID, detail := m4DeniedAuditRow(t, ctx, f, f.userID, "run.get")
	if rows != 1 {
		t.Fatalf("denied audit rows = %d, want exactly 1", rows)
	}
	if projectID != f.projectID {
		t.Errorf("audit project_id = %q, want the run's project %q", projectID, f.projectID)
	}
	if want := `{"action": "run.get", "resource_id": "` + runID + `"}`; detail != want {
		t.Errorf("audit detail = %s, want %s", detail, want)
	}
}

// TestM4DeniedNonUUIDProjectNull: an id that names no row still records the
// denial, with a NULL project rather than a fabricated one (a nonsense id is
// also what a cross-org probe looks like to the handler).
func TestM4DeniedNonUUIDProjectNull(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)
	caller := api.Caller{UserID: f.userID, OrganizationID: f.orgID}
	store := APIRunStore{Runs: f.runs}

	const nonsense = "not-a-uuid-at-all"
	if err := store.RecordDenied(ctx, caller, nonsense, "run.get"); err != nil {
		t.Fatalf("RecordDenied(%s): %v", nonsense, err)
	}

	rows, projectID, _ := m4DeniedAuditRow(t, ctx, f, f.userID, "run.get")
	if rows != 1 {
		t.Fatalf("denied audit rows = %d, want exactly 1", rows)
	}
	if projectID != "" {
		t.Errorf("audit project_id = %q, want NULL for an id naming no row", projectID)
	}
}

// TestM4DeniedNodeExecutionAuditRow: RecordDenied also receives node-execution
// ids (docs/m4-contract.md § 2 run-scoped reads). node_executions carries no
// project_id of its own, so the resolution must reach the owning run's project
// rather than recording a NULL.
func TestM4DeniedNodeExecutionAuditRow(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)
	caller := api.Caller{UserID: f.userID, OrganizationID: f.orgID}
	runID := m4RunsReadSeedRun(t, ctx, f)
	nodeID, _ := f.m4WorkerNode(t, ctx, runID, "/implement")
	store := APIRunStore{Runs: f.runs}

	if err := store.RecordDenied(ctx, caller, nodeID, "run.nodes"); err != nil {
		t.Fatalf("RecordDenied(node %s): %v", nodeID, err)
	}

	rows, projectID, detail := m4DeniedAuditRow(t, ctx, f, f.userID, "run.nodes")
	if rows != 1 {
		t.Fatalf("denied audit rows = %d, want exactly 1", rows)
	}
	if projectID != f.projectID {
		t.Errorf("audit project_id = %q, want the node execution's run project %q", projectID, f.projectID)
	}
	if want := `{"action": "run.nodes", "resource_id": "` + nodeID + `"}`; detail != want {
		t.Errorf("audit detail = %s, want %s", detail, want)
	}
}

// TestM4DeniedAttemptAuditRow: same duty for attempt ids, resolved through the
// attempt's run (attempts.run_id is pinned to its node execution by 00005's
// composite FK, so the project is unambiguous).
func TestM4DeniedAttemptAuditRow(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)
	caller := api.Caller{UserID: f.userID, OrganizationID: f.orgID}
	runID := m4RunsReadSeedRun(t, ctx, f)
	_, attemptID := f.m4WorkerNode(t, ctx, runID, "/implement")
	store := APIRunStore{Runs: f.runs}

	if err := store.RecordDenied(ctx, caller, attemptID, "run.attempts"); err != nil {
		t.Fatalf("RecordDenied(attempt %s): %v", attemptID, err)
	}

	rows, projectID, detail := m4DeniedAuditRow(t, ctx, f, f.userID, "run.attempts")
	if rows != 1 {
		t.Fatalf("denied audit rows = %d, want exactly 1", rows)
	}
	if projectID != f.projectID {
		t.Errorf("audit project_id = %q, want the attempt's run project %q", projectID, f.projectID)
	}
	if want := `{"action": "run.attempts", "resource_id": "` + attemptID + `"}`; detail != want {
		t.Errorf("audit detail = %s, want %s", detail, want)
	}
}

// TestM4DeniedForeignRunAuditRow: a uuid that is well-formed but belongs to no
// row (a cross-org probe) records the denial with no project.
func TestM4DeniedForeignRunAuditRow(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)
	caller := api.Caller{UserID: f.userID, OrganizationID: f.orgID}
	store := APIRunStore{Runs: f.runs}

	const unknown = m4RunsReadForeignUser
	if err := store.RecordDenied(ctx, caller, unknown, "run.get"); err != nil {
		t.Fatalf("RecordDenied(%s): %v", unknown, err)
	}

	rows, projectID, _ := m4DeniedAuditRow(t, ctx, f, f.userID, "run.get")
	if rows != 1 {
		t.Fatalf("denied audit rows = %d, want exactly 1", rows)
	}
	if projectID != "" {
		t.Errorf("audit project_id = %q, want NULL for a uuid naming no row", projectID)
	}
}
