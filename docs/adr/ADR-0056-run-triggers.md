# ADR-0056 — Run triggers, part 1: how a run was started (manual / schedule / issue / thread)

- **Date:** 2026-10-22
- **Status:** Accepted (part 1: trigger recording + the run-list filter; the issue-polling fire itself is part 2 and is specified here, not implemented here)
- **Owners:** control-plane API + scheduler maintainers
- **Related decisions / contracts:** ADR-0013 (forward-only migrations), ADR-0014 (§3 invisible resource / uniform 404), ADR-0023 (§12 idempotency keys, §5 run shape), ADR-0031 (GitHub issue listing is read-only, not a trigger), ADR-0032 (schedules, cron UTC, `schedule-<id>-<slot>` idempotency key), ADR-0047 (§5 cross-project runs list), ADR-0053 (`RunCreate.source`, `runs.source_conversation_id`), design handoff `docs/design/handoff-app-shell/gaps/home-board.md` §2/§4/§5/§9 (the Board's `from issues` / `scheduled` chips and the drawer card's "from issue #512" meta), `communication-spec/07` (GitHub integration), `communication-spec/12` (test layers)

## Context

The app-shell redesign (artboards 2d/3c, PO handoff) asks every run to say **how it was
started**: the Board's filter chips **from issues / scheduled**, the drawer card's meta
**from issue #512**, the Home briefing's running rows. Today the only record is
`runs.triggered_by` (a nullable user — ADR-0023 §5; NULL for system/child starts) and the
schedule table's `last_run_id` (ADR-0032 §5) — which names a run but not why it fired, and
keeps no per-trigger cursor. Nothing distinguishes a manual start, a schedule fire, a thread
handoff or an issue start, so the chips have no data behind them and the drawer has nothing
honest to render for "from issue #512".

Schedules already fire today (`internal/store/postgres/schedules.go` `TickSchedules` →
`fireSchedule`, keyed `schedule-<scheduleId>-<slot>` in `run_idempotency_keys`, ADR-0032 §4);
the fire writes through the same create path as a manual `POST /runs` (`APIRunStore.createRunPinned`)
and stamps `triggered_by = NULL` (a system start). What is missing is exactly the
`trigger_kind`/`trigger_ref` pair that names the trigger.

Issue triggering does not exist yet (ADR-0031 keeps the issues listing read-only and explicitly
not a trigger; the M6 tables and dedupe the PO deferred are now the `issue_triggers` table of
this ADR's migration). This ADR therefore fixes the vocabulary and the recording contract
first; the GitHub poll that turns an `issue_triggers` row into a run is designed here and lands
as part 2.

## Options considered

| Option | Advantages | Disadvantages | Evidence |
|---|---|---|---|
| A: `runs.trigger_kind` + `runs.trigger_ref` columns, backfilled, filterable | one column per fact; the run row is the run's own record (ADR-0023's "the run is the truth") and needs no join to recover the trigger later | a new migration (forward-only, ADR-0013) plus a new table for issue triggers | `00005` runs shape, `00006` schedules, design handoff |
| B: a `runs.trigger_id` uuid only | one column | loses the kind/ref split (schedule id vs `owner/repo#num`), cannot distinguish a manual start from a thread handoff, cannot answer "from issue #512" | |
| C: derive the trigger from `triggered_by` + idempotency keys at read time | zero migration | the keys are a write-side dedupe ledger keyed `schedule-<id>-<slot>`, not a trigger ledger; issue triggers have no key yet; deriving is re-implementing the backfill | |

## Decision

1. **`runs` gains `trigger_kind text NOT NULL DEFAULT 'manual' CHECK (trigger_kind IN
   ('manual','schedule','issue','thread'))` and `trigger_ref text NULL`** in migration
   `00012_run_triggers.sql`, written in the same create transaction as the run when the trigger
   is known (the column is NOT NULL so a row can never be trigger-less again — the default is
   the honest manual answer for every pre-existing writer, which the backfill corrects).
2. **`trigger_ref`** names the trigger: the schedule id for `schedule`; `owner/repo#<number>`
   for `issue`; NULL for `manual` and `thread` (a thread start keeps `source_conversation_id`,
   ADR-0053 — the thread IS the trigger context, and the reverse read is the conversation's
   `linked_runs`).
3. **Backfill (migration 00012, forward-only):** `source_conversation_id IS NOT NULL` →
   `trigger_kind = 'thread'`; runs whose idempotency key row matches `schedule-%` →
   `trigger_kind = 'schedule'` with `trigger_ref` = the schedule id parsed from the key
   (`schedule-<uuid>-<slot>`; the uuid is the second `split_part` field, the slot being
   compact-RFC3339 UTC per ADR-0032 §4). Everything else — manual starts, thread starts whose
   conversation row is gone — is `manual`/`thread` via the default and stays as written.
4. **`issue_triggers` table** (migration 00012): one row per (project, assignment, repository)
   issue-trigger intent — `event` (`opened`|`labeled`), `labels text[] NOT NULL DEFAULT '{}'`
   (any-of, case-insensitive; empty = every issue), `inputs jsonb NOT NULL DEFAULT '{}'`
   (template values; strings may carry `{{issue.number}} {{issue.title}} {{issue.body}}
   {{issue.url}} {{issue.labels}}`), `enabled`, `cursor_at`/`last_polled_at`/`last_error`,
   `version` (config-edit counter, a fire never bumps it, ADR-0032 §3), plus the two composite
   FKs to `assignments (id, project_id)` and `repositories (id, project_id)` (the latter
   needing the `repositories (id, project_id)` UNIQUE the migration adds, exactly as 00006 added
   the assignments one). Supporting index on `enabled` for the poll pass.
5. **Firing rule (decided here, implemented in part 2):** one serve-side tick polls GitHub's
   public issues list (`GET /projects/{p}/repos/{r}/issues`-shaped, `since=cursor_at`,
   `state=open`, `sort=updated`, anonymous unless a later ADR adds a token — ADR-0031's client),
   one run per (trigger, issue number) via idempotency key `issue-<trigger id>-<number>`; `labeled`
   fires when the issue now carries any of the trigger's labels, `opened` for issues created
   after the trigger was created (never backfills old issues); event `issue_trigger.fired`;
   rate-limit → `last_error`, no crash; poll interval 60 s, ≤ 100 triggers per pass, FOR UPDATE
   SKIP LOCKED like `TickSchedules`.
6. **API:** `GET/POST /api/v1/projects/{projectId}/issue-triggers`,
   `PATCH /api/v1/issue-triggers/{id}` — same roles/404/audit rules as the schedules routes
   (`schedule.list/create/update` on the assignment's project, viewer+ to read, maintainer+
   to write). **Part 1 adds only the run-side surface**: the run lists accept
   `?trigger=manual|schedule|issue|thread` (unknown → 400 `invalid_trigger`), and the run JSON
   carries `trigger: {kind, ref}`.

## Consequences

- The run row now records how it started, in the same transaction that writes it (a mutation
  writes state + its journal event in one transaction, ADR-0023 §12), so no second ledger can
  disagree with the run.
- Manual starts (`POST /projects/{projectId}/runs`, the handler stamps `manual` — or `thread`
  when the request carried `source`, ADR-0053) and schedule fires (`fireSchedule` stamps
  `schedule` + the schedule id; the child runs the engine starts through `pipeline.invoke`
  inherit the parent's trigger) all record honestly; retry re-opens the same row, so it keeps
  the original trigger.
- The Board's `from issues` / `scheduled` chips and the drawer's `from issue #512` meta have
  their backend data (`trigger` on the run summaries the Board reads); the UI wiring is the
  app-shell redesign's own brief and is out of this task's scope.
- New public API + a new persisted state ⇒ this ADR is required by the house rules; the
  migration is forward-only (ADR-0013).

## Security/privacy

No trust-boundary change. A run the control plane starts from a GitHub issue is still a
system start (`triggered_by` NULL, the pinned revision and the validated inputs — no caller
elevation); the trigger row is per-project/per-assignment/per-repository and the poll reads
GitHub's *public* issue list anonymously (ADR-0031), so no credentials or scopes enter the
control plane for the read half.

## Verification

- `go test -race ./internal/store/postgres/... -count=1` — migration 00012 applies on a database
  with existing runs and backfills `thread` (source conversation) and `schedule`
  (idempotency-key-led) rows; each create path writes its kind (manual / schedule / thread);
  the run-list filters return only matching runs and never another org's.
- `go test -race ./internal/api/... -count=1` — the `?trigger=` validation (unknown → 400
  `invalid_trigger`, bad values never reach SQL) and the run JSON shape.
- OpenAPI: `npx @redocly/cli@2.63.0 lint api/openapi.yaml` clean; `pnpm --dir ui gen:api` (the
  generated client picks the new `trigger` member and the new query param up).

## Migration/rollback

`00012_run_triggers.sql` (additive: two columns on `runs` + one index, the `issue_triggers`
table + its indexes, and the supporting `repositories (id, project_id)` UNIQUE). `migrate down`
rolls the table back; the columns go with the table in the same file, forward-only per ADR-0013.
Part 2 wires the poll and the issue-trigger routes.

## Amendment (2026-10-25) — a whole-placeholder value renders typed

§ 4's template vocabulary said strings "may carry `{{issue.number}}`" and the first
implementation quoted every rendered value back into a JSON string, so the shipped
`issue-to-pr` template — whose `issue_number` input is declared `type: integer` — could never
have a trigger at all: `"{{issue.number}}"` failed the pinned revision's type check both when
the trigger was written and at the fire. The rule now, with the vocabulary otherwise unchanged:
**when a trigger's string input is EXACTLY one placeholder (the whole value, e.g.
`{{issue.number}}`, no surrounding text), it renders with the type GitHub's own issue object
carries — `number` as a JSON number; every other member (`title`, `body`, `url`, `labels`) and
any mixed text (`"#{{issue.number}}"`) still renders a JSON string as before.** Because a
placeholder-only value is then a typed fact rather than a string, Create/PATCH validate the
inputs a fire WOULD produce (the template rendered against a fixed sample issue) instead of
validating the raw template text; the row keeps storing the template. A string-typed input that
wants the number as text still writes it as mixed text (`"issue {{issue.number}}"`), which is
what the trigger dialog's numeric "use issue number" binding and its refusal messages advertise.

## Amendment (2026-10-25) — a replay of an already-fired (trigger, issue) pair is DONE, not an error

§ 5 keys the fire on `issue-<trigger id>-<number>` and ADR-0023 § 12 answers a
same-key/different-body collision with the idempotency mismatch; but the issue
trigger's request body is rendered from the issue's *mutable* content (title,
body) and GitHub's `since` cursor is inclusive, so an edit after the fire
guarantees a replay of that key with a different sha — and treating that as an
error jammed the trigger forever: the poll aborted before the cursor advanced,
every later tick re-polled from the same stale cursor, re-saw the same edited
issue, and no other issue ever fired again. The rule now: **for the issue-trigger
fire only, an already-fired (trigger, issue) pair is DONE** — a mismatched replay
is skipped (debug-logged, no second run, no second `issue_trigger.fired` event)
and the poll still advances its cursor past that issue, so the rest of the same
listing fires normally. Every other idempotency-key caller (`POST /runs`,
schedule fires) keeps ADR-0023 § 12's mismatch answer unchanged: this narrows
what a trigger promises about its own (trigger, issue) dedupe, not the meaning
of an API idempotency key.

## Amendment (2026-10-25) — `labeled` never backfills either

§ 5 attached "never backfills old issues" to the `opened` arm, and the shipped
`labeled` arm read that literally: its first poll — no cursor, no `since`, the
whole labeled listing — fired on "does this issue carry a watched label NOW".
The gh-loop of 2026-10-25 showed what that answers: one poll fired eight runs
for issues whose labels had been applied hours before the trigger was written,
and those backfilled runs (seven waiting on human gates against a
`max_concurrent_runs` of 1) then deferred every real fire the trigger saw
afterwards. The rule now, in the spirit of the ADR rather than its letter:
**a `labeled` trigger fires only for a label applied at or after the trigger's
own `created_at`** — the event the intent subscribes to, not the state the
intent finds. The witness is GitHub's issue event timeline
(`GET /repos/{o}/{r}/issues/{n}/events`, a `labeled` event whose `created_at`
is at or after `issue_triggers.created_at`, matched case-insensitively against
the trigger's label set when GitHub names it), read with the same anonymous or
per-credential call as the listing. Where no timeline can be read at all — a
lister without that capability, or a failed event read — the declared degraded
fallback is the issue's `updated_at >= created_at`: an edit can over-fire
through it, but a pre-trigger label never can, since applying the label is
itself an update. A skipped issue still advances the cursor; a *new* label
bumps `updated_at` past it and returns the issue to a later listing on its
merits.

## Amendment (2026-10-25) — the no-backfill comparison runs on GitHub's clock, and an invisible label event is never a verdict

The amendment above hands the `labeled` arm a comparison — label event at or
after `created_at` — that pits two clocks against each other: the trigger's
`created_at` is the database's clock, GitHub's event times are GitHub's, and
NTP discipline is not a cross-service agreement. The gh-loop of 2026-10-25
measured the cost: the lab's clock ran ~50 s ahead of GitHub's (`date -u`
17:10:50 while GitHub answered `Date: 17:10:00`), and issue #16 — labeled
AFTER its trigger by GitHub's own timeline — compared as "before", was skipped,
and the cursor advanced past it for good. The rule now:

**Each trigger is armed on GitHub's own clock.** The first poll that can read
GitHub's `Date` response header records `created_at − (local_now −
github_now)` as the trigger's `github_created_at` baseline (migration 00018),
and every later labeled-event comparison — and the `opened` arm's
created-at gate — runs against that baseline, never the raw `created_at`.
The tolerance is 2 minutes toward accepting: Date headers are
second-granular, arming happens once, and a label landing within minutes of
authoring is plainly the event the trigger subscribed to, while an hours-old
backfill label stays refused by orders of magnitude. Where GitHub's clock
cannot be read at all (a lister with no clock, a failed probe), the poll
degrades to the old `created_at` comparison — loudly, at WARN — rather than
refusing to fire anything.

**An issue that carries a watched label whose `labeled` event is not yet
visible gets no verdict at all**: the events API is eventually consistent, so
the trigger neither fires nor refuses it, and the cursor does not advance
past it (GitHub's `since` is inclusive, so the issue re-surfaces on every
later poll until its timeline catches up, at which point it fires or is
decisively refused). Silent-permanent-skip was the failure; retry is the
answer.
