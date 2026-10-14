# M0 sandbox probe — nono enforcement (host + Docker)

Reproducible enforcement test for the **Provisional / Spike required** sandbox
decision (D-011, D-021, ADR-0003). It answers one question with observed
evidence: *when nono says it restricted a child process, is the restriction
actually enforced?* and *does nono refuse to run when it cannot enforce?*

Result words used everywhere: `PASS` (observed, matched expectation),
`FAIL` (observed, did not match), `GAP` (could not test), `N/A` (precondition
absent). Never `PASS` by inference.

## Layout

| File | Contents |
| --- | --- |
| `run.sh` | The probe. Writes `CASE <id> <verdict> <observed>` lines only (plus an `ENV` header). |
| `results-host.txt` | Raw output of the host run. |
| `results-docker.txt` | Raw output of the main Docker run (default seccomp). |
| `../..` → `docs/compatibility/SANDBOX.md` | The capability matrix distilled from these two files. |

## Install (pinned, no sudo)

```bash
mkdir -p "$HOME/.local/share/communication-lab/nono/0.80.0"
cd "$HOME/.cache/communication-lab/m0-nono"
curl -sSfL -O https://github.com/nolabs-ai/nono/releases/download/v0.80.0/nono-v0.80.0-x86_64-unknown-linux-gnu.tar.gz \
       -O https://github.com/nolabs-ai/nono/releases/download/v0.80.0/SHA256SUMS.txt
sha256sum -c --ignore-missing SHA256SUMS.txt          # -> ...x86_64-unknown-linux-gnu.tar.gz: OK
tar -xzf nono-v0.80.0-x86_64-unknown-linux-gnu.tar.gz \
    -C "$HOME/.local/share/communication-lab/nono/0.80.0"
ln -sf "$HOME/.local/share/communication-lab/nono/0.80.0/nono" "$HOME/.local/bin/nono"
nono --version                                         # -> nono 0.80.0
```

* `nono --version` → `nono 0.80.0`
* tarball sha256 verified against the published `SHA256SUMS.txt`
  (`6da665b61999570c10dffc7da78828fe1fb7f3cac53319e505cebecaef17037f`)
* binary sha256 (`$HOME/.local/share/communication-lab/nono/0.80.0/nono`) →
  `e02d003d52b3f65e8c75358eb73e339ad952a2876529047e61183b46eff1287d`
* scratch/fixture data lives in `$HOME/.cache/communication-lab/m0-nono/`, never in the repo.

## nono CLI surface actually used

Learned from `nono --help`, `nono run --help`, `nono setup --help`,
`nono profile --help`, `nono profile schema`, `nono why --help`.

The policy under test is expressed with these flags:

```bash
nono run -s \
  --allow   "$FIXTURE/projA" \        # read+write, recursive — the only workspace grant
  --block-net \                       # kernel-level outbound block (Landlock TCP / seccomp baseline)
  -- sh -c "cat $FIXTURE/projB/secret.txt"
```

* `--allow <DIR>` read+write (recursive); `--read <DIR>` read-only;
  `--write <DIR>` write-only; `--allow-file`/`--read-file`/`--write-file` for
  single files.
* **"Deny everything else" is not a flag.** Landlock rulesets are allowlists, so
  omission *is* the deny. Explicit covering denies exist only in profiles
  (`filesystem.deny`, and `deny_credentials`/`deny_shell_configs` groups which
  nono applies by default — 48 sensitive paths), and on Linux a deny only covers
  paths that existed when the sandbox started.
* `--block-net` blocks outbound network; `--allow-domain`, `--deny-domain`,
  `--upstream-proxy`, `--proxy-port` switch to the filtering credential proxy.
* `--allow-unix-socket <path>` / `--allow-unix-socket-dir|-subtree` grant
  `connect()`; pathname AF_UNIX mediation is **off by default** and is enabled
  only by the profile key `linux.af_unix_mediation = "pathname"`.
* `--sandbox-policy auto|landlock|external` selects the enforcement mechanism.
* Non-interactive gotcha: with `-s` a working directory outside the grants makes
  nono exit 1 (`CWD access requires --allow-cwd`), so `run.sh` always `cd`s into
  `projA` and passes absolute paths; `--allow-cwd` is deliberately *not* used
  because the CWD is the fixture parent.

Built-in status/reporting commands (the "actual nono status" the spec asks for):

```bash
nono setup --check-only -v   # kernel + Landlock ABI + default-protection report (see below)
nono profile show default    # resolved profile (groups: deny_credentials, system_read_linux_core, …)
nono profile groups          # 31 policy groups
nono why --path X --op read  # static verdict: DENIED path_not_granted
nono why --host example.com  # static verdict: ALLOWED network_allowed
nono ps / nono inspect / nono logs / nono audit   # session state and audit trail
```

`nono setup --check-only -v` on the host (abridged; FC4 in each results file carries the one-line version of the same report):

```text
nono v0.80.0
[2/4] Testing sandbox support...
  * Kernel version: 7.2.9-arch1-1
  * Landlock enabled (syscall probe)
  * Landlock V6
  * Available features:
      - Basic filesystem access control
      - File rename across directories (Refer)
      - File truncation (Truncate)
      - TCP network filtering
      - Device ioctl filtering
      - Signal and abstract UNIX socket scoping
  * Linux AF_UNIX mediation: off by default
    - For stricter IPC isolation, set linux.af_unix_mediation = "pathname"
    - Then grant required pathname sockets with filesystem.unix_socket entries
    - In public-facing or privacy-sensitive deployments that keep it off, run
      nono inside a stronger outer boundary such as a MicroVM
  * Filesystem ruleset creation verified
  * TCP network rule support verified

[3/4] Default protections...
  * 48 sensitive paths blocked by default: SSH keys, AWS/GCP/Azure credentials,
    Kubernetes config, Docker config, GPG keys, password managers, shell configs
  * 46 dangerous commands blocked by default: apt, apt-get, chattr, chgrp,
    chmod, chown, cp, dd, ...
  * Network access: allowed by default (use --block-net to disable)

Installation verified!
```

The same probe inside `debian:trixie-slim` on Docker 29.9.0 reported the **host
kernel** (7.2.9-arch1-1), **Landlock V6**, "Filesystem ruleset creation
verified" and "TCP network rule support verified" — i.e. Landlock survives the
default (`profile=builtin`) Docker seccomp filter on this engine.

## Running

Host:

```bash
bash docs/compatibility/probes/sandbox/run.sh > docs/compatibility/probes/sandbox/results-host.txt 2>&1
```

Docker (default seccomp, no `--privileged`, unmodified image + curl):

```bash
docker run --rm \
  -v "$HOME/.local/share/communication-lab/nono/0.80.0":/opt/nono:ro \
  -v "$PWD/docs/compatibility/probes/sandbox":/probe:ro \
  debian:trixie-slim bash -c 'apt-get update -qq && apt-get install -y -qq curl ca-certificates >/dev/null \
    && bash /probe/run.sh --nono /opt/nono/nono --fixture /root/fixture' \
  > docs/compatibility/probes/sandbox/results-docker.txt 2>&1
```

`run.sh` accepts `--nono <path>`, `--fixture <dir>`, `--socket <path>` (default
`/var/run/docker.sock`) and `--keep` (leave the fixture in place for
inspection; without it the fixture tree is deleted at the end). It always exits
0 — a recorded `FAIL`/`GAP` is a result, not a script error.

## Cases

| id | action inside the sandbox | expected enforcement |
| --- | --- | --- |
| C1 | write `projA/out.txt` | allowed |
| C2 | read `projB/secret.txt` (another project's checkout) | denied |
| C3 | read `fake-home/.ssh/id_test` (fake credential) | denied |
| C4 | read `projA/link` → `../projB/secret.txt`, symlink created *outside* the sandbox | denied |
| C5 | read `projA/../projB/secret.txt` | denied |
| C6 | `curl -sS --max-time 5 https://example.com` | denied |
| C7 | `curl --unix-socket /var/run/docker.sock http://localhost/version` | denied |
| C8 | grandchild: `sh -c 'sh -c "cat projB/secret.txt"'` | denied (inheritance) |
| C9 | `cat /proc/1/environ` | denied |
| C9b | `ls /proc/1/` (informational, not in the brief's matrix) | recorded either way |
| C10 | control: read `projB/secret.txt` **without** nono | allowed (fixture proves the read is otherwise possible) |
| FC1 | `--allow-domain` network policy whose proxy cannot bind (`--proxy-port 1`) | nono must refuse to run the command |
| FC2 | `--block-net` **with** `--sandbox-policy external` | must not silently leave egress open |
| FC3 | `--allow <path that does not exist>` | must not silently drop the sandbox |
| FC4 | `nono setup --check-only` | kernel/capability probe must be honest |
| FC5 | `--allow-domain` + `--upstream-proxy 127.0.0.1:9` (dead upstream) | egress denied, never permitted outside policy |
| FC6 | unsatisfiable policy value (`--proxy-port 65536`) | refuse to launch |

FC1 needs two non-obvious things: `--block-net` and `--allow-domain` are
mutually exclusive (`Configuration parse error`), so the proxy cases run without
`--block-net`; and as uid 0 the bind of port 1 *succeeds*, so the "cannot bind"
precondition does not exist inside the container and FC1 reports `N/A` there
rather than inventing a verdict.

## Extra Docker run: `--security-opt seccomp=unconfined`

One additional run was made with `--security-opt seccomp=unconfined` (all other
flags identical). **Verdict: no difference in any case** — C1–C10, FC2–FC6
produced the same result words, and `--sandbox-policy landlock` (Landlock-only,
no seccomp fallback) also enforced both filesystem and TCP in the container:

```text
CASE C6 PASS exit=6 curl: (6) Could not resolve host: example.com
CASE C7 GAP socket /var/run/docker.sock not present in this environment
CASE FC1 N/A precondition not met: uid=0 could bind proxy port 1, ...
== EXTRA: sandbox-policy=landlock TCP probe (uid 0)
RC=7 OBS=curl: (7) Failed to connect to example.com port 443 after 1 ms: Could not connect to server
RC2=1 OBS2=cat: /root/fixture2/projB/secret.txt: Permission denied
```

Conclusion for the matrix: on Docker 29.9.0 with the builtin seccomp profile,
Landlock (ABI V6) is available and `--sandbox-policy landlock` is usable, so
`required` mode does not need `seccomp=unconfined` on this engine. The reason
C7 is `GAP` in both container runs is that `/var/run/docker.sock` is not mounted
into the container — the socket exposure question is answered by the host run,
and a container that *does* mount the docker socket inherits that exposure.

## nono behaviour worth remembering when writing the adapter

* nono applies its `default` profile even when you pass only CLI flags; the
  48 deny paths and `system_read_linux_core` grants are always in the mix, so a
  "deny everything else" policy is never a bare allowlist.
* Missing/nonexistent grant paths are silently ignored (FC3): the sandbox still
  applies, just without that grant. A typo in a workspace path therefore shows
  up as unexplained `EACCES` at runtime, not as a startup error.
* Startup failures (`Sandbox initialization failed`, argument validation) exit
  non-zero **and do not exec the child** — verified by checking that the
  in-sandbox marker file was never created (FC1/FC6).
* `--sandbox-policy external` is a documented opt-out of TCP enforcement and
  produces **no warning** while `--block-net` is still requested (FC2). Any
  `required` implementation must therefore validate the resolved policy, not
  just the exit status.
