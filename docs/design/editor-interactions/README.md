# Handoff: Workflow editor interactions (editor-interactions)

Point your coding agent at **`design_handoff_editor_interactions/`**. It sits on top of `design_handoff_communication_redesign/` (shell, Home, Chats, Factory, and the section 8 visual language). That handoff still applies. Where the two disagree, **this one wins** for the Factory editor canvas.

## Overview
Eight changes to the workflow editor (Factory → open a workflow) in `dbirks/communication` `ui/`. They fix problems found when comparing Prototype v2 with `main` as of Nov 27, 2026:
- Two different cards open next to the selection (the step card and the wrap panel).
- The tool island has five modes, and wrapping steps needs a separate box-select mode.
- The draft status and Make live sit far apart.
- Shadows on everything make them meaningless.
- Blue means too many things.
- Test-run detail has no home in the editor.
- Assistant changes have no visible preview.

## About the design files
`Editor Ideas.dc.html` is a **static design board built in HTML**. It shows the look and states; it is not production code and is not clickable. Rebuild it in the existing app (React + React Flow, `tokens.css`, Tabler icons), following the repo's patterns. `support.js` is only needed to open the `.dc.html` file locally.

## Fidelity
**High-fidelity** for colors, type, radii, shadows and spacing. Positions on the canvas are illustrative. Where the board and this README disagree, the README wins.

## Status by idea
| Id | Idea | Status |
|---|---|---|
| 1a | One card beside the selection | **Build** |
| 1b | Canvas without modes, add bar | **Build** |
| 1c | Run tray under the canvas | Leaning yes. Build it, expect changes after trying it. |
| 1d | Assistant changes as ghost steps | **Build** (+ a review view, still to be designed) |
| 1e | Draft status next to Make live | Leaning yes. Build it. |
| 1f | Shadow rules by role | **Build** (rule for the whole app) |
| 1g | Goal frame: **G1 ink tab** | **Build G1.** G2 (hatched edge) is dropped. |
| 1h | + on lines to insert a step | **Build** |

The black **REPEAT UNTIL** tab was a favorite. Ink + royal blue may become the editor's flow pair: ink for structure, blue for actions and the assistant. Don't spread ink further yet, but avoid choices that block it.

---

## Shared values (from section 8, repeated here)
- Fonts: Red Hat Text (UI), Red Hat Mono (labels, code, meta). Icons: Tabler webfont (`ti ti-*`).
- Ink `#1e1d1a`, ink-2 `#3a3833`, muted `#6b675e`, placeholder `#6e6a62`.
- Lines `#e6e2d9`, dividers `#f0ede6`, inputs `#cfcac0`, raised edge `#cfc9bd`, tonal shadow `#e1ddd4`.
- Accent `#2f4bd6`, edge `#2238a8`, press shadow `#1a2d8f`, text `#2a43b8`, tint `#eef0fc`, wash `#f6f7fe`, mid `#8fa0e6`.
- Running `#d9eefa` / `#0f5e96` / `#1a6da6`, pale edge `#8cc8ec`. Done `#d9f0de` / `#1f6b37`. Failed `#fdd8d2` / `#b0281a`. Queued `#eeece6` / `#5e5a52`. Draft amber dot `#f0a93a`.
- Canvas: white, dot grid `radial-gradient(#d6d2c8 1.1px, transparent 1.1px)` at 20px.
- Step node: 168×56, radius 10, 1px `#cfc9bd`, shadow `2px 2px 0 #e1ddd4`, padding 0 12, gap 10. Icon tile 30×30 radius 8. Title 13.5/600, subline mono 11 `#6b675e` with ellipsis. Selected: border and shadow `#1e1d1a`. Dragging: hatch card 6px down-right (`repeating-linear-gradient(135deg,#b3ada2 0 1px,transparent 1px 4px)`), no box shadow.
- Status tag on a node: absolutely positioned top −9 / right 8, padding 1 5, radius 4, mono 9.5/600, letter-spacing .03em, in the state colors.
- Buttons: BTN-I with radius 8, height 32 (34 on the canvas's floating buttons), 13/600, press moves 2px into the shadow. **Retire `ds/SoftButton.tsx`**: one button style everywhere.

---

## 1a. One card beside the selection
**What:** a single anchored card pattern, the *beside card*, for anything selected on the canvas. It merges main's `AgentStepCard` placement with the wrap panel.

**Content by selection:**
- 1 agent step → step card, header "AGENT STEP": Step name (mono input), Agent picker (tile + name 13/600 + model mono 11 + chevron), Prompt (multi-line), footer "More settings" (13/600 `#2a43b8`) and "autosaved" (mono 10.5 `#6e6a62`). Other step kinds get their own fields under the same header style ("COMMAND STEP", "APPROVAL", "JUDGE").
- 2+ steps → wrap panel, header "WRAP N STEPS IN" (content unchanged from the redesign handoff section 3).
- 1 sticky note → note editor, header "NOTE".
- Insert from a line's + → insert menu (see 1h).

**Look:**
- Width 340, padding 12 14 14, gap 12, white, 1px `#cfc9bd`, radius 12, shadow `3px 3px 0 #e1ddd4`.
- Header: mono 10.5/600, letter-spacing .06em, `#6b675e`, with `ti-x` 15px at the right.
- Field labels 12.5/600 `#3a3833`. Inputs 1px `#cfcac0`, radius 8, padding 7 10.
- Caret: a 12×12 square, white, rotated 45°, with left and bottom borders `#cfc9bd`, 7px outside the card's edge.

**Placement:**
- 18px to the right of the selection's bounding box, with the caret vertically centered on it.
- If it doesn't fit on the right, flip to the left (caret on the right edge). If neither side fits, go below with the caret on top.
- Pan the canvas so both the selection and the card are visible (same as the wrap panel today).

**Behavior:**
- Only one beside card is open at a time. A new selection replaces it.
- Esc, the ×, or a click on empty canvas closes it. Dragging the selected step moves the card with it; hide it during the drag and show it again on drop.
- Edits autosave to the draft.
- "More settings" opens the existing full step panel.

**Repo:** generalize `studio/AgentStepCard.tsx` into a `BesideCard` with a body per selection kind. The wrap panel body moves into it.

## 1b. Canvas without modes
**What:** remove the tool modes (Select / Move around / Box select / Connect / Note). Each gesture does one thing:
- Drag on **empty canvas** → selection box. Style while dragging: 1px `#2f4bd6`, fill `rgba(47,75,214,.05)`, radius 2. On release, the selected nodes turn ink; 2+ selected opens the wrap card (1a).
- **Space + drag**, middle-mouse drag, or two-finger trackpad scroll → pan. The cursor is a grab hand while Space is held.
- Drag a **node** → move (4px threshold as before).
- **Hover a node** → connection dots on its left and right edges, vertically centered: 10px circle, white, 1.5px `#2f4bd6` ring. Drag from a dot to another node to connect.
- **N** → drop a sticky note at the cursor.
- Shift-click adds to or removes from the selection. ⌘A selects all. Delete/Backspace deletes.

**Add bar** (replaces the tool island and `StudioPalette.tsx`):
- Floating, bottom-center, 22px from the bottom. Padding 5, gap 2, white, 1px `#cfc9bd`, radius 12, shadow `3px 3px 0 #e1ddd4`.
- Items 34px tall, padding 0 11, radius 8, icon 17px + label 13 `#3a3833`, labels always visible. Hover `#f3f1ec`.
- Items: Agent (`ti-robot`), Command (`ti-terminal-2`), Approval (`ti-user-check`), Judge (`ti-gavel`), a 1×20 `#e6e2d9` divider, Note (`ti-note`, with an "N" hint in mono 10.5 `#6b675e`), More (`ti-dots`, opens the rest of the step types).
- **Click** an item → add that step to the right of the selected step, or at the viewport center if nothing is selected, then open its beside card.
- **Drag** an item onto the canvas → place it there. While dragging, the node gets the hatch drag look.
- On first open, show a one-line gesture hint at the top-left of the canvas: mono 10.5 on white, keys in `#1e1d1a`/600: "drag empty space select · space + drag move · drag a dot connect · N note". Hide it after the first selection-box drag, or with a × to dismiss.

**Repo:** `studio/ToolIsland.tsx` becomes the add bar. React Flow: `selectionOnDrag`, `panOnDrag={[1]}` plus Space to pan, `panOnScroll`.

## 1c. Run tray under the canvas
**What:** Try it and live runs open a tray docked under the canvas. The canvas keeps only small status tags (4h); everything else goes in the tray.

**On the canvas while running:** node tags `✓` / `● RUNNING` / `· QUEUED`. The running node has border `#1a6da6` and shadow `2px 2px 0 #8cc8ec`. Queued nodes are at opacity .7. Inside the goal frame, at the bottom-left: mono 10.5/600 `#0f5e96` "● round 2 of up to 3".

**Tray:**
- Full width of the canvas area, 1px `#cfc9bd` top border, white. Default height about 240, resizable by dragging the top edge (min 120, max 60%). Remember the height.
- **Header row** (padding 10 16, gap 12, bottom border `#f0ede6`):
  - State tag (e.g. `● RUNNING`).
  - Title 13.5/600, e.g. "Try it on #318".
  - Meta in mono 11 `#6b675e`: "round 2 of up to 3 · 1m 42s".
  - Segmented control: Rounds / Log / Output. Track `#f3f1ec`, padding 3, radius 9; active item white with a 1px `#cfc9bd` border, radius 7, 26 tall, 12.5/600.
  - At the right: **Stop** (secondary button, 28 tall) and a collapse chevron.
- **Body:** two columns.
  - Left, 400px: the **round list**. Each row is a grid of 26px / auto / 1fr: the round in mono 11 ("R1"), a verdict tag (`× NOT YET` failed colors, `✓ DONE` done colors, `● RUNNING`), and the judge's one-line reason (12.5/18). The current round has a `#f6f7fe` background.
  - Right: a **log** in mono 11.5/19 with timestamps in `#6e6a62`. Its header (mono 10.5/600 caps) names the step: "LOG · WRITE THE FIX".
- Clicking a node during a run filters the log to that step. Clicking a round shows that round's log.

**Lifecycle:** opens when Try it starts, collapses to its header row when the run ends (the final verdict stays visible), and closes with the chevron. Opening a past run from Runs or Versions shows it in the tray too.

**Note:** the user wants to see this in practice before committing. Keep it self-contained so it's easy to change.

## 1d. Assistant changes as ghost steps
**What:** when you ask the assistant from ⌘K to change the open workflow, its proposal lands on the canvas as a **preview**. Nothing is saved to the draft until Apply.

**On the canvas:**
- **New step:** border 1.5px dashed `#8fa0e6`, no box shadow, with a blue hatch card 6px down-right: `repeating-linear-gradient(135deg,#8fa0e6 0 1px,transparent 1px 4px)`, radius 10. Tag "PROPOSED" (`#eef0fc` / `#2238a8`).
- **Changed step:** normal node with an "EDITED" tag (same colors). The subline shows the new value.
- **Removed step:** (not drawn on the board) suggested look: node at opacity .45, title struck through, tag "REMOVED" in failed colors.
- **New or changed connections:** 1.5px dashed `#8fa0e6`, dash 5 4.
- Blue hatch means "proposed by the assistant"; grey hatch means "you, dragging". This is the hatch's second allowed use besides the logo; update the design rules.

**Proposal bar:**
- Floating at top-center of the canvas, 600 wide, padding 12 14, gap 12. Same float style: 1px `#cfc9bd`, radius 12, `3px 3px 0 #e1ddd4`.
- Contents: a 30px tile (`#eef0fc`, `ti-message-circle` `#2238a8`), the request (13.5/600), a meta line in mono 10.5 `#6b675e` ("from ⌘K · 2 changes · nothing saved yet"), then **Discard** (secondary-plain) and **Apply** (primary).
- **Apply** writes the changes to the draft, removes the ghost styling, and bumps the 1e change count. **Discard** removes all ghosts. Making it live is still a separate step.
- While a proposal is showing, editing the canvas is locked. Clicking a ghost node opens its beside card read-only, with a before/after for that step.

**Still to design:** a **review view** to see every proposed change in one place before applying, like a diff (steps added, removed and changed, with before/after fields and prompt text diffs). Suggested entry point: a "Review" link in the proposal bar's meta line that opens a panel in the beside-card style or a sheet. Build Apply/Discard first; the review view comes next.

**Repo:** replaces `studio/AssistantProposalBox.tsx`. Remove ⌘J and the editor's separate "Ask to change this draft" row. **One entry point: ⌘K (tap to search/ask, hold about 0.5s to talk)**, per the redesign handoff section 6.

## 1e. Draft status next to Make live
**What:** the draft state moves from the breadcrumb to the canvas's top-right button group, next to the button it affects. The breadcrumb shows only the path (`atlas / Factory / fix-issue`).

**Group** (top-right of the canvas, gap 8, buttons 34 tall), three states:
1. **Draft with changes:** `[● 2 changes ▾]` secondary-plain (7px amber dot `#f0a93a`, `ti-chevron-down` 14 `#6b675e`) · `[▶ Try it]` secondary · `[Make live]` primary.
2. **Nothing to make live:** `[✓ Live v3 ▾]` (`ti-check` `#1f6b37`) · `[▶ Try it]` · `[Make live]` disabled (`#f3f1ec` fill, `#b3ada2` text, 1px `#e6e2d9`, no shadow).
3. **Trying it:** `[● 2 changes ▾]` · a running split button (`#d9eefa` fill, `#0f5e96` text, 1px `#8cc8ec` border, shadow `2px 2px 0 #8cc8ec`) reading "● Trying · round 2" | a 1×18 `#8cc8ec` divider | "■ Stop" · `[Make live]` disabled.

**Behavior:** the status chip replaces the Versions button and opens the same Versions panel (304 wide, anchored under the group). Make live is enabled only when the draft differs from live and no test run is in progress.

## 1f. Shadow rules by role (whole app)
A shadow means you can **press** it, **drag** it, or it **floats** above the canvas. Everything else is flat.

| Role | What | Treatment |
|---|---|---|
| Press | Buttons | 2px offset in the button's darker tone; pressed, it moves 2px into the shadow |
| Drag | Steps, sticky notes | `2px 2px 0 #e1ddd4` (notes: `#e8cf94`). Ink when selected, hatch while dragging |
| Float | Beside card, Versions panel, add bar, proposal bar, menus | border `#cfc9bd`, radius 12, `3px 3px 0 #e1ddd4` |
| Static | Cards (workflow list, Home, Chats) | Border `#e6e2d9` only. If clicking opens something: on hover, border `#cfc9bd` + `2px 2px 0 #cfc9bd` |
| Flat | Inputs, chips, list rows, tags | No shadow. Focus ring only. |

Changes from section 8: workflow cards **lose** their resting `2px 2px 0 #ece9e2`. The tool island (now the add bar) goes from 2px to the 3px float shadow. The section pill and the quick-chat panel's edge shadow are unchanged. Remove the soft blurred shadows (`0 10px 30px …` etc.) from `tokens.css`.

## 1g. Goal frame: G1 ink tab
**What:** the goal frame stops being blue. Blue now means buttons, focus, the live selection box, and the assistant. Selection is ink.
- Frame: 1px `#cfc9bd`, radius 16, fill `#faf9f6`. Steps sit inside with about 20px padding below the header.
- **Tab** on the top border: 18px from the left, vertically centered on the border line (top −11). Padding 3 8, radius 6, `#1e1d1a` fill, white mono 10.5/600, letter-spacing .06em, `ti-repeat` 12px, gap 5. Text by goal type: "REPEAT UNTIL", or for side-by-side wraps "SIDE BY SIDE".
- Inside, top-left: the goal in quotes (13/18 `#1e1d1a`) and then the checker in 12px `#6b675e` ("a judge decides" / "a command passes" / "the output contains …").
- Footer inside, bottom-left: mono 10.5 `#6b675e` "up to 3 rounds · then ask David". During a run it's replaced by the round indicator (1c).
- Selected frame: border `#1e1d1a` + `2px 2px 0 #1e1d1a` (the frame is draggable). Clicking the tab selects the frame and opens a beside card to edit the goal.
- Also: the wrap panel's selected choice changes from blue to an ink border with a `#f3f1ec` fill, so blue isn't used for selection.

**Repo:** `studio/wrap/GoalFrame.tsx`.

## 1h. + on lines to insert a step
- **Hovering a connecting line** highlights it (2.5px `#1e1d1a`) and shows a **+ button** at its midpoint: 24px circle, white, 1px `#1e1d1a`, shadow `2px 2px 0 #1e1d1a`, `ti-plus` 14.
- **Click the +** → the beside card opens **below** it, caret on top, 260 wide, padding 10:
  - Header "INSERT STEP" + "between Read and Write" (11.5 `#6b675e`).
  - Rows 32 tall, radius 8, icon 16 + label 13: Agent, Command, Approval, Judge. Hover/keyboard focus `#f6f7fe`. ↑↓ moves between rows, ↵ picks one.
  - Divider, then the input "Or describe it…". Typing and pressing ↵ sends it to the assistant, which comes back as a 1d proposal.
- Picking a type inserts the step, re-routes the two connections, shifts the steps after it to the right, and opens the new step's beside card.
- **The last step** shows a dashed + to its right, 42px away (1.5px dashed `#b3ada2` circle, a dashed line to it, label "next step" in mono 10.5). Same menu, header "ADD STEP".

**Repo:** main already has edge + buttons. Restyle them and route them through the beside card.

---

## State
- `selection`: `{kind: 'none' | 'step' | 'steps' | 'note' | 'frame' | 'edge-insert', ids}` drives which beside card is open.
- `besideCard`: derived from `selection`, plus `{side: 'right' | 'left' | 'below'}` from layout.
- `spaceHeld` (pan), `hintDismissed` (persisted).
- `proposal`: `{request, adds[], edits[], removes[], edgeChanges[]} | null`. Editing is locked while it's not null.
- `draft`: `{changeCount, differsFromLive, liveVersion}` drives 1e.
- `run`: `{status, round, maxRounds, rounds[{verdict, reason}], logByStep}` and `tray: {open, collapsed, height, tab}`.

## Files in this bundle
- `Editor Ideas.dc.html`: the design board (1a–1h). Turn 1, Nov 27, 2026.
- `support.js`: runtime for opening the board locally.
- Related: `../design_handoff_communication_redesign/` (README section 8 and `Prototype v2.dc.html`).

## Repo files touched
`ui/src/components/studio/AgentStepCard.tsx`, `ToolIsland.tsx`, `AssistantProposalBox.tsx`, `wrap/GoalFrame.tsx`, `shell/TopBar.tsx` (breadcrumb), `ds/SoftButton.tsx` (retire), `styles/tokens.css` (shadows).
