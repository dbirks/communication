# Using Communication on the home cluster

For the product owner. Live stack: manifests in `~/dev/home-k8s/apps/communication/communication.yaml`
(plus `communication-image-automation.yaml` and the `*-secrets.enc.yaml` / `communication-keyring.enc.yaml`
SOPS files). Status words here are only ever as strong as
[`design/wishlist-gap.md`](design/wishlist-gap.md) records them; nothing below claims a capability that
doc has not marked live.

## 1. What runs where

- **`deploy/communication`** (`ghcr.io/dbirks/communication:main`, args `serve`) — the stateless control
  plane: API, embedded web UI, artifact *reads*, and the read-only assistant
  (`COMMUNICATION_ASSISTANT_*` → the LLM collective, ADR-0034). Tailnet-only Tailscale Ingress at
  **https://communication.beluga-wyvern.ts.net**; artifact previews get their own hostname,
  `communication-preview.beluga-wyvern.ts.net` (ADR-0020 D6). Login is OIDC via tsidp;
  `COMMUNICATION_BOOTSTRAP_ADMIN_SUBJECTS` grants org admin. Init containers run `migrate up` (ADR-0013)
  and stage the secret keyring (ADR-0018). All state lives in Postgres — one replica is deliberate.
- **`deploy/communication-postgres`** (`postgres:18.6`, PVC `communication-postgres-data`) — the
  authoritative store; serve refuses readiness until the schema is current.
- **`deploy/communication-worker`** (`ghcr.io/dbirks/communication-worker:main`; binary + Node ACP
  adapters + nono + APM — the plain `:main` image has none of that and cannot run agent turns). It claims
  run attempts, mirrors repos under `/repos`, prepares per-run worktrees under `/workspaces`, executes
  nodes inside the nono (Landlock) sandbox (`COMMUNICATION_SANDBOX_ENFORCEMENT=required`: it refuses to
  start rather than launch an unisolated agent), and writes artifact bytes to `/artifacts`. Capacity 2.

Kinds this worker executes today (`cmd/communication/worker.go`): **`process.exec`**, **`model.chat`**
(one OpenAI-compatible completion against `COMMUNICATION_MODEL_CHAT_BASE_URL`;
`COMMUNICATION_MODEL_CHAT_MODELS` allowlists exactly `qwen3-8-flash-next`), **`artifact.publish`**, and
`agent.acp` (see below). **`human.approval`** — plus `condition`, `until`, `for_each`, `pipeline.invoke` —
is settled by the control plane with no worker lease (`docs/samples/home/README.md`).

`agent.acp` runs **only after you create the optional Claude credentials Secret**; until then the dir stays
empty, `agent.acp` fails closed with the worker's honest refusal, and only `process.exec`/`model.chat`/
`artifact.publish`/`human.approval` nodes run. From the manifest header, verbatim:

```
kubectl create secret generic communication-worker-claude -n default \
  --from-file=.credentials.json=$HOME/.claude/.credentials.json --dry-run=client -o yaml \
  > apps/communication/communication-worker-claude.enc.yaml && sops -e -i apps/communication/communication-worker-claude.enc.yaml
```

That file *is* your Claude login: every `agent.acp` run on this worker executes as that account and
`/harness/claude` is shared mutable state across them — not credential isolation (ADR-0019 D4).
`CODEX_HOME` is not mounted, so the codex launcher stays unavailable.

## 2. Ten-minute click path

1. Sign in at https://communication.beluga-wyvern.ts.net (tsidp OIDC) → **Projects** (`/`).
2. **New project** → open it → **Add repository** with an `https://github.com/...` URL (`/projects/<id>/settings`
   also holds members; the clone happens at run-prepare in the worker).
3. **Library** (`/library`) → **New pipeline** → **Start from** "Plan with approval" or "Security review"
   (the two vetted `docs/samples/home/` samples; `Blank` is the old paste path) → **Validate** → **Publish**.
4. Open the project → **Pipelines** (`/projects/<id>/pipelines`) → **Assign** the published pipeline.
5. **Runs** (`/projects/<id>/runs`) → **New run**. For a GitHub repo the form also offers **"Start from a
   GitHub issue"** (read-only, anonymous listing, ADR-0031), which fills the revision's declared `goal` /
   `issue_number` / `issue_url` inputs.
6. Watch it in the **run inspector** (`/projects/<id>/runs/<runId>`): stage strip, run tree, attempt
   transcripts. `model.chat` prompts interpolate `${{ inputs.* }}` and `${{ nodes.<id>.outputs.<name> }}`
   at claim time (ADR-0029, ADR-0027).
7. The `human.approval` gate pauses the run (`waiting_human`) → approve or reject inline on **Inbox**
   (`/inbox`) or on the gate card in the run inspector.
8. Published outputs appear under **Artifacts** (`/projects/<id>/artifacts`); HTML previews open on the
   separate preview origin.
9. **Schedules:** project → **Pipelines** → the assigned row's **"When to run"** block (ADR-0032) — a
   5-field **UTC** cron with hourly/daily/weekly presets, per-assignment; next run, last run and a pause
   toggle are shown. Nothing runs on a clock until a schedule exists there.
10. **Skills:** **Agents** (`/agents`) → **Attach skill package** → an APM ref pinned at a git tag
    (`owner/repo#v1.3.1`) plus its lock digest (ADR-0030). The form's **"How do I get this?"** block prints
    the two copy-paste commands that compute that digest inside the worker image; a moved tag fails closed.
11. **Ask anything:** **Ctrl K** opens the palette over pages, projects, pipelines, recent runs and agents;
    its Ask row is the assistant (ADR-0034).

## 3. Known limits (honest)

- **Unattended agent permission prompts are cancelled, not answered.** Under
  `permission_mode: ask`, a prompt inside a run is journalled `permission.requested` then
  `permission.decided{status:'cancelled', decided_by:'node_policy:ask_unattended'}` — the controller during
  an attempt is the run attempt, so no human holds the lock. An agent step that needs a write fails its
  run. Options 1–4 (recommendation: test steps as `process.exec`, lab-evaluate
  `preapproved_within_sandbox`) are in [`design/attempt-permissions.md`](design/attempt-permissions.md);
  option 1 needs no code and the home samples already follow it.
- **Agent egress is provisional.** The allowlist is a nono proxy domain list authored into the profile
  (ADR-0035 amends ADR-0019 D3), worker-config-owned via `COMMUNICATION_AGENT_EGRESS_ALLOW`, default
  `api.anthropic.com`. The mechanism is unit-tested; the host list is **not** lab-proven live — no real
  `claude-agent-acp` turn has run under an allowlist, so `network_enforced` stays honestly false until the
  row-8 denial in [`design/agent-egress.md`](design/agent-egress.md) is observed.
- **The assistant is read-only** (ADR-0034): a bounded tool loop over existing reads with *your*
  permissions, nothing stored, links only from the app-route allowlist. Write tools
  (`pipeline.createDraft/validate/publish`, `question.ask`, `approval.request`) are unbuilt.
- **The codex APM target has never been run live.** W6 is CHECKED LIVE for claude only
  (`docs/compatibility/APM.md:223-246`); the codex launcher is also unavailable on this worker (no
  `CODEX_HOME` mount).
- **Nothing else is a webhook.** Issue-triggered runs by *trigger* (webhook/polling, `triggers` tables) and
  `parallel`/`join` are spec only; `for_each` fan-out works (ADR-0031, W3).
- **Other rows not yet live** (W-numbers per [`design/wishlist-gap.md`](design/wishlist-gap.md)): the
  Assign button and the issue→run prefill have no recorded live click (W2/W3); the draft editor's per-step
  form is unit-tested only (W4); the run-attempt transcript's browser leg is still a driver stub (W7); the
  assistant has never answered through the palette here (W9 — this cluster *does* set
  `COMMUNICATION_ASSISTANT_*`, which the lab never had, so it is the place to record that first answer);
  there are **no resource limits** — the Operations page (`/ops`) says so openly and a noisy `process.exec`
  step is unbounded.

## 4. Troubleshooting

- Logs: `kubectl -n default logs deploy/communication` (serve + migrations) and
  `kubectl -n default logs deploy/communication-worker` (claims, clones, sandbox launches; the
  `claude-config` init container prints whether harness credentials were seeded).
- Readiness: https://communication.beluga-wyvern.ts.net/api/v1/system/readiness (`/api/v1/system/health`
  is liveness). Readiness goes false when the schema is behind — re-run `communication migrate up`.
- "The assistant isn't configured on this server." in the palette means `POST /assistant/ask` answered
  503 `assistant_not_configured`: `COMMUNICATION_ASSISTANT_BASE_URL/_MODEL/_API_KEY` are missing on serve.
  The palette still jumps; it just does not answer.
- Runs sitting queued with a live worker: the worker requires nono and fails to start otherwise, and it only
  runs the kinds in § 1 — an `agent.acp` node without the Secret fails closed rather than hanging.
- Updates: Flux image automation elects the `main` tag and rewrites the pinned `@sha256:` digest in
  `communication.yaml` as a git commit, so a green push to main is a real rollout (`kubectl -n flux-system
  get imagepolicy,imageupdateautomation` to watch it; `communication-worker` is a separate policy).
