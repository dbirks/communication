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

Triggers: `workflow_dispatch`, every push to `main` (superseded runs
cancelled), and nightly at 04:00 UTC.

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
gh workflow run acceptance.yml            # main
gh workflow run acceptance.yml --ref <branch>
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

- **Agent logins.** `compose.harness.yml` rw-binds `${HOME}/.claude` and
  `${HOME}/.codex`; a fresh runner has neither, so legs that spend a real
  Claude/Codex turn (C4e, W2's transcript arm, the gh-loop PRs) answer with
  the adapters' own "Authentication required" failures / GAPs. Porting them
  needs an operator-provided non-interactive credential (a `claude
  setup-token` file, ACP.md — the worker already takes
  `COMMUNICATION_CLAUDE_OAUTH_TOKEN_FILE`) as a third secret.
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
