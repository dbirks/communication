# ADR-0017 — Run workspaces: per-project mirrors, per-run worktrees, proven commit grants, and worker volume identity

- **Date:** 2026-10-15
- **Status:** **Proposed** (the grants in Decision 4 were observed on the lab host, not yet inside the worker image)
- **Owners:** M3 implementation workers (worker runtime, control plane, UI)
- **Related decisions / contracts:** D-004 (**Accepted**, run workspace is a concrete filesystem), D-008 (**Accepted**, per-run worktree), D-009 (**Accepted**, node-boundary checkpoints, honest restart), D-024 (**Open**, checkpoint strategy), D-025 (**Open**, trust model), ADR-0010 (this record makes its Decision 3 concrete and closes its "key missing integration check"), ADR-0008 (staging exclusions), ADR-0009/ADR-0019 (who may hold these grants), ADR-0013 (forward-only migrations), ADR-0016 (turn leases and fencing), `communication-spec/05-workspaces-security-secrets.md` § "Workspace design" / "Checkpoint/recovery policy", `communication-spec/01-domain-model.md` (Workspace, Attempt), `communication-spec/12-test-strategy.md` cases 17 and 20. Evidence: `docs/compatibility/WORKSPACES.md`, `docs/compatibility/SANDBOX.md`, and the M3 pre-contract probe recorded in this ADR's Verification section.

## Context

M2 gave every conversation a directory — `internal/worker/workspace.go` makes
`<COMMUNICATION_WORKSPACE_ROOT>/<conversation-id>/{repos,scratch,meta}` and `git clone --depth 1
--single-branch` per repository into `repos/<name>`. That is the 05 layout with the wrong git
mechanism: a shallow standalone clone per conversation, so there is no shared object store, no run
branch, no worktree, and no way to answer "what changed" or "give me this run's history". M3 replaces
it with ADR-0010's shape: mirrors at `repos/<project-id>/<name>.git`, one linked worktree per
(conversation|run) × repository on a per-attempt branch.

ADR-0010 said *what* to isolate but deferred the part that can only be settled by measurement: its
Verification lists "agent commits *through* a nono sandbox with the Decision 3 grants (W3 and the
sandbox matrix were measured separately and never together — the key missing integration check)".
M3 cannot schedule a committing agent without that check, because the grant list is a security
boundary: too narrow and the agent's own `git commit` fails mid-attempt, too wide and one run can
rewrite another's history inside the shared mirror.

Three further holes are M3-shaped:

- **Nothing identifies *which disk* a workspace lives on.** `workers` (migration `00001`) has `name`,
  `hostname`, `version`, `status`. Case 20 ("worker restart on same volume recovers workspace;
  restart on different host clearly reports loss/redo") is unanswerable without a volume identity, and
  "same volume" is exactly the thing a container restart can silently change (compose.yml mounts a
  named volume; `compose.harness.yml` overrides it with a host bind at the *same path*).
- **M3 has no runs and no attempts.** `attempts` and `runs` arrive in M4 (`11-build-roadmap.md`:
  "durable attempts" is an M4 bullet); migration `00003` created `conversation_turns` instead. Every
  spec sentence about an attempt-scoped workspace, secret or checkpoint therefore has to be written
  against the turn, with the attempt slot left open rather than renamed later.
- **The `.gitignore`-shaped assumption inside 05** ("verify `git ls-files` and check ignore/exclude
  rules") has no per-run implementation in a linked-worktree layout — measured, see Verification.

## Options considered

| Option | Advantages | Disadvantages | Evidence |
|---|---|---|---|
| A. Keep M2's per-conversation shallow clones | Already implemented and proven against two real harnesses; zero shared state, so no mirror grant exists at all | No history, no base-ref pinning, no branch identity, no cheap second repo checkout, no portable checkpoint; every conversation re-downloads the repo; the 05 "dirty diff summary / modified path manifest" cannot be produced from a depth-1 clone reliably | `internal/worker/workspace.go`; ADR-0010 rejected it implicitly via D-008 |
| **B (selected).** Per-project mirror + per-run linked worktree (ADR-0010), with the commit grant set **measured** through nono and resolved per-attempt rather than constructed from layout | D-008 and the 05 layout unchanged; the write-set of a sandboxed commit is now a known list, not an inference; per-run-branch ref grants confine *writes* to one run even though reads stay shared | The mirror is shared state within a project; the worktree admin directory name is not derivable from the layout (git auto-suffixes on basename collision); git needs a granted `HOME` and pre-created reflog directories, so workspace preparation has real ordering; exclusions land project-wide | Probe P1–P10 below; WORKSPACES.md W1/W2/W3/W4/W6; ADR-0010 Decision 1–6 |
| C. Per-run full clone from the mirror | No shared writable path; W4 cross-run visibility gone; a copied clone is portable (W5 moot) | Disk and fetch cost per conversation of a large repo; M2 measured nothing about cost, and ADR-0010 already lists this as the "untrusted projects" escape hatch rather than the default | WORKSPACES.md candidate (a); ADR-0010 Decision 5 |
| D. Mirror made writable to the agent at the directory level (`--allow repos/<project>`) | Never fails; no per-ref bookkeeping; git can do everything | Grants authority over *every* run's refs in that project: observed unsandboxed `git update-ref refs/heads/run-1/backend` succeeds, and the sandboxed equivalent is precisely what narrower grants deny | Probe P4 (denied) vs its control (allowed) |

## Decision

1. **Layout** — a workspace is owned by a scope, not by a milestone:

   ```
   <COMMUNICATION_WORKSPACE_ROOT>/<scope-kind>/<scope-id>/
     repos/<name>/          linked worktree, branch <scope-id>/<name>
     scratch/               generated output, never tracked
     meta/                  worker-only bookkeeping (workspace.json, staging ledgers)
     home/                  per-attempt HOME (see 4; this is the one "meta-ish" path the agent may write)
   ```

   with `scope-kind ∈ {conversation, run}`, `<scope-id>` the canonical uuid text (the `uuidDir`
   guard from `workspace.go` is retained and applied to run ids too), and mirrors at
   `/var/lib/communication/repos/<project-id>/<name>.git` exactly as ADR-0010 Decision 1 (configurable
   root; `repos/` beside `workspaces/` on the same worker volume). `meta/` stays out of every grant;
   `home/` is a *separate* directory precisely so 05's "meta/ … never mounted to agent" keeps meaning
   what it says (deviation D2 in `docs/m3-contract.md`).

2. **Volume identity is registration data.** The worker resolves the `st_dev` of its workspace root,
   hashes the device identity plus the root path, and reports it on register as `volume_id`
   (`workers.volume_id`, `workers.workspace_root` — new columns). Every `workspaces` row stores the
   `worker_id` **and** the `volume_id` it was created under. Recovery rule: a workspace may be
   reclaimed only by the same worker with the same `volume_id`; otherwise the worker records
   `workspace.recovery_lost` and the work is redone (`02`: "do not advertise" cross-host
   rehydration). A named volume replaced at the same path is a *different* `volume_id`, and that is
   the whole point of the column.

3. **Workspace state machine** (table `workspaces`, contract in `docs/m3-contract.md`):
   `preparing → ready → {released, lost}` plus `quarantined` for a workspace that failed a security
   check (e.g. an exclusion could not be established, or a materialized file survived cleanup).
   Transition writes follow ADR-0013's one-transaction rule (state + `domain_events` + outbox).

4. **Per-attempt git identity and grants.** `Prepare` does, worker-side and *outside* any sandbox:
   mirror create-or-fetch → `git worktree add -b <scope-id>/<name> <path> <ref>` →
   `git worktree list --porcelain` to read this worktree's real `gitdir:` (**P1**: two worktrees of
   one repo are `worktrees/backend` and `worktrees/backend1`; the admin path is **not** derivable
   from the directory layout) → pre-create `<mirror>/logs/refs/heads/<scope-id>/` (**P7**: git creates
   reflog directories lazily and fails with `unable to create directory for … No such file or
   directory` when only the leaf is granted) → store all four paths on `workspace_repos`.

   The launch-time grant set is then:

   | Axis | Grant | Evidence |
   |---|---|---|
   | `edit` (always) | `rw <workspace>`, `rw <workspace>/home`, `ro <mirror>` | **P10**: *any* git command in a linked worktree needs the mirror readable — `--allow <worktree>` alone dies with `fatal: gitfile does not point to a valid repository`; **P6**: a `HOME` outside the grants makes git abort on `~/.gitconfig` even when `-c user.email`/`-c user.name` are passed |
   | `commit` (separate, per profile) | `rw <mirror>/objects`, `rw <mirror>/refs/heads/<scope-id>`, `rw <mirror>/logs/refs/heads/<scope-id>`, `rw <mirror>/worktrees/<admin-id>` | **P2**: a real commit succeeded with exactly these plus the `edit` row; the observed write-set was exactly these paths. **P3**: with the mirror `ro` only, the same commit failed at `worktrees/backend/index.lock: Permission denied`. **P4**: run-2's sandboxed `git update-ref refs/heads/run-1/backend` was denied (`backend.lock: Permission denied`) while the identical unsandboxed command succeeded |
   | never | `rw <mirror>/info`, `rw <mirror>/refs/heads/<other-scope-id>`, anything under another project's mirror | **X4**: agent write to `<mirror>/info/exclude` denied with the mirror `ro`; **P4** |

   `objects/` stays shared-writable under `commit` and that is accepted: objects are content-addressed
   and immutable, so the exposure is disk growth and garbage, not history corruption — the history
   *is* refs, and refs are per-scope (`05` "a workspace's successful implementation result is a
   candidate change" needs its own branch and nothing else).

5. **Never place a workspace, mirror, HOME or scratch path under `/tmp`, `/var/tmp` or `/dev/shm`.**
   Measured (**P9**): with a single `--allow <dir>` grant, a write into an *ungranted* directory under
   `/tmp` **succeeded** while a read of the same directory was denied; the identical write under
   `$HOME/.cache/…` was denied. nono's built-in `default` profile is always layered in
   (SANDBOX.md "The default profile is always mixed in"), and its temp-dir grants mean "denied by
   omission" is **not** true under `/tmp`. This is a hard rule of the adapter, checked at
   `Probe`/`Launch` time: any grant path under those prefixes in `required` mode is a configuration
   error, not a warning. (This finding corrected an earlier false reading of mine: a commit appeared to
   succeed with the mirror read-only *only* because the whole fixture lived under `/tmp`.)

6. **Excluding materialized and staged paths from git is a project-scoped, worker-owned file.**
   In a linked-worktree layout the only mechanism git honors is the **common** directory's exclude
   file, `<mirror>/info/exclude` (**X1**: a per-worktree `$(git-dir)/info/exclude` is ignored —
   `git check-ignore` exit 1 and the file still listed by `git status --porcelain`; **X2**: the same
   line in `<mirror>/info/exclude` made it vanish from `git status`; **X3**: the documented per-worktree
   route `extensions.worktreeConfig = true` broke every git command inside the worktree
   (`fatal: this operation must be run in a work tree`) against a bare mirror, and is itself a
   shared-mirror write). So: the **worker** writes the declared secret-mount and APM-staging paths
   into `<mirror>/info/exclude` before launch (it is unsandboxed), the agent can never edit it
   (X4), and the exclusion's real scope is *one project's mirror*, which deviates from 05's per-mount
   framing (deviation D3). Defense in depth does not stop there: the checkpoint/diff/artifact paths
   additionally filter the declared exclusion set explicitly, so a git-level exclusion is never the
   only thing standing between a `.env` and an artifact (ADR-0018).

7. **Cleanup** is ADR-0010 Decision 6 (`git worktree remove --force` then `prune`, W6-proven; mirror
   `gc` is worker-owned and never runs inside an attempt), plus: `home/` deleted with the attempt,
   `meta/` retained while the workspace is reclaimable, and a failed cleanup moves the workspace to
   `quarantined` rather than silently deleting it.

8. **Checkpoints stay bundles/refs or captured diffs** (ADR-0010 Decision 7, W5). M3 proves the
   *capture* (dirty diff summary + modified-path manifest with exclusions applied) and stores it via
   ADR-0020's artifact backend; it does **not** prove cross-host rehydration (D-024 stays Open,
   case 20's "different host" arm asserts only the honest `workspace.recovery_lost` report).

## Consequences

- Positive: ADR-0010's untested integration check now has an observed answer, including the failure
  modes (`index.lock`, reflog directory, `~/.gitconfig`) that a first real attempt would have hit.
- Positive: `commit` becomes a schedulable, per-profile axis with a bounded grant list, so M4's
  publication nodes can ask for exactly one thing.
- Positive: workspace recovery stops depending on a hostname and starts depending on a device.
- Cost: workspace preparation is now a multi-step worker routine with persisted path state
  (`workspace_repos`), and it must be idempotent because a killed attempt can leave a half-added
  worktree behind (untested; `git worktree prune` is the recovery).
- Limitation: exclusion is project-wide, not attempt-scoped (X1/X3 force it); a declared `.env.local`
  mount in one conversation silently excludes that name for every run of the project.
- Limitation: cross-run *read* visibility inside a project survives (P5: run-2's sandbox read
  run-1's branch through the mirror) — accepted by ADR-0010 as same-trust-domain behaviour.
- Limitation: a sandboxed commit prints `error: Unable to create '<mirror>/packed-refs.lock':
  Permission denied` and still exits 0 (P8). Stderr noise is therefore **not** a failure signal in
  this design; attempt outcomes come from exit status plus a post-commit ref readback, and any
  implementation that reads "git said error" as failure will misreport.
- Limitation: `home/` inside the workspace means "workspace contents" now includes harness caches;
  the artifact/checkpoint exclusions must name it.

## Security/privacy

The security-relevant object is still the mirror (ADR-0010): a writable mirror path is authority over
that project's history on that worker. This ADR narrows that authority from "the project" to "the
project, this ref namespace, this worktree admin dir" and proves the narrowing holds under Landlock
(P4 denied with the grant, allowed without it — a control pair, not an inference). Reads inside a
project stay open (P5), so **nothing here is a tenant-isolation claim** (05 "Trust caveat", D-025
**Open**): everything measured ran as one Unix user on one host. Cross-project separation comes from
never naming another project's mirror in a grant, plus ADR-0019's verify-then-run; per-run full clones
(ADR-0010 Decision 5) remain the answer for genuinely untrusted co-tenants and stay unprobed.
`/tmp`-shaped paths are refused outright (P9) rather than trusted to omission. Materialized secrets
are excluded by a file the agent cannot write (X4) and filtered again worker-side. Fail-closed
positions: unresolved `gitdir:` → the attempt does not start; workspace root under a temp dir → the
attempt does not start; `commit` requested but any of its four grants cannot be resolved and
normalized server-side (05: reject traversal/symlink/relative paths as ACL proof) → the attempt does
not start, with `sandbox.enforcement_failed` (ADR-0019).

## Verification

Ad-hoc probe on the lab host 2026-10-15 (`git 2.56.0`, `nono 0.80.0` binary sha256
`e02d003d…eff1287d`, Landlock ABI V6, uid 1000), fixtures under
`$HOME/.cache/communication-lab/m3-probe/` — **not scripted into `docs/compatibility/probes/` by this
task** (out of brief boundaries); scripting it is M3's first implementation step and the case-17 test
below re-runs the same checks inside the worker image:

- **P1** `git worktree list` → `ws/run-1/repos/backend [run-1/backend]`, `ws/run-2/repos/backend
  [run-2/backend]`; admin dirs `repos/proj.git/worktrees/{backend,backend1}` — same-repo basenames
  collide and git auto-suffixes.
- **P2** sandboxed commit with grants `rw ws/run-1`, `ro <mirror>`, `rw <mirror>/{objects,
  refs/heads/run-1,logs/refs/heads/run-1,worktrees/backend}`, `HOME=ws/run-1/home` →
  `[run-1/backend 6a35bf7] narrow-set commit`; `find <mirror> -newer marker` listed exactly
  `logs/refs/heads/run-1{,/backend}`, `objects/6a/…`, `objects/dd/…`, `refs/heads/run-1{,/backend}`,
  `worktrees/backend{,/COMMIT_EDITMSG,/index,/logs/HEAD}` — nothing outside those paths.
- **P3** same commit, mirror `ro` only → `fatal: Unable to create '<mirror>/worktrees/backend/index.lock':
  Permission denied`.
- **P4** run-2's sandbox: `git update-ref refs/heads/run-1/backend <sha>` → `Unable to create
  '<mirror>/refs/heads/run-1/backend.lock': Permission denied`; **control without the sandbox →
  `UNSANDBOXED_WRITE_OK`** and the ref moved.
- **P5** run-2's sandbox `git --git-dir=<mirror> log --oneline run-1/backend` → succeeded (three
  commits listed), matching W4.
- **P6** with the real `HOME` ungranted: `warning: unable to access '~/.gitconfig': Permission denied`
  ×3 then `fatal: unknown error occurred while reading the configuration files`, despite `-c`
  identity flags.
- **P7** with `<mirror>/logs/refs/heads/run-1/` absent → `fatal: cannot update the ref
  'refs/heads/run-1/backend': unable to create directory for '…/logs/refs/heads/run-1/backend': No
  such file or directory` — fixed by worker-side `mkdir -p`, after which P2 passed.
- **P8** during a *successful* (exit 0) commit: `error: Unable to create '<mirror>/packed-refs.lock':
  Permission denied`.
- **P9** `--allow /tmp/sbx/rw` only: write to ungranted `/tmp/sbx/dn` → `WRITE_OK` (file exists on the
  host), read of the same dir → `READ_DENIED`; write to ungranted
  `$HOME/.cache/communication-lab/sbx-probe/pwn` → `Permission denied`.
- **P10** `--allow <worktree>` only → `fatal: gitfile does not point to a valid repository:
  <worktree>/.git`; adding `ro <mirror>` → `git log` works.
- **X1** `git check-ignore -v .env.test.local` with the rule in `$(git-dir)/info/exclude` → exit 1,
  `git status --porcelain` still shows `?? .env.test.local`.
- **X2** same rule appended to `<mirror>/info/exclude` → `check-ignore` names
  `<mirror>/info/exclude:7:.env.test.local` and `git status --porcelain` shows only `M  app.txt`.
- **X3** `git config extensions.worktreeConfig true` + `git config --worktree core.excludesFile …`
  (both exit 0) → `git status --porcelain` → `fatal: this operation must be run in a work tree`;
  unsetting restored normal output.
- **X4** sandboxed `echo .env.secret >> <mirror>/info/exclude` with the mirror `ro` →
  `Permission denied` / `EXCLUDE_WRITE_DENIED`.
- **X5** a file created at the same path in *another* run of the same project (run-2) was also
  ignored → the exclusion is project-scoped.

Not tested (each is a scripted M3 gate, `12-test-strategy.md`): cases 17 and 20 executed inside the
worker image with a real harness rather than `git` directly; concurrent `Prepare` of two runs against
one mirror (lock contention on `<mirror>/refs`); mirror fetch failure and half-written worktree
recovery; `prune` while another run's worktree is live; disk pressure with per-project mirrors;
per-run full clone (Option C) cost; worker restart with `volume_id` unchanged but orphaned worktrees;
multi-worker mirror ownership; submodules/LFS; and any of this under ADR-0019's `required` mode with
the Communication-owned profile applied (the probe used CLI flags, which ADR-0009 forbids as proof).

## Migration/rollback

M3 adds `workspaces` and `workspace_repos` and widens `workers` with `volume_id`, `workspace_root`,
`sandbox_*` (draft DDL in `docs/m3-contract.md`); it rewrites no `00001`/`00002`/`00003` row, and
`ExpectedSchemaVersion()` advances by one (ADR-0013). M2's conversation workspaces keep working
untouched: the new path shape is a sibling of the old one, and a `conversation` workspace created by
`00003`-era code is simply never claimed by M3 code (no `workspaces` row ⇒ `workspace.recovery_lost`
on first M3 turn for that conversation, which is the honest "start over" the spec already permits).

Rolling back a project from worktrees to per-run full clones is a workspace-mode flag (ADR-0010
Decision 5). Rolling back the `commit` grant is immediate and proven-shaped by WORKSPACES.md H1/H2:
drop the four mirror writes, the run continues dirty-only, and the worker captures the diff before
the grant goes away. Dropping volume identity is a column nobody reads — no data migration. If the
mirror layout ever has to move, ADR-0010's Migration section applies unchanged
(`git clone --mirror` per project, re-fetch, `git worktree list` as the audit).

---

## Implementation note (M3 build, 2026-10-15)

Two clauses of this record were falsified by the code they were written to guide.
Both are corrected here rather than left for a reader to rediscover; neither
changes a Decision, only the mechanism a Decision named.

**D1's mirror creation cannot use `git clone --mirror`** (contract deviation D17,
probe G9). A `--mirror` clone sets `remote.origin.mirror=true`, which makes every
subsequent `git fetch --prune` delete refs the *platform* wrote, not just stale
ones. Observed on a second prepare in the same project:

```
$ git --git-dir=<mirror> rev-parse <scope-id>/backend
fatal: ambiguous argument '<scope-id>/backend': unknown revision
```

The first run's ref had been pruned by the second run's fetch. D1's own
requirement — run refs persist, because that is what makes a resumed conversation
continue — cannot coexist with mirror-mode fetch, so the mirror is built as
`git init --bare --initial-branch=<default>` + `remote add origin` +
`config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'`, with
`remote.origin.mirror` explicitly unset (`init --bare` leaves it set in some git
versions, and the pin is worthless if it does not). Pruning is then confined to
`refs/remotes/origin/*`, and a start point reads `refs/remotes/origin/<branch>`
rather than `refs/heads/<branch>`. Every observable property D1 claims — one bare
per-project mirror, shared objects, no cross-project link — is unchanged.

**D4's sequence needs one step this record does not contain** (contract deviation
D22, `TestRePrepareAfterReleaseResumesTheRunRef`). `git worktree add -b
<scope-id>/<name>` is right for a *first* prepare and wrong for every later one:
release deliberately keeps the run refs (that is D1's point), so on turn two the
branch exists and the worktree does not, and git answers

```
fatal: a branch named '<scope-id>/<name>' already exists
```

which would make every resumed conversation permanently unstartable — a failure
that cannot be observed on turn one and so cannot be caught by a test that only
prepares once. Prepare now reads `refs/heads/<scope-id>/<name>` back first; when
it exists, the worktree is added **on that ref** and `base_commit` becomes the
previous turn's commit rather than the branch head. The `clone` mode's equivalent
(`checkout -b` after `clone`) needed the same split.

Everything else in the implementation follows the record as written: the admin
directory is read back with `rev-parse --absolute-git-dir` (D4, probes G1b/G1c —
`git worktree list --porcelain` emitted no `gitdir:` line at all on git 2.56.0 and
2.39.5, so G1c's read replaced G1b's mechanism before this note was written); the
reflog directory is pre-created (P7); exclusions are project-scoped in
`<mirror>/info/exclude` and re-filtered in code (D6, X1/X3/X4); no path is ever
placed under `/tmp` (D5); and the four-path commit axis was measured rather than
inferred, then confirmed live when a sandboxed agent under `required` mode wrote
exactly its own ref:

```
refs/heads/01a13eaa-bf85-…/projA → 464ecb68
  Communication Worker <worker@communication.invalid> m3 projA
  ls-tree: .env  MARKER_projA.txt  README.md
```
