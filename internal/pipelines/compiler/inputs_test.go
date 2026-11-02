package compiler

// Typed workflow inputs (ADR-0066): the x-communication-input annotation, the
// two compiler findings it can raise, and Plan.InputSpecs. This file is an
// internal test because input_type_unknown / input_default_invalid block
// Compile (it returns no plan), while the degraded spec list is exactly what
// those findings promise — so the parse is exercised directly, and the happy
// path still goes through loader → schema → Compile.

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/dbirks/communication/internal/pipelines/diag"
	"github.com/dbirks/communication/internal/pipelines/loader"
	"github.com/dbirks/communication/internal/pipelines/ptr"
	"github.com/dbirks/communication/internal/pipelines/schema"
)

// indentInputs shifts a flush-left inputs block under spec:.
func indentInputs(block string) string {
	lines := strings.Split(strings.TrimRight(block, "\n"), "\n")
	for i := range lines {
		lines[i] = "    " + lines[i]
	}
	return strings.Join(lines, "\n")
}

// pipelineWithInputs loads a schema-clean Pipeline carrying the inputs block.
func pipelineWithInputs(t *testing.T, block string) loader.Document {
	t.Helper()
	src := "apiVersion: communication.dev/v1alpha1\n" +
		"kind: Pipeline\nmetadata:\n  name: typed-inputs\nspec:\n  inputs:\n" +
		indentInputs(block) + "\n" +
		"  nodes:\n  - id: build\n    kind: process.exec\n    config:\n      executable: go\n      args: [\"version\"]\n"
	doc, d := loader.Load([]byte(src))
	if !d.Valid() {
		t.Fatalf("loader rejected the document: %v", d)
	}
	if d = schema.MustCompile().Validate(doc.Value); !d.Valid() {
		t.Fatalf("schema rejected the document: %v", d)
	}
	return doc
}

// parseInputs runs the ADR-0066 parse on the block alone, at the pointer the
// walk would use.
func parseInputs(t *testing.T, block string) ([]InputSpec, diag.List) {
	t.Helper()
	spec := pipelineWithInputs(t, block).Map()["spec"].(map[string]canonValue)["inputs"]
	return specsByParse(spec)
}

func specsByParse(v canonValue) ([]InputSpec, diag.List) {
	return inputSpecs(v, ptr.Root.Child("spec").Child("inputs"))
}

func findSpec(t *testing.T, specs []InputSpec, name string) InputSpec {
	t.Helper()
	for _, s := range specs {
		if s.Name == name {
			return s
		}
	}
	t.Fatalf("no input spec named %q in %+v", name, specs)
	return InputSpec{}
}

func hasCode(d diag.List, code diag.Code) *diag.Diagnostic {
	for i := range d {
		if d[i].Code == code {
			return &d[i]
		}
	}
	return nil
}

func inputTypes(specs []InputSpec) string {
	var b strings.Builder
	for _, s := range specs {
		b.WriteString(s.Name + "=" + s.Type + " ")
	}
	return strings.TrimSpace(b.String())
}

// The five ADR-0066 types parse, with their label and help, sorted by name.
func TestInputSpecsParseEveryType(t *testing.T) {
	plan, d := Compile(pipelineWithInputs(t, `
type: object
properties:
  notes:
    type: string
    x-communication-input: {type: long_text, label: Notes, help: Long context for the agent}
  issue:
    type: object
    x-communication-input: {type: github_issue, label: Issue, help: The issue to work on}
  profile:
    type: string
    x-communication-input: {type: agent_profile, label: Agent profile}
  base:
    type: string
    x-communication-input: {type: branch, label: Base branch, help: Short ref name}
  goal:
    type: string
    x-communication-input: {type: text, label: Goal}
`), Options{})
	if !d.Valid() {
		t.Fatalf("compile raised findings: %v", d)
	}

	specs := plan.InputSpecs()
	if got, want := len(specs), 5; got != want {
		t.Fatalf("got %d specs, want %d: %s", got, want, inputTypes(specs))
	}
	for i := 1; i < len(specs); i++ {
		if specs[i-1].Name >= specs[i].Name {
			t.Errorf("specs are not sorted by name: %s", inputTypes(specs))
		}
	}

	want := []InputSpec{
		{Name: "base", Type: InputTypeBranch, Label: "Base branch", Help: "Short ref name"},
		{Name: "goal", Type: InputTypeText, Label: "Goal"},
		{Name: "issue", Type: InputTypeGithubIssue, Label: "Issue", Help: "The issue to work on"},
		{Name: "notes", Type: InputTypeLongText, Label: "Notes", Help: "Long context for the agent"},
		{Name: "profile", Type: InputTypeAgentProfile, Label: "Agent profile"},
	}
	for _, w := range want {
		got := findSpec(t, specs, w.Name)
		if got.Type != w.Type || got.Label != w.Label || got.Help != w.Help {
			t.Errorf("input %q = type %q label %q help %q, want type %q label %q help %q",
				w.Name, got.Type, got.Label, got.Help, w.Type, w.Label, w.Help)
		}
	}
	// The annotation is an addition, not a replacement: the schema the
	// expression checker and run-input validation read is still verbatim.
	obj, ok := plan.Inputs.(map[string]canonValue)
	if !ok {
		t.Fatalf("plan.inputs is %T, want an object", plan.Inputs)
	}
	props, _ := obj["properties"].(map[string]canonValue)
	issue, _ := props["issue"].(map[string]canonValue)
	if issue["type"] != "object" {
		t.Errorf("plan.inputs.properties.issue.type = %v, want object", issue["type"])
	}
	if _, has := issue[InputTypeAnnotation]; !has {
		t.Errorf("plan.inputs dropped the %s annotation", InputTypeAnnotation)
	}
}

// An un-annotated property is a valid document and means text (ADR-0066).
func TestInputSpecWithoutAnnotationIsText(t *testing.T) {
	plan, d := Compile(pipelineWithInputs(t, `
type: object
properties:
  goal: {type: string}
`), Options{})
	if !d.Valid() {
		t.Fatalf("a document with no annotation must stay valid: %v", d)
	}
	specs := plan.InputSpecs()
	if len(specs) != 1 {
		t.Fatalf("got %s, want one spec", inputTypes(specs))
	}
	if got := findSpec(t, specs, "goal"); got.Type != InputTypeText {
		t.Errorf("un-annotated input type = %q, want %q", got.Type, InputTypeText)
	}

	// A plan with no inputs block at all answers "no inputs", not a panic.
	bare, d := Compile(pipelineWithInputs(t, "type: object\n"), Options{})
	if !d.Valid() {
		t.Fatalf("compile raised findings: %v", d)
	}
	if got := bare.InputSpecs(); len(got) != 0 {
		t.Errorf("empty schema yielded %s", inputTypes(got))
	}
}

// An unknown type is a finding, and the input degrades to text rather than
// vanishing from the list the editor renders.
func TestInputUnknownTypeIsADiagnostic(t *testing.T) {
	specs, d := parseInputs(t, `
type: object
properties:
  target:
    type: string
    x-communication-input: {type: slack_channel, label: Channel}
`)
	got := hasCode(d, diag.CodeInputTypeUnknown)
	if got == nil {
		t.Fatalf("no input_type_unknown finding; got %v", d)
	}
	if want := "/spec/inputs/properties/target/x-communication-input/type"; string(got.InstanceLocation) != want {
		t.Errorf("instance location = %s, want %s", got.InstanceLocation, want)
	}
	for _, want := range []string{"slack_channel", "github_issue", "long_text"} {
		if !strings.Contains(got.Message, want) {
			t.Errorf("message %q does not name %q", got.Message, want)
		}
	}
	if s := findSpec(t, specs, "target"); s.Type != InputTypeText {
		t.Errorf("unknown type left the input as %q, want the %q fallback", s.Type, InputTypeText)
	}
	if s := findSpec(t, specs, "target"); s.Label != "Channel" {
		t.Errorf("the fallback dropped the label: %q", s.Label)
	}

	// A numeric type value is the same finding, and its default is not
	// second-guessed on top of it.
	_, d = parseInputs(t, "type: object\nproperties:\n  a: {type: string, default: 7, x-communication-input: {type: 7}}\n")
	if hasCode(d, diag.CodeInputTypeUnknown) == nil {
		t.Fatalf("a numeric type produced no input_type_unknown; got %v", d)
	}
	if hasCode(d, diag.CodeInputDefaultInvalid) != nil {
		t.Fatalf("an unusable type also raised a default finding; got %v", d)
	}
	// A malformed annotation is the same finding.
	_, d = parseInputs(t, "type: object\nproperties:\n  a: {type: string, x-communication-input: branch}\n")
	if hasCode(d, diag.CodeInputTypeUnknown) == nil {
		t.Fatalf("a scalar annotation produced no input_type_unknown; got %v", d)
	}
}

// `default` stays JSON Schema's member, so it has to fit the annotated type's
// runtime shape (ADR-0066).
func TestInputDefaultMustMatchTheType(t *testing.T) {
	bad := []struct{ name, block string }{
		{"string for branch", "type: object\nproperties:\n  base: {type: string, default: 42, x-communication-input: {type: branch}}\n"},
		{"bool for agent_profile", "type: object\nproperties:\n  profile: {type: string, default: true, x-communication-input: {type: agent_profile}}\n"},
		{"string for text", "type: object\nproperties:\n  goal: {type: string, default: 1.5, x-communication-input: {type: text}}\n"},
		{"array for long_text", "type: object\nproperties:\n  notes: {type: string, default: [a], x-communication-input: {type: long_text}}\n"},
		{"scalar for github_issue", "type: object\nproperties:\n  issue: {type: object, default: \"oops\", x-communication-input: {type: github_issue}}\n"},
		{"non-integer issue number", "type: object\nproperties:\n  issue:\n    type: object\n    default: {number: seven}\n    x-communication-input: {type: github_issue}\n"},
		{"non-string issue title", "type: object\nproperties:\n  issue:\n    type: object\n    default: {number: 12, title: 3}\n    x-communication-input: {type: github_issue}\n"},
	}
	for _, tc := range bad {
		_, d := parseInputs(t, tc.block)
		got := hasCode(d, diag.CodeInputDefaultInvalid)
		if got == nil {
			t.Errorf("%s: no input_default_invalid finding; got %v", tc.name, d)
			continue
		}
		if !strings.HasPrefix(string(got.InstanceLocation), "/spec/inputs/properties/") {
			t.Errorf("%s: instance location = %s", tc.name, got.InstanceLocation)
		}
	}

	good := []struct{ name, block string }{
		{"branch default", "type: object\nproperties:\n  base: {type: string, default: main, x-communication-input: {type: branch}}\n"},
		{"agent profile default", "type: object\nproperties:\n  profile: {type: string, default: pi-reviewer, x-communication-input: {type: agent_profile}}\n"},
		{"text defaults", "type: object\nproperties:\n  goal: {type: string, default: fix the flake, x-communication-input: {type: text}}\n  notes: {type: string, default: '', x-communication-input: {type: long_text}}\n"},
		{"partial issue default", "type: object\nproperties:\n  issue:\n    type: object\n    default: {number: 512, title: Ship it, repo: communication}\n    x-communication-input: {type: github_issue}\n"},
		{"no default at all", "type: object\nproperties:\n  issue: {type: object, x-communication-input: {type: github_issue}}\n"},
		// Compatibility pin (ADR-0066): the m4 seed document carries un-annotated
		// typed-like inputs whose defaults are not strings. "Treated as text" is a
		// presentation rule; it must not retroactively invalidate those documents.
		{"un-annotated boolean input (m4 seed shape)", "type: object\nproperties:\n  fanout: {type: boolean, default: false}\n  fanout_count: {type: integer, default: 3}\n"},
		{"annotation without a type still means text", "type: object\nproperties:\n  goal: {type: string, default: go, x-communication-input: {label: Goal}}\n"},
	}
	for _, tc := range good {
		_, d := parseInputs(t, tc.block)
		if h := hasCode(d, diag.CodeInputDefaultInvalid); h != nil {
			t.Errorf("%s: unexpected finding %v", tc.name, h)
		}
		if !d.Valid() {
			t.Errorf("%s: unexpected findings %v", tc.name, d)
		}
	}

	// The Default field carries the authored value, in the loader's number model.
	specs, _ := parseInputs(t, "type: object\nproperties:\n  base: {type: string, default: main, x-communication-input: {type: branch}}\n  issue:\n    type: object\n    default: {number: 512}\n    x-communication-input: {type: github_issue}\n")
	if got := findSpec(t, specs, "base").Default; got != "main" {
		t.Errorf("branch default = %#v, want \"main\"", got)
	}
	issue, _ := findSpec(t, specs, "issue").Default.(map[string]canonValue)
	if number, ok := issue["number"].(int64); !ok || number != 512 {
		t.Errorf("issue default number = %#v, want int64(512)", issue["number"])
	}
	if findSpec(t, specs, "issue").Default == nil {
		t.Error("a declared default was dropped")
	}
}

// `required` stays JSON Schema's array: no shadow copy in the annotation.
func TestInputRequiredComesFromTheRequiredArray(t *testing.T) {
	plan, d := Compile(pipelineWithInputs(t, `
type: object
properties:
  issue: {type: object, x-communication-input: {type: github_issue}}
  base: {type: string, default: main, x-communication-input: {type: branch}}
required: [issue]
`), Options{})
	if !d.Valid() {
		t.Fatalf("compile raised findings: %v", d)
	}
	specs := plan.InputSpecs()
	if !findSpec(t, specs, "issue").Required {
		t.Error("issue is in the required array but reports Required false")
	}
	if findSpec(t, specs, "base").Required {
		t.Error("base is not in the required array but reports Required true")
	}

	// A required name with no property is the schema's business, not ours.
	_, d = parseInputs(t, "type: object\nproperties:\n  base: {type: string}\nrequired: [ghost]\n")
	if !d.Valid() {
		t.Errorf("an unmatched required entry produced compiler findings %v", d)
	}
}

// InputSpecs is derived, so a plan read back out of compiled_plan answers the
// same way — and nothing new is stored in the plan bytes (ADR-0066).
func TestInputSpecsSurviveAPlanJSONRoundTrip(t *testing.T) {
	plan, d := Compile(pipelineWithInputs(t, `
type: object
properties:
  issue: {type: object, x-communication-input: {type: github_issue, label: Issue}}
  base: {type: string, default: main, x-communication-input: {type: branch, label: Base}}
  goal: {type: string}
required: [issue]
`), Options{})
	if !d.Valid() {
		t.Fatalf("compile raised findings: %v", d)
	}
	raw, err := json.Marshal(plan)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if strings.Contains(string(raw), "input_specs") {
		t.Error("the plan stores a derived input-spec field")
	}
	var back Plan
	if err := json.Unmarshal(raw, &back); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	before, after := plan.InputSpecs(), back.InputSpecs()
	if len(before) != len(after) {
		t.Fatalf("round trip lost specs: %s vs %s", inputTypes(before), inputTypes(after))
	}
	for i := range before {
		if before[i].Name != after[i].Name || before[i].Type != after[i].Type ||
			before[i].Label != after[i].Label || before[i].Help != after[i].Help ||
			before[i].Required != after[i].Required {
			t.Errorf("spec %d differs after the round trip: %+v vs %+v", i, before[i], after[i])
		}
	}
	if got := findSpec(t, after, "issue").Default; got != nil {
		t.Errorf("an absent default came back as %#v", got)
	}
	if specs, d := specsByParse(back.Inputs); !d.Valid() || len(specs) != len(before) {
		t.Errorf("re-parse of the round-tripped schema raised %v / %d specs", d, len(specs))
	}
}
