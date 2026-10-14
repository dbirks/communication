# Workspace layout compatibility

Provenance: measured **2026-10-14** on the dev lab host with
`git version 2.56.0`, `claude 2.1.300 (Claude Code)`, `codex-cli 0.162.1`.
Rerun with:

```bash
bash docs/compatibility/probes/workspace/run.sh > docs/compatibility/probes/workspace/results.txt 2>&1
```

Raw evidence: `probes/workspace/results.txt` (`CHECK`/`W3PATH` lines).
Spec anchors: `05-workspaces-security-secrets.md` "Workspace design" /
"Checkpoint/recovery policy", `12-test-strategy.md` case 17, D-008
(per-run worktree by default).

## Results

| id | check | result | observation |
|----|-------|--------|-------------|
| W1 | layout: 4 worktrees on run branches | PASS | all `run-N/<name>` worktrees created from mirrors via `git --git-dir=repos/<name>.git worktree add -b <run>/<name> … main` |
| W2 | test case 17 isolation | PASS | commit in `run-1/repos/backend` left `run-2/repos/backend/app.txt` unchanged and `status --porcelain` empty |
| W3 | write-set outside worktree | PASS (captured) | 19 paths inside the shared mirror changed — see list below; **this is a security input, not a pass/fail** |
| W4 | cross-run ref reach | PASS (observed) | from `run-2/repos/backend`, `git log --oneline run-1/backend` **succeeds** — run-2 reads run-1's branch through the shared mirror |
| W5 | portability of copied worktree | PASS (spec warning confirmed) | `cp -a` copy fails once mirror is moved aside: `fatal: gitfile does not point to a valid repository` (exit 128) — "a copied worktree alone is not portable" holds |
| W6 | remove + prune cleanup | PASS | `worktree remove --force` + `prune` dropped the run-2 entry; run-1 worktree intact and clean |
| H1 | Claude edits two checkouts | PASS | `claude -p --permission-mode acceptEdits "<prompt>"` from the run root (cwd itself not a git repo): both `app.txt` files gained exactly the required line, each worktree shows only ` M app.txt`, run-1 untouched |
| H2 | Codex edits two checkouts | PASS | `codex exec --skip-git-repo-check --sandbox workspace-write -C <run root> "<prompt>"` — same verification as H1. Note: `--full-auto` was **removed** in codex-cli 0.162.1 (`error: unexpected argument '--full-auto' found`); `--sandbox workspace-write` is the documented equivalent and sufficed |

## W3 write-set, verbatim

`find repos/backend.git -newer <marker>` after committing in
`workspaces/run-1/repos/backend` (paths relative to probe root):

```
W3PATH repos/backend.git
W3PATH repos/backend.git/logs
W3PATH repos/backend.git/logs/refs
W3PATH repos/backend.git/logs/refs/heads
W3PATH repos/backend.git/logs/refs/heads/run-1
W3PATH repos/backend.git/logs/refs/heads/run-1/backend
W3PATH repos/backend.git/objects
W3PATH repos/backend.git/objects/5a
W3PATH repos/backend.git/objects/5a/a2045d71da402b05dd86de563e104a1914e95d
W3PATH repos/backend.git/objects/8d
W3PATH repos/backend.git/objects/8d/406ff99ba86c047925ee5bb3f18acd20e370f6
W3PATH repos/backend.git/objects/c2
W3PATH repos/backend.git/objects/c2/cbd3e2ca5b5f6a88bcbbefd69f740f36be321b
W3PATH repos/backend.git/refs/heads/run-1
W3PATH repos/backend.git/refs/heads/run-1/backend
W3PATH repos/backend.git/worktrees/backend
W3PATH repos/backend.git/worktrees/backend/COMMIT_EDITMSG
W3PATH repos/backend.git/worktrees/backend/index
W3PATH repos/backend.git/worktrees/backend/logs/HEAD
```

(Commit/tree/blob objects, the new branch ref `refs/heads/run-1/backend` +
its reflog, and the committing worktree's administrative directory
`worktrees/<id>/` — index, `COMMIT_EDITMSG`, HEAD reflog — all live in the
shared mirror, outside the agent-visible worktree directory.)

## Implications

*Flagged as input for an ADR — not decisions.*

- **Sandbox policy for a committing agent.** If an agent may `git commit`,
  read-only mounts of the worktree are insufficient: the policy must grant
  write access into the shared mirror (`repos/<name>.git/objects`,
  `refs/heads/<run>/*`, reflogs, and `worktrees/<id>/` for the agent's own
  worktree id). With per-run worktrees, the minimal-looking grant is still a
  **shared** writable path. Both harnesses edited files fine without commit
  rights (H1/H2 dirty-only), so commit capability should be an explicit,
  separately-granted policy axis rather than implicit.
- **Cross-run visibility risk.** With one mirror per repo, any run with
  mirror write access can read (W4: observed) and even write other runs'
  refs/objects — one project's agent could enumerate or poison another run's
  branches. Combined with the 05 trust caveat (shared Unix identity ≠
  tenant boundary), worktree-on-shared-mirror is only safe between runs the
  same credential scope may fully see each other.
- **Candidate mitigations to evaluate in an ADR:** (a) per-run `git clone`
  from the mirror instead of linked worktrees (isolates write-set, costs
  disk and `gc` duplication); (b) per-project (or per-trust-scope) mirror
  stores so a mirror is only shared within a trust domain; (c) keep
  worktrees for intra-project parallelism (D-008 default) and forbid agent
  commits into the mirror, having the worker commit/stage checkpoints
  worker-side; (d) namespace-restricted `objects/`+`refs/` grants — git does
  not support this natively, likely a non-starter.
- **Portability.** W5 confirms 05: linked worktrees are worker-local;
  cross-host recovery must ship checkpoint payloads as git bundles/refs or
  captured diffs, never copied worktree directories.
- **Harness cwd choice.** Both CLIs worked from the **run root** (a
  non-repo parent of two worktrees), matching the spec layout; codex needed
  `--skip-git-repo-check`, and claude `acceptEdits` was sufficient without
  any repo-root hint.
