package compiler

import (
	"sort"
	"strings"

	"github.com/dbirks/communication/internal/pipelines/canon"
	"github.com/dbirks/communication/internal/pipelines/diag"
	"github.com/dbirks/communication/internal/pipelines/expr"
	"github.com/dbirks/communication/internal/pipelines/ptr"
	"github.com/dbirks/communication/internal/pipelines/schema"
)

// scope is the compiler's state for one DAG while it walks.
type scope struct {
	key       string
	parent    string
	owner     string
	kind      string // root | until | for_each | parallel
	nodes     []canon.Value
	nodesAt   ptr.Pointer
	path      []string
	suffix    string
	exprScope expr.Scope
	indexed   []string
	declared  bool
	compiled  bool

	byID     map[string]map[string]canon.Value
	at       map[string]ptr.Pointer
	order    []string
	ids      map[string]bool
	schemas  map[string]*expr.SchemaNode
	engine   map[string][]string
	prevKeys []string

	entry, terminals                           []string
	maxIterations, maxDuration, maxConcurrency int
	onChildFailure                             string
}

// binding splits one authored value according to its schema position and
// compiles every expression it holds. The position comes from the shipped
// schema (schema.Position), so "where does an expression live" has one answer
// per field rather than one per compiler (ADR-0022 § 1, contract § 9.2).
func (w *walk) binding(raw canon.Value, at ptr.Pointer, s *scope, position string) Binding {
	b := Binding{Pointer: string(at), Position: position}
	switch position {
	case schema.PositionSchema, schema.PositionScope, schema.PositionLiteral:
		if str, ok := raw.(string); ok {
			if b2, d := expr.SplitBinding(at, expr.PositionLiteral, str); len(d) > 0 {
				w.diags.Extend(d)
				return b
			} else {
				_ = b2
			}
		}
		b.Literal = raw
		return b
	case schema.PositionValue:
		return w.valueBinding(raw, at, s)
	case schema.PositionText:
		str, ok := raw.(string)
		if !ok {
			b.Literal = raw
			return b
		}
		return w.textBinding(str, at, s)
	case schema.PositionExpression:
		str, ok := raw.(string)
		if !ok {
			w.err(at, diag.CodeBindingSyntax, "an expression field must be a string, got %s", jsonKindName(raw))
			return b
		}
		compiled := w.compile(str, at, s, expr.PositionExpression)
		b.ExprIDs = compiled
		if len(compiled) == 1 {
			b.Template = "%" + compiled[0]
		}
		return b
	}
	b.Literal = raw
	return b
}

// valueBinding handles bindingValue: a whole-value ${{ … }}, the {expr,
// fallback} object, or a plain literal of the declared JSON type.
func (w *walk) valueBinding(raw canon.Value, at ptr.Pointer, s *scope) Binding {
	b := Binding{Pointer: string(at), Position: schema.PositionValue}
	if m, ok := raw.(map[string]canon.Value); ok {
		if _, hasExpr := m["expr"]; hasExpr {
			compiled := w.compile(exprTextOf(m), at.Child("expr"), s, expr.PositionValue)
			b.ExprIDs = compiled
			if len(compiled) == 1 {
				b.Template = "%" + compiled[0]
			}
			if fb, has := m["fallback"]; has {
				b.Fallback = fb
			}
			return b
		}
	}
	if str, ok := raw.(string); ok {
		if isBindingString(str) {
			compiled := w.compile(innerExpr(str), at, s, expr.PositionValue)
			b.ExprIDs = compiled
			if len(compiled) == 1 {
				b.Template = "%" + compiled[0]
			}
			return b
		}
		if strings.Contains(str, "${{") {
			// Text around a binding in a bindingValue slot: ADR-0022 § 1 says
			// this position takes the whole value or nothing.
			b.Literal = raw
			_, d := expr.SplitBinding(at, expr.PositionValue, str)
			w.diags.Extend(d)
			return b
		}
	}
	b.Literal = raw
	return b
}

// textBinding handles bindingText: literal text with zero or more
// interpolations, each of which may produce any JSON type (ADR-0022 § 1).
func (w *walk) textBinding(str string, at ptr.Pointer, s *scope) Binding {
	b := Binding{Pointer: string(at), Position: schema.PositionText}
	if !strings.Contains(str, "${{") {
		b.Literal = str
		b.Template = str
		return b
	}
	segs, d := splitText(at, str)
	if len(d) > 0 {
		w.diags.Extend(d)
		return b
	}
	var tmpl strings.Builder
	for _, seg := range segs {
		if !seg.IsExpr {
			tmpl.WriteString(seg.Literal)
			continue
		}
		ids := w.compile(seg.Expression, at, s, expr.PositionText)
		if len(ids) == 1 {
			tmpl.WriteString("%" + ids[0])
			b.ExprIDs = append(b.ExprIDs, ids...)
		}
	}
	b.Template = tmpl.String()
	return b
}

// compile checks one expression source and registers it in the plan, returning
// its id. An empty slice means the expression was refused (diags carry why).
func (w *walk) compile(src string, at ptr.Pointer, s *scope, pos expr.Position) []string {
	sc := s.context(w)
	c, d := expr.Compile(src, sc, at)
	if len(d) > 0 {
		w.diags.Extend(d)
		return nil
	}
	if pos == expr.PositionExpression && !c.BoolResult {
		// ADR-0022 § 1: an expression position must type-check to bool.
		w.err(at, diag.CodeNonBoolean,
			"this field must produce a boolean: the expression is %s (guard an optional output with has(x.y) && x.y == true, or compare it)",
			orDyn(c.ResultTypeName()))
		return nil
	}
	w.exprSeq++
	if len(w.plan.Expressions) >= w.budgets.ExpressionsPerRevision {
		// ADR-0022 § 5: the per-revision cap is what bounds a fan-out graph's
		// compile, and exceeding it is a validate error rather than a runtime
		// surprise.
		w.err(at, diag.CodeExpressionBudget,
			"the document needs more than %d compiled expressions (ADR-0022 § 5)", w.budgets.ExpressionsPerRevision)
		return nil
	}
	id := exprID(w.exprSeq)
	w.plan.Expressions = append(w.plan.Expressions, Expression{
		ID:            id,
		Pointer:       string(at),
		Scope:         s.key,
		Position:      schema.PositionText,
		Source:        c.Source,
		NormalizedAST: c.Normalized,
		Refs:          toRefs(c.Refs),
		Literals:      c.LiteralStrings(),
		ResultType:    c.ResultTypeName(),
		BoolPredicate: c.BoolResult,
		Cost:          CostEstimate{Nodes: c.NodeCount(), ActualLimit: expr.EvalCostLimit},
	})
	// The recorded position is the real one, not the default.
	w.plan.Expressions[len(w.plan.Expressions)-1].Position = pos.String()
	return []string{id}
}

func exprID(n int) string { return "e" + itoa(n) }

// context builds the CEL scope context for a scope: which roots exist and what
// the declared output schemas say.
func (s *scope) context(w *walk) expr.ScopeContext {
	return expr.ScopeContext{
		Scope:         s.exprScope,
		Nodes:         s.schemas,
		Inputs:        w.inputs,
		PreviousKeys:  s.prevKeys,
		EngineOutputs: s.engine,
		ScopeKey:      s.key,
		WhereIsNode:   func(id string) []string { return w.declaredIDs[id] },
	}
}

// resultBindings compiles a resultBindings map, keeping the output names.
func (w *walk) resultBindings(rb map[string]canon.Value, at ptr.Pointer, s *scope) []NamedBinding {
	names := make([]string, 0, len(rb))
	for k := range rb {
		names = append(names, k)
	}
	sort.Strings(names)
	out := make([]NamedBinding, 0, len(names))
	for _, name := range names {
		out = append(out, NamedBinding{
			Name:    name,
			Binding: w.binding(rb[name], at.Child(name), s, schema.PositionValue),
		})
	}
	return out
}

// configValues walks a node's config subtree, compiling every string by its
// schema position. Bodies and resultBindings are the composite's own business
// and are compiled in the body scope instead.
func (w *walk) configValues(cfg map[string]canon.Value, at ptr.Pointer, s *scope, kind string) []Binding {
	if cfg == nil {
		return nil
	}
	keys := make([]string, 0, len(cfg))
	for k := range cfg {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var out []Binding
	for _, k := range keys {
		switch k {
		case "body", "branches", "responseSchema", "outputSchema", "outputs":
			// a nested schema or scope, not a value
			continue
		case "resultBindings", "passWhen", "failWhen":
			// A composite's own predicates and outputs are evaluated over the
			// body's envelope, so the owner compiled them against the child
			// scope already. Compiling them again in the parent would put the
			// same text in two scopes and give the plan two digests for one
			// expression.
			continue
		}
		out = append(out, w.valueTree(cfg[k], at.Child(k), s)...)
	}
	return out
}

// valueTree walks an object or array whose members each carry their own
// binding position (config.env, config.args, workspace.repositories, inputs).
func (w *walk) valueTree(v canon.Value, at ptr.Pointer, s *scope) []Binding {
	var out []Binding
	switch t := v.(type) {
	case map[string]canon.Value:
		keys := sortedKeysValue(t)
		for _, k := range keys {
			out = append(out, w.valueTree(t[k], at.Child(k), s)...)
		}
		return out
	case []canon.Value:
		for i, el := range t {
			out = append(out, w.valueTree(el, at.Index(i), s)...)
		}
		return out
	}
	position := schema.Position(w.doc, at)
	b := w.binding(v, at, s, position)
	if !b.IsLiteral() || position != schema.PositionLiteral {
		out = append(out, b)
	}
	return out
}

// toRefs converts expr references into plan references.
func toRefs(in []expr.Reference) []Ref {
	out := make([]Ref, 0, len(in))
	for _, r := range in {
		out = append(out, Ref{Root: r.Root, Path: append([]string(nil), r.Path...), Guard: r.Guard})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Key() < out[j].Key() })
	return out
}

func isBindingString(s string) bool {
	if !strings.HasPrefix(s, "${{") {
		return false
	}
	if !strings.HasSuffix(s, "}}") {
		return false
	}
	return strings.Index(s, "${{") == 0 && strings.LastIndex(s, "}}") == len(s)-2 &&
		strings.Count(s, "${{") == 1
}

func innerExpr(s string) string {
	return strings.TrimSpace(strings.TrimSuffix(strings.TrimPrefix(s, "${{"), "}}"))
}

func exprTextOf(m map[string]canon.Value) string {
	if e, ok := m["expr"].(string); ok {
		return e
	}
	return ""
}

// splitText is the bindingText splitter: ADR-0022 § 1's positions differ in
// what they accept, and the errors are the contract's.
func splitText(at ptr.Pointer, s string) ([]expr.Segment, diag.List) {
	b, d := expr.SplitBinding(at, expr.PositionText, s)
	return b.Segments, d
}

func orDyn(s string) string {
	if s == "" {
		return "dyn"
	}
	return s
}

func jsonKindName(v canon.Value) string {
	switch v.(type) {
	case string:
		return "a string"
	case map[string]canon.Value:
		return "an object"
	case []canon.Value:
		return "an array"
	case nil:
		return "null"
	default:
		return "a scalar"
	}
}

var _ = strings.Join
