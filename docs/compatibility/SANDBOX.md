# Sandbox capability matrix

Observed behaviour of the first prototype sandbox backend (nono / Linux
Landlock) against `communication-spec/05-workspaces-security-secrets.md`
("Sandbox backend — nono first prototype", "First security acceptance gate")
and `communication-spec/adr/ADR-0003-sandbox-prototype.md`. Nothing here is
inferred: every cell comes from a `CASE` line in the two results files.

## Provenance

| Item | Value |
| --- | --- |
| Date | 2026-10-14 |
| Host kernel | `7.2.9-arch1-1` (Arch Linux, x86_64) |
| Active LSMs | `capability,landlock,lockdown,yama,bpf` (`/sys/kernel/security/lsm`) |
| Landlock ABI (nono's probe) | **V6** — filesystem, Refer, Truncate, TCP, ioctl, signal + abstract-UNIX-socket scoping |
| nono version | `nono 0.80.0` (`nono --version`) |
| nono binary sha256 | `e02d003d52b3f65e8c75358eb73e339ad952a2876529047e61183b46eff1287d` |
| nono tarball sha256 | `6da665b61999570c10dffc7da78828fe1fb7f3cac53319e505cebecaef17037f` (verified against published `SHA256SUMS.txt`) |
| nono install path | `$HOME/.local/share/communication-lab/nono/0.80.0/nono` → symlink `$HOME/.local/bin/nono` |
| Docker | client/server `29.9.0`, `linux/amd64`, seccomp `profile=builtin`, cgroup v2 + `cgroupns`, containerd snapshotter |
| Container image | `debian:trixie-slim` + `curl`, `ca-certificates` |
| Run user | host: `david` (uid 1000, non-root); container: `root` (uid 0) |
| Policy under test | `--allow <fixture>/projA` (rw) only, `--block-net`; everything else denied by omission |
| Probe | `docs/compatibility/probes/sandbox/run.sh` (see its `README.md` for exact flags) |

Rerun:

```bash
bash docs/compatibility/probes/sandbox/run.sh > docs/compatibility/probes/sandbox/results-host.txt 2>&1
docker run --rm \
  -v "$HOME/.local/share/communication-lab/nono/0.80.0":/opt/nono:ro \
  -v "$PWD/docs/compatibility/probes/sandbox":/probe:ro \
  debian:trixie-slim bash -c 'apt-get update -qq && apt-get install -y -qq curl ca-certificates >/dev/null \
    && bash /probe/run.sh --nono /opt/nono/nono --fixture /root/fixture' \
  > docs/compatibility/probes/sandbox/results-docker.txt 2>&1
```

## Matrix

`C9b` is the informational sibling of C9 (`ls /proc/1/`). `Fail-closed`
summarises FC1/FC5/FC6 (policy that cannot be established) and FC2
(`--sandbox-policy external`).

| Environment | C1 | C2 | C3 | C4 | C5 | C6 | C7 | C8 | C9 | C9b | C10 | Fail-closed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Host (Arch, kernel 7.2.9, uid 1000) | PASS | PASS | PASS | PASS | PASS | PASS | **FAIL** | PASS | PASS | **FAIL** | PASS | **PASS** — FC1 exit 1, child never exec'd; FC6 exit 2; FC5 egress denied (502) |
| Docker 29.9.0 default seccomp (`profile=builtin`) | PASS | PASS | PASS | PASS | PASS | PASS | GAP¹ | PASS | PASS | **FAIL** | PASS | **PASS for FC5/FC6**; FC1 **N/A**²; **FAIL** FC2 |
| Docker 29.9.0 `--security-opt seccomp=unconfined` | PASS | PASS | PASS | PASS | PASS | PASS | GAP¹ | PASS | PASS | **FAIL** | PASS | same as default seccomp (FC5/FC6 PASS, FC2 FAIL, FC1 N/A²) |
| Rootless Podman | GAP | GAP | GAP | GAP | GAP | GAP | GAP | GAP | GAP | GAP | GAP | GAP³ |

¹ `/var/run/docker.sock` is not present inside the container, so there was no
socket to connect to — the probe refuses to call that a PASS. The host row is the
authoritative answer for C7.
² FC1 induces failure by asking the network proxy to bind privileged port 1; as
uid 0 that bind **succeeds**, so the precondition does not exist in the container.
³ `podman` is not installed on this host and rootless setup needs sudo, which this
spike may not use. Untested, not assumed.

## Observations

* **Landlock ABI V6 on both host and container.** nono's own probe reports
  "Landlock enabled (syscall probe)", "Filesystem ruleset creation verified" and
  "TCP network rule support verified"; Docker 29.9.0's builtin seccomp profile
  does **not** block the Landlock syscalls. `--sandbox-policy landlock`
  (Landlock only, no seccomp fallback) enforced filesystem *and* TCP inside the
  container, so `required` mode does not need `seccomp=unconfined` here.
* **Filesystem enforcement is solid and inheritance-safe.** C2/C3/C4/C5/C8 all
  produced `EACCES` at the syscall level (the child exits 1, content never
  reaches stdout). Symlink escape (C4) and `..` traversal (C5) are both closed
  because Landlock mediates by resolved inode/path, not by the string the caller
  used. Restrictions survive `sh -c` grandchildren (C8).
* **Network blocking is not one mechanism.** `--block-net` on ABI V6 is kernel
  Landlock TCP filtering plus a seccomp baseline; domain allow/deny
  (`--allow-domain`, `--deny-domain`, `--upstream-proxy`) is a *userland MITM
  proxy* in supervised mode, which requires the proxy to start and requires the
  target to honour `HTTPS_PROXY`/CONNECT. In the container, C6 failed at DNS
  (`Could not resolve host`, exit 6) while on the host it failed at connect
  (exit 7) — different observable, same denial.
* **Which restriction is which layer:** filesystem grants + denies, `/proc`
  reads and socket-file *reads* → Landlock rules. Outbound TCP → Landlock TCP
  rules (V4+) with a seccomp fallback. Domain filtering / credential injection →
  userland proxy only. AF_UNIX `connect()` → **nothing by default**.
* **C7 fell open, and it is a default, not a bug.** nono reports "Linux AF_UNIX
  mediation: off by default". With the briefed policy, the sandboxed child read
  the Docker engine version over `/var/run/docker.sock` (exit 0, full JSON).
  Adding a profile with `{"extends":"default","linux":{"af_unix_mediation":"pathname"}}`
  closed it (`curl: (7) ... Could not connect`, exit 7) without granting the
  socket. nono's own guidance says the same thing: keep it off only "inside a
  stronger outer boundary such as a MicroVM". A reachable Docker socket is a
  root-equivalent escape, so this is the most consequential open default found.
* **C9b fell open.** Reading another process's `/proc/1/environ` is denied
  (`security.process_info_mode` defaults to `isolated`), but `ls /proc/1/` still
  lists all 19+ entries and non-default grants (`system_read_linux_core`,
  `linux_sysfs_read`) expose host-wide `/proc` and `/sys` metadata. Process
  *contents* are gated; process *existence and layout* are not.
* **Deny rules are point-in-time on Linux.** `filesystem.deny` "only covers
  paths present at start time" (macOS gets a runtime regex rule). Anything
  created after the sandbox starts — including a symlink planted to a later
  secret path, or a `.env` materialized by a helper — is not covered by a deny,
  only by the absence of a grant.
* **The default profile is always mixed in.** `nono run --allow X` still layers
  `default` (48 sensitive-path denies, `system_read_linux_core` read grants,
  `dangerous_commands` blocklist incl. `cp`/`chmod`/`apt-get`). Reproducing a
  policy therefore requires the resolved profile (`nono profile show`), not the
  CLI flags.
* **Silent degradations.** A nonexistent grant path is ignored with no error
  (FC3), and `--sandbox-policy external` drops nono's own TCP lockdown with no
  warning even though `--block-net` was requested (FC2 — egress succeeded, exit
  0, in host and both container runs).
* **Fail-closed behaviour is real where nono controls startup**: when the proxy
  could not bind, nono exited 1 and the child was *never exec'd* (verified by the
  absence of the in-sandbox marker file); invalid policy values exit 2 before
  exec; a dead `--upstream-proxy` yields `CONNECT tunnel failed, response 502`
  rather than a direct route. We could **not** test the "kernel feature missing"
  branch (no way to disable Landlock without sudo), so that path is unverified.
* **These results do NOT establish tenant isolation.** Per 05 "Trust caveat":
  everything sandboxed here still runs as one Unix user, shares the host PID
  namespace view, host `/proc`/`/sys` metadata, the host's `/var/run/docker.sock`
  (see C7), and any credential readable by uid 1000 at sandbox start. Landlock is
  not a separate kernel boundary and nono's SECURITY.md does not recommend
  production reliance. Two mutually untrusted client projects still need distinct
  Unix identities / OCI or VM boundaries. nono is an additional layer, not a
  certification of tenant safety.
* `bwrap` (bubblewrap) is present on this host and is the ADR-0003 alternative B
  for a later comparison run. **It was not tested in this spike.**

## Implications for `required` mode

* `required` must be a **verify-then-run** sequence, not a flag: probe
  (`nono setup --check-only`, `nono run --dry-run`), then assert the *resolved*
  profile (grants, denies, `af_unix_mediation`, `sandbox_policy`) before
  exec'ing the agent, and abort on any mismatch. Exit status alone is not proof —
  FC2 shows a policy that is honoured-by-configuration while being unenforced.
* Ship a Communication-owned nono profile rather than CLI flags: set
  `linux.af_unix_mediation = "pathname"` (C7), keep `process_info_mode: isolated`,
  and pass `-p <path>` so the policy is auditable and reproducible; the built-in
  `default` profile would otherwise be layered in silently.
* Never accept `--sandbox-policy external` (or any delegation) in `required`
  mode unless the worker itself proved the outer boundary (cgroup/namespace/OCI)
  in the same run, and record which layer denied what in the run's
  `SandboxCapabilities` evidence.
* Network egress for `required` needs kernel TCP denial *plus* the proxy, and the
  proxy must be started by nono with an OS-assigned port (`--proxy-port`
  fixed/privileged ports are an availability cliff and, as uid 0, silently bind
  anywhere). A missing/nonexistent grant must be treated as a configuration
  error at the adapter layer, since nono ignores it (FC3).
* `disabled` / `permissive-dev` runs must stay honestly labelled, and the M0
  acceptance gate for `required` should carry an explicit GAP until (a) rootless
  Podman is tested, (b) the no-Landlock kernel branch is observed to abort, and
  (c) a container variant that mounts the Docker socket is proven denied.
