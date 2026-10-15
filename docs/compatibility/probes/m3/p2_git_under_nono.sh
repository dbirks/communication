#!/usr/bin/env bash
# m3 probe 2 — the ADR-0017 grant set measured THROUGH a real nono sandbox on a
# real git worktree: P2/P3/P4/P5/P6/P7/P8/P10, X4, the commit write-set, and
# the "meta/ is never granted" claim.
#
# Usage: bash p2_git_under_nono.sh [--nono <path>] [--fixture <dir>] [--keep]
set -uo pipefail
M3_PROBE=p2_git_under_nono
M3_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$M3_DIR"
# shellcheck source=lib.sh
. ./lib.sh
M3_FIXTURE="${M3_FIXTURE_ARG:-${M3_PROBE_ROOT_BASE}/p2}"
m3_args "$@"
m3_env_header
command -v "$M3_NONO" >/dev/null 2>&1 || [ -x "$M3_NONO" ] || { check PREAMBLE GAP "nono not found at $M3_NONO"; exit 0; }

rm -rf "$M3_FIXTURE"; mkdir -p "$M3_FIXTURE"/{origins,repos,workspaces}
m3_git_identity
m3_seed_origin backend
m3_make_mirror projA backend
M="$(m3_mirror projA backend)"
for id in run-1 run-2 run-3; do m3_add_worktree run "$id" projA backend; done
W1="$(m3_ws run run-1)"; W2="$(m3_ws run run-2)"; W3="$(m3_ws run run-3)"
# Prepare, worker-side, unsandboxed (ADR-0017 D4): the reflog namespace git
# needs must exist BEFORE a confined commit. run-3 is deliberately left
# unprepared — it is the P7 case.
for id in run-1 run-2; do mkdir -p "$M/logs/refs/heads/$id"; done
mkdir -p "$M/logs/refs/heads/run-4"
# An existing-but-ungranted HOME, which is what P6 is actually about.
mkdir -p "$M3_FIXTURE/outside-home"
printf '[user]\n\tname = outsider\n\temail = outsider@x.invalid\n' > "$M3_FIXTURE/outside-home/.gitconfig"
B1="$W1/repos/backend"; B2="$W2/repos/backend"; B3="$W3/repos/backend"
A1="$(m3_admin_dir "$B1")"; A2="$(m3_admin_dir "$B2")"; A3="$(m3_admin_dir "$B3")"
note PATHS "mirror=$M run-1 wt=$B1 admin=$(basename "$A1") run-2 admin=$(basename "$A2")"

# The launcher's own HOME, deliberately OUTSIDE every workspace grant (see the
# H1 finding below: nono refuses a grant that overlaps its own state root).
export M3_HOME_LAUNCHER="$M3_FIXTURE/launcher-home"
mkdir -p "$M3_HOME_LAUNCHER"; chmod 700 "$M3_HOME_LAUNCHER"
M3_SB_HOME="$M3_HOME_LAUNCHER"

# Grant sets per ADR-0017 Decision 4, materialised into the GRANTS array.
grant_edit() { GRANTS=(--allow "$1" --read "$M"); }
grant_commit() { GRANTS=(--allow "$1" --read "$M" --allow "$M/objects"
    --allow "$M/refs/heads/$2" --allow "$M/logs/refs/heads/$2" --allow "$3"); }

# ---- C-P10: any git command in a linked worktree needs the mirror readable ---
M3_SB_CWD="$B1" m3_sb --allow "$W1" -- sh -c "HOME='$W1/home' git status --porcelain"
if [ "$M3_RC" -ne 0 ] && printf '%s' "$M3_OUT" | grep -qiE 'gitfile does not point to a valid repository|not a git repository'; then
    check C-P10 PASS "P10 re-derived: the worktree grant alone breaks git (exit=$M3_RC) — '$M3_OUT'"
elif [ "$M3_RC" -eq 0 ]; then
    check C-P10 FAIL "git worked with only the worktree granted (exit=0) — P10 does not reproduce"
else
    check C-P10 FAIL "git failed for a different reason than P10: exit=$M3_RC '$M3_OUT'"
fi
M3_SB_CWD="$B1" m3_sb --allow "$W1" --read "$M" -- sh -c "HOME='$W1/home' git log --oneline -1"
if [ "$M3_RC" -eq 0 ]; then check C-P10b PASS "adding 'ro <mirror>' fixes it: exit=0 '$M3_OUT'"; else check C-P10b FAIL "still broken: exit=$M3_RC '$M3_OUT'"; fi

# ---- C-P6: HOME outside the grants makes git abort ---------------------------
M3_SB_CWD="$B1" m3_sb --allow "$W1" --read "$M" -- sh -c "HOME='$M3_FIXTURE/outside-home' git -c user.name=x -c user.email=x@y status --porcelain"
if [ "$M3_RC" -ne 0 ] && printf '%s' "$M3_OUT" | grep -qi 'unable to access.*gitconfig\|error occurred while reading the configuration'; then
    check C-P6 PASS "ungranted HOME aborts git even with -c identity flags: exit=$M3_RC '$M3_OUT'"
else
    check C-P6 FAIL "git survived an ungranted HOME (exit=$M3_RC) '$M3_OUT' — P6 does not reproduce"
fi
M3_SB_CWD="$B1" m3_sb --allow "$W1" --read "$M" -- sh -c "HOME='$W1/home' git status --porcelain"
if [ "$M3_RC" -eq 0 ]; then
    check C-P6b PASS "HOME inside the grants (workspace home/) works: exit=0 '$M3_OUT'"
else
    check C-P6b FAIL "git broke with home/ inside the granted workspace: exit=$M3_RC '$M3_OUT'"
fi

# ---- C-H1: HOME=<workspace>/home handed to NONO itself (ADR-0019 D1 argv) ----
M3_RC=0
M3_OUT="$(cd "$B1" && env -i PATH="$PATH" HOME="$W1/home" "$M3_NONO" run -s --allow "$W1" --read "$M" -- sh -c 'true' 2>&1)" || M3_RC=$?
M3_OUT="$(printf '%s' "$M3_OUT" | m3_oneline)"
if [ "$M3_RC" -ne 0 ] && printf '%s' "$M3_OUT" | grep -qi 'Refusing to grant.*overlaps protected nono state root'; then
    check C-H1 FAIL "ADR-0019 Decision 1's argv is not launchable as written: handing HOME=<workspace>/home to the nono process makes nono REFUSE the workspace grant — exit=$M3_RC '$M3_OUT'. The child's HOME must be set INSIDE the sandbox (or nono's own HOME must stay outside every grant)"
elif [ "$M3_RC" -eq 0 ]; then
    check C-H1 PASS "nono accepted HOME inside the granted workspace (exit=0) — no protected-state-root collision on this build"
else
    check C-H1 FAIL "unexpected nono behaviour: exit=$M3_RC '$M3_OUT'"
fi
M3_SB_CWD="$B1" m3_sb --allow "$W1" --read "$M" -- sh -c "HOME='$W1/home' git rev-parse --abbrev-ref HEAD"
if [ "$M3_RC" -eq 0 ]; then
    check C-H1b PASS "the working shape: nono's own HOME outside the grants, child HOME=<workspace>/home inside -> exit=0 '$M3_OUT'"
else
    check C-H1b FAIL "even the child-side HOME shape failed: exit=$M3_RC '$M3_OUT'"
fi
# The same thing without a shell, which is what a Go exec.Command needs: `env` as
# the sandboxed program, HOME as its first argument.
M3_SB_CWD="$B1" m3_sb --allow "$W1" --read "$M" -- env "HOME=$W1/home" git rev-parse --abbrev-ref HEAD
if [ "$M3_RC" -eq 0 ] && printf '%s' "$M3_OUT" | grep -q 'run-1/backend'; then
    check C-H1c PASS "spec.Env's HOME must be applied INSIDE the sandbox, never on nono's own process: 'nono run … -- env HOME=<ws>/home <adapter argv>' works shell-free (exit=0 '$M3_OUT'). That is the argv the launcher must build; nono's own HOME stays the worker's, because once nono runs with HOME=X it creates a protected state root under X and every later grant covering X is refused (C-H1)"
else
    check C-H1c FAIL "the shell-free env recipe does not work (exit=$M3_RC '$M3_OUT') — ADR-0019 D1's Env contract still has no launchable form"
fi

# ---- C-P7: reflog namespace must exist before a confined commit --------------
mkdir -p "$W3/home"
M3_SB_CWD="$B3" m3_sb --allow "$W3" --read "$M" --allow "$M/objects" --allow "$M/refs/heads/run-3" --allow "$A3" -- sh -c "HOME='$W3/home' sh -c 'printf x >> app.txt; git add app.txt; git commit -qm p7'"
p7err="$M3_OUT"; p7rc=$M3_RC
mkdir -p "$M/logs/refs/heads/run-3"
M3_SB_CWD="$B3" m3_sb --allow "$W3" --read "$M" --allow "$M/objects" --allow "$M/refs/heads/run-3" --allow "$M/logs/refs/heads/run-3" --allow "$A3" -- sh -c "HOME='$W3/home' sh -c 'git add app.txt; git commit -qm p7-retry'"
if [ "$p7rc" -ne 0 ] && printf '%s' "$p7err" | grep -qi 'unable to create directory' && [ "$M3_RC" -eq 0 ]; then
    check C-P7 PASS "P7 re-derived: without pre-created <mirror>/logs/refs/heads/run-3 the commit failed exit=$p7rc '$p7err'; after worker-side mkdir -p the same grant set committed (exit=0)"
elif [ "$M3_RC" -ne 0 ]; then
    check C-P7 FAIL "commit never succeeded even with the reflog dir: first=$p7rc '$p7err' second=$M3_RC '$M3_OUT'"
else
    check C-P7 FAIL "the commit succeeded WITHOUT the pre-created reflog dir (first rc=$p7rc '$p7err') — P7's pre-create requirement does not reproduce"
fi

# ---- C-P2: the narrow commit grant set, and its write-set -------------------
touch "$M3_FIXTURE/marker"; sleep 1.1
grant_commit "$W1" run-1 "$A1"
M3_SB_CWD="$B1" m3_sb "${GRANTS[@]}" -- sh -c "HOME='$W1/home' sh -c 'printf \"run-1 sandboxed edit\n\" >> app.txt; git add app.txt; git commit -qm \"narrow-set commit\"'"
commit_rc=$M3_RC; commit_out="$M3_OUT"
changed="$(find "$M" -newer "$M3_FIXTURE/marker" -not -path "$M" | sed "s|^$M/||" | sort)"
outside=""
while IFS= read -r p; do
    [ -z "$p" ] && continue
    adm="$(printf '%s' "$A1" | sed "s|^$M/||")"
    case "$p" in
        objects|objects/*) ;;
        refs/heads/run-1|refs/heads/run-1/*) ;;
        logs/refs/heads/run-1|logs/refs/heads/run-1/*) ;;
        "$adm"|"$adm"/*) ;;
        *) outside="$outside $p" ;;
    esac
done <<EOF
$changed
EOF
head="$(git -C "$B1" log --oneline -1 2>&1 | m3_oneline)"
if [ "$commit_rc" -eq 0 ] && printf '%s' "$head" | grep -q 'narrow-set commit' && [ -z "$outside" ]; then
    check C-P2 PASS "P2 re-derived: sandboxed commit with exactly rw <ws> + rw <mirror>/objects + rw refs/heads/run-1 + rw logs/refs/heads/run-1 + rw <admin> + ro <mirror> succeeded ('$head'); every changed mirror path ($(printf '%s' "$changed" | grep -c . ) of them) was inside the granted set"
elif [ "$commit_rc" -eq 0 ]; then
    check C-P2 FAIL "commit succeeded but wrote outside the grants:$outside"
else
    check C-P2 FAIL "sandboxed commit failed exit=$commit_rc '$commit_out' (head=$head)"
fi

# ---- C-P3: mirror read-only is not enough for a commit ----------------------
m3_add_worktree run run-4 projA backend
W4="$(m3_ws run run-4)"; B4="$W4/repos/backend"; A4="$(m3_admin_dir "$B4")"
M3_SB_CWD="$B4" m3_sb --allow "$W4" --read "$M" -- sh -c "HOME='$W4/home' sh -c 'printf y >> app.txt; git add app.txt; git commit -qm p3'"
if [ "$M3_RC" -ne 0 ] && printf '%s' "$M3_OUT" | grep -qi 'index.lock.*Permission denied\|Permission denied'; then
    check C-P3 PASS "P3 re-derived: with the mirror ro only the commit failed exit=$M3_RC '$M3_OUT'"
else
    check C-P3 FAIL "commit with a ro mirror exited $M3_RC: '$M3_OUT'"
fi

# ---- C-P4: another scope's ref is unwritable under the narrow grant ----------
SHA="$(git -C "$B1" rev-parse HEAD 2>/dev/null || echo)"
grant_commit "$W2" run-2 "$A2"
M3_SB_CWD="$B2" m3_sb "${GRANTS[@]}" -- git update-ref "refs/heads/run-1/backend" "$SHA"
p4rc=$M3_RC; p4out="$M3_OUT"
M3_SB_CWD="$B2" M3_SB_HOME="$W2/home" m3_unsandboxed git update-ref "refs/heads/run-1/backend" "$SHA"
ctlrc=$M3_RC
if [ "$p4rc" -ne 0 ] && printf '%s' "$p4out" | grep -qi 'Permission denied' && [ "$ctlrc" -eq 0 ]; then
    check C-P4 PASS "P4 re-derived as a control pair: run-2's sandboxed 'git update-ref refs/heads/run-1/backend' denied exit=$p4rc ('$p4out'); the identical unsandboxed command succeeded"
elif [ "$ctlrc" -ne 0 ]; then
    check C-P4 GAP "control failed (unsandboxed update-ref exit=$ctlrc '$M3_OUT'), so the denial proves nothing: sandboxed said '$p4out'"
else
    check C-P4 FAIL "run-2 rewrote run-1's ref from inside its own sandbox (exit=$p4rc '$p4out') — the grant set does NOT bound commit reach"
fi
git --git-dir="$M" rev-parse --verify -q "run-1/backend" >/dev/null && note C-P4 "post-control ref run-1/backend -> $(git --git-dir="$M" rev-parse run-1/backend | cut -c1-10)"

# ---- C-P5: cross-scope READ inside a project stays open ----------------------
grant_edit "$W2"
M3_SB_CWD="$B2" m3_sb "${GRANTS[@]}" -- git log --oneline run-1/backend
if [ "$M3_RC" -eq 0 ]; then
    check C-P5 PASS "P5 re-derived: run-2's sandbox CAN read run-1's branch through the shared mirror (exit=0, $(printf '%s' "$M3_OUT" | grep -o ';' | wc -l | tr -d ' ') lines of output) — a limitation, not a defect"
else
    check C-P5 FAIL "run-2 could not read run-1/backend (exit=$M3_RC '$M3_OUT') — either the grant set is narrower than ADR-0017 claims, or the probe broke"
fi

# ---- C-X4: the agent cannot edit the project exclusion file ------------------
grant_commit "$W1" run-1 "$A1"
M3_SB_CWD="$B1" m3_sb "${GRANTS[@]}" -- sh -c "printf '.env.sneaky\n' >> '$M/info/exclude'"
m3_denied C-X4 "$M3_RC" "$M3_OUT"

# ---- C-META: is meta/ really outside the agent's reach? ---------------------
printf 'WORKER-ONLY-BOOKKEEPING-MARKER' > "$W1/meta/workspace.json"
grant_edit "$W1"
M3_SB_CWD="$B1" m3_sb "${GRANTS[@]}" -- sh -c "cat '$W1/meta/workspace.json'; printf 'agent-touched' > '$W1/meta/agent-written'"
if [ "$M3_RC" -eq 0 ] && printf '%s' "$M3_OUT" | grep -q WORKER-ONLY-BOOKKEEPING-MARKER && [ -e "$W1/meta/agent-written" ]; then
    check C-META FAIL "05's 'meta/ is worker-only, never mounted to agent' does NOT hold under ADR-0019's grant shape: --allow <workspace root> is recursive, so the sandboxed child read meta/workspace.json AND wrote meta/agent-written (exit=0). Either stop granting the workspace root (grant its agent-visible children instead — measured in C-GRANT/C-GRANT2 below) or move meta/ out of the granted tree"
elif [ "$M3_RC" -ne 0 ] && printf '%s' "$M3_OUT" | grep -qi 'permission denied'; then
    check C-META PASS "meta/ was unreachable under the applied grants: exit=$M3_RC '$M3_OUT'"
else
    check C-META FAIL "inconclusive: exit=$M3_RC '$M3_OUT'"
fi

# ---- C-GRANT: the corrected grant shape (what C-META's FAIL asks for) -------
# Grant the three agent-visible CHILDREN of the workspace instead of its root,
# so meta/ — which stays where 05 put it — is outside every grant by omission.
rm -f "$W1/meta/agent-written"
printf 'WORKER-ONLY-BOOKKEEPING-MARKER2' > "$W1/meta/workspace.json"
M3_SB_CWD="$B1" m3_sb --allow "$W1/repos" --allow "$W1/scratch" --allow "$W1/home" --read "$M" -- sh -c "HOME='$W1/home' git status --porcelain && printf 'narrow-grant edit\\n' >> app.txt && printf s > '$W1/scratch/out.txt' && echo EDIT_OK"
g_a_rc=$M3_RC; g_a="$M3_OUT"
M3_SB_CWD="$B1" m3_sb --allow "$W1/repos" --allow "$W1/scratch" --allow "$W1/home" --read "$M" -- cat "$W1/meta/workspace.json"
g_b_rc=$M3_RC; g_b="$M3_OUT"
M3_SB_CWD="$B1" m3_sb --allow "$W1/repos" --allow "$W1/scratch" --allow "$W1/home" --read "$M" -- sh -c "printf 'agent-touched' > '$W1/meta/agent-written2'"
g_c_rc=$M3_RC; g_c="$M3_OUT"
if [ "$g_a_rc" = 0 ] && printf '%s' "$g_a" | grep -q EDIT_OK; then
    check C-GRANT PASS "the minimal correction to ADR-0019 D1's 'rw <workspace>' is launchable: 'rw <ws>/repos + rw <ws>/scratch + rw <ws>/home + ro <mirror>' let git status and an edit in the worktree and a write in scratch/ all succeed (exit=0 '$g_a') — the workspace root itself never needs to be a grant"
else
    check C-GRANT FAIL "narrowing the grant to the agent-visible children broke git or the edit (exit=$g_a_rc '$g_a') — C-META's correction must be found another way"
fi
if [ "$g_b_rc" -ne 0 ] && ! printf '%s' "$g_b" | grep -q WORKER-ONLY-BOOKKEEPING-MARKER2 && [ "$g_c_rc" -ne 0 ] && [ ! -e "$W1/meta/agent-written2" ]; then
    check C-GRANT2 PASS "and meta/ keeps 05's promise under that shape: read denied exit=$g_b_rc ('$g_b'), write denied exit=$g_c_rc ('$g_c'); host still sees meta/ as $(ls -1 "$W1/meta" | tr '\n' ' ' | m3_oneline) — 'worker-only, never mounted to agent' is achievable with omission alone, no nono deny rule needed"
else
    check C-GRANT2 FAIL "meta/ is still reachable under the narrow shape (read exit=$g_b_rc '$g_b'; write exit=$g_c_rc '$g_c'; meta/ now holds: $(ls -1 "$W1/meta" | tr '\n' ' ' | m3_oneline))"
fi

# ---- C-P8: a successful commit still prints an error line -------------------
touch "$M3_FIXTURE/marker2"; sleep 1.1
grant_commit "$W1" run-1 "$A1"
M3_SB_CWD="$B1" m3_sb "${GRANTS[@]}" -- sh -c "HOME='$W1/home' sh -c 'printf z >> app.txt; git add app.txt; git commit -qm p8-noise'"
post="$(git -C "$B1" rev-parse HEAD 2>&1 | m3_oneline)"
if [ "$M3_RC" -eq 0 ] && printf '%s' "$M3_OUT" | grep -qi 'packed-refs.lock.*Permission denied'; then
    check C-P8 PASS "P8 re-derived: exit=0 with '$M3_OUT' — stderr noise is NOT a failure signal; the post-commit ref readback ($post) is the proof"
elif [ "$M3_RC" -eq 0 ]; then
    check C-P8 GAP "commit succeeded (exit=0) but printed no packed-refs.lock error this time: '$M3_OUT' — P8 is git-version sensitive (ref readback $post)"
else
    check C-P8 FAIL "commit exited $M3_RC: '$M3_OUT'"
fi

m3_cleanup
exit 0
