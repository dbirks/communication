package api

import (
	"crypto/tls"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
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

// --- app-origin security headers (audit F5) --------------------------------
//
// The policy is written against the real build (`pnpm --dir ui build`, then an
// inspection of ui/dist/index.html and ui/dist/assets/*): one external module
// script and one external stylesheet, self-hosted woff/woff2 fonts, no inline
// script, no inline event handler, no eval/new Function, no CDN or third-party
// fetch, blob: object URLs for client-side downloads, EventSource on the same
// origin, and one cross-origin iframe — the artifact preview host.

// wantCSP is the policy pinned verbatim, so editing appCSPBaseTemplate cannot
// pass by agreeing with itself.
const wantCSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
	"img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'self'; " +
	"frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'"

const wantPermissionsPolicy = "camera=(), geolocation=(), microphone=(self)"

// cspDirectives parses a policy into directive → value ("frame-src" →
// "'self' http://x"), so a test can assert one directive without re-stating
// the whole string.
func cspDirectives(t *testing.T, policy string) map[string]string {
	t.Helper()
	out := map[string]string{}
	for _, part := range strings.Split(policy, ";") {
		fields := strings.Fields(part)
		if len(fields) == 0 {
			continue
		}
		out[fields[0]] = strings.Join(fields[1:], " ")
	}
	return out
}

func TestSecurityHeadersOnSPAAndAPI(t *testing.T) {
	// Pin the optional knobs off, so an operator's environment cannot change
	// what this test proves.
	t.Setenv(EnvHSTS, "")
	t.Setenv(EnvPreviewBaseURL, "")
	srv := newTestServer(t, uiFS(), fakeReadiness{expected: 1}, principalAuth(testPrincipal(), nil))

	for _, path := range []string{
		"/",                       // the SPA shell (index.html)
		"/projects/abc",           // the shell again, client-side route
		"/assets/index-abc123.js", // a hashed build asset
		"/api/v1/me",              // authed API JSON
		"/api/v1/system/health",   // public API JSON
		"/api/v1/does-not-exist",  // problem+json 404
		"/auth/login",             // the OIDC entry point
	} {
		rec := do(t, srv, request(http.MethodGet, "http://localhost:8080"+path, nil))
		h := rec.Header()
		if got := h.Get("Content-Security-Policy"); got != wantCSP {
			t.Errorf("%s: CSP = %q, want %q", path, got, wantCSP)
		}
		if len(h.Values("Content-Security-Policy")) != 1 {
			t.Errorf("%s: %d CSP headers, want exactly 1", path, len(h.Values("Content-Security-Policy")))
		}
		for name, want := range map[string]string{
			"X-Content-Type-Options": "nosniff",
			"Referrer-Policy":        "same-origin",
			"X-Frame-Options":        "DENY",
			"Permissions-Policy":     wantPermissionsPolicy,
		} {
			if got := h.Get(name); got != want {
				t.Errorf("%s: %s = %q, want %q", path, name, got, want)
			}
		}
		// TLS terminates at the proxy, so HSTS is opt-in only.
		if got := h.Get("Strict-Transport-Security"); got != "" {
			t.Errorf("%s: Strict-Transport-Security = %q, want it off by default", path, got)
		}
	}
}

func TestSecurityHeadersKeepEveryDirective(t *testing.T) {
	// A directive list checked by name, so a dropped or renamed directive fails
	// even if the string above is edited in lockstep.
	d := cspDirectives(t, appCSP("http://preview.localhost:18084"))
	for name, want := range map[string]string{
		"default-src":     "'self'",
		"script-src":      "'self'",
		"style-src":       "'self' 'unsafe-inline'",
		"img-src":         "'self' data: blob:",
		"font-src":        "'self' data:",
		"connect-src":     "'self'",
		"frame-ancestors": "'none'",
		"base-uri":        "'self'",
		"form-action":     "'self'",
		"object-src":      "'none'",
	} {
		if got := d[name]; got != want {
			t.Errorf("%s = %q, want %q", name, got, want)
		}
	}
	// The bundle needs no code execution it did not declare: no unsafe-eval
	// anywhere, and nothing wide open.
	if strings.Contains(appCSP(""), "'unsafe-eval'") || strings.Contains(appCSP(""), "*") {
		t.Errorf("the policy widened itself: %s", appCSP(""))
	}
	// The artifact preview iframe is the one cross-origin frame the app renders
	// (ADR-0020 D6): its origin must be framed, and only it.
	if got, want := d["frame-src"], "'self' http://preview.localhost:18084"; got != want {
		t.Errorf("frame-src = %q, want %q", got, want)
	}
	if got := cspDirectives(t, appCSP(""))["frame-src"]; got != "'self'" {
		t.Errorf("frame-src with no preview origin = %q, want 'self'", got)
	}
	// A bare host is a host, not a path: it gains the safe scheme.
	if got := cspDirectives(t, appCSP("preview.example.com/"))["frame-src"]; got != "'self' https://preview.example.com" {
		t.Errorf("frame-src from a bare host = %q", got)
	}
}

func TestSecurityHeadersReadThePreviewOriginFromEnv(t *testing.T) {
	t.Setenv(EnvPreviewBaseURL, "http://preview.localhost:18084")
	t.Setenv(EnvHSTS, "1")
	srv := newTestServer(t, uiFS(), fakeReadiness{expected: 1}, principalAuth(testPrincipal(), nil))
	rec := do(t, srv, request(http.MethodGet, "http://localhost:8080/", nil))
	if got := rec.Header().Get("Content-Security-Policy"); !strings.Contains(got,
		"frame-src 'self' http://preview.localhost:18084") {
		t.Fatalf("CSP = %q, want the env preview origin framed", got)
	}
	// COMMUNICATION_HSTS=1 is the operator's switch for a deployment that only
	// ever answers over TLS (the proxy terminates it, so the binary cannot know).
	if got := rec.Header().Get("Strict-Transport-Security"); got != "max-age=31536000" {
		t.Fatalf("Strict-Transport-Security = %q, want max-age=31536000", got)
	}
	// An explicit Config field wins over the environment.
	explicit := New(Config{ReplicaName: "r", Logger: discardLogger(), PreviewOrigin: "https://p.example"}, nil, nil, nil)
	rec = do(t, explicit, request(http.MethodGet, "http://localhost:8080/", nil))
	if got := rec.Header().Get("Content-Security-Policy"); !strings.Contains(got, "frame-src 'self' https://p.example") {
		t.Fatalf("explicit PreviewOrigin ignored: %q", got)
	}
}

// A handler that owns one of these names keeps its own value: the middleware
// runs first, so the handler's Set replaces it (artifact content responses set
// their own nosniff/Content-Type; nothing here may fight them).
func TestSecurityHeadersDoNotOverrideHandlerHeaders(t *testing.T) {
	t.Setenv(EnvPreviewBaseURL, "")
	srv := New(Config{ReplicaName: "r", Logger: discardLogger()}, nil, nil, nil)
	srv.Handle("GET /api/v1/own-headers", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Security-Policy", "default-src 'none'")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		WriteJSON(w, http.StatusOK, map[string]string{"ok": "1"})
	}))
	rec := do(t, srv, request(http.MethodGet, "http://localhost:8080/api/v1/own-headers", nil))
	h := rec.Header()
	if got := h.Get("Content-Security-Policy"); got != "default-src 'none'" {
		t.Fatalf("CSP = %q, want the handler's own value", got)
	}
	if got := h.Get("Referrer-Policy"); got != "no-referrer" {
		t.Fatalf("Referrer-Policy = %q, want the handler's own value", got)
	}
	// Names the handler left alone still carry the backstop.
	if got := h.Get("X-Frame-Options"); got != "DENY" {
		t.Fatalf("X-Frame-Options = %q, want DENY", got)
	}
}

// The preview origin's header set is ADR-0020's, verbatim, and is asserted
// byte-for-byte by TestPreviewOriginServesTheSandboxHeaderSet. This test pins
// the other half: the app-origin middleware never touches that response, so
// adding a second Content-Security-Policy (which browsers intersect) or an
// X-Frame-Options there is a regression.
func TestPreviewResponsesCarryNoAppHeaders(t *testing.T) {
	t.Setenv(EnvHSTS, "1") // even switched on, it must not reach /preview/*
	doc := []byte("<!doctype html><title>p</title>")
	store, b := artNewFakeStore(), newArtFakeBytes()
	b.objects[artTestKey] = doc
	store.put(artView("html", "standard", "ready", "contributor"))
	s := artNewServer(t, store, b, PreviewConfig{}, nil)
	tok := artMintToken(t, artTestID, artTestDigest, time.Now().Add(time.Minute))

	req := httptest.NewRequest(http.MethodGet, artPreviewBase+"/preview/"+tok, nil)
	req.Host = artPreviewHost
	rec := do(t, s, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d (body %s)", rec.Code, rec.Body)
	}
	h := rec.Header()
	if got := len(h.Values("Content-Security-Policy")); got != 2 {
		t.Fatalf("CSP headers = %d, want the preview origin's own 2 (sandbox + document), got %q",
			got, h.Values("Content-Security-Policy"))
	}
	for _, name := range []string{"X-Frame-Options", "Permissions-Policy", "Strict-Transport-Security"} {
		if got := h.Get(name); got != "" {
			t.Errorf("%s on a preview response = %q, want it untouched", name, got)
		}
	}
	if got := h.Get("Referrer-Policy"); got != "no-referrer" {
		t.Errorf("Referrer-Policy = %q, want the preview origin's no-referrer", got)
	}
	// The app origin refusing a preview path is still a plain problem+json 404;
	// it carries the app headers, and never the preview document.
	rec = do(t, s, request(http.MethodGet, artPublicOrigin+"/preview/"+tok, nil))
	if rec.Code != http.StatusNotFound || !strings.Contains(rec.Header().Get("Content-Type"), ProblemJSON) {
		t.Fatalf("app origin /preview = %d %s", rec.Code, rec.Header().Get("Content-Type"))
	}
}

// --- X-Request-ID (audit F4) ----------------------------------------------

func TestRequestIDAdoptsOnlySanitizableValues(t *testing.T) {
	long64 := strings.Repeat("a", maxRequestIDLen)
	tests := []struct {
		name string
		in   string
		want string // "" means: expect a freshly generated id
	}{
		{"plain", "trace-42", "trace-42"},
		{"surrounding space is trimmed", " trace-42 ", "trace-42"},
		{"dots and underscores", "a.b_c-1.2.3", "a.b_c-1.2.3"},
		{"exactly 64 chars", long64, long64},
		{"absent", "", ""},
		{"only space", "   ", ""},
		{"65 chars", strings.Repeat("a", maxRequestIDLen+1), ""},
		{"internal space", "trace 42", ""},
		{"newline", "trace\n42", ""},
		{"header injection", "x\r\nSet-Cookie: a=b", ""},
		{"quotes and slashes", `a"b/c\`, ""},
		{"html", "<script>", ""},
		{"non-ascii", "héllo", ""},
		{"emoji", "🥸", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			srv := New(Config{ReplicaName: "r", Logger: discardLogger()}, nil, nil, nil)
			var inContext string
			srv.Handle("GET /x", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				inContext = RequestIDFrom(r)
				w.WriteHeader(http.StatusNoContent)
			}))
			hdr := map[string]string{}
			if tt.in != "" {
				hdr[HeaderRequestID] = tt.in
			}
			rec := do(t, srv, request(http.MethodGet, "http://x/x", hdr))
			got := rec.Header().Get(HeaderRequestID)
			if tt.want == "" {
				if len(got) != 32 || !isHex(got) {
					t.Fatalf("rejected %q but echoed %q, want a fresh 32-hex id", tt.in, got)
				}
			} else if got != tt.want {
				t.Fatalf("X-Request-ID = %q, want %q", got, tt.want)
			}
			// The logged/echoed id are the same value; a forged id must never
			// reach either.
			if inContext != got {
				t.Fatalf("handler context id %q != response id %q", inContext, got)
			}
			if strings.Contains(rec.Header().Get(HeaderRequestID), "\n") ||
				strings.Contains(rec.Header().Get(HeaderRequestID), "\r") {
				t.Fatal("a line break reached the response header")
			}
		})
	}
}
