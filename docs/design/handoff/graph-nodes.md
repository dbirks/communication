# Graph nodes — the definition graph in the design system

Status: **engineering proposal, drawn in the system's spirit, awaiting design review.**
Implemented in `ui/src/components/m4/DefinitionGraph.tsx`, `ui/src/components/m4/KindChip.tsx` and
`ui/src/lib/pipeline/layout.ts`; measured geometry and dependency rules in
[ADR-0025](../../adr/ADR-0025-definition-graph-layout-and-rendering.md).
Semantics of what a node *is* come from `03` (kinds, scopes, entry/exit) and `01` (identity);
nothing here changes them.

The identity handoff lists "graph-editor nodes" under STILL OPEN. This is the slot filled by whoever
was drawing screens, not a design decision: the M4 screens cannot show a pipeline without a node, so
a node exists — in the system's vocabulary, at the system's measurements, and with the system's one
rule that matters most here (**rule 06: every state carries glyph *and* word, never colour alone**).

## What the surface is

Two places, one node language:

1. **Library / revision viewer** — the definition only, no state. Title-bar meta carries provenance
   (`pinned revision 7 · sha256:3f2f…`), because a graph without a digest is a picture of some
   pipeline, not this one.
2. **Run inspector** — the same graph with a state chip per node, joined from `node_executions`. The
   graph is definition; the chip is run. Neither is allowed to change the other's shape.

The canvas is read-only at M4. An editor (M5) inherits this node, plus a position store that must
stay out of the canonical document (ADR-0025 § Consequences).

## Node anatomy — 200 × 60, radius 3, one 1px line

```
┌──────────────────────────────────────┐  border: --color-node-border (#cfcac0, line-strong)
│ ⟨4⟩ implement                        │  row 1 · mono 11px ⟨n⟩ + Red Hat Text 12.5px 600, ink
│ ✓ DONE  ◆ agent.acp                  │  row 2 · STATUS-E chip + kind chip (mono 9.5px)
└──────────────────────────────────────┘
```

| Slot | Content | Why it is where it is |
|---|---|---|
| Row 1 | binding marker `⟨n⟩`, then the **node id** | The id is the only string an expression can use (`nodes.implement…`), so it never shares a line with a chip and never truncates before a chip does. `⟨n⟩` is the handoff's binding marker; **n is the real count of `${{ }}`/CEL slots on the node**, so it is a fact and not an ornament. A node with no bindings shows nothing — an empty box would read as "unknown kind", because `□` *is* the unknown-kind glyph. |
| Row 2 | state chip (run context only) + **kind chip** | Identity and state share the machine row: both are mono, both are short, neither is prose. |
| Selected | `border: --color-node-border-selected` (ink) + `shadow-raised` (`2px 2px 0 #1e1d1a`) | Exactly BTN-I / ROW-I's raised selection. There is no "selected node" colour, so a selected node cannot be mistaken for a state. |
| Deferred kind | dashed 1px border + grey kind chip + `not until M5` | ADR-0024's refusal has to be legible or it is just a wall. |

Canvas: `--color-canvas-bg` (#f4f2ec, one step off paper) inside a 1px `--color-line` frame; nodes are
`surface` (#fff). Nodes are real `<button>`s — no `foreignObject`, no canvas raster, no library CSS.

## Kind identity — glyph + name, always both

The catalogue is sixteen names (`03`, scoped for M4 by ADR-0024). The glyph is a **family marker in
mono, beside the name in words** — never the name's substitute. Where a chip can be short (the
canvas), the name is still there; where there is room (the list, the inspector) the name is alone
and the glyph is the locator.

| Kind | Glyph | Family read |
|---|---|---|
| `agent.acp` | `◆` | filled diamond — a mind with hands (an agent that acts) |
| `model.chat` | `◇` | the same shape open — a mind without hands |
| `process.exec` | `▸` | a command |
| `condition` | `⌄` | a fork in the flow |
| `gate` | `◉` | a hard ring: pass or stop |
| `human.approval` | `⊙` | a ring with a person in it |
| `until` | `↻` | the loop's own arrow |
| `for_each` | `⊕` | one thing, added per item |
| `parallel` | `∥` | side by side (M5) |
| `join` | `≡` | aligned into one (M5) |
| `pipeline.invoke` | `⇒` | a call, leaving this graph |
| `artifact.publish` | `↑` | leaving the workspace, upward |
| `git.commit` | `◍` | a commit point (M6) |
| `git.publish` | `⇧` | pushed out (M6) |
| `integration.query` | `?` | asks something outside |
| `integration.action` | `!` | changes something outside |
| *(unreadable kind)* | `□` | not in the catalogue: an empty box with the server's name beside it, verbatim |

Two deliberate exclusions, learned the hard way: `✋` (`human.approval`) and `▶`/`⬆`
(`pipeline.invoke`, `artifact.publish`) were replaced with `⊙` and `⇒`/`↑`, because U+270B, U+25B6
and U+2B06 are **emoji-presentation capable** — they render as coloured pictograms on some platforms,
which would put a colour on the canvas that means nothing. Keep every glyph inside geometric-shapes
with text presentation. (The state glyphs `● ! × ⊘ ↻ ✓ · i` are already in this class; nothing here
is a colour-only signal, and the shipped `@fontsource` latin subsets do not contain them, so they
arrive by system fallback today. **Design should decide the fallback stack or replace these with
drawn glyphs** — this is the open item with the most consequences.)

## Scope groups — a boundary, not a node

An `until` / `for_each` is not a box with a label; it contains its body (03 § 3).

```
┌───────────────────────────────────────────────────────┐ border: 1px ink (#1e1d1a), radius 3
│ ↻ UNTIL · BUILD_UNTIL_VERIFIED · MAX 4                │ bar: mono 10px 600, +4% tracking, ink-2
│   ┌─────────────┐   ┌─────────────┐   ┌────────────┐  │ fill: --color-node-scope-fill
│   │ ⟨4⟩ implement│ → │ test         │ → │ review     │  │ (rgba(232,229,221,.45) wash)
│   └─────────────┘   └─────────────┘   └────────────┘  │
└───────────────────────────────────────────────────────┘
```

- Bar text is `KIND · NAME · bound`, all uppercase mono, where **bound is the document's own**
  (`max 4`, `≤3 in flight`, `25 items`) and is omitted when the document declares none — never a
  number we made up.
- Geometry: children's bounding box + 12px padding + a 22px bar. The group's *name* is in words, so
  the box is never the only signal.
- Edges cross the boundary to the body's entry/exit nodes, never to the group: a scope has no
  position to arrive at.
- An empty body is a compiler error (`empty_body`) but a draft may not compile yet, so the node
  degrades to a plain node — dropping it would make the graph lie about what the document contains.
- **Open question for design:** when a scope's contents are failing, may the bar take the state's
  strong colour (CARD-L rule 5), or does a boundary stay neutral and let the chips inside carry it?
  Current build: boundary stays ink.

## Edges

| Kind | Draw |
|---|---|
| dependency | 1px `--color-line-strong` (#cfcac0), solid, arrowhead at the head, 6px |
| condition route | same, with the selected route at 100% and the others at 45% opacity |
| error route (`onFailure.errorRoute`) | 1px dashed `--color-node-error-route` (#d0402f) |
| selected node | its edges stay full, everything else drops to 45% |

Edges are **decorative to assistive technology**. A polyline cannot say *"verdict routes to
`publish_needs_attention` when the result is not successful"*, and a hidden-text duplicate would be
a second source of truth for the same claim. The claim lives in the node list.

## State overlay (run context)

- Inside the node: STATUS-E chip with the state's **short word** (`✓ DONE`, `● RUNNING`,
  `! NEED YOU`, `⊘ STOPPED`, `× FAILED`) — a 200px box cannot hold `SUCCEEDED` beside a kind name.
- In the node list and the binding inspector: the **wire status verbatim** (`succeeded`,
  `waiting`, `interrupted`, `leased`), because that list is where a person checks the UI's reading
  against the API's word.
- Both words come from the one table (`ui/src/components/ds/states.ts`: `STATES`, `SHORT_WORD`,
  per-status maps). A stage cell, a tree row and a graph node that disagree about what cerulean
  means break rule 06 at the only place it can be audited.
- A node is never painted `interrupted` because one of its *attempts* was: `node_executions.status`
  is the node's current state, so a node that retried and succeeded is `done` on the canvas, and the
  interruption is legible in the attempt panel where it belongs.

## Bindings and the inspector (why the graph is not just a picture)

Selecting a node opens the binding inspector: the node's `path` (scope-qualified), the document
pointer (`/spec/nodes/2/config/body/nodes/0` — which is what links the box to a YAML line and back),
and each binding as it was **written**: slot path, position (`in text` for `${{ … }}`, `bare
expression` for a CEL slot), the expression verbatim, and the declared roots it names (`inputs`,
`nodes`, `previous`, `iteration`, `item`, `items`, `run`, `budget`).

Two honesty rules there: quoted literals are blanked before roots are read (so `'(first iteration:
no prior review)'` does not report an `iteration` dependency), and nothing is evaluated — the UI
shows what the compiler accepted, never what it would resolve to.

## The node list is part of the design

Below the canvas: one row per concrete node, in dependency order — state chip, name, kind glyph,
`after <deps>` / `no dependencies`, `· in scope` when nested, binding count on the right. It is the
keyboard-free and screen-reader path to the same information, and it is the honest total when the
canvas overflows (a § 9.3 sample lays out at 1824×172 px against an 862 px frame), which is why the
caption above the canvas states `8 nodes · 7 edges · 1824×172 px`.

Keyboard on the canvas: nodes are tab-stops, `aria-pressed` marks selection, arrow keys move to the
spatial neighbour in that direction, and each node's accessible name is
`Definition node implement in scope build_until_verified, kind agent.acp, 4 bindings`.

## What design still owes this surface

1. Glyph set: keep-or-replace the geometric-shape glyphs, and decide the font fallback (they are not
   in the shipped latin subsets).
2. Whether a scope boundary may take a state's strong colour (CARD-L rule 5 inside a graph).
3. Pan/zoom affordance and a max readable node count before the canvas should degrade to the list.
4. Whether a node shows a profile or model monogram — deferred here because profiles are org-scoped
   names (`ADR-0016` § 10 keeps revisions deferred) and a monogram would imply a fact the API does
   not send.
5. Dark-theme slots: every token used here (`--color-node-border`, `--color-node-border-selected`,
   `--color-node-scope-fill`, `--color-node-error-route`, `--color-canvas-bg`, `--color-redacted-fill`)
   is a named slot in `ui/src/styles/tokens.css`, none is a literal.
