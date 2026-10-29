package runtime_test

import (
	"encoding/json"
	"fmt"
	"testing"

	pevents "github.com/dbirks/communication/internal/pipelines/events"
	"github.com/dbirks/communication/internal/pipelines/runtime"
)

// TestUntilIterationsRecordedOnScopeJournalRow answers docs/m4-contract.md
// § 7.1 C7a's "the until scope reports how many iterations it spent" from the
// engine side. The scope's own terminal journal row is where that number
// lives: node.scope.failed.iterations_stopped (§ 3 row 19) for a loop that
// died at its bound, node.scope.completed.iterations (§ 3 row 18) plus the
// scope row's outputs.iterations for one that passed. node_executions itself
// carries NO iterations column — § 1's CREATE TABLE has no scope-state
// column by design (ADR-0023 § 6; internal/pipelines/runtime/scope_state.go)
// — so the live gate's old `SELECT iterations FROM node_executions` read could
// only ever report None. These tests pin the recording the fixed C7a verdict
// now reads: run an until scope to exhaustion and assert the count it leaves
// in its own journal row, and run one to a pass and assert the same count
// lands on the completed row and the scope's outputs.
func TestUntilIterationsRecordedOnScopeJournalRow(t *testing.T) {
	plan := loadPlan(t, "../testdata/feature-development-contract.yaml")
	dv := newDriver(t, plan, sampleInputs())
	dv.gate = func(*runtime.Approval) (string, string) { return "approved", "" }
	dv.script("/plan", step{outputs: map[string]any{"plan": "do it"}})
	// The case-7 shape: honest business fails on every iteration, so the only
	// way out is the sample's declared bound of 4.
	for i := 1; i <= 4; i++ {
		p := fmt.Sprintf("/build_until_verified[%d]", i)
		dv.script(p+"/implement", step{outputs: map[string]any{"summary": "attempt"}})
		dv.script(p+"/test", step{outputs: map[string]any{
			"exit_code": int64(1), "result": map[string]any{"successful": false}}})
		dv.script(p+"/review", step{
			outputs: map[string]any{"approved": false, "evidence": fmt.Sprintf("still red #%d", i)},
			outcome: "failed"})
	}
	dv.pump(200)
	st := dv.state()
	if st.Run.Status != runtime.RunFailed || st.Run.FailedCause != "until_exhausted" {
		t.Fatalf("run = %s/%s, want failed/until_exhausted", st.Run.Status, st.Run.FailedCause)
	}

	// The typed recording: the scope's own node.scope.failed names the spent
	// iteration count (failScopeLevel's Iterations: iterationOf(st)).
	sf := lastRecord(t, st, pevents.TypeNodeScopeFailed)
	pl, ok := sf.Payload.(pevents.NodeScopeFailed)
	if !ok {
		t.Fatalf("node.scope.failed payload = %T, want the typed pevents.NodeScopeFailed", sf.Payload)
	}
	if pl.FailedCause != "until_exhausted" {
		t.Errorf("scope failed_cause = %q, want until_exhausted", pl.FailedCause)
	}
	if pl.NodeInstanceKey != "/build_until_verified" {
		t.Errorf("scope row node_instance_key = %q, want /build_until_verified (the count must ride the until scope's OWN row, not a body row)", pl.NodeInstanceKey)
	}
	if pl.Iterations != 4 {
		t.Errorf("node.scope.failed.iterations_stopped = %d, want 4 (the loop spent every iteration its bound allowed)", pl.Iterations)
	}
	if len(pl.Evidence) != 4 {
		t.Errorf("node.scope.failed evidence = %d entries, want 4", len(pl.Evidence))
	}

	// The wire spelling the C7a verdict reads out of domain_events.payload.
	raw, err := json.Marshal(sf.Payload)
	if err != nil {
		t.Fatalf("encode scope-failed payload: %v", err)
	}
	var pmap map[string]any
	if err := json.Unmarshal(raw, &pmap); err != nil {
		t.Fatalf("decode scope-failed payload: %v", err)
	}
	if got, ok := pmap["iterations_stopped"]; !ok {
		t.Errorf("payload JSON carries no iterations_stopped field (§ 3 row 19's wire name): %s", raw)
	} else if toInt(got) != 4 {
		t.Errorf("iterations_stopped wire = %v, want 4", got)
	}

	// And the ledger half of the same truth: the until root row fails with the
	// cause and carries NO outputs — the count is not a column or an outputs
	// field on a failed scope row, which is exactly the read the old driver
	// arm performed and why it GAPped.
	root := st.Node("/build_until_verified")
	if root == nil {
		t.Fatal("no root row for /build_until_verified")
	}
	if root.Status != runtime.NodeFailed || root.FailedCause != "until_exhausted" {
		t.Errorf("root row = %s/%s, want failed/until_exhausted", root.Status, root.FailedCause)
	}
	if root.Outputs != nil {
		t.Errorf("failed scope row carries outputs %v, want none (a failed until produces no result; the count lives in its journal row)", root.Outputs)
	}
}

// TestUntilPassRecordsIterationsOnRowAndJournal is the pass-path twin: when the
// loop exits by predicate the advancer's completeScope writes the spent count
// BOTH into the scope's own node.scope.completed journal row (iterations,
// § 3 row 18) and onto the row's outputs.iterations — the output channel the
// contract sample's run bindings read (${{ nodes.build_until_verified.outputs.
// iterations }}, contract § 9.3). The C7a reader accepts either terminal row;
// this test pins the completed spelling.
func TestUntilPassRecordsIterationsOnRowAndJournal(t *testing.T) {
	plan := loadPlan(t, "testdata/loop_prev.yaml")
	dv := newDriver(t, plan, map[string]any{"goal": "loop"})
	dv.script("/build[1]/review", step{outputs: map[string]any{"approved": false}})
	dv.script("/build[2]/review", step{outputs: map[string]any{"approved": true}})
	dv.script("/build[3]/review", step{outputs: map[string]any{"approved": false}})
	dv.pump(50)
	st := dv.state()
	if st.Run.Status != runtime.RunCompleted {
		t.Fatalf("run = %s/%s", st.Run.Status, st.Run.FailedCause)
	}
	sc := lastPayload(t, st, pevents.TypeNodeScopeCompleted)
	if sc["node_instance_key"] != "/build" {
		t.Errorf("completed row node_instance_key = %v, want /build", sc["node_instance_key"])
	}
	if toInt(sc["iterations"]) != 3 {
		t.Errorf("node.scope.completed.iterations = %v, want 3 (the scope reports the iterations it spent)", sc["iterations"])
	}
	root := st.Node("/build")
	if root == nil {
		t.Fatal("no root row for /build")
	}
	outs, ok := root.Outputs.(map[string]any)
	if !ok {
		t.Fatalf("scope row outputs = %T %v, want the result map", root.Outputs, root.Outputs)
	}
	if toInt(outs["iterations"]) != 3 {
		t.Errorf("scope row outputs.iterations = %v, want 3", outs["iterations"])
	}
}
