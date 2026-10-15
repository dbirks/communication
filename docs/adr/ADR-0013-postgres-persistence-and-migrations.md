# ADR-0013 — PostgreSQL 18 persistence: pgx, embedded forward-only goose migrations, transactional event journal

- **Date:** 2026-10-14
- **Status:** Accepted
- **Owners:** M1 control-plane implementers
- **Related decisions / contracts:** D-003 (Postgres authoritative DB; event history durable), D-002 (`migrate` mode of the one Go binary), `communication-spec/02-system-architecture.md` ("Data / infrastructure plan"), `communication-spec/09-api-events-data.md` ("Durable event envelope", "Database table families"), `communication-spec/11-build-roadmap.md` (M1), ADR-0007 (layout), ADR-0012 (sessions tables)

## Context

D-003 is Accepted: PostgreSQL is the authoritative operational store and event history is durable. `02-system-architecture.md` mandates the shape: "Postgres for domain models … events, scheduler claims, authorization grants and audit data. Add forward-only SQL migrations and backwards-compatible deploy strategy (`expand → deploy → backfill → contract`)", and "application-level sessions in secure HTTP-only cookies" — which, with multiple API replicas, means session and login state must live in the DB (ADR-0012).

`09-api-events-data.md` is explicit about writes: "For each significant state transition: one SQL transaction updates authoritative state, appends event and outbox notification", plus `domain_events (project_id, global_seq)` ordering and the `UNIQUE (issuer, subject)` constraint.

Nothing in the spec names a database driver, a migration tool, or an ORM. M1 needs all three pinned before code depends on them, because these choices are hard to reverse once `00001_m1_core.sql` and the first queries exist:

- **Ordering IDs.** Event replay, `Last-Event-ID` catch-up and cursor pagination (ADR-0014) all depend on a monotonic `global_seq`; the choice of ID generator is a persistence-schema decision under `13-decisions-and-adrs.md`.
- **Deploy-time schema safety.** Replicas roll independently (D-002), so a replica running newer code than the DB must be detectable, not guessed.
- **No schema-library coupling.** IMPLEMENTATION_AGENT_BRIEF rule 5: "Avoid coupling persisted schema directly to `nono`, SDK structs, YAML library or one ACP provider" — an ORM's struct tags are exactly that coupling.

## Options considered

| Option | Advantages | Disadvantages | Evidence |
|---|---|---|---|
| **Postgres 18 + `pgx/v5` + `goose/v3` with embedded SQL, forward-only (chosen)** | `uuidv7()` is native in PG 18, so ID generation needs no application logic or extension; pgx is a pure-Go driver exposing native `pgtype`, usable as a pool without a query layer; goose migrations are plain SQL files compiled into the binary via `go:embed`, so `communication migrate up` needs no external binary and the schema under test equals the schema shipped | Two pinned dependencies to keep current; goose embeds an indirect graph (multi-driver support) that must be watched in the license/dependency gate; no down-migrations by policy — recovery is a new forward migration | `postgres:18.6` observed in the lab, `select uuidv7();` → `01a13ce3-afed-783d-890c-92039ec0cdc7` (2026-10-14); https://www.postgresql.org/docs/18/functions-uuid.html (fetched 2026-10-14) |
| golang-migrate | Widely used, same forward-only capability, `iofs` embedding supported | Its CLI/multi-source story and lock table behave differently under concurrent startup; no readiness-oriented "current version" API that we would use anyway (we query `schema_version` ourselves) | Compared; equivalent-in-kind, so driver/tool choice is what matters — rejected for no net gain over goose |
| Atlas (declarative schema + generated migrations) | Drift detection, plan/apply UX, nice for multi-env | Introduces a second source of truth (HCL/SQL desired state) alongside hand-written migrations, and a desired-state engine between us and `expand → deploy → backfill → contract`; generated plans can drop columns silently under time pressure | Compared; rejected as heavier process than the spec's simple forward-only rule |
| An ORM (GORM or ent) as the schema owner | Model structs and migrations in one place; less SQL for CRUD | Rejected: makes generated library code the definition of the persisted schema (IMPLEMENTATION_AGENT_BRIEF rule 5), hides the single-transaction state+event+outbox write and the `pg_notify` trigger behind hooks, and entangles `domain/` types with library structs (AGENTS.md dependency rule) | Compared; rejected on spec grounds, not performance |

## Decision

1. **Database: PostgreSQL 18**, image `postgres:18`, no extensions required. Primary keys are `uuid` columns defaulting to the native `uuidv7()`; timestamps are `timestamptz`; JSON payloads are `jsonb`. UUIDs are exposed in JSON as strings.
2. **Driver/pool: `github.com/jackc/pgx/v5 v5.11.0`**, one `pgxpool.Pool` per process, used from `internal/store/postgres`. No SQL builder, no ORM; queries are hand-written in that package. `internal/domain` stays free of pgx types (AGENTS.md dependency rule).
3. **Migrations: `github.com/pressly/goose/v3 v3.29.0`**, driven by plain SQL files under `internal/store/postgres/migrations/*.sql` embedded into the binary (`go:embed`) and run through `communication migrate up|status` (D-002). Migrations are **forward-only**: no `-- +goose Down` sections are relied upon, and recovery from a bad change is a new migration.
4. **First migration `00001_m1_core.sql`** creates the M1 tables named in `09-api-events-data.md`: `organizations` (seeded with slug `default`), `users`, `oidc_identities` with `UNIQUE(issuer,subject)`, `sessions`, `oidc_login_states` (ADR-0012), `projects`, `memberships` (role CHECK `maintainer|contributor|viewer`), `repositories`, `domain_events` (`global_seq bigint GENERATED ALWAYS AS IDENTITY` + `event_id uuidv7()` + `payload jsonb`, index `(project_id, global_seq)`, `actor_kind` CHECK), an `AFTER INSERT` trigger issuing `pg_notify('communication_events', NEW.global_seq::text)`, `outbox` (fk to `domain_events.global_seq`), `audit_events` (`outcome` CHECK `allowed|denied`) and `workers` (`status` CHECK `online|draining|offline`).
5. **Writes are one transaction:** every state change commits authoritative rows + a `domain_events` row + an `outbox` row together (`09`), so a replica can never publish an event it did not persist, and the outbox can never reference a missing event. `pg_notify` is only a wake-up hint; readers re-query by `global_seq` (ADR-0014).
6. **Readiness reports schema version:** `GET /api/v1/system/readiness` returns `{status, schema_version, expected_schema_version}` and **503** when the DB is unreachable or its version is behind what the binary expects (`02`'s expand→deploy→backfill→contract), so a load balancer drains a replica whose migration has not been applied rather than serving it.

## Consequences

- Positive: one binary carries the schema; a fresh clone needs only Postgres to get an identical database; `goose`'s version table plus the readiness probe make "the DB is behind the code" an explicit, observable state instead of a 500 storm.
- Positive: native `uuidv7()` gives time-ordered, index-friendly IDs with zero application-side generation and no clock coordination.
- Limitation: forward-only means rollback = write-forward; a migration that must be abandoned needs a compensating migration, and tests must exercise the *up* path from an empty database.
- Limitation: `pg_notify` payloads are best-effort and are lost across reconnects — correctness therefore depends on sequence-based re-querying, and a very high event rate makes the wake-up + re-query loop the thing to measure (D-012 stays *Proposed*).
- Limitation: no row-level security yet; `06` suggests RLS as defense-in-depth *after* query scoping, which M1 defers. Storage of multi-MB logs in rows stays prohibited (`02`), so payloads must stay small references.
- Ops: one Postgres remains a single failure domain (`02` "Service availability scope") and this ADR changes none of that.

## Security/privacy

- `sessions.token_hash` stores sha256 of the cookie token, never the token (ADR-0012); `oidc_login_states` holds short-lived PKCE verifiers/nonces and is single-use.
- Every sensitive query carries a project permission predicate — never a client-controlled header (`09` "Constraints / indexes to prioritize"); authz denials land in `audit_events` with `outcome='denied'`.
- CHECK constraints on roles, actor kinds and audit outcomes are the last line of defense, not the first; application validation runs in `internal/domain`.
- `payload jsonb` and `audit_events.detail` must never contain prompts or raw secrets (`05`/`06`); `secret.materialized`-style events carry metadata references only.
- The connection string (`COMMUNICATION_DATABASE_URL`) is environment-provided and never committed; Postgres is not published to the host in the local compose topology.

## Verification

Observed on 2026-10-14 in the lab (`communication-lab-pg`, image `postgres:18.6`):

```
$ docker exec communication-lab-pg psql -U lab -d lab -tAc 'select version();'
PostgreSQL 18.6 (Debian 18.6-1.pgdg13+2) on x86_64-pc-linux-gnu, compiled by gcc (14.2.0-19) 14.2.0, 64-bit
$ docker exec communication-lab-pg psql -U lab -d lab -tAc 'select uuidv7();'
01a13ce3-afed-783d-890c-92039ec0cdc7
```

`github.com/jackc/pgx/v5 v5.11.0` and `github.com/pressly/goose/v3 v3.29.0` are the versions resolved in `go.mod` at the time of writing (added by the M1 store task); no migration files or queries exist yet.

Gates before M1 is called done (`12-test-strategy.md`): (a) `communication migrate up` against an empty database, then `migrate status` reporting the same version as `expected_schema_version`; (b) readiness returning **503** with `schema_version < expected_schema_version` after applying only `00001`, and 200 once the next migration is applied — proving the expand/deploy ordering; (c) an atomicity test that rolls back a state change and observes no `domain_events`/`outbox` rows; (d) two replicas reading an identical `global_seq` series after writes through either; (e) `pg_notify` reconnect/re-query test showing no lost event is visible to a client after a dropped connection.

## Migration/rollback

Upgrade: apply new migrations before deploying binaries that need them (`migrate up`, then roll replicas); readiness makes the window visible. Each migration is additive in the expand→contract style — new columns/tables first, backfill, then contract in a later release.

Rollback: never downgrade the schema. Roll the *binary* back to a version whose `expected_schema_version` is ≤ the deployed one; if that is impossible, ship a compensating forward migration. Replacing goose later means adopting its `goose_db_version` rows (or rewriting them once) under a new ADR — the schema itself stays portable because it is plain SQL. Swapping pgx is contained by `internal/store/postgres`; nothing in `internal/domain` may reference driver types.
