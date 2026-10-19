# Workflow Studio + Run Workbench — design checkpoint (issue #2)

Status: **design checkpoint** for issue #2 ("graph-first Workflow Studio, live Run Workbench,
integrated agent conversations"). This document is the checkpoint delivery of the issue's
"Delivery approach" step 1; the ADRs it commits to are ADR-0042 (graph authoring libraries and
text→text graph ops), ADR-0043 (graph-first Run Workbench) and ADR-0044 (assistant draft
proposals).

Constraints that shape everything below (from issue #2):

- Published revisions stay immutable; every edit lands through the existing
  `PUT /api/v1/drafts/{id}` / `POST …/validate` / `POST …/publish` contracts, and every run
  stays pinned to the revision that launched it.
- Canonical YAML is the single source of truth. The graph is an alternate authoring surface
  over the same schema — never a frontend-only graph with different semantics than the compiler.
- Loops are bounded composite scopes (`until`, `for_each`); the definition graph and the
  possibly enormous execution-instance tree are different objects.
- The graph library is an interaction layer, not a workflow engine.
- Reuse, never duplicate: `Transcript`, `pages/Conversation.tsx`, `components/m4/*`,
  `components/ds/*`, `lib/pipeline/{definition,layout,nodeFields,yamlPointer}.ts`.
- Styling from `ui/src/styles/tokens.css` only; no existing `data-testid` is removed.

## 1. Gap analysis

Wireframes §6 promised **palette | canvas | inspector** with a draft header
(`Save / Validate / Publish`, YAML view, JSON-Schema-driven inspector). What shipped:

- `DefinitionGraph.tsx` — a **read-only SVG** definition graph (dagre compound layout, ADR-0025);
  no node creation, no edge insertion, no drag, no scope editing.
- `DraftEditor.tsx` — a **YAML textarea** with a per-node scalar form; complex scopes and
  connections are YAML-only; no graph surface at all.
- `RunInspector.tsx` — defaults to a **Definition** tab and a stage strip + execution tree; the
  agent conversation is **buried inside the selected attempt detail**, not the primary content.

| Intent (issue #2 / wireframes) | Shipped today | This effort |
|---|---|---|
| Palette / canvas / inspector authoring (§6) | read-only SVG graph + YAML textarea | Workflow Studio: palette + React Flow canvas + schema-driven inspector (§3) |
| Insert on an edge, drag-to-insert, connect, delete, undo/redo | none | `graphDoc.ts` pure text→text ops + gesture layer with ambiguity rules (§3, §4) |
| Repeat-until scope container with recurrence marker | scope box rendered read-only | editable scope box, wrap action, illustration-only arrow (§3.5) |
| Graph ↔ YAML round trip, invalid-YAML diagnostics | one-way (YAML in, graph out) | bidirectional, comment-preserving, last-good graph on parse error (§5) |
| Graph-first live run view with the ACP conversation beside the graph | Definition-tab default; conversation inside attempt detail | Run Workbench: live graph default + shared `AgentConversationPanel` dock (§6) |
| One-off ACP conversations, discoverable and labeled | conversations exist but are hard to find, no manual/run badge | project-header + Conversations-tab + global `New ▾` entry; Manual vs From-run badges (§7) |
| Assistant edits the draft with a visible, reviewable proposal | read-only assistant (ADR-0034) | `POST /assistant/draft-proposals`, closed op set, canvas highlight, Apply/Discard (ADR-0044, §8) |

## 2. Information architecture

Top navigation keeps the existing URLs, relabels `/library`, and adds a global `New ▾` menu:

```
Inbox · Projects · Workflows · Agents · Operations      [ New ▾ ]  [search ⌘K]
                                   (label for /library)
```

- **`New ▾`** (global, user menu): *New conversation* (project picker required — §7),
  *New workflow* (→ `/library` new-draft flow), *Start run* (project + assignment picker).
- **Project header actions**: `Start run` and `New conversation`.
- **Project tabs**: Overview · Runs · Conversations · Workflows · Artifacts · Settings.
- Old URLs stay valid. `/library/:pipelineId?draft=<id>` **redirects** to the Studio route
  `/library/:pipelineId/drafts/:draftId`; `/drafts/:draftId` (wireframes §6) keeps working via
  the same redirect rule.

## 3. Workflow Studio — `/library/:pipelineId/drafts/:draftId`

### 3.1 Layout

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ Draft: Feature Delivery   draft v12 · ✓ validated (0 findings) · [Canvas][YAML]          │
│ [Undo][Redo]  [Save]  [Validate]  [Diff]  [Publish]      Ask to change this draft… ▸      │
├──────────────────┬───────────────────────────────────────────────┬──────────────────────┤
│ Palette          │ Canvas (React Flow: zoom / fit / pan)         │ Inspector            │
│ Search nodes…    │   ┌────────┐   ┌─────────┐  ┌──────────────┐ │ node: review         │
│ ┌──────────────┐  │   │ plan   │─▶│ approve │  │ until (max 4)│ │ kind condition       │
│ ▸ Coding agent │  │   └────────┘   └─────────┘  │ ┌──────────┐│ │ cases:              │
│ ▸ Ask a model  │  │                         │ │ │ implement││ │  when: tests == ok   │
│ ▸ Run command/ │  │                         │ │ └──────────┘│ │  route: pass         │
│   tests        │  │                         │ │   │        │ │ default: fail         │
│ ▸ Human appr.  │  │                         │ │   ▼        │ │                      │
│ ▸ Condition    │  │                         │ │  review ──▶ │ │ [Edit prompt]        │
│ ▸ Repeat until │  │                         │ └──────────────┘ │ [Open YAML @node]    │
│ ▸ For each     │  │                         └                  └──────────────────────┘
│ ▸ Call pipeline│  │                                        │
│ ▸ Publish artf │  │                                        │
│ ─ Not runnable ─│  │                                        │
│ ▸ parallel …   │  │                                        │
└──────────────────┴───────────────────────────────────────────────┴──────────────────────┘
```

Palette labels are approachable names with the kind as secondary text:

| Label | Kind |
|---|---|
| Coding agent | `agent.acp` |
| Ask a model | `model.chat` |
| Run command / tests | `process.exec` |
| Human approval | `human.approval` |
| Condition | `condition` |
| Repeat until | `until` |
| For each | `for_each` |
| Call pipeline | `pipeline.invoke` |
| Publish artifact | `artifact.publish` |

`parallel`, `join`, `gate`, `git.commit`, `git.publish`, `integration.query`,
`integration.action` (the `DEFERRED_KINDS` set in `lib/pipeline/definition.ts`) render in a
separate **"Not runnable yet"** group, greyed, with that label in the inspector too — never made
to look selectable-as-runnable.

### 3.2 Gestures

- **`+` on every edge and after terminal nodes** → searchable node picker; choosing an item
  inserts the node at exactly that location (the safety rules of §4 decide whether it may).
- **Drag a palette item over an edge** → the edge highlights with a split preview
  (`A → NEW → B`); drop rewrites `A→B` into `A→NEW→B` atomically, preserving node ids and
  unaffected bindings.
- **Connect by dragging** from a node's bottom handle to another node's top handle.
- **Delete key** removes the selected node (with a confirmation dialog naming the downstream
  nodes that will lose a dependency) or edge.
- **Undo/Redo**: `Ctrl/Cmd+Z` / `Shift+Ctrl/Cmd+Z` over `{text, ui_layout}` snapshots (§5).
- **Zoom / fit / pan** on the canvas.
- **Accessible "Steps" list**: a keyboard alternative for every gesture — an ordered,
  focusable list of nodes and edges in each scope with add/insert/delete/wrap actions; `Tab`
  walks palette → canvas nodes (focusable, arrow-navigable) → inspector (wireframes §6 keyboard
  contract).

### 3.3 Inspector

Schema-driven from the node's kind (build from the canonical schema via
`lib/pipeline/nodeFields.ts`): profile/launcher, APM package & skills, prompt, timeout/retries,
failure routing, bindings, secrets, per-kind fields. Unknown schema shapes fall back to a JSON
editor with a warning, never silently hide a field. A `pipeline.invoke` node shows the pinned
revision, never "latest". Configuring a reusable **Agent Profile** is a separate linked action,
visually distinguished from overriding this step.

### 3.4 Starting point

New drafts and starter workflows land on a usable **graph**, not a YAML textarea (wireframes §6,
issue #2 "Try / Clone / Customize").

### 3.5 Repeat-until / For-each scope boxes

`until` and `for_each` render as **bordered scope boxes** titled, e.g.,
`repeat until outputs.tests.passed · max 4 iterations · max 30m` (until) or
`for each <source> · 25 items` (for_each), with their body's steps inside
(`config.body.nodes[]` / `config.branches[].nodes[]`). A recurrence arrow is drawn **inside the
box as a UI illustration only — it is never serialized** into the YAML. An empty body shows
`+ Add step inside`. **Wrap**: select 1..n sibling steps → `Wrap in Repeat until` /
`Wrap in For each` produces the scope with the selection as the body (`wrapInScope` op).

## 4. Edge semantics and the ambiguity rule (core safety rule)

An edge `A→B` exists **iff `B.dependsOn` contains `A`** — there are no edge objects in the
schema. `insertOnEdge(A→B, NEW)` rewrites `B.dependsOn: [A, …]` to `[NEW, …]` and adds
`NEW.dependsOn: [A]`.

**Insert on `A→B` is SAFE only when all of the following hold:**

1. `A` and `B` are in the **same scope** (`dependsOn` never crosses a scope boundary);
2. `B` has **no `when`** CEL guard;
3. `A` is **not** a `condition` node (its downstream edges encode route guards);
4. the edge is **not** an error route (`onFailure.errorRoute`);
5. `B`'s `config` does **not** bind `nodes.A.*`.

If any of 2 or 5 fails, the UI shows a **dialog naming the exact reason** — e.g.
`"B only runs when nodes.check.outputs.route == 'pass'"` or
`"B reads nodes.A.outputs.x"` — with exactly two choices: **Insert and keep B's condition/
bindings as-is** (A remains an ancestor so bindings still resolve, but B loses its *direct*
dependency — we refuse to silently rewire and instead ask) or **Cancel**. Rules 1 and 4 are
hard rejections with a message: cross-scope and error-route edges cannot be split.

**Connect (drag a new edge) refuses, each with an on-canvas explanation:**

| Refusal | Message names |
|---|---|
| Self-edge | the node itself |
| Cycle | the existing path that would be closed |
| Cross-scope | the two scopes involved |
| Duplicate edge | the existing `A→B` |

No gesture ever writes YAML the compiler would interpret differently than the compiler does.

## 5. Graph ↔ YAML synchronization

- **The YAML text is the source of truth.** Graph edits are pure functions
  `text → text` in `ui/src/lib/pipeline/graphDoc.ts`, using the `yaml` package's Document API
  so comments and unrelated formatting survive (ADR-0042). Ops: `addNode`, `insertOnEdge`,
  `connect`, `delete`, `wrapInScope`, `updateConfig`.
- **Valid YAML** refreshes the graph. **Invalid YAML** keeps the user's text, shows the parse
  diagnostic, and the canvas renders the **last good graph greyed** with the banner:
  *"YAML has errors — the canvas shows the last valid version; graph editing is paused."*
  No work is discarded; graph editing is paused, not lost.
- **Positions** live in the draft's `ui_layout` (`{nodes: {<scopePath/id>: {x,y}}}`) —
  `metadata.ui`-style layout metadata **excluded from the revision digest** (ADR-0042 §2).
  Saving a position never changes execution semantics.
- **Undo/redo** = a stack of `{text, ui_layout}` snapshots; the stack is in-memory per session.
- **Stale draft (HTTP 409 `stale_draft_version`)** → banner with **Reload theirs** /
  **Keep mine and overwrite** (re-PUT with the new version). Never silent, never "restored"
  claims about edits the server never saw.
- **Save/Validate/Publish** hit the existing endpoints unchanged; Publish stays disabled while
  server validation reports findings, with the reason in text, not just hover.

## 6. Run Workbench — `/projects/:projectId/runs/:runId` (default view)

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ Project A / Feature Delivery (r-482) · goal "Split billing by tenant"                    │
│ revision 8f2c1a… (pinned) [Open pinned workflow] [New draft from this revision]          │
│ running · 3h 22m   [Pause][Resume][Cancel]        view: (●)Graph ( )Timeline ( )Tree ( )Dx│
├───────────────────────────────────────────────────────────────┬──────────────────────────┤
│ Live graph (definition topology + status overlays)            │ Right dock (resizable,    │
│  ┌────────┐  ┌─────────┐  ┌───────────────────────────────┐  │  collapsible; full sheet  │
│  │ plan ✓ │─▶│approve✓ │─▶│ until: iteration 2 of 4       │  │  under 1024px)            │
│  └────────┘  └─────────┘  │  implement: 25 items           │  │ ┌ kind: agent.acp ──────┐ │
│                          │  22 ✓ · 2 ⟳ · 1 ✗               │  │ │ Transcript (live)     │ │
│                          │  review ⟳ (running)  test ✗     │  │ │ Permission cards      │ │
│                          └──────────────────────────────────┘ │ │ Composer (if control-  │ │
│                                                               │ │  ler), Stop, Take/    │ │
│                                                               │ │  Return control, Open │ │
│                                                               │ │  full conversation    │ │
│                                                               │ └────────────────────────┘ │
└───────────────────────────────────────────────────────────────┴──────────────────────────┘
```

- **Header**: project, run title/goal, pinned-revision link, status, Pause/Resume/Cancel,
  `Open pinned workflow`, `New draft from this revision`. The workbench is **not** a live
  graph-rewriting editor.
- **Live graph**: the *definition's* topology with text/icon status overlays from the run's
  node executions (the authoritative execution journal). Scope boxes carry instance counts:
  until → `iteration 2 of 4`; for_each → `25 items: 22 ✓ 2 ⟳ 1 ✗`. Runtime instances are
  **selected through selectors, never drawn as extra definition nodes** (ADR-0043).
- **Dock content by kind**:
  - `agent.acp` → the **live conversation** via the shared `AgentConversationPanel`:
    transcript, permission cards, composer only when the caller may control, `Stop`,
    `Take control`, `Return to factory`, `Open full conversation`.
  - `process.exec` → stdout/stderr tail, outputs, artifacts.
  - `human.approval` → the existing `ApprovalCard`.
  - failed/retrying → error, `attempt n of m`, evidence, checkpoint consequence.
- **Instance selectors**: iteration chips for `until`; a paged, state-filterable item list for
  `for_each`; attempt tabs for retries.
- **Auto-select**: on load select the first node needing attention, else the running node;
  **never move selection after the user clicked**.
- **Secondary tabs** keep the old views: **Timeline**, **Execution tree**,
  **Diagnostics** (the previous inspector).
- **URL state**: `?node=<definitionNodeId>&instance=<nodeExecutionId>&attempt=<n>&view=graph|
timeline|tree|diagnostics` — conversations deep-link back to their exact run/node/view with a
shareable URL.

## 7. One-off ACP conversations

- **Entry points**: project header `New conversation`, the project **Conversations** tab, and
  the global `New ▾` menu (with a project picker). No pipeline and no synthetic one-node
  pipeline are required.
- **Dialog fields**: project, agent profile, title, first prompt.
- **List**: a `Manual` vs `From run <title> · <node>` badge on every conversation, plus a
  search box.
- A run-linked conversation links back to `/projects/:p/runs/:r?node=…&instance=…`; a manual
  conversation shows no fictional graph.

## 8. Assistant drafting slice (ADR-0044)

In Studio, the draft header's **"Ask to change this draft…"** box submits
`POST /api/v1/assistant/draft-proposals {draft_id, version, instruction}`. The server (the
caller must be allowed to `PUT` that draft) asks the model for **one operation from a closed
set**: `insert_after {after, kind, id, config}`, `insert_on_edge {from, to, kind, id, config}`,
`update_prompt {node, prompt}`. Node ids are validated against the draft; the server **returns
the proposal without writing anything**. The UI applies the same `graphDoc` op locally,
highlights the changed nodes with `data-highlight="assistant-proposed"` and the caption
*"Assistant proposed this change — review, then Apply or Discard"*. **Apply** = the normal
version-checked `PUT`; **Discard** reverts. The assistant **never publishes**, and no second,
unvalidated YAML generator exists.

## 9. Responsive

| Surface | ≥1024px | <1024px | <640px |
|---|---|---|---|
| Studio | palette + canvas + inspector | **step outline + focused inspector, no canvas** | step outline + inspector (single column) |
| Run Workbench | graph + right dock (resizable) | graph, then dock as a **full-width sheet** | **step list with states** instead of the canvas; dock is a full page sheet |

Mobile contract (wireframes §13, unchanged): a stalled run stays **actionable** on mobile
(approve, take control, retry); graph authoring is desktop-only. The `<640px` Workbench step
list preserves those actions next to each step.

## 10. Mockups and evidence

Static mockups (another worker authors these; realistic content, real interaction states, not
placeholder dashboard cards):

- [`docs/design/mockups/studio.html`](mockups/studio.html) — Studio with a multi-step workflow,
  an edge-insert preview and an until-scope box.
- [`docs/design/mockups/workbench.html`](mockups/workbench.html) — active Run Workbench with a
  running ACP node and the conversation dock.
- [`docs/design/mockups/new-conversation.html`](mockups/new-conversation.html) — one-off
  conversation dialog + list with Manual/From-run badges.

Screenshots recorded under `~/.cache/communication-lab/issue2/` as the implementation lands
(browser-verified per ADR-0006): `studio-insert-edge.png`, `studio-until-wrap.png`,
`studio-yaml-invalid-banner.png`, `studio-assistant-proposal.png`, `workbench-acp-conversation.png`,
`workbench-for-each-children.png`, `workbench-mobile-steps.png`,
`new-conversation-dialog.png`, `new-conversation-list.png`.
