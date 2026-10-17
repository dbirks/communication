package compiler_test

// ADR-0029: model.chat message content is a bindingText position, so a
// `${{ … }}` written inside a prompt compiles into a real expression instead of
// being recorded as a literal. Before the asset typed `configModelChat.messages
// .items`, the position walker could not place /config/messages/<i>/content
// (schema.Position → "unknown"), the compiler stored the raw text, and the model
// received `${{ inputs.goal }}` verbatim. These tests pin the pointer, the
// position and the expression count — the compiler half; the runtime half lives
// in internal/worker/modelchat_test.go and internal/pipelines/runtime.

import (
	"strings"
	"testing"

	"github.com/dbirks/communication/internal/pipelines/compiler"
	"github.com/dbirks/communication/internal/pipelines/diag"
	"github.com/dbirks/communication/internal/pipelines/loader"
	"github.com/dbirks/communication/internal/pipelines/schema"
)

const modelChatHeader = `apiVersion: communication.dev/v1alpha1
kind: Pipeline
metadata:
  name: model-chat-bindings
  description: ADR-0029 message binding probe.
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

const modelChatBody = `  - id: plan
    kind: model.chat
    config:
      model: qwen3-8-27b
      messages:
      - role: system
        content: Reply with a plan.
      - role: user
        content: |
          Goal: ${{ inputs.goal }}
    outputs:
      type: object
      required: [text]
      properties:
        text: {type: string, minLength: 1}
`

// compileModelChat runs loader → schema → compiler on the probe document and
// returns the plan plus every finding. A loader refusal (bad YAML) is fatal;
// schema and compiler findings are the caller's to judge, because two of these
// cases exist to prove the document is refused.
func compileModelChat(t *testing.T, body string) (*compiler.Plan, diag.List) {
	t.Helper()
	doc, ld := loader.Load([]byte(modelChatHeader + body))
	if !ld.Valid() {
		t.Fatalf("loader: %s", showDiags(ld))
	}
	if vd := schema.MustCompile().Validate(doc.Value); !vd.Valid() {
		return nil, vd
	}
	plan, cd := compiler.Compile(doc, compiler.Options{})
	return plan, cd
}

func bindingsAt(plan *compiler.Plan, pointer string) []compiler.Binding {
	var out []compiler.Binding
	for _, n := range plan.Nodes {
		for _, b := range n.ConfigBindings {
			if b.Pointer == pointer {
				out = append(out, b)
			}
		}
	}
	return out
}

// TestModelChatMessageContentIsABindingPosition: the user message binds, the
// system message beside it stays a literal, and the binding sits at exactly the
// pointer the runtime resolves.
func TestModelChatMessageContentIsABindingPosition(t *testing.T) {
	plan, d := compileModelChat(t, modelChatBody)
	if !d.Valid() {
		t.Fatalf("compiler refused the document: %s", showDiags(d))
	}
	at := "/spec/nodes/0/config/messages/1/content"
	got := bindingsAt(plan, at)
	if len(got) != 1 {
		t.Fatalf("%s: %d bindings, want exactly 1", at, len(got))
	}
	b := got[0]
	if b.Position != schema.PositionText {
		t.Errorf("%s position = %q, want %q", at, b.Position, schema.PositionText)
	}
	if len(b.ExprIDs) != 1 {
		t.Fatalf("%s compiled %d expressions, want 1 (binding recorded as literal = the ADR-0029 bug)", at, len(b.ExprIDs))
	}
	if b.IsLiteral() {
		t.Errorf("%s recorded as a literal: template %q", at, b.Template)
	}
	if !strings.Contains(b.Template, "%") || strings.Contains(b.Template, "${{") {
		t.Errorf("%s template = %q, want the authored text with ${{ … }} replaced by an expression id", at, b.Template)
	}
	if lit := bindingsAt(plan, "/spec/nodes/0/config/messages/0/content"); len(lit) != 1 || !lit[0].IsLiteral() {
		t.Errorf("the system message must stay a literal: %+v", lit)
	}
	var pinned int
	for _, e := range plan.Expressions {
		if e.Pointer == at {
			pinned++
			if e.Position != schema.PositionText {
				t.Errorf("expression position = %q, want %q", e.Position, schema.PositionText)
			}
		}
	}
	if pinned != 1 {
		t.Errorf("%d plan expressions pinned at %s, want 1", pinned, at)
	}
}

// TestModelChatMessageExtraKeyFailsValidation is ADR-0029's fail-closed half: a
// key the message shape does not declare is refused at its own pointer, not
// ignored on the way to the endpoint.
func TestModelChatMessageExtraKeyFailsValidation(t *testing.T) {
	_, d := compileModelChat(t, strings.Replace(modelChatBody,
		"        content: Reply with a plan.\n",
		"        content: Reply with a plan.\n        name: planner\n", 1))
	if d.Valid() {
		t.Fatal("a message holding an undeclared `name` key validated")
	}
	var hit *diag.Diagnostic
	for i, x := range d {
		if x.InstanceLocation.String() == "/spec/nodes/0/config/messages/0/name" {
			hit = &d[i]
		}
	}
	if hit == nil {
		t.Fatalf("no finding at the offending key: %s", showDiags(d))
	}
	if hit.Code != diag.CodeSchemaShape {
		t.Errorf("code = %s, want %s", hit.Code, diag.CodeSchemaShape)
	}
}

// TestModelChatMessageRoleMustBeKnown: role is a literal enum, so a role outside
// system|user|assistant — and a ${{ }} there, which nothing could bind — both
// fail closed at the role's own pointer.
func TestModelChatMessageRoleMustBeKnown(t *testing.T) {
	for _, role := range []string{"tool", "'${{ inputs.goal }}'"} {
		body := strings.Replace(modelChatBody, "      - role: user\n",
			"      - role: "+role+"\n", 1)
		_, d := compileModelChat(t, body)
		if d.Valid() {
			t.Errorf("role %s validated", role)
			continue
		}
		var hit bool
		for _, x := range d {
			if x.InstanceLocation.String() == "/spec/nodes/0/config/messages/1/role" {
				hit = true
			}
		}
		if !hit {
			t.Errorf("role %s: no finding at the role pointer: %s", role, showDiags(d))
		}
	}
}

// The live pass-34 failure: temperature: 0 is an integer literal the schema
// admits (minimum 0), yet the run-time check only read float64 and refused it
// before the model was called. The validate half of the same rule lives in
// chatPolicy: it must accept the canon loader's int64 and name a range the
// worker would refuse at run time — at the key's own pointer, at publish.
// compiler.Compile is driven directly (loader → compiler, no schema pass) so
// these cases pin the policy check itself, not the schema validator that
// would otherwise catch the same ranges first.
func compileModelChatNoSchema(t *testing.T, body string) diag.List {
	t.Helper()
	doc, ld := loader.Load([]byte(modelChatHeader + body))
	if !ld.Valid() {
		t.Fatalf("loader: %s", showDiags(ld))
	}
	_, cd := compiler.Compile(doc, compiler.Options{})
	return cd
}

func modelChatFinding(d diag.List, pointer string) *diag.Diagnostic {
	for i := range d {
		if d[i].InstanceLocation.String() == pointer {
			return &d[i]
		}
	}
	return nil
}

// TestModelChatNumericConfigAtCompile: an integer 0 is in range and compiles;
// an out-of-range or non-whole value is refused at the key's pointer with
// schema_shape — the same ranges the worker enforces (internal/domain
// chatnumber helper, shared by both sides).
func TestModelChatNumericConfigAtCompile(t *testing.T) {
	valid := []string{
		"      temperature: 0\n",
		"      temperature: 1\n",
		"      temperature: 2\n",
		"      temperature: 0.2\n",
		"      maxTokens: 1\n",
		"      maxTokens: 64\n",
		"      maxTokens: 200000\n",
	}
	for _, extra := range valid {
		d := compileModelChatNoSchema(t, strings.Replace(modelChatBody, "    outputs:\n",
			extra+"    outputs:\n", 1))
		if !d.Valid() {
			t.Errorf("valid numeric config %q refused: %s", extra, showDiags(d))
		}
	}
	refused := []struct {
		line    string
		pointer string
	}{
		{"      temperature: 2.5\n", "/spec/nodes/0/config/temperature"},
		{"      temperature: -1\n", "/spec/nodes/0/config/temperature"},
		{"      maxTokens: 0\n", "/spec/nodes/0/config/maxTokens"},
		{"      maxTokens: 1.5\n", "/spec/nodes/0/config/maxTokens"},
		{"      maxTokens: 200001\n", "/spec/nodes/0/config/maxTokens"},
	}
	for _, tc := range refused {
		d := compileModelChatNoSchema(t, strings.Replace(modelChatBody, "    outputs:\n",
			tc.line+"    outputs:\n", 1))
		if d.Valid() {
			t.Errorf("out-of-range %s compiled: %s", strings.TrimSpace(tc.line), showDiags(d))
			continue
		}
		hit := modelChatFinding(d, tc.pointer)
		if hit == nil {
			t.Errorf("%s: no finding at the key's pointer: %s", strings.TrimSpace(tc.line), showDiags(d))
			continue
		}
		if hit.Code != diag.CodeSchemaShape {
			t.Errorf("%s code = %s, want %s", strings.TrimSpace(tc.line), hit.Code, diag.CodeSchemaShape)
		}
	}
}
