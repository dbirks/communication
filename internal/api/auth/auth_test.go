package auth

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"

	"github.com/dbirks/communication/internal/store/postgres"
)

func TestSanitizeReturnTo(t *testing.T) {
	cases := []struct {
		name, in, want string
	}{
		{"empty", "", "/"},
		{"blank", "   ", "/"},
		{"root", "/", "/"},
		{"path", "/projects", "/projects"},
		{"path with query", "/projects?p=1#top", "/projects?p=1#top"},
		{"protocol relative", "//evil.example", "/"},
		{"protocol relative backslash", `/\evil.example`, "/"},
		{"double slash deep", "//evil.example/p", "/"},
		{"absolute url", "https://evil.example/x", "/"},
		{"scheme relative", "evil.example/x", "/"},
		{"bare scheme", "javascript:alert(1)", "/"},
		{"backslash only", `\`, "/"},
		{"single slash prefix stripped by whitespace", " /projects", "/projects"},
		{"tab smuggling", "/projects\t\n@evil.example", "/"},
		{"control char", "/pro\x01jects", "/"},
		{"over long", "/" + strings.Repeat("a", maxReturnToLen), "/"},
		{"max length ok", "/" + strings.Repeat("a", maxReturnToLen-1), "/" + strings.Repeat("a", maxReturnToLen-1)},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := SanitizeReturnTo(c.in); got != c.want {
				t.Errorf("SanitizeReturnTo(%q) = %q, want %q", c.in, got, c.want)
			}
		})
	}
}

func TestApplyBrowserIssuer(t *testing.T) {
	cases := []struct {
		name, authURL, issuer, browser, want string
	}{
		{
			name:    "compose host name swapped for the browser's",
			authURL: "http://oidc:8080/default/authorize",
			issuer:  "http://oidc:8080/default",
			browser: "http://localhost:18090/default",
			want:    "http://localhost:18090/default/authorize",
		},
		{
			name:    "empty browser issuer is a no-op",
			authURL: "http://oidc:8080/default/authorize",
			issuer:  "http://oidc:8080/default",
			browser: "",
			want:    "http://oidc:8080/default/authorize",
		},
		{
			name:    "trailing slashes on either side",
			authURL: "https://idp.example/authorize",
			issuer:  "https://idp.example/",
			browser: "https://login.example.com/",
			want:    "https://login.example.com/authorize",
		},
		{
			name:    "endpoint at the issuer root",
			authURL: "https://idp.example",
			issuer:  "https://idp.example",
			browser: "https://login.example.com",
			want:    "https://login.example.com",
		},
		{
			name:    "issuer not a prefix is left alone",
			authURL: "https://other.example/authorize",
			issuer:  "https://idp.example/default",
			browser: "https://login.example.com/default",
			want:    "https://other.example/authorize",
		},
		{
			name:    "partial segment prefix is not a match",
			authURL: "https://idp.example.default.evil/authorize",
			issuer:  "https://idp.example",
			browser: "https://login.example.com",
			want:    "https://idp.example.default.evil/authorize",
		},
		{
			name:    "query on the discovered endpoint survives",
			authURL: "https://idp.example/default/authorize?x=1",
			issuer:  "https://idp.example/default",
			browser: "http://localhost:18090/default",
			want:    "http://localhost:18090/default/authorize?x=1",
		},
		{
			name:    "missing issuer config is a no-op",
			authURL: "https://idp.example/authorize",
			issuer:  "",
			browser: "https://login.example.com",
			want:    "https://idp.example/authorize",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := ApplyBrowserIssuer(c.authURL, c.issuer, c.browser); got != c.want {
				t.Errorf("ApplyBrowserIssuer(%q, %q, %q) = %q, want %q",
					c.authURL, c.issuer, c.browser, got, c.want)
			}
		})
	}
}

func TestConfigFromEnv(t *testing.T) {
	t.Setenv(EnvIssuer, "http://oidc:8080/default")
	t.Setenv(EnvBrowserIssuer, "http://localhost:18090/default")
	t.Setenv(EnvClientID, "communication")
	t.Setenv(EnvClientSecret, "")
	t.Setenv(EnvPublicURL, "http://localhost:18080")
	t.Setenv(EnvCookieSecure, "")
	t.Setenv(EnvBootstrapAdminSubjects, "alice, , bob")

	cfg, err := ConfigFromEnv()
	if err != nil {
		t.Fatalf("ConfigFromEnv: %v", err)
	}
	if cfg.SessionTTL != DefaultSessionTTL {
		t.Errorf("SessionTTL = %v, want %v", cfg.SessionTTL, DefaultSessionTTL)
	}
	if !cfg.CookieSecure {
		t.Errorf("CookieSecure = false, want default true")
	}
	if got := cfg.RedirectURL(); got != "http://localhost:18080/auth/callback" {
		t.Errorf("RedirectURL = %q", got)
	}
	if strings.Join(cfg.BootstrapAdminSubjects, ",") != "alice,bob" {
		t.Errorf("BootstrapAdminSubjects = %v, want [alice bob]", cfg.BootstrapAdminSubjects)
	}
	if !cfg.IsBootstrapAdmin("bob") || cfg.IsBootstrapAdmin("mallory") || cfg.IsBootstrapAdmin("") {
		t.Errorf("IsBootstrapAdmin wrong for %v", cfg.BootstrapAdminSubjects)
	}

	for _, missing := range []string{EnvIssuer, EnvClientID, EnvPublicURL} {
		t.Setenv(missing, "")
		if _, err := ConfigFromEnv(); err == nil || !strings.Contains(err.Error(), missing) {
			t.Errorf("ConfigFromEnv with %s unset err = %v, want it named", missing, err)
		}
	}
	t.Setenv(EnvIssuer, "http://oidc:8080/default")
	t.Setenv(EnvClientID, "communication")
	t.Setenv(EnvPublicURL, "http://localhost:18080")

	t.Setenv(EnvCookieSecure, "maybe")
	if _, err := ConfigFromEnv(); err == nil {
		t.Errorf("ConfigFromEnv with a non-boolean %s err = nil, want error", EnvCookieSecure)
	}
	t.Setenv(EnvCookieSecure, "false")
	cfg, err = ConfigFromEnv()
	if err != nil {
		t.Fatalf("ConfigFromEnv (cookie secure false): %v", err)
	}
	if cfg.CookieSecure {
		t.Errorf("CookieSecure = true, want false")
	}

	t.Setenv(EnvPublicURL, "localhost:18080")
	if _, err := ConfigFromEnv(); err == nil {
		t.Error("ConfigFromEnv accepted a PublicURL without a scheme")
	}
}

func TestConfigValidateAndSessionTTL(t *testing.T) {
	var zero Config
	if err := zero.Validate(); err == nil {
		t.Fatal("zero Config.Validate() = nil, want an error")
	} else if !strings.Contains(err.Error(), EnvIssuer) ||
		!strings.Contains(err.Error(), EnvClientID) ||
		!strings.Contains(err.Error(), EnvPublicURL) {
		t.Errorf("error should name all three missing vars, got %v", err)
	}
	c := Config{Issuer: "https://idp", ClientID: "cid", PublicURL: "https://app", SessionTTL: time.Hour}
	if err := c.Validate(); err != nil {
		t.Fatalf("Validate: %v", err)
	}
	if c.SessionTTLOrDefault() != time.Hour {
		t.Errorf("SessionTTLOrDefault = %v, want 1h", c.SessionTTLOrDefault())
	}
	c.SessionTTL = 0
	if c.SessionTTLOrDefault() != DefaultSessionTTL {
		t.Errorf("SessionTTLOrDefault = %v, want the 12h default", c.SessionTTLOrDefault())
	}
}

func TestDisplayNameFrom(t *testing.T) {
	if got := displayNameFrom(idTokenClaims{Name: " Name "}, "sub"); got != "Name" {
		t.Errorf("name precedence: %q", got)
	}
	if got := displayNameFrom(idTokenClaims{PreferredUsername: " pref "}, "sub"); got != "pref" {
		t.Errorf("preferred_username fallback: %q", got)
	}
	if got := displayNameFrom(idTokenClaims{}, "sub"); got != "sub" {
		t.Errorf("subject fallback: %q", got)
	}
}

func TestRedactErrHidesTokens(t *testing.T) {
	fake := errors.New(`oauth2: server response missing access_token but this leaked ` +
		`eyJhbGciOiJSUzI1NiIsImtpZCI6ImRlZmF1bHQifQ.eyJzdWIiOiJhbGljZSJ9.fake-signature-value ` +
		`and ?code=SplxlOBeZQQYbYS6WxSbIA&state=abc123def456&id_token=aaa.bbb.ccc`)
	got := redactErr(fake)
	for _, want := range []string{"SplxlOBeZQQYbYS6WxSbIA", "abc123def456",
		"eyJhbGciOiJSUzI1NiIsImtpZCI6ImRlZmF1bHQifQ", "aaa.bbb.ccc"} {
		if strings.Contains(got, want) {
			t.Errorf("redactErr leaked %q in %q", want, got)
		}
	}
	if !strings.Contains(got, "code=[redacted]") || !strings.Contains(got, "state=[redacted]") {
		t.Errorf("redactErr did not redact query secrets: %q", got)
	}
	long := errors.New(strings.Repeat("x", maxErrLen+50))
	if len(redactErr(long)) != maxErrLen+3 {
		t.Errorf("redactErr length = %d, want the cap", len(redactErr(long)))
	}
	if redactErr(nil) != "" {
		t.Error("redactErr(nil) should be empty")
	}
	if got := redactURL("http://h/c?code=secret#f"); got != "http://h/c" {
		t.Errorf("redactURL = %q", got)
	}
}

func TestRandomTokensAreUniqueAndURLSafe(t *testing.T) {
	seen := map[string]bool{}
	for range 64 {
		tok, err := randomToken(32)
		if err != nil {
			t.Fatalf("randomToken: %v", err)
		}
		if len(tok) != 43 {
			t.Fatalf("randomToken(32) length = %d, want 43 base64url chars", len(tok))
		}
		if strings.ContainsAny(tok, "+/=") {
			t.Fatalf("token %q is not base64url", tok)
		}
		if seen[tok] {
			t.Fatalf("duplicate token %q", tok)
		}
		seen[tok] = true
	}
}

// requireFlowEnv skips tests that need a live PostgreSQL and OIDC provider.
func requireFlowEnv(t *testing.T) (databaseURL, issuer string) {
	t.Helper()
	databaseURL = os.Getenv("COMMUNICATION_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("COMMUNICATION_TEST_DATABASE_URL not set")
	}
	issuer = os.Getenv("COMMUNICATION_TEST_OIDC_ISSUER")
	if issuer == "" {
		t.Skip("COMMUNICATION_TEST_OIDC_ISSUER not set")
	}
	return databaseURL, issuer
}

// TestAvatarURLFrom pins the one rule a provider-supplied picture must pass to
// become stored state: an absolute https URL with a host, or the empty string.
// Everything else — http, data:, javascript:, a relative path, userinfo in the
// authority, an over-long claim — becomes "", which the UI draws as initials.
func TestAvatarURLFrom(t *testing.T) {
	cases := []struct{ name, in, want string }{
		{"empty", "", ""},
		{"whitespace only", "   ", ""},
		{"https kept", "https://avatars.example.test/a/b.png", "https://avatars.example.test/a/b.png"},
		{"surrounding space trimmed", " https://cdn.example.test/p.png ", "https://cdn.example.test/p.png"},
		{"http is not https", "http://cdn.example.test/p.png", ""},
		{"data uri", "data:image/png;base64,AAAA", ""},
		{"javascript", "javascript:alert(1)", ""},
		{"relative path", "/avatars/me.png", ""},
		{"protocol relative", "//cdn.example.test/p.png", ""},
		{"userinfo in the authority", "https://user:pw@cdn.example.test/p.png", ""},
		{"no host", "https://", ""},
		{"control character", "https://cdn.example.test/a\x01b.png", ""},
		{"over long", "https://cdn.example.test/" + strings.Repeat("a", maxAvatarURLLen), ""},
		{"exactly at the cap is kept", "https://c.test/" + strings.Repeat("a", maxAvatarURLLen-len("https://c.test/")),
			"https://c.test/" + strings.Repeat("a", maxAvatarURLLen-len("https://c.test/"))},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := avatarURLFrom(c.in); got != c.want {
				t.Errorf("avatarURLFrom(%q) = %q, want %q", truncateForTest(c.in), got, c.want)
			}
		})
	}
}

func truncateForTest(s string) string {
	if len(s) > 48 {
		return s[:48] + "…"
	}
	return s
}

// TestIDTokenClaimsReadPicture proves the claim is read next to name/email.
func TestIDTokenClaimsReadPicture(t *testing.T) {
	var c idTokenClaims
	if err := json.Unmarshal([]byte(`{"name":"David Birks","preferred_username":"dbirks",`+
		`"email":"d@example.test","picture":"https://avatars.example.test/d.png"}`), &c); err != nil {
		t.Fatalf("claims: %v", err)
	}
	if c.Picture != "https://avatars.example.test/d.png" {
		t.Errorf("picture = %q", c.Picture)
	}
	if got := displayNameFrom(c, "sub"); got != "David Birks" {
		t.Errorf("name precedence broken: %q", got)
	}
	// preferred_username still wins over the subject when name is absent.
	var pref idTokenClaims
	if err := json.Unmarshal([]byte(`{"preferred_username":"dbirks"}`), &pref); err != nil {
		t.Fatalf("claims: %v", err)
	}
	if got := displayNameFrom(pref, "sub"); got != "dbirks" {
		t.Errorf("preferred_username fallback: %q", got)
	}
}

// TestMeResponseCarriesAvatarURL pins the wire name on GET /api/v1/me: the
// field is always present, and an empty picture is an empty string rather than
// a missing key.
func TestMeResponseCarriesAvatarURL(t *testing.T) {
	body, err := json.Marshal(meResponse{ID: "u-1", DisplayName: "David Birks",
		AvatarURL: "https://avatars.example.test/d.png"})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(body), `"avatar_url":"https://avatars.example.test/d.png"`) {
		t.Errorf("me body = %s, want avatar_url with the stored picture", body)
	}
	empty, err := json.Marshal(meResponse{ID: "u-1"})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(empty), `"avatar_url":""`) {
		t.Errorf("me body = %s, want an always-present avatar_url", empty)
	}
}

// startProviderStub serves just enough OIDC for oidc.NewProvider and
// Provider.UserInfo on loopback: a discovery document, an empty JWKS and the
// caller's /userinfo handler.
func startProviderStub(t *testing.T, advertiseUserinfo bool, userinfo http.HandlerFunc) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	var srv *httptest.Server
	mux.HandleFunc("/.well-known/openid-configuration", func(w http.ResponseWriter, _ *http.Request) {
		doc := map[string]any{
			"issuer":                                srv.URL,
			"authorization_endpoint":                srv.URL + "/authorize",
			"token_endpoint":                        srv.URL + "/token",
			"jwks_uri":                              srv.URL + "/certs",
			"id_token_signing_alg_values_supported": []string{"RS256"},
		}
		if advertiseUserinfo {
			doc["userinfo_endpoint"] = srv.URL + "/userinfo"
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(doc)
	})
	mux.HandleFunc("/certs", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"keys":[]}`))
	})
	if userinfo != nil {
		mux.HandleFunc("/userinfo", userinfo)
	}
	srv = httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

// providerFor discovers the stub above with the same client the service uses.
func providerFor(t *testing.T, svc *Service, url string) *oidc.Provider {
	t.Helper()
	p, err := oidc.NewProvider(oidc.ClientContext(context.Background(), svc.client), url)
	if err != nil {
		t.Fatalf("discover stub provider: %v", err)
	}
	return p
}

// TestUserInfoProfileSuppliesWhatTheIDTokenLacked is the tsidp case: the
// provider releases `picture` (and `name`) only at /userinfo, so a login whose
// ID token carried neither must still end up with the face — and it must send
// the access token to get it.
func TestUserInfoProfileSuppliesWhatTheIDTokenLacked(t *testing.T) {
	var authHeader string
	srv := startProviderStub(t, true, func(w http.ResponseWriter, r *http.Request) {
		authHeader = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"sub":"user-1","name":"David Birks",` +
			`"picture":"https://avatars.example.test/d.png"}`))
	})
	svc := New(Config{Issuer: srv.URL, ClientID: "cid"}, nil, nil)
	p := providerFor(t, svc, srv.URL)

	picture, name := svc.userInfoProfile(context.Background(), p, &oauth2.Token{AccessToken: "at"})
	if picture != "https://avatars.example.test/d.png" {
		t.Errorf("picture = %q, want the /userinfo claim", picture)
	}
	if name != "David Birks" {
		t.Errorf("name = %q, want the /userinfo claim", name)
	}
	if authHeader != "Bearer at" {
		t.Errorf("userinfo request Authorization = %q, want %q", authHeader, "Bearer at")
	}
}

// TestUserInfoProfileNeverBreaksLogin covers every way the UserInfo endpoint
// can fail to help. A missing face is a cosmetic problem; none of these may
// look like an error, and none may store a picture the browser should not load.
func TestUserInfoProfileNeverBreaksLogin(t *testing.T) {
	cases := []struct {
		name        string
		advertise   bool
		userinfo    http.HandlerFunc
		token       *oauth2.Token
		wantPicture string
		wantName    string
	}{
		{
			name:      "provider advertises no userinfo endpoint",
			advertise: false,
			token:     &oauth2.Token{AccessToken: "at"},
		},
		{
			name:      "exchange produced no access token",
			advertise: true,
			userinfo: func(w http.ResponseWriter, _ *http.Request) {
				t.Error("userinfo was called with no access token")
			},
			token: &oauth2.Token{},
		},
		{
			name:      "userinfo errors",
			advertise: true,
			userinfo: func(w http.ResponseWriter, _ *http.Request) {
				http.Error(w, "boom", http.StatusInternalServerError)
			},
			token: &oauth2.Token{AccessToken: "at"},
		},
		{
			name:      "userinfo body is not JSON",
			advertise: true,
			userinfo: func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "text/plain")
				_, _ = w.Write([]byte("not json"))
			},
			token: &oauth2.Token{AccessToken: "at"},
		},
		{
			// The name is still true; only the unsafe URL is dropped.
			name:      "userinfo releases a non-https picture",
			advertise: true,
			userinfo: func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`{"sub":"user-1","name":"David",` +
					`"picture":"http://cdn.example.test/insecure.png"}`))
			},
			token:    &oauth2.Token{AccessToken: "at"},
			wantName: "David",
		},
		{
			name:      "userinfo releases no picture at all",
			advertise: true,
			userinfo: func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`{"sub":"user-1"}`))
			},
			token: &oauth2.Token{AccessToken: "at"},
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			srv := startProviderStub(t, c.advertise, c.userinfo)
			svc := New(Config{Issuer: srv.URL, ClientID: "cid"}, nil, nil)
			p := providerFor(t, svc, srv.URL)
			picture, name := svc.userInfoProfile(context.Background(), p, c.token)
			if picture != c.wantPicture || name != c.wantName {
				t.Errorf("userInfoProfile = (%q, %q), want (%q, %q)",
					picture, name, c.wantPicture, c.wantName)
			}
		})
	}
}

// TestFlowLoginStoresPictureClaim drives the real provider end to end: an ID
// token with a `picture` claim is stored and answered by GET /api/v1/me, and a
// non-https claim never reaches the browser.
func TestFlowLoginStoresPictureClaim(t *testing.T) {
	f := startFlow(t)
	callback := f.login("avatar-alice", `{"name":"Alice Example",`+
		`"picture":"https://avatars.example.test/alice.png"}`, "/")
	f.finish(callback, "/")

	var withPicture struct {
		ID          string `json:"id"`
		DisplayName string `json:"display_name"`
		AvatarURL   string `json:"avatar_url"`
	}
	f.decode(f.mustDo(http.MethodGet, f.publicURL+"/api/v1/me", nil, ""), http.StatusOK, &withPicture)
	if withPicture.ID == "" {
		t.Fatal("/api/v1/me returned no id")
	}
	f.userID = withPicture.ID
	if withPicture.DisplayName != "Alice Example" {
		t.Errorf("display_name = %q, want the name claim", withPicture.DisplayName)
	}
	if withPicture.AvatarURL != "https://avatars.example.test/alice.png" {
		t.Errorf("avatar_url = %q, want the https picture claim", withPicture.AvatarURL)
	}
	t.Cleanup(func() {
		purgeFlowUser(t, f.databaseURL, withPicture.ID)
	})
}

// TestFlowLoginRejectsInsecurePictureClaim is the other half of the rule at the
// only place a provider gets to speak: an http (or javascript, or data) picture
// is stored as "", so /me can never hand a browser a mixed-content or scripted
// image source.
func TestFlowLoginRejectsInsecurePictureClaim(t *testing.T) {
	f := startFlow(t)
	subject := "avatar-insecure"
	callback := f.login(subject, `{"picture":"http://cdn.example.test/insecure.png"}`, "/")
	f.finish(callback, "/")

	var body struct {
		ID        string `json:"id"`
		AvatarURL string `json:"avatar_url"`
	}
	f.decode(f.mustDo(http.MethodGet, f.publicURL+"/api/v1/me", nil, ""), http.StatusOK, &body)
	if body.ID == "" {
		t.Fatal("/api/v1/me returned no id")
	}
	if body.AvatarURL != "" {
		t.Errorf("avatar_url = %q, want empty for a non-https claim", body.AvatarURL)
	}
	t.Cleanup(func() { purgeFlowUser(t, f.databaseURL, body.ID) })
}

// purgeFlowUser deletes one user (with its sessions and identities) that a
// flow test created. The flow helper only removes the id it recorded in
// f.userID, which these tests learn only after /api/v1/me has answered.
func purgeFlowUser(t *testing.T, databaseURL, userID string) {
	t.Helper()
	if userID == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	pool, err := postgres.Open(ctx, databaseURL)
	if err != nil {
		t.Errorf("purgeFlowUser: open pool: %v", err)
		return
	}
	defer pool.Close()
	for _, q := range []string{
		`DELETE FROM sessions WHERE user_id = $1::uuid`,
		`DELETE FROM oidc_identities WHERE user_id = $1::uuid`,
		`DELETE FROM users WHERE id = $1::uuid`,
	} {
		if _, err := pool.Exec(ctx, q, userID); err != nil {
			t.Errorf("purgeFlowUser %q: %v", q[:24], err)
		}
	}
}

// TestIssuerHostNamesOnlyTheHost proves the Profile page's "Signed in with"
// line gets a host and nothing more: no scheme, no tenant path, no client id.
func TestIssuerHost(t *testing.T) {
	cases := []struct {
		issuer, want string
	}{
		{"https://idp.example.test", "idp.example.test"},
		{"https://idp.example.test/tailnet-abc", "idp.example.test"},
		{"http://localhost:18090/default", "localhost:18090"},
		{"https://idp.example.test:8443/", "idp.example.test:8443"},
		{"", ""},
		{"not a url", ""},
	}
	for _, c := range cases {
		svc := New(Config{Issuer: c.issuer, ClientID: "cid", PublicURL: "https://app.test"}, nil, nil)
		if got := svc.issuerHost(); got != c.want {
			t.Errorf("issuerHost(%q) = %q, want %q", c.issuer, got, c.want)
		}
	}
}
