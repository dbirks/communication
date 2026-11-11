# Run modes: one container, or a control plane plus a worker

Communication ships in the two shapes ADR-0082 accepts. Pick by who has to be
alive independently, not by cluster size.

## Which mode

| | `single` | `split` |
|---|---|---|
| Shape | one container: `communication dev` (control plane + one worker, one process, one signal context) | `serve` Deployment (N replicas) + one worker Deployment |
| Roll you own | `docker compose -f compose.single.yml up` | Helm chart `deploy/helm/communication`, `mode: split` |
| Use it when | one host, one team, you want the whole thing in one `logs -f`; local eval of pipelines; a laptop | you need API replicas behind a load balancer, a worker rollout that does not drop the UI, or agent pods instead of agent children |
| Never when | you need HA — `dev` is explicitly not an HA runtime (`cmd/communication/dev.go:16-36`) | you cannot give the worker a persistent volume (workspace roots are single-writer) |
| Kubernetes privileges | none, and no service-account token is mounted | none unless `worker.launcher: kubernetes`, which adds a namespaced Role in `agentNamespace` and nothing cluster-wide |

Both modes keep `serve` from migrating the database: `communication migrate up`
is an initContainer / a compose one-shot, and a replica refuses readiness until
the schema is current (ADR-0013).

## Host requirements — the sandbox decides, not the orchestrator

`worker.enforcement` defaults to `required`, which means *proved or refused*:

* **Landlock ABI ≥ V4 from the HOST kernel.** Landlock is unprivileged and comes
  from the kernel, so no image, capability or seccomp tweak adds it
  (`https://docs.kernel.org/userspace-api/landlock.html`, read 2026-11-21). The
  worker runs a filesystem self-test at startup and refuses to serve turns it
  cannot isolate (ADR-0019 D6).
* **`kernel.yama.ptrace_scope` ≤ 1.** The agent-turn profile mediates AF_UNIX by
  pathname (seccomp-notify on `connect`); at `ptrace_scope=2` every TCP connect
  from an agent fails `EPERM`. Yama is host-wide — a pod cannot fix it, and
  Kubernetes cannot reproduce it in kind. The startup gate detects this and
  withholds `agent.acp` while `process.exec` / `model.chat` keep running
  (`docs/compatibility/SANDBOX.md` § Talos measurement).
  Check: `cat /proc/sys/kernel/yama/ptrace_scope`.
* **Seccomp:** the containerd/Docker default profile already allows the Landlock
  and notify syscalls, so the chart's `seccompProfile: RuntimeDefault` is
  compatible (`https://github.com/moby/profiles/blob/main/seccomp/default.json`,
  read 2026-11-11). Do not add `SYS_PTRACE` on a theory: it is spike S1, not a
  known requirement on ABI ≥ V4.
* A `required` worker that cannot prove any of this **fails visibly**. The
  symptom is a CrashLooping container whose log names the gate;
  `communication doctor` prints the same verdicts as rows
  (`sandbox:nono`, `sandbox:nono-tcp-reachability`).

## Single container — quick start

```bash
docker compose -f compose.single.yml up --build     # http://localhost:18190
```

One service from `worker/Dockerfile` (the only image with nono, the ACP adapters
and APM) run as `dev`, plus Postgres, a keyring one-shot and the mock IdP. Sign
in as `admin` — that is the lab's dev-login path
(`COMMUNICATION_COOKIE_SECURE=false` + a seeded bootstrap admin subject,
ADR-0012), which is why the file is called dev-only.

Two honest limits of this shape, both inherited from the images and the mode
itself: the worker image builds `ui/dist` as a placeholder
(`worker/Dockerfile:41-43`), so `dev` serves the API and **not** the web UI until
that build carries a bundle (ADR-0082 Decision 1's "one container: the Go binary,
the UI and a worker" is not fully true of today's worker image); and `dev`
defaults `COMMUNICATION_ALLOW_FILE_GIT_URLS=true`, which production does not.

Helm, same mode:

```bash
helm upgrade --install communication deploy/helm/communication \
  -n communication --create-namespace \
  -f deploy/helm/communication/ci/single.yaml --set devLogin=true
```

## Split — quick start

```bash
kubectl create ns communication
# Secrets first: the chart renders their NAMES only.
kubectl -n communication create secret generic communication-database-url \
  --from-literal=url='postgres://user:pass@host:5432/communication?sslmode=disable'
head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > /tmp/master-key-v1
kubectl -n communication create secret generic communication-keyring \
  --from-file=/tmp/master-key-v1 && rm /tmp/master-key-v1

helm upgrade --install communication deploy/helm/communication \
  -n communication -f deploy/helm/communication/ci/split-local.yaml
```

Set `worker.launcher: kubernetes` (see `ci/split-kubernetes.yaml`) only when you
want agent pods instead of agent children: the worker then creates one pod per
attempt in `worker.agentNamespace`, labelled `communication.dev/attempt=<id>`,
with no SA token, uid 10001, `RuntimeDefault`, `drop: [ALL]`, and ACP riding
`pods/exec` stdio. The chart's only privilege grant is the namespaced Role in
that namespace; the attempt pods get no token at all. The default stays `local`
(ADR-0082 Migration/rollback).

## Verify it in kind

```bash
DOCKER="sudo -n docker" KIND="sudo -n env PATH=$PATH kind" bash scripts/kind/test.sh
KEEP=1 …            # leave the cluster up
```

It creates `communication-kind` (kind v0.33.0, node image pinned by digest —
`https://github.com/kubernetes-sigs/kind/releases/tag/v0.33.0`, read 2026-11-11),
builds and loads both images, applies a throwaway Postgres, installs single then
split+local, waits on `/api/v1/system/readiness`, runs `communication doctor`
*inside* the pod (the probe must not run on a node shell), and asserts with
`kubectl auth can-i` that the worker SA creates pods in the agent namespace and
cannot in `default` or `communication`. Its final table is PASS/FAIL per check;
the doctor rows are reported as INFO because the verdict belongs to the host
kernel, not to the chart. Note that kind cannot test the Talos `ptrace_scope=2`
failure at all (host-wide Yama) and that its NetworkPolicy engine is pod/IP/CIDR
only — FQDN egress stays nono's `allow_domain` job inside the pod.
