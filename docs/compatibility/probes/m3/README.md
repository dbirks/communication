# m3 probe suite — sandbox / git / secret / volume / APM claims behind `docs/m3-contract.md`

Re-derives, from scripts, every M0/M3 claim the M3 contract and ADR-0017…0020 depend on, on two
arms: this lab host and the real worker image (`communication-worker:dev`).

* **Summary, verdicts and the required contract corrections:**
  [`../../M3-PROBES.md`](../../M3-PROBES.md). Read that file before implementing M3 task 1 — nine of
  these claims are FAIL and they contradict sentences in the ADRs.
* **Raw evidence:** `results-host.txt`, `results-container.txt` (the unedited output of `run.sh`;
  every `PASS` in the summary is a `CHECK` line in one of these files).

## Layout

| File | Contents |
| --- | --- |
| `run.sh` | Runner: `--nono <path> --apm <path> --root <dir> --groups "p1 p3"`. Prints each probe's output plus `SUMMARY`/`FAILED_CLAIM`. |
| `lib.sh` | Sourced helpers: fixture builders (origin → mirror → linked worktree, the ADR-0017 layout), the `CHECK`/`NOTE` reporters, `m3_sb` / `m3_unsandboxed` (clean-env sandbox + control arm). |
| `p1_git_worktrees.sh` | git-behaviour claims: P1 admin-dir suffixing and read-back, X1/X2/X3/X5 exclusion scope, W5/W6, case-17 isolation, concurrent `Prepare`. |
| `p2_git_under_nono.sh` | The P1–P10 grant measurements under nono, `meta/` reachability, and the narrowed grant shape that fixes it. |
| `p3_nono_policy.sh` | nono policy surface: N1–N6, `/tmp` writes, `AF_UNIX` mediation, cwd handling, egress shapes, fail-closed arms. |
| `p4_secrets_env.sh` | `.env` materialization (case 12's probe form) and the cross-project denial scenario (nono + git + a planted secret, no Communication code). |
| `p5_volume_identity.sh` | Worker volume identity: `st_dev`/`st_ino` of named volumes and binds in fresh containers. Needs the docker CLI; creates and removes only its own `m3probe-*` volumes. |
| `p6_apm_staging.sh` | APM staging claims: per-run HOME, per-target lock digest, `--frozen` behaviour across an upstream mutation, generated paths vs `info/exclude`. Needs `apm` 0.33.0. |
| `helpers/m3-net.mjs` | Loopback TCP + `AF_UNIX` echo listener (node stdlib only) for the egress and socket arms. |

## Result words

`PASS` = observed, matched expectation. `FAIL` = observed, did not match. `GAP` = could not be
measured here. `N/A` = precondition absent, or informational capture. Never `PASS` by inference, and
never a mocked stand-in for a real protocol or sandbox run (`12-test-strategy.md`).

## Rerun

The two commands (host arm and worker-image arm, with the bind mounts the image still lacks) are in
[`../../M3-PROBES.md`](../../M3-PROBES.md) § "Rerun". Fixture data lives only under
`$HOME/.cache/communication-lab/m3-probes/` (container arm: the same directory bind-mounted at
`/scratch`); nothing here writes into the repository.
