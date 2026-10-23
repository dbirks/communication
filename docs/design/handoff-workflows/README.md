# Handoff: Project, repository, threads and workflow screens

## Overview
This redesign covers six screens in the Communication web UI (`dbirks/communication`, `ui/`). The app shell (Sidebar v3), tokens and `ds` primitives stay as they are. What changes is the page layout, the hierarchy, the copy and the canvas behavior on:

1. Project page `/p/:projectId`
2. Repository page `/p/:projectId/:repo`
3. Threads `/threads` (and a project's Threads tab)
4. Workflows index `/workflows` and the New workflow dialog
5. Workflow page `/workflows/:id` (including Triggers and YAML)
6. Workflow Studio `/workflows/:id/drafts/:draftId`

## About the design files
The `.dc.html` files in this folder are **design references made in HTML**. They show the intended look and behavior; they are not production code to copy. Rebuild them in `ui/` (React + TypeScript + Tailwind v4 + `ui/src/components/ds/*`), following its routing, React Query data hooks and component patterns. Open the files in a browser; they need `support.js`, which sits next to them. Each file is a pan/zoom canvas. Every screen has a badge id (1a, 1b, …). Each row pairs **Today** (recreated from the current source) with **Proposed**.

## Fidelity
**High fidelity for visuals.** Colors, type, radii, borders and shadows are the app's real tokens (`ui/src/styles/tokens.css`). Use the token classes, not hex values. **Medium fidelity for layout and data.** Widths and structure are intended. All data is made up. Never fake data the API doesn't serve (AGENTS.md "honesty" rules still apply). Show an honest empty state and list the gap.

## Chosen screens (the product owner picked these)
| Screen | Pick | File |
|---|---|---|
| Project page | **1b** · tabs across the top (1c, sections in the sidebar tree, was not chosen) | Projects Review.dc.html |
| Repository page | **1e** | Projects Review.dc.html |
| Threads | **1g** | Projects Review.dc.html |
| Workflows index | **1b** + dialog **1c** | Workflows Review.dc.html |
| Workflow page | **1e** | Workflows Review.dc.html |
| Studio | **1g** | Workflows Review.dc.html |
| Workflow page "Used in" tab | **2a**: replaces the Triggers tab and Start run | Workflows Review.dc.html, Turn 2 |
| Triggers | **2e**: edited on the repo page, under each workflow the repo uses, with dialog **2c**. (**2b**, a canvas card, was not chosen.) | Workflows Review.dc.html, Turn 2 |
| YAML | **2d** · block style | Workflows Review.dc.html, Turn 2 |

The "WHAT'S WRONG WITH …" cards under each row list the problems with the current screen. Use them as a checklist.

---

## Shared page pattern (all proposed screens)
- Shell: unchanged (`components/Shell.tsx` + `Sidebar.tsx`). Content is **not** capped at `max-w-5xl` on these pages; it uses the full content column (viewport − 240px sidebar).
- **Page header** (project, workflow): white (`bg-surface`) band, `border-b border-line-strong`, padding `20px 28px 0`. Inside:
  - H1 22/28px, weight 600.
  - Subtitle 13.5px `text-muted`.
  - Actions on the right: one **primary** button, others secondary, 30px tall.
- **Header tabs**: a row of links that sits on the band's bottom border (`margin-bottom:-1px`).
  - Each tab: 13px, padding `6px 12px 7px`.
  - Active tab: `1px solid ink` border with the bottom border set to the paper color, radius `3px 3px 0 0`, `bg-paper`, weight 600.
  - Inactive tab: transparent border, `text-muted`.
  - Counts trail the label in mono 10.5px. Use the status glyph and color when the count means something, e.g. `! 2` in `st-waiting-tag-fg`.
  - Tabs are routes, not fragments.
- **Body**: padding `22px 28px`. Two columns `minmax(0,1fr) 300px`, gap 20px. Below 1024px the columns stack.
- Panels: the existing `Panel` (CARD-L). Header text: mono 10px caps. Row padding grows to `10–12px`, and rows grow to fit their content: **don't use fixed 34px `Row`s for two-line content**.
- Callouts (needs decision / failed) use the ALERT pale set:
  - Waiting: body `st-waiting-pale-body`, edge `-pale-edge`, header strip `-pale-bar`, text `-pale-fg`.
  - Failed: the same roles from the failed set.
  - Actions sit inline in the callout, compact 26px.

## 2. Repository page (1e) — only the parts 2e needs are in scope for this goal
- **Header**: Breadcrumb `Project /` in mono 11px, then H1 with the repo name. Mono line: `remote · default branch`. Actions: `New thread here` (secondary) and `Start run` (primary).
- **Left column, WORKFLOWS ON THIS REPO**: each row: name · revision chip (`✓ r3`) · trigger sentence, then a mono step chain (reuse `stepChain()` from `WorkflowRow.tsx`; loop scopes are shaded chips). Buttons: `Edit` (secondary-plain) and `Run`. Panel header link: `+ assign a workflow`.

## 4. Workflows index (1b) + New workflow (1c)
- **Header**: H1 `Workflows` + mono count; `Import YAML` (secondary); `New workflow` (primary). Delete the inline `NewPipelineForm` panel.
- **Starter cards**: 3 columns, gap 12. One `START BLANK` card (dashed border) and one card per template: mono caps `TEMPLATE · n STEPS`, the name, the step chain. Clicking a card opens the dialog with that template preselected. Remove the bottom `STARTER WORKFLOWS` panel.
- **Filters**: a search field (240px) + chips `all` / `has open draft` / `used in <project>`.
- **Folder groups**:
  - Each folder is a `Panel` whose header holds an SVG chevron (`M3 4.5l3 3 3-3`), the folder name in caps and a count. Replace the ▾/▸ glyphs.
  - Rows: grid `220px 1fr 180px 120px`. Name 13.5/600 + chip `✓ r3` (no digest) or `· draft · not published` · step chain · where it's used (`project · repo`, or "Not used yet") · `Edit` + a `⋯` menu (Use in a repo…, Duplicate, Move to folder…, Export YAML).
  - Bug fixed by this layout: today's three buttons (~290px) overflow the 150px column.
- **Dialog (1c)**: 520px wide, ink border, `2px 2px 0 ink` shadow, radius 4.
  - **NAME** field; below it the id generated from the name: `id: retry-payments-plan · change`.
  - **START FROM** as 3 radio cards. The selected card has an ink border, hard shadow and `bg-accent-wash`. The template description shows below the cards.
  - **FOLDER** select.
  - Footer: `Cancel` · `Create and open canvas` (primary). This runs the existing two writes (create pipeline → create draft), then navigates to the Studio.
  - Keep the `409` (duplicate slug) handling, shown inline on the id line.

## Mental model: library workflows are templates
A workflow in the library (`/workflows`) is a reusable template. It never runs by itself. A **repo uses** a workflow (a project assignment pinned to a revision), and runs and triggers belong to that use. So:
- The library workflow page has **no Start run** and **no trigger editing**. It shows where it is used.
- Triggers are created and edited on the **repo page** (and listed on the project's Workflows tab across all its repos).
- In the UI, "Assign to a project" becomes **"Use in a repo…"**, which picks a project and repo, then pins the latest revision.

## 5. Workflow page (1e, 2a, 2d)
- `/workflows/:id` opens on **Overview** (today it opens on the revisions/drafts/YAML page).
- **Header**: breadcrumb `Workflows / <folder> /`; H1 + revision chip; the line "Library workflow. It runs only in the repos that use it, and triggers are set up there."; `Use in a repo…` (secondary); `Edit workflow` (primary).
  - Edit workflow opens the newest open draft in the Studio. If there isn't one, it creates a draft from the newest revision (the current "Customize" logic).
- **Tabs**: Overview · YAML · Used in (n) · History.
- **Overview**:
  - A read-only `DefinitionGraph`, laid out **top-to-bottom**, on the dotted canvas, with the caption `read-only · r1 · Edit workflow opens the canvas on your draft`.
  - Right rail 300px with four blocks:
    - **OPEN DRAFT**: a wash card with `v3 by <name> · 2h · valid` and `Continue editing ›`.
    - **USED IN**: project / repo and the trigger sentence, plus `+ Assign to a project`.
    - **INPUTS**: from `spec.inputs`.
    - **LAST RUNS**: glyph rows.
- **History**: today's REVISIONS and DRAFTS panels move here.
- **YAML tab (2d)**:
  - Serialize **block style** everywhere: this tab, the Studio YAML mode and export. Lists as `- item`, maps nested under their keys, no `{}`/`[]` flow collections. With the `yaml` package, set `collectionStyle: 'block'` / `flowCollectionPadding` off, or `doc.toString({ collectionStyle: 'block' })`.
  - Show line numbers, plus `copy · download` in the header.
- **Used in tab (2a)**: one panel, `USED IN n REPOS`.
  - Rows: grid `200px 120px 1fr 150px 56px`:
    - Repo name 13/600 over its project (mono).
    - The pinned revision (`pinned r2 · latest`, or `pinned r1` + an `Update to r2` link).
    - Its triggers as read-only sentences with icons (GitHub: "issue labeled `plan`"; clock: "Mondays 06:00 UTC"; play: "started by hand").
    - The last run (glyph + id + age, in its state color).
    - `Open ›`, which goes to the repo page.
  - Footnote: "Open › goes to the repo page, where its triggers are edited."
  - Data: the same assignment / schedule / issue-trigger fan-out `components/workflows/Triggers.tsx` already does.

## 5b. Triggers on the repo page (2e)
- In the repo page's **WORKFLOWS ON THIS REPO** panel (see 1e), each workflow row is collapsible (SVG chevron).
- Collapsed row: name · revision chip · trigger summary ("started by hand", or icons + sentences) · `+ Add trigger` link · `Run`.
- Expanded row: a **STARTS WHEN** box, indented 34px.
  - Header strip: `bg-accent-wash`, mono caps in accent-text, with `+ Add trigger` on the right.
  - One row per trigger: grid `18px 1fr 160px 80px 40px`. Icon · sentence (13/600; labels as mono chips) over a mono detail line (repo · "checked every minute", or the cron + fixed inputs) · last fired / next fire / last error · on/paused switch · `Edit`.
  - Last line: "Or start it by hand with Run, or from an issue below."
- The header link changes from `+ assign a workflow` to `+ use a library workflow`.
- Routes are unchanged: the ADR-0032 schedule routes and the ADR-0056 issue-trigger routes. Keep `422 invalid_cron` / `409` inline.

## 5c. Trigger dialog (2c)
- 520px, same chrome as the New workflow dialog.
- Title `Add a trigger`, with the context underneath in mono (`plan-with-approval · Northwind / storefront`). The project and repo come from where it was opened, so there are no selects for them.
- **START IT WHEN**: a segmented control, `[GitHub icon] A GitHub issue…` / `[clock icon] On a schedule`. The selected segment is `bg-ink text-surface`.
- Issue: **IS** (`opened` / `labeled`), then **WITH ANY OF THESE LABELS** (chip input). Schedule: the cron field with its English reading next to it (`cronInWords`), plus the fixed inputs.
- **THE RUN GETS** box (`bg-paper`): the input mapping, e.g. `goal` = the issue title and body; `repository` = storefront.
- Footnote: "Checked every minute · public GitHub repositories only".
- **Icons**: Lucide `github`, `clock`, `play` at 14px, stroke 2, `currentColor`. This adds `lucide-react` as a new dependency (APPROVED by the product owner). Don't use `#` or `◷` glyphs for trigger types.

## 6. Studio (1g)
- **Height**: the page fills the viewport. Remove `h-[calc(100vh-91px)]` (it was sized for the removed top bar and footer) and use `h-screen` with the column flex.
- **Header (52px)**:
  - Left: breadcrumb `Workflows / <folder> /`, name 15/600, then a draft chip (`· DRAFT V3 · UNSAVED` on the queued set).
  - A Canvas | YAML segmented control (selected segment `bg-ink text-surface`).
  - Right: undo/redo as 30px icon buttons (`↶ ↷`), `Validate`, `Save`, `Publish` (primary; disabled until it can publish).
  - Remove the Runs/Assigned links; they live on the workflow page.
- **Status bar (30px, bottom)**: mono 10.5px: `n steps · unsaved changes` on the left. On the right, the publish reason in words ("to publish: save, then validate"). This replaces the truncated reason in the header.
- **Palette (200px)**, using ds styling:
  - Mono `ADD A STEP` label, then the DS search field.
  - 32px rows: kind glyph from `definition.ts` (◆ agent, ◇ model, ▸ command, ⊙ gate, ↻ until, ≡ for_each) · label 13px. Hover/selected: ink border + `bg-accent-wash`.
  - Groups: `ADD A STEP` and `WRAP STEPS`. Put not-runnable kinds behind a collapsed "n more, not runnable yet" line.
  - Footer tip: "Click to add after the selected step, or drag onto a line."
  - No `rounded-md`, no uppercase 11px tracking-wide headings.
- **Canvas layout**:
  - Always **top-to-bottom**. Drop `chooseCanvasOrientation` / LR for authoring, and set `subgraphRankdir` to the same direction. Handles: target `Position.Top`, source `Position.Bottom`, always.
  - `routeEdge` should prefer vertical segments, so after a step is dragged the edge still leaves the bottom and enters the top.
  - Nodes: 200×52, 6px radius, `border-line`; selected: `border-accent` + `0 0 0 2px accent-ring`. The second line is glyph + kind word + one key fact (`◇ model · qwen3-8-27b`).
- **+ affordances**:
  - The edge "+" is 22px, centered **on** the line at its midpoint. If the edge has a label, put the label beside the line, not on top of the "+". Hover: royal border + ring and a mono label `insert step` to its right.
  - The terminal "+" sits at the end of a short dashed stub below the last node, on the same vertical axis. It's never offset onto the node edge.
- **Delete**:
  - The selected node gets a small menu to its right (ink border, hard shadow): `Duplicate` and `Delete ⌫` (danger tint).
  - The same actions appear on **right-click** (context menu).
  - The inspector header also has `Delete` (danger, compact).
  - Keep the Backspace/Delete keys.
- **Inspector (320px)**:
  - Header: glyph + step id 15/600 + mono `kind · after <prev>` + Delete.
  - Fields in the DS style (mono caps labels). Prompt fields are textareas in the UI font.
  - Advanced fields (retries, timeout, outputs) go behind a disclosure.
  - The assistant box collapses into a footer row "Ask to change this draft… ⌘K" that opens the existing AssistantProposalBox.

## State / data notes
- No new client state beyond: selected thread id (URL), the project tab (route), the expanded inline issue-run row, and the Studio context-menu position.
- Reuse the existing hooks: `useProject`, `useProjectRuns`, `useRepositories`, `usePipelines`, `useWorkspaces`, the cross-project `/api/v1/conversations`, `WorkflowTriggers` data, and the issue-trigger routes.
- Attention and needs-you come from `lib/attention.ts`, as today.

## Design tokens (all already in `ui/src/styles/tokens.css`)
- Paper `#f8f7f3` · surface `#ffffff` · ink `#1e1d1a` · ink-2 `#3a3833` · muted `#6b675e` · faint `#6e6a62`.
- Lines: line-strong `#cfcac0` · line `#e6e2d9` · line-soft `#f0ede6` · fill `#efede7` · fill-edge `#cfc9bd`.
- Accent `#2f4bd6` / edge `#2238a8` / shadow `#1a2d8f` / text `#2a43b8` / tint `#eef0fc` / wash `#f6f7fe` / ring `#dfe4fa`.
- State sets `st-*` (tag, strong, pale). Glyphs: ● ! × ⊘ ↻ ✓ · i.
- Type: Red Hat Text (UI), Red Hat Mono (meta, ids, labels), Kaisei Opti (Mark only). Sizes: 22/28 H1 · 19 · 15 · 13.5 body · 13 · 12.5 rows · mono 10–11.5.
- Radii: 2/3/4 (6 graph nodes, 8 scopes). Shadows: hard offset only, `2px 2px 0`. Menus: `0 8px 24px rgba(30,29,26,.18)`.

## Assets
Icons: the SVG chevron path (`M3 4.5l3 3 3-3`), the kind glyphs from `lib/pipeline/definition.ts`, and Lucide `github` / `clock` / `play` for trigger types (use `lucide-react` in the app).

## Files (in this folder)
- `Workflows Review.dc.html` — Turn 2: Used in (2a), repo triggers (2e), trigger dialog (2c), YAML (2d), not chosen (2b); Turn 1: index (1a–1c), workflow page (1d–1e), Studio (1f–1g)
- `support.js` — runtime needed to open the `.dc.html` files
- `screens.txt` — the visible text of every screen, by badge id (grep for `===== [2e]`)
- `png/<id>.png` — a render of each screen at its design size
- NOTE (orchestrator): sections 1 (project page), 2 beyond the workflows panel, and 3 (threads) are from Projects Review.dc.html and are OUT OF SCOPE for this work; they were trimmed from this copy.
