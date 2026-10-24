# ADR-0061 — A repository's GitHub credential: private repos for clone, fetch and issue reads (integration_broker, first consumer)

- **Date:** 2026-10-24
- **Status:** Proposed
- **Owners:** control-plane + worker contributors (orchestrator-authored; implemented by workers)
- **Related:** ADR-0018 (SecretRef, `integration_broker` declared-but-unbuilt), ADR-0031 (anonymous issue listing; option B deferred to "a follow-up"), ADR-0045 (agent-held push token), ADR-0056 (run triggers poll issues anonymously), ADR-0060 (per-repo attachments), `05-workspaces-security-secrets.md` § SecretRef

## Context

Every GitHub read the control plane and the worker make today is anonymous: the worker's mirror
`git clone --mirror` / `fetch` (`internal/workspace/git/workspace.go`) carries no credential, and
the issue client (`internal/integrations/github/client.go`) deliberately sends no `Authorization`
header (ADR-0031). A **private** repository therefore cannot be prepared into a workspace, listed
on the repository page, or polled by an issue trigger — the product's core loop (issue → run →
agent pushes a draft PR, ADR-0045) works only on public repos. The first real proof target
(the product owner's throwaway repo) is private.

ADR-0018 already reserves `delivery_mode: integration_broker` for "a secret the platform uses on
the agent's behalf and never hands to it"; the API refuses to create one because no consumer
exists. This ADR builds the first consumer.

## Options considered
| Option | Advantages | Disadvantages | Evidence |
|---|---|---|---|
| A: operator-mounted credential helper in the worker's git HOME + a server-wide token env | No schema change | One credential for every project (cross-tenant), issue reads still need a code path, invisible in the UI | `gitcmd.go` Runner.Home comment |
| B: a project secret with `delivery_mode: integration_broker`, referenced by the repository row | Per-project, audited, reuses the SecretRef keyring and authz; the declared extension point | Migration + API + UI field | this ADR |
| C: GitHub App installation tokens | Short-lived, fine-grained | App registration, JWT signing, installation discovery — a much larger surface; no app exists | Later |

## Decision

Option B.

1. **Schema (migration 00016):** `repositories.credential_secret_id uuid NULL REFERENCES secrets(id)`.
   The referenced secret must belong to the same project (or the project's org) and have
   `delivery_mode = 'integration_broker'`; enforced in the store write, not only the API.
2. **Secrets API:** `integration_broker` becomes creatable (purpose free text, e.g. `github_repo`).
   It is **never mountable** — mounts keep refusing it (ADR-0018 clause 8 stays true for agents):
   an integration_broker secret never enters an agent's environment, argv, file tree or sandbox.
   The ADR-0045 push token remains a separate `env` secret allowlisted to an agent profile.
3. **Repository API:** create/patch accept `credential_secret_id` (nullable; `null` clears). The
   response carries `credential_secret_id` and a derived `credential: "none" | "configured"` —
   never the value.
4. **Worker clone/fetch:** when the repository row has a credential, the worker resolves it
   through the existing resolver (new broker path: authorized by the repository reference, not by
   an agent profile) and runs **only the mirror `clone --mirror` / `fetch`** with the token in the
   exec environment, wired the ADR-0045 way: `GIT_CONFIG_COUNT/KEY/VALUE` credential helper for
   `https://github.com` reading `$COMM_GIT_TOKEN`; never argv, never written to disk, never into
   the mirror's config (the remote URL stays token-free). The agent's worktree inherits nothing.
5. **Issue reads:** the API's GitHub client gains an optional bearer token per call
   (`Authorization: Bearer <token>`); the repository-issues endpoint and the ADR-0056 poller pass
   the repository's credential when set, anonymous otherwise. Rate-limit/404 mapping unchanged.
6. **UI:** repository settings get a "GitHub access" field (pick an integration_broker secret or
   none); the repository page's issue panel says "private repo — add GitHub access" on a 404 with
   no credential instead of the generic not-found.

## Consequences

- Private GitHub repos work end to end: prepare, issue listing, issue triggers, and (with the
  separate ADR-0045 token) agent push + draft PR.
- One credential per repository; rotation = new secret version (resolver reads the current
  version on each use; nothing caches the plaintext beyond one call).
- `integration_broker` gains exactly one consumer; other integrations need their own ADR.

## Security/privacy

- The token is decrypted only in the process making the call (serve for issue reads, worker for
  mirror git), held in memory for that call, delivered to git via env only. Fail closed: a
  credential that cannot be resolved fails the prepare/poll with a typed error naming the
  repository, never falls back to anonymous silently (the error is visible on the trigger's
  `last_error` and the attempt).
- Agents never see it: the mirror is fetched before the sandbox starts, the worktree's remote URL
  has no credential, and the agent's push uses its own profile-allowlisted token (ADR-0045).
- Audit: each broker resolve records a `secret.resolved` audit row with `consumer` =
  `repo_mirror` | `issue_read`, like mount resolves do.
- Cross-tenant: the store write rejects a credential_secret_id from another project/org.

## Verification

- Store tests: create/patch with a same-project broker secret; refusal for another project's
  secret, for an `env` secret, and mount refusal for a broker secret.
- Worker unit test: the git argv for clone/fetch contains no token; the env carries the helper.
- GitHub client test: the bearer header is sent when a token is given and absent otherwise.
- Real proof (lab): the private repo `dbirks/comms-test-repo-1` is prepared into a workspace,
  its issues list on the repository page, and an issue trigger fires on a real label.

## Migration/rollback

Additive: nullable column, default none. Rollback = drop the column after clearing references;
anonymous behaviour is unchanged for repositories without a credential.
