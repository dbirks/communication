# ADR-0025 — The definition graph: dagre compound layout, edges to leaf nodes, HTML nodes over an SVG edge layer

- **Date:** 2026-10-15
- **Status:** Proposed
- **Owners:** M4 UI building-block implementers; M5 editor owner (this is the surface the editor inherits)
- **Related decisions / contracts:** ADR-0021 (canonicalization + revision digests — the graph is
  projected from canonical JSON, never re-parsed from YAML), ADR-0022 (expression roots and the
  binding subset the inspector shows), ADR-0023 § 1 (`node_instance_key` as a text path, 01
  invariant 6 — the graph's node key is that path minus the `[n]` suffix), ADR-0024 (which kinds M4
  runs and which it refuses — the deferred kinds still have to appear), `03` § 3 (scope bodies,
  entry/exit semantics), `10` J7 (iterations render as repeat counts on one stage), `docs/design/`
  handoff § "STILL OPEN" (graph-editor nodes were undesigned), `docs/m4-contract.md` routes 13/24/25,
  `ui/src/lib/pipeline/layout.ts`, `ui/src/components/m4/DefinitionGraph.tsx`,
  `docs/design/handoff/graph-nodes.md`

## Context

M4's UI has to draw a pipeline definition in two places: the library/revision viewer ("what is this
pipeline") and the run inspector ("where is this run inside the thing it ran"). The design handoff
lists *graph-editor nodes* under "STILL OPEN — keep slots, don't invent finals", so the visual
language for a node did not exist and had to be designed in the system's spirit rather than
imported. The constraints that make this a decision and not a library pick:

- **No YAML parser in the browser.** The UI's authority for a definition is route 13's canonical
  JSON document (`revision.canonical_document`); the YAML panel is read-only text. So the graph is
  built from a document object the compiler already accepted, and a node must be traceable back to
  the YAML line its pointer resolves to.
- **Scope nodes are not boxes.** `until`/`for_each` bodies are scopes (03 § 3): a scope must contain
  its members, and its members' identity is the scope-qualified path (`/build_until_verified/implement`),
  not the bare id — the § 9.3 sample has an `implement` inside a scope and the corrected example has
  one inside *two* scopes, so `node_id` alone cannot address a box.
- **A run overlays state on the same graph** (03 § 5.2, `10` J7), which means the graph's node key
  has to join `node_executions.node_instance_key` without a translation layer to get wrong.
- **Deferred kinds must be visible, not hidden** (ADR-0024): a document authored for M5/M6 has to
  show the seven kinds M4 refuses, with the milestone named, so the author learns what the compiler
  will say.
- **Keyboard and non-visual access are not optional** for a control-plane surface, and a
  screenshot-driven milestone needs layout that is *deterministic* — same document, same pixels —
  or every DOM assertion becomes flaky.
- Weight and licence matter: this is a 121 kB-gzip SPA today, and the graph is one panel inside it.

## Options considered

| Option | Advantages | Disadvantages | Evidence |
|---|---|---|---|
| **A — `@dagrejs/dagre` 3.1.1 as a pure layout function; HTML nodes + one SVG edge layer** | MIT; 48.6 kB raw / **16.95 kB gzip** ESM build (measured on the installed `dist/dagre.esm.js`); compound graphs (clusters) are native; deterministic for a fixed input; positions are plain numbers, so nodes are real focusable DOM buttons and hairlines/radius-3/mono type come from the existing tokens with no CSS reset fight | Cluster boxes are sized from children only (labels and padding added by us); **edges cannot terminate at a cluster** (observed crash); no pan/zoom, no edge routing around obstacles, no interactive editing | measured: `stat`/`gzip -c` on `node_modules/@dagrejs/dagre/dist/dagre.esm.js`; crash observed in the first compound-graph probe: `setEdge` against a cluster id throws `Cannot set properties of undefined (setting 'rank')` |
| **B — React Flow (+ `@dagrejs/dagre` for layout)** | Pan/zoom, minimap, edge labels, node drag — the editor features M5 will want; huge community | ~60 kB gzip before dagre plus `d3-*` and `zustand` runtimes; its own stylesheet and `foreignObject` node DOM collide with the design system's 1px hairline/mono rules (override surface = the whole node); its zoom/pan transforms make DOM assertions viewport-dependent | `pnpm add` trial: React Flow pulled `d3-drag/d3-zoom/d3-selection`, `zustand`, `@reactflow/core`; rejected on weight + override cost, not on licence |
| **C — `elkjs` (Eclipse Layout Kernel)** | Best-in-class layered/orthogonal routing, port constraints, real edge routing inside clusters | **EPL-2.0** (weak copyleft with a distribution-interpretation question this project has not adjudicated) and a ~1.4 MB unpacked bundle, mostly the layout engine, for one panel | `npm view elkjs license`; bundle inspected before rejection |
| **D — hand-rolled layered (Sugiyama-style) layout** | No dependency, exact control, smallest bytes | Weeks for crossing-number minimisation + compound nesting that dagre gives in one call; and it would have to be *re-derived* when M5 wants edge routing | rejected as scope, not as preference |
| **E — compiler emits positions; UI draws them** | Byte-identical layout server and browser; graph becomes data | `09`'s `canonical_document`/`plan_digest` are digest-bearing: adding coordinates to the canonical form either changes ADR-0021's digest scope (`v1alpha1-canonical-1`, not revisitable here) or stores a second non-canonical field the UI must trust | rejected: presentation must not enter a digest-bearing canonical document |

## Decision

**Option A.** Exact dependency: `@dagrejs/dagre` **3.1.1** (MIT), imported only by
`ui/src/lib/pipeline/layout.ts`.

The rules that follow, each of which is the shape of a bug we found rather than a style choice:

1. **Layout only, never rendering.** dagre returns `{x,y,width,height}` per node, per cluster and
   per edge polyline. Nodes are absolutely-positioned `<button>`s in an HTML canvas; edges are one
   SVG layer beneath them. No `foreignObject`, no canvas raster, no library CSS.
2. **An edge never terminates at a cluster.** A scope's incoming edges wire to the body's *entry*
   nodes and its outgoing edges to the body's *exit* nodes (`scopeEntryNodes` / `scopeExitNodes`,
   which is 03 § 3's entry/exit semantics, not a workaround): the cluster is a drawn boundary, and
   the crash above is dagre's way of agreeing.
3. **The graph's node key is the wire key minus the iteration.** `/build_until_verified/implement`,
   i.e. `definitionKeyOf(node_instance_key)` from `lib/pipeline/runView.ts`, leading `/` included.
   Run state therefore joins by identity: `rollupStatuses(nodes)` is keyed by exactly that string,
   and nothing in the UI maps `node_id` → box (a name two scopes can share).
4. **Group boxes are computed after layout, deepest scope first**, from the children's bounding
   box, plus `GROUP_PAD = 12` padding and a `GROUP_BAR = 22` title bar; dagre's own cluster
   width/height are ignored because they know nothing about the bar.
5. **Determinism**: fixed `NODE_SIZE = 200×60`, `rankdir: "LR"`, `nodesep: 20`, `ranksep: 56`, and
   insertion in document order. `layout.test.ts` asserts a second layout of the same document is
   identical, which is what makes the preview screenshots and DOM counts reviewable.
6. **Degradation is drawn, not dropped.** A scope with an empty body is an `empty_body` compiler
   error, but a draft that has not compiled yet must still show the node — it degrades to a plain
   box rather than vanishing from the graph. A cyclic draft is broken by dagre's `acyclicer:
   "greedy"`; the renderer wraps layout in `safeLayout` so nothing thrown reaches the page.
7. **A node list beside the canvas is part of the design, not a fallback.** It carries dependencies,
   binding counts and the wire status verbatim; the canvas is `aria-hidden`-free but decorative
   edges are hidden from AT, because a polyline cannot state a condition's route and a hidden
   duplicate would be a second source of truth.
8. **Deferred kinds are drawn with a dashed edge and the milestone in words** (`not until M5`), so a
   document that M4 refuses renders as a document that M4 refuses (ADR-0024's refusal has to be
   *legible* to be useful).
9. The whole surface is **dev-only reachable today**: `/__m4-preview` is behind
   `import.meta.env.DEV` with a statically-folded `lazy()` import, and the production bundle
   contains no dagre and no fixtures (verified: `dist/assets` gains no `M4Preview` chunk and no
   fixture string).

## Consequences

- Positive: the graph panel costs ~17 kB gzip when it is eventually routed into the app, adds no
  runtime beyond a function call, ships zero CSS, and its nodes are ordinary buttons — focus order,
  `aria-pressed`, arrow-key movement and `check:testids` all work on it unchanged.
- Positive: the join between definition and run is one string rule (rule 3), which is also what
  `RunStageStrip` and `RunTree` use — the three surfaces cannot disagree about which row is which
  node, and `runView.test.ts` pins the rule.
- Limitation: no pan/zoom, no minimap, no edge labels. A § 9.3 sample lays out at **1824×172 px**
  against an 862 px-wide frame, so the canvas scrolls and a caption states the node/edge/px totals
  rather than letting a cut-off graph look complete.
- Limitation: dagre's cluster sizing ignores its own labels and our title bar, so group geometry is
  ours to keep right — if a future layout option changes `rankdir` or node size, rule 4's
  deepest-first pass is where that breaks.
- Limitation for M5: an editor that drags nodes needs its own position store (and per rule 5/ADR-0021
  that store must stay out of the canonical document), and edges that route around obstacles need a
  router dagre does not provide. Both are additive to this ADR, not a reversal: the *semantics*
  (rules 2, 3, 6, 8) survive a layout swap; only the numbers come from elsewhere.
- Backwards compatibility: nothing public changes. No API, schema, protocol or digest-scope field is
  touched; the UI reads route 13's document and route 24's rows as specified.

## Security/privacy

- The graph is a projection of data the viewer is already allowed to read; it performs no
  resolution of expressions or plans (`rootWords` names the declared roots of a binding verbatim,
  which is why quoted literals are blanked — a string containing the word `iteration` must not be
  reported as a root reference).
- Nothing worker-side reaches this surface: `worker_id`, `fencing_token` and `lease_expires_at` are
  refused by contract route 32 and are asserted absent from the DOM (W11), so a graph cannot leak
  placement internals.
- Layout is pure and synchronous over already-authorized JSON, so there is no fail-open path; a
  malformed or unreadable document renders "no graph" text instead of a guess.
- Dependency surface: one MIT package, no transitive runtime deps, no network, no filesystem, no
  fonts.

## Verification

- `ui/src/lib/pipeline/layout.test.ts` (14 tests): node keys and order, group containment
  (members inside the box, title bar above them), **entry/exit wiring including edges *inside* a
  scope body** (the seven-edge § 9.3 set asserted exactly — the bug this test caught was body
  `dependsOn` resolving against a cluster-prefixed key, so intra-body edges silently disappeared),
  determinism across two runs, canvas containment, empty-body degradation, cycle refusal.
- `ui/src/components/m4/DefinitionGraph.test.tsx` (12 tests): one box per concrete node, scope
  naming itself in words, kind name never a glyph alone (rule 06), two nodes sharing an id across
  scopes stay distinct and only the named one carries state, binding inspector with pointer and
  declared roots, canvas-size caption, node-list equivalence, arrow-key focus movement, deferred
  milestone words, degradation for a non-pipeline document, no throw on a cyclic document.
- Browser pass (dev server + `@playwright/test` chromium, 2026-10-15): preview renders 2 graphs /
  21 node boxes / 3 scope groups / 20 edges with **zero console errors or warnings**; forbidden
  fields and banned wording absent from `document.body.innerText`. Console evidence was captured by
  a script run against `http://localhost:5199/__m4-preview` (screenshots are not committed).
- Bundle evidence: `pnpm --dir ui build` emits `dist/assets/index-*.js` only (no `M4Preview`
  chunk), and `grep -rl "feature-development" dist/assets/` returns nothing — the fixtures and
  dagre are absent from what ships.
- Dependency evidence: `@dagrejs/dagre` 3.1.1, MIT (`dist/dagre.esm.js` = 48559 B raw,
  16954 B gzip), zero runtime dependencies.

## Migration/rollback

- Add: `@dagrejs/dagre` in `ui/package.json` + `ui/src/lib/pipeline/layout.ts`. Removing the
  dependency means deleting that module and the canvas branch of `DefinitionGraph`; the node list,
  the YAML panel and the run inspector are independent and keep working, because the graph is the
  only consumer of layout output.
- Replace (likely under M5): swap `layoutDefinition`'s internals for an editor-supplied position
  store or a different router while keeping `DefinitionGraphLayout`'s shape (rules 2, 3, 6, 8 are
  semantics and must move with it). Nothing outside `lib/pipeline/layout.ts` reads dagre types.
- Revisit if: definitions grow past ~40 concrete nodes (then pan/zoom and rank chunking), or an
  `edge labels` requirement arrives from the editor brief — both need an amendment here, not a new
  ADR, because neither changes the join rule or the cluster-edge rule.
