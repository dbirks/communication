-- 00018 — ADR-0056 amendment (docs/adr/ADR-0056-run-triggers.md): the issue
-- trigger's GitHub-clock baseline, `github_created_at`.
--
-- The gap this closes: the `labeled` no-backfill rule (amendment of
-- 2026-10-25) asks "was the label applied at or after the trigger's
-- created_at?" — but the two timestamps answer on different clocks.
-- issue_triggers.created_at is the database's now(); a labeled event's
-- created_at is GitHub's. The gh-loop of 2026-10-25 measured ~50 s of skew
-- on one healthy host (`date -u` read 17:10:50 while GitHub's Date header
-- read 17:10:00): issue #16, labeled AFTER its trigger by GitHub's own
-- clock, compared as "before" and was skipped — and the cursor advanced past
-- it for good. NTP discipline is not a cross-service agreement; a rule that
-- compares two clocks must first put them on one.
--
-- The column stores the trigger's created_at AS MEASURED ON GITHUB'S CLOCK:
-- the first poll whose lister can read GitHub's Date header records
-- created_at - (local_now - github_now) here, and every later labeled-event
-- comparison uses this baseline (never the raw created_at) with a declared
-- tolerance. It is written once (the poll keeps the first armed value), so
-- clock drift after arming can only be noticed, not silently re-baselined.
--
-- NULL means "not yet armed": the row predates this migration, or no poll
-- has read GitHub's clock yet. Until armed, the comparison degrades to the
-- created_at fallback (with the same tolerance) and the poll says so at
-- WARN — the fallback is a declared degradation, not a silent one.
--
-- Forward-only per ADR-0013: the Down section exists for test resets only.

-- +goose Up

ALTER TABLE issue_triggers ADD COLUMN github_created_at timestamptz NULL;

-- +goose Down

ALTER TABLE issue_triggers DROP COLUMN IF EXISTS github_created_at;
