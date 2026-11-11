#!/usr/bin/env bash
# scripts/kind/test.sh — ADR-0082 Decision 10: prove the chart in a real kind
# cluster. Three configurations (single, split + local, split + kubernetes), a
# throwaway Postgres, `communication doctor`'s sandbox verdict read from inside
# the running container, and the worker's least-privilege boundary checked with
# `kubectl auth can-i`.
#
# Nothing here marks a sandbox or protocol row PASS on inference: the doctor row
# prints what the binary observed (12-test-strategy.md — no prefilled PASS).
#
# It then runs the three spikes only a cluster can answer (ADR-0082 Decision 10,
# internal/sandbox/k8s/kind_test.go behind the `kind` build tag): S1, whether
# Landlock really denies a write inside an attempt pod; S2, whether ACP really rides
# a `pods/exec` stdio pipe through the production Transporter; S4, whether the
# garbage collector really takes the per-attempt Secret with its pod.
#
# Usage:
#   scripts/kind/test.sh                       # deletes the cluster at exit
#   KEEP=1 scripts/kind/test.sh                # leave it up for inspection
#   DOCKER="sudo -n docker" \
#   KIND="sudo -n env PATH=$PATH kind" scripts/kind/test.sh   # this host: docker needs sudo
#
# Knobs: DOCKER and KIND may carry a sudo prefix ("sudo -n docker"); KUBECTL and
# HELM must be a single command name. KEEP, SKIP_BUILD.
# SRC=<dir> builds the images, the chart and the spike tests from another tree
# (a clean worktree of HEAD plus the changes under test) instead of this one, so a
# dirty checkout of somebody else's work is never what a verdict is drawn from.
# Everything it reads — Dockerfile, worker/Dockerfile, the chart, scripts/kind's
# own manifests, the Go packages — comes from $SRC.
# Port choice for the two readiness port-forwards: random in 9000-9999, retried
# on a bind failure, and only ever used on this host. NEVER published.

# Scope: the cluster is named communication-kind and everything created here
# lives inside it. The script never runs `docker rm`, never touches a compose
# project, and never stops a container it did not start.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

DOCKER="${DOCKER:-docker}"
KIND="${KIND:-kind}"
KUBECTL="${KUBECTL:-kubectl}"
HELM="${HELM:-helm}"

SRC="${SRC:-$REPO_ROOT}"
# A guard, not a log line: `log` is defined below, and a wrong SRC must say so
# without depending on anything else in the script.
[ -f "$SRC/worker/Dockerfile" ] || { printf 'SRC=%s is not a Communication tree (no worker/Dockerfile)\n' "$SRC" >&2; exit 2; }

CLUSTER=communication-kind
NS=communication
AGENT_NS=communication-agents
SERVE_IMAGE=communication:kind
WORKER_IMAGE=communication-worker:kind
CHART="$SRC/deploy/helm/communication"
RELEASE=communication
# The claim the attempt pods mount, under test: the release's own claim lives in
# the release namespace and a claim cannot be mounted across namespaces, so the
# kubernetes phase binds one in the agent namespace to the SAME volume (see the
# configuration-3 phase) and points worker.workspacePVC at it.
AGENT_CLAIM=communication-agents-data

STATE="$(mktemp -d)"
KCFG="$STATE/kubeconfig"
: >"$KCFG"
chmod 600 "$KCFG"
export KUBECONFIG="$KCFG"
PF_PID=""
CLUSTER_CREATED=0
RESULTS=()

log() { printf 'kind-test: %s\n' "$*" >&2; }

cleanup() {
    if [ -n "$PF_PID" ]; then kill "$PF_PID" 2>/dev/null || true; fi
    if [ "${KEEP:-0}" = "1" ]; then
        log "KEEP=1: leaving cluster $CLUSTER up (KUBECONFIG=$KCFG)"
    elif [ "$CLUSTER_CREATED" = "1" ]; then
        log "deleting cluster $CLUSTER"
        $KIND delete cluster --name "$CLUSTER" >/dev/null 2>&1 \
            || log "cluster delete failed; remove it by hand (kind delete cluster --name $CLUSTER)"
    else
        log "cluster $CLUSTER pre-existed this run; leaving it untouched"
    fi
    rm -rf "$STATE"
}
trap cleanup EXIT

record() { RESULTS+=("${1}|${2}|${3}"); }

print_table() {
    local r name status detail failed=0
    printf '\n==== scripts/kind/test.sh ============================================================\n'
    printf '%-42s %-6s %s\n' CHECK RESULT DETAIL
    printf '%-42s %-6s %s\n' '------------------------------------------' '------' '------'
    for r in "${RESULTS[@]}"; do
        [ -n "$r" ] || continue
        name="${r%%|*}"; status="${r#*|}"; detail="${status#*|}"; status="${status%%|*}"
        # INFO is a verdict the host kernel owns (the sandbox probe rows): it is
        # reported, never counted as a pass and never counted as a failure.
        case "$status" in PASS|INFO) ;; *) failed=$((failed + 1)) ;; esac
        printf '%-42s %-6s %s\n' "$name" "$status" "$detail"
    done
    printf '%s\n' '=============================================================================='
    if [ "$failed" = "0" ]; then
        echo "PASS  (${#RESULTS[@]} checks)"
        return 0
    fi
    echo "FAIL  ($failed of ${#RESULTS[@]} checks)"
    return 1
}

# check NAME cmd... — PASS on exit 0, FAIL otherwise. Never aborts the run.
check() {
    local name="$1"; shift
    local out rc=0
    out="$("$@" 2>&1)" || rc=$?
    if [ "$rc" = "0" ]; then
        record "$name" PASS "$(printf '%s' "$out" | tail -n 1 | cut -c1-84)"
    else
        record "$name" FAIL "$(printf '%s' "$out" | tail -n 1 | cut -c1-84)"
        printf '%s\n' "$out" >&2
    fi
}

# expect NAME want cmd... — PASS when the command's stdout, trimmed of leading
# and trailing whitespace, equals want. Used for `kubectl auth can-i`, whose
# whole answer is yes/no, and for a jsonpath read-back.
expect() {
    local name="$1" want="$2"; shift 2
    local got
    got="$($KUBECTL "$@" 2>/dev/null | sed -e '1s/^[[:space:]]*//' -e 's/[[:space:]]*$//' | paste -sd' ' -)" || true
    if [ "$got" = "$want" ]; then
        record "$name" PASS "got ${got:0:40}"
    else
        record "$name" FAIL "wanted ${want:0:40}, got ${got:-<empty>}"
    fi
}

# ---------------------------------------------------------------- preflight --
for cmd in ${KIND%% *} ${KUBECTL%% *} ${HELM%% *}; do
    command -v "$cmd" >/dev/null 2>&1 || { log "missing required command: $cmd"; exit 2; }
done
if ! $DOCKER info >/dev/null 2>&1; then
    log "docker is unreachable via '$DOCKER' (this host needs DOCKER=\"sudo -n docker\")"
    exit 2
fi
log "host: kernel $(uname -r), ptrace_scope $(cat /proc/sys/kernel/yama/ptrace_scope 2>/dev/null || echo unreadable)"
log "note: Yama is host-wide, so kind cannot reproduce the Talos ptrace_scope=2 failure (research § 3)"

# ------------------------------------------------------------------ cluster --
if $KIND get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
    log "cluster $CLUSTER already exists; reusing it and leaving it up at exit"
    KEEP=1
else
    log "creating kind cluster $CLUSTER (node image pinned by digest)"
    if $KIND create cluster --name "$CLUSTER" \
        --config "$SRC/scripts/kind/kind-config.yaml" \
        --kubeconfig "$KCFG" >&2; then
        CLUSTER_CREATED=1
        record "kind cluster create" PASS 'v0.33.0 node image, pinned @sha256'
    else
        record "kind cluster create" FAIL 'see output above'
        print_table || true
        exit 1
    fi
fi
$KIND get kubeconfig --name "$CLUSTER" >"$KCFG" 2>/dev/null || true
check "cluster reachable" $KUBECTL get nodes
# kind runs one node, and the launcher pins every attempt to it (ADR-0082
# Decision 4: the workspace claim is single-writer). The spikes need the same pin.
NODE_NAME="$($KUBECTL get nodes -o jsonpath='{.items[0].metadata.name}')"

# ------------------------------------------------------------------- images ---
# The root Dockerfile never compiles Go (ADR-0004: GoReleaser hands it the
# binary), so the serve image is built from a throwaway context holding that one
# file. ui/dist has to exist for //go:embed (ADR-0007).
build_serve_image() {
    local ctx rc=0
    ctx="$(mktemp -d)"
    # ui/dist/.gitkeep is committed so //go:embed compiles in a fresh clone
    # (ADR-0007); the serve image never carries a UI bundle of its own.
    ( cd "$SRC" && CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags "-s -w" \
        -o "$ctx/communication" ./cmd/communication ) \
        || { rm -rf "$ctx"; return 1; }
    cp "$SRC/Dockerfile" "$ctx/Dockerfile"
    # The build's own status is the answer: `rm -rf` after it must not be the
    # last command in the function, or a failed image would report PASS.
    $DOCKER build -q -t "$SERVE_IMAGE" "$ctx" >/dev/null || rc=$?
    rm -rf "$ctx"
    return $rc
}
if [ "${SKIP_BUILD:-0}" = "1" ]; then
    record "build serve image" PASS 'SKIP_BUILD=1'
    record "build worker image" PASS 'SKIP_BUILD=1'
else
    log "building $SERVE_IMAGE (Dockerfile)"
    check "build serve image" build_serve_image
    log "building $WORKER_IMAGE from $SRC (worker/Dockerfile); a cold build is slow"
    check "build worker image" $DOCKER build -q -t "$WORKER_IMAGE" -f "$SRC/worker/Dockerfile" "$SRC"
fi
check "kind load serve image" $KIND load docker-image "$SERVE_IMAGE" --name "$CLUSTER"
check "kind load worker image" $KIND load docker-image "$WORKER_IMAGE" --name "$CLUSTER"

# --------------------------------------------------------------- namespaces ---
ensure_ns() { $KUBECTL get ns "$1" >/dev/null 2>&1 || $KUBECTL create ns "$1" >/dev/null; }
check "namespace $NS" ensure_ns "$NS"
check "namespace $AGENT_NS" ensure_ns "$AGENT_NS"

# ----------------------------------------------------------- throwaway pg -----
check "postgres manifest apply" $KUBECTL apply -f "$SRC/scripts/kind/postgres.yaml"

# Secrets. The chart names a Secret and a key and renders no value, so this
# script owns the two the install references — created here, never printed,
# never written into the tree.
pg_password() { $KUBECTL get secret communication-postgres -n "$NS" -o jsonpath='{.data.password}' | base64 -d; }
make_pg_secret() {
    local f="$STATE/pg-secret.yaml"
    umask 077
    printf 'apiVersion: v1\nkind: Secret\nmetadata:\n  name: communication-postgres\n  namespace: %s\ntype: Opaque\nstringData:\n  password: "%s"\n' \
        "$NS" "$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')" >"$f"
    $KUBECTL apply -f "$f" >/dev/null
    rm -f "$f"
}
if $KUBECTL get secret communication-postgres -n "$NS" >/dev/null 2>&1; then
    record "postgres password secret" PASS 'reused the existing communication-postgres'
else
    check "postgres password secret" make_pg_secret
fi

# database.urlSecret: one key, the full DSN (ADR-0082 Decision 9).
make_url_secret() {
    local f="$STATE/url-secret.yaml"
    umask 077
    printf 'apiVersion: v1\nkind: Secret\nmetadata:\n  name: communication-database-url\n  namespace: %s\ntype: Opaque\nstringData:\n  url: "postgres://communication:%s@communication-postgres:5432/communication?sslmode=disable"\n' \
        "$NS" "$(pg_password)" >"$f"
    $KUBECTL apply -f "$f" >/dev/null
    rm -f "$f"
}
check "database-url secret" make_url_secret

# keyring secret. `communication` has no keyring-generation mode (main.go's
# switch is serve/worker/dev/migrate/doctor/version/help), so this is the lab's
# own recipe: 32 random bytes as hex in one master-key-v1 file
# (compose.yml's keyring-init; the format parseMasterKey demands,
# internal/secrets/keyring.go:162-176). An operator without the lab can copy the
# one-line command in docs/run-modes.md.
make_keyring_secret() {
    local f="$STATE/keyring-secret.yaml"
    umask 077
    printf 'apiVersion: v1\nkind: Secret\nmetadata:\n  name: communication-keyring\n  namespace: %s\ntype: Opaque\nstringData:\n  master-key-v1: "%s"\n' \
        "$NS" "$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')" >"$f"
    $KUBECTL apply -f "$f" >/dev/null
    rm -f "$f"
}
check "keyring secret" make_keyring_secret
check "postgres ready" $KUBECTL -n "$NS" rollout status deployment/communication-postgres --timeout=240s

# ------------------------------------------------------------------ install ---
install_chart() {
    local values="$1"; shift
    $HELM upgrade --install "$RELEASE" "$CHART" \
        --namespace "$NS" --wait --timeout 10m \
        -f "$values" \
        --set image.repository=communication-worker --set image.tag=kind \
        --set serveImage.repository=communication --set serveImage.tag=kind \
        --set persistence.storageClass=standard \
        "$@"
}

# endpoint the pods' own probe uses (ADR-0013: schema current, not just alive).
free_port() {
    local p
    for _ in 1 2 3 4 5; do
        p=$((9000 + RANDOM % 1000))
        ss -ltnH "sport = :$p" 2>/dev/null | grep -q . || { printf '%s' "$p"; return 0; }
    done
    return 1
}

# readiness_probe port-forwards the chart's Service and reads the readiness
readiness_probe() {
    local port body rc=0
    port="$(free_port)" || { echo "no free host port in 9000-9999" >&2; return 1; }
    $KUBECTL -n "$NS" port-forward "svc/$RELEASE" "${port}:80" >"$STATE/pf.log" 2>&1 &
    PF_PID=$!
    sleep 3
    body="$(curl -fsS --max-time 20 "http://127.0.0.1:${port}/api/v1/system/readiness")" || rc=$?
    kill "$PF_PID" 2>/dev/null || true
    wait "$PF_PID" 2>/dev/null || true
    PF_PID=""
    [ "$rc" = "0" ] || return "$rc"
    printf '%s' "$body"
}

# doctor_in runs the shipped binary's own sandbox gate INSIDE the running
# container — the probe must run in a pod, not on a node shell (research § 3).
# ADR-0082 Decision 10 asks for it in an attempt pod; the attempt pod only exists
# once the pod launcher lands (queued behind this chart), so this runs it in the
# single-mode pod, which is the same image, uid, seccomp and drop-ALL shape.
doctor_in() {
    local component="$1" container="$2"
    local pod
    pod="$($KUBECTL -n "$NS" get pod -l "app.kubernetes.io/instance=$RELEASE,app.kubernetes.io/component=$component" \
        -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
    [ -n "$pod" ] || { echo "no pod for component=$component" >&2; return 1; }
    $KUBECTL -n "$NS" exec "$pod" -c "$container" -- communication doctor
}

# ---------------------------------------------------- configuration 1: single -
log "installing mode=single (ci/single.yaml, devLogin)"
check "helm install single" install_chart "$CHART/ci/single.yaml" --set devLogin=true
check "single rollout" $KUBECTL -n "$NS" rollout status deployment/"$RELEASE" --timeout=300s
check "single readiness endpoint" readiness_probe
DOCTOR_OUT="$(doctor_in single communication 2>&1 || true)"
printf '%s\n' "$DOCTOR_OUT" >"$STATE/doctor-single.txt"
log "doctor in the single-mode pod:"
printf '%s\n' "$DOCTOR_OUT" | sed 's/^/    /' >&2
# sandbox:* rows first — they are the verdict; the kernel/landlock-lsm lines are
# context that would otherwise eat the 200-char budget.
SANDBOX="$(printf '%s\n' "$DOCTOR_OUT" | { grep -E 'sandbox:' || true; } | tr '\n' ' ' | cut -c1-240)"
if [ -n "$SANDBOX" ]; then
    # An INFO row: the verdict is the host kernel's, and a refusal here is a
    # finding to report, not a chart defect to hide.
    record "doctor sandbox lines" INFO "$SANDBOX"
else
    record "doctor sandbox lines" FAIL 'doctor printed no sandbox lines'
fi

# ----------------------------------------------- configuration 2: split+local -
log "reinstalling mode=split with launcher=local"
check "helm install split+local" install_chart "$CHART/ci/split-local.yaml" --set devLogin=true
check "serve rollout" $KUBECTL -n "$NS" rollout status deployment/"$RELEASE"-serve --timeout=300s
check "worker rollout (local launcher)" $KUBECTL -n "$NS" rollout status deployment/"$RELEASE"-worker --timeout=300s
check "split readiness endpoint" readiness_probe
SPLIT_DOCTOR="$(doctor_in worker worker 2>&1 || true)"
printf '%s\n' "$SPLIT_DOCTOR" >"$STATE/doctor-worker.txt"
log "doctor in the split-mode worker pod:"
printf '%s\n' "$SPLIT_DOCTOR" | sed 's/^/    /' >&2
WSP="$(printf '%s\n' "$SPLIT_DOCTOR" | { grep -E 'sandbox:' || true; } | tr '\n' ' ' | cut -c1-240)"
record "worker doctor sandbox lines" "$([ -n "$WSP" ] && echo INFO || echo FAIL)" "${WSP:-doctor printed no sandbox lines}"

# RBAC must be absent in both of these — that is the whole privilege argument.
no_roles() {
    local values="$1" n
    n="$($HELM template x "$CHART" -f "$values" \
        | { grep -cE '^kind: (Role|RoleBinding|ServiceAccount)' || true; } | tr -d '[:space:]')"
    [ "$n" = "0" ] || { echo "rendered $n privilege objects from $values" >&2; return 1; }
    return 0
}
# The rendering is the contract; `helm get manifest` proves the LIVE release
# rendered the same way, which a namespace scan cannot (another run's objects
# would be counted against it).
check "single renders no RBAC" no_roles "$CHART/ci/single.yaml"
check "split+local renders no RBAC" no_roles "$CHART/ci/split-local.yaml"
live_rbac() {
    local n
    n="$($HELM get manifest "$RELEASE" -n "$NS" \
        | { grep -cE '^kind: (Role|RoleBinding|ServiceAccount)' || true; } | tr -d '[:space:]')"
    [ "$n" = "0" ] || { echo "the live release rendered $n privilege objects" >&2; return 1; }
}
check "live split+local release has no RBAC" live_rbac

# ------------------------------------------- configuration 3: split+kubernetes -
log "rendering mode=split with launcher=kubernetes"
check "helm template split-kubernetes" $HELM template "$RELEASE" "$CHART" \
    -f "$CHART/ci/split-kubernetes.yaml" --namespace "$NS"
apply_rbac() {
    $HELM template "$RELEASE" "$CHART" -f "$CHART/ci/split-kubernetes.yaml" \
        --namespace "$NS" -s templates/rbac.yaml | $KUBECTL apply -f -
}
check "RBAC apply (agent namespace)" apply_rbac
IMPERSONATE="system:serviceaccount:$NS:$RELEASE-worker"
expect "creates pods in $AGENT_NS" yes auth can-i create pods -n "$AGENT_NS" --as="$IMPERSONATE"
expect "creates pods/exec in $AGENT_NS" yes auth can-i create pods/exec -n "$AGENT_NS" --as="$IMPERSONATE"
expect "reads pods/log in $AGENT_NS" yes auth can-i get pods/log -n "$AGENT_NS" --as="$IMPERSONATE"
expect "cannot create pods in default" no auth can-i create pods -n default --as="$IMPERSONATE"
expect "cannot create pods in $NS" no auth can-i create pods -n "$NS" --as="$IMPERSONATE"
expect "cannot list secrets in $AGENT_NS" no auth can-i list secrets -n "$AGENT_NS" --as="$IMPERSONATE"
expect "no cluster-wide pod rights" no auth can-i create pods --all-namespaces --as="$IMPERSONATE"
# Least privilege that IS visible from outside the pod: the RoleBinding in the
# agent namespace binds exactly one subject, the worker's own ServiceAccount —
# no group, no user, no other SA. (The attempt pods' own
# automountServiceAccountToken: false lives in the pod spec the worker writes,
# which the RBAC rows above cannot see; scripts/kind/README-less by design,
# docs/run-modes.md points at the spike that does prove it.)
# Named, not a collection: `-o jsonpath` over a list of RoleBindings has no
# .subjects at all, so the collection form silently read back empty.
expect "only the worker SA is bound" "$RELEASE-worker ServiceAccount" \
    get rolebinding "$RELEASE-worker" -n "$AGENT_NS" -o "jsonpath={.subjects[0].name} {.subjects[0].kind}"

# ------------------------------- configuration 3, live: split + kubernetes -----
#
# Everything above is what the chart renders and what privilege it hands out. This
# phase installs it for real and runs the three spikes ADR-0082 Decision 10 says the
# launcher is measured by (internal/sandbox/k8s/kind_test.go, behind the `kind`
# build tag so normal CI never needs a cluster):
#
#   S1  does Landlock deny a write, and a TCP connect complete, INSIDE an attempt
#       pod built the way the launcher builds them;
#   S2  does ACP really ride the stdin/stdout of a `pods/exec` session, through the
#       production Transporter and the production client, with the agent side
#       answered by `communication acp-echo`;
#   S4  does the garbage collector take the per-attempt Secret when the attempt pod
#       goes, without anyone being asked to.
#
# The ADR's spike S5 (an agent turn that writes to the workspace and opens a PR) and
# S6 (an attempt that is killed by a node failure and the claim's single-writer
# behaviour under pod+worker restart) need a model endpoint and a node-restart lab,
# so they are NOT claimed here, and this script does not print a row for them.

log "installing mode=split with launcher=kubernetes (live)"

# The RBAC the script applied by hand is exactly what the release renders, and helm
# will not adopt objects it does not own — so the hand-applied copies go away first
# and the release re-creates them. The `can-i` rows below are then read against what
# helm installed, which is the object an operator actually ends up with.
drop_manual_rbac() {
    $KUBECTL -n "$AGENT_NS" delete rolebinding "$RELEASE-worker" --ignore-not-found
    $KUBECTL -n "$AGENT_NS" delete role "$RELEASE-worker" --ignore-not-found
    $KUBECTL -n "$NS" delete serviceaccount "$RELEASE-worker" --ignore-not-found
}
check "release takes over the worker RBAC" drop_manual_rbac

# The claim the attempt pods mount, in their own namespace. ADR-0082 Decision 4 is
# only true if something is there to mount: a claim cannot be mounted by a pod in
# another namespace, so worker.workspacePVC names this one, and this binds it to
# the SAME directory on the node as the release's own claim. The row below then
# proves the sharing by reading a file back that the worker pod wrote, through a pod
# built like an attempt pod — a plan's absolute path resolving to the same bytes on
# both sides, which is the whole point.
agent_claim() {
    local pv path size f
    pv="$($KUBECTL -n "$NS" get pvc "$RELEASE-data" -o jsonpath='{.spec.volumeName}')"
    [ -n "$pv" ] || { echo "the release's claim $NS/$RELEASE-data is not bound yet"; return 1; }
    path="$($KUBECTL get pv "$pv" -o jsonpath='{.spec.hostPath.path}')"
    [ -n "$path" ] || path="$($KUBECTL get pv "$pv" -o jsonpath='{.spec.local.path}')"
    [ -n "$path" ] || { echo "pv $pv names no host path; the mirror claim has no recipe here"; return 1; }
    size="$($KUBECTL -n "$NS" get pvc "$RELEASE-data" -o jsonpath='{.spec.resources.requests.storage}')"
    f="$STATE/agent-claim.yaml"
    cat >"$f" <<YAML
apiVersion: v1
kind: PersistentVolume
metadata:
  name: $AGENT_CLAIM
  labels:
    communication.dev/mirror-of: "$NS-$RELEASE-data"
spec:
  capacity:
    storage: $size
  accessModes: ["ReadWriteOnce"]
  persistentVolumeReclaimPolicy: Retain
  storageClassName: ""
  hostPath:
    path: $path
    type: DirectoryOrCreate
  claimRef:
    apiVersion: v1
    kind: PersistentVolumeClaim
    namespace: $AGENT_NS
    name: $AGENT_CLAIM
  nodeAffinity:
    required:
      nodeSelectorTerms:
      - matchExpressions:
        - key: kubernetes.io/hostname
          operator: In
          values: ["$NODE_NAME"]
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: $AGENT_CLAIM
  namespace: $AGENT_NS
spec:
  accessModes: ["ReadWriteOnce"]
  storageClassName: ""
  volumeName: $AGENT_CLAIM
  resources:
    requests:
      storage: $size
YAML
    $KUBECTL apply -f "$f" || return 1
    rm -f "$f"
    $KUBECTL -n "$AGENT_NS" wait --for=jsonpath='{.status.phase}'=Bound "pvc/$AGENT_CLAIM" --timeout=120s
}
check "agent claim bound in $AGENT_NS ($AGENT_CLAIM)" agent_claim

check "helm install split+kubernetes" install_chart "$CHART/ci/split-kubernetes.yaml" --set devLogin=true
check "serve rollout (kubernetes launcher)" $KUBECTL -n "$NS" rollout status deployment/"$RELEASE"-serve --timeout=300s
check "worker rollout (kubernetes launcher)" $KUBECTL -n "$NS" rollout status deployment/"$RELEASE"-worker --timeout=300s
check "split+kubernetes readiness endpoint" readiness_probe

# The worker's own startup line: it registered the pod launcher, and it names the
# namespace, image, node and claim it will place attempts on. A worker that could
# not build the launcher config refuses to start (ADR-0082 Decision 8), so this line
# is the difference between "installed" and "ready to launch".
launcher_line() {
    local pod
    pod="$($KUBECTL -n "$NS" get pod -l "app.kubernetes.io/instance=$RELEASE,app.kubernetes.io/component=worker" \
        -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
    [ -n "$pod" ] || { echo "no worker pod" >&2; return 1; }
    $KUBECTL -n "$NS" logs "$pod" -c worker --tail=300 | grep 'worker launcher: kubernetes'
}
check "worker registered the kubernetes launcher" launcher_line

# The same least-privilege boundary, re-read now that helm owns the objects.
expect "helm-owned RBAC: creates pods in $AGENT_NS" yes auth can-i create pods -n "$AGENT_NS" --as="$IMPERSONATE"
expect "helm-owned RBAC: no pods in $NS" no auth can-i create pods -n "$NS" --as="$IMPERSONATE"
expect "helm-owned RBAC: no secrets list in $AGENT_NS" no auth can-i list secrets -n "$AGENT_NS" --as="$IMPERSONATE"

# The spike tests drive the cluster from this host with the same launcher selection
# variables the worker's own pod was configured with, so what they place is what the
# worker would place.
export COMMUNICATION_AGENT_NAMESPACE="$AGENT_NS"
export COMMUNICATION_AGENT_POD_IMAGE="$WORKER_IMAGE"
export COMMUNICATION_AGENT_POD_NODE="$NODE_NAME"
export COMMUNICATION_AGENT_WORKSPACE_PVC="$AGENT_CLAIM"
export COMMUNICATION_AGENT_WORKSPACE_PATHS="/data/workspaces,/data/repos,/sandbox-policy"

# spike NAME test-name marker — runs one kind-tagged test and reads its own verdict
# line, so the table quotes what the cluster said rather than a bare exit code.
spike() {
    local name="$1" test="$2" marker="$3"
    local log="$STATE/spike-${test}.txt" rc=0 line
    log "running $test"
    ( cd "$SRC" && go test -tags kind -count=1 -v -run "^${test}\$" ./internal/sandbox/k8s/ ) \
        >"$log" 2>&1 || rc=$?
    line="$(grep -E "$marker" "$log" | tail -n 1 | sed -e 's/^[[:space:]]*//' -e 's/^[^ ]*: //' || true)"
    if [ "$rc" = "0" ] && [ -n "$line" ]; then
        record "$name" PASS "$(printf '%s' "$line" | cut -c1-200)"
    else
        record "$name" FAIL "$(tail -n 3 "$log" | tr '\n' ' ' | cut -c1-200)"
        sed 's/^/    /' "$log" >&2
    fi
}
spike "S1 attempt pod enforced the sandbox" TestKindAttemptPodVerifies 'S1 PASS'
# The verdict JSON itself, as the host kernel's answer rather than this script's.
S1_JSON="$(grep -o 'verdict: {.*' "$STATE/spike-TestKindAttemptPodVerifies.txt" 2>/dev/null | tail -n 1 || true)"
record "S1 pod-verify JSON" "$([ -n "$S1_JSON" ] && echo INFO || echo FAIL)" "${S1_JSON:0:240}"
spike "S2 ACP handshake over pods/exec" TestKindACPHandshake 'S2 PASS'
spike "S4 secret GC with the attempt pod" TestKindAttemptObjectsAreGarbageCollected 'S4 PASS'

# Decision 4, read as data: a file the worker wrote in its own workspace root must
# be readable by a pod in the agent namespace that mounts the claim the launcher was
# configured with. Anything else would mean the verified plan's paths and the pod's
# paths are two different filesystems wearing the same names.
shared_workspace() {
    local marker worker_pod out rc=0
    marker="kind-decision4-$$"
    worker_pod="$($KUBECTL -n "$NS" get pod -l "app.kubernetes.io/instance=$RELEASE,app.kubernetes.io/component=worker" \
        -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
    [ -n "$worker_pod" ] || { echo "no worker pod" >&2; return 1; }
    $KUBECTL -n "$NS" exec "$worker_pod" -c worker -- \
        sh -c "printf %s $marker > /data/workspaces/kind-decision4.txt" || return 1
    cat >"$STATE/shared-workspace.yaml" <<YAML
apiVersion: v1
kind: Pod
metadata:
  name: kind-decision4
  namespace: $AGENT_NS
spec:
  restartPolicy: Never
  automountServiceAccountToken: false
  enableServiceLinks: false
  nodeSelector:
    kubernetes.io/hostname: $NODE_NAME
  securityContext:
    runAsNonRoot: true
    runAsUser: 10001
    runAsGroup: 10001
    fsGroup: 10001
    seccompProfile:
      type: RuntimeDefault
  containers:
  - name: read
    image: $WORKER_IMAGE
    imagePullPolicy: IfNotPresent
    command: ["cat", "/data/workspaces/kind-decision4.txt"]
    securityContext:
      allowPrivilegeEscalation: false
      capabilities:
        drop: ["ALL"]
    volumeMounts:
    - name: data
      mountPath: /data/workspaces
      subPath: workspaces
  volumes:
  - name: data
    persistentVolumeClaim:
      claimName: $AGENT_CLAIM
YAML
    $KUBECTL delete pod kind-decision4 -n "$AGENT_NS" --ignore-not-found --wait=true >/dev/null 2>&1
    $KUBECTL apply -f "$STATE/shared-workspace.yaml" >/dev/null || return 1
    local phase=""
    for _ in $(seq 1 60); do
        phase="$($KUBECTL -n "$AGENT_NS" get pod kind-decision4 -o jsonpath='{.status.phase}' 2>/dev/null || true)"
        [ "$phase" = "Succeeded" ] || [ "$phase" = "Failed" ] && break
        sleep 2
    done
    [ "$phase" = "Succeeded" ] || { echo "reader pod ended in phase '${phase:-never}'" >&2; return 1; }
    out="$($KUBECTL -n "$AGENT_NS" logs kind-decision4 -c read 2>/dev/null || true)"
    [ "$out" = "$marker" ] || { echo "read back '${out:-<empty>}', wrote '$marker'" >&2; return 1; }
    printf 'the attempt namespace read the worker file back through %s' "$AGENT_CLAIM"
}
check "Decision 4: workspace is shared with attempts" shared_workspace

# What an attempt leaves behind is nothing: the launcher retired its pod, the
# collector retired its Secret, and the agent namespace is back to holding only the
# role binding that lets the next one happen.
no_attempt_objects() {
    local pods secrets
    pods="$($KUBECTL -n "$AGENT_NS" get pods -l communication.dev/attempt -o name 2>/dev/null | grep -c . || true)"
    secrets="$($KUBECTL -n "$AGENT_NS" get secrets -l communication.dev/attempt -o name 2>/dev/null | grep -c . || true)"
    [ "$pods" = "0" ] && [ "$secrets" = "0" ] || {
        echo "$pods attempt pods and $secrets attempt secrets still in $AGENT_NS"
        return 1
    }
    printf 'no attempt pods or secrets left in %s' "$AGENT_NS"
}
check "no attempt objects left behind" no_attempt_objects

print_table
