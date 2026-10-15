#!/usr/bin/env bash
# m3 probe runner — re-derives every sandbox/git/secret claim
# docs/m3-contract.md and ADR-0017/0018/0019 stand on. See README.md for the
# two commands that make the M3 evidence reproducible (host + worker image).
#
# Usage:
#   bash run.sh [--nono <path>] [--root <dir>] [--groups "p1 p2 p3 p4 p5"]
#
# Output: each probe's ENV header + CHECK/NOTE lines, then a SUMMARY block.
set -uo pipefail
M3_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$M3_DIR"
export M3_NONO="${M3_NONO:-$HOME/.local/bin/nono}"
export M3_PROBE_ROOT_BASE="${M3_PROBE_ROOT_BASE:-$HOME/.cache/communication-lab/m3-probes}"
M3_GROUPS="p1 p2 p3 p4 p5 p6"
while [ $# -gt 0 ]; do
    case "$1" in
        --nono)   M3_NONO="$2"; shift 2 ;;
        --root)   M3_PROBE_ROOT_BASE="$2"; shift 2 ;;
        --groups) M3_GROUPS="$2"; shift 2 ;;
        *) echo "unknown arg: $1" >&2; exit 2 ;;
    esac
done
mkdir -p "$M3_PROBE_ROOT_BASE"
LOG="$(mktemp "${M3_PROBE_ROOT_BASE}/run.XXXXXX.log")"

emit() { printf '%s\n' "$@" | tee -a "$LOG"; }

emit "== m3 probe suite"
emit "SUITE nono=$M3_NONO root=$M3_PROBE_ROOT_BASE groups='$M3_GROUPS' host=$(uname -n) date=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
for g in $M3_GROUPS; do
    case "$g" in
        p1) f=p1_git_worktrees.sh ;;
        p2) f=p2_git_under_nono.sh ;;
        p3) f=p3_nono_policy.sh ;;
        p4) f=p4_secrets_env.sh ;;
        p5) f=p5_volume_identity.sh ;;
        p6) f=p6_apm_staging.sh ;;
        *) emit "CHECK $g-unknown FAIL no such probe group"; continue ;;
    esac
    emit ""
    emit "================================================================"
    emit "## $f"
    emit "================================================================"
    rc=0
    bash "$M3_DIR/$f" 2>&1 | tee -a "$LOG" || rc=$?
    [ "$rc" -ne 0 ] && emit "CHECK $g-script FAIL exited non-zero ($rc)"
done
emit ""
emit "== summary"
awk '/^CHECK / { v[$3]++; t++ } END { s="SUMMARY"; split("PASS FAIL GAP N/A", order, " "); for (i in order) { k=order[i]; s=s sprintf(" %s=%d", k, v[k]+0) } print s sprintf(" TOTAL=%d", t) }' "$LOG" | tee -a "$LOG"
awk '/^CHECK / && $3=="FAIL" { print "FAILED_CLAIM " $2 " " $4 }' "$LOG" | tee -a "$LOG"
echo "log: $LOG" >&2
exit 0
