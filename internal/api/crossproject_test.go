package api

// Handler-level tests for the cross-project read routes (ADR-0047, contract
// C3): the query validation matrix (every bad value is a 400 problem+json
// before any store call), the envelope shapes (runs / approvals / items,
// next_cursor null on the last page) and the store-error leg — against a
// fake. The SQL predicates behind the interface are proven against a real
// PostgreSQL in internal/store/postgres (crossproject_test.go); a mocked
// green test never substitutes for that.

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// cpFakeStore records the last filter it saw and answers with canned data.
type cpFakeStore struct {
	runsFilter    CrossProjectRunsFilter
	runsSeen      int
	approvalsSeen int
	approvalsQ    string
	convLimit     int
	convCursor    string
	convSeen      int

	runs   []CrossProjectRunView
	approv []ApprovalView
	convs  []ConversationSummaryView

	runsNext  string
	convNext  string
	runsErr   error
	approvErr error
	convsErr  error
}

func (f *cpFakeStore) ListVisibleRuns(_ context.Context, _ Caller, f2 CrossProjectRunsFilter) ([]CrossProjectRunView, string, error) {
	f.runsFilter, f.runsSeen = f2, f.runsSeen+1
	if f.runsErr != nil {
		return nil, "", f.runsErr
	}
	if f.runs == nil {
		return nil, "", nil
	}
	return f.runs, f.runsNext, nil
}

func (f *cpFakeStore) ListVisibleApprovals(_ context.Context, _ Caller, status string) ([]ApprovalView, error) {
	f.approvalsQ, f.approvalsSeen = status, f.approvalsSeen+1
	if f.approvErr != nil {
		return nil, f.approvErr
	}
	if f.approv == nil {
		return nil, nil
	}
	return f.approv, nil
}

func (f *cpFakeStore) ListVisibleConversations(_ context.Context, _ Caller, limit int, cursor string) ([]ConversationSummaryView, string, error) {
	f.convLimit, f.convCursor, f.convSeen = limit, cursor, f.convSeen+1
	if f.convsErr != nil {
		return nil, "", f.convsErr
	}
	if f.convs == nil {
		return nil, "", nil
	}
	return f.convs, f.convNext, nil
}

func cpServer(t *testing.T, store CrossProjectStore) (*Server, *cpFakeStore) {
	t.Helper()
	fx := &cpFakeStore{}
	if store != nil {
		fx = store.(*cpFakeStore)
	}
	s := newTestServer(t, nil, fakeReadiness{expected: 5},
		principalAuth(testPrincipal(), nil))
	RegisterCrossProject(s, fx)
	return s, fx
}

func cpReq(t *testing.T, s *Server, target string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, target, nil)
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	return rec
}

func cpDecode[T any](t *testing.T, rec *httptest.ResponseRecorder) T {
	t.Helper()
	var v T
	if err := json.Unmarshal(rec.Body.Bytes(), &v); err != nil {
		t.Fatalf("decode %s: %v", rec.Body.String(), err)
	}
	return v
}

func cpNilStore() *cpFakeStore { return &cpFakeStore{} }

// ------------------------------------------------------------------ runs ---

func TestCrossProjectRunListDefaults(t *testing.T) {
	fx := &cpFakeStore{runs: []CrossProjectRunView{{
		RunSummaryView: RunSummaryView{ID: "r-1", ProjectID: "p-1", Status: "running"},
		ProjectName:    "Alpha", PipelineSlug: "hotfix", PipelineDisplayName: "Hotfix",
		Steps: []CrossProjectRunStep{{NodeID: "implement", Kind: "agent", State: "running"}},
	}}}
	s, fx2 := cpServer(t, fx)
	rec := cpReq(t, s, "/api/v1/runs")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", rec.Code, rec.Body.String())
	}
	body := cpDecode[CrossProjectRunListView](t, rec)
	if len(body.Runs) != 1 {
		t.Fatalf("runs = %d, want 1", len(body.Runs))
	}
	if body.NextCursor != nil {
		t.Fatalf("next_cursor = %q, want null on the last page", *body.NextCursor)
	}
	r := body.Runs[0]
	if r.RunSummaryView.ID != "r-1" || r.ProjectName != "Alpha" ||
		!strings.Contains(rec.Body.String(), "\"pipeline_slug\":\"hotfix\"") {
		t.Fatalf("row = %+v (body %s): pinned identity + human names must ride the row",
			r, rec.Body.String())
	}
	if len(r.Steps) != 1 || r.Steps[0].State != "running" {
		t.Fatalf("steps = %+v, want the embedded projection", r.Steps)
	}
	if fx2.runsSeen != 1 || fx2.runsFilter.Limit != CrossProjectDefaultLimit {
		t.Fatalf("filter = %+v: the default limit 50 must reach the store",
			fx2.runsFilter)
	}
}

func TestCrossProjectRunListFilters(t *testing.T) {
	fx := &cpFakeStore{runs: []CrossProjectRunView{}}
	s, fx2 := cpServer(t, fx)
	since := "2026-10-19T00:00:00Z"
	cursor := EncodeCrossProjectCursor(CrossProjectCursor{
		CreatedAt: time.Date(2026, 10, 18, 12, 0, 0, 0, time.UTC), ID: "r-9"})
	rec := cpReq(t, s,
		"/api/v1/runs?status=running,waiting_human,running"+
			"&project_id="+m4UUID+"&pipeline_id="+m4UUID2+
			"&mine=true&updated_since="+since+"&limit=7&cursor="+cursor+
			"&trigger=manual")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", rec.Code, rec.Body.String())
	}
	f := fx2.runsFilter
	if len(f.Statuses) != 2 || f.Statuses[0] != "running" || f.Statuses[1] != "waiting_human" {
		t.Fatalf("statuses = %v, want the deduplicated csv", f.Statuses)
	}
	if f.Trigger != "manual" {
		t.Fatalf("trigger = %q, want manual (ADR-0056)", f.Trigger)
	}
	if f.ProjectID != m4UUID || f.PipelineID != m4UUID2 {
		t.Fatalf("ids = %q %q, want the uuid filters", f.ProjectID, f.PipelineID)
	}
	if !f.Mine || f.UpdatedSince == nil || f.UpdatedSince.Year() != 2026 ||
		f.Limit != 7 || f.Cursor != cursor {
		t.Fatalf("filter = %+v: mine/updated_since/limit/cursor must reach the store", f)
	}
}

func TestCrossProjectRunListValidation(t *testing.T) {
	fx := &cpFakeStore{}
	s, fx2 := cpServer(t, fx)
	cases := []struct {
		q      string
		detail string
	}{
		{"?status=bogus", "invalid_status"},
		{"?status=running,bogus", "invalid_status"},
		{"?project_id=not-a-uuid", "invalid_project_id"},
		{"?pipeline_id=not-a-uuid", "invalid_pipeline_id"},
		{"?mine=yes", "invalid_mine"},
		{"?updated_since=yesterday", "invalid_updated_since"},
		{"?trigger=bogus", "invalid_trigger"},
		{"?trigger=running", "invalid_trigger"},
		{"?limit=0", "invalid_limit"},
		{"?limit=201", "invalid_limit"},
		{"?limit=abc", "invalid_limit"},
		{"?cursor=notbase64", "invalid_cursor"},
	}
	for _, tc := range cases {
		rec := cpReq(t, s, "/api/v1/runs"+tc.q)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("%s: status = %d, want 400", tc.q, rec.Code)
		}
		if ct := rec.Header().Get("Content-Type"); !strings.Contains(ct, "application/problem+json") {
			t.Fatalf("%s: content type %q is not problem+json", tc.q, ct)
		}
		var p Problem
		if err := json.Unmarshal(rec.Body.Bytes(), &p); err != nil {
			t.Fatalf("%s: decode problem: %v", tc.q, err)
		}
		if !strings.Contains(p.Detail, tc.detail) {
			t.Fatalf("%s: detail %q does not name %s", tc.q, p.Detail, tc.detail)
		}
	}
	if fx2.runsSeen != 0 {
		t.Fatalf("store was called %d times: a bad value must not reach SQL", fx2.runsSeen)
	}
}

func TestCrossProjectRunListNextCursorAndStoreError(t *testing.T) {
	fx := &cpFakeStore{runs: []CrossProjectRunView{}, runsNext: "abc123"}
	s, _ := cpServer(t, fx)
	rec := cpReq(t, s, "/api/v1/runs?limit=1")
	body := cpDecode[CrossProjectRunListView](t, rec)
	if body.NextCursor == nil || *body.NextCursor != "abc123" {
		t.Fatalf("next_cursor = %v, want the store's cursor", body.NextCursor)
	}

	errStore := errors.New("pool: connection timeout")
	fx.runsErr = errStore
	rec = cpReq(t, s, "/api/v1/runs")
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500 on a store failure", rec.Code)
	}

	// An empty page is an empty array, never absent.
	fx.runsErr = nil
	rec = cpReq(t, s, "/api/v1/runs")
	if !strings.Contains(rec.Body.String(), "\"runs\":[]") {
		t.Fatalf("body %s: an empty page is []", rec.Body.String())
	}
	_ = errStore
}

func TestCrossProjectApprovalList(t *testing.T) {
	fx := &cpFakeStore{approv: []ApprovalView{{
		ID: "a-1", ProjectID: "p-1", RunID: "r-1", Kind: "pipeline_gate",
		Summary: "approve the plan", State: "pending", Version: 1,
	}}}
	s, fx2 := cpServer(t, fx)
	rec := cpReq(t, s, "/api/v1/approvals?status=pending")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", rec.Code, rec.Body.String())
	}
	body := cpDecode[CrossProjectApprovalListView](t, rec)
	if len(body.Approvals) != 1 {
		t.Fatalf("approvals = %d, want 1", len(body.Approvals))
	}
	// The existing schema rides unchanged: project_id and run_id are on it.
	if body.Approvals[0].ProjectID != "p-1" || body.Approvals[0].RunID != "r-1" {
		t.Fatalf("row = %+v: the existing Approval schema is reused", body.Approvals[0])
	}
	if fx2.approvalsQ != "pending" || fx2.approvalsSeen != 1 {
		t.Fatalf("status %q seen %d: the value must reach the store",
			fx2.approvalsQ, fx2.approvalsSeen)
	}

	rec = cpReq(t, s, "/api/v1/approvals?status=bogus")
	if rec.Code != http.StatusBadRequest ||
		!strings.Contains(rec.Body.String(), "invalid_status") {
		t.Fatalf("status = %d body %s: a bad state is a 400 invalid_status",
			rec.Code, rec.Body.String())
	}
}

func TestCrossProjectConversationList(t *testing.T) {
	fx := &cpFakeStore{convs: []ConversationSummaryView{{
		ID: "c-1", ProjectID: "p-1", Title: "fix the flake", Origin: "manual",
	}}, convNext: "cur-1"}
	s, fx2 := cpServer(t, fx)
	rec := cpReq(t, s, "/api/v1/conversations?limit=25&cursor="+EncodeCrossProjectCursor(
		CrossProjectCursor{CreatedAt: time.Now().UTC().Truncate(time.Second), ID: "c-1"}))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", rec.Code, rec.Body.String())
	}
	body := cpDecode[CrossProjectConversationListView](t, rec)
	if len(body.Items) != 1 || body.Items[0].ProjectID != "p-1" {
		t.Fatalf("items = %+v: the existing summary schema + project_id", body.Items)
	}
	if body.NextCursor == nil || *body.NextCursor != "cur-1" {
		t.Fatalf("next_cursor = %v", body.NextCursor)
	}
	if fx2.convLimit != 25 || fx2.convCursor == "" {
		t.Fatalf("limit %d cursor %q: both must reach the store", fx2.convLimit, fx2.convCursor)
	}

	for _, q := range []string{"?limit=0", "?limit=201", "?limit=x", "?cursor=!!!", "?cursor=notbase64"} {
		rec := cpReq(t, s, "/api/v1/conversations"+q)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("%s: status = %d, want 400", q, rec.Code)
		}
	}
}

func TestCrossProjectRoutesUnauthenticated(t *testing.T) {
	s := newTestServer(t, nil, fakeReadiness{expected: 5},
		principalAuth(nil, ErrUnauthenticated))
	RegisterCrossProject(s, &cpFakeStore{})
	for _, target := range []string{
		"/api/v1/runs", "/api/v1/approvals", "/api/v1/conversations",
	} {
		rec := cpReq(t, s, target)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("%s: status = %d, want 401", target, rec.Code)
		}
	}
}

func TestCrossProjectCursorCodec(t *testing.T) {
	c := CrossProjectCursor{
		CreatedAt: time.Date(2026, 10, 19, 7, 30, 5, 123456789, time.UTC),
		ID:        "01987a80-1111-7000-8000-abcdef012345",
	}
	got, err := ParseCrossProjectCursor(EncodeCrossProjectCursor(c))
	if err != nil {
		t.Fatalf("round trip: %v", err)
	}
	if !got.CreatedAt.Equal(c.CreatedAt) || got.ID != c.ID {
		t.Fatalf("round trip = %+v, want %+v", got, c)
	}
	for _, bad := range []string{"", "%%", "not-base64!!!",
		"garbage-without-separator"} {
		if _, err := ParseCrossProjectCursor(bad); err == nil {
			t.Fatalf("%q: parse succeeded, want a refusal", bad)
		}
	}
}
