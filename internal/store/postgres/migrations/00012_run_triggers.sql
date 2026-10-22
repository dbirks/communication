-- 00012 — ADR-0056 (docs/adr/ADR-0056-run-triggers.md): run triggers, part 1.
--
-- Forward-only per ADR-0013: nothing here rewrites an earlier row's meaning, and
-- the Down section exists for test resets only.
--
-- Deliberate placement of invariants (each stated as the lie it makes
-- impossible):
--
--   * runs_trigger_kind_is_exhaustive — trigger_kind is NOT NULL with a CHECK
--     over the four recorded kinds (manual | schedule | issue | thread). The
--     column is NOT NULL so a row can never be trigger-less again; the DEFAULT
--     is the honest manual answer for every pre-existing writer, which the
--     backfill corrects.
--   * runs_trigger_ref_names_the_trigger — trigger_ref is the schedule id for
--     a 'schedule' start, `owner/repo#<number>` for an 'issue' start, and NULL
--     for 'manual' and 'thread' (a thread start keeps source_conversation_id,
--     ADR-0053 — the thread IS the trigger context).
--   * runs_backfill_threads_first — the thread arm runs BEFORE the schedule
--     arm and the two predicates are disjoint by construction (a thread start
--     carries source_conversation_id; a schedule fire does not), so the order
--     cannot matter; the schedule arm reads the idempotency-key ledger
--     (`schedule-<id>-<slot>`, ADR-0032 § 4) to recover the fired schedule.
--
-- What is deliberately NOT here: no issue-trigger fire path (that is part 2,
-- the GitHub poll behind issue_triggers), no per-trigger cursor semantics
-- beyond the columns the table carries, and no second journal — the fire's
-- journal rows commit in the same transactions as the run and the trigger-row
-- advance.

-- +goose Up

ALTER TABLE runs
    ADD COLUMN trigger_kind text NOT NULL DEFAULT 'manual'
        CHECK (trigger_kind IN ('manual', 'schedule', 'issue', 'thread')),
    ADD COLUMN trigger_ref text;

-- A run that came from a thread was started by that thread's handoff
-- (ADR-0053): the thread is the trigger context and the reverse read stays the
-- conversation's linked_runs.
UPDATE runs
SET trigger_kind = 'thread'
WHERE source_conversation_id IS NOT NULL;

-- A run that came from a schedule fire: the idempotency key row names the
-- fired slot (`schedule-<scheduleId>-<slot>`, the dash separator and the
-- compact-RFC3339 UTC slot both legal under the key grammar), and the second
-- dash-separated field is the schedule id.
UPDATE runs AS r
SET trigger_kind = 'schedule',
    trigger_ref = split_part(k.key, '-', 2)
FROM run_idempotency_keys AS k
WHERE r.id = k.run_id
  AND k.key LIKE 'schedule-%'
  AND array_length(string_to_array(k.key, '-'), 2) = 3
  AND r.source_conversation_id IS NULL;

-- Supporting UNIQUE for the composite FK below: assignments.id is already the
-- primary key, so this index costs one column on an already-unique tuple.
ALTER TABLE repositories
    ADD CONSTRAINT repositories_id_project_unique UNIQUE (id, project_id);

-- One row per (project, assignment, repository) issue-trigger intent: "when
-- an issue in this repo for this assignment is opened / labeled, fire the
-- pinned revision with these template values". Part 1 creates the table; the
-- poll that turns rows into runs lands in part 2 (ADR-0056 § 5).
CREATE TABLE issue_triggers (
    id            uuid        PRIMARY KEY DEFAULT uuidv7(),
    project_id   uuid        NOT NULL REFERENCES projects (id),
    assignment_id uuid       NOT NULL,
    repository_id uuid       NOT NULL,
    event        text        NOT NULL CHECK (event IN ('opened', 'labeled')),
    labels       text[]      NOT NULL DEFAULT '{}',   -- any-of, case-insensitive; empty = every issue
    inputs       jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof (inputs) = 'object'),
    enabled      boolean     NOT NULL DEFAULT true,
    cursor_at    timestamptz,
    last_polled_at timestamptz,
    last_error   text,
    version      integer     NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_by   uuid        NOT NULL REFERENCES users (id),
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT issue_triggers_fire_in_their_assignment_project
        FOREIGN KEY (assignment_id, project_id)
        REFERENCES assignments (id, project_id),
    CONSTRAINT issue_triggers_fire_in_their_repository_project
        FOREIGN KEY (repository_id, project_id)
        REFERENCES repositories (id, project_id)
);

-- The poll pass's due scan: a disabled trigger is never due, so it is not in
-- the index the tick reads.
CREATE INDEX issue_triggers_enabled_idx ON issue_triggers (enabled) WHERE enabled;

-- +goose Down

DROP TABLE IF EXISTS issue_triggers;
ALTER TABLE runs DROP COLUMN IF EXISTS trigger_kind;
ALTER TABLE runs DROP COLUMN IF EXISTS trigger_ref;
ALTER TABLE repositories DROP CONSTRAINT IF EXISTS repositories_id_project_unique;
