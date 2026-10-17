-- 00007 — ADR-0039 (Option A): policy-owned permission verdicts on the
-- conversation path (docs/adr/ADR-0039-conversation-policy-permission-verdicts.md).
--
-- The row `permission_requests` (00003) could not hold a policy answer at all:
-- `decided_by` is a `uuid REFERENCES users (id)` and the answered CHECK
-- required a user for every `decided` row, so the worker's policy closes had
-- no honest shape and landed as `cancelled` without an option (deny) or not
-- at all (preapproved). This migration lets the row own a policy verdict:
-- a policy names ITSELF (`decided_by_kind`/`decided_by_policy`) and the
-- chosen option, and the journal's `decided` event names the policy.
--
-- Forward-only per ADR-0013: nothing here rewrites a 00001-00006 row, and
-- the Down section exists for test resets only.
--
-- Deliberate placement of invariants (each stated as the lie it makes
-- impossible):
--
--   * decided_by_kind's NOT NULL DEFAULT 'user' — every existing row is a
--     user's answer (the old CHECK made any other decided shape impossible),
--     so the default IS the backfill; no UPDATE statement is needed and no
--     row can ever be an unnamed decider.
--   * the rewritten permission_request_decision_is_answered — `decided`
--     still requires a named decider (a user OR a policy) AND a chosen
--     option, so "the UI cannot render a decision nobody made" is kept, and
--     `decided_by_kind='policy'` with a NULL `decided_by_policy` is
--     impossible: a policy verdict is attributable by name, not by absence.
--     Non-decided rows still carry no answer at all.
--
-- Deploy order (ADR-0039 Migration/rollback): migration first, worker after —
-- old workers keep writing `cancelled` closes, which the new CHECK still
-- accepts.

-- +goose Up

ALTER TABLE permission_requests
    ADD COLUMN decided_by_kind text NOT NULL DEFAULT 'user'
        CHECK (decided_by_kind IN ('user', 'policy')),
    -- The policy's recorded permission mode (`deny`,
    -- `preapproved_within_sandbox`); NULL unless kind is `policy`.
    ADD COLUMN decided_by_policy text;

ALTER TABLE permission_requests
    DROP CONSTRAINT permission_request_decision_is_answered;
ALTER TABLE permission_requests
    ADD CONSTRAINT permission_request_decision_is_answered CHECK (
        (status = 'decided' AND decision_option_id IS NOT NULL
           AND ((decided_by_kind = 'user'   AND decided_by IS NOT NULL)
             OR (decided_by_kind = 'policy' AND decided_by_policy IS NOT NULL)))
     OR (status <> 'decided' AND decided_by IS NULL
        AND decision_option_id IS NULL AND decided_by_policy IS NULL)
    );

-- +goose Down

ALTER TABLE permission_requests
    DROP CONSTRAINT IF EXISTS permission_request_decision_is_answered;
ALTER TABLE permission_requests
    ADD CONSTRAINT permission_request_decision_is_answered CHECK (
        (status = 'decided'  AND decided_by IS NOT NULL AND decision_option_id IS NOT NULL)
     OR (status <> 'decided' AND decided_by IS NULL     AND decision_option_id IS NULL)
    );
ALTER TABLE permission_requests
    DROP COLUMN IF EXISTS decided_by_policy,
    DROP COLUMN IF EXISTS decided_by_kind;
