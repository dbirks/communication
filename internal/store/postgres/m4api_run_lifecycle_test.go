package postgres

// TestM4RunLifecycle*: the API-created run driven by the REAL advancer
// against a real Postgres (docs/m4-contract.md § 2.1 route 22 + § 5.1). The
// existing runtime tests seed through the runtimetest harness, so nothing
// proved that a run written by APIRunStore.CreateRun hydrates into a state
// the advancer can execute. This does: publish the § 7 exit seed's first
// document through APIPipelineStore, assign it, POST-create the run exactly
// as the handler does, advance once, and read the node_executions rows back.

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/dbirks/communication/internal/api"
	"github.com/dbirks/communication/internal/pipelines/compiler"
	"github.com/dbirks/communication/internal/pipelines/loader"
	"github.com/dbirks/communication/internal/pipelines/runtime"
	"github.com/dbirks/communication/internal/pipelines/schema"
)

// m4LifecyclePlan compiles the probe pipeline's first document the way a
// publish does (loader -> canonical schema -> compiler). The bytes are the
// real plan a run pins, never a Go-built fake.
func m4LifecyclePlan(t *testing.T) (*compiler.Plan, json.RawMessage) {
	t.Helper()
	doc := m4APIProbeDoc(t)
	parsed, d := loader.Load([]byte(doc))
	if !d.Valid() {
		t.Fatalf("loader: %v", d)
	}
	if d := schema.MustCompile().Validate(parsed.Value); !d.Valid() {
		t.Fatalf("schema: %v", d)
	}
	plan, d := compiler.Compile(parsed, compiler.Options{})
	if !d.Valid() {
		t.Fatalf("compiler: %v", d)
	}
	raw, err := json.Marshal(plan)
	if err != nil {
		t.Fatalf("marshal compiled plan: %v", err)
	}
	return plan, raw
}

// m4LifecyclePublished publishes the probe document through APIPipelineStore
// — create pipeline -> draft -> RecordValidation -> PublishDraft — and
// returns the pipeline id and the published revision's id.
func m4LifecyclePublished(t *testing.T, f *m4Fixture, planJSON json.RawMessage) (string, string) {
	t.Helper()
	ctx := testCtx(t)
	c := api.Caller{UserID: f.userID, OrganizationID: f.orgID, IsOrgAdmin: true}
	store := APIPipelineStore{S: f.pipelines, ExtractUI: ExtractPipelineUI}
	token := migFixtureToken(t)

	pipe, err := store.CreatePipeline(ctx, c, "m4life-pipe-"+token, "M4 lifecycle pipe", "")
	if err != nil {
		t.Fatalf("CreatePipeline: %v", err)
	}
	t.Cleanup(func() { m4LifecycleMop(t, f, pipe.ID) })
	doc := m4APIProbeDoc(t)
	draft, err := store.CreateDraft(ctx, c, pipe.ID, api.DraftCreateInput{
		DocumentYAML: doc, SourceKind: "manual", SourceSHA256: m4Hex("src/life/" + token),
	})
	if err != nil {
		t.Fatalf("CreateDraft: %v", err)
	}
	planDigest, err := func() (string, error) {
		var p compiler.Plan
		if err := json.Unmarshal(planJSON, &p); err != nil {
			return "", err
		}
		return p.Digest()
	}()
	if err != nil {
		t.Fatalf("plan digest: %v", err)
	}
	revDigest := m4Digest("life-rev/" + token)
	validated, err := store.RecordValidation(ctx, c, draft.ID, api.DraftValidationRecord{
		Status: "valid",
		Body: api.ValidateResponse{
			Valid: true, DigestScope: "v1alpha1-canonical-1", Errors: []api.ValidateError{},
		},
		CanonicalDocument: json.RawMessage(`{"apiVersion":"communication.dev/v1alpha1",` +
			`"kind":"Pipeline","name":"feature-development"}`),
		RevisionDigest: revDigest,
		CompiledPlan:   planJSON,
		PlanDigest:     planDigest,
		DigestScope:    "v1alpha1-canonical-1",
	})
	if err != nil {
		t.Fatalf("RecordValidation: %v", err)
	}
	rev, err := store.PublishDraft(ctx, c, draft.ID, api.DraftPublishInput{
		ExpectedVersion: validated.Version, VersionLabel: "1.0.0", DocumentText: doc,
		SchemaDigest: m4Digest("schema"), CelEnvDigest: m4Digest("celenv"),
	})
	if err != nil {
		t.Fatalf("PublishDraft: %v", err)
	}
	return pipe.ID, rev.ID
}

// TestM4RunLifecycleAPIRunAdvances is the panic reproduction: an
// API-created run of a freshly published revision, advanced once the way
// serve's M4Driver does, must hydrate a real plan and schedule its first
// nodes rather than crash the request.
func TestM4RunLifecycleAPIRunAdvances(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)
	_, planJSON := m4LifecyclePlan(t)
	pipelineID, revisionID := m4LifecyclePublished(t, f, planJSON)

	caller := api.Caller{UserID: f.userID, OrganizationID: f.orgID, IsOrgAdmin: true}
	assignments := APIAssignmentStore{S: f.pipelines}
	as, err := assignments.CreateAssignment(ctx, caller, f.projectID, api.AssignmentCreateInput{
		PipelineID: pipelineID, PinnedRevisionID: revisionID,
		MaxConcurrentRuns: 1,
	})
	if err != nil {
		t.Fatalf("CreateAssignment: %v", err)
	}

	// Built exactly as cmd/communication/serve.go builds them: the
	// deployment's advancer carries only its child resolver — the run's own
	// pinned plan is what must drive it.
	runStore := &RunStore{Pool: f.pool}
	children := &M4Children{Runs: runStore}
	m4Runtime := NewRuntimeStore(f.pool, &runtime.Advancer{
		Deps: runtime.AdvancerDeps{Children: children},
	})
	children.Runtime = m4Runtime
	driver := NewM4Driver(f.pool, m4Runtime, nil)

	view, created, err := APIRunStore{Runs: runStore, Runtime: m4Runtime}.CreateRun(ctx, caller,
		api.RunCreateInput{
			ProjectID:    f.projectID,
			AssignmentID: as.ID,
			Inputs: map[string]json.RawMessage{
				"goal":                json.RawMessage(`"add feature"`),
				"repository":          json.RawMessage(`"repo-a"`),
				"acceptance_criteria": json.RawMessage(`"tests pass"`),
				"fanout":              json.RawMessage(`false`),
				"fanout_count":        json.RawMessage(`0`),
			},
			Key:         "m4-life-run-1",
			RequestSHA:  m4Hex("body/m4-life-run-1"),
			TriggeredBy: f.userID,
		})
	if err != nil {
		t.Fatalf("CreateRun: %v", err)
	}
	if !created {
		t.Fatalf("CreateRun reported created=false")
	}
	if view.ID == "" {
		t.Fatalf("CreateRun returned an id-less run")
	}

	if err := m4Runtime.Advance(ctx, view.ID); err != nil {
		t.Fatalf("first advance: %v", err)
	}
	driver.Trigger(ctx, view.ID) // the handler's own path (api.M4Trigger)

	type nodeRow struct {
		nodeID, kind, status, scopeKey string
	}
	rows, err := f.pool.Query(ctx, `
		SELECT node_id, kind, status, scope_key FROM node_executions
		WHERE run_id = $1::uuid ORDER BY id`, view.ID)
	if err != nil {
		t.Fatalf("read node_executions: %v", err)
	}
	var got []nodeRow
	for rows.Next() {
		var n nodeRow
		if err := rows.Scan(&n.nodeID, &n.kind, &n.status, &n.scopeKey); err != nil {
			rows.Close()
			t.Fatalf("scan node_executions: %v", err)
		}
		got = append(got, n)
	}
	rows.Close()
	if len(got) == 0 {
		t.Fatalf("advance created no node_executions rows for run %s", view.ID)
	}
	var first *nodeRow
	for i := range got {
		t.Logf("node %s kind=%s status=%s scope=%s", got[i].nodeID, got[i].kind,
			got[i].status, got[i].scopeKey)
		if got[i].nodeID == "plan" {
			first = &got[i]
		}
	}
	if first == nil {
		t.Fatalf("no /plan node row in %d rows", len(got))
	}
	if first.status == runtime.NodePending {
		t.Errorf("root node plan is still pending after one advance: %+v", *first)
	}
	// The scheduled root node owns a queued attempt (contract § 5.1's pass).
	var attempts int
	if err := f.pool.QueryRow(ctx, `
		SELECT count(*) FROM attempts a JOIN node_executions ne ON ne.id = a.node_execution_id
		WHERE ne.run_id = $1::uuid`, view.ID).Scan(&attempts); err != nil {
		t.Fatalf("count attempts: %v", err)
	}
	if attempts == 0 {
		t.Errorf("first advance queued no attempt for run %s", view.ID)
	}

	// The run left queued: the first advance owns the work.
	var status string
	if err := f.pool.QueryRow(ctx,
		`SELECT status FROM runs WHERE id = $1::uuid`, view.ID).Scan(&status); err != nil {
		t.Fatalf("read run status: %v", err)
	}
	if status != runtime.RunRunning {
		t.Errorf("run status = %s, want %s", status, runtime.RunRunning)
	}
}

// TestM4RunLifecycleAdvanceWithoutProgramIsTypedError proves the engine
// refuses a run it cannot program: a run row that pins no plan, on a store
// whose wired advancer owns no program either, returns runtime.ErrNoProgram.
// No nil-pointer panic escapes to the request.
func TestM4RunLifecycleAdvanceWithoutProgramIsTypedError(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)
	caller := api.Caller{UserID: f.userID, OrganizationID: f.orgID, IsOrgAdmin: true}
	runStore := &RunStore{Pool: f.pool}
	// The store's advancer carries no program of its own: with no pinned plan
	// to hydrate, nothing can be executed, and the advance must say so.
	m4Runtime := NewRuntimeStore(f.pool, &runtime.Advancer{})

	view := m4LifecycleCorruptRun(t, f, caller, runStore, m4Runtime, "m4-life-noplan-1",
		`'{}'::jsonb`)
	var panicked any
	advanceErr := func() (err error) {
		defer func() {
			if r := recover(); r != nil {
				panicked = r
			}
		}()
		return m4Runtime.Advance(ctx, view.ID)
	}()
	if panicked != nil {
		t.Fatalf("advance panicked instead of returning an error: %v", panicked)
	}
	t.Logf("advance refusal: %v", advanceErr)
	if advanceErr == nil {
		t.Fatalf("advance with no program returned nil, want runtime.ErrNoProgram")
	}
	if !errors.Is(advanceErr, runtime.ErrNoProgram) {
		t.Errorf("advance error = %v, want runtime.ErrNoProgram", advanceErr)
	}
	m4LifecycleNoPartialWrite(t, f, view.ID)
}

// TestM4RunLifecycleAdvanceCorruptPlanIsTypedError proves a pinned snapshot
// the engine refuses to program is a typed refusal too: the run is corrupt
// data, and corrupt data answers with an error, not a crashed replica.
func TestM4RunLifecycleAdvanceCorruptPlanIsTypedError(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)
	caller := api.Caller{UserID: f.userID, OrganizationID: f.orgID, IsOrgAdmin: true}
	runStore := &RunStore{Pool: f.pool}
	m4Runtime := NewRuntimeStore(f.pool, &runtime.Advancer{})

	view := m4LifecycleCorruptRun(t, f, caller, runStore, m4Runtime, "m4-life-corrupt-1",
		`'{"version":"v1alpha1-plan-1","scopes":[{"key":true}]}'::jsonb`)
	var panicked any
	advanceErr := func() (err error) {
		defer func() {
			if r := recover(); r != nil {
				panicked = r
			}
		}()
		return m4Runtime.Advance(ctx, view.ID)
	}()
	if panicked != nil {
		t.Fatalf("advance panicked instead of returning an error: %v", panicked)
	}
	t.Logf("advance refusal: %v", advanceErr)
	if advanceErr == nil {
		t.Fatalf("advance on an unreadable snapshot returned nil, want a typed error")
	}
	if !strings.Contains(advanceErr.Error(), "plan snapshot") {
		t.Errorf("advance error = %v, want it to name the plan snapshot", advanceErr)
	}
	m4LifecycleNoPartialWrite(t, f, view.ID)

	// The fixture's placeholder shape (`{"nodes":[]}`, no scopes) is a row that
	// pins no plan at all: the store falls back to its wired advancer, and with
	// none wired the advance refuses with runtime.ErrNoProgram rather than
	// inventing an empty graph.
	placeholder := m4LifecycleCorruptRun(t, f, caller, runStore, m4Runtime, "m4-life-placeholder-1",
		`'{"nodes":[]}'::jsonb`)
	perr := m4Runtime.Advance(ctx, placeholder.ID)
	t.Logf("placeholder refusal: %v", perr)
	if !errors.Is(perr, runtime.ErrNoProgram) {
		t.Errorf("advance on a placeholder snapshot = %v, want runtime.ErrNoProgram", perr)
	}
	m4LifecycleNoPartialWrite(t, f, placeholder.ID)
}

// m4LifecycleCorruptRun creates an API run and rewrites its pinned snapshot
// with the raw jsonb literal a corrupt row would carry.
func m4LifecycleCorruptRun(t *testing.T, f *m4Fixture, caller api.Caller,
	runStore *RunStore, m4Runtime *RuntimeStore, key, snapshotSQL string) api.RunView {
	t.Helper()
	ctx := testCtx(t)
	view, _, err := APIRunStore{Runs: runStore, Runtime: m4Runtime}.CreateRun(ctx, caller,
		api.RunCreateInput{
			ProjectID:          f.projectID,
			PipelineRevisionID: f.revisionID,
			Inputs:             map[string]json.RawMessage{},
			Key:                key,
			RequestSHA:         m4Hex("body/" + key),
			TriggeredBy:        f.userID,
		})
	if err != nil {
		t.Fatalf("CreateRun(%s): %v", key, err)
	}
	if _, err := f.pool.Exec(ctx, `UPDATE runs SET plan_snapshot = `+snapshotSQL+
		` WHERE id = $1::uuid`, view.ID); err != nil {
		t.Fatalf("rewrite plan_snapshot: %v", err)
	}
	return view
}

// m4LifecycleNoPartialWrite asserts the refused transaction wrote nothing:
// the run keeps its pre-advance shape.
func m4LifecycleNoPartialWrite(t *testing.T, f *m4Fixture, runID string) {
	t.Helper()
	var nodes int
	if err := f.pool.QueryRow(testCtx(t),
		`SELECT count(*) FROM node_executions WHERE run_id = $1::uuid`, runID).
		Scan(&nodes); err != nil {
		t.Fatalf("count node rows: %v", err)
	}
	if nodes != 0 {
		t.Errorf("refused advance wrote %d node_executions rows, want 0", nodes)
	}
}

// m4LifecycleMop unwinds everything the lifecycle test touched, in the one
// order the foreign keys allow: the run's rows (which pin the assignment), the
// assignment (which pins the revision), then the revision slice itself. The
// fixture's own sweep runs afterwards and finds nothing left to delete.
func m4LifecycleMop(t *testing.T, f *m4Fixture, pipelineID string) {
	t.Helper()
	bg := context.Background()
	projectScoped := []string{
		`DELETE FROM secret_materializations WHERE attempt_id IN
			(SELECT a.id FROM attempts a JOIN runs r ON r.id = a.run_id WHERE r.project_id = $1)`,
		`UPDATE conversation_turns SET node_attempt_id = NULL WHERE node_attempt_id IN
			(SELECT a.id FROM attempts a JOIN runs r ON r.id = a.run_id WHERE r.project_id = $1)`,
		`DELETE FROM run_checkpoints WHERE run_id IN (SELECT id FROM runs WHERE project_id = $1)`,
		`DELETE FROM approval_requests WHERE run_id IN (SELECT id FROM runs WHERE project_id = $1)`,
		`DELETE FROM pipeline_invocations WHERE run_id IN (SELECT id FROM runs WHERE project_id = $1)
		   OR child_run_id IN (SELECT id FROM runs WHERE project_id = $1)`,
		`DELETE FROM attempts WHERE run_id IN (SELECT id FROM runs WHERE project_id = $1)`,
		`DELETE FROM node_executions WHERE run_id IN (SELECT id FROM runs WHERE project_id = $1)`,
		`DELETE FROM run_idempotency_keys WHERE project_id = $1`,
		`DELETE FROM outbox WHERE global_seq IN
			(SELECT global_seq FROM domain_events WHERE run_id IN
				(SELECT id FROM runs WHERE project_id = $1))`,
		`DELETE FROM domain_events WHERE run_id IN (SELECT id FROM runs WHERE project_id = $1)`,
		`DELETE FROM run_inputs WHERE run_id IN (SELECT id FROM runs WHERE project_id = $1)`,
		`DELETE FROM workspaces WHERE project_id = $1`,
		// runs self-reference through parent_run_id: deepest level first.
		`DELETE FROM runs WHERE project_id = $1 AND depth = 2`,
		`DELETE FROM runs WHERE project_id = $1 AND depth = 1`,
		`DELETE FROM runs WHERE project_id = $1 AND depth = 0`,
		`DELETE FROM assignments WHERE project_id = $1`,
	}
	pipelineScoped := []string{
		`UPDATE pipeline_drafts SET published_revision_id = NULL WHERE pipeline_id = $1`,
		`DELETE FROM pipeline_revisions WHERE pipeline_id = $1`,
		`DELETE FROM pipeline_drafts WHERE pipeline_id = $1`,
		`DELETE FROM pipelines WHERE id = $1`,
	}
	for _, sql := range append(projectScoped, pipelineScoped...) {
		id := f.projectID
		for _, scoped := range pipelineScoped {
			if sql == scoped {
				id = pipelineID
			}
		}
		if _, err := f.pool.Exec(bg, sql, id); err != nil {
			t.Errorf("cleanup %q: %v", sql, err)
		}
	}
	// Org-scoped pipeline events carry no run_id, so the sweep above never
	// reaches them.
	m4APIEventsMopped(t, f.pool, pipelineID)
}

// TestM4RunLifecycleBindingsClaimResolvesConfig is the § 4 step 6 / § 5.1 step 3
// gate for the live lab: the CONTROL PLANE resolves a node's `${{ }}` config
// bindings, so the attempt a worker claims must arrive fully interpolated — no
// `${{` anywhere in its Config, and the plan node's prompt carrying the run's
// own goal input. A claim that still carried an expression is the bug this
// proves absent (§ 4 step 14: the worker never evaluates).
func TestM4RunLifecycleBindingsClaimResolvesConfig(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)
	_, planJSON := m4LifecyclePlan(t)
	pipelineID, revisionID := m4LifecyclePublished(t, f, planJSON)

	caller := api.Caller{UserID: f.userID, OrganizationID: f.orgID, IsOrgAdmin: true}
	runStore := &RunStore{Pool: f.pool}
	children := &M4Children{Runs: runStore}
	m4Runtime := NewRuntimeStore(f.pool, &runtime.Advancer{
		Deps: runtime.AdvancerDeps{Children: children},
	})
	children.Runtime = m4Runtime
	as, err := APIAssignmentStore{S: f.pipelines}.CreateAssignment(ctx, caller, f.projectID,
		api.AssignmentCreateInput{PipelineID: pipelineID, PinnedRevisionID: revisionID,
			MaxConcurrentRuns: 1})
	if err != nil {
		t.Fatalf("CreateAssignment: %v", err)
	}
	const goal = "make bindings resolve at claim time"
	view, created, err := APIRunStore{Runs: runStore, Runtime: m4Runtime}.CreateRun(ctx, caller,
		api.RunCreateInput{
			ProjectID:    f.projectID,
			AssignmentID: as.ID,
			Inputs: map[string]json.RawMessage{
				"goal":                json.RawMessage("\"" + goal + "\""),
				"repository":          json.RawMessage(`"repo-a"`),
				"acceptance_criteria": json.RawMessage(`"tests pass"`),
				"fanout":              json.RawMessage(`false`),
				"fanout_count":        json.RawMessage(`0`),
			},
			Key:         "m4-life-bindings-1",
			RequestSHA:  m4Hex("body/m4-life-bindings-1"),
			TriggeredBy: f.userID,
		})
	if err != nil || !created {
		t.Fatalf("CreateRun = (%v, %v)", created, err)
	}
	if err := m4Runtime.Advance(ctx, view.ID); err != nil {
		t.Fatalf("advance: %v", err)
	}

	workerID := m4Worker(t, ctx, f.pool, "bindings", 1)
	claims, err := (&AttemptStore{Runs: runStore}).ClaimAttempts(ctx, workerID, 1)
	if err != nil || len(claims) == 0 {
		t.Fatalf("ClaimAttempts = (%d claims, %v), want the queued plan attempt", len(claims), err)
	}
	var cfg map[string]any
	var nodeIDs []string
	for _, cl := range claims {
		nodeIDs = append(nodeIDs, cl.NodeID)
		if cl.NodeID == "plan" {
			cfg = cl.Config
		}
	}
	if cfg == nil {
		t.Fatalf("claimed nodes = %v, want the plan node's attempt", nodeIDs)
	}
	raw, err := json.Marshal(cfg)
	if err != nil {
		t.Fatalf("marshal claim config: %v", err)
	}
	if strings.Contains(string(raw), "${{") {
		t.Errorf("claimed config still carries an expression binding: %s", raw)
	}
	if strings.Contains(string(raw), "$unresolved") {
		t.Errorf("claimed config carries an unresolved marker: %s", raw)
	}
	prompt, _ := cfg["prompt"].(string)
	if prompt == "" {
		t.Fatalf("claim config = %#v, want a hydrated string prompt", cfg)
	}
	if !strings.Contains(prompt, goal) {
		t.Errorf("prompt = %q, want it to carry the run's goal input %q", prompt, goal)
	}
	if !strings.Contains(prompt, "tests pass") {
		t.Errorf("prompt = %q, want the acceptance_criteria input interpolated too", prompt)
	}
	t.Logf("resolved prompt for run %s: %q", view.ID, prompt)

	// Every evaluation is counted (contract § 6's budget is only real if the
	// claim-time path pays it too).
	var evals int
	if err := f.pool.QueryRow(ctx,
		`SELECT expression_evaluations FROM runs WHERE id = $1::uuid`, view.ID).Scan(&evals); err != nil {
		t.Fatalf("read expression_evaluations: %v", err)
	}
	if evals == 0 {
		t.Errorf("runs.expression_evaluations = 0 after claim resolution, want > 0")
	}
}

// ---------------------------------------------------------------- retry re-arm

// m4LifeNodeStatuses reads node_executions back from the database.
func m4LifeNodeStatuses(t *testing.T, f *m4Fixture, runID string) map[string]string {
	t.Helper()
	rows, err := f.pool.Query(context.Background(), `
		SELECT node_instance_key, status FROM node_executions WHERE run_id = $1::uuid`, runID)
	if err != nil {
		t.Fatalf("read node_executions: %v", err)
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var k, s string
		if err := rows.Scan(&k, &s); err != nil {
			t.Fatalf("scan node_executions: %v", err)
		}
		out[k] = s
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("scan node_executions: %v", err)
	}
	return out
}

// m4LifeEvents lists the run's journaled event types in append order.
func m4LifeEvents(t *testing.T, f *m4Fixture, runID string) []string {
	t.Helper()
	rows, err := f.pool.Query(context.Background(), `
		SELECT type FROM domain_events WHERE run_id = $1::uuid ORDER BY global_seq`, runID)
	if err != nil {
		t.Fatalf("read domain_events: %v", err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			t.Fatalf("scan domain_events: %v", err)
		}
		out = append(out, s)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("scan domain_events: %v", err)
	}
	return out
}

// m4LifeRunWiring builds the run stores exactly as cmd/communication/serve.go does.
func m4LifeRunWiring(f *m4Fixture) (*RunStore, *RuntimeStore, APIRunStore) {
	runStore := &RunStore{Pool: f.pool}
	children := &M4Children{Runs: runStore}
	rt := NewRuntimeStore(f.pool, &runtime.Advancer{Deps: runtime.AdvancerDeps{Children: children}})
	children.Runtime = rt
	return runStore, rt, APIRunStore{Runs: runStore, Runtime: rt}
}

// TestM4RunLifecycleRetryRearmsDownstream is the live-lab defect as a test: an
// API run whose first worker node fails to the end of its budget (the M4 exit
// seed's /plan, closed failed/infra three times the way the attempt store
// does) fails the run with node_execution_failed:/plan and cascade-cancels
// /approve. Retrying it through the public API must re-arm /plan AND let the
// run proceed exactly as a fresh run would from that point: /approve waits for
// a human, it must NOT be jumped straight to ready (where its config binding
// reads a plan with no outputs and errors predicate_error:/approve, failing
// the run again and cascade-cancelling the retried attempt before any worker
// claims it).
func TestM4RunLifecycleRetryRearmsDownstream(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)
	_, planJSON := m4LifecyclePlan(t)
	pipelineID, revisionID := m4LifecyclePublished(t, f, planJSON)

	caller := api.Caller{UserID: f.userID, OrganizationID: f.orgID, IsOrgAdmin: true}
	assignments := APIAssignmentStore{S: f.pipelines}
	as, err := assignments.CreateAssignment(ctx, caller, f.projectID, api.AssignmentCreateInput{
		PipelineID: pipelineID, PinnedRevisionID: revisionID, MaxConcurrentRuns: 1,
	})
	if err != nil {
		t.Fatalf("CreateAssignment: %v", err)
	}
	_, m4Runtime, runs := m4LifeRunWiring(f)

	view, _, err := runs.CreateRun(ctx, caller, api.RunCreateInput{
		ProjectID: f.projectID, AssignmentID: as.ID,
		Inputs: map[string]json.RawMessage{
			"goal": json.RawMessage(`"add feature"`), "repository": json.RawMessage(`"repo-a"`),
			"acceptance_criteria": json.RawMessage(`"tests pass"`),
			"fanout":              json.RawMessage(`false`), "fanout_count": json.RawMessage(`0`),
		},
		Key: "m4-life-retry-1", RequestSHA: m4Hex("body/m4-life-retry-1"), TriggeredBy: f.userID,
	})
	if err != nil {
		t.Fatalf("CreateRun: %v", err)
	}
	if err := m4Runtime.Advance(ctx, view.ID); err != nil {
		t.Fatalf("first advance: %v", err)
	}
	workerID := m4Worker(t, ctx, f.pool, "retry", 4)

	// Drive /plan to its terminal failure: three failed/infra closes (the
	// attempt store's own path), with the persisted backoff pulled into the
	// past so the next queued attempt is claimable immediately.
	for i := 0; i < 6; i++ {
		if _, err := f.pool.Exec(ctx, `
			UPDATE attempts SET scheduled_at = now() - interval '1 minute'
			WHERE run_id = $1::uuid AND status = 'queued'`, view.ID); err != nil {
			t.Fatalf("age queued attempts: %v", err)
		}
		a, err := m4Runtime.Claim(ctx, view.ID, workerID)
		if err != nil {
			t.Fatalf("claim: %v", err)
		}
		if a == nil {
			break
		}
		if err := m4Runtime.Start(ctx, view.ID, a.ID, workerID, a.FencingToken); err != nil {
			t.Fatalf("start: %v", err)
		}
		if err := m4Runtime.Fail(ctx, view.ID, a.ID, workerID, a.FencingToken,
			runtime.ErrInfra, "lab: agent process exited", nil); err != nil {
			t.Fatalf("fail attempt %d: %v", a.AttemptNumber, err)
		}
	}

	var runStatus, runCause string
	if err := f.pool.QueryRow(ctx,
		`SELECT status, coalesce(failed_cause,'') FROM runs WHERE id = $1::uuid`, view.ID).
		Scan(&runStatus, &runCause); err != nil {
		t.Fatalf("read run: %v", err)
	}
	before := m4LifeNodeStatuses(t, f, view.ID)
	t.Logf("after failures: run=%s/%s nodes=%v", runStatus, runCause, before)
	if runStatus != runtime.RunFailed || runCause != "node_execution_failed:/plan" {
		t.Fatalf("run = %s/%s, want failed/node_execution_failed:/plan", runStatus, runCause)
	}
	if before["/plan"] != runtime.NodeFailed {
		t.Fatalf("/plan = %s, want failed", before["/plan"])
	}
	if before["/approve"] != runtime.NodeCancelled {
		t.Fatalf("/approve = %s, want cancelled (cascade)", before["/approve"])
	}

	// --- retry through the public API (route 31), the lab's exact call: no
	// explicit targets, so every non-succeeded terminal row is a target.
	if _, err := runs.RetryRun(ctx, caller, view.ID, api.RunRetryInput{Reason: "lab retry"}); err != nil {
		t.Fatalf("RetryRun: %v", err)
	}
	after := m4LifeNodeStatuses(t, f, view.ID)
	t.Logf("right after retry: nodes=%v", after)

	var runStatus2 string
	if err := f.pool.QueryRow(ctx,
		`SELECT status FROM runs WHERE id = $1::uuid`, view.ID).Scan(&runStatus2); err != nil {
		t.Fatalf("read run after retry: %v", err)
	}
	if runStatus2 == runtime.RunFailed {
		t.Fatalf("the retry failed the run again (nodes=%v, events=%v)", after, m4LifeEvents(t, f, view.ID))
	}
	// Readiness is the advancer's alone (§ 5.1 step 2): a re-armed downstream
	// node returns to pending and is re-readied once its dependencies are
	// genuinely succeeded again. Jumping it to ready is what produced the
	// live lab's predicate_error:/approve.
	if after["/approve"] != runtime.NodePending {
		t.Errorf("/approve = %s right after retry, want %s", after["/approve"], runtime.NodePending)
	}
	// The retried attempt is appended (history stays append-only) with the
	// decision's retry_context, and is still alive.
	var attemptNo int
	var attemptStatus, retryCtx string
	if err := f.pool.QueryRow(ctx, `
		SELECT a.attempt_number, a.status, coalesce(a.retry_context::text, '')
		FROM attempts a JOIN node_executions ne ON ne.id = a.node_execution_id
		WHERE ne.run_id = $1::uuid AND ne.node_instance_key = '/plan'
		ORDER BY a.attempt_number DESC LIMIT 1`, view.ID).
		Scan(&attemptNo, &attemptStatus, &retryCtx); err != nil {
		t.Fatalf("read retried attempt: %v", err)
	}
	t.Logf("retried plan attempt: #%d %s ctx=%s", attemptNo, attemptStatus, retryCtx)
	if attemptNo != 4 || attemptStatus != runtime.AttemptQueued {
		t.Errorf("retried plan attempt = #%d %s, want #4 queued", attemptNo, attemptStatus)
	}
	if !strings.Contains(retryCtx, "error_class") {
		t.Errorf("retried attempt retry_context = %s, want the failed attempt's error_class", retryCtx)
	}

	// --- the retried attempt lands: the run proceeds as a fresh run would.
	if _, err := f.pool.Exec(ctx, `
		UPDATE attempts SET scheduled_at = now() - interval '1 minute'
		WHERE run_id = $1::uuid AND status = 'queued'`, view.ID); err != nil {
		t.Fatalf("age retried attempt: %v", err)
	}
	a, err := m4Runtime.Claim(ctx, view.ID, workerID)
	if err != nil || a == nil {
		t.Fatalf("claim retried attempt: a=%v err=%v", a, err)
	}
	if err := m4Runtime.Start(ctx, view.ID, a.ID, workerID, a.FencingToken); err != nil {
		t.Fatalf("start retried attempt: %v", err)
	}
	var workspaceID string
	if err := f.pool.QueryRow(ctx, `
		INSERT INTO workspaces (organization_id, project_id, scope_kind, run_id, worker_id,
		                        volume_id, root_path, state, ready_at)
		VALUES ($1, $2, 'run', $3, $4, 'sha256:' || repeat('1', 64), '/workspaces/runs/retry', 'ready', now())
		RETURNING id`, f.orgID, f.projectID, view.ID, workerID).Scan(&workspaceID); err != nil {
		t.Fatalf("seed run workspace: %v", err)
	}
	ckpt := runtime.CheckpointRecord{
		InputsDigest: "sha256:" + strings.Repeat("1", 64), OutputsDigest: "sha256:" + strings.Repeat("2", 64),
		VolumeID: "sha256:" + strings.Repeat("1", 64), WorkspaceID: workspaceID, WorkerID: workerID,
	}
	if err := m4Runtime.Complete(ctx, view.ID, a.ID, workerID, a.FencingToken,
		map[string]any{"plan": "step 1: read the spec"}, "sha256:"+strings.Repeat("3", 64),
		nil, "", ckpt); err != nil {
		t.Fatalf("complete retried attempt: %v", err)
	}
	done := m4LifeNodeStatuses(t, f, view.ID)
	events := m4LifeEvents(t, f, view.ID)
	t.Logf("after the retried plan succeeded: nodes=%v events=%v", done, events)
	if done["/plan"] != runtime.NodeSucceeded {
		t.Errorf("/plan = %s after the retried attempt succeeded, want succeeded", done["/plan"])
	}
	if done["/approve"] != runtime.NodeWaiting {
		t.Errorf("/approve = %s after the retried plan succeeded, want waiting (gate open)",
			done["/approve"])
	}
	var gates int
	if err := f.pool.QueryRow(ctx, `
		SELECT count(*) FROM approval_requests ar JOIN node_executions ne ON ne.id = ar.node_execution_id
		WHERE ne.run_id = $1::uuid AND ne.node_instance_key = '/approve'
		  AND ar.state = 'pending'`, view.ID).Scan(&gates); err != nil {
		t.Fatalf("count approval requests: %v", err)
	}
	if gates != 1 {
		t.Errorf("pending /approve gates = %d, want 1", gates)
	}
	var failedAfterRetry int
	if err := f.pool.QueryRow(ctx, `
		SELECT count(*) FROM domain_events WHERE run_id = $1::uuid
		  AND type IN ('run.failed','node.execution_failed')`, view.ID).
		Scan(&failedAfterRetry); err != nil {
		t.Fatalf("count failure events: %v", err)
	}
	if failedAfterRetry != 1 {
		t.Errorf("run.failed/node.execution_failed events = %d, want exactly 1 (the original failure): "+
			"the retry cascade-cancelled its own attempt (%v)", failedAfterRetry, events)
	}
}
