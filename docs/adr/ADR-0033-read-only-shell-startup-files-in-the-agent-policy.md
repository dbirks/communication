# ADR-0033 — The sandbox profile grants read on the shell's system startup files, never on `/etc`

- **Date:** 2026-10-16 · **Status:** Accepted · **Owners:** worker/sandbox maintainers
- **Related:** ADR-0019 (agent launch under nono in `required` mode — the chain this keeps),
  ADR-0026 (per-launch tool read grants — a *different* mechanism, which is why this is its own ADR),
  ADR-0009 (resolved-profile assertion), probe C-GITCFG (`/etc/gitconfig` precedent in
  `systemConfigReads`), probe C-BASHRC (this file's evidence, recorded in
  `docs/compatibility/SANDBOX.md`), `internal/sandbox/nono/profile.go`,
  `worker/sandbox/profiles/communication-command.json`

## Context

A pipeline agent attempt in the lab (231fc7a) reported **every** Bash step as
failed. The transcript of claude-agent-acp's Bash tool inside nono:

```
find . -maxdepth 3 ... ; cat hello.py ...        status: failed
OUTPUT: List repo files ...  Exit code 1
/bin/bash: /etc/bash.bashrc: Permission denied
.  ./app  ./app/README.md     (the command's own output still printed)
```

Reproduced without the lab, in `communication-worker:dev` under the exact
`communication-agent` profile bytes `WriteProfile` builds (grant set = one
`--allow` workspace HOME, launcher HOME outside every grant, `nono 0.80.0`):

```
$ printf "echo hi\n" | HOME=/tmp/lhome nono run -s -p <agent-profile> --allow /tmp/work/home -- env HOME=/tmp/work/home /bin/bash -i
bash: cannot set terminal process group (1): Inappropriate ioctl for device
bash: no job control in this shell
bash: /etc/bash.bashrc: Permission denied
...
$ HOME=/tmp/lhome nono run -s -p <agent-profile> --allow /tmp/work/home -- env HOME=/tmp/work/home /bin/bash -lc "echo hi"
bash: /etc/profile: Permission denied
hi
```

(The two job-control lines are pty artifacts, not sandbox denials: unsandboxed
`printf "echo hi\n" | /bin/bash -i` in the same image prints them too.)

Mechanism: the agent harness keeps a persistent shell, and Debian's bash reads
`/etc/bash.bashrc` at interactive startup and `/etc/profile` at login startup.
Landlock denies reads by omission, and nono's `system_read_linux_core` group
names a fixed `/etc` list (observed via `nono profile groups
system_read_linux_core` in the image: `passwd`, `group`, `nsswitch.conf`,
`hosts`, `ld.so.*`, TLS dirs…) that contains **neither** shell file. The
denials land on stderr of every shell invocation the agent runs, so implement
and test steps — which are shell steps — all look broken. This is a
security-boundary change (a new standing filesystem grant inside ADR-0019's
sandbox), so it needs an ADR regardless of diff size.

## Options considered

| Option | Advantages | Disadvantages | Evidence |
|---|---|---|---|
| A — grant `/etc` read-only | One line, never fails again | Hands the sandbox every system configuration file; the profile's own comment calls this exactly what it must not be. Rejected by the C-GITCFG precedent ("the grant is the exact file, never the directory") | `internal/sandbox/nono/profile.go` |
| B — tell the harness to run `bash --norc --noprofile` / unset `BASH_ENV` | No new grant | The shell is started inside the proprietary `claude` binary shipped by `@agentclientprotocol/claude-agent-acp`; a grep of the adapter tree in the worker image finds no shell-startup configuration surface (no `--norc`/`BASH_ENV`/`--rcfile` knob), and `BASH_ENV` does not suppress interactive startup files anyway. Not available, not guessed at | `grep -rl "norc\|BASH_ENV\|rcfile"` over `/usr/local/lib/node_modules/@agentclientprotocol/` inside `communication-worker:dev` |
| C — `--read /etc/bash.bashrc` as a per-launch CLI flag | Fits ADR-0026's ToolReads shape | nono 0.80.0's CLI refuses single files on `--read` ("CLI path '/etc/bash.bashrc' is not a directory. Use --allow-file for single files"), and these are host infrastructure, not per-run paths — a `[user]` grant would break N-d's exact-set equality on hosts that lack the file (C-HOSTGRP's lesson) | observed live in the repro, above |
| **D — add the exact files to the profile's `filesystem.read_file` (chosen)** | Exactly the mechanism probe C-GITCFG established for `/etc/gitconfig`; static, host-independent, `[profile]`-tagged, pinned by `AssertOwnBytes`' closed list; read level is structural (`read_file` cannot express write) | A standing grant in every profile kind (agent-turn, egress-denied, command) — accepted: the same shell starts under all three | § Decision |

## Decision

**Option D.** `systemConfigReads` becomes exactly

```go
{"/etc/gitconfig", "/etc/bash.bashrc", "/etc/profile"}
```

which `profileBody` emits as `filesystem.read_file` for **all three** profile
kinds. `profileVersion` **3.2.0 → 3.3.0** (every recorded policy digest from
here on names the new revision; the shipped asset was regenerated from
`ProfileJSON`, never hand-edited — `TestShippedCommandProfileAssetIsTheAuthoredBytes`).

What stays denied, measured in the same container run: `/etc/shadow`
(`Permission denied`, exit 1), appending to `/etc/bash.bashrc`
(`tee: Permission denied`, exit 1), `/etc` as a directory grant (refused by
nono's CLI and by `AssertOwnBytes`, which rejects any `read_file` entry outside
the pinned list). `/etc/inputrc` was probed and deliberately **not** added: it
does not exist in the pinned worker image, and bash skips an absent startup
file silently — the list only grows on new evidence. `nsswitch.conf` and
`/etc/passwd` need no grant: `system_read_linux_core` already names them.

## Consequences

- Positive: agent Bash steps start clean — interactive and login shells print
  no startup-file error under the shipped profile (literal before/after in
  `docs/compatibility/SANDBOX.md`'s C-BASHRC addendum).
- Positive: content of both files is static distro config readable by any user
  already outside the sandbox; the grant adds no *secret*, only removes noise.
- Limitation: world-readable-but-sensitive-by-cataloguing files (an org that
  puts flags in `/etc/bash.bashrc`) become readable in the sandbox. Accepted —
  the deny_* groups still gate the known-sensitive paths.
- Operational: the harness's exit-1 attribution in the original transcript
  could not be reproduced (every repro shape exited 0 on `echo hi` in the
  image); what is proven is the denial and its stderr pollution on every shell
  step. If a shell step still reports failure after this, that is a different
  bug and needs its own evidence.

## Security/privacy

Two exact files, read level only, pinned in code and re-asserted byte-for-byte
by `AssertOwnBytes` before every launch: dropping either entry, adding any
other file, or naming `/etc` refuses the launch (`sandbox: ... not on this
adapter's read-only system-file contract`). `filesystem.read_file` is not
expressible at write level, and `TestEveryProfileKindCarriesTheShellStartupReads`
asserts no startup file ever appears in `write_file`. N-d is unchanged: these
rules are `[profile]`-tagged like the device re-grants, and the per-run `[user]`
exact-set equality still measures only what the launcher computes.

## Verification

- `communication-worker:dev` repro, `nono 0.80.0`, before/after with literal
  outputs: `docs/compatibility/SANDBOX.md` § "C-BASHRC addendum".
- `TestShellStartupFilesAreReadableInsideTheSandbox` (live lab): interactive
  and login `/bin/bash` under the shipped agent-turn profile print no
  `Permission denied`, plus a negative control — the same bash under the same
  policy with `read_file` stripped still reproduces
  `bash: /etc/bash.bashrc: Permission denied`, so the green is the grant, not
  the host.
- `TestSystemGitConfigIsReadableInsideTheSandbox` /
  `TestSandboxDeniesTheSystemGitConfigWithoutTheGrant` now iterate
  `SystemConfigReads()`, i.e. they measure the new files the same way they
  measure `/etc/gitconfig` on hosts that ship them.
- `TestSystemConfigReadsIsThePinnedFileSet` /
  `TestAssertOwnBytesRefusesEtcWholesaleAndUnpinnedFiles`: builder-level pins.

## Migration/rollback

- **Upgrade:** none — the behaviour arrives with the binary and the
  regenerated asset; no schema, no API, no restart ordering.
- **Rollback:** revert this change; the shell startup files return to
  present-but-unreadable and agent Bash steps return to stderr noise. Nothing
  else depended on their absence.
