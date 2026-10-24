# ACP compatibility matrix

## Provenance

- Date: 2026-10-14 (baseline), pi row added 2026-10-23; pi Permission/Nono cells updated 2026-10-24 from the M4 lab (`docs/compatibility/SANDBOX.md` § "pi launcher in nono (2026-10-24)")
- Host OS/kernel: Linux 7.2.9-arch1-1 (Arch); Python 3.14.7; Node v26.11.1; npm 12.2.0
- Probe: `docs/compatibility/probes/acp/acp_probe.py` (raw JSON-RPC 2.0 over stdio, stdlib only; baseline rows from probe v0.0.1, Permission/Cancel cells from v0.0.3). Rerun: see `docs/compatibility/probes/acp/README.md`.
- Adapters under test (installed under `$HOME/.local/share/communication-lab/acp/`, exact pinned versions):
  - `@agentclientprotocol/claude-agent-acp@0.90.0` — `dist.integrity`: `sha512-XgbpMB0CIVDAxZKESwUPUiuXxdzlh8Ga1gT6pBufwkD38Zclo8/GP5khCTKssvLGad2T/8iASZusWcsDzlqpQQ==`
  - `@agentclientprotocol/codex-acp@2.2.2` — `dist.integrity`: `sha512-vNdeNV3jxbqaH7MYvVWzyB6cMOz+YGIV9W1xyBDsQfoii92DulZLM+ahCL2T2G6uohlaB1Yma347p2kLfAab2w==`
  - `pi-acp@0.0.34` (community ACP adapter; spawns `pi --mode rpc`) — installed via `npm install -g pi-acp`; `pi` `v1.1.0` on PATH (the adapter's own prerequisite: pi >= 0.81.0; the installed 1.1.0 satisfies it)
- Harness versions: `claude` 2.1.300 (Claude Code); `codex-cli` 0.162.1; pi `v1.1.0` (via `pi-acp`)
- Harness versions: `claude` 2.1.300 (Claude Code); `codex-cli` 0.162.1
- Auth mode: the harness's own local login of the developer machine — **NOT** organization-managed credentials; see 04 "Credential source".
- Raw evidence (redacted): `docs/compatibility/probes/acp/results-claude.json`, `docs/compatibility/probes/acp/results-codex.json` (probe 0.0.1 baseline) and `docs/compatibility/probes/acp/results-claude-permission.json`, `docs/compatibility/probes/acp/results-codex-permission.json` (probe 0.0.3 permission + 5× cancel follow-up, run 2026-10-14). Transcripts/stderr under `$HOME/.cache/communication-lab/m0-acp-probe/` and `.../m0-acp-permission/`.
- Result words: `PASS` observed and matched · `FAIL` observed and did not match · `GAP` could not test.

## Matrix

Columns match the protocol compatibility table in `communication-spec/12-test-strategy.md`.

| Candidate | New session | Streaming/tool calls | Permission | Cancel | Native restore | APM target | Nono |
|---|---|---|---|---|---|---|---|
| Claude Code ACP adapter `@agentclientprotocol/claude-agent-acp@0.90.0` (claude 2.1.300) | PASS | PASS | PASS — with `session/set_mode modeId=default` (Manual) the adapter sent `session/request_permission` (`allow_once`/`allow_always`/`reject_once`); allow_once → `allowed.txt` created, reject_once → `rejected.txt` absent (`results-claude-permission.json`). Under the default `auto` mode it still never asks (baseline GAP) | PASS — 5/5 `stopReason=cancelled` <0.1 s after `session/cancel` sent 2 s into the turn, 5/5 with the turn still open (`results-claude-permission.json`); **timing-dependent**: at a 5 s delay the adapter sometimes auto-backgrounds `sleep 60` and closes the turn `end_turn` before the cancel lands (0/5 in that run) | PASS — `loadSession` advertised; 10 updates replayed | GAP — tested in separate M0 spikes | GAP — tested in separate M0 spikes |
| Codex ACP adapter `@agentclientprotocol/codex-acp@2.2.2` (codex-cli 0.162.1) | PASS | PASS | PASS — with `session/set_mode modeId=read-only` the adapter sent `session/request_permission` (`allow_once`/`allow_always`/`reject_once`); allow_once → `allowed.txt` created, reject_once → `rejected.txt` absent (`results-codex-permission.json`). Under the default `agent` mode it still never asks (baseline GAP) | PASS — 5/5 `stopReason=cancelled` at 2 s into the turn (`results-codex-permission.json`) | PASS — `loadSession` advertised; 15 updates replayed | GAP — tested in separate M0 spikes | GAP — tested in separate M0 spikes |
| Gemini ACP | GAP — `gemini` not installed on this host, no Google credentials | GAP — same reason | GAP — same reason | GAP — same reason | GAP — same reason | GAP — same reason | GAP — same reason |
| Pi ACP adapter (`pi-acp@0.0.34`, spawns `pi --mode rpc`; native `pi --mode acp` not shipped by any release — installed pi 1.1.0, npm latest 1.4.0, upstream main all validate `--mode` against `text|json|rpc`) | New session **PASS**; one prompt turn streamed **tool calls** (`hello.txt` created, 2 tool calls) against the LLM collective, with `session/set_config_option model=collective/flint` **PASS** | **tool_calls PASS** (agent emitted `agent_thought_chunk` ×77 + `tool_call` ×2 + `tool_call_update` ×7; `hello.txt` content `hello`) — the probe's `streaming` step FAILed only because pi emitted **no `agent_message_chunk`** (final answer text) during the turn, so the message-text expectation did not hold | **GAP — no prompting mode exists to verify** (2026-10-24 lab): in `pi-acp@0.0.34`'s shipped bundle the only `session/request_permission` call site is `requestExtensionPermission`, reached solely from the `extension_ui_request` handler (pi *extension* UI dialogs); ordinary tool execution is never gated, and the advertised `modes` are pi's thinking levels (`off…high`). The worker therefore fail-closes `ask`/`deny`/`preapproved_within_sandbox` profiles on launcher pi (ADR-0019 D6): pipeline attempt `1389e01a-7e44-51ba-ae62-4ca9eb5644ae` detail `launcher pi has no verified prompting mode … running its never-asks default would be a lie about review` | GAP — not exercised | GAP — not exercised | GAP — not exercised | **GAP** (2026-10-24) — a `required`+`preapproved` `agent.acp` attempt (run `01a16fb5-e95e-75f4-bfef-d780c615542a`, profile row `pi/required/preapproved_within_sandbox`) was refused **before** sandbox verification: 0 `sandbox.verified` rows, no launch; the nono boundary for pi stays not_tested until the prompting-mode and provider-config decisions in SANDBOX.md are made |

Protocol negotiated by both probed adapters: `protocolVersion: 1` (v1 baseline; v2 not exercised).

## Known limits / observations

### Claude Code (`@agentclientprotocol/claude-agent-acp@0.90.0`)

- Negotiated `protocolVersion` 1; `agentInfo` `{name: "@agentclientprotocol/claude-agent-acp", version: "0.90.0"}`.
- Advertised capabilities: `loadSession: true`; `promptCapabilities` image + embeddedContext; `mcpCapabilities` http + sse; `sessionCapabilities` additionalDirectories/close/delete/fork/list/resume; `auth.logout`; `_meta.claudeCode.promptQueueing`. `authMethods` empty — it rides the ambient `claude` CLI login.
- Permission: with the adapter's default `auto` mode the agent wrote `hello.txt` **without any `session/request_permission` request** (baseline GAP). In mode `default` the round-trip works both ways — see *Permission modes* below.
- Cancel: 5/5 iterations returned `stopReason=cancelled` within <0.1 s of `session/cancel` when the notification was sent 2 s into the turn (`--cancel-repeats 5 --cancel-after 2.0`). A first attempt of the same probe at `--cancel-after 5.0` returned `end_turn` 5/5 (raw log: `$HOME/.cache/communication-lab/m0-acp-permission/scratch/results-claude-permission-cancel5s.json`): Claude Code had set `run_in_background: true` on the `sleep 60` Bash call and closed the turn with "I've started the 60-second sleep in the background" before the cancel arrived, so there was nothing in flight to cancel. A single 5.0 s repeat of that same setup did return `cancelled` (`.../scratch/gapcheck-claude.json`), i.e. the auto-backgrounding is model-dependent, not deterministic. The original single-run `end_turn` flake is the same mechanism, so **cancel is reliable only while a tool call is genuinely in flight** — the client must not assume a cancel that lands after a turn has closed produces `cancelled`. The probe now records `cancel_sent_while_turn_open` per iteration and reports such an iteration as GAP instead of a misleading FAIL.
- Emits extra opaque updates (`available_commands_update`, `usage_update`, `session_info_update`); a client must tolerate unknown `sessionUpdate` kinds.
- `session/new` returns `configOptions` and `modes` alongside `sessionId`; both `session/set_mode` and `session/set_config_option mode=…` are implemented and answered with an empty result / the full option list respectively (no `current_mode_update` or `config_option_update` notification was sent for either).
- Restart restore via `session/load` worked in-place (same cwd); different-workspace restore not tested (lab step 5 variant).

#### Permission modes (Claude)

Observed from `session/new` (`results-claude-permission.json` → `session/new` step) and confirmed by `session/set_config_option`:

- `modes.currentModeId` = `auto`; `availableModes` = `default` ("Manual — Always ask before making changes"), `acceptEdits`, `plan`, `auto` ("Claude handles permission decisions"), `bypassPermissions`.
- `configOptions` ids = `mode` (category `mode`, same values), `model`, `effort`, `fast`.
- Mode under test: **`default`** — the most restrictive mode that still performs the edit once approved. `plan` was rejected as a candidate because it gates implementation behind a plan/switch-mode step rather than exercising per-tool permission; `bypassPermissions` is the opposite extreme.
- Allow round: prompt to create `allowed.txt` → 1 `session/request_permission` (`toolCall.title` "Write allowed.txt") with options `allow-once`/"Yes" (`allow_once`), `allow-with-updates`/"Yes, allow all edits during this session" (`allow_always`), `reject`/"No" (`reject_once`). Client selected `allow_once` → turn closed `end_turn` after 3.2 s, `allowed.txt` existed with content `allowed` → **PASS**.
- Reject round: same three options, client selected `reject_once` (`optionId` `reject`) → `tool_call_update status=failed`, `rawOutput` "User refused permission to run tool", turn closed `end_turn` after 3.8 s, `rejected.txt` did **not** exist (agent replied "I didn't create `rejected.txt` because the permission request to write it was denied") → **PASS**.
- Net: the adapter is permission-capable, but permission prompting is a **mode property**, so `communication-spec/04-agent-runtime.md` "Permission policy" means the server must select a prompting mode (`default`) rather than accept the adapter default (`auto`).

### Codex (`@agentclientprotocol/codex-acp@2.2.2`)

- Negotiated `protocolVersion` 1; `agentInfo` `{name: "@agentclientprotocol/codex-acp"}`.
- Advertised capabilities: `loadSession: true`; `promptCapabilities` image + embeddedContext; `mcpCapabilities` http (acp/sse false); `sessionCapabilities` resume/list/close/delete/fork/additionalDirectories/**subagents**; `auth.logout`. `authMethods` offers `api-key` and `chat-gpt`; neither was used — the existing `codex-cli` login (`~/.codex/auth.json`) was sufficient, and the `api-key` method's `_meta` payload was redacted by the probe.
- Permission: same as Claude — no `session/request_permission` under the adapter default `agent` mode; file created without asking (baseline GAP). In mode `read-only` the round-trip works both ways — see *Permission modes* below.
- Cancel: 5/5 iterations returned `stopReason=cancelled` within <0.1 s of `session/cancel` at 2 s into the turn (`--cancel-repeats 5`), `sleep 60` tool call abandoned.
- Streams `agent_thought_chunk` in addition to `agent_message_chunk`; client mapping must decide what is displayable.
- `session/new`/`session/load` results carry `models` + `configOptions` + `modes`.
- Survived malformed stdin (`{not json`) with no stderr noise.

#### Permission modes (Codex)

Observed from `session/new` and confirmed by `session/set_mode` /
`session/set_config_option` (`results-codex-permission.json`):

- `modes.currentModeId` = `agent`; `availableModes` = `read-only` ("Requires approval to edit files and access the internet"), `workspace-write`, `agent` ("Auto review — only ask for actions detected as potentially unsafe"), `agent-full-access`.
- `configOptions` ids = `mode` (category `mode`, same values), `collaboration_mode`, `model`, `reasoning_effort`, `fast-mode`.
- Mode under test: **`read-only`** — the only listed mode that requires approval for every file edit, which is exactly what the permission round-trip needs; `workspace-write` would have auto-approved an in-workspace write and reproduced the `agent`-mode GAP.
- Allow round: prompt to create `allowed.txt` → 1 `session/request_permission` (`toolCall.title` "Edit files") with options `allow_once`/"Yes, proceed", `allow_for_session`/"Yes, and don't ask again for these files" (`allow_always`), `cancel`/"No, and tell Codex what to do differently" (`reject_once`). Client selected `allow_once` → turn closed `end_turn` after 5.6 s, `allowed.txt` existed → **PASS**. Note the reject option's `optionId` is literally `cancel` while its `kind` is `reject_once` — clients must key on `kind`, not the id.
- Reject round: same options, client selected the `reject_once` option → `rejected.txt` did **not** exist and the turn closed with `stopReason=cancelled` after 2.7 s (Codex reports a refused edit as a cancelled turn, Claude as `end_turn` — the client must not treat `cancelled` here as its own cancellation) → **PASS**.

### Both / general

- Neither adapter crashed or leaked on malformed input; both answered the valid `session/new` that followed.
- Permission requests were not exercised in the 0.0.1 baseline runs (negative observation only); they are now exercised in the 0.0.3 follow-up above. Both adapters are **permission-capable** but only in a stricter mode — per 04 "Permission policy", the server must select that mode (`default` for Claude, `read-only` for Codex) at session setup; the adapter defaults (`auto`, `agent`) never ask.
- This probe speaks raw ACP with no SDK. It is the baseline the Go SDK adapter (`github.com/coder/acp-go-sdk`, evaluated in a later M0 task) must reproduce message-for-message; SDK results are only credible when they match `results-*.json` here.
- Single-run results for the permission rounds; the 5× cancel repeat is the first reliability sample and it already shows timing sensitivity on Claude — the matrix needs repeated nightly runs (per 12-test-strategy CI note) before sign-off.
- Both adapters accept `session/set_mode` **and** `session/set_config_option mode=…` with the same effect; neither sent a `current_mode_update` or `config_option_update` notification afterwards, so a client must read the mode from the call result rather than wait for a notification.
- The pi adapter **does** send a `config_option_update` notification after a successful `session/set_config_option model=…` (the Claude/Codex probes observed none) — a client must tolerate the notification and read the value from the call result.

### Pi (`pi-acp@0.0.34`, pi v1.1.0)

- Registered as launcher `pi` (internal/agent/acp/launchers.go); the ACP entry point is the community adapter, which spawns `pi --mode rpc` — pi has no native `--mode acp` in any release (installed 1.1.0, npm latest 1.4.0 and upstream main all validate `--mode` against `text|json|rpc`; the ACP-mode PRs #241/#836 were closed unmerged and the changelog never mentions ACP).
- Observed (2026-10-23 host probe, `results-pi.json`): `initialize` PASS at `protocolVersion: 1` with `loadSession` advertised; `session/new` PASS; one prompt turn streamed **tool calls** against the LLM collective with `session/set_config_option model=collective/flint` PASS.
- Not observed: permission round-trips (the adapter never sent a `session/request_permission` in the default mode), cancel reliability, native restore via `session/load`, required-sandbox (nono) evaluation, APM target.
- Observed 2026-10-24 (M4 lab, SANDBOX.md § "pi launcher in nono (2026-10-24)"): **launcher `pi` runs no `agent.acp` node or conversation turn under any recorded permission mode on the current product.** Both worker paths (`internal/worker/agentturn.go`, `turnloop.go`) require a verified prompting mode for `ask`/`deny`/`preapproved_within_sandbox`, and none exists to verify (the adapter's only permission round-trip is the extension-UI handler). The `required`-sandbox cells remain `not_tested` — the attempt is refused before nono verification, so no filesystem or egress axis was measured for pi.
- Product bug found and fixed in-tree the same day (unit-proven; live re-check needs a worker-image rebuild, deferred): pi declared its key var `OPENAI_API_KEY` both as `ApiKeyEnv` (a VALUE) and in `AuthEnvVars` (a credential DIRECTORY); the conversation turn then `os.Stat`ed the sourced key value and journalled it inside `conversation.turn.failed` — violating ADR-0040/ADR-0059's never-journal-the-value rule. `acp.AuthEnvFor` now excludes value-carrying vars (`TestAuthEnvForNeverEmitsCredentialValueVars`); the sandboxed child still receives the key via nono's inherited process environment (ADR-0040's measured channel), never via the argv `env` hop.
- Not implemented (ADR-0059 gap, SANDBOX.md row P5): the per-turn provider config the launcher entry documents (agent-home `models.json` from `COMMUNICATION_PI_BASE_URL` + `COMMUNICATION_PI_MODEL`) has zero worker call sites (`ApiModelsJSON` unreferenced), and no base URL reaches the child — a launched pi would fall back to `api.openai.com`, which the egress allowlist denies. The gateway model is unreachable for pi until this delivery (and its channel choice) is built.
- Auth: pi speaks to an OpenAI-compatible provider (`collective`, base `https://llm-collective.e-gineering.com/v1`); the API key rides the adapter→pi env (`LLMC_API_KEY` on this host). The worker-side delivery design (per-turn agent-home `models.json` + `COMMUNICATION_PI_API_KEY_FILE` → `OPENAI_API_KEY`) is recorded in the launcher entry.

## Worker container (M2, observed 2026-10-14)

Image `communication-worker:dev` (worker/Dockerfile: golang:1.27.3-trixie build, node:22-bookworm-slim runtime, pinned `@agentclientprotocol/claude-agent-acp@0.90.0`, `@agentclientprotocol/codex-acp@2.2.2`, `@earendil-works/pi-coding-agent@1.4.0`, `pi-acp@0.0.34`, `@anthropic-ai/claude-code@2.1.300`, `@openai/codex@0.162.1`). Run under compose project `m2wrk` with the credential override `compose.harness.yml` (host uid; the image itself carries no credentials).

- `communication doctor --acp claude --acp-timeout 120s` **inside the worker container** against the real account:
  `acp:claude ok @agentclientprotocol/claude-agent-acp@0.90.0 protocol=1 loadSession=true session=81fe7d87 events=message_chunk:2,tool_call:1,tool_call_update:4,unknown:10 elapsed=8.3s` → **PASS** (the first claude row ever observed from a container, not just the host).
- Full worker turn loop against real Claude Code in the container, journal-verified in `domain_events`:
  - plain answer turn: `turn.started → message.user → message.agent(×2, final=true) → turn.completed`, `stop_reason=end_turn` → **PASS**;
  - session reuse across turns in one process (magic-word recall, one live binding, no second `agent.session.connected`) → **PASS**;
  - permission bridge in `ask` mode (worker selected Claude mode `default`): `tool.call → tool.update → permission.requested` (durable row `pending`) → decision written as plain SQL → tool `completed` → `turn.completed` → **PASS**;
  - cancel mid-stream: 16 coalesced chunks then `turn.cancelled`, `stop_reason=cancelled` → **PASS**;
  - SIGTERM mid-stream: 19 chunks flushed, `turn.interrupted` + `agent.session.disconnected` + worker `offline` — never a false `completed` → **PASS**;
  - hard kill (`docker kill`, no drain) then restart: live `connected` binding with `loadSession=true` was resumed via `session/load` (`session_origin=resumed`) and the agent recalled a phrase taught in the killed process → **PASS**.
- Observed failure honesty: when credentials were unreachable (worker recreated without `HOST_UID`, so uid 10001 could not read the 0600 host config), the turn closed `turn.failed` with the adapter's own JSON-RPC error text (`Authentication required`) in the event payload and the session was disconnected — the loop did not pretend, and the same conversation succeeded once the uid was fixed.
- Codex in-container was **not** exercised in this run (single worker, Claude account mounted); the image installs and smokes the codex adapter binaries, but its E2E row stays UNVERIFIED for containers until run.

## Claude long-lived headless authentication (ADR-0040, note appended 2026-10-20)

- The copied-interactive-login path is **measured failing** for server launches: the worker's `CLAUDE_CONFIG_DIR` seeded from a copy of the owner's `~/.claude/.credentials.json` produced `{"code":-32000,"message":"Authentication required"}` on the home cluster — the access token expires in hours and the refresh token is rotated by the owner's local sessions, so a copied login cannot stay valid on a server.
- Claude Code's long-lived headless credential is `claude setup-token` (value prefix `sk-ant-oat`), which Claude Code reads from the environment variable `CLAUDE_CODE_OAUTH_TOKEN`. The worker now takes the token from a FILE (`COMMUNICATION_CLAUDE_OAUTH_TOKEN_FILE`, e.g. a mounted Secret key), reads it at each launch, and hands it to the claude launcher through the sandbox launcher's process environment (nono 0.80.0 inherits its own process environment into the sandboxed child — measured, see ADR-0040 Verification) — never argv (nono's audit journal records argv verbatim), never a log or event field. `CLAUDE_CONFIG_DIR` is unchanged: a writable config directory is still required for agent state. The alternatives rejected (copied interactive login, `ANTHROPIC_API_KEY`, env-in-argv) and the ADR-0019 D4 caveat (still a shared owner credential, not isolation) are recorded in ADR-0040.

