package auth

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestSignInProvidersListsTheFileInOrder is the operations page's read: with
// COMMUNICATION_OIDC_PROVIDERS_FILE set, the provider list — not
// COMMUNICATION_OIDC_ISSUER — is what the deployment signs people in with, and
// the page must print exactly what the sign-in chooser prints.
func TestSignInProvidersListsTheFileInOrder(t *testing.T) {
	path := filepath.Join(t.TempDir(), "providers.yaml")
	if err := os.WriteFile(path, []byte(homeProvidersYAML(t)), 0o600); err != nil {
		t.Fatalf("write providers: %v", err)
	}
	providers, _, err := LoadProvidersFile(path)
	if err != nil {
		t.Fatalf("LoadProvidersFile: %v", err)
	}
	c := Config{Providers: providers, PublicURL: "https://app.example.test"}
	if err := c.Validate(); err != nil {
		t.Fatalf("Validate: %v", err)
	}

	got := c.SignInProviders()
	if len(got) != 2 {
		t.Fatalf("SignInProviders = %d rows, want the file's two, in order: %+v", len(got), got)
	}
	if got[0].ID != "tailnet" || got[0].Label != "Tailscale" || got[0].Issuer != "https://idp.beluga-wyvern.ts.net" {
		t.Errorf("row 0 = %+v, want tailnet / Tailscale / the tsidp issuer", got[0])
	}
	if got[1].ID != "work" || got[1].Label != "Microsoft (E-gineering)" ||
		got[1].Issuer != "https://login.microsoftonline.com/organizations/v2.0" {
		t.Errorf("row 1 = %+v, want work / the configured label / the entra issuer", got[1])
	}
	// Nothing secret rides out: the file's client secrets and client ids are
	// this package's business.
	for _, row := range got {
		if joined := row.ID + row.Label + row.Issuer; strings.Contains(joined, "secret-value") ||
			strings.Contains(joined, "556debffc484b7820c30093a21e1e199") {
			t.Errorf("row %+v carries credential material", row)
		}
	}
}

// TestSignInProvidersLabelsAnEnvOnlyDeployment: the deployment that names one
// issuer in the environment gets the one row the sign-in page has always drawn,
// labelled with the word that page prints (ADR-0083 "Configuration").
func TestSignInProvidersLabelsAnEnvOnlyDeployment(t *testing.T) {
	c := Config{
		Issuer:       "https://idp.example.test/",
		ClientID:     "communication",
		PublicURL:    "https://app.example.test",
		ClientSecret: "env-secret",
	}
	if err := c.Validate(); err != nil {
		t.Fatalf("Validate: %v", err)
	}
	got := c.SignInProviders()
	if len(got) != 1 {
		t.Fatalf("SignInProviders = %+v, want the one synthesized provider", got)
	}
	if got[0].ID != DefaultProviderID || got[0].Issuer != c.Issuer {
		t.Errorf("row = %+v, want id %q and the env issuer", got[0], DefaultProviderID)
	}
	if got[0].Label == "" {
		t.Error("label is empty: the row must say what the chooser prints")
	}
	if got[0].Label != "OIDC" {
		t.Errorf("label = %q, want the sign-in page's own word for the default provider", got[0].Label)
	}
}

// TestSignInProvidersKindLabelsAreTheChoosers: an unset label falls back to the
// kind's name, so the operations page and the sign-in button never disagree.
func TestSignInProvidersKindLabelsAreTheChoosers(t *testing.T) {
	c := Config{
		Providers: []Provider{
			{ID: "ts", Kind: KindTsidp, Issuer: "https://idp.example.ts.net", ClientID: "c"},
			{ID: "plain", Issuer: "https://idp.example.test", ClientID: "c"},
		},
		PublicURL: "https://app.example.test",
	}
	if err := c.Validate(); err != nil {
		t.Fatalf("Validate: %v", err)
	}
	got := c.SignInProviders()
	if len(got) != 2 {
		t.Fatalf("SignInProviders = %+v, want two rows", got)
	}
	if got[0].Label != "Tailscale" {
		t.Errorf("tsidp label = %q, want %q", got[0].Label, "Tailscale")
	}
	// A named provider with no label of its own says where it is — the issuer's
	// host, never its path (`Provider.label`), so the operations page prints the
	// same word the sign-in chooser would.
	if got[1].Label != "idp.example.test" {
		t.Errorf("generic label = %q, want the issuer host the chooser prints", got[1].Label)
	}
}
