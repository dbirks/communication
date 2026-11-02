-- 00024 — ADR-0066 step 2: the trigger→input mapping lives ON THE TRIGGER.
--
-- An issue trigger fills one typed `github_issue` input with the matched
-- issue object ({number, title, body, url, repo}); `issue_input` names that
-- input. The ADR stores the mapping on the trigger — not in the pipeline
-- document — so one workflow can be fired by an issue trigger and a schedule
-- with different fillers, and so a trigger row answers "what does it fill?"
-- without reparsing the workflow.
--
-- NULL means "not explicitly mapped". The reader (create/update and the fire)
-- resolves it against the pinned revision's input specs: the single
-- github_issue-typed input when there is exactly one; when there are several
-- the write refuses until the trigger names one, and a legacy row whose
-- revision gained a second issue input simply fills nothing (logged, never
-- guessed).
--
-- Schedules have no such column: a schedule fills nothing typed (ADR-0066 §
-- Decision), only the literal values of its own inputs object.
--
-- Forward-only per ADR-0013: the Down section exists for test resets only.

-- +goose Up

ALTER TABLE issue_triggers ADD COLUMN issue_input text
    CHECK (issue_input IS NULL OR (issue_input <> '' AND length(issue_input) <= 200));

-- +goose Down

ALTER TABLE issue_triggers DROP COLUMN IF EXISTS issue_input;
