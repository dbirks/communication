-- 00013 — ADR-0054 amendment 1 (server-side APM lock, implementation): the
-- lock digest plus the contents summary it was computed from, and the durable
-- queue of lock requests the control plane dispatches to a worker.
--
-- Forward-only per ADR-0013: nothing here rewrites an earlier row's meaning, and
-- the Down section exists for test resets only.
--
--   * agent_profiles.apm_contents_summary jsonb — the names-only lock summary
--     (`{skills, instructions, mcp_servers, truncated}`) computed by the
--     worker's resolve and reported back through the lock result. NULL until a
--     lock has been resolved and reported (ADR-0054: display state; nothing
--     authorizes from it, the launch gate stays the digest column).
--   * apm_lock_requests — the pending/claimed lock dispatch queue. The claim
--     idiom is the worker family's own (FOR UPDATE SKIP LOCKED + lease), the
--     same statement shape the turn and attempt claims use: the loser of a
--     concurrent claim skips the winner's row instead of waiting for it.
--
-- Deliberately NOT here: no retry policy for failed locks beyond the status
-- itself (the operator re-issues `POST .../apm/lock`), no per-request payload
-- storage (the result travels the fenced claim back, never a stored body).

-- +goose Up

ALTER TABLE agent_profiles
    ADD COLUMN apm_contents_summary jsonb;

CREATE TABLE apm_lock_requests (
    id              uuid        PRIMARY KEY DEFAULT uuidv7(),
    organization_id uuid      NOT NULL REFERENCES organizations (id),
    profile_id     uuid        NOT NULL REFERENCES agent_profiles (id),
    package_ref    text        NOT NULL,
    target         text        NOT NULL CHECK (target IN ('claude', 'codex')),
    status         text        NOT NULL DEFAULT 'queued'
                                   CHECK (status IN ('queued', 'claimed', 'done', 'failed')),
    error          text,
    claimed_by     text,
    lease_expires_at timestamptz,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now()
);

-- The due-queue scan: only rows still claimable. A queued row is due; a claimed
-- row is due again once its lease has expired (the same lease arithmetic the turn
-- and attempt claims use), so a worker that died mid-resolve leaves the lock to
-- be retried by whoever next asks for it.
CREATE INDEX apm_lock_requests_claim_idx ON apm_lock_requests (created_at, id) WHERE status = 'queued';

-- +goose Down

DROP TABLE IF EXISTS apm_lock_requests;
ALTER TABLE agent_profiles DROP COLUMN IF EXISTS apm_contents_summary;
