package canon_test

import (
	"encoding/json"
	"math/rand"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/dbirks/communication/internal/pipelines/canon"
)

// FuzzCanonicalize is contract § 8's property/fuzz row for canonicalization
// (spec 12 "Property/fuzz"): YAML → canonical JSON → digest must be idempotent
// and order-invariant for generated documents. The properties that must hold
// for every input:
//
//   - canonicalize(canonicalize(x)) == canonicalize(x) (bytes, hence digest);
//   - a random key permutation preserves the digest;
//   - the digest is a pure function of the canonical bytes;
//   - no panic, on inputs that are not even valid JSON.
func FuzzCanonicalize(f *testing.F) {
	seeds := []string{
		`{}`,
		`[]`,
		`null`,
		`{"b":1,"a":[1,2,{"c":"x"}]}`,
		`{"metadata":{"ui":{"x":1},"name":"p"},"spec":{"nodes":[]}}`,
		`{"k":"é","ké":"e\u0301"}`,
		`{"n":1e999}`,
		`{"big":9223372036854775807,"f":1.5,"t":true,"nil":null}`,
		`{"s":"line\nbreak\ttab  ","e":""}`,
		`{"dup":1,"dup":2}`,
		`"just a string"`,
		`123`,
		`{"nested":{"deep":{"deeper":[[[[1]]]]}}}`,
	}
	for _, s := range seeds {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, text string) {
		dec := json.NewDecoder(strings.NewReader(text))
		dec.UseNumber()
		var v any
		if err := dec.Decode(&v); err != nil {
			return // not a JSON document: nothing to canonicalize, no panic is the property
		}
		first, err := canon.Canonicalize(v)
		if err != nil {
			return // refused numbers/types are legal outcomes (TestRejectsUnsupportedValues)
		}
		// Idempotence through the bytes themselves. Invalid UTF-8 is passed
		// through canon untouched (encoding/json's Unmarshal would replace it,
		// which is a different promise), so the round trip is checked on the
		// domain canon actually claims: valid UTF-8.
		if !utf8.Valid(first) {
			return
		}
		var again any
		dec2 := json.NewDecoder(strings.NewReader(string(first)))
		dec2.UseNumber() // the default float64 decode re-cuts 9223372036854775807
		if err := dec2.Decode(&again); err != nil {
			t.Fatalf("canonical bytes are not valid JSON: %v (%q)", err, first)
		}
		second, err := canon.Canonicalize(again)
		if err != nil {
			t.Fatalf("re-canonicalizing canonical bytes failed: %v", err)
		}
		if string(first) != string(second) {
			t.Fatalf("canonicalization is not idempotent:\n %s\n %s", first, second)
		}
		if canon.Digest(first) != canon.Digest(second) {
			t.Fatal("digest of canonical bytes moved under re-canonicalization")
		}
		// Key-order invariance: rebuild the tree with keys inserted in a
		// random order (Go maps are already unordered, but normalization and
		// sorting must make the *bytes* identical).
		shuffled := shuffleValue(v, rand.Int63())
		shuf, err := canon.Canonicalize(shuffled)
		if err != nil {
			t.Fatalf("a permutation of the same document failed: %v", err)
		}
		if string(shuf) != string(first) {
			t.Fatalf("key permutation changed the canonical bytes:\n %s\n %s", first, shuf)
		}
	})
}

// shuffleValue rebuilds maps with a permuted insertion order. Go maps carry no
// order, so the permuted construction proves encode()'s sort — not a lucky
// range order — is what fixes the bytes.
func shuffleValue(v any, seed int64) any {
	r := rand.New(rand.NewSource(seed))
	switch t := v.(type) {
	case map[string]any:
		keys := make([]string, 0, len(t))
		for k := range t {
			keys = append(keys, k)
		}
		r.Shuffle(len(keys), func(i, j int) { keys[i], keys[j] = keys[j], keys[i] })
		out := make(map[string]any, len(t))
		for _, k := range keys {
			out[k] = shuffleValue(t[k], r.Int63())
		}
		return out
	case []any:
		out := make([]any, len(t))
		for i, el := range t {
			out[i] = shuffleValue(el, r.Int63())
		}
		return out
	default:
		return v
	}
}
