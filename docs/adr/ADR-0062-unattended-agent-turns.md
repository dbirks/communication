# ADR-0062 — Unattended agent turns: a fired run submits on behalf of the human who authorised the automation

- **Date:** 2026-10-25
- **Status:** Accepted (implemented and verified on real Postgres — see Verification)
- **Owners:** control-plane persistence + worker loop maintainers
- **Related decisions / contracts:** ADR-0016 (`conversation_turns`, turn leases), ADR-0013 (forward-only migrations), ADR-0023 § 7 (attempt failure classes), ADR-0032 (schedules, `schedule-<id>-<slot>` key), ADR-0053 (thread starts), ADR-0056 (run triggers: `runs.trigger_kind`/`trigger_ref`, the `issue_triggers` table, `issue-<trigger id>-<number>` key), ADR-0016 § 5 / m4-contract § 4 step 6 (the attempt's conversation/turn stamp), `communication-spec/06` (every action audit-logged with actor kind), `communication-spec/09` (`conversation_turns.submitted_by`, the events vocabulary), `communication-spec/12` (test layers)

## Context

The product's core loop — an issue label fires the `issue-to-pr` pipeline, its first
`agent.acp` node plans the change — was dead on the lab (f2ca905). Every run started by a
schedule or an issue trigger failed its first agent attempt with `error_class: infra`:

```
read attempt conversation: postgres: run has no triggering user (runs.triggered_by is NULL
for a child or system start) and conversation_turns.submitted_by is NOT NULL REFERENCES
users: an unattended agent turn cannot honestly name its submitter
```

(`internal/store/postgres/agentturn_seams.go`). The seam refused rather than forge a
submitter, and it was right to: 00003 made `submitted_by` NOT NULL and user-FK'd, 00005
models a schedule/issue fire and a child run as `triggered_by = NULL` ("a system start,
exactly as 00005 models it", ADR-0056 Security: "a run the control plane starts from a
GitHub issue is still a system start"). So the columns 00005/00012 chose made an
unattended turn unsupportable — the honesty rule and the schema together blocked the
feature the triggers were built for.

Two facts make honesty and function compatible. First, an automation is never anonymous:
`schedules.created_by` and `issue_triggers.created_by` are NOT NULL FKs to `users` — a
human wrote the row that authorises every fire of it, and that consent ("this trigger runs
this pinned revision on this cadence/event") is exactly the authorization `communication-spec/06`
asks the audit trail to attribute. Second, the run already records *that* it was fired
(`trigger_kind`, and for a schedule fire, the schedule id in `trigger_ref`) — but for an
issue fire `trigger_ref` names `owner/repo#<number>`, the ISSUE, not the trigger row, and
ADR-0056 § Options already rejected recovering the trigger by parsing the idempotency-key
ledger as a read-time practice ("the keys are a write-side dedupe ledger, not a trigger
ledger"). Attribution had to be *recorded*, not guessed.

## Options considered

| Option | Advantages | Disadvantages | Evidence |
|---|---|---|---|
| A: on-behalf-of attribution — `runs.trigger_id` records the firing trigger row; the turn's `submitted_by` is read from that row's `created_by` at stamp time; children inherit through `parent_run_id`; no provable human ⇒ the node fails CLOSED | no invented principal; the run row carries the fact in its own create transaction (ADR-0023 "the run is the truth"); the `submitted_by` NOT NULL contract stands; fail-closed is the house rule | two additive columns + one walk at turn time; deleting a trigger row turns pending fires into honest failures | implemented; `TestUnattended*` on real Postgres |
| B: stamp the author into `runs.triggered_by` at fire time | zero new columns | lies about *initiation*: ADR-0056's Security paragraph and both fire paths' comments say a fire is a system start, and `run.created` carries `actor_kind=system`; the Board/audit read `triggered_by` as "who started this run", and a person who never touched the fire would appear there | 00005 column comment; `fireSchedule`/`fireIssue` comments |
| C: make `submitted_by` nullable-with-kind (00005's own note) | turns could be submitter-less | every consumer of `submitted_by` (M2 claim path, transcript authoring, display joins) must re-learn the null branch; the spec's "exactly one current owner / one non-terminal turn" family treats the submitter as a person; and it answers the problem by *deleting the fact* rather than attributing it | 00003 `conversation_turns`, `turns.go` claim read |
| D: a per-org "system principal" users row | zero schema change | invents a non-person inside `users` — the table the FK, the display-name join and the membership model all treat as people; audit would show "Alice" acting where the event journal already has the honest vocabulary `actor_kind: system` (spec 06); and nothing about a bot row says *which human authorised the automation* | spec 06 actor kinds; 00001 users shape |

## Decision

1. **`runs.trigger_id uuid NULL`** (migration `00017_unattended_agent_turns.sql`) — the
   primary key of the trigger table that started the run: `schedules.id` for
   `trigger_kind = 'schedule'`, `issue_triggers.id` for `'issue'`, NULL for
   `manual`/`thread`; a `CHECK` makes any other combination unrepresentable. Both fire
   paths (`fireSchedule`, `fireIssue`) write it in the run's own create transaction
   (ADR-0056's "written in the same create transaction as the run"); `pipeline.invoke`
   children inherit it with the kind and ref. There is deliberately **no foreign key**:
   the column is a polymorphic ref (kind selects the table), and a deleted trigger row
   must stay a *readable fact* that the next turn fails closed on — not a `SET NULL`
   erasure. Backfill: schedule fires join the `schedule-<id>-<slot>` idempotency ledger,
   issue fires the `issue-<id>-<number>` ledger (both keyed by trigger-row id, the
   fire's own write), and children inherit down the `parent_run_id` chain. The schedule
   arm simultaneously repairs ADR-0056's migration-00012 backfill, whose predicate
   (`array_length(string_to_array(key,'-'),2)=3`) can never match a schedule key — a
   uuid and a compact-RFC3339 slot carry more dashes than that — so the arm silently
   matched zero real rows and its `split_part(key,'-',2)` answer was not a uuid anyway.
2. **`conversation_turns.submitted_via text NOT NULL DEFAULT 'human' CHECK (submitted_via
   IN ('human','schedule','issue_trigger','child_run'))`** (same migration) — what
   ACTUALLY queued the prompt, next to `submitted_by`'s "on whose behalf". The default
   keeps every pre-00017 row honest: the only attempt turns that could exist were stamped
   from `triggered_by` (a human start), which the resolver labels `human` too.
3. **The stamp resolves its submitter in this order** (`attemptSubmitter`, the § 4 step 6
   seam): (a) the run's own `triggered_by` → `human`; (b) the run's `trigger_id`'s row —
   `schedules.created_by` (`schedule`) or `issue_triggers.created_by` (`issue_trigger`);
   (c) the same walk up the `parent_run_id` chain, a child reaching an ancestor's
   `triggered_by` labelled `child_run`. The author's users row is re-proved before use.
   **If none names a provable human — the trigger row is gone, the author row is gone, or
   the run is an unparented start with no triggering user — the seam errors, the attempt
   lands `failed` with `error_class: infra` and a detail that names the missing row, and
   nothing is written.** A deleted trigger authorises nothing; nobody may inherit the
   automation silently.
4. **The wire says who/what.** `ConversationTurn.submitted_via` joins `submitted_by`
   (enum above; OpenAPI + generated `schema.d.ts`). It is always SENT (the column is
   NOT NULL) but declared optional on the wire so the additive change breaks no
   pre-ADR-0062 producer or fixture. `submitted_by`'s description changes from "always
   a human in M2" to the on-behalf-of rule — a transcript that renders only the
   submitter is honest exactly when `submitted_via` is `human`. No event payload
   changes: the journal keeps `actor_kind: system` for the fire, which is the
   *initiation* fact ADR-0056 protects.

## Consequences

- The issue→PR loop and every scheduled pipeline run. The failing node in the lab
  report (`plan` on run 01a1729e…) now stamps `submitted_by` = the trigger author with
  `submitted_via='issue_trigger'`.
- Trigger deletion becomes a visible operational event instead of silent inheritance:
  pending fires of a deleted trigger fail closed with "run … was fired by schedule
  <id>, whose row is gone — the human who authorised the automation can no longer be
  named"; the fix is an operator decision (re-create the trigger, cancel the run), never
  a guessed principal. The same error text covers the old gap (a root start with no
  `triggered_by`).
- `submitted_by` stops meaning "typed it" universally; readers that assumed it (the M2
  claim path, conversation lists) are unaffected in behavior because their rows stay
  `human`; the new column is what makes the difference legible instead of a lie of
  omission. UI copy ("on behalf of X · scheduled") is the UI brief's own next step.
- The conversation row (`conversations.created_by`) follows the same attribution, so the
  attempt thread and its turns name one honest person.
- Manual and thread starts are unchanged in every respect except the new `submitted_via
  = 'human'` label; a retried slot or a retried node keeps the original trigger (ADR-0056).

## Security/privacy

No trust-boundary change: the pinned revision, the assignment ceiling and the
authorization checks at fire time are untouched — this decides only what the turn row
says. Attribution is consent-based (the trigger author IS the authorising human under
spec 06's per-project model), is re-proved against `users` before writing, and fails
CLOSED with zero rows written when unprovable. No synthetic principals enter `users`;
no secret, token or identity material is added to the run row. On-behalf-of attribution
is not elevation: the agent acts under the run's sandbox/policy axes (ADR-0016 § 5,
ADR-0019), never under the author's session.

## Verification

Real Postgres 18 (`COMMUNICATION_TEST_DATABASE_URL`, migrations 00001–00017 applied):

```
$ go test ./internal/store/postgres/ -run 'TestUnattended|TestMigrate0017|TestAttemptSession' -count=1 -v
--- PASS: TestAttemptSessionConversationStamp (5.19s)             manual start ⇒ turn submitted_via='human'
--- PASS: TestAttemptSessionNoSubmitterRefuses (2.22s)            the old gap still refuses, honestly
--- PASS: TestAttemptSessionBindingLabelling (2.45s)
--- PASS: TestAttemptSessionResumeAfterKilledOwner (3.60s)
--- PASS: TestUnattendedScheduleTurnNamesTheScheduleAuthor (6.86s) TickSchedules fire ⇒ turn
                                                             submitted_by = schedules.created_by, via='schedule'
--- PASS: TestUnattendedIssueTurnNamesTheTriggerAuthor (0.68s)    TickIssueTriggers fire ⇒ submitted_by =
                                                             issue_triggers.created_by, via='issue_trigger'
--- PASS: TestUnattendedChildTurnInheritsTheSubmitter (0.90s)     child of a human start ⇒ via='child_run'
--- PASS: TestUnattendedTurnFailsClosedWhenTheScheduleIsGone (1.29s) row gone ⇒ closed failure naming
                                                             the vanished schedule id; zero conversations written
--- PASS: TestUnattendedTurnFailsClosedWhenTheIssueTriggerIsGone (1.00s)
--- PASS: TestMigrate0017UnattendedTurnShape (0.01s)              CHECKs + DEFAULT 'human' as catalog state
ok  	github.com/dbirks/communication/internal/store/postgres	26.527s
```

Plus, with all of the above in the tree: `go build ./...`, `go vet ./...`,
`gofmt -l internal cmd` clean for every file this change touches, and
`go test ./internal/store/postgres ./internal/worker ./internal/api/... -count=1` →
`ok …/store/postgres 333.253s / ok …/worker 10.469s / ok …/api 2.544s / ok …/api/auth 0.032s`;
`npx @redocly/cli@2.63.0 lint api/openapi.yaml` valid (8 pre-existing warnings, none on the
turn schema); `pnpm --dir ui gen:api:check`, `tsc --noEmit` and `pnpm --dir ui test`
(1565 tests) green.

## Migration/rollback

`00017_unattended_agent_turns.sql` — additive: one nullable column + CHECK on `runs`, one
NOT NULL DEFAULT column + CHECK on `conversation_turns`, and the three-statement trigger
backfill (schedule ledger, issue ledger, recursive child propagation). Head moves 16 → 17
(`migHeadVersion`). Forward-only per ADR-0013; the Down section exists for test resets
only. Rollback of the code without the migration is not supported (the stamp reads the
new columns); rollback with it loses the attribution and the fire paths' extra column
value with it.
