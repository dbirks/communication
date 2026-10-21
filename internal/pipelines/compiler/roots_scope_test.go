package compiler_test

import (
	"strings"
	"testing"

	"github.com/dbirks/communication/internal/pipelines/compiler"
	"github.com/dbirks/communication/internal/pipelines/diag"
	"github.com/dbirks/communication/internal/pipelines/loader"
	"github.com/dbirks/communication/internal/pipelines/schema"
)

// ADR-0022 § 2 declares the CEL roots POSITIONALLY: inputs/nodes/run exist at
// pipeline scope, item/items only inside a for_each body, previous/iteration only
// inside an until body, and parameters only inside a NodeTemplate expansion.
// Contract § 7.1 C13d therefore has two halves per root: it must compile where it
// is declared, and be refused with undeclared_root where it is not. The documents
// below are byte-for-byte what the live gate sends (see testdata headers), so this
// is the same evidence the exit gate claims — read off the same compiler.

// rootRefusalCodes are the findings that say "this root does not exist here".
var rootRefusalCodes = []diag.Code{
	diag.CodeUndeclaredRoot, diag.CodeCELCompile, diag.CodeFunctionNotAllowed,
	diag.CodeBindingSyntax,
}

func compileYAMLFile(t *testing.T, path string) diag.List {
	t.Helper()
	doc, d := load(t, path)
	if !d.Valid() {
		t.Fatalf("loader/schema %s: %s", path, showDiags(d))
	}
	_, cd := compiler.Compile(doc, compiler.Options{})
	return cd
}

func showDiags(d diag.List) string {
	if len(d) == 0 {
		return "no findings"
	}
	parts := make([]string, 0, len(d))
	for _, x := range d {
		parts = append(parts, string(x.Code)+"@"+x.InstanceLocation.String())
	}
	return strings.Join(parts, ", ")
}

// diagsAt returns the findings whose location is at or under a document pointer.
func diagsAt(d diag.List, at string) diag.List {
	var out diag.List
	for _, x := range d {
		if loc := x.InstanceLocation.String(); loc == at || strings.HasPrefix(loc, at+"/") {
			out = append(out, x)
		}
	}
	return out
}

// TestC13dDeclaredRootsCompileInTheirOwnScope is C13d's accept half: seven roots
// probed in the scope that declares them. A member-level refusal (unknown_field on
// run.x, whose envelope has fixed keys) proves the ROOT resolved; a root-level
// refusal of a root the scope declares is the bug C13d exists to catch.
func TestC13dDeclaredRootsCompileInTheirOwnScope(t *testing.T) {
	// The same document carries the gate's reserved-`loop` probe; its own refusal is
	// asserted by TestC13dReservedRootIsRefused, not here.
	const reservedAt = "/spec/nodes/3/config/prompt"
	var reserved diag.List
	for _, x := range compileYAMLFile(t, "testdata/c13d-roots-in-scope.yaml") {
		if strings.HasPrefix(x.InstanceLocation.String(), reservedAt) {
			reserved = append(reserved, x)
			continue
		}
		for _, c := range rootRefusalCodes {
			if x.Code == c {
				t.Errorf("a declared root was refused as a root: %s@%s %s",
					x.Code, x.InstanceLocation, x.Message)
			}
		}
	}
	if len(reserved) != 1 || reserved[0].Code != diag.CodeUndeclaredRoot ||
		!strings.Contains(reserved[0].Message, "reserved identifier") {
		t.Errorf("the reserved root `loop` was not refused by the parser's own reason: %s",
			showDiags(reserved))
	}
}

// TestC13dPositionalRootsAreRefusedOutsideTheirScope is C13d's refusal half, and
// the reason the gate may not probe `item.x` at pipeline scope and call the answer
// a compiler bug: the answer is the positional rule working (ADR-0022 § 2).
func TestC13dPositionalRootsAreRefusedOutsideTheirScope(t *testing.T) {
	want := map[string]string{
		"/spec/nodes/0/config/prompt": "item",
		"/spec/nodes/1/config/prompt": "items",
		"/spec/nodes/2/config/prompt": "previous",
		"/spec/nodes/3/config/prompt": "iteration",
		"/spec/nodes/4/config/prompt": "parameters",
	}
	d := compileYAMLFile(t, "testdata/c13d-roots-misuse.yaml")
	for at, root := range want {
		hits := diagsAt(d, at)
		if len(hits) == 0 {
			t.Errorf("%s: root %q compiled at pipeline scope; ADR-0022 § 2 declares it elsewhere", at, root)
			continue
		}
		var found bool
		for _, x := range hits {
			if x.Code == diag.CodeUndeclaredRoot && strings.Contains(x.Message, root) {
				found = true
			}
		}
		if !found {
			t.Errorf("%s: root %q refused with %s, want undeclared_root naming it", at, root, showDiags(hits))
		}
	}
}

// misuseSiblingTail reads the other composite's roots: item/items belong to
// for_each and previous/iteration to until, never to each other's body.
const misuseSiblingTail = `  - id: fan
    kind: for_each
    config:
      items: '${{ inputs.goal }}'
      maxConcurrency: 1
      body:
        nodes:
        - id: b_prev
          kind: agent.acp
          timeoutSeconds: 60
          config:
            profile: m4-planner
            sessionMode: new
            prompt: 'previous -> ${{ has(previous.x) ? previous.x : "y" }}'
  - id: until1
    kind: until
    dependsOn: [fan]
    config:
      maxIterations: 2
      passWhen: nodes.b_item.status == 'succeeded'
      body:
        nodes:
        - id: b_item
          kind: agent.acp
          timeoutSeconds: 60
          config:
            profile: m4-planner
            sessionMode: new
            prompt: 'item -> ${{ item.x }}'
`

func TestC13dSiblingScopeRootsAreRefused(t *testing.T) {
	d := compileYAML(t, misuseSiblingTail)
	for at, root := range map[string]string{
		"/spec/nodes/0/config/body/nodes/0/config/prompt": "previous",
		"/spec/nodes/1/config/body/nodes/0/config/prompt": "item",
	} {
		var found bool
		var seen string
		for _, x := range diagsAt(d, at) {
			seen += string(x.Code) + " "
			if x.Code == diag.CodeUndeclaredRoot && strings.Contains(x.Message, root) {
				found = true
			}
		}
		if !found {
			t.Errorf("%s: root %q not refused as undeclared_root (saw: %s)", at, root, seen)
		}
	}
}

// TestC13dParametersRootCompilesInTemplateScope: the NodeTemplate scope
// answer (contract § 9.1 row 12): the parameters root resolves inside the
// template scope and the document compiles. ADR-0049 § 2 lifted the
// ADR-0024 § 2 publish deferral: the registry API is the publish path and
// the compiler no longer refuses the document itself.
func TestC13dParametersRootCompilesInTemplateScope(t *testing.T) {
	d := compileYAMLFile(t, "testdata/c13d-parameters-template.yaml")
	for _, x := range diagsAt(d, "/spec/config") {
		if x.Code == diag.CodeUndeclaredRoot {
			t.Errorf("the parameters root was refused in its own scope: %s %s", x.Code, x.Message)
		}
	}
	if !d.Valid() {
		t.Errorf("the NodeTemplate document no longer compiles cleanly: %s", showDiags(d))
	}
}

// rootsHeader is the minimal pipeline frame the sibling-scope probes are compiled
// in — the same inputs/policies the gate's own base document declares.
const rootsHeader = `apiVersion: communication.dev/v1alpha1
kind: Pipeline
metadata:
  name: c13d-root-probe
  description: C13d CEL root scope probe (docs/m4-contract.md § 7.1).
spec:
  inputs:
    type: object
    required: [goal]
    properties:
      goal: {type: string, minLength: 1}
  policies:
    maxConcurrentNodes: 1
    maxDurationSeconds: 3600
    maxNodeExecutions: 50
    maxChildDepth: 0
    workspaceMode: worktree
    cancelPolicy: cascade
  nodes:
`

func compileYAML(t *testing.T, tail string) diag.List {
	t.Helper()
	doc, d := loader.Load([]byte(rootsHeader + tail))
	if !d.Valid() {
		t.Fatalf("loader/schema: %s", showDiags(d))
	}
	if vd := schema.MustCompile().Validate(doc.Value); !vd.Valid() {
		t.Fatalf("schema: %s", showDiags(vd))
	}
	_, cd := compiler.Compile(doc, compiler.Options{})
	return cd
}
