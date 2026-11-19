-- 00035 — ADR-0085 (in-app agent sign-in): the agent_logins request queue and
-- the agent_account_status read side, so an org admin can sign a subscription
-- agent in from the Settings page instead of a production shell.
--
-- What is here and why:
--
--   * agent_logins — one row per sign-in attempt, queued by the control plane
--     and claimed by a worker with the APM-lock idiom (FOR UPDATE SKIP LOCKED
--     + lease; ADR-0054's pattern restated for a login child). The worker that
--     runs the launcher's sign-in child is the one whose credential volume
--     receives the login, so worker_id names it (NULL = any worker; the claim
--     pins it). status walks
--     queued → starting → awaiting_user → (verifying) → succeeded|failed|cancelled|expired.
--     submitted_code is the pasted Antigravity authorization code: the worker
--     reads and clears it in the SAME statement (the code is single-use and
--     PKCE-bound, and an API read of the row never selects it), verification_url
--     and user_code are the provider's display material, and error is a human
--     sentence the store caps at 500 chars — never a code or a token.
--   * the partial unique index: at most one ACTIVE (queued|starting|
--     awaiting_user|verifying) row per (organization_id, launcher,
--     coalesce(worker_id, '')) — the queue refuses a second sign-in for the
--     same launcher (and the same worker, when pinned) by constraint, not by
--     a check-an-then-insert race. A terminal row does not block the next
--     attempt because it is outside the predicate.
--   * agent_account_status — what the Settings page reads, one row per
--     (worker_id, launcher): state, an optional account label, a detail
--     sentence and checked_at. The worker writes it at registration, after
--     every login attempt, and every 10 minutes; a row that never landed reads
--     "unknown" at the API, which is the honest answer, not signed_out.
--     worker_id here is the TEXT form of a workers.id (uuidv7) — the id string
--     the registry hands out at Register — so there is no FK: the column type
--     is text by the ADR and the workers.id is uuid, and an FK needs matching
--     types. A worker deleted from the registry leaves its status rows behind
--     unread (the list keys on LIVE workers), which is the same lifetime rule
--     the APM-lock rows follow.
--
-- Forward-only per ADR-0013: two new tables, nothing existing touched. The Down
-- section exists for test resets only.

-- +goose Up

CREATE TABLE agent_logins (
    id                uuid        PRIMARY KEY DEFAULT uuidv7(),
    organization_id   uuid        NOT NULL REFERENCES organizations (id),
    launcher          text        NOT NULL CHECK (launcher IN ('codex', 'antigravity')),
    worker_id         text,
    status            text        NOT NULL DEFAULT 'queued'
                                        CHECK (status IN ('queued', 'starting', 'awaiting_user',
                                                          'verifying', 'succeeded', 'failed',
                                                          'cancelled', 'expired')),
    verification_url  text,
    user_code         text,
    needs_code        boolean     NOT NULL DEFAULT false,
    submitted_code    text,
    account_label     text,
    error             text,
    requested_by      uuid        NOT NULL REFERENCES users (id),
    claimed_by        text,
    lease_expires_at  timestamptz,
    expires_at        timestamptz NOT NULL,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);

-- One active sign-in per (organization, launcher, worker-or-any). COALESCE to
-- '' is what makes "any worker" participate in the uniqueness: two NULL-worker
-- rows for one launcher are two rows for the same slot, not two slots.
CREATE UNIQUE INDEX agent_logins_one_active_idx ON agent_logins (
    organization_id, launcher, COALESCE(worker_id, '')
) WHERE status IN ('queued', 'starting', 'awaiting_user', 'verifying');

-- The claim scan: oldest active row first, ordered (created_at, id) exactly as
-- ClaimAgentLogin orders it (uuidv7 ids break created_at ties). Expired-lease
-- reclaims ride the same index; the queue is two rows deep in practice.
CREATE INDEX agent_logins_claim_idx ON agent_logins (created_at, id)
    WHERE status IN ('queued', 'starting', 'awaiting_user', 'verifying');

CREATE TABLE agent_account_status (
    -- The workers.id the registry hands out, in text form. See the header: no
    -- FK, because workers.id is a uuid and this column is text by the ADR.
    worker_id     text        NOT NULL,
    launcher      text        NOT NULL CHECK (launcher IN ('codex', 'antigravity')),
    state         text        NOT NULL CHECK (state IN ('signed_in', 'signed_out', 'unknown')),
    account_label text,
    detail        text,
    checked_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (worker_id, launcher)
);

-- +goose Down
-- Test-reset only; production is forward-only (ADR-0013).
DROP TABLE IF EXISTS agent_account_status;
DROP TABLE IF EXISTS agent_logins;
