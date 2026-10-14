# 05 — Repositories, Sandboxes, Credentials and Secrets

## Workspace design

Each **Project** has zero or more associated Git repositories. Each **Run Workspace** is a worker-local directory e.g. `/var/lib/communication/workspaces/<run-id>/` with stable subdirectories for several checkouts:

```
run-482/
  repos/frontend/     # dedicated linked worktree or clone
  repos/backend/      # dedicated linked worktree or clone
  scratch/            # generated documents, temporary outputs
  meta/               # worker-only metadata, never mounted to agent
```

- Default writable parallel branches create **separate Run Workspaces** or scoped forked worktrees; reviewers may share immutable input/checkpoint without sharing writable directories.
- Optionally, a user may explicitly select a **shared writable** workspace with concurrency/race warnings and locking; not default.
- Treat repo mirrors (`/var/lib/communication/repos`) as worker-managed; linked worktrees require shared Git common metadata—**a copied worktree alone is not portable**.
- The workspace root is always resolved/normalized server-side. Reject traversal, symlink escape, relative paths used as ACL proof. Agent's working directory and additional repo paths are logical configuration, not security enforcement.
- Configurable workspace creation from branch/ref + per-repo policy. Do not automatically push/merge changes.
- Test data / generated artifacts go under scratch or dedicated paths, not silently into tracked repositories.

## Checkpoint/recovery policy

At successful node boundaries save: repo HEAD/base refs, dirty diff summary, output JSON, artifact references, modified path manifest, ACP conversation pointer. Worker-local persistent volume preserves actual edits across worker process restart on same host. For cross-host recovery, **only** portable staged checkpoints (internal Git bundle/ref or captured diff + allowlisted untracked files in object storage) can recreate prior edits. Never include ignored secret files or runtime credential homes in checkpoint payload. No continuous filesystem snapshot promise; user accepts retrying an interrupted node.

## Sandbox backend — nono first prototype

Define `SandboxPolicy{fs_ro, fs_rw, fs_deny, network, process, resources, ipc, required_level}` and `SandboxCapabilities`. `SandboxLauncher` starts **child** processes; NEVER install irreversible Landlock restrictions in the main API/worker Go process.

**nono prototype** on a modern Linux host (kernel ABI probe) with CLI/helper execution. Compare to Bubblewrap/OCI for later. Nono uses kernel Landlock restrictions; its early-development security policy explicitly says it is not a separate kernel/microVM boundary and production use is not currently recommended. Use behind a configurable enforcement mode:

- `required`: abort when filesystem/network/IPC guarantees cannot be verified; only mode acceptable for production security claims.
- `permissive-dev`: run a clearly labeled insecure development execution if configured by administrator; never silently fallback.
- `disabled`: explicit admin-only for trusted local developer use; every event carries isolation status.

**Trust caveat:** users' Project membership does not imply separate Unix/credential isolation. Two mutually untrusted client projects should require stronger outer isolation (distinct Unix identity / OCI or VM / separate worker credential scope) before asserting tenant security. nono is an additional layer, not a certification of tenant safety.

Security test cases: filesystem traversal/symlink, inherited FDs, `/proc`, Unix sockets, Docker/Podman sockets, HOME XDG paths, SSH agent/GPG agent, Git credential helpers, network allowlist and DNS bypass, child process inheritance, terminal helpers, credential mount, nested container environment. Test actual `nono` status/reporting on each supported host image.

## Secrets / credentials design

Three independent concepts:

1. **User identity (OIDC)** — who uses Communication.
2. **Project/organization integration credentials** — GitHub Apps/PATs/SSH deploy keys, external APIs, DB secrets, etc.
3. **Harness authentication** — credentials needed to start Claude/Codex/etc. under organization-approved terms. These can be sensitive directory trees, not necessarily a single environment variable.

**SecretRef:** `scope (project|org)`, `secret_id`, `version`, `allowed_agent_profiles`, `allowed_node_templates`, `purpose`, `delivery_mode (env|file|integration_broker)`, audit policy. Store encrypted at rest with envelope KMS/provider key when available; local dev fallback with explicit master key outside DB. Avoid UI view-raw-secret endpoint and never log secrets.

### `.env` materialization

Support declared secret placement when an app/test needs `.env` at a specific path within a checkout:

```yaml
secret_mounts:
  - secret: project/test-database-url
    mode: env_file
    repository: backend
    relative_path: .env.test.local
    key: DATABASE_URL
    lifecycle: node_attempt
```

**Contract**: only allow relative paths under an authorized workspace checkout; validate after resolving symlinks; ensure required file mode (0600), owner-only readable, atomic creation; refuse overwriting a tracked file by default; verify `git ls-files` and check ignore/exclude rules; remove at attempt completion; exclude materialized paths from Git staging/checkpoints/artifacts/diff previews; rotate/revoke and rematerialize on retry. Do not claim secure deletion on SSD/copy-on-write filesystems. If a file must live in a tracked path, require an explicit policy exception, not a silent overwrite. Never include generated `.env` content in conversation logs or artifacts.

**Threat-model clarification**: an agent granted read access to `.env` can copy/exfiltrate its contents over any allowed channel. Secret scoping and network egress control matter more than file permissions alone. For third-party credentials prefer a restricted broker/token over long-lived raw secrets where feasible. Treat redaction as a defense-in-depth best effort, not absolute secrecy after an agent has seen a value.

## Publish / merge responsibilities

A workspace's successful implementation result is a candidate change. Configure separate commands/nodes for commit, push, draft PR, human review and merge. Gas Town's Refinery design motivates an optional *merge queue with verification and batch bisection*; it does not force auto-merge into the core executor. External publication operations need idempotent tokens and post-crash reconciliation.

## First security acceptance gate

- `communication doctor` prints kernel/nono version, isolation verdict, forbidden capabilities, run-user permissions and expected attack surfaces.
- In test sandboxes, agent can read/write allowed workspace but cannot read another project checkout or configured denied credentials, or use blocked egress/socket routes in enforcement configuration.
- On missing kernel feature or policy mismatch, the run fails with a visible security error; no implicit unprotected execution.
- `.env` materialization test: file exists only within desired attempt, excluded from `git status`/tracked changes and stored artifacts, no value exposed in logs; traversal attempts rejected.
