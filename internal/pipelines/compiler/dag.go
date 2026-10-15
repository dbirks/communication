package compiler

import (
	"sort"
	"strings"

	"github.com/dbirks/communication/internal/pipelines/diag"
	"github.com/dbirks/communication/internal/pipelines/ptr"
)

// dag computes one scope's entries and terminals and proves it acyclic.
//
// dependsOn is a barrier edge — a node is ready when every dependency reaches
// a terminal state including skipped (ADR-0023 § 5, 03 § 5) — which is what
// lets a `condition` route branches without route-typed edges. Entries are the
// nodes with no in-scope dependency; terminals are those nothing depends on.
func (w *walk) dag(s *scope) (entries, terminals []string, cyclic bool) {
	deps := map[string][]string{}
	kids := map[string][]string{}
	for _, id := range s.order {
		var list []string
		for _, d := range asStrings(s.byID[id]["dependsOn"]) {
			if !s.ids[d] || d == id {
				continue // already reported by dependencies()
			}
			list = append(list, d)
			kids[d] = append(kids[d], id)
		}
		deps[id] = dedupe(list)
	}
	for _, id := range s.order {
		if len(deps[id]) == 0 {
			entries = append(entries, id)
		}
		if len(kids[id]) == 0 {
			terminals = append(terminals, id)
		}
	}

	// Iterative three-colour DFS. A document of 1000 nodes must not be able to
	// recurse 1000 frames deep in a control-plane process.
	const (
		white = iota
		grey
		black
	)
	color := map[string]int{}
	type frame struct {
		id string
		i  int
	}
	var report func(start string) []string
	report = func(start string) []string {
		stack := []frame{{id: start}}
		path := []string{}
		for len(stack) > 0 {
			top := &stack[len(stack)-1]
			if color[top.id] == black {
				stack = stack[:len(stack)-1]
				if len(path) > 0 {
					path = path[:len(path)-1]
				}
				continue
			}
			if color[top.id] != grey {
				color[top.id] = grey
				path = append(path, top.id)
			}
			next := deps[top.id]
			if top.i < len(next) {
				kid := next[top.i]
				top.i++
				switch color[kid] {
				case grey:
					loop := append(append([]string{}, path...), kid)
					// Trim to the repeating segment so the message names the
					// actual loop rather than the path that discovered it.
					if startIdx := indexOf(loop, kid); startIdx >= 0 {
						loop = append(loop[startIdx:], kid)
					}
					return loop
				case white:
					stack = append(stack, frame{id: kid})
				}
				continue
			}
			color[top.id] = black
			stack = stack[:len(stack)-1]
			if len(path) > 0 {
				path = path[:len(path)-1]
			}
		}
		return nil
	}
	for _, id := range s.order {
		if color[id] == white {
			color[id] = grey
			if loop := report(id); loop != nil {
				w.reportCycle(s, loop)
				return nil, nil, true
			}
		}
	}
	if len(entries) == 0 {
		// 03 § 5: a scope with no entry node cannot start.
		w.err(s.nodesAt, diag.CodeScopeEntryAmbiguous,
			"scope %q has no entry node: every node waits on another one", s.key)
		return nil, nil, true
	}
	return entries, terminals, false
}

func (w *walk) reportCycle(s *scope, loop []string) {
	if len(loop) == 0 {
		w.err(s.nodesAt, diag.CodeCycleDetected, "scope %q contains a cycle", s.key)
		return
	}
	w.err(s.at[loop[len(loop)-1]].Child("dependsOn"), diag.CodeCycleDetected,
		"scope %q contains a cycle: %s. dependsOn is a barrier edge and may not close a loop; a bounded loop is an until node (ADR-0023 § 8)",
		s.key, strings.Join(loop, " -> "))
	// A cycle invalidates the whole scope: report it once and stop, rather than
	// failing every downstream binding check with noise.
	w.bailed = true
}

func indexOf(hay []string, needle string) int {
	for i, h := range hay {
		if h == needle {
			return i
		}
	}
	return -1
}

// checkRoutes enforces 03's "every reachable terminal outcome" rule for
// condition nodes: a route no downstream `when` can select is a dead outcome
// that will silently strand a branch, so it fails at publish.
func (w *walk) checkRoutes(s *scope) {
	type routeKey struct{ node, name string }
	declared := map[routeKey]ptr.Pointer{}
	for _, id := range s.order {
		if s.byID[id]["kind"] != "condition" {
			continue
		}
		cfg, _ := s.byID[id]["config"].(map[string]canonValue)
		at := s.at[id].Child("config")
		for _, cs := range asListOfMaps(cfg["cases"]) {
			if r, _ := cs["route"].(string); r != "" {
				declared[routeKey{id, r}] = at
			}
		}
		if d, _ := cfg["default"].(string); d != "" {
			declared[routeKey{id, d}] = at
		}
	}
	if len(declared) == 0 {
		return
	}

	// A route is consumed when some expression in this scope reads
	// nodes.<id>.outputs.route and compares it with that literal. An
	// expression that reads the route without a literal comparison (e.g. it
	// forwards the value) counts as consuming every route: the compiler cannot
	// prove otherwise, and refusing would be a guess.
	consumed := map[routeKey]bool{}
	wide := map[string]bool{}
	for _, e := range w.plan.Expressions {
		if e.Scope != s.key {
			continue
		}
		for _, r := range e.Refs {
			if r.Root != "nodes" || len(r.Path) != 3 || r.Path[2] != "route" || r.Path[1] != "outputs" {
				continue
			}
			if len(e.Literals) == 0 {
				wide[r.Path[0]] = true
				continue
			}
			for _, lit := range e.Literals {
				consumed[routeKey{r.Path[0], lit}] = true
			}
		}
	}
	keys := make([]routeKey, 0, len(declared))
	for k := range declared {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool {
		if keys[i].node != keys[j].node {
			return keys[i].node < keys[j].node
		}
		return keys[i].name < keys[j].name
	})
	for _, k := range keys {
		if consumed[k] || wide[k.node] {
			continue
		}
		w.err(declared[k], diag.CodeUnreachableTerminal,
			"condition %q declares route %q, but no downstream when selects it: the outcome is unreachable (03 § reachable terminal outcomes)", k.node, k.name)
	}
}

func asListOfMaps(v canonValue) []map[string]canonValue {
	arr, ok := v.([]canonValue)
	if !ok {
		return nil
	}
	out := make([]map[string]canonValue, 0, len(arr))
	for _, e := range arr {
		if m, ok := e.(map[string]canonValue); ok {
			out = append(out, m)
		}
	}
	return out
}

var _ = ptr.Root
