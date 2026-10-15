package runtime_test

import (
	"encoding/json"
	"strings"
	"testing"

	pevents "github.com/dbirks/communication/internal/pipelines/events"
	"github.com/dbirks/communication/internal/pipelines/runtime"
)

func sampleInputs() map[string]any {
	return map[string]any{
		"goal":                "Document and fix add() in hello.py",
		"repository":          "app",
		"acceptance_criteria": "Tests pass, the plan is followed, and the reviewer approves.",
	}
}

// scenarioSampleRunsToEndToEnd is the milestone's own sentence: Plan →
// Approve → Implement → Test → Review → Loop, review failing once (a business
// fail, not an execution fail) and passing on iteration 2, then the condition
// routing to the verified artifact node. Test matrix: contract § 8's scenario
// row; exit-plan twin: § 7 C1.
func TestSampleReviewFailsOnceThenLoopPasses(t *testing.T) {
	plan := loadPlan(t, "../testdata/feature-development-contract.yaml")
	dv := newDriver(t, plan, sampleInputs())
	dv.gate = func(ap *runtime.Approval) (string, string) {
		if !strings.Contains(ap.Summary, "Document and fix add()") {
			t.Errorf("gate summary lost the interpolated plan: %q", ap.Summary)
		}
		return "approved", ""
	}
	dv.script("/plan", step{outputs: map[string]any{"plan": "1. add a docstring 2. fix the assertion"}})
	dv.script("/build_until_verified[1]/implement", step{outputs: map[string]any{"summary": "docstring added"}})
	dv.script("/build_until_verified[1]/test", step{outputs: map[string]any{
		"exit_code": int64(0), "result": map[string]any{"successful": true}}})
	// Iteration 1 review: an honest business fail (succeeded, approved=false).
	dv.script("/build_until_verified[1]/review", step{
		outputs: map[string]any{"approved": false, "evidence": "the assertion still expects 99", "findings": []any{"test still red"}},
		outcome: "failed"})
	dv.script("/build_until_verified[2]/implement", step{outputs: map[string]any{"summary": "assertion corrected"}})
	dv.script("/build_until_verified[2]/test", step{outputs: map[string]any{
		"exit_code": int64(0), "result": map[string]any{"successful": true}}})
	dv.script("/build_until_verified[2]/review", step{
		outputs: map[string]any{"approved": true, "evidence": "acceptance criteria met"}})

	dv.pump(100)

	st := dv.state()
	if st.Run.Status != runtime.RunCompleted {
		t.Fatalf("run = %s (%s), want completed; events=%v", st.Run.Status, st.Run.FailedCause, eventTypes(st))
	}
	// RunKeys sorts; this is the same set contract C1d enumerates.
	want := []string{
		"/approve", "/build_until_verified",
		"/build_until_verified[1]/implement", "/build_until_verified[1]/review", "/build_until_verified[1]/test",
		"/build_until_verified[2]/implement", "/build_until_verified[2]/review", "/build_until_verified[2]/test",
		"/plan", "/publish_needs_attention", "/publish_verified", "/verdict",
	}
	got := st.RunKeys()
	if strings.Join(got, " ") != strings.Join(want, " ") {
		t.Errorf("node_instance_key set =\n %v\nwant\n %v", got, want)
	}
	if v := st.Node("/publish_verified").Status; v != runtime.NodeSucceeded {
		t.Errorf("/publish_verified = %s, want succeeded", v)
	}
	if v := st.Node("/publish_needs_attention"); v.Status != runtime.NodeSkipped || v.SkipReason != "condition_default" {
		t.Errorf("/publish_needs_attention = %s/%s, want skipped/condition_default", v.Status, v.SkipReason)
	}
	if v := st.Node("/verdict").Outputs; asRoute(v) != "verified" {
		t.Errorf("verdict route = %v, want verified", v)
	}
	if c := countType(st, pevents.TypeNodeScopeIteration); c != 2 {
		t.Errorf("node.scope.iteration = %d, want 2 (the per-iteration evidence of ADR-0023 § 8)", c)
	}
	if c := countType(st, pevents.TypeRunCheckpointSaved); c != 8 {
		// one checkpoint per succeeded WORKER node execution: /plan + 3 + 3 +
		// /publish_verified = 8; the three control-plane successes (/approve,
		// /build_until_verified, /verdict) carry none (ADR-0023 § 6).
		t.Errorf("run.checkpoint_saved = %d, want 8", c)
	}
	completed := lastPayload(t, st, pevents.TypeRunCompleted)
	rb := completed["result_bindings"].(map[string]any)
	if rb["review_approved"] != true || toInt(rb["iterations"]) != 2 || rb["implementation_summary"] != "assertion corrected" {
		t.Errorf("run.completed result_bindings = %v", rb)
	}
	// carryForward (C7d): the iteration-2 implement prompt must have seen the
	// iteration-1 review feedback through `previous`, and iteration 1 saw an
	// empty object — asserted on the gate summary path is impossible here, so
	// the property is tested directly in TestPreviousRootIsPriorResultBindings.
}

func asRoute(v any) string {
	m, _ := v.(map[string]any)
	s, _ := m["route"].(string)
	return s
}

func toInt(v any) int64 {
	switch n := v.(type) {
	case int64:
		return n
	case float64:
		return int64(n)
	case int:
		return int64(n)
	}
	return -1
}

func lastPayload(t *testing.T, st *runtime.State, typ string) map[string]any {
	t.Helper()
	raw, _ := json.Marshal(lastRecord(t, st, typ).Payload)
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func lastRecord(t *testing.T, st *runtime.State, typ string) pevents.Record {
	t.Helper()
	for i := len(st.Events) - 1; i >= 0; i-- {
		if st.Events[i].Type == typ {
			return st.Events[i]
		}
	}
	t.Fatalf("no %s event; got %v", typ, eventTypes(st))
	return pevents.Record{}
}
