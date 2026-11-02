package runtime_test

import (
	"context"
	"fmt"
	"testing"

	pevents "github.com/dbirks/communication/internal/pipelines/events"
	"github.com/dbirks/communication/internal/pipelines/runtime"
)

// depthRefusingChildren is scriptedChildren behind a host that refuses every
// booking with the wrapped budget error a real host writes — this is exactly
// M4Children.CreateChild's shape for req.Depth > 2 (contract § 6, issue #96).
type depthRefusingChildren struct{ *scriptedChildren }

func (c *depthRefusingChildren) CreateChild(_ context.Context, req runtime.ChildRequest) (runtime.ChildOutcome, error) {
	c.created = append(c.created, req.NodeInstanceKey)
	return runtime.ChildOutcome{}, fmt.Errorf("postgres: child_depth_exceeded at depth %d: %w",
		req.Depth, runtime.ErrChildDepthExceeded)
}

// TestInvokeChildDepthExceededIsTerminal is issue #96's contract at the
// runtime seam: a refused depth-beyond-ceiling booking is a NAMED TERMINAL
// failure, not a pass error. The invoking node fails with error_class and
// failed_cause child_depth_exceeded (the name contract § 6 fixes, read off
// the row the way C12b reads fanout_items_exceeded), the run fails with the
// SAME name in runs.failed_cause (never the generic node_execution_failed:
// <key>), and every later advance — the driver's retry tick — answers nil
// with the state unmoved. Before the fix the refusal aborted the pass, the
// driver logged an ERROR and retried the same refusal every tick forever.
func TestInvokeChildDepthExceededIsTerminal(t *testing.T) {
	plan := loadPlan(t, "testdata/fanout_single.yaml")
	cr := &depthRefusingChildren{scriptedChildren: &scriptedChildren{status: map[int]string{}}}
	dv := newDriverWith(t, plan, map[string]any{"goal": "deep"}, runtime.AdvancerDeps{Children: cr})
	dv.script("/seed", step{outputs: worklist(2)})
	// pump's advance calls t.Fatalf on ANY pass error: reaching the assertions
	// below at all already proves the refusing tick did not error.
	dv.pump(50)
	st := dv.state()

	if st.Run.Status != runtime.RunFailed {
		t.Fatalf("run = %s/%s, want failed/child_depth_exceeded", st.Run.Status, st.Run.FailedCause)
	}
	if st.Run.FailedCause != runtime.ChildDepthExceeded {
		t.Errorf("runs.failed_cause = %q, want child_depth_exceeded (contract § 6 row 10 names the budget)",
			st.Run.FailedCause)
	}
	inv := st.Node("/fan_out[0]/invoke")
	if inv == nil || inv.Status != runtime.NodeFailed {
		t.Fatalf("invoke row = %+v, want failed", inv)
	}
	if inv.ErrorClass != runtime.ChildDepthExceeded || inv.FailedCause != runtime.ChildDepthExceeded {
		t.Errorf("invoke row error_class/failed_cause = %q/%q, want child_depth_exceeded/child_depth_exceeded",
			inv.ErrorClass, inv.FailedCause)
	}
	if len(st.Invocations) != 0 {
		t.Errorf("invocations = %d, want 0 — a refused booking is never recorded", len(st.Invocations))
	}
	rf := lastPayload(t, st, pevents.TypeRunFailed)
	if rf["failed_cause"] != runtime.ChildDepthExceeded {
		t.Errorf("run.failed failed_cause = %v, want child_depth_exceeded", rf["failed_cause"])
	}
	if rf["node_instance_key"] != "/fan_out[0]/invoke" {
		t.Errorf("run.failed node_instance_key = %v, want the refusing invoke's key", rf["node_instance_key"])
	}

	// The driver's backstop ticks: nil errors, no re-arming of the refusal,
	// and the second item never starts (the run is terminal — issue #96's
	// "other runs in the same tick are unaffected" is this run's own
	// sibling: nothing new is scheduled past the named failure).
	created := len(cr.created)
	for i := 0; i < 3; i++ {
		dv.advance() // t.Fatalf on any error
	}
	if len(cr.created) != created || created != 1 {
		t.Errorf("CreateChild calls = %d (was %d), want 1 — a terminal run's tick must not re-ask (issue #96's 2536-line loop)",
			len(cr.created), created)
	}
	if st2 := dv.state(); st2.Run.Status != runtime.RunFailed || st2.Run.FailedCause != runtime.ChildDepthExceeded {
		t.Errorf("run after retried ticks = %s/%s, want failed/child_depth_exceeded unchanged",
			st2.Run.Status, st2.Run.FailedCause)
	}
}
