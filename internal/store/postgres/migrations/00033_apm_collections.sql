-- 00033 — ADR-0084 (APM collections): named, pinned skill bundles an agent
-- profile attaches in an order, and the profile's ordered attachment list.
--
-- A profile pinned exactly ONE APM package (ADR-0030 §3). ADR-0084 amends that:
-- a profile attaches an ORDERED list of collections — bundles of pinned
-- skill/instruction/MCP refs — and keeps its own single ref as "extra packages"
-- appended last. The worker flattens the whole set into ONE generated apm.yml,
-- so every invariant that made the single pin trustworthy survives: one lock,
-- one sha256(apm.lock.yaml), one digest per profile, and the launch gate in
-- internal/agent/apm/stage.go untouched.
--
-- What is here and why:
--
--   * apm_collections — the org-scoped library item (slug unique per org, the
--     node_templates rule restated). Display text plus identity; nothing
--     executes from this table.
--   * apm_collection_revisions — one row per revision, UNIQUE
--     (collection_id, revision), status draft|published. `entries` is the
--     ORDERED array [{ref, skills?, note?}]; order is stored because it is
--     load-bearing: two entries shipping one skill name are settled by APM's
--     install order (the last claimant is the lock's active_owner), so the
--     position an entry holds here is the position it holds in the generated
--     manifest. A published revision is immutable — the pipeline rule
--     (ADR-0002), enforced structurally below by a trigger because the API
--     having no mutation route is a convention, not a constraint.
--   * agent_profiles.apm_collections jsonb NOT NULL DEFAULT '[]' — the ordered
--     attachment list [{collection_id, revision}]. NOT NULL with an empty-array
--     default: a profile that never heard of collections reads `[]`, never a
--     third state. The revision is frozen (never "latest") for the reason
--     ADR-0058 freezes everything else — a profile revision must be replayable.
--   * apm_lock_requests.deps jsonb — the flattened dependency list a queued
--     resolve must install. `package_ref` stays (the profile's own extra ref)
--     because every existing row's meaning must stand; `deps` is what the worker
--     resolves from here on. Recording it ON THE REQUEST is the difference
--     between locking what the operator looked at and locking whatever the
--     collection had become by the time a worker got to the row.
--   * agent_profiles.apm_target and apm_lock_requests.target gain
--     'agent-skills': ADR-0084 gives `pi` a target, apm's shared
--     `.agents/skills/` tree. Whether PI READS what lands there is UNVERIFIED
--     (spike A-1, docs/compatibility/APM.md). The CHECK admits a pin shape; it
--     claims nothing about a harness.
--   * the seed rows: the three collections ADR-0084 names, in the default
--     organization. Every seeded ref carries a tag or a 40-character commit, so
--     nothing seeded follows a moving branch. Review conventions is seeded as an
--     empty DRAFT, not an empty published revision: publishing nothing would
--     create an attachable bundle of zero entries, and the point of that
--     collection is the editing a team has not done yet.
--
-- Forward-only per ADR-0013: additive tables plus one new column; a profile with
-- no collections behaves exactly as before (the flatten of `[]` plus the old ref
-- IS the old single-dependency manifest byte for byte). The Down section exists
-- for test resets only.

-- +goose Up

-- Shape helpers. A Postgres CHECK may not contain a subquery and a set-returning
-- function is one, so the jsonb grammar rules live in IMMUTABLE SQL functions the
-- constraints call. They check SHAPE. The ref grammar of ADR-0030 §3 is stated in
-- Go — apm.ValidatePackageRef (the worker's own parser) and
-- postgres.ValidAPMPackageRef (the profile write's) — and applied per element on
-- every write path; the pattern below is the floor that stops nonsense arriving
-- from outside the API (a psql session, a restore, a future importer).

-- +goose StatementBegin
CREATE FUNCTION apm_collection_entries_shape(entries jsonb) RETURNS boolean
    LANGUAGE sql IMMUTABLE AS $$
    SELECT jsonb_typeof(entries) = 'array'
       AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(entries) AS e
            WHERE jsonb_typeof(e) <> 'object'
               OR jsonb_typeof(e -> 'ref') <> 'string'
               OR btrim(e ->> 'ref') = ''
               OR e ->> 'ref' !~ '^[A-Za-z0-9._/-]+#[A-Za-z0-9._/-]+$'
               OR e ->> 'ref' LIKE '%..%'
               OR (e ? 'skills' AND (
                      jsonb_typeof(e -> 'skills') <> 'array'
                   OR EXISTS (SELECT 1 FROM jsonb_array_elements(e -> 'skills') AS s
                              WHERE jsonb_typeof(s) <> 'string'
                                 OR btrim(s #>> '{}') = ''
                                 OR s #>> '{}' !~ '^[A-Za-z0-9._/-]+$')))
               OR (e ? 'note' AND jsonb_typeof(e -> 'note') <> 'string')
       )
    $$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION apm_profile_collections_shape(pins jsonb) RETURNS boolean
    LANGUAGE sql IMMUTABLE AS $$
    SELECT jsonb_typeof(pins) = 'array'
       AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(pins) AS a
            WHERE jsonb_typeof(a) <> 'object'
               OR jsonb_typeof(a -> 'collection_id') <> 'string'
               OR a ->> 'collection_id' !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
               OR jsonb_typeof(a -> 'revision') <> 'number'
               OR (a ->> 'revision')::int < 1
       )
    $$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION apm_lock_deps_shape(deps jsonb) RETURNS boolean
    LANGUAGE sql IMMUTABLE AS $$
    SELECT jsonb_typeof(deps) = 'array'
       AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(deps) AS d
            WHERE jsonb_typeof(d) <> 'object'
               OR jsonb_typeof(d -> 'ref') <> 'string'
               OR d ->> 'ref' !~ '^[A-Za-z0-9._/-]+#[A-Za-z0-9._/-]+$'
               OR (d ? 'skills' AND jsonb_typeof(d -> 'skills') <> 'array')
       )
    $$;
-- +goose StatementEnd

CREATE TABLE apm_collections (
    id              uuid        PRIMARY KEY DEFAULT uuidv7(),
    organization_id uuid        NOT NULL REFERENCES organizations (id),
    slug            text        NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
    name            text        NOT NULL CHECK (length (btrim(name)) BETWEEN 1 AND 200),
    description     text        NOT NULL DEFAULT '' CHECK (length (description) <= 2000),
    -- created_by is TEXT, not a uuid FK: agent_profile_versions.created_by
    -- (00014) already established that a writer column has to be able to name a
    -- writer that is not a user — a worker id, and here a migration. An FK to
    -- users would have made the ADR's own seed rows uninsertable.
    created_by      text        NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT apm_collections_org_slug_unique UNIQUE (organization_id, slug)
);

CREATE INDEX apm_collections_org_idx ON apm_collections (organization_id, slug);

CREATE TABLE apm_collection_revisions (
    id              uuid        PRIMARY KEY DEFAULT uuidv7(),
    collection_id   uuid        NOT NULL REFERENCES apm_collections (id) ON DELETE CASCADE,
    organization_id uuid        NOT NULL REFERENCES organizations (id),
    revision        integer     NOT NULL CHECK (revision >= 1),
    status          text        NOT NULL DEFAULT 'draft'
                                    CHECK (status IN ('draft', 'published')),
    -- The ordered bundle. apm.FlattenProfile renders these entries in this
    -- order into one apm.yml's dependencies.apm list.
    entries         jsonb       NOT NULL DEFAULT '[]'::jsonb
                                    CHECK (apm_collection_entries_shape(entries)),
    created_by      text        NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT apm_collection_revisions_unique UNIQUE (collection_id, revision)
);

CREATE INDEX apm_collection_revisions_collection_idx
    ON apm_collection_revisions (collection_id, revision);

-- A revision's organization is its collection's organization. The FKs can name
-- both tables; only a trigger can say they are the same one.
-- +goose StatementBegin
CREATE FUNCTION apm_collection_revisions_collection_org() RETURNS trigger
    LANGUAGE plpgsql AS $$
BEGIN
    IF (SELECT c.organization_id FROM apm_collections c WHERE c.id = NEW.collection_id) IS DISTINCT FROM NEW.organization_id THEN
        RAISE EXCEPTION 'apm collection revision % names an organization its collection does not belong to', NEW.id
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
-- +goose StatementEnd

CREATE TRIGGER apm_collection_revisions_collection_org_trigger
    BEFORE INSERT OR UPDATE OF collection_id, organization_id ON apm_collection_revisions
    FOR EACH ROW EXECUTE FUNCTION apm_collection_revisions_collection_org();

-- A published revision is immutable (ADR-0002's rule for pipelines, restated for
-- collections by ADR-0084). A draft is editable — that is what "edit the bundle,
-- then publish" means — and publishing flips one column.
-- +goose StatementBegin
CREATE FUNCTION apm_collection_revisions_published_immutable() RETURNS trigger
    LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.status = 'published'
       AND (NEW.entries IS DISTINCT FROM OLD.entries
            OR NEW.collection_id IS DISTINCT FROM OLD.collection_id
            OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
            OR NEW.revision IS DISTINCT FROM OLD.revision) THEN
        RAISE EXCEPTION 'apm collection revision % is published: its entries are frozen (ADR-0084)', OLD.id
            USING ERRCODE = '23514';
    END IF;
    IF OLD.status = 'published' AND NEW.status <> 'published' THEN
        RAISE EXCEPTION 'apm collection revision % is published: it cannot become a draft again', OLD.id
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
-- +goose StatementEnd

CREATE TRIGGER apm_collection_revisions_published_immutable_trigger
    BEFORE UPDATE ON apm_collection_revisions
    FOR EACH ROW EXECUTE FUNCTION apm_collection_revisions_published_immutable();

ALTER TABLE agent_profiles
    ADD COLUMN apm_collections jsonb NOT NULL DEFAULT '[]'::jsonb
        CONSTRAINT agent_profiles_apm_collections_check
        CHECK (apm_profile_collections_shape(apm_collections));

-- Every attachment names a PUBLISHED collection of the profile's OWN
-- organization. Two tables and a jsonb array: no CHECK can say it, so the store
-- checks it in its write (checkProfileAPMCollections) and this trigger is the
-- backstop under a store bug or a hand-written statement — the same division
-- ADR-0061 states for a repository credential. The trigger covers INSERT too (a
-- profile may be created with its attachments already chosen), and note the
-- ordinary Postgres consequence: UPDATE OF a column fires whenever that column
-- appears in the SET list, changed or not — which is why every profile write in
-- this package re-asserts the same pins it just read.
-- +goose StatementBegin
CREATE FUNCTION agent_profiles_apm_collections_scope() RETURNS trigger
    LANGUAGE plpgsql AS $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM jsonb_array_elements(NEW.apm_collections) AS a
        LEFT JOIN apm_collections col ON col.id = (a ->> 'collection_id')::uuid
        LEFT JOIN apm_collection_revisions r
               ON r.collection_id = col.id AND r.revision = (a ->> 'revision')::int
        WHERE col.id IS NULL
           OR col.organization_id <> NEW.organization_id
           OR r.id IS NULL
           OR r.status <> 'published'
    ) THEN
        RAISE EXCEPTION 'agent profile % attaches an apm collection that is outside its organization or is not published', NEW.id
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
-- +goose StatementEnd

CREATE TRIGGER agent_profiles_apm_collections_scope_trigger
    BEFORE INSERT OR UPDATE OF apm_collections ON agent_profiles
    FOR EACH ROW EXECUTE FUNCTION agent_profiles_apm_collections_scope();

-- The lock queue carries the flattened set, not one ref.
ALTER TABLE apm_lock_requests
    ADD COLUMN deps jsonb NOT NULL DEFAULT '[]'::jsonb
        CONSTRAINT apm_lock_requests_deps_check
        CHECK (apm_lock_deps_shape(deps));

-- pi's target is admissible now (ADR-0084). The name is apm's own: the shared
-- `.agents/skills/` tree. Additive — no existing row changes meaning.
ALTER TABLE agent_profiles DROP CONSTRAINT IF EXISTS agent_profiles_apm_target_check;
ALTER TABLE agent_profiles ADD CONSTRAINT agent_profiles_apm_target_check
    CHECK (apm_target IN ('claude', 'codex', 'agent-skills'));

ALTER TABLE apm_lock_requests DROP CONSTRAINT IF EXISTS apm_lock_requests_target_check;
ALTER TABLE apm_lock_requests ADD CONSTRAINT apm_lock_requests_target_check
    CHECK (target IN ('claude', 'codex', 'agent-skills'));

-- --- the seed: the three collections ADR-0084 names ---------------------
--
-- Collection rows first (a revision has nowhere to point without one), then
-- revision 1. All three belong to the `default` organization 00001 seeded; an
-- organization that does not exist seeds nothing rather than failing the
-- migration, because a deployment that renamed or deleted it must still come up.

INSERT INTO apm_collections (organization_id, slug, name, description, created_by)
SELECT o.id, seed.slug, seed.name, seed.description, 'migration:00033'
FROM organizations o
CROSS JOIN (VALUES
    ('matt-pocock-skills', 'Matt Pocock skills',
     'Matt Pocock''s skill set (mattpocock/skills), pinned to one tag: the whole plugin, 27 skills.'),
    ('pstack-claude-code', 'pstack (Claude Code)',
     'Lauren Tan''s pstack (MIT), one ref per skill from cursor/plugins'' generated Claude tree, every ref pinned to commit 63912a9. The router, the core working set and all 24 principle-* skills the router invokes by name; the Cursor-only parts (benny automations, Bugbot, cloud agents) are not here.'),
    ('review-conventions', 'Review conventions',
     'Empty starter for your team''s own review instructions. Add the refs, then publish.')
) AS seed (slug, name, description)
WHERE o.slug = 'default'
  AND NOT EXISTS (SELECT 1 FROM apm_collections c WHERE c.organization_id = o.id AND c.slug = seed.slug);

-- 1. "Matt Pocock skills": the whole plugin set, one pinned tag.
INSERT INTO apm_collection_revisions (collection_id, organization_id, revision, status, entries, created_by)
SELECT c.id, c.organization_id, 1, 'published',
       '[{"ref": "mattpocock/skills#v1.3.2"}]'::jsonb, 'migration:00033'
FROM apm_collections c
WHERE c.slug = 'matt-pocock-skills'
  AND NOT EXISTS (SELECT 1 FROM apm_collection_revisions r WHERE r.collection_id = c.id AND r.revision = 1);

-- 2. "pstack (Claude Code)": consumed per skill from the GENERATED Claude tree
--    (research §2: the plugin itself is a Portable Agent Plugin APM does not
--    dissect, and the generated tree is the one with the Cursor tool names
--    translated). One entry per skill, so one cached clone per skill at the same
--    pinned commit; the order below is the ADR's own order and is stored as
--    written, because it is the order APM will settle a name clash by.
WITH seed AS (
    SELECT c.id AS collection_id, c.organization_id
    FROM apm_collections c
    WHERE c.slug = 'pstack-claude-code'
),
skills (ord, name) AS (VALUES
    (1,  'poteto-mode'),
    (2,  'how'),
    (3,  'why'),
    (4,  'architect'),
    (5,  'interrogate'),
    (6,  'tdd'),
    (7,  'blast-radius'),
    (8,  'unslop'),
    (9,  'recall'),
    (10, 'ketchup'),
    (11, 'teach'),
    (12, 'technical-writing'),
    (13, 'principle-attack-the-premise'),
    (14, 'principle-boundary-discipline'),
    (15, 'principle-build-the-lever'),
    (16, 'principle-encode-lessons-in-structure'),
    (17, 'principle-exhaust-the-design-space'),
    (18, 'principle-experience-first'),
    (19, 'principle-explain-the-number'),
    (20, 'principle-fix-root-causes'),
    (21, 'principle-foundational-thinking'),
    (22, 'principle-guard-the-context-window'),
    (23, 'principle-laziness-protocol'),
    (24, 'principle-make-operations-idempotent'),
    (25, 'principle-migrate-callers-then-delete-legacy-apis'),
    (26, 'principle-minimize-reader-load'),
    (27, 'principle-model-the-domain'),
    (28, 'principle-never-block-on-the-human'),
    (29, 'principle-outcome-oriented-execution'),
    (30, 'principle-prove-it-works'),
    (31, 'principle-redesign-from-first-principles'),
    (32, 'principle-separate-before-serializing-shared-state'),
    (33, 'principle-sequence-verifiable-units'),
    (34, 'principle-subtract-before-you-add'),
    (35, 'principle-test-behavior-not-implementation'),
    (36, 'principle-type-system-discipline')
),
entries AS (
    SELECT jsonb_agg(
               jsonb_build_object(
                   'ref',
                   'cursor/plugins/harness/pstack/claude-code/skills/' || name
                       || '#63912a91d52c43946f974f2aaf661334a6116a82'
               ) ORDER BY ord
           ) AS doc
    FROM skills
)
INSERT INTO apm_collection_revisions (collection_id, organization_id, revision, status, entries, created_by)
SELECT seed.collection_id, seed.organization_id, 1, 'published', entries.doc, 'migration:00033'
FROM seed, entries
WHERE NOT EXISTS (
    SELECT 1 FROM apm_collection_revisions r WHERE r.collection_id = seed.collection_id AND r.revision = 1
);

-- 3. "Review conventions": the empty, editable starter, as a DRAFT. An empty
--    PUBLISHED revision would be an attachable bundle of nothing at all, and the
--    honest state of a bundle nobody has filled in is a draft.
INSERT INTO apm_collection_revisions (collection_id, organization_id, revision, status, entries, created_by)
SELECT c.id, c.organization_id, 1, 'draft', '[]'::jsonb, 'migration:00033'
FROM apm_collections c
WHERE c.slug = 'review-conventions'
  AND NOT EXISTS (SELECT 1 FROM apm_collection_revisions r WHERE r.collection_id = c.id AND r.revision = 1);

-- +goose Down

DROP TRIGGER IF EXISTS agent_profiles_apm_collections_scope_trigger ON agent_profiles;
DROP FUNCTION IF EXISTS agent_profiles_apm_collections_scope();
DROP TRIGGER IF EXISTS apm_collection_revisions_published_immutable_trigger ON apm_collection_revisions;
DROP FUNCTION IF EXISTS apm_collection_revisions_published_immutable();
DROP TRIGGER IF EXISTS apm_collection_revisions_collection_org_trigger ON apm_collection_revisions;
DROP FUNCTION IF EXISTS apm_collection_revisions_collection_org();
DROP FUNCTION IF EXISTS apm_lock_deps_shape(jsonb);
DROP FUNCTION IF EXISTS apm_profile_collections_shape(jsonb);
DROP FUNCTION IF EXISTS apm_collection_entries_shape(jsonb);

ALTER TABLE apm_lock_requests DROP CONSTRAINT IF EXISTS apm_lock_requests_deps_check;
ALTER TABLE apm_lock_requests DROP COLUMN IF EXISTS deps;
ALTER TABLE apm_lock_requests DROP CONSTRAINT IF EXISTS apm_lock_requests_target_check;
ALTER TABLE apm_lock_requests ADD CONSTRAINT apm_lock_requests_target_check
    CHECK (target IN ('claude', 'codex'));
ALTER TABLE agent_profiles DROP CONSTRAINT IF EXISTS agent_profiles_apm_target_check;
ALTER TABLE agent_profiles ADD CONSTRAINT agent_profiles_apm_target_check
    CHECK (apm_target IN ('claude', 'codex'));
ALTER TABLE agent_profiles DROP COLUMN IF EXISTS apm_collections;
DROP TABLE IF EXISTS apm_collection_revisions;
DROP TABLE IF EXISTS apm_collections;
