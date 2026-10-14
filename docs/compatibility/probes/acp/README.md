# ACP compatibility probe (M0 spike)

Stdlib-only Python 3 probe that speaks the Agent Client Protocol directly
(JSON-RPC 2.0, newline-delimited JSON over stdio) to produce raw-protocol
compatibility evidence for `docs/compatibility/ACP.md`. It is the baseline the
Go SDK adapter must reproduce; no Go SDK or npm client library is used.

## What it does

Launches an ACP adapter subprocess (no shell), then runs the steps from
`communication-spec/04-agent-runtime.md` / `communication-spec/12-test-strategy.md`:
initialize → session/new → prompt with streaming + permission → second turn →
cancel during a long tool call → process restart + native `session/load`
restore → malformed-input survival. Each step is recorded as `PASS`, `FAIL` or
`GAP` with literal protocol/filesystem evidence. Full message transcripts,
stderr logs and disposable git repos live under
`$HOME/.cache/communication-lab/m0-acp-probe/` — never in the repository.
Results written into the repo are redacted (keys matching
`token|secret|key|authorization|cookie` and strings > 500 chars).

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
