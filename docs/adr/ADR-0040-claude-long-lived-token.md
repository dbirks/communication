# ADR-0040 — Claude launcher long-lived token via `CLAUDE_CODE_OAUTH_TOKEN`

- **Date:** 2026-10-20
- **Status:** Proposed (accepted-pending-owner sign-off)
- **Owners:** agent-runtime / sandbox
- **Related decisions / contracts:** ADR-0019 (harness credentials, D4), ADR-0018 D4 (env values
  never in the journal), docs/compatibility/ACP.md (Claude row)

## Context

On the home cluster the claude `agent.acp` step fails with
`{"code":-32000,"message":"Authentication required"}`. The worker's `CLAUDE_CONFIG_DIR` is seeded
from a Secret that is a copy of the owner's interactive `~/.claude/.credentials.json`. That login
cannot stay valid on a server: the access token expires in hours, and the refresh token is rotated
by the owner's local sessions, so the copy is invalidated out from under the worker.

Claude Code ships a long-lived headless credential for exactly this: `claude setup-token` prints a
token (value prefix `sk-ant-oat`) that Claude Code reads from the environment variable
`CLAUDE_CODE_OAUTH_TOKEN`.

Constraint from ADR-0018 D4 / the seams rule: a secret value must never appear in a log line, a
journal entry, an event, or a transcript. Constraint measured with nono 0.80.0: `nono` records the
child's argv **verbatim** in its audit journal, so a value delivered through the
`-- env NAME=value …` argv hop is written into the audit journal.

## Options considered

| Option | Advantages | Disadvantages | Evidence |
|---|---|---|---|
| A. Copied interactive login (`CLAUDE_CONFIG_DIR` from a Secret copy) | No new surface | Expires/rotates out from under the worker; measured failing on the home cluster | `Authentication required` (-32000) on `agent.acp` |
| B. API key via `ANTHROPIC_API_KEY` | Simple, long-lived | Different billing/usage model than owner login; does not match the "the owner's claude account" operating model; new credential kind to manage | — |
| C. `setup-token` value in argv (`env CLAUDE_CODE_OAUTH_TOKEN=…`) | Matches today's env-hop delivery | The token lands verbatim in nono's audit journal (argv is recorded) | measured: `nono audit show` records child argv |
| D. **`setup-token` value in the sandbox launcher's process environment** | nono inherits its own process environment into the sandboxed child (measured on 0.80.0); the value never enters argv, a log, or a journal; operator config is a file, so a rotated Secret takes effect without a restart | Relies on nono's env inheritance (pinned 0.80.0); unsandboxed launches instead use the child's exec environment | `nono run -s --allow-cwd sh -c 'test -n "$CLAUDE_CODE_OAUTH_TOKEN" && echo present'` prints `present` with the variable set only on nono's own environment |

## Decision

Operator configuration is a **file**, never a raw-token environment variable on the worker:
`COMMUNICATION_CLAUDE_OAUTH_TOKEN_FILE=<path>` (e.g. a mounted Secret key). The worker reads the
file at launch time, trims it, and refuses to launch (fail-closed, clear error naming the file and
the fault and never the value) when the file is missing, empty, or does not start with
`sk-ant-oat`.

When configured, **both** the pipeline `agent.acp` path (`AgentTurn`) and the conversation
path (`Unit`/`TurnLoop`) deliver `CLAUDE_CODE_OAUTH_TOKEN=<token>` to the claude launcher through
the real process environment:

- sandboxed (enforcement `required`): the value is appended to **nono's own** launch environment
  (`UnitService.launcherNonoEnv` / `AgentTurn.nonoLauncherEnv`). nono inherits its own process
  environment into the child, so the agent sees the variable; the argv that the audit journal
  records contains only the `env NAME=value` hop built from the from-scratch agent environment,
  which does not carry the token.
- unsandboxed (configured non-required mode): the value is appended to the adapter's exec
  environment (`os/exec` Env), again an environment, never argv.

`CLAUDE_CONFIG_DIR` is unchanged: the agent still needs a writable per-attempt config directory
for its own state. The token variable simply outranks nothing and shadows the (expired) copied
login inside the sandbox.

The claude `Launcher` registry entry declares the delivery names (`CLAUDE_CODE_OAUTH_TOKEN`,
`COMMUNICATION_CLAUDE_OAUTH_TOKEN_FILE`, prefix `sk-ant-oat`), so launcher knowledge stays in the
registry as with `AuthEnvVars`. `communication doctor` reports only `configured, N chars, prefix
ok` (or the fault) — never the value.

## Consequences

- A rotated Secret file takes effect at the next launch, with no worker restart.
- The token value is absent from argv (and thus the audit journal), from slog output, domain
  events, transcripts, attempt detail, and doctor output — pinned by tests
  (`internal/worker/claude_oauth_test.go`, `internal/agent/acp/claude_oauth_test.go`), including a
  real-nono run asserting the sandboxed child sees the variable and the session's audit record does
  not contain the value.
- nono's env inheritance is a **pinned-version** behavior (0.80.0, ADR-0019 N-a). A nono upgrade
  must re-run the sandbox matrix including this inheritance probe before a token launch trusts it.
- Unconfigured workers are byte-for-byte unchanged: no `CLAUDE_CODE_OAUTH_TOKEN` anywhere.

## Security/privacy

- The value is a long-lived **owner credential**. This is fail-closed: a broken file refuses the
  launch rather than running unauthenticated.
- **ADR-0019 D4 caveat, unchanged and now more pronounced:** the token authenticates the owner's
  interactive account from every worker that mounts the file. This is a shared credential, not a
  per-tenant/per-user isolation boundary; nothing here may be cited as evidence of credential
  isolation (same standing rule as the `AuthEnvVars` directory grants).
- The token file path (not the value) may appear in error text and doctor detail.
- The value never enters argv, so it never enters the audit journal; never a log line, event,
  transcript, or attempt detail.

## Verification

- `go build ./... && go vet ./...` clean.
- Unit tests: `go test -race ./internal/agent/acp/ ./internal/worker/ -run 'ClaudeOAuth|LauncherOAuthToken' -count=1`
  (argv-absence, exec-env presence, fail-closed, regression guard; real-nono run asserts the
  sandboxed child prints `present` and `nono audit show` of its own session does not contain the
  fake token).
- Measured on nono 0.80.0 (2026-10-20): a process environment variable set only on `nono run` is
  visible inside the sandboxed child, and `nono audit show` records argv, not the parent
  environment.

## Migration/rollback

Rollback: unset `COMMUNICATION_CLAUDE_OAUTH_TOKEN_FILE`; the launcher authenticates through
`CLAUDE_CONFIG_DIR` exactly as before. Rollforward: rotate the `claude setup-token` (the old value
can be revoked in the owner account) and update the Secret file — no worker change required.
