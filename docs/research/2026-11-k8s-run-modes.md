# The two run modes: one container with nono, and a Kubernetes-native worker that spawns agent pods

**Status:** research + code map, **no decision**. Round 1 (`docs/design/k8s-execution-research.md`,
commit `f918881`) stands; this doc updates it (new releases), answers the four run-mode questions,
and names the exact seams a `PodLauncher` would plug into. Nothing here is an accepted design:
per `communication-spec/12-test-strategy.md`, no sandbox/protocol row may be marked PASS without a
real test, and every Kubernetes claim below is a *candidate* until the spikes at the end run.

All external facts were read **2026-11-11** unless a different date is given.

## 1. Single-container mode today

**Answer**

* **Yes, one process can run both halves, and it already exists:** `communication dev`
    (`cmd/communication/main.go:61` → `runDev`, `cmd/communication/dev.go:41`) runs the control plane and one
    worker in one process, one signal context, sharing the environment. The embedded UI is served by
    `serve`/`dev` same-origin because the Vite build is `//go:embed all:dist` (`ui/embed.go`). The mode is
    explicitly "dev convenience only, NOT an HA runtime" (`cmd/communication/dev.go:16-36`) and matches ADR-0001
    option B and `communication-spec/02-system-architecture.md:9`.
* **Minimum environment.** `dev` = the union of `serve` + `worker`:
  `COMMUNICATION_DATABASE_URL` (required by both), `COMMUNICATION_PUBLIC_URL`,
  `COMMUNICATION_OIDC_ISSUER` + `COMMUNICATION_OIDC_CLIENT_ID` (the `serve` usage block,
  `cmd/communication/serve.go:41,43,167-169`), plus the worker's storage and sandbox set:
  `COMMUNICATION_WORKSPACE_ROOT`, `COMMUNICATION_REPOS_ROOT`, `COMMUNICATION_SECRET_KEYRING`,
  `COMMUNICATION_SANDBOX_ENFORCEMENT` (default `required`), `COMMUNICATION_SANDBOX_HOME`,
  `COMMUNICATION_SANDBOX_POLICY_DIR`, `COMMUNICATION_SANDBOX_SELFTEST_DIR`,
  `COMMUNICATION_AGENT_GIT_NAME/EMAIL` (required in `required` mode). Three of those sandbox dirs
  **must be siblings, not children,** of the storage roots and of nono's HOME (probe C-H1's
  permanent refusal, `cmd/communication/worker.go:1185-1194`, `compose.yml:341-352`).
  `dev` also flips `COMMUNICATION_ALLOW_FILE_GIT_URLS=true` by default (`cmd/communication/dev.go:49-55`).
* **One container with nono is not what we ship, and today's images decide the answer.** The root `Dockerfile` is
    the *control-plane* image: `debian:trixie-slim` + `ca-certificates` + `git` + the binary, uid 10001
    (`Dockerfile:10,16-21,29`). **No nono, no Node, no adapters** — it cannot run agent turns. The execution
    image is `worker/Dockerfile`: node 22 trixie, the pinned ACP adapters, APM 0.34.0, gh 2.103.0 and **nono
    0.80.0 pinned by digest** (`worker/Dockerfile:83-84`, installed to `/usr/local/bin/nono` at `:209`). A
    required-mode worker that cannot find nono on PATH refuses to start (`cmd/communication/worker.go:337`). So
    "single container with nono" = **the worker image, run as `communication dev`** (its ENTRYPOINT is the
    binary, CMD is `worker`; override args with `dev`) + Postgres reachable. The live home deployment states the
    same split in its own header (`/home/david/dev/home-k8s/apps/communication/communication.yaml`: "serve's
    plain runtime image cannot run agent turns"). This all-in-one combination has **never been run in-tree** —
    compose runs `serve` and `worker` as separate containers from separate images (`compose.yml:169,237,314`).
* **What nono needs inside a container (measured, ours):** Landlock comes from the **host kernel**, not the image.
    Our probe matrix ran nono 0.80.0 inside `debian:trixie-slim` under **Docker 29.9.0's builtin seccomp
    profile, uid 0, no cap_add, no `seccomp=unconfined`**, and got the same PASS set as the Arch host (Landlock
    ABI **V6**, filesystem + TCP enforced) — `docs/compatibility/SANDBOX.md:15-16,48,62-67`. Fail-closed is
    fail-closed there too: nono aborts rather than running unrestricted.
* **Capabilities / seccomp / NNP / userns:**
  * Landlock is an *unprivileged* LSM — it needs no capability
    (`https://docs.kernel.org/userspace-api/landlock.html`).
  * The container's seccomp profile must allow `landlock_create_ruleset`, `landlock_add_rule`,
    `landlock_restrict_self`, `seccomp` (the notify fd), `clone` with `CLONE_FILES`,
    `close_range`/`unshare`, `ptrace`/`pidfd_getfd` (older proxy handoff), and child procfs reads.
    The **moby/containerd default profile allows every one of those** (checked in
    `https://github.com/moby/profiles/blob/main/seccomp/default.json`: all listed `SCMP_ACT_ALLOW`;
    `clone3` is `SCMP_ACT_ERRNO`). Landlock syscalls entered the default policy via
    `https://github.com/moby/moby/pull/43199` and containerd's vendored copy via
    `https://github.com/containerd/containerd/pull/6494`. So Kubernetes `seccompProfile: RuntimeDefault` is *compatible* with nono on a Landlock host — and it is what the home worker
    pod already runs.
  * `no_new_privs`: nono sets it on the child itself (`https://github.com/always-further/nono`);
    `allowPrivilegeEscalation: false` / a `NoNewPrivs` container does not conflict with it. No user
    namespace is needed today — the adapter pins `--sandbox-policy landlock` and never emits
    `external` (finding FC2, `internal/sandbox/nono/launcher.go:38-42`). nono 0.81 adds *opt-in*
    `--isolate net,ipc,uts` namespace isolation
    (`https://nono.sh/docs/cli/features/namespace-isolation`), which we do not use; if we ever do,
    userns availability becomes a node question.
  * **The real container blockers are two, and both are measured.** (a)
    `kernel.yama.ptrace_scope` must be <= 1 for the agent-turn profile's pathname AF_UNIX mediation
    (`af_unix_mediation = "pathname"`, `worker/sandbox/profiles/communication-command.json`,
    `internal/sandbox/nono/profile.go:129,802`): with `ptrace_scope=2` on the live Talos nodes every
    TCP connect fails `EPERM`, the worker's startup gate detects it and withholds `agent.acp`
    (`docs/compatibility/SANDBOX.md:549-560`, `internal/sandbox/nono/tcpselftest.go`). Yama is
    host-wide, not namespaced — a pod cannot fix it. (b) nono's container doc says domain filtering
    (`--allow-domain`, our ADR-0035 path, `internal/sandbox/nono/profile.go:115`) needs
    `--cap-add=SYS_PTRACE` inside Docker
    (`https://github.com/nolabs-ai/nono/blob/main/docs/cli/internals/containers.mdx`), while its
    troubleshooting page says the newer `CLONE_FILES` bootstrap needs **neither** `pidfd_getfd` nor
    `CAP_SYS_PTRACE` (`https://nono.sh/docs/cli/usage/troubleshooting.md`). Our lab runs the domain
    proxy with no added capabilities on an ABI-V6 kernel and it holds. Treat "no SYS_PTRACE needed
    on V4+" as **spike S1**, not as fact.

* **Version currency:** we pin nono **0.80.0**; upstream latest is **v0.81.0** (published 2026-10-29), which fixes
    three security advisories (GHSA-wh99-5qx8-cgh4, GHSA-p39g-3xw6-83jx, GHSA-p398-cgqf-c48x), adds `--isolate`
    namespace isolation, denies io_uring during AF_UNIX mediation, and "detects Landlock ABI up to V9, keeps
    enforcement at V6" (`https://github.com/nolabs-ai/nono/releases/tag/v0.81.0`). Upgrading a pinned sandbox
    requires re-running the `docs/compatibility/SANDBOX.md` probe matrix, not just bumping the digest.

**Evidence:** `cmd/communication/main.go:55-61`, `cmd/communication/dev.go:16-55`,
`cmd/communication/worker.go:337,1185-1257`, `Dockerfile:10-29`, `worker/Dockerfile:83-84,123,209`,
`compose.yml:310-372`, `ui/embed.go`, `communication-spec/02-system-architecture.md:8-9,75-81`,
`communication-spec/05-workspaces-security-secrets.md:27-39`,
`communication-spec/adr/ADR-0001-control-and-worker-modes.md`,
`docs/compatibility/SANDBOX.md:15-67,549-560`, and the worker Deployment in
`/home/david/dev/home-k8s/apps/communication/communication.yaml` (`runAsNonRoot 10001`,
`seccompProfile: RuntimeDefault`, `drop ALL`, `strategy: Recreate`, RWO `local-path` PVCs).

## 2. Kubernetes-native mode — worker asks the API server for one pod per attempt

### 2.1 agent-sandbox vs. worker-created Pods/Jobs

**Answer.** Keep the round-1 leaning: **worker-created Pods behind our own launcher interface**,
with agent-sandbox as a possible later backend, not the foundation. Reasons that survived a
re-check of the v1.0.10 release notes:

* agent-sandbox **is** real and current: latest release **v1.0.10** (published 2026-11-06), core `Sandbox` is
    `agents.x-k8s.io/v1beta1`, `SandboxTemplate`/`SandboxClaim`/`SandboxWarmPool` are
    `extensions.agents.x-k8s.io/v1beta1`; minimum Kubernetes 1.25+, recommended 1.29+; weekly 1.0.x releases
    still change behaviour (this one changed the router's NetworkPolicy semantics and removed
    `Options.ProbeAddr`). There is now an **official `examples/nono-sandbox`** in the repo
    (`https://github.com/kubernetes-sigs/agent-sandbox/tree/main/examples/nono-sandbox`, blog:
    `https://nolabs.ai/blog/nono-kubernetes-agent-sandbox`) — i.e. "nono inside an agent-sandbox pod" is a
    supported pattern upstream, with a scripted kind demo.
* But its **default egress posture is the opposite of ours**: v1.0.10's router policy now allows sandbox egress on
    TCP 443/6443 and 53 to `0.0.0.0/0` unless you set `networkPolicy.apiServerCIDRs` (release notes
    #1550/#2144). Its lifecycle unit is a *long-lived stateful singleton pod* (warm pools; per-claim `env` or
    `volumeClaimTemplates` force a cold start; suspend keeps PVCs). Our unit of work is a fenced, per-attempt,
    short-lived process whose environment and policy are per-unit by construction
    (`internal/worker/profile_slot.go`, one private profile dir per unit).
* A plain `Pod` (or `Job` with `ttlSecondsAfterFinished`) created by the worker gives us exactly the three things
    we need and nothing else: per-attempt labels for audit, `ownerReferences` for GC, `nodeSelector`/`nodeName`
    control so an attempt stays on the node holding its workspace.
* **gVisor stays unavailable for nono**: gVisor's Sentry still has no Landlock syscalls; upstream issue
    `https://github.com/google/gvisor/issues/13439` (opened 2026-06-13, updated 2026-10-04) is about *adding*
    guest Landlock, starting at ABI v1
    (`https://github.com/google/gvisor/commit/31a791793542a89d9b79e1f59e5bfe7728b3c4d7`). Do not plan "runsc +
    nono" yet; the sandbox-conformance write-up (`https://carlostapiacl.github.io/sandbox-conformance/docs/sandboxes/nono/`, read 2026-11-11) describes the same stack (Landlock + seccomp +
    `no_new_privs` + supervising parent, nono 0.80/0.81).

### 2.2 How the worker talks to the agent in the pod

**Answer — three shapes, ranked for the first spike.**

| Shape | Mechanics | RBAC the worker needs | For | Against |
|---|---|---|---|---|
| **A. `pods/exec` stdio (spike first)** | `client-go` `remotecommand.NewSPDYExecutor` / `NewWebSocketExecutor` with `Streams{Stdin, Stdout, Stderr, TTY:false}`; the exec'd argv **is** today's nono argv, so ACP rides the same two pipes it rides now | `pods[get,list,watch]`, `pods/exec[create]`, `pods/log[get]` | zero new code inside the pod; 1:1 with `acp.Runtime`'s stdio model; the ACP handshake, permission bridge and stall watcher are unchanged | no resume: an API-server/worker blip kills the session exactly like a killed child; streams traverse the API server; the worker SA holds *exec* privilege over its namespace; stdin close semantics need care across turns |
| **B. In-pod relay on a port** | a tiny supervisor in the pod listens on TCP/TLS, spawns the agent under nono, proxies stdio; worker dials `podIP:port` | `pods[get,list,watch]` only (+ endpoints read if you resolve by Service) | reconnect/heartbeat under our control; no `pods/exec`; can carry stderr/audit out-of-band | new listener **inside** the boundary we are trying to shrink; needs mTLS + authz we must write; needs a NetworkPolicy ingress rule from the worker; new image surface |
| **C. Pod dials back to the worker** | worker listens; the pod's bootstrap connects out and is authenticated with a projected SA token the worker validates via `TokenReview` | `pods[create,get,list,watch,delete]`, `secrets[create,delete]`, `serviceaccounts[get]`, `tokenreviews[create]` on `authentication.k8s.io` — **no exec at all** | best long-term privilege story; egress-only pod policy; survives worker restart if the pod re-dials; matches today's design, where the worker needs no inbound port (`compose.yml:305`) | the worker becomes a server (new surface, new auth); needs the pod→worker address injected; two-way protocol we own |

RBAC verb detail is from `https://kubernetes.io/docs/reference/access-authn-authz/rbac/`
(subresources are addressed as `pods/exec`, `pods/log`; exec requires `create` on the subresource and
`get` on the pod — the same shape the SO answers at
`https://stackoverflow.com/questions/48118125/` recommend) and the client-go package doc
`https://pkg.go.dev/k8s.io/client-go/tools/remotecommand` (`NewSPDYExecutor`,
`NewWebSocketExecutor`, `StreamWithContext`).

### 2.3 Workspace handoff and artifacts

**Answer.** The hard part is not the agent, it is that the worker *owns* the git topology today:
mirrors and per-run worktrees live on the worker's own roots (ADR-0017;
`internal/worker/workspace.go`, `internal/workspace/git`), the launch plan's `Cwd`/`AgentHome` are
paths in that tree (`internal/worker/unit.go:259-262`), unit-boundary capture and checkpoint restore
read those paths from the worker's filesystem (`internal/worker/unit_capture.go`,
`internal/worker/checkpointrestore.go`), and `ArtifactPublish` reads a workspace file through the
worker FS before `Bytes.Put` (`internal/worker/artifactpublish.go:211,256,416`). Options:

1. **emptyDir + clone inside the pod (spike-friendly).** The attempt pod gets an `emptyDir` at the same absolute
    path as the worker's workspace root; an initContainer clones (from the mirror or the origin) at the pinned
    revision. Cheap and attempt-local, but the git credential (ADR-0061, `UnitService.MirrorCredentials`,
    `internal/worker/unit.go:66-72`) must reach the pod, and the commit returns the way a real push does today —
    the agent's own `git push` with a delivered token (ADR-0045, `internal/worker/gitpush.go:42`) — or as a
    patch artifact the worker applies.
2. **Shared PVC at the same path (single-node only).** Preserves every path assumption and today's volume-identity
    checks, but needs `ReadWriteMany` for multi-node (RWO works only co-located — the home cluster is RWO
    `local-path` on one node), plus agreed uid/fsGroup (10001 is already the convention, `Dockerfile:23-29`).
3. **PVC per attempt.** Best isolation and lifecycle (create at claim, `ownerReferences` → the attempt pod, GC on
    delete); worst latency. Do this when attempts spread across nodes.

Artifacts: with option 2/3 the worker keeps publishing unchanged; with option 1 the pod must write
the artifact bytes itself, which today requires the **S3 backend**
(`COMMUNICATION_ARTIFACT_BACKEND=s3`, `compose.yml:380-400` / `internal/artifacts`) — the `local`
backend is a worker-local directory and is invisible to a remote pod.

### 2.4 Least privilege: RBAC, securityContext, NetworkPolicy

**Answer.**

Worker ServiceAccount — namespaced `Role`, no cluster-scope, no `pods/exec` once shape C lands:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata: {name: communication-worker, namespace: communication-agents}
rules:
  - apiGroups: [""]                       # one pod per attempt
    resources: ["pods"]
    verbs: ["create", "get", "list", "watch", "delete"]
  - apiGroups: [""]                       # shape A only; drop it for shape C
    resources: ["pods/exec"]
    verbs: ["create"]
  - apiGroups: [""]                       # stderr tail on launch failure
    resources: ["pods/log"]
    verbs: ["get", "list"]
  - apiGroups: [""]                       # per-attempt credential + policy payloads
    resources: ["secrets"]
    verbs: ["create", "get", "delete"]
  - apiGroups: [""]                       # scheduling failures, read-only
    resources: ["events"]
    verbs: ["list"]
  - apiGroups: ["authentication.k8s.io"]   # shape C only
    resources: ["tokenreviews"]
    verbs: ["create"]
```

`Role` not `ClusterRole`; scope the agent pods into their own namespace so "can create pods" cannot
touch the platform's; bind with a `RoleBinding` in that namespace; `automountServiceAccountToken:
true` **only** on the worker Deployment. Never give the worker `pods/attach`, `pods/portforward`,
`pods/proxy`, `secrets[list]`, or anything on `nodes`/`namespaces`.

Agent pod (one per attempt; `spec.restartPolicy: Never`, `automountServiceAccountToken: false` —
round 1's "no service-account token in the pod", which also kills the token-replay path):

```yaml
spec:
  enableServiceLinks: false
  automountServiceAccountToken: false
  securityContext:
    runAsNonRoot: true
    runAsUser: 10001
    runAsGroup: 10001
    fsGroup: 10001
    seccompProfile: {type: RuntimeDefault}   # allows the landlock + seccomp syscalls (§1)
  containers:
    - securityContext:
        allowPrivilegeEscalation: false
        capabilities: {drop: ["ALL"]}
        readOnlyRootFilesystem: true         # + emptyDir at workspace, agent HOME, /tmp
```

`readOnlyRootFilesystem: true` is compatible with our design only if every writable path is a
mount: the worktree, the two HOMEs (`LaunchPlan.Cwd`, `LaunchPlan.AgentHome`), the per-unit policy
file dir, and `CLAUDE_CONFIG_DIR`/`CODEX_HOME` (Claude writes into its config dir mid-turn — the
home worker mount is read-write for exactly that reason). `kind: Job` with
`ttlSecondsAfterFinished` is the alternative to a bare pod plus our own reaper.

NetworkPolicy: stock **kind enforces NetworkPolicy** since v0.24.0 via
`sigs.k8s.io/kube-network-policies` ("first-packet inspection", verdict cached in user space;
`https://github.com/kubernetes-sigs/kind/releases/tag/v0.24.0` published 2024-08-15,
`https://kindnet.sigs.k8s.io/docs/user/network-policies/`) — but kindnet is a **pod/IP/CIDR** engine,
so no FQDN rules. FQDN egress needs Cilium `toFQDNs`
(`https://docs.cilium.io/en/stable/security/dns/`, kind install
`https://docs.cilium.io/en/stable/installation/kind/`), the experimental `ClusterNetworkPolicy`
`domainNames` peer (network-policy-api **v0.3.0**, published 2026-11-06,
`https://github.com/kubernetes-sigs/network-policy-api/releases/tag/v0.3.0`), or Calico
Enterprise/Cloud. So: **deny-all egress + CIDR allows (DNS, the API's host, the model endpoints, the
artifact store) at the NetworkPolicy layer, and keep nono's `network.allow_domain` CONNECT proxy
inside the pod as the FQDN layer** — belt (any CNI) plus suspenders (nono), which is round 1's
"proxy pattern works on any enforcing CNI".

### 2.5 Credentials into the pod without leaking them into pod specs

**Answer.**

* Never put a token in a pod `env` value or in `args`: the pod spec is readable by anyone with `get` on pods, is
    copied into controller logs, and — in our own design — argv is journalled verbatim as audit (ADR-0040;
    `internal/worker/agentturn.go:1396-1424` deliberately rides secrets in the *process environment*, never the
    argv `env` hop). A `secretKeyRef` is only a *name*, so a `Secret` value never lands in the pod spec; it
    lands in `secrets`, where RBAC and (optionally) provider-side encryption at rest govern it.
* **Per-attempt Secrets, owned by the pod:** the worker creates `attempt-<id>` at claim time, and sets
    `ownerReferences` to the attempt Pod (or to a Job) so Kubernetes GC removes it when the attempt is collected
    — no orphaned credential blobs. Names carry the attempt id, so our audit trail can name the object without
    naming the value. `defaultMode: 0400`, `items:` listing exactly the file names.
* **The read-only-symlink problem is already measured:** Secret/projected volumes expose `..data` symlinks at 0644
    and are read-only; `LoadKeyring` refuses them outright, and Claude/Codex *rewrite* their credential file
    mid-turn. The live deployment solves it with an initContainer that copies into a `0700` emptyDir as `0600`
    regular files (keyring and `claude-config` initContainers in
    `/home/david/dev/home-k8s/apps/communication/communication.yaml`). Reuse that shape in the attempt pod, or
    hand the agent a `CLAUDE_CONFIG_DIR` it cannot write and accept the ADR-0019 D4 failure mode.
* **`env`-shaped secrets** (the collective/model-chat bearer, `COMMUNICATION_PI_API_KEY_FILE`) should arrive as
    files with an `_FILE` name, the same convention the worker already uses (`cmd/communication/worker.go:154`),
    and reach only the sandboxed child's environment.
* Projected service-account tokens have **no** role here: the agent pod gets `automountServiceAccountToken:
    false`. Only shape C projects one, for dial-back authentication (`expirationSeconds: 600`, audience = the
    worker's listener). Cleanup is not optional either: `ownerReferences` covers the object, and the pod-side
    copy of a credential must be asserted gone before the workspace is released — the pattern already exists as
    `AgentTurn.cleanupSecrets` (`internal/worker/agentturn.go:1167`).

**Evidence for §2:** agent-sandbox v1.0.10 release notes,
`https://agent-sandbox.sigs.k8s.io/docs/api/` and `.../docs/getting_started/overview/`; nono
container requirements `https://nono.sh/docs/cli/internals/containers.md`,
`.../troubleshooting.md#running-inside-docker-podman`, `.../features/namespace-isolation.md`; gVisor
`https://github.com/google/gvisor/issues/13439`; RBAC
`https://kubernetes.io/docs/reference/access-authn-authz/rbac/` and
`https://pkg.go.dev/k8s.io/client-go/tools/remotecommand`; NetworkPolicy limits
`https://kindnet.sigs.k8s.io/docs/user/network-policies/` and
`https://docs.cilium.io/en/stable/security/dns/`; ownership GC (ownerReferences cascade)
`https://kubernetes.io/docs/concepts/architecture/garbage-collection/`.

## 3. kind as the test rig

**Answer.**

* **Version.** kind latest **v0.33.0** (published 2026-08-26); default node image
    `kindest/node:v1.37.0@sha256:a1ed56cfb0e7b93589bdf97c8cd566405a265939e3620fc4f5de89adff580ae5`, and the
    release note insists you pin the `@sha256` digest; pre-built for k8s 1.37.0/1.36.4/1.35.8/1.34.11
    (`https://github.com/kubernetes-sigs/kind/releases/tag/v0.33.0`). NetworkPolicy enforcement is built in
    (§2.4).
* **Can nono's Landlock self-test pass in kind?** Expected yes on this host, **unproven** — it is spike **K1**.
    Kind nodes are ordinary containers on the **host kernel**, so the Landlock ABI the pods see is the host's:
    Arch `7.2.9-arch1-1` reports ABI **V6** (`docs/compatibility/SANDBOX.md:15-16`), and our own matrix already
    shows nono enforcing filesystem **and** TCP inside a Docker container under the default seccomp profile
    (`:48,62-67`) — the same condition a kind pod sees, with containerd's default profile allowing the same
    syscalls (§1). Two honest caveats: (a) a kind node runs containerd + systemd inside a privileged container,
    so a node-level failure mode could still differ — the probe must run *in a pod*, not on a node shell; (b)
    kind cannot reproduce the Talos `ptrace_scope=2` failure at all, because Yama is host-wide. Run the gate
    with the binary we already ship, in the pod: `communication doctor` reports `sandbox:nono-tcp-reachability`
    and the Landlock verdict (`cmd/communication/doctor.go:224,295`).
* **Loading a locally built image.** `kind load docker-image ghcr.io/dbirks/communication-worker:dev --name
    communication` (quick-start, "loading an image into your cluster",
    `https://kind.sigs.k8s.io/docs/user/quick-start/`); for CI, `helm/kind-action` also accepts a `registry:`
    input (a local registry) which avoids multi-GB loads. `imagePullPolicy: IfNotPresent` and a tag that never
    floats, or the load is silently ignored.
* **Minimal CI lane.** `helm/kind-action@v1.15.2` (published 2026-11-04; v1.15.x carries the checksum-validation
    fix and the bumped kind/kubectl defaults) with `version: v0.33.0` and `node_version: v1.37.0`, then `kind
    load docker-image`, `helm upgrade --install`, wait for `communication` readiness `/api/v1/system/readiness`,
    then a pod running plain `communication doctor` — it already runs the `sandbox:nono` and `sandbox:nono-tcp-reachability` checks (`cmd/communication/doctor.go:64-66`) — or `doctor --acp claude` for the opt-in end-to-end launcher check (`:90-93`), then one real agent turn. **Kernel reality check:** GitHub-hosted runners are
    Ubuntu (6.8 → Landlock ABI **v4**; v5 needs 6.12+). Filesystem + TCP mediation should hold there, the V5/V6
    extras (signal/ioctl/abstract-socket scoping) will not. Record it as its own row in
    `docs/compatibility/SANDBOX.md`; never copy the lab's V6 row across.

## 4. The smallest reasonable Helm chart

**Answer.** One chart, two Deployments, no bundled database:

```
deploy/helm/communication/
  Chart.yaml            # apiVersion v2, type application, appVersion = image tag
  values.yaml           # image{repository,tag,digest}, database.url (external only),
                        # oidc{issuer,browserIssuer,clientId,clientSecretRef},
                        # secrets{keyringRef,workerRef}, artifacts{backend,local.root,s3},
                        # serve{enabled,replicas,publicUrl,host}, worker{enabled,enforcement,
                        # launcher: local|kubernetes, agentNamespace}, rbac.create, resources
  templates/
    _helpers.tpl
    deployment-serve.yaml       # + initContainer `communication migrate up`
    deployment-worker.yaml      # strategy Recreate (workspace roots are single-writer)
    service-serve.yaml          # (+ optional ingress.yaml)
    serviceaccount-worker.yaml  # + role-worker.yaml + rolebinding-worker.yaml
                                #   rendered only when worker.launcher == kubernetes
    secretrefs.yaml             # renders *names* and secretKeyRef entries, never values
    NOTES.txt
  ci/  (values files used by helm lint / helm template in CI)
```

Rules that keep it honest: Postgres arrives as `database.url` only (ADR-0013: `serve` never
migrates itself, it refuses readiness until the schema is current, so `migrate` is an
initContainer — the live home manifest does exactly this); no template ever renders a secret
*value*; `worker.launcher: kubernetes` is the only thing that makes the RBAC objects appear, so the
single-container mode never ships pod-creation privileges; `nodeSelector`/tolerations exposed but
not defaulted; `podSecurityContext`/`securityContext` rendered verbatim from values so the pinned
`RuntimeDefault` + `drop ALL` + 10001 shape is visible in review.

**Style references (deliberately minimal, both inspected today).**
`kubernetes-sigs/descheduler` `charts/descheduler/templates` — NOTES, `_helpers.tpl`, clusterrole,
clusterrolebinding, configmap, cronjob, deployment, pdb, service, serviceaccount, servicemonitor:
one workload, one SA, everything else a values toggle (`https://github.com/kubernetes-sigs/descheduler/tree/main/charts/descheduler`).
`prometheus-community/helm-charts` `charts/prometheus-pushgateway/templates` — deployment/statefulset
switched by a value, service, serviceaccount, networkpolicy, pvc, and an `extra-manifests.yaml`
escape hatch for objects the chart refuses to model
(`https://github.com/prometheus-community/helm-charts/tree/main/charts/prometheus-pushgateway`).
Neither chart templates secret payloads — that is the convention worth copying.

## Code map: where a `PodLauncher` plugs in

Today's local launch path, end to end:

| Step | file:line |
|---|---|
| mode dispatch (`serve`/`worker`/`dev`) | `cmd/communication/main.go:55,58,61` |
| nono backend constructed + startup gates (`Probe`, `SelfTest`, `TCPConnectSelfTest`; `agent.acp` withheld on failure) | `cmd/communication/worker.go:1195`, gates `:1210-1257`, injected `:1308` (`Sandbox: nano`) |
| ACP session factory + runtime wired | `cmd/communication/worker.go:532-533`, `:1103-1104` |
| agent-turn plan: build `nono.LaunchSpec` → `Verify` → `BuildLaunchArgv` → `acp.LaunchPlan{Path: nono, Args: argv, Env: …}` | `internal/worker/agentturn.go:1324` (`verifyThenPlan`), `:1364`, `:1370`, `:1387`, `:1425` |
| hand-off to the runtime (plan attached to ctx) | `internal/worker/agentturn.go:712`, `internal/worker/turnloop_units.go:366` |
| plan wins over registry argv; `RequirePlan` makes "no plan" fatal | `internal/agent/acp/factory.go:73-101` |
| **the exec itself** — `exec.CommandContext`, stdio pipes, `acp.NewClientSideConnection(h, stdin, stdout)` | `internal/agent/acp/runtime.go:41`, `:49`, `:76-83`, `:104`, `:105` (`h.attachProcess(cmd, stdout)`) |
| `process.exec` sibling path (`BlockNet: true`) | `internal/worker/procexec.go:687`, `:699`, `:718`, `:466` |
| nono verify→run and the local `exec.Cmd` | `internal/sandbox/nono/launchplan.go:199`, `:216`, `internal/sandbox/nono/process.go:41`, `internal/sandbox/nono/verify.go:100` |
| interfaces a pod launcher must satisfy | `domain.SandboxLauncher` `internal/domain/sandbox.go:90`; `domain.AgentRuntime` `internal/domain/agent.go:85`; `worker.AgentSandbox` (`Probe`+`Verify`) `internal/worker/unit.go:126` |

**Suggested seam (one new interface, two implementations).**

```go
// internal/agent/acp/transport.go  (proposed)
// Transport carries ACP stdio for one session: today a local child under nono,
// in Kubernetes mode a pod created for this attempt.
type Transport interface {
    Stdin() io.WriteCloser
    Stdout() io.Reader
    Stderr() io.Reader
    Wait() error
    Close() error
}
// Transporter starts one launch. Required mode must not be able to return a
// Transport whose sandbox was never verified (ADR-0019 D6: no fallback).
type Transporter interface {
    Start(ctx context.Context, spec domain.AgentLaunchSpec, prov SandboxProof) (Transport, error)
}
```

* `ProcTransport` = the body of `internal/agent/acp/runtime.go:49-105` moved behind it; `handle.attachProcess`
    (`runtime.go:105`) generalizes from `*exec.Cmd` to `Wait() error`, and the process-group/SIGKILL teardown
    ladder in `internal/agent/acp/handle.go` gains a pod-shaped implementation (delete the pod / `pods/exec`
    signal).
* `PodTransport` = client-go `pods/exec` (shape A) or the dial-back listener (shape C).
* Wire it where the runtime is built today: `cmd/communication/worker.go:532-533` and `:1103-1104`
    (`&acp.Factory{Runtime: &acp.Runtime{…}}`) — a new env switch beside the existing sandbox selection at
    `:1180-1310`, e.g. `COMMUNICATION_WORKER_LAUNCHER=local|kubernetes`, and `Factory.LookPath`
    (`internal/agent/acp/factory.go:21-22`, used at `:50-54`) must stop resolving executables on the *worker's*
    PATH in pod mode (the image is the same, but the lookup belongs to the pod).
* **A second, separate seam is required for honesty:** `PodLauncher` in a new `internal/sandbox/k8s` package
    implementing `worker.AgentSandbox` (`Probe`, `Verify` against the N-a…N-d chain run inside the attempt pod,
    e.g. `nono run --dry-run` in an initContainer whose `terminationMessage` carries the `VerificationResult`).
    Without it, required mode would credit a pod it never proved — the exact thing ADR-0009 D4 / `LaunchPlan`'s
    "no path runs the adapter unverified" rule forbids (`internal/sandbox/nono/launchplan.go:189-205`).
* Callers that assume a shared filesystem and must change with it:
  `internal/worker/unit.go:680` and `internal/worker/apmsandbox.go:159` (both build `nono.LaunchSpec`
  from local paths), `internal/worker/profile_slot.go` + `openUnitProfile` (the per-unit policy file
  is a *local file* — in pod mode it ships as a per-attempt Secret payload, and §2.4's read-only
  symlink caveat applies), `internal/worker/unit_capture.go` / `checkpointrestore.go` (unit-boundary
  capture), `internal/worker/artifactpublish.go:416` (reads workspace bytes), `internal/worker/egressaudit.go`
  + `internal/sandbox/nono/egress.go:369` (`nono audit show` reads nono's state from the launcher
  HOME — the audit must come back from the pod), and `internal/worker/procexec.go:458-463` (the
  policy file is deleted *after* the child is reaped; in pod mode that becomes a delete-after-termination API call).

## Spikes (nothing below is a claim until it runs)

* **S1** — nono 0.80/0.81 in a kind pod: `communication doctor` + the worker's two startup gates, no cap_add,
    `RuntimeDefault`, drop-ALL, uid 10001. Confirms/refutes "SYS_PTRACE not needed on ABI ≥ V4". (Not run for
    this document: the research host session has no Docker daemon access — `/var/run/docker.sock` is permission-denied — and `kind` is not installed, so no cluster was created. The host does read
    `kernel.yama.ptrace_scope = 1`, `uname -r` = `7.2.9-arch1-1`, matching the `SANDBOX.md` provenance row.)
* **S2** — ACP over `pods/exec` with the pinned adapters (claude-agent-acp 0.90.0, codex-acp 2.2.2, pi-acp
    0.0.34): full handshake + one two-turn conversation, including stdin held open across turns.
* **S3** — egress: default-deny NetworkPolicy + one allow rule, with nono's `allow_domain` proxy inside the pod;
    prove a denied host is denied at *both* layers and journalled (`SandboxVerified` `network_enforced`,
    ADR-0035).
* **S4** — per-attempt Secret lifecycle: create at claim, `ownerReferences` GC, assert absent after pod deletion;
    assert the agent's copy is gone (the `AssertNothingBut` shape) inside the pod.
* **S5** — workspace: emptyDir + clone at the pinned revision, commit returned as a bundle artifact, and unit-boundary capture proven from the returned bytes.
* **S6** — Talos: `kernel.yama.ptrace_scope<=1` on the nodes (machine config), then re-run the TCP self-test; this
    gates `agent.acp` on the home cluster in *either* mode.
* **S7** — gVisor: re-check `google/gvisor#13439` before any runsc plan; if guest Landlock lands at ABI v1, nono's
    TCP claim (ABI v4) still would not hold — record it, don't infer it.
