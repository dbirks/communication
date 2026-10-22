package api

// ADR-0054 amendment 1 (server-side APM lock, implementation): the lock
// dispatch and status reads behind POST/GET /api/v1/agent-profiles/{profileId}/apm/lock.
//
// The control plane is the only writer of profile state, and the worker is the
// only process that resolves a package ref (ADR-0054 Option B). The POST is
// therefore a thin trigger: it validates the profile's pin is complete, queues a
// lock request, and answers 202 with the new request's id — the resolve's outcome
// arrives later through the worker-reported lock result.
//
// What this file pins is the HTTP surface the handler owns: the 202 Accepted
// shape, the status GET's answer, the CSRF gate before the store is reached, and
// the anonymous arm. The precondition refusals (404 invisible / 422
// apm_pin_incomplete) are the store's, proven in the Postgres integration tests
// and shared with the PATCH triple's refusal shape.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

const apmLockURL = "http://localhost:8080/api/v1/agent-profiles"

func apmLockSend(t *testing.T, s *Server, method, target string, body any) *httptest.ResponseRecorder {
	t.Helper()
	return profSend(t, s, method, target, body)
}

func TestPostAgentProfileAPMLockAnswers202(t *testing.T) {
	store := cnvNewFakeStore()
	s := cnvMount(t, store, nil, profAdminCaller("admin"))
	rec := apmLockSend(t, s, http.MethodPost, apmLockURL+"/"+cnvTProfile+"/apm/lock", nil)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("POST apm/lock = %d, want 202 (%s)", rec.Code, rec.Body)
	}
	var body struct {
		RequestID string `json:"request_id"`
		Status    string `json:"status"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode 202 body %q: %v", rec.Body.String(), err)
	}
	if body.Status != "queued" || body.RequestID == "" {
		t.Errorf("202 body = %+v, want a queued request id", body)
	}
	if len(store.apmLockCalls) != 1 || store.apmLockCalls[0].profileID != cnvTProfile {
		t.Errorf("store lock calls = %+v, want one for %s", store.apmLockCalls, cnvTProfile)
	}
}

func TestGetAgentProfileAPMLockStatus(t *testing.T) {
	store := cnvNewFakeStore()
	s := cnvMount(t, store, nil, profAdminCaller("admin"))
	rec := apmLockSend(t, s, http.MethodGet, apmLockURL+"/"+cnvTProfile+"/apm/lock", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET apm/lock = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var body struct {
		RequestID string `json:"request_id"`
		Status    string `json:"status"`
		Error     string `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode status body %q: %v", rec.Body.String(), err)
	}
	if body.Status != "done" {
		t.Errorf("status body = %+v, want the reported done status", body)
	}
	if len(store.apmLockReads) != 1 || store.apmLockReads[0] != cnvTProfile {
		t.Errorf("store lock reads = %+v, want one for %s", store.apmLockReads, cnvTProfile)
	}
}

func TestPostAgentProfileAPMLockWithoutCSRF(t *testing.T) {
	store := cnvNewFakeStore()
	s := cnvMount(t, store, nil, profAdminCaller("admin"))
	req := httptest.NewRequest(http.MethodPost, apmLockURL+"/"+cnvTProfile+"/apm/lock", nil)
	req.Header.Set("Origin", "http://localhost:8080")
	rec := do(t, s, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("POST apm/lock without the CSRF pair = %d, want 403 (%s)", rec.Code, rec.Body)
	}
	if len(store.apmLockCalls) != 0 {
		t.Errorf("store reached before the CSRF gate: %+v", store.apmLockCalls)
	}
}

func TestGetAgentProfileAPMLockAnonymousIsUnauthorized(t *testing.T) {
	store := cnvNewFakeStore()
	s := cnvMount(t, store, nil, principalAuth(nil, ErrUnauthenticated))
	rec := apmLockSend(t, s, http.MethodGet, apmLockURL+"/"+cnvTProfile+"/apm/lock", nil)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("GET apm/lock anonymous = %d, want 401 (%s)", rec.Code, rec.Body)
	}
}
