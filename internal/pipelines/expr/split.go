package expr

import (
	"strings"

	"github.com/dbirks/communication/internal/pipelines/diag"
	"github.com/dbirks/communication/internal/pipelines/ptr"
)

// Position is ADR-0022 § 1's name for what a document field accepts. The
// schema types these as $defs/bindingText, $defs/bindingValue and
// $defs/celExpression; the compiler dispatches on the name so a binding can
// never masquerade as a literal.
type Position int

const (
	// PositionText is bindingText: literal text with zero or more
	// ${{ … }} interpolations (config.prompt, config.summary, artifact name).
	PositionText Position = iota
	// PositionValue is bindingValue: a whole-value ${{ … }} only, or a literal
	// of the declared JSON type (items, args entries, env values, from.value).
	PositionValue
	// PositionExpression is bare CEL with no delimiters, type-checked to bool
	// (node.when, condition cases, until passWhen/failWhen).
	PositionExpression
	// PositionLiteral is a plain typed field: a ${{ … }} string here is an
	// authoring mistake, not a binding (budgets, ids, enum slots).
	PositionLiteral
)

// String implements fmt.Stringer for hints and the editor helper.
func (p Position) String() string {
	switch p {
	case PositionText:
		return "bindingText"
	case PositionValue:
		return "bindingValue"
	case PositionExpression:
		return "expression"
	default:
		return "literal"
	}
}

// Segment is one piece of a split binding.
type Segment struct {
	// Expression is the inner CEL text (trimmed) when IsExpr.
	Expression string
	// Literal is the verbatim text when !IsExpr.
	Literal string
	IsExpr  bool
	// Offset/End are byte offsets into the authored string.
	Offset, End int
}

// Binding is the parsed form of one field value.
type Binding struct {
	Position Position
	// Exprs holds exactly one entry for PositionValue and PositionExpression.
	// For PositionText it holds every interpolation, in order.
	Segments []Segment
	// ExprTexts is the expression source of every segment, in order.
	ExprTexts []string
}

// HasBindings reports whether the value contains any expression.
func (b Binding) HasBindings() bool { return len(b.ExprTexts) > 0 }

// SplitBinding splits a string field according to its position and reports the
// loader/compiler diagnostics that make a malformed authoring refusal
// (ADR-0022 § 1's three failure names).
//
// There are no escapes: `${{` always opens a binding, and a field that needs
// the literal sequence cannot have one (ADR-0022 § 1: "a deliberate
// limitation, not an omission"). An accidental `$${{ … }}` is therefore
// reported, not silently split into two segments the way a naive splitter
// (the spike's) did.
func SplitBinding(at ptr.Pointer, pos Position, s string) (Binding, diag.List) {
	var diags diag.List
	b := Binding{Position: pos}

	if strings.Contains(s, "$${{") {
		diags.Addf(diag.SourceCompiler, diag.CodeEscapeNotSupported, at,
			"$${{ is not an escape: there is no way to write a literal ${%s inside a binding (ADR-0022 § 1)", "{")
	}

	// A `}}` with no `${{` before it is an offset that points at nothing.
	if open0 := strings.Index(s, "}}"); open0 >= 0 && !strings.Contains(s, "${{") {
		diags.Addf(diag.SourceCompiler, diag.CodeBindingOffset, at,
			"}} at offset %d closes a binding that was never opened", open0)
		return b, diags
	}

	var segs []Segment
	i := 0
	for i < len(s) {
		open := strings.Index(s[i:], "${{")
		if open < 0 {
			segs = append(segs, Segment{Literal: s[i:], Offset: i, End: len(s)})
			break
		}
		start := i + open
		if start > i {
			segs = append(segs, Segment{Literal: s[i:start], Offset: i, End: start})
		}
		body := start + 3
		close := strings.Index(s[body:], "}}")
		if close < 0 {
			// A missing }} is malformed authoring, not a pointer into a value:
			// contract § 2's binding_offset_out_of_range is for a `}}` that names
			// a location that does not exist.
			diags.Addf(diag.SourceCompiler, diag.CodeBindingSyntax, at,
				"${{ at offset %d has no closing }}", start)
			return b, diags
		}
		end := body + close + 2
		inner := s[body : body+close]
		if strings.TrimSpace(inner) == "" {
			diags.Addf(diag.SourceCompiler, diag.CodeBindingSyntax, at,
				"binding at offset %d is empty", start)
			return b, diags
		}
		if strings.Contains(inner, "${{") {
			diags.Addf(diag.SourceCompiler, diag.CodeBindingSyntax, at,
				"binding at offset %d nests another ${", start)
			return b, diags
		}
		segs = append(segs, Segment{Expression: strings.TrimSpace(inner), IsExpr: true, Offset: start, End: end})
		i = end
	}
	if len(diags) > 0 {
		return b, diags
	}

	switch pos {
	case PositionExpression:
		// celExpression is **bare** CEL: the schema's pattern forbids the ${{ }}
		// wrapper, because a field whose whole content is an expression does not
		// need delimiters (ADR-0022 § 1, and the shipped schema's celExpression
		// pattern). A literal segment here is therefore the normal case, and an
		// interpolated one is the mistake.
		for _, sgm := range segs {
			if sgm.IsExpr {
				diags.Addf(diag.SourceCompiler, diag.CodeBindingPosition, at,
					"this field is bare CEL: found a ${{ … }} wrapper at offset %d — remove the delimiters", sgm.Offset)
				return b, diags
			}
		}
		if strings.TrimSpace(s) == "" {
			diags.Addf(diag.SourceCompiler, diag.CodeBindingSyntax, at, "expression field is empty")
			return b, diags
		}
		b.Segments = []Segment{{Expression: strings.TrimSpace(s), IsExpr: true, Offset: 0, End: len(s)}}
		b.ExprTexts = []string{strings.TrimSpace(s)}
	case PositionValue:
		if len(segs) == 1 && segs[0].IsExpr && segs[0].Offset == 0 && segs[0].End == len(s) {
			b.Segments = segs
			b.ExprTexts = []string{segs[0].Expression}
			return b, diags
		}
		for _, sgm := range segs {
			if sgm.IsExpr {
				diags.Addf(diag.SourceCompiler, diag.CodeBindingPosition, at,
					"a binding in this field must be the whole value (one ${{ … }} with nothing around it); found text at offset %d", sgm.Offset)
				return b, diags
			}
		}
		// A plain string literal in a bindingValue slot: legal, and it keeps
		// its JSON type (ADR-0022 § 1).
		b.Segments = segs
	case PositionText, PositionLiteral:
		if pos == PositionLiteral {
			for _, sgm := range segs {
				if sgm.IsExpr {
					diags.Addf(diag.SourceCompiler, diag.CodeBindingPosition, at,
						"this field takes a literal %s, not a binding (ADR-0021 § 3 keeps budgets and ids literal)", "value")
					return b, diags
				}
			}
		}
		b.Segments = segs
		for _, sgm := range segs {
			if sgm.IsExpr {
				b.ExprTexts = append(b.ExprTexts, sgm.Expression)
			}
		}
	}
	return b, diags
}

// SplitExprText splits an expression string that arrived without delimiters
// (the {expr: …} object form and every bare expression).
func SplitExprText(at ptr.Pointer, src string) (Binding, diag.List) {
	return SplitBinding(at, PositionExpression, strings.TrimSpace(src))
}

// ObjectForm is the {expr, fallback} spelling of a bindingValue field.
type ObjectForm struct {
	Expr     string
	Fallback string // raw JSON text of the fallback, "" when absent
}

// BindingValueFromJSON interprets a decoded bindingValue field. ok is false
// when diags are non-empty.
func BindingValueFromJSON(at ptr.Pointer, v any) (Binding, diag.List) {
	var diags diag.List
	if m, isMap := v.(map[string]any); isMap {
		exprText, hasExpr := m["expr"].(string)
		if !hasExpr {
			diags.Addf(diag.SourceCompiler, diag.CodeBindingSyntax, at,
				"a {expr, fallback} object needs an expr string")
			return Binding{Position: PositionValue}, diags
		}
		for k := range m {
			if k != "expr" && k != "fallback" {
				diags.Addf(diag.SourceCompiler, diag.CodeBindingSyntax, at.Child(k),
					"unknown key %q in a binding object (only expr and fallback exist)", k)
				return Binding{Position: PositionValue}, diags
			}
		}
		b, d := SplitBinding(at.Child("expr"), PositionExpression, exprText)
		if len(d) > 0 {
			return b, d
		}
		return b, diags
	}
	if s, isStr := v.(string); isStr {
		return SplitBinding(at, PositionValue, s)
	}
	// A typed literal (integer, boolean, array, object, null): no expression.
	return Binding{Position: PositionValue, Segments: []Segment{{Literal: "", Offset: 0, End: 0}}}, diags
}
