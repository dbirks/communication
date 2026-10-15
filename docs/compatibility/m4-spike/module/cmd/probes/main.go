// Command probes feeds deliberately shaped documents at the provisional schema
// and at a candidate strict schema, to record exactly which classes of pipeline
// bug the JSON Schema layer can and cannot catch (spec 03 § "Canonical document
// & schema" claims the compiler must do the rest — this measures that claim).
package main

import (
	"bytes"
	"context"
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

// Imported-copy change (see ../README.md): the spike baked its author's
// absolute paths in. Resolution is now runtime rather than compile-time so the
// copy in this repository reruns: the spec directory is $M4SPIKE_SPEC_DIR or the
// nearest ancestor holding communication-spec/schemas/pipeline.schema.json, and
// the spike's own candidate assets are $M4SPIKE_CANDIDATE_DIR or ./candidate
// relative to the working directory (i.e. run from the module root).
var (
	specDir       = findSpecDir()
	provSchemaAt  = specDir + "/schemas/pipeline.schema.json"
	candSchemaAt  = candidateDir() + "/pipeline.schema.json"
	contractYAML  = candidateDir() + "/feature-development.yaml"
	correctedYAML = candidateDir() + "/feature-development-corrected.yaml"
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

func candidateDir() string {
	if v := os.Getenv("M4SPIKE_CANDIDATE_DIR"); v != "" {
		return v
	}
	return "candidate"
}

type probe struct {
	name      string
	why       string
	doc       string // YAML, for readability
	wantValid bool   // expectation under the candidate (strict) schema
}

// minimal valid pipeline used as the baseline for one-bug-at-a-time probes.
const base = `apiVersion: communication.dev/v1alpha1
kind: Pipeline
metadata:
  name: p
spec:
  inputs:
    type: object
    properties: {}
  nodes:
  - id: a
    kind: condition
    config:
      cases:
      - {when: "true", route: ok}
      default: no
`

func withBase(tail string) string { return base + tail }

var probes = []probe{
	{"vacuous-config", "unknown node config keys are accepted by the provisional schema (no per-kind config schema exists)",
		"apiVersion: communication.dev/v1alpha1\nkind: Pipeline\nmetadata: {name: p}\nspec:\n  inputs: {}\n  nodes:\n    - id: a\n      kind: process.exec\n      config: {executable: go, typo: x, prompt2: y}\n", false},
	{"typed-literal-vs-expression", "expression string where an integer budget is required (examples/process-ready-issues maxConcurrency)",
		"apiVersion: communication.dev/v1alpha1\nkind: Pipeline\nmetadata: {name: p}\nspec:\n  inputs: {}\n  nodes:\n    - id: a\n      kind: for_each\n      config: {items: \"${{ nodes.b.outputs.x }}\", maxConcurrency: \"${{ inputs.n }}\", body: {nodes: [{id: c, kind: condition, config: {cases: [{when: \"true\", route: ok}]}}]}}\n", false},
	{"duplicate-node-id", "same node id twice: NOT catchable structurally (JSON Schema cannot compare array items) — compiler job",
		withBase("  - id: b\n    kind: condition\n    config:\n      cases:\n      - {when: \"false\", route: ok}\n"), true},
	{"self-dependency", "a node depending on itself: NOT catchable structurally — compiler job (DAG check)",
		withBase("  - id: b\n    kind: condition\n    dependsOn: [b]\n    config:\n      cases:\n      - {when: \"false\", route: ok}\n"), true},
	{"dangling-depends-on", "dependsOn naming a nonexistent node: NOT catchable structurally — compiler job",
		withBase("  - id: b\n    kind: condition\n    dependsOn: [nope]\n    config:\n      cases:\n      - {when: \"false\", route: ok}\n"), true},
	{"inputs-not-json-schema", "spec.inputs as a map of names (not a JSON Schema) passes the provisional schema",
		"apiVersion: communication.dev/v1alpha1\nkind: Pipeline\nmetadata: {name: p}\nspec:\n  inputs: {goal: string, repository: string}\n  nodes:\n    - {id: a, kind: condition, config: {cases: [{when: \"true\", route: ok}]}}\n", false},
	{"unconstrained-policies", "spec.policies is a free object in the provisional schema: a nonsense budget passes",
		"apiVersion: communication.dev/v1alpha1\nkind: Pipeline\nmetadata: {name: p}\nspec:\n  inputs: {}\n  policies: {maxConcurrentNodes: -1, timeoutSeconds: \"later\"}\n  nodes:\n    - {id: a, kind: condition, config: {cases: [{when: \"true\", route: ok}]}}\n", false},
	{"until-body-unvalidated", "nested body.nodes inside until.config are unvalidated by the provisional schema (config is a free object)",
		"apiVersion: communication.dev/v1alpha1\nkind: Pipeline\nmetadata: {name: p}\nspec:\n  inputs: {}\n  nodes:\n    - id: loop\n      kind: until\n      config: {maxIterations: 3, passWhen: \"true\", body: {nodes: [{id: \"1\", kind: \"nope\"}]}}\n", false},
	{"kind-name-drift", "roadmap/M4 language says \"human gate\"; the enum has `gate` and `human.approval`, so `human.gate` is a hard schema error",
		"apiVersion: communication.dev/v1alpha1\nkind: Pipeline\nmetadata: {name: p}\nspec:\n  inputs: {}\n  nodes:\n    - {id: a, kind: human.gate, config: {approvers: []}}\n", false},
	{"yaml-1.1-boolean", "`yes` is a string under YAML 1.2 core schema (yaml.v3): a boolean-typed field written 1.1-style is a type error",
		"apiVersion: communication.dev/v1alpha1\nkind: Pipeline\nmetadata: {name: p}\nspec:\n  inputs: {}\n  nodes:\n    - {id: a, kind: until, config: {maxIterations: 3, passWhen: \"true\", carryForward: yes, body: {nodes: [{id: c, kind: condition, config: {cases: [{when: \"true\", route: ok}]}}]}}}\n", false},
	{"secret-literal-in-config", "an inline secret value passes structurally under BOTH schemas: invariant 5 is compiler-only, not schema",
		"apiVersion: communication.dev/v1alpha1\nkind: Pipeline\nmetadata: {name: p}\nspec:\n  inputs: {}\n  nodes:\n    - {id: a, kind: process.exec, config: {executable: psql, env: {DATABASE_URL: \"postgres://u:p@h/d\"}}}\n", true},
	{"secretrefs-shape", "secretRefs must be `project/<slug>`|`org/<slug>` references; a URL-shaped value is rejected structurally",
		"apiVersion: communication.dev/v1alpha1\nkind: Pipeline\nmetadata: {name: p}\nspec:\n  inputs: {}\n  nodes:\n    - {id: a, kind: process.exec, config: {executable: psql, secretRefs: [\"postgres://u:p@h/d\"]}}\n", false},
	{"template-kind", "examples/node-template-reviewer.yaml kind NodeTemplate: rejected by the provisional schema (Pipeline-only), accepted by the candidate",
		"apiVersion: communication.dev/v1alpha1\nkind: NodeTemplate\nmetadata: {name: t, version: 1.0.0}\nspec: {implements: agent.acp, parameters: {type: object, properties: {}}, config: {profile: \"${{ parameters.p }}\", prompt: \"review\"}}\n", true},
	{"assignment-kind", "examples/project-binding.yaml kind PipelineAssignment: NO schema exists for it in either candidate (07 makes assignments first-class)",
		"apiVersion: communication.dev/v1alpha1\nkind: PipelineAssignment\nmetadata: {name: b}\nspec: {project: p}\n", false},
	{"secret-mounts-document", "examples/secret-mounts.yaml is not an apiVersion/kind document at all, so nothing validates it",
		"secret_mounts: []\nsandbox: {backend: nono}\n", false},
}

func main() {
	prov, err := os.ReadFile(provSchemaAt)
	must(err)
	cand, err := os.ReadFile(candSchemaAt)
	must(err)

	fmt.Printf("provisional schema: %d bytes; candidate schema: %d bytes\n", len(prov), len(cand))
	for _, label := range []string{"provisional", "candidate"} {
		src := prov
		if label == "candidate" {
			src = cand
		}
		if err := compileCheck(src); err != nil {
			fmt.Printf("schema-compile/%s: FAIL: %v\n", label, err)
		} else {
			fmt.Printf("schema-compile/%s: PASS (santhosh v6 compiles it as 2020-12)\n", label)
		}
	}

	for _, p := range probes {
		doc := mustJSON(yamlToJSON([]byte(p.doc)))
		provRes := short(validateSanthoshSrc(prov, doc))
		candRes := short(validateSanthoshSrc(cand, doc))
		agree := "MATCHES"
		if (candRes == "PASS") != p.wantValid {
			agree = "MISMATCH"
		}
		fmt.Printf("\n--- probe %s\n    why: %s\n    provisional: %s\n    candidate:     %s\n    expected-under-candidate-valid=%v => %s\n",
			p.name, p.why, provRes, candRes, p.wantValid, agree)
	}

	// The shipped example vs the corrected one, under both schemas and all libs.
	for _, f := range []string{contractYAML, correctedYAML} {
		raw, err := os.ReadFile(f)
		if err != nil {
			fmt.Printf("\n--- contract-sample %s: MISSING (%v)\n", filepathBase(f), err)
			continue
		}
		doc := mustJSON(yamlToJSON(raw))
		_ = doc
		fmt.Printf("\n--- sample %s\n    provisional/santhosh: %s\n    provisional/qri:      %s\n    provisional/xeipuuv:  %s\n    candidate/santhosh:   %s\n",
			filepathBase(f),
			errText(validateSanthoshSrc(prov, doc)),
			errText(validateQri(prov, mustMarshal(doc))),
			errText(validateXeipuuv(prov, mustMarshal(doc))),
			errText(validateSanthoshSrc(cand, doc)))
	}
}

func filepathBase(f string) string {
	i := bytes.LastIndexByte([]byte(f), '/')
	return f[i+1:]
}

func compileCheck(src []byte) error {
	c := santhosh.NewCompiler()
	id := mustJSON(src).(map[string]any)["$id"].(string)
	if err := c.AddResource(id, mustJSON(src)); err != nil {
		return err
	}
	_, err := c.Compile(id)
	return err
}

// validateSanthoshFor compiles the kind-branch of a candidate schema whose
// top level is a oneOf over document kinds, identified by a const `kind`.
func unusedSanthoshFor(src []byte, doc any, wantKind string) error {
	c := santhosh.NewCompiler()
	id := mustJSON(src).(map[string]any)["$id"].(string)
	// Compile just that branch by $id anchor: #/$defs/<Kind>Document
	branch := id + "#/$defs/" + wantKind + "Document"
	if err := c.AddResource(id, mustJSON(src)); err != nil {
		return err
	}
	_ = branch
	// The candidate root is a oneOf over document kinds, so compiling the root
	// is what a real validator does; per-kind branch ids exist for error framing.
	sch, err := c.Compile(id)
	if err != nil {
		return fmt.Errorf("compile %s: %w", branch, err)
	}
	return wrapVErr(sch.Validate(doc))
}

func wrapVErr(err error) error {
	if err == nil {
		return nil
	}
	var ve *santhosh.ValidationError
	if errors.As(err, &ve) {
		b, merr := json.Marshal(ve.BasicOutput())
		if merr == nil {
			return errors.New(truncate(ve.Error()+"\n  basic-output: "+string(b), 1500))
		}
	}
	return err
}

func short(err error) string {
	if err == nil {
		return "PASS"
	}
	msg := err.Error()
	if i := strings.Index(msg, "\n"); i >= 0 {
		lines := strings.Split(msg, "\n")
		keep := []string{lines[0]}
		for _, l := range lines[1:] {
			t := strings.TrimSpace(l)
			if strings.HasPrefix(t, "- at") && !strings.Contains(t, "oneOf") && !strings.Contains(t, "allOf") && !strings.Contains(t, "validation failed") && !strings.Contains(t, "anyOf") {
				keep = append(keep, "    "+t)
			}
			if strings.Contains(t, "missing property") || strings.Contains(t, "not allowed") || strings.Contains(t, "must be") || strings.Contains(t, "is not valid") {
				keep = append(keep, "    "+t)
			}
		}
		if len(keep) > 8 {
			keep = keep[:8]
		}
		return "FAIL:\n" + strings.Join(dedupe(keep), "\n")
	}
	return "FAIL: " + truncate(msg, 600)
}

func dedupe(in []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(in))
	for _, s := range in {
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}

func validateSanthoshSrc(schemaSrc []byte, doc any) error {
	c := santhosh.NewCompiler()
	id := mustJSON(schemaSrc).(map[string]any)["$id"].(string)
	must(c.AddResource(id, mustJSON(schemaSrc)))
	sch, err := c.Compile(id)
	if err != nil {
		return fmt.Errorf("compile: %w", err)
	}
	return wrapVErr(sch.Validate(doc))
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
	return errors.New(truncate(strings.Join(parts, " | "), 1800))
}

func validateXeipuuv(schemaSrc, doc []byte) error {
	res, err := xeipuuv.Validate(xeipuuv.NewBytesLoader(schemaSrc), xeipuuv.NewBytesLoader(doc))
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
	return errors.New(truncate(strings.Join(parts, " | "), 1800))
}

func yamlToJSON(raw []byte) []byte {
	var v any
	must(yaml.Unmarshal(raw, &v))
	b, err := json.Marshal(normalize(v))
	must(err)
	return b
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
	must(dec.Decode(&v))
	return v
}

func mustMarshal(v any) []byte {
	b, err := json.Marshal(v)
	must(err)
	return b
}

func errText(err error) string {
	if err == nil {
		return "PASS"
	}
	return "FAIL: " + truncate(err.Error(), 1800)
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
