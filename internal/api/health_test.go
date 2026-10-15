package api

import (
	"errors"
	"net/http"
	"testing"
)

func TestHealth(t *testing.T) {
	s := newTestServer(t, nil, fakeReadiness{expected: 1}, principalAuth(testPrincipal(), nil))
	rec := do(t, s, request(http.MethodGet, "http://localhost:8080/api/v1/system/health", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	body := decodeBody(t, rec)
	if body["status"] != "ok" || body["replica"] != "replica-a" || body["version"] != "1.2.3" {
		t.Fatalf("health body = %v", body)
	}
}

func TestReplicaHeaderOnEveryResponse(t *testing.T) {
	s := newTestServer(t, uiFS(), fakeReadiness{expected: 1}, principalAuth(testPrincipal(), nil))
	for _, tt := range []struct {
		method, target string
	}{
		{http.MethodGet, "http://localhost:8080/api/v1/system/health"},
		{http.MethodGet, "http://localhost:8080/api/v1/nope"},            // 404 problem
		{http.MethodGet, "http://localhost:8080/projects/abc"},           // SPA
		{http.MethodGet, "http://localhost:8080/assets/index-abc123.js"}, // asset
		{http.MethodGet, "http://localhost:8080/auth/login"},             // 404 problem
		{http.MethodPost, "http://localhost:8080/api/v1/projects"},       // CSRF 403
		{http.MethodGet, "http://localhost:8080/boom"},                   // SPA route
	} {
		rec := do(t, s, request(tt.method, tt.target, nil))
		if got := rec.Header().Get(HeaderReplica); got != "replica-a" {
			t.Errorf("%s %s: %s = %q, want replica-a (status %d)", tt.method, tt.target,
				HeaderReplica, got, rec.Code)
		}
		if got := rec.Header().Get(HeaderRequestID); got == "" {
			t.Errorf("%s %s: missing %s", tt.method, tt.target, HeaderRequestID)
		}
	}
}

func TestReadinessReady(t *testing.T) {
	s := newTestServer(t, nil, fakeReadiness{ver: 7, expected: 7}, nil)
	rec := do(t, s, request(http.MethodGet, "http://localhost:8080/api/v1/system/readiness", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body)
	}
	body := decodeBody(t, rec)
	if body["status"] != "ready" {
		t.Fatalf("status = %v, want ready", body["status"])
	}
	if body["schema_version"] != float64(7) || body["expected_schema_version"] != float64(7) {
		t.Fatalf("versions = %v / %v", body["schema_version"], body["expected_schema_version"])
	}
	if _, ok := body["reason"]; ok {
		t.Fatalf("ready body carries a reason: %v", body)
	}
}

func TestReadinessUnavailable(t *testing.T) {
	tests := []struct {
		name    string
		ready   Readiness
		reason  string
		hasVer  bool
		nilRead bool
	}{
		{name: "ping error", ready: fakeReadiness{pingErr: errors.New("dial tcp: refused"), expected: 7}, reason: "datastore unreachable"},
		{name: "schema lookup error", ready: fakeReadiness{verErr: errors.New("no such table"), expected: 7}, reason: "schema version unavailable"},
		{name: "schema behind", ready: fakeReadiness{ver: 6, expected: 7}, reason: "schema migration required", hasVer: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := newTestServer(t, nil, tt.ready, nil)
			rec := do(t, s, request(http.MethodGet, "http://localhost:8080/api/v1/system/readiness", nil))
			if rec.Code != http.StatusServiceUnavailable {
				t.Fatalf("status = %d, want 503", rec.Code)
			}
			body := decodeBody(t, rec)
			if body["status"] != "not_ready" {
				t.Fatalf("status = %v, want not_ready", body["status"])
			}
			if body["reason"] != tt.reason {
				t.Fatalf("reason = %v, want %q", body["reason"], tt.reason)
			}
			if body["expected_schema_version"] != float64(7) {
				t.Fatalf("expected_schema_version = %v", body["expected_schema_version"])
			}
			_, sawVer := body["schema_version"]
			if sawVer != tt.hasVer {
				t.Fatalf("schema_version present = %v, want %v (%v)", sawVer, tt.hasVer, body["schema_version"])
			}
		})
	}
}

func TestReadinessWithoutDatastore(t *testing.T) {
	s := newTestServer(t, nil, nil, nil)
	rec := do(t, s, request(http.MethodGet, "http://localhost:8080/api/v1/system/readiness", nil))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rec.Code)
	}
	if body := decodeBody(t, rec); body["status"] != "not_ready" {
		t.Fatalf("body = %v", body)
	}
}
