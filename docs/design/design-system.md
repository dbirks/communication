# Design system: tokens, typography, layout, responsive (M5 layer)

Two design documents exist in this folder, and they are not in conflict — they are different layers:

| Layer | Authority | Owns |
|---|---|---|
| **Visual identity v0.1** | [`handoff/README.md`](handoff/README.md) (transcription of `handoff/design-system-handoff.dc.html`, "5f Hairline Flat"), implemented today as `ui/src/styles/tokens.css` + `ui/src/components/ds/` | colour families, the eight state sets (STATES-J), type scale and fonts, shape/depth/texture, the locked primitives (BTN-I, INPUT-A, CARD-L, ROW-I, STATUS-E, PROGRESS-J/K, ALERT-K, NAV-I, SIDE-F, MARK-E) |
| **M5 application layer (this file)** | this document | the *roles* the M5 screens need that v0.1 left open — status→state mapping for every domain enum, attention/approval/assistant/diff/highlight tokens, layout and density for the run tree, editor and assistant panes, responsive behaviour, and the copy voice |

Rule for everyone: **do not restyle the identity from a feature branch.** New screens consume
`ui/src/components/ds/*` and the tokens below; a token is added here, transcribed into
`ui/src/styles/tokens.css` by an implementation worker with its own brief (`ui/` is outside this
brief's boundaries), and the identity handoff is the place hue decisions are recorded. This is the
`10` "Independence boundary" applied to visuals: engine code never reads a colour, and a feature
never re-defines one locally.

## What ships today (observed, not assumed)

`ui/src/index.css` = `@import "tailwindcss"` + `@import "./styles/tokens.css"` + the global
reduced-motion floor. `tokens.css` (295 lines) defines `@theme` families `--font-ui` (Red Hat Text),
`--font-mono` (Red Hat Mono), `--font-mark` (Kaisei Opti, mark only), neutrals
(`paper #f8f7f3`, `surface #ffffff`, `ink #1e1d1a`, `ink-2 #3a3833`, `muted #6b675e`,
`faint #8f8a80`, `line-strong #cfcac0`, `line #e6e2d9`, `line-soft #f0ede6`, `fill #efede7`),
the royal accent (`--color-accent #2f4bd6` + edge/shadow/text/mid/tint/wash/ring), eight state sets
`--color-st-<state>-{tag,tag-fg,strong,strong-fg,pale-bar,pale-body,pale-edge,pale-fg}`,
progress segments (`--color-seg-*`), radii `tag 2 / panel 3 / btn 4`, `--shadow-raised: 2px 2px 0 ink`,
the type scale (`title-xl 22 / title-l 19 / title-m 15 / body 13.5 / ui 13 / small 12.5 / meta 11 /
label 10.5 / bar 10`), the texture classes `.ds-texture-neutral/.ds-texture-accent/.ds-hatch-mark`,
and `.ds-btn` variants. Fonts are self-hosted from pinned `@fontsource/*` — no runtime third-party
request. Density from the handoff: 34px rows, 30px buttons, 52px app bar, 4px card gaps.

## Measured contrast (WCAG 2.1, computed offline from the shipped hexes)

Not measured in a browser — the implementation worker re-verifies against built CSS during the
Playwright pass and records observed numbers (ADR-0006; `12` "record test results, don't prefill").

**Text pairs, all ≥ 4.5:1 — safe as shipped**

| Foreground on background | Ratio | Where it appears |
|---|---|---|
| `ink #1e1d1a` on `paper #f8f7f3` | 15.72:1 | page text |
| `ink-2 #3a3833` on `surface #ffffff` | 11.71:1 | body copy in panels |
| `muted #6b675e` on `surface` | 5.63:1 | secondary text, sub-nav |
| `accent-text #2a43b8` on `surface` | 8.10:1 | links |
| `accent-text` on `accent-tint #eef0fc` | 7.14:1 | context chips |
| `ink` on `accent-wash #f6f7fe` | 15.78:1 | highlighted areas, active stage cell |
| panel title bar `ink-2` on `fill #efede7` | 10.00:1 | CARD-L default bar |
| state tags: running 5.74 · waiting 6.42 · failed 5.03 · interrupted 5.01 · retrying 6.17 · done 5.43 · queued 5.81 · info 5.87 | ≥5.0:1 | STATUS-E chips (mono 9.5px 600) |
| pale alerts: waiting 9.18 · failed 8.71 · interrupted 8.11 · running 8.51 · done 7.52 | ≥7.5:1 | ALERT-K bodies |
| strong bars: waiting 8.38 (dark fg) · retrying 8.05 · queued 6.96 · info 6.34 | ≥6.3:1 | CARD-L action bars with the handoff's dark fg |

**Pairs the M5 screens must not use for text (≥3:1 only, i.e. large-text/non-text)**

| Pair | Ratio | Consequence for M5 |
|---|---|---|
| `faint #8f8a80` on `surface` | 3.43:1 | meta (mono 11px) fails AA as *text*: use `faint` only for aria-hidden glyphs, decorative marks and placeholders; every meaningful meta string uses `muted` |
| white on `st-running-strong #2a8bd0` | 3.68:1 | strong bars may carry the **word** only at `title-m`-or-larger/600 or with the dark fg; at `bar` 10px use pale or `*-tag` instead |
| white on `st-done-strong #3a9a5b` | 3.53:1 | same |
| white on `st-failed-strong #d0402f` | 4.71:1 | passes; keep |
| white on `st-interrupted-strong #e8763f` | 2.96:1 | **fails even 3:1**: an interrupted panel bar takes the pale treatment (`pale-bar`/`pale-fg`, 8.11:1) with the `⊘ INTERRUPTED` word — never white-on-orange |
| `disabled-fg #b3ada2` on `disabled-bg #f3f1ec` | 1.98:1 | acceptable only because disabled text is exempt from AA contrast; it must never be the styling of an *enabled* control |
| `line #e6e2d9` / `line-strong #cfcac0` on `paper` | 1.21 / 1.52:1 | decorative; the hairline system is why "status never colour-only" is enforced in the components (`STATUS-E` glyph + word, `ALERT-K` label) |

The `⊘ INTERRUPTED` and `faint` findings are real bugs in how an M5 screen would naively render
`run.interrupted` — recorded here so nobody discovers them at review time.

## Token extensions M5 needs (additive; identity-neutral)

These are **roles**, each expressed with existing v0.1 values so no new hue enters the product.
Paste-ready Tailwind v4 block (v4.3.3, CSS-configured — `ui/vite.config.ts` uses `@tailwindcss/vite`,
and there is no `tailwind.config.js`):

```css
/*
 * docs/design/design-system.md — M5 application layer.
 * Extension of ui/src/styles/tokens.css (identity v0.1, docs/design/handoff/README.md).
 * Adds ROLES only: no new hue, no restyled primitive. Apply in a ui/ brief, not here.
 */
@theme {
  /* ── Attention / inbox hierarchy (ROW-I + STATUS-E reuse) ─────────────── */
  --color-inbox-group-bar: var(--color-fill);        /* neutral panel title bar   */
  --color-inbox-group-bar-urgent: var(--color-st-waiting-strong);
  --color-inbox-row-hover: var(--color-accent-wash); /* the only hover wash in app */
  --color-inbox-count: var(--color-muted);

  /* ── Run inspector: tree, timeline, stage strip ───────────────────────── */
  --color-tree-guide: var(--color-line);             /* indent guides, 1px         */
  --color-tree-active: var(--color-accent-wash);     /* focused row inside a tree  */
  --color-timeline-rule: var(--color-line-soft);
  --color-attempt-stale: var(--color-st-interrupted-pale-body);
  --color-seg-detached: var(--color-st-retrying-strong); /* detached child run     */

  /* ── Pipeline editor ──────────────────────────────────────────────────── */
  --color-canvas-bg: var(--color-paper);
  --color-node-border: var(--color-line-strong);
  --color-node-border-selected: var(--color-ink);
  --color-node-scope-fill: var(--color-accent-wash); /* until / for_each / parallel */
  --color-node-error-route: var(--color-st-failed-tag-fg);
  --color-diff-added: var(--color-st-done-pale-body);
  --color-diff-added-edge: var(--color-st-done-pale-edge);
  --color-diff-removed: var(--color-st-failed-pale-body);
  --color-diff-removed-edge: var(--color-st-failed-pale-edge);
  --color-diff-changed: var(--color-st-waiting-pale-body);
  --color-diff-changed-edge: var(--color-st-waiting-pale-edge);

  /* ── Assistant (08: highlight without cinematic animation) ────────────── */
  --color-assistant-ring: var(--color-accent);       /* 1px ring, always w/ caption */
  --color-assistant-surface: var(--color-accent-tint);
  --color-assistant-trace-pending: var(--color-st-waiting-pale-body);

  /* ── Evidence and safety surfaces ─────────────────────────────────────── */
  --color-preview-frame-chrome: var(--color-fill);   /* sandboxed iframe bar       */
  --color-redacted-fill: var(--color-line-soft);     /* "value never shown" block  */
  color: var(--color-muted);

  /* ── Layout: panes the M5 screens need ───────────────────────────────── */
  --layout-content: 64rem;   /* as shipped: main is max-w-5xl px-4            */
  --layout-wide: 80rem;      /* Runs, Library                                 */
  --pane-tree: 26rem;
  --pane-detail: 34rem;
  --pane-assistant: 24rem;
  --pane-inspector: 22rem;
  --row-condensed: 28px;     /* tree/timeline rows: identity 34px, dense lists 28px */
  --indent-step: 14px;       /* execution-tree indent per level                */

  /* ── Motion: the identity has none of these yet ──────────────────────── */
  --duration-fast: 120ms;
  --duration-base: 180ms;
  --ease-out: cubic-bezier(0, 0, 0.2, 1);
}

/* Focus: one ring product-wide, built from the identity's own tokens
   (BTN-I focus = tonal shadow + paper gap + royal ring). */
@utility focus-ring {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}

/* A 1px hairline that reads as structure without ink weight. */
@utility rule-soft {
  border-top: 1px solid var(--color-line-soft);
}

/* "the server did not give us this" — never a dash alone. */
@utility value-unavailable {
  color: var(--color-muted);
  font-family: var(--font-mono);
  font-size: var(--text-meta);
}
```

Usage rules for the additions:

- `--color-node-error-route` and the `--color-diff-*` roles use *pale* fills plus an edge; a
  removed/failed node is labelled `[removed]`/`× FAILED` in text, never tint-only (identity rule 06).
- `--color-redacted-fill` blocks are always accompanied by the words "value never shown" — a black bar
  alone reads as a missing render (J8).
- No new component may set a hex literal; class strings reference tokens or the `ds/` primitives.

## Status → state set (the table the components consume)

`ui/src/components/ds/states.ts` already maps the M1/M2 statuses onto the eight sets. M5 extends
**that** table; it does not add a ninth set. Where two domain states share a set, the **word** carries
the difference (identity rule 06).

| Domain state (`01`, `03`, ADR-0016, M3) | State set | Glyph + word shown | Note |
|---|---|---|---|
| run `queued`, turn `queued` | queued | `· QUEUED` | |
| run `preparing`, `running`; node `ready`, `leased`, `running` | running | `● RUNNING` | cerulean = work in progress |
| run `waiting_human`; node `waiting`; approval pending; permission pending | waiting | `! NEEDS YOUR DECISION` / `! WAITING FOR APPROVAL` | the royal accent means *you* can act, so a waiting panel pairs `!` with a royal button |
| run `paused` | waiting | `! PAUSED` | distinct word; pipeline scheduling stopped, not an agent pause |
| node `skipped` | queued | `· SKIPPED` | neutral: nothing needs anyone |
| run/node `failed`, turn `failed`, permission `expired` | failed | `× FAILED` | |
| execution ok + `business_outcome=fail` | failed | `× CHECK FAILED` rendered beside `✓ RAN FINE` | two words side by side, because the engine distinguishes them (`03`) |
| run `cancelled`, turn `cancelled`, node `cancelled` | interrupted | `⊘ CANCELLED` | |
| run/node `interrupted`, turn `interrupted`, conversation `disconnected`, worker `offline` | interrupted | `⊘ INTERRUPTED — outcome unknown` | panel uses the **pale** interrupted set (white-on-`#e8763f` fails 3:1) |
| attempt retry in flight; SSE/feed reconnecting | retrying | `↻ RETRYING 2/4` / `↻ RECONNECTING` | |
| run `completed`, node `succeeded`, turn `completed`, health ok, readiness ready | done | `✓ COMPLETED — met acceptance passes (not merged)` | never "merged" (H6 in the checklist) |
| revision `draft` / `validated` / `published` / `deprecated` | queued / info / done / queued | `· DRAFT`, `i VALIDATED`, `✓ PUBLISHED 8f2c1a…`, `· DEPRECATED` | royal button says "publish" — royal means *you can act* |
| assignment channel `stable` / `beta` | info / waiting | `i STABLE 8f2c1a…`, `! BETA 41d0b7…` | digest in mono always |
| worker `online` / `draining` / `offline` | done / waiting / interrupted | `✓ ONLINE`, `! DRAINING`, `⊘ OFFLINE` | |
| sandbox `required`+verified / `permissive-dev` / `disabled` | done / waiting / waiting | `✓ REQUIRED · VERIFIED`, `! INSECURE DEV EXECUTION`, `! ISOLATION DISABLED` | `05`: never silent |
| sandbox enforcement failed | failed | `× ENFORCEMENT FAILED · stage exec` | stage + reason from the event |
| artifact `standard` / `internal` / `restricted` / `secret` | queued / info / waiting / — | `STANDARD`, `INTERNAL`, `! RESTRICTED — metadata only`; `secret` is **not listed at all** (ADR-0020 §3) | no row is the correct render |
| secret `revoked`, mount refused (`path_escape`, `tracked_target`, …) | failed | `× REVOKED`, `× NOT MATERIALIZED · tracked_target` | |
| assistant state | see [`assistant-flow.md`](assistant-flow.md) | `i PLANNING`, `! AWAITING YOUR ANSWER`, `! NEEDS APPROVAL`, `↻ EXECUTING 2/3`, `✓ COMPLETED`, `× FAILED` | |
| artifact state `pending` / `ready` | queued / done | `· PENDING`, `✓ READY` | |

## Typography for the new screens

Reuse the v0.1 scale; state which role each M5 region takes. Mono = anything a machine produced
(identity rule 07), which in M5 is most of the run inspector.

| Region | Role |
|---|---|
| page `h1` (project, run, draft, worker) | `title-l 19/700` (run id in mono beside the pipeline name) |
| panel/section bar | `bar 10/600 mono +4%`, uppercase, `STATUS-E` word when the panel needs action |
| Attention row title | `small 12.5` (Red Hat Text) + `meta 11 mono` age, as `ROW-I` |
| execution-tree label | `small 12.5` node name, `meta 11 mono` counts |
| timeline row | `meta 11 mono` time · `small 12.5` summary · `label 10.5 mono` actor chip |
| outputs / YAML / diffs / prompts / digests | `--font-mono` at `body 13.5` (code blocks) or `meta 11` (dense) |
| inspector form | `label 10.5 mono` field labels (never `bar` — bar is for panel title bars only) |
| transcript | `body 13.5` prose, mono for tool payloads; measure capped at ~78ch |
| numbers | `font-variant-numeric: tabular-nums` — added as `@utility numeric` in the extension block if not already; ages/counts must not jitter |

Sentence case everywhere; no all-caps prose (only `bar`/`label` mono roles, which the identity uses
deliberately); ids are never the only label (`user <8>` fallback pattern already in the code).

## Layout and density

| Region | Rule |
|---|---|
| Default pages | `max-w-5xl px-4` exactly as `Shell.tsx` renders today |
| Runs, Library | `--layout-wide 80rem` via a `layout="wide"` hint on `Shell` — no page fights the container locally |
| Run inspector | stage strip full width; then `--pane-tree 26rem` + flexible detail; detail collapses to a bottom sheet <1280px |
| Execution tree | `--indent-step 14px`, `--row-condensed 28px`, guides in `--color-tree-guide`; counts right-aligned mono |
| Timeline | one row per event, `34px`, filters above; `dl` for key/value facts |
| Editor | three panes: palette `--pane-inspector`, canvas (min 40rem), inspector `--pane-inspector`; validations as a bottom drawer, 40% max height |
| Assistant | `--pane-assistant 24rem` right dock ≥1280px; below that a sheet; **never** overlaying the composer on mobile |
| Grid rhythm | the identity's 4/8/12/16/24/32 steps only; 4px gaps between cards (identity rule 08: space around groups, not inside them) |
| App bar | 52px, unchanged; a project switcher slot stays where the handoff put it (secondary button, 30px) |

Texture stays rare: `--color-node-scope-fill` is a flat wash (no crosshatch) because identity rule 04
forbids texture on progress or text; the accent grid texture keeps meaning "active/selected" — in M5
that is the sub-nav active item and the selected run-tree row only.

Shadow: `--shadow-raised` remains the *only* shadow, and in M5 it means "selected" (tree row,
approval row, palette node) — dialogs keep the identity's flat hairline rather than inventing an
elevation scale. **Open UX choice:** whether a drawer needs a shadow; recommended answer is "no, a
1px ink edge", to stay flat.

## Responsive behaviour

Breakpoints are Tailwind defaults (`sm 40rem`, `md 48rem`, `lg 64rem`, `xl 80rem`); the semantic map:

| Range | Attention | Run inspector | Editor | Conversation | Assistant | Operations |
|---|---|---|---|---|---|---|
| <40rem | grouped list, one column, filter chips | stage counts → flat attempt list → detail route; **no canvas** | read-only graph image + Parameters/YAML tabs | transcript; controller badge sticky; composer above keyboard | sheet, opened explicitly | cards of `dl` pairs |
| 40–48rem | as above + counts inline | same | same | + context rail behind a button | sheet | two-column forms |
| 48–64rem | two-column groups | tree; detail as bottom sheet | palette drawer + canvas + inspector drawer | rail as toggle | sheet | tables scroll |
| 64–80rem | full | tree + detail stacked→side by side | 3 panes, inspector collapsible | full | dock, toggled | full tables |
| ≥80rem | full | full 3-column with timeline beneath | full | full | dock persistent | full |

Mobile is supervision, not authoring (`10` responsive): approve, take control, retry-from-boundary,
read evidence, and prompt all work at 320px; canvas editing does not, by design. Nothing that an
approval or a handoff needs may exist only at `lg`.

## Motion and reduced motion

v0.1 defines no transitions, which fits this product: state changes are announced by words, not by
movement. M5 rules:

- Transitions exist only for hover/focus (120ms) and expand/collapse (180ms) with `--ease-out`; no
  entrance animation for runs, transcripts or tree rows.
- The pressed `translate(2px,2px)` + shadow removal is the only "movement" that carries meaning
  (button press), and it is not an animation.
- Under `prefers-reduced-motion: reduce` (global floor already in `ui/src/index.css`) assistant
  highlight rings appear statically with their caption, tree expansion is instant, transcript
  streaming defaults to the per-turn/slow rate, and no pulsing exists anywhere.
- Live counters (`waiting 3d 4h`, deadline countdowns) update on the minute and are `aria-hidden`
  with a text alternative — a ticking number is motion for a screen reader too.

## Copy voice (owned here)

Plain, declarative, no hype; failures are ordered *what happened → what is safe → what to do next*.

- Keep shipped strings: `Sign in`, `Sign out`, `Projects`, `Operations`, `Take control`,
  `Return control`, `Stop`, `role:`, `profile:`, `status:`, `stream:`, `turn:`,
  `Project not found or you do not have access`, `Conversation not found or you do not have access`,
  `That repository name is already used in this project.`, `Pick a different name — the slug is taken.`,
  `Only the controller can send prompts…`, `A turn is already open (status: …)…`.
- Bar titles follow the identity: `! NEEDS YOUR DECISION`, `× FAILED`, `⊘ INTERRUPTED`,
  `↻ RETRYING 2/4`, `✓ PUBLISHED`, `· QUEUED`, `i NOTE`.
- Reserved words, never used loosely: *paused* (pipeline scheduling) · *cancelled* · *interrupted*
  (nobody reported an outcome) · *failed* · *completed* (acceptance passed, not merged) ·
  *take/return control* (the CAS lock) · *publish* (immutable revision) · *promote* (a project's
  assignment) · *draft* (never "unsaved changes").
- Never written: "resumed without loss", "recovered", "synced", "are you sure?", emoji, exclamation
  marks inside a status word, "something went wrong".
- Protocol/product names as in the spec: ACP, APM, nono, OIDC, Postgres; a launcher id
  (`claude`, `codex`) is always shown with its profile name.
- Nothing promises tenant isolation or sandbox certainty (`05` Trust caveat, D-025 **Open**).

## Open items handed back to the identity pass (slots, not inventions)

The v0.1 handoff's own "STILL OPEN" list; M5 needs four of them, so the requirement is stated without
inventing finals:

| Item | M5 need | Suggested slot (not a decision) |
|---|---|---|
| Graph-editor nodes | node cards for 11 kinds + scope containers | keep CARD-L hairline boxes; state = tag chip; scope container = wash + labelled bar |
| Empty states | every screen in `wireframes.md` §12 | `Mark`/`Wordmark` slot + `small` copy + one BTN-I secondary |
| Toggles / checkboxes | transcript rate, tree "hide succeeded", promotion target pickers | needs an INPUT-A-consistent treatment before use |
| Toasts | "Draft saved", "Control returned" | ALERT-K pale + 26px compact action; never the sole channel for an error |
| Avatars / presence | controller badge, participants | keep the 28px initials box (`InitialsBox` already ships); **no presence indicator until a server source exists** |
| Dark theme | none | deferred; every role above is defined through existing tokens, so it costs one palette block later |
