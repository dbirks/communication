package api

// The "used by" usage reports: handler tests for GET /api/v1/agent-profiles/
// {profileId}/usage and GET /api/v1/node-templates/{templateId}/usage — the
// 404 (invisible subject) arm and the response shape. The database behind the
// store calls is fake here; the real-Postgres semantics are
// internal/store/postgres/usage_test.go.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func usageGet(t *testing.T, s *Server, target string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "http://localhost:8080"+target, nil)
	req.Header.Set("Origin", "http://localhost:8080")
	return do(t, s, req)
}

func TestGetAgentProfileUsageShape(t *testing.T) {
	store := &cnvFakeStore{}
	var revisionNumber int = 4
	store.usage = AgentProfileUsage{
		WorkflowCount: 2,
		StepCount:     3,
		Uses: []UsageUse{{
			PipelineID:     "01987a6c-4d5e-7f1a-9b2c-3d4e5f6a7b80",
			PipelineName:   "feature-development",
			Source:         UsageSourceRevision,
			RevisionNumber: &revisionNumber,
			NodeID:         "implement",
		}},
	}
	s := cnvMount(t, store, nil, cnvCaller(cnvTUserA))
	rec := usageGet(t, s, "/api/v1/agent-profiles/"+cnvTProfile+"/usage")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET usage = %d (%s)", rec.Code, rec.Body)
	}
	if got := rec.Header().Get("Content-Type"); !strings.HasPrefix(got, "application/json") {
		t.Errorf("content-type = %q, want application/json", got)
	}
	var got AgentProfileUsage
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.WorkflowCount != 2 || got.StepCount != 3 {
		t.Errorf("workflow_count=%d step_count=%d, want 2/3", got.WorkflowCount, got.StepCount)
	}
	if len(got.Uses) != 1 {
		t.Fatalf("uses = %+v, want one row", got.Uses)
	}
	u := got.Uses[0]
	if u.PipelineID != "01987a6c-4d5e-7f1a-9b2c-3d4e5f6a7b80" || u.PipelineName != "feature-development" {
		t.Errorf("use = %+v", u)
	}
	if u.Source != UsageSourceRevision {
		t.Errorf("source = %q, want revision", u.Source)
	}
	if u.RevisionNumber == nil || *u.RevisionNumber != 4 {
		t.Errorf("revision_number = %v, want 4", u.RevisionNumber)
	}
	if u.DraftID != nil {
		t.Errorf("draft_id = %v, want null", *u.DraftID)
	}
	if got.Truncated {
		t.Errorf("truncated = true, want false")
	}
	if len(store.usageCalls) != 1 || store.usageCalls[0] != cnvTProfile {
		t.Errorf("usageCalls = %v, want [%s]", store.usageCalls, cnvTProfile)
	}
}

func TestGetAgentProfileUsageInvisibleIsNotFound(t *testing.T) {
	store := &cnvFakeStore{}
	store.usageErr = ErrProfileNotFound
	s := cnvMount(t, store, nil, cnvCaller(cnvTUserA))
	rec := usageGet(t, s, "/api/v1/agent-profiles/"+cnvTProfile+"/usage")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("GET usage for an invisible profile = %d, want 404 (%s)", rec.Code, rec.Body)
	}
	if got := rec.Header().Get("Content-Type"); !strings.HasPrefix(got, "application/problem+json") {
		t.Errorf("content-type = %q, want application/problem+json", got)
	}
}

func TestGetNodeTemplateUsageShape(t *testing.T) {
	store := &ntFakeStore{}
	s := ntMount(t, store, ntCaller(false))
	rec := usageGet(t, s, "/api/v1/node-templates/01987a71-3333-7000-8000-abcdef012345/usage")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET usage = %d (%s)", rec.Code, rec.Body)
	}
	var got NodeTemplateUsage
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.WorkflowCount != 0 || got.StepCount != 0 || got.Truncated {
		t.Errorf("report = %+v, want an empty honest zero", got)
	}
	if got.Uses == nil {
		t.Errorf("uses = %v, want an empty array", got.Uses)
	}
}
