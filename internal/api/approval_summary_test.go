package api

// ADR-0052 route tests: the approval summarization pass and free-text
// interpretation over a scripted (fake) model. These cover the HTTP contract
// the assistant unit tests leave to the handler: permission (a gate the
// caller cannot see is the uniform 404), the unconfigured 503, in-memory
// caching keyed on the gate version, and the response shape after coercion.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

// fakeModel serves one scripted chat completion and counts the calls it gets,
// so the caching test can assert the model is hit exactly once per version.
func fakeModel(t *testing.T, content string, calls *int64) string {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/chat/completions" {
			http.Error(w, "wrong path", http.StatusNotFound)
			return
		}
		if calls != nil {
			atomic.AddInt64(calls, 1)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []map[string]any{{
				"message":       map[string]any{"role": "assistant", "content": content},
				"finish_reason": "stop",
			}},
		})
	}))
	t.Cleanup(srv.Close)
	return srv.URL
}

func summaryTestGate() ApprovalView {
	return ApprovalView{
		ID: "ap-1", ProjectID: "p-1", RunID: "r-1", NodeExecutionID: "ne-1",
		Kind:            "pipeline_gate",
		Summary:         "Implement the retry feature and add a migration.",
		ArtifactRefs:    json.RawMessage(`[{"name":"plan.md","kind":"markdown","sensitivity":"internal"}]`),
		ApproverRoles:   []string{"maintainer"},
		ApproverUserIDs: []string{"u-1"},
		State:           "pending", OnTimeout: "fail", Version: 1,
	}
}

func summaryServer(t *testing.T, ap *m4Approvals, modelURL string) *Server {
	t.Helper()
	s := newTestServer(t, nil, fakeReadiness{expected: 5},
		AuthenticatorFunc(func(*http.Request) (*Principal, error) { return testPrincipal(), nil }))
	cfg := AssistantConfig{Model: "test-model"}
	if modelURL != "" {
		cfg.BaseURL = modelURL
	}
	RegisterApprovalSummary(s, ap, cfg)
	return s
}

// postCSRF issues an authed, CSRF-bearing POST and returns the recorder.
func postCSRF(t *testing.T, s *Server, target, body string) *httptest.ResponseRecorder {
	t.Helper()
	return do(t, s.handler, m4Req(http.MethodPost, target, body, true))
}

func TestApprovalSummaryHappyPathCoerces(t *testing.T) {
	content := `{"summary":"Retry feature with a migration.","actions":[
		{"label":"Approve","intent":"approve","risk":"proceed"},
		{"label":"Reject","intent":"reject","risk":"refuse"},
		{"label":"Request changes","intent":"wibble","risk":"yabble"}]}`
	ap := &m4Approvals{ap: summaryTestGate()}
	s := summaryServer(t, ap, fakeModel(t, content, nil))

	rec := postCSRF(t, s, "http://localhost:8080/api/v1/approvals/ap-1/summary", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("summary = %d: %s", rec.Code, rec.Body)
	}
	var out struct {
		Summary string `json:"summary"`
		Actions []struct {
			Label  string `json:"label"`
			Intent string `json:"intent"`
			Risk   string `json:"risk"`
		} `json:"actions"`
		Model string `json:"model"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if out.Model != "test-model" {
		t.Errorf("model = %q", out.Model)
	}
	if len(out.Actions) != 3 {
		t.Fatalf("actions = %+v", out.Actions)
	}
	if out.Actions[2].Intent != "other" || out.Actions[2].Risk != "other" {
		t.Errorf("unknown members not coerced: %+v", out.Actions[2])
	}
}

func TestApprovalSummaryCachesByVersion(t *testing.T) {
	var calls int64
	content := `{"summary":"One. Two.","actions":[
		{"label":"Approve","intent":"approve","risk":"proceed"},
		{"label":"Reject","intent":"reject","risk":"refuse"}]}`
	ap := &m4Approvals{ap: summaryTestGate()}
	s := summaryServer(t, ap, fakeModel(t, content, &calls))
	target := "http://localhost:8080/api/v1/approvals/ap-1/summary"

	if rec := postCSRF(t, s, target, ""); rec.Code != http.StatusOK {
		t.Fatalf("first = %d: %s", rec.Code, rec.Body)
	}
	if rec := postCSRF(t, s, target, ""); rec.Code != http.StatusOK {
		t.Fatalf("second = %d: %s", rec.Code, rec.Body)
	}
	if got := atomic.LoadInt64(&calls); got != 1 {
		t.Fatalf("model calls = %d after two requests at the same version, want 1", got)
	}
	// A decision bumps the version; the cache must miss and recompute.
	ap.ap.Version = 2
	if rec := postCSRF(t, s, target, ""); rec.Code != http.StatusOK {
		t.Fatalf("after version bump = %d: %s", rec.Code, rec.Body)
	}
	if got := atomic.LoadInt64(&calls); got != 2 {
		t.Fatalf("model calls = %d after the version bump, want 2", got)
	}
}

func TestApprovalSummaryNotVisibleIs404(t *testing.T) {
	ap := &m4Approvals{} // no gate: GetApproval answers the not-found sentinel
	s := summaryServer(t, ap, fakeModel(t, `{"summary":"x","actions":[]}`, nil))
	rec := postCSRF(t, s, "http://localhost:8080/api/v1/approvals/missing/summary", "")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("summary for an invisible gate = %d, want 404", rec.Code)
	}
	rec = postCSRF(t, s, "http://localhost:8080/api/v1/approvals/missing/interpret", `{"text":"approve"}`)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("interpret for an invisible gate = %d, want 404", rec.Code)
	}
}

func TestApprovalSummaryUnconfiguredIs503(t *testing.T) {
	ap := &m4Approvals{ap: summaryTestGate()}
	s := summaryServer(t, ap, "") // no base URL: the feature is absent
	rec := postCSRF(t, s, "http://localhost:8080/api/v1/approvals/ap-1/summary", "")
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("summary unconfigured = %d, want 503", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "assistant_not_configured") {
		t.Errorf("503 body does not name the cause: %s", rec.Body)
	}
	rec = postCSRF(t, s, "http://localhost:8080/api/v1/approvals/ap-1/interpret", `{"text":"approve"}`)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("interpret unconfigured = %d, want 503", rec.Code)
	}
}

func TestApprovalInterpretShapeAndValidation(t *testing.T) {
	content := `{"interpretation":"The approver wants to approve once the test is fixed.",
		"proposed":{"decision":"REQUEST_CHANGES","comments":"fix the flaky test"}}`
	ap := &m4Approvals{ap: summaryTestGate()}
	s := summaryServer(t, ap, fakeModel(t, content, nil))
	target := "http://localhost:8080/api/v1/approvals/ap-1/interpret"

	rec := postCSRF(t, s, target, `{"text":"approve once the flaky test is fixed"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("interpret = %d: %s", rec.Code, rec.Body)
	}
	var out struct {
		Interpretation string `json:"interpretation"`
		Proposed       struct {
			Decision string `json:"decision"`
			Comments string `json:"comments"`
		} `json:"proposed"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if out.Proposed.Decision != "request_changes" {
		t.Errorf("decision = %q", out.Proposed.Decision)
	}
	if out.Interpretation == "" {
		t.Errorf("empty interpretation")
	}

	// Empty text is a 400 before the store.
	if rec := postCSRF(t, s, target, `{"text":"   "}`); rec.Code != http.StatusBadRequest {
		t.Errorf("empty text = %d, want 400", rec.Code)
	}
	// Oversized text is a 400.
	big := strings.Repeat("a", 3000)
	if rec := postCSRF(t, s, target, `{"text":"`+big+`"}`); rec.Code != http.StatusBadRequest {
		t.Errorf("oversized text = %d, want 400", rec.Code)
	}
}
