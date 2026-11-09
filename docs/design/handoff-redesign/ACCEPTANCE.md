# Redesign handoff — TASKS.md acceptance checklist with per-box evidence at HEAD

**Final code SHA: 716f7b3** (HEAD, working tree clean). Acceptance run on this commit's successor (the commit that updates this file) is the final word; see its CI and Acceptance status in the commit history. **Previous full green — f2985ec:** **CI 42593536627** (success) and **Acceptance 42593536736** (success on the first attempt: lab-e2e 151/151; verification 107/107 in both passes, 170 screens, 0 defects; every m4 shard + regrade; github-loop). Since that run 18dbcba added six more verification specs (screen-guard rule (c) + its g7–g9 tests, Today's word-for-word f12 note, the rail badge colour proof, the tour player's colour proof) and a `cu-7b diff` capture, 006c414 rewrote the last two implementation-voiced diagnostics strings, and 716f7b3 (HEAD) stabilised the Catch up page unit tests to wait for the state they assert (segment states, counts, chips, the `?stop=` pick) instead of reading the DOM right after an interaction — the successor's green covers all of them; its test and screen counts will therefore exceed f2985ec's. The verification loop files every failed test as a defect (907a578); the screen guard files a defect for visible chat/conversation wording or `/inbox`|`/board` links on every captured screen (62f3602) and — since 18dbcba — for finding 12's implementation words ("control plane", "server build", "scaffold", "decision word", "winner", a bare 404/409/500/503 read as prose) (`e2e/emulator/screen-guard.ts:82–97`), so these greens cannot hide a failing test or a retired word.
**Design parity: see the final review recorded below.**
**Design parity (fresh independent reviewer, design | 1280 | 390 triptychs from Acceptance run 42593536736's verification captures of f2985ec — the UI is unchanged since except the copy on two diagnostics strings, 006c414):** Catch up (8a, incl. the big-backlog banner) PASS · piece of work (8b, incl. an in-stop decision) PASS · tour player (7b) PASS · collapsed rail (3a) PASS · Today (f03/f04/f08) PASS · Threads list PASS · Workflows index PASS · workflow page PASS · project header PASS · run page at a gate PASS · repository lanes PASS · project overview (shared DecisionBar) PASS — **OVERALL PASS**. Minor notes (not defects): ragged "Tour ›" placement on phone rest rows; no per-step timestamps on the player's labels; the project overview's "Running now" excludes gate-waiting runs that Today lists (pre-existing count semantics).

Box text below is quoted verbatim from `TASKS.md` (checkbox flipped to `[x]` with the evidence). "lab" = Acceptance lab-e2e job (specs in `e2e/tests/`), "verif" = verification emulator loop (specs in `e2e/emulator/`), "unit" = `pnpm --dir ui test` in CI. Backend boxes (T12/T13) say "Go": that is the Go test suite run by CI's `go` job against a real PostgreSQL 18.6 — `.github/workflows/ci.yml:64` (job `go`), `COMMUNICATION_TEST_DATABASE_URL:79`, service `postgres:18.6` at :82–83, `go test -race -p 1 ./...` at :370–382, and a gate that fails the build on ANY skipped test (:391–392, `.github/scripts/check-go-test-skips.py`) — so those tests running for real against the database IS "proven on CI", never a mock. Commits per box are from `git log 1baaf12..HEAD`.

## Phase 1: cleanup

### T1 · Rename conversations to "thread" (finding 01) — commits 66f9c8d, 1557f50, 2a1b7a7, a43a865, 7ccf0b4, 62f3602
- [x] `No visible "chat" or "conversation" remains (search ui/src for chat and onversation in JSX text and aria-labels).`
  - verif: the screen guard scans every captured screen's visible chrome for exactly these words — `e2e/emulator/screen-guard.ts:74` (`RETIRED_WORDS = ["chat", "chats", "conversation", "conversations"]`), wired into every capture at `e2e/emulator/fixtures.ts:586`; its own spec `e2e/emulator/reflow-screen-guard.spec.ts:40` (g1) files a defect per hit. 0 defects across f2985ec's 170 screens; rule (c) (18dbcba) adds the finding-12 words to the same scan — its green arrives with the successor's run.
  - lab: `e2e/tests/shell-p1-shell.spec.ts:175` — the nav rows read Today, **Threads**, Workflows, Agents; `e2e/tests/issue2-conversations.spec.ts:242` — "the sidebar's **New thread**" dialog.
- [x] `/p/:id/conversations` redirects to `/p/:id/threads`.
  - lab: `e2e/tests/shell-p1-shell.spec.ts:220`/:225 seed the old URLs; the test at :179 asserts (:240) "the project-scoped p/<id>/conversations[/] lands on p/<id>/threads[/] (T1)" with query state preserved. Redirect routes: `ui/src/App.tsx:524`/:528.
- [x] `The API and types are unchanged.`
  - the UI still calls `/api/v1/conversations/{id}` and the `Conversation` type (`ui/src/api/conversations.ts:31`); CI contract keeps OpenAPI and generated types honest (`ui/package.json:9` `gen:api:check`). contract — nothing visible to prove in a browser: the rename moved no bytes on the wire (T1's lab rows above show the same reads driving the renamed UI).

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
  - verif: the same guard's g2 (`e2e/emulator/reflow-screen-guard.spec.ts:53`, `screen-guard.ts` routes) files a defect for any visible `/inbox`|`/board` link on any captured screen — 0 across f2985ec's 170 screens. The Inbox/Board pages themselves are deleted (bd0c9c8).
- [x] `/inbox` and `/board` redirect to `/`.
  - lab: `e2e/tests/shell-p1-shell.spec.ts:179`/:240 — "/inbox and /board land on Today".
- [x] `Empty-state Start run opens the new-run dialog.`
  - verif: `e2e/emulator/catchup.spec.ts:1330` ("today empty" test) — clicks `home-start-run` (:1379) and asserts the `home-start-run-dialog` with its "Start a run" title (:1386–1394).

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

### T9 · Copy pass (finding 12) — commits 8351d11, a43a865, bb92a40, 116ee49, bd0c9c8, f2985ec, 18dbcba, 006c414
- [x] `The four rewrites in finding 12 are applied word for word.`
  - verif (browser): `e2e/emulator/empty-error.spec.ts:107` — "T9 — Today's server-version note reads finding 12 word for word" (18dbcba): the test reads the Today `REWRITE` line straight out of `docs/design/handoff-redesign/findings/f12.txt` in the browser, answers `GET /api/v1/approvals?status=pending` with a 404 problem, and asserts the rendered `home-not-available` note `toHaveText` the finding's sentence verbatim (:169), with the untouched count line still reading (:174–178); unrouting takes the note away, proving it answers the server's version and not a stuck render (:184–201). `e2e/emulator/empty-error.spec.ts:263` — "T9 — /runs/<random uuid> shows the RunNotFound copy with its two exits": the RunNotFound sentence and the quotable id asserted `toHaveText` verbatim in the browser (:285–295).
  - unit: `ui/src/test/finding12.copy.test.tsx` reads the `REWRITE` lines straight out of `docs/design/handoff-redesign/findings/f12.txt` (:59/:66–73) and asserts the rendered components match word for word — Home :189, RunNotFound :203, DecisionBar :222/:253. lab m4 W9: `e2e/m4/test_w_logic.py:895` ("Back to Runs … Ask for access").
- [x] `Search for "control plane", "server build", "scaffold", "404", "decision word" and "winner" in JSX text, and rewrite every hit.`
  - verif (browser, 18dbcba): the screen guard's rule (c) files a `retired-ia` defect for every one of these words on every captured screen — `e2e/emulator/screen-guard.ts:82–88` (`IMPLEMENTATION_PHRASES`), :97 (`BARE_STATUS_CODES = ["404", "409", "500", "503"]`, prose-bounded so ids, digests and JSON numbers never hit), matching at :261–306, wired into every capture at `e2e/emulator/fixtures.ts:586–599`; the guard's own spec `e2e/emulator/reflow-screen-guard.spec.ts:190` (g7 files the phrases + the prose 404), :228 (g8 shares rule (a)'s exclusions — code font, model/person text and numbers inside data never file), :279 (g9 rules file alone, a clean page files nothing). This green arrives with the successor's run (f2985ec's 170-screen 0-defect pass predates rule (c)).
  - 006c414 rewrote the last two implementation-voiced strings: the no-attempt dock line now says "This step failed before an agent started … The run's Diagnostics tab has the details" (`ui/src/components/workbench/WorkbenchDock.tsx:597–602`, unit `WorkbenchDock.test.tsx:687–689`) and Running now's note says "Step progress can't load on this server version — … Ask an admin to update." (`ui/src/components/project/RunningNow.tsx:129–130`, unit `Project.test.tsx:637`). The remaining `control plane`/`server build` grep hits in `ui/src` are doc comments (e.g. `ui/src/components/m4/NewRunForm.tsx:235`), test titles and the generated API description — none is rendered copy; bd0c9c8 dropped the last one from the M4 preview page.
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
  - verif (browser, 18dbcba): "decision word" is one of the screen guard's `IMPLEMENTATION_PHRASES` (`e2e/emulator/screen-guard.ts:86`) — any captured screen that prints it files a defect (g7, `e2e/emulator/reflow-screen-guard.spec.ts:190`).

## Phase 3: collapsed rail

### T11 · Rail redesign (3a + 4a) — commits 4879199, 2c3fe3a, 8be6ef8, 8eb0f88, a43a865, 7b313a3, 18dbcba
- [x] `Icons only, per README Part B. railInitials is deleted.`
  - `grep -rn railInitials ui/src` has no hits. lab: `e2e/tests/shell-p1-shell.spec.ts:599–602` (the icon tiles `rail-item-workflows` / `rail-item-agents`, old library tile gone); verif drives the full icon set in the rail journey (`e2e/emulator/catchup.spec.ts:695`, rail step at :1034).
- [x] `Hover shows a dark label with an arrow. Click opens a popover with an arrow and keyboard support.`
  - lab: `e2e/tests/shell-p1-shell.spec.ts:671` — hover prints `rail-tooltip` (:686) and :701–703 asserts the `rail-tooltip-arrow` exists and carries the same ink colour; :931 — the Projects popover walks on ↓ and navigates on Enter, and :948 asserts the `ds/Popover` `menu-arrow` square facing the trigger.
- [x] `Expand works three ways: the button, ⌘\, and dragging the edge (snaps at about 120px).`
  - lab: `e2e/tests/shell-p1-shell.spec.ts:671` (⌘\ collapses and re-expands, restoring the saved preference — the expanded column's collapse button is asserted in the verif step at `e2e/emulator/catchup.spec.ts:929`); :861 — "dragging the edge handle past ~120px snaps the column open, back below snaps the rail shut".
- [x] `Badges use the state colors.`
  - verif (browser, 18dbcba): `e2e/emulator/catchup.spec.ts:1558` — "T11 — the collapsed rail's badges are painted in the state token colours" checks the computed background of the live rail badges, not a class name: the token hexes are read out of `ui/src/styles/tokens.css` at run time (`tokenRgb`, :228) and the badges' painted ground is asserted against it — Today's badge = `st-waiting-tag` (:1652–1653), Catch up's badge = `accent-tint` (:1664–1665), Threads' badge = `st-running-tag` (:1678–1679). The badge states are seeded by answering the sidebar's own two reads through `page.route` (:1582–1583) — nothing is mutated and no screen is claimed.
  - unit: `ui/src/components/Sidebar.test.tsx:610–629` (Threads rail badge `bg-st-running-tag`/`text-st-running-tag-fg`), :638–651 (Projects tile carries the waiting state, `bg-st-waiting-tag`), :197–211 (Catch up row's `{n} unseen` in the accent ink), :538 (rail badges carry the expanded rows' own counts). verif (counts): `e2e/emulator/catchup.spec.ts:916–971` — the rail's Catch up badge equals the expanded column's unseen count on screen.

## Phase 4: Catch up

### T12 · Data model and API (backend) — commits 9e9cdca, 8d71913, a6bf1bf, ed8a3a7, 47266ed, 1923a2f, 55a8c4c (migrations 00028/00029, ADR-0078)
Every "Go" proof below is the named test in CI's `go` job: `go test -race -p 1 ./...` against the job's real PostgreSQL 18.6 service (`.github/workflows/ci.yml:64`/:79/:82–83/:370–382), with the any-skipped-test build failure (:391–392) guaranteeing these ran rather than mocked — that IS "proven on CI".
- [x] `WorkItem has: id, project, shape (issue|pr|push), refs, resolution, timestamps, and grouping done by the assistant.`
  - Go: closed vocabularies and WorkItem validation — `TestCatchUpVocabulariesAreClosed` (`internal/domain/catchup_test.go:20`), `TestCatchUpWorkItemValidation` (:54) (shape constants `internal/domain/catchup.go:33–35`; the assistant proposes, the server's derivation wins, :23–26 — pinned by `TestCatchUpGenerateDerivesResolutionAndShapeWhenOmitted` / `TestCatchUpGenerateServerFactsBeatUnfoundedClaims`, `internal/assistant/catchup_gen_test.go:328`/:370). Grouping is server-side per ADR-0078 § Grouping: `TestCatchUpGrouping` — runs on one issue/PR become ONE piece (`internal/store/postgres/catch_up_test.go:1191`, real PostgreSQL); migration `internal/store/postgres/migrations/00029_catch_up_grouping.sql`.
- [x] `Tour (one per WorkItem) has versions and stops: title, narrative, evidence[], kind, importance, and an optional decision {prompt, options[], allowText}.`
  - Go: `TestCatchUpSeenUnseenAcrossTourVersions` (`internal/store/postgres/catch_up_test.go:134`, seen across versions), `TestCatchUpStopEvidenceRoundTrip` (:277, evidence survives the real DB), `TestCatchUpVersionAtomicity` (:426); `TestCatchUpItemShape` (the item's wire shape, `internal/api/catch_up_test.go:344`); decision options bounded — `TestCatchUpDecisionOptionsAreBounded` (`internal/domain/catchup_test.go:131`).
- [x] `Seen has user, workItem and tourVersion. There is a "mark all seen" endpoint.`
  - Go: `TestCatchUpMarkAllSeen` (`internal/store/postgres/catch_up_test.go:305`), `TestCatchUpSeenAllScopesToMyProjects` (`internal/api/catch_up_test.go:458`); endpoints `api/openapi.yaml:1063`/:1132. lab: `e2e/tests/catchup-lab.spec.ts:712` (leg 3, over HTTP: every stop reads `seen`, :752).
- [x] `A decision reply posts plain text back to the agent session.`
  - Go: `TestCatchUpReplyGoesToTheConversation` (`internal/api/catch_up_test.go:593`; the honest no-session/busy/not-controller states — `TestCatchUpReplyWithNoConversation` :622, `TestCatchUpReplyBusyAgentIsConflict` :718, `TestCatchUpReplyNotControllerIsConflict` :753); the store half on real PostgreSQL — `TestCatchUpDecisionReply` (`internal/store/postgres/catch_up_test.go:491`). lab: `e2e/tests/catchup-lab.spec.ts:789` (leg 4) — the clicked option "Change to 12h" arrives as the thread's next user turn: :915 asserts the agent's active turn prompt is exactly `"Change to 12h"`.
- [x] `Endpoints: list unseen work items (filter by projects and window), get a work item with its tour, generate the recap for a user, get the catch-up tour for a user, and "see more" (up to 4 more stops).`
  - contract: `api/openapi.yaml` — :865 items (window/project/`include_seen` filters, Go `TestCatchUpListParsesFilters` / `TestCatchUpListRejectsBadFilters`, `internal/api/catch_up_test.go:223`/:295; recap on the DB — `TestCatchUpRecapAndVisits`, `internal/store/postgres/catch_up_test.go:573`), :1014 item with tour, :1251 recap, :948 tour; "See more" is the tour read at the next offset, 4 stops a page (`internal/api/catch_up.go:337–338`). lab legs 1–3 drive these over HTTP (`e2e/tests/catchup-lab.spec.ts:396`/:607/:712); UI types generated + CI `gen:api:check`.
- [x] `Write an ADR if the journal or event model changes.`
  - docs-only, and the ADR exists: `docs/adr/ADR-0078-catch-up-work-items-and-tours.md` — § Grouping (:185), § Trigger (:264), § Structure and importance (:327), § Patch artifacts (:593); migrations 00028 + 00029.

### T13 · Tour generation (agent side) — commits 21de9d3, 1923a2f, 8d2bdb1, ed8a3a7, 47266ed
As in T12, every "Go" proof is the named test run by CI's `go` job — the assistant/sweep store reads run against the job's real PostgreSQL 18.6 with the no-skips gate (`.github/workflows/ci.yml:64`/:79/:82–83/:370–382/:391–392).
- [x] `When a run finishes or a piece of work changes, write or rewrite its tour.`
  - lab: `e2e/tests/catchup-lab.spec.ts:396` (leg 1) — a REAL finished run in the lab produces the tour the API serves. Go: the pass honours cooldown/caps — `TestCatchUpPassHonoursPerRunCooldown` / `TestCatchUpPassCapsGenerationsPerPass` / `TestCatchUpPassHonoursGlobalModelCallCap` (`internal/assistant/catchup_gen_test.go:421`/:448/:472); a changed piece rewrites as a NEW version keeping stop ids — `TestCatchUpStableIdsAcrossARewrite` (:586), `TestCatchUpGrouping` + `TestCatchUpVersionAtomicity` (`internal/store/postgres/catch_up_test.go:1191`, :426); the background sweep claims newest-first against the real DB — `TestCatchUpSweepCandidatesAndClaimRead` / `TestCatchUpSweepCandidatesNewestFirst` (`internal/store/postgres/catch_up_sweep_test.go:49`/:201, header :3–4: "skipped unless COMMUNICATION_TEST_DATABASE_URL is set, run by CI — the only way either is actually known"); a run is only claimed once its version is written (sweep read, same file).
- [x] `Bug stories follow found → cause → fixed → follow-up, using logs and the session.`
  - Go: the prompt demands the story from the run's node outcomes and its agent conversation tail (`internal/assistant/catchup_gen.go:1031–1033`), the server enforces the order (:1488–1515) and re-asks exactly once — `TestCatchUpBugStoryReasksOnceWhenBeatsAreOutOfOrder` (`internal/assistant/catchup_gen_test.go:1166`, repaired story order checked, honest note otherwise) and `TestCatchUpBugStoryAcceptedWhenToldRight` (:1206). Evidence only from excerpts the server showed it: `TestCatchUpGenerateCopiesEvidenceTheServerWasShown` (:199).
- [x] `Assign importance using the signals in README "Open decisions" #2 (confirm first).`
  - the README signals are used as proposed: the prompt ranks with them (`catchup_gen.go:1035`) and the server floors a stop carrying one at must_know — `TestCatchUpImportanceFloorPerSignal` (`internal/assistant/catchup_gen_test.go:1338`) tests each signal (migration, auth, public API, dependency, weakened test, push to main, revert) names itself in the reason, and `TestCatchUpImportanceFloorHoldsWhenNotNeeded` (:1392) keeps it a floor not a veto; ADR-0078 § Structure and importance (:327).

### T14 · Catch up page (8a) — commits fb13d5f, 43b8d28, 9035683, 6db6fe4, fff288d, fdaafe7, 75fab24
- [x] `Route /catch-up, plus a sidebar row and rail icon with an "{n} unseen" badge.`
  - lab: `e2e/tests/catchup-lab.spec.ts:607` (leg 2 — the piece is unseen in the badge and on /catch-up). verif: `e2e/emulator/catchup.spec.ts:709–779` (the 8a screen), :916–971 (rail badge = the column's unseen count). unit `ui/src/components/Sidebar.test.tsx:198`.
- [x] `Filters (project checkbox chips with color squares, window chips with unseen as the default), the recap, the tour cards with a See more card, and "The rest" list with how-it-landed labels and UPDATED tags.`
  - verif: `e2e/emulator/catchup.spec.ts:709–733` (chips, recap, Start the tour, See more), :776 (the rest lists only pieces with no stop in the cards), :2026–2120 (each rest row's how-it-landed label, resolution chip and project colour square checked against the row's seeded data), :2239 (UPDATED tag), :1174 (on the wire: 24h chip sends `since`, show-seen sends `include_seen` — the click-level proofs at :1188–1221). unit `ui/src/pages/CatchUp.test.tsx:257`/:271/:306, `ui/src/components/catchup/RestList.test.tsx`.
- [x] `The big-backlog banner appears when the unseen count is over a threshold. The suggested window comes from visit frequency.`
  - verif: `e2e/emulator/catchup.spec.ts:1881` — a labelled fixture seeds >12 unseen over several days plus a daily visit history; the banner's counts are asserted against the served list, `Last 24h` moves the read's `since`, `Keep all` dismisses (the banner's own daysSince arithmetic applied to the wire's timestamps: :1753–1756; the API's own visits read answers 24h for the seeded daily rhythm: :1904). unit `ui/src/pages/CatchUp.test.tsx:358` (past 12 unseen, not at 12).
- [x] `Items leave the page when seen. "Show seen" brings them back.`
  - lab: `e2e/tests/catchup-lab.spec.ts:712` (leg 3 — after every stop reads seen the item is gone from the unseen list, the rest row and the tour cards, :777). verif: `e2e/emulator/catchup.spec.ts:998` (mark all seen empties the pass's rows) and :2239 (show seen brings a paid piece back).

### T15 · Piece of work page (8b) — commits 2c981e7, be5ce84, 47d4119, 6daca66, 7b313a3
- [x] `Three columns: stops, current stop, tour history.`
  - verif: `e2e/emulator/catchup.spec.ts:782–799` ("8b — /catch-up/{bug}: stop list, current stop, history", the `cu-8b` screen). unit `ui/src/pages/CatchUpItem.test.tsx:313` (header row and the stop-list column keep their headings; full-height columns per be5ce84).
- [x] `Seen-by avatars, "you have not seen the {time} update", and a Copy link button.`
  - verif: `e2e/emulator/catchup.spec.ts:2586` (T15 piece page — seen-by names the other reader, the update sentence fires, Copy link copies via the clipboard). unit `ui/src/pages/CatchUpItem.test.tsx:187` (names the update the reader has not seen) and :427 (Copy link → clipboard → "Copied").

### T16 · Tour player (7b) — commits ccfebe6, be5ce84, 8f6f378, b714cd9, 2de357b, 75fab24, 7b313a3, 18dbcba
- [x] `Full screen, segmented progress with a dashed see-more segment, and a stop list.`
  - verif: `e2e/emulator/catchup.spec.ts:848–901` — on screen, the upcoming segment (plain line) and the current one (accent fill) per stop (:862–863), and after `Next stop ›` pays, the done segment (`bg-ink`) and the new current one (:892–901; 7b313a3). unit `ui/src/pages/TourPlayer.test.tsx:193`/:205–208 (the last segment is `border-dashed` for see-more), :454 (stop list full height, its see-more entry counts what is left).
- [x] `Narrative steps with state tints, a dark log block, and diffs.`
  - verif (browser, 18dbcba): `e2e/emulator/catchup.spec.ts:1424` — "T16 — the bug chain's tints, the ink log block and the diff, painted in token colours": the seeded FIXED stop now carries a real `diff` evidence entry next to its files list (:152–160), and on the player's own DOM the computed colours are checked against the tokens read from `ui/src/styles/tokens.css` — all four beat labels on their state tag tokens (FOUND=failed, CAUSE=waiting, FIXED=done, FOLLOW-UP=queued, :1462–1478), the CAUSE log block on the `ink` ground (:1479–1482), every seeded `+`/`-` diff line counted and painted on the done-/failed-pale tints with the sign glyph kept (:1483–1503); the piece page (8b) paints the same ink block and diff tints (:1512, :1526, :1546–1553). The proof is captured as the `cu-7b diff` screen (:1509; landmarks `e2e/emulator/design.ts:2780`).
  - unit: `ui/src/components/catchup/Evidence.test.tsx:20–35` (the log renders as the dark `bg-ink` block with its header strip), :39 (diff `+`/`−` lines tinted, sign glyphs kept), files in mono (:59).
- [x] `Decisions in stops render the model's options as buttons, and the choice posts plain text to the agent.`
  - lab: `e2e/tests/catchup-lab.spec.ts:789` (leg 4, SEEDED FIXTURE) — `catchup-decision-option-1` ("Change to 12h") clicked (:868–894) arrives as exactly that user turn (:915). verif: `e2e/emulator/catchup.spec.ts:802–819` (the decision stop renders; with no agent session the click says honestly nobody was notified).
- [x] `Moving on marks the stop seen. ⌘J opens Ask with the stop as context.`
  - verif: `e2e/emulator/catchup.spec.ts:1241` — "ArrowRight walks to the next beat (and pays the one it leaves)"; S pays the current stop proven on `GET /catch-up/items/{id}`, not the label. ⌘J opens the assistant about the stop (same test; the player mounts the popover itself through `openAsk` — 8f6f378). unit `ui/src/pages/TourPlayer.tsx:13–17` documents the stop-level marking.
- [x] `Keys: ←/→ move between stops, S marks seen, Esc closes.`
  - verif: `e2e/emulator/catchup.spec.ts:1241` — the whole key contract on the keyboard piece (:1253): S seen on the store read, → moves and leaves the previous narrative, ← walks back, Esc closes, ⌘J asks.

## Known, recorded limits
- Request changes records a rejection with comments — the decide API knows only `approved` | `rejected` (`e2e/tests/helpers.ts:31`/:134–137: "Request changes" posts `{decision: "rejected", comments}` and the note is read back).
- A stop's diff can only come from the worker's bounded, secret-scoped `patch` artifact (ADR-0078 § Patch artifacts, `internal/worker/attempt_patch.go`/`unit_patch.go`), and it appears in a tour only when the model cites one. The artifact itself is proven deterministically in lab leg 1 (`e2e/tests/catchup-lab.spec.ts:521–589`): the run edits a file, the spec lists that run's artifacts filtered to `kind === "patch"` (:538) and FAILS if a finished run that moved the workspace filed none (:553); it asserts a cited diff excerpt can never exist without a filed patch (:568–572) and that a filed patch stores bytes (:589); whether the tour cited one is logged (:562).
