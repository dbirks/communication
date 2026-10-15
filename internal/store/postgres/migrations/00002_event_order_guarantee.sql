-- 00002 — the journal's commit-order guarantee (ADR-0014 §9).
--
-- domain_events.global_seq is allocated by an IDENTITY at INSERT time, so a
-- lower sequence value can commit *after* a higher one. A reader that
-- remembers "the highest sequence I have sent" and asks for rows above it
-- would then skip the late committer forever: LISTEN/NOTIFY being only a
-- wake-up makes this invisible to the caller.
--
-- tx_id records the PostgreSQL transaction that inserted the row, and lets a
-- reader emit only rows whose inserting transaction was already determined
-- (committed or aborted) when the read snapshot was taken:
--
--     WHERE tx_id < pg_snapshot_xmin(pg_current_snapshot())
--
-- Anything at or above the snapshot's xmin may still belong to a transaction
-- that will later insert a *smaller* sequence value, so it is withheld until
-- the next snapshot settles it. See ADR-0014 §9 for the full argument and the
-- writer-side advisory lock that closes the remaining reordering window.

-- +goose Up

ALTER TABLE domain_events
    ADD COLUMN tx_id xid8 NOT NULL DEFAULT pg_current_xact_id();

-- +goose Down
-- Test-reset only; production is forward-only (ADR-0013).
ALTER TABLE domain_events DROP COLUMN IF EXISTS tx_id;
