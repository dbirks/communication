package runtime

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"sort"
	"strconv"
	"strings"

	"github.com/dbirks/communication/internal/pipelines/compiler"
	"github.com/dbirks/communication/internal/pipelines/diag"
	"github.com/dbirks/communication/internal/pipelines/expr"
	"github.com/dbirks/communication/internal/pipelines/ptr"
)

// Program holds one plan's expressions prepared for evaluation. The plan
// stores source and normalized AST once; preparation happens per process,
// outside the advancer's transaction (ADR-0022 § 3), and goes through the
// same restricted environment the publish path used — so a plan that drifted
// from its digests fails here, loudly, rather than evaluating differently.
type Program struct {
	plan *compiler.Plan

	scopes map[string]*compiler.Scope
	nodes  map[string]map[string]*compiler.Node // scope key → node id → node
	exprs  map[string]*compiler.Expression
	preps  map[string]*expr.Prepared
	ctxs   map[string]expr.ScopeContext
	cel    map[string]expr.Scope // plan scope key → CEL root set
}

// PreparePlan compiles-and-programs every expression in the plan. Non-empty
// diagnostics mean the snapshot cannot execute: a run must refuse to start
// rather than evaluate an expression its revision would have refused to
// publish (ADR-0023 § 2: planning happened once, at publish).
func PreparePlan(plan *compiler.Plan) (*Program, diag.List) {
	p := &Program{
		plan:   plan,
		scopes: map[string]*compiler.Scope{},
		nodes:  map[string]map[string]*compiler.Node{},
		exprs:  map[string]*compiler.Expression{},
		preps:  map[string]*expr.Prepared{},
		ctxs:   map[string]expr.ScopeContext{},
		cel:    map[string]expr.Scope{},
	}
	for i := range plan.Scopes {
		s := &plan.Scopes[i]
		p.scopes[s.Key] = s
		if p.nodes[s.Key] == nil {
			p.nodes[s.Key] = map[string]*compiler.Node{}
		}
	}
	for i := range plan.Nodes {
		n := &plan.Nodes[i]
		if p.nodes[n.Scope] == nil {
			p.nodes[n.Scope] = map[string]*compiler.Node{}
		}
		p.nodes[n.Scope][n.ID] = n
	}
	for i := range plan.Expressions {
		e := &plan.Expressions[i]
		p.exprs[e.ID] = e
	}
	// WhereIsNode is the compiler's, rebuilt from the plan: the runtime knows
	// every scope that declares a node id.
	where := func(id string) []string {
		var out []string
		for _, n := range plan.Nodes {
			if n.ID == id {
				out = append(out, n.Scope)
			}
		}
		return out
	}
	for key, s := range p.scopes {
		p.cel[key] = celScope(s.ExpressionScope)
		ctx := expr.ScopeContext{
			Scope:         p.cel[key],
			Nodes:         map[string]*expr.SchemaNode{},
			EngineOutputs: map[string][]string{},
			ScopeKey:      key,
			WhereIsNode:   where,
		}
		for id, n := range p.nodes[key] {
			ctx.Nodes[id] = expr.SchemaFromJSON(n.Outputs)
			if len(n.EngineOutputs) > 0 {
				ctx.EngineOutputs[id] = n.EngineOutputs
			}
		}
		if key != ScopeRoot {
			// `previous` is exactly the enclosing until's resultBindings names
			// (ADR-0023 § 8); the plan carries them on the owner node.
			if owner, ok := p.ownerNode(s); ok {
				for _, rb := range owner.ResultBindings {
					ctx.PreviousKeys = append(ctx.PreviousKeys, rb.Name)
				}
				sort.Strings(ctx.PreviousKeys)
			}
		} else {
			ctx.Inputs = expr.SchemaFromJSON(plan.Inputs)
		}
		// Non-root scopes also read inputs and run; the compiler checked the
		// same thing with the same context shape.
		if key != ScopeRoot {
			ctx.Inputs = expr.SchemaFromJSON(plan.Inputs)
		}
		p.ctxs[key] = ctx
	}
	var diags diag.List
	for _, e := range plan.Expressions {
		scopeKey := e.Scope
		if p.scopes[scopeKey] == nil {
			diags.Addf(diag.SourceRuntime, diag.CodeCELCompile, ptr.Root,
				"expression %s names scope %q, which the plan does not declare", e.ID, scopeKey)
			continue
		}
		prep, d := expr.Prepare(p.cel[scopeKey], e.Source, p.ctxs[scopeKey])
		if len(d) > 0 {
			diags.Extend(d)
			continue
		}
		prepCopy := prep
		p.preps[e.ID] = &prepCopy
	}
	return p, diags
}

// EmptyPlanSnapshot reports the bytes a run row carries when it pins no plan
// at all: NULL, the empty string, or jsonb's empty object. Hand-seeded rows
// (schema tests, fixtures) look like this; a run created through the API
// never does.
func EmptyPlanSnapshot(raw []byte) bool {
	t := bytes.TrimSpace(raw)
	return len(t) == 0 || string(t) == "{}" || string(t) == "null"
}

// PreparePlanSnapshot rebuilds the Program one run executes from its stored
// plan_snapshot bytes (ADR-0023 § 2: the run runs the plan it pinned, and
// nothing else). The snapshot is the compiler's canonical JSON, so decoding
// it back into the plan's untyped (canon.Value) positions yields JSON numbers
// — restoreSnapshotNumbers puts them back in the engine's numeric model
// (integers are int64) exactly as the compiler's own normalization left them.
// Non-empty diagnostics mean the snapshot cannot execute: the caller refuses
// the run rather than evaluating an expression its revision would have
// refused to publish. (nil, nil) means the row pins a placeholder that carries
// no plan at all, which is not corruption — see the scope test below.
func PreparePlanSnapshot(raw []byte) (*Program, diag.List) {
	if EmptyPlanSnapshot(raw) {
		return nil, diag.List{{
			Code:   diag.CodeUnknownDocument,
			Source: diag.SourceRuntime,
			Message: "run pins no plan snapshot: there is nothing for the " +
				"advancer to execute",
		}}
	}
	var plan compiler.Plan
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&plan); err != nil {
		return nil, diag.List{{
			Code:    diag.CodeUnknownDocument,
			Source:  diag.SourceRuntime,
			Message: fmt.Sprintf("plan snapshot is not a readable plan: %v", err),
		}}
	}
	if plan.Version != "" && plan.Version != compiler.PlanVersion {
		return nil, diag.List{{
			Code:   diag.CodeUnknownDocument,
			Source: diag.SourceRuntime,
			Message: fmt.Sprintf("plan snapshot version %q is not executable by this engine (%q)",
				plan.Version, compiler.PlanVersion),
		}}
	}
	if len(plan.Scopes) == 0 {
		// A placeholder, not a plan: the compiler always emits the root scope,
		// so a snapshot declaring none is a hand-seeded fixture row
		// (`{"nodes":[]}`, the shape several stores' tests pin). No program is
		// rebuilt; the caller decides whether its wired advancer stands in.
		return nil, nil
	}
	restoreSnapshotNumbers(reflect.ValueOf(&plan).Elem())
	return PreparePlan(&plan)
}

// restoreSnapshotNumbers walks a decoded plan and replaces every JSON number
// that reached an untyped (canon.Value / any) position with the engine's own
// numeric model — int64 when the literal is integral, float64 otherwise.
// Reflection rather than a field list: new untyped plan fields are covered by
// construction instead of by remembering to add them here.
func restoreSnapshotNumbers(v reflect.Value) {
	switch v.Kind() {
	case reflect.Interface:
		if v.IsNil() {
			return
		}
		if n, ok := v.Interface().(json.Number); ok {
			if !v.CanSet() {
				return
			}
			if i, err := n.Int64(); err == nil {
				v.Set(reflect.ValueOf(i))
				return
			}
			if f, err := n.Float64(); err == nil {
				v.Set(reflect.ValueOf(f))
				return
			}
			v.Set(reflect.ValueOf(n.String()))
			return
		}
		restoreSnapshotNumbers(v.Elem())
	case reflect.Pointer:
		if !v.IsNil() {
			restoreSnapshotNumbers(v.Elem())
		}
	case reflect.Struct:
		for i := 0; i < v.NumField(); i++ {
			restoreSnapshotNumbers(v.Field(i))
		}
	case reflect.Slice, reflect.Array:
		for i := 0; i < v.Len(); i++ {
			restoreSnapshotNumbers(v.Index(i))
		}
	case reflect.Map:
		for _, k := range v.MapKeys() {
			elem := v.MapIndex(k)
			if !elem.IsValid() || elem.Kind() != reflect.Interface {
				continue
			}
			fresh := reflect.New(elem.Type()).Elem()
			fresh.Set(elem)
			restoreSnapshotNumbers(fresh)
			v.SetMapIndex(k, fresh)
		}
	}
}

func (p *Program) ownerNode(s *compiler.Scope) (*compiler.Node, bool) {
	if s.Owner == "" {
		return nil, false
	}
	n, ok := p.nodes[s.Parent][s.Owner]
	return n, ok
}

// Plan exposes the underlying plan snapshot.
func (p *Program) Plan() *compiler.Plan { return p.plan }

// ScopeNodes lists a scope's plan nodes in the plan's topological order.
func (p *Program) ScopeNodes(scopeKey string) []*compiler.Node {
	s, ok := p.scopes[scopeKey]
	if !ok {
		return nil
	}
	out := make([]*compiler.Node, 0, len(s.TopologicalOrder))
	for _, id := range s.TopologicalOrder {
		if n := p.nodes[scopeKey][id]; n != nil {
			out = append(out, n)
		}
	}
	return out
}

// Scope returns a plan scope by key.
// PlanNode returns the plan node for a row's declared scope and node id.
func (p *Program) PlanNode(scopeKey, nodeID string) *compiler.Node {
	return p.nodes[scopeKey][nodeID]
}

func (p *Program) Scope(key string) (compiler.Scope, bool) {
	s, ok := p.scopes[key]
	if !ok {
		return compiler.Scope{}, false
	}
	return *s, true
}

func celScope(name string) expr.Scope {
	switch name {
	case "for_each":
		return expr.ScopeForEach
	case "until":
		return expr.ScopeUntil
	case "template":
		return expr.ScopeTemplate
	default:
		return expr.ScopePipeline
	}
}

// ------------------------------------------------------------- evaluation

// BudgetExceeded reports the per-run expression cap (contract § 6: 10 000
// evaluations; exceeding it fails the run with a named cause, never silently
// truncates a scope).
type BudgetExceeded struct{ Limit int }

func (e BudgetExceeded) Error() string {
	return fmt.Sprintf("runtime: the run exceeded its %d expression evaluations", e.Limit)
}

// PredicateError is a CEL evaluation failure at an advancer predicate site.
// ADR-0022 § 3: an error is never a false. Detail is the only CEL text that
// may reach the journal, bounded to 512 bytes and redaction-scanned by the
// store writer (contract § 3).
type PredicateError struct {
	ExprID string
	Detail string
	Err    error
}

func (e PredicateError) Error() string {
	return fmt.Sprintf("runtime: expression %s failed: %v", e.ExprID, e.Err)
}

func boundedDetail(s string) string {
	if len(s) > 512 {
		return s[:512]
	}
	return s
}

// Evaluator evaluates expressions for one run: every evaluation increments
// the run's counter (runs.expression_evaluations) and the per-run cap is
// enforced here so no caller can forget it.
type Evaluator struct {
	Prog *Program
	ST   *State
}

func (ev Evaluator) eval(id string, vars map[string]any) (any, error) {
	prep, ok := ev.Prog.preps[id]
	if !ok {
		return nil, fmt.Errorf("runtime: expression %s is not prepared", id)
	}
	ev.ST.Run.ExpressionEvaluations++
	if lim := ev.Prog.plan.Budgets.EvaluationsPerRun; lim > 0 && ev.ST.Run.ExpressionEvaluations > lim {
		return nil, BudgetExceeded{Limit: lim}
	}
	v, _, err := prep.Eval(context.Background(), vars)
	if err != nil {
		return nil, PredicateError{ExprID: id, Detail: boundedDetail(err.Error()), Err: err}
	}
	return v, nil
}

// EvalBool evaluates a predicate position (when / cases / passWhen / failWhen).
func (ev Evaluator) EvalBool(b *compiler.Binding, vars map[string]any) (bool, error) {
	if b == nil {
		return true, nil // an absent predicate is "always"
	}
	if b.IsLiteral() {
		// A literal in a bare-expression position was author-checked to a
		// bool-ish value; treat a true literal as true, everything else as a
		// refusal (the compiler's non_boolean_expression owns authoring).
		if v, ok := b.Literal.(bool); ok {
			return v, nil
		}
		return false, fmt.Errorf("runtime: literal %v is not a boolean predicate", b.Literal)
	}
	id := b.ExprIDs[0]
	v, err := ev.eval(id, vars)
	if err != nil {
		return false, err
	}
	bv, ok := v.(bool)
	if !ok {
		return false, PredicateError{ExprID: id, Detail: "non-boolean predicate result",
			Err: fmt.Errorf("got %T", v)}
	}
	return bv, nil
}

// Resolve evaluates one binding to a Go value. bindingText joins its
// template's %eN references with expr.Stringify (canonical JSON for a
// structured value, bare text for a string); bindingValue takes the whole
// value or its authored fallback; expression returns the boolean.
func (ev Evaluator) Resolve(b compiler.Binding, vars map[string]any) (any, error) {
	if b.IsLiteral() {
		return b.Literal, nil
	}
	switch b.Position {
	case "expression":
		return ev.eval(b.ExprIDs[0], vars)
	case "bindingValue":
		v, err := ev.eval(b.ExprIDs[0], vars)
		if err != nil {
			// The {expr, fallback} object's fallback is consulted on an
			// evaluation error (ADR-0022 § 1) — and only then.
			if b.Fallback != nil {
				return b.Fallback, nil
			}
			return nil, err
		}
		return v, nil
	default: // bindingText
		return ev.joinText(b, vars)
	}
}

func (ev Evaluator) joinText(b compiler.Binding, vars map[string]any) (any, error) {
	tmpl := b.Template
	if tmpl == "" {
		tmpl = fmt.Sprint(b.Literal)
	}
	// Longest id first so "%e24" is never read as "%e2" + "4".
	ids := append([]string{}, b.ExprIDs...)
	sort.Slice(ids, func(i, j int) bool { return len(ids[i]) > len(ids[j]) })
	var out strings.Builder
	for i := 0; i < len(tmpl); {
		if tmpl[i] != '%' {
			out.WriteByte(tmpl[i])
			i++
			continue
		}
		matched := false
		for _, id := range ids {
			want := "%" + id
			if strings.HasPrefix(tmpl[i:], want) {
				v, err := ev.eval(id, vars)
				if err != nil {
					return nil, err
				}
				s, serr := expr.Stringify(v)
				if serr != nil {
					return nil, serr
				}
				out.WriteString(s)
				i += len(want)
				matched = true
				break
			}
		}
		if !matched {
			out.WriteByte(tmpl[i])
			i++
		}
	}
	return out.String(), nil
}

// EvalBindings evaluates every named resultBinding into a result map
// (resultBindings and spec.resultBindings share this path).
func (ev Evaluator) EvalBindings(named []compiler.NamedBinding, vars map[string]any) (map[string]any, error) {
	out := map[string]any{}
	for _, nb := range named {
		v, err := ev.Resolve(nb.Binding, vars)
		if err != nil {
			return nil, err
		}
		out[nb.Name] = v
	}
	return out, nil
}

// ------------------------------------------------------------------ config

// configLeaf is one position in a node's compiled config: either a literal
// tree value or an unresolved binding. Arrays and objects are rebuilt from
// the binding pointers' path segments.
type configLeaf struct {
	binding *compiler.Binding
	value   any
}

// ConfigTree reconstructs a node's config object with compiler.Binding leaves
// left in place, so kind handlers can evaluate exactly the fields their
// semantics require (a condition's cases must short-circuit in authored order;
// an approval's summary is interpolated once, at gate creation).
func ConfigTree(n *compiler.Node) (any, error) {
	type node struct {
		kids    map[string]*node
		arr     map[int]*node
		leaf    configLeaf
		isArr   bool
		hasLeaf bool
	}
	root := &node{kids: map[string]*node{}, arr: map[int]*node{}}
	for i := range n.ConfigBindings {
		b := &n.ConfigBindings[i]
		segs, err := configSegments(b.Pointer)
		if err != nil {
			return nil, err
		}
		cur := root
		for _, s := range segs {
			if idx, numErr := strconv.Atoi(s); numErr == nil {
				if cur.arr == nil {
					cur.arr = map[int]*node{}
				}
				if cur.arr[idx] == nil {
					cur.arr[idx] = &node{kids: map[string]*node{}, arr: map[int]*node{}}
				}
				cur.isArr = true
				cur = cur.arr[idx]
				continue
			}
			if cur.kids == nil {
				cur.kids = map[string]*node{}
			}
			if cur.kids[s] == nil {
				cur.kids[s] = &node{kids: map[string]*node{}, arr: map[int]*node{}}
			}
			cur = cur.kids[s]
		}
		cur.leaf = configLeaf{binding: b}
		cur.hasLeaf = true
	}
	var build func(c *node) (any, error)
	build = func(c *node) (any, error) {
		if c.hasLeaf {
			return c.leaf, nil
		}
		if c.isArr && len(c.arr) > 0 {
			idxs := make([]int, 0, len(c.arr))
			for i := range c.arr {
				idxs = append(idxs, i)
			}
			sort.Ints(idxs)
			if idxs[0] != 0 || idxs[len(idxs)-1] != len(idxs)-1 {
				return nil, fmt.Errorf("runtime: config array is not dense (indices %v)", idxs)
			}
			out := make([]any, 0, len(idxs))
			for _, i := range idxs {
				v, err := build(c.arr[i])
				if err != nil {
					return nil, err
				}
				out = append(out, v)
			}
			return out, nil
		}
		out := map[string]any{}
		for k, kid := range c.kids {
			v, err := build(kid)
			if err != nil {
				return nil, err
			}
			out[k] = v
		}
		return out, nil
	}
	return build(root)
}

// configSegments strips the "/spec/nodes/<i>/config" document prefix from a
// binding pointer, leaving the path inside the config object.
func configSegments(pointer string) ([]string, error) {
	const marker = "/config/"
	// LAST occurrence: a body node's pointer embeds the enclosing composite's
	// own "/config/" prefix ("…/config/body/nodes/0/config/inputs/issue"),
	// and the path inside THIS node's config starts at the final one.
	i := strings.LastIndex(pointer, marker)
	if i < 0 {
		return nil, fmt.Errorf("runtime: binding pointer %q is not inside a node config", pointer)
	}
	rest := pointer[i+len(marker):]
	if rest == "" {
		return nil, fmt.Errorf("runtime: binding pointer %q names the config object itself", pointer)
	}
	return strings.Split(rest, "/"), nil
}

// ResolveConfig walks a ConfigTree and evaluates every bindingValue/bindingText
// leaf against vars; expression-position leaves are returned unresolved (still
// configLeaf) for the kinds that own their evaluation order.
func (ev Evaluator) ResolveConfig(tree any, vars map[string]any) (any, error) {
	switch t := tree.(type) {
	case configLeaf:
		if t.binding == nil {
			return t.value, nil
		}
		if t.binding.Position == "expression" {
			return t, nil // left for the kind handler
		}
		return ev.Resolve(*t.binding, vars)
	case []any:
		out := make([]any, len(t))
		for i, v := range t {
			r, err := ev.ResolveConfig(v, vars)
			if err != nil {
				return nil, err
			}
			out[i] = r
		}
		return out, nil
	case map[string]any:
		out := map[string]any{}
		for k, v := range t {
			r, err := ev.ResolveConfig(v, vars)
			if err != nil {
				return nil, err
			}
			out[k] = r
		}
		return out, nil
	}
	return tree, nil
}

// ConfigString reads a resolved config leaf as a string.
func ConfigString(v any) (string, bool) {
	s, ok := v.(string)
	return s, ok
}

// ConfigInt reads a resolved config leaf as an integer (canonical JSON may
// carry int64 or float64).
func ConfigInt(v any) (int, bool) {
	switch t := v.(type) {
	case int:
		return t, true
	case int64:
		return int(t), true
	case float64:
		return int(t), true
	}
	return 0, false
}

// ConfigSlice reads a resolved config leaf as a list.
func ConfigSlice(v any) ([]any, bool) {
	if l, ok := v.([]any); ok {
		return l, true
	}
	return nil, false
}
