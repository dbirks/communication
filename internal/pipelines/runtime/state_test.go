package runtime_test

import (
	"strings"
	"testing"
	"time"

	"github.com/dbirks/communication/internal/pipelines/runtime"
)

var base = time.Date(2026, 10, 15, 12, 0, 0, 0, time.UTC)

// TestRunTransitions is 01's Run machine as a table: every cell of the
// adjacency matrix is asserted, not sampled.
func TestRunTransitions(t *testing.T) {
	legal := map[string][]string{
		runtime.RunQueued:       {runtime.RunPreparing, runtime.RunRunning, runtime.RunPaused, runtime.RunCompleted, runtime.RunFailed, runtime.RunCancelled, runtime.RunInterrupted},
		runtime.RunPreparing:    {runtime.RunRunning, runtime.RunPaused, runtime.RunFailed, runtime.RunCancelled, runtime.RunInterrupted},
		runtime.RunRunning:      {runtime.RunWaitingHuman, runtime.RunPaused, runtime.RunCompleted, runtime.RunFailed, runtime.RunCancelled, runtime.RunInterrupted},
		runtime.RunWaitingHuman: {runtime.RunRunning, runtime.RunPaused, runtime.RunFailed, runtime.RunCancelled, runtime.RunInterrupted},
		runtime.RunPaused:       {runtime.RunQueued, runtime.RunRunning, runtime.RunWaitingHuman, runtime.RunFailed, runtime.RunCancelled, runtime.RunInterrupted},
		runtime.RunInterrupted:  {runtime.RunQueued, runtime.RunRunning, runtime.RunFailed, runtime.RunCancelled},
		runtime.RunCompleted:    {},
		runtime.RunFailed:       {},
		runtime.RunCancelled:    {},
	}
	all := []string{runtime.RunQueued, runtime.RunPreparing, runtime.RunRunning,
		runtime.RunWaitingHuman, runtime.RunPaused, runtime.RunCompleted,
		runtime.RunFailed, runtime.RunCancelled, runtime.RunInterrupted}
	for from, oks := range legal {
		okSet := map[string]bool{}
		for _, o := range oks {
			okSet[o] = true
		}
		for _, to := range all {
			if from == to {
				continue
			}
			if got := runtime.CanRunTransition(from, to); got != okSet[to] {
				t.Errorf("CanRunTransition(%s → %s) = %v, want %v", from, to, got, okSet[to])
			}
		}
	}
	for _, s := range []string{runtime.RunCompleted, runtime.RunFailed, runtime.RunCancelled} {
		if !runtime.RunTerminal(s) {
			t.Errorf("RunTerminal(%s) = false", s)
		}
	}
	if runtime.RunTerminal(runtime.RunRunning) || runtime.RunTerminal(runtime.RunPaused) {
		t.Error("live states must not be terminal")
	}
}

func TestMoveRunRules(t *testing.T) {
	t.Run("terminal needs timestamp", func(t *testing.T) {
		r := &runtime.Run{ID: "r", Status: runtime.RunRunning}
		if err := r.MoveRun(runtime.RunCompleted, "", "", time.Time{}); err == nil {
			t.Fatal("completed without finished_at must be refused (runs_terminal_timestamped)")
		}
		if r.Status != runtime.RunRunning {
			t.Fatalf("refusal must not mutate the row (got %s)", r.Status)
		}
	})
	t.Run("failed needs a cause", func(t *testing.T) {
		r := &runtime.Run{ID: "r", Status: runtime.RunRunning}
		if err := r.MoveRun(runtime.RunFailed, "", "", base); err == nil {
			t.Fatal("failed without failed_cause must be refused (runs_terminal_cause)")
		}
		if err := r.MoveRun(runtime.RunFailed, "node_execution_failed:/x", "", base); err != nil {
			t.Fatal(err)
		}
		if r.FinishedAt.IsZero() {
			t.Error("terminal carries finished_at")
		}
	})
	t.Run("paused needs a reason", func(t *testing.T) {
		r := &runtime.Run{ID: "r", Status: runtime.RunRunning}
		if err := r.MoveRun(runtime.RunPaused, "", "", base); err == nil {
			t.Fatal("paused without reason must be refused (runs_paused_reasoned)")
		}
		if err := r.MoveRun(runtime.RunPaused, "", runtime.PausedHumanTakeover, base); err != nil {
			t.Fatal(err)
		}
		if r.PausedReason != runtime.PausedHumanTakeover {
			t.Errorf("paused_reason = %q", r.PausedReason)
		}
		if err := r.MoveRun(runtime.RunRunning, "", "", base); err != nil {
			t.Fatal(err)
		}
		if r.PausedReason != "" {
			t.Error("resume clears paused_reason")
		}
	})
	t.Run("illegal edge", func(t *testing.T) {
		r := &runtime.Run{ID: "r", Status: runtime.RunCompleted}
		err := r.MoveRun(runtime.RunRunning, "", "", base)
		if err == nil || !strings.Contains(err.Error(), "illegal transition") {
			t.Fatalf("completed → running: %v", err)
		}
	})
	t.Run("same status is a no-op", func(t *testing.T) {
		r := &runtime.Run{ID: "r", Status: runtime.RunRunning}
		if err := r.MoveRun(runtime.RunRunning, "", "", base); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("started_at is first-run", func(t *testing.T) {
		r := &runtime.Run{ID: "r", Status: runtime.RunQueued}
		if err := r.MoveRun(runtime.RunRunning, "", "", base); err != nil {
			t.Fatal(err)
		}
		if !r.StartedAt.Equal(base) {
			t.Error("running stamps started_at")
		}
	})
}

func TestReopenForRetry(t *testing.T) {
	for _, s := range []string{runtime.RunFailed, runtime.RunInterrupted, runtime.RunCancelled} {
		r := &runtime.Run{ID: "r", Status: s, FailedCause: "x", FinishedAt: base}
		if err := r.ReopenForRetry(); err != nil {
			t.Errorf("reopen %s: %v", s, err)
		}
		if r.Status != runtime.RunQueued || !r.FinishedAt.IsZero() {
			t.Errorf("reopen %s left %+v", s, r)
		}
	}
	r := &runtime.Run{ID: "r", Status: runtime.RunRunning}
	if err := r.ReopenForRetry(); err == nil || !strings.Contains(err.Error(), "run_not_retriable") {
		t.Fatalf("a live run must not reopen: %v", err)
	}
}

// TestNodeTransitions mirrors node_executions' CHECKs, including
// node_executions_control_plane_never_leased (ADR-0023 § 3's two paths
// through ONE machine).
func TestNodeTransitions(t *testing.T) {
	legal := map[string][]string{
		runtime.NodePending:     {runtime.NodeReady, runtime.NodeSkipped, runtime.NodeCancelled, runtime.NodeFailed},
		runtime.NodeReady:       {runtime.NodeLeased, runtime.NodeSucceeded, runtime.NodeFailed, runtime.NodeSkipped, runtime.NodeWaiting, runtime.NodeCancelled, runtime.NodeInterrupted},
		runtime.NodeLeased:      {runtime.NodeRunning, runtime.NodeReady, runtime.NodeSucceeded, runtime.NodeFailed, runtime.NodeWaiting, runtime.NodeCancelled, runtime.NodeInterrupted},
		runtime.NodeRunning:     {runtime.NodeSucceeded, runtime.NodeFailed, runtime.NodeReady, runtime.NodeWaiting, runtime.NodeCancelled, runtime.NodeInterrupted},
		runtime.NodeWaiting:     {runtime.NodeSucceeded, runtime.NodeFailed, runtime.NodeReady, runtime.NodeCancelled, runtime.NodeInterrupted},
		runtime.NodeFailed:      {runtime.NodeReady},
		runtime.NodeCancelled:   {runtime.NodeReady}, // run-level retry (route 31)
		runtime.NodeInterrupted: {runtime.NodeReady},
		runtime.NodeSucceeded:   {},
		runtime.NodeSkipped:     {},
	}
	all := []string{runtime.NodePending, runtime.NodeReady, runtime.NodeLeased, runtime.NodeRunning,
		runtime.NodeSucceeded, runtime.NodeFailed, runtime.NodeSkipped, runtime.NodeWaiting,
		runtime.NodeCancelled, runtime.NodeInterrupted}
	for from, oks := range legal {
		okSet := map[string]bool{}
		for _, o := range oks {
			okSet[o] = true
		}
		for _, to := range all {
			if from == to {
				continue
			}
			if got := runtime.CanNodeTransition(from, to); got != okSet[to] {
				t.Errorf("CanNodeTransition(%s → %s) = %v, want %v", from, to, got, okSet[to])
			}
		}
	}
	t.Run("control plane never leases", func(t *testing.T) {
		n := &runtime.NodeExecution{ID: "ne", InstanceKey: "/c", Location: "control_plane", Status: runtime.NodeReady}
		if err := n.Move(runtime.NodeLeased, base); err == nil {
			t.Fatal("control_plane → leased must be refused (node_executions_control_plane_never_leased)")
		}
		if n.Status != runtime.NodeReady {
			t.Fatal("refusal must not mutate")
		}
		if err := n.Move(runtime.NodeRunning, base); err == nil {
			t.Fatal("control_plane → running must be refused too")
		}
		if err := n.Move(runtime.NodeSucceeded, base); err != nil {
			t.Fatalf("control_plane pending→ready→succeeded is ADR-0023 § 3's path: %v", err)
		}
	})
	t.Run("terminal timestamps", func(t *testing.T) {
		n := &runtime.NodeExecution{ID: "ne", InstanceKey: "/w", Location: "worker", Status: runtime.NodeRunning}
		for _, term := range []string{runtime.NodeSucceeded, runtime.NodeFailed, runtime.NodeSkipped, runtime.NodeCancelled, runtime.NodeInterrupted} {
			if err := n.Move(term, time.Time{}); err == nil {
				t.Errorf("%s → %s without finished_at must be refused", n.Status, term)
			}
		}
		if err := n.Move(runtime.NodeSucceeded, base); err != nil {
			t.Fatal(err)
		}
		if n.FinishedAt.IsZero() {
			t.Error("terminal node carries finished_at")
		}
	})
	t.Run("ready_at", func(t *testing.T) {
		n := &runtime.NodeExecution{ID: "ne", InstanceKey: "/w", Location: "worker", Status: runtime.NodePending}
		if err := n.Move(runtime.NodeReady, base); err != nil {
			t.Fatal(err)
		}
		if n.ReadyAt.IsZero() {
			t.Error("node_executions_ready_timestamped: ready carries ready_at")
		}
	})
}

// TestAttemptTransitions covers 01 invariant 3 and contract § 1's five
// attempt CHECKs as pure transition behaviour.
func TestAttemptTransitions(t *testing.T) {
	t.Run("queued is unowned", func(t *testing.T) {
		a := newAttempt("at", 1, runtime.AttemptQueued)
		if err := a.Check(); err != nil {
			t.Fatal(err)
		}
		a.WorkerID = "w"
		if err := a.Check(); err == nil || !strings.Contains(err.Error(), "attempts_queued_unowned") {
			t.Fatalf("owned queued row: %v", err)
		}
	})
	t.Run("lease is a triple", func(t *testing.T) {
		a := newAttempt("at", 1, runtime.AttemptQueued)
		if err := a.Claim("w1", 7, base, time.Minute); err != nil {
			t.Fatal(err)
		}
		a.LeaseExpiresAt = time.Time{}
		if err := a.Check(); err == nil || !strings.Contains(err.Error(), "attempts_lease_is_a_triple") {
			t.Fatalf("leased without deadline: %v", err)
		}
	})
	t.Run("claim draws a positive token", func(t *testing.T) {
		a := newAttempt("at", 1, runtime.AttemptQueued)
		if err := a.Claim("w1", 0, base, time.Minute); err == nil {
			t.Fatal("token 0 must be refused (01 invariant 3)")
		}
	})
	t.Run("happy path", func(t *testing.T) {
		a := newAttempt("at", 1, runtime.AttemptQueued)
		must(t, a.Claim("w1", 5, base, 30*time.Second))
		must(t, a.Start(base.Add(time.Second), time.Hour))
		must(t, a.Renew("w1", 5, base.Add(10*time.Second), 30*time.Second))
		if err := a.Renew("w2", 5, base, 30*time.Second); err == nil {
			t.Fatal("wrong owner renews: refuse")
		}
		if err := a.Verify("w1", 4); err == nil {
			t.Fatal("stale token verifies: refuse (StaleOwner)")
		}
		must(t, a.Succeed("w1", 5, base.Add(20*time.Second), map[string]any{}, "sha256:x", nil))
		if err := a.Check(); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("succeeded needs outputs (01 invariant 4)", func(t *testing.T) {
		a := newAttempt("at", 1, runtime.AttemptQueued)
		must(t, a.Claim("w1", 5, base, time.Minute))
		must(t, a.Start(base, 0))
		if err := a.Succeed("w1", 5, base.Add(time.Second), nil, "", nil); err == nil {
			t.Fatal("success without an output envelope must be refused")
		}
	})
	t.Run("failed needs a class", func(t *testing.T) {
		a := newAttempt("at", 1, runtime.AttemptQueued)
		must(t, a.Claim("w1", 5, base, time.Minute))
		must(t, a.Start(base, 0))
		if err := a.Fail("w1", 5, base.Add(time.Second), "", "boom", nil); err == nil {
			t.Fatal("attempts_failed_has_class")
		}
		if err := a.Fail("w1", 5, base.Add(time.Second), "not_a_class", "", nil); err == nil {
			t.Fatal("error class outside ADR-0023 § 7 must be refused")
		}
		must(t, a.Fail("w1", 5, base.Add(time.Second), runtime.ErrAgentError, strings.Repeat("x", 600), nil))
		if len(a.Detail) != 512 {
			t.Errorf("detail bounded to 512 (attempts.detail CHECK), got %d", len(a.Detail))
		}
	})
	t.Run("interrupt refuses an unclaimed attempt", func(t *testing.T) {
		a := newAttempt("at", 1, runtime.AttemptQueued)
		if err := a.Interrupt(base, ""); err == nil {
			t.Fatal("a queued attempt was never owned: the honest terminal is cancelled")
		}
	})
	t.Run("cancel before claim", func(t *testing.T) {
		a := newAttempt("at", 1, runtime.AttemptQueued)
		must(t, a.CancelBeforeClaim(base, "on_child_failure_stop"))
		if a.Status != runtime.AttemptCancelled || a.ErrorClass != runtime.ErrCancelled {
			t.Fatalf("%+v", a)
		}
		if err := a.Check(); err != nil {
			t.Fatalf("a before-claim cancel has no owner and must still be valid: %v", err)
		}
		b := newAttempt("at", 2, runtime.AttemptQueued)
		must(t, b.Claim("w", 9, base, time.Minute))
		if err := b.CancelBeforeClaim(base, "x"); err == nil {
			t.Fatal("a live attempt is cancelled by its owner, not the advancer")
		}
	})
	t.Run("terminal is absorbing", func(t *testing.T) {
		a := newAttempt("at", 1, runtime.AttemptQueued)
		must(t, a.Claim("w", 3, base, time.Minute))
		must(t, a.Start(base, 0))
		must(t, a.Succeed("w", 3, base, map[string]any{}, "d", nil))
		if err := a.Move(runtime.AttemptFailed, base.Add(time.Hour)); err == nil {
			t.Fatal("succeeded → failed must be refused (01: attempts append, never overwrite)")
		}
	})
	t.Run("agent turn pair", func(t *testing.T) {
		a := newAttempt("at", 1, runtime.AttemptQueued)
		a.TurnID = "turn"
		if err := a.Check(); err == nil || !strings.Contains(err.Error(), "attempts_agent_turn_pair") {
			t.Fatalf("turn without conversation: %v", err)
		}
	})
}

func TestErrorClasses(t *testing.T) {
	for _, c := range []string{"infra", "interrupted", "timeout", "agent_error", "invalid_output",
		"predicate_error", "sandbox_enforcement_failed", "workspace_lost", "binding_error",
		"approval_expired", "cancelled"} {
		if !runtime.ValidErrorClass(c) {
			t.Errorf("error class %q must be admitted (ADR-0023 § 7)", c)
		}
	}
	for _, c := range []string{"", "node_execution_failed", "until_exhausted", "WORKSPACE_LOST"} {
		if runtime.ValidErrorClass(c) {
			t.Errorf("error class %q must not be admitted", c)
		}
	}
}

// TestApprovalCAS is 12 case 9's machine: CAS, denial-without-mutation, and
// the expire re-request that happens EXACTLY once.
func TestApprovalCAS(t *testing.T) {
	ap := &runtime.Approval{ID: "ap", State: runtime.ApprovalPending, Version: 1, OnTimeout: "expire", DeadlineAt: base.Add(time.Minute)}
	must(t, ap.Check())
	// CAS miss.
	if err := ap.Decide(0, "approved", "", "alice", base); err == nil {
		t.Fatal("stale version must conflict")
	}
	// Expire with on_timeout=expire re-requests once.
	re, err := ap.Expire(base.Add(2 * time.Minute))
	must(t, err)
	if !re || !ap.ReRequested {
		t.Fatalf("first expiry must re-request: re=%v", re)
	}
	if err := ap.Decide(1, "approved", "", "alice", base); err == nil {
		t.Fatal("the CAS version moved on re-request — the old read must conflict")
	}
	re, err = ap.Expire(base.Add(3 * time.Minute))
	must(t, err)
	if re || ap.State != runtime.ApprovalExpired {
		t.Fatalf("second expiry must fail the gate: re=%v state=%s", re, ap.State)
	}
	// Decided consistency.
	g := &runtime.Approval{ID: "g", State: runtime.ApprovalPending, Version: 1, OnTimeout: "fail"}
	must(t, g.Decide(1, "rejected", "no", "bob", base))
	if g.State != runtime.ApprovalDecided || g.Decision != "rejected" {
		t.Fatalf("%+v", g)
	}
	if err := g.Decide(2, "approved", "", "eve", base); err == nil {
		t.Fatal("already-decided must conflict")
	}
	bad := &runtime.Approval{ID: "b", State: runtime.ApprovalDecided, Version: 1}
	if err := bad.Check(); err == nil {
		t.Fatal("approvals_decided_consistency: decided with no decision")
	}
	pend := &runtime.Approval{ID: "p", State: runtime.ApprovalPending, Version: 1, Decision: "approved"}
	if err := pend.Check(); err == nil {
		t.Fatal("pending with a decision is the same lie")
	}
}

func TestCheckpointAndInvocationChecks(t *testing.T) {
	c := runtime.CheckpointRecord{RunID: "r", NodeExecutionID: "ne", OutputsDigest: "sha256:a", InputsDigest: "sha256:b", WorkspaceID: "ws", WorkerID: "w"}
	if err := c.Check(); err == nil || !strings.Contains(err.Error(), "volume_id") {
		t.Fatalf("run_checkpoints_volume_required (D-024): %v", err)
	}
	c.VolumeID = "vol-a"
	must(t, c.Check())
	iv := runtime.Invocation{ID: "iv", RunID: "r", NodeExecutionID: "ne", ChildRunID: "r", Depth: 1, WaitPolicy: "completion"}
	if err := iv.Check(); err == nil {
		t.Fatal("pipeline_invocations_child_is_not_self")
	}
	iv.ChildRunID = "r2"
	iv.Depth = 3
	if err := iv.Check(); err == nil {
		t.Fatal("runs_depth_check caps at 2")
	}
	iv.Depth = 1
	iv.WaitPolicy = "detach"
	if err := iv.Check(); err == nil {
		t.Fatal("detach is refused at validate (ADR-0024 § 4) — the runtime refuses it too")
	}
	iv.WaitPolicy = "completion"
	must(t, iv.Check())
}

// helpers ------------------------------------------------------------------

func newAttempt(id string, n int, status string) *runtime.Attempt {
	return &runtime.Attempt{ID: id, AttemptNumber: n, Status: status}
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatalf("unexpected: %v", err)
	}
}
