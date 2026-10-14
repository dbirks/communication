# ADR-0010 — Worker-managed mirrors are per-project; runs get linked worktrees

- **Date:** 2026-10-14
- **Status:** **Proposed** (D-024 remains Open; acceptance needs the checks below)
- **Owners:** project owner
- **Related decisions / contracts:** D-008 (**Accepted**, per-run worktree by default), D-024
  (**Open**, checkpoint strategy), D-025 (**Open**, trust model), D-011/ADR-0009 (sandbox grants),
  ADR-0008 (staging exclusions in the checkout), 05 § "Workspace design" / "Checkpoint/recovery
  policy", 12-test-strategy case 17. Evidence: `docs/compatibility/WORKSPACES.md` and
  `docs/compatibility/probes/workspace/`.

## Context

05 puts a Run Workspace at `/var/lib/communication/workspaces/<run-id>/` with `repos/<name>/` as a
"dedicated linked worktree or clone", treats `/var/lib/communication/repos` mirrors as worker-managed,
and warns that linked worktrees share Git common metadata so "a copied worktree alone is not portable".
D-008 (Accepted) makes a per-run worktree the default and shared writable workspaces an explicit
opt-in. What the spec does not decide is the **scope of the mirror** a worktree links to — the object
group, ref group and admin directory a commit touches but the agent never sees as files — nor what a
sandbox policy must therefore grant. D-024 (checkpoint portability) and D-025 (whether two projects
are mutually untrusted on the same worker) both hinge on that.

The M0 workspace probe (2026-10-14, `git 2.56.0`, `claude 2.1.300`, `codex-cli 0.162.1`, 2 runs × 2
repos) measured it: the layout builds and run branches exist (W1); a commit in `run-1` left
`run-2/repos/backend/app.txt` unchanged with an empty `status --porcelain` (W2 = test case 17); a
commit from inside a worktree wrote **19 paths outside the worktree, all inside the shared mirror**
(W3: loose objects, `refs/heads/run-1/backend` + reflog, `worktrees/backend/{index,COMMIT_EDITMSG,logs/HEAD}`);
from `run-2`, `git log --oneline run-1/backend` **succeeded** (W4); a `cp -a` copy died with
`fatal: gitfile does not point to a valid repository` once the mirror moved aside (W5); and both
harnesses edited two checkouts from the run root — `claude -p --permission-mode acceptEdits` (H1) and
`codex exec --skip-git-repo-check --sandbox workspace-write -C <run root>` (H2, after `--full-auto`
was found removed in 0.162.1).

## Options considered

| Option | Advantages | Disadvantages | Evidence |
|---|---|---|---|
| A. One global mirror per repo URL, worktrees for every run | Least disk, one fetch per repo per worker, simplest gc | The shared writable path spans **projects**: any run with mirror write access can read (observed) and write other runs' refs/objects; a single project's grant reaches every project's branches | WORKSPACES.md W4 ("run-2 CAN read run-1's branch via shared mirror"), W3 write-set; 05 "Trust caveat" |
| **B (selected).** **Per-project mirrors** (`/var/lib/communication/repos/<project-id>/<name>.git`, never shared across projects) + **per-run linked worktrees** (D-008) | Keeps D-008 and the 05 layout exactly; W1/W2/H1/H2 show edits and commits stay isolated *within* a project; blast radius of the shared metadata path is one trust scope, matching the credential scope a worker already has | Commit capability requires deliberate rw grants into the project mirror (W3), so mirror paths must be enumerated per project and never globally; disk and fetch cost scale with project × repo | WORKSPACES.md W1, W2, W3 write-set, H1, H2; 05 § "Workspace design"; 12 case 17 |
| C. Per-run full clones (mirror used only as a fetch source) | No shared writable path at all; each run's `objects/`/`refs/` are private, so W4 disappears; worktree-portability caveat (W5) moot | Disk and `gc` duplication per run; loses cheap intra-project parallelism and the shared-object basis for checkpoint/prune (W6) that D-008 assumes; slow workspace creation for large repos | WORKSPACES.md candidate mitigation (a) "isolates write-set, costs disk and `gc` duplication"; W5, W6 |
| D. Linked worktrees + agent commits forbidden; worker commits checkpoints worker-side | Minimal agent grants (worktree rw only), no mirror write policy at all | Harnesses observed editing without commit rights (H1/H2 dirty-only), so this is feasible, but agent-authored history, bisect and mid-run recovery from the agent's own commits are lost — and the spec's checkpoint model is diff/bundle based, not commit based | WORKSPACES.md candidate mitigation (c); "Checkpoint/recovery policy" (05) |

## Decision

Option **B**, with **C** available per project:

1. **Mirrors are per project.** `/var/lib/communication/repos/<project-id>/<name>.git`, worker-managed
   (05). A mirror is **never** shared between projects, and never between trust scopes, even for the
   same repo URL. Namespace by project first, repo second.
2. **Runs get linked worktrees** off that project's mirror on branch `<run-id>/<name>` (W1), which is
   D-008's default; shared writable workspaces stay an explicit opt-in.
3. **Commit is a separate, explicit grant axis.** Sandbox policy grants rw on the run workspace plus,
   for that project's mirror only, the W3 set: `objects/`, `refs/heads/<run-id>/*` and their reflogs,
   and `worktrees/<worktree-id>/` — nothing from another project's mirror. Runs that need no commits
   get none (H1/H2 prove edits work without commit rights).
4. **Cross-project isolation never relies on worktrees.** Worktrees isolate *edit races* inside one
   project's credential scope (W1/W2); separation between mutually untrusted projects comes from
   distinct Unix identity / separate worker credential scope / OCI or VM (D-025, 05 "Trust caveat",
   ADR-0009), not from directory layout.
5. **Untrusted projects get per-run full clones** as a per-project workspace mode (Option C), paid for
   in disk and fetch time.
6. **Cleanup**: `git worktree remove --force` + `prune` per run (W6 showed this leaves other runs
   intact); mirror `gc` is worker-owned and never runs inside an attempt.
7. **Checkpoints are bundles/refs or captured diffs, never copied worktree directories** (W5) — the
   answer D-024 must stay consistent with. **Harness launch cwd is the run root** (H1/H2, codex needs
   `--skip-git-repo-check`); ADR-0008 staging paths are excluded from any diff or commit here.

## Consequences

- Positive: D-008 stands unchanged, and the spec layout is confirmed workable by two real harnesses.
- Positive: the "shared writable path" that W3 exposes is confined to one project, so W4-style
  cross-run visibility is a same-trust-domain property rather than a cross-tenant one.
- Cost: mirror disk, fetch and `gc` work multiply by project; the same repo in ten projects is ten
  object stores on one worker.
- Cost: sandbox policy for a committing run is no longer "the workspace plus nothing" — it names paths
  inside a git directory, where a wrong path is a corruption or disclosure bug, not a clean denial.
- Limitation: W4 remains *within* a project — one project's runs can see each other's branches; that
  is accepted as in-scope visibility, not isolation.
- Limitation: per-run full clones are offered but unprobed; their cost has no measurement yet.

## Security/privacy

The mirror is the security-relevant object here: a writable mirror path is a write into every worktree
that shares it. W3 shows the exact minimal write-set of a single commit; granting it is therefore
granting authority over that project's history on that worker, and the ADR bounds it by project rather
than by run. Poisoning risk is real and stated in WORKSPACES.md ("one project's agent could enumerate
or poison another run's branches") — the mitigation is project scoping plus Option C for untrusted
projects, not path tricks (git cannot namespace `objects/`/`refs/` grants, candidate (d)). Secrets do
not move here, but `.env`-style files materialized later inside the worktree fall under ADR-0009's rule
that Linux `filesystem.deny` is point-in-time. Fail-closed position: if the project mirror path cannot
be resolved and normalized server-side (05 rejects traversal/symlink/relative paths as ACL proof), the
attempt does not start. All of this stays *within* the single-Unix-user trust caveat — none of it is a
tenant-isolation claim (D-025).

## Verification

Observed 2026-10-14 (`bash probes/workspace/run.sh` → `results.txt`): **W1** PASS (4 worktrees on run
branches), **W2** PASS (case 17 — run-1 commit did not touch run-2), **W3** PASS (captured) — 19 mirror
paths changed, listed verbatim in WORKSPACES.md, **W4** PASS (observed) — cross-run branch read
succeeds, **W5** PASS — copied worktree broken without the mirror (exit 128), **W6** PASS
(remove+prune), **H1/H2** PASS (both harnesses edited two checkouts from the run root, dirty-only).

Not tested, listed explicitly: concurrent mirrors/gc against live worktrees; agent commits *through* a
nono sandbox with the Decision 3 grants (W3 and the sandbox matrix were measured separately and never
together — the key missing integration check); cross-project enforcement of project-scoped grants with
a real `SandboxPolicy`; per-run full-clone cost on a large repository; mirror or mid-fetch failure
recovery; worker restart with orphaned worktrees (only W6's clean path was tested); multi-worker
mirror ownership; submodules or LFS; disk pressure and gc with many projects on one worker.

## Migration/rollback

Mirror scope is a filesystem layout choice on worker-local state: moving from a global mirror to
per-project mirrors is `git clone --mirror` per project plus a re-fetch, then deleting the global
mirror once no worktree references it (`git worktree list` per mirror is the audit). No API, database
schema or wire format changes, so runs and checkpoints are unaffected. Switching a project from
worktrees to per-run full clones is a workspace-mode flag, reversible per new run. Rollback of the
commit grant is immediate: revoke the mirror paths and the run continues in dirty-only mode as H1/H2
observed — with uncommitted work recoverable only by the 05 checkpoint path, so the worker must capture
the diff before dropping the grant. D-024 remains Open and this ADR constrains it only by ruling out
copied worktree directories (W5).
