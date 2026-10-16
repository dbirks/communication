package runtime

// Composite scope state, re-derived from the ledger rows and the journal
// (docs/m4-contract.md § 5.1 step 6, ADR-0023 § 6).
//
// node_executions has no scope-state column (§ 1's CREATE TABLE says so), so
// the ScopeState an advance pass carries is a CACHE of facts that live in the
// rows: which iterations the loop opened, which of them the journal closed,
// and what the run's per-iteration evidence was. A run whose rows came from
// another replica's transaction therefore re-derives the same loop position
// the replica that wrote them had — the property § 5.1 step 1 promises and
// § 7.1 C7b measures (an until that re-walked its finished iterations on every
// advance emitted one node.scope.iteration per already-closed iteration per
// transaction: 21 journal rows for a 3-iteration loop).

import (
	"encoding/json"

	"github.com/dbirks/communication/internal/pipelines/compiler"
	pevents "github.com/dbirks/communication/internal/pipelines/events"
)

// rederiveUntil rebuilds an until's bookkeeping from rows + journal. It runs
// only when the row carries no in-memory state yet (a fresh hydrate); the
// iteration position it finds is the highest /owner[i] the loop inhabited,
// advanced by one when the journal already closed that iteration.
func (ac *advanceCtx) rederiveUntil(pn *compiler.Node, row *NodeExecution,
	sub *compiler.Scope, idx map[string]int) (*ScopeState, error) {
	st := &ScopeState{
		Kind:         "until",
		Iteration:    1,
		Previous:     map[string]any{},
		StartedAt:    ac.now,
		CarryForward: configBool(pn, "carryForward"),
		Evidence:     ac.journalEvidence(row),
	}
	last := 0
	max := sub.MaxIterations
	if max < 1 {
		max = 1
	}
	for i := 1; i <= max; i++ {
		if ac.scopeInhabited(scopeKeyOf(pn.Path, idx, i)) {
			last = i
		}
	}
	if last > 0 {
		st.Iteration = last
		if ac.bodySettled(sub, childIdx(idx, pn.ID, last)) && ac.iterationRecorded(row, last) {
			st.Iteration = last + 1
		}
	}
	if st.CarryForward && st.Iteration > 1 {
		prev, err := ac.priorBindings(pn, sub, idx, st.Iteration-1)
		if err != nil {
			return nil, err
		}
		st.Previous = prev
	}
	return st, nil
}

// priorBindings is one until iteration's `previous` root: the named prior
// iteration's resultBindings, an empty object on iteration 1 (ADR-0022 § 2).
// It is the same evaluation the claim hydration performs (attempt_config.go),
// so the advancer and the worker cannot disagree about what `previous` meant.
func (ac *advanceCtx) priorBindings(pn *compiler.Node, sub *compiler.Scope,
	idx map[string]int, iteration int) (map[string]any, error) {
	if iteration < 1 || len(pn.ResultBindings) == 0 {
		return map[string]any{}, nil
	}
	pi := childIdx(idx, pn.ID, iteration)
	vars := ac.varsFor(sub.Key, pi, &ScopeState{Kind: "until", Iteration: iteration,
		Previous: map[string]any{}, CarryForward: configBool(pn, "carryForward")})
	results, err := ac.ev.EvalBindings(pn.ResultBindings, vars)
	if err != nil {
		return nil, err
	}
	if results == nil {
		return map[string]any{}, nil
	}
	return results, nil
}

// scopeInhabited reports whether any row of one scope INSTANCE exists — the
// loop opened that iteration at some point, whoever wrote the rows.
func (ac *advanceCtx) scopeInhabited(instanceScopeKey string) bool {
	return len(ac.st.NodesInScope(instanceScopeKey)) > 0
}

// iterationScopeKey is the instance scope key one until iteration inhabits:
// the composite's own path with its own segment carrying [iteration] (and the
// live indices of any enclosing composite). It is the key the body rows were
// opened under, so it is also the key node.scope.started names for that
// iteration — the pair the dedupe below compares.
func iterationScopeKey(pn *compiler.Node, idx map[string]int, iteration int) string {
	return scopeKeyOf(pn.Path, idx, iteration)
}

// scopeEventRecorded reports whether the journal already carries one event of
// typ for this composite instance at scopeKey. node.scope.started is append-
// once per iteration (§ 3 row 16), so a pass that hydrated another replica's
// rows must not open the same iteration twice — the ledger says it was opened,
// the journal is the proof.
func (ac *advanceCtx) scopeEventRecorded(row *NodeExecution,
	typ pevents.TypeName, scopeKey string) bool {
	if row == nil {
		return false
	}
	for _, e := range ac.st.Events {
		if e.Type != typ || e.RunID != ac.st.Run.ID {
			continue
		}
		p, ok := decodeScopeStarted(e.Payload)
		if !ok || p.NodeInstanceKey != row.InstanceKey {
			continue
		}
		if p.ScopeKey == scopeKey {
			return true
		}
	}
	return false
}

func decodeScopeStarted(payload any) (pevents.NodeScopeStarted, bool) {
	switch v := payload.(type) {
	case pevents.NodeScopeStarted:
		return v, true
	case *pevents.NodeScopeStarted:
		if v != nil {
			return *v, true
		}
		return pevents.NodeScopeStarted{}, false
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return pevents.NodeScopeStarted{}, false
	}
	var p pevents.NodeScopeStarted
	if err := json.Unmarshal(raw, &p); err != nil || p.NodeInstanceKey == "" {
		return pevents.NodeScopeStarted{}, false
	}
	return p, true
}

// iterationRecorded is the journal's own answer to "did this iteration close?"
// — node.scope.iteration (§ 3 row 17) is the append that closes it, so an
// advance pass must never write it twice for one iteration.
func (ac *advanceCtx) iterationRecorded(row *NodeExecution, iteration int) bool {
	for _, e := range ac.iterationEvents(row) {
		if e.Iteration == iteration {
			return true
		}
	}
	return false
}

// journalEvidence re-reads the closed iterations' evidence from the journal, so
// node.scope.failed's evidence[] names EVERY iteration the run executed and not
// merely the ones this transaction walked (12 case 7's preserved evidence).
func (ac *advanceCtx) journalEvidence(row *NodeExecution) []IterationEvidence {
	evs := ac.iterationEvents(row)
	if len(evs) == 0 {
		return nil
	}
	out := make([]IterationEvidence, 0, len(evs))
	out = append(out, evs...)
	return out
}

// iterationEvents decodes this composite's node.scope.iteration appends. The
// payload is the typed struct inside one process and raw JSON after a hydrate
// (runtime_read.go), and both spellings mean the same thing here.
func (ac *advanceCtx) iterationEvents(row *NodeExecution) []IterationEvidence {
	if row == nil {
		return nil
	}
	var out []IterationEvidence
	for _, e := range ac.st.Events {
		if e.Type != pevents.TypeNodeScopeIteration || e.RunID != ac.st.Run.ID {
			continue
		}
		p, ok := decodeScopeIteration(e.Payload)
		if !ok || p.NodeInstanceKey != row.InstanceKey {
			continue
		}
		tr := IterationEvidence{Iteration: p.Iteration, PassWhenResult: p.PassWhenResult,
			PredicateErrorDetail: p.PredicateErrorDetail, Items: p.Items}
		out = append(out, tr)
	}
	return out
}

func decodeScopeIteration(payload any) (pevents.NodeScopeIteration, bool) {
	switch v := payload.(type) {
	case pevents.NodeScopeIteration:
		return v, true
	case *pevents.NodeScopeIteration:
		if v != nil {
			return *v, true
		}
		return pevents.NodeScopeIteration{}, false
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return pevents.NodeScopeIteration{}, false
	}
	var p pevents.NodeScopeIteration
	if err := json.Unmarshal(raw, &p); err != nil || p.NodeInstanceKey == "" {
		return pevents.NodeScopeIteration{}, false
	}
	return p, true
}

// scopeEventEvidence is the fallback run.failed evidence set: the loop's own
// per-iteration records (iteration + passWhen result), so an exhausted run
// always names what it tried even when the body rows carried no artifacts.
func scopeEventEvidence(st *ScopeState) []any {
	if st == nil {
		return nil
	}
	var out []any
	for _, e := range st.Evidence {
		m := map[string]any{"iteration": int64(e.Iteration)}
		if e.PassWhenResult != nil {
			m["pass_when_result"] = *e.PassWhenResult
		}
		if e.PredicateErrorDetail != "" {
			m["predicate_error_detail"] = e.PredicateErrorDetail
		}
		out = append(out, m)
	}
	return out
}

// scopeEvidenceArtifacts is § 3 row 10's evidence_artifacts for a composite
// that failed: one entry per iteration the loop ran, naming the body rows that
// are that iteration's evidence and the artifact refs they carry. It is the
// pointer set a reader follows into the ledger (§ 7.1 C7b), never a claim of
// bytes this failure did not produce.
func (ac *advanceCtx) scopeEvidenceArtifacts(row *NodeExecution, sub *compiler.Scope,
	idx map[string]int, iterations int) []any {
	if row == nil || sub == nil {
		return nil
	}
	var out []any
	for i := 1; i <= iterations; i++ {
		bi := childIdx(idx, sub.Owner, i)
		var (
			refs []any
			keys []any
		)
		for _, id := range sub.TopologicalOrder {
			cpn := ac.prog.nodes[sub.Key][id]
			if cpn == nil {
				continue
			}
			crow := ac.st.Node(buildInstanceKey(cpn.Path, bi))
			if crow == nil {
				continue
			}
			keys = append(keys, crow.InstanceKey)
			refs = append(refs, nz(crow.ArtifactRefs)...)
		}
		if len(keys) == 0 {
			continue
		}
		out = append(out, map[string]any{
			"iteration": int64(i), "node_instance_keys": keys, "artifact_refs": nz(refs),
		})
	}
	return out
}
