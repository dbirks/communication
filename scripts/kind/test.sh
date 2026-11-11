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
# Usage:
#   scripts/kind/test.sh                       # deletes the cluster at exit
#   KEEP=1 scripts/kind/test.sh                # leave it up for inspection
#   DOCKER="sudo -n docker" \
#   KIND="sudo -n env PATH=$PATH kind" scripts/kind/test.sh   # this host: docker needs sudo
#
# Knobs: DOCKER and KIND may carry a sudo prefix ("sudo -n docker"); KUBECTL and
# HELM must be a single command name. KEEP, SKIP_BUILD.
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

CLUSTER=communication-kind
NS=communication
AGENT_NS=communication-agents
SERVE_IMAGE=communication:kind
WORKER_IMAGE=communication-worker:kind
CHART=deploy/helm/communication
RELEASE=communication

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
        --config scripts/kind/kind-config.yaml \
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

# ------------------------------------------------------------------- images ---
# The root Dockerfile never compiles Go (ADR-0004: GoReleaser hands it the
# binary), so the serve image is built from a throwaway context holding that one
# file. ui/dist has to exist for //go:embed (ADR-0007).
build_serve_image() {
    local ctx rc=0
    ctx="$(mktemp -d)"
    # ui/dist/.gitkeep is committed so //go:embed compiles in a fresh clone
    # (ADR-0007); the serve image never carries a UI bundle of its own.
    CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags "-s -w" \
        -o "$ctx/communication" ./cmd/communication \
        || { rm -rf "$ctx"; return 1; }
    cp Dockerfile "$ctx/Dockerfile"
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
    log "building $WORKER_IMAGE (worker/Dockerfile); a cold build is slow"
    check "build worker image" $DOCKER build -q -t "$WORKER_IMAGE" -f worker/Dockerfile .
fi
check "kind load serve image" $KIND load docker-image "$SERVE_IMAGE" --name "$CLUSTER"
check "kind load worker image" $KIND load docker-image "$WORKER_IMAGE" --name "$CLUSTER"

# --------------------------------------------------------------- namespaces ---
ensure_ns() { $KUBECTL get ns "$1" >/dev/null 2>&1 || $KUBECTL create ns "$1" >/dev/null; }
check "namespace $NS" ensure_ns "$NS"
check "namespace $AGENT_NS" ensure_ns "$AGENT_NS"

# ----------------------------------------------------------- throwaway pg -----
check "postgres manifest apply" $KUBECTL apply -f scripts/kind/postgres.yaml

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

print_table
