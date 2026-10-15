#!/usr/bin/env bash
# m3 probe 5 — worker volume identity (ADR-0017 Decision 2, case 20's premise):
# `st_dev` as the thing `workers.volume_id` hashes, measured with real Docker
# named volumes and a real host bind at the same path. Run on the HOST; it
# needs the docker CLI and creates/removes only its own volumes (m3probe-*).
#
# Usage: bash p5_volume_identity.sh [--image communication-worker:dev]
set -uo pipefail
M3_PROBE=p5_volume_identity
M3_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$M3_DIR"
# shellcheck source=lib.sh
. ./lib.sh
M3_FIXTURE="${M3_FIXTURE_ARG:-${M3_PROBE_ROOT_BASE}/p5}"
M3_IMAGE=communication-worker:dev
while [ $# -gt 0 ]; do
    case "$1" in
        --image) M3_IMAGE="$2"; shift 2 ;;
        *) m3_args "$1"; [ $# -gt 1 ] && shift || shift=0; shift ;;
    esac
done
m3_env_header

if ! command -v docker >/dev/null 2>&1; then
    check PREAMBLE GAP "docker CLI not on PATH — volume identity cannot be measured here"
    exit 0
fi
if ! docker image inspect "$M3_IMAGE" >/dev/null 2>&1; then
    check PREAMBLE GAP "image $M3_IMAGE not present (this probe runs against the real worker image)"
    exit 0
fi

BIND="$M3_FIXTURE/bind"; mkdir -p "$BIND"
V1="m3probe-v1-$$"; V2="m3probe-v2-$$"; V3="m3probe-v3-$$"
cleanup_vols() { docker volume rm "$V1" "$V2" "$V3" >/dev/null 2>&1 || true; rm -rf "$M3_FIXTURE"; }
trap cleanup_vols EXIT

stat2() { # stat2 <mount-src> <path> — "st_dev inode" of a path inside one fresh container
    docker run --rm -v "$1:$2" --entrypoint sh "$M3_IMAGE" -c "stat -c '%d %i' '$2'" 2>&1 | tail -1
}
stat_pair() { # stat_pair <volume> <pathA> <pathB> — two mounts of ONE volume, one container
    docker run --rm -v "$1:$2" -v "$1:$3" --entrypoint sh "$M3_IMAGE" -c "stat -c '%d %i' '$2'; stat -c '%d %i' '$3'" 2>&1 | tr '\n' '|'
}

d1="$(stat2 "$V1" /workspaces)"; d2="$(stat2 "$V1" /workspaces)"
d3="$(stat2 "$V2" /workspaces)"
d4="$(stat2 "$BIND" /workspaces)"
dev1="${d1% *}"; ino1="${d1#* }"; dev3="${d3% *}"; ino3="${d3#* }"
check V1 N/A "named volume $V1 mounted at /workspaces in a fresh container: st_dev=$dev1 inode=$ino1"
if [ "$d1" = "$d2" ]; then
    check V2 PASS "ADR-0017 D2's premise, same-volume arm: the same named volume at the same path reports the same st_dev AND inode in two fresh containers ($d1 == $d2) — an identity derived from (dev, inode, path) survives a worker restart"
else
    check V2 FAIL "the same named volume reported different identity across containers ($d1 vs $d2) — (dev, inode) is not a stable volume identity and case 20's same-volume arm would report false loss"
fi
if [ "$dev1" != "$dev3" ]; then
    check V3 PASS "a replaced named volume changes st_dev at the same path ($dev1 vs $dev3) — the D2 rule would catch it"
else
    check V3 FAIL "ADR-0017 D2's derivation is INSUFFICIENT as written: two DIFFERENT docker named volumes at the same path share st_dev ($dev1 == $dev3 — docker volumes are bind mounts of host directories on one filesystem), so 'resolves the st_dev of its workspace root, hashes the device identity plus the root path' would call a replaced volume the SAME volume and silently reclaim workspaces that are gone (case 20's honest-loss arm would never fire). The inode DOES differ ($ino1 vs $ino3), so volume_id must be (st_dev, root inode, root path) — V2 shows that triple is stable across containers for one volume"
fi
if [ "$dev1" != "${d4% *}" ]; then
    check V4 PASS "compose.harness.yml's shape (host bind over a volume path): bind mount is on st_dev ${d4% *} vs the named volume's $dev1 at the identical path — switching the dev harness really does change volume identity"
else
    check V4 FAIL "a host bind at the same path shared st_dev with the named volume (${d4}) — identity would not notice the harness override"
fi

pair="$(stat_pair "$V3" /workspaces /repos)"
pa="${pair%%|*}"; pb="$(printf '%s' "$pair" | awk -F'|' '{print $2}')"
if [ "${pa% *}" = "${pb% *}" ]; then
    check V5 PASS "ADR-0017 D1's 'repos/ beside workspaces/ on the same worker volume': one volume mounted at both paths reports one st_dev (workspaces=$pa repos=$pb) — 'same volume' is a device statement that holds"
else
    check V5 FAIL "one volume mounted at two paths gave different st_dev (workspaces=$pa repos=$pb)"
fi
sep1="$(stat2 "$V1" /workspaces)"; sep2="$(stat2 "$V2" /repos)"
if [ "${sep1% *}" = "${sep2% *}" ] && [ "${sep1#* }" != "${sep2#* }" ]; then
    check V5b FAIL "docs/m3-contract.md § 5 gives the mirror root its OWN named volume beside the workspaces volume — measured /workspaces=(dev ${sep1% *}, ino ${sep1#* }) and /repos=(dev ${sep2% *}, ino ${sep2#* }): same device, different inode. workers.volume_id is one column, so it names exactly one of the two trees; the recovery rule has to say which, or store the identity per path (workspace_repos.mirror_path is already per-path)"
else
    check V5b PASS "separate named volumes for /workspaces and /repos are distinguishable by (dev, inode) as measured: workspaces=$sep1 repos=$sep2"
fi

root_stat="$(docker run --rm -v "$V1:/workspaces" --entrypoint sh "$M3_IMAGE" -c 'echo "root=$COMMUNICATION_WORKSPACE_ROOT dev=$(stat -c %d "$COMMUNICATION_WORKSPACE_ROOT") ino=$(stat -c %i "$COMMUNICATION_WORKSPACE_ROOT") fstype=$(stat -c %T "$COMMUNICATION_WORKSPACE_ROOT") uid=$(id -u)"' 2>&1 | tail -1)"
check V6 N/A "the worker image's own view of its configured root, i.e. the exact tuple ADR-0017 D2 hashes: $root_stat"

cleanup_vols
trap - EXIT
exit 0
