package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"

	"github.com/dbirks/communication/internal/api"
	"github.com/dbirks/communication/internal/store/postgres"
)

// discoveryTimeout bounds OIDC discovery (and the JWKS fetch that verification
// may trigger).
const discoveryTimeout = 10 * time.Second

// Service is the OIDC login service and session Authenticator. A zero Value is
// not usable; build one with New.
type Service struct {
	cfg    Config
	store  *postgres.IdentityStore
	log    *slog.Logger
	client *http.Client

	mu       sync.Mutex
	provider *oidc.Provider
}

// New builds a Service. Discovery has not happened yet: it happens on first
// use and is retried after a failure, so a replica that starts before its
// identity provider still serves health, readiness and existing sessions.
func New(cfg Config, store *postgres.IdentityStore, logger *slog.Logger) *Service {
	if logger == nil {
		logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	return &Service{
		cfg:   cfg,
		store: store,
		log:   logger,
		client: &http.Client{
			Timeout:   discoveryTimeout,
			Transport: http.DefaultTransport,
		},
	}
}

// Config returns a copy of the configuration in use.
func (s *Service) Config() Config { return s.cfg }

// discover performs OIDC discovery at most once, retrying on the next request
// after a failure.
func (s *Service) discover(ctx context.Context) (*oidc.Provider, error) {
	if err := s.cfg.Validate(); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.provider != nil {
		return s.provider, nil
	}
	dctx, cancel := context.WithTimeout(oidc.ClientContext(ctx, s.client), discoveryTimeout)
	defer cancel()
	p, err := oidc.NewProvider(dctx, s.cfg.Issuer)
	if err != nil {
		return nil, fmt.Errorf("auth: discover issuer %s: %w", redactURL(s.cfg.Issuer), err)
	}
	s.provider = p
	s.log.InfoContext(ctx, "oidc provider discovered", "issuer", redactURL(s.cfg.Issuer))
	return p, nil
}

// oauth2Config binds the discovered endpoints to this deployment's client.
// An empty ClientSecret makes it a public client, which PKCE makes safe.
func (s *Service) oauth2Config(p *oidc.Provider) *oauth2.Config {
	return &oauth2.Config{
		ClientID:     s.cfg.ClientID,
		ClientSecret: s.cfg.ClientSecret,
		RedirectURL:  s.cfg.RedirectURL(),
		Scopes:       []string{oidc.ScopeOpenID, "profile", "email"},
		Endpoint:     p.Endpoint(),
	}
}

// Authenticate implements api.Authenticator from the session cookie alone: no
// call to the identity provider is made, so an IdP outage does not log anyone
// out mid-session.
func (s *Service) Authenticate(r *http.Request) (*api.Principal, error) {
	cookie, err := r.Cookie(CookieName)
	if err != nil || cookie.Value == "" {
		return nil, api.ErrUnauthenticated
	}
	if s.store == nil {
		return nil, errors.New("auth: no session store configured")
	}
	hash := sessionHash(cookie.Value)
	u, csrf, err := s.store.SessionUser(r.Context(), hash)
	switch {
	case errors.Is(err, postgres.ErrNotFound):
		return nil, api.ErrUnauthenticated
	case err != nil:
		return nil, fmt.Errorf("auth: resolve session: %w", err)
	}
	return &api.Principal{
		UserID:         u.ID,
		OrganizationID: u.OrganizationID,
		DisplayName:    u.DisplayName,
		Email:          u.Email,
		CSRFToken:      csrf,
		IsOrgAdmin:     u.IsOrgAdmin,
	}, nil
}

// Register mounts the identity routes on s. /auth/login and /auth/callback are
// public; everything else requires a session, and the POST additionally
// requires the CSRF token (api.HandleAuthed installs both guards).
func (s *Service) Register(server *api.Server) {
	server.Handle("GET /auth/login", http.HandlerFunc(s.handleLogin))
	server.Handle("GET /auth/callback", http.HandlerFunc(s.handleCallback))
	server.HandleAuthed("POST /auth/logout", http.HandlerFunc(s.handleLogout))
	server.HandleAuthed("GET /api/v1/me", http.HandlerFunc(s.handleMe))
	server.HandleAuthed("GET /api/v1/users", http.HandlerFunc(s.handleUsers))
}

// handleLogin starts the Authorization Code + PKCE handshake. state, nonce and
// the PKCE verifier go to the database, not to memory, so the callback may
// land on a different replica (ADR-0012 §6).
func (s *Service) handleLogin(w http.ResponseWriter, r *http.Request) {
	returnTo := SanitizeReturnTo(r.URL.Query().Get("return_to"))
	p, err := s.discover(r.Context())
	if err != nil {
		s.providerUnavailable(w, r, err)
		return
	}
	state, err := randomToken(32)
	if err != nil {
		s.serverError(w, r, "login", err)
		return
	}
	nonce, err := randomToken(32)
	if err != nil {
		s.serverError(w, r, "login", err)
		return
	}
	verifier := oauth2.GenerateVerifier()
	if err := s.store.SaveLoginState(r.Context(), postgres.LoginState{
		State:        state,
		CodeVerifier: verifier,
		Nonce:        nonce,
		ReturnTo:     returnTo,
		ExpiresAt:    time.Now().Add(LoginStateTTL),
	}); err != nil {
		s.serverError(w, r, "login", err)
		return
	}
	cfg := s.oauth2Config(p)
	cfg.Endpoint.AuthURL = ApplyBrowserIssuer(cfg.Endpoint.AuthURL, s.cfg.Issuer, s.cfg.BrowserIssuer)
	http.Redirect(w, r, cfg.AuthCodeURL(state, oidc.Nonce(nonce), oauth2.S256ChallengeOption(verifier)),
		http.StatusFound)
}

// idTokenClaims are the profile claims this deployment consumes. email is
// optional and never an identity key.
type idTokenClaims struct {
	Nonce             string `json:"nonce"`
	Name              string `json:"name"`
	PreferredUsername string `json:"preferred_username"`
	Email             string `json:"email"`
}

// handleCallback finishes the handshake: consume state, exchange the code with
// the stored PKCE verifier, verify the ID token (issuer, audience, nonce),
// upsert the (issuer, subject) identity and open a session.
func (s *Service) handleCallback(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	q := r.URL.Query()

	// The IdP reported a failure (access_denied, login_required, ...). Never
	// echo its description back verbatim beyond a fixed sentence, and never log
	// the query string, which carries one-time codes.
	if errParam := q.Get("error"); errParam != "" {
		s.log.WarnContext(ctx, "oidc login rejected by provider", "error", safeErrorCode(errParam))
		api.WriteProblem(w, http.StatusUnauthorized, "Login Denied",
			"The identity provider rejected the login. Try signing in again.")
		return
	}
	state := q.Get("state")
	if state == "" {
		invalidLoginState(w)
		return
	}
	if s.store == nil {
		s.serverError(w, r, "callback", errors.New("auth: no session store configured"))
		return
	}
	stored, err := s.store.TakeLoginState(ctx, state)
	switch {
	case errors.Is(err, postgres.ErrNotFound):
		invalidLoginState(w)
		return
	case err != nil:
		s.serverError(w, r, "callback", err)
		return
	}
	code := q.Get("code")
	if code == "" {
		s.log.WarnContext(ctx, "oidc callback without a code")
		api.WriteProblem(w, http.StatusBadRequest, "Invalid Login Callback",
			"The identity provider returned no authorization code.")
		return
	}
	p, err := s.discover(ctx)
	if err != nil {
		s.providerUnavailable(w, r, err)
		return
	}
	oauthCfg := s.oauth2Config(p)
	tok, err := oauthCfg.Exchange(oidc.ClientContext(ctx, s.client), code,
		oauth2.VerifierOption(stored.CodeVerifier))
	if err != nil {
		s.log.WarnContext(ctx, "oidc code exchange failed", "detail", redactErr(err))
		api.WriteProblem(w, http.StatusUnauthorized, "Login Failed",
			"The identity provider would not accept the authorization code.")
		return
	}
	rawIDToken, ok := idTokenFromToken(tok)
	if !ok {
		s.log.WarnContext(ctx, "oidc token response had no id_token")
		api.WriteProblem(w, http.StatusUnauthorized, "Login Failed",
			"The identity provider returned no ID token.")
		return
	}
	verified, err := p.Verifier(&oidc.Config{ClientID: s.cfg.ClientID}).
		Verify(oidc.ClientContext(ctx, s.client), rawIDToken)
	if err != nil {
		// A forged, mis-audience or wrong-nonce token looks identical here.
		s.log.WarnContext(ctx, "oidc id token failed verification", "detail", redactErr(err))
		api.WriteProblem(w, http.StatusUnauthorized, "Login Failed",
			"The identity provider returned a token that could not be verified.")
		return
	}
	var claims idTokenClaims
	if err := verified.Claims(&claims); err != nil {
		s.serverError(w, r, "callback", fmt.Errorf("auth: read id token claims: %w", err))
		return
	}
	if subtle.ConstantTimeCompare([]byte(claims.Nonce), []byte(stored.Nonce)) != 1 {
		s.log.WarnContext(ctx, "oidc nonce mismatch")
		api.WriteProblem(w, http.StatusUnauthorized, "Login Failed",
			"The identity provider returned a token for a different login attempt.")
		return
	}
	subject := verified.Subject
	if subject == "" {
		api.WriteProblem(w, http.StatusUnauthorized, "Login Failed",
			"The identity provider returned a token with no subject.")
		return
	}
	displayName := displayNameFrom(claims, subject)

	org, err := s.store.DefaultOrganization(ctx)
	if err != nil {
		s.serverError(w, r, "callback", fmt.Errorf("auth: default organization: %w", err))
		return
	}
	user, err := s.store.UpsertOIDCUser(ctx, org.ID, s.cfg.Issuer, subject,
		displayName, claims.Email, s.cfg.IsBootstrapAdmin(subject))
	if err != nil {
		s.serverError(w, r, "callback", fmt.Errorf("auth: upsert user: %w", err))
		return
	}
	sessionToken, err := randomToken(32)
	if err != nil {
		s.serverError(w, r, "callback", err)
		return
	}
	csrf, err := randomToken(32)
	if err != nil {
		s.serverError(w, r, "callback", err)
		return
	}
	ttl := s.cfg.SessionTTLOrDefault()
	if err := s.store.CreateSession(ctx, sessionHash(sessionToken), user.ID, csrf,
		time.Now().Add(ttl)); err != nil {
		s.serverError(w, r, "callback", fmt.Errorf("auth: create session: %w", err))
		return
	}
	http.SetCookie(w, s.sessionCookie(sessionToken, ttl))
	s.log.InfoContext(ctx, "oidc login succeeded",
		"user_id", user.ID, "is_org_admin", user.IsOrgAdmin)
	http.Redirect(w, r, stored.ReturnTo, http.StatusFound)
}

// handleLogout deletes the session and expires the cookie. The row is gone
// even if the browser somehow keeps the cookie.
func (s *Service) handleLogout(w http.ResponseWriter, r *http.Request) {
	if s.store == nil {
		s.serverError(w, r, "logout", errors.New("auth: no session store configured"))
		return
	}
	cookie, err := r.Cookie(CookieName)
	if err == nil && cookie.Value != "" {
		if err := s.store.DeleteSession(r.Context(), sessionHash(cookie.Value)); err != nil {
			s.serverError(w, r, "logout", fmt.Errorf("auth: delete session: %w", err))
			return
		}
	}
	expired := s.sessionCookie("", -1)
	http.SetCookie(w, expired)
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusNoContent)
}

// meResponse is the body of GET /api/v1/me.
type meResponse struct {
	ID           string       `json:"id"`
	DisplayName  string       `json:"display_name"`
	Email        string       `json:"email"`
	IsOrgAdmin   bool         `json:"is_org_admin"`
	Organization organization `json:"organization"`
	CSRFToken    string       `json:"csrf_token"`
}

type organization struct {
	ID   string `json:"id"`
	Slug string `json:"slug"`
	Name string `json:"name"`
}

// handleMe describes the caller, including the CSRF token the UI must echo on
// mutations. M1 is single-tenant: this service provisions every user into the
// one seeded organization, so its metadata is the caller's organization.
func (s *Service) handleMe(w http.ResponseWriter, r *http.Request) {
	p, ok := api.PrincipalFrom(r.Context())
	if !ok {
		api.WriteProblem(w, http.StatusUnauthorized, "Unauthenticated",
			"A valid session is required.")
		return
	}
	org, err := s.store.DefaultOrganization(r.Context())
	if err != nil {
		s.serverError(w, r, "me", fmt.Errorf("auth: organization: %w", err))
		return
	}
	api.WriteJSON(w, http.StatusOK, meResponse{
		ID:           p.UserID,
		DisplayName:  p.DisplayName,
		Email:        p.Email,
		IsOrgAdmin:   p.IsOrgAdmin,
		Organization: organization{ID: org.ID, Slug: org.Slug, Name: org.Name},
		CSRFToken:    p.CSRFToken,
	})
}

// userSummary is one entry of GET /api/v1/users.
type userSummary struct {
	ID          string `json:"id"`
	DisplayName string `json:"display_name"`
	Email       string `json:"email"`
}

type usersResponse struct {
	Items []userSummary `json:"items"`
}

// handleUsers lists the caller's organization members.
func (s *Service) handleUsers(w http.ResponseWriter, r *http.Request) {
	p, ok := api.PrincipalFrom(r.Context())
	if !ok {
		api.WriteProblem(w, http.StatusUnauthorized, "Unauthenticated",
			"A valid session is required.")
		return
	}
	if s.store == nil {
		s.serverError(w, r, "users", errors.New("auth: no session store configured"))
		return
	}
	users, err := s.store.ListOrgUsers(r.Context(), p.OrganizationID)
	if err != nil {
		s.serverError(w, r, "users", fmt.Errorf("auth: list users: %w", err))
		return
	}
	items := make([]userSummary, 0, len(users))
	for _, u := range users {
		items = append(items, userSummary{ID: u.ID, DisplayName: u.DisplayName, Email: u.Email})
	}
	api.WriteJSON(w, http.StatusOK, usersResponse{Items: items})
}

// sessionCookie builds the session cookie. Path is "/" and MaxAge matches the
// stored expiry so a browser does not keep a cookie for a dead session.
func (s *Service) sessionCookie(value string, ttl time.Duration) *http.Cookie {
	return &http.Cookie{
		Name:     CookieName,
		Value:    value,
		Path:     "/",
		Expires:  time.Now().Add(ttl),
		MaxAge:   int(ttl.Seconds()),
		HttpOnly: true,
		Secure:   s.cfg.CookieSecure,
		SameSite: http.SameSiteLaxMode,
	}
}

// providerUnavailable answers 503 for a failed discovery: the client (or the
// load balancer) should retry once the identity provider is reachable.
func (s *Service) providerUnavailable(w http.ResponseWriter, r *http.Request, err error) {
	s.log.WarnContext(r.Context(), "identity provider unavailable", "detail", redactErr(err))
	api.WriteProblem(w, http.StatusServiceUnavailable, "Identity Provider Unavailable",
		"The identity provider could not be reached. Try signing in again shortly.")
}

func (s *Service) serverError(w http.ResponseWriter, r *http.Request, op string, err error) {
	s.log.ErrorContext(r.Context(), "auth request failed", "op", op, "detail", redactErr(err))
	api.WriteProblem(w, http.StatusInternalServerError, "Internal Server Error",
		"The server could not complete the sign-in flow.")
}

func invalidLoginState(w http.ResponseWriter) {
	api.WriteProblem(w, http.StatusBadRequest, "Invalid Login State",
		"The login attempt is missing, already used, or older than 10 minutes. Sign in again.")
}

// SanitizeReturnTo keeps `return_to` same-origin: it must be a path starting
// with a single "/", so neither "//evil.example" (protocol-relative) nor
// "/\\evil.example" (which some browsers normalize to one) can escape.
func SanitizeReturnTo(raw string) string {
	v := strings.TrimSpace(raw)
	if v == "" || !strings.HasPrefix(v, "/") {
		return "/"
	}
	if strings.HasPrefix(v, "//") || strings.HasPrefix(v, `/\`) {
		return "/"
	}
	if len(v) > maxReturnToLen {
		return "/"
	}
	// Control characters let a value be truncated by a browser mid-path.
	for _, r := range v {
		if r < 0x20 || r == 0x7f {
			return "/"
		}
	}
	return v
}

// maxReturnToLen caps a stored return_to; anything longer is not a real path.
const maxReturnToLen = 2048

// ApplyBrowserIssuer rewrites the discovered authorization endpoint so the
// browser is sent to the issuer it can reach, while this server keeps using
// Issuer for discovery, tokens and JWKS (ADR-0012 §3). The rewrite only
// applies when the endpoint actually sits under Issuer.
func ApplyBrowserIssuer(authURL, issuer, browserIssuer string) string {
	base := strings.TrimSuffix(strings.TrimSpace(issuer), "/")
	browser := strings.TrimSuffix(strings.TrimSpace(browserIssuer), "/")
	if base == "" || browser == "" || authURL == "" {
		return authURL
	}
	if !strings.HasPrefix(authURL, base) {
		return authURL
	}
	rest := authURL[len(base):]
	if rest != "" && rest[0] != '/' && rest[0] != '?' && rest[0] != '#' {
		// A prefix match on a partial path segment is not the same issuer.
		return authURL
	}
	return browser + rest
}

// displayNameFrom resolves the profile name per ADR-0012 §4: name ->
// preferred_username -> subject.
func displayNameFrom(c idTokenClaims, subject string) string {
	for _, v := range []string{c.Name, c.PreferredUsername} {
		if v = strings.TrimSpace(v); v != "" {
			return v
		}
	}
	return subject
}

// sessionHash is the only form of a session token that is ever persisted.
func sessionHash(token string) []byte {
	sum := sha256.Sum256([]byte(token))
	return sum[:]
}

// randomToken returns n random bytes as base64url without padding.
func randomToken(n int) (string, error) {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("auth: generate token: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

// idTokenFromToken pulls the ID token out of an exchange response; go-oidc
// surfaces it as the "id_token" extra claim.
func idTokenFromToken(tok *oauth2.Token) (string, bool) {
	if tok == nil {
		return "", false
	}
	v, ok := tok.Extra("id_token").(string)
	return v, ok && v != ""
}

// Secret-bearing patterns that must never reach a log: a compact JWS (an ID or
// access token) and one-time OIDC values echoed inside a query string or JSON
// body by an upstream error.
var (
	jwtRe         = regexp.MustCompile(`[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}`)
	querySecretRe = regexp.MustCompile(`(?i)(code|state|nonce|id_token|access_token|refresh_token|client_secret|session)=([^&\s"']+)`)

	// maxErrLen caps a logged upstream error so a token response body cannot be
	// reproduced in full even after redaction.
	maxErrLen = 300
)

// redactErr makes an upstream error safe to log. Token responses, one-time
// codes and state values are replaced rather than recorded.
func redactErr(err error) string {
	if err == nil {
		return ""
	}
	s := err.Error()
	s = jwtRe.ReplaceAllString(s, "[redacted-token]")
	s = querySecretRe.ReplaceAllString(s, "$1=[redacted]")
	if len(s) > maxErrLen {
		s = s[:maxErrLen] + "..."
	}
	return s
}

// redactURL drops any query or fragment from a URL before logging it.
func redactURL(raw string) string {
	if i := strings.IndexAny(raw, "?#"); i >= 0 {
		return raw[:i]
	}
	return raw
}

// safeErrorCode keeps only the IdP's short error code, not its description.
func safeErrorCode(v string) string {
	v = strings.TrimSpace(v)
	if len(v) > 64 {
		return v[:64]
	}
	return v
}
