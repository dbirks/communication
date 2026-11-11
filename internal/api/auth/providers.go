package auth

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"

	yaml "go.yaml.in/yaml/v3"
	"golang.org/x/oauth2"
)

// Provider kinds accepted by the providers file (ADR-0083). The kind selects
// the adapter: the claims that make a stable subject, what admits a token, and
// where the profile picture comes from.
const (
	// KindGeneric is a standard OIDC provider: subject `sub`, picture either on
	// the ID token or at /userinfo.
	KindGeneric = "generic"
	// KindTsidp is tailscale's tsidp: subject `sub` (`userid:<n>`), and the
	// `picture` claim is served only at /userinfo, never on the ID token.
	KindTsidp = "tsidp"
	// KindEntra is Microsoft Entra ID: subject `tid + "/" + oid` because `sub`
	// is pairwise per application, and the tenant MUST be allowlisted.
	KindEntra = "entra"
)

// DefaultProviderID is the id of the provider synthesized from the
// single-issuer environment variables (COMMUNICATION_OIDC_ISSUER and friends).
// A deployment that sets only those variables keeps behaving exactly as before
// ADR-0083, with this one provider named `default`.
const DefaultProviderID = "default"

// DefaultGraphBaseURL is the Microsoft Graph v1.0 root used for the Entra
// profile photo. It is overridable per provider so a test — or a sovereign
// cloud deployment — can point at another host.
//
// Photo endpoint and `User.Read` permission:
// https://learn.microsoft.com/en-us/graph/api/profilephoto-get?view=graph-rest-1.0
// (read 2026-11-11).
const DefaultGraphBaseURL = "https://graph.microsoft.com/v1.0"

// MaxAvatarBytes is the ADR-0083 cap on a stored profile photo: 256 KiB. A
// provider that serves more than this gets no picture at all rather than a
// database full of wallpaper.
const MaxAvatarBytes = 256 * 1024

// providerIDRe bounds a provider id: it appears in /auth/login?provider=<id>,
// in /auth/callback/<id> and in the `provider:subject` form of a bootstrap
// admin, so it is a lowercase slug with no separators that could be confused
// with the delimiter.
var providerIDRe = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)

// Picture is a provider's profile image: a public https URL (tsidp, generic) or
// bytes this server must store and serve itself (Entra, whose photo endpoint
// needs a bearer token and cannot be hot-linked).
type Picture struct {
	URL         string
	Bytes       []byte
	ContentType string
}

// ProfileInput is what an adapter may use to build a profile.
type ProfileInput struct {
	// Claims is the verified ID token payload.
	Claims map[string]any
	// Token is the exchanged token response (nil when the provider released
	// none); its access token authorizes the /userinfo and Graph calls.
	Token *oauth2.Token
	// UserInfo releases the provider's /userinfo `picture` and `name` claims,
	// or ("", "") whenever that is impossible: no endpoint advertised, no
	// access token, an error. It never fails a login.
	UserInfo func(ctx context.Context) (picture, name string)
	// Client is this service's HTTP client, for the Graph photo request.
	Client *http.Client
}

// Profile is the display data one login released.
type Profile struct {
	Name    string
	Email   string
	Picture Picture
}

// ProviderAdapter is the per-kind claim and picture rule (ADR-0083 "Adapters").
// An adapter is stateless configuration: the Service owns discovery.
type ProviderAdapter interface {
	// Kind names the adapter ("generic", "tsidp", "entra").
	Kind() string
	// Scopes are the OAuth2 scopes the authorization request asks for.
	Scopes() []string
	// Subject derives the stable identity key from the verified claims.
	Subject(claims map[string]any) (string, error)
	// Admit refuses a token this provider must not sign anyone in with.
	Admit(claims map[string]any) error
	// Profile reads the display data. It returns an error only for a
	// configuration this build cannot satisfy: a picture that will not load is
	// never an error, because the login it would cancel is already verified.
	Profile(ctx context.Context, in ProfileInput) (Profile, error)
}

// EntraConfig is the kind=entra-only block.
type EntraConfig struct {
	// AllowedTenants is REQUIRED: an Entra app is multi-tenant by default and
	// would otherwise admit any tenant in the directory forest. An empty list
	// refuses to start.
	AllowedTenants []string
	// FetchPhoto asks for `User.Read` and pulls /me/photo/$value from Graph.
	FetchPhoto bool
	// GraphBaseURL overrides DefaultGraphBaseURL (tests, sovereign clouds).
	GraphBaseURL string
}

// Provider is one configured identity provider.
type Provider struct {
	// ID is the stable slug used in the login URLs.
	ID string
	// Label is what the login chooser prints; a sensible default is derived
	// when unset.
	Label string
	// Kind selects the adapter; empty means KindGeneric.
	Kind string
	// Issuer is used by THIS server for discovery, tokens and JWKS.
	Issuer string
	// BrowserIssuer optionally replaces the issuer prefix of the discovered
	// authorization endpoint for the browser redirect only (ADR-0012 §3).
	BrowserIssuer string
	// ClientID is this deployment's OAuth2 client id at this provider.
	ClientID string
	// ClientSecretFile holds the client secret; secrets are read from files
	// only, never from the providers file or the environment of a spec.
	ClientSecretFile string
	// Entra is the kind=entra configuration.
	Entra EntraConfig

	// clientSecret is the content of ClientSecretFile, read once at load time.
	// It is unexported so it cannot be marshalled or printed by accident, and
	// it is never passed to the logger.
	clientSecret string

	// Adapter is derived from Kind at load time.
	Adapter ProviderAdapter
}

// ClientSecret returns the provider's client secret. It is empty for a public
// client, which PKCE makes safe.
func (p Provider) ClientSecret() string { return p.clientSecret }

// String and GoString keep the client secret out of anything printed: the
// secret lives in an unexported field, which `%v`/`%+v` would still show, and a
// deployment's log line or panic dump must not reproduce a credential. The
// issuer is reduced to its query-free form by the same rule the rest of this
// package applies before logging.
func (p Provider) String() string {
	return fmt.Sprintf("auth.Provider{id:%s label:%q kind:%s issuer:%s client_id:%s}",
		p.ID, p.Label, p.Kind, redactURL(p.Issuer), p.ClientID)
}

// GoString is String: there is no Go-syntax form of a Provider that is safe to
// print, because that form includes unexported fields.
func (p Provider) GoString() string { return p.String() }

// label is the login-chooser text: the configured label, or a default derived
// from the kind (never the issuer URL — the chooser is public).
func (p Provider) label() string {
	if v := strings.TrimSpace(p.Label); v != "" {
		return v
	}
	switch p.Kind {
	case KindTsidp:
		return "Tailscale"
	case KindEntra:
		return "Microsoft Entra ID"
	}
	// The provider an env-only deployment synthesizes answers with the word the
	// sign-in page has always printed, so its one button keeps its copy.
	if p.ID == DefaultProviderID {
		return "OIDC"
	}
	// A named provider with no label says where it is: the host, never the path
	// (which for Entra carries a tenant) and never the scheme.
	if u, err := url.Parse(p.Issuer); err == nil && u.Host != "" {
		return u.Host
	}
	return "Sign in"
}

// fetchesPictureBytes reports whether this provider's picture can only ever be
// a stored blob (Entra), as opposed to a URL the browser loads itself.
func (p Provider) fetchesPictureBytes() bool {
	return p.Kind == KindEntra && p.Entra.FetchPhoto
}

// adapterFor returns the provider's adapter, deriving one from Kind when the
// Provider was built by hand rather than loaded.
func (p Provider) adapterFor() (ProviderAdapter, error) {
	if p.Adapter != nil {
		return p.Adapter, nil
	}
	return newAdapter(p)
}

// graphBase is the Graph root for photo requests, defaulting to the public one.
func (e EntraConfig) graphBase() string {
	if v := strings.TrimRight(strings.TrimSpace(e.GraphBaseURL), "/"); v != "" {
		return v
	}
	return DefaultGraphBaseURL
}

// ---------------------------------------------------------------- YAML load

// providersFile is the on-disk shape of COMMUNICATION_OIDC_PROVIDERS_FILE.
// It deliberately has no `client_secret` member: the loader decodes strictly,
// so a deployment that puts a secret in the file fails to start instead of
// writing a credential into a ConfigMap.
type providersFile struct {
	Providers       []providerSpec `yaml:"providers"`
	BootstrapAdmins []string       `yaml:"bootstrap_admins"`
	// ClientSecret is declared only so the loader can name the mistake it
	// refuses: a credential in a ConfigMap is a secret in plain sight.
	ClientSecret string `yaml:"client_secret"`
}

type providerSpec struct {
	ID               string     `yaml:"id"`
	Label            string     `yaml:"label"`
	Kind             string     `yaml:"kind"`
	Issuer           string     `yaml:"issuer"`
	BrowserIssuer    string     `yaml:"browser_issuer"`
	ClientID         string     `yaml:"client_id"`
	ClientSecretFile string     `yaml:"client_secret_file"`
	Entra            *entraSpec `yaml:"entra"`
	// ClientSecret: see providersFile.ClientSecret.
	ClientSecret string `yaml:"client_secret"`
}

type entraSpec struct {
	AllowedTenants []string `yaml:"allowed_tenants"`
	FetchPhoto     *bool    `yaml:"fetch_photo"`
	GraphBaseURL   string   `yaml:"graph_base_url"`
}

// LoadProvidersFile reads and validates the provider list, and returns the
// bootstrap admins it names. The file is read once at startup: a deployment
// that changes its providers restarts.
func LoadProvidersFile(path string) ([]Provider, []string, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, nil, fmt.Errorf("auth: read %s: %w", EnvProvidersFile, err)
	}
	providers, admins, perr := ParseProvidersConfig(raw)
	if perr != nil {
		return nil, nil, fmt.Errorf("auth: %s: %w", EnvProvidersFile, perr)
	}
	return providers, admins, nil
}

// ParseProvidersConfig validates the providers YAML itself (secrets are read
// from the paths it names, relative to the process).
func ParseProvidersConfig(raw []byte) ([]Provider, []string, error) {
	var doc providersFile
	dec := yaml.NewDecoder(strings.NewReader(string(raw)))
	// Unknown keys — `client_secret`, a misspelt `allowed_tenant` — are errors:
	// the first because a credential does not belong in a mounted ConfigMap,
	// the second because it would silently widen who may sign in.
	dec.KnownFields(true)
	if err := dec.Decode(&doc); err != nil && !errors.Is(err, io.EOF) {
		return nil, nil, fmt.Errorf("parse providers: %w", err)
	}
	if doc.ClientSecret != "" {
		return nil, nil, errors.New(
			"parse providers: client_secret is not accepted: use client_secret_file")
	}
	if len(doc.Providers) == 0 {
		return nil, nil, errors.New("parse providers: the file names no providers")
	}
	out := make([]Provider, 0, len(doc.Providers))
	seen := map[string]bool{}
	for i, spec := range doc.Providers {
		p, err := providerFromSpec(spec)
		if err != nil {
			return nil, nil, fmt.Errorf("providers[%d]: %w", i, err)
		}
		if seen[p.ID] {
			return nil, nil, fmt.Errorf("providers[%d]: duplicate provider id %q", i, p.ID)
		}
		seen[p.ID] = true
		out = append(out, p)
	}
	admins := make([]string, 0, len(doc.BootstrapAdmins))
	for _, a := range doc.BootstrapAdmins {
		if a = strings.TrimSpace(a); a != "" {
			admins = append(admins, a)
		}
	}
	return out, admins, nil
}

// providerFromSpec validates one provider and binds its adapter.
func providerFromSpec(spec providerSpec) (Provider, error) {
	if spec.ClientSecret != "" {
		return Provider{}, errors.New(
			"a provider may not carry client_secret: point client_secret_file at a mounted secret")
	}
	id := strings.TrimSpace(spec.ID)
	if id == "" {
		return Provider{}, errors.New("provider id is required")
	}
	if !providerIDRe.MatchString(id) {
		return Provider{}, fmt.Errorf("provider id %q must match %s", id, providerIDRe.String())
	}
	kind := strings.TrimSpace(spec.Kind)
	if kind == "" {
		kind = KindGeneric
	}
	switch kind {
	case KindGeneric, KindTsidp, KindEntra:
	default:
		return Provider{}, fmt.Errorf("provider %q has unknown kind %q (want generic, tsidp or entra)", id, kind)
	}
	p := Provider{
		ID:               id,
		Label:            strings.TrimSpace(spec.Label),
		Kind:             kind,
		Issuer:           strings.TrimSpace(spec.Issuer),
		BrowserIssuer:    strings.TrimSpace(spec.BrowserIssuer),
		ClientID:         strings.TrimSpace(spec.ClientID),
		ClientSecretFile: strings.TrimSpace(spec.ClientSecretFile),
	}
	if p.Issuer == "" {
		return Provider{}, fmt.Errorf("provider %q has no issuer", id)
	}
	if err := absoluteURL("provider "+id+" issuer", p.Issuer); err != nil {
		return Provider{}, err
	}
	if p.BrowserIssuer != "" {
		if err := absoluteURL("provider "+id+" browser_issuer", p.BrowserIssuer); err != nil {
			return Provider{}, err
		}
	}
	if p.ClientID == "" {
		return Provider{}, fmt.Errorf("provider %q has no client_id", id)
	}
	if spec.Entra != nil && kind != KindEntra {
		return Provider{}, fmt.Errorf("provider %q: the entra block requires kind entra (kind is %q)", id, kind)
	}
	if kind == KindEntra {
		if spec.Entra == nil || len(spec.Entra.AllowedTenants) == 0 {
			// Fail closed: an Entra app with no tenant allowlist admits every
			// tenant in the world (ADR-0083 Security/privacy).
			return Provider{}, fmt.Errorf(
				"provider %q: kind entra requires a non-empty entra.allowed_tenants", id)
		}
		tenants := make([]string, 0, len(spec.Entra.AllowedTenants))
		for _, t := range spec.Entra.AllowedTenants {
			if t = strings.TrimSpace(t); t == "" {
				return Provider{}, fmt.Errorf("provider %q: entra.allowed_tenants has an empty entry", id)
			}
			tenants = append(tenants, t)
		}
		p.Entra.AllowedTenants = tenants
		p.Entra.FetchPhoto = spec.Entra.FetchPhoto != nil && *spec.Entra.FetchPhoto
		p.Entra.GraphBaseURL = strings.TrimSpace(spec.Entra.GraphBaseURL)
		if p.Entra.GraphBaseURL != "" {
			if err := absoluteURL("provider "+id+" entra.graph_base_url", p.Entra.GraphBaseURL); err != nil {
				return Provider{}, err
			}
		}
		if err := validateEntraIssuer(id, p.Issuer); err != nil {
			return Provider{}, err
		}
	}
	if p.ClientSecretFile != "" {
		secret, err := readClientSecret(p.ClientSecretFile)
		if err != nil {
			return Provider{}, fmt.Errorf("provider %q: %w", id, err)
		}
		p.clientSecret = secret
	}
	ad, err := newAdapter(p)
	if err != nil {
		return Provider{}, err
	}
	p.Adapter = ad
	return p, nil
}

// readClientSecret reads a client secret from its file. The value is never
// included in an error, and the file's content is trimmed of one trailing
// newline, which is what a `kubectl create secret` round trip leaves behind.
func readClientSecret(path string) (string, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("client_secret_file %s is unreadable", path)
	}
	return strings.TrimRight(string(raw), "\r\n"), nil
}

// absoluteURL rejects a value that could not be discovered over http(s).
func absoluteURL(what, value string) error {
	u, err := url.Parse(value)
	if err != nil || !u.IsAbs() || u.Host == "" ||
		(u.Scheme != "https" && u.Scheme != "http") {
		return fmt.Errorf("%s %q must be an absolute http(s) URL", what, value)
	}
	if u.User != nil {
		return fmt.Errorf("%s %q must not carry credentials in its authority", what, value)
	}
	return nil
}

// validateEntraIssuer requires the shape Microsoft documents: one path segment
// naming the tenant, then the `v2.0` version segment.
//
// https://learn.microsoft.com/en-us/entra/identity-platform/v2-protocols-oidc
// (read 2026-11-11)
func validateEntraIssuer(id, issuer string) error {
	u, err := url.Parse(issuer)
	if err != nil {
		return fmt.Errorf("provider %q: cannot parse issuer: %v", id, err)
	}
	segs := strings.Split(strings.Trim(u.Path, "/"), "/")
	if len(segs) != 2 || segs[1] != "v2.0" {
		return fmt.Errorf("provider %q: entra issuer %q must look like https://<host>/<tenant>/v2.0", id, issuer)
	}
	return nil
}

// newAdapter binds the kind's rules to a validated provider.
func newAdapter(p Provider) (ProviderAdapter, error) {
	switch p.Kind {
	case "", KindGeneric:
		return genericAdapter{p: p}, nil
	case KindTsidp:
		return tsidpAdapter{genericAdapter: genericAdapter{p: p}}, nil
	case KindEntra:
		if len(p.Entra.AllowedTenants) == 0 {
			return nil, fmt.Errorf("auth: provider %q: kind entra requires a non-empty entra.allowed_tenants", p.ID)
		}
		return entraAdapter{p: p}, nil
	default:
		return nil, fmt.Errorf("auth: provider %q has unknown kind %q", p.ID, p.Kind)
	}
}

// ------------------------------------------------------------------ adapters

// claimsString reads one string claim, "" when absent or not a string.
func claimsString(claims map[string]any, key string) string {
	if claims == nil {
		return ""
	}
	if v, ok := claims[key].(string); ok {
		return strings.TrimSpace(v)
	}
	return ""
}

// genericAdapter is a standards-shaped OIDC provider: the subject is `sub`, the
// picture is a public URL on the ID token or at /userinfo, and nothing beyond
// the library's own issuer/audience/nonce checks gates a login.
type genericAdapter struct{ p Provider }

func (a genericAdapter) Kind() string { return KindGeneric }

func (a genericAdapter) Scopes() []string {
	return []string{"openid", "profile", "email"}
}

func (a genericAdapter) Subject(claims map[string]any) (string, error) {
	sub := claimsString(claims, "sub")
	if sub == "" {
		return "", errors.New("auth: id token has no sub claim")
	}
	return sub, nil
}

func (a genericAdapter) Admit(map[string]any) error { return nil }

// profileFrom reads the ID-token profile claims. tsidp shares it: tailscale
// keeps `picture` off the ID token entirely, so the /userinfo fallback below is
// the whole reason that kind exists.
func (a genericAdapter) profileFrom(ctx context.Context, in ProfileInput) Profile {
	var c idTokenClaims
	for k, v := range map[string]*string{
		"name":               &c.Name,
		"preferred_username": &c.PreferredUsername,
		"email":              &c.Email,
		"picture":            &c.Picture,
	} {
		if s := claimsString(in.Claims, k); s != "" {
			*v = s
		}
	}
	prof := Profile{
		Name:    strings.TrimSpace(firstNonEmpty(c.Name, c.PreferredUsername)),
		Email:   strings.TrimSpace(c.Email),
		Picture: Picture{URL: avatarURLFrom(c.Picture)},
	}
	// One UserInfo round trip, only when the ID token left something out — the
	// same condition ADR-0012's single-provider path used.
	if in.UserInfo != nil && (prof.Picture.URL == "" || prof.Name == "") {
		pic, name := in.UserInfo(ctx)
		if prof.Picture.URL == "" {
			// Still the one rule a provider-supplied picture must pass, applied
			// here as well as at the source: a UserInfo body is as much a foreign
			// claim as an ID token was.
			prof.Picture.URL = avatarURLFrom(pic)
		}
		if prof.Name == "" {
			prof.Name = name
		}
	}
	return prof
}

func (a genericAdapter) Profile(ctx context.Context, in ProfileInput) (Profile, error) {
	return a.profileFrom(ctx, in), nil
}

// tsidpAdapter is tailscale's tsidp. Its claim rules are a standard provider's
// — `sub` is already the stable `userid:<n>` — and its picture is the
// Tailscale profile URL, which tsidp serves ONLY at /userinfo (see
// userInfoProfile in service.go for the source citation). It is a distinct
// kind so a deployment says what it actually runs, and so tsidp-only behaviour
// has a home when the next difference appears.
type tsidpAdapter struct{ genericAdapter }

func (a tsidpAdapter) Kind() string { return KindTsidp }

// entraAdapter is Microsoft Entra ID (v2 endpoint). Two rules make it safe:
// the tenant must be allowlisted, and the identity key is `oid` within `tid`
// because `sub` is pairwise per application.
type entraAdapter struct{ p Provider }

func (a entraAdapter) Kind() string { return KindEntra }

func (a entraAdapter) Scopes() []string {
	scopes := []string{"openid", "profile", "email"}
	if a.p.Entra.FetchPhoto {
		// A Graph permission rides in the OIDC scope list; Entra then issues an
		// access token whose audience is Microsoft Graph. Requested only when a
		// photo is actually wanted (ADR-0083 Security/privacy).
		scopes = append(scopes, "User.Read")
	}
	return scopes
}

func (a entraAdapter) Subject(claims map[string]any) (string, error) {
	tid := claimsString(claims, "tid")
	if tid == "" {
		return "", errors.New("auth: entra id token has no tid claim")
	}
	oid := claimsString(claims, "oid")
	if oid == "" {
		return "", errors.New("auth: entra id token has no oid claim")
	}
	return tid + "/" + oid, nil
}

func (a entraAdapter) Admit(claims map[string]any) error {
	tid := claimsString(claims, "tid")
	if tid == "" {
		return errors.New("auth: entra id token has no tid claim")
	}
	if !entraTenantAllowed(a.p.Entra.AllowedTenants, tid) {
		return fmt.Errorf("auth: entra tenant %q is not in allowed_tenants", tid)
	}
	// oid is the identity key, so a token without one cannot be admitted even
	// though its tenant is allowed: Subject would have to invent a person.
	if claimsString(claims, "oid") == "" {
		return errors.New("auth: entra id token has no oid claim")
	}
	want, err := entraTenantIssuer(a.p.Issuer, tid)
	if err != nil {
		return err
	}
	// Microsoft's rule for a multi-tenant app: the token's `iss` names the
	// SIGNING user's tenant, not the `organizations` endpoint the code was
	// redeemed at (v2-protocols-oidc, read 2026-11-11).
	if iss := claimsString(claims, "iss"); iss != want {
		return fmt.Errorf("auth: entra id token issuer %q does not match the expected %q", iss, want)
	}
	return nil
}

// Profile takes the name and UPN from the ID token (`name` and
// `preferred_username` arrive with the `profile` scope) and the photo from
// Graph. A photo that will not load is never an error.
func (a entraAdapter) Profile(ctx context.Context, in ProfileInput) (Profile, error) {
	prof := Profile{
		Name:  firstNonEmpty(claimsString(in.Claims, "name"), claimsString(in.Claims, "preferred_username")),
		Email: claimsString(in.Claims, "email"),
	}
	if prof.Email == "" {
		// A guest account's UPN is often the only address claim released.
		if upn := claimsString(in.Claims, "preferred_username"); strings.Contains(upn, "@") {
			prof.Email = upn
		}
	}
	if in.UserInfo != nil && (prof.Name == "" || prof.Email == "") {
		pic, name := in.UserInfo(ctx)
		if prof.Name == "" {
			prof.Name = name
		}
		if pic != "" && prof.Picture.URL == "" {
			prof.Picture.URL = pic
		}
	}
	if !a.p.Entra.FetchPhoto {
		return prof, nil
	}
	pic, err := a.fetchGraphPhoto(ctx, in)
	if err != nil {
		// Graph being down, refusing the consent, or sending 20 KiB of GIF is a
		// missing face, never a refused login.
		return prof, nil
	}
	prof.Picture = pic
	return prof, nil
}

// fetchGraphPhoto pulls GET <graph>/me/photo/$value with the access token,
// type-sniffs the body and refuses anything larger than MaxAvatarBytes. The
// content type comes from the sniff, never from Graph's header.
func (a entraAdapter) fetchGraphPhoto(ctx context.Context, in ProfileInput) (Picture, error) {
	if in.Token == nil || in.Token.AccessToken == "" {
		return Picture{}, errors.New("auth: no access token for the graph photo")
	}
	client := in.Client
	if client == nil {
		return Picture{}, errors.New("auth: no http client for the graph photo")
	}
	endpoint := a.p.Entra.graphBase() + "/me/photo/$value"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return Picture{}, fmt.Errorf("auth: build graph photo request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+in.Token.AccessToken)
	resp, err := client.Do(req)
	if err != nil {
		return Picture{}, fmt.Errorf("auth: graph photo request failed")
	}
	defer func() { _, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096)); resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return Picture{}, fmt.Errorf("auth: graph photo endpoint answered %d", resp.StatusCode)
	}
	// Read one byte past the cap: a body that fits is stored, a body that does
	// not is refused rather than truncated into a corrupt image.
	body, err := io.ReadAll(io.LimitReader(resp.Body, int64(MaxAvatarBytes)+1))
	if err != nil {
		return Picture{}, errors.New("auth: graph photo body unreadable")
	}
	if len(body) == 0 {
		return Picture{}, errors.New("auth: graph photo body is empty")
	}
	if len(body) > MaxAvatarBytes {
		return Picture{}, fmt.Errorf("auth: graph photo is over the %d byte cap", MaxAvatarBytes)
	}
	ct := http.DetectContentType(body)
	switch ct {
	case "image/jpeg", "image/png", "image/webp":
		return Picture{Bytes: body, ContentType: ct}, nil
	default:
		return Picture{}, fmt.Errorf("auth: graph photo is %s, not jpeg, png or webp", ct)
	}
}

func entraTenantAllowed(tenants []string, tid string) bool {
	for _, t := range tenants {
		if strings.EqualFold(t, tid) {
			return true
		}
	}
	return false
}

// entraGenericTenants name the endpoint, not a company: a token redeemed
// through one of them carries the signing user's own tenant in `tid`.
//
// https://learn.microsoft.com/en-us/entra/identity-platform/v2-protocols-oidc
// (read 2026-11-11)
var entraGenericTenants = map[string]bool{
	"organizations": true,
	"common":        true,
	"consumers":     true,
}

// entraTenantIssuer is the `iss` a token from tid must carry. A configured
// single-tenant endpoint pins both the tenant and the issuer; an
// organizations/common/consumers endpoint takes its expected issuer from the
// token's own tid, which is why allowed_tenants is what actually gates entry.
func entraTenantIssuer(configured, tid string) (string, error) {
	u, err := url.Parse(configured)
	if err != nil {
		return "", fmt.Errorf("auth: cannot parse entra issuer: %v", err)
	}
	segs := strings.Split(strings.Trim(u.Path, "/"), "/")
	if len(segs) != 2 || segs[1] != "v2.0" {
		return "", fmt.Errorf("auth: entra issuer %q must look like https://<host>/<tenant>/v2.0", configured)
	}
	if tid == "" {
		return "", errors.New("auth: entra id token has no tid claim")
	}
	if !entraGenericTenants[segs[0]] {
		if !strings.EqualFold(segs[0], tid) {
			return "", fmt.Errorf("auth: entra tenant %q may not sign in through the single-tenant endpoint %q",
				tid, configured)
		}
		return strings.TrimRight(configured, "/"), nil
	}
	return u.Scheme + "://" + u.Host + "/" + tid + "/v2.0", nil
}

// envProvider synthesizes the single `default` provider from the pre-ADR-0083
// environment fields, so an env-only deployment sees one provider and keeps the
// exact login behaviour it has today.
func envProvider(issuer, browserIssuer, clientID, clientSecret string) Provider {
	p := Provider{
		ID:            DefaultProviderID,
		Kind:          KindGeneric,
		Issuer:        strings.TrimSpace(issuer),
		BrowserIssuer: strings.TrimSpace(browserIssuer),
		ClientID:      strings.TrimSpace(clientID),
		clientSecret:  clientSecret,
	}
	if ad, err := newAdapter(p); err == nil {
		p.Adapter = ad
	}
	return p
}
