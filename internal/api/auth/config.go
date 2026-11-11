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
	// EnvProvidersFile is ADR-0083's list: a YAML file naming every identity
	// provider this deployment signs people in with. Unset means the single
	// issuer above, synthesized into one `default` provider.
	EnvProvidersFile = "COMMUNICATION_OIDC_PROVIDERS_FILE"
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
	// login (COMMUNICATION_BOOTSTRAP_ADMIN_SUBJECTS). An entry is either a bare
	// subject — which applies to the `default` provider only — or the ADR-0083
	// `provider:subject` form.
	BootstrapAdminSubjects []string
	// SessionTTL is the session lifetime; zero means DefaultSessionTTL.
	SessionTTL time.Duration
	// Providers is the ADR-0083 identity provider list. Empty means "use the
	// single-issuer fields above", which are then synthesized into one `generic`
	// provider with id `default`.
	Providers []Provider
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
	if len(c.Providers) == 0 {
		// The pre-ADR-0083 single-issuer contract, unchanged.
		if strings.TrimSpace(c.Issuer) == "" {
			missing = append(missing, EnvIssuer)
		}
		if strings.TrimSpace(c.ClientID) == "" {
			missing = append(missing, EnvClientID)
		}
	}
	if strings.TrimSpace(c.PublicURL) == "" {
		missing = append(missing, EnvPublicURL)
	}
	if len(missing) > 0 {
		return fmt.Errorf("auth: missing required configuration: %s", strings.Join(missing, ", "))
	}
	if len(c.Providers) > 0 {
		seen := map[string]bool{}
		for i, p := range c.Providers {
			if p.ID == "" || !providerIDRe.MatchString(p.ID) {
				return fmt.Errorf("auth: providers[%d]: id %q must match %s", i, p.ID, providerIDRe.String())
			}
			if seen[p.ID] {
				return fmt.Errorf("auth: providers[%d]: duplicate provider id %q", i, p.ID)
			}
			seen[p.ID] = true
			if p.Issuer == "" || p.ClientID == "" {
				return fmt.Errorf("auth: provider %q needs an issuer and a client_id", p.ID)
			}
			if p.Kind == KindEntra {
				if len(p.Entra.AllowedTenants) == 0 {
					return fmt.Errorf("auth: provider %q: kind entra requires a non-empty entra.allowed_tenants", p.ID)
				}
				if err := validateEntraIssuer(p.ID, p.Issuer); err != nil {
					return err
				}
			}
			if _, err := p.adapterFor(); err != nil {
				return fmt.Errorf("auth: provider %q: %w", p.ID, err)
			}
		}
	}
	return nil
}

// LoginProviders returns the providers this deployment signs people in with:
// the configured list, or one synthesized `default` provider built from the
// single-issuer environment fields (ADR-0083 "Configuration").
func (c Config) LoginProviders() []Provider {
	if len(c.Providers) > 0 {
		out := make([]Provider, len(c.Providers))
		copy(out, c.Providers)
		return out
	}
	return []Provider{envProvider(c.Issuer, c.BrowserIssuer, c.ClientID, c.ClientSecret)}
}

// providerIDSet is the set of configured provider ids, which is what tells a
// `provider:subject` bootstrap-admin entry from a subject that contains a
// colon (`userid:16684175954410223` is tailscale's subject shape).
func (c Config) providerIDSet() map[string]bool {
	out := map[string]bool{DefaultProviderID: true}
	for _, p := range c.Providers {
		if p.ID != "" {
			out[p.ID] = true
		}
	}
	return out
}

// RedirectURL is the fixed OIDC callback URI.
func (c Config) RedirectURL() string {
	return strings.TrimSuffix(c.PublicURL, "/") + "/auth/callback"
}

// IsBootstrapAdmin reports whether a subject grants organization admin on the
// `default` provider — the pre-ADR-0083 meaning, kept for its callers.
func (c Config) IsBootstrapAdmin(subject string) bool {
	return c.IsBootstrapAdminFor(DefaultProviderID, subject)
}

// IsBootstrapAdminFor reports whether a login at providerID grants organization
// admin. Two entry forms are accepted (ADR-0083 scope item 3):
//
//   - `provider:subject` — matched at split-on-the-FIRST-colon, so tailscale's
//     own `userid:<n>` subject survives qualification: `tailnet:userid:1668…`.
//   - a bare subject — the old COMMUNICATION_BOOTSTRAP_ADMIN_SUBJECTS form, and
//     it applies to the `default` provider only. That is what keeps a subject
//     like `userid:1668…` (whose colon is part of the subject, not a provider
//     prefix) working exactly as it does today.
//
// An entry whose prefix names no configured provider is a bare subject, so a
// typo'd provider id never silently becomes a wildcard.
func (c Config) IsBootstrapAdminFor(providerID, subject string) bool {
	if subject == "" || providerID == "" {
		return false
	}
	ids := c.providerIDSet()
	for _, entry := range c.BootstrapAdminSubjects {
		if entry == "" {
			continue
		}
		if id, rest, ok := strings.Cut(entry, ":"); ok && ids[id] {
			if id == providerID && rest == subject {
				return true
			}
			continue
		}
		if providerID == DefaultProviderID && entry == subject {
			return true
		}
	}
	return false
}

// ConfigFromEnv builds a Config from the M1 environment contract plus, when
// COMMUNICATION_OIDC_PROVIDERS_FILE names one, the ADR-0083 provider list. It
// fails when Issuer, ClientID or PublicURL is absent, when the providers file
// will not parse or admits a provider whose rules this build cannot enforce, and
// when CookieSecure is set to something that is not a boolean: silently
// defaulting a Secure flag to false is a security footgun, and so is starting a
// multi-tenant Entra provider with no tenant allowlist.
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
	// The provider list is read before validation, because it REPLACES the
	// issuer and client id requirements: a deployment that names its providers
	// in the file has no COMMUNICATION_OIDC_ISSUER to set, and requiring both
	// would make the file unusable. Bootstrap admins merge rather than
	// replace — the env list keeps working next to the file's.
	if path := strings.TrimSpace(os.Getenv(EnvProvidersFile)); path != "" {
		providers, admins, err := LoadProvidersFile(path)
		if err != nil {
			return Config{}, err
		}
		c.Providers = providers
		c.BootstrapAdminSubjects = append(c.BootstrapAdminSubjects, admins...)
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
