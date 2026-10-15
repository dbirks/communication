// Contract-phase probes (docs/m4-contract.md § 9.1 rows 17–19, § 7 C13d, § 8 "unit — CEL").
//
// These are NOT part of the copied spike evidence: they were written while authoring the M4
// contract, after every expression in the corrected sample pipeline was compiled. They live in
// their own package rather than beside cmd/celprobe because cmd/celprobe/main.go carries a
// pre-existing vet finding (a Println with a %d) that is part of the checked-in transcript and is
// deliberately left byte-for-byte as recorded; `go test ./cmd/celprobe` would fail vet on it.
//
//	cd docs/compatibility/m4-spike/module && go test ./contractprobe -v
//
// Observed output is checked in one level up at ../results-contract-probes.txt.
package contractprobe

import (
	"os"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/google/cel-go/cel"
	celast "github.com/google/cel-go/common/ast"
)

// allowlist is ADR-0022 § 5's function set, copied from cmd/celprobe so this package stands alone.
var allowlist = map[string]bool{
	"_&&_": true, "_||_": true, "!_": true, "_==_": true, "_!=_": true,
	"_<_": true, "_<=_": true, "_>_": true, "_>=_": true,
	"_+_": true, "_-_": true, "_*_": true, "_/_": true, "_%_": true,
	"_?_:_": true, "@in": true,
	"size": true, "contains": true, "startsWith": true, "endsWith": true,
	"string": true, "int": true, "double": true, "bool": true,
	"has": true,
}

type funcAllowlist struct{}

func (funcAllowlist) Name() string { return "communication.func_allowlist" }

func (funcAllowlist) Validate(_ *cel.Env, _ cel.ValidatorConfig, a *celast.AST, iss *cel.Issues) {
	celast.PostOrderVisit(a.Expr(), celast.NewExprVisitor(func(e celast.Expr) {
		if e.Kind() != celast.CallKind {
			return
		}
		if name := e.AsCall().FunctionName(); !allowlist[name] {
			iss.ReportErrorAtID(e.ID(), "function %q is outside the Communication CEL subset", name)
		}
	}))
}

// parserOnly is restricted() without the function allowlist, for separating parser-level refusals
// (reserved identifiers) from allowlist refusals (index syntax, non-allowlisted calls).
func parserOnly(t *testing.T, extra ...cel.EnvOption) *cel.Env {
	t.Helper()
	e, err := cel.NewEnv(append([]cel.EnvOption{
		cel.ClearMacros(), cel.Macros(cel.HasMacro),
		cel.ParserExpressionSizeLimit(2048), cel.ExpressionNodeLimit(256),
		cel.ExpressionNestingDepthLimit(16),
	}, extra...)...)
	if err != nil {
		t.Fatalf("env build: %v", err)
	}
	return e
}

func restricted(t *testing.T, extra ...cel.EnvOption) *cel.Env {
	t.Helper()
	e, err := cel.NewEnv(append([]cel.EnvOption{
		cel.ClearMacros(), cel.Macros(cel.HasMacro),
		cel.ParserExpressionSizeLimit(2048), cel.ExpressionNodeLimit(256),
		cel.ExpressionNestingDepthLimit(16), cel.ASTValidators(funcAllowlist{}),
	}, extra...)...)
	if err != nil {
		t.Fatalf("env build: %v", err)
	}
	return e
}

// Finding 1 — `loop` is a parser-reserved identifier in cel-go v0.31.0. The env *builds* with a
// `loop` variable declared and then refuses every use of it, in the default env as well as the
// restricted one. ADR-0022 § 2's `loop` root is therefore unnameable, and the failure surfaces at
// expression-compile time, not at env construction — which is the worst place for it.
func TestLoopRootIsReserved(t *testing.T) {
	cases := []struct {
		name, src string
		opts      []cel.EnvOption
	}{
		{"declared, restricted env", "loop.previous.review_feedback", []cel.EnvOption{cel.Variable("loop", cel.DynType)}},
		{"undeclared, restricted env", "loop.previous.review_feedback", nil},
		{"guarded by has()", "has(loop.previous)", []cel.EnvOption{cel.Variable("loop", cel.DynType)}},
		{"declared as a typed map", "loop.previous", []cel.EnvOption{cel.Variable("loop", cel.MapType(cel.StringType, cel.DynType))}},
	}
	for _, tc := range cases {
		base := []cel.EnvOption{cel.ClearMacros(), cel.Macros(cel.HasMacro)}
		e, err := cel.NewEnv(append(base, tc.opts...)...)
		if err != nil {
			t.Fatalf("%s: %v", tc.name, err)
		}
		_, iss := e.Compile(tc.src)
		if iss.Err() == nil || !strings.Contains(iss.Err().Error(), "reserved identifier") {
			t.Errorf("%s: want a reserved-identifier refusal, got %v", tc.name, iss.Err())
			continue
		}
		t.Logf("%-30s -> %v", tc.name, strings.SplitN(iss.Err().Error(), "\n", 2)[0])
	}
	// …while the same name is fine wherever the parser does not see an identifier root.
	e := restricted(t, cel.Variable("nodes", cel.DynType), cel.Variable("run", cel.DynType))
	for _, src := range []string{`nodes.loop`, `run.loop.previous`} {
		if _, iss := e.Compile(src); iss.Err() != nil {
			t.Errorf("%s should compile (%v) — the reservation is identifier-level", src, iss.Err())
		}
	}
	// Index syntax reaches a key named "loop" too, but only for an env that keeps the index operator:
	// ADR-0022 § 5's allowlist has no `_[_]`, so M4's restricted env refuses it as a *function*
	// finding. Two consequences the compiler's error messages should keep distinct: a reserved root
	// name is a parser error, and `nodes['x']` is an allowlist error. Both are publish-time refusals.
	if _, iss := e.Compile(`nodes['loop'].previous`); iss.Err() == nil ||
		!strings.Contains(iss.Err().Error(), "outside the Communication CEL subset") {
		t.Errorf("index syntax is not in ADR-0022 § 5's allowlist; expected that refusal, got %v", iss.Err())
	} else {
		t.Log("nodes['loop'] -> allowlist refusal (no `_[_]` in § 5), not a parser refusal")
	}
	if _, iss := parserOnly(t, cel.Variable("nodes", cel.DynType)).Compile(`nodes['loop'].previous`); iss.Err() != nil {
		t.Errorf("without the allowlist, index syntax should compile: %v", iss.Err())
	} else {
		t.Log("nodes['loop'] compiles with index enabled -> the reservation is identifier-level only")
	}
	// And the roots contract § 9.1 row 17 proposes in its place are clean.
	r := restricted(t, cel.Variable("iteration", cel.IntType), cel.Variable("previous", cel.DynType))
	if _, iss := r.Compile(`iteration > 1 && has(previous.review_feedback) ? previous.review_feedback : 'first'`); iss.Err() != nil {
		t.Errorf("the proposed replacement roots must be usable: %v", iss.Err())
	}
}

// Finding 2 — every root ADR-0022 § 2 declares (plus the two proposed replacements) compiles except
// `loop`. This is the guard M4's unit-CEL layer needs: declare a root, compile a selection through
// it, and fail the build if the pinned engine calls it reserved. Two lines, and the spike had
// neither — which is how the bug in row 17 stayed invisible.
func TestEveryDeclaredRootCompiles(t *testing.T) {
	for _, name := range []string{"inputs", "nodes", "item", "items", "run", "parameters", "previous", "iteration"} {
		ty := cel.DynType
		src := name + ".x"
		if name == "iteration" {
			ty, src = cel.IntType, "iteration > 1"
		}
		if _, iss := restricted(t, cel.Variable(name, ty)).Compile(src); iss.Err() != nil {
			t.Errorf("root %q: %v — an ADR-declared root the pinned engine reserves is a spec bug (contract § 9.1 row 17)", name, iss.Err())
		}
	}
	if _, err := cel.NewEnv(cel.Variable("loop", cel.DynType)); err != nil {
		t.Errorf("declaring `loop` must NOT fail at env time — that is exactly why this bug hides: %v", err)
	}
	t.Log("env declares `loop` happily; only the parser knows it is reserved")
}

// Finding 3 — cel.AstToString line-wraps its own output, so digesting the raw text (ADR-0021 § 6's
// plan_digest input) would bake a formatter's column width into a value that pins runs for their
// whole life. The wrap is the only source of a raw newline (literals come back escaped), so
// replacing it with a single space is deterministic; the pinned cel-go version belongs in the digest
// scope regardless.
func TestNormalizedAstTextWraps(t *testing.T) {
	e := restricted(t, cel.Variable("a", cel.DynType), cel.Variable("b", cel.DynType))
	long := strings.TrimSuffix(strings.Repeat("a == 1 && ", 8), " && ") + " && b == 2"
	ast, iss := e.Compile(long)
	if iss.Err() != nil {
		t.Fatalf("%v", iss.Err())
	}
	norm, err := cel.AstToString(ast)
	if err != nil {
		t.Fatalf("%v", err)
	}
	if !strings.Contains(norm, "\n") {
		t.Fatalf("expected the observed wrap at %d chars and got %q — if the engine stopped wrapping, plan_digest stability changed underneath us (contract § 9.1 row 19)", len(long), norm)
	}
	flat := strings.ReplaceAll(norm, "\n", " ")
	if strings.Contains(flat, "\n") || strings.Contains(flat, "  ") {
		t.Errorf("unwrapping produced odd whitespace: %q", flat)
	}
	t.Logf("input %d chars -> normalized %d chars with %d wrap newline(s); unwrapped %d chars",
		len(long), len(norm), strings.Count(norm, "\n"), len(flat))
	for _, spelling := range []string{"a==1&&b=='x'", `a == 1 && b == "x"`, "a  ==  1  &&  b  ==  'x'"} {
		astS, issS := e.Compile(spelling)
		if issS.Err() != nil {
			t.Errorf("%s: %v", spelling, issS.Err())
			continue
		}
		nS, _ := cel.AstToString(astS)
		if strings.ReplaceAll(nS, "\n", " ") != `a == 1 && b == "x"` {
			t.Errorf("%s normalized to %q — spelling is supposed to be invisible", spelling, nS)
		}
	}
}

// The check that found Finding 1: every `${{ … }}` group and every bare `when:`/`passWhen:` value in
// the contract's § 9.3 sample must compile under the restricted env with the renamed roots.
func TestContractSampleExpressionsCompile(t *testing.T) {
	path := "../candidate/feature-development-contract.yaml"
	if dir := os.Getenv("M4SPIKE_CANDIDATE_DIR"); dir != "" {
		path = dir + "/feature-development-contract.yaml"
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Skipf("sample not present: %v", err)
	}
	var exprs []string
	for _, re := range []*regexp.Regexp{
		regexp.MustCompile(`(?m)^[ \t]*(?:when|passWhen)[ \t]*:[ \t]*(.+)$`),
		regexp.MustCompile(`\$\{\{[ \t]*([^{}]+?)[ \t]*\}\}`),
	} {
		for _, m := range re.FindAllStringSubmatch(string(data), -1) {
			exprs = append(exprs, strings.TrimSpace(m[len(m)-1]))
		}
	}
	sort.Strings(exprs)
	e := restricted(t,
		cel.Variable("inputs", cel.DynType), cel.Variable("nodes", cel.DynType),
		cel.Variable("item", cel.DynType), cel.Variable("items", cel.DynType),
		cel.Variable("run", cel.DynType), cel.Variable("parameters", cel.DynType),
		cel.Variable("previous", cel.DynType), cel.Variable("iteration", cel.IntType),
	)
	seen, compiled, failed := map[string]bool{}, 0, 0
	for _, src := range exprs {
		if src == "" || seen[src] {
			continue
		}
		seen[src] = true
		ast, iss := e.Compile(src)
		if iss.Err() != nil {
			t.Errorf("expression %q: %v", src, iss.Err())
			failed++
			continue
		}
		if _, err := cel.AstToString(ast); err != nil {
			t.Errorf("expression %q does not normalize: %v", src, err)
			failed++
			continue
		}
		compiled++
	}
	if failed > 0 {
		t.Fatalf("%d of %d distinct expressions failed", failed, compiled+failed)
	}
	t.Logf("%d distinct expressions compiled and normalized (contract § 9.3 sample)", compiled)
}
