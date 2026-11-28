# Redesign build contract

This is the shared contract for building the redesign in `README.md` (the handoff) and
`Prototype v2.dc.html` (the clickable source of truth since Nov 27; open it in a browser). `Prototype.dc.html` is
the earlier soft-styled prototype, kept for reference; `Visual Directions.dc.html` is the board behind README
section 8. Every brief builds on it. Where the
handoff README is silent, this file decides.

## Rules for every piece

- **Never copy the prototype's mock data into `ui/src`.** Names such as its project names, workflow names, people
  and issue numbers are design-mock strings; CI (`node e2e/emulator/mockdata-scan.mjs`) fails the build on them.
  Tests use their own neutral fixtures ("Project One", "wf-1", "Ada").
- Real data only. A block whose data the API doesn't have yet shows a plain empty state sentence, never fake rows.
- Tailwind v4 classes with the tokens in `ui/src/styles/tokens.css`. Radii: `rounded-[10px]` cards and steps,
  `rounded-[12px]` panels, `rounded-[14px]` prompt box and modals, `rounded-full` pills.
- **Visual language (README section 8, Nov 27) with shadow roles (editor interactions 1f, Nov 28).** A shadow
  means you can press it, drag it, or it floats; everything else is flat. Press: buttons (`.ds-btn`). Drag:
  canvas steps and notes (`--shadow-node`, ink `--shadow-node-selected` when selected, hatch while dragging).
  Float: beside card, Versions panel, add bar, proposal bar, review panel, menus (`--shadow-pop`,
  `3px 3px 0 #e1ddd4`, with a `border-fill-edge` border; `--shadow-island` is the same 3px value). Modals:
  `--shadow-modal` (`4px 4px 0 #cfc9bd`). Static cards (workflow cards, Home, Chats): border only, and on hover
  when they open something `--shadow-card-hover`. Flat: inputs, chips, list rows, tags (focus ring only; a
  selected row is an ink border, no shadow). The prompt box keeps `--shadow-prompt` (`2px 2px 0 #e6e2d9`).
  Only the section pill (`--shadow-pill`) and the Quick chat panel's left edge stay soft.
- **Buttons are BTN-I, rounded**: `.ds-btn` + a variant (`ds/Button` emits the same classes; `ds/SoftButton` is retired, editor interactions 1f): radius 8, height 32, 13/600; `ds-btn--compact` (26px, radius 7), `ds-btn--tall` (34px, the editor's
  floating buttons), `ds-btn--round` (the 32px send button). Never hand-roll a button's border and shadow.
- Page background is white (`bg-surface`); the rail is `bg-rail`. `ds/Panel` chrome is not used on redesigned
  surfaces.
- Icons: `@tabler/icons-react`, 14–19px, stroke 1.5.
- Status is always glyph + word (● running, ! waiting, × failed, ✓ done, ⊘ interrupted). Plain declarative
  sentences. Never "something went wrong".
- Section label style (used everywhere): `font-mono text-[10.5px] font-semibold uppercase tracking-[.06em] text-muted`.
- Links are built with `ui/src/lib/routes.ts`; never hand-write a path.
- Every interactive element is a real `button`/`a` with a visible focus ring
  (`focus-visible:outline-2 focus-visible:outline-accent`) and an accessible name. Touch targets ≥ 44px on phone.

## Routes and scope

The selected rail tile is the **scope**. It is a URL prefix: `/p/:projectId/...`; "All projects" has no prefix.
`useScope()` (`ui/src/lib/scope.ts`) returns the project id or `null`. `sectionFromPath()` says which pill item
is active.

| Route | Page | Builder |
|---|---|---|
| `/` | Home, all projects | `routes.scopeHome()` |
| `/p/:projectId` | Project home | `routes.scopeHome(id)` |
| `/chats`, `/p/:projectId/chats` | Chats list + New chat pane | `routes.chats(scope)` |
| `/chats/:id`, `/p/:projectId/chats/:id` | A thread (`new` = New chat) | `routes.chat(id, scope)` |
| `/factory`, `/p/:projectId/factory` | Factory index | `routes.factory(scope)` |
| `/factory/:pipelineId`, `/p/:projectId/factory/:pipelineId` | Workflow editor | `routes.factoryWorkflow(id, scope, params)` |
| `/manage/:section[/:itemId]` | Manage (global) | `routes.manage(section, itemId)` |

Sections of Manage: `projects`, `repositories`, `people`, `runners`, `agents`, `secrets`.

**Kept as they are** (restyled lightly later, reachable from the new places): the run workbench `/runs/:runId`
("Open in Factory" and run cards link here), approvals `/approvals/:id`, artifacts `/artifacts/:id`, a piece of
catch-up work `/catch-up/:workId` and its tour, the repository page `/p/:projectId/:repo`, the person's own
page `/profile`, `/assistant` (where "Open as chat" lands), `/login`.

**Redirects** (query and hash preserved): `/threads[/:id]` → chats; `/p/:p/threads[/:id]` → scoped chats;
`/workflows` → `/factory`; `/workflows/:id` and its drafts/yaml/used-in/history → the editor (with
`?draft=`, `?panel=yaml|used-in|versions`); `/workflows/steps*`, `/workflows/collections*`, `/profiles[/:id]`,
`/settings/assistant`, `/settings/accounts` → `/manage/agents...`; `/settings/operations`, `/ops` →
`/manage/runners`; `/projects` → `/manage/projects`; `/p/:p/settings` → `/manage/projects/:p`;
`/p/:p/members` → `/manage/people?project=:p`; `/p/:p/runs`, `/p/:p/workflows` → `/p/:p/factory`;
`/catch-up` → `/`. `App.tsx` is owned by the orchestrator.

## Shell

`components/Shell.tsx` renders: `ProjectRail` (64px) | main column = `TopBar` (60px) + content (fills the rest;
each page scrolls itself: the shell is `h-dvh overflow-hidden`, the content region is
`min-h-0 flex-1 overflow-auto`).

- Top bar left region: by default the scope name ("All projects" / the project's name, 16/700). A page replaces
  it by rendering `<TopBarLeft>…</TopBarLeft>` (`components/shell/TopBarSlot.tsx`, a portal into the left
  region): the editor's breadcrumb (path only), a run page's breadcrumb.
- Pill items link to `routes.scopeHome(scope)`, `routes.chats(scope)`, `routes.factory(scope)`.
- Rail tiles link to the **same section** in the new scope (on Chats, picking another project goes to that
  project's chats; from Manage or an unscoped page they go to that project's home).
- "+" tile → `routes.manage("projects")` with `?new=1`.
- Test ids: `project-rail`, `rail-tile-all`, `rail-tile-<projectId>`, `rail-add-project`, `rail-manage`,
  `rail-account`, `top-bar`, `top-bar-context`, `pill-home`, `pill-chats`, `pill-factory`, `search-or-ask`,
  `top-bar-mic`.

### Phone (below 768px) — not in the handoff; decided here

- The rail does not mount. The top bar is 52px: left = a 36px scope button (the selected tile's look) that opens
  a **scope sheet** from the left (the rail's tiles as full rows: tile + project name + needs-you badge, then
  Manage and the account row); center = the pill with icons only (labels are `sr-only`, 40px items); right =
  a 36px round search button (opens the same Search-or-ask) and the mic.
- Two-column pages stack to one column with 16px side padding. Chats shows the list at `/chats` and the thread
  alone at `/chats/:id` with a back arrow in its header. Modals become full-width bottom sheets (radius 18 on
  top corners). The editor keeps the canvas (pan/zoom by touch); the add bar stays bottom-centre and scrolls sideways; one finger pans, a long-press on empty canvas starts a selection box, a tap selects a step (E1); the wrap panel and
  Versions panel become bottom sheets. The quick chat panel covers the full width.
- No horizontal page scroll at 390px on any page.

## Shared components (already written; import, don't re-make)

- `components/ds/PromptBox.tsx`: `PromptBox` and `PromptChip`.
- `lib/scope.ts`: `useScope`, `scopeFromPath`, `sectionFromPath`.
- `lib/routes.ts`: the builders above, `MANAGE_SECTIONS`, `ManageSection`, `Section`.
- Existing and still used: `components/ds/{Button,Menu,Field,Mark,states}`, `components/Feedback`
  (`Spinner`, `FormError`, `ProblemBanner`), `components/UserAvatar`, `components/UserMenu`,
  `lib/stepIcons.tsx`, `lib/format.ts`.
- Coming in wave 1 (import by this path once it lands): `components/shell/AgentPicker.tsx`
  (`AgentPicker({ value, onChange, disabled })`: the agent chip + profile popover).

## What happens to the old app

| Old | New home |
|---|---|
| Sidebar, phone drawer, floating Ask button, `sidebarCollapsed` pref | gone (rail + top bar) |
| Today (`/`) + Catch up (`/catch-up`) | Home (All). The brief/recap components are reused as sections |
| Project page tabs (runs, workflows, artifacts, threads, settings) | Project home, scoped Chats, scoped Factory, Manage → Projects. Artifacts stay reachable from a run and a thread |
| Threads | Chats |
| Workflows index, workflow page (overview / YAML / used in / history) | Factory index and the editor. History = Versions panel; YAML and Used in = panels opened from the editor's "…" menu |
| Triggers dialogs | Opened from the trigger step on the canvas and from a Factory card's "…" menu |
| Studio palette, header, status bar, inspector | Add bar, top-right button group with the status chip, the beside card |
| Run workbench | Kept. Reached from run cards, "Open in Factory", Home |
| Steps library, skill collections | Tabs inside Manage → Agents & models |
| Agents (`/profiles`) | Manage → Agents & models |
| Settings → Assistant, Agent accounts | Manage → Agents & models |
| Settings → Operations (workers, models, capability matrix) | Manage → Runners (workers), Agents & models (models) |
| Settings → Layout | gone with the sidebar |
| Projects list, project settings, members, secrets | Manage → Projects, Repositories, People & access, Secrets |
| Assistant popover (⌘J) + command palette (⌘K) | Search or ask (⌘K) + Quick chat panel |

## Agents & models (not in the handoff; approved plan)

1. **Manage → Agents & models**: an accounts strip on top (one row per harness with "✓ signed in as …" or
   "! needs sign-in" + **Sign in**, using `api/agentAccounts.ts` and `components/settings/AgentLoginDialog.tsx`);
   a profiles table below (Name / Harness / Model / Skills / Used by); a profile opens a 560px side sheet
   (`/manage/agents/:profileId`) built from the existing `components/profiles/ProfileDetail`. Tabs under the
   strip: Profiles · Skills · Step templates · Models · Assistant.
2. **The agent chip is a profile picker everywhere** (`AgentPicker`): Home prompt boxes, the chat composer, agent
   steps on the canvas. Profiles grouped by harness; "! sign-in" beside a profile whose harness account is
   signed out; "Manage agents…" at the bottom.
3. **Project default agent**: one line on the project home's right column under "Workflows here".
4. **Agent step inspector** on the canvas: a card beside the step (wrap-panel style) with the picker and prompt.

## Decided differences from the prototype

The prototype shows mock screens; the app also has to keep what people could already do. A reviewer comparing
the two should treat each line below as decided, not as a defect. Anything not listed here follows the README
and the prototype.

| Where | The app has / lacks | Why |
|---|---|---|
| Chats list | a search field with an All · One-off · Runs filter under it, each the full width of the list, always shown | Existing behaviour (finding chats; separating run chats); the lab journeys use both, and a control that appears only on long lists moves the rows |
| Chat composer | "/ skill" and "# issue" chips beside the agent chip and "Run workflow" | Existing behaviour (attach a skill, link an issue); styled as the same chips |
| Chat header | the turn status and controller ("✓ done · you control"), the agent line, and a "…" menu (Details, Artifacts, control hand-off) | Existing behaviour; the prototype's header is title, repo chip, people |
| Quick chat footer | the trust-level and page-context chips | Existing assistant controls (what it may do without asking; whether it reads the open page) |
| New workflow sheet | "Start from a template", collapsed, after "Or copy" | Starting from a vetted template existed before the redesign |
| New workflow sheet | "Or from something you keep doing in chats" shows one sentence, no rows | No API detects repeated step chains yet; fake rows are not allowed |
| Manage → Runners | no "Add runner" button | A runner registers itself when it is started; the app has nothing to add |
| Manage → Runners | the old Operations panels (health, queue, sandbox, capability matrix, identity & storage, about) under "This server" | Operations had no other home |
| Manage → Agents & models | Skills, Step templates, Models and Assistant tabs | Their old pages had no other home (see "What happens to the old app") |
| Editor "…" menu | Edit as YAML (with the paste-and-validate panel), Used in, Run inputs, Use in a project, Tidy up, Discard draft | What the old workflow page and Studio could do |
| Editor | "Repeat until a judge says" is built from a model step that answers GOAL_MET plus the existing `until` condition | No judge condition exists in the engine; a dedicated one needs an ADR |
| Editor | a run on the canvas (`?run=`) with "Open run" / "Back to editing" | README "During a run"; the prototype has no route for it |
| Factory, project scope | "Schedules and triggers here" under the cards | Seeing, adding and pausing a workflow's schedules had no other home |
| Factory cards | a "…" menu (Triggers, Use in a project, Duplicate, Open YAML) and "Open run" / "Watch on canvas" on a live run | Existing actions |
| Home | data blocks print one plain sentence when empty | Real data; the prototype is always populated |
| Editor, goal frame | the wrapped steps stack top to bottom inside the frame (the prototype keeps them in a row) | A loop body has always been laid out top to bottom here, and README "Edges" allows "bottom→top inside a vertical stack". **Confirmed by David (2026-11-28, E3)** |
| Send, Wrap and Sketch it buttons | grey and disabled until there is something to send (text in the box, a goal in the field); primary with the hard shadow once there is | The prototype is a static picture with an empty box and a primary button; a button that does nothing must not look pressable |
| Editor, goal frame | the judge of a "judge says" loop is a visible step inside the frame; the edge from the step before ends at the frame's border | The judge is a real model step (see the "Repeat until a judge says" line); a loop is entered as a whole, so the edge belongs to the frame |
| Editor, box selection | the marching-ants box's pale fill lies over the selected steps | The box is drawn in the canvas overlay above the steps; the steps' ink edge is the selected mark |
| Editor, phone | selecting steps slides them into the strip above the wrap bottom sheet | Section 8: box and panel both stay visible; on a phone the panel is a bottom sheet |
| Editor, wrap | a selection that cannot be wrapped says why in one sentence above the canvas | The engine refuses a loop whose results are read from outside it; the prototype has no refusal state |
| Top bar mic | a click opens Quick chat and starts listening; "Stop" in the dark capsule or a second click sends | README section 6: "The mic button does the same by click" |
| Factory | "Recent runs" under the cards (newest first, 10 at a time) | Past runs had no other place to be found; there is no Runs tab |
| Kept pages (run workbench, approvals, artifacts, repository) | the same rounded buttons as the new shell | One button style across the app (`--radius-btn` is 8) |
| Editor, phone | opens at zoom 1 with the trigger at the left; later steps are reached by panning | Steps stay readable; the prototype is desktop-only |
| Home | the heading greets by time of day ("Good morning", "Good afternoon"…) and uses the signed-in name the identity provider gives | "Morning" at 4pm would be wrong; the app has no separate first name |
| Rail avatar | the person's photo when the identity provider has one, initials otherwise | Existing behaviour of the account avatar |
| Project home, Repos | each repository shows its open issue count, and maintainers get "Add repository" | Real data the API has (the prototype's "✓ 4 PRs" has no source yet); adding a repository had no other door on this page |
| Chat transcript | tool rows and permission cards keep their own tags ("✓ STATUS: COMPLETED", "kind: execute") | The transcript is a kept surface (CONTRACT "Kept as they are"); it prints what the agent protocol sent |
| New workflow sheet | "Blank canvas" and "Import YAML" sit on their own row under "Or copy" | Importing a YAML file existed before; two links read better as a row than at the end of a wrapping chip list |
| Editor | the add bar's "More" opens the rest of the step kinds; a "− + fit" zoom control sits bottom-right | Zoom without a wheel or trackpad needs one; the add bar covers the four common kinds |
| Editor | the hint under the canvas always reads "left to right · drag steps to arrange" | The prototype's changing hints narrate its own demo script |
| Editor | the add bar sits bottom-centre, 22px from the bottom (editor interactions 1b) | The tool island and its modes are gone |
| Goal frame footer | "up to N rounds · then stop" | What the engine does when rounds run out; "then ask <person>" needs an escalation the engine does not have |
| Quick chat | a pop-out icon in the header; a separate round send button; mic and "Open as chat" outside the reply field | Opening the assistant as a page and sending by button existed before; the footer keeps the prototype's three controls |
| Manage, phone | the sub-nav is a horizontal strip of chips that scrolls, faded at both edges, opened at the current section | CONTRACT "Phone": two-column pages stack; six sections do not fit 390px |
| Page gutters | Home and Factory content is centred at the README's max widths (1100 / 1180 including padding) | README section 2 gives max widths, not the prototype's left offset |
| Editor breadcrumb | the path only, at every width; the draft or run status is the chip beside Try it / Make live (editor interactions 1e), its full sentence in the chip's tooltip and accessible name | The status sits next to the button it affects |
| Editor | opens top- and left-aligned at zoom 1, the first step 88px from the left edge, not centred on the board | A centred fit opened long flows in their middle (review 1); the reader starts at the trigger |
| Goal frame | the space under the last step holds the step's "+" handle and the rounds footer (88px) | The "+" under a terminal step is how a step is added inside the loop |
| Project home | the starter pills are the resumable chats first, then "Run <workflow>" and "New chat" | Real data: picking up recent work is the common case; the prototype's order is its fixed demo |
| Prompt chips | a chip with no chevron (the project chip of a project-scoped New chat) is regular weight; a chevron chip is a picker and is 600 | Weight says "you can change this"; the project is fixed by the page's scope |
| New chat, pick up | each row is the chat's title (600), with the resume icon and its age | The rows are chats to resume, one kind; the age is what tells them apart |
| Chat, run from the hand-off dialog or the suggestion's "Run it" | no "Started …" message is posted; the run card itself is the record | The hand-off links the run to the chat; a second line would say the same thing |
| Run card step strip | one segment per step execution, up to five (more are grouped), so a one-step workflow draws one bar | The strip shows the real run, not a fixed five |
| Chat composer, phone | the chips wrap onto a second row at the 44px touch height | Phone touch floor (CONTRACT "Phone"); a sideways-scrolling row hides chips |
| Chat transcript, phone | the "+N" chips beside session lines are 44px tall touch targets | Phone touch floor |
| Run card, phone | "Open in Factory" sits on its own line under the title and strip | The title needs the width at 390 |
| Factory | a 2-column card grid | README section 4 ("a 2-column grid"); the prototype shows 3 |
| Factory card state | "○ idle" when the workflow has nothing in flight | A card has to say something when there is no live run; ○ is the "not running" mark beside ● |
| Factory, phone | the trigger sentence is a second line under the name; "New workflow" sits under the title, right-aligned | 390px has no room for name, trigger and state on one line |
| Wrap panel | sits 18px right of the selection even when other canvas content is there | Section 8: the panel is anchored to the selection; both stay visible |
| Editor, phone | the "…" menu of a selected step sits on the step's top-right corner | 390px of board |
| Editor, dragging | while a step is dragged past the border of a goal frame its edge to the frame is drawn straight | The edge ends at the frame's border (see above); it settles when the step is dropped |
| Chat transcript | prints the agent's text as the agent sent it, chunks joined as received | The transcript is a kept surface |
| New chat, phone | the header row holds the back arrow; "New chat" is the page heading under it | The same header every phone chat screen has (back arrow, then content); the title is the page's own |
| Factory card thumbnails, phone | the step strip starts at the left and is cut at the card's edge | The strip reads left to right from the trigger; the card opens the whole workflow |
| Goal frame | its "…" button shows while the frame is selected (right after a wrap it is), 8px inside the corner | The same rule as a step's "…" |
| Wrap panel | "Side by side" is unavailable with one step selected, and says why on hover | One step cannot run beside itself |
| Versions panel | a line joins the version dots, and each version (the live one included) has "Restore as draft" | Restoring an old version existed before; the line reads the rows as one history |
| Versions panel, phone | rows are 44px touch targets | Phone touch floor |
| Editor, after a wrap | the board keeps its place; the opening fit applies only when the editor opens | Moving the board under the reader's hands after an edit loses their place |
| Editor, phone | a selection made before the window narrows to phone width keeps its place; selecting on the phone slides the steps above the sheet | The slide runs when the selection is made |
| Quick chat composer | while listening, the mic button is a stop square | It stops the dictation; the capsule above carries the mic |
| Lists (Repos, chats, runners) | the last row has no rule under it | A rule separates rows; the card's own edge ends the list |
| Rail and top bar | their 1px rules can sit 1px from where the prototype draws them | A 1px offset review 5 measured; the rail keeps its 64px and the bar its 60px box |
| Home, "Since you left" | no "9 h · 3 projects" aside next to the heading | The catch-up API gives no visit window or story count to print; a made-up number is not allowed |
| New workflow sheet | 720px wide outside | README section 4: "720 wide" |
| Editor draft status chip | short labels "● N changes", "● New draft", "✓ Live vN", "Saving…", "× Couldn't save", "Run … · word"; the full sentence ("Your draft · N changes from live vN") is its tooltip and accessible name | The chip sits in the 34px button group (1e) |
| Editor, phone | "Try it" is an icon-only 44px button; the status chip keeps its short label | Four labelled buttons do not fit at 390px; Try it keeps its name as its accessible label |
| Factory card thumbnails | the connector is 18 × 1.5px, which a 1x screen draws 1px | README section 8 gives 1.5px |
| Run card in a chat | the state reads "● running · <current step>" with no elapsed seconds | The step name tells where the run is; the card has no running clock (the prototype’s seconds are mock data) |
| New chat | the block keeps the shared page top padding (it sits about 35px lower than the prototype) | One top padding for every page under the top bar |
| Quick chat | a short conversation sits at the bottom of the panel, next to the reply field | Chat convention: the newest message is where the eye and the reply box are |
| Project home, Repos | the first repository row keeps the list's own top padding (about 33px under the heading rule) | Every home list block uses one row rhythm, with or without the "Add repository" action |
| New workflow sheet | the "Describe it" box opens three lines tall | A described workflow is usually two or three sentences; the box does not jump as the first line wraps |
| Quick chat, phone | the "stays open until you close it" subtitle is hidden | The panel covers the whole screen on a phone; the line has no room and adds nothing there |
| Chats list | each row is about 58px | Each row has two lines, the title and the agent’s last line, plus its padding |
| Round send button, phone | draws a 32px circle with a transparent 44×44 touch area (`tokens.css` APP-SHELL-PHONE) | The design keeps a circle at every width |
| Editor interactions (2026-11-28) | `docs/design/editor-interactions/README.md` wins over this contract and the v2 prototype for the Factory editor canvas | The newer handoff; v2 stays the source for everything else |
| Keyboard | ⌘K is the documented way to ask, and on the editor "Change this workflow" (on by default in Quick chat) sends the request to the open draft as a proposal; ⌘J still opens Quick chat as an alias | ⌘J is used across the app and its journeys; removing it is outside the editor |
| Editor, step status tag | sits right 8, top −12 (4px over the card), not top −9 | The emulator's overlap check measures more than 4px of overlap as covered content |
| Editor, last step | the dashed "+" with "next step" is always visible | Editor interactions 1h draws it; it replaces the review-1 hover-only "+" under the sink |
| Editor, ghost proposals | a removed step is listed in the review panel (struck through) and not drawn on the canvas | The board does not draw removal; the canvas shows the proposed draft |
| Editor, proposals | a request made while the last edit is still saving asks to try again | Proposals are made against the saved version |
| Editor, single step | "Wrap in…" on a step's card opens the wrap card for that one step | Box select mode used to allow wrapping one step; the canvas has no modes now |
| Editor, proposal bar | Top-centre 64px below the pane top (72px on phone), under the toolbar row | The board has no toolbar; at 18px the bar covered the status chip, Try it and Make live |
| Editor, beside cards | A right/left card starts no higher than 60px below the pane top | Keeps the card clear of the toolbar row; the board's frames never reach the top |
| Editor, insert / add step card | Keeps screen size at every zoom | It is drawn inside the zoomed canvas; at a fitted 50% zoom the board's 260px card read at 130px |
| Editor, agent card prompt | 4 rows, grows to 8, then scrolls | The board's box is 4 rows; a long prompt pushed the card past an 800px screen |
| Editor, goal card open | The frame is drawn selected (ink) while its goal card is open | The tab opens the card without selecting the frame; the card needs a visible owner |
| Editor, Versions | Escape closes the panel (and the phone sheet) | It had only the × |
| Editor, viewing a run (`?run=`) | "Open run" and "Back to editing" sit in the run tray header; the top run pill shows only when the run cannot load. The status chip keeps naming the run | The tray already states the run; the chip names the run because the canvas shows the run's pinned revision, not the draft |
| Editor, note card | A selected note (not being typed in) opens the NOTE beside card: text box, "Delete note", autosaved | The board names the note body but does not draw it |
| Editor, review view | The docked panel starts 138px below the pane top, under the proposal bar; on phone it is a bottom sheet | At 62px it covered the bar's right end and Apply |
| Editor, read-only caption | The caption band says why the canvas is read-only: a proposal is showing, a run's pinned definition, an older version, no library role, a live version, or YAML errors | It said "the definition this run is pinned to" for every reason |
| Editor, phone toolbar and hint | The top-right group is capped to the pane width so the status chip truncates; the touch gesture hint sits below it at 72px | At 390 the chip ran off the left edge and the hint sat under the group |
| Editor, phone run tray | The header wraps (state, title, actions; then the tabs, Stop and collapse) and the rounds list stacks above the log | At 390 the tabs, Stop and collapse were off-screen |
| Editor, nothing to make live | When the draft's steps, connections and settings match the live version, the chip reads "✓ Live vN" and Make live is off; notes and layout alone do not count as a change | Board 1e "nothing to make live" |
| Home, "Since you left" | rows keep two lines (headline, then summary); the project (All projects) and time stay Red Hat Mono; on a project home the row leads with the time and has no project column | Design review 10, F1: the story text comes from the server's catch-up and needs its second line |
| Project home prompt | the box is 94px, 8px shorter than the prototype's | Design review 10, F2: low impact (Home's box is 116px); recorded rather than fixed |
| Chat thread composer and header | the composer keeps the hard 2px shadow and is 94px; the header title inset is 21px | Design review 10, F3: one composer component everywhere |
| Run card | names the workflow the run started (proven: "Run it" on "Run Scratch: fix an issue on #1" makes a "Scratch: fix an issue" card); the issue number and round are on the run page, not the card | Design review 10, F4: the run record carries the issue as a trigger fact the card does not read yet |
| Chats scope switch | switching to All opens the newest thread of the new list instead of keeping the open one | Design review 10, F5: the scope switch resets the list and its selection; keeping the open thread is a later improvement |
| New chat "Or pick up" | row pitch and gap differ by a few pixels | Design review 10, F6: negligible; the rows share the phone layout's 44px rows |
| New workflow sheet | the describe box uses our own example text | Design review 10, F7 |
| Editor tool island, wrap panel, post-wrap layout, phone selection zoom | as built in v2 | Design review 10, F8, F9, F10, F12: the editor interactions handoff replaces the tool island and wrap panel; F10 (trigger against the island after a wrap) and F12 (phone selection zooms to about 0.58) are named in TODO "Editor interactions" |
| Section pill | about 5px wider | Design review 10, F13: low impact; recorded rather than fixed |
| Versions draft lines | the change lines name steps and engine kinds ("+ until", "+ first → judge") | Design review 10, F14: they come from the step diff; plain-sentence lines belong with the editor interactions work |
| Phone (below 768px) | everything in "Phone" above | The prototype is desktop-only |
