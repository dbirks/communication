-- 00030 — assistant handoff §6 (CONTRACT §5): the five setup change kinds.
--
-- The risky setup tools (project.create, repo.add, assignment.set,
-- run.cancel, schedule.create) each write one assistant_changes row, and a
-- kind the table cannot hold is an INSERT that fails AFTER the real state
-- changed — the project exists, the transcript says nothing. So the kind
-- CHECK is extended here, before the tools are wired:
--
--   * project_create     — the project the assistant created (with its
--                          repository attached in the same confirm, which is
--                          why repo_add gets its own row only for the
--                          standalone repo.add call);
--   * repo_add           — a repository bound to a project (+ its named
--                          credential, ADR-0061);
--   * assignment_set     — a workflow pinned to a project at its latest
--                          published revision (the promotion preview);
--   * run_cancel         — a cancellation REQUESTED on a run;
--   * schedule_create    — a cron trigger that starts future runs.
--
-- Forward-only per ADR-0013: no existing row changes meaning (no row can
-- carry a new kind before this migration), nothing is rewritten, and the
-- undo pair below exists for test resets only. None of the five is undoable:
-- they carry no `undo_payload`, exactly as run_start / run_retry /
-- approval_decision / publish already do (ADR-0050 decision 5 — the change
-- list says "can't be undone" for these).

-- +goose Up
ALTER TABLE assistant_changes
    DROP CONSTRAINT assistant_changes_kind_check;

ALTER TABLE assistant_changes
    ADD CONSTRAINT assistant_changes_kind_check CHECK (kind IN (
        'draft_edit', 'navigate', 'run_start', 'run_retry',
        'approval_decision', 'publish',
        'project_create', 'repo_add', 'assignment_set',
        'run_cancel', 'schedule_create'));

-- +goose Down
ALTER TABLE assistant_changes
    DROP CONSTRAINT assistant_changes_kind_check;

ALTER TABLE assistant_changes
    ADD CONSTRAINT assistant_changes_kind_check CHECK (kind IN (
        'draft_edit', 'navigate', 'run_start', 'run_retry',
        'approval_decision', 'publish'));
