-- 00020 — ADR-0064 (docs/adr/ADR-0064-run-title-and-repository.md): a run
-- serves a title and its repository.
--
-- Forward-only per ADR-0013: nothing here rewrites an earlier row; the Down
-- section exists for test resets only. In particular there is NO backfill:
-- a pre-00020 run has no recorded title, and inventing one from the workflow
-- name or the trigger text would put words on a row that never carried them
-- (the same no-guesses rule that keeps `trigger_ref` null for a manual
-- start). Old rows stay null and the UI keeps its honest fallback.
--
-- What is deliberately NOT here: no `repository_id` column — that already
-- exists (00015, ADR-0060), set by every create path (the explicit body
-- member, the repo-scoped assignment, the issue trigger's repository, the
-- resolved `inputs.repository`); this migration only makes the run READABLE
-- with it on the API (ADR-0064). And no second copy of the issue title: the
-- title is recorded once, at creation, from whatever named the run then —
-- the issue title the trigger fetched, the thread's own title, or the
-- caller's words — and never re-resolved afterwards (the run pins its facts
-- at creation, ADR-0023 § 2).
--
-- The CHECK bounds: 1..200 characters (Postgres `length`, the same bound
-- conversations.title carries at 00003 — one honest width for every human
-- title in the app). Server-derived titles longer than the bound (a GitHub
-- issue title may reach 259 characters) are truncated to 200 characters by
-- the creating writer, never refused: the run must not be lost over the
-- length of its banner.

-- +goose Up

ALTER TABLE runs
    ADD COLUMN title text
        CHECK (title IS NULL OR length (title) BETWEEN 1 AND 200);

-- +goose Down

ALTER TABLE runs DROP COLUMN IF EXISTS title;
