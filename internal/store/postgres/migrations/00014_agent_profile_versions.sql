-- 00014 — ADR-0058 (versioned agent profiles, part 1): the profile version
-- history and the optimistic-concurrency token.
--
-- Forward-only per ADR-0013: nothing here rewrites an earlier row's meaning, and
-- the Down section exists for test resets only.
--
--   * agent_profiles.version int NOT NULL DEFAULT 1 — the CURRENT version of
--     the profile, carried as the optimistic-concurrency token (ADR-0030:62 said
--     "no optimistic version token"; ADR-0058 amends that with the token *and*
--     the history it unlocks). Writes that carry a version the row no longer has
--     answer 409 instead of overwriting somebody else's work.
--   * agent_profile_versions — the append-only history: one row per version
--     with the frozen launch-descriptor snapshot, the writer, the note and the
--     timestamp. UNIQUE (profile_id, version) makes a version a key into history,
--     never a mutable row; restoring version n is a NEW write whose snapshot
--     equals n, and history stays append-only.
--   * conversations.agent_profile_version / runs.agent_profile_version —
--     the pin a conversation (and the run it sources) was created against, read
--     off the profile's current version at creation. The conversation is the
--     resolution root the worker's ProfileFor joins through, so the pin is the
--     least invasive place the version can be recorded.
--
-- Backfill: every profile that already existed (the M2 seeds, plus anything a
-- lab operator created before the versioning ADR) starts at version 1 with a
-- v1 snapshot of its then-current state, so the history is complete from the
-- first versioned read and the token is never NULL.

-- +goose Up

ALTER TABLE agent_profiles
    ADD COLUMN version int NOT NULL DEFAULT 1;

CREATE TABLE agent_profile_versions (
    id              uuid        PRIMARY KEY DEFAULT uuidv7(),
    profile_id     uuid        NOT NULL REFERENCES agent_profiles (id),
    organization_id uuid      NOT NULL REFERENCES organizations (id),
    version         int         NOT NULL CHECK (version >= 1),
    snapshot        jsonb       NOT NULL,
    created_by      text        NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    note            text
);

CREATE UNIQUE INDEX agent_profile_versions_profile_version_idx
    ON agent_profile_versions (profile_id, version);

CREATE INDEX agent_profile_versions_profile_idx
    ON agent_profile_versions (profile_id, version);

-- The backfill: version 1 for every existing profile, frozen at its current
-- state. created_by is NOT NULL and the pre-versioning table carried no writer
-- column of its own, so the migration names the migration itself as the writer
-- of the bootstrap version.
INSERT INTO agent_profile_versions (profile_id, organization_id, version, snapshot, created_by, created_at)
SELECT p.id, p.organization_id, 1,
       jsonb_build_object(
           'name', p.name,
           'launcher_id', p.launcher_id,
           'permission_mode', p.permission_mode,
           'apm_package_ref', p.apm_package_ref,
           'apm_target', p.apm_target,
           'apm_lock_digest', p.apm_lock_digest
       ),
       'migration', now()
FROM agent_profiles p;

ALTER TABLE conversations
    ADD COLUMN agent_profile_version int NOT NULL DEFAULT 1;

ALTER TABLE runs
    ADD COLUMN agent_profile_version int NOT NULL DEFAULT 1;

-- +goose Down

DROP TABLE IF EXISTS agent_profile_versions;
ALTER TABLE conversations DROP COLUMN IF EXISTS agent_profile_version;
ALTER TABLE runs DROP COLUMN IF EXISTS agent_profile_version;
ALTER TABLE agent_profiles DROP COLUMN IF EXISTS version;
