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
	"strconv"
	"strings"

	"github.com/santhosh-tekuri/jsonschema/v6"
	"github.com/santhosh-tekuri/jsonschema/v6/kind"

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
//
// When the document's kind resolves to exactly one root oneOf branch, only that
// branch's units are reported: the sibling branch's /kind, /metadata and /spec
// refusals describe a different document and would crowd out the deep location
// the editor needs. An unknown or missing kind keeps every branch's findings.
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
	// The root oneOf is a dispatch, not a diagnosis. When the document's kind
	// names exactly one branch, the other branch's findings are noise about a
	// document the author is not writing (/kind, /metadata, /spec) and the
	// editor would highlight those instead of the real miss (exit gate C13b).
	idx, refTarget := chosenBranch(doc)
	for _, u := range leafUnits(*ve.DetailedOutput()) {
		if u.InstanceLocation == "" {
			continue
		}
		if idx >= 0 && !inBranch(u, idx, refTarget) {
			continue
		}
		for _, d := range diagnosticsFor(u, doc) {
			out.Add(d)
		}
	}
	if len(out) == 0 {
		out.Addf(diag.SourceSchema, diag.CodeSchemaShape, ptr.Root, "%s", collapse(ve.Error()))
	}
	return out
}

// diagnosticsFor converts one validator unit into the findings an editor can
// highlight. An additional-properties refusal names the offending keys but
// points at the object that holds them; the unit is reported per key instead,
// so a misspelled field is located at its own pointer. Everything else is
// reported where the validator put it.
func diagnosticsFor(u jsonschema.OutputUnit, doc canon.Value) []diag.Diagnostic {
	msg := collapse(u.Error.String())
	base := diag.Diagnostic{
		Code:             diag.CodeSchemaShape,
		Source:           diag.SourceSchema,
		Message:          msg,
		InstanceLocation: ptr.Pointer(u.InstanceLocation),
		SchemaLocation:   absoluteLocation(u.AbsoluteKeywordLocation),
		Hint:             hintFor(u.Error.String()),
	}
	ap, ok := u.Error.Kind.(*kind.AdditionalProperties)
	if !ok {
		return []diag.Diagnostic{base}
	}
	obj, ok := atPointer(doc, u.InstanceLocation).(map[string]canon.Value)
	if !ok {
		return []diag.Diagnostic{base}
	}
	var out []diag.Diagnostic
	for _, name := range ap.Properties {
		if _, held := obj[name]; !held {
			continue // the validator named something the document does not hold
		}
		d := base
		d.InstanceLocation = base.InstanceLocation.Child(name)
		out = append(out, d)
	}
	if len(out) == 0 {
		return []diag.Diagnostic{base}
	}
	return out
}

// atPointer resolves a validator instance location against the document.
func atPointer(doc canon.Value, location string) canon.Value {
	cur := doc
	for _, tok := range ptr.Pointer(location).Segments() {
		switch v := cur.(type) {
		case map[string]canon.Value:
			cur = v[tok]
		case []canon.Value:
			i, err := strconv.Atoi(tok)
			if err != nil || i < 0 || i >= len(v) {
				return nil
			}
			cur = v[i]
		default:
			return nil
		}
	}
	return cur
}

// leafUnits flattens the validator's output tree into the units that carry a
// message of their own. The detailed tree is the source rather than BasicOutput
// because the library's basic output hoists grandchildren into a flat list and,
// where a $ref wrapper has a single cause, keeps only that cause's first child:
// the deep unit (a misspelled key under a node config) disappears and only the
// wrapper survives, at the wrong location.
func leafUnits(u jsonschema.OutputUnit) []jsonschema.OutputUnit {
	if u.Error != nil {
		return []jsonschema.OutputUnit{u}
	}
	var out []jsonschema.OutputUnit
	for _, sub := range u.Errors {
		out = append(out, leafUnits(sub)...)
	}
	return out
}

// chosenBranch finds the root oneOf branch whose `kind` const equals the
// document's kind. It returns the branch index and, when the branch is a $ref,
// the local target it resolves to; idx is -1 when the kind is missing, unknown,
// or claimed by more than one branch, in which case Validate keeps every
// branch's findings as it always has.
func chosenBranch(doc canon.Value) (int, string) {
	kind := DocumentKind(doc)
	if kind == "" {
		return -1, ""
	}
	branches, ok := positionCache.root["oneOf"].([]any)
	if !ok {
		return -1, ""
	}
	idx, target := -1, ""
	for i, b := range branches {
		bm, ok := b.(map[string]any)
		if !ok {
			continue
		}
		resolved, okBranch := followRef(positionCache.root, bm)
		if !okBranch || resolved == nil || constKind(resolved) != kind {
			continue
		}
		if idx >= 0 {
			return -1, "" // ambiguous: two branches call themselves this kind
		}
		idx = i
		if ref, _ := bm["$ref"].(string); strings.HasPrefix(ref, "#") {
			target = strings.TrimPrefix(ref, "#")
		}
	}
	return idx, target
}

// inBranch reports whether a unit's schema location lies under root oneOf
// branch idx: by keyword path (/oneOf/<i>/…), or under the $ref target that
// path resolves to (#/$defs/PipelineDocument/…).
func inBranch(u jsonschema.OutputUnit, idx int, refTarget string) bool {
	if strings.HasPrefix(u.KeywordLocation, fmt.Sprintf("/oneOf/%d/", idx)) {
		return true
	}
	if refTarget != "" {
		loc := absoluteLocation(u.AbsoluteKeywordLocation)
		if loc == refTarget || strings.HasPrefix(loc, refTarget+"/") {
			return true
		}
	}
	return false
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
