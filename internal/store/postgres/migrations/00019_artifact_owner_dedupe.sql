-- 00019 — ADR-0020 amendment (docs/adr/ADR-0020-artifact-store-and-sandboxed-html-preview.md,
-- "Amendment (2026-10-27) — dedupe is owner-scoped; bytes stay shared"):
-- replace the global artifact dedupe key with owner-scoped ones.
--
-- The defect 00004's UNIQUE (project_id, kind, sha256) allowed: both writers
-- upsert on that key and rewrite the owner columns, so when run B published
-- bytes identical to run A's (the deterministic twin does this every time —
-- same report, same sha256), the ONE row was re-pointed to run B. Run A's
-- artifact list went empty and its `artifact.created` event named an artifact
-- owned by another run. D2's intent was always narrower: a RETRY cannot
-- double-count bytes. Cross-run and cross-turn re-attribution was never
-- intended, so the constraint was wider than the rule.
--
-- New contract, two partial unique indexes that each fold only one writer
-- family's retries:
--
--   * artifacts_run_dedupe_idx — (run_id, node_execution_id, kind, sha256)
--     over the attempt-publish family. The predicate is `attempt_id IS NOT
--     NULL`, not `run_id IS NOT NULL`, because the ADR-0053 run-from-thread
--     attach (m4api_runs_write.go) writes run_id onto TURN-owned rows; those
--     rows must stay in the turn family's dedupe scope, and a row published by
--     an attempt always carries attempt_id while a turn capture never does.
--     attempt_id itself is not in the key: a retried attempt of the same node
--     still folds into the same row (D2), while a different node of the same
--     run — or the same bytes in another run — gets its own row.
--     node_execution_id is nullable, so NULLS NOT DISTINCT (Postgres 18.6 is
--     the pinned server, and 00015 already uses this) makes two node-less
--     attempt publishes of the same bytes inside one run fold like a retry
--     instead of each escaping the index through DISTINCT NULLs. (The flag
--     is spelled only at index creation, after the column list — neither
--     CREATE INDEX's per-column slot nor the ON CONFLICT arbiter grammar
--     accepts it; the writers' arbiters name the index by column list +
--     partial-index predicate, and the index's own NULLS NOT DISTINCT decides
--     what counts as equal.)
--
--   * artifacts_turn_dedupe_idx — (turn_id, kind, sha256) over the
--     turn-capture family. turn_id is the narrowest owner that still dedupes
--     a retry of the SAME capture: PublishArtifact fences on the turn row, a
--     capture retry replays with the same turn_id (the lease re-claim rotates
--     the fencing token on the same turn row; a re-run never reuses a closed
--     turn — agentturn_seams_test pins "each attempt owns its turn"), and
--     turn_id is a globally unique PK, so conversation_id would be a
--     redundant copy of the same fact. Two turns capturing identical bytes
--     are now two rows that each keep their own turn — the defect, fixed.
--
-- Bytes remain content-addressed: both rows reference the SAME storage key,
-- so nothing double-counts storage; a row delete must therefore only delete
-- bytes no other non-deleted row still references (see the amendment's
-- retention rule, enforced by postgres.BytesStillReferenced).
--
-- Forward-only per ADR-0013: the Down section exists for test resets only
-- (it fails, correctly, on a database that now holds owner-distinct rows of
-- identical bytes — reset, do not downgrade).

-- +goose Up

ALTER TABLE artifacts DROP CONSTRAINT artifacts_project_id_kind_sha256_key;

CREATE UNIQUE INDEX artifacts_run_dedupe_idx
    ON artifacts (run_id, node_execution_id, kind, sha256)
    NULLS NOT DISTINCT
    WHERE attempt_id IS NOT NULL;

CREATE UNIQUE INDEX artifacts_turn_dedupe_idx
    ON artifacts (turn_id, kind, sha256)
    WHERE turn_id IS NOT NULL;

-- +goose Down

DROP INDEX IF EXISTS artifacts_turn_dedupe_idx;
DROP INDEX IF EXISTS artifacts_run_dedupe_idx;

ALTER TABLE artifacts
    ADD CONSTRAINT artifacts_project_id_kind_sha256_key
    UNIQUE (project_id, kind, sha256);
