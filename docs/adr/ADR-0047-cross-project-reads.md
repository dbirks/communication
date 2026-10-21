# ADR-0047 — Cross-project reads: `GET /api/v1/runs`, `GET /api/v1/approvals`, `GET /api/v1/conversations` scoped by the caller's memberships

- **Date:** 2026-10-20 · **Status:** Accepted · **Owners:** API maintainer; UI maintainer
- **Evidence:** handler tests `internal/api/crossproject_test.go` (8) and real-PostgreSQL
  store tests `internal/store/postgres/crossproject_test.go` (5) named in § Verification
- **Related:** ADR-0014 (HTTP/problem conventions), ADR-0048 (the org event stream — the
  live-update path this ADR deliberately does not duplicate), ADR-0046 (per-user preferences,
  sibling of this ADR in the app-shell wave); design gap analyses
  `docs/design/handoff-app-shell/gaps/home-board.md`, `gaps/shell.md` §2, `gaps/threads.md`

## Context

The app-shell redesign puts three surfaces at the top level of the app instead of inside a
project tab: **Home** (counts + "running now", across all of the caller's projects),
**Board** (a cross-project runs board with a filterable column view and per-run step
progress), and **Threads** (a cross-project conversation list). The gap analyses found that
none of the three reads exists beyond the project scope: the runs list is
`GET /api/v1/projects/{projectId}/runs`, the approvals list is
`GET /api/v1/projects/{projectId}/approvals`, and conversations are
`GET /api/v1/projects/{projectId}/conversations` (`api/openapi.yaml`, per
`gaps/home-board.md:23` and `gaps/shell.md` §2). The Home/Board pages therefore had no
honest data source, and the only alternatives were polling several per-project calls per
render (N HTTP + N SSE per page load) or faking the numbers — both forbidden by the
spec's "no fake counts" rule and by `communication-spec/09-api-events-data.md:75`
("ensure no event stream leaks inaccessible projects across subscriptions").

The rows themselves already carry everything a cross-project row needs: `runs` has
`project_id`, `approval_requests` has `project_id` and `run_id`, and `conversations` has
`project_id` (`communication-spec/09-api-events-data.md` tables). What is missing is a
**visibility scope larger than one project but still exactly the caller's memberships** —
a scope that no current route expresses.

## Decision

1. **Three new read routes, all session-authenticated GETs** (no CSRF, as on every other
   read), registered in `internal/api/server.go` via `RegisterCrossProject`:

   | route | rows | filters | pagination |
   |---|---|---|---|
   | `GET /api/v1/runs` | `RunSummary` + `project_name`, `pipeline_slug`, `pipeline_display_name`, `steps` | `status` (csv of `RunStatus`), `project_id`, `pipeline_id`, `mine=true`, `updated_since` (RFC 3339) | keyset, `limit` 1–200 (default 50) |
   | `GET /api/v1/approvals` | the existing `Approval` schema | `status` (one of `pending, decided, expired, cancelled, denied`; absent = all) | none (a gate is an action; the count is bounded by the caller's projects) |
   | `GET /api/v1/conversations` | the existing `ConversationSummary` schema | — | keyset, `limit` 1–200 (default 50) |

   No route mutates anything; the journal is untouched; no migration is needed (the
   queries ride the existing `runs_project_created_idx`, the approvals ordering and the
   conversations index). `mine=true` is `triggered_by = the caller` — a child or a system
   start has no `triggered_by` and is never "mine". `updated_since` matches
   `COALESCE(finished_at, created_at) >= value`, the "done today / just created" ask.
   Every bad value (unknown status, malformed uuid/timestamp/limit/cursor) is a `400`
   problem+json **before any store call** (ADR-0014 § 3 shape).

2. **Permission model: the membership predicate in SQL, row by row — the handler is not
   the gate.** Every method of the `CrossProjectStore` interface
   (`internal/api/crossproject.go`) takes the caller's `Caller` and embeds the same
   visibility predicate the project-scoped list routes already use: the caller sees a row
   exactly when the row's project is one they are a member of (or they are the
   organization admin, as on those routes). A project the caller does not belong to
   contributes **no rows and no error** — it does not 404, because these routes are
   org-scoped by definition and naming a non-member project in `project_id` is not an
   error, it is an empty answer. The approvals route additionally applies the same role
   gate the project approvals detail route applies, row by row. This keeps the boundary in
   one place (the store's SQL) so a future transport cannot "fix" the handler and leak;
   it matches `communication-spec/06-collaboration-identity.md`'s model, where
   authorization is evaluated per project the caller holds a role in.

3. **The `steps` projection is one query per page, not one per run.** Each run's steps
   are the **top-level nodes of the run's pinned revision, in definition order**, each
   projected onto the seven step states `pending | running | waiting | succeeded | failed
   | skipped | cancelled`. Definition order and `kind` come from the run's stored
   `plan_snapshot`; states come from the node executions in a single `IN (page ids)`
   statement. A node with several execution rows (a loop) takes the state that most
   needs attention (`failed > running > waiting > cancelled > succeeded > skipped >
   pending`), so the board's segment count is the **step** count, not the execution
   count. Mapping rule (the § state table): ready/leased → `pending` (not visibly
   started), `interrupted` → `failed` (stopped without completing), the rest is the
   identity; anything the node-execution CHECK has not seen defaults to `pending`.
   A run whose plan snapshot does not decode answers with empty `steps` and the row
   still lists — the run row never hides because its projection could not be computed.

4. **Pagination is keyset, shared across the two paginated routes.** Order is
   `(created_at DESC, id DESC)` on both; the cursor is an opaque base64url encoding of
   `(created_at, id)`, produced by `EncodeCrossProjectCursor` and refused
   (`400 invalid_cursor`) in any other shape, so a cursor cannot probe row ids it was
   never handed. The page over-fetches one row to decide `next_cursor`; `next_cursor`
   is `null` exactly when the page holds the last row — the UI's "no more pages" test is
   null, and an empty string would be an unparseable cursor on the next request.
   Approvals has no pagination (decision 1), so the cursor codec is shared by exactly the
   two routes that paginate.

5. **Live updates are the org event stream (ADR-0048), not polling.** These routes are
   the *initial and filtered* reads; the sidebar flags, Home and Board subscribe to
   `GET /api/v1/events` for deltas and refetch a page only after a relevant event. The
   design brief's "don't poll" rule is therefore met without a per-project SSE fan-out
   (the interim in `gaps/home-board.md` line 76).

## Consequences

- The three Home/Board/Threads/Inbox data sources (contract C3 of the app-shell wave)
  exist as honest, membership-scoped reads; the UI must never synthesize a count these
  routes do not answer.
- New public API ⇒ documented in `api/openapi.yaml` (`CrossProjectRunStep`,
  `CrossProjectRunSummary` = `RunSummary` + the four extras, `CrossProjectRunList`,
  `CrossProjectApprovalList`, `CrossProjectConversationList`) and the generated client.
- Read-only: no new journal events, no migration, no new table. The cost is one extra
  statement per page for the steps projection.
- The routes read the *display* names (project name, pipeline slug/display name) on the
  row so a board card needs no second fetch; the vocabulary is the API's (pipeline),
  never the UI wording.

## Alternatives

- **Client-side fan-out** of the existing per-project list routes: N HTTP calls per page
  load, N per-project streams for updates, and no single SQL scope to enforce
  membership; it also cannot answer `mine`/cross-project filters in one query. Rejected.
- **A fourth "board" endpoint** (`GET /api/v1/board/runs`, the gap doc's U1) instead of a
  plain `GET /api/v1/runs`: the filters are exactly the run list's filters, so a separate
  resource would have the same rows under a second name. Rejected — the route is the
  natural unscoped plural.
- **Polling** from the UI: explicitly against the design brief; the org stream exists for
  exactly this (ADR-0048).

## Verification

- `go test -race ./internal/api/... -count=1` — `TestCrossProjectRunListDefaults`,
  `TestCrossProjectRunListFilters`, `TestCrossProjectRunListValidation`,
  `TestCrossProjectRunListNextCursorAndStoreError`, `TestCrossProjectApprovalList`,
  `TestCrossProjectConversationList`, `TestCrossProjectRoutesUnauthenticated`,
  `TestCrossProjectCursorCodec` (`internal/api/crossproject_test.go`).
- Real-PostgreSQL integration, two projects, the caller a member of exactly one (the
  other's rows must not list): `TestCrossProjectRunsVisibility`,
  `TestCrossProjectRunsFiltersAndPagination`, `TestCrossProjectApprovalsVisibility`,
  `TestCrossProjectConversationsVisibility`, plus the state-mapping table test
  `TestCrossProjectStepStateTable` (`internal/store/postgres/crossproject_test.go`).
