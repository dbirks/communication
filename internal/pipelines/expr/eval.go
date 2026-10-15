package expr

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/cel-go/cel"
	"github.com/google/cel-go/common/types"
	"github.com/google/cel-go/common/types/ref"
	"github.com/google/cel-go/common/types/traits"

	"github.com/dbirks/communication/internal/pipelines/canon"
	"github.com/dbirks/communication/internal/pipelines/diag"
	"github.com/dbirks/communication/internal/pipelines/ptr"
)

// EvalTimeout bounds one expression evaluation (contract § 6). A runaway
// comprehension is stopped and attributed to its expression, never to a lost
// process (ADR-0022 § 5).
const EvalTimeout = 200 * time.Millisecond

// Envelope is one evaluation's variables, keyed by the CEL root names. The
// advancer materializes it for **every** declared node in the scope, with
// {status, outcome, outputs:{}, artifact_refs:[]} for anything unscheduled
// (ADR-0022 § 3, contract § 5.1 step 3) — that shape is what makes a reference
// to an unscheduled node resolve instead of faulting.
type Envelope map[string]any

// NodeResult is one node's entry in the envelope.
type NodeResult struct {
	Status       string
	Outcome      string
	Outputs      any
	ArtifactRefs []any
}

// Value renders the node result as the dynamic map CEL reads.
func (n NodeResult) Value() map[string]any {
	outs := n.Outputs
	if outs == nil {
		outs = map[string]any{}
	}
	refs := n.ArtifactRefs
	if refs == nil {
		refs = []any{}
	}
	return map[string]any{
		"status":        n.Status,
		"outcome":       n.Outcome,
		"outputs":       outs,
		"artifact_refs": refs,
	}
}

// Nodes builds the `nodes` root from per-node results.
func Nodes(results map[string]NodeResult) map[string]any {
	out := make(map[string]any, len(results))
	for id, nr := range results {
		out[id] = nr.Value()
	}
	return out
}

// Vars assembles an activation from the roots an evaluation may read. A root
// the scope does not declare is simply absent, which the checker already
// refused at compile time (ADR-0022 § 2: every available root is declared
// statically, so undeclared_root cannot come from the runtime).
func Vars(nodes map[string]any, inputs any, previous any, iteration any, item any) map[string]any {
	out := map[string]any{}
	if nodes != nil {
		out["nodes"] = nodes
	}
	if inputs != nil {
		out["inputs"] = inputs
	}
	if previous != nil {
		out["previous"] = previous
	}
	if iteration != nil {
		out["iteration"] = iteration
	}
	if item != nil {
		out["item"] = item
	}
	return out
}

// Prepared is a checked expression plus the program the runtime evaluates. A
// plan stores the source and the normalized AST once; preparation happens per
// process, outside the advancer's transaction (ADR-0022 § 3).
type Prepared struct {
	Compiled Compiled
	program  cel.Program

	// CostLimit is ADR-0022 § 5's runtime bound: actual cost, not an estimate.
	CostLimit int
	// Timeout bounds one evaluation.
	Timeout time.Duration
}

// Prepare checks and builds one expression for a scope. This is the runtime
// entry point; the plan-side compiler uses Compile, and both go through EnvFor,
// so a worker reaching the same normalized AST is the same check (proven by
// TestNormalizedASTIsStable).
func Prepare(scope Scope, src string, sc ScopeContext) (Prepared, diag.List) {
	// The check is Compile — the same restricted environment, the same
	// reference table, the same normalizer the publish path used. A worker that
	// re-prepares a plan expression reaches the same AST or reports the same
	// diagnostics (ADR-0022 § 5).
	sc.Scope = scope
	c, d := Compile(src, sc, ptr.Root)
	if !d.Valid() {
		return Prepared{}, d
	}
	env, err := EnvFor(scope)
	if err != nil {
		d.Addf(diag.SourceRuntime, diag.CodeCELCompile, ptr.Root, "cannot build the CEL environment: %v", err)
		return Prepared{}, d
	}
	prog, perr := env.Program(c.AST,
		// The budget is a guardrail, not a scheduler: a runaway comprehension
		// stops and the error names its expression instead of a lost process
		// (ADR-0022 § 5).
		cel.CostLimit(EvalCostLimit),
		cel.InterruptCheckFrequency(64),
	)
	if perr != nil {
		d.Addf(diag.SourceRuntime, diag.CodeCELCompile, ptr.Root, "cannot build the program: %v", perr)
		return Prepared{}, d
	}
	return Prepared{
		Compiled:  c,
		program:   prog,
		CostLimit: EvalCostLimit,
		Timeout:   EvalTimeout,
	}, d
}

// Eval runs the expression over an activation and returns a Go value. An
// evaluation failure is returned as an error, never as a false value (contract
// § 5.1 step 6: an expression error is predicate_error, not a business fail).
func (p Prepared) Eval(ctx context.Context, vars map[string]any) (val any, cost int, err error) {
	if p.program == nil {
		return nil, 0, fmt.Errorf("expr: expression is not prepared")
	}
	if p.Timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, p.Timeout)
		defer cancel()
	}
	out, det, rerr := p.program.ContextEval(ctx, vars)
	cost = actualCost(det)
	if rerr != nil {
		return nil, cost, fmt.Errorf("expr: evaluation failed: %w", rerr)
	}
	if e, ok := out.(*types.Err); ok {
		return nil, cost, fmt.Errorf("expr: %w", e.Unwrap())
	}
	v, derr := unwrap(out)
	return v, cost, derr
}

// EvalBool is the predicate path for when / cases / passWhen. A non-boolean
// result is an error rather than a false.
func (p Prepared) EvalBool(ctx context.Context, vars map[string]any) (bool, int, error) {
	v, cost, err := p.Eval(ctx, vars)
	if err != nil {
		return false, cost, err
	}
	b, ok := v.(bool)
	if !ok {
		return false, cost, fmt.Errorf("expr: expected a boolean predicate, got %T", v)
	}
	return b, cost, nil
}

func actualCost(det *cel.EvalDetails) int {
	if det == nil {
		return 0
	}
	c := det.ActualCost()
	if c == nil {
		return 0
	}
	return int(*c)
}

// unwrap converts a CEL value into Go values the canonical encoder can write.
// The missing/empty distinction survives as an absent map key, which is what
// has() draws its line at (ADR-0022 § 3).
func unwrap(v ref.Val) (any, error) {
	if v == nil {
		return nil, nil
	}
	if e, ok := v.(*types.Err); ok {
		return nil, fmt.Errorf("expr: %w", e.Unwrap())
	}
	switch v.Type() {
	case types.BoolType:
		b, _ := v.Value().(bool)
		return b, nil
	case types.IntType:
		i, _ := v.Value().(int64)
		return i, nil
	case types.DoubleType:
		f, _ := v.Value().(float64)
		return f, nil
	case types.StringType:
		s, _ := v.Value().(string)
		return s, nil
	case types.BytesType:
		b, _ := v.Value().([]byte)
		return b, nil
	case types.UintType:
		u, _ := v.Value().(uint64)
		return int64(u), nil
	case types.DurationType, types.TimestampType:
		return v.Value(), nil
	case types.NullType:
		return nil, nil
	case types.ListType:
		idx, ok := v.(traits.Indexer)
		if !ok {
			return v.Value(), nil
		}
		n := 0
		if sz, hasSize := v.(traits.Sizer); hasSize {
			if si, isInt := sz.Size().(types.Int); isInt {
				n = int(si)
			}
		}
		out := make([]any, 0, n)
		for i := 0; i < n; i++ {
			el, err := unwrap(idx.Get(types.Int(i)))
			if err != nil {
				return nil, err
			}
			out = append(out, el)
		}
		return out, nil
	case types.MapType:
		m, ok := v.(traits.Mapper)
		if !ok {
			return v.Value(), nil
		}
		out := map[string]any{}
		it := m.Iterator()
		for it.HasNext() == types.True {
			k := it.Next()
			got, err := unwrap(m.Get(k))
			if err != nil {
				return nil, err
			}
			name, err := unwrap(k)
			if err != nil {
				return nil, err
			}
			out[fmt.Sprint(name)] = got
		}
		return out, nil
	}
	return v.Value(), nil
}

// Stringify renders a result the way a bindingText interpolation joins it:
// canonical JSON for a structured value, bare text for a string (ADR-0022 § 1's
// "a bindingText interpolation may produce any JSON type" needs one join rule).
// ADR-0022 § 1's secret rule means this path can never see a secret: secrets are
// not a root (ADR-0022 § 3), so nothing here can leak one into text.
func Stringify(v any) (string, error) {
	if s, ok := v.(string); ok {
		return s, nil
	}
	if v == nil {
		return "null", nil
	}
	cv, err := toCanonical(v)
	if err != nil {
		return "", err
	}
	b, err := canon.Canonicalize(cv)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

func toCanonical(v any) (canon.Value, error) {
	switch t := v.(type) {
	case nil:
		return nil, nil
	case bool:
		return t, nil
	case string:
		return t, nil
	case int:
		return int64(t), nil
	case int64:
		return t, nil
	case float64:
		return t, nil
	case json.Number:
		if i, err := t.Int64(); err == nil {
			return i, nil
		}
		f, err := t.Float64()
		if err != nil {
			return t.String(), nil
		}
		return f, nil
	case map[string]any:
		out := make(map[string]canon.Value, len(t))
		for k, sub := range t {
			cv, err := toCanonical(sub)
			if err != nil {
				return nil, err
			}
			out[k] = cv
		}
		return out, nil
	case []any:
		out := make([]canon.Value, len(t))
		for i, sub := range t {
			cv, err := toCanonical(sub)
			if err != nil {
				return nil, err
			}
			out[i] = cv
		}
		return out, nil
	}
	return nil, fmt.Errorf("expr: value of type %T cannot enter the canonical tree", v)
}
