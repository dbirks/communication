// Package auth implements Communication's browser identity path: OIDC
// Authorization Code + PKCE login (communication-spec/06-collaboration-
// identity.md "Identity architecture", ADR-0012) and PostgreSQL-backed
// sessions, exposed as an api.Authenticator plus the /auth/* and /api/v1/me
// handlers.
//
// Discovery is lazy: compose may bring the API up before the identity
// provider, so the first request that needs it performs discovery and a
// failure is retried on the next request instead of killing the replica.
// Sessions resolve from the database alone, so an existing session keeps
// working while the IdP is down (06 "OIDC edge cases").
package auth

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// CookieName is the session cookie holding the raw 32-byte login token. Only
// its sha256 is ever stored (ADR-0012 §5).
const CookieName = "communication_session"

// DefaultSessionTTL is the session lifetime when Config.SessionTTL is unset.
const DefaultSessionTTL = 12 * time.Hour

// LoginStateTTL bounds an in-flight OIDC handshake (ADR-0012 §6).
const LoginStateTTL = 10 * time.Minute

// Environment variable names read by ConfigFromEnv. They are part of the M1
// configuration contract.
const (
	EnvIssuer                 = "COMMUNICATION_OIDC_ISSUER"
	EnvBrowserIssuer          = "COMMUNICATION_OIDC_BROWSER_ISSUER"
	EnvClientID               = "COMMUNICATION_OIDC_CLIENT_ID"
	EnvClientSecret           = "COMMUNICATION_OIDC_CLIENT_SECRET"
	EnvPublicURL              = "COMMUNICATION_PUBLIC_URL"
	EnvCookieSecure           = "COMMUNICATION_COOKIE_SECURE"
	EnvBootstrapAdminSubjects = "COMMUNICATION_BOOTSTRAP_ADMIN_SUBJECTS"
)

// Config is the identity configuration of one deployment.
type Config struct {
	// Issuer is the OIDC issuer used by this server for discovery, token
	// exchange and JWKS (COMMUNICATION_OIDC_ISSUER).
	Issuer string
	// BrowserIssuer optionally replaces the Issuer prefix of the discovered
	// authorization endpoint for browser redirects only
	// (COMMUNICATION_OIDC_BROWSER_ISSUER). Empty means "use Issuer".
	BrowserIssuer string
	// ClientID is the OAuth2 client id (COMMUNICATION_OIDC_CLIENT_ID).
	ClientID string
	// ClientSecret is optional; empty means a public client with PKCE.
	ClientSecret string
	// PublicURL is the browser-facing base URL (COMMUNICATION_PUBLIC_URL).
	// The redirect URI is PublicURL + "/auth/callback".
	PublicURL string
	// CookieSecure sets the Secure cookie flag (COMMUNICATION_COOKIE_SECURE,
	// default true). False is dev-only.
	CookieSecure bool
	// BootstrapAdminSubjects lists OIDC subjects that become org admins at
	// login (COMMUNICATION_BOOTSTRAP_ADMIN_SUBJECTS).
	BootstrapAdminSubjects []string
	// SessionTTL is the session lifetime; zero means DefaultSessionTTL.
	SessionTTL time.Duration
}

// SessionTTLOrDefault returns the configured session lifetime, applying the
// 12 hour default.
func (c Config) SessionTTLOrDefault() time.Duration {
	if c.SessionTTL <= 0 {
		return DefaultSessionTTL
	}
	return c.SessionTTL
}

// Validate reports configuration that would make the login path unsound.
func (c Config) Validate() error {
	var missing []string
	if strings.TrimSpace(c.Issuer) == "" {
		missing = append(missing, EnvIssuer)
	}
	if strings.TrimSpace(c.ClientID) == "" {
		missing = append(missing, EnvClientID)
	}
	if strings.TrimSpace(c.PublicURL) == "" {
		missing = append(missing, EnvPublicURL)
	}
	if len(missing) > 0 {
		return fmt.Errorf("auth: missing required configuration: %s", strings.Join(missing, ", "))
	}
	return nil
}

// RedirectURL is the fixed OIDC callback URI.
func (c Config) RedirectURL() string {
	return strings.TrimSuffix(c.PublicURL, "/") + "/auth/callback"
}

// IsBootstrapAdmin reports whether a subject grants organization admin.
func (c Config) IsBootstrapAdmin(subject string) bool {
	if subject == "" {
		return false
	}
	for _, s := range c.BootstrapAdminSubjects {
		if s == subject {
			return true
		}
	}
	return false
}

// ConfigFromEnv builds a Config from the M1 environment contract. It fails
// when Issuer, ClientID or PublicURL is absent, and when CookieSecure is set
// to something that is not a boolean: silently defaulting a Secure flag to
// false is a security footgun.
func ConfigFromEnv() (Config, error) {
	c := Config{
		Issuer:                 strings.TrimSpace(os.Getenv(EnvIssuer)),
		BrowserIssuer:          strings.TrimSpace(os.Getenv(EnvBrowserIssuer)),
		ClientID:               strings.TrimSpace(os.Getenv(EnvClientID)),
		ClientSecret:           os.Getenv(EnvClientSecret),
		PublicURL:              strings.TrimSpace(os.Getenv(EnvPublicURL)),
		CookieSecure:           true,
		BootstrapAdminSubjects: splitList(os.Getenv(EnvBootstrapAdminSubjects)),
		SessionTTL:             DefaultSessionTTL,
	}
	if v := strings.TrimSpace(os.Getenv(EnvCookieSecure)); v != "" {
		secure, err := strconv.ParseBool(v)
		if err != nil {
			return Config{}, fmt.Errorf("auth: %s must be a boolean: %w", EnvCookieSecure, err)
		}
		c.CookieSecure = secure
	}
	if err := c.Validate(); err != nil {
		return Config{}, err
	}
	return c, errors.Join(c.validateURLs())
}

// validateURLs rejects values that would produce a broken redirect.
func (c Config) validateURLs() error {
	var errs []error
	for _, e := range []struct {
		name, value string
	}{
		{EnvIssuer, c.Issuer},
		{EnvBrowserIssuer, c.BrowserIssuer},
		{EnvPublicURL, c.PublicURL},
	} {
		if value := strings.TrimSpace(e.value); value != "" && !strings.Contains(value, "://") {
			errs = append(errs, fmt.Errorf("auth: %s must be an absolute URL, got %q", e.name, value))
		}
	}
	return errors.Join(errs...)
}

// splitList parses a comma-separated env value, trimming blanks.
func splitList(v string) []string {
	if strings.TrimSpace(v) == "" {
		return nil
	}
	parts := strings.Split(v, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}
