package auth

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/oauth2"

	"github.com/dbirks/communication/internal/api"
)

// writeSecret drops a client secret into a temp file, mirroring the mounted-file
// shape ADR-0083 requires (the providers file itself may never carry one).
func writeSecret(t *testing.T, name, value string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, []byte(value+"\n"), 0o600); err != nil {
		t.Fatalf("write %s: %v", name, err)
	}
	return path
}

// homeProvidersYAML is the ADR-0083 example: a tailnet through tsidp and
// colleagues through Entra, in that order, which is the order the login chooser
// must print.
func homeProvidersYAML(t *testing.T) string {
	t.Helper()
	return fmt.Sprintf(`
providers:
  - id: tailnet
    label: "Tailscale"
    kind: tsidp
    issuer: https://idp.beluga-wyvern.ts.net
    client_id: 556debffc484b7820c30093a21e1e199
    client_secret_file: %s
  - id: work
    label: "Microsoft (E-gineering)"
    kind: entra
    issuer: https://login.microsoftonline.com/organizations/v2.0
    client_id: 11111111-2222-3333-4444-555555555555
    client_secret_file: %s
    entra:
      allowed_tenants: ["eeeeeeee-aaaa-bbbb-cccc-dddddddddddd"]
      fetch_photo: true
bootstrap_admins: ["tailnet:userid:16684175954410223", "work:eeeeeeee-aaaa-bbbb-cccc-dddddddddddd/999"]
`, writeSecret(t, "tailnet", "tailnet-secret-value"), writeSecret(t, "work", "entra-secret-value"))
}

func TestLoadProvidersFileReadsTheADR0083Example(t *testing.T) {
	path := filepath.Join(t.TempDir(), "providers.yaml")
	if err := os.WriteFile(path, []byte(homeProvidersYAML(t)), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	providers, admins, err := LoadProvidersFile(path)
	if err != nil {
		t.Fatalf("LoadProvidersFile: %v", err)
	}
	if len(providers) != 2 {
		t.Fatalf("providers = %d, want 2", len(providers))
	}
	if got := providers[0].ID + "," + providers[1].ID; got != "tailnet,work" {
		t.Errorf("ids = %q, want configuration order preserved", got)
	}
	if providers[0].Kind != KindTsidp || providers[1].Kind != KindEntra {
		t.Errorf("kinds = %q, %q", providers[0].Kind, providers[1].Kind)
	}
	// The secret came from the file, with the mounted file's trailing newline
	// removed.
	if providers[0].ClientSecret() != "tailnet-secret-value" {
		t.Errorf("tailnet secret = %q", providers[0].ClientSecret())
	}
	if providers[1].ClientSecret() != "entra-secret-value" {
		t.Errorf("entra secret = %q", providers[1].ClientSecret())
	}
	if len(admins) != 2 || admins[0] != "tailnet:userid:16684175954410223" {
		t.Errorf("bootstrap_admins = %v", admins)
	}
	if !providers[1].Entra.FetchPhoto {
		t.Errorf("entra fetch_photo = false, want true")
	}
	// The scope list is where the two kinds differ, and where User.Read appears
	// only for a deployment that actually asked for a photo.
	if got := strings.Join(providers[0].Adapter.Scopes(), " "); got != "openid profile email" {
		t.Errorf("tsidp scopes = %q", got)
	}
	if got := strings.Join(providers[1].Adapter.Scopes(), " "); got != "openid profile email User.Read" {
		t.Errorf("entra scopes = %q, want User.Read with fetch_photo", got)
	}
	noPhoto := Provider{
		ID: "work", Kind: KindEntra, Issuer: "https://login.microsoftonline.com/organizations/v2.0",
		ClientID: "c", Entra: EntraConfig{AllowedTenants: []string{"t"}},
	}
	ad, err := newAdapter(noPhoto)
	if err != nil {
		t.Fatalf("newAdapter: %v", err)
	}
	if got := strings.Join(ad.Scopes(), " "); got != "openid profile email" {
		t.Errorf("entra scopes without fetch_photo = %q, want no User.Read", got)
	}
}

func TestLoadProvidersFileMissingFileNamesTheVariable(t *testing.T) {
	_, _, err := LoadProvidersFile(filepath.Join(t.TempDir(), "absent.yaml"))
	if err == nil || !strings.Contains(err.Error(), EnvProvidersFile) {
		t.Fatalf("err = %v, want it to name %s", err, EnvProvidersFile)
	}
}

func TestParseProvidersConfigRefusesWhatWouldWidenAccess(t *testing.T) {
	tailnetSecret := writeSecret(t, "s", "x")
	cases := []struct {
		name string
		yaml string
		want string
	}{
		{
			name: "duplicate ids",
			yaml: fmt.Sprintf(`
providers:
  - {id: a, issuer: https://a.test, client_id: c, client_secret_file: %s}
  - {id: a, issuer: https://b.test, client_id: c}
`, tailnetSecret),
			want: "duplicate provider id",
		},
		{
			name: "entra with no tenant allowlist",
			yaml: `
providers:
  - id: work
    kind: entra
    issuer: https://login.microsoftonline.com/organizations/v2.0
    client_id: c
`,
			want: "allowed_tenants",
		},
		{
			name: "entra with an empty tenant list",
			yaml: `
providers:
  - id: work
    kind: entra
    issuer: https://login.microsoftonline.com/organizations/v2.0
    client_id: c
    entra:
      allowed_tenants: []
`,
			want: "allowed_tenants",
		},
		{
			name: "unknown kind",
			yaml: `
providers:
  - {id: a, kind: magic, issuer: https://a.test, client_id: c}
`,
			want: "unknown kind",
		},
		{
			name: "client secret in the file",
			yaml: `
providers:
  - {id: a, issuer: https://a.test, client_id: c, client_secret: hunter2}
`,
			want: "client_secret",
		},
		{
			name: "client secret at the top level",
			yaml: `
client_secret: hunter2
providers:
  - {id: a, issuer: https://a.test, client_id: c}
`,
			want: "client_secret",
		},
		{
			name: "a misspelt tenant key would silently widen access",
			yaml: `
providers:
  - {id: w, kind: entra, issuer: https://login.microsoftonline.com/organizations/v2.0, client_id: c,
     entra: {allowed_tenant: [x]}}
`,
			want: "field allowed_tenant not found",
		},
		{
			name: "entra block on a generic provider",
			yaml: `
providers:
  - {id: a, issuer: https://a.test, client_id: c, entra: {allowed_tenants: [x]}}
`,
			want: "requires kind entra",
		},
		{
			name: "no providers",
			yaml: "bootstrap_admins: [x]\n",
			want: "no providers",
		},
		{
			name: "an id that is not a slug",
			yaml: `
providers:
  - {id: "Tail Net", issuer: https://a.test, client_id: c}
`,
			want: "must match",
		},
		{
			name: "no issuer",
			yaml: `
providers:
  - {id: a, client_id: c}
`,
			want: "no issuer",
		},
		{
			name: "a non-absolute issuer",
			yaml: `
providers:
  - {id: a, issuer: idp.internal, client_id: c}
`,
			want: "absolute http(s) URL",
		},
		{
			name: "entra issuer without the v2.0 tenant shape",
			yaml: `
providers:
  - {id: w, kind: entra, issuer: https://login.microsoftonline.com/organizations, client_id: c,
     entra: {allowed_tenants: [x]}}
`,
			want: "/v2.0",
		},
		{
			name: "an unreadable secret file",
			yaml: `
providers:
  - {id: a, issuer: https://a.test, client_id: c, client_secret_file: /nonexistent/oidc-secret}
`,
			want: "unreadable",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, _, err := ParseProvidersConfig([]byte(c.yaml))
			if err == nil {
				t.Fatalf("ParseProvidersConfig = nil error, want %q", c.want)
			}
			if !strings.Contains(err.Error(), c.want) {
				t.Errorf("err = %q, want it to contain %q", err, c.want)
			}
			if strings.Contains(err.Error(), "hunter2") {
				t.Errorf("an error echoed a client secret: %q", err)
			}
		})
	}
}

// TestEnvOnlyConfigSynthesizesDefaultProvider is ADR-0083's compatibility
// promise: the single-issuer environment variables become ONE `generic`
// provider called `default`, carrying the same issuer, client and secret.
func TestEnvOnlyConfigSynthesizesDefaultProvider(t *testing.T) {
	c := Config{
		Issuer:       "https://idp.example.test/",
		ClientID:     "communication",
		ClientSecret: "env-secret",
		PublicURL:    "https://app.example.test",
	}
	if err := c.Validate(); err != nil {
		t.Fatalf("an env-only config must still validate: %v", err)
	}
	ps := c.LoginProviders()
	if len(ps) != 1 {
		t.Fatalf("LoginProviders = %d, want the one synthesized provider", len(ps))
	}
	p := ps[0]
	if p.ID != DefaultProviderID || p.Kind != KindGeneric {
		t.Errorf("provider = %+v, want id %q kind %q", p, DefaultProviderID, KindGeneric)
	}
	if p.Issuer != c.Issuer || p.ClientID != c.ClientID || p.ClientSecret() != c.ClientSecret {
		t.Errorf("provider = %+v, want the env issuer/client/secret", p)
	}
	if got := strings.Join(p.Adapter.Scopes(), " "); got != "openid profile email" {
		t.Errorf("default scopes = %q, want the pre-ADR-0083 list", got)
	}
	// The redirect URI stays the fixed one, so a deployment's registered
	// callback URL does not change when it adds providers.
	if got := c.RedirectURL(); got != "https://app.example.test/auth/callback" {
		t.Errorf("RedirectURL = %q", got)
	}
	// A provider list relaxes the issuer/client requirement but not PublicURL:
	// the redirect URI is still how the IdP reaches us.
	list := Config{Providers: ps, PublicURL: "https://app.example.test"}
	if err := list.Validate(); err != nil {
		t.Errorf("Validate with a provider list and no env issuer = %v, want nil", err)
	}
	if err := (&Config{Providers: ps}).Validate(); err == nil ||
		!strings.Contains(err.Error(), EnvPublicURL) {
		t.Errorf("Validate without PublicURL = %v, want it named", err)
	}
	// An env-only config with neither issuer nor client says exactly what it
	// said before ADR-0083.
	empty := Config{PublicURL: "https://app.example.test"}
	err := empty.Validate()
	want := fmt.Sprintf("auth: missing required configuration: %s, %s", EnvIssuer, EnvClientID)
	if err == nil || err.Error() != want {
		t.Errorf("err = %v, want %q", err, want)
	}
}

// TestProviderValidationRejectsADuplicatedOrUnknownKindThroughConfig covers the
// path serve takes when a Config is built by hand rather than loaded from YAML.
func TestProviderValidationRejectsBadLists(t *testing.T) {
	good := Provider{ID: "a", Kind: KindGeneric, Issuer: "https://a.test", ClientID: "c"}
	cases := []struct {
		name string
		cfg  Config
		want string
	}{
		{"dup", Config{PublicURL: "https://x.test", Providers: []Provider{good, good}}, "duplicate provider id"},
		{"entra no tenants", Config{PublicURL: "https://x.test", Providers: []Provider{
			{ID: "w", Kind: KindEntra, Issuer: "https://login.microsoftonline.com/organizations/v2.0", ClientID: "c"},
		}}, "allowed_tenants"},
		{"bad kind", Config{PublicURL: "https://x.test", Providers: []Provider{
			{ID: "a", Kind: "saml", Issuer: "https://a.test", ClientID: "c"},
		}}, "unknown kind"},
		{"bad id", Config{PublicURL: "https://x.test", Providers: []Provider{
			{ID: "A B", Kind: KindGeneric, Issuer: "https://a.test", ClientID: "c"},
		}}, "must match"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := c.cfg.Validate()
			if err == nil || !strings.Contains(err.Error(), c.want) {
				t.Errorf("err = %v, want %q", err, c.want)
			}
		})
	}
}

// TestAdapterSubjectsAndAdmission is the claim-rule table of ADR-0083: the same
// ID token payload means different things per kind, and Entra is the kind that
// must refuse.
func TestAdapterSubjectsAndAdmission(t *testing.T) {
	const tenant = "eeeeeeee-aaaa-bbbb-cccc-dddddddddddd"
	entraIssuer := "https://login.microsoftonline.com/organizations/v2.0"
	entra := Provider{
		ID: "work", Kind: KindEntra, Issuer: entraIssuer, ClientID: "c",
		Entra: EntraConfig{AllowedTenants: []string{tenant}},
	}
	entraAd, err := newAdapter(entra)
	if err != nil {
		t.Fatalf("newAdapter(entra): %v", err)
	}
	single := entra
	single.Issuer = "https://login.microsoftonline.com/" + tenant + "/v2.0"
	singleAd, err := newAdapter(single)
	if err != nil {
		t.Fatalf("newAdapter(single tenant): %v", err)
	}
	sovereign := entra
	sovereign.Issuer = "https://login.microsoftonline.cn/" + tenant + "/v2.0"
	sovAd, err := newAdapter(sovereign)
	if err != nil {
		t.Fatalf("newAdapter(sovereign): %v", err)
	}
	genericAd, _ := newAdapter(Provider{ID: "d", Kind: KindGeneric, Issuer: "https://d.test", ClientID: "c"})
	tsidpAd, _ := newAdapter(Provider{ID: "t", Kind: KindTsidp, Issuer: "https://t.test", ClientID: "c"})

	t.Run("generic subject is sub", func(t *testing.T) {
		sub, err := genericAd.Subject(map[string]any{"sub": "userid:16684175954410223"})
		if err != nil || sub != "userid:16684175954410223" {
			t.Errorf("Subject = (%q, %v)", sub, err)
		}
		if _, err := genericAd.Subject(map[string]any{"sub": "  "}); err == nil {
			t.Errorf("Subject with a blank sub = nil error, want a refusal")
		}
		if err := genericAd.Admit(map[string]any{"iss": "anything"}); err != nil {
			t.Errorf("generic Admit = %v, want nil (the library checks iss/aud/nonce)", err)
		}
	})
	t.Run("tsidp kind names itself", func(t *testing.T) {
		sub, err := tsidpAd.Subject(map[string]any{"sub": "userid:42"})
		if err != nil || sub != "userid:42" {
			t.Errorf("Subject = (%q, %v)", sub, err)
		}
		if tsidpAd.Kind() != KindTsidp || genericAd.Kind() != KindGeneric || entraAd.Kind() != KindEntra {
			t.Errorf("kinds = %q %q %q", tsidpAd.Kind(), genericAd.Kind(), entraAd.Kind())
		}
	})

	// Entra: the stable person key is `oid` WITHIN `tid`, because `sub` is
	// pairwise per application.
	t.Run("entra subject is tid slash oid", func(t *testing.T) {
		sub, err := entraAd.Subject(map[string]any{"tid": tenant, "oid": "999", "sub": "pairwise"})
		if err != nil {
			t.Fatalf("Subject: %v", err)
		}
		if want := tenant + "/999"; sub != want {
			t.Errorf("Subject = %q, want %q", sub, want)
		}
	})
	t.Run("entra refuses a token it cannot key", func(t *testing.T) {
		for name, claims := range map[string]map[string]any{
			"no oid": {"tid": tenant, "iss": "https://login.microsoftonline.com/" + tenant + "/v2.0"},
			"no tid": {"oid": "999", "iss": "https://login.microsoftonline.com/" + tenant + "/v2.0"},
		} {
			if _, err := entraAd.Subject(claims); err == nil {
				t.Errorf("%s: Subject = nil error, want a refusal", name)
			}
			if err := entraAd.Admit(claims); err == nil {
				t.Errorf("%s: Admit = nil error, want a refusal", name)
			}
		}
	})

	// The multi-tenant endpoint means the token's iss names the SIGNING USER's
	// tenant: https://learn.microsoft.com/en-us/entra/identity-platform/v2-protocols-oidc
	// (read 2026-11-11).
	t.Run("entra admits its allowlisted tenant", func(t *testing.T) {
		claims := map[string]any{
			"tid": tenant, "oid": "999",
			"iss": "https://login.microsoftonline.com/" + tenant + "/v2.0",
		}
		if err := entraAd.Admit(claims); err != nil {
			t.Errorf("Admit = %v, want nil", err)
		}
	})
	t.Run("entra refuses a foreign tenant", func(t *testing.T) {
		const other = "ffffffff-aaaa-bbbb-cccc-dddddddddddd"
		if err := entraAd.Admit(map[string]any{
			"tid": other, "oid": "999",
			"iss": "https://login.microsoftonline.com/" + other + "/v2.0",
		}); err == nil || !strings.Contains(err.Error(), "allowed_tenants") {
			t.Errorf("Admit(other tenant) = %v, want an allowed_tenants refusal", err)
		}
	})
	t.Run("entra refuses an issuer that is not its own tenant", func(t *testing.T) {
		// The tenant IS allowlisted, but the token claims to come from the
		// multi-tenant endpoint instead of the tenant-specific issuer.
		if err := entraAd.Admit(map[string]any{
			"tid": tenant, "oid": "999", "iss": entraIssuer,
		}); err == nil || !strings.Contains(err.Error(), "issuer") {
			t.Errorf("Admit(iss = organizations) = %v, want an issuer refusal", err)
		}
		if err := entraAd.Admit(map[string]any{
			"tid": tenant, "oid": "999", "iss": "https://attacker.example/" + tenant + "/v2.0",
		}); err == nil || !strings.Contains(err.Error(), "issuer") {
			t.Errorf("Admit(foreign host) = %v, want an issuer refusal", err)
		}
	})
	t.Run("a single-tenant endpoint pins the tenant", func(t *testing.T) {
		if err := singleAd.Admit(map[string]any{
			"tid": tenant, "oid": "999", "iss": single.Issuer,
		}); err != nil {
			t.Errorf("Admit(own tenant) = %v, want nil", err)
		}
		const other = "ffffffff-aaaa-bbbb-cccc-dddddddddddd"
		if err := singleAd.Admit(map[string]any{
			"tid": other, "oid": "999", "iss": "https://login.microsoftonline.com/" + other + "/v2.0",
		}); err == nil {
			t.Errorf("Admit(other tenant through a single-tenant endpoint) = nil, want a refusal")
		}
		// A sovereign cloud host is just another host: the expected issuer is
		// built from the configured one, never from a hardcoded Microsoft URL.
		if err := sovAd.Admit(map[string]any{
			"tid": tenant, "oid": "999", "iss": sovereign.Issuer,
		}); err != nil {
			t.Errorf("Admit(china cloud) = %v, want nil", err)
		}
	})
}

// TestGenericProfileUsesUserInfoOnce covers the tsidp picture rule (tailscale
// serves `picture` only at /userinfo) and the one-round-trip budget.
func TestGenericProfileUsesUserInfoOnce(t *testing.T) {
	ctx := context.Background()
	ad, err := newAdapter(Provider{ID: "t", Kind: KindTsidp, Issuer: "https://t.test", ClientID: "c"})
	if err != nil {
		t.Fatalf("newAdapter: %v", err)
	}
	calls := 0
	userInfo := func(context.Context) (string, string) {
		calls++
		return "https://avatars.githubusercontent.com/u/1?v=4", "David Birks"
	}

	// The ID token carried neither face nor name: one call, both gaps filled.
	prof, err := ad.Profile(ctx, ProfileInput{Claims: map[string]any{"sub": "userid:1"}, UserInfo: userInfo})
	if err != nil {
		t.Fatalf("Profile: %v", err)
	}
	if prof.Picture.URL != "https://avatars.githubusercontent.com/u/1?v=4" || prof.Name != "David Birks" {
		t.Errorf("Profile = %+v, want the userinfo picture and name", prof)
	}
	if calls != 1 {
		t.Errorf("userinfo calls = %d, want 1", calls)
	}

	// Both present: no round trip at all.
	calls = 0
	prof, _ = ad.Profile(ctx, ProfileInput{Claims: map[string]any{
		"sub": "userid:1", "name": "Davida", "picture": "https://cdn.example/x.png",
	}, UserInfo: userInfo})
	if calls != 0 {
		t.Errorf("userinfo calls = %d, want 0 when the ID token was complete", calls)
	}
	if prof.Name != "Davida" || prof.Picture.URL != "https://cdn.example/x.png" {
		t.Errorf("Profile = %+v, want the ID-token values", prof)
	}

	// An insecure picture claim never becomes a stored URL.
	prof, _ = ad.Profile(ctx, ProfileInput{Claims: map[string]any{"sub": "u"},
		UserInfo: func(context.Context) (string, string) { return "http://cdn.example/x.png", "" }})
	if prof.Picture.URL != "" {
		t.Errorf("picture = %q, want the http claim dropped", prof.Picture.URL)
	}
	// No UserInfo at all is a complete answer, not an error.
	prof, err = ad.Profile(ctx, ProfileInput{Claims: map[string]any{"sub": "u"}})
	if err != nil || prof.Name != "" || prof.Picture.URL != "" {
		t.Errorf("Profile = (%+v, %v), want an empty profile and no error", prof, err)
	}
}

// TestEntraProfilePhotoRules is ADR-0083's picture half: type-sniffed, capped,
// and never a reason to refuse a login.
func TestEntraProfilePhotoRules(t *testing.T) {
	const tenant = "eeeeeeee-aaaa-bbbb-cccc-dddddddddddd"
	graph := func(t *testing.T, status int, contentType string, body []byte) *httptest.Server {
		t.Helper()
		return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/me/photo/$value" {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			if r.Header.Get("Authorization") != "Bearer graph-token" {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			w.Header().Set("Content-Type", contentType)
			w.WriteHeader(status)
			_, _ = w.Write(body)
		}))
	}
	profile := func(t *testing.T, srv *httptest.Server, fetch bool) (Profile, error) {
		t.Helper()
		ad, err := newAdapter(Provider{
			ID: "work", Kind: KindEntra, ClientID: "c",
			Issuer: "https://login.microsoftonline.com/organizations/v2.0",
			Entra:  EntraConfig{AllowedTenants: []string{tenant}, FetchPhoto: fetch, GraphBaseURL: srv.URL},
		})
		if err != nil {
			t.Fatalf("newAdapter: %v", err)
		}
		return ad.Profile(context.Background(), ProfileInput{
			Claims: map[string]any{"tid": tenant, "oid": "999", "name": "Davida Birks",
				"preferred_username": "davida@eg.test", "email": "davida@eg.test"},
			Token:  tokenWithAccess("graph-token"),
			Client: srv.Client(),
		})
	}

	t.Run("a jpeg is stored with the sniffed type", func(t *testing.T) {
		body := append([]byte{0xff, 0xd8, 0xff, 0xe0}, bytes.Repeat([]byte{'j'}, 64)...)
		srv := graph(t, http.StatusOK, "application/octet-stream", body)
		defer srv.Close()
		prof, err := profile(t, srv, true)
		if err != nil {
			t.Fatalf("Profile: %v", err)
		}
		if prof.Name != "Davida Birks" || prof.Email != "davida@eg.test" {
			t.Errorf("Profile = %+v, want the ID-token name and email", prof)
		}
		if prof.Picture.ContentType != "image/jpeg" {
			t.Errorf("content type = %q, want the sniffed image/jpeg, not Graph's header",
				prof.Picture.ContentType)
		}
		if !bytes.Equal(prof.Picture.Bytes, body) {
			t.Errorf("picture bytes = %d bytes, want the body", len(prof.Picture.Bytes))
		}
	})

	t.Run("an over-cap photo is no photo", func(t *testing.T) {
		body := append([]byte{0xff, 0xd8, 0xff, 0xe0}, bytes.Repeat([]byte{'j'}, MaxAvatarBytes+1)...)
		srv := graph(t, http.StatusOK, "image/jpeg", body)
		defer srv.Close()
		prof, err := profile(t, srv, true)
		if err != nil {
			t.Fatalf("Profile must not fail a login over a photo: %v", err)
		}
		if prof.Picture.Bytes != nil {
			t.Errorf("picture = %d bytes, want none", len(prof.Picture.Bytes))
		}
	})

	t.Run("an unaccepted type is no photo", func(t *testing.T) {
		body := append([]byte("GIF89a"), bytes.Repeat([]byte{'g'}, 64)...)
		srv := graph(t, http.StatusOK, "image/gif", body)
		defer srv.Close()
		prof, _ := profile(t, srv, true)
		if prof.Picture.Bytes != nil {
			t.Errorf("picture = %q, want none for a gif", prof.Picture.ContentType)
		}
	})

	t.Run("graph failure is no photo", func(t *testing.T) {
		for name, srv := range map[string]*httptest.Server{
			"404":   graph(t, http.StatusNotFound, "image/jpeg", nil),
			"500":   graph(t, http.StatusInternalServerError, "image/jpeg", []byte("boom")),
			"empty": graph(t, http.StatusOK, "image/jpeg", nil),
		} {
			prof, err := profile(t, srv, true)
			if err != nil {
				t.Errorf("%s: Profile = %v, want a login that succeeded", name, err)
			}
			if prof.Picture.Bytes != nil {
				t.Errorf("%s: picture bytes = %d, want none", name, len(prof.Picture.Bytes))
			}
			if prof.Name != "Davida Birks" {
				t.Errorf("%s: name = %q, want the ID-token name kept", name, prof.Name)
			}
			srv.Close()
		}
	})

	t.Run("no User.Read without fetch_photo means no graph call", func(t *testing.T) {
		calls := 0
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			calls++
			w.WriteHeader(http.StatusOK)
		}))
		defer srv.Close()
		if _, err := profile(t, srv, false); err != nil {
			t.Fatalf("Profile: %v", err)
		}
		if calls != 0 {
			t.Errorf("graph calls = %d, want 0 when fetch_photo is off", calls)
		}
	})
}

// TestBootstrapAdminForms covers ADR-0083 scope item 3: `provider:subject` and
// the old bare subject, which applies to `default` only.
func TestBootstrapAdminForms(t *testing.T) {
	c := Config{
		Providers: []Provider{
			{ID: "default", Kind: KindGeneric, Issuer: "https://d.test", ClientID: "c"},
			{ID: "tailnet", Kind: KindTsidp, Issuer: "https://t.test", ClientID: "c"},
			{ID: "work", Kind: KindEntra, Issuer: "https://login.microsoftonline.com/organizations/v2.0",
				ClientID: "c", Entra: EntraConfig{AllowedTenants: []string{"tid-guid"}}},
		},
		BootstrapAdminSubjects: []string{
			"tailnet:userid:16684175954410223", // qualified, subject keeps its own colon
			"work:tid-guid/999",                // qualified
			"frank",                            // bare: default provider only
			"userid:16684175954410223",         // bare: the colon is part of the subject
		},
	}
	cases := []struct {
		provider, subject string
		want              bool
	}{
		{"tailnet", "userid:16684175954410223", true},
		{"tailnet", "16684175954410223", false},
		{"work", "tid-guid/999", true},
		{"work", "999", false},
		{"default", "frank", true},
		{"default", "userid:16684175954410223", true},
		{"tailnet", "frank", false},
		{"tailnet", "tailnet:userid:16684175954410223", false},
		// A bare subject never grants admin at a named provider.
		{"work", "frank", false},
		{"", "frank", false},
		{"default", "", false},
	}
	for _, tc := range cases {
		t.Run(tc.provider+"/"+tc.subject, func(t *testing.T) {
			if got := c.IsBootstrapAdminFor(tc.provider, tc.subject); got != tc.want {
				t.Errorf("IsBootstrapAdminFor(%q, %q) = %v, want %v",
					tc.provider, tc.subject, got, tc.want)
			}
		})
	}
	// IsBootstrapAdmin is the `default`-provider question it always was: the env
	// variable's bare subjects keep granting admin exactly as they do today.
	if !c.IsBootstrapAdmin("frank") {
		t.Errorf("IsBootstrapAdmin(frank) = false, want true")
	}
	if !c.IsBootstrapAdmin("userid:16684175954410223") {
		t.Errorf("IsBootstrapAdmin(tsidp-shaped subject) = false, want true")
	}
	if c.IsBootstrapAdmin("999") {
		t.Errorf("IsBootstrapAdmin(work subject) = true, want false: it is qualified to work")
	}
}

// tokenWithAccess builds a token response carrying an access token, which is
// what authorizes the /userinfo and Graph calls an adapter may make.
func tokenWithAccess(accessToken string) *oauth2.Token {
	return &oauth2.Token{AccessToken: accessToken, TokenType: "Bearer", ExpiresIn: 3600}
}

// TestClientSecretNeverReachesTheLogger is ADR-0083's Security promise, tested
// rather than asserted in a comment: the secret must not appear in the log a
// failing login produces, nor in anything a Provider prints.
func TestClientSecretNeverReachesTheLogger(t *testing.T) {
	const secret = "sup3r-s3cret-client-value"
	var logs bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&logs, nil))

	// A provider whose issuer will not answer: discovery fails, and the failure
	// path is the one that logs the most about the upstream.
	idp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, `{"error":"down"}`, http.StatusServiceUnavailable)
	}))
	defer idp.Close()

	cfg := Config{
		PublicURL: "http://app.test",
		Providers: []Provider{{
			ID: "tailnet", Kind: KindTsidp, Issuer: idp.URL, ClientID: "client-id-1",
			clientSecret: secret,
		}},
	}
	svc := New(cfg, nil, logger)
	apiSrv := api.New(api.Config{ReplicaName: "unit", Version: "test", PublicURL: "http://app.test"},
		nil, svc, nil)
	svc.Register(apiSrv)

	req := httptest.NewRequest(http.MethodGet, "http://app.test/auth/login?provider=tailnet", nil)
	rec := httptest.NewRecorder()
	apiSrv.ServeHTTP(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("login status = %d, want 503 (the IdP is down)", rec.Code)
	}

	// A failing token exchange, which is the path whose upstream error text can
	// carry a query string.
	cfg2 := Config{Issuer: "http://127.0.0.1:1/", ClientID: "c", ClientSecret: secret,
		PublicURL: "http://app.test"}
	svc2 := New(cfg2, nil, logger)
	_, err := svc2.providerStates()
	if err2 := func() error {
		states, err := svc2.providerStates()
		if err != nil {
			return err
		}
		_, err = states[0].discover(context.Background(), svc2.client, logger)
		return err
	}(); err2 == nil {
		t.Fatalf("discovery against a dead port = nil error, want a failure (err from states: %v)", err)
	}

	out := logs.String()
	for _, leak := range []string{secret, "client-secret", "ClientSecret"} {
		if strings.Contains(out, leak) {
			t.Errorf("the log carries %q:\n%s", leak, out)
		}
	}
	// The same promise for anything that formats a Provider or a Config: the
	// secret lives in an unexported field with a String() that omits it.
	p := Provider{ID: "tailnet", Kind: KindTsidp, Issuer: "https://idp.example", ClientID: "c",
		clientSecret: secret}
	for _, form := range []string{fmt.Sprintf("%v", p), fmt.Sprintf("%s", p), fmt.Sprintf("%+v", p),
		fmt.Sprintf("%#v", p)} {
		if strings.Contains(form, secret) {
			t.Errorf("a Provider printed the secret: %s", form)
		}
	}
	// ... and a Config that carries providers, which is what a debug log line
	// would print.
	for _, form := range []string{fmt.Sprintf("%v", cfg), fmt.Sprintf("%+v", cfg), jsonMustMarshal(t, cfg)} {
		if strings.Contains(form, secret) {
			t.Errorf("a Config printed the secret: %s", form)
		}
	}
}

func jsonMustMarshal(t *testing.T, v any) string {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return string(raw)
}

// TestConfigFromEnvReadsTheProvidersFile is the deployment contract of
// ADR-0083: one variable turns a single-issuer replica into a multi-provider one,
// the single-issuer variables stop being required, the file's bootstrap admins
// add to the environment's rather than replacing them, and a file that cannot be
// enforced is a startup refusal that names the variable — the same rule
// COMMUNICATION_COOKIE_SECURE follows, because a provider list that would admit
// the world is worse than a replica that will not start.
func TestConfigFromEnvReadsTheProvidersFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "providers.yaml")
	body := fmt.Sprintf(`
providers:
  - id: tailnet
    kind: tsidp
    issuer: https://idp.beluga-wyvern.ts.net
    client_id: 556debffc484b7820c30093a21e1e199
    client_secret_file: %s
  - id: work
    kind: entra
    issuer: https://login.microsoftonline.com/organizations/v2.0
    client_id: app-reg-id
    entra:
      allowed_tenants: ["eeeeeeee-aaaa-bbbb-cccc-dddddddddddd"]
bootstrap_admins: ["tailnet:userid:16684175954410223", "work:eeeeeeee-aaaa-bbbb-cccc-dddddddddddd/999"]
`, writeSecret(t, "tailnet-secret", "tailnet-secret-value"))
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}

	t.Setenv(EnvIssuer, "")
	t.Setenv(EnvBrowserIssuer, "")
	t.Setenv(EnvClientID, "")
	t.Setenv(EnvClientSecret, "")
	t.Setenv(EnvPublicURL, "https://app.example.test")
	t.Setenv(EnvCookieSecure, "")
	t.Setenv(EnvBootstrapAdminSubjects, "alice")
	t.Setenv(EnvProvidersFile, path)

	cfg, err := ConfigFromEnv()
	if err != nil {
		t.Fatalf("ConfigFromEnv with a provider list and no single issuer: %v", err)
	}
	if len(cfg.Providers) != 2 {
		t.Fatalf("Providers = %v, want the two from the file", cfg.Providers)
	}
	if got := cfg.Providers[1].Entra.AllowedTenants; len(got) != 1 {
		t.Errorf("entra allowed_tenants = %v", got)
	}
	want := []string{"alice", "tailnet:userid:16684175954410223", "work:eeeeeeee-aaaa-bbbb-cccc-dddddddddddd/999"}
	if len(cfg.BootstrapAdminSubjects) != 3 || cfg.BootstrapAdminSubjects[0] != "alice" {
		t.Errorf("BootstrapAdminSubjects = %v, want the env entry first then the file's %v",
			cfg.BootstrapAdminSubjects, want)
	}
	if !cfg.IsBootstrapAdmin("alice") {
		t.Errorf("the env list's bare subject stopped granting admin at default: %v",
			cfg.BootstrapAdminSubjects)
	}
	if !cfg.IsBootstrapAdminFor("tailnet", "userid:16684175954410223") {
		t.Errorf("the file's qualified tailnet admin does not apply at tailnet")
	}

	// A providers file this build cannot enforce refuses to start, and says
	// which variable it came from.
	bad := filepath.Join(dir, "bad.yaml")
	if err := os.WriteFile(bad, []byte("providers:\n  - {id: w, kind: entra, issuer: https://login.microsoftonline.com/organizations/v2.0, client_id: c}\n"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	t.Setenv(EnvProvidersFile, bad)
	if _, err := ConfigFromEnv(); err == nil ||
		!strings.Contains(err.Error(), EnvProvidersFile) ||
		!strings.Contains(err.Error(), "allowed_tenants") {
		t.Errorf("ConfigFromEnv with an Entra provider lacking tenants err = %v, want it to name %s and the tenant rule",
			err, EnvProvidersFile)
	}

	// Unset (or blank) means today's single-provider configuration exactly.
	t.Setenv(EnvProvidersFile, "")
	t.Setenv(EnvIssuer, "http://oidc:8080/default")
	t.Setenv(EnvClientID, "communication")
	single, err := ConfigFromEnv()
	if err != nil {
		t.Fatalf("ConfigFromEnv without a providers file: %v", err)
	}
	if len(single.Providers) != 0 {
		t.Errorf("Providers = %v, want none (the default provider is synthesized on demand)",
			single.Providers)
	}
	if ps := single.LoginProviders(); len(ps) != 1 || ps[0].ID != DefaultProviderID ||
		ps[0].Issuer != single.Issuer {
		t.Errorf("LoginProviders = %v, want the one synthesized default", ps)
	}
}
