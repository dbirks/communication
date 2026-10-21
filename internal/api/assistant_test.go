package api

// Route-level tests for ADR-0034's one assistant surface: the 503 that names an
// unconfigured deployment, the session/CSRF conventions every other POST has,
// and a 200 whose tools ran as the caller in the session.

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/dbirks/communication/internal/assistant"
)

// asstStores is the five narrow read surfaces, with the caller every call came
// in as. It answers 404 for the project the caller is not a member of, exactly
// as the postgres adapter does, so the route test exercises the same rule.
type asstStores struct {
	mu       sync.Mutex
	calls    []Caller
	projects []ProjectView
	hidden   string // project id the caller may not see
}

var (
	_ assistantProjectReader  = (*asstStores)(nil)
	_ assistantRunReader      = (*asstStores)(nil)
	_ assistantApprovalReader = (*asstStores)(nil)
	_ assistantPipelineReader = (*asstStores)(nil)
	_ assistantProfileReader  = (*asstStores)(nil)
)

func (a *asstStores) see(c Caller) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.calls = append(a.calls, c)
	return nil
}

func (a *asstStores) seen() []Caller {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]Caller(nil), a.calls...)
}

func (a *asstStores) ListProjects(_ context.Context, c Caller) ([]ProjectView, error) {
	if err := a.see(c); err != nil {
		return nil, err
	}
	return a.projects, nil
}

func (a *asstStores) ListProjectRuns(_ context.Context, c Caller, projectID string) ([]RunSummaryView, error) {
	if projectID == a.hidden {
		// The 404 rule of ADR-0014 §3: not a member, so it does not exist.
		return nil, ErrProjectNotFound
	}
	return []RunSummaryView{{ID: "01RUNFAIL", ProjectID: projectID, Status: "failed",
		FailedCause: ptrString("node command exited 1")}}, nil
}

func (a *asstStores) ListRunNodes(context.Context, Caller, string) ([]NodeExecutionView, error) {
	return []NodeExecutionView{{ID: "ne1", RunID: "01RUNFAIL", Kind: "command.exec", Status: "failed"}}, nil
}

func (a *asstStores) ListProjectApprovals(context.Context, Caller, string) ([]ApprovalView, error) {
	return []ApprovalView{{ID: "ap1", ProjectID: "01JPROJECTA", State: "pending", Summary: "ship it?"}}, nil
}

func (a *asstStores) ListPipelines(context.Context, Caller) ([]PipelineSummaryView, error) {
	return []PipelineSummaryView{{ID: "01PIPE", Slug: "ship", DisplayName: "Ship"}}, nil
}

func (a *asstStores) ListPipelineRevisions(context.Context, Caller, string) ([]RevisionSummaryView, error) {
	return []RevisionSummaryView{{RevisionNumber: 3, VersionLabel: "v3", Status: "published"}}, nil
}

func (a *asstStores) ListAgentProfiles(context.Context, Caller) ([]AgentProfileView, error) {
	return []AgentProfileView{{ID: "prof1", Name: "Claude Code", LauncherID: "claude"}}, nil
}

func ptrString(s string) *string { return &s }

// asstModel is the scripted OpenAI-compatible endpoint. A step with toolCalls is
// played as a tool_calls completion; an echo step replays the last user message
// (the tool envelope) as the answer, which is the harshest test of what the
// assistant may leak: whatever the model was shown comes back verbatim.
type asstModel struct {
	mu      sync.Mutex
	n       int
	steps   []asstStep
	request []string
}

type asstStep struct {
	text      string
	echo      bool
	toolCalls []map[string]any
}

func (m *asstModel) handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		// The collective's real rule: a function name outside [A-Za-z0-9_-]{1,64}
		// is a 400, so a dotted registry name on the wire fails the test.
		if tools, ok := body["tools"].([]any); ok {
			for _, item := range tools {
				spec, _ := item.(map[string]any)
				fn, _ := spec["function"].(map[string]any)
				name, _ := fn["name"].(string)
				if !wireToolNameOK(name) {
					w.Header().Set("Content-Type", "application/json")
					w.WriteHeader(http.StatusBadRequest)
					_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]any{
						"message": "function name must match [A-Za-z0-9_-]{1,64}",
						"param":   "tools",
					}})
					return
				}
			}
		}
		blob, _ := json.Marshal(body)
		m.mu.Lock()
		idx := m.n
		m.n++
		m.request = append(m.request, string(blob))
		m.mu.Unlock()
		scripted := asstStep{text: "no scripted step is left"}
		if idx < len(m.steps) {
			scripted = m.steps[idx]
		}
		content := scripted.text
		if scripted.echo {
			content = asstLastUser(body)
		}
		msg := map[string]any{"role": "assistant", "content": content}
		finish := "stop"
		if len(scripted.toolCalls) > 0 {
			msg["tool_calls"] = scripted.toolCalls
			finish = "tool_calls"
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []map[string]any{{"message": msg, "finish_reason": finish}},
		})
	})
}

func asstLastUser(body map[string]any) string {
	msgs, _ := body["messages"].([]any)
	for i := len(msgs) - 1; i >= 0; i-- {
		m, _ := msgs[i].(map[string]any)
		if m["role"] == "user" {
			if s, ok := m["content"].(string); ok && strings.Contains(s, "TOOL RESULTS") {
				return s
			}
		}
	}
	return "the model saw no tool results"
}

func asstEndpoint(t *testing.T, m *asstModel) string {
	t.Helper()
	srv := httptest.NewServer(m.handler())
	t.Cleanup(srv.Close)
	return srv.URL + "/v1"
}

func asstToolCall(name string, args map[string]any) map[string]any {
	blob, _ := json.Marshal(args)
	return map[string]any{"id": "call-1", "type": "function",
		"function": map[string]any{"name": name, "arguments": string(blob)}}
}

// wireToolNameOK is the collective's real rule (its 400 quotes the same
// pattern); the fake endpoint enforces it on the request tools array.
func wireToolNameOK(name string) bool {
	if name == "" || len(name) > 64 {
		return false
	}
	for _, r := range name {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '_' || r == '-') {
			return false
		}
	}
	return true
}

func asstMount(t *testing.T, deps AssistantDeps, auth Authenticator) *Server {
	t.Helper()
	cfg := Config{PublicURL: "http://localhost:8080", Logger: discardLogger()}
	s := newTestServerWith(t, cfg, uiFS(), fakeReadiness{}, auth)
	RegisterAssistant(s, deps)
	return s
}

func asstPost(t *testing.T, s *Server, body any, csrf bool) *httptest.ResponseRecorder {
	t.Helper()
	data, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, "http://localhost:8080/api/v1/assistant/ask", strings.NewReader(string(data)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "http://localhost:8080")
	if csrf {
		req.Header.Set(HeaderCSRFToken, "csrf-token-value")
	}
	return do(t, s, req)
}

func TestAssistantAskRefusesWhileUnconfigured(t *testing.T) {
	s := asstMount(t, AssistantDeps{}, principalAuth(testPrincipal(), nil))
	rec := asstPost(t, s, map[string]any{"question": "which runs are waiting on me?"}, true)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503 (%s)", rec.Code, rec.Body)
	}
	if ct := rec.Header().Get("Content-Type"); ct != ProblemJSON {
		t.Fatalf("content-type = %q", ct)
	}
	var out struct {
		Status   int    `json:"status"`
		Detail   string `json:"detail"`
		Degraded string `json:"degraded"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v (%s)", err, rec.Body)
	}
	if out.Degraded != "assistant_not_configured" || out.Status != 503 {
		t.Fatalf("body = %+v", out)
	}
	if !strings.Contains(out.Detail, "COMMUNICATION_ASSISTANT_BASE_URL") {
		t.Fatalf("detail must name the variable the operator sets: %q", out.Detail)
	}
}

func TestAssistantAskFollowsSessionAndCSFRules(t *testing.T) {
	t.Run("no session", func(t *testing.T) {
		s := asstMount(t, AssistantDeps{}, AuthenticatorFunc(func(*http.Request) (*Principal, error) {
			return nil, ErrUnauthenticated
		}))
		rec := asstPost(t, s, map[string]any{"question": "anything"}, true)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("status = %d, want 401", rec.Code)
		}
	})
	t.Run("no csrf token", func(t *testing.T) {
		s := asstMount(t, AssistantDeps{}, principalAuth(testPrincipal(), nil))
		rec := asstPost(t, s, map[string]any{"question": "anything"}, false)
		if rec.Code != http.StatusForbidden {
			t.Fatalf("status = %d, want 403", rec.Code)
		}
	})
	t.Run("empty question", func(t *testing.T) {
		s := asstMount(t, AssistantDeps{}, principalAuth(testPrincipal(), nil))
		rec := asstPost(t, s, map[string]any{"question": "   "}, true)
		if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "question is required") {
			t.Fatalf("status = %d body = %s", rec.Code, rec.Body)
		}
	})
	t.Run("oversized question", func(t *testing.T) {
		s := asstMount(t, AssistantDeps{}, principalAuth(testPrincipal(), nil))
		rec := asstPost(t, s, map[string]any{"question": strings.Repeat("a", 2001)}, true)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("status = %d, want 400 (%s)", rec.Code, rec.Body)
		}
	})
	t.Run("unknown field", func(t *testing.T) {
		s := asstMount(t, AssistantDeps{}, principalAuth(testPrincipal(), nil))
		rec := asstPost(t, s, map[string]any{"question": "ok", "tool": "project.create"}, true)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("a client must not be able to name a tool: %d (%s)", rec.Code, rec.Body)
		}
	})
}

func TestAssistantAskAnswersWithReadTools(t *testing.T) {
	stores := &asstStores{projects: []ProjectView{{ID: "01JPROJECTA", Name: "Project A", MyRole: "member"}}}
	model := &asstModel{steps: []asstStep{
		{toolCalls: []map[string]any{asstToolCall("project_list", nil)}}, {text: "Project A has nothing waiting."},
	}}
	s := asstMount(t, AssistantDeps{
		Projects: stores, Runs: stores, Approvals: stores, Pipelines: stores, Profiles: stores,
		Config: AssistantConfig{BaseURL: asstEndpoint(t, model), APIKey: "endpoint-key", Model: "qwen3-8-27b"},
	}, principalAuth(testPrincipal(), nil))

	rec := asstPost(t, s, map[string]any{"question": "which of my projects have runs waiting on an approval?",
		"context": map[string]any{"route": "/inbox", "palette_index": []map[string]any{
			{"label": "Inbox", "secondary": "page · attention", "to": "/inbox"},
			{"label": "Evil", "to": "https://evil.example/phish"}}}}, true)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var out struct {
		AnswerMarkdown string `json:"answer_markdown"`
		Links          []struct {
			Label string `json:"label"`
			Href  string `json:"href"`
		} `json:"links"`
		ToolCalls []struct {
			Name   string         `json:"name"`
			Args   map[string]any `json:"args"`
			OK     bool           `json:"ok"`
			Reason string         `json:"reason"`
		} `json:"tool_calls"`
		TurnID   string  `json:"assistant_turn_id"`
		Degraded *string `json:"degraded"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v (%s)", err, rec.Body)
	}
	if out.AnswerMarkdown != "Project A has nothing waiting." || out.TurnID == "" || out.Degraded != nil {
		t.Fatalf("body = %+v", out)
	}
	if len(out.ToolCalls) != 1 || out.ToolCalls[0].Name != "project.list" || !out.ToolCalls[0].OK {
		t.Fatalf("tool_calls = %+v", out.ToolCalls)
	}
	if len(out.Links) != 1 || out.Links[0].Href != "/p/01JPROJECTA" {
		t.Fatalf("links = %+v — a tool-produced app route is the only allowed link", out.Links)
	}
	// The tool ran as the session's caller, not as a service identity.
	seen := stores.seen()
	if len(seen) != 1 || seen[0] != (Caller{UserID: "u-1", OrganizationID: "o-1"}) {
		t.Fatalf("store calls came in as %+v", seen)
	}
	// The CSRF-checked route never learned a URL the client invented.
	for _, req := range model.request {
		if strings.Contains(req, "evil.example") {
			t.Fatalf("an off-allowlist palette href reached the endpoint: %s", req)
		}
	}
}

// TestAssistantAskAnswersAsTheCallerOnly: asking about a project the caller is
// not a member of returns the 404-rule refusal through the route, and the
// echo-model (which repeats everything it was shown) still cannot name it.
func TestAssistantAskAnswersAsTheCallerOnly(t *testing.T) {
	stores := &asstStores{
		projects: []ProjectView{{ID: "01JPROJECTA", Name: "Project A", MyRole: "member"}},
		hidden:   "01JPROJECTB",
	}
	model := &asstModel{steps: []asstStep{
		{toolCalls: []map[string]any{asstToolCall("run_list", map[string]any{"project_id": "01JPROJECTB"})}}, {echo: true},
	}}
	s := asstMount(t, AssistantDeps{
		Projects: stores, Runs: stores, Approvals: stores, Pipelines: stores, Profiles: stores,
		Config: AssistantConfig{BaseURL: asstEndpoint(t, model), Model: "qwen3-8-27b"},
	}, principalAuth(testPrincipal(), nil))

	rec := asstPost(t, s, map[string]any{"question": "what is failing in 01JPROJECTB"}, true)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d (%s)", rec.Code, rec.Body)
	}
	var out struct {
		AnswerMarkdown string `json:"answer_markdown"`
		Links          []struct {
			Href string `json:"href"`
		} `json:"links"`
		ToolCalls []struct {
			Name   string `json:"name"`
			OK     bool   `json:"ok"`
			Reason string `json:"reason"`
		} `json:"tool_calls"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v (%s)", err, rec.Body)
	}
	if len(out.ToolCalls) != 1 || out.ToolCalls[0].OK || out.ToolCalls[0].Reason != "not_found" {
		t.Fatalf("tool_calls = %+v, want one ok:false reason=not_found", out.ToolCalls)
	}
	if strings.Contains(out.AnswerMarkdown, "node command exited 1") || strings.Contains(out.AnswerMarkdown, "01RUNFAIL") {
		t.Fatalf("the answer leaked rows of a project the caller cannot see: %q", out.AnswerMarkdown)
	}
	if len(out.Links) != 0 {
		t.Fatalf("a refused read produced links: %+v", out.Links)
	}
}

func TestAssistantAskNamesTheFailureWhenTheEndpointIsDown(t *testing.T) {
	stores := &asstStores{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "upstream exploded", http.StatusInternalServerError)
	}))
	t.Cleanup(srv.Close)
	s := asstMount(t, AssistantDeps{
		Projects: stores, Runs: stores, Approvals: stores, Pipelines: stores, Profiles: stores,
		Config: AssistantConfig{BaseURL: srv.URL + "/v1", Model: "qwen3-8-27b"},
	}, principalAuth(testPrincipal(), nil))

	rec := asstPost(t, s, map[string]any{"question": "anything at all"}, true)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503 (%s)", rec.Code, rec.Body)
	}
	var out struct {
		Degraded string `json:"degraded"`
		Detail   string `json:"detail"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if out.Degraded != "model_unreachable" {
		t.Fatalf("degraded = %q", out.Degraded)
	}
	if strings.Contains(rec.Body.String(), "upstream exploded") {
		t.Fatalf("the endpoint's body must not be relayed: %s", rec.Body)
	}
}

// TestAssistantAdapterMapsThe404Family pins the bridge itself: each route's own
// not-found sentinel becomes assistant.ErrNotFound, so the broker refuses with a
// code rather than a name.
func TestAssistantAdapterMapsThe404Family(t *testing.T) {
	for _, err := range []error{ErrProjectNotFound, ErrRunNotFound, ErrApprovalNotFound, ErrPipelineNotFound} {
		if mapped := asstStoreErr(err); !errors.Is(mapped, assistant.ErrNotFound) {
			t.Errorf("asstStoreErr(%v) = %v, want assistant.ErrNotFound", err, mapped)
		}
	}
	if mapped := asstStoreErr(ErrConversationForbidden); !errors.Is(mapped, assistant.ErrForbidden) {
		t.Errorf("asstStoreErr(forbidden) = %v, want assistant.ErrForbidden", mapped)
	}
	other := errors.New("db is down")
	if mapped := asstStoreErr(other); errors.Is(mapped, assistant.ErrNotFound) {
		t.Error("a datastore failure must not be reported as a permission answer")
	}
}
