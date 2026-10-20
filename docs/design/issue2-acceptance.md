# Issue #2 acceptance record — graph-first Workflow Studio, live Run Workbench, integrated agent conversations

Final acceptance record for `gh issue view 2` ("Definition of done — demonstrable acceptance
walkthrough"). This replaces the earlier draft, which still carried a pending final-run line.
Every checkbox below is **PASS**, proven by the acceptance specs in
`e2e/tests/issue2-{studio,workbench,conversations}.spec.ts` run against the live lab built from
**HEAD `bd89502`** — the production embedded UI (built from that tree), real Claude coding agents
for the ACP turns, and the lab's real collective model for the assistant. Labels A1–A10 follow the
spec test names; each section cites the spec test, the screenshot files and the `EVIDENCE` line(s)
from the final run.

## Final acceptance run

| Suite | Result | Run |
|---|---|---|
| `issue2-studio.spec.ts` | **7/7 PASS** | `final6` (one consolidated run, `issue2-studio.out`) |
| `issue2-workbench.spec.ts` | **5/5 PASS** | `final6` (`issue2-workbench.out`) |
| `issue2-conversations.spec.ts` | **3/3 PASS** | `final6` (`issue2-conversations.out`) |
| M5 regression (`m5-*.spec.ts`) | **53 PASS, 1 pre-existing fixme** | `final6`, freshly reset lab (`lab-reset-m5.out`, recorded in `m5.out`) |
| a11y | **13 axe checks, 0 serious/critical violations** | across the runs above (`A11Y` lines in `evidence.txt`) |
| unit / CI | **991 UI tests green and the full Go race suite green at `bd89502`** | CI |

## Evidence

- Evidence directory: `~/.cache/communication-lab/issue2/final-evidence/`
  - `evidence.txt` — every `EVIDENCE …` and `A11Y …` console line emitted by the final runs
  - 37 full-page screenshots (inventory below)
  - `m5.out` — the M5 regression run (53 passed, 1 skipped fixme)
- Screenshot inventory:
  - **Studio (13):** `studio-loaded.png`, `studio-narrow.png`, `studio-a1-inserted.png`,
    `studio-a1-yaml.png`, `studio-a1b-inspector-a11y.png`, `studio-a2-wrapped.png`,
    `studio-a2-published.png`, `studio-a2-reopened.png`, `studio-a3-preview.png`,
    `studio-a3-undo.png`, `studio-a3-ambiguity.png`, `studio-a8-proposed.png`, `studio-a8-applied.png`
  - **Workbench (14):** `wb-setup-run-started.png`, `wb-a4-graph-default.png`,
    `wb-a4-approval.png`, `wb-a4-acp-live.png`, `wb-a5-bob-control.png`,
    `wb-a5-carol-readonly.png`, `wb-a5-returned.png`, `wb-a5-timeline.png`, `wb-a6-exec.png`,
    `wb-a6-iter1.png`, `wb-a6-iter2.png`, `wb-a6-fanout.png`, `wb-a6-attempts.png`, `wb-narrow.png`
  - **Conversations (10):** `conv-a7-dialog.png`, `conv-a7-global-menu.png`,
    `conv-a7-list-manual.png`, `conv-a7-manual-label.png`, `conv-a7-reply.png`,
    `conv-a7-filter-run-hides-manual.png`, `conv-run-badge.png`, `conv-run-conversation-page.png`,
    `conv-run-linkback.png`, `conv-narrow-dialog.png`

## How to re-run (scratchpad-independent)

With a lab stack running and its UI reachable:

```bash
pnpm --dir e2e install --frozen-lockfile
pnpm --dir e2e exec playwright install chromium

# Issue #2 acceptance journeys (studio + workbench + conversations)
COMMUNICATION_E2E_ISSUE2=1 E2E_BASE_URL=http://<lab-ui> \
  E2E_EVIDENCE_DIR=$HOME/.cache/communication-lab/issue2/final-evidence \
  pnpm --dir e2e test \
    tests/issue2-studio.spec.ts tests/issue2-workbench.spec.ts tests/issue2-conversations.spec.ts

# M5 regression
COMMUNICATION_E2E_M5=1 E2E_BASE_URL=http://<lab-ui> \
  pnpm --dir e2e test \
    tests/m5-agents-schedules.spec.ts tests/m5-assistant.spec.ts tests/m5-inbox.spec.ts \
    tests/m5-issue-run.spec.ts tests/m5-journey.spec.ts tests/m5-layout.spec.ts \
    tests/m5-prompt-edit.spec.ts
```

- The specs are env-gated: `COMMUNICATION_E2E_ISSUE2=1` / `COMMUNICATION_E2E_M5=1`, otherwise they
  skip. `E2E_BASE_URL` points at the lab UI; `E2E_EVIDENCE_DIR` (default `test-results/issue2/`)
  receives the `EVIDENCE` screenshots and lines.
- Re-run safety is built in: the studio spec restores the seeded
  `feature-development-deterministic` twin before A0 and works in its own fresh drafts; the
  workbench setup repins the project assignment to the Studio-published revision through the UI.

## A1 — Edge insertion of an ACP reviewer (checkbox 1) — PASS

> From an example workflow, open Studio and visually insert an ACP reviewer on an edge after
> testing; set its profile/APM and prompt; configure the following route without hand-editing YAML.

- **Spec test:** `issue2-studio.spec.ts` → `A0` (opens the deterministic twin in the Studio) and
  `A1` (inserts the ACP reviewer on the test→review edge and configures it in the schema-driven
  inspector — no YAML editing anywhere).
- **Screenshots:** `studio-loaded.png`, `studio-a1-inserted.png`, `studio-a1-yaml.png`.
- **Evidence:**
  > `EVIDENCE studio-a1-inserted: agent.acp node agent inserted on the test → review edge and configured entirely in the inspector: profile m4-reviewer, review prompt, id code_review, on-failure continue`
  > `EVIDENCE studio-a1-yaml: YAML view proves the inspector's work: id: code_review (kind agent.acp, profile m4-reviewer), review's dependsOn now names code_review, on-failure continue — untouched by any YAML editing`
- **Implementing work:** pure comment-preserving text→text graph ops in
  `ui/src/lib/pipeline/graphDoc.ts` (`5c5c887`, 60 unit tests), Studio canvas + schema-driven
  inspector (`e07fd04`, `78ec5be`); ADR-0042.

## A2 — Bounded Repeat until, publish, reopen (checkbox 2) — PASS

> Wrap an implementation/check/review sequence in a bounded Repeat until container, configure the
> pass test and iteration cap, publish after server validation; reopening the revision shows the
> same semantics and readable graph/YAML.

- **Spec test:** `issue2-studio.spec.ts` → `A2` (adds three steps, multi-selects them, wraps them
  in a Repeat until scope, configures it, validates — 0 findings — diffs, publishes, reopens).
- **Screenshots:** `studio-a2-wrapped.png`, `studio-a2-published.png`, `studio-a2-reopened.png`.
- **Evidence:**
  > `EVIDENCE studio-a2-wrapped: three steps added at the root tail (two echo Run-command steps → the m4-reviewer agent), multi-selected by shift+click and wrapped in a Repeat until scope (until) from the selection toolbar — the YAML carries kind: until with passWhen true and maxIterations: 2`
  > `EVIDENCE studio-a2-published: the draft was saved, validated (server verdict: valid — 0 findings) and published — published as r2 2.0.0; the diff listed code_review and the until until scope before publish`
  > `EVIDENCE studio-a2-reopened: reopened r2 from the pipeline page: the definition graph shows the new until Repeat until scope and the regenerated YAML shows kind: until with maxIterations: 2`
- **Implementing work:** `wrapInScope`/`unwrapScope` in `graphDoc.ts` (`5c5c887`), scope groups +
  selection toolbar in the Studio (`e07fd04`, `78ec5be`), multi-select loop fix (`29483fc`).

## A3 — Drag-to-insert, undo/redo, no silent rewrite (checkbox 3) — PASS

> Drag a compatible node onto an edge, see the insertion preview, undo and redo; invalid or
> ambiguous route insertion cannot silently rewrite existing conditions or bindings.

- **Spec test:** `issue2-studio.spec.ts` → `A3` (drag-to-insert with the nearest-edge split
  preview, undo leaves the YAML byte-identical, redo restores it, and the ambiguity dialog on a
  guarded edge changes nothing without explicit acceptance).
- **Screenshots:** `studio-a3-preview.png`, `studio-a3-undo.png`, `studio-a3-ambiguity.png`.
- **Evidence:**
  > `EVIDENCE studio-a3-preview: dragging 'Human approval' over the plan → approve edge shows the insert-preview on that edge`
  > `EVIDENCE studio-a3-undo: drag-to-insert of a Human approval step on the plan → approve edge (insert preview, drop, guard confirm): inserted, undone (YAML byte-identical to before) and redone (YAML restored with kind: human.approval)`
  > `EVIDENCE studio-a3-ambiguity: the guarded verdict → publish edge's own + raised the AmbiguityDialog naming the condition (when) guard before anything changed`
- **Implementing work:** `insertOnEdge`/`connect`/`canConnect` with the ADR-0042 §4 ambiguity
  rules — guarded, condition-route and binding-reader edges require explicit acceptance that
  leaves `when`/bindings byte-identical; error routes are refused (`5c5c887`).

## A4 — Graph-first Run Workbench with live conversation (checkbox 4) — PASS

> Start the published pipeline. The default Run Workbench is graph-first, highlights the active
> node, and clicking an ACP node reveals its live conversation directly beside the graph.

- **Spec test:** `issue2-workbench.spec.ts` → `setup` (pins the assignment to the Studio-published
  revision, provisions members, starts the run) and `A4` (graph-first default, approval from the
  dock, live ACP conversation in the dock).
- **Screenshots:** `wb-setup-run-started.png`, `wb-a4-graph-default.png`, `wb-a4-approval.png`,
  `wb-a4-acp-live.png`.
- **Evidence:**
  > `EVIDENCE wb-setup-run-started: the run started with fanout=14, hold_seconds=20`
  > `EVIDENCE wb-a4-graph-default: the run page opens graph-first: graph tab selected, react-flow canvas visible (no definition table), the attention node auto-selected and docked`
  > `EVIDENCE wb-a4-approval: the approve human gate was selected in the graph and approved from the dock's approval card`
  > `EVIDENCE wb-a4-acp-live: the agent.acp node code_review is selected and the dock shows its live conversation transcript (agent messages / tool events)`
- **Implementing work:** graph-first `RunWorkbench` + dock (`78ec5be`), execution→definition
  mapping with status overlays (`0bf4669`), shared `AgentConversationPanel` (`c7f3684`),
  whole-conversation dock (`1512ae7`), dense canvas layout (`90db90f`); ADR-0043.

## A5 — Human takeover and read-only refusal (checkbox 5) — PASS

> A permitted teammate takes control, prompts the selected agent, then returns control to the
> factory; a read-only project member cannot take control. The graph, transcript and event
> timeline remain in sync.

- **Spec test:** `issue2-workbench.spec.ts` → `A5` (bob takes control of a genuinely in-flight
  attempt, prompts, returns to the factory; carol is refused; the timeline carries the handoffs).
- **Screenshots:** `wb-a5-bob-control.png`, `wb-a5-carol-readonly.png`, `wb-a5-returned.png`,
  `wb-a5-timeline.png`.
- **Evidence:**
  > `EVIDENCE wb-a5-bob-control: bob (contributor) took control while /build_until_verified[1]/code_review was running — the badge reads "You are in control" and the run is paused for human_takeover (the attempt was interrupted)`
  > `EVIDENCE wb-a5-carol-readonly: carol (viewer) sees Take control disabled (with the composer explainer) and a disabled composer on the same ACP node`
  > `EVIDENCE wb-a5-returned: bob returned control to the factory — on the conversation he drove (attempt 1 tab) the badge names the pipeline run, the run resumed (not paused), and a NEW attempt (attempt 2) of code_review was queued and reached succeeded (attempt tabs: 1 + 2)`
  > `EVIDENCE wb-a5-timeline: the workbench timeline lists the control handoffs — run.paused (human_takeover) and run.resumed with bob as actor`
- **Implementing work:** shared controller semantics in `AgentConversationPanel` (`c7f3684`);
  multi-turn dock with attempt-boundary and human-driven turn markers (`1512ae7`); takeover
  journey hardened to a live attempt (`3d78281`); post-return dock behaviour (`72563da`).
## A6 — Non-agent evidence, loops and attempts (checkbox 6) — PASS

> Select command/check/approval nodes and see their correct output, evidence and actions. Inspect
> at least two loop iterations, several fan-out children, and repeated attempts without confusing
> runtime instances with immutable definition nodes.

- **Spec test:** `issue2-workbench.spec.ts` → `A6` (exec output in the dock, the until
> iteration picker over both iterations, the for_each item picker with several picks, and
> repeated attempts on a failing fan-out child).
- **Screenshots:** `wb-a6-exec.png`, `wb-a6-iter1.png`, `wb-a6-iter2.png`, `wb-a6-fanout.png`,
  `wb-a6-attempts.png`.
- **Evidence:**
  > `EVIDENCE wb-a6-exec: a process.exec node (test) is selected; the dock shows its exit code and captured stdout/stderr`
  > `EVIDENCE wb-a6-iter1: the until scope's picker selects iteration 1 — iteration 1 · attempt 1 of 2`
  > `EVIDENCE wb-a6-iter2: the until scope's picker selects iteration 2 — iteration 2`
  > `EVIDENCE wb-a6-fanout: the for_each scope shows 14 items with per-state counts; items 1-4 were selected and the dock followed the picks`
  > `EVIDENCE wb-a6-attempts: fan-out item 13 (the child that exits 1) — its child run's implement step shows more than one attempt — attempt tabs or 'attempt k of m' with m > 1`
- **Implementing work:** per-iteration/per-item status overlays and instance selectors —
  "runtime instances are selected, never drawn as extra definition nodes" (`0bf4669`); dock
  detail views for exec/approval/failure/child-run (`78ec5be`).

## A7 — One-off conversations and run link-backs (checkbox 7) — PASS

> Start a one-off ACP conversation in a project without choosing a pipeline; complete a turn and
> find the conversation afterward. Run-linked conversations navigate back to the correct graph
> node.

- **Spec tests:** `issue2-conversations.spec.ts` → `A7` (one-off conversation from the project
  header and from the global New menu, a completed real-agent turn, search + Manual badge +
  filters), `run-linked conversation: the badge deep-links into the Run Workbench`, and the
  narrow-dialog fit test.
- **Screenshots:** `conv-a7-dialog.png`, `conv-a7-global-menu.png`, `conv-a7-reply.png`,
  `conv-a7-list-manual.png`, `conv-a7-manual-label.png`, `conv-a7-filter-run-hides-manual.png`,
  `conv-run-badge.png`, `conv-run-conversation-page.png`, `conv-run-linkback.png`,
  `conv-narrow-dialog.png`.
- **Evidence:**
  > `EVIDENCE conv-a7-dialog: New conversation dialog opened from the m4-exit overview header with the project pinned, profile m4-implementer and the first prompt filled — no pipeline field exists`
  > `EVIDENCE conv-a7-global-menu: the global New menu (new-menu → new-menu-conversation) opened the same dialog with a working project picker set to M4 Exit`
  > `EVIDENCE conv-a7-reply: conversation "issue2 one-off final6" landed on its page and the m4-implementer turn completed with an agent reply containing "pong"`
  > `EVIDENCE conv-a7-list-manual: searching "issue2 one-off" lists the row with the Manual badge (conversation-origin-manual)`
  > `EVIDENCE conv-a7-manual-label: the conversation page shows the "Manual conversation" label and has no part-of-run-link or node reference`
  > `EVIDENCE conv-a7-filter-run-hides-manual: filtering the list to "From runs" hides the manual conversation`
  > `EVIDENCE conv-run-badge: a run-linked conversation row's "From run" badge is a deep link into the Run Workbench with a ?node= parameter (…/runs/01a159b5-4139-7544-99a6-89d02b4d07c7?node=code_review&instance=d2f69e5f-12c7-56d9-be72-ef480dd5dbd9&attempt=1)`
  > `EVIDENCE conv-run-conversation-page: the conversation page's part-of-run-link points at the same workbench deep link as the list badge (/projects/01a159b4-4629-7b16-bf65-932bc69ea578/runs/01a159b5-4139-7544-99a6-89d02b4d07c7?node=code_review&instance=d2f69e5f-12c7-56d9-be72-ef480dd5dbd9&attempt=1)`
  > `EVIDENCE conv-run-linkback: the part-of-run link landed on the Run Workbench with the source node selected in the graph and the conversation open in the dock`
  > `EVIDENCE conv-narrow-dialog: at 390x844 the new-conversation dialog sits inside the viewport and the document does not scroll horizontally`
- **Implementing work:** shared New conversation dialog with no workflow field (`c8f0768`);
  Manual vs "From run · <run> · <node>" badges, `?q=`/`?origin=` filters (`9ef281d`); pointer
  click on the badge navigating to the Workbench (`cf6a533`);
  keyboard-operable badge deep-linking (`c6fd527`, `1d29db9`).

## A8 — One genuine assistant draft action (checkbox 8) — PASS

> Use one genuine assistant-to-draft action that previews and highlights a change, requires
> authorization and does not publish automatically.

- **Spec test:** `issue2-studio.spec.ts` → `A8` (a real assistant proposal previewed and
  highlighted on the canvas, applied through the normal version-checked draft PUT, never
  published). Proven against the lab's **real collective model**, not a fake model.
- **Screenshots:** `studio-a8-proposed.png`, `studio-a8-applied.png`.
- **Evidence:**
  > `EVIDENCE studio-a8-proposed: the assistant's proposal previews on the canvas (highlighted node + caption) with the draft still at version 1 on the server — nothing saved, nothing published`
  > `EVIDENCE studio-a8-applied: Apply saved the assistant's edit: draft version 1 → 2, while the pipeline's revision count stayed at 2 (no publish)`
- **Implementing work:** `POST /api/v1/assistant/draft-proposals` — authorized exactly like the
  draft PUT, closed op set (insert_after, insert_on_edge, update_prompt), the server never writes
  or publishes (`33455ce`, ADR-0044); the UI applies the op through the same `graphDoc` ops a
  human gesture uses and offers no Publish (`98d984b`); highlight cleared only once the save
  resolves (`8b57cae`); real-model pinning of `chat_template_kwargs`
  `{enable_thinking: false}` (`7956010`).

## A9 — Preserved functionality, tests, a11y, screenshots (checkbox 9) — PASS

> Preserve existing functionality and URLs (or redirects), security, ACP/APM/sandbox behavior,
> event journal, and workflow compiler semantics. Tests include unit/contract tests, realistic
> browser journeys at desktop and narrow widths, accessibility checks, and recorded screenshots.

- **Preserved:** no Go scheduler/schema/compiler changes in `d25c788..bd89502` (UI-only plus the
  one documented assistant API, ADR-0044). `/library` and `/projects/:p/runs/:r` URLs unchanged;
  `?draft=` → Studio redirect and legacy `?tab=` → `?view=` mapping (`78ec5be`, `13f5a07`);
  the old RunInspector is preserved whole as the Workbench **Diagnostics** tab; M5 specs were
  migrated to the Studio/Workbench (`78ec5be`); no `data-testid` removed (enforced by
  `pnpm check:testids`).
- **M5 regression:** `m5.out` — **53 passed, 1 pre-existing fixme** (final6, freshly reset lab),
  including `m5-layout.spec.ts`'s no-horizontal-scroll matrix at 1500x950 and 390x844.
- **Unit/CI:** 991 UI tests and the full Go race suite green at `bd89502` (CI), on top of the
  `graphDoc` (60 tests), `Studio`, `RunWorkbench` and `AssistantProposalBox` suites.
- **Accessibility:** all 13 `A11Y` lines in `evidence.txt` report **0 violations** (wcag2a +
  wcag2aa, failing only on serious/critical): studio desktop/inspector (agent.acp and
  process.exec)/narrow, workbench graph view, ACP dock and viewer (carol), narrow workbench,
  conversations list (manual + run-linked), conversation page, run-linked conversation page,
  global New-menu dialog. WCAG AA contrast work: `9f0e720`, `4aaa7af` (status colours),
  `a5974b1` (inspector input names).
- **Screenshots:** the 37 full-page screenshots listed in Evidence cover every acceptance state,
  desktop 1500x950 and narrow 390x844 (`studio-narrow.png`, `wb-narrow.png`,
  `conv-narrow-dialog.png`).

## A10 — Design docs and ADRs (checkbox 10) — PASS

> Update relevant design docs and add ADRs for material decisions. No "done" based only on
> mockups, component tests, or a read-only graph.

- **Design docs:** checkpoint `docs/design/studio-workbench.md` (gap analysis, gestures,
  ambiguity rules, sync, IA) + mockups `docs/design/mockups/{studio,workbench,new-conversation}.html`
  (`d25c788`, `bbc507f`), kept current through the range (`78ec5be`); this record is the final
  acceptance evidence.
- **ADRs — now Accepted:** ADR-0042 (Workflow Studio graph authoring), ADR-0043 (Run Workbench
  graph-first, with the addendum on return-to-factory while a human turn is running) and ADR-0044
  (assistant draft proposals) each carry a one-line evidence pointer to this document.
- **Not mockups or read-only:** every journey above ran against the production embedded UI of a
  live lab with the real backend, real Claude agents and a real assistant model (`bd89502`).

## Bugs found and fixed BY the acceptance journeys

All commits in the issue-#2 range `d25c788..bd89502`:

| Commit | Bug found by the acceptance runs | Fix |
|---|---|---|
| `23fc4cc` | A Studio-inserted `agent.acp` step with a literal prompt inside an until loop failed with "agent.acp config has no prompt" — `configRelPath` took the first `/config/` in the plan pointer and nested the prompt under the scope body | literal config of a scope-body node now claims the **last** `config` in the pointer, matching the runtime's `ConfigTree`; failing-then-passing pointer + end-to-end hydration tests |
| `2afa9fd` | The run header read "queued" for the whole run after a gate resume — the frame fold mapped every `run.resumed` to `queued` | the fold now reads the frame's `paused_reason` (waiting_human → running); fixes the Workbench and Diagnostics headers |
| `2c84b9a` | The Workbench canvas went blank during a live run — rebuilds replaced React Flow node objects and dropped their `measured` sizes, so the nodes stayed `visibility: hidden` | rebuilds carry `measured` through; fitting uses measured sizes with the layout as fallback and never fits an unmeasured pane; tests pin both |
| `a28122e` | The auto-select latch closed on first data even when nothing needed attention, leaving the dock empty when a gate opened after load | the latch closes only once a node is selected; an earlier auto-pick moves to a later gate and never overrides a user or deep-linked selection |
| `d8e66b7` | Returning to the factory while the human's own turn was still running failed the retried attempt's claim on contract § 4 step 12's one-active-turn pairing (2 of 3 live takeover runs failed) | the retried attempt's claim waits (bounded, while it holds its lease) for the active human turn to finish; ADR-0016 § 5 forbids cancelling it and the contract defines no 409 for return-control; failing-then-passing tests at the worker and Postgres levels — see the ADR-0043 addendum |
| `4aaa7af` | Status colours missed WCAG AA (running 3.68:1, interrupted 2.96:1, done 3.53:1; chips at 75% opacity over strong bars 3.48:1), exposed by the live takeover journey's interrupted attempt panel | strong bars at 5.30–5.85:1 with white text, chips no longer blended; axe sweep of 18 screens zero serious/critical |
| `cf6a533` | A pointer click on the run-origin badge opened the conversation instead of the Workbench — the row anchor's default navigation won before `navigate` | `preventDefault` before navigate; unit test proven red before the fix |
| `136529c` | "Assign to a project" on the pipeline page had drifted below the fold (mounted only after the revisions query resolved), so the M5 journey raced app boot | the panel now sits in the rail beside Customize and the journey waits for whichever assign arm it offers |
| `5674a45` | The workbench takeover journey intermittently failed the dock attempt-2 tab check — since `d8e66b7` the retried attempt's claim legitimately waits for the human's turn to finish (1–2+ min), which the tab assertion raced | the spec now waits on the ledger for attempt 2 before asserting its dock tab, and a new unit test proves the dock itself grows its attempt tabs on refetch — the `final6` workbench run passed 5/5 and `wb-a5-returned.png` + its `EVIDENCE` line show attempt tabs 1 + 2 |
| `bd89502` | The run header could still read "queued" after a takeover return — a manual resume's journal frame pinned the folded status over a running run (follow-up to `2afa9fd`) | a journal frame may only move the folded run status forward from the refetched baseline (mirroring the server's run state machine); gate-resume mapping kept — live: paused(human_takeover) → running on every sample → completed, 0 mismatches |

## Known limitations

- **Lab authorization is single-tenant:** the Workbench spec provisions bob (contributor) and
  carol (viewer) directly on the seeded project; A5's read-only refusal and A8's proposal authz
  are proven against that lab membership (same-org users may request proposals, consistent with
  the draft PUT), not a multi-org deployment.
- **Screenshots live outside git:** by repo policy the 37 evidence screenshots stay in
  `~/.cache/communication-lab/issue2/final-evidence/` (gitignored); only `EVIDENCE` lines and
  this record are in the tree.
- **Narrow fallback is deliberate:** at 390x844 the Studio collapses to a step outline + focused
  inspector and the Workbench dock becomes a sheet (`studio-narrow.png`, `wb-narrow.png`).
- **Assistant op set is deliberately narrow:** one op per request from the closed set
  (insert_after, insert_on_edge, update_prompt) — not arbitrary graph surgery (ADR-0044).

## ADRs

- **ADR-0042** (`docs/adr/ADR-0042-workflow-studio-graph-authoring.md`) — **Accepted.**
  `@xyflow/react` for interaction, `yaml` Document API for comment-preserving text→text edits;
  graph positions in digest-excluded `metadata.ui`/`ui_layout`; A2's publish/reopen flow proves
  the digest/revision semantics. Evidence: this document (A1–A3, A8).
- **ADR-0043** (`docs/adr/ADR-0043-run-workbench-graph-first.md`) — **Accepted**, with the
  addendum *"return-to-factory while a human turn is running"* recording `d8e66b7`'s semantics.
  Evidence: this document (A4–A6).
- **ADR-0044** (`docs/adr/ADR-0044-assistant-draft-proposals.md`) — **Accepted.** Closed op set,
  apply through the normal version-checked PUT, never auto-publishes. Evidence: this document (A8).

**Final acceptance run: PASSED** — one consolidated pass (`final6`) on the lab built from HEAD
`bd89502`: issue2-studio 7/7, issue2-workbench 5/5, issue2-conversations 3/3, M5 regression 53
+ 1 pre-existing fixme on a freshly reset lab, 13/13 axe checks clean, 991 UI tests and the Go
race suite green at HEAD `bd89502`.
