package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

// --- shared fakes -------------------------------------------------------

type fakeReadiness struct {
	pingErr  error
	ver      int64
	verErr   error
	expected int64
}

func (f fakeReadiness) Ping(context.Context) error { return f.pingErr }

func (f fakeReadiness) SchemaVersion(context.Context) (int64, error) {
	return f.ver, f.verErr
}

func (f fakeReadiness) ExpectedSchemaVersion() int64 { return f.expected }

func principalAuth(p *Principal, err error) Authenticator {
	return AuthenticatorFunc(func(*http.Request) (*Principal, error) { return p, err })
}

func testPrincipal() *Principal {
	return &Principal{
		UserID:         "u-1",
		OrganizationID: "o-1",
		DisplayName:    "David",
		Email:          "david@example.com",
		CSRFToken:      "csrf-token-value",
		IsOrgAdmin:     false,
	}
}

// newTestServer returns a server with one authed GET route, one authed
// mutation and one method-less authed route so tests exercise the full chain.
func newTestServer(t *testing.T, ui fs.FS, ready Readiness, auth Authenticator) *Server {
	t.Helper()
	return newTestServerWith(t, Config{ReplicaName: "replica-a", Version: "1.2.3", PublicURL: "http://localhost:8080"}, ui, ready, auth)
}

func newTestServerWith(t *testing.T, cfg Config, ui fs.FS, ready Readiness, auth Authenticator) *Server {
	t.Helper()
	if cfg.Logger == nil {
		cfg.Logger = discardLogger()
	}
	s := New(cfg, ready, auth, ui)
	s.HandleAuthed("GET /api/v1/me", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p, ok := PrincipalFrom(r.Context())
		if !ok {
			t.Error("principal missing from context")
		}
		WriteJSON(w, http.StatusOK, map[string]string{"id": p.UserID})
	}))
	s.HandleAuthed("POST /api/v1/projects", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		WriteJSON(w, http.StatusCreated, map[string]string{"status": "created"})
	}))
	s.HandleAuthed("/api/v1/any", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		WriteJSON(w, http.StatusOK, map[string]string{"method": r.Method})
	}))
	return s
}

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// errStoreDown stands in for a datastore error that is not "unauthenticated".
var errStoreDown = errors.New("pool: connection timeout")

func do(t *testing.T, h http.Handler, req *http.Request) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func request(method, target string, header map[string]string) *http.Request {
	r := httptest.NewRequest(method, target, nil)
	for k, v := range header {
		r.Header.Set(k, v)
	}
	return r
}

func decodeProblem(t *testing.T, rec *httptest.ResponseRecorder) Problem {
	t.Helper()
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, ProblemJSON) {
		t.Fatalf("content-type = %q, want %s", ct, ProblemJSON)
	}
	var p Problem
	if err := json.Unmarshal(rec.Body.Bytes(), &p); err != nil {
		t.Fatalf("decode problem %q: %v", rec.Body.String(), err)
	}
	return p
}

func decodeBody(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &m); err != nil {
		t.Fatalf("decode body %q: %v", rec.Body.String(), err)
	}
	return m
}

func TestPrincipalContextRoundTrip(t *testing.T) {
	p := testPrincipal()
	ctx := WithPrincipal(context.Background(), p)
	got, ok := PrincipalFrom(ctx)
	if !ok || got != p {
		t.Fatalf("PrincipalFrom() = %v, %v; want the stored principal", got, ok)
	}
	if _, ok := PrincipalFrom(context.Background()); ok {
		t.Fatal("PrincipalFrom(empty) reported a principal")
	}
}

func TestErrUnauthenticatedSentinel(t *testing.T) {
	rec := do(t, newTestServer(t, nil, fakeReadiness{expected: 1}, principalAuth(nil, ErrUnauthenticated)),
		request(http.MethodGet, "http://localhost:8080/api/v1/me", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401 (body %s)", rec.Code, rec.Body)
	}
}

// uiFS is a minimal Vite-shaped build output.
func uiFS() fstest.MapFS {
	return fstest.MapFS{
		"index.html":             &fstest.MapFile{Data: []byte("<!doctype html><title>Communication</title>")},
		"assets/index-abc123.js": &fstest.MapFile{Data: []byte("console.log(1)")},
		"favicon.ico":            &fstest.MapFile{Data: []byte("icon")},
	}
}
