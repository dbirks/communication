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
- **Visual language (README section 8, Nov 27).** Depth is a hard tonal offset with no blur:
  `--shadow-prompt` (`2px 2px 0 #e6e2d9`), `--shadow-card` / `--shadow-card-hover` (workflow cards),
  `--shadow-island` (tool island), `--shadow-pop` (`3px 3px 0 #e1ddd4`, with a `border-fill-edge` border: wrap
  panel, Versions panel, menus), `--shadow-modal` (`4px 4px 0 #cfc9bd`), `--shadow-node` /
  `--shadow-node-selected` / `--shadow-node-running` (canvas steps and notes). Only the section pill
  (`--shadow-pill`) and the Quick chat panel's left edge stay soft.
- **Buttons are BTN-I, rounded**: `.ds-btn` + a variant (`ds/Button` or `ds/SoftButton`, which emit the same
  classes): radius 8, height 32, 13/600; `ds-btn--compact` (26px, radius 7), `ds-btn--tall` (34px, the editor's
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
  region): the editor's breadcrumb + draft status, a run page's breadcrumb.
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
  top corners). The editor keeps the canvas (pan/zoom by touch); the tool island stays 48px; the wrap panel and
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
| Studio palette, header, status bar, inspector | Tool island, top-right buttons, the step inspector card |
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
| Editor, goal frame | the wrapped steps stack top to bottom inside the frame (the prototype keeps them in a row) | A loop body has always been laid out top to bottom here, and README "Edges" allows "bottom→top inside a vertical stack". **Open: David has not confirmed this one** |
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
| Editor | a ninth tool-island row "More steps…" and a "− + fit" zoom control bottom-right | The step kinds beyond Agent / Command / Approval need a door; zoom without a wheel or trackpad needs one too |
| Editor | the hint under the canvas always reads "left to right · drag steps to arrange" | The prototype's changing hints narrate its own demo script |
| Editor, tool island | sits 40px under the top bar | README section 5 gives (16, 100) in page coordinates: 100 − the 60px top bar |
| Goal frame footer | "up to N rounds · then stop" | What the engine does when rounds run out; "then ask <person>" needs an escalation the engine does not have |
| Quick chat | a pop-out icon in the header; a separate round send button; mic and "Open as chat" outside the reply field | Opening the assistant as a page and sending by button existed before; the footer keeps the prototype's three controls |
| Manage, phone | the sub-nav is a horizontal strip of chips that scrolls, faded at both edges, opened at the current section | CONTRACT "Phone": two-column pages stack; six sections do not fit 390px |
| Page gutters | Home and Factory content is centred at the README's max widths (1100 / 1180 including padding) | README section 2 gives max widths, not the prototype's left offset |
| Editor breadcrumb | below 1440px the scope segment ("All projects /" or the project) is hidden, the rail tile shows the scope; on desktop the draft or run status is never shortened, and a long workflow name gives way and shows in full on hover | The status is short and bounded; a name is whatever people typed (the prototype's is "fix-issue") |
| Editor | opens top- and left-aligned at zoom 1, the first step 24px clear of the tool island, not centred on the board | A centred fit opened long flows in their middle (review 1); the reader starts at the trigger |
| Goal frame | the space under the last step holds the step's "+" handle and the rounds footer (88px) | The "+" under a terminal step is how a step is added inside the loop |
| Project home | the starter pills are the resumable chats first, then "Run <workflow>" and "New chat" | Real data: picking up recent work is the common case; the prototype's order is its fixed demo |
| Prompt chips | a chip with no chevron (the project chip of a project-scoped New chat) is regular weight; a chevron chip is a picker and is 600 | Weight says "you can change this"; the project is fixed by the page's scope |
| New chat, pick up | each row is the chat's title (600), with the resume icon and its age | The rows are chats to resume, one kind; the age is what tells them apart |
| Chat, run from the hand-off dialog | no "Started …" message is posted; the run card itself is the record | The hand-off links the run to the chat; a second line would say the same thing |
| Run card step strip | one segment per step execution, up to five (more are grouped), so a one-step workflow draws one bar | The strip shows the real run, not a fixed five |
| Chat composer, phone | the chips wrap onto a second row at the 44px touch height | Phone touch floor (CONTRACT "Phone"); a sideways-scrolling row hides chips |
| Chat transcript, phone | the "+N" chips beside session lines are 44px tall touch targets | Phone touch floor |
| Run card, phone | "Open in Factory" sits on its own line under the title and strip | The title needs the width at 390 |
| Factory | a 2-column card grid | README section 4 ("a 2-column grid"); the prototype shows 3 |
| Factory card state | "○ idle" when the workflow has nothing in flight | A card has to say something when there is no live run; ○ is the "not running" mark beside ● |
| Factory, phone | the trigger sentence is a second line under the name; "New workflow" sits under the title, right-aligned | 390px has no room for name, trigger and state on one line |
| Wrap panel | sits 18px right of the selection even when other canvas content is there | Section 8: the panel is anchored to the selection; both stay visible |
| Editor, phone | the "…" menu of a selected step sits on the step's top-right corner, and the tool island may cover the leftmost step until the board is panned | 390px of board; the island stays reachable |
| Editor, dragging | while a step is dragged past the border of a goal frame its edge to the frame is drawn straight | The edge ends at the frame's border (see above); it settles when the step is dropped |
| Chat transcript | prints the agent's text as the agent sent it, chunks joined as received | The transcript is a kept surface |
| New chat, phone | the header row holds the back arrow; "New chat" is the page heading under it | The same header every phone chat screen has (back arrow, then content); the title is the page's own |
| Factory card thumbnails, phone | the step strip starts at the left and is cut at the card's edge | The strip reads left to right from the trigger; the card opens the whole workflow |
| Tool island, touch | no hover labels; every tool carries its name (and key) as its accessible label | A touch screen cannot hover; the island stays 48px wide on a 390px board |
| Goal frame | its "…" button shows while the frame is selected (right after a wrap it is), 8px inside the corner | The same rule as a step's "…" |
| Wrap panel | "Side by side" is unavailable with one step selected, and says why on hover | One step cannot run beside itself |
| Phone (below 768px) | everything in "Phone" above | The prototype is desktop-only |
