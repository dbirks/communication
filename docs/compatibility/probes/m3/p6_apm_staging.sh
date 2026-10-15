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
echo "ENV apm_bin=${M3_APM}"
echo "ENV apm_version=$([ -x "$M3_APM" ] && "$M3_APM" --version 2>&1 | m3_oneline || echo MISSING)"
echo

if [ ! -x "$M3_APM" ]; then
    check A0 GAP "apm not found at $M3_APM — ADR-0008 D1's vendored 0.33.0 is not in this environment (and not in communication-worker:dev, which is the point: docs/m3-contract.md § 5 still has to vendor it)"
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

# ---- A3: the lock digest is per target ---------------------------------------
run_apm install --target codex >"$M3_FIXTURE/a3.log" 2>&1; a3rc=$?
d_codex="$(lock_digest)"
if [ "$a3rc" = 0 ] && [ -n "$d_claude" ] && [ -n "$d_codex" ] && [ "$d_claude" != "$d_codex" ]; then
    check A3 PASS "APM.md T5 / ADR-0008's per-target digest: sha256(apm.lock.yaml) differs per target for the SAME dependency set (claude=$d_claude codex=$d_codex) — agent_profiles.apm_lock_digest must be one value per target, not one per profile"
else
    check A3 FAIL "per-target digests did not differ as expected (rc=$a3rc claude=$d_claude codex=$d_codex)"
fi

# ---- A4: --frozen survives an upstream mutation (case 14) -------------------
run_apm install --frozen --target claude >/dev/null 2>&1
d_before="$(lock_digest)"; tree_before="$(cd "$B1" && find .claude apm_modules -type f | sort | xargs sha256sum 2>/dev/null | sha256sum | awk '{print $1}')"
printf '# alpha-skill\nALPHA-MARKER MUTATED-UPSTREAM\n' > "$M3_FIXTURE/pkgs/pkg-alpha/skills/alpha-skill/SKILL.md"
printf 'extra: true\n' >> "$M3_FIXTURE/pkgs/pkg-alpha/apm.yml"
run_apm install --frozen --target claude >"$M3_FIXTURE/a4.log" 2>&1; a4rc=$?
d_after="$(lock_digest)"; tree_after="$(cd "$B1" && find .claude apm_modules -type f | sort | xargs sha256sum 2>/dev/null | sha256sum | awk '{print $1}')"
deployed="$(cat "$B1/.claude/skills/alpha-skill/SKILL.md" 2>/dev/null | m3_oneline)"
if [ "$a4rc" = 0 ] && [ "$d_before" = "$d_after" ] && [ "$tree_before" = "$tree_after" ] && ! printf '%s' "$deployed" | grep -q MUTATED; then
    check A4 PASS "case 14's stability half re-derived: after the upstream local package was mutated, 'apm install --frozen' reproduced the identical lock digest ($d_after) and the identical deployed tree, and the mutated content did NOT appear ('$deployed')"
else
    check A4 FAIL "frozen install did not survive the upstream mutation (rc=$a4rc digest $d_before -> $d_after; deployed='$deployed')"
fi

# ---- A5: an unfrozen install DOES pick the mutation up (the digest must move)
run_apm install --target claude >"$M3_FIXTURE/a5.log" 2>&1; a5rc=$?
d_unfrozen="$(lock_digest)"; deployed2="$(cat "$B1/.claude/skills/alpha-skill/SKILL.md" 2>/dev/null | m3_oneline)"
if [ "$a5rc" = 0 ] && [ "$d_unfrozen" != "$d_after" ] && printf '%s' "$deployed2" | grep -q MUTATED; then
    check A5 PASS "the refusal path is measurable: without --frozen the same install moved the digest ($d_after -> $d_unfrozen) and deployed the mutated content ('$deployed2') — so a digest check before launch catches restaging, exactly as ADR-0008 D4 requires"
else
    check A5 FAIL "unfrozen install did not move the digest/deploy the change (rc=$a5rc $d_after -> $d_unfrozen, deployed='$deployed2')"
fi

# ---- A6: APM's generated paths are git-visible until excluded ---------------
status_raw="$(git -C "$B1" status --porcelain | tr '\n' ';' | m3_oneline)"
mkdir -p "$M/info"
for g in apm.yml apm.lock.yaml .gitignore .claude/ apm_modules/ .agents/ .codex/; do
    grep -qxF "$g" "$M/info/exclude" || printf '%s\n' "$g" >> "$M/info/exclude"
done
status_ex="$(git -C "$B1" status --porcelain | tr '\n' ';' | m3_oneline)"
if printf '%s' "$status_raw" | grep -q 'apm_modules' && ! printf '%s' "$status_ex" | grep -qE 'apm_modules|\.claude'; then
    check A6 PASS "contract § 4.2's exclusion step is load-bearing: before it, 'git status --porcelain' listed the staging output ($status_raw); after appending the generated paths to <mirror>/info/exclude it is clean ('$status_ex')"
else
    check A6 FAIL "exclusion of APM output did not behave as expected (before='$status_raw' after='$status_ex')"
fi

# ---- A7: a per-run HOME is only isolated if someone deletes it --------------
if [ -d "$W1/home/.apm" ] || [ -d "$W1/home/.cache/apm" ]; then
    check A7 N/A "home/ carries harness state (APM.md T4) — ADR-0017 D7's 'home/ deleted with the attempt' is what makes it throwaway, and the artifact/checkpoint exclusion set must name home/ (contract § 4.6)"
else
    check A7 GAP "no .apm/.cache under home/ to inspect (apm wrote elsewhere: '$home_writes')"
fi

m3_cleanup
exit 0
