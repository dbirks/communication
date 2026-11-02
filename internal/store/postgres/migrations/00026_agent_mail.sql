-- 00026 — ADR-0072 (docs/adr/ADR-0072-agent-mail.md): agent mail across
-- repos. A chat's agent may ask the agent of another repository in the SAME
-- project a question; the ask is one journal event, the answer is another,
-- and the relation between the two chats is a `conversation_links` row.
--
-- The axes this schema holds:
--
--   * the project setting `agent_mail_enabled` defaults FALSE — the feature
--     is opt-in per project (design 3d, DECISIONS.md "optional, off by
--     default");
--   * a link is born `asked` and moves to exactly one terminal state
--     (`answered` with an answer, `failed` when the target turn did not
--     answer, `expired` when the answer deadline passed first);
--     `answered` ⇔ (answer IS NOT NULL AND answered_at IS NOT NULL) is a DB
--     CHECK, the conversation_control_single_controller style: a half-answer
--     is unrepresentable rather than merely discouraged;
--   * read-only by default: the target turn carries
--     `permission_override = 'ask'` so every tool call the harness wants
--     permission for is a durable human prompt (ADR-0016's
--     permission_requests), and an unanswered prompt EXPIRES — an edit is
--     only possible when a person says yes. The override column is narrow
--     on purpose: only 'ask' may ever override, so a mailed turn can never
--     be quietly upgraded to a preapproved or autonomous launch;
--   * depth 1: a conversation that is the TARGET of a link never asks
--     (enforced by the claim predicate, backed by the FK here), and a target
--     turn is marked by `mail_link_id` so it cannot itself dispatch mail.
--
-- Forward-only per ADR-0013. The Down section exists for test resets only.

-- +goose Up

ALTER TABLE projects
    ADD COLUMN agent_mail_enabled boolean NOT NULL DEFAULT false;

CREATE TABLE conversation_links (
    id                   uuid        PRIMARY KEY DEFAULT uuidv7(),
    project_id           uuid        NOT NULL REFERENCES projects (id),
    from_conversation_id uuid        NOT NULL REFERENCES conversations (id),
    to_conversation_id   uuid        NOT NULL REFERENCES conversations (id),
    -- The turn that asked and the profile it ran on, kept so the answer can
    -- be delivered back as a follow-up prompt on the asking chat's own
    -- agent. Both are NULL-able only for rows some future non-turn ask (a
    -- human-queued mail) might write; every ADR-0072 row sets them.
    from_turn_id         uuid        REFERENCES conversation_turns (id),
    asked_by             uuid        NOT NULL REFERENCES users (id),
    repo_name            text        NOT NULL CHECK (length (repo_name) BETWEEN 1 AND 200),
    question             text        NOT NULL CHECK (length (question) BETWEEN 1 AND 4096),
    answer               text        CHECK (answer IS NULL OR length (answer) <= 16384),
    reason               text        CHECK (reason IS NULL OR length (reason) <= 512),
    state                text        NOT NULL DEFAULT 'asked'
                         CHECK (state IN ('asked', 'answered', 'failed', 'expired')),
    answer_deadline      timestamptz NOT NULL,
    created_at           timestamptz NOT NULL DEFAULT now(),
    answered_at          timestamptz,
    -- A link never points a conversation at itself, and the two ends always
    -- belong to the same project (the FK on to_conversation_id alone would
    -- allow a cross-project ask otherwise).
    CONSTRAINT conversation_links_not_self CHECK (from_conversation_id <> to_conversation_id),
    -- The honest terminal pair: an answered link carries answer+answered_at;
    -- any other state carries neither.
    CONSTRAINT conversation_links_answer_is_answered CHECK (
        (state = 'answered' AND answer IS NOT NULL AND answered_at IS NOT NULL)
     OR (state <> 'answered' AND answer IS NULL AND answered_at IS NULL)
    ),
    -- A failed/expired link must say why, an asked link says nothing yet.
    CONSTRAINT conversation_links_failure_is_reasoned CHECK (
        (state IN ('failed', 'expired') AND reason IS NOT NULL)
     OR (state NOT IN ('failed', 'expired') AND reason IS NULL)
    )
);

-- The side panel and the per-chat cap both read one chat's links newest
-- first; the cap counts them all.
CREATE INDEX conversation_links_from_idx
    ON conversation_links (from_conversation_id, created_at DESC, id DESC);
CREATE INDEX conversation_links_to_idx
    ON conversation_links (to_conversation_id, created_at DESC, id DESC);
-- The reconciler's mail pass: asked links whose deadline has passed.
CREATE INDEX conversation_links_deadline_idx
    ON conversation_links (answer_deadline, id) WHERE state = 'asked';

-- The target turn of a link. The FK lives only here (never
-- conversation_links.answer_turn_id) so the two tables cannot hold a
-- circular reference; "which turn answers this link" is one query.
ALTER TABLE conversation_turns
    ADD COLUMN mail_link_id uuid REFERENCES conversation_links (id);

-- A narrow per-turn permission-mode override (ADR-0072): only 'ask' may
-- override the profile's mode, and only a mailed turn uses it.
ALTER TABLE conversation_turns
    ADD COLUMN permission_override text
    CHECK (permission_override IS NULL OR permission_override = 'ask');

-- One live answering turn per link: a retry of a failed ask opens a new
-- link, never a second writer on the same one.
CREATE UNIQUE INDEX conversation_turns_mail_link_one_idx
    ON conversation_turns (mail_link_id) WHERE mail_link_id IS NOT NULL;

-- +goose Down

ALTER TABLE conversation_turns DROP COLUMN IF EXISTS permission_override;
ALTER TABLE conversation_turns DROP COLUMN IF EXISTS mail_link_id;
DROP TABLE IF EXISTS conversation_links;
ALTER TABLE projects DROP COLUMN IF EXISTS agent_mail_enabled;
