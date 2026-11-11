# Communication Helm chart

Two run modes from one chart (ADR-0082). Nothing here is a feature the ADR does
not name: Postgres is external, secrets are secretRefs, and the only thing that
makes Kubernetes privileges appear is `worker.launcher: kubernetes`.

## Modes

| mode | renders | image | RBAC |
|---|---|---|---|
| `single` | one Deployment (`communication dev`), one Service, one PVC | worker | none, and no SA token mounted |
| `split` | `serve` Deployment (N replicas) + worker Deployment (`Recreate`), Service, PVC | serve + worker | only with `worker.launcher: kubernetes` |

## Prerequisites the chart does not create

- **Postgres** (external, ADR-0013) and a Secret holding its URL:
  `kubectl create secret generic communication-database-url --from-literal=url='postgres://…'`
- **Keyring** (optional; without it secret writes refuse loudly, ADR-0018 D2.3).
  One 32-byte master key as hex, in a file named `master-key-v1`:
  `head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > master-key-v1`
  then `kubectl create secret generic communication-keyring --from-file=master-key-v1`
  and set `keyringSecret: communication-keyring`.
- **OIDC**: `oidc.issuer` + `oidc.clientId` (a client secret is optional: empty
  name means public client + PKCE). `devLogin: true` renders the lab's dev path
  instead — **never in production** (it turns the Secure cookie flag off).
- With `launcher: kubernetes`, the `worker.agentNamespace` must exist; the
  chart puts a `Role`/`RoleBinding` + the worker `ServiceAccount` in it.

## Key values

`mode`, `image`/`serveImage` `{repository,tag,pullPolicy}`, `serve.replicas`,
`database.urlSecret.{name,key}`, `oidc.{issuer,clientId,clientSecret.{name,key}}`,
`devLogin`, `publicUrl`, `keyringSecret`,
`worker.{enforcement,launcher,agentNamespace,capacity}`,
`persistence.{size,storageClass}`, `ingress.{enabled,host,className}`,
`networkPolicy.egressCIDRs`, `podSecurityContext`, `securityContext`,
`resources`, `extraEnv`, `nodeSelector`/`tolerations`/`affinity`.

Layout the chart fixes (copying the working home deployment and research § 1):
storage roots `/data/workspaces`, `/data/repos`, `/data/artifacts` as subPaths of
one claim; the three sandbox directories (`/sandbox-home`, `/sandbox-policy`,
`/sandbox-selftest`) as **siblings**, because nono derives its protected state
root from HOME and then permanently refuses overlapping grants (probe C-H1).

## Check it

```bash
helm lint deploy/helm/communication
for f in deploy/helm/communication/ci/*.yaml; do
  helm template x deploy/helm/communication -f "$f" >/dev/null || echo "FAIL $f"
done
bash scripts/kind/test.sh            # DOCKER="sudo -n docker" on this host
```

`scripts/kind/test.sh` installs each ci/ values file into a real kind cluster,
waits for readiness, runs `communication doctor` inside the pod, and asserts the
worker's ServiceAccount can create pods in the agent namespace and cannot in
`default` or in the platform namespace. See `docs/run-modes.md`.

## Limits (v1, ADR-0082)

Attempts pin to one node (RWO claim, `nodeName`); a session dies with the worker;
the host must give Landlock ABI ≥ V4 and `kernel.yama.ptrace_scope` ≤ 1 or the
worker withholds `agent.acp` — that refusal is the design, not a bug.
