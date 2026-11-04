package runtime_test

import (
	"errors"
	"testing"

	"github.com/dbirks/communication/internal/pipelines/runtime"
)

// TestAdvanceWaitingInvokeWithoutChildResolver is the advance-children-nil
// guard: a pass that must POLL a waiting pipeline.invoke but was handed no
// ChildResolver refuses with runtime.ErrNoChildResolver — the error the
// driver and every settle caller can log — instead of nil-dereferencing in
// pollInvoke. The refusal writes nothing: the row stays exactly as the
// hydrated transaction wrote it, so a replica that IS wired polls the child
// on the next pass as if nothing happened.
func TestAdvanceWaitingInvokeWithoutChildResolver(t *testing.T) {
	plan := loadPlan(t, "testdata/fanout_single.yaml")
	// The child stays live forever (delay never settles), so the invoke node
	// parks waiting on it — the exact row shape return-control's advance
	// landed on in the lab.
	cr := &scriptedChildren{status: map[int]string{}, delay: map[int]int{0: 99}}
	dv := newDriverWith(t, plan, map[string]any{"goal": "fan me"}, runtime.AdvancerDeps{Children: cr})
	dv.script("/seed", step{outputs: worklist(1)})
	dv.pump(30)
	st := dv.state()
	invoking := st.Node("/fan_out[0]/invoke")
	if invoking == nil || invoking.Status != runtime.NodeWaiting || invoking.Waiting != runtime.WaitingChildRun {
		t.Fatalf("invoke node = %+v, want waiting on a child run", invoking)
	}
	if len(st.Invocations) != 1 || st.Invocations[0].NodeExecutionID != invoking.ID {
		t.Fatalf("invocations = %+v, want exactly the waiting node's booking", st.Invocations)
	}
	runStatus := st.Run.Status
	eventsBefore := len(st.Events)

	// The bare advancer: the same program, no resolver — the shape the
	// conversation-side transactions used to build for return-control.
	prog, d := runtime.PreparePlan(plan)
	if !d.Valid() {
		t.Fatalf("PreparePlan: %v", d)
	}
	bare := &runtime.Advancer{Prog: prog, Deps: runtime.AdvancerDeps{}}
	err := bare.Advance(st, dv.now)
	if !errors.Is(err, runtime.ErrNoChildResolver) {
		t.Fatalf("Advance = %v, want an error wrapping %v (the loggable refusal)", err, runtime.ErrNoChildResolver)
	}
	// Nothing moved: the poll is a read, and the pass it could not finish
	// leaves the row exactly as hydrated.
	if got := st.Node("/fan_out[0]/invoke"); got.Status != runtime.NodeWaiting || got.Waiting != runtime.WaitingChildRun {
		t.Errorf("invoke node after the refused pass = %s/%s, want waiting on the child", got.Status, got.Waiting)
	}
	if st.Run.Status != runStatus {
		t.Errorf("run = %s after the refused pass, want %s (a refused pass moves nothing)", st.Run.Status, runStatus)
	}
	if len(st.Events) != eventsBefore {
		t.Errorf("events = %d after the refused pass, want %d (no journal for a refusal)", len(st.Events), eventsBefore)
	}

	// The same pass with the resolver wired behaves normally: it polls the
	// live child, writes nothing, and returns nil — the refusal is the wiring
	// gap's, not the row's.
	wired := &runtime.Advancer{Prog: prog, Deps: runtime.AdvancerDeps{Children: cr}}
	if err := wired.Advance(st, dv.now); err != nil {
		t.Fatalf("Advance with the resolver wired = %v, want nil (the child is simply still live)", err)
	}
	if got := st.Node("/fan_out[0]/invoke"); got.Status != runtime.NodeWaiting {
		t.Errorf("invoke node after the wired pass = %s, want waiting", got.Status)
	}
}
