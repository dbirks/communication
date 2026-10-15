package api

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestUnknownAPIRouteIsProblem404(t *testing.T) {
	srv := newTestServer(t, uiFS(), fakeReadiness{expected: 1}, principalAuth(testPrincipal(), nil))
	for _, target := range []string{
		"http://localhost:8080/api/v1/nope",
		"http://localhost:8080/api/v1/projects",
		"http://localhost:8080/api/",
		"http://localhost:8080/api",
		"http://localhost:8080/auth/login",
		"http://localhost:8080/auth/nope",
		"http://localhost:8080/auth",
	} {
		rec := do(t, srv, request(http.MethodGet, target, nil))
		if rec.Code != http.StatusNotFound {
			t.Fatalf("GET %s: status = %d, want 404 (body %s)", target, rec.Code, rec.Body)
		}
		p := decodeProblem(t, rec)
		if p.Type != "about:blank" || p.Status != http.StatusNotFound || p.Title != "Not Found" {
			t.Fatalf("GET %s: problem = %+v", target, p)
		}
	}
	// A method the API does not serve is a 404 too, not an HTML body.
	rec := do(t, srv, request(http.MethodPost, "http://localhost:8080/api/v1/system/health", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
	decodeProblem(t, rec)
}

func TestRegisteredRoutesReachHandlers(t *testing.T) {
	srv := newTestServer(t, uiFS(), fakeReadiness{expected: 1}, principalAuth(testPrincipal(), nil))
	srv.HandleAuthed("GET /api/v1/projects/{projectId}", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		WriteJSON(w, http.StatusOK, map[string]string{"project_id": r.PathValue("projectId")})
	}))

	rec := do(t, srv, request(http.MethodGet, "http://localhost:8080/api/v1/projects/p-42", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d (body %s)", rec.Code, rec.Body)
	}
	if body := decodeBody(t, rec); body["project_id"] != "p-42" {
		t.Fatalf("PathValue not delivered: %v", body)
	}

	// HEAD matches a GET pattern (net/http.ServeMux).
	if rec := do(t, srv, request(http.MethodHead, "http://localhost:8080/api/v1/me", nil)); rec.Code != http.StatusOK {
		t.Fatalf("HEAD /api/v1/me: status = %d", rec.Code)
	}

	// CSRF never blocks a safe method, even from a foreign origin.
	rec = do(t, srv, request(http.MethodGet, "http://localhost:8080/api/v1/me",
		map[string]string{"Origin": "http://evil.example"}))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET from foreign origin: status = %d, want 200", rec.Code)
	}
}

func TestNewDefaults(t *testing.T) {
	srv := New(Config{ReplicaName: "solo"}, nil, nil, nil)
	rec := do(t, srv, request(http.MethodGet, "http://x/api/v1/system/health", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	body := decodeBody(t, rec)
	if body["version"] != "dev" {
		t.Fatalf("version = %v, want dev", body["version"])
	}
	if body["replica"] != "solo" {
		t.Fatalf("replica = %v", body["replica"])
	}
}

func TestHandlePanicsOnBadPattern(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("Handle accepted an invalid pattern")
		}
	}()
	New(Config{}, nil, nil, nil).Handle("GET /bad{", http.NotFoundHandler())
}

func TestChainAppliesToEveryRoute(t *testing.T) {
	srv := newTestServer(t, uiFS(), fakeReadiness{expected: 1}, principalAuth(nil, ErrUnauthenticated))
	rec := do(t, srv, request(http.MethodGet, "http://localhost:8080/api/v1/me", map[string]string{HeaderRequestID: "abc123"}))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
	for h, want := range map[string]string{HeaderRequestID: "abc123", HeaderReplica: "replica-a"} {
		if got := rec.Header().Get(h); got != want {
			t.Fatalf("%s = %q, want %q", h, got, want)
		}
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, ProblemJSON) {
		t.Fatalf("content-type = %q", ct)
	}
}

// TestFlusherPassthrough protects the SSE handlers registered by the events
// task: they assert http.Flusher on the ResponseWriter they are handed.
func TestFlusherPassthrough(t *testing.T) {
	srv := New(Config{ReplicaName: "r", Logger: discardLogger()}, nil, nil, nil)
	srv.Handle("GET /api/v1/stream", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f, ok := w.(http.Flusher)
		if !ok {
			t.Error("handler ResponseWriter is not an http.Flusher")
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, "event: project.created\ndata: {}\n\n")
		f.Flush()
		if err := http.NewResponseController(w).Flush(); err != nil {
			t.Errorf("ResponseController.Flush: %v", err)
		}
	}))
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "http://x/api/v1/stream", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "project.created") {
		t.Fatalf("body = %q", rec.Body)
	}
}
