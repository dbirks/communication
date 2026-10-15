# ADR-0018 — SecretRef: envelope-encrypted values outside the API surface, env/env_file materialization, and what is honestly not guaranteed

- **Date:** 2026-10-15
- **Status:** **Proposed** (nothing here is proven until the case-12/13 gates in `docs/m3-contract.md` run)
- **Owners:** M3 implementation workers (control plane, worker runtime, UI)
- **Related decisions / contracts:** D-010 (**Accepted**: OIDC mapping, project RBAC, scoped secrets), D-020, D-025 (**Open**), ADR-0013 (`payload jsonb`/`audit_events.detail` must never contain raw secrets; forward-only migrations), ADR-0014 (problem+json, 404-not-403, audit on denial), ADR-0016 (one journal, turn fencing), ADR-0017 (worktree layout, the exclusion mechanism, `/tmp` prohibition), ADR-0019 (who is allowed to read a materialized file and over which channels), `communication-spec/05-workspaces-security-secrets.md` § "Secrets / credentials design" / "`.env` materialization" / "Trust caveat" / "Threat-model clarification", `communication-spec/09-api-events-data.md` (`secret_metadata`, `GET/POST /secrets` metadata-only, `secret.materialized` **metadata only**), `communication-spec/02-system-architecture.md` (`SecretResolver`), `communication-spec/06-collaboration-identity.md` (authorization at every boundary; secret materializations audited by reference), `communication-spec/10-ui-design-handoff.md` J8, `communication-spec/12-test-strategy.md` cases 12 and 15, `communication-spec/examples/secret-mounts.yaml`.

## Context

05 separates three things that get conflated in every implementation: user identity (OIDC),
project/org integration credentials, and harness authentication ("These can be sensitive directory
trees, not necessarily a single environment variable"). It then specifies a `SecretRef`
(`scope`, `secret_id`, `version`, `allowed_agent_profiles`, `allowed_node_templates`, `purpose`,
`delivery_mode (env|file|integration_broker)`, audit policy), "encrypted at rest … local dev fallback
with explicit master key outside DB", "Avoid UI view-raw-secret endpoint and never log secrets", and a
nine-clause `.env` materialization contract.

M2 already created the process that will hold these values: an ACP subprocess, launched by a worker
that shares a Unix uid with everything else on that volume, whose transcript is a durable journal
that other project members read. What M2 did **not** build is any place to put a value: there is no
`secret_metadata` table (migration `00001` and `00003` have none), no `SecretResolver`, no materialize
step, and `internal/agent/acp/runtime.go` still inherits `os.Environ()` wholesale
(`cmd.Env = os.Environ()` when `spec.Env` is nil), which is itself the first leak to close.

Three constraints from the M0 evidence shape this record rather than the spec's text:

- **A deny rule cannot protect a file that appears later.** SANDBOX.md: `filesystem.deny` "only covers
  paths present at start time", so a `.env` materialized *after* launch (or created by a helper) is
  protected only by the *absence of a grant* — and ADR-0017 P9 shows absence of a grant does not even
  hold under `/tmp`. The design must therefore place materialized secrets inside paths that are
  granted, and protect them by *who is granted* — not by denial.
- **The only git exclusion mechanism that works in a per-run worktree is project-scoped** (X1/X2/X3 in
  ADR-0017's Verification): git ignores a per-worktree `info/exclude`, honors the shared
  `<mirror>/info/exclude`, and the per-worktree config route broke git outright in that layout.
- **M3 has turns, not attempts.** 05's `lifecycle: node_attempt` has no `attempts` row to attach to
  until M4, and the existing per-conversation workspace is deleted per conversation, not per attempt.
  The lifecycle vocabulary has to be defined against a real unit now.

## Options considered

| Option | Advantages | Disadvantages | Evidence |
|---|---|---|---|
| A. Values in Postgres `secret_values.value text`, access controlled by the API | Trivially consistent, no key management, backups "just work" | Falsified by D-010 and ADR-0013's own posture: the DB is the most-exposed artifact in this deployment (trust-authenticated in compose, single failure domain), and a `pg_dump` would then be a secret export. Rejected | 05 "Store encrypted at rest"; 13 D-010 |
| **B (selected).** Envelope encryption in Postgres: AES-256-GCM ciphertext rows in `secret_versions`, data keys derived from a **master key that lives outside the database** (file/volume, generation-identified), KMS behind the same interface later | One authoritative store and one transaction boundary; the DB dump alone is inert; no new service for the dev stack; "when available, envelope KMS/provider key" becomes an adapter choice, not a schema change | Key custody becomes an operational obligation (a lost master key is unrecoverable data); rotation needs a rewrap path; a `secret` value is still decryptable by both `serve` and `worker`, so those two processes share a trust domain by construction | 05 § "Secrets"; ADR-0013 (Postgres authoritative, forward-only); `compose.yml` shows both processes already share the DB URL |
| C. Secrets never in Postgres — worker-local encrypted files only, provisioned out of band | Control plane cannot read plaintext even in principle; matches 05's "credential mount" security test | No metadata-only CRUD story (09 asks for `/secrets` metadata endpoints), no J8 UI, no audit of who changed what, and per-worker provisioning is exactly the "dual mutable truth" the spec avoids; also makes M4's scheduler blind to scopes | Compared; rejected for M3, kept as the shape of `integration_broker` later |
| D. External secrets manager (Vault / AWS SM / SOPS-age store) as the only implementation | Best real-world properties; orgs already have one | `required` for the dev lab is a non-starter for a one-command compose stack; the spec's own fallback exists precisely for this; a second service in the acceptance gate contradicts `12-test-strategy.md`'s lab framing | 05 "local dev fallback"; compared |

For the materialization half:

| Option | Advantages | Disadvantages | Evidence |
|---|---|---|---|
| **Write real bytes at the declared relative path, worker-side, before launch; exclude via `<mirror>/info/exclude`; delete at unit end (selected)** | Exactly 05's contract; the harness needs the file to exist at a path, and both probed harnesses read real files; worker writes are unsandboxed so the exclusion file is agent-immutable | Exclusion is project-scoped (X1/X3); an agent with the grant can read and exfiltrate the value; leftover files are a real failure mode on crash | 05 `.env` contract; ADR-0017 X1/X2/X4; P9 |
| B. Mount the file read-only at the path with tmpfs/bind tricks | Bytes never touch the workspace, so `git status`, checkpoints and artifacts never see them | Requires mount privileges the worker does not have (it runs unprivileged, uid 10001 or host uid per `compose.harness.yml`), and per-attempt bind mounts inside a container are a different deployment model than `02` describes | `compose.yml`, `compose.harness.yml`; `02` "Persistent worker directory" |
| C. Symlink the path to a worker-held file | No content in the workspace tree | 05: "Reject traversal, symlink escape, relative paths used as ACL proof"; a symlink *is* the escape shape the sandbox's Landlock path-resolution denies inconsistently, and `git` follows it into tracked paths | 05 § "Workspace design"; SANDBOX.md C4 (symlink escape closed by *absence* of grant, not by clever layout) |
| D. Environment-only delivery, no files at all | Nothing on disk to exclude | 05 and `examples/secret-mounts.yaml` explicitly need `env_file` at `relative_path: .env.test.local`; real apps read `.env`, and `10` J8 is "target `.env` destination" | 05; `10` J8 |

## Decision

### 1. Model

```
secret_metadata   one row per logical secret: scope (project|org), project_id/organization_id,
                  slug, purpose, delivery_mode (env|env_file|integration_broker), current_version,
                  allowed_agent_profile_ids, allowed_node_template_ids, audit_policy, created_by,
                  created_at, rotated_at, revoked_at
secret_versions   one row per immutable version: secret_id, version, key_id (master-key generation),
                  nonce, ciphertext, aad, content_sha256, created_by, created_at, revoked_at
secret_mounts     declared placements: project_id, repository_id, relative_path, key,
                  delivery_mode, lifecycle, plus the secret_id it points at
secret_materializations  one row per delivery: secret_id, secret_version, turn_id/attempt_id (null
                  until M4), workspace_id, delivery_mode, target (env name or relative path),
                  mode (0600), materialized_at, cleaned_at, cleaned_by ('worker'|'reconciler')
```

`secret_metadata` is the only thing the API ever lists; **no column in any table holds plaintext**, and
`secret_versions.ciphertext` is never selected by a read path reachable from HTTP (the worker reads it
through a store method the API package does not expose). `content_sha256` is a sha256 of the
plaintext, and it exists solely to make "did this retry rematerialize the same value" answerable; it
is not a MAC, it is not logged, and for high-entropy secrets it is not reversible (recorded as such,
not as a leak-proof hash).

`lifecycle` values are `turn` (M3 default: created before launch, removed when the turn reaches a
terminal state), `workspace` (survives turns of the same workspace, removed at `workspace.released`),
and `node_attempt` (**reserved**: the column accepts it, no M3 code path honours it, and it becomes
real with `attempts` in M4).

### 2. Encryption at rest, with the master key outside the database

1. **Algorithm:** AES-256-GCM, 12-byte random nonce per version, `aad` =
   `secret_id || version || key_id || sha256(slug)`, so a ciphertext cannot be replayed into another
   row, another version, or another secret.
2. **Key hierarchy:** master key per generation, `key_id` = `<generation-id>`, stored **outside
   Postgres**. Dev/compose: a `masterkeys` named volume generated once by a one-shot and mounted
   **read-only** into `api-a`, `api-b` and `worker` at `/etc/communication/keys`; path from
   `COMMUNICATION_SECRET_KEYRING`, default `/etc/communication/keys`. Production recipe: the same
   directory from a host path or a secret store, or the KMS provider. Data keys are
   `HKDF-SHA256(master_key, "communication/secret/v1/" + secret_id + "/" + version)`, which keeps the
   master key file the only secret material and makes "which generation encrypted this row" a column.
3. **Never in an environment variable.** A key in `COMMUNICATION_*` would leak through `/proc/<pid>/environ`
   to anything sharing the uid — including, in the lab, the agent process. File + read-only mount is
   the point. `communication doctor` gains a check: keyring readable, exactly one active generation,
   mode ≤ 0600/0700, **not** inside any workspace root (P9 makes that non-theoretical).
4. **Rotation:** revoke = set `revoked_at`; materialization then refuses the version and the run fails
   with `secret.materialization_failed` rather than using a stale value ("rotate/revoke and
   rematerialize on retry", 05). Master-key rotation rewraps `secret_versions` rows in a bounded
   forward pass keyed on `key_id`; until a row is rewrapped it decrypts under the old generation, and
   `doctor` reports the backlog.
5. **KMS/provider path:** `internal/secrets` owns a `KeyProvider` interface (`UnwrapDataKey(key_id,
   wrapped)`); the file provider is the dev fallback and a KMS provider is additive. No table change,
   because `key_id` and `aad` already describe what a provider needs.

### 3. Scopes, policy, and the value-never-read invariant

- A secret is visible to `authz` exactly as its project is (`CanView`); org-scope secrets require org
  admin (ADR-0012's `is_org_admin`). Listing returns metadata only.
- `allowed_agent_profile_ids` / `allowed_node_template_ids` are **allowlists, empty means none**:
  a profile with no grant cannot see the secret even in its own project, and the check runs in the
  worker at materialization time, not only in the API (defense in depth: the worker holds the keyring
  and must not be the party that reasons about intent).
- The API surface has **no read-value route at all** — not redacted, not gated, absent. `openapi.yaml`
  must not contain a schema with a plaintext member, and a test asserts it (`docs/m3-contract.md`
  § Verification). Values enter through `POST …/secrets` and `POST …/secrets/{id}/versions` request
  bodies and stop existing as far as the read path is concerned.
- Request-body values are additionally excluded from access logs, `audit_events.detail` records
  `{secret_id, version, slug, purpose, delivery_mode}` and never a value, and the middleware that
  could echo bodies is not present (ADR-0014's error shape is `{type,title,status,detail}` with `detail`
  authored by us).

### 4. Materialization contract (05's nine clauses, made concrete)

For each `secret_mounts` row applicable to the launch, in this order, worker-side, before the
sandboxed exec:

1. **Resolve and validate the destination** — `relative_path` must be relative, must not contain `..`
   before or after `filepath.Clean` (the rule already in `internal/sandbox/nono/launcher.go`
   `absolutePaths`), must resolve under `<workspace>/repos/<repository>/` after `EvalSymlinks` of the
   *parent*, and the final path must not exist as a symlink. Repository name must match a
   `workspace_repos` row of *this* workspace. Anything else is `secret.materialization_failed` and the
   attempt does not start. Never into `meta/`, `home/` or a temp directory (ADR-0017 Decision 5).
2. **Confirm it is not tracked** — `git ls-files --error-unmatch <path>` must fail; if it succeeds,
   refuse unless the project carries an explicit policy exception (05: "require an explicit policy
   exception, not a silent overwrite").
3. **Publish the exclusion first** — worker appends the exact relative path to
   `<mirror>/info/exclude` (the only mechanism git honors here, X2) and re-checks with
   `git check-ignore -v`. Ordering matters: excluding after the write would leave a window where a
   concurrent `git add -A` in the same worktree captures it.
4. **Create atomically, owner-only** — `open(path, O_WRONLY|O_CREAT|O_EXCL, 0600)` at the final path,
   write, `Close`; on `EEXIST`, remove-then-create once (that row's own previous materialization) and
   refuse a second time. No temp-file-then-rename: rename needs an unlink of the target and would
   silently overwrite what step 2 just verified.
5. **Deliver `env`** — `KEY=value` appended to the launch `Env` list only for the agent process.
   Honest note: env values are readable by every process the agent spawns, appear in `ps eww`-style
   views for the same uid, and land in crash dumps; prefer `env_file` where the app supports it, and
   say so in the profile UI rather than pretending the two modes are equivalent.
6. **Clean up** — in a `defer` on the launch path and again in a worker-start sweep over
   `secret_materializations WHERE cleaned_at IS NULL` for workspaces this worker owns; each removal
   writes `secret.removed` (metadata only) and sets `cleaned_at`. A file that could not be removed
   moves the workspace to `quarantined` (ADR-0017 Decision 3) and blocks reuse.
7. **Exclude downstream** — checkpoint manifests, diff previews and artifact uploads filter the declared
   exclusion set of the *workspace*, independent of git's opinion; the event journal never carries
   file content beyond ADR-0016's bounded previews; and worker-side log capture is passed through a
   redaction set built from exactly the values this unit materialized (best-effort by 05's own words,
   implemented because it is cheap: replace-and-count, count emitted as a metric so "redaction did
   nothing" is visible rather than assumed).
8. **`integration_broker` is declared, not built** — the enum accepts it, `internal/secrets` returns
   `ErrDeliveryUnsupported` for it, and profiles using it fail at validate time with a message naming
   M3's scope. This keeps 05's "prefer a restricted broker/token" from becoming a silent env delivery.
9. **No secure-deletion claim.** 05 already refuses it ("Do not claim secure deletion on
   SSD/copy-on-write filesystems"); the compose lab mounts bind or volume paths where
   copy-on-write is plausible on the host, so this record repeats it verbatim in the UI copy for J8.

### 5. Harness credentials are not `SecretRef`s

05's third credential kind (harness authentication: `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, directory trees
that are logins) does not fit the value-per-row model, and ADR-0019 owns where those mounts live and
who may read them. This record rules only that they are **never** represented as `env`-delivered
`SecretRef`s, because a `SecretRef` implies project-scoped rotation and audit metadata that a
personal harness login does not have (`compose.harness.yml`'s honest framing: the owner authorized
their own logins for local development).

## Consequences

- Positive: `09`'s `/secrets (metadata-only)` line becomes implementable, and the "no raw secret UI
  endpoint ever" rule is structural (there is no route to wire up by mistake) rather than a code
  review finding.
- Positive: a database dump stops being a credential leak, and the master-key file's absence is a
  loud startup failure instead of a silent decrypt error.
- Cost: key custody enters the deployment recipe (one one-shot, one volume, `doctor` checks); losing
  the keyring means the secrets are gone, which is the point and must be said in the docs.
- Cost: materialization becomes a *staged, ordered* routine with a persistent audit trail, so a crash
  mid-materialization has to be reconciled — the sweep in clause 6 is load-bearing, not defensive.
- Limitation: exclusions are project-wide, not per unit (X1/X3). A declared mount path is invisible to
  `git status` for every run of that project; that is a disclosure about *path names*, not values, and
  it is recorded as such.
- Limitation: `turn`-lifecycle secrets in a `workspace`-lifecycle world cannot exist yet; the reverse
  (node_attempt in M4) is additive.
- Limitation: `content_sha256` makes low-entropy secrets (a 4-digit PIN) enumerable by anyone who can
  read the row *and* guess candidates. Accepted deliberately for retry-comparison, and the reason the
  column is not exposed via the API.

## Security/privacy

**What this does NOT guarantee, stated plainly (05 "Threat-model clarification"):**

- An agent granted read access to `.env` **can copy or exfiltrate it over any allowed channel**.
  File permissions are defense in depth here; the load-bearing controls are ADR-0019's grants (which
  workspace, which project), its egress policy, and secret *scope*.
- One Unix uid. Everything materialized at 0600 is readable by every process on that worker running
  as that uid — including a compromised harness, a harness wrapper, or a helper the agent started
  (SANDBOX.md C8 proves restrictions inherit to grandchildren, which cuts both ways: the grant that
  lets the agent read the file lets its children read it too).
- Linux `filesystem.deny` is point-in-time (SANDBOX.md), so no deny rule is relied on for anything
  created at or after launch. Absence-of-grant is the mechanism, and ADR-0017 P9 shows it fails under
  `/tmp`, which is why temp paths are prohibited.
- Redaction of logs and events is best-effort by design (05), and the count of redactions is the only
  thing that makes "nothing to redact" distinguishable from "redaction broken".
- Encryption at rest is not integrity of *use*: `serve` and `worker` both hold the keyring, so an
  attacker who owns either process (or a request that reaches either) can decrypt. The boundary this
  record defends is the database dump, the HTTP surface, the journal, and artifacts — not the app
  processes.
- No tenant isolation claim (D-010 application RBAC ≠ OS isolation; D-025 **Open**; 05 "Trust
  caveat").

**Fail-closed positions:** unknown `key_id` → decrypt refused, `secret.materialization_failed`;
`revoked_at` set → refused; destination outside the authorized checkout → refused before any write;
target is a tracked file and no policy exception exists → refused; `integration_broker` → refused;
`enforcement: required` and the launch would expose the file beyond the unit's grants → refused
(ADR-0019). Every refusal is an event plus an `audit_events` row with `outcome='denied'`, and every
materialization is an event with metadata only (09's `secret.materialized` **metadata only**),
including for a case-15 probe from a non-member, who receives `404` with no existence signal
(ADR-0014 §3).

## Verification

Nothing in this record is claimed as observed except the exclusion mechanism it depends on, which was
measured for ADR-0017 and is cited here as X1/X2/X4 (per-worktree `info/exclude` ignored; shared
`<mirror>/info/exclude` honored and confirmed by `git check-ignore -v`; the agent's own write to that
file denied). Required gates, all scripted in `docs/m3-contract.md` § "M3 exit test plan" and none
runnable before M3 code exists:

- case 12 (`.env` present only during the authorized unit, absent from git changes, logs and artifact
  export): destination exists mid-attempt, is untracked (`git ls-files` empty for it), is invisible in
  `git status --porcelain`, is absent from `git diff`/`git status` after the attempt, is gone at
  cleanup, and grepping the whole `domain_events` journal, every stored artifact and the worker log for
  the planted sentinel value yields zero matches;
- case 15 (non-member of project B probes API/SSE/artifacts/assistant search) for the secret surface:
  every route answers `404` and writes an audit denial, with no metadata leak;
- property/fuzz (05, `12-test-strategy.md` "Property/fuzz: … secret path materialization") over
  `relative_path`: `..`, absolute paths, symlinked parents, NUL, unicode normalization, trailing dot,
  case collisions and over-long names, each either accepted into the exact authorized directory or
  rejected — never both, never silently rewritten;
- at-rest evidence: `psql` shows ciphertext (with `encode(ciphertext,'base64')` non-empty,
  `ciphertext::text` containing no plaintext substring of the sentinel), `pg_dump` grep for the
  sentinel returns nothing, and starting the worker with an unreadable keyring fails readiness rather
  than serving turns;
- redaction: a forced leak (a prompt that echoes the value) lands as `***redacted(N)***` with `N>0`
  counted in the metric, proving the redaction path is live rather than decorative.

**Not proven by M3** and explicitly out of scope: KMS-backed providers (interface only),
`integration_broker` delivery, secure deletion, multi-worker key sharing, secret rotation racing an
in-flight turn (only the between-attempts path is tested), and any claim about a hostile
same-uid process.

## Migration/rollback

`00004_m3_secrets_artifacts.sql` adds five tables and no column to existing ones (draft DDL in
`docs/m3-contract.md`), so `00001`–`00003` rows are untouched and `ExpectedSchemaVersion()` advances
by one. Deploy order is `migrate` → `worker` (which needs the keyring to exist before it can serve a
secret-bearing profile) → `serve` replicas; a replica that starts without the keyring mounted must
fail **readiness**, not health (ADR-0013 §6), so the load balancer drains it.

Rolling back the feature is forward-compatible: drop the mounts from profiles, and the worker stops
materializing; the tables stay, because `secret_versions` rows are the only copy of customer secrets
and no migration may delete them. Replacing the file keyring with a KMS is a new `KeyProvider` plus a
rewrap pass, no schema change. Replacing the exclusion mechanism with a per-worktree one is possible
only if git's behaviour changes (X1/X3 today) and would be an amendment to ADR-0017, not to this
record — the checkpoint/artifact filters stay either way.
