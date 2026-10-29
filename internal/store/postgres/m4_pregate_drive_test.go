package postgres

// Driving a run that pins the § 7.0 seed document up to its own /approve gate.
//
// This used to be one step — "complete /plan and the gate opens". It is two
// since docs/compatibility/probes/m4/pipeline.yaml grew the seed's pre-gate
// artifact publisher (README "The seed pipeline", deviation 9):
//
//	/plan  ->  /publish_plan  ->  /approve (human.approval)
//
// /approve now carries `dependsOn: [plan, publish_plan]` BECAUSE § 7.1 C9f
// reads "the run's other branches keep running: the sample's /plan artifact is
// still readable … while an unrelated gate waits" — the gate cannot be the
// artifact's descendant or the row would not exist yet, and the dependency edge
// is what makes that ordering real instead of lucky. So a drive that stops at
// /plan leaves /publish_plan `ready`, /approve `pending` and runs.status
// 'running' forever: which is exactly how the 26723d3 ci run lost
// TestM4GateCancelRun*, TestM4RunLifecycleApprovalResumesRun,
// TestM4APIRetry*Gate* and TestM4RunLifecycleRetryRearmsDownstream.
//
// Every step here goes through the same fenced claim/start/complete trio a
// worker uses (no ledger row is UPDATEd into a terminal state), and each one
// asserts WHICH node its claim landed on: if the published graph ever stops
// readies /publish_plan behind /plan, the drive says so instead of completing
// whatever happened to be ready and reporting a green gate.

import (
	"context"
	"strings"
	"testing"

	"github.com/dbirks/communication/internal/pipelines/runtime"
)

// The seed's pre-gate node keys, spelled once. They are the published
// document's, not fixtures: /publish_plan is the node deviation 9 added, and
// /approve is the gate the whole drive exists to reach.
const (
	m4GatePlanKey    = "/plan"
	m4GatePublishKey = "/publish_plan"
	m4GateApproveKey = "/approve"
)

// m4GateStep is one pre-gate worker step: the node the drive must claim, the
// outputs envelope a real worker reports for it, and the artifact_refs that
// ride the same transaction. No `kind` field: document 1 runs /plan as
// `agent.acp` and its twin as `process.exec` (README deviation 4), so the kind
// belongs to the document a leg pinned, not to the drive.
type m4GateStep struct {
	Key     string
	Outputs map[string]any
	Refs    []any
}

// m4GatePublishOutputs is /publish_plan's outputs envelope in
// worker/artifactpublish.go's succeeded() shape — the artifact named, never
// carried. The seed declares NO outputs schema for an artifact.publish node
// (runtime.CheckNodeOutputs: "a node that declares nothing promises nothing"),
// so this is not a schema the graph can refuse; it is the shape that keeps the
// fake drive telling the truth about what completing that kind means.
//
// What is deliberately NOT faked here: the `artifacts` row itself. Writing that
// ledger (and the bytes behind it) is the worker artifact store's § 5.2 step 10
// transaction, which none of these gate tests wires; the graph only needs the
// step's terminal write. "The artifact is readable" is asserted where a real
// store is present — e2e/m4's C1f/C9f/C7b arms against the lab.
func m4GatePublishOutputs(t *testing.T, ctx context.Context, f *m4Fixture) map[string]any {
	t.Helper()
	var id string
	if err := f.pool.QueryRow(ctx, `SELECT gen_random_uuid()::text`).Scan(&id); err != nil {
		t.Fatalf("draw an artifact id for the pre-gate publish: %v", err)
	}
	sha := strings.Repeat("b", 64)
	return map[string]any{
		"artifact_id":     id,
		"kind":            "markdown",
		"name":            "plan-evidence.md",
		"media_type":      "text/markdown",
		"sha256":          sha,
		"digest":          "sha256:" + sha,
		"size_bytes":      512,
		"source_mode":     "output_json",
		"redaction_count": 0,
	}
}

// m4GatePublishRefs mirrors the artifact_refs the publish executor attaches to
// the same boundary (worker/artifactpublish.go's ckpt.ArtifactRefs).
func m4GatePublishRefs(outputs map[string]any) []any {
	return []any{map[string]any{
		"artifact_id":     outputs["artifact_id"],
		"kind":            outputs["kind"],
		"name":            outputs["name"],
		"media_type":      outputs["media_type"],
		"sha256":          outputs["sha256"],
		"size_bytes":      outputs["size_bytes"],
		"storage_backend": "filesystem",
		"storage_key":     "runs/m4-gate-drive/plan-evidence.md",
	}}
}

// m4GateSteps are the seed's pre-gate steps in claim order. The document's
// policies.maxConcurrentNodes is 1, so the advancer readies exactly one of them
// at a time and a claim can be aimed by position.
func m4GateSteps(t *testing.T, ctx context.Context, f *m4Fixture) []m4GateStep {
	t.Helper()
	publish := m4GatePublishOutputs(t, ctx, f)
	return []m4GateStep{
		{Key: m4GatePlanKey, Outputs: m4LifecyclePlanOutputs()},
		{Key: m4GatePublishKey, Outputs: publish, Refs: m4GatePublishRefs(publish)},
	}
}

// m4GateWorkspace seeds the run workspace the pre-gate boundaries name (the
// row the checkpoint's workspace_id/volume_id must resolve to). `tag` is the
// leg's own label, so a failure names the leg that seeded it.
func m4GateWorkspace(t *testing.T, ctx context.Context, f *m4Fixture, runID, workerID,
	tag string) string {
	t.Helper()
	var workspaceID string
	if err := f.pool.QueryRow(ctx, `
		INSERT INTO workspaces (organization_id, project_id, scope_kind, run_id, worker_id,
		                        volume_id, root_path, state, ready_at)
		VALUES ($1, $2, 'run', $3, $4, 'sha256:' || repeat('1', 64),
		        '/workspaces/runs/' || $5, 'ready', now())
		RETURNING id`, f.orgID, f.projectID, runID, workerID, tag).Scan(&workspaceID); err != nil {
		t.Fatalf("seed run workspace (%s): %v", tag, err)
	}
	return workspaceID
}

// m4CompleteGateStep settles ONE pre-gate step through the worker trio:
// claim, start, complete — fenced, with a checkpoint naming the run workspace —
// and fails loudly if the claim it drove belongs to a different node than the
// step names. Returns the attempt id it settled (the retry legs read it back).
func m4CompleteGateStep(t *testing.T, ctx context.Context, f *m4Fixture, rt *RuntimeStore,
	runID, workerID, workspaceID string, step m4GateStep) string {
	t.Helper()
	a, err := rt.Claim(ctx, runID, workerID)
	if err != nil || a == nil {
		t.Fatalf("claim %s attempt: a=%v err=%v (nothing claimable behind the gate means the "+
			"graph did not ready this step, not that the worker was busy)", step.Key, a, err)
	}
	var gotKey string
	if err := f.pool.QueryRow(ctx, `
		SELECT ne.node_instance_key FROM attempts a
		JOIN node_executions ne ON ne.id = a.node_execution_id WHERE a.id = $1::uuid`, a.ID).
		Scan(&gotKey); err != nil {
		t.Fatalf("read the claimed attempt's node (%s): %v", step.Key, err)
	}
	if gotKey != step.Key {
		t.Fatalf("claimed attempt %s belongs to %q, want %q — the pre-gate drive claims in the "+
			"published graph's order, so a different node here means that graph moved",
			a.ID, gotKey, step.Key)
	}
	if err := rt.Start(ctx, runID, a.ID, workerID, a.FencingToken); err != nil {
		t.Fatalf("start %s attempt: %v", step.Key, err)
	}
	ckpt := runtime.CheckpointRecord{
		InputsDigest:  "sha256:" + strings.Repeat("1", 64),
		OutputsDigest: "sha256:" + strings.Repeat("2", 64),
		VolumeID:      "sha256:" + strings.Repeat("1", 64),
		WorkspaceID:   workspaceID, WorkerID: workerID,
	}
	if err := rt.Complete(ctx, runID, a.ID, workerID, a.FencingToken,
		step.Outputs, "sha256:"+strings.Repeat("3", 64), step.Refs, "", ckpt); err != nil {
		t.Fatalf("complete %s attempt: %v", step.Key, err)
	}
	return a.ID
}

// m4DriveToApprovalGate drives a run that pins the seed document from `queued`
// to a LIVE /approve gate by completing BOTH pre-gate worker steps — /plan and
// the deviation-9 publisher /publish_plan — on one worker. Returns the worker id
// for legs that later fence or compare it.
//
// It does not decide the gate: what happens behind an open gate is each leg's
// own business (approve, expire, cancel_run, reject, retry).
func m4DriveToApprovalGate(t *testing.T, ctx context.Context, f *m4Fixture, rt *RuntimeStore,
	runID, tag string) string {
	t.Helper()
	workerID := m4Worker(t, ctx, f.pool, tag, 4)
	workspaceID := m4GateWorkspace(t, ctx, f, runID, workerID, tag)
	for _, step := range m4GateSteps(t, ctx, f) {
		m4CompleteGateStep(t, ctx, f, rt, runID, workerID, workspaceID, step)
	}
	// The drive's own postcondition, so no caller has to re-derive it: the gate
	// is only "open" if the graph says so, not because the steps were driven.
	statuses := m4LifeNodeStatuses(t, f, runID)
	if statuses[m4GatePublishKey] != runtime.NodeSucceeded {
		t.Fatalf("%s = %v after the pre-gate drive, want succeeded (nodes=%v)",
			m4GatePublishKey, statuses[m4GatePublishKey], statuses)
	}
	if statuses[m4GateApproveKey] != runtime.NodeWaiting {
		t.Fatalf("%s = %v after the pre-gate drive, want waiting — the drive completed %s and %s, "+
			"so a gate that did not open is a graph/product fact this package must not paper over",
			m4GateApproveKey, statuses[m4GateApproveKey], m4GatePlanKey, m4GatePublishKey)
	}
	return workerID
}
