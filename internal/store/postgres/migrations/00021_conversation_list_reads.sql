-- 00021 — ADR-0065 (docs/adr/ADR-0065-conversation-list-repository-and-last-line.md):
-- the two indexes the `ConversationSummary` list READS (project-scoped
-- `ListConversations` and ADR-0047's cross-project `ListVisibleConversations`)
-- pay their two LATERAL seeks with. No new columns: the repository comes from
-- the workspace binding and the last line from the journal, both already
-- stored; only the access paths were missing.
--
--   * domain_events_conversation_agent_message_idx — the last-agent-line seek:
--     newest `conversation.message.agent` row per conversation
--     (`ORDER BY global_seq DESC LIMIT 1`). 00003's
--     domain_events_conversation_seq_idx covers
--     (conversation_id, global_seq) without the type, so a conversation
--     whose agent never spoke — the exact fallback the field exists for —
--     would walk that conversation's ENTIRE event stream backwards on every
--     list page. The partial index makes the silent-agent probe one empty
--     index seek; conversation.message.agent rows are a small slice of the
--     journal (thoughts, tool updates and turn events stay out), so the
--     index stays cheap to maintain.
--
--   * workspaces_conversation_idx — the repository-binding seek:
--     newest conversation-scoped workspace, any state but `lost`. 00004's
--     workspaces_one_live_per_conversation_idx is partial (live states only),
--     so it cannot answer a read that includes `released` — and a released
--     thread must keep its repository (ADR-0017 D1), which is most of what a
--     thread list shows. Same scan the run-from-thread head pinning already
--     does (m4api_runs_write.go); with the list capped at 100 rows, an
--     indexed seek per row is the bounded database work ADR-0063 asks of a
--     page read.

-- +goose Up

CREATE INDEX domain_events_conversation_agent_message_idx
    ON domain_events (conversation_id, global_seq DESC)
    WHERE type = 'conversation.message.agent';

CREATE INDEX workspaces_conversation_idx
    ON workspaces (conversation_id, created_at DESC, id DESC);

-- +goose Down

DROP INDEX IF EXISTS workspaces_conversation_idx;
DROP INDEX IF EXISTS domain_events_conversation_agent_message_idx;
