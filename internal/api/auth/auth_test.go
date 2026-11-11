package auth

import (
	"bytes"
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"

	"github.com/dbirks/communication/internal/api"
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

// ---------------------------------------------------------------------------
// ADR-0083: several providers, one login path.
//
// These run against the real PostgreSQL and two real, signed ID tokens — the
// IdPs are in-process so a test can name the claims each kind reads (tid, oid,
// a tenant-specific iss), which the lab's single mock issuer cannot express.
// Nothing about verification is mocked: discovery, JWKS, the signature, the
// audience, the nonce and the PKCE handshake all run for real.
// ---------------------------------------------------------------------------

// fakeIdP is a minimal OIDC provider: a discovery document, a JWKS, and a token
// endpoint that answers a code this test registered with an RS256 ID token
// signed by a key generated for this test.
type fakeIdP struct {
	t        *testing.T
	srv      *httptest.Server
	prefix   string // discovery path prefix ("" or "/organizations/v2.0")
	clientID string
	key      *rsa.PrivateKey
	kid      string

	mu         sync.Mutex
	codes      map[string]map[string]any
	tokenCalls int
}

func newFakeIdP(t *testing.T, clientID string) *fakeIdP {
	t.Helper()
	return newFakeIdPAt(t, clientID, "")
}

// newFakeIdPAt builds a provider whose issuer is srv.URL+prefix. Entra's v2
// endpoints carry a tenant path, and the discovery document's issuer must match
// the issuer this server is configured with, so the prefix is where the shape of
// a tenant endpoint is reproduced.
func newFakeIdPAt(t *testing.T, clientID, prefix string) *fakeIdP {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("rsa.GenerateKey: %v", err)
	}
	f := &fakeIdP{
		t: t, prefix: prefix, clientID: clientID, key: key,
		kid:   "test-key-1",
		codes: map[string]map[string]any{},
	}
	mux := http.NewServeMux()
	var srv *httptest.Server
	mux.HandleFunc(prefix+"/.well-known/openid-configuration", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"issuer":                                srv.URL + prefix,
			"authorization_endpoint":                srv.URL + "/authorize",
			"token_endpoint":                        srv.URL + "/token",
			"jwks_uri":                              srv.URL + "/certs",
			"id_token_signing_alg_values_supported": []string{"RS256"},
		})
	})
	mux.HandleFunc("/certs", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"keys": []map[string]string{{
			"kty": "RSA", "use": "sig", "alg": "RS256", "kid": f.kid,
			"n": base64.RawURLEncoding.EncodeToString(key.N.Bytes()),
			// "e" is the exponent as big-endian bytes, per RFC 7518 § 6.3.1.
			"e": base64.RawURLEncoding.EncodeToString(big.NewInt(int64(key.E)).Bytes()),
		}}})
	})
	mux.HandleFunc("/token", f.handleToken)
	srv = httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	f.srv = srv
	return f
}

func (f *fakeIdP) issuer() string { return f.srv.URL + f.prefix }

// register says what the ID token for `code` will claim. The test owns the
// claims precisely because the point of these tests is which claims the
// adapters read and refuse.
func (f *fakeIdP) register(code string, claims map[string]any) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.codes[code] = claims
}

func (f *fakeIdP) calls() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.tokenCalls
}

// handleToken redeems a registered code. An unknown code is the honest 400: the
// reason a code minted for provider B fails at provider A's endpoint is that A
// never issued it.
func (f *fakeIdP) handleToken(w http.ResponseWriter, r *http.Request) {
	_ = r.ParseForm()
	code := r.FormValue("code")
	f.mu.Lock()
	f.tokenCalls++
	claims, ok := f.codes[code]
	f.mu.Unlock()
	if !ok {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "invalid_grant"})
		return
	}
	now := time.Now()
	payload := map[string]any{
		"iss": f.issuer(),
		"aud": f.clientID,
		"exp": now.Add(time.Hour).Unix(),
		"iat": now.Unix(),
	}
	for k, v := range claims {
		payload[k] = v
	}
	tok := f.sign(payload)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"access_token": "fake-access-token",
		"token_type":   "Bearer",
		"expires_in":   3600,
		"id_token":     tok,
	})
}

// sign writes an RS256 JWS by hand: the repo depends on no JWT library directly,
// and a test fixture has no business adding one.
func (f *fakeIdP) sign(claims map[string]any) string {
	f.t.Helper()
	header, err := json.Marshal(map[string]string{"alg": "RS256", "typ": "JWT", "kid": f.kid})
	if err != nil {
		f.t.Fatalf("marshal header: %v", err)
	}
	body, err := json.Marshal(claims)
	if err != nil {
		f.t.Fatalf("marshal claims: %v", err)
	}
	signing := base64.RawURLEncoding.EncodeToString(header) + "." +
		base64.RawURLEncoding.EncodeToString(body)
	sum := sha256.Sum256([]byte(signing))
	sig, err := rsa.SignPKCS1v15(rand.Reader, f.key, crypto.SHA256, sum[:])
	if err != nil {
		f.t.Fatalf("sign: %v", err)
	}
	return signing + "." + base64.RawURLEncoding.EncodeToString(sig)
}

// mpFlow is one API replica with a provider list, plus the http.Client that
// plays the browser.
type mpFlow struct {
	t           *testing.T
	publicURL   string
	databaseURL string
	svc         *Service
	client      *http.Client
}

func requireDatabase(t *testing.T) string {
	t.Helper()
	url := os.Getenv("COMMUNICATION_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("COMMUNICATION_TEST_DATABASE_URL not set")
	}
	return url
}

// startMultiFlow serves the API with exactly these providers. The public URL is
// fixed before the handler exists, so the redirect URI is the one the provider
// list will send.
func startMultiFlow(t *testing.T, cfg Config, providers ...Provider) *mpFlow {
	t.Helper()
	databaseURL := flowDatabase(t, requireDatabase(t))
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	ensureMigrated(t, databaseURL)
	pool, err := postgres.Open(ctx, databaseURL)
	if err != nil {
		t.Fatalf("postgres.Open: %v", err)
	}
	t.Cleanup(pool.Close)

	srv := httptest.NewUnstartedServer(nil)
	publicURL := "http://" + srv.Listener.Addr().String()
	cfg.PublicURL = publicURL
	cfg.CookieSecure = false
	cfg.SessionTTL = time.Hour
	cfg.Providers = append(cfg.Providers, providers...)
	if err := cfg.Validate(); err != nil {
		t.Fatalf("config: %v", err)
	}
	svc := New(cfg, &postgres.IdentityStore{Pool: pool}, nil)
	apiSrv := api.New(api.Config{ReplicaName: "multi-a", Version: "test", PublicURL: publicURL},
		nil, svc, nil)
	svc.Register(apiSrv)
	srv.Config.Handler = apiSrv
	srv.Start()
	t.Cleanup(srv.Close)

	f := &mpFlow{t: t, publicURL: publicURL, databaseURL: databaseURL, svc: svc}
	// Every user these tests create is keyed by a fake issuer whose host is this
	// test's own loopback port, so cleanup can be exact without touching a row
	// another suite wrote.
	t.Cleanup(func() { f.purgeIssuers(providers...) })
	return f
}

func (f *mpFlow) purgeIssuers(providers ...Provider) {
	f.t.Helper()
	issuers := make([]string, 0, len(providers))
	for _, p := range providers {
		if p.Issuer != "" {
			issuers = append(issuers, p.Issuer)
		}
	}
	if len(issuers) == 0 {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	pool, err := postgres.Open(ctx, f.databaseURL)
	if err != nil {
		f.t.Errorf("purge: open pool: %v", err)
		return
	}
	defer pool.Close()
	ids := []string{}
	rows, err := pool.Query(ctx, `SELECT user_id::text FROM oidc_identities WHERE issuer = ANY($1)`, issuers)
	if err != nil {
		f.t.Errorf("purge: select users: %v", err)
		return
	}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			f.t.Errorf("purge: scan: %v", err)
		}
		ids = append(ids, id)
	}
	rows.Close()
	if len(ids) == 0 {
		return
	}
	for _, q := range []string{
		`DELETE FROM sessions WHERE user_id = ANY($1::uuid[])`,
		`DELETE FROM user_avatars WHERE user_id = ANY($1::uuid[])`,
		`DELETE FROM oidc_identities WHERE user_id = ANY($1::uuid[])`,
		`DELETE FROM users WHERE id = ANY($1::uuid[])`,
	} {
		if _, err := pool.Exec(ctx, q, ids); err != nil {
			f.t.Errorf("purge %q: %v", q[:24], err)
		}
	}
}

// beginLogin starts a handshake and returns (state, nonce) out of the 302 the
// browser would be sent to.
func (f *mpFlow) beginLogin(provider, returnTo string) (status int, location string) {
	f.t.Helper()
	query := url.Values{}
	if provider != "" {
		query.Set("provider", provider)
	}
	if returnTo != "" {
		query.Set("return_to", returnTo)
	}
	target := f.publicURL + "/auth/login"
	if len(query) > 0 {
		target += "?" + query.Encode()
	}
	resp, err := f.noRedirect().Get(target)
	if err != nil {
		f.t.Fatalf("GET /auth/login: %v", err)
	}
	defer func() { _, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<16)); resp.Body.Close() }()
	loc := resp.Header.Get("Location")
	return resp.StatusCode, loc
}

func (f *mpFlow) noRedirect() *http.Client {
	jar, err := cookiejar.New(nil)
	if err != nil {
		f.t.Fatalf("cookiejar: %v", err)
	}
	return &http.Client{
		Jar:           jar,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
}

// handshake performs login through idp and returns the callback response, so a
// test can assert on the 302, its cookie, or a problem body.
func (f *mpFlow) handshake(idp *fakeIdP, provider, code string, claims map[string]any) *http.Response {
	f.t.Helper()
	status, location := f.beginLogin(provider, "")
	if status != http.StatusFound {
		f.t.Fatalf("GET /auth/login status = %d, want 302 (location %q)", status, location)
	}
	q, err := url.Parse(location)
	if err != nil {
		f.t.Fatalf("parse authorize url: %v", err)
	}
	state, nonce := q.Query().Get("state"), q.Query().Get("nonce")
	if state == "" || nonce == "" {
		f.t.Fatalf("authorize url carries no state/nonce: %s", redactURL(location))
	}
	if !strings.HasPrefix(q.String(), idp.srv.URL) {
		f.t.Fatalf("login redirected to %s, want it under the named provider %s",
			redactURL(location), idp.issuer())
	}
	// The nonce this handshake minted is what the ID token must carry; every
	// other claim is the test's, because which claims an adapter reads and
	// refuses is the point.
	if claims == nil {
		claims = map[string]any{}
	}
	claims["nonce"] = nonce
	if _, ok := claims["sub"]; !ok {
		claims["sub"] = "flow-subject"
	}
	idp.register(code, claims)
	return f.getRaw(f.publicURL + "/auth/callback?code=" + url.QueryEscape(code) +
		"&state=" + url.QueryEscape(state))
}

func (f *mpFlow) getRaw(target string) *http.Response {
	f.t.Helper()
	resp, err := f.noRedirect().Get(target)
	if err != nil {
		f.t.Fatalf("GET %s: %v", target, err)
	}
	return resp
}

// claimsFor builds the ID-token claims a test wants, keeping the sub/nonce
// handling of handshake readable at the call site.
func claimsFor(extra map[string]any) map[string]any {
	out := map[string]any{}
	for k, v := range extra {
		out[k] = v
	}
	return out
}

// TestFlowProvidersListsEveryConfiguredProvider is the login chooser's read:
// public, in configuration order, and carrying nothing but an id and a label.
func TestFlowProvidersListsEveryConfiguredProvider(t *testing.T) {
	alpha := newFakeIdP(t, "alpha-client")
	beta := newFakeIdP(t, "beta-client")
	f := startMultiFlow(t, Config{BootstrapAdminSubjects: []string{"frank"}},
		Provider{ID: "tailnet", Kind: KindTsidp, Issuer: alpha.issuer(), ClientID: "alpha-client"},
		Provider{ID: "work", Label: "Microsoft (E-gineering)", Kind: KindGeneric,
			Issuer: beta.issuer(), ClientID: "beta-client"},
	)

	resp := f.getRaw(f.publicURL + "/auth/providers")
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<16))
		t.Fatalf("GET /auth/providers status = %d, want 200: %s", resp.StatusCode, body)
	}
	if got := resp.Header.Get("Content-Type"); !strings.Contains(got, "application/json") {
		t.Errorf("content type = %q", got)
	}
	if got := resp.Header.Get("Cache-Control"); got != "no-store" {
		t.Errorf("Cache-Control = %q, want no-store: the list changes with the deployment", got)
	}
	var items []map[string]string
	if err := json.NewDecoder(resp.Body).Decode(&items); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(items) != 2 {
		t.Fatalf("providers = %v, want two entries in configuration order", items)
	}
	if items[0]["id"] != "tailnet" || items[0]["label"] != "Tailscale" {
		t.Errorf("first entry = %v, want the tsidp kind's default label", items[0])
	}
	if items[1]["id"] != "work" || items[1]["label"] != "Microsoft (E-gineering)" {
		t.Errorf("second entry = %v, want the configured label", items[1])
	}
	// The route is public and says nothing an unauthenticated visitor has no
	// business seeing.
	for _, item := range items {
		for _, leak := range []string{"client", "http", "issuer", "secret"} {
			for _, v := range item {
				if strings.Contains(strings.ToLower(v), leak) {
					t.Errorf("provider entry %v leaks %q", item, leak)
				}
			}
		}
	}
}

// TestFlowSingleProviderKeepsTodayBehaviour is the compatibility promise: an
// env-only Config (no provider list) still redirects straight at its issuer,
// with the same scopes, and lists exactly one provider for the login page.
func TestFlowSingleProviderKeepsTodayBehaviour(t *testing.T) {
	idp := newFakeIdP(t, "communication-test")
	f := startMultiFlow(t, Config{Issuer: idp.issuer(), ClientID: "communication-test"})

	resp := f.getRaw(f.publicURL + "/auth/providers")
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if strings.TrimSpace(string(body)) != `[{"id":"default","label":"OIDC"}]` {
		t.Fatalf("providers = %s, want the one synthesized default", body)
	}

	status, location := f.beginLogin("", "")
	if status != http.StatusFound {
		t.Fatalf("GET /auth/login status = %d, want 302", status)
	}
	q, err := url.Parse(location)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if !strings.HasPrefix(q.String(), idp.issuer()) {
		t.Fatalf("login went to %s, want it under the single issuer", redactURL(location))
	}
	if got := q.Query().Get("scope"); got != "openid profile email" {
		t.Errorf("scope = %q, want the pre-ADR-0083 list", got)
	}
	if q.Query().Get("code_challenge_method") != "S256" || q.Query().Get("redirect_uri") !=
		f.publicURL+"/auth/callback" {
		t.Errorf("PKCE or redirect_uri changed: %s", redactURL(location))
	}
	// A provider id that does not exist is a bad link, not an outage.
	if status, _ := f.beginLogin("tailnet", ""); status != http.StatusBadRequest {
		t.Errorf("GET /auth/login?provider=tailnet status = %d, want 400", status)
	}
}

// TestFlowChooserRedirectWhenSeveralProviders is the multi-provider case with no
// provider named: the server cannot pick a person's employer for them, so it
// sends the browser to the chooser with the deep link intact.
func TestFlowChooserRedirectWhenSeveralProviders(t *testing.T) {
	alpha, beta := newFakeIdP(t, "a"), newFakeIdP(t, "b")
	f := startMultiFlow(t, Config{},
		Provider{ID: "a", Kind: KindGeneric, Issuer: alpha.issuer(), ClientID: "a"},
		Provider{ID: "b", Kind: KindGeneric, Issuer: beta.issuer(), ClientID: "b"},
	)
	status, location := f.beginLogin("", "/board")
	if status != http.StatusFound {
		t.Fatalf("status = %d, want 302 to the chooser", status)
	}
	if want := "/login?return_to=%2Fboard"; location != want {
		t.Errorf("location = %q, want %q", location, want)
	}
	// A hostile return_to is still sanitized on the way to the chooser.
	if _, location := f.beginLogin("", "//evil.example"); location != "/login?return_to=%2F" {
		t.Errorf("location for a hostile return_to = %q, want the sanitized chooser link", location)
	}
}

// TestFlowTwoProvidersCreateTwoUsers is the identity half of ADR-0083: users are
// keyed by (issuer, subject), so the SAME subject at two providers is two users
// — and only the one the bootstrap list names at that provider is an admin.
func TestFlowTwoProvidersCreateTwoUsers(t *testing.T) {
	alpha, beta := newFakeIdP(t, "alpha-client"), newFakeIdP(t, "beta-client")
	f := startMultiFlow(t, Config{BootstrapAdminSubjects: []string{"beta:shared-sub"}},
		Provider{ID: "alpha", Kind: KindTsidp, Issuer: alpha.issuer(), ClientID: "alpha-client"},
		Provider{ID: "beta", Kind: KindGeneric, Issuer: beta.issuer(), ClientID: "beta-client"},
	)

	respA := f.handshake(alpha, "alpha", "code-alpha", claimsFor(map[string]any{
		"sub": "shared-sub", "name": "Shared Person", "email": "shared@example.test",
	}))
	defer respA.Body.Close()
	if respA.StatusCode != http.StatusFound {
		body, _ := io.ReadAll(io.LimitReader(respA.Body, 1<<16))
		t.Fatalf("alpha login status = %d, want 302: %s", respA.StatusCode, body)
	}
	respB := f.handshake(beta, "beta", "code-beta", claimsFor(map[string]any{
		"sub": "shared-sub", "name": "Shared Person",
	}))
	defer respB.Body.Close()
	if respB.StatusCode != http.StatusFound {
		t.Fatalf("beta login status = %d, want 302", respB.StatusCode)
	}
	if alpha.calls() != 1 || beta.calls() != 1 {
		t.Errorf("token calls = alpha %d beta %d, want one each", alpha.calls(), beta.calls())
	}

	type identity struct{ issuer, subject string }
	rows, err := f.queryRows(`
		SELECT i.issuer, i.subject, u.display_name, u.is_org_admin
		FROM oidc_identities i JOIN users u ON u.id = i.user_id
		WHERE i.issuer IN ($1, $2)
		ORDER BY i.issuer`, alpha.issuer(), beta.issuer())
	if err != nil {
		t.Fatalf("query identities: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("identities = %v, want one row per provider", rows)
	}
	// Keyed by issuer, because the two fake issuers differ only in their
	// loopback port and SQL orders them by text.
	byIssuer := map[string][3]string{}
	for _, row := range rows {
		byIssuer[row[0]] = [3]string{row[1], row[2], row[3]}
	}
	if len(byIssuer) != 2 {
		t.Fatalf("identities = %v, want two distinct issuers", rows)
	}
	for name, idp := range map[string]*fakeIdP{"alpha": alpha, "beta": beta} {
		row, ok := byIssuer[idp.issuer()]
		if !ok {
			t.Fatalf("%s has no identity row among %v", name, rows)
		}
		if row[0] != "shared-sub" {
			t.Errorf("%s subject = %q, want the shared one", name, row[0])
		}
		if row[1] != "Shared Person" {
			t.Errorf("%s display_name = %q, want the name claim", name, row[1])
		}
		wantAdmin := "false"
		if name == "beta" {
			// `beta:shared-sub` is qualified: it grants admin at beta and nowhere
			// else, so the same subject at alpha stays a plain member.
			wantAdmin = "true"
		}
		if row[2] != wantAdmin {
			t.Errorf("is_org_admin at %s = %s, want %s", name, row[2], wantAdmin)
		}
	}
}

// TestFlowStateIsBoundToItsProvider is ADR-0083's callback rule: a handshake
// minted for one provider cannot be finished at another, and the refusal
// happens before either IdP's token endpoint is touched.
func TestFlowStateIsBoundToItsProvider(t *testing.T) {
	alpha, beta := newFakeIdP(t, "alpha-client"), newFakeIdP(t, "beta-client")
	f := startMultiFlow(t, Config{},
		Provider{ID: "alpha", Kind: KindGeneric, Issuer: alpha.issuer(), ClientID: "alpha-client"},
		Provider{ID: "beta", Kind: KindGeneric, Issuer: beta.issuer(), ClientID: "beta-client"},
	)

	// Mint a state for alpha and never finish it.
	_, location := f.beginLogin("alpha", "")
	q, err := url.Parse(location)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	state := q.Query().Get("state")
	if state == "" {
		t.Fatalf("no state in %s", redactURL(location))
	}
	// A code that beta's IdP WOULD redeem: the provider binding must stop it
	// before the exchange, so beta's token endpoint must stay silent.
	beta.register("code-at-beta", map[string]any{"sub": "attacker", "nonce": "not-the-stored-one"})

	resp := f.getRaw(f.publicURL + "/auth/callback/alpha-mismatch?code=code-at-beta&state=" +
		url.QueryEscape(state))
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("unknown provider path status = %d, want 400", resp.StatusCode)
	}
	resp.Body.Close()

	mismatch := f.getRaw(f.publicURL + "/auth/callback/beta?code=code-at-beta&state=" +
		url.QueryEscape(state))
	if mismatch.StatusCode != http.StatusBadRequest {
		body, _ := io.ReadAll(io.LimitReader(mismatch.Body, 1<<16))
		t.Fatalf("cross-provider callback status = %d, want 400: %s", mismatch.StatusCode, body)
	}
	mismatch.Body.Close()

	// The state is consumed by the refusal (single use, as before), so replaying
	// it at the RIGHT provider now fails too.
	replay := f.getRaw(f.publicURL + "/auth/callback?code=code-at-beta&state=" + url.QueryEscape(state))
	if replay.StatusCode != http.StatusBadRequest {
		t.Errorf("replayed state status = %d, want 400", replay.StatusCode)
	}
	replay.Body.Close()

	// A state still in flight for alpha, redeemed at the bare callback: the
	// server follows the STATE, so it asks alpha — which never issued the code —
	// and beta is never contacted.
	_, location = f.beginLogin("alpha", "")
	q, _ = url.Parse(location)
	state = q.Query().Get("state")
	second := f.getRaw(f.publicURL + "/auth/callback?code=code-at-beta&state=" + url.QueryEscape(state))
	if second.StatusCode != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401 from alpha's token endpoint", second.StatusCode)
	}
	second.Body.Close()
	if beta.calls() != 0 {
		t.Errorf("beta's token endpoint was called %d times, want 0: the state named alpha",
			beta.calls())
	}
	// A floor, not an equality: a FAILED token request is retried by
	// golang.org/x/oauth2 with the other client-auth style (its
	// cachedAuthStyle probe), so one exchange can POST twice. What matters here
	// is that the POSTs went to alpha and never to beta.
	if alpha.calls() < 1 {
		t.Errorf("alpha's token endpoint was called %d times, want at least 1", alpha.calls())
	}
}

// TestFlowEntraPhotoIsStoredAndServedSameOrigin is ADR-0083 scope item 2 end to
// end: a tenant-allowlisted Entra login, its photo taken from a Graph-shaped
// server with the access token, stored, and served from this origin with an
// etag. An oversized photo costs the face, never the login.
func TestFlowEntraPhotoIsStoredAndServedSameOrigin(t *testing.T) {
	const tenant = "eeeeeeee-aaaa-bbbb-cccc-dddddddddddd"
	var graphMu sync.Mutex
	var graphAuth []string
	noteGraphAuth := func(v string) {
		graphMu.Lock()
		defer graphMu.Unlock()
		graphAuth = append(graphAuth, v)
	}
	graphAuthHeaders := func() []string {
		graphMu.Lock()
		defer graphMu.Unlock()
		return append([]string(nil), graphAuth...)
	}
	graphBody := func(t *testing.T, body []byte) *httptest.Server {
		t.Helper()
		return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/me/photo/$value" {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			noteGraphAuth(r.Header.Get("Authorization"))
			w.Header().Set("Content-Type", "image/jpeg")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(body)
		}))
	}
	jpeg := append([]byte{0xff, 0xd8, 0xff, 0xe0}, bytes.Repeat([]byte("jpeg"), 32)...)
	graph := graphBody(t, jpeg)
	defer graph.Close()

	idp := newFakeIdPAt(t, "work-client", "/organizations/v2.0")
	// Microsoft's multi-tenant rule: the code is redeemed at the organizations
	// endpoint, and the token's iss names the SIGNING USER's tenant.
	tenantIssuer := strings.TrimPrefix(idp.issuer(), idp.srv.URL+"/organizations")
	f := startMultiFlow(t, Config{},
		Provider{
			ID: "work", Kind: KindEntra, Issuer: idp.issuer(), ClientID: "work-client",
			Entra: EntraConfig{AllowedTenants: []string{tenant}, FetchPhoto: true, GraphBaseURL: graph.URL},
		},
	)

	resp := f.handshake(idp, "work", "entra-code", claimsFor(map[string]any{
		"sub": "pairwise-sub", "tid": tenant, "oid": "999",
		"iss":  idp.srv.URL + "/" + tenant + "/v2.0",
		"name": "Davida Birks", "preferred_username": "davida@eg.test",
	}))
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusFound {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<16))
		t.Fatalf("entra login status = %d, want 302: %s", resp.StatusCode, body)
	}
	if tenantIssuer == "" {
		t.Fatalf("test fixture lost the issuer prefix")
	}
	if got := graphAuthHeaders(); len(got) != 1 || got[0] != "Bearer fake-access-token" {
		t.Errorf("graph Authorization headers = %v, want the bearer token once", got)
	}

	// The person is keyed by tid/oid, not the pairwise sub.
	rows, err := f.queryRows(`
		SELECT u.id::text, i.subject, u.display_name, u.email, u.avatar_url
		FROM oidc_identities i JOIN users u ON u.id = i.user_id WHERE i.issuer = $1`, idp.issuer())
	if err != nil {
		t.Fatalf("query user: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("users = %v, want one", rows)
	}
	userID, subject, avatarURL := rows[0][0], rows[0][1], rows[0][4]
	if want := tenant + "/999"; subject != want {
		t.Errorf("subject = %q, want %q (sub is pairwise per application)", subject, want)
	}
	if want := "/api/v1/users/" + userID + "/avatar"; avatarURL != want {
		t.Fatalf("avatar_url = %q, want the same-origin path %q", avatarURL, want)
	}

	avatar := f.getRaw(f.publicURL + avatarURL)
	// The session cookie from the login must ride along; without it the route is
	// 401 like the rest of /api/v1.
	if avatar.StatusCode == http.StatusUnauthorized {
		// Re-get with the cookie the callback set.
		req, err := http.NewRequest(http.MethodGet, f.publicURL+avatarURL, nil)
		if err != nil {
			t.Fatalf("new request: %v", err)
		}
		for _, c := range resp.Cookies() {
			if c.Name == CookieName {
				req.AddCookie(c)
			}
		}
		avatar.Body.Close()
		resp2, err := (&http.Client{CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		}}).Do(req)
		if err != nil {
			t.Fatalf("GET avatar: %v", err)
		}
		avatar = resp2
	}
	defer avatar.Body.Close()
	if avatar.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(avatar.Body, 1<<16))
		t.Fatalf("GET avatar status = %d, want 200: %s", avatar.StatusCode, body)
	}
	if got := avatar.Header.Get("Content-Type"); got != "image/jpeg" {
		t.Errorf("avatar content type = %q, want the sniffed image/jpeg", got)
	}
	if got := avatar.Header.Get("Cache-Control"); got != "private, max-age=3600" {
		t.Errorf("Cache-Control = %q", got)
	}
	etag := avatar.Header.Get("ETag")
	if !strings.HasPrefix(etag, `"sha256-`) || !strings.HasSuffix(etag, `"`) {
		t.Fatalf("ETag = %q, want a quoted sha256 validator", etag)
	}
	body, _ := io.ReadAll(avatar.Body)
	if !bytes.Equal(body, jpeg) {
		t.Errorf("avatar body = %d bytes, want the photo", len(body))
	}

	notModified := func() *http.Response {
		req, err := http.NewRequest(http.MethodGet, f.publicURL+avatarURL, nil)
		if err != nil {
			t.Fatalf("new request: %v", err)
		}
		req.Header.Set("If-None-Match", etag)
		copySession(req, resp)
		r, err := (&http.Client{CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		}}).Do(req)
		if err != nil {
			t.Fatalf("conditional GET: %v", err)
		}
		return r
	}()
	defer notModified.Body.Close()
	if notModified.StatusCode != http.StatusNotModified {
		t.Errorf("If-None-Match status = %d, want 304", notModified.StatusCode)
	}

	// A 404 for a user with no stored photo, and for an id that is not one.
	noUser := f.getRaw(f.publicURL + "/api/v1/users/00000000-0000-0000-0000-000000000000/avatar")
	if noUser.StatusCode != http.StatusNotFound && noUser.StatusCode != http.StatusUnauthorized {
		t.Errorf("unknown user avatar status = %d, want 404 (or 401 without a session)", noUser.StatusCode)
	}
	noUser.Body.Close()
	notUUID := f.getRaw(f.publicURL + "/api/v1/users/not-a-uuid/avatar")
	if notUUID.StatusCode != http.StatusNotFound && notUUID.StatusCode != http.StatusUnauthorized {
		t.Errorf("malformed id avatar status = %d, want 404 (or 401)", notUUID.StatusCode)
	}
	notUUID.Body.Close()
}

// TestFlowEntraOversizedPhotoCostsOnlyTheFace is the 300 KiB row of ADR-0083's
// verification matrix.
func TestFlowEntraOversizedPhotoCostsOnlyTheFace(t *testing.T) {
	const tenant = "eeeeeeee-aaaa-bbbb-cccc-dddddddddddd"
	big := append([]byte{0xff, 0xd8, 0xff, 0xe0}, bytes.Repeat([]byte("jpeg"), MaxAvatarBytes/4+1)...)
	if len(big) <= MaxAvatarBytes {
		t.Fatalf("fixture is %d bytes, want over the %d byte cap", len(big), MaxAvatarBytes)
	}
	graph := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/jpeg")
		_, _ = w.Write(big)
	}))
	defer graph.Close()

	idp := newFakeIdPAt(t, "work-client", "/organizations/v2.0")
	f := startMultiFlow(t, Config{},
		Provider{ID: "work", Kind: KindEntra, Issuer: idp.issuer(), ClientID: "work-client",
			Entra: EntraConfig{AllowedTenants: []string{tenant}, FetchPhoto: true, GraphBaseURL: graph.URL}},
	)
	resp := f.handshake(idp, "work", "big-code", claimsFor(map[string]any{
		"sub": "pairwise-sub", "tid": tenant, "oid": "888",
		"iss": idp.srv.URL + "/" + tenant + "/v2.0", "name": "Big Face",
	}))
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("an oversized photo must not fail a login: status = %d", resp.StatusCode)
	}
	rows, err := f.queryRows(`
		SELECT u.id::text, u.avatar_url FROM oidc_identities i
		JOIN users u ON u.id = i.user_id WHERE i.issuer = $1`, idp.issuer())
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	if len(rows) != 1 || rows[0][1] != "" {
		t.Fatalf("users = %v, want one row whose avatar_url is empty", rows)
	}
	avatar := f.getRaw(f.publicURL + "/api/v1/users/" + rows[0][0] + "/avatar")
	avatar.Body.Close()
	if avatar.StatusCode == http.StatusOK {
		t.Errorf("GET avatar = 200 for a photo that was refused, want 404")
	}
}

// TestFlowEntraRefusesAnUnlistedTenant proves the allowlist is what admits a
// login, not the discovery document: the token is signed by the trusted IdP and
// still rejected.
func TestFlowEntraRefusesAnUnlistedTenant(t *testing.T) {
	const tenant = "eeeeeeee-aaaa-bbbb-cccc-dddddddddddd"
	graph := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer graph.Close()
	idp := newFakeIdPAt(t, "work-client", "/organizations/v2.0")
	f := startMultiFlow(t, Config{},
		Provider{ID: "work", Kind: KindEntra, Issuer: idp.issuer(), ClientID: "work-client",
			Entra: EntraConfig{AllowedTenants: []string{tenant}, FetchPhoto: true, GraphBaseURL: graph.URL}},
	)
	const other = "ffffffff-aaaa-bbbb-cccc-dddddddddddd"
	resp := f.handshake(idp, "work", "wrong-tenant", claimsFor(map[string]any{
		"sub": "pairwise-sub", "tid": other, "oid": "777",
		"iss": idp.srv.URL + "/" + other + "/v2.0",
	}))
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unlisted tenant status = %d, want 401", resp.StatusCode)
	}
	rows, err := f.queryRows(`SELECT count(*) FROM oidc_identities WHERE issuer = $1`, idp.issuer())
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	if rows[0][0] != "0" {
		t.Errorf("identities = %s, want none: a refused admission creates no user", rows[0][0])
	}
}

// queryRows runs a read against the flow's database, stringifying every column
// so a test can assert without importing a driver of its own.
func (f *mpFlow) queryRows(query string, args ...any) ([][]string, error) {
	f.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pool, err := postgres.Open(ctx, f.databaseURL)
	if err != nil {
		return nil, err
	}
	defer pool.Close()
	rows, err := pool.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out [][]string
	for rows.Next() {
		values, err := rows.Values()
		if err != nil {
			return nil, err
		}
		row := make([]string, 0, len(values))
		for _, v := range values {
			if b, ok := v.([]byte); ok {
				row = append(row, string(b))
				continue
			}
			row = append(row, fmt.Sprint(v))
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

// copySession puts the login's session cookie on a hand-built request.
func copySession(req *http.Request, login *http.Response) {
	for _, c := range login.Cookies() {
		if c.Name == CookieName {
			req.AddCookie(c)
		}
	}
}
