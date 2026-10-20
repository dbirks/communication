# Handoff: Communication — app shell and IA redesign

## Overview

This redesigns how the Communication UI (`dbirks/communication`, `ui/`) is organized. The visual identity (tokens, type, panels, status chips, hard-shadow buttons) **stays as it is**. What changes is the frame and the information architecture:

- A permanent **left sidebar** replaces the top app bar. It has cross-project views (Home, Inbox, Board, Threads), then projects with their repos nested under them, then a shared library (Workflows → folders, Steps, Agent profiles).
- **Home** is a briefing: decisions that need you, runs in progress across all repos, and recent one-off threads.
- **Workflows** are sets built from **Steps** (formerly “nodes” / “node templates” in the UI). A step's agent profile is chosen in the workflow when you add the step.
- **Agent profiles** are agent + account + optional APM package + sandbox. Creating one is a single dialog with safe defaults.
- **The assistant** is available on every page as a popover (⌘K), can expand to full screen, has a mic, asks follow-up questions with model-written answer buttons, edits drafts, navigates and gives tours, and runs under a **per-person trust level**.
- **Runs** get a Board (kanban by state), a click-in drawer, and a workbench with the pinned graph plus a live transcript that can go full screen, with an explicit take-control handoff.
- **One-off threads** are direct agent conversations on one repo, which can be handed to a workflow.
- **Inbox** works on a phone: model-written two-line summaries and model-chosen buttons colored by risk. Replies are free text sent back to the model.

## About the design files

The files in this bundle are **design references made in HTML**. They show the intended look and behavior; they are not production code to copy. Recreate them in the existing `ui/` app (React + TypeScript + the components in `ui/src/components/ds/`), using its routing, data fetching and component patterns. Where a design calls for something the app doesn't have yet (sidebar, popover assistant, board, drawers), build it from the existing `ds` primitives and `ui/src/styles/tokens.css`. Don't introduce a second style system.

Open `Rethink - Six Directions.dc.html` in a browser. It is a pan/zoom canvas with five turns, newest at the top. **Turns 4 and 5 are the current decisions.** Turns 1–3 are history, kept for context; where they disagree with 4–5, follow 4–5.

## Fidelity

**High fidelity for visuals.** Colors, type, borders, radii and shadows are the app's real tokens and should match exactly. **Medium fidelity for layout and data.** Widths and structure are intended, but all data is made up, and some behaviors are proposals that need backend work (flagged below as **[needs backend]**).

## Decisions made with the product owner

| Topic | Decision |
|---|---|
| Frame | Left sidebar on every page. No top app bar. |
| Sidebar order | Cross-project nav first → Projects → Library → user/settings footer |
| Projects in sidebar | **Tree is the default** (all projects, repos nested). A project switcher is an optional per-user setting. |
| Name for reusable pieces | **Steps** (the Studio already says “Add a step”). “Workflow” for the whole set. |
| Workflows in sidebar | Expands to **folders**, not every workflow. The Workflows page lists them. |
| Where a step's profile is chosen | **In the workflow, per step**, when the step is added. No per-project override. |
| Home | **Briefing** (needs you, running now, recent threads). |
| Assistant change list | Collapsed into a **“N changes · undo all”** chip. |
| Assistant permissions | **Per-person trust level**: Ask before everything / Ask for risky actions (default) / Don't ask. A user preference applied in the assistant's tool loop; it doesn't need its own server-side enforcement. The assistant acts as the user, so the existing API authorization already caps it at the user's role. |
| Phone buttons | **Labels written by the model, colors fixed by risk** (red = refuse or destructive, royal = go ahead, neutral = other). |
| Agents offered | Claude Code, Codex, Pi, Antigravity, “Other ACP agent”. |
| Publish | **No separate Publish step for now.** Agents may hold a GitHub token (via their profile's account/secrets) and push or open PRs themselves. Leave Publish out of the step picker; it can come back later as an optional step. |

## Screens

Screen IDs match badges on the canvas. Each 1280×800 artboard is a desktop frame: 240px sidebar plus content.

### Shell — Sidebar v3 (`SidebarV3.dc.html`, canvas 5a)
- **Width** 240px, white, `border-right:1px solid #1e1d1a`, padding 12px 10px, vertical flex, gap 12px.
- **Mark + “Communication”**: the existing `Mark` component (26px, hatched royal offset shadow, Kaisei Opti “C”).
- **Actions row**: `New` (primary, flex 1, 30px) and `Ask ⌘K` (secondary, mono 11px).
- **Cross-project nav**: Home, Inbox (`! 2`, amber), Board (`● 4`, blue), Threads (count). Rows have 5px 8px padding and 13px text. The active row has a `1px solid #1e1d1a` border, white background with a 4px blueprint grid (`#e4e8fa` lines), and weight 600. Inactive rows are `#6b675e` with a transparent border.
- A 1px `#e6e2d9` divider.
- **Projects (tree, default)**: a mono 10px `PROJECTS` label (letter-spacing .06em, `#6e6a62`). Each project row is 12.5px, weight 600, with a **16px chevron SVG** (stroke 1.6, `#3a3833`; down = open, right = closed). The project's worst status flag sits on the right: `× 1` red, `! 1` amber, `● 1` blue. Repos are indented 14px with a `1px #e6e2d9` left rule, mono 11.5px, each with its own live flag.
- **Projects (switcher, setting)**: a `PROJECT` label, then a 36px secondary-style button (initials tile, name, status flag, chevron) and the selected project's repos below. The dropdown lists projects with flags and ends with “All projects”.
- **Library**: Workflows with a chevron and count, its folders indented (Delivery 2, Maintenance 2, Drafts 1), then Steps (9) and Agent profiles (5).
- **Footer**: `margin-top:auto`, top rule, 26px initials tile, name, `Settings` link. Operations is reachable from Settings or as an optional sidebar row (see 4h).
- Chevrons: use a real SVG chevron (`M3 4.5l3 3 3-3`), 14–16px. **Not** the ▾ glyph; it read as a bullet.

### Home — briefing (canvas 2a; use the v3 sidebar)
- Content max-width ~960px, padding 22px 28px, gap 16px.
- H1 “Good afternoon, David” (22/28, 600), then a mono 10.5px count line: `! 2 need you` (`#7a4a00`), `× 1 failed` (`#b0281a`), `● 3 running` (`#0f5e96`), `· 1 queued` (`#6e6a62`).
- **Decision callout**: an amber panel (`#fdf6e4` background, `#e8cf94` border, `#fbe7b4` header strip with `#5c3d00` mono 10px caps “! NEEDS YOUR DECISION” plus workflow, run, repo and age on the right). The body has the summary sentence plus `Read plan` (secondary) and `Approve` (primary), 26px.
- **Running now** panel: a header strip (`#efede7`, mono caps) with “open board ›”. Rows are 38px, grid `92px 1fr 120px 110px 36px`: status chip, title with `workflow #id · repo`, segmented progress bar (one 7px segment per step: done `#4a4740`, running `#1a6da6`, waiting `#f0a93a`, failed `#c02a1a`, pending white with a `#cfcac0` border), current step, age.
- **Recent threads**: 34px rows with glyph, title, `repo · agent`, and age.

### Assistant popover (2a, 3d, 4d)
- Opens with ⌘K or the sidebar Ask button. 400px wide, `1px #1e1d1a` border, radius 4, `2px 2px 0 #1e1d1a` shadow, anchored bottom-right of the content (or from the sidebar if Ask sits at the top; both are allowed via a setting, 3g).
- Header strip: `ASSISTANT`, then a **trust-level pill** (`ask for risky ▾`), `⤢ expand`, and `esc`.
- **Composer**: a context chip naming the current page (`home`, `feature-delivery`, `run 9c1e`, …), the input, and a **mic button** (36px, secondary style, Lucide-style mic SVG).
- **Empty state**: three dashed suggestion chips specific to the page (“FOR THIS PAGE”).
- **Listening state**: the user's words appear as they're spoken in a dashed royal bubble, with a waveform bar in the input (royal bars, timer) and `Done`.
- **Answers** can include link rows with `Go ›` (navigation), action buttons, and a collapsed “used N tools ▸”.
- **Follow-up questions**: the model asks a question and offers 2–4 answer buttons it wrote (secondary, left-aligned, 32px), plus “Or say it your way…”. **Whatever the user taps, types or says is sent back to the model as plain text.** The model then proposes an action.
- **Change chip**: `3 changes ▴ undo all` (mono 10.5px, `1px #1e1d1a`). It expands to a list with per-item undo.
- **Approval card** (risky action under “Ask for risky”): amber panel with “! NEEDS APPROVAL”, a sentence, and `Retry` / `Not now`.

### Assistant expanded (2c)
- Full content area, conversation column max-width 680px, centered. Header has the name, a context chip “opened from Feature Delivery”, and `Shrink to popover`.
- Shows a multi-workflow edit result (✓ lines, mini diagram cards of each changed draft with the new step dashed royal), `Tour the changes` / `Open both drafts` / `Discard`, and a structured question (radio list) under “! AWAITING YOUR ANSWER”.
- **Decision**: drop 2c's right “Changes in this conversation” column and use the change chip instead.

### Tours (2b)
- The assistant can run a guided tour: it dims the page with a `0 0 0 9999px rgba(30,29,26,.30)` spotlight, draws a 2px royal ring around the target, shows numbered markers (22px circles), and a step card (`STEP 2 OF 4 · THE LOOP`, text, Back/Next). A bottom pill reads “Touring Feature Delivery 2 / 4 · Ask about this step… · End tour”.
- A tour step is `{route, targetSelector, title, body}`. Generate tours from the assistant and allow saving them. **Later phase.**

### Board (2d, 3c)
- Header: title, a segmented control (by state / by repo / by workflow), filter chips (all projects / mine / from issues / scheduled), and `Start run`.
- 5 columns: QUEUED, RUNNING (`#d9eefa`/`#0f5e96`), ! NEEDS YOU (solid `#f0a93a`, ink text), × FAILED (solid `#c02a1a`, white text), DONE TODAY.
- Card: `workflow #id`, title, segmented bar, repo chip and current step. Waiting cards get `Approve` / `Read plan`. Failed cards get `Retry from <step>` / `Fix the workflow`.
- **Click a card** to open a 440px **right drawer** (3c): a header strip in the state color, title, meta, a strip of steps (one cell per step, colored by state), a model-written summary with “Read the full plan ›”, the latest 3 events, actions, and an “Ask about this run…” composer with a mic. `Open run ›` goes to the workbench.

### Workflows index (3a)
- Grouped by folder (collapsible headers). Each row is a grid `220px 1fr 200px 150px`: name plus revision chip (`✓ PUBLISHED r3 8f2c1a` green, `! BETA r5 · STABLE r4` amber), a chain of steps (loops shown as a shaded chip), assigned repos plus trigger, the open draft link, and `Duplicate` / `Open`.
- Header: filter chips, `Import YAML`, `New workflow`.

### Workflow editor (1d → 2b → 4a/4b)
- Top bar (52px): breadcrumb `Workflows / Delivery /`, name, `· DRAFT #12` chip, tabs (Canvas, YAML, Runs, Assigned to N repos), `Validate`, `Publish r4`.
- The canvas is the existing Studio graph (`ui/src/components/studio/nodes.tsx` styling: 6px nodes, `#e6e2d9` border, selected `#2f4bd6` with a `0 0 0 2px #dfe4fa` ring; loop groups are 8px with an `#efede7` header).
- **Add a step (4a)**: hovering an edge shows a 22px `+`. Clicking opens a 360px picker: a search/describe input; **START A NEW STEP** cards for Agent, Command, Approval, Loop, Workflow (the design also shows Publish; **leave it out for now**); **YOUR SAVED STEPS**; and a footer hint that typing a description lets the assistant draft the step.
- **New agent step (4b)**: the step appears on the canvas dashed royal, marked “new · unsaved”. The inspector has the step id, the **Agent profile** dropdown (defaults to the profile of the previous agent step and is marked SUGGESTED; every option shows sandbox status; the last option is `+ New profile…`), “What should it do?”, and an unchecked **“Also save as a reusable step”**.
- Selecting an existing step in the inspector offers `Duplicate as a new step…` and `Edit for all N workflows → version x.y.z` (running runs keep the old version; workflows get drafts to adopt the new one).
- Assistant proposals show on the canvas as dashed royal steps, with an Accept/Undo bar.

### Steps (3b)
- Grouped list (AGENT, CHECK, GATE, PUBLISH, LOOP). 40px rows: name plus version, config summary, kind (mono), and “N workflows”.
- The right panel (360px) has a description, key/value facts, **USED IN N WORKFLOWS** with live status per use, `Edit for all N → version`, and `Duplicate as a new step…`.

### Agent profiles (2e, 3e) and New profile (4c → 5b)
- Profile list (260px) with name, launcher and a sandbox chip (`✓ REQUIRED · VERIFIED` green, `! INSECURE DEV EXECUTION` amber, `! LAUNCHER NOT REGISTERED` amber).
- Detail panels: **SANDBOX · NONO** (files, network allowlist, secrets, last checked), **ACCOUNT** (secret reference; “value never shown”; can include a GitHub token so the agent pushes and opens PRs itself), **FROM APM PACKAGE** (three columns: skills, instructions, MCP servers, with the package ref and digest), and **USED BY N STEPS**. The APM note reads: “Copied into the agent's workspace when it starts. This is not a security boundary; the sandbox above is.”
- **New profile dialog (5b)**: 720px modal. **AGENT** is 5 cards (Claude Code, Codex, Pi, Antigravity, Other ACP agent): a 30px mono tile, name, launcher, and readiness line (green verified / amber not tested or not registered). Below that: account select (16px chevron), name (suggested from agent + step), optional APM package with `Lock it` **[needs backend: compute the lock/digest server-side]**, and a green defaults bar (“✓ sandbox required · permission ask · egress allowlist from the project · Change”). Footer: `Cancel`, `Create and use in <step>`.
- Readiness comes from launcher registration plus compatibility probes. **Never show “verified” without a probe result.**

### Run workbench (4e, 5c)
- Header: title, status chip, meta (`workflow #id · repo · revision r3 8f2c1a (pinned) · started by …`), `Fix the workflow…`, `Pause`, `Cancel run` (danger). Tabs: Graph, Timeline, Artifacts, Diagnostics.
- **Split**: the read-only pinned graph (live state per step, iteration counter on loops, “edits go to a new draft”) plus a **480px transcript** for the selected step: iteration tabs, attempt/worker, the controller line, the prompt card, agent messages, and tool-call rows (✓/● with diffstat or timing).
- **⤢ Full screen (5c)**: the graph collapses to a strip of step cells across the top (current step raised with a hard shadow), and the transcript is centered at max 760px. `⤡ show graph` returns to the split.
- **Take control (5c)**: clicking it shows a confirm card: “The run pauses before its next step… when you hand back, the loop continues from `test`.” `Take control` / `Just watch`. The composer stays disabled (“Take control to send prompts”) until control is granted. **[needs backend: controller lease handoff and pause-before-next-step]**

### One-off thread (4f)
- Header: title, `thread · repo · profile · age`, a “You're in control” pill, `Stop` (danger).
- Conversation column (max 820px): user bubble (`#eef0fc`), tool-call rows, agent prose, and an **inline permission card** (amber, `Deny` danger / `Allow once` primary). Composer: a 1px ink border with hard shadow, mic, and `Send`.
- Right rail (300px): **WORKSPACE** (repo, branch `thread/<slug>`, base, changed files, sandbox), **ARTIFACTS**, **NEXT** (`Open a draft PR from this branch`, `Hand to a workflow…`).

### Hand to a workflow (5d)
- 640px modal: workflow select, then **CARRIES OVER**: the branch becomes the run's base; an editable model-written summary becomes the first step's input; artifacts are attached; the thread stays open and links to the run. Note: “the run starts fresh agent sessions; the thread's conversation is not replayed”. **[needs backend: start a run from a branch with seeded input]**

### Approval detail (4g) and phone inbox (2f → 3f)
- Desktop: a full-width amber strip (`expires in 22h · on timeout: fail`). Main column: title, meta, a **model-written summary** card, the `plan.md` artifact rendered, and **FILES IT WILL TOUCH** (+/~ list, new dependencies flagged amber). Right rail (360px): who / then, **SUGGESTED** buttons (model-written; colored by risk), and **OR IN YOUR WORDS** (textarea, mic, Send). Footnote: “you confirm whatever it proposes”.
- Phone (390×844): Inbox list cards. Each card has a type chip, repo, age, title, a **2-line clamped summary**, “More”, and two 44px buttons. The detail view has the summary, the user's free-text reply, and the model's proposed interpretation with `Change it` / `Approve with note`.
- **Button rule**: the model returns `{label, intent, risk}`; the UI maps risk → style (`refuse|destructive` → danger, `proceed` → primary, else secondary). Labels are free text. Every action is confirmed by the user.

### Operations (4h)
- Health line (replicas, queue depth, oldest lease). An **interrupted** callout (`#faf2ef` / `#e6c3b8` / `#f2d6cc` header / `#7a3424` text, “⊘ INTERRUPTED — outcome unknown”) with `Reclaim and retry`.
- Workers table: worker, status chip, leases, sandbox mode, heartbeat.
- **Agent × capability matrix** (ACP session, resume, permission prompts, nono required): `✓ observed` green, `× not supported` red, `not tested` muted. Only show what probes observed.

### Settings → Layout (3g)
- Projects in the sidebar: **All projects as a tree (default)** / Project switcher. Ask button: top of the sidebar (default) / floating bottom right. Workflows in the sidebar: show folders / link only. ⌘K always works.
- Settings → Assistant: the trust level (same three options as the pill).

## Interactions & behavior

- **Routing (suggested)**: `/` Home · `/inbox` · `/board` · `/threads`, `/threads/:id` · `/p/:project`, `/p/:project/:repo` · `/workflows`, `/workflows/:id` (editor), `/workflows/:id/drafts/:n` · `/steps`, `/steps/:id` · `/profiles`, `/profiles/:id` · `/runs/:id` (workbench, `?step=&iter=&full=1`) · `/ops` · `/settings/:tab`. Keep the existing routes working as redirects.
- **Sidebar**: expand/collapse state is per user and persisted. The status flags are live.
- **Drawers and popovers**: `esc` closes them. Focus is trapped in modals. The assistant popover keeps its conversation across page changes; the context chip updates to the new page.
- **Trust level** gates assistant tools:
  - *Ask before everything*: every tool call that changes state, including navigation, shows a confirm card.
  - *Ask for risky* (default): it can read, navigate, tour and edit drafts on its own. It asks before starting or retrying runs, approving gates, allowing permission requests, and publishing or promoting.
  - *Don't ask*: it can do everything, with each action logged and undo offered where possible.
  - It calls the same API as the user, so it can never do more than the user's role allows. It never reads secret values.
  - The trust level is stored as a user preference and checked in the assistant's tool loop before each action. No separate server-side permission system is needed.
- **Undo**: every assistant mutation is recorded against the conversation; the chip offers per-item undo and undo all. Draft edits are reversible; runs and approvals are not (say so).
- **Loading**: skeleton rows using the panel grid. **Empty states**: one sentence plus a primary action. **Errors**: the existing `Alert` component.
- **Live updates**: runs, board, inbox and sidebar flags subscribe to the existing event stream. Don't poll.

## State

- `layoutPrefs` (per user): `{ projectsMode: 'tree'|'switcher', askPlacement: 'sidebar'|'floating', showWorkflowFolders: boolean, expanded: Record<id, boolean> }`
- `assistant` (per user): `{ trustLevel: 'ask_all'|'ask_risky'|'no_ask', conversations, activeConversationId, changes: Change[] }`; `Change = { id, kind, targetRef, summary, undoToken }`
- `assistantQuestion` message: `{ prompt, options: {label, value}[], allowFreeText: true }`. The reply sent is always text.
- `inboxItem`: `{ id, kind: 'approval'|'permission'|'failed'|'question', refs, summary, actions: {label, intent, risk}[] }`. Summary and actions are produced by a summarization pass **[needs backend]**.
- `run`: existing run/graph state plus `controller: {kind: 'pipeline'|'user', userId?}`.

## Design tokens (from `ui/src/styles/tokens.css`; use the variables, values here for reference)

- **Ink** `#1e1d1a` · **paper** `#f8f7f3` · **surface** `#ffffff` · **sunken/strip** `#efede7` · **line** `#cfcac0` · **line-soft** `#e6e2d9` · **hairline** `#f0ede6` · **text-2** `#3a3833` · **muted** `#6b675e` / `#6e6a62`
- **Royal (primary)** `#2f4bd6`, border `#2238a8`, shadow `#1a2d8f` · **link** `#2a43b8` · **focus ring** `#dfe4fa` · **selected bg** `#f6f7fe` · **assistant/user tint** `#eef0fc` · **blueprint grid** `#e4e8fa`
- **Status** (chip bg / fg; panel bg / edge):
  - running `#d9eefa`/`#0f5e96`; `#f3f9fd`/`#8cc8ec`; bar `#1a6da6`
  - waiting `#ffecc2`/`#7a4a00`; `#fdf6e4`/`#e8cf94`; header `#fbe7b4` text `#5c3d00`; solid `#f0a93a`
  - failed `#fdd8d2`/`#b0281a`; `#fbefec`/`#e5b2a8`; solid `#c02a1a`; danger button border `#e5a99c`
  - done `#d9f0de`/`#1f6b37`; `#f1f7f2`/`#b9d3bf`
  - queued `#eeece6`/`#5e5a52` · info `#e3f1fb`/`#135f96`
  - interrupted `#fde3d6`/`#a5431c`; `#faf2ef`/`#e6c3b8`; header `#f2d6cc` text `#7a3424`
- **Glyphs**: `●` running, `!` needs you, `×` failed, `✓` done, `·` queued, `i` info, `⊘` interrupted. Status is never conveyed by color alone.
- **Type**: Red Hat Text (UI), Red Hat Mono (meta, ids, code, labels), Kaisei Opti (mark only). Sizes: 30/36 page title (canvas only), 22/28 H1, 19 H2, 15 section, 13.5 body, 12.5 controls/rows, mono 10–11.5 meta. Caps labels are mono 10px, weight 600, letter-spacing .04–.06em.
- **Radii**: 3px panels/chips/inputs · 4px buttons/popovers · 6px graph steps · 8px loop groups · 44px phone frame.
- **Shadows**: hard offset only. Buttons `2px 2px 0 <border>`; selected cards and popovers `2px 2px 0 #1e1d1a`; menus `0 8px 24px rgba(30,29,26,.18)`.
- **Buttons**: primary (royal), secondary (`#efede7` with `#cfc9bd` border and shadow), ghost (link color), danger (`#fdd8d2`, `#b0281a` text). Heights 26 / 30 / 36; mobile 44–48. `white-space:nowrap` on all buttons.

## Assets

No images. Icons: the SVG chevron (path above) and a Lucide-style mic (`rect x9 y3 w6 h11 rx3`, `path M5 11a7 7 0 0 0 14 0`, `path M12 18v3`, stroke 2). Use the codebase's icon set if it has one.

## Files

- `Rethink - Six Directions.dc.html` — the full canvas (open in a browser; pan/zoom). Turns 4–5 are current.
- `SidebarV3.dc.html` — the current sidebar (props: `active`, `mode`).
- `SidebarV2.dc.html`, `Sidebar.dc.html` — earlier sidebars used by Turns 2–4.
- `Current - Projects.dc.html` — today's Projects page, recreated for comparison.
- `support.js` — runtime needed to open the `.dc.html` files.
- `GOAL.md` — a ready-to-paste goal for your coding agent.

Existing source these were built from: `ui/src/styles/tokens.css`, `ui/src/components/ds/*` (AppBar, Panel, Row, Button, Mark, SubNav, Field, Alert, states.ts), `ui/src/components/Shell.tsx`, `ui/src/components/CommandPalette.tsx`, `ui/src/components/NewMenu.tsx`, `ui/src/components/studio/nodes.tsx`, `ui/src/pages/Projects.tsx`, `ui/src/pages/Agents.tsx`, `communication-spec/examples/*.yaml`.
