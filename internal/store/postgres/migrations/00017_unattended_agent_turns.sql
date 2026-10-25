-- 00017 — ADR-0062 (docs/adr/ADR-0062-unattended-agent-turns.md): unattended
-- agent turns — a schedule-fired or issue-trigger-fired run names the human
-- who authorised the automation as its turn submitter, on the record.
--
-- The gap this closes: conversation_turns.submitted_by is NOT NULL REFERENCES
-- users (00003) and runs.triggered_by is NULL for every schedule fire, issue
-- trigger fire and child run (00005 models them as system starts), so the
-- § 4 step 6 seam refused to stamp a run-attempt conversation for exactly
-- those runs — "an unattended agent turn cannot honestly name its
-- submitter". The fix is attribution, not a nullable column and not a
-- per-org system principal: the human who WROTE the trigger/schedule row is
-- the human who authorised the automation, and their users row exists
-- (schedules.created_by / issue_triggers.created_by are NOT NULL FKs).
--
-- Forward-only per ADR-0013: the Down section exists for test resets only.
--
-- Deliberate placement of invariants (each stated as the lie it makes
-- impossible):
--
--   * runs_trigger_id_names_a_trigger — runs.trigger_id is the PRIMARY KEY
--     of the trigger table that started the run (schedules.id for 'schedule',
--     issue_triggers.id for 'issue'); the CHECK makes it unrepresentable for
--     any other kind, because 'manual'/'thread' starts carry their human in
--     triggered_by and a child inherits its parent's pair. There is NO
--     foreign key: one column points at two tables by trigger_kind — the
--     same polymorphic-ref discipline run_inputs.origin names — and a deleted
--     trigger row must stay a readable fact (the attribution then fails
--     closed at turn time, ADR-0062 Decision 3), which a cascading or
--     setting-NULL FK would erase.
--   * The schedule backfill joins run_idempotency_keys on the TEXT of the
--     schedule id instead of casting trigger_ref, because it repairs rows the
--     00012 backfill never matched: 00012's schedule arm required
--     array_length(string_to_array(key,'-'),2)=3, but a schedule key is
--     `schedule-<uuid>-<compact-RFC3339 slot>` and both the uuid and the
--     date dashes in the slot blow that count up — the arm silently matched
--     zero rows on every real database, and where it HAD matched it would
--     have stored split_part(key,'-',2), a uuid head segment, not a uuid. The
--     LIKE-join reads the ledger the fire actually wrote. It also corrects
--     trigger_ref (ADR-0056 § 2: the schedule id), and it only ever touches
--     rows whose kind is 'manual' (the mis-backfill's resting state) or
--     'schedule'.
--   * The child propagation carries trigger_id down the parent_run_id chain
--     only where the child's kind already admits one — pre-00012 children of
--     unattended runs kept kind 'manual' — and turn-time attribution walks
--     the same parent chain, so an unpropagated child still resolves to its
--     root's author rather than failing.
--   * conversation_turns.submitted_via answers "who/WHAT put this prompt
--     into the queue" next to submitted_by's "on whose behalf": human (typed
--     or run-started through the API — the DEFAULT, so every pre-00017 row
--     reads exactly what it was), schedule / issue_trigger (the automation
--     fired it; submitted_by names the trigger's author, never a person who
--     typed anything), child_run (pipeline.invoke inherited the submitter
--     from an ancestor run's triggered_by). A transcript renderer that shows
--     only submitted_by is honest exactly when submitted_via='human'; this
--     column is what makes the difference visible instead of a lie of
--     omission.

-- +goose Up

ALTER TABLE runs
    ADD COLUMN trigger_id uuid,
    ADD CONSTRAINT runs_trigger_id_names_a_trigger
        CHECK (trigger_id IS NULL OR trigger_kind IN ('schedule', 'issue'));

-- Schedule fires, including the 00012 arm's silent zero-match repair.
UPDATE runs AS r
SET trigger_kind = 'schedule',
    trigger_ref  = s.id::text,
    trigger_id   = s.id
FROM run_idempotency_keys AS k
JOIN schedules AS s ON k.key LIKE 'schedule-' || s.id::text || '-%'
WHERE r.id = k.run_id
  AND r.trigger_id IS NULL
  AND r.trigger_kind IN ('manual', 'schedule');

-- Issue fires: the fire writes key `issue-<trigger id>-<number>` (ADR-0056
-- § 5), and issue_triggers' own last-fired read joins the same way.
UPDATE runs AS r
SET trigger_id = t.id
FROM run_idempotency_keys AS k
JOIN issue_triggers AS t ON k.key LIKE 'issue-' || t.id::text || '-%'
WHERE r.id = k.run_id
  AND r.trigger_id IS NULL
  AND r.trigger_kind = 'issue';

-- Children inherit the trigger their ancestor fired from (same inheritance
-- rule ADR-0056 states for trigger_kind/trigger_ref, retro-applied). The
-- CHECK above bounds what this may touch.
WITH RECURSIVE trigger_origin AS (
    SELECT id, parent_run_id, trigger_id
    FROM runs
    WHERE parent_run_id IS NULL AND trigger_id IS NOT NULL
    UNION ALL
    SELECT c.id, c.parent_run_id, o.trigger_id
    FROM runs c
    JOIN trigger_origin o ON c.parent_run_id = o.id
)
UPDATE runs AS r
SET trigger_id = o.trigger_id
FROM trigger_origin AS o
WHERE r.id = o.id
  AND r.trigger_id IS NULL
  AND r.trigger_kind IN ('schedule', 'issue');

ALTER TABLE conversation_turns
    ADD COLUMN submitted_via text NOT NULL DEFAULT 'human'
        CONSTRAINT conversation_turns_submitted_via_is_honest
        CHECK (submitted_via IN ('human', 'schedule', 'issue_trigger', 'child_run'));

-- +goose Down

ALTER TABLE conversation_turns
    DROP COLUMN IF EXISTS submitted_via;

ALTER TABLE runs
    DROP CONSTRAINT IF EXISTS runs_trigger_id_names_a_trigger;

ALTER TABLE runs
    DROP COLUMN IF EXISTS trigger_id;
