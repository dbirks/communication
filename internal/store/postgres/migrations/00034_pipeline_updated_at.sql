-- 00034 — assistant exercise 2026-11-11 F-6 remainder: pipelines.updated_at.
--
-- workflow.list answers "what changed in workflows this week?" and could say
-- nothing about WHEN: the library row had no date at all, so prompt 18's
-- "nothing published, nothing assigned" was true while the workflow and its
-- draft had been created the same day. The definition row is the right owner
-- of that clock — drafts and revisions carry their own timestamps, but the
-- question is asked about the workflow.
--
-- Semantics: pipelines.updated_at is the newest write the pipeline store made
-- for this definition — create (the column default), metadata PATCH/archive
-- (the UPDATE itself), draft save, publish, revision deprecation and
-- assignment create/update/delete (each re-stamps the definition inside its
-- own transaction). The store owns the stamping; no trigger hides it.
--
-- Forward-only per ADR-0013: one additive column. The Down section exists for
-- test resets only.

-- +goose Up

ALTER TABLE pipelines ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

-- History the column never kept: the newest honest stamp a pre-existing row
-- can carry is the later of its birth and its latest published revision;
-- a pipeline with no revisions is only ever as new as its created_at.
UPDATE pipelines p
SET updated_at = GREATEST(
    p.created_at,
    COALESCE((SELECT max(pr.published_at) FROM pipeline_revisions pr
              WHERE pr.pipeline_id = p.id), p.created_at)
);

-- +goose Down

ALTER TABLE pipelines DROP COLUMN IF EXISTS updated_at;
