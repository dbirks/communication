package runtime_test

import (
	"testing"

	pevents "github.com/dbirks/communication/internal/pipelines/events"
	"github.com/dbirks/communication/internal/pipelines/runtime"
)

// worklistN is worklist's shape at an arbitrary length: the over-cap fan-out
// the advancer must refuse.
func worklistN(n int) map[string]any {
	list := make([]any, 0, n)
	for i := 1; i <= n; i++ {
		list = append(list, map[string]any{"number": int64(i)})
	}
	return map[string]any{"worklist": list}
}

// TestFanoutItemsOverCapNamesTheRunCause is contract § 6's for_each row and
// § 7.1 C12b's second arm: 1001 EVALUATED items fail the RUN at scope start
// with failed_cause='fanout_items_exceeded' — the name § 6 fixes, not the
// generic node_execution_failed:<key> a node execution error carries — and the
// scope row carries the same name as its scope cause.
func TestFanoutItemsOverCapNamesTheRunCause(t *testing.T) {
	plan := loadPlan(t, "testdata/fanout_collect.yaml")
	dv := newDriver(t, plan, map[string]any{"goal": "issues"})
	dv.script("/seed", step{outputs: worklistN(1001)})
	dv.pump(50)
	st := dv.state()
	if st.Run.Status != runtime.RunFailed {
		t.Fatalf("run = %s/%s, want failed/fanout_items_exceeded", st.Run.Status, st.Run.FailedCause)
	}
	if st.Run.FailedCause != "fanout_items_exceeded" {
		t.Errorf("runs.failed_cause = %q, want fanout_items_exceeded (contract § 6 names the cap)",
			st.Run.FailedCause)
	}
	fo := st.Node("/fan_out")
	if fo == nil || fo.Status != runtime.NodeFailed {
		t.Fatalf("for_each row = %+v, want failed", fo)
	}
	if fo.FailedCause != "fanout_items_exceeded" {
		t.Errorf("scope row failed_cause = %q, want fanout_items_exceeded", fo.FailedCause)
	}
	sf := lastRecord(t, st, pevents.TypeNodeScopeFailed)
	if p := sf.Payload.(pevents.NodeScopeFailed); p.FailedCause != "fanout_items_exceeded" {
		t.Errorf("node.scope.failed failed_cause = %q, want fanout_items_exceeded", p.FailedCause)
	}
	rf := lastRecord(t, st, pevents.TypeRunFailed)
	if p := rf.Payload.(pevents.RunFailed); p.FailedCause != "fanout_items_exceeded" {
		t.Errorf("run.failed failed_cause = %q, want fanout_items_exceeded", p.FailedCause)
	}
}
