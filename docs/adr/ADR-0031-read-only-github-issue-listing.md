# ADR-0031 — Read-only, anonymous GitHub issue listing

- **Date:** 2026-10-16
- **Status:** Accepted
- **Owners:** control-plane contributors
- **Related:** ADR-0014, ADR-0018, ADR-0030, `07-config-integrations.md`, `wishlist-gap.md` § W3, ADR-0024

## Context

W3 asks that a run can be started from a GitHub issue. The smallest honest step is the read half:
`GET /api/v1/projects/{projectId}/repos/{repositoryId}/issues` answering "what is in the tracker
right now" for a repository the caller can already see; `07` forbids mirroring ("this does not
create a second generic issue tracker"), so this is a live proxy, not a sync. The full wishlist item (issue → trigger → run) needs `triggers`/`invocations` tables and
dedupe, which are M6 work (`11-build-roadmap`); the `integration.query` node kind stays deferred
(ADR-0024).

## Options considered
| Option | Advantages | Disadvantages | Evidence |
|---|---|---|---|
| A: read-through proxy, anonymous | No new tables, no secrets, no webhook surface; public repos work today | 60 req/h per replica IP; private repos 404 | adapter + handler tests; real curl in `docs/compatibility/GITHUB.md` |
| B: token via `SecretRef` now | private repos, 5000 req/h | needs per-deployment secret wiring before any test can run; mixes two deliverables | deferred to the follow-up named in Consequences |
| C: webhook + mirror | push updates, triggers | `triggers`/`invocations`/dedupe are M6; a receiver without them is an unauthenticated write surface | `11`, `07` |

## Decision

Option A. `internal/integrations/github` holds an `IssueLister` interface plus a net/http-only
client (pinned `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`, 10 s
timeout, base URL injectable for tests). It parses `owner/repo` from the repository row's `git_url`
(https/ssh/git@ forms; anything else → typed `not_a_github_repository` → HTTP 422), skips pull
requests, truncates bodies to 4000 bytes flagging `body_truncated`, and maps upstream 403/404 to
`github_rate_limited`/`github_repository_not_found` 502 problem codes. No token is sent — this
covers public repositories only. Nothing is stored; authorization is the project's own viewer+ read
with the standard 404 + audit row (ADR-0014 §3).

## Consequences

- New public read-only API surface (openapi `listRepositoryIssues`); no migration, no event, no
  node kind. Additive; revert = delete the mount.
- Anonymous budget is per-replica IP; the 502 detail carries the reset time when GitHub sends it.
- Private repos answer as `github_repository_not_found` — "anonymous cannot read this", not a guess.

## Security/privacy

Outbound-only, no token, no user input reaches GitHub except the repo path and label/state params
(path-escaped, query-encoded). Reads public data on behalf of an authenticated viewer; responses
are `no-store`. Fail-closed: no lister configured → 503, never an empty list.

## Verification

`internal/integrations/github/client_test.go`/`client_more_test.go` (httptest: request pinning, PR
filtering, truncation, 403/404/timeout) and `internal/api/github_issues_test.go` (fake lister: auth,
404-hiding, 422, 502 mapping) — all offline. One real anonymous call is recorded with date in
`docs/compatibility/GITHUB.md`.

## Migration/rollback

Follow-up (still W3): attach a `SecretRef`-backed token to the client for private repos and rate
headroom. Triggers/webhooks/`integration.query` arrive with M6's `triggers`/`invocations` tables and
dedupe, as a separate ADR. Rollback: unmount `RegisterGitHubIssues` and drop the openapi path.
