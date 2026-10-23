# ADR-0059 — pi coding agent as an ACP launcher (via the `pi-acp` adapter) + API-key delivery

- **Date:** 2026-10-23
- **Status:** Accepted
- **Owners:** backend (be-launchers)
- **Related decisions / contracts:** ADR-0051 (launcher registry + evidence), ADR-0019 D4/D5/D6 (launch env built from scratch, credential custody, fail-closed), ADR-0040 (long-lived headless credential delivery — API-key form mirrored), ADR-0035/ADR-0036 (egress), `docs/compatibility/ACP.md` + `docs/compatibility/acp-observed.json` + `docs/compatibility/probes/acp/`, `internal/agent/acp/launchers.go`, `worker/Dockerfile`, `cmd/communication/worker.go`

## Context

The app-shell redesign's fifth agent card (`pi`) had no launcher entry and its
compatibility row read `GAP — no ACP adapter for pi on this host`. The task
(`pi-launcher`) was to register pi as an ACP launcher so the profiles UI, the
New-profile dialog and the Operations capability matrix can render it from the
registry instead of special-casing it.

The blocker found while confirming the first pi release that ships
`--mode acp` (task step 1): **no released pi does**. The installed pi is
`v1.1.0`; the npm latest `@earendil-works/pi-coding-agent` is `1.4.0`; upstream
`main` types the CLI mode as `"text" | "json" | "rpc"` and rejects
`--mode acp`. The two ACP-mode PRs (#241, #836) were closed unmerged and the
package changelog never mentions ACP — so the native path is not available and
the working ACP integration today is the community adapter
`pi-acp@0.0.34` (npm), which spawns `pi --mode rpc` and bridges ACP JSON-RPC 2.0
over stdio to pi's JSONL RPC dialect (requires pi >= 0.81.0; the installed 1.1.0
satisfies it).

## Options considered

| Option | Advantages | Disadvantages | Evidence |
|---|---|---|---|
| A. Register launcher `pi` → executable `pi-acp` (adapter) | The only ACP-capable pi entry that exists today; protocol bridge already runs; task step 4's registry-driven UI then lights up | Not the "native `pi --mode acp`" the task title names; the adapter is community-maintained (MIT) and its permission behaviour is unprobed | `pi-acp` README, `pi` CLI source on `main` |
| B. Register launcher `pi` → executable `pi` with `Args ["--mode","acp"]` | Literal reading of the task | The mode value is rejected by every pi release on this host (`Error: Invalid mode "acp". Valid values: text, json, rpc`) — the launch would fail before any protocol traffic | task step 3 |
| C. Defer until pi ships native ACP | Honest | The product owner's redesign cannot ship the fifth card without an entry; a failed launch is worse than an adapter | — |

## Decision

**A**: launcher `pi` registered in `internal/agent/acp/launchers.go` with
`Executable: "pi-acp"`, `Package: "pi-acp"`, `Version: "0.0.34"`, `Args: []`,
fail-closed ask mode (`AskModeID: ""` — no prompting mode observed) and an
OpenAI-compatible API-key delivery:

- the API key travels through the launch environment only, via the launcher's
  declared auth variable (`OPENAI_API_KEY` for the `collective` provider);
- the operator key file is `COMMUNICATION_PI_API_KEY_FILE` (read at each launch,
  fail-closed on missing/empty);
- the per-turn provider config (base URL + model) is rendered into the agent
  home as pi `models.json` (`apiKey` via `$ENV` interpolation, so the key never
  lands in a file the worker or journal can see) from
  `COMMUNICATION_PI_BASE_URL` + `COMMUNICATION_PI_MODEL`.

Unobserved capabilities stay `not_tested` (no row → honest default): resume,
permission prompts, cancel, required-sandbox (nono), APM target.

## Consequences

- `GET /api/v1/launchers` now lists `pi` as registered; the New-profile dialog's
  Pi card reads it from the registry (no UI hardcoding added — the dialog already
  resolves cards through `useLaunchers`/`launcherEntry`).
- The worker image installs `@earendil-works/pi-coding-agent@1.4.0` + `pi-acp@0.0.34`
  (worker/Dockerfile); the probe gained a `pi` adapter entry
  (`docs/compatibility/probes/acp/acp_probe.py`).
- The 2026-10-23 host probe (`docs/compatibility/probes/acp/results-pi.json`)
  observed: `initialize` PASS (protocolVersion 1, `loadSession` advertised),
  `session/new` PASS, one prompt turn streamed tool calls against the LLM
  collective, `session/set_config_option model=collective/flint` PASS.
  Capability cells not exercised remain `not_tested`.

## Security/privacy

ADR-0040's delivery rule (env only, never argv / journalled file) is mirrored for
the API key; errors name the file and the fault, never the value. Fail-closed
ask mode (ADR-0019 D6) until a permission round-trip is observed.

## Verification

- Host probe run: `python3 -I docs/compatibility/probes/acp/acp_probe.py
  --agent-cmd <pi-acp> --label pi --out docs/compatibility/probes/acp/results-pi.json
  --steps streaming --set-config model=collective/flint` → initialize PASS,
  session/new PASS, session/set_config_option model PASS, tool_calls PASS
  (hello.txt created), streaming FAIL (no `agent_message_chunk` emitted).
- `go test -race ./internal/agent/... -count=1` green (launcher registry,
  evidence, factory); `gofmt` clean on touched Go files.

## Migration/rollback

No schema change. Rollback = drop the `pi` entry from `KnownLaunchers` and the
pi block from the worker Dockerfile; the adapter and the operator env vars are
additive.
