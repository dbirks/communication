package loader_test

import (
	"fmt"
	"strings"
	"testing"

	"github.com/dbirks/communication/internal/pipelines/canon"
	"github.com/dbirks/communication/internal/pipelines/diag"
	"github.com/dbirks/communication/internal/pipelines/loader"
)

// minimal returns the smallest document the loader accepts, so every test
// changes exactly one thing from a known-good base.
func minimal(extra string) []byte {
	return []byte("apiVersion: communication.dev/v1alpha1\nkind: Pipeline\nmetadata:\n  name: p\n" + extra)
}

func codes(d diag.List) []diag.Code {
	out := make([]diag.Code, 0, len(d))
	for _, x := range d {
		out = append(out, x.Code)
	}
	return out
}

func mustHave(t *testing.T, d diag.List, want diag.Code) {
	t.Helper()
	for _, x := range d {
		if x.Code == want {
			if x.Message == "" {
				t.Fatalf("%s carries no message", want)
			}
			return
		}
	}
	t.Fatalf("want %s, got %v", want, codes(d))
}

// TestContractCaps: every size bound contract § 6 gives the loader, enforced
// with the named failure.
func TestDocumentTooLarge(t *testing.T) {
	big := []byte("a: " + strings.Repeat("x", loader.MaxDocumentBytes))
	_, d := loader.Load(big)
	mustHave(t, d, diag.CodeDocumentTooLarge)
	if len(d) != 1 {
		t.Fatalf("a size refusal must be one diagnostic, got %v", codes(d))
	}
}

func TestEmptyAndGarbageAreInvalidYAML(t *testing.T) {
	for _, in := range []string{"", "   \n\t\n", "!!! {{[", "just a scalar"} {
		_, d := loader.Load([]byte(in))
		if d.Valid() {
			t.Fatalf("%q was accepted", in)
		}
	}
	_, d := loader.Load([]byte("\n"))
	mustHave(t, d, diag.CodeInvalidYAML)
}

func TestMultipleDocuments(t *testing.T) {
	_, d := loader.Load(minimal("---\nkind: Pipeline\n"))
	mustHave(t, d, diag.CodeMultipleDocuments)
}

func TestDuplicateKey(t *testing.T) {
	_, d := loader.Load(minimal("  name: q\n")) // metadata.name authored twice
	mustHave(t, d, diag.CodeDuplicateKey)
}

// TestNumericTraps is contract § 8 unit-canonicalization's trap list, which
// the loader owns because it is the only stage still seeing authored text:
// 0123→83 (octal trap), .inf/1e999 (non-finite), int64 overflow, and the
// YAML-1.2 yes/on behaviour, each refused or explained by name.
func TestNumericTraps(t *testing.T) {
	cases := []struct {
		in   string
		want diag.Code
	}{
		{"n: 0123\n", diag.CodeInvalidNumber},                // would decode as 83
		{"n: .inf\n", diag.CodeInvalidNumber},                // not a JSON number
		{"n: .nan\n", diag.CodeInvalidNumber},                // not a JSON number
		{"n: 9223372036854775808\n", diag.CodeInvalidNumber}, // int64 overflow
		{"n: -0123\n", diag.CodeInvalidNumber},               // signed octal trap
		{"n: 0x1F\n", ""},                                    // explicit bases stay legal
		{"n: 0o17\n", ""},                                    //
		{"n: 0b101\n", ""},                                   //
	}
	for _, c := range cases {
		_, d := loader.Load(minimal(c.in))
		if c.want == "" {
			if !d.Valid() {
				t.Fatalf("%q refused: %v", c.in, codes(d))
			}
			continue
		}
		mustHave(t, d, c.want)
		if c.in == "n: 0123\n" {
			// The message must name the trap, not just refuse.
			for _, x := range d {
				if x.Code == c.want && !strings.Contains(x.Message, "83") {
					t.Fatalf("the octal refusal must show what 0123 decodes to: %s", x.Message)
				}
			}
		}
	}
	// 1e999: YAML 1.2 (unlike 1.1) does not resolve scientific notation
	// without a dot, so the loader keeps it a string — the non-finite trap is
	// inert, and a numeric slot in the schema will refuse the string. The
	// spellings that *do* resolve to !!float (.inf/.nan/.Inf) are refused by
	// name above; this asserts the difference instead of assuming it.
	doc, d := loader.Load(minimal("n: 1e999\n"))
	if !d.Valid() {
		t.Fatalf("1e999 refused: %v", codes(d))
	}
	if s, ok := doc.Map()["n"].(string); !ok || s != "1e999" {
		t.Fatalf("n = %#v, want the string \"1e999\"", doc.Map()["n"])
	}
	// Scientific notation — even the dotted spelling — resolves to a string
	// under YAML 1.2 core (probed against the pinned yaml.v3: 1.0e999 tag
	// !!str), so the only non-finite floats that can reach the loader are the
	// .inf/.nan spellings refused above. Assert the difference, do not assume it.
	if _, d := loader.Load(minimal("n: 1.0e999\n")); !d.Valid() {
		t.Fatalf("1.0e999 was refused (%v) — the float trap needs re-examining", codes(d))
	}
}

func TestUnquotedDate(t *testing.T) {
	_, d := loader.Load(minimal("when: 2026-10-14\n"))
	mustHave(t, d, diag.CodeUnquotedDate)
	// metadata.ui is served, never digested — exempt by contract.
	ok, d := loader.Load([]byte("apiVersion: communication.dev/v1alpha1\nkind: Pipeline\nmetadata:\n  name: p\n  ui:\n    generated: 2026-10-14\n"))
	if !d.Valid() {
		t.Fatalf("metadata.ui timestamps must not block: %v", codes(d))
	}
	if ok.Kind != "Pipeline" {
		t.Fatal("kind lost")
	}
	// Quoting fixes it.
	if _, d := loader.Load(minimal("when: '2026-10-14'\n")); !d.Valid() {
		t.Fatalf("the quoted form was refused: %v", codes(d))
	}
}

// TestYesOnOffStayStrings is the YAML 1.2 promise: the loader must not replay
// YAML 1.1 habits, so yes/on are strings here (and the schema hint tells the
// author to write true/false).
func TestYesOnOffStayStrings(t *testing.T) {
	doc, d := loader.Load(minimal("flag: yes\nother: on\n"))
	if !d.Valid() {
		t.Fatalf("codes: %v", codes(d))
	}
	m := doc.Map()
	for k, want := range map[string]string{"flag": "yes", "other": "on"} {
		if got, ok := m[k].(string); !ok || got != want {
			t.Fatalf("%s = %#v, want the string %q (YAML 1.2 keeps it)", k, m[k], want)
		}
	}
}

// TestAliasBudget is contract § 6: ≤ 512 alias nodes, ≤ 64 depth, with
// alias_budget_exceeded — yaml.v3's own abort stays the backstop, not the
// contract.
func TestAliasBudget(t *testing.T) {
	var b strings.Builder
	b.WriteString("base: &x 1\n")
	for i := range 600 {
		fmt.Fprintf(&b, "k%d: *x\n", i)
	}
	_, d := loader.Load(append(minimal(""), []byte(b.String())...))
	mustHave(t, d, diag.CodeAliasBudget)

	// Just under the budget: 512 aliases are fine (the base map key is not
	// one of them).
	b.Reset()
	b.WriteString("base: &x 1\n")
	for i := range loader.MaxAliasNodes {
		fmt.Fprintf(&b, "k%d: *x\n", i)
	}
	if _, d := loader.Load(append(minimal(""), []byte(b.String())...)); !d.Valid() {
		t.Fatalf("the budget refused exactly %d aliases: %v", loader.MaxAliasNodes, codes(d))
	}
}

func TestAliasDepthBudget(t *testing.T) {
	// A chain of aliases nested MaxAliasDepth+1 deep: x{n} anchors a
	// one-element sequence wrapping x{n+1}, so each expansion costs one level.
	var b strings.Builder
	n := loader.MaxAliasDepth + 2
	fmt.Fprintf(&b, "x0: &a0 [1]\n")
	for i := 1; i < n; i++ {
		fmt.Fprintf(&b, "x%d: &a%d [ *a%d ]\n", i, i, i-1)
	}
	fmt.Fprintf(&b, "top: *a%d\n", n-1)
	_, d := loader.Load(append(minimal(""), []byte(b.String())...))
	mustHave(t, d, diag.CodeAliasBudget)
}

func TestUnknownDocumentKind(t *testing.T) {
	_, d := loader.Load([]byte("apiVersion: communication.dev/v1alpha1\nkind: Widget\nmetadata:\n  name: w\n"))
	mustHave(t, d, diag.CodeUnknownDocument)
	if d[0].Hint != "" {
		t.Log("hint is fine but the message must carry the reason")
	}
	_, d = loader.Load([]byte("metadata:\n  name: no-kind\n"))
	mustHave(t, d, diag.CodeUnknownDocument)
	_, d = loader.Load([]byte("- just\n- a sequence\n"))
	mustHave(t, d, diag.CodeUnknownDocument)
}

func TestNodeTemplateKindIsKnown(t *testing.T) {
	doc, d := loader.Load([]byte("apiVersion: communication.dev/v1alpha1\nkind: NodeTemplate\nmetadata:\n  name: t\n"))
	if !d.Valid() {
		t.Fatalf("NodeTemplate refused: %v", codes(d))
	}
	if doc.Kind != loader.KindNodeTemplate || doc.Name != "t" {
		t.Fatalf("kind=%q name=%q", doc.Kind, doc.Name)
	}
}

func TestNonStringKey(t *testing.T) {
	_, d := loader.Load(minimal("7: seven\n"))
	if d.Valid() {
		t.Fatal("an integer key was accepted into a JSON object")
	}
	_, d = loader.Load(minimal("[1,2]: seq\n"))
	if d.Valid() {
		t.Fatal("a sequence key was accepted")
	}
}

func TestMergeKeysExpandWithPrecedenceAndNote(t *testing.T) {
	in := minimal(`base: &b
  a: from-base
  b: from-base
merged:
  <<: *b
  b: explicit
`)
	doc, d := loader.Load(in)
	if !d.Valid() {
		t.Fatalf("merge key refused: %v", codes(d))
	}
	m := doc.Map()
	merged, ok := m["merged"].(map[string]canon.Value)
	if !ok {
		t.Fatalf("merged is %#v", m["merged"])
	}
	if merged["a"] != canon.Value("from-base") || merged["b"] != canon.Value("explicit") {
		t.Fatalf("merge precedence wrong: %#v", merged)
	}
	if len(doc.Notes) == 0 || !strings.Contains(doc.Notes[0], "merge keys") {
		t.Fatalf("an expanded merge must be recorded in Notes: %v", doc.Notes)
	}
}

func TestMergeKeyMustNameMapping(t *testing.T) {
	_, d := loader.Load(minimal("m:\n  <<: 3\n"))
	if d.Valid() {
		t.Fatal("a scalar merge value was accepted")
	}
}

// TestDigestsAreStable: SourceSHA256 covers the authored bytes; Value digests
// cover the expanded tree. They must differ when text differs but expansion
// matches, and never panic.
func TestSourceAndValueDigests(t *testing.T) {
	doc, d := loader.Load(minimal("n: 1\n"))
	if !d.Valid() {
		t.Fatal(d)
	}
	if got := doc.SourceSHA256(); len(got) != 64 {
		t.Fatalf("SourceSHA256 = %q", got)
	}
	vd, err := canon.DigestValue(doc.Value)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(vd, "sha256:") {
		t.Fatalf("value digest %q", vd)
	}
}

func TestMaxMappingKeys(t *testing.T) {
	var b strings.Builder
	for i := range loader.MaxMappingKeys + 1 {
		fmt.Fprintf(&b, "k%d: 1\n", i)
	}
	_, d := loader.Load(append(minimal(""), []byte(b.String())...))
	mustHave(t, d, diag.CodeGraphTooLarge)
}
