# ADR-0009 — nono `required` mode is verify-then-run, never policy delegation

- **Date:** 2026-10-14
- **Status:** **Proposed** (acceptance requires the unexercised items under Verification)
- **Owners:** project owner
- **Related decisions / contracts:** D-011 (**Provisional**), D-021 (**Provisional**), D-025
  (**Open**), ADR-0003 (refines it, supersedes nothing), `communication-spec/05-workspaces-security-secrets.md`
  § "Sandbox backend — nono first prototype" / "Trust caveat", `SandboxPolicy`/`SandboxCapabilities`
  (05, 09). Evidence: `docs/compatibility/SANDBOX.md`, `docs/compatibility/probes/sandbox/`.

## Context

05 defines three enforcement modes and says `required` is "the only mode acceptable for production
security claims": it must abort when filesystem/network/IPC guarantees cannot be verified. D-011 and
D-021 are Provisional pending test. The M0 probe (2026-10-14, nono `0.80.0`, binary sha256
`e02d003d…eff1287d`, host Arch Linux kernel `7.2.9-arch1-1`, uid 1000, Landlock ABI **V6**, plus
`debian:trixie-slim` on Docker 29.9.0) answers the actual question: *when nono says it restricted a
child, is the restriction enforced, and does nono refuse to run when it cannot enforce?*

Enforcement was largely real: C2/C3/C4/C5/C8 filesystem denials returned `EACCES` at the syscall level
including symlink and `..` traversal and `sh -c` grandchildren; C6 egress denied; C9 `/proc/1/environ`
denied; C10 proves the fixture read is otherwise possible. Fail-closed behaviour exists where nono
controls startup: FC1 exit 1 with the child never exec'd, FC6 invalid policy exit 2, FC5 dead upstream
→ `CONNECT tunnel failed, response 502`, FC4 honest capability report. But three results break the
"trust the exit code" model: **FC2 FAIL** — with `--sandbox-policy external`, `--block-net` was
silently ignored and egress succeeded (exit 0, host and both container runs); **C7 FAIL** — AF_UNIX
mediation is off by default and the sandboxed child read the Docker engine version over
`/var/run/docker.sock`; **C9b FAIL** — `ls /proc/1/` still lists 19+ entries. FC3 shows a nonexistent
grant path is ignored silently, and the built-in `default` profile (48 sensitive-path denies,
`system_read_linux_core` grants) is always layered in, so CLI flags do not describe the policy.

## Options considered

| Option | Advantages | Disadvantages | Evidence |
|---|---|---|---|
| A. Trust the nono exit code / flags as proof of `required` | No adapter state machine; cheapest | Directly falsified: FC2 honoured-by-configuration while unenforced; FC3 drops a mistyped grant silently; `default` profile silently mixed in | SANDBOX.md FC2 **FAIL**, FC3, "The default profile is always mixed in" |
| **B (selected).** **Verify-then-run**: probe, then assert the *resolved* policy, then exec — with a Communication-owned nono profile, and no `external` policy | Aborts on the failure modes we observed instead of reporting success; policy is one auditable file; per-run evidence goes into `SandboxCapabilities` | Two nono invocations per attempt (startup cost); any gap found (C7/C9b) becomes our config obligation, so some environments must refuse `required` until fixed | SANDBOX.md "Implications for `required` mode"; FC1/FC4/FC6 show nono can fail closed at startup; C7 remedy observed (AF_UNIX pathname mediation profile closed it) |
| C. Outer OCI/VM isolation only, no nono in `required` | Stronger boundary; matches nono's own guidance to keep AF_UNIX off only "inside a stronger outer boundary such as a MicroVM" | Does not answer D-011 (nono prototype), heavier deployment model, and loses per-agent workspace grants; 05 still requires child-process sandboxing inside the container | SANDBOX.md C7 observation + Landlock notes; ADR-0003 alternative D; 05 "Trust caveat" |
| D. `required` = flags + resolved-profile assert but AF_UNIX left at default | Runs everywhere the probe ran; zero new config | Reopens the root-equivalent Docker-socket path (C7) that the probe demonstrated end-to-end | SANDBOX.md "C7 fell open, and it is a default, not a bug"; "most consequential open default found" |

## Decision

Option **B**, as the definition of `required`:

1. **Probe**: `nono setup --check-only` (FC4-class capability report) and `nono run --dry-run` against
   the attempt's actual policy. Any non-zero or missing Landlock result aborts the attempt.
2. **Assert the resolved policy** before exec — grants, denies, `sandbox_policy`, `af_unix_mediation`,
   `process_info_mode` — via `nono profile show`/`nono why`, and abort on mismatch with the
   `SandboxPolicy` the run was scheduled with. Never infer policy from CLI flags.
3. **Never pass `--sandbox-policy external`** (or accept any delegation) in `required` unless the
   worker proved the outer boundary in the same run, and record which layer denied what (FC2).
4. **Ship a Communication-owned nono profile** passed with `-p <path>` that sets
   `linux.af_unix_mediation = "pathname"` and keeps `process_info_mode: isolated`. Where a Docker or
   Podman socket is reachable and mediation cannot be enabled, **deny the run** rather than start.
5. **Grants are validated by the adapter**: a nonexistent grant path is a configuration error (FC3),
   and `filesystem.deny` is treated as point-in-time only — protection against later-created paths
   comes from absence of a grant, never from a deny rule.
6. **Egress** in `required` = kernel TCP denial **plus** the nono-started proxy on an OS-assigned port
   (never a fixed/privileged `--proxy-port`), recorded per D-021.
7. `permissive-dev` and `disabled` remain available but must be labelled in every event (05), and no
   `required` claim may be made from a run that took them.

## Consequences

- Positive: the mode that carries security claims is defined by observed behaviour, and FC2/FC3-style
  silent degradation becomes an abort rather than a false guarantee.
- Positive: policy lives in a versioned profile file, so a run's sandbox is reproducible and reviewable.
- Cost: one extra nono invocation per attempt and adapter code to diff resolved policy against intent.
- Limitation: some hosts will simply not qualify — the no-Landlock kernel branch was never observed
  aborting (no way to disable Landlock without sudo), so "abort when the kernel lacks it" is designed,
  not proven.
- Limitation: C7/C9b mean `required` is stricter than nono's defaults; until the profile in Decision 4
  is exercised, the M0 gate for `required` carries an explicit **GAP** (rootless Podman untested;
  container variant with the socket mounted untested).

## Security/privacy

**These results do not establish tenant isolation** (SANDBOX.md "These results do NOT establish tenant
isolation"; 05 "Trust caveat"; D-025 **Open**): everything probed ran as one Unix user (uid 1000),
sharing the host PID view, host `/proc`/`/sys` metadata, `/var/run/docker.sock` (C7) and any credential
readable by that uid at sandbox start. Landlock is not a separate kernel boundary and nono's SECURITY.md
does not recommend production reliance. Mutually untrusted projects need distinct Unix identities or an
OCI/VM boundary; this ADR only makes the nono layer honest. C9b (process *existence and layout*
visible) is an information leak about the host, not a write. Fail-open cases are enumerated above
(FC2/FC3/C7/C9b); everything else observed failed closed. Landlock restrictions are applied only to
child processes — never the worker process (05).

## Verification

Observed 2026-10-14 (`bash probes/sandbox/run.sh` → `results-host.txt`; Docker run →
`results-docker.txt`; `--security-opt seccomp=unconfined` extra run showed no difference in any case):
C1–C6, C8–C10 as in the matrix (C7 **FAIL**, C9b **FAIL**), FC1/FC3/FC4/FC5/FC6 PASS, FC2 **FAIL**;
Landlock ABI V6 on host and container, `--sandbox-policy landlock` enforcing filesystem and TCP under
Docker's builtin seccomp. The C7 remedy — a profile with `linux.af_unix_mediation: "pathname"`, which
closed the socket without granting it — is recorded as observed in SANDBOX.md's C7 observation.

Not tested, and this ADR stays Proposed until each has a probe check: rootless Podman (row = GAP; not
installed, setup needs sudo); the "kernel feature missing" abort branch; a container that *mounts* the
Docker socket; `nono run --dry-run` as an enforcement assertion (named in SANDBOX.md's implications,
never run in the probe — only `nono setup --check-only` was, as FC4); the Communication-owned profile of
Decision 4 applied end-to-end; inherited FDs and terminal helpers beyond C8; `nono audit`/`logs` as an
evidence source; NPM/ACP launch compatibility under the sandbox; Windows/macOS.

## Migration/rollback

Rolling forward is additive: the adapter gains a verify stage and a profile path; runs that fail either
are recorded as aborted with the mismatch in `SandboxCapabilities`, so no historical data changes.
If verification proves too strict in practice, the rollback is *not* to Option A (exit-code trust) but
to explicitly labelled `permissive-dev`/`disabled` (05), which keeps the security claim honest while
the gaps are closed. Replacing nono (bubblewrap was present on the lab host but **not tested**, ADR-0003
alternative B; or OCI per-run isolation) changes only the `SandboxLauncher` adapter behind the same
`SandboxPolicy`/`SandboxCapabilities` contract; the verify-then-run requirement and this matrix transfer
unchanged to the replacement.
