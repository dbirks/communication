#!/usr/bin/env bash
# M0 workspace spike: multi-repo run workspaces from worker-managed mirrors,
# isolation between runs, git write-set outside the worktree (sandbox policy
# input), and claude/codex harness behaviour inside the layout from
# communication-spec/05-workspaces-security-secrets.md ("Workspace design").
#
# Usage:  bash run.sh [--skip-harness]
# Root:   $HOME/.cache/communication-lab/m0-worktree/ (wiped at start)
# Output: one "CHECK <id> <PASS|FAIL|GAP> <observation>" line per check to
#         stdout; W3 write-set paths as "W3PATH <path>" lines.
set -euo pipefail

ROOT="${M0_ROOT:-$HOME/.cache/communication-lab/m0-worktree}"
SKIP_HARNESS=0
for a in "$@"; do
  case "$a" in
    --skip-harness) SKIP_HARNESS=1 ;;
    *) echo "unknown arg: $a" >&2; exit 2 ;;
  esac
done

# Deterministic lab identity; never touches the user's global git config.
export GIT_CONFIG_COUNT=2
export GIT_CONFIG_KEY_0=user.name  GIT_CONFIG_VALUE_0=communication-lab
export GIT_CONFIG_KEY_1=user.email GIT_CONFIG_VALUE_1=lab@communication.invalid
export GIT_TERMINAL_PROMPT=0

check() { # check <id> <PASS|FAIL|GAP> <observation...>
  printf 'CHECK %s %s %s\n' "$1" "$2" "$(printf '%s' "$3" | tr '\n\t' ' ; ')"
}

mirror() { printf '%s/repos/%s.git' "$ROOT" "$1"; }
wt()     { printf '%s/workspaces/%s/repos/%s' "$ROOT" "$1" "$2"; }

# ---------------------------------------------------------------- origins ---
rm -rf "$ROOT"
mkdir -p "$ROOT/origins" "$ROOT/repos" "$ROOT/workspaces"

seed_repo() { # seed_repo <name>
  local name="$1" d="$ROOT/.seed/$1"
  mkdir -p "$d"
  git init -q -b main "$d"
  printf '# %s\nSeed repo for the M0 workspace spike.\n' "$name" > "$d/README.md"
  printf '%s line one\n' "$name" > "$d/app.txt"
  git -C "$d" add -A
  git -C "$d" commit -qm "seed $name"
  git clone --bare -q "$d" "$ROOT/origins/$name.git"
}
seed_repo frontend
seed_repo backend

# ---------------------------------------------------------------- mirrors ---
for name in frontend backend; do
  git clone --mirror -q "$ROOT/origins/$name.git" "$(mirror "$name")"
done

add_wt() { # add_wt <run-id> <repo> — one linked worktree per repo per run
  local run="$1" name="$2" dir
  dir="$(wt "$run" "$name")"
  mkdir -p "$ROOT/workspaces/$run/repos" "$ROOT/workspaces/$run/scratch" \
           "$ROOT/workspaces/$run/meta"
  git --git-dir="$(mirror "$name")" worktree add -q -b "$run/$name" "$dir" main
}
add_wt run-1 frontend; add_wt run-1 backend
add_wt run-2 frontend; add_wt run-2 backend

# -------------------------------------------------------------------- W1 ----
w1_fail=0
for run in run-1 run-2; do
  for name in frontend backend; do
    d="$(wt "$run" "$name")"
    branch=$(git -C "$d" rev-parse --abbrev-ref HEAD 2>/dev/null || echo MISSING)
    if [ ! -d "$d" ] || [ "$branch" != "$run/$name" ]; then
      w1_fail=1; echo "W1 bad: $d branch=$branch" >&2
    fi
  done
done
if [ "$w1_fail" -eq 0 ]; then
  check W1 PASS "all 4 run worktrees exist on their run branches (run-N/name from mirror main)"
else
  check W1 FAIL "layout/branch mismatch, see stderr echoes above"
fi

# ------------------------------------- W2 isolation (test case 17) + W3 ----
marker="$ROOT/w3-marker"
touch "$marker"
b1="$(wt run-1 backend)"
printf 'BACKEND-EDIT run-1\n' >> "$b1/app.txt"
git -C "$b1" add app.txt
git -C "$b1" commit -qm "run-1 backend change"

# W3: paths OUTSIDE the worktree that the commit wrote (inside the mirror).
# Captured BEFORE any other git command touches the mirror.
w3_list=$(find "$(mirror backend)" -newer "$marker" | sed "s|^$ROOT/||" | sort)
if [ -n "$w3_list" ]; then
  while IFS= read -r p; do printf 'W3PATH %s\n' "$p"; done <<<"$w3_list"
  n=$(printf '%s\n' "$w3_list" | wc -l)
  check W3 PASS "$n paths inside shared mirror repos/backend.git changed during the run-1 commit (listed as W3PATH lines above): objects + refs + worktrees/<id>/ metadata; an agent allowed to commit needs write access to the SHARED mirror"
else
  check W3 GAP "find -newer captured no changed paths — snapshot method failed"
fi

b2="$(wt run-2 backend)"
w2_ok=1
grep -q 'BACKEND-EDIT' "$b2/app.txt" && w2_ok=0
[ -n "$(git -C "$b2" status --porcelain)" ] && w2_ok=0
if [ "$w2_ok" -eq 1 ]; then
  check W2 PASS "run-1 committed app.txt; run-2/repos/backend/app.txt unchanged and status --porcelain empty"
else
  check W2 FAIL "run-2 checkout saw run-1's change or became dirty"
fi

# -------------------------------------------------------------------- W4 ----
if w4out=$(git -C "$b2" log --oneline run-1/backend 2>&1); then
  check W4 PASS "run-2 CAN read run-1's branch via shared mirror: git log --oneline run-1/backend -> $(printf '%s' "$w4out" | tr '\n' ';' | head -c 120)"
else
  check W4 FAIL "run-2 could not resolve run-1/backend: $w4out"
fi

# -------------------------------------------------------------------- W5 ----
mkdir -p "$ROOT/copied"
cp -a "$(wt run-1 backend)" "$ROOT/copied/backend"
mv "$(mirror backend)" "$(mirror backend).moved"
w5_err=""
if git -C "$ROOT/copied/backend" status >/dev/null 2>&1; then
  w5_rc=0
else
  w5_rc=$?
  w5_err=$( { git -C "$ROOT/copied/backend" status 2>&1 || true; } | head -2 | tr '\n' ';')
fi
mv "$(mirror backend).moved" "$(mirror backend)"
if [ "$w5_rc" -ne 0 ]; then
  check W5 PASS "copied worktree broken without mirror (git status exit $w5_rc: $w5_err) — confirms 05 'a copied worktree alone is not portable'"
else
  check W5 FAIL "copied worktree still worked with mirror moved aside — spec warning not reproduced"
fi

# -------------------------------------------------------------------- W6 ----
git --git-dir="$(mirror backend)" worktree remove --force "$b2"
git --git-dir="$(mirror backend)" worktree prune
wtl=$(git --git-dir="$(mirror backend)" worktree list)
w6_ok=1
printf '%s' "$wtl" | grep -q 'run-2/repos/backend' && w6_ok=0
[ -z "$(git -C "$b1" status --porcelain)" ] && git -C "$b1" log --oneline -1 >/dev/null 2>&1 || w6_ok=0
if [ "$w6_ok" -eq 1 ]; then
  check W6 PASS "worktree remove+prune dropped run-2 entry; run-1/backend intact; remaining: $(printf '%s' "$wtl" | tr '\n' ';')"
else
  check W6 FAIL "prune left run-2 entry or run-1 broken; worktree list: $(printf '%s' "$wtl" | tr '\n' ';')"
fi

# ---------------------------------------------------------- harness runs ----
if [ "$SKIP_HARNESS" -eq 1 ]; then
  check H1 GAP "--skip-harness given"
  check H2 GAP "--skip-harness given"
  exit 0
fi

PROMPT='Append the line FRONTEND-EDIT to repos/frontend/app.txt and the line BACKEND-EDIT to repos/backend/app.txt. Do not modify any other file. Reply DONE.'

verify_edits() { # verify_edits <run-id> — echoes ok or a failure description
  local run="$1" f b nf nb pf pb
  f="$(wt "$run" frontend)"; b="$(wt "$run" backend)"
  nf=$(grep -c '^FRONTEND-EDIT$' "$f/app.txt" 2>/dev/null || true)
  nb=$(grep -c '^BACKEND-EDIT$' "$b/app.txt" 2>/dev/null || true)
  [ "${nf:-0}" = 1 ] || { echo "frontend app.txt has $nf FRONTEND-EDIT lines (want 1)"; return; }
  [ "${nb:-0}" = 1 ] || { echo "backend app.txt has $nb BACKEND-EDIT lines (want 1)"; return; }
  pf=$(git -C "$f" status --porcelain); pb=$(git -C "$b" status --porcelain)
  [ "$pf" = " M app.txt" ] || { echo "frontend status: '$pf' (want only ' M app.txt')"; return; }
  [ "$pb" = " M app.txt" ] || { echo "backend status: '$pb' (want only ' M app.txt')"; return; }
  # run-1 (frontend untouched all spike; backend committed in W2) must be intact
  [ -z "$(git -C "$(wt run-1 frontend)" status --porcelain)" ] || { echo "run-1 frontend dirty"; return; }
  [ -z "$(git -C "$(wt run-1 backend)" status --porcelain)" ] || { echo "run-1 backend dirty"; return; }
  echo ok
}

# -------------------------------------------------------------------- H1 ----
add_wt run-3 frontend; add_wt run-3 backend
printf 'CMD H1 (cwd %s/workspaces/run-3): claude -p --permission-mode acceptEdits "<PROMPT>"\n' "$ROOT"
h1obs=""
if cd "$ROOT/workspaces/run-3" && timeout 300 claude -p --permission-mode acceptEdits "$PROMPT" >"$ROOT/h1.log" 2>&1; then
  h1obs=$(verify_edits run-3)
  if [ "$h1obs" = ok ]; then
    check H1 PASS "claude 2.1.300 -p --permission-mode acceptEdits from run root (cwd not a git repo): both app.txt gained exactly the required line, statuses show only app.txt, run-1 untouched"
  else
    check H1 FAIL "claude ran (rc=0) but edits wrong: $h1obs"
  fi
else
  h1rc=$?
  # retry up to twice
  h1done=0
  for i in 2 3; do
    if cd "$ROOT/workspaces/run-3" && timeout 300 claude -p --permission-mode acceptEdits "$PROMPT" >>"$ROOT/h1.log" 2>&1; then h1done=1; break; fi
    h1rc=$?
  done
  if [ "$h1done" = 1 ]; then
    h1obs=$(verify_edits run-3)
    [ "$h1obs" = ok ] && check H1 PASS "claude succeeded on retry; both edits verified, run-1 untouched" || check H1 FAIL "claude rc=0 on retry but edits wrong: $h1obs"
  else
    err=$(tail -c 400 "$ROOT/h1.log" | tr '\n' ';' | head -c 300)
    if [ "$h1rc" = 124 ]; then check H1 GAP "claude timed out after 300s x3 attempts; last output: $err"
    else check H1 GAP "claude exited rc=$h1rc after 3 attempts; literal error: $err"; fi
  fi
fi

# -------------------------------------------------------------------- H2 ----
# codex-cli 0.162.1 REMOVED --full-auto ("unexpected argument"). Nearest
# documented equivalent for non-interactive auto-editing: --sandbox
# workspace-write (writes under -C dir allowed without approval prompts).
add_wt run-4 frontend; add_wt run-4 backend
H2CMD=(codex exec --skip-git-repo-check --sandbox workspace-write -C "$ROOT/workspaces/run-4" "$PROMPT")
printf 'CMD H2: %s\n' "${H2CMD[*]}"
if cd "$ROOT" && timeout 300 "${H2CMD[@]}" >"$ROOT/h2.log" 2>&1; then
  h2obs=$(verify_edits run-4)
  if [ "$h2obs" = ok ]; then
    check H2 PASS "codex 0.162.1 exec --skip-git-repo-check --sandbox workspace-write -C <run root>: both app.txt gained exactly the required line, statuses show only app.txt, run-1 untouched (exact cmd in results log header)"
  else
    check H2 FAIL "codex ran (rc=0) but edits wrong: $h2obs"
  fi
else
  h2rc=$?
  h2done=0
  for i in 2 3; do
    if cd "$ROOT" && timeout 300 "${H2CMD[@]}" >>"$ROOT/h2.log" 2>&1; then h2done=1; break; fi
    h2rc=$?
  done
  if [ "$h2done" = 1 ]; then
    h2obs=$(verify_edits run-4)
    [ "$h2obs" = ok ] && check H2 PASS "codex succeeded on retry; both edits verified, run-1 untouched" || check H2 FAIL "codex rc=0 on retry but edits wrong: $h2obs"
  else
    err=$(tail -c 400 "$ROOT/h2.log" | tr '\n' ';' | head -c 300)
    if [ "$h2rc" = 124 ]; then check H2 GAP "codex timed out after 300s x3 attempts; last output: $err"
    else check H2 GAP "codex exited rc=$h2rc after 3 attempts; literal error: $err"; fi
  fi
fi
