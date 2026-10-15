# ADR-0019 — Launching the agent under nono in `required` mode from inside the worker container

- **Date:** 2026-10-15
- **Status:** **Proposed** (the chain is proven; network egress and the worker-image Landlock row are not)
- **Owners:** M3 implementation workers (worker runtime, sandbox adapter, UI ops page)
- **Related decisions / contracts:** D-011 (**Provisional**, nono first prototype, fail closed in required mode), D-021 (**Provisional**, strict network egress per execution), D-020 (**Accepted**, no default MCP/CLI privileges), D-025 (**Open**, trust model), ADR-0003 (prototype nono), **ADR-0009** (this record implements its Decision 1–7 as a concrete launch chain; it supersedes nothing), ADR-0008 (per-attempt isolated `HOME`), ADR-0016 (turn leases, permission modes, `preapproved_within_sandbox` left unused), ADR-0017 (which paths may appear in a policy), `communication-spec/05-workspaces-security-secrets.md` § "Sandbox backend — nono first prototype" / "First security acceptance gate", `communication-spec/04-agent-runtime.md` § "Agent launcher registry" / "Profile → environment → instance" / "Permission policy", `communication-spec/02-system-architecture.md` (worker launches sandboxed ACP subprocesses), `communication-spec/12-test-strategy.md` cases 13 and 15, `communication-spec/10-ui-design-handoff.md` ("Admin/Operations: workers, sandbox health"). Evidence: `docs/compatibility/SANDBOX.md`, `docs/compatibility/ACP.md` ("Worker container (M2…)"), `docs/compatibility/WORKSPACES.md`, and the M3 pre-contract probe recorded below.

## Context

`02` says the worker "launches sandboxed ACP/command subprocesses", and `05` defines `required` as the
only mode acceptable for production security claims: "abort when filesystem/network/IPC guarantees
cannot be verified". ADR-0009 decided *how* `required` must be implemented (probe, then assert the
resolved policy, never trust exit codes or CLI flags, ship a Communication-owned nono profile with
`linux.af_unix_mediation = "pathname"`, never `--sandbox-policy external`). What remains is the
concrete chain — who execs what, with which argv, with which HOME, holding which credentials, and
what a failure looks like in the journal — because M2's launch path has **no sandbox in it at all**
(`internal/agent/acp/runtime.go` does `exec.CommandContext(ctx, spec.Executable, spec.Args...)`, and
`internal/sandbox/nono.Launcher` is reached only by `communication doctor`; `domain.SandboxLauncher`
is nowhere in the turn loop).

Four facts make this harder than wrapping one argv:

1. **The adapter is not the harness.** `claude-agent-acp` / `codex-acp` are Node CLIs that spawn
   `claude` / `codex` themselves, which in turn spawn shells, tests and package managers. Landlock
   restrictions do inherit to descendants (SANDBOX.md C8), so the *policy* covers the whole tree — but
   every grant has to satisfy the deepest child, not the process we exec.
2. **Nono is not in the worker image.** `worker/Dockerfile` ships git, node, the pinned adapters and
   the harnesses; there is no `nono` line, and ADR-0007 puts sandbox policy files in `worker/`, not in
   the API image. SANDBOX.md's Docker rows ran `debian:trixie-slim` with nono bind-mounted from the
   host; the real worker image is `node:22-bookworm-slim`, which **has never been probed**.
3. **A real agent turn needs network.** Claude/Codex must reach their model APIs, so `--block-net`
   cannot be the profile every run uses — while case 13 and the M0 matrix's FC5/C6 need observed
   egress *denial*. Those are two different policies and pretending otherwise is how a security claim
   becomes a fiction.
4. **A real agent turn needs a HOME that is writable and a credential tree that is readable — by two
   conversations.** `compose.harness.yml` mounts `~/.claude` → `/harness/claude` and `~/.codex` →
   `/harness/codex` **read-write on purpose** ("these are the agents' live state directories … a
   read-only mount wedges the agent mid-turn"), and sets `HOME=/harness/home` because a numeric
   `--user` has no passwd entry. ADR-0008 separately proved APM writes `~/.apm/config.json` and
   `~/.cache/apm/` into whatever HOME it is given (T4 **FAIL**), which is why the per-attempt HOME
   exists.

And one finding from this contract's probe changes the shape of every policy below: with a single
`--allow <workspace>` grant and nothing else, a sandboxed child **wrote `/tmp/ninety-probe`** (file
observed on the host afterwards, content `x`) — while `/var/tmp`, `/dev/shm` and a read-granted
directory outside `/tmp` were all correctly denied. nono's always-layered `default` profile grants
`/tmp` write, so "denied by omission" is false there. A workspace, mirror, attempt HOME or materialized
secret placed under `/tmp` would be writable by any agent on the host (ADR-0017 Decision 5).

## Options considered

| Option | Advantages | Disadvantages | Evidence |
|---|---|---|---|
| A. Launch the ACP adapter directly and treat the harness's own sandbox as the boundary (`codex --sandbox workspace-write`, Claude permission modes) | Zero new moving parts; both harnesses' write-restriction was observed working (WORKSPACES.md H1/H2) | Not Communication's boundary at all: it is per-harness, differently semantic, unverifiable from our side, and Claude's is a *permission prompt* system that `permission_mode='ask'` already governs. 05's "auto-approving ACP prompts is not a substitute for sandbox isolation" forbids this reading | WORKSPACES.md H2 (`--sandbox workspace-write`); 05 § "Sandbox backend"; 04 § "Permission policy" |
| **B (selected).** Worker execs `nono run -s -p <Communication profile> <grants> -- <adapter argv>`, verify-then-run per ADR-0009, one policy per launched agent, network axis chosen per launcher | One boundary, ours, with per-run auditable grants and a resolved-policy assertion; Landlock inheritance covers the harness tree; the same `domain.SandboxLauncher` contract the doctor already exercises | Vendored nono in the worker image; per-attempt HOME must be *inside* the grants (P6); harness credential mounts must stay rw and are therefore shared; egress needs a second profile | ADR-0009 Decision 1–7; SANDBOX.md C8 (inheritance); ADR-0008 Decision 3; probe N1–N6 below |
| C. One OCI/Podman container per attempt as the sandbox, no nono in `required` | Real outer boundary: distinct mount namespace, distinct uid possible, answers D-025 rather than papering over it | Deployment model `02` does not describe (workers are long-lived processes, per-agent containers need an image, a socket, and privileged nesting); Landlock-in-Landlock nesting; and it still leaves 05's "SandboxLauncher starts child processes" contract unimplemented | SANDBOX.md "Implications" (`--sandbox-policy external` … "unless the worker itself proved the outer boundary"); ADR-0009 Option C; ADR-0003 alternative D |
| D. Apply Landlock in the worker process itself via a Go binding | No external binary, no argv | 05 forbids it in terms ("NEVER install irreversible Landlock restrictions in the main API/worker Go process") and the worker is long-lived and multi-project, so one grant would outlive its attempt | 05 § "Sandbox backend" |

## Decision

Option **B**, as a named chain and a named failure surface.

### 1. The launch chain

```
communication worker (internal/worker, unsandboxed — 05)
  → WorkspaceStore.Prepare                     ADR-0017: mirror, worktree, per-attempt home
  → SecretResolver.Materialize                 ADR-0018: env entries + env_file bytes, before exec
  → SandboxPolicy for this unit                from AgentProfileRevision.sandbox_policy_ref
  → Launcher.Probe + Launcher.Launch(required)
       exec nono run -s \                       (binary vendored in the worker image)
         -p /etc/communication/sandbox/communication-agent.json \
         --allow <workspace root>                          # repos/ + scratch/ + home/
         --allow <mirror>/objects \                        # only when commit is granted
         --allow <mirror>/refs/heads/<scope-id> \
         --allow <mirror>/logs/refs/heads/<scope-id> \
         --allow <mirror>/worktrees/<admin-id> \
         --read  <mirror> \                                # any git command needs this (P10)
         --read  <harness config dir> \                    # or --allow, see 4
         [--block-net] [--allow-domain …] [--proxy-port 0] \
         -- <adapter executable> <adapter argv…>
            └─ claude-agent-acp | codex-acp     (ACP over stdio pipes — unchanged)
                 └─ claude | codex              (Landlock restrictions inherit; C8)
                      └─ sh -c "<tests, tools>"
```

`cmd.Dir` is the workspace root, which is inside `--allow` (nono exits 1 in non-interactive mode
otherwise — the reason `internal/sandbox/nono/launcher.go` already has `requireDirInsideReadWrite`).
`spec.Env` is built explicitly rather than inherited (`runtime.go` falls back to `os.Environ()`, which
would hand the agent the worker's whole environment, including `COMMUNICATION_DATABASE_URL`): the
worker passes `PATH`, `HOME=<workspace>/home`, `XDG_*` under that HOME, `GIT_*` identity, the harness
config variable, and the `env`-mode secret entries — nothing else. The DB URL never reaches a child.

### 2. `required` is the ADR-0009 sequence, with the assertions that actually work

| Step | Command (observed behaviour in probes) | Abort condition |
|---|---|---|
| N-a probe | `nono --version`; `nono setup --check-only -v` | version ≠ pinned `0.80.0`; "Filesystem ruleset creation verified" or "TCP network rule support verified" missing → `ErrNotEnforceable` (already implemented in `Probe`) |
| N-b resolve | `nono profile validate -p <path>` **on a file we ship**, never `nono profile init` (observed: `init` refuses a path argument with "must be alphanumeric with hyphens"; only `run -p`/`validate`/`show` accept paths) | file missing (observed exit 1 with "Profile read error"), schema invalid |
| N-c assert policy | `nono profile show <path>` → require `Linux AF_UNIX mediation: Pathname` (observed: this string appears **only** here; `nono run -v --dry-run` printed no AF_UNIX line at all, grep count 0) | mediation not Pathname |
| N-d assert grants | `nono run -p <path> -v --dry-run` **with `cmd.Dir` inside the grants** (observed: exit 1 "CWD access requires --allow-cwd" when run from outside them, exit 0 when inside) and parse the merged list | any printed grant line not in the intended set (exact match on path+level), any `[user]` grant under `/tmp`, `/var/tmp` or `/dev/shm`, and any `[group:…]` source other than the allowlisted ones (`system_read_linux_core`, the `deny_*` groups) |
| N-e exec | the argv in §1, stdio pipes handed to `acp.Runtime` | any non-zero before the ACP `initialize` response → `sandbox.enforcement_failed` |

Exit status is never the assertion (FC2: honoured-by-configuration, unenforced), which is what N-c and
N-d exist for. The adapter keeps `--sandbox-policy landlock` pinned and never emits `external`.
`filesystem.deny` remains unsupported by CLI flags, so `FSDeny` in `required` stays an error at the
adapter layer rather than a silently dropped list (already the code's behaviour), and
absence-of-grant remains the only deny mechanism — which is exactly why ADR-0017's paths are never
temp paths and why ADR-0018 materializes *inside* granted trees.

### 3. Network is an axis, not a mode, and M3 proves it twice

Two Communication-owned policies, both first-class, both labelled in every event:

- **`agent-turn`** — filesystem + AF_UNIX enforced; network **`allow_all` and explicitly unenforced**
  for a real Claude/Codex turn, because the harness cannot answer without its model API and the
  domain-filtering path is a userland MITM proxy requiring `HTTPS_PROXY`/CONNECT plus a generated CA
  (SANDBOX.md "Network blocking is not one mechanism"). This profile carries
  `enforcement.network = "unenforced"` in `SandboxCapabilities.Notes` and the UI says so.
- **`agent-turn-egress-denied`** — same filesystem grants plus `--block-net`, used by the *security*
  gate (a command-only sandbox, no model call, egress must fail) so case 13/D-021 get an observed
  denial row without lying about real turns.

If the proxy spike succeeds (`--allow-domain` with a nono-started proxy on an OS-assigned port,
`NODE_EXTRA_CA_CERTS`/`SSL_CERT_FILE` handed to the adapter, denial *and* allowance both observed from
inside a real ACP turn), `agent-turn` may move to allowlisted egress and this section gets amended.
Until then **D-021 stays Provisional and no run may claim enforced egress control**.
`--proxy-port` is never fixed (availability cliff; as root it silently binds anywhere).

### 4. HOME and harness credentials, stated honestly

- `HOME = <workspace>/home` (ADR-0017 Decision 1's deviation note), created 0700 by the worker,
  granted rw implicitly by the workspace grant, seeded with a minimal `.gitconfig` (identity only),
  and deleted with the attempt. It satisfies ADR-0008 (APM's `~/.apm` writes land in throwaway state)
  and probe P6 (git aborts on an ungranted `~/.gitconfig`).
- The **harness credential tree is not per-attempt** and cannot be, in the lab: `~/.claude` and
  `~/.codex` are rw mounts whose contents Claude/Codex write mid-turn. Consequences recorded rather
  than argued away: (a) two conversations — even across projects — share one harness login and its
  mutable state, so *any* project able to launch that launcher can write that tree; (b) 05's
  "credential mount" security test is therefore only about the **application** secret kinds, and says
  so in its own results row; (c) the M3 exit gate's cross-project denial is proven over workspaces and
  mirrors, **not** over harness credentials, and this record must not be cited as if it were.
  Per-attempt credential copies (mode 0400, deleted with the attempt) are the intended answer for a
  profile-managed harness and are listed as an M3 spike, not as a decision.
- `CLAUDE_CONFIG_DIR` / `CODEX_HOME` stay runtime mounts (`compose.harness.yml`), never baked into the
  image, never in the DB, never in a policy file, and never in an `Env` list the worker builds from
  the environment it inherited — they are declared in `worker/launchers.yaml` as per-launcher auth
  requirements (`04` "per-harness auth requirements"), which is the missing home for this config.

> **GAP — custody of production harness credentials (owner decision; does not block M3).**
> The project owner has authorized **personal Claude/Codex logins for all local and lab runs**, which
> is what every M3 observation in `docs/compatibility/` is made with — and that authorization stops at
> the lab boundary. *Whose* credential a **production** worker may hold (`04`'s "organization-managed,
> terms-compliant" requirement; `05`'s warning that personal interactive subscriptions may not permit
> shared service usage) is unresolved, and it is a licensing/terms question rather than a technical
> one, so it cannot be closed by an implementation worker. Consequences kept explicit: Decision 4
> above stays the shipped shape (shared rw credential tree), **this record must not be cited as
> evidence of credential isolation**, `required` mode enforces workspace isolation only, and the ops
> page has to show that next to any green check. Per-attempt copied credentials (mode 0400, deleted
> with the attempt) remain the intended answer for a profile-managed harness and stay an M3 spike,
> not a decision. The technical options the owner's choice will pick between — org API key per
> project, a broker (`integration_broker`, declared and unbuilt per ADR-0018 clause 8), or a
> per-attempt copy — are all behind `worker/launchers.yaml`'s per-launcher auth requirements, so none
> of them changes this ADR's launch chain; only its honesty label changes. Tracked as D-010/D-020.

### 5. Where the policy lives, and how it is identified

`worker/sandbox/profiles/communication-agent.json` (ADR-0007: `worker/` holds sandbox policy files),
pinned by content digest, referenced as `SandboxPolicyRef` and recorded per unit. The
`SandboxPolicy` → argv translation is what `internal/sandbox/nono` already does; it gains
`ProfilePath`, `HarnessCredentialDirs`, `CommitGrant` (the four ADR-0017 paths), and rejection of
temp-dir grants. `SandboxCapabilities` gains `Enforcement` (mode actually used), `BackendVersion`,
`AfUnixMediation`, `NetworkEnforced`, `PolicyDigest`, `DeniedWhat` (which layer denied what, per
ADR-0009 Decision 3) and `Verified=true` **only** when N-a…N-d all passed for this unit — the existing
`notVerifiedNote` behaviour in `Probe` stays, because a probe is still not a proof.

### 6. Failure reporting

`domain.SandboxLauncher` errors map to one event, `sandbox.enforcement_failed`, with a `stage`
(`probe|profile|policy_assert|grant_assert|exec|runtime`), a `reason` enum
(`binary_missing|landlock_unavailable|fs_unverified|tcp_unverified|af_unix_not_mediated|profile_invalid|grant_mismatch|temp_path_grant|cwd_not_granted|policy_delegation_refused|deny_unsupported|egress_check_failed`),
the intended `policy_digest`, `verified=false`, and `child_started=false` (true only for `runtime`).
The turn then closes `conversation.turn.failed` with `reason="sandbox_enforcement_failed"` — never
`interrupted` (that word means "nobody reported an outcome", ADR-0016 § 6) and never a fallback run:
`permissive-dev`/`disabled` are separate configured modes, not recovery paths, and every event from a
launch that took one carries `isolation="none"` (`05`). `communication doctor` gains a check that runs
N-a…N-d with a dry-run policy and prints the verdict plus the forbidden capabilities it observed —
which is what `10`'s "sandbox health" ops page needs, and what the 05 first security acceptance gate
demands.

## Consequences

- Positive: `required` finally has an implementation shape instead of a name, and the two things that
  would have broken a first live attempt (ungranted `HOME`, mirror read needed for *any* git command)
  are pre-committed in the policy.
- Positive: egress honesty is structural — two profiles with different names, rather than one profile
  whose network claim depends on which flags happened to be passed.
- Cost: nono enters the worker image as a pinned, digest-verified artifact, so a nono upgrade is a
  worker image rebuild plus a re-run of the SANDBOX matrix (ADR-0009's Migration section anticipated
  exactly this).
- Cost: three extra nono invocations per launch (`validate`, `profile show`, `run -v --dry-run`).
  Measured cost of those three is unknown; if it is material, cache per (policy digest, worker boot).
- Limitation: the agent's file-system reach is bounded by *grants*, and grants now name paths inside a
  git directory — a wrong path there is corruption or disclosure, not a clean denial (ADR-0010
  Consequences).
- Limitation: harness credentials remain shared mutable state (Decision 4), so `required` mode
  enforces *workspace* isolation and not *credential* isolation.
- Limitation: everything above lives inside one Unix uid. Two mutually untrusted client projects still
  need Option C / distinct identities (D-025 **Open**), and the ops page must show that caveat next to
  the green check, because a passing `required` launch will otherwise read as a tenant guarantee.
- Ops: `permission_mode='preapproved_within_sandbox'` may only be offered for a launcher whose
  `agent-turn` policy has produced an observed `Verified=true` launch — the ADR-0016 § 10 gate, now
  with a defined meaning.

## Security/privacy

The boundary is "one launched agent unit": its filesystem reach is exactly the granted paths
(workspace, its own mirror ref namespace, its harness config dir), restrictions inherit to every
descendant (C8), and anything not granted is invisible at the syscall level (C2–C5: `EACCES`, symlink
and `..` traversal closed). Process *existence* is still visible (C9b: `ls /proc/1/` lists entries
even with `process_info_mode: isolated`), so host layout is an information leak we do not claim to
close. AF_UNIX is closed **only** by the shipped profile (C7 fell open at the defaults, and the
remedy was observed). The always-layered `default` profile grants `/tmp` write — measured, not
inferred — hence Decision 5's temp-path abort. Fail-closed points: probe, profile, policy assert,
grant assert, exec, and a missing prompting mode (ADR-0016). Known **fail-open** shapes, each with an
assertion: `/tmp`-shaped paths (N-d rejects), `--sandbox-policy external` (never emitted), a
nonexistent grant path silently ignored by nono (FC3 — the adapter validates paths exist before
launch, and N-d's merged-list parse catches a dropped one), `FSDeny` under CLI flags (adapter-level
error), AF_UNIX at defaults (N-c), and egress (never claimed on the `agent-turn` profile). Nothing
here is a tenant-isolation claim; `12-test-strategy.md`'s release gate ("No production 'sandboxed
tenant isolation' claim based solely on alpha nono") is the rule this ADR implements, not violates.

## Verification

Observed 2026-10-15 on the lab host (`nono 0.80.0`, binary sha256 `e02d003d…eff1287d`, kernel
`7.2.9-arch1-1`, Landlock ABI V6, uid 1000) — ad-hoc, fixtures under
`$HOME/.cache/communication-lab/m3-probe/`, **not yet scripted** into
`docs/compatibility/probes/sandbox/` (out of this task's boundaries; scripting is M3's first step):

- **N1** `nono run -s --allow <workspace> -- sh -c 'echo x > /tmp/ninety-probe'` → `TMP_WRITE_OK`,
  and the file existed on the host afterwards with content `x`. Same child, `/var/tmp` and
  `/dev/shm` → `Permission denied`; `/etc/hostname` → `Permission denied`.
- **N2** `nono run -s --allow <workspace> --read <dir-outside-tmp> -- sh -c 'echo w > <dir>/w'` →
  `RO_WRITE_DENIED`, `cat <dir>/f` → `RO_READ_OK`: a read grant really is read-only *outside* the
  default profile's temp grants.
- **N3** `nono profile init /tmp/comm-agent.json` → `Profile parse error: Invalid profile name … must
  be alphanumeric with hyphens`; `nono profile init comm-agent` wrote
  `~/.config/nono/profiles/comm-agent.json`, `nono profile validate <path>` → exit 0, "Result: valid,
  All 18 group references valid".
- **N4** after setting `linux.af_unix_mediation="pathname"`: `nono profile show <path>` printed
  `Linux AF_UNIX mediation: Pathname`; a sandboxed `curl --unix-socket /var/run/docker.sock` under
  that profile → `curl: (7) … Could not connect` (exit 7, the socket was never used) — reproducing
  SANDBOX.md's C7 remedy with **our** profile file, which ADR-0009's Verification listed as untested
  ("applied end-to-end").
- **N5** `nono run -p <path> --allow <ws> --read <mirror> --block-net -v --dry-run -- true`: from a
  cwd inside the grants → exit 0 and a merged list whose every line is tagged
  `[user]`/`[group:system_read_linux_core]`; from a cwd outside them → exit 1 `CWD access requires
  --allow-cwd`. The same output contained **no** AF_UNIX line (grep count 0) — hence N-c and N-d are
  different commands, not one.
- **N6** `nono run -s -p /tmp/does-not-exist.json … --dry-run` → exit 1
  `Profile read error … profile file not found`: a missing policy file fails closed at the assert
  stage, as ADR-0009 Decision 1 requires.
- **P6**/**P10** (ADR-0017): git aborts with `fatal: unknown error occurred while reading the
  configuration files` when HOME is ungranted, and with `fatal: gitfile does not point to a valid
  repository` when the mirror is not readable — both are agent-visible failures a launch must not ship.
- **Inherited from M0:** C8 (grandchildren restricted), C2–C5 (`EACCES`, symlink/`..` closed), FC1/FC6
  (abort before exec), FC2 (**FAIL**, external drops `--block-net` — rejected by Decision 2), FC3
  (nonexistent grant silently ignored — rejected by N-d), C7 (**FAIL** at defaults, closed by N4),
  C9b (partial, documented as a leak).
- From `docs/compatibility/ACP.md`, the same chain **minus nono** is proven inside
  `communication-worker:dev`: `communication doctor --acp claude` PASS, and the full turn loop against
  real Claude Code (permissions, cancel, SIGTERM, hard-kill resume) PASS. So the stdio pipes survive
  the container; whether they survive `nono` wrapping is untested, and it is M3's first probe.

**Not tested — the list that keeps this Proposed:** Landlock inside `node:22-bookworm-slim` under
Docker 29.9.0's builtin seccomp (the worker image's actual base; only `debian:trixie-slim` was
probed); ACP `initialize`/`session/new`/prompt/permission/cancel through a `nono run` wrapper, for
both adapters (npm/npx + Node under a Landlock ruleset, including the `dangerous_commands` blocklist
that ships inside the default profile — nono itself reports command blocking as deprecated and
bypassable by children, so it is not a control we rely on either way); harness writes into their
config dirs under `--read` (the hypothesis "must stay rw" rests on `compose.harness.yml`'s recorded
observation, not on a probe of this chain); per-attempt copied credentials; enforced domain allowlist
through the nono proxy from a real turn; rootless Podman (SANDBOX.md row is GAP); the
"kernel-feature-missing" abort; worker image with nono vendored rather than bind-mounted; and CPU/
memory/process limits, which `SandboxPolicy` does not model at all yet (`resources` in 05's struct
list — M3 leaves it unimplemented and says so rather than pretending).

## Migration/rollback

Additive: `AgentProfileRevision` gains `sandbox_policy_ref` (04 already lists it conceptually),
`workers` gains the `sandbox_*` columns (ADR-0017), and `sandbox.enforcement_failed` is a new event
type in the same journal. A deployment that does not want the sandbox sets
`COMMUNICATION_SANDBOX_ENFORCEMENT=permissive-dev` (or `disabled`) and every event from it is labelled
`isolation="none"` — that is the rollback, and it is ADR-0009's explicitly stated rollback
("the rollback is *not* to Option A"), never a silent fallback and never a `required` claim.
Removing nono later (bubblewrap — present on the lab host, still untested; or OCI per Option C)
replaces this adapter behind the unchanged `domain.SandboxLauncher` contract, and N-a…N-d transfer to
whatever answers "what did you actually enforce?".

---

## Implementation note (M3 build, 2026-10-15)

Four things this record specified needed correcting against the built system. Each
is a mechanism change; no Decision here is relaxed.

**The startup gate cannot be `Probe`.** Decision 6 requires a refusal rather than
a fallback, and the first implementation read that as "probe, and refuse unless
`Verified`" — which is unstartable, because `Launcher.Probe` sets
`Verified=false` *by construction*. M2 wrote that deliberately: a probe reports
what `nono setup --check-only` claims it supports, and cannot report that a child
was confined. The failure was observed on the first compose bring-up:

```
"msg":"invalid execution-unit configuration",
"error":"sandbox cannot enforce filesystem isolation (observed filesystem=true verified=false): required mode refuses to start"
```

`required` mode therefore has a real two-legged exec test at startup
(`Launcher.SelfTest`, contract deviation D21): a granted path must be writable, and
a non-granted sibling under the same scratch root must not be — with the child's
own report corroborated by a `stat`, so a child that *printed* success while
leaving no file cannot pass either. It runs before registration, and the negative
control (`selftest_negative_test.go`) replaces `nono` with a shim that performs no
sandboxing; if the test ever became vacuous, that test fails with
`SELF-TEST IS VACUOUS` rather than quietly green. Observed live, the refusal is now
specific and the success is earned:

```
"msg":"sandbox enforcement observed before serving turns","backend":"nono","backend_version":"0.80.0","filesystem_live":true
```

**Grants are CLI flags, not profile entries** (deviation D18). N-d was written
assuming the resolved grant list could be matched against what the profile
declared. It cannot: `--dry-run` tags profile-inherited rules `[profile]`, and
those are indistinguishable from nono's own `extends: default` contributions —
`/run/systemd/userdb` appears in the resolved set with no caller having named it.
Exact-match assertion is only expressible over `[user]`-tagged lines, so grants go
in as `--allow`/`--read` and the static profile carries only what flags cannot
express: mediation settings, the Landlock pin, the `system_write_linux` exclusion,
the host-conditional group exclusions (D19 follow-up below), and the device
re-grants that exclusion breaks (probe C-TMP3).

**N-d asserts set *equality*, and that is load-bearing** (deviation D19). Comparison
in the "did we get at least what we asked for" direction would pass on a superset,
and nono always layers its `default` profile — so `/tmp` is always present. Two
observations make this concrete; the first is from the live container:

```
WARN  '/repos/DOES-NOT-EXIST' does not exist and will be ignored.
INFO  Skipping non-existent path: /repos/DOES-NOT-EXIST
CHILD-RAN
```

nono accepts a grant naming a nonexistent path, warns on stderr, and execs the
child anyway — the silent-drop class probe C-FC3 recorded, now observed on the
release build. So every grant path is stat-ed before the argv is built, the
resolved `[user]` set must equal the requested set with nothing added, and a
resolved temp path is refused on sight. The second observation: with no `-p` flag,
`/tmp` is writable; with the shipped profile, it is not
(`cannot create /tmp/m3-b: Permission denied`). Omission is not a deny under a
layered default profile, and this record's D4 said so — the note is that the
*assertion* has to be as strict as that statement.

**Set equality is only portable if the inherited layer is** (D19 follow-up,
probe C-HOSTGRP, CI run 38755314927). nono's `default` profile composes
groups whose rules exist only on hosts carrying the paths, and the assertion
correctly refused: on ubuntu-latest, `group:homebrew_linux` resolved
`r /home/linuxbrew/.linuxbrew` and every `required`-mode launch died at
`grant_assert (grant_mismatch)`; on the lab host, `group:user_tools` resolves
`~/.local/*` whenever nono's HOME has one (reproduced as a negative control).
The remedy is at the profile, not the assertion: the shipped policy now
excludes every host/platform-conditional default group
(`homebrew_*`, `user_tools`, `system_write_*`, `system_read_macos`,
`dangerous_commands_macos` — the `deny_*` groups are required by nono and
cannot be excluded, and are denies rather than grants), so the resolved
sources are exactly `group:system_read_linux_core`, `[profile]` and `[user]`
on any host. The N-d source allowlist was **not** widened; a stray grant is
still refused, it just no longer arrives.

**The agent needs a temp directory inside its grants** (deviation D23). Refusing
`/tmp` is correct and unchanged; what was missing is a place for the harness to
write. The first real turn showed the shape of the gap — Claude Code aborted at
`session/new` with `EACCES: permission denied, mkdir '/tmp/claude-1000'`, which
looks exactly like an adapter bug and is the sandbox working. `TMPDIR` is now
pointed at `<scratch>/tmp`, created *before* the launch (a grant to a nonexistent
path grants nothing, the same C-FC3 class), and proven both ways in the container:
`/tmp` unwritable under the shipped profile, `claude-1000` created successfully
under `TMPDIR`. Per-attempt scratch beats a shared `/tmp` for ADR-0008's purposes
anyway.

**What this record claims, now observed rather than designed.** A turn under
`required` mode produced seven `sandbox.verified` rows carrying nine
`{role, access}` labels and no paths, and one of those turns ran a real commit
through the four-path axis into its own run ref. Cross-project denial held from
inside the container in both directions (read and write against another project's
mirror, disk-corroborated, with a positive control so the denial could not be an
artifact of broken access). Decision 4's credential gap is unchanged and still
called a gap: `harness_credentials` is a **rw** grant, so `required` isolates
workspaces, not credentials.
