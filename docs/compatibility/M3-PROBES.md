# M3 probe suite — every sandbox/git/secret claim the M3 contract stands on, scripted

`docs/m3-contract.md` and ADR-0017…0020 rest on probes the contract author ran by hand.
This directory re-derives each of them from a script, on two arms: this lab host and the
**real worker image**. Nothing below is inferred: a `PASS` needs an observed literal in
`probes/m3/results-<arm>.txt`, a claim that could not be measured is `GAP`, and a
measurement whose precondition does not exist in that environment is `N/A`
(`12-test-strategy.md`, "done means proven running").

The suite is 90 checks on the host arm and 76 on the container arm (p5 needs the docker CLI
and p6 needs apm to execute — neither is available inside the worker image, so those groups
report `GAP` there). Nine host claims and seven
container claims are **FAIL**: they contradict sentences in ADR-0017, ADR-0019 and
`docs/m3-contract.md`. Those sentences, and the smallest corrected design the evidence
supports, are in **Contract corrections required** below. Do not implement M3 task 1
against an ADR line listed there without reading this file.

## Provenance

| Item | Host arm | Worker-image arm |
| --- | --- | --- |
| Date (UTC) | `2026-10-15T06:13:39Z` (`SUITE` line) | `2026-10-15T06:14:02Z` |
| Machine | `delightful-goose`, Arch Linux, kernel `7.2.9-arch1-1`, x86_64 | same kernel (containers share it), Debian 12 bookworm userland |
| LSMs | `capability,landlock,lockdown,yama,bpf` (`/sys/kernel/security/lsm`) | `unreadable` (`/sys/kernel/security/lsm` not mounted); Landlock proven working by C-PROBE |
| Run user | `david` uid 1000 | `worker` uid 10001 (the image's own `USER`, its own `/home/worker`) |
| Locale | `en_US.UTF-8` | image default is POSIX; lib.sh promotes it to `C.utf8` (see deviations) |
| git | `2.56.0` | `2.39.5` (apt in `node:22-bookworm-slim`) |
| node | `v26.11.1` | `v22.23.3` |
| curl | `8.22.0` | `7.88.1` |
| nono | `0.80.0`, sha256 `e02d003d52b3f65e8c75358eb73e339ad952a2876529047e61183b46eff1287d`, `$HOME/.local/bin/nono` | same binary, bind-mounted read-only at `/opt/nono` — the image does **not** contain nono |
| apm | `0.33.0`, `$HOME/.local/bin/apm` | same binary mounted at `/opt/apm`; **cannot execute** (see A0) |
| glibc | `GNU libc 2.44` | `Debian GLIBC 2.36-9+deb12u14` |
| Image | — | `communication-worker:dev` `sha256:88cd4564d3cb…b8558c` |
| Docker | client/server `29.9.0` (p5's volume measurements use `docker run --rm` only, no compose project, own `m3probe-*` volumes, removed by the probe) | — |
| Scratch | `$HOME/.cache/communication-lab/m3-probes/` | `/scratch` (a bind of `$HOME/.cache/communication-lab/m3-probes/container/`) |

## Rerun

Host arm (needs `git`, `node`, `curl`, nono and apm on the paths above):

```bash
bash docs/compatibility/probes/m3/run.sh \
  > docs/compatibility/probes/m3/results-host.txt 2>&1
```

Worker-image arm — `docker run --rm`, never through the `communication` compose project;
the scratch dir must be world-writable because the container writes as uid 10001:

```bash
SCR="$HOME/.cache/communication-lab/m3-probes/container"
rm -rf "$SCR"; mkdir -p "$SCR"; chmod 0777 "$SCR"
docker run --rm \
  -v "$SCR":/scratch \
  -v "$HOME/.local/share/communication-lab/nono/0.80.0":/opt/nono:ro \
  -v "$HOME/.local/share/communication-lab/apm/0.33.0":/opt/apm:ro \
  -v "$PWD/docs/compatibility/probes/m3":/probe:ro \
  --entrypoint bash \
  -e M3_NONO=/opt/nono/nono -e M3_APM=/opt/apm/apm -e M3_PROBE_ROOT_BASE=/scratch \
  communication-worker:dev /probe/run.sh \
  > docs/compatibility/probes/m3/results-container.txt 2>&1
```

One probe at a time: `bash docs/compatibility/probes/m3/p3_nono_policy.sh --keep`
(`--nono`, `--apm`, `--fixture`, `--keep`; `run.sh --groups "p2 p3"` selects groups).
Each probe prints `CHECK <id> <PASS|FAIL|GAP|N/A> <observation>` and `run.sh` ends with
`SUMMARY` + one `FAILED_CLAIM` line per FAIL.

## Tallies

| Arm | PASS | FAIL | GAP | N/A | TOTAL |
| --- | --- | --- | --- | --- | --- |
| Host (Arch, git 2.56.0, uid 1000) | 73 | 9 | 1 | 7 | 90 |
| `communication-worker:dev` (bookworm, git 2.39.5, uid 10001) | 60 | 7 | 5 | 4 | 76 |

Host FAILs: `G1b`, `C-H1`, `C-META`, `C-SILENT`, `C-CWD`, `C-FC2`, `V3`, `V5b`, `A5`.
Container FAILs: the same minus `V3`/`V5b`/`A5` (not measurable there), plus `G10`.

## Claims and verdicts

"H" = host arm, "C" = worker-image arm. The raw observation for every row is the matching
`CHECK <id>` line in `probes/m3/results-host.txt` / `results-container.txt`.

### p1 — git worktree, mirror and exclusion behaviour (`p1_git_worktrees.sh`)

No sandbox: these are git-behaviour claims, measured identically on both arms (which is why
the arms disagree — different git versions).

| id | claim | H | C |
| --- | --- | --- | --- |
| G1 | two worktrees of one repo get admin dirs `backend` / `backend1` — the admin path is not derivable from the layout (ADR-0017 **P1**) | PASS | PASS |
| G1b | `git worktree list --porcelain` emits a `gitdir:` line to read it back (ADR-0017 D4, contract's `admin_dir` comment) | **FAIL** | **FAIL** |
| G1c | `git -C <worktree> rev-parse --absolute-git-dir` and the worktree's own `.git` file agree | PASS | PASS |
| G2 | `<mirror>/logs/refs/heads/<scope-id>/` exists after an unsandboxed add+commit (i.e. git creates reflog dirs lazily) | GAP | GAP |
| G3 | a rule in the *worktree* admin `info/exclude` is honoured (ADR-0017 **X1**) | PASS (it is ignored) | PASS |
| G4 | the same rule in `<mirror>/info/exclude` is honoured (**X2**) — the only working place | PASS | PASS |
| G5 | one mirror-level exclusion also covers a second run's identical path (**X5**, project-scoped) | PASS | PASS |
| G6 | `extensions.worktreeConfig=true` breaks `git status` in this layout (**X3**) | PASS | PASS |
| G7 | case-17 shape: run-1's commit leaves run-2's checkout clean and unchanged | PASS | PASS |
| G8 | a copied worktree without its mirror is unusable (WORKSPACES **W5**) | PASS | PASS |
| G9 | `worktree remove --force` + `prune` drops one run and leaves the other intact (**W6**) | PASS | PASS |
| G10 | concurrent `Prepare` of two runs against one mirror is safe (ADR-0017's own "untested" list) | PASS | **FAIL** |
| G10b | running the same adds one at a time succeeds on both gits (the remedy G10 demands) | PASS | PASS |

### p2 — git under nono: the P1–P10 grant measurements (`p2_git_under_nono.sh`)

| id | claim | H | C |
| --- | --- | --- | --- |
| C-P10 / C-P10b | the worktree grant alone kills any git command; `ro <mirror>` fixes it | PASS | PASS |
| C-P6 / C-P6b | a HOME outside the grants aborts git even with `-c` identity flags; a `home/` inside them does not | PASS | PASS |
| C-H1 | nono accepts a launch whose `HOME` is `<workspace>/home` (ADR-0019 D1's argv) | **FAIL** | **FAIL** |
| C-H1b | nono's own HOME outside the grants + child `HOME=<ws>/home` inside → works | PASS | PASS |
| C-H1c | the shell-free form of that: `nono run … -- env HOME=<ws>/home <adapter argv>` | PASS | PASS |
| C-P7 | `<mirror>/logs/refs/heads/<scope-id>/` must be pre-created before a confined commit (**P7**) | PASS | PASS |
| C-P2 | a sandboxed commit succeeds with exactly `rw <ws>` + `rw objects` + `rw refs/heads/<scope>` + `rw logs/refs/heads/<scope>` + `rw <admin>` + `ro <mirror>`, and its write-set stays inside it (**P2**) | PASS | PASS |
| C-P3 | with the mirror `ro` only, the same commit fails at `worktrees/<admin>/index.lock` (**P3**) | PASS | PASS |
| C-P4 | run-2's sandbox cannot write run-1's ref, while the identical unsandboxed command can (**P4**, control pair) | PASS | PASS |
| C-P5 | run-2's sandbox *can* read run-1's branch through the shared mirror (**P5**, a limitation) | PASS | PASS |
| C-X4 | the agent cannot append to `<mirror>/info/exclude` | PASS | PASS |
| C-META | `meta/` ("worker-only, never mounted to agent", `05`) is unreachable under ADR-0019 D1's `--allow <workspace root>` | **FAIL** | **FAIL** |
| C-GRANT | git + edits + `scratch/` writes still work when the grant is `rw <ws>/repos` + `rw <ws>/scratch` + `rw <ws>/home` + `ro <mirror>` (the correction) | PASS | PASS |
| C-GRANT2 | under that shape `meta/` is unreadable *and* unwritable — omission alone keeps 05's promise | PASS | PASS |
| C-P8 | a successful sandboxed commit still prints `packed-refs.lock: Permission denied` on stderr (exit status, not stderr, is the signal) | PASS | GAP (2.39.5 prints nothing) |

### p3 — nono policy surface, temp paths, sockets, cwd, egress (`p3_nono_policy.sh`)

| id | claim | H | C |
| --- | --- | --- | --- |
| C-PROBE | N-a: `nono setup --check-only` honestly reports Landlock V6 + filesystem + TCP support here | PASS | PASS |
| C-TMP1 | the default layered profile write-grants `/tmp` — "denied by omission" is false there (N1/P9) | PASS | PASS |
| C-TMP2 | a profile-level `filesystem.deny` of `/tmp,/var/tmp,/dev/shm` does **not** beat the layered default grant | PASS | PASS |
| C-TMP3 | the `/tmp` write comes from the `system_write_linux` group; excluding it also kills `/dev/null` (so devices must be re-granted) | PASS | PASS |
| C-RO / C-ROb | `--read` is genuinely read-only; a secret under a read grant is readable by design | PASS / N/A | PASS / N/A |
| C-PROF, C-PROFb, C-PROFc | N3: `profile init` refuses a path argument (profiles must be authored); `profile validate <path>` works on a file we ship and fails closed when it is missing | PASS | PASS |
| C-AFU, C-AFU2 | N-c/N4: `profile show` is the only surface reporting `AF_UNIX mediation: Pathname`; the verbose dry-run has no AF_UNIX line | PASS | PASS |
| C-SILENT | `run -s -p <path> -v --dry-run` prints the grant list that N-d asserts on | **FAIL** | **FAIL** |
| C-SOCK, C-SOCKb, C-SOCK2 | `af_unix_mediation=pathname` denies an ungranted `AF_UNIX` connect, granting it restores connect, and the docker socket stays unreachable | PASS | PASS / PASS / GAP (no socket in the image) |
| C-CWD | N-d's exit status proves the cwd is inside the grants in the configuration ADR-0009 mandates (`-p <profile path>`) | **FAIL** | **FAIL** |
| C-CWD2 | with `-p <profile>` and a cwd outside the grants, nothing leaks: the child is relocated and the old cwd stays unreadable by absolute path | PASS | PASS |
| C-CWD3 | `--allow-cwd` is a grant, not an assertion — passing it makes an out-of-scope launch dir readable | PASS (hazard confirmed) | PASS |
| C-ND | N-d is observable without `-s` (merged grant list, `[user]` + `[group:…]` sources, and it shows `/tmp` count) | PASS | PASS |
| C-MISSING | N6: a missing profile aborts with exit 1 and the child is never exec'd (marker absent) | PASS | PASS |
| C-EG1, C-EG2 | `--block-net` denies a loopback TCP connect; without it the same connect succeeds — the observed basis for `network_enforced=false` on the agent-turn profile (ADR-0019 D3) | PASS | PASS |
| C-FC2 | nono fails closed when the policy resolves to `--sandbox-policy external` while `--block-net` is requested | **FAIL** | **FAIL** |
| C-FC2b | some nono surface reports the *resolved* sandbox policy (`validate`, `profile show`, dry-run) | PASS (none does — see correction 6) | PASS |
| C-FC3 | nono rejects a grant path that does not exist | PASS (it is ignored silently; adapter must validate) | PASS |
| C-CMD (note) | default-profile `dangerous_commands` blocks `cp` of an ungranted file but `chmod` did not apply | noted | noted |

### p4 — `.env` materialization and the cross-project denial (`p4_secrets_env.sh`)

| id | claim | H | C |
| --- | --- | --- | --- |
| C-ENV1 | `O_CREAT\|O_EXCL` + umask 077 lands the file 0600 owned by the worker uid (C12a) | PASS | PASS |
| C-ENV2 | while the file exists it is invisible to `status --porcelain` / `ls-files` / `diff` (C12c) | PASS | PASS |
| C-ENV3 | the sandboxed agent of project A can read A's own materialized secret | N/A (by design) | N/A |
| C-ENV4, C-ENV4b | `git add -A && git commit` inside the sandbox captures no secret (C12g), and the negative control proves the exclusion is what stops it | PASS | PASS |
| C-ENV5 | after the unit the file is gone (C12d) | PASS | PASS |
| C-ENV6, C-ENV6b, C-ENV7 | the path battery (`path_escape`, `absolute_path`, `bad_shape`), a tracked target is refused as `tracked_target`, and a second materialization at a live path is refused with content untouched (C12i, ADR-0018 D4) | PASS | PASS |
| C-ENV10 | Landlock does not scrub the environment — a launcher env var reaches the sandboxed child unchanged, so "Env built from scratch" is load-bearing (ADR-0019 D1) | PASS | PASS |
| C-XPROJ1, C-XPROJ1b, C-XPROJ2, C-XPROJ3, C-XPROJ3b, C-XPROJ3c | project B's sandbox cannot read project A's `.env`, cannot stat its workspace dir, cannot reach A's mirror or A's `info/exclude`; the positive control shows B *can* read its own (contract X1–X3) | PASS | PASS |
| C-XPROJ4 | with the same uid and no sandbox, B's 0600 secret is readable | N/A (D-025 caveat, not a bug) | N/A |
| C-ENV8 | under `/tmp`, project B cannot read A's secret but *can* truncate and replace it — integrity hole, not disclosure hole | PASS | PASS |
| C-ENV8b | the default `/tmp` grant is write-only (not even self-read-back) | N/A | N/A |

### p5 — worker volume identity (`p5_volume_identity.sh`; container arm: `PREAMBLE GAP` — no docker CLI in the image)

| id | claim | H | C |
| --- | --- | --- | --- |
| V1 | informational: named volume at `/workspaces` reports `st_dev`/`st_ino` in a fresh container | N/A | GAP |
| V2 | the same named volume at the same path reports the same `(st_dev, st_ino)` across two fresh containers — an identity from that triple survives a worker restart | PASS | — |
| V3 | `st_dev` + root path distinguishes a replaced named volume (ADR-0017 D2's derivation) | **FAIL** | — |
| V4 | the dev harness's host bind at the same path really changes the measured device | PASS | — |
| V5 | `repos/` beside `workspaces/` on one volume reports one `st_dev` (ADR-0017 D1) | PASS | — |
| V5b | one `workers.volume_id` column can name both the workspace tree and the mirror tree when they are separate volumes on one device | **FAIL** | — |
| V6 | the image's own view of the tuple ADR-0017 D2 hashes (`/workspaces` dev + inode + fstype, uid 10001) | N/A | GAP |

### p6 — APM staging claims (`p6_apm_staging.sh`; container arm: `A0 GAP` — apm cannot execute)

| id | claim | H | C |
| --- | --- | --- | --- |
| A0 | the vendored apm 0.33.0 binary runs in this environment | — (runs) | **GAP**: needs `GLIBC_2.38`, image has 2.36 |
| A1 | `HOME=<ws>/home apm install --target claude` stages into the run checkout (contract § 4.2 step 2) | PASS | — |
| A2 | apm writes `.apm` + `.cache/apm` into the per-run HOME (APM.md T4 — why `home/` exists) | PASS | — |
| A4 | `install --frozen --target claude` reproduces the lock digest and tree for an unchanged upstream (C14d's stability half) | PASS | — |
| A5 | `install --frozen` also holds when the upstream local-path package changed (C14d's "no new package content appears") | **FAIL** | — |
| A5b | the lock digest moves exactly when package content moves, with or without `--frozen` — so the pre-launch digest assertion works | PASS | — |
| A3 | the lock digest is per target (APM.md T5): one shared `apm.lock.yaml` per checkout, so a second `--target` install moves it | PASS (with the caveat) | — |
| A3b | a target switch is loud: a codex-written lock does not match the recorded claude digest | PASS | — |
| A6 | APM's generated paths are git-visible until the mirror's `info/exclude` names them | PASS | — |
| A7 | `home/` carries harness state and must be deleted with the attempt | N/A | — |

## Newly proven that was only assumed before

* **Landlock works inside the real worker image.** `communication-worker:dev`
  (`node:22-bookworm-slim`, Docker 29.9.0 builtin seccomp, non-root uid 10001) reports Landlock V6,
  "Filesystem ruleset creation verified" and "TCP network rule support verified" (`C-PROBE`) and
  every filesystem and egress denial in p2/p3/p4 reproduced there (`C-P2`, `C-P4`, `C-XPROJ*`,
  `C-EG1`, `C-SOCK`). `docs/m3-contract.md` § 5's row "Landlock probe of `node:22-bookworm-slim`
  under Docker 29.9.0 builtin seccomp — only `debian:trixie-slim` was probed" is now answered:
  `required` mode needs no `--security-opt seccomp=unconfined` and no base-image change *for
  Landlock*. (The base-image problem that does exist is apm's glibc, correction 10.)
* **The corrected grant shape is launchable** (`C-GRANT`, `C-GRANT2`, `C-H1c`), so corrections 2 and
  3 are not speculative — they are measured, on both arms.
* **Serialization is a sufficient remedy for concurrent `Prepare`** (`G10b`, both arms).

## Contract corrections required

Each entry names the falsified sentence, the observed contradiction, and the smallest corrected
design the evidence supports. **Do not edit the ADRs from this file's authority — open the change
as an ADR amendment** (13-decisions: protocol/persistence/deployment changes need an ADR). The
"state" line records what had already landed in `docs/m3-contract.md` at the time of writing
(HEAD `4d27f75`, contract still being edited by another worker — re-verify before acting).

### 1. `G1b` — the admin-dir read-back mechanism does not exist (H+C FAIL)

* **Sentence** — ADR-0017 D4: "`git worktree list --porcelain` to read this worktree's real `gitdir:`".
* **Observed** — that command emitted **no `gitdir:` line at all**, on git 2.56.0 *and* 2.39.5: 8
  lines, all `worktree` / `bare` / `HEAD` / `branch` records, none of them `gitdir:`. An
  implementation following the ADR literally parses nothing into `workspace_repos.admin_dir`, and the
  `rw <admin>` row of ADR-0017 D4's commit grant set then has no path to grant — the failure C-P3
  measured (`worktrees/<admin>/index.lock: Permission denied`).
* **Corrected design** — read it back with `git -C <worktree> rev-parse --absolute-git-dir`; the
  worktree's own `.git` file (`gitdir: <abs>`) agrees with it (`G1c`), which is the read-back a
  worker can do without git at all if it ever needs to.
* **State** — contract fixed (`admin_dir … read back with rev-parse --absolute-git-dir`, § 4.2 step 1);
  **ADR-0017 D4 still carries the wrong mechanism**.

### 2. `C-H1` — ADR-0019 D1's argv is not launchable (H+C FAIL)

* **Sentence** — ADR-0019 D1: `exec nono run -s -p <profile> --allow <workspace root> … -- <adapter>`
  with "the worker passes `PATH`, `HOME=<workspace>/home`, …" in the launched process's env.
* **Observed** — handing `HOME=<workspace>/home` to the **nono process** makes nono refuse its own
  workspace grant: `Sandbox initialization failed: Refusing to grant '<ws>' (source: CLI) because it
  overlaps protected nono state root '<ws>/home/.local/state/nono'`, exit 1. The trap is sticky: once
  nono has run with `HOME=X`, `X/.local/state/nono` is a protected root and every later grant
  covering `X` is refused — so a workspace whose `home/` was ever used that way becomes ungrantable.
* **Corrected design** — two different HOMEs, in two different places:
  nono's own `HOME` stays the worker's (`/home/worker` in the image, or a per-launch launcher home)
  and is never under any workspace or any grant; the *agent's* `HOME=<ws>/home` is applied inside the
  sandbox as the first argument of the sandboxed program — `… -- env HOME=<ws>/home <adapter argv>`
  (`C-H1c`, shell-free, works on both arms; `C-H1b` the `sh -c` form). ADR-0019's argv block must
  show the `env` hop, because `internal/sandbox/nono/launcher.go` execs the adapter directly.

### 3. `C-META` — `meta/` is inside the recursive grant (H+C FAIL), fixed by `C-GRANT`/`C-GRANT2`

* **Sentences** — `05`: "`meta/` # worker-only metadata, never mounted to agent"; ADR-0017 D1:
  "`meta/` stays out of every grant"; while ADR-0019 D1's argv grants `--allow <workspace root>`
  (commented `# repos/ + scratch/ + home/`).
* **Observed** — `--allow` is recursive, so the sandboxed agent read `meta/workspace.json` **and**
  wrote `meta/agent-written`, exit 0. The argv's comment names three children and the flag grants
  their parent, which also contains `meta/`.
* **Corrected design (measured)** — never grant the workspace root. `C-GRANT` shows
  `--allow <ws>/repos --allow <ws>/scratch --allow <ws>/home --read <mirror>` keeps git, edits and
  scratch writes working, and `C-GRANT2` shows `meta/` is then unreadable *and* unwritable by
  omission alone — no nono deny rule involved. Equally valid is the contract's shape (grant
  `agent_root` = `<root>/work` and keep `meta/` a sibling); note that it was measured as three child
  grants, so if `work/` can ever contain anything else at launch, the worker must assert that it
  cannot. Either way `cmd.Dir` moves with it (see correction 5).
* **State** — contract fixed (§ 4.2 step 4 + deviation D13); **ADR-0019's argv and ADR-0017 D1's
  "stays out of every grant" still describe the shape that does not hold**; `05` cannot be edited, so
  the ADR must record the deviation explicitly (it is currently only in the contract's D13).

### 4. `C-SILENT` — `-s` and N-d are mutually exclusive, and the failure is silent (H+C FAIL)

* **Sentence** — ADR-0019 D1 runs `nono run -s …` and D2's N-d asserts on the merged grant list; the
  chain is written as one argv used everywhere except a note.
* **Observed** — `run -s -p <path> -v --dry-run` printed **0 lines**; the same argv without `-s`
  printed 62 (then 63 with the mirror read). An adapter that reuses its silent argv for N-d asserts
  against empty output and passes **vacuously** — the worst kind of green.
* **Corrected design** — N-d gets its own argv (no `-s`), and the parser must fail closed when it
  finds no `[user]` grant line at all (`C-ND` shows the expected shape: 63 lines, 2 `[user]`,
  39 `[group:…]`). "Zero grants parsed" must be an abort, never an empty-set match.

### 5. `C-CWD` — N-d's cwd assertion is false in profile mode (H+C FAIL); `C-CWD2`/`C-CWD3` give the recipe

* **Sentence** — ADR-0019 N-d: "`nono run -p <path> -v --dry-run` **with `cmd.Dir` inside the
  grants** (observed: exit 1 "CWD access requires --allow-cwd" when run from outside them, exit 0
  when inside)".
* **Observed** — that exit-1 behaviour exists **only with CLI flags**. With `-p <profile path>` — the
  configuration ADR-0009 mandates — the identical command exits **0**: nono does not abort, it drops
  the cwd grant and the child's `pwd` becomes `/`. The outside directory is not readable (`C-CWD2`,
  even by absolute path), so this is not a disclosure bug; it is a *missing assertion* plus a
  confusing runtime failure (every relative path in the turn now resolves against `/`).
* **Corrected design** — (a) the cwd rule is the adapter's own: validate `cmd.Dir` is inside one of
  the rw grants it computed (`requireDirInsideReadWrite`) *before* exec, and say so in the ADR rather
  than attributing it to nono; (b) never read N-d's exit status as the cwd proof; (c) **never pass
  `--allow-cwd`** — `C-CWD3` shows it is a grant, not an assertion: with it, the launch directory
  outside the intended grants became readable; (d) after correction 3 narrows the grant, `cmd.Dir`
  must be the worktree (or another granted path), not the workspace root, or profile mode relocates
  it to `/`.

### 6. `C-FC2` + `C-FC2b` — nono neither enforces nor reports `external` (H+C FAIL)

* **Sentence** — ADR-0019 D2: "The adapter keeps `--sandbox-policy landlock` pinned and never emits
  `external`", listed as a fail-closed assertion the sandbox provides.
* **Observed** — with `--sandbox-policy external --block-net` the child reached the network (exit 0,
  `200` from `https://example.com`): nono does **not** fail closed. And no nono surface reveals the
  resolved policy: `profile validate` accepts a profile with `sandbox_policy: external` (exit 0),
  `profile show` output is identical for `landlock` and `external` once its own path echo is dropped,
  and the verbose dry-run rule list is identical modulo the per-invocation `/proc/<pid>/fd` grant
  (`C-FC2b`).
* **Corrected design** — the assertion moves from "never emit the flag" to "assert the shipped
  profile file's contents": parse the JSON the worker ships and require
  `linux.sandbox_policy == "landlock"` (and `af_unix_mediation == "pathname"`, which `C-AFU` shows is
  only visible via `profile show`), pin that file with the contract's `policy_digest`, ban the CLI
  flag in the adapter, and add a unit test proving a profile mutated to `external` is refused before
  any exec. N-b/N-c/N-d cannot catch it.

### 7. `V3` — `st_dev` alone cannot identify a volume (H FAIL)

* **Sentence** — ADR-0017 D2: "The worker resolves the `st_dev` of its workspace root, hashes the
  device identity plus the root path, and reports it on register as `volume_id`" — and "a named volume
  replaced at the same path is a *different* `volume_id`, and that is the whole point of the column".
* **Observed** — two **different** docker named volumes mounted at `/workspaces` reported the same
  `st_dev` (30 == 30; docker volumes are bind mounts of host directories on one filesystem). They
  differ in `st_ino`. The stated derivation therefore calls a replaced volume the same volume, and
  case 20's honest-loss arm never fires: the worker reclaims directories that are gone.
* **Corrected design** — `volume_id = sha256(st_dev, st_ino of the root, normalized root path)`.
  `V2` shows that triple is stable across two fresh containers on one volume; `V3` shows it
  discriminates a replaced one; `V4` shows the dev harness's host bind changes it.
* **State** — contract fixed (`worker_volumes`, `(st_dev, st_ino, root_path)`); **ADR-0017 D2 still
  says `st_dev` only** and needs the same amendment.

### 8. `V5b` — one `volume_id` column cannot name two trees (H FAIL)

* **Sentence** — `docs/m3-contract.md` § 5 (mirror root gets its own named volume beside the
  workspaces volume) together with ADR-0017 D2's single `workers.volume_id`.
* **Observed** — `/workspaces` = (dev 30, ino 19522917) and `/repos` = (dev 30, ino 19523019) in the
  shipped run: same device, different inode (the inodes differ every run; the point is that `st_dev`
  cannot even tell the two roots apart), and one column names exactly one of them, so recovery has no
  identity for the other tree.
* **Corrected design** — per-root identity rows (contract's `worker_volumes` +
  `workspace_repos.mirror_volume_id`), or a single volume for both trees (`V5`: one volume mounted at
  both paths reports one `st_dev`, so "same volume" remains a meaningful statement). Whichever is
  chosen, the recovery rule must say **which** tree an identity refers to.
* **State** — contract fixed; **ADR-0017 D1/D2 still describe one identity**.

### 9. `A5` — `apm install --frozen` does not freeze a local-path dependency (H FAIL)

* **Sentence** — contract case `C14d`: "turn 2 on the SAME profile revision → `apm install --frozen`
  reproduces the SAME tree; assert `sha256(apm.lock.yaml)` on disk equals the recorded digest, and no
  new package content appears"; § 4.2 step 2 leans on `--frozen` for that.
* **Observed** — with the upstream local-path package mutated, `apm install --frozen --target claude`
  exited **0**, **moved** the lock digest, replaced the deployed tree and put the mutated skill
  content live, while reporting `Lockfile presence verified. Run 'apm audit' for on-disk content
  integrity` (quoted verbatim in the `A5` line). It verifies presence, not content.
  The unchanged-upstream half of C14d *does* hold (`A4`: identical digest and tree).
* **Corrected design** — keep `--frozen` (it prevents re-resolution of *registry* versions) but move
  the guarantee to where it is measured: the pre-launch digest comparison (`A5b` — the digest moves
  exactly when content moves, under `--frozen` and without it alike), so
  `agent_profiles.apm_lock_digest` mismatch is the control that refuses restaging, and case 14's
  acceptance test must assert *refusal by digest*, not "no new content appears". Drop the wording
  that describes `--frozen` as content pinning.
* **Also from p6** — the lock is **one file per checkout recording every installed target** (`A3`):
  a second `--target` install moves the digest, and a `--frozen --target claude` run over a
  codex-written lock keeps the codex lock (`A3b`). So "one digest per target" is only comparable if
  exactly one target is ever installed into a run checkout — say that in § 4.2 step 2, or a profile
  whose target changes mid-run silently produces an unmatchable digest (loudly refused, but for the
  wrong reason).

### 10. `A0` + `G10` — the worker image cannot run the toolchain the contract assumes (C: GAP + FAIL)

* **Sentence** — § 5: "Vendor `nono 0.80.0` … and `apm 0.33.0` … into the worker image | the image has
  neither today", and ADR-0017's line listing "concurrent `Prepare` of two runs against one mirror"
  among the things to be settled.
* **Observed** — apm 0.33.0 is a PyInstaller bundle: `[PYI-…:ERROR] Failed to load Python shared
  library … GLIBC_2.38' not found (required by …/libpython3.12.so.1.0)`; the image ships
  `Debian GLIBC 2.36-9+deb12u14`, so **the pinned apm cannot exec in the worker image at all** —
  the § 5 task is not merely undone, it is impossible on `node:22-bookworm-slim` as pinned.
  Separately, on the image's `git 2.39.5`, 6 parallel `git worktree add -b` against one mirror
  succeeded 1–3 times out of 6 across repeated runs (`could not lock config file
  <mirror>/config: File exists`, `unable to write upstream branch configuration`), while 6 serialized
  adds always succeeded (`G10b`). On the host's git 2.56.0 the parallel form happened to pass, so
  ADR-0017's "untested" item is now **tested and false for the deployment target**.
* **Corrected design** — (a) Prepare takes a per-mirror mutex (or a lockfile) around `worktree add`:
  measured sufficient on both gits, no upgrade required; (b) the worker image choice must be an ADR
  decision (ADR-0007 deployment model): a trixie-based image (newer glibc — which also moves git
  toward the version this suite measured passing on the host, though the bisect of *which* git fixed
  the config-lock race is an M3 task, not a claim here), or an apm build that runs on bookworm, or a
  bundled interpreter; (c) pin and record the image's git version in `doctor` output, because `C-P8`
  shows error-text expectations are git-version dependent.
* **State** — unresolved. The `worker/Dockerfile` in the working tree (HEAD `4d27f75` + another
  worker's in-flight edit) still builds its runtime from `node:22-bookworm-slim`, so the glibc floor
  stands; and no image vendors nono or apm yet — which is exactly why this suite has to bind-mount
  them (`communication-worker:dev` has neither on PATH).

## What this suite does **not** prove

* **APM inside the worker image** (`A1`…`A7`): unmeasured, not passed — `A0` says why. Re-run p6 in
  the container once the image can execute apm; until then every APM claim is host-only evidence.
* **Volume identity in-image** (`V1`…`V6`): the container arm reports `PREAMBLE GAP` (no docker CLI
  in the image, and the probe must not mount the docker socket). As with `SANDBOX.md`'s C7, the host
  row is the authoritative answer, and the numbers are docker-29.9.0-specific.
* **Enforced egress on a real harness turn**: `C-EG1`/`C-EG2` reproduce both shapes on bare `curl`
  and a loopback listener; a real agent turn still cannot carry enforced egress (ADR-0019 D3), which
  is why `network_enforced=false` stays on the agent-turn profile.
* **Cross-tenant hostile same-uid process** (`C-XPROJ4`): with one uid and no sandbox, project B's
  0600 secret is readable. D-025 stays open; ADR-0018 defends the DB dump/API/journal/artifacts.
* **`/var/run/docker.sock` in-image** (`C-SOCK2 GAP`): the socket is not present in the worker image;
  its denial is proven on the host arm only.
* **The `dangerous_commands` blocklist as a control** (`C-CMD` note): bypassable, `chmod` did not
  apply; a materializer must use `umask` + `O_CREAT|O_EXCL`, not `chmod`.

## How these scripts differ from the original brief

* nono and apm are **bind-mounted from the lab** into the container arm (`/opt/nono`, `/opt/apm`),
  because the image contains neither (contract § 5 says so). The mounted apm cannot execute (A0);
  the mounted nono does, and ADR-0019's pin is the same binary sha256 as the host arm.
* The container runs as the image's own `USER worker` (uid 10001) rather than the invoking uid, so
  the arm measures the real runtime identity; scratch is bind-mounted `0777` and cleaned up by
  `docker run --rm` + the probe itself.
* `lib.sh` promotes a POSIX locale to `C.utf8` and pipes `m3_oneline` through `iconv -c`: under the
  image's default locale `cut -c` counts bytes and split nono's box-drawing banner into an invalid
  byte, which made `results-container.txt` non-text.
* Checks added while turning the corrections into evidence (none of them weakens an existing check):
  `G10b` (serialization), `C-H1c` (shell-free `env` recipe), `C-GRANT`/`C-GRANT2` (the narrowed grant
  shape), `C-CWD2`/`C-CWD3` (cwd disclosure and the `--allow-cwd` hazard), `C-FC2b` (no surface
  reports the policy), `A3b`/`A5b` (digest semantics), plus `A0`'s runnability gate — a tool that
  exists but cannot execute is a missing precondition (GAP), not a failed claim.
* `results-host.txt` was regenerated to include p6: the committed host run predates
  `p6_apm_staging.sh`, and its recorded `SUMMARY` line ("`SUMMARY C-XPROJ3b=1 C-ENV5=1 …`") tallies
  check **ids** rather than verdicts — it was emitted by an earlier revision of the tally awk and
  cannot be reproduced from the committed `run.sh`. The regenerated file reports the real verdict
  counts (`PASS=73 FAIL=9 GAP=1 N/A=7 TOTAL=90`).
