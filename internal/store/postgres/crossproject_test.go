package postgres

// TestCrossProject*: the cross-project reads (ADR-0047, contract C3) over a
// database that actually ran 00005. Integration layer: two projects in one
// organization where the caller is a member of only the first, and every
// assertion reads rows a real Postgres wrote — the visibility leg is checked
// against the second project's real rows, never against a mock that agrees
// to forget.

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dbirks/communication/internal/api"
)

// xpFixture is the two-project shape: project B and its user exist in the
// same organization, but the caller is a member of project A ONLY — exactly
// the shape a Home/Board/Threads request arrives in.
type xpFixture struct {
	f        *m4Fixture
	projectB string
	userB    string
	profile  string
	caller   api.Caller
	store    APICrossProjectStore
}

func xpSetup(t *testing.T) *xpFixture {
	t.Helper()
	ctx := testCtx(t)
	f := m4Setup(t)
	fx := &xpFixture{f: f, store: APICrossProjectStore{Pool: f.pool}}

	if err := f.pool.QueryRow(ctx, `
		INSERT INTO users (organization_id, display_name)
		VALUES ($1, 'xp-user-b-' || $2) RETURNING id`, f.orgID, migFixtureToken(t)).
		Scan(&fx.userB); err != nil {
		t.Fatalf("insert user B: %v", err)
	}
	if err := f.pool.QueryRow(ctx, `
		INSERT INTO projects (organization_id, slug, name, created_by)
		VALUES ($1, 'xp-proj-b-' || $2, 'XP project B', $3) RETURNING id`,
		f.orgID, migFixtureToken(t), fx.userB).Scan(&fx.projectB); err != nil {
		t.Fatalf("insert project B: %v", err)
	}
	if err := f.pool.QueryRow(ctx, `
		INSERT INTO agent_profiles (organization_id, name, launcher_id)
		VALUES ($1, 'xp-profile-' || $2, 'claude') RETURNING id`,
		f.orgID, migFixtureToken(t)).Scan(&fx.profile); err != nil {
		t.Fatalf("insert agent profile: %v", err)
	}
	// The caller's ONLY membership: project A.
	if _, err := f.pool.Exec(ctx, `
		INSERT INTO memberships (project_id, user_id, role)
		VALUES ($1::uuid, $2::uuid, 'maintainer')`, f.projectID, f.userID); err != nil {
		t.Fatalf("seed membership A: %v", err)
	}
	fx.caller = api.Caller{UserID: f.userID, OrganizationID: f.orgID}

	bg := context.Background()
	t.Cleanup(func() {
		steps := []struct {
			sql  string
			args []any
		}{
			{`DELETE FROM conversation_control WHERE conversation_id IN
				(SELECT id FROM conversations WHERE project_id IN ($1, $2))`,
				[]any{f.projectID, fx.projectB}},
			{`DELETE FROM conversations WHERE project_id IN ($1, $2)`,
				[]any{f.projectID, fx.projectB}},
			{`DELETE FROM approval_requests WHERE run_id IN
				(SELECT id FROM runs WHERE project_id IN ($1, $2))`, []any{f.projectID, fx.projectB}},
			{`DELETE FROM node_executions WHERE run_id IN
				(SELECT id FROM runs WHERE project_id IN ($1, $2))`, []any{f.projectID, fx.projectB}},
			{`DELETE FROM run_inputs WHERE run_id IN
				(SELECT id FROM runs WHERE project_id IN ($1, $2))`, []any{f.projectID, fx.projectB}},
			{`DELETE FROM runs WHERE project_id IN ($1, $2)`, []any{f.projectID, fx.projectB}},
			{`DELETE FROM memberships WHERE project_id = $1 AND user_id = $2`,
				[]any{f.projectID, f.userID}},
			{`DELETE FROM projects WHERE id = $1`, []any{fx.projectB}},
			{`DELETE FROM agent_profile_versions WHERE profile_id = $1`, []any{fx.profile}},
			{`DELETE FROM agent_profiles WHERE id = $1`, []any{fx.profile}},
			{`DELETE FROM users WHERE id = $1`, []any{fx.userB}},
		}
		for _, step := range steps {
			if _, err := f.pool.Exec(bg, step.sql, step.args...); err != nil {
				t.Errorf("cleanup %q: %v", step.sql, err)
			}
		}
	})
	return fx
}

// xpPlanSnapshot is a pinned revision whose root scope lists the top-level
// nodes in definition order, plus one nested node that must NOT surface.
func xpPlanSnapshot(topLevel []struct {
	id, kind string
}) json.RawMessage {
	nodes := make([]map[string]string, 0, len(topLevel)+1)
	for _, n := range topLevel {
		nodes = append(nodes, map[string]string{"id": n.id, "kind": n.kind, "scope": "/"})
	}
	// A loop body node: real data carries it under the loop's scope key.
	nodes = append(nodes, map[string]string{"id": "inner", "kind": "agent", "scope": "/loop/"})
	var doc struct {
		Nodes []map[string]string `json:"nodes"`
	}
	doc.Nodes = nodes
	raw, err := json.Marshal(doc)
	if err != nil {
		panic(err)
	}
	return raw
}

// xpSeedRun creates a run in the named project pinned to a snapshot with the
// given top-level nodes, then materializes one node execution per entry in
// nodeStatuses (missing node = no row = pending). triggeredBy "" ⇒ NULL.
func (fx *xpFixture) xpSeedRun(t *testing.T, projectID string, triggeredBy string,
	topLevel []struct {
		id, kind string
	}, nodeStatuses map[string]string) string {
	t.Helper()
	ctx := testCtx(t)
	run, _, err := fx.f.runs.CreateRun(ctx, NewRun{
		OrganizationID: fx.f.orgID, ProjectID: projectID, PipelineID: fx.f.pipelineID,
		PipelineRevisionID: fx.f.revisionID, RevisionDigest: fx.f.digest,
		PlanDigest:       fx.f.planDigest,
		PlanSnapshot:     xpPlanSnapshot(topLevel),
		PoliciesSnapshot: json.RawMessage(`{}`),
		RepoSnapshot:     json.RawMessage(`[]`),
		TriggeredBy:      triggeredBy,
	})
	if err != nil {
		t.Fatalf("CreateRun: %v", err)
	}
	for nodeID, status := range nodeStatuses {
		if _, err := fx.f.runs.InsertNodeExecution(ctx, NewNodeExecution{
			RunID: run.ID, NodeID: nodeID, Kind: "agent",
			NodeInstanceKey: "/" + nodeID, ScopeKey: "/",
			ExecutionLocation: "worker",
		}); err != nil {
			t.Fatalf("InsertNodeExecution %s: %v", nodeID, err)
		}
		xpSetNodeStatus(t, fx.f.pool, run.ID, nodeID, status)
	}
	return run.ID
}

// xpSetNodeStatus moves a row to its wanted status with the timestamps the
// CHECKs demand (terminal ⇒ finished_at; not-pending ⇒ ready_at).
func xpSetNodeStatus(t *testing.T, pool *pgxpool.Pool, runID, nodeID, status string) {
	t.Helper()
	ctx := testCtx(t)
	terminal := "false"
	switch status {
	case "succeeded", "skipped", "cancelled", "failed", "interrupted":
		terminal = "true"
	}
	// Every non-pending status carries ready_at (the CHECK), and only a
	// terminal one carries finished_at.
	tag, err := pool.Exec(ctx, `
		UPDATE node_executions
		SET status = $3,
		    ready_at = CASE WHEN $3 = 'pending' THEN ready_at ELSE now() END,
		    finished_at = CASE WHEN $4::boolean THEN now() ELSE NULL END
		WHERE run_id = $1::uuid AND node_id = $2`, runID, nodeID, status, terminal)
	if err != nil {
		t.Fatalf("set node %s to %s: %v", nodeID, status, err)
	}
	if tag.RowsAffected() != 1 {
		t.Fatalf("set node %s: %d rows, want 1", nodeID, tag.RowsAffected())
	}
}

// xpSeedApproval adds a pending gate against the run's node execution.
func (fx *xpFixture) xpSeedApproval(t *testing.T, projectID, runID, nodeID, summary string) {
	t.Helper()
	ctx := testCtx(t)
	var nodeExecID string
	if err := fx.f.pool.QueryRow(ctx, `
		SELECT id FROM node_executions WHERE run_id = $1::uuid AND node_id = $2`,
		runID, nodeID).Scan(&nodeExecID); err != nil {
		t.Fatalf("lookup node execution: %v", err)
	}
	if _, err := fx.f.pool.Exec(ctx, `
		INSERT INTO approval_requests (project_id, run_id, node_execution_id, summary,
		                                deadline_at, organization_id)
		VALUES ($1::uuid, $2::uuid, $3::uuid, $4, now() + interval '1 day', $5::uuid)`,
		projectID, runID, nodeExecID, summary, fx.f.orgID); err != nil {
		t.Fatalf("seed approval: %v", err)
	}
}

// xpSeedConversation adds a manual conversation (control row included).
func (fx *xpFixture) xpSeedConversation(t *testing.T, projectID, title string) string {
	t.Helper()
	ctx := testCtx(t)
	var convID string
	if err := fx.f.pool.QueryRow(ctx, `
		INSERT INTO conversations (project_id, agent_profile_id, title, created_by)
		VALUES ($1::uuid, $2::uuid, $3, $4::uuid) RETURNING id`,
		projectID, fx.profile, title, fx.f.userID).Scan(&convID); err != nil {
		t.Fatalf("insert conversation: %v", err)
	}
	if _, err := fx.f.pool.Exec(ctx, `
		INSERT INTO conversation_control (conversation_id, controller_kind, controller_user_id)
		VALUES ($1::uuid, 'human', $2::uuid)`, convID, fx.f.userID); err != nil {
		t.Fatalf("insert control: %v", err)
	}
	return convID
}

// TestCrossProjectRunsVisibility proves the membership predicate and the
// step projection against real rows: the caller is a member of A only, and
// A's run — with its pinned top-level nodes and their execution states —
// must come back complete while B's run is absent.
func TestCrossProjectRunsVisibility(t *testing.T) {
	fx := xpSetup(t)
	ctx := testCtx(t)

	topLevel := []struct{ id, kind string }{
		{"plan", "gate"}, {"implement", "agent"}, {"review", "gate"},
	}
	runA := fx.xpSeedRun(t, fx.f.projectID, fx.f.userID, topLevel, map[string]string{
		"plan": "succeeded", "implement": "running", // review: no row = pending
	})
	runB := fx.xpSeedRun(t, fx.projectB, fx.userB, topLevel, map[string]string{
		"plan": "succeeded", "implement": "failed", "review": "waiting",
	})

	views, next, err := fx.store.ListVisibleRuns(ctx, fx.caller,
		api.CrossProjectRunsFilter{Limit: api.CrossProjectDefaultLimit})
	if err != nil {
		t.Fatalf("ListVisibleRuns: %v", err)
	}
	if next != "" {
		t.Fatalf("next_cursor = %q on a one-row page", next)
	}
	if len(views) != 1 {
		t.Fatalf("len(views) = %d, want exactly A's run (B is invisible): %+v",
			len(views), views)
	}
	v := views[0]
	if v.ID != runA || v.ProjectID != fx.f.projectID {
		t.Fatalf("row = %s/%s, want A's run %s", v.ID, v.ProjectID, runA)
	}
	if v.ProjectName != "M4 fixture" || v.PipelineDisplayName == "" {
		t.Fatalf("names = %q/%q: the human names ride the row",
			v.ProjectName, v.PipelineDisplayName)
	}
	if v.TriggeredBy == nil || *v.TriggeredBy != fx.f.userID {
		t.Fatalf("triggered_by = %v, want the caller's id (the mine filter's column must ride the row)",
			v.TriggeredBy)
	}
	wantSteps := []struct{ id, state string }{
		{"plan", "succeeded"}, {"implement", "running"}, {"review", "pending"},
	}
	if len(v.Steps) != len(wantSteps) {
		t.Fatalf("steps = %+v, want %d top-level steps (the loop body's 'inner' node never surfaces)",
			v.Steps, len(wantSteps))
	}
	for i, want := range wantSteps {
		got := v.Steps[i]
		if got.NodeID != want.id || got.State != want.state {
			t.Fatalf("step %d = %s/%s, want %s/%s (definition order, projected states)",
				i, got.NodeID, got.State, want.id, want.state)
		}
	}
	_ = runB
}

// TestCrossProjectRunsFiltersAndPagination proves the board's filters
// (status, project, mine, updated_since) and keyset paging: a cursor from
// page 1 walks to exactly the remaining rows, and an invisible project_id
// filter answers an empty page rather than a 404.
func TestCrossProjectRunsFiltersAndPagination(t *testing.T) {
	fx := xpSetup(t)
	ctx := testCtx(t)

	topLevel := []struct{ id, kind string }{{"step", "agent"}}
	a1 := fx.xpSeedRun(t, fx.f.projectID, fx.f.userID, topLevel,
		map[string]string{"step": "running"})
	// A system start (no triggered_by): it is never "mine".
	a2 := fx.xpSeedRun(t, fx.f.projectID, "", topLevel,
		map[string]string{"step": "succeeded"})
	// Another user's run, FAILED: the status filter's row.
	a3 := fx.xpSeedRun(t, fx.f.projectID, fx.userB, topLevel,
		map[string]string{"step": "failed"})
	if _, err := fx.f.runs.SetRunStatus(ctx, a3, RunStatusInput{
		Status: "failed", FailedCause: "node_execution_failed:/step",
	}); err != nil {
		t.Fatalf("fail run %s: %v", a3, err)
	}
	b1 := fx.xpSeedRun(t, fx.projectB, fx.userB, topLevel,
		map[string]string{"step": "running"})

	all, _, err0 := fx.store.ListVisibleRuns(ctx, fx.caller,
		api.CrossProjectRunsFilter{Limit: api.CrossProjectDefaultLimit})
	if err0 != nil {
		t.Fatalf("ListVisibleRuns: %v", err0)
	}
	if len(all) != 3 {
		t.Fatalf("len = %d, want A's three runs (B's absent): %+v", len(all), all)
	}
	allIDs := map[string]bool{}
	for _, v := range all {
		allIDs[v.ID] = true
	}
	if !allIDs[a1] || !allIDs[a2] || !allIDs[a3] || allIDs[b1] {
		t.Fatalf("ids = %v: A's three runs (incl. the system start %s), B's %s absent",
			allIDs, a2, b1)
	}

	mine, _, err := fx.store.ListVisibleRuns(ctx, fx.caller,
		api.CrossProjectRunsFilter{Mine: true})
	if err != nil {
		t.Fatalf("mine: %v", err)
	}
	if len(mine) != 1 || mine[0].ID != a1 {
		t.Fatalf("mine = %d rows, want only %s (the system start and %s are not the caller's)",
			len(mine), a1, a3)
	}

	byStatus, _, err := fx.store.ListVisibleRuns(ctx, fx.caller,
		api.CrossProjectRunsFilter{Statuses: []string{"failed"}})
	if err != nil {
		t.Fatalf("status: %v", err)
	}
	if len(byStatus) != 1 || byStatus[0].ID != a3 {
		t.Fatalf("status=failed = %+v, want only %s", byStatus, a3)
	}

	byProject, _, err := fx.store.ListVisibleRuns(ctx, fx.caller,
		api.CrossProjectRunsFilter{ProjectID: fx.projectB})
	if err != nil {
		t.Fatalf("project filter: %v", err)
	}
	if len(byProject) != 0 {
		t.Fatalf("project_id=B returned %d rows: an invisible project's filter is an empty page, not a 404",
			len(byProject))
	}
	since := time.Now().UTC().Add(-time.Hour)
	updated, _, err := fx.store.ListVisibleRuns(ctx, fx.caller,
		api.CrossProjectRunsFilter{UpdatedSince: &since})
	if err != nil {
		t.Fatalf("updated_since: %v", err)
	}
	if len(updated) != 3 {
		t.Fatalf("updated_since = %d rows, want the three just-created runs", len(updated))
	}

	// Keyset paging: page size 2 over the 3 A-runs (newest first).
	page1, next, err := fx.store.ListVisibleRuns(ctx, fx.caller,
		api.CrossProjectRunsFilter{Limit: 2})
	if err != nil {
		t.Fatalf("page 1: %v", err)
	}
	if len(page1) != 2 || next == "" {
		t.Fatalf("page 1 = %d rows next=%q: a full page must carry a cursor", len(page1), next)
	}
	page2, next2, err := fx.store.ListVisibleRuns(ctx, fx.caller,
		api.CrossProjectRunsFilter{Limit: 2, Cursor: next})
	if err != nil {
		t.Fatalf("page 2: %v", err)
	}
	if len(page2) != 1 || next2 != "" || page2[0].ID == page1[0].ID || page2[0].ID == page1[1].ID {
		t.Fatalf("page 2 = %+v next=%q: exactly the remaining row, no overlap", page2, next2)
	}
}

// TestCrossProjectApprovalsVisibility: the caller's gates across all their
// projects — A's pending gate comes back (with project_id and run_id on the
// existing schema), B's does not, and the status filter answers only the
// gates in that state.
func TestCrossProjectApprovalsVisibility(t *testing.T) {
	fx := xpSetup(t)
	ctx := testCtx(t)
	topLevel := []struct{ id, kind string }{{"review", "gate"}}
	runA := fx.xpSeedRun(t, fx.f.projectID, fx.f.userID, topLevel,
		map[string]string{"review": "waiting"})
	runB := fx.xpSeedRun(t, fx.projectB, fx.userB, topLevel,
		map[string]string{"review": "waiting"})
	fx.xpSeedApproval(t, fx.f.projectID, runA, "review", "approve A's plan")
	fx.xpSeedApproval(t, fx.projectB, runB, "review", "approve B's plan")

	all, err := fx.store.ListVisibleApprovals(ctx, fx.caller, "")
	if err != nil {
		t.Fatalf("ListVisibleApprovals: %v", err)
	}
	if len(all) != 1 || all[0].ProjectID != fx.f.projectID || all[0].RunID != runA {
		t.Fatalf("all = %+v, want exactly A's gate (B invisible)", all)
	}
	if all[0].Summary != "approve A's plan" || all[0].State != "pending" {
		t.Fatalf("gate = %+v: the existing Approval schema rides unchanged", all[0])
	}

	pending, err := fx.store.ListVisibleApprovals(ctx, fx.caller, "pending")
	if err != nil {
		t.Fatalf("pending: %v", err)
	}
	if len(pending) != 1 || pending[0].RunID != runA {
		t.Fatalf("pending = %+v", pending)
	}

	decided, err := fx.store.ListVisibleApprovals(ctx, fx.caller, "decided")
	if err != nil {
		t.Fatalf("decided: %v", err)
	}
	if len(decided) != 0 {
		t.Fatalf("decided = %+v, want none", decided)
	}
}

// TestCrossProjectConversationsVisibility: the thread list across all the
// caller's projects, newest first, with keyset paging — B's conversation is
// never returned.
func TestCrossProjectConversationsVisibility(t *testing.T) {
	fx := xpSetup(t)
	ctx := testCtx(t)
	cA := fx.xpSeedConversation(t, fx.f.projectID, "fix the flake")
	fx.xpSeedConversation(t, fx.f.projectID, "second thread")
	fx.xpSeedConversation(t, fx.projectB, "B's thread")

	all, next, err := fx.store.ListVisibleConversations(ctx, fx.caller,
		api.CrossProjectDefaultLimit, "")
	if err != nil {
		t.Fatalf("ListVisibleConversations: %v", err)
	}
	if len(all) != 2 || next != "" {
		t.Fatalf("len = %d next = %q, want A's two threads and no cursor", len(all), next)
	}
	seen := map[string]bool{}
	for _, v := range all {
		if v.ProjectID != fx.f.projectID || v.Origin != "manual" {
			t.Fatalf("row = %+v: only A's rows, manual origin (no attempt links them)", v)
		}
		seen[v.ID] = true
	}
	if !seen[cA] {
		t.Fatalf("the seeded conversation %s is missing from %v", cA, seen)
	}

	// Keyset paging over the two A-threads.
	page1, next, err := fx.store.ListVisibleConversations(ctx, fx.caller, 1, "")
	if err != nil {
		t.Fatalf("page 1: %v", err)
	}
	if len(page1) != 1 || next == "" {
		t.Fatalf("page 1 = %d next = %q", len(page1), next)
	}
	page2, next2, err := fx.store.ListVisibleConversations(ctx, fx.caller, 1, next)
	if err != nil {
		t.Fatalf("page 2: %v", err)
	}
	if len(page2) != 1 || next2 != "" || page2[0].ID == page1[0].ID {
		t.Fatalf("page 2 = %+v next = %q: exactly the other thread, no overlap", page2, next2)
	}
}

// TestCrossProjectStepStateTable is the projection's mapping table
// (ADR-0047 § 4): every node execution status onto the seven step states,
// and the aggregation precedence over several executions.
func TestCrossProjectStepStateTable(t *testing.T) {
	t.Parallel()
	single := []struct {
		exec string
		want string
	}{
		{"pending", api.CrossProjectStepPending},
		{"ready", api.CrossProjectStepPending},
		{"leased", api.CrossProjectStepPending},
		{"running", api.CrossProjectStepRunning},
		{"waiting", api.CrossProjectStepWaiting},
		{"succeeded", api.CrossProjectStepSucceeded},
		{"failed", api.CrossProjectStepFailed},
		{"interrupted", api.CrossProjectStepFailed},
		{"skipped", api.CrossProjectStepSkipped},
		{"cancelled", api.CrossProjectStepCancelled},
		{"never-heard-of", api.CrossProjectStepPending},
	}
	for _, tc := range single {
		if got := xpStepState(tc.exec); got != tc.want {
			t.Errorf("xpStepState(%q) = %q, want %q", tc.exec, got, tc.want)
		}
	}
	aggregates := []struct {
		in   []string
		want string
	}{
		{nil, api.CrossProjectStepPending},
		{[]string{"succeeded"}, "succeeded"},
		{[]string{"succeeded", "succeeded", "succeeded"}, "succeeded"},
		{[]string{"succeeded", "pending", "failed"}, "failed"}, // failed beats the rest
		{[]string{"succeeded", "running"}, "running"},
		{[]string{"succeeded", "waiting"}, "waiting"},
		{[]string{"succeeded", "cancelled"}, "cancelled"},
		{[]string{"succeeded", "skipped"}, "succeeded"},
		{[]string{"skipped", "skipped"}, "skipped"},
	}
	for i, tc := range aggregates {
		got := xpAggregateStepState(tc.in)
		want := tc.want
		if got != want {
			t.Errorf("aggregate %d (%v) = %q, want %q", i, tc.in, got, want)
		}
	}
	// The loop projection: a run whose loop node ran once, succeeded once and
	// failed once reports the step failed — the loop's fate is the loop node's
	// row(s), never its body.
	if got := xpAggregateStepState([]string{"succeeded", "failed"}); got != api.CrossProjectStepFailed {
		t.Errorf("loop fold = %q, want failed", got)
	}
	// Definition order with a nested node: only scope "/" surfaces.
	snapshot := xpPlanSnapshot([]struct{ id, kind string }{{"a", "agent"}, {"b", "gate"}})
	steps := xpProjectSteps(snapshot, map[string][]string{"a": {"running"}, "inner": {"succeeded"}})
	if len(steps) != 2 || steps[0].NodeID != "a" || steps[0].Kind != "agent" ||
		steps[0].State != api.CrossProjectStepRunning ||
		steps[1].NodeID != "b" || steps[1].State != api.CrossProjectStepPending {
		t.Errorf("steps = %+v: definition order, top-level only, pending without a row", steps)
	}
	// A garbage snapshot (a data bug) must not crash the projection.
	if got := xpProjectSteps([]byte("{not json"), nil); len(got) != 0 {
		t.Errorf("garbage snapshot = %+v, want no steps", got)
	}
}
