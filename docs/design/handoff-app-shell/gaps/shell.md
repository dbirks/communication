# Gap analysis — Phase 1: App shell (Sidebar v3), Settings → Layout, routing

Scope: README sections "Shell — Sidebar v3", "Settings → Layout (3g)",
"Interactions & behavior → Routing / Sidebar / Drawers", "State → layoutPrefs".
Artboards 5a (canvas turn 5), 3g (canvas turn 3), plus `docs/design/handoff-app-shell/SidebarV3.dc.html`.
Companion: `docs/design/handoff-app-shell/gaps/` (sibling reports cover other areas).

Handoff copy lives in `docs/design/handoff-app-shell/` (copied verbatim from the product-owner bundle).

## 1. Design asks (this area)

- **Permanent 240px left sidebar replaces the top app bar** (5a, 3g, README "Shell — Sidebar v3"):
  Mark + "Communication"; a `New` + `Ask ⌘K` row; cross-project nav **Home, Inbox (`! 2`), Board (`● 4`), Threads** (counts, always all-projects per 5a note); a divider; **Projects as a tree (default)** — mono `PROJECTS` label, 16px SVG chevron per project, worst-status flag on the right, repos indented 14px each with its own live flag; **switcher mode as a per-user setting** (36px button, dropdown ending in "All projects"); **Library** — Workflows with chevron + count expanding to folders, Steps (9), Agent profiles (5); footer (`margin-top:auto`): initials tile, name, `Settings` link.
- **Settings → Layout (3g)**: radio groups *Projects in the sidebar* (switcher / tree), *Ask button* (top of sidebar / floating bottom-right), *Workflows in the sidebar* (folders / link only); plus Settings → Assistant trust level. ⌘K works from anywhere.
- **Routing (README "Interactions & behavior")**: `/` Home · `/inbox` · `/board` · `/threads`, `/threads/:id` · `/p/:project`, `/p/:project/:repo` · `/workflows`, `/workflows/:id`, `/workflows/:id/drafts/:n` · `/steps`, `/steps/:id` · `/profiles`, `/profiles/:id` · `/runs/:id` (`?step=&iter=&full=1`) · `/ops` · `/settings/:tab`. **Existing routes keep working as redirects.**
- **State**: `layoutPrefs` per user `{ projectsMode, askPlacement, showWorkflowFolders, expanded }` — persisted, sidebar flags **live from the existing event stream, "Don't poll."**
- **Drawers/popovers**: `esc` closes; focus trapped in modals; assistant popover keeps its conversation across page changes (assistant area — noted here only because the Ask *placement* is ours).

## 2. Exists today

**Shell / nav**
- `ui/src/components/Shell.tsx` — the app frame: top `AppBar` (NAV-I), `NAV_ITEMS` = Inbox · Projects · Workflows (→`/library`) · Agents · Operations (`Shell.tsx:14-20`), `NewMenu`, Ask slot = `<CommandPalette>` (`Shell.tsx:44,74`), `user-badge` / `sign-out` testids, `replica-badge` footer. **No sidebar component exists anywhere** (`grep -ril sidebar ui/src` → 0 hits).
- `ui/src/components/ds/AppBar.tsx` — 52px sticky bar: `Mark`, `NavLink` track, `ask` slot, `right` slot, `InitialsBox`. Phone-width wrap behavior documented in-file.
- `ui/src/components/CommandPalette.tsx` — **⌘K is already global**: window `keydown` listener for `metaKey/ctrlKey && key === "k"` (`CommandPalette.tsx:214`); testids `ask-box`, `palette-input`, `palette-ask`. Context chip fed by `sectionOf(pathname)` (`Shell.tsx:26-34`).
- `ui/src/components/ProjectSectionNav.tsx` — the project-scoped rail (Overview · Runs · Conversations · Pipelines · Artifacts · Settings); unaffected by the shell change except it sticks under the (removed) 64px bar (`md:sticky top-[64px]` default, line 40).

**Router — every route registered today** (`ui/src/App.tsx:62-197`):
`/login` · `/` (renders `<Projects/>`, i.e. the projects index) · `/inbox` · `/library` · `/agents` · `/library/:pipelineId` (PipelinePage) · `/library/:pipelineId/drafts/:draftId` (lazy Studio) · `/projects/:projectId` (Overview) · `…/artifacts` · `…/runs` · `…/runs/:runId` (RunWorkbench, fullBleed) · `…/pipelines` · `…/settings` · `/artifacts/:artifactId` · `…/conversations` · `…/conversations/:conversationId` · `/ops` · `*` NotFound. Dev-only `/__m4-preview` renders outside Shell. `workbenchBleed` regexes at `App.tsx:35-38` will need the new prefixes.

**Data for flags / counts**
- Cross-project attention already exists as **polling**: `pages/Inbox.tsx` computes decisions/stalled/running/unread across all projects via `lib/attention.ts` at `INBOX_POLL_MS = 7_500` (`Inbox.tsx:53,57-64`). Sidebar flags can reuse this reduction immediately.
- **Project-scoped SSE** exists: `GET /api/v1/projects/{id}/events` → `useProjectEvents` (`ui/src/api/events.ts:288`); run event types incl. `run.waiting_human`, `run.failed`, `run.started`, `run.completed` (`ui/src/lib/pipeline/runEvents.ts:36-68`). **There is no cross-project / org-level event stream** in `api/openapi.yaml` (streams are only `projects/{id}/events`, line 685, and `conversations/{id}/events`, line 1165).
- Approvals: `GET /api/v1/projects/{projectId}/approvals` (`openapi.yaml:3641`) — **per-project only**; no cross-project approvals list. Runs: `GET /api/v1/projects/{projectId}/runs` (line 3000) and single `GET /api/v1/runs/{runId}` (line 3100, **not project-scoped** — so `/runs/:id` deep links are API-feasible today).

**Settings / preferences**
- **No per-user preference storage exists, client- or server-side.** `GET /api/v1/me` returns identity + org + CSRF token only (`openapi.yaml:350-371`); `grep -rni preference ui/src internal api` finds no settings entity; no `/api/v1/settings*` or `/api/v1/preferences*` route; no `localStorage` prefs in `ui/src` (no `localStorage` hits in `components/`, `api/`). Settings pages today are **project-scoped only** (`ProjectSettings.tsx`, route `…/settings`).

**Names that exist under other labels**: Workflows = `pipelines` (org-global: `GET /api/v1/pipelines`, `openapi.yaml:2167`; `Library.tsx`); "Steps" = *node templates* — spec 03 defines "reusable node templates" (`communication-spec/03-pipeline-engine.md:33`) but **there is no template store or API** (openapi mentions only `unknown_node_template`/`unresolved_node_template` validation codes, lines 6578-6584); Threads = `conversations` (project-scoped); Agent profiles = `agent-profiles` (`openapi.yaml:839`); repo page — **does not exist** (repos are a column of the project Overview, `pages/Project.tsx:222-239`; per-repo status exists at `GET /workspaces/{id}/repos/{repoId}/status`, `openapi.yaml:1893`).

**Design/decision docs**
- `docs/design/sitemap.md` — the M5 route plan (`/` retargeted, `/projects/:projectId/…` tabs, `/ops/workers/:workerId`…) plus an "actually registered today" table (lines 100-114) with testids. The new routing **supersedes parts of it**; it is not Accepted spec (spec 10 line 9: navigation is a "proposal, not visual mandate"; line 79: "the designer owns … navigation choices").
- ADRs: ADR-0043 (run-workbench URL state `?view=…`, §6), ADR-0042 (studio). **No ADR covers the navigation shell** — none of the 45 ADRs in `docs/adr/` mention sidebar/app-bar.

## 3. Gap table

| item | kind | evidence / spec ref | size |
|---|---|---|---|
| Sidebar component (240px, tree, flags, footer) replacing the top bar | UI-only (build from `ds/` primitives) | `Shell.tsx` has `AppBar` only; `SidebarV3.dc.html` is the reference markup | L |
| Drop `AppBar` from the frame; relocate `user-badge`, `sign-out`, `replica-badge`, Ask slot | UI-only | `Shell.tsx:44-92`; `AppBar.tsx` | M |
| Route: `/` = Home briefing | **needs backend** for the real cross-project briefing; interim possible from `lib/attention.ts` | `App.tsx:63` (`/` → `<Projects/>`); no cross-project runs/approvals endpoints (`openapi.yaml` lists only per-project) | M interim / L real |
| Route: `/board` (kanban) | needs backend (cross-project run list) for all-project board; per-project board possible now | `GET /api/v1/projects/{projectId}/runs` `openapi.yaml:3000`; no global run list | M |
| Routes: `/threads`, `/threads/:id` | needs backend — conversations are project-scoped (`openapi.yaml:984`); cross-project thread list is new API | `App.tsx:168-180` | M |
| Routes: `/p/:project`, `/p/:project/:repo` | UI-only redirect for project; **repo page new** (no repo route today; repo status API exists `openapi.yaml:1893`) | `App.tsx:116` | M |
| Routes: `/workflows`, `/workflows/:id`, `/workflows/:id/drafts/:n` | UI-only (redirect/alias of `/library*`; `Library.tsx` already redirects the old `?draft=` form, `sitemap.md:112`) | `App.tsx:76-96` | S |
| Routes: `/steps`, `/steps/:id` | needs backend — no node-template store/API exists (spec 03 `:33` defines the concept; openapi only validation codes `:6578-6584`) | — | L (API) / S (UI shell + empty state) |
| Route: `/profiles`, `/profiles/:id` | UI-only (alias of `/agents`; API `openapi.yaml:839,923` is org-global) | `App.tsx:84-89` | S |
| Route: `/runs/:id` workbench without project prefix | UI-only (`GET /api/v1/runs/{runId}` `openapi.yaml:3100` is unscoped); old URL redirects; query param rename `?view=` (ADR-0043 §6) vs design `?step=&iter=&full=1` needs a mapping + ADR note | `App.tsx:35-38` regexes | M |
| Route: `/ops` | **exists** | `App.tsx:182-188`; `Operations.tsx` | S |
| Route: `/settings/:tab` (user settings) | UI-only shell; persistence needs backend | no user-settings route today | M |
| Per-user `layoutPrefs` + assistant `trustLevel` persistence (table, endpoint, client hook) | **needs backend + needs ADR** (new persisted state + new public API) | no prefs in `openapi.yaml`; `GET /me` is identity-only `:350` | M (backend) |
| Live status flags on sidebar projects/repos (SSE, no polling) | UI on existing API — per-project `useProjectEvents` fan-out; or interim from `lib/attention.ts` reduction | `events.ts:288`; `runEvents.ts:36-68`; no org-level stream | M |
| Ask placement setting (sidebar vs floating bottom-right) | UI-only (⌘K already global, `CommandPalette.tsx:214`) | | S |
| Sidebar expand/collapse persistence (`expanded`) | UI on new prefs API (unit W5); localStorage interim | | S |
| `esc` closes drawers/popovers; focus trap in modals | UI-only (assistant popover is another area's file; verify shared behavior) | | S |
| Workflows-with-folders in sidebar | needs backend — no folder entity in `openapi.yaml` | | M (backend) / S (UI link-only fallback) |

**Full OLD ROUTE → NEW ROUTE table** (all old routes must keep resolving; where an old URL's *content* moves, the row says so):

| old route (today, `App.tsx`) | new route (design) | disposition |
|---|---|---|
| `/` (Projects index) | `/` = Home briefing | **content moves**: Projects index relocates to new route `/projects`; `/` re-lands as the briefing (no redirect possible — same URL) |
| `/inbox` | `/inbox` | unchanged (page rebuild is the Inbox/Board area's) |
| `/library` | `/workflows` | redirect (replace) to `/workflows` |
| `/library/:pipelineId` | `/workflows/:id` | redirect |
| `/library/:pipelineId?draft=<draftId>` (existing in-page redirect, `sitemap.md:112`) | `/workflows/:id?draft=<draftId>` | keep, new prefix |
| `/library/:pipelineId/drafts/:draftId` | `/workflows/:id/drafts/:n` | redirect (Studio mounts on both) |
| `/agents` | `/profiles` | redirect |
| `/agents/<id>` (if any detail link) | `/profiles/:id` | redirect (verify `Agents.tsx` links) |
| `/projects/:projectId` | `/p/:project` | redirect (Overview) |
| `/projects/:projectId` + repo context (none today) | `/p/:project/:repo` | **new**; phase 1 redirects to Overview (open Q4) |
| `/projects/:projectId/runs` | `/p/:project/runs` | redirect (Board covers the cross-project case) |
| `/projects/:projectId/runs/:runId` (+ `?view=…`, ADR-0043 §6) | `/runs/:id` (+ `?step=&iter=&full=1`) | redirect + **query-param mapping** (`view=timeline` → new scheme keeps the Timeline tab; legacy params documented in `lib/routes.ts`) |
| `/projects/:projectId/pipelines` | `/p/:project/pipelines` | redirect (or Board/assignments; keep page) |
| `/projects/:projectId/artifacts` | `/p/:project/artifacts` | redirect |
| `/projects/:projectId/conversations` | `/threads?project=<id>` | redirect **with query** — a true all-project `/threads` needs the cross-project list (backend) |
| `/projects/:projectId/conversations/:conversationId` | `/threads/:id` | redirect (conversation detail API is already unscoped, `openapi.yaml:1070`) |
| `/projects/:projectId/settings` | `/p/:project/settings` | redirect (project settings stay; **user** settings go to `/settings/:tab`) |
| `/artifacts/:artifactId` | unchanged | unchanged (deep link) |
| `/ops` | `/ops` | unchanged (`/ops/workers/:workerId` etc. per `sitemap.md:89-92`) |
| `/login` | `/login` | unchanged |
| `/__m4-preview` (dev-only) | unchanged | unchanged (outside Shell, `App.tsx:44-58`) |
| `*` NotFound | `*` NotFound | unchanged |
| — (new) | `/board` | new (interim: project-scoped runs + attention; backend for all-project) |
| — (new) | `/steps`, `/steps/:id` | new shell; data needs template-store backend (empty state until then) |
| — (new) | `/settings/:tab` (`layout`, `assistant`, …) | new |

## 4. Spec / design conflicts

1. **3g artboard vs settled decision — default sidebar mode.** `shots/3g.txt`: "The project switcher is the default." README decision table (settled, product owner): "**Tree is the default**… A project switcher is an optional per-user setting." **Resolution: follow the README** (newer; 3g is turn 3, README decisions postdate it). Note: if the artboard is meant as the *screenshot* of a settings screen, the "default" radio is mislabeled — confirm in open question 1.
2. **`/runs/:id` query params vs ADR-0043 §6.** Design: `?step=&iter=&full=1`. ADR-0043 §6 (per `sitemap.md:113`) fixes the workbench URL state as `?view=graph|timeline|tree|diagnostics · node=… · instance=… · attempt=… · scopes=…`. These are different schemes for the same screen. Not an *Accepted spec* conflict (ADR-0043 is a UI contract), but the rename needs an ADR amendment/decision and a legacy-param mapping table so permalinks keep working.
3. **No top app bar.** Spec 10 (`communication-spec/10-ui-design-handoff.md:9`) presents navigation as "proposal, not visual mandate" and `:79` cedes navigation choices to the designer — so replacing the bar is **permitted, not a conflict**; `sitemap.md:8-18` (our own doc) will need its route table superseded. Recommend a short ADR recording the shell swap + route redirects (public behavior change).
4. **"Threads cover all projects" (5a) vs project-scoped conversations.** Design: "Home, Inbox, Board and Threads always cover all projects." API reality: conversations are created and listed per project (`POST /projects/{id}/conversations`, `openapi.yaml:984`); the conversation *detail* is unscoped (`/conversations/{id}`). A global thread list is a real backend change — cannot be faked by a redirect. (Vocabulary rename itself is settled: UI "Threads", API `conversations` unchanged.)
5. **Steps count in sidebar ("Steps (9)")** has no data source: no template store exists (see gap table). Until the API lands the number is fake — see empty states.
6. **No security-boundary conflicts in this area.** The token-in-sandbox decision (PO, needs an ADR amending spec 05) lands in the profiles/agent area, not the shell; the only shell touchpoint is the `Ask` popover, which by design "never reads secret values" — consistent with the read-only assistant broker (ADR-0034).

## 5. Honest empty states

- **Sidebar flags when nothing is pending**: the lab typically has 0 approvals and few runs. Show the flag slot as muted `·`/no glyph rather than `! 0` (design says status is never color-only and counts are real). Derive from the same source Inbox uses so a number is never shown that Inbox disagrees with.
- **Home briefing (interim)**: the real cross-project briefing (needs-you / running-now / recent-threads with links) has no single API today. Interim: reuse `lib/attention.ts` (the Inbox reduction) and label the panel data honestly ("across N projects"). When data is absent: one sentence + primary action ("Start a run"), per README "Empty states".
- **Board columns**: with few lab runs, 3–4 columns will be empty. One-line empty copy per column + the `Start run` action; never prefill with made-up cards.
- **Library counts**: `Steps (9)` and the folders `Delivery 2 / Maintenance 2 / Drafts 1` are **design fiction** — no template store, no folder entity. Sidebar must render `Steps (0)` and the flat workflow link (link-only mode) until the backend lands; the Workflows page shows "No saved steps yet" + a pointer to the Studio's "Also save as a reusable step".
- **Repo flags**: per-repo live status has no event type today (M3 has workspace events, `events.ts:70-85`, but not per-repo run state) — repo flags can only mirror the project's worst flag until the backend adds repo-scoped runs/status, in which case show the project flag on the repo rows or nothing at all.

## 6. Proposed work units

One worker each, ≤60 min. **Serialize chain: W1 → W2 → W6** (all touch `Shell.tsx`/`App.tsx`). W3–W5 are parallel to the chain; W4 depends on W5 for final form (ship W4 with a client-side store that W5 upgrades in place).

1. **W1 — route layer & redirects** (S, ~30 min). Owns: `ui/src/App.tsx`, small new `ui/src/lib/routes.ts`. New routes as aliases/redirects to existing components (`/workflows*` → library routes, `/profiles` → agents, `/p/:id` → project routes, `/board`, `/threads` stubs, `/settings/:tab` stub); move `<Projects/>` from `/` to `/projects`; update `workbenchBleed` regexes; `/runs/:runId` alias with query mapping (`view`↔`step/iter/full` table documented in-file). Redirects must be `replace` navigations (pattern in `Library.tsx`).
2. **W2 — the sidebar shell** (L, ~55 min). Owns: new `ui/src/components/Sidebar.tsx` (+ `SidebarFlags.tsx`), `ui/src/components/Shell.tsx`, `ui/src/components/ds/AppBar.tsx` (or its removal), `ui/src/pages/Settings.tsx` + `pages/settings/` stubs. Builds from `SidebarV3.dc.html` markup + `ds/` primitives and `tokens.css`; moves `user-badge`/`sign-out`/`replica-badge` testids; `ask` prop slots; keeps `RouteErrorBoundary`/`fullBleed` semantics; sticky offset fix for `ProjectSectionNav` (`top-[64px]` → new barless value).
3. **W3 — live flags hook** (M, ~45 min). Owns: `ui/src/lib/sidebarFlags.ts` + tests. Consumes `useProjectEvents` per visible project (with a connection cap) **and** falls back to the `lib/attention.ts` reduction; pure function `worstFlag(attention)` mapping to `! n` / `× n` / `● n` / muted. No polling introduced; document the SSE fan-out tradeoff for >5 projects.
4. **W4 — Settings → Layout page + prefs store** (M, ~45 min). Owns: `ui/src/pages/Settings.tsx`, `pages/settings/{Layout,Assistant}.tsx`, `ui/src/lib/prefs.ts` (hook `useLayoutPrefs()` returning `{ projectsMode, askPlacement, showWorkflowFolders, expanded }`, backed by `localStorage` for now, with an adapter seam for the W5 API). Three radio groups exactly as 3g; trust-level group reads/writes the same store key the assistant area will use.
5. **W5 — backend: per-user preferences + ADR** (M, ~50 min). Owns: `docs/adr/ADR-0045-user-preferences.md`, `internal/api/` handler, `internal/domain` (or storage layer per existing pattern), migration, `api/openapi.yaml` (`GET/PATCH /api/v1/me/preferences` — one endpoint, no new route family), tests. Stores `layout_prefs jsonb` + `assistant jsonb` per user; values are client-side display prefs only — ADR must state they authorize nothing (per README: trust level "doesn't need its own server-side enforcement").
6. **W6 — Ask placement** (S, ~25 min). Owns: `Shell.tsx` (ask slot), `CommandPalette.tsx` (popover anchor prop; the `⌘K` listener already lives on `window` so it survives moving out of `AppBar`). Floating mode: fixed bottom-right container above the content; sidebar mode: the `Ask ⌘K` button in the New/Ask row. Reads `askPlacement` from W4's store.

Parallelizable: {W3, W4, W5} run concurrently with each other and with W1; W2 must follow W1 (same files); W6 must follow W2+W4.

## 7. Acceptance checks (browser, real lab)

1. At `/`: `data-testid="sidebar"` present; `header` with `aria-label="Primary"` (the old bar's nav, `AppBar.tsx`) **absent**; nav items `sidebar-link-home|inbox|board|threads` all present; active row = `aria-current=page` with blueprint-grid background (computed `background-image` non-none).
2. **Redirect audit** (open each in a fresh tab, assert final URL + 200 + key testid): `/library` → `/workflows` (`library` page testids) · `/library/<pid>/drafts/<did>` → `/workflows/<pid>/drafts/<did>` (`studio-header`) · `/agents` → `/profiles` · `/projects/<p>` → `/p/<p>` (overview) · `/projects/<p>/runs/<r>` → `/runs/<r>` (`run-tab-*` visible and `?view=timeline` still selects the Timeline tab — ADR-0043 permalink regression) · `/` → briefing H1, **and** `/projects` → the old projects index.
3. **Flag correctness**: with the lab fixture, `Inbox` shows `! N`; the sidebar Inbox badge equals the same N, and per-project `!`/`×` counts equal `GET /api/v1/projects/{id}/approvals` pending counts (assert against the API response, not the screenshot). Total sidebar badges = sum of project flags.
4. **Live, no poll**: start a run that reaches a gate; the affected project's flag changes to `! 1` within one SSE frame (<5 s) with **zero** `GET /api/v1/projects` requests in the network log for that window.
5. **Prefs round-trip**: at `/settings/layout` set *Ask button* → floating; the `Ask ⌘K` sidebar button disappears and a fixed bottom-right `data-testid="ask-float"` appears; hard-reload — setting persists. Set *Projects* → switcher: tree collapses to the 36px switcher button + its repos only. `expanded` state of the tree survives reload.
6. **⌘K**: on each of `/`, `/inbox`, `/board`, `/p/<p>`, `/runs/<r>` press ⌘K → `palette-input` focused; `esc` closes; context chip text changes to the page's section (`sectionOf`).
7. **Mobile floor**: at 390px the sidebar is reachable (collapse to an icon rail or drawer) with no horizontal scroll of the document (`document.scrollWidth === innerWidth`).

## 8. Open questions for the product owner

1. **Default sidebar mode**: 3g says *switcher* default; the settled README table says *tree* default. **Recommend: tree** (README wins); fix the 3g artboard's default radio.
2. **What replaces the app bar on fullBleed pages?** Workbench/Studio already own their 52px headers (ADR-0042/0043). **Recommend:** drop the bar everywhere, fullBleed pages keep only their own header — no double header.
3. **Where does the `replica:` footer go?** It currently sits under the content (`Shell.tsx` footer). **Recommend:** into the sidebar footer line (it is the last honest ops signal the shell carries), or drop it to `/ops` only.
4. **`/p/:project/:repo` now or later?** No repo page exists; repo status APIs do (`openapi.yaml:1893`). **Recommend: later** — phase 1 redirects `/p/<p>/<repo>` to the project Overview; a dedicated repo page (status, workspaces, issues) is its own unit.
5. **Phase-1 Home data source?** **Recommend:** interim briefing from `lib/attention.ts` (per-project reads, same numbers as Inbox, no new backend); the cross-project runs/approvals endpoints come with the Board/Inbox backend unit, not the shell.
