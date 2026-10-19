package postgres

// Claim hydration of a scope-BODY node's config (ADR-0027 § 4 step 6): a body
// node's plan pointer embeds the enclosing composite's own "/config/" prefix
// ("/spec/nodes/0/config/body/nodes/0/config/prompt"), and the path INSIDE the
// node's config starts at the LAST occurrence — the same rule the runtime's
// ConfigTree (internal/pipelines/runtime configSegments) already applies. The
// lab's "agent.acp config has no prompt" (run 01a1566e) was this helper taking
// the FIRST occurrence: the body node's prompt landed under
// body.nodes[0].config.prompt in the claim's Config and the top level was
// empty.

import (
	"encoding/json"
	"testing"

	"github.com/dbirks/communication/internal/pipelines/compiler"
	"github.com/dbirks/communication/internal/pipelines/loader"
	"github.com/dbirks/communication/internal/pipelines/schema"
)

const claimProbeHeader = `apiVersion: communication.dev/v1alpha1
kind: Pipeline
metadata:
  name: claim-hydration-probe
spec:
  inputs:
    type: object
    properties: {}
  policies:
    maxConcurrentNodes: 1
    maxDurationSeconds: 3600
    maxNodeExecutions: 50
    maxChildDepth: 2
    workspaceMode: worktree
    cancelPolicy: cascade
  nodes:
`

func compileClaimProbe(t *testing.T, body string) *compiler.Plan {
	t.Helper()
	doc, ld := loader.Load([]byte(claimProbeHeader + body))
	if !ld.Valid() {
		t.Fatalf("loader: %v", ld)
	}
	if d := schema.MustCompile().Validate(doc.Value); !d.Valid() {
		t.Fatalf("schema: %v", d)
	}
	plan, cd := compiler.Compile(doc, compiler.Options{})
	if !cd.Valid() {
		t.Fatalf("compiler: %v", cd)
	}
	return plan
}

// planShapeJSON is the plan exactly as it would sit in runs.plan_snapshot:
// the compiled plan's canonical JSON.
func planShapeJSON(t *testing.T, plan *compiler.Plan) []byte {
	t.Helper()
	v, err := plan.Value()
	if err != nil {
		t.Fatalf("plan.Value: %v", err)
	}
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal plan: %v", err)
	}
	return raw
}

// TestConfigRelPathBodyNodePointer pins the LAST-occurrence rule for a body
// node's pointer, plus the root-scope regression guard (the first occurrence
// is also the right one there).
func TestConfigRelPathBodyNodePointer(t *testing.T) {
	cases := []struct {
		pointer string
		rel     string
		ok      bool
	}{
		{"/spec/nodes/3/config/argv/0", "argv/0", true},
		{"/spec/nodes/0/config/prompt", "prompt", true},
		{"/spec/nodes/0/config/body/nodes/0/config/prompt", "prompt", true},
		{"/spec/nodes/0/config/body/nodes/1/config/env/API_KEY", "env/API_KEY", true},
		{"/spec/nodes/0/config/branches/0/nodes/2/config/prompt", "prompt", true},
		{"/spec/nodes/0/passWhen", "", false},
	}
	for _, c := range cases {
		got, ok := configRelPath(c.pointer)
		if ok != c.ok || got != c.rel {
			t.Errorf("configRelPath(%q) = %q, %v; want %q, %v", c.pointer, got, ok, c.rel, c.ok)
		}
	}
}

// TestNodeConfigHydratesBodyNodeConfigEndToEnd compiles a real document (an
// agent.acp with a LITERAL prompt inside an until body, the lab's failing
// shape, plus a root agent.acp for contrast) and runs the claim hydration the
// worker sees: plan snapshot -> nodeConfig -> claim Config. The prompt must
// arrive at the top level and nothing may be duplicated under body/.
func TestNodeConfigHydratesBodyNodeConfigEndToEnd(t *testing.T) {
	const prompt = "Review the diff for the add() fix and answer JSON {\"approved\": true|false}"
	const rootPrompt = "Review the diff and answer JSON {\"approved\": true|false}"
	plan := compileClaimProbe(t, `  - id: review_root
    kind: agent.acp
    config:
      profile: m4-reviewer
      prompt: 'Review the diff and answer JSON {"approved": true|false}'
  - id: build_until_verified
    kind: until
    config:
      maxIterations: 2
      passWhen: has(nodes.code_review.outputs.approved) && nodes.code_review.outputs.approved == true
      body:
        nodes:
        - id: code_review
          kind: agent.acp
          config:
            profile: m4-reviewer
            prompt: 'Review the diff for the add() fix and answer JSON {"approved": true|false}'
          dependsOn: [test]
          onFailure: {onExecutionError: continue}
          outputs:
            type: object
            properties:
              approved: {type: boolean}
        - id: test
          kind: process.exec
          config:
            executable: test
      resultBindings:
        approved: ${{ nodes.code_review.outputs.approved }}
    outputs:
      type: object
      properties:
        approved: {type: boolean}
`)
	shape := parsePlanShape(planShapeJSON(t, plan))

	// The root node: first /config/ is the only one.
	rootCfg := shape.nodeConfig("/", "review_root")
	if rootCfg == nil {
		t.Fatalf("nodeConfig(/, review_root) = nil: the snapshot has no entry")
	}
	if got, _ := rootCfg["prompt"].(string); got != rootPrompt {
		t.Errorf("root config prompt = %q, want the authored literal", got)
	}

	// The body node: the pointer carries the composite's own /config/ prefix.
	bodyCfg := shape.nodeConfig("/build_until_verified/", "code_review")
	if bodyCfg == nil {
		t.Fatalf("nodeConfig(/build_until_verified/, code_review) = nil: the snapshot has no entry")
	}
	if got, _ := bodyCfg["prompt"].(string); got != prompt {
		t.Errorf("body config prompt = %q, want the authored literal (lab: 'agent.acp config has no prompt')", got)
	}
	if got, _ := bodyCfg["profile"].(string); got != "m4-reviewer" {
		t.Errorf("body config profile = %q, want m4-reviewer", got)
	}
	if _, leaked := bodyCfg["body"]; leaked {
		t.Errorf("body config leaked the composite's shape: %v (first-occurrence /config/ bug)", bodyCfg)
	}
}
