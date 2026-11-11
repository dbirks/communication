# ADR-0083: Multi-provider OIDC, with Tailscale tsidp and Microsoft Entra ID side by side

- **Date:** 2026-11-11
- **Status:** Proposed
- **Owners:** project owner, orchestrator
- **Related decisions / contracts:** ADR-0012 (OIDC sign-in and identity keys), 06-collaboration-identity
  (OIDC, authorization, audit), migration 00031 (`users.avatar_url`)

## Context
Today the server has exactly one issuer. `auth.Config` holds `Issuer`, `ClientID` and `ClientSecret`, set from
`COMMUNICATION_OIDC_ISSUER`, `COMMUNICATION_OIDC_CLIENT_ID` and `COMMUNICATION_OIDC_CLIENT_SECRET`.

The home deployment signs in through Tailscale's tsidp. A work deployment will sign in through Microsoft Entra
ID (Azure AD). Some deployments want both: tailnet members through tsidp, colleagues through Entra.

The two providers differ in ways that matter:

| | tsidp | Entra ID (v2 endpoint) |
|---|---|---|
| Issuer | `https://idp.<tailnet>.ts.net` | `https://login.microsoftonline.com/{tid}/v2.0`; for `organizations` or `common` the token's `iss` carries the **user's** tenant |
| Stable subject | `sub` (`userid:<n>`) | `sub` is pairwise per application. **`oid`** (object id) **within `tid`** is the stable person key across apps |
| Name | `/userinfo` `name` (the ID token may carry only the login name) | `name` and `preferred_username` (UPN) in the ID token, with the `profile` scope |
| Picture | `/userinfo` `picture`: a public https URL to the Tailscale profile image | **No URL.** The photo comes from Microsoft Graph `GET /me/photo/$value` with a bearer token (`User.Read`). It cannot be hot-linked |
| Tenant restriction | the tailnet itself | **must** check `tid` against an allowlist; a multi-tenant app otherwise admits any Entra tenant |
| Client auth | secret | secret, or a certificate or federated credential (later) |

Users are already keyed by `(issuer, subject)` (`UpsertOIDCUser(org, issuer, subject, …)`), so two providers
cannot collide. Adding providers is mostly configuration, a login chooser, and per-provider claim rules.

## Options considered
| Option | Advantages | Disadvantages |
|---|---|---|
| A. Keep one issuer and run two deployments | nothing to build | one team, two apps |
| B. A broker such as Dex or Keycloak in front | one issuer to the app | another stateful service to run and secure, and it hides Entra's `oid`/`tid` semantics behind its own subject |
| **C. A provider list in the app, each with a small adapter for claims and pictures** | explicit, testable, and keeps each provider's real identity keys | some per-provider code |

## Decision
Option C.

### Configuration
`COMMUNICATION_OIDC_PROVIDERS_FILE` points at YAML, mounted from a ConfigMap. Secrets stay in files:

```yaml
providers:
  - id: tailnet                 # stable slug; used in /auth/login/{id} and /auth/callback/{id}
    label: "Tailscale"
    kind: tsidp                 # tsidp | entra | generic
    issuer: https://idp.beluga-wyvern.ts.net
    client_id: 556debffc484b7820c30093a21e1e199
    client_secret_file: /run/oidc/tailnet/secret
  - id: work
    label: "Microsoft (E-gineering)"
    kind: entra
    issuer: https://login.microsoftonline.com/organizations/v2.0
    client_id: <app registration id>
    client_secret_file: /run/oidc/work/secret
    entra:
      allowed_tenants: ["<tid>"]   # required for kind entra; empty refuses to start
      fetch_photo: true            # Graph /me/photo/$value with User.Read
bootstrap_admins: ["tailnet:userid:16684175954410223", "work:<tid>/<oid>"]
```

The existing single-issuer env vars still work. They synthesize one `generic` provider with id `default`, so
every deployment keeps running unchanged.

### Adapters
```go
type ProviderAdapter interface {
    Scopes() []string                                      // tsidp/generic: openid profile email; entra: + User.Read when fetch_photo
    Subject(claims map[string]any) (string, error)          // tsidp/generic: sub; entra: tid + "/" + oid (both required)
    Admit(claims map[string]any) error                      // entra: tid ∈ allowed_tenants; issuer must equal the tenant-specific iss
    Profile(ctx, tok, claims) (name, email string, pic Picture, err error)
}
type Picture struct { URL string; Bytes []byte; ContentType string } // URL for tsidp/generic, Bytes for entra
```

The pieces behave as follows:

- **Discovery and validation.** Each provider gets its own `oidc.Provider` and verifier.
  - Entra multi-tenant is handled with `InsecureSkipIssuerCheck` on discovery only.
  - The **token** issuer is then checked against `https://login.microsoftonline.com/{tid}/v2.0`, with `tid` in
    the allowlist. This is Microsoft's documented validation rule for multi-tenant apps.
- **State.** Login state records `provider_id`, and the callback refuses a state minted for a different
  provider.
- **Login page.**
  - With one provider, it shows one button, as today.
  - With several, it shows one button per provider, in config order.
  - `/auth/login?provider=<id>` deep-links.
- **Pictures.**
  - `Picture.URL` is stored in `users.avatar_url` (https only, as 00031).
  - `Picture.Bytes` (Entra) is stored server-side in a new `user_avatars(user_id, content_type, bytes, etag,
    updated_at)` table, capped at 256 KiB with jpeg, png or webp only. It is served at
    `GET /api/v1/users/{id}/avatar` (same-origin, so CSP `img-src 'self'` covers it). `avatar_url` is then set to
    that path.
- **Identity linking.** The same human signing in through two providers is **two users** until an admin links
  them. Linking is out of scope here; the extension point is a future `user_identities` table replacing the
  `(issuer, subject)` columns.

### Scope of the first implementation
1. The provider list, adapters `generic`, `tsidp` and `entra`, the login chooser, and state-to-provider binding.
2. Entra photo bytes and the avatar route.
3. Bootstrap admins in `provider:subject` form, with the old bare-subject form still accepted for `default`.

## Consequences
- One deployment can serve tailnet users and Entra users.
- Entra's stable `tid/oid` key avoids the pairwise-`sub` trap.
- **Picture URLs (tsidp, generic):** the CSP keeps `img-src https:` for them. Entra pictures need no CSP change.
- Two accounts for one person until linking exists.

## Security/privacy
- An Entra provider refuses to start with no `allowed_tenants`, which fails closed on the "any tenant" default.
- Client secrets are read from files only, never env values in specs, and are never logged.
- `User.Read` is requested only when `fetch_photo` is on.
- Photo bytes are type-sniffed and size-capped. Content-Type comes from the sniff, not from Graph.
- The callback binds state to the provider, so a code from provider A can't complete a login started for B.

## Verification
- **Unit tests:**
  - Subject derivation for each adapter.
  - Entra `Admit`: wrong `tid`, a missing `oid`, and an issuer mismatch.
  - State-to-provider binding.
  - The env-to-`default` synthesis.
- **Integration:** two mock IdPs (the lab's mock issuer twice, with different ids). The login page lists both,
  each signs in, and they produce two users.
- **Entra:** a fake Graph server serving a JPEG gives a stored avatar served same-origin, and a 300 KiB photo is
  rejected.

## Migration/rollback
The change is additive. Env-only deployments see no change. Rollback means removing
`COMMUNICATION_OIDC_PROVIDERS_FILE`. `user_avatars` is forward-only (ADR-0013).
