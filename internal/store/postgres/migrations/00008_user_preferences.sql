-- 00008 — ADR-0046: per-user display preferences
-- (docs/adr/ADR-0046-user-preferences.md).
--
-- One row per users.id holds two JSON documents: the layout preferences the
-- app shell reads and the assistant section (trust level). Both are display
-- preferences only: they authorize nothing and no authorization path reads
-- them, so a save appends no journal event — this is per-user UI state, not
-- shared operational state, and 09's event families are untouched.
--
-- Forward-only per ADR-0013: nothing here rewrites a 00001-00007 row, and the
-- Down section exists for test resets only.
--
-- Deliberate placement of invariants (each stated as the lie it makes
-- impossible):
--
--   * user_id is the PRIMARY KEY referencing users(id): one document per
--     principal, the save is a plain ON CONFLICT (user_id) upsert, and a row
--     can never outlive its user.
--   * NOT NULL DEFAULT '{}' on both documents: a half-written row is
--     impossible, and the reader merges the defaults under whatever is stored
--     (a preference added after the row was written keeps its default).
--   * the jsonb_typeof(object) CHECKs make a non-object column impossible, so
--     the application only ever parses objects.
--   * updated_at is NULL until the first save: the API surfaces that as
--     "never saved", which a NOT NULL DEFAULT now() would hide.

-- +goose Up

CREATE TABLE user_preferences (
    user_id    uuid        PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    layout     jsonb       NOT NULL DEFAULT '{}'::jsonb
               CHECK (jsonb_typeof(layout) = 'object'),
    assistant  jsonb       NOT NULL DEFAULT '{}'::jsonb
               CHECK (jsonb_typeof(assistant) = 'object'),
    updated_at timestamptz
);

-- +goose Down

DROP TABLE user_preferences;
