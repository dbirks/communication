# ADR-0012 — Dev/test identity (OIDC + PKCE against a mock IdP) and Postgres-backed sessions

- **Date:** 2026-10-14
- **Status:** Accepted — dev/test identity and session mechanics only. The **production** identity provider remains the project owner's open decision; D-015 stays *Spike required*.
- **Owners:** M1 control-plane implementers
- **Related decisions / contracts:** D-003 (Postgres authoritative, multi-replica control plane), D-010 (OIDC mapping, project RBAC), D-015 (hosted OIDC provider / exact Go auth library — unchanged, still Spike required), `communication-spec/06-collaboration-identity.md`, `communication-spec/09-api-events-data.md` ("Database table families"), `communication-spec/11-build-roadmap.md` (M1 exit)

## Context

M1's exit gate is "log in, create a project, add two repositories, see consistent state across two API replicas" (`11-build-roadmap.md` § M1). A working login is required before any production identity decision has been made.

`06-collaboration-identity.md` "Identity architecture" is Accepted and constrains the design: OIDC Authorization Code + PKCE "through a well-maintained Go/OIDC library"; internal `user_id` mapped to immutable `(issuer, subject)` and explicitly *not* email as key; API auth via "secure HttpOnly same-site cookie, CSRF protection for browser mutations, strict origin checks for event transports". `09-api-events-data.md` fixes the table family (`organizations`, `users`, `oidc_identities`, `memberships`) and the `UNIQUE (issuer, subject)` constraint.

Two constraints make this a decision rather than a tutorial:

1. **Replica independence (D-003).** An OIDC login is a two-request handshake split by a browser redirect, so in a round-robin deployment the callback lands on a different replica than the redirect that started it. Nonce, PKCE verifier and `return_to` held in process memory break M1's own exit demo.
2. **No passwords in the repo.** AGENTS.md forbids secrets/credentials in code, fixtures, tests or logs, so the dev IdP must authenticate without any committed credential material.

D-015 ("Initial hosted OIDC provider / exact Go auth library") is *Spike required*, and its answer — Keycloak, Dex, Entra, Okta, Google or another provider — is a business decision the implementation must not make silently on the owner's behalf.

## Options considered

| Option | Advantages | Disadvantages | Evidence |
|---|---|---|---|
| **`ghcr.io/navikt/mock-oauth2-server:6.0.7` as local/CI IdP (chosen)** | Real OIDC protocol (discovery, JWKS, signed tokens, Authorization Code + PKCE) so the `06` paths are genuinely exercised; any username logs in per provider path, so there are **no passwords to commit**; one pinned container | No group claims, no consent screen, no re-authentication or back-channel logout — those `06` behaviours stay unverified; JVM container is heavier than a Go fixture | Release 6.0.7 published 2026-10-13, https://github.com/navikt/mock-oauth2-server/releases (fetched 2026-10-14) |
| Dex with the static-users connector | Single binary, production-shaped config, real signature keys | Static users means committed password hashes — a repo-secret hazard under AGENTS.md; `http://localhost` redirect plumbing | Compared, not chosen for M1 |
| Keycloak dev realm + testcontainers | Richest simulation: realm roles, groups→claims, admin API for provisioning | Multi-hundred-MB JVM per test run; realm-import JSON becomes a maintained artefact; tempts committing test credentials | Compared; a candidate *later* integration fixture, not the dev default |
| Header-based dev auth (`X-Dev-User`), no IdP | Zero dependencies, instant | Rejected: exercises none of discovery/JWKS/PKCE/nonce handling that D-015 acceptance depends on, and leaves a permanent auth-bypass path | Rejected by `06` ("Use OIDC Authorization Code + PKCE") |

## Decision

1. **Libraries:** `github.com/coreos/go-oidc/v3 v3.21.0` + `golang.org/x/oauth2 v0.37.0`; Authorization Code + PKCE (S256) with `state` and `nonce`, scopes `openid profile email`; ID token verified for issuer, audience and nonce.
2. **Local/CI IdP:** `ghcr.io/navikt/mock-oauth2-server:6.0.7` (compose port 8090, issuer path `/default`). Logins use an arbitrary username; no password, client secret or cookie value is committed anywhere.
3. **Split issuer config**, because the container network name and the browser's view of the issuer differ: `COMMUNICATION_OIDC_ISSUER` is used by the *server* for discovery/token/JWKS (e.g. `http://oidc:8080/default`); `COMMUNICATION_OIDC_BROWSER_ISSUER`, when set, replaces the issuer prefix of the discovered `authorization_endpoint` for browser redirects only (e.g. `http://localhost:8090/default`). Redirect URI = `COMMUNICATION_PUBLIC_URL + /auth/callback`.
4. **Identity key is `(issuer, subject)`** in `oidc_identities` with `UNIQUE(issuer,subject)`; users are upserted on that pair at login. Display name resolution: `name` → `preferred_username` → `subject`; `email` nullable and never a key. `COMMUNICATION_BOOTSTRAP_ADMIN_SUBJECTS` grants org-admin by subject at login.
5. **Sessions are server-side Postgres rows, not JWTs:** `sessions(token_hash bytea PRIMARY KEY, user_id, csrf_token, created_at, expires_at, last_seen_at)`. The `communication_session` cookie carries a fresh 32-byte random token; **only its sha256 is stored, never the token**. Flags: HttpOnly, SameSite=Lax, `Secure` per `COMMUNICATION_COOKIE_SECURE` (default true), `Path=/`, 12 h.
6. **The login handshake lives in the DB:** `oidc_login_states(state PRIMARY KEY, code_verifier, nonce, return_to, created_at, expires_at)`, single-use, valid ≤10 min — this is what lets a login started on replica A complete on replica B (D-003, M1 two-replica exit).
7. **CSRF:** mutations require `X-CSRF-Token` equal to the session row's `csrf_token`; a present `Origin` must equal `COMMUNICATION_PUBLIC_URL`'s origin or the request's own scheme+host. `return_to` must be a same-origin relative path, else `/`.
8. **Out of scope:** choosing the production IdP. D-015 remains *Spike required*; nothing here implies Keycloak/Dex/Entra/Okta/Google, and no code may rely on mock-server behaviour beyond standard OIDC.

## Consequences

- The full OIDC path — discovery, redirect, code exchange, verification, `(issuer, subject)` upsert, session cookie — is exercised in dev and CI with zero committed secrets; revocation is possible because sessions and login states live in the authoritative DB.
- Session state survives API restart, which is what M1 asks us to demonstrate ("force restart, show preserved events and user access").
- Limitation: the mock IdP emits no group claims, so `06`'s "map IdP groups to roles through explicit policy" stays unimplemented and unverified.
- Limitation: IdP-side logout or account removal does not revoke an existing session until expiry; `06` "OIDC edge cases" prescribes a short-lived read-only grace that the 12 h TTL approximates but does not prove.
- Limitation: `sessions` rows accumulate; pruning and PII retention (`06` "Audit and retention") are required before this carries real data.
- Operational: the cookie is same-origin, so `serve` must serve the UI from `ui/dist` (or Vite must proxy `/api` and `/auth`); deploying the UI to a separate origin reopens this ADR.

## Security/privacy

- Trust boundary: browser → anonymous load balancer → any API replica. Fail-closed throughout: a missing/expired/unknown session token, or a reused/expired/nonexistent `state`, yields 401 or a rejected login — never a fallback identity.
- Storing `sha256(token)` means a `sessions` dump does not yield usable cookies; DB write access can still delete sessions (availability, not authentication) and that is audit-visible.
- CSRF = double-submit against a DB-stored random token plus origin check, per `06`. Project-scoped authorization (404-not-403 for non-members, denial audit rows) is ADR-0014's scope.
- Privacy: `email` optional and `subject` is the key, so email re-allocation cannot transfer ownership. No IdP tokens are persisted — only derived session material.
- The mock IdP must stay on the local compose network and must never be an issuer in production; `COMMUNICATION_COOKIE_SECURE=false` is dev-only.

## Verification

The M1 auth code does not exist at the time of writing, so **nothing above is claimed as observed**. Gates to record with evidence before M1 is called done (`12-test-strategy.md` matrices):

1. Compose round trip: `/auth/login?return_to=/projects` → IdP → callback → 302 to `return_to`; `GET /api/v1/me` with the cookie.
2. **Cross-replica login:** force the redirect through replica A (`:8081`) and the callback through replica B (`:8082`); the session must work on both (M1 exit, D-003).
3. Negatives: reused `state`, expired `state`, wrong `nonce`, wrong audience, missing `X-CSRF-Token`, `Origin` mismatch — all rejected.
4. IdP outage (`06`): an existing session still resolves with the mock server stopped; new logins fail closed.
5. Session survival across a forced restart of both replicas.

External evidence cited: mock-oauth2-server 6.0.7 release page (2026-10-13, fetched 2026-10-14). go-oidc v3.21.0 / x/oauth2 v0.37.0 are pinned by the M1 contract and are not in `go.mod` yet.

## Migration/rollback

Selecting the production IdP (D-015) is config-only *if* no identity rewrite is needed: repoint `COMMUNICATION_OIDC_ISSUER`/`CLIENT_ID`/`CLIENT_SECRET`, remove the mock container. If the issuer string changes, existing `oidc_identities` rows are keyed to the old issuer — that is an identity migration (rewrite or orphan), needs its own ADR/register update, and must not be done casually.

`sessions` and `oidc_login_states` arrive via the forward-only migration `00001_m1_core.sql` (ADR-0013); rollback is a compensating forward migration. Cookie name and TTL are implementation-scoped: re-keying means truncating `sessions` (logging everyone out), no schema change. Moving sessions out of Postgres would contradict D-003 and requires a new ADR.
