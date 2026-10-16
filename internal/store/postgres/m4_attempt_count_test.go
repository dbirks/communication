package postgres

// docs/m4-live-findings.md P1 over real Postgres: node_executions.attempt_count
// is the node's attempt ledger — max(attempts.attempt_number) (contract § 7.1
// C1e: a single-attempt node reads 1). The ENGINE counts it when it queues the
// attempt; the CLAIM must not count it again. Before the fix queue(+1) and
// claim(+1) summed, so every single-attempt worker node read 2, and — worse —
// the advancer gates the retry on `attempt_count < attempt_limit`
// (advancer.go:578), so a node authored `maxAttempts: 2` got ONE real try.
//
// This test walks the whole loop through the faces each actor really uses:
// RuntimeStore.Advance for the engine, AttemptStore.ClaimAttempts/BeginAttempt/
// FailAttempt for the worker, and reads the ledger from the rows.

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/dbirks/communication/internal/pipelines/compiler"
	"github.com/dbirks/communication/internal/pipelines/loader"
	"github.com/dbirks/communication/internal/pipelines/runtime"
	"github.com/dbirks/communication/internal/pipelines/schema"
	"github.com/dbirks/communication/internal/worker"
)

// m4AttemptCountYAML is one worker node with a two-attempt budget: the
// smallest document whose second attempt is the thing under test.
const m4AttemptCountYAML = `
apiVersion: communication.dev/v1alpha1
kind: Pipeline
metadata:
  name: m4-attempt-count
spec:
  inputs:
    type: object
    required: [goal]
    properties:
      goal: {type: string, minLength: 1}
  policies:
    maxConcurrentNodes: 4
    maxDurationSeconds: 3600
    maxNodeExecutions: 50
    cancelPolicy: cascade
  nodes:
  - id: implement
    kind: process.exec
    retry:
      maxAttempts: 2
      backoff: {baseSeconds: 1, multiplier: 1, maxSeconds: 1, jitter: false}
      retriableErrors: [infra]
    config:
      executable: implement
  resultBindings:
    done: ${{ nodes.implement.outputs.ok }}
`

// m4AttemptCountPlan compiles the document for real (loader → schema →
// compiler → PreparePlan), exactly as m4DriverPlan does: a hand-written plan
// jsonb would test a program no pipeline could publish.
func m4AttemptCountPlan(t *testing.T) (*runtime.Program, json.RawMessage) {
	t.Helper()
	doc, d := loader.Load([]byte(m4AttemptCountYAML))
	if !d.Valid() {
		t.Fatalf("loader: %v", d)
	}
	if d := schema.MustCompile().Validate(doc.Value); !d.Valid() {
		t.Fatalf("schema: %v", d)
	}
	plan, d := compiler.Compile(doc, compiler.Options{})
	if !d.Valid() {
		t.Fatalf("compiler: %v", d)
	}
	prog, d := runtime.PreparePlan(plan)
	if !d.Valid() {
		t.Fatalf("PreparePlan: %v", d)
	}
	raw, err := json.Marshal(plan)
	if err != nil {
		t.Fatalf("marshal plan: %v", err)
	}
	return prog, json.RawMessage(raw)
}

// m4AttemptCountSetup publishes the two-attempt pipeline, creates a run pinned
// to it and moves the run to 'running' (the claim predicate demands it), and
// returns the fixture, the ENGINE face, the worker face, the run id and an
// online worker with capacity 1.
func m4AttemptCountSetup(t *testing.T) (*m4Fixture, *RuntimeStore, *AttemptStore, string, string) {
	t.Helper()
	ctx := testCtx(t)
	url := mustMigrate(t)
	pool, err := Open(ctx, url)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(pool.Close)
	f := m4SetupShared(t, ctx, pool)
	prog, planJSON := m4AttemptCountPlan(t)

	revDigest := m4Digest("ac-rev/" + migFixtureToken(t))
	draft, err := f.pipelines.CreateDraft(ctx, NewDraft{
		PipelineID: f.pipelineID, DocumentText: m4AttemptCountYAML, SourceKind: "manual",
		SourceSHA256: m4Hex("ac-src/" + revDigest), EditedBy: f.userID,
	})
	if err != nil {
		t.Fatalf("CreateDraft: %v", err)
	}
	if _, err := f.pipelines.RecordValidation(ctx, draft.ID, "valid", DraftValidation{
		CanonicalDocument: json.RawMessage(`{"apiVersion":"communication.dev/v1alpha1","kind":"Pipeline","name":"m4-attempt-count"}`),
		RevisionDigest:    revDigest,
		CompiledPlan:      planJSON,
		PlanDigest:        m4Digest("ac-plan/" + migFixtureToken(t)),
		Validation:        json.RawMessage(`[]`),
	}); err != nil {
		t.Fatalf("RecordValidation: %v", err)
	}
	rev, err := f.pipelines.PublishDraft(ctx, draft.ID, NewRevision{
		VersionLabel: "1.1.0", DocumentText: m4AttemptCountYAML,
		SchemaDigest: m4Digest("ac-schema"), CelEnvDigest: m4Digest("ac-celenv"),
		PublishedBy: f.userID, ExpectedDraftVersion: draft.Version,
	})
	if err != nil {
		t.Fatalf("PublishDraft: %v", err)
	}

	goal, err := json.Marshal("count the attempts honestly")
	if err != nil {
		t.Fatalf("encode input: %v", err)
	}
	run, created, err := f.runs.CreateRun(ctx, NewRun{
		OrganizationID: f.orgID, ProjectID: f.projectID, PipelineID: f.pipelineID,
		PipelineRevisionID: rev.ID, RevisionDigest: rev.RevisionDigest, PlanDigest: f.planDigest,
		PlanSnapshot: planJSON, PoliciesSnapshot: json.RawMessage(`{}`),
		TriggeredBy: f.userID,
		Inputs:      map[string]RunInput{"goal": {Value: goal, Origin: "submitted"}},
	})
	if err != nil || !created {
		t.Fatalf("CreateRun = (%v, %v), want a fresh run", err, created)
	}
	if _, err := f.runs.SetRunStatus(ctx, run.ID, RunStatusInput{Status: "running"}); err != nil {
		t.Fatalf("start run: %v", err)
	}
	return f, NewRuntimeStore(pool, &runtime.Advancer{Prog: prog}),
		&AttemptStore{Runs: &RunStore{Pool: pool, LeaseTTL: 2 * time.Second}},
		run.ID, m4Worker(t, ctx, f.pool, "attempt-count", 1)
}

// acLedger is the pair the contract reads: the node's attempt_count beside
// max(attempts.attempt_number) and the node's status. They must agree —
// attempt_count IS the attempt ledger, not a second counter.
func acLedger(t *testing.T, ctx context.Context, f *m4Fixture, nodeID string) (int, int, string) {
	t.Helper()
	var count, maxNum int
	var status string
	if err := f.pool.QueryRow(ctx, `
		SELECT n.attempt_count,
		       COALESCE((SELECT max(a.attempt_number) FROM attempts a
		                 WHERE a.node_execution_id = n.id), 0),
		       n.status
		FROM node_executions n WHERE n.id = $1::uuid`, nodeID).
		Scan(&count, &maxNum, &status); err != nil {
		t.Fatalf("read the attempt ledger: %v", err)
	}
	return count, maxNum, status
}

// acNodeID finds the run's implement node once the engine has materialized it.
func acNodeID(t *testing.T, ctx context.Context, f *m4Fixture, runID string) string {
	t.Helper()
	var id string
	if err := f.pool.QueryRow(ctx, `
		SELECT id FROM node_executions WHERE run_id = $1::uuid AND node_id = 'implement'`,
		runID).Scan(&id); err != nil {
		t.Fatalf("find the implement node: %v", err)
	}
	return id
}

// acClaim wins exactly one attempt for the worker.
func acClaim(t *testing.T, ctx context.Context, store *AttemptStore, workerID string) worker.AttemptClaim {
	t.Helper()
	claims, err := store.ClaimAttempts(ctx, workerID, 1)
	if err != nil {
		t.Fatalf("ClaimAttempts: %v", err)
	}
	if len(claims) != 1 {
		t.Fatalf("claim won %d attempts, want 1", len(claims))
	}
	return claims[0]
}

// TestAttemptCountOnePerAttempt is docs/m4-live-findings.md P1's regression:
// one queued+claimed attempt counts ONE, and a node authored maxAttempts: 2
// really gets a second try.
func TestAttemptCountOnePerAttempt(t *testing.T) {
	f, rs, store, runID, workerID := m4AttemptCountSetup(t)
	ctx := testCtx(t)

	// 1. The engine materializes the node and queues attempt 1: the queue is
	//    where the count is earned (contract § 7.1 C1e).
	if err := rs.Advance(ctx, runID); err != nil {
		t.Fatalf("first advance: %v", err)
	}
	nodeID := acNodeID(t, ctx, f, runID)
	if count, maxNum, status := acLedger(t, ctx, f, nodeID); count != 1 || maxNum != 1 || status != runtime.NodeReady {
		t.Fatalf("after queueing = (count %d, max attempt_number %d, %s), want (1, 1, %s)",
			count, maxNum, status, runtime.NodeReady)
	}

	// 2. The worker claims it — the claim must not count again. Before the fix
	//    this row read (2, 1): queue(+1) plus claim(+1).
	first := acClaim(t, ctx, store, workerID)
	if first.AttemptNumber != 1 {
		t.Fatalf("first claim = attempt_number %d, want 1", first.AttemptNumber)
	}
	if count, maxNum, status := acLedger(t, ctx, f, nodeID); count != 1 || maxNum != 1 || status != "leased" {
		t.Errorf("after the claim = (count %d, max attempt_number %d, %s), want (1, 1, leased)",
			count, maxNum, status)
	}
	if err := store.BeginAttempt(ctx, first); err != nil {
		t.Fatalf("BeginAttempt: %v", err)
	}

	// 3. A retriable failure returns the node to ready and the ADVANCER
	//    decides the retry from rows (§ 4 step 9).
	if err := store.FailAttempt(ctx, first, "infra", "simulated infra fault", nil); err != nil {
		t.Fatalf("FailAttempt: %v", err)
	}
	if err := rs.Advance(ctx, runID); err != nil {
		t.Fatalf("advance after the failure: %v", err)
	}
	if count, maxNum, status := acLedger(t, ctx, f, nodeID); count != 2 || maxNum != 2 || status != runtime.NodeReady {
		t.Fatalf("after the retry was queued = (count %d, max attempt_number %d, %s), want (2, 2, %s): "+
			"a maxAttempts: 2 node must get its second try", count, maxNum, status, runtime.NodeReady)
	}

	// 4. The retry's 1 s backoff has not elapsed inside the test; age the row
	//    instead of sleeping (the claim predicate reads scheduled_at <= now()).
	second := acAttemptID(t, ctx, f, nodeID, 2)
	if _, err := f.pool.Exec(ctx,
		`UPDATE attempts SET scheduled_at = now() - interval '1 second' WHERE id = $1::uuid`, second); err != nil {
		t.Fatalf("age the retry's backoff: %v", err)
	}
	again := acClaim(t, ctx, store, workerID)
	if again.AttemptNumber != 2 {
		t.Fatalf("second claim = attempt_number %d, want 2 (attempt_number stays 1, 2, …)", again.AttemptNumber)
	}
	if again.AttemptID != second {
		t.Errorf("second claim won attempt %s, want the retry attempt %s", again.AttemptID, second)
	}
	if count, maxNum, status := acLedger(t, ctx, f, nodeID); count != 2 || maxNum != 2 || status != "leased" {
		t.Errorf("after the second claim = (count %d, max attempt_number %d, %s), want (2, 2, leased)",
			count, maxNum, status)
	}
	if st := func() string {
		var s string
		if err := f.pool.QueryRow(ctx, `SELECT status FROM runs WHERE id = $1::uuid`, runID).Scan(&s); err != nil {
			t.Fatalf("read run status: %v", err)
		}
		return s
	}(); st != runtime.RunRunning {
		t.Errorf("run status = %s, want %s — the retry budget is not spent", st, runtime.RunRunning)
	}
}

// acAttemptID names the attempt row with the given number.
func acAttemptID(t *testing.T, ctx context.Context, f *m4Fixture, nodeID string, number int) string {
	t.Helper()
	var id string
	if err := f.pool.QueryRow(ctx, `
		SELECT id FROM attempts WHERE node_execution_id = $1::uuid AND attempt_number = $2`,
		nodeID, number).Scan(&id); err != nil {
		t.Fatalf("find attempt n%d: %v", number, err)
	}
	return id
}
