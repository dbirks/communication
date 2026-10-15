package auth

import (
	"errors"
	"os"
	"strings"
	"testing"
	"time"
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
