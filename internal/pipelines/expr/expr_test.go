package expr_test

import (
	"context"
	"strconv"
	"strings"
	"testing"

	"github.com/dbirks/communication/internal/pipelines/diag"
	"github.com/dbirks/communication/internal/pipelines/expr"
	"github.com/dbirks/communication/internal/pipelines/ptr"
)

// spikeAccepted and spikeRejected come from
// docs/compatibility/m4-spike/results-cel.txt section A, where the spike's
// celprobe ran the restricted environment against each subset case. They are the
// spike's evidence, not this package's opinion: the accepted list must compile,
// and every rejected one must be refused for the reason the probe observed.
var spikeAccepted = []struct {
	src  string
	refs []string
}{
	{"nodes.review.outputs.approved == true", []string{"nodes.review.outputs.approved"}},
	{"size(inputs.goal) <= 4096", []string{"inputs.goal"}},
	{"nodes.review.outputs.findings.size() > 0", []string{"nodes.review.outputs.findings"}},
	{`nodes.review.status == 'succeeded' && nodes.review.outputs.approved == true`,
		[]string{"nodes.review.status", "nodes.review.outputs.approved"}},
	{"inputs.max_retries > 4 - 1", []string{"inputs.max_retries"}},
}

var spikeRejected = []struct {
	src  string
	code diag.Code
}{
	// Cleared macros and the function allowlist (ADR-0022 § 4).
	// The spike saw cel-go's raw "undeclared reference" text for a cleared macro;
	// this build classifies it as the subset refusal it actually is, so the
	// author is told which door was locked (contract § 9.1 row 8).
	{`nodes.review.outputs.findings.exists(f, f != "")`, diag.CodeFunctionNotAllowed},
	{`nodes.review.outputs.findings.map(f, f)`, diag.CodeFunctionNotAllowed},
	{`"x".matches(".*")`, diag.CodeFunctionNotAllowed},
	{"now() > 0", diag.CodeFunctionNotAllowed},
	{`type(nodes.review.outputs.approved) == bool`, diag.CodeFunctionNotAllowed},
	// Every available root is declared statically, so a wrong name is a compile
	// error rather than a runtime fault (ADR-0022 § 2).
	{"unknown_root.field == 1", diag.CodeUndeclaredRoot},
}

func pipelineCtx() expr.ScopeContext {
	return expr.ScopeContext{
		Scope: expr.ScopePipeline,
		Nodes: map[string]*expr.SchemaNode{
			"review": expr.OpenSchema(),
			"test":   expr.OpenSchema(),
		},
		Inputs:   expr.OpenSchema(),
		ScopeKey: "/",
	}
}

func TestSpikeAcceptedCasesCompile(t *testing.T) {
	for _, c := range spikeAccepted {
		t.Run(c.src, func(t *testing.T) {
			got, d := expr.Compile(c.src, pipelineCtx(), ptr.Root)
			if !d.Valid() {
				t.Fatalf("refused a case the spike accepted: %v", d)
			}
			if !got.BoolResult {
				t.Errorf("BoolResult = false for a predicate")
			}
			have := map[string]bool{}
			for _, r := range got.Refs {
				have[r.Key()] = true
			}
			for _, want := range c.refs {
				if !have[want] {
					t.Errorf("reference %s missing from %v", want, have)
				}
			}
		})
	}
}

func TestSpikeRejectedCasesAreRefused(t *testing.T) {
	for _, c := range spikeRejected {
		t.Run(c.src, func(t *testing.T) {
			_, d := expr.Compile(c.src, pipelineCtx(), ptr.Root)
			if d.Valid() {
				t.Fatal("an expression the spike rejected compiled")
			}
			found := false
			for _, x := range d {
				if x.Code == c.code {
					found = true
				}
			}
			if !found {
				t.Fatalf("codes = %v, want %s", d, c.code)
			}
		})
	}
}

// TestAllowlistIsTheOnlyDoor states ADR-0022 § 4 plainly. The subset is the
// exact name set ADR-0022 § 5 lists — sixteen operator spellings ("the
// operator spellings are CEL's, not ours", incl. `_/_` and `@in`) plus the
// nine named functions has/size/contains/startsWith/endsWith/string/int/
// double/bool: twenty-five in total. The contract's earlier "21" counted only
// the ADR's prose list and is reconciled here against the ADR itself, which
// names all twenty-five (contract § 9.1 defers to ADR-0022 for the subset).
// The set is pinned exactly so an accidental env widening is a test failure
// rather than a quiet capability increase.
func TestAllowlistIsTheOnlyDoor(t *testing.T) {
	want := map[string]bool{
		"_&&_": true, "_||_": true, "!_": true, "_==_": true, "_!=_": true,
		"_<_": true, "_<=_": true, "_>_": true, "_>=_": true,
		"_+_": true, "_-_": true, "_*_": true, "_/_": true, "_%_": true,
		"_?_:_": true, "@in": true,
		"has": true, "size": true, "contains": true, "startsWith": true, "endsWith": true,
		"string": true, "int": true, "double": true, "bool": true,
	}
	got := expr.AllowedFunctions()
	if len(got) != len(want) {
		t.Fatalf("allowlist has %d entries, want %d: %v", len(got), len(want), got)
	}
	for _, name := range got {
		if !want[name] {
			t.Fatalf("%q is not in ADR-0022 § 5's allowlist", name)
		}
	}
	for _, banned := range []string{"exec", "eval", "printf", "format", "matches", "now", "type", "exists", "map", "filter", "all", "sort", "transformValue", "toInt", "to string", "_[_]"} {
		for _, allowed := range expr.AllowedFunctions() {
			if allowed == banned {
				t.Fatalf("%q must not be reachable", banned)
			}
		}
	}
}

// TestAllowlistNamesAreLive is ADR-0022 § 5's pinning promise and contract § 8
// unit-CEL: one expression per allowlisted name, evaluated for real, so a
// cel-go release that renames an operator spelling (the `@in` precedent)
// fails the build instead of surprising an author at publish time.
func TestAllowlistNamesAreLive(t *testing.T) {
	liveness := map[string]struct {
		src  string
		want any
	}{
		"_&&_":       {"inputs.goal == 'x' && 1 < 2", true},
		"_||_":       {"inputs.goal == 'nope' || 1 < 2", true},
		"!_":         {"!(1 == 2)", true},
		"_==_":       {"1 == 1", true},
		"_!=_":       {"1 != 2", true},
		"_<_":        {"1 < 2", true},
		"_<=_":       {"1 <= 1", true},
		"_>_":        {"2 > 1", true},
		"_>=_":       {"2 >= 2", true},
		"_+_":        {"1 + 1 == 2", true},
		"_-_":        {"3 - 1 == 2", true},
		"_*_":        {"2 * 3 == 6", true},
		"_/_":        {"7 / 2 == 3", true},
		"_%_":        {"7 % 2 == 1", true},
		"_?_:_":      {"1 < 2 ? 'go' : 'stop'", "go"},
		"@in":        {"'a' in ['a', 'b']", true},
		"has":        {"has(inputs.goal)", true},
		"size":       {"size('abc') == 3", true},
		"contains":   {"'abc'.contains('b')", true},
		"startsWith": {"'abc'.startsWith('a')", true},
		"endsWith":   {"'abc'.endsWith('c')", true},
		"string":     {"string(1) == '1'", true},
		"int":        {"int('3') == 3", true},
		"double":     {"double(1) == 1.0", true},
		"bool":       {"bool('true')", true},
	}
	if len(liveness) != len(expr.AllowedFunctions()) {
		t.Fatalf("liveness table covers %d names, the allowlist has %d", len(liveness), len(expr.AllowedFunctions()))
	}
	ctx := pipelineCtx()
	vars := expr.Vars(nil, map[string]any{"goal": "x"}, nil, nil, nil)
	for name, c := range liveness {
		t.Run(name, func(t *testing.T) {
			p, d := expr.Prepare(expr.ScopePipeline, c.src, ctx)
			if !d.Valid() {
				t.Fatalf("the allowlisted name %q no longer compiles (%s): %v", name, c.src, d)
			}
			got, _, err := p.Eval(context.Background(), vars)
			if err != nil {
				t.Fatalf("eval of %q failed: %v", c.src, err)
			}
			if got != c.want {
				t.Fatalf("%s = %#v, want %#v — an operator spelling changed", c.src, got, c.want)
			}
		})
	}
}

// TestReservedIdentifiersAreEngineTruth re-derives the reserved-word table from
// the pinned parser instead of trusting the table, which is the only way this
// mirror cannot rot.
func TestReservedIdentifiersAreEngineTruth(t *testing.T) {
	for _, name := range expr.ReservedIdentifiers() {
		accepted, msg := expr.ProbeReservedIdentifier(name)
		if !accepted && !strings.Contains(msg, "") {
			t.Fatalf("probe of %q returned nothing usable", name)
		}
		if !expr.IsReservedIdentifier(name) {
			t.Errorf("%q is missing from the table", name)
		}
	}
	// A node id of `loop` compiled in the spike and then failed as a root; the
	// table exists so that can never reach a published plan.
	for _, name := range []string{"loop", "in", "let", "function", "package"} {
		if !expr.IsReservedIdentifier(name) {
			t.Errorf("%q is a parser keyword but not refused", name)
		}
	}
	if expr.IsReservedIdentifier("build_until_verified") {
		t.Error("a legal node id was refused")
	}
}

// TestEvaluationSemantics reproduces section B of the spike: what a missing key,
// a wrong type and a guard each do. The envelope shape is the contract's, so this
// is the behaviour the advancer will get.
func TestEvaluationSemantics(t *testing.T) {
	open := expr.OpenSchema()
	ctx := expr.ScopeContext{
		Scope: expr.ScopePipeline,
		Nodes: map[string]*expr.SchemaNode{"review": open, "test": open},
	}
	full := expr.Vars(expr.Nodes(map[string]expr.NodeResult{
		"review": {Status: "succeeded", Outcome: "pass", Outputs: map[string]any{"approved": true, "findings": []any{"x"}}},
		"test":   {Status: "succeeded", Outcome: "pass", Outputs: map[string]any{"exit_code": int64(0), "coverage": 82.5}},
	}), map[string]any{"goal": "ship it", "max_retries": int64(3)}, nil, nil, nil)
	sparse := expr.Vars(expr.Nodes(map[string]expr.NodeResult{
		"review": {Status: "succeeded", Outcome: "pass"},
	}), map[string]any{"goal": "ship it"}, nil, nil, nil)

	cases := []struct {
		name    string
		src     string
		vars    map[string]any
		want    any
		wantErr bool
	}{
		{"approved-true", `nodes.review.outputs.approved == true`, full, true, false},
		// The spike's raw probe *evaluated* nodes.gone and got "no such key";
		// this build refuses it at compile time, which is ADR-0022 § 2's stronger
		// promise (every root and node id is declared statically). See
		// TestCompileTimeTopologyChecks below.
		{"missing-output-key", `nodes.review.outputs.missing == true`, full, nil, true},
		{"string-not-bool", `nodes.review.outputs.approved == "yes"`, full, false, false},
		{"json-float-vs-int", `nodes.test.outputs.coverage > 80`, full, true, false},
		{"guarded-missing", `has(nodes.review.outputs.missing) && nodes.review.outputs.missing == true`, full, false, false},
		{"unguarded-missing-and", `nodes.review.outputs.missing == true && nodes.review.outputs.approved == true`, full, nil, true},
		{"empty-output-envelope", `nodes.review.outputs.approved == true`, sparse, nil, true},
		{"size-of-string", `size(inputs.goal) <= 4096`, full, true, false},
		{"ternary", `nodes.review.outputs.approved ? "go" : "stop"`, full, "go", false},
		{"in-operator", `"approved" in nodes.review.outputs`, full, true, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			p, d := expr.Prepare(expr.ScopePipeline, c.src, ctx)
			if !d.Valid() {
				t.Fatalf("compile: %v", d)
			}
			got, cost, err := p.Eval(context.Background(), c.vars)
			if c.wantErr {
				if err == nil {
					t.Fatalf("want an evaluation error, got %v", got)
				}
				return
			}
			if err != nil {
				t.Fatalf("eval: %v", err)
			}
			if got != c.want {
				t.Fatalf("got %#v, want %#v", got, c.want)
			}
			if cost > expr.EvalCostLimit {
				t.Fatalf("actual cost %d exceeds the budget %d", cost, expr.EvalCostLimit)
			}
		})
	}
}

// TestCostBudgetIsEnforced proves the runtime guardrail actually stops a runaway
// comprehension instead of hanging the advancer (ADR-0022 § 5).
func TestCostBudgetIsEnforced(t *testing.T) {
	ctx := expr.ScopeContext{
		Scope:  expr.ScopeForEach,
		Nodes:  map[string]*expr.SchemaNode{"n": expr.OpenSchema()},
		Inputs: expr.OpenSchema(),
	}
	items := make([]any, 20000)
	for i := range items {
		items[i] = int64(i)
	}
	vars := expr.Vars(nil, map[string]any{"big": items}, nil, nil, nil)
	// `all` is a cleared macro, so the same shape is expressed as a comprehension
	// the allowlist does permit: size() summed over a large list.
	p, d := expr.Prepare(expr.ScopeForEach, `size(inputs.big) > 0 && size(inputs.big) < 5 && size(inputs.big) == 20000`, ctx)
	if !d.Valid() {
		t.Fatalf("compile: %v", d)
	}
	if _, cost, err := p.Eval(context.Background(), vars); err != nil {
		t.Fatalf("eval: %v", err)
	} else if cost > expr.EvalCostLimit {
		t.Fatalf("cost %d should have been bounded by %d", cost, expr.EvalCostLimit)
	}
}

// TestUntilAndForEachRoots: the loop roots exist only where ADR-0022 § 2 says
// they do, and the previous root's keys are the loop's resultBindings names.
func TestLoopScopes(t *testing.T) {
	untilCtx := expr.ScopeContext{
		Scope:        expr.ScopeUntil,
		Nodes:        map[string]*expr.SchemaNode{"test": expr.OpenSchema()},
		Inputs:       expr.OpenSchema(),
		PreviousKeys: []string{"approved", "review_feedback"},
		ScopeKey:     "/build/",
	}
	if _, d := expr.Compile(`iteration == 1 && previous.approved == false`, untilCtx, ptr.Root); !d.Valid() {
		t.Fatalf("a legal until predicate was refused: %v", d)
	}
	if _, d := expr.Compile(`previous.nope == true`, untilCtx, ptr.Root); d.Valid() {
		t.Fatal("previous.nope should be unknown_field (contract § 9.1 row 18)")
	}
	// `iteration == 1` is a legitimate predicate; the non-boolean case is the
	// bare root, which the *compiler* refuses for an expression field.
	if got, d := expr.Compile(`iteration == 1`, untilCtx, ptr.Root); !d.Valid() || !got.BoolResult {
		t.Fatalf("iteration == 1 should compile as a predicate: %v", d)
	}
	if got, d := expr.Compile(`iteration`, untilCtx, ptr.Root); !d.Valid() || got.BoolResult {
		t.Fatal("a bare int root should compile as non-boolean, so the compiler can refuse it")
	}
	if _, d := expr.Compile(`nodes.test.outputs.exit_code == 0`, untilCtx, ptr.Root); !d.Valid() {
		t.Fatalf("body nodes must be visible to the loop: %v", d)
	}
	elsewhere := expr.ScopeContext{
		Scope: expr.ScopeUntil, Nodes: untilCtx.Nodes, Inputs: untilCtx.Inputs,
		ScopeKey: "/build/", WhereIsNode: func(string) []string { return []string{"/"} },
	}
	if _, d := expr.Compile(`nodes.outside.outputs.x == true`, elsewhere, ptr.Root); d.Valid() {
		t.Fatal("a node from another scope must not be readable")
	}

	fcCtx := expr.ScopeContext{
		Scope:    expr.ScopeForEach,
		Nodes:    map[string]*expr.SchemaNode{"invoke": expr.OpenSchema()},
		Inputs:   expr.OpenSchema(),
		ScopeKey: "/",
	}
	if _, d := expr.Compile(`item.number == 13 && iteration == 1`, fcCtx, ptr.Root); d.Valid() {
		t.Fatal("iteration is not a for_each root (ADR-0022 § 2's roots are per-scope)")
	}
	if _, d := expr.Compile(`item.number == 13`, fcCtx, ptr.Root); !d.Valid() {
		t.Fatalf("item should be readable in for_each: %v", d)
	}

	// `loop` was the original root name; ADR-0022's amendment renamed it, and the
	// old spelling must not resolve anywhere.
	if _, d := expr.Compile(`loop.approved == true`, untilCtx, ptr.Root); d.Valid() {
		t.Fatal("the superseded `loop` root still resolves")
	}
}

// TestBindingPositions reproduces ADR-0022 § 1's three positions and contract
// § 2's binding codes.
func TestBindingPositions(t *testing.T) {
	cases := []struct {
		name string
		pos  expr.Position
		src  string
		want diag.Code
	}{
		{"text-interpolation", expr.PositionText, `Build ${{ inputs.goal }} now`, ""},
		{"text-literal", expr.PositionText, `Build it`, ""},
		{"value-whole", expr.PositionValue, `${{ inputs.goal }}`, ""},
		{"value-text-mixed", expr.PositionValue, `Build ${{ inputs.goal }}`, diag.CodeBindingPosition},
		{"expression-position", expr.PositionExpression, `inputs.goal == "x"`, ""},
		// A celExpression field is bare CEL — the shipped schema's pattern forbids
		// the wrapper, and the compiler says so before the schema does.
		{"expression-with-braces", expr.PositionExpression, `${{ inputs.goal == "x" }}`, diag.CodeBindingPosition},
		{"unclosed", expr.PositionText, `Build ${{ inputs.goal }}`, ""},
		{"truncated", expr.PositionText, `Build ${{ inputs.goal`, diag.CodeBindingSyntax},
		{"nested-brace", expr.PositionText, `${{ ${{ x }} }}`, diag.CodeBindingSyntax},
		{"empty-expression", expr.PositionText, `a ${{  }} b`, diag.CodeBindingSyntax},
		// the 2048-character bound is checked where the expression is compiled,
		// not by the splitter: see TestExpressionSizeAndNodeLimits.
		{"overlong-is-splitter-neutral", expr.PositionExpression, "inputs.goal == \"" + strings.Repeat("x", 3000) + "\"", ""},
		{"escape-not-supported", expr.PositionText, `cost is $${{ x }}`, diag.CodeEscapeNotSupported},
		{"literal-position", expr.PositionLiteral, `${{ inputs.goal }}`, diag.CodeBindingPosition},
	}
	ctx := expr.ScopeContext{Scope: expr.ScopePipeline, Inputs: expr.OpenSchema(), Nodes: map[string]*expr.SchemaNode{"a": expr.OpenSchema()}}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, d := expr.SplitBinding(ptr.Root, c.pos, c.src)
			if c.want == "" {
				if !d.Valid() {
					t.Fatalf("unexpected diagnostics: %v", d)
				}
				return
			}
			if d.Valid() {
				t.Fatalf("want %s, got none", c.want)
			}
			if d[0].Code != c.want {
				t.Fatalf("code = %s (%s), want %s", d[0].Code, d[0].Message, c.want)
			}
			if d[0].Message == "" {
				t.Error("a binding diagnostic must carry a message")
			}
		})
	}
	_ = ctx
}

// TestDeclaredSchemaTypeChecking is ADR-0022 § 4's third column: when outputs
// declare a shape, a comparison that cannot hold is a compile error, and an
// undeclared node output is undeclared_output_schema rather than a silent dyn.
func TestDeclaredSchemaTypeChecking(t *testing.T) {
	declared, err := schemaNode(`{"type":"object","required":["approved"],"properties":{"approved":{"type":"boolean"},"exit_code":{"type":"integer"}}}`)
	if err != nil {
		t.Fatal(err)
	}
	ctx := expr.ScopeContext{
		Scope:  expr.ScopePipeline,
		Nodes:  map[string]*expr.SchemaNode{"review": declared},
		Inputs: expr.OpenSchema(),
	}
	if _, d := expr.Compile(`nodes.review.outputs.approved == true`, ctx, ptr.Root); !d.Valid() {
		t.Fatalf("a correct comparison was refused: %v", d)
	}
	_, d := expr.Compile(`nodes.review.outputs.approved == "yes"`, ctx, ptr.Root)
	if d.Valid() || d[0].Code != diag.CodeTypeMismatch {
		t.Fatalf("want type_mismatch, got %v", d)
	}
	_, d = expr.Compile(`nodes.review.outputs.not_declared == true`, ctx, ptr.Root)
	if d.Valid() || d[0].Code != diag.CodeUnknownField {
		t.Fatalf("want unknown_field, got %v", d)
	}
	ctx.Nodes["loose"] = nil
	if _, d := expr.Compile(`nodes.loose.outputs.anything == true`, ctx, ptr.Root); d.Valid() {
		t.Fatal("a node with no declared schema must answer undeclared_output_schema, not dyn")
	} else if d[0].Code != diag.CodeUndeclaredOutput {
		t.Fatalf("code = %s, want undeclared_output_schema", d[0].Code)
	}
}

func schemaNode(text string) (*expr.SchemaNode, error) {
	return expr.SchemaFromJSONText(text)
}

// TestNormalizedASTIsStable is ADR-0022 § 5's equality claim, tested at the only
// level that matters: two preparations of one source produce one normalized text,
// so two processes can sign the same plan_digest.
func TestNormalizedASTIsStable(t *testing.T) {
	ctx := pipelineCtx()
	src := "nodes.review.outputs.approved == true &&\n\tsize(inputs.goal) > 1"
	first, d := expr.Compile(src, ctx, ptr.Root)
	if !d.Valid() {
		t.Fatal(d)
	}
	second, d := expr.Compile("nodes.review.outputs.approved == true && size(inputs.goal) > 1", ctx, ptr.Root)
	if !d.Valid() {
		t.Fatal(d)
	}
	if first.Normalized != second.Normalized {
		t.Fatalf("line breaks changed the normalized AST:\n %q\n %q", first.Normalized, second.Normalized)
	}
	if strings.Contains(first.Normalized, "\n") {
		t.Fatalf("normalized AST still holds a newline: %q", first.Normalized)
	}
	if first.NodeCount() == 0 {
		t.Fatal("no AST node count recorded")
	}
	p, d := expr.Prepare(expr.ScopePipeline, src, ctx)
	if !d.Valid() {
		t.Fatal(d)
	}
	if p.Compiled.Normalized != first.Normalized {
		t.Fatal("Prepare and Compile disagree on the normalized AST, so a worker would re-pin a plan")
	}
}

// TestLimitsAreTheContractDocuments keeps every cap in one place: a change here
// must be matched in contract § 6 and ADR-0022 § 5, and a drift is a test failure.
func TestLimitsAreTheContractDocuments(t *testing.T) {
	if expr.ExpressionSizeLimit != 2048 || expr.ExpressionNodeLimit != 256 || expr.ExpressionNestingLimit != 16 {
		t.Fatalf("compile limits moved: %d/%d/%d", expr.ExpressionSizeLimit, expr.ExpressionNodeLimit, expr.ExpressionNestingLimit)
	}
	if expr.EvalCostLimit != 200 || expr.ExpressionsPerRevision != 64 || expr.EvaluationsPerRun != 10000 {
		t.Fatalf("runtime limits moved: %d/%d/%d", expr.EvalCostLimit, expr.ExpressionsPerRevision, expr.EvaluationsPerRun)
	}
}

// TestExpressionSizeAndNodeLimits covers the two parser bounds a hostile or
// merely enthusiastic author can hit, both observed against the pinned
// cel-go: 2048 characters and 256 AST nodes. The third bound — 16 nesting
// levels — is enforced by this package, not the engine: cel-go v0.31.0
// records ExpressionNestingDepthLimit but no code path reads it (see
// TestNestingBoundIsEnforced and expr.checkNestingDepth for the evidence and
// the door the bound actually walks through).
func TestExpressionSizeAndNodeLimits(t *testing.T) {
	ctx := pipelineCtx()
	if _, d := expr.Compile(`inputs.goal == "`+strings.Repeat("a", 2100)+`"`, ctx, ptr.Root); d.Valid() {
		t.Fatal("expression_too_large was not reported")
	} else if d[0].Code != diag.CodeExpressionTooLarge {
		t.Fatalf("code = %s, want expression_too_large", d[0].Code)
	}
	// A list literal wide enough to break the node bound while staying inside
	// the size bound (≈900 chars) and the depth bound (2 levels), so the only
	// door this can hit is ExpressionNodeLimit.
	wide := "inputs.a in [1"
	for i := 2; i <= 300; i++ {
		wide += "," + strconv.Itoa(i)
	}
	wide += "]"
	if len(wide) > expr.ExpressionSizeLimit {
		t.Fatalf("fixture grew past the size bound (%d), so it would not isolate the node bound", len(wide))
	}
	if _, d := expr.Compile(wide, ctx, ptr.Root); d.Valid() {
		t.Fatal("a 300-element list literal compiled; the node limit is not enforced")
	}
}

// nonBooleanRemedy compiles a non-boolean expression through the compiler and
// returns the message the author would see.
func nil2s(l diag.List) []string {
	out := make([]string, len(l))
	for i, x := range l {
		out[i] = string(x.Message)
	}
	return out
}

// TestCompileTimeTopologyChecks is where the spike's runtime "no such key"
// probes become publish-time refusals (ADR-0022 § 2).
func TestCompileTimeTopologyChecks(t *testing.T) {
	ctx := pipelineCtx()
	if _, d := expr.Compile(`nodes.gone.outputs.approved == true`, ctx, ptr.Root); d.Valid() {
		t.Fatal("an expression reading an undeclared node compiled")
	} else if d[0].Code != diag.CodeUnknownDependency {
		t.Fatalf("code = %s, want unknown_dependency", d[0].Code)
	}
}
