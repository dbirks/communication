# ADR-0048 — Org-level event stream: `GET /api/v1/events` multiplexes the journal across the caller's projects

- **Date:** 2026-10-20
- **Status:** Accepted
- **Owners:** backend (be-org-events)
- **Related decisions / contracts:** ADR-0014 (durable journal, SSE contract), ADR-0016 (conversation scope), `api/openapi.yaml` `streamOrgEvents`, C4 of the app-shell redesign handoff (`docs/design/handoff-app-shell/README.md`)

## Context

The app-shell redesign (Six Directions, step 1) moves the product into a
permanent sidebar whose cross-project flags and counts must be **live**: the
brief says "sidebar flags live from the existing event stream — don't poll"
(`docs/design/handoff-app-shell/gaps/shell.md` §1). Today there is exactly one
stream, and it is project-scoped:
`GET /api/v1/projects/{projectId}/events` (`internal/api/events.go`,
`useProjectEvents` in `ui/src/api/events.ts`). A browser that is not inside a
project — the shell, Home, the board — has no stream to read, so the shell
would have to poll (forbidden by the brief) or hold no live state.

The journal already makes this cheap: one table (`domain_events`), one
monotonic `global_seq` shared by every project (migration 00002, ADR-0014 §9),
one `LISTEN communication_events` wake-up channel. The project stream is
`evtJournalSQL` filtered by `project_id`; the org stream is the same read
widened to every project the caller may see.

Spec support: `communication-spec/09-api-events-data.md` recommends SSE for
append-only events, defines the durable envelope (D23 ff.) and requires that
"no event stream leaks inaccessible projects across subscriptions" (line 75);
`02-system-architecture.md` line 56 fixes the replay contract — "SSE consumers
reconnect with `Last-Event-ID` and replay from durable sequence; LISTEN/NOTIFY
is only a wake-up optimization".

## Options considered

| Option | Advantages | Disadvantages | Evidence |
|---|---|---|---|
| A. One widened store read (`OrgEventsAfter`), one multiplexing handler, same envelope/heartbeat/resume as the project stream | No new cursor; the existing `global_seq` is already global; one query per batch (no N+1 over projects); every client property the project stream proves is inherited by construction | A member of many projects sees one combined timeline; a project the caller stops seeing drops out of the stream (documented §3) | `internal/api/org_events.go`, `internal/store/postgres/events.go` `orgEventsSQL` |
| B. Client-side fan-out: the browser opens one project stream per project | Zero new backend | One socket per project (the shell has no project id to open first); N connections, N heartbeats, a per-project `global_seq` floor that cannot dedupe the union; membership churn means open/close storms; the brief says don't poll — this is poll-shaped | gap analysis `gaps/shell.md` §2 |
| C. A second journal table / per-project sequences, unioned in SQL | Isolated sequences per project | A second cursor, a second gap-safety argument, and a broken cross-project resume (a union of per-project sequences is not a total order); amends the journal contract ADR-0014 §9 spent its gap proof on | rejected |

## Decision

**A.** `GET /api/v1/events` (SSE, `operationId: streamOrgEvents`) serves the
same frame contract the project stream serves — `id: <global_seq>`,
`event: <type>`, `data: <envelope JSON>`, 15 s `: heartbeat`, replay from
`Last-Event-ID` (winning over `?after=`) — with the journal read widened from
one project to **every project the caller may see**: a membership in the
caller's organization, or every project of the organization for an org admin
(the exact visibility `prjProjectSelect` implements). The permission predicate
lives in the SQL (`orgEventsSQL`), per house style.

The **cursor is the existing journal-global `global_seq`** — no new cursor
design was needed: the project stream already stamps `id:` with the global
sequence (not a per-project one), so a resume header the browser returns
replays exactly the rows above it across all projects. Sequences of rows the
caller may not see are simply absent from the batch the store returns;
because the stream's cursor advances on **delivered** rows only, skipping an
invisible row costs neither a gap nor a duplicate, and a later resume over it
replays nothing wrong.

## Consequences

- **Positive.** The shell gets one live feed for every project it can see;
  the per-project project stream is unchanged and remains a superset for
  single-project screens; resume survives replica restarts exactly as before
  (durable `global_seq`, wake-up-only LISTEN per ADR-0014 §6).
- **Limitation 1 — membership is evaluated at connect and on resume, and
  re-checked by every query.** The predicate runs inside each batch read, so
  a membership granted or revoked while the stream is open takes effect on
  the next query (≤ one poll interval after the change commits). What is
  *not* provided: replaying, on a mid-stream membership **grant**, the
  project's history below the caller's current cursor. A user who becomes a
  member of a project only sees events from the grant onward; their next
  (re)connect without `Last-Event-ID` resumes from the journal head, as the
  project stream does.
- **Limitation 2 — project-less rows are out of scope.** Rows with
  `project_id IS NULL` (organization-scoped events) are filtered out: the
  stream carries project events only, and C4's consumers key on
  `project_id`. Org-scoped streaming is a later extension point, not a gap
  today.
- **Limitation 3 — backpressure is the TCP buffer, as on the project stream.**
  A slow reader holding one combined stream (instead of one per project)
  backpressures the combined feed; the handler never queues beyond the
  server's write buffer and ends the stream when a write fails.

## Security/privacy

- Fail-closed: the visibility predicate is a SQL join on
  `memberships`/`projects` scoped by the caller's `organization_id`, so an
  invisible project's rows are absent from every batch — no existence leak,
  no cross-organization leak (both asserted in
  `TestOrgEventsAfterRestrictsToVisibleProjects`).
- The route names no resource: a caller with zero projects gets an open,
  quiet stream (200 + heartbeats), never a 404, so the endpoint cannot be
  used to probe anything.
- Malformed cursors are refused with 422 problem+json before the response
  becomes a stream, exactly as the project stream does (ADR-0014 §5).
- No payload content changes; envelopes carry no secrets (the field-name and
  secret-scan invariants ADR-0017..0020 pin apply unchanged, since this is the
  same stored JSON).

## Verification

- `internal/api/org_events_test.go` (handler, fake journal): two projects,
  member of one — only that project's rows arrive, on connect and live;
  resume after `Last-Event-ID` replays exactly the tail; mid-stream
  revocation skips the withheld row without ending the stream; a caller with
  no visible projects gets 200 + heartbeat; bad cursor → 422; anonymous →
  401; journal error ends the stream.
- `internal/store/postgres/events_test.go`
  `TestOrgEventsAfterRestrictsToVisibleProjects` (real PostgreSQL):
  member-only visibility per project, org-admin sees both in global order,
  project-less rows excluded, resume cursor orders the multiplexed rows,
  another organization sees nothing.
- `ui/src/api/events.test.tsx` `useOrgEvents`: opens `/api/v1/events`,
  multiplexes types from two projects into `onEvent` with the envelope's
  `project_id`, and reconnects with `?after=<last global_seq>`.
- Wire contract in `api/openapi.yaml` (`streamOrgEvents`); the UI client
  types are regenerated from it.

## Migration/rollback

Additive: one new route, one new store read, one new client hook. Reverting
removes `RegisterOrgEvents` from `cmd/communication/serve.go` and the OpenAPI
path; no schema change, no migration, no state to migrate.
