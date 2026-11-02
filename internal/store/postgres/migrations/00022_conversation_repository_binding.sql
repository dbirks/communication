-- 00022 — ADR-0067 (docs/adr/ADR-0067-repo-scoped-conversations.md): a
-- conversation may be born bound to ONE repository of its project.
--
-- Forward-only per ADR-0013: nothing here rewrites an earlier row; the Down
-- section exists for test resets only. No backfill: a pre-00022 conversation
-- was never asked which repository it was opened FOR — its repository stays
-- whatever ADR-0065 derives (workspace binding, else the linked run's), and
-- the new column is NULL there. Inventing a binding from a later workspace
-- would put a choice on a row that never carried one.
--
-- The column is the DECLARED binding, recorded once at create (the repo
-- page's chat box starts "a conversation scoped to this repo"): unlike the
-- ADR-0065 derivation it exists before any workspace or run has said where
-- the work happened, and it never drifts with the volume. The list READs
-- resolve it first and fall back to the derivation, so one
-- `repository_id`/`repository_name` pair keeps its ADR-0065 meaning plus this
-- arm (COALESCE over the binding, the workspace, the run — one column list,
-- both list READS, still no second query).
--
-- The composite foreign key (the 00015 assignments precedent) makes "the
-- repository belongs to THIS conversation's project" a database fact, not a
-- caller's promise; the create path still resolves name → id by
-- repositories (project_id, name) to answer 422 rather than a constraint
-- violation. The referenced key (id, project_id) has been unique since
-- 00012's repositories_id_project_unique — the same cover the 00015/00012
-- composite run-side keys already use, so this migration adds no index.
-- No index on the new column for filtering either: the filter rides the list
-- statement's existing conversations_project_created_idx scan capped at 100
-- rows (ADR-0063); EXPLAIN on a populated table drove the decision, recorded
-- in ADR-0067.

-- +goose Up

ALTER TABLE conversations
    ADD COLUMN repository_id uuid;

ALTER TABLE conversations
    ADD CONSTRAINT conversations_repository_fk
        FOREIGN KEY (repository_id, project_id)
        REFERENCES repositories (id, project_id);

-- +goose Down

ALTER TABLE conversations
    DROP CONSTRAINT IF EXISTS conversations_repository_fk;

ALTER TABLE conversations
    DROP COLUMN IF EXISTS repository_id;
