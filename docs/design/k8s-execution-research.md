# Running agent attempts in Kubernetes pods: research (round 1)

**Status:** research, no decision yet. This feeds the ADR the Assistant handoff §7 asks for. Round 2, on Kubernetes-native egress restriction, is appended below once it lands.

**Context:** each agent attempt should run in its own pod (handoff §7, "Mode B"). Today the worker launches the agent as a child process under nono, inside the worker's own container (ADR-0001 option B, ADR-0019).

## What this repo has already measured

All of the following is in `docs/compatibility/SANDBOX.md`.

- **Filesystem:** nono 0.80 enforces it with Landlock V6, in the lab container and on the host.
- **Egress allowlist (ADR-0035):** nono's per-session CONNECT proxy holds `network.allow_domain`. Lab rows 8a/8b show the allowed host reachable (`api.anthropic.com` answered 405), `example.com` denied as `host_denied`, and the denial journalled.
- **Talos home cluster** (2026-11-20 addendum): with `kernel.yama.ptrace_scope=2`, nono's pathname AF_UNIX mediation (seccomp-notify on connect) fails every TCP connect with `EPERM`. The worker's startup probe detects this and withholds `agent.acp`. Nodes need `ptrace_scope <= 1`.

## kubernetes-sigs/agent-sandbox
Sources: [repo](https://github.com/kubernetes-sigs/agent-sandbox), [releases](https://github.com/kubernetes-sigs/agent-sandbox/releases), [api.md](https://raw.githubusercontent.com/kubernetes-sigs/agent-sandbox/main/docs/api.md).

- **Release and API:** v1.0.10, released 2026-11-06. `Sandbox` is `agents.x-k8s.io/v1beta1`; `SandboxTemplate`, `SandboxClaim` and `SandboxWarmPool` are `extensions.agents.x-k8s.io/v1beta1`. Weekly 1.0.x releases still change behaviour; for example, v1.0.6 started rejecting names longer than 63 characters.
- **Model:** one stateful pod per Sandbox, plus an optional headless Service. Claims check sandboxes out of warm pools, but per-claim `env` or `volumeClaimTemplates` force a cold start. Suspend deletes the pod and keeps the PVCs.
- **Process access:**
  - The Sandbox Router is an HTTP/gRPC proxy keyed by an `X-Sandbox-ID` header. Direct port-forward does not work under gVisor ([gVisor guide](https://agent-sandbox.sigs.k8s.io/docs/use-cases/gvisor-isolation/)).
  - sandboxd's `ProcessService` offers streaming `Start` plus `WriteStdin`, which is enough for ACP stdio ([process.proto](https://github.com/kubernetes-sigs/agent-sandbox/blob/main/packages/sandboxd/spec/process/v1/process.proto)). It has no TLS, and its bearer auth is opt-in ([USER_GUIDE](https://github.com/kubernetes-sigs/agent-sandbox/blob/main/packages/sandboxd/USER_GUIDE.md)).
  - The **Go SDK shows no stdin streaming** (only Run, Read and Write — [Go quickstart](https://agent-sandbox.sigs.k8s.io/docs/getting_started/go-sdk-quickstart/)).
- **Networking:**
  - The managed default policy allows ingress only from the router. Egress is the public internet minus RFC1918 and the metadata server, with **no FQDN allowlist**.
  - Since v1.0.10 the router's policy allows sandbox egress on ports 443, 6443 and 53 to anywhere, unless `apiServerCIDRs` is set.
- **Requirements:** Kubernetes 1.25+, 1.29+ recommended. It runs on kind ([quickstart](https://agent-sandbox.sigs.k8s.io/docs/use-cases/examples/quickstart/)). For gVisor on kind, the only recipe found is third-party ([nucleus](https://coproduct-opensource.github.io/nucleus/quickstart/agent-sandbox.html)) and is unverified.

## nono
Sources: [always-further/nono](https://github.com/always-further/nono) and its [networking](https://github.com/always-further/nono/blob/main/docs/cli/features/networking.mdx), [containers](https://github.com/always-further/nono/blob/main/docs/cli/internals/containers.mdx) and [troubleshooting](https://github.com/always-further/nono/blob/main/docs/cli/usage/troubleshooting.mdx) docs.

- **Release:** v0.81.0, released 2026-10-29. It is pre-1.0.
- **Enforcement:** Landlock for the filesystem; ABI v4 or later (kernel 6.7+) adds TCP rules. `--block-net` is a seccomp filter. `--allow-domain` runs a CONNECT proxy in the supervisor; `nono proxy` runs that proxy standalone.
- **In containers:** the seccomp profile must allow user notifications, `clone(CLONE_FILES)` and `close_range`. nono fails closed, aborting rather than running unrestricted.
- **nono cannot enforce Landlock under gVisor.** gVisor's syscall table has no Landlock, and its Landlock tests are skipped on gVisor ([linux64.go](https://github.com/google/gvisor/blob/master/pkg/sentry/syscalls/linux/linux64.go), [landlock_v1.cc](https://github.com/google/gvisor/blob/master/test/syscalls/linux/landlock_v1.cc)).

## Egress allowlisting (round 1)
- **NetworkPolicy** can only select pods, namespaces and CIDRs: no FQDN rules, and it needs an enforcing CNI. **kind enforces it since v0.24.0** through kube-network-policies ([kind v0.24.0](https://github.com/kubernetes-sigs/kind/releases/tag/v0.24.0)).
- **Cilium `toFQDNs`** needs a DNS L7 rule ([Cilium DNS](https://docs.cilium.io/en/stable/security/dns/)) and has a documented kind install ([Cilium kind](https://docs.cilium.io/en/stable/installation/kind/)).
- **ClusterNetworkPolicy** (the merged ANP/BANP) went to v1beta1 in network-policy-api v0.3.0, released 2026-11-06 ([release](https://github.com/kubernetes-sigs/network-policy-api/releases/tag/v0.3.0)). It has `domainNames` egress peers, in the experimental channel.
- **Calico** domain policy is documented only for Enterprise and Cloud.
- **The proxy pattern** (a NetworkPolicy allows only the proxy, and the proxy holds the allowlist) works on any enforcing CNI, including stock kind.

## Options compared
| | agent-sandbox + gVisor | Pod/Job + nono (runc) | Pod/Job + gVisor, no nono |
|---|---|---|---|
| Isolation | User-space kernel, pod per attempt | Host kernel + Landlock/seccomp | User-space kernel, the pod is the boundary |
| Egress | Open internet minus private ranges, by default | nono domain proxy + NetworkPolicy | NetworkPolicy + proxy or FQDN policy |
| ACP stdio | sandboxd could carry it; the Go SDK lacks stdin | native exec/attach, or dial-back | API-server attach (untested under runsc), or dial-back |
| Warm start | Warm pools, but per-claim env forces a cold start | build it ourselves | build it ourselves, plus gVisor start cost |
| Dependencies | controller, CRDs, router, sandboxd, runsc | nono + seccomp profile; node `ptrace_scope <= 1` | runsc on nodes |
| kind CI | yes; gVisor via an unofficial recipe | yes; Landlock comes from the CI kernel | yes; same runsc recipe |

**Round-1 leaning:**
- Worker-created pods behind a launcher interface, so agent-sandbox can slot in later.
- gVisor where available.
- Egress denied by default, plus an allowlist.
- No service-account token in the pod.

**Open spikes:**
- Installing runsc into kind.
- ACP over `pods/attach` under runsc.
- Whether nono's seccomp-notify works under runsc.

The owner asked for a deeper look at Kubernetes-native egress restriction before choosing (round 2).
