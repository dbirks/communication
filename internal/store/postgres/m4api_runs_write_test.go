package postgres

// TestM4APIRunsWrite*: the run-family WRITE adapter against a real Postgres
// that ran 00005 (docs/m4-contract.md § 2.1 routes 22/28-31, § 5.5): the
// idempotent 201-vs-200, the pause/resume/cancel lifecycle with its journal
// rows, and pipeline.invoke's child run. Every claim is a row or a journal
// count read back — a mocked green test never substitutes for this
// (12-test-strategy's rule).

import (
	"encoding/json"
	"errors"
	"testing"

	"github.com/dbirks/communication/internal/api"
	"github.com/dbirks/communication/internal/pipelines/runtime"
)

// m4RunsWriteCaller is an organization admin: visible in every project of
// the fixture's organization without a membership row (which the shared
// fixture's cleanup does not unwind), so the tests exercise the predicate
// rather than the plumbing around it.
func m4RunsWriteCaller(f *m4Fixture) api.Caller {
	return api.Caller{UserID: f.userID, OrganizationID: f.orgID, IsOrgAdmin: true}
}

func m4RunsWriteStore(f *m4Fixture) APIRunStore {
	return APIRunStore{Runs: f.runs}
}

// m4RunsWriteCount counts journal rows of one type for one run.
func m4RunsWriteCount(t *testing.T, f *m4Fixture, runID, typ string) int {
	t.Helper()
	var n int
	if err := f.pool.QueryRow(testCtx(t), `
		SELECT count(*) FROM domain_events WHERE run_id = $1::uuid AND type = $2`,
		runID, typ).Scan(&n); err != nil {
		t.Fatalf("count %s for run %s: %v", typ, runID, err)
	}
	return n
}

// m4RunsWriteRun creates one run by direct revision pin and returns its view.
func m4RunsWriteRun(t *testing.T, f *m4Fixture, key string) api.RunView {
	t.Helper()
	in := api.RunCreateInput{
		ProjectID:          f.projectID,
		PipelineRevisionID: f.revisionID,
		Key:                key,
		RequestSHA:         m4Hex("body/" + key),
		TriggeredBy:        f.userID,
	}
	view, created, err := m4RunsWriteStore(f).CreateRun(testCtx(t), m4RunsWriteCaller(f), in)
	if err != nil {
		t.Fatalf("CreateRun(%s): %v", key, err)
	}
	if !created {
		t.Fatalf("CreateRun(%s): first creation reported created=false", key)
	}
	return view
}

// TestM4APIRunsWriteCreateIdempotency is 12 case 1 and 12 case 11 through
// route 22: the same key + the same body replays the STORED run with
// created=false and writes no second row; the same key with a different body
// is the idempotency_key_mismatch 409; the run.created row exists exactly
// once; and the pin is the revision's own digests, copied at creation.
func TestM4APIRunsWriteCreateIdempotency(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)
	caller := m4RunsWriteCaller(f)
	store := m4RunsWriteStore(f)

	as, err := f.pipelines.CreateAssignment(ctx, NewAssignment{
		ProjectID: f.projectID, PipelineID: f.pipelineID,
		PinnedRevisionID: f.revisionID, MaxConcurrentRuns: 2, CreatedBy: f.userID,
	})
	if err != nil {
		t.Fatalf("CreateAssignment: %v", err)
	}

	first := api.RunCreateInput{
		ProjectID: f.projectID, AssignmentID: as.ID,
		Key: "runs-write-idem", RequestSHA: m4Hex("same-body"), TriggeredBy: f.userID,
	}
	view, created, err := store.CreateRun(ctx, caller, first)
	if err != nil {
		t.Fatalf("CreateRun: %v", err)
	}
	if !created {
		t.Errorf("first CreateRun reported created=false")
	}
	if view.Status != "queued" {
		t.Errorf("new run status = %q, want queued", view.Status)
	}
	if view.RevisionDigest != f.digest {
		t.Errorf("pinned revision_digest = %q, want the revision's %q", view.RevisionDigest, f.digest)
	}
	if view.PlanDigest == "" || view.DigestScope == "" {
		t.Errorf("pinned plan_digest/digest_scope = %q/%q, want both copied from the revision",
			view.PlanDigest, view.DigestScope)
	}
	if view.AssignmentID == nil || *view.AssignmentID != as.ID {
		t.Errorf("assignment_id = %v, want %s", view.AssignmentID, as.ID)
	}
	if got := m4RunsWriteCount(t, f, view.ID, "run.created"); got != 1 {
		t.Errorf("run.created rows = %d, want exactly 1", got)
	}

	replay, created, err := store.CreateRun(ctx, caller, first)
	if err != nil {
		t.Fatalf("replayed CreateRun: %v", err)
	}
	if created {
		t.Errorf("same key + same body reported created=true; 12 case 1 wants a replay of the stored run")
	}
	if replay.ID != view.ID {
		t.Errorf("replay returned run %s, want the stored %s", replay.ID, view.ID)
	}
	var runs int
	if err := f.pool.QueryRow(ctx, `
		SELECT count(*) FROM runs WHERE project_id = $1::uuid`, f.projectID).Scan(&runs); err != nil {
		t.Fatalf("count runs: %v", err)
	}
	if runs != 1 {
		t.Errorf("runs after replay = %d, want 1 (a replay touches no row)", runs)
	}
	if got := m4RunsWriteCount(t, f, view.ID, "run.created"); got != 1 {
		t.Errorf("run.created rows after replay = %d, want still 1", got)
	}

	// Same key, different body: the mismatch arm, and no run is created.
	var conflict *api.RunConflictError
	if _, _, err := store.CreateRun(ctx, caller, api.RunCreateInput{
		ProjectID: f.projectID, AssignmentID: as.ID,
		Key: "runs-write-idem", RequestSHA: m4Hex("other-body"), TriggeredBy: f.userID,
	}); !errors.As(err, &conflict) || conflict.Kind != api.RunConflictIdempotencyMismatch {
		t.Errorf("same key + different body err = %v, want RunConflictError kind %s",
			err, api.RunConflictIdempotencyMismatch)
	}
	if err := f.pool.QueryRow(ctx, `
		SELECT count(*) FROM runs WHERE project_id = $1::uuid`, f.projectID).Scan(&runs); err != nil {
		t.Fatalf("count runs: %v", err)
	}
	if runs != 1 {
		t.Errorf("runs after the mismatch refusal = %d, want still 1", runs)
	}

	// A caller with no membership in the project cannot start a run in it:
	// the same not-found bytes nonsense produces, and still no new row.
	if _, _, err := store.CreateRun(ctx, api.Caller{
		UserID: f.userID, OrganizationID: f.orgID,
	}, first); err == nil {
		t.Errorf("a non-admin of another fixture would reach the run; visibility must be in the SQL")
	} else if !errors.Is(err, api.ErrProjectNotFound) {
		t.Errorf("cross-org CreateRun err = %v, want api.ErrProjectNotFound", err)
	}
}

// TestM4APIRunsWriteMaxConcurrentRuns is § 5.1's assignment ceiling enforced
// at POST /runs from rows: with max_concurrent_runs=1, the second queued run
// is a 409 run_state_conflict, never a third state.
func TestM4APIRunsWriteMaxConcurrentRuns(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)
	store := m4RunsWriteStore(f)
	caller := m4RunsWriteCaller(f)

	as, err := f.pipelines.CreateAssignment(ctx, NewAssignment{
		ProjectID: f.projectID, PipelineID: f.pipelineID,
		PinnedRevisionID: f.revisionID, MaxConcurrentRuns: 1, CreatedBy: f.userID,
	})
	if err != nil {
		t.Fatalf("CreateAssignment: %v", err)
	}
	base := api.RunCreateInput{
		ProjectID: f.projectID, AssignmentID: as.ID, TriggeredBy: f.userID,
	}
	if _, _, err := store.CreateRun(ctx, caller, base); err != nil {
		t.Fatalf("first CreateRun: %v", err)
	}
	var conflict *api.RunConflictError
	if _, _, err := store.CreateRun(ctx, caller, api.RunCreateInput{
		ProjectID: f.projectID, AssignmentID: as.ID, TriggeredBy: f.userID,
		Key: "second", RequestSHA: m4Hex("second"),
	}); !errors.As(err, &conflict) || conflict.Kind != api.RunConflictState {
		t.Errorf("second CreateRun err = %v, want RunConflictError kind %s",
			err, api.RunConflictState)
	}
}

// TestM4APIRunsWriteLifecycle is routes 28-30 in order on one run: pause
// stops future scheduling (paused_reason='manual', run.paused naming the
// in-flight attempts), resume returns it to queued (run.resumed naming the
// reason it cleared), and cancel is a REQUEST — cancel_requested_at set with
// run.cancel_requested, status untouched until the advancer says otherwise.
func TestM4APIRunsWriteLifecycle(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)
	store := m4RunsWriteStore(f)
	caller := m4RunsWriteCaller(f)

	run := m4RunsWriteRun(t, f, "lifecycle")

	paused, err := store.PauseRun(ctx, caller, run.ID)
	if err != nil {
		t.Fatalf("PauseRun: %v", err)
	}
	if paused.Status != "paused" || paused.PausedReason == nil || *paused.PausedReason != "manual" {
		t.Errorf("after pause: status=%q reason=%v, want paused/manual", paused.Status, paused.PausedReason)
	}
	if got := m4RunsWriteCount(t, f, run.ID, "run.paused"); got != 1 {
		t.Errorf("run.paused rows = %d, want 1", got)
	}
	// Pausing twice is a state conflict, not a second journal row.
	var conflict *api.RunConflictError
	if _, err := store.PauseRun(ctx, caller, run.ID); !errors.As(err, &conflict) ||
		conflict.Kind != api.RunConflictState || conflict.RunStatus != "paused" {
		t.Errorf("second PauseRun err = %v, want run_state_conflict on a paused run", err)
	}

	resumed, err := store.ResumeRun(ctx, caller, run.ID)
	if err != nil {
		t.Fatalf("ResumeRun: %v", err)
	}
	if resumed.Status != "queued" || resumed.PausedReason != nil {
		t.Errorf("after resume: status=%q reason=%v, want queued/<absent>", resumed.Status, resumed.PausedReason)
	}
	if got := m4RunsWriteCount(t, f, run.ID, "run.resumed"); got != 1 {
		t.Errorf("run.resumed rows = %d, want 1", got)
	}
	var payload struct {
		PausedReason string `json:"paused_reason"`
	}
	if err := f.pool.QueryRow(ctx, `
		SELECT payload FROM domain_events WHERE run_id = $1::uuid AND type = 'run.resumed'`, run.ID).
		Scan(&payload); err != nil {
		t.Fatalf("read run.resumed payload: %v", err)
	}
	if payload.PausedReason != "manual" {
		t.Errorf("run.resumed paused_reason = %q, want the reason it cleared (manual)", payload.PausedReason)
	}
	// Resume on a run that is not paused refuses.
	if _, err := store.ResumeRun(ctx, caller, run.ID); !errors.As(err, &conflict) ||
		conflict.Kind != api.RunConflictState {
		t.Errorf("ResumeRun on a queued run err = %v, want run_state_conflict", err)
	}

	cancelled, err := store.CancelRun(ctx, caller, run.ID)
	if err != nil {
		t.Fatalf("CancelRun: %v", err)
	}
	if cancelled.CancelRequestedAt == nil {
		t.Errorf("after cancel: cancel_requested_at is nil; the flag is the whole route")
	}
	if cancelled.Status != "queued" {
		t.Errorf("cancel moved status to %q; § 5.5 makes the advancer do that, not the API", cancelled.Status)
	}
	if got := m4RunsWriteCount(t, f, run.ID, "run.cancel_requested"); got != 1 {
		t.Errorf("run.cancel_requested rows = %d, want 1", got)
	}

	// A terminal run refuses the lifecycle, and the refusal writes nothing.
	if _, err := f.runs.SetRunStatus(ctx, run.ID, RunStatusInput{Status: "completed"}); err != nil {
		t.Fatalf("settle the run: %v", err)
	}
	for name, call := range map[string]func() error{
		"pause":  func() error { _, err := store.PauseRun(ctx, caller, run.ID); return err },
		"resume": func() error { _, err := store.ResumeRun(ctx, caller, run.ID); return err },
		"cancel": func() error { _, err := store.CancelRun(ctx, caller, run.ID); return err },
	} {
		if _, err := f.runs.GetRun(ctx, run.ID); err != nil {
			t.Fatalf("GetRun: %v", err)
		}
		if err := call(); !errors.As(err, &conflict) || conflict.Kind != api.RunConflictState {
			t.Errorf("%s on a completed run err = %v, want run_state_conflict", name, err)
		}
	}
	if got := m4RunsWriteCount(t, f, run.ID, "run.cancel_requested"); got != 1 {
		t.Errorf("run.cancel_requested rows after the terminal refusal = %d, want still 1", got)
	}
}

// TestM4APIRunsWriteChild is § 5.5's child side: the child lives in the
// parent's project at depth = parent.depth + 1, pins the revision resolved at
// ITS start (the assignment's pin here), is booked on pipeline_invocations
// with that resolved revision, and CreateChild is idempotent per
// (parentRunID, nodeExecutionID) — the advancer may retry an aborted pass.
func TestM4APIRunsWriteChild(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)

	as, err := f.pipelines.CreateAssignment(ctx, NewAssignment{
		ProjectID: f.projectID, PipelineID: f.pipelineID,
		PinnedRevisionID: f.revisionID, MaxConcurrentRuns: 4, CreatedBy: f.userID,
	})
	if err != nil {
		t.Fatalf("CreateAssignment: %v", err)
	}
	if as.ID == "" {
		t.Fatalf("CreateAssignment returned an id-less assignment")
	}
	parent := m4RunsWriteRun(t, f, "parent")

	var neID string
	if err := f.pool.QueryRow(ctx, `
		INSERT INTO node_executions
			(run_id, node_id, kind, node_instance_key, scope_key, execution_location,
			 status, waiting_reason, ready_at)
		VALUES ($1::uuid, 'invoke', 'pipeline.invoke', '/invoke', '/', 'control_plane',
		        'waiting', 'child_run', now())
		RETURNING id`, parent.ID).Scan(&neID); err != nil {
		t.Fatalf("insert invoking node execution: %v", err)
	}

	children := &M4Children{Runs: f.runs}
	req := runtime.ChildRequest{
		ParentRunID: parent.ID, ParentProjectID: f.projectID, OrganizationID: f.orgID,
		NodeExecutionID: neID, NodeInstanceKey: "/invoke", Target: f.pipelineID,
		Depth: parent.Depth + 1, Inputs: map[string]any{},
	}
	childID, err := children.CreateChild(ctx, req)
	if err != nil {
		t.Fatalf("CreateChild: %v", err)
	}
	if childID == "" || childID == parent.ID {
		t.Fatalf("CreateChild returned %q for parent %q", childID, parent.ID)
	}
	again, err := children.CreateChild(ctx, req)
	if err != nil {
		t.Fatalf("replayed CreateChild: %v", err)
	}
	if again != childID {
		t.Errorf("CreateChild replay returned child %s, want the booked %s (idempotent per node execution)",
			again, childID)
	}

	var (
		invocations int
		childRuns   int
		depth       int
		parentID    string
		digest      string
		resolved    string
	)
	if err := f.pool.QueryRow(ctx, `
		SELECT count(*) FROM pipeline_invocations WHERE run_id = $1::uuid AND node_execution_id = $2::uuid`,
		parent.ID, neID).Scan(&invocations); err != nil {
		t.Fatalf("count invocations: %v", err)
	}
	if invocations != 1 {
		t.Errorf("pipeline_invocations rows for the retried pass = %d, want 1", invocations)
	}
	if err := f.pool.QueryRow(ctx, `
		SELECT count(*) FROM runs WHERE parent_run_id = $1::uuid`, parent.ID).Scan(&childRuns); err != nil {
		t.Fatalf("count children: %v", err)
	}
	if childRuns != 1 {
		t.Errorf("child runs = %d, want 1 — a retried advancer pass must not spawn a second", childRuns)
	}
	if err := f.pool.QueryRow(ctx, `
		SELECT depth, parent_run_id::text, revision_digest FROM runs WHERE id = $1::uuid`, childID).
		Scan(&depth, &parentID, &digest); err != nil {
		t.Fatalf("read child run: %v", err)
	}
	if depth != parent.Depth+1 || parentID != parent.ID {
		t.Errorf("child run: depth=%d parent=%s, want depth=%d parent=%s",
			depth, parentID, parent.Depth+1, parent.ID)
	}
	if digest != f.digest {
		t.Errorf("child revision_digest = %q, want the resolved revision's %q", digest, f.digest)
	}
	if err := f.pool.QueryRow(ctx, `
		SELECT resolved_revision_id::text FROM pipeline_invocations
		WHERE run_id = $1::uuid AND node_execution_id = $2::uuid`, parent.ID, neID).
		Scan(&resolved); err != nil {
		t.Fatalf("read invocation pin: %v", err)
	}
	if resolved != f.revisionID {
		t.Errorf("invocation resolved_revision_id = %s, want the assignment's pin %s", resolved, f.revisionID)
	}
	if got := m4RunsWriteCount(t, f, childID, "run.created"); got != 1 {
		t.Errorf("child run.created rows = %d, want 1", got)
	}

	// § 5.5's cascade: CancelChild flags the child, and a terminal child is a
	// no-op rather than an error the parent's advancer would choke on.
	status, cause, err := children.ChildStatus(ctx, childID)
	if err != nil {
		t.Fatalf("ChildStatus: %v", err)
	}
	if status != "queued" || cause != "" {
		t.Errorf("ChildStatus = %q/%q, want queued/<empty>", status, cause)
	}
	if err := children.CancelChild(ctx, childID, "parent_cancelled"); err != nil {
		t.Fatalf("CancelChild: %v", err)
	}
	child, err := f.runs.GetRun(ctx, childID)
	if err != nil {
		t.Fatalf("GetRun(child): %v", err)
	}
	if child.CancelRequestedAt == nil {
		t.Errorf("CancelChild left cancel_requested_at nil")
	}
	if _, err := f.runs.SetRunStatus(ctx, childID, RunStatusInput{Status: "completed"}); err != nil {
		t.Fatalf("complete the child: %v", err)
	}
	if err := children.CancelChild(ctx, childID, "parent_cancelled"); err != nil {
		t.Errorf("CancelChild on a terminal child err = %v, want a silent no-op", err)
	}

	// Depth beyond the engine ceiling is named, not a CHECK violation.
	if _, err := children.CreateChild(ctx, runtime.ChildRequest{
		ParentRunID: parent.ID, ParentProjectID: f.projectID, OrganizationID: f.orgID,
		NodeExecutionID: neID, Target: f.pipelineID, Depth: 3,
	}); err == nil {
		t.Errorf("CreateChild at depth 3 succeeded; runs_depth_check's rule must be named in Go")
	}
}

// TestM4APIRunsWriteRetryRefusals covers route 31's refusals that need no
// engine state: a completed run is not retriable, and an unknown run answers
// the uniform not-found. (The reopen itself is RuntimeStore.Retry's own
// integration coverage.)
func TestM4APIRunsWriteRetryRefusals(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)
	store := m4RunsWriteStore(f)
	caller := m4RunsWriteCaller(f)

	run := m4RunsWriteRun(t, f, "retry")
	if _, err := f.runs.SetRunStatus(ctx, run.ID, RunStatusInput{Status: "completed"}); err != nil {
		t.Fatalf("complete the run: %v", err)
	}
	var conflict *api.RunConflictError
	if _, err := store.RetryRun(ctx, caller, run.ID, api.RunRetryInput{RequestedBy: f.userID}); !errors.As(err, &conflict) ||
		conflict.Kind != api.RunConflictNotRetriable {
		t.Errorf("RetryRun on a completed run err = %v, want run_not_retriable", err)
	}
	if _, err := store.RetryRun(ctx, caller, run.ID, api.RunRetryInput{
		Inputs: map[string]json.RawMessage{"nope": json.RawMessage(`1`)},
	}); !errors.As(err, &conflict) {
		t.Errorf("RetryRun err = %v, want the same refusal before any input is written", err)
	}
	if _, err := store.RetryRun(ctx, caller, "00000000-0000-0000-0000-000000000000",
		api.RunRetryInput{}); !errors.Is(err, api.ErrRunNotFound) {
		t.Errorf("RetryRun on a nonsense run err = %v, want api.ErrRunNotFound", err)
	}
}
