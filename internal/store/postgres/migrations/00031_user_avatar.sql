-- 00031 — the identity provider's profile picture on the user row.
--
-- The app prints the signed-in person's face where it printed their initials:
-- the sidebar footer, and the new Profile page. The picture is not data this
-- application owns — it belongs to the identity provider, and the person
-- changes it there — so the column is a cache of a claim, refreshed on every
-- login because it may change between logins (the same reason `display_name`
-- and `email` are refreshed by UpsertOIDCUser).
--
--   * NOT NULL with an empty-string default: every existing user gets the
--     empty string rather than a third state, and a login whose provider
--     releases no picture writes it explicitly. Empty means "draw the
--     initials", and the UI has that fallback whether the row was ever touched
--     or not.
--   * users_avatar_url_check: only an https URL or the empty string can be
--     stored. The API already rejects anything else (an http, javascript, data
--     or relative picture claim becomes the empty string), and the app CSP
--     admits https: images only (internal/api/middleware.go), so any other
--     value would be a row no browser could ever draw. The CHECK is what stops
--     a future caller that forgot to sanitize from writing one at all.
--   * length(avatar_url) <= 2048: the same cap a `return_to` path carries
--     (SanitizeReturnTo in internal/api/auth); a picture claim longer than that
--     is not a URL anyone meant to load into an img element.
--
-- Forward-only per ADR-0013: no existing row changes meaning, nothing is
-- rewritten, and the undo pair exists for test resets only. No event is
-- appended — a profile cache is per-user display state, not shared operational
-- state (09's event families are untouched, as with 00008's preferences).

-- +goose Up
ALTER TABLE users
    ADD COLUMN avatar_url text NOT NULL DEFAULT ''
        CONSTRAINT users_avatar_url_check
        CHECK (avatar_url = ''
            OR (avatar_url LIKE 'https://%' AND length(avatar_url) <= 2048));

-- +goose Down
ALTER TABLE users
    DROP COLUMN avatar_url;
