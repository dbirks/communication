# From the handoff README — Part B (collapsed rail) and Part C (Catch up)

## Part B: collapsed rail (3a + 4a)
Width and contents: the rail is 52px wide: white background, 1px ink right border. Top to bottom: the logo mark (26px), the expand button, Search, then the nav icons (Today, Catch up, Threads, Projects, Workflows, Agents), then the user avatar at the bottom. Icon buttons are 34×34 with a 3px radius. The active button has a 1px ink border and the blue grid-paper fill used by active sidebar rows (repeating-linear-gradient 4px grid in #e4e8fa). On hover a button gets a #efede7 fill and a #cfc9bd border.
Badges: 15×14 boxes, top-right of the icon, offset −4/−5px. The background is the state tint, the text is the state ink, mono 9px/600, with a 1px white outline.
Hover: a dark label appears 8px to the right: #1e1d1a background, white text, Red Hat Text 12px/600, 24px tall. It can carry a mono shortcut hint (#cfcac0) and has a 4px arrow pointing at the icon.
Click (projects, and any icon with children): a popover opens: white, 1px ink border, 2px 2px 0 #1e1d1a shadow, 3px radius, 8px padding, about 196px wide. A 10px rotated-square arrow sits on its left edge, pointing at the icon. It has a mono uppercase header, then the project rows with state counts, with the active project's repos nested under it. Esc or a click outside closes it. ↑/↓ and Enter work inside it.
Expanding to the full sidebar: the expand button under the logo, with the tooltip "Expand sidebar ⌘\". ⌘\ toggles from anywhere. Hovering the right edge shows a 5px #dfe4fa handle. Dragging it past about 120px snaps the sidebar open, and dragging it back snaps it closed. Expanded state: a collapse button with ‹‹ arrows in the header.
Nav: the full sidebar gains a Catch up row with a "{n} unseen" badge in accent ink #2238a8.

## Part C: Catch up
Piece of work: the assistant groups code into an Issue (with PRs/commits nested), a PR only, or a Push to main. Each has a project, a resolution (merged, branch ready, open, run failed, no code), refs, timestamps.
Tour (one per piece of work, shared): rewritten as the work moves, with versions and new stops marked "ADDED {time}". A stop: title, narrative (plain language), evidence (log excerpt, diff hunk, before/after screenshots, file refs), kind (BUG · FIXED, UI CHANGE, YOUR CALL, MIGRATION… model label), importance must_know | worth_a_look | routine, optional decision. Bug stories: found → cause → fixed → follow-up.
Decision inside a stop: model supplies prompt + 1–4 button labels; optional free text. The choice is sent back to the agent as plain text. Separate from workflow gates (DecisionBar).
Seen state: per user, per piece, per tour version. Viewing a stop marks it seen when you move on. "Mark all seen". A piece that changes after you saw it comes back with an UPDATED label and only new stops.
Catch-up tour (per user): opinionated summary of unseen per-piece tours, highest priority first. "See more" asks for up to 4 more stops.
Recap: assistant-written, 2–3 sentences, says what to look at first. "written {time}" + regenerate.
Window: default unseen (items leave as you see them). Chips: unseen · 6h · 24h · 2d · 7d. Projects multi-select: checkbox chips with a color square per project.
Big backlog: when the unseen pile is large, one compact banner suggesting a narrower window based on visit frequency (daily → 24h, weekly → 7d).

### Catch up page (8a), route /catch-up
- Header: "Catch up" (22px/600) and a mono subline "{n} unseen · oldest from {time} · {k} waiting on you on Today". The Today part links to /.
- Filter row: project checkbox chips: 28px tall, 15px checkbox, 8px project color square, mono name. Selected chips: ink border + 2px offset shadow. Then a divider, then the window chips.
- Big-backlog banner (when needed): one line, 38px, #f6f7fe background, #dfe4fa border. Copy: "**41 unseen over 4 days.** The tour covers the 6 that matter. Narrow to the last 24h?" Buttons: [Last 24h] and [Keep all].
- Recap block, mono label "ASSISTANT RECAP · WRITTEN 14:00". On the right: primary "▶ Start the tour · {n} stops · {m} min" and meta "built from {k} shared tours".
- Tour cards, one per stop of your catch-up tour, in a row, flex 1 each: 3px top border in the importance color; number square, project color square, ref (issue/PR/commit icon + number), minutes; kind label, title (14.5px/600), why (12.5px); evidence box 124px tall; "Start here ›". The first card is focused (ink border + offset shadow). A 150px dashed "See more" card ends the row.
- The rest: one panel "THE REST · {n} UNSEEN", with "show seen" and "mark all seen". Rows 46px: checkbox, how the code landed (icon + label: Issue / PR only / Push to main), project + ref, title + one-line summary, resolution chip, "Tour ›". UPDATED tag: accent ink on #dfe4fa.

### Piece of work (8b), route /catch-up/:workId
- Header: importance tag, kind, project, refs, title, seen-by avatars, line "seen by {names} · you have not seen the {time} update". Buttons [Copy link], primary [▶ Play tour · {n} stops].
- Three columns: left 260px the tour's stops; center the current stop's narrative + evidence with Back / Next; right 260px tour history (versions with time and reason) and "In your catch-up tour as: stop {x} of {y}".

### Tour player (7b), full screen, no sidebar
- Top bar: close ×, "Catch-up tour", meta "stop {x} of {n} · about {m} min", segmented progress (done = ink, current = accent, upcoming = #e6e2d9, last segment dashed for "see more"). Right: Back and primary "Next stop ›".
- Left 260px: stop list, then "See more", then keyboard hint "← → move · S seen · ⌘J ask about this stop".
- Center (max ~980px): tags + refs line, title (24px/600), lead paragraph (15px); narrative steps as a 110px state label + content: FOUND (failed tint), CAUSE (waiting tint), FIXED (done tint), FOLLOW-UP (queued tint); logs in a dark block (#1e1d1a bg, #e6e2d9 mono text, header #3a3833); diffs: + lines on #eaf5ec, − lines on #fbeceb.
- Footer actions: Open the fix, Open {follow-up}, Ask about this; right: "Marked seen when you move on". ⌘J opens Ask with the current stop as context. Keys ←/→ move, S marks seen, Esc closes.
- Decisions in stops render the model's options as buttons; the choice posts plain text to the agent.

### Importance colors (new tokens)
| Level | Fill | Border | Tag |
| Must know | #2f4bd6 | #2f4bd6 | white text on #2f4bd6 |
| Worth a look | #8fa0ea | #5b6fd6 | #2238a8 on #dfe4fa |
| Routine | #ffffff | #9a958a | #5e5a52 on #eeece6 |
### Project colors
Each project stores a color from a fixed set (API returns project.color): payments #6a4bc4, web-console #1f8077, platform #4a5a78; #9a958a for unselected/quiet. 8px square, 1px radius.
