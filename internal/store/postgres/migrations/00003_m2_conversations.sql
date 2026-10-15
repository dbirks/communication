-- 00003 — M2 conversations, controller lock, turn leases and ACP bindings
-- (ADR-0016; communication-spec/01-domain-model.md invariants 2 and 3,
-- 06-collaboration-identity.md "Shared conversation model",
-- 02-system-architecture.md "Scheduling and recovery",
-- 09-api-events-data.md "Database table families").
--
-- Forward-only per ADR-0013; the Down section exists for test resets only.
--
-- Deliberate placement of invariants (what a constraint can and cannot say):
--
--   * "Exactly one controller" (01 invariant 2) — conversation_control's
--     PRIMARY KEY is the conversation id, so a second controller row is
--     impossible, and its CHECK makes "two populated controller ids"
--     impossible too. The *row always existing* cannot be a FK without a
--     cycle, so the create-transaction inserts conversation and control
--     together; ADR-0016 records that as the application-side half.
--   * "Never two prompts into one running turn" — the partial UNIQUE index
--     conversation_turns_one_active_idx. A queued or leased or running turn
--     occupies the conversation; a second enqueue fails with 23505 and the
--     API answers 409.
--   * "Fencing token monotonic" (01 invariant 3) — a dedicated sequence,
--     drawn (never generated) at claim time, so re-leasing after an expired
--     lease strictly increases the token and a stale owner's writes can be
--     rejected by comparing tokens.
--   * "One live agent instance per conversation" — partial UNIQUE index over
--     acp_session_bindings (status = 'connected'); it is also the index the
--     claim query uses to read a conversation's worker affinity.
--   * The transcript is the existing domain_events journal filtered by
--     conversation_id (ADR-0016), which is why domain_events gains a
--     (conversation_id, global_seq) index: the conversation SSE stream needs
--     the same gap-safe key the project stream has (ADR-0014 §9).
--
-- Spec table families (09) are mapped, not copied: `conversation_events` is
-- served by domain_events.conversation_id, `approval_requests` by
-- permission_requests, and `agent_instances`/`agent_capability_snapshots` are
-- collapsed into acp_session_bindings (see ADR-0016 section 10, "Explicitly deferred past M2").

-- +goose Up

-- Org-scoped agent profiles. Pipelines and APM resolve profiles to pinned
-- revisions in later milestones; M2 stores only what a worker needs to launch
-- a harness, and nothing here claims that a launcher works on this host —
-- docs/compatibility/ACP.md is the only place capability evidence lives.
CREATE TABLE agent_profiles (
    id              uuid        PRIMARY KEY DEFAULT uuidv7(),
    organization_id uuid        NOT NULL REFERENCES organizations (id),
    name            text        NOT NULL CHECK (length (name) BETWEEN 1 AND 200),
    -- launcher_id is a key into the agent launcher registry
    -- (internal/agent/acp in M2, worker assets later). Not a foreign key: the
    -- registry is not a table yet, and inventing one now would be a second
    -- source of truth.
    launcher_id     text        NOT NULL CHECK (launcher_id ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
    -- ask = a human decides every ACP permission prompt.
    -- preapproved_within_sandbox may only be used once an enforced sandbox is
    -- verified for that launcher (04-agent-runtime.md "Permission policy",
    -- ADR-0009), which is why both seeded profiles below are 'ask'.
    permission_mode text        NOT NULL DEFAULT 'ask'
                    CHECK (permission_mode IN ('ask', 'preapproved_within_sandbox', 'deny')),
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, name)
);

CREATE INDEX agent_profiles_organization_id_idx ON agent_profiles (organization_id);

-- The two profiles M2 demos with. M0 observed both adapters
-- (docs/compatibility/ACP.md); neither has a verified sandbox, so both ship
-- permission_mode 'ask' and every permission prompt reaches a human.
INSERT INTO agent_profiles (organization_id, name, launcher_id, permission_mode)
VALUES
    ((SELECT id FROM organizations WHERE slug = 'default'), 'Claude Code', 'claude', 'ask'),
    ((SELECT id FROM organizations WHERE slug = 'default'), 'Codex', 'codex', 'ask');

-- Durable, human-visible conversation against one project. It may outlive the
-- agent process, the worker and the ACP session bound to it (01: "may
-- predate/outlive an ACP instance"), so nothing below hangs off it that would
-- die with a process.
CREATE TABLE conversations (
    id               uuid        PRIMARY KEY DEFAULT uuidv7(),
    project_id       uuid        NOT NULL REFERENCES projects (id),
    agent_profile_id uuid        NOT NULL REFERENCES agent_profiles (id),
    title            text        NOT NULL CHECK (length (title) BETWEEN 1 AND 200),
    -- active   = a live agent session is attached
    -- idle     = history exists, nothing is attached or running
    -- disconnected = the session/worker went away with a turn still open;
    --                recovery is honest (02 "Execution recovery semantics")
    -- archived = read-only, no further turns
    status           text        NOT NULL DEFAULT 'idle'
                     CHECK (status IN ('active', 'idle', 'disconnected', 'archived')),
    created_by       uuid        NOT NULL REFERENCES users (id),
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
);

-- Conversation list reads (project timeline, "my conversations"), all newest
-- first with the id as a stable tiebreaker.
CREATE INDEX conversations_project_created_idx ON conversations (project_id, created_at DESC, id DESC);
CREATE INDEX conversations_project_status_idx ON conversations (project_id, status);

-- One row per conversation: who holds the exclusive control lock, and the
-- optimistic-concurrency token every control mutation compares against
-- (06: "acquired via compare-and-swap against conversation_control.version").
CREATE TABLE conversation_control (
    conversation_id           uuid        PRIMARY KEY REFERENCES conversations (id),
    controller_kind           text        NOT NULL DEFAULT 'none'
                              CHECK (controller_kind IN ('none', 'human', 'run_attempt')),
    controller_user_id        uuid        REFERENCES users (id),
    -- M4 fills this in: run attempts do not exist yet, so it stays NULL and no
    -- M2 transition may set controller_kind = 'run_attempt'.
    controller_run_attempt_id uuid,
    previous_controller_user_id uuid      REFERENCES users (id),
    version                   integer     NOT NULL DEFAULT 1 CHECK (version >= 1),
    acquired_at               timestamptz NOT NULL DEFAULT now(),
    updated_at                timestamptz NOT NULL DEFAULT now(),
    -- Exactly one controller, expressed as a state/pointer agreement: the kind
    -- decides which pointer is populated, so 'two simultaneous controllers' is
    -- unrepresentable rather than merely discouraged.
    CONSTRAINT conversation_control_single_controller CHECK (
        (controller_kind = 'human'        AND controller_user_id IS NOT NULL AND controller_run_attempt_id IS NULL)
     OR (controller_kind = 'run_attempt'  AND controller_user_id IS NULL     AND controller_run_attempt_id IS NOT NULL)
     OR (controller_kind = 'none'         AND controller_user_id IS NULL     AND controller_run_attempt_id IS NULL)
    )
);

-- Monotonic ownership counter for turn leases (01 invariant 3). Drawn with
-- nextval() at claim time — never generated per row — so every successful
-- claim of the same turn is strictly greater than the last, and a writer
-- carrying an old token is provably stale.
CREATE SEQUENCE conversation_turn_fencing_seq;

-- The unit of work a worker claims: one prompt and the agent's whole response
-- for it. Turn status is the worker's; control status is the API's; they are
-- separate rows precisely so a takeover can cancel a turn without pretending
-- the turn finished cleanly.
CREATE TABLE conversation_turns (
    id                 uuid        PRIMARY KEY DEFAULT uuidv7(),
    conversation_id    uuid        NOT NULL REFERENCES conversations (id),
    prompt             text        NOT NULL CHECK (length (prompt) BETWEEN 1 AND 65536),
    submitted_by       uuid        NOT NULL REFERENCES users (id),
    status             text        NOT NULL DEFAULT 'queued'
                     CHECK (status IN ('queued', 'leased', 'running',
                                       'completed', 'cancelled', 'failed', 'interrupted')),
    worker_id          uuid        REFERENCES workers (id),
    lease_expires_at   timestamptz,
    fencing_token      bigint      NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
    cancel_requested_at timestamptz,
    -- Harness stop reason verbatim where known (ACP stopReason): end_turn,
    -- max_tokens, max_turn_requests, refusal, cancelled. 'interrupted' turns
    -- carry no stop reason — nothing reported one.
    stop_reason        text,
    created_at         timestamptz NOT NULL DEFAULT now(),
    started_at         timestamptz,
    finished_at        timestamptz,
    -- Only an unclaimed turn may be queued, so an owner can never coexist with
    -- 'queued' (and a claim can never leave a turn ownerless).
    CONSTRAINT conversation_turn_queued_unowned CHECK (status <> 'queued'
           OR (worker_id IS NULL AND lease_expires_at IS NULL AND fencing_token = 0
               AND started_at IS NULL AND finished_at IS NULL)),
    -- A live lease is a full triple: owner, deadline and token together, or a
    -- rejection of the stale owner has nothing to compare.
    CONSTRAINT conversation_turn_lease_is_a_triple CHECK (status NOT IN ('leased', 'running')
           OR (worker_id IS NOT NULL AND lease_expires_at IS NOT NULL AND fencing_token > 0)),
    -- finished_at is both set by and the marker of a terminal status.
    CONSTRAINT conversation_turn_terminal_is_timestamped CHECK ((status IN ('completed', 'cancelled', 'failed', 'interrupted'))
           = (finished_at IS NOT NULL)),
    -- An interrupted turn was not reported by the harness, so it must not
    -- borrow a stop reason from one.
    CONSTRAINT conversation_turn_interrupted_unreasoned CHECK (status <> 'interrupted' OR stop_reason IS NULL)
);

-- 01 invariant 2's execution-side twin and the DB backstop for
-- "never two prompts into one running turn": one non-terminal turn per
-- conversation. Duplicate enqueue -> 23505 -> 409.
CREATE UNIQUE INDEX conversation_turns_one_active_idx
    ON conversation_turns (conversation_id)
    WHERE status IN ('queued', 'leased', 'running');

-- Claim scan: FIFO over queued turns, the only status the claimer reads.
CREATE INDEX conversation_turns_claim_idx ON conversation_turns (created_at, id)
    WHERE status = 'queued';

-- Reconciler scan: expired leases, oldest deadline first.
CREATE INDEX conversation_turns_lease_expiry_idx ON conversation_turns (lease_expires_at, id)
    WHERE status IN ('leased', 'running');

CREATE INDEX conversation_turns_conversation_idx ON conversation_turns (conversation_id, created_at DESC, id DESC);

-- Which agent process served a conversation, and what it negotiated. Its
-- lifetime is the subprocess's; the conversation outlives it, and every row
-- stays as the evidence of what was attached when.
CREATE TABLE acp_session_bindings (
    id                 uuid        PRIMARY KEY DEFAULT uuidv7(),
    conversation_id    uuid        NOT NULL REFERENCES conversations (id),
    worker_id          uuid        NOT NULL REFERENCES workers (id),
    acp_session_id     text        NOT NULL CHECK (acp_session_id <> ''),
    protocol_version   integer     NOT NULL CHECK (protocol_version >= 1),
    -- Agent-reported capabilities from initialize/session/new, stored as
    -- observed. Never a capability claim (04: "Never claim universal support
    -- on the basis of ACP branding alone").
    agent_capabilities jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof (agent_capabilities) = 'object'),
    launcher_id        text        NOT NULL CHECK (launcher_id <> ''),
    launcher_version   text        NOT NULL DEFAULT '',
    -- 'new'      = session/new on a freshly launched process
    -- 'resumed'  = session/load succeeded against a previously advertised
    --              loadSession capability; a failed resume is recorded as a
    --              new session, never as a silent resume
    session_origin     text        NOT NULL DEFAULT 'new'
                     CHECK (session_origin IN ('new', 'resumed')),
    status             text        NOT NULL DEFAULT 'connected'
                     CHECK (status IN ('connected', 'disconnected', 'closed')),
    connected_at       timestamptz NOT NULL DEFAULT now(),
    last_seen_at       timestamptz NOT NULL DEFAULT now(),
    disconnected_at    timestamptz,
    -- disconnected_at marks the end of a binding, so it cannot pre-exist the
    -- 'connected' state nor survive out of it.
    CONSTRAINT acp_session_binding_liveness CHECK ((status = 'connected') = (disconnected_at IS NULL))
);

-- One live agent instance per conversation, and the affinity anchor: the claim
-- query reads this row to decide that a conversation's turns belong to the
-- worker that holds it.
CREATE UNIQUE INDEX acp_session_bindings_one_live_per_conversation_idx
    ON acp_session_bindings (conversation_id)
    WHERE status = 'connected';

CREATE INDEX acp_session_bindings_conversation_idx ON acp_session_bindings (conversation_id, connected_at DESC, id DESC);
CREATE INDEX acp_session_bindings_worker_idx ON acp_session_bindings (worker_id) WHERE status = 'connected';

-- ACP permission prompts, durable and answered by the current controller
-- (06: "Permission prompts arriving from ACP are surfaced to authorized
-- current controller"). Spec 09 calls this family approval_requests; the M2
-- name is recorded in ADR-0016.
CREATE TABLE permission_requests (
    id                 uuid        PRIMARY KEY DEFAULT uuidv7(),
    conversation_id    uuid        NOT NULL REFERENCES conversations (id),
    turn_id            uuid        NOT NULL REFERENCES conversation_turns (id),
    -- The ACP JSON-RPC request id as a string: opaque, harness-owned, and the
    -- key the worker matches an answer to. Not the API's path parameter, which
    -- is id above.
    acp_request_id     text        NOT NULL CHECK (acp_request_id <> ''),
    tool_call_id       text,
    tool_title         text        NOT NULL DEFAULT '',
    tool_kind          text        NOT NULL DEFAULT '',
    -- Options the agent offered, normalised to
    -- [{"option_id":"...","label":"...","kind":"allow_once|..."}]. Bounded by
    -- the worker that writes it; never includes tool input.
    options            jsonb       NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof (options) = 'array'),
    status             text        NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'decided', 'expired', 'cancelled')),
    decided_by         uuid        REFERENCES users (id),
    decision_option_id text,
    -- Answered rows carry the answer; unanswered rows carry nothing, so the
    -- UI cannot render a decision nobody made.
    CONSTRAINT permission_request_decision_is_answered CHECK (
        (status = 'decided'  AND decided_by IS NOT NULL AND decision_option_id IS NOT NULL)
     OR (status <> 'decided' AND decided_by IS NULL     AND decision_option_id IS NULL)
    ),
    requested_at       timestamptz NOT NULL DEFAULT now(),
    deadline_at        timestamptz,
    decided_at         timestamptz,
    -- A prompt is answered once (06: durable human decision request/result).
    UNIQUE (turn_id, acp_request_id)
);

CREATE INDEX permission_requests_pending_idx ON permission_requests (conversation_id, requested_at)
    WHERE status = 'pending';

-- Reconciler scan for prompts nobody will answer anymore.
CREATE INDEX permission_requests_deadline_idx ON permission_requests (deadline_at, id)
    WHERE status = 'pending';

CREATE INDEX permission_requests_turn_idx ON permission_requests (turn_id);

-- The transcript is this journal, conversation-scoped (ADR-0016). The stream
-- needs the same (scope, global_seq) key the project stream has so replay and
-- gap-safety work identically (ADR-0014 §9).
CREATE INDEX domain_events_conversation_seq_idx ON domain_events (conversation_id, global_seq);

-- +goose Down
-- Test-reset only; production is forward-only (ADR-0013). Child tables first;
-- indexes travel with their table.
DROP INDEX IF EXISTS domain_events_conversation_seq_idx;
DROP TABLE IF EXISTS permission_requests;
DROP TABLE IF EXISTS acp_session_bindings;
DROP TABLE IF EXISTS conversation_turns;
DROP SEQUENCE IF EXISTS conversation_turn_fencing_seq;
DROP TABLE IF EXISTS conversation_control;
DROP TABLE IF EXISTS conversations;
DROP TABLE IF EXISTS agent_profiles;
