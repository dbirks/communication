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
| `m4 (regrade)` | The § 7.1 rows whose witnesses ran in another shard, re-graded over the six shards' uploaded witness files — no stack, no new measurements (below). | `m4` (regrade half) |
| `verification` | The "play the user" emulator loop, up to 6 passes with a full lab rebuild before each; passes only on **two consecutive clean passes**. New defect fingerprints file as GitHub issues (label `emulator`) with the job's `GITHUB_TOKEN`; the same token is also written to a mode-600 `$RUNNER_TEMP` file and exported only as `E2E_GITHUB_READ_TOKEN_FILE`, so the emulator's `server` repo reads GitHub authenticated through its ADR-0061 credential instead of the anonymous 60/hour budget. | `emu` |
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

### Cross-shard regrade (`m4 (regrade)`)

Several § 7.1 rows are graded from ANOTHER gate's measurement — C11c's structural
arms over C8b/C14a/C10a/C10b/C7c/C1f/C2c/C13c/C2d/C12a/C12b/C13b, C5g's and C6c's
"the same node_instance_key set as C1", C3d's citation of C4's fence — and the
driver's exit-time regrade only sees verdicts printed in ITS OWN process, so in a
six-shard matrix those witnesses live in a different job. That is why acceptance
run 41983100425 filed `C11c outputs are project-scoped data … C8B=NOT PRINTED` and
`C5g … no C1 key set in this pass (CTX['c1'] empty)` as GAPs that still let the
shard jobs pass. Now every shard runs with `--shard <name> --witness
m4-witness.json`, uploading a machine-readable witness file (each verdict line's
leg id and status, plus the CTX half-shapes later gates compare against — C1's
twin `node_instance_key` set, the retried run's own key set), and the
`m4 (regrade)` job downloads all six and runs `python3 e2e/m4/e2e_m4_exit.py
--regrade <files…> --expect-shards <names>` with **no stack at all**, so every
cross-gate row is re-graded purely over the recorded measurements and the job
FAILs on any FAIL, any row whose witness no shard ever measured (naming the leg
and the shard that owed it), and any shard whose witness never arrived. While the
regrade is contracted (select's `m4-all`, i.e. all six shards ran) a shard prints
such a row as `PENDING <row id> (regraded by m4 (regrade))` instead of a GAP —
visible in the summary, counted in its own `PENDING=` tally, and owned by the
regrade job; on a partial shard selection there is nothing to merge, so the rows
keep the honest GAP and the regrade job prints a notice saying it was skipped.
Key-set rows compared across shards compare **structure** — the
`node_instance_key` SETs the same § 7.0 seed pipeline produces on two fresh
stacks, iteration-normalized with `collapse_iterations()` and guarded by
`loop_history_holes()` — which is exactly what those contract rows claim, and the
row text says so. The algebra is proven offline in
`e2e/m4/test_regrade_logic.py` (witness round-trip, PENDING-not-GAP, merged
regrade PASS/FAIL over recorded shard witnesses).

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
  that file by `scripts/lab-up.sh`, and — for the m4 job — by the job itself
  and by `e2e/m4/e2e_m4_exit.py` (worker.go's `COMMUNICATION_MODEL_CHAT_API_KEY`
  has no `_FILE` form, so the value must exist in the environment compose
  renders with). The value is never echoed and never an argv word.
- `COMMUNICATION_TEST_REPO_TOKEN` — fine-grained token for the throwaway
  repo, delivered the same way as
  `COMMUNICATION_TEST_REPO_TOKEN_FILE` (`gh-loop.sh` reads only the file).

Lab launcher selection: the workflow sets `COMMUNICATION_LAB_LAUNCHER=pi`
(`seed.sh` / `seed-github-loop.sh` read it; unset = `claude`, the local
default), which seeds the agent profiles `autonomous_within_sandbox` — the
mode ADR-0069 added for a launcher that cannot prompt, since pi runs no turn
under a mode that claims a review (`preapproved_within_sandbox` is ADR-0036's
claude-only exception). The pi launcher's per-turn config reaches the worker
containers from `compose.real.yml` on the lab stack and from
**`compose.m4-llm.yml`** on the m4 exit stack — `COMMUNICATION_PI_BASE_URL`,
`COMMUNICATION_PI_MODEL` (default `david-birks/qwen3-8-flash-next`, the exact
id form pi's `models.json` carries on the operator host; the gateway retired
the `qwen3-8-27b`/`ripple-65b` pair) and `COMMUNICATION_PI_API_KEY_FILE`,
which inside the container is `/run/comm/llm-api-key`: **the same
`COMMUNICATION_LLM_API_KEY` secret file**, bind-mounted read-only — no
second secret, no Claude token. Setting the base URL is also what admits the
gateway host to the agent-turn egress allowlist (ADR-0069), so neither layer
sets `COMMUNICATION_AGENT_EGRESS_ALLOW` and the § 7.1 C11 probe keeps
measuring the shipped policy rather than a widened one.

## Evidence artifacts (7-day retention)

| Artifact | Contents |
| --- | --- |
| `lab-e2e-<attempt>` | `lab-list.txt` (the Playwright list report the gate greps) + `lab-compose.log` (stack logs with timestamps). |
| `m4-<shard>-<attempt>` | `m4.out` (the full exit-driver transcript for that shard) + `m4-compose.log` + `m4-witness.json` (this shard's verdict lines and CTX half-shapes, read by `m4 (regrade)`). |
| `regrade-m4-<attempt>` | `m4-regrade.out` — the cross-gate rows re-graded over every shard's merged witness file. |
| `emulator-out-<attempt>` | `e2e/emulator/out/` — every pass's screenshots, `results.json` and `index.html` report. The passes' session storage states (`admin.json`, `alice.json`) are **excluded**: they are live cookies. |
| `github-loop-<attempt>` | `gh-loop.out` (the PASS/FAIL verdict lines per issue, failing-node errors, journal tails) + compose logs. |

## Honest gaps carried by the runners

These jobs prove what a GitHub runner can prove; where the laptop acceptance
run leaned on the operator's host, the CI stack says so instead of faking it
(12-test-strategy: a mocked green is never evidence):

- **Agent turns: CI carries the pi credential; the refusal GAP is local-only.**
  Runners have no `~/.claude` login and the operator decision is **no Claude
  token on CI**, so the acceptance jobs seed the lab's agent profiles with
  `COMMUNICATION_LAB_LAUNCHER=pi` against the LLM collective. Since ADR-0069
  that launcher **does** run turns (`autonomous_within_sandbox`, no review
  claim), and since the m4 job mounts the gateway key the legs that spend a
  real turn **measure** on CI rather than reporting an environment gap:
  `e2e/m4/e2e_m4_exit.py` composes `compose.m4-llm.yml` on top of its three
  files whenever `COMMUNICATION_LLM_API_KEY_HOST_FILE` names a readable file
  (it prints one line naming the composed layers — never the key), which
  gives `worker-a`/`worker-b` `COMMUNICATION_PI_API_KEY_FILE` +
  `COMMUNICATION_PI_BASE_URL`/`_MODEL` and the `model.chat` endpoint, and the
  two serve replicas their assistant triple. The legs this turned from GAP to
  measurement: § 7.1 **C1c**/C1's cross-variant key set, **C2a**, **C4e**,
  **C9g**, **C7d**'s transcript half (the agent variant's journaled
  `conversation_turns.prompt`), **C10c** (a real `model.chat` reviewer arm),
  **C11**'s agent arm, and § 7.2 **W2**/**W3**.
  What the credential does NOT change, stated plainly:
  - **The local path.** A laptop with no readable key file keeps the 3-file
    stack, and launcher pi then dies at `session/new` -32000 `Authentication
    required`. The driver still GAPs there — naming `compose.m4-llm.yml`, the
    variable that would have composed it, and the fact that on the runners the
    same refusal is a **FAIL**, not a GAP. Composing the layer is the only
    branch where that refusal may not be gap-worded.
  - **A real model is not deterministic.** § 7.1 C1g expects it: the twin's
    two-iteration loop is the loop's ledger witness, and an agent loop that
    finishes in one iteration leaves that run's iteration-2 rows genuinely
    unmeasurable (the twin arm above still measures).
  - **Windows are the model's, not the harness's.** The lab model is a
    reasoning model (~10-60 s per turn, and it thinks before it streams), so
    the legs that wait for a first streamed transcript row (`C4E_FIRST_CHUNK_S`),
    for a gate to park (`W3_GATE_WAIT_S`), for two sequential `model.chat`
    nodes (`C10C_ARM_WAIT_S`) or for C11's single `/plan` turn
    (`C11_AGENT_RUN_CAP_S`) are sized for that. A truncated `model.chat`
    completion is also why C10c names a 1200-token budget with
    `reasoningEffort: low` rather than the old 200.
  - **github-loop / emulator**: both already write the same key file, and their
    agent legs run on the lab stack's own `compose.real.yml`, so their launcher
    story is theirs to report (see their job sections below) — this bullet is
    about the **m4 exit stack**, which now carries its own model layer.
  - **lab-e2e**: `home-cluster` step 5, `m5-agents-schedules` and
    `issue2-conversations` create/assert profiles on the **claude** launcher
    through the UI itself (hardcoded in those specs, outside this workflow's
    launcher knob) — those legs still answer with the adapter's own
    "Authentication required" on a runner with an empty `${HOME}/.claude`.
  Making pi run under a *prompting* mode remains a product decision (a
  verified prompting mode for `pi-acp`, or an ADR relaxing ADR-0019 D6) — not
  something CI may fake. Porting the Claude legs instead would need an
  operator-provided non-interactive credential (a `claude setup-token` file,
  ACP.md — the worker already takes `COMMUNICATION_CLAUDE_OAUTH_TOKEN_FILE`)
  as a third secret; explicitly NOT taken this round.
- **`compose.real.yml` is part of the lab-up stack** (assistant + model.chat
  + the pi launcher reach the gateway with the secret above), exactly like
  the host's `lab_reset.sh`. The m4 exit driver brings its own stack up with
  `--up` on three files plus `compose.m4-llm.yml` **only when a readable key
  file is named** — so `m4.out`'s first lines and the worker container's own
  compose `config_files` label (which C10c reads) always agree on which stack
  actually ran.
- **Sandbox enforcement** is whatever the runner kernel offers (the
  ubuntu-24.04 line is Landlock ABI v6); `docs/compatibility/SANDBOX.md`
  rows claimed on other kernels are not re-observed here.
- The host-only quirks `accept_run.sh` worked around (port 2808x clash with
  the laptop's gateway, `sudo docker` because the operator is not in the
  `docker` group, `sudo docker exec` in `gh-loop.sh`) do not apply to
  GitHub-hosted runners: the ports are free and `docker` needs no sudo.
  `scripts/lab-up.sh` accepts a `DOCKER` prefix override for local hosts
  where they do.
