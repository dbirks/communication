package loader_test

import (
	"strings"
	"testing"

	"github.com/dbirks/communication/internal/pipelines/canon"
	"github.com/dbirks/communication/internal/pipelines/loader"
)

// FuzzLoad is spec 12 "Property/fuzz" for the YAML/JSON door of the system:
// the loader eats author- and attacker-shaped bytes before anything digests
// them. Properties asserted for every input, seeded or generated:
//
//   - no panic and no unbounded work (the size, alias and key budgets must
//     hold even when the shape was never written by a human);
//   - determinism: the same bytes produce the same codes and the same
//     canonical digest, or a stable refusal;
//   - anything the loader accepts produces a value tree canon can encode,
//     and that encoding is the document's stable identity (two loads of one
//     text digest identically — revision_digest depends on it).
//
// JSON is YAML 1.2's subset, so JSON documents arrive here too: the seed
// corpus carries the numeric traps and the multi-document markers.
func FuzzLoad(f *testing.F) {
	seeds := []string{
		"apiVersion: communication.dev/v1alpha1\nkind: Pipeline\nmetadata:\n  name: p\n",
		`{"apiVersion": "communication.dev/v1alpha1", "kind": "Pipeline", "metadata": {"name": "p"}}`,
		"a: {b: {c: [1, 2, {d: null}]}}\nkind: Pipeline\nmetadata:\n  name: p\n",
		"a: &x 1\nb: *x\nkind: Pipeline\n",
		"a: *missing\nkind: Pipeline\n",
		"n: 0123\nkind: Pipeline\n",
		"n: .inf\nkind: Pipeline\n",
		"n: 1e999\nkind: Pipeline\n",
		"when: 2026-10-14\nkind: Pipeline\n",
		"k: yes\nkind: Pipeline\n",
		"d:\n  <<: *missing\nkind: Pipeline\n",
		"a: 1\na: 2\nkind: Pipeline\n",
		"---\na: 1\n---\na: 2\n",
		"\x00\x01\x02",
		"a: \"\\ud800\"\nkind: Pipeline\n",
		"key:worse\tvalue\n",
		strings.Repeat("[", 500) + strings.Repeat("]", 500) + "\nkind: Pipeline\n",
		strings.Repeat("{", 300) + strings.Repeat("}", 300),
	}
	for _, s := range seeds {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, text string) {
		if len(text) > 2*loader.MaxDocumentBytes {
			text = text[:loader.MaxDocumentBytes] // budget test, not a size test
		}
		doc1, d1 := loader.Load([]byte(text))
		doc2, d2 := loader.Load([]byte(text))
		if len(d1) != len(d2) {
			t.Fatalf("loader is not deterministic for %q: %d vs %d diagnostics", text, len(d1), len(d2))
		}
		for i := range d1 {
			if d1[i].Code != d2[i].Code || d1[i].Message != d2[i].Message {
				t.Fatalf("diagnostic %d moved between runs for %q", i, text)
			}
			if d1[i].Code == "" || d1[i].Message == "" {
				t.Fatalf("loader refusal without a code or message for %q", text)
			}
		}
		if !d1.Valid() {
			return
		}
		// Accepted: the tree must canonicalize, deterministically, and the
		// digest of the authored bytes must be a pure function of the text.
		dig1, err := canon.DigestValue(doc1.Value)
		if err != nil {
			t.Fatalf("loader accepted a tree canon refuses (%v) for %q", err, text)
		}
		dig2, err := canon.DigestValue(doc2.Value)
		if err != nil || dig1 != dig2 {
			t.Fatalf("canonical digest is not stable for %q", text)
		}
		if doc1.SourceSHA256() != doc2.SourceSHA256() {
			t.Fatalf("source digest is not stable for %q", text)
		}
	})
}
