# Tasks for Claude Code (handoff copy)

Source: claude.ai/design project 00029951-9736-479d-8ff2-a1e57daa15fd, `design_handoff_communication_redesign/TASKS.md`, copied verbatim on 2026-11-09 so the acceptance checklist (`ACCEPTANCE.md`) can be audited against it in-repo. The twelve review findings it cites are in `findings/f01.txt`–`f12.txt` (plain-text extracts of `Redesign Review.dc.html`), and README Parts B and C are in `README-parts-b-c.md`.

Work top to bottom. Each task is one PR. Before starting, read `README.md` and the referenced section of the design file. Paths under `ui/src` come from reading `main`; confirm them before editing.

## Phase 1: cleanup (no backend changes)

### T1 · Rename conversations to "thread" (finding 01)
Files: `components/Sidebar.tsx` (NewChatRow, nav rows), `components/Shell.tsx` (NAV_ITEMS), `components/threads/ThreadListPane.tsx`, `pages/Threads.tsx`, the NewMenu component, router in `App.tsx`.
- [ ] No visible "chat" or "conversation" remains (search `ui/src` for `chat` and `onversation` in JSX text and aria-labels).
- [ ] `/p/:id/conversations` redirects to `/p/:id/threads`.
- [ ] The API and types are unchanged.

### T2 · Split Library (finding 02)
Files: `Sidebar.tsx` (LibrarySection, Rail), the workflows page, the steps page, the agent profiles page, `App.tsx`.
- [ ] The sidebar shows Workflows and Agents as rows, with no LIBRARY label.
- [ ] Steps is a tab on the Workflows page, and the old route redirects.
- [ ] `/p/:id/pipelines` redirects to `/p/:id/workflows`.

### T3 · Today dead ends (finding 03)
Files: `components/home/DecisionCallout.tsx`, `components/home/RunningNow.tsx`, `pages/Home.tsx`, `App.tsx`.
- [ ] "Show {n} more" expands in place, and nothing links to `/inbox` or `/board`.
- [ ] `/inbox` and `/board` redirect to `/`.
- [ ] Empty-state Start run opens the new-run dialog.

### T4 · Page layout prop (finding 07)
Files: `App.tsx` (`workbenchBleed`), Shell, every page.
- [ ] `<Page layout="reading|wide|canvas">` exists, and the regex list is deleted.
- [ ] Title baseline and left edge are identical across Today, Projects, Threads, the Workflow page and Settings at 1440px.
- [ ] Phone layout starts below 768px. From 768 to 1023px, the collapsed rail shows instead of the drawer.

### T5 · ⌘K search, ⌘J floating Ask (findings 08 and 10)
Files: `Sidebar.tsx` (NewChatRow), the Ask popover, the command palette, `lib/prefs.ts`, the Studio key handler.
- [ ] The sidebar has a "Search ⌘K" field-button. ⌘K always opens search / jump.
- [ ] A floating "Ask ⌘J" button sits bottom-right on every page. ⌘J opens Ask, and Ask opens via an explicit function, not a synthetic keydown.
- [ ] The `askPlacement` pref is removed.

### T6 · Project actions to the header (finding 09)
Files: `Sidebar.tsx` (ProjectTree menu), the project overview header, AddRepositoryDialog.
- [ ] No hover-only ⋯ on sidebar project rows.
- [ ] The project header has "+ Repository" (opens the dialog) and "Settings" (with a Members tab).

### T7 · Cut sidebar prefs (finding 10)
Files: `lib/prefs.ts`, `Sidebar.tsx` (ProjectSwitcher, folder rows), UserMenu.
- [ ] `projectsMode` and `showWorkflowFolders` are gone, and ProjectSwitcher is deleted.
- [ ] Old stored values are ignored without errors.

### T8 · Run header (finding 11)
Files: `components/workbench/RunHeader.tsx`, RunActions.
- [ ] Layout is breadcrumb, title + state chip + one primary action + ⋯, then the labeled facts row.
- [ ] The primary action follows run state (waiting → Review, failed → Retry step, running → Pause).
- [ ] Stream status shows only when it isn't live.

### T9 · Copy pass (finding 12)
- [ ] The four rewrites in finding 12 are applied word for word.
- [ ] Search for "control plane", "server build", "scaffold", "404", "decision word" and "winner" in JSX text, and rewrite every hit.
- [ ] The rulebook is added to `docs/design/design-system.md`.

## Phase 2: DecisionBar (finding 04)

### T10 · DecisionBar with undo
Files: new `components/ds/DecisionBar.tsx`, `DecisionCallout.tsx`, `inbox/InboxCard.tsx`, the Approval page, the run workbench.
- [ ] Buttons are Approve, Request changes and Reject, with no confirm step.
- [ ] The POST is held for 5s behind an "Approved. The run continues in 5s. Undo" toast. Undo sends nothing.
- [ ] A conflict shows "{Name} approved this {age} ago. Your decision wasn't recorded."
- [ ] The "not a decision word" path is deleted.

## Phase 3: collapsed rail (3a + 4a)

### T11 · Rail redesign
Files: `Sidebar.tsx` (Rail, railInitials), a new Popover with an arrow in `ds/`.
- [ ] Icons only, per README Part B. railInitials is deleted.
- [ ] Hover shows a dark label with an arrow. Click opens a popover with an arrow and keyboard support.
- [ ] Expand works three ways: the button, ⌘\, and dragging the edge (snaps at about 120px).
- [ ] Badges use the state colors.

## Phase 4: Catch up (new)

### T12 · Data model and API (backend)
- [ ] `WorkItem` has: id, project, shape (`issue|pr|push`), refs, resolution, timestamps, and grouping done by the assistant.
- [ ] `Tour` (one per WorkItem) has versions and stops: title, narrative, evidence[], kind, importance, and an optional decision {prompt, options[], allowText}.
- [ ] `Seen` has user, workItem and tourVersion. There is a "mark all seen" endpoint.
- [ ] A decision reply posts plain text back to the agent session.
- [ ] Endpoints: list unseen work items (filter by projects and window), get a work item with its tour, generate the recap for a user, get the catch-up tour for a user, and "see more" (up to 4 more stops).
- [ ] Write an ADR if the journal or event model changes.

### T13 · Tour generation (agent side)
- [ ] When a run finishes or a piece of work changes, write or rewrite its tour.
- [ ] Bug stories follow found → cause → fixed → follow-up, using logs and the session.
- [ ] Assign importance using the signals in README "Open decisions" #2 (confirm first).

### T14 · Catch up page (8a)
- [ ] Route `/catch-up`, plus a sidebar row and rail icon with an "{n} unseen" badge.
- [ ] Filters (project checkbox chips with color squares, window chips with unseen as the default), the recap, the tour cards with a See more card, and "The rest" list with how-it-landed labels and UPDATED tags.
- [ ] The big-backlog banner appears when the unseen count is over a threshold. The suggested window comes from visit frequency.
- [ ] Items leave the page when seen. "Show seen" brings them back.

### T15 · Piece of work page (8b)
- [ ] Three columns: stops, current stop, tour history.
- [ ] Seen-by avatars, "you have not seen the {time} update", and a Copy link button.

### T16 · Tour player (7b)
- [ ] Full screen, segmented progress with a dashed see-more segment, and a stop list.
- [ ] Narrative steps with state tints, a dark log block, and diffs.
- [ ] Decisions in stops render the model's options as buttons, and the choice posts plain text to the agent.
- [ ] Moving on marks the stop seen. ⌘J opens Ask with the stop as context.
- [ ] Keys: ←/→ move between stops, S marks seen, Esc closes.

## Phase 5: after the open decisions
- Today layout (README "Open decisions" #1).
- Ranked diff view (4h), if confirmed.
