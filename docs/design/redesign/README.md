# Handoff: Communication UI redesign (shell, Home, Chats, Factory)

## Overview
This is a redesign of the Communication web UI (`ui/` in `dbirks/communication`). It replaces the 220px left sidebar and the many top-level pages with three daily places (**Home**, **Chats** and **Factory**), a **project rail** on the far left, and an **assistant** you reach with one key. The workflow editor ("Studio") becomes an open, left→right canvas: drag steps around, draw a box around steps, and wrap them in a **Repeat until** loop that ends when a **goal** is met.

## About the design files
The files in this bundle are **design references built in HTML**. They are prototypes that show the intended look and behavior; they are not production code to copy. Recreate them in the existing app (`ui/`: Vite + React 19 + TypeScript + Tailwind v4, `@xyflow/react` for the canvas, `@tabler/icons-react` for icons), using its patterns: `ui/src/styles/tokens.css`, `ui/src/components/ds/*`, and react-router.

- `Prototype v2.dc.html` is the **source of truth** for everything marked "Decided" below. Open it in a browser; it is clickable. It is `Prototype.dc.html` restyled with the visual language in **section 8** (Nov 27), plus draggable steps and an anchored wrap panel. `Prototype.dc.html` stays for reference only.
- `Visual Directions.dc.html` is the look-and-feel board behind section 8 (turns 1–5, newest at top).
- `Factory.dc.html`, `Shell.dc.html`, `Projects.dc.html`, `Chats.dc.html` and `Morning.dc.html` are the exploration boards (rounds 1–4, newest at top; every option has an id like `3e`). Use them for detail and for context on the open questions. **Don't build options that aren't in the prototype** unless this README says so.
- `support.js` is only needed to open the `.dc.html` files locally.

## Fidelity
**High-fidelity** for layout, spacing, type, color and interactions in `Prototype.dc.html`. Data is mock data. Where this README and the prototype disagree, the README wins.

---

## Decided

### 1. Shell (every page)
Layout: a horizontal flex across the full viewport. From left: **project rail** (64px), then a main column. The main column holds the **top bar** (60px) and the **content** (fills the rest; each page scrolls itself).

**Project rail** (replaces `components/Sidebar.tsx`; `Shell.tsx` loses the sidebar, the phone drawer and the floating Ask button)
- Width 64, background `#faf9f6`, right border 1px `#e6e2d9`, padding 14px 0, items centered, gap 10.
- Top: the existing `Mark` (26px, `components/ds/Mark.tsx`), margin-bottom 6.
- Then tiles, 38×38, radius 11, 1px border `#e6e2d9`, background `#fff`, Red Hat Mono 12/600 initials (2 letters, uppercase):
  - **All** (text "All", 10.5px) = cross-project scope. A 24×1 `#e6e2d9` divider follows it.
  - One tile per project.
  - A "+" tile with a 1px dashed `#cfcac0` border = add project.
- Selected tile: background `#1e1d1a`, text `#fff`, border `#1e1d1a`.
- Needs-you badge: a 15px circle at top -5 / right -6, `#f0a93a` fill, `#2a1a00` "!" in 9px/700, 2px `#faf9f6` ring. Show it when the project has anything waiting on the current user (same source as today's `useSidebarFlags` "waiting").
- Bottom (margin-top auto): **Manage** gear (38×38, `ti-settings` 19px; selected = ink background, white icon), then the user avatar (30px circle, 1px ink border, mono 10.5 initials) → the account menu.
- Native `title` tooltips for now. No faces on tiles (we tried it; too busy).

**Top bar** (replaces `components/ds/AppBar.tsx` usage)
- Height 60, white, bottom border 1px `#e6e2d9`, padding 0 16 0 24.
- CSS grid `1fr auto 1fr`, gap 16, items centered.
- **Left:** the context.
  - On most pages: the project name ("All projects" / "atlas"), 16/700.
  - In the editor: a breadcrumb `atlas / Factory / fix-issue`. Segments are 14px `#6b675e`, the last one is 700 ink, separators `/` are `#cfcac0`. The first two segments are links. After it comes the draft status: a 7px `#f0a93a` dot + "Your draft · 2 changes from live v3", 12px `#6b675e`.
- **Center:** the section **pill**.
  - Container: 1px `#e6e2d9` border, radius 999, padding 3, gap 2, shadow `0 1px 3px rgba(30,29,26,.06)`.
  - Items: 32px tall, padding 0 14 0 11, radius 999, gap 7, Tabler icon 18px + label 13px.
  - Order: Home `ti-sunrise`, Chats `ti-message`, Factory `ti-building-factory-2`. Labels are always shown.
  - Active item: background `#1e1d1a`, white text, weight 600. Inactive: `#3a3833`, weight 500, no background.
- **Right:**
  - **Search or ask** field: 250×32, radius 999, 1px `#e6e2d9`, `ti-search` 15px, 12.5px `#6b675e` text, and a "⌘K" mono 10.5 chip on `#f3f1ec`.
  - **Mic** button: 32px circle, 1px `#e6e2d9`. While listening it turns `#2f4bd6` with a white icon.

**Scope rules**
- The selected rail tile sets the scope for Home, Chats and Factory.
- "All" shows everything, tagged with its project.
- Manage is global.

### 2. Home
**All projects** (`Prototype` → rail "All" → Home). This merges today's `/` (Today) and `/catch-up`.
- A centered column (max 760): h2 "Morning, David. What are we working on?" (24/700, centered). Below it the **prompt box**: radius 14, 1px `#cfcac0`, padding 14 16, shadow `0 4px 18px rgba(30,29,26,.06)`. The box has a project picker chip, an agent chip, and a 32px `#2f4bd6` round send button with `ti-arrow-up`.
- Below that, a two-column grid (max 1100; columns `1fr` and `320px`, gap 44):
  - **Left, "Since you left":** rows on a 3-column grid (70px project in mono `#2a43b8`, the story, a time aligned right), each with a bottom border `#f0ede6`. A final "+ N routine updates" line in muted text.
  - **Right**, three blocks in this order:
    - **NEEDS YOU:** pale-waiting cards (`#fdf6e4` / border `#e8cf94`).
    - **RUNNING:** in `#0f5e96`.
    - **FACTORY HEALTH:** one sentence.
  - Section labels are Red Hat Mono 10.5/600, letter-spacing .06em, uppercase.
- The catch-up data is the existing brief/recap (`api/catchup`, `components/catchup/*`). It is now a section of Home, not its own page.

**Project home** (rail tile → Home). Max width 1180, grid `1fr 300px`, gap 40, padding 28 36.
- Left column:
  - **Prompt box** with the placeholder "What should we do in atlas?" and an "or run a workflow" chip.
  - **Starter pills:** 1px `#e6e2d9`, radius 999, padding 5 11, 12.5px, with a `#2238a8` icon. The icon says what the pill does: `ti-message-plus` starts a chat, `ti-building-factory-2` runs a workflow, `ti-arrow-back-up` resumes a chat.
  - **HAPPENING NOW:** 3 cards in a row, radius 10, padding 12 14. A live run uses `#f3f9fd` with border `#8cc8ec`; a chat uses white with border `#e6e2d9`.
  - **Since you left** for this project only.
- Right column: **Repos** (mono name + status), then **Workflows here**. Each workflow is one line: bold name, then its trigger in plain English, e.g. "fix-issue *when an issue gets 'ready'*". The user liked this a lot; keep the wording style.

### 3. Chats (replaces Threads / `pages/Conversation.tsx` chrome)
- Grid `300px 1fr`.
- **Left list:** "Chats" title + a "New" button (`#eef0fc` / `#2238a8`). Rows: 13.5/600 title, 12.5 muted last line, and a status at the right ("! you" `#7a4a00`, "● run" `#0f5e96`). Selected row: background `#f6f7fe`, radius 8. Under "All" the list is grouped by project with mono uppercase headers.
- **New chat:** the right pane centers h2 "New chat", the prompt box (max 700), and an "OR PICK UP" list.
- **Thread:**
  - A 54px header: title, repo chip, people.
  - Messages: a mono 11 author/time line + 14.5/22 text, in a column of max 720.
  - The composer at the bottom has an agent chip and a "Run workflow" chip.
- **Workflow suggestion:** a single pill above the composer: "Run **fix-issue** on #318 instead? *tests + goal check + review*" with a **Run it** button and an ×.
  - It must be **clicked**. No Tab or keyboard shortcut accepts it (the user didn't want an accidental switch).
  - Starting a run inserts a live run card in the thread (`#f3f9fd` / `#8cc8ec`, a 5-segment step strip, "Open in Factory").

### 4. Factory (replaces `pages/Workflows.tsx` and folds in runs)
**Index:** h2 "Factory" + a one-line live summary + a "New workflow" primary button. Below it, a 2-column grid of **workflow cards** (radius 12, 1px `#e6e2d9`).
- Top of the card: a 120px **live thumbnail** on a dot grid (`#faf9f6`, dots `#e2ded5` at 14px). The workflow's steps are drawn as small chips joined by 18px lines. The running step is blue (`#d9eefa` / `#1a6da6` / `#0f5e96`), a step waiting on a person is amber, and the trigger chip is ink.
- Bottom of the card: the name (15/700), the trigger in plain English, and the current state at the right ("● #318 · round 2"), plus one muted line.
- Last card: a dashed "New workflow" card.
- Runs live here (cards + editor) and on Home. There is no Runs tab.

**New workflow sheet** (modal, 720 wide, radius 18). Contents, top to bottom:
1. A big "Describe it" box (1.5px `#2f4bd6` border + 4px `#dfe4fa` ring) with "Say it" and **Sketch it**. Copy: "Steps get sketched on the canvas. Nothing runs until you make it live."
2. "OR FROM SOMETHING YOU KEEP DOING IN CHATS": rows that show the detected step chain as small chips joined by arrows, each with a **Use this** button.
3. "OR COPY" chips for existing workflows, and a "Blank canvas" link.

### 5. Workflow editor (replaces `pages/Studio.tsx` + `components/studio/*`)
**Canvas**
- Full-bleed white with a dot grid: `radial-gradient(#d6d2c8 1.1px, transparent 1.1px)`, 20px, offset 10px.
- **Free placement, snapping to the 20px grid. Flow goes left→right.** Drop dagre auto-layout as the default; keep a "tidy up" action if it's cheap.
- **Edges:** smooth cubic béziers from a node's right side to the next node's left side (or bottom→top inside a vertical stack), 1.5px `#3a3833`. No arrowheads, and no dashed back-edges for loops.
- **Nodes:** 168×56, white, 1px `#e6e2d9`, radius 10, padding 0 12, gap 10.
  - A 30×30 icon tile (radius 8). Tile colors by kind:
    - agent: `#eef0fc` / `#2238a8`
    - command: `#efede7` / `#3a3833`
    - approval: `#ffecc2` / `#7a4a00`
    - trigger: `#1e1d1a` / white
    - git: `#efede7`
  - Title 13.5/600.
  - Subline in Red Hat Mono 11px `#6b675e`, one line, ellipsis.
  - Selected: border `#2f4bd6`. **(Superseded: see section 8 — gray edge + tonal shadow at rest, ink when selected.)**
  - Use the step icons from `lib/stepIcons.tsx`.
- Connection handles appear on hover (10px circle, 1.5px `#2f4bd6` ring). Drag from one to connect.

**Floating chrome on the canvas**
- **Tool island:** top-left at (16, 100), white, 1px `#e6e2d9`, radius 12, padding 5.
  - At rest it is 48px wide (icons only). **On hover it widens to 176px**, showing names and keys: Select V, Move around H, Box select B, Connect C, Note N; a separator; then Agent, Command, Approval (add a step).
  - Rows are 34px. The active tool is `#eef0fc` / `#2238a8` / 600.
  - It replaces `StudioPalette.tsx`.
- **Top-right:** **Versions** (`ti-history`, toggles the panel), **Try it** (test run), **Make live** (primary `#2f4bd6`). These replace Validate / Save / Publish: drafts autosave, "Make live" is today's publish.
- **Versions panel:** 304 wide, radius 12, anchored at top-right below the buttons. A vertical list:
  - "Your draft · now" (amber dot) with a change summary
  - "v3 LIVE" (green dot + `#d9f0de` "LIVE" tag) with who and when and the run count
  - older versions (hollow dots)

**Box select → wrap (the key interaction)**
1. With Box select on, drag a box around steps. The selection is drawn as **marching ants**: an SVG rect, 1.5px `#2f4bd6`, `stroke-dasharray: 6 5`, radius 14, fill `rgba(47,75,214,.035)`, animated with `stroke-dashoffset` 0 → −22 over 0.7s linear, infinite. A mono 10.5 `#2a43b8` label "3 steps selected" sits above it.
2. A **wrap panel** floats beside the box, anchored with a caret (section 8). 340 wide. It contains:
   - Header "WRAP 3 STEPS IN" with an ×.
   - A **segmented control** with two tabs: **Repeat until** `ti-repeat` | **Side by side** `ti-columns`. Track `#f3f1ec`; the active tab is white with a `#cfc9bd` border.
   - **Repeat until** tab:
     - "How do we know it's done?" with three choices, each with an icon:
       - A judge says the goal is met (`ti-gavel`)
       - A command passes (`ti-terminal-2`)
       - The output contains… (`ti-text-scan-2`)
     - The selected choice is `#f6f7fe` with a `#2f4bd6` border.
     - A field that changes with the choice: "The goal" (plain text) / "Command" (mono) / "Look for" (mono).
     - "Give up after [− 3 +] rounds".
     - **Wrap** button.
   - **Side by side** tab: one explanatory sentence + **Wrap**.
3. After Wrap, the steps sit in a **goal frame**: 1.5px `#2f4bd6`, radius 16, fill `rgba(47,75,214,.03)`.
   - Header inside the frame, top-left: icon + "Repeat until a judge says:" (12/600 `#2238a8`), then the goal in quotes (13/18).
   - Footer inside the frame: mono 10.5 `#2a43b8` "up to 3 rounds · then ask David".

**During a run** (see `Factory.dc.html` → `2h`):
- The frame's outline uses the marching-ants animation while it works.
- Nodes show state: done = `#d9f0de` tile + check; running = `#f3f9fd` background and `#1a6da6` border.
- Each round's judge verdict stacks in a card beside the frame.

### 6. Assistant ("Search or ask", ⌘K)
- **Tap ⌘K** (or click the field) opens search/jump; typing a question and pressing ↵ asks it.
- **Hold ⌘K for about 0.5s** to talk (speech to text); let go to send. The mic button does the same by click.
- Answers land in a **Quick chat** panel docked on the right: 400 wide, full height under the top bar, left border, shadow `-12px 0 30px rgba(30,29,26,.06)`.
  - **It stays open until closed**, so answers aren't lost on a stray click.
  - Bottom-posting chat. User bubbles are `#f3f1ec`, radius 12 12 4 12; voice messages carry a `ti-microphone` icon.
  - Assistant answers can include small live tables (agent · task · step strip).
  - While listening, a dark capsule shows the transcript.
  - Footer: reply field, mic, "Open as chat" (promotes it to a real chat).
- This replaces the floating "Ask ⌘J" button and `AssistantPopover`.

### 7. Manage (gear at the bottom of the rail)
- Left sub-nav (230px): Projects, Repositories, People & access, Runners, Agents & models, Secrets.
- Content shown: **Runners** table (Name / Where / Status / Busy / Used by), using the existing status words and glyphs ("✓ online", "! draining", "⊘ offline").
- Absorbs today's Settings, Operations, Agents (`/profiles`) and the project settings pages.

---

### 8. Visual language (decided Nov 27 — overrides the soft shadows below)
We stepped back from the soft, Pinterest-like look toward the original BTN-I system (`docs/design/handoff/README.md`), with rounder corners. Picks on `Visual Directions.dc.html`: **2a / 3a** for components, **3f / 4g** for nodes, **4h** for live state, **5b** for dragging. Rejected: 1c (too dense), 1d (too loud), 2b/2d (ink primary and ink edges), 2c (pills), 4a–4f (nav stays as today).

**Buttons = BTN-I, rounded.** Same variants, colors and press as `.ds-btn` in `tokens.css`; only the radius and height change.
- Radius **8** (compact 26–28px buttons: 7). Height 32 (34 on the editor's floating buttons). Text 13/600.
- primary `#2f4bd6`, border `#2238a8`, shadow `2px 2px 0 #1a2d8f`
- secondary `#efede7`, border + shadow `#cfc9bd`; secondary-plain is the same on white
- danger `#fdd8d2` / `#b0281a`, border + shadow `#e5a99c`; ghost has no border or shadow
- hover `filter: brightness(.96)`; pressed `translate(2px,2px)` + no shadow; focus ring as in `.ds-btn`
- Round send buttons keep radius 999 but get the primary border and shadow.
- In practice: add a `--radius-btn-rounded: 8px` (or change `--radius-btn`) and use `.ds-btn` everywhere in the new shell.

**Depth = hard tonal offset, no blur.** Replace the redesign's soft shadows:
- `--shadow-prompt` → `2px 2px 0 #e6e2d9`
- workflow cards: `2px 2px 0 #ece9e2`; hover: border `#cfc9bd` + `2px 2px 0 #cfc9bd`
- tool island: border `#cfc9bd`, `2px 2px 0 #e1ddd4`
- `--shadow-pop` (wrap panel, versions panel) → border `#cfc9bd`, radius 12, `3px 3px 0 #e1ddd4`
- `--shadow-modal` (new-workflow sheet) → radius 14, `4px 4px 0 #cfc9bd`
- Unchanged: the **section pill** (still `--shadow-pill`, black active tab) and the quick-chat panel's left-edge shadow.

**Search or ask** is plain: hairline pill, and "⌘K" is plain mono 10.5 `#6e6a62` text (no chip background).

**Canvas nodes (3f / 4g)**
- rest: border `#cfc9bd`, shadow `2px 2px 0 #e1ddd4`
- selected (incl. box-selected): border + shadow `#1e1d1a`
- **dragging (5b):** no box shadow; a diagonal-hatch shadow card sits 6px down-right behind the node: `repeating-linear-gradient(135deg, #b3ada2 0 1px, transparent 1px 4px)`, radius 10. A **dashed snap target** (1.5px dashed `#b3ada2`, radius 10) shows where it lands on the 20px grid. Edges follow the node live. Drop snaps to the grid.
- A mouse-down that moves less than 4px is a click, not a drag.
- **Live state during Try it / a run (4h):** a small mono status tag (9.5/600, radius 4, state tag colors, e.g. `● RUNNING`, `✓`, `· QUEUED`) on the node's top-right corner; the running node takes border `#1a6da6` + shadow `2px 2px 0 #8cc8ec`. Not wired in the prototype; see `Visual Directions` 4h.
- Factory thumbnails use single dots (`#dcd8ce` 1px, 14px).

**Wrap panel is anchored to the selection.** It sits 18px to the right of the marching-ants box, vertically centered on it, with a 12px rotated-square caret on its left edge pointing at the box's middle. It scrolls with the canvas. Selecting scrolls the board so both the box and the panel are visible.

**Considered, not decided:** 3h (a mono "kind" row on every node) was interesting; revisit with Try it. Canvas sticky notes (`NoteNode.tsx`, amber `#fdf6e4` / `#e8cf94`) exist on main but aren't in the prototype; give them the same rest/selected/drag treatment as steps.

## Design tokens
Keep `ui/src/styles/tokens.css` (Red Hat Text / Red Hat Mono / Kaisei Opti for the mark only; all state sets). Changes for this redesign:

- **Page background is `#ffffff`.** `--color-paper #f8f7f3` is no longer the page background; use it only for small fills. The rail is `#faf9f6`.
- **Lines:** `#e6e2d9` (default), `#f0ede6` (row dividers), `#cfcac0` (inputs, prompt box).
- **Text:** ink `#1e1d1a`, ink-2 `#3a3833`, muted `#6b675e`, placeholder `#6e6a62`.
- **Accent** stays royal `#2f4bd6`, with edge `#2238a8`, text `#2a43b8`, tint `#eef0fc`, wash `#f6f7fe`, ring `#dfe4fa`, mid `#8fa0e6`.
- **States** are unchanged. Used here:
  - running: `#d9eefa` / `#0f5e96` / `#1a6da6`, pale `#f3f9fd` / `#8cc8ec` / `#0f4c78`
  - waiting: `#ffecc2` / `#7a4a00` / `#f0a93a`, pale `#fdf6e4` / `#e8cf94` / `#5c3d00`
  - failed: `#fdd8d2` / `#b0281a` / `#c02a1a`, pale `#fbefec` / `#e5b2a8` / `#7f2215`
  - done: `#d9f0de` / `#1f6b37`, pale `#f1f7f2` / `#b9d3bf`
  - done progress segment: `#4a4740`
- **Radii (new):** 6–8 for chips and inputs, 10 for cards and nodes, 12 for panels, 14 for the prompt box and wrap panel, 16 for the goal frame, 18 for modals, 999 for the pill, round buttons and starter pills.
- **Shadows:** superseded by section 8 (hard tonal offsets). The soft values below are kept only for the pill and the quick-chat panel:
  - pill `0 1px 3px rgba(30,29,26,.06)`
  - prompt box `0 4px 18px rgba(30,29,26,.06)`
  - popovers and panels `0 10px 30px rgba(30,29,26,.10)`
  - modal `0 24px 60px rgba(30,29,26,.16)`
  - The old hard `2px 2px 0` offset shadow is **not** used in the new shell or canvas.
- **Type sizes:** h2 24/700; page title 16/700; section label mono 10.5/600 + .06em uppercase; body 13.5–14.5; small 12–12.5; mono meta 11.
- **Icons:** Tabler, 14–19px, stroke 1.5 default.

Copy rules from `docs/design/design-system.md` still apply:
- Status is always glyph + word, never color alone (● running, ! waiting, × failed, ✓ done, ⊘ interrupted).
- Plain, declarative sentences.
- Never "something went wrong".

## Mapping to the repo
| New | Replaces / touches |
|---|---|
| Project rail + top bar + pill | `components/Shell.tsx`, `components/Sidebar.tsx`, `components/ds/AppBar.tsx`, `lib/prefs.ts` (the `sidebarCollapsed` preference goes away) |
| Home (all / project) | `pages/Home.tsx`, `pages/CatchUp.tsx`, `pages/Project.tsx`, `components/catchup/*` |
| Chats | `pages/ProjectConversations.tsx`, `pages/Conversation.tsx`, `components/conversation/*` |
| Factory index + New workflow | `pages/Workflows.tsx`, `pages/Workflow.tsx`, `components/workflows/*`, run lists from `pages/ProjectRuns*` |
| Editor | `pages/Studio.tsx`, `components/studio/StudioCanvas.tsx`, `nodes.tsx`, `edges.tsx`, `StudioPalette.tsx`, `StudioHeader.tsx`, `StudioStatusBar.tsx`, `flowModel.ts` (layout direction LR, free positions persisted per node) |
| Repeat until + goal | the `until` scope kind already exists (`communication-spec/03-pipeline-engine.md`). "A judge says the goal is met" needs a judge step (`model.chat` with a rubric) or a new condition kind. **Needs an ADR before backend work**; build the UI against the existing `until` condition first. |
| Assistant quick chat | `components/assistant/*`, `components/CommandPalette.tsx` |
| Manage | `pages/settings/*`, `pages/Operations.tsx`, `pages/Agents.tsx`, `pages/ProjectSettings.tsx` |

Routes (suggested):
- `/` → Home for the current scope
- `/chats`, `/chats/:id`
- `/factory`, `/factory/:workflow`
- `/manage/:section`
- Project scope as a prefix: `/p/:projectId/...`; "All" has no prefix

## State (prototype logic)
- **Navigation:** `project` (`all` | id), `section` (`home` | `chats` | `factory` | `manage`), `fview` (`index` | `editor`).
- **Chats:** `chat` (id | `new`), `suggestion` (shown), `runStarted`.
- **Editor:** `tool`, `sel` (box selection active), `wrapTab` (`repeat` | `side`), `goal` (`judge` | `command` | `contains`), `looped`, `versions`, `island` (hover).
- **Assistant and sheet:** `quick` (panel open), `listening`, `sheet` (New workflow).

## Still open (don't block on these; build the decided version)
1. **The rail's look.** The user worries it reads as "VS Code". There's also the question of what it shows with only one project (maybe hide the rail and show the name in the top bar). Explorations: `Shell.dc.html` round 5 and later.
2. **"All" tile.** A globe icon was confusing; it's text "All" for now.
3. **Wrap menu.** "For each" wasn't clear to the user, so it's left out of the prototype. Side by side stays.
4. **Project home layout.** 3n / 4j are closest; 4k and 4l were not liked. Showing presence on items (faces) is unsettled; leave it out for v1.
5. **Factory index.** The prototype uses cards (3b). The assembly line (3c) was liked as an alternate view.
6. **Quick chat.** Docked panel vs a drop-down under the search field.

## Files in this bundle
- `Prototype v2.dc.html`: the clickable prototype (source of truth)
- `Visual Directions.dc.html`: look-and-feel board (section 8)
- `Prototype.dc.html`: the earlier soft-styled prototype (reference)
- `Factory.dc.html`, `Shell.dc.html`, `Projects.dc.html`, `Chats.dc.html`, `Morning.dc.html`: exploration boards (ids referenced above)
- `support.js`: runtime for opening `.dc.html` files
