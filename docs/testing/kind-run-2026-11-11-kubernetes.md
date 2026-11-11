# kind run, Kubernetes mode: 2026-11-11 (ADR-0082 spikes S1, S2, S4)

Command: `DOCKER="sudo -n docker" KIND="sudo -n env PATH=$PATH kind" SRC=<clean worktree> scripts/kind/test.sh` (kind v0.33.0, node v1.37.0, host kernel 7.2.9-arch1-1, Landlock ABI 6).

```
CHECK                                      RESULT DETAIL
------------------------------------------ ------ ------
kind cluster create                        PASS   v0.33.0 node image, pinned @sha256
cluster reachable                          PASS   communication-kind-control-plane   NotReady   control-plane   7s    v1.37.0
build serve image                          PASS   
build worker image                         PASS   sha256:e6d5061a1e8a5d898999f55d92a2dca23d2cf25e48a1328156c6986d39dba2ba
kind load serve image                      PASS   Image: "communication:kind" with ID "sha256:2e0e9b015fccd9138f92117d376695ad3eb317b6
kind load worker image                     PASS   Image: "communication-worker:kind" with ID "sha256:e6d5061a1e8a5d898999f55d92a2dca23
namespace communication                    PASS   
namespace communication-agents             PASS   
postgres manifest apply                    PASS   service/communication-postgres created
postgres password secret                   PASS   
database-url secret                        PASS   
keyring secret                             PASS   
postgres ready                             PASS   deployment "communication-postgres" successfully rolled out
helm install single                        PASS   `kubectl -n communication logs deploy/communication`.
single rollout                             PASS   deployment "communication" successfully rolled out
single readiness endpoint                  PASS   {"status":"ready","schema_version":33,"expected_schema_version":33}
doctor sandbox lines                       INFO   sandbox:nono                   ok       nono 0.80.0; landlock fs=true net=true; verified=false (probe only — enforcement proven by sandbox_integration tests, see docs/com
helm install split+local                   PASS   `kubectl -n communication logs deploy/communication-serve`.
serve rollout                              PASS   deployment "communication-serve" successfully rolled out
worker rollout (local launcher)            PASS   deployment "communication-worker" successfully rolled out
split readiness endpoint                   PASS   {"status":"ready","schema_version":33,"expected_schema_version":33}
worker doctor sandbox lines                INFO   sandbox:nono                   ok       nono 0.80.0; landlock fs=true net=true; verified=false (probe only — enforcement proven by sandbox_integration tests, see docs/com
single renders no RBAC                     PASS   
split+local renders no RBAC                PASS   
live split+local release has no RBAC       PASS   
helm template split-kubernetes             PASS                   port: {name: http}
RBAC apply (agent namespace)               PASS   rolebinding.rbac.authorization.k8s.io/communication-worker created
creates pods in communication-agents       PASS   got yes
creates pods/exec in communication-agents  PASS   got yes
reads pods/log in communication-agents     PASS   got yes
cannot create pods in default              PASS   got no
cannot create pods in communication        PASS   got no
cannot list secrets in communication-agents PASS   got no
no cluster-wide pod rights                 PASS   got no
only the worker SA is bound                PASS   got communication-worker ServiceAccount
release takes over the worker RBAC         PASS   role.rbac.authorization.k8s.io "communication-worker" deleted from communication-age
agent claim bound in communication-agents (communication-agents-data) PASS   persistentvolumeclaim/communication-agents-data condition met
helm install split+kubernetes              PASS   `kubectl -n communication logs deploy/communication-serve`.
serve rollout (kubernetes launcher)        PASS   deployment "communication-serve" successfully rolled out
worker rollout (kubernetes launcher)       PASS   deployment "communication-worker" successfully rolled out
split+kubernetes readiness endpoint        PASS   {"status":"ready","schema_version":33,"expected_schema_version":33}
worker registered the kubernetes launcher  PASS   {"time":"2026-11-11T19:06:40.24351731Z","level":"INFO","msg":"worker launcher: kuber
helm-owned RBAC: creates pods in communication-agents PASS   got yes
helm-owned RBAC: no pods in communication  PASS   got no
helm-owned RBAC: no secrets list in communication-agents PASS   got no
S1 attempt pod enforced the sandbox        PASS   S1 PASS: verified=true landlock_abi=6 tcp=true detail="nono 0.80.0; landlock abi v6; filesystem denial observed; tcp ok"
S1 pod-verify JSON                         INFO   verdict: {"verified":true,"landlock_abi":6,"tcp":true,"detail":"nono 0.80.0; landlock abi v6; filesystem denial observed; tcp ok"}
S2 ACP handshake over pods/exec            PASS   S2 PASS: "acp-echo: prompt=\"hello from kind\" probe=\"kind-probe-s3cr3t\" session=\"acp-echo//tmp\""
S4 secret GC with the attempt pod          PASS   S4 PASS: the garbage collector took the Secret with the pod
Decision 4: workspace is shared with attempts PASS   the attempt namespace read the worker file back through communication-agents-data
no attempt objects left behind             PASS   no attempt pods or secrets left in communication-agents
==============================================================================
PASS  (51 checks)
```

Not claimed: S5 (clone-in-pod workspace) and S6 (Talos ptrace_scope) need a model and node-restart lab.
