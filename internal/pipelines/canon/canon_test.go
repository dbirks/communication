package canon

import (
	"encoding/json"
	"math"
	"strings"
	"testing"

	"golang.org/x/text/unicode/norm"
)

// spikeCanonical rows come from docs/compatibility/m4-spike/results-canon.txt,
// where the spike's standalone canonicalizer printed the canonical bytes and the
// first 16 hex characters of the digest for every loader hazard. They are the
// M4 spike's evidence rather than numbers this package could round: a golden
// table the implementation authors proves nothing.
//
// digestPrefix is the digest over exactly the bytes in `bytes`.
var spikeCanonical = []struct {
	name     string
	bytes    string
	digest16 string
	value    func() Value // nil = the bytes are the assertion only
}{
	{"key-order", `{"a":1,"b":2,"c":{"x":1,"y":2}}`, "c0f5a125be13845a",
		func() Value { return Map{"c": Map{"y": int64(2), "x": int64(1)}, "a": int64(1), "b": int64(2)} }},
	{"comments-and-style", `{"a":1,"b":"2","c":{"x":1,"y":2}}`, "9d5dcc41885e8420",
		func() Value { return Map{"a": int64(1), "b": "2", "c": Map{"x": int64(1), "y": int64(2)}} }},
	{"alias", `{"a":{"p":1},"b":{"p":1}}`, "aab956d3aa4c03d8",
		func() Value { return Map{"a": Map{"p": int64(1)}, "b": Map{"p": int64(1)}} }},
	{"merge-key", `{"base":{"p":1,"q":2},"use":{"p":1,"q":3}}`, "a53ce092f0232a66",
		func() Value {
			return Map{"base": Map{"p": int64(1), "q": int64(2)}, "use": Map{"p": int64(1), "q": int64(3)}}
		}},
	{"yaml11-bools", `{"no":2,"off":4,"on":3,"true_":true,"yes":1}`, "0bde0a051ec0d37b",
		func() Value {
			return Map{"yes": int64(1), "on": int64(3), "no": int64(2), "off": int64(4), "true_": true}
		}},
	{"date-scalar", `{"when":"2026-10-14T00:00:00Z"}`, "b24c03b6e6240c33", nil},
	{"sexagesimal", `{"ratio":"1:30"}`, "9844de97e61f84ef",
		func() Value { return Map{"ratio": "1:30"} }},
	{"leading-zero-int", `{"n":83}`, "b61e2f4dc856678c", func() Value { return Map{"n": int64(83)} }},
	{"underscore-number", `{"n":1000}`, "fe1c788f83a7b21b", func() Value { return Map{"n": int64(1000)} }},
	{"big-int", `{"n":1.2345678901234568e+29}`, "cf06dd17e5dab029",
		func() Value { return Map{"n": 1.2345678901234568e+29} }},
	{"float-forms", `{"a":1,"b":1000,"c":0.5,"d":1}`, "d5c1ce544f736fe9",
		func() Value { return Map{"a": 1.0, "b": 1e3, "c": 0.5, "d": 1.0} }},
	{"null-forms", `{"a":null,"b":null,"c":null,"d":null,"e":null}`, "3ace9bc888ef4ce1",
		func() Value {
			return Map{"a": nil, "b": nil, "c": nil, "d": nil, "e": nil}
		}},
	{"multi-document", `{"a":1}`, "015abd7f5cc57a2d", func() Value { return Map{"a": int64(1)} }},
	{"duplicate-anchor", `{"a":1,"b":2,"c":2}`, "efc55b7cd6ef9b27",
		func() Value { return Map{"a": int64(1), "b": int64(2), "c": int64(2)} }},
	{"unicode-compose", `{"name":"café"}`, "645fa443126a8954",
		func() Value { return Map{"name": norm.NFC.String("café")} }},
	{"unicode-decompose-nfcd", `{"name":"café"}`, "645fa443126a8954",
		func() Value { return Map{"name": norm.NFD.String("café")} }},
	{"empty-vs-missing", `{"a":{}}`, "5d8171b9fc362e38", func() Value { return Map{"a": Map{}} }},
	{"list-vs-map", `{"a":[]}`, "50e8660084976a10", func() Value { return Map{"a": []Value{}} }},
	{"string-carrying-yaml", `{"expr":"${{ nodes.a.outputs.b }}"}`, "632fa61f466181bf",
		func() Value { return Map{"expr": "${{ nodes.a.outputs.b }}"} }},
	{"folded-scalar", `{"prompt":"one two\n"}`, "3c2f240d25ecbc23",
		func() Value { return Map{"prompt": "one two\n"} }},
	{"literal-scalar", `{"prompt":"one\ntwo\n"}`, "afa25a6617cea537",
		func() Value { return Map{"prompt": "one\ntwo\n"} }},
}

func TestSpikeCanonicalBytesAndDigests(t *testing.T) {
	for _, c := range spikeCanonical {
		t.Run(c.name, func(t *testing.T) {
			// The digest half of the golden always applies: it proves this
			// package's Digest is the same function the spike ran.
			if got := Digest([]byte(c.bytes)); !strings.HasPrefix(got, "sha256:"+c.digest16) {
				t.Fatalf("Digest(%s) = %s, want the spike's sha256 prefix %s", c.bytes, got, c.digest16)
			}
			if c.value == nil {
				return
			}
			b, err := Canonicalize(c.value())
			if err != nil {
				t.Fatalf("Canonicalize: %v", err)
			}
			if string(b) != c.bytes {
				t.Fatalf("canonical bytes =\n  %s\nwant\n  %s", b, c.bytes)
			}
		})
	}
}

// TestDigestsMatchSHA256 is the cheapest proof that the digest function is the
// real one rather than something that merely looks stable.
func TestDigestsMatchSHA256(t *testing.T) {
	if got := Digest(nil); got != "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" {
		t.Fatalf("Digest(nil) = %s, want sha256 of the empty input", got)
	}
	if got := Digest([]byte("{}")); got != "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a" {
		t.Fatalf("Digest({}) = %s", got)
	}
}

func TestKeyOrderIndependent(t *testing.T) {
	a := Map{"x": int64(1), "y": Map{"p": int64(2), "q": []Value{int64(3), nil, "s"}}}
	b := Map{"y": Map{"q": []Value{int64(3), nil, "s"}, "p": int64(2)}, "x": int64(1)}
	da, err := DigestValue(a)
	if err != nil {
		t.Fatal(err)
	}
	db, err := DigestValue(b)
	if err != nil {
		t.Fatal(err)
	}
	if da != db {
		t.Fatalf("key order changed the digest: %s vs %s", da, db)
	}
}

// TestCanonicalMapSorts pins the property the digest depends on: the encoder
// sorts by UTF-8 byte order, never by author order, and never by Go's map order.
func TestCanonicalMapSorts(t *testing.T) {
	b, err := Canonicalize(Map{"z": int64(1), "a": int64(2), "M": int64(3), "~": int64(4), "é": int64(5)})
	if err != nil {
		t.Fatal(err)
	}
	// Byte order: 'M'(4D) < 'a'(61) < 'z'(7a) < '~'(7e) < 'é'(C3 A9).
	if string(b) != `{"M":3,"a":2,"z":1,"~":4,"é":5}` {
		t.Fatalf("encoder did not sort by UTF-8 byte order: %s", b)
	}
}

// TestIntegersStayIntegers is ADR-0021 § 5's reason for rejecting full RFC 8785
// JCS: a reformatting rule would rewrite values the loader already validated.
func TestIntegersStayIntegers(t *testing.T) {
	b, err := Canonicalize(Map{"n": int64(83), "f": 1e3, "half": 0.5, "big": int64(9223372036854775807)})
	if err != nil {
		t.Fatal(err)
	}
	want := `{"big":9223372036854775807,"f":1000,"half":0.5,"n":83}`
	if string(b) != want {
		t.Fatalf("canonical = %s, want %s", b, want)
	}
	// A canonical float must equal encoding/json's shortest round-trip form,
	// which is what ADR-0021 § 5 names as the number rule.
	for _, f := range []float64{0.1, 1e-7, 1e15, 1e308, 3.0, -0.0, 1234567890.123456} {
		jb, err := json.Marshal(f)
		if err != nil {
			t.Fatal(err)
		}
		cb, err := Canonicalize(f)
		if err != nil {
			t.Fatal(err)
		}
		if string(cb) != string(jb) {
			t.Errorf("float %v: canonical %s != encoding/json %s", f, cb, jb)
		}
	}
}

func TestRejectsUnsupportedValues(t *testing.T) {
	var bad any = func() {}
	if _, err := Canonicalize(Map{"bad": bad}); err == nil {
		t.Fatal("a func value was canonicalized instead of rejected")
	}
	// int and int64 must encode to the same bytes: the loader emits int64, a hand
	// built tree may emit int, and a digest may not care which.
	si, err := Canonicalize(int(3))
	if err != nil {
		t.Fatal(err)
	}
	s64, err := Canonicalize(int64(3))
	if err != nil {
		t.Fatal(err)
	}
	if string(si) != string(s64) {
		t.Fatalf("int and int64 encoded differently: %s vs %s", si, s64)
	}
	inf := math.Inf(1)
	if _, err := Canonicalize(Map{"inf": inf}); err == nil {
		t.Fatal("a non-finite float was canonicalized instead of rejected")
	}
}

// TestWithoutUIDropsOnlyUI pins ADR-0021 § 2: the digest covers the executable
// revision, so a redrawn button cannot orphan a run that pinned it.
func TestWithoutUIDropsOnlyUI(t *testing.T) {
	doc := map[string]Value{
		"apiVersion": "communication.dev/v1alpha1",
		"kind":       "Pipeline",
		"metadata":   Map{"name": "p", "ui": Map{"icon": "rocket", "nested": Map{"deep": int64(1)}}},
		"spec":       Map{"nodes": []Value{Map{"id": "a", "kind": "condition"}}},
	}
	raw, err := Canonicalize(doc)
	if err != nil {
		t.Fatal(err)
	}
	cvs, err := CanonicalizeDocument(doc)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(cvs), `"ui"`) || strings.Contains(string(cvs), "rocket") {
		t.Fatalf("ui survived canonicalization: %s", cvs)
	}
	if !strings.Contains(string(raw), `"ui"`) {
		t.Fatal("the raw form must keep ui")
	}
	withUI, err := DigestValue(doc)
	if err != nil {
		t.Fatal(err)
	}
	noUI, err := DigestDocument(doc)
	if err != nil {
		t.Fatal(err)
	}
	if withUI == noUI {
		t.Fatal("stripping ui did not change the digest")
	}
	// WithoutUI must not mutate the caller's document: the same map is digested
	// twice in the publish path and handed to the store afterwards.
	if _, ok := doc["metadata"].(Map)["ui"]; !ok {
		t.Fatal("WithoutUI mutated the input document")
	}

	// A document with no ui digests the same either way: the separation must not
	// move the identity of a pipeline that never had any.
	bare := map[string]Value{"apiVersion": "a", "spec": Map{"nodes": []Value{}}}
	b, err := Canonicalize(bare)
	if err != nil {
		t.Fatal(err)
	}
	if Digest(b) != mustDigestDoc(t, bare) {
		t.Fatal("ui-less document digest moved")
	}
}

func mustDigestDoc(t *testing.T, doc map[string]Value) string {
	t.Helper()
	d, err := DigestDocument(doc)
	if err != nil {
		t.Fatal(err)
	}
	return d
}

// TestNFCNormalization: two spellings of one name are one identity. This is
// exactly where the spike's toolchain error hid — Go's fixture writer emitted
// NFD, Rust emitted NFC, and the digest diverged across services with nothing on
// screen to say so.
func TestNFCNormalization(t *testing.T) {
	nfc := norm.NFC.String("café")
	nfd := norm.NFD.String("café")
	if nfc == nfd {
		t.Fatal("test string does not distinguish the two forms")
	}
	d1, err := DigestValue(Map{"name": nfc})
	if err != nil {
		t.Fatal(err)
	}
	d2, err := DigestValue(Map{"name": nfd})
	if err != nil {
		t.Fatal(err)
	}
	if d1 != d2 {
		t.Fatalf("NFC and NFD produced different digests: %s vs %s", d1, d2)
	}
	// And the key path normalizes too.
	k1, _ := DigestValue(Map{"é": int64(1)})
	k2, _ := DigestValue(Map{norm.NFD.String("é"): int64(1)})
	if k1 != k2 {
		t.Fatal("keys were not NFC-normalized")
	}
}

// TestStringEncodingRules: controls are escaped so the canonical form holds no
// raw control bytes; printable non-ASCII survives literally so a digest input
// stays readable in a diff; the line/paragraph separators are escaped because a
// JSON text-splitting tool would otherwise break inside a string.
func TestStringEncodingRules(t *testing.T) {
	for _, s := range []string{"a\tb", "a\x00b", "a\x1fb", "a\nb\rc", "a\x07b"} {
		enc := encString(s)
		for _, r := range enc[1 : len(enc)-1] {
			if r < 0x20 {
				t.Fatalf("canonical string %q still holds a raw control character", enc)
			}
		}
	}
	for _, s := range []string{"café ☃", "a-b_c.d/e"} {
		if enc := encString(s); enc != `"`+s+`"` {
			t.Fatalf("printable non-ASCII was escaped: %s -> %s", s, enc)
		}
	}
	if enc := encString(`q"b\`); enc != `"q\"b\\"` {
		t.Fatalf("quotes/backslash mis-encoded: %s", enc)
	}
	if enc := encString("line\u2028break"); enc != `"line\u2028break"` {
		t.Fatalf("U+2028 was left literal, which breaks JSON line tools: %s", enc)
	}
	// The escape vocabulary must match encoding/json's, or two honest
	// implementations of the same document disagree in a digest.
	for _, s := range []string{"tab\t", "quot\"", "bs\\", "nul\x00", "bell\x07", "café"} {
		jb, err := json.Marshal(s)
		if err != nil {
			t.Fatal(err)
		}
		cb, err := Canonicalize(s)
		if err != nil {
			t.Fatal(err)
		}
		// encoding/json HTML-escapes <, > and & by default; canonical form must
		// not, so those three are excluded from the comparison.
		if strings.ContainsAny(s, "<>&") {
			continue
		}
		if string(cb) != string(jb) {
			t.Errorf("string %q: canonical %s != encoding/json %s", s, cb, jb)
		}
	}
}

// encString runs the encoder's string path alone.
func encString(s string) string {
	var out []byte
	encodeString(&out, s)
	return string(out)
}

// TestCanonicalIsStableAcrossRuns: encoding is a pure function of the tree, so
// a plan digest computed today matches one computed at recovery.
func TestCanonicalIsDeterministic(t *testing.T) {
	v := Map{"a": []Value{int64(1), Map{"b": "c"}, nil, true}, "d": 0.5}
	first, err := Canonicalize(v)
	if err != nil {
		t.Fatal(err)
	}
	for range 20 {
		again, err := Canonicalize(v)
		if err != nil {
			t.Fatal(err)
		}
		if string(again) != string(first) {
			t.Fatalf("canonicalization is not deterministic: %s vs %s", again, first)
		}
	}
}

// TestRoundTripsThroughEncodingJSON: whatever the encoder emits must parse back
// to the same tree, which is what lets the store and the browser agree.
func TestRoundTripsThroughEncodingJSON(t *testing.T) {
	v := Map{
		"nodes": []Value{
			Map{"id": "plan", "kind": "agent.acp", "config": Map{"prompt": "build ${{ x }}\ttab"}},
			Map{"id": "t", "kind": "process.exec", "outputs": Map{"type": []Value{"string", "null"}}},
		},
		"policies": Map{"maxConcurrentNodes": int64(1), "maxChildDepth": int64(0), "n": 1e15},
	}
	b, err := Canonicalize(v)
	if err != nil {
		t.Fatal(err)
	}
	var back map[string]any
	if err := json.Unmarshal(b, &back); err != nil {
		t.Fatalf("canonical bytes do not parse as JSON: %v\n%s", err, b)
	}
	again, err := json.Marshal(back)
	if err != nil {
		t.Fatal(err)
	}
	// Re-encoding through encoding/json must land on the same bytes: if it does
	// not, the two encoders disagree about some value and a digest computed by
	// one service would not verify at another.
	var tree Value
	if err := json.Unmarshal(again, &tree); err != nil {
		t.Fatal(err)
	}
	second, err := Canonicalize(normalize(tree))
	if err != nil {
		t.Fatal(err)
	}
	if string(second) != string(b) {
		t.Fatalf("round trip moved the canonical bytes:\n %s\n %s", b, second)
	}
}
