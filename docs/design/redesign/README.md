# Handoff: Communication UI redesign

Repo: `dbirks/communication` (branch `main`, UI in `ui/src`). Implementer: Claude Code.

## Overview

The main user is an engineer supervising coding agents. That person needs to do two things:

1. **Unblock.** Find out what agents need right now so they can keep working.
2. **Catch up.** Find out what agents did while they were away, and understand the parts that matter.

This handoff covers three kinds of work:

- **Cleanup of the existing UI**: 12 review findings, each one decided.
- **A new collapsed sidebar rail.**
- **A new feature, Catch up**: an assistant-written overview, shared per-item tours, and a tour player.

Work is ordered in `TASKS.md`. Each task there has its files and an acceptance checklist.

## About the design files

The `.dc.html` files in `designs/` are **design references built in HTML**. They show the intended look and behavior; they are not production code. Recreate them in the existing React + Tailwind codebase (`ui/src`), using its patterns: the `ds/` components, `tokens.css`, and the `states.ts` state vocabulary. Do not copy the HTML or the inline styles.

To view a file, open it in a browser with `support.js` next to it. Each canvas file holds several numbered options (`1a`, `3a`, `8b`…). Only the options named below are approved.

## Fidelity

**High fidelity**, drawn in the existing "Hairline Flat" design system: same palette, fonts, 1px hairlines, 2px offset shadows on buttons, mono for machine-produced text.

Two decisions limit how far to change it:

- **Finding 05:** keep the current type scale. Don't raise sizes.
- **Finding 06:** keep the compact, tactile feel: mono metadata, uppercase panel bars, offset shadows.

Where a mock disagrees with existing tokens or components, the codebase wins on component structure and the mock wins on layout and copy.

## Approved designs (source of truth)

| Area | Approved option | File | Section |
|---|---|---|---|
| Review findings 01–12 | "Decided" banner on each finding | `designs/Redesign Review.dc.html` | `#f01`–`#f12` |
| Collapsed rail | **3a** (hover = label, click = menu with arrow) + **4a** (ways to expand) | `designs/Today Options.dc.html` | `#3a`, `#4a` |
| Catch up page | **8a** + the compact big-backlog banner below it | `designs/Catch Up.dc.html` | `#8a` |
| One piece of work + its shared tour | **8b** | `designs/Catch Up.dc.html` | `#8b` |
| Tour player (full screen) | **7b** | `designs/Catch Up.dc.html` | `#7b` |
| Decisions inside a tour | "Decisions inside the tour" idea card (Turn 8) | `designs/Catch Up.dc.html` | Turn 8, "More ideas" |
| Today page | **Not decided yet**; see "Open decisions" | `designs/Today Options.dc.html` | 3e, 3f, 4b, 4c |

`designs/Today (current).dc.html` is a rebuild of today's Today page, kept as the baseline.

---

## Part A: cleanup findings (all decided)

These apply to existing screens. The exact before and after for each is in `Redesign Review.dc.html`.

**01 · One name for conversations: "Thread".**
- Use "thread" in every visible string: the sidebar row (now "My chats"), the "New chat" button, the "New conversation" item in NewMenu, and the `/threads` page.
- The project route `/p/:id/conversations` becomes `/p/:id/threads`, and the old URL redirects.
- The API and type names stay `Conversation`.
- Update `NAV_ITEMS` in `Shell.tsx` to match.

**02 · Split "Library".**
- Remove the LIBRARY label from the sidebar.
- **Workflows** and **Agents** (renamed from "Agent profiles") become top-level rows.
- **Steps** becomes a tab inside the Workflows page.
- `/p/:id/pipelines` becomes `/p/:id/workflows`, with a redirect.
- The rail tile reads "Workflows", not "Library". The project menu item "Workflows in use" goes away (see 09).

**03 · No dead-end links on Today.**
- Remove the three-callout cap in `DecisionCallout`. Add "Show *n* more" that expands in place, and drop "*n* more in Inbox ›".
- Remove "open board ›" from `RunningNow`.
- The empty-state **Start run** opens the same new-run dialog as the New ▾ menu, not `/projects`.
- `/inbox` and `/board` redirect to `/`, the same way `/ops` does today.

**04 · One DecisionBar for workflow gates.**
- Build one component with fixed verbs: **Approve** (primary), **Request changes** (secondary), **Reject** (danger).
- No confirm step. On click, show a toast "Approved. The run continues in 5s." with **Undo**, and hold the POST for 5s. Undo cancels it.
- Model-written text goes in the summary, never on these buttons.
- Use it on Today, the Inbox card, the Approval page, and the run workbench.
- Remove the "not a decision word" fallback in `InboxCard.tsx`.
- If someone else decides first, show: "{Name} approved this {time} ago. Your decision wasn't recorded."
- Agent questions inside a tour are a different case with model-provided labels; see Part C.

**05 · Type scale.** No change.

**06 · Mono and caps.** No change.

**07 · One layout prop per page.**
- Each page declares `<Page layout="reading|wide|canvas">`, with one shared header band (same title baseline and left edge everywhere).
- Delete the `workbenchBleed` regex list in `App.tsx`.
- Move the phone breakpoint from 1024px to 768px. Between 768 and 1024px, show the collapsed rail instead of the drawer.

**08 · Two shortcuts.**
- **⌘K** opens search / jump. In the sidebar it's a field-like button reading "Search" with a ⌘K hint.
- **⌘J** opens Ask, the assistant.
- Ask is a **floating button** in the bottom-right corner: label "Ask", hint "⌘J", primary style. It is not in the sidebar.
- Replace the synthetic-keydown `openAsk()` with an explicit open function. Remove the Studio capture-phase workaround if it's no longer needed.

**09 · Project actions on the project page.**
- Remove the hover-only ⋯ menu from sidebar project rows.
- The project header gets **+ Repository**, which opens `AddRepositoryDialog` directly, and **Settings**, with Members as a tab. Both sit next to the existing New thread and Start run buttons.

**10 · Sidebar preferences.**
- Keep: projects as a tree, and `sidebarCollapsed`.
- Remove: `projectsMode` (and `ProjectSwitcher`), `askPlacement` (Ask always floats, see 08), and `showWorkflowFolders` (folders stay off).
- Migrate stored prefs by ignoring the removed keys.
- Expanded is the default. The collapsed rail is redesigned (Part B).

**11 · Run header.**
- Row 1: breadcrumb "{project} › Runs".
- Row 2: the title (22px/700), a state chip, and **one primary action chosen by run state** on the right, plus a ⋯ menu for everything else:
  - waiting → "Review plan" (or "Review diff")
  - failed → "Retry step"
  - running → "Pause"
- Row 3: a labeled facts row (Workflow + revision link, Repository in mono, Started "{age} by {name}", Pinned digest in mono).
- Show stream status only when it isn't live, e.g. "↻ reconnecting".

**12 · Copy pass.** Every empty, error and conflict string answers three questions: what happened, is my work safe, and what to do next. The rules:
- No API, component, ADR or status-code names in visible text.
- Name the person and the time when the data has them.
- End every error with an action.
- Add the rules to `docs/design/design-system.md`.
- The four before → after rewrites in finding 12 are exact copy.

---

## Part B: collapsed rail (3a + 4a)

**Width and contents.**
- The rail is 52px wide: white background, 1px ink right border.
- Top to bottom: the logo mark (26px), the expand button, Search, then the nav icons (Today, Catch up, Threads, Projects, Workflows, Agents), then the user avatar at the bottom.
- Icon buttons are 34×34 with a 3px radius.
- The active button has a 1px ink border and the blue grid-paper fill used by active sidebar rows (`repeating-linear-gradient` 4px grid in `#e4e8fa`).
- On hover a button gets a `#efede7` fill and a `#cfc9bd` border.

**Badges.**
- 15×14 boxes, top-right of the icon, offset −4/−5px.
- The background is the state tint, the text is the state ink, mono 9px/600, with a 1px white outline.

**Hover.**
- A dark label appears 8px to the right: `#1e1d1a` background, white text, Red Hat Text 12px/600, 24px tall.
- It can carry a mono shortcut hint (`#cfcac0`) and has a 4px arrow pointing at the icon.

**Click (projects, and any icon with children).**
- A popover opens: white, 1px ink border, `2px 2px 0 #1e1d1a` shadow, 3px radius, 8px padding, about 196px wide.
- A 10px rotated-square arrow sits on its left edge, pointing at the icon.
- It has a mono uppercase header, then the project rows with state counts, with the active project's repos nested under it.
- Esc or a click outside closes it. ↑/↓ and Enter work inside it.

**Expanding to the full sidebar.**
- The expand button under the logo, with the tooltip "Expand sidebar ⌘\".
- ⌘\ toggles from anywhere.
- Hovering the right edge shows a 5px `#dfe4fa` handle. Dragging it past about 120px snaps the sidebar open, and dragging it back snaps it closed.
- Expanded state: a collapse button with ‹‹ arrows in the header.

**Nav.** The full sidebar gains a **Catch up** row with a "{n} unseen" badge in accent ink `#2238a8`.

---

## Part C: Catch up (new feature)

### Concepts and data

**Piece of work.** The assistant groups code into one of three shapes:

- an **Issue** with its PR(s) and commits nested under it;
- a **PR only** (no issue);
- a **Push to main** (one or more commits with no PR).

Each piece of work has a project, a resolution (`merged`, `branch ready`, `open`, `run failed`, `no code`), refs, and timestamps.

**Tour (one per piece of work, shared).** Everyone on the project sees the same tour. It is rewritten as the work moves, with versions and new stops marked "ADDED {time}".

A stop contains:
- `title`
- `narrative`: plain language, written by the assistant
- `evidence`: some of a log excerpt, a diff hunk, before/after screenshots, or file refs
- `kind`: `BUG · FIXED`, `UI CHANGE`, `YOUR CALL`, `MIGRATION`… (a model-chosen label)
- `importance`: `must_know` | `worth_a_look` | `routine`
- an optional `decision` (see below)

Bug stories use the structure **found → cause → fixed → follow-up**. The model chooses the content from logs and the session.

**Decision inside a stop (agent question).**
- The model supplies the prompt text and 1–4 button labels, e.g. "Keep 24h" or "Change to 12h". A free-text reply is optional.
- The user's choice is sent back to the agent **as plain text**. This is how catching up and unblocking meet in one place.
- This is separate from workflow gates, which keep the fixed DecisionBar verbs (finding 04).

**Seen state.**
- Tracked per user, per piece of work, per tour version.
- Viewing a stop marks it seen when you move on. "Mark all seen" exists.
- No GitHub sync.
- A piece that changes after you saw it comes back with an **UPDATED** label, and its tour shows only the new stops.

**Catch-up tour (per user).** An opinionated summary of the per-piece tours you haven't seen, highest priority first. "See more" asks the assistant for up to 4 more stops from the rest.

**Recap (per user, per visit).**
- Written by the assistant: 2–3 sentences that say **what to look at first**.
- Shows "written {time}" with a regenerate action.
- Stays in the app; no email or Slack digest.

**Window.**
- The default is **unseen**: items leave the page as you see them.
- Chips: `unseen · 6h · 24h · 2d · 7d`.
- Projects can be multi-selected: checkbox chips with a color square per project.

**Big backlog.** When the unseen pile is large, show one compact banner suggesting a narrower window, based on how often the user visits (daily → 24h, weekly → 7d).

### Screens

**Catch up page (8a)**, route `/catch-up`.
- Header: "Catch up" (22px/600) and a mono subline "{n} unseen · oldest from {time} · {k} waiting on you on Today". The Today part links to `/`.
- Filter row: project checkbox chips. Each is 28px tall with a 15px checkbox, an 8px project color square and the mono name. Selected chips get an ink border and the 2px offset shadow. Then a divider, then the window chips.
- Big-backlog banner (when needed): one line, 38px, `#f6f7fe` background, `#dfe4fa` border. Copy: "**41 unseen over 4 days.** The tour covers the 6 that matter. Narrow to the last 24h?" Buttons: [Last 24h] and [Keep all].
- Recap block, with the mono label "ASSISTANT RECAP · WRITTEN 14:00". On the right: primary **▶ Start the tour · {n} stops · {m} min** and the meta "built from {k} shared tours".
- **Tour cards**, one per stop of your catch-up tour, in a row with flex 1 each:
  - a 3px top border in the importance color;
  - a number square, the project color square, the ref (issue/PR/commit icon and number), and minutes;
  - the kind label, then the title (14.5px/600), then the why (12.5px);
  - an evidence box 124px tall;
  - "Start here ›".
  - The first card is focused (ink border and offset shadow).
  - A 150px dashed **See more** card ends the row.
- **The rest**: one panel "THE REST · {n} UNSEEN", with "show seen" and "mark all seen". Rows are 46px. Each row has a checkbox, how the code landed (icon and label: Issue / PR only / Push to main), project and ref, title and one-line summary, a resolution chip, and "Tour ›". The UPDATED tag is accent ink on `#dfe4fa`.

**Piece of work (8b)**, route `/catch-up/:workId` (or under the project).
- Header: importance tag, kind, project, refs, the title, seen-by avatars, and the line "seen by {names} · you have not seen the {time} update".
- Buttons: [Copy link] and primary [▶ Play tour · {n} stops].
- Three columns:
  - **left (260px):** the tour's stops;
  - **center:** the current stop's narrative and evidence, with Back / Next;
  - **right (260px):** tour history (versions with time and reason) and "In your catch-up tour as: stop {x} of {y}".

**Tour player (7b)**, full screen with no sidebar.
- Top bar: close ×, "Catch-up tour", the meta "stop {x} of {n} · about {m} min", and segmented progress (done = ink, current = accent, upcoming = `#e6e2d9`, last segment dashed for "see more"). On the right: Back and primary **Next stop ›**.
- Left (260px): the stop list, then "See more", then the keyboard hint "← → move · S seen · ⌘J ask about this stop".
- Center (max about 980px):
  - the tags and refs line, then the title (24px/600), then the lead paragraph (15px);
  - narrative steps as a 110px state label plus content: FOUND (failed tint), CAUSE (waiting tint), FIXED (done tint), FOLLOW-UP (queued tint);
  - logs in a dark block: `#1e1d1a` background, `#e6e2d9` mono text, header `#3a3833`;
  - diffs: + lines on `#eaf5ec`, − lines on `#fbeceb`.
- Footer actions: Open the fix, Open {follow-up}, Ask about this, and on the right "Marked seen when you move on".
- Ask (⌘J) opens with the current stop as context.

### Importance colors (new tokens)

Blue is used for importance so that amber (waiting on you) and red (failed) keep their meaning.

| Level | Fill | Border | Tag |
|---|---|---|---|
| Must know | `#2f4bd6` | `#2f4bd6` | white text on `#2f4bd6` |
| Worth a look | `#8fa0ea` | `#5b6fd6` | `#2238a8` on `#dfe4fa` |
| Routine | `#ffffff` | `#9a958a` | `#5e5a52` on `#eeece6` |

### Project colors (new)

Each project stores a color, assigned from a fixed set that avoids the state hues. The mocks use payments `#6a4bc4`, web-console `#1f8077`, platform `#4a5a78`, and `#9a958a` for unselected or quiet projects. Show it as an 8px square with a 1px radius.

---

## Design tokens (existing; read `ui/src/styles/tokens.css` first)

| Role | Value |
|---|---|
| Ink | `#1e1d1a` |
| Paper (page) | `#f8f7f3` |
| Surface | `#ffffff` |
| Sunken / panel bar | `#efede7` |
| Hairline | `#e6e2d9` |
| Strong line | `#cfcac0` |
| Button line | `#cfc9bd` |
| Body 2 | `#3a3833` |
| Muted | `#6b675e` |
| Faint | `#6e6a62` |
| Accent | `#2f4bd6` |
| Accent border | `#2238a8` |
| Accent shadow | `#1a2d8f` |
| Link | `#2a43b8` |
| Accent tints | `#e4e8fa`, `#dfe4fa`, `#eef0fc`, `#f6f7fe` |
| Waiting | `#ffecc2` / `#7a4a00`, bar `#f0a93a` |
| Failed | `#fdd8d2` / `#b0281a`, bar `#c02a1a`, button border `#e5a99c` |
| Running | `#d9eefa` / `#0f5e96`, bar `#1a6da6` |
| Queued | `#eeece6` / `#5e5a52` |
| Done | `#d9f0de` / `#1f6b37` |

- **Fonts:** Red Hat Text (UI), Red Hat Mono (machine text, chips, panel bars), Kaisei Opti 500 (logo "C" only).
- **Radii:** 2px (chips, small squares), 3px (panels, rows, icon buttons), 4px (buttons).
- **Shadows:** buttons and focused cards use a solid `2px 2px 0` offset in the border color (primary `#1a2d8f`, secondary `#cfc9bd`, danger `#e5a99c`, focus `#1e1d1a`). There are no blurred shadows.
- **Panel bar:** mono 10px/600, uppercase, letter-spacing .04em, 4px 10px padding, `#efede7` background with a `#cfcac0` border. Waiting panels use the `#f0a93a` background.

## Assets

- **Icons** are 1.6px-stroke line icons on a 24px grid. Use the codebase's existing icon set; the inline SVGs in the mocks are stand-ins.
- **Screenshots** in UI-change stops are placeholders. They need agents to capture before/after images.
- **Data** in the mocks (people, issues, times, the 24h grace period, the 40s lock) is invented.

## Open decisions (ask before building)

1. **Today layout.** Unblock as an inbox (3e) or compact rows with inline buttons (4b top). And should Today show a one-line Catch up teaser? Until decided, apply findings 03, 04 and 12 to the current Today page and add a "Catch up · {n} unseen" link.
2. **Importance signals.** These defaults are proposed but not confirmed: auth/security, data migrations, public API changes, UI users will notice, new dependencies, tests weakened or skipped, a commit straight to main, a bug introduced by earlier work, a deviation from the approved plan.
3. **Ranking scope.** The same for everyone on a project, or per person.
4. **Ranked diff (4h)** as a second view of a piece of work. It was liked but not confirmed.

## Files

- `designs/Redesign Review.dc.html`: the 12 findings, with before/after and the decision on each.
- `designs/Today Options.dc.html`: rail options (Turns 2–4) and Today explorations. Approved: 3a and 4a.
- `designs/Catch Up.dc.html`: Catch up Turns 6–8. Approved: 8a, the compact banner, 8b, 7b, and decisions in tours.
- `designs/Today (current).dc.html`: baseline rebuild of the current Today page.
- `designs/support.js`: runtime needed to open the `.dc.html` files.
- `TASKS.md`: ordered tasks for Claude Code, with acceptance checks.
