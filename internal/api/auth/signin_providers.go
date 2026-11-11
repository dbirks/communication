package auth

import "github.com/dbirks/communication/internal/api"

// SignInProviders is the ONE exported read of the deployment's provider list
// meant for surfaces outside this package (ADR-0083). It answers in
// configuration order with the same rows `GET /auth/providers` prints, plus the
// issuer each provider discovers against, reduced to what an operator may see:
//
//   - `ID` is the slug in `/auth/login?provider=<id>`;
//   - `Label` is the chooser's own wording (`Provider.label()` — the configured
//     label, else the kind's name, else the default provider's "OIDC", else the
//     issuer host), so the operations page and the sign-in button can never
//     disagree;
//   - `Issuer` is the provider's issuer URL. Callers reduce it further —
//     `internal/api`'s operations overview prints the bare host only — because
//     it is a hostname, never a path, query or userinfo, that leaves this
//     process.
//
// It deliberately carries no client id, no secret and no discovery document: a
// provider list is not a secret, but everything around it is. `Provider.clientSecret`
// is unexported precisely so it cannot ride out of a struct like this one by
// accident.
//
// The row type is `api`'s, not this package's, and that direction is not an
// accident: `auth` already imports `internal/api` (it writes problems with it),
// so `internal/api` may not import `auth` back. Naming the type once, on the
// side both packages can see, is what lets the overview take the list as plain
// data instead of each caller inventing its own copy of the same three fields.
func (c Config) SignInProviders() []api.SignInProvider {
	providers := c.LoginProviders()
	out := make([]api.SignInProvider, 0, len(providers))
	for _, p := range providers {
		out = append(out, api.SignInProvider{ID: p.ID, Label: p.label(), Issuer: p.Issuer})
	}
	return out
}
