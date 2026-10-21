-- 00010 — ADR-0050 decision 1 (docs/adr/ADR-0050-assistant-v2.md): the
-- assistant v2 per-user tables (ADR-0034's storage clause is amended here —
-- the v1 ask path still stores nothing; these tables serve the new
-- conversation routes only).
--
-- Forward-only per ADR-0013: nothing here rewrites an earlier row; the Down
-- section exists for test resets only.
--
-- Deliberate placement of invariants (each stated as the lie it makes
-- impossible):
--
--   * user_id on assistant_conversations with ON DELETE CASCADE (and the
--     same cascade down messages and changes): a conversation is the
--     signed-in user's, like user_preferences — deleting a user deletes
--     their transcript, and a row can never outlive its user.
--   * kind CHECKs on assistant_messages and assistant_changes: the non-
--     undoable change kinds (navigate, run_start, run_retry,
--     approval_decision, publish) are named explicitly, so a future tool
--     has to name its kind here before it can be recorded.
--   * undo_payload is never returned by a read route (the api layer
--     projects `undoable = undo_payload IS NOT NULL`); the CHECKs keep an
--     undone row undoable-by-design and force navigate rows to carry no
--     inverse op (the UI shows "not undoable").
--   * assistant_messages is an append-only transcript ordered by
--     (created_at, id): uuidv7 is time-ordered, so the index serves both
--     the transcript page and the "most recent conversation" list without
--     an update path — the only in-place updates the ADR allows (an
--     approval_request state, a question answered_by) travel as jsonb
--     payload decisions, not row rewrites.
-- +goose Up

CREATE TABLE assistant_conversations (
    id              uuid        PRIMARY KEY DEFAULT uuidv7(),
    user_id         uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    title           text,                                   -- set from first user message, ≤ 80 chars
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    last_message_at timestamptz
);
CREATE INDEX assistant_conversations_user_recent_idx
    ON assistant_conversations (user_id, last_message_at DESC NULLS LAST);

CREATE TABLE assistant_messages (
    id              uuid        PRIMARY KEY DEFAULT uuidv7(),
    conversation_id uuid        NOT NULL REFERENCES assistant_conversations (id) ON DELETE CASCADE,
    kind            text        NOT NULL
                    CHECK (kind IN ('user','assistant','question','change','approval_request')),
    payload         jsonb       NOT NULL DEFAULT '{}'::jsonb
                    CHECK (jsonb_typeof(payload) = 'object'),
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX assistant_messages_conversation_idx
    ON assistant_messages (conversation_id, created_at, id);

CREATE TABLE assistant_changes (
    id              uuid        PRIMARY KEY DEFAULT uuidv7(),
    conversation_id uuid        NOT NULL REFERENCES assistant_conversations (id) ON DELETE CASCADE,
    user_id         uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    project_id      uuid,                                    -- NULL for org-level actions
    kind            text        NOT NULL
                    CHECK (kind IN ('draft_edit','navigate','run_start','run_retry',
                                    'approval_decision','publish')),
    target_ref      text        NOT NULL,                    -- e.g. "draft:01K…", "run:01K…/test"
    summary         text        NOT NULL,
    undo_payload    jsonb,                                    -- NULL when not undoable
    undone_at       timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CHECK (undone_at IS NULL OR undo_payload IS NOT NULL),
    CHECK (kind <> 'navigate' OR undo_payload IS NULL)
);
CREATE INDEX assistant_changes_conversation_idx ON assistant_changes (conversation_id, id);

-- +goose Down

DROP TABLE assistant_changes;
DROP TABLE assistant_messages;
DROP TABLE assistant_conversations;
