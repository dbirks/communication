# ADR-0043 — Run Workbench: graph-first default, shared `AgentConversationPanel`, deep-linkable URL state

- **Date:** 2026-10-19 · **Status:** Accepted · **Owners:** UI maintainer
- **Evidence:** issue #2 acceptance — [`docs/design/issue2-acceptance.md`](../design/issue2-acceptance.md) (A4–A6)
- **Related:** ADR-0016 (conversations, controller lock, turn leases), ADR-0023 (runs, node
  executions and attempts), ADR-0025 (definition graph layout), ADR-0042 (graph authoring),
  design checkpoint [`docs/design/studio-workbench.md`](../design/studio-workbench.md) §6 (issue #2)

## Context

Today `/projects/:projectId/runs/:runId` renders `pages/RunInspector.tsx`, which **defaults to
a Definition tab** and a stage strip + execution tree; the agent's real conversation is buried
inside the selected attempt detail, and `pages/Conversation.tsx` (transcript, composer,
controller handoff) is a separate page. Issue #2's acceptance walkthrough requires the
opposite: the default view is a **large live execution graph**, and selecting an ACP node
shows **its real streaming conversation beside the graph**, with Take control / Return to
factory working in place.

Two problems force the shape of the solution:

1. **Definition ≠ instance.** The definition graph is small and immutable for the life of a
   run (pinned revision); the execution tree is potentially enormous (a `for_each` over 25
   items with retries). Drawing instances as extra nodes would fabricate hundreds of
   definition nodes — forbidden by issue #2 ("do not fabricate hundreds of distinct
   definition nodes") and inconsistent with ADR-0023, which models runs, node executions and
   attempts as journal rows, not graph nodes.
2. **Two chat surfaces already exist.** `Transcript.tsx` / `pages/Conversation.tsx` and the
   attempt-detail conversation fragment both wrap the same conversation APIs
   (`useConversation`, `useConversationEvents`, permission decisions, take/return control —
   ADR-0016). A second, dock-sized chat component would drift from the controller semantics
   and the permission UI.

## Decision

1. **Graph-first default.** `Run Workbench` replaces the `RunInspector` default at
   `/projects/:projectId/runs/:runId`: a large live graph = the **definition's topology**
   (ADR-0025 layout, read-only React Flow surface from ADR-0042) with text/icon status
   overlays computed from the run's node executions and the SSE `/runs/{id}/events` stream.
   Scope boxes show instance counts (`iteration 2 of 4`, `25 items: 22 ✓ 2 ⟳ 1 ✗`).
   **Runtime instances are selected through selectors, never drawn as extra definition
   nodes**: iteration chips for `until`, a paged state-filterable item list for `for_each`,
   attempt tabs for retries. The full instance tree remains available on the **Execution tree**
   tab.
2. **One shared `AgentConversationPanel`** (new component, in `components/`) wraps the
   existing `Transcript` + conversation/permission/control hooks for both consumers: the
   Workbench dock and `pages/Conversation.tsx`. It contains transcript, permission cards, the
   composer **only when the caller holds/may take control** (ADR-0016 controller lock, never
   widened), `Stop`, `Take control`, `Return to factory`, and an `Open full conversation`
   link. The full Conversation page keeps its own rail; the panel is the shared surface, not
   a fork.
3. **Right dock.** Resizable, collapsible; under 1024px the detail becomes a full page sheet.
   Dock content is keyed by node kind: `agent.acp` → the panel; `process.exec` →
   stdout/stderr tail + outputs + artifacts; `human.approval` → the existing
   `ApprovalCard`; failed/retrying → error, `attempt n of m`, evidence, checkpoint
   consequence.
4. **Auto-select rule.** On load, select the first node needing attention (failed,
   `waiting_human`, retrying), else the running node. **After the user clicks, the view
   never moves the selection** — SSE events update badges and counts only.
5. **The old inspector is preserved as the `Diagnostics` tab** together with `Timeline` and
   `Execution tree` tabs; nothing the old inspector showed is deleted (testids preserved per
   the repo rule).
6. **URL state**: `?node=<definitionNodeId>&instance=<nodeExecutionId>&attempt=<n>&view=
graph|timeline|tree|diagnostics`. Selection is derived from the URL on load, so
   conversations can deep-link back to their exact run/node/attempt and links are shareable;
   view changes update the query string via the router.

## Consequences

- `RunInspector.tsx` becomes a thin shell over the tabs; its existing components
  (`RunTree`, `AttemptDetail`, `DefinitionGraph` read-only render) are reused, not rewritten.
- The Workbench graph is read-only: no `graphDoc` ops here — editing a pipeline from a run
  goes through `New draft from this revision` (new draft, normal Studio editing). A live
  graph-rewriting editor over a running run is explicitly out of scope (pinned revisions
  cannot mutate).
- Live-data honesty (issue #2): all state shown comes from the execution journal / SSE; on
  stream reconnection or replica change the dock re-derives from REST — the UI never claims
  restored state the backend did not confirm.
- One more consumer of the conversation hooks means the take/return-control and permission
  cards get exercised from two surfaces; their existing tests (ADR-0016) plus a dock-level
  browser test cover the new path.
- New `data-testid`s added freely for dock, selectors and badges; no existing testid is
  removed.

## Alternatives

| Option | Advantages | Disadvantages |
|---|---|---|
| **A (chosen)** — definition topology + status overlays + selectors + shared panel + URL state | matches ADR-0023's data model; one chat surface; deep-linkable; old views preserved as tabs | the dock needs a kind-keyed content switch; auto-select must be disciplined |
| B — draw every node execution/attempt as its own graph node | maximal fidelity of the instance tree | fabricates hundreds of nodes (for_each/retries), conflates definition and run (issue #2 forbids), and breaks the pinned-revision invariant visually |
| C — keep the Definition tab default and lift the conversation to a side panel | smallest diff | fails the issue's defining acceptance ("default Run Workbench is graph-first… clicking an ACP node reveals its live conversation directly beside the graph"); the stage-strip/tree layout fights the same job worse |
| D — fork a second, dock-sized chat component | isolated from the page's rail | two diverging implementations of ADR-0016 control/permission semantics — the drift the issue explicitly warns against ("do not create a second incompatible chat product") |

## Verification

- Unit: status-overlay derivation from a fixture run (definition + node executions + attempts)
  picks the right badges, scope counts and auto-select target; the selectors (iteration chip /
  item list / attempt tab) map to the right `node_execution` rows.
- URL-state test: loading `?node=…&instance=…&view=timeline` restores the exact selection and
  tab; changing selection updates the query.
- Browser pass (ADR-0006, recorded under `~/.cache/communication-lab/issue2/`): start a seeded
  run; default view is the live graph with the active node highlighted; clicking the ACP node
  shows the streaming transcript; a permitted user takes control, sends a prompt, returns
  control — graph, transcript and timeline stay in sync; a read-only member sees no composer
  and no `Take control`. `workbench-acp-conversation.png` and `workbench-for-each-children.png`
  are recorded, plus a narrow-width sheet shot.
- `pnpm --dir ui check` green (including `check:testids` — no removed testids).

## Addendum: return-to-factory while a human turn is running

`d8e66b7` — surfaced by the issue #2 takeover journey (2 of 3 live runs failed) and recorded in
`docs/design/issue2-acceptance.md` (A5, "Bugs found and fixed BY the acceptance journeys"). When a
human takes control of a running agent attempt and then returns control to the factory **while the
human's own turn is still active**, the retried agent attempt's claim no longer fails the run:
the claim waits — bounded, while it holds its lease — for the conversation's active human turn to
finish, instead of failing on the run-contract's one-active-turn pairing (contract § 4 step 12).
ADR-0016 § 5 forbids cancelling the human's turn, and the contract defines no 409 for
return-control, so waiting is the only semantics consistent with both.
