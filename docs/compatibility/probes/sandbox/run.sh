#!/usr/bin/env bash
# M0 sandbox spike probe: observe what nono (Landlock) actually enforces.
#
# Usage:
#   bash run.sh [--nono <path-to-nono>] [--fixture <dir>] [--socket <path>] [--keep]
#
# Policy under test: read-write on <fixture>/projA only, everything else
# denied by omission (Landlock is an allowlist), outbound network blocked.
# Every case prints exactly one line:
#   CASE <id> <PASS|FAIL|GAP> <observed>
# PASS = observed behaviour matched the expected enforcement.
# The script always exits 0; a recorded FAIL/GAP is a result, not an error.
set -euo pipefail

NONO="${HOME}/.local/bin/nono"
FIXTURE="${HOME}/.cache/communication-lab/m0-nono/fixture"
SOCKET="/var/run/docker.sock"
KEEP=0

while [ $# -gt 0 ]; do
    case "$1" in
        --nono)    NONO="$2"; shift 2 ;;
        --fixture) FIXTURE="$2"; shift 2 ;;
        --socket)  SOCKET="$2"; shift 2 ;;
        --keep)    KEEP=1; shift ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
done

oneline() { tr '\n\r\t' '   ' | cut -c1-160; }

have_curl=1
command -v curl >/dev/null 2>&1 || have_curl=0

# ---- environment header (not a CASE line) -----------------------------------
echo "== nono sandbox probe"
echo "ENV date=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "ENV user=$(id -un 2>/dev/null || echo '?') uid=$(id -u)"
echo "ENV kernel=$(uname -r) machine=$(uname -m)"
echo "ENV lsm=$(cat /sys/kernel/security/lsm 2>/dev/null || echo 'unreadable')"
echo "ENV nono_bin=${NONO}"
echo "ENV nono_version=$("${NONO}" --version 2>&1 | oneline)"
echo "ENV nono_sha256=$(sha256sum "${NONO}" 2>/dev/null | awk '{print $1}' || echo '?')"
echo "ENV fixture=${FIXTURE}"
echo "ENV curl=$([ "${have_curl}" = 1 ] && echo yes || echo no)"
echo

# ---- fixture ----------------------------------------------------------------
rm -rf "${FIXTURE}"
mkdir -p "${FIXTURE}/projA" "${FIXTURE}/projB" "${FIXTURE}/fake-home/.ssh"
echo "PROJB-SECRET-MATERIAL" >"${FIXTURE}/projB/secret.txt"
echo "FAKE-PRIVATE-KEY-MATERIAL" >"${FIXTURE}/fake-home/.ssh/id_test"
# C4's symlink is created OUTSIDE the sandbox, before any nono run.
ln -sf ../projB/secret.txt "${FIXTURE}/projA/link"

# ---- helpers ----------------------------------------------------------------
# run_sandboxed <args...>  -> sets RC / OUT. Tolerates non-zero exits.
# Policy: rw projA only + --block-net (network blocked).
run_sandboxed() {
    sandboxed "--block-net" "$@"
}

# run_sandboxed_nonet <args...> -> same policy but network left in proxy mode
# (needed to exercise proxy-only failure paths; --block-net conflicts with
# --allow-domain).
run_sandboxed_proxy() {
    sandboxed "" "$@"
}

sandboxed() {
    local net_flag="$1"; shift
    local rc=0 out="" args=()
    if [ -n "${net_flag}" ]; then args+=("${net_flag}"); fi
    out="$( cd "${FIXTURE}/projA" && "${NONO}" run -s --allow "${FIXTURE}/projA" \
        "${args[@]}" "$@" 2>&1 )" || rc=$?
    RC=${rc}
    OUT="$(printf '%s' "${out}" | oneline)"
}

# run_unsandboxed <cmd...>
run_unsandboxed() {
    local rc=0 out=""
    out="$( cd "${FIXTURE}/projA" && "$@" 2>&1 )" || rc=$?
    RC=${rc}
    OUT="$(printf '%s' "${out}" | oneline)"
}

# report <id> <expected> <verdict>
report() { printf 'CASE %s %s %s\n' "$1" "$2" "$3"; }

# classify a "read must be denied" case
denied_verdict() {
    local id="$1"
    if printf '%s' "${OUT}" | grep -qi 'Sandbox initialization failed\|Landlock\|not supported\|unsupported'; then
        report "${id}" GAP "nono refused to start: ${OUT}"
    elif [ "${RC}" -ne 0 ] && printf '%s' "${OUT}" | grep -qi 'permission denied\|operation not permitted\|read-only file system'; then
        report "${id}" PASS "exit=${RC} ${OUT}"
    elif [ "${RC}" -ne 0 ]; then
        report "${id}" PASS "exit=${RC} (non-zero, content not returned) ${OUT}"
    else
        report "${id}" FAIL "exit=${RC} content readable: ${OUT}"
    fi
}

PROJB="${FIXTURE}/projB/secret.txt"
SSHK="${FIXTURE}/fake-home/.ssh/id_test"

# ---- cases ------------------------------------------------------------------
# C1: write inside the allowed workspace must succeed.
rm -f "${FIXTURE}/projA/out.txt"
run_sandboxed -- sh -c "echo agent-write > '${FIXTURE}/projA/out.txt'"
if [ "${RC}" -eq 0 ] && grep -q agent-write "${FIXTURE}/projA/out.txt" 2>/dev/null; then
    report C1 PASS "exit=0 projA/out.txt written, verified by reading it back outside the sandbox"
else
    report C1 FAIL "exit=${RC} ${OUT}"
fi

# C2: another project's checkout must not be readable.
run_sandboxed -- cat "${PROJB}"
denied_verdict C2

# C3: fake credential file must not be readable.
run_sandboxed -- cat "${SSHK}"
denied_verdict C3

# C4: symlink placed in projA pointing outside must not be readable.
run_sandboxed -- cat "${FIXTURE}/projA/link"
denied_verdict C4

# C5: lexical traversal out of projA must not be readable.
run_sandboxed -- cat "${FIXTURE}/projA/../projB/secret.txt"
denied_verdict C5

# C6: outbound network must be blocked.
if [ "${have_curl}" = 1 ]; then
    run_sandboxed -- curl -sS --max-time 5 https://example.com
    if [ "${RC}" -ne 0 ]; then
        report C6 PASS "exit=${RC} ${OUT}"
    else
        report C6 FAIL "exit=0 network reachable: ${OUT}"
    fi
else
    report C6 GAP "curl not installed in this environment"
fi

# C7: AF_UNIX connect to the Docker socket must be blocked.
if [ ! -S "${SOCKET}" ]; then
    report C7 GAP "socket ${SOCKET} not present in this environment"
elif [ "${have_curl}" != 1 ]; then
    report C7 GAP "curl not installed in this environment"
else
    run_sandboxed -- curl -sS --max-time 5 --unix-socket "${SOCKET}" http://localhost/version
    if [ "${RC}" -ne 0 ]; then
        report C7 PASS "exit=${RC} ${OUT}"
    else
        report C7 FAIL "exit=0 docker API answered: ${OUT}"
    fi
fi

# C8: denial must be inherited by grandchildren (nono -> sh -> cat).
run_sandboxed -- sh -c "sh -c 'cat \"${PROJB}\"'"
denied_verdict C8

# C9: /proc/1/environ of a process outside the sandbox.
run_sandboxed -- cat /proc/1/environ
denied_verdict C9

# C9b (informational): is /proc/<pid>/ metadata still listable?
run_sandboxed -- ls /proc/1/
if [ "${RC}" -ne 0 ]; then
    report C9b PASS "exit=${RC} /proc/1 not listable: ${OUT}"
else
    report C9b FAIL "exit=0 /proc/1 listable ($(printf '%s' "${OUT}" | wc -w) entries incl. environ/cmdline visible): ${OUT}"
fi

# C10: control — the same read without nono must succeed (fixture sanity).
run_unsandboxed cat "${PROJB}"
if [ "${RC}" -eq 0 ] && printf '%s' "${OUT}" | grep -q 'PROJB-SECRET-MATERIAL'; then
    report C10 PASS "exit=0 readable without sandbox, fixture works"
else
    report C10 FAIL "exit=${RC} ${OUT}"
fi

# ---- fail-closed demonstrator -----------------------------------------------
# FC1: request network enforcement that cannot be established (proxy cannot bind
# a privileged port). Does nono refuse to run the command, or run it anyway?
# Note: as uid 0 the bind succeeds, so the precondition may not hold — reported
# as N/A rather than a verdict.
MARKER="${FIXTURE}/projA/fc1-ran.txt"
rm -f "${MARKER}"
run_sandboxed_proxy --allow-domain example.com --proxy-port 1 \
    -- sh -c "echo i-ran > '${MARKER}'"
if printf '%s' "${OUT}" | grep -qi 'sandbox initialization failed\|proxy bind failed'; then
    if [ -e "${MARKER}" ]; then
        report FC1 FAIL "fail-open: command ran after nono reported it could not enforce the network policy (exit=${RC})"
    else
        report FC1 PASS "fail-closed: exit=${RC}, command never executed (${OUT})"
    fi
elif [ -e "${MARKER}" ]; then
    report FC1 N/A "precondition not met: uid=$(id -u) could bind proxy port 1, so bind failure could not be induced (exit=${RC})"
else
    report FC1 FAIL "exit=${RC} nono reported neither enforcement failure nor execution: ${OUT}"
fi

# FC2: ask nono to delegate TCP enforcement (--sandbox-policy external) while
# also asking for --block-net. Does anything warn, and is egress open?
if [ "${have_curl}" = 1 ]; then
    run_sandboxed --sandbox-policy external -- curl -sS --max-time 5 https://example.com
    if [ "${RC}" -ne 0 ]; then
        report FC2 PASS "exit=${RC} egress still blocked with sandbox-policy=external: ${OUT}"
    else
        report FC2 FAIL "fail-open: --block-net ignored with --sandbox-policy external, egress allowed (exit=${RC})"
    fi
else
    report FC2 GAP "curl not installed in this environment"
fi

# FC3: nonexistent grant path — does nono error, or sandbox with a missing grant?
run_sandboxed --allow "${FIXTURE}/does-not-exist" -- sh -c "cat '${PROJB}'"
if printf '%s' "${OUT}" | grep -qi 'permission denied'; then
    report FC3 PASS "nonexistent grant ignored, sandbox still applied (exit=${RC})"
else
    report FC3 FAIL "unexpected: ${OUT}"
fi

# FC4: is the kernel capability probe honest here? nono's own status report.
SRC=0
STATUS="$("${NONO}" setup --check-only 2>&1 | oneline)" || SRC=$?
if [ "${SRC}" -eq 0 ]; then
    report FC4 PASS "nono setup --check-only ok: ${STATUS}"
else
    report FC4 FAIL "nono setup --check-only exit=${SRC}: ${STATUS}"
fi

# FC5: network policy that depends on an upstream proxy which does not exist.
# Expected: egress is denied, never silently permitted outside the policy.
if [ "${have_curl}" = 1 ]; then
    run_sandboxed_proxy --allow-domain example.com --upstream-proxy 127.0.0.1:9 \
        -- curl -sS --max-time 5 https://example.com
    if [ "${RC}" -ne 0 ]; then
        report FC5 PASS "dead upstream proxy -> egress denied not permitted: exit=${RC} ${OUT}"
    else
        report FC5 FAIL "fail-open: egress succeeded through a dead upstream proxy (exit=${RC})"
    fi
else
    report FC5 GAP "curl not installed in this environment"
fi

# FC6: unsatisfiable policy request (out-of-range proxy port). Expected: nono
# refuses to launch the command at all.
MARKER6="${FIXTURE}/projA/fc6-ran.txt"
rm -f "${MARKER6}"
run_sandboxed_proxy --allow-domain example.com --proxy-port 65536 \
    -- sh -c "echo i-ran > '${MARKER6}'"
if [ ! -e "${MARKER6}" ]; then
    report FC6 PASS "fail-closed: exit=${RC}, invalid policy rejected before exec (${OUT})"
else
    report FC6 FAIL "fail-open: command ran with an invalid network policy"
fi

if [ "${KEEP}" = 0 ]; then
    rm -rf "${FIXTURE}"
fi
exit 0
