-- 00006 — M6 schedule triggers (ADR-0032; communication-spec/07-config-integrations.md's
-- "cron-like schedule" trigger, 11-build-roadmap.md M6 "Schedule triggers").
--
-- Forward-only per ADR-0013: no statement here rewrites a 00001-00005 row, and
-- the Down section exists for test resets only.
--
-- One row is one recurring intent: "fire THIS assignment's pinned revision on
-- this cron expression with these fixed inputs". It owns no run state — the
-- run it creates is an ordinary 00005 run, made through the same create path a
-- manual POST /runs uses, keyed by run_idempotency_keys so a double tick
-- cannot produce a second run.
--
-- Deliberate placement of invariants (each stated as the lie it makes
-- impossible):
--
--   * schedules_fire_in_their_assignment's_project — the composite FK to
--     assignments (id, project_id) (whose supporting UNIQUE this migration
--     adds) rejects "a schedule in project A that fires an assignment in
--     project B", the same cross-project refusal route 22's CreateRun makes
--     in Go (m4api_runs_write.go). Structural, because a scheduler writes
--     with no caller in the room to check.
--   * schedules_cron_is_five_fields — five whitespace-separated fields, which
--     is the shape the store writes (schedule.Parse's normalized String(), so
--     single spaces and no leading or trailing whitespace) and the widest shape
--     the column admits. Parse stays the authority on MEANING: the CHECK exists
--     so a row written by hand, or by a future migration's backfill, cannot be
--     silently unfireable — a sixth field or an empty expression is refused at
--     the door rather than discovered by a tick that can never advance the row.
--   * schedules_next_run_at_is_the_only_due_clock — next_run_at is NOT NULL:
--     there is no "enabled but unscheduled" state to reason about, so the due
--     index and the tick's predicate agree on one column.
--   * schedules_last_run_is_a_pair — a last_run_id with no last_run_at (or the
--     reverse) is a half-written fire, which the tick's transaction cannot
--     produce; the CHECK is there for whoever writes this row next.
--   * schedules_version_starts_at_one — the optimistic-concurrency counter the
--     API's PATCH compares against (ADR-0032 § 3). It counts CONFIG edits
--     only: a fire advances next_run_at and stamps last_run_* without
--     touching version, so a scheduled fire never invalidates an edit.
--
-- What is deliberately NOT here: no timezone column (fires are UTC, ADR-0032
-- § 3), no cron parser state (parsed per tick from cron_expr, so the column
-- stays the single human-readable truth), no per-fire history table (every
-- fire is a run plus its run.created and schedule.fired journal rows), no
-- secret material (inputs are the fixed JSON a run's declared inputs accept,
-- and run_inputs stays the only place input values land), and no second
-- journal — the fire's journal rows commit in the same transactions as the
-- run and the schedule-row advance.

-- +goose Up

-- Supporting UNIQUE for the composite FK below: assignments.id is already the
-- primary key, so this index costs one column on an already-unique tuple.
ALTER TABLE assignments
    ADD CONSTRAINT assignments_id_project_unique UNIQUE (id, project_id);

CREATE TABLE schedules (
    id             uuid        PRIMARY KEY DEFAULT uuidv7(),
    project_id     uuid        NOT NULL REFERENCES projects (id),
    assignment_id  uuid        NOT NULL,
    cron_expr      text        NOT NULL CHECK (cron_expr ~ '^[^[:space:]]+([[:space:]]+[^[:space:]]+){4}$'),
    inputs         jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof (inputs) = 'object'),
    enabled        boolean     NOT NULL DEFAULT true,
    next_run_at    timestamptz NOT NULL,
    last_run_at    timestamptz,
    last_run_id    uuid        REFERENCES runs (id),
    version        integer     NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_by     uuid        NOT NULL REFERENCES users (id),
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT schedules_fire_in_their_assignments_project
        FOREIGN KEY (assignment_id, project_id)
        REFERENCES assignments (id, project_id),
    CONSTRAINT schedules_last_run_is_a_pair
        CHECK ((last_run_id IS NULL) = (last_run_at IS NULL))
);

-- The tick's due scan, and the only reason the table is indexed: an disabled
-- schedule is never due, so it is not in the index the tick reads.
CREATE INDEX schedules_due_idx ON schedules (next_run_at) WHERE enabled;
CREATE INDEX schedules_project_idx ON schedules (project_id, created_at DESC, id DESC);

-- +goose Down
DROP INDEX IF EXISTS schedules_project_idx;
DROP INDEX IF EXISTS schedules_due_idx;
DROP TABLE IF EXISTS schedules;
ALTER TABLE assignments DROP CONSTRAINT IF EXISTS assignments_id_project_unique;
