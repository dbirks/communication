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

// testDeadlineFreshHeartbeat is pass 3's dedicated arm (contract § 5.4:
// "attempt deadline with a fresh heartbeat ⇒ set cancel_requested_at and let
// the worker close it"). conform-single authors timeoutSeconds: 60 on /work,
// so Start stamped a launch-relative deadline (§ 1). Renewing well inside
// every 30 s lease keeps the heartbeat fresh across the deadline; from there
// ReconcileDeadlines must do exactly ONE thing: stamp cancel_requested_at.
// It must not interrupt or fail the attempt, move the node or the run,
// schedule a retry, or write a single journal row — closing a live attempt is
// its owner's (§ 4 step 11; § 5.4 leaves it to "the worker", and § 4 step 7
// names the honest terminal for "killed by the deadline": failed /
// error_class='timeout'). The stale-heartbeat contrast lives in the sibling
// arm: past the deadline WITHOUT a fresh lease, pass 1 owns the outcome and
// pass 3 adds nothing.
func testDeadlineFreshHeartbeat(t *testing.T, f Factory) {
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
	started := s.Now()
	deadline := attemptByID(s.State(t), a.ID).DeadlineAt
	if deadline.IsZero() {
		t.Fatal("node timeoutSeconds must stamp attempts.deadline_at (contract § 1: launch-relative)")
	}

	// Fresh heartbeat: renew every 15 s — always half a lease early — then
	// walk one second past the deadline on the strength of the last renew.
	for _, off := range []time.Duration{15, 30, 45, 60} {
		s.SetNow(started.Add(off * time.Second))
		if err := s.Renew(a.ID, WorkerA, a.FencingToken); err != nil {
			t.Fatalf("renew at +%vs (heartbeat must stay fresh): %v", off, err)
		}
	}
	s.SetNow(deadline.Add(time.Second))

	before := s.Events(t)
	if err := s.ReconcileDeadlines(); err != nil {
		t.Fatalf("reconcile deadlines: %v", err)
	}
	st := s.State(t)
	at := attemptByID(st, a.ID)
	if at.CancelRequested == nil {
		t.Fatal("pass 3 with a fresh heartbeat must set cancel_requested_at (§ 5.4)")
	}
	if at.CancelRequested.After(s.Now()) {
		t.Fatalf("cancel_requested_at = %v, want at or before now %v", *at.CancelRequested, s.Now())
	}
	// The attempt is STILL live: the reconciler requested, it did not close.
	if at.Status != runtime.AttemptRunning {
		t.Fatalf("pass 3 moved the attempt to %s; only its owner may close a leased attempt (§ 5.4)", at.Status)
	}
	if n := st.Node("/work"); n.Status != runtime.NodeRunning {
		t.Fatalf("pass 3 moved the node to %s, want still running", n.Status)
	}
	if st.Run.Status != runtime.RunRunning {
		t.Fatalf("pass 3 moved the run to %s, want still running", st.Run.Status)
	}
	// No retry was scheduled: still exactly one attempt, nothing due.
	if len(st.Attempts) != 1 {
		t.Fatalf("pass 3 scheduled a retry: %d attempts (§ 5.4 requests cancellation, it does not re-queue)", len(st.Attempts))
	}
	for _, typ := range []string{
		string(pevents.TypeNodeAttemptInterrupted), string(pevents.TypeNodeAttemptFailed),
		string(pevents.TypeNodeAttemptCancelled),
	} {
		if n := countType(st.Events, typ); n != 0 {
			t.Fatalf("pass 3 wrote %s x%d: the request is silent, the close belongs to the worker (§ 4 step 11)", typ, n)
		}
	}
	hasPrefix(t, "deadline pass", before, st.Events)

	// Idempotence: the request is already stamped; a second pass moves nothing
	// (advance-twice-one-effect, contract § 8).
	first := *at.CancelRequested
	snapshotAfterFirst := s.Events(t)
	if err := s.ReconcileDeadlines(); err != nil {
		t.Fatalf("second reconcile deadlines: %v", err)
	}
	again := attemptByID(s.State(t), a.ID)
	if again.CancelRequested == nil || !again.CancelRequested.Equal(first) {
		t.Fatalf("second pass moved cancel_requested_at (%v → %v)", first, again.CancelRequested)
	}
	hasPrefix(t, "deadline re-pass", snapshotAfterFirst, s.State(t).Events)

	// The worker read cancel_requested_at on its renewal tick (§ 4 step 11):
	// the lease still renews — the request never killed the owner's fence.
	if err := s.Renew(a.ID, WorkerA, a.FencingToken); err != nil {
		t.Fatalf("renew after the cancel request: %v", err)
	}
	// …and its own terminal write closes the attempt exactly once, as timeout
	// (§ 4 step 7: "killed by the deadline ⇒ failed with error_class
	// timeout"). conform-single authors no retry block, so the authored stop
	// arm makes that failure the run's (§ 5.1 step 8, mirroring
	// testRetryAppendOnly's stop-path pin).
	if err := s.Fail(a.ID, WorkerA, a.FencingToken, runtime.ErrTimeout, "killed by deadline"); err != nil {
		t.Fatalf("worker's timeout close: %v", err)
	}
	st = s.State(t)
	at = attemptByID(st, a.ID)
	if at.Status != runtime.AttemptFailed || at.ErrorClass != runtime.ErrTimeout {
		t.Fatalf("worker close left %s/%s, want failed/timeout (§ 4 step 7)", at.Status, at.ErrorClass)
	}
	if n := countType(st.Events, string(pevents.TypeNodeAttemptFailed)); n != 1 {
		t.Fatalf("node.attempt.failed = %d, want exactly 1 (the attempt closed exactly once)", n)
	}
	if st.Run.Status != runtime.RunFailed || st.Run.FailedCause != "node_execution_failed:/work" {
		t.Fatalf("after the timeout close run=%s cause=%q, want failed/node_execution_failed:/work (§ 5.1 step 8)",
			st.Run.Status, st.Run.FailedCause)
	}

	// Late writes after the honest terminal are refused and the ledger is
	// untouched (append-only, 12 case 3's twin).
	history := s.Events(t)
	if err := s.Fail(a.ID, WorkerA, a.FencingToken, runtime.ErrInfra, "late"); err == nil {
		t.Fatal("a closed attempt accepted a late fail")
	}
	hasPrefix(t, "post-close late write", history, s.State(t).Events)
}

// testDeadlineStaleHeartbeatIsLeasePass is the contrast the contract's ORDER
// draws (§ 5.4: pass 1 BEFORE pass 3): a deadline crossed while the lease is
// stale is NOT pass 3's subject — pass 1 interrupts it and the advancer makes
// the retry decision. Running the reconciler in contract order must therefore
// show lease_expired evidence, and pass 3 afterwards must add nothing: the
// attempt stays interrupted, never cancel-requested (its owner is gone; there
// is nobody left to ask).
func testDeadlineStaleHeartbeatIsLeasePass(t *testing.T, f Factory) {
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
	deadline := attemptByID(s.State(t), a.ID).DeadlineAt
	if deadline.IsZero() {
		t.Fatal("fixture lost its deadline")
	}

	// Silent worker: the clock walks past the lease AND the deadline without
	// a single renew, then the reconciler runs in § 5.4's order.
	s.SetNow(deadline.Add(time.Second))
	if err := s.ReconcileLeases(); err != nil {
		t.Fatalf("reconcile leases: %v", err)
	}
	st := s.State(t)
	at := attemptByID(st, a.ID)
	if at.Status != runtime.AttemptInterrupted || at.ErrorClass != runtime.ErrInterrupted {
		t.Fatalf("stale lease past deadline left %s/%s, want interrupted/interrupted (pass 1 owns it, § 5.4)",
			at.Status, at.ErrorClass)
	}
	ev := lastEvent(st.Events, string(pevents.TypeNodeAttemptInterrupted))
	if got := payloadField(t, ev, "reason"); got != "lease_expired" {
		t.Fatalf("interrupt reason = %q, want lease_expired (the lease pass, not the deadline pass)", got)
	}

	// Pass 3 afterwards is a no-op on the dead attempt: no rows, no journal.
	before := s.Events(t)
	if err := s.ReconcileDeadlines(); err != nil {
		t.Fatalf("reconcile deadlines after lease pass: %v", err)
	}
	st = s.State(t)
	if at = attemptByID(st, a.ID); at.CancelRequested != nil {
		t.Fatalf("pass 3 cancel-requested an attempt pass 1 already closed (%v)", *at.CancelRequested)
	}
	if at.Status != runtime.AttemptInterrupted {
		t.Fatalf("pass 3 moved the interrupted attempt to %s", at.Status)
	}
	if len(st.Attempts) != 1 {
		t.Fatalf("deadline arm scheduled a retry; conform-single authors none (%d attempts)", len(st.Attempts))
	}
	hasPrefix(t, "deadline pass after lease pass", before, st.Events)
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
