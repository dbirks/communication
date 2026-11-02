-- 00027 — ADR-0071 (docs/adr/ADR-0071-assistant-notes.md): assistant notes.
-- A note is one quiet, model-written suggestion shown to ONE person about ONE
-- repository or ONE thread, with at most one allowlisted action and a
-- `dismiss` that hides it for that person alone.
--
-- The axes this schema holds:
--
--   * the row belongs to a USER, not to a scope. Dismissal is per user, so a
--     note is written once per intended reader and one member hiding a note
--     can never silence advice another member still needs. The alternative
--     (one note per scope, dismissed per user in a child table) stores the
--     same sentence twice over per reader and buys nothing at this size;
--   * `scope_kind` is a two-valued CHECK and `scope_id` carries no foreign
--     key. A uuid that could name either `repositories` or `conversations` is
--     not enforceable by one FK, and a pair of nullable FK columns would make
--     "exactly one is set" a CHECK the reads never use. The write path closes
--     the gap instead: the store admits a note only when the scope id resolves
--     to a row of the named kind INSIDE the note's own project, in the same
--     statement that inserts it, so a dangling or cross-project scope is
--     never written rather than cleaned up afterwards;
--   * `text` is one sentence and is bounded as a database fact (280
--     characters, the design's line width), not a UI convention. It is model
--     output rendered as text;
--   * dismissal and expiry are TIMESTAMPS, not deletes. The panel's content
--     is transient, but "what did the assistant claim at the time" is worth
--     keeping for the generator's own evaluation, so an inactive row is a row
--     with `dismissed_at` set or `expires_at` in the past. Only the
--     per-scope overflow — the note a fourth suggestion displaced — is
--     deleted, because keeping every superseded suggestion would grow the
--     table for content nobody ever saw;
--   * the active index is partial on `dismissed_at IS NULL`: every read in
--     the surface is "this user's live notes in this scope", and the expired
--     residue is not worth an index entry.
--
-- Forward-only per ADR-0013. The Down section exists for test resets only.

-- +goose Up

CREATE TABLE assistant_notes (
    id           uuid        PRIMARY KEY DEFAULT uuidv7(),
    -- Both cascade: a note without its project or its reader is a fact about
    -- nothing, and neither can be deleted while the note is meant to be shown.
    project_id   uuid        NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    user_id      uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    scope_kind   text        NOT NULL CHECK (scope_kind IN ('repository', 'conversation')),
    -- A repositories id when scope_kind = 'repository', a conversations id
    -- when it is 'conversation' (see the header: no FK by design).
    scope_id     uuid        NOT NULL,
    "text"        text       NOT NULL CHECK (length ("text") BETWEEN 1 AND 280),
    -- The allowlisted action object (ADR-0071 § The action union), or NULL
    -- for a note that only says something. The union's SHAPE is checked here
    -- (an object, never an array or a bare string); its vocabulary is checked
    -- by internal/api on the way in, because an allowlist of action kinds is
    -- product vocabulary and belongs with the rest of the contract.
    action       jsonb       CHECK (action IS NULL OR jsonb_typeof (action) = 'object'),
    created_at   timestamptz NOT NULL DEFAULT now(),
    -- Set by the owning user's `dismiss`; never by anybody else.
    dismissed_at timestamptz,
    -- The generator's own horizon: a note about a run that finished is not
    -- worth reading. NULL is "no deadline".
    expires_at   timestamptz,
    -- The write path trims, so a stored sentence never hides its length in
    -- padding: 280 characters means 280 characters of what a reader sees.
    CONSTRAINT assistant_notes_text_is_trimmed CHECK (length (btrim ("text")) = length ("text"))
);

-- Every read of the surface: one user's live notes in one scope. The partial
-- predicate is the whole point — dismissed rows are kept for the record and
-- no read wants them.
CREATE INDEX assistant_notes_active_idx
    ON assistant_notes (user_id, scope_kind, scope_id) WHERE dismissed_at IS NULL;

-- +goose Down

DROP TABLE IF EXISTS assistant_notes;
