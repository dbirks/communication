package runtime_test

import (
	"errors"
	"testing"

	"github.com/dbirks/communication/internal/pipelines/runtime"
)

// killImplement scripts the lab's C5 twin: /plan succeeds, /implement's attempt
// 1 is interrupted by the reconciler (the SIGKILL arm), and attempt 2 — which
// the ENGINE schedules itself, no POST involved — finishes the node.
func killImplement(t *testing.T, firstStep step) (*driver, map[string]any) {
	t.Helper()
	plan := loadPlan(t, "../testdata/feature-development-contract.yaml")
	dv := newDriver(t, plan, sampleInputs())
	dv.gate = func(*runtime.Approval) (string, string) { return "approved", "" }
	dv.script("/plan", firstStep)
	dv.script("/build_until_verified[1]/implement",
		step{interrupt: true},
		step{outputs: map[string]any{"summary": "attempt 2 finishes the edit"}})
	dv.script("/build_until_verified[1]/test", step{outputs: map[string]any{
		"exit_code": int64(0), "result": map[string]any{"successful": true}}})
	dv.script("/build_until_verified[1]/review", step{
		outputs: map[string]any{"approved": true, "evidence": "clean"}})
	dv.pump(100)
	st := dv.state()
	if st.Run.Status != runtime.RunCompleted {
		t.Fatalf("run = %s/%s, want completed after the auto-retry", st.Run.Status, st.Run.FailedCause)
	}
	im := st.Node("/build_until_verified[1]/implement")
	atts := st.AttemptsFor(im.ID)
	if len(atts) != 2 {
		t.Fatalf("attempts = %d, want 2 (the budget armed the retry)", len(atts))
	}
	if atts[1].RetryContext == nil {
		t.Fatal("the automatic retry carries no retry_context at all (ADR-0023 § 6)")
	}
	return dv, atts[1].RetryContext
}

// TestAutomaticRetryAfterInterruptNamesTheBoundaryCommit is lab live13 C5e's
// regression: ADR-0023 § 6 gives a continue_workspace retry
// {attempt, error_class, head_commit, modified_path_count}, and the automatic
// retry of an interrupted attempt is a retry. The boundary it inherits had no
// git capture, so its only recorded commit is the base commit — which IS the
// HEAD the retry resumes from. Dropping head_commit because the head column was
// never written left the retry describing nothing (retry_context='None').
func TestAutomaticRetryAfterInterruptNamesTheBoundaryCommit(t *testing.T) {
	_, rc := killImplement(t, step{outputs: map[string]any{"plan": "the plan"}, bareBoundary: true})
	if rc["attempt"] != int64(1) || rc["error_class"] != runtime.ErrInterrupted {
		t.Errorf("retry_context = %v, want {attempt:1 error_class:interrupted …}", rc)
	}
	if rc["head_commit"] != bareHead {
		t.Errorf("retry_context.head_commit = %v, want the boundary's commit identity %q",
			rc["head_commit"], bareHead)
	}
	// "Nobody measured the working tree" is not "the working tree was clean":
	// the key is absent rather than a confident zero restore_checkpoint could
	// act on.
	if _, ok := rc["modified_path_count"]; ok {
		t.Errorf("retry_context = %v, want no modified_path_count for an un-captured boundary", rc)
	}
}

// TestAutomaticRetryCarriesMeasuredZeroPathCount is the other half of C5e: a
// boundary whose capture DID run reports its count even when it is zero, so the
// retry is told the tree it inherits is clean.
func TestAutomaticRetryCarriesMeasuredZeroPathCount(t *testing.T) {
	_, rc := killImplement(t, step{outputs: map[string]any{"plan": "the plan"}, cleanBoundary: true})
	if rc["head_commit"] != "head-/plan" {
		t.Errorf("retry_context.head_commit = %v, want the captured head", rc["head_commit"])
	}
	if rc["modified_path_count"] != int64(0) {
		t.Errorf("retry_context.modified_path_count = %v, want the measured 0 (C5e)", rc["modified_path_count"])
	}
}

// TestRestoreCheckpointRefusesAnUncapturedBoundary is C6d's other arm: the
// refusal is not only for a boundary known dirty, but for one whose committed
// state was never recorded. restore_checkpoint resets a tree; an unmeasured
// tree gives it no licence (ADR-0023 § 6: allowed only when every repo IS at a
// committed state).
func TestRestoreCheckpointRefusesAnUncapturedBoundary(t *testing.T) {
	plan := loadPlan(t, "testdata/restore.yaml")
	dv := newDriver(t, plan, map[string]any{"goal": "g"})
	dv.script("/a", step{outputs: map[string]any{"ok": true}, bareBoundary: true})
	dv.script("/b", step{failClass: runtime.ErrInfra}, step{failClass: runtime.ErrInfra})
	dv.pump(30)
	st := dv.state()
	if st.Run.Status != runtime.RunFailed {
		t.Fatalf("run = %s/%s, want failed on b", st.Run.Status, st.Run.FailedCause)
	}
	ck := st.Checkpoints[len(st.Checkpoints)-1]
	if ck.RepoStates[0].CaptureRecorded {
		t.Fatal("fixture must be an un-captured boundary")
	}
	err := dv.ms.Retry(dv.run.ID, "alice", nil, nil)
	var unavail runtime.ErrCheckpointUnavailable
	if !errors.As(err, &unavail) {
		t.Fatalf("restore over an un-captured boundary = %v, want checkpoint_unavailable", err)
	}
	if unavail.NodeInstanceKey != "/b" {
		t.Errorf("refusal names %s, want /b", unavail.NodeInstanceKey)
	}
	if st.Run.Status != runtime.RunFailed {
		t.Error("a checkpoint_unavailable refusal must reopen nothing")
	}
}
