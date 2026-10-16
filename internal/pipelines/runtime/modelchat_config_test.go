package runtime_test

// ADR-0029's runtime half: a model.chat message's ${{ … }} is compiled as a
// binding (see compiler/modelchat_test.go) and resolved by the SAME claim-time
// path that resolves agent.acp's prompt (ADR-0027) — the store hydrates a claim
// through ResolveNodeConfig, and the worker is handed literals. If message
// content had never been routed through it, the fix would be schema-only and
// the model would still receive the raw ${{ … }} text.

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/dbirks/communication/internal/pipelines/runtime"
)

func TestResolveNodeConfigInterpolatesModelChatMessages(t *testing.T) {
	plan := loadPlan(t, "testdata/model_chat_bindings.yaml")
	prog, d := runtime.PreparePlan(plan)
	if !d.Valid() {
		t.Fatalf("PreparePlan: %v", d)
	}
	dv := newDriver(t, plan, map[string]any{"goal": "ship the nightly report"})
	dv.script("/survey", step{outputs: map[string]any{"stdout_preview": "README.md\nmain.go"}})
	dv.script("/plan", step{outputs: map[string]any{"text": "1. read main.go"}})
	dv.pump(30)
	st := dv.state()
	if st.Run.Status != runtime.RunCompleted {
		t.Fatalf("run = %s/%s, want completed (%v)", st.Run.Status, st.Run.FailedCause, eventTypes(st))
	}

	cfg, err := runtime.ResolveNodeConfig(prog, st, st.Node("/plan"))
	if err != nil {
		t.Fatalf("ResolveNodeConfig: %v", err)
	}
	raw, err := json.Marshal(cfg)
	if err != nil {
		t.Fatal(err)
	}
	// § 4 step 14: what the worker is handed carries no expression syntax.
	if strings.Contains(string(raw), "${{") {
		t.Fatalf("resolved config still holds a binding: %s", raw)
	}
	msgs, ok := cfg["messages"].([]any)
	if !ok || len(msgs) != 2 {
		t.Fatalf("config.messages = %#v, want the two authored messages", cfg["messages"])
	}
	first, _ := msgs[0].(map[string]any)
	second, _ := msgs[1].(map[string]any)
	if first["role"] != "system" || first["content"] != "Reply with a numbered plan and nothing else." {
		t.Errorf("messages[0] = %#v, want the literal system prompt untouched", first)
	}
	want := "Goal: ship the nightly report\nFiles: README.md\nmain.go\n"
	if second["role"] != "user" || second["content"] != want {
		t.Errorf("messages[1] = %#v, want content %q", second, want)
	}
	if second["content"] == "Goal: ${{ inputs.goal }}\nFiles: ${{ nodes.survey.outputs.stdout_preview }}\n" {
		t.Error("the model would receive the authored text verbatim — ADR-0029's bug")
	}
	// ADR-0027 rule 5: resolving costs the run's expression budget.
	if st.Run.ExpressionEvaluations == 0 {
		t.Error("claim-time resolution was not counted in runs.expression_evaluations")
	}
	if model, _ := cfg["model"].(string); model != "qwen3-8-flash-next" {
		t.Errorf("config.model = %v", cfg["model"])
	}
}
