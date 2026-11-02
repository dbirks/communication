# e2e/emulator — the "play the user" loop

The product must be proven by a scripted loop that plays a real user in a
real browser against a freshly built lab, screen by screen, until **two
consecutive passes come back clean**. This directory is the harness;
journeys are added as screens land.

## What a pass does

1. `setup.spec.ts` (setup project) signs the lab's identities in through
   the mock IdP once and saves the browser storage states
   (`admin.json`, `alice.json`) into the pass output directory.
2. The journeys (`journeys.spec.ts`) play the screens against the lab
   (`http://localhost:18091` — `localhost`, not `127.0.0.1`: the session
   cookie is set for `localhost`). Every screen goes through
   `emu.screen(badge, name)`, which captures the page at **1280×900 and
   390×844** and records it against the design render
   `docs/design/handoff-workflows/png/<badge>.png` (Projects Review
   badges come under `docs/design/handoff-projects/png/`; the
   Repo/Chat/Nav handoff's renders live under
   `docs/design/handoff-repo-chat-nav/png/` and REUSE the old badge
   numbers for different screens, so its badges are namespaced `rcn-`:
   badge `rcn-3a` is that directory's `3a.png`. The per-directory prefix
   map is `env.ts` `EMU_DESIGN_DIRS`; render files are never renamed.) Each capture
   goes from the **top**: `emu.screen` calls `scrollToTopForCapture` (the
   shared helper in `tests/helpers.ts`) first, because a `fullPage` shot is
   stitched from the page's scroll position and a journey that auto-scrolled a
   clicked row otherwise paints the sticky phone band across the MIDDLE of the
   390 render. Nothing is scrolled back afterwards.
3. The `emu` fixture (fixtures.ts) records, per page:
   - `pageerror` events and `console.error` messages (URL + text);
   - every `/api/` response with status ≥ 400 (method, path, status) and
     every `requestfailed` — **except** ones a journey declared expected
     via `emu.expectFailure(/regex/, status)` (e.g. a deliberate 409/422
     shown inline);
   - a **sideways scroll** at either viewport — `document.documentElement.scrollWidth <= innerWidth`
     is asserted, but a violation is *recorded* (the screenshot still
     proves the screen), not thrown;
   - **overlapping content** at either viewport — leaf text and controls whose
     boxes paint over one another (`reflow.ts` `findOverlaps`), recorded as
     `kind: overlap`;
   - the screen's **design landmarks** at either width — the headings, tabs,
     buttons, sections and fields its design render draws (`design.ts`),
     structure only and never data, recorded as `kind: design`;
   - **no made-up data** at either width — none of the design mocks'
     invented sample values (people, repo/project/workflow names, issue
     titles and numbers, run ids, amounts) may appear in the page's visible
     text (`mockdata.ts`), recorded as `kind: made-up-data`;
   - a failing journey's own error, as `kind: assertion` — a journey that
     hits a missing design element is a real defect, recorded, and the
     journey FAILS with a clear message. Journeys are written against the
     design, never around the old UI.
4. At each test's end, one JSON object per screen and per defect is
   **appended** to `out/<passId>/results.json` (append-safe JSON lines).
   Defects carry `{kind, journey, screen, viewport, detail, fingerprint,
   screenshot}`; the fingerprint is a stable hash of kind + journey +
   screen + normalised detail (uuids and numbers stripped), so the same
   defect files one issue across passes.
5. `report.mjs` renders `out/<passId>/index.html` — defects on top, then the
   per-screen results table (a column per width plus the **design** column),
   then
   one row per screen with the app screenshot beside its design render
   (both at 50%) — and prints `PASS <id>: <n> screens, <m> defects`
   (exit 0 when clean, 1 otherwise).
6. `file-issues.mjs` files each not-yet-filed fingerprint as a GitHub
   issue in `dbirks/communication` (label `emulator`, body carries
   journey, screen, viewport, detail, `fingerprint: <fp>` and the
   screenshot path; open AND closed issues are searched). It never puts
   cookies, tokens or env values in an issue.

## Run one pass

```bash
docker compose -p communication-m4 -f compose.yml up -d --build   # or the orchestrator's reset
EMU_PASS_ID=pass-1-$(date +%s) \
  pnpm --dir e2e exec playwright test -c emulator/playwright.config.ts
node e2e/emulator/report.mjs e2e/emulator/out/pass-1-<ts>
node e2e/emulator/file-issues.mjs --dry-run e2e/emulator/out/pass-1-<ts>   # prints instead of filing
node e2e/emulator/file-issues.mjs e2e/emulator/out/pass-1-<ts>            # files the issues
```

`EMU_PASS_ID` defaults to `emu-p<runner-pid>` (stable across the suite's
worker processes); `EMU_BASE_URL` defaults to `http://localhost:18091`.

## Run the loop

```bash
LAB_RESET_CMD='docker compose -p communication-m4 -f compose.yml up -d --build && ...' \
  e2e/emulator/loop.sh [--max-passes 6] [--no-reset]
```

Each pass rebuilds the lab (`$LAB_RESET_CMD`, required unless
`--no-reset` — the orchestrator sets it), runs the suite, renders the
report and files new issues (skip filing with `EMU_DRY_RUN=1`). The loop
prints one summary line per pass and exits 0 after **two consecutive
clean passes**, or 1 after `--max-passes` (default 6) without that.

## out/ layout

```
e2e/emulator/out/<passId>/
  admin.json            signed-in browser state (admin)
  alice.json            signed-in browser state (alice)
  results.json          one JSON line per screen and per defect
  <badge>-<name>-1280.png   desktop capture
  <badge>-<name>-390.png    phone capture
  index.html            the report (report.mjs)
  report.log, file-issues.log   loop outputs
```

## Defect rules

- A defect is anything the fixture records: `pageerror`, `console`,
  `api`, `sidescroll`, `assertion`, `reflow`, `clip`, `target`, `overlap`,
  `design`, `made-up-data`. A pass is clean when results.json holds zero defect lines.
- Deliberate failures a journey exercises inline are *declared*:
  `emu.expectFailure(/\/api\/v1\/pipelines$/, 409)`. Anything undeclared
  with status ≥ 400 is a defect.
- Filing is fingerprint-deduplicated across open and closed issues; a
  fixed-then-returned defect files a new issue, a recurring one does not.
- Do not run the loop yourself and do not skip/modify journeys to make a
  pass clean — a red journey is the signal.

## The 390 definition (no phone designs exist)

Per the product owner there are **no 390px design renders** — Workflows
Review and Projects Review are 1280 boards only. A screen's 390 match is
its **1280 content and hierarchy, reflowed into one column**, checked by
`emu.screen()` (page-side collectors in `reflow.ts`) at each capture:

- **(a) no sideways scroll** at either width — as before;
- **(b) content parity** — the 1280 inventory (visible headings h1–h3 /
  `[role=heading]`, `[role=tab]` names, visible `data-testid` elements,
  MAIN content only — the app shell's sidebar/phone strip is excluded) must
  all be rendered at 390 too, or sit behind an explicit, per-testid
  `REFLOW_ALLOWLIST` entry with a one-line reason (must stay empty unless a
  real phone-only collapse forces one — every entry gets reported). A key (or
  reach) ending in `*` is a prefix pattern for dynamic testids: it covers
  items whose own testid matches the stem, and the reach resolves per item —
  `edge-add-label-survey-plan` is excused only while *its own*
  `edge-add-survey-plan` renders at 390. A tab's
  identity name ignores a live count badge inside it (a run can add
  `Artifacts 1` between the two captures — see dbirks/communication#22).
  Missing items are recorded as `kind: reflow`;
- **(c) no clipped text** — main content overflowing an
  `overflow-x: hidden|clip` box without `text-overflow: ellipsis` (an
  ellipsis is the design's intended truncation) is recorded as `kind: clip`;
  visually-hidden (`.sr-only`) copy is skipped — it renders no visible text
- **(d) touch targets ≥ 44px** — rendered, enabled buttons / `[role=button]`
  / `[role=tab]` / selects / inputs (hidden/checkbox/radio measured via
  their label box) / textareas whose **hit area** is under 44px tall, per the
  app-shell handoff ("Heights 26 / 30 / 36; mobile 44–48"), are recorded as
  `kind: target`. Bare `<a>` links are inline text, not targets. The hit area is
  the box ∪ the element's own `position:absolute` `::before`/`::after` (the
  phone rows draw a 26px button and extend its tap area with an invisible
  pseudo — `PHONE_HIT`), but only when the element hosts the pseudo (not
  `position:static`) and `document.elementFromPoint` at the extension's top and
  bottom still resolves to the element or a descendant of it; a neighbour
  parked over the band takes the extension away. The reported height is the
  measured hit area, so a `42px` line means 42 real pixels, not a short box.
- **(e) no overlapping content** — NOT 390-only: `findOverlaps` runs on every
  screen at **1280 and 390** and is recorded as `kind: overlap`. Within MAIN
  (shell excluded) the candidates are the things a person reads or presses:
  a **leaf text-bearing element** (it carries its own text and has no element
  children — a wrapper's box legitimately spills around the label inside it)
  and a **control** (button / `[role=button]` / `[role=tab]` / link / input /
  select / textarea / summary / slider / contenteditable — wrapper or not).
  A pair is a defect when **some fragment of one and some fragment of the other
  intersect by more than 4px on BOTH axes** and **neither candidate contains the
  other** (±1px slack: a label inside its field, a heading inside its card, a
  badge inside its tile are the design). A box is the box that gets PAINTED:
  for an element with one box, its own `getBoundingClientRect` unioned with the
  Range rects of its direct text (a `whitespace-nowrap` line paints past its
  layout box — that is exactly how the caption ran under the zoom group at 1280
  while its box stopped short of it); for a **`display: inline` run, its
  `getClientRects()` line fragments** plus those Range rects, compared
  fragment-by-fragment. The distinction is what acceptance 32 was missing: the
  markdown reader renders a plan as adjacent inline `<span>`/`<code>` runs, and
  collapsing a run that wraps across two lines into the UNION of its fragments
  covers both lines, so two neighbouring wrapped runs of one paragraph
  "intersected" (the `span × span` / `code × span` hits on `run-gate waiting`,
  `run-gate completed` and `2e schedule-run-approved`, 351×17px) on screenshots
  that show them neatly stacked. `inline-block`/`inline-flex` are atomic — one
  box, so they keep the union rule. Every box and every fragment is then cropped
  by its own and every ancestor's `overflow: hidden|clip|auto|scroll`, because a
  collision the browser clips away is not visible (this is also what stops a
  React Flow node parked off-pane pairing with another one).
  Filters beyond that, each because the alternative is a false positive:
  `aria-hidden` and `.sr-only` / `clip-path` copy (it renders no visible
  text); `opacity: 0` and zero-box elements; **SVG** (React Flow's edges and
  edge labels are SVG and legitimately cross node cards, as does every
  decorative glyph); and elements **inside the same control** (the `fit` text
  inside its button is not a second element colliding with that button).
  While a modal dialog is open only the dialog's own subtree is measured —
  the page behind it is inert background and the backdrop legitimately covers
  it. There is **no allowlist**: a reported pair is a real overlap and gets
  fixed. The first things it caught (2026-10-27) were the canvas caption
  printing over the last step card and under the − + fit group at 390, the
  floating fit group sitting on the step cards, and the Studio inspector's
  model-prompt textarea bleeding over the pinned `Ask to change this
  draft…` row at 1280.
  The checker is itself tested, with no lab and no app: `reflow-overlap.spec.ts`
  hands it `page.setContent` fixtures (adjacent inline runs that wrap → no hit;
  an absolutely positioned span printed over a line → hit) and
  `reflow-target.spec.ts` hands `findSmallTargets` hit-area fixtures (a 26px box
  with a ±9px absolute `::after` → passes; the same box with a 1px border → 42px,
  reported; a plain 26px box, a covered extension, a `static` host → reported)
  and `reflow-capture.spec.ts` hands the capture rule the same treatment (a
  sticky band, a scrolled window and a scrolled `main`: after
  `scrollToTopForCapture` the full-page shot's first ink is the band and its
  bottom border is row 43; captured while scrolled, the same shot starts 248px
  down and borders at 443 — the stitched band over the content) in
  its own `reflow` Playwright project, which has no `setup` dependency:

  ```bash
  pnpm --dir e2e exec playwright test -c emulator/playwright.config.ts \
    --project=reflow
  ```

Like sidescroll today, every violation is a RECORDED defect (one aggregated
defect per kind per screen, so fingerprints stay stable) — never a throw —
so the screenshot still lands and the loop files it. Each screen record in
`results.json` carries `checks: {sidescroll, parity, clip, target, overlap, design, data}`
per width (true = pass; the 390-only checks trivially pass on the 1280 record,
while `overlap`, `design` and `data` are evaluated at both), and `report.mjs` renders
them as the **Per-screen results** table on top of the report.

## Design landmarks (is this the screen its render drew?)

Reflow proves a screen survives 390px; it proves nothing about whether the
screen is the one the design drew. `e2e/emulator/design.ts` therefore holds
`DESIGN_LANDMARKS`: one entry per captured screen, keyed `"<badge> <screen
name>"` — the same words `emu.screen(badge, name)` records (`2a use-dialog`,
`1g studio`, …). `emu.screen()` evaluates the screen's landmarks **at both
widths**; a miss records `kind: design` with
`design landmark missing: <desc>` (one defect per missing landmark per screen,
fingerprinted exactly like the other kinds, so it files one issue across
passes), and the screen record's `checks.design` goes false. `report.mjs`
shows it as the table's **design** column.

**Structure, never data.** The lab's data is real and the mock's is invented,
so a landmark may only ask for the parts the design owns: a heading, a tab, a
button, a section, a field. Specs address elements by

- `testid` (optionally `current: true`, which additionally requires
  `aria-current="page"` — how this app marks the tab you are standing on),
- `{ role, name?, level? }` — an accessible role with a name **regex**
  (`{ role: "heading", name: /^RUNNING NOW/i }` catches the panel whatever
  its count reads), or
- `{ text }` — a copy regex over words the *design* wrote (`/^pinned r/i`,
  `/not used in any repo yet/i`), never a repo name, a count or a run id.

A landmark is satisfied when **ANY** of its specs matches an element that
renders — a non-zero box, not `display:none`/`visibility:hidden` — inside
`<main>` or an open dialog; being scrolled out of view is fine, since the
screen's own full-page screenshot shows it. A landmark may opt into
`host: "page"` to search the WHOLE document instead — only the app-shell
screens use it (`rcn-3c`: the sidebar column and the assistant popover live
outside `<main>`), so every per-page list keeps the strict main+dialog
reading. `only?: 1280|390` narrows a
landmark to one width, but the phone swap is better expressed as ONE landmark
whose `any` carries both forms, which is the 390 rule read as a landmark: the
content is there, or the one tap that reaches it is (`threads-1g`'s list
landmark accepts the 1280 list pane or the 390 `← Threads` back link).

Coverage cannot lapse: a badge that HAS a design render
(`docs/design/handoff-workflows/png/<badge>.png`,
`docs/design/handoff-projects/png/<badge>.png`, or — under the `rcn-`
namespace, env.ts `EMU_DESIGN_DIRS` —
`docs/design/handoff-repo-chat-nav/png/<badge-minus-prefix>.png`) and no
entry is itself a
`design` defect (`no landmarks defined`), so adding a screen forces a landmark
list. Screens with no design render at all — `run-gate`, `artifact` — are
exempt and their `checks.design` trivially passes. A screen name whose tail is
a per-pass id (`2e schedule-run-9c1e04f2`) finds its entry by shape: a run of
6+ hex characters collapses to `*`, so it lives under `2e schedule-run-*`.

What each list asserts is read off the renders themselves (and the app's real
testids, never a guess): the 1b index's heading, both authoring verbs, the
START BLANK + template starter cards, the search field, the `all` /
`has open draft` chips and a row's `Edit` + `⋯`; the 1c dialog's NAME field,
`id:` line with `change`, START FROM (Blank among them), FOLDER select and
both footer verbs; the 1e breadcrumb, title, revision chip, four tabs,
`Use in a repo…`, the read-only graph and the USED IN / INPUTS / LAST RUNS
rail; the 1g header (draft chip, Canvas|YAML, undo, redo, Validate, Save,
Publish), the ADD A STEP palette with its search and the Agent / Model /
Command / Approval rows, WRAP STEPS with Repeat until and For each, the
canvas, the inspector (plus the selected step's card, `kind · after` line,
prompt field and advanced disclosure on the inspector-edit beat), the
`Ask to change this draft…` row and the status bar; the 2a panel, its empty
line or its rows' pinned revision and `Open ›` with the footnote; the 2c
dialog's START IT WHEN segments, its arm's fields, THE RUN GETS and both
verbs — and, for the saved arms, the STARTS WHEN row with its switch and
`Edit` on the repo page (2e.png puts `Edit` on the TRIGGER rows under
STARTS WHEN, never on a workflow row — whose verbs are `+ Add trigger` and
`Run`); the 2d tab with its revision select, Copy, download
and line-numbered text; the 2e/repo-1e page verbs, WORKFLOWS ON THIS REPO
(repo-chain-r4: the bar briefly read REPO WORKFLOWS so its count would not
ellipsise away at 390 — the design's own words fit the one-line bar after all)
with its library link, the row verbs, the STARTS WHEN box, and (Projects
Review) OPEN ISSUES, WORK IN THIS REPO and RECENT RUNS; the project overview's
title, two verbs, six tabs and RUNNING NOW / RECENT THREADS / REPOSITORIES /
WORKFLOWS panels; and threads-1g's heading, New thread, search, chips, thread
title, control badge, transcript and composer with Send. Server-error variants
keep the page heading and the error panel; `NEEDS YOUR DECISION`, the
`used in <project>` chip, the header's `Edit workflow` verb and the thread
`Stop` control are deliberately **not** landmarks — they appear only on a state
or a permission the pass does not control (`Stop` needs a live turn, `Edit
workflow` the library role, the chip a project of the viewer's that pins the
workflow), so asserting them would prove who signed in rather than what the
screen draws. Where an error state genuinely has no heading — the Studio whose
draft read failed, the repository page whose repository list failed — the
landmark STAYS in the list and the screen reports the miss: a failed read is not
an excuse to lose the page.

## No made-up data (does the app show the mock's sample data?)

**"No made-up data" means every person, project, repository, workflow, issue,
run, id or amount on a screen is data the lab actually served — never a value
copied out of the design mocks**, whose READMEs say outright that "All data is
made up. Never fake data the API doesn't serve." `e2e/emulator/mockdata.ts`
estates that rule as `MOCK_DATA`: a curated list (extracted statically from
the two `.dc.html` review boards, their `screens.txt` dumps and
`Sidebar.dc.html` — read, never executed) of the mocks' DATA values, each
with the file and context it came from, deliberately excluding UI chrome
(labels, verbs, empty-state copy the app reuses) and anything that is really
lab or product content (the seeded repos `app`/`tally`, the shipped
plan-with-approval / security-review / issue-to-pr templates and their
descriptions, prompts and artifact names, the real profile names "Claude
Code"/"Codex", live step ids). Two checks prove it: at capture time,
`emu.screen()` runs `checks.data` **at both widths** — if any MOCK_DATA
string appears in `document.body.innerText` (case-sensitive, whole-word), the
screen records a `kind: made-up-data` defect naming the string and its mock
source, and the report's **data** column fails; and without any browser,
`node e2e/emulator/mockdata-scan.mjs` greps the same list through `ui/src`
(test files, `test/` trees and doc comments excluded), so a value hardcoded
into the source — even one that never reaches visible text, like a
`placeholder=` — fails the scan with its `file:line`. A hit on either check
is never answered by dropping the string from `MOCK_DATA`; the fix is for the
UI to show what the API serves, or an honest empty state.

## Current journeys

- `workflows-index` (admin, `journeys.spec.ts`): `/workflows` → 1b; New
  workflow dialog → 1c; create from the "Plan with approval" template
  ("Emu plan <passId>") → Studio → 1g.
- `thread` (alice — the seeded M4 lab gives the org admin no project
  membership, and a thread starts in a project workspace; `journeys.spec.ts`):
  `/threads` → New thread → send one message → threads-1g.
- `workflow-lifecycle` (admin authors, alice uses): create "Emu lc <passId>"
  from the template → Studio (1g): edit the plan step's prompt in the
  inspector, Save, Validate, Publish → workflow page (1e) → YAML tab (2d,
  block style: no inline `{ … }` maps) → Used in tab (2a, honest empty
  state) → `Use in a repo…` → the repo lists under Used in.
- `repo-triggers` (alice): pin "Emu sched <passId>" to M4 Exit / app → repo
  page (2e) → `+ Add trigger` (2c): the OPEN dialog is recorded as the 2c
  screen itself — `2c-dialog-schedule` (cron + goal filled) and
  `2c-dialog-issue` (labeled, label `emu-<passId>` chip filled, recorded on
  the GitHub-remote repo's page) — then each arm is saved and its saved-state
  row shot follows; a schedule trigger on `* * * * *` (the server ticks every
  30 s — `defaultScheduleTick`, ADR-0032) → wait ≤ 4 min for the
  schedule-fired run and open it → pause the schedule trigger so later
  passes stay quiet.
- `run-gate-artifacts` (alice): start the pass's pinned plan-with-approval
  run from the repo row's `Run` → wait ≤ 10 min for `waiting_human` (the
  model legs are real) → approve the gate in the run view (`?node=` selects
  the approve node; the ApprovalCard offers Approve to a maintainer) → wait
  ≤ 10 min for `completed` → open plan.md and prove the artifact renders.
- `thread-control` (alice): start "Emu ctrl <passId>" → Return control (the
  composer locks for the non-controller) → Take control (composer enabled
  again), screens both sides of the handoff.
- `empty-and-error`: 1b no-match search and 2e's "uses no workflow yet" +
  `+ use a library workflow` CTA (alice creates a pass-stamped empty project
  + repo over the API first — project-wide pins cover every repo of a
  project, ADR-0060); 1e not-found for a random UUID (the 404 is declared
  via `emu.expectFailure`).
- `server-error` (`server-error.spec.ts`): every reviewed screen's SERVER-
  ERROR state — 1b, 1c, 1e, 1g, 2a, 2c, 2d, 2e, project-1b, repo-1e,
  threads-1g. `page.route` answers the one GET the page cannot render
  without (the reads listed in the file header) with `500` +
  `application/problem+json` ("Internal Server Error: emulated failure");
  the failure is declared via `emu.expectFailure(re, 500)` and each screen
  must show its honest error state (a ProblemBanner/alert quoting the
  problem, a Retry where the design offers one — never a blank page, a
  stuck spinner or invented rows; the empty-state line must not stand in
  for a failed read). The 1g/2a/2c/2d legs stand on one pass-stamped
  scratch workflow (`Emu srvfail <passId>`, created + published over the
  API by admin; alice pins it to M4 Exit / app for 2c) — left behind like
  every other pass-stamped scratch, with no triggers and no runs.
- `projects` (alice — every screen here is project-scoped and the org admin
  holds no project membership; `projects.spec.ts`): the Projects Review
  badges, paired with `docs/design/handoff-projects/png/<badge>.png`.
  **project-1b** — the overview of the seeded M4 Exit project, its Runs /
  Threads / Workflows tabs each opening their own route, a pass-stamped
  project with no runs and no workflows (the empty state), and a random-UUID
  `/p/<uuid>` (the not-found; its single 404 is declared the way
  empty-error.spec.ts declares 1e's, `$`-anchored so a fan-out 404 still
  counts). **repo-1e** — M4 Exit's `app` repository: workflows on this repo,
  the honest "Issue triggers need a GitHub repository" line (the lab's remote
  is `file://`, so that line IS the expected state), work in this repo and
  recent runs; then `/p/<id>/no-such-repo`, which needs no declaration — the
  repository list answers 200 and the absence is the client's own read.
  **threads-1g** — `/threads` with nothing selected (the existing thread
  journeys keep the open-thread screens).
- `repo-chat-nav` (`repo-chat-nav.spec.ts`) — the Repo/Chat/Nav handoff's
  final picks, under the `rcn-` badge namespace (its renders reuse the old
  numbers: badge `rcn-2e` is `handoff-repo-chat-nav/png/2e.png`). Admin
  publishes `Emu rcn <pass>` (the plan-with-approval template plus the
  ADR-0066 annotations: `goal` as long text, a branch-typed `revision` on a
  default — the fields the 1k form builds); alice then stands a
  pass-stamped project with TWO repos — `web` on the lab's `file://`
  fixture remote and `server` on a REAL tiny public remote
  (`octocat/Hello-World`; the worker mirrors every repo of a chat's
  project before a turn, so an unreachable remote would fail the turn's
  workspace prep outright) — pins the
  workflow, arms a labeled issue trigger on `server` (the server REFUSES
  one on `web`: `not_a_github_repository`, and that refusal is exactly the
  List view's asserted OPEN ISSUES state) and seeds one repo-bound chat
  (ADR-0067). Seeds resolve-or-create by their pass-stamped slug/name/label:
  Playwright restarts the worker after a serial-group failure, and a fresh
  process must reuse the dead one's rows, never 409 on them. The journeys:
  **rcn-3c** — the one sidebar expanded, the ⋯ project menu, the collapse to
  the rail, a tile's hover flyout, and the rail surviving a reload (then
  re-expanded, because the preference lives on alice's account across
  passes); **rcn-3a** — the feed's empty line, then the page with the chat
  row, the WORKFLOWS row's trigger/result/Run, the honest
  `Issue hand-offs need a GitHub repository`, the All/Runs/Chats/Mine chips,
  typing + Start landing in the new thread, and the runs-read 500 shown as
  its ProblemBanner with a Retry; **rcn-3b** — List→Lanes, the four lanes
  with the empty issues lane (no fake cards to drag on a `file://` repo),
  the choice persisting per repo on reload, back to List; **rcn-2e +
  rcn-1h** — control returned and taken back, the composer's NEXT TURN
  RUNS ON picker, the two real agent turns (the waits are capped and fail
  loudly if the lab's worker cannot run them), the switch divider
  `… carried over`, AGENTS IN THIS CHAT with its turn ranges; **rcn-2f** —
  `Make a workflow…` opening the assistant with the chat as context (the
  app's canned ask is asserted, never the model's answer); **rcn-1j** (admin
  — the Inputs tab edits the DRAFT and the library role authors it): add
  `issue`, typed GitHub issue, marked required, saved, and the WHO FILLS
  rows (by hand asks for the required names; the trigger row reads
  `✓ issue ← the labeled issue`); **rcn-1k** — the row's Run opening the
  form whose fields are the pinned revision's declared inputs (goal a
  textarea, revision a branch field on `main`), Cancelled — no run is ever
  started on this pin. The pass PAUSES its issue trigger at the end (same
  rule as repo-triggers). **3d agent mail has no journey**: the inline mail
  card needs two live agents actually conversing, which a pass cannot stage
  without faking the answer — the TODO sits in the spec.

Journeys share the pass's lab serially (`workers: 1`); names are
pass-stamped (`EMU_PASS_ID`) so passes never collide. Cleanup is only for
what would make the NEXT pass differ (triggers are paused); pass-stamped
workflows/projects/repos are left behind.

API writes from a journey go through `apiMutate(page, …)` (fixtures.ts) —
it replays the `GET /api/v1/me` CSRF token as `X-CSRF-Token`, exactly like
the web client, because the lab guards mutations with the double-submit
header. An `expectFailure` declaration also silences the browser's own
"Failed to load resource" console error for the declared URL.
