# Handoff: Repo page, sidebar shell, chats, workflow inputs

## Overview
A redesign of the repository page and the app shell for Communication (`dbirks/communication`, `ui/`). The goal: a repo page that shows what has run and what is running (runs and chats together); one collapsible left sidebar instead of a sidebar + top bar mix; repo-scoped chats where you can switch agents partway; quiet suggestions written by the assistant; workflow inputs you define on the workflow and fill in when you run it.

## About the design files
`Directions.dc.html` holds **design references made in HTML**. It is not production code. Rebuild these screens in the existing `ui/` app (React 19 + Tailwind v4 + react-router + TanStack Query), using its components (`components/ds/Panel`, `Button`, `states.ts`), tokens (`styles/tokens.css`) and data hooks (`api/*`). Open the file in a browser. Each option carries an id badge (1a…3e). The **final picks are listed below**. Options that weren't picked are kept for context only.

## Fidelity
**Mid-fidelity.** Colors, type, radii and shadows come from `tokens.css`, so treat them as final. Layout, hierarchy, copy and behavior are the spec. Exact spacing should follow the codebase's existing patterns (the 20px 28px page band, panel bars, 30/26px buttons). The mocks use placeholder data (project Northwind, repo storefront).

## Final picks (build these)

| Area | Option | Notes |
|---|---|---|
| Shell | **2c / 3c** | Left sidebar only, collapsible to a rail. No top bar on desktop. |
| Repo page, List view | **3a** | Default view. |
| Repo page, Lanes view | **3b** | Switched with a List / Lanes picker, remembered per repo. |
| Chat | **2e** + agent picker from **1h** | Side panel for context; switch agents per turn. |
| Thread → workflow | **2f** | Done in the assistant panel, no separate screen. |
| Agent mail across repos | **3d** | Optional feature, off by default per project. |
| Workflow inputs authoring | **1j** | New "Inputs" tab on the workflow page. |
| Run by hand form | **1k** | Built from the workflow's inputs. |

Not picked: 1a–1d, 1e–1g, 1i, 2a/2b (superseded by 3a/3b), 2d/3e (top bar).

## Screens

### Shell: sidebar (2c, 3c)
Changes to `components/Shell.tsx` and `components/Sidebar.tsx`:
- **Expanded (220px, was 240):** brand row with a collapse control at the right · `New chat` + `⌘K` · `Today` (was Home; the name is still open, see below) and `My chats` · **PROJECTS** tree (project rows ▾ with the worst-state flag; repos indented under a left rule, mono 11.5) · **LIBRARY** section label (Workflows with count, Steps, Agent profiles with count) · user footer.
- **Project row "⋯"** appears on hover/focus and opens a menu: Project settings · Members · Add repository · (divider) Workflows in use. This takes these items out of the tree.
- **Collapsed (52px rail):** mark, `+` (new chat), Today, project initials tiles (active tile = ink border + accent tint), Library, expand control, avatar. Hovering or focusing a tile opens a **flyout** with the project name, flag and repo list.
- Save the collapsed state in layout prefs (`lib/prefs.ts`) next to `projectsMode`.
- **All popovers/menus get a pointer arrow:** a 9px square, white, 1px ink border on two sides, rotated 45°, centered on the trigger. The menu box is white, 1px ink border, 4px radius, `2px 2px 0 ink` shadow.
- The `NAV_ITEMS` "Board" and "Inbox" entries are replaced by Today. The Board behavior now lives in the repo Lanes view. Check with the user whether Inbox stays (see Open questions).

### Repo page, List view (3a)
Replaces the body of `pages/Repository.tsx`. Header: breadcrumb (`Project / repo`, mono 11 muted), H1 22/28 600, and on the right a segmented **List | Lanes** control (active segment = ink fill, white text).

Two columns: `minmax(0,1fr) 290px`, stacking below 1024px.

**Left column**
1. **Chat box:** one line, ink border with a `2px 2px 0` ink shadow. Placeholder "Chat in storefront… ask, plan, or paste an issue". Agent profile picker chip (secondary, 26px). Primary `Start`. Starting creates a conversation scoped to **this repo** and navigates to it.
2. **Filter chips:** All · Runs · Chats · Mine (24px, the active one has an ink border and is bold).
3. **Activity list:** one panel holding **runs and chats mixed**, newest first. Row grid `16px 44px minmax(0,1fr) 120px 36px`: state glyph (from `states.ts`) · kind (`RUN` muted / `CHAT` accent-text, mono 10) · title + short status · workflow name or agents (mono 10.5) · age. A waiting row gets the `waiting` pale body background. A running run shows a 5-segment progress strip (200×4px, seg-done/seg-running/open) under its title.

**Right column (side panel)**
1. **WORKFLOWS · n** panel (`Panel`, meta `+ add` = today's "use a library workflow"). Each row: name (12.5/600), trigger line (`GitHub · issue labeled factory` / `Schedule · daily 02:00` / `By hand`), latest result line (mono 10, state color: `● 1 running · ! 1 needs you`, `✓ last 6h ago`, `× last failed 1d ago`), plus a `Run` button (secondary compact). Triggers are edited from the workflow row (today's TriggerDialog), not shown inline.
2. **OPEN ISSUES · n** panel: issue rows with a `Hand off` link, which opens the 1k run form with the issue prefilled. Meta `all ›`.
3. **ASSISTANT NOTICED:** a plain section, not a panel. Up to 3 notes, each a sentence + one action link + `dismiss`. The assistant (LLM) writes them; there are no hard-coded rules. The user wants this **more prominent** than drawn. Try a small panel with an accent-wash bar at the top of the side panel.

Removed from today's page: WORK IN THIS REPO (workspaces) and the inline STARTS WHEN boxes. Workspace info moves to the chat/run side panels.

### Repo page, Lanes view (3b)
Same header (Lanes segment active) + New chat. Under the header: a **WORKFLOWS** chip row (name · trigger). Four lanes in `repeat(4, minmax(0,1fr))`, each lane fill `#efede7`, radius 3, padding 10, with mono 10/600 caps headers:
- **ISSUES · n:** issue cards (`#num` mono 10 + title). These can be dragged.
- **! NEEDS YOU:** waiting runs/chats with inline `Approve` / `Open`.
- **● RUNNING:** run cards with the progress strip, plus live chat cards.
- **FINISHED · 7 DAYS:** done / failed / ended chats. A failed card uses the failed pale edge.

**Drag an issue into Running:** the lane shows a dashed accent border with an accent-tint fill; on drop, a menu with an arrow opens: "START #421 WITH" → workflows that accept an `issue` input · "Chat about it instead". Choosing a workflow starts a run with `issue` filled in (or opens 1k if other required inputs are empty).

### Chat (2e + 1h)
Builds on `pages/Conversation.tsx` / `components/conversation/*`.
- Header: breadcrumb, title, participants.
- Transcript: messages from people and agents. An agent message header shows `Agent · model` (+ `· skill: name` when a skill ran) and a mono line of tool activity.
- **Switching agents:** the composer's agent chip (`Codex · gpt-5 ▾`) opens a menu with an arrow, "NEXT TURN RUNS ON", listing the project's agent profiles with ✓ on the current one. Switching inserts a centered mono divider: "Dana switched to Codex · gpt-5 · transcript and branch carried over".
- Composer hints: `/` skills, `#` issues, `@` another repo's agent (only when agent mail is on).
- **Side panel (280px, white, left border):** WORKS IN (the repo; read-only once the chat starts), BRANCH (+ files changed, PR link), AGENTS IN THIS CHAT (with turn ranges), skills used, LINKED CHATS (agent mail), and an **ASSISTANT** note at the bottom, e.g. "Plan → implement → review → PR. This could be a workflow." with `Make a workflow…` and `dismiss`.

### Thread → workflow (2f)
`Make a workflow…` opens the assistant panel (`components/assistant/AssistantPanel`) with the chat as context. The assistant:
1. Posts a draft step list built from the chat (Plan · Approval · Implement · Review · Open draft PR), each with its agent profile, and marks progress ✓ / ● / ·.
2. Asks structured questions as cards: an accent-wash body, accent mono caps "QUESTION 1 OF 2", the question, then option buttons (the selected one has an ink border and is bold). Example: "Should Review repeat until clean?" → `Repeat, max 3` / `Run once`. Then "What starts it?" → An issue / A typed goal / Either.
3. Saves a **library draft** (never publishes), then shows `Open draft` (goes to Studio).
This reuses the existing QuestionCard / ChangeChip patterns. The assistant needs tool schemas + examples to render these (see DECISIONS.md).

### Agent mail across repos (3d)
Optional, off by default (project setting). In a chat, the agent can ask the agent of another repo in the same project. This shows up inline as a bordered card: a fill-colored bar "→ asked the agent in **api**" with `open chat ›`, then the question, then "← api · Codex · gpt-5 · read handlers/search.go" with the answer. The side panel lists it under LINKED CHATS with its state. Agents asked this way are **read-only by default**; letting one edit its repo needs a person's approval.

### Workflow inputs, authoring (1j)
New **Inputs** tab on the workflow page (`pages/Workflow.tsx`; tabs: Overview · Inputs · YAML · Used in · History). Edits apply to the open draft revision; the header shows `draft r5 · unpublished` + `Publish r5`.
- **INPUTS · n** panel, grid `130px 120px 80px minmax(0,1fr)`: NAME (mono 600) · TYPE · REQUIRED (`required` in failed-fg / `optional` muted) · DEFAULT. Click a row to expand it into an accent-wash editor: Label, Type (select), Help text, Required toggle, and a "used as `${{ inputs.issue.body }}` in Plan" reference line.
- Types: GitHub issue, Branch, Agent profile, Text, Long text.
- **WHO FILLS THE INPUTS** panel (320px): one row per way to start the workflow. By hand → "Form asks for issue; others prefilled". Issue trigger → "✓ issue ← the labeled issue". Schedule → waiting-pale row "! issue is required and a schedule can't fill it".
- **YAML** preview panel showing the `inputs:` block.

### Run by hand (1k)
A modal (520–540px; ink border, raised shadow, `esc` hint). Title "Run <workflow>", subtitle mono "<repo> · pinned r4". Fields are built from the inputs: a GitHub issue becomes a **searchable picker** (shows the number, title, repo, and "● run in progress" when the issue already has a run), a branch is a mono text field with its default, an agent profile is a select, long text is a textarea. Required fields are marked `*` (failed-fg). Footer: helper text, `Cancel` (ghost), `Start run` (primary). Replaces the free-form part of `components/m4/NewRunForm.tsx`.

## Interactions & behavior
- Menus and popovers: Esc closes and focus returns to the trigger; arrow keys move between items; clicking outside closes (same as `NewMenu.tsx` today).
- The List/Lanes choice is saved per repo in layout prefs.
- Chat box `Start` → create a conversation (repo-scoped, chosen profile, first message) → go to the thread.
- `Hand off` → 1k with the issue filled in. Dropping in Lanes → workflow menu → start the run (or 1k if required inputs are missing).
- Assistant notes: `dismiss` hides the note for this user; acting on it runs the action and removes the note.
- Statuses always pair a glyph and a word (never color alone), per `states.ts`.
- **Fix:** every `<button>` needs `cursor: pointer` (Tailwind v4 dropped it). Add `button:not(:disabled){cursor:pointer}` to the `@layer base` block in `tokens.css`.

## State / data
- Activity feed: merge `useProjectRuns` (filtered to this repo, as `RepoRuns` does now) with conversations scoped to the repo; sort by last activity. Needs a repo filter on conversations.
- Workflow panel: existing `useAssignments` + `useSchedules` + `useIssueTriggers`, plus the latest run per assignment.
- Inputs: a new `inputs` block in the pipeline definition (schema change → ADR). Trigger→input mapping is stored on the trigger.
- Agent switch: the per-turn agent profile on conversation turns; capability differences shown in the picker.
- Agent mail: a new tool + linked-conversation relation, scoped to project membership.
- Assistant notes: a store of suggestions the assistant generates (per user, can be dismissed).

## Design tokens
Use `ui/src/styles/tokens.css` as-is. The values used here: paper `#f8f7f3`, surface `#fff`, ink `#1e1d1a`, ink-2 `#3a3833`, muted `#6b675e`, faint `#6e6a62`, line-strong `#cfcac0`, line `#e6e2d9`, line-soft `#f0ede6`, fill `#efede7`, fill-edge `#cfc9bd`, accent `#2f4bd6` / edge `#2238a8` / shadow `#1a2d8f` / text `#2a43b8` / mid `#8fa0e6` / tint `#eef0fc` / wash `#f6f7fe` / ring `#dfe4fa`, plus the state sets from `states.ts`. Radii 2 / 3 / 4. Shadow `2px 2px 0`. Type: Red Hat Text (UI), Red Hat Mono (machine text, labels), Kaisei Opti (mark only). Sizes 22 / 17 / 15 / 13.5 / 13 / 12.5 / 12 / 11 / 10.5 / 10.

## Assets / icons
The mocks use Unicode glyphs (▾ ▸ « » ⋯ ●) as placeholders. **Replace them with an icon library.** The user wants to move off Unicode arrows and is open to something other than Lucide (already a dependency). Candidates, to confirm with the user: **Phosphor** (`@phosphor-icons/react`, has thin/regular/bold weights that suit the hairline style), **Tabler** (`@tabler/icons-react`, large set, close to Lucide's look), or keep **Lucide**. Use 14–16px icons with stroke matching the 1px/1.6px hairlines. State glyphs (● ! × ⊘ ↻ ✓ · i) are part of the design system and **stay** as text.

## Open questions (confirm before or while building)
- Home page name: Today / Inbox / Overview. Does Inbox stay as its own page?
- Icon library choice (see above).
- How prominent the assistant notes should be.
- Whether project-wide chats exist at all (leaning no: chats are repo-scoped).

## Files
- `Directions.dc.html`: all rounds (3 at top, then 2, then 1). Open in a browser; it needs `support.js` next to it.
- `DECISIONS.md`: running log of decisions, open threads and engineering items.
- Source repo map: `github.md` at the project root.
