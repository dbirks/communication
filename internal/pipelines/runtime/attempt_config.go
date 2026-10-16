package runtime

// Claim-time config resolution (docs/m4-contract.md § 4 step 6, § 5.1 step 3,
// ADR-0022 § 3). The control plane is the only evaluator: a worker receives a
// node's config with every binding already interpolated, because the store
// hydrates the claim through THESE functions — the same Evaluator, the same
// ConfigTree and the same vars assembly the advancer uses to decide the node.
// A second evaluator is forbidden by the contract, and a second vars assembly
// would disagree with the advancer's own view of the same node, so there is
// exactly one of each, reached from both call sites.

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/dbirks/communication/internal/pipelines/compiler"
)

// envelopeAt is the `nodes` activation of one scope instance: every plan node
// of the scope, mirrored from its row where one exists.
func envelopeAt(prog *Program, st *State, scopeKey string, idx map[string]int) map[string]any {
	results := map[string]nodeResult{}
	for _, pn := range prog.ScopeNodes(scopeKey) {
		nr := nodeResult{Status: NodePending, Outputs: map[string]any{}, ArtifactRefs: []any{}}
		if row := st.Node(buildInstanceKey(pn.Path, idx)); row != nil {
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

// varsAt assembles the activation for evaluations inside one scope instance:
// the advancer's varsFor, lifted onto (prog, st) so the claim hydration and the
// advance pass cannot disagree about what `nodes`/`inputs`/`previous` mean.
func varsAt(prog *Program, st *State, scopeKey string, idx map[string]int, state *ScopeState) map[string]any {
	inputs := st.Run.Inputs
	if inputs == nil {
		inputs = map[string]any{}
	}
	vars := map[string]any{
		"nodes":  envelopeAt(prog, st, scopeKey, idx),
		"inputs": inputs,
		"run": map[string]any{
			"id":    st.Run.ID,
			"depth": int64(st.Run.Depth),
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
			owner := ""
			if s, ok := prog.scopes[scopeKey]; ok {
				owner = s.Owner
			}
			if i, ok := idx[owner]; ok && i >= 0 && i < len(items) {
				vars["item"] = items[i]
			} else {
				vars["item"] = map[string]any{}
			}
		}
	}
	return vars
}

// ResolveNodeConfig evaluates every config binding of the plan node behind one
// node-execution row against the run's persisted state, returning that node's
// fully interpolated config. It never half-resolves: an evaluation failure is
// returned as an error and the caller closes the attempt predicate_error /
// binding_error rather than shipping an unevaluated binding (§ 4 step 14). Each
// expression evaluated counts toward runs.expression_evaluations exactly as an
// advancer evaluation does (via st.Run.ExpressionEvaluations).
func ResolveNodeConfig(prog *Program, st *State, row *NodeExecution) (map[string]any, error) {
	if prog == nil || st == nil || row == nil {
		return nil, fmt.Errorf("runtime: config resolution needs a program, a state and a node row")
	}
	if st.Run == nil {
		return nil, fmt.Errorf("runtime: run state carries no run row")
	}
	planKey := planScopeKey(row.ScopeKey)
	pn := prog.PlanNode(planKey, row.NodeID)
	if pn == nil {
		return nil, fmt.Errorf("runtime: the pinned plan declares no node %q in scope %q",
			row.NodeID, planKey)
	}
	idx, err := indicesOf(pn.Path, row.InstanceKey)
	if err != nil {
		return nil, err
	}
	ev := Evaluator{Prog: prog, ST: st}
	vars, err := scopeActivation(prog, st, ev, planKey, idx)
	if err != nil {
		return nil, err
	}
	tree, err := ConfigTree(pn)
	if err != nil {
		return nil, err
	}
	resolved, err := ev.ResolveConfig(tree, vars)
	if err != nil {
		return nil, err
	}
	// Expression-position leaves are what the condition/gate kinds own inside
	// the advancer. A claim carries no handler that could own them, so they
	// evaluate here too — the worker never does.
	resolved, err = finishConfigLeaves(resolved, ev, vars)
	if err != nil {
		return nil, err
	}
	cfg, ok := resolved.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("runtime: config of node %s resolved to %T, not an object",
			row.InstanceKey, resolved)
	}
	return cfg, nil
}

// scopeActivation rebuilds one scope instance's activation from its PLAN scope
// key and live index map, including the iteration/item roots a composite body
// sees. No scope-state column exists in 00005, so a composite's state is
// re-derived from the rows exactly as the advancer re-derives it after a
// restart (ADR-0023 § 6: re-derive, never trust a memory).
func scopeActivation(prog *Program, st *State, ev Evaluator, planKey string, idx map[string]int) (map[string]any, error) {
	if planKey == "" || planKey == "/" {
		return varsAt(prog, st, "/", idx, nil), nil
	}
	sc, ok := prog.scopes[planKey]
	if !ok {
		return nil, fmt.Errorf("runtime: the pinned plan declares no scope %q", planKey)
	}
	owner := prog.PlanNode(sc.Parent, sc.Owner)
	if owner == nil {
		return nil, fmt.Errorf("runtime: scope %q names owner %q in %q, which the plan does not declare",
			planKey, sc.Owner, sc.Parent)
	}
	parentVars, err := scopeActivation(prog, st, ev, sc.Parent, idx)
	if err != nil {
		return nil, err
	}
	state := &ScopeState{Kind: sc.Kind}
	switch sc.Kind {
	case "for_each":
		items, ierr := forEachItems(ev, owner, parentVars)
		if ierr != nil {
			return nil, ierr
		}
		state.Items = items
		state.NextIndex = idx[owner.ID] + 1
	case "until":
		state.Iteration = idx[owner.ID]
		state.CarryForward = configBool(owner, "carryForward")
		state.Previous = map[string]any{}
		// carryForward=false means the author asked for the previous root to be
		// empty (advancer.go's until arm), so no prior iteration is evaluated.
		if state.CarryForward && state.Iteration > 1 {
			prevIdx := childIdx(trimIndex(idx, owner.ID), owner.ID, state.Iteration-1)
			prevVars, perr := scopeActivation(prog, st, ev, planKey, prevIdx)
			if perr != nil {
				return nil, perr
			}
			results, perr := ev.EvalBindings(owner.ResultBindings, prevVars)
			if perr != nil {
				return nil, perr
			}
			state.Previous = results
		}
	default:
		return nil, fmt.Errorf("runtime: scope %q has kind %q, whose bindings the claim hydration does not resolve",
			planKey, sc.Kind)
	}
	return varsAt(prog, st, planKey, idx, state), nil
}

// forEachItems evaluates the composite's own `items` binding against the
// activation ITS scope uses (advanceForEach's first step), so a body node's
// item/items roots see the same persisted list.
func forEachItems(ev Evaluator, owner *compiler.Node, parentVars map[string]any) ([]any, error) {
	for i := range owner.ConfigBindings {
		b := &owner.ConfigBindings[i]
		if !strings.HasSuffix(b.Pointer, "/config/items") {
			continue
		}
		v, err := ev.Resolve(*b, parentVars)
		if err != nil {
			return nil, err
		}
		items, ok := v.([]any)
		if !ok {
			return nil, fmt.Errorf("runtime: for_each %s items resolved to %T, not a list", owner.ID, v)
		}
		return items, nil
	}
	return []any{}, nil
}

// finishConfigLeaves evaluates the leaves ResolveConfig deliberately left for
// their kind handlers. A claim has no handler: the worker never evaluates, so
// nothing may stay a leaf.
func finishConfigLeaves(v any, ev Evaluator, vars map[string]any) (any, error) {
	switch t := v.(type) {
	case configLeaf:
		if t.binding == nil {
			return t.value, nil
		}
		return ev.Resolve(*t.binding, vars)
	case []any:
		out := make([]any, len(t))
		for i, el := range t {
			r, err := finishConfigLeaves(el, ev, vars)
			if err != nil {
				return nil, err
			}
			out[i] = r
		}
		return out, nil
	case map[string]any:
		out := make(map[string]any, len(t))
		for k, el := range t {
			r, err := finishConfigLeaves(el, ev, vars)
			if err != nil {
				return nil, err
			}
			out[k] = r
		}
		return out, nil
	}
	return v, nil
}

// planScopeKey turns a row's INSTANCE scope key (/fan_out[3]/until_x[2]/) back
// into the plan's scope key (/fan_out/until_x/): the plan is keyed per scope
// declaration, the rows per scope instance.
func planScopeKey(scopeKey string) string {
	if !strings.ContainsRune(scopeKey, '[') {
		return scopeKey
	}
	var b strings.Builder
	for i := 0; i < len(scopeKey); {
		if scopeKey[i] == '[' {
			j := strings.IndexByte(scopeKey[i:], ']')
			if j < 0 {
				b.WriteString(scopeKey[i:])
				break
			}
			i += j + 1
			continue
		}
		b.WriteByte(scopeKey[i])
		i++
	}
	return b.String()
}

// indicesOf recovers the live index map an instance key was built with:
// buildInstanceKey stamps every ancestor segment of a body node's path with its
// composite index, so the row's own instance key carries that map verbatim.
func indicesOf(path []string, instanceKey string) (map[string]int, error) {
	idx := map[string]int{}
	if len(path) == 0 {
		return idx, nil
	}
	segs := strings.Split(strings.TrimPrefix(instanceKey, "/"), "/")
	if len(segs) != len(path) {
		return nil, fmt.Errorf("runtime: instance key %q does not match plan path %v", instanceKey, path)
	}
	for i, seg := range segs {
		name, index, err := splitKeySegment(seg)
		if err != nil {
			return nil, fmt.Errorf("runtime: instance key %q: %w", instanceKey, err)
		}
		if name != path[i] {
			return nil, fmt.Errorf("runtime: instance key %q segment %q is not plan segment %q",
				instanceKey, seg, path[i])
		}
		if i < len(path)-1 {
			if index < 0 {
				return nil, fmt.Errorf("runtime: instance key %q omits the index of ancestor %q",
					instanceKey, name)
			}
			idx[name] = index
		}
	}
	return idx, nil
}

func splitKeySegment(seg string) (string, int, error) {
	open := strings.Index(seg, "[")
	if open < 0 {
		return seg, -1, nil
	}
	if !strings.HasSuffix(seg, "]") {
		return "", 0, fmt.Errorf("malformed key segment %q", seg)
	}
	n, err := strconv.Atoi(seg[open+1 : len(seg)-1])
	if err != nil {
		return "", 0, fmt.Errorf("malformed key segment %q: %w", seg, err)
	}
	return seg[:open], n, nil
}

// trimIndex drops one owner's own body index, to look at the prior iteration.
func trimIndex(idx map[string]int, ownerID string) map[string]int {
	out := make(map[string]int, len(idx))
	for k, v := range idx {
		if k != ownerID {
			out[k] = v
		}
	}
	return out
}
