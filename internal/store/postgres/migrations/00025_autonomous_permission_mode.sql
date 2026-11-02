-- 00025 — ADR-0069 (docs/adr/ADR-0069-never-asks-launchers.md): a fourth
-- recorded permission mode, autonomous_within_sandbox, for launchers that
-- never ask (pi-acp@0.0.34 sends no session/request_permission outside its
-- extension-UI handler — docs/compatibility/ACP.md), so the three prompting
-- modes can never be honoured on them and pi runs no turn.
--
-- The mode makes NO review claim: nothing is asked, no verdict row is
-- produced, and the journal/UI wording is "runs without asking; the sandbox
-- is the boundary". That sentence is a security statement, so the pair is
-- enforced here rather than trusted to the writer:
--
--   * the mode joins the permission_mode CHECK (ask, preapproved_within_sandbox,
--     deny unchanged — they stay fail-closed on a launcher that has no
--     verified prompting mode);
--   * autonomous_within_sandbox may only stand beside sandbox_enforcement
--     'required'. A profile row with any other sandbox axis and this mode is
--     refused by the database, exactly as the store refuses it with the named
--     422 code permission_mode_invalid on the version-restore write path.
--
-- Forward-only per ADR-0013: no existing row changes meaning (no row can carry
-- the new mode before this migration). The Down section exists for test resets
-- only.

-- +goose Up
ALTER TABLE agent_profiles
    DROP CONSTRAINT agent_profiles_permission_mode_check;

ALTER TABLE agent_profiles
    ADD CONSTRAINT agent_profiles_permission_mode_check
    CHECK (permission_mode IN ('ask', 'preapproved_within_sandbox', 'deny', 'autonomous_within_sandbox'));

ALTER TABLE agent_profiles
    ADD CONSTRAINT agent_profiles_autonomous_requires_enforced_sandbox
    CHECK (permission_mode <> 'autonomous_within_sandbox' OR sandbox_enforcement = 'required');

-- +goose Down
-- No row rewrite: Down simply restores the older CHECKs, and Postgres refuses
-- the migration while any profile still carries the mode or the pair — the
-- honest failure of a reset that would silently drop a live launch descriptor.
ALTER TABLE agent_profiles
    DROP CONSTRAINT agent_profiles_autonomous_requires_enforced_sandbox;

ALTER TABLE agent_profiles
    DROP CONSTRAINT agent_profiles_permission_mode_check;

ALTER TABLE agent_profiles
    ADD CONSTRAINT agent_profiles_permission_mode_check
    CHECK (permission_mode IN ('ask', 'preapproved_within_sandbox', 'deny'));
