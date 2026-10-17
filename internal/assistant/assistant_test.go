package assistant

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"sync"
	"testing"
)

// --- the fake store -------------------------------------------------------

// fakeStore answers the six reads with canned rows and records WHO each call
// was made as, which is how the authz test proves the broker passed the caller
// rather than an admin identity of its own.
type fakeStore struct {
	mu       sync.Mutex
	calls    []string
	callers  []Caller
	byName   map[string]json.RawMessage
	byErr    map[string]error
	projects json.RawMessage
	runs     map[string]json.RawMessage
}

func newFakeStore() *fakeStore {
	return &fakeStore{
		byName: map[string]json.RawMessage{},
		byErr:  map[string]error{},
		runs:   map[string]json.RawMessage{},
	}
}

func (f *fakeStore) ListProjects(_ context.Context, c Caller) (json.RawMessage, error) {
	if err := f.recordRow("project.list", c); err != nil {
		return nil, err
	}
	return rawOr(f.projects), nil
}

func (f *fakeStore) recordRow(name string, c Caller) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, name)
	f.callers = append(f.callers, c)
	return f.byErr[name]
}

func (f *fakeStore) ListPipelines(_ context.Context, c Caller) (json.RawMessage, error) {
	if err := f.recordRow("pipeline.list", c); err != nil {
		return nil, err
	}
	return rawOr(f.byName["pipeline.list"]), nil
}

func (f *fakeStore) ListProjectRuns(_ context.Context, c Caller, projectID string) (json.RawMessage, error) {
	if err := f.recordRow("run.list", c); err != nil {
		return nil, err
	}
	if err := f.byErr["run.list:"+projectID]; err != nil {
		return nil, err
	}
	if rows, ok := f.runs[projectID]; ok {
		return rows, nil
	}
	return rawOr(f.byName["run.list"]), nil
}

func (f *fakeStore) ListRunNodes(_ context.Context, c Caller, _ string) (json.RawMessage, error) {
	if err := f.recordRow("run.nodes", c); err != nil {
		return nil, err
	}
	return rawOr(f.byName["run.nodes"]), nil
}

func (f *fakeStore) ListProjectApprovals(_ context.Context, c Caller, _ string) (json.RawMessage, error) {
	if err := f.recordRow("approval.pending", c); err != nil {
		return nil, err
	}
	return rawOr(f.byName["approval.pending"]), nil
}

func (f *fakeStore) ListPipelineRevisions(_ context.Context, c Caller, _ string) (json.RawMessage, error) {
	if err := f.recordRow("pipeline.revisions", c); err != nil {
		return nil, err
	}
	return rawOr(f.byName["pipeline.revisions"]), nil
}

func (f *fakeStore) ListAgentProfiles(_ context.Context, c Caller) (json.RawMessage, error) {
	if err := f.recordRow("profile.list", c); err != nil {
		return nil, err
	}
	return rawOr(f.byName["profile.list"]), nil
}

func rawOr(v json.RawMessage) json.RawMessage {
	if len(v) == 0 {
		return json.RawMessage(`[]`)
	}
	return v
}

func (f *fakeStore) called(name string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, c := range f.calls {
		if c == name {
			return true
		}
	}
	return false
}

func (f *fakeStore) count(name string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, c := range f.calls {
		if c == name {
			n++
		}
	}
	return n
}

func (f *fakeStore) seenCallers() []Caller {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]Caller(nil), f.callers...)
}

// --- the fake OpenAI-compatible endpoint ----------------------------------

// wireToolNameRe is the collective's real rule (its 400 quotes the same
// pattern); the fake endpoint enforces it so a dotted name leaking onto the
// wire fails the test the way it failed the M4 lab.
var wireToolNameRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// step is one scripted completion. echo replays the last user message back as
// the answer text, which is how the authz test proves what the model was shown.
type step struct {
	text      string
	toolCalls []toolCallRequest
	echo      bool
}

type fakeModel struct {
	mu       sync.Mutex
	steps    []step
	requests []chatRequest
	keys     []string
	server   *httptest.Server
}

func newFakeModel(t *testing.T, steps ...step) *fakeModel {
	t.Helper()
	f := &fakeModel{steps: steps}
	f.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" {
			http.NotFound(w, r)
			return
		}
		var req chatRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Errorf("fake model: request body is not a chat request: %v", err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		// Enforce the collective's real rule: an OpenAI-compatible endpoint
		// answers 400 for a function name outside [A-Za-z0-9_-]{1,64}, so a
		// dotted registry name leaking onto the wire cannot pass unnoticed.
		for _, spec := range req.Tools {
			if !wireToolNameRe.MatchString(spec.Function.Name) {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusBadRequest)
				_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]any{
					"message": "function name must match [A-Za-z0-9_-]{1,64}",
					"param":   "tools",
				}})
				return
			}
		}
		f.mu.Lock()
		f.requests = append(f.requests, req)
		idx := len(f.requests) - 1
		if k := r.Header.Get("Authorization"); k != "" {
			f.keys = append(f.keys, k)
		}
		f.mu.Unlock()
		scripted := step{text: "no scripted step is left"}
		if idx < len(f.steps) {
			scripted = f.steps[idx]
		}
		// A real model echoes back the function names it was announced, i.e. the
		// wire names; encode the scripted registry names the same way so the
		// scripted responses are what the wire would actually carry.
		wireCalls := make([]toolCallRequest, len(scripted.toolCalls))
		copy(wireCalls, scripted.toolCalls)
		for i := range wireCalls {
			wireCalls[i].Function.Name = wireName(wireCalls[i].Function.Name)
		}
		content := scripted.text
		if scripted.echo {
			content = lastUserContent(req)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []map[string]any{{
				"message": map[string]any{
					"role":       "assistant",
					"content":    content,
					"tool_calls": wireCalls,
				},
				"finish_reason": func() string {
					if len(scripted.toolCalls) > 0 {
						return "tool_calls"
					}
					return "stop"
				}(),
			}},
		})
	}))
	t.Cleanup(f.server.Close)
	return f
}

func lastUserContent(req chatRequest) string {
	for i := len(req.Messages) - 1; i >= 0; i-- {
		if req.Messages[i].Role == "user" && req.Messages[i].Content != nil {
			return *req.Messages[i].Content
		}
	}
	return ""
}

func (f *fakeModel) bodyCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.requests)
}

func (f *fakeModel) seen(i int) chatRequest {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.requests[i]
}

func (f *fakeModel) authHeaders() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.keys...)
}

func toolCall(name string, args map[string]any) toolCallRequest {
	blob, _ := json.Marshal(args)
	return toolCallRequest{ID: "call-" + name, Type: "function",
		Function: functionCall{Name: name, Arguments: string(blob)}}
}

func newTestBroker(t *testing.T, model *fakeModel, store Store) *Broker {
	t.Helper()
	b, err := New(Config{BaseURL: model.server.URL + "/v1", APIKey: "test-key-not-a-secret", Model: DefaultModel}, store)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return b
}

var testCaller = Caller{UserID: "user-1", OrganizationID: "org-1"}

// --- tests ----------------------------------------------------------------

func TestAskDirectAnswer(t *testing.T) {
	model := newFakeModel(t, step{text: "**Nothing** is waiting on you."})
	store := newFakeStore()
	b := newTestBroker(t, model, store)

	answer, bad := b.Ask(context.Background(), testCaller, "what needs me today?", QuestionContext{Route: "/inbox"})
	if bad != nil {
		t.Fatalf("Ask failed: %+v", bad)
	}
	if answer.AnswerMarkdown != "**Nothing** is waiting on you." {
		t.Fatalf("answer = %q", answer.AnswerMarkdown)
	}
	if len(answer.ToolCalls) != 0 || len(answer.Links) != 0 {
		t.Fatalf("expected an answer with no tools/links, got %+v / %+v", answer.ToolCalls, answer.Links)
	}
	if answer.TurnID == "" {
		t.Fatal("assistant_turn_id must be present")
	}
	if answer.Degraded != nil {
		t.Fatalf("degraded = %v, want null", *answer.Degraded)
	}
	if store.called("project.list") {
		t.Fatal("a direct answer must not touch the store")
	}
	req := model.seen(0)
	if req.Model != DefaultModel {
		t.Fatalf("model = %q", req.Model)
	}
	if len(req.Tools) != len(toolOrder) {
		t.Fatalf("tools announced = %d, want %d", len(req.Tools), len(toolOrder))
	}
	for _, spec := range req.Tools {
		if strings.Contains(spec.Function.Name, ".create") || strings.Contains(spec.Function.Name, ".publish") {
			t.Fatalf("registry leaked a write tool: %q", spec.Function.Name)
		}
	}
	if req.Messages[0].Role != "system" || !strings.Contains(*req.Messages[0].Content, "READ-ONLY") {
		t.Fatal("the fixed system rules must lead the envelope")
	}
	if !strings.Contains(*req.Messages[1].Content, "what needs me today?") {
		t.Fatal("the question must reach the model")
	}
	if !strings.Contains(*req.Messages[1].Content, "/inbox") {
		t.Fatal("the on-screen route must reach the model as context")
	}
	if got := model.authHeaders(); len(got) != 1 || got[0] != "Bearer test-key-not-a-secret" {
		t.Fatalf("auth headers = %v", got)
	}
}

func TestAskRunsToolWithCallerAndReturnsLinks(t *testing.T) {
	store := newFakeStore()
	store.projects = json.RawMessage(`[{"id":"01JPROJECTA","slug":"alpha","name":"Project A","my_role":"member"},
		{"id":"01JPROJECTB","slug":"beta","name":"Project B","my_role":"member"}]`)
	model := newFakeModel(t,
		step{toolCalls: []toolCallRequest{toolCall("project.list", nil)}},
		step{text: "Project A has 2 runs waiting."})
	b := newTestBroker(t, model, store)

	answer, bad := b.Ask(context.Background(), testCaller, "which of my projects have runs waiting on an approval?", QuestionContext{})
	if bad != nil {
		t.Fatalf("Ask failed: %+v", bad)
	}
	if answer.AnswerMarkdown != "Project A has 2 runs waiting." {
		t.Fatalf("answer = %q", answer.AnswerMarkdown)
	}
	if !store.called("project.list") {
		t.Fatal("project.list never reached the store")
	}
	for _, c := range store.seenCallers() {
		if c != testCaller {
			t.Fatalf("the store was called as %+v, want the caller %+v", c, testCaller)
		}
	}
	if len(answer.ToolCalls) != 1 || answer.ToolCalls[0].Name != "project.list" || !answer.ToolCalls[0].OK {
		t.Fatalf("tool_calls = %+v", answer.ToolCalls)
	}
	want := []string{"/projects/01JPROJECTA", "/projects/01JPROJECTB"}
	if len(answer.Links) != 2 || answer.Links[0].Href != want[0] || answer.Links[1].Href != want[1] {
		t.Fatalf("links = %+v, want %v", answer.Links, want)
	}
	if !strings.Contains(answer.Links[0].Label, "Project A") {
		t.Fatalf("link label = %q", answer.Links[0].Label)
	}
	// The second completion must carry the tool result as a user-role envelope,
	// never as a system message (docs/design/assistant-v1.md § Tools).
	second := model.seen(1)
	if len(second.Messages) < 3 {
		t.Fatalf("second request carried %d messages", len(second.Messages))
	}
	var result string
	for _, m := range second.Messages {
		if m.Role == "user" && strings.Contains(deref(m.Content), "TOOL RESULTS") {
			result = deref(m.Content)
		}
	}
	if result == "" {
		t.Fatalf("no user-role tool envelope in %+v", second.Messages)
	}
	if !strings.Contains(result, "01JPROJECTA") || !strings.Contains(result, "Project A") {
		t.Fatalf("tool payload did not reach the model: %q", result)
	}
	for _, m := range second.Messages {
		if m.Role == "system" && strings.Contains(deref(m.Content), "01JPROJECTA") {
			t.Fatal("tool output must never be sent as a system message")
		}
	}
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// TestAskToolNameRoundTripsOnTheWire is the M4-lab regression: the request
// tools array carries the legal wire name (project_list), the model's
// project_list call executes the dotted registry tool project.list, and the
// answer's audit record names project.list — the dotted name never reaches the
// wire, and the wire name never reaches the answer.
func TestAskToolNameRoundTripsOnTheWire(t *testing.T) {
	store := newFakeStore()
	store.projects = json.RawMessage(`[{"id":"01JPROJECTA","slug":"alpha","name":"Project A","my_role":"member"}]`)
	// The model answers with the name it was announced with — the wire name,
	// exactly as the collective does.
	model := newFakeModel(t,
		step{toolCalls: []toolCallRequest{toolCall("project_list", nil)}},
		step{text: "Project A has one run."})
	b := newTestBroker(t, model, store)

	answer, bad := b.Ask(context.Background(), testCaller, "list my projects", QuestionContext{})
	if bad != nil {
		t.Fatalf("Ask failed: %+v", bad)
	}
	sawProjectList, sawDotted := false, false
	for _, spec := range model.seen(0).Tools {
		if spec.Function.Name == "project_list" {
			sawProjectList = true
		}
		if strings.ContainsRune(spec.Function.Name, '.') {
			sawDotted = true
		}
	}
	if !sawProjectList {
		t.Fatalf("request tools carry no project_list")
	}
	if sawDotted {
		t.Fatalf("request tools carry a dotted registry name")
	}
	if !store.called("project.list") {
		t.Fatal("the model's project_list call did not execute project.list")
	}
	if len(answer.ToolCalls) != 1 || answer.ToolCalls[0].Name != "project.list" || !answer.ToolCalls[0].OK {
		t.Fatalf("answer must name project.list: %+v", answer.ToolCalls)
	}
}

// TestAskNonMemberLearnsNothingAboutProjectB is ADR-0034's Verification case:
// the ID-scoped tool answers the 404 rule, the refusal carries no rows and no
// name, and an echo-model that repeats whatever it was shown still cannot
// produce B's name.
func TestAskNonMemberLearnsNothingAboutProjectB(t *testing.T) {
	store := newFakeStore()
	store.projects = json.RawMessage(`[{"id":"01JPROJECTA","name":"Project A","my_role":"member"}]`)
	store.byErr["run.list:01JPROJECTB"] = ErrNotFound
	model := newFakeModel(t,
		step{toolCalls: []toolCallRequest{toolCall("run.list", map[string]any{"project_id": "01JPROJECTB"})}},
		step{echo: true})
	b := newTestBroker(t, model, store)

	answer, bad := b.Ask(context.Background(), testCaller, "what is failing in Project B?", QuestionContext{})
	if bad != nil {
		t.Fatalf("Ask failed: %+v", bad)
	}
	if len(answer.ToolCalls) != 1 || answer.ToolCalls[0].OK || answer.ToolCalls[0].Reason != "not_found" {
		t.Fatalf("tool_calls = %+v, want one ok:false reason=not_found", answer.ToolCalls)
	}
	if strings.Contains(answer.AnswerMarkdown, "Project B") {
		t.Fatalf("the answer named a project the caller cannot see: %q", answer.AnswerMarkdown)
	}
	// The caller typed B's name, so request 0 legitimately contains it; the rule
	// under test is that no B-scoped TOOL RESULT ever reaches the endpoint.
	for i := 1; i < model.bodyCount(); i++ {
		envelope := ""
		for _, m := range model.seen(i).Messages {
			if m.Role == "user" && strings.Contains(deref(m.Content), "TOOL RESULTS") {
				envelope = deref(m.Content)
			}
		}
		if envelope == "" {
			t.Fatalf("egress request %d carries no tool envelope", i)
		}
		if strings.Contains(envelope, "Project B") || strings.Contains(envelope, "01JPROJECTB") {
			t.Fatalf("the endpoint saw a B-scoped tool result: %q", envelope)
		}
	}
	if len(answer.Links) != 0 {
		t.Fatalf("a refused tool produced links: %+v", answer.Links)
	}
}

// TestAskRefusesToolsOutsideTheRegistry: a write or an unknown name is refused
// with ok:false and zero store calls (docs/design/assistant-v1.md § Test plan).
func TestAskRefusesToolsOutsideTheRegistry(t *testing.T) {
	store := newFakeStore()
	model := newFakeModel(t,
		step{toolCalls: []toolCallRequest{
			toolCall("pipeline.publish", nil),
			toolCall("secret.list", nil),
			toolCall("approval.decide", map[string]any{"approval_id": "01A"}),
			toolCall("project.list", map[string]any{"nope": "x"}),
		}},
		step{text: "I cannot do that."})
	b := newTestBroker(t, model, store)

	answer, bad := b.Ask(context.Background(), testCaller, "publish my pipeline", QuestionContext{})
	if bad != nil {
		t.Fatalf("Ask failed: %+v", bad)
	}
	// Known tools decode back to the dotted registry name; unknown names are
	// refused and recorded exactly as the model sent them — the wire names.
	want := map[string]string{"pipeline_publish": "write_not_allowed", "secret_list": "unknown_tool",
		"approval_decide": "write_not_allowed", "project.list": "bad_arguments"}
	if len(answer.ToolCalls) != len(want) {
		t.Fatalf("tool_calls = %+v", answer.ToolCalls)
	}
	for _, call := range answer.ToolCalls {
		if want[call.Name] != call.Reason || call.OK {
			t.Fatalf("call %+v, want ok:false reason=%q", call, want[call.Name])
		}
	}
	if store.count("project.list") != 0 {
		t.Fatal("a call refused on its arguments must not reach the store")
	}
}

func TestAskCaps(t *testing.T) {
	t.Run("completion cap", func(t *testing.T) {
		store := newFakeStore()
		store.projects = json.RawMessage(`[{"id":"01JPROJECTA","name":"Project A"}]`)
		round := step{toolCalls: []toolCallRequest{toolCall("project.list", nil)}}
		model := newFakeModel(t, round, round, round, round, round)
		b := newTestBroker(t, model, store)

		_, bad := b.Ask(context.Background(), testCaller, "and again?", QuestionContext{})
		if bad == nil || bad.Code != FailCallCap {
			t.Fatalf("bad = %+v, want %s", bad, FailCallCap)
		}
		if model.bodyCount() != MaxModelCalls {
			t.Fatalf("completions = %d, want the cap %d", model.bodyCount(), MaxModelCalls)
		}
	})
	t.Run("tool cap", func(t *testing.T) {
		store := newFakeStore()
		store.projects = json.RawMessage(`[{"id":"01JPROJECTA","name":"Project A"}]`)
		var many []toolCallRequest
		for i := 0; i < MaxToolCalls+2; i++ {
			many = append(many, toolCall("project.list", nil))
		}
		model := newFakeModel(t, step{toolCalls: many}, step{text: "one project"})
		b := newTestBroker(t, model, store)

		answer, bad := b.Ask(context.Background(), testCaller, "list", QuestionContext{})
		if bad != nil {
			t.Fatalf("Ask failed: %+v", bad)
		}
		if got := store.count("project.list"); got != MaxToolCalls {
			t.Fatalf("store calls = %d, want the cap %d", got, MaxToolCalls)
		}
		refused := 0
		for _, call := range answer.ToolCalls {
			if call.Reason == "tool_cap_exceeded" {
				refused++
			}
		}
		if refused != 2 {
			t.Fatalf("expected 2 cap refusals, got %+v", answer.ToolCalls)
		}
	})
}

func TestAskRefusesSecretShapedPromptBeforeSend(t *testing.T) {
	store := newFakeStore()
	model := newFakeModel(t, step{text: "ok"})
	b := newTestBroker(t, model, store)

	_, bad := b.Ask(context.Background(), testCaller,
		"why did the run fail? my token is sk-abcdefghijklmnopqrstuvwxyz012345", QuestionContext{})
	if bad == nil || bad.Code != "secret_in_request" {
		t.Fatalf("bad = %+v, want secret_in_request", bad)
	}
	if model.bodyCount() != 0 {
		t.Fatalf("the refusal must send nothing, saw %d requests", model.bodyCount())
	}
}

func TestAllowedHrefDropsLinksOutsideTheAppRoutes(t *testing.T) {
	b := &Broker{}
	good := []string{"/", "/login", "/inbox", "/library", "/library/01PIPELINE", "/agents", "/ops",
		"/projects/01P", "/projects/01P/artifacts", "/projects/01P/runs", "/projects/01P/runs/01R",
		"/projects/01P/pipelines", "/projects/01P/settings",
		"/projects/01P/conversations", "/projects/01P/conversations/01C", "/artifacts/01A"}
	for _, href := range good {
		if _, ok := b.allowedHref(href); !ok {
			t.Errorf("allowed route rejected: %q", href)
		}
	}
	bad := []string{"", "https://evil.example/x", "//evil.example/x", "/x", "/schedules", "/api/v1/projects",
		"/projects/01P/../01Q", "/projects/01P/runs/01R?next=evil", "/projects/01P#frag",
		"/projects/01P/approvals", "/projects/01P/runs/01R/extra", "/projects", "/evil",
		"/projects/01P/settings/deep"}
	for _, href := range bad {
		if _, ok := b.allowedHref(href); ok {
			t.Errorf("off-allowlist href accepted: %q", href)
		}
	}
}

func TestNewRequiresAnEndpoint(t *testing.T) {
	if _, err := New(Config{}, newFakeStore()); !errors.Is(err, ErrNotConfigured) {
		t.Fatalf("New with no base URL = %v, want ErrNotConfigured", err)
	}
	if _, err := New(Config{BaseURL: "api.example.com/v1"}, newFakeStore()); err == nil {
		t.Fatal("a schemeless base URL must be refused, not carried to the first request")
	}
	if _, err := New(Config{BaseURL: "https://x@example.com/v1"}, newFakeStore()); err == nil {
		t.Fatal("credentials in the URL must be refused")
	}
}

// TestPaletteSearchReadsTheCallersOwnIndex proves the sixth tool actually fans
// (and that a client-supplied entry with an off-allowlist href contributes
// nothing, so the palette cannot be used to smuggle a URL into the prompt).
func TestPaletteSearchReadsTheCallersOwnIndex(t *testing.T) {
	store := newFakeStore()
	store.projects = json.RawMessage(`[{"id":"01JPROJECTA","name":"Project A","my_role":"member"}]`)
	store.byName["pipeline.list"] = json.RawMessage(`[{"id":"01PIPE","slug":"nightly","display_name":"Nightly"}]`)
	store.byName["profile.list"] = json.RawMessage(`[{"id":"prof1","name":"Claude Code","launcher_id":"claude"}]`)
	store.runs["01JPROJECTA"] = json.RawMessage(`[{"id":"01RUN1","project_id":"01JPROJECTA","status":"failed"}]`)
	model := newFakeModel(t,
		step{toolCalls: []toolCallRequest{toolCall("palette.search", map[string]any{"needle": "night"})}},
		step{echo: true})
	b := newTestBroker(t, model, store)

	answer, bad := b.Ask(context.Background(), testCaller, "where is nightly?", QuestionContext{
		Palette: []PaletteEntry{{Label: "Inbox", Secondary: "page", To: "/inbox"},
			{Label: "Phish", Secondary: "page", To: "https://evil.example/night"}}})
	if bad != nil {
		t.Fatalf("Ask failed: %+v", bad)
	}
	for _, want := range []string{"pipeline.list", "profile.list", "run.list", "project.list"} {
		if !store.called(want) {
			t.Errorf("palette.search never read %s", want)
		}
	}
	if len(answer.ToolCalls) != 1 || !answer.ToolCalls[0].OK {
		t.Fatalf("tool_calls = %+v", answer.ToolCalls)
	}
	if len(answer.Links) != 1 || answer.Links[0].Href != "/library/01PIPE" {
		t.Fatalf("links = %+v, want the one app route the hit justified", answer.Links)
	}
	envelope := ""
	for _, m := range model.seen(1).Messages {
		if strings.Contains(deref(m.Content), "TOOL RESULTS") {
			envelope = deref(m.Content)
		}
	}
	if !strings.Contains(envelope, "nightly") {
		t.Fatalf("the match did not reach the model: %q", envelope)
	}
	if strings.Contains(envelope, "evil.example") || strings.Contains(envelope, "Phish") {
		t.Fatalf("an off-allowlist palette entry reached the endpoint: %q", envelope)
	}
}

// TestCapPayloadMarksTheCut: the ≤64 item / ≤2 KB rule must tell the model it
// cut, or the model answers "there are no others".
func TestCapPayloadMarksTheCut(t *testing.T) {
	var sb strings.Builder
	sb.WriteString("[")
	for i := 0; i < 400; i++ {
		if i > 0 {
			sb.WriteString(",")
		}
		sb.WriteString(`{"id":"01RUN` + strings.Repeat("x", 40) + fmt.Sprint(i) + `","summary":"a run with a long summary line to make the payload exceed two kilobytes"}`)
	}
	sb.WriteString("]")
	payload, truncated := capPayload(json.RawMessage(sb.String()))
	if !truncated {
		t.Fatal("a 60 KB result must be reported as truncated")
	}
	if len(payload) > MaxResultBytes {
		t.Fatalf("payload is %d bytes, over the %d byte cap", len(payload), MaxResultBytes)
	}
	if !strings.Contains(string(payload), `"truncated":true`) {
		t.Fatalf("the cut was not marked: %s", payload)
	}
	small, truncated := capPayload(json.RawMessage(`[{"id":"a"}]`))
	if truncated || string(small) != `[{"id":"a"}]` {
		t.Fatalf("a small result was rewritten: %s %v", small, truncated)
	}
}
