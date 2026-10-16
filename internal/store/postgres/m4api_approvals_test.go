package postgres

// TestM4APIApprovals*: integration tests for the assignment (routes 17–20)
// and pipeline-gate (routes 34–36) postgres adapters on a database that ran
// 00005. The assertions are behavioural, in the m4_pipelines_test.go idiom:
// the journal row exists because the write committed, a stale CAS answers the
// conflict with the winner, and a cross-organization id answers the same
// not-found sentinel a random uuid does.

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dbirks/communication/internal/api"
	"github.com/dbirks/communication/internal/events"
)

// m4APMember makes the fixture user a project member and returns the caller
// every test below reads as. The fixture's project carries no membership row
// (m4Setup seeds it with a bare INSERT) and the adapters' whole answer is the
// membership predicate, so the membership is stated, not assumed.
func m4APMember(t *testing.T, ctx context.Context, f *m4Fixture, role string) api.Caller {
	t.Helper()
	if _, err := f.pool.Exec(ctx, `
		INSERT INTO memberships (project_id, user_id, role)
		VALUES ($1::uuid, $2::uuid, $3)
		ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
		f.projectID, f.userID, role); err != nil {
		t.Fatalf("seed membership: %v", err)
	}
	t.Cleanup(func() {
		if _, err := f.pool.Exec(context.Background(),
			`DELETE FROM memberships WHERE project_id = $1 AND user_id = $2`,
			f.projectID, f.userID); err != nil {
			t.Errorf("cleanup membership: %v", err)
		}
	})
	return api.Caller{UserID: f.userID, OrganizationID: f.orgID}
}

func m4APIAssignments(f *m4Fixture) APIAssignmentStore {
	return APIAssignmentStore{S: &PipelineStore{Pool: f.pool}}
}

// m4APEventCount counts journal rows of one type for the fixture project.
func m4APEventCount(t *testing.T, ctx context.Context, pool *pgxpool.Pool, projectID, typ string) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM domain_events WHERE project_id = $1::uuid AND type = $2`,
		projectID, typ).Scan(&n); err != nil {
		t.Fatalf("count %s events: %v", typ, err)
	}
	return n
}

// m4APIApprovals builds a fixture gate on a live run's node and returns
// (runID, nodeID, approvalID). The gate is seeded through the same table the
// advancer writes, so the adapter reads a row the engine could have opened.
func m4APIApprovals(t *testing.T, ctx context.Context, f *m4Fixture, runID string,
	approverIDs []string) (string, string) {
	t.Helper()
	if len(approverIDs) != 1 {
		t.Fatalf("fixture gate wants exactly one designated approver, got %v", approverIDs)
	}
	node, err := f.runs.InsertNodeExecution(ctx, NewNodeExecution{
		RunID: runID, NodeID: "review_gate", Kind: "human.gate",
		NodeInstanceKey: "/review_gate", ExecutionLocation: "control_plane",
	})
	if err != nil {
		t.Fatalf("InsertNodeExecution: %v", err)
	}
	if _, err := f.runs.SetNodeStatus(ctx, node.ID, NodeStatusInput{
		Status: "waiting", WaitingReason: "approval",
	}); err != nil {
		t.Fatalf("waiting node: %v", err)
	}
	var approvalID string
	if err := f.pool.QueryRow(ctx, `
		INSERT INTO approval_requests
			(organization_id, project_id, run_id, node_execution_id, summary,
			 approver_user_ids, approver_roles, deadline_at)
		VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'm4 api approvals gate',
		        ARRAY[$5::uuid], $6::text[], now() + interval '1 hour')
		RETURNING id`,
		f.orgID, f.projectID, runID, node.ID, f.userID, []string{"maintainer"}).
		Scan(&approvalID); err != nil {
		t.Fatalf("insert gate: %v", err)
	}
	return node.ID, approvalID
}

// TestM4APIApprovalsAssignmentCRUD: routes 17–20 end to end on real rows —
// the pin, the effective ceilings after overrides, the caller's role, and the
// assignment.created / assignment.updated journal rows in the same commit as
// the state they describe.
func TestM4APIApprovalsAssignmentCRUD(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)
	c := m4APMember(t, ctx, f, "maintainer")
	store := m4APIAssignments(f)

	created, err := store.CreateAssignment(ctx, c, f.projectID, api.AssignmentCreateInput{
		PipelineID: f.pipelineID, PinnedRevisionID: f.revisionID,
		MaxConcurrentRuns: 3, BudgetOverrides: json.RawMessage(`{"maxAttempts":4}`),
	})
	if err != nil {
		t.Fatalf("CreateAssignment: %v", err)
	}
	if created.ID == "" || created.Version != 1 || !created.Enabled {
		t.Fatalf("created assignment = %+v", created)
	}
	if created.PinnedRevisionDigest != f.digest {
		t.Errorf("pinned revision digest = %q, want %q", created.PinnedRevisionDigest, f.digest)
	}
	if created.MyRole != "maintainer" {
		t.Errorf("MyRole = %q, want maintainer", created.MyRole)
	}
	if !strings.Contains(string(created.EffectiveBudgets), `"maxAttempts":4`) {
		t.Errorf("effective budgets = %s, want the override lowered maxAttempts to 4", created.EffectiveBudgets)
	}
	if n := m4APEventCount(t, ctx, f.pool, f.projectID, events.TypeAssignmentCreated); n != 1 {
		t.Errorf("assignment.created rows = %d, want 1 (state + journal commit together)", n)
	}

	// A second assignment of one pipeline to one project is the plain 409.
	if _, err := store.CreateAssignment(ctx, c, f.projectID, api.AssignmentCreateInput{
		PipelineID: f.pipelineID, PinnedRevisionID: f.revisionID,
	}); !errors.Is(err, api.ErrAssignmentConflict) {
		t.Errorf("duplicate create err = %v, want ErrAssignmentConflict", err)
	}

	list, err := store.ListAssignments(ctx, c, f.projectID)
	if err != nil {
		t.Fatalf("ListAssignments: %v", err)
	}
	if len(list) != 1 || list[0].ID != created.ID {
		t.Fatalf("ListAssignments = %+v, want the one assignment", list)
	}
	got, err := store.GetAssignment(ctx, c, created.ID)
	if err != nil {
		t.Fatalf("GetAssignment: %v", err)
	}
	if got.MaxConcurrentRuns != 3 {
		t.Errorf("MaxConcurrentRuns = %d, want 3", got.MaxConcurrentRuns)
	}

	// PATCH: enabled=false moves the flag and bumps the version, and the
	// journal row carries only what changed (§ 3 row 36).
	patched, err := store.UpdateAssignment(ctx, c, created.ID, api.AssignmentPatchInput{
		Enabled: ptrTrue(false),
	})
	if err != nil {
		t.Fatalf("UpdateAssignment: %v", err)
	}
	if patched.Enabled || patched.Version != 2 {
		t.Fatalf("patched assignment = enabled %v version %d, want false / 2", patched.Enabled, patched.Version)
	}
	if n := m4APEventCount(t, ctx, f.pool, f.projectID, events.TypeAssignmentUpdated); n != 1 {
		t.Errorf("assignment.updated rows = %d, want 1", n)
	}
	var payload []byte
	if err := f.pool.QueryRow(ctx,
		`SELECT payload FROM domain_events WHERE project_id = $1::uuid AND type = $2`,
		f.projectID, events.TypeAssignmentUpdated).Scan(&payload); err != nil {
		t.Fatalf("read assignment.updated payload: %v", err)
	}
	var updated events.AssignmentUpdatedPayload
	if err := json.Unmarshal(payload, &updated); err != nil {
		t.Fatalf("decode assignment.updated payload %s: %v", payload, err)
	}
	if len(updated.Before) != 1 || updated.Before["enabled"] != true {
		t.Errorf("before = %v, want exactly {enabled: true}", updated.Before)
	}
	if len(updated.After) != 1 || updated.After["enabled"] != false {
		t.Errorf("after = %v, want exactly {enabled: false}", updated.After)
	}
	if updated.RevisionDigest != f.digest || updated.MaxConcurrentRuns != 3 {
		t.Errorf("updated payload pin = %q/%d, want %q/3",
			updated.RevisionDigest, updated.MaxConcurrentRuns, f.digest)
	}

	// DELETE detaches referencing runs rather than refusing (route 20's
	// promise), and the row is gone behind the not-found sentinel.
	runID := f.m4QueuedRun(t, ctx, "", 0)
	if _, err := f.pool.Exec(ctx,
		`UPDATE runs SET assignment_id = $1::uuid WHERE id = $2::uuid`, created.ID, runID); err != nil {
		t.Fatalf("attach run to assignment: %v", err)
	}
	if err := store.DeleteAssignment(ctx, c, created.ID); err != nil {
		t.Fatalf("DeleteAssignment: %v", err)
	}
	var attached any
	if err := f.pool.QueryRow(ctx,
		`SELECT assignment_id FROM runs WHERE id = $1::uuid`, runID).Scan(&attached); err != nil {
		t.Fatalf("read run assignment_id: %v", err)
	}
	if attached != nil {
		t.Errorf("run assignment_id = %v after delete, want NULL (the run keeps its pinned revision)", attached)
	}
	if _, err := store.GetAssignment(ctx, c, created.ID); !errors.Is(err, api.ErrAssignmentNotFound) {
		t.Errorf("get after delete err = %v, want ErrAssignmentNotFound", err)
	}
}

// TestM4APIApprovalsAssignmentStaleVersion: route 19 is a CAS on version. The
// loser of a concurrent PATCH gets 409 carrying the winner's version — never
// a silent overwrite of the row that moved first.
func TestM4APIApprovalsAssignmentStaleVersion(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)
	c := m4APMember(t, ctx, f, "maintainer")
	store := m4APIAssignments(f)

	created, err := store.CreateAssignment(ctx, c, f.projectID, api.AssignmentCreateInput{
		PipelineID: f.pipelineID, PinnedRevisionID: f.revisionID, MaxConcurrentRuns: 2,
	})
	if err != nil {
		t.Fatalf("CreateAssignment: %v", err)
	}
	// The winner's PATCH lands first.
	one := 5
	if _, err := store.updateWithVersion(ctx, c, created.ID,
		api.AssignmentPatchInput{MaxConcurrentRuns: &one}, created.Version); err != nil {
		t.Fatalf("winner patch: %v", err)
	}
	// The loser arrives holding the version it read before the winner landed.
	two := 6
	_, err = store.updateWithVersion(ctx, c, created.ID,
		api.AssignmentPatchInput{MaxConcurrentRuns: &two}, created.Version)
	var conflict *api.RunConflictError
	if !errors.As(err, &conflict) {
		t.Fatalf("stale patch err = %v, want *api.RunConflictError", err)
	}
	if conflict.Kind != "assignment_stale_version" {
		t.Errorf("conflict kind = %q, want assignment_stale_version", conflict.Kind)
	}
	if !strings.Contains(conflict.Detail, "version 2, not 1") {
		t.Errorf("conflict detail = %q, want it to carry the winner's version 2", conflict.Detail)
	}
	// The loser wrote nothing: not the row, not the journal.
	got, err := store.GetAssignment(ctx, c, created.ID)
	if err != nil {
		t.Fatalf("GetAssignment: %v", err)
	}
	if got.MaxConcurrentRuns != 5 || got.Version != 2 {
		t.Errorf("after the losing patch: max_concurrent_runs %d version %d, want 5 / 2",
			got.MaxConcurrentRuns, got.Version)
	}
	if n := m4APEventCount(t, ctx, f.pool, f.projectID, events.TypeAssignmentUpdated); n != 1 {
		t.Errorf("assignment.updated rows = %d, want 1 (the loser journals nothing)", n)
	}
}

// TestM4APIApprovalsBudgetOverridesMayOnlyLower: § 2 route 18 — an assignment
// is a governor, not an upgrade path.
func TestM4APIApprovalsBudgetOverridesMayOnlyLower(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)
	c := m4APMember(t, ctx, f, "maintainer")
	store := m4APIAssignments(f)

	_, err := store.CreateAssignment(ctx, c, f.projectID, api.AssignmentCreateInput{
		PipelineID: f.pipelineID, PinnedRevisionID: f.revisionID,
		BudgetOverrides: json.RawMessage(`{"maxAttempts":99}`),
	})
	if !errors.Is(err, api.ErrBudgetOverridesRaise) {
		t.Fatalf("raising override err = %v, want ErrBudgetOverridesRaise", err)
	}
	created, err := store.CreateAssignment(ctx, c, f.projectID, api.AssignmentCreateInput{
		PipelineID: f.pipelineID, PinnedRevisionID: f.revisionID,
	})
	if err != nil {
		t.Fatalf("CreateAssignment: %v", err)
	}
	lower := json.RawMessage(`{"maxAttempts":1}`)
	if _, err := store.UpdateAssignment(ctx, c, created.ID,
		api.AssignmentPatchInput{BudgetOverrides: &lower}); err != nil {
		t.Fatalf("lowering patch: %v", err)
	}
	if _, err := store.UpdateAssignment(ctx, c, created.ID, api.AssignmentPatchInput{
		BudgetOverrides: jsonRawPtr(`{"maxAttempts":99}`)}); !errors.Is(err, api.ErrBudgetOverridesRaise) {
		t.Errorf("raising patch err = %v, want ErrBudgetOverridesRaise", err)
	}
	if n := m4APEventCount(t, ctx, f.pool, f.projectID, events.TypeAssignmentCreated); n != 1 {
		t.Errorf("assignment.created rows = %d, want 1 (the refused create journaled nothing)", n)
	}
}

// TestM4APIApprovalsCrossOrgNotFound: an id of another organization answers
// the not-found sentinel — byte-identical to nonsense — and RecordDenied
// still audits the attempt against the caller's own organization.
func TestM4APIApprovalsCrossOrgNotFound(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)
	c := m4APMember(t, ctx, f, "maintainer")
	store := m4APIAssignments(f)

	created, err := store.CreateAssignment(ctx, c, f.projectID, api.AssignmentCreateInput{
		PipelineID: f.pipelineID, PinnedRevisionID: f.revisionID,
	})
	if err != nil {
		t.Fatalf("CreateAssignment: %v", err)
	}
	otherOrg := f.m4OtherOrg(t, ctx)

	_, err = store.GetAssignment(ctx, otherOrg, created.ID)
	if !errors.Is(err, api.ErrAssignmentNotFound) {
		t.Errorf("cross-org get err = %v, want ErrAssignmentNotFound", err)
	}
	if _, err := store.UpdateAssignment(ctx, otherOrg, created.ID, api.AssignmentPatchInput{
		Enabled: ptrTrue(false)}); !errors.Is(err, api.ErrAssignmentNotFound) {
		t.Errorf("cross-org patch err = %v, want ErrAssignmentNotFound", err)
	}
	if err := store.DeleteAssignment(ctx, otherOrg, created.ID); !errors.Is(err, api.ErrAssignmentNotFound) {
		t.Errorf("cross-org delete err = %v, want ErrAssignmentNotFound", err)
	}
	if n := m4APCount(t, ctx, f.pool, `assignments`); n != 1 {
		t.Errorf("assignments rows = %d, want 1 (a refusal deletes nothing)", n)
	}
	// The stream adapter's answer is the same sentinel for the same caller.
	approvals := APIApprovalStore{R: NewRuntimeStore(f.pool, nil)}
	if _, err := approvals.GetApproval(ctx, otherOrg, "00000000-0000-0000-0000-000000000000"); !errors.Is(err, api.ErrApprovalNotFound) {
		t.Errorf("unknown gate err = %v, want ErrApprovalNotFound", err)
	}
}

// TestM4APIApprovalsDecidedTwiceOneWinner: 12 case 9 / C9d. Two designated
// approvers both hold version 1; exactly one decision lands, the other is
// approval_already_decided carrying the winner, and the journal has ONE
// approval.decided row.
func TestM4APIApprovalsDecidedTwiceOneWinner(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)
	c := m4APMember(t, ctx, f, "maintainer")
	runID := f.m4QueuedRun(t, ctx, "", 0)
	_, approvalID := m4APIApprovals(t, ctx, f, runID, []string{f.userID})

	approvals := APIApprovalStore{R: NewRuntimeStore(f.pool, nil)}
	authorize := func(ap api.ApprovalView, decider string) (bool, string) {
		for _, uid := range ap.ApproverUserIDs {
			if uid == decider {
				return true, ""
			}
		}
		return false, api.ApprovalDeniedNotDesignated
	}

	winner, err := approvals.DecideApproval(ctx, c, approvalID, "approved", "ship it", 1, authorize)
	if err != nil {
		t.Fatalf("first decide: %v", err)
	}
	if winner.State != "decided" || derefStr(winner.Decision) != "approved" || winner.Version != 2 {
		t.Fatalf("winner view = state %q decision %q version %d",
			winner.State, derefStr(winner.Decision), winner.Version)
	}
	if derefStr(winner.Comments) != "ship it" {
		t.Errorf("comments = %q, want them stored on the gate", derefStr(winner.Comments))
	}

	// The loser arrives with the same version it read before the decision.
	_, err = approvals.DecideApproval(ctx, c, approvalID, "rejected", "", 1, authorize)
	var conflict *api.ApprovalConflictError
	if !errors.As(err, &conflict) {
		t.Fatalf("second decide err = %v, want *api.ApprovalConflictError", err)
	}
	if conflict.Kind != api.ApprovalDeniedAlreadyDecided {
		t.Errorf("conflict kind = %q, want %q", conflict.Kind, api.ApprovalDeniedAlreadyDecided)
	}
	if conflict.State != "decided" || conflict.Decision != "approved" || conflict.Version != 2 {
		t.Errorf("conflict carries winner state %q decision %q version %d, want decided/approved/2",
			conflict.State, conflict.Decision, conflict.Version)
	}
	if conflict.DecidedBy != f.userID {
		t.Errorf("conflict decider = %q, want the winner %q", conflict.DecidedBy, f.userID)
	}

	// The gate says approved once, and the journal says decided once.
	var decisions int
	if err := f.pool.QueryRow(ctx,
		`SELECT count(*) FROM approval_requests WHERE id = $1::uuid AND decision = 'approved'`,
		approvalID).Scan(&decisions); err != nil {
		t.Fatalf("count gate decisions: %v", err)
	}
	if decisions != 1 {
		t.Errorf("gates decided 'approved' = %d, want 1", decisions)
	}
	if n := m4APEventCount(t, ctx, f.pool, f.projectID, events.TypeApprovalDecided); n != 1 {
		t.Errorf("approval.decided rows = %d, want 1 (exactly one winner)", n)
	}
	if n := m4APEventCount(t, ctx, f.pool, f.projectID, events.TypeApprovalDenied); n != 0 {
		t.Errorf("approval.denied rows = %d, want 0 (a CAS miss journals nothing)", n)
	}
}

// TestM4APIApprovalsRefusalLeavesGatePending: 12 case 9c — a decider who lost
// access (or was never designated) is refused, the denial is journaled, and
// the gate keeps waiting at its old version.
func TestM4APIApprovalsRefusalLeavesGatePending(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)
	c := m4APMember(t, ctx, f, "maintainer")
	runID := f.m4QueuedRun(t, ctx, "", 0)
	_, approvalID := m4APIApprovals(t, ctx, f, runID, []string{f.userID})

	approvals := APIApprovalStore{R: NewRuntimeStore(f.pool, nil)}
	authorize := func(api.ApprovalView, string) (bool, string) {
		return false, api.ApprovalDeniedLostAccess
	}
	_, err := approvals.DecideApproval(ctx, c, approvalID, "approved", "", 1, authorize)
	var conflict *api.ApprovalConflictError
	if !errors.As(err, &conflict) {
		t.Fatalf("refused decide err = %v, want *api.ApprovalConflictError", err)
	}
	if conflict.Kind != api.ApprovalDeniedLostAccess {
		t.Errorf("refusal kind = %q, want %q", conflict.Kind, api.ApprovalDeniedLostAccess)
	}
	var state, version int
	if err := f.pool.QueryRow(ctx, `
		SELECT count(*) FROM approval_requests WHERE id = $1::uuid AND state = 'pending' AND version = 1`,
		approvalID).Scan(&state); err != nil {
		t.Fatalf("read gate after refusal: %v", err)
	}
	if state != 1 {
		t.Errorf("gate after refusal: rows pending at version 1 = %d, want 1 (a refusal is not a decision)", version)
	}
	if n := m4APEventCount(t, ctx, f.pool, f.projectID, events.TypeApprovalDenied); n != 1 {
		t.Errorf("approval.denied rows = %d, want 1", n)
	}
	if n := m4APEventCount(t, ctx, f.pool, f.projectID, events.TypeApprovalDecided); n != 0 {
		t.Errorf("approval.decided rows = %d, want 0", n)
	}
}

// TestM4APIApprovalsListOrderAndVisibility: route 34's order (pending by
// deadline first, decided history newest first) and the caller's role on the
// view.
func TestM4APIApprovalsListOrderAndVisibility(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)
	c := m4APMember(t, ctx, f, "viewer")
	runID := f.m4QueuedRun(t, ctx, "", 0)
	_, urgent := m4APIApprovals(t, ctx, f, runID, []string{f.userID})
	if _, err := f.pool.Exec(ctx,
		`UPDATE approval_requests SET deadline_at = now() + interval '5 minutes' WHERE id = $1::uuid`,
		urgent); err != nil {
		t.Fatalf("tighten deadline: %v", err)
	}
	_, later := m4APIApprovalsNode(t, ctx, f, runID, "/review_second", "review_second")
	_ = later

	approvals := APIApprovalStore{R: NewRuntimeStore(f.pool, nil)}
	list, err := approvals.ListProjectApprovals(ctx, c, f.projectID)
	if err != nil {
		t.Fatalf("ListProjectApprovals: %v", err)
	}
	if len(list) < 1 {
		t.Fatalf("ListProjectApprovals = %+v, want the fixture gates", list)
	}
	if list[0].ID != urgent {
		t.Errorf("first gate = %s, want the one about to expire (%s)", list[0].ID, urgent)
	}
	if list[0].MyRole != "viewer" {
		t.Errorf("MyRole = %q, want viewer (the caller's current role rides the view)", list[0].MyRole)
	}
	if len(list[0].ApproverUserIDs) != 1 || list[0].ApproverUserIDs[0] != f.userID {
		t.Errorf("ApproverUserIDs = %v, want [%s]", list[0].ApproverUserIDs, f.userID)
	}
	if len(list[0].ApproverRoles) != 1 || list[0].ApproverRoles[0] != "maintainer" {
		t.Errorf("ApproverRoles = %v, want [maintainer]", list[0].ApproverRoles)
	}
	// A caller outside the organization sees nothing at all.
	other := f.m4OtherOrg(t, ctx)
	hidden, err := approvals.ListProjectApprovals(ctx, other, f.projectID)
	if err != nil {
		t.Fatalf("cross-org ListProjectApprovals: %v", err)
	}
	if len(hidden) != 0 {
		t.Errorf("cross-org list = %+v, want empty", hidden)
	}
}

// m4APIApprovalsNode seeds a second gate on a distinct node of the run.
func m4APIApprovalsNode(t *testing.T, ctx context.Context, f *m4Fixture, runID, key, nodeID string) (string, string) {
	t.Helper()
	node, err := f.runs.InsertNodeExecution(ctx, NewNodeExecution{
		RunID: runID, NodeID: nodeID, Kind: "human.gate",
		NodeInstanceKey: key, ExecutionLocation: "control_plane",
	})
	if err != nil {
		t.Fatalf("InsertNodeExecution %s: %v", key, err)
	}
	var approvalID string
	if err := f.pool.QueryRow(ctx, `
		INSERT INTO approval_requests
			(organization_id, project_id, run_id, node_execution_id, summary, deadline_at)
		VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'm4 api approvals gate 2',
		        now() + interval '3 hours')
		RETURNING id`, f.orgID, f.projectID, runID, node.ID).Scan(&approvalID); err != nil {
		t.Fatalf("insert second gate: %v", err)
	}
	return node.ID, approvalID
}

// m4APCount counts rows in one table.
func m4APCount(t *testing.T, ctx context.Context, pool *pgxpool.Pool, table string) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM "+table).Scan(&n); err != nil {
		t.Fatalf("count %s: %v", table, err)
	}
	return n
}

func jsonRawPtr(s string) *json.RawMessage {
	raw := json.RawMessage(s)
	return &raw
}

func ptrTrue(b bool) *bool { return &b }

// m4OtherOrg seeds a second organization and returns a caller who is a member
// of nothing in this one: every id the fixture owns must answer not-found.
func (f *m4Fixture) m4OtherOrg(t *testing.T, ctx context.Context) api.Caller {
	t.Helper()
	token := migFixtureToken(t)
	var orgID, userID string
	if err := f.pool.QueryRow(ctx, `
		INSERT INTO organizations (slug, name) VALUES ('m4-ap-org-' || $1, 'm4 api approvals other')
		RETURNING id`, token).Scan(&orgID); err != nil {
		t.Fatalf("seed other org: %v", err)
	}
	if err := f.pool.QueryRow(ctx, `
		INSERT INTO users (organization_id, display_name) VALUES ($1, 'm4-ap-other-' || $2)
		RETURNING id`, orgID, token).Scan(&userID); err != nil {
		t.Fatalf("seed other user: %v", err)
	}
	t.Cleanup(func() {
		bg := context.Background()
		if _, err := f.pool.Exec(bg, `DELETE FROM users WHERE id = $1`, userID); err != nil {
			t.Errorf("cleanup other user: %v", err)
		}
		if _, err := f.pool.Exec(bg, `DELETE FROM organizations WHERE id = $1`, orgID); err != nil {
			t.Errorf("cleanup other org: %v", err)
		}
	})
	return api.Caller{UserID: userID, OrganizationID: orgID}
}
