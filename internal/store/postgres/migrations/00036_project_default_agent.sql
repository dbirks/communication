-- 00036 — ADR-0086 (a project's default agent profile): projects gains the one
-- column the redesign's agent chip needs, so a person starting a chat in a
-- project is not asked to pick a profile every time.
--
-- What is here and why:
--
--   * projects.default_agent_profile_id — the project's default agent profile,
--     nullable by design. NULL is "no default", which is a real state and not
--     the same as "some profile": the UI falls back to the person's last choice
--     and then to the first profile, and nothing here may invent a pick a
--     maintainer never made (the same rule projects.color follows, ADR-0078).
--   * ON DELETE SET NULL — deleting a profile clears the default on every
--     project that named it rather than refusing the delete or orphaning the
--     reference. The alternative (RESTRICT) would make profile cleanup a
--     cross-project editing task; the third option (no FK at all) would let a
--     deleted profile's id keep pointing at nothing and surface as a name the
--     read cannot resolve.
--   * No organization-scoping constraint at the row: a cross-organization id
--     is refused by the write path instead. ProjectStore.SetProjectSettings
--     checks the profile belongs to the project's organization in the same
--     transaction and answers the typed error the API maps to
--     400 invalid_agent_profile. A table constraint would need the
--     composite (id, organization_id) uniqueness dance migrations 00015/00022
--     used for repository scoping; the write path is the only way a value gets
--     here, and adding a unique index on agent_profiles for one read-side rule
--     is a bigger schema change than the rule is worth.
--   * Nothing reads the column server-side yet (ADR-0086 § 5): a conversation
--     or a run still names its profile explicitly. This migration is storage
--     and the PATCH that maintains it, not behavior.
--
-- Forward-only per ADR-0003/0013: one new nullable column, no row rewritten, no
-- existing column touched. The Down section exists for test resets only.

-- +goose Up
ALTER TABLE projects
    ADD COLUMN default_agent_profile_id uuid
        REFERENCES agent_profiles (id) ON DELETE SET NULL;

-- +goose Down
-- Test-reset only; production is forward-only (ADR-0013).
ALTER TABLE projects DROP COLUMN IF EXISTS default_agent_profile_id;
