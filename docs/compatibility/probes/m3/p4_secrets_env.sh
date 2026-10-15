#!/usr/bin/env bash
# m3 probe 4 — the `.env` lifecycle and cross-project half of the M3 contract's
# exit plan (§ C12, X1–X4), in probe form: nono + git + a planted sentinel,
# no Communication code. The materializer below is a throw-away re-implementation
# of ADR-0018 Decision 4's ordered steps — it exists only to make the git and
# sandbox facts measurable; the real one is M3's `internal/secrets`.
#
# Usage: bash p4_secrets_env.sh [--nono <path>] [--fixture <dir>] [--keep]
set -uo pipefail
M3_PROBE=p4_secrets_env
M3_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$M3_DIR"
# shellcheck source=lib.sh
. ./lib.sh
M3_FIXTURE="${M3_FIXTURE_ARG:-${M3_PROBE_ROOT_BASE}/p4}"
m3_args "$@"
m3_env_header
[ -x "$M3_NONO" ] || { check PREAMBLE GAP "nono not executable at $M3_NONO"; exit 0; }

rm -rf "$M3_FIXTURE"; mkdir -p "$M3_FIXTURE"/{origins,repos,workspaces,logs}
m3_git_identity
m3_seed_origin backend
m3_make_mirror projA backend
m3_seed_origin backend-b
m3_make_mirror projB backend-b
for spec in "projA run-A backend" "projB run-B backend-b"; do
    set -- $spec
    proj="$1"; scope="$2"; repo="$3"
    m3_add_worktree run "$scope" "$proj" "$repo"
    mkdir -p "$(m3_mirror "$proj" "$repo")/logs/refs/heads/$scope"   # Prepare, P7
done
WRA="$(m3_ws run run-A)"; WRB="$(m3_ws run run-B)"
BRA="$WRA/repos/backend";  BRB="$WRB/repos/backend-b"
MIRA="$(m3_mirror projA backend)";  MIRB="$(m3_mirror projB backend-b)"
ADMA="$(m3_admin_dir "$BRA")";  ADMB="$(m3_admin_dir "$BRB")"
SENT_A='SENTINEL-m3-9f4c2a1b-database_url-for_exit_test_only=postgres://a:pw@h/db'
SENT_B='SENTINEL-B-7777-other-project-database_url=postgres://b:pw@h/db'
mkdir -p "$M3_FIXTURE/launcher-home"; chmod 700 "$M3_FIXTURE/launcher-home"
M3_SB_HOME="$M3_FIXTURE/launcher-home"; export M3_SB_HOME

# Project B plants the SAME relative path with a value project A must never see.
mkdir -p "$MIRB/info"; grep -qxF '.env.test.local' "$MIRB/info/exclude" || printf '.env.test.local\n' >> "$MIRB/info/exclude"
printf '%s\n' "$SENT_B" > "$BRB/.env.test.local"; chmod 600 "$BRB/.env.test.local"

# ---- the throw-away materializer (ADR-0018 D4 steps 1→4, in order) ----------
# materialize <checkout> <mirror> <relative-path> <value> ; prints REASON:<x> on
# refusal and creates nothing.
materialize() {
    local co="$1" mirror="$2" rel="$3" value="$4"
    case "$rel" in /*) echo "REASON:absolute_path"; return 1 ;; esac
    case "$rel" in *..*) echo "REASON:path_escape"; return 1 ;; esac
    case "$rel" in *//*) echo "REASON:bad_shape"; return 1 ;; esac
    case "$rel" in */.) echo "REASON:bad_shape"; return 1 ;; esac
    local cleaned; cleaned="$(realpath -m -- "$co/$rel")"
    case "$cleaned" in "$co"/*) ;; *) echo "REASON:path_escape"; return 1 ;; esac
    [ "$cleaned" = "$co/$rel" ] || { echo "REASON:needs_cleaning"; return 1; }
    local parent; parent="$(dirname "$cleaned")"
    if [ -L "$parent" ]; then echo "REASON:symlink_parent"; return 1; fi
    if [ -L "$cleaned" ]; then echo "REASON:symlink_target"; return 1; fi
    local realparent; realparent="$(realpath -- "$parent" 2>/dev/null)" || { echo "REASON:missing_parent"; return 1; }
    case "$realparent/" in "$co/"*) ;; *) echo "REASON:path_escape"; return 1 ;; esac
    if git -C "$co" ls-files --error-unmatch -- "$rel" >/dev/null 2>&1; then
        echo "REASON:tracked_target"; return 1
    fi
    mkdir -p "$mirror/info"
    grep -qxF "$rel" "$mirror/info/exclude" 2>/dev/null || printf '%s\n' "$rel" >> "$mirror/info/exclude"
    if ! git -C "$co" check-ignore -q -- "$rel"; then echo "REASON:exclusion_failed"; return 1; fi
    local rc=0
    ( umask 077; set -o noclobber; printf '%s\n' "$value" > "$cleaned" ) 2>"$M3_FIXTURE/logs/excl.err" || rc=$?
    if [ "$rc" -ne 0 ]; then
        if grep -qi 'cannot overwrite\|excl' "$M3_FIXTURE/logs/excl.err"; then echo "REASON:exists"; else echo "REASON:write_failed"; fi
        return 1
    fi
    echo "MATERIALIZED $cleaned"
}

# ---- C-ENV1: 0600, owner-only, at the declared path -------------------------
m_out="$(materialize "$BRA" "$MIRA" .env.test.local "$SENT_A")"
mode="$(stat -c '%a %u' "$BRA/.env.test.local" 2>/dev/null || echo missing)"
if printf '%s' "$m_out" | grep -q '^MATERIALIZED' && [ "$mode" = "600 $(id -u)" ]; then
    check C-ENV1 PASS "case 12/C12a shape: O_EXCL+umask077 materialization produced $BRA/.env.test.local at mode $mode (uid = the worker uid, which is the whole point of C-XPROJ4 below)"
else
    check C-ENV1 FAIL "materialization did not land as expected: '$m_out' mode=$mode"
fi

# ---- C-ENV2: invisible to git during the unit (C12c) ------------------------
st="$(git -C "$BRA" status --porcelain)"; lf="$(git -C "$BRA" ls-files -- .env.test.local)"; df="$(git -C "$BRA" diff -- .env.test.local | m3_oneline)"
if [ -z "$lf" ] && [ -z "$df" ] && ! printf '%s' "$st" | grep -q '.env.test.local'; then
    check C-ENV2 PASS "case 12/C12c re-derived while the file EXISTS: git status --porcelain='$st', git ls-files empty, git diff empty"
else
    check C-ENV2 FAIL "the materialized file is visible to git (status='$st' ls-files='$lf' diff='$df')"
fi

# ---- C-ENV3: the granted agent CAN read it (ADR-0018's honest clause) -------
grant_commit() { GRANTS=(--allow "$1" --read "$2" --allow "$2/objects" --allow "$2/refs/heads/$3" --allow "$2/logs/refs/heads/$3" --allow "$4"); }
grant_commit "$WRA" "$MIRA" run-A "$ADMA"
M3_SB_CWD="$BRA" m3_sb "${GRANTS[@]}" -- sh -c "HOME='$WRA/home' cat .env.test.local"
if printf '%s' "$M3_OUT" | grep -q 'SENTINEL-m3-9f4c2a1b'; then
    check C-ENV3 N/A "the sandboxed agent inside project A read its own materialized secret (expected, and the reason ADR-0018 Security says file permissions are defense in depth, not the control): '$M3_OUT'"
else
    check C-ENV3 FAIL "the agent could NOT read the secret it was granted: exit=$M3_RC '$M3_OUT' — the grant model would be broken"
fi

# ---- C-ENV4: durable — the value never reaches git history (C12g) -----------
M3_SB_CWD="$BRA" m3_sb "${GRANTS[@]}" -- sh -c "HOME='$WRA/home' sh -c 'git add -A && git commit -qm \"agent commits everything incl. the .env\"'"
grep_rc=0; grep_out="$(git --git-dir="$MIRA" grep -I 'SENTINEL-m3-9f4c2a1b' $(git --git-dir="$MIRA" for-each-ref --format='%(refname)') 2>&1)" || grep_rc=$?
if [ "$grep_rc" -ne 0 ]; then
    check C-ENV4 PASS "case 12/C12g re-derived: 'git add -A && git commit' inside the sandbox did NOT capture .env.test.local — git grep over every ref in the mirror found nothing (exit=$grep_rc)"
else
    check C-ENV4 FAIL "the sentinel IS in git history: '$grep_out' — the project-scoped exclusion is not holding"
fi
# negative control: a path nobody excluded really does get committed
m_out2="$(materialize "$BRA" "$MIRA" .env.excluded-control "$SENT_A")" # excluded by construction
printf '%s\n' "$SENT_A" > "$BRA/not-excluded-control.txt"
git -C "$BRA" add -A >/dev/null 2>&1; git -C "$BRA" commit -qm "control: a NON-excluded file" >/dev/null 2>&1
if git --git-dir="$MIRA" grep -I 'SENTINEL-m3-9f4c2a1b' $(git --git-dir="$MIRA" for-each-ref --format='%(refname)') >/dev/null 2>&1; then
    check C-ENV4b PASS "negative control works: the same sentinel committed through an UNexcluded path IS in history — so C-ENV4's clean answer is the exclusion's doing, not git ignoring the value"
else
    check C-ENV4b GAP "control did not land in history either (git add/commit behaviour in this fixture), so C-ENV4 proves less than it appears to"
fi

# ---- C-ENV5: cleanup removes it, and the tree is clean ---------------------
rm -f "$BRA/.env.test.local"
st2="$(git -C "$BRA" status --porcelain | m3_oneline)"
if [ ! -e "$BRA/.env.test.local" ]; then
    check C-ENV5 PASS "case 12/C12d shape: after the unit the file is gone (git status now '$st2'); a leftover would be the quarantined-workspace trigger"
else
    check C-ENV5 FAIL "the file survived cleanup"
fi

# ---- C-ENV6: the traversal battery (C12i, probe form) ----------------------
mkdir -p "$M3_FIXTURE/outside"
ln -sfn "$M3_FIXTURE/outside" "$BRA/linkdir"
printf 'TRACKED-ENV\n' > "$BRA/tracked.env"; git -C "$BRA" add tracked.env >/dev/null 2>&1; git -C "$BRA" commit -qm track >/dev/null 2>&1
battery_fail=0; battery_obs=""
for attempt in "../../etc/m3-probe" "../backend/.env.test.local" "/etc/m3-probe-abs" ".env.test.local/../../y" "linkdir/escaped.env" "tracked.env" "weird//path" "trail/."; do
    res="$(materialize "$BRA" "$MIRA" "$attempt" "$SENT_A")"
    case "$res" in
        REASON:*) battery_obs="$battery_obs [$attempt → $res]" ;;
        *) battery_fail=1; battery_obs="$battery_obs [$attempt → ACCEPTED: $res]" ;;
    esac
done
n_outside="$(ls -A "$M3_FIXTURE/outside" | wc -l | tr -d ' ')"
if [ "$battery_fail" -eq 0 ] && [ "$n_outside" = 0 ] && [ ! -e /etc/m3-probe-abs ]; then
    check C-ENV6 PASS "case 12/C12i battery: every attempt refused before any write, no file created anywhere ($battery_obs)"
else
    check C-ENV6 FAIL "a traversal attempt was accepted or wrote somewhere: fail=$battery_fail outside_dir_entries=$n_outside$battery_obs"
fi
ln -sfn "$M3_FIXTURE/outside" "$BRA/../escapesymlink" 2>/dev/null; rm -f "$BRA/../escapesymlink"
tr_res="$(materialize "$BRA" "$MIRA" "tracked.env" "$SENT_A")"
if printf '%s' "$tr_res" | grep -q 'REASON:tracked_target'; then
    check C-ENV6b PASS "a TRACKED target is refused with reason=tracked_target (05's 'not a silent overwrite'); nothing was rewritten: '$(git -C "$BRA" show HEAD:tracked.env | m3_oneline)'"
else
    check C-ENV6b FAIL "tracked-target refusal did not behave: '$tr_res' / retry: $(materialize "$BRA" "$MIRA" tracked.env x)"
fi

# ---- C-ENV7: O_EXCL semantics on a re-materialization ----------------------
materialize "$BRA" "$MIRA" .env.race "$SENT_A" >/dev/null
r2="$(materialize "$BRA" "$MIRA" .env.race "$SENT_A")"
if printf '%s' "$r2" | grep -q 'REASON:exists'; then
    check C-ENV7 PASS "second materialization at a live path is refused with reason=exists (ADR-0018 D4 step 4's 'refuse a second time'); content untouched: $(stat -c %a "$BRA/.env.race")"
else
    check C-ENV7 FAIL "re-materialization returned '$r2'"
fi
rm -f "$BRA/.env.race"

# ---- C-ENV10: nono inherits the launcher's environment ---------------------
M3_RC=0
M3_OUT="$(cd "$BRA" && env -i PATH="$PATH" HOME="$M3_SB_HOME" COMMUNICATION_DATABASE_URL="postgres://worker:pw@db/communication" "$M3_NONO" run -s --allow "$WRA" --read "$MIRA" -- sh -c 'env | grep COMMUNICATION_DATABASE_URL' 2>&1 | m3_oneline)" || M3_RC=$?
if printf '%s' "$M3_OUT" | grep -q 'postgres://worker:pw@db'; then
    check C-ENV10 PASS "ADR-0019 D1's 'Env built from scratch, never os.Environ()' is load-bearing: a launcher env var reached the sandboxed child unchanged ('$M3_OUT') — Landlock does not scrub environment, so the worker must"
else
    check C-ENV10 FAIL "launcher env did not propagate (exit=$M3_RC '$M3_OUT') — if nono started scrubbing env, ADR-0019's rationale for the explicit Env list needs a re-check"
fi

# ---- C-XPROJ1/2/3: project A's agent cannot reach project B -----------------
# A's grants, exactly ADR-0019's argv for a committing agent, B never named.
grant_commit "$WRA" "$MIRA" run-A "$ADMA"
M3_SB_CWD="$BRA" m3_sb "${GRANTS[@]}" -- cat "$BRB/.env.test.local"
m3_denied C-XPROJ1 "$M3_RC" "$M3_OUT"
if printf '%s' "$M3_OUT" | grep -q 'SENTINEL-B'; then
    check C-XPROJ1b FAIL "the denied read still leaked the value into the tool output: '$M3_OUT'"
else
    check C-XPROJ1b PASS "no project-B value appeared anywhere in the sandboxed output (exit=$M3_RC '$M3_OUT')"
fi
grant_commit "$WRB" "$MIRB" run-B "$ADMB"
M3_SB_CWD="$BRB" m3_sb "${GRANTS[@]}" -- sh -c "cat .env.test.local"
if printf '%s' "$M3_OUT" | grep -q 'SENTINEL-B'; then
    check C-XPROJ2 PASS "positive control (contract X3): the identical path IS readable for project B's own launch — without this arm X1 would prove nothing"
else
    check C-XPROJ2 FAIL "project B could not read its own workspace: exit=$M3_RC '$M3_OUT'"
fi
grant_commit "$WRA" "$MIRA" run-A "$ADMA"
M3_SB_CWD="$BRA" m3_sb "${GRANTS[@]}" -- git --git-dir="$MIRB" log --oneline -1
m3_denied C-XPROJ3 "$M3_RC" "$M3_OUT"
M3_SB_CWD="$BRA" m3_sb "${GRANTS[@]}" -- sh -c "ls '$WRB'"
m3_denied C-XPROJ3b "$M3_RC" "$M3_OUT"
M3_SB_CWD="$BRA" m3_sb "${GRANTS[@]}" -- sh -c "printf 'x\n' >> '$MIRB/info/exclude'"
m3_denied C-XPROJ3c "$M3_RC" "$M3_OUT"

# ---- C-XPROJ4: 0600 is not the boundary; the grant is -----------------------
M3_SB_CWD="$BRA" M3_SB_HOME="$WRA/home" m3_unsandboxed sh -c "cat '$BRB/.env.test.local'"
if [ "$M3_RC" -eq 0 ] && printf '%s' "$M3_OUT" | grep -q 'SENTINEL-B'; then
    check C-XPROJ4 N/A "measured, and it is the D-025 caveat rather than a bug: with the SAME uid and NO sandbox, project B's 0600 secret is readable ('$M3_OUT'). Everything ADR-0018 defends is the DB dump / API / journal / artifacts — never a hostile same-uid process on the worker"
else
    check C-XPROJ4 FAIL "unexpected: the same-uid unsandboxed read was refused (exit=$M3_RC '$M3_OUT') — if real, D-025's caveat could be revisited"
fi

# ---- C-ENV8: what the /tmp grant really costs a secret ----------------------
TDIR="/tmp/communication-m3-probe-p4.$$"
mkdir -p "$TDIR/run-A/repos/backend"
printf '%s\n' "$SENT_A" > "$TDIR/run-A/repos/backend/.env.test.local"
chmod 600 "$TDIR/run-A/repos/backend/.env.test.local"
M3_SB_CWD="$BRB" m3_sb --allow "$WRB" --read "$MIRB" -- sh -c "cat '$TDIR/run-A/repos/backend/.env.test.local'"
tmp_read_rc=$M3_RC; tmp_read="$M3_OUT"
M3_SB_CWD="$BRB" m3_sb --allow "$WRB" --read "$MIRB" -- sh -c "echo clobbered-by-B > '$TDIR/run-A/repos/backend/.env.test.local' && echo CLOBBER_OK || echo CLOBBER_DENIED"
tmp_write="$M3_OUT"; after="$(cat "$TDIR/run-A/repos/backend/.env.test.local" 2>&1 | m3_oneline)"
if printf '%s' "$tmp_write" | grep -q CLOBBER_OK && printf '%s' "$after" | grep -q clobbered-by-B; then
    check C-ENV8 PASS "temp paths are an INTEGRITY hole, not a disclosure hole: project B's sandbox could not READ A's 0600 secret under /tmp (exit=$tmp_read_rc '$tmp_read') but it TRUNCATED AND REPLACED it ('$tmp_write'; host now sees '$after'). ADR-0017 D5's ban is still required — and ADR-0019's wording ('writable by any agent') is the accurate one"
else
    check C-ENV8 FAIL "temp clobber did not reproduce: read_rc=$tmp_read_rc '$tmp_read' write='$tmp_write' host='$after'"
fi
# a path A itself wrote under /tmp is not even readable back (the grant is write-only)
M3_SB_CWD="$BRA" m3_sb --allow "$WRA" --read "$MIRA" -- sh -c "echo mine > '$TDIR/self.txt'; cat '$TDIR/self.txt' || echo SELF_READ_DENIED"
check C-ENV8b N/A "the default temp grant is WRITE-ONLY — an agent cannot even read back what it wrote there: '$M3_OUT'. It also means a spool area under /tmp cannot be trusted as an artifact staging dir (ADR-0020 D2)"
rm -rf "$TDIR"

m3_cleanup
exit 0
