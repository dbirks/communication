# ACP compatibility probe (M0 spike)

Stdlib-only Python 3 probe that speaks the Agent Client Protocol directly
(JSON-RPC 2.0, newline-delimited JSON over stdio) to produce raw-protocol
compatibility evidence for `docs/compatibility/ACP.md`. It is the baseline the
Go SDK adapter must reproduce; no Go SDK or npm client library is used.

## What it does

Launches an ACP adapter subprocess (no shell), then runs the steps from
`communication-spec/04-agent-runtime.md` / `communication-spec/12-test-strategy.md`:
initialize → session/new → (optional `session/set_mode` /
`session/set_config_option`) → prompt with streaming + permission → second turn →
cancel during a long tool call → process restart + native `session/load`
restore → malformed-input survival. Each step is recorded as `PASS`, `FAIL` or
`GAP` with literal protocol/filesystem evidence. Full message transcripts,
stderr logs and disposable git repos live under
`$HOME/.cache/communication-lab/<run directory>/` — never in the repository.
Results written into the repo are redacted (keys matching
`token|secret|key|authorization|cookie`, email addresses, strings > 500 chars).

## Install adapters (pinned versions, no npx floating)

```bash
BASE="$HOME/.local/share/communication-lab/acp"
npm install --prefix "$BASE/claude-agent-acp-0.90.0" \
  @agentclientprotocol/claude-agent-acp@0.90.0
npm install --prefix "$BASE/codex-acp-2.2.2" \
  @agentclientprotocol/codex-acp@2.2.2
# executables then live in $BASE/<pkgver>/node_modules/.bin/
```

Verify published integrity before use:

```bash
npm view @agentclientprotocol/claude-agent-acp@0.90.0 dist.integrity
npm view @agentclientprotocol/codex-acp@2.2.2 dist.integrity
```

Auth prerequisite: the machine must already be logged in to the underlying
harness (`claude` / `codex` CLI). The probe never attempts interactive login;
if `session/new` reports an auth error the run records FAIL and stops.

## Rerun

Each run makes a few small agent calls against the real harness login.

```bash
python3 -I docs/compatibility/probes/acp/acp_probe.py \
  --agent-cmd "$HOME/.local/share/communication-lab/acp/claude-agent-acp-0.90.0/node_modules/.bin/claude-agent-acp" \
  --label claude \
  --out docs/compatibility/probes/acp/results-claude.json \
  --workdir-root "$HOME/.cache/communication-lab/m0-acp-probe"

python3 -I docs/compatibility/probes/acp/acp_probe.py \
  --agent-cmd "$HOME/.local/share/communication-lab/acp/codex-acp-2.2.2/node_modules/.bin/codex-acp" \
  --label codex \
  --out docs/compatibility/probes/acp/results-codex.json \
  --workdir-root "$HOME/.cache/communication-lab/m0-acp-probe"
```

The probe prints one `[RESULT] step` line per step and writes the results JSON
(already redacted). Inspect a results file with:

```bash
python3 -I -c "import json;d=json.load(open('docs/compatibility/probes/acp/results-claude.json'));print([(s['step'],s['result']) for s in d['steps']])"
```

## Selecting steps, modes and repeats (probe 0.0.3+)

| Flag | Protocol call / effect |
|---|---|
| `--steps <groups>` | Run only these groups (comma list of `streaming`, `second-turn`, `permission`, `cancel`, `restore`, `malformed`). `initialize` + `session/new` always run first. Default: `streaming,second-turn,cancel,restore,malformed`. |
| `--mode-id <id>` | `session/set_mode` with `{"sessionId","modeId"}` after `session/new` (ACP v1 *Session Modes*, <https://agentclientprotocol.com/protocol/v1/session-modes>). Ids come from `session/new` → `modes.availableModes`. |
| `--set-config <id>=<value>` | `session/set_config_option` with `{"sessionId","configId","value"}` (repeatable), per <https://agentclientprotocol.com/protocol/v1/session-config-options>. Both adapters answer it and echo the full `configOptions`; the step is PASS only when the returned `currentValue` equals the requested value. |
| `permission` group | Two permission-gated turns: `allowed.txt` answered with an `allow_once` option (PASS = a request arrived AND the file exists) and `rejected.txt` answered with a `reject_once` option (PASS = a request arrived AND the file does NOT exist). Offered option kinds, tool titles and the client's exact reply are recorded per request. If the agent never asks, or offers no `allow*`/`reject*` option, the step is `GAP`, never `PASS`. |
| `--cancel-repeats N` | Runs the cancel step N times, each in a fresh session (`session/set_mode` is per-session, so cancel iterations sit at the adapter default mode and stay comparable with the baseline runs). The summary step is `PASS` only if all N returned `stopReason=cancelled`; `GAP` if no iteration still had an open turn when `session/cancel` was sent. |
| `--cancel-after <s>` | Delay before `session/cancel`. Keep it short (2 s used): Claude Code sometimes auto-backgrounds `sleep 60` (`run_in_background: true`, turn ends `end_turn` in <5 s), leaving nothing to cancel. The probe records `cancel_sent_while_turn_open` per iteration so that shows up instead of silently reading as a broken cancel. |

The permission/cancel follow-up (probe 0.0.3) used:

```bash
python3 -I docs/compatibility/probes/acp/acp_probe.py \
  --agent-cmd "$HOME/.local/share/communication-lab/acp/claude-agent-acp-0.90.0/node_modules/.bin/claude-agent-acp" \
  --label claude --steps permission,cancel --cancel-repeats 5 --cancel-after 2.0 \
  --mode-id default --set-config mode=default \
  --out docs/compatibility/probes/acp/results-claude-permission.json \
  --workdir-root "$HOME/.cache/communication-lab/m0-acp-permission/final"

python3 -I docs/compatibility/probes/acp/acp_probe.py \
  --agent-cmd "$HOME/.local/share/communication-lab/acp/codex-acp-2.2.2/node_modules/.bin/codex-acp" \
  --label codex --steps permission,cancel --cancel-repeats 5 --cancel-after 2.0 \
  --mode-id read-only --set-config mode=read-only \
  --out docs/compatibility/probes/acp/results-codex-permission.json \
  --workdir-root "$HOME/.cache/communication-lab/m0-acp-permission/final"
```

`results-claude.json` / `results-codex.json` remain the untouched probe 0.0.1
baseline (its `permission` step is emitted as `permission (default flow)` by
0.0.3); the `*-permission.json` files carry `permission allow`,
`permission reject` and `cancel i/N` steps.
