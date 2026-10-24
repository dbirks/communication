-- 00015 — ADR-0060 (docs/adr/ADR-0060-repo-attachments.md): repo attachments.
--
-- Forward-only per ADR-0013: nothing here rewrites an earlier row's meaning;
-- the Down section exists for test resets only.
--
-- An assignment may name ONE repository of its project (ADR-0060): NULL means
-- the whole project, which is what every pre-00015 row meant. Uniqueness moves
-- from the old (project_id, pipeline_id) pair to (project_id, pipeline_id,
-- repository_id) with NULLS NOT DISTINCT, so a repository pin and a project-wide
-- pin of one pipeline coexist while a duplicate of either is refused.
--
-- The run-side column is the repository a run works on (ADR-0060): set at insert,
-- never later; the create paths resolve it (explicit body member, the
-- assignment's repository, the issue trigger's repository, an inputs.repository
-- name) before the run insert.

-- +goose Up

ALTER TABLE assignments
    ADD COLUMN repository_id uuid;

ALTER TABLE assignments
    ADD CONSTRAINT assignments_repository_fk
        FOREIGN KEY (repository_id, project_id)
        REFERENCES repositories (id, project_id);

ALTER TABLE assignments
    DROP CONSTRAINT assignments_project_id_pipeline_id_key;

CREATE UNIQUE INDEX assignments_project_pipeline_repository_uniq
    ON assignments (project_id, pipeline_id, repository_id)
    NULLS NOT DISTINCT;

ALTER TABLE runs
    ADD COLUMN repository_id uuid;

ALTER TABLE runs
    ADD CONSTRAINT runs_repository_fk
        FOREIGN KEY (repository_id) REFERENCES repositories (id);

CREATE INDEX runs_project_repository_created_idx
    ON runs (project_id, repository_id, created_at DESC);

-- +goose Down

DROP INDEX IF EXISTS runs_project_repository_created_idx;

ALTER TABLE runs
    DROP CONSTRAINT IF EXISTS runs_repository_fk;

ALTER TABLE runs
    DROP COLUMN IF EXISTS repository_id;

ALTER TABLE assignments
    DROP CONSTRAINT IF EXISTS assignments_repository_fk;

CREATE UNIQUE INDEX assignments_project_id_pipeline_id_key
    ON assignments (project_id, pipeline_id);
