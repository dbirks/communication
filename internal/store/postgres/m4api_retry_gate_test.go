package postgres

// TestM4APIRetry*Gate: route 31's gate arm against a real Postgres (docs/
// m4-contract.md route 31, § 7.1 C9f, ADR-0023 § 9). The bug this closes is
// the live lab's (api-a request_id 4128cffa494a6f9f8ced9cc23f86e538,
// 2026-10-16):
//
//	postgres: insert approval … (pending): duplicate key value violates unique
//	constraint "approval_requests_node_execution_id_key"
//
// retrying a run whose retriable node is a human.approval gate wanted a FRESH
// approval_requests row, the table allows one per node execution, and so an
// unanswered-then-expired gate was a dead end: 500, the run stays failed. The
// reopen now moves the gate's OWN row back to pending (decision and deadline
// reset, version bumped for the CAS, created_at kept), and the arms that
// cannot be re-armed answer the documented 409 run_not_retriable. No 500.

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/dbirks/communication/internal/api"
	"github.com/dbirks/communication/internal/pipelines/runtime"
)

// m4Ptr renders an optional run field for a failure message.
func m4Ptr(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// m4GateFixture is a run parked on a LIVE /approve gate, driven there the way
// the deployment drives it: publish → assignment → CreateRun → advance → the
// worker's own claim/start/complete of /plan.
type m4GateFixture struct {
	f          *m4Fixture
	rt         *RuntimeStore
	caller     api.Caller
	runs       APIRunStore
	approvals  APIApprovalStore
	run        api.RunView
	approvalID string
	version    int
	createdAt  time.Time
	// workerID is the worker the pre-gate steps were completed by. A leg that
	// retries the run claims the re-armed attempt as the same worker (route 31's
	// retry does not reassign affinity), so the id has to survive the fixture.
	workerID string
}

func m4GateRun(t *testing.T) *m4GateFixture {
	t.Helper()
	ctx := testCtx(t)
	f := m4Setup(t)
	_, planJSON := m4LifecyclePlan(t)
	pipelineID, revisionID := m4LifecyclePublished(t, f, planJSON)

	caller := api.Caller{UserID: f.userID, OrganizationID: f.orgID, IsOrgAdmin: true}
	runStore := &RunStore{Pool: f.pool}
	children := &M4Children{Runs: runStore}
	rt := NewRuntimeStore(f.pool, &runtime.Advancer{Deps: runtime.AdvancerDeps{Children: children}})
	children.Runtime = rt
	runAPI := APIRunStore{Runs: runStore, Runtime: rt}

	as, err := APIAssignmentStore{S: f.pipelines}.CreateAssignment(ctx, caller, f.projectID,
		api.AssignmentCreateInput{PipelineID: pipelineID, PinnedRevisionID: revisionID,
			MaxConcurrentRuns: 1})
	if err != nil {
		t.Fatalf("CreateAssignment: %v", err)
	}
	key := "gate-retry-" + migFixtureToken(t)
	view, created, err := runAPI.CreateRun(ctx, caller, api.RunCreateInput{
		ProjectID:    f.projectID,
		AssignmentID: as.ID,
		Inputs: map[string]json.RawMessage{
			"goal":                json.RawMessage(`"expire the gate, then retry it"`),
			"repository":          json.RawMessage(`"repo-a"`),
			"acceptance_criteria": json.RawMessage(`"tests pass"`),
			"fanout":              json.RawMessage(`false`),
			"fanout_count":        json.RawMessage(`0`),
		},
		Key:         key,
		RequestSHA:  m4Hex("body/" + key),
		TriggeredBy: f.userID,
	})
	if err != nil || !created {
		t.Fatalf("CreateRun = (%v, %v)", created, err)
	}
	if err := rt.Advance(ctx, view.ID); err != nil {
		t.Fatalf("advance: %v", err)
	}
	// Both pre-gate worker steps to success, by the real claim/start/complete
	// trio: /plan, and the seed's pre-gate artifact publisher /publish_plan that
	// /approve now depends on (m4_pregate_drive_test.go names the reason).
	workerID := m4DriveToApprovalGate(t, ctx, f, rt, view.ID, "gate-retry")
	x := &m4GateFixture{f: f, rt: rt, caller: caller, runs: runAPI,
		approvals: APIApprovalStore{R: rt}, run: view, workerID: workerID}
	x.approvalID, x.version, x.createdAt = m4GateRow(t, ctx, f, view.ID)
	return x
}

// TestM4APIRetryExpiredGateRearmsItsApprovalRow is the 500's regression: the
// retry of a run whose only retriable node execution is an EXPIRED
// human.approval gate answers 200, the gate's own row is pending again, and
// the decision posted at the NEW version moves the run.
func TestM4APIRetryExpiredGateRearmsItsApprovalRow(t *testing.T) {
	ctx := testCtx(t)
	x := m4GateRun(t)
	f, runID, approvalID := x.f, x.run.ID, x.approvalID
	if st, _, _, _, _, _ := m4GateState(t, ctx, f, approvalID); st != runtime.ApprovalPending {
		t.Fatalf("fixture gate state = %s, want pending", st)
	}
	expireGate(t, x, approvalID)

	updated, err := x.runs.RetryRun(ctx, x.caller, runID, api.RunRetryInput{
		RequestedBy: f.userID,
		// Route 31's retry-time input: the reopened gate re-resolves its ASK
		// against it, so the re-armed row must carry the new summary — the old
		// one is the ask nobody answered.
		Inputs: map[string]json.RawMessage{"goal": json.RawMessage(`"retry the dead gate"`)},
	})
	if err != nil {
		var conflict *api.RunConflictError
		if errors.As(err, &conflict) {
			t.Fatalf("retry of an expired gate = 409 %s (%s): the reopen must land, and the "+
				"unfixed code's unique-violation 500 surfaces as a plain error", conflict.Kind, conflict.Detail)
		}
		t.Fatalf("retry of an expired gate: %v", err)
	}
	if updated.Status != runtime.RunWaitingHuman {
		t.Fatalf("run after the retry = %s/%s, want waiting_human with the gate live again",
			updated.Status, m4Ptr(updated.FailedCause))
	}

	// ONE row, the SAME row, live again.
	id, version, created := m4GateRow(t, ctx, f, runID)
	if id != approvalID {
		t.Fatalf("gate row after the retry = %s, want the run's own %s re-armed in place", id, approvalID)
	}
	if version <= x.version {
		t.Errorf("gate version = %d, want > %d — a decide posted against the pre-retry read "+
			"must not decide the retried gate", version, x.version)
	}
	if !created.Equal(x.createdAt) {
		t.Errorf("gate created_at = %v, want the row's original %v (the ask's age is the row's)",
			created, x.createdAt)
	}
	state, reRequested, decision, decidedAt, deadline, onTimeout := m4GateState(t, ctx, f, approvalID)
	if state != runtime.ApprovalPending {
		t.Errorf("gate state = %s, want pending", state)
	}
	if !reRequested {
		t.Error("gate re_requested = false: the retry re-asked this row, and re_requested is the only " +
			"re-request marker approval_requests carries")
	}
	if decision != nil || decidedAt != nil {
		t.Errorf("re-armed gate carries decision=%v decided_at=%v: approvals_decided_consistency's "+
			"pending arm admits neither", decision, decidedAt)
	}
	if !deadline.After(time.Now()) {
		t.Errorf("gate deadline = %v, want a live window (now %v)", deadline, time.Now())
	}
	if onTimeout != "fail" {
		t.Errorf("gate on_timeout = %s, want the authored arm preserved across the reopen", onTimeout)
	}
	var summary string
	if err := f.pool.QueryRow(ctx,
		`SELECT summary FROM approval_requests WHERE id = $1::uuid`, approvalID).Scan(&summary); err != nil {
		t.Fatalf("read the re-armed summary: %v", err)
	}
	if !strings.Contains(summary, "retry the dead gate") {
		t.Errorf("re-armed gate summary = %q, want the retry-time input's ask (the row and the "+
			"approval.requested digest must describe the SAME question)", summary)
	}
	if nodeStatus, _ := m4GateNode(t, ctx, f, runID); !strings.HasPrefix(nodeStatus, runtime.NodeWaiting) {
		t.Errorf("/approve = %s, want waiting/approval", nodeStatus)
	}
	// The journal tells the whole story: one retry, two asks naming the SAME
	// approval id (route 34's card cannot be keyed by a row that does not exist).
	if n := m4RunsWriteCount(t, f, runID, "run.retried"); n != 1 {
		t.Errorf("run.retried = %d, want 1", n)
	}
	if n := m4RunEventCount(t, ctx, f, runID, "approval.requested"); n != 2 {
		t.Errorf("approval.requested = %d, want the first ask and the retry's re-ask", n)
	}
	if n := m4RunEventCount(t, ctx, f, runID, "approval.expired"); n != 1 {
		t.Errorf("approval.expired = %d, want the one expiry the reopen followed", n)
	}

	// The dead end is gone: decide the re-armed gate at its NEW version and the
	// run leaves waiting_human.
	if _, err := x.approvals.DecideApproval(ctx, x.caller, approvalID, "approved", "retry worked",
		version, func(api.ApprovalView, string) (bool, string) { return true, "" }); err != nil {
		t.Fatalf("DecideApproval on the re-armed gate: %v", err)
	}
	assertRunStatus(t, ctx, f, runID, runtime.RunRunning)
}

// TestM4APIRetryDeniedGateAnswersRunNotRetriable is the arm the brief names in
// words: whatever is implemented, a gate that CANNOT be re-armed answers a
// documented 4xx. A row closed by a recorded refusal is that gate — re-arming
// it would overwrite who refused and when — so route 31 names it and moves
// nothing.
func TestM4APIRetryDeniedGateAnswersRunNotRetriable(t *testing.T) {
	ctx := testCtx(t)
	x := m4GateRun(t)
	f, runID, approvalID := x.f, x.run.ID, x.approvalID
	expireGate(t, x, approvalID)
	// The honest denial shape the approvals path records: a refusal with an
	// author and a timestamp, and no decision (approvals_decided_consistency).
	renamed := x.approvalID
	if _, err := f.pool.Exec(ctx, `
		UPDATE approval_requests SET state = 'denied', decided_by = $2::uuid,
		       decided_at = now(), version = version + 1
		WHERE id = $1::uuid AND state = 'expired'`, renamed, f.userID); err != nil {
		t.Fatalf("record the refusal: %v", err)
	}

	var conflict *api.RunConflictError
	_, err := x.runs.RetryRun(ctx, x.caller, runID, api.RunRetryInput{RequestedBy: f.userID})
	if !errors.As(err, &conflict) || conflict.Kind != api.RunConflictNotRetriable {
		t.Fatalf("retry of an unre-armable gate = %v, want 409 %s (never a 500)",
			err, api.RunConflictNotRetriable)
	}
	if !strings.Contains(conflict.Detail, "/approve") || !strings.Contains(conflict.Detail, approvalID) {
		t.Errorf("refusal detail = %q, want it to name the gate and its node", conflict.Detail)
	}
	// Validate-then-mutate: the reopen is refused whole, so every row the retry
	// would have moved is exactly where it was.
	nodeStatus, runStatus := m4GateNode(t, ctx, f, runID)
	if runStatus != runtime.RunFailed || !strings.HasPrefix(nodeStatus, runtime.NodeFailed) {
		t.Fatalf("after the refusal run=%s /approve=%s, want both terminal as they were",
			runStatus, nodeStatus)
	}
	if st, _, _, _, _, _ := m4GateState(t, ctx, f, approvalID); st != runtime.ApprovalDenied {
		t.Errorf("gate state = %s, want the refusal left standing", st)
	}
	if n := m4RunsWriteCount(t, f, runID, "run.retried"); n != 0 {
		t.Errorf("run.retried = %d, want 0 — a refused reopen journals nothing", n)
	}
}
