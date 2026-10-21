-- 00009 — ADR-0049 § 1 (docs/adr/ADR-0049-step-registry-and-folders.md):
-- the node-template ("Step") registry (spec 01:17, 09:54) and workflow
-- folders.
--
-- Forward-only per ADR-0013: nothing here rewrites an earlier row; the Down
-- section exists for test resets only.
--
-- Deliberate placement of invariants (each stated as the lie it makes
-- impossible):
--
--   * node_templates slug CHECK + UNIQUE (organization_id, slug): a template
--     is addressed by slug in a pipeline node's `template: slug@semver`
--     reference, and two templates in one organization can never share a
--     name (the reference would be ambiguous).
--   * node_template_revisions carries NO UPDATE path in the application:
--     immutability is structural, as in pipeline_revisions (00005) — a new
--     version is a new row, a published one is never rewritten (ADR-0002).
--   * UNIQUE (template_id, revision_number) and (template_id,
--     version_label): the revision number is monotonic per template and the
--     semver label is unique per template (07's semver), so a publish can
--     never silently reuse either.
--   * revision_digest CHECK: the digest is always the sha256 scope form, so
--     a row cannot claim a digest the canonicalizer never produced
--     (ADR-0021, scope v1alpha1-canonical-1). Unlike pipeline_revisions
--     there is NO organization-wide digest uniqueness: identical content in
--     two templates is legitimate (it is exactly what :duplicate produces).
--   * pipeline_revision_template_refs PRIMARY KEY
--     (pipeline_revision_id, node_id, template_id): a node references a
--     template at most once, and the row is written in the same
--     transaction as the pipeline_revisions row (ON DELETE CASCADE keeps a
--     deleted revision from leaving orphan references).
--   * pipelines.folder: a plain display string (design 3a) — no folder
--     entity, no per-folder permissions (a new ADR if they appear);
--     NULL = unfiled, the API never special-cases an empty string.

-- +goose Up

CREATE TABLE node_templates (
    id               uuid        PRIMARY KEY DEFAULT uuidv7(),
    organization_id  uuid        NOT NULL REFERENCES organizations (id),
    slug             text        NOT NULL CHECK (slug ~ '^[a-z][a-z0-9.-]{0,127}$'),  -- = metadata.name in YAML
    display_name     text        NOT NULL CHECK (length (display_name) BETWEEN 1 AND 200),
    kind             text        NOT NULL,          -- the implemented kind, e.g. agent.acp
    description      text        NOT NULL DEFAULT '',
    status           text        NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
    created_by       uuid        NOT NULL REFERENCES users (id),
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, slug)
);

-- Immutability is structural, as in pipeline_revisions (00005): no UPDATE
-- path to the content columns, the API has no mutation route, and pipeline
-- revisions pin a row here.
CREATE TABLE node_template_revisions (
    id               uuid        PRIMARY KEY DEFAULT uuidv7(),
    template_id      uuid        NOT NULL REFERENCES node_templates (id),
    organization_id  uuid        NOT NULL REFERENCES organizations (id),
    revision_number  integer     NOT NULL CHECK (revision_number >= 1),
    version_label    text        NOT NULL CHECK (version_label ~ '^\d+\.\d+\.\d+$'),  -- 07's semver
    parameters       jsonb       NOT NULL CHECK (jsonb_typeof (parameters) = 'object'),
    config           jsonb       NOT NULL CHECK (jsonb_typeof (config) = 'object'),
    output_schema    jsonb       NOT NULL DEFAULT '{}'::jsonb
                       CHECK (jsonb_typeof (output_schema) = 'object'),
    workspace_mode   text        NOT NULL DEFAULT 'run_workspace'
                       CHECK (workspace_mode IN ('run_workspace','read_only')),
    revision_digest  text        NOT NULL CHECK (revision_digest ~ '^sha256:[0-9a-f]{64}$'),
    created_by       uuid        NOT NULL REFERENCES users (id),
    created_at       timestamptz NOT NULL DEFAULT now(),
    UNIQUE (template_id, revision_number),
    UNIQUE (template_id, version_label)
);
CREATE INDEX node_template_revisions_template_idx
    ON node_template_revisions (template_id, revision_number DESC);

-- Written at publish time (same transaction as the pipeline_revisions row);
-- the source of truth for "used in N workflows" (ADR-0049 § 3/§ 4).
CREATE TABLE pipeline_revision_template_refs (
    pipeline_revision_id uuid NOT NULL REFERENCES pipeline_revisions (id) ON DELETE CASCADE,
    template_id          uuid NOT NULL REFERENCES node_templates (id),
    template_revision_id uuid NOT NULL REFERENCES node_template_revisions (id),
    node_id              text NOT NULL,
    PRIMARY KEY (pipeline_revision_id, node_id, template_id)
);
CREATE INDEX ptr_refs_template_idx
    ON pipeline_revision_template_refs (template_id, pipeline_revision_id);

-- Workflow folders (design 3a).
ALTER TABLE pipelines ADD COLUMN folder text
    CHECK (folder IS NULL OR length (folder) BETWEEN 1 AND 200);

-- +goose Down

DROP TABLE pipeline_revision_template_refs;
DROP TABLE node_template_revisions;
DROP TABLE node_templates;
ALTER TABLE pipelines DROP COLUMN folder;
