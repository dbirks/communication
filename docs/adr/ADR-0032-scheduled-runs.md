# ADR-0032 — Scheduled runs: assignment-owned schedules, cron in UTC, idempotent fires

- **Date:** 2026-06-19 · **Status:** Accepted · **Owners:** control-plane contributors
- **Related:** ADR-0013 (goose), ADR-0014 (envelope), ADR-0023 (runs, idempotency keys), ADR-0031 (M6);
  `communication-spec/07`'s "cron-like schedule" trigger, `11-build-roadmap.md` M6, `01-domain-model.md`
  (assignment ACL), `docs/design/wishlist-gap.md` § W5

## Context

The product owner's ask (W5): "a security workflow that runs on a schedule". Nothing creates runs on a
clock today — every run comes from a user or a parent node, and the only Go tickers (reconciler, M4
driver) advance runs that already exist. A schedule is a new persistence object *and* a new writer of
runs, so ownership, syntax, and what happens when two replicas tick or one ticks late had to be pinned first.

## Options considered

| Option | Advantages | Disadvantages | Evidence |
|---|---|---|---|
| A: cron in the pipeline YAML | declared where the pipeline is | revisions are immutable, so editing a schedule means publishing one | `07` scopes triggers per project assignment |
| B (chosen): a schedule owned by a project ASSIGNMENT, firing its pinned revision with fixed inputs | reuses route 22's create path verbatim; the assignment ACL is already the scope; `runs.triggered_by` is already NULL for a system start | inputs are config, not a template; one more table | `m4api_runs_write.go` route 22 |
| C: external cron hitting `POST /runs`, or a cron library | zero new code / names, `@daily`, DST | outside the product (no UI, no audit, per-project credentials) or a new dependency in the process that inserts runs | W5's status line; `AGENTS.md` forbids the dependency |

## Decision

1. **Table** `schedules (id, project_id, assignment_id, cron_expr, inputs jsonb, enabled, next_run_at,
   last_run_at, last_run_id, version, created_by, created_at, updated_at)` in `00006_m6_schedules.sql`, with
   composite FK `(assignment_id, project_id) → assignments (id, project_id)` (no firing another project's
   assignment) and `(next_run_at) WHERE enabled` — a disabled schedule is never due.
2. **Syntax**: 5-field cron (minute hour dom month dow), always UTC, parsed by `internal/pipelines/schedule`
   (~200 in-repo lines, no dependency): `*`, lists, ranges, `*/n`, `a-b/n`; dow 0-7, 7 folded to Sunday; when
   BOTH day fields are restricted the day matches on EITHER (Vixie's rule). **Refused by Parse:** seconds and
   year fields, month/weekday NAMES, `?`, `L`, `W`, `#`, `H`, wrapped ranges (`22-2`), a step on a single value
   (`5/10`). No DST — a fire is UTC wall clock.
3. **Firing** inserts the run through the SAME path a manual createRun uses — `APIRunStore.createRunPinned`
   over `RunStore.CreateRun`'s statements — so run, `run_inputs`, key and `run.created` commit together,
   pinned to the assignment's revision and digests, `triggered_by = NULL`. No schedule-specific insert.
4. **No double-fire.** Idempotency key `schedule-<id>-<fired slot as 20060102T150405Z>` — a dash rather
   than the sketch's colon because `run_idempotency_keys.key` is CHECKed `^[A-Za-z0-9._-]{1,128}$`. Two
   ticks reaching the create for one slot get one run (`created=false` for the loser); and `TickSchedules`
   claims due rows `FOR UPDATE SKIP LOCKED` (`turns.go`/`m4driver.go`'s idiom) and holds the row across the
   create, so a wedged replica neither waits, fires, nor leaves a gap the key would not close.
5. **Missed fires**: fire ONCE for the LATEST missed slot, never backfill; skipped slots count into
   `schedule.fired`'s `late_fire_count` and `next_run_at` advances to the first slot strictly after `now`. A
   fire refused by the assignment's `max_concurrent_runs` ceiling (counted from rows, route 22's predicate)
   or a disabled assignment does NOT consume the slot — it stays due and fires late once it can, where this
   rule collapses the backlog into one run. Re-enabling re-derives the clock from `now`.
6. **Tick placement**: `ScheduleStore.TickSchedules(ctx, now)`, capped at 100 rows per pass, on serve
   replicas; part 2 wires it beside the M4 driver's `Run` loop on its own ticker. No advisory lock — the row
   claim is the mutex, so replicas fire different schedules in parallel. `version` counts config edits only:
   a fire never bumps it, so an edit racing a fire is never a false 409.
7. **Event**: `schedule.fired` (registered in `internal/events`) carries project_id, schedule_id,
   assignment_id, run_id, cron_expr, scheduled_for, late_fire_count — never input values, which live on the
   run's `run_inputs`. Appended in the advance transaction, correlated via `domain_events.run_id`.

## Consequences and security

Runs gain a third creator with no new run shape; until part 2's routes land the table is inert outside tests.
The dedupe window is the keys table's 24 h TTL (ADR-0023 § 12's sweep), so a slot re-presented more than a day
late could create a second run — rule 5's re-enable semantics keep that unreachable, and UTC-only fire times
read oddly in DST until a timezone column gets its own ADR. Fires act as `system` with the pinned revision and
the schedule's fixed inputs: no caller elevation, no secret entry point (inputs are validated against the
revision's `spec.inputs` at Create/Update), cross-project firing structural rather than checked, and routes on
the assignment's existing maintainer-or-admin rule (`01`). Fail-closed: a row that cannot be read or pinned
fires nothing and logs why.

## Verification

`go test ./internal/pipelines/schedule/` — parse/Next tables (strictly-after, 7→Sunday fold, Vixie OR rule,
Feb-30 → zero) plus a 400-fire invariant scan. `go test ./internal/store/postgres -run Schedule` on real
PostgreSQL — one due schedule fires exactly one run (pinned revision, NULL `triggered_by`, `run.created` and
`schedule.fired` correlated); a row locked elsewhere is skipped not waited for and fires when the lock clears;
4 concurrent ticks over 4 schedules = 4 runs; a disabled schedule or assignment never fires; 5 missed daily
slots = 1 run with `late_fire_count = 5`; the ceiling defers a slot until capacity frees; and 00006's FK,
partial index and CHECKs are asserted by behaviour rather than goose's version number.

## Migration/rollback

`communication migrate` applies 00006 (additive: one table, two indexes, one supporting `assignments (id,
project_id)` UNIQUE); `migrate down` drops them. No pre-M6 row is rewritten, and with the tick unwired nothing
depends on the table. Input templates, if ever wanted, are a new entity rather than an edit to this one.
