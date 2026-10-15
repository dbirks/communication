// Command validate is the M4 spike's schema harness: strict-parse every example
// YAML in the spec, convert to JSON, and validate against the provisional
// pipeline JSON Schema with three candidate Go validators, so the library
// choice (and the schema's own bugs) is observed rather than assumed.
package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	qri "github.com/qri-io/jsonschema"
	santhosh "github.com/santhosh-tekuri/jsonschema/v6"
	xeipuuv "github.com/xeipuuv/gojsonschema"
	"go.yaml.in/yaml/v3"
)

// Imported-copy change (see ../README.md): path resolution moved from baked-in
// absolute constants to runtime lookup, so the copy in this repository reruns.
var (
	specDir  = findSpecDir()
	schemaAt = specDir + "/schemas/pipeline.schema.json"
	examples = specDir + "/examples"
)

func findSpecDir() string {
	if v := os.Getenv("M4SPIKE_SPEC_DIR"); v != "" {
		return v
	}
	dir, err := os.Getwd()
	must(err)
	for i := 0; i < 10; i++ {
		if _, err := os.Stat(dir + "/communication-spec/schemas/pipeline.schema.json"); err == nil {
			return dir + "/communication-spec"
		}
		dir = filepath.Dir(dir)
	}
	panic("communication-spec not found in any ancestor directory; set M4SPIKE_SPEC_DIR")
}

func main() {
	schemaSrc, err := os.ReadFile(schemaAt)
	must(err)
	var self map[string]any
	must(json.Unmarshal(schemaSrc, &self))
	fmt.Printf("schema: $schema=%v $id=%v\n", self["$schema"], self["$id"])
	fmt.Printf("schema: required=%v additionalProperties=%v\n",
		self["required"], self["additionalProperties"])
	node := self["$defs"].(map[string]any)["node"].(map[string]any)
	props := node["properties"].(map[string]any)
	kind := props["kind"]
	fmt.Printf("schema: $defs.node keys=%v\n", keysOf(node))
	fmt.Printf("schema: $defs.node.properties keys=%v\n", keysOf(props))
	fmt.Printf("schema: node kinds=%d enum=%v\n", len(kind.(map[string]any)["enum"].([]any)), kind.(map[string]any)["enum"])
	fmt.Printf("schema: node additionalProperties=%v node required=%v\n", node["additionalProperties"], node["required"])
	fmt.Printf("schema: spec.properties keys=%v\n", keysOf(self["properties"].(map[string]any)["spec"].(map[string]any)["properties"].(map[string]any)))

	files, err := filepath.Glob(examples + "/*.yaml")
	must(err)
	sort.Strings(files)
	for _, f := range files {
		fmt.Printf("\n=== %s ===\n", filepath.Base(f))
		runOne(f, schemaSrc)
	}
}

func runOne(file string, schemaSrc []byte) {
	raw, err := os.ReadFile(file)
	must(err)

	dup, alias, err := yamlProbe(raw)
	fmt.Printf("yaml: duplicate-keys=%v anchors/aliases/merge=%v parse-err=%v\n", dup, alias, errText(err))
	if err != nil {
		return
	}
	// Strict decode: yaml.v3 into map[string]any plus a KnownFields decoder to
	// prove it refuses nothing structural the schema will have to catch instead.
	dec := yaml.NewDecoder(bytes.NewReader(raw))
	dec.KnownFields(true)
	var doc any
	if err := dec.Decode(&doc); err != nil {
		fmt.Printf("yaml: decode-err=%s\n", err)
		return
	}
	norm := normalize(doc)
	if km, ok := norm.(map[string]any); ok {
		fmt.Printf("yaml: apiVersion=%v kind=%v top-level-keys=%v\n", km["apiVersion"], km["kind"], keysOf(km))
	} else {
		fmt.Printf("yaml: top-level is %T, not a mapping\n", norm)
	}
	jsonDoc, err := json.Marshal(norm)
	must(err)

	fmt.Printf("jsonschema/santhosh/v6 (2020-12): %s\n", errText(validateSanthosh(schemaSrc, jsonDoc)))
	fmt.Printf("jsonschema/qri-io         (2019-09 max): %s\n", errText(validateQri(schemaSrc, jsonDoc)))
	fmt.Printf("jsonschema/xeipuuv        (draft-07 max): %s\n", errText(validateXeipuuv(schemaSrc, jsonDoc)))

	canon, err := canonicalJSON(norm)
	must(err)
	fmt.Printf("canon: bytes=%d sha256=%s\n", len(canon), sha256Hex(canon))
	var back any
	must(yaml.Unmarshal(canon, &back)) // JSON is a subset of YAML
	canon2, err := canonicalJSON(normalize(back))
	must(err)
	fmt.Printf("canon: json-is-yaml-round-trip-stable=%v\n", bytes.Equal(canon, canon2))
}

func yamlProbe(raw []byte) (dup bool, alias bool, err error) {
	var root yaml.Node
	if e := yaml.Unmarshal(raw, &root); e != nil {
		return false, false, e
	}
	var walk func(n *yaml.Node)
	walk = func(n *yaml.Node) {
		switch n.Kind {
		case yaml.DocumentNode, yaml.SequenceNode:
			for _, c := range n.Content {
				walk(c)
			}
		case yaml.MappingNode:
			seen := map[string]bool{}
			for i := 0; i+1 < len(n.Content); i += 2 {
				k := n.Content[i]
				if k.Tag == "!!merge" {
					alias = true
				}
				if seen[k.Value] {
					dup = true
				}
				seen[k.Value] = true
				walk(n.Content[i+1])
			}
		case yaml.AliasNode:
			alias = true
			return
		default:
			if n.Anchor != "" {
				alias = true
			}
		}
	}
	walk(&root)
	return dup, alias, yaml.Unmarshal(raw, &map[string]any{})
}

func validateSanthosh(schemaSrc, doc []byte) error {
	c := santhosh.NewCompiler()
	c.AssertFormat()
	schema := mustJSON(schemaSrc)
	id := schema.(map[string]any)["$id"].(string)
	if err := c.AddResource(id, schema); err != nil {
		return err
	}
	sch, err := c.Compile(id)
	if err != nil {
		return fmt.Errorf("compile: %w", err)
	}
	if err := sch.Validate(mustJSON(doc)); err != nil {
		var ve *santhosh.ValidationError
		if errors.As(err, &ve) {
			b, merr := json.Marshal(ve)
			if merr != nil {
				return err
			}
			return errors.New(truncate(string(b), 2500))
		}
		return err
	}
	return nil
}

func validateQri(schemaSrc, doc []byte) error {
	var ks qri.Schema
	if err := json.Unmarshal(schemaSrc, &ks); err != nil {
		return fmt.Errorf("schema-parse: %w", err)
	}
	errs, err := ks.ValidateBytes(context.Background(), doc)
	if err != nil {
		return err
	}
	if len(errs) == 0 {
		return nil
	}
	parts := make([]string, 0, len(errs))
	for _, e := range errs {
		parts = append(parts, fmt.Sprintf("%s: %s", e.PropertyPath, e.Message))
	}
	return errors.New(truncate(strings.Join(parts, " | "), 2000))
}

func validateXeipuuv(schemaSrc, doc []byte) error {
	res, err := xeipuuv.Validate(
		xeipuuv.NewBytesLoader(schemaSrc), xeipuuv.NewBytesLoader(doc))
	if err != nil {
		return err
	}
	if res.Valid() {
		return nil
	}
	parts := make([]string, 0, len(res.Errors()))
	for _, e := range res.Errors() {
		parts = append(parts, e.String())
	}
	return errors.New(truncate(strings.Join(parts, " | "), 2000))
}

// canonicalJSON emits a JCS-like form: sorted keys, no insignificant
// whitespace. Deliberately simple — the ADR decides whether full RFC 8785 is needed.
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
		keys := keysOf(t)
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
	default:
		return v
	}
}

func keysOf(m map[string]any) []string {
	ks := make([]string, 0, len(m))
	for k := range m {
		ks = append(ks, k)
	}
	sort.Strings(ks)
	return ks
}

func mustJSON(b []byte) any {
	var v any
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.UseNumber()
	if err := dec.Decode(&v); err != nil {
		panic(err)
	}
	return v
}

func sha256Hex(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

func errText(err error) string {
	if err == nil {
		return "PASS"
	}
	return "FAIL: " + truncate(err.Error(), 2000)
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…(truncated)"
}

func must(err error) {
	if err != nil {
		panic(err)
	}
}
