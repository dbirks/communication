-- 00011 — ADR-0053 (docs/adr/ADR-0053-run-from-thread.md): a run started from
-- a thread (artboard 5d, "hand to a workflow").
--
-- Forward-only per ADR-0013: nothing here rewrites an earlier row; the Down
-- section exists for test resets only.
--
-- Deliberate placement of invariants (each stated as the lie it makes
-- impossible):
--
--   * source_conversation_id REFERENCES conversations with ON DELETE SET
--     NULL: the run keeps its pinned revision and snapshots even if the
--     thread row is ever gone — the run pinned its own facts at creation
--     (ADR-0023, 12 case 11) and loses only the back-link, which is the
--     honest answer for a deleted thread.
--   * No base_ref / base_commit column on runs: the pinned starting base
--     IS runs.repo_snapshot (ADR-0017's "a commit identity, never a path",
--     03 step 2), written in the same create transaction. A second copy
--     could drift and would answer "what did the run actually start from?"
--     with something other than the column the worker reads.
--   * The partial index serves the conversation detail's linked_runs read
--     (runs WHERE source_conversation_id = $1) without indexing the many
--     ordinary runs that name no thread.

-- +goose Up

ALTER TABLE runs
    ADD COLUMN source_conversation_id uuid REFERENCES conversations (id) ON DELETE SET NULL;

CREATE INDEX runs_source_conversation_idx
    ON runs (source_conversation_id)
    WHERE source_conversation_id IS NOT NULL;

-- +goose Down

DROP INDEX IF EXISTS runs_source_conversation_idx;

ALTER TABLE runs DROP COLUMN IF EXISTS source_conversation_id;
