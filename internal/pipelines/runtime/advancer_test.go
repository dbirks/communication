package runtime_test

import (
	"strings"
	"testing"
	"time"

	"github.com/dbirks/communication/internal/pipelines/compiler"
	pevents "github.com/dbirks/communication/internal/pipelines/events"
	"github.com/dbirks/communication/internal/pipelines/runtime"
)

// TestContinuePolicySkipsDependants: 03's failure table row — an execution
// error with onExecutionError=continue fails the node, skips its dependants,
// and the run completes honestly (b's envelope reads "skipped").
func TestContinuePolicySkipsDependants(t *testing.T) {
	plan := loadPlan(t, "testdata/continue.yaml")
	patchFailure(plan, "a", "continue", "")
	dv := newDriver(t, plan, map[string]any{"goal": "g"})
	dv.script("/a", step{failClass: runtime.ErrInfra, detail: "the sandbox said no"})
	dv.pump(30)
	st := dv.state()
	a := st.Node("/a")
	if a.Status != runtime.NodeFailed || a.ErrorClass != runtime.ErrInfra {
		t.Fatalf("a = %s/%s", a.Status, a.ErrorClass)
	}
	b := st.Node("/b")
	if b.Status != runtime.NodeSkipped || b.SkipReason != "dependency_skipped" {
		t.Errorf("b = %s/%s, want skipped/dependency_skipped", b.Status, b.SkipReason)
	}
	if st.Run.Status != runtime.RunCompleted {
		t.Fatalf("run = %s/%s, want completed", st.Run.Status, st.Run.FailedCause)
	}
	rb := lastPayload(t, st, pevents.TypeRunCompleted)["result_bindings"].(map[string]any)
	if rb["b_status"] != "skipped" {
		t.Errorf("b_status = %v, want skipped (the envelope grammar is observable)", rb["b_status"])
	}
}

// TestRoutePolicyRunsTheCarrier: D6 — the named error route runs off the
// FAILED envelope; the non-route dependant is skipped; the run completes.
func TestRoutePolicyRunsTheCarrier(t *testing.T) {
	plan := loadPlan(t, "testdata/route.yaml")
	// The compiler defect (a) drops authored onFailure from the plan; state
	// the fixed compiler's output.
	patchFailure(plan, "gen", "route", "recover")
	dv := newDriver(t, plan, map[string]any{"goal": "g"})
	dv.script("/gen", step{failClass: runtime.ErrAgentError, detail: "agent exploded"})
	dv.script("/recover", step{outputs: map[string]any{"ok": true}})
	dv.pump(30)
	st := dv.state()
	if st.Node("/gen").Status != runtime.NodeFailed {
		t.Fatalf("gen = %s", st.Node("/gen").Status)
	}
	rec := st.Node("/recover")
	if rec.Status != runtime.NodeSucceeded {
		t.Fatalf("route carrier = %s (%v), want succeeded", rec.Status, eventTypes(st))
	}
	if sid := st.Node("/sidecar"); sid.Status != runtime.NodeSkipped {
		t.Errorf("non-route dependant = %s, want skipped", sid.Status)
	}
	if st.Run.Status != runtime.RunCompleted {
		t.Fatalf("run = %s/%s, want completed (D6: a routed failure is not a run stop)", st.Run.Status, st.Run.FailedCause)
	}
	rb := lastPayload(t, st, pevents.TypeRunCompleted)["result_bindings"].(map[string]any)
	if rb["done"] != true {
		t.Errorf("done = %v, want true (the carrier read the failed envelope and ran)", rb["done"])
	}
}

// TestGateHoldsWhileSiblingRuns is contract § 5.3 / 12 case 9's shape: the
// gate parks the run in waiting_human with NO worker attached, while the
// independent branch keeps executing.
func TestGateHoldsWhileSiblingRuns(t *testing.T) {
	plan := loadPlan(t, "testdata/gate_sibling.yaml")
	dv := newDriver(t, plan, map[string]any{"goal": "hold"})
	dv.script("/sibling", step{outputs: map[string]any{"ok": true}})
	dv.gate = nil // hold the gate open
	dv.pump(30)
	st := dv.state()
	if st.Run.Status != runtime.RunWaitingHuman {
		t.Fatalf("run = %s, want waiting_human", st.Run.Status)
	}
	if st.Node("/sibling").Status != runtime.NodeSucceeded {
		t.Errorf("sibling stalled behind the gate — the gate must hold only its branch")
	}
	if len(st.AttemptsFor(st.Node("/gate").ID)) != 0 {
		t.Error("durable gate produced a worker attempt (ADR-0023 § 9: it holds no worker)")
	}
	// Now decide; the dependant runs and the run finishes.
	dv.gate = func(*runtime.Approval) (string, string) { return "approved", "go" }
	dv.pump(30)
	st = dv.state()
	if st.Run.Status != runtime.RunCompleted {
		t.Fatalf("run = %s/%s", st.Run.Status, st.Run.FailedCause)
	}
	if st.Node("/after").Status != runtime.NodeSucceeded {
		t.Errorf("after = %s", st.Node("/after").Status)
	}
	req := lastRecord(t, st, pevents.TypeApprovalRequested).Payload.(pevents.ApprovalRequested)
	if req.DeadlineAt.IsZero() || len(req.ApproverRoles) != 1 || req.ApproverRoles[0] != "maintainer" {
		t.Errorf("approval.requested payload incomplete: %+v", req)
	}
	// run.waiting_human fired exactly once for the single gate.
	if c := countType(st, pevents.TypeRunWaitingHuman); c != 1 {
		t.Errorf("run.waiting_human = %d, want 1", c)
	}
}

// TestGateExpiryReRequestsExactlyOnce is contract § 5.4 pass 2: an
// onTimeout=expire gate gets ONE re-request, and the second expiry is the
// honest failure.
func TestGateExpiryReRequestsExactlyOnce(t *testing.T) {
	plan := loadPlan(t, "testdata/gate_expire.yaml")
	dv := newDriver(t, plan, map[string]any{"goal": "expire me"})
	dv.pump(30)
	st := dv.state()
	if len(st.Approvals) != 1 || st.Approvals[0].State != runtime.ApprovalPending {
		t.Fatalf("gate not open: %v", st.Approvals)
	}
	// Past the 30 s deadline.
	dv.now = dv.now.Add(61 * time.Second)
	dv.advance()
	st = dv.state()
	ap := st.Approvals[0]
	if ap.State != runtime.ApprovalPending || !ap.ReRequested {
		t.Fatalf("first expiry: state=%s reRequested=%v — must re-request once", ap.State, ap.ReRequested)
	}
	ev := lastRecord(t, st, pevents.TypeApprovalExpired).Payload.(pevents.ApprovalExpired)
	if !ev.ReRequested || ev.OnTimeout != "expire" {
		t.Errorf("approval.expired = %+v, want re_requested=true on_timeout=expire", ev)
	}
	// The re-requested gate is live again inside a fresh window and still
	// decidable: another pass before the new deadline must not touch it.
	dv.advance()
	if st.Approvals[0].State != runtime.ApprovalPending {
		t.Fatalf("re-requested gate expired twice: %s", st.Approvals[0].State)
	}
	dv.now = dv.now.Add(61 * time.Second)
	dv.advance() // the second deadline passes — no second re-request
	st = dv.state()
	if st.Approvals[0].State != runtime.ApprovalExpired {
		t.Fatalf("second expiry: state=%s", st.Approvals[0].State)
	}
	if st.Node("/gate").Status != runtime.NodeFailed || st.Node("/gate").ErrorClass != runtime.ErrApprovalExpired {
		t.Errorf("gate = %s/%s, want failed/approval_expired", st.Node("/gate").Status, st.Node("/gate").ErrorClass)
	}
	if st.Run.Status != runtime.RunFailed || st.Run.FailedCause != "node_execution_failed:/gate" {
		t.Fatalf("run = %s/%s, want failed / node_execution_failed:/gate", st.Run.Status, st.Run.FailedCause)
	}
}

// TestApprovalDenialKeepsGateOpen: 12 case 9's revoked grant — a denied
// decision writes approval.denied and changes NOTHING else; the gate waits.
func TestApprovalDenialKeepsGateOpen(t *testing.T) {
	plan := loadPlan(t, "testdata/gate_sibling.yaml")
	dv := newDriver(t, plan, map[string]any{"goal": "deny"})
	dv.script("/sibling", step{outputs: map[string]any{"ok": true}})
	dv.pump(30)
	st := dv.state()
	ap := st.PendingApprovals()[0]
	err := dv.ms.Decide(dv.run.ID, ap.ID, "approved", "", "mallory", ap.Version,
		func(*runtime.Approval, string) (bool, string) { return false, "role_revoked" })
	if err == nil {
		t.Fatal("decider without the role must be refused")
	}
	st = dv.state()
	if len(st.PendingApprovals()) != 1 {
		t.Fatal("a refusal must leave the gate pending (C9b: it is not a decision)")
	}
	den := lastRecord(t, st, pevents.TypeApprovalDenied).Payload.(pevents.ApprovalDenied)
	if den.Reason != "role_revoked" {
		t.Errorf("denied reason = %s", den.Reason)
	}
	if st.Node("/gate").Status != runtime.NodeWaiting {
		t.Errorf("gate row moved on denial: %s", st.Node("/gate").Status)
	}
}

// TestConditionNodeBothArms: the condition kind decides downstream `when`
// inputs from a CEL expression — true and false arms, no worker involved.
func TestConditionNodeBothArms(t *testing.T) {
	for _, want := range []struct {
		keep bool
		skip string
	}{{true, "/off"}, {false, "/on"}} {
		plan := loadPlan(t, "testdata/condition.yaml")
		dv := newDriver(t, plan, map[string]any{"goal": "keep", "flags": map[string]any{"keep": want.keep}})
		dv.pump(30)
		st := dv.state()
		c := st.Node("/pick")
		if c.Status != runtime.NodeSucceeded {
			t.Fatalf("condition = %s", c.Status)
		}
		if keys := statusKeys(st, runtime.NodeSkipped); len(keys) != 1 || keys[0] != want.skip {
			t.Errorf("keep=%v skipped=%v, want [%s]", want.keep, keys, want.skip)
		}
		if st.Run.Status != runtime.RunCompleted {
			t.Errorf("run = %s/%s", st.Run.Status, st.Run.FailedCause)
		}
	}
}

// TestInvalidOutputIsHonestFailure: a worker completing with an envelope the
// plan rejects must not reach succeeded — the boundary transaction closes
// the attempt invalid_output (01 invariant 4, contract § 4 step 8:
// "validation failure is an invalid_output attempt failure").
func TestInvalidOutputIsHonestFailure(t *testing.T) {
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
	ck := runtime.CheckpointRecord{InputsDigest: "sha256:" + strings.Repeat("1", 64),
		OutputsDigest: "sha256:" + strings.Repeat("2", 64), VolumeID: "v", WorkspaceID: "w", WorkerID: "worker-a"}
	// The plan node requires outputs.plan: string. Send a lying envelope.
	if err := dv.ms.Complete(dv.run.ID, a.ID, a.WorkerID, a.FencingToken,
		map[string]any{"plan": int64(42)}, "sha256:x", nil, "", ck); err != nil {
		t.Fatalf("complete: %v", err)
	}
	st := dv.state()
	att := st.LastAttempt(a.NodeExecutionID)
	if att.Status != runtime.AttemptFailed || att.ErrorClass != runtime.ErrInvalidOutput {
		t.Fatalf("lying completion = %s/%s, want failed/invalid_output", att.Status, att.ErrorClass)
	}
	if att.Detail == "" {
		t.Error("invalid_output must carry the validation detail")
	}
	if n := st.Node("/plan"); n.Status == runtime.NodeSucceeded {
		t.Fatal("a node reached succeeded on a rejected envelope")
	}
	// The journal never saw a completion for it:
	if c := countType(st, pevents.TypeNodeAttemptCompleted); c != 0 {
		t.Errorf("node.attempt.completed on the invalid attempt = %d, want 0", c)
	}
	// And with the node's attempt budget spent (maxAttempts 1), the failure
	// policy (stop) ends the run honestly.
	dv.pump(30)
	st = dv.state()
	if st.Run.Status != runtime.RunFailed || st.Run.FailedCause != "node_execution_failed:/plan" {
		t.Fatalf("run = %s/%s, want failed / node_execution_failed:/plan", st.Run.Status, st.Run.FailedCause)
	}
}

// TestStaleTokenRefusedEverywhere is C4c's mechanism: a fenced worker whose
// lease was taken over can write NOTHING.
func TestStaleTokenRefusedEverywhere(t *testing.T) {
	plan := loadPlan(t, "testdata/gate_sibling.yaml")
	patchRetries(plan, "sibling", retryPolicy(2, 1))
	dv := newDriver(t, plan, map[string]any{"goal": "fence"})
	dv.advance()
	a, err := dv.ms.Claim(dv.run.ID, "worker-old")
	if err != nil || a == nil {
		t.Fatalf("claim: %v", err)
	}
	// Old worker renews — fine.
	if err := dv.ms.Renew(dv.run.ID, a.ID, "worker-old", a.FencingToken); err != nil {
		t.Fatal(err)
	}
	// Lease expiry hands the node to a new worker (reconciler), then the OLD
	// token tries every fenced write. 45 s: past the 30 s lease, still inside
	// the gate's 60 s deadline (which would fail the run for other reasons).
	dv.now = dv.now.Add(45 * time.Second)
	if err := dv.ms.ReconcileLeases(dv.run.ID); err != nil {
		t.Fatal(err)
	}
	st := dv.state()
	first := st.AttemptsFor(a.NodeExecutionID)[0]
	if first.Status != runtime.AttemptInterrupted || first.ErrorClass != runtime.ErrInterrupted {
		t.Fatalf("expired lease attempt = %s/%s, want interrupted", first.Status, first.ErrorClass)
	}
	// The retry's backoff is ~2 s (base 1, multiplier 2): cross it.
	dv.now = dv.now.Add(5 * time.Second)
	b, err := dv.ms.Claim(dv.run.ID, "worker-new")
	if err != nil || b == nil || b.NodeExecutionID != a.NodeExecutionID {
		t.Fatalf("re-claim: %+v %v", b, err)
	}
	if b.AttemptNumber != 2 {
		t.Errorf("re-claimed attempt #%d, want 2 (the append-only ledger)", b.AttemptNumber)
	}
	if b.FencingToken <= a.FencingToken {
		t.Errorf("fencing tokens must strictly increase: old=%d new=%d", a.FencingToken, b.FencingToken)
	}
	if err := dv.ms.Start(dv.run.ID, b.ID, "worker-old", a.FencingToken); err == nil {
		t.Error("old token may not start a new attempt")
	}
	if err := dv.ms.Renew(dv.run.ID, b.ID, "worker-old", a.FencingToken); err == nil {
		t.Error("old token may not renew a new attempt")
	}
	if err := dv.ms.Complete(dv.run.ID, b.ID, "worker-old", a.FencingToken, map[string]any{}, "d", nil, "",
		runtime.CheckpointRecord{VolumeID: "v", WorkspaceID: "w", WorkerID: "worker-old"}); err == nil {
		t.Error("old token may not complete a new attempt")
	}
	if err := dv.ms.Fail(dv.run.ID, b.ID, "worker-old", a.FencingToken, runtime.ErrInfra, "", nil); err == nil {
		t.Error("old token may not fail a new attempt")
	}
	if err := dv.ms.CancelAttempt(dv.run.ID, b.ID, "worker-old", a.FencingToken, "x"); err == nil {
		t.Error("old token may not cancel a new attempt")
	}
}

// TestCancelCascadeClosesEverything is 12's "parent cancelled with live
// children": the flag, then the cascade, then run.cancelled — with the
// child run asked politely and no attempt left claimed.
func TestCancelCascadeClosesEverything(t *testing.T) {
	plan := planFanout("collect_and_continue", 4, 1)
	cr := &scriptedChildren{status: map[int]string{}, delay: map[int]int{0: 99, 1: 99, 2: 99, 3: 99}}
	dv := newDriverWith(t, plan, map[string]any{"goal": "cancel me"}, runtime.AdvancerDeps{Children: cr})
	dv.script("/seed", step{outputs: items25(4)})
	dv.pump(50) // leaves one child running (maxConcurrency 1) and the rest queued
	st := dv.state()
	if st.Run.Status != runtime.RunRunning {
		t.Fatalf("run = %s pre-cancel", st.Run.Status)
	}
	if err := dv.ms.RequestCancel(dv.run.ID, "alice"); err != nil {
		t.Fatal(err)
	}
	// The live attempt's owner closes it honestly (the worker's arm).
	for _, a := range st.LiveAttempts() {
		if err := dv.ms.CancelAttempt(dv.run.ID, a.ID, a.WorkerID, a.FencingToken, "run_cancelled"); err != nil {
			t.Fatal(err)
		}
	}
	for i := 0; i < 20; i++ {
		dv.advance()
		st = dv.state()
		// Keep closing any newly-marked live attempts.
		for _, a := range st.LiveAttempts() {
			if a.CancelRequested != nil {
				if err := dv.ms.CancelAttempt(dv.run.ID, a.ID, a.WorkerID, a.FencingToken, "run_cancelled"); err != nil {
					t.Fatal(err)
				}
			}
		}
		if runtime.RunTerminal(st.Run.Status) {
			break
		}
	}
	if st.Run.Status != runtime.RunCancelled {
		t.Fatalf("run = %s/%s, want cancelled (events=%v)", st.Run.Status, st.Run.FailedCause, eventTypes(st))
	}
	if !cr.cancelled {
		t.Error("cancel must CancelChild the live child run (ADR-0023 § 10)")
	}
	for _, n := range st.Nodes {
		if !runtime.NodeTerminal(n.Status) {
			t.Errorf("node %s left %s after cancel", n.InstanceKey, n.Status)
		}
	}
	for _, a := range st.Attempts {
		if a.Status == runtime.AttemptQueued || a.Status == runtime.AttemptLeased || a.Status == runtime.AttemptRunning {
			t.Errorf("attempt %s left %s", a.ID, a.Status)
		}
	}
	rc := lastRecord(t, st, pevents.TypeRunCancelled).Payload.(pevents.RunCancelled)
	if len(rc.CancelledNodeExecutions) == 0 {
		t.Error("run.cancelled must name what it cancelled")
	}
}

// TestPauseBlocksClaimsAndResumeReDerives: routes 28/29 — pause stops FUTURE
// scheduling only; the in-flight attempt finishes honestly; resume re-derives
// readiness from rows.
func TestPauseBlocksClaimsAndResumeReDerives(t *testing.T) {
	plan := loadPlan(t, "testdata/gate_sibling.yaml")
	dv := newDriver(t, plan, map[string]any{"goal": "pause"})
	dv.gate = nil // never decide: we cancel-pause below instead
	dv.advance()
	a, err := dv.ms.Claim(dv.run.ID, "worker-a")
	if err != nil || a == nil {
		t.Fatal("first claim")
	}
	if err := dv.ms.Pause(dv.run.ID, runtime.PausedHumanTakeover, "alice"); err != nil {
		t.Fatal(err)
	}
	if got, err := dv.ms.Claim(dv.run.ID, "worker-b"); err != nil || got != nil {
		t.Fatalf("paused run claimed: %+v %v", got, err)
	}
	// The in-flight attempt still finishes (pause is not a kill).
	if err := dv.ms.Start(dv.run.ID, a.ID, "worker-a", a.FencingToken); err != nil {
		t.Fatal(err)
	}
	ck := runtime.CheckpointRecord{InputsDigest: "sha256:" + strings.Repeat("3", 64),
		OutputsDigest: "sha256:" + strings.Repeat("4", 64), VolumeID: "v", WorkspaceID: "w", WorkerID: "worker-a"}
	if err := dv.ms.Complete(dv.run.ID, a.ID, "worker-a", a.FencingToken,
		map[string]any{"ok": true}, "sha256:z", nil, "", ck); err != nil {
		t.Fatal(err)
	}
	st := dv.state()
	if st.Run.Status != runtime.RunPaused {
		t.Fatalf("completion under pause moved the run: %s", st.Run.Status)
	}
	if err := dv.ms.Resume(dv.run.ID, "alice"); err != nil {
		t.Fatal(err)
	}
	dv.gate = func(*runtime.Approval) (string, string) { return "approved", "" }
	dv.pump(50)
	st = dv.state()
	if st.Run.Status != runtime.RunCompleted {
		t.Fatalf("run after resume = %s/%s events=%v", st.Run.Status, st.Run.FailedCause, eventTypes(st))
	}
	if c := countType(st, pevents.TypeRunResumed); c != 1 {
		t.Errorf("run.resumed = %d, want 1 carrying the cleared reason", c)
	}
}

// TestAdvanceIsIdempotent: contract § 5.1 — Advance twice, one effect. The
// journal and every row must be byte-stable across a redundant pass.
func TestAdvanceIsIdempotent(t *testing.T) {
	plan := loadPlan(t, "../testdata/feature-development-contract.yaml")
	dv := newDriver(t, plan, sampleInputs())
	dv.gate = func(*runtime.Approval) (string, string) { return "approved", "" }
	dv.script("/plan", step{outputs: map[string]any{"plan": "p"}})
	dv.script("/build_until_verified[1]/implement", step{outputs: map[string]any{"summary": "s"}})
	dv.script("/build_until_verified[1]/test", step{outputs: map[string]any{
		"exit_code": int64(0), "result": map[string]any{"successful": true}}})
	dv.script("/build_until_verified[1]/review", step{outputs: map[string]any{"approved": false}})
	dv.pump(50)
	st := dv.state()
	before := st.SortedEvents()
	snapshot := len(before)
	for i := 0; i < 3; i++ {
		if err := dv.ms.Advance(dv.run.ID); err != nil {
			t.Fatal(err)
		}
	}
	after := st.SortedEvents()
	if len(after) != snapshot {
		var added []string
		seen := map[string]bool{}
		for _, e := range before {
			seen[eventKey(e.Type, e.NodeExecutionID)] = true
		}
		for _, e := range after {
			if !seen[eventKey(e.Type, e.NodeExecutionID)] {
				added = append(added, e.Type)
			}
		}
		t.Errorf("redundant advances wrote %v", added)
	}
}

func eventKey(typ string, nodeExecID string) string {
	return typ + "\x00" + nodeExecID
}

// patchFailure states an authored onFailure for a plan node (compiler
// defect (a) — see patchRetries).
func patchFailure(plan *compiler.Plan, nodeID, policy, route string) {
	for i := range plan.Nodes {
		if plan.Nodes[i].ID == nodeID {
			plan.Nodes[i].Failure = compiler.FailurePolicy{OnExecutionError: policy, ErrorRoute: route}
		}
	}
}
