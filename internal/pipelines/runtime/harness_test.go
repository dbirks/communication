package runtime_test

import (
	"os"
	"strings"
	"testing"
	"time"

	"github.com/dbirks/communication/internal/pipelines/compiler"
	"github.com/dbirks/communication/internal/pipelines/loader"
	"github.com/dbirks/communication/internal/pipelines/runtime"
	"github.com/dbirks/communication/internal/pipelines/schema"
)

// loadPlan compiles a testdata pipeline: loader, then schema, then compiler —
// the same three steps a publish performs. Every plan these tests run is an
// authored document's output: none is assembled in Go, and none is edited
// afterwards, so what the runtime honours (retry budgets, failure routing,
// workspace policy) is what an author wrote. compiler/policy_test.go holds the
// pins that keep that promise true.
func loadPlan(t *testing.T, path string) *compiler.Plan {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	doc, d := loader.Load(b)
	if !d.Valid() {
		t.Fatalf("loader: %v", d)
	}
	if d := schema.MustCompile().Validate(doc.Value); !d.Valid() {
		t.Fatalf("schema: %v", d)
	}
	plan, d := compiler.Compile(doc, compiler.Options{})
	if !d.Valid() {
		t.Fatalf("compiler: %v", d)
	}
	return plan
}

// ---------------------------------------------------------------- scenario harness

type step struct {
	// outputs is the attempt's validated envelope; nil ⇒ succeed with {}.
	outputs map[string]any
	// failClass, when set, fails the attempt with that ADR-0023 § 7 class.
	failClass string
	detail    string
	// interrupt closes the attempt as interrupted (the docker-kill arm,
	// written by the reconciler rather than the worker).
	interrupt bool
	// outcome is the business outcome (03's execution_status=success,
	// business_outcome=fail shape).
	outcome string
	// skipClaim leaves the attempt queued (tests the not-yet-claimable arm).
	skipClaim bool
	// uncommitted records the repo state as uncommitted at the checkpoint
	// (the flag that makes restore_checkpoint illegal — C6d).
	uncommitted bool
	// bareBoundary records the checkpoint an M4 boundary whose git capture never
	// ran looks like: the repository's only recorded identity is its base
	// commit, and no working-tree facts were measured (lab live13 C5e's row).
	bareBoundary bool
	// cleanBoundary records a captured boundary with a clean tree — a MEASURED
	// zero, which C5e's retry_context must carry rather than omit.
	cleanBoundary bool
}

// driver scripted outcomes + a store + an advancer, all in memory.
type driver struct {
	t    *testing.T
	ms   *runtime.MemStore
	now  time.Time
	run  *runtime.Run
	seq  int
	fail map[string][]step // node instance key → steps per attempt
	gate func(ap *runtime.Approval) (decision string, comments string)
}

func newDriver(t *testing.T, plan *compiler.Plan, inputs map[string]any) *driver {
	t.Helper()
	return newDriverWith(t, plan, inputs, runtime.AdvancerDeps{})
}

// newDriverWith additionally wires advancer capabilities (a ChildResolver
// for fan-out/invoke tests), which a plain driver leaves nil.
func newDriverWith(t *testing.T, plan *compiler.Plan, inputs map[string]any, deps runtime.AdvancerDeps) *driver {
	t.Helper()
	prog, d := runtime.PreparePlan(plan)
	if !d.Valid() {
		t.Fatalf("PreparePlan: %v", d)
	}
	adv := &runtime.Advancer{Prog: prog, Deps: deps}
	ms := runtime.NewMemStore(adv)
	dv := &driver{t: t, ms: ms, now: time.Date(2026, 10, 15, 12, 0, 0, 0, time.UTC), fail: map[string][]step{}}
	ms.Now = func() time.Time { return dv.now }
	run := &runtime.Run{
		ID: "r1", OrganizationID: "org1", ProjectID: "prj1",
		PipelineID: "pipe1", RevisionID: "rev1",
		RevisionDigest: "sha256:" + strings.Repeat("a", 64),
		PlanDigest:     "sha256:" + strings.Repeat("b", 64),
		Status:         runtime.RunQueued,
		Inputs:         inputs,
		CreatedAt:      dv.now,
	}
	st := runtime.NewState(run)
	st.Run.ID = run.ID // NewID uses the state; ids are deterministic
	ms.AddRun(st)
	dv.run = run
	return dv
}

// script queues the outcome steps for a node instance key (one per attempt;
// when exhausted, later attempts repeat the last step).
func (dv *driver) script(key string, steps ...step) { dv.fail[key] = steps }

func (dv *driver) state() *runtime.State {
	st, _ := dv.ms.Peek(dv.run.ID)
	return st
}

func (dv *driver) advance() {
	dv.t.Helper()
	if err := dv.ms.Advance(dv.run.ID); err != nil {
		dv.t.Fatalf("advance: %v", err)
	}
}

// pump runs claim/start/complete cycles until nothing is claimable, then
// handles any waiting gate via dv.gate and continues. It stops on a terminal
// run or when a gate has no scripted decision.
func (dv *driver) pump(max int) {
	dv.t.Helper()
	for i := 0; i < max; i++ {
		dv.advance()
		st := dv.state()
		if runtime.RunTerminal(st.Run.Status) {
			return
		}
		a, err := dv.ms.Claim(dv.run.ID, "worker-a")
		if err != nil {
			dv.t.Fatalf("claim: %v", err)
		}
		if a == nil {
			// Nothing claimable. A scripted gate decides first (it is live
			// work); with no gate and only future-scheduled retries left,
			// the deterministic clock jumps to the next due moment and the
			// reconcilers run — the hermetic twin of the API poll loop.
			pending := st.PendingApprovals()
			if len(pending) > 0 {
				if dv.gate == nil {
					return
				}
				ap := pending[0]
				decision, comments := dv.gate(ap)
				if decision == "" {
					return
				}
				if err := dv.ms.Decide(dv.run.ID, ap.ID, decision, comments, "alice", ap.Version,
					func(*runtime.Approval, string) (bool, string) { return true, "" }); err != nil {
					dv.t.Fatalf("decide: %v", err)
				}
				continue
			}
			if due, ok := dv.ms.NextDue(dv.run.ID); ok {
				if due.After(dv.now) {
					dv.now = due
				} else {
					dv.now = dv.now.Add(time.Millisecond)
				}
				if err := dv.ms.ReconcileLeases(dv.run.ID); err != nil {
					dv.t.Fatalf("reconcile leases: %v", err)
				}
				if err := dv.ms.ReconcileDeadlines(dv.run.ID); err != nil {
					dv.t.Fatalf("reconcile deadlines: %v", err)
				}
				continue
			}
			return
		}
		dv.runAttempt(a)
	}
	dv.t.Fatalf("pump exceeded %d rounds (run %s stuck?)", max, dv.run.ID)
}

func (dv *driver) runAttempt(a *runtime.Attempt) {
	dv.t.Helper()
	st := dv.state()
	n := st.Node(dv.keyForAttempt(a))
	key := n.InstanceKey
	list := dv.fail[key]
	var s step
	if len(list) == 0 {
		s = step{outputs: map[string]any{}}
	} else if a.AttemptNumber <= len(list) {
		s = list[a.AttemptNumber-1]
	} else {
		s = list[len(list)-1]
	}
	if s.skipClaim {
		return
	}
	if err := dv.ms.Start(dv.run.ID, a.ID, a.WorkerID, a.FencingToken); err != nil {
		dv.t.Fatalf("start: %v", err)
	}
	outs := s.outputs
	if outs == nil {
		outs = map[string]any{}
	}
	switch {
	case s.interrupt:
		if err := dv.ms.Interrupt(dv.run.ID, a.ID, "lease_expired"); err != nil {
			dv.t.Fatalf("interrupt: %v", err)
		}
	case s.failClass != "":
		if err := dv.ms.Fail(dv.run.ID, a.ID, a.WorkerID, a.FencingToken, s.failClass, s.detail, nil); err != nil {
			dv.t.Fatalf("fail: %v", err)
		}
	default:
		ck := runtime.CheckpointRecord{
			InputsDigest:  "sha256:" + strings.Repeat("1", 64),
			OutputsDigest: "sha256:" + strings.Repeat("2", 64),
			ArtifactRefs:  []any{},
			RepoStates:    []runtime.RepoState{dv.repoState(key, s)},
			WorkspaceID:   "ws1", VolumeID: "vol-a", WorkerID: "worker-a",
		}
		if err := dv.ms.Complete(dv.run.ID, a.ID, a.WorkerID, a.FencingToken,
			outs, "sha256:"+"out-"+key, []any{}, s.outcome, ck); err != nil {
			dv.t.Fatalf("complete: %v", err)
		}
	}
}

// bareHead is the commit identity of a boundary that never captured: the
// repository is where it started, and "started at" is a real 12-hex commit the
// same way the lab's HEAD_BEFORE was.
const bareHead = "3acceb6285f2"

func (dv *driver) repoState(key string, s step) runtime.RepoState {
	switch {
	case s.bareBoundary:
		return runtime.RepoState{RepositoryID: "app", BaseCommit: bareHead}
	case s.cleanBoundary:
		return runtime.RepoState{
			RepositoryID: "app", BaseCommit: "base1", HeadCommit: "head-" + key,
			Committed: true, CaptureRecorded: true,
		}
	default:
		return runtime.RepoState{
			RepositoryID: "app", BaseCommit: "base1", HeadCommit: "head-" + key,
			Committed: !s.uncommitted, ModifiedPathCount: 2, CaptureRecorded: true,
		}
	}
}

func (dv *driver) keyForAttempt(a *runtime.Attempt) string {
	st := dv.state()
	for _, n := range st.Nodes {
		if n.ID == a.NodeExecutionID {
			return n.InstanceKey
		}
	}
	dv.t.Fatalf("attempt %s on unknown node execution", a.ID)
	return ""
}

// ---------------------------------------------------------------- event helpers

func eventTypes(st *runtime.State) []string {
	var out []string
	for _, e := range st.Events {
		out = append(out, e.Type)
	}
	return out
}

func countType(st *runtime.State, typ string) int {
	n := 0
	for _, e := range st.Events {
		if e.Type == typ {
			n++
		}
	}
	return n
}

func statusKeys(st *runtime.State, status string) []string {
	var out []string
	for _, n := range st.Nodes {
		if n.Status == status {
			out = append(out, n.InstanceKey)
		}
	}
	return out
}
