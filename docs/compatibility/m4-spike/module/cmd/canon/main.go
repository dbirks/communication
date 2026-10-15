// Command canon tests the YAML→canonical-JSON→digest path for the classes of
// input that silently change a pipeline's identity: duplicate keys, aliases and
// merge keys, YAML 1.1 vs 1.2 scalars, multi-document streams, number types and
// key ordering. This is the evidence for ADR-0021's digest rule.
package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"golang.org/x/text/unicode/norm"
	"sort"
	"strings"
	"time"

	"go.yaml.in/yaml/v3"
)

type doc struct {
	name string
	yaml string
}

var docs = []doc{
	{"key-order", "a: 1\nb: 2\nc: {y: 2, x: 1}\n"},
	{"key-order-shuffled", "c: {x: 1, y: 2}\nb: 2\na: 1\n"},
	{"comments-and-style", "# leading\na: 1   # trailing\nb: '2'\nc:\n  x: 1\n  y: 2\n"},
	{"block-vs-flow", "a: 1\nb: \"2\"\nc:\n  x: 1\n  y: 2\n"},
	{"duplicate-keys", "a: 1\na: 2\n"},
	{"alias", "a: &x {p: 1}\nb: *x\n"},
	{"merge-key", "base: &b {p: 1, q: 2}\nuse:\n  <<: *b\n  q: 3\n"},
	{"billion-laughs", "a: &a {x: [1,2,3,4,5,6,7,8,9,10]}\nb: &b {x: [*a,*a,*a,*a,*a,*a,*a,*a,*a]}\nc: &c {x: [*b,*b,*b,*b,*b,*b,*b,*b,*b]}\nd: &d {x: [*c,*c,*c,*c,*c,*c,*c,*c,*c]}\ne: &e {x: [*d,*d,*d,*d,*d,*d,*d,*d,*d]}\nf: {x: [*e,*e,*e,*e,*e,*e,*e,*e,*e]}\n"},
	{"yaml11-bools", "yes: 1\nno: 2\non: 3\noff: 4\ntrue_: true\n"},
	{"date-scalar", "when: 2026-10-14\n"},
	{"time-scalar", "when: 2026-10-14T18:00:00Z\n"},
	{"sexagesimal", "ratio: 1:30\n"},
	{"leading-zero-int", "n: 0123\n"},
	{"octal-0o", "n: 0o17\n"},
	{"underscore-number", "n: 1_000\n"},
	{"big-int", "n: 123456789012345678901234567890\n"},
	{"float-forms", "a: 1.0\nb: 1e3\nc: .5\nd: +1\n"},
	{"null-forms", "a: ~\nb: null\nc:\nd: Null\ne: NULL\n"},
	{"multi-document", "a: 1\n---\nb: 2\n"},
	{"tab-character", "a: 1\n\tb: 2\n"},
	{"duplicate-anchor", "a: &x 1\nb: &x 2\nc: *x\n"},
	{"unicode-compose", "name: \"caf\\u00e9\"\n"},
	{"unicode-decompose", "name: \"cafe\\u0301\"\n"},
	{"empty-vs-missing", "a: {}\n"},
	{"list-vs-map", "a: []\n"},
	{"string-carrying-yaml", "expr: \"${{ nodes.a.outputs.b }}\"\n"},
	{"folded-scalar", "prompt: >\n  one\n  two\n"},
	{"literal-scalar", "prompt: |\n  one\n  two\n"},
}

func main() {
	fmt.Println("=== parse behaviour + canonical digest per document ===")
	for _, d := range docs {
		probe(d)
	}

	fmt.Println("\n=== digest stability of one pipeline written two ways ===")
	a := mustParse(`metadata:
  name: p
  description: d
spec:
  inputs: {}
  nodes:
    - id: a
      kind: condition
      config:
        cases:
          - when: "true"
            route: ok
`)
	b := mustParse(`spec:
  nodes:
    - config:
        cases:
          - route: ok
            when: "true"
      kind: condition
      id: a
  inputs: {}
metadata:
  description: d
  name: p
  # a comment changes nothing
`)
	c := mustParse(`metadata:
  description: d
  name: p
spec:
  inputs: {}
  nodes:
  - id: a
    kind: condition
    config:
      cases:
      - when: "true"
        route: ok
`)
	fmt.Printf("same-canonical-bytes-regardless-of-key-order=%v\n", bytes.Equal(a, b))
	fmt.Printf("same-canonical-after-yaml-reparse=%v\n", bytes.Equal(b, c))
	fmt.Printf("digest=%s len=%d\n", digest(a), len(a))

	fmt.Println("\n=== proposed canonicalization rules, applied ===")
	nfcCheck()
	numberCheck()
	boolCheck()
}

func nfcCheck() {
	x := mustParse("name: \"caf\\u00e9\"\n")
	y := mustParse("name: \"cafe\\u0301\"\n")
	fmt.Printf("raw-digests-equal-for-NFC-variants=%v (false means unnormalized digests split)\n", bytes.Equal(x, y))
	nx, _ := canonicalJSON(nfc(normalize(mustAny("name: \"caf\\u00e9\"\n"))))
	ny, _ := canonicalJSON(nfc(normalize(mustAny("name: \"cafe\\u0301\"\n"))))
	fmt.Printf("after-NFC-digests-equal=%v digest=%s\n", bytes.Equal(nx, ny), digest(nx))
}

func numberCheck() {
	for _, src := range []string{"n: 1e999\n", "n: .inf\n", "n: 9223372036854775808\n", "n: 3.0\n"} {
		v := mustAny(src)
		c, err := canonicalJSON(normalize(v))
		fmt.Printf("%-24q canon=%-18s err=%v\n", src, string(c), err)
	}
}

func boolCheck() {
	for _, src := range []string{"flag: yes\n", "flag: on\n", "flag: true\n", "flag: True\n", "flag: \"yes\"\n"} {
		v := mustAny(src)
		c, _ := canonicalJSON(normalize(v))
		fmt.Printf("%-20q -> %s\n", src, string(c))
	}
}

func mustAny(src string) any {
	var v any
	if err := yaml.Unmarshal([]byte(src), &v); err != nil {
		panic(err)
	}
	return v
}

func probe(d doc) {
	var root yaml.Node
	perr := yaml.Unmarshal([]byte(d.yaml), &root)
	if perr != nil {
		fmt.Printf("%-22s parse-err: %s\n", d.name, truncate(errStr(perr), 130))
		return
	}
	dup, alias, merge := walk(&root)

	// decode into a plain map (what a validator would do)
	var v any
	derr := yaml.Unmarshal([]byte(d.yaml), &v)
	if derr != nil {
		fmt.Printf("%-22s decode-err: %s\n", d.name, truncate(errStr(derr), 130))
		return
	}
	// multi-document detection
	dec := yaml.NewDecoder(bytes.NewReader([]byte(d.yaml)))
	docs := 0
	for {
		var tmp any
		if e := dec.Decode(&tmp); e != nil {
			if e.Error() == "EOF" {
				break
			}
			fmt.Printf("%-22s stream-err: %s\n", d.name, truncate(errStr(e), 90))
			return
		}
		docs++
		if docs > 4 {
			break
		}
	}

	types := scalarTypes(v)
	canon, cerr := canonicalJSON(normalize(v))
	if cerr != nil {
		fmt.Printf("%-22s canonical-err: %s\n", d.name, truncate(errStr(cerr), 130))
		return
	}
	fmt.Printf("%-22s dup=%v alias=%v merge=%v docs=%d canon=%s digest=%s\n",
		d.name, dup, alias, merge, docs, truncate(string(canon), 96), digest(canon))
	if len(types) > 0 {
		fmt.Printf("%-22s   go-types: %s\n", "", strings.Join(types, " "))
	}
}

func walk(n *yaml.Node) (dup, alias, merge bool) {
	var rec func(*yaml.Node)
	rec = func(n *yaml.Node) {
		switch n.Kind {
		case yaml.DocumentNode, yaml.SequenceNode:
			for _, c := range n.Content {
				rec(c)
			}
		case yaml.MappingNode:
			seen := map[string]bool{}
			for i := 0; i+1 < len(n.Content); i += 2 {
				k := n.Content[i]
				if k.Tag == "!!merge" {
					merge = true
				}
				if seen[k.Value] {
					dup = true
				}
				seen[k.Value] = true
				rec(n.Content[i+1])
			}
		case yaml.AliasNode:
			alias = true
		default:
			if n.Anchor != "" {
				alias = true
			}
		}
	}
	rec(n)
	return
}

func scalarTypes(v any) []string {
	var out []string
	switch t := v.(type) {
	case map[string]any:
		for k, val := range t {
			out = append(out, fmt.Sprintf("%s=%T", k, val))
			if _, ok := val.(time.Time); ok {
				out = append(out, "(time.Time)")
			}
		}
	case []any:
		for _, val := range t {
			out = append(out, fmt.Sprintf("[]%T", val))
		}
	}
	sort.Strings(out)
	return out
}

func mustParse(s string) []byte {
	var v any
	if err := yaml.Unmarshal([]byte(s), &v); err != nil {
		panic(err)
	}
	b, err := canonicalJSON(normalize(v))
	if err != nil {
		panic(err)
	}
	return b
}

func nfc(v any) any {
	switch t := v.(type) {
	case map[string]any:
		m := make(map[string]any, len(t))
		for k, val := range t {
			m[nfcString(k)] = nfc(val)
		}
		return m
	case []any:
		s := make([]any, len(t))
		for i, val := range t {
			s[i] = nfc(val)
		}
		return s
	case string:
		return nfcString(t)
	default:
		return v
	}
}

func nfcString(s string) string { return norm.NFC.String(s) }

func normalize(v any) any {
	switch t := v.(type) {
	case map[any]any:
		m := make(map[string]any, len(t))
		for k, val := range t {
			m[fmt.Sprint(k)] = normalize(val)
		}
		return m
	case map[string]any:
		m := make(map[string]any, len(t))
		for k, val := range t {
			m[k] = normalize(val)
		}
		return m
	case []any:
		s := make([]any, len(t))
		for i, val := range t {
			s[i] = normalize(val)
		}
		return s
	case time.Time:
		return t.UTC().Format(time.RFC3339Nano)
	default:
		return v
	}
}

func canonicalJSON(v any) ([]byte, error) {
	var buf bytes.Buffer
	if err := writeCanonical(&buf, v); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func writeCanonical(buf *bytes.Buffer, v any) error {
	switch t := v.(type) {
	case map[string]any:
		keys := make([]string, 0, len(t))
		for k := range t {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		buf.WriteByte('{')
		for i, k := range keys {
			if i > 0 {
				buf.WriteByte(',')
			}
			kb, err := json.Marshal(k)
			if err != nil {
				return err
			}
			buf.Write(kb)
			buf.WriteByte(':')
			if err := writeCanonical(buf, t[k]); err != nil {
				return err
			}
		}
		buf.WriteByte('}')
	case []any:
		buf.WriteByte('[')
		for i, e := range t {
			if i > 0 {
				buf.WriteByte(',')
			}
			if err := writeCanonical(buf, e); err != nil {
				return err
			}
		}
		buf.WriteByte(']')
	default:
		b, err := json.Marshal(t)
		if err != nil {
			return err
		}
		buf.Write(b)
	}
	return nil
}

func digest(b []byte) string {
	h := sha256.Sum256(b)
	return "sha256:" + hex.EncodeToString(h[:8])
}

func errStr(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

func truncate(s string, n int) string {
	s = strings.ReplaceAll(s, "\n", "⏎")
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

var _ = errors.New
