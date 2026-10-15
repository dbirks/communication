package expr_test

import (
	"strings"
	"testing"

	"github.com/dbirks/communication/internal/pipelines/expr"
	"github.com/dbirks/communication/internal/pipelines/ptr"
)

// FuzzSplitBinding is contract § 8's property/fuzz row for the `${{ … }}`
// splitter (spec 12 "Property/fuzz"). The splitter slices author text at
// offsets a browser editor also highlights, so the properties that must never
// break are: no panic, deterministic splits, segments that tile the input
// without gaps or overlaps, and segment offsets that actually point where the
// segment claims to be.
func FuzzSplitBinding(f *testing.F) {
	seeds := []string{
		"Build it",
		"Build ${{ inputs.goal }} now",
		"${{ inputs.goal }}",
		"Build ${{ inputs.goal }}",
		"${{  }}",
		"${{ inputs.goal }}",
		"${{ inputs.goal",
		"cost is $${{ x }}",
		"}}",
		"a}}b${{c}}d",
		"${{ ${{ x }} }}",
		"${{\t\n }}",
		"${{a}}{{b}}",
		"${{ " + strings.Repeat("x", 2100) + " }}",
		"$${{x}}",
		"${{{$&x}}}",
		"",
	}
	for _, s := range seeds {
		f.Add(s)
	}
	positions := []expr.Position{expr.PositionText, expr.PositionValue, expr.PositionExpression, expr.PositionLiteral}
	f.Fuzz(func(t *testing.T, s string) {
		for _, pos := range positions {
			first, d1 := expr.SplitBinding(ptr.Root, pos, s)
			second, d2 := expr.SplitBinding(ptr.Root, pos, s)
			// Determinism: the same bytes split the same way every time.
			if len(d1) != len(d2) {
				t.Fatalf("split of %q is not deterministic (%d vs %d diagnostics)", s, len(d1), len(d2))
			}
			for i := range d1 {
				if d1[i].Code != d2[i].Code {
					t.Fatalf("diagnostic %d changed code for %q", i, s)
				}
			}
			if len(first.Segments) != len(second.Segments) {
				t.Fatalf("segment count changed for %q", s)
			}
			if len(d1) > 0 {
				// A refusal needs a message and a code an author can act on.
				for _, x := range d1 {
					if x.Code == "" || x.Message == "" {
						t.Fatalf("refusal of %q carries no code or message: %v", s, d1)
					}
				}
				continue
			}
			// Offsets must be well-formed slices of the input and must
			// reproduce the segment they name.
			prev := 0
			for _, seg := range first.Segments {
				if seg.Offset < 0 || seg.End > len(s) || seg.Offset > seg.End {
					t.Fatalf("segment offsets [%d,%d) out of range for %q", seg.Offset, seg.End, s)
				}
				if pos != expr.PositionExpression && seg.Offset != prev {
					// Text/Value/Literal splits tile the input exactly; the
					// expression position trims and holds one whole segment.
					t.Fatalf("segments do not tile the input at offset %d (expected %d) for %q", seg.Offset, prev, s)
				}
				raw := s[seg.Offset:seg.End]
				if seg.IsExpr && pos != expr.PositionExpression {
					if !strings.HasPrefix(raw, "${{") || !strings.HasSuffix(raw, "}}") {
						t.Fatalf("expression segment %q does not hold its delimiters in %q", raw, s)
					}
					if strings.TrimSpace(raw[3:len(raw)-2]) != seg.Expression {
						t.Fatalf("segment.Expression %q does not match the source %q", seg.Expression, raw)
					}
					if seg.Expression == "" {
						t.Fatalf("empty expression segment accepted for %q", s)
					}
				} else if !seg.IsExpr && pos != expr.PositionExpression && raw != seg.Literal {
					t.Fatalf("literal segment %q does not match the source %q", seg.Literal, raw)
				}
				prev = seg.End
			}
			if pos != expr.PositionExpression && prev != len(s) && len(first.Segments) > 0 {
				t.Fatalf("segments stop at %d, input is %d bytes: %q", prev, len(s), s)
			}
		}
	})
}

// FuzzCompileExpression asserts the resource bounds hold for **every**
// generated expression under the restricted environment (ADR-0022 § 5's
// "budgeted evaluation" as a property, not a constant): no panic, the limits
// the compiler promises are the limits an accepted expression obeys, and the
// normalized AST — plan_digest's content — is stable across preparations.
func FuzzCompileExpression(f *testing.F) {
	seeds := []string{
		"nodes.review.outputs.approved == true",
		"size(inputs.goal) <= 4096",
		"inputs.a" + strings.Repeat(".b", 40) + " == 1",
		"inputs.a" + strings.Repeat(".b", 16),
		"inputs.a in [1,2,3]",
		"1 < 2 && 3 < 4",
		"'a' in ['a']",
		"has(nodes.review.outputs.x)",
		"inputs.goal == '" + strings.Repeat("x", 2100) + "'",
		"now()",
		"inputs.goal == ",
		"${{ inputs.goal }}",
		"(((1)))",
		"inputs.\x00",
		"inputs.\t",
		"\"\xc3\x28\"",
		"int(uint(1))",
		"[1,2,3].size()",
	}
	for _, s := range seeds {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, src string) {
		sc := expr.ScopeContext{
			Scope:  expr.ScopePipeline,
			Nodes:  map[string]*expr.SchemaNode{"review": expr.OpenSchema()},
			Inputs: expr.OpenSchema(),
		}
		got, d := expr.Compile(src, sc, ptr.Root)
		if !d.Valid() {
			for _, x := range d {
				if x.Code == "" || x.Message == "" {
					t.Fatalf("refusal of %q is not actionable: %v", src, d)
				}
			}
			return
		}
		// Accepted ⇒ every bound holds. These are the contract § 6 numbers.
		if len(got.Source) > expr.ExpressionSizeLimit {
			t.Fatalf("accepted an expression of %d chars (limit %d)", len(got.Source), expr.ExpressionSizeLimit)
		}
		if got.NodeCount() > expr.ExpressionNodeLimit {
			t.Fatalf("accepted an expression of %d AST nodes (limit %d)", got.NodeCount(), expr.ExpressionNodeLimit)
		}
		if got.Depth > expr.ExpressionNestingLimit {
			t.Fatalf("accepted an expression nesting %d levels deep (limit %d)", got.Depth, expr.ExpressionNestingLimit)
		}
		if strings.Contains(got.Normalized, "\n") {
			t.Fatalf("normalized AST holds a newline (plan_digest would bake a wrap in): %q", got.Normalized)
		}
		// Source ↔ normalized-AST round trip, property form: recompiling the
		// same source must reproduce the same normalized text byte for byte.
		again, d2 := expr.Compile(src, sc, ptr.Root)
		if !d2.Valid() || again.Normalized != got.Normalized {
			t.Fatalf("AST normalization is not stable for %q: %q vs %q (%v)", src, got.Normalized, again.Normalized, d2)
		}
	})
}
