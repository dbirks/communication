// Command celprobe exercises the candidate CEL binding subset (cel-go) against
// the expressions the spec's examples actually contain, and records what the
// restricted environment refuses: macros/comprehensions, non-allowlisted
// functions, unknown roots, heterogeneous output maps, missing keys, cost.
package main

import (
	"fmt"
	"sort"
	"strings"

	"github.com/google/cel-go/cel"
	celast "github.com/google/cel-go/common/ast"
	"github.com/google/cel-go/common/types"
	"github.com/google/cel-go/common/types/ref"
)

const costBudget = 200

// allowlist is the proposed M4 function set. Everything else — including
// stdlib members like matches()/type() and any future addition — is refused by
// an AST validator rather than by rebuilding the environment.
var allowlist = map[string]bool{
	"_&&_": true, "_||_": true, "!_": true, "_==_": true, "_!=_": true,
	"_<_": true, "_<=_": true, "_>_": true, "_>=_": true,
	"_+_": true, "_-_": true, "_*_": true, "_/_": true, "_%_": true,
	"_?_:_": true, "@in": true, // the `in` operator compiles to @in, not _in_ (observed)
	"size": true, "contains": true, "startsWith": true, "endsWith": true,
	"string": true, "int": true, "double": true, "bool": true,
	"has": true, // macro, re-enabled explicitly
}

type funcAllowlist struct{}

func (funcAllowlist) Name() string { return "communication.func_allowlist" }

func (funcAllowlist) Validate(_ *cel.Env, _ cel.ValidatorConfig, a *celast.AST, iss *cel.Issues) {
	celast.PostOrderVisit(a.Expr(), celast.NewExprVisitor(func(e celast.Expr) {
		if e.Kind() != celast.CallKind {
			return
		}
		if name := e.AsCall().FunctionName(); !allowlist[name] {
			iss.ReportErrorAtID(e.ID(), "function %q is outside the Communication CEL subset", e.AsCall().FunctionName())
		}
	}))
}

func main() {
	fmt.Println("=== A. restricted env: macros cleared, has() only, function allowlist ===")
	env, err := subset()
	if err != nil {
		panic(err)
	}
	exprs := []string{
		`nodes.review.outputs.approved == true`,
		`nodes.test.outputs.exit_code == 0 && nodes.review.outputs.approved == true`,
		`size(inputs.goal) <= 4096`,
		`has(nodes.review.outputs.approved) && nodes.review.outputs.approved == true`,
		`nodes.review.outputs.findings.size() > 0`,
		`nodes.review.outputs.findings.exists(f, f != "")`,
		`nodes.review.outputs.findings.map(f, f)`,
		`"x".matches(".*")`,
		`now() > 0`,
		`type(nodes.review.outputs.approved) == bool`,
		`nodes.review.outputs.approved ? "go" : "stop"`,
		`"approved" in nodes.review.outputs`,
		`unknown_root.field == 1`,
		`nodes.review.status == 'succeeded' && nodes.review.outputs.approved == true`,
		`inputs.max_retries > 4 - 1`,
	}
	for _, src := range exprs {
		report(env, src)
	}

	fmt.Println("\n=== B. evaluation semantics: missing key, wrong type, null, JSON numbers ===")
	evalCases := []struct {
		name string
		src  string
		vars map[string]any
	}{
		{"approved-true", `nodes.review.outputs.approved == true`, map[string]any{"nodes": map[string]any{"review": map[string]any{"outputs": map[string]any{"approved": true}}}}},
		{"missing-node", `nodes.review.outputs.approved == true`, map[string]any{"nodes": map[string]any{}}},
		{"missing-output-key", `nodes.review.outputs.approved == true`, map[string]any{"nodes": map[string]any{"review": map[string]any{"outputs": map[string]any{}}}}},
		{"string-not-bool", `nodes.review.outputs.approved == true`, map[string]any{"nodes": map[string]any{"review": map[string]any{"outputs": map[string]any{"approved": "yes"}}}}},
		{"json-float-vs-int", `nodes.test.outputs.exit_code == 0`, map[string]any{"nodes": map[string]any{"test": map[string]any{"outputs": map[string]any{"exit_code": float64(0)}}}}},
		{"null-output", `nodes.review.outputs.approved == true`, map[string]any{"nodes": map[string]any{"review": map[string]any{"outputs": map[string]any{"approved": nil}}}}},
		{"guarded-missing", `has(nodes.review.outputs.approved) && nodes.review.outputs.approved == true`, map[string]any{"nodes": map[string]any{"review": map[string]any{"outputs": map[string]any{}}}}},
		{"unguarded-missing-and", `nodes.review.outputs.missing == true && nodes.review.outputs.approved == true`, map[string]any{"nodes": map[string]any{"review": map[string]any{"outputs": map[string]any{"approved": true}}}}},
		{"wrong-root-shape", `inputs.goal == "x"`, map[string]any{"inputs": map[string]any{}}},
	}
	for _, c := range evalCases {
		ast, iss := env.Compile(c.src)
		if iss.Err() != nil {
			fmt.Printf("%-20s compile-err=%v\n", c.name, truncate(iss.Err().Error(), 120))
			continue
		}
		prog, perr := env.Program(ast, cel.CostLimit(costBudget))
		if perr != nil {
			fmt.Printf("%-20s program-err=%v\n", c.name, perr)
			continue
		}
		out, det, eerr := prog.Eval(c.vars)
		fmt.Printf("%-20s result=%-10v cost=%-6v eval-err=%v\n", c.name, outValue(out), costOf(det), errText(eerr))
	}

	fmt.Println("\n=== C. cost: cleared macros vs. permissive env, budget=%d ===")
	list := make([]any, 5000)
	for i := range list {
		list[i] = i
	}
	permissive, err := cel.NewEnv(cel.Variable("items", cel.DynType))
	if err != nil {
		panic(err)
	}
	for _, e := range []struct {
		label string
		env   *cel.Env
		src   string
	}{
		{"restricted-long-chained-eq", env, `nodes.a.outputs.x == 1 && nodes.b.outputs.x == 2 && nodes.c.outputs.x == 3 && nodes.d.outputs.x == 4`},
		{"restricted-comprehension", env, `items.exists(i, i == 4999)`},
		{"permissive-comprehension-5000", permissive, `items.exists(i, i == 4999)`},
		{"permissive-nested-comprehension", permissive, `items.map(i, i * 2).filter(i, i > 9000).size() > 0`},
	} {
		ast, iss := e.env.Compile(e.src)
		if iss.Err() != nil {
			fmt.Printf("%-34s compile-err=%s\n", e.label, truncate(iss.Err().Error(), 150))
			continue
		}
		prg, perr := e.env.Program(ast, cel.CostLimit(costBudget))
		if perr != nil {
			fmt.Printf("%-34s program-err=%v\n", e.label, perr)
			continue
		}
		vars := map[string]any{"items": list, "nodes": map[string]any{
			"a": map[string]any{"outputs": map[string]any{"x": 1}},
			"b": map[string]any{"outputs": map[string]any{"x": 2}},
			"c": map[string]any{"outputs": map[string]any{"x": 3}},
			"d": map[string]any{"outputs": map[string]any{"x": 4}},
		}}
		out, det, eerr := prg.Eval(vars)
		fmt.Printf("%-34s result=%-8v cost=%-8v eval-err=%s\n", e.label, outValue(out), costOf(det), errText(eerr))
	}

	fmt.Println("\n=== D. ${{ }} splitting: what the tokenizer must survive ===")
	for _, s := range []string{
		`Produce a plan for: ${{ inputs.goal }}`,
		`${{ nodes.a.outputs.x }}/${{ nodes.b.outputs.y }}`,
		`literal with no binding`,
		`unterminated ${{ inputs.goal`,
		`nested index ${{ nodes.a.outputs["x"] }}`,
		`${{ }}`,
		`$${{ escaped-looking }}`,
		`${{ inputs.goal }} ${{ inputs.goal }}`,
		`${{ inputs.a }} and ${{ inputs.b }} and ${{ inputs.c }} and ${{ inputs.d }} and ${{ inputs.e }}`,
	} {
		parts, serr := splitBinding(s)
		fmt.Printf("%-72q -> segments=%d %v err=%v\n", s, len(parts), parts, errText(serr))
	}

	fmt.Println("\n=== E. AST round-trip (what a revision digest would pin for expressions) ===")
	for _, src := range []string{
		`nodes.review.outputs.approved == true`,
		`nodes.review.outputs.approved==true`,
		`(nodes.review.outputs.approved) == true`,
		`nodes.review.outputs.approved != false`,
	} {
		ast, iss := env.Compile(src)
		if iss.Err() != nil {
			fmt.Printf("%-46q compile-err=%v\n", src, truncate(iss.Err().Error(), 100))
			continue
		}
		t, aerr := cel.AstToString(ast)
		fmt.Printf("%-46q -> canonical=%-52q err=%v\n", src, t, errText(aerr))
	}
	names := make([]string, 0, len(allowlist))
	for k := range allowlist {
		names = append(names, k)
	}
	sort.Strings(names)
	fmt.Printf("\nallowlist (%d entries): %s\n", len(names), strings.Join(names, " "))
}

func report(env *cel.Env, src string) {
	ast, iss := env.Compile(src)
	if iss.Err() != nil {
		fmt.Printf("%-62s REJECTED at compile: %s\n", truncate(src, 62), truncate(iss.Err().Error(), 190))
		return
	}
	prg, err := env.Program(ast, cel.CostLimit(costBudget))
	if err != nil {
		fmt.Printf("%-62s REJECTED at program: %s\n", truncate(src, 62), truncate(err.Error(), 190))
		return
	}
	vars := map[string]any{
		"inputs": map[string]any{"goal": "ship it", "max_retries": 3},
		"nodes": map[string]any{"review": map[string]any{
			"status":  "succeeded",
			"outputs": map[string]any{"approved": true, "findings": []any{"a"}, "iterations": 2},
		}},
	}
	out, det, eerr := prg.Eval(vars)
	fmt.Printf("%-62s ACCEPTED result=%-8v cost=%v err=%s\n", truncate(src, 62), outValue(out), costOf(det), errText(eerr))
}

// subset builds the proposed M4 CEL environment.
func subset() (*cel.Env, error) {
	return cel.NewEnv(
		cel.ClearMacros(),
		cel.Macros(cel.HasMacro),
		cel.ParserExpressionSizeLimit(2048),
		cel.ExpressionNodeLimit(256),
		cel.ExpressionNestingDepthLimit(16),
		cel.ASTValidators(funcAllowlist{}),
		cel.Variable("inputs", cel.DynType),
		cel.Variable("nodes", cel.DynType),
		cel.Variable("item", cel.DynType),
		cel.Variable("items", cel.DynType),
		cel.Variable("run", cel.DynType),
		cel.Variable("parameters", cel.DynType),
	)
}

// splitBinding is the naive `${{ ... }}` segmenter the spike tests.
func splitBinding(s string) ([]string, error) {
	var out []string
	for len(s) > 0 {
		i := strings.Index(s, "${{")
		if i < 0 {
			return append(out, s), nil
		}
		if i > 0 {
			out = append(out, s[:i])
		}
		rest := s[i+3:]
		j := strings.Index(rest, "}}")
		if j < 0 {
			return nil, fmt.Errorf("unterminated binding")
		}
		expr := strings.TrimSpace(rest[:j])
		if expr == "" {
			return nil, fmt.Errorf("empty binding")
		}
		out = append(out, "EXPR:"+expr)
		s = rest[j+2:]
	}
	return out, nil
}

func costOf(det *cel.EvalDetails) any {
	if det == nil {
		return "-"
	}
	c := det.ActualCost()
	if c == nil {
		return "-"
	}
	return *c
}

func outValue(v ref.Val) any {
	if v == nil {
		return nil
	}
	switch t := v.(type) {
	case types.Bool:
		return bool(t)
	case types.String:
		return string(t)
	case types.Int:
		return int64(t)
	default:
		return fmt.Sprintf("%T", v)
	}
}

func errText(err error) string {
	if err == nil {
		return "-"
	}
	return truncate(err.Error(), 200)
}

func truncate(s string, n int) string {
	s = strings.ReplaceAll(s, "\n", " ")
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
