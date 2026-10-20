# Gap analysis — Phase 5: Agent profiles (list / detail / New profile dialog)

Area: README "Agent profiles (2e, 3e) and New profile (4c → 5b)". Artboards 2e, 3e, 4c, 5b.
Scope: UI pages + the backend surface behind them (profiles, launchers, probes, secrets, APM, sandbox status).

## 1. Design asks

- **(2e, 3e)** 260px profile list: name, `launcher: <id>`, sandbox chip with 3 states —
  `✓ REQUIRED · VERIFIED` (green), `! INSECURE DEV EXECUTION` (amber), `! LAUNCHER NOT REGISTERED` (amber).
- **(2e)** Per row: account (`secret: CLAUDE_TOKEN_WORK`), skill package (`mattpocock/skills#v1.3.1` or
  "no skill package"), **used by N nodes**, `Edit` / `Duplicate`.
- **(2e, 3e)** Detail pane: versioned header (`CLAUDE CODE · WORK v3`), LAUNCHER select, ACCOUNT
  (`value never shown · long-lived token`), SKILL PACKAGE (ref · target · `sha256:…`),
  PERMISSION (`permission: ask`), **USED BY N NODES** (node name + which workflows), `Save as v4`, `Duplicate…`.
- **(3e)** SANDBOX · NONO block: enforcement chip; files (workspace rw, mirrors ro); network
  (egress allowlist); secrets (which slug as env); `checked · worker w-1 · 2h ago`.
- **(3e)** FROM APM PACKAGE contents: `SKILLS · 3`, `INSTRUCTIONS · 1` (+ Preview), `MCP SERVERS · 2`
  (with egress warnings), plus the "staging is not a security boundary" caveat.
- **(3e)** **USED BY N STEPS**: step name + "N workflows" / "N drafts".
- **(4c, 5b)** New profile dialog (720px) titled "for step <name>": **AGENT** = 5 cards
  (Claude Code `claude`, Codex `codex`, Pi `pi`, Antigravity `antigravity`, Other ACP agent = "any
  registered launcher"), each with 30px mono tile, launcher, readiness line
  (`✓ sandbox verified` / `✓ sandbox verified · no resume` / `! not tested yet` / `! not registered` /
  `run a probe first`); **ACCOUNT** select or "add a token" (`value never shown`); **NAME** suggested
  from agent + step; **SKILLS · OPTIONAL APM PACKAGE** with `Lock it` (server-side digest, 5b) and
  "locked for target <x>" line; green defaults bar (`✓ sandbox required · permission ask · egress
  allowlist from the project · Change`); footer `Cancel` / `Create and use in <step>`.
- **(README:55, 144)** Sidebar "Agent profiles (N)" under Library; routes `/profiles`, `/profiles/:id`;
  old routes keep working.

## 2. Exists today

**Profile entity & API**
- Table `agent_profiles` — `internal/store/postgres/migrations/00003_m2_conversations.sql:44-71`:
  `id, organization_id, name, launcher_id, permission_mode (default 'ask'), created_at`; unique
  `(organization_id, name)`. Seeded rows: `Claude Code`/`claude`, `Codex`/`codex` (:68-71), both `ask`.
  **No version column, no account field, no sandbox field.**
- API (openapi.yaml): `GET /api/v1/agent-profiles` (:839), `POST` (:876; body = `name` + `launcher_id`
  only; org library role required; `internal/api/agent_profiles.go:110-131`),
  `PATCH /api/v1/agent-profiles/{profileId}` (:923; APM triple all-or-nothing,
  `agent_profiles.go:73-92` — `apm_package_ref` + `apm_target` + `apm_lock_digest`).
- Events `agent.profile.created` / `agent.profile.updated` — `internal/events/events.go:236-237`.
- ADR-0030 (Accepted): writable fields are the APM columns only; "**No optimistic `version` token**"
  (`docs/adr/ADR-0030-writable-agent-profiles-with-apm-packages.md:62`); permission_mode is not
  writable ("ask is the only mode an unverified launcher may have", ADR-0009).

**UI today**
- One page, no detail route: `/agents` (`ui/src/App.tsx:91`) → `ui/src/pages/Agents.tsx` (499 lines).
  Testids: `agents-page`, `agent-list`, `agent-item-{id}`, `agent-row-{id}`, `agent-name/launcher/permission/apm-*`,
  `agents-new-form`, `agents-new-launcher-select` (hardcoded options `claude`/`codex` :274-275),
  `agents-digest-input` (operator pastes the lock digest by hand :332-399). Page already renders
  the "staging is not isolation" disclaimer and the `apm_pin_incomplete` problem code.

**Launchers**
- Exactly **two** built-in launchers: `claude` (`internal/agent/acp/launchers.go:77-92`) and
  `codex` (:96-110); `LookupLauncher` :117. No `pi`, no `antigravity` entry.
- The authoritative registry is meant to move to worker assets YAML "in a later milestone"
  (launchers.go:12-15; ADR-0007:48); `worker/` currently holds only `Dockerfile` + sandbox profiles.
- No API lists the registry, and the store does **not** check registry membership at create —
  `launcher_id` is regex-validated only (`agent_profiles.go` `cnvLauncherPattern`;
  migration CHECK :52). A profile `antigravity` can be created today and would fail at launch.

**Compatibility probes / evidence**
- `docs/compatibility/ACP.md` matrix: Claude Code ACP adapter and Codex ACP adapter rows = observed
  PASS; **:24-25 Gemini and Pi = GAP — "no ACP adapter for `pi` on this host"**. Raw evidence:
  `docs/compatibility/probes/acp/results-{claude,codex}[-permission].json`; `communication doctor --acp`
  (`cmd/communication/doctor.go:64-74,112-121`) re-runs end-to-end checks.
- **No database table stores probe results** — evidence is markdown + probe output only.
- ADR-0036 (Accepted): `preapproved_within_sandbox` granted to **lab seeds only**; `claude` is
  "the only one evaluated". `docs/compatibility/SANDBOX.md:372-374`: "One launcher (`claude`)… Codex
  was not tested".

**Sandbox status**
- Per worker: `workers.sandbox_backend / sandbox_version / sandbox_enforcement
  ('required'|'permissive-dev'|'disabled')` (`00004_m3_workspaces_secrets_artifacts.sql:75-78`).
- `GET /api/v1/system/sandbox` (openapi.yaml:1970): per-worker backend/version/enforcement/
  `verified`/notes; docs explicitly warn against a green check that implies safety.
- `GET /api/v1/turns/{turnId}/sandbox` (openapi.yaml:1929): per-turn enforcement record (stage,
  policy digest, egress enforced, grant roles) — the closest thing to "checked · worker · when".
- UI helpers already exist: `workerSandboxCopy` / `workerSandboxState` (`ui/src/api/sandbox.ts`,
  asserted by `ui/src/api/sandbox.test.ts:34-36` — `permissive-dev` must render "NOT a security
  boundary").

**Secrets (the "account")**
- `secret_metadata` (`00004…sql:253-270`): `scope ('project'|'org')`, `slug`, `purpose`,
  `delivery_mode ('env'|'env_file'|'integration_broker'` — broker "declared, never built" :264-266`
  ')`, `current_version`, **`allowed_agent_profile_ids uuid[]` (empty = denied to all :266-268)**,
  `allowed_node_template_ids`, `audit_policy`. Values are envelope-encrypted, never API-exposed.
- API: `GET/POST /api/v1/projects/{projectId}/secrets` (openapi.yaml:1472+),
  `PATCH …/secrets/{secretId}` (:1559, takes `purpose`, `allowed_agent_profile_ids`, `audit_policy` —
  `internal/api/secrets.go:518`), versions :1605, revoke :1647, materializations :1683. The `Secret`
  schema **returns `allowed_agent_profile_ids`** (openapi.yaml:5731-5760), so the UI can already
  compute "which secrets this profile may see" client-side.
- Claude token delivery pattern already exists: ADR-0040 (`claude setup-token` value delivered via
  nono's process environment, never argv/journal).

**APM**
- Worker-side staging verifies `sha256(apm.lock.yaml)` against the profile's recorded
  `apm_lock_digest` and refuses on mismatch (`internal/agent/apm/stage.go:18-24`,
  `manifest.go:9-18`). The digest is recorded **by hand** (UI paste field; `PATCH` triple).
- No API computes a lock/digest ("Lock it") and no API lists package contents (skills /
  instructions / MCP servers).

**"Used by"**
- Agent pipeline nodes reference the profile **by name** in `config.profile`
  (`ui/src/lib/pipeline/nodeFields.ts:107`; `internal/pipelines/compiler/policy.go:228-238`,
  name-scoped per ADR-0016 — no `@revision`). No endpoint reports which pipelines/steps use a profile.
- Node templates (= "steps") are compiled but **publishing is refused — the template registry is M5**
  (`internal/pipelines/compiler/template.go:13-15`). `secret_metadata.allowed_node_template_ids`
  exists but no `node_templates` table does. So "used by N steps" has no source-of-truth table yet.

## 3. Gap table

| item | kind | evidence / spec ref | size |
|---|---|---|---|
| `/profiles` + `/profiles/:id` routes, 260px list, `/agents` redirect | UI-only | `Agents.tsx` is a single page; `App.tsx:91` | S |
| Sandbox chip (required·verified / insecure-dev / launcher-not-registered) | UI on existing API | `GET /system/sandbox` (openapi:1970) + built-in registry (`launchers.go:77,96`); no API lists the registry → client hardcodes `{claude,codex}` unless a launcher-registry endpoint is added (ADR-0007:48) | S–M |
| ACCOUNT section (detail) + account select (dialog) | UI on existing API | `Secret` returns `allowed_agent_profile_ids` (openapi:5731+); attach = `PATCH` secret (:1559) | M |
| APM pin display / set / clear | **exists** | `Agents.tsx:332-399`; `PATCH` (openapi:923) | — |
| `Lock it` — server-side lock/digest computation | **needs backend + ADR** (decision list: "server-side APM lock digest") | digest manual today (`agents-digest-input`); staging logic worker-only (`apm/stage.go`) | L |
| APM contents (skills / instructions / MCP list, 3e) | **needs backend** | no API resolves or lists a package; staging runs at launch in the worker | L |
| "USED BY N STEPS / N NODES" with workflow/draft breakdown | **needs backend** | profile name in node `config.profile` (`nodeFields.ts:107`, `policy.go:228`); no aggregation endpoint; no step registry (`template.go:13-15`) | M |
| Profile versions `v3` / `Save as v4` / history | **needs ADR + backend** | ADR-0030:62 says no version; persisted-state change per PO decision | M–L |
| `Duplicate…` (clone launcher + APM triple) | UI-only (POST + PATCH) | both APIs exist; no dedicated endpoint needed | S |
| New profile dialog with 5 agent cards + readiness | UI on existing API (+ docs) | cards map to registry ids; readiness = registry membership + `ACP.md` rows + `/system/sandbox` | M |
| Pi / Antigravity launchers + probes | **needs backend** (worker launcher assets) + real probes | no `pi`/`antigravity` in `launchers.go`; `ACP.md:25` Pi = GAP, no ACP adapter on host | L (out of phase 5 — cards must show honest "not tested / not registered") |
| `Create and use in <step>` cross-link from Studio | UI-only (phase-4 coupling) | Studio's profile field is a name string (`nodeFields.ts:107`) | S |
| GitHub token attached to profile, usable in sandbox to push / open PR | **needs ADR** (amends spec 05) + egress config | spec 05:45,48,66,70; egress default = `api.anthropic.com` only (ADR-0035:121) | M |
| Defaults bar "egress allowlist from the project" (4c) | **needs backend / config-scope decision** | ADR-0035 allowlist is worker/deployment-level (env `COMMUNICATION_AGENT_EGRESS_ALLOW`), not project-scoped | M |

## 4. Spec / design conflicts

1. **GitHub token in the sandbox.** Design decision (README:41): "Agents may hold a GitHub token
   (via their profile's account/secrets) and push or open PRs themselves." Spec 05 currently frames
   GitHub credentials as org-integration credentials and requires the pipeline to own publication:
   - `communication-spec/05-workspaces-security-secrets.md:70` — "Configure separate commands/nodes
     for commit, push, draft PR, human review and merge … External publication operations need
     idempotent tokens and post-crash reconciliation."
   - `05:66` — "For third-party credentials prefer a restricted broker/token over long-lived raw
     secrets where feasible." A raw PAT env-var in the agent's sandbox is the *other* option; the
     ADR must justify it (egress allowlist + `audit_policy=materialization_and_access` + token
     scope limits) and note `integration_broker` stays declared-not-built
     (`00004…sql:264-266`, ADR-0018 clause 8).
   - Also `05:45` (tier 2 = "Project/organization integration credentials — GitHub Apps/PATs/
     SSH deploy keys") and `05:48` (SecretRef already has `allowed_agent_profiles` — so the secret
     plumbing is compatible; the ADR amends the *publish responsibilities*, not the SecretRef).
   - Egress: pushing needs `github.com`/`api.github.com` in the allowlist; shipped default is
     `api.anthropic.com` only (`docs/adr/ADR-0035-agent-turn-egress-allowlist.md:121`).
2. **"Codex ✓ sandbox verified" (4c, 5b).** `docs/compatibility/SANDBOX.md:372-374`: "One launcher
   (`claude`) … Codex was not tested", and ADR-0036: the preapproved evidence is claude-only. If the
   chip means *worker-level* nono enforcement, the wording is fine (`/system/sandbox`); if it means
   *per-launcher* verification, the design contradicts the evidence and must render
   "sandbox verified on this worker, no per-launcher evidence" (or amber).
3. **Profile versions (2e, 3e).** `CLAUDE CODE · WORK v3` / `Save as v4` vs ADR-0030:62
   "No optimistic `version` token — the triple is written as one" and the write model "the only
   writable fields are the three APM columns". Versioned profile history is a new persisted-state
   surface → ADR required (PO decision list), or drop `v3`/`Save as v4` from phase 5.
4. **"egress allowlist from the project" (4c defaults bar).** ADR-0035's allowlist is a
   worker/deployment configuration (env, digest-journalled), not a project setting; making it
   project-scoped is a security-semantic change → same ADR as item 1 or a separate one.
5. **Pi card implies a launcher that doesn't exist (5b).** `! not tested yet` suggests `pi` is
   registered and unprobed; in fact there is no `pi` entry in the registry (`launchers.go:77-110`) and
   `ACP.md:25` says "no ACP adapter for `pi` on this host". A created `pi` profile would pass the
   regex CHECK and fail at launch — the card must read "no launcher registered", and POST of an
   unregistered id is currently *accepted* (fail-closed only at launch, ADR-0019 D6).

## 5. Honest empty states

- **Pi / Antigravity cards (5b):** no launcher row, no probe row → "no launcher registered" (Pi)
  and "not registered" (Antigravity), amber, **disabled or select-with-warning**. Never green
  "verified"; `ACP.md:25` is the evidence text to quote on hover.
- **APM contents (3e):** until a resolver/list API exists, show only ref · target · digest (real
  data) plus "contents available after the package is staged — not available yet". Never fabricate
  skill/instruction/MCP counts.
- **USED BY (2e/3e):** until the aggregation endpoint exists, render "usage tracking not available
  yet" — *not* "used by 0 steps" (a zero claim we cannot substantiate).
- **Account value:** "value never shown" (matches the secrets API; spec 05:48 forbids a view-raw
  endpoint). The dialog's "or add a token" links to the existing secret-creation flow.
- **`checked · worker w-1 · 2h ago` (3e):** `/system/sandbox` gives per-worker `verified` +
  enforcement but no per-check timestamp; show `backend · version · enforcement · verified`, and
  "last verified" only if a timestamp is actually available.
- **Version header:** show nothing (or "v1") until the versioning ADR lands; no fake `v3`.

## 6. Proposed work units

Ordered; "∥" = may run in parallel (disjoint files), "→" = must serialize (same file).

1. **W1 — routes + profile list** (S, UI-only). New `ui/src/pages/Profiles.tsx` (260px list,
   sandbox chips from `useSystemSandbox` + registry set), new `ui/src/lib/profiles.ts` (chip
   derivation + testids), add `/profiles`, `/profiles/:id` to `ui/src/App.tsx` with `/agents`
   redirect. Owns: `App.tsx`, `Profiles.tsx`, `lib/profiles.ts`, `Profiles.test.tsx`.
2. **W2 — detail pane** (M, UI on existing API, → after W1: same `Profiles.tsx`/route files).
   Launcher, permission, APM triple (port the existing form from `Agents.tsx`), Duplicate (POST+
   PATCH), honest empty states per §5. Owns: `ProfileDetail.tsx` + tests.
3. **W3 — New profile dialog** (M, → after W1/W2). 5 agent cards with readiness text derived from
   the registry set + evidence strings; name suggestion from agent+step; defaults bar; "Create and
   use in <step>" (navigate with `?step=`; POST then optional PATCH APM + account grant). Owns:
   `ui/src/components/ProfileDialog.tsx` + tests; small hook in `ui/src/api/queries.ts`.
4. **W4 — account section** (M, → after W2, shares `ProfileDetail.tsx`). Client-side join of
   `useProjectSecrets` `allowed_agent_profile_ids` → profile; attach/detach via `PATCH` secret;
   org-scope secrets as the "account" tier; "value never shown". Owns: `ProfileDetail.tsx`
   section + `ProfileDialog.tsx` account select + tests.
5. **W5 — usage endpoint** (M, backend, ∥ W1–W4). `GET /api/v1/agent-profiles/{id}/usage` scanning
   published revisions + drafts for node `config.profile` (and template refs once the M5 registry
   exists); OpenAPI + problem doc. Owns: `internal/api/agent_profiles.go` (+tests),
   `internal/store/postgres/conversations.go`, `api/openapi.yaml`.
6. **W6 — GitHub-token ADR** (M, ∥ everything, ADR-only this phase). ADR amending spec 05:70/66
   (agent holds PAT, pushes/opens PRs itself; idempotency + reconciliation note; egress needs
   `github.com`/`api.github.com`; `integration_broker` remains declared-not-built). Owns:
   `docs/adr/ADR-00xx-github-token-in-agent-sandbox.md`.
7. **W7 — APM `Lock it` + contents API** (L, backend, needs the "server-side APM lock digest" ADR
   first; likely next milestone, not phase 5). Worker-side resolve → return manifest +
   `sha256(apm.lock.yaml)`; control-plane API `POST /api/v1/agent-profiles/{id}/apm:lock`.
8. **W8 — profile versioning** (M–L, ADR + migration + API; deferrable out of phase 5; see Q1).

## 7. Acceptance checks

Browser-testable against the real lab (`pnpm dlx @playwright/cli`):

1. `GET /api/v1/agent-profiles` returns the 2 seeded rows; after one dialog submission the list
   count is +1 and the new row is present with the chosen `launcher_id` (before/after API state).
2. Routes: `/profiles` renders `data-testid="profiles-list"` with exactly one `profile-item-{id}`
   per API row; `/profiles/{id}` renders `profile-detail-{id}`; navigating to `/agents` lands on
   the profile list (redirect), and `Agents.test.tsx` still passes unmodified or is deleted only
   in the same unit.
3. Chips: with the lab worker registered (`/system/sandbox` `enforcement: required`, `verified:
   true`) claude/codex rows show `REQUIRED · VERIFIED` with a glyph **and** text (assert the text
   node, not the color); a `permissive-dev` worker flips the chip to `INSECURE DEV EXECUTION` with
   "NOT a security boundary" wording; a profile whose `launcher_id` ∉ `{claude,codex}` shows
   `LAUNCHER NOT REGISTERED`.
4. Dialog: exactly 5 cards with testids `profile-agent-card-{claude,codex,pi,antigravity,other}`;
   the pi card's readiness text is "not registered" (not "verified"); submit with pi either
   disabled or refused with the named 422 — and `document.body.innerText` never contains a
   `sha256:` digest that wasn't returned by the API.
5. APM: "locked" line appears only after `PATCH` 200 and shows the server-returned digest; partial
   pin renders the `apm_pin_incomplete` problem code (existing behavior retained).
6. Account: detail shows only slug + delivery mode + "value never shown"; assert no secret value
   string from the fixture appears anywhere in `document.body.innerText`.
7. Used-by: before W5 ships, the section renders `usage-tracking-unavailable` (testid), never a
   numeric "0"; after W5, count equals the number of node `config.profile` refs in the lab's
   published revisions (verify via `GET /api/v1/pipelines` bodies in the same test).

## 8. Open questions for the product owner

1. **Is profile versioning (`v3`, `Save as v4`) in phase 5 or deferred?** Recommended default:
   defer (W8 after its ADR); phase 5 shows a plain name, no version glyph.
2. **Should the launcher set be a small `GET /api/v1/launcher-registry` endpoint (worker assets per
   ADR-0007) instead of the UI hardcoding `{claude,codex}`?** Recommended default: yes — one tiny
   read endpoint, keeps the 5-card readiness honest as launchers land.
3. **GitHub PAT: accept raw-PAT-via-env into the sandbox (per your decision), with what guardrails?**
   Recommended default: org/project-scoped secret, `allowed_agent_profile_ids` grant,
   `audit_policy=materialization_and_access`, project egress allowlist including `github.com`, and
   the ADR records 05:66's broker preference as the future replacement.
4. **"Used by N steps": count only M5 node-template references, or also inline agent nodes in
   published pipeline revisions?** Recommended default: both, labeled "N definitions (M published,
   K drafts)" — the M5 registry doesn't exist yet, so inline nodes are the only real signal.
5. **Codex card's "no resume" (5b): which resume — ACP `loadSession` (observed PASS for Codex,
   `ACP.md` matrix) or conversation-level session restore?** Recommended default: derive every
   readiness glyph from the `ACP.md` probe rows so the UI can never claim more than observed.
