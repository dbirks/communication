package api

import (
	"context"
	"errors"
	"net/http"
)

// Principal is the authenticated human behind an HTTP request, as resolved by
// an Authenticator (see internal/api/auth for the session/OIDC
// implementation). It is deliberately small: authorization decisions are made
// from these fields plus the route, never from client-supplied identifiers.
type Principal struct {
	// UserID is the internal users.id (a Postgres uuidv7 rendered as a string).
	UserID string
	// OrganizationID is the user's owning organization.
	OrganizationID string
	// DisplayName is the human-facing name shown in the UI.
	DisplayName string
	// Email is optional (the IdP may not release it).
	Email string
	// CSRFToken is the session's CSRF token. Browsers must echo it in the
	// X-CSRF-Token header on mutations; it is never logged.
	CSRFToken string
	// IsOrgAdmin grants organization-wide visibility.
	IsOrgAdmin bool
}

// ErrUnauthenticated is returned by an Authenticator when the request carries
// no session or the session is invalid/expired. Other errors mean the
// authenticator could not decide (for example the database is unreachable)
// and are reported as 503 rather than 401.
var ErrUnauthenticated = errors.New("api: unauthenticated")

// Authenticator resolves an incoming request to a Principal.
//
// Implementations read the session cookie (or another bearer credential),
// look it up in the authoritative store and return ErrUnauthenticated when
// there is no valid session.
type Authenticator interface {
	Authenticate(r *http.Request) (*Principal, error)
}

// AuthenticatorFunc adapts a function to Authenticator.
type AuthenticatorFunc func(r *http.Request) (*Principal, error)

// Authenticate implements Authenticator.
func (f AuthenticatorFunc) Authenticate(r *http.Request) (*Principal, error) { return f(r) }

type principalKey struct{}

// WithPrincipal returns a context carrying p.
func WithPrincipal(ctx context.Context, p *Principal) context.Context {
	return context.WithValue(ctx, principalKey{}, p)
}

// PrincipalFrom returns the Principal stored in ctx by RequireAuth. A stored
// principal without a UserID is treated as absent: an identity that cannot be
// attributed must never reach an authorization decision.
func PrincipalFrom(ctx context.Context) (*Principal, bool) {
	p, ok := ctx.Value(principalKey{}).(*Principal)
	if !ok || p == nil || p.UserID == "" {
		return nil, false
	}
	return p, true
}
