// Package expr implements the Communication CEL subset: the three binding
// positions (ADR-0022 § 1), the restricted cel-go environment (§ 5), the
// declared-output reference checks (§ 4 rule 1) and the bounded evaluator.
//
// It is pure Go with no database, no workspace and no clock: the control plane
// compiles these expressions at publish time and evaluates them in the
// advancer's transaction (ADR-0023 § 5) with the same code.
package expr

import (
	"strings"

	"github.com/google/cel-go/cel"
	celast "github.com/google/cel-go/common/ast"

	"github.com/dbirks/communication/internal/pipelines/diag"
	"github.com/dbirks/communication/internal/pipelines/ptr"
)

// Limits are ADR-0022 § 5 and contract § 6. They are exported so doctor can
// report them and every caller names the same bound.
const (
	ExpressionSizeLimit    = 2048
	ExpressionNodeLimit    = 256
	ExpressionNestingLimit = 16
	EvalCostLimit          = 200
	ExpressionsPerRevision = 64
	EvaluationsPerRun      = 10000
)

// CELVersion is the pinned cel-go release, stamped into the plan-digest scope
// (contract § 9.1 row 19): an upgrade that changes AST normalization must move
// plan_digest visibly instead of silently re-pinning published revisions.
const CELVersion = "v0.31.0"

// allowlist is ADR-0022 § 5's function set. The operator spellings are CEL's,
// not ours: the `in` operator compiles to `@in`, not `_in_` (observed).
// TestAllowlistNamesAreLive evaluates one expression per name so a rename in
// the engine fails the build rather than surprising an author.
var allowlist = map[string]bool{
	"_&&_": true, "_||_": true, "!_": true, "_==_": true, "_!=_": true,
	"_<_": true, "_<=_": true, "_>_": true, "_>=_": true,
	"_+_": true, "_-_": true, "_*_": true, "_/_": true, "_%_": true,
	"_?_:_": true, "@in": true,
	"has":  true, // the only macro kept (ADR-0022 § 3)
	"size": true, "contains": true, "startsWith": true, "endsWith": true,
	"string": true, "int": true, "double": true, "bool": true,
}

// AllowedFunctions returns the allowlist, for doctor and the docs guard test.
func AllowedFunctions() []string {
	out := make([]string, 0, len(allowlist))
	for k := range allowlist {
		out = append(out, k)
	}
	return out
}

type funcAllowlist struct{}

func (funcAllowlist) Name() string { return "communication.func_allowlist" }

func (funcAllowlist) Validate(_ *cel.Env, _ cel.ValidatorConfig, a *celast.AST, iss *cel.Issues) {
	celast.PostOrderVisit(a.Expr(), celast.NewExprVisitor(func(e celast.Expr) {
		if e.Kind() != celast.CallKind {
			return
		}
		name := e.AsCall().FunctionName()
		if !allowlist[name] {
			iss.ReportErrorAtID(e.ID(), "function %q is outside the Communication CEL subset", name)
		}
	}))
}

// Scope selects which roots an expression may see. ADR-0022 § 2 makes root
// availability positional: item/items exist only in a for_each body,
// previous/iteration only in an until body, parameters only in a template.
type Scope int

const (
	// ScopePipeline is the root scope: inputs, nodes, run.
	ScopePipeline Scope = iota
	// ScopeForEach adds item and items.
	ScopeForEach
	// ScopeUntil adds previous and iteration.
	ScopeUntil
	// ScopeTemplate sees parameters only.
	ScopeTemplate
)

// Roots lists the declared root names for the scope.
func (s Scope) Roots() []string {
	switch s {
	case ScopeForEach:
		return []string{"inputs", "nodes", "run", "item", "items"}
	case ScopeUntil:
		return []string{"inputs", "nodes", "run", "previous", "iteration"}
	case ScopeTemplate:
		return []string{"parameters"}
	default:
		return []string{"inputs", "nodes", "run"}
	}
}

// reservedIdentifiers mirrors the pinned cel-go parser's keyword set. It is
// here as data because cel-go does not export it, and ADR-0022 § 2 requires
// the compiler to refuse any root name on this list.
// TestReservedIdentifiersAreEngineTruth re-derives every entry from the pinned
// parser, so this table cannot drift silently.
var reservedIdentifiers = map[string]bool{
	"as": true, "break": true, "const": true, "continue": true, "else": true,
	"false": true, "for": true, "function": true, "if": true, "import": true,
	"in": true, "let": true, "loop": true, "package": true, "namespace": true,
	"null": true, "return": true, "true": true, "var": true, "void": true,
	"while": true,
}

// IsReservedIdentifier reports whether name is refused as an identifier by the
// pinned CEL parser.
func IsReservedIdentifier(name string) bool { return reservedIdentifiers[name] }

// ReservedIdentifiers lists the refused names (sorted is the caller's job).
func ReservedIdentifiers() []string {
	out := make([]string, 0, len(reservedIdentifiers))
	for k := range reservedIdentifiers {
		out = append(out, k)
	}
	return out
}

// EnvFor builds the restricted environment for a scope. It returns a fresh env
// per call on purpose: cel.Env is immutable, and caching by scope invited a
// stale-cache question this package does not need.
func EnvFor(s Scope) (*cel.Env, error) {
	opts := []cel.EnvOption{
		cel.ClearMacros(),
		cel.Macros(cel.HasMacro),
		cel.ParserExpressionSizeLimit(ExpressionSizeLimit),
		cel.ExpressionNodeLimit(ExpressionNodeLimit),
		cel.ExpressionNestingDepthLimit(ExpressionNestingLimit),
		cel.ASTValidators(funcAllowlist{}),
		cel.OptionalTypes(),
	}
	for _, root := range s.Roots() {
		if root == "iteration" {
			// The one non-dyn root (ADR-0022 § 4): the engine authors it.
			opts = append(opts, cel.Variable("iteration", cel.IntType))
			continue
		}
		opts = append(opts, cel.Variable(root, cel.DynType))
	}
	return cel.NewEnv(opts...)
}

// ProbeReservedIdentifier asks the pinned parser whether name is reserved by
// compiling `<name>.x`. It returns the engine's own message when it is.
//
// This is the two-line guard ADR-0022 § 5 says the environment itself cannot
// give: cel.Variable("loop", cel.DynType) builds fine and only the parser
// knows the name is unusable.
func ProbeReservedIdentifier(name string) (bool, string) {
	env, err := cel.NewEnv(cel.Declarations())
	if err != nil {
		return false, err.Error()
	}
	_, iss := env.Compile(name + ".x")
	if iss == nil {
		return false, ""
	}
	for _, e := range iss.Errors() {
		if strings.Contains(e.Message, "reserved identifier") {
			return true, e.Message
		}
	}
	return false, ""
}

// Diagnostics converts cel-go issues onto the contract § 2 code list.
// Diagnostics converts cel-go issues at a document pointer.
func Diagnostics(at ptr.Pointer, iss *cel.Issues) diag.List {
	return DiagnosticsIn(at, iss, "")
}

// DiagnosticsIn converts cel-go issues, using the expression source to tell an
// undeclared *function* (a subset refusal) from an undeclared *root* (a naming
// mistake). cel-go's own message carries only the identifier, so the source is
// the only witness.
func DiagnosticsIn(at ptr.Pointer, iss *cel.Issues, src string) diag.List {
	var out diag.List
	if iss == nil {
		return out
	}
	for _, e := range iss.Errors() {
		code, hint := classifyCEL(e.Message, src)
		out.Add(diag.Diagnostic{
			Code:             code,
			Source:           diag.SourceCompiler,
			Message:          strings.TrimSpace(e.Message),
			InstanceLocation: at,
			Hint:             hint,
		})
	}
	return out
}

// classifyCEL maps an engine message to a code. The order matters: a reserved
// identifier also reads as an undeclared reference, and the reservation is the
// true cause (ADR-0022 § 2's two distinct refusals must stay apart).
// undeclaredName pulls the offending identifier out of a cel-go issue message.
func undeclaredName(msg string) string {
	const key = "undeclared reference to '"
	i := strings.Index(msg, key)
	if i < 0 {
		return ""
	}
	rest := msg[i+len(key):]
	j := strings.Index(rest, "'")
	if j < 0 {
		return ""
	}
	return rest[:j]
}

func classifyCEL(msg, src string) (diag.Code, string) {
	switch {
	case strings.Contains(msg, "reserved identifier"):
		return diag.CodeUndeclaredRoot, "the pinned CEL parser reserves this name; an id may not be one of these (ADR-0022 § 2)"
	case strings.Contains(msg, "undeclared reference to"):
		if name := undeclaredName(msg); name != "" && strings.Contains(src, name+"(") {
			return diag.CodeFunctionNotAllowed,
				"\"" + name + "\" is outside the Communication CEL subset: the allowlist is ADR-0022 § 5, and comprehensions such as exists()/map() are refused by design"
		}
		// An undeclared *function* name (exists/map/filter/now…) is a subset
		// refusal — the author reached for something the allowlist withholds.
		// An undeclared *identifier* used as a root is the other case, and the
		// two need different remedies in the message.
		if name := undeclaredName(msg); name != "" && strings.Contains(msg, name+"(") {
			return diag.CodeFunctionNotAllowed,
				"\"" + name + "\" is outside the Communication CEL subset: the allowlist is ADR-0022 § 5 and comprehensions are refused by design"
		}
		return diag.CodeUndeclaredRoot, "legal roots are inputs, nodes, run, and positionally item/items or previous/iteration (ADR-0022 § 2); there is no workspace, env or secrets root"
	case strings.Contains(msg, "outside the Communication CEL subset"):
		return diag.CodeFunctionNotAllowed, "the allowlist is ADR-0022 § 5: comprehensions, matches() and now() are refused by design"
	case strings.Contains(msg, "expression size limit"), strings.Contains(msg, "input length exceeded"):
		return diag.CodeExpressionTooLarge, "the bound is 2048 characters"
	case strings.Contains(msg, "node count exceeded"), strings.Contains(msg, "exceeded the node limit"):
		return diag.CodeExpressionTooLarge, "the bound is 256 AST nodes"
	case strings.Contains(msg, "nested depth"):
		return diag.CodeExpressionTooLarge, "the bound is 16 nesting levels"
	case strings.Contains(msg, "Syntax error"), strings.Contains(msg, "mismatched input"),
		strings.Contains(msg, "token recognition"), strings.Contains(msg, "extraneous input"):
		return diag.CodeCELCompile, ""
	}
	return diag.CodeCELCompile, ""
}
