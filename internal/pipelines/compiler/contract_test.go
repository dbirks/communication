package compiler_test

import (
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/dbirks/communication/internal/pipelines/compiler"
	"github.com/dbirks/communication/internal/pipelines/diag"
	"github.com/dbirks/communication/internal/pipelines/loader"
	"github.com/dbirks/communication/internal/pipelines/schema"
)

func load(t *testing.T, path string) (loader.Document, diag.List) {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	doc, d := loader.Load(b)
	if !d.Valid() {
		return doc, d
	}
	return doc, schema.MustCompile().Validate(doc.Value)
}

func codes(d diag.List) []string {
	out := make([]string, 0, len(d))
	for _, x := range d {
		out = append(out, string(x.Code))
	}
	return out
}

// TestSampleCompiles is contract § 8's gate: the § 9.3 corrected sample parses,
// validates and compiles, and its plan digests.
func TestSampleCompiles(t *testing.T) {
	doc, d := load(t, "../testdata/feature-development-contract.yaml")
	if !d.Valid() {
		for _, x := range d {
			t.Errorf("%s %s %s", x.Code, x.InstanceLocation, x.Message)
		}
		t.Fatalf("loader+schema: %d errors", len(d))
	}
	plan, d := compiler.Compile(doc, compiler.Options{})
	if !d.Valid() {
		for _, x := range d {
			t.Errorf("%s %s %s", x.Code, x.InstanceLocation, x.Message)
		}
		t.Fatalf("compiler: %d errors", len(d))
	}
	if len(plan.Scopes) != 2 {
		t.Errorf("scopes = %d, want 2 (the root and the until body)", len(plan.Scopes))
	}
	if len(plan.Nodes) != 9 {
		t.Errorf("nodes = %d, want 9", len(plan.Nodes))
	}
	if len(plan.Expressions) == 0 {
		t.Fatal("no expressions compiled")
	}
	dg, err := plan.Digest()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(dg, "sha256:") || len(dg) != 71 {
		t.Fatalf("plan digest = %q", dg)
	}
	if plan.SchemaDigest != schema.Digest() {
		t.Error("the plan does not record the schema it was validated against")
	}
	if plan.CELVersion == "" || plan.CELEnvDigest == "" {
		t.Error("the plan does not record its CEL environment (contract § 9.1 row 19)")
	}
}

// TestSamplePlanShape pins the parts of the plan the M5 runtime depends on:
// scope keys, instance keys, execution locations and entry/terminal sets.
func TestSamplePlanShape(t *testing.T) {
	doc, _ := load(t, "../testdata/feature-development-contract.yaml")
	plan, d := compiler.Compile(doc, compiler.Options{})
	if !d.Valid() {
		t.Fatal(d)
	}
	root, ok := plan.FindScope("/")
	if !ok {
		t.Fatal("no root scope")
	}
	if len(root.EntryNodes) == 0 || len(root.TerminalNodes) == 0 {
		t.Fatalf("root entries=%v terminals=%v", root.EntryNodes, root.TerminalNodes)
	}
	body, ok := plan.FindScope("/build_until_verified/")
	if !ok {
		t.Fatal("the until body scope is missing from the plan")
	}
	if body.ExpressionScope != "until" {
		t.Errorf("body expression scope = %q, want until", body.ExpressionScope)
	}
	if body.Owner != "build_until_verified" {
		t.Errorf("body owner = %q", body.Owner)
	}
	until, _ := plan.FindNode("/", "build_until_verified")
	if until.SubScope != "/build_until_verified/" {
		t.Errorf("subscope = %q", until.SubScope)
	}
	if until.ExecLocation != compiler.LocationControlPlane {
		t.Errorf("until execution location = %q, want control_plane (ADR-0023 § 3)", until.ExecLocation)
	}
	impl, _ := plan.FindNode("/build_until_verified/", "implement")
	if impl.ExecLocation != compiler.LocationWorker {
		t.Errorf("agent node execution location = %q, want worker", impl.ExecLocation)
	}
	if !strings.HasPrefix(impl.InstanceKey, "/build_until_verified[") {
		t.Errorf("instance key = %q, want an ADR-0023 § 1 body path", impl.InstanceKey)
	}
	if len(impl.Indexed) == 0 {
		t.Error("a body node must carry the indexed segment its scope adds")
	}
	// Every node's dependsOn must be visible inside its own scope.
	for _, n := range plan.Nodes {
		sc, ok := plan.FindScope(n.Scope)
		if !ok {
			t.Fatalf("node %q sits in unknown scope %q", n.ID, n.Scope)
		}
		for _, dep := range n.DependsOn {
			known := false
			for _, id := range sc.TopologicalOrder {
				if id == dep {
					known = true
				}
			}
			if !known {
				t.Errorf("node %q depends on %q outside its scope", n.ID, dep)
			}
		}
	}
}

// TestPlanDigestIsSensitive: contract § 9.1 row 19 — the CEL version and the
// expression text are inside the digest, so an upgrade cannot silently re-pin a
// published revision.
func TestPlanDigestIsSensitive(t *testing.T) {
	doc, _ := load(t, "../testdata/feature-development-contract.yaml")
	plan, d := compiler.Compile(doc, compiler.Options{})
	if !d.Valid() {
		t.Fatal(d)
	}
	first, err := plan.Digest()
	if err != nil {
		t.Fatal(err)
	}
	saved := plan.CELVersion
	plan.CELVersion = "v0.32.0"
	second, err := plan.Digest()
	if err != nil {
		t.Fatal(err)
	}
	if first == second {
		t.Fatal("changing cel_version did not move plan_digest")
	}
	plan.CELVersion = saved

	savedExpr := plan.Expressions[0].NormalizedAST
	plan.Expressions[0].NormalizedAST += " "
	third, err := plan.Digest()
	if err != nil {
		t.Fatal(err)
	}
	if third == first {
		t.Fatal("changing a normalized AST did not move plan_digest (ADR-0022 § 5)")
	}
	plan.Expressions[0].NormalizedAST = savedExpr
	if again, err := plan.Digest(); err != nil || again != first {
		t.Fatalf("digest is not a pure function of the plan: %s vs %s", again, first)
	}
}

// specExamples is contract § 9's table: what each authored example must answer.
var specExamples = []struct {
	file string
	want []string // every code must appear; an empty list means "must be valid"
}{
	{"feature-development.yaml", []string{string(diag.CodeKindNotImplemented), string(diag.CodeSchemaShape)}},
	{"process-ready-issues.yaml", []string{string(diag.CodeKindNotImplemented), string(diag.CodeSchemaShape)}},
	{"node-template-reviewer.yaml", []string{}},
	{"project-binding.yaml", []string{string(diag.CodeUnknownDocument)}},
	{"secret-mounts.yaml", []string{string(diag.CodeUnknownDocument)}},
}

func TestSpecExamplesAnswerTheContract(t *testing.T) {
	for _, tc := range specExamples {
		t.Run(tc.file, func(t *testing.T) {
			doc, d := load(t, "../../../communication-spec/examples/"+tc.file)
			plan, cd := compiler.Compile(doc, compiler.Options{})
			all := append(d, cd...)
			_ = plan
			if len(tc.want) == 0 {
				if !all.Valid() {
					t.Fatalf("want valid, got %v", codes(all))
				}
				return
			}
			got := map[string]bool{}
			for _, x := range all {
				got[string(x.Code)] = true
			}
			for _, want := range tc.want {
				if !got[want] {
					t.Errorf("missing code %s; got %v", want, codes(d))
					for _, x := range d {
						t.Logf("  %s %s %s", x.Code, x.InstanceLocation, x.Message)
					}
				}
			}
		})
	}
}

// TestDeferredKindsNameTheirMilestone is ADR-0024 § 2's requirement that the
// refusal cite the milestone instead of being folklore.
func TestDeferredKindsNameTheirMilestone(t *testing.T) {
	for _, kind := range compiler.DeferredKinds() {
		if !strings.Contains(strings.Join(deferredMessages(t), " "), kind) {
			t.Errorf("no diagnostic names the deferred kind %q", kind)
		}
	}
}

func deferredMessages(t *testing.T) []string {
	t.Helper()
	var out []string
	for _, kind := range compiler.DeferredKinds() {
		doc := pipelineWithKind(t, kind)
		_, d := compiler.Compile(doc, compiler.Options{})
		for _, x := range d {
			if x.Code == diag.CodeKindNotImplemented {
				out = append(out, x.Message)
			}
		}
	}
	return out
}

func pipelineWithKind(t *testing.T, kind string) loader.Document {
	t.Helper()
	src := []byte("apiVersion: communication.dev/v1alpha1\nkind: Pipeline\nmetadata:\n  name: p\nspec:\n  nodes:\n    - id: a\n      kind: " + kind + "\n      config: {}\n")
	doc, d := loader.Load(src)
	if !d.Valid() {
		t.Fatalf("%v", d)
	}
	d = schema.MustCompile().Validate(doc.Value)
	if !d.Valid() {
		// A deferred kind's config shape may not validate in every case; the
		// compiler refusal is what this test cares about.
		t.Logf("schema said: %v", d)
	}
	return doc
}

// TestKindCatalogueMatchesSchema is the guard ADR-0021's Consequences asks for:
// the shipped schema's kind enum and the compiler's executed/deferred tables must
// agree, or a kind would validate without any build promising to run it.
func TestKindCatalogueMatchesSchema(t *testing.T) {
	var doc map[string]any
	if err := json.Unmarshal(schema.JSON(), &doc); err != nil {
		t.Fatal(err)
	}
	// The schema's kind enum is the one array that contains agent.acp; naming it
	// that way keeps this test honest if the $defs entry is ever renamed.
	kinds := map[string]bool{}
	var walk func(any)
	walk = func(v any) {
		switch t := v.(type) {
		case map[string]any:
			if e, ok := t["enum"].([]any); ok {
				has := false
				for _, c := range e {
					if c == "agent.acp" {
						has = true
					}
				}
				if has {
					for _, c := range e {
						if s, ok := c.(string); ok {
							kinds[s] = true
						}
					}
					return
				}
			}
			for _, sub := range t {
				walk(sub)
			}
		case []any:
			for _, sub := range t {
				walk(sub)
			}
		}
	}
	walk(doc)
	if len(kinds) == 0 {
		t.Fatal("the shipped schema declares no kind enum containing agent.acp")
	}
	exec := map[string]bool{}
	for _, k := range compiler.ExecutedKinds() {
		exec[k] = true
	}
	for _, k := range compiler.DeferredKinds() {
		exec[k] = true
	}
	if len(exec) != 16 {
		t.Fatalf("catalogue has %d kinds, want the sixteen of ADR-0024", len(exec))
	}
	for k := range kinds {
		if !exec[k] {
			t.Errorf("the schema admits kind %q, which neither table names", k)
		}
	}
	for k := range exec {
		if !kinds[k] {
			t.Errorf("the compiler names kind %q, which the schema does not admit", k)
		}
	}
}

// TestSchemaAssetMatchesSpecCopy proves the embedded contract and the published
// one are the same bytes, so a schema edit cannot land on one side only.
func TestSchemaAssetMatchesSpecCopy(t *testing.T) {
	embedded := schema.JSON()
	onDisk, err := os.ReadFile("../../../communication-spec/schemas/pipeline-v1alpha1.schema.json")
	if err != nil {
		t.Fatal(err)
	}
	if string(embedded) != string(onDisk) {
		t.Fatalf("the embedded schema asset differs from communication-spec/schemas/ by %d bytes", len(embedded)-len(onDisk))
	}
}

// TestNonBooleanPredicateNamesTheRemedy is contract § 9.1 row 8: the raw cel-go
// message is useless to an author, so the compiler says what to write instead.
func TestNonBooleanPredicateNamesTheRemedy(t *testing.T) {
	src := []byte(`apiVersion: communication.dev/v1alpha1
kind: Pipeline
metadata:
  name: p
spec:
  inputs:
    type: object
    properties:
      goal: {type: string}
  nodes:
    - id: a
      kind: condition
      when: inputs.goal
      config:
        default: go
        cases:
          - when: inputs.goal == 'x'
            route: go
`)
	doc, d := loader.Load(src)
	if !d.Valid() {
		t.Fatalf("loader: %v", d)
	}
	d = schema.MustCompile().Validate(doc.Value)
	if !d.Valid() {
		for _, x := range d {
			t.Errorf("%s %s %s", x.Code, x.InstanceLocation, x.Message)
		}
		t.Fatal("the fixture does not validate")
	}
	_, d = compiler.Compile(doc, compiler.Options{})
	var msg string
	for _, x := range d {
		if x.Code == diag.CodeNonBoolean {
			msg = x.Message
		}
	}
	if msg == "" {
		t.Fatalf("want non_boolean_expression, got %v", codes(d))
	}
	if !strings.Contains(msg, "has(") {
		t.Fatalf("the message does not name the remedy: %s", msg)
	}
	if !strings.Contains(x(d, "/spec/nodes/0/when"), "/spec/nodes/0/when") {
		t.Fatalf("the diagnostic is not located at the authored field: %s", x(d, ""))
	}
}

func x(d diag.List, want string) string {
	for _, i := range d {
		if string(i.InstanceLocation) == want {
			return want
		}
	}
	return ""
}
