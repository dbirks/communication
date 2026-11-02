-- 00023 — ADR-0068 (docs/adr/ADR-0068-per-turn-agent-profile.md): a
-- conversation switches its agent profile BETWEEN turns, every turn records
-- the profile it ran on, and a profile can name the model it pins.
--
-- Forward-only per ADR-0013: nothing here rewrites an earlier row's meaning;
-- the Down section exists for test resets only.
--
--   * agent_profiles.model — the display model the profile pins (04's
--     `model_preference` axis, first cut). Nullable: a profile that names no
--     model is the honest "harness default", not a missing read. The
--     transcript divider ("switched to Codex · gpt-5") and the turn/agent
--     displays render this; nothing in the launch path reads it (the harness
--     still gets its model from the launcher's own configuration), so a wrong
--     value is a display lie, never a behavior change.
--   * conversation_turns.agent_profile_id — the profile the turn ran on,
--     stamped when the turn is enqueued from the conversation's then-current
--     (next-turn) profile. Nullable so pre-migration rows and pre-existing
--     writers keep working; every new write sets it, and readers COALESCE
--     through the conversation's profile, which for a historical row was
--     never mutable (nothing could change it until this migration), so the
--     COALESCE is the recorded answer for those rows, not a guess.
--   * acp_session_bindings.agent_profile_id — which profile launched this
--     session. This is what suppresses resume after a switch: session/load
--     belongs to the harness that made the session, so a switch must launch
--     NEW (ADR-0068); the worker's resume probe only offers bindings stamped
--     with the turn's own profile. Backfilled from the conversation: a live
--     binding's launcher always was its conversation's profile's launcher.
--   * conversations.agent_profile_id KEEPS its column and gains a meaning: it
--     is now the NEXT turn's profile (only the controller may move it, only
--     between turns). Per-turn history lives on the turn rows above.

-- +goose Up

ALTER TABLE agent_profiles
    ADD COLUMN model text CHECK (model IS NULL OR length (model) BETWEEN 1 AND 200);

ALTER TABLE conversation_turns
    ADD COLUMN agent_profile_id uuid REFERENCES agent_profiles (id);

UPDATE conversation_turns t
SET agent_profile_id = c.agent_profile_id
FROM conversations c
WHERE c.id = t.conversation_id AND t.agent_profile_id IS NULL;

CREATE INDEX conversation_turns_agent_profile_idx
    ON conversation_turns (conversation_id, created_at, id);

ALTER TABLE acp_session_bindings
    ADD COLUMN agent_profile_id uuid REFERENCES agent_profiles (id);

UPDATE acp_session_bindings b
SET agent_profile_id = c.agent_profile_id
FROM conversations c
WHERE c.id = b.conversation_id AND b.agent_profile_id IS NULL;

-- +goose Down

ALTER TABLE acp_session_bindings DROP COLUMN IF EXISTS agent_profile_id;
DROP INDEX IF EXISTS conversation_turns_agent_profile_idx;
ALTER TABLE conversation_turns DROP COLUMN IF EXISTS agent_profile_id;
ALTER TABLE agent_profiles DROP COLUMN IF EXISTS model;
