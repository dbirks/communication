# ACP compatibility matrix

## Provenance

- Date: 2026-10-14
- Host OS/kernel: Linux 7.2.9-arch1-1 (Arch); Python 3.14.7; Node v26.11.1; npm 12.2.0
- Probe: `docs/compatibility/probes/acp/acp_probe.py` (raw JSON-RPC 2.0 over stdio, stdlib only, probe v0.0.1). Rerun: see `docs/compatibility/probes/acp/README.md`.
- Adapters under test (installed under `$HOME/.local/share/communication-lab/acp/`, exact pinned versions):
  - `@agentclientprotocol/claude-agent-acp@0.90.0` — `dist.integrity`: `sha512-XgbpMB0CIVDAxZKESwUPUiuXxdzlh8Ga1gT6pBufwkD38Zclo8/GP5khCTKssvLGad2T/8iASZusWcsDzlqpQQ==`
  - `@agentclientprotocol/codex-acp@2.2.2` — `dist.integrity`: `sha512-vNdeNV3jxbqaH7MYvVWzyB6cMOz+YGIV9W1xyBDsQfoii92DulZLM+ahCL2T2G6uohlaB1Yma347p2kLfAab2w==`
- Harness versions: `claude` 2.1.300 (Claude Code); `codex-cli` 0.162.1
- Auth mode: the harness's own local login of the developer machine — **NOT** organization-managed credentials; see 04 "Credential source".
- Raw evidence (redacted): `docs/compatibility/probes/acp/results-claude.json`, `docs/compatibility/probes/acp/results-codex.json`; transcripts/stderr under `$HOME/.cache/communication-lab/m0-acp-probe/`.
- Result words: `PASS` observed and matched · `FAIL` observed and did not match · `GAP` could not test.

## Matrix

Columns match the protocol compatibility table in `communication-spec/12-test-strategy.md`.

| Candidate | New session | Streaming/tool calls | Permission | Cancel | Native restore | APM target | Nono |
|---|---|---|---|---|---|---|---|
| Claude Code ACP adapter `@agentclientprotocol/claude-agent-acp@0.90.0` (claude 2.1.300) | PASS | PASS | GAP — no `session/request_permission` under adapter default mode; file was created without asking | PASS — `stopReason=cancelled` <1 s after `session/cancel` (flaky, see limits) | PASS — `loadSession` advertised; 10 updates replayed | GAP — tested in separate M0 spikes | GAP — tested in separate M0 spikes |
| Codex ACP adapter `@agentclientprotocol/codex-acp@2.2.2` (codex-cli 0.162.1) | PASS | PASS | GAP — no `session/request_permission` under adapter default mode; file was created without asking | PASS — `stopReason=cancelled` <1 s after `session/cancel` | PASS — `loadSession` advertised; 15 updates replayed | GAP — tested in separate M0 spikes | GAP — tested in separate M0 spikes |
| Gemini ACP | GAP — `gemini` not installed on this host, no Google credentials | GAP — same reason | GAP — same reason | GAP — same reason | GAP — same reason | GAP — same reason | GAP — same reason |
| Pi ACP adapter | GAP — no ACP adapter for `pi` on this host | GAP — same reason | GAP — same reason | GAP — same reason | GAP — same reason | GAP — same reason | GAP — same reason |

Protocol negotiated by both probed adapters: `protocolVersion: 1` (v1 baseline; v2 not exercised).

## Known limits / observations

### Claude Code (`@agentclientprotocol/claude-agent-acp@0.90.0`)

- Negotiated `protocolVersion` 1; `agentInfo` `{name: "@agentclientprotocol/claude-agent-acp", version: "0.90.0"}`.
- Advertised capabilities: `loadSession: true`; `promptCapabilities` image + embeddedContext; `mcpCapabilities` http + sse; `sessionCapabilities` additionalDirectories/close/delete/fork/list/resume; `auth.logout`; `_meta.claudeCode.promptQueueing`. `authMethods` empty — it rides the ambient `claude` CLI login.
- Permission: with the adapter's default permission mode the agent wrote `hello.txt` **without any `session/request_permission` request**, so the permission round-trip could not be exercised (GAP, not PASS). Probing a non-default `permission_mode`/`modes` setting is a follow-up.
- Cancel: the recorded run returned `stopReason=cancelled` immediately after `session/cancel`. An earlier run of the same probe observed `end_turn` (not `cancelled`) at the instant of cancel — treat cancel as **flaky, not yet trustworthy**; more runs needed before anything depends on it.
- Emits extra opaque updates (`available_commands_update`, `usage_update`, `session_info_update`); a client must tolerate unknown `sessionUpdate` kinds.
- `session/new` returns `configOptions` and `modes` alongside `sessionId`.
- Restart restore via `session/load` worked in-place (same cwd); different-workspace restore not tested (lab step 5 variant).

### Codex (`@agentclientprotocol/codex-acp@2.2.2`)

- Negotiated `protocolVersion` 1; `agentInfo` `{name: "@agentclientprotocol/codex-acp"}`.
- Advertised capabilities: `loadSession: true`; `promptCapabilities` image + embeddedContext; `mcpCapabilities` http (acp/sse false); `sessionCapabilities` resume/list/close/delete/fork/additionalDirectories/**subagents**; `auth.logout`. `authMethods` offers `api-key` and `chat-gpt`; neither was used — the existing `codex-cli` login (`~/.codex/auth.json`) was sufficient, and the `api-key` method's `_meta` payload was redacted by the probe.
- Permission: same as Claude — no `session/request_permission` under the adapter default; file created without asking (GAP).
- Cancel: `stopReason=cancelled` returned <1 s after `session/cancel`, `sleep 60` tool call abandoned.
- Streams `agent_thought_chunk` in addition to `agent_message_chunk`; client mapping must decide what is displayable.
- `session/new`/`session/load` results carry `models` + `configOptions` + `modes`.
- Survived malformed stdin (`{not json`) with no stderr noise.

### Both / general

- Neither adapter crashed or leaked on malformed input; both answered the valid `session/new` that followed.
- Permission requests were never exercised in these runs: the `Permission` column evidence for both rows is a **negative observation**, not a verified round-trip. A follow-up run with a tightened permission mode is required before claiming `permission-capable`.
- This probe speaks raw ACP with no SDK. It is the baseline the Go SDK adapter (`github.com/coder/acp-go-sdk`, evaluated in a later M0 task) must reproduce message-for-message; SDK results are only credible when they match `results-*.json` here.
- Single-run results; cancel flakiness above shows the matrix needs repeated nightly runs (per 12-test-strategy CI note) before sign-off.
