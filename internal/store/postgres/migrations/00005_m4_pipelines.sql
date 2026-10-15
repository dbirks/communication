-- 00005 — M4 pipelines, runs, node executions and attempts
-- (docs/m4-contract.md § 1; ADR-0021 canonicalization and revision digests,
-- ADR-0022 the CEL binding subset, ADR-0023 the execution model, ADR-0024 the
-- node-kind scope; communication-spec/01-domain-model.md invariants 1/3/4/6,
-- 02-system-architecture.md "Scheduling and recovery", 03, 09, 12 cases
-- 1/2/3/5/7/8/11).
--
-- Forward-only per ADR-0013: no statement here rewrites a 00001-00004 row, and
-- the Down section exists for test resets only.
--
-- Deliberate placement of invariants (each CHECK is stated as the lie it makes
-- impossible):
--
--   * pipeline_revisions (organization_id, revision_digest) UNIQUE — `09`'s
--     "Published revision hash unique in organization": a double publish is a
--     23505 the API answers 409 revision_already_published, never a second row.
--   * runs_root_is_unparented — depth and parent_run_id cannot disagree, so a
--     child-run tree is navigable from either side (ADR-0023 § 10).
--   * node_executions_control_plane_never_leased — ADR-0023 § 3's two-path
--     state machine made structural: control-plane work moves
--     pending -> ready -> succeeded inside the advancer and can never occupy a
--     lease or a running slot (contract § 5: the advance happens with NO
--     attempts row, and the DB refuses the row that pretends otherwise).
--   * attempts_run_matches_node_execution — the composite FK to
--     node_executions (id, run_id) makes an attempt's run agree with its node
--     execution, which is how `09`'s UNIQUE (run_id, node_instance_key,
--     attempt_number) is enforced transitively (contract § 1's comment).
--   * attempts_queued_unowned / attempts_lease_is_a_triple /
--     attempts_terminal_timestamped — the same three lease lies ADR-0016
--     rejects for conversation_turns, now on the attempt table: an owned
--     queued row, a leased row missing any member of (worker, deadline, token),
--     a terminal row without finished_at. attempt_fencing_seq is drawn at claim
--     time only, never per row (ADR-0016 § 3), so the triple is comparable and
--     stale writers are rejectable (12 case 3).
--   * attempts_succeeded_has_outputs / attempts_failed_has_class — 01
--     invariant 4: success carries a validated envelope (possibly {}), failure
--     names its class (ADR-0023 § 7's enum) so backoff and reporting key on it.
--   * conversation_turns.node_attempt_id + attempts_agent_turn_pair — 01
--     invariant 3 across BOTH leases of an agent attempt (ADR-0023 § 4): M2-era
--     turns stay NULL and keep claiming as before; a row that names a turn
--     without its conversation (or the reverse) cannot exist.
--   * approval_requests UNIQUE (node_execution_id) — one live gate per node
--     execution, and approvals_decided_consistency refuses a decision nobody
--     made or a "decided" row with nothing decided (ADR-0023 § 9).
--   * pipeline_invocations keyed by node_execution_id, never attempt_id —
--     ADR-0023 § 3/§ 10 make pipeline.invoke control-plane work that creates no
--     attempt row (ADR-0023's 2026-10-15 amendment; contract § 9.1 row 20).
--
-- What is deliberately NOT here: no column that can hold a secret value, no
-- absolute workspace path (checkpoints carry volume_id + workspace_id, M3's
-- honest identity), and no second journal — every run/node/attempt transition
-- appends to domain_events in the same transaction as the state write, now with
-- the three correlation columns this migration adds.

-- +goose Up

-- ADR-0021 § 2/§ 5/§ 6: definitions, drafts, immutable published revisions.
CREATE TABLE pipelines (
    id              uuid        PRIMARY KEY DEFAULT uuidv7(),
    organization_id uuid        NOT NULL REFERENCES organizations (id),
    slug            text        NOT NULL CHECK (slug ~ '^[a-z][a-z0-9.-]{0,127}$'),
    display_name    text        NOT NULL DEFAULT '',
    description     text        NOT NULL DEFAULT '',
    created_by      uuid        NOT NULL REFERENCES users (id),
    created_at      timestamptz NOT NULL DEFAULT now(),
    archived_at     timestamptz,
    UNIQUE (organization_id, slug)
);

-- A draft is the only mutable pipeline object. document_text is what the author wrote;
-- canonical_document is ADR-0021 § 5's output (metadata.ui DELETED, NFC applied).
CREATE TABLE pipeline_drafts (
    id                uuid        PRIMARY KEY DEFAULT uuidv7(),
    pipeline_id       uuid        NOT NULL REFERENCES pipelines (id),
    status            text        NOT NULL DEFAULT 'draft'
                                CHECK (status IN ('draft','validating','valid','invalid','published')),
    document_text     text        NOT NULL CHECK (length (document_text) BETWEEN 1 AND 262144),
    source_kind       text        NOT NULL DEFAULT 'manual'
                                CHECK (source_kind IN ('manual','yaml_import','assistant','clone')),
    source_sha256     text        NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
    canonical_document jsonb,
    ui_layout         jsonb       NOT NULL DEFAULT '{}'::jsonb,   -- metadata.ui: served, never digested
    revision_digest   text        CHECK (revision_digest IS NULL
                                          OR revision_digest ~ '^sha256:[0-9a-f]{64}$'),
    compiled_plan     jsonb,
    plan_digest       text        CHECK (plan_digest IS NULL
                                          OR plan_digest ~ '^sha256:[0-9a-f]{64}$'),
    digest_scope      text        NOT NULL DEFAULT 'v1alpha1-canonical-1',
    validation        jsonb       NOT NULL DEFAULT '[]'::jsonb,   -- last validate body (§ 2)
    version           integer     NOT NULL DEFAULT 1 CHECK (version >= 1),
    edited_by         uuid        NOT NULL REFERENCES users (id),
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pipeline_drafts_pipeline_idx ON pipeline_drafts (pipeline_id, updated_at DESC, id DESC);

-- Immutability is structural: no UPDATE is granted a path to these columns, the API has no
-- mutation route, and a run pins a row here (ADR-0002).
CREATE TABLE pipeline_revisions (
    id                uuid        PRIMARY KEY DEFAULT uuidv7(),
    pipeline_id       uuid        NOT NULL REFERENCES pipelines (id),
    draft_id          uuid        NOT NULL REFERENCES pipeline_drafts (id),
    organization_id   uuid        NOT NULL REFERENCES organizations (id),
    revision_number   integer     NOT NULL CHECK (revision_number >= 1),
    version_label     text        NOT NULL CHECK (version_label ~ '^\d+\.\d+\.\d+$'),  -- 07's semver
    api_version       text        NOT NULL CHECK (api_version = 'communication.dev/v1alpha1'),
    canonical_document jsonb      NOT NULL,
    document_text     text        NOT NULL,           -- regenerated from canonical_document, never re-hashed
    ui_layout         jsonb       NOT NULL DEFAULT '{}'::jsonb,
    revision_digest   text        NOT NULL CHECK (revision_digest ~ '^sha256:[0-9a-f]{64}$'),
    digest_scope      text        NOT NULL DEFAULT 'v1alpha1-canonical-1',
    compiled_plan     jsonb       NOT NULL CHECK (jsonb_typeof (compiled_plan) = 'object'),
    plan_digest       text        NOT NULL CHECK (plan_digest ~ '^sha256:[0-9a-f]{64}$'),
    schema_digest     text        NOT NULL CHECK (schema_digest ~ '^sha256:[0-9a-f]{64}$'),
    cel_env_digest    text        NOT NULL CHECK (cel_env_digest ~ '^sha256:[0-9a-f]{64}$'),
    status            text        NOT NULL DEFAULT 'published' CHECK (status IN ('published','deprecated')),
    published_by      uuid        NOT NULL REFERENCES users (id),
    published_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (pipeline_id, revision_number),
    UNIQUE (pipeline_id, version_label),
    UNIQUE (organization_id, revision_digest)   -- 09: "Published revision hash unique in organization"
);
CREATE INDEX pipeline_revisions_pipeline_idx ON pipeline_revisions (pipeline_id, revision_number DESC);

-- The draft -> revision pointer closes the loop, so it is added after the revisions exist.
-- (The contract's DDL names only the FK; the column itself travels with it — an FK cannot
-- reference a column nobody created.)
ALTER TABLE pipeline_drafts ADD COLUMN published_revision_id uuid;
ALTER TABLE pipeline_drafts
    ADD CONSTRAINT pipeline_drafts_published_revision_fk
    FOREIGN KEY (published_revision_id) REFERENCES pipeline_revisions (id);

-- `runs.assignment_id` (ADR-0023 § 1) needs a target, and § 5's concurrency layers name "the
-- assignment's limit". M4's assignment is a pin plus budgets: NO triggers, NO stable/beta channels,
-- NO promote/preview (all M6, `07` "Version rollout").
CREATE TABLE assignments (
    id                  uuid        PRIMARY KEY DEFAULT uuidv7(),
    project_id          uuid        NOT NULL REFERENCES projects (id),
    pipeline_id         uuid        NOT NULL REFERENCES pipelines (id),
    pinned_revision_id  uuid        NOT NULL REFERENCES pipeline_revisions (id),
    max_concurrent_runs integer     NOT NULL DEFAULT 1 CHECK (max_concurrent_runs BETWEEN 1 AND 8),
    budget_overrides    jsonb       NOT NULL DEFAULT '{}'::jsonb,  -- ceilings only, never raises a limit
    enabled             boolean     NOT NULL DEFAULT true,
    version             integer     NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_by          uuid        NOT NULL REFERENCES users (id),
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (project_id, pipeline_id)
);

CREATE SEQUENCE attempt_fencing_seq;   -- drawn at claim time only, never per row (ADR-0016 § 3)

-- 01 invariant 1, made structural: one project, one published revision, both copied at creation.
CREATE TABLE runs (
    id                  uuid        PRIMARY KEY DEFAULT uuidv7(),
    organization_id     uuid        NOT NULL REFERENCES organizations (id),
    project_id          uuid        NOT NULL REFERENCES projects (id),
    pipeline_id         uuid        NOT NULL REFERENCES pipelines (id),
    pipeline_revision_id uuid       NOT NULL REFERENCES pipeline_revisions (id),
    assignment_id       uuid        REFERENCES assignments (id),
    revision_digest     text        NOT NULL CHECK (revision_digest ~ '^sha256:[0-9a-f]{64}$'),
    plan_digest         text        NOT NULL CHECK (plan_digest ~ '^sha256:[0-9a-f]{64}$'),
    plan_snapshot       jsonb       NOT NULL CHECK (jsonb_typeof (plan_snapshot) = 'object'),
    policies_snapshot   jsonb       NOT NULL CHECK (jsonb_typeof (policies_snapshot) = 'object'),
    repo_snapshot       jsonb       NOT NULL DEFAULT '[]'::jsonb,   -- starting base commits (03 step 2)
    status              text        NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued','preparing','running','waiting_human','paused',
                          'completed','failed','cancelled','interrupted')),
    failed_cause        text,
    paused_reason       text        CHECK (paused_reason IS NULL OR paused_reason IN
                                       ('human_takeover','manual','worker_unavailable')),
    cancel_requested_at timestamptz,
    depth               integer     NOT NULL DEFAULT 0 CHECK (depth BETWEEN 0 AND 2),
    parent_run_id       uuid        REFERENCES runs (id),
    triggered_by        uuid        REFERENCES users (id),           -- NULL for a child or a system start
    worker_affinity     uuid        REFERENCES workers (id),
    worker_volume_id    text,
    priority            integer     NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 10),
    expression_evaluations integer  NOT NULL DEFAULT 0 CHECK (expression_evaluations >= 0),
    created_at          timestamptz NOT NULL DEFAULT now(),
    started_at          timestamptz, finished_at timestamptz,
    CONSTRAINT runs_root_is_unparented  CHECK ((depth = 0) = (parent_run_id IS NULL)),
    CONSTRAINT runs_terminal_timestamped CHECK ((status IN ('completed','failed','cancelled','interrupted'))
                                                = (finished_at IS NOT NULL)),
    CONSTRAINT runs_paused_reasoned     CHECK (status = 'paused' OR paused_reason IS NULL),
    CONSTRAINT runs_affinity_is_a_pair  CHECK (worker_affinity IS NULL OR worker_volume_id IS NOT NULL),
    CONSTRAINT runs_terminal_cause      CHECK (status NOT IN ('failed','interrupted')
                                               OR failed_cause IS NOT NULL)
);
CREATE INDEX runs_project_created_idx ON runs (project_id, created_at DESC, id DESC);
CREATE INDEX runs_status_idx          ON runs (status, created_at) WHERE status IN
    ('queued','preparing','running','waiting_human','paused');
CREATE INDEX runs_parent_idx          ON runs (parent_run_id) WHERE parent_run_id IS NOT NULL;

-- One validated row per declared input: the value bindings read, plus where it came from.
CREATE TABLE run_inputs (
    run_id       uuid        NOT NULL REFERENCES runs (id),
    name         text        NOT NULL CHECK (name ~ '^[a-z][a-z0-9_]{0,62}$'),
    value        jsonb       NOT NULL,
    origin       text        NOT NULL DEFAULT 'submitted'
                 CHECK (origin IN ('submitted','default','override')),
    validated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (run_id, name)
);

-- ADR-0023 § 1. node_instance_key is a text PATH of node ids and index/iteration suffixes, never a
-- position index (01 invariant 6): /implement, /build_until_verified[2]/review, /fan_out[3]/invoke.
CREATE TABLE node_executions (
    id                uuid        PRIMARY KEY DEFAULT uuidv7(),
    run_id            uuid        NOT NULL REFERENCES runs (id),
    node_id           text        NOT NULL CHECK (node_id ~ '^[a-z][a-z0-9_]{0,62}$'),
    kind              text        NOT NULL,                    -- the catalogue name, verbatim
    node_instance_key text        NOT NULL CHECK (node_instance_key ~
        '^(/[a-z][a-z0-9_]{0,62})(\[[0-9]{1,9}\])?(/[a-z][a-z0-9_]{0,62}(\[[0-9]{1,9}\])?)*$'
        AND length (node_instance_key) <= 2048),
    scope_key         text        NOT NULL DEFAULT '/',        -- '/' or the parent scope key
    execution_location text       NOT NULL CHECK (execution_location IN ('worker','control_plane')),
    status            text        NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','ready','leased','running','succeeded','failed',
                          'skipped','waiting','cancelled','interrupted')),
    outputs           jsonb,
    outcome           text,                                    -- business outcome, distinct from status
    error_class       text,                                    -- ADR-0023 § 7 enum (below)
    failed_cause      text,
    artifact_refs     jsonb       NOT NULL DEFAULT '[]'::jsonb,
    depends_on        jsonb       NOT NULL DEFAULT '[]'::jsonb, -- node ids in this scope
    attempt_count     integer     NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    attempt_limit     integer     NOT NULL DEFAULT 1 CHECK (attempt_limit >= 1),
    in_flight         integer     NOT NULL DEFAULT 0 CHECK (in_flight >= 0),   -- fan-out accounting
    waiting_reason    text        CHECK (waiting_reason IS NULL OR waiting_reason IN
                                    ('approval','child_run','join_deferred')),
    created_at        timestamptz NOT NULL DEFAULT now(),
    ready_at          timestamptz, finished_at timestamptz,
    UNIQUE (run_id, node_instance_key),
    -- ADR-0023 § 3: control-plane work never occupies a lease. This is the CHECK the ADR names.
    CONSTRAINT node_executions_control_plane_never_leased
        CHECK (execution_location = 'worker'
               OR status NOT IN ('leased','running')),
    CONSTRAINT node_executions_terminal_timestamped
        CHECK (status NOT IN ('succeeded','failed','skipped','cancelled','interrupted')
               OR finished_at IS NOT NULL),
    CONSTRAINT node_executions_ready_timestamped
        CHECK (status = 'pending' OR ready_at IS NOT NULL),
    -- Composite-FK target so attempts.run_id cannot disagree with this row (see attempts below).
    UNIQUE (id, run_id)
);
CREATE INDEX node_executions_run_scope_idx ON node_executions (run_id, scope_key, id);
CREATE INDEX node_executions_status_idx    ON node_executions (run_id, status) WHERE status IN
    ('pending','ready','leased','running','waiting');

-- The single claim unit for worker work (ADR-0023 § 4). 09's
-- UNIQUE (run_id, node_instance_key, attempt_number) is enforced here transitively: node_executions
-- is unique on (run_id, node_instance_key), attempts is unique on (node_execution_id,
-- attempt_number), and the composite FK below makes attempts.run_id agree with its node execution —
-- so the third index cannot exist without violating one of the first two.
CREATE TABLE attempts (
    id                 uuid        PRIMARY KEY DEFAULT uuidv7(),
    node_execution_id  uuid        NOT NULL REFERENCES node_executions (id),
    run_id             uuid        NOT NULL,                    -- composite-FK column, see below
    attempt_number     integer     NOT NULL CHECK (attempt_number >= 1),
    status             text        NOT NULL DEFAULT 'queued'
                         CHECK (status IN ('queued','leased','running',
                                            'succeeded','failed','cancelled','interrupted')),
    error_class        text        CHECK (error_class IS NULL OR error_class IN
        ('infra','interrupted','timeout','agent_error','invalid_output','predicate_error',
         'sandbox_enforcement_failed','workspace_lost','binding_error','approval_expired',
         'cancelled')),
    detail             text        CHECK (detail IS NULL OR length (detail) <= 512),
    output_errors      jsonb       NOT NULL DEFAULT '[]'::jsonb, -- invalid_output evidence
    worker_id          uuid        REFERENCES workers (id),
    lease_expires_at   timestamptz,
    fencing_token      bigint      NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
    scheduled_at       timestamptz NOT NULL DEFAULT now(),      -- the COMPUTED backoff landing time
    deadline_at        timestamptz,                             -- node timeoutSeconds
    cancel_requested_at timestamptz,
    outputs            jsonb,
    outputs_digest     text        CHECK (outputs_digest IS NULL
                                          OR outputs_digest ~ '^sha256:[0-9a-f]{64}$'),
    artifact_refs      jsonb       NOT NULL DEFAULT '[]'::jsonb,
    overrides          jsonb,                                   -- run-local input overrides
    retry_context      jsonb,                                   -- continue_workspace inheritance
    conversation_id    uuid        REFERENCES conversations (id),
    turn_id            uuid        REFERENCES conversation_turns (id),
    created_at         timestamptz NOT NULL DEFAULT now(),
    started_at         timestamptz, finished_at timestamptz,
    UNIQUE (node_execution_id, attempt_number),
    CONSTRAINT attempts_run_matches_node_execution FOREIGN KEY (node_execution_id, run_id)
        REFERENCES node_executions (id, run_id),
    CONSTRAINT attempts_queued_unowned CHECK (status <> 'queued'
        OR (worker_id IS NULL AND lease_expires_at IS NULL AND fencing_token = 0
            AND started_at IS NULL AND finished_at IS NULL)),
    CONSTRAINT attempts_lease_is_a_triple CHECK (status NOT IN ('leased','running')
        OR (worker_id IS NOT NULL AND lease_expires_at IS NOT NULL AND fencing_token > 0)),
    CONSTRAINT attempts_terminal_timestamped CHECK ((status IN ('succeeded','failed',
                                          'cancelled','interrupted')) = (finished_at IS NOT NULL)),
    -- 01 invariant 4: a succeeded attempt HAS validated outputs (possibly {}), a failed one may
    -- carry diagnostics but never a success envelope.
    CONSTRAINT attempts_succeeded_has_outputs CHECK (status <> 'succeeded' OR outputs IS NOT NULL),
    CONSTRAINT attempts_failed_has_class      CHECK (status <> 'failed' OR error_class IS NOT NULL),
    CONSTRAINT attempts_terminal_reasoned    CHECK (status NOT IN ('interrupted','cancelled')
                                          OR error_class IN ('interrupted','cancelled','workspace_lost')
                                          OR error_class IS NULL),
    CONSTRAINT attempts_agent_turn_pair       CHECK ((conversation_id IS NULL) = (turn_id IS NULL))
);
-- Claim scan (ADR-0023 § 4) and reconciler scan, in that shape.
CREATE INDEX attempts_claim_idx       ON attempts (scheduled_at, id) WHERE status = 'queued';
CREATE INDEX attempts_lease_expiry_idx ON attempts (lease_expires_at, id)
    WHERE status IN ('leased','running');
CREATE INDEX attempts_run_idx         ON attempts (run_id, created_at DESC, id DESC);

-- 01 invariant 3 across BOTH leases of an agent attempt (ADR-0023 § 4). conversation_turns gains:
ALTER TABLE conversation_turns ADD COLUMN node_attempt_id uuid REFERENCES attempts (id);
CREATE INDEX conversation_turns_node_attempt_idx ON conversation_turns (node_attempt_id)
    WHERE node_attempt_id IS NOT NULL;

-- D-009's durable boundary record (ADR-0023 § 6). One row per successful node execution.
CREATE TABLE run_checkpoints (
    run_id             uuid        NOT NULL REFERENCES runs (id),
    node_execution_id  uuid        NOT NULL REFERENCES node_executions (id),
    attempt_id         uuid        NOT NULL REFERENCES attempts (id),
    inputs_digest      text        NOT NULL CHECK (inputs_digest ~ '^sha256:[0-9a-f]{64}$'),
    outputs_digest     text        NOT NULL CHECK (outputs_digest ~ '^sha256:[0-9a-f]{64}$'),
    artifact_refs      jsonb       NOT NULL DEFAULT '[]'::jsonb,  -- kind=checkpoint (+ kind=json manifest)
    repo_states        jsonb       NOT NULL DEFAULT '[]'::jsonb,  -- [{repository_id,base_commit,head_commit,modified_paths_artifact}]
    workspace_id       uuid        NOT NULL REFERENCES workspaces (id),
    volume_id          text        NOT NULL,
    worker_id          uuid        NOT NULL REFERENCES workers (id),
    plan_digest        text        NOT NULL CHECK (plan_digest ~ '^sha256:[0-9a-f]{64}$'),
    created_at         timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (run_id, node_execution_id),
    -- D-024 stays Open: a checkpoint is only readable as a same-volume record.
    CONSTRAINT run_checkpoints_volume_required CHECK (volume_id <> '')
);

-- A pipeline gate. NOT permission_requests (ADR-0016's ACP tool prompt): different table,
-- different authorizer, different CAS. One live gate per node execution.
CREATE TABLE approval_requests (
    id                uuid        PRIMARY KEY DEFAULT uuidv7(),
    organization_id   uuid        NOT NULL REFERENCES organizations (id),
    project_id        uuid        NOT NULL REFERENCES projects (id),
    run_id            uuid        NOT NULL REFERENCES runs (id),
    node_execution_id uuid        NOT NULL REFERENCES node_executions (id),
    kind              text        NOT NULL DEFAULT 'pipeline_gate'
                      CHECK (kind IN ('pipeline_gate','promotion_deferred')),  -- only the first is used
    summary           text        NOT NULL CHECK (length (summary) BETWEEN 1 AND 65536),
    artifact_refs     jsonb       NOT NULL DEFAULT '[]'::jsonb,
    approver_roles    text[]      NOT NULL DEFAULT '{}',
    approver_user_ids uuid[]      NOT NULL DEFAULT '{}',
    deadline_at       timestamptz NOT NULL,
    on_timeout        text        NOT NULL DEFAULT 'fail'
                      CHECK (on_timeout IN ('fail','cancel_run','expire')),
    re_requested      boolean     NOT NULL DEFAULT false,       -- 'expire' re-requests exactly once
    state             text        NOT NULL DEFAULT 'pending'
                      CHECK (state IN ('pending','decided','expired','cancelled','denied')),
    decision          text        CHECK (decision IS NULL OR decision IN ('approved','rejected')),
    comments          text        CHECK (comments IS NULL OR length (comments) <= 8192),
    decided_by        uuid        REFERENCES users (id),
    decided_at        timestamptz,
    version           integer     NOT NULL DEFAULT 1 CHECK (version >= 1),       -- CAS on decide
    created_at        timestamptz NOT NULL DEFAULT now(),
    UNIQUE (node_execution_id),
    CONSTRAINT approvals_decided_consistency CHECK (
        (state = 'pending'  AND decision IS NULL AND decided_by IS NULL AND decided_at IS NULL) OR
        (state IN ('decided','denied') AND (state = 'denied') = (decision IS NULL)
                                       AND decided_at IS NOT NULL) OR
        (state IN ('expired','cancelled') AND decision IS NULL AND decided_at IS NULL))
);
CREATE INDEX approvals_pending_idx ON approval_requests (deadline_at, id) WHERE state = 'pending';
CREATE INDEX approvals_project_idx ON approval_requests (project_id, created_at DESC, id DESC);

-- Child-run bookkeeping: a child is a run, this row is the relationship (ADR-0023 § 10).
-- NOTE: the key is the *node execution*, never an attempt — ADR-0023 § 3 and § 10 make
-- `pipeline.invoke` control-plane work that creates no attempt row, so an `attempt_id` column could
-- not be populated for the only rows this table holds. ADR-0023 § 1's summary table was amended
-- (2026-10-15) to match; see § 9.1 row 20. Do not "correct" this back to `attempt_id`.
CREATE TABLE pipeline_invocations (
    id                   uuid        PRIMARY KEY DEFAULT uuidv7(),
    run_id               uuid        NOT NULL REFERENCES runs (id),
    node_execution_id    uuid        NOT NULL REFERENCES node_executions (id),
    child_run_id         uuid        NOT NULL REFERENCES runs (id),
    child_project_id     uuid        NOT NULL REFERENCES projects (id),   -- must equal run's project
    pipeline_id          uuid        NOT NULL REFERENCES pipelines (id),
    resolved_revision_id uuid        NOT NULL REFERENCES pipeline_revisions (id),
    wait_policy          text        NOT NULL DEFAULT 'completion'
                         CHECK (wait_policy IN ('completion','started','detach')),
    depth                integer     NOT NULL CHECK (depth BETWEEN 1 AND 2),
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),
    UNIQUE (node_execution_id),
    UNIQUE (child_run_id),
    CONSTRAINT pipeline_invocations_child_is_not_self CHECK (child_run_id <> run_id)
);

-- 12 case 1. Same key + same request hash -> the stored run; same key, different body -> 409.
CREATE TABLE run_idempotency_keys (
    project_id     uuid        NOT NULL REFERENCES projects (id),
    key            text        NOT NULL CHECK (key ~ '^[A-Za-z0-9._-]{1,128}$'),
    run_id         uuid        NOT NULL REFERENCES runs (id),
    request_sha256 text        NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
    created_at     timestamptz NOT NULL DEFAULT now(),
    expires_at     timestamptz NOT NULL DEFAULT now() + interval '24 hours',
    PRIMARY KEY (project_id, key)
);
CREATE INDEX run_idempotency_expiry_idx ON run_idempotency_keys (expires_at);

-- ADR-0023 § 4/§ 5: capacity accounting becomes load-bearing the moment attempts exist.
ALTER TABLE workers ADD COLUMN capacity integer NOT NULL DEFAULT 1
    CHECK (capacity BETWEEN 1 AND 16);
ALTER TABLE workers ADD COLUMN active_attempts integer NOT NULL DEFAULT 0
    CHECK (active_attempts >= 0);

-- ADR-0023 § 4's two-lease rule, checked from the turn side: a turn that belongs to an attempt
-- lives in the attempt's run's project. conversation_turns has no project column, so the join is
-- conversation_id -> conversations.project_id (the API route already does this), and the attempt
-- link is asserted by attempts_agent_turn_pair plus the § 8 integration test.

-- Run correlation for the journal. 09's envelope example puts these at the top level; the envelope
-- schema and the journal gain them here (additive, ADR-0014 § 8: additive fields are not a version
-- bump). M3's workspace_id stays where M3 put it — inside payload — so existing consumers do not
-- move; run ids are new and have no legacy rows.
ALTER TABLE domain_events ADD COLUMN run_id            uuid;
ALTER TABLE domain_events ADD COLUMN node_execution_id uuid;
ALTER TABLE domain_events ADD COLUMN attempt_id        uuid;
CREATE INDEX domain_events_run_seq_idx ON domain_events (run_id, global_seq) WHERE run_id IS NOT NULL;
CREATE INDEX domain_events_attempt_idx ON domain_events (attempt_id, global_seq) WHERE attempt_id IS NOT NULL;

-- ADR-0018's reserved lifecycle finally has a unit to attach to.
ALTER TABLE secret_materializations ADD CONSTRAINT secret_materializations_attempt_fk
    FOREIGN KEY (attempt_id) REFERENCES attempts (id);

-- +goose Down
-- Test-reset only; production is forward-only (ADR-0013). Child tables first,
-- then the parents, then the widened columns; the additive ALTERs unwind last so
-- the tables they touch (domain_events, conversation_turns, workers,
-- secret_materializations) survive exactly as 00001-00004 built them.
DROP INDEX IF EXISTS domain_events_attempt_idx;
DROP INDEX IF EXISTS domain_events_run_seq_idx;
ALTER TABLE secret_materializations DROP CONSTRAINT IF EXISTS secret_materializations_attempt_fk;
ALTER TABLE domain_events DROP COLUMN IF EXISTS attempt_id;
ALTER TABLE domain_events DROP COLUMN IF EXISTS node_execution_id;
ALTER TABLE domain_events DROP COLUMN IF EXISTS run_id;
ALTER TABLE workers DROP COLUMN IF EXISTS active_attempts;
ALTER TABLE workers DROP COLUMN IF EXISTS capacity;
ALTER TABLE conversation_turns DROP COLUMN IF EXISTS node_attempt_id;
DROP TABLE IF EXISTS run_idempotency_keys;
DROP TABLE IF EXISTS pipeline_invocations;
DROP TABLE IF EXISTS approval_requests;
DROP TABLE IF EXISTS run_checkpoints;
DROP TABLE IF EXISTS attempts;
DROP TABLE IF EXISTS node_executions;
DROP TABLE IF EXISTS run_inputs;
DROP TABLE IF EXISTS runs;
DROP SEQUENCE IF EXISTS attempt_fencing_seq;
DROP TABLE IF EXISTS assignments;
ALTER TABLE pipeline_drafts DROP CONSTRAINT IF EXISTS pipeline_drafts_published_revision_fk;
DROP TABLE IF EXISTS pipeline_revisions;
DROP TABLE IF EXISTS pipeline_drafts;
DROP TABLE IF EXISTS pipelines;
