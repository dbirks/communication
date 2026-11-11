# ADR-0082: Two run modes, a single container with nono and Kubernetes-native agent pods, in one minimal Helm chart

- **Date:** 2026-11-11
- **Status:** Proposed (acceptance requires spikes S1, S2 and S4 green in kind)
- **Owners:** project owner, orchestrator
- **Related decisions / contracts:** ADR-0001 (control and worker modes), ADR-0003 and ADR-0009 (nono required
  mode), ADR-0019 D6 (no unverified fallback), ADR-0035 (egress), ADR-0040 (Claude token),
  `docs/research/2026-11-k8s-run-modes.md` (research and code map)

## Context
The owner wants two ways to run Communication:

1. **Simple.** One container: the Go binary, the UI and a worker that runs agents in nono sandboxes in-process.
2. **Kubernetes-native.** The worker orchestrates pods: one agent pod per attempt, nono inside the pod, the right
   RBAC, and a deliberately small Helm chart tested in kind.

The research (§1) shows the simple mode almost exists. `communication dev` runs serve and the worker in one
process (`cmd/communication/dev.go`), but nothing ships or tests it in the **worker image**, the only image that
contains nono, the ACP adapters and APM.

Pods do not exist at all. The worker execs the adapter locally (`internal/agent/acp/runtime.go:41-105`).

## Options considered
| Option | Advantages | Disadvantages | Evidence |
|---|---|---|---|
| agent-sandbox CRDs as the pod layer | upstream nono example, warm pools | its default egress is open (v1.0.10), its stateful singleton model doesn't match per-attempt units, and it changes weekly | research §2.1 |
| **Worker-created Pods behind a `Transport` seam, ACP over `pods/exec` stdio** | ACP keeps its exact stdio model; no listener inside the boundary; least code | the worker holds `pods/exec`; a worker restart kills a session, as a killed child does today | research §2.2 shape A |
| Pod dials back to the worker | best privilege story | a new server and auth protocol to write first | research §2.2 shape C; kept as the follow-up |

## Decision
1. **Single mode.** The worker image runs `communication dev`.
   - Helm `mode: single` renders **one** Deployment, with the `migrate` initContainer, the sandbox dirs as
     siblings of the storage roots, and a PVC for workspaces, repos and artifacts.
   - It renders no RBAC at all.
   - Compose gains `compose.single.yml` (Postgres plus one container).
   - The host must give Landlock ABI ≥ V4 and `kernel.yama.ptrace_scope` ≤ 1. Otherwise the worker's existing
     startup gate withholds `agent.acp`, which fails closed.
2. **Kubernetes mode.** Helm `mode: split` renders serve (N replicas) and a worker.
   - The worker has `launcher: local` (today's behaviour) or `launcher: kubernetes`.
   - With `kubernetes`, the worker creates **one Pod per agent attempt** in `agentNamespace`, from the **same
     worker image**, labelled `communication.dev/attempt=<id>`.
   - The attempt pod has `restartPolicy: Never`, `automountServiceAccountToken: false`, uid/gid 10001,
     `RuntimeDefault` seccomp, `drop: [ALL]` and `allowPrivilegeEscalation: false`.
   - The worker starts the session with `pods/exec` running today's nono argv. ACP rides the exec's stdin and
     stdout.
   - The pod's command is `sleep infinity` under a tiny `communication pod-wait` entrypoint that exits when
     stdin closes.
3. **Verification stays fail-closed.** Before the session starts, the worker execs
   `communication doctor --sandbox --json` in the attempt pod and requires the same N-a…N-d verdict
   `nono.Verify` gives locally. With no verdict, there is no session (ADR-0019 D6).
4. **Workspaces (v1).** The attempt pod mounts the worker's workspace PVC at the same absolute paths and is
   pinned to the worker's node by `nodeName`. This works because the PVC is RWO and on a single node in kind and
   the home cluster.
   - Every path assumption stays valid, including capture, checkpoints and artifacts.
   - Multi-node (an RWX PVC, or clone-in-pod with returned bundles) is out of scope and stays a follow-up.
5. **Credentials.** Each attempt gets a Secret, `attempt-<id>`, whose `ownerReferences` point at the attempt
   Pod. It holds only the files that launcher needs: the Claude token, Codex auth or the Pi key.
   - An initContainer copies it into a 0700 emptyDir as 0600 files, the home manifest's pattern.
   - No value ever appears in a pod spec, env value or argv.
6. **RBAC.** The worker gets a namespaced `Role` in `agentNamespace` and nothing cluster-wide:
   - `pods` create, get, list, watch, delete
   - `pods/exec` create
   - `pods/log` get
   - `secrets` create, get, delete
   - `events` list
7. **NetworkPolicy.** The chart renders default-deny egress for attempt pods plus CIDR allows from values: DNS,
   model endpoints and git hosts. nono's `allow_domain` proxy stays the FQDN layer inside the pod.
8. **The seam.**
   - `acp.Transport` / `acp.Transporter` (research code map): `ProcTransport` is today's code, unchanged, and
     `PodTransport` is new in `internal/sandbox/k8s`.
   - Selection: `COMMUNICATION_WORKER_LAUNCHER=local|kubernetes`, with `COMMUNICATION_AGENT_NAMESPACE`,
     `COMMUNICATION_AGENT_POD_IMAGE` and `COMMUNICATION_AGENT_POD_NODE` (downward API).
   - The new dependency is `k8s.io/client-go`, the smallest set needed.
9. **The chart** is `deploy/helm/communication`.
   - Templates: `_helpers.tpl`, `deployment.yaml` (single or serve), `deployment-worker.yaml`, `service.yaml`,
     an optional `ingress.yaml`, `pvc.yaml`, and `rbac.yaml` plus `networkpolicy.yaml` (only with
     `launcher: kubernetes`).
   - Postgres arrives only as an external `database.url` secretRef.
   - No template ever renders a secret value.
10. **kind test.** `scripts/kind/test.sh` does the following:
    - creates a kind v0.33.0 cluster pinned by digest;
    - builds and loads the images;
    - applies a throwaway Postgres;
    - installs the chart in each of the three configurations: single, split + local, split + kubernetes;
    - waits for readiness;
    - runs `communication doctor` in an attempt pod (S1);
    - runs one ACP handshake through `pods/exec` with a fake adapter (S2);
    - asserts the attempt Secret is gone after the pod is deleted (S4);
    - asserts the worker's ServiceAccount cannot create pods outside `agentNamespace`, using
      `kubectl auth can-i`.

    CI runs the same script on `helm/kind-action@v1.15.2`. The runner kernel is Landlock v4, recorded as its own
    row in `docs/compatibility/SANDBOX.md`.

## Consequences
- **Simple mode:** one image and one command, with no Kubernetes privileges.
- **Kubernetes mode:** agent processes leave the worker's pod. A compromised agent lands in a pod with no
  service-account token, no capabilities, default-deny egress and nono.
- **Limitations:**
  - Attempts are pinned to one node (v1).
  - A session dies with the worker.
  - The worker holds `pods/exec` on the agent namespace.
  - The home cluster's Talos nodes still need `ptrace_scope ≤ 1` for agent turns in either mode (S6).

## Security/privacy
- **Least privilege:** a namespaced Role, separate from the platform namespace; attempt pods carry no SA token.
- **Secrets:** they live in owner-referenced, per-attempt Secrets, are copied to 0600 files, and never appear in
  specs or argv.
- **Fail-closed verification:** there is no session without an in-pod nono verdict.
- **Egress:** CIDR-level deny by default, with FQDN rules enforced by nono.

## Verification
Spikes S1, S2, S4 and the `auth can-i` checks are scripted in `scripts/kind/test.sh` and run in CI. Go unit
tests cover `PodTransport` against client-go's fake clientset, plus exec stream tests with a fake executor.
`helm lint` and `helm template` run in CI for every values file under `deploy/helm/communication/ci/`.

## Migration/rollback
The default stays `launcher: local`. Rollback means setting `launcher: local`, or reverting the chart. Existing
compose and home-k8s manifests are unaffected.
