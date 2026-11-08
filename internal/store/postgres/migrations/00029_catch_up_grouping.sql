-- 00029 — ADR-0078 § Grouping (docs/adr/ADR-0078-catch-up-work-items-and-tours.md):
-- Catch up grouped. The design's piece of work is an ISSUE with its PRs and
-- commits nested under it, a PR, or a push — not a run. Keying an item by
-- `source_run_id` made two runs on the same issue (the issue-to-pr template run
-- twice, or a fix run after a failed one) two pieces of work, each with its own
-- tour the reader had to read twice. This migration adds the identity the
-- product actually described:
--
--   * `group_key` is the work item's identity — `issue:<repository>:<number>`,
--     `pr:<repository>:<number>`, or `run:<run id>` when the run named no
--     number at all (then the run IS the piece of work, exactly as before). The
--     store derives it from the refs the server read off the run's own inputs
--     and outputs, so the model cannot name its way into somebody else's story:
--     a hallucinated issue number moves no key, because the key is not read
--     from the answer. The unique index is partial so an item written before
--     grouping (`group_key IS NULL`, keyed by `source_run_id` as it always was)
--     never collides with anything;
--   * `source_run_id` stays, but its meaning narrows to the LATEST run of the
--     item — the run that moved the work last, which is the run a reader wants
--     to follow from the story. `catchup_work_item_runs` is the whole history:
--     every run that has been folded into the item, with the instant it joined.
--     It carries no foreign key on `run_id` for the 00028 reason that already
--     applies to `source_run_id` — runs are pruned by retention, the record of
--     what they did outlives them, and the table is never a join into run state;
--   * candidate selection reads that link table: a finished run is owed a story
--     when no item has claimed it yet. Keying off "the item's newest tour
--     predates the run" was the run-identity model talking; under grouping the
--     run that moves the story is a DIFFERENT run, and the only statement that
--     is true of an unclaimed run is that no `catchup_work_item_runs` row
--     names it.
--
-- Forward-only per ADR-0013. The Down section exists for test resets only.

-- +goose Up

ALTER TABLE catchup_work_items ADD COLUMN group_key text
    CONSTRAINT catchup_work_items_group_key_check CHECK (group_key IS NULL OR
        (length (group_key) BETWEEN 3 AND 160
         AND length (btrim (group_key)) = length (group_key)));

-- The re-grouping key: a second run naming the same issue in the same
-- repository rewrites THIS item rather than writing a twin.
CREATE UNIQUE INDEX catchup_work_items_group_key_idx
    ON catchup_work_items (project_id, group_key) WHERE group_key IS NOT NULL;

CREATE TABLE catchup_work_item_runs (
    -- Cascades from the work item: which runs told a story that is gone told
    -- nothing.
    work_item_id uuid        NOT NULL REFERENCES catchup_work_items (id) ON DELETE CASCADE,
    -- No foreign key (see the header): a pruned run stays a run this item
    -- claims. uuid-typed so the id a reader follows is at least an id.
    run_id       uuid        NOT NULL,
    added_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (work_item_id, run_id)
);

-- "Has this run been claimed by an item yet?" — the candidate read, and the
-- item's own run list, both keyed on the run.
CREATE INDEX catchup_work_item_runs_run_idx
    ON catchup_work_item_runs (run_id, added_at DESC);

-- The items that already exist keep the identity they were born with: a run
-- that has a work item is claimed by it, and an item whose run is known is
-- keyed by that run. Items with no run at all stay NULL, which is the honest
-- "nobody has grouped me yet", not a key invented after the fact.
INSERT INTO catchup_work_item_runs (work_item_id, run_id)
    SELECT w.id, w.source_run_id
    FROM catchup_work_items w
    WHERE w.source_run_id IS NOT NULL
    ON CONFLICT (work_item_id, run_id) DO NOTHING;

UPDATE catchup_work_items
    SET group_key = 'run:' || source_run_id::text
    WHERE group_key IS NULL AND source_run_id IS NOT NULL;

-- +goose Down

DROP TABLE IF EXISTS catchup_work_item_runs;
DROP INDEX IF EXISTS catchup_work_items_group_key_idx;
ALTER TABLE catchup_work_items DROP COLUMN IF EXISTS group_key;
