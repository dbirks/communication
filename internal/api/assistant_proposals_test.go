package api

// Route-level tests for ADR-0044's proposals endpoint: the 404/403/409/422/503
// arms and the 200 whose model call went through the ADR-0034 broker with the
// caller's own draft read — and whose fake store records zero writes.

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/dbirks/communication/internal/assistant"
)

// proposalDraftYAML is the draft the handler-level cases propose on.
const proposalDraftYAML = `apiVersion: communication.dev/v1alpha1
kind: Pipeline
metadata:
  name: propose-target
spec:
  nodes:
  - id: plan
    kind: agent.acp
    config: {profile: planner, prompt: plan the change}
  - id: approve
    kind: human.approval
    dependsOn: [plan]
  - id: build
    kind: process.exec
    dependsOn: [approve]
    config: {cmd: make}
`

// proposalDrafts is the drafts face: the caller's own read, counting every
// call. It has NO write method at all, so "the server never writes the
// draft" holds structurally; the tests still pin the call counts.
type proposalDrafts struct {
	asstStores
	draft DraftView
	gerr  error
	reads int
}

func (s *proposalDrafts) GetDraft(_ context.Context, _ Caller, _ string) (DraftView, error) {
	s.asstStores.mu.Lock()
	defer s.asstStores.mu.Unlock()
	s.reads++
	if s.gerr != nil {
		return DraftView{}, s.gerr
	}
	return s.draft, nil
}

var (
	_ assistantPipelineReader = (*proposalDrafts)(nil)
	_ assistantDraftAccess    = (*proposalDrafts)(nil)
)

// proposalModel is the scripted endpoint: one scripted answer per request,
// counting completions so a request is proven to make exactly ONE model
// call (no re-ask, no tool loop).
type proposalModel struct {
	mu      sync.Mutex
	n       int
	answers []string
	status  int
}

func (m *proposalModel) handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "bad body", http.StatusBadRequest)
			return
		}
		m.mu.Lock()
		idx := m.n
		m.n++
		status := m.status
		answer := "the model has no scripted answer"
		if idx < len(m.answers) {
			answer = m.answers[idx]
		}
		m.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		if status != 0 {
			w.WriteHeader(status)
			_, _ = w.Write([]byte(`{"error":{"message":"scripted egress failure","type":"unreachable"}}`))
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []map[string]any{{
				"message":       map[string]any{"role": "assistant", "content": answer},
				"finish_reason": "stop",
			}},
		})
	})
}

func proposalMount(t *testing.T, deps AssistantDeps, model *proposalModel) *Server {
	t.Helper()
	srv := httptest.NewServer(model.handler())
	t.Cleanup(srv.Close)
	deps.Config = AssistantConfig{BaseURL: srv.URL, Model: "test-model"}
	return asstMount(t, deps, principalAuth(testPrincipal(), nil))
}

func proposalPost(t *testing.T, s *Server, body any) *httptest.ResponseRecorder {
	t.Helper()
	data, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, "http://localhost:8080/api/v1/assistant/draft-proposals",
		strings.NewReader(string(data)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "http://localhost:8080")
	req.Header.Set(HeaderCSRFToken, "csrf-token-value")
	return do(t, s, req)
}

func proposalDraftFixture() DraftView {
	return DraftView{ID: "draft-1", PipelineID: "pipe-1", Status: "draft",
		DocumentYAML: proposalDraftYAML, SourceKind: "manual", Version: 1}
}

// TestDraftProposalsRefusesWhileUnconfigured pins the honest 503: with no
// COMMUNICATION_ASSISTANT_BASE_URL the deployment has no assistant, and the
// problem names the cause like the ask route does.
func TestDraftProposalsRefusesWhileUnconfigured(t *testing.T) {
	s := asstMount(t, AssistantDeps{}, principalAuth(testPrincipal(), nil))
	rec := proposalPost(t, s, map[string]any{
		"draft_id": "draft-1", "version": 1, "instruction": "insert a reviewer",
	})
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503 (%s)", rec.Code, rec.Body)
	}
	var out struct {
		Status   int    `json:"status"`
		Detail   string `json:"detail"`
		Degraded string `json:"degraded"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v (%s)", err, rec.Body)
	}
	if out.Degraded != "assistant_not_configured" {
		t.Fatalf("degraded = %q", out.Degraded)
	}
}

func TestDraftProposalAuthzAndVersionArms(t *testing.T) {
	t.Run("unknown draft is a uniform 404, never 403", func(t *testing.T) {
		drafts := &proposalDrafts{gerr: ErrPipelineNotFound}
		model := &proposalModel{answers: []string{`{"op":"unknown_op"}`}}
		s := proposalMount(t, AssistantDeps{Pipelines: drafts, Profiles: drafts}, model)
		rec := proposalPost(t, s, map[string]any{"draft_id": "nope", "version": 1, "instruction": "x"})
		if rec.Code != http.StatusNotFound {
			t.Fatalf("status = %d, want 404 (%s)", rec.Code, rec.Body)
		}
		if drafts.reads != 1 || model.n != 0 {
			t.Fatalf("reads = %d, model calls = %d, want one read and zero egress", drafts.reads, model.n)
		}
	})

	t.Run("a caller who may see but not write the draft gets 403", func(t *testing.T) {
		drafts := &proposalDrafts{gerr: ErrDraftForbidden}
		model := &proposalModel{answers: []string{`{"op":"unknown_op"}`}}
		s := proposalMount(t, AssistantDeps{Pipelines: drafts, Profiles: drafts}, model)
		rec := proposalPost(t, s, map[string]any{"draft_id": "draft-1", "version": 1, "instruction": "x"})
		if rec.Code != http.StatusForbidden {
			t.Fatalf("status = %d, want 403 (%s)", rec.Code, rec.Body)
		}
		if model.n != 0 {
			t.Fatalf("model calls = %d, want zero egress before the authorization answer", model.n)
		}
	})

	t.Run("a stale version is the PUT's own 409 with the winner", func(t *testing.T) {
		drafts := &proposalDrafts{draft: proposalDraftFixture()} // version 1
		model := &proposalModel{answers: []string{`{"op":"unknown_op"}`}}
		s := proposalMount(t, AssistantDeps{Pipelines: drafts, Profiles: drafts}, model)
		rec := proposalPost(t, s, map[string]any{"draft_id": "draft-1", "version": 2, "instruction": "x"})
		if rec.Code != http.StatusConflict {
			t.Fatalf("status = %d, want 409 (%s)", rec.Code, rec.Body)
		}
		var out struct {
			Type           string `json:"type"`
			Status         int    `json:"status"`
			Detail         string `json:"detail"`
			DraftID        string `json:"draft_id"`
			CurrentVersion int    `json:"current_version"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
			t.Fatalf("decode: %v (%s)", err, rec.Body)
		}
		if out.Type != "https://communication.dev/errors/stale-draft-version" || out.CurrentVersion != 1 {
			t.Fatalf("conflict = %+v", out)
		}
		if model.n != 0 {
			t.Fatalf("model calls = %d, want zero egress for a version mismatch", model.n)
		}
	})

	t.Run("a bad body is 400 before any store or model call", func(t *testing.T) {
		drafts := &proposalDrafts{draft: proposalDraftFixture()}
		model := &proposalModel{}
		s := proposalMount(t, AssistantDeps{Pipelines: drafts, Profiles: drafts}, model)
		rec := proposalPost(t, s, map[string]any{"draft_id": "draft-1", "version": 1})
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("status = %d, want 400 (%s)", rec.Code, rec.Body)
		}
		if drafts.reads != 0 || model.n != 0 {
			t.Fatalf("reads = %d, model = %d, want none", drafts.reads, model.n)
		}
	})
}

func TestDraftProposalRefusesInvalidModelOutput(t *testing.T) {
	drafts := &proposalDrafts{draft: proposalDraftFixture()}
	model := &proposalModel{answers: []string{`{"op":"teleport","after":"plan"}`}}
	s := proposalMount(t, AssistantDeps{Pipelines: drafts, Profiles: drafts}, model)
	rec := proposalPost(t, s, map[string]any{
		"draft_id": "draft-1", "version": 1, "instruction": "insert a reviewer",
	})
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	var out struct {
		Type   string `json:"type"`
		Detail string `json:"detail"`
		Code   string `json:"code"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v (%s)", err, rec.Body)
	}
	if out.Code != "assistant_proposal_invalid" || !strings.Contains(out.Detail, "unknown_op") {
		t.Fatalf("problem = %+v", out)
	}
	if model.n != 1 {
		t.Fatalf("model calls = %d, want exactly one (no re-ask)", model.n)
	}
}

// TestDraftProposalHappyPath pins the 200: one completion through the broker,
// a validated insert_on_edge, the touched node ids, the version for the Apply
// PUT — and a draft row the store never wrote.
func TestDraftProposalHappyPath(t *testing.T) {
	const answer = "```json\n" +
		`{"op":"insert_on_edge","from":"approve","to":"build","kind":"agent.acp","id":"review_code","config":{"profile":"planner","prompt":"review the diff"},"summary":"Insert a reviewer between approval and the build"}` +
		"\n```"
	before := proposalDraftFixture()
	drafts := &proposalDrafts{draft: before}
	model := &proposalModel{answers: []string{answer}}
	s := proposalMount(t, AssistantDeps{Pipelines: drafts, Profiles: drafts}, model)
	rec := proposalPost(t, s, map[string]any{
		"draft_id": "draft-1", "version": 1, "instruction": "insert a code reviewer after the approval gate",
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var out assistantDraftProposalResponseWire
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v (%s)", err, rec.Body)
	}
	if out.Op.Op != "insert_on_edge" || out.Op.From != "approve" || out.Op.To != "build" || out.Op.ID != "review_code" {
		t.Fatalf("op = %+v", out.Op)
	}
	if len(out.NodeIDs) != 3 || out.NodeIDs[0] != "review_code" {
		t.Fatalf("node_ids = %v", out.NodeIDs)
	}
	if out.Version != 1 || out.Summary == "" {
		t.Fatalf("version = %d, summary = %q", out.Version, out.Summary)
	}
	// The server wrote nothing: the draft row is byte-identical and the only
	// store traffic was the caller's own read.
	after := drafts.draft
	if after.ID != before.ID || after.PipelineID != before.PipelineID || after.Status != before.Status ||
		after.Version != 1 || after.DocumentYAML != proposalDraftYAML || after.SourceSHA256 != before.SourceSHA256 {
		t.Fatalf("draft row changed: %v", after)
	}
	if drafts.reads != 1 || model.n != 1 {
		t.Fatalf("reads = %d, model calls = %d, want one of each", drafts.reads, model.n)
	}
}

func TestDraftProposalModelEgressFailureMapsLikeAsk(t *testing.T) {
	drafts := &proposalDrafts{draft: proposalDraftFixture()}
	model := &proposalModel{status: http.StatusServiceUnavailable}
	s := proposalMount(t, AssistantDeps{Pipelines: drafts, Profiles: drafts}, model)
	rec := proposalPost(t, s, map[string]any{
		"draft_id": "draft-1", "version": 1, "instruction": "insert a reviewer",
	})
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503 (%s)", rec.Code, rec.Body)
	}
	var out struct {
		Degraded string `json:"degraded"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v (%s)", err, rec.Body)
	}
	if out.Degraded != assistant.FailModelUnreachable {
		t.Fatalf("degraded = %q, want %q", out.Degraded, assistant.FailModelUnreachable)
	}
}

// assistantDraftProposalResponseWire is the response shape re-decoded here so
// the test reads the wire, not the struct.
type assistantDraftProposalResponseWire struct {
	Op struct {
		Op     string         `json:"op"`
		From   string         `json:"from"`
		To     string         `json:"to"`
		ID     string         `json:"id"`
		Kind   string         `json:"kind"`
		Config map[string]any `json:"config"`
	} `json:"op"`
	NodeIDs []string `json:"node_ids"`
	Summary string   `json:"summary"`
	Version int      `json:"version"`
}
