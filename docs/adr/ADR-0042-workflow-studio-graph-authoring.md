# ADR-0042 — Workflow Studio graph authoring: `@xyflow/react` for interaction, `yaml` for comment-preserving text→text edits

- **Date:** 2026-10-19 · **Status:** Accepted · **Owners:** UI maintainer; pipeline schema maintainer
- **Evidence:** issue #2 acceptance — [`docs/design/issue2-acceptance.md`](../design/issue2-acceptance.md) (A1–A3, A8)
- **Related:** ADR-0005 (frontend toolchain), ADR-0021 (v1alpha1 schema, revision digests —
  `metadata.ui` excluded), ADR-0025 (dagre compound layout for the read-only definition graph),
  design checkpoint [`docs/design/studio-workbench.md`](../design/studio-workbench.md) (issue #2)

## Context

Issue #2 makes the interactive graph the primary surface for authoring a pipeline draft.
ADR-0025 shipped a **read-only** definition graph: dagre computes a compound layout
(scopes as subgraphs, edges to leaf nodes only) over `lib/pipeline/definition.ts` +
`lib/pipeline/layout.ts`, rendered as HTML nodes over an SVG edge layer. Authoring needs
handles, edge hover, drag-to-insert, node/edge selection and deletion, keyboard focus and
zoom/fit/pan — interactions that hand-rolling in raw SVG (the ADR-0025 approach) would mean
rebuilding, untested, a whole input layer, while the layout rules ADR-0025 pins would be
threatened.

The issue and the design checkpoint constrain the choice: the graph library must **not become
a workflow engine** (no layout-derived semantics, no node-type behaviour), positions must be
presentation state **outside the revision digest**, and every edit must land as valid
canonical YAML — comments and unrelated formatting included — through the existing
version-checked draft contract.

Two libraries are therefore in play for two different jobs:

| Job | Candidate | Role |
|---|---|---|
| graph **interaction** (handles, edges, drag, selection, viewport, a11y focus) | `@xyflow/react` 12.12.0 (React Flow, MIT) | interaction layer only |
| **layout** | dagre (already in `lib/pipeline/layout.ts`, ADR-0025) | unchanged; the layout engine |
| **document edits** | `yaml` 2.9.1 (eemeli/yaml, MIT) | Document API: parse to a node tree, mutate, serialize back so comments survive |

**New dependencies (flagged here, both MIT):** `@xyflow/react` 12.12.0 and `yaml` 2.9.1.
Neither is required by the spec; both are project-owner choices and this ADR is therefore
`Proposed` until its Verification section is exercised (README policy).

## Decision

1. **`@xyflow/react` 12.12.0 is the interaction layer of Studio and the Run Workbench graph.**
   Nodes are React components wrapping the existing m4 node rendering; edges render from
   `dependsOn` (edge `A→B` exists iff `B.dependsOn` contains `A`). dagre remains the layout
   engine: the ADR-0025 compound layout (edges to leaf nodes, scope boxes) feeds
   initial/automatic positions; user moves override per-node in the document's
   `metadata.ui` only (ADR-0042 §3).
   **The library never runs anything**: no node types execute, no store derives pipeline
   semantics, no graph state is sent to the server.
2. **Graph ops are pure functions `YAML text → YAML text` in `ui/src/lib/pipeline/graphDoc.ts`**
   (`addNode`, `insertOnEdge`, `connect`, `delete`, `wrapInScope`, `updateConfig`). Each op
   mutates a `yaml` Document node tree and re-serializes, so comments and untouched regions
   survive. The rendered graph is always derived from the text — the library's internal state
   is never the source of truth.
3. **Node positions and viewport are saved in the document's `metadata.ui` block**
   (shape `{nodes: {<scopePath/id>: {x,y}}}`) — the non-semantic layout metadata that
   ADR-0021's digest excludes. A non-semantic move changes the draft text but no
   execution behaviour and no revision digest. **The draft's `ui_layout` column/field is
   not used by the Studio**: the draft PUT body is exactly `{document_yaml, version}` and
   the live server never fills `ui_layout` from it (the pipeline store is built without
   an `ExtractUI` hook, `cmd/communication/serve.go`), so the client keeps the layout in
   the canonical document instead and re-reads it out with `uiLayoutOfText` when the
   served `ui_layout` is empty.
4. **The ambiguity rules of `studio-workbench.md` §4 are enforced in `graphDoc.ts`, not in
   the rendering layer.** `insertOnEdge(A→B, NEW)` is safe only when: same scope; `B` has no
   `when`; `A` is not a `condition` node; the edge is not an `errorRoute`; and `B`'s config
   binds no `nodes.A.*`. Violations either refuse (cross-scope, error-route) or force an
   explicit user dialog naming the reason. `connect` refuses self-edges, cycles, cross-scope
   and duplicates, each with a reason string the UI displays. The same predicates are unit
   tested against YAML fixtures.
5. **Invalid-YAML policy**: ops are applied to text; a parse failure keeps the user's text,
   shows the diagnostic, and the canvas renders the last good graph greyed (graph editing
   paused). Undo/redo is a stack of `{text, ui_layout}` snapshots, where the layout is the
   in-memory view of the document's `metadata.ui` (it is always derivable from the text,
   so the stack is in-memory per session).

## Consequences

- Two more npm dependencies in `ui/` (flagged above); `pnpm --dir ui` frozen-lockfile adds
  both at the pinned versions.
- ADR-0025's layout tests keep passing unchanged: dagre's output contract is untouched;
  React Flow consumes positions the way the old SVG layer did.
- `graphDoc.ts` is the single place where YAML is mutated by the UI; every edit is reviewable
  as text→text (the Diff tab shows the exact delta), which makes the §4 rules auditable in
  tests without a browser.
- The digest-excluded `metadata.ui` now carries real data (positions). Digest stability
  is pinned by a test: saving a move-only change to `metadata.ui` must not change the
  `revision_digest` Validate reports for unchanged spec content. Observable proof in the
  lab (probe in `/tmp/pi-logs/adr42/probe.py` against the m4 stack, 2026-10-19): validate →
  `sha256:64433c7aedc981697fa2b8112644e0dd819a64919dd68cddf92e32b261132dda`; move node
  `plan` (`x: 12` → `x: 52`) and save; validate again → the same digest.
- The `ui_layout` column stays empty for Studio-authored drafts; anything that does
  populate it (a future `ExtractUI` wiring) must remain digest-excluded and non-semantic.
- `@xyflow/react` ships its own CSS; it is imported once at the Studio/Workbench entry and
  scoped under the existing tokens (no new colour names — `check:tokens` still passes).
- The run page (ADR-0043) renders the *same* React Flow surface in read-only mode with status
  overlays — one interaction library, two consumers.

## Alternatives

| Option | Advantages | Disadvantages |
|---|---|---|
| **A (chosen)** — `@xyflow/react` 12.12.0 interaction + dagre layout + `yaml` Document ops | issue #2 explicitly names React Flow as the library to evaluate; mature handles/edges/a11y; keeps ADR-0025's dagre rules; `yaml`'s Document API is the only common tool that preserves comments through programmatic edits | two new dependencies; React Flow's state must be disciplined away from semantics (decided: it renders derived state only) |
| B — extend ADR-0025's raw-SVG layer with hand-rolled handles/drag/zoom | zero dependencies | rebuilds an untested input layer (pointer math, hit testing, keyboard, zoom) exactly where ADR-0025's read-only SVG already showed its limits; slow and regress-prone |
| C — ELK for layout instead of dagre | more layout options | dagre already satisfies ADR-0025's compound layout and its tests; switching buys nothing this issue needs and churns a stable module |
| D — store a JSON graph alongside YAML and sync both | simpler op code | two sources of truth, a sync bug class, and a second canonical-ish artifact the compiler does not read — violates issue #2 constraint 2 outright |

## Verification

- `ui/src/lib/pipeline/graphDoc.test.ts`: for every op, YAML fixtures in → exact YAML out
  (comments preserved — a `# keep me` comment survives `insertOnEdge`), plus one
  round-trip test per §4 rule (safe insert; refused cycle; refused cross-scope; condition-edge
  dialog path; `nodes.A.*`-binding dialog path).
- `pnpm --dir ui check` (gen:api:check, oxlint, oxfmt, tsc, `check:testids`, `check:tokens`,
  vitest, build) green with both dependencies in `ui/package.json` at the pinned versions.
- Browser pass (ADR-0006, recorded under `~/.cache/communication-lab/issue2/`): insert a node
  on an edge in Studio, save, publish; reopen the draft and the graph matches. A stale-draft
  (409) banner path is exercised.
- Digest test: a save that only changes the document's `metadata.ui` leaves the
  `revision_digest` unchanged (observed in the lab — see Consequences).
