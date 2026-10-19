# Issue #2 design checkpoint — static mockups

Illustrative static mockups (1440×900, inline SVG + CSS only, tokens copied from
`ui/src/styles/tokens.css`, light theme) for the issue #2 "Delivery approach"
step 1 checkpoint: Studio, active Run Workbench, one-off conversation initiation.
No frameworks, no external assets, no JavaScript.

## What each mockup shows

- **`studio.html`** — Workflow Studio editing the `feature-development` draft v7
  (unsaved, 1 validation finding, Publish disabled with the "validate first" reason).
  Palette with approachable names + mono kind labels and a search box; canvas with
  Plan → Approve plan → `Repeat until` scope box (Implement → Run tests → **Code
  review, NEW, selected**, with the in-box recurrence arrow) → Verdict → the two
  guarded `verified` / `needs attention` routes to Publish evidence. Real
  interaction states: `+` on the Run tests → Code review edge, a drag ghost
  "Insert Coding agent here" over the highlighted Plan → Approve plan edge with a
  split preview, `+` under terminal steps. Right inspector for the new Code review
  agent node (profile + APM package, prompt with `${{ … }}` bindings, session mode,
  timeout/retries, failure route, outputs) and zoom + minimap.
- **`workbench.html`** — Run Workbench for "Split billing by tenant"
  (`feature-development r8` pinned, running): graph-first layout with icon+word
  status overlays (never colour alone), the until scope box showing
  "iteration 2 of 4" with iteration chips, the resizable right dock on the
  running Implement agent node (controller badge "Factory is driving this
  session", Take control / Stop / Open full conversation, streaming transcript
  with a tool call and a permission card, disabled composer with explainer), the
  secondary Graph · Timeline · Execution tree · Diagnostics tabs, and the
  for_each fan-out inset (25 items: 22 ✓ · 2 ⟳ · 1 ✗).
- **`new-conversation.html`** — Billing project overview with "Start run" /
  "New conversation" header actions and the global "New ▾" menu open, the
  New conversation dialog in front (project, agent profile, title, first prompt,
  "no workflow needed" helper), and the Conversations list behind it with
  `Manual` vs `From run · Split billing by tenant · implement` badges and search.

## How this differs from `docs/design/wireframes.md` §3/§6

- The editor is a real three-pane graph workspace (palette | canvas | inspector)
  over a multi-step workflow, not the read-only definition graph plus YAML
  textarea that shipped; the selected agent node gets a full schema-driven
  inspector.
- Graph authoring gestures are shown in state: `+` edge insertion points,
  drag-to-insert preview on an edge, terminal-step insertion — the wireframes
  only sketched the canvas chrome.
- `until`/`for_each` render as bordered scope containers with in-box child
  steps, a UI-only recurrence arrow, and live instance context (iteration
  chips, item counts) — the wireframe showed flat node chains.
- The run page default is the live execution graph with icon+word status
  overlays from the execution journal, not the Definition tab or attempt
  diagnostics table described by the shipped inspector.
- On a selected ACP step, the **conversation itself** (transcript, permission
  cards, controller badge, Take control, disabled composer with explainer) is
  the dock's main content instead of a digest/status table; the factory-owns-
  session state is explicit.
- Loop/fan-out instances are selected through chips and selectors, never drawn
  as extra definition nodes (ADR-0043), which the wireframes did not resolve.
- One-off conversations have first-class entry points (project header, global
  New menu, Conversations tab) with Manual / From-run badges — no synthetic
  one-node pipeline.

## Status

These mockups are **illustrations of the intended interaction states** (per
issue #2 step 1 and `docs/design/studio-workbench.md` §10). The running
application — verified with real data, recorded browser screenshots under
`~/.cache/communication-lab/issue2/`, and the acceptance walkthrough — is the
evidence.
