package runtimetest

import (
	"encoding/json"
	"testing"
	"time"

	pevents "github.com/dbirks/communication/internal/pipelines/events"
	"github.com/dbirks/communication/internal/pipelines/runtime"
)

// The reconciler arms no other subtest reaches: pass 4 (the run's own duration
// budget) and pass 5 (its workspace vanished before a worker held it), from
// docs/m4-contract.md § 5.4 / ADR-0023 § 11. Expectations were pinned by
// observing MemStore, exactly as subtests.go does.

// testRunDurationBudget: conform-single authors policies.maxDurationSeconds:
// 3600, so walking the clock two hours past the attempt's start must end the
// RUN — not the attempt — with failed_cause='run_duration_exceeded' and § 10's
// cascade behind it (live attempts cancel-requested, never terminated by the
// control plane).
func testRunDurationBudget(t *testing.T, f Factory) {
	s := f.Open(t, Config{Pipeline: PipelineSingle})
	if err := s.Advance(); err != nil {
		t.Fatalf("advance: %v", err)
	}
	a, err := s.Claim(WorkerA)
	if err != nil || a == nil {
		t.Fatalf("claim: %v", err)
	}
	if err := s.Start(a.ID, WorkerA, a.FencingToken); err != nil {
		t.Fatalf("start: %v", err)
	}
	history := s.Events(t)

	s.SetNow(s.Now().Add(2 * time.Hour))
	if err := s.Advance(); err != nil {
		t.Fatalf("advance past the run budget: %v", err)
	}
	st := s.State(t)
	if st.Run.Status != runtime.RunFailed {
		t.Fatalf("run after the duration budget = %s, want failed (contract § 6)", st.Run.Status)
	}
	if st.Run.FailedCause != "run_duration_exceeded" {
		t.Fatalf("failed_cause = %q, want run_duration_exceeded (§ 5.4 pass 4)", st.Run.FailedCause)
	}
	if st.Run.FinishedAt.IsZero() {
		t.Fatal("a terminal run must carry finished_at (runs_terminal_timestamped)")
	}
	if countType(st.Events, string(pevents.TypeRunFailed)) != 1 {
		t.Fatalf("run.failed = %d, want 1 (§ 3 row 10)", countType(st.Events, string(pevents.TypeRunFailed)))
	}
	if got := payloadField(t, lastEvent(st.Events, string(pevents.TypeRunFailed)), "failed_cause"); got != "run_duration_exceeded" {
		t.Fatalf("run.failed failed_cause = %q, want run_duration_exceeded", got)
	}

	// § 10's cascade: the live attempt is cancel-REQUESTED. The reconciler does
	// not write the terminal of a worker's attempt — pass 1 or the worker does.
	live := attemptByID(st, a.ID)
	if live.CancelRequested == nil {
		t.Fatalf("attempt %s survived the cascade without cancel_requested_at (%s)", a.ID, live.Status)
	}
	if runtime.AttemptTerminal(live.Status) && live.Status != runtime.AttemptInterrupted {
		t.Fatalf("the control plane closed a live attempt as %s; only its owner may", live.Status)
	}
	hasPrefix(t, "duration cascade", history, st.Events)

	// Idempotent: the budget is spent, and a second pass must not repeat the
	// cascade or re-open the run.
	before := s.Events(t)
	if err := s.Advance(); err != nil {
		t.Fatalf("second advance: %v", err)
	}
	after := s.State(t)
	hasPrefix(t, "duration re-advance", before, after.Events)
	if after.Run.Status != runtime.RunFailed {
		t.Fatalf("a second pass moved the run to %s", after.Run.Status)
	}
}

// testWorkspaceLostInterrupt: pass 5's honest arm (12 case 20). A run that
// never reached a worker because its workspace is gone is INTERRUPTED with
// error_class='workspace_lost' — and, unlike every other arm, it must not be
// retried automatically: ADR-0023 § 7 keeps workspace_lost out of
// retry.retriableErrors, so the compiler and the reconciler agree that a human
// decides the next attempt (route 31).
func testWorkspaceLostInterrupt(t *testing.T, f Factory) {
	s := f.Open(t, Config{Pipeline: PipelineSingle})
	history := s.Events(t)
	if status := s.State(t).Run.Status; status != runtime.RunQueued {
		t.Fatalf("fixture must open queued for pass 5's arm, got %s", status)
	}

	if err := s.InterruptWorkspaceLost(); err != nil {
		t.Fatalf("workspace-lost pass: %v", err)
	}
	st := s.State(t)
	if st.Run.Status != runtime.RunInterrupted {
		t.Fatalf("run = %s, want interrupted (§ 5.4 pass 5)", st.Run.Status)
	}
	if st.Run.FailedCause != "workspace_lost" {
		t.Fatalf("failed_cause = %q, want workspace_lost", st.Run.FailedCause)
	}
	if st.Run.FinishedAt.IsZero() {
		t.Fatal("an interrupted run must carry finished_at")
	}
	ev := lastEvent(st.Events, string(pevents.TypeRunInterrupted))
	if ev.Type != string(pevents.TypeRunInterrupted) {
		t.Fatalf("run.interrupted missing from the journal (§ 3 row 13): %v", st.Events)
	}
	if got := payloadField(t, ev, "error_class"); got != runtime.ErrWorkspaceLost {
		t.Fatalf("run.interrupted error_class = %q, want workspace_lost", got)
	}
	if ev.ActorKind != pevents.ActorKindSystem {
		t.Fatalf("run.interrupted actor_kind = %q, want system", ev.ActorKind)
	}
	hasPrefix(t, "workspace lost", history, st.Events)

	// No auto-retry: the backstop advance — which is what the reconciler tick
	// runs for every live run — must leave the honest terminal alone.
	before := s.Events(t)
	if err := s.Advance(); err != nil {
		t.Fatalf("advance after interrupt: %v", err)
	}
	after := s.State(t)
	hasPrefix(t, "workspace-lost re-advance", before, after.Events)
	if after.Run.Status != runtime.RunInterrupted {
		t.Fatalf("pass 5 auto-retried: run is %s", after.Run.Status)
	}
	if len(after.Attempts) != 0 {
		t.Fatalf("a lost workspace queued %d attempts; workspace_lost never auto-retries (ADR-0023 § 7)", len(after.Attempts))
	}
	// A human retry is the only way back, and it is route 31's decision, not
	// the reconciler's. Retry is asserted for real in testRetryAppendOnly.
}

// lastEvent returns the newest record of a type (zero Record when absent).
func lastEvent(events []pevents.Record, typ string) pevents.Record {
	var out pevents.Record
	for _, e := range events {
		if e.Type == typ {
			out = e
		}
	}
	return out
}

// payloadField reads one JSON member of an event payload. MemStore keeps the
// typed struct, an adapter hydrates the stored JSON (see the run.resumed arm in
// subtests.go), so both shapes are read through the wire form.
func payloadField(t *testing.T, ev pevents.Record, member string) string {
	t.Helper()
	raw, err := json.Marshal(ev.Payload)
	if err != nil {
		t.Fatalf("encode %s payload: %v", ev.Type, err)
	}
	var fields map[string]any
	if err := json.Unmarshal(raw, &fields); err != nil {
		t.Fatalf("decode %s payload %s: %v", ev.Type, raw, err)
	}
	v, _ := fields[member].(string)
	return v
}
