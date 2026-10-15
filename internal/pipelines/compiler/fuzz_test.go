package compiler_test

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/dbirks/communication/internal/pipelines/compiler"
	"github.com/dbirks/communication/internal/pipelines/diag"
	"github.com/dbirks/communication/internal/pipelines/loader"
)

// The two fuzz targets below are contract § 8's property/fuzz row for the
// graph: "node_instance_key grammar" and "DAG/cycle check over generated
// graphs" (spec 12 "Property/fuzz"). Documents are generated as JSON —
// JSON is YAML 1.2's subset, so the loader's parser is exercised too — from
// the fuzz input's bytes, so corpus shrinkage finds the minimal graph that
// breaks something.

// buildGraphDoc renders a Pipeline document with n process.exec nodes whose
// dependsOn sets come from bits of data.
func buildGraphDoc(data []byte) (string, int, map[int][]int) {
	n := 2 + int(data[0])%9 // 2..10 nodes
	depends := map[int][]int{}
	bit := func(i int) bool {
		byteIdx := 1 + i/8
		if byteIdx >= len(data) {
			return false
		}
		return data[byteIdx]&(1<<(i%8)) != 0
	}
	k := 0
	for i := range n {
		for j := range n {
			if i == j {
				continue
			}
			if bit(k) {
				depends[i] = append(depends[i], j)
			}
			k++
		}
	}
	nodes := make([]map[string]any, n)
	for i := range n {
		node := map[string]any{
			"id":     nodeID(i),
			"kind":   "process.exec",
			"config": map[string]any{"executable": "ls"},
		}
		if deps := depends[i]; len(deps) > 0 {
			list := make([]string, len(deps))
			for d, x := range deps {
				list[d] = nodeID(x)
			}
			node["dependsOn"] = list
		}
		nodes[i] = node
	}
	doc := map[string]any{
		"apiVersion": "communication.dev/v1alpha1",
		"kind":       "Pipeline",
		"metadata":   map[string]any{"name": "fuzz-graph"},
		"spec":       map[string]any{"nodes": nodes},
	}
	text, err := json.Marshal(doc)
	if err != nil {
		panic(err)
	}
	return string(text), n, depends
}

func nodeID(i int) string { return "n" + string(rune('0'+i%10)) + strings.Repeat("x", i/10) }

// acyclic answers whether the generated edge set is a DAG via Kahn's
// algorithm — an independent reference the compiler's verdict is compared
// against, so the test does not grade the compiler's homework with the
// compiler's own pen.
func acyclic(n int, depends map[int][]int) bool {
	indeg := map[int]int{}
	children := map[int][]int{}
	for i := range n {
		if _, ok := indeg[i]; !ok {
			indeg[i] = 0
		}
		for _, d := range depends[i] {
			if d == i {
				return false // self edge is its own cycle
			}
			indeg[i]++
			children[d] = append(children[d], i)
		}
	}
	queue := []int{}
	for i := range n {
		if indeg[i] == 0 {
			queue = append(queue, i)
		}
	}
	done := 0
	for len(queue) > 0 {
		x := queue[0]
		queue = queue[1:]
		done++
		for _, c := range children[x] {
			indeg[c]--
			if indeg[c] == 0 {
				queue = append(queue, c)
			}
		}
	}
	return done == n
}

func hasCode(d diag.List, want diag.Code) bool {
	for _, x := range d {
		if x.Code == want {
			return true
		}
	}
	return false
}

// FuzzGraphDAG asserts the cycle check is exact, not approximate: the
// compiler reports cycle_detected on a generated graph iff the graph has a
// cycle; an acyclic graph produces a plan whose TopologicalOrder respects
// every edge, and whose instance keys obey the ADR-0023 § 1 grammar.
func FuzzGraphDAG(f *testing.F) {
	seeds := []string{
		"", // two nodes, no edges
		"\xff",
		"\x02\x01",                // n0 <- n1 one edge
		"\x02\x80",                // cycle: n0->n1->n0
		"\x05\x15\x0a",            // assorted fan-in
		strings.Repeat("\xaa", 8), // dense alternating edges
		strings.Repeat("\xff", 16),
	}
	for _, s := range seeds {
		f.Add([]byte(s))
	}
	f.Fuzz(func(t *testing.T, data []byte) {
		if len(data) == 0 {
			data = []byte{0}
		}
		text, n, depends := buildGraphDoc(data)
		doc, d := loader.Load([]byte(text))
		if !d.Valid() {
			t.Fatalf("the generator produced a document the loader refuses: %v\n%s", d, text)
		}
		plan, d := compiler.Compile(doc, compiler.Options{})
		wantCycle := !acyclic(n, depends)
		if wantCycle {
			if !hasCode(d, diag.CodeCycleDetected) {
				t.Fatalf("a cyclic graph compiled without cycle_detected: %v\n%s", d, text)
			}
			return
		}
		if hasCode(d, diag.CodeCycleDetected) {
			t.Fatalf("an acyclic graph was reported as cyclic: %v\n%s", d, text)
		}
		if !d.Valid() {
			t.Fatalf("a valid acyclic graph drew diagnostics: %v\n%s", d, text)
		}
		sc, ok := plan.FindScope("/")
		if !ok {
			t.Fatal("no root scope in the plan")
		}
		pos := map[string]int{}
		for i, id := range sc.TopologicalOrder {
			pos[id] = i
		}
		if len(pos) != n {
			t.Fatalf("topological order covers %d of %d nodes", len(pos), n)
		}
		for i := range n {
			for _, dep := range depends[i] {
				if pos[nodeID(dep)] >= pos[nodeID(i)] {
					t.Fatalf("topological order violates the edge %s -> %s: %v\n%s", nodeID(dep), nodeID(i), sc.TopologicalOrder, text)
				}
			}
		}
		// node_instance_key grammar (ADR-0023 § 1): /<id> per scope segment,
		// indexed segments carry [n]; root-scope keys are /<id>.
		for _, nd := range plan.Nodes {
			if nd.InstanceKey == "" || nd.InstanceKey[0] != '/' {
				t.Fatalf("instance key %q does not start at a scope root", nd.InstanceKey)
			}
			for _, seg := range strings.Split(strings.TrimPrefix(nd.InstanceKey, "/"), "/") {
				base, _, indexed := strings.Cut(seg, "[")
				if base == "" || strings.ContainsAny(base, " \t") {
					t.Fatalf("instance key segment %q is malformed", seg)
				}
				if open := strings.IndexByte(seg, '['); open >= 0 {
					if !strings.HasSuffix(seg, "]") {
						t.Fatalf("instance key segment %q has a broken index", seg)
					}
					for _, r := range seg[open+1 : len(seg)-1] {
						if r != 'i' && (r < '0' || r > '9') {
							t.Fatalf("instance key index %q is neither numeric nor the ADR-0023 iteration placeholder", seg)
						}
					}
					if !indexed {
						t.Fatalf("segment %q lost its bracket", seg)
					}
				}
			}
			if !strings.Contains(nd.InstanceKey, nd.ID) {
				t.Fatalf("instance key %q does not name the node %q", nd.InstanceKey, nd.ID)
			}
		}
	})
}

// buildNestedForEach renders `depth` levels of for_each bodies around one
// leaf. Scope recursion is where the compiler walks author-shaped trees: the
// property is that it terminates with an answer (a plan or diagnostics) on
// any generated shape, never with a crash — a 1000-node document must not be
// able to recurse 1000 frames deep in a control-plane process (dag.go's own
// promise, here measured). The text is assembled iteratively because
// encoding/json itself refuses >10k nesting — Marshal would test the
// encoder, not the compiler.
func buildNestedForEach(depth int) string {
	var b strings.Builder
	b.WriteString(`{"apiVersion":"communication.dev/v1alpha1","kind":"Pipeline","metadata":{"name":"fuzz-nest"},"spec":{"nodes":[`)
	for i := range depth {
		b.WriteString("{\"id\":\"f")
		b.WriteString(itoa(i))
		b.WriteString(`","kind":"for_each","config":{"items":[],"body":{"nodes":[`)
	}
	b.WriteString(`{"id":"leaf","kind":"process.exec","config":{"executable":"ls"}}`)
	for range depth {
		b.WriteString(`]}}}`) // nodes array, body, config, node object
	}
	b.WriteString(`]}}`) // spec.nodes, spec, root
	return b.String()
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var d []byte
	for n > 0 {
		d = append([]byte{byte('0' + n%10)}, d...)
		n /= 10
	}
	return string(d)
}

// TestTopologicalOrderRespectsReverseDeclaredEdges is the regression pin for
// what FuzzGraphDAG found: a scope whose dependencies are declared *after*
// their dependents must still produce a topological order (TopologicalOrder
// used to be declaration order verbatim).
func TestTopologicalOrderRespectsReverseDeclaredEdges(t *testing.T) {
	text, n, depends := buildGraphDoc([]byte{0x02, 0x01}) // n0 dependsOn n1: declared backwards
	doc, d := loader.Load([]byte(text))
	if !d.Valid() {
		t.Fatal(d)
	}
	plan, d := compiler.Compile(doc, compiler.Options{})
	if !d.Valid() {
		t.Fatalf("%v of %d nodes", d, n)
	}
	sc, _ := plan.FindScope("/")
	pos := map[string]int{}
	for i, id := range sc.TopologicalOrder {
		pos[id] = i
	}
	for i := range n {
		for _, dep := range depends[i] {
			if pos[nodeID(dep)] >= pos[nodeID(i)] {
				t.Fatalf("order %v violates %s -> %s", sc.TopologicalOrder, nodeID(dep), nodeID(i))
			}
		}
	}
}

func FuzzScopeRecursion(f *testing.F) {
	for _, depth := range []int{1, 2, 60, 512, 3000} {
		f.Add(int64(depth))
	}
	f.Fuzz(func(t *testing.T, depth int64) {
		if depth < 1 {
			depth = 1
		}
		if depth > 8000 {
			depth = 8000 // the document bound is the real cap; this keeps the fuzz cheap
		}
		text := buildNestedForEach(int(depth))
		if len(text) > loader.MaxDocumentBytes {
			return // document_too_large is the loader's door, tested in loader
		}
		doc, d := loader.Load([]byte(text))
		if !d.Valid() {
			for _, x := range d {
				if x.Code == "" || x.Message == "" {
					t.Fatalf("refusal without a code/message at depth %d: %v", depth, d)
				}
			}
			return
		}
		plan, d := compiler.Compile(doc, compiler.Options{})
		if !d.Valid() {
			for _, x := range d {
				if x.Code == "" || x.Message == "" {
					t.Fatalf("refusal without a code/message at depth %d: %v", depth, d)
				}
			}
			return
		}
		// A deep nested-body plan keeps the scope-chain grammar: the deepest
		// node's key has one segment per enclosing for_each plus the leaf.
		var deepest string
		for _, nd := range plan.Nodes {
			if nd.ID == "leaf" {
				deepest = nd.InstanceKey
			}
		}
		if got := strings.Count(deepest, "/"); got != int(depth)+1 {
			t.Fatalf("depth %d produced %d slashes in %q, want one per scope (depth+1)", depth, got, deepest)
		}
		if len(plan.Scopes) != int(depth)+1 {
			t.Fatalf("depth %d produced %d scopes, want depth+1", depth, len(plan.Scopes))
		}
	})
}
