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
	"net/url"
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

	mu sync.Mutex
	// providers holds one entry per configured identity provider, in
	// configuration order — the order the login chooser prints (ADR-0083).
	providers []*providerState
}

// providerState is one provider plus the discovered endpoints, which are cached
// per provider because each issuer has its own JWKS.
type providerState struct {
	prov    Provider
	adapter ProviderAdapter

	mu         sync.Mutex
	discovered *oidc.Provider
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

// providerStates resolves the provider list lazily, retrying after a failure.
func (s *Service) providerStates() ([]*providerState, error) {
	if err := s.cfg.Validate(); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.providers == nil {
		for _, p := range s.cfg.LoginProviders() {
			ad, err := p.adapterFor()
			if err != nil {
				return nil, err
			}
			s.providers = append(s.providers, &providerState{prov: p, adapter: ad})
		}
	}
	return s.providers, nil
}

// providerByID finds a provider by its configuration id.
func (s *Service) providerByID(id string) (*providerState, bool) {
	states, err := s.providerStates()
	if err != nil {
		return nil, false
	}
	for _, ps := range states {
		if ps.prov.ID == id {
			return ps, true
		}
	}
	return nil, false
}

// selectLoginProvider answers "which provider does this /auth/login start a
// handshake with?". With one provider configured the `provider` parameter is
// optional and today's behaviour is unchanged. With several, an unknown id is a
// 400 and a missing id sends the browser to the chooser the SPA renders at
// /login — the one page that can list them.
func (s *Service) selectLoginProvider(id string) (*providerState, string, error) {
	states, err := s.providerStates()
	if err != nil {
		return nil, "", err
	}
	if id != "" {
		for _, ps := range states {
			if ps.prov.ID == id {
				return ps, "", nil
			}
		}
		return nil, "", fmt.Errorf("auth: no provider %q is configured", id)
	}
	if len(states) == 1 {
		return states[0], "", nil
	}
	return nil, "/login", nil
}

// discover performs this provider's OIDC discovery at most once, retrying on the
// next request after a failure.
func (ps *providerState) discover(ctx context.Context, client *http.Client,
	log *slog.Logger) (*oidc.Provider, error) {
	ps.mu.Lock()
	defer ps.mu.Unlock()
	if ps.discovered != nil {
		return ps.discovered, nil
	}
	dctx, cancel := context.WithTimeout(oidc.ClientContext(ctx, client), discoveryTimeout)
	defer cancel()
	p, err := oidc.NewProvider(dctx, ps.prov.Issuer)
	if err != nil {
		return nil, fmt.Errorf("auth: discover issuer %s: %w", redactURL(ps.prov.Issuer), err)
	}
	ps.discovered = p
	log.InfoContext(ctx, "oidc provider discovered", "provider", ps.prov.ID,
		"issuer", redactURL(ps.prov.Issuer))
	return p, nil
}

// verifierConfig is the ID-token validation for this provider. Entra runs with
// the library's issuer check off, because a multi-tenant endpoint issues tokens
// whose `iss` names the SIGNING USER's tenant: entraAdapter.Admit performs the
// tenant-specific issuer check instead, against an allowlisted tenant
// (ADR-0083 "Adapters").
func (ps *providerState) verifierConfig() *oidc.Config {
	return &oidc.Config{ClientID: ps.prov.ClientID, SkipIssuerCheck: ps.prov.Kind == KindEntra}
}

// oauth2Config binds the discovered endpoints to this provider's client. An
// empty client secret makes it a public client, which PKCE makes safe. The
// redirect URI is the single fixed callback for every provider: the stored
// login state, not the URL, is what identifies the provider on the way back.
func (ps *providerState) oauth2Config(p *oidc.Provider, redirectURL string) *oauth2.Config {
	return &oauth2.Config{
		ClientID:     ps.prov.ClientID,
		ClientSecret: ps.prov.ClientSecret(),
		RedirectURL:  redirectURL,
		Scopes:       ps.adapter.Scopes(),
		Endpoint:     p.Endpoint(),
	}
}

// authorizeURL builds the browser redirect for a handshake.
func (ps *providerState) authorizeURL(cfg *oauth2.Config, state, nonce, verifier string) string {
	return cfg.AuthCodeURL(state, oidc.Nonce(nonce), oauth2.S256ChallengeOption(verifier))
}

// browserIssuer names the two issuers the authorization-endpoint rewrite works
// with (ADR-0012 §3).
func (ps *providerState) browserIssuer() (issuer, browserIssuer string) {
	return ps.prov.Issuer, ps.prov.BrowserIssuer
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
		AvatarURL:      u.AvatarURL,
		CSRFToken:      csrf,
		IsOrgAdmin:     u.IsOrgAdmin,
	}, nil
}

// Register mounts the identity routes on s. /auth/login, /auth/callback and
// /auth/providers are public; everything else requires a session, and the POST
// additionally requires the CSRF token (api.HandleAuthed installs both guards).
// The two public login routes carry the per-client-IP throttle (audit F1,
// ADR-0077): each login writes a database row, so it must not be an unbounded
// write amplifier.
//
// ADR-0083 adds the provider dimension: `/auth/login?provider=<id>` starts a
// handshake with one named provider, and `/auth/callback/{id}` is the same
// callback for a deployment whose IdP application must register a distinct
// redirect URI per provider. `/auth/callback` (no id) stays the primary
// redirect URI — the stored login state already names the provider.
func (s *Service) Register(server *api.Server) {
	server.Handle("GET /auth/login", server.ThrottleAuth(http.HandlerFunc(s.handleLogin)))
	server.Handle("GET /auth/providers", http.HandlerFunc(s.handleProviders))
	server.Handle("GET /auth/callback", server.ThrottleAuth(http.HandlerFunc(s.handleCallback)))
	server.Handle("GET /auth/callback/{provider}", server.ThrottleAuth(http.HandlerFunc(s.handleCallback)))
	server.HandleAuthed("POST /auth/logout", http.HandlerFunc(s.handleLogout))
	server.HandleAuthed("GET /api/v1/me", http.HandlerFunc(s.handleMe))
	server.HandleAuthed("GET /api/v1/users", http.HandlerFunc(s.handleUsers))
	server.HandleAuthed("GET /api/v1/users/{userId}/avatar", http.HandlerFunc(s.handleUserAvatar))
}

// providerListItem is one row of GET /auth/providers: enough for the chooser to
// print a button, and nothing else. No issuer URL, no client id — the route is
// public, and the login page is rendered before anyone is signed in.
type providerListItem struct {
	ID    string `json:"id"`
	Label string `json:"label"`
}

// handleProviders lists the sign-in options. With one provider the SPA draws
// exactly the button it drew before ADR-0083; with several it draws one per
// entry, in configuration order.
func (s *Service) handleProviders(w http.ResponseWriter, r *http.Request) {
	states, err := s.providerStates()
	if err != nil {
		s.serverError(w, r, "providers", err)
		return
	}
	out := make([]providerListItem, 0, len(states))
	for _, ps := range states {
		out = append(out, providerListItem{ID: ps.prov.ID, Label: ps.prov.label()})
	}
	// A provider list is deployment configuration: it changes on a restart, so
	// a cache that outlives one would show a button that 400s.
	w.Header().Set("Cache-Control", "no-store")
	api.WriteJSON(w, http.StatusOK, out)
}

// handleLogin starts the Authorization Code + PKCE handshake. state, nonce and
// the PKCE verifier go to the database, not to memory, so the callback may
// land on a different replica (ADR-0012 §6). The state also records WHICH
// provider it was minted for, so a code from provider B cannot complete a login
// started for provider A (ADR-0083 "State").
func (s *Service) handleLogin(w http.ResponseWriter, r *http.Request) {
	returnTo := SanitizeReturnTo(r.URL.Query().Get("return_to"))
	ps, chooser, err := s.selectLoginProvider(r.URL.Query().Get("provider"))
	if err != nil {
		// An unknown provider id is a bad link, not an IdP outage: answer 400 and
		// name nothing but the fact that no such provider exists.
		s.log.WarnContext(r.Context(), "unknown login provider requested")
		api.WriteProblem(w, http.StatusBadRequest, "Unknown Login Provider",
			"No identity provider is configured under that name.")
		return
	}
	if chooser != "" {
		// Several providers and none named: hand the browser to the chooser page,
		// preserving the deep link.
		redirect := chooser + "?return_to=" + url.QueryEscape(returnTo)
		http.Redirect(w, r, redirect, http.StatusFound)
		return
	}
	p, err := ps.discover(r.Context(), s.client, s.log)
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
		// `default` is stored as NULL (migration 00032), so an env-only
		// deployment writes the same row shape it wrote before providers existed.
		ProviderID: ps.prov.ID,
		ExpiresAt:  time.Now().Add(LoginStateTTL),
	}); err != nil {
		s.serverError(w, r, "login", err)
		return
	}
	cfg := ps.oauth2Config(p, s.cfg.RedirectURL())
	issuer, browserIssuer := ps.browserIssuer()
	cfg.Endpoint.AuthURL = ApplyBrowserIssuer(cfg.Endpoint.AuthURL, issuer, browserIssuer)
	http.Redirect(w, r, ps.authorizeURL(cfg, state, nonce, verifier), http.StatusFound)
}

// idTokenClaims are the profile claims this deployment consumes. email is
// optional and never an identity key. picture is the provider's profile image
// URL; providers that keep it off the ID token (tailscale's tsidp serves it
// only from /userinfo) are handled by userInfoProfile below.
type idTokenClaims struct {
	Nonce             string `json:"nonce"`
	Name              string `json:"name"`
	PreferredUsername string `json:"preferred_username"`
	Email             string `json:"email"`
	Picture           string `json:"picture"`
}

// handleCallback finishes the handshake: consume state, check the state belongs
// to the provider this callback names, exchange the code with the stored PKCE
// verifier, verify the ID token (issuer, audience, nonce), apply the adapter's
// admission and subject rules, upsert the (issuer, subject) identity and open a
// session.
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
	// The provider the state was minted for, checked against the one this URL
	// names. `/auth/callback` names none, so the state decides; a
	// `/auth/callback/{id}` that disagrees with the state is the ADR-0083
	// cross-provider replay and is refused before a code is redeemed anywhere.
	// The answer is the same fixed 400 as an unknown state: which provider a
	// in-flight login was for is not this endpoint's to confirm.
	if pathID := r.PathValue("provider"); pathID != "" && pathID != stored.ProviderID {
		s.log.WarnContext(ctx, "oidc callback provider mismatch",
			"requested", safeErrorCode(pathID), "minted_for", safeErrorCode(stored.ProviderID))
		invalidLoginState(w)
		return
	}
	ps, ok := s.providerByID(stored.ProviderID)
	if !ok {
		// The provider list changed under an in-flight login (a rollout that
		// renamed or removed a provider). The state is already consumed.
		s.log.WarnContext(ctx, "oidc callback for an unknown provider",
			"provider", safeErrorCode(stored.ProviderID))
		api.WriteProblem(w, http.StatusUnauthorized, "Login Failed",
			"The identity provider for this login is no longer configured. Sign in again.")
		return
	}
	p, err := ps.discover(ctx, s.client, s.log)
	if err != nil {
		s.providerUnavailable(w, r, err)
		return
	}
	oauthCfg := ps.oauth2Config(p, s.cfg.RedirectURL())
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
	verified, err := p.Verifier(ps.verifierConfig()).
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
	// The same payload as a map, which is the shape a ProviderAdapter reads: the
	// rules that make a subject differ per provider, so the service cannot name
	// the claims each kind needs up front.
	var rawClaims map[string]any
	if err := verified.Claims(&rawClaims); err != nil {
		s.serverError(w, r, "callback", fmt.Errorf("auth: read id token claims: %w", err))
		return
	}
	if subtle.ConstantTimeCompare([]byte(claims.Nonce), []byte(stored.Nonce)) != 1 {
		s.log.WarnContext(ctx, "oidc nonce mismatch")
		api.WriteProblem(w, http.StatusUnauthorized, "Login Failed",
			"The identity provider returned a token for a different login attempt.")
		return
	}
	// The adapter's admission rule runs after the library has verified signature,
	// audience, expiry and nonce: for Entra this is the tenant allowlist plus the
	// tenant-specific issuer check that a multi-tenant endpoint cannot express
	// (ADR-0083). A refused admission looks like every other failed login.
	if err := ps.adapter.Admit(rawClaims); err != nil {
		s.log.WarnContext(ctx, "oidc admission refused", "provider", ps.prov.ID, "detail", redactErr(err))
		api.WriteProblem(w, http.StatusUnauthorized, "Login Failed",
			"The identity provider returned a token this deployment may not accept.")
		return
	}
	subject, err := ps.adapter.Subject(rawClaims)
	if err != nil || subject == "" {
		s.log.WarnContext(ctx, "oidc id token carries no usable subject",
			"provider", ps.prov.ID, "detail", redactErr(err))
		api.WriteProblem(w, http.StatusUnauthorized, "Login Failed",
			"The identity provider returned a token with no subject.")
		return
	}
	// UserInfo is offered to every adapter and still costs at most the one round
	// trip the single-provider path made.
	prof, err := ps.adapter.Profile(ctx, ProfileInput{
		Claims: rawClaims,
		Token:  tok,
		Client: s.client,
		UserInfo: func(ctx context.Context) (string, string) {
			return s.userInfoProfile(ctx, p, tok)
		},
	})
	if err != nil {
		s.serverError(w, r, "callback", err)
		return
	}
	displayName := displayNameFrom(claims, subject)
	// ADR-0012 §4 precedence (name -> preferred_username -> subject) still holds:
	// what the adapter released fills the gap where the ID token carried neither
	// name claim.
	if displayName == subject && strings.TrimSpace(prof.Name) != "" {
		displayName = strings.TrimSpace(prof.Name)
	}
	email := strings.TrimSpace(claims.Email)
	if email == "" {
		email = strings.TrimSpace(prof.Email)
	}
	avatarURL := avatarURLFrom(prof.Picture.URL)

	org, err := s.store.DefaultOrganization(ctx)
	if err != nil {
		s.serverError(w, r, "callback", fmt.Errorf("auth: default organization: %w", err))
		return
	}
	user, err := s.store.UpsertOIDCUser(ctx, org.ID, ps.prov.Issuer, subject,
		displayName, email, avatarURL, s.cfg.IsBootstrapAdminFor(ps.prov.ID, subject))
	if err != nil {
		s.serverError(w, r, "callback", fmt.Errorf("auth: upsert user: %w", err))
		return
	}
	// A photo that came as bytes (Entra) cannot be hot-linked, so it lives in
	// this database and is served same-origin, which is what lets the app CSP
	// stay at img-src 'self' for it (ADR-0083 "Pictures"). SaveUserAvatar points
	// users.avatar_url at that route in the same transaction.
	if prof.Picture.Bytes != nil {
		if _, err := s.store.SaveUserAvatar(ctx, user.ID, prof.Picture.ContentType,
			prof.Picture.Bytes); err != nil {
			s.serverError(w, r, "callback", fmt.Errorf("auth: store avatar: %w", err))
			return
		}
	} else if ps.prov.fetchesPictureBytes() {
		// Graph was down, refused the consent, or sent something over the cap. The
		// ID token carries no picture URL of its own, so writing what the login
		// released would erase a face this server still holds: keep it.
		if _, err := s.store.EnsureUserAvatarURL(ctx, user.ID); err != nil {
			s.serverError(w, r, "callback", fmt.Errorf("auth: keep avatar: %w", err))
			return
		}
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
	AvatarURL    string       `json:"avatar_url"`
	IsOrgAdmin   bool         `json:"is_org_admin"`
	Organization organization `json:"organization"`
	CSRFToken    string       `json:"csrf_token"`
	// IssuerHost is the host of the configured OIDC issuer ("idp.example"), so
	// the Profile page can say where the name and picture come from without the
	// UI ever learning the issuer URL or the client id. "" when the issuer will
	// not parse.
	IssuerHost string `json:"issuer_host"`
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
		AvatarURL:    p.AvatarURL,
		IsOrgAdmin:   p.IsOrgAdmin,
		Organization: organization{ID: org.ID, Slug: org.Slug, Name: org.Name},
		CSRFToken:    p.CSRFToken,
		IssuerHost:   s.issuerHost(),
	})
}

// issuerHost is the host part of the configured issuer, for the Profile page's
// "Signed in with …" line. The full issuer URL (which can carry a tenant path)
// and the client id stay server-side: the page needs a name to print, not an
// endpoint to call.
//
// With an ADR-0083 provider list it answers for the list only when exactly one
// provider is configured: a user of one of several has a host this row does not
// know, and a login whose issuer is not recorded per user is not described by
// picking one at random. "" is already the "unknown" answer the page handles.
func (s *Service) issuerHost() string {
	issuer := strings.TrimSpace(s.cfg.Issuer)
	if issuer == "" {
		states, err := s.providerStates()
		if err != nil || len(states) != 1 {
			return ""
		}
		issuer = states[0].prov.Issuer
	}
	u, err := url.Parse(issuer)
	if err != nil {
		return ""
	}
	return u.Host
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

// uuidPathSegmentRe guards a route parameter that goes into a `::uuid` cast: an
// id that cannot be one is a 404, not a database error shaped like a 500.
var uuidPathSegmentRe = regexp.MustCompile(
	`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

// avatarCacheControl is `private` because a profile photo is one person's face:
// a shared cache must not hand it to another origin visitor. max-age is short
// because the photo is refreshed on every login.
const avatarCacheControl = "private, max-age=3600"

// handleUserAvatar serves a profile photo this server stores itself — the Entra
// case, where Microsoft's photo endpoint needs a bearer token and therefore
// cannot be an <img> src. Serving it from the app origin is what keeps the CSP
// at img-src 'self' for it (ADR-0083 "Pictures").
//
// Any signed-in member may read any member's avatar: the same people can already
// see the face on every surface that lists users, and the photo is the
// provider's data about a colleague, not a secret. There is nothing here for an
// unauthenticated visitor: a 401 is the honest answer, and the app draws initials.
func (s *Service) handleUserAvatar(w http.ResponseWriter, r *http.Request) {
	userID := r.PathValue("userId")
	if !uuidPathSegmentRe.MatchString(userID) {
		api.WriteProblem(w, http.StatusNotFound, "Not Found", "No user has that id.")
		return
	}
	if s.store == nil {
		s.serverError(w, r, "avatar", errors.New("auth: no session store configured"))
		return
	}
	avatar, err := s.store.GetUserAvatar(r.Context(), userID)
	switch {
	case errors.Is(err, postgres.ErrNotFound):
		api.WriteProblem(w, http.StatusNotFound, "Not Found",
			"That user has no profile photo stored on this server.")
		return
	case err != nil:
		s.serverError(w, r, "avatar", fmt.Errorf("auth: read avatar: %w", err))
		return
	}
	etag := `"` + avatar.ETag + `"`
	h := w.Header()
	h.Set("ETag", etag)
	h.Set("Cache-Control", avatarCacheControl)
	h.Set("Content-Type", avatar.ContentType)
	if ifNoneMatch(r, etag) {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	h.Set("Content-Length", fmt.Sprint(len(avatar.Bytes)))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(avatar.Bytes)
}

// ifNoneMatch is the weak comparison RFC 9110 asks for: a stored etag is
// compared ignoring a `W/` prefix on either side, and `*` matches anything.
func ifNoneMatch(r *http.Request, etag string) bool {
	have := strings.TrimSpace(r.Header.Get("If-None-Match"))
	if have == "" {
		return false
	}
	if have == "*" {
		return true
	}
	want := strings.TrimPrefix(strings.TrimPrefix(etag, "W/"), "\"")
	want = strings.TrimSuffix(want, "\"")
	for _, cand := range strings.Split(have, ",") {
		cand = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(cand), "W/"))
		cand = strings.TrimSuffix(strings.TrimPrefix(cand, "\""), "\"")
		if cand == want {
			return true
		}
	}
	return false
}

// firstNonEmpty is the first value with content, "" when none has any.
func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v = strings.TrimSpace(v); v != "" {
			return v
		}
	}
	return ""
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

// maxAvatarURLLen matches the users_avatar_url_check length cap (migration
// 00031): a claim longer than this is not a URL anyone meant to load into an
// <img>.
const maxAvatarURLLen = 2048

// avatarURLFrom is the one place a provider-supplied picture becomes stored
// state: an absolute https URL with a host, or "". Anything else — relative,
// http, data:, javascript:, a bare word — becomes "" so the UI draws initials
// and the value never reaches a browser as an img src.
func avatarURLFrom(raw string) string {
	v := strings.TrimSpace(raw)
	if v == "" || len(v) > maxAvatarURLLen ||
		!strings.HasPrefix(strings.ToLower(v), "https://") {
		return ""
	}
	u, err := url.Parse(v)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil {
		return ""
	}
	return v
}

// userInfoProfile queries the provider's UserInfo endpoint once, for the
// picture and name claims the ID token did not carry. tailscale's tsidp is the
// reason this exists: it takes `picture` from the Tailscale profile and serves
// it ONLY at /userinfo, never in the ID token (see serveUserInfo and the
// userInfo struct in
// https://raw.githubusercontent.com/tailscale/tailscale/main/cmd/tsidp/tsidp.go,
// read 2026-11-11).
//
// Every failure mode returns two empty strings — no endpoint advertised, no
// access token, an error, a body without those claims — because the login is
// already verified and a missing face is never a reason to refuse a session.
func (s *Service) userInfoProfile(ctx context.Context, p *oidc.Provider,
	tok *oauth2.Token) (picture, name string) {
	if p.UserInfoEndpoint() == "" || tok == nil || tok.AccessToken == "" {
		return "", ""
	}
	uctx, cancel := context.WithTimeout(oidc.ClientContext(ctx, s.client), discoveryTimeout)
	defer cancel()
	info, err := p.UserInfo(uctx, oauth2.StaticTokenSource(tok))
	if err != nil {
		s.log.WarnContext(ctx, "oidc userinfo request failed; continuing without a picture",
			"detail", redactErr(err))
		return "", ""
	}
	var claims struct {
		Picture string `json:"picture"`
		Name    string `json:"name"`
	}
	if err := info.Claims(&claims); err != nil {
		s.log.WarnContext(ctx, "oidc userinfo claims unreadable; continuing without a picture",
			"detail", redactErr(err))
		return "", ""
	}
	return avatarURLFrom(claims.Picture), strings.TrimSpace(claims.Name)
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
