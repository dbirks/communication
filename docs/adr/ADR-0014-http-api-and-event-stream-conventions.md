# ADR-0014 — HTTP API and event stream conventions: `/api/v1`, problem+json, SSE from `global_seq`

- **Date:** 2026-10-14
- **Status:** Accepted for M1 conventions. D-012 (REST + SSE) stays **Proposed** in the register until streaming volume is measured; this ADR does not promote it.
- **Owners:** M1 control-plane implementers
- **Related decisions / contracts:** D-003, D-010, D-012 (REST + SSE + transactional outbox — Proposed), `communication-spec/09-api-events-data.md` ("HTTP APIs (suggested)", "Durable event envelope", "Event streaming to browser"), `communication-spec/02-system-architecture.md` (Observability, scheduling), `communication-spec/06-collaboration-identity.md` (authz at every boundary, SSE edge cases), ADR-0013 (event journal, outbox, `pg_notify`)

## Context

`09-api-events-data.md` fixes the outline — versioned `/api/v1` JSON, project/org-scoped authorization, problem+json-compatible errors, `Idempotency-Key` on work-creating operations, `etag/version` on resources — and recommends SSE for append-only browser streams reconnecting from "monotonically increasing durable `global_seq` / `Last-Event-ID`" with catch-up from the DB. `06` requires authorization to be checked for SSE subscriptions too, and defines the "user removed from project while observing an SSE stream" edge case. `02` names OpenTelemetry-style trace correlation across replicas.

M1 must pin the concrete conventions before two replicas, a UI and an event journal exist, because these are public-API-contract decisions under `13-decisions-and-adrs.md`: routing style, error shape, 404-vs-403 semantics, stream identity and replay key. Everything here is observable from a browser and hard to change later.

## Options considered

| Option | Advantages | Disadvantages | Evidence |
|---|---|---|---|
| **stdlib `net/http.ServeMux` method patterns + SSE (chosen)** | Zero routing dependency (no new module in the license/dependency gate); method+path patterns (`GET /api/v1/projects/{projectId}/repos`) are native since Go 1.22 and this module builds on `go 1.27.2`; SSE is plain HTTP/1.1 or/2 responses the browser reconnects automatically, replay keyed by a durable DB sequence, so any replica can serve any reconnect | No middleware ecosystem, so auth/CSRF/replica headers are hand-rolled; SSE is server→client only — future bidirectional features need a separate channel | `go.mod` (`go 1.27.2`); https://pkg.go.dev/net/http#ServeMux; `09` "Event streaming to browser" |
| WebSocket per project | Bidirectional, single connection | Rejected for M1: `09` says "Add WebSocket only for features truly requiring bidirectional low-latency channel"; loses HTTP caching/proxy friendliness, needs its own auth/CSRF/reconnect+resume story, and duplicates what the durable journal already provides | Compared; may return in M2 for live prompting |
| gRPC / gRPC-web to the browser | Typed contracts, streaming built in | Rejected: browser needs a proxy or connect-web translation layer, breaks plain cookies/CSRF semantics, and the spec's public surface is JSON resources (`09` table) | Compared; not chosen |
| Client polling of `GET /projects/{id}/events?after=seq` | Simplest possible server; identical replay semantics to SSE resume | Rejected for M1 UI liveness: latency proportional to interval and request volume per open tab multiplies by replicas; SSE is the same query plus a push hint | Compared; remains the fallback if D-012 volume measurement condemns SSE |

## Decision

1. **Surface:** all resources under `/api/v1`, JSON; `/auth/*` (login, callback, logout) is the only non-versioned surface. Routing uses `http.ServeMux` method patterns — no third-party router.
2. **Errors** are `application/problem+json` objects `{type, title, status, detail}` (`09` "adopt problem+json-compatible errors") for every non-2xx, including auth failures (401), CSRF/origin rejection (403), duplicate slug/name (409).
3. **Non-members get 404, not 403,** for any project-scoped route they cannot see (org admins see all), and each such denial writes an `audit_events` row with `outcome='denied'`. Existence of a project is itself project-scoped information (`06`: "Project-scoped identity claims cannot be trusted just because an ID is present in a URL").
4. **Authorization is applied in middleware before handlers**, per project, using `internal/authz` pure policy functions; role rules: maintainer = everything in M1, contributor/viewer = read. Mutations additionally require a valid session **and** `X-CSRF-Token` matching the session, with the `Origin` check from ADR-0012 — including for SSE subscriptions, which are authorized at connect time (`06`).
5. **Event stream:** `GET /api/v1/projects/{projectId}/events` returns `text/event-stream`; each event carries `id: <global_seq>`, `event: <type>`, `data: <envelope JSON>` using `09`'s durable envelope (`event_id, global_seq, type, schema_version, occurred_at, organization_id, project_id?, conversation_id?, actor{kind,id}, trace_id?, payload`). On connect the server replays rows with `global_seq >` `Last-Event-ID` (or `?after=<seq>`), then streams new ones; a comment heartbeat every 15 s keeps proxies from closing idle streams. A user removed from the project stops receiving events (`06` edge case).
6. **`LISTEN`/`NOTIFY` is only a wake-up hint** (`02`, ADR-0013): on `communication_events` the server re-queries `domain_events` by `global_seq`. No event is ever delivered from a notification payload, so a lost or duplicated notify cannot make the stream wrong.
7. **Replica observability:** every response carries `X-Communication-Replica` (`COMMUNICATION_REPLICA_NAME`, default hostname), and `/api/v1/system/health` reports `{status, replica, version}` while `/api/v1/system/readiness` reports schema version per ADR-0013 — this is how M1's two-replica consistency demo is proven from a browser rather than asserted.
8. **Versioning:** JSON resources expose `version` (projects today) for optimistic concurrency; M1 does not yet honour `Idempotency-Key` or `If-Match` — see Consequences.
9. **Stream consistency (no gaps under concurrent commits).** `domain_events.global_seq` is a `bigint GENERATED ALWAYS AS IDENTITY`, so a sequence value is consumed at INSERT time and two transactions can commit in the opposite order to the one in which they consumed values. A reader that remembers "the highest `global_seq` I have sent" and asks for rows above it would then skip the late committer *forever and silently* — the `pg_notify` wake-up says nothing about order (§6). Two mechanisms close this, and both are load-bearing:
    * **Reader side — `tx_id` + snapshot visibility (migration `00002_event_order_guarantee.sql`).** Every journal row records its inserting transaction (`tx_id xid8 NOT NULL DEFAULT pg_current_xact_id()`), and the stream query emits only rows that were already *determined* when its own snapshot was taken:

      ```sql
      WHERE e.project_id = $1 AND e.global_seq > $2
        AND e.tx_id < pg_snapshot_xmin(pg_current_snapshot())
      ORDER BY e.global_seq LIMIT $3
      ```

      A transaction id below the snapshot's `xmin` has committed or aborted, so no row it holds can appear later. The comparison works because XIDs are assigned in the order transactions first write, and a row's XID must exist before it can consume a sequence value: if row `N` is still in flight then `tx_id(N) < tx_id(N+1)` and `xmin <= tx_id(N)`, so `N+1` fails the filter too and is *withheld* rather than emitted ahead of its predecessor. The wake-up loop re-queries with a fresh snapshot (and unconditionally at the poll interval), so once `N` settles both rows are delivered together, in order — `N+1` is delayed by one poll interval, `N` is never skipped. (A long-running transaction elsewhere holds `xmin` back and stretches that delay; see Consequences.)
    * **Writer side — per-project append lock.** `postgres.AppendEvent` takes `pg_advisory_xact_lock(hashtextextended('communication.domain_events.append/' || <project>, 0))` before it inserts, so within one project a transaction cannot consume a sequence value until every smaller one has committed or aborted: commit order cannot disagree with sequence order for a project. The reader-side filter above is what makes that invariant unbreakable by a writer that bypasses `AppendEvent` (a future path, an operator statement); the filter alone is what makes a *foreign* long transaction visible as latency rather than as a hole.

    Streams are still authorized on the delivery path and at every heartbeat, so a revoked member stops at the next check rather than at the next reconnect (§4, `06`).

## Consequences

- Positive: no new Go dependency for routing or streaming; replay semantics are identical whether the client reconnects to the same replica or another one, which is exactly the property M1's exit gate demonstrates; the `X-Communication-Replica` header plus durable `global_seq` makes "which replica lied" answerable in the field.
- Positive: because the journal is the only delivery source, streaming can be replayed, rate-limited, or replaced by polling without changing what clients store.
- Limitation: SSE is one-way; prompting and control-plane interaction stay ordinary POSTs, and a bidirectional need (M2) requires revisiting this ADR or `09`'s WebSocket allowance.
- Limitation (D-012 stays Proposed): the design assumes per-project streams and a wake-up + re-query loop. High-frequency token deltas and many concurrent viewers are **unmeasured**; `09` anticipates worker-side batching/coalescing, and if measurements are poor the polling or batching alternative replaces this without a data-model change.
- Limitation: the `tx_id < pg_snapshot_xmin(pg_current_snapshot())` filter is deliberately conservative — it is bounded by the *oldest* write transaction in the database, not by the project being streamed. A long-running transaction (a bulk migration, an abandoned `BEGIN`) therefore delays event delivery on every stream until it finishes; nothing is lost, and the delay is not unbounded once it ends. M1's writers are all short single-row transactions, so this is invisible today. If a later milestone needs delivery latency independent of other workloads, the precise alternative is to use the per-project append lock as the ordering proof (a free project append lock means nothing is in flight, so the naive read is safe) instead of the global snapshot floor — that trades a lock probe per read for the current zero-lock read. It is a tuning change to this endpoint, not a wire change.
- Limitation: `AppendEvent`'s per-project advisory lock is held to COMMIT, so journal appends for one project are serialized. At M1's write rate that is a non-issue (and it is what makes a project's commit order match its sequence order), but a project with many concurrent writers would need batching or a per-project sequence allocated under the lock. A transaction must append to only one project; a transaction appending to two projects in a different order could deadlock, and M1 has no such path (`09`: one state change, one event, one outbox row per transaction).
- Limitation: `Idempotency-Key` and conditional updates (`If-Match`/etag) are specified in `09` but not implemented in M1; M1's only mutations are project and repository creation, so a duplicate request surfaces as 409 rather than a replayed success. They must land with run/conversation creation (M2/M4) before retries are advertised as safe.
- Operational: SSE connections are long-lived and unpooled across replicas; a rolling restart drops them and clients reconnect via `Last-Event-ID`, so reconnection must be exercised, not assumed.

## Security/privacy

- Streams never cross project boundaries: the `global_seq` cursor is resolved *through* a project-scoped query (`WHERE project_id = $1 AND global_seq > $2`), so a forged `Last-Event-ID` from another project replays nothing it should not — and nothing inaccessible (`09`: "Ensure no event stream leaks inaccessible projects across subscriptions").
- Fail-closed: unauthorized or unsubstantiated subscriptions are refused at connect time; authorization failures on an open stream terminate delivery.
- SSE inherits the cookie/CSRF posture of ADR-0012 (SameSite=Lax, `Secure` by default, origin check for mutations); GET streams are read-only, and CSRF is irrelevant to them by design.
- `payload` and `audit_events.detail` must not carry prompts or raw secrets (ADR-0013); `trace_id` propagates correlation without embedding sensitive values in metric labels (`02` Observability).
- `X-Communication-Replica` exposes an internal hostname by default — acceptable for a self-hosted control plane, documented, and removable if it ever faces untrusted clients.

## Verification

Gates (record literal output in the M1 acceptance run; `12-test-strategy.md` rows). At the time this ADR was written the API server did not exist, so none of these were claimed; gates 1, 2, 2a, 4 and 5 are now observed in the M1 acceptance run (scripted two-replica HTTP run + `internal/api` / `internal/store/postgres` suites) and the observed evidence is recorded there, not here:

1. Via the load balancer (`:8080`) with replicas on `:8081`/`:8082`: create a project and two repositories through replica A, then read them through replica B — same `global_seq` values, same JSON (M1 exit).
2. SSE replay: open a stream with `Last-Event-ID` set behind the current sequence and observe the missed events delivered before live ones; disconnect one replica mid-stream and observe the client resuming against the other with no gap and no duplicate visible to the UI.
2a. Gap-safety (§9): commit `global_seq` N+1 while the transaction holding N is still open, and show (a) the naive `global_seq > cursor` read returns N+1 and would have lost N, (b) the stream read returns nothing until N settles, then both in order — `internal/store/postgres/events_test.go` `TestEventsAfterDeliversLateCommitterInOrder`, run against a real PostgreSQL 18. The writer-side half is `TestAppendEventSerializesAppendsPerProject`; the column's existence, type and default are asserted by `TestMigration0002EventOrdering`.
3. `kill` the Postgres connection or stop `oidc`/replica and confirm readiness flips to 503 while health stays 200, and that LB drains the replica.
4. Non-member access to `/api/v1/projects/{id}` and `/projects/{id}/repos` yields 404 (never 403, no existence leak) **and** an `audit_events` row with `outcome='denied'`.
5. Error shape check: every non-2xx is `application/problem+json` with the four members.
6. D-012 measurement: record events/sec, DB re-queries per notification and connection counts under a scripted fan-out (the numbers that decide whether D-012 can be promoted or replaced by polling/batching).

## Migration/rollback

`/api/v1` is the version prefix: incompatible resource changes go to `/api/v2` with the old surface kept until the UI stops using it; additive JSON fields are not a version bump. Dropping `X-Communication-Replica` or changing the SSE `id` semantics would be breaking and needs a new ADR.

Rolling back routing (e.g. adopting a router) is internal and does not change the wire contract. If D-012 measurement condemns SSE, clients switch to `?after=<seq>` polling of the same endpoint — the journal and cursor semantics are unchanged, so the rollback is a delivery-mechanism change, not a data-model one. Bidirectional transport, if ever added, is a new ADR against `09`.
