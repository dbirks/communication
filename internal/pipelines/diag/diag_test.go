package diag_test

import (
	"sort"
	"strings"
	"testing"

	"github.com/dbirks/communication/internal/pipelines/diag"
	"github.com/dbirks/communication/internal/pipelines/ptr"
)

func TestAddDefaultsSourceToCompiler(t *testing.T) {
	var l diag.List
	l.Add(diag.Diagnostic{Code: diag.CodeCELCompile, Message: "m", InstanceLocation: ptr.Root})
	if l[0].Source != diag.SourceCompiler {
		t.Fatalf("Source = %q, want compiler", l[0].Source)
	}
	l.Add(diag.Diagnostic{Code: diag.CodeSchemaShape, Source: diag.SourceSchema, Message: "m"})
	if l[1].Source != diag.SourceSchema {
		t.Fatal("an explicit source must survive")
	}
}

func TestAddfFormats(t *testing.T) {
	var l diag.List
	l.Addf(diag.SourceLoader, diag.CodeInvalidNumber, ptr.Root.Child("n"), "integer %q has a leading zero", "0123")
	if !strings.Contains(l[0].Message, `"0123"`) {
		t.Fatalf("Message = %q", l[0].Message)
	}
	if l[0].Source != diag.SourceLoader || l[0].Code != diag.CodeInvalidNumber {
		t.Fatalf("%+v", l[0])
	}
}

func TestExtendAndValid(t *testing.T) {
	var a, b diag.List
	a.Addf(diag.SourceLoader, diag.CodeDuplicateKey, ptr.Root, "x")
	if !a.Valid() == (len(a) == 0) {
		t.Fatal("Valid disagrees with length")
	}
	if a.Valid() {
		t.Fatal("a non-empty list reported valid")
	}
	a.Extend(b)
	if len(a) != 1 {
		t.Fatalf("Extend with an empty list changed the list: %d", len(a))
	}
	var more diag.List
	more.Addf(diag.SourceSchema, diag.CodeSchemaShape, ptr.Root.Child("k"), "y")
	a.Extend(more)
	if len(a) != 2 || a[1].Code != diag.CodeSchemaShape {
		t.Fatalf("Extend: %+v", a)
	}
	var empty diag.List
	if !empty.Valid() {
		t.Fatal("the empty list must be valid — it gates every stage")
	}
}

// TestSortOrderIsTheContractOrder: the validate response must render the same
// document with the same bytes every time, so List sorts by
// (instance_location, schema_location, code, message) — contract § 2.2.
func TestSortOrderIsTheContractOrder(t *testing.T) {
	var l diag.List
	l.Add(diag.Diagnostic{Code: "z", Source: diag.SourceCompiler, Message: "late", InstanceLocation: "/b"})
	l.Add(diag.Diagnostic{Code: "a", Source: diag.SourceCompiler, Message: "m", InstanceLocation: "/a", SchemaLocation: "#/1"})
	l.Add(diag.Diagnostic{Code: "a", Source: diag.SourceCompiler, Message: "m", InstanceLocation: "/a", SchemaLocation: "#/0"})
	l.Add(diag.Diagnostic{Code: "b", Source: diag.SourceCompiler, Message: "m", InstanceLocation: "/a", SchemaLocation: "#/0"})
	l.Add(diag.Diagnostic{Code: "a", Source: diag.SourceCompiler, Message: "aaa", InstanceLocation: "/a", SchemaLocation: "#/0"})
	l.SortOrder()
	if l[0].Message != "aaa" || l[1].Message != "m" {
		t.Fatalf("message tiebreak: %+v", l)
	}
	if l[2].Code != "b" {
		t.Fatalf("code tiebreak: %+v", l)
	}
	if l[3].SchemaLocation != "#/1" || l[4].InstanceLocation != "/b" {
		t.Fatalf("location ordering: %+v", l)
	}
	// Sorting twice changes nothing (the response bytes must be a pure
	// function of the findings).
	before := render(l)
	l.SortOrder()
	if render(l) != before {
		t.Fatal("SortOrder is not stable")
	}
}

func render(l diag.List) string {
	var b strings.Builder
	for _, x := range l {
		b.WriteString(x.String() + "\n")
	}
	return b.String()
}

// TestCodesAreThePublicContract: the code strings are what editors and the
// assistant link to — adding is fine, renaming is not. Pinning the whole set
// (sorted) makes any rename a loud test failure. A new code must also be
// added here deliberately, which is the checkpoint the contract § 2.2 note
// asks for.
func TestCodesAreThePublicContract(t *testing.T) {
	published := []string{
		// loader
		"invalid_yaml", "document_too_large", "multiple_documents", "duplicate_key",
		"alias_budget_exceeded", "invalid_number", "unquoted_date", "unknown_document_kind",
		// schema
		"schema_shape",
		// topology / identity
		"duplicate_node_id", "unknown_dependency", "self_dependency", "cycle_detected",
		"depends_on_outside_scope", "scope_entry_ambiguous", "unreachable_terminal",
		"graph_too_large", "empty_body",
		// bindings
		"binding_syntax_error", "binding_offset_out_of_range", "binding_position_mismatch",
		"escape_not_supported", "expression_too_large", "cel_compile_error",
		"undeclared_root", "cel_function_not_allowed", "non_boolean_expression",
		"unknown_field", "type_mismatch", "undeclared_output_schema", "reserved_node_id",
		"expression_budget_exceeded",
		// policy / registry
		"kind_not_implemented", "template_publish_deferred", "unresolved_node_template",
		"secret_literal_detected", "invalid_secret_ref", "unknown_profile",
		"unknown_repository", "unknown_node_template", "unsupported_session_mode",
		"unsupported_policy", "child_depth_exceeded", "budget_below_minimum",
		"budget_exceeds_assignment_ceiling",
	}
	set := map[string]bool{}
	for _, c := range []diag.Code{
		diag.CodeInvalidYAML, diag.CodeDocumentTooLarge, diag.CodeMultipleDocuments,
		diag.CodeDuplicateKey, diag.CodeAliasBudget, diag.CodeInvalidNumber,
		diag.CodeUnquotedDate, diag.CodeUnknownDocument, diag.CodeSchemaShape,
		diag.CodeDuplicateNodeID, diag.CodeUnknownDependency, diag.CodeSelfDependency,
		diag.CodeCycleDetected, diag.CodeDependsOutsideScope, diag.CodeScopeEntryAmbiguous,
		diag.CodeUnreachableTerminal, diag.CodeGraphTooLarge, diag.CodeEmptyBody,
		diag.CodeBindingSyntax, diag.CodeBindingOffset, diag.CodeBindingPosition,
		diag.CodeEscapeNotSupported, diag.CodeExpressionTooLarge, diag.CodeCELCompile,
		diag.CodeUndeclaredRoot, diag.CodeFunctionNotAllowed, diag.CodeNonBoolean,
		diag.CodeUnknownField, diag.CodeTypeMismatch, diag.CodeUndeclaredOutput,
		diag.CodeReservedNodeID, diag.CodeExpressionBudget, diag.CodeKindNotImplemented,
		diag.CodeTemplatePublishDefer, diag.CodeUnresolvedTemplate, diag.CodeSecretLiteral,
		diag.CodeInvalidSecretRef, diag.CodeUnknownProfile, diag.CodeUnknownRepository,
		diag.CodeUnknownNodeTemplate, diag.CodeUnsupportedSessionMode, diag.CodeUnsupportedPolicy,
		diag.CodeChildDepthExceeded, diag.CodeBudgetBelowMinimum, diag.CodeBudgetAboveCeiling,
	} {
		if set[string(c)] {
			t.Fatalf("duplicate code %q", c)
		}
		set[string(c)] = true
	}
	sort.Strings(published)
	var want map[string]bool = map[string]bool{}
	for _, c := range published {
		want[c] = true
	}
	for c := range set {
		if !want[c] {
			t.Errorf("code %q is defined but not in the pinned published list (adding a code is allowed; do it here on purpose and in contract § 2.2)", c)
		}
	}
	for c := range want {
		if !set[c] {
			t.Errorf("published code %q vanished — that is a rename, which contract § 2.2 forbids", c)
		}
	}
}

func TestDiagnosticStringIsOneLineAndLocated(t *testing.T) {
	d := diag.Diagnostic{
		Code:             diag.CodeCycleDetected,
		Source:           diag.SourceCompiler,
		Message:          "scope / contains a cycle",
		InstanceLocation: ptr.Root.Child("spec"),
		SchemaLocation:   "#/$defs/node",
	}
	s := d.String()
	if strings.Contains(s, "\n") {
		t.Fatalf("String must be one line: %q", s)
	}
	for _, want := range []string{"cycle_detected", "/spec", "schema #/$defs/node"} {
		if !strings.Contains(s, want) {
			t.Fatalf("%q missing %q", s, want)
		}
	}
}
