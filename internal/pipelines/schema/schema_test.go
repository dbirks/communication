package schema_test

import (
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/dbirks/communication/internal/pipelines/diag"
	"github.com/dbirks/communication/internal/pipelines/loader"
	"github.com/dbirks/communication/internal/pipelines/ptr"
	"github.com/dbirks/communication/internal/pipelines/schema"
)

func sample(t *testing.T) loader.Document {
	t.Helper()
	b, err := os.ReadFile("../testdata/feature-development-contract.yaml")
	if err != nil {
		t.Fatal(err)
	}
	doc, d := loader.Load(b)
	if !d.Valid() {
		t.Fatalf("the corrected sample no longer loads: %v", d)
	}
	return doc
}

func TestAssetAndDigest(t *testing.T) {
	j := schema.JSON()
	if len(j) < 1000 {
		t.Fatalf("the embedded schema asset is %d bytes — that is not the catalogue", len(j))
	}
	var probe map[string]any
	if err := json.Unmarshal(j, &probe); err != nil {
		t.Fatalf("the embedded asset is not valid JSON: %v", err)
	}
	if probe["$id"] != schema.ID {
		t.Fatalf("$id = %v, want %s", probe["$id"], schema.ID)
	}
	if d := schema.Digest(); !strings.HasPrefix(d, "sha256:") || len(d) != 7+64 {
		t.Fatalf("Digest = %q", d)
	}
}

// TestCanonicalCopyIsTheAsset is the drift guard the package doc promises:
// communication-spec/schemas/pipeline-v1alpha1.schema.json and the embedded
// asset are the same bytes.
func TestCanonicalCopyIsTheAsset(t *testing.T) {
	onDisk, err := os.ReadFile("../../../communication-spec/schemas/pipeline-v1alpha1.schema.json")
	if err != nil {
		t.Fatal(err)
	}
	if string(onDisk) != string(schema.JSON()) {
		t.Fatal("the spec-side schema copy differs from the embedded asset")
	}
}

func TestMustCompileIsThePinnedSchema(t *testing.T) {
	v := schema.MustCompile()
	if v == nil {
		t.Fatal("nil validator")
	}
	// A second compile must succeed identically — the asset is static,
	// and the store records schema_digest per revision (contract § 1).
	if _, err := schema.New(); err != nil {
		t.Fatalf("New: %v", err)
	}
}

func TestCorrectedSampleValidates(t *testing.T) {
	doc := sample(t)
	if d := schema.MustCompile().Validate(doc.Value); !d.Valid() {
		for _, x := range d {
			t.Errorf("%s %s %s", x.Code, x.InstanceLocation, x.Message)
		}
		t.Fatal("the § 9.3 corrected sample must validate")
	}
}

// mutate runs a corrected copy of the sample tree through a change and
// returns the schema diagnostics.
func mutate(t *testing.T, change func(map[string]any)) diag.List {
	t.Helper()
	doc := sample(t)
	raw, err := json.Marshal(doc.Value)
	if err != nil {
		t.Fatal(err)
	}
	var tree map[string]any
	if err := json.Unmarshal(raw, &tree); err != nil {
		t.Fatal(err)
	}
	change(tree)
	return schema.MustCompile().Validate(tree)
}

func spec(tree map[string]any) map[string]any {
	s, _ := tree["spec"].(map[string]any)
	return s
}

func TestUnknownKeyRefused(t *testing.T) {
	d := mutate(t, func(tree map[string]any) {
		spec(tree)["nodez"] = []any{} // the classic typo
	})
	if d.Valid() {
		t.Fatal("an unknown top-level spec key validated")
	}
	found := false
	for _, x := range d {
		if x.Source != diag.SourceSchema || x.Code != diag.CodeSchemaShape {
			t.Fatalf("diagnostic = %+v", x)
		}
		if strings.Contains(x.Message, "\n") {
			t.Fatalf("a schema diagnostic must be one line: %q", x.Message)
		}
		if x.Message == "" || x.SchemaLocation == "" {
			t.Fatalf("schema diagnostic without a message or schema location: %+v", x)
		}
		if strings.Contains(x.Message, "additional properties") {
			found = true
			if !strings.Contains(string(x.InstanceLocation), "/spec") {
				t.Fatalf("location = %s, want it to point into /spec", x.InstanceLocation)
			}
			// The additionalProperties hint is the editor's link target.
			if x.Hint == "" {
				t.Error("an additional-properties refusal must carry a hint")
			}
		}
	}
	if !found {
		t.Fatalf("no additional-properties finding for the typo key: %v", d)
	}
}

func TestBadNodeIDPattern(t *testing.T) {
	d := mutate(t, func(tree map[string]any) {
		nodes := spec(tree)["nodes"].([]any)
		nodes[0].(map[string]any)["id"] = "My-Step" // uppercase and a dash: pattern-refused
	})
	if d.Valid() {
		t.Fatal("an id outside ^[a-z][a-z0-9_]{0,62}$ validated")
	}
	hit := false
	for _, x := range d {
		if x.InstanceLocation == "/spec/nodes/0/id" && strings.Contains(x.SchemaLocation, "pattern") {
			hit = true
		}
	}
	if !hit {
		t.Fatalf("no finding points at /spec/nodes/0/id for the pattern: %v", d)
	}
}

func TestMissingRequiredMember(t *testing.T) {
	d := mutate(t, func(tree map[string]any) {
		delete(spec(tree), "nodes")
	})
	if d.Valid() {
		t.Fatal("a pipeline without nodes validated")
	}
}

func TestKindConstDistinguishesBranches(t *testing.T) {
	doc, dd := loader.Load([]byte("apiVersion: communication.dev/v1alpha1\nkind: Pipeline\nmetadata:\n  name: p\n"))
	if !dd.Valid() {
		t.Fatal(dd)
	}
	d := schema.MustCompile().Validate(doc.Value)
	if d.Valid() {
		t.Fatal("a Pipeline with no spec validated")
	}
	// The refusal must not accidentally read as "kind unknown": the oneof
	// branch matched (kind: Pipeline is const), the miss is inside it.
	if schema.DocumentKind(doc.Value) != "Pipeline" {
		t.Fatal("DocumentKind lost the envelope")
	}
}

func TestDocumentKindAndPointerOf(t *testing.T) {
	if got := schema.DocumentKind(map[string]any{"kind": "NodeTemplate"}); got != "NodeTemplate" {
		t.Fatalf("DocumentKind = %q", got)
	}
	if got := schema.DocumentKind("not a map"); got != "" {
		t.Fatalf("DocumentKind(non-map) = %q", got)
	}
	if got := schema.PointerOf("spec", "nodes", "0").String(); got != "/spec/nodes/0" {
		t.Fatalf("PointerOf = %q", got)
	}
	if got := schema.PointerOf("a/b", "c~d").String(); got != "/a~1b/c~0d" {
		t.Fatalf("PointerOf must RFC 6901-escape: %q", got)
	}
}

// TestPositionTable pins the binding position of representative slots of the
// corrected sample: the schema's $defs are the single source of truth (ADR-0022 § 1,
// contract § 9.2), and these are the doors the compiler dispatches on. The
// documented fallback is fail-open to bindingValue — literalness is asserted
// only where a $defs name says so positively (classify's comment in
// positions.go); `id` is an `identifier` $ref, so its position is the
// fallback and the *schema* pattern is what refuses a binding there. This
// table is the drift guard contract § 9.2 asks for, pinned to the shipped
// classifier rather than to a wish.
func TestPositionTable(t *testing.T) {
	doc := sample(t)
	cases := []struct {
		at   ptr.Pointer
		want string
	}{
		{"/spec/nodes/0/config/prompt", schema.PositionText},
		{"/spec/nodes/1/config/summary", schema.PositionText},
		{"/spec/nodes/2/config/passWhen", schema.PositionExpression},
		{"/spec/nodes/2/config/body", schema.PositionScope},
		{"/spec/inputs", schema.PositionSchema},
		{"/spec/nodes/2/config/body/nodes/0/config/prompt", schema.PositionText},
		// The $defs-name-less slots fall back to the value position by design.
		{"/spec/nodes/0/id", schema.PositionValue},
		{"/spec/nodes/2/config/maxIterations", schema.PositionValue},
		{"/spec/policies/maxDurationSeconds", schema.PositionValue},
		// A pointer that walks off the document is the only true unknown.
		{"/spec/nodes/0/nope/deeper", schema.PositionUnknown},
	}
	for _, c := range cases {
		if got := schema.Position(doc.Value, c.at); got != c.want {
			t.Errorf("Position(%s) = %s, want %s", c.at, got, c.want)
		}
	}
	if _, def := schema.PositionAndDef(doc.Value, "/spec/nodes/0/config/prompt"); def == "" {
		t.Error("PositionAndDef must name the $defs slot the walk resolved")
	}
}

// FuzzJSONValidate is the schema door of spec 12 "Property/fuzz": the API
// feeds arbitrary JSON-shaped values in, so the validator must terminate,
// never panic, and answer with well-formed diagnostics only.
func FuzzJSONValidate(f *testing.F) {
	seeds := []string{
		`{}`,
		`[]`,
		`"x"`,
		`1e999`,
		`{"apiVersion":"communication.dev/v1alpha1","kind":"Pipeline","metadata":{"name":"p"},"spec":{"nodes":[{"id":"a","kind":"condition","when":"inputs.x","config":{"cases":[{"when":"inputs.x","route":"go"}]}}]}}`,
		`{"kind":"NodeTemplate","apiVersion":"communication.dev/v1alpha1","metadata":{"name":"t"},"spec":{"inputs":{"type":"object"},"kind":"process.exec","config":{"executable":"ls"}}}`,
		`{"kind":"Pipeline","apiVersion":"communication.dev/v1alpha1","metadata":{"name":"p"},"spec":{"nodes":[{"id":"a","kind":"until","config":{"maxIterations":1,"passWhen":"true","body":{"nodes":[{"id":"b","kind":"until"}]}}}]}}`,
		`{"a":{"b":{"c":{"d":[1,2,{"e":[true,null]}]}}}}`,
		`{"metadata":{"name":"p","ui":{"deep":{"x":1}}}}`,
	}
	for _, s := range seeds {
		f.Add(s)
	}
	v := schema.MustCompile()
	f.Fuzz(func(t *testing.T, text string) {
		if len(text) > loader.MaxDocumentBytes {
			return // the loader owns that bound; this door tests the validator
		}
		var value any
		if err := json.Unmarshal([]byte(text), &value); err != nil {
			return // not JSON: nothing reaches the validator in the real flow
		}
		d := v.Validate(value)
		for _, x := range d {
			if x.Source != diag.SourceSchema || x.Code != diag.CodeSchemaShape {
				t.Fatalf("validator emitted %+v: only schema/schema_shape may come from this door", x)
			}
			if x.Message == "" || strings.Contains(x.Message, "\n") {
				t.Fatalf("schema diagnostic not one actionable line: %+v", x)
			}
		}
	})
}
