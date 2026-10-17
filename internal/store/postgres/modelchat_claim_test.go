package postgres

// Pass-37 fix (lab cabade3): a published model.chat node's
// config.responseSchema never reached the executor — the compiler dropped it
// from the plan's configBindings, the claim hydration rebuilds the executor's
// config from exactly those bindings, and model.chat sets outputs.json only
// when it sees the schema. The compiler half is pinned in
// internal/pipelines/compiler TestModelChatResponseSchemaSurvivesCompilation;
// the executor half (schema-valid reply → outputs.json) in internal/worker
// TestModelChatHappyPath. This test pins the middle: the COMPILER'S plan,
// pinned as a run's immutable plan_snapshot exactly as PublishDraft stores it,
// hydrates into the claim's Config with the whole schema intact.

import (
	"encoding/json"
	"testing"

	"github.com/dbirks/communication/internal/pipelines/compiler"
	"github.com/dbirks/communication/internal/pipelines/loader"
	"github.com/dbirks/communication/internal/pipelines/schema"
)

const modelChatClaimDoc = `apiVersion: communication.dev/v1alpha1
kind: Pipeline
metadata:
  name: model-chat-claim-schema
  description: pass-37 responseSchema hydration probe.
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
  - id: review
    kind: model.chat
    config:
      model: qwen3-8-27b
      messages:
      - role: system
        content: Reply with JSON only.
      - role: user
        content: |
          Goal: ${{ inputs.goal }}
      responseSchema:
        type: object
        required: [verdict]
        properties:
          verdict: {type: string}
          notes: {type: string}
    outputs:
      type: object
      required: [text, json]
      properties:
        text: {type: string}
        json:
          type: object
          required: [verdict]
          properties:
            verdict: {type: string}
`

// TestModelChatResponseSchemaReachesTheClaim compiles the document with the
// real compiler, pins that plan into runs.plan_snapshot, claims the attempt
// through the real ClaimAttempts path, and asserts the claim's Config carries
// the whole responseSchema object — the value model.chat reads to set
// outputs.json (§ 4 step 8).
func TestModelChatResponseSchemaReachesTheClaim(t *testing.T) {
	ctx := testCtx(t)
	f, store := awSetup(t)

	doc, ld := loader.Load([]byte(modelChatClaimDoc))
	if !ld.Valid() {
		t.Fatalf("loader: %v", ld)
	}
	if vd := schema.MustCompile().Validate(doc.Value); !vd.Valid() {
		t.Fatalf("schema: %v", vd)
	}
	plan, cd := compiler.Compile(doc, compiler.Options{})
	if !cd.Valid() {
		t.Fatalf("compiler: %v", cd)
	}
	snapshot, err := json.Marshal(plan)
	if err != nil {
		t.Fatalf("marshal plan: %v", err)
	}

	runID := f.m4QueuedRun(t, ctx, "", 0)
	if _, err := f.pool.Exec(ctx, `UPDATE runs SET plan_snapshot = $2 WHERE id = $1::uuid`, runID, snapshot); err != nil {
		t.Fatalf("pin the compiled plan: %v", err)
	}
	f.m4WorkerNode(t, ctx, runID, "/review")
	workerID := m4Worker(t, ctx, f.pool, "schema-hydrated", 1)

	claims, err := store.ClaimAttempts(ctx, workerID, 1)
	if err != nil {
		t.Fatalf("claim: %v", err)
	}
	if len(claims) != 1 {
		t.Fatalf("claims = %d, want 1", len(claims))
	}
	cfg := claims[0].Config
	if cfg == nil {
		t.Fatal("claim carried no Config: hydration found no plan node for /review")
	}
	schemaVal, ok := cfg["responseSchema"].(map[string]any)
	if !ok {
		t.Fatalf("config.responseSchema = %#v (type %T): the claim lost the schema — the executor would set no outputs.json and the declared outputs (required: [text, json]) would refuse the reply",
			cfg["responseSchema"], cfg["responseSchema"])
	}
	if schemaVal["type"] != "object" {
		t.Errorf("responseSchema.type = %v, want object", schemaVal["type"])
	}
	props, _ := schemaVal["properties"].(map[string]any)
	if _, ok := props["verdict"]; !ok {
		t.Errorf("responseSchema lost its properties: %#v", cfg["responseSchema"])
	}
	if cfg["model"] != "qwen3-8-27b" {
		t.Errorf("config.model = %v, want the authored literal beside the schema", cfg["model"])
	}
	if msgs, ok := cfg["messages"].([]any); !ok || len(msgs) != 2 {
		t.Fatalf("config.messages = %#v, want the hydrated 2-entry message list", cfg["messages"])
	}
}
