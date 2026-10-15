# M4 exit proof — end-to-end driver (skeleton)

`e2e_m4_exit.py` is the executable form of `docs/m4-contract.md` § 7. Today
it implements the **stack lifecycle, fixtures and helpers**; every gate
C1–C14 and W1–W11 is a named stub printing `SKIP (pending)` with its
one-line intent, wired so implementation workers fill them in one at a time.
A `SKIP` here is never a pass — § 7 gates report literal Postgres/API output
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
  this project (`docker compose -p communication-m4 kill worker-a`).

## Bring the stack up

```bash
HOST_UID=$(id -u) HOST_GID=$(id -g) \
  python3 e2e/m4/e2e_m4_exit.py --up --ready --down
```

`--up` prepares the `.harness` directories (workspaces, per-worker agent
homes, remotes, m4-fixtures), regenerates the disposable fixture repo, and
runs `compose up -d --build`. Flags: `--only C1,C5,W2`, `--list`,
`--no-build`, `--down`.

## The fixture

`make_fixture_repo.sh [OUT_DIR]` builds the § 7.0 disposable repo — a bare
`app.git` with `hello.py` (undocumented `add`), `tests/test_hello.py`
(asserting `__doc__` **and** `add(1,2) == 99` — the failure is intended, so
iteration 1 must fail and the implementer's job is exactly one edit), and
`pytest.ini` (`testpaths = tests`). It is generated under
`.harness/m4-fixtures/` and bind-mounted **at the URL's own path**
(`.harness/m4-fixtures:/srv/m4/fixtures:ro`), the exact same-path trick the
M3 harness uses for `.harness/remotes/`: a `file://` URL in the database must
resolve to the same directory inside every worker, or every prepare fails for
a lab reason wearing a protocol fault. Re-running replaces `app.git`
wholesale; it removes only its own paths.

## What is in the harness already

* `COMPOSE` project list, `run`/`psql`/`wexec`/`compose_logs` (helpers cloned
  from `e2e/m3/e2e_m3_exit.py` — the house idiom).
* `Client` + `login()` (mock-OIDC form dance, cookie jar per user, CSRF).
* `stack_up` / `wait_ready` / `stack_down`, `ensure_fixture_repo`.
* `start_throwaway` / `stop_throwaway` — M3's shape adapted: named
  `communication-m4-*` containers, per-run `communication-m4-<name>-repos`
  volume option (C6e's cross-volume arm), the `communication-m4_default`
  network and `communication-m4_masterkeys` volume. The two stack workers are
  never reconfigured by it.
* `wait_worker_row` (name → id/enforcement/capacity from `workers`).

## Prerequisites

* Go code built by the M4 implementation workers (`communication:dev` and
  `communication-worker:dev` images build from this repo; the harness
  skeletons here are language-agnostic to their progress).
* Real agent logins for the ACP legs (`~/.claude`, `~/.codex` — same
  requirement as the M3 harness; gates C1/C2/C9/C11 spend real turns).
* Host tools: `docker` (compose v2), `git`, CPython 3 (stdlib only), `bash`.
  No new repo dependencies. One new **image pull** is flagged in
  `compose.m4.yml` (`python:3.13-alpine`, the C11 collector).

## Related

* Probe evidence lives in `docs/compatibility/probes/m4/` (`run.sh` →
  `results-exit.txt`).
* The § 9.3 pipeline document will be copied to
  `docs/compatibility/probes/m4/pipeline.yaml` by the implementation workers
  (contract § 9.3); the profiles `seed.sh` (§ 7.0) is theirs as well.
