# Gap analysis — Phase 3: Run workbench (artboards 4e, 5c)

Scope: the run workbench (split graph + transcript, full-screen transcript, take control).
Built in issue #2: `docs/design/issue2-acceptance.md` A4–A6 (all PASS), ADR-0042/0043/0044.

## 1. Design asks

- **4e** — Header: title, status chip, meta `workflow #id · repo · revision r3 8f2c1a (pinned) · started by david 18m ago`, buttons `Fix the workflow…`, `Pause`, `Cancel run` (danger).
- **4e** — Tabs: `Graph`, `Timeline`, `Artifacts 2` (count badge), `Diagnostics`.
- **4e** — Split: read-only pinned graph (live status, iteration counter on loops, "edits go to a new draft" note) + 480px transcript: iteration tabs, `attempt 1 · worker w-1`, controller line, `PROMPT · from review iter 1` card, agent messages, tool-call rows (✓/● with **diffstat or timing**).
- **4e** — `Take control` button; composer disabled ("Only the controller can send prompts").
- **5c** — ⤢ full screen: graph collapses to a **strip of step cells** across the top (current raised), transcript centered ≤760px; `⤡ show graph` returns to split.
- **5c** — Two-step handoff confirm card: "TAKE CONTROL OF implement? … the loop continues from `test`" with `Take control` / `Just watch`.
- **README routing** — `/runs/:id` workbench with `?step=&iter=&full=1`.

## 2. Exists today

- **Route + URL state**: `/projects/:projectId/runs/:runId` → `ui/src/pages/RunWorkbench.tsx` (ADR-0043 decision 1, 6). URL params are `?view=graph|timeline|tree|diagnostics&node=<definitionNodeId>&instance=<nodeExecutionId>&attempt=<n>` with `?tab=` legacy mapping (`RunWorkbench.tsx:9-14`, `:57-75`). **No `full=1`, no `⤢` anywhere** (grep `ui/src` for `fullScreen|full=1` → none).
- **Tabs**: Graph / Timeline / Execution tree / Diagnostics (`RunWorkbench.tsx:60-64`, testids `workbench-tab-*`). Old inspector preserved as Diagnostics (ADR-0043 decision 5).
- **Split**: read-only React Flow graph with live status overlays, scope boxes with iteration/fan-out counts and selectors (iteration chips for `until`, item list for `for_each`), auto-select (A4/A6 acceptance; ADR-0043 decision 1, 4). Right dock resizable, default **440px** (`RunWorkbench.tsx:477`; testids `workbench-dock-*`).
- **Transcript**: shared `ui/src/components/conversation/AgentConversationPanel.tsx` (ADR-0043 decision 2): controller badge `controller-badge` with copy "You are in control" / **"Controlled by a pipeline run"** (`AgentConversationPanel.tsx:44-60`), `Take control` / `Return to factory` / `Stop` (`:158-196`), permission cards, composer **disabled for non-controllers with explainer** ("Only the controller (…) can send prompts. Take control to drive.", `:290-316`), and `Open full conversation` → separate page `/projects/:id/conversations/:cid` (`:535-544`).
- **Attempt/iteration UI**: attempt tabs in the dock (`data-testid="dock-attempt-N"`, `workbench/WorkbenchDock.tsx:226`), iteration picker on the `until` scope box (A6 evidence), `attempt k of m` lines.
- **Header verbs**: `ui/src/components/workbench/RunHeader.tsx` — breadcrumb, goal/slug, pinned-revision link, stream state, `Open pinned workflow`, **`New draft from this revision`** (line 132; **org-admin only** via `hasLibraryRole`, `ui/src/lib/pipeline/authoring.ts:25`), plus reused `Pause`/`Resume`/`Cancel`/`Retry` (`pages/RunInspector.tsx:555-558`).
- **Run-level Pause API — yes**: `POST /api/v1/runs/{runId}/pause` / `resume` / `cancel` (`internal/api/runs.go:570-572`; `api/openapi.yaml:3265/3300/3336`). `PauseRun` sets `paused_reason=manual` and "stops FUTURE scheduling only: live attempts keep their leases" (`runs.go:389-393`); `waiting_human`/already-paused/terminal refuse with `run_state_conflict`. Run statuses include `paused` with reasons `human_takeover | manual | worker_unavailable` (`internal/pipelines/runtime/state.go:36-47`). Events `run.paused` / `run.resumed` / `run.cancel_requested` (`runs.go:354`).
- **What takeover actually does** (the core question): it **interrupts the current attempt and pauses the run** — it does *not* pause "before the next step". `MemStore.MarkCancelledByHumanTakeover` (`internal/pipelines/runtime/retry.go:472-487`): *"the attempt closes interrupted{human_takeover} and the run pauses with that reason"* — pause first, then `Interrupt`. Hand-back: `ResumeFromHumanTakeover` (`retry.go:503-555`) lifts the pause and re-queues **the interrupted node once** with `retry_context` carrying `human_takeover: <intervention>` — the loop continues **from the same node** (a new attempt), not from the next node. ADR-0016 §5 (`docs/adr/ADR-0016-…md:96-101`): take-control CAS also sets `cancel_requested_at` on the running turn; permission prompts go to the current controller only. ADR-0043 addendum: return-to-factory while the human turn is still running → the retried claim *waits* (bounded) for the human turn, not fail. Acceptance proof: A5 evidence — "the run is paused for human_takeover (the attempt was interrupted)" and "a NEW attempt (attempt 2) of code_review was queued" (`issue2-acceptance.md:140-157`).
- **Tool-call rows**: `ui/src/components/Transcript.tsx` `ToolRow` (`:119-195`): kind, title, status chip, input/output behind a click. Events `conversation.tool.call` / `conversation.tool.update` each carry `occurred_at` (`ui/src/api/transcript.ts:366-395`; `:298`), so **per-call timing is derivable client-side**. No diffstat in any event payload or in `api/openapi.yaml`.
- **Artifacts data**: node executions/attempts expose `artifact_refs` (`ui/src/lib/pipeline/contract.ts:223,262,275,333`); `GET /api/v1/projects/{projectId}/artifacts` and `GET /api/v1/artifacts/{id}` (`openapi.yaml:2001-2034`); `ArtifactsPanel` is used on the Project page (`pages/Project.tsx:31`) but **not in the workbench** (no run-level artifact list endpoint — count would be a client-side sum over `artifact_refs`).
- **Vocabulary**: the workbench currently says *nodes* / *definition* / *pipeline* (spec vocabulary). The PO-approved UI renames (steps/workflows) are not applied here yet.

## 3. Gap table

| item | kind | evidence / spec ref | size |
|---|---|---|---|
| ⤢ full-screen mode + step strip + `?full=1` + `⤡ show graph` | UI-only (ADR-0043 decision 6 needs extending for the new param) | no `full` param/button in `ui/src`; today "full transcript" = separate page (`AgentConversationPanel.tsx:535`) | M |
| `?step=&iter=&full=1` param mapping (alias for `node=&instance=&view=`) | UI-only (alias) or ADR (break old links) | `RunWorkbench.tsx:9-14` (ADR-0043 d6) | S |
| Tab set Graph/Timeline/Artifacts/Diagnostics: add Artifacts tab + count, decide fate of Execution-tree tab | UI on existing API | `RunWorkbench.tsx:60-64`; `contract.ts:223`; `openapi.yaml:2001` | M |
| Header verb `Fix the workflow…` (rename of `New draft from this revision`; role widening?) | UI-only + product decision; role change needs ADR | `RunHeader.tsx:132`; `authoring.ts:25` (org-admin only) | S |
| Two-step take-control confirm card (`TAKE CONTROL OF …`, `Just watch`) | UI-only (no backend change: takeover already pauses run) | `takeControl.mutate` fires on first click, `AgentConversationPanel.tsx:158-162` | S |
| Tool-call row timing ("14s") | UI-only (derive from `occurred_at`) | `transcript.ts:366-395`; `Transcript.tsx:119` | S |
| Tool-call diffstat ("+38 −6") | needs backend / ACP (new event field) or fragile text parsing | no diffstat in `transcript.ts` / `openapi.yaml` | M |
| `attempt 1 · worker w-1` (worker name) | needs ADR — `worker_id` is deliberately never browser-facing | `contract.ts:240-245` (route 32 refuses `worker_id`); ADR-0016 §8 (`ADR-0016…md:125`) | S |
| `PROMPT · from …` card (seeded step input) | needs backend (node inputs not exposed — only `inputs_digest`) or transcript fallback | `contract.ts:204-230` (no `inputs` on node execution) | M |
| Header meta `started by <user>` | needs backend (`RunDetail` has no creator) or event-stream actor | `contract.ts:138-161` | S |
| Iteration *tabs* in transcript header (design shows them beside the node name) | UI-only restyle — data exists, today picked on the graph scope box | `WorkbenchDock.tsx:147` (`iterationOf`); A6 evidence | S |
| Composer disabled until control granted | **exists** | `AgentConversationPanel.tsx:290-316` | — |
| Controller line, split, attempt tabs, live graph, Pause/Cancel header actions | **exist** | A4–A6 acceptance; `runs.go:570-572` | — |

## 4. Spec / design conflicts

1. **5c copy vs accepted takeover semantics** — 5c: "The run pauses **before its next step**… when you hand back, **the loop continues from `test`**". Actual accepted behavior: takeover **interrupts the current attempt** and pauses the run (`retry.go:472-487`); hand-back **re-queues the interrupted node** (`retry.go:503-555`; ADR-0016 §5; A5 acceptance "a NEW attempt (attempt 2) of code_review was queued"). The PO decision list already names "pause-before-next-step" as ADR-requiring: if the product wants the 5c semantics (skip re-running the interrupted node), that is a new ADR amending ADR-0023 §9 / ADR-0043; otherwise the confirm-card copy must be rewritten to match reality ("the current attempt is interrupted; when you hand back, the same step runs again with your changes").
2. **Worker visibility** — 4e's `worker w-1` vs ADR-0016 §8: *"`fencing_token`, `lease_expires_at` and `worker_id`-as-arbiter never appear in a browser-facing body"* (`ADR-0016…md:125`). Showing a worker name needs an ADR.
3. **Route shape** — README routing says `/runs/:id`; ADR-0043 pins `/projects/:projectId/runs/:runId`. Shell-area change, but it affects this page's deep links.
4. **Vocabulary** — 4e/5c label the step cells `plan/approve/implement/test/review/publish`; the workbench graph currently renders spec vocabulary (nodes, "definition", pinned "revision"). Pure UI rename per PO decision, but touches `RunWorkbench.tsx` copy and ADR-0043's testid-bearing labels — rename carefully (no testid removals).
5. **Graph immutability** — 4e's "read-only · this run is pinned to r3 · edits go to a new draft" matches ADR-0043 ("live graph-rewriting editor over a running run is explicitly out of scope"). No conflict.

## 5. Honest empty states

- **Worker name**: never render a placeholder `w-1`; show `attempt 1 of 2` only.
- **Diffstat**: no structured data; for `exec`/`read` calls show timing only, for `edit` show the existing output preview — do not parse `+N −M` out of prose (would be a lie).
- **PROMPT card**: only render when the transcript actually contains the seeded prompt message; otherwise omit the card (no invented "from review iter 1").
- **started by**: show only when the actor is in the `run.created`/`run.started` event payload (verify); else show `started_at` alone.
- **Artifacts tab (0 items)**: one sentence + link to the project artifacts page; the count badge is a client-side sum of `artifact_refs` (honest: "referenced" artifacts, may double-count across nodes).

## 6. Proposed work units (≤60 min each)

Order matters only where files overlap (same-file ⇒ serialize).

1. **U1 — tab set + header copy** (S): 4 design tabs (add Artifacts tab shell with count + empty state), `Fix the workflow…` copy, pinned-line copy. Owns `ui/src/pages/RunWorkbench.tsx`, `ui/src/components/workbench/RunHeader.tsx`. **Serializes U2 and U5.**
2. **U2 — full-screen mode** (M): `?full=1` (aliased to `view`+new param), `⤢`/`⤡` controls, new `ui/src/components/workbench/StepStrip.tsx`, centered ≤760px transcript, `⤡ show graph` restore. Owns `RunWorkbench.tsx` + new file. **Runs after U1.**
3. **U3 — take-control confirm card** (S): new `ui/src/components/workbench/TakeControlCard.tsx` + optional `confirm` prop on `AgentConversationPanel` (Conversation page keeps one-click take). Copy matches real semantics (see §4.1). Owns `AgentConversationPanel.tsx` + new file. **Serializes U6; parallel with U1/U2 chain.**
4. **U4 — tool-row timing** (S): record first-`occurred_at` per tool call in `ui/src/api/transcript.ts`, render elapsed (`14s`) on `ToolRow`. Owns `transcript.ts`, `Transcript.tsx` + tests. **Parallel with everything.**
5. **U5 — header meta line** (S): `#id · repo · revision rN digest (pinned) · started by/when` from `RunDetail` + one event lookup. Owns `RunHeader.tsx`. **After U1.**
6. **U6 — PROMPT card** (S): dock-variant card echoing the first seeded/user transcript message, honest fallback. Owns `AgentConversationPanel.tsx`. **After U3.**
7. **U7 — (deferred) diffstat + worker id**: not doable without ADRs/new fields; tracked via §8 Q4/Q5.

Parallelizable: {U1→U2→U5} and {U3→U6} and {U4} are three independent chains.

## 7. Acceptance checks (browser vs real lab)

- `GET /projects/:p/runs/:r?full=1&node=<defId>&instance=<execId>` → no `[data-testid=workbench-graph-frame]`, `[data-testid=workbench-step-strip]` present with the current step cell raised; transcript column ≤760px; clicking `⤡ show graph` restores the graph frame and removes `full=1`.
- Tab row = exactly `Graph | Timeline | Artifacts | Diagnostics` (testids `workbench-tab-*`); `Artifacts` shows N = client-side sum of `artifact_refs` for a run seeded with 2 artifacts; old `?view=tree` deep link still resolves (to tree or Diagnostics, per U1 decision) — no dead link.
- Take control: with run controller `run_attempt`, composer input `disabled` + explainer; `click [data-testid=take-control]` → confirm card (testid `take-control-confirm`) naming the step; `Just watch` → card gone, **no** `POST …/take-control` request, `control.version` unchanged; `Take control` → exactly one `POST`, badge "You are in control", `GET /runs/{id}` → `status=paused`, `paused_reason=human_takeover`; after `Return to factory`, the **same node** has `attempt_count` +1 (not the next node advanced).
- Pause: header `Pause` → `POST /api/v1/runs/{id}/pause` 202; `GET` shows `paused_reason=manual`; SSE timeline gains `run.paused` (actor = user) before any state flip.
- Tool rows: in a seeded ACP attempt, completed tool rows show an elapsed string matching the `occurred_at` span of their `conversation.tool.call`/`update` events; tool-row count == `conversation.tool.call` event count.
- No `worker_id` string appears anywhere in the workbench DOM.

## 8. Open questions for the product owner

1. **Hand-back semantics**: keep the accepted behavior (interrupted node re-runs once, ADR-0023 §9 / A5 evidence) and only fix the 5c copy, or amend to "continue from the next step" (new ADR)? **Default: keep behavior, fix copy.**
2. **Execution tree tab**: keep as a 5th tab, or fold under Diagnostics to match the 4-tab artboard? **Default: fold under Diagnostics (ADR-0043 d5 already groups old views there).**
3. **`Fix the workflow…` role**: who may start a draft from a running run's revision — org admin only (today) or any contributor? **Default: org admin only until an ADR.**
4. **Worker names on attempt lines** (`worker w-1`)? Needs an ADR amending ADR-0016 §8's "never browser-facing" rule. **Default: no; show `attempt k of m` only.**
5. **Diffstat on edit tool rows**: accept a fragile parse of agent output for now, or defer until the ACP event contract carries structured diffs (ADR amending spec 09)? **Default: defer; timing only.**
6. (bonus) **URL params**: alias `?step=&iter=&full=1` onto `?node=&instance=&view=` keeping old links valid, or migrate and 404/redirect the old form? **Default: alias; old form stays source of truth.**
