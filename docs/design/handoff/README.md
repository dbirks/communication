# Design system handoff — transcription

- Source of truth: `design-system-handoff.dc.html` in this folder ("COMMUNICATION ·
  VISUAL IDENTITY v0.1 · 2026-10-14"). It is an export from a design tool and references a
  missing `./support.js`, so it does not render standalone. **It is the visual authority**;
  everything below is a faithful transcription of its visible text and its
  `renderVals()` script data so engineers never need to open the HTML.
- Implemented in the app as `ui/src/styles/tokens.css` (tokens) and `ui/src/components/ds/`
  (locked components). Direction name: **5f Hairline Flat** — warm paper, ink hairlines,
  small corners, soft tactile buttons with a bottom-right shadow, a very light crosshatch
  for texture, and color used mainly to signal state.
- Still open (per the handoff "STILL OPEN" box — keep slots, don't invent finals): dark
  theme (every token has a slot for it), toggles and checkboxes, avatars and presence,
  toasts, empty states, graph-editor nodes. Royal (ACCENT-I) is the accent pick; light
  cerulean (ACCENT-K) was close and both live in R3, so swapping later changes only the
  accent tokens.

## Pick ids

`TEXTURE-G` light crosshatch · `MARK-E` hatch offset · `ACCENT-I` royal · `STATES-J`
clear, brighter · `NAV-I` track + flat tab · `SIDE-F` box + grid · `BTN-I` tonal border +
shadow · `INPUT-A` hairline · `STATUS-E` tint + glyph · `CARD-L` bar by meaning · `ROW-I`
compact + raised · `PROGRESS-J` stage strip · `PROGRESS-K` per stage · `ALERT-K` all pale

## 01 Color

### Neutrals

| Token | Hex | Use |
|---|---|---|
| paper | `#f8f7f3` | app background |
| surface | `#ffffff` | panels, cards, inputs |
| ink | `#1e1d1a` | text, structural lines, raised shadow |
| ink-2 | `#3a3833` | body copy |
| muted | `#6b675e` | secondary text |
| faint | `#8f8a80` | meta, placeholders |
| line-strong | `#cfcac0` | inputs, gray edges |
| line | `#e6e2d9` | dividers |
| line-soft | `#f0ede6` | row rules |
| fill | `#efede7` | secondary buttons, nav track, gray bars |

### Accent · royal (ACCENT-I)

| Token | Hex | Use |
|---|---|---|
| accent | `#2f4bd6` | primary fill, mark hatch |
| accent-edge | `#2238a8` | primary border |
| accent-shadow | `#1a2d8f` | primary shadow |
| accent-text | `#2a43b8` | links, context chips |
| accent-mid | `#8fa0e6` | wordmark offset |
| accent-tint | `#eef0fc` | chips, selected wash |
| accent-wash | `#f6f7fe` | highlighted areas |

### State colors (STATES-J) · tag / strong bar / pale alert

Every state always carries its glyph **and** its word — never color alone.

| State | Glyph | Tag BG / FG | Strong (FG) | Pale bar / body / edge / FG |
|---|---|---|---|---|
| running | ● | `#d9eefa` / `#0f5e96` | `#2a8bd0` (`#fff`) | `#cfe8f7` / `#f3f9fd` / `#8cc8ec` / `#0f4c78` |
| waiting | ! | `#ffecc2` / `#7a4a00` | `#f0a93a` (`#2a1a00`) | `#fbe7b4` / `#fdf6e4` / `#e8cf94` / `#5c3d00` |
| failed | × | `#fdd8d2` / `#b0281a` | `#d0402f` (`#fff`) | `#f3c4b9` / `#fbefec` / `#e5b2a8` / `#7f2215` |
| interrupted | ⊘ | `#fde3d6` / `#a5431c` | `#e8763f` (`#fff`) | `#f2d6cc` / `#faf2ef` / `#e6c3b8` / `#7a3424` |
| retrying | ↻ | `#fff1cf` / `#7a5200` | `#ffe3a0` (`#5a3c00`) | `#fbefcf` / `#fdf9ee` / `#ecd9a6` / `#5a3c00` |
| done | ✓ | `#d9f0de` / `#1f6b37` | `#3a9a5b` (`#fff`) | `#d3e9d9` / `#f1f7f2` / `#b9d3bf` / `#1f5a33` |
| queued | · | `#eeece6` / `#5e5a52` | `#e2dfd7` (`#4a4740`) | `#efede7` / `#faf9f6` / `#dcd8ce` / `#4a4740` |
| info | i | `#e3f1fb` / `#135f96` | `#8cc8ec` (`#0f3c5e`) | `#e6f3fb` / `#f6fafd` / `#cfe3f2` / `#0f4c78` |

Pale bar titles (uppercase, mono, +4% letter-spacing): `● RUNNING`,
`! NEEDS YOUR DECISION`, `× FAILED`, `⊘ INTERRUPTED`, `↻ RETRYING 2/4`, `✓ PUBLISHED`,
`· QUEUED`, `i NOTE`.

Running uses cerulean on purpose: **royal means "you can act", cerulean means "work in
progress"**.

## 02 Type

- **UI / prose**: Red Hat Text 400 · 500 · 600 · 700. All interface text, titles, buttons.
- **Meta / machine-produced**: Red Hat Mono 400 · 500 · 600. IDs, timestamps, counts,
  labels, tags, title bars, code.
- **Mark only**: Kaisei Opti 500 — only the C and the boxed COMMUNICATION wordmark.
  Line-height 1 + `text-box: trim-both cap alphabetic` so the C sits optically centered.

Self-hosted (all OFL) via pinned `@fontsource/*` packages; no Google Fonts / external
requests at runtime.

### Type scale

| Token | Spec | Family | Sample |
|---|---|---|---|
| title-xl | 22 / 700 | Text | "Good afternoon, David" |
| title-l | 19 / 700 | Text | "Run #482" |
| title-m | 15 / 700 | Text | "Saved-cart endpoint" |
| body | 13.5 / 400 | Text | prose |
| ui | 13 / 500–600 | Text | "Pause pipeline · Overview · Runs" |
| small | 12.5 / 400 | Text | "Sandbox denies network by default." |
| meta | 11 / 400 mono | Mono | "run #212 · approve gate · 1h" |
| label | 10.5 / 600 mono | Mono | "PERMISSION · NETWORK" |
| bar | 10 / 600 mono +4% | Mono | "! NEEDS YOUR DECISION" |

## 03 Shape, depth, texture

| Aspect | Spec |
|---|---|
| Radius | 2 = tags, bars · 3 = panels, inputs, cards · 4 = buttons |
| Lines | 1px only. Ink (`#1e1d1a`) for structure (bars, panel edges); gray for inputs and dividers: `#cfcac0` inputs/gray edges · `#e6e2d9` dividers · `#f0ede6` row rules |
| Depth | One shadow: `2px 2px 0`, no blur. Tonal on buttons (darker tone of the fill), ink on raised selection (`2px 2px 0 #1e1d1a`). Pressed = `translate(2px,2px)` + no shadow. |
| Texture | 4px grid, 1px lines: `--texture-grid: repeating-linear-gradient(0deg, var(--tex) 0 1px, transparent 1px 4px), repeating-linear-gradient(90deg, var(--tex) 0 1px, transparent 1px 4px)`; `--tex: #e8e5dd` neutral · `#e4e8fa` accent. Diagonal hatch `--hatch-mark: repeating-linear-gradient(135deg, #2f4bd6 0 1px, transparent 1px 3px)` is only the mark's shadow. |
| Spacing | 4 · 8 · 12 · 16 · 24 · 32 |
| Density | 34px rows, 30px buttons, 52px app bar, 4px gaps between cards |

## 04 Locked component variants

### MARK-E — Mark

C in a 1px-ink, radius-3, white box; behind it a diagonal-hatch (`--hatch-mark`) square
offset to the bottom-right by 1/10 of the size (e.g. 44px box → `inset: 4px -4px -4px 4px`).
Sizes: 28px C alone in the app bar (font 17px), 40px (font 25px), 44px (font 27px) — font
≈ 0.61× box, Kaisei Opti 500, line-height 1, cap/alphabetic trim. Wordmark = 13 boxed
letters (16px, radius 0, `box-shadow: 1.5px 1.5px 0 #8fa0e6`, font 11px) for sign-in,
empty states and the expanded nav.

### BTN-I — Buttons (30px tall, radius 4, font Red Hat Text 600 12.5px)

Border and shadow use a **darker tone of the fill**. One primary per area. Hover =
`filter: brightness(0.96)`; pressed = `translate(2px,2px)` + no shadow; focus ring =
`box-shadow: 2px 2px 0 <tone-dark>, 0 0 0 3px #f8f7f3, 0 0 0 4.5px #2f4bd6`.

| Variant | Border | BG | FG | Shadow |
|---|---|---|---|---|
| primary | `#2238a8` | `#2f4bd6` | `#fff` | `2px 2px 0 #1a2d8f` |
| secondary | `#cfc9bd` | `#efede7` | `#1e1d1a` | `2px 2px 0 #cfc9bd` |
| ghost | transparent | transparent | `#2a43b8` | none |
| danger | `#e5a99c` | `#fdd8d2` | `#b0281a` | `2px 2px 0 #e5a99c` |
| disabled | `#e6e2d9` | `#f3f1ec` | `#b3ada2` | none, `cursor: not-allowed` |

(The handoff's app-bar project-switcher button is a secondary at 30px with border/shadow
`#cfc9bd`; alert inline buttons are a 26px compact secondary/primary.)

### NAV-I — App bar (52px, white, 1px ink bottom rule)

C (28px) · project dropdown (secondary button) · section track: `#efede7` rounded-4
track, 4px padding, items `padding: 4px 10px` radius 3 transparent border; **active =
flat white tab** (1px `#cfc9bd` border, white bg, 600 weight); hover darkens text to ink.
Right: "Ask" input (INPUT-A-like, 200px, context tag chip `#eef0fc`/`#2a43b8` mono 10.5px
+ `Ctrl K`) and you (28px radius-3 ink box, mono initials — avatars are still open, keep
the slot).

### SIDE-F — Sub-nav

Left column, items 13px muted, `padding 6px 8px`; **active = ink box + accent grid
texture** (`--texture-grid` with `--tex: #e4e8fa`, white base) + 600 weight + ink text.
Trailing mono counts/flags (`10.5px 600`) in the state color (e.g. `#b0281a` "1",
`#7a4a00` "!").

### INPUT-A — Inputs (32px, radius 3, mono content)

| State | Edge | Extra |
|---|---|---|
| rest | gray `#cfcac0` | placeholder faint `#8f8a80` |
| focus | ink `#1e1d1a` | `box-shadow: 0 0 0 2px #dfe4fa` (pale ring) |
| error | red `#d0402f` | inline message right-aligned in Red Hat Text 11px, `#b0281a` |

### CARD-L — Panel ("title bar by meaning")

1px `#cfcac0` edge, radius 3, white, sections separated by 1px `#f0ede6`. Title bar:
`padding 4px 10px`, bg `#efede7`, color `#3a3833`, mono 600 10px +4% tracking; right slot
mono 400 faint. **Gray bar by default; the bar takes a state's strong color only when the
panel needs action** (then 1px edge becomes the state edge, e.g. failed: edge `#d0402f`,
bar `#d0402f`/`#fff`, "needs you" right in 400 weight).

### ROW-I — List rows (34px, 4px gaps, STATUS-E chips)

Row: 1px `#e6e2d9`, radius 3, white, `padding 0 10px`, gap 9px. Left: STATUS-E chip
(`padding 1px 6px`, radius 3, tag bg/fg, mono 600 9.5px +3% tracking, `glyph WORD`).
Then mono 600 10px muted 20px project slot, bold 12.5px title (truncate), mono 10.5px
faint age. Hover: edge `#cfcac0`. **Selected = ink edge + `2px 2px 0 #1e1d1a`** (raised).

### STATUS-E — Chips

Tag bg/fg + glyph + word from the state table; mono 600 ~9.5–11px; never color-only.

### PROGRESS-J (run header) / PROGRESS-K (per stage)

- J: ink-bordered radius-3 strip of stage cells (`padding 7px 11px`, 1px `#e6e2d9`
  dividers). Cell = mono 10px faint label + 600 12.5px state glyph (inactive = `–` faint).
  Active cell has bg `#f6f7fe` (accent wash) and holds a 7px segmented bar (inset 0.5px
  ink outline, radius 1) with one segment per state: done `#4a4740` (neutral dark),
  running `#2a8bd0`, waiting `#f0a93a`, failed `#d0402f`, untouched `#fff`; counts + words
  alongside ("150 ✓ · 38 ● · 15 need you").
- K: rows of `label | 10px bar (1px ink, radius 2) | mono count`, same flat colors.
  Flat state colors, **no texture**; segments are clickable filters; always show counts.

### ALERT-K — Alerts (all pale)

Bar + body in the state's pale hue: bar `paleBar` bg / `paleFg` text (mono 600 10px +4%
tracking, `glyph LABEL`, right meta 400 opacity .75), body `paleBody` bg, whole box
`paleEdge` 1px edge, radius 3; text 12.5px; optional 26px compact action button carries
the emphasis (primary for "you can act", secondary otherwise). Example labels: `! NEEDS
YOUR DECISION`, `× FAILED`, `⊘ INTERRUPTED`, `i NOTE`, `✓ PUBLISHED`.

## 05 Rules of use

1. Ink is for structure and emphasis: app bar rule, panel edges, raised selection.
   Everything else uses gray lines.
2. Color means state. Royal = something you can do. Cerulean = work in progress. Amber,
   red, orange, green = waiting, failed, interrupted, done.
3. One shadow style everywhere: `2px 2px 0`, no blur. Pressing moves the element into its
   shadow.
4. Texture is rare: the light crosshatch marks "active" in sub-nav and highlighted areas;
   diagonal hatch is only the mark's shadow. Never on progress or text.
5. Panel title bars stay gray unless the panel needs action; then they take the state's
   strong color.
6. Every state has a glyph and a word. Never rely on color alone, including in progress
   bars (always show counts).
7. Mono for anything a machine produced (IDs, times, counts, paths, labels); Red Hat Text
   for anything a person reads as prose or acts on.
8. Density: 34px rows, 30px buttons, 52px app bar, 4px gaps between cards. Prefer
   compact; add space around groups, not inside them.

## Status → state-set mapping used by the app

| UI status | State set |
|---|---|
| turn queued / conversation idle / tool pending / "no turn yet" | queued · |
| turn leased, running · stream/feed live · conversation active · worker online · tool in_progress | running ● |
| permission pending · worker draining (needs attention) | waiting ! |
| turn or run failed · health/readiness not ok · permission expired · tool failed | failed × |
| turn interrupted or cancelled · conversation disconnected · worker offline · permission cancelled | interrupted ⊘ |
| SSE/feed reconnecting | retrying ↻ |
| turn completed · health ok · readiness ready · permission decided | done ✓ |
| conversation archived · informational notes | info i |
