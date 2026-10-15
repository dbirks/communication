package api

import (
	"crypto/tls"
	"log/slog"
	"net/http"
	"strings"
	"testing"
)

func TestRequestIDGeneratedAndAdopted(t *testing.T) {
	srv := New(Config{ReplicaName: "r", Logger: discardLogger()}, nil, nil, nil)
	var seen string
	srv.Handle("GET /x", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = RequestIDFrom(r)
		w.WriteHeader(http.StatusNoContent)
	}))

	rec := do(t, srv, request(http.MethodGet, "http://x/x", nil))
	id := rec.Header().Get(HeaderRequestID)
	if len(id) != 32 || !isHex(id) {
		t.Fatalf("generated request id %q: want 32 hex chars", id)
	}
	if seen != id {
		t.Fatalf("handler saw %q, response header %q", seen, id)
	}

	rec = do(t, srv, request(http.MethodGet, "http://x/x", map[string]string{HeaderRequestID: " trace-42 "}))
	if got := rec.Header().Get(HeaderRequestID); got != "trace-42" {
		t.Fatalf("client request id = %q, want trace-42", got)
	}
}

func isHex(s string) bool {
	for _, c := range s {
		if !strings.ContainsRune("0123456789abcdef", c) {
			return false
		}
	}
	return true
}

func TestAccessLogRecordsRequest(t *testing.T) {
	var out strings.Builder
	srv := New(Config{ReplicaName: "r", Logger: slog.New(slog.NewJSONHandler(&out, nil))}, nil, nil, nil)
	srv.Handle("GET /api/v1/ping", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		WriteJSON(w, http.StatusOK, map[string]string{"ok": "1"})
	}))
	rec := do(t, srv, request(http.MethodGet, "http://x/api/v1/ping?after=12", map[string]string{
		"Cookie":        "communication_session=supersecrettoken",
		"Authorization": "Bearer supersecretbearer",
	}))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	logged := out.String()
	for _, want := range []string{
		`"msg":"http request"`, `"method":"GET"`, `"path":"/api/v1/ping"`, `"status":200`,
		`"request_id":"`, `"duration_ms":`, `"query":"after=12"`,
	} {
		if !strings.Contains(logged, want) {
			t.Errorf("access log missing %s\n%s", want, logged)
		}
	}
	for _, leak := range []string{"supersecrettoken", "supersecretbearer", "communication_session", "Bearer"} {
		if strings.Contains(logged, leak) {
			t.Errorf("access log leaked %q\n%s", leak, logged)
		}
	}
}

func TestAccessLogRedactsAuthCallbackQuery(t *testing.T) {
	var out strings.Builder
	srv := New(Config{ReplicaName: "r", Logger: slog.New(slog.NewJSONHandler(&out, nil))}, nil, nil, nil)
	srv.Handle("GET /auth/callback", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusFound)
	}))
	do(t, srv, request(http.MethodGet, "http://x/auth/callback?code=onetimecode&state=statevalue", nil))
	logged := out.String()
	if strings.Contains(logged, "onetimecode") || strings.Contains(logged, "statevalue") {
		t.Errorf("auth callback query was logged\n%s", logged)
	}
	if !strings.Contains(logged, `"path":"/auth/callback"`) {
		t.Errorf("auth callback path was not logged\n%s", logged)
	}
}

func TestRequireAuth(t *testing.T) {
	ok := testPrincipal()
	tests := []struct {
		name string
		auth Authenticator
		want int
	}{
		{"no session", principalAuth(nil, ErrUnauthenticated), http.StatusUnauthorized},
		{"nil principal without error", principalAuth(nil, nil), http.StatusUnauthorized},
		{"store unreachable", principalAuth(nil, errStoreDown), http.StatusServiceUnavailable},
		{"valid session", principalAuth(ok, nil), http.StatusOK},
		{"no authenticator configured", nil, http.StatusUnauthorized},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			srv := newTestServer(t, nil, fakeReadiness{expected: 1}, tt.auth)
			rec := do(t, srv, request(http.MethodGet, "http://localhost:8080/api/v1/me", nil))
			if rec.Code != tt.want {
				t.Fatalf("status = %d, want %d (body %s)", rec.Code, tt.want, rec.Body)
			}
			if tt.want == http.StatusOK {
				if body := decodeBody(t, rec); body["id"] != ok.UserID {
					t.Fatalf("body = %v, want the principal id", body)
				}
				return
			}
			p := decodeProblem(t, rec)
			if p.Status != tt.want || p.Type != "about:blank" || p.Title == "" || p.Detail == "" {
				t.Fatalf("problem = %+v", p)
			}
		})
	}
}

func TestRequireCSRFForMutations(t *testing.T) {
	ok := testPrincipal()
	tests := []struct {
		name   string
		method string
		path   string
		header map[string]string
		want   int
	}{
		{"post without token", http.MethodPost, "/api/v1/projects", nil, http.StatusForbidden},
		{"post wrong token", http.MethodPost, "/api/v1/projects", map[string]string{HeaderCSRFToken: "wrong"}, http.StatusForbidden},
		{"post right token", http.MethodPost, "/api/v1/projects", map[string]string{HeaderCSRFToken: ok.CSRFToken}, http.StatusCreated},
		{"get ignores token", http.MethodGet, "/api/v1/me", nil, http.StatusOK},
		{"methodless pattern guards post", http.MethodPost, "/api/v1/any", nil, http.StatusForbidden},
		{"methodless pattern allows get", http.MethodGet, "/api/v1/any", nil, http.StatusOK},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			srv := newTestServer(t, nil, fakeReadiness{expected: 1}, principalAuth(ok, nil))
			rec := do(t, srv, request(tt.method, "http://localhost:8080"+tt.path, tt.header))
			if rec.Code != tt.want {
				t.Fatalf("%s %s: status = %d, want %d (body %s)", tt.method, tt.path, rec.Code, tt.want, rec.Body)
			}
			if tt.want == http.StatusForbidden {
				if p := decodeProblem(t, rec); p.Title != "CSRF Token Invalid" {
					t.Fatalf("problem = %+v", p)
				}
			}
		})
	}
}

func TestCSRFOriginChecks(t *testing.T) {
	ok := testPrincipal()
	good := map[string]string{HeaderCSRFToken: ok.CSRFToken}
	tests := []struct {
		name   string
		target string
		public string
		header map[string]string
		https  bool
		want   int
	}{
		{
			name: "origin equals public url", target: "http://localhost:8080/api/v1/projects",
			public: "http://localhost:8080", header: withHeaders(good, "Origin", "http://localhost:8080"),
			want: http.StatusCreated,
		},
		{
			name: "origin equals request host when public url differs", target: "http://localhost:8080/api/v1/projects",
			public: "http://api.internal:9999", header: withHeaders(good, "Origin", "http://localhost:8080"),
			want: http.StatusCreated,
		},
		{
			name: "origin mismatch", target: "http://localhost:8080/api/v1/projects",
			public: "http://localhost:8080", header: withHeaders(good, "Origin", "http://evil.example"),
			want: http.StatusForbidden,
		},
		{
			name: "scheme mismatch", target: "http://localhost:8080/api/v1/projects",
			public: "http://localhost:8080", header: withHeaders(good, "Origin", "https://localhost:8080"),
			want: http.StatusForbidden,
		},
		{
			name: "no origin header", target: "http://localhost:8080/api/v1/projects",
			public: "http://localhost:8080", header: good, want: http.StatusCreated,
		},
		{
			name: "forwarded proto sets self scheme", target: "http://lb.example.com/api/v1/projects",
			public: "", header: withHeaders(withHeaders(good, "Origin", "https://lb.example.com"), "X-Forwarded-Proto", "https"),
			want: http.StatusCreated,
		},
		{
			name: "forwarded proto missing", target: "http://lb.example.com/api/v1/projects",
			public: "", header: withHeaders(good, "Origin", "https://lb.example.com"),
			want: http.StatusForbidden,
		},
		{
			name: "tls connection is https", target: "http://lb.example.com/api/v1/projects",
			public: "", header: withHeaders(good, "Origin", "https://lb.example.com"), https: true,
			want: http.StatusCreated,
		},
		{
			name: "bad public url falls back to request origin", target: "http://localhost:8080/api/v1/projects",
			public: "not a url", header: withHeaders(good, "Origin", "http://localhost:8080"),
			want: http.StatusCreated,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			srv := newTestServerWith(t, Config{ReplicaName: "r", PublicURL: tt.public}, nil, fakeReadiness{expected: 1}, principalAuth(ok, nil))
			r := request(http.MethodPost, tt.target, tt.header)
			if tt.https {
				r.TLS = &tls.ConnectionState{}
			}
			rec := do(t, srv, r)
			if rec.Code != tt.want {
				t.Fatalf("status = %d, want %d (body %s)", rec.Code, tt.want, rec.Body)
			}
		})
	}
}

func withHeaders(h map[string]string, k, v string) map[string]string {
	out := make(map[string]string, len(h)+1)
	for kk, vv := range h {
		out[kk] = vv
	}
	out[k] = v
	return out
}

func TestPanicBecomesProblem500(t *testing.T) {
	var out strings.Builder
	srv := New(Config{ReplicaName: "r", Logger: slog.New(slog.NewJSONHandler(&out, nil))}, nil, nil, nil)
	srv.Handle("GET /api/v1/boom", http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		var m map[string]string
		m["boom"] = "now" // assignment to entry in nil map
	}))
	rec := do(t, srv, request(http.MethodGet, "http://localhost:8080/api/v1/boom", nil))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500 (body %s)", rec.Code, rec.Body)
	}
	p := decodeProblem(t, rec)
	if p.Title != "Internal Server Error" || p.Status != 500 || p.Type != "about:blank" {
		t.Fatalf("problem = %+v", p)
	}
	if strings.Contains(rec.Body.String(), "assignment to entry in nil map") {
		t.Fatal("panic value leaked to the client")
	}
	logged := out.String()
	if !strings.Contains(logged, "assignment to entry in nil map") {
		t.Errorf("panic not logged:\n%s", logged)
	}
	if !strings.Contains(logged, `"status":500`) {
		t.Errorf("access log did not record the 500:\n%s", logged)
	}
}

func TestPanicBeforeAnyWrite(t *testing.T) {
	srv := New(Config{ReplicaName: "r"}, nil, nil, nil)
	srv.Handle("GET /api/v1/panic", http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		panic("kaboom")
	}))
	rec := do(t, srv, request(http.MethodGet, "http://localhost:8080/api/v1/panic", nil))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
	if got := decodeProblem(t, rec); got.Detail == "" {
		t.Fatalf("problem has no detail: %+v", got)
	}
}
