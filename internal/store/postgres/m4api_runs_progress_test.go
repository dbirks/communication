package postgres

// TestM4RunsListProgress*: ADR-0070's step progress on the project run list
// (route 21). Integration layer over a database that actually ran 00005: the
// projection is checked against real node_executions rows moved through real
// status UPDATEs, the 12-step cap against a 15-node plan, and the "one
// set-based query, never N+1" bound with a pgx QueryTracer counting every
// node_executions statement a single list call pays.

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dbirks/communication/internal/api"
)

// m4ProgressPlan is a pinned plan snapshot: the named top-level nodes in
// definition order (the compiler appends as it walks the document), plus one
// loop-body node under /loop/ that must never surface.
func m4ProgressPlan(topLevel ...string) json.RawMessage {
	nodes := make([]map[string]string, 0, len(topLevel)+1)
	for _, id := range topLevel {
		nodes = append(nodes, map[string]string{"id": id, "kind": "agent", "scope": "/"})
	}
	nodes = append(nodes, map[string]string{"id": "inner", "kind": "agent", "scope": "/loop/"})
	raw, err := json.Marshal(struct {
		Nodes []map[string]string `json:"nodes"`
	}{Nodes: nodes})
	if err != nil {
		panic(err)
	}
	return raw
}

// m4ProgressSeedRun creates a run pinned to a plan with the given top-level
// nodes and materializes one top-level node execution per status entry
// (a node absent from the map has NO row — a planned step not started).
func m4ProgressSeedRun(t *testing.T, ctx context.Context, f *m4Fixture,
	topLevel []string, statuses map[string]string) string {
	t.Helper()
	run, _, err := f.runs.CreateRun(ctx, NewRun{
		OrganizationID: f.orgID, ProjectID: f.projectID, PipelineID: f.pipelineID,
		PipelineRevisionID: f.revisionID, RevisionDigest: f.digest,
		PlanDigest:       f.planDigest,
		PlanSnapshot:     m4ProgressPlan(topLevel...),
		PoliciesSnapshot: json.RawMessage(`{}`),
		RepoSnapshot:     json.RawMessage(`[]`),
		TriggeredBy:      f.userID,
	})
	if err != nil {
		t.Fatalf("CreateRun: %v", err)
	}
	for _, nodeID := range topLevel {
		status, seeded := statuses[nodeID]
		if !seeded {
			continue
		}
		if _, err := f.runs.InsertNodeExecution(ctx, NewNodeExecution{
			RunID: run.ID, NodeID: nodeID, Kind: "agent",
			NodeInstanceKey: "/" + nodeID, ScopeKey: "/",
			ExecutionLocation: "worker",
		}); err != nil {
			t.Fatalf("InsertNodeExecution %s: %v", nodeID, err)
		}
		xpSetNodeStatus(t, f.pool, run.ID, nodeID, status)
	}
	return run.ID
}

// m4ProgressSetRunTerminal marks the run terminal with the timestamps and
// causes the runs CHECKs demand (completed carries no cause; failed must).
func m4ProgressSetRunTerminal(t *testing.T, ctx context.Context, f *m4Fixture, runID, status, cause string) {
	t.Helper()
	if _, err := f.pool.Exec(ctx, `
		UPDATE runs SET status = $2, finished_at = now(), failed_cause = NULLIF($3, '')
		WHERE id = $1::uuid`, runID, status, cause); err != nil {
		t.Fatalf("finish run %s: %v", runID, err)
	}
}

// m4ProgressFind pulls one run's row out of a list result.
func m4ProgressFind(t *testing.T, runs []api.RunSummaryView, runID string) api.RunSummaryView {
	t.Helper()
	for _, r := range runs {
		if r.ID == runID {
			return r
		}
	}
	t.Fatalf("run %s absent from the project list (%d rows)", runID, len(runs))
	return api.RunSummaryView{}
}

func m4ProgressAssertSteps(t *testing.T, v api.RunSummaryView, want []struct{ id, state string }, wantMore int) {
	t.Helper()
	if v.Progress == nil {
		t.Fatalf("run %s: progress is nil — the list row must carry it", v.ID)
	}
	if len(v.Progress.Steps) != len(want) {
		t.Fatalf("steps = %+v, want %d top-level steps (loop body never surfaces)",
			v.Progress.Steps, len(want))
	}
	for i, w := range want {
		got := v.Progress.Steps[i]
		if got.NodeID != w.id || got.State != w.state {
			t.Fatalf("step %d = %s/%s, want %s/%s (definition order, coarse state)",
				i, got.NodeID, got.State, w.id, w.state)
		}
	}
	if v.Progress.More != wantMore {
		t.Fatalf("more = %d, want %d", v.Progress.More, wantMore)
	}
}

// TestM4RunsListProgressMidwayRun: a run whose second step is executing shows
// done / running / open, in definition order, with the unplanned-looking
// loop-body node absent.
func TestM4RunsListProgressMidwayRun(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)
	member := m4RunsReadMember(t, ctx, f, "viewer")
	store := APIRunStore{Runs: f.runs}
	runID := m4ProgressSeedRun(t, ctx, f, []string{"plan", "implement", "review"},
		map[string]string{"plan": "succeeded", "implement": "running"})

	runs, err := store.ListProjectRunsFiltered(ctx, member, f.projectID, api.RunListFilter{})
	if err != nil {
		t.Fatalf("ListProjectRunsFiltered: %v", err)
	}
	v := m4ProgressFind(t, runs, runID)
	m4ProgressAssertSteps(t, v, []struct{ id, state string }{
		{"plan", api.RunStepDone},
		{"implement", api.RunStepRunning},
		{"review", api.RunStepOpen}, // no execution row yet = open
	}, 0)
}

// TestM4RunsListProgressFinishedRun: every top-level node succeeded means
// every segment is done — and a skipped node is settled too, so it reads
// done as well (nothing asks for attention on it).
func TestM4RunsListProgressFinishedRun(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)
	member := m4RunsReadMember(t, ctx, f, "viewer")
	store := APIRunStore{Runs: f.runs}
	runID := m4ProgressSeedRun(t, ctx, f, []string{"plan", "implement", "review"},
		map[string]string{"plan": "succeeded", "implement": "succeeded", "review": "skipped"})
	m4ProgressSetRunTerminal(t, ctx, f, runID, "completed", "")

	runs, err := store.ListProjectRunsFiltered(ctx, member, f.projectID, api.RunListFilter{})
	if err != nil {
		t.Fatalf("ListProjectRunsFiltered: %v", err)
	}
	v := m4ProgressFind(t, runs, runID)
	m4ProgressAssertSteps(t, v, []struct{ id, state string }{
		{"plan", api.RunStepDone},
		{"implement", api.RunStepDone},
		{"review", api.RunStepDone},
	}, 0)
}

// TestM4RunsListProgressFailedRun: the failing step is marked, the steps
// after it stay open — a failed run is a strip with the wound visible, not
// an all-failed wall.
func TestM4RunsListProgressFailedRun(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)
	member := m4RunsReadMember(t, ctx, f, "viewer")
	store := APIRunStore{Runs: f.runs}
	runID := m4ProgressSeedRun(t, ctx, f, []string{"plan", "implement", "review"},
		map[string]string{"plan": "succeeded", "implement": "failed"})
	m4ProgressSetRunTerminal(t, ctx, f, runID, "failed", "node_execution_failed:/implement")

	runs, err := store.ListProjectRunsFiltered(ctx, member, f.projectID, api.RunListFilter{})
	if err != nil {
		t.Fatalf("ListProjectRunsFiltered: %v", err)
	}
	v := m4ProgressFind(t, runs, runID)
	m4ProgressAssertSteps(t, v, []struct{ id, state string }{
		{"plan", api.RunStepDone},
		{"implement", api.RunStepFailed},
		{"review", api.RunStepOpen},
	}, 0)
}

// TestM4RunsListProgressCap: the strip is bounded — the first 12 top-level
// steps ride `steps` in definition order, everything beyond them is only a
// `more` count.
func TestM4RunsListProgressCap(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)
	member := m4RunsReadMember(t, ctx, f, "viewer")
	store := APIRunStore{Runs: f.runs}
	var nodes []string
	statuses := map[string]string{}
	for i := 1; i <= 15; i++ {
		id := "s" + string(rune('a'+i-1))
		nodes = append(nodes, id)
	}
	statuses[nodes[0]] = "succeeded"
	runID := m4ProgressSeedRun(t, ctx, f, nodes, statuses)

	runs, err := store.ListProjectRunsFiltered(ctx, member, f.projectID, api.RunListFilter{})
	if err != nil {
		t.Fatalf("ListProjectRunsFiltered: %v", err)
	}
	v := m4ProgressFind(t, runs, runID)
	if v.Progress == nil || len(v.Progress.Steps) != runProgressStepCap {
		t.Fatalf("steps = %+v, want the %d-step cap", v.Progress, runProgressStepCap)
	}
	if v.Progress.Steps[0].NodeID != nodes[0] || v.Progress.Steps[runProgressStepCap-1].NodeID != nodes[runProgressStepCap-1] {
		t.Fatalf("capped steps = %s..%s, want %s..%s (definition order kept)",
			v.Progress.Steps[0].NodeID, v.Progress.Steps[runProgressStepCap-1].NodeID,
			nodes[0], nodes[runProgressStepCap-1])
	}
	if v.Progress.Steps[0].State != api.RunStepDone {
		t.Fatalf("first step = %s, want done", v.Progress.Steps[0].State)
	}
	for _, s := range v.Progress.Steps[1:] {
		if s.State != api.RunStepOpen {
			t.Fatalf("step %s = %s, want open (no execution row)", s.NodeID, s.State)
		}
	}
	if v.Progress.More != 3 {
		t.Fatalf("more = %d, want 3 (15 planned top-level steps - 12 shown)", v.Progress.More)
	}
}

// m4ProgressTracer counts every statement that reads node_executions, so a
// test can prove the progress read is ONE set-based query per list call
// regardless of how many runs the page holds (ADR-0063).
type m4ProgressTracer struct {
	mu             sync.Mutex
	nodeExecSQL    []string
	nodeExecArrays int // statements of those that are ANY(...)-keyed
}

var _ pgx.QueryTracer = (*m4ProgressTracer)(nil)

func (c *m4ProgressTracer) TraceQueryStart(ctx context.Context, _ *pgx.Conn,
	data pgx.TraceQueryStartData) context.Context {
	if !strings.Contains(data.SQL, "node_executions") {
		return ctx
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.nodeExecSQL = append(c.nodeExecSQL, data.SQL)
	if strings.Contains(data.SQL, "= ANY(") {
		c.nodeExecArrays++
	}
	return ctx
}

func (c *m4ProgressTracer) TraceQueryEnd(ctx context.Context, _ *pgx.Conn,
	data pgx.TraceQueryEndData) {
}

func (c *m4ProgressTracer) counts() (int, int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.nodeExecSQL), c.nodeExecArrays
}

// TestM4RunsListProgressOneQuery: three runs, each with real top-level
// executions, answered by ONE list call that touches node_executions EXACTLY
// once, on a set-based `run_id = ANY(...)` statement — never a per-row read.
func TestM4RunsListProgressOneQuery(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)
	member := m4RunsReadMember(t, ctx, f, "viewer")
	for i := 0; i < 3; i++ {
		m4ProgressSeedRun(t, ctx, f, []string{"plan", "implement"},
			map[string]string{"plan": "succeeded", "implement": "running"})
	}

	cfg := f.pool.Config().Copy()
	tracer := &m4ProgressTracer{}
	cfg.ConnConfig.Tracer = tracer
	counted, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatalf("counted pool: %v", err)
	}
	t.Cleanup(counted.Close)

	store := APIRunStore{Runs: &RunStore{Pool: counted}}
	runs, err := store.ListProjectRunsFiltered(ctx, member, f.projectID, api.RunListFilter{})
	if err != nil {
		t.Fatalf("ListProjectRunsFiltered: %v", err)
	}
	if len(runs) != 3 {
		t.Fatalf("runs = %d, want the 3 seeded rows", len(runs))
	}
	for _, r := range runs {
		if r.Progress == nil || len(r.Progress.Steps) != 2 {
			t.Fatalf("run %s progress = %+v, want 2 projected steps", r.ID, r.Progress)
		}
	}
	n, arrays := tracer.counts()
	if n != 1 {
		t.Fatalf("node_executions statements per list call = %d, want exactly 1 (set-based, never N+1): %v", n, tracer.nodeExecSQL)
	}
	if arrays != 1 {
		t.Fatalf("the one statement is not set-based: %v", tracer.nodeExecSQL)
	}
}

// TestM4RunsListProgressEmptyPlan: a run whose pinned plan has no top-level
// nodes answers an empty strip (steps [] not null, more 0) — the list row
// still rides, and the projection never invents a segment.
func TestM4RunsListProgressEmptyPlan(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)
	member := m4RunsReadMember(t, ctx, f, "viewer")
	store := APIRunStore{Runs: f.runs}
	runID := m4RunsReadSeedRun(t, ctx, f) // the fixture's {"nodes":[]} plan

	runs, err := store.ListProjectRunsFiltered(ctx, member, f.projectID, api.RunListFilter{})
	if err != nil {
		t.Fatalf("ListProjectRunsFiltered: %v", err)
	}
	v := m4ProgressFind(t, runs, runID)
	if v.Progress == nil {
		t.Fatalf("run %s: progress is nil — the list row must always carry it", v.ID)
	}
	if v.Progress.Steps == nil || len(v.Progress.Steps) != 0 || v.Progress.More != 0 {
		t.Fatalf("progress = %+v, want steps=[] more=0", v.Progress)
	}
}
