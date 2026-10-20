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

| ADR | Topic | Status | Motivated by |
|---|---|---|---|
| ADR-0045 | Agent-held GitHub token in the sandbox (no Publish step in the picker; agent pushes/opens PRs); amends spec 05:19 / :66 / :70 | in progress | [profiles §4.1](gaps/profiles.md), [threads §4.1](gaps/threads.md), [inbox-ops §4.1](gaps/inbox-ops.md), [library §4.1](gaps/library.md) |
| ADR-0046 | User preferences: `layoutPrefs` + assistant trust level; display-only, authorizes nothing | in progress | [shell §3](gaps/shell.md), [assistant §3](gaps/assistant.md), [inbox-ops §3](gaps/inbox-ops.md) |
| ADR-0047 | Cross-project reads: board runs list with embedded per-step progress, scoped per membership | in progress | [home-board §3 (U1)](gaps/home-board.md) |
| ADR-0048 | Org-level event stream for live cross-project flags/boards; per-project SSE fan-out is the fallback | in progress | [shell §3](gaps/shell.md), [home-board §4.3](gaps/home-board.md) |
| (next number) | Node-template registry + versioning — Steps page, saved steps, "edit for all → version x.y.z" (spec 01:17, 03:33; M5 gate at `m4api.go:979-984`) | planned | [library §4.2](gaps/library.md) |
| (next number) | Workflow folders — 3a grouping, sidebar folders, `showWorkflowFolders` pref | planned | [library §3](gaps/library.md) |
| (next number) | Assistant persistence (conversations/messages), change log + undo, trust level in the tool loop — amends ADR-0034 | planned | [assistant §4](gaps/assistant.md) |
| (next number) | Inbox summarization pass — `POST /approvals/{id}/summary` → `{summary, actions:[{label,intent,risk}]}` (+ free-text interpretation) | planned | [inbox-ops §3 (W1/W2)](gaps/inbox-ops.md), [home-board §3](gaps/home-board.md) |
| (next number) | Run from a thread branch with seeded input + run↔thread link (`RunCreate.source`, `runs.source_conversation_id`) | planned | [threads §3 (W4b)](gaps/threads.md) |
| (next number) | Draft PR from a thread — push integration + token-in-sandbox delivery | planned | [threads §3 (W7)](gaps/threads.md) |
| (next number) | Server-side APM lock digest — "Lock it" (`POST /agent-profiles/{id}/apm:lock`); the digest is pasted by hand today | planned | [profiles §3 (W7)](gaps/profiles.md) |
| (next number) | Worker identity in the browser — worker name on attempt lines; amends ADR-0016 §8 | planned | [workbench §4.2](gaps/workbench.md) |
| (next number) | Pause-before-next-step — takeover pauses at a step boundary (5c semantics); today it interrupts the current attempt | planned | [workbench §4.1](gaps/workbench.md) |

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

1. **3g artboard vs tree default** — 3g draws the switcher as default; the later README decision table makes the tree the default. Resolved: tree. — [shell §4.1](gaps/shell.md)
2. **Workbench URL params** — design `?step=&iter=&full=1` vs ADR-0043 §6 `?view=…&node=…&instance=…`; needs an ADR amendment + legacy-param mapping so permalinks keep working. — [shell §4.2](gaps/shell.md), [workbench §4.3](gaps/workbench.md)
3. **5c copy vs takeover reality** — "pauses before its next step … the loop continues from `test`" vs accepted behavior: the attempt is interrupted and the run pauses; hand-back re-queues the interrupted node (`retry.go:472-487`, `retry.go:503-555`, ADR-0016 §5). Resolved by decision: keep the semantics, rewrite the 5c copy; 5c semantics become a planned ADR. — [workbench §4.1](gaps/workbench.md)
4. **`worker w-1` (4e) vs ADR-0016 §8** — "`worker_id` … never appear in a browser-facing body" (`ADR-0016-….md:125`); a worker name needs an ADR. — [workbench §4.2](gaps/workbench.md)
5. **GitHub token vs spec 05** — `05-workspaces-security-secrets.md:19` "Do not automatically push/merge changes", `:66` "prefer a restricted broker/token over long-lived raw secrets", `:70` "Configure separate commands/nodes for commit, push, draft PR". → ADR-0045. — [profiles §4.1](gaps/profiles.md), [threads §4.1](gaps/threads.md), [inbox-ops §4.1](gaps/inbox-ops.md), [library §4.1](gaps/library.md)
6. **Codex "✓ sandbox verified" (4c/5b)** — `docs/compatibility/SANDBOX.md:372-374`: "One launcher (`claude`) … Codex was not tested"; ADR-0036 preapproval is claude-only. Render "sandbox verified on this worker, no per-launcher evidence" (or amber). — [profiles §4.2](gaps/profiles.md)
7. **Profile `v3` / `Save as v4` vs ADR-0030:62** — "No optimistic `version` token"; versioned profile history is a new persisted-state surface → ADR. — [profiles §4.3](gaps/profiles.md)
8. **"egress allowlist from the project" (4c) vs ADR-0035** — the allowlist is worker/deployment-level configuration, not a project setting; a security-semantic change. — [profiles §4.4](gaps/profiles.md)
9. **Pi card (5b) vs launcher registry** — no `pi` entry (`launchers.go:77-110`); `docs/compatibility/ACP.md:25` "no ACP adapter for `pi` on this host"; POST of an unregistered id is accepted today and fails only at launch. — [profiles §4.5](gaps/profiles.md)
10. **`from issue #512` + `from issues`/`scheduled` chips vs ADR-0031** — `openapi.yaml:545`: the issues route "is not a trigger"; `runs` has no trigger-source column. — [home-board §4.1](gaps/home-board.md)
11. **Model-written summary / buttons vs ADR-0034** — the broker is "one bounded turn … read-only … nothing is stored" (`openapi.yaml:3804-3820`); the gate `summary` is static author text (`advancer.go:823`). — [home-board §4.2](gaps/home-board.md), [inbox-ops §4.2](gaps/inbox-ops.md)
12. **Assistant persistence vs ADR-0034:51** — "v1 stores nothing" vs spec 08:40 "Persist assistant transcript and action trace"; the confirmation gate and change log must be server-side. Also ADR-0034 is still Status: Proposed (`ADR-0034-….md:4`) although implemented. — [assistant §4.1-4.2](gaps/assistant.md)
13. **Decider note (3f)** — the reply "goes to implement as a note on the plan" vs `comments` "never enters the journal" (`openapi.yaml:3723`). Unresolved — default: keep it a note. — [inbox-ops §4.3](gaps/inbox-ops.md)
14. **PERMISSION cards vs controller-only decide** — `openapi.yaml:1428` "Controller only (409 …)"; non-controllers get "Open to decide", not buttons that 409. — [inbox-ops §4.4](gaps/inbox-ops.md)
15. **`inboxItem.kind: 'question'` has no wire** — approval `kind` is only `pipeline_gate | promotion_deferred` (`openapi.yaml:8030`). — [inbox-ops §4.5](gaps/inbox-ops.md)
16. **`draft #12 · by assistant`** — drafts carry only `edited_by` (a user id); no assistant-vs-human identity is persisted. — [library §4.4](gaps/library.md)
17. **Branch `thread/<slug>` (4f/5d)** — the real ref is the local mirror branch `refs/heads/<conversation>/<repo>` (`workspace.go:350`); display-only label, no upstream claim. — [threads §4.5](gaps/threads.md)
18. **"Don't poll" vs stream topology** — the only streams are per-project (`openapi.yaml:685`); the Inbox polls today (7.5 s, `Inbox.tsx:57`); an org-wide stream is a new public API (ADR-0048). — [home-board §4.3](gaps/home-board.md), [shell §2](gaps/shell.md)
19. **One segment per step vs loops** — a loop node yields many executions; the board endpoint must aggregate per step template or the `2/4` fraction breaks. — [home-board §4.4](gaps/home-board.md)

No conflict found (per the reports): dropping the top app bar is permitted (spec 10:9, :79 — navigation is the designer's); the 4e read-only pinned graph matches ADR-0043; the thread handoff touches no revision immutability ([threads §4.3](gaps/threads.md)); `origin=manual` permission semantics match ADR-0039 / ADR-0016 §5 ([threads §4.4](gaps/threads.md)).

## Status log

### Phase 1 — shipped / stubbed / next
in progress.

### Phase 2 — shipped / stubbed / next
not started.

### Phase 3 — shipped / stubbed / next
not started.

### Phase 4 — shipped / stubbed / next
not started.

### Phase 5 — shipped / stubbed / next
not started.

### Phase 6 — shipped / stubbed / next
not started.

### Phase 7 — shipped / stubbed / next
not started.

### Phase 8 — shipped / stubbed / next
not started.

### Phase 9 — shipped / stubbed / next
not started.
