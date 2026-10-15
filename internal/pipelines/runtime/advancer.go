package runtime

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"hash/fnv"
	"math"
	"strings"
	"time"

	"github.com/dbirks/communication/internal/pipelines/compiler"
	pevents "github.com/dbirks/communication/internal/pipelines/events"
)

// ChildResolver is how the control plane creates and polls child runs for
// pipeline.invoke (ADR-0023 § 10). The runtime owns the bookkeeping (the
// pipeline_invocations row, the waiting state, the cascade); the host owns
// actually starting a run, because that is an API-transaction act. The
// in-memory tests script this; the Postgres serve loop will implement it over
// the real runs table.
type ChildResolver interface {
	// CreateChild starts a child run and returns its id. It must be
	// idempotent per (parentRunID, nodeExecutionID): the advancer may retry
	// a pass that aborted.
	CreateChild(ctx context.Context, req ChildRequest) (childRunID string, err error)
	// ChildStatus reports the child run's current status (the run.status
	// enum) and its failed cause when failed.
	ChildStatus(ctx context.Context, childRunID string) (status string, failedCause string, err error)
	// CancelChild requests cancellation of a live child.
	CancelChild(ctx context.Context, childRunID string, reason string) error
}

// ChildRequest names what the host needs to start a child.
type ChildRequest struct {
	ParentRunID     string
	ParentProjectID string
	OrganizationID  string
	NodeExecutionID string
	NodeInstanceKey string
	Target          string
	Inputs          map[string]any
	Depth           int
	Priority        int
}

// AdvancerDeps wires the outside capabilities the advancer may ask for.
type AdvancerDeps struct {
	// Children may be nil; pipeline.invoke then fails honestly as infra
	// ("no child runner is wired") rather than hanging forever.
	Children ChildResolver
	// Context is carried into child calls; may be nil (context.TODO used).
	Context context.Context
}

// Advancer turns plan + rows into the next rows. It is one function deep:
// Advance applies contract § 5.1's loop until nothing changes, and every
// handler re-derives its decision from row state, so calling it twice has one
// effect (the idempotence claim § 8's integration row tests).
type Advancer struct {
	Prog *Program
	Deps AdvancerDeps
}

// Advance runs the advancer pass over st at time now. Errors here are bugs
// or impossible states (a row that violates its own machine); business
// outcomes — failed nodes, exhausted loops — are STATE, not errors.
func (adv *Advancer) Advance(st *State, now time.Time) error {
	ac := &advanceCtx{
		st:   st,
		prog: adv.Prog,
		deps: adv.Deps,
		now:  now,
	}
	ac.ev = Evaluator{Prog: adv.Prog, ST: st}
	if RunTerminal(st.Run.Status) || st.Run.Status == RunPaused {
		// Pause stops FUTURE scheduling only: in-flight attempts finish
		// honestly through the store's worker ops, not through here.
		return nil
	}
	if st.Run.Status == RunQueued {
		// queued → running once the run owns work. The real deployment's
		// worker writes run.started after the run workspace is ready
		// (contract § 4 step 3); the hermetic model has no workspace, so the
		// transition itself is what's modelled.
		if err := st.Run.MoveRun(RunRunning, "", "", now); err != nil {
			return err
		}
	}
	for pass := 0; pass < 64; pass++ {
		ac.changed = false
		if err := ac.pass(); err != nil {
			return err
		}
		if !ac.changed {
			return nil
		}
		if RunTerminal(st.Run.Status) {
			return nil
		}
	}
	return fmt.Errorf("runtime: advancer did not settle in 64 passes (state bug or pathological graph)")
}

type advanceCtx struct {
	st      *State
	prog    *Program
	ev      Evaluator
	deps    AdvancerDeps
	now     time.Time
	changed bool
}

func (ac *advanceCtx) pass() error {
	// 1. Cancellation cascade first: a cancelled run schedules nothing new.
	if ac.st.Run.CancelRequestedAt != nil && !RunTerminal(ac.st.Run.Status) {
		if err := ac.cascadeCancel(); err != nil {
			return err
		}
	}
	// 2. Approval deadlines (reconciler pass 2 shares this rule; the advancer
	// is idempotent, so both may run it).
	if err := ac.expireApprovals(); err != nil {
		return err
	}
	// 3. Ensure the root scope's rows exist, then advance the DAG.
	if err := ac.enterScope(ScopeRoot, nil, ScopeRoot); err != nil {
		return err
	}
	if err := ac.advanceScope(ScopeRoot, nil); err != nil {
		return err
	}
	// 4. Run outcome.
	return ac.settleRun()
}

// ------------------------------------------------------------------- scopes

// enterScope creates pending rows for a scope instance's declared nodes.
// declaredKey is the plan-side scope key ("/", "/build_until_verified/");
// instanceScopeKey is the runtime directory its rows are stamped with
// ("/build_until_verified[2]/") — the two differ exactly where ADR-0023 § 1's
// [i] suffixes live, and confusing them silently skips a body.
func (ac *advanceCtx) enterScope(declaredKey string, idx map[string]int, instanceScopeKey string) error {
	nodes := ac.prog.ScopeNodes(declaredKey)
	if len(nodes) == 0 {
		return nil
	}
	for _, pn := range nodes {
		key := buildInstanceKey(pn.Path, idx)
		if ac.st.Node(key) != nil {
			continue
		}
		if limit := ac.prog.plan.Policies.MaxNodeExecutions; limit > 0 && len(ac.st.Nodes) >= limit {
			// The loop/fan-out runaway guard (contract § 6).
			return ac.failRun("node_execution_budget_exceeded", "", key)
		}
		row := &NodeExecution{
			ID:           ac.st.NewID("ne"),
			RunID:        ac.st.Run.ID,
			NodeID:       pn.ID,
			Kind:         pn.Kind,
			InstanceKey:  key,
			ScopeKey:     instanceScopeKey,
			Location:     pn.ExecLocation,
			Status:       NodePending,
			DependsOn:    append([]string{}, pn.DependsOn...),
			AttemptLimit: max1(pn.Retry.MaxAttempts),
			ArtifactRefs: []any{},
			CreatedAt:    ac.now,
		}
		ac.st.Nodes = append(ac.st.Nodes, row)
		ac.st.Run.NodeExecutionCount++
		ac.changed = true
	}
	return nil
}

// advanceScope walks one scope instance in topological order, deciding
// readiness, skipping, dispatch and composites. Composite bodies recurse.
func (ac *advanceCtx) advanceScope(scopeKey string, idx map[string]int) error {
	for _, pn := range ac.prog.ScopeNodes(scopeKey) {
		row := ac.st.Node(buildInstanceKey(pn.Path, idx))
		if row == nil || NodeTerminal(row.Status) {
			continue
		}
		if row.Status == NodePending {
			if err := ac.decidePending(pn, row, scopeKey, idx); err != nil {
				return err
			}
		}
		if row.Status == NodeReady {
			if err := ac.dispatch(pn, row, scopeKey, idx); err != nil {
				return err
			}
		}
		if row.Status == NodeWaiting {
			if err := ac.pollWaiting(pn, row, scopeKey, idx); err != nil {
				return err
			}
		}
	}
	return nil
}

// envelopeFor materializes the CEL `nodes` root for one scope instance:
// every declared node gets an envelope, {status:'pending', outputs:{}} for the
// unscheduled (ADR-0022 § 3, contract § 5.1 step 3).
func (ac *advanceCtx) envelopeFor(scopeKey string, idx map[string]int) map[string]any {
	results := map[string]nodeResult{}
	for _, pn := range ac.prog.ScopeNodes(scopeKey) {
		nr := nodeResult{Status: NodePending, Outputs: map[string]any{}, ArtifactRefs: []any{}}
		if row := ac.st.Node(buildInstanceKey(pn.Path, idx)); row != nil {
			outs := row.Outputs
			if outs == nil {
				outs = map[string]any{}
			}
			nr = nodeResult{Status: row.Status, Outcome: row.Outcome, Outputs: outs, ArtifactRefs: nz(row.ArtifactRefs)}
		}
		results[pn.ID] = nr
	}
	return nodesRoot(results)
}

type nodeResult struct {
	Status       string
	Outcome      string
	Outputs      any
	ArtifactRefs []any
}

func nodesRoot(results map[string]nodeResult) map[string]any {
	out := make(map[string]any, len(results))
	for id, r := range results {
		outs := r.Outputs
		if outs == nil {
			outs = map[string]any{}
		}
		refs := r.ArtifactRefs
		if refs == nil {
			refs = []any{}
		}
		out[id] = map[string]any{
			"status":        r.Status,
			"outcome":       r.Outcome,
			"outputs":       outs,
			"artifact_refs": refs,
		}
	}
	return out
}

// varsFor assembles the activation for evaluations inside one scope instance.
func (ac *advanceCtx) varsFor(scopeKey string, idx map[string]int, state *ScopeState) map[string]any {
	inputs := ac.st.Run.Inputs
	if inputs == nil {
		inputs = map[string]any{}
	}
	vars := map[string]any{
		"nodes":  ac.envelopeFor(scopeKey, idx),
		"inputs": inputs,
		"run": map[string]any{
			"id":    ac.st.Run.ID,
			"depth": int64(ac.st.Run.Depth),
		},
	}
	if state != nil {
		switch state.Kind {
		case "until":
			prev := state.Previous
			if prev == nil {
				prev = map[string]any{}
			}
			vars["previous"] = prev
			vars["iteration"] = int64(state.Iteration)
		case "for_each":
			items := state.Items
			if items == nil {
				items = []any{}
			}
			vars["items"] = items
			if i, ok := idx[ac.prog.scopes[scopeKey].Owner]; ok && i < len(items) {
				vars["item"] = items[i]
			} else {
				vars["item"] = map[string]any{}
			}
		}
	}
	return vars
}

// ------------------------------------------------------------ node decision

// depState classifies one dependency edge for readiness (ADR-0023 § 5 step 2,
// with D6's failure-route exception).
func (ac *advanceCtx) depState(scopeKey string, idx map[string]int, dep string) (state string, row *NodeExecution) {
	dn, ok := ac.prog.nodes[scopeKey][dep]
	if !ok {
		return "pending", nil
	}
	drow := ac.st.Node(buildInstanceKey(dn.Path, idx))
	if drow == nil {
		return "pending", nil
	}
	switch drow.Status {
	case NodeSucceeded:
		return "succeeded", drow
	case NodeSkipped:
		return "skipped", drow
	case NodeFailed, NodeInterrupted, NodeCancelled:
		return "failed", drow
	}
	return "live", drow
}

func (ac *advanceCtx) decidePending(pn *compiler.Node, row *NodeExecution, scopeKey string, idx map[string]int) error {
	allSettled := true
	skip := false
	skipReason := "dependency_skipped"
	blocked := false
	for _, dep := range pn.DependsOn {
		stt, drow := ac.depState(scopeKey, idx, dep)
		switch stt {
		case "succeeded":
			// ok
		case "skipped":
			skip = true
		case "pending", "live":
			allSettled = false
		case "failed":
			dplan := ac.prog.nodes[scopeKey][dep]
			policy := dplan.Failure.OnExecutionError
			carrier := false
			if policy == "route" && dplan.Failure.ErrorRoute == pn.ID && drow != nil && drow.Status == NodeFailed {
				// D6: the error route is a readiness exception, not a graph
				// edge. Only the named route node may run off a failed dep.
				carrier = true
			}
			if carrier {
				continue
			}
			switch drow.Status {
			case NodeInterrupted, NodeCancelled:
				// The run is already failing/cancelling on that branch; this
				// node simply never becomes ready.
				blocked = true
			case NodeFailed:
				if policy == "stop" {
					if sc, ok := ac.prog.Scope(scopeKey); !ok || sc.Kind == "root" {
						return ac.failRun("node_execution_failed:"+drow.InstanceKey, firstClass(drow.ErrorClass), drow.InstanceKey)
					}
					// A body node with stop: the composite itself decides the
					// scope's fate (until's failure scan, for_each's
					// onChildFailure) — but this dependant's branch is dead
					// now, and an unsettled body would hang the scope. The
					// honest terminal for "my input failed" is cancelled.
					return ac.cancelNode(row, "branch_stopped")
				}
				// continue (and non-route dependants of a routed failure):
				skip = true
			}
		}
	}
	if blocked || !allSettled {
		return nil
	}
	if !skip {
		vars := ac.varsFor(scopeKey, idx, ac.scopeStateOf(pn, idx))
		trueish, err := ac.ev.EvalBool(pn.When, vars)
		if err != nil {
			return ac.failPredicate(err, row)
		}
		if !trueish {
			skip = true
			skipReason = "condition_default"
		}
	}
	if skip {
		return ac.skipNode(row, skipReason)
	}
	return ac.st2ready(row)
}

func (ac *advanceCtx) st2ready(row *NodeExecution) error {
	if err := row.Move(NodeReady, ac.now); err != nil {
		return err
	}
	ac.changed = true
	return nil
}

func (ac *advanceCtx) skipNode(row *NodeExecution, reason string) error {
	if NodeTerminal(row.Status) {
		return nil
	}
	if err := row.Move(NodeSkipped, ac.now); err != nil {
		return err
	}
	row.SkipReason = reason
	ac.event(pevents.TypeNodeExecutionSkipped, row, "", pevents.NodeExecutionSkipped{
		ProjectID: ac.st.Run.ProjectID, RunID: ac.st.Run.ID,
		NodeInstanceKey: row.InstanceKey, Reason: reason,
	})
	ac.changed = true
	return nil
}

func firstClass(s string) string { return s }

// failPredicate turns a predicate error into the honest terminal: the node
// fails as predicate_error (an expression error is never a false, ADR-0022 § 3)
// and the run failure follows the failure policy (stop by default).
func (ac *advanceCtx) failPredicate(err error, row *NodeExecution) error {
	var pe PredicateError
	var be BudgetExceeded
	switch {
	case errors.As(err, &be):
		return ac.failRun("expression_eval_budget_exceeded", "", row.InstanceKey)
	case errors.As(err, &pe):
		if mvErr := row.Move(NodeFailed, ac.now); mvErr != nil {
			return mvErr
		}
		row.ErrorClass = ErrPredicate
		row.FailedCause = "predicate_error"
		ac.changed = true
		if ac.cancelPending() || ac.prog.scopes[row.scopeRef()] == nil {
			return nil
		}
		if pn := ac.prog.nodes[row.scopeRef()][row.NodeID]; pn != nil && pn.Failure.OnExecutionError == "stop" {
			return ac.escalateStop(row, "predicate_error:"+row.InstanceKey, ErrPredicate)
		}
		return nil
	default:
		return err
	}
}

// ----------------------------------------------------------------- dispatch

func (ac *advanceCtx) dispatch(pn *compiler.Node, row *NodeExecution, scopeKey string, idx map[string]int) error {
	switch pn.Kind {
	case "condition":
		return ac.runCondition(pn, row, scopeKey, idx)
	case "human.approval":
		return ac.openGate(pn, row, scopeKey, idx)
	case "until":
		return ac.advanceUntil(pn, row, scopeKey, idx)
	case "for_each":
		return ac.advanceForEach(pn, row, scopeKey, idx)
	case "pipeline.invoke":
		return ac.advanceInvoke(pn, row, scopeKey, idx)
	default:
		return ac.workerNode(pn, row)
	}
}

// workerNode owns the advancer's half of worker work: queue attempts, decide
// retries, and honour the failure/attempt budgets. The attempt's lifecycle in
// between belongs to the worker's fenced writes (contract § 4).
func (ac *advanceCtx) workerNode(pn *compiler.Node, row *NodeExecution) error {
	last := ac.st.LastAttempt(row.ID)
	switch {
	case last == nil:
		if !ac.slotFree() {
			return nil // maxConcurrentNodes: counted as live attempts (§ 5.2)
		}
		return ac.queueAttempt(pn, row, ac.now, nil)
	case last.Status == AttemptSucceeded:
		// The boundary transaction already moved the node; a succeeded
		// attempt with a non-terminal node is a store bug, surfaced.
		if row.Status != NodeSucceeded {
			return fmt.Errorf("runtime: attempt %s succeeded but node %s is %s", last.ID, row.InstanceKey, row.Status)
		}
		return nil
	case last.Status == AttemptFailed, last.Status == AttemptInterrupted:
		class := last.ErrorClass
		if class == "" {
			class = ErrInfra
		}
		if retriable(pn.Retry, class) && row.AttemptCount < row.AttemptLimit && !ac.cancelPending() {
			if !ac.slotFree() {
				return nil
			}
			scheduled := ac.now.Add(backoffDelay(pn.Retry, row.ID, last.AttemptNumber))
			ctx := map[string]any{
				"attempt":     int64(last.AttemptNumber),
				"error_class": last.ErrorClass,
			}
			// continue_workspace is the default (ADR-0023 § 6): the retry is
			// TOLD what the interrupted attempt left behind. The repo facts
			// come from the last durable checkpoint, never from a memory.
			if rc, ok := ac.lastCheckpointContext(); ok {
				for k, v := range rc {
					ctx[k] = v
				}
			}
			if err := ac.queueAttempt(pn, row, scheduled, ctx); err != nil {
				return err
			}
			ac.event(pevents.TypeNodeAttemptRetryScheduled, row, last.ID, pevents.NodeAttemptRetryScheduled{
				ProjectID: ac.st.Run.ProjectID, RunID: ac.st.Run.ID,
				NodeInstanceKey: row.InstanceKey, AttemptNumber: last.AttemptNumber,
				NextAttemptNumber: last.AttemptNumber + 1, ErrorClass: class,
				DelaySeconds: int(math.Round(scheduled.Sub(ac.now).Seconds())), ScheduledAt: scheduled,
			})
			return nil
		}
		// Out of retries (or non-retriable): the node reaches its terminal.
		to := NodeFailed
		if last.Status == AttemptInterrupted {
			to = NodeInterrupted
		}
		if err := row.Move(to, ac.now); err != nil {
			return err
		}
		row.ErrorClass = class
		ac.changed = true
		switch pn.Failure.OnExecutionError {
		case "stop":
			return ac.escalateStop(row, "node_execution_failed:"+row.InstanceKey, class)
		}
		return nil
	default:
		// queued/leased/running attempt: nothing to decide until it lands.
		return nil
	}
}

func (ac *advanceCtx) cancelPending() bool { return ac.st.Run.CancelRequestedAt != nil }

// slotFree enforces policies.maxConcurrentNodes as live-attempt accounting
// (contract § 5.2's second layer).
func (ac *advanceCtx) slotFree() bool {
	max := ac.prog.plan.Policies.MaxConcurrentNodes
	if max <= 0 {
		return true
	}
	return len(ac.st.LiveAttempts()) < max
}

func (ac *advanceCtx) queueAttempt(pn *compiler.Node, row *NodeExecution, scheduled time.Time, retryCtx map[string]any) error {
	a := &Attempt{
		ID:              ac.st.NewID("at"),
		NodeExecutionID: row.ID,
		RunID:           ac.st.Run.ID,
		AttemptNumber:   row.AttemptCount + 1,
		Status:          AttemptQueued,
		ScheduledAt:     scheduled,
		Overrides:       nil,
		RetryContext:    retryCtx,
		CreatedAt:       ac.now,
	}
	if err := a.Check(); err != nil {
		return err
	}
	row.AttemptCount++
	row.InFlight++
	if pn.TimeoutSeconds > 0 {
		a.DeadlineAt = time.Time{} // set at Start: deadline is launch-relative
	}
	ac.st.Attempts = append(ac.st.Attempts, a)
	ac.changed = true
	return nil
}

// retriable is ADR-0023 § 7's rule as data: the class must be one the author
// admitted AND the attempt budget must have room. Non-retriable classes are
// the absence from retriableErrors, and workspace_lost can never be in the
// list (the compiler refuses it there).
func retriable(r compiler.Retry, class string) bool {
	for _, c := range r.RetriableErrors {
		if c == class {
			return true
		}
	}
	return false
}

// backoffDelay is min(maxSeconds, baseSeconds * multiplier^attemptNumber) with
// ±20 % jitter (ADR-0023 § 7). The jitter is a deterministic hash of
// (node execution, failed attempt number): "jittered" across the retry spread,
// but stable across an API restart mid-backoff, because the computed
// scheduled_at is persisted on the attempt row and never recomputed.
func backoffDelay(r compiler.Retry, nodeExecID string, attemptNumber int) time.Duration {
	base := float64(r.BaseSeconds)
	if base <= 0 {
		base = 30
	}
	mult := r.Multiplier
	if mult <= 0 {
		mult = 2
	}
	d := base * math.Pow(mult, float64(attemptNumber))
	if r.MaxSeconds > 0 && d > float64(r.MaxSeconds) {
		d = float64(r.MaxSeconds)
	}
	if r.Jitter {
		h := fnv.New64a()
		h.Write([]byte(nodeExecID))
		h.Write([]byte{byte(attemptNumber)})
		frac := float64(h.Sum64()%4001) / 10000 // [0, 0.4)
		d *= 0.8 + frac
	}
	if d < 0 {
		d = 0
	}
	return time.Duration(d * float64(time.Second))
}

// ------------------------------------------------------------ control kinds

func (ac *advanceCtx) runCondition(pn *compiler.Node, row *NodeExecution, scopeKey string, idx map[string]int) error {
	tree, err := ConfigTree(pn)
	if err != nil {
		return err
	}
	vars := ac.varsFor(scopeKey, idx, nil)
	resolved, err := ac.ev.ResolveConfig(tree, vars)
	if err != nil {
		return ac.failPredicate(err, row)
	}
	route := ""
	if cases, ok := ConfigSlice(resolved.(map[string]any)["cases"]); ok {
		for _, c := range cases {
			cm, ok := c.(map[string]any)
			if !ok {
				continue
			}
			leaf, _ := cm["when"].(configLeaf)
			if leaf.binding == nil {
				continue
			}
			// Short-circuit in authored order: the FIRST true case routes.
			trueish, berr := ac.ev.EvalBool(leaf.binding, vars)
			if berr != nil {
				return ac.failPredicate(berr, row)
			}
			if trueish {
				r, _ := ConfigString(cm["route"])
				route = r
				break
			}
		}
	}
	if route == "" {
		d, ok := ConfigString(resolved.(map[string]any)["default"])
		if !ok || d == "" {
			// No case matched and no default: 03 requires a route out; the
			// compiler checked for a declared default, so this is a state bug.
			return fmt.Errorf("runtime: condition %s matched no case and declares no default", row.InstanceKey)
		}
		route = d
	}
	if err := ac.succeedNode(row, map[string]any{"route": route}, ""); err != nil {
		return err
	}
	return nil
}

func (ac *advanceCtx) openGate(pn *compiler.Node, row *NodeExecution, scopeKey string, idx map[string]int) error {
	// One live gate per node execution (approval_requests UNIQUE
	// (node_execution_id)) — re-derive, never trust a memory.
	for _, ap := range ac.st.Approvals {
		if ap.NodeExecutionID == row.ID && ap.State == ApprovalPending {
			return nil
		}
	}
	// A decided gate that has not yet been delivered to the node row (a crash
	// between the decide transaction and this pass) completes the node now.
	for _, ap := range ac.st.Approvals {
		if ap.NodeExecutionID == row.ID && ap.State == ApprovalDecided {
			return ac.closeGate(pn, row, ap)
		}
	}
	tree, err := ConfigTree(pn)
	if err != nil {
		return err
	}
	vars := ac.varsFor(scopeKey, idx, nil)
	resolved, err := ac.ev.ResolveConfig(tree, vars)
	if err != nil {
		return ac.failPredicate(err, row)
	}
	cfg := resolved.(map[string]any)
	summary, _ := ConfigString(cfg["summary"])
	deadline, _ := ConfigInt(cfg["deadlineSeconds"])
	if deadline <= 0 {
		deadline = 86400 // the schema's authored default lives in the document, not here
	}
	onTimeout, ok := ConfigString(cfg["onTimeout"])
	if !ok || onTimeout == "" {
		onTimeout = "fail"
	}
	ap := &Approval{
		ID:              ac.st.NewID("ap"),
		RunID:           ac.st.Run.ID,
		NodeExecutionID: row.ID,
		Kind:            "pipeline_gate",
		Summary:         summary,
		DeadlineAt:      ac.now.Add(time.Duration(deadline) * time.Second),
		OnTimeout:       onTimeout,
		State:           ApprovalPending,
		Version:         1,
		CreatedAt:       ac.now,
	}
	for _, r := range rawConfigStrings(pn, "/config/approverRoles") {
		ap.ApproverRoles = append(ap.ApproverRoles, r)
	}
	for _, u := range rawConfigStrings(pn, "/config/approverUserIds") {
		ap.ApproverUserIDs = append(ap.ApproverUserIDs, u)
	}
	if err := ap.Check(); err != nil {
		return err
	}
	ac.st.Approvals = append(ac.st.Approvals, ap)
	if err := row.Move(NodeWaiting, ac.now); err != nil {
		return err
	}
	row.Waiting = WaitingApproval
	ac.changed = true
	ac.event(pevents.TypeApprovalRequested, row, "", pevents.ApprovalRequested{
		ProjectID: ac.st.Run.ProjectID, RunID: ac.st.Run.ID, ApprovalID: ap.ID,
		NodeInstanceKey: row.InstanceKey, SummaryDigest: digestText(summary),
		ArtifactRefs: nz(row.ArtifactRefs), DeadlineAt: ap.DeadlineAt,
		OnTimeout: ap.OnTimeout, ApproverRoles: ap.ApproverRoles, ApproverUserIDs: ap.ApproverUserIDs,
	})
	// The run carries waiting_human while a gate is live, and the OTHER
	// branches keep running (contract § 5.3 — the scope waits, not the run).
	if ac.st.Run.Status == RunRunning {
		if err := ac.st.Run.MoveRun(RunWaitingHuman, "", "", ac.now); err != nil {
			return err
		}
	}
	ac.event(pevents.TypeRunWaitingHuman, row, "", pevents.RunWaitingHuman{
		ProjectID: ac.st.Run.ProjectID, RunID: ac.st.Run.ID, ApprovalID: ap.ID,
		NodeInstanceKey: row.InstanceKey, DeadlineAt: ap.DeadlineAt, ApproverRoles: ap.ApproverRoles,
	})
	return nil
}

// digestText is the gate summary's fingerprint. The summary text may embed
// another node's output (C11's vector), so only the digest enters the journal.
func digestText(s string) string { return "sha256:" + shortHash([]byte(s)) }

// closeGate completes the approval node from its decided gate. A rejection is
// a BUSINESS outcome, not an execution failure (contract § 5.3): succeeded,
// outcome 'rejected', and downstream `when` expressions read it.
func (ac *advanceCtx) closeGate(pn *compiler.Node, row *NodeExecution, ap *Approval) error {
	decision := "rejected"
	if ap.Decision == "approved" {
		decision = "approved"
	}
	outs := map[string]any{
		"decision":         decision,
		"comments_present": ap.Comments != "",
	}
	outcome := decision
	if decision == "approved" {
		outcome = ""
	}
	return ac.succeedNode(row, outs, outcome)
}

func (ac *advanceCtx) expireApprovals() error {
	for _, ap := range ac.st.Approvals {
		if ap.State != ApprovalPending || ap.DeadlineAt.After(ac.now) {
			continue
		}
		reRequest, err := ap.Expire(ac.now)
		if err != nil {
			return err
		}
		row := ac.nodeByExecID(ap.NodeExecutionID)
		ac.event(pevents.TypeApprovalExpired, row, "", pevents.ApprovalExpired{
			ProjectID: ac.st.Run.ProjectID, RunID: ac.st.Run.ID, ApprovalID: ap.ID,
			OnTimeout: ap.OnTimeout, ReRequested: reRequest,
		})
		ac.changed = true
		if reRequest {
			continue // exactly once, via re_requested (contract § 5.4 pass 2)
		}
		switch ap.OnTimeout {
		case "cancel_run":
			t := ac.now
			ac.st.Run.CancelRequestedAt = &t
		default: // fail
			if row != nil && !NodeTerminal(row.Status) {
				if err := row.Move(NodeFailed, ac.now); err != nil {
					return err
				}
				row.ErrorClass = ErrApprovalExpired
				row.FailedCause = "approval_expired"
				return ac.escalateStop(row, "node_execution_failed:"+row.InstanceKey, ErrApprovalExpired)
			}
		}
	}
	return nil
}

// ---------------------------------------------------------------- composites

func (ac *advanceCtx) advanceUntil(pn *compiler.Node, row *NodeExecution, scopeKey string, idx map[string]int) error {
	sub, ok := ac.prog.Scope(pn.SubScope)
	if !ok {
		return fmt.Errorf("runtime: until %s names sub-scope %q, which the plan does not declare", pn.ID, pn.SubScope)
	}
	if row.Scope == nil {
		row.Scope = &ScopeState{
			Kind:         "until",
			Iteration:    1,
			Previous:     map[string]any{},
			StartedAt:    ac.now,
			CarryForward: configBool(pn, "carryForward"),
		}
		if err := ac.enterScope(sub.Key, childIdx(idx, pn.ID, 1), scopeKeyOf(pn.Path, idx, 1)); err != nil {
			return err
		}
		ac.event(pevents.TypeNodeScopeStarted, row, "", pevents.NodeScopeStarted{
			ProjectID: ac.st.Run.ProjectID, RunID: ac.st.Run.ID,
			ScopeKey: scopeKeyOf(pn.Path, idx, 1), NodeInstanceKey: row.InstanceKey,
			Kind: "until", Iteration: 1,
		})
		ac.changed = true
		return nil
	}
	st := row.Scope
	bodyIdx := childIdx(idx, pn.ID, st.Iteration)
	bodyKey := scopeKeyOf(pn.Path, idx, st.Iteration)
	if err := ac.advanceScope(sub.Key, bodyIdx); err != nil {
		return err
	}
	if !ac.bodySettled(&sub, bodyIdx) {
		return nil
	}
	if cause, class := ac.bodyFailure(&sub, bodyIdx); cause != "" {
		return ac.failScope(row, "child_failed", class, &sub, bodyIdx)
	}
	vars := ac.varsFor(sub.Key, bodyIdx, st)
	// failWhen first: an author-stated failure beats the pass predicate.
	if pn.FailWhen != nil {
		bad, err := ac.ev.EvalBool(pn.FailWhen, vars)
		if err != nil {
			return ac.scopePredicateError(row, st, err)
		}
		if bad {
			return ac.failScope(row, "fail_when", "", &sub, bodyIdx)
		}
	}
	pass, err := ac.ev.EvalBool(pn.PassWhen, vars)
	if err != nil {
		return ac.scopePredicateError(row, st, err)
	}
	results, err := ac.ev.EvalBindings(pn.ResultBindings, vars)
	if err != nil {
		return ac.scopePredicateError(row, st, err)
	}
	truth := pass
	st.Evidence = append(st.Evidence, IterationEvidence{Iteration: st.Iteration, PassWhenResult: &truth})
	ac.event(pevents.TypeNodeScopeIteration, row, "", pevents.NodeScopeIteration{
		ProjectID: ac.st.Run.ProjectID, RunID: ac.st.Run.ID,
		ScopeKey: bodyKey, NodeInstanceKey: row.InstanceKey,
		Iteration: st.Iteration, PassWhenResult: &truth,
	})
	ac.changed = true
	if pass {
		outs := map[string]any{"iterations": int64(st.Iteration)}
		for k, v := range results {
			outs[k] = v
		}
		return ac.completeScope(row, "until", st.Iteration, 0, outs, &sub, bodyIdx)
	}
	if st.Iteration >= sub.MaxIterations {
		// Case 7: the bound is reached with the predicate never true. The
		// scope FAILS with until_exhausted and the per-iteration evidence
		// preserved — never a silent truncation.
		return ac.failScope(row, "until_exhausted", "", &sub, bodyIdx)
	}
	if st.CarryForward {
		st.Previous = results
	} else {
		st.Previous = map[string]any{}
	}
	st.Iteration++
	nbi := childIdx(idx, pn.ID, st.Iteration)
	if err := ac.enterScope(sub.Key, nbi, scopeKeyOf(pn.Path, idx, st.Iteration)); err != nil {
		return err
	}
	ac.event(pevents.TypeNodeScopeStarted, row, "", pevents.NodeScopeStarted{
		ProjectID: ac.st.Run.ProjectID, RunID: ac.st.Run.ID,
		ScopeKey: scopeKeyOf(pn.Path, idx, st.Iteration), NodeInstanceKey: row.InstanceKey,
		Kind: "until", Iteration: st.Iteration,
	})
	return nil
}

func (ac *advanceCtx) advanceForEach(pn *compiler.Node, row *NodeExecution, scopeKey string, idx map[string]int) error {
	sub, ok := ac.prog.Scope(pn.SubScope)
	if !ok {
		return fmt.Errorf("runtime: for_each %s names sub-scope %q, which the plan does not declare", pn.ID, pn.SubScope)
	}
	if row.Scope == nil {
		tree, err := ConfigTree(pn)
		if err != nil {
			return err
		}
		vars := ac.varsFor(scopeKey, idx, nil)
		resolved, err := ac.ev.ResolveConfig(tree, vars)
		if err != nil {
			return ac.failPredicate(err, row)
		}
		itemsVal := resolved.(map[string]any)["items"]
		items, ok := ConfigSlice(itemsVal)
		if !ok {
			return ac.failScope(row, "predicate_error", "items did not evaluate to an array", &sub, nil)
		}
		if lim := ac.prog.plan.Budgets.MaxItemsPerForEach; lim > 0 && len(items) > lim {
			// fanout_items_exceeded is the advancer's named failure at scope
			// start (contract § 6), not a schema promise that broke late.
			if err := ac.failScope(row, "fanout_items_exceeded", "", &sub, nil); err != nil {
				return err
			}
			return ac.failRun("fanout_items_exceeded", "", row.InstanceKey)
		}
		row.Scope = &ScopeState{Kind: "for_each", Items: items, StartedAt: ac.now}
		ac.event(pevents.TypeNodeScopeStarted, row, "", pevents.NodeScopeStarted{
			ProjectID: ac.st.Run.ProjectID, RunID: ac.st.Run.ID,
			ScopeKey: scopeKeyOf(pn.Path, idx, 0), NodeInstanceKey: row.InstanceKey,
			Kind: "for_each", Items: len(items),
		})
		ac.changed = true
		if len(items) == 0 {
			// 03's zero-item edge case: the scope succeeds immediately with an
			// empty result list and one scope.completed {items: 0}.
			outs := map[string]any{"children": []any{}, "items": int64(0)}
			return ac.completeScope(row, "for_each", 0, 0, outs, &sub, nil)
		}
	}
	st := row.Scope
	// Advance each started index's body DAG (bounded fan-out: at most
	// maxConcurrency are unsettled at once — § 5.2's fourth layer and C8c's
	// measured assertion).
	for i := 0; i < st.NextIndex; i++ {
		if err := ac.advanceScope(sub.Key, childIdx(idx, pn.ID, i)); err != nil {
			return err
		}
	}
	// Settle finished indices and start new ones up to maxConcurrency (the
	// per-scope fan-out bound counted by in-flight child executions, § 5.2's
	// fourth layer).
	maxConc := sub.MaxConcurrency
	if maxConc <= 0 {
		maxConc = 1
	}
	active := 0
	for i := 0; i < st.NextIndex; i++ {
		if !ac.indexSettled(&sub, childIdx(idx, pn.ID, i)) {
			active++
		}
	}
	for i := 0; i < st.NextIndex; i++ {
		bi := childIdx(idx, pn.ID, i)
		if !ac.indexSettled(&sub, bi) {
			continue
		}
		if alreadyRecorded(st, i) {
			continue
		}
		res := ac.indexResult(&sub, bi, i)
		st.ChildResults = append(st.ChildResults, res)
		ac.event(pevents.TypeNodeScopeIteration, row, "", pevents.NodeScopeIteration{
			ProjectID: ac.st.Run.ProjectID, RunID: ac.st.Run.ID,
			ScopeKey: scopeKeyOf(pn.Path, idx, i), NodeInstanceKey: row.InstanceKey,
			Items: 1,
		})
		if res.Status == NodeFailed || res.Status == NodeInterrupted || res.Status == NodeCancelled {
			switch sub.OnChildFailure {
			case "stop":
				st.StopRequested = true
			case "fail_after_all":
				st.FailAfterAll = true
			}
		}
		ac.changed = true
	}
	if st.StopRequested {
		if err := ac.cancelUnsettledIndices(&sub, pn, idx, st.NextIndex); err != nil {
			return err
		}
	} else {
		for st.NextIndex < len(st.Items) && active < maxConc {
			i := st.NextIndex
			if err := ac.enterScope(sub.Key, childIdx(idx, pn.ID, i), scopeKeyOf(pn.Path, idx, i)); err != nil {
				return err
			}
			st.NextIndex++
			active++
			ac.changed = true
		}
	}
	// Scope end: every index key is terminal (§ 5.1 step 6). Under a fired
	// `stop` the never-started indices are simply unreached — settled +
	// cancelled siblings are what the scope completes on.
	if !st.StopRequested && st.NextIndex < len(st.Items) {
		return nil
	}
	for i := 0; i < st.NextIndex; i++ {
		if !ac.indexSettled(&sub, childIdx(idx, pn.ID, i)) {
			return nil
		}
	}
	if len(st.ChildResults) < st.NextIndex {
		return nil // last index settles on the next pass
	}
	failed := false
	for _, r := range st.ChildResults {
		if r.Status == NodeFailed || r.Status == NodeInterrupted {
			failed = true
		}
	}
	if failed && (sub.OnChildFailure == "stop" || sub.OnChildFailure == "fail_after_all" || sub.OnChildFailure == "") {
		return ac.failScope(row, "child_failed", "", &sub, nil)
	}
	children := make([]any, 0, len(st.ChildResults))
	for _, r := range st.ChildResults {
		m := map[string]any{
			"index":  int64(r.Index),
			"key":    r.Key,
			"status": r.Status,
		}
		if r.Outcome != "" {
			m["outcome"] = r.Outcome
		}
		if r.Outputs != nil {
			m["outputs"] = r.Outputs
		}
		if r.ArtifactRefs != nil {
			m["artifact_refs"] = r.ArtifactRefs
		}
		if r.ChildRunID != "" {
			m["child_run_id"] = r.ChildRunID
		}
		children = append(children, m)
	}
	outs := map[string]any{"children": children, "items": int64(len(st.Items))}
	// resultBindings over a fan-out evaluate on the LAST index's body
	// envelope (a provisional reading of § 9.1 row 6 that says which scope's
	// bindings each one evaluates — children stays the primary output).
	if len(st.Items) > 0 && len(pn.ResultBindings) > 0 {
		last := childIdx(idx, pn.ID, len(st.Items)-1)
		vars := ac.varsFor(sub.Key, last, &ScopeState{Kind: "for_each", Items: st.Items})
		rb, err := ac.ev.EvalBindings(pn.ResultBindings, vars)
		if err != nil {
			return ac.failPredicate(err, row)
		}
		for k, v := range rb {
			outs[k] = v
		}
	}
	return ac.completeScope(row, "for_each", 0, len(st.Items), outs, &sub, nil)
}

func (ac *advanceCtx) advanceInvoke(pn *compiler.Node, row *NodeExecution, scopeKey string, idx map[string]int) error {
	iv, has := ac.st.InvocationFor(row.ID)
	if !has {
		if ac.deps.Children == nil {
			// Honest refusal, not a hang: no child runner is wired.
			if mvErr := row.Move(NodeFailed, ac.now); mvErr != nil {
				return mvErr
			}
			row.ErrorClass = ErrInfra
			row.FailedCause = "no child runner is wired (pipeline.invoke needs the host's run-creation transaction)"
			ac.changed = true
			return ac.escalateStop(row, "node_execution_failed:"+row.InstanceKey, ErrInfra)
		}
		tree, err := ConfigTree(pn)
		if err != nil {
			return err
		}
		vars := ac.varsFor(scopeKey, idx, ac.scopeStateOf(pn, idx))
		resolved, err := ac.ev.ResolveConfig(tree, vars)
		if err != nil {
			return ac.failPredicate(err, row)
		}
		cfg := resolved.(map[string]any)
		target, _ := ConfigString(cfg["pipeline"])
		inputs := map[string]any{}
		if in, ok := cfg["inputs"].(map[string]any); ok {
			for k, v := range in {
				inputs[k] = v
			}
		}
		ctx := ac.deps.Context
		if ctx == nil {
			ctx = context.TODO()
		}
		childID, err := ac.deps.Children.CreateChild(ctx, ChildRequest{
			ParentRunID: ac.st.Run.ID, ParentProjectID: ac.st.Run.ProjectID,
			OrganizationID: ac.st.Run.OrganizationID, NodeExecutionID: row.ID,
			NodeInstanceKey: row.InstanceKey, Target: target, Inputs: inputs,
			Depth: ac.st.Run.Depth + 1, Priority: ac.st.Run.Priority,
		})
		if err != nil {
			return err
		}
		inv := Invocation{
			ID: ac.st.NewID("inv"), RunID: ac.st.Run.ID, NodeExecutionID: row.ID,
			ChildRunID: childID, ChildProjectID: ac.st.Run.ProjectID,
			PipelineID: target, WaitPolicy: "completion", Depth: ac.st.Run.Depth + 1,
			CreatedAt: ac.now,
		}
		if err := inv.Check(); err != nil {
			return err
		}
		ac.st.Invocations = append(ac.st.Invocations, inv)
		if err := row.Move(NodeWaiting, ac.now); err != nil {
			return err
		}
		row.Waiting = WaitingChildRun
		ac.changed = true
		return nil
	}
	return ac.pollInvoke(pn, row, iv)
}

func (ac *advanceCtx) pollInvoke(pn *compiler.Node, row *NodeExecution, iv Invocation) error {
	ctx := ac.deps.Context
	if ctx == nil {
		ctx = context.TODO()
	}
	status, failedCause, err := ac.deps.Children.ChildStatus(ctx, iv.ChildRunID)
	if err != nil {
		return err
	}
	switch status {
	case RunCompleted:
		return ac.succeedNode(row, map[string]any{
			"child_run_id": iv.ChildRunID, "status": status,
		}, "")
	case RunFailed, RunInterrupted:
		if mvErr := row.Move(NodeFailed, ac.now); mvErr != nil {
			return mvErr
		}
		row.ErrorClass = ErrInfra
		row.FailedCause = "child_run_failed"
		if failedCause != "" {
			row.FailedCause = "child_run_failed:" + failedCause
		}
		ac.changed = true
		if pn.Failure.OnExecutionError == "stop" {
			return ac.escalateStop(row, "node_execution_failed:"+row.InstanceKey, firstClass(row.ErrorClass))
		}
		return nil
	case RunCancelled:
		return ac.cancelNode(row, "cascade")
	}
	return nil
}

func (ac *advanceCtx) pollWaiting(pn *compiler.Node, row *NodeExecution, scopeKey string, idx map[string]int) error {
	switch row.Waiting {
	case WaitingChildRun:
		iv, has := ac.st.InvocationFor(row.ID)
		if !has {
			return nil
		}
		return ac.pollInvoke(pn, row, iv)
	case WaitingApproval:
		for _, ap := range ac.st.Approvals {
			if ap.NodeExecutionID != row.ID {
				continue
			}
			if ap.State == ApprovalDecided {
				return ac.closeGate(pn, row, ap)
			}
		}
		return nil
	}
	return nil
}

// ------------------------------------------------------- composite plumbing

func (ac *advanceCtx) bodySettled(sub *compiler.Scope, idx map[string]int) bool {
	for _, id := range sub.TopologicalOrder {
		pn := ac.prog.nodes[sub.Key][id]
		row := ac.st.Node(buildInstanceKey(pn.Path, idx))
		if row == nil || !NodeTerminal(row.Status) {
			return false
		}
	}
	return true
}

func (ac *advanceCtx) bodyFailure(sub *compiler.Scope, idx map[string]int) (cause, class string) {
	for _, id := range sub.TopologicalOrder {
		pn := ac.prog.nodes[sub.Key][id]
		row := ac.st.Node(buildInstanceKey(pn.Path, idx))
		if row == nil {
			continue
		}
		if row.Status == NodeInterrupted ||
			(row.Status == NodeFailed && pn.Failure.OnExecutionError == "stop") {
			// A continue-policy body failure skips its dependants but does
			// not kill the loop — 03's failure table routes that choice to
			// the node's own policy, and only `stop` (or an interrupt,
			// which has no continue arm) reaches the scope.
			return "child_failed", firstClass(row.ErrorClass)
		}
	}
	return "", ""
}

// escalateStop applies a node's stop policy honestly in both placements: at
// the root scope it fails the run; inside a composite body it terminalizes
// the dead branch (the failed node's non-route descendants) so the composite
// settles and judges the failure by ITS rules — until's failure scan, or
// for_each's onChildFailure. A direct run-fail from a body node skipped
// collect_and_continue entirely; this function is why C8d can pass.
func (ac *advanceCtx) escalateStop(row *NodeExecution, cause, class string) error {
	sub, ok := ac.prog.Scope(row.scopeRef())
	if ok && sub.Kind != "root" {
		return ac.stopBranch(row.scopeRef(), idxOfInstanceKey(row.InstanceKey), row.NodeID)
	}
	return ac.failRun(cause, class, row.InstanceKey)
}

// stopBranch cancels the untouched transitive descendants of a just-failed
// node within one scope instance, sparing the declared error route (D6).
func (ac *advanceCtx) stopBranch(scopeKey string, idx map[string]int, failedNodeID string) error {
	sub, ok := ac.prog.Scope(scopeKey)
	if !ok {
		return nil
	}
	killed := map[string]bool{failedNodeID: true}
	for pass := 0; pass < len(sub.TopologicalOrder); pass++ {
		grew := false
		for _, id := range sub.TopologicalOrder {
			if killed[id] {
				continue
			}
			cpn := ac.prog.nodes[sub.Key][id]
			if cpn == nil || cpn.Failure.ErrorRoute != "" {
				continue // the carrier survives to run off the failed envelope
			}
			for _, dep := range cpn.DependsOn {
				if killed[dep] {
					killed[id] = true
					grew = true
					break
				}
			}
		}
		if !grew {
			break
		}
	}
	for _, id := range sub.TopologicalOrder {
		if id == failedNodeID || !killed[id] {
			continue
		}
		cpn := ac.prog.nodes[sub.Key][id]
		if cpn == nil {
			continue
		}
		crow := ac.st.Node(buildInstanceKey(cpn.Path, idx))
		if crow == nil || NodeTerminal(crow.Status) {
			continue // never started: nothing to terminalize
		}
		if err := ac.cancelNode(crow, "branch_stopped"); err != nil {
			return err
		}
	}
	return nil
}

// idxOfInstanceKey recovers the composite index map (/a[1]/b[0]/c ⇒ {a:1,
// b:0}) from an instance key — the restart-safe twin of threading idx
// through every call site.
func idxOfInstanceKey(key string) map[string]int {
	m := map[string]int{}
	for _, seg := range splitPath(key) {
		i := strings.IndexByte(seg, '[')
		if i < 0 || !strings.HasSuffix(seg, "]") {
			continue
		}
		var n int
		if _, err := fmt.Sscanf(seg[i+1:len(seg)-1], "%d", &n); err == nil {
			m[seg[:i]] = n
		}
	}
	return m
}

func (ac *advanceCtx) indexSettled(sub *compiler.Scope, idx map[string]int) bool {
	return ac.bodySettled(sub, idx)
}

func (ac *advanceCtx) indexResult(sub *compiler.Scope, idx map[string]int, i int) ChildResult {
	res := ChildResult{Index: i}
	worst := NodeSucceeded
	outs := map[string]any{}
	for _, id := range sub.TopologicalOrder {
		pn := ac.prog.nodes[sub.Key][id]
		row := ac.st.Node(buildInstanceKey(pn.Path, idx))
		if row == nil {
			continue
		}
		switch row.Status {
		case NodeFailed, NodeInterrupted:
			worst = row.Status
			res.ErrorClass = firstClass(row.ErrorClass)
		case NodeCancelled:
			if worst == NodeSucceeded {
				worst = row.Status
			}
		}
		outs[id] = map[string]any{
			"status": row.Status, "outcome": row.Outcome,
			"outputs": nzAny(row.Outputs), "artifact_refs": nz(row.ArtifactRefs),
		}
		if iv, has := ac.st.InvocationFor(row.ID); has {
			res.ChildRunID = iv.ChildRunID
		}
	}
	res.Status = worst
	res.Key = scopeKeyOf(subPath(ac.prog.scopes[sub.Key]), idx, indexFromIdx(sub, idx))
	res.Outcomes(outs, sub)
	return res
}

func (ac *advanceCtx) cancelUnsettledIndices(sub *compiler.Scope, pn *compiler.Node, idx map[string]int, upto int) error {
	for i := 0; i < upto; i++ {
		bi := childIdx(idx, pn.ID, i)
		if ac.indexSettled(sub, bi) {
			continue
		}
		for _, cid := range sub.TopologicalOrder {
			cpn := ac.prog.nodes[sub.Key][cid]
			crow := ac.st.Node(buildInstanceKey(cpn.Path, bi))
			if crow == nil || NodeTerminal(crow.Status) {
				continue
			}
			if err := ac.cancelNode(crow, "on_child_failure_stop"); err != nil {
				return err
			}
		}
	}
	return nil
}

func alreadyRecorded(st *ScopeState, i int) bool {
	for _, r := range st.ChildResults {
		if r.Index == i {
			return true
		}
	}
	return false
}

func (ac *advanceCtx) completeScope(row *NodeExecution, kind string, iterations, items int, outs map[string]any, sub *compiler.Scope, idx map[string]int) error {
	ac.event(pevents.TypeNodeScopeCompleted, row, "", pevents.NodeScopeCompleted{
		ProjectID: ac.st.Run.ProjectID, RunID: ac.st.Run.ID,
		ScopeKey: row.InstanceKey, NodeInstanceKey: row.InstanceKey, Kind: kind,
		Iterations: iterations, Items: items,
	})
	return ac.succeedNode(row, outs, "")
}

func (ac *advanceCtx) failScope(row *NodeExecution, cause, class string, sub *compiler.Scope, idx map[string]int) error {
	var evidence []any
	st := row.Scope
	if st != nil {
		for _, e := range st.Evidence {
			tr := e
			ev := map[string]any{"iteration": int64(tr.Iteration)}
			if tr.PassWhenResult != nil {
				ev["pass_when_result"] = *tr.PassWhenResult
			}
			if tr.PredicateErrorDetail != "" {
				ev["predicate_error_detail"] = tr.PredicateErrorDetail
			}
			evidence = append(evidence, ev)
		}
	}
	scopeKey := row.InstanceKey
	ac.event(pevents.TypeNodeScopeFailed, row, "", pevents.NodeScopeFailed{
		ProjectID: ac.st.Run.ProjectID, RunID: ac.st.Run.ID,
		ScopeKey: scopeKey, NodeInstanceKey: row.InstanceKey, Kind: row.Kind,
		FailedCause: cause, Evidence: evidence, Iterations: iterationOf(st),
	})
	if !NodeTerminal(row.Status) {
		if err := row.Move(NodeFailed, ac.now); err != nil {
			return err
		}
	}
	if class != "" {
		row.ErrorClass = class
	}
	row.FailedCause = cause
	ac.changed = true
	pn := ac.prog.nodes[row.scopeRef()][row.NodeID]
	if pn != nil && pn.Failure.OnExecutionError == "stop" {
		return ac.escalateStop(row, "node_execution_failed:"+row.InstanceKey, class)
	}
	return nil
}

func iterationOf(st *ScopeState) int {
	if st == nil {
		return 0
	}
	return st.Iteration
}

func (ac *advanceCtx) scopePredicateError(row *NodeExecution, st *ScopeState, err error) error {
	var pe PredicateError
	if errors.As(err, &pe) {
		st.Evidence = append(st.Evidence, IterationEvidence{Iteration: st.Iteration, PredicateErrorDetail: pe.Detail})
	}
	var be BudgetExceeded
	if errors.As(err, &be) {
		return ac.failRun("expression_eval_budget_exceeded", "", row.InstanceKey)
	}
	return ac.failScope(row, "predicate_error", ErrPredicate, nil, nil)
}

// ----------------------------------------------------------------- node close

func (ac *advanceCtx) succeedNode(row *NodeExecution, outs any, outcome string) error {
	if err := row.Move(NodeSucceeded, ac.now); err != nil {
		return err
	}
	row.Outputs = outs
	row.Outcome = outcome
	row.Waiting = ""
	ac.changed = true
	return nil
}

func (ac *advanceCtx) cancelNode(row *NodeExecution, reason string) error {
	if NodeTerminal(row.Status) {
		return nil
	}
	// Queued attempts on this node close before claim (case 8's honest arm).
	for _, a := range ac.st.AttemptsFor(row.ID) {
		if a.Status == AttemptQueued {
			if err := a.CancelBeforeClaim(ac.now, reason); err != nil {
				return err
			}
			row.InFlight--
			ac.event(pevents.TypeNodeAttemptCancelled, row, a.ID, pevents.NodeAttemptCancelled{
				ProjectID: ac.st.Run.ProjectID, RunID: ac.st.Run.ID,
				NodeInstanceKey: row.InstanceKey, AttemptNumber: a.AttemptNumber, Reason: "before_claim",
			})
		} else if a.Status == AttemptLeased || a.Status == AttemptRunning {
			t := ac.now
			a.CancelRequested = &t
		}
	}
	// A leased/running row is NOT moved here: its owner's fenced write closes
	// it (§ 4 step 11 — the advancer marks the attempt cancel-requested and
	// the worker writes the honest terminal). Marking and moving would be the
	// control plane lying about work it does not own.
	if row.Status == NodeLeased || row.Status == NodeRunning {
		ac.changed = true
		return nil
	}
	if err := row.Move(NodeCancelled, ac.now); err != nil {
		return err
	}
	row.CancelReason = reason
	// A waiting gate dies with its node (approval.cancelled, § 3 row 30).
	for _, ap := range ac.st.Approvals {
		if ap.NodeExecutionID == row.ID && ap.State == ApprovalPending {
			ap.State = ApprovalCancelled
			ac.event(pevents.TypeApprovalCancelled, row, "", pevents.ApprovalCancelled{
				ProjectID: ac.st.Run.ProjectID, RunID: ac.st.Run.ID, ApprovalID: ap.ID,
				Reason: reasonFromCancel(reason),
			})
		}
	}
	// Children cascade (ADR-0023 § 10): cancelPolicy is always cascade in M4.
	if iv, has := ac.st.InvocationFor(row.ID); has && ac.deps.Children != nil {
		ctx := ac.deps.Context
		if ctx == nil {
			ctx = context.TODO()
		}
		if err := ac.deps.Children.CancelChild(ctx, iv.ChildRunID, "cascade"); err != nil {
			return err
		}
	}
	ac.event(pevents.TypeNodeExecutionCancelled, row, "", pevents.NodeExecutionCancelled{
		ProjectID: ac.st.Run.ProjectID, RunID: ac.st.Run.ID,
		NodeInstanceKey: row.InstanceKey, Reason: reason,
	})
	ac.changed = true
	return nil
}

func reasonFromCancel(r string) string {
	switch r {
	case "cascade", "run_cancelled", "on_child_failure_stop":
		return "run_cancelled"
	}
	return r
}

// ------------------------------------------------------------------ run ends

// settleRun decides the root scope's outcome: no joins in M4 — a run ends
// when every terminal node of the root scope is terminal (§ 5.1 step 6).
func (ac *advanceCtx) settleRun() error {
	run := ac.st.Run
	root := ac.prog.scopes[ScopeRoot]
	if root == nil {
		return fmt.Errorf("runtime: the plan declares no root scope")
	}
	if ac.cancelPending() {
		// Cancel everything still live, then see if we are done.
		for _, n := range ac.st.Nodes {
			if !NodeTerminal(n.Status) {
				if live(n.Status) {
					continue // the worker closes live attempts (§ 4 step 11)
				}
				if err := ac.cancelNode(n, "run_cancelled"); err != nil {
					return err
				}
			}
		}
		if !ac.anyLive() {
			var keys, aids []string
			for _, n := range ac.st.Nodes {
				if n.Status == NodeCancelled {
					keys = append(keys, n.InstanceKey)
				}
			}
			for _, a := range ac.st.Attempts {
				if a.Status == AttemptCancelled {
					aids = append(aids, a.ID)
				}
			}
			if err := run.MoveRun(RunCancelled, "", "", ac.now); err != nil {
				return err
			}
			ac.event(pevents.TypeRunCancelled, nil, "", pevents.RunCancelled{
				ProjectID: run.ProjectID, RunID: run.ID,
				CancelledNodeExecutions: keys, CancelledAttempts: aids,
			})
			ac.changed = true
		}
		return nil
	}
	// A run settles only when EVERY root-scope row is terminal, not merely
	// when the declared terminal nodes are: a reopened branch (route 31) can
	// leave a non-terminal row whose queued attempt has not run, and
	// completing over it would be the run lying about work it never re-did.
	// (The § 5.1 step-6 rule holds for a graph already at rest; this is the
	// at-rest test itself.)
	for _, n := range ac.st.Nodes {
		if n.ScopeKey == ScopeRoot && !NodeTerminal(n.Status) {
			return nil
		}
	}
	// All root rows are terminal. Any failure has already failed
	// the run through the failure policy; a skipped or succeeded set
	// completes it with the result bindings evaluated over the root envelope.
	for _, id := range root.TerminalNodes {
		pn := ac.prog.nodes[ScopeRoot][id]
		row := ac.st.Node(buildInstanceKey(pn.Path, nil))
		if row == nil {
			return nil
		}
		if row.Status == NodeFailed || row.Status == NodeInterrupted || row.Status == NodeCancelled {
			// A continue/route policy let a non-stop failure reach the end of
			// the graph: the run still has to state an honest outcome.
			cause := "node_execution_failed:" + row.InstanceKey
			class := firstClass(row.ErrorClass)
			if run.Status != RunFailed {
				return ac.failRun(cause, class, row.InstanceKey)
			}
			return nil
		}
	}
	vars := ac.varsFor(ScopeRoot, nil, nil)
	results, err := ac.ev.EvalBindings(ac.prog.plan.RunBindings, vars)
	if err != nil {
		var be BudgetExceeded
		if errors.As(err, &be) {
			return ac.failRun("expression_eval_budget_exceeded", "", "")
		}
		return ac.failRun("predicate_error:/spec/resultBindings", ErrPredicate, "")
	}
	totals := map[string]int{}
	for _, n := range ac.st.Nodes {
		if n.Scope != nil && n.Scope.Kind == "until" {
			totals[n.InstanceKey] = n.Scope.Iteration
		}
	}
	if run.Status == RunWaitingHuman {
		if err := run.MoveRun(RunRunning, "", "", ac.now); err != nil {
			return err
		}
	}
	if err := run.MoveRun(RunCompleted, "", "", ac.now); err != nil {
		return err
	}
	ac.event(pevents.TypeRunCompleted, nil, "", pevents.RunCompleted{
		ProjectID: run.ProjectID, RunID: run.ID,
		ResultBindings: results, IterationTotals: totals,
	})
	ac.changed = true
	return nil
}

func live(status string) bool {
	// leased/running: a worker owns the row and must write its terminal.
	// waiting is control-plane work with no owner — it cancels directly.
	switch status {
	case NodeLeased, NodeRunning:
		return true
	}
	return false
}

func (ac *advanceCtx) anyLive() bool {
	for _, n := range ac.st.Nodes {
		if !NodeTerminal(n.Status) {
			return true
		}
	}
	return false
}

// cascadeCancel implements the cancel arm: queued/ready rows cancel, live
// attempts are cancel-REQUESTED (their owner writes the honest terminal),
// children receive the cascade, and run.cancelled waits for every branch.
func (ac *advanceCtx) cascadeCancel() error {
	// One run.cancel_requested per cancel, however many passes follow (the
	// journal is the marker; a repeat advance must not repeat the event).
	for _, e := range ac.st.Events {
		if e.Type == pevents.TypeRunCancelRequested && e.RunID == ac.st.Run.ID {
			return nil
		}
	}
	var children []string
	for _, iv := range ac.st.Invocations {
		children = append(children, iv.ChildRunID)
	}
	if ac.deps.Children != nil {
		ctx := ac.deps.Context
		if ctx == nil {
			ctx = context.TODO()
		}
		for _, c := range children {
			if err := ac.deps.Children.CancelChild(ctx, c, "cascade"); err != nil {
				return err
			}
		}
	}
	ac.event(pevents.TypeRunCancelRequested, nil, "", pevents.RunCancelRequested{
		ProjectID: ac.st.Run.ProjectID, RunID: ac.st.Run.ID,
		Cascade: len(children) > 0, Children: children,
	})
	for _, a := range ac.st.LiveAttempts() {
		t := ac.now
		a.CancelRequested = &t
	}
	ac.changed = true
	return nil
}

// failRun is the single place a run reaches 'failed': the cause is always
// named (runs_terminal_cause's CHECK mirrored by MoveRun).
func (ac *advanceCtx) failRun(cause, class, nodeKey string) error {
	run := ac.st.Run
	if RunTerminal(run.Status) {
		return nil
	}
	var evidence []any
	var key string
	if nodeKey != "" {
		key = nodeKey
	}
	for _, n := range ac.st.Nodes {
		switch n.Status {
		case NodePending, NodeReady, NodeWaiting:
			if err := ac.cancelNode(n, "cascade"); err != nil {
				return err
			}
		}
	}
	for _, a := range ac.st.LiveAttempts() {
		t := ac.now
		a.CancelRequested = &t
	}
	if run.Status == RunWaitingHuman {
		if err := run.MoveRun(RunRunning, "", "", ac.now); err != nil {
			return err
		}
	}
	if err := run.MoveRun(RunFailed, cause, "", ac.now); err != nil {
		return err
	}
	ac.event(pevents.TypeRunFailed, nil, "", pevents.RunFailed{
		ProjectID: run.ProjectID, RunID: run.ID,
		FailedCause: cause, ErrorClass: class, NodeInstanceKey: key,
		EvidenceArtifacts: evidence,
	})
	ac.changed = true
	return nil
}

// lastCheckpointContext reads the newest durable boundary for a retry's
// continue_workspace context (the facts come from the checkpoint row, never
// from a memory — ADR-0023 § 6, C5e's retry_context shape).
func (ac *advanceCtx) lastCheckpointContext() (map[string]any, bool) {
	var last *CheckpointRecord
	for i, c := range ac.st.Checkpoints {
		if last == nil || c.CreatedAt.After(last.CreatedAt) {
			cc := ac.st.Checkpoints[i]
			last = &cc
		}
	}
	if last == nil {
		return nil, false
	}
	out := map[string]any{}
	for _, r := range last.RepoStates {
		if r.HeadCommit != "" {
			out["head_commit"] = r.HeadCommit
		}
		if r.ModifiedPathCount > 0 {
			out["modified_path_count"] = r.ModifiedPathCount
		}
	}
	if len(out) == 0 {
		return nil, false
	}
	return out, true
}

// ---------------------------------------------------------------- events

func (ac *advanceCtx) event(typ pevents.TypeName, row *NodeExecution, attemptID string, payload any) {
	rec := pevents.Record{
		Type:           typ,
		Payload:        payload,
		OrganizationID: ac.st.Run.OrganizationID,
		ProjectID:      ac.st.Run.ProjectID,
		RunID:          ac.st.Run.ID,
		AttemptID:      attemptID,
		ActorKind:      pevents.ActorKindSystem,
		Timestamp:      ac.now,
	}
	if row != nil {
		rec.NodeExecutionID = row.ID
	}
	ac.st.AppendEvent(rec)
}

// ------------------------------------------------------------------ helpers

func (n *NodeExecution) scopeRef() string {
	if n.ScopeKey == "" {
		return ScopeRoot
	}
	// A body row's scope key is /owner[i]/…; the plan-side scope key drops
	// the [i] suffixes. Rows keep the instance scope key (the DB CHECK
	// grammar), the program needs the declared one.
	return trimInstanceSuffixes(n.ScopeKey)
}

func trimInstanceSuffixes(key string) string {
	var b []byte
	for i := 0; i < len(key); i++ {
		if key[i] == '[' {
			for i < len(key) && key[i] != ']' {
				i++
			}
			continue // skip [n]
		}
		b = append(b, key[i])
	}
	return string(b)
}

func (ac *advanceCtx) scopeStateOf(pn *compiler.Node, idx map[string]int) *ScopeState {
	if pn.Scope == ScopeRoot {
		row := ac.st.Node(buildInstanceKey(pn.Path, idx))
		if row != nil {
			return row.Scope
		}
		return nil
	}
	// A node inside a composite body sees its enclosing scope's state.
	owner := ac.enclosingComposite(pn)
	if owner == nil {
		return nil
	}
	orow := ac.st.Node(buildInstanceKey(owner.Path, idx))
	if orow == nil {
		return nil
	}
	return orow.Scope
}

// enclosingComposite walks up the plan scope chain to the nearest composite
// whose body contains this node.
func (ac *advanceCtx) enclosingComposite(pn *compiler.Node) *compiler.Node {
	s := ac.prog.scopes[pn.Scope]
	for s != nil && s.Kind != "root" {
		if owner, ok := ac.prog.ownerNode(s); ok {
			// The idx passed to scope-state lookups is already the live one
			// for the enclosing chain, so the caller's idx is authoritative.
			return owner
		}
		s = ac.prog.scopes[s.Parent]
	}
	return nil
}

func (ac *advanceCtx) nodeByExecID(id string) *NodeExecution {
	for _, n := range ac.st.Nodes {
		if n.ID == id {
			return n
		}
	}
	return nil
}

// subPath returns the declared path of a scope (without [i] suffixes) — the
// scope key with suffixes stripped, split.
func subPath(s *compiler.Scope) []string {
	key := trimInstanceSuffixes(s.Key)
	parts := splitPath(key)
	return parts
}

func splitPath(key string) []string {
	var out []string
	for _, seg := range split(key, '/') {
		if seg != "" {
			out = append(out, seg)
		}
	}
	return out
}

func split(s string, sep byte) []string {
	var out []string
	start := 0
	for i := 0; i < len(s); i++ {
		if s[i] == sep {
			out = append(out, s[start:i])
			start = i + 1
		}
	}
	return append(out, s[start:])
}

// indexFromIdx recovers the composite's own live index for a scope key — used
// only for event scope keys of body scopes.
func indexFromIdx(sub *compiler.Scope, idx map[string]int) int {
	if idx == nil {
		return 0
	}
	return idx[sub.Owner]
}

// ChildResult.Outcomes attaches the per-node result map, flattening the
// single-terminal-node case (the common fan-out shape: one invoke child) to
// that node's own outputs.
func (r *ChildResult) Outcomes(outs map[string]any, sub *compiler.Scope) {
	if r.Outputs == nil {
		r.Outputs = outs
	}
}

// subPath returns the declared path of a scope (without [i] suffixes) — the
// scope key with suffixes stripped, split.
func nz(s []any) []any {
	if s == nil {
		return []any{}
	}
	return s
}

func nzAny(v any) any {
	if v == nil {
		return map[string]any{}
	}
	return v
}

func max1(n int) int {
	if n < 1 {
		return 1
	}
	return n
}

func configBool(pn *compiler.Node, key string) bool {
	for _, b := range pn.ConfigBindings {
		if strings.HasSuffix(b.Pointer, "/config/"+key) {
			if v, ok := b.Literal.(bool); ok {
				return v
			}
		}
	}
	return false
}

func rawConfigStrings(pn *compiler.Node, keySuffix string) []string {
	var out []string
	for _, b := range pn.ConfigBindings {
		// Array elements carry an index hop ("/approverRoles/0"); the whole
		// slice itself ends right at the key.
		if !strings.HasSuffix(b.Pointer, keySuffix) &&
			!strings.Contains(b.Pointer, keySuffix+"/") {
			continue
		}
		if b.IsLiteral() {
			if s, ok := b.Literal.(string); ok {
				out = append(out, s)
			}
		}
	}
	return out
}

func shortHash(b []byte) string { return fmt.Sprintf("%x", sha256.Sum256(b)) }
