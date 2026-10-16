package postgres

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/dbirks/communication/internal/worker"
)

// C10 on the REAL database (docs/m4-contract.md § 7.1, ADR-0022 § 4 rule 2):
// the worker's boundary write is what owns the declared-outputs guarantee, so
// these tests drive postgres.AttemptStore.CompleteAttempt against a run whose
// PINNED plan_snapshot declares `evidence: boolean` while the reply answers a
// string. Every assertion reads rows back through SQL — the same evidence the
// § 7.1 gate collects with psql.

// c10ReviewPlan is the twin's snapshot: one process.exec reviewer with the
// schema-invalid outputs declaration and the retry budget the gate cites
// (maxAttempts 2, invalid_output retriable).
const c10ReviewPlan = `{
	"version": "v1alpha1-plan-1",
	"nodes": [{
		"id": "review", "scope": "/", "kind": "process.exec",
		"outputs": {
			"type": "object",
			"required": ["approved", "evidence"],
			"properties": {
				"approved": {"type": "boolean"},
				"evidence": {"type": "boolean"}
			}
		},
		"retry": {"maxAttempts": 2, "retriableErrors": ["infra", "interrupted", "invalid_output"]},
		"configBindings": [
			{"pointer": "/spec/nodes/0/config/executable", "position": "literal", "literal": "m4-exit.sh"}
		]
	}]
}`

// c10Seed seeds the reviewer node and its first attempt, claims them, and
// returns the live claim.
func c10Seed(t *testing.T, ctx context.Context, f *m4Fixture, store *AttemptStore, tag string) worker.AttemptClaim {
	t.Helper()
	runID := f.m4QueuedRun(t, ctx, "", 0)
	if _, err := f.pool.Exec(ctx, `UPDATE runs SET plan_snapshot = $2 WHERE id = $1::uuid`, runID, c10ReviewPlan); err != nil {
		t.Fatalf("pin the reviewer plan: %v", err)
	}
	node, err := f.runs.InsertNodeExecution(ctx, NewNodeExecution{
		RunID: runID, NodeID: "review", Kind: "process.exec",
		NodeInstanceKey: "/review", ScopeKey: "/",
		ExecutionLocation: "worker", AttemptLimit: 2,
	})
	if err != nil {
		t.Fatalf("seed the reviewer node: %v", err)
	}
	if _, err := f.runs.SetNodeStatus(ctx, node.ID, NodeStatusInput{Status: "ready"}); err != nil {
		t.Fatalf("ready: %v", err)
	}
	if _, err := f.runs.QueueAttempt(ctx, NewAttempt{NodeExecutionID: node.ID, AttemptNumber: 1}); err != nil {
		t.Fatalf("queue attempt 1: %v", err)
	}
	wid := m4Worker(t, ctx, f.pool, tag, 1)
	claims, err := store.ClaimAttempts(ctx, wid, 1)
	if err != nil || len(claims) != 1 {
		t.Fatalf("claim = (%v, %v)", claims, err)
	}
	if err := store.BeginAttempt(ctx, claims[0]); err != nil {
		t.Fatalf("begin attempt: %v", err)
	}
	return claims[0]
}

// c10Rows reads back the ledger evidence of one attempt and its node.
func c10Rows(t *testing.T, ctx context.Context, f *m4Fixture, claim worker.AttemptClaim) (
	attStatus, attClass, attOutputs, attErrs, nodeStatus string, nodeOutputs *string) {
	t.Helper()
	var outs, errs *string
	if err := f.pool.QueryRow(ctx, `
		SELECT a.status, COALESCE(a.error_class, ''), a.outputs::text, a.output_errors::text
		FROM attempts a WHERE a.id = $1::uuid`, claim.AttemptID).Scan(&attStatus, &attClass, &outs, &errs); err != nil {
		t.Fatalf("read attempt %s: %v", claim.AttemptID, err)
	}
	if outs != nil {
		attOutputs = *outs
	}
	attErrs = "{}"
	if errs != nil {
		attErrs = *errs
	}
	if err := f.pool.QueryRow(ctx, `
		SELECT ne.status, ne.outputs FROM node_executions ne WHERE ne.id = $1::uuid`,
		claim.NodeExecutionID).Scan(&nodeStatus, &nodeOutputs); err != nil {
		t.Fatalf("read the reviewer node: %v", err)
	}
	return
}

// c10CheckpointCount counts the boundary's durable record for one attempt.
func c10CheckpointCount(t *testing.T, ctx context.Context, f *m4Fixture, claim worker.AttemptClaim) int {
	t.Helper()
	var n int
	if err := f.pool.QueryRow(ctx,
		`SELECT count(*) FROM run_checkpoints WHERE attempt_id = $1::uuid`, claim.AttemptID).Scan(&n); err != nil {
		t.Fatalf("count checkpoints: %v", err)
	}
	return n
}

// TestC10BoundaryRefusesSchemaInvalidReply is C10a/C10b's core arm: a reply
// that violates its node's declared outputs closes the attempt
// failed/invalid_output, its JSON-Schema locations land in output_errors, and
// NOTHING the reply produced becomes visible anywhere.
func TestC10BoundaryRefusesSchemaInvalidReply(t *testing.T) {
	ctx := testCtx(t)
	f, store := awSetup(t)
	claim := c10Seed(t, ctx, f, store, "c10refuse")
	wsID := m4Workspace(t, ctx, f, claim.RunID)

	malformed := map[string]any{
		"approved": true,
		"evidence": "deterministic review: plan followed (docstring + corrected assertion)",
	}
	if err := store.CompleteAttempt(ctx, claim, malformed, m4Digest("outs"), nil, "passed",
		worker.AttemptCheckpoint{
			InputsDigest: m4Digest("in"), OutputsDigest: m4Digest("outs"),
			WorkspaceID: wsID, VolumeID: "vol-a",
		}); err != nil {
		t.Fatalf("the boundary converts the refusal into an attempt close, it does not error: %v", err)
	}

	attStatus, attClass, attOutputs, attErrs, nodeStatus, nodeOutputs := c10Rows(t, ctx, f, claim)
	if attStatus != "failed" || attClass != "invalid_output" {
		t.Fatalf("attempt closed %s/%s, want failed/invalid_output — a succeeded review IS the engine reading the reply as a business verdict",
			attStatus, attClass)
	}
	if attOutputs != "" && attOutputs != "null" {
		t.Fatalf("the rejected attempt carries outputs %s: nothing may be published before validation (01 invariant 4)", attOutputs)
	}
	if !strings.Contains(attErrs, "/evidence") || !strings.Contains(attErrs, "#/properties/evidence") {
		t.Fatalf("output_errors = %s, want the JSON-Schema instance location /evidence and the schema location", attErrs)
	}
	if nodeOutputs != nil {
		t.Fatalf("the reviewer node_execution carries outputs %v while its reply was rejected", *nodeOutputs)
	}
	if nodeStatus != "ready" {
		t.Fatalf("reviewer node status = %s, want ready: the ADVANCER decides retry vs terminal from rows (§ 5.1)", nodeStatus)
	}
	if n := c10CheckpointCount(t, ctx, f, claim); n != 0 {
		t.Fatalf("a node that never succeeded wrote %d checkpoint row(s) (§ 4 step 10)", n)
	}

	var completed, failed, ckpts int
	if err := f.pool.QueryRow(ctx, `
		SELECT count(*) FILTER (WHERE type = 'node.attempt.completed'),
		       count(*) FILTER (WHERE type = 'node.attempt.failed'),
		       count(*) FILTER (WHERE type = 'run.checkpoint_saved')
		FROM domain_events WHERE attempt_id = $1::uuid`, claim.AttemptID).
		Scan(&completed, &failed, &ckpts); err != nil {
		t.Fatalf("read the journal: %v", err)
	}
	if completed != 0 || ckpts != 0 {
		t.Fatalf("journal of a refused envelope: node.attempt.completed=%d run.checkpoint_saved=%d, want 0/0", completed, ckpts)
	}
	if failed != 1 {
		t.Fatalf("node.attempt.failed rows = %d, want exactly 1", failed)
	}
	var payload string
	if err := f.pool.QueryRow(ctx, `
		SELECT payload::text FROM domain_events
		WHERE attempt_id = $1::uuid AND type = 'node.attempt.failed'`, claim.AttemptID).Scan(&payload); err != nil {
		t.Fatalf("read the failure payload: %v", err)
	}
	if !strings.Contains(payload, "invalid_output") || !strings.Contains(payload, "/evidence") {
		t.Fatalf("node.attempt.failed lost its error_class or its locations: %s", payload)
	}
}

// TestC10BoundaryAcceptsSchemaValidReply is the other half of the same
// boundary: a reply that satisfies its node's declared schema still succeeds,
// with its outputs, digest and checkpoint — the check is not a refusal machine.
func TestC10BoundaryAcceptsSchemaValidReply(t *testing.T) {
	ctx := testCtx(t)
	f, store := awSetup(t)
	claim := c10Seed(t, ctx, f, store, "c10accept")
	wsID := m4Workspace(t, ctx, f, claim.RunID)

	if err := store.CompleteAttempt(ctx, claim, map[string]any{"approved": true, "evidence": true},
		m4Digest("outs"), nil, "passed", worker.AttemptCheckpoint{
			InputsDigest: m4Digest("in"), OutputsDigest: m4Digest("outs"),
			WorkspaceID: wsID, VolumeID: "vol-a",
		}); err != nil {
		t.Fatalf("complete a schema-valid reply: %v", err)
	}
	attStatus, attClass, attOutputs, attErrs, nodeStatus, nodeOutputs := c10Rows(t, ctx, f, claim)
	if attStatus != "succeeded" || attClass != "" {
		t.Fatalf("a valid reply closed %s/%s, want succeeded with no error_class", attStatus, attClass)
	}
	if !strings.Contains(attOutputs, `"approved"`) {
		t.Fatalf("attempt.outputs = %s, want the validated envelope", attOutputs)
	}
	if b := strings.Trim(attErrs, "[] \t"); b != "" {
		t.Fatalf("a succeeded attempt carries output_errors %s", attErrs)
	}
	if nodeStatus != "succeeded" || nodeOutputs == nil {
		t.Fatalf("node after a valid reply = %s outputs=%v", nodeStatus, nodeOutputs)
	}
	if n := c10CheckpointCount(t, ctx, f, claim); n != 1 {
		t.Fatalf("checkpoints = %d, want 1 (ADR-0023 § 6: a succeeded node HAS its durable boundary)", n)
	}
}

// TestC10BoundarySkipsPlansThatDeclareNothing keeps the new check from becoming
// a new way to fail honest work: a run whose pinned snapshot carries no entry
// for the node (the hand-seeded fixture shape) completes exactly as before.
func TestC10BoundarySkipsPlansThatDeclareNothing(t *testing.T) {
	ctx := testCtx(t)
	f, store := awSetup(t)
	claim := c10Seed(t, ctx, f, store, "c10none")
	wsID := m4Workspace(t, ctx, f, claim.RunID)
	if _, err := f.pool.Exec(ctx,
		`UPDATE runs SET plan_snapshot = '{"nodes":[]}' WHERE id = $1::uuid`, claim.RunID); err != nil {
		t.Fatalf("downgrade the snapshot: %v", err)
	}
	var declared json.RawMessage
	if err := f.pool.QueryRow(ctx,
		`SELECT plan_snapshot FROM runs WHERE id = $1::uuid`, claim.RunID).Scan(&declared); err != nil {
		t.Fatalf("read it back: %v", err)
	}
	var snap struct {
		Nodes []json.RawMessage `json:"nodes"`
	}
	if err := json.Unmarshal(declared, &snap); err != nil || len(snap.Nodes) != 0 {
		t.Fatalf("snapshot rewrite did not land an empty node list: %s (%v)", declared, err)
	}
	if err := store.CompleteAttempt(ctx, claim, map[string]any{"anything": "goes"}, m4Digest("o"), nil,
		"passed", worker.AttemptCheckpoint{
			InputsDigest: m4Digest("in"), OutputsDigest: m4Digest("o"),
			WorkspaceID: wsID, VolumeID: "vol-a",
		}); err != nil {
		t.Fatalf("a plan that declares nothing for the node must not block the boundary: %v", err)
	}
	attStatus, _, _, _, _, _ := c10Rows(t, ctx, f, claim)
	if attStatus != "succeeded" {
		t.Fatalf("attempt closed %s on a plan with no declared outputs", attStatus)
	}
}
