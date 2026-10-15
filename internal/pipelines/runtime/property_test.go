package runtime_test

import (
	"fmt"
	"math/rand"
	"testing"
	"time"

	"github.com/dbirks/communication/internal/pipelines/runtime"
)

// TestPropertyRandomScripts is the § 8 property row made executable: random
// scripts over the contract sample's real machinery (compiled plan, CEL, the
// full state machine set), asserting the four invariants that the whole
// milestone rests on — they must hold for EVERY interleaving, not just the
// happy path:
//
//  1. no node instance ever has two SUCCEEDED attempts (exactly at most one);
//  2. no checkpoint is skipped: every succeeded attempt wrote one;
//  3. terminal rows never change again (append-only ledgers);
//  4. a redundant advance has zero effect (idempotence from rows).
func TestPropertyRandomScripts(t *testing.T) {
	for seed := int64(1); seed <= 25; seed++ {
		seed := seed
		t.Run(fmt.Sprintf("seed-%d", seed), func(t *testing.T) {
			runRandomScript(t, seed)
		})
	}
}

func runRandomScript(t *testing.T, seed int64) {
	rng := rand.New(rand.NewSource(seed))
	// No retry patching: the sample's authored retry blocks reach the plan now,
	// so the dice roll against real attempt budgets (3 for /plan, 2 for the
	// loop body nodes) and real retriable class lists.
	plan := loadPlan(t, "../testdata/feature-development-contract.yaml")
	dv := newDriver(t, plan, sampleInputs())
	dv.gate = func(*runtime.Approval) (string, string) { return "approved", "" }

	// Random but consistent per-node scripts over 3 possible iterations.
	keys := []string{"/plan"}
	for i := 1; i <= 3; i++ {
		for _, b := range []string{"implement", "test", "review"} {
			keys = append(keys, fmt.Sprintf("/build_until_verified[%d]/%s", i, b))
		}
	}
	for _, k := range keys {
		n := 1 + rng.Intn(3)
		steps := make([]step, 0, n)
		for j := 0; j < n; j++ {
			switch rng.Intn(10) {
			case 0:
				steps = append(steps, step{failClass: runtime.ErrInfra, detail: "random infra hiccup"})
			case 1:
				steps = append(steps, step{interrupt: true})
			case 2:
				// An invalid envelope half the time the dice say so.
				steps = append(steps, step{outputs: map[string]any{"wrong": "shape"}})
			case 3:
				// Business failure for the loop bodies (never an execution error).
				var out map[string]any
				switch {
				case len(k) > 7 && k[len(k)-5:] == "/test":
					out = map[string]any{"exit_code": int64(1), "result": map[string]any{"successful": false}}
				case len(k) > 7 && k[len(k)-6:] == "/review":
					out = map[string]any{"approved": false, "evidence": "not yet"}
				case len(k) > 7 && k[len(k)-9:] == "/implement":
					out = map[string]any{"summary": "work"}
				}
				steps = append(steps, step{outputs: out, outcome: "failed"})
			default:
				var out map[string]any
				switch {
				case k == "/plan":
					out = map[string]any{"plan": fmt.Sprintf("plan-%d", j)}
				case k[len(k)-5:] == "/test":
					out = map[string]any{"exit_code": int64(0), "result": map[string]any{"successful": true}}
				case k[len(k)-6:] == "/review":
					out = map[string]any{"approved": true, "evidence": "clean"}
				default:
					out = map[string]any{"summary": fmt.Sprintf("work-%d", j)}
				}
				steps = append(steps, step{outputs: out})
			}
		}
		dv.script(k, steps...)
	}

	dv.pump(400)
	st := dv.state()

	// Invariants 1 & 2: per node execution — at most one succeeded attempt,
	// and every succeeded attempt has a checkpoint with the same attempt id.
	byNode := map[string][]*runtime.Attempt{}
	for _, a := range st.Attempts {
		byNode[a.NodeExecutionID] = append(byNode[a.NodeExecutionID], a)
	}
	for execID, atts := range byNode {
		key := ""
		for _, n := range st.Nodes {
			if n.ID == execID {
				key = n.InstanceKey
			}
		}
		succ := 0
		for _, a := range atts {
			if a.Status == runtime.AttemptSucceeded {
				succ++
				has := false
				for _, c := range st.Checkpoints {
					if c.AttemptID == a.ID {
						has = true
					}
				}
				if !has {
					t.Errorf("%s: succeeded attempt %s without a checkpoint", key, a.ID)
				}
			}
		}
		if succ > 1 {
			t.Errorf("%s: %d succeeded attempts, want at most 1", key, succ)
		}
	}

	// Every attempt is numbered 1..len contiguously (append-only ledger).
	for execID, atts := range byNode {
		for i, a := range atts {
			if a.AttemptNumber != i+1 {
				t.Errorf("node %s: attempt %d has number %d (ledger has holes)", execID, i, a.AttemptNumber)
			}
		}
	}

	// Invariant 4: a redundant advance changes nothing (event count + run
	// fingerprint).	before := fingerprint(st)
	before := fingerprint(st)
	for i := 0; i < 2; i++ {
		if err := dv.ms.Advance(dv.run.ID); err != nil {
			t.Fatal(err)
		}
	}
	if after := fingerprint(st); after != before {
		t.Errorf("redundant advance changed state:\n before %s\n after  %s", before, after)
	}

	// Invariant 3: terminal rows are absorbing — snapshot, re-advance after
	// time passes, nothing with a finished_at moved.
	type snap struct {
		status string
		done   time.Time
	}
	snapshots := map[string]snap{}
	for _, n := range st.Nodes {
		if runtime.NodeTerminal(n.Status) {
			snapshots[n.ID] = snap{n.Status, n.FinishedAt}
		}
	}
	for _, a := range st.Attempts {
		if runtime.AttemptTerminal(a.Status) {
			snapshots[a.ID] = snap{a.Status, a.FinishedAt}
		}
	}
	dv.now = dv.now.Add(10 * time.Minute)
	dv.pump(50) // whatever can still happen, happens
	for _, n := range st.Nodes {
		if s, ok := snapshots[n.ID]; ok && runtime.NodeTerminal(s.status) {
			if n.Status != s.status || !n.FinishedAt.Equal(s.done) {
				t.Errorf("terminal node %s moved %s→%s", n.InstanceKey, s.status, n.Status)
			}
		}
	}
	for _, a := range st.Attempts {
		if s, ok := snapshots[a.ID]; ok {
			if a.Status != s.status || !a.FinishedAt.Equal(s.done) {
				t.Errorf("terminal attempt %s moved %s→%s", a.ID, s.status, a.Status)
			}
		}
	}

	// The run itself is legal and, when terminal, honest.
	if runtime.RunTerminal(st.Run.Status) && st.Run.FinishedAt.IsZero() {
		t.Error("terminal run without finished_at")
	}
	if st.Run.Status == runtime.RunFailed && st.Run.FailedCause == "" {
		t.Error("failed run without a cause")
	}
}

func fingerprint(st *runtime.State) string {
	out := fmt.Sprintf("run=%s/%s|%v;", st.Run.Status, st.Run.FailedCause, st.Run.CancelRequestedAt != nil)
	for _, n := range st.Nodes {
		out += fmt.Sprintf("%s:%s:%s;%03d;", n.ID, n.Status, n.Outcome, n.AttemptCount)
	}
	for _, a := range st.Attempts {
		out += fmt.Sprintf("%s:%s;%d;", a.ID, a.Status, a.AttemptNumber)
	}
	out += fmt.Sprintf("ev=%d;ck=%d;ap=%d", len(st.Events), len(st.Checkpoints), len(st.Approvals))
	return out
}
