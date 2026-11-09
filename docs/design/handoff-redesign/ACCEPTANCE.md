# Redesign handoff — TASKS.md acceptance checklist with evidence

Evidence below was gathered on 6727bc0 → b430e61. **The final word is the Acceptance run on the commit that introduced this line** (it also closes a verification-loop hole: before it, a failed test that wrote no defect row could still count as a clean pass, which hid one failing proof on b430e61). CI 42516428780 success. Acceptance **42516428819 success on first attempt** (all jobs: lab-e2e 150 passed / 0 failed; verification two clean passes, final pass 162 screens 0 defects; m4 core-a/core-b/fence/fanout/watch/restore + regrade; github-loop).
Specs below are in `e2e/`; "lab" = Acceptance lab-e2e job, "verif" = verification (emulator loop) job, "unit" = `pnpm --dir ui test` / `go test` in CI.

## Phase 1
### T1 Thread rename (66f9c8d, 2a1b7a7)
- [x] No visible chat/conversation — copy across ui/src renamed; specs assert "Threads"/"New thread" (lab shell-p1-shell.spec.ts:137, issue2-conversations.spec.ts:242 "the sidebar's New thread").
- [x] `/p/:id/conversations` → `/p/:id/threads` redirect — lab shell-p1-shell.spec.ts:168 "legacy routes redirect"; unit App.test.tsx.
- [x] API/types unchanged — `/api/v1/conversations` routes and `Conversation` types untouched (CI go + contract).
### T2 Library split (835003f, 5c10e28)
- [x] Workflows + Agents rows, no LIBRARY — lab shell-p1-shell.spec.ts:137.
- [x] Steps tab, old route redirects — lab shell-p1-shell.spec.ts:168 (/steps → /workflows/steps), shell-p4-library.spec.ts.
- [x] `/p/:id/pipelines` → `/p/:id/workflows` — lab shell-p1-shell.spec.ts:168.
### T3 Today dead ends (22a5823)
- [x] "Show n more" in place, no /inbox or /board links — lab shell-p2-home-board.spec.ts:153.
- [x] /inbox and /board redirect to / — lab shell-p1-shell.spec.ts:168.
- [x] Empty-state Start run opens the run form — verif catchup.spec.ts "today empty" test (fresh member-less identity → `home-start-run-dialog`); unit StartRunDialog.test.tsx.
### T4 Page layout (89c2c4c, 19ed63a, 8f6f378)
- [x] `<Page layout>` exists, regex list deleted — unit Page.test.tsx; `grep workbenchBleed ui/src` empty; lab m5-layout.spec.ts (every root carries `data-page-layout`).
- [x] Title baseline + left edge identical across Today, Projects, Threads, Workflow page, Settings at 1440 — lab shell-p1-shell.spec.ts:578 (±1px).
- [x] Phone < 768; rail 768–1023 — lab shell-p1-shell.spec.ts:389 and :464.
### T5 ⌘K / ⌘J (43b8d28)
- [x] "Search ⌘K" field-button; ⌘K always opens search — lab shell-p1-shell.spec.ts:315; verif catchup.spec.ts Today step.
- [x] Floating "Ask ⌘J" on every page; explicit open function — lab shell-p1-shell.spec.ts:315, :630 (Threads + Workflow pages); `askControl.ts openAsk()`.
- [x] `askPlacement` removed — unit prefs.test.ts (old stored blob ignored); lab shell-p1-shell.spec.ts:269.
### T6 Project actions (7061572)
- [x] No hover ⋯ on project rows; header has + Repository (opens dialog) and Settings with Members tab — verif repo-chat-nav.spec.ts header-actions/add-repository/settings-tabs screens; unit ProjectHeader.test.tsx.
### T7 Cut prefs (43b8d28)
- [x] projectsMode, showWorkflowFolders gone, ProjectSwitcher deleted — unit prefs.test.ts, Sidebar.test.tsx; test ids retired in ui/scripts/retired-testids.json.
- [x] Old stored values ignored — unit prefs.test.ts; lab shell-p1-shell.spec.ts:269.
### T8 Run header (4405617, 19ff7c1)
- [x] Breadcrumb / title + chip + one primary + ⋯ / facts row — unit RunHeader.test.tsx; lab shell-p3-workbench.spec.ts.
- [x] Primary by state — verif run-gate-artifacts.spec.ts (waiting ⇒ Review plan; running ⇒ Pause sampled while API says running); lab home-cluster.spec.ts (failed ⇒ "Retry step").
- [x] Stream status only when not live — unit RunHeader.test.tsx; lab issue2-workbench.spec.ts.
### T9 Copy pass (8351d11)
- [x] Four rewrites verbatim — unit tests on Home/RunNotFound/DecisionBar; m4 W9 reads the run-not-found copy.
- [x] Implementation words rewritten — 8351d11 diff (control plane, server build, scaffold, 404, decision word, winner…).
- [x] Rulebook in docs/design/design-system.md ("On-screen copy").

## Phase 2
### T10 DecisionBar (3c965b7, 8010d59)
- [x] Approve / Request changes / Reject, no confirm — lab shell-p789.spec.ts (three fixed verbs, no model label on a button); verif run-gate-artifacts.spec.ts.
- [x] POST held 5s, Undo sends nothing — lab shell-p2-home-board.spec.ts:334/:383 (waits 7s after Undo, zero decide POSTs, gate still pending); lab `decideGate` helper proves exactly one POST after the hold.
- [x] Conflict "{Name} approved this {age} ago. Your decision wasn't recorded." — verif gate-decision-conflict.spec.ts T10a (Today) and T10b (/approvals/:id): user A clicks Approve, user B decides the same gate through the API during A's hold, A's screen names B and shows no "recorded" status, live updates on; unit DecisionBar.test.tsx (hold cancelled when the cache shows the gate decided elsewhere).
- [x] "not a decision word" path deleted — grep empty; retired test ids recorded.

## Phase 3
### T11 Rail (4879199)
- [x] Icons only, railInitials deleted — verif rail-3a screens; unit Sidebar.test.tsx.
- [x] Hover dark label; click popover with arrow + keyboard — lab shell-p1-shell.spec.ts:492 (label), :736 (↓/Enter), verif catchup.spec.ts (Esc closes, focus returns).
- [x] Expand three ways — lab shell-p1-shell.spec.ts:492 (⌘\), :666 (edge drag past ~120px snaps open, back snaps closed), button in both.
- [x] Badges use state colours — unit Sidebar.test.tsx (Today, Catch up, Threads, Projects badges); final review "3a: PASS".

## Phase 4
### T12 Data model + API (9e9cdca, 8d71913, 21de9d3, 33d2060, ed8a3a7, 47266ed, ADR-0078, migrations 00028/00029)
- [x] WorkItem (id, project, shape, refs, resolution, timestamps, assistant grouping by issue/PR) — store tests on Postgres 18 (CI go job), ADR-0078 § Grouping.
- [x] Tour versions + stops incl. optional decision — store + API tests (CI).
- [x] Seen per user/item/version; mark-all-seen — store tests (CI); lab catchup-lab leg 3 (HTTP: every stop `seen: true`, item gone from unseen list).
- [x] Decision reply posts plain text to the agent session — lab catchup-lab leg 4 (exact text "Change to 12h" arrives as the thread's next user turn).
- [x] Endpoints: list unseen (lab legs 1–3 via HTTP `GET /api/v1/catch-up/items`), item with tour, recap (POST/GET), catch-up tour + see-more (`GET /catch-up/tour?offset`; verif catchup.spec.ts) — plus OpenAPI + generated types (CI contract + `gen:api:check`).
- [x] ADR written — ADR-0078 (+ Grouping and Trigger sections).
### T13 Tour generation (21de9d3, 33d2060, ed8a3a7, 1923a2f, 47266ed)
- [x] Written when a run finishes / work changes — lab catchup-lab leg 1 (real run → tour served); grouping rewrites as a new version (CI generator tests).
- [x] found → cause → fixed → follow-up from logs/session — generator prompt + truth-set tests; evidence only from cited excerpts (diffs: no server-readable source exists — recorded).
- [x] Importance signals as proposed in README Open decision #2 (used as-is).
### T14 Catch up page (fb13d5f, 43b8d28, 9035683, cd9dd6d, 8eb0f88)
- [x] /catch-up, sidebar row + rail badge "{n} unseen" — lab catchup-lab leg 2; verif cu-8a screens.
- [x] Filters, recap, tour cards + See more, rest list with landed labels + UPDATED — verif catchup.spec.ts 8a + "8a on the wire" (24h ⇒ `since`, show seen ⇒ `include_seen`); unit CatchUp/RestList tests.
- [x] Big-backlog banner from visit frequency — verif catchup.spec.ts backlog test: a labelled fixture seeds >12 unseen pieces and a daily visit history; the banner shows the served counts and "Narrow to the last 24h?", Last 24h narrows the read's since, Keep all dismisses it (screen cu-8a-backlog); unit CatchUp.test.tsx.
- [x] Items leave when seen; show seen brings them back — lab catchup-lab leg 3; verif mark-all-seen step.
### T15 Piece of work (2c981e7, be5ce84, 6daca66, 47d4119)
- [x] Three columns — verif cu-8b screens; final review "8b: PASS".
- [x] Seen-by, "you have not seen the {time} update", Copy link — unit CatchUpItem.test.tsx; verif cu-8b.
### T16 Tour player (ccfebe6, be5ce84, 8f6f378)
- [x] Full screen, segmented progress with dashed see-more, stop list — verif cu-7b screens; unit TourPlayer.test.tsx (see-more segment in tour mode).
- [x] Narrative steps, dark log, file list — verif cu-7b; final review "7b: PASS".
- [x] Decisions post plain text — lab catchup-lab leg 4; verif cu-8b/7b decision screens.
- [x] Moving on marks seen; ⌘J asks with the stop as context — verif catchup.spec.ts "7b on the keyboard" (S marks seen via API, ⌘J opens Ask naming the stop).
- [x] ←/→, S, Esc — same verif test.

## Design parity (fresh reviewers, design | 1280 | 390)
Final round on 6727bc0 captures: **Catch up PASS, piece of work PASS, tour player PASS, rail PASS, Today PASS — OVERALL PASS.** Four earlier rounds' DEFECT and MINOR findings were fixed in 5da1b79, be5ce84, 8be6ef8, 6daca66, cd9dd6d, 8eb0f88.

## Known, recorded limits
- Request changes records a rejection with comments (the decide API knows approved | rejected).
- Tour evidence is logs + file lists; no server-readable diff source exists.
- Out of scope per the goal: Phase 5 (Today layout, ranked diff).
