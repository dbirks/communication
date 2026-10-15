# Component inventory and interaction specifications

Each component lists: purpose, data it may read (never invents), states, interactions, keyboard and
accessibility behaviour, and the `data-testid` it must expose. Components marked *(shipped)* exist in
`ui/src/components/` and are extended, not replaced; their existing testids are frozen.

Global rules (apply to every component; derived from `10` and the shipped code):

1. **Status is never colour-only.** Every status control pairs a token colour with a word
   (`✓ ready`, `✗ failed`, `⚠ waiting 3d 4h`). Icon + text, never icon alone.
2. **Loading / empty / error / denied are four distinct states**, and denied renders exactly like
   missing (`404` "not found or you do not have access" — ADR-0014 §3). No component renders a
   bespoke fourth state.
3. **Optimistic state is only allowed for reads the server already authorised.** Mutations never
   fake a result: the control flips to a pending label ("Taking…") and the authoritative value comes
   back from the response or the stream (ADR-0016 §9). On a `409`, the returned state is *adopted*.
4. **Disabled controls explain themselves** via `aria-describedby` text that is also visible to
   sighted users (pattern shipped as `⟨T:composer-explainer⟩`).
5. **Every number has a unit and a source**; every timestamp renders `HH:MM:SS UTC` plus a relative
   age (`3d 4h`) — the shipped `formatTime` convention, extended with relative age.
6. **No raw secret, no absolute host path, no cross-project name** ever appears in a prop, tooltip,
   placeholder, `aria-label` or empty-state string.

---

## A. Primitives

### `StatusWord` *(pattern, shipped inline in `Operations.tsx`)*
Word + glyph + token-coloured text for any enum: `run.status`, `node.execution_status`,
`business_outcome`, `conversation.status`, `turn.status`, worker `status`, `sensitivity`,
`enforcement`.
- Props: `value`, `tone` (`neutral|ok|warn|bad|info`), `detail?`, `live?: boolean`.
- `role="status"` + `aria-live="polite"` when `live`, otherwise plain text (a screen reader must not
  re-announce a static table column 25 times).
- Testid: `status-<value>`; table cells keep `⟨T:activity-status⟩`-style names where shipped.

### `ProblemBanner` / `FormError` / `Spinner` *(shipped, `Feedback.tsx`)*
- Unchanged. `FormError` remains the single renderer of problem+json (`type`, `title`, `status`,
  `detail`), with `role="alert"`.
- Addition: `ProblemBanner` accepts an optional `recovery` node (a link or button) so every failure
  names the next action (`10` J1 "errors and prerequisites should not be hidden").

### `TokenField` (`⟨T+token-field⟩`)
Read-only monospace value with a copy button and a *meaning* caption: event ids, digests, shas,
fencing tokens, policy digests, control versions.
- Never truncated below 8 chars without an expand control; copy writes the full value.
- Digests are links to the immutable revision; ids are links to their detail screen.

### `AgeLine`
`started 13:58:02 UTC · 3h 22m ago` with `datetime` on the `<time>` element.
- Counts **up** for running work and **down** for deadlines, labelled either way
  ("waiting 3d 4h" vs "expires 00:41"). A ticking countdown is `aria-hidden` with a static text
  alternative updated every minute (screen readers get a polite sentence, not a metronome).

### `Tabs` (`⟨T+tabs⟩`)
Router-driven tab strip. ARIA `tablist` only when panels share scroll/focus context (Run inspector
modes); otherwise a `nav > ul` of `NavLink`s (project detail, ops) — because router navigation is a
page change, not a tab panel swap, and mis-announcing it is worse than no `tablist` at all.
- `aria-current="page"` on the active item (shipped `Shell.tsx` convention).
- Keyboard: `Tab` into the strip, arrow keys move focus *and* activate (single-actionable pattern is
  wrong here because activation is navigation).

### `Dialog` / `Drawer` / `Popover` (`⟨T+dialog-*⟩`)
- Focus trap, `Esc` closes, focus returns to the opener, title via `aria-labelledby`, description via
  `aria-describedby`. Body scroll locked. Confirm-destructive variant requires typing nothing —
  it names the consequence instead (an "unpause will start 12 queued child runs" style sentence),
  because typing `DELETE` for a pipeline action is theatre.
- Drawers (editor inspector, run detail) are `role="dialog"` on mobile, plain regions on desktop.

### `ToastHost`
Non-blocking confirmations only ("Draft saved", "Control returned"). Errors are never toasts alone —
they also render inline where they can be acted on (shipped behaviour: `FormError` inline).

---

## B. Attention / inbox

### `AttentionGroup` (`⟨T+attention-group-<kind>⟩`)
Sections: `needs-decision`, `stuck`, `open-turns`, `quiet`. Rows are `Link`s with a status word, an
`AgeLine`, the project name and a single verb.
- `kind` order is fixed (decision → stuck → open turns → quiet).
- Within a group, sort is user-selectable (`age|project|actor`) and persisted in the URL query so the
  view is shareable.
- Empty group renders "0 open approvals" rather than disappearing — silence is ambiguous
  (J2's whole point is that *nothing* here must be silently missing).
- If the aggregate source is unavailable: `StatusWord value="unavailable"`, "Counts may be out of
  date", plus a retry button (never stale-looking-fresh).

### `ApprovalRow`, `StalledRunRow`, `OpenTurnRow`
- `StalledRunRow` states *why* (`waiting_human`, `interrupted`, `lease expired`, `approval overdue`) —
  the reason is server-sourced (gap **G17**); "stalled" is never a client-side timeout guess.
- Each row's verb matches the object: approvals → Review; interrupted runs → Inspect; open turns →
  Open/Take control. Never a generic "Handle".

---

## C. Runs and execution history

### `StageStrip` (`⟨T+run-stage-strip⟩`)
One segment per **definition** node with rollup counts (`3/12 ✓ · 2 ⟳ · 1 ⚠`). It is the compact view
`10`/J5 demand: "compact progress by stage".
- Segments are buttons that scroll/focus the matching tree branch; `aria-label` =
  "test stage: 12 of 25 succeeded, 1 failed, activate to jump to the execution tree".
- A failed `business_outcome` on a *successful execution* renders two words
  ("ran fine · check failed") — the distinction is the engine's (`03` envelope) and hiding it would
  be a UI lie.

### `ExecutionTree` (`⟨T+run-tree⟩`)
Virtualised tree of node executions → attempts → child runs.
- Depth-first, per-branch expand/collapse, counts on collapsed parents, pagination inside a branch
  (gap **G15**).
- Roles: `role="tree"`, rows `role="treeitem"`, `aria-expanded`, `aria-level`, `aria-setsize/posinset`
  so a screen-reader user can read a 25-child fan-out as a hierarchy (`10`: "screen-reader run
  hierarchy").
- Keyboard: `↑/↓` move, `→` expand, `←` collapse or jump to parent, `Home/End` ends of list,
  `Enter` opens detail, `*` expands all siblings of the current level (no "expand all 150").
- A detached child (parent cancelled, detach policy) keeps a visible label
  "detached — still running" (`03` edge case).
- Never renders coordinates; the tree order is execution identity
  `(node_instance_key, attempt_number)` (`01` invariant 6).

### `RunDefinitionGraph` (`⟨T+run-definition-graph⟩`)
Read-only render of the pinned revision in Definition mode. Same visual vocabulary as the editor
canvas, no handles, banner: "pinned to digest 8f2c1a…".

### `Timeline` (`⟨T+run-timeline⟩`)
Event rows correlated by run/node/attempt with search and filters (`failure | actor | stage`)
(`10` Activity timeline).
- Each row: time (`AgeLine`), type, human summary, actor chip (`kind` + display name), ids as
  `TokenField`s, permalink `#event-<global_seq>` (reuses the journal cursor so the link is honest).
- `run.override.applied` renders actor, before/after and reason as an explicit row (gap **G6**) —
  "who changed this and why" must be answerable from the screen (`08`).
- `conversation.turn.interrupted` renders the reason enum, and never a `stop_reason` (ADR-0016:
  nobody reported an outcome).
- Live appends are `aria-live="polite"` on the list container with a "N new events above" button when
  the user has scrolled up (do not steal reading position).

### `AttemptDetail` (`⟨T+run-attempt-detail⟩`)
`execution_status`, `business_outcome`, outputs (schema-rendered / raw / bindings), evidence artifact
chips, workspace + per-repo refs, agent session line (launcher, version, protocol, session origin),
sandbox verdict row, limits/timeout, retry history.
- The sandbox row is the M3 requirement verbatim: "the sandbox verdict next to the conversation, not
  hidden in a tooltip" (`docs/m3-contract.md` §7 W3).
- Stale-fencing attempt: "Writes from this attempt were rejected — token 8812 was superseded."
  (12 case 3.)

### `InterruptedBanner` (`⟨T+run-interrupted-banner⟩`)
`role="status"`, text from J7. Offers `[Retry from boundary]` and `[Stop]`, names the boundary and
the redo scope. Contains no promise about uncheckpointed edits (`02` "Not guaranteed" column).
Extends the shipped `⟨T:interrupted-notice⟩` copy convention (`interruptedCopy` in
`ui/src/api/transcript.ts`).

### `RetryDialog` (`⟨T+run-retry-dialog⟩`)
Target attempt selector · checkpoint boundary card (gap **G5**) · downstream invalidation list (what
will not be reused) · optional run-local input override with a **required** reason field · explicit
warning for side-effecting nodes ("this node publishes to GitHub; retrying reconciles against the
existing PR rather than assuming no effect" — `03` "Avoid infinite automatic retries of external side
effects"). Submit label: "Retry attempt" (not "OK").

### `PauseMenu`
Three different actions, never conflated (`10` "Pausing the pipeline is different from interrupting
an agent turn or taking control"):
- `Pause pipeline` → stops future scheduling (`POST /runs/{id}:pause`) — run-level.
- `Stop this turn` → ACP cancellation for one agent turn (shipped `⟨T:stop-turn⟩`) — turn-level.
- `Take control` → controller CAS (shipped `⟨T:take-control⟩`) — conversation-level.
Each item's description says what waits and what keeps running ("the running attempt finishes; no new
nodes start").

---

## D. Pipeline library, editor, promotion

### `StarterCard` (`⟨T+starter-card-<name>⟩`)
Name · "what it does" · prerequisites · node/scope inventory · `[Clone to organization]` ·
`[Inspect]`. Disabled clone reasons are explicit (missing integration, no repos, no writable profile
— gap **G18**).

### `DefinitionCard`, `RevisionRow`, `DraftRow`
Definition row shows channel labels with digests (`stable 8f2c1a… · beta 41d0b7…`) and drafts count.
Revision rows carry state words from `draft → validated → published → deprecated/archived` (`01`) and
an immutable-digest `TokenField`. A `published` row has no Edit control at all — immutability is
visible (ADR-0002).

### `GraphCanvas` (`⟨T+editor-canvas⟩`) — editor only
- Node = focusable element (`tabindex="0"`), `aria-label` = "node implement, agent.acp, depends on
  approve, 2 outputs". Arrow keys move spatially between nodes; `Enter`/`Space` select; `Delete`
  removes with confirm; `Ctrl/Cmd+D` duplicates; drag with pointer; `Ctrl/Cmd+Z` undo (draft history
  list is the same trace the assistant uses — one source, per `08` "One control source").
- Scope containers (`until`, `for_each`, `parallel`) render as labelled regions with their bound
  (`maxIterations: 4`, `passWhen: nodes.review.outputs.approved == true`) visible inline, not behind
  a tooltip; nesting depth is limited visually with a "depth 2 of 3" crumb rather than shrinking text.
- Edges have semantic styling: success (solid), condition route (dashed + route key label),
  error route (dotted + "on error"), approval wait (labelled "durable wait"). Edge labels are text.
- Zoom/pan controls are buttons with `aria-label`s; keyboard `+`/`-`/`0`. A canvas-only feature must
  also be reachable through the node list + inspector, because a canvas is unusable by keyboard-only
  and screen-reader users (`10` Accessibility). **Open UX choice:** auto-layout button vs manual.
- Layout metadata is presentation-only and excluded from semantic diff (`03`).

### `NodePalette` (`⟨T+editor-palette⟩`)
Grouped by kind with one-line semantics from `03`'s catalogue. Every entry says what it *can* do
(side effects, durable wait, spawns child runs) — an author must see that `git.publish` pushes
before dragging it.

### `NodeInspector` (`⟨T+editor-inspector⟩`)
Schema-driven form (`03`: "UI renders form fields from schema and sensible widgets"):
identity (stable id, `01` invariant 6) · kind · profile picker with capability notes · prompt ·
`sessionMode` with `resume_if_supported` + fallback (`04`) · inputs/outputs with `${{ … }}` binding
picker · workspace mode (read-only vs writable; shared-writable shows the race warning, `05`) ·
secret pickers (**references only**) · sandbox policy ref · failure policy (`stop|retry|continue|route`
with max/backoff fields) · timeout, limits, fan-out max + in-flight max · declared outputs and
artifact list.
- Invalid combination ⇒ field-level `aria-invalid` + a validation finding, never a silent clamp.
- Unknown JSON Schema shape ⇒ explicit "raw JSON" mode with a warning; no hidden fields.

### `ValidationsPanel` (`⟨T+editor-validations⟩`)
Server findings (unique ids, DAG scopes, ports, recursion depth, secret refs, no literals, resource
limits, schemas, reachable terminal outcomes — `03` step 1) grouped by severity; each finding links to
the node. "Publish" is gated on zero errors, and the button's disabled reason is in text.

### `YamlView` (`⟨T+editor-yaml⟩`)
Read-only canonical YAML with digest + copy/export (gap **G14**); import is a dry-run validate first
(`07`). Header line: "YAML is a rendering of the stored canonical document; the graph and this view
cannot disagree."

### `RevisionDiff` (`⟨T+editor-diff⟩`)
Node-level added/removed/changed with before/after YAML and a graph overlay (rings:
`data-highlight="diff-added|changed|removed"`), plus the digest delta (gap **G13**).

### `AssignmentEditor` / `PromotionPreview` (`⟨T+assignment-*⟩`, `⟨T+promotion-preview⟩`)
Assignment selects an **exact published revision, or a channel** (`stable|beta`) and previews before
changing the target project (`10` Deployment status). The promotion preview states, in sentences:
target project(s), old digest → new digest, affected assignments, and "N running attempts stay
pinned to `8f2c1a…`" (`07`, `12` case 11). Promote is a separate action from Publish with separate
copy (gap **G21**).

### `TemplateCard` / `ProfileCard` (`⟨T+template-*⟩`, `⟨T+profile-*⟩`)
Template: owner, version, compatibility evidence, example outputs, `[Clone]` `[Edit]` — and the rule
from `03`: templates "must not silently bypass sandbox/credential policies", so the card shows the
effective workspace mode and secret scope it wraps.
Profile: launcher, permission mode with the reason it is `ask` (no verified enforced sandbox), APM
package + lock digest, model preference, limits, sandbox ref, allowed secrets, **auth readiness** and
capabilities. Capability gaps are explained where a button would otherwise be missing (`10`: "buttons
disabled/explained when resume/permissions/etc unsupported").

---

## E. Conversation (extend, do not fork the shipped page)

| Component | Status | Spec |
|---|---|---|
| `Transcript` | shipped | Fold of journal frames (`ui/src/api/transcript.ts`) — item kinds `user/agent/thought/tool/permission/system` are the contract; keep dedup by `global_seq` and "one message per turn" merging |
| `TranscriptItem` | shipped | adds: `thought` collapsible with "thinking (truncated)" label; `tool` rows show `inputPreview/outputPreview` with `truncated` marker, and mutate in place on `conversation.tool.update` |
| `PermissionCard` | shipped | options come only from the request (`option_id`s the agent offered); read-only variant names the controller; deadline `AgeLine` counting down; decided state keeps the chosen label + who + when |
| `ControllerBadge` | shipped `⟨T:controller-badge⟩` | texts fixed: "You are in control" / "Controlled by <name>" / "Controlled by a pipeline run" / "No controller — take control to drive" |
| `TakeControlButton` / `ReturnControlButton` / `StopTurnButton` | shipped | pending labels ("Taking…", "Returning…", "Stop requested"); pending disables the peer button; `409` adopts the returned control and re-labels, with a visible one-line explanation |
| `Composer` | shipped | disabled + explained when not controller or a turn is open; **adds** `Ctrl/Cmd+Enter` to send (Enter alone keeps inserting a newline — prompts are multi-line); no character counter on purpose |
| `StreamingRateSelect` (`⟨T+transcript-rate⟩`) | new | `slow | normal | full`; default `normal`, `slow` under `prefers-reduced-motion`; token deltas batch client-side, order from the journal |
| `RunContextLink` (`⟨T+conversation-run-context⟩`) | new | "run r-482 ▸ implement child 3 ▸ attempt#3"; visible only when the conversation is attached to a node execution; a conversation with no pipeline shows nothing (there is no pipeline) |
| `WorkspaceWidget` (`⟨T+conversation-workspace⟩`) | new | repos + base/head refs + dirty path count + workspace mode + excluded paths note; **no** restore/discard control, **no** host path, **no** materialized `.env` content (`10`, `05`) |
| `ParticipantPresence` (`⟨T+conversation-presence⟩`) | new | who is viewing is *only* shown if a server source exists; otherwise the component is absent — inventing presence would be a fake fact (gap: no presence route in `api/openapi.yaml`) |
| `HandoffEvidence` (`⟨T+handoff-evidence⟩`) | new | after return-control: the recorded intervention summary + event link (gap **G8** requires the contract) |

## F. Assistant (`assistant-flow.md` has the choreography)

`AssistantPanel` (`⟨T+assistant-panel⟩`), `AssistantTrace` (`⟨T+assistant-trace⟩`),
`ToolProposalCard` (`⟨T+assistant-proposal⟩`), `QuestionWidget` (`⟨T+assistant-question⟩` +
`⟨T+assistant-question-option-<n>⟩`), `AssistantApprovalBar`, `UiHighlightRing`,
`AssistantStateChip` (`planning|asking|proposing|executing|completed|failed|awaiting approval`).
Critical rule: option buttons carry the **literal semantic answer** (`08`: "Run both reviewers in
parallel" is the answer, not an opaque index) and the transcript stores the phrase, so history stays
readable years later.

## G. Operations

`WorkerTable` (extends shipped `⟨T:workers-table⟩`), `WorkerDetail` (leases, drain state, volume
identity, sandbox verdict + pinned nono version + policy digest), `QueueMeters` (queued/leased/
waiting_human/lease-expired), `CompatibilityTable` (evidence-only, never prefilled),
`SandboxHealthCard`, `CredentialMetadataTable` (never a value), `AuditTable`
(`actor.kind`/`action`/`outcome`/ids), `DoctorSummary` (kernel/nono verdict surfaced from
`communication doctor` output — read-only).

## H. Accessibility conformance floor

| Requirement | Implementation rule |
|---|---|
| Keyboard | every action reachable by keyboard; visible focus ring token (`--color-focus`), never `outline: none` (already enforced by `ui/src/index.css`); logical tab order follows reading order in all wireframes |
| Screen reader | run tree uses `tree/treeitem/aria-level/aria-setsize`; approvals and permission cards announce with `role="status"`; headings per wireframe block (exactly one `h1` per screen, `h2` per block — the shipped convention); `dl` for key/value facts; tables keep `caption` + `scope="col"` (see `Project.tsx`) |
| Live regions | `aria-live="polite"` for stream status, turn status, activity list appends; nothing uses `assertive` except a failed mutation the user must not miss (existing `role="alert"` in `Feedback.tsx`) |
| Motion | global reduced-motion reset already ships (`ui/src/index.css`); assistant highlights, diff rings and progress transitions all degrade to static text/opacity with no animation |
| Contrast | tokens meet WCAG 2.1 AA (4.5:1 body, 3:1 large/UI) — see `design-system.md` measurements table |
| Zoom/reflow | content survives 200% zoom and a 320px viewport without horizontal pan, except wide tables, which scroll inside their labelled region |
| Target size | ≥ 24×24 CSS px for icon buttons, ≥ 44px row height in lists |
| Reading order | DOM order equals the wireframe's visual priority order (attention first, config last) |

## I. New `data-testid`s this brief proposes

Names follow the shipped style (`kebab-case`, verb-object for controls, `<entity>-list/-row-*` for
collections):
`attention-group-*`, `attention-item-*`, `run-status`, `run-mode-toggle`, `run-stage-strip`,
`run-tree`, `run-tree-row-*`, `run-timeline`, `run-attempt-detail`, `run-retry-dialog`,
`run-interrupted-banner`, `editor-canvas`, `editor-palette`, `editor-inspector`,
`editor-validations`, `editor-yaml`, `editor-diff`, `starter-card-*`, `template-list`,
`template-card-*`, `profile-list`, `profile-card-*`, `assignment-row-*`, `promotion-preview`,
`artifact-row-*`, `artifact-preview-frame`, `secret-row-*`, `secret-mount-row-*`,
`materialization-row-*`, `approval-*`, `assistant-panel`, `assistant-proposal`,
`assistant-question-option-*`, `assistant-trace`, `compat-table`, `worker-detail-*`,
`queue-meters`, `workspace-widget`.

Existing names are never reused for different semantics: e.g. `⟨T:conversation-list⟩` stays the
project's conversation list even after Attention grows its own conversation group (`⟨T+attention-group-open-turns⟩`).
