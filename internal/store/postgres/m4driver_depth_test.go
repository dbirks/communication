package postgres

// TestM4DriverChildDepthExceededStopsRetrying is issue #96 against a real
// Postgres driven by the real M4Driver: a depth-2 run whose pipeline.invoke
// asks for the ceiling-crossing third-level child must (a) fail that node
// with error_class/failed_cause child_depth_exceeded, (b) fail the run with
// the same named cause (contract § 6 / docs/m4-contract.md § 3 row 10), and
// (c) never again surface an error from a driver tick — the live defect was
// the plain store error aborting every pass, so the tick retried the same
// refusal every 5 s for 28 minutes (2536 ERROR lines, run 01a19a5d).

import (
	"fmt"
	"testing"

	"github.com/dbirks/communication/internal/api"
)

// m4DepthChainDoc is one link of the C8f three-level chain: a pipeline whose
// only node invokes the next link BY NAME. Its own static depth is 1, so the
// compiler admits every link (§ 6's static refusal is compiler/policy_test's
// case); only the RUNTIME depth — a run of the last link executing at
// runs.depth = 2 — reaches the ceiling.
func m4DepthChainDoc(slug, target string) string {
	return fmt.Sprintf(`apiVersion: communication.dev/v1alpha1
kind: Pipeline
metadata:
  name: %s
spec:
  inputs:
    type: object
  policies:
    maxConcurrentNodes: 1
    maxDurationSeconds: 3600
    maxNodeExecutions: 50
    maxChildDepth: 2
    cancelPolicy: cascade
  nodes:
  - id: invoke
    kind: pipeline.invoke
    timeoutSeconds: 600
    config:
      pipeline: %s
      waitFor: completion
`, slug, target)
}

func TestM4DriverChildDepthExceededStopsRetrying(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)
	token := migFixtureToken(t)
	m4Runtime := m4InvokeDriver(f)

	// l1 → l2 → l3 → leaf: publishing l3's run at depth 2 is the arm that
	// asks for a depth-3 child. The leaf is published so every name the
	// chain carries resolves; the depth refusal must fire before the leaf
	// is ever booked.
	leafSlug := fmt.Sprintf("depth-leaf-%s", token)
	l3Slug := fmt.Sprintf("depth-l3-%s", token)
	l2Slug := fmt.Sprintf("depth-l2-%s", token)
	l1Slug := fmt.Sprintf("depth-l1-%s", token)
	m4InvokePublish(t, f, leafSlug, m4InvokeChildDoc(leafSlug))
	m4InvokePublish(t, f, l3Slug, m4DepthChainDoc(l3Slug, leafSlug))
	m4InvokePublish(t, f, l2Slug, m4DepthChainDoc(l2Slug, l3Slug))
	l1Pipe, l1Rev := m4InvokePublish(t, f, l1Slug, m4DepthChainDoc(l1Slug, l2Slug))

	caller := api.Caller{UserID: f.userID, OrganizationID: f.orgID, IsOrgAdmin: true}
	as, err := APIAssignmentStore{S: f.pipelines}.CreateAssignment(ctx, caller, f.projectID,
		api.AssignmentCreateInput{PipelineID: l1Pipe, PinnedRevisionID: l1Rev, MaxConcurrentRuns: 1})
	if err != nil {
		t.Fatalf("CreateAssignment: %v", err)
	}
	view, created, err := APIRunStore{Runs: f.runs, Runtime: m4Runtime}.CreateRun(ctx, caller,
		api.RunCreateInput{
			ProjectID: f.projectID, AssignmentID: as.ID,
			Key: "m4-depth-run-" + token, RequestSHA: m4Hex("body/m4-depth-run/" + token),
			TriggeredBy: f.userID,
		})
	if err != nil || !created || view.ID == "" {
		t.Fatalf("CreateRun: view=%+v created=%v err=%v", view, created, err)
	}

	drv := NewM4Driver(f.pool, m4Runtime, nil)

	// Tick until the depth-2 run exists and settles. Every tick BEFORE that
	// point — including the tick on which the refusal happens — must answer
	// nil: pre-fix, the refusing tick itself returned an error, and every
	// later tick repeated it (the issue's 2536-line loop).
	settled := false
	for pass := 1; pass <= 12 && !settled; pass++ {
		if _, err := drv.Tick(ctx); err != nil {
			t.Fatalf("driver tick %d: %v — a depth refusal must fail the node, not the tick (issue #96)", pass, err)
		}
		var n int
		if err := f.pool.QueryRow(ctx, `
			SELECT count(*) FROM runs WHERE project_id = $1::uuid AND depth = 2
			  AND status = 'failed'`, f.projectID).Scan(&n); err != nil {
			t.Fatalf("count settled depth-2 runs: %v", err)
		}
		settled = n > 0
	}
	if !settled {
		t.Fatal("no depth-2 run failed within 12 driver ticks — the chain never reached the ceiling or the failure did not settle the run")
	}

	var deepID, deepCause string
	if err := f.pool.QueryRow(ctx, `
		SELECT id::text, failed_cause FROM runs WHERE project_id = $1::uuid AND depth = 2
		  AND status = 'failed'`, f.projectID).Scan(&deepID, &deepCause); err != nil {
		t.Fatalf("read the failed depth-2 run: %v", err)
	}
	if deepCause != "child_depth_exceeded" {
		t.Errorf("runs.failed_cause = %q, want child_depth_exceeded (contract § 3 row 10 names the budget)", deepCause)
	}

	var neStatus, neClass, neCause string
	if err := f.pool.QueryRow(ctx, `
		SELECT status, error_class, failed_cause FROM node_executions
		WHERE run_id = $1::uuid AND kind = 'pipeline.invoke'`, deepID).
		Scan(&neStatus, &neClass, &neCause); err != nil {
		t.Fatalf("read the depth-2 run's invoke row: %v", err)
	}
	if neStatus != "failed" || neClass != "child_depth_exceeded" || neCause != "child_depth_exceeded" {
		t.Errorf("invoke row = %s/%s/%s, want failed/child_depth_exceeded/child_depth_exceeded",
			neStatus, neClass, neCause)
	}

	// The refusal booked nothing and started nothing: no invocation row on
	// the failing run, and no run below it (runs_depth_check would have
	// refused the INSERT anyway — the Go-side naming is what this proves).
	var invs int
	if err := f.pool.QueryRow(ctx,
		`SELECT count(*) FROM pipeline_invocations WHERE run_id = $1::uuid`, deepID).Scan(&invs); err != nil {
		t.Fatalf("count invocations: %v", err)
	}
	if invs != 0 {
		t.Errorf("pipeline_invocations on the refused run = %d, want 0", invs)
	}
	if got := m4RunsWriteCount(t, f, deepID, "run.failed"); got != 1 {
		t.Errorf("run.failed rows = %d, want 1", got)
	}

	// The § 96 assertion in its literal form: a SUBSEQUENT driver tick for
	// that run returns no error, and the next tick after it changes nothing.
	for i := 0; i < 3; i++ {
		if _, err := drv.Tick(ctx); err != nil {
			t.Errorf("post-settlement driver tick %d: %v — the driver must have stopped retrying the named failure", i+1, err)
		}
	}
	var stillStatus string
	if err := f.pool.QueryRow(ctx,
		`SELECT status FROM runs WHERE id = $1::uuid`, deepID).Scan(&stillStatus); err != nil {
		t.Fatalf("re-read the failed run: %v", err)
	}
	if stillStatus != "failed" {
		t.Errorf("depth-2 run re-read as %s, want failed unchanged", stillStatus)
	}
}
