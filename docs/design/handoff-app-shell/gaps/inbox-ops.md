# Gap analysis — Inbox + approvals (phase 8) and Operations / Settings-Assistant (phase 9)

Area: artboards **4g** (approval detail), **2f/3f** (phone inbox), **4h** (Operations), **3g**
(Settings → Assistant tab only). Investigator: gap-inbox-ops. All "exists" claims cite `path:line`.

## 1. Design asks

**4g — Approval detail (desktop)**
- Full-width amber strip `expires in 22h · on timeout: fail` (4g).
- Model-written summary card "SUMMARY · WRITTEN BY THE MODEL" (4g, 3f; README:130).
- `plan.md` artifact rendered inline (4g) — currently the gate only links to it.
- "FILES IT WILL TOUCH" list with `+`/`~` marks and new dependencies flagged amber (4g) — implies a
  diff/manifest preview; README:131 calls it out.
- Right rail: **SUGGESTED** buttons, model-written `{label, intent, risk}` colored by risk
  (`refuse|destructive`→danger, `proceed`→primary, else secondary) (4g, README:131, README:162).
- **OR IN YOUR WORDS** textarea + Send; "you confirm whatever it proposes" (4g) — free text maps to a
  decider note, and (3f) to a model re-interpretation with `Change it` / `Approve with note`.

**2f/3f — Phone inbox**
- Cards: type chip (APPROVAL / PERMISSION / FAILED), repo, age, title, **2-line clamped model summary**,
  "More", two 44px model-labeled buttons (3f, README:130).
- PERMISSION card: "Deny / Allow once" inline (2f) — answer an ACP permission prompt from the inbox.
- FAILED card: "Retry from test" — retry a *named node*, not the whole run (2f).
- "3 running fine · see all" collapse strip (2f).
- Detail view: summary + free-text reply → model's proposed interpretation (3f; README:130).

**4h — Operations**
- Health line: replicas, queue depth, oldest lease (4h, README:134).
- "⊘ INTERRUPTED — outcome unknown" callout naming worker + run, with **Reclaim and retry** (4h).
- Workers table: status chip, **leases**, **sandbox mode**, heartbeat (4h) — richer than today's rows.
- Agent × capability matrix (ACP session, resume, permission prompts, nono required):
  `✓ observed` / `× not supported` / `not tested`, "from compatibility probes" (4h, README:136).

**3g — Settings → Assistant tab (only this part is mine)**
- Trust level `ask_all` / `ask_risky` / `no_ask`, "same three options as the pill", stored as a user
  preference and checked in the assistant's tool loop (3g, README:138–141, README:148–151).

## 2. Exists today

**Routes (ui/src/App.tsx)**: `/inbox` (App.tsx:75), `/ops` (App.tsx:189). **No `/settings` route at all**;
the only settings page is per-project (`/projects/:projectId/settings`, App.tsx:157).

**Inbox (ui/src/pages/Inbox.tsx, 456 lines)**: org-wide attention list. Polls every `INBOX_POLL_MS =
7_500` (Inbox.tsx:57) — no SSE consumption here, although project/conversation/run SSE streams exist
(`api/openapi.yaml:685`, `:1165`, `:3431`; client `ui/src/api/events.ts`). Sections: NEEDS YOUR DECISION
(pending approvals, inline Approve/Reject — **no note field on the row**), STALLED (failed/interrupted
runs, inline Retry for `failed` only), CONVERSATIONS (pending-permission tag, **"Open" link only** —
answering a prompt lives on `pages/Conversation.tsx`, Inbox.tsx:348 comment), RUNNING fine strip.

**Approval gate API** (OpenAPI): `GET /projects/{id}/approvals` (openapi.yaml:3641),
`GET /approvals/{id}` (3672), `POST /approvals/{id}/decide` (3701) — `{decision, comments?, version}`
with CAS; `comments` ≤ 8 KiB (ApprovalDecide, openapi.yaml:8092); `409` carries the winner
(ApprovalConflictProblem, :8112). `Approval` (openapi.yaml:7991) carries `summary` (≤ 64 KiB,
gate text in full), `artifact_refs` (`{name, kind, sensitivity}` only — no diff/manifest),
`deadline_at`, `on_timeout` (`fail|cancel_run|expire`), `re_requested`, `state`, `decided_by/at`,
`version`. `kind` enum is only `pipeline_gate | promotion_deferred` (:8030) — **no `question` kind**
for inboxItem (README:162).

**Approval detail surface**: `ui/src/components/m4/ApprovalCard.tsx` (285 lines) already renders
summary, node key, roles, `on_timeout` words, **live countdown to deadline**, artifact evidence list
(plan.md by name/kind/sensitivity, :128–149), comment textarea, approve/reject with CAS, decided/denied
states. Used in `pages/RunInspector.tsx`, `components/workbench/WorkbenchDock.tsx`, M4Preview(Live).
`components/m4/PlanView.tsx` structurally renders the planner JSON inside the gate `summary`.
Artifact bytes are fetchable: `GET /artifacts/{id}/content` (openapi.yaml:2066, role-gated by
sensitivity, ADR-0020).

**Permission prompts**: `POST /conversations/{id}/permissions/{requestId}` (openapi.yaml:1413) —
`option_id` must be one the agent offered; **controller only** (409 otherwise), contributor+.
Pending prompts surface via `getConversation` `pending_permissions` (Inbox.tsx header doc).

**Retry**: `POST /runs/{id}/retry` (openapi.yaml:3376) — targets non-succeeded terminal node
executions or named `node_instance_keys[]`, `retry_context`, `continue_workspace` default (edits stay),
`409 run_not_retriable`. ADR-0037 (retry / unknown node execution 404).

**Operations page** (`ui/src/pages/Operations.tsx`, 342 lines): health/readiness cards (replica,
version, schema), `workers-table` (name, hostname, version, status `online|draining|offline`,
started, last heartbeat — from `GET /workers`, openapi.yaml:816; Worker schema :4899),
`SchedulerPanel` from `GET /system/scheduler` (openapi.yaml:3770; SchedulerStatus :8165 —
`attempts_by_status`, `oldest_queued_age_seconds`, `lease_expirations`, `max_retry_loop_depth`,
`waiting_approvals`, `queued_unbindable_runs`, per-worker `active_attempts/capacity`), a fixed
resource-limits notice, and `SandboxHealthPanel` (per-worker sandbox verdict, ADR-0019 D5).

**Interrupted evidence**: `run.interrupted` and `node.attempt.interrupted` event types
(openapi.yaml:3479, :3489; emitted by the reconciler, :3527); `SchedulerStatus.lease_expirations`
counts them. **No endpoint lists currently-interrupted attempts** — `GET /attempts/{id}` (openapi.yaml:
3603) is single-item, and workers have no per-worker attempt listing.

**Assistant**: `POST /assistant/ask` (openapi.yaml:3799, ADR-0034 — read-only tool broker, **nothing
persisted**, ≤ 8 tool calls, model at `COMMUNICATION_ASSISTANT_BASE_URL` + `COMMUNICATION_ASSISTANT_API_KEY`,
`internal/assistant/broker.go:58–70`) and `POST /assistant/draft-proposals` (openapi.yaml:3883,
ADR-0044 — one validated draft op, server never writes). **No summarization pass exists anywhere**
(grep `summar` in `internal/assistant`, `internal/api` finds only proposal-summary fields).
**No user-preference endpoint exists** (grep `prefs|preference|trust` in openapi.yaml: zero matches).

**Capability evidence**: `docs/compatibility/ACP.md` — matrix with PASS/FAIL/GAP per agent ×
capability, raw JSON in `docs/compatibility/probes/acp/`; `AgentProfile` docs say "capability evidence
lives in `docs/compatibility/ACP.md`" (openapi.yaml:5071). Spec 09 lists an `agent_capability_snapshots`
table but implements it folded into `acp_session_bindings` (spec 09:56–57 — live per-session rows only,
not a fleet matrix).

**ADR/spec anchors**: ADR-0019/0009 (sandbox), ADR-0020 (artifacts/sensitivity), ADR-0023 § 9
(approvals vs permissions, reclaim/lease semantics), ADR-0034 (assistant), ADR-0044 (draft proposals),
spec 08:11 (structured application tools incl. `approval.request`, `run.retry`, `question.ask`,
`ui.navigate` — "proposed domain action names, not currently implemented"), spec 08:40 ("Persist
assistant transcript and action trace").

## 3. Gap table

| item | kind | evidence / spec ref | size |
|---|---|---|---|
| Approval detail route/panel, 4g layout (amber strip, summary card, right rail) | UI on existing API | `GET /approvals/{id}` openapi.yaml:3672; ApprovalCard.tsx | M |
| Render `plan.md` artifact content inline | UI on existing API | `GET /artifacts/{id}/content` openapi.yaml:2066; sensitivity gates (ADR-0020) | S |
| FILES IT WILL TOUCH (+/~ list) | needs backend | no manifest/diff on any wire field; `artifact_refs` carries `{name,kind,sensitivity}` only (openapi.yaml:8022) | L |
| "new dependency flagged amber" | needs backend | no package.json parsing/diff anywhere; cannot be shown honestly | L |
| Model-written summary (inbox cards + 4g card) | needs backend + ADR | nothing exists; model path = `COMMUNICATION_ASSISTANT_BASE_URL` (broker.go:58); spec 08:38 "configurable OpenAI-compatible endpoint" | L |
| Model-written buttons `{label,intent,risk}` | needs backend + ADR | same summarization pass; risk→style mapping itself is UI-only (S) | L |
| Free-text reply → model interpretation → `Change it`/`Approve with note` | needs backend + ADR | no endpoint; nearest pattern: ADR-0034 broker + ADR-0044 validation; `comments` exists on decide (openapi.yaml:3701) | L |
| Note field on inbox decision rows (approve-with-note from the list) | UI-only | `ApprovalDecide.comments` already on the wire (openapi.yaml:8092); Inbox.tsx DecisionRow has none | S |
| Phone cards: 44px buttons, 2-line clamp, "More", type chips | UI-only | Inbox.tsx today is desktop rows | S |
| PERMISSION card inline Deny/Allow once | UI on existing API | `POST /conversations/{id}/permissions/{requestId}` (1413) needs `option_id` from the prompt; inbox fetches `pending_permissions` count only | S |
| "Retry from test" (named-node retry) | UI on existing API | `retryRun` `node_instance_keys` (openapi.yaml:3376); UI today sends `{}` | S |
| Interrupted callout (worker, run, age) + Reclaim and retry | needs backend | no "currently interrupted attempts" endpoint; only counters (openapi.yaml:8165) and events (:3489); Reclaim-and-retry ≈ `POST /runs/{id}/retry` (exists) | M |
| Workers table: leases column + sandbox mode per row | UI-only | merge `GET /workers` (816) + `SchedulerStatus.workers[]` (8165) + SandboxHealthPanel on worker id | S |
| Agent × capability matrix in /ops | needs backend (or UI-only static) | no API; docs/compatibility/ACP.md + probes JSON; spec 09:57 folded snapshots into session bindings; static table with date + source link is UI-only | S static / L API |
| `/settings/:tab` route + Assistant tab | UI + needs backend + ADR | no route (App.tsx), no preference endpoint; ADR-0043-class change for persisted state | M |
| Trust level gating assistant actions | needs backend + ADR | assistant currently read-only + never-writes (ADR-0034/0044); spec 08:11 lists mutating tools as *proposed* | M |
| Inbox live via event stream, no polling | UI-only | SSE streams exist (openapi.yaml:685/1165/3431; events.ts); Inbox polls (Inbox.tsx:57) | M |
| Deadline strip + "on timeout: fail" wording | UI-only | `deadline_at`/`on_timeout` on wire; countdown exists (ApprovalCard.tsx:108–111) | S |

## 4. Spec / design conflicts

1. **Agent-held GitHub token (PO decision) vs spec 05.** 4g's "then: implement → test → review →
   publish draft PR" and the "no Publish step in the step picker" decision amend
   `communication-spec/05-workspaces-security-secrets.md:19` ("Do not automatically push/merge
   changes"), `:70` ("Configure separate commands/nodes for commit, push, draft PR… External
   publication operations need idempotent tokens and post-crash reconciliation") and the credential
   class at `:45` ("Project/organization integration credentials — GitHub Apps/PATs/SSH deploy keys").
   Spec 05's own threat model ("For third-party credentials prefer a restricted broker/token over
   long-lived raw secrets") also argues the ADR must name the token's lifecycle. **ADR needed**
   (spec 05 amendment; also touches ADR-0018 secret materialization and ADR-0035 egress allowlist).
2. **Design's stateful, acting assistant vs ADR-0034.** 3g's trust levels + "every assistant mutation
   is recorded… undo" (README:153) and spec 08:40 ("Persist assistant transcript and action trace")
   contradict ADR-0034: "Nothing is stored: no table, no transcript, no action trace" (openapi.yaml
   :3831). Trust levels are meaningless until the assistant has mutating tools (spec 08:11 lists
   them as *proposed*, not implemented). **ADR needed** (amends ADR-0034; new table → also an ADR per
   AGENTS.md "persistence schema").
3. **Decider note vs downstream node.** 3f says the reply "goes to implement as a note on the plan",
   but the API says `comments` "is ≤ 8 KiB and **never enters the journal**" (openapi.yaml:3723) and
   nothing documents forwarding it to downstream node inputs. Design implies the note reaches
   implement. **Unresolved — see open question 1.**
4. **Permission cards vs controller-only decide.** 3f shows any inbox viewer "Deny / Allow once", but
   `decideConversationPermission` is controller-only (openapi.yaml:1428: "Controller only (409 with
   the current control otherwise)"). Non-controller viewers would get a button that 409s.
5. **`inboxItem.kind: 'question'` has no wire** — approval `kind` is only `pipeline_gate |
   promotion_deferred` (openapi.yaml:8030) and no question-attention endpoint exists.
6. **Aligned (no conflict)**: 4h "not tested" cells match AGENTS.md "must never be prefilled with
   PASS"; "uncommitted edits stayed on that host" matches `retryRun` `continue_workspace` default
   (openapi.yaml:3390) and spec 05's "user accepts retrying an interrupted node"; "It never reads
   secret values" matches ADR-0034/0018.

## 5. Honest empty states

- **FILES IT WILL TOUCH**: show "plan carries no file manifest — open plan.md" (or omit the section).
  Never render a +/~ list from anything but a real manifest.
- **Model summary/actions** (lab without `COMMUNICATION_ASSISTANT_BASE_URL`): fall back to the gate's
  own `summary` + the static Approve/Reject buttons, with one line "model summaries not configured"
  (the broker returns `503 assistant_not_configured` — name the cause, don't hide the card).
- **Capability matrix**: `not tested` is the correct default (docs/compatibility/ACP.md rule). A
  static rendering must carry the probe date and a link to ACP.md; a cell reads `✓ observed` only if
  the ACP.md row is PASS.
- **Interrupted callout**: zero lease expirations / no interrupted attempts → render nothing (empty
  is healthy); never invent an interrupted row from a stale heartbeat.
- **Trust level (until mutating assistant ships)**: show the three options with "assistant currently
  reads and drafts only — nothing to gate yet".
- **Question-kind inbox items**: don't fabricate them; only `approval|permission|failed` exist today.

## 6. Proposed work units

Contract-first order: backend/ADR units can run while UI units build against the OpenAPI diff.
Files in parentheses are what each unit owns.

1. **W1 — ADR + summarization pass** (needs ADR): draft `docs/adr/ADR-0045-*.md` (inbox/approval
   summarization: read-only broker path, per-gate caching keyed on gate `version`, never stored long-
   term, secret-scanned like `ask`); new `POST /approvals/{approvalId}/summary` returning
   `{summary, actions:[{label,intent,risk}]}`. Owns: `internal/assistant/summary.go`,
   `internal/api/assistant_summary.go`, `api/openapi.yaml` (assistant section), ADR file. **L. Parallel.**
2. **W2 — ADR + reply-interpretation endpoint**: `POST /approvals/{approvalId}/interpret`
   (free text → `{interpretation, proposed:{decision, comments}}`, validated against the gate;
   UI still calls `decide` itself — the model never decides). Same ADR family as W1 (or fold into
   W1's ADR). Owns: `internal/assistant/interpret.go`, `internal/api/assistant_interpret.go`,
   openapi. **L. Parallel with W1 after its ADR lands (or same ADR).**
3. **W3 — ADR + user-preference persistence**: `GET/PUT /api/v1/me/preferences`
   (`{trust_level, …layout slots for the shell worker}`, ADR covering both since it's one table),
   store migration + route. Owns: `internal/api/preferences.go`, store/migrations, openapi, ADR.
   **M. Parallel.**
4. **W4 — 4g approval detail page**: new `/approvals/:approvalId` route; 4g layout (amber strip,
   summary card consuming W1, `plan.md` inline via `GET /artifacts/{id}/content`, FILES IT WILL TOUCH
   as honest empty state, right rail: suggested buttons when W1 configured else Approve/Reject,
   "OR IN YOUR WORDS" → W2 interpret → `Change it`/`Approve with note`). Owns:
   `ui/src/pages/Approval.tsx`, `ui/src/pages/Approval.test.tsx`, testids `approval-detail-*`.
   **M. Parallel; route registration in `ui/src/App.tsx` serializes with the app-shell worker —
   hand the route block to the shell unit or land last.**
5. **W5 — Inbox card v2 (2f/3f UI)**: responsive 44px-button cards, 2-line clamp, "More", model
   summary slot (fallback text when W1 unconfigured), risk→style button mapping, note field on
   decision rows. Owns: `ui/src/pages/Inbox.tsx`. **M.**
6. **W6 — Inbox inline permission + named-node retry**: PERMISSION card fetching the pending
   prompt's `options[]` and calling `decideConversationPermission`; non-controller gets
   "Open to decide" instead of dead buttons (conflict §4.4); FAILED card "Retry from `<node>`"
   with `node_instance_keys`. Owns: `ui/src/pages/Inbox.tsx`. **S. Serial after W5 (same file).**
7. **W7 — Operations 4h**: health line (replicas/queue/oldest lease from existing two endpoints),
   merged workers table (status chip + leases + sandbox mode + heartbeat), interrupted callout
   (data: `SchedulerStatus.lease_expirations` > 0 → "N lease expirations since replica start; see
   run events" + deep link; full per-attempt callout needs W8), Reclaim-and-retry → run retry page.
   Owns: `ui/src/pages/Operations.tsx`. **M. Parallel with W5–W6 (different file).**
8. **W8 — interrupted-attempts endpoint (needs backend)**: `GET /api/v1/system/interrupted`
   (worker, run, node_instance_key, attempt_number, age — from `node.attempt.interrupted` /
   attempts table) so the 4h callout names the actual row. Owns: `internal/api/interrupted.go`,
   openapi, `ui/src/components/m4/…` callout component. **S–M. Serial after W7 for the callout
   markup; endpoint itself parallel.**
9. **W9 — capability matrix (static)**: component rendering the docs/compatibility/ACP.md cells
   (hard-coded with probe date + source link; `not tested` default; no PASS without the doc row).
   Owns: `ui/src/components/CompatibilityMatrix.tsx`, used from Operations. **S. Parallel.**
10. **W10 — Settings → Assistant tab**: `/settings/:tab` route, Assistant tab with trust pill
    (persisted via W3; gating applies when mutating tools exist — note that), empty-state honesty
    (conflict §4.2). Owns: `ui/src/pages/Settings.tsx`, App.tsx route (serial, late). **S. Serial
    after W3; route registration late (App.tsx shared with shell worker).**
11. **W11 — Inbox live updates**: replace the 7.5 s poll with the project/run/conversation SSE
    streams (existing `ui/src/api/events.ts`), keeping poll as fallback. Owns: `ui/src/pages/
    Inbox.tsx`, possibly `ui/src/api/events.ts`. **M. Serial last in the Inbox chain.**

Parallel groups: {W1→W2, W3, W4*, W7, W9} run concurrently; Inbox chain W5→W6→W11;
W8 endpoint ∥ UI; W10 last with the route. `*`W4's App.tsx edit is the only true cross-worker
serialization point.

## 7. Acceptance checks

Browser-testable against the real lab (testids in `ui/src/` naming convention `area-slug-<shortId>`):

1. **4g route**: create a gate (lab fixture pipeline), open `/approvals/<id>`: `approval-detail-
   deadline` text equals `GET /approvals/{id}` `deadline_at` formatted; strip says "on timeout: fail"
   iff `on_timeout === "fail"`.
2. **plan.md inline**: `approval-detail-plan` innerText byte-equals `GET /artifacts/{plan.md's id}/
   content` (fixture); a `restricted` artifact renders the sensitivity note, not content.
3. **Note on decide**: type "paid keys 300/min" into `approval-detail-note`, click approve;
   afterwards `GET /approvals/{id}` has `state=decided`, `decision=approved`, `comments` non-null,
   `version` = old+1; `approval.decided` event present with `comments_present: true`.
4. **Risk→style**: with the lab assistant configured, suggested actions render — each `refuse`
   action's button has the danger variant class, `proceed` primary, others secondary; clicking one
   only *prefills* the decide form (no state change until the user confirms).
5. **Inbox permission card**: start a lab conversation turn that prompts; card shows the prompt's
   real `options` labels; clicking the deny-kind option → `GET /conversations/{id}` no longer lists
   it as pending, and `permission_requests` row is `decided`.
6. **Named-node retry**: fail a fixture run at node `test`; "Retry from test" → API returns run with
   a re-queued attempt at `node_instance_key=test`, `run.retried` event emitted; other nodes'
   attempts untouched.
7. **Ops table counts**: `workers-table` row count == `GET /workers` items; per-row "active/capacity"
   equals `GET /system/scheduler` `workers[]`; heartbeat cell within 15 s of `last_heartbeat_at`.
8. **Capability matrix**: 4 columns × 3 agents; every `✓ observed` cell maps to a PASS row in
   docs/compatibility/ACP.md; `antigravity` row is 3× `not tested`; page shows the probe date.
9. **Model summary fallback**: with `COMMUNICATION_ASSISTANT_BASE_URL` unset, the summary slot shows
   the fallback line (503 named) and the card still offers static Approve/Reject; with it set,
   `SUMMARY · WRITTEN BY THE MODEL` is visible.
10. **Settings persistence**: pick "Ask for risky" in Settings → Assistant; reload; selection
    persists and `GET /api/v1/me/preferences` returns `trust_level: "ask_risky"`.
11. **Inbox liveness**: with the tab open and polling disabled in the test, a gate that goes pending
    (second lab client) appears within one event frame (< 2 s), not 7.5 s.

## 8. Open questions for the product owner

1. **Does the decider note reach the implement node?** 3f says the change "goes to implement as a
   note on the plan", but `decide` documents `comments` as a decider note that never enters the
   journal (openapi.yaml:3723). *Default: no — keep it a note; if it must flow, that's a pipeline
   runtime change (node input binding from `outputs`) and its own ADR.*
2. **Can non-controllers act on PERMISSION inbox cards?** The decide API is controller-only
   (openapi.yaml:1428). *Default: show the card, disable the buttons with "Open to decide" —
   don't relax the API in phase 8.*
3. **Capability matrix: static (from docs) or a new probe-results API?** *Default: static table
   with date + link now; a `probe_results` table/API later (avoids a schema ADR this phase).*
4. **Store model summaries or recompute per view?** ADR-0034 stores nothing; spec 08:40 wants
   persistence. *Default: recompute per load, cache per gate `version` in-process; revisit when the
   assistant-transcript ADR lands.*
5. **Persist the trust level now, before any assistant action can use it?** *Default: yes — one
   preferences ADR/endpoint now (layout prefs + `trust_level`), gate applies when mutating tools
   exist; avoids a second migration.*
