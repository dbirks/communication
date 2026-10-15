#!/usr/bin/env bash
# m3 probe 6 — APM staging claims the M3 contract's § 4.2 step depends on
# (ADR-0008, APM.md T1–T6): per-run HOME, per-target lock digest, stability of
# `--frozen` across an upstream change, and the fact that APM's generated paths
# are git-visible until the worker puts them in the project exclusion file.
#
# Needs apm 0.33.0 on PATH (host only — the worker image does not vendor it
# yet; that is docs/m3-contract.md § 5's own line, and this probe reports GAP
# rather than pretending).
#
# Usage: bash p6_apm_staging.sh [--apm <path>] [--fixture <dir>] [--keep]
set -uo pipefail
M3_PROBE=p6_apm_staging
M3_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$M3_DIR"
# shellcheck source=lib.sh
. ./lib.sh
M3_FIXTURE="${M3_FIXTURE_ARG:-${M3_PROBE_ROOT_BASE}/p6}"
M3_APM="${M3_APM:-$HOME/.local/bin/apm}"
while [ $# -gt 0 ]; do
    case "$1" in
        --apm) M3_APM="$2"; shift 2 ;;
        *) m3_args "$1"; shift ;;
    esac
done
m3_env_header
echo "ENV glibc=$(ldd --version 2>&1 | head -1 | m3_oneline)"
echo "ENV apm_bin=${M3_APM}"
apm_ver='MISSING'; apm_vrc=1
if [ -x "$M3_APM" ]; then
    apm_raw="$("$M3_APM" --version 2>&1)"; apm_vrc=$?
    apm_ver="$(printf '%s' "$apm_raw" | m3_oneline)"
fi
echo "ENV apm_version=$apm_ver"
echo

if [ ! -x "$M3_APM" ]; then
    check A0 GAP "apm not found at $M3_APM — ADR-0008 D1's vendored 0.33.0 is not in this environment (and not in communication-worker:dev, which is the point: docs/m3-contract.md § 5 still has to vendor it)"
    exit 0
fi
# A binary that exists but cannot execute is a missing precondition, not a
# failed claim: reporting A1..A7 as FAIL would blame the APM behaviour we never
# got to measure. The observed loader error is what A0 records instead.
if [ "$apm_vrc" -ne 0 ]; then
    check A0 GAP "apm is present at $M3_APM but cannot execute here (exit=$apm_vrc '$apm_ver') — A1..A7 are UNMEASURED in this environment, not failed"
    exit 0
fi

rm -rf "$M3_FIXTURE"; mkdir -p "$M3_FIXTURE"/{origins,repos,workspaces,pkgs}
m3_git_identity
m3_seed_origin backend
m3_make_mirror projA backend
m3_add_worktree run run-1 projA backend
W1="$(m3_ws run run-1)"; B1="$W1/repos/backend"; M="$(m3_mirror projA backend)"
mkdir -p "$M/logs/refs/heads/run-1"

# local-path APM package + consumer manifest, self-contained in the fixture
mkdir -p "$M3_FIXTURE/pkgs/pkg-alpha/skills/alpha-skill"
cat > "$M3_FIXTURE/pkgs/pkg-alpha/apm.yml" <<'EOF'
name: pkg-alpha
version: 0.1.0
description: m3 probe package carrying the ALPHA-MARKER token
includes: auto
EOF
printf '# alpha-skill\nALPHA-MARKER original\n' > "$M3_FIXTURE/pkgs/pkg-alpha/skills/alpha-skill/SKILL.md"
cat > "$B1/apm.yml" <<EOF
name: m3-probe-consumer
version: 0.1.0
description: m3 probe consumer of a local-path APM package
includes: auto
dependencies:
  apm:
    - $M3_FIXTURE/pkgs/pkg-alpha
EOF

run_apm() { ( cd "$B1" && HOME="$W1/home" "$M3_APM" "$@" ); }
lock_digest() { sha256sum "$B1/apm.lock.yaml" 2>/dev/null | awk '{print $1}'; }

# ---- A1: --frozen install lands inside the run checkout with a per-run HOME --
run_apm install --target claude >"$M3_FIXTURE/a1.log" 2>&1; a1rc=$?
d_claude="$(lock_digest)"
generated="$(cd "$B1" && find .claude apm_modules apm.lock.yaml .gitignore -maxdepth 3 -type f 2>/dev/null | head -6 | tr '\n' ' ')"
gen_ok=0
[ -f "$B1/apm.lock.yaml" ] && [ -d "$B1/apm_modules" ] && [ -f "$B1/.claude/skills/alpha-skill/SKILL.md" ] && gen_ok=1
home_writes="$(find "$W1/home" -mindepth 1 -maxdepth 2 2>/dev/null | sed "s|$W1/home/||" | tr '\n' ' ')"
if [ "$a1rc" = 0 ] && [ "$gen_ok" = 1 ]; then
    check A1 PASS "contract § 4.2 step 2 shape: 'HOME=<workspace>/home apm install --target claude' staged into the run checkout ($generated)"
else
    check A1 FAIL "apm install exit=$a1rc gen_ok=$gen_ok in $B1; log: $(tail -c 200 "$M3_FIXTURE/a1.log" | m3_oneline)"
fi
if printf '%s' "$home_writes" | grep -q '.apm'; then
    check A2 PASS "APM.md T4 re-derived in the run HOME: apm wrote $home_writes into <workspace>/home — which is exactly why home/ exists (deviation D2) and why it must be deleted with the unit"
else
    check A2 FAIL "apm wrote nothing into the per-run HOME ('$home_writes') — T4's premise may be stale, in which case home/ needs re-justifying"
fi

tree_hash() { ( cd "$B1" && find .claude .agents apm_modules -type f 2>/dev/null | sort | xargs sha256sum 2>/dev/null | sha256sum | awk '{print $1}' ); }

# ---- A4: --frozen reproduces an UNCHANGED upstream (case 14's stability) -----
# This runs BEFORE A3 deliberately: apm keeps ONE apm.lock.yaml per checkout
# recording every target ever installed into it, so a codex install would move
# the claude baseline and A4 would be measuring install history, not --frozen.
d_base="$d_claude"; tree_base="$(tree_hash)"
run_apm install --frozen --target claude >"$M3_FIXTURE/a4.log" 2>&1; a4rc=$?
d_frozen="$(lock_digest)"; tree_frozen="$(tree_hash)"
if [ "$a4rc" = 0 ] && [ "$d_frozen" = "$d_base" ] && [ "$tree_frozen" = "$tree_base" ]; then
    check A4 PASS "case 14's stability half re-derived for an UNCHANGED upstream: 'apm install --frozen --target claude' over the same package reproduced the lock digest ($d_frozen) and the deployed tree exactly — C14d's 'turn 2 reproduces the SAME tree' holds while nothing upstream moved"
else
    check A4 FAIL "frozen install did not reproduce the unchanged-upstream install (rc=$a4rc digest $d_base -> $d_frozen; tree $tree_base -> $tree_frozen)"
fi

# ---- A5: --frozen does NOT freeze a local-path dependency -------------------
printf '# alpha-skill\nALPHA-MARKER MUTATED-UPSTREAM\n' > "$M3_FIXTURE/pkgs/pkg-alpha/skills/alpha-skill/SKILL.md"
printf 'extra: true\n' >> "$M3_FIXTURE/pkgs/pkg-alpha/apm.yml"
run_apm install --frozen --target claude >"$M3_FIXTURE/a5.log" 2>&1; a5rc=$?
d_mut="$(lock_digest)"; tree_mut="$(tree_hash)"
deployed="$(cat "$B1/.claude/skills/alpha-skill/SKILL.md" 2>/dev/null | m3_oneline)"
if [ "$a5rc" = 0 ] && [ "$d_mut" != "$d_frozen" ] && [ "$tree_mut" != "$tree_frozen" ] && printf '%s' "$deployed" | grep -q MUTATED; then
    check A5 FAIL "docs/m3-contract.md C14d's 'no new package content appears' is FALSE for a local-path dependency: after mutating the upstream package, 'apm install --frozen --target claude' exited 0 — apm said '$(grep -i -m1 -o 'Lockfile presence verified[.][^.]*' "$M3_FIXTURE/a5.log" | head -1 | m3_oneline)' — and MOVED the lock digest (${d_frozen:0:12}… -> ${d_mut:0:12}…), replaced the deployed tree, and put the MUTATED content live ('$deployed'). --frozen verifies the lockfile is present; it does not pin local-path content. The control that works is ADR-0008 D4's pre-launch digest comparison (it sees this move)"
else
    check A5 FAIL "unexpected --frozen behaviour after an upstream mutation (rc=$a5rc digest $d_frozen -> $d_mut; tree changed=$([ "$tree_mut" != "$tree_frozen" ] && echo yes || echo no); deployed='$deployed')"
fi

# ---- A5b: the digest is a faithful change detector under BOTH flags ---------
run_apm install --target claude >"$M3_FIXTURE/a5b.log" 2>&1; a5brc=$?
d_unfrozen="$(lock_digest)"; deployed2="$(cat "$B1/.claude/skills/alpha-skill/SKILL.md" 2>/dev/null | m3_oneline)"
if [ "$a5brc" = 0 ] && [ "$d_unfrozen" = "$d_mut" ] && printf '%s' "$deployed2" | grep -q MUTATED; then
    check A5b PASS "the recorded digest moves exactly when package content moves, under --frozen and without it alike (both $d_unfrozen) — so 'validate sha256(apm.lock.yaml) against agent_profiles.apm_lock_digest before launch' (contract § 4.2 step 2 / ADR-0008 D4) catches restaging; --frozen contributes nothing to that control"
else
    check A5b FAIL "frozen and unfrozen digests diverged for the same tree (rc=$a5brc $d_mut -> $d_unfrozen, deployed='$deployed2')"
fi

# ---- A3: one shared lock, so the digest identifies the install SET ----------
run_apm install --target codex >"$M3_FIXTURE/a3.log" 2>&1; a3rc=$?
d_codex="$(lock_digest)"
if [ "$a3rc" = 0 ] && [ -n "$d_claude" ] && [ -n "$d_codex" ] && [ "$d_claude" != "$d_codex" ]; then
    check A3 PASS "APM.md T5 / ADR-0008's per-target digest, with a caveat: apm keeps ONE apm.lock.yaml per checkout, so adding '--target codex' to a checkout that already had claude MOVED the digest ($d_claude -> $d_codex) instead of writing a per-target lock. agent_profiles.apm_lock_digest is one value per profile only if exactly one target is ever installed into a run checkout"
else
    check A3 FAIL "per-target digests did not differ as expected (rc=$a3rc claude=$d_claude codex=$d_codex)"
fi
run_apm install --frozen --target claude >"$M3_FIXTURE/a3b.log" 2>&1; a3brc=$?
d_switch="$(lock_digest)"
if [ "$a3brc" = 0 ] && [ "$d_switch" = "$d_codex" ] && [ "$d_switch" != "$d_claude" ]; then
    check A3b PASS "a target switch is loud, not silent: 'install --frozen --target claude' on a checkout whose lock was last written by a codex install exited 0 but left the codex lock ($d_switch), so the recorded claude digest would NOT match and the pre-launch assertion refuses the launch rather than accepting a mixed-target tree"
else
    check A3b FAIL "unexpected lock after a target switch (rc=$a3brc claude=$d_claude codex=$d_codex switch=$d_switch)"
fi

# ---- A6: APM's generated paths are git-visible until excluded ---------------
status_raw="$(git -C "$B1" status --porcelain | tr '\n' ';' | m3_oneline)"
ignored="$(cd "$B1" && for g in apm.yml apm.lock.yaml .gitignore .claude .agents apm_modules; do printf '%s=%s;' "$g" "$(git check-ignore -v "$g" 2>/dev/null | m3_oneline)"; done | m3_oneline)"
mkdir -p "$M/info"
for g in apm.yml apm.lock.yaml .gitignore .claude/ apm_modules/ .agents/ .codex/; do
    grep -qxF "$g" "$M/info/exclude" || printf '%s\n' "$g" >> "$M/info/exclude"
done
status_ex="$(git -C "$B1" status --porcelain | tr '\n' ';' | m3_oneline)"
if printf '%s' "$status_raw" | grep -qE '\.claude|apm\.lock\.yaml|apm\.yml' && [ -z "$(git -C "$B1" status --porcelain)" ]; then
    check A6 PASS "contract § 4.2's exclusion step is load-bearing: before it, 'git status --porcelain' listed the staging output ($status_raw); after appending the generated paths to <mirror>/info/exclude it is clean ('$status_ex')"
else
    check A6 FAIL "exclusion of APM output did not behave as expected (before='$status_raw' after='$status_ex')"
fi
note A6b "which generated paths git actually sees: status before exclusion='$status_raw'; check-ignore -v reports [$ignored] — apm_modules/ is hidden by the .gitignore apm itself wrote into the checkout, while apm.yml, apm.lock.yaml, .gitignore, .claude/ and .agents/ are visible until the mirror's info/exclude names them. The exclusion set must therefore include .gitignore (a new untracked file apm authors), and the contract cannot rely on apm's own .gitignore for the other five"

# ---- A7: a per-run HOME is only isolated if someone deletes it --------------
if [ -d "$W1/home/.apm" ] || [ -d "$W1/home/.cache/apm" ]; then
    check A7 N/A "home/ carries harness state (APM.md T4) — ADR-0017 D7's 'home/ deleted with the attempt' is what makes it throwaway, and the artifact/checkpoint exclusion set must name home/ (contract § 4.6)"
else
    check A7 GAP "no .apm/.cache under home/ to inspect (apm wrote elsewhere: '$home_writes')"
fi

m3_cleanup
exit 0
