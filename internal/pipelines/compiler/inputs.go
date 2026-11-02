package compiler

import (
	"fmt"
	"sort"
	"strings"

	"github.com/dbirks/communication/internal/pipelines/diag"
	"github.com/dbirks/communication/internal/pipelines/ptr"
)

// Typed workflow inputs (ADR-0066). spec.inputs stays a JSON Schema object: the
// annotation below is the only addition, and `required`/`default` remain the
// JSON Schema members the validator already honours. Nothing here is stored as
// a new plan field — InputSpecs derives from Plan.Inputs — so the plan bytes,
// and therefore the digest a run pins (ADR-0023 § 2), are unaffected.

// InputTypeAnnotation is the extension keyword a property under
// spec.inputs.properties may carry: {type, label, help} (ADR-0066).
const InputTypeAnnotation = "x-communication-input"

// The input types ADR-0066 defines. A property with no annotation is text.
const (
	InputTypeGithubIssue  = "github_issue"
	InputTypeBranch       = "branch"
	InputTypeAgentProfile = "agent_profile"
	InputTypeText         = "text"
	InputTypeLongText     = "long_text"
)

// InputTypes is the accepted set, in authoring order; the diagnostic quotes it.
var InputTypes = []string{
	InputTypeGithubIssue, InputTypeBranch, InputTypeAgentProfile, InputTypeText, InputTypeLongText,
}

// InputSpec is one compiled input declaration: the presentation the Inputs tab
// and the run-by-hand form need (design handoff 1j/1k), merged from the
// property's JSON Schema members and its annotation. Default is the raw
// document value (loader number model: int64/float64).
type InputSpec struct {
	Name     string `json:"name"`
	Type     string `json:"type"`
	Label    string `json:"label,omitempty"`
	Help     string `json:"help,omitempty"`
	Required bool   `json:"required"`
	Default  any    `json:"default,omitempty"`
}

// InputSpecs returns the plan's typed inputs sorted by name. It reads
// p.Inputs, so it answers the same way for a freshly compiled plan and for one
// loaded back out of pipeline_revisions.compiled_plan. Findings it would have
// raised are the compile-time diagnostics (input_type_unknown,
// input_default_invalid); an unusable annotation degrades to text rather than
// dropping the input from the list.
func (p *Plan) InputSpecs() []InputSpec {
	specs, _ := inputSpecs(p.Inputs, ptr.Root)
	return specs
}

// inputSpecs parses the block and reports the ADR-0066 findings, at the
// document pointer of the inputs schema.
func inputSpecs(v canonValue, at ptr.Pointer) ([]InputSpec, diag.List) {
	var diags diag.List
	obj, ok := v.(map[string]canonValue)
	if !ok {
		// Absent or not an object: the schema stage owns that shape (the
		// jsonSchemaObject branch), so the compiler stays silent.
		return nil, nil
	}
	props, ok := obj["properties"].(map[string]canonValue)
	if !ok {
		return nil, nil
	}
	required := stringSet(obj["required"])

	names := make([]string, 0, len(props))
	for name := range props {
		names = append(names, name)
	}
	sort.Strings(names)

	specs := make([]InputSpec, 0, len(names))
	for _, name := range names {
		ps, ok := props[name].(map[string]canonValue)
		if !ok {
			continue // shape again belongs to the schema validator
		}
		at := at.Child("properties").Child(name)
		spec := InputSpec{Name: name, Type: InputTypeText, Required: required[name]}

		// annotated records that the author opted into a declared input type.
		// Only then is `default` judged against the type's runtime shape: an
		// un-annotated property stays whatever JSON Schema says it is, which is
		// what keeps a pre-ADR-0066 document (`fanout: {type: boolean, default:
		// false}` in the m4 seed) compiling.
		annotated := false
		if ann, has := ps[InputTypeAnnotation]; has {
			annAt := at.Child(InputTypeAnnotation)
			m, ok := ann.(map[string]canonValue)
			if !ok {
				diags.Addf(diag.SourceCompiler, diag.CodeInputTypeUnknown, annAt,
					"inputs.%s: %s must be a mapping of {type, label, help}, not %s; treated as %s (ADR-0066)",
					name, inputValueKind(ann), InputTypeAnnotation, InputTypeText)
			} else {
				if tv, hasType := m["type"]; hasType {
					t, isStr := tv.(string)
					if !isStr || !knownInputType(t) {
						diags.Addf(diag.SourceCompiler, diag.CodeInputTypeUnknown, annAt.Child("type"),
							"inputs.%s: input type %s is not one of %s (ADR-0066); treated as %s",
							name, quoteValue(tv), strings.Join(InputTypes, ", "), InputTypeText)
					} else {
						spec.Type = t
						annotated = true
					}
				} else {
					annotated = true // an annotation without a type means text
				}
				spec.Label, _ = m["label"].(string)
				spec.Help, _ = m["help"].(string)
			}
		}

		if def, has := ps["default"]; has && annotated && !defaultMatchesType(spec.Type, def) {
			diags.Addf(diag.SourceCompiler, diag.CodeInputDefaultInvalid, at.Child("default"),
				"inputs.%s: the default (%s) cannot be a %s input (ADR-0066)", name, inputValueKind(def), spec.Type)
		} else if has {
			spec.Default = def
		}
		specs = append(specs, spec)
	}
	if len(specs) == 0 {
		return nil, diags
	}
	return specs, diags
}

// checkInputs raises the ADR-0066 findings on the document walk.
func (w *walk) checkInputs(v canonValue) {
	_, diags := inputSpecs(v, ptr.Root.Child("spec").Child("inputs"))
	w.diags.Extend(diags)
}

func knownInputType(t string) bool {
	for _, k := range InputTypes {
		if k == t {
			return true
		}
	}
	return false
}

// stringSet reads a JSON Schema `required` array as a name set. canon.Value is
// `any`, so the loader's arrays and a plan's round-tripped arrays are the same
// []any and one branch covers both.
func stringSet(v canonValue) map[string]bool {
	set := map[string]bool{}
	a, _ := v.([]any)
	for _, e := range a {
		if s, ok := e.(string); ok {
			set[s] = true
		}
	}
	return set
}

// defaultMatchesType checks a JSON Schema default against the annotated type's
// runtime shape (ADR-0066 § Decision). Extra github_issue members are allowed:
// a default may fill only part of the shape.
func defaultMatchesType(typ string, v canonValue) bool {
	switch typ {
	case InputTypeGithubIssue:
		m, ok := v.(map[string]canonValue)
		if !ok {
			return false
		}
		for k, sub := range m {
			switch k {
			case "number":
				if !isIntValue(sub) {
					return false
				}
			case "title", "body", "url", "repo":
				if _, ok := sub.(string); !ok {
					return false
				}
			}
		}
		return true
	case InputTypeBranch, InputTypeAgentProfile, InputTypeText, InputTypeLongText:
		_, ok := v.(string)
		return ok
	}
	return true // unknown type: input_type_unknown is already on the record
}

func isIntValue(v canonValue) bool {
	switch n := v.(type) {
	case int64:
		return true
	case int:
		return true
	case float64:
		return n == float64(int64(n))
	}
	return false
}

// inputValueKind names a value's JSON kind for the ADR-0066 messages, which
// quote it inline ("the default (a number)").
func inputValueKind(v canonValue) string {
	switch v.(type) {
	case nil:
		return "null"
	case bool:
		return "a boolean"
	case string:
		return "a string"
	case int, int64, float64:
		return "a number"
	case []any:
		return "an array"
	case map[string]any:
		return "an object"
	}
	return "an unsupported value"
}

func quoteValue(v canonValue) string {
	if s, ok := v.(string); ok {
		return fmt.Sprintf("%q", s)
	}
	return inputValueKind(v)
}
