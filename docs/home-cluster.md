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
`COMMUNICATION_MODEL_CHAT_MODELS` allowlists exactly `qwen3-8-27b`), **`artifact.publish`**, and
`agent.acp` (see below). **`human.approval`** — plus `condition`, `until`, `for_each`, `pipeline.invoke` —
is settled by the control plane with no worker lease (`docs/samples/home/README.md`).
Because the cluster manifests are not in this repo, the owner must update the deployed
`COMMUNICATION_MODEL_CHAT_MODELS` and `COMMUNICATION_ASSISTANT_MODEL` env vars to `qwen3-8-27b`
so the new default is allowed and used.

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
   The two samples are also listed in a read-only **PIPELINE TEMPLATES** panel at the bottom of `/library`
   that **every signed-in member can see** (`9be68fd`) — each row names `docs/samples/home` as its document
   source, and nothing there writes. Creating from one still needs the library role (today: an organization
   admin, i.e. a `COMMUNICATION_BOOTSTRAP_ADMIN_SUBJECTS` subject): without it the panel's own note reads
   "read-only — creating a pipeline from one needs the library role", every template row adds "needs the
   library role to create", the NEW PIPELINE form is absent, and the draft editor opens **read-only** with
   the reason on the page — "read-only — editing a shared draft needs the
   library role (organization admins hold it), and publishing refuses a caller without it. Revisions and
   validation stay readable." (`8f28cb3`). Reading a draft, **Validate** against the server's copy and every
   published revision stay available to everyone either way. Same commit: an unsaved-changes guard
   ("Leave this draft with unsaved changes?") so navigating away cannot silently discard the text, and the
   per-step **form** beside the YAML now covers approval / until / for_each / condition / publish fields.
4. Open the project → **Pipelines** (`/projects/<id>/pipelines`) → **Assign** the published pipeline (that
   write is Maintainer+ on the project). A pipeline's own library page (`/library/<id>`) carries the same
   write in an **ASSIGN TO A PROJECT** panel that lists **every project you maintain with its state** —
   `assigned · pins 1.0.0 (newest published)` / `(an older revision)` / `· disabled` (an unlabeled pin reads
   `r<12 hex>`), `not assigned`, or `checking…` while its read is in flight, with the pick on the unassigned
   rows — instead of hiding the
   projects already assigned, so you can see where a definition actually runs before leaving the library
   (`9be68fd`). When every maintained project already has it, the panel says so and links to your projects.
5. **Runs** (`/projects/<id>/runs`) → **New run**. For a GitHub repo the form also offers **"Start from a
   GitHub issue"** (read-only, anonymous listing, ADR-0031), which fills the revision's declared `goal` /
   `issue_number` / `issue_url` inputs.
6. Watch it in the **run inspector** (`/projects/<id>/runs/<runId>`): stage strip, run tree, attempt
   transcripts. The stage strip now shows **one cell per scope**, and a `pipeline.invoke` parent's child runs
   are reached through one always-visible "child runs" branch fed by `GET /runs/{id}/tree` (that was W11: 25
   C8 children parked under one paged invocation node were unreachable), while the event stream resumes with
   `?after=` and dedupes instead of reloading the page (`74ea274`); checkpoint rows no longer look like
   attempts, each attempt has one title, empty scopes
   collapse, and the header/digests fit a 390px screen (`e609b00`, browser-checked on the lab).
   `model.chat` prompts interpolate `${{ inputs.* }}` and `${{ nodes.<id>.outputs.<name> }}`
   at claim time (ADR-0029, ADR-0027). There is a **Retry** control: it is armed when a retriable target
   exists and otherwise disabled *with the reason* — a rejected gate is final (`run_not_retriable`), and the
   control names the gate that made it so (`a3004c0`; that wording has no live re-run recorded yet).
7. The `human.approval` gate pauses the run (`waiting_human`) → approve or reject inline on **Inbox**
   (`/inbox`) or on the gate card in the run inspector. The **Inbox re-reads itself every 7.5 s while the tab
   is visible** (`INBOX_POLL_MS`), so a gate or a permission prompt that turns pending while you are watching
   arrives without a reload; it is the only attention poller — the 15 s tickers elsewhere are health,
   readiness and scheduler (`699c3ff`). What the card shows is your pipeline's own
   `summary` text: for `plan-with-approval` that is the "Plan for … in repository …" line plus the
   markdown `model.chat` wrote. Where a plan is an object rather than a string, interpolating its arrays
   renders raw JSON the card truncates mid-array (the expression language has no join — ADR-0022 § 5),
   which is why the M4 lab planner now carries a `summary` string and its gate prints **Objective** plus
   that human-readable plan and nothing else (`35a9acf`); `findings`/`steps` stay in the node outputs.
   Author your own gates the same way — a bounded sentence, not an array.
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

**What a teammate who is not on the project sees.** One sentence, on every screen of a project they cannot
open — **Runs**, **Pipelines** and **Artifacts** now refuse with "Project not found or you do not have
access" (the overview already did): no rail, no library rows, no "not assigned to this project" chips
confirming the project exists and what is missing from it. Server-side, the project's runs and schedules
routes answer a non-member with the same existence-hiding 404 an unknown project gets (ADR-0014 § 3) instead
of a per-resource refusal, and an actor outside the caller's readable membership list reads "a member"
(`5145bcb`). Adding them (project → settings → members) is the fix; there is no "request access" flow.

## 3. Known limits (honest)

- **Unattended agent permission prompts are cancelled, not answered.** Under
  `permission_mode: ask`, a prompt inside a run is journalled `permission.requested` then
  `permission.decided{status:'cancelled', decided_by:'node_policy:ask_unattended'}` — the controller during
  an attempt is the run attempt, so no human holds the lock. An agent step that needs a write fails its
  run. **This cluster is unaffected by the lab decision**: option 2 (`preapproved_within_sandbox`) was
  evaluated and adopted **for the M4 lab's three seeded profiles only** (ADR-0036, `382d42b`) — the product
  seeds (migration 00003) and every deployment stay `ask`, so the home worker's behaviour above is what you
  get. Option 1 needs no code and the home samples already follow it (test steps as `process.exec`); the
  other options and why they are parked are in
  [`design/attempt-permissions.md`](design/attempt-permissions.md).
- **Agent egress is a nono proxy domain allowlist, and the mechanism is now observed live.** The list is
  authored into the sandbox profile (ADR-0035 amends ADR-0019 D3), worker-config-owned via
  `COMMUNICATION_AGENT_EGRESS_ALLOW`, default `api.anthropic.com`. The lab evaluation is recorded in
  `docs/compatibility/SANDBOX.md` § "Egress allowlist lab evaluation (rows 8a/8b)" (`9e83e12`): a real
  `claude-agent-acp` turn completed on `api.anthropic.com` alone (8a `PASS`, the live API answering `405` to
  a GET) while `fetch('https://example.com')` was refused with a `host_denied` audit record (8b `PASS`), and
  `sandbox.egress_observed` rows carry `"network": "allowlisted:api.anthropic.com", "network_enforced":
  true`. What is **not** live: the interactive conversation path never reads that audit (the same section's
  8-label `FAIL` — `journalEgressAudit` runs only on the pipeline attempt path), and a verify-time
  `sandbox.verified` still says `network_enforced: false` by construction because no connection has been
  denied yet. So an allowlist miss inside a browser conversation never reaches the journal — it is visible
  only in nono's own audit inside the worker (`nono audit show <session> --json`). Host list per
  [`design/agent-egress.md`](design/agent-egress.md).
- **The assistant is read-only** (ADR-0034): a bounded tool loop over existing reads with *your*
  permissions, nothing stored, links only from the app-route allowlist. Write tools
  (`pipeline.createDraft/validate/publish`, `question.ask`, `approval.request`) are unbuilt.
- **The codex APM target has never been run live.** W6 is CHECKED LIVE for claude only
  (`docs/compatibility/APM.md:223-246`); the codex launcher is also unavailable on this worker (no
  `CODEX_HOME` mount).
- **Nothing else is a webhook.** Issue-triggered runs by *trigger* (webhook/polling, `triggers` tables) and
  `parallel`/`join` are spec only; `for_each` fan-out works (ADR-0031, W3).
- **Other rows not yet live** (W-numbers per [`design/wishlist-gap.md`](design/wishlist-gap.md)): the
  issue→run prefill has no recorded live click (W3); what is outstanding on the editor is a re-run of the
  driver's W4/W8 legs since the `3654c18` fixes, not the feature itself — the pipeline-page **Assign** click
  is CHECKED LIVE (`8c4377c`) and so are the templates (`5fa3d52`, per the wishlist's evidence), and the
  `9be68fd` panel was browser-checked on the lab;
  the run-attempt transcript's browser leg landed but has **no recorded verdict** (W7, `dfc4db0`); the
  **Retry** control and the M5 journey's retry step have no live re-run either (`a3004c0`); the assistant has
  never answered through the palette here (W9 — this cluster *does* set
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

## 5. Verify the run (read-only evidence)

Everything below is a read. Nothing here writes, restarts or deletes anything, and nothing here can
print a credential: the commands name resources and **env variable names** only, never Secret
objects, Secret values, `.env` files or kubeconfig contents. Never run `kubectl get secret`,
`describe secret`, `-o yaml` on a Secret, or `logs | grep` for anything that could match a value —
the session cookie (`communication_session`, `internal/api/auth/config.go:25`) is a credential too,
so copy URLs, never headers.

**Namespace: `default`, not `communication`.** Every object in
`~/dev/home-k8s/apps/communication/communication.yaml` names `namespace: default` (the worker
Deployment is `communication.yaml:349-353`, serve `:116-119`, Postgres `:45-48`), so
`-n communication` finds nothing. Labels are
`app: communication`, `app: communication-worker`, `app: communication-postgres` (lines 53, 123, 358).

### a. The pod is up and the image is the one Flux pinned

```bash
kubectl -n default get pods,deploy \
  -l 'app in (communication,communication-worker,communication-postgres)' -o wide
# the worker container's pinned image digest, no Secret material in this read
kubectl -n default get deploy communication-worker \
  -o jsonpath='{range .spec.template.spec.containers[*]}{.name}{"\t"}{.image}{"\n"}{end}'
# env NAMES only (never .value), to confirm the worker's own configuration
kubectl -n default get deploy communication-worker \
  -o jsonpath='{range .spec.template.spec.containers[*]}{.name}{"\n"}{range .env[*]}{"  "}{.name}{"\n"}{end}{end}'
# what Flux elected, to compare against the digest above
kubectl -n flux-system get imagepolicy communication-worker -o jsonpath='{.status.latestImage}{"\n"}'
```

What "passing" looks like: `deploy/communication-worker` `READY 1/1` and its pod `1/1 Running`
(`worker` is the pod's only regular container — `keyring` and `claude-config` are init
containers and do not count toward `READY`; the serve pod reads `1/1` the same way, its init
containers being `migrate` and `keyring`); the worker image is
`ghcr.io/dbirks/communication-worker:main@sha256:<digest>` — the `communication-worker` image is
the only one that carries the binary + Node ACP adapters + nono + APM, and a worker pod pointing
at the plain `:main` image cannot run agent turns (§ 1). The env-name list must include
`COMMUNICATION_SANDBOX_ENFORCEMENT` (set `required`, manifest line 457), `COMMUNICATION_WORKER_NAME`
(taken from `metadata.name`, i.e. the pod name — line 447), `COMMUNICATION_MODEL_CHAT_BASE_URL` and
`COMMUNICATION_MODEL_CHAT_MODELS` (lines 466-467), `CLAUDE_CONFIG_DIR` (line 470) — and it must NOT
include `COMMUNICATION_AGENT_EGRESS_ALLOW`, which the manifest does not set, so the agent-turn
allowlist is the shipped default `api.anthropic.com` (`internal/sandbox/nono/egress.go:68`, read by
`internal/worker/agentturn.go:263-279`).

The init container that decides whether `agent.acp` is live at all prints its own verdict (a shell
`echo` in the manifest, not a Go log string — `communication.yaml:425,427`):

```bash
kubectl -n default logs deploy/communication-worker -c claude-config
# either:  claude-config: seeded harness credentials from secret communication-worker-claude
#  or:     claude-config: secret communication-worker-claude absent; agent.acp stays disabled
```

### b. The worker claimed the run's attempts — the strings that are really logged

Worker logs are JSON (`slog.NewJSONHandler` on stderr, `cmd/communication/worker.go:382`), so grep
the `msg` field, not loose prose:

```bash
kubectl -n default logs deploy/communication-worker --since=1h \
  | grep -E '"msg":"(worker registered|attempt loop starting|sandbox enforcement observed before serving turns|run workspace prepared|model\.chat egress is configured)"'
```

| observed `msg` | what it proves | source |
| --- | --- | --- |
| `worker registered` | the row `GET /api/v1/workers` answers; carries `worker`, `worker_id`, `hostname`, `version` | `internal/worker/worker.go:203-206` |
| `attempt loop starting` | the claim loop is running; carries `worker_id` and `capacity` (2 here) | `internal/worker/attemptloop.go:224-227` |
| `sandbox enforcement observed before serving turns` | nono passed the startup probe + self-test: `backend` (`nono`, `internal/sandbox/nono/launcher.go:36-37`; `internal/sandbox/nono/selftest.go:62`), `backend_version`, `filesystem_live: true` | `cmd/communication/worker.go:1009-1012` |
| `run workspace prepared` | **the per-attempt claim evidence** (§ 4 step 3): `run_id`, `workspace_id`, `worker_id`, `volume_id`, `repos` | `cmd/communication/worker.go:829-831` |
| `model.chat egress is configured against this endpoint (…)` | the `model.chat` endpoint is wired; names only the host, path, allowlist and `api_key_set: true|false` — never a key | `cmd/communication/worker.go:1158-1162` |

`run workspace prepared` is the line that ties *this* pod to *that* run: every wired kind runs
behind the run-workspace preparer (`internal/worker/runworkspace.go:71-89`, wired for
`process.exec`, `agent.acp` and `artifact.publish` at `cmd/communication/worker.go:518,523,542`
and for `model.chat` at `:563-567`), so an
attempt of the run that reached the node body logged it. Its counterpart on a refusal is
`run workspace preparation refused the attempt` (`internal/worker/runworkspace.go:83-86`).

Then grep for the failures that mean the run did **not** execute as claimed — each must be empty for
a clean run:

```bash
kubectl -n default logs deploy/communication-worker --since=1h \
  | grep -E '"msg":"(attempt claim failed|begin attempt failed|attempt lease lost.*|attempt terminal write (failed|rejected.*)|run workspace preparation refused the attempt|egress audit unavailable.*|UNSANDBOXED.*|unsandboxed execution.*)"'
```

`attempt claim failed` — `internal/worker/attemptloop.go:240`; `begin attempt failed` —
`internal/worker/attemptloop.go:399`; lease-loss lines — `internal/worker/attemptloop.go:426,568`;
workspace refusal — `internal/worker/runworkspace.go:83`; the egress-audit read failing (which
downgrades the run's own network claim to unenforced) — `internal/worker/egressaudit.go:133-135`;
and the two permissive-dev lines that this `required` worker must never print —
`internal/sandbox/nono/launcher.go:314` and `:376`.

**One honest limit:** there is no per-attempt log line naming nono. Sandbox enforcement per
attempt is journalled, not logged — `sandbox.verified` is appended for `process.exec` at
`internal/worker/procexec.go:611` and for `agent.acp` at `internal/worker/agentturn.go:992`, and
`sandbox.egress_observed` only on the attempt path at `internal/worker/egressaudit.go:143-153`. The
startup line above is the only place the word reaches the logs. So read (c) — the per-attempt
`sandbox.verified` row is the evidence, and a `sandbox.enforcement_failed` row names the stage that
refused (`internal/worker/procexec.go:599-610`).

### c. The API reads that pin the attempts to this worker

The id that ties everything together is the worker's: `GET /api/v1/workers` returns
`{id, name, hostname, version, status, started_at, last_heartbeat_at}`
(`internal/api/workers.go:16-23`, route mounted at `:38`), and `name` is the **pod name**
(`COMMUNICATION_WORKER_NAME` comes from `fieldRef metadata.name`, `communication.yaml:447`) — so the
`kubectl` line in (a) and the `worker_id` in every journal row are the same object. Every read
below is a plain `GET` (CSRF passes GET/HEAD untouched, `internal/api/middleware.go:216-220`), so
either open the URL in the signed-in browser tab or read the same payloads off the UI. Do not print
or paste the `communication_session` cookie value.

```
GET /api/v1/workers                             # the worker's id, and status=online
GET /api/v1/system/sandbox                      # per worker: backend nono, verified, enforcement
GET /api/v1/runs/{runId}                        # the run's terminal status
GET /api/v1/runs/{runId}/nodes                  # every node: kind, status, attempt_count
GET /api/v1/runs/{runId}/nodes/{nodeExecutionId}# attempts[] + the boundary checkpoint
GET /api/v1/runs/{runId}/checkpoints            # attempt_id ↔ worker_id, per boundary
```

- `GET /api/v1/system/sandbox` (`internal/api/sandbox.go:95`, view types `:71-90`) is the fleet
  answer to "was nono real here": `workers[].backend`, `backend_version`, `enforcement`,
  `verified`, plus `pinned_backend_version` and `policy_digest`. It is the `/ops` page's sandbox
  panel (`ui/src/components/Sandbox.tsx:123-158`).
- The **attempt** read deliberately carries **no** worker id: `AttemptView` has no
  `worker_id`/`fencing_token`/`lease_expires_at` field at all ("leak is unrepresentable, not merely
  filtered" — `internal/api/runs.go:246-274`, comment at `:247-250`; route `:568`, handler `:1034`).
  The worker's identity per attempt therefore comes from two places that *do* carry it:
  `GET /api/v1/runs/{runId}/checkpoints` (`internal/api/runs.go:563`, view
  `RunCheckpointView.WorkerID` at `:291`, store read `internal/store/postgres/attempts.go:788-791`)
  and the journal — `node.attempt.started` / `.completed` / `.failed` are appended with
  `Actor.Kind = "worker"` and `Actor.ID = <worker id>`
  (`internal/store/postgres/attempt_worker.go:489,598,682,706,734,760`; envelope `Actor` at
  `internal/events/events.go:60-80`). So "the cluster worker ran this attempt" is proven by the
  checkpoint row's `worker_id` equal to (a)'s worker id, plus the attempt's `status`/`finished_at`
  and the `node.attempt.*` actor.
- Terminal statuses to expect per attempt: `succeeded` (with `node.attempt.completed`), or
  `failed` with a named `error_class` and a bounded (≤512 B, redaction-scanned) `detail`
  (`internal/api/runs.go:251-274`); `interrupted` means the worker died mid-node and the outcome is
  unknown, and the run page says exactly that (`ui/src/components/m4/AttemptDetail.tsx:119-126`).
- `sandbox.verified` is the per-attempt enforcement row (there is no log line for it — see (b)):
  payload members `project_id, turn_id, workspace_id, worker_id, policy_digest, backend,
  backend_version, af_unix_mediation, network_enforced, network, grants, commit_granted, verified`
  (`internal/events/events.go:732-749`). It is appended for `process.exec` at
  `internal/worker/procexec.go:611` (payload builder `:615-631`) and for `agent.acp` at
  `internal/worker/agentturn.go:992`. The run's event stream is
  `GET /api/v1/runs/{runId}/events` (`internal/api/runs.go:569`, handler `:1063`); for an `agent.acp`
  turn there is also `GET /api/v1/turns/{turnId}/sandbox` (`internal/api/sandbox.go:94`).
  Read the two egress fields exactly as they are: for a `process.exec` node `network` is `"denied"`
  with `network_enforced: true` (the command profile launches with `--block-net`,
  `internal/worker/procexec.go:584`, reported at `internal/sandbox/nono/egress.go:305-307`); for an
  `agent.acp` node an allowlist that was never *exercised* reports `network: "open"` +
  `network_enforced: false` by construction, and `allowlisted:<hosts>` only once that run's own
  `nono audit show` saw a refusal (`internal/sandbox/nono/egress.go:285-316`, § 3 above). A green
  run with `open / false` on the agent node is the honest expected shape, not a failure.

**What the run page shows** (`/projects/<id>/runs/<runId>`, `ui/src/App.tsx:120`): the run header
with its status chip, the per-scope stage strip, the node panes with one `ATTEMPT <n>` panel each —
status chip, `error class` chip and the bounded `detail` text
(`ui/src/components/m4/AttemptDetail.tsx:101-113`) — and under the newest attempt the checkpoint
card: `inputs`/`outputs` digests, `volume` (the same `volume_id` as the row), per-repo
`base → head` commits and `saved` time (`ui/src/components/m4/AttemptDetail.tsx:513-569`), under
which it says plainly that "a retry inherits this boundary, not the interrupted process". A run the
worker cannot take shows the chip `waiting for its worker`
(`ui/src/pages/RunInspector.tsx:343-346`); an `agent.acp` attempt also gets a live work pane under
its card (`ui/src/pages/RunInspector.tsx:1171-1175`).

### d. "End to end with Claude agent steps" vs "model.chat only"

| | no `communication-worker-claude` Secret (today) | Secret created |
| --- | --- | --- |
| `process.exec` (`survey`, `scan`) | cluster worker, inside nono, `--block-net`, `sandbox.verified` says `denied`/`true` | same |
| `model.chat` (`plan`, `summarize`) | cluster worker, one HTTPS completion to `llm-collective.e-gineering.com` (the kind is only registered when the base URL is set, `cmd/communication/worker.go:563-567,1137-1139`) | same |
| `artifact.publish` (`publish_plan`, `publish_report`) | cluster worker, bytes into `/artifacts` (the `communication-artifacts` PVC), read back by serve | same |
| `human.approval` (`approve`) and `condition`/`until`/`for_each`/`pipeline.invoke` | **control plane**, no worker lease at all — the run parks `waiting_human` and the decision happens on `/inbox` | same |
| `agent.acp` | **runs on the cluster worker and fails closed**: the kind is wired (`cmd/communication/worker.go:523-526`), so the attempt is claimed and refused inside `credentialAuth`, whose `detail` names the launcher's credential directory as unusable (`internal/worker/agentturn.go:1323-1330`) with `error_class: infra`; the `claude-config` init line says `agent.acp stays disabled` | **runs on the cluster worker as your Claude account**: one prompt turn per attempt (`internal/worker/agentturn.go:597-620`) under the allowlisted agent-turn profile (`internal/worker/agentturn.go:263-279`, default host `internal/sandbox/nono/egress.go:68`), journalling `agent.session.connected`, `sandbox.verified` and — after the child exits — `sandbox.egress_observed` (`internal/worker/egressaudit.go:143-152`) |

So the click-through in § 2 is end to end **with** the cluster worker today (claim → workspace →
sandboxed command → model call → gate → artifact), but it is *not* an agent turn: with no Secret no
`agent.acp` node runs any Claude work, and both `docs/samples/home/` pipelines deliberately contain
no `agent.acp` node at all (`docs/samples/home/README.md`). The Claude-shaped run adds three things
to the same checks: the `run workspace prepared` line plus a `node.attempt.*` actor for the
`agent.acp` node, a `sandbox.verified` row whose `network` reads `open` (`false`) or
`allowlisted:<hosts>` (`true`) as explained above, and `sandbox.egress_observed` with
`denied_hosts` naming only hostnames. The transcript itself is the `agent.acp` attempt's work pane
and conversation (`ui/src/pages/RunInspector.tsx:1171-1175`), not a log.

Two standing cautions while reading: an unattended `permission_mode: ask` prompt is cancelled, not
answered, so an agent step that needs a write fails its run (§ 3), and every `agent.acp` run on this
worker executes as the single mounted Claude login with `/harness/claude` as shared mutable state
(ADR-0019 D4, § 1) — it is not credential isolation. And nothing in this section prints a Secret:
if a command you typed starts echoing values, stop and re-read the manifest by name instead.

### e. Proof record 2026-10-18

Spec: `e2e/tests/home-cluster.spec.ts` (commit `560e2d5`), opt-in via
`COMMUNICATION_E2E_HOME=1`; lab mode adds
`E2E_HOME_URL=E2E_BASE_URL=http://localhost:18091 E2E_HOME_LOGIN_SUBJECT=admin`.
Evidence files in `~/.cache/communication-lab/home-proof/`: `run-home3b.out`,
`run-home3c.out`, `run-home3d.out`, `run-lab1b.out`.

**Local lab (HEAD `5fad0d5`, real collective `qwen3-8-27b`, real Claude login): 6/6 PASS (1.1 min).**
Project "Home proof lab1" with repository `github.com/dbirks/communication`;
plan-with-approval `r1 sha256:8149ba4d…`; plan run `a473a0f4` completed on worker-a
(survey, plan `model.chat`, approve `human.approval`, `publish_plan` — all succeeded;
`plan_digest sha256:71681a21…`); claude `agent.acp` run `21f26cc5` completed on worker-b;
profile launcher claude, permission `ask`; no finding.

**Home cluster** (`https://communication.beluga-wyvern.ts.net`, tsidp OIDC as dbirks,
Talos v1.13.6):

- **Steps 1–4 PASS.** Plan run `7b3e0ef0` (and earlier `b5cc7a52`, `a488fbd5`) completed
  on the cluster worker (`communication-worker-5f5db7fcf9-4ncrd`), `r1 sha256:1f3abb35…`,
  `plan_digest sha256:14bde064…`, every node succeeded, gate approved through the UI.
- **Step 5 (claude `agent.acp`) NOT YET PASSING.** Findings fixed along the way, in order:
  1. Blank template could never get a first draft (`0e988e6`, product fix).
  2. Scheduler view listed ~90 dead worker pods (`2523dd5`, product fix).
  3. Every TCP connect in the agent sandbox was EPERM: nono's seccomp-notify AF_UNIX
     pathname mediation could not open `/proc/<pid>/mem` under Talos
     `kernel.yama.ptrace_scope=2` (nono trace: "Failed to read sockaddr from seccomp
     notification (nr=42): Failed to open /proc/615/mem: Permission denied"). The worker
     now self-tests TCP reachability at startup and withholds `agent.acp` if it fails
     (`5fad0d5`). Remediation applied by the owner's home-k8s session: `ptrace_scope=1`
     on both nodes (home-k8s `4f6cbdf`, no reboot); the cluster self-test now logs
     "agent-turn TCP reachability observed".
  4. **Current blocker.** Run `4d8fe087` failed in 4 s with
     `{"code":-32000,"message":"Authentication required"}` — the
     `communication-worker-claude` Secret is a snapshot of the owner's
     `~/.claude/.credentials.json`; its access token expired 03:28Z and its refresh
     token is rotated by the owner's local sessions, so a copied interactive login
     cannot stay valid on a cluster. Next: a long-lived `claude setup-token` credential.

Honest status: steps 1–4 pass on the cluster, step 5 is a **GAP with its reason** —
not a pass.
