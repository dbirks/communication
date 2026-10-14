# workspace probe (M0)

Spike for roadmap item "Validate worktree layouts for two repos and whether
selected harness can work there" (`11-build-roadmap.md`), against
`05-workspaces-security-secrets.md` "Workspace design" /
"Checkpoint/recovery policy" and `12-test-strategy.md` case 17.

## What it does

`run.sh` builds the spec layout under `$HOME/.cache/communication-lab/m0-worktree/`
(wiped at start):

```
origins/<name>.git            # stand-in "remotes"
repos/<name>.git              # worker-managed mirrors (05: /var/lib/communication/repos)
workspaces/<run-id>/
  repos/<name>/               # linked worktree on branch <run-id>/<name>
  scratch/
  meta/
```

Two runs (`run-1`, `run-2`) × two repos (`frontend`, `backend`), then:

| id | proves |
|----|--------|
| W1 | layout + run branches exist |
| W2 | test case 17: a commit in run-1 doesn't touch run-2's checkout |
| W3 | exactly which paths **outside** the worktree a commit writes (sandbox policy input; printed as `W3PATH` lines) |
| W4 | cross-run branch readability through the shared mirror |
| W5 | `cp -a` of a worktree is not portable without the mirror (05 warning) |
| W6 | `worktree remove` + `prune` clean-up doesn't disturb other runs |
| H1 | `claude -p --permission-mode acceptEdits` edits two checkouts from the run root |
| H2 | same with `codex exec` (see note: `--full-auto` no longer exists) |

## Run

```bash
bash docs/compatibility/probes/workspace/run.sh > docs/compatibility/probes/workspace/results.txt 2>&1
```

Pass `--skip-harness` to skip the (network/LLM-dependent) H1/H2 checks.
Harness logs land in `$HOME/.cache/communication-lab/m0-worktree/h{1,2}.log`
(cache only, never committed). Each CLI gets at most 3 attempts of 300 s.

Observed results: see `results.txt` (each check is one
`CHECK <id> <PASS|FAIL|GAP> <observation>` line) and
`docs/compatibility/WORKSPACES.md` for the interpretation.
