#!/usr/bin/env bash
# m4 exit probe runner — docs/m4-contract.md § 7 evidence capture.
#
#   bash run.sh            # writes results-exit.txt (commands + literal output)
#   M4_RESULTS=/path run.sh
#
# Honesty rule (AGENTS.md, 12-test-strategy.md): a PASS line only ever
# accompanies an observed literal. TODAY the M4 Go code is still landing, so
# the honest output of this script is a block of SKIP lines saying WHY. That
# is the point of running it before the stack exists — see README.md.
#
# Isolation (§ 7.0): project communication-m4, ports 18091-18095/18099 only.
# This script never starts or stops the stack and never touches another
# compose project or port block.
set -uo pipefail
M4_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$M4_DIR"
export M4_PROBE=exit-runner
# shellcheck source=lib.sh
. "$M4_DIR/lib.sh"
export M4_PROBE_ROOT_BASE="${M4_PROBE_ROOT_BASE:-$HOME/.cache/communication-lab/m4-probes}"
mkdir -p "$M4_PROBE_ROOT_BASE"
LOG="${M4_RESULTS:-$M4_DIR/results-exit.txt}"
: > "$LOG"

emit() { printf '%s\n' "$*" | tee -a "$LOG"; }
# check/note print to stdout via lib.sh; tee them into the evidence file too.
ck() { check "$@" | tee -a "$LOG"; }
nt() { note  "$@" | tee -a "$LOG"; }

# case id + one-line intent (authority: docs/m4-contract.md § 7; the driver in
# e2e/m4/e2e_m4_exit.py holds the full acceptance text per gate).
CASES=(
"C1|sample pipeline completes end to end, twice, deterministically (agent run + process.exec twin)"
"C2|unit of work is the attempt: secret sentinel lives only in the authorized attempt's live environment"
"C3|two workers claim one ready attempt: one lease, fencing token drawn once per claim"
"C4|worker loses its lease but keeps running: stale writes rejected by the fence"
"C5|EXIT GATE: docker kill worker mid-node -> reconciler interrupted -> bounded retry -> completed (continue_workspace)"
"C6|restore_checkpoint reset is real; uncommitted boundary refuses 409; cross-volume arm says lost"
"C7|until never passes: exhaustion at maxIterations with per-iteration evidence; predicate_error != false"
"C8|fan-out 0 and 25 items, maxConcurrency 3 measured from the journal, child-failure policies, cascade"
"C9|durable gates: no lease, decide at decision time, approver-lost-access refused, CAS, rejection is business"
"C10|malformed reviewer reply fails invalid_output; routing never sees a coercion"
"C11|prompt-injection egress probe: collector (18099) receives no sentinel, no fencing/lease values"
"C12|CEL subset cannot be widened; runs pinned: mid-run republish cannot move digests"
"C13|refusals are real: deferred kinds name their milestone, secret literals block, roots table executable"
"C14|control-plane rolling update + two-replica advancer race: no duplicated terminal events"
"W1|UI: run form from spec.inputs; idempotency key on submit"
"W2|UI: live event stream renders; iterations not duplicate nodes"
"W3|UI: gate card button only for designated approvers"
"W4|UI: pinned-digest notice after mid-run republish"
"W5|UI: kill worker -> honest interrupted wording, never 'resumed'"
"W6|UI: cross-volume loss says 'prior edits lost, rerun required'"
"W7|UI: ops counters + 'waiting for its worker' honesty"
"W8|UI: validate panel renders located errors, redacted secret findings"
"W9|UI: cross-project deep links 404 with zero leakage"
"W10|UI: SSE continuity across a replica roll"
"W11|UI: run tree + attempt list; fence internals absent from DOM"
)

emit "== m4 exit probe suite"
if m4_stack_up; then STACK_STATE=UP; else STACK_STATE=DOWN; fi
if [ "$STACK_STATE" = DOWN ]; then
    emit "NOTE stack DOWN — exit gates cannot run. Bring the lab up with:"
    emit "NOTE   HOST_UID=\$(id -u) HOST_GID=\$(id -g) \\"
    emit "NOTE     docker compose -p communication-m4 -f compose.yml -f compose.harness.yml -f compose.m4.yml up -d --build"
fi
emit ""

for entry in "${CASES[@]}"; do
    id="${entry%%|*}"; intent="${entry#*|}"
    if [ "$STACK_STATE" = DOWN ]; then
        ck "$id" SKIP "stack not up — gate's precondition is the M4 exit stack (§ 7.0)"
    else
        # Stack is up, but the scripted gate bodies live in
        # e2e/m4/e2e_m4_exit.py and are stubs until the M4 Go code lands.
        ck "$id" SKIP "stack up, but gate not yet implemented — driver prints the same SKIP (e2e/m4/e2e_m4_exit.py)"
    fi
    nt "$id" "intent: $intent"
done

emit ""
emit "== summary"
awk '/^CHECK / { v[$3]++; t++ } END { s="SUMMARY"; split("PASS FAIL GAP SKIP N/A", order, " "); for (i in order) { k=order[i]; s=s sprintf(" %s=%d", k, v[k]+0) } print s sprintf(" TOTAL=%d", t) }' "$LOG" | tee -a "$LOG"
awk '/^CHECK / && $3=="FAIL" { print "FAILED_CLAIM " $2 " " $4 }' "$LOG" | tee -a "$LOG"
echo "evidence: $LOG" >&2
# Honest today: SKIPs are not failures of the runner. Exit non-zero only on
# real FAIL lines.
if grep -q '^CHECK .* FAIL' "$LOG"; then exit 1; fi
exit 0
