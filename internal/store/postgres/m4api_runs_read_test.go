package postgres

// TestM4APIRunsRead*: the READ half of api.RunStore over a database that
// actually ran 00005 (docs/m4-contract.md § 2.1 routes 21/23-27/32, § 5.2).
// Integration layer: every assertion reads rows a real Postgres wrote, and
// the visibility legs are checked against a second organization and a second
// user rather than against a mock that agrees to forget.

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/dbirks/communication/internal/api"
)

// Foreign identities: valid uuids naming nothing in this fixture's
// organization — from the SQL's side, exactly what a cross-org probe looks
// like.
const (
	m4RunsReadForeignOrg  = "0af0df00-0000-4000-8000-0000000000b1"
	m4RunsReadForeignUser = "0af0df00-0000-4000-8000-0000000000b2"
)

// m4RunsReadMember makes the fixture user a project member and returns the
// api caller the tests read as (m4Setup seeds the project with a bare
// INSERT, so the membership is stated, not assumed).
func m4RunsReadMember(t *testing.T, ctx context.Context, f *m4Fixture, role string) api.Caller {
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

// m4RunsReadSeedRun creates a run pinned to the fixture revision and leaves
// it QUEUED (placement's § 5.2 answer is only interesting while the run is
// still waiting for its worker).
func m4RunsReadSeedRun(t *testing.T, ctx context.Context, f *m4Fixture) string {
	t.Helper()
	run, _, err := f.runs.CreateRun(ctx, NewRun{
		OrganizationID: f.orgID, ProjectID: f.projectID, PipelineID: f.pipelineID,
		PipelineRevisionID: f.revisionID, RevisionDigest: f.digest, PlanDigest: f.planDigest,
		PlanSnapshot:     json.RawMessage(`{"nodes":[]}`),
		PoliciesSnapshot: json.RawMessage(`{}`),
		RepoSnapshot:     json.RawMessage(`[{"repository_id":"0af0df00-0000-4000-8000-0000000000b9","base_commit":"abc123"}]`),
		TriggeredBy:      f.userID,
		Inputs:           map[string]RunInput{"brief": {Value: json.RawMessage(`"fix it"`), Origin: "submitted"}},
	})
	if err != nil {
		t.Fatalf("CreateRun: %v", err)
	}
	return run.ID
}

// m4RunsReadAssertNotFound is the uniform-refusal assertion: the api sentinel
// the handler renders as a 404, byte-identical for a foreign row and a
// nonsense uuid.
func m4RunsReadAssertNotFound(t *testing.T, err error, what string) {
	t.Helper()
	if !errors.Is(err, api.ErrRunNotFound) {
		t.Errorf("%s: err = %v, want api.ErrRunNotFound", what, err)
	}
}

// TestM4APIRunsReadGetRun proves route 23's read against real rows: the
// pinned digests and the caller's project role ride the view, the validated
// input is readable with its origin, repo_snapshot is commit identity (never
// a path), and the affinity worker's uuid appears NOWHERE in the serialized
// body — placement is the boolean answer (§ 5.2).
func TestM4APIRunsReadGetRun(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)
	member := m4RunsReadMember(t, ctx, f, "viewer")
	runID := m4RunsReadSeedRun(t, ctx, f)
	store := APIRunStore{Runs: f.runs}

	view, err := store.GetRun(ctx, member, runID)
	if err != nil {
		t.Fatalf("GetRun: %v", err)
	}
	if view.ID != runID || view.ProjectID != f.projectID || view.Status != "queued" {
		t.Errorf("view = %+v, want the seeded queued run %s in project %s", view, runID, f.projectID)
	}
	if view.RevisionDigest != f.digest || view.PlanDigest != f.planDigest {
		t.Errorf("digests = %q/%q, want the pinned %q/%q",
			view.RevisionDigest, view.PlanDigest, f.digest, f.planDigest)
	}
	if view.MyRole != "viewer" {
		t.Errorf("MyRole = %q, want viewer", view.MyRole)
	}
	if view.DigestScope == "" {
		t.Errorf("DigestScope is empty; the revision carries one")
	}
	if len(view.Inputs) != 1 || view.Inputs[0].Name != "brief" ||
		view.Inputs[0].Origin != "submitted" ||
		string(view.Inputs[0].Value) != `"fix it"` {
		t.Errorf("Inputs = %+v, want the one submitted brief row", view.Inputs)
	}
	if len(view.RepoSnapshot) != 1 || view.RepoSnapshot[0].BaseCommit != "abc123" {
		t.Errorf("RepoSnapshot = %+v, want the pinned base commit", view.RepoSnapshot)
	}
	if !view.Placement.Scheduled || view.Placement.Reason != nil {
		t.Errorf("Placement = %+v, want scheduled with no reason for an unaffined queued run", view.Placement)
	}

	// The § 5.2 honest "still queued": affinity to a worker that is not
	// online any more says so in data, and still never names the worker.
	workerID := m4Worker(t, ctx, f.pool, "read-offline", 4)
	if _, err := f.pool.Exec(ctx, `UPDATE workers SET status = 'offline' WHERE id = $1`, workerID); err != nil {
		t.Fatalf("offline worker: %v", err)
	}
	if ok, err := f.runs.SetRunAffinity(ctx, runID, workerID, "vol-read"); err != nil || !ok {
		t.Fatalf("SetRunAffinity: ok=%v err=%v", ok, err)
	}
	view, err = store.GetRun(ctx, member, runID)
	if err != nil {
		t.Fatalf("GetRun after affinity: %v", err)
	}
	if view.Placement.Scheduled || view.Placement.Reason == nil ||
		*view.Placement.Reason != "volume_affinity_unsatisfied" {
		t.Errorf("Placement = %+v, want {false, volume_affinity_unsatisfied}", view.Placement)
	}

	body, err := json.Marshal(view)
	if err != nil {
		t.Fatalf("marshal run view: %v", err)
	}
	if strings.Contains(string(body), workerID) {
		t.Errorf("serialized run view names the affinity worker %s: %s", workerID, body)
	}
	for _, leak := range []string{"worker_affinity", "fencing_token", "lease_expires_at", "worker_id"} {
		if strings.Contains(string(body), leak) {
			t.Errorf("serialized run view carries %q: %s", leak, body)
		}
	}

	// Same uuid, a caller with no membership in the project: the 404 a random
	// uuid produces.
	stranger := api.Caller{UserID: m4RunsReadForeignUser, OrganizationID: f.orgID}
	if _, err := store.GetRun(ctx, stranger, runID); !errors.Is(err, api.ErrRunNotFound) {
		t.Errorf("GetRun as a non-member = %v, want api.ErrRunNotFound", err)
	}
	// And the nonsense uuid answers the same bytes.
	if _, err := store.GetRun(ctx, member, "0af0df00-0000-4000-8000-0000000000zz"); !errors.Is(err, api.ErrRunNotFound) {
		t.Errorf("GetRun of a nonsense id = %v, want api.ErrRunNotFound", err)
	}
}

// TestM4APIRunsReadCrossOrganization proves the organization predicate is in
// the SQL, not in a Go branch: a caller carrying another organization's
// identity cannot see the run at all — and RecordDenied still writes its
// audit row for the refusal.
func TestM4APIRunsReadCrossOrganization(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)
	m4RunsReadMember(t, ctx, f, "maintainer")
	runID := m4RunsReadSeedRun(t, ctx, f)
	store := APIRunStore{Runs: f.runs}

	foreign := api.Caller{UserID: m4RunsReadForeignUser, OrganizationID: m4RunsReadForeignOrg}
	if _, err := store.GetRun(ctx, foreign, runID); !errors.Is(err, api.ErrRunNotFound) {
		t.Errorf("cross-org GetRun = %v, want api.ErrRunNotFound", err)
	}
	if _, err := store.ListRunNodes(ctx, foreign, runID); !errors.Is(err, api.ErrRunNotFound) {
		t.Errorf("cross-org ListRunNodes = %v, want api.ErrRunNotFound", err)
	}
	if _, err := store.ListRunCheckpoints(ctx, foreign, runID); !errors.Is(err, api.ErrRunNotFound) {
		t.Errorf("cross-org ListRunCheckpoints = %v, want api.ErrRunNotFound", err)
	}
	if _, err := store.GetRunTree(ctx, foreign, runID); !errors.Is(err, api.ErrRunNotFound) {
		t.Errorf("cross-org GetRunTree = %v, want api.ErrRunNotFound", err)
	}
	if _, err := store.ListProjectRuns(ctx, foreign, f.projectID); !errors.Is(err, api.ErrProjectNotFound) {
		t.Errorf("cross-org ListProjectRuns = %v, want api.ErrProjectNotFound", err)
	}

	if err := store.RecordDenied(ctx, foreign, runID, "run.get"); err != nil {
		t.Fatalf("RecordDenied: %v", err)
	}
	var denied int
	var deniedProject string
	if err := f.pool.QueryRow(ctx, `
		SELECT count(*), COALESCE(MAX(project_id::text), '') FROM audit_events
		WHERE action = 'run.get' AND outcome = 'denied' AND actor_id = $1`,
		foreign.UserID).Scan(&denied, &deniedProject); err != nil {
		t.Fatalf("count denials: %v", err)
	}
	if denied != 1 {
		t.Errorf("denial audit rows = %d, want 1", denied)
	}
	if deniedProject != f.projectID {
		t.Errorf("denial project_id = %q, want the run's project %s", deniedProject, f.projectID)
	}
	t.Cleanup(func() {
		if _, err := f.pool.Exec(context.Background(),
			`DELETE FROM audit_events WHERE action = 'run.get' AND outcome = 'denied'`); err != nil {
			t.Errorf("cleanup denials: %v", err)
		}
	})
}

// TestM4APIRunsReadListNodesAndCheckpoints covers routes 24 and 27 (plus
// route 25's pair enforcement): the rows come back in key order, an orphan
// node id under another run's URL is the same 404, and a run with no
// checkpoints answers an empty list rather than a null.
func TestM4APIRunsReadListNodesAndCheckpoints(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)
	member := m4RunsReadMember(t, ctx, f, "contributor")
	runID := m4RunsReadSeedRun(t, ctx, f)
	otherRunID := m4RunsReadSeedRun(t, ctx, f)
	store := APIRunStore{Runs: f.runs}

	nodeID, attemptID := f.m4WorkerNode(t, ctx, runID, "/implement")
	if _, err := f.runs.SetRunStatus(ctx, runID, RunStatusInput{Status: "running"}); err != nil {
		t.Fatalf("start run: %v", err)
	}

	nodes, err := store.ListRunNodes(ctx, member, runID)
	if err != nil {
		t.Fatalf("ListRunNodes: %v", err)
	}
	if len(nodes) != 1 || nodes[0].ID != nodeID || nodes[0].NodeInstanceKey != "/implement" {
		t.Fatalf("ListRunNodes = %+v, want the one /implement row", nodes)
	}
	if nodes[0].MyRole != "contributor" {
		t.Errorf("node view = %+v, want the contributor role", nodes[0])
	}

	detail, err := store.GetRunNode(ctx, member, runID, nodeID)
	if err != nil {
		t.Fatalf("GetRunNode: %v", err)
	}
	if len(detail.Attempts) != 1 || detail.Attempts[0].ID != attemptID {
		t.Errorf("detail.Attempts = %+v, want the one queued attempt %s", detail.Attempts, attemptID)
	}
	if detail.CelEnvelope.Status != "ready" {
		t.Errorf("CelEnvelope = %+v, want the node's own ready status", detail.CelEnvelope)
	}
	if detail.Checkpoint != nil {
		t.Errorf("Checkpoint = %+v, want none for a row that never wrote one", detail.Checkpoint)
	}

	// Route 25's relationship claim: the node exists, the run exists, the
	// PAIR does not.
	if _, err := store.GetRunNode(ctx, member, otherRunID, nodeID); !errors.Is(err, api.ErrRunNotFound) {
		t.Errorf("GetRunNode across runs = %v, want api.ErrRunNotFound", err)
	}

	checks, err := store.ListRunCheckpoints(ctx, member, runID)
	if err != nil {
		t.Fatalf("ListRunCheckpoints: %v", err)
	}
	if checks == nil || len(checks) != 0 {
		t.Errorf("ListRunCheckpoints = %#v, want an empty non-nil slice", checks)
	}

	// Route 32: the attempt view carries no lease column at all.
	attempt, err := store.GetAttempt(ctx, member, attemptID)
	if err != nil {
		t.Fatalf("GetAttempt: %v", err)
	}
	if attempt.ID != attemptID || attempt.RunID != runID || attempt.MyRole != "contributor" {
		t.Errorf("attempt view = %+v, want the seeded attempt in the seeded run", attempt)
	}
	body, err := json.Marshal(attempt)
	if err != nil {
		t.Fatalf("marshal attempt view: %v", err)
	}
	for _, leak := range []string{"worker_id", "fencing_token", "lease_expires_at"} {
		if strings.Contains(string(body), leak) {
			t.Errorf("serialized attempt view carries %q: %s", leak, body)
		}
	}
	// An org admin with no membership row still sees everything
	// (prjProjectSelect's rule), and a foreign caller sees nothing.
	admin := api.Caller{UserID: m4RunsReadForeignUser, OrganizationID: f.orgID, IsOrgAdmin: true}
	if _, err := store.GetAttempt(ctx, admin, attemptID); err != nil {
		t.Errorf("org-admin GetAttempt = %v, want the row", err)
	}
	foreign := api.Caller{UserID: m4RunsReadForeignUser, OrganizationID: m4RunsReadForeignOrg}
	if _, err := store.GetAttempt(ctx, foreign, attemptID); !errors.Is(err, api.ErrRunNotFound) {
		t.Errorf("cross-org GetAttempt = %v, want api.ErrRunNotFound", err)
	}
}

// TestM4APIRunsReadListProjectRunsAndTree covers routes 21 and 26: a
// member's project list carries the run, a non-member's is the project 404,
// and the tree reports the invocation relationship (invoking key, wait
// policy, depth) for a seeded child.
func TestM4APIRunsReadListProjectRunsAndTree(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)
	member := m4RunsReadMember(t, ctx, f, "viewer")
	runID := m4RunsReadSeedRun(t, ctx, f)
	store := APIRunStore{Runs: f.runs}

	runs, err := store.ListProjectRuns(ctx, member, f.projectID)
	if err != nil {
		t.Fatalf("ListProjectRuns: %v", err)
	}
	var found bool
	for _, r := range runs {
		if r.ID == runID {
			found = true
		}
	}
	if !found {
		t.Fatalf("ListProjectRuns = %+v, want the seeded run %s", runs, runID)
	}
	stranger := api.Caller{UserID: m4RunsReadForeignUser, OrganizationID: f.orgID}
	if _, err := store.ListProjectRuns(ctx, stranger, f.projectID); !errors.Is(err, api.ErrProjectNotFound) {
		t.Errorf("non-member ListProjectRuns = %v, want api.ErrProjectNotFound", err)
	}

	tree, err := store.GetRunTree(ctx, member, runID)
	if err != nil {
		t.Fatalf("GetRunTree: %v", err)
	}
	if tree.Run.ID != runID || tree.NodeInstanceKey != nil || tree.Depth != nil {
		t.Errorf("root tree = %+v, want the run with null invocation members", tree)
	}
	if tree.Children == nil || len(tree.Children) != 0 {
		t.Errorf("root children = %#v, want an empty non-nil list", tree.Children)
	}

	// Seed one invocation: a depth-1 child of the same project, hung off a
	// control-plane node of the root run.
	node, err := f.runs.InsertNodeExecution(ctx, NewNodeExecution{
		RunID: runID, NodeID: "invoke", Kind: "pipeline.invoke",
		NodeInstanceKey: "/invoke", ExecutionLocation: "control_plane",
	})
	if err != nil {
		t.Fatalf("InsertNodeExecution: %v", err)
	}
	childID := m4RunsReadSeedRun(t, ctx, f)
	if _, err := f.pool.Exec(ctx, `UPDATE runs SET depth = 1, parent_run_id = $2::uuid WHERE id = $1::uuid`,
		childID, runID); err != nil {
		t.Fatalf("make the child a child: %v", err)
	}
	if _, err := f.pool.Exec(ctx, `
		INSERT INTO pipeline_invocations
			(run_id, node_execution_id, child_run_id, child_project_id, pipeline_id,
			 resolved_revision_id, wait_policy, depth)
		VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, 'completion', 1)`,
		runID, node.ID, childID, f.projectID, f.pipelineID, f.revisionID); err != nil {
		t.Fatalf("seed invocation: %v", err)
	}

	tree, err = store.GetRunTree(ctx, member, runID)
	if err != nil {
		t.Fatalf("GetRunTree with a child: %v", err)
	}
	if len(tree.Children) != 1 {
		t.Fatalf("children = %+v, want exactly the one seeded child", tree.Children)
	}
	kid := tree.Children[0]
	if kid.Run.ID != childID || kid.NodeInstanceKey == nil || *kid.NodeInstanceKey != "/invoke" ||
		kid.WaitPolicy == nil || *kid.WaitPolicy != "completion" || kid.Depth == nil || *kid.Depth != 1 {
		t.Errorf("child tree = %+v, want the invocation's key/wait policy/depth", kid)
	}
	// A child is looked at through its parent's authorization: reading the
	// child directly as a member works, reading it as a stranger does not.
	if _, err := store.GetRunTree(ctx, member, childID); err != nil {
		t.Errorf("GetRunTree of the child as a member = %v, want the tree", err)
	}
	if _, err := store.GetRunTree(ctx, stranger, childID); !errors.Is(err, api.ErrRunNotFound) {
		t.Errorf("GetRunTree of the child as a stranger = %v, want api.ErrRunNotFound", err)
	}
}
