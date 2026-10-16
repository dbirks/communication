package postgres

// TestM4InvokeFanout*: contract § 7.1 C8's fan-out arm against a real Postgres,
// driven by the real advancer and the real publish path. A pipeline.invoke's
// authored target is a pipeline NAME — `pipeline: issue-implementation`
// (docs/compatibility/probes/m4/pipeline.yaml:222, and C8's own words "A second
// published pipeline issue-implementation") — which the compiler validates only
// against compiler.Registries.PipelineRevs, a registry serve never wires (grep
// Registries: has no non-test hit). So the name is still a name when
// M4Children.CreateChild resolves it at run start, in the parent's
// organization, whose key is (organization_id, slug) (migration 00005:58-68).

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/dbirks/communication/internal/api"
	"github.com/dbirks/communication/internal/pipelines/compiler"
	"github.com/dbirks/communication/internal/pipelines/loader"
	"github.com/dbirks/communication/internal/pipelines/runtime"
	"github.com/dbirks/communication/internal/pipelines/schema"
)

// m4InvokeChildDoc is C8's second pipeline: two declared inputs (the invoke
// maps number+title through them) and one node the child run would execute if
// anything claimed it.
func m4InvokeChildDoc(slug string) string {
	return fmt.Sprintf(`apiVersion: communication.dev/v1alpha1
kind: Pipeline
metadata:
  name: %s
spec:
  inputs:
    type: object
    required: [number]
    properties:
      number: {type: integer}
      title: {type: string}
  policies:
    maxConcurrentNodes: 1
    maxDurationSeconds: 3600
    maxNodeExecutions: 50
    maxChildDepth: 1
    cancelPolicy: cascade
  nodes:
  - id: implement
    kind: process.exec
    timeoutSeconds: 300
    config:
      executable: m4-exit.sh
      args: [issue]
`, slug)
}

// m4InvokeParentDoc is the fan-out arm: for_each over the run's own `items`
// input (no worker needed to reach the invoke), three at a time, target BY NAME.
func m4InvokeParentDoc(childSlug string) string {
	return fmt.Sprintf(`apiVersion: communication.dev/v1alpha1
kind: Pipeline
metadata:
  name: fanout-parent
spec:
  inputs:
    type: object
    required: [items]
    properties:
      items: {type: array, items: {type: object}}
  policies:
    maxConcurrentNodes: 3
    maxDurationSeconds: 3600
    maxNodeExecutions: 200
    maxChildDepth: 1
    cancelPolicy: cascade
  nodes:
  - id: fan_out
    kind: for_each
    timeoutSeconds: 3600
    config:
      items: ${{ inputs.items }}
      maxConcurrency: 3
      onChildFailure: collect_and_continue
      body:
        nodes:
        - id: invoke
          kind: pipeline.invoke
          timeoutSeconds: 1800
          config:
            pipeline: %s
            waitFor: completion
            inputs:
              number: ${{ item.number }}
              title: ${{ item.title }}
`, childSlug)
}

// m4InvokePublish compiles a document the way a publish does (loader ->
// canonical schema -> compiler) and publishes it as a new pipeline's first
// revision. The plan bytes are the real thing a run pins.
func m4InvokePublish(t *testing.T, f *m4Fixture, slug, doc string) (string, string) {
	t.Helper()
	ctx := testCtx(t)
	parsed, d := loader.Load([]byte(doc))
	if !d.Valid() {
		t.Fatalf("loader %s: %v", slug, d)
	}
	if d := schema.MustCompile().Validate(parsed.Value); !d.Valid() {
		t.Fatalf("schema %s: %v", slug, d)
	}
	plan, d := compiler.Compile(parsed, compiler.Options{})
	if !d.Valid() {
		t.Fatalf("compiler %s: %v", slug, d)
	}
	planJSON, err := json.Marshal(plan)
	if err != nil {
		t.Fatalf("marshal plan %s: %v", slug, err)
	}
	planDigest, err := plan.Digest()
	if err != nil {
		t.Fatalf("plan digest %s: %v", slug, err)
	}
	c := api.Caller{UserID: f.userID, OrganizationID: f.orgID, IsOrgAdmin: true}
	store := APIPipelineStore{S: f.pipelines, ExtractUI: ExtractPipelineUI}
	pipe, err := store.CreatePipeline(ctx, c, slug, slug, "")
	if err != nil {
		t.Fatalf("CreatePipeline %s: %v", slug, err)
	}
	t.Cleanup(func() { m4LifecycleMop(t, f, pipe.ID) })
	draft, err := store.CreateDraft(ctx, c, pipe.ID, api.DraftCreateInput{
		DocumentYAML: doc, SourceKind: "manual", SourceSHA256: m4Hex("src/invoke/" + slug),
	})
	if err != nil {
		t.Fatalf("CreateDraft %s: %v", slug, err)
	}
	validated, err := store.RecordValidation(ctx, c, draft.ID, api.DraftValidationRecord{
		Status: "valid",
		Body: api.ValidateResponse{
			Valid: true, DigestScope: "v1alpha1-canonical-1", Errors: []api.ValidateError{},
		},
		CanonicalDocument: json.RawMessage(fmt.Sprintf(
			`{"apiVersion":"communication.dev/v1alpha1","kind":"Pipeline",`+
				`"metadata":{"name":%q}}`, slug)),
		RevisionDigest: m4Digest("invoke-rev/" + slug),
		CompiledPlan:   planJSON,
		PlanDigest:     planDigest,
		DigestScope:    "v1alpha1-canonical-1",
	})
	if err != nil {
		t.Fatalf("RecordValidation %s: %v", slug, err)
	}
	rev, err := store.PublishDraft(ctx, c, draft.ID, api.DraftPublishInput{
		ExpectedVersion: validated.Version, VersionLabel: "1.0.0", DocumentText: doc,
		SchemaDigest: m4Digest("schema"), CelEnvDigest: m4Digest("celenv"),
	})
	if err != nil {
		t.Fatalf("PublishDraft %s: %v", slug, err)
	}
	return pipe.ID, rev.ID
}

// m4InvokeDriver is the deployment's wiring copied exactly: one advancer whose
// only capability is the child resolver, over a RuntimeStore that hydrates each
// run's own pinned plan (cmd/communication/serve.go:775-777).
func m4InvokeDriver(f *m4Fixture) *RuntimeStore {
	runStore := &RunStore{Pool: f.pool}
	children := &M4Children{Runs: runStore}
	m4Runtime := NewRuntimeStore(f.pool, &runtime.Advancer{
		Deps: runtime.AdvancerDeps{Children: children},
	})
	children.Runtime = m4Runtime
	return m4Runtime
}

// m4InvokeRun assigns the parent pipeline and creates its run with `items` as
// the run input the fan-out reads. It returns the run id.
func m4InvokeRun(t *testing.T, f *m4Fixture, m4Runtime *RuntimeStore,
	pipelineID, revisionID, items string) string {
	t.Helper()
	ctx := testCtx(t)
	caller := api.Caller{UserID: f.userID, OrganizationID: f.orgID, IsOrgAdmin: true}
	// No assignment for the CHILD pipeline: its target must resolve through
	// § 5.5's second arm, the newest published revision of the named pipeline.
	as, err := APIAssignmentStore{S: f.pipelines}.CreateAssignment(ctx, caller, f.projectID,
		api.AssignmentCreateInput{PipelineID: pipelineID, PinnedRevisionID: revisionID,
			MaxConcurrentRuns: 1})
	if err != nil {
		t.Fatalf("CreateAssignment: %v", err)
	}
	token := migFixtureToken(t)
	view, created, err := APIRunStore{Runs: f.runs, Runtime: m4Runtime}.CreateRun(ctx, caller,
		api.RunCreateInput{
			ProjectID:    f.projectID,
			AssignmentID: as.ID,
			Inputs:       map[string]json.RawMessage{"items": json.RawMessage(items)},
			Key:          "m4-invoke-run-" + token,
			RequestSHA:   m4Hex("body/m4-invoke-run/" + token),
			TriggeredBy:  f.userID,
		})
	if err != nil {
		t.Fatalf("CreateRun: %v", err)
	}
	if !created || view.ID == "" {
		t.Fatalf("CreateRun view = %+v created=%v", view, created)
	}
	return view.ID
}

// TestM4InvokeFanoutByNameChildren is C8b's three-item shape against a real
// Postgres: for_each fans out over 3 items into pipeline.invoke of a child
// pipeline named BY NAME, and the advance must produce 3 child runs with
// parent_run_id set, 3 pipeline_invocations rows, and no error. Re-running the
// advance must not duplicate either.
func TestM4InvokeFanoutByNameChildren(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)
	token := migFixtureToken(t)
	childSlug := "issue-implementation-" + token
	childPipeID, childRevID := m4InvokePublish(t, f, childSlug, m4InvokeChildDoc(childSlug))
	parentPipeID, parentRevID := m4InvokePublish(t, f, "fanout-parent-"+token,
		m4InvokeParentDoc(childSlug))
	m4Runtime := m4InvokeDriver(f)

	runID := m4InvokeRun(t, f, m4Runtime, parentPipeID, parentRevID,
		`[{"number":1,"title":"one"},{"number":2,"title":"two"},{"number":3,"title":"three"}]`)
	if err := m4Runtime.Advance(ctx, runID); err != nil {
		t.Fatalf("first advance of %s: %v", runID, err)
	}

	counts := func(pass string) (inv, childRuns, invokeRows int) {
		t.Helper()
		if err := f.pool.QueryRow(ctx,
			`SELECT count(*) FROM pipeline_invocations WHERE run_id = $1::uuid`, runID).
			Scan(&inv); err != nil {
			t.Fatalf("%s: count invocations: %v", pass, err)
		}
		if err := f.pool.QueryRow(ctx,
			`SELECT count(*) FROM runs WHERE parent_run_id = $1::uuid`, runID).
			Scan(&childRuns); err != nil {
			t.Fatalf("%s: count children: %v", pass, err)
		}
		if err := f.pool.QueryRow(ctx, `
			SELECT count(*) FROM node_executions
			WHERE run_id = $1::uuid AND kind = 'pipeline.invoke'`, runID).
			Scan(&invokeRows); err != nil {
			t.Fatalf("%s: count invoke rows: %v", pass, err)
		}
		return inv, childRuns, invokeRows
	}

	inv, childRuns, invokeRows := counts("first")
	if invokeRows != 3 {
		t.Errorf("pipeline.invoke node_executions = %d, want 3 (one per item)", invokeRows)
	}
	if childRuns != 3 {
		t.Errorf("child runs of %s = %d, want 3 — the authored name must resolve, not abort the advance", runID, childRuns)
	}
	if inv != 3 {
		t.Errorf("pipeline_invocations = %d, want 3", inv)
	}

	// Each child is a real run in the parent's project at depth 1, pinned to
	// the newest published revision of the pipeline the name named (§ 5.5).
	rows, err := f.pool.Query(ctx, `
		SELECT i.child_run_id::text, i.pipeline_id::text, i.resolved_revision_id::text,
		       c.parent_run_id::text, c.project_id::text, c.depth, c.revision_digest,
		       i.wait_policy
		FROM pipeline_invocations i JOIN runs c ON c.id = i.child_run_id
		WHERE i.run_id = $1::uuid ORDER BY i.node_execution_id`, runID)
	if err != nil {
		t.Fatalf("read invocations: %v", err)
	}
	children := 0
	for rows.Next() {
		var childID, pipeID, revID, parentID, projectID, digest, waitPolicy string
		var depth int
		if err := rows.Scan(&childID, &pipeID, &revID, &parentID, &projectID, &depth,
			&digest, &waitPolicy); err != nil {
			rows.Close()
			t.Fatalf("scan invocation: %v", err)
		}
		children++
		if pipeID != childPipeID {
			t.Errorf("invocation child %s: pipeline_id = %s, want the named pipeline %s (resolved, not the name)",
				childID, pipeID, childPipeID)
		}
		if revID != childRevID {
			t.Errorf("invocation child %s: resolved_revision_id = %s, want the newest published %s",
				childID, revID, childRevID)
		}
		if parentID != runID {
			t.Errorf("child %s: parent_run_id = %s, want %s", childID, parentID, runID)
		}
		if projectID != f.projectID {
			t.Errorf("child %s: project_id = %s, want the parent's %s (contract § 5.5)",
				childID, projectID, f.projectID)
		}
		if depth != 1 {
			t.Errorf("child %s: depth = %d, want 1", childID, depth)
		}
		if waitPolicy != "completion" {
			t.Errorf("child %s: wait_policy = %s, want completion (ADR-0023 § 10)", childID, waitPolicy)
		}
	}
	rows.Close()
	if children != 3 {
		t.Errorf("joined invocation/child rows = %d, want 3", children)
	}

	// Idempotence: the advance is retried (§ 5.1's loop, § 8's "twice has one
	// effect"), and neither a second child nor a second invocation appears.
	for i := 0; i < 3; i++ {
		if err := m4Runtime.Advance(ctx, runID); err != nil {
			t.Fatalf("advance pass %d of %s: %v", i+2, runID, err)
		}
	}
	inv2, childRuns2, invokeRows2 := counts("retried")
	if inv2 != inv || childRuns2 != childRuns || invokeRows2 != invokeRows {
		t.Errorf("after retried advances: invocations=%d children=%d invoke rows=%d, want %d/%d/%d",
			inv2, childRuns2, invokeRows2, inv, childRuns, invokeRows)
	}

	// The children are waiting, not fabricated: the parent's invoke rows park
	// on child_run and each names a real child run.
	var waiting int
	if err := f.pool.QueryRow(ctx, `
		SELECT count(*) FROM node_executions
		WHERE run_id = $1::uuid AND kind = 'pipeline.invoke'
		  AND status = 'waiting' AND waiting_reason = 'child_run'`, runID).
		Scan(&waiting); err != nil {
		t.Fatalf("count waiting invoke rows: %v", err)
	}
	if waiting != 3 {
		t.Errorf("waiting invoke rows = %d, want 3 (maxConcurrency 3 bounds the fan-out, § 5.2)", waiting)
	}
}

// TestM4InvokeFanoutZeroItems is C8a: for_each over [] succeeds the scope with
// an empty children list rather than failing it — against the real store, where
// the empty result has to survive the write-back and the event.
func TestM4InvokeFanoutZeroItems(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)
	token := migFixtureToken(t)
	childSlug := "issue-implementation-" + token
	m4InvokePublish(t, f, childSlug, m4InvokeChildDoc(childSlug))
	parentPipeID, parentRevID := m4InvokePublish(t, f, "fanout-parent-"+token,
		m4InvokeParentDoc(childSlug))
	m4Runtime := m4InvokeDriver(f)

	runID := m4InvokeRun(t, f, m4Runtime, parentPipeID, parentRevID, `[]`)
	if err := m4Runtime.Advance(ctx, runID); err != nil {
		t.Fatalf("advance of the zero-item run %s: %v", runID, err)
	}

	var status, outputs string
	if err := f.pool.QueryRow(ctx, `
		SELECT status, coalesce(outputs::text, 'null') FROM node_executions
		WHERE run_id = $1::uuid AND node_instance_key = '/fan_out'`, runID).
		Scan(&status, &outputs); err != nil {
		t.Fatalf("read /fan_out of %s: %v", runID, err)
	}
	if status != "succeeded" {
		t.Errorf("/fan_out status = %s, want succeeded (C8a: zero items succeeds the scope)", status)
	}
	var outs map[string]any
	if err := json.Unmarshal([]byte(outputs), &outs); err != nil {
		t.Fatalf("decode /fan_out outputs %q: %v", outputs, err)
	}
	children, isList := outs["children"].([]any)
	if !isList {
		t.Fatalf("/fan_out outputs = %v, want a children list (contract § 5.5, ADR-0023 § 8)", outs)
	}
	if len(children) != 0 {
		t.Errorf("children = %v, want the empty list", children)
	}
	for _, tbl := range []string{"pipeline_invocations", "runs"} {
		sql := `SELECT count(*) FROM pipeline_invocations WHERE run_id = $1::uuid`
		if tbl == "runs" {
			sql = `SELECT count(*) FROM runs WHERE parent_run_id = $1::uuid`
		}
		var n int
		if err := f.pool.QueryRow(ctx, sql, runID).Scan(&n); err != nil {
			t.Fatalf("count %s of %s: %v", tbl, runID, err)
		}
		if n != 0 {
			t.Errorf("%s rows for the zero-item run = %d, want 0", tbl, n)
		}
	}
	var scopeCompleted int
	if err := f.pool.QueryRow(ctx, `
		SELECT count(*) FROM domain_events
		WHERE run_id = $1::uuid AND type = 'node.scope.completed'`, runID).
		Scan(&scopeCompleted); err != nil {
		t.Fatalf("count node.scope.completed: %v", err)
	}
	if scopeCompleted != 1 {
		t.Errorf("node.scope.completed rows = %d, want 1 (the zero-item scope completes once)", scopeCompleted)
	}
	var runStatus string
	if err := f.pool.QueryRow(ctx,
		`SELECT status FROM runs WHERE id = $1::uuid`, runID).Scan(&runStatus); err != nil {
		t.Fatalf("read run status: %v", err)
	}
	if runStatus != "completed" {
		t.Errorf("run status = %s, want completed (C8a: the run completes)", runStatus)
	}
}

// TestM4InvokeUnknownTargetNamesTheRefusal keeps the failure honest: a target
// that is neither a pipeline name of the parent's organization nor a pipeline
// id fails the node with a name — it does not silently advance past the invoke.
func TestM4InvokeUnknownTargetNamesTheRefusal(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)
	token := migFixtureToken(t)
	parentPipeID, parentRevID := m4InvokePublish(t, f, "fanout-parent-"+token,
		m4InvokeParentDoc("no-such-pipeline-"+token))
	m4Runtime := m4InvokeDriver(f)
	runID := m4InvokeRun(t, f, m4Runtime, parentPipeID, parentRevID,
		`[{"number":1,"title":"one"}]`)

	err := m4Runtime.Advance(ctx, runID)
	if err == nil {
		t.Fatalf("advance of an invoke of an unknown pipeline succeeded; the pass must fail loudly")
	}
	if !errors.Is(err, ErrPipelineNotFound) &&
		!strings.Contains(err.Error(), "not a pipeline of organization") {
		t.Errorf("advance err = %v, want the named pipeline-not-found refusal", err)
	}
	var inv, childRuns int
	if err := f.pool.QueryRow(ctx,
		`SELECT count(*) FROM pipeline_invocations WHERE run_id = $1::uuid`, runID).
		Scan(&inv); err != nil {
		t.Fatalf("count invocations: %v", err)
	}
	if err := f.pool.QueryRow(ctx,
		`SELECT count(*) FROM runs WHERE parent_run_id = $1::uuid`, runID).
		Scan(&childRuns); err != nil {
		t.Fatalf("count children: %v", err)
	}
	if inv != 0 || childRuns != 0 {
		t.Errorf("refused invoke left %d invocations / %d child runs, want 0/0 (the pass aborts)",
			inv, childRuns)
	}
}

// TestM4InvokeTargetByNameAndByIdAgree proves the two authored spellings of the
// same target reach the same child pipeline: the slug, and the uuid an author
// could have written instead (the probe library's own two forms).
func TestM4InvokeTargetByNameAndByIdAgree(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)
	token := migFixtureToken(t)
	childSlug := "issue-implementation-" + token
	childPipeID, _ := m4InvokePublish(t, f, childSlug, m4InvokeChildDoc(childSlug))
	parentPipeID, parentRevID := m4InvokePublish(t, f, "fanout-parent-"+token,
		m4InvokeParentDoc(childSlug))
	m4Runtime := m4InvokeDriver(f)
	runID := m4InvokeRun(t, f, m4Runtime, parentPipeID, parentRevID,
		`[{"number":7,"title":"seven"}]`)
	if err := m4Runtime.Advance(ctx, runID); err != nil {
		t.Fatalf("advance: %v", err)
	}
	var byName string
	if err := f.pool.QueryRow(ctx, `
		SELECT i.pipeline_id::text FROM pipeline_invocations i
		WHERE i.run_id = $1::uuid`, runID).Scan(&byName); err != nil {
		t.Fatalf("read the invoked pipeline id: %v", err)
	}
	if byName != childPipeID {
		t.Errorf("invoked pipeline_id = %s, want %s", byName, childPipeID)
	}

	// The uuid spelling resolves to the same definition.
	pin, err := m4ResolveChildRevision(ctx, f.pool, f.orgID, f.projectID, childPipeID)
	if err != nil {
		t.Fatalf("resolve the uuid spelling: %v", err)
	}
	if pin.pipelineID != childPipeID {
		t.Errorf("uuid spelling resolved to pipeline %s, want %s", pin.pipelineID, childPipeID)
	}
	byName2, err := m4ResolveChildTarget(ctx, f.pool, f.orgID, childSlug)
	if err != nil {
		t.Fatalf("resolve the name spelling: %v", err)
	}
	if byName2 != childPipeID {
		t.Errorf("name %q resolved to pipeline %s, want %s", childSlug, byName2, childPipeID)
	}
}
