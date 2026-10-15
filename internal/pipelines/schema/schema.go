// Package schema owns the canonical v1alpha1 authoring schema and its
// validation: the asset, its digest, and the 1:1 conversion of the validator's
// structured output into path-addressed diagnostics (ADR-0021 § 2, § 7).
//
// The asset in assets/ is authoritative for Go consumers (the API serves it at
// GET /api/v1/schemas/pipeline-v1alpha1 so the UI never bundles a copy that can
// drift). communication-spec/schemas/pipeline-v1alpha1.schema.json is the
// spec-side copy of the same bytes; TestSpecCopyMatchesEmbeddedAsset is what
// keeps them from separating.
package schema

import (
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/santhosh-tekuri/jsonschema/v6"

	"github.com/dbirks/communication/internal/pipelines/canon"
	"github.com/dbirks/communication/internal/pipelines/diag"
	"github.com/dbirks/communication/internal/pipelines/ptr"
)

//go:embed assets/pipeline-v1alpha1.schema.json
var schemaAsset []byte

// ID is the schema's $id, which is also the resource key the compiler registers
// it under. ADR-0021 § 2: compiling under a synthetic URL produced
// "missing reference" for internal $refs in the spike.
const ID = "https://communication.dev/schemas/pipeline-v1alpha1.schema.json"

// JSON returns the authoritative asset bytes.
func JSON() []byte { return schemaAsset }

// Digest is the sha256 of the asset, recorded as pipeline_revisions.schema_digest
// (contract § 1) so a run can prove which schema built its plan.
func Digest() string { return canon.Digest(schemaAsset) }

// Validator is a compiled schema.
type Validator struct {
	schema *jsonschema.Schema
}

// New compiles the embedded asset. It is called once at process start by the
// API and by doctor; a failure is a build defect, not a runtime condition.
func New() (*Validator, error) {
	var doc any
	if err := json.Unmarshal(schemaAsset, &doc); err != nil {
		return nil, fmt.Errorf("schema: embedded asset is not JSON: %w", err)
	}
	c := jsonschema.NewCompiler()
	if err := c.AddResource(ID, doc); err != nil {
		return nil, fmt.Errorf("schema: add resource: %w", err)
	}
	s, err := c.Compile(ID)
	if err != nil {
		return nil, fmt.Errorf("schema: compile: %w", err)
	}
	return &Validator{schema: s}, nil
}

// MustCompile is New for package-level initialization in tests and doctor.
func MustCompile() *Validator {
	v, err := New()
	if err != nil {
		panic(err)
	}
	return v
}

// Validate checks a loader-clean document against the schema. The result holds
// one diagnostic per validator error unit (contract § 2.2: the source is
// "schema", the code is schema_shape, and the location is the payload).
func (v *Validator) Validate(doc canon.Value) diag.List {
	var out diag.List
	err := v.schema.Validate(doc)
	if err == nil {
		return out
	}
	var ve *jsonschema.ValidationError
	if !errors.As(err, &ve) {
		out.Addf(diag.SourceSchema, diag.CodeSchemaShape, ptr.Root, "%s", err.Error())
		return out
	}
	basic := ve.BasicOutput()
	var walk func(u jsonschema.OutputUnit)
	walk = func(u jsonschema.OutputUnit) {
		if u.Error != nil && u.InstanceLocation != "" {
			out.Add(diag.Diagnostic{
				Code:             diag.CodeSchemaShape,
				Source:           diag.SourceSchema,
				Message:          collapse(u.Error.String()),
				InstanceLocation: ptr.Pointer(u.InstanceLocation),
				SchemaLocation:   absoluteLocation(u.AbsoluteKeywordLocation),
				Hint:             hintFor(u.Error.String()),
			})
			return
		}
		for _, sub := range u.Errors {
			walk(sub)
		}
	}
	walk(*basic)
	if len(out) == 0 {
		out.Addf(diag.SourceSchema, diag.CodeSchemaShape, ptr.Root, "%s", collapse(ve.Error()))
	}
	return out
}

// collapse keeps a validator message on one line: the API embeds these in
// problem+json detail strings and the editor renders one line per finding.
func collapse(s string) string {
	return strings.Join(strings.Fields(strings.ReplaceAll(s, "\n", " ")), " ")
}

// absoluteLocation trims the $id prefix so the schema location is a pointer,
// which is what the editor resolves.
func absoluteLocation(loc string) string {
	if i := strings.Index(loc, "#"); i >= 0 {
		return loc[i:]
	}
	return loc
}

// hintFor turns the validator's own phrasing into the fix an author can apply.
// It quotes scalar shapes only, never a document value (ADR-0021 Security).
func hintFor(msg string) string {
	switch {
	case strings.Contains(msg, "additional properties"):
		return "this version does not know that key; a misspelled or newer field fails closed rather than being ignored"
	case strings.Contains(msg, "value must be one of"):
		return "the catalogue of names is fixed by the schema enum; see communication-spec/03-pipeline-engine.md"
	case strings.Contains(msg, "does not match pattern"):
		return "the shape is wrong (an id, a path, a secretRef or a digest); the pattern is in the schema location"
	case strings.Contains(msg, "expected integer"), strings.Contains(msg, "expected number"):
		return "this slot takes a literal number; a ${{ … }} binding there is refused by design (ADR-0021 § 3)"
	case strings.Contains(msg, "expected boolean"):
		return "YAML 1.2 reads yes/on/off as strings; write true or false"
	case strings.Contains(msg, "expected object"):
		return "this must be a JSON object"
	case strings.Contains(msg, "is not valid against any schema"), strings.Contains(msg, "oneOf"):
		return "the document matches neither Pipeline nor NodeTemplate, or both; check apiVersion/kind and the per-kind config branch"
	}
	return ""
}

// DocumentKind reports which top-level branch a document targets, for the
// loader's unknown_document_kind rule and for the compiler's dispatch.
func DocumentKind(doc canon.Value) string {
	m, ok := doc.(map[string]canon.Value)
	if !ok {
		return ""
	}
	k, _ := m["kind"].(string)
	return k
}

// PointerOf returns the pointer for a nested field, used by tests and the
// compiler when it re-walks the document for binding positions.
func PointerOf(segments ...string) ptr.Pointer {
	var p ptr.Pointer
	for _, s := range segments {
		p = p.Child(s)
	}
	return p
}
