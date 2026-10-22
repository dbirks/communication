# Agent push — ADR-0045 (`docs/adr/ADR-0045-agent-held-github-token.md`)

Making the Accepted ADR-0045 real: an agent whose profile is authorized for a
GitHub token can push a branch and open a draft PR from the sandbox it already
runs in.

## Today (finding — Phase A)

**Secret → sandboxed agent env: already wired, on both agent paths.**

- Pipeline node attempts: `internal/worker/agentturn.go` (`executeAttempt` →
  `materializeSecrets`) resolve through the same
  `internal/secrets/resolver.go` (`Resolve` / `authorizeAgainst`, which checks
  `allowed_agent_profile_ids` against the attempt's `AgentProfileID`), then
  `internal/secrets/materialize/materialize.go` delivers `env`-mode mounts into
  `Materialized.Env` (`KEY=value`), which `internal/worker/agentturn.go` joins
  into the launch env and `internal/worker/procexec.go` joins into the command
  env.
- Thread / conversation turns: the same `SecretMaterializer` seam through
  `internal/worker/unit.go` (`Prepare` → `materializeSecrets`, turn lifecycle).
- So the materialization machinery, the profile allowlist and the per-attempt
  scoping are all present today; nothing about "which profile may hold which
  secret" is missing.

**Env var name(s): the mount's `env_name` is the only name delivered today** (e.g.
`GH_TOKEN=…` for a mount declared with that name). Neither `GH_TOKEN` nor
`GITHUB_TOKEN` is ever emitted as the pair a GitHub client reads.

**Worker image (`worker/Dockerfile`):** `git` IS installed (runtime stage apt-get
`ca-certificates git openssh-client libffi8`); the `gh` CLI is NOT installed and
`curl` is deliberately absent (Dockerfile comment). So git is present, gh is not.

**Git push authentication: none today.** The launch env sets `GIT_CONFIG_NOSYSTEM=1`,
`GIT_TERMINAL_PROMPT=0` and the `GIT_AUTHOR_*`/`GIT_COMMITTER_*` identity
(`internal/agent/acp/launchenv.go`); there is no `credential.*` configuration, so
a sandboxed `git push` cannot authenticate.

**Egress (`docs/design/agent-egress.md`, ADR-0035, `internal/worker/egress.go`):**
the shipped agent-turn allowlist is `api.anthropic.com` only; an operator widens
it via `COMMUNICATION_AGENT_EGRESS_ALLOW` (comma-separated). Pushing needs
`github.com` (git smart-HTTP) and `api.github.com` (REST, e.g. draft-PR creation).

**Delivery-argv discipline (finding):** the launcher's own long-lived token
already rides the exec environment (ADR-0040); the GitHub token delivered through
a secret mount was still being appended into the env list that renders into the
`-- env NAME=value …` argv hop, which the audit journal records verbatim — the
value would have reached the journal.

## What changed (Phase B)

- `internal/worker/gitpush.go` (new): `GitPushEnv(delivered)` — token under both
  `GH_TOKEN` and `GITHUB_TOKEN`, plus `GIT_CONFIG_COUNT=1`,
  `GIT_CONFIG_KEY_0=credential.https://github.com.helper`,
  `GIT_CONFIG_VALUE_0=!f() { echo username=x-access-token; echo password=$GH_TOKEN; }; f`.
  `WithoutGitTokenEnv(kvs)` strips token entries from the argv-bound copy.
- Launch paths updated so a delivered GitHub token joins the exec environment
  (sandboxed and unsandboxed, unit / agent-turn / process.exec) and git is wired
  through the env; the token never enters argv.
- Egress warning: when a GitHub token is delivered and `github.com` / `api.github.com`
  are not in the allowlist, the worker logs a warning that push will fail.

## How to enable (operator)

1. Create a GitHub fine-grained PAT (or classic) scoped to the target repo with
   `contents:write` + `pull_requests:write` (no merge/admin scopes).
2. Add it as a project secret (`delivery_mode: env`, purpose e.g. `git_push`) whose
   `allowed_agent_profile_ids` names the agent profile(s) that may push.
3. Set the worker env: `COMMUNICATION_AGENT_EGRESS_ALLOW=github.com,api.github.com`.
4. Run `communication doctor` / check the sandbox report.

## Not yet / NEXT

- Real push proof in the lab: needs a real token; run a push turn under the widened
  allowlist and confirm the token is absent from logs/journal/UI.
- The worker image does not ship `gh` (and `curl` is deliberately absent); agents
  open PRs via the REST API with curl/gh if present.

## Security finding (2026-10-22)

**Env-delivered secret values were written into nono's audit journal via the launch argv.**

Finding: every secret delivered with `delivery_mode: env` rode the launcher's
`-- env NAME=value …` argv hop and therefore landed in nono's audit journal
verbatim (ADR-0040: the journal records the child's argv verbatim; the egress
marker in `egressaudit.go` relies on exactly that argv shape).

Wider than the GitHub token: the ADR-0045 Phase-A wiring appended every
`materialized.Env` entry (all env-delivered SecretRef mounts, not just the
GitHub token) into the adapter env list the argv builder renders, while the
ADR-0045 Phase-B `WithoutGitTokenEnv` name-strip only removed `GH_TOKEN` /
`GITHUB_TOKEN` from that copy. Any secret mounted with `delivery_mode: env` for a
sandboxed agent reached the audit journal in plaintext.

Since when: the env-mount delivery arm is ADR-0018 D4's `env` delivery; the
agent-turn and process.exec joins of `materialized.Env` into the argv-bound
adapter env are the pre-existing shape (see the comments at
`internal/worker/agentturn.go` — "The env-delivered mounts join the child
environment here and nowhere else" — and `internal/worker/procexec.go`).

Fix: structural. Env-delivered secrets now travel through the launched
process's exec environment only — through `acp.LaunchEnv`'s `SecretEnv` channel,
folded with the launcher token and GitHub-push wiring by `execEnv`, and
subtracted from the argv-bound copy by `argvBoundEnv`. The name-based
`WithoutGitTokenEnv` is gone; the GitHub token is derived by `GitPushEnv` into
the exec environment.

Operator action: treat any secret delivered with `delivery_mode: env` to a
sandboxed agent before this fix as exposed to anyone who can read the worker's
sandbox home (the nono audit store under the launcher's state home, `<launcher-home>/.local/state/nono`,
one file per launch session) — rotate it, and purge the journal files for the
affected attempts before rotating.

Verification: sentinel-valued fake mounts on all three launch paths (AgentTurn,
process.exec, conversation Unit) assert the value reaches the exec environment
and nowhere in the argv, the rendered nono argv, log lines, or journalled
payloads.
