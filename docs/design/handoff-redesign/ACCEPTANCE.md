# Redesign handoff — TASKS.md acceptance checklist with per-box evidence at HEAD

**Final code SHA: f2985ec** (HEAD, working tree clean). Its runs: **CI 42593536627** (success) and **Acceptance 42593536736** (success on the first attempt: lab-e2e 151/151; verification 107/107 in both passes, 170 screens, 0 defects; every m4 shard + regrade; github-loop). The verification loop files every failed test as a defect (907a578) and a screen guard files a defect for visible chat/conversation wording or `/inbox`|`/board` links on every captured screen (62f3602), so these greens cannot hide a failing test or a retired word.
**Design parity: see the final review recorded below.**
**Design parity (fresh independent reviewer, design | 1280 | 390 triptychs from Acceptance run 42593536736's verification captures of f2985ec):** Catch up (8a, incl. the big-backlog banner) PASS · piece of work (8b, incl. an in-stop decision) PASS · tour player (7b) PASS · collapsed rail (3a) PASS · Today (f03/f04/f08) PASS · Threads list PASS · Workflows index PASS · workflow page PASS · project header PASS · run page at a gate PASS · repository lanes PASS · project overview (shared DecisionBar) PASS — **OVERALL PASS**. Minor notes (not defects): ragged "Tour ›" placement on phone rest rows; no per-step timestamps on the player's labels; the project overview's "Running now" excludes gate-waiting runs that Today lists (pre-existing count semantics).

Box text below is quoted verbatim from `TASKS.md` (checkbox flipped to `[x]` with the evidence). "lab" = Acceptance lab-e2e job (specs in `e2e/tests/`), "verif" = verification emulator loop (specs in `e2e/emulator/`), "unit" = `pnpm --dir ui test` / `go test` in CI. Commits per box are from `git log 1baaf12..HEAD`.

## Phase 1: cleanup

### T1 · Rename conversations to "thread" (finding 01) — commits 66f9c8d, 1557f50, 2a1b7a7, a43a865, 7ccf0b4, 62f3602
- [x] `No visible "chat" or "conversation" remains (search ui/src for chat and onversation in JSX text and aria-labels).`
  - verif: the screen guard scans every captured screen's visible chrome for exactly these words — `e2e/emulator/screen-guard.ts:52` (`RETIRED_WORDS = ["chat", "chats", "conversation", "conversations"]`), wired into every capture at `e2e/emulator/fixtures.ts:566`; its own spec `e2e/emulator/reflow-screen-guard.spec.ts:35` (g1) files a defect per hit. 170 screens, 0 defects.
  - lab: `e2e/tests/shell-p1-shell.spec.ts:175` — the nav rows read Today, **Threads**, Workflows, Agents; `e2e/tests/issue2-conversations.spec.ts:242` — "the sidebar's **New thread**" dialog.
- [x] `/p/:id/conversations` redirects to `/p/:id/threads`.
  - lab: `e2e/tests/shell-p1-shell.spec.ts:220`/:225 seed the old URLs; the test at :179 asserts (:240) "the project-scoped p/<id>/conversations[/] lands on p/<id>/threads[/] (T1)" with query state preserved. Redirect routes: `ui/src/App.tsx:524`/:528.
- [x] `The API and types are unchanged.`
  - the UI still calls `/api/v1/conversations/{id}` and the `Conversation` type (`ui/src/api/conversations.ts:31`); CI contract keeps OpenAPI and generated types honest (`ui/package.json:9` `gen:api:check`). unit.

### T2 · Split Library (finding 02) — commits 835003f, 5c10e28, 6295af4
- [x] `The sidebar shows Workflows and Agents as rows, with no LIBRARY label.`
  - lab: `e2e/tests/shell-p1-shell.spec.ts:166` (`getByText("LIBRARY")` count 0), :169 (`sidebar-link-workflows`), :175 (the four nav rows include Workflows and Agents; no Steps row).
- [x] `Steps is a tab on the Workflows page, and the old route redirects.`
  - lab: `e2e/tests/shell-p4-library.spec.ts:271` (the registry at `/workflows/steps`); redirect `e2e/tests/shell-p1-shell.spec.ts:189` (`/steps` → `/workflows/steps`).
- [x] `/p/:id/pipelines` redirects to `/p/:id/workflows`.
  - lab: `e2e/tests/shell-p1-shell.spec.ts:199` seeds `/p/<id>/pipelines`; the :240 assertion covers it ("all … legacy URLs … land on their canonical URLs").

### T3 · Today dead ends (finding 03) — commits 22a5823, fcc5edc, 835003f, a43a865, bd0c9c8
- [x] `"Show {n} more" expands in place, and nothing links to /inbox or /board.`
  - lab: `e2e/tests/shell-p2-home-board.spec.ts:153` — exact `Show n more` text only while gates overflow (:230–243), and expanding shows every pending gate with the button gone (:259–274).
  - verif: the same guard's g2 (`e2e/emulator/reflow-screen-guard.spec.ts:48`, `screen-guard.ts` routes) files a defect for any visible `/inbox`|`/board` link on any captured screen — 0 across 170 screens. The Inbox/Board pages themselves are deleted (bd0c9c8).
- [x] `/inbox` and `/board` redirect to `/`.
  - lab: `e2e/tests/shell-p1-shell.spec.ts:179`/:240 — "/inbox and /board land on Today".
- [x] `Empty-state Start run opens the new-run dialog.`
  - verif: `e2e/emulator/catchup.spec.ts:1269` ("today empty" test) — clicks `home-start-run` (:1318) and asserts the `home-start-run-dialog` with its "Start a run" title (:1325–1333).

### T4 · Page layout prop (finding 07) — commits 89c2c4c, 19ed63a, ca2a1f9, 8f6f378, 965b078
- [x] `<Page layout="reading|wide|canvas">` exists, and the regex list is deleted.
  - `ui/src/components/ds/Page.tsx` + unit `ui/src/components/ds/Page.test.tsx:26`; `grep -rn workbenchBleed ui/src` has no hits; lab `e2e/tests/m5-layout.spec.ts:361–368` — every screen's main root carries a `data-page-layout` that is one of the three layouts.
- [x] `Title baseline and left edge are identical across Today, Projects, Threads, the Workflow page and Settings at 1440px.`
  - lab: `e2e/tests/shell-p1-shell.spec.ts:773` ("at 1440x900 the band title's left edge and baseline do not move between routes").
- [x] `Phone layout starts below 768px. From 768 to 1023px, the collapsed rail shows instead of the drawer.`
  - lab: `e2e/tests/shell-p1-shell.spec.ts:643` ("the phone frame ends at 768px: 767 is the drawer, 768 is the rail") and :568 ("at 900x800 the rail is forced and the stored preference is untouched").

### T5 · ⌘K search, ⌘J floating Ask (findings 08 and 10) — commits 43b8d28, f9b053a, 8f6f378, 4333a74
- [x] `The sidebar has a "Search ⌘K" field-button. ⌘K always opens search / jump.`
  - source: `ui/src/components/Sidebar.tsx:353` (`data-testid="sidebar-search"`); lab: `e2e/tests/shell-p1-shell.spec.ts:494` (⌘K opens the palette) and :541–549 (the sidebar's Search field opens the jump palette, Escape closes).
- [x] `A floating "Ask ⌘J" button sits bottom-right on every page. ⌘J opens Ask, and Ask opens via an explicit function, not a synthetic keydown.`
  - lab: `e2e/tests/shell-p1-shell.spec.ts:494` — the floating `ask-fab` and ⌘J both open the assistant popover (:525/:538); :825 — "⌘J opens Ask from the Threads and Workflow pages, not just Today"; :295 — "Ask is the ⌘J float on every page". Explicit opener: `ui/src/components/assistant/askControl.ts:13` (`openAsk(context?)`, replacing Sidebar's synthetic-keydown path).
- [x] `The askPlacement pref is removed.`
  - `ui/src/lib/prefs.ts:35` documents the key as cut; no code reads it (grep hits are comments only); unit `ui/src/lib/prefs.test.ts`; lab proof under T7 below.

### T6 · Project actions to the header (finding 09) — commits 7061572, ca2a1f9
- [x] `No hover-only ⋯ on sidebar project rows.`
  - verif: `e2e/emulator/repo-chat-nav.spec.ts:1605–1606` — `sidebar-project-menu` is "gone, not merely hidden" (test at :1562); retirement recorded with its reason in `ui/scripts/retired-testids.json:116`.
- [x] `The project header has "+ Repository" (opens the dialog) and "Settings" (with a Members tab).`
  - verif: `e2e/emulator/repo-chat-nav.spec.ts:1615`/:1617 (`+ Repository` is a project-header action, exact verb), :1639 (opens the add-repository dialog in place), :1678–1687 (Settings | Members tab strip on the settings page). unit `ui/src/components/project/ProjectHeader.test.tsx`.

### T7 · Cut sidebar prefs (finding 10) — commits 43b8d28, bd0c9c8, 7b313a3
- [x] `projectsMode and showWorkflowFolders are gone, and ProjectSwitcher is deleted.`
  - `grep -rn ProjectSwitcher ui/src` has no hits; `ui/src/lib/prefs.ts:35` names all three keys as cut; the unused `ProjectsMode`/`AskPlacement` types were deleted in bd0c9c8; unit `ui/src/components/Sidebar.test.tsx:366` ("the switcher component does not exist").
- [x] `Old stored values are ignored without errors.`
  - lab: `e2e/tests/shell-p1-shell.spec.ts:347` — "T7 — an OLD stored preferences document (the retired layout keys) still loads today's shell" (page-error watch in the test body); unit `ui/src/lib/prefs.test.ts:6–7` drives today's layout off a doc that still carries the retired keys.

### T8 · Run header (finding 11) — commits 4405617, 21bb415, 6727bc0, 75fab24, 861deef
- [x] `Layout is breadcrumb, title + state chip + one primary action + ⋯, then the labeled facts row.`
  - verif: `e2e/emulator/run-gate-artifacts.spec.ts:357` — "T8 — the header's breadcrumb, its title+chip row and the facts row": :368–375 (breadcrumb is exactly the two links), :386–405 (title and state chip share ONE row), :420–436 (each fact is a `<dt>/<dd>` pair read by its own label); the ⋯ trigger is asserted part of every run header at :46. unit `ui/src/components/workbench/RunHeader.test.tsx:219` (chip baseline-locked on the title's row).
- [x] `The primary action follows run state (waiting → Review, failed → Retry step, running → Pause).`
  - waiting: verif `e2e/emulator/run-gate-artifacts.spec.ts:338–343` (the ONE primary is `run-review-plan`, text "Review plan"); running: the helper at :72–83 asserts a running run draws no Review plan and its primary elsewhere, sampled while the API says running (6727bc0); failed: lab `e2e/tests/home-cluster.spec.ts:1291–1301` (`run-retry` worded "Retry step"). unit `RunHeader.test.tsx:161–243` (all four states).
- [x] `Stream status shows only when it isn't live.`
  - lab: `e2e/tests/issue2-workbench.spec.ts:1077–1082` — mid-run reload with a live stream: `run-stream-status` count stays 0. unit `RunHeader.test.tsx:359`.

### T9 · Copy pass (finding 12) — commits 8351d11, a43a865, bb92a40, 116ee49, bd0c9c8, f2985ec
- [x] `The four rewrites in finding 12 are applied word for word.`
  - unit: `ui/src/test/finding12.copy.test.tsx` reads the `REWRITE` lines straight out of `docs/design/handoff-redesign/findings/f12.txt` (:59/:66–73) and asserts the rendered components match word for word — Home :189, RunNotFound :203, DecisionBar :222/:253. lab m4 W9: `e2e/m4/test_w_logic.py:895` ("Back to Runs … Ask for access").
- [x] `Search for "control plane", "server build", "scaffold", "404", "decision word" and "winner" in JSX text, and rewrite every hit.`
  - the remaining grep hits in `ui/src` are doc comments (e.g. `ui/src/components/m4/NewRunForm.tsx:235`), test titles (`RunHeader`-area tests) and the generated API description — none is rendered copy; every visible chrome string on all 170 captured screens carries 0 guard defects (`screen-guard.ts` + `fixtures.ts:566`). bd0c9c8 dropped the last "control plane" from the M4 preview page.
- [x] `The rulebook is added to docs/design/design-system.md.`
  - `docs/design/design-system.md:284` — "## On-screen copy (finding 12 rulebook)".

## Phase 2: DecisionBar

### T10 · DecisionBar with undo (finding 04) — commits 3c965b7, 2de357b, 8010d59, 700aa25, bb92a40, bd0c9c8, f2985ec
- [x] `Buttons are Approve, Request changes and Reject, with no confirm step.`
  - lab: `e2e/tests/shell-p789.spec.ts:1424–1426` (the three fixed verbs, exact names) and :1432/:1456 ("the bar offers its three fixed verbs and nothing else while it is idle"; no model-written label on a button). unit `ui/src/components/ds/DecisionBar.test.tsx:218`.
- [x] `The POST is held for 5s behind an "Approved. The run continues in 5s. Undo" toast. Undo sends nothing.`
  - lab: `e2e/tests/shell-p2-home-board.spec.ts:334` — waits past the 5s hold plus margin, then :395 asserts "Undo cancels the hold with zero POST /api/v1/approvals and the gate still serves as pending". Every journey decides through `decideGate` (`e2e/tests/helpers.ts:67`), which asserts the counting-down hold line (`… The run continues in \d+s.`) and "the gate is decided exactly once" (:150). unit `DecisionBar.test.tsx:61/:83`.
- [x] `A conflict shows "{Name} approved this {age} ago. Your decision wasn't recorded."`
  - verif: `e2e/emulator/gate-decision-conflict.spec.ts:323` (T10a Today — the loser's callout names the winner and stays until dismissed) and :703 (T10b the Approval page); the sentence parts and the age grammar (f2985ec) are asserted at :606–616 (`/approved this (\d+ seconds?|\d+[mhd]|a moment) ago\./`) and :922. unit `DecisionBar.test.tsx:109` (a cache update to decided-by-B during the hold sends nothing and names B), :242/:294/:363.
- [x] `The "not a decision word" path is deleted.`
  - `grep -rn "decision word" ui/src` hits nothing user-visible; the old per-card verb buttons are retired with reasons in `ui/scripts/retired-testids.json:86–89`.

## Phase 3: collapsed rail

### T11 · Rail redesign (3a + 4a) — commits 4879199, 2c3fe3a, 8be6ef8, 8eb0f88, a43a865, 7b313a3
- [x] `Icons only, per README Part B. railInitials is deleted.`
  - `grep -rn railInitials ui/src` has no hits. lab: `e2e/tests/shell-p1-shell.spec.ts:599–602` (the icon tiles `rail-item-workflows` / `rail-item-agents`, old library tile gone); verif drives the full icon set in the rail journey (`e2e/emulator/catchup.spec.ts:634`).
- [x] `Hover shows a dark label with an arrow. Click opens a popover with an arrow and keyboard support.`
  - lab: `e2e/tests/shell-p1-shell.spec.ts:671` — hover prints `rail-tooltip` (:686) and :701–703 asserts the `rail-tooltip-arrow` exists and carries the same ink colour; :931 — the Projects popover walks on ↓ and navigates on Enter, and :948 asserts the `ds/Popover` `menu-arrow` square facing the trigger.
- [x] `Expand works three ways: the button, ⌘\, and dragging the edge (snaps at about 120px).`
  - lab: `e2e/tests/shell-p1-shell.spec.ts:671` (⌘\ collapses and re-expands, restoring the saved preference — the expanded column's collapse button is asserted in the verif step at `e2e/emulator/catchup.spec.ts:868`); :861 — "dragging the edge handle past ~120px snaps the column open, back below snaps the rail shut".
- [x] `Badges use the state colors.`
  - unit: `ui/src/components/Sidebar.test.tsx:610–629` (Threads rail badge `bg-st-running-tag`/`text-st-running-tag-fg`), :638–651 (Projects tile carries the waiting state, `bg-st-waiting-tag`), :197–211 (Catch up row's `{n} unseen` in the accent ink), :538 (rail badges carry the expanded rows' own counts). verif: `e2e/emulator/catchup.spec.ts:855–896` — the rail's Catch up badge equals the expanded column's unseen count on screen.

## Phase 4: Catch up

### T12 · Data model and API (backend) — commits 9e9cdca, 8d71913, a6bf1bf, ed8a3a7, 47266ed, 1923a2f, 55a8c4c (migrations 00028/00029, ADR-0078)
- [x] `WorkItem has: id, project, shape (issue|pr|push), refs, resolution, timestamps, and grouping done by the assistant.`
  - unit: closed vocabularies and WorkItem validation — `internal/domain/catchup_test.go:20`/:54 (shape constants `internal/domain/catchup.go:33–35`; the assistant proposes, the server's derivation wins, :23–26 — pinned by `internal/assistant/catchup_gen_test.go:328`/:370). Grouping is server-side per ADR-0078 § Grouping: `internal/store/postgres/catch_up_test.go:1191` (runs on one issue/PR become ONE piece), `internal/store/postgres/migrations/00029_catch_up_grouping.sql`.
- [x] `Tour (one per WorkItem) has versions and stops: title, narrative, evidence[], kind, importance, and an optional decision {prompt, options[], allowText}.`
  - unit: `internal/store/postgres/catch_up_test.go:134` (seen across versions), :277 (stop evidence round-trip), :426 (version atomicity); `internal/api/catch_up_test.go:344` (the item's wire shape); decision options bounded — `internal/domain/catchup_test.go:131`.
- [x] `Seen has user, workItem and tourVersion. There is a "mark all seen" endpoint.`
  - unit: `internal/store/postgres/catch_up_test.go:305` (mark-all-seen), `internal/api/catch_up_test.go:458` (seen-all scopes to my projects); endpoints `api/openapi.yaml:1063`/:1132. lab: `e2e/tests/catchup-lab.spec.ts:712` (leg 3, over HTTP: every stop reads `seen`, :752).
- [x] `A decision reply posts plain text back to the agent session.`
  - unit: `internal/api/catch_up_test.go:593` ("TestCatchUpReplyGoesToTheConversation"; :622/:718/:753 the honest no-session/busy/not-controller states). lab: `e2e/tests/catchup-lab.spec.ts:789` (leg 4) — the clicked option "Change to 12h" arrives as the thread's next user turn: :915 asserts the agent's active turn prompt is exactly `"Change to 12h"`.
- [x] `Endpoints: list unseen work items (filter by projects and window), get a work item with its tour, generate the recap for a user, get the catch-up tour for a user, and "see more" (up to 4 more stops).`
  - contract: `api/openapi.yaml` — :865 items (window/project/`include_seen` filters, unit `internal/api/catch_up_test.go:223`/:295), :1014 item with tour, :1251 recap, :948 tour; "See more" is the tour read at the next offset, 4 stops a page (`internal/api/catch_up.go:337–338`). lab legs 1–3 drive these over HTTP (`e2e/tests/catchup-lab.spec.ts:396`/:607/:712); UI types generated + CI `gen:api:check`.
- [x] `Write an ADR if the journal or event model changes.`
  - `docs/adr/ADR-0078-catch-up-work-items-and-tours.md` (§ Grouping :185, § Trigger :264, § Structure and importance :327, § Patch artifacts :593); migrations 00028 + 00029.

### T13 · Tour generation (agent side) — commits 21de9d3, 1923a2f, 8d2bdb1, ed8a3a7, 47266ed
- [x] `When a run finishes or a piece of work changes, write or rewrite its tour.`
  - lab: `e2e/tests/catchup-lab.spec.ts:396` (leg 1) — a REAL finished run in the lab produces the tour the API serves. unit: the pass honours cooldown/caps (`internal/assistant/catchup_gen_test.go:421`/:448/:472`), a changed piece rewrites as a NEW version keeping stop ids (`internal/store/postgres/catch_up_test.go:1191`, :426); the background sweep claims newest-first (`internal/store/postgres/catch_up_sweep_test.go:49`/:201); a run is only claimed once its version is written.
- [x] `Bug stories follow found → cause → fixed → follow-up, using logs and the session.`
  - unit: the prompt demands the story from the run's node outcomes and its agent conversation tail (`internal/assistant/catchup_gen.go:1031–1033`), the server enforces the order (:1488–1515) and re-asks exactly once — `internal/assistant/catchup_gen_test.go:1164–1200` (one repair turn, story order checked, honest note otherwise). Evidence only from excerpts the server showed it: `catchup_gen_test.go:199`.
- [x] `Assign importance using the signals in README "Open decisions" #2 (confirm first).`
  - the README signals are used as proposed: the prompt ranks with them (`catchup_gen.go:1035`) and the server floors a stop carrying one at must_know — `internal/assistant/catchup_gen_test.go:1333–1391` tests each signal (migration, auth, public API, dependency, weakened test, push to main, revert) names itself in the reason; ADR-0078 § Structure and importance (:327).

### T14 · Catch up page (8a) — commits fb13d5f, 43b8d28, 9035683, 6db6fe4, fff288d, fdaafe7, 75fab24
- [x] `Route /catch-up, plus a sidebar row and rail icon with an "{n} unseen" badge.`
  - lab: `e2e/tests/catchup-lab.spec.ts:607` (leg 2 — the piece is unseen in the badge and on /catch-up). verif: `e2e/emulator/catchup.spec.ts:648–672` (the 8a screen), :855–896 (rail badge = the column's unseen count). unit `ui/src/components/Sidebar.test.tsx:198`.
- [x] `Filters (project checkbox chips with color squares, window chips with unseen as the default), the recap, the tour cards with a See more card, and "The rest" list with how-it-landed labels and UPDATED tags.`
  - verif: `e2e/emulator/catchup.spec.ts:649–672` (chips, recap, Start the tour, See more), :715 (the rest lists only pieces with no stop in the cards), :1671–1765 (each rest row's how-it-landed label, resolution chip and project colour square checked against the row's seeded data), :1884 (UPDATED tag), :1113 (on the wire: 24h chip sends `since`, show-seen sends `include_seen`). unit `ui/src/pages/CatchUp.test.tsx:257`/:271/:301, `ui/src/components/catchup/RestList.test.tsx`.
- [x] `The big-backlog banner appears when the unseen count is over a threshold. The suggested window comes from visit frequency.`
  - verif: `e2e/emulator/catchup.spec.ts:1526` — a labelled fixture seeds >12 unseen over several days plus a daily visit history; the banner's counts are asserted against the served list, `Last 24h` moves the read's `since`, `Keep all` dismisses (banner arithmetic from visits: :1399–1402). unit `ui/src/pages/CatchUp.test.tsx:345` (past 12 unseen, not at 12).
- [x] `Items leave the page when seen. "Show seen" brings them back.`
  - lab: `e2e/tests/catchup-lab.spec.ts:712` (leg 3 — after every stop reads seen the item is gone from the unseen list, the rest row and the tour cards, :777). verif: `e2e/emulator/catchup.spec.ts:937` (mark all seen empties the pass's rows) and :1884 (show seen brings a paid piece back).

### T15 · Piece of work page (8b) — commits 2c981e7, be5ce84, 47d4119, 6daca66, 7b313a3
- [x] `Three columns: stops, current stop, tour history.`
  - verif: `e2e/emulator/catchup.spec.ts:721–738` ("8b — /catch-up/{bug}: stop list, current stop, history", the `cu-8b` screen). unit `ui/src/pages/CatchUpItem.test.tsx:307` (header row and the stop-list column keep their headings; full-height columns per be5ce84).
- [x] `Seen-by avatars, "you have not seen the {time} update", and a Copy link button.`
  - verif: `e2e/emulator/catchup.spec.ts:2231` (T15 piece page — seen-by names the other reader, the update sentence fires, Copy link copies via the clipboard). unit `ui/src/pages/CatchUpItem.test.tsx:187` (names the update the reader has not seen) and :421 (Copy link → clipboard → "Copied").

### T16 · Tour player (7b) — commits ccfebe6, be5ce84, 8f6f378, b714cd9, 2de357b, 75fab24, 7b313a3
- [x] `Full screen, segmented progress with a dashed see-more segment, and a stop list.`
  - verif: `e2e/emulator/catchup.spec.ts:797–839` — on screen, the done segment, the current segment (accent fill) and the upcoming ones are asserted per stop (7b313a3). unit `ui/src/pages/TourPlayer.test.tsx:198–201` (the last segment is `border-dashed` for see-more), :424 (stop list full height, its see-more entry counts what is left).
- [x] `Narrative steps with state tints, a dark log block, and diffs.`
  - unit: `ui/src/components/catchup/Evidence.test.tsx:20–35` (the log renders as the dark `bg-ink` block with its header strip), :39 (diff `+`/`−` lines tinted, sign glyphs kept), files in mono (:59). verif: the fixture's log/files/diff-shaped evidence payloads (`e2e/emulator/catchup.spec.ts:130–187`) render inside the captured `cu-8b`/`cu-7b` frames.
- [x] `Decisions in stops render the model's options as buttons, and the choice posts plain text to the agent.`
  - lab: `e2e/tests/catchup-lab.spec.ts:789` (leg 4, SEEDED FIXTURE) — `catchup-decision-option-1` ("Change to 12h") clicked (:868–894) arrives as exactly that user turn (:915). verif: `e2e/emulator/catchup.spec.ts:741–758` (the decision stop renders; with no agent session the click says honestly nobody was notified).
- [x] `Moving on marks the stop seen. ⌘J opens Ask with the stop as context.`
  - verif: `e2e/emulator/catchup.spec.ts:1180` — "ArrowRight walks to the next beat (and pays the one it leaves)"; S pays the current stop proven on `GET /catch-up/items/{id}`, not the label. ⌘J opens the assistant about the stop (same test; the player mounts the popover itself through `openAsk` — 8f6f378). unit `ui/src/pages/TourPlayer.tsx:13–17` documents the stop-level marking.
- [x] `Keys: ←/→ move between stops, S marks seen, Esc closes.`
  - verif: `e2e/emulator/catchup.spec.ts:1180` — the whole key contract on the keyboard piece: S seen on the store read, → moves and leaves the previous narrative, ← walks back, Esc closes, ⌘J asks.

## Known, recorded limits
- Request changes records a rejection with comments — the decide API knows only `approved` | `rejected` (`e2e/tests/helpers.ts:31`/:134–137: "Request changes" posts `{decision: "rejected", comments}` and the note is read back).
- A stop's diff can only come from the worker's bounded, secret-scoped `patch` artifact (ADR-0078 § Patch artifacts, `internal/worker/attempt_patch.go`/`unit_patch.go`), and it appears in a tour only when the model cites one. The artifact itself is proven deterministically in lab leg 1 (`e2e/tests/catchup-lab.spec.ts:521–589`): the run edits a file, the spec lists that run's artifacts filtered to `kind === "patch"` (:538) and FAILS if a finished run that moved the workspace filed none (:553); it asserts a cited diff excerpt can never exist without a filed patch (:568–572) and that a filed patch stores bytes (:589); whether the tour cited one is logged (:562).
