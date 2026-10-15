// Package diag carries the path-addressed diagnostic every stage of the
// pipeline definition layer emits: the loader, the JSON Schema validator and
// the compiler all report the same shape, which is what lets
// POST /api/v1/drafts/{id}/validate answer one shape for three sources
// (ADR-0021 § 7, contract § 2.2).
//
// Error codes are a public contract: the editor's help links and the
// assistant's fixes name them, so adding one is additive and renaming one is
// not (contract § 2.2). The constants below are that contract, verbatim.
package diag

import (
	"fmt"
	"sort"
	"strings"

	"github.com/dbirks/communication/internal/pipelines/ptr"
)

// Source names the stage that produced a diagnostic. The three sources are
// ordered, not merged: loader rules gate the JSON the schema sees, then the
// schema validator, then the compiler.
type Source string

const (
	SourceLoader   Source = "loader"
	SourceSchema   Source = "schema"
	SourceCompiler Source = "compiler"
	// SourceRuntime marks a failure the plan-side evaluator hit. Validate
	// never produces it; the advancer does (contract § 5.1 step 6).
	SourceRuntime Source = "runtime"
)

// Code is a machine-readable failure name.
type Code string

const (
	// loader (ADR-0021 § 4)
	CodeInvalidYAML       Code = "invalid_yaml"
	CodeDocumentTooLarge  Code = "document_too_large"
	CodeMultipleDocuments Code = "multiple_documents"
	CodeDuplicateKey      Code = "duplicate_key"
	CodeAliasBudget       Code = "alias_budget_exceeded"
	CodeInvalidNumber     Code = "invalid_number"
	CodeUnquotedDate      Code = "unquoted_date"
	CodeUnknownDocument   Code = "unknown_document_kind"

	// schema (one unit per validator error; the location is the payload)
	CodeSchemaShape Code = "schema_shape"

	// topology / identity
	CodeDuplicateNodeID     Code = "duplicate_node_id"
	CodeUnknownDependency   Code = "unknown_dependency"
	CodeSelfDependency      Code = "self_dependency"
	CodeCycleDetected       Code = "cycle_detected"
	CodeDependsOutsideScope Code = "depends_on_outside_scope"
	CodeScopeEntryAmbiguous Code = "scope_entry_ambiguous"
	CodeUnreachableTerminal Code = "unreachable_terminal"
	CodeGraphTooLarge       Code = "graph_too_large"
	CodeEmptyBody           Code = "empty_body"

	// bindings (ADR-0022)
	CodeBindingSyntax      Code = "binding_syntax_error"
	CodeBindingOffset      Code = "binding_offset_out_of_range"
	CodeBindingPosition    Code = "binding_position_mismatch"
	CodeEscapeNotSupported Code = "escape_not_supported"
	CodeExpressionTooLarge Code = "expression_too_large"
	CodeCELCompile         Code = "cel_compile_error"
	CodeUndeclaredRoot     Code = "undeclared_root"
	CodeFunctionNotAllowed Code = "cel_function_not_allowed"
	CodeNonBoolean         Code = "non_boolean_expression"
	CodeUnknownField       Code = "unknown_field"
	CodeTypeMismatch       Code = "type_mismatch"
	CodeUndeclaredOutput   Code = "undeclared_output_schema"
	CodeReservedNodeID     Code = "reserved_node_id"
	CodeExpressionBudget   Code = "expression_budget_exceeded"

	// policy / registry
	CodeKindNotImplemented     Code = "kind_not_implemented"
	CodeTemplatePublishDefer   Code = "template_publish_deferred"
	CodeUnresolvedTemplate     Code = "unresolved_node_template"
	CodeSecretLiteral          Code = "secret_literal_detected"
	CodeInvalidSecretRef       Code = "invalid_secret_ref"
	CodeUnknownProfile         Code = "unknown_profile"
	CodeUnknownRepository      Code = "unknown_repository"
	CodeUnknownNodeTemplate    Code = "unknown_node_template"
	CodeUnsupportedSessionMode Code = "unsupported_session_mode"
	CodeUnsupportedPolicy      Code = "unsupported_policy"
	CodeChildDepthExceeded     Code = "child_depth_exceeded"
	CodeBudgetBelowMinimum     Code = "budget_below_minimum"
	CodeBudgetAboveCeiling     Code = "budget_exceeds_assignment_ceiling"
)

// Diagnostic is one structured finding. Locations are JSON pointers:
// InstanceLocation points into the submitted document (what the editor
// highlights), SchemaLocation points into the schema (why it failed).
type Diagnostic struct {
	Code             Code        `json:"code"`
	Source           Source      `json:"source"`
	Message          string      `json:"message"`
	InstanceLocation ptr.Pointer `json:"instance_location"`
	SchemaLocation   string      `json:"schema_location,omitempty"`
	Hint             string      `json:"hint,omitempty"`
}

func (d Diagnostic) String() string {
	var b strings.Builder
	fmt.Fprintf(&b, "%s [%s] %s", d.Code, d.InstanceLocation, d.Message)
	if d.SchemaLocation != "" {
		fmt.Fprintf(&b, " (schema %s)", d.SchemaLocation)
	}
	return b.String()
}

// List is a diagnostic set with the ordering the validate response promises:
// sorted by (instance_location, schema_location, code, message) so the same
// document always renders the same bytes (contract § 2.2).
type List []Diagnostic

// Add appends a diagnostic.
func (l *List) Add(d Diagnostic) {
	if d.Source == "" {
		d.Source = SourceCompiler
	}
	*l = append(*l, d)
}

// Addf appends a diagnostic with a formatted message.
func (l *List) Addf(src Source, code Code, instanceLocation ptr.Pointer, format string, args ...any) {
	l.Add(Diagnostic{
		Code:             code,
		Source:           src,
		Message:          fmt.Sprintf(format, args...),
		InstanceLocation: instanceLocation,
	})
}

// Extend appends every diagnostic from other.
func (l *List) Extend(other List) { *l = append(*l, other...) }

// Valid reports whether the list holds no findings. Every code in this
// package is a block: notes carry the informational half (ADR-0021 § 7).
func (l List) Valid() bool { return len(l) == 0 }

// SortOrders the list in contract order, in place.
func (l List) SortOrder() {
	sort.SliceStable(l, func(i, j int) bool {
		a, b := l[i], l[j]
		if a.InstanceLocation != b.InstanceLocation {
			return a.InstanceLocation < b.InstanceLocation
		}
		if a.SchemaLocation != b.SchemaLocation {
			return a.SchemaLocation < b.SchemaLocation
		}
		if a.Code != b.Code {
			return a.Code < b.Code
		}
		return a.Message < b.Message
	})
}
