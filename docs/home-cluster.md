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
