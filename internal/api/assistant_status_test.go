package api

// Assistant handoff §2 (CONTRACT §1): the setup read. These tests pin the
// route's shape against the contract object, the rule that no value can
// appear, per-caller visibility, the honest `configured: false` of an
// endpoint nobody set, and the tool's registration rule (announced only when
// a StatusReader is wired). The real-PostgreSQL fan-out behind the same reads
// is the store suite's job on GitHub Actions; here the stores are fakes that
// answer with the caller in hand.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	as "github.com/dbirks/communication/internal/assistant"
)

// --- the caller-scoped fakes ----------------------------------------------

// statusStore is one fake world for the status read: projects, their
// repositories and secrets, the pipeline library and the assignments, all
// answered per caller so visibility is a property of the fixture rather than
// a claim in a comment.
type statusStore struct {
	mu sync.Mutex
	// visible projects by user id.
	visible map[string][]ProjectView
	repos   map[string][]RepositoryView
	// secrets by project id.
	secrets map[string][]SecretView
	// pipelines by user id (org visibility differs per caller here).
	pipelines map[string][]PipelineSummaryView
	// assignments by project id.
	assignments map[string][]AssignmentView
	calls       []string
	err         error
}

func newStatusStore() *statusStore {
	return &statusStore{
		visible:     map[string][]ProjectView{},
		repos:       map[string][]RepositoryView{},
		secrets:     map[string][]SecretView{},
		pipelines:   map[string][]PipelineSummaryView{},
		assignments: map[string][]AssignmentView{},
	}
}

func (f *statusStore) note(name string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, name)
}

func (f *statusStore) ListProjects(_ context.Context, c Caller) ([]ProjectView, error) {
	f.note("projects")
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.err != nil {
		return nil, f.err
	}
	return append([]ProjectView{}, f.visible[c.UserID]...), nil
}

func (f *statusStore) ListRepositories(_ context.Context, c Caller, projectID string) ([]RepositoryView, error) {
	f.note("repos:" + projectID)
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.seesProject(c, projectID) {
		return nil, ErrProjectNotFound
	}
	return append([]RepositoryView{}, f.repos[projectID]...), nil
}

func (f *statusStore) ListSecrets(_ context.Context, c Caller, projectID string) ([]SecretView, error) {
	f.note("secrets:" + projectID)
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.seesProject(c, projectID) {
		return nil, ErrProjectNotFound
	}
	return append([]SecretView{}, f.secrets[projectID]...), nil
}

func (f *statusStore) ListPipelines(_ context.Context, c Caller) ([]PipelineSummaryView, error) {
	f.note("pipelines")
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]PipelineSummaryView{}, f.pipelines[c.UserID]...), nil
}

func (f *statusStore) ListAssignments(_ context.Context, c Caller, projectID string, _ AssignmentListFilter) ([]AssignmentView, error) {
	f.note("assignments:" + projectID)
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.seesProject(c, projectID) {
		return nil, ErrProjectNotFound
	}
	return append([]AssignmentView{}, f.assignments[projectID]...), nil
}

func (f *statusStore) seesProject(c Caller, projectID string) bool {
	for _, p := range f.visible[c.UserID] {
		if p.ID == projectID {
			return true
		}
	}
	return false
}

// statusWorkers is the worker registry + the fleet's registered sandbox
// state, both the reads GET /api/v1/workers and GET /api/v1/system/sandbox
// already serve.
type statusWorkers struct {
	mu         sync.Mutex
	workers    []WorkerView
	sandbox    []WorkerSandboxStatusView
	sandboxErr error
}

func (f *statusWorkers) ListWorkers(context.Context) ([]WorkerView, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]WorkerView{}, f.workers...), nil
}

func (f *statusWorkers) ListWorkerSandbox(context.Context) ([]WorkerSandboxStatusView, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.sandboxErr != nil {
		return nil, f.sandboxErr
	}
	return append([]WorkerSandboxStatusView{}, f.sandbox...), nil
}

// --- the fixture world -----------------------------------------------------

const (
	statusSpeechKey   = "sk-SPEECH-SECRET-DO-NOT-ECHO"
	statusSpeechHost  = "llm-collective.example.com"
	statusDecisionURL = "http://decision.internal:8000/v1"
)

// statusFixture is one server with the whole status surface wired, reading as
// one user. A nil worker face is the deployment that has no registry.
func statusFixture(t *testing.T, store *statusStore, workers assistantStatusWorkers,
	sandbox assistantStatusSandbox, models AssistantStatusModels, chat AssistantConfig,
	userID string) *Server {
	t.Helper()
	svc := NewSystemStatus(AssistantStatusDeps{
		Chat:        chat,
		Models:      models,
		Workers:     workers,
		Sandbox:     sandbox,
		Projects:    store,
		Repos:       store,
		Secrets:     store,
		Pipelines:   store,
		Assignments: store,
		// The fixture is a `communication serve` replica (F-6): the API process
		// and the worker are separate, so the status object must not claim the
		// work ran here. The dev reading is its own test below.
		ProcessArgs: []string{"/usr/bin/communication", "serve"},
	})
	s := newTestServerWith(t,
		Config{ReplicaName: "replica-a", Version: "1.2.3", PublicURL: "http://localhost:8080"},
		nil, fakeReadiness{expected: 1},
		principalAuth(&Principal{UserID: userID, OrganizationID: "o-1", DisplayName: userID,
			CSRFToken: prjCSRF}, nil))
	RegisterAssistantStatus(s, svc)
	return s
}

func statusGet(t *testing.T, srv *Server) *httptest.ResponseRecorder {
	t.Helper()
	return convGet(t, srv, "http://localhost:8080/api/v1/assistant/status")
}

// --- the route ------------------------------------------------------------

// TestAssistantStatusRouteShape pins the §1 object: the exact top-level field
// set, and that no secret material appears anywhere in the body even though
// the deployment under test has a speech key and credentialed URLs.
func TestAssistantStatusRouteShape(t *testing.T) {
	t.Parallel()
	store := newStatusStore()
	store.visible["u-1"] = []ProjectView{{ID: "p-1", Slug: "home-lab", Name: "Home Lab"}}
	store.secrets["p-1"] = []SecretView{
		{ID: "s-1", Slug: "GITHUB_TOKEN", Scope: "org", Purpose: "github_repo", Delivery: "integration_broker"},
		{ID: "s-2", Slug: "DEPLOY_KEY", Scope: "project", Purpose: "releases", Delivery: "env_file"},
	}
	store.repos["p-1"] = []RepositoryView{
		{ID: "r-1", ProjectID: "p-1", Name: "api", CredentialSecretID: ptr("s-1")},
		{ID: "r-2", ProjectID: "p-1", Name: "web"},
	}
	store.pipelines["u-1"] = []PipelineSummaryView{
		{ID: "w-1", Slug: "issue-to-pr"}, {ID: "w-2", Slug: "security-review"}, {ID: "w-3", Slug: "mine"},
	}
	store.assignments["p-1"] = []AssignmentView{{ID: "a-1", ProjectID: "p-1", PipelineID: "w-1"}}
	workers := &statusWorkers{
		workers: []WorkerView{{ID: "01", Name: "worker-a", Status: "online"},
			{ID: "02", Name: "worker-b", Status: "offline"}},
		sandbox: []WorkerSandboxStatusView{{WorkerID: "01", Enforcement: "required"},
			{WorkerID: "02", Enforcement: "disabled"}},
	}
	srv := statusFixture(t, store, workers, workers,
		AssistantStatusModels{
			SpeechBaseURL:   "https://user:" + statusSpeechKey + "@" + statusSpeechHost + "/v1",
			SpeechModel:     "qwen3-asr-1-7b",
			SpeechAPIKey:    statusSpeechKey,
			DecisionBaseURL: statusDecisionURL,
			DecisionModel:   "",
		},
		AssistantConfig{BaseURL: "http://chat.internal:8000/v1", APIKey: "sk-CHAT-SECRET", Model: "qwen3-8-flash-next"},
		"u-1")

	rec := statusGet(t, srv)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	body := rec.Body.String()

	// No secret value, and no URL that could carry one, anywhere in the body.
	for _, leak := range []string{statusSpeechKey, "sk-CHAT-SECRET", "user:", statusDecisionURL,
		"http://chat.internal", "://"} {
		if strings.Contains(body, leak) {
			t.Errorf("body leaked %q: %s", leak, body)
		}
	}

	view := decodeBody(t, rec)
	fields := prjFields(t, secMarshal(t, view))
	want := []string{"chat_model", "decision_model", "execution_mode", "github_credentials",
		"projects", "speech_model", "workers", "workflows"}
	if got := strings.Join(fields, ","); got != strings.Join(want, ",") {
		t.Errorf("status fields = %v, want %v", got, want)
	}
	chat := view["chat_model"].(map[string]any)
	if chat["configured"] != true || chat["model"] != "qwen3-8-flash-next" {
		t.Errorf("chat_model = %v, want configured qwen3-8-flash-next", chat)
	}
	// F-6: the chat row carries the same two facts speech and decision do, so
	// "which models are configured?" can name the endpoint it is talking to
	// without hedging — a bare host, and a bool about the key.
	if chat["endpoint_host"] != "chat.internal" {
		t.Errorf("chat_model.endpoint_host = %v, want chat.internal", chat["endpoint_host"])
	}
	if chat["key_set"] != true {
		t.Errorf("chat_model.key_set = %v, want true (an API key is configured)", chat["key_set"])
	}
	speech := view["speech_model"].(map[string]any)
	if speech["configured"] != true || speech["endpoint_host"] != statusSpeechHost || speech["key_set"] != true {
		t.Errorf("speech_model = %v, want configured host %s key_set true", speech, statusSpeechHost)
	}
	// The judge names no model: base URL alone is not configured (CONTRACT §3).
	decision := view["decision_model"].(map[string]any)
	if decision["configured"] != false || decision["model"] != "" {
		t.Errorf("decision_model = %v, want configured:false with no model id", decision)
	}
	// Weakest mode wins: the offline worker's `disabled` is not folded in.
	wk := view["workers"].(map[string]any)
	if wk["online"] != float64(1) || wk["sandbox_mode"] != "required" {
		t.Errorf("workers = %v, want 1 online / required", wk)
	}
	if view["execution_mode"] != "worker" {
		t.Errorf("execution_mode = %v, want worker on a serve-only replica (F-6)", view["execution_mode"])
	}
	creds, _ := view["github_credentials"].([]any)
	if len(creds) != 1 {
		t.Fatalf("github_credentials = %v, want the one broker secret", view["github_credentials"])
	}
	row := creds[0].(map[string]any)
	if row["name"] != "GITHUB_TOKEN" || row["scope"] != "org" || row["used_by"] != float64(1) {
		t.Errorf("credential row = %v, want GITHUB_TOKEN/org used_by 1", row)
	}
	if got := view["projects"].(map[string]any)["count"]; got != float64(1) {
		t.Errorf("projects.count = %v, want 1", got)
	}
	wf := view["workflows"].(map[string]any)
	if wf["count"] != float64(3) || wf["samples"] != float64(2) || wf["assigned"] != float64(1) {
		t.Errorf("workflows = %v, want count 3 samples 2 assigned 1", wf)
	}
}

// TestAssistantStatusEmptyArrays: an organization with nothing configured
// still answers an iterable object, not a hole.
func TestAssistantStatusEmptyArrays(t *testing.T) {
	t.Parallel()
	store := newStatusStore()
	srv := statusFixture(t, store, nil, nil, AssistantStatusModels{}, AssistantConfig{}, "nobody")
	rec := statusGet(t, srv)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	view := decodeBody(t, rec)
	creds, ok := view["github_credentials"].([]any)
	if !ok || creds == nil || len(creds) != 0 {
		t.Errorf("github_credentials = %v, want []", view["github_credentials"])
	}
	// Every unconfigured model row says configured:false with an empty model id,
	// and carries neither endpoint_host nor key_set (CONTRACT §1's example).
	for _, name := range []string{"chat_model", "speech_model", "decision_model"} {
		row, ok := view[name].(map[string]any)
		if !ok {
			t.Fatalf("%s = %v, want an object", name, view[name])
		}
		if row["configured"] != false || row["model"] != "" {
			t.Errorf("%s = %v, want configured:false model \"\"", name, row)
		}
		if _, ok := row["endpoint_host"]; ok {
			t.Errorf("%s carried endpoint_host while unconfigured: %v", name, row)
		}
	}
	if view["workers"].(map[string]any)["sandbox_mode"] != "unknown" {
		t.Errorf("workers = %v, want unknown with no fleet report", view["workers"])
	}
}

// TestAssistantStatusIsCallersOwn: two callers in one organization see
// different counts, because every read is theirs and not the server's.
func TestAssistantStatusIsCallersOwn(t *testing.T) {
	t.Parallel()
	store := newStatusStore()
	store.visible["insider"] = []ProjectView{{ID: "p-1"}, {ID: "p-2"}}
	store.visible["visitor"] = []ProjectView{{ID: "p-2"}}
	store.secrets["p-1"] = []SecretView{{ID: "s-1", Slug: "ORG_TOKEN", Scope: "org", Delivery: "integration_broker"}}
	store.secrets["p-2"] = []SecretView{
		{ID: "s-1", Slug: "ORG_TOKEN", Scope: "org", Delivery: "integration_broker"},
		{ID: "s-2", Slug: "P2_TOKEN", Scope: "project", Delivery: "integration_broker"},
	}
	store.repos["p-1"] = []RepositoryView{{ID: "r-1", CredentialSecretID: ptr("s-1")}}
	store.pipelines["insider"] = []PipelineSummaryView{{ID: "w-1", Slug: "issue-to-pr"}, {ID: "w-2", Slug: "mine"}}
	store.pipelines["visitor"] = []PipelineSummaryView{{ID: "w-2", Slug: "mine"}}
	store.assignments["p-1"] = []AssignmentView{{ID: "a-1", ProjectID: "p-1", PipelineID: "w-1"}}
	store.assignments["p-2"] = []AssignmentView{{ID: "a-2", ProjectID: "p-2", PipelineID: "w-1"}}

	inner := decodeBody(t, statusGet(t, statusFixture(t, store, nil, nil,
		AssistantStatusModels{}, AssistantConfig{}, "insider")))
	outer := decodeBody(t, statusGet(t, statusFixture(t, store, nil, nil,
		AssistantStatusModels{}, AssistantConfig{}, "visitor")))

	if inner["projects"].(map[string]any)["count"] != float64(2) {
		t.Errorf("insider projects = %v, want 2", inner["projects"])
	}
	if outer["projects"].(map[string]any)["count"] != float64(1) {
		t.Errorf("visitor projects = %v, want 1", outer["projects"])
	}
	// The org secret appears once per caller, never once per project.
	in, out := inner["github_credentials"].([]any), outer["github_credentials"].([]any)
	if len(in) != 2 || len(out) != 2 {
		t.Fatalf("credentials = %v / %v, want 2 each (org + p-2's)", inner["github_credentials"], outer["github_credentials"])
	}
	for _, row := range out {
		r := row.(map[string]any)
		if r["name"] == "P2_TOKEN" && r["used_by"] != float64(0) {
			t.Errorf("visitor saw %v", r)
		}
	}
	// A workflow assigned in a project the visitor cannot see is not in their
	// assigned count: the visitor's own assignments only.
	if inner["workflows"].(map[string]any)["assigned"] != float64(1) {
		t.Errorf("insider workflows = %v, want assigned 1", inner["workflows"])
	}
	if outer["workflows"].(map[string]any)["assigned"] != float64(1) {
		t.Errorf("visitor workflows = %v, want assigned 1 (its own pin)", outer["workflows"])
	}
	if outer["workflows"].(map[string]any)["samples"] != float64(0) {
		t.Errorf("visitor samples = %v, want 0 (the sample is not in their list)", outer["workflows"])
	}
}

// TestAssistantStatusUnauthenticated: an anonymous caller gets 401, not the
// organization's shape of itself.
func TestAssistantStatusUnauthenticated(t *testing.T) {
	t.Parallel()
	svc := NewSystemStatus(AssistantStatusDeps{Projects: newStatusStore()})
	s := newTestServerWith(t,
		Config{ReplicaName: "replica-a", Version: "1.2.3", PublicURL: "http://localhost:8080"},
		nil, fakeReadiness{expected: 1}, AuthenticatorFunc(func(*http.Request) (*Principal, error) {
			return nil, ErrUnauthenticated
		}))
	RegisterAssistantStatus(s, svc)
	rec := convGet(t, s, "http://localhost:8080/api/v1/assistant/status")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401 (%s)", rec.Code, rec.Body)
	}
}

// --- the tool --------------------------------------------------------------

// statusToolModel is the scripted endpoint with a memory: it records the tool
// names each request announces, which is the only honest place to test
// "registered only when wired" from (the announced set is the request).
type statusToolModel struct {
	mu     sync.Mutex
	seen   [][]string
	steps  []wiringStep
	served int
}

func newStatusToolModel(t *testing.T, steps ...wiringStep) (*httptest.Server, *statusToolModel) {
	t.Helper()
	f := &statusToolModel{steps: steps}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" {
			http.NotFound(w, r)
			return
		}
		var body struct {
			Tools []struct {
				Function struct {
					Name string `json:"name"`
				} `json:"function"`
			} `json:"tools"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		names := make([]string, 0, len(body.Tools))
		for _, tool := range body.Tools {
			names = append(names, tool.Function.Name)
		}
		f.mu.Lock()
		idx := f.served
		f.served++
		f.seen = append(f.seen, names)
		f.mu.Unlock()
		step := wiringStep{text: "no scripted step is left"}
		if idx < len(f.steps) {
			step = f.steps[idx]
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []map[string]any{{
			"message": step.wireMessage(), "finish_reason": "stop",
		}}})
	}))
	t.Cleanup(srv.Close)
	return srv, f
}

func (f *statusToolModel) announced(idx int) []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	if idx >= len(f.seen) {
		return nil
	}
	return append([]string{}, f.seen[idx]...)
}

// statusRunner wires a runner over the scripted endpoint, with or without the
// status face — the two states the honest-degradation rule distinguishes.
func statusRunner(t *testing.T, model *httptest.Server, reader as.StatusReader) *as.ConversationRunner {
	t.Helper()
	b, err := as.New(as.Config{BaseURL: model.URL + "/v1", Model: "status-model"}, &wiringReadStore{})
	if err != nil {
		t.Fatalf("broker: %v", err)
	}
	return as.NewConversationRunner(as.ConversationRunnerDeps{Broker: b, Status: reader})
}

func statusTurn(t *testing.T, r *as.ConversationRunner) *as.TurnResult {
	t.Helper()
	res, f := r.RunTurn(context.Background(), as.TurnRequest{
		Caller: as.Caller{UserID: "u-1", OrganizationID: "o-1"}, Text: "is this set up?",
		TrustLevel: as.TrustAskRisky,
	})
	if f != nil {
		t.Fatalf("RunTurn: code=%s detail=%s", f.Code, f.Detail)
	}
	return res
}

func named(names []string, want string) bool {
	for _, n := range names {
		if n == want {
			return true
		}
	}
	return false
}

// TestAssistantStatusToolAnnouncedOnlyWhenWired: system.status joins the
// announced tool set when a StatusReader is wired and stays out when it is
// not, so the model is never told about a setup read this server cannot
// answer.
func TestAssistantStatusToolAnnouncedOnlyWhenWired(t *testing.T) {
	t.Parallel()
	store := newStatusStore()
	store.visible["u-1"] = []ProjectView{{ID: "p-1"}}
	reader := NewAssistantStatusReader(NewSystemStatus(AssistantStatusDeps{
		Chat:     AssistantConfig{BaseURL: "http://chat.internal/v1", Model: "m"},
		Projects: store,
	}))

	wired, modelWired := newStatusToolModel(t, wiringStep{text: "One worker, chat model set."})
	if got := statusTurn(t, statusRunner(t, wired, reader)); len(got.Answer.ToolCalls) != 0 {
		t.Fatalf("tool calls = %v, want none", got.Answer.ToolCalls)
	}
	if !named(modelWired.announced(0), "system_status") {
		t.Errorf("wired runner did not announce system_status: %v", modelWired.announced(0))
	}

	// And when the model does call it, it runs: the read is a ClassRead, so
	// no trust level gates it.
	runModel, _ := newStatusToolModel(t,
		wiringStep{calls: []wiringWireCall{{name: "system_status", arguments: `{}`}}},
		wiringStep{text: "One project, three workflows."},
	)
	res := statusTurn(t, statusRunner(t, runModel, reader))
	calls := res.Answer.ToolCalls
	if len(calls) != 1 || calls[0].Name != "system.status" || !calls[0].OK {
		t.Fatalf("wired tool call = %+v, want one ok system.status", calls)
	}
	if res.Approval != nil {
		t.Errorf("a read was gated: %+v", res.Approval)
	}

	bare, modelBare := newStatusToolModel(t, wiringStep{text: "I cannot read the setup here."})
	statusTurn(t, statusRunner(t, bare, nil))
	if named(modelBare.announced(0), "system_status") {
		t.Errorf("unwired runner announced system_status: %v", modelBare.announced(0))
	}
}

// TestAssistantStatusToolAnswersWithRouteShape: the tool's payload is the
// route's object — one read, two doors — and a read that cannot be answered
// is the stable `unavailable` refusal, never a fabricated green checklist.
func TestAssistantStatusToolAnswersWithRouteShape(t *testing.T) {
	t.Parallel()
	store := newStatusStore()
	store.visible["u-1"] = []ProjectView{{ID: "p-1"}}
	store.pipelines["u-1"] = []PipelineSummaryView{{ID: "w-1", Slug: "issue-to-pr"}}
	svc := NewSystemStatus(AssistantStatusDeps{Chat: AssistantConfig{Model: "m"}, Projects: store, Pipelines: store})

	// The route's own bytes, not a re-marshal of the same value: the contract
	// says the tool's payload is exactly this object.
	srv := newTestServerWith(t,
		Config{ReplicaName: "replica-a", Version: "1.2.3", PublicURL: "http://localhost:8080"},
		nil, fakeReadiness{expected: 1},
		principalAuth(&Principal{UserID: "u-1", OrganizationID: "o-1", CSRFToken: prjCSRF}, nil))
	RegisterAssistantStatus(srv, svc)
	routeBody := []byte(strings.TrimRight(statusGet(t, srv).Body.String(), "\n"))

	raw, err := NewAssistantStatusReader(svc)(context.Background(), as.Caller{UserID: "u-1", OrganizationID: "o-1"})
	if err != nil {
		t.Fatalf("status reader: %v", err)
	}
	if string(raw) != string(routeBody) {
		t.Errorf("tool payload != route body:\n tool:  %s\n route: %s", raw, routeBody)
	}

	// The closed table knows the name, and it is a read: never gated.
	class, known := as.ClassOf("system.status")
	if !known {
		t.Fatal("system.status is outside the closed tool table")
	}
	if class != as.ClassRead {
		t.Errorf("system.status class = %v, want read", class)
	}

	// A model that invents the call on an unwired server gets the stable
	// unknown-tool refusal: the name was never announced, and the loop does
	// not execute tools it never told the model about.
	model := newWiringModel(t,
		wiringStep{calls: []wiringWireCall{{name: "system_status", arguments: `{}`}}},
		wiringStep{text: "I could not read the setup."},
	)
	res := statusTurn(t, statusRunner(t, model, nil))
	calls := res.Answer.ToolCalls
	if len(calls) != 1 || calls[0].OK || calls[0].Reason != "unknown_tool" {
		t.Fatalf("unwired tool call = %+v, want ok:false unknown_tool", calls)
	}

	// A wired server whose read FAILS answers the stable `unavailable`, never
	// a fabricated green checklist.
	brokenStore := newStatusStore()
	brokenStore.err = fmt.Errorf("the database is unreachable")
	broken := NewAssistantStatusReader(NewSystemStatus(AssistantStatusDeps{Projects: brokenStore}))
	model2 := newWiringModel(t,
		wiringStep{calls: []wiringWireCall{{name: "system_status", arguments: `{}`}}},
		wiringStep{text: "The setup read failed."},
	)
	res2 := statusTurn(t, statusRunner(t, model2, broken))
	calls2 := res2.Answer.ToolCalls
	if len(calls2) != 1 || calls2[0].Name != "system.status" || calls2[0].OK ||
		calls2[0].Reason != "unavailable" {
		t.Fatalf("failed-read tool call = %+v, want ok:false unavailable", calls2)
	}
}

// TestAssistantStatusStoreFailureIs500: a store that cannot answer is the
// request id's error, not a checklist that quietly reads "nothing set up".
func TestAssistantStatusStoreFailureIs500(t *testing.T) {
	t.Parallel()
	store := newStatusStore()
	store.err = fmt.Errorf("projects table is unreachable")
	srv := statusFixture(t, store, nil, nil, AssistantStatusModels{}, AssistantConfig{}, "u-1")
	rec := statusGet(t, srv)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500 (%s)", rec.Code, rec.Body)
	}
	if strings.Contains(rec.Body.String(), "projects table") {
		t.Errorf("the store's error reached the client: %s", rec.Body.String())
	}
}

// TestAssistantStatusWeakestSandboxMode: disagreement among the online fleet
// answers the weakest mode, so one unenforced worker is never hidden.
func TestAssistantStatusWeakestSandboxMode(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name   string
		modes  []string
		online int
		want   string
	}{
		{name: "all required", modes: []string{"required", "required"}, online: 2, want: "required"},
		{name: "one permissive-dev", modes: []string{"required", "permissive-dev"}, online: 2, want: "optional"},
		{name: "one disabled", modes: []string{"required", "permissive-dev", "disabled"}, online: 3, want: "off"},
		{name: "nothing registered", modes: nil, online: 1, want: "unknown"},
		{name: "no worker online", modes: []string{"disabled"}, online: 0, want: "unknown"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			workers := &statusWorkers{}
			for i := 0; i < tc.online; i++ {
				workers.workers = append(workers.workers,
					WorkerView{ID: fmt.Sprintf("w%d", i), Name: fmt.Sprintf("w%d", i), Status: "online"})
			}
			for i, mode := range tc.modes {
				workers.sandbox = append(workers.sandbox,
					WorkerSandboxStatusView{WorkerID: fmt.Sprintf("w%d", i), Enforcement: mode})
			}
			svc := NewSystemStatus(AssistantStatusDeps{Workers: workers, Sandbox: workers})
			view, err := svc.Status(context.Background(), Caller{UserID: "u-1", OrganizationID: "o-1"})
			if err != nil {
				t.Fatalf("Status: %v", err)
			}
			if view.Workers.Online != tc.online || view.Workers.SandboxMode != tc.want {
				t.Errorf("workers = %+v, want online %d mode %s", view.Workers, tc.online, tc.want)
			}
		})
	}
}

// --- F-6: the status object tells the truth about this process ---------------

// TestAssistantStatusExecutionMode: `execution_mode` is the honest answer to
// "does the work run in this process?" (docs/testing/assistant-exercise-2026-11-11.md
// F-6). A deployed split replica — API in one pod, the runs in a separate worker
// pod — answered `inprocess`, and prompt 2 told the person "runs execute
// in-process". `communication dev` (ADR-0082's `single` mode) is the ONE mode
// that shares the process, so it is the only one that may say `inprocess`;
// everything else, including a bare `communication serve`, says `worker`.
func TestAssistantStatusExecutionMode(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name string
		args []string
		want string
	}{
		{"serve-only", []string{"/usr/bin/communication", "serve"}, "worker"},
		{"serve-with-flags", []string{"/usr/bin/communication", "serve", "--foo"}, "worker"},
		{"worker-mode", []string{"/usr/bin/communication", "worker"}, "worker"},
		{"dev-shares-the-process", []string{"/usr/bin/communication", "dev"}, "inprocess"},
		{"dev-is-the-word-not-the-path", []string{"/tmp/dev", "serve"}, "worker"},
		{"no-arguments-at-all", []string{}, "worker"},
		// The zero wiring reads THIS process's argv, and a test binary's argv is
		// flags — never `communication dev` — so the honest answer here is the
		// split one. serve builds the service without the field and gets this.
		{"unwired-means-this-process", nil, "worker"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			svc := NewSystemStatus(AssistantStatusDeps{ProcessArgs: tc.args})
			view, err := svc.Status(context.Background(), Caller{UserID: "u-1", OrganizationID: "o-1"})
			if err != nil {
				t.Fatalf("Status: %v", err)
			}
			if view.ExecutionMode != tc.want {
				t.Errorf("execution_mode for %v = %q, want %q", tc.args, view.ExecutionMode, tc.want)
			}
		})
	}
}

// TestAssistantStatusChatModelCarriesHostAndKeySet is the other half of F-6: the
// chat row used to name nothing but its model id while speech and decision
// carried `endpoint_host`/`key_set`, so prompt 7 could only hedge about the one
// endpoint every answer comes from. The row now says the same two facts, and
// still no value, URL or key: a base URL that carried credentials in its
// userinfo contributes the hostname and nothing else.
func TestAssistantStatusChatModelCarriesHostAndKeySet(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name       string
		cfg        AssistantConfig
		wantHost   any
		wantKeySet any
	}{
		{
			name:       "endpoint with a key",
			cfg:        AssistantConfig{BaseURL: "https://llm.example.com/v1", APIKey: "a-key-never-echoed", Model: "m"},
			wantHost:   "llm.example.com",
			wantKeySet: true,
		},
		{
			name:       "endpoint with no key",
			cfg:        AssistantConfig{BaseURL: "http://chat.internal:8000/v1", Model: "m"},
			wantHost:   "chat.internal",
			wantKeySet: false,
		},
		{
			name: "credentials in the URL contribute no more than the host",
			cfg: AssistantConfig{BaseURL: "https://user:pw@collective.example.com/v1",
				APIKey: "a-key-never-echoed", Model: "m"},
			wantHost:   "collective.example.com",
			wantKeySet: true,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			svc := NewSystemStatus(AssistantStatusDeps{Chat: tc.cfg})
			view, err := svc.Status(context.Background(), Caller{UserID: "u-1", OrganizationID: "o-1"})
			if err != nil {
				t.Fatalf("Status: %v", err)
			}
			chat := view.ChatModel
			if !chat.Configured {
				t.Fatalf("chat_model = %+v, want configured", chat)
			}
			if chat.EndpointHost == nil || *chat.EndpointHost != tc.wantHost.(string) {
				t.Errorf("chat_model.endpoint_host = %v, want %v", chat.EndpointHost, tc.wantHost)
			}
			if chat.KeySet == nil || *chat.KeySet != tc.wantKeySet.(bool) {
				t.Errorf("chat_model.key_set = %v, want %v", chat.KeySet, tc.wantKeySet)
			}
			// Nothing that could hold a value, a scheme or userinfo is served.
			blob, err := json.Marshal(view)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			for _, leak := range []string{"a-key-never-echoed", "user:pw", "://", "https://", "http://"} {
				if strings.Contains(string(blob), leak) {
					t.Errorf("status body leaked %q: %s", leak, blob)
				}
			}
		})
	}
}
