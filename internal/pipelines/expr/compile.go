package expr

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"

	"github.com/google/cel-go/cel"
	celast "github.com/google/cel-go/common/ast"
	"github.com/google/cel-go/common/types"
	"github.com/google/cel-go/common/types/ref"

	"github.com/dbirks/communication/internal/pipelines/diag"
	"github.com/dbirks/communication/internal/pipelines/ptr"
)

// Reference is one root-plus-path read by an expression.
//
// nodes.review.outputs.approved has Root "nodes" and Path
// ["review","outputs","approved"]. Complete is false when the chain is broken
// by a dynamic step (an index computed at run time), which the reference-table
// checks skip rather than refuse — the schema simply cannot say where such a
// read lands, and refusing it would refuse the one thing `has()` exists for.
type Reference struct {
	Root  string
	Path  []string
	Guard bool // the selection sits inside has(): ADR-0022 § 3's probe
	// Complete reports a pure static selector chain.
	Complete bool
}

// Key renders the reference in envelope spelling.
func (r Reference) Key() string {
	out := r.Root
	for _, p := range r.Path {
		out += "." + p
	}
	return out
}

// Compiled is one expression that passed the restricted environment.
type Compiled struct {
	Source string
	AST    *cel.Ast
	// Normalized is the digest input: cel-go's AST text with its own line
	// wrapping collapsed to single spaces (contract § 9.1 row 19). A
	// formatter's column width must not be part of a value that pins a run.
	Normalized string
	Refs       []Reference
	RootNames  []string
	// BoolResult records that the expression is known to produce a boolean.
	BoolResult bool
	// Depth is the AST nesting depth the compiler counted (ADR-0022 § 5's
	// 16-level bound). cel-go v0.31.0 records ExpressionNestingDepthLimit but
	// never enforces it — observed: a 40-segment selector chain and a 31-clause
	// && chain compile under the option — so this package owns the count.
	// Compilation refuses anything above ExpressionNestingLimit; the field is
	// what a plan records and what the fuzz property asserts.
	Depth int
}

// ResultTypeName names the checked output type ("bool", "dyn", …).
// EnvFingerprint digests the environment definition: the roots each scope
// declares, the function allowlist, the limits and the cel-go version. A plan
// records it so an environment change is visible in a plan diff instead of
// altering behaviour silently (ADR-0022 § 5).
func EnvFingerprint() string {
	var b strings.Builder
	b.WriteString("cel-go=" + CELVersion + "\n")
	b.WriteString("limits=" + itoa(ExpressionSizeLimit) + "," + itoa(ExpressionNodeLimit) + "," + itoa(ExpressionNestingLimit) + "," + itoa(EvalCostLimit) + "," + itoa(ExpressionsPerRevision) + "," + itoa(EvaluationsPerRun) + "\n")
	b.WriteString("functions=" + strings.Join(AllowedFunctions(), ",") + "\n")
	for _, s := range []Scope{ScopePipeline, ScopeForEach, ScopeUntil, ScopeTemplate} {
		b.WriteString("scope=" + ScopeName(s) + ":" + strings.Join(s.Roots(), ",") + "\n")
	}
	return digestText(b.String())
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var digits []byte
	for n > 0 {
		digits = append([]byte{byte('0' + n%10)}, digits...)
		n /= 10
	}
	return string(digits)
}

func digestText(s string) string {
	sum := sha256.Sum256([]byte(s))
	return "sha256:" + hex.EncodeToString(sum[:])
}

func (c Compiled) ResultTypeName() string {
	if c.AST == nil {
		return "dyn"
	}
	return c.AST.OutputType().TypeName()
}

// ScopeContext is what the compiler knows about the position an expression
// sits in: which scope's roots are live and what the declared schemas say.
type ScopeContext struct {
	// Scope selects the live roots.
	Scope Scope
	// Nodes maps a node id visible in this scope to its declared outputs
	// schema; a nil value means the node declared none. Ids outside the map
	// are not visible here, which is a topology fact the compiler owns.
	Nodes map[string]*SchemaNode
	// Inputs is spec.inputs (nil when the document declares no properties).
	Inputs *SchemaNode
	// PreviousKeys are the enclosing until node's resultBindings names. The
	// compiler cannot know whether a *value* exists on iteration 1 (contract
	// § 9.1 row 18); it can say a key outside this set can never exist.
	PreviousKeys []string
	// EngineOutputs names the outputs a composite node supplies itself
	// (for_each's children, until's iterations) besides its declared schema.
	EngineOutputs map[string][]string
	// ScopeKey is the current scope's text path, used only in messages.
	ScopeKey string
	// WhereIsNode reports every scope key that declares a node id, so an
	// expression reading a node from another scope gets the true diagnosis
	// rather than "not declared" (ADR-0021 § 3).
	WhereIsNode func(id string) []string
}

func (sc ScopeContext) hasRoot(name string) bool {
	for _, r := range sc.Scope.Roots() {
		if r == name {
			return true
		}
	}
	return false
}

// Compile checks one expression source in the given scope. A non-empty
// diagnostic list means the document is invalid: nothing may be stored.
func Compile(src string, sc ScopeContext, at ptr.Pointer) (Compiled, diag.List) {
	var diags diag.List
	env, err := EnvFor(sc.Scope)
	if err != nil {
		diags.Addf(diag.SourceCompiler, diag.CodeCELCompile, at, "cannot build the CEL environment: %v", err)
		return Compiled{}, diags
	}
	if len(src) > ExpressionSizeLimit {
		diags.Addf(diag.SourceCompiler, diag.CodeExpressionTooLarge, at,
			"expression is %d characters; the limit is %d", len(src), ExpressionSizeLimit)
		return Compiled{}, diags
	}
	astc, iss := env.Compile(src)
	if d := DiagnosticsIn(at, iss, src); !d.Valid() {
		return Compiled{}, d
	}

	if d := checkNestingDepth(astc, at); !d.Valid() {
		return Compiled{}, d
	}

	refs := references(astc)
	for _, r := range refs {
		if code, msg, bad := sc.checkRef(r); bad {
			diags.Addf(diag.SourceCompiler, code, at, "%s", msg)
		}
	}
	if m, bad := typeMismatch(astc, sc); bad {
		diags.Addf(diag.SourceCompiler, diag.CodeTypeMismatch, at,
			"%s is declared %s but is compared with a %s literal (%s)",
			m.Ref.Key(), m.Declared, m.Literal, opName(m.Op))
	}

	text, err := astText(astc)
	if err != nil {
		diags.Addf(diag.SourceCompiler, diag.CodeCELCompile, at, "cannot normalize the expression: %v", err)
		return Compiled{}, diags
	}
	c := Compiled{
		Source:     src,
		AST:        astc,
		Normalized: text,
		Refs:       refs,
		RootNames:  rootNames(refs),
		Depth:      nestingDepth(astc.NativeRep().Expr()),
	}
	c.BoolResult = sc.isBoolean(astc, refs)
	return c, diags
}

// checkRef applies ADR-0022 § 4 rule 1: an expression may not select a field no
// declared output can produce, and the declared-schema requirement (§ 2) is
// enforced here rather than at the first failed evaluation.
func (sc ScopeContext) checkRef(r Reference) (diag.Code, string, bool) {
	if IsReservedIdentifier(r.Root) {
		return diag.CodeUndeclaredRoot,
			fmt.Sprintf("%q is reserved by the CEL parser and cannot name a root", r.Root), true
	}
	if !sc.hasRoot(r.Root) {
		return diag.CodeUndeclaredRoot,
			fmt.Sprintf("root %q is not declared for this position (legal roots here: %s)",
				r.Root, strings.Join(sc.Scope.Roots(), ", ")), true
	}
	if !r.Complete || len(r.Path) == 0 {
		return "", "", false
	}
	switch r.Root {
	case "nodes":
		return sc.checkNodeRef(r)
	case "inputs", "parameters":
		// A NodeTemplate's data root is `parameters` (ADR-0022 § 2); it is the
		// same check with a different name, so ScopeContext.Inputs carries
		// whichever schema the position declares. ADR-0024 § 2 keeps template
		// *publishing* in M5, but the parameter references must still type-check
		// so a template draft is not silently wrong.
		schema, found := walkPath(sc.Inputs, r.Path)
		if !found && !r.Guard && sc.Inputs != nil && !sc.Inputs.Open {
			return diag.CodeUnknownField,
				fmt.Sprintf("%s selects an input the pipeline does not declare (%s)",
					r.Key(), listNames(sc.Inputs)), true
		}
		_ = schema
		return "", "", false
	case "previous":
		if r.Guard {
			return "", "", false
		}
		for _, k := range sc.PreviousKeys {
			if k == r.Path[0] {
				return "", "", false
			}
		}
		return diag.CodeUnknownField,
			fmt.Sprintf("previous.%s is not a result binding of the enclosing loop, so it can never exist; prior-iteration reads must name an iteration result (ADR-0022 § 2, contract § 9.1 row 18)",
				r.Path[0]), true
	}
	return "", "", false
}

func (sc ScopeContext) checkNodeRef(r Reference) (diag.Code, string, bool) {
	id := r.Path[0]
	declared, visible := sc.Nodes[id]
	if !visible {
		// nodes.<id> must name a declared node **in scope** (ADR-0022 § 2).
		// Where the id lives is a topology fact the caller supplies, so the
		// message can name the real problem instead of guessing.
		if sc.WhereIsNode != nil {
			if keys := sc.WhereIsNode(id); len(keys) > 0 {
				return diag.CodeUnknownDependency, fmt.Sprintf(
					"nodes.%s is declared in scope %s but is not visible in scope %s: an expression only reads nodes in its own scope (ADR-0022 § 2)",
					id, strings.Join(keys, ", "), orRoot(sc.ScopeKey)), true
			}
		}
		return diag.CodeUnknownDependency, fmt.Sprintf("nodes.%s is not declared in scope %s", id, orRoot(sc.ScopeKey)), true
	}
	if len(r.Path) == 1 {
		return "", "", false
	}
	switch r.Path[1] {
	case "status", "outcome", "artifact_refs":
		if len(r.Path) > 2 && !r.Guard {
			return diag.CodeUnknownField,
				fmt.Sprintf("%s is a node envelope field with no sub-fields; the envelope is {status, outcome, outputs, artifact_refs} (ADR-0022 § 3)", r.Key()), true
		}
		return "", "", false
	case "outputs":
		if len(r.Path) == 2 {
			return "", "", false
		}
		field := r.Path[2]
		for _, name := range sc.EngineOutputs[id] {
			if name == field {
				return "", "", false
			}
		}
		if declared == nil {
			if r.Guard {
				return "", "", false
			}
			return diag.CodeUndeclaredOutput,
				fmt.Sprintf("%s reads a field of node %q, which declares no outputs schema; declare outputs on the node or read the envelope (ADR-0022 § 4)", r.Key(), id), true
		}
		if _, found := declared.Child(field); found {
			inner, _ := walkPath(declared, r.Path[2:])
			if inner == nil && !r.Guard {
				return diag.CodeUnknownField,
					fmt.Sprintf("%s selects a field no declared output can produce (%s declares %s)",
						r.Key(), id, listNames(declared)), true
			}
			return "", "", false
		}
		if r.Guard {
			return "", "", false
		}
		return diag.CodeUnknownField,
			fmt.Sprintf("%s selects a field no declared output can produce (%s declares %s)",
				r.Key(), id, listNames(declared)), true
	default:
		if r.Guard {
			return "", "", false
		}
		return diag.CodeUnknownField,
			fmt.Sprintf("%s is not a node envelope field; the envelope is {status, outcome, outputs, artifact_refs} (ADR-0022 § 3)", r.Key()), true
	}
}

// isBoolean is ADR-0022 § 1's rule that an expression position must type-check
// to bool, with the declared-schema escape § 4 rule 1 exists to provide: a
// bare dyn read whose declared output is boolean counts as boolean.
func (sc ScopeContext) isBoolean(a *cel.Ast, refs []Reference) bool {
	if a == nil {
		return false
	}
	if a.OutputType() == cel.BoolType {
		return true
	}
	if a.OutputType() != cel.DynType || len(refs) != 1 {
		return false
	}
	r := refs[0]
	if !r.Complete || len(r.Path) == 0 {
		return false
	}
	schema, found := sc.resolveDeclared(r)
	return found && schema != nil && schema.Types["boolean"]
}

// resolveDeclared walks the declared schemas along a reference path. found is
// false where the compiler has no claim (a dynamic step, an invisible node, a
// root whose shape v1alpha1 does not describe field-by-field).
func (sc ScopeContext) resolveDeclared(r Reference) (*SchemaNode, bool) {
	switch r.Root {
	case "inputs", "parameters":
		// A NodeTemplate's data root is `parameters` (ADR-0022 § 2); it is the
		// same check with a different name, so ScopeContext.Inputs carries
		// whichever schema the position declares. ADR-0024 § 2 keeps template
		// *publishing* in M5, but the parameter references must still type-check
		// so a template draft is not silently wrong.
		return walkPath(sc.Inputs, r.Path)
	case "nodes":
		if len(r.Path) < 3 || r.Path[1] != "outputs" {
			return nil, false
		}
		declared, visible := sc.Nodes[r.Path[0]]
		if !visible || declared == nil {
			return nil, false
		}
		return walkPath(declared, r.Path[2:])
	}
	return nil, false
}

func walkPath(cur *SchemaNode, path []string) (*SchemaNode, bool) {
	for _, seg := range path {
		if cur == nil {
			return nil, false
		}
		child, ok := cur.Child(seg)
		if !ok {
			return nil, false
		}
		cur = child
	}
	if cur == nil {
		return nil, false
	}
	return cur, true
}

func listNames(s *SchemaNode) string {
	if s == nil || len(s.PropNames) == 0 {
		return "no declared fields"
	}
	copied := append([]string(nil), s.PropNames...)
	sortStrings(copied)
	return "fields " + strings.Join(copied, ", ")
}

// astText returns cel-go's normalized AST text with line wraps collapsed.
func astText(a *cel.Ast) (string, error) {
	s, err := cel.AstToString(a)
	if err != nil {
		return "", err
	}
	return strings.ReplaceAll(s, "\n", " "), nil
}

func sortStrings(s []string) {
	for i := 1; i < len(s); i++ {
		for j := i; j > 0 && s[j] < s[j-1]; j-- {
			s[j], s[j-1] = s[j-1], s[j]
		}
	}
}

func opName(fn string) string {
	switch fn {
	case "_==_":
		return "=="
	case "_!=_":
		return "!="
	}
	return fn
}

func rootNames(refs []Reference) []string {
	seen := map[string]bool{}
	var out []string
	for _, r := range refs {
		if seen[r.Root] {
			continue
		}
		seen[r.Root] = true
		out = append(out, r.Root)
	}
	return out
}

// references walks the checked AST for static selector chains rooted at a
// declared identifier.
func references(a *cel.Ast) []Reference {
	var out []Reference
	var walk func(e celast.Expr, guard bool)
	walk = func(e celast.Expr, guard bool) {
		switch e.Kind() {
		case celast.SelectKind:
			sel := e.AsSelect()
			root, path, complete := chain(e)
			if root != "" {
				out = append(out, Reference{Root: root, Path: path, Guard: guard, Complete: complete})
				return
			}
			walk(sel.Operand(), guard || sel.IsTestOnly())
		case celast.CallKind:
			c := e.AsCall()
			if t := c.Target(); t != nil && t.Kind() != celast.UnspecifiedExprKind {
				walk(t, guard)
			}
			for _, arg := range c.Args() {
				walk(arg, guard)
			}
		case celast.ListKind:
			for _, el := range e.AsList().Elements() {
				walk(el, guard)
			}
		case celast.MapKind, celast.StructKind:
			for _, entry := range e.AsStruct().Fields() {
				switch entry.Kind() {
				case celast.MapEntryKind:
					walk(entry.AsMapEntry().Key(), guard)
					walk(entry.AsMapEntry().Value(), guard)
				case celast.StructFieldKind:
					walk(entry.AsStructField().Value(), guard)
				}
			}
		case celast.ComprehensionKind:
			// Cleared macros make this unreachable for authored source; the
			// walk stays total so a future macro addition cannot hide a root.
			c := e.AsComprehension()
			walk(c.IterRange(), guard)
			walk(c.AccuInit(), guard)
			walk(c.LoopCondition(), guard)
			walk(c.LoopStep(), guard)
			walk(c.Result(), guard)
		case celast.IdentKind:
			name := e.AsIdent()
			if !isBuiltinIdent(name) {
				out = append(out, Reference{Root: name, Complete: true})
			}
		}
	}
	if a != nil && a.NativeRep() != nil {
		walk(a.NativeRep().Expr(), false)
	}
	return dedupeRefs(out)
}

// chain collapses a Select nest into (root, path, complete). An empty root
// means the bottom of the chain is not a plain identifier.
func chain(sel celast.Expr) (root string, path []string, complete bool) {
	var fields []string
	var cur celast.Expr = sel
	for cur.Kind() == celast.SelectKind {
		s := cur.AsSelect()
		if s.IsTestOnly() {
			return "", nil, false
		}
		fields = append([]string{s.FieldName()}, fields...)
		cur = s.Operand()
	}
	if cur.Kind() != celast.IdentKind {
		return "", nil, false
	}
	name := cur.AsIdent()
	if isBuiltinIdent(name) {
		return "", nil, false
	}
	return name, fields, true
}

func isBuiltinIdent(name string) bool {
	switch name {
	case "true", "false", "null":
		return true
	}
	return false
}

func dedupeRefs(in []Reference) []Reference {
	seen := map[string]bool{}
	var out []Reference
	for _, r := range in {
		k := r.Key() + "|" + guardMark(r.Guard)
		if seen[k] {
			continue
		}
		seen[k] = true
		out = append(out, r)
	}
	return out
}

func guardMark(b bool) string {
	if b {
		return "g"
	}
	return ""
}

// Mismatch names the two types that cannot meet.
type Mismatch struct {
	Ref      Reference
	Declared string // the schema's declared JSON type set
	Literal  string // the literal's JSON type
	Op       string
}

// typeMismatch finds a comparison whose literal side can never match the
// declared type of the field it is compared against (ADR-0022 § 4 rule 1b). It
// fires only where the compiler can name both sides, which is exactly the case
// the ADR calls out: `approved` declared boolean, compared with a string.
// CEL answers that with a plain `false` and no error, which is why refusing it
// at publish time is the whole point.
func typeMismatch(a *cel.Ast, sc ScopeContext) (Mismatch, bool) {
	if a == nil || a.NativeRep() == nil {
		return Mismatch{}, false
	}
	var found *Mismatch
	var walk func(e celast.Expr)
	walk = func(e celast.Expr) {
		if found != nil {
			return
		}
		switch e.Kind() {
		case celast.CallKind:
			c := e.AsCall()
			if c.FunctionName() == "_==_" || c.FunctionName() == "_!=_" {
				if args := c.Args(); len(args) == 2 {
					for _, pair := range [][2]celast.Expr{{args[0], args[1]}, {args[1], args[0]}} {
						if m, ok := mismatchOf(pair[0], pair[1], c.FunctionName(), sc); ok {
							found = &m
							return
						}
					}
				}
			}
			if t := c.Target(); t != nil && t.Kind() != celast.UnspecifiedExprKind {
				walk(t)
			}
			for _, arg := range c.Args() {
				walk(arg)
			}
		case celast.ListKind:
			for _, el := range e.AsList().Elements() {
				walk(el)
			}
		case celast.MapKind, celast.StructKind:
			for _, entry := range e.AsStruct().Fields() {
				switch entry.Kind() {
				case celast.MapEntryKind:
					walk(entry.AsMapEntry().Key())
					walk(entry.AsMapEntry().Value())
				case celast.StructFieldKind:
					walk(entry.AsStructField().Value())
				}
			}
		}
	}
	walk(a.NativeRep().Expr())
	if found == nil {
		return Mismatch{}, false
	}
	return *found, true
}

func mismatchOf(lit, other celast.Expr, op string, sc ScopeContext) (Mismatch, bool) {
	if lit.Kind() != celast.LiteralKind || other.Kind() != celast.SelectKind {
		return Mismatch{}, false
	}
	sel := other.AsSelect()
	if sel.IsTestOnly() {
		return Mismatch{}, false
	}
	root, path, complete := chain(other)
	if root == "" || !complete {
		return Mismatch{}, false
	}
	ref := Reference{Root: root, Path: path, Complete: true}
	schema, found := sc.resolveDeclared(ref)
	if !found || schema == nil {
		return Mismatch{}, false
	}
	jt := jsonTypeOfLiteral(lit.AsLiteral())
	if jt == "" || schema.AdmitsLiteral(jt) {
		return Mismatch{}, false
	}
	return Mismatch{Ref: ref, Declared: schema.TypeNames(), Literal: jt, Op: op}, true
}

// jsonTypeOfLiteral names a CEL literal's JSON type, or "" when the compiler
// should not claim to know.
func jsonTypeOfLiteral(v ref.Val) string {
	if v == nil {
		return ""
	}
	switch v.Type().TypeName() {
	case "string":
		return "string"
	case "int", "uint":
		return "integer"
	case "double":
		return "number"
	case "bool":
		return "boolean"
	case types.NullType.TypeName():
		return "null"
	}
	return ""
}

// NodeCount is the expression's AST node count: the static half of the cost
// picture a plan records (ADR-0022 § 5).
func (c Compiled) NodeCount() int {
	if c.AST == nil {
		return 0
	}
	return int(celast.NodeCount(c.AST.NativeRep()))
}

// LiteralStrings lists the string literals an expression compares against. The
// compiler uses it to prove a condition's routes are reachable (03 § reachable
// terminal outcomes): a route no `when` can select is a dead outcome.
func (c Compiled) LiteralStrings() []string {
	if c.AST == nil {
		return nil
	}
	var out []string
	var walk func(e celast.Expr)
	walk = func(e celast.Expr) {
		switch e.Kind() {
		case celast.LiteralKind:
			if lit, ok := e.AsLiteral().Value().(string); ok {
				out = append(out, lit)
			}
		case celast.SelectKind:
			walk(e.AsSelect().Operand())
		case celast.CallKind:
			if t := e.AsCall().Target(); t != nil && t.Kind() != celast.UnspecifiedExprKind {
				walk(t)
			}
			for _, arg := range e.AsCall().Args() {
				walk(arg)
			}
		case celast.ListKind:
			for _, el := range e.AsList().Elements() {
				walk(el)
			}
		case celast.MapKind:
			for _, ent := range e.AsMap().Entries() {
				walk(ent.AsMapEntry().Key())
				walk(ent.AsMapEntry().Value())
			}
		case celast.ComprehensionKind:
			com := e.AsComprehension()
			for _, sub := range []celast.Expr{com.IterRange(), com.AccuInit(), com.LoopCondition(), com.LoopStep(), com.Result()} {
				if sub != nil && sub.Kind() != celast.UnspecifiedExprKind {
					walk(sub)
				}
			}
		}
	}
	walk(c.AST.NativeRep().Expr())
	sortStrings(out)
	return out
}

// nestingDepth counts the AST's nesting levels the way contract § 6 means it:
// every selection, operator call, list, map, struct and comprehension adds one
// level over its deepest child; literals and identifiers add none. The walk is
// safe to run recursively because the parser's 256-node bound (verified here
// before this runs) caps the tree, and it counts exactly what the pinned
// engine's own nesting option fails to: cel-go v0.31.0 records
// ExpressionNestingDepthLimit but no code path reads it — observed: a
// 40-segment selector chain and a 31-clause && chain compile under the option.
// So this package owns the 16-level bound (TestNestingBoundIsEnforced).
func nestingDepth(e celast.Expr) int {
	switch e.Kind() {
	case celast.SelectKind:
		return 1 + nestingDepth(e.AsSelect().Operand())
	case celast.CallKind:
		c := e.AsCall()
		best := 0
		if t := c.Target(); t != nil && t.Kind() != celast.UnspecifiedExprKind {
			best = nestingDepth(t)
		}
		for _, a := range c.Args() {
			if a != nil && a.Kind() != celast.UnspecifiedExprKind {
				if d := nestingDepth(a); d > best {
					best = d
				}
			}
		}
		return 1 + best
	case celast.ListKind:
		best := 0
		for _, el := range e.AsList().Elements() {
			if d := nestingDepth(el); d > best {
				best = d
			}
		}
		return 1 + best
	case celast.MapKind, celast.StructKind:
		best := 0
		for _, f := range e.AsStruct().Fields() {
			var v celast.Expr
			switch f.Kind() {
			case celast.MapEntryKind:
				if k := f.AsMapEntry().Key(); k != nil && k.Kind() != celast.UnspecifiedExprKind {
					if d := nestingDepth(k); d > best {
						best = d
					}
				}
				v = f.AsMapEntry().Value()
			case celast.StructFieldKind:
				v = f.AsStructField().Value()
			}
			if v != nil && v.Kind() != celast.UnspecifiedExprKind {
				if d := nestingDepth(v); d > best {
					best = d
				}
			}
		}
		return 1 + best
	case celast.ComprehensionKind:
		c := e.AsComprehension()
		best := 0
		for _, sub := range []celast.Expr{c.IterRange(), c.AccuInit(), c.LoopCondition(), c.LoopStep(), c.Result()} {
			if sub != nil && sub.Kind() != celast.UnspecifiedExprKind {
				if d := nestingDepth(sub); d > best {
					best = d
				}
			}
		}
		return 1 + best
	}
	// Literal, ident, not-a-selected-function, unspecified.
	return 0
}

// ScopeName renders a scope for messages and the plan's expression_scope.
func ScopeName(s Scope) string {
	switch s {
	case ScopeForEach:
		return "for_each"
	case ScopeUntil:
		return "until"
	case ScopeTemplate:
		return "template"
	}
	return "pipeline"
}

// ProbeNestingLimitInert asks the pinned engine, built with the same
// expression options this package passes, whether it refuses src for nesting
// reasons on its own. At v0.31.0 the answer for a 40-segment selector chain is
// no — ExpressionNestingDepthLimit is recorded but no code path reads it —
// which is the evidence TestNestingBoundIsEnforced pins; checkNestingDepth is
// what enforces the bound in this build. If a future cel-go makes the option
// live, the probe reports it and the refusal still stands (via the engine).
func ProbeNestingLimitInert(src string) (engineRefusedNesting bool, msg string) {
	env, err := cel.NewEnv(
		cel.ClearMacros(), cel.Macros(cel.HasMacro),
		cel.ParserExpressionSizeLimit(ExpressionSizeLimit),
		cel.ExpressionNodeLimit(ExpressionNodeLimit),
		cel.ExpressionNestingDepthLimit(ExpressionNestingLimit),
		cel.Variable("inputs", cel.DynType),
	)
	if err != nil {
		return false, err.Error()
	}
	_, iss := env.Compile(src)
	if iss == nil || iss.Err() == nil {
		return false, ""
	}
	for _, e := range iss.Errors() {
		if strings.Contains(e.Message, "nested depth") || strings.Contains(e.Message, "nesting") {
			return true, e.Message
		}
	}
	return false, ""
}

// checkNestingDepth refuses an expression whose AST nests deeper than the
// contract § 6 bound, with the diagnosis the author can act on. The pinned
// engine's ExpressionNestingDepthLimit is inert (see nestingDepth), so this is
// the one door the bound walks through.
func checkNestingDepth(a *cel.Ast, at ptr.Pointer) diag.List {
	d := nestingDepth(a.NativeRep().Expr())
	if d <= ExpressionNestingLimit {
		return nil
	}
	return diag.List{{
		Code:             diag.CodeExpressionTooLarge,
		Source:           diag.SourceCompiler,
		Message:          fmt.Sprintf("expression nests %d levels deep; the bound is %d (ADR-0022 § 5): each selection, operator call or list is a level, so split the check across resultBindings or shorten the field path", d, ExpressionNestingLimit),
		InstanceLocation: at,
		Hint:             "the bound is 16 nesting levels; the engine's own nesting option is inert at the pinned cel-go version, so the compiler enforces it",
	}}
}

func orRoot(s string) string {
	if s == "" {
		return "/"
	}
	return s
}
