package assistant

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// probePipeline is the first document of the § 7 exit seed (the M4 contract
// shape) — the real node tree the refusal table is validated against.
const probePipelinePath = "../../docs/compatibility/probes/m4/pipeline.yaml"

func probeDoc(t *testing.T) *Doc {
	t.Helper()
	raw, err := os.ReadFile(filepath.Clean(probePipelinePath))
	if err != nil {
		t.Fatalf("read probe pipeline: %v", err)
	}
	// The file is one document per --- slice; document 1 is the agent-driven
	// variant (Plan -> Approve -> ... -> publish evidence).
	slices := strings.Split(string(raw), "\n---\n")
	if len(slices) == 0 {
		t.Fatalf("probe pipeline has no documents")
	}
	d, err := LoadDraftDoc([]byte(slices[0]))
	if err != nil {
		t.Fatalf("load probe pipeline: %v", err)
	}
	want := []string{"plan", "approve", "build_until_verified", "implement", "test",
		"review", "emit_items", "fan_out", "invoke", "verdict",
		"publish_verified", "publish_needs_attention"}
	for _, id := range want {
		if !d.HasID(id) {
			t.Fatalf("probe doc is missing node %q (got %v)", id, d.order)
		}
	}
	return d
}

// syntheticDoc is a second, controlled tree for the edge cases the probe
// document cannot express (cross-scope is impossible in a real document, so
// the guard stays tested on a hand-built one).
const syntheticYAML = `apiVersion: communication.dev/v1alpha1
kind: Pipeline
metadata:
  name: synthetic
spec:
  nodes:
  - id: plan
    kind: agent.acp
    config: {profile: planner, prompt: plan the change}
  - id: check
    kind: model.chat
    dependsOn: [plan]
    config: {prompt: inspect the plan}
  - id: gate
    kind: condition
    dependsOn: [check]
    config:
      cases:
      - when: "true"
        route: "pass"
      default: "fail"
  - id: pass_arm
    kind: process.exec
    dependsOn: [gate]
    when: "nodes.gate.outputs.route == 'pass'"
    config: {cmd: echo, arg: "ok ${{ nodes.gate.outputs.route }}"}
  - id: flaky
    kind: process.exec
    onFailure: {onExecutionError: route, errorRoute: repair}
    config: {cmd: echo}
  - id: repair
    kind: agent.acp
    dependsOn: [flaky]
    config: {profile: fixer, prompt: repair the failure}
`

func syntheticDoc(t *testing.T) *Doc {
	t.Helper()
	d, err := LoadDraftDoc([]byte(syntheticYAML))
	if err != nil {
		t.Fatalf("load synthetic doc: %v", err)
	}
	return d
}

func wantReason(t *testing.T, d *Doc, p Proposal, want string) {
	t.Helper()
	err := ValidateProposal(d, p)
	if want == "" {
		if err != nil {
			t.Fatalf("op %+v = %v, want accepted", p, err)
		}
		return
	}
	if err == nil {
		t.Fatalf("op %+v accepted, want refusal %q", p, want)
	}
	if err.Reason != want {
		t.Fatalf("op %+v = %q (%s), want reason %q", p, err.Reason, err.Detail, want)
	}
}

func TestValidateProposalProbePipeline(t *testing.T) {
	d := probeDoc(t)
	cases := []struct {
		name string
		p    Proposal
		want string
	}{
		{"accept insert_after terminal node",
			Proposal{Op: OpInsertAfter, After: "review", Kind: "human.approval", ID: "approve_review", Config: map[string]any{}},
			""},
		{"accept insert_after publish_verified",
			Proposal{Op: OpInsertAfter, After: "publish_verified", Kind: "process.exec", ID: "notify"},
			""},
		{"accept insert_on_edge approve->build_until_verified",
			Proposal{Op: OpInsertOnEdge, From: "approve", To: "build_until_verified", Kind: "model.chat", ID: "check_plan",
				Config: map[string]any{"prompt": "review the plan"}},
			""},
		{"accept update_prompt on agent.acp",
			Proposal{Op: OpUpdatePrompt, Node: "plan", Prompt: "plan the change"},
			""},
		{"refuse unknown op",
			Proposal{Op: "teleport", After: "plan"},
			"unknown_op"},
		{"refuse validate-only kind",
			Proposal{Op: OpInsertAfter, After: "publish_verified", Kind: "parallel", ID: "fan"},
			"unknown_kind"},
		{"refuse id with a dash (schema identifier has none)",
			Proposal{Op: OpInsertOnEdge, From: "approve", To: "build_until_verified", Kind: "model.chat", ID: "check-plan"},
			"bad_id"},
		{"refuse id starting with a digit",
			Proposal{Op: OpInsertOnEdge, From: "approve", To: "build_until_verified", Kind: "model.chat", ID: "1check"},
			"bad_id"},
		{"refuse id colliding with an existing node",
			Proposal{Op: OpInsertOnEdge, From: "approve", To: "build_until_verified", Kind: "model.chat", ID: "plan"},
			"id_taken"},
		{"refuse unknown target node",
			Proposal{Op: OpInsertAfter, After: "ghost", Kind: "process.exec", ID: "n1"},
			"unknown_node"},
		{"refuse insert_after on a node with dependents",
			Proposal{Op: OpInsertAfter, After: "plan", Kind: "process.exec", ID: "n1"},
			"target_has_dependents"},
		{"refuse insert_on_edge on a missing edge",
			Proposal{Op: OpInsertOnEdge, From: "approve", To: "plan", Kind: "process.exec", ID: "n1"},
			"no_edge"},
		{"refuse insert_on_edge on a when-guarded target",
			Proposal{Op: OpInsertOnEdge, From: "emit_items", To: "fan_out", Kind: "process.exec", ID: "n1"},
			"guarded_target"},
		{"refuse insert_on_edge reading the source's outputs",
			Proposal{Op: OpInsertOnEdge, From: "verdict", To: "publish_needs_attention", Kind: "process.exec", ID: "n1"},
			"guarded_target"},
		{"refuse update_prompt on human.approval",
			Proposal{Op: OpUpdatePrompt, Node: "approve", Prompt: "hi"},
			"wrong_kind"},
		{"refuse update_prompt with an empty prompt",
			Proposal{Op: OpUpdatePrompt, Node: "plan", Prompt: "  "},
			"empty_prompt"},
		{"refuse update_prompt on a missing node",
			Proposal{Op: OpUpdatePrompt, Node: "ghost", Prompt: "hi"},
			"unknown_node"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			wantReason(t, d, tc.p, tc.want)
		})
	}
}

func TestValidateProposalSyntheticEdges(t *testing.T) {
	d := syntheticDoc(t)
	cases := []struct {
		name string
		p    Proposal
		want string
	}{
		{"accept insert_on_edge plan->check (no guards)",
			Proposal{Op: OpInsertOnEdge, From: "plan", To: "check", Kind: "model.chat", ID: "peek"},
			""},
		{"refuse condition source",
			Proposal{Op: OpInsertOnEdge, From: "gate", To: "pass_arm", Kind: "process.exec", ID: "n1"}, // pass_arm has a when, so strip the guard to reach the
			// condition-source rule alone below.

			"guarded_target"},
		{"refuse error-route edge",
			Proposal{Op: OpInsertOnEdge, From: "flaky", To: "repair", Kind: "process.exec", ID: "n1"},
			"error_route"},
		{"refuse update_prompt on model.chat with the named reason",
			Proposal{Op: OpUpdatePrompt, Node: "check", Prompt: "hi"},
			"prompt_kind_not_supported"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			wantReason(t, d, tc.p, tc.want)
		})
	}

	// The condition-source rule alone: a condition whose target has no when
	// guard (the synthetic pass_arm's guard shadows it otherwise).
	condDoc := LoadDraftDocForTest(t, `apiVersion: communication.dev/v1alpha1
kind: Pipeline
metadata:
  name: cond-only
spec:
  nodes:
  - id: gate
    kind: condition
    config:
      cases:
      - when: "true"
        route: "pass"
      default: "fail"
  - id: plain
    kind: process.exec
    dependsOn: [gate]
    config: {cmd: echo}
`)
	wantReason(t, condDoc,
		Proposal{Op: OpInsertOnEdge, From: "gate", To: "plain", Kind: "process.exec", ID: "n1"},
		"condition_source")

	// The edge-guard rule alone: a target with no when whose config binds
	// the source's outputs.
	bindDoc := LoadDraftDocForTest(t, `apiVersion: communication.dev/v1alpha1
kind: Pipeline
metadata:
  name: bound
spec:
  nodes:
  - id: emit
    kind: process.exec
    config: {cmd: echo}
  - id: consume
    kind: process.exec
    dependsOn: [emit]
    config: {cmd: echo, arg: "value ${{ nodes.emit.outputs.value }}"}
`)
	wantReason(t, bindDoc,
		Proposal{Op: OpInsertOnEdge, From: "emit", To: "consume", Kind: "process.exec", ID: "n1"},
		"edge_guarded")
}

func TestExtractProposal(t *testing.T) {
	const valid = `{"op":"insert_on_edge","from":"approve","to":"build","kind":"model.chat","id":"check","config":{"prompt":"look"},"summary":"inserts a plan check"}`
	cases := []struct {
		name    string
		raw     string
		wantErr bool
	}{
		{"plain object", valid, false},
		{"surrounding whitespace", "  \n" + valid + "\n", false},
		{"json fence", "```json\n" + valid + "\n```", false},
		{"bare fence", "```\n" + valid + "\n```", false},
		{"think prefix", "<think>\nlet me look at the graph...\n</think>" + valid, false},
		{"think then fence", "<think>hmm</think>\n```json\n" + valid + "\n```", false},
		{"malformed json", "```json\n{op: insert_after\n```", true},
		{"a second op", valid + `{"op":"update_prompt","node":"plan","prompt":"x"}`, true},
		{"trailing prose", valid + " let me know if that works", true},
		{"no op member", `{"after":"plan","id":"n1"}`, true},
		{"open think only", "<think>still reasoning", true},
		{"empty answer", "", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p, err := ExtractProposal(tc.raw)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("got %+v, want refusal", p)
				}
				return
			}
			if err != nil {
				t.Fatalf("got %v, want the parsed op", err)
			}
			if p.Op != OpInsertOnEdge || p.From != "approve" || p.To != "build" || p.ID != "check" {
				t.Fatalf("parsed %+v", p)
			}
		})
	}
}

// TestProposalFakeModelRoundTrip stands up the broker against a scripted
// OpenAI-compatible endpoint that answers with a fenced insert_on_edge and
// walks the whole proposal pipeline: one completion, one extraction, one
// validation, one validated op.
func TestProposalFakeModelRoundTrip(t *testing.T) {
	const answer = "```json\n" +
		`{"op":"insert_on_edge","from":"approve","to":"build_until_verified","kind":"model.chat","id":"check_plan","config":{"prompt":"review the plan"},"summary":"Adds a plan check between approval and the build loop"}` +
		"\n```"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/chat/completions" {
			http.Error(w, "wrong path", http.StatusNotFound)
			return
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "bad body", http.StatusBadRequest)
			return
		}
		msgs, _ := body["messages"].([]any)
		if len(msgs) != 2 {
			http.Error(w, "expected exactly one system+user turn", http.StatusBadRequest)
			return
		}
		// The proposal turn must switch the thinking budget off.
		kwargs, _ := body["chat_template_kwargs"].(map[string]any)
		if len(kwargs) != 1 || kwargs["enable_thinking"] != false {
			http.Error(w, "expected chat_template_kwargs {\"enable_thinking\":false}, got "+toAnyString(body["chat_template_kwargs"]), http.StatusBadRequest)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []map[string]any{{
				"message":       map[string]any{"role": "assistant", "content": answer},
				"finish_reason": "stop",
			}},
		})
	}))
	t.Cleanup(srv.Close)

	broker, err := New(Config{BaseURL: srv.URL, HTTPClient: srv.Client()}, storeForProposals(t))
	if err != nil {
		t.Fatalf("broker: %v", err)
	}
	raw, fail := broker.CompleteText(t.Context(), "system", "user")
	if fail != nil {
		t.Fatalf("completion: %v", fail)
	}
	if raw != answer {
		t.Fatalf("answer = %q", raw)
	}
	d := probeDoc(t)
	sumJSON, _ := json.Marshal(d.Summaries())
	system, user := ProposalPrompt(sumJSON, []string{"m4-planner"}, "insert a code reviewer after the approval gate")
	if !strings.Contains(system, "insert_on_edge") || !strings.Contains(user, "insert a code reviewer") {
		t.Fatalf("prompt missing the op set or the instruction")
	}
	p, err := ExtractProposal(raw)
	if err != nil {
		t.Fatalf("extract: %v", err)
	}
	if verr := ValidateProposal(d, p); verr != nil {
		t.Fatalf("validate: %v", verr)
	}
	if p.ID != "check_plan" || p.Kind != "model.chat" {
		t.Fatalf("validated op %+v", p)
	}
}

// TestCompleteTextRequestBodies pins the wire split between the two request
// shapes: the proposal turn carries chat_template_kwargs with
// enable_thinking=false, and the /ask tool-loop request (loop.go's shape)
// marshals byte-identically to before the field existed.
func TestCompleteTextRequestBodies(t *testing.T) {
	messages := []chatMessage{{Role: "system", Content: text("s")}, {Role: "user", Content: text("q")}}

	proposal, err := json.Marshal(chatRequest{
		Model:              "m",
		Messages:           messages,
		ChatTemplateKwargs: map[string]any{"enable_thinking": false},
	})
	if err != nil {
		t.Fatalf("marshal proposal: %v", err)
	}
	var proposalBody map[string]any
	if err := json.Unmarshal(proposal, &proposalBody); err != nil {
		t.Fatalf("unmarshal proposal: %v", err)
	}
	kwargs, _ := proposalBody["chat_template_kwargs"].(map[string]any)
	if len(kwargs) != 1 || kwargs["enable_thinking"] != false {
		t.Fatalf("proposal body %s: chat_template_kwargs = %v", proposal, proposalBody["chat_template_kwargs"])
	}

	// The /ask loop's exact construction (loop.go: Model + Messages +
	// ToolChoice): the new field must stay out of that body entirely.
	ask, err := json.Marshal(chatRequest{Model: "m", Messages: messages, ToolChoice: "auto"})
	if err != nil {
		t.Fatalf("marshal ask: %v", err)
	}
	golden := `{"model":"m","messages":[{"role":"system","content":"s"},{"role":"user","content":"q"}],"tool_choice":"auto"}`
	if string(ask) != golden {
		t.Fatalf("ask body is not byte-identical to the pre-change shape:\n got %s\nwant %s", ask, golden)
	}
}

// storeForProposals satisfies the broker's Store with the caller's own reads;
// the proposal turn makes no tool calls at all, so every method is a stand-in
// that must never be reached.
type staticStore struct{}

func (staticStore) ListProjects(context.Context, Caller) (json.RawMessage, error) {
	return nil, ErrNotFound
}
func (staticStore) ListPipelines(context.Context, Caller) (json.RawMessage, error) {
	return nil, ErrNotFound
}
func (staticStore) ListProjectRuns(context.Context, Caller, string) (json.RawMessage, error) {
	return nil, ErrNotFound
}
func (staticStore) ListRunNodes(context.Context, Caller, string) (json.RawMessage, error) {
	return nil, ErrNotFound
}
func (staticStore) ListProjectApprovals(context.Context, Caller, string) (json.RawMessage, error) {
	return nil, ErrNotFound
}
func (staticStore) ListPipelineRevisions(context.Context, Caller, string) (json.RawMessage, error) {
	return nil, ErrNotFound
}
func (staticStore) ListAgentProfiles(context.Context, Caller) (json.RawMessage, error) {
	return nil, ErrNotFound
}

func storeForProposals(t *testing.T) staticStore { return staticStore{} }

func toAnyString(v any) string {
	s, _ := json.Marshal(v)
	return string(s)
}

// LoadDraftDocForTest is the small escape hatch for the synthetic edge docs.
func LoadDraftDocForTest(t *testing.T, yaml string) *Doc {
	t.Helper()
	d, err := LoadDraftDoc([]byte(yaml))
	if err != nil {
		t.Fatalf("load doc: %v", err)
	}
	return d
}
