# Redesign build contract

This is the shared contract for building the redesign in `README.md` (the handoff) and
`Prototype.dc.html` (the clickable source of truth; open it in a browser). Every brief builds on it. Where the
handoff README is silent, this file decides.

## Rules for every piece

- **Never copy the prototype's mock data into `ui/src`.** Names such as its project names, workflow names, people
  and issue numbers are design-mock strings; CI (`node e2e/emulator/mockdata-scan.mjs`) fails the build on them.
  Tests use their own neutral fixtures ("Project One", "wf-1", "Ada").
- Real data only. A block whose data the API doesn't have yet shows a plain empty state sentence, never fake rows.
- Tailwind v4 classes with the tokens in `ui/src/styles/tokens.css`. New radii/shadows: `rounded-[10px]` cards,
  `rounded-[12px]` panels, `rounded-[14px]` prompt box, `rounded-[18px]` modals, `rounded-full` pills;
  `shadow-[var(--shadow-pill)]`, `--shadow-prompt`, `--shadow-pop`, `--shadow-modal`. The old hard
  `2px 2px 0` shadow and `ds/Panel` chrome are not used on redesigned surfaces. Page background is white
  (`bg-surface`); the rail is `bg-rail`.
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
| Chats list | a search field, and an All · One-off · From runs filter that appears when the list is long, a filter is active or the search has text | Existing behaviour (finding chats; separating run chats); the lab journeys use both |
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
| Phone (below 768px) | everything in "Phone" above | The prototype is desktop-only |
