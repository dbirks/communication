# Acceptance suite on GitHub Actions

## What runs where

`.github/workflows/acceptance.yml` codifies the heavy phases the orchestrator
used to run serially on one laptop (`accept_run.sh`). The `ci` and `e2e`
phases of that script are already `ci.yml` jobs and are **not** duplicated
here. What remains is four parallel jobs, each on its own `ubuntu-latest`
runner with a fresh `communication-m4` stack brought up from this checkout —
`scripts/lab-up.sh`, the repo-tracked sibling of the host's `lab_reset.sh`.

| Job | Proof | Source phase (`accept_run.sh`) |
| --- | --- | --- |
| `lab-e2e` | Every lab-gated Playwright suite (M5, shell, issue2, home, harness, shell-journey) against a fresh seeded lab; the list-reporter summary must contain no `failed`/`skipped`/`flaky`/`did not run` line, and a run that never reaches a summary fails too. | `lab` |
| `m4 (<shard>)` | The live M4 exit gates (docs/m4-contract.md § 7.1/§ 7.2) against `--up --ready --seed`, sharded (below). | `m4` |
| `verification` | The "play the user" emulator loop, up to 6 passes with a full lab rebuild before each; passes only on **two consecutive clean passes**. New defect fingerprints file as GitHub issues (label `emulator`) with the job's `GITHUB_TOKEN`. | `emu` |
| `github-loop` | The real issue → draft-PR loop on the throwaway repo `dbirks/comms-test-repo-1`: two labeled issues must return as draft PRs from `comm/issue-*` refs. | (addition) |

Triggers: `workflow_dispatch`, every push to `main`, and nightly at 04:00
UTC. `concurrency.cancel-in-progress` is **false** on every trigger: a run
that started is never cancelled by a later push (the first real run lost
hours of lab work when a push to main cancelled it mid-shard); GitHub keeps
only the newest *queued* run per group, so superseded pushes collapse in the
queue instead of killing a half-finished run.

## Running a subset (`jobs` input)

`workflow_dispatch` takes a `jobs` input — a comma list of job/shard names
that limits the run to what you name (surrounding spaces are trimmed; an
unknown name fails the `select jobs` gate step rather than silently skipping
everything). A tiny `select` job parses the input into per-job booleans and
the m4 matrix JSON (`jobs.<job_id>.if` cannot read the `matrix` context, so
per-shard filtering is computed there, not inline); the heavy jobs
`need: select` and gate on its outputs. Names: `lab-e2e`, `m4` (all shards),
`m4:fence`, `m4:restore`, `m4:watch`, `m4:fanout`, `m4:core-a`,
`m4:core-b`, `verification`, `github-loop`.

```bash
gh workflow run acceptance.yml -f jobs=m4:watch               # one shard
gh workflow run acceptance.yml -f jobs=m4:watch,github-loop   # mixed
gh workflow run acceptance.yml -f jobs=all                    # everything (default)
```

## Browser legs: two pinned chromium revisions, one preflight

The W gates drive `pnpm dlx @playwright/cli@0.1.22`, which bundles its **own**
playwright-core (`1.64.0-alpha-1790635538000`) and therefore pins **chromium
v1247** — a different build than the **v1248** that the e2e package's
`@playwright/test` 1.64.1 installs. `pnpm --dir e2e exec playwright install`
alone leaves a fresh runner without v1247, and `playwright-cli open` then
dies daemon-side before the session exists:

```
Error: Daemon pid=…: Daemon process exited with code 1
Error: Browser "chrome-for-testing" is not installed; expected executable at
~/.cache/ms-playwright/chromium-1247/chrome-linux64/chrome. Run
`playwright-cli install-browser chrome-for-testing` to install
```

That is Actions run 41408536765's W-leg failure (`reject(Object.assign(new
Error(\`Daemon pid=…` with every arm truncated at 300 chars before the
cause), reproduced locally by pointing `PLAYWRIGHT_BROWSERS_PATH` at a
v1248-only cache; the laptop works because its shared
`~/.cache/ms-playwright` happens to hold both revisions. So the `m4` and
`verification` jobs install **both** — `pnpm --dir e2e exec playwright
install --with-deps chromium` for v1248 and `pnpm dlx
@playwright/cli@0.1.22 install-browser chromium` for v1247 (the system
deps are identical) — and each runs a **preflight** step, `pnpm dlx
@playwright/cli@0.1.22 -s=preflight open --browser=chromium about:blank`
then `close`, printing full stdout+stderr and failing the job on its own so
a runner-browser problem never hides inside a W-gate verdict line. The
preflight speaks only to its own named session and closes only that one.
The driver's open-failure verdict now carries up to 4000 chars of the
open's stdout+stderr (the W arms of run 41408536765 proved 300 truncates
below the fault).

## M4 shard map

Coverage is the table `python3 e2e/m4/e2e_m4_exit.py --list` prints (C1–C14,
W1–W11); **every gate id appears in exactly one shard**, and each shard
re-checks at run time that its ids are in `--list`.

| Shard | Gates | Why this grouping |
| --- | --- | --- |
| `fence` | C3, C4, C5, W2 | The long lease/fault group. C3d's witness arm is regraded at process exit from C4's in-process verdict lines, so C3 must share a runner with C4; W2's transcript arm spends its pane read on the run C4e fenced a real turn inside (otherwise it falls back to a ledger search of this shard's own database). |
| `restore` | C6 | Checkpoint restore incl. the throwaway-worker arms — long, owns a runner. |
| `watch` | W5, W6, W11 | W5 re-enacts C5's kill in the browser and W6 produces its own `workspace_lost` case; W11's attempt-pair arm reads exactly the interrupted-then-succeeded pair W5's kill leaves in this shard's ledger. |
| `fanout` | C8 | 25 children, one failing — owns a runner. |
| `core-a` | C1, C2, C7, C9, C10, W1, W3, W7 | Everything else, half one. |
| `core-b` | C11, C12, C13, C14, W4, W8, W9, W10 | C11c's structural rows are regraded at exit from C12/C13/C14's verdict lines, so they share a runner. |

## Running it

```bash
gh workflow run acceptance.yml            # main, everything
gh workflow run acceptance.yml --ref <branch>
gh workflow run acceptance.yml -f jobs=m4:watch   # one shard (see “Running a subset”)
```

Required repository secrets (settings → secrets → actions):

- `COMMUNICATION_LLM_API_KEY` — the gateway key for
  `llm-collective.e-gineering.com`. The workflow writes it to a mode-600 file
  under `$RUNNER_TEMP` and exports only
  `COMMUNICATION_LLM_API_KEY_HOST_FILE` (the form `compose.real.yml` and
  `e2e/tests/helpers.ts` already speak); `LLMC_API_KEY` itself is read from
  that file by `scripts/lab-up.sh`. The value is never echoed and never an
  argv word.
- `COMMUNICATION_TEST_REPO_TOKEN` — fine-grained token for the throwaway
  repo, delivered the same way as
  `COMMUNICATION_TEST_REPO_TOKEN_FILE` (`gh-loop.sh` reads only the file).

Lab launcher selection: the workflow sets `COMMUNICATION_LAB_LAUNCHER=pi`
(`seed.sh` / `seed-github-loop.sh` read it; unset = `claude`, the local
default). The pi launcher's per-turn config comes from `compose.real.yml`
into the worker containers — `COMMUNICATION_PI_BASE_URL`,
`COMMUNICATION_PI_MODEL` (default
`david-birks/qwen3-8-flash-next`, the exact id form pi's `models.json`
carries on the operator host) and `COMMUNICATION_PI_API_KEY_FILE`, which
inside the container is `/run/comm/llm-api-key`: **the same
`COMMUNICATION_LLM_API_KEY` secret file**, bind-mounted read-only — no
second secret, no Claude token.

## Evidence artifacts (7-day retention)

| Artifact | Contents |
| --- | --- |
| `lab-e2e-<attempt>` | `lab-list.txt` (the Playwright list report the gate greps) + `lab-compose.log` (stack logs with timestamps). |
| `m4-<shard>-<attempt>` | `m4.out` (the full exit-driver transcript for that shard) + `m4-compose.log`. |
| `emulator-out-<attempt>` | `e2e/emulator/out/` — every pass's screenshots, `results.json` and `index.html` report. The passes' session storage states (`admin.json`, `alice.json`) are **excluded**: they are live cookies. |
| `github-loop-<attempt>` | `gh-loop.out` (the PASS/FAIL verdict lines per issue, failing-node errors, journal tails) + compose logs. |

## Honest gaps carried by the runners

These jobs prove what a GitHub runner can prove; where the laptop acceptance
run leaned on the operator's host, the CI stack says so instead of faking it
(12-test-strategy: a mocked green is never evidence):

- **Agent turns (the launcher is pi on CI, and pi cannot run one yet).**
  Runners have no `~/.claude` login and the operator decision is **no Claude
  token on CI**, so the acceptance jobs seed the lab's agent profiles with
  `COMMUNICATION_LAB_LAUNCHER=pi` against the LLM collective. Honesty first:
  **launcher `pi` runs no `agent.acp` node or conversation turn under ANY
  recorded permission mode on the current product** — `ask`, `deny` and
  `preapproved_within_sandbox` all require the launcher's *verified prompting
  mode* (ADR-0019 D6; `internal/agent/acp/launchers.go` registers
  `AskModeID: ""` for pi; observed 2026-10-24 in `docs/compatibility/ACP.md`
  "Pi" and `docs/compatibility/SANDBOX.md` § "pi launcher in nono": the
  worker refuses with `no verified prompting mode … before sandbox
  verification`). There is therefore **no permission mode to pick that makes
  a pi profile run**; the seeds keep `preapproved_within_sandbox` (the mode
  the claude lab seeds use — for pi it changes nothing except the refusal's
  wording). Affected legs, which must land as FAIL/GAP verdicts naming
  launcher `pi`, never a pass:
  - m4 § 7.1: the agent-variant legs that spend a real turn — **C2**'s
    agent-leg secret-materialization witness, **C4e** (the fenced real
    turn's transcript arm), **C11a**'s live-agent-turn arm; and in § 7.2,
    **W2**'s transcript arm (it reads C4e's fenced turn) and the turn-
    dependent arms of **W5/W11** in the watch shard. These fall into the
    driver's existing "turn never ran" GAP paths (e.g. its C4e note for
    attempts carrying no transcript arm).
  - **github-loop**: both issues' `implement` nodes are `agent.acp` on the
    seeded profiles, so the run cannot complete and the job FAILS with the
    attempt detail naming launcher pi. That is the honest state of the
    decision, not a regression to hide.
  - **lab-e2e**: `home-cluster` step 5, `m5-agents-schedules` and
    `issue2-conversations` create/assert profiles on the **claude** launcher
    through the UI itself (hardcoded in those specs, outside this workflow's
    launcher knob) — those legs still answer with the adapter's own
    "Authentication required" on a runner with an empty `${HOME}/.claude`.
  Making pi runnable is a product decision (a verified prompting mode for
  `pi-acp`, or an ADR relaxing ADR-0019 D6 for never-asks launchers) — not
  something CI may fake. Porting the Claude legs instead would need an
  operator-provided non-interactive credential (a `claude setup-token` file,
  ACP.md — the worker already takes `COMMUNICATION_CLAUDE_OAUTH_TOKEN_FILE`)
  as a third secret; explicitly NOT taken this round.
- **`compose.real.yml` is part of the lab-up stack** (assistant + model.chat
  + the pi launcher reach the gateway with the secret above), exactly like
  the host's `lab_reset.sh`. The m4 exit driver still brings its own 3-file
  stack up with `--up`, exactly like `accept_run.sh` did.
- **Sandbox enforcement** is whatever the runner kernel offers (the
  ubuntu-24.04 line is Landlock ABI v6); `docs/compatibility/SANDBOX.md`
  rows claimed on other kernels are not re-observed here.
- The host-only quirks `accept_run.sh` worked around (port 2808x clash with
  the laptop's gateway, `sudo docker` because the operator is not in the
  `docker` group, `sudo docker exec` in `gh-loop.sh`) do not apply to
  GitHub-hosted runners: the ports are free and `docker` needs no sudo.
  `scripts/lab-up.sh` accepts a `DOCKER` prefix override for local hosts
  where they do.
