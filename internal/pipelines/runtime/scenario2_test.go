package runtime_test

import (
	"context"
	"fmt"
	"strings"
	"testing"

	pevents "github.com/dbirks/communication/internal/pipelines/events"
	"github.com/dbirks/communication/internal/pipelines/runtime"
)

// TestSampleLoopBoundExhausted is 12 case 7 through the contract sample: the
// reviewer never approves, the loop dies at its declared bound, and every
// iteration's evidence survives.
func TestSampleLoopBoundExhausted(t *testing.T) {
	plan := loadPlan(t, "../testdata/feature-development-contract.yaml")
	dv := newDriver(t, plan, sampleInputs())
	dv.gate = func(*runtime.Approval) (string, string) { return "approved", "" }
	dv.script("/plan", step{outputs: map[string]any{"plan": "do it"}})
	// Every iteration: honest business fails (the loop's exit predicate can
	// never read true), never an execution error.
	for i := 1; i <= 4; i++ {
		p := fmt.Sprintf("/build_until_verified[%d]", i)
		dv.script(p+"/implement", step{outputs: map[string]any{"summary": "attempt"}})
		dv.script(p+"/test", step{outputs: map[string]any{
			"exit_code": int64(1), "result": map[string]any{"successful": false}}})
		dv.script(p+"/review", step{
			outputs: map[string]any{"approved": false, "evidence": fmt.Sprintf("still red #%d", i)},
			outcome: "failed"})
	}
	dv.pump(200)
	st := dv.state()
	// Contract § 7.1 C7a reads the cause off `runs.failed_cause`, and line 1137
	// names it `until_exhausted`: the exhaustion is the advancer's own verdict,
	// so it names the run instead of being masked as an execution error (the
	// live gate's C7a FAIL: 'node_execution_failed:/build_until_verified').
	if st.Run.Status != runtime.RunFailed || st.Run.FailedCause != "until_exhausted" {
		t.Fatalf("run = %s/%s, want failed / until_exhausted", st.Run.Status, st.Run.FailedCause)
	}
	rf := lastPayload(t, st, pevents.TypeRunFailed)
	if ev, _ := rf["evidence_artifacts"].([]any); len(ev) == 0 {
		t.Errorf("run.failed evidence_artifacts empty, want the per-iteration pointers (§ 7.1 C7b)")
	}
	body := 0
	for _, n := range st.Nodes {
		if strings.HasPrefix(n.InstanceKey, "/build_until_verified[") {
			body++
		}
	}
	if body != 12 {
		t.Errorf("body rows = %d, want 12 (4 iterations × 3 nodes: no infinite loop, the bound is structural)", body)
	}
	if c := countType(st, pevents.TypeNodeScopeIteration); c != 4 {
		t.Errorf("node.scope.iteration = %d, want 4 (case 7's per-iteration evidence)", c)
	}
	sc := lastRecord(t, st, pevents.TypeNodeScopeFailed)
	pl := sc.Payload.(pevents.NodeScopeFailed)
	if pl.FailedCause != "until_exhausted" {
		t.Errorf("scope failed_cause = %s, want until_exhausted", pl.FailedCause)
	}
	if len(pl.Evidence) != 4 {
		t.Errorf("scope evidence = %d entries, want 4 (the full evidence preserved)", len(pl.Evidence))
	}
	// The exhausted run must carry NO success evidence anywhere.
	if c := countType(st, pevents.TypeRunCompleted); c != 0 {
		t.Errorf("run.completed on an exhausted loop: %d", c)
	}
}

// TestPreviousRootIsPriorResultBindings guards 03's carryForward through the
// `previous`/`iteration` roots (contract § 9.1 rows 17-18): iteration 1 sees
// an EMPTY previous (the guarded expression must not fault), iteration 2
// passes because it reads iteration 1's resultBindings.
func TestPreviousRootIsPriorResultBindings(t *testing.T) {
	plan := loadPlan(t, "testdata/loop_prev.yaml")
	dv := newDriver(t, plan, map[string]any{"goal": "loop"})
	dv.script("/build[1]/review", step{outputs: map[string]any{"approved": false}})
	dv.script("/build[2]/review", step{outputs: map[string]any{"approved": true}})
	dv.script("/build[3]/review", step{outputs: map[string]any{"approved": false}})
	dv.pump(50)
	st := dv.state()
	if st.Run.Status != runtime.RunCompleted {
		t.Fatalf("run = %s/%s events=%v", st.Run.Status, st.Run.FailedCause, eventTypes(st))
	}
	rb := lastPayload(t, st, pevents.TypeRunCompleted)["result_bindings"].(map[string]any)
	// § 9.1 row 17 read literally: previous is the PRIOR iteration's
	// resultBindings everywhere, including the scope's own passWhen. So an
	// approval landing in iteration 2 exits the loop when iteration 3's
	// predicate reads it — the extra iteration is the documented cost of
	// that reading, and the sample sidesteps it by reading
	// nodes.review.outputs directly (which is why its passWhen does).
	if toInt(rb["iterations"]) != 3 {
		t.Errorf("iterations = %v, want 3 (exit reads iteration 2's bindings at iteration 3's predicate)", rb["iterations"])
	}
}

// TestSampleKilledAttemptRetriesFromCheckpoint is 12 case 5 / contract C5:
// the worker disappears mid-Implement; the reconciler writes the honest
// interrupted; the retry is a NEW attempt carrying retry_context computed
// from the last durable checkpoint; already-succeeded nodes gain no rows,
// and the run completes.
func TestSampleKilledAttemptRetriesFromCheckpoint(t *testing.T) {
	plan := loadPlan(t, "../testdata/feature-development-contract.yaml")
	dv := newDriver(t, plan, sampleInputs())
	dv.gate = func(*runtime.Approval) (string, string) { return "approved", "" }
	dv.script("/plan", step{outputs: map[string]any{"plan": "the plan"}})
	dv.script("/build_until_verified[1]/implement",
		step{interrupt: true}, // the docker-kill arm, attempt 1
		step{outputs: map[string]any{"summary": "second attempt finishes the edit"}})
	dv.script("/build_until_verified[1]/test", step{outputs: map[string]any{
		"exit_code": int64(0), "result": map[string]any{"successful": true}}})
	dv.script("/build_until_verified[1]/review", step{
		outputs: map[string]any{"approved": true, "evidence": "clean"}})

	dv.pump(100)
	st := dv.state()
	if st.Run.Status != runtime.RunCompleted {
		t.Fatalf("run = %s/%s events=%v", st.Run.Status, st.Run.FailedCause, eventTypes(st))
	}
	im := st.Node("/build_until_verified[1]/implement")
	attempts := st.AttemptsFor(im.ID)
	if len(attempts) != 2 {
		t.Fatalf("attempt rows = %d, want 2 (retries APPEND, never overwrite — 01)", len(attempts))
	}
	if attempts[0].Status != runtime.AttemptInterrupted || attempts[0].ErrorClass != runtime.ErrInterrupted {
		t.Errorf("attempt 1 = %s/%s, want interrupted", attempts[0].Status, attempts[0].ErrorClass)
	}
	if attempts[1].Status != runtime.AttemptSucceeded {
		t.Errorf("attempt 2 = %s, want succeeded", attempts[1].Status)
	}
	rc := attempts[1].RetryContext
	if rc["attempt"] != int64(1) || rc["error_class"] != runtime.ErrInterrupted {
		t.Errorf("retry_context = %v, want {attempt:1 error_class:interrupted …}", rc)
	}
	// continue_workspace facts: the head commit came from the last durable
	// checkpoint (the /plan boundary), not from a memory.
	if rc["head_commit"] != "head-/plan" {
		t.Errorf("retry_context head_commit = %v, want the checkpointed head", rc["head_commit"])
	}
	if rc["modified_path_count"] == nil {
		t.Error("retry_context must carry modified_path_count (C5e)")
	}
	if c := countType(st, pevents.TypeNodeAttemptRetryScheduled); c != 1 {
		t.Errorf("node.attempt.retry_scheduled = %d, want 1 (the persisted-backoff half of case 5)", c)
	}
	sched := lastPayload(t, st, pevents.TypeNodeAttemptRetryScheduled)
	if sched["scheduled_at"].(string) == "" {
		t.Error("the backoff landing time must be persisted on the retry_scheduled event")
	}
	// No new rows for anything that had already succeeded, and the key set is
	// exactly one iteration.
	if _, ok := lookupNode(st, "/build_until_verified[2]/implement"); ok {
		t.Error("a retried attempt must not start a fresh iteration")
	}
	// And no run.checkpoint_restored: this was continue_workspace (the
	// default), the sentence the report must repeat (D5).
	if c := countType(st, pevents.TypeRunCheckpointRestored); c != 0 {
		t.Errorf("run.checkpoint_restored = %d, want 0 under continue_workspace", c)
	}
}

// TestSampleApprovalRejectedIsBusinessOutcome is C9e through the runtime: a
// rejection is a business outcome (succeeded, outcome rejected), dependants
// skip via their `when`, the run completes — and only a TIMEOUT is the
// execution-side failure (asserted in TestGateTimeout).
func TestSampleApprovalRejectedIsBusinessOutcome(t *testing.T) {
	plan := loadPlan(t, "testdata/gate_sibling.yaml")
	dv := newDriver(t, plan, map[string]any{"goal": "ship"})
	dv.gate = func(*runtime.Approval) (string, string) { return "rejected", "not this way" }
	dv.script("/sibling", step{outputs: map[string]any{"ok": true}})
	dv.pump(50)
	st := dv.state()
	g := st.Node("/gate")
	if g.Status != runtime.NodeSucceeded || g.Outcome != "rejected" {
		t.Fatalf("gate = %s/%s, want succeeded/rejected (a rejection is not an execution failure)", g.Status, g.Outcome)
	}
	a := st.Node("/after")
	if a.Status != runtime.NodeSkipped || a.SkipReason != "condition_default" {
		t.Errorf("after = %s/%s, want skipped/condition_default", a.Status, a.SkipReason)
	}
	if st.Run.Status != runtime.RunCompleted {
		t.Fatalf("run = %s/%s", st.Run.Status, st.Run.FailedCause)
	}
	rb := lastPayload(t, st, pevents.TypeRunCompleted)["result_bindings"].(map[string]any)
	if rb["gate_decision"] != "rejected" {
		t.Errorf("run outputs gate_decision = %v", rb["gate_decision"])
	}
	// The gate held no worker and no lease while it waited (§ 5.3).
	for _, ap := range st.Approvals {
		if n := nodeByExec(st, ap.NodeExecutionID); n != nil {
			for _, a := range st.AttemptsFor(n.ID) {
				t.Errorf("gate node produced attempt %s — durable gates hold no worker (ADR-0023 § 9)", a.ID)
			}
		}
	}
}

// TestFanoutTwentyFiveChildrenOneFails is 12 case 8: for_each over 25
// items → pipeline.invoke child runs, maxConcurrency 3 measured never
// exceeded, child number 3 fails, its 24 siblings are preserved and readable.
func TestFanoutTwentyFiveChildrenOneFails(t *testing.T) {
	plan := loadPlan(t, "testdata/fanout_collect.yaml")
	cr := &scriptedChildren{status: map[int]string{}}
	for i := 0; i < 25; i++ {
		s := runtime.RunCompleted
		if i == 2 { // item NUMBER 3 fails (indices are 0-based, C8's 13th item twin)
			s = runtime.RunFailed
		}
		cr.status[i] = s
	}
	dv := newDriverWith(t, plan, map[string]any{"goal": "issues"}, runtime.AdvancerDeps{Children: cr})
	dv.script("/seed", step{outputs: worklist(25)})
	dv.pump(300)
	st := dv.state()
	if st.Run.Status != runtime.RunCompleted {
		t.Fatalf("run = %s/%s events=%d", st.Run.Status, st.Run.FailedCause, len(st.Events))
	}
	// 25 child executions, each a real invocation row.
	if c := len(st.Invocations); c != 25 {
		t.Errorf("invocations = %d, want 25", c)
	}
	if got := toInt(cr.inputs[2]); got != 3 {
		t.Errorf("child for index 2 received issue=%v, want 3 (the item root reached the invoke inputs)", cr.inputs[2])
	}
	invoked := 0
	for _, n := range st.Nodes {
		if strings.HasPrefix(n.InstanceKey, "/fan_out[") && strings.HasSuffix(n.InstanceKey, "/invoke") {
			invoked++
		}
	}
	if invoked != 25 {
		t.Errorf("invoke rows = %d, want 25 (keys derived per ADR-0023 § 1)", invoked)
	}
	// The measured bound (C8c): never more than 3 indices unsettled.
	if cr.maxActive > 3 {
		t.Errorf("observed concurrent children = %d, want ≤ 3", cr.maxActive)
	}
	fo := st.Node("/fan_out")
	out := fo.Outputs.(map[string]any)
	children := out["children"].([]any)
	if len(children) != 25 {
		t.Fatalf("outputs.children = %d, want 25", len(children))
	}
	succ, failed := 0, 0
	for _, ch := range children {
		m := ch.(map[string]any)
		if m["status"] == runtime.NodeSucceeded {
			succ++
			if m["child_run_id"] == nil || m["child_run_id"] == "" {
				t.Errorf("child %v lacks its child_run_id", m["index"])
			}
		} else {
			failed++
			if toInt(m["index"]) != 2 { // item number 3 ⇒ index 2
				t.Errorf("unexpected failing index %v", m["index"])
			}
		}
		if m["child_run_id"] == nil || m["child_run_id"] == "" {
			t.Errorf("child %v lacks its child_run_id", m["index"])
		}
	}
	if succ != 24 || failed != 1 {
		t.Errorf("children: %d succeeded %d failed, want 24/1 (siblings preserved — case 8)", succ, failed)
	}
	// Every child was created at depth 1 in the parent's project.
	for _, iv := range st.Invocations {
		if iv.Depth != 1 || iv.ChildProjectID != st.Run.ProjectID {
			t.Errorf("invocation depth/project = %d/%s", iv.Depth, iv.ChildProjectID)
		}
	}
}

// TestFanoutStopPreservesCompletedSiblings is case 8's stop arm: queued
// siblings cancel, completed ones keep their results, the scope fails.
func TestFanoutStopPreservesCompletedSiblings(t *testing.T) {
	plan := loadPlan(t, "testdata/fanout_stop.yaml")
	// Index 0 fails immediately; index 1 is still running when the stop is
	// observed (it goes terminal only on its third poll), so the cancelled
	// sibling is a LIVE child — and 2..4 were never started.
	cr := &scriptedChildren{status: map[int]string{0: runtime.RunFailed}, delay: map[int]int{1: 3}}
	dv := newDriverWith(t, plan, map[string]any{"goal": "stop me"}, runtime.AdvancerDeps{Children: cr})
	dv.script("/seed", step{outputs: worklist(5)})
	dv.pump(100)
	st := dv.state()
	if st.Run.Status != runtime.RunFailed {
		t.Fatalf("run = %s, want failed (scope failed under stop)", st.Run.Status)
	}
	if st.Run.FailedCause != "node_execution_failed:/fan_out" {
		t.Errorf("failed_cause = %s", st.Run.FailedCause)
	}
	cancelled := statusKeys(st, runtime.NodeCancelled)
	succeeded := statusKeys(st, runtime.NodeSucceeded)
	_ = succeeded
	// The completed sibling (index 1, which finishes while the stop is
	// already requested but before cancel reaches it) keeps its results —
	// preserved, not rewritten (C8e).
	_ = succeeded
	// The queued siblings (2..4) were never DISPATCHED, and now read as
	// cancelled rather than as nothing at all (C8e — see
	// TestFanoutStopJournalsQueuedSiblingsCancelled).
	for _, key := range []string{"/fan_out[2]/invoke", "/fan_out[4]/invoke"} {
		queued, ok := lookupNode(st, key)
		if !ok {
			t.Errorf("%s: stop must leave a cancelled row for a queued sibling", key)
			continue
		}
		if queued.Status != runtime.NodeCancelled {
			t.Errorf("%s = %s, want cancelled", key, queued.Status)
		}
		if n := len(st.AttemptsFor(queued.ID)); n != 0 {
			t.Errorf("%s booked %d attempts, want 0 (a queued sibling is cancelled before dispatch)", key, n)
		}
		if indexOfKey(cr.created, key) >= 0 {
			t.Errorf("%s booked a child run (%v), want no child at all", key, cr.created)
		}
	}
	n1 := st.Node("/fan_out[1]/invoke")
	if n1 == nil || n1.Status != runtime.NodeCancelled {
		t.Fatalf("live sibling at stop time = %+v, want cancelled", n1)
	}
	cancels := 0
	for _, e := range st.Events {
		if e.Type == pevents.TypeNodeExecutionCancelled {
			pl := e.Payload.(pevents.NodeExecutionCancelled)
			if pl.Reason != "on_child_failure_stop" {
				t.Errorf("cancel reason = %s, want on_child_failure_stop", pl.Reason)
			}
			cancels++
		}
	}
	if cancels == 0 {
		t.Error("C8e: cancelled siblings need node.execution_cancelled rows")
	}
	// The child itself received the cascade.
	if !cr.cancelled {
		t.Error("C8g: cancelling a waiting invoke must CancelChild the live child run")
	}
	if indexOfKey(cancelled, "/fan_out[1]/invoke") < 0 {
		t.Errorf("cancelled set = %v", cancelled)
	}
	sf := lastRecord(t, st, pevents.TypeNodeScopeFailed)
	if pl := sf.Payload.(pevents.NodeScopeFailed); pl.FailedCause != "child_failed" {
		t.Errorf("scope failed_cause = %s, want child_failed", pl.FailedCause)
	}
}

// TestFanoutStopJournalsQueuedSiblingsCancelled is C8e's live shape (lab
// live10): with maxConcurrency 2 the whole in-flight window settles in the
// same pass that records the failing child, so NOT ONE started sibling is
// still open when the stop fires. Everything the contract calls a "queued
// sibling" is an index the window never reached — and § 7 C8e promises those
// siblings cancel via node.execution_cancelled{reason:'on_child_failure_stop'}.
// Before the fix the engine simply never started them, left no row, and the
// live gate counted 0 such journal rows for a run that had stopped 10 siblings.
func TestFanoutStopJournalsQueuedSiblingsCancelled(t *testing.T) {
	plan := loadPlan(t, "testdata/fanout_stop.yaml")
	// Index 0 fails and index 1 completes with no delay: at the pass that
	// records index 0's failure the started set is fully settled, so the ONLY
	// siblings left to cancel are the queued ones (2, 3, 4).
	cr := &scriptedChildren{status: map[int]string{0: runtime.RunFailed}}
	dv := newDriverWith(t, plan, map[string]any{"goal": "stop me"}, runtime.AdvancerDeps{Children: cr})
	dv.script("/seed", step{outputs: worklist(5)})
	dv.pump(100)
	st := dv.state()

	if st.Run.Status != runtime.RunFailed {
		t.Fatalf("run = %s, want failed (scope failed under stop)", st.Run.Status)
	}
	sf := lastRecord(t, st, pevents.TypeNodeScopeFailed).Payload.(pevents.NodeScopeFailed)
	if sf.FailedCause != "child_failed" {
		t.Errorf("scope failed_cause = %s, want child_failed", sf.FailedCause)
	}
	// The completed sibling is PRESERVED, not rewritten by the stop.
	if n := st.Node("/fan_out[1]/invoke"); n == nil || n.Status != runtime.NodeSucceeded {
		t.Errorf("completed sibling = %+v, want succeeded", n)
	}
	// Every queued sibling is a cancelled row naming the stop reason, and the
	// journal says so once each (C8e's cancelled=None -> cancelled=3).
	want := []string{"/fan_out[2]/invoke", "/fan_out[3]/invoke", "/fan_out[4]/invoke"}
	seen := map[string]int{}
	for _, e := range st.Events {
		if e.Type != pevents.TypeNodeExecutionCancelled {
			continue
		}
		pl := e.Payload.(pevents.NodeExecutionCancelled)
		if pl.Reason != "on_child_failure_stop" {
			continue
		}
		seen[pl.NodeInstanceKey]++
	}
	for _, key := range want {
		if seen[key] != 1 {
			t.Errorf("node.execution_cancelled{reason:on_child_failure_stop} for %s = %d, want exactly 1", key, seen[key])
		}
		if n := st.Node(key); n == nil || n.Status != runtime.NodeCancelled || n.CancelReason != "on_child_failure_stop" {
			t.Errorf("queued sibling %s = %+v, want cancelled/on_child_failure_stop", key, n)
		}
	}
	// Queued siblings are cancelled BEFORE dispatch: no attempt, no child run.
	for _, key := range want {
		n := st.Node(key)
		if n == nil {
			continue
		}
		if got := len(st.AttemptsFor(n.ID)); got != 0 {
			t.Errorf("%s booked %d attempts, want 0", key, got)
		}
		if indexOfKey(cr.created, key) >= 0 {
			t.Errorf("%s booked a child run (%v), want none", key, cr.created)
		}
	}
	// The stop still honours the fan-out bound: materializing queued siblings
	// books no child and opens no slot.
	if cr.maxActive > 2 {
		t.Errorf("peak live children = %d, want <= maxConcurrency 2", cr.maxActive)
	}
}

// TestFanoutZeroItems is 03's zero-item edge case, asserted as a test and not
// a comment (ADR-0023 § 8): succeeded with items: 0 and ONE scope.completed.
func TestFanoutZeroItems(t *testing.T) {
	plan := loadPlan(t, "testdata/fanout_stop.yaml")
	cr := &scriptedChildren{status: map[int]string{}}
	dv := newDriverWith(t, plan, map[string]any{"goal": "none"}, runtime.AdvancerDeps{Children: cr})
	dv.script("/seed", step{outputs: map[string]any{"worklist": []any{}}})
	dv.pump(50)
	st := dv.state()
	fo := st.Node("/fan_out")
	if fo.Status != runtime.NodeSucceeded {
		t.Fatalf("fan_out = %s", fo.Status)
	}
	if len(st.Nodes) != 2 {
		t.Errorf("rows = %d, want 2 (body unreached: no phantom executions)", len(st.Nodes))
	}
	sc := lastRecord(t, st, pevents.TypeNodeScopeCompleted).Payload.(pevents.NodeScopeCompleted)
	if sc.Items != 0 {
		t.Errorf("scope.completed items = %d, want the explicit 0", sc.Items)
	}
	if st.Run.Status != runtime.RunCompleted {
		t.Fatalf("run = %s/%s", st.Run.Status, st.Run.FailedCause)
	}
}

// ------------------------------------------------------------------ helpers

func indexOfKey(keys []string, want string) int {
	for i, k := range keys {
		if k == want {
			return i
		}
	}
	return -1
}

func lookupNode(st *runtime.State, key string) (*runtime.NodeExecution, bool) {
	n := st.Node(key)
	return n, n != nil
}

func nodeByExec(st *runtime.State, id string) *runtime.NodeExecution {
	for _, n := range st.Nodes {
		if n.ID == id {
			return n
		}
	}
	return nil
}

// worklist is a seed node's outputs: n items, numbered from 1, which is what
// the fan-out fixtures' `items` binding reads and what the invoke inputs assert
// (item number 3 is index 2).
func worklist(n int) map[string]any {
	list := make([]any, 0, n)
	for i := 1; i <= n; i++ {
		list = append(list, map[string]any{"number": int64(i)})
	}
	return map[string]any{"worklist": list}
}

// scriptedChildren is the ChildResolver the fan-out tests run against: every
// created child is immediately terminal with its scripted status. maxActive
// measures the highest simultaneously-live child count the advancer produced,
// which is C8c's "measured from the journal, not asserted from the schema".
type scriptedChildren struct {
	status    map[int]string
	live      map[string]int
	settled   map[string]bool
	inputs    map[int]any
	delay     map[int]int
	polls     map[string]int
	cancelled bool
	created   []string
	maxActive int
	active    int
}

func (c *scriptedChildren) CreateChild(_ context.Context, req runtime.ChildRequest) (runtime.ChildOutcome, error) {
	c.created = append(c.created, req.NodeInstanceKey)
	// The instance key carries the index: /fan_out[i]/invoke.
	idx := indexFromKey(req.NodeInstanceKey)
	if c.inputs == nil {
		c.inputs = map[int]any{}
	}
	c.inputs[idx] = req.Inputs["issue"]
	c.active++
	if c.active > c.maxActive {
		c.maxActive = c.active
	}
	id := fmt.Sprintf("child-%d", idx)
	if c.live == nil {
		c.live = map[string]int{}
		c.settled = map[string]bool{}
	}
	c.live[id] = idx
	// A script resolves nothing: the ids belong to a real host's pipeline
	// library, so the invocation row it represents is the host's booking.
	return runtime.ChildOutcome{ChildRunID: id}, nil
}

func (c *scriptedChildren) ChildStatus(_ context.Context, childRunID string) (string, string, error) {
	idx := c.live[childRunID]
	s, ok := c.status[idx]
	if !ok {
		s = runtime.RunCompleted
	}
	if c.polls == nil {
		c.polls = map[string]int{}
	}
	c.polls[childRunID]++
	if d, isDelayed := c.delay[idx]; isDelayed && c.polls[childRunID] <= d {
		return runtime.RunRunning, "", nil // still live
	}
	cause := ""
	if s == runtime.RunFailed {
		cause = "node_execution_failed:/work"
	}
	// A child stops counting as live exactly once, the first time a poll
	// observes it terminal.
	if s == runtime.RunCompleted || s == runtime.RunFailed {
		if !c.settled[childRunID] {
			c.settled[childRunID] = true
			c.active--
		}
	}
	return s, cause, nil
}

func (c *scriptedChildren) CancelChild(_ context.Context, childRunID, _ string) error {
	c.cancelled = true
	// The child reaches its terminal promptly; the next poll proves the
	// advancer treats a cancelled child as cancelled, not failed.
	c.status[c.live[childRunID]] = runtime.RunCancelled
	delete(c.settled, childRunID)
	return nil
}

func indexFromKey(key string) int {
	i := strings.Index(key, "[")
	j := strings.Index(key, "]")
	if i < 0 || j < 0 {
		return -1
	}
	var n int
	fmt.Sscanf(key[i+1:j], "%d", &n)
	return n
}
