package runtime_test

// TestWorkspaceLostAttemptArmsNoRetry is contract § 7.1 C6e's engine arm and
// ADR-0023 § 7's rule as an executable statement: an attempt that lands
// `workspace_lost` (the run's workspace is on another worker's volume — see
// internal/worker's § 4 step 3 decorator) is terminal for the node. It must not
// schedule a retry even though the node's authored retriableErrors hold room
// and its budget is 3, because workspace_lost sits in no retriableErrors list
// the compiler will admit (compiler/policy.go refuses it there).

import (
	"testing"

	pevents "github.com/dbirks/communication/internal/pipelines/events"
	"github.com/dbirks/communication/internal/pipelines/runtime"
)

func TestWorkspaceLostAttemptArmsNoRetry(t *testing.T) {
	plan := loadPlan(t, "../testdata/feature-development-contract.yaml")
	dv := newDriver(t, plan, sampleInputs())
	dv.advance()

	a, err := dv.ms.Claim(dv.run.ID, "worker-a") // /plan is the first ready
	if err != nil || a == nil {
		t.Fatalf("claim: %v %v", a, err)
	}
	if err := dv.ms.Start(dv.run.ID, a.ID, a.WorkerID, a.FencingToken); err != nil {
		t.Fatal(err)
	}
	// The worker's § 4 step 3 refusal, classed as ADR-0023 § 7 says it must be.
	if err := dv.ms.Fail(dv.run.ID, a.ID, a.WorkerID, a.FencingToken, runtime.ErrWorkspaceLost,
		"workspace.recovery_lost/volume_changed: prior edits lost, rerun required", nil); err != nil {
		t.Fatalf("fail: %v", err)
	}

	st := dv.state()
	if atts := st.AttemptsFor(a.NodeExecutionID); len(atts) != 1 {
		t.Fatalf("attempt rows = %d, want 1 — workspace_lost never arms another attempt", len(atts))
	}
	if n := st.Node("/plan"); n.Status != runtime.NodeFailed || n.ErrorClass != runtime.ErrWorkspaceLost {
		t.Fatalf("/plan = %s/%s, want failed/workspace_lost", n.Status, n.ErrorClass)
	}

	dv.pump(30)
	st = dv.state()
	if st.Run.Status != runtime.RunFailed {
		t.Fatalf("run = %s, want failed (12 case 20's honest arm: no auto-retry, a human reruns)", st.Run.Status)
	}
	if got := lastPayload(t, st, pevents.TypeRunFailed)["error_class"]; got != runtime.ErrWorkspaceLost {
		t.Errorf("run.failed error_class = %v, want workspace_lost (the run page's error chip is read from here)", got)
	}
	if c := countType(st, pevents.TypeNodeAttemptRetryScheduled); c != 0 {
		t.Errorf("node.attempt.retry_scheduled = %d, want 0 (ADR-0023 § 11 pass 5's no-auto-retry rule)", c)
	}
	if st.Run.WorkspaceLost {
		t.Error("run.WorkspaceLost set on an attempt-refusal arm: that flag is reconciler pass 5's evidence for a run that never reached a worker")
	}
}
