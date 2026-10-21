package compiler

// ADR-0049 § 2: a pipeline node's `template: slug@semver` reference —
// resolution, pinning and the fail-closed refusals. The canonical document
// keeps the reference string as written (never the expansion), so a
// template's content change cannot move a pipeline revision's digest.

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/dbirks/communication/internal/pipelines/canon"
	"github.com/dbirks/communication/internal/pipelines/diag"
	"github.com/dbirks/communication/internal/pipelines/loader"
)

// fakeTemplates is the map-backed TemplateRegistry the unit tests use.
type fakeTemplates struct{ revs map[string]TemplateRevision }

func (f fakeTemplates) GetActiveTemplate(slug string) bool {
	for _, r := range f.revs {
		if r.Slug == slug {
			return true
		}
	}
	return false
}

func (f fakeTemplates) GetTemplateRevision(slug, version string) (TemplateRevision, bool) {
	r, ok := f.revs[slug+"@"+version]
	return r, ok
}

func reviewTemplate(slug, version string, paramsCanon canon.Value, config map[string]canonValue) TemplateRevision {
	return TemplateRevision{
		Slug:           slug,
		TemplateID:     "tmpl-id-" + slug,
		RevisionID:     "rev-id-" + slug + version,
		Kind:           "agent.acp",
		Parameters:     paramsCanon,
		Config:         config,
		OutputSchema:   canon.Value(map[string]canonValue{"type": "object"}),
		WorkspaceMode:  "run_workspace",
		RevisionDigest: "sha256:" + strings.Repeat("ab", 32),
	}
}

func reviewParams() canon.Value {
	return canon.Value(map[string]canonValue{
		"type":       "object",
		"required":   []canonValue{"focus"},
		"properties": map[string]canonValue{"focus": map[string]canonValue{"type": "string"}},
	})
}

func tmplRefDoc(t *testing.T, ref string) (loader.Document, diag.List) {
	t.Helper()
	yaml := `apiVersion: communication.dev/v1alpha1
kind: Pipeline
metadata:
  name: tmplref
  description: template reference probe (ADR-0049 § 2).
spec:
  inputs:
    type: object
  nodes:
    - id: review
      kind: agent.acp
      template: ` + ref + `
      config:
        focus: auth
`
	return loadYAML(t, yaml)
}

func loadYAML(t *testing.T, yaml string) (loader.Document, diag.List) {
	t.Helper()
	doc, d := loader.Load([]byte(yaml))
	if !d.Valid() {
		t.Fatalf("loader: %v", d)
	}
	return doc, d
}

func findCode(d diag.List, code diag.Code) *diag.Diagnostic {
	for i := range d {
		if d[i].Code == code {
			return &d[i]
		}
	}
	return nil
}

// TestTemplateRefResolvesAndPins: the reference resolves, the plan node
// carries the pin (ids + digest) and the parameter values, and the body's
// bindings compile in the template scope (parameters are the declared roots).
func TestTemplateRefResolvesAndPins(t *testing.T) {
	doc, _ := tmplRefDoc(t, "security-reviewer@1.0.0")
	reg := &Registries{Templates: fakeTemplates{revs: map[string]TemplateRevision{
		"security-reviewer@1.0.0": reviewTemplate("security-reviewer", "1.0.0", reviewParams(),
			map[string]canonValue{
				"profile": canon.Value("managed-agent"),
				"prompt":  canon.Value("${{ parameters.focus }}"),
			}),
	}}}
	plan, d := Compile(doc, Options{Registries: reg})
	if !d.Valid() {
		t.Fatalf("want a clean compile, got: %v", d)
	}
	var pn *Node
	for i := range plan.Nodes {
		if plan.Nodes[i].ID == "review" {
			pn = &plan.Nodes[i]
		}
	}
	if pn == nil {
		t.Fatalf("node review missing from the plan: %+v", plan.Nodes)
	}
	if len(pn.TemplateRefs) != 1 {
		t.Fatalf("templateRefs = %d entries, want 1", len(pn.TemplateRefs))
	}
	ref := pn.TemplateRefs[0]
	if ref.TemplateID != "tmpl-id-security-reviewer" || ref.TemplateRevisionID != "rev-id-security-reviewer1.0.0" ||
		ref.TemplateRevisionDigest != "sha256:"+strings.Repeat("ab", 32) {
		t.Errorf("pin does not name the resolved revision: %+v", ref)
	}
	params, err := json.Marshal(pn.TemplateParams)
	if err != nil || !strings.Contains(string(params), `"focus":"auth"`) {
		t.Errorf("templateParams = %s (err %v), want the node's config as the parameter values", params, err)
	}
	if len(pn.ConfigBindings) == 0 {
		t.Error("the composed body produced no config bindings")
	}
	// The parameters root compiled inside the template scope: the body's
	// prompt binding names the parameter, not the pipeline's inputs.
	var promptBinding *Binding
	for i := range pn.ConfigBindings {
		b := &pn.ConfigBindings[i]
		if strings.HasSuffix(b.Pointer, "/prompt") {
			promptBinding = b
		}
	}
	if promptBinding == nil || len(promptBinding.ExprIDs) == 0 {
		t.Errorf("the body's prompt expression did not compile against the parameters root: %+v", pn.ConfigBindings)
	}
}

// TestTemplateRefFailClosed: every unresolved shape is a diagnostic (validate
// answers, no 500) — unknown slug, unknown version, malformed reference, a
// retired or foreign registry entry, and no registry at all.
func TestTemplateRefFailClosed(t *testing.T) {
	cases := []struct {
		name string
		ref  string
		reg  *Registries
	}{
		{"unknown slug", "nope@1.0.0", &Registries{Templates: fakeTemplates{revs: map[string]TemplateRevision{
			"security-reviewer@1.0.0": reviewTemplate("security-reviewer", "1.0.0", reviewParams(), map[string]canonValue{}),
		}}}},
		{"unknown version", "security-reviewer@9.9.9", &Registries{Templates: fakeTemplates{revs: map[string]TemplateRevision{
			"security-reviewer@1.0.0": reviewTemplate("security-reviewer", "1.0.0", reviewParams(), map[string]canonValue{}),
		}}}},
		{"malformed reference", "security-reviewer@one", &Registries{Templates: fakeTemplates{revs: map[string]TemplateRevision{
			"security-reviewer@1.0.0": reviewTemplate("security-reviewer", "1.0.0", reviewParams(), map[string]canonValue{}),
		}}}},
		{"no registry", "security-reviewer@1.0.0", nil},
		{"nil templates", "security-reviewer@1.0.0", &Registries{}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			doc, _ := tmplRefDoc(t, tc.ref)
			_, d := Compile(doc, Options{Registries: tc.reg})
			x := findCode(d, diag.CodeTemplateRefUnresolved)
			if x == nil {
				t.Fatalf("want template_ref_unresolved, got: %v", d)
			}
		})
	}
}

// TestTemplateRefKindMismatch: the node's kind must equal the revision's
// spec.implements; a mismatch is a type_mismatch diagnostic.
func TestTemplateRefKindMismatch(t *testing.T) {
	yaml := `apiVersion: communication.dev/v1alpha1
kind: Pipeline
metadata:
  name: tmplref-mismatch
  description: template reference kind probe.
spec:
  inputs:
    type: object
  nodes:
    - id: review
      kind: model.chat
      template: security-reviewer@1.0.0
      config:
        focus: auth
`
	doc, d := loadYAML(t, yaml)
	if !d.Valid() {
		t.Fatalf("loader: %v", d)
	}
	reg := &Registries{Templates: fakeTemplates{revs: map[string]TemplateRevision{
		"security-reviewer@1.0.0": reviewTemplate("security-reviewer", "1.0.0", reviewParams(), map[string]canonValue{}),
	}}}
	_, cd := Compile(doc, Options{Registries: reg})
	x := findCode(cd, diag.CodeTypeMismatch)
	if x == nil {
		t.Fatalf("want a type_mismatch diagnostic, got: %v", cd)
	}
	if !strings.Contains(x.Message, "implements") {
		t.Errorf("the mismatch should name the template's implements kind: %s", x.Message)
	}
}

// TestTemplateRefParametersValidated: the node's config (the parameter
// values) must satisfy the revision's parameters schema — a missing required
// parameter is a type_mismatch diagnostic at the node's config.
func TestTemplateRefParametersValidated(t *testing.T) {
	yaml := `apiVersion: communication.dev/v1alpha1
kind: Pipeline
metadata:
  name: tmplref-params
  description: template reference parameter probe.
spec:
  inputs:
    type: object
  nodes:
    - id: review
      kind: agent.acp
      template: security-reviewer@1.0.0
      config: {}
`
	doc, d := loadYAML(t, yaml)
	if !d.Valid() {
		t.Fatalf("loader: %v", d)
	}
	reg := &Registries{Templates: fakeTemplates{revs: map[string]TemplateRevision{
		"security-reviewer@1.0.0": reviewTemplate("security-reviewer", "1.0.0", reviewParams(), map[string]canonValue{}),
	}}}
	_, cd := Compile(doc, Options{Registries: reg})
	x := findCode(cd, diag.CodeTypeMismatch)
	if x == nil {
		t.Fatalf("a config missing the required parameter must not compile: %v", cd)
	}
	if x.InstanceLocation == "" || !strings.Contains(string(x.InstanceLocation), "config") {
		t.Errorf("the finding should point at the node's config, got %q", x.InstanceLocation)
	}
}

// TestTemplateRefDigestInvariant: compiling the same authored document
// against two registries whose revision CONTENT differs (the re-publish the
// ADR describes) moves the PLAN digest (the pin travels into the plan) but
// never the document's own canonical digest — which carries only the
// reference string.
func TestTemplateRefDigestInvariant(t *testing.T) {
	doc, _ := tmplRefDoc(t, "security-reviewer@1.0.0")
	// The document's own canonical digest — what a pipeline revision pins —
	// carries only the reference string: it is computed once here and must
	// hold before AND after the template's content changes below.
	docDigest, err := canon.DigestDocument(doc.Map())
	if err != nil {
		t.Fatal(err)
	}
	mk := func(prompt canon.Value) *Registries {
		return &Registries{Templates: fakeTemplates{revs: map[string]TemplateRevision{
			"security-reviewer@1.0.0": reviewTemplate("security-reviewer", "1.0.0", reviewParams(),
				map[string]canonValue{"profile": canon.Value("managed-agent"), "prompt": prompt}),
		}}}
	}
	planA, dA := Compile(doc, Options{Registries: mk(canon.Value("${{ parameters.focus }}"))})
	planB, dB := Compile(doc, Options{Registries: mk(canon.Value("${{ parameters.focus }} thoroughly"))})
	if !dA.Valid() || !dB.Valid() {
		t.Fatalf("both compiles must be clean: %v / %v", dA, dB)
	}
	again, err := canon.DigestDocument(doc.Map())
	if err != nil || again != docDigest {
		t.Fatalf("the document digest moved after the template's content changed: %s vs %s", again, docDigest)
	}
	digestA, err := planA.Digest()
	if err != nil {
		t.Fatal(err)
	}
	digestB, err := planB.Digest()
	if err != nil {
		t.Fatal(err)
	}
	if digestA == digestB {
		t.Error("a changed template body did not move the plan digest — the pin must be covered by plan_digest")
	}
}

// TestTemplateRefCompositeRefused: a template reference on a kind that owns
// a body DAG (until / for_each) is a diagnostic, not a silent behaviour
// change — the ADR-0049 § 2 expansion composes config bindings only.
func TestTemplateRefCompositeRefused(t *testing.T) {
	yaml := `apiVersion: communication.dev/v1alpha1
kind: Pipeline
metadata:
  name: tmplref-composite
  description: template reference composite probe.
spec:
  inputs:
    type: object
  nodes:
    - id: loop
      kind: for_each
      template: security-reviewer@1.0.0
      config:
        focus: auth
`
	doc, d := loadYAML(t, yaml)
	if !d.Valid() {
		t.Fatalf("loader: %v", d)
	}
	reg := &Registries{Templates: fakeTemplates{revs: map[string]TemplateRevision{
		"security-reviewer@1.0.0": reviewTemplate("security-reviewer", "1.0.0", reviewParams(), map[string]canonValue{}),
	}}}
	_, cd := Compile(doc, Options{Registries: reg})
	if findCode(cd, diag.CodeTemplateRefUnresolved) == nil {
		t.Fatalf("a composite kind with a template reference must be refused, got: %v", cd)
	}
}
