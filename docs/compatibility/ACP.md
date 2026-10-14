# ACP compatibility matrix

## Provenance

- Date: 2026-10-14
- Host OS/kernel: Linux 7.2.9-arch1-1 (Arch); Python 3.14.7; Node v26.11.1; npm 12.2.0
- Probe: `docs/compatibility/probes/acp/acp_probe.py` (raw JSON-RPC 2.0 over stdio, stdlib only; baseline rows from probe v0.0.1, Permission/Cancel cells from v0.0.3). Rerun: see `docs/compatibility/probes/acp/README.md`.
- Adapters under test (installed under `$HOME/.local/share/communication-lab/acp/`, exact pinned versions):
  - `@agentclientprotocol/claude-agent-acp@0.90.0` — `dist.integrity`: `sha512-XgbpMB0CIVDAxZKESwUPUiuXxdzlh8Ga1gT6pBufwkD38Zclo8/GP5khCTKssvLGad2T/8iASZusWcsDzlqpQQ==`
  - `@agentclientprotocol/codex-acp@2.2.2` — `dist.integrity`: `sha512-vNdeNV3jxbqaH7MYvVWzyB6cMOz+YGIV9W1xyBDsQfoii92DulZLM+ahCL2T2G6uohlaB1Yma347p2kLfAab2w==`
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
| Pi ACP adapter | GAP — no ACP adapter for `pi` on this host | GAP — same reason | GAP — same reason | GAP — same reason | GAP — same reason | GAP — same reason | GAP — same reason |

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
