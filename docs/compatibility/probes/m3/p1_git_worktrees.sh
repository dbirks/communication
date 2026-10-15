#!/usr/bin/env bash
# m3 probe 1 — git worktree/mirror/exclusion claims behind ADR-0017 and the
# M3 contract (P1 read-back, P7 pre-create, W5/W6, X1/X2/X3/X5, case-17 shape).
# No sandbox here: these are git-behaviour claims, measured the same way in the
# host and in the worker image (the images carry different git versions:
# host 2.56.0, node:22-bookworm-slim 2.39.5).
#
# Usage: bash p1_git_worktrees.sh [--fixture <dir>] [--keep]
set -uo pipefail
M3_PROBE=p1_git_worktrees
M3_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$M3_DIR"
# shellcheck source=lib.sh
. ./lib.sh
M3_FIXTURE="${M3_FIXTURE_ARG:-${M3_PROBE_ROOT_BASE}/p1}"
m3_args "$@"
mkdir -p "$M3_FIXTURE"
m3_git_identity
m3_env_header

rm -rf "$M3_FIXTURE"; mkdir -p "$M3_FIXTURE"/{origins,repos,workspaces}
m3_seed_origin backend
m3_seed_origin frontend
MBAK="$(m3_mirror projA backend)"
MFRONT="$(m3_mirror projA frontend)"
m3_make_mirror projA backend frontend
for id in run-1 run-2; do
    m3_add_worktree run "$id" projA backend
    m3_add_worktree run "$id" projA frontend
done

# ---- G1a: same-repo worktree admin dirs collide and git auto-suffixes (P1) --
a1="$(m3_admin_dir "$(m3_ws run run-1)/repos/backend")"
a2="$(m3_admin_dir "$(m3_ws run run-2)/repos/backend")"
if [ "$(basename "$a1")" = backend ] && [ "$(basename "$a2")" = backend1 ]; then
    check G1 PASS "ADR-0017 P1 re-derived: admin dirs are $(basename "$a1")/$(basename "$a2") for two worktrees of one repo — the second is auto-suffixed, so the admin path is NOT derivable from the layout"
else
    check G1 FAIL "admin dirs were '$(basename "$a1")'/'$(basename "$a2")' — ADR-0017 P1 (auto-suffix) did not reproduce"
fi

# ---- G1b: the read-back mechanism the ADR names -----------------------------
# ADR-0017 D4 says to read `gitdir:` from `git worktree list --porcelain`.
porcelain="$(git --git-dir="$MBAK" worktree list --porcelain)"
if printf '%s' "$porcelain" | grep -q '^gitdir '; then
    check G1b PASS "git worktree list --porcelain printed gitdir: lines (admin dir readable back as the ADR says): $(printf '%s' "$porcelain" | grep '^gitdir ' | m3_oneline)"
else
    check G1b FAIL "ADR-0017 D4's stated mechanism is wrong for this git: 'git worktree list --porcelain' emitted NO gitdir line at all ($(printf '%s' "$porcelain" | grep -c . ) lines, members: $(printf '%s' "$porcelain" | grep -v '^[a-z]* ' | awk -F' ' '{print $1}' | sort -u | tr '\n' ',')) — the admin dir must be resolved with 'git -C <worktree> rev-parse --absolute-git-dir' (which did return $(basename "$a2"))"
fi

# ---- G1c: the mechanism that DOES read the admin dir back -------------------
dotgit="$(cat "$(m3_ws run run-2)/repos/backend/.git" 2>&1 | m3_oneline)"
if printf '%s' "$dotgit" | grep -q 'gitdir:' && [ "$(printf '%s' "$dotgit" | sed -e 's/^gitdir: *//' -e 's/ *$//')" = "$a2" ]; then
    check G1c PASS "the admin dir IS readable back — from the worktree's .git file: '$dotgit' == rev-parse --absolute-git-dir ($a2). This is the read-back ADR-0017 D4 should name"
else
    check G1c FAIL "'.git' file read-back did not match rev-parse: '$dotgit' vs $a2"
fi

# ---- G2: reflog namespace must be pre-created before a confined commit (P7) --
# Measured without a sandbox here: git creates logs/refs/heads/<scope>/ lazily,
# which is only a problem under a narrow grant set (proved in p2). This check
# records whether the directory exists after the first commit on a new scope.
git --git-dir="$MBAK" worktree list >/dev/null
if [ -d "$MBAK/logs/refs/heads/run-1" ]; then
    check G2 GAP "logs/refs/heads/run-1 already exists after worktree add — P7's pre-create requirement cannot be isolated unsandboxed (it is asserted under the sandbox in p2 C-P7)"
else
    check G2 GAP "logs/refs/heads/run-1 does not exist after worktree add+commit unsandboxed (git created it lazily) — the pre-create requirement is a sandbox-only failure, asserted in p2 C-P7"
fi

# ---- G3: exclusion via the per-worktree info/exclude is ignored (X1) --------
GDIR="$(git -C "$(m3_ws run run-1)/repos/backend" rev-parse --absolute-git-dir)"
mkdir -p "$GDIR/info"
printf '.env.test.local\n' >> "$GDIR/info/exclude"
printf 'SENTINEL-m3-p1-database_url=postgres://probe\@probe/db\n' > "$(m3_ws run run-1)/repos/backend/.env.test.local"
ci_rc=0; ci="$(git -C "$(m3_ws run run-1)/repos/backend" check-ignore -v .env.test.local 2>&1)" || ci_rc=$?
st="$(git -C "$(m3_ws run run-1)/repos/backend" status --porcelain)"
if [ "$ci_rc" -ne 0 ] && printf '%s' "$st" | grep -q '\.env\.test\.local'; then
    check G3 PASS "ADR-0017 X1 re-derived: rule in \$(git-dir)/info/exclude ($GDIR) is ignored — check-ignore exit=$ci_rc, status still lists $st"
else
    check G3 FAIL "per-worktree exclude appeared to work (check-ignore rc=$ci rc, out=$ci, status=$st) — X1 does not hold for this git"
fi

# ---- G4: the common (mirror) info/exclude IS honored (X2) -------------------
mkdir -p "$MBAK/info"
printf '.env.test.local\n' >> "$MBAK/info/exclude"
ci2="$(git -C "$(m3_ws run run-1)/repos/backend" check-ignore -v .env.test.local 2>&1)"; ci2rc=$?
st2="$(git -C "$(m3_ws run run-1)/repos/backend" status --porcelain)"
if [ "$ci2rc" -eq 0 ] && printf '%s' "$ci2" | grep -q "$MBAK/info/exclude" && ! printf '%s' "$st2" | grep -q '\.env'; then
    check G4 PASS "ADR-0017 X2 re-derived: same rule in <mirror>/info/exclude is honored — check-ignore says '$ci2'; status now '$st2'"
else
    check G4 FAIL "mirror info/exclude not honored (rc=$ci2rc out=$ci2 status=$st2)"
fi

# ---- G5: the exclusion is project-scoped, not per-run (X5) ------------------
printf 'SENTINEL-m3-p1-database_url=postgres://probe\@probe/db\n' > "$(m3_ws run run-2)/repos/backend/.env.test.local"
st3="$(git -C "$(m3_ws run run-2)/repos/backend" status --porcelain)"
ci3="$(git -C "$(m3_ws run run-2)/repos/backend" check-ignore -v .env.test.local 2>&1)"
if ! printf '%s' "$st3" | grep -q '\.env' && printf '%s' "$ci3" | grep -q "$MBAK/info/exclude"; then
    check G5 PASS "ADR-0017 X5 re-derived: run-2's file at the same relative path is ignored by run-1's declaration — status '$st3'; the exclusion's scope is the project mirror, not the mount"
else
    check G5 FAIL "exclusion leaked per-run scope (status=$st3 check-ignore=$ci3)"
fi

# ---- G6: extensions.worktreeConfig breaks git in this layout (X3) -----------
git -C "$(m3_ws run run-1)/repos/backend" config extensions.worktreeConfig true
git -C "$(m3_ws run run-1)/repos/backend" config --worktree core.excludesFile "$(m3_ws run run-1)/repos/backend/.customignore" 2>/dev/null
x3out="$(git -C "$(m3_ws run run-1)/repos/backend" status --porcelain 2>&1)"; x3rc=$?
git -C "$(m3_ws run run-1)/repos/backend" config --unset extensions.worktreeConfig 2>/dev/null || true
if [ "$x3rc" -ne 0 ]; then
    check G6 PASS "ADR-0017 X3 re-derived: with extensions.worktreeConfig=true, git status fails exit=$x3rc: '$x3out' (unset restored normal: '$(git -C "$(m3_ws run run-1)/repos/backend" status --porcelain | m3_oneline)')"
else
    check G6 FAIL "worktreeConfig route WORKS on this git (status exit=0 '$x3out') — ADR-0017 D6's rejection of per-worktree config needs restating for this version"
fi

# ---- G7: case-17 isolation between two live worktrees (W2 shape) ------------
b1="$(m3_ws run run-1)/repos/backend"; b2="$(m3_ws run run-2)/repos/backend"
printf 'BACKEND-EDIT run-1\n' >> "$b1/app.txt"
git -C "$b1" add app.txt && git -C "$b1" commit -qm "run-1 change"
if ! grep -q 'BACKEND-EDIT' "$b2/app.txt" && [ -z "$(git -C "$b2" status --porcelain)" ]; then
    check G7 PASS "case-17 shape re-derived unsandboxed: run-1 committed app.txt, run-2 file unchanged and status empty"
else
    check G7 FAIL "run-2 saw run-1's change (status=$(git -C "$b2" status --porcelain | m3_oneline))"
fi

# ---- G8: a copied worktree is not portable (W5) -----------------------------
mkdir -p "$M3_FIXTURE/copied"
cp -a "$b1" "$M3_FIXTURE/copied/backend"
mv "$MBAK" "${MBAK}.moved"
cp_err="$(git -C "$M3_FIXTURE/copied/backend" status 2>&1)"; cprc=$?
mv "${MBAK}.moved" "$MBAK"
if [ "$cprc" -ne 0 ]; then
    check G8 PASS "WORKSPACES W5 re-derived: copied worktree without its mirror fails exit=$cprc: '$cp_err'"
else
    check G8 FAIL "copied worktree still worked with the mirror moved aside"
fi

# ---- G9: worktree remove + prune (W6) ---------------------------------------
git --git-dir="$MBAK" worktree remove --force "$(m3_ws run run-2)/repos/backend"
git --git-dir="$MBAK" worktree prune
if git --git-dir="$MBAK" worktree list | grep -q 'run-2/repos/backend'; then
    check G9 FAIL "prune left the run-2 entry: $(git --git-dir="$MBAK" worktree list | m3_oneline)"
elif [ -n "$(git -C "$b1" status --porcelain)" ]; then
    check G9 FAIL "run-1 worktree broken/dirty after prune"
else
    check G9 PASS "WORKSPACES W6 re-derived: remove --force + prune dropped run-2; run-1 intact and clean ($(git --git-dir="$MBAK" worktree list | m3_oneline))"
fi

# ---- G10: concurrent Prepare against one mirror (ADR-0017's untested list) ---
rm -rf "$M3_FIXTURE/conc"; mkdir -p "$M3_FIXTURE/conc"
for i in 1 2 3 4 5 6; do
    ( git --git-dir="$MBAK" worktree add -q -b "conc-$i" "$M3_FIXTURE/conc/$i" main >"$M3_FIXTURE/conc/$i.err" 2>&1; echo "$?" > "$M3_FIXTURE/conc/$i.rc" ) &
done
wait
ok=0; errs=""
for i in 1 2 3 4 5 6; do
    [ "$(cat "$M3_FIXTURE/conc/$i.rc" 2>/dev/null)" = 0 ] && ok=$((ok+1))
    [ -s "$M3_FIXTURE/conc/$i.err" ] && errs="$errs [$i: $(m3_oneline < "$M3_FIXTURE/conc/$i.err")]"
done
listed="$(git --git-dir="$MBAK" worktree list | grep -c 'conc/')"
if [ "$ok" = 6 ] && [ "$listed" = 6 ]; then
    check G10 PASS "ADR-0017's untested item 'concurrent Prepare of two runs against one mirror': 6 parallel 'git worktree add -b' against one mirror all succeeded (rc=0 x6, $listed worktrees listed) on $(git --version | awk '{print $3}') — no index.lock/refs contention observed"
else
    check G10 FAIL "concurrent worktree add on $(git --version | awk '{print $3}'): $ok/6 succeeded, $listed listed in 'worktree list'; errors:$errs — the mirror's ref namespace is a real contention point that Prepare must serialize or retry"
fi

# ---- G10b: is serialization the sufficient remedy G10's FAIL asks for? ------
# Same mirror, same number of adds, one at a time.
rm -rf "$M3_FIXTURE/conc2"; mkdir -p "$M3_FIXTURE/conc2"
sok=0; serr=""
for i in 1 2 3 4 5 6; do
    if git --git-dir="$MBAK" worktree add -q -b "conc2-$i" "$M3_FIXTURE/conc2/$i" main >"$M3_FIXTURE/conc2/$i.err" 2>&1; then
        sok=$((sok+1))
    else
        serr="$serr [$i: $(m3_oneline < "$M3_FIXTURE/conc2/$i.err")]"
    fi
done
slisted="$(git --git-dir="$MBAK" worktree list | grep -c 'conc2/')"
if [ "$sok" = 6 ] && [ "$slisted" = 6 ]; then
    check G10b PASS "serialization is sufficient on $(git --version | awk '{print $3}'): the same 6 'git worktree add -b' against one mirror, run one at a time, all succeeded (rc=0 x6, $slisted listed) — Prepare needs a per-mirror mutex (or a lockfile), not a git upgrade"
else
    check G10b FAIL "even serialized, $sok/6 adds succeeded on $(git --version | awk '{print $3}'); errors:$serr — the contention is not fixed by ordering alone"
fi

m3_cleanup
exit 0
