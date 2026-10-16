# ADR-0026 — The command sandbox grants read+exec on the program it launches and its `#!` interpreter

- **Date:** 2026-10-16
- **Status:** Accepted (implemented on `main` in commit `4fe3f68`, 2026-10-15; this ADR records a
  decision that landed in code before its paperwork, which is a process deviation, not a proposed one)
- **Owners:** worker/sandbox maintainers; M4 exit-gate owner (the `process.exec` twins depend on it)
- **Related decisions / contracts:** ADR-0019 (agent launch under nono in `required` mode — the
  verification chain N-d this extends, and the sandbox boundary this widens), ADR-0009 (nono
  `required` mode + the resolved-grant assertion), ADR-0013 (persistence; no schema change here),
  `docs/m4-contract.md` § 4 step 5 (the `process.exec` grant set) and step 14 (workers never
  evaluate), `docs/compatibility/M3-PROBES.md` probes C-FC2/C-FC3/C-HOSTGRP/C-GITCFG,
  `worker/sandbox/profiles/communication-command.json`, `internal/sandbox/nono/launchplan.go`,
  `internal/sandbox/nono/verify.go`, `internal/worker/procexec.go`

## Context

`process.exec` attempts run under the `communication-command` profile: Landlock-only, AF_UNIX
path-mediated, egress denied (`--block-net`), with the *workspace* the command works on granted as
per-run CLI flags and asserted path-for-path by N-d (ADR-0019). What that grant set never named is
the directory the program **itself** lives in. The M4 lab showed what that omission is worth:

- **Every `process.exec` attempt in the lab exited 126.** The command resolved from the worker's own
  `PATH` to `/opt/m4/bin/m4-exit.sh` (the deterministic-twin fixture, `.harness/m4-fixtures/bin/`),
  a path outside every Landlock grant. `nono` found the file and could not execute it; `classify()`
  reported the unable-to-start class. The failure was uniform — 126 on every attempt of every
  command node — so it was policy, not flake.
- The asymmetry is the point: the *worker* resolves the executable outside the sandbox (an
  `exec.LookPath` against the worker image's `PATH`), then asks the *sandbox* to exec that resolved
  path. Anything the lookup can reach but the ruleset cannot is unreachable-by-definition, and no
  amount of workspace granting fixes it.

This is a **security-boundary change** (a new class of filesystem grant inside ADR-0019's sandbox),
so it requires an ADR under `13-decisions-and-adrs.md` regardless of how small the diff looks.

## Options considered

| Option | Advantages | Disadvantages | Evidence |
|---|---|---|---|
| **A — copy/vendored tools into the workspace so they inherit the existing grant** | No new grant at all; the sandbox's path set is exactly the plan's | The command profile's workspace grants are `r+w`, so a copied tool becomes a **writable executable inside the sandbox** — strictly worse than a read-only grant outside it; plus per-run byte duplication and an ownership question (which digest covers the copy?) the schema has no answer for | profile grant levels in `internal/sandbox/nono/launchplan.go` (`plan.Grants` asserted at `r+w`); ADR-0019's write-scope argument |
| **B — one fixed tools directory granted in the profile file** | Static, host-declarable, no per-launch computation | It is a **broad static grant on every launch of every profile kind**, tagged `[profile]` and therefore invisible to N-d's `[user]` exact-set equality (ADR-0019's grant model note); it forces a worker-image packaging contract (`/opt/communication/tools`) that nothing in `09`/`03` declares, and it does not help a command the *pipeline author* names, which is what `process.exec` exists for | `GrantModelNote` + `[profile]` vs `[user]` tagging in `internal/sandbox/nono/profile.go`; probe C-HOSTGRP (host-conditional static grants are what broke CI before) |
| **C — per-tool allowlist of exact file paths** | Narrowest possible grant; a declared inventory is auditable | Needs a manifest with no home today (pipeline config has no tool inventory field), and the allowlist would still have to *resolve* `#!/usr/bin/env python3` against the worker's `PATH`, so the declared set and the resolved set disagree by construction; a file-level `--read` also does not cover a program's own data/library directory | `shebangInterpreter`'s `env` handling in `internal/worker/procexec.go`; `09`'s config shape |
| **D — derive two read grants from what the worker actually resolved (chosen)** | Exactly two paths, both derived from the argv the launch is already committed to; read level only; skipped when already covered; refused pre-launch if unresolvable; asserted in N-d like every other per-launch rule | Directory-granular, not file-granular (see Consequences/Security) — it grants the resolved program's *directory*, so siblings come along | implemented in `4fe3f68`; observed live in the two-worker lab (§ Verification) |

## Decision

**Option D**, as shipped in `4fe3f68`. The exact scope of the widening — this is the part that must
be read literally, because "grants the program its directory" understates the boundary:

1. **`LaunchSpec.ToolReads`** (`internal/sandbox/nono/launchplan.go`) carries per-launch read grants
   for the *program*, distinct from `Plan.Grants`, which are the workspace it works on.
2. **The set has at most two entries**: `filepath.Dir()` of the resolved `argv[0]` (after
   `exec.LookPath` if it was a bare name), and — when the program is a script — `filepath.Dir()` of
   the interpreter its `#!` line names. `#!/usr/bin/env X` is answered by the `PATH`-resolved `X`,
   because that is the program whose execution is being granted; a relative interpreter is resolved
   the same way; a non-`#!` binary contributes nothing.
3. **Level is `read`, never write.** Read is the level nono's Landlock ruleset pairs with exec
   (observed: `--read /opt/m4/bin` made `m4-exit.sh` runnable with egress unchanged). No code path
   in this change can emit `--write`/`--allow` for a tool path, and N-d refuses an `r+w` `[user]`
   rule on one (§ 6 below).
4. **Three skips before granting**: the file is not a regular existing file; the directory is already
   `seen` (dedupe); or the directory already sits **inside a plan grant** (`coveredByGrant`) — a
   checked-out build script is covered by its workspace's ruleset, and re-granting read on it would
   put two levels on one path and refuse the launch.
5. **Symlink-resolved before granting**, because nono resolves them too and N-d compares
   path-for-path: `--read /bin` is printed back as `r /usr/bin (dir)` and a want-list naming `/bin`
   would then read as "missing" while `/usr/bin` read as "never asked for".
6. **Unresolvable grant paths are refused before the launch**, not after: `BuildLaunchArgv` runs
   every entry through `wsgit.CheckGrantPath` and fails the launch with the C-FC3 note, because nono
   *silently drops* an unresolvable grant path and would otherwise launch a narrower sandbox than
   the one that was verified.
7. **N-d knows about them** (`assertGrants(plan, toolReads, got)` in
   `internal/sandbox/nono/verify.go`): tool reads enter the *intended* set at level `r`, never
   overwriting a plan entry's level. An assertion that did not know them would refuse every
   out-of-workspace command; a launcher that quietly allowed them would make "the resolved grant
   list is the recorded one" a claim nobody checks. A `[user]` rule at `r+w` on a tool path is a
   broadening and falls through to the existing unknown-rule refusal.
8. **Nothing else in the profile changes.** `worker/sandbox/profiles/communication-command.json`
   stays at version 3.2.0 with the same digest, the same excluded host-conditional groups, the same
   `--block-net`, and the same `filesystem` block: the widening is per-launch and per-command, not a
   standing rule for every attempt under the profile.

## Consequences

- Positive: `process.exec` works under the real sandbox. The lab's deterministic twin's `plan` node
  now succeeds and the run stops honestly at its approval gate; the failure mode it replaces
  (uniform exit 126) is gone rather than retried away.
- Positive: the grant is *computed from the launch*, so it cannot drift from it. There is no
  inventory to keep in sync, no host assumption baked into the profile, and the digest of the
  shipped profile is untouched — recorded policy digests still mean what they said.
- Positive: every entry still passes the whole verification chain, so the widened set is the
  *asserted* set. A command whose program resolves somewhere unexpected shows up as a
  `grant_assert (grant_mismatch)` refusal, i.e. fail-closed, not as a silently looser sandbox.
- Limitation: granularity is the **directory**, not the file. Granting `/opt/m4/bin` grants
  everything in it, executable and readable, for the lifetime of that one launch.
- Limitation: the sandbox can now execute anything in the same directory as the command the pipeline
  author named. Two commands in one directory means two grants' worth of exposure counted as one.
- Limitation: `shebangInterpreter` reads 256 bytes of the script and understands only the
  one-line, single-program `#!` form (`env`-with-flags and unresolvable names deliberately
  contribute no grant). An exotic interpreter line yields a launch that fails 126 again — an honest
  refusal, not a widening.
- Operational: worker-image `PATH` hygiene is now part of the sandbox's trust story, because
  `PATH` decides which directory gets granted (see Security/privacy).

## Security/privacy

**What actually widened, stated against what was already there.** The residual risk people expect
from "the sandbox can now read `PATH` directories" is, for the system ones, **not new**: the shipped
profile `extends: default`, and its `groups.exclude` list deliberately does *not* exclude
`system_read_linux_core` — `internal/sandbox/nono/profile.go` says so in words ("it is the group that
makes any binary run"), and N-d's group-source allowlist names it. That group already grants read on
`/bin`, `/sbin`, `/usr/bin`, `/usr/sbin`, `/usr/local/bin`, `/lib*`, `/usr/lib*` and the loader/TLS/
name-service `/etc` files, and nono pairs read with exec. So for a command resolving into a **system
`PATH` entry** (`/usr/bin/git`) the widening buys no new capability at all: the effective access was
already read+exec. Note the mechanism precisely, though — `coveredByGrant` only inspects the *plan's*
workspace grants, not the base layer's group grants, so such a launch does emit a redundant
`[user] r /usr/bin` flag. It is harmless and, unlike the `[group:…]` rule (which `assertGrants`
skips by source), it is the one N-d actually checks. The widening is real only for a resolved
program **outside** that group.

The genuinely new surface is a resolved program **outside** that core list:

- a helper under `/opt/...` (the lab fixture's case), a vendored toolchain under
  `/usr/local/share/...`, or any `PATH` entry the image adds;
- `~/.local/bin` and friends: `user_tools`/`homebrew_linux` are excluded from the profile precisely
  because they are host-conditional, so this change *re-admits one such directory, read+exec,
  per launch, whenever the worker's `PATH` resolves a command into it*.

Threat cases, in the order they bite:

1. **Planted binary in a non-core `PATH` directory.** A program written anywhere on the worker's
   `PATH` outside the core group can be named by a pipeline command and then read/exec'd inside the
   sandbox. This is reachable only by something that can already write the worker filesystem — which
   is outside the sandbox's claimed boundary — but it does mean the sandbox no longer compensates
   for a compromised worker image. State it plainly: **nono remains a per-launch FS/network boundary
   under a trusted worker, not a tenant boundary against one** (`AGENTS.md`: nono is the first
   sandbox prototype, not a verified tenant boundary; ADR-0019 says the same in its own words).
2. **Confused-deputy read.** Command `cat /opt/secret/tool/../data.json` was already answerable
   through a workspace grant; a *program* outside the workspace can now be executed, but it cannot
   read workspace material the plan did not grant, nor write anything it may not already write, nor
   reach egress (`--block-net` unchanged), nor see the excluded sensitive paths (the `deny_*` groups
   are required and contribute denies, never grants).
3. **Fail direction.** Unresolvable path → launch refused before it starts (C-FC3). Non-regular or
   missing file → no grant, launch proceeds, exit 126 as before. `r+w` on a tool path →
   `grant_mismatch`. Nothing here opens a fail-open path: each new branch either narrows or refuses.

## Verification

- **Live lab (the evidence this ADR is written from).** Two-worker M4 lab, `4fe3f68`: before, every
  `process.exec` attempt exited **126** (worker log: nono found `/opt/m4/bin/m4-exit.sh`, could not
  execute it); after, the deterministic twin's `plan` node **succeeds under the real sandbox** and
  the run waits at its approval gate. Reproduce with `e2e/m4/e2e_m4_exit.py` against
  `compose.m4.yml`; the fixture is generated by `e2e/m4/make_fixture_repo.sh`.
- **Base-profile grant evidence (this file's own claim about `/usr/bin`).** `nono profile groups
  system_read_linux_core` on nono 0.80.0, 2026-10-16, lists `/bin`, `/sbin`, `/usr/bin`,
  `/usr/sbin`, `/usr/local/bin`, `/lib`, `/lib64`, the multiarch lib dirs, `/usr/local/lib*` and the
  named `/etc` files — i.e. the system `PATH` entries were already read+exec-granted before this
  change. `internal/sandbox/nono/verify.go`'s parser comment carries the same observed line shape
  (`r /usr/bin (dir) [group:system_read_linux_core]`).
- **N-d coverage.** `TestVerifyChainPassesForARealWorkspace` and
  `TestVerifyChainFailsClosedOnEveryFailOpenShape` exercise the chain whose signature and semantics
  this change extended (grant-set exactness, unresolvable-path and `/tmp` refusals);
  `TestVerifyRefusesAPathNonoDrops` pins the C-FC3 class this change leans on;
  `TestSandboxVerifiedPayloadMatchesTheChain` pins the payload the worker records.
- **Gap, recorded rather than papered over.** No Go test asserts `ToolReads` today: `grep -rn
  "ToolReads" --include=*_test.go` is empty. The assertion is *reachable* —
  `internal/worker/procexec_test.go` already records every `nono.LaunchSpec` the executor builds
  (`recordingSandbox.lastSpec()`) — and the `shebangInterpreter`/`commandToolReads`/`coveredByGrant`
  trio is pure and unit-testable. That test is the follow-up named in this ADR's NEXT line; until it
  exists, the exit-126→success lab transition is the only thing pinning this behaviour.
- **Non-PASS discipline (ADR-0019):** the compatibility table row for `process.exec` under
  `communication-command` is evidenced by the observed exit codes above, not by a mocked launcher.

## Migration/rollback

- **Upgrade:** nothing to migrate — no schema, no profile version, no digest, no API change. The
  behaviour arrives with the binary.
- **Rollback:** revert `4fe3f68`. Every `process.exec` attempt whose program lives outside the plan's
  grants returns to exit 126 (fail-closed), which is why this is a rollback and not a regression
  risk for agent turns: agent profiles pass no `ToolReads` at all.
- **Tighten later (preferred direction, no reversal needed):** narrow the grant from directory to
  the resolved file plus the interpreter file (`--read <file>`), which is what option C wanted and
  what a declared tool manifest in `09`/`03` would finally make expressible; or move commands the
  product ships into a core-group directory so no new grant is ever computed. Both are amendments to
  § Decision items 2-4, and neither changes item 6 or 7, which are the safety properties.
