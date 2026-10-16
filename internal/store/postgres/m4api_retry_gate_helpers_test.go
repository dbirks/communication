package postgres

// Gate-retry helpers: the DB-side scaffolding m4api_retry_gate_test.go drives.
// Every assertion reads approval_requests back — the reopen is proved against
// the ledger, never against an in-memory mirror.

import (
	"context"
	"testing"
	"time"

	"github.com/dbirks/communication/internal/pipelines/runtime"
)

// m4GateRow reads the /approve gate's row identity: exactly one must exist
// (the reopen's whole point), and the id/version/created_at it returns are
// what the retry must preserve or move.
func m4GateRow(t *testing.T, ctx context.Context, f *m4Fixture, runID string) (string, int, time.Time) {
	t.Helper()
	var (
		id      string
		version int
		created time.Time
		rows    int
	)
	if err := f.pool.QueryRow(ctx, `
		SELECT count(*) FROM approval_requests ar
		JOIN node_executions ne ON ne.id = ar.node_execution_id
		WHERE ne.run_id = $1::uuid AND ne.node_instance_key = '/approve'`, runID).Scan(&rows); err != nil {
		t.Fatalf("count gate rows: %v", err)
	}
	if rows != 1 {
		t.Fatalf("approval_requests rows for /approve = %d, want 1 (UNIQUE (node_execution_id) — a "+
			"retried gate that needed a second row is the 500 this task exists for)", rows)
	}
	if err := f.pool.QueryRow(ctx, `
		SELECT ar.id::text, ar.version, ar.created_at
		FROM approval_requests ar
		JOIN node_executions ne ON ne.id = ar.node_execution_id
		WHERE ne.run_id = $1::uuid AND ne.node_instance_key = '/approve'`, runID).
		Scan(&id, &version, &created); err != nil {
		t.Fatalf("read gate row: %v", err)
	}
	return id, version, created
}

// m4GateState reads the gate's whole shape back: state, the re-request marker,
// the decision pair, the deadline and the authored timeout arm.
func m4GateState(t *testing.T, ctx context.Context, f *m4Fixture, approvalID string) (
	string, bool, *string, *time.Time, time.Time, string) {
	t.Helper()
	var (
		state, onTimeout string
		re               bool
		decision         *string
		decidedAt        *time.Time
		deadline         time.Time
	)
	if err := f.pool.QueryRow(ctx, `
		SELECT state, re_requested, decision, decided_at, deadline_at, on_timeout
		FROM approval_requests WHERE id = $1::uuid`, approvalID).
		Scan(&state, &re, &decision, &decidedAt, &deadline, &onTimeout); err != nil {
		t.Fatalf("read gate %s: %v", approvalID, err)
	}
	return state, re, decision, decidedAt, deadline, onTimeout
}

// m4GateNode reads (node status/error_class, run status) for the gate's own
// node execution and the run it belongs to.
func m4GateNode(t *testing.T, ctx context.Context, f *m4Fixture, runID string) (string, string) {
	t.Helper()
	var nodeStatus, runStatus string
	if err := f.pool.QueryRow(ctx, `
		SELECT (SELECT status || '/' || COALESCE(error_class, '') FROM node_executions
		        WHERE run_id = $1::uuid AND node_instance_key = '/approve'),
		       (SELECT status FROM runs WHERE id = $1::uuid)`, runID).
		Scan(&nodeStatus, &runStatus); err != nil {
		t.Fatalf("read the gate node: %v", err)
	}
	return nodeStatus, runStatus
}

// expireGate ages the live gate past its deadline and runs the reconciler pass
// the deployment runs (§ 5.4 pass 2 — the deadline_at is the fact, the wall
// clock is not), leaving the gate expired, its node failed/approval_expired and
// the run terminal: a route-31 target with a dead gate.
func expireGate(t *testing.T, x *m4GateFixture, approvalID string) {
	t.Helper()
	ctx, f := testCtx(t), x.f
	if _, err := f.pool.Exec(ctx, `
		UPDATE approval_requests SET deadline_at = now() - interval '1 minute'
		WHERE id = $1::uuid AND state = 'pending'`, approvalID); err != nil {
		t.Fatalf("age the gate deadline: %v", err)
	}
	if err := x.rt.Advance(ctx, x.run.ID); err != nil {
		t.Fatalf("advance past the deadline: %v", err)
	}
	state, _, _, _, _, _ := m4GateState(t, ctx, f, approvalID)
	if state != runtime.ApprovalExpired {
		t.Fatalf("gate state = %s, want expired", state)
	}
	nodeStatus, runStatus := m4GateNode(t, ctx, f, x.run.ID)
	if nodeStatus != runtime.NodeFailed+"/"+runtime.ErrApprovalExpired {
		t.Fatalf("/approve = %s, want failed/approval_expired", nodeStatus)
	}
	if runStatus != runtime.RunFailed {
		t.Fatalf("run = %s, want failed on the expired gate", runStatus)
	}
}

// m4RunEventCount counts one journal type for one run (the reopen's evidence:
// the first ask and the retry's re-ask are two rows; a third would be a loop).
func m4RunEventCount(t *testing.T, ctx context.Context, f *m4Fixture, runID, typ string) int {
	t.Helper()
	var n int
	if err := f.pool.QueryRow(ctx,
		`SELECT count(*) FROM domain_events WHERE run_id = $1::uuid AND type = $2`, runID, typ).
		Scan(&n); err != nil {
		t.Fatalf("count %s: %v", typ, err)
	}
	return n
}
