package runtime_test

import (
	"errors"
	"strings"
	"testing"
	"time"

	pevents "github.com/dbirks/communication/internal/pipelines/events"
	"github.com/dbirks/communication/internal/pipelines/runtime"
)

// TestRunLevelRetryIsAppendOnly is route 31 / C6e: retry a failed run at a
// boundary; the key set never changes, attempts only grow, and the reopened
// run re-derives everything from rows.
func TestRunLevelRetryIsAppendOnly(t *testing.T) {
	plan := loadPlan(t, "testdata/stop.yaml")
	dv := newDriver(t, plan, map[string]any{"goal": "g"})
	dv.script("/a", step{failClass: runtime.ErrInfra, detail: "transient"},
		step{outputs: map[string]any{"ok": true}})
	dv.script("/b", step{outputs: map[string]any{"ok": true}})
	// First pass: /a authors no retry and no onFailure, so its single infra
	// attempt is terminal and the stop policy fails the run honestly.
	dv.pump(30)
	st := dv.state()
	if st.Run.Status != runtime.RunFailed {
		t.Fatalf("run = %s/%s, want failed", st.Run.Status, st.Run.FailedCause)
	}
	keysBefore := strings.Join(st.RunKeys(), ",")
	eventsBefore := len(st.SortedEvents())

	// Retry targets the failed /a (named target). Its skipped descendant is
	// NOT a reopen candidate (skipped ≠ cancelled — the graph re-runs `when`
	// from rows anyway).
	if err := dv.ms.Retry(dv.run.ID, "alice", []string{"/a"}, nil); err != nil {
		t.Fatalf("retry: %v", err)
	}
	st = dv.state()
	if keysBefore != strings.Join(st.RunKeys(), ",") {
		t.Errorf("retry changed the key set: %s → %s (C6e: append, never rewrite)", keysBefore, st.RunKeys())
	}
	if st.Run.Status != runtime.RunRunning && st.Run.Status != runtime.RunQueued && st.Run.Status != runtime.RunPreparing {
		t.Errorf("run after retry = %s, want reopened", st.Run.Status)
	}
	if len(st.SortedEvents()) <= eventsBefore {
		t.Error("retry wrote no journal")
	}
	rt := lastRecord(t, st, pevents.TypeRunRetried).Payload.(pevents.RunRetried)
	if len(rt.Targets) != 1 || rt.Targets[0] != "/a" || rt.RequestedBy != "alice" {
		t.Errorf("run.retried payload = %+v", rt)
	}
	// Finish the retry honestly.
	dv.pump(30)
	st = dv.state()
	if st.Run.Status != runtime.RunCompleted {
		t.Fatalf("run = %s/%s events=%v", st.Run.Status, st.Run.FailedCause, eventTypes(st))
	}
	a := st.Node("/a")
	atts := st.AttemptsFor(a.ID)
	if len(atts) != 2 || atts[1].Status != runtime.AttemptSucceeded {
		t.Fatalf("/a attempts = %d, want 2 with a fresh success appended", len(atts))
	}
	if b := st.Node("/b"); b.Status != runtime.NodeSucceeded {
		t.Errorf("b = %s after retry, want re-run to succeeded", b.Status)
	}
	rb := lastPayload(t, st, pevents.TypeRunCompleted)["result_bindings"].(map[string]any)
	if rb["b_status"] != "succeeded" {
		t.Errorf("final b_status = %v, want succeeded", rb["b_status"])
	}
}

// TestCheckpointUnavailableRefusesRestore is C6d's teeth: restore_checkpoint
// against an uncommitted (or absent) boundary is a refusal that resets
// NOTHING — the destructive arm cannot be reached by accident.
func TestCheckpointUnavailableRefusesRestore(t *testing.T) {
	plan := loadPlan(t, "testdata/restore.yaml")
	dv := newDriver(t, plan, map[string]any{"goal": "g"})
	// a succeeds (durable checkpoint with an UNCOMMITTED repo state); b fails.
	dv.script("/a", step{outputs: map[string]any{"ok": true}, uncommitted: true})
	dv.script("/b", step{failClass: runtime.ErrInfra})
	dv.pump(30)
	st := dv.state()
	if st.Run.Status != runtime.RunFailed {
		t.Fatalf("run = %s/%s, want failed on b", st.Run.Status, st.Run.FailedCause)
	}
	// The checkpoint the retry would restore from carries uncommitted work.
	ck := st.Checkpoints[len(st.Checkpoints)-1]
	if ck.RepoStates[0].Committed {
		t.Fatal("fixture must carry an uncommitted repo state")
	}
	before := strings.Join(st.RunKeys(), ",") + "|" + st.Run.Status
	err := dv.ms.Retry(dv.run.ID, "alice", nil, nil)
	var unavail runtime.ErrCheckpointUnavailable
	if !errors.As(err, &unavail) {
		t.Fatalf("restore over uncommitted work = %v, want checkpoint_unavailable", err)
	}
	if unavail.NodeInstanceKey != "/b" {
		t.Errorf("refusal names %s, want /b", unavail.NodeInstanceKey)
	}
	st = dv.state()
	if before != strings.Join(st.RunKeys(), ",")+"|"+st.Run.Status {
		t.Fatal("a checkpoint_unavailable refusal must reset nothing (validate-then-mutate)")
	}
}

// TestRestoreCheckpointFromCommittedBoundary: the same retry with a committed
// boundary succeeds, and run.checkpoint_restored — the event that "proves
// the engine knows the difference" (contract § 3 row 8) — is written.
func TestRestoreCheckpointFromCommittedBoundary(t *testing.T) {
	plan := loadPlan(t, "testdata/restore.yaml")
	dv := newDriver(t, plan, map[string]any{"goal": "g"})
	dv.script("/a", step{outputs: map[string]any{"ok": true}})
	dv.script("/b", step{failClass: runtime.ErrInfra}, step{failClass: runtime.ErrInfra},
		step{outputs: map[string]any{"ok": true}})
	// Make /a's checkpoint boundary committed: the driver's default records
	// committed=true, so this is the ordinary case. /b authors two attempts,
	// so its own budget is spent before the run fails.
	dv.pump(20)
	st := dv.state()
	if st.Run.Status != runtime.RunFailed {
		t.Fatalf("run = %s/%s want failed on b", st.Run.Status, st.Run.FailedCause)
	}
	if ck := st.Checkpoints[len(st.Checkpoints)-1]; !ck.RepoStates[0].Committed {
		t.Fatal("fixture committed flag lost")
	}
	if err := dv.ms.Retry(dv.run.ID, "alice", nil, nil); err != nil {
		t.Fatalf("retry: %v", err)
	}
	st = dv.state()
	if c := countType(st, pevents.TypeRunCheckpointRestored); c != 1 {
		t.Errorf("run.checkpoint_restored = %d, want 1 under restore_checkpoint (and 0 under continue — C5f)", c)
	}
	rv := lastPayload(t, st, pevents.TypeRunCheckpointRestored)
	if rv["from_commit"] != "head-/a" {
		t.Errorf("from_commit = %v, want the committed boundary head", rv["from_commit"])
	}
	dv.pump(30)
	st = dv.state()
	if st.Run.Status != runtime.RunCompleted {
		t.Fatalf("run = %s/%s", st.Run.Status, st.Run.FailedCause)
	}
}

// TestHumanTakeoverPausesTheRun is ADR-0023 § 9's run-state half: the live
// attempt closes interrupted{human_takeover} and the run carries
// paused{human_takeover} — never a silent steal.
func TestHumanTakeoverPausesTheRun(t *testing.T) {
	plan := loadPlan(t, "testdata/gate_sibling.yaml")
	dv := newDriver(t, plan, map[string]any{"goal": "take it"})
	dv.advance()
	a, err := dv.ms.Claim(dv.run.ID, "worker-a")
	if err != nil || a == nil {
		t.Fatal("claim")
	}
	if err := dv.ms.Start(dv.run.ID, a.ID, "worker-a", a.FencingToken); err != nil {
		t.Fatal(err)
	}
	if err := dv.ms.MarkCancelledByHumanTakeover(dv.run.ID, a.ID, "user-a"); err != nil {
		t.Fatal(err)
	}
	st := dv.state()
	if a.Status != runtime.AttemptInterrupted {
		t.Errorf("attempt = %s, want interrupted", a.Status)
	}
	if st.Run.Status != runtime.RunPaused || st.Run.PausedReason != runtime.PausedHumanTakeover {
		t.Errorf("run = %s/%s, want paused/human_takeover", st.Run.Status, st.Run.PausedReason)
	}
	// C9g's half at the engine: the attempt's terminal event names the reason
	// the human moved, while error_class stays the honest 'interrupted'.
	var seen int
	for _, e := range st.SortedEvents() {
		if e.Type != pevents.TypeNodeAttemptInterrupted {
			continue
		}
		seen++
		if p, ok := e.Payload.(pevents.NodeAttemptInterrupted); !ok || p.Reason != runtime.PausedHumanTakeover {
			t.Errorf("node.attempt.interrupted reason = %+v, want %s", e.Payload, runtime.PausedHumanTakeover)
		}
	}
	if seen != 1 {
		t.Errorf("node.attempt.interrupted events = %d, want exactly 1", seen)
	}
	if a.ErrorClass != runtime.ErrInterrupted {
		t.Errorf("attempt error_class = %s, want %s", a.ErrorClass, runtime.ErrInterrupted)
	}
	// Claiming under the pause stays empty; a resume returns the node to
	// ready for a fresh attempt (the conversation machinery is M2's — this
	// is only the run-state seam).
	if got, err := dv.ms.Claim(dv.run.ID, "w"); err != nil || got != nil {
		t.Errorf("paused run claim = %v %v", got, err)
	}
	if err := dv.ms.Resume(dv.run.ID, "alice"); err != nil {
		t.Fatal(err)
	}
	dv.gate = func(*runtime.Approval) (string, string) { return "approved", "" }
	dv.pump(60)
	st = dv.state()
	if st.Run.Status != runtime.RunCompleted {
		t.Fatalf("run after takeover+resume = %s/%s", st.Run.Status, st.Run.FailedCause)
	}
}

// TestAttemptBudgetIsHard: the authored maxAttempts 3 in gate_sibling.yaml
// means exactly 3 attempt rows and no more, even with an infinitely retriable
// class.
func TestAttemptBudgetIsHard(t *testing.T) {
	plan := loadPlan(t, "testdata/gate_sibling.yaml")
	dv := newDriver(t, plan, map[string]any{"goal": "budget"})
	dv.script("/sibling", step{failClass: runtime.ErrInfra}) // every attempt fails
	dv.script("/after", step{outputs: map[string]any{}})
	dv.gate = func(*runtime.Approval) (string, string) { return "approved", "" }
	for i := 0; i < 8; i++ {
		dv.pump(40)
		dv.now = dv.now.Add(30 * time.Second)
	}
	st := dv.state()
	n := st.Node("/sibling")
	atts := st.AttemptsFor(n.ID)
	if len(atts) != 3 {
		t.Fatalf("attempt rows = %d, want exactly 3 (maxAttempts=3)", len(atts))
	}
	for i, a := range atts {
		if a.AttemptNumber != i+1 {
			t.Errorf("attempt numbering = %d, want %d (append-only ledger)", a.AttemptNumber, i+1)
		}
	}
	if n.Status != runtime.NodeFailed || n.ErrorClass != runtime.ErrInfra {
		t.Errorf("node = %s/%s, want failed after the budget", n.Status, n.ErrorClass)
	}
}
