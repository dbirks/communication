package auth

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"path"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/dbirks/communication/internal/api"
	"github.com/dbirks/communication/internal/store/postgres"
)

// flowAdminSubject is the login used to prove bootstrap admin grants.
const flowAdminSubject = "frank-admin"

// flow is a running API replica wired to PostgreSQL and the real mock OIDC
// provider, plus a browser-like http.Client that keeps cookies but never
// follows a redirect on its own (the test must see every 302).
type flow struct {
	t           *testing.T
	publicURL   string
	databaseURL string
	issuer      string
	client      *http.Client
	userID      string
}

// flowDatabase returns a database URL dedicated to the OIDC flow tests. Each
// test package migrates on its own, and `go test ./...` runs packages in
// parallel, so two packages calling Migrate against the same database race on
// goose's version table. Falling back to the shared URL keeps the tests usable
// where creating a database is not permitted.
func flowDatabase(t *testing.T, base string) string {
	t.Helper()
	u, err := url.Parse(base)
	if err != nil || u.Path == "" || u.Path == "/" {
		return base
	}
	name := path.Base(u.Path) + "_oidc"
	u.Path = "/" + name
	flow := u.String()

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pool, err := postgres.Open(ctx, base)
	if err != nil {
		t.Logf("flow tests fall back to the shared database (%v)", err)
		return base
	}
	defer pool.Close()
	if _, err := pool.Exec(ctx, "CREATE DATABASE "+pgx.Identifier{name}.Sanitize()); err != nil {
		if !strings.Contains(err.Error(), "already exists") {
			t.Logf("flow tests fall back to the shared database: cannot create %q: %v", name, err)
			return base
		}
	}
	return flow
}

// ensureMigrated applies the migrations, tolerating a concurrent migration by
// another process: it succeeds as soon as the schema is at the expected
// version, whoever got it there.
func ensureMigrated(t *testing.T, databaseURL string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	want := postgres.ExpectedSchemaVersion()
	var lastErr error
	for start := time.Now(); time.Since(start) < 60*time.Second; time.Sleep(250 * time.Millisecond) {
		got, err := postgres.SchemaVersion(ctx, databaseURL)
		if err == nil && got >= want {
			return
		}
		lastErr = postgres.Migrate(ctx, databaseURL)
	}
	t.Fatalf("migrations did not reach version %d: %v", want, lastErr)
}

// startFlow migrates the scratch database, points a Service at the mock
// provider and serves the API on a loopback httptest server whose URL becomes
// COMMUNICATION_PUBLIC_URL.
func startFlow(t *testing.T, adminSubjects ...string) *flow {
	t.Helper()
	databaseURL, issuer := requireFlowEnv(t)
	databaseURL = flowDatabase(t, databaseURL)

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	ensureMigrated(t, databaseURL)
	pool, err := postgres.Open(ctx, databaseURL)
	if err != nil {
		t.Fatalf("postgres.Open: %v", err)
	}
	t.Cleanup(pool.Close)

	// httptest allocates its listener at construction, so the public URL can be
	// baked into the config before the handler exists.
	srv := httptest.NewUnstartedServer(nil)
	publicURL := "http://" + srv.Listener.Addr().String()

	cfg := Config{
		Issuer:                 issuer,
		ClientID:               "communication-test",
		PublicURL:              publicURL,
		CookieSecure:           false, // the test server speaks http
		BootstrapAdminSubjects: adminSubjects,
		SessionTTL:             time.Hour,
	}
	svc := New(cfg, &postgres.IdentityStore{Pool: pool}, nil)
	apiSrv := api.New(api.Config{ReplicaName: "flow-a", Version: "test", PublicURL: publicURL},
		nil, svc, nil)
	svc.Register(apiSrv)

	srv.Config.Handler = apiSrv
	srv.Start()
	t.Cleanup(srv.Close)

	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatalf("cookiejar: %v", err)
	}
	f := &flow{
		t: t, publicURL: publicURL, databaseURL: databaseURL, issuer: issuer,
		client: &http.Client{
			Jar: jar,
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
	}
	t.Cleanup(f.cleanup)
	return f
}

// cleanup removes the users, sessions and identities this test created. It
// never touches rows another suite wrote.
func (f *flow) cleanup() {
	if f.userID == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	pool, err := postgres.Open(ctx, f.databaseURL)
	if err != nil {
		f.t.Errorf("cleanup: open pool: %v", err)
		return
	}
	defer pool.Close()
	ids := []string{f.userID}
	stmts := []string{
		`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE id::text = ANY($1))`,
		`DELETE FROM oidc_identities WHERE user_id IN (SELECT id FROM users WHERE id::text = ANY($1))`,
		`DELETE FROM users WHERE id::text = ANY($1)`,
	}
	for _, q := range stmts {
		if _, err := pool.Exec(ctx, q, ids); err != nil {
			f.t.Errorf("cleanup %q: %v", q[:30], err)
		}
	}
}

// replicaB starts a second API replica sharing the same database but with its
// own identity configuration, used to prove sessions and logins are not bound
// to the process that started them (ADR-0012 §6).
func (f *flow) replicaB(issuer string) *httptest.Server {
	f.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := postgres.Open(ctx, f.databaseURL)
	if err != nil {
		f.t.Fatalf("replicaB postgres.Open: %v", err)
	}
	svc := New(Config{
		Issuer:       issuer,
		ClientID:     "communication-test",
		PublicURL:    f.publicURL,
		CookieSecure: false,
		SessionTTL:   time.Hour,
	}, &postgres.IdentityStore{Pool: pool}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	apiSrv := api.New(api.Config{
		ReplicaName: "flow-b", Version: "test", PublicURL: f.publicURL,
	}, nil, svc, nil)
	svc.Register(apiSrv)
	srv := httptest.NewServer(apiSrv)
	// The handler is serving, so the listener must close before the pool.
	f.t.Cleanup(func() {
		srv.Close()
		pool.Close()
	})
	return srv
}

// login drives /auth/login -> the IdP interactive form -> /auth/callback and
// stops just before following the final redirect, so the callback URL can be
// replayed.
func (f *flow) login(username, claimsJSON, returnTo string) (callbackURL string) {
	f.t.Helper()

	loginURL := f.publicURL + "/auth/login"
	if returnTo != "" {
		loginURL += "?return_to=" + url.QueryEscape(returnTo)
	}
	resp := f.mustDo(http.MethodGet, loginURL, nil, "")
	if resp.StatusCode != http.StatusFound {
		f.t.Fatalf("GET /auth/login status = %d, want 302", resp.StatusCode)
	}
	authorize := f.location(resp)
	if !strings.HasPrefix(authorize, f.issuer+"/authorize") {
		f.t.Fatalf("login redirected to %q, want the IdP authorize endpoint under %s",
			redactURL(authorize), f.issuer)
	}
	q := f.query(authorize)
	for key, want := range map[string]string{
		"client_id":             "communication-test",
		"response_type":         "code",
		"code_challenge_method": "S256",
		"redirect_uri":          f.publicURL + "/auth/callback",
	} {
		if got := q.Get(key); got != want {
			f.t.Errorf("authorize %s = %q, want %q", key, got, want)
		}
	}
	if q.Get("code_challenge") == "" || q.Get("state") == "" || q.Get("nonce") == "" {
		f.t.Errorf("authorize request is missing PKCE/state/nonce: %s", redactURL(authorize))
	}
	if scope := q.Get("scope"); !strings.Contains(scope, "openid") ||
		!strings.Contains(scope, "profile") || !strings.Contains(scope, "email") {
		f.t.Errorf("authorize scope = %q, want openid profile email", scope)
	}

	// The mock provider serves an interactive login page: any username signs in,
	// there is no password to commit (ADR-0012).
	formResp := f.mustDo(http.MethodGet, authorize, nil, "")
	if formResp.StatusCode != http.StatusOK {
		f.t.Fatalf("GET authorize status = %d, want 200", formResp.StatusCode)
	}
	page, _ := io.ReadAll(io.LimitReader(formResp.Body, 1<<20))
	formResp.Body.Close()
	if !strings.Contains(string(page), "<form") || !strings.Contains(string(page), `name="username"`) {
		f.t.Fatalf("authorize page offers no login form:\n%.300s", page)
	}
	if !strings.Contains(string(page), `name="claims"`) {
		f.t.Logf("provider login form has no claims field")
	}

	form := url.Values{"username": {username}}
	if claimsJSON != "" {
		form.Set("claims", claimsJSON)
	}
	f.t.Logf("signed in at the mock provider as username=%q", username)
	postResp := f.mustDo(http.MethodPost, authorize, strings.NewReader(form.Encode()),
		"application/x-www-form-urlencoded")
	if postResp.StatusCode != http.StatusFound {
		body, _ := io.ReadAll(io.LimitReader(postResp.Body, 1<<20))
		f.t.Fatalf("POST login status = %d, want 302; body:\n%.300s", postResp.StatusCode, body)
	}
	callback := f.location(postResp)
	if !strings.HasPrefix(callback, f.publicURL+"/auth/callback?") {
		f.t.Fatalf("IdP redirected to %q, want this replica's /auth/callback", redactURL(callback))
	}
	if got := f.query(callback).Get("state"); got != q.Get("state") {
		f.t.Fatalf("callback state %q != authorize state %q", got, q.Get("state"))
	}
	return callback
}

// finish exchanges the callback code for a session and asserts the contracted
// cookie flags, returning the response that carries the final redirect.
func (f *flow) finish(callbackURL, wantTo string) {
	f.t.Helper()
	resp := f.mustDo(http.MethodGet, callbackURL, nil, "")
	if resp.StatusCode != http.StatusFound {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		f.t.Fatalf("GET /auth/callback status = %d, want 302; body:\n%.300s", resp.StatusCode, body)
	}
	if got := f.location(resp); got != wantTo {
		f.t.Fatalf("callback redirected to %q, want %q", got, wantTo)
	}
	var cookie *http.Cookie
	for _, c := range resp.Cookies() {
		if c.Name == CookieName {
			cookie = c
		}
	}
	if cookie == nil || cookie.Value == "" {
		f.t.Fatalf("successful login set no %s cookie", CookieName)
	}
	if !cookie.HttpOnly {
		f.t.Errorf("%s cookie is not HttpOnly", CookieName)
	}
	if cookie.Secure {
		f.t.Errorf("%s cookie is Secure but CookieSecure=false", CookieName)
	}
	if cookie.Path != "/" {
		f.t.Errorf("cookie Path = %q, want /", cookie.Path)
	}
	if cookie.SameSite != http.SameSiteLaxMode {
		f.t.Errorf("cookie SameSite = %v, want Lax", cookie.SameSite)
	}
	if cookie.MaxAge <= 0 {
		f.t.Errorf("cookie MaxAge = %d, want > 0", cookie.MaxAge)
	}
}

func (f *flow) location(resp *http.Response) string {
	f.t.Helper()
	v := resp.Header.Get("Location")
	resp.Body.Close()
	if v == "" {
		f.t.Fatalf("302 response has no Location header")
	}
	return v
}

func (f *flow) query(rawURL string) url.Values {
	f.t.Helper()
	u, err := url.Parse(rawURL)
	if err != nil {
		f.t.Fatalf("parse %q: %v", redactURL(rawURL), err)
	}
	return u.Query()
}

func (f *flow) mustDo(method, rawURL string, body io.Reader, contentType string) *http.Response {
	f.t.Helper()
	req, err := http.NewRequest(method, rawURL, body)
	if err != nil {
		f.t.Fatalf("%s %s: new request: %v", method, redactURL(rawURL), err)
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	return f.do(req)
}

func (f *flow) do(req *http.Request) *http.Response {
	f.t.Helper()
	resp, err := f.client.Do(req)
	if err != nil {
		f.t.Fatalf("%s %s: %v", req.Method, redactURL(req.URL.String()), err)
	}
	f.t.Logf("%s %s -> %d", req.Method, redactURL(req.URL.String()), resp.StatusCode)
	return resp
}

// me is the decoded GET /api/v1/me body.
type me struct {
	ID           string `json:"id"`
	DisplayName  string `json:"display_name"`
	Email        string `json:"email"`
	IsOrgAdmin   bool   `json:"is_org_admin"`
	Organization struct {
		ID   string `json:"id"`
		Slug string `json:"slug"`
		Name string `json:"name"`
	} `json:"organization"`
	CSRFToken string `json:"csrf_token"`
}

// getMe fetches /api/v1/me, asserting 200 and recording the user id for
// cleanup.
func (f *flow) getMe() me {
	f.t.Helper()
	var body me
	resp := f.mustDo(http.MethodGet, f.publicURL+"/api/v1/me", nil, "")
	f.decode(resp, http.StatusOK, &body)
	if body.ID == "" {
		f.t.Fatalf("/api/v1/me returned no id: %+v", body)
	}
	f.userID = body.ID
	return body
}

func (f *flow) decode(resp *http.Response, wantStatus int, dst any) {
	f.t.Helper()
	defer resp.Body.Close()
	if resp.StatusCode != wantStatus {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		f.t.Fatalf("status = %d, want %d; body:\n%.300s", resp.StatusCode, wantStatus, body)
	}
	if dst == nil {
		return
	}
	if err := json.NewDecoder(resp.Body).Decode(dst); err != nil {
		f.t.Fatalf("decode response body: %v", err)
	}
}

// TestFlowLoginRoundTrip drives the whole ADR-0012 path against a real OIDC
// provider: discovery, redirect, interactive login, code exchange, ID token
// verification, (issuer, subject) upsert, session cookie, CSRF and logout.
func TestFlowLoginRoundTrip(t *testing.T) {
	f := startFlow(t)
	callback := f.login("alice", "", "/projects")
	f.finish(callback, "/projects")

	// Replay of the same callback URL: the state row was consumed by the first
	// exchange, so this must be rejected.
	replay := f.mustDo(http.MethodGet, callback, nil, "")
	if replay.StatusCode != http.StatusBadRequest {
		t.Errorf("replayed callback status = %d, want 400", replay.StatusCode)
	}
	replay.Body.Close()

	body := f.getMe()
	// Observed behaviour of mock-oauth2-server 6.0.7 with interactiveLogin and
	// an empty claims field: the ID token carries only sub (= the typed
	// username) — no name, no preferred_username, no email. The display name
	// therefore comes from the subject fallback of ADR-0012 §4.
	t.Logf("provider claims: name/preferred_username absent -> /me display_name = %q, email = %q",
		body.DisplayName, body.Email)
	if !strings.Contains(strings.ToLower(body.DisplayName), "alice") {
		t.Errorf("display_name = %q, want it to contain alice", body.DisplayName)
	}
	if body.CSRFToken == "" {
		t.Errorf("/me returned no csrf_token")
	}
	if body.Organization.Slug != "default" || body.Organization.Name != "Default organization" ||
		body.Organization.ID == "" {
		t.Errorf("/me organization = %+v, want the seeded default organization", body.Organization)
	}
	if body.IsOrgAdmin {
		t.Errorf("is_org_admin = true, want false (subject is not bootstrapped)")
	}

	var users struct {
		Items []struct {
			ID          string `json:"id"`
			DisplayName string `json:"display_name"`
			Email       string `json:"email"`
		} `json:"items"`
	}
	f.decode(f.mustDo(http.MethodGet, f.publicURL+"/api/v1/users", nil, ""), http.StatusOK, &users)
	if len(users.Items) == 0 {
		t.Fatal("GET /api/v1/users returned no items")
	}
	found := false
	for _, u := range users.Items {
		if u.ID == body.ID {
			found = true
			if u.DisplayName == "" {
				t.Errorf("user list entry for the caller has no display_name")
			}
		}
	}
	if !found {
		t.Errorf("GET /api/v1/users does not include the caller (%d items)", len(users.Items))
	}

	// Logout is a mutation and needs the session CSRF token.
	noCSRF := f.mustDo(http.MethodPost, f.publicURL+"/auth/logout", nil, "")
	if noCSRF.StatusCode != http.StatusForbidden {
		t.Errorf("POST /auth/logout without CSRF status = %d, want 403", noCSRF.StatusCode)
	}
	noCSRF.Body.Close()

	req, err := http.NewRequest(http.MethodPost, f.publicURL+"/auth/logout", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set(api.HeaderCSRFToken, body.CSRFToken)
	f.decode(f.do(req), http.StatusNoContent, nil)

	after := f.mustDo(http.MethodGet, f.publicURL+"/api/v1/me", nil, "")
	if after.StatusCode != http.StatusUnauthorized {
		t.Errorf("GET /me after logout status = %d, want 401", after.StatusCode)
	}
	after.Body.Close()
}

// TestFlowSessionSurvivesAnotherReplica logs in on replica A and reads /me on
// replica B, which shares only the database (ADR-0012 §6, M1 two-replica exit).
func TestFlowSessionSurvivesAnotherReplica(t *testing.T) {
	f := startFlow(t)
	f.finish(f.login("gina", "", "/projects"), "/projects")
	body := f.getMe()

	down := f.replicaB("http://127.0.0.1:1/unreachable-issuer")
	req, err := http.NewRequest(http.MethodGet, down.URL+"/api/v1/me", nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range f.client.Jar.Cookies(mustURL(t, f.publicURL)) {
		if c.Name == CookieName {
			req.AddCookie(&http.Cookie{Name: CookieName, Value: c.Value})
		}
	}
	resp, err := down.Client().Do(req)
	if err != nil {
		t.Fatalf("GET /me on replica B: %v", err)
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		t.Fatalf("GET /me on replica B = %d, want 200", resp.StatusCode)
	}
	var onB me
	if err := json.NewDecoder(resp.Body).Decode(&onB); err != nil {
		t.Fatalf("decode replica B /me: %v", err)
	}
	resp.Body.Close()
	if onB.ID != body.ID || onB.CSRFToken != body.CSRFToken {
		t.Errorf("replica B reported %+v, want the same identity and csrf token", onB)
	}
	if got := resp.Header.Get(api.HeaderReplica); got != "flow-b" {
		t.Errorf("X-Communication-Replica = %q, want flow-b", got)
	}

	// New logins on a replica that cannot reach the IdP fail closed with 503,
	// while the existing session above kept working.
	loginResp, err := down.Client().Get(down.URL + "/auth/login")
	if err != nil {
		t.Fatalf("GET /auth/login on replica B: %v", err)
	}
	problemBody, _ := io.ReadAll(io.LimitReader(loginResp.Body, 1<<20))
	loginResp.Body.Close()
	if loginResp.StatusCode != http.StatusServiceUnavailable {
		t.Errorf("GET /auth/login with an unreachable issuer = %d, want 503", loginResp.StatusCode)
	}
	if !strings.Contains(string(problemBody), "Identity Provider Unavailable") {
		t.Errorf("503 body does not name the identity provider: %.200s", problemBody)
	}
}

// TestFlowLoginWithoutSessionIsRejected checks the fail-closed reads.
func TestFlowLoginWithoutSessionIsRejected(t *testing.T) {
	f := startFlow(t)
	for _, path := range []string{"/api/v1/me", "/api/v1/users"} {
		resp := f.mustDo(http.MethodGet, f.publicURL+path, nil, "")
		if resp.StatusCode != http.StatusUnauthorized {
			t.Errorf("GET %s status = %d, want 401", path, resp.StatusCode)
		}
		if ct := resp.Header.Get("Content-Type"); ct != api.ProblemJSON {
			t.Errorf("GET %s content type = %q, want %q", path, ct, api.ProblemJSON)
		}
		resp.Body.Close()
	}
	// An unknown session cookie behaves exactly like no cookie.
	f.client.Jar.SetCookies(mustURL(t, f.publicURL),
		[]*http.Cookie{{Name: CookieName, Value: "not-a-real-session-token"}})
	resp := f.mustDo(http.MethodGet, f.publicURL+"/api/v1/me", nil, "")
	if resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("GET /me with a forged cookie status = %d, want 401", resp.StatusCode)
	}
	resp.Body.Close()
}

// TestFlowBootstrapAdminSubject logs in as a subject listed in
// COMMUNICATION_BOOTSTRAP_ADMIN_SUBJECTS and expects organization admin.
func TestFlowBootstrapAdminSubject(t *testing.T) {
	f := startFlow(t, flowAdminSubject)
	f.finish(f.login(flowAdminSubject, "", ""), "/")
	if body := f.getMe(); !body.IsOrgAdmin {
		t.Errorf("is_org_admin = false, want true for bootstrapped subject %q", flowAdminSubject)
	}
}

// TestFlowClaimedProfileChecksNamePrecedence uses the mock provider's claims
// field to release name, preferred_username and email, proving the precedence
// name -> preferred_username -> subject.
func TestFlowClaimedProfileChecksNamePrecedence(t *testing.T) {
	f := startFlow(t)
	callback := f.login("carol",
		`{"name":"Carol Danvers","preferred_username":"cdanvers","email":"carol@example.test"}`, "")
	f.finish(callback, "/")
	body := f.getMe()
	if body.DisplayName != "Carol Danvers" {
		t.Errorf("display_name = %q, want the name claim %q", body.DisplayName, "Carol Danvers")
	}
	if body.Email != "carol@example.test" {
		t.Errorf("email = %q, want the released claim", body.Email)
	}
	if len(body.ID) != 36 {
		t.Errorf("user id = %q, want a uuid string", body.ID)
	}
}

// TestFlowReturnToMustBeSameOrigin: a protocol-relative return_to must not
// escape the deployment.
func TestFlowReturnToMustBeSameOrigin(t *testing.T) {
	f := startFlow(t)
	f.finish(f.login("dave", "", "//evil.example"), "/")
}

// TestFlowCallbackRejectsBogusRequests proves a callback whose state was never
// issued cannot log anyone in.
func TestFlowCallbackRejectsBogusRequests(t *testing.T) {
	f := startFlow(t)
	cases := []struct {
		query string
		want  int
	}{
		{"?code=abc&state=never-issued", http.StatusBadRequest},
		{"?code=abc", http.StatusBadRequest},
		{"?state=never-issued", http.StatusBadRequest},
		{"?error=access_denied&error_description=not+logged+in", http.StatusUnauthorized},
	}
	for _, c := range cases {
		resp := f.mustDo(http.MethodGet, f.publicURL+"/auth/callback"+c.query, nil, "")
		if resp.StatusCode != c.want {
			t.Errorf("GET /auth/callback%s status = %d, want %d",
				redactURL(c.query), resp.StatusCode, c.want)
		}
		resp.Body.Close()
	}
	// No session may have been minted.
	resp := f.mustDo(http.MethodGet, f.publicURL+"/api/v1/me", nil, "")
	if resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("GET /me status = %d, want 401", resp.StatusCode)
	}
	resp.Body.Close()
}

func mustURL(t *testing.T, rawURL string) *url.URL {
	t.Helper()
	u, err := url.Parse(rawURL)
	if err != nil {
		t.Fatalf("parse %q: %v", redactURL(rawURL), err)
	}
	return u
}
