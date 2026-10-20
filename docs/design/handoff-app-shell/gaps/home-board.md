# Gap analysis — Phase 2: Home briefing, Board, run drawer (artboards 2a, 2d, 3c)

Scope: Home briefing (2a; turn-4 note `shots/turn-intros.txt:33` "Home stays the briefing from 2a"),
Board (2d/3c), run drawer (3c). Design source: `docs/design/handoff-app-shell/README.md` sections
"Home — briefing" and "Board (2d, 3c)"; artboard text `shots/2a.txt`, `shots/2d.txt`, `shots/3c.txt`.

## 1. Design asks

- **Home count line** (2a): `! N need you · × N failed · ● N running · · N queued` — across ALL the caller's projects.
- **Decision callout** (2a): amber `! NEEDS YOUR DECISION` panel — workflow `#id`, repo, age, summary sentence, `Read plan` + `Approve`.
- **Running now** (2a): cross-project active runs; per row: status chip, title, `workflow #id · repo`, **segmented bar, one 7px segment per step** (done/running/waiting/failed/pending), current step + fraction (`implement · 2/4`), age; `open board ›`.
- **Recent threads** (2a): recent one-off conversations (`repo · agent · age`), "one-off, no workflow".
- **Board page** (2d): sidebar item; group by **state / repo / workflow**; filter chips **all projects / mine / from issues / scheduled**; `Start run`; columns QUEUED, RUNNING, ! NEEDS YOU, × FAILED, DONE TODAY.
- **Board cards** (2d): `workflow #id`, title, segmented bar, repo chip, current step, age; NEEDS-YOU cards `Approve`/`Read plan`; FAILED cards `Retry from <step>`/`Fix the workflow`; DONE cards `✓ draft PR #N`.
- **Card → 440px right drawer** (3c): state-colored header, `esc to close`, meta incl. **trigger "from issue #512"**, step strip (one cell per step), **model-written PLAN SUMMARY** + `Read the full plan ›`, latest 3 events, `Approve`/`Request changes`, `Open run ›`, `Ask about this run…` composer.
- Sidebar repo click → **board filtered to that repo** (2d caption). Live updates via the event stream, "don't poll" (README "Interactions & behavior").

## 2. Exists today

### Backend (grep-verified)

- **Runs list — project-scoped only, unfiltered.** `GET /api/v1/projects/{projectId}/runs` (`api/openapi.yaml:3000`), handler `listRuns` (`internal/api/runs.go:720`) → `ListProjectRuns` (`internal/store/postgres/runs.go:364`), newest-first, **no query parameters**.
  - There is **no cross-project runs list** anywhere in the route table (`api/openapi.yaml:197-3883`); `GET /runs/{runId}` (`openapi.yaml:3100`) is single-run detail only.
- **`RunSummaryView`** (`internal/api/runs.go:129`):
  - has `status` (9 states incl. `waiting_human`), `pipeline_id`, `created_at`/`started_at`/`finished_at`, `depth`, `parent_run_id`, `triggered_by`;
  - `triggered_by` is a nullable user — **NULL for system/child starts** (`internal/store/postgres/migrations/00005_m4_pipelines.sql:175`);
  - **missing: title, per-step progress, current step, trigger source (manual/issue/schedule).**
- **Per-run step states**: `GET /runs/{runId}/nodes` (`api/openapi.yaml:3134`, `listRunNodes` `internal/api/runs.go:833`; `NodeExecutionView` `internal/api/runs.go:203` carries `status`/`outcome`/`waiting_reason`) and `GET /runs/{runId}/tree` (`openapi.yaml:3201`).
  - That is **one call per run** — N board rows ⇒ N calls; no batch endpoint and no embedded progress anywhere.
- **"Needs you" sources** (all exist):
  - `runs.status='waiting_human'` (`00005_m4_pipelines.sql:163-167`);
  - pending approvals `GET /projects/{p}/approvals` (`openapi.yaml:3641`; `ApprovalView` `internal/api/approvals.go:93` — `summary`, `run_id`, `node_instance_key`, `deadline_at`, `on_timeout`);
  - conversation `pending_permissions` (`internal/api/conversations.go:194-201`).
  - **The reduction already exists in the UI: `ui/src/lib/attention.ts`** — `decisions`/`stalled`/`permissions` shapes, `STALLED_STATES = failed,paused` (`attention.ts:37`), cross-project via `useProjects` (`ui/src/api/queries.ts:142`). Used by `Projects.tsx` and `Inbox.tsx`.
- **Inbox today** (`ui/src/pages/Inbox.tsx`):
  - **polls**: `INBOX_POLL_MS` 15s refetch of `useProjects` + `useProjectAttention` (`Inbox.tsx:57,64`);
  - header comment `Inbox.tsx:20`: "no SSE feed exists for attention yet";
  - rows: approval decision rows + permission rows, testids `inbox-decision-*` (`Inbox.tsx:206`).
- **Event streams — project-scoped only**:
  - `GET /projects/{projectId}/events` SSE (`openapi.yaml:685`); M4 types include `run.started/completed/failed/waiting_human/cancelled`, `node.*`, `approval.requested/decided/…` (`internal/events`);
  - per-run `GET /runs/{runId}/events` (`openapi.yaml:3431`) and per-conversation (`openapi.yaml:1165`);
  - **no org/cross-project stream**;
  - UI hooks: `useEventStream` (`ui/src/api/events.ts:158`), `useProjectEvents` (`events.ts:288`) with batched react-query invalidation — the fan-out pattern for U7 is already built.
- **Threads**: "Threads" = existing **conversations** (rename only). `GET /projects/{p}/conversations` (`openapi.yaml:984`), `ConversationSummaryView` (`internal/api/conversations.go:211`) carries `origin: 'manual' | 'run'` (ADR-0043 comment) — "recent threads" = `origin=manual`, but **list is per-project only**.
- **Triggers**: `runs.triggered_by` (user) only. Schedules exist (`00006_m6_schedules.sql:56`, ADR-0032) but keep just `last_run_id`. GitHub issues are read-only and explicitly **not a trigger**: `GET /projects/{p}/repos/{r}/issues` (`openapi.yaml:545`, ADR-0031: "this route is not a trigger"). **So "from issue #512" (3c) and the `from issues`/`scheduled` chips (2d) have no data behind them.**
- **Model-written summary: nothing produces one.** Gate `summary` is static author text from node config `config/summary` (`internal/pipelines/runtime/advancer.go:823,843,867`), digested, not model-generated. No run/plan summary endpoint.
- **Assistant**: `POST /api/v1/assistant/ask` (`openapi.yaml:3799`, ADR-0034) — one-shot, read-only tools (`run.list`, `run.nodes`, `approval.pending`, …), returns `links`. The drawer's "Ask about this run…" can reuse it (questions only; UI hook `useAssistantAsk` `ui/src/api/assistant.ts:72`).
- **Every drawer/card action the design draws already has an API**:
  - `Approve` / `Request changes` → `POST /approvals/{id}/decide` (`openapi.yaml:3701`);
  - `Retry from <step>` → `POST /runs/{runId}/retry` accepts `node_instance_keys[]` (`openapi.yaml:3376+`, ADR-0037);
  - `Read plan` → approval `artifact_refs` (`internal/api/approvals.go:101`) + `GET /artifacts/{id}/content` (`openapi.yaml:2066`);
  - `Fix the workflow` → drafts routes (`openapi.yaml:2323`; UI route `/library/:pipelineId/drafts/:draftId` `ui/src/App.tsx:106`).
- **Start run**: `POST /projects/{p}/runs` (`openapi.yaml:3031`) + `ui/src/components/m4/NewRunForm.tsx` — project-scoped; the board's global `Start run` needs a target-picker around it.
- **Draft PR data: none** — no `pr_number`/`pull_request` columns (grep of migrations + `internal/api`); only `head_commit` on workspace status (`internal/api/workspaces.go:46`). `✓ draft PR #212` has no source.

### UI

- **`ds/ProgressStrip.tsx` exists (120 lines) and is exactly this widget**: variant "J" = one cell per stage colored by state (3c step strip), variant "K" = segmented bar; kinds `done|running|waiting|failed|interrupted|open` with `SEGMENT_COLOR` from `ui/src/components/ds/states.ts`. **Currently used only by `ds.test.tsx`** — no page imports it yet.
- **Routes** (`ui/src/App.tsx:64-197`): `/` → `Projects` (the current "home"), `/inbox`, `/library`, `/agents`, `/projects/:projectId[/runs|/runs/:runId|/pipelines|/conversations|/settings|/artifacts]`, `/ops`. **No `/board`, no cross-project Home.**
- `ui/src/pages/ProjectRuns.tsx` (324 lines): per-project runs list, **client-side** filters `attention/active/waiting/all` (testids `runs-filter-*`, `runs-list`, `run-row-<id>` `ProjectRuns.tsx:148-208`); no progress bar.
- `ui/src/pages/RunInspector.tsx` (1325 lines) and `ui/src/pages/RunWorkbench.tsx` (781 lines) exist (ADR-0043) — the drawer's `Open run ›` target; workbench reads step/iter/full params (`RunWorkbench.tsx:68`).
- Hooks: `useRun`/`useRunNodes` (`ui/src/api/runs.ts:41,50`), `useProjectApprovals` (`ui/src/api/approvals.ts:21`), `useAssistantAsk` (`ui/src/api/assistant.ts:72`).

## 3. Gap table

| item | kind | evidence / spec ref | size |
|---|---|---|---|
| Cross-project board runs list (state, mine, repo; embedded step progress, current step, step count) | needs backend + ADR (new public API, scoped per membership) | no `GET /api/v1/board*`; runs list is project-scoped `openapi.yaml:3000` | L |
| One-segment-per-step data in list rows (no N+1) | needs backend (same endpoint as above; aggregate node executions per step of pinned revision) | `openapi.yaml:3134` is per-run only | M (inside the endpoint) |
| Home briefing page (counts, callout, running now, recent threads) | UI on existing APIs if cross-project list endpoint lands; counts reuse `ui/src/lib/attention.ts` | `attention.ts` already cross-project; `/` today is `Projects.tsx` | M |
| Board page (kanban, group by state/repo/workflow, filters) | UI on new endpoint; regrouping is client-side | `App.tsx` has no `/board` | M |
| Run drawer (steps, 3 events, actions, Open run) | UI on existing APIs (`/runs/{id}`, `/runs/{id}/nodes`, `/runs/{id}/events`, approvals) | `openapi.yaml:3100,3134,3431` | M |
| `mine` filter | UI on existing field (`triggered_by` is on `RunSummaryView` `runs.go:141`) | `runs.triggered_by` `00005:175` | S |
| `from issues` / `scheduled` filters + "from issue #512" meta | needs backend (trigger-source data doesn't exist) — defer, show disabled chips | ADR-0031 "not a trigger"; `00006` keeps only `last_run_id` | L (out of phase 2) |
| Model-written PLAN SUMMARY (drawer) + "written by the model" label | needs backend + ADR (summarization pass; PO decision) | gate summary is static config `advancer.go:823`; assistant is one-shot read-only ADR-0034 | L (out of phase 2) |
| Live board/home updates without polling | UI-only short term: N per-project SSE streams (one per visible project) using `useEventStream` | no cross-project stream `openapi.yaml:685`; `events.ts:288` pattern; ADR if a cross-project stream is added later | M |
| `Start run` from cross-project board | UI on existing API (target picker, then project-scoped `POST /projects/{p}/runs` + `NewRunForm`) | `openapi.yaml:3031` | S |
| "Threads" rename + Recent threads list (cross-project, `origin=manual`) | UI-only (rename + client-side merge of per-project lists) | `conversations.go:211 origin` | S |
| Retry-from-step / Approve / Read plan / Fix workflow buttons | UI on existing APIs | `openapi.yaml:3701,3376,2066,2323` | S |
| `✓ draft PR #N` on DONE cards | honest empty state — no PR data anywhere | grep: no `pr_number` columns | S (show head commit/`✓ done`) |
| Run title on cards/rows | no `title` on runs — needs a convention (see Q2) | `RunSummaryView` `runs.go:129` | S |

## 4. Spec / design conflicts

1. **Issue triggers (3c meta, 2d chips) vs ADR-0031**: `api/openapi.yaml:545-560` — the issues route "is not a trigger: webhooks/invocations … need the M6 tables and dedupe". `runs` has no trigger-source column (`00005:154-185`). The design's `from issue #512` line and `from issues` filter are unprovable today → do not render as data; show `started by <user>` (`triggered_by`) or omit. Needs an ADR when issue-triggering is built (per PO: run-from-thread/issue seeding is already flagged).
2. **Model-written summary (3c) vs ADR-0034**: the assistant broker is "one bounded turn … read-only … nothing is stored" (`openapi.yaml:3804-3820`). A persisted per-run plan summary is a new capability → needs the summarization-pass ADR the PO already listed. Until then, the drawer can show the **author-written** gate `summary` (`advancer.go:823`) honestly labeled, never "written by the model".
3. **"Don't poll" (README) vs current Inbox precedent**: README says board/home subscribe to "the existing event stream"; the only existing streams are per-project (`openapi.yaml:685`). Today even the Inbox polls (15s, `Inbox.tsx:20,57`) because "no SSE feed exists for attention yet". Cross-project SSE fan-out is compatible with "existing stream"; a single org-wide stream would be a new public API needing an ADR.
4. **One segment per step vs loops**: the pinned revision defines steps (docs `openapi.yaml:2633 /revisions/{id}/document`); a loop node yields many node executions with `iterations` (`runs.go:222`). Segments must aggregate **per step template**, not per execution, or loops break the "2/4" fraction. Not a spec violation, but the backend endpoint must define it.
5. **Immutability check (no conflict found)**: Board/Home read pinned-revision data only; nothing here touches revision mutability (ADR-0002, `openapi.yaml:2262`).
6. **Vocabulary**: design's Workflows/Steps/Threads are UI renames of pipelines/node-templates/conversations (PO decision; ADR-0043 already covers workbench takeover). API keeps `pipeline`/`conversation` — the board UI must translate, not rename routes.

## 5. Honest empty states

- **Plan summary**: show the gate's static `summary` (`approvals.go:100`) with label "plan summary · from workflow"; if empty, show the plan-document artifact link only. Never a fake model label.
- **Trigger meta**: `started by <user>` when `triggered_by` set, else omit (system/child starts are NULL by design, `00005:175`).
- **DONE cards**: `✓ done · <age>` (or head commit if resolvable) — no PR numbers exist.
- **`from issues` / `scheduled` chips**: render disabled with a tooltip "not available yet", or omit; do not render empty columns implying data.
- **Recent threads**: no `origin=manual` conversations in a project → contribute nothing; globally empty → one line "No one-off threads yet" + primary action per README empty-state rule.
- **Fresh lab board**: all five columns empty → single sentence + `Start run` (README: "one sentence plus a primary action").
- **Assistant 503** (`assistant_not_configured`, `openapi.yaml:3820`): drawer "Ask about this run…" shows the composer disabled with that reason.

## 6. Proposed work units

Ordered; **S** = same-file serialize. Each ≤60 min, one owner.

| # | unit | files owned | deps / parallel |
|---|---|---|---|
| U1 | **ADR-0045**: cross-project board runs endpoint (shape, authz per membership, 404 rule ADR-0014 §3, progress semantics incl. loop aggregation, depth-0-only default) | `docs/adr/ADR-0045-*.md` | first; everything else depends |
| U2 | Store query: caller's board runs in one statement (join projects↔membership, per-run step aggregation from node_executions + pinned revision, pending-approval flag) | `internal/store/postgres/*` (new file) + tests | after U1 |
| U3 | API handler `GET /api/v1/board/runs` + `RunBoardView` + OpenAPI block + authz tests | `internal/api/board.go` (new; **not** `runs.go`), `api/openapi.yaml` | after U2; parallel-safe w/ U5 (different files) |
| U4 | UI: `/board` route + `Board.tsx` (columns, group control, filter chips, cards w/ `ds/ProgressStrip` variant J, disabled `from issues`/`scheduled` chips) + `useBoardRuns` hook | `ui/src/pages/Board.tsx`, `ui/src/api/board.ts`, `ui/src/App.tsx` (route) | after U3 |
| U5 | UI: `RunDrawer` (3c): header strip, step strip (ProgressStrip J), static plan summary, latest 3 events (per-run SSE), Approve/Request changes/Retry, `Open run ›`, assistant ask composer | `ui/src/components/board/RunDrawer.tsx` | after U4 (touches `Board.tsx` → S w/ U4) |
| U6 | UI: Home briefing at `/` (counts from `attention.ts`, decision callout, Running now from board API, Recent threads = per-project manual conversations) + redirect old `/` content | `ui/src/pages/Home.tsx`, `ui/src/App.tsx` (**S with U4** on App.tsx → run after U4) | after U4 |
| U7 | Live updates: `useBoardEvents` — one SSE per visible project via `useEventStream`, batched invalidation of board+home keys (mirrors `events.ts:288`); kill the 15s poll on pages using it | `ui/src/api/boardEvents.ts` | after U4; parallel w/ U5/U6 |
| U8 | `StartRunDialog` for the board (target picker prefilled from repo/project filter; reuses `NewRunForm`) | `ui/src/components/board/StartRunDialog.tsx` | after U4; parallel w/ U5/U6/U7 |

Parallel groups: **{U5, U6, U7, U8}** after U4 (U5 touches Board.tsx, U6 touches App.tsx, U7/U8 new files). Serial spine: U1 → U2 → U3 → U4.
Out of phase 2 (need the summarization-pass ADR / trigger-source ADR): model summaries, issue/scheduled filters, PR chips.

## 7. Acceptance checks

Browser test against the real lab (Postgres lab, ≥2 projects, caller member of both):

1. **API scope**: `GET /api/v1/board/runs` returns runs from exactly the caller's projects; a run in a project the caller isn't a member of is absent (create it, verify 404-on-direct-get via ADR-0014 §3 rule). Row count equals sum of per-project counts for active states.
2. **Progress**: seed a 4-step pipeline, run it to step 2 (implement running): the row reports `steps: [done, running, pending, pending]`, `current: "implement"`, fraction `2/4`; after approval of a gate the row moves `waiting → running` with no N+1 (exactly **1** XHR per board load regardless of row count — assert in console/network).
3. **Columns**: 5 column headers present (`board-col-queued|running|needs-you|failed|done`); a `waiting_human` run sits in NEEDS YOU with `data-testid=board-card-<runId>`; `completed` run finished today is in DONE TODAY only (set `finished_at` yesterday → card disappears from the column, count drops by 1).
4. **Filters**: `mine` shows only runs where `triggered_by == caller` (seed one run by another user → absent under `mine`, present under all); `from issues`/`scheduled` chips are `disabled` with `aria-disabled=true`.
5. **Drawer**: click `board-card-<id>` → drawer opens (`data-testid=run-drawer`, 440px, header strip in amber for waiting); `Esc` closes it; step strip shows one cell per step with correct glyphs; latest 3 event rows carry timestamps; `Approve` flips `run.status` `waiting_human → running` (GET before/after) and the card leaves NEEDS YOU within one SSE frame (no manual refresh).
6. **Home**: count-line numbers (`home-count-needyou|failed|running|queued`) equal board column counts at the same moment; decision callout names the oldest pending approval's summary; `Recent threads` lists only `origin=manual` conversations, newest first.
7. **Live**: start a run via the board's `Start run`; board QUEUED count goes 0→1 on event arrival (<10s, no `refetchInterval` XHRs in between — assert request count).
8. **Empty lab**: fresh DB → each column shows the empty-state sentence; exactly one `Start run` primary button visible.

## 8. Open questions for the product owner

1. **API shape**: one new cross-project endpoint `GET /api/v1/board/runs` (filters + embedded progress) vs. client-side fan-out of existing per-project calls? **Default: new endpoint** — the fan-out is N HTTP + N SSE per page load and can't answer `mine`/cross-project counts in one scope check. (Needs ADR either way; the fan-out is ADR-free but slow.)
2. **Run title** (cards, rows, drawer): there is no `title` on a run. Options: first declared run input, pipeline name, issue title (future). **Default: first input value, falling back to pipeline name** — matches 2a where titles read like task descriptions.
3. **Loop segments**: confirm one segment per **step template** (iterations collapse into that segment, counter shown like `implement ×3`), not one per loop iteration. **Default: yes** — matches the `2/4` fractions in 2a.
4. **Board scope**: show only root runs (`depth = 0`)? Child runs (workflow steps) currently would double-count. **Default: root only**; child runs visible inside the workbench graph.
5. **Live transport**: per-project SSE fan-out now (UI-only, no ADR) vs. a new org-level stream (better, but a new public API + ADR + replica-load question). **Default: fan-out for phase 2**, revisit when project counts make N connections silly.
