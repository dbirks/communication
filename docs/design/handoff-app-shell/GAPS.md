# GAPS — app shell & IA redesign: living gap register

Purpose: for the "Six Directions" redesign (the `README.md` in this folder), record what can
be built on the existing API, what needs a backend/ADR, and what must render as an honest
empty state. `GOAL.md` is the build order (phases 1–9; tours are later). Update the status
log after each phase.

Detailed per-area analyses: `gaps/<area>.md` — shell, home-board, workbench, library,
profiles, threads, assistant, inbox-ops. Those reports are the detailed appendices and are
not edited; this register is the living document.

## Vocabulary (UI wording only)

| UI says | means | note |
|---|---|---|
| Workflows | pipelines | API/spec vocabulary unchanged |
| Steps | node templates | spec 01:17 concept; registry does not exist yet |
| Threads | one-off conversations | API stays `conversations`; `origin=manual` = one-off |
| Take control | takeover | ADR-0043 workbench / ADR-0016 §5 semantics |

Rule: real data only. Where the backend cannot supply something, render an honest empty /
"not available yet" state and record the gap here. Never fake counts, "verified" or
"observed".

## Decisions (product owner, 2026-10-20)

- **GitHub token in the sandbox** — agents may hold a GitHub token (via their profile's
  account/secrets) and push / open PRs themselves. **No Publish step in the step picker**
  (the kind stays in the YAML catalogue; it can return later as an optional step). → ADR-0045.
- **Tree is the default sidebar mode** — the `PROJECTS` tree (all projects, repos nested) is
  the default; the project switcher is an optional per-user setting. The README decision
  table beats the turn-3 artboard (3g), which draws the switcher as the default.
- **Take control keeps the existing takeover semantics** — takeover *interrupts the current
  attempt* and pauses the run with `human_takeover`; hand-back *re-runs the same step* (new
  attempt of the interrupted node, `retry.go:503-555`). The 5c confirm copy ("pauses before
  its next step … the loop continues from `test`") is rewritten to say so; true
  pause-before-next-step is a recorded gap (ADR register below).
- **Phase 1 `/p/:project/:repo`** — redirects to the project page; a dedicated repo page
  (status, workspaces, issues) is later work.

## ADR register

Updated 2026-10-21 (post-`6222d01`, plus the in-flight working tree). "Shipped" cites the commit that landed it.

| ADR | Topic | Status | Motivated by |
|---|---|---|---|
| ADR-0045 | Agent-held GitHub token in the sandbox (no Publish step in the picker; agent pushes/opens PRs); amends spec 05:19 / :66 / :70; egress stays ADR-0035 (per-profile `network.allow_domain`) | **Accepted** (2026-10-20); UI side shipped (`5198c90` picker, `126af18`, `6222d01` draft-PR prompt) | [profiles §4.1](gaps/profiles.md), [threads §4.1](gaps/threads.md), [inbox-ops §4.1](gaps/inbox-ops.md), [library §4.1](gaps/library.md) |
| ADR-0046 | User preferences: `layout` + assistant `trust_level`; `GET/PATCH /me/preferences`; display-only, authorizes nothing | **Accepted — shipped** (`80033b6`, migration 00008) | [shell §3](gaps/shell.md), [assistant §3](gaps/assistant.md), [inbox-ops §3](gaps/inbox-ops.md) |
| ADR-0047 | Cross-project reads: `GET /runs` (top-level steps from the pinned revision, one query) / `approvals` / `conversations`, scoped per membership | **Accepted — shipped** (`80033b6`) | [home-board §3 (U1)](gaps/home-board.md) |
| ADR-0048 | Org-level event stream `GET /api/v1/events`, `Last-Event-ID` resume; client `useOrgEvents` | **Accepted — shipped** (`80033b6`) | [shell §3](gaps/shell.md), [home-board §4.3](gaps/home-board.md) |
| ADR-0049 | Node-template (Step) registry + versioning — immutable revisions, `slug@semver` refs fail-closed at compile, usage refs at publish, "edit for all" → new revision + adopt drafts — and workflow folders (`pipelines.folder`) | **Accepted — shipped** (`3349840` part 1; `80033b6` + `6222d01` part 2) | [library §4.2](gaps/library.md), [library §3](gaps/library.md) |
| ADR-0050 | Assistant v2 — persisted conversations/messages/changes + undo, multi-turn questions, trust-level gating in the tool loop; amends ADR-0034 | **Accepted (design only)** — storage + API + popover shipped (`c3cf02f` ADR, `6222d01`, migration 00010); tool-loop gating **in progress** (be-as-loop) | [assistant §4](gaps/assistant.md) |
| ADR-0051 | Launcher registry + observed-capability evidence: `GET /api/v1/launchers`; `result` ONLY from recorded probe evidence, else `not_tested` | **Accepted — shipped** (`80033b6`, `acp-observed.json` transcribed from recorded probes only) | [profiles §4.2](gaps/profiles.md), [workbench §4.2](gaps/workbench.md) |
| ADR-0052 | Inbox summarization pass — `POST /approvals/{id}/summary` → `{summary, actions:[{label,intent,risk}]}` (+ free-text interpretation); model writes, human decides | **Accepted — shipped** (`6222d01`) | [inbox-ops §3 (W1/W2)](gaps/inbox-ops.md), [home-board §3](gaps/home-board.md) |
| ADR-0053 | Run from a thread branch — `RunCreate.source`, the thread branch as pinned run base, `handoff_summary` input, run↔thread link | **Accepted — shipped** (`6222d01`, migration 00011) | [threads §3 (W4b)](gaps/threads.md) |
| ADR-0054 | Server-side APM lock digest — "Lock it" (`POST /agent-profiles/{id}/apm/lock`); the digest is pasted by hand today | **Accepted (design; implementation later)** — not implemented, UI renders the honest "paste it by hand" state | [profiles §3 (W7)](gaps/profiles.md) |
| ADR-0055 | Pause-before-next-step — takeover pauses at a step boundary (5c semantics); today it interrupts the current attempt | **Proposed (evaluated and deferred)** — the redesign keeps the current interrupt-and-rerun semantics and says so in the confirm card (`126af18`) | [workbench §4.1](gaps/workbench.md) |
| (next number) | Worker identity in the browser — worker name on attempt lines; amends ADR-0016 §8 | **planned — not started** (reason: `worker_id` may never appear in a browser-facing body; the UI therefore renders no worker name at all — `RunHeader.tsx:15`; the amending ADR is only needed if a name is ever exposed) | [workbench §4.2](gaps/workbench.md) |

## Per-phase table (build order: `GOAL.md` phases 1–9)

Short bullets, linked to the report section that carries the evidence. "Needs backend" items
block the real version of a feature; the third column is what must render meanwhile.

| Phase | UI on existing API | Needs backend | Honest empty states |
|---|---|---|---|
| **1 Shell** [shell §3](gaps/shell.md) | Sidebar v3 from `ds/` primitives; old-route redirects (`/workflows*`, `/profiles`, `/p/*`, `/runs/:id`); live flags via per-project SSE fan-out + `lib/attention.ts` fallback; Ask placement; `esc`/focus trap | user-prefs store + `GET/PATCH /me/preferences` (ADR-0046); org-level stream (ADR-0048; fan-out fallback); folder entity for sidebar Workflows | `Steps (0)` and link-only Workflows until the template store + folders land; muted flag slots from the same source as Inbox (never `! 0`); repo flags mirror the project flag | 
| **2 Home + Board** [home-board §3](gaps/home-board.md) | Home counts from `lib/attention.ts`; run drawer (`/runs/{id}`, `/nodes`, `/events`, approvals); `mine` via `triggered_by`; Approve / Retry-from-step / Read plan / Fix the workflow (all exist); `ds/ProgressStrip` J/K already built; Start-run picker → `POST /projects/{p}/runs` | cross-project board runs endpoint (ADR-0047) with per-step progress aggregated **per step template** (loops aggregate, not per execution); later: model summaries, issue/scheduled triggers | one-line empty copy per column + `Start run`; `from issues` / `scheduled` chips disabled (ADR-0031: "not a trigger"); the static gate `summary` labeled "from workflow", never "written by the model"; `✓ done` instead of a PR number |
| **3 Run workbench** [workbench §3](gaps/workbench.md) | ⤢ full-screen + step strip (`?full=1`); tab set with Artifacts (client-side count); take-control confirm card with the real semantics; tool-row timing from `occurred_at`; header meta from `RunDetail` | worker name (ADR-0016 §8 amendment); PROMPT card (node inputs not exposed, only `inputs_digest`); diffstat (no structured event field); started-by (no creator on `RunDetail`) | `attempt k of m` only — never a placeholder `w-1`; timing only, no diffstat parsed out of prose; PROMPT card only when the seeded message exists; artifacts count = client-side sum of `artifact_refs`, labeled "referenced" |
| **4 Library** [library §3](gaps/library.md) | `/workflows*` rename + redirects; 3a rows (revision chip, step chain, assignment fan-out, cron/manual trigger, open draft, client-side duplicate); editor chrome tabs; step picker (no Publish, 5 kind cards); new-agent-step inspector (SUGGESTED default, sandbox status via `/system/sandbox` join) | node-template registry + versioning; workflow folders; later: edit-for-all via drafts, server-side duplicate endpoint | Steps page = static `STEP_LIBRARY` catalogue with `—` version/usage + M5 note; YOUR SAVED STEPS 0 items; manual/cron only — no `label:ready`; single `✓ PUBLISHED rN` chip (no BETA/STABLE); the real editor name, never "by assistant" |
| **5 Agent profiles** [profiles §3](gaps/profiles.md) | `/profiles` list/detail + `/agents` redirect; sandbox chips via `/system/sandbox` + registry set; account section via `allowed_agent_profile_ids`; APM pin (exists; digest pasted by hand); New-profile dialog with 5 agent cards | ADR-0045 (GitHub token + egress allowlist); server-side APM digest ("Lock it") + contents listing; profile usage endpoint; profile versioning (ADR-0030) | pi / antigravity cards read "no launcher registered" — never green "verified"; APM contents "not available yet"; usage "not available yet", never "0"; no version glyph until the ADR |
| **6 Threads** [threads §3](gaps/threads.md) | wording rename (API stays `conversations`); header meta (repo + age); WORKSPACE/ARTIFACTS/NEXT rail; permission-card restyle (feature exists, ADR-0039); hand-to-workflow dialog once the backend lands | artifact `conversation_id` filter; run-from-branch ADR (`RunCreate.source` + base, `runs.source_conversation_id`); draft PR (ADR-0045 + push integration) | NEXT panel omits "Open a draft PR" until the backend lands; clean-branch handoff says "starts from the default branch"; plan summary prefilled from the last agent message — no model label unless the model produced it |
| **7 Assistant v2** [assistant §3](gaps/assistant.md) | 400px popover shell (⌘K, `esc`, context chip); mic via Web Speech (hidden when unsupported); follow-up question widget (reply sent as plain text); expanded 680px view; "FOR THIS PAGE" chips only where the six existing tools + ADR-0044 back them | ADR amending ADR-0034 + tables (conversations/messages/changes); multi-turn ask; change log + undo endpoints; trust level in the tool loop (ADR-0046 route); `assistant.*` journal events | change chip is in-session only ("undo works until you leave the page") until the backend lands; mic button absent when `webkitSpeechRecognition` is missing; footer line ("just for you · never reads secret values …") is true by construction |
| **8 Inbox + approvals** [inbox-ops §3](gaps/inbox-ops.md) | 4g approval detail (plan.md inline via `/artifacts/{id}/content`); phone cards (44px buttons, 2-line clamp); note field on decision rows (`comments` already on the wire); inline permission decide + named-node retry (`node_instance_keys`) | summarization pass (`/approvals/{id}/summary`, `/interpret`); `/settings/:tab` + trust-level persistence (ADR-0046); question-kind inbox items | FILES IT WILL TOUCH omitted without a real manifest; on `503 assistant_not_configured` fall back to the gate's own `summary` + "model summaries not configured"; no fabricated question items — only `approval|permission|failed` |
| **9 Operations + settings** [inbox-ops §3](gaps/inbox-ops.md) | health line + merged workers table (existing endpoints); static capability matrix from `docs/compatibility/ACP.md` with probe date + link; Settings → Layout/Assistant tabs; interrupted callout from `lease_expirations` | `GET /system/interrupted` (names actual attempts for the 4h callout); probe-results API (later); preferences persistence (ADR-0046) | no interrupted callout at zero expirations; `not tested` default matrix cells — never prefilled PASS; trust options carry the "nothing to gate yet" note |

(Phase 10 — assistant tours, `{route, targetSelector, title, body}` spotlight steps, is a later phase; [assistant §1](gaps/assistant.md) marks them out of scope for phases 1–9.)

## Conflicts with spec / ADRs (found by the reports)

One line each; file:line quoted as the reports quote it.

1. **3g artboard vs tree default** — 3g draws the switcher as default; the later README decision table makes the tree the default. — **Resolved: tree** (shipped; switcher is a per-user setting, `6222d01`). — [shell §4.1](gaps/shell.md)
2. **Workbench URL params** — design `?step=&iter=&full=1` vs ADR-0043 §6 `?view=…&node=…&instance=…`. — **Resolved: both** — `lib/routes.ts` keeps the ADR-0043 `view`/`node`/`instance`/`attempt`/`scopes` state and adds `?full=1` for the full-screen step strip; legacy permalinks keep their view (`6222d01`). — [shell §4.2](gaps/shell.md), [workbench §4.3](gaps/workbench.md)
3. **5c copy vs takeover reality** — "pauses before its next step … the loop continues from `test`" vs accepted behavior: the attempt is interrupted and the run pauses; hand-back re-queues the interrupted node (`retry.go:472-487`, `retry.go:503-555`, ADR-0016 §5). — **Resolved by decision: keep the semantics, rewrite the copy** (two-step confirm card, `126af18`); 5c semantics = ADR-0055 (Proposed, deferred). — [workbench §4.1](gaps/workbench.md)
4. **`worker w-1` (4e) vs ADR-0016 §8** — "`worker_id` … never appear in a browser-facing body" (`ADR-0016-….md:125`). — **Resolved (render side): no worker name is rendered** — header shows `by <name>` only when a journal frame names the actor (`RunHeader.tsx:6-15`); exposing a worker name still needs the planned ADR. — [workbench §4.2](gaps/workbench.md)
5. **GitHub token vs spec 05** — `05-workspaces-security-secrets.md:19` "Do not automatically push/merge changes", `:66` "prefer a restricted broker/token over long-lived raw secrets", `:70` "Configure separate commands/nodes for commit, push, draft PR". — **Resolved: ADR-0045 Accepted** (token in-sandbox, agent pushes/PRs, no Publish step in the picker). — [profiles §4.1](gaps/profiles.md), [threads §4.1](gaps/threads.md), [inbox-ops §4.1](gaps/inbox-ops.md), [library §4.1](gaps/library.md)
6. **Codex "✓ sandbox verified" (4c/5b)** — `docs/compatibility/SANDBOX.md:372-374`: "One launcher (`claude`) … Codex was not tested"; ADR-0036 preapproval is claude-only. — **Resolved: ADR-0051 evidence-backed cells** — `result` comes only from recorded probe evidence; unobserved render `not tested` / muted "status not available yet", never green. — [profiles §4.2](gaps/profiles.md)
7. **Profile `v3` / `Save as v4` vs ADR-0030:62** — "No optimistic `version` token"; versioned profile history is a new persisted-state surface → ADR. — **Unresolved** — no version glyph in the UI today; the ADR is still to be written.
8. **"egress allowlist from the project" (4c) vs ADR-0035** — the allowlist is worker/deployment-level configuration, not a project setting; a security-semantic change. — **Resolved: the UI shows no egress setting** — ADR-0045 cites ADR-0035 (per-profile `network.allow_domain`, operator-controlled); no project-level knob exists or is drawn.
9. **Pi card (5b) vs launcher registry** — no `pi` entry (`launchers.go:77-110`); `docs/compatibility/ACP.md:25` "no ACP adapter for `pi` on this host"; POST of an unregistered id is accepted today and fails only at launch. — **Resolved: ADR-0051** — `GET /launchers` always carries the five ids; unregistered launchers render "no launcher registered" and the New-profile dialog disables the card with that reason.
10. **`from issue #512` + `from issues`/`scheduled` chips vs ADR-0031** — `openapi.yaml:545`: the issues route "is not a trigger"; `runs` has no trigger-source column. — **Resolved: chips disabled with the reason** — "not available yet" (`Board.tsx:204,235,243`); no trigger-source data is faked.
11. **Model-written summary / buttons vs ADR-0034** — the broker is "one bounded turn … read-only … nothing is stored" (`openapi.yaml:3804-3820`); the gate `summary` is static author text (`advancer.go:823`). — **Resolved: ADR-0052** — model summaries only via the summarization pass; the gate's own static text is labelled as its own, never "written by the model".
12. **Assistant persistence vs ADR-0034:51** — "v1 stores nothing" vs spec 08:40 "Persist assistant transcript and action trace"; the confirmation gate and change log must be server-side. Also ADR-0034 is still Status: Proposed (`ADR-0034-….md:4`) although implemented. — **Resolved (design): ADR-0050** — persistence + change log + undo shipped server-side (`6222d01`); tool-loop gating in progress. *Remaining:* ADR-0034's status line was not updated in this wave.
13. **Decider note (3f)** — the reply "goes to implement as a note on the plan" vs `comments` "never enters the journal" (`openapi.yaml:3723`). — **Unresolved — default kept: the reply stays a note** (rendered as such, never claimed to enter the journal). — [inbox-ops §4.3](gaps/inbox-ops.md)
14. **PERMISSION cards vs controller-only decide** — `openapi.yaml:1428` "Controller only (409 …)". — **Resolved: non-controllers get "Open to decide"**, never buttons that would 409 (`6222d01`). — [inbox-ops §4.4](gaps/inbox-ops.md)
15. **`inboxItem.kind: 'question'` has no wire** — approval `kind` is only `pipeline_gate | promotion_deferred` (`openapi.yaml:8030`). — **Unresolved — default kept: no fabricated question items**; Inbox renders only `approval|permission|failed`.
16. **`draft #12 · by assistant`** — drafts carry only `edited_by` (a user id); no assistant-vs-human identity is persisted. — **Resolved: never "by assistant"** — the real `edited_by` name is shown (`Library.tsx:13,1028`).
17. **Branch `thread/<slug>` (4f/5d)** — the real ref is the local mirror branch `refs/heads/<conversation>/<repo>` (`workspace.go:350`). — **Resolved: display-only label** — "starts from the default branch" copy, no upstream claim (`6222d01`). — [threads §4.5](gaps/threads.md)
18. **"Don't poll" vs stream topology** — the only streams are per-project (`openapi.yaml:685`); the Inbox polls today (7.5 s, `Inbox.tsx:57`); an org-wide stream is a new public API. — **Resolved: ADR-0048** — `GET /api/v1/events` shipped (`80033b6`) and the sidebar flags run off it (`useOrgEvents`, no polling).
19. **One segment per step vs loops** — a loop node yields many executions; the board endpoint must aggregate per step template or the `2/4` fraction breaks. — **Resolved: ADR-0047** — `steps` are the TOP-LEVEL nodes of the pinned revision in definition order, state mapped from node executions in one query (`80033b6`).

No conflict found (per the reports): dropping the top app bar is permitted (spec 10:9, :79 — navigation is the designer's); the 4e read-only pinned graph matches ADR-0043; the thread handoff touches no revision immutability ([threads §4.3](gaps/threads.md)); `origin=manual` permission semantics match ADR-0039 / ADR-0016 §5 ([threads §4.4](gaps/threads.md)).

## Status log

Updated 2026-10-21. "Shipped" cites the commit that landed it (`6222d01` = app-shell phases 1–6 +
backend for 4–8; `80033b6` = backend batch: prefs, cross-project reads, org stream, launchers, step
registry p1; `3349840`/`c3cf02f`/`5198c90`/`0c42aec`/`126af18`/`cf5af0e`/`8db926c` = ADRs + focused UI).
In progress at time of writing: assistant v2 tool loop with trust gating and undo (be-as-loop, uncommitted
in the working tree) and the acceptance suites.

### Phase 1 — shipped / stubbed / next

**Shipped** (`80033b6`, `6222d01`): Sidebar v3 (`components/Sidebar.tsx`) — cross-project nav (Home,
Inbox, Board, Threads), LIBRARY (Workflows, Steps, Agent profiles), user footer, phone off-canvas
drawer; live flags from `GET /api/v1/runs` + `/approvals` + the org SSE stream (`useOrgEvents`,
ADR-0048 — no polling); PROJECTS tree default (all projects, repos nested) with the switcher as a
per-user setting, SVG chevrons, persisted expand state; canonical routes + every old-route redirect
(`lib/routes.ts`; `/p/:projectId/:repo` → `/p/:projectId`, `/agents` → `/profiles`); Settings →
Layout and Assistant on `/settings/:tab` (ADR-0046); backends: `/me/preferences` (migration 00008),
cross-project reads (ADR-0047), org stream (ADR-0048).

**Stubbed / honest empty states**:
- Sidebar flag slots are driven by the same cross-project reads as Home/Inbox — never a `! 0`
  (flag rows render only for real data; `lib/sidebarFlags.ts`).
- `GET /runs` 404 on an old image: Home renders "not available yet — this server build predates the
  cross-project reads the briefing needs" (`Home.tsx:102`); the ops interrupted callout uses the same
  404 → "not available yet", not an error state (`InterruptedCallout.tsx:36`).
- The phase-1 stubs "`Steps (0)` and link-only Workflows" are now **shipped** — the Steps page and
  Workflows index are real (phase 4 below).

**Next:** dedicated repo page (`/p/:p/:r` currently redirects; status, workspaces, issues is later
work per the Decisions section).

### Phase 2 — shipped / stubbed / next

**Shipped** (`6222d01`): Home briefing — counts, decision callouts (confirm before approve),
running-now with per-step progress (ADR-0047 `steps`), recent threads; Board — five state columns,
group-by, filters, 440px run drawer (`components/board/*`); `mine` via `triggered_by`; Start-run
picker → `POST /projects/{p}/runs`; Approve / Retry-from-step / Read plan / Fix the workflow.

**Stubbed / honest empty states**:
- `from issues` / `scheduled` filter chips are **disabled with the reason** — `runs` has no
  trigger-source column and the issues route "is not a trigger" (ADR-0031);
  `title="not available yet"` (`Board.tsx:204,235,243`).
- One-line empty copy per column + `Start run`.
- The pending gate shows its own static `summary` — never labelled "written by the model".
- Run drawer "Ask about this run…" composer is **disabled with that reason** on `503
  assistant_not_configured` — never a fake answer (`RunDrawer.tsx:492`).
- `✓ done` instead of a PR number (no draft-PR link from the board yet).

**Next:** issue/schedule triggers as run sources (needs an ADR amending ADR-0031); model summaries
on board rows beyond the approval page.

### Phase 3 — shipped / stubbed / next

**Shipped** (`0c42aec`, `126af18`, `6222d01`): workbench tab set (Graph/Timeline/Artifacts/
Diagnostics) with Artifacts (client-side count, labelled "referenced"); header meta from `RunDetail`
(repo pinned, age, `by <name>` only when the journal names the actor); ⤢ full screen + step strip
(`?full=1`, `StepStrip.tsx`); two-step take-control confirm card stating the **real** semantics — the
current attempt stops and the run pauses; hand-back re-runs the same step as a new attempt
(`126af18`, ADR-0055 recorded); tool-row timing from the call's first-to-terminal `occurred_at`
(`<1s`, `14s`, `1m 05s`, `1h 05m`, `● running` while open; `0c42aec`).

**Stubbed / honest empty states**:
- **Worker names hidden** — `worker_id` never appears in a browser-facing body (ADR-0016 §8);
  `by <name>` renders only when a `run.created`/`run.started` frame names the actor
  (`RunHeader.tsx:6-15`). `attempt k of m` is real — never a placeholder `w-1`.
- **No diffstat** — timing only; nothing is parsed out of prose (`0c42aec`).
- PROMPT card only when the seeded message exists (node inputs are not exposed, only
  `inputs_digest`).
- Artifacts count = client-side sum of `artifact_refs`, labelled "referenced".

**Next:** worker-identity ADR (register, not started); a structured diffstat/event field; structured
node inputs for the PROMPT card.

### Phase 4 — shipped / stubbed / next

**Shipped** (`3349840`, `5198c90`, `80033b6`, `6222d01`): Workflows index — revision chip
(`✓ PUBLISHED rN`), step chain, assignment fan-out, cron/manual trigger, open draft, Duplicate,
Import YAML; **folders** via `pipelines.folder` (ADR-0049) with the `showWorkflowFolders` pref;
Studio header tabs + phone layout; step picker (4a) — START A NEW STEP cards (Agent, Command,
Approval, Loop, Workflow) then MORE, **Publish kinds hidden** from picker and palette per ADR-0045
(still in the YAML catalogue), the describe-it hint; new-agent-step inspector (SUGGESTED profile,
sandbox chips, + New profile…, "Also save as a reusable step" + `Save as step` — 4b, unchecked
default, `StudioInspector.tsx:383`); **Steps page on the real step registry** (ADR-0049) —
`USED IN N WORKFLOWS` (`StepDetailPanel.tsx:146`), edit for all → new immutable version + adopt
drafts (never rewrites a published revision), duplicate.

**Stubbed / honest empty states**:
- Single `✓ PUBLISHED rN` chip — **no BETA/STABLE channels** (M6 vocabulary the wire doesn't carry;
  no amber dual chip; `WorkflowRow.tsx:8-9`).
- **Never "by assistant"** — drafts show the real `edited_by` name (`Library.tsx:13,1028`).
- No Publish card in the step picker (ADR-0045); no `label:ready` — manual/cron only.
- The phase-4 stub (static `STEP_LIBRARY` catalogue with `—` version/usage + M5 note) is
  **superseded by the real registry** (`80033b6` + `6222d01`).

**Next:** server-side duplicate endpoint (client-side duplicate for now); `label:ready` triggers;
BETA/STABLE if M6 lands.

### Phase 5 — shipped / stubbed / next

**Shipped** (`80033b6`, `6222d01`): profiles list/detail (`/profiles`, `/agents` redirect);
sandbox/readiness chips **evidence-backed** from `GET /api/v1/launchers` (ADR-0051 — `result` only
from recorded probe evidence); New profile dialog with the **five agent cards** (claude, codex, pi,
antigravity + "Other ACP agent" catch-all), POSTs `/agent-profiles` itself, APM triple on create;
account section via `allowed_agent_profile_ids`; APM pin with digest display.

**Stubbed / honest empty states**:
- **pi / antigravity cards: "no launcher registered" — disabled with that reason**, never green
  "verified" (`NewProfileDialog.tsx:102,116,373`).
- `/launchers` 404 (old image): muted **"status not available yet"** chip (`lib/profiles.ts:83`,
  `ProfileDetail.tsx:198`, `NewProfileDialog.tsx:102,116,373`) — never a claim.
- **APM contents: "Contents available after the package is staged — not available yet."**
  (`ProfileDetail.tsx:302`).
- **APM "Lock it": disabled** — "computing the lock digest server-side is not available yet —
  paste it by hand" (`NewProfileDialog.tsx:601-608`); ADR-0054 is Accepted (design) and not
  implemented.
- **Profile usage: "usage tracking not available yet"** — never a fake "0"
  (`ProfileDetail.tsx:327`).
- Codex/other cells without recorded probe evidence read `not tested`, never "verified".

**Next:** ADR-0054 implementation (worker-side sandboxed resolve + stored digest); profile
versioning (conflict 7, ADR still to write); profile-usage endpoint.

### Phase 6 — shipped / stubbed / next

**Shipped** (`6222d01`, ADR-0053): Threads list (cross-project, `/threads`) + thread page with the
WORKSPACE / ARTIFACTS / NEXT rail and header meta (repo + age, branch label display-only);
**Hand to a workflow** — run from the thread branch: `RunCreate.source`, the thread branch as the
pinned run base, `handoff_summary` input, run↔thread link (ADR-0053, migration 00011);
**"Open a draft PR"** — asks the agent per ADR-0045 (confirm card sends `DRAFT_PR_PROMPT`,
`Conversation.tsx:434-528`); wording rename (API stays `conversations`), permission-card restyle
(feature exists, ADR-0039).

**Stubbed / honest empty states**:
- **Artifacts by thread: "Not available yet — the artifact API cannot list just this thread's
  files"** (`Conversation.tsx:374`) — the rail says so instead of listing project files.
- **Draft PR is a prompt to the agent**: "A draft PR exists only [if the agent says so]" — no push
  integration yet (`Conversation.tsx:486`); non-controllers see "Take control to ask the agent"
  (`Conversation.tsx:502`).
- Clean-branch handoff copy: "starts from the default branch"; the `thread/<slug>` label is
  display-only (conflict 17 resolved).

**Next:** push integration for draft PRs (ADR-0045 delivery path); an artifact
`conversation_id` filter so the rail can list real files.

### Phase 7 — shipped / stubbed / next

**Shipped** (`c3cf02f`, `6222d01`): ADR-0050 (Accepted, design only at commit); **Assistant v2
storage + API** — conversations/messages/changes, per-change undo (inverse op for draft edits),
undo-all, `trust_level` read from prefs (migration 00010; `openapi.yaml:4652-4947`); assistant route
allowlist on the canonical routes; **UI** — the popover (⌘K, `esc`, context chip, expand to 680px),
`QuestionCard` (model follow-ups answered as plain text), `ChangeChip`, `TrustPill` (ask_all /
ask_risky / no_ask — "the pill never claims to gate anything itself"), mic via Web Speech
(`MicButton`/`ListeningBar`, `lib/speech.ts`), `ApprovalRequestCard`.

**In progress (uncommitted in the working tree at time of writing):** assistant v2 tool loop with
trust gating and undo (be-as-loop); the acceptance suites.

**Stubbed / honest empty states**:
- Mic button absent when `webkitSpeechRecognition` is missing (`lib/speech.ts`).
- Runs and approvals are **not undoable** (ADR-0050 / `c3cf02f`) — their changes get no chip.
- The trust pill reports the choice; gating is server-side ("the pill never claims to gate anything
  itself", `TrustPill.tsx:10-11`).

**Next:** land the tool-loop trust gating + undo (be-as-loop); `assistant.*` journal events.

### Phase 8 — shipped / stubbed / next

**Shipped** (`6222d01`, ADR-0052): Inbox cards (`InboxCard`, risk styling, note field on decision
rows — `comments` already on the wire); approval detail page (`Approval.tsx`) — plan.md inline,
**model summaries via ADR-0052** (`POST /approvals/{id}/summary` → `summary` + action chips) and
free-text **interpret** (`/interpret`); inline permission decide + named-node retry
(`node_instance_keys`).

**Stubbed / honest empty states**:
- **FILES IT WILL TOUCH: "Not available yet — the API carries no diff or file manifest for this
gate."** (`Approval.tsx:461`).
- `503 assistant_not_configured`: **"Model summaries not configured on this server — the gate's own
text below."** (`Approval.tsx:231,251`) — the static gate `summary` is labelled as its own.
- No fabricated question items — only `approval|permission|failed` (conflict 15, unresolved by
  design).
- Decider note stays a note — `comments` never enter the journal (conflict 13, default kept).
- PERMISSION cards: non-controllers get "Open to decide", not buttons that would 409 (conflict 14).

**Next:** question-kind inbox items (needs the wire); a real file manifest/diff on gates.

### Phase 9 — shipped / stubbed / next

**Shipped** (`80033b6`, `6222d01`): Operations — health line, merged workers table (existing
endpoints), **interrupted callout** from `GET /api/v1/runs?status=interrupted` (real attempts +
stalled top-level steps), **agent × capability matrix from recorded probes only** (ADR-0051,
`CapabilityMatrix.tsx`); Settings → Layout / Assistant tabs on `/me/preferences` (ADR-0046).

**Stubbed / honest empty states**:
- Capability matrix cells default to **"not tested — no recorded compatibility probe"** — never
  prefilled PASS (`CapabilityMatrix.tsx:46,126`); observed cells carry the evidence path or probe id.
- Interrupted callout on a 404 (old image): "not available yet", not an error
  (`InterruptedCallout.tsx:36`); nothing renders at zero interruptions.
- Settings: **"Not saved: this server doesn't store preferences yet. The choice applies for this
  session."** when the endpoint 404s (`settings/Layout.tsx:165`, `settings/Assistant.tsx:49`).
- Trust options carry the "nothing to gate yet" note until the tool loop lands.

**Next:** probe-results API beyond the transcribed `acp-observed.json`; per-attempt granularity for
the interrupted callout.
