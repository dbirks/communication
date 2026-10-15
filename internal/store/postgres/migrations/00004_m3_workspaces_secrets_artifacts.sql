-- 00004 — M3 workspaces, secrets and artifacts
-- (docs/m3-contract.md § 1; ADR-0017 workspaces/mirrors/volume identity,
-- ADR-0018 SecretRefs and envelope encryption, ADR-0019 sandboxed launch,
-- ADR-0020 artifacts; communication-spec/05-workspaces-security-secrets.md,
-- 09-api-events-data.md, 12-test-strategy.md cases 12-17, 20).
--
-- Forward-only per ADR-0013: no statement here rewrites a 00001-00003 row, and
-- the Down section exists for test resets only.
--
-- What the constraints below are actually for (a CHECK is cheap; a wrong one is
-- a silent data bug, so each is stated as the lie it makes impossible):
--
--   * Volume identity (`worker_volumes`, ADR-0017 D2 as corrected by probe V3)
--     — "the worker restarted on the same disk" is case 20's whole question,
--     and a hostname cannot answer it. Identity is stored **per storage root**
--     and derived from (st_dev, st_ino, root path), never from st_dev alone:
--     two different docker named volumes mounted at the same path report the
--     same st_dev (V3), so an st_dev-derived id would call a replaced volume
--     the same one and silently reclaim workspaces that no longer exist. An
--     M2-era worker has no `worker_volumes` row at all, which reads as
--     "unknown volume", and no M3 workspace may bind to an unknown volume.
--   * workspaces.agent_root being GENERATED — `nono --allow <dir>` is recursive,
--     so whatever sits under the granted directory is readable and writable by
--     the agent (probe C-META: under a workspace-root grant the sandboxed child
--     read `meta/workspace.json` and wrote `meta/agent-written`). Worker-only
--     state therefore lives at `root_path`, the *granted* tree is the derived
--     child `root_path || '/work'`, and no writer can record any other shape —
--     an INSERT that names agent_root is refused (428C9).
--   * workspaces_scope_pointer — a workspace belongs to exactly one of
--     {conversation, run}. M4 fills run_id; until then the column exists so
--     that milestone does not rename the wire (contract deviation D1).
--   * workspaces_one_live_per_conversation_idx — two live workspaces for one
--     conversation is two agent processes editing two checkouts of the same
--     scope; the second INSERT is 23505 and the API answers 409.
--   * workspaces_path_absolute — a relative or `..`-bearing root_path is the
--     ACL-proof failure ADR-0018 D4 clause 1 refuses at materialization time;
--     the column is *also* refused at write time.
--   * secrets_scope_pointer — an org-scope secret with a project_id (or the
--     reverse) would make "which projects may read this" ambiguous, which for a
--     secret is a disclosure bug, not a tidy-up problem.
--   * secret_versions_not_empty — an empty ciphertext row is a version that
--     cannot be decrypted and cannot be distinguished from a failed write.
--   * mounts_shape — `env` needs a name and must not name a path; `env_file`
--     needs a repository and a relative path and must not name an env var. A
--     mount that does both is delivered twice or not at all.
--   * artifacts sha256 pattern + UNIQUE (project_id, kind, sha256) — the
--     content-addressed key ADR-0020 D2 dedupes on; a retry must be a no-op
--     rather than a second byte-count.
--
-- What is deliberately NOT here:
--
--   * No column anywhere can hold a plaintext secret. `secret_versions` holds
--     AES-256-GCM ciphertext whose data key derives from a master key kept
--     OUTSIDE the database (ADR-0018 D2), so a `pg_dump` is inert.
--   * No artifact bytes in a row (02: "avoid storing multi-MB logs in database
--     rows"); `storage_key` is a pointer into the artifact backend.
--   * No FK from `workspaces.volume_id` / `workspace_repos.mirror_volume_id` to
--     `worker_volumes`: volume identity is a *historical fact* about a write,
--     not a live relationship. The row that owns it changes the moment the
--     worker re-probes after a volume is replaced, and an FK would either
--     rewrite history (the lie case 20 exists to catch) or refuse the re-probe.
--   * No FK from workspaces.conversation_id / workspaces.run_id /
--     artifacts.run_id, as drafted: `runs` does not exist yet, and a workspace
--     outlives the row that scoped it by design (ADR-0017 Migration: an M2-era
--     conversation has no `workspaces` row at all and is reclaimed honestly).
--     The scope-pointer CHECK is what holds the shape together instead.

-- +goose Up

-- ---------------------------------------------------------------- workers ---

-- ADR-0019: what the worker could actually prove about its sandbox at startup.
-- `disabled` is the honest default for a worker that has never probed; a
-- `required` profile must never fall back to it (ADR-0019 D6).
ALTER TABLE workers ADD COLUMN sandbox_backend     text NOT NULL DEFAULT 'none';
ALTER TABLE workers ADD COLUMN sandbox_version     text;
ALTER TABLE workers ADD COLUMN sandbox_enforcement text NOT NULL DEFAULT 'disabled'
    CHECK (sandbox_enforcement IN ('required', 'permissive-dev', 'disabled'));
ALTER TABLE workers ADD COLUMN sandbox_verified    boolean NOT NULL DEFAULT false;
ALTER TABLE workers ADD COLUMN sandbox_notes       jsonb NOT NULL DEFAULT '[]'::jsonb;

-- ------------------------------------------------------- worker_volumes ---

-- ADR-0017 D2's "which disk is this", measured, one row per storage root the
-- worker was configured with. `repos` (the project mirror root) is its own row
-- because it is its own tree — in the M3 deployment it is even its own named
-- volume — and probe V5b measured /workspaces and /repos on one mount as
-- (dev 30, ino 19414245) vs (dev 30, ino 19414347): same device, different
-- inode. A single identity column could only ever name one of the two trees,
-- which is why identity is keyed by root instead.
CREATE TABLE worker_volumes (
    worker_id   uuid        NOT NULL REFERENCES workers (id),
    -- The two roots M3 names. A later milestone with more trees adds a value,
    -- it does not widen the derivation rule.
    root_kind   text        NOT NULL CHECK (root_kind IN ('workspaces', 'repos')),
    root_path   text        NOT NULL,
    -- Both of these are load-bearing: st_dev alone cannot tell two named
    -- volumes mounted at one path apart (probe V3), and st_ino alone is a
    -- number inside whatever filesystem the path resolves into. The observed
    -- stable identity is the pair plus the path (V2: same volume, same
    -- (dev, ino, path) in two fresh containers).
    st_dev      bigint      NOT NULL CHECK (st_dev >= 0),
    st_ino      bigint      NOT NULL CHECK (st_ino > 0),
    fstype      text,
    -- sha256('communication-volume-v1' || st_dev || st_ino || root_path),
    -- hex-prefixed like every other digest on the wire. The pinned prefix means
    -- a re-derivation cannot be mistaken for an id computed under the old rule.
    volume_id   text        NOT NULL CHECK (volume_id ~ '^sha256:[0-9a-f]{64}$'),
    observed_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (worker_id, root_kind),
    -- The id is only comparable to a workspace row if it names an absolute,
    -- `..`-free path (ADR-0017 FC3: an unresolvable grant path is a bug).
    CONSTRAINT worker_volumes_path_absolute CHECK (root_path LIKE '/%' AND root_path NOT LIKE '%..%')
);

-- "Which workers claim to be sitting on this volume right now" — the ops query
-- behind ADR-0017's replaced-volume case.
CREATE INDEX worker_volumes_volume_idx ON worker_volumes (volume_id, worker_id);

-- ------------------------------------------------------------ workspaces ---

-- A run/conversation workspace: one scope, one worker, one volume, one root
-- (ADR-0017 D1/D3). `state` is the only field the reconciler and the UI read to
-- decide whether work may proceed here.
--
-- Two paths, not one, and the difference is a measured security failure:
--   root_path  = <WORKSPACE_ROOT>/<scope-kind>/<scope-id>/  — the workspace
--                directory; holds worker-only `meta/` (ADR-0017 D1).
--   agent_root = root_path || '/work'                       — the ONE directory
--                handed to the sandbox recursively; holds `repos/` (the
--                worktrees), `scratch/` and `home/`.
-- ADR-0017 D1 put meta/ beside repos/ at the workspace root and ADR-0019 D1
-- granted the workspace root; probe C-META showed that pair does not survive
-- contact with a real sandbox — `--allow` is recursive, so the sandboxed child
-- read meta/workspace.json *and wrote* meta/agent-written. The probe's own
-- remedy is the layout here: worker state as a *sibling* of the granted tree.
--
-- agent_root is a GENERATED column, not an input, because that is the only
-- shape that survives three workers writing to this table: nobody can record a
-- grant that includes meta/, and nobody can record a grant root that was not
-- derived from the workspace directory it belongs to (the same reasoning that
-- makes `admin_dir` read-back-only in ADR-0017 D4, applied to a path the
-- sandbox actually enforces).
CREATE TABLE workspaces (
    id              uuid        PRIMARY KEY DEFAULT uuidv7(),
    -- Denormalized for the project-scoped query predicate (09: "every sensitive
    -- query includes a project permission predicate"); project_id is the FK.
    organization_id uuid        NOT NULL,
    project_id      uuid        NOT NULL REFERENCES projects (id),
    scope_kind      text        NOT NULL CHECK (scope_kind IN ('conversation', 'run')),
    conversation_id uuid,       -- set iff scope_kind = 'conversation'
    run_id          uuid,       -- set iff scope_kind = 'run' (M4 fills)
    worker_id       uuid        NOT NULL REFERENCES workers (id),
    -- Copied from the worker's `worker_volumes` row for the root owning
    -- root_path, at Prepare time. Not an FK — see the note above.
    volume_id       text        NOT NULL CHECK (volume_id ~ '^sha256:[0-9a-f]{64}$'),
    root_path       text        NOT NULL,
    -- The recursive sandbox grant (see the block comment). Derived, never
    -- supplied: an INSERT that names this column is an error, not a choice.
    agent_root      text GENERATED ALWAYS AS (root_path || '/work') STORED NOT NULL,
    workspace_mode  text        NOT NULL DEFAULT 'worktree'
                    CHECK (workspace_mode IN ('worktree', 'clone')),
    -- preparing -> ready -> {released, lost}; quarantined is entered when a
    -- security check failed (a leftover materialized secret, an exclusion that
    -- could not be established, an unresolvable worktree) and blocks reuse.
    state           text        NOT NULL CHECK (state IN ('preparing', 'ready', 'quarantined', 'released', 'lost')),
    created_at      timestamptz NOT NULL DEFAULT now(),
    ready_at        timestamptz,
    released_at     timestamptz,
    lost_at         timestamptz,
    CONSTRAINT workspaces_scope_pointer CHECK (
        (scope_kind = 'conversation' AND conversation_id IS NOT NULL AND run_id IS NULL) OR
        (scope_kind = 'run'           AND run_id          IS NOT NULL AND conversation_id IS NULL)
    ),
    -- ready_at is not "when it became ready" but "this workspace got far enough
    -- to have a path on disk", which every post-preparing state depends on.
    CONSTRAINT workspaces_state_timestamped CHECK (
        (state IN ('ready', 'quarantined', 'released', 'lost')) = (ready_at IS NOT NULL)
    ),
    -- Absolute and `..`-free, or it is not an ACL proof (ADR-0017 FC3).
    -- agent_root inherits both properties from root_path by construction, so
    -- this constraint is stated once, over the column that is actually written.
    CONSTRAINT workspaces_path_absolute CHECK (root_path LIKE '/%' AND root_path NOT LIKE '%..%')
);

-- One live workspace per conversation (23505 -> 409); released/lost history
-- stays, and a conversation may have another live workspace after one ends.
CREATE UNIQUE INDEX workspaces_one_live_per_conversation_idx
    ON workspaces (conversation_id)
    WHERE state IN ('preparing', 'ready', 'quarantined');

-- Recovery scan: "what does this worker own on this volume, in what state".
CREATE INDEX workspaces_worker_volume_idx ON workspaces (worker_id, volume_id, state);

-- The per-repository half of a workspace, and the only place the *real* git
-- topology is recorded: admin_dir is read back rather than constructed, because
-- git auto-suffixes colliding worktree basenames — two worktrees of one repo
-- are `worktrees/backend` and `worktrees/backend1` (ADR-0017 P1) — and a
-- constructed path would be a guess the sandbox then grants or denies.
--
-- The read-back command is `git -C <worktree> rev-parse --absolute-git-dir`
-- (probe G1c). ADR-0017 D4 names `git worktree list --porcelain` instead, and
-- that mechanism is falsified on this git: for the second worktree it emitted
-- no `gitdir:` line at all (probe G1b, git 2.56.0), so an adapter following
-- the ADR literally would store an empty admin_dir and silently drop the one
-- grant a commit needs. The *requirement* (read it back, never derive it)
-- stands; only the command is corrected.
CREATE TABLE workspace_repos (
    id             uuid        PRIMARY KEY DEFAULT uuidv7(),
    workspace_id   uuid        NOT NULL REFERENCES workspaces (id),
    repository_id  uuid        NOT NULL REFERENCES repositories (id),
    checkout_path  text        NOT NULL,   -- <agent_root>/repos/<name>
    mirror_path    text        NOT NULL,   -- <repos root>/<project>/<name>.git
    -- Identity of the volume owning mirror_path, copied at Prepare time from
    -- the worker's `worker_volumes` row for root_kind = 'repos'. Separate from
    -- workspaces.volume_id because the mirror is a different tree (V5b), and
    -- "the worktree is still there but the mirror is gone" is a distinction
    -- case 20 has to be able to report.
    mirror_volume_id text      NOT NULL CHECK (mirror_volume_id ~ '^sha256:[0-9a-f]{64}$'),
    admin_dir      text        NOT NULL,   -- from `rev-parse --absolute-git-dir`
    run_ref        text        NOT NULL,   -- <scope-id>/<name>
    base_commit    text        NOT NULL,
    head_commit    text,                   -- set by the post-commit ref read (P8)
    -- The modified-path manifest, with excluded_paths already subtracted
    -- (ADR-0017 D8). A manifest, not a diff.
    modified_paths jsonb       NOT NULL DEFAULT '[]'::jsonb,
    -- ADR-0017 D6 / ADR-0018 clause 3: the project-scoped exclusion set that
    -- the checkpoint and artifact paths filter *again*, independently of git.
    excluded_paths jsonb       NOT NULL DEFAULT '[]'::jsonb,
    UNIQUE (workspace_id, repository_id),
    -- Every path here ends up in a sandbox grant list, so all four must be
    -- absolute and `..`-free at write time (ADR-0019 D1 refuses them at launch
    -- too; refusing them here means the refusal is not reachable by a bug in
    -- one caller). checkout_path's containment inside workspaces.agent_root and
    -- mirror_path's containment inside the repos root are the worker's own
    -- check — a CHECK cannot see the sibling row.
    CONSTRAINT workspace_repos_paths_absolute CHECK (
        (checkout_path LIKE '/%' AND checkout_path NOT LIKE '%..%') AND
        (mirror_path LIKE '/%' AND mirror_path NOT LIKE '%..%') AND
        (admin_dir LIKE '/%' AND admin_dir NOT LIKE '%..%') AND
        (checkout_path NOT LIKE '%//%' AND mirror_path NOT LIKE '%//%'
            AND admin_dir NOT LIKE '%//%'))
);

-- --------------------------------------------------------------- secrets ---

-- ADR-0018 D1: the metadata half of a SecretRef. This table has no column that
-- could hold a plaintext value, and no read path from internal/api touches
-- secret_versions.ciphertext.
CREATE TABLE secret_metadata (
    id              uuid        PRIMARY KEY DEFAULT uuidv7(),
    organization_id uuid        NOT NULL REFERENCES organizations (id),
    -- Set iff scope = 'project'. An org-scoped secret has no project, which is
    -- also why project_id cannot be NOT NULL: org-scope is 05's
    -- organization-wide tier.
    project_id      uuid        REFERENCES projects (id),
    scope           text        NOT NULL CHECK (scope IN ('project', 'org')),
    slug            text        NOT NULL,
    purpose         text        NOT NULL DEFAULT '',
    -- integration_broker is declared, never built: internal/secrets answers
    -- ErrDeliveryUnsupported (ADR-0018 clause 8), so 05's "prefer a restricted
    -- broker" cannot silently degrade into env delivery.
    delivery_mode   text        NOT NULL CHECK (delivery_mode IN ('env', 'env_file', 'integration_broker')),
    current_version integer     NOT NULL DEFAULT 1 CHECK (current_version >= 1),
    -- Allowlists; empty means denied to all (ADR-0018 D3): a profile with no
    -- grant cannot see the secret even inside its own project.
    allowed_agent_profile_ids   uuid[] NOT NULL DEFAULT '{}',
    allowed_node_template_ids   uuid[] NOT NULL DEFAULT '{}',
    audit_policy    text        NOT NULL DEFAULT 'materialization'
                    CHECK (audit_policy IN ('materialization', 'materialization_and_access')),
    created_by      uuid        NOT NULL REFERENCES users (id),
    created_at      timestamptz NOT NULL DEFAULT now(),
    rotated_at      timestamptz,
    revoked_at      timestamptz,
    CONSTRAINT secrets_scope_pointer CHECK (
        (scope = 'project' AND project_id IS NOT NULL) OR (scope = 'org' AND project_id IS NULL)
    )
);

-- One slug per project. Partial because the index below owns org scope; without
-- the predicate the two statements are the same rule twice, and the org-wide
-- one (organization_id is NOT NULL on every row) would then be the effective
-- one: two projects in one organization could not both define
-- `test-database-url`, which is exactly what the M3 exit fixtures do
-- (docs/m3-contract.md S4/S6). Recorded as a contract correction, not a whim.
CREATE UNIQUE INDEX secret_metadata_project_slug_idx ON secret_metadata (project_id, slug)
    WHERE project_id IS NOT NULL;
CREATE UNIQUE INDEX secret_metadata_org_slug_idx ON secret_metadata (organization_id, slug)
    WHERE project_id IS NULL;

-- ADR-0018 D2: immutable, envelope-encrypted versions. An old version is never
-- replaced — an in-flight unit pinned it — and no migration ever deletes one:
-- after the keyring stays where it belongs, these rows are the only copy of the
-- value that exists.
CREATE TABLE secret_versions (
    secret_id    uuid        NOT NULL REFERENCES secret_metadata (id),
    version      integer     NOT NULL CHECK (version >= 1),
    -- The master-key generation: a name for a file OUTSIDE this database
    -- (ADR-0018 D2.2). An unknown key_id is a refused decrypt, never a guess.
    key_id       text        NOT NULL,
    -- AES-256-GCM with a fresh 12-byte nonce per version.
    nonce        bytea       NOT NULL CHECK (octet_length (nonce) = 12),
    ciphertext   bytea       NOT NULL,
    -- secret_id || version || key_id || sha256(slug): a ciphertext cannot be
    -- replayed into another row, another version or another secret.
    aad          text        NOT NULL,
    -- Retry-comparison only. Never API-exposed, not a MAC, and enumerable for
    -- low-entropy values by anyone who can read the row (ADR-0018 Consequences).
    content_sha256 text      NOT NULL,
    created_by   uuid        NOT NULL REFERENCES users (id),
    created_at   timestamptz NOT NULL DEFAULT now(),
    revoked_at   timestamptz,
    PRIMARY KEY (secret_id, version),
    -- A version with no bytes is indistinguishable from a half-written row.
    CONSTRAINT secret_versions_not_empty CHECK (octet_length (ciphertext) > 0)
);

-- Declared placements (communication-spec/05's secret_mounts, examples/
-- secret-mounts.yaml). `relative_path` is relative by constraint and validated
-- again at materialization time: a CHECK cannot see the filesystem, and
-- "relative to what" is only answerable once the workspace exists (ADR-0018 D4
-- clause 1).
CREATE TABLE secret_mounts (
    id             uuid        PRIMARY KEY DEFAULT uuidv7(),
    project_id     uuid        NOT NULL REFERENCES projects (id),
    secret_id      uuid        NOT NULL REFERENCES secret_metadata (id),
    delivery_mode  text        NOT NULL CHECK (delivery_mode IN ('env', 'env_file', 'integration_broker')),
    repository_id  uuid        REFERENCES repositories (id),  -- required for env_file
    relative_path  text,       -- required for env_file; relative, validated at use
    env_name       text,       -- required for env
    -- Single-key extraction from a multi-line value (secret-mounts.yaml `key`).
    key            text,
    -- turn: created before launch, removed at the turn's terminal state.
    -- workspace: survives the turn, removed at workspace.released.
    -- node_attempt: accepted by the CHECK and honoured by nothing until M4's
    -- `attempts` exist (contract deviations D1/D9).
    lifecycle      text        NOT NULL DEFAULT 'turn'
                   CHECK (lifecycle IN ('turn', 'workspace', 'node_attempt')),
    -- 05's explicit policy exception for a tracked target — "not a silent
    -- overwrite"; the worker refuses a tracked target unless this is true.
    allow_tracked  boolean     NOT NULL DEFAULT false,
    created_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT mounts_shape CHECK (
        (delivery_mode = 'env_file' AND repository_id IS NOT NULL
            AND relative_path IS NOT NULL AND relative_path NOT LIKE '/%'
            AND relative_path NOT LIKE '%..%' AND relative_path NOT LIKE '%//%'
            AND env_name IS NULL) OR
        (delivery_mode = 'env' AND env_name IS NOT NULL AND relative_path IS NULL
            AND repository_id IS NULL)
    )
);

-- ADR-0018 D1's proof that a value was present only during the unit authorized
-- to have it. Metadata only; the value is not here to be forgotten.
CREATE TABLE secret_materializations (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    secret_id       uuid        NOT NULL REFERENCES secret_metadata (id),
    secret_version  integer     NOT NULL,
    project_id      uuid        NOT NULL REFERENCES projects (id),
    workspace_id    uuid        REFERENCES workspaces (id),
    -- M3's unit is the turn; attempt_id arrives with M4 and nothing is renamed
    -- later (contract deviations D1/D9).
    turn_id         uuid,
    attempt_id      uuid,
    worker_id       uuid        NOT NULL REFERENCES workers (id),
    -- env delivery is never recorded as a file, and vice versa.
    delivery_mode   text        NOT NULL CHECK (delivery_mode IN ('env', 'env_file')),
    target          text        NOT NULL,  -- env name or relative path
    file_mode       integer,               -- 384 == 0o600 for env_file
    materialized_at timestamptz NOT NULL DEFAULT now(),
    cleaned_at      timestamptz,
    -- Who removed it: the unit's own defer, the reconciler, or the worker's
    -- startup sweep over rows still uncleaned.
    cleaned_by      text CHECK (cleaned_by IN ('worker', 'reconciler', 'startup_sweep'))
);

-- The sweep query, index-backed by design: an uncleaned materialization is a
-- secret left on disk, and the startup sweep must find it without a seq scan.
CREATE INDEX secret_materializations_uncleaned_idx ON secret_materializations (workspace_id)
    WHERE cleaned_at IS NULL;

-- ---------------------------------------------------------- artifacts ----

-- ADR-0020 D2. Bytes never live in a row; this is the index into the backend.
CREATE TABLE artifacts (
    id              uuid        PRIMARY KEY DEFAULT uuidv7(),
    organization_id uuid        NOT NULL,
    project_id      uuid        NOT NULL REFERENCES projects (id),
    -- M4 columns, nullable and unpopulated until then; M3's writers set
    -- conversation_id / turn_id / worker_id instead.
    run_id          uuid,
    node_execution_id uuid,
    attempt_id      uuid,
    conversation_id uuid,
    turn_id         uuid,
    worker_id       uuid,
    name            text        NOT NULL,
    -- checkpoint is ADR-0020 D8: ADR-0017's captured diff + manifest, stored as
    -- an artifact rather than through a second mechanism.
    kind            text        NOT NULL CHECK (kind IN ('markdown', 'image', 'html', 'json', 'patch', 'archive', 'checkpoint')),
    media_type      text        NOT NULL,
    sha256          text        NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    size_bytes      bigint      NOT NULL CHECK (size_bytes >= 0),
    -- `s3` is ADR-0020 D7's written contract, not an M3 implementation; a row
    -- carrying it means a later milestone put bytes there.
    storage_backend text        NOT NULL CHECK (storage_backend IN ('local', 's3')),
    storage_key     text        NOT NULL,
    sensitivity     text        NOT NULL DEFAULT 'standard'
        CHECK (sensitivity IN ('standard', 'internal', 'restricted', 'secret')),
    -- uploading -> ready happens in one fenced transaction with
    -- artifact.created; a row stuck at uploading is the reconciler's orphan
    -- sweep, never served bytes (01 invariant 4's spirit).
    state           text        NOT NULL DEFAULT 'uploading'
        CHECK (state IN ('uploading', 'ready', 'orphan', 'deleted')),
    -- ADR-0020 D4: the count that makes "the scanner saw nothing"
    -- distinguishable from "the scanner is broken". 0 is normal.
    redaction_count integer     NOT NULL DEFAULT 0,
    -- 'worker' or a user id: artifacts are created by both, and 06 wants the
    -- actor recorded.
    created_by      text        NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    ready_at        timestamptz,
    expires_at      timestamptz,
    deleted_at      timestamptz,
    -- A retried Put of the same bytes is the same row: content addressing has
    -- to fall out of the schema, or a worker crash double-counts storage.
    UNIQUE (project_id, kind, sha256)
);

-- Project artifact list, newest first with the id as a stable tiebreaker.
CREATE INDEX artifacts_project_created_idx ON artifacts (project_id, created_at DESC, id DESC);
-- Orphan sweep scan.
CREATE INDEX artifacts_sweep_idx ON artifacts (id) WHERE state = 'uploading';
-- Retention sweep scan: only rows that can actually expire.
CREATE INDEX artifacts_expiry_idx ON artifacts (expires_at, id)
    WHERE state = 'ready' AND expires_at IS NOT NULL;
-- Dedupe lookup, required by ADR-0020 D2's index list (the contract's draft
-- DDL omitted it; the ADR wins).
CREATE INDEX artifacts_sha256_idx ON artifacts (sha256);

-- ------------------------------------------------- agent profile additions ---

-- ADR-0008/0016 and contract deviation D10: there are still no profile
-- revisions, so M3's per-launch inputs are columns on agent_profiles. When
-- revisions arrive they carry these defaults forward; they do not rename them.
-- `limits` (resources/CPU/memory) is NOT modeled at all — ADR-0019 names it
-- unimplemented rather than as a no-op field.
ALTER TABLE agent_profiles ADD COLUMN workspace_mode text NOT NULL DEFAULT 'worktree'
    CHECK (workspace_mode IN ('worktree', 'clone'));
-- The profile chooses its enforcement; the worker's registered mode is the
-- ceiling, and `required` against a worker that cannot verify is a refusal, not
-- a downgrade (ADR-0019 D6). The seeded M2 profiles keep permission_mode 'ask'
-- and gain sandbox_enforcement 'required', which is the honest pair: no prompt
-- is auto-approved, and no launch happens unverified.
ALTER TABLE agent_profiles ADD COLUMN sandbox_enforcement text NOT NULL DEFAULT 'required'
    CHECK (sandbox_enforcement IN ('required', 'permissive-dev', 'disabled'));
-- The commit grant axis (ADR-0017 D4): four named mirror paths, nothing else.
ALTER TABLE agent_profiles ADD COLUMN commit_granted boolean NOT NULL DEFAULT false;
ALTER TABLE agent_profiles ADD COLUMN apm_package_ref text;
ALTER TABLE agent_profiles ADD COLUMN apm_target text
    CHECK (apm_target IN ('claude', 'codex'));
-- Per-target lock digest, validated before launch; a mismatch refuses rather
-- than restaging (case 14). NULL means "this profile stages no APM package".
ALTER TABLE agent_profiles ADD COLUMN apm_lock_digest text
    CHECK (apm_lock_digest IS NULL OR apm_lock_digest ~ '^sha256:[0-9a-f]{64}$');
-- Mounts this profile may materialize. The secret's own allowlist is the other
-- half: both must agree (ADR-0018 D3).
ALTER TABLE agent_profiles ADD COLUMN secret_mount_ids uuid[] NOT NULL DEFAULT '{}';

-- +goose Down
-- Test-reset only; production is forward-only (ADR-0013). Child tables first,
-- then the parents, then the widened columns. `secret_versions` is dropped here
-- ONLY because a Down that kept a table nothing else could drop would make the
-- reset non-idempotent; no deployment runs this section (ADR-0018 Migration:
-- "no migration may delete them").
DROP INDEX IF EXISTS artifacts_sha256_idx;
DROP INDEX IF EXISTS secret_materializations_uncleaned_idx;
DROP INDEX IF EXISTS workspaces_worker_volume_idx;
DROP INDEX IF EXISTS workspaces_one_live_per_conversation_idx;
DROP INDEX IF EXISTS secret_metadata_org_slug_idx;
DROP INDEX IF EXISTS secret_metadata_project_slug_idx;

ALTER TABLE agent_profiles DROP COLUMN IF EXISTS secret_mount_ids;
ALTER TABLE agent_profiles DROP COLUMN IF EXISTS apm_lock_digest;
ALTER TABLE agent_profiles DROP COLUMN IF EXISTS apm_target;
ALTER TABLE agent_profiles DROP COLUMN IF EXISTS apm_package_ref;
ALTER TABLE agent_profiles DROP COLUMN IF EXISTS commit_granted;
ALTER TABLE agent_profiles DROP COLUMN IF EXISTS sandbox_enforcement;
ALTER TABLE agent_profiles DROP COLUMN IF EXISTS workspace_mode;

ALTER TABLE workers DROP COLUMN IF EXISTS sandbox_notes;
ALTER TABLE workers DROP COLUMN IF EXISTS sandbox_verified;
ALTER TABLE workers DROP COLUMN IF EXISTS sandbox_enforcement;
ALTER TABLE workers DROP COLUMN IF EXISTS sandbox_version;
ALTER TABLE workers DROP COLUMN IF EXISTS sandbox_backend;

DROP TABLE IF EXISTS worker_volumes;
DROP TABLE IF EXISTS artifacts;
DROP TABLE IF EXISTS secret_materializations;
DROP TABLE IF EXISTS secret_mounts;
DROP TABLE IF EXISTS secret_versions;
DROP TABLE IF EXISTS secret_metadata;
DROP TABLE IF EXISTS workspace_repos;
DROP TABLE IF EXISTS workspaces;
