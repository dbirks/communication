package runtimetest

import (
	"encoding/json"
	"testing"

	pevents "github.com/dbirks/communication/internal/pipelines/events"
	"github.com/dbirks/communication/internal/pipelines/runtime"
)

// iterationWitness is the journal-side twin of pevents.NodeScopeIteration,
// decoded from whatever spelling the store returned (typed in MemStore, raw
// JSON after a Postgres hydrate).
type iterationWitness struct {
	Iteration      int   `json:"iteration"`
	PassWhenResult *bool `json:"pass_when_result"`
}

// testUntilIterationEventsOnce: docs/m4-contract.md § 7.1 C7a/C7b, § 5.1 step 1
// and ADR-0023 § 6. The loop's position is a CACHE of ledger facts, so an
// advance pass that hydrated another replica's rows must resume the same
// iteration rather than restart it: three iterations means exactly three
// `node.scope.iteration` appends with iteration=1,2,3 — the live gate counted
// 21 for the same run because every transaction re-walked the closed ones.
// The exhaustion is then the ADVANCER's named verdict: `runs.failed_cause` is
// `until_exhausted` (C7a, contract line 1130), not the generic
// `node_execution_failed:<key>` (which stays for unnamed/child failures, § 5.1
// step 5), and `run.failed.evidence_artifacts` names the per-iteration
// evidence (C7b, contract line 1137).
func testUntilIterationEventsOnce(t *testing.T, f Factory) {
	s := f.Open(t, Config{Pipeline: PipelineUntil})
	for i := 1; i <= 3; i++ {
		if err := s.Advance(); err != nil {
			t.Fatalf("advance before iteration %d: %v", i, err)
		}
		a, err := s.Claim(WorkerA)
		if err != nil || a == nil {
			t.Fatalf("claim iteration %d: %v", i, err)
		}
		if err := s.Start(a.ID, WorkerA, a.FencingToken); err != nil {
			t.Fatalf("start iteration %d: %v", i, err)
		}
		// Honest business fail, execution success: the only way the loop can
		// die is its bound (12 case 7).
		if err := s.Complete(a.ID, WorkerA, a.FencingToken, Completion{
			Outputs:       map[string]any{"approved": false},
			OutputsDigest: BoundaryDigest,
			ArtifactRefs:  []any{"art:test-" + string(rune('0'+i))},
			Outcome:       "failed",
			Checkpoint:    NewCheckpoint(WorkerA),
		}); err != nil {
			t.Fatalf("complete iteration %d: %v", i, err)
		}
	}
	for i := 0; i < 6; i++ {
		if err := s.Advance(); err != nil {
			t.Fatalf("advance: %v", err)
		}
		if st := s.State(t); runtime.RunTerminal(st.Run.Status) {
			break
		}
	}
	st := s.State(t)
	if st.Run.Status != runtime.RunFailed || st.Run.FailedCause != "until_exhausted" {
		t.Fatalf("run = %s/%s, want failed/until_exhausted (§ 7.1 C7a)", st.Run.Status, st.Run.FailedCause)
	}

	var its []iterationWitness
	for _, e := range st.Events {
		if e.Type != string(pevents.TypeNodeScopeIteration) {
			continue
		}
		raw, err := json.Marshal(e.Payload)
		if err != nil {
			t.Fatalf("encode iteration payload: %v", err)
		}
		var w iterationWitness
		if err := json.Unmarshal(raw, &w); err != nil {
			t.Fatalf("decode iteration payload: %v", err)
		}
		its = append(its, w)
	}
	if len(its) != 3 {
		t.Fatalf("node.scope.iteration = %d rows, want exactly 3 for a 3-iteration loop (§ 3 row 17): %s",
			len(its), encodeJSON(its))
	}
	for i, w := range its {
		if w.Iteration != i+1 {
			t.Fatalf("node.scope.iteration[%d] = iteration %d, want %d (one append per iteration, ever): %s",
				i, w.Iteration, i+1, encodeJSON(its))
		}
		if w.PassWhenResult == nil || *w.PassWhenResult {
			t.Fatalf("iteration %d reports pass_when_result %v, want false (§ 7.1 C7b: never null)",
				w.Iteration, w.PassWhenResult)
		}
	}
	if n := countType(st.Events, string(pevents.TypeNodeScopeStarted)); n != 3 {
		t.Fatalf("node.scope.started = %d, want one per iteration: %s", n, encodeJSON(eventTypesOf(st)))
	}
	rf := lastPayloadOf(t, st, pevents.TypeRunFailed)
	if ev, _ := rf["evidence_artifacts"].([]any); len(ev) == 0 {
		t.Fatalf("run.failed carries no evidence_artifacts (§ 7.1 C7b): %s", encodeJSON(rf))
	}
}

func eventTypesOf(st *runtime.State) []string {
	out := make([]string, 0, len(st.Events))
	for _, e := range st.Events {
		out = append(out, e.Type)
	}
	return out
}

func lastPayloadOf(t *testing.T, st *runtime.State, typ pevents.TypeName) map[string]any {
	t.Helper()
	for i := len(st.Events) - 1; i >= 0; i-- {
		if st.Events[i].Type != string(typ) {
			continue
		}
		raw, err := json.Marshal(st.Events[i].Payload)
		if err != nil {
			t.Fatalf("encode %s payload: %v", typ, err)
		}
		var m map[string]any
		if err := json.Unmarshal(raw, &m); err != nil {
			t.Fatalf("decode %s payload: %v", typ, err)
		}
		return m
	}
	t.Fatalf("no %s event; got %v", typ, eventTypesOf(st))
	return nil
}
