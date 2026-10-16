# M4 exit proof — end-to-end driver

`e2e_m4_exit.py` is the executable form of `docs/m4-contract.md` § 7. Every
gate C1–C14 and W1–W11 has a real implementation (the W legs drive the
browser through `pnpm dlx @playwright/cli`), and each one still prints an
honest `SKIP`/`GAP` when the stack or the § 7.0 seed manifest is missing.
What has actually been *seen* against a live lab is recorded in
`docs/m4-exit-status.md` (evidence root `$HOME/.cache/communication-lab/m4-exit/`,
one `<GATE>.out` per gate per pass); nothing here claims a pass.
A `SKIP`/`GAP` is never a pass: § 7 gates report literal Postgres/API output
before M4 is called done (`12-test-strategy.md`).

## Isolation rules (§ 7.0 — non-negotiable)

* Compose project is **`communication-m4`**, always via
  `-p communication-m4 -f compose.yml -f compose.harness.yml -f compose.m4.yml`.
* Its ports are **18091** (lb/app), **18092/18093** (api-a/api-b), **18094**
  (preview), **18095** (OIDC), **18099** (collector). Nothing in this plan
  ever binds or touches **18080–18090** (the dev stack) or **8080/8081/8090**
  (the host's model gateway). `compose.m4.yml` replaces every inherited
  1808x mapping with `!override`.
* Teardown is `down -v` on that project only. No `docker system/volume/image
  prune`, no pattern `pkill`; the workers are only ever killed by name inside
  this project (`container_signal("KILL", "worker-a")` → `docker kill
  communication-m4-worker-a-1`, with `docker compose … kill worker-a` as the
  fallback), and only after `compose_container` proves the container's
  `com.docker.compose.project` label is `communication-m4` (13dd742).

## How to run a gate

Everything below runs from the repository root.

```bash
python3 e2e/m4/e2e_m4_exit.py --list          # the gate table + each gate's intent

python3 e2e/m4/e2e_m4_exit.py --up --ready --seed --only C4 --down \
  2>&1 | tee "$HOME/.cache/communication-lab/m4-exit/<pass>/C4.out"
```

(The driver injects `HOST_UID`/`HOST_GID` into every compose call itself, so no
`env` prefix is needed. Its stdout *is* the evidence: write each gate's output
to `<pass>/<GATE>.out` under the evidence root — that is the path
`docs/m4-exit-status.md` cites when it quotes a verdict line.)

Flags: `--up` (prepare the `.harness` directories — workspaces, per-worker
agent homes, remotes, m4-fixtures — **regenerate the fixture repo**, then
`compose up -d --build`), `--ready` (wait for both API replicas' readiness),
`--seed` (shell out to the § 7.0 `docs/compatibility/probes/m4/seed.sh`
contract and parse its `seed-manifest.json`; C1 also seeds on demand when the
stack is up but no manifest exists), `--only C1,C5,W2`, `--no-build`,
`--list`, `--down` (`down -v` at the end, even on failure).

To attach to a stack that is already up, drop `--up` and run
`--ready --only C4` — but read the fixture note below first: **only `--up`
regenerates `.harness/m4-fixtures`**, and `--ready` against a stale fixture
makes every fault leg unmeasurable.

Env overrides: `COMM_REPO_DIR` (repo root), `M4X_SCRATCH` (throwaway-worker
scratch + evidence root), `M4_SEED_MANIFEST` (the manifest path — set it when
you seeded by hand; see `docs/compatibility/probes/m4/README.md` for that
wire order).

A gate that *crashes* records a FAIL naming the raising frame
(`gate_crash_location`) and the driver continues to the next gate — a broken
gate is a fact about the gate, never a silent green.

**Offline verdict tests.** Each `e2e/m4/test_*_logic.py` runs standalone
(`python3 e2e/m4/test_hold_logic.py`) with stdlib unittest only — canned
Postgres/API evidence through the reducer, no stack, no agent. CI's
`m4-gate-logic` job globs `e2e/m4/test_c*_logic.py`, so
`test_hold_logic.py`, `test_names_logic.py` and `test_w_logic.py` only run
when you invoke them. They prove the reducer is self-consistent; they are
never § 7 evidence.

## The fixture

`make_fixture_repo.sh [OUT_DIR]` builds the § 7.0 disposable repo — a bare
`app.git` with `hello.py` (undocumented `add`), `tests/test_hello.py`
(asserting `__doc__` **and** `add(1,2) == 99` — the failure is intended, so
iteration 1 must fail and the implementer's job is exactly one edit), and
`pytest.ini` (`testpaths = tests`), and `bin/m4-exit.sh` — the deterministic
step helper the twins call (mounted at `.harness/m4-fixtures/bin:/opt/m4/bin:ro`).
It is generated under
`.harness/m4-fixtures/` and bind-mounted **at the URL's own path**
(`.harness/m4-fixtures:/srv/m4/fixtures:ro`), the exact same-path trick the
M3 harness uses for `.harness/remotes/`: a `file://` URL in the database must
resolve to the same directory inside every worker, or every prepare fails for
a lab reason wearing a protocol fault. Re-running replaces `app.git`
wholesale; it removes only its own paths.

**The `hold_seconds` lesson (522a82b / 1e75c23).** The twins take an opt-in run
input `hold_seconds` (0–600, default 0) that `m4-exit.sh` sleeps *before* any
work, so C4's lease freeze, C5/C6's kill and W5/W6's restart land on an attempt
a worker still holds (45s covers the 30s lease + the 15s reconciler tick; W2
holds 10s so the page can be sampled mid-lease). **Only the fault legs post
it** — C1/C7/C8 keep the default 0 and byte-identical stdout. A fixture left
from before the hold honours nothing: live8/C5, W5 and W6 GAPped "nothing was
ever held by a worker" on a stack that was up but never regenerated, which is a
lab artefact wearing a product gap. So after ANY fixture change, or before any
fault leg on an old `.harness`:

```bash
bash e2e/m4/make_fixture_repo.sh .harness/m4-fixtures
```

…and bring the stack up with `--up` (the only path that regenerates it).
`require_fault_hold()` checks the mounted script up front and GAPs with that
exact command instead of spending 300s polling; if a leg posted the hold and
still saw nothing, `fault_hold_evidence()` + `hold_diagnosis()` dump the three
reads that tell the explanations apart (the run's validated `run_inputs` rows,
the longest worker-held attempt, whether the mounted script mentions
`M4_HOLD_SECONDS`).

## What is in the harness already

* `COMPOSE` project list, `run`/`psql`/`wexec`/`compose_logs` (helpers cloned
  from `e2e/m3/e2e_m3_exit.py` — the house idiom).
* **Container addressing (13dd742).** `WORKER_A`/`WORKER_B` are compose SERVICE
  names; compose creates `<project>-<service>-<n>` (`communication-m4-worker-a-1`),
  so `docker logs communication-m4-worker-a` answers `no such object` and the
  leg silently reads nothing — that is what made live9's C4c/C5b and the W5/W6
  legs read or kill nothing (that commit names exactly those four). Every raw
  `docker` call now resolves through
  `compose_container_identity` / `compose_ps_refs` / `compose_container` /
  `resolve_container` (which proves `com.docker.compose.project=communication-m4`
  first, § 7.0) and uses `container_signal` / `container_logs` / `container_exec`
  — each returns `(rc, out, how)`, where `how` is the literal command for the
  report and `rc=None` means nothing resolved (the caller must GAP, never FAIL on
  a read it did not perform); `resolve_container` is the variant that emits that
  GAP itself. `c4_worker_service` maps a `workers` row's name to its service
  (unknown names return `None`, so a leg kills nothing it did not create),
  `wexec` is now a thin wrapper over `container_exec`, and `c2_compose_svc`
  normalizes a container name back to the service for compose's own exec.
* `Client` + `login()` (mock-OIDC form dance, cookie jar per user, CSRF).
* `stack_up` / `wait_ready` / `stack_down`, `ensure_fixture_repo`.
* `start_throwaway` / `stop_throwaway` — M3's shape adapted: named
  `communication-m4-*` containers, per-run `communication-m4-<name>-repos`
  volume option (C6e's cross-volume arm), the `communication-m4_default`
  network and `communication-m4_masterkeys` volume. The two stack workers are
  never reconfigured by it.
* `wait_worker_row` (name → id/enforcement/capacity from `workers`).
* The hold helpers above: `with_hold`, `hold_cover`, `hold_window`,
  `fixture_hold_state`, `hold_diagnosis`, `fault_hold_evidence`,
  `require_fault_hold` (522a82b, 1e75c23).
* **Gate-owned revisions.** A leg that needs a document the seed does not ship
  publishes its own immutable revision rather than mutating the seed's — C6a's
  `restore_checkpoint` splice, C7's until-exhaustion doc, C12's variants, and
  since b2bfe62 **C8e** publishes one parent per child-failure policy
  (`stop` / `fail_after_all`) and asserts each mode on its own run, while
  **C8f** builds a real 3-level chain to prove no depth-3 run is booked. Pin the
  revision you publish; a shared seed revision proves nothing about the mode.
* Browser helpers for the W legs (`pw`, `pw_login`, `pw_snapshot`, `pw_click`,
  `pw_poll`, `pw_shot`) over `pnpm dlx @playwright/cli` with named sessions;
  screenshots stay in gitignored `.playwright-cli/`.

## Prerequisites

* Go code built by the M4 implementation workers (`communication:dev` and
  `communication-worker:dev` images build from this repo; the driver here is
  language-agnostic to their progress — it verdicts only on what the stack
  answers).
* Real agent logins for the ACP legs (`~/.claude`, `~/.codex` — same
  requirement as the M3 harness; gates C1/C2/C9/C11 spend real turns).
* Host tools: `docker` (compose v2), `git`, CPython 3 (stdlib only), `bash`,
  and `pnpm` for the W legs' `pnpm dlx @playwright/cli`. No new repo
  dependencies. One new **image pull** is flagged in
  `compose.m4.yml` (`python:3.13-alpine`, the C11 collector).

## Related

* `docs/m4-exit-status.md` is the scoreboard — which pass observed what, per § 7
  item; `docs/m4-live-findings.md` records the per-pass findings, including
  DRIVER bugs like the container-name one that 13dd742 fixed.
* Probe evidence lives in `docs/compatibility/probes/m4/` (`run.sh` →
  `results-exit.txt`), and that README holds the § 7.0 seed contract + the
  hand-seed wire order.
* The § 9.3 pipeline documents live in `docs/compatibility/probes/m4/pipeline.yaml`
  (the agent twin, the `process.exec` twin with `hold_seconds`, and the C8
  child docs) and `seed.sh` (§ 7.0) publishes them plus the agent profiles — the
  driver shells out to it under `--seed` rather than duplicating either.
