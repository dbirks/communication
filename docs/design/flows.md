# User flows J1–J9 (with error and abort paths)

Journeys are named exactly as in `communication-spec/10-ui-design-handoff.md` "Key user journeys to
design completely". Every node below is either (a) an existing capability in
`api/openapi.yaml` / `docs/m3-contract.md`, or (b) tagged with a gap id from
[`README.md`](README.md) → *Contract gaps*. Diagrams are Mermaid `flowchart`s; state names are the
domain's (`01` "State machines"), never a UI-invented label.

Legend used in all diagrams:

| Marker | Meaning |
|---|---|
| `[server]` | authoritative state change the UI may only observe |
| `(409 …)` | conflict branch the UI must render, not swallow (ADR-0016 §9: adopt, don't retry) |
| ⛔ | hard stop: the screen explains what is missing and where to fix it (`10` J1) |
| ✓ | an acceptance point reused by [`acceptance-checklist.md`](acceptance-checklist.md) |

---

## J1 — First-run onboarding

*Admin connects OIDC (or approved dev auth), creates Project, adds two repositories, registers a
managed Claude/Codex launcher/profile, imports a starter pipeline, configures secrets, checks sandbox
status, launches the first run.*

There is no wizard object in the domain, so there is no wizard that fakes one: this is a **checklist
screen** whose items are each a real resource the admin can see, and whose completion state is read
from those resources — never stored as a "tutorial progress" field.

```mermaid
flowchart TD
  A["Open app unauthenticated"] --> B["/login · Sign in<br/>(OIDC code+PKCE; dev mock IdP)"]
  B -->|IdP unreachable| B1["⛔ 'Sign-in service unreachable.<br/>Existing sessions are read-only for X.'"]
  B -->|success| C["/ Attention, empty-state<br/>with the setup checklist"]
  C --> D["Create project · /projects/new<br/>POST /api/v1/projects ⟨server⟩"]
  D -->|409 slug taken| D1["'Pick a different name — the slug is taken.'<br/>(copy already shipped in ui/src/pages/Projects.tsx)"]
  D1 --> D
  D --> E["Add repository #1 and #2<br/>POST /api/v1/projects/:id/repos ⟨server⟩"]
  E -->|409 duplicate name| E1["inline: 'That repository name is already used in this project.'"]
  E --> F["Register launcher + agent profile<br/>GET /api/v1/agent-profiles (read-only today)"]
  F -->|no writable route| F1["⛔ gap G18: 'Profiles are read-only in this build.<br/>Seeded: Claude Code (claude), Codex (codex).<br/>Create/edit is a later milestone.'"]
  F --> G["Import starter pipeline<br/>Library ▸ Starter gallery ▸ Clone to draft ⟨gap G1⟩"]
  G --> H["Configure secrets (metadata + write-only value)<br/>POST /api/v1/projects/:id/secrets ⟨M3 contract⟩"]
  H --> I["Check sandbox status<br/>GET /api/v1/system/sandbox ⟨M3⟩ + GET /api/v1/workers"]
  I -->|enforcement=required and verified=false| I1["⛔ 'No worker can start an agent in required mode.<br/>Stage: probe · Reason: <reason from event>'"]
  I -->|permissive-dev| I2["amber, worded: 'Insecure development execution —<br/>clearly labelled, never silent (05)'"]
  I --> J["Start first run<br/>POST /api/v1/runs ⟨gap G1⟩"]
  J --> K["✓ Run Inspector opens on a queued run,<br/>revision digest pinned, stream: live"]
  K --> L["✓ Checklist reads '6 of 7 ready'; the unfinished item<br/>links to the screen that finishes it"]
```

Error/abort paths designed:

| Condition | Screen behaviour | Source |
|---|---|---|
| IdP down mid-session | banner from `GET /api/v1/me` 401 → "read-only grace" copy; privileged actions disabled, transcript still readable | `06` "Identity provider unreachable", ADR-0012 |
| Non-admin tries to publish | no Publish button; explanation "Publishing needs a library role" (not a disabled mystery) | `01` authorization matrix |
| nono unavailable / kernel lacks restriction | run refuses to start; the failure names the stage (`probe,profile,policy_assert,grant_assert,exec,runtime`) and reason from `sandbox.enforcement_failed` | `docs/m3-contract.md` §3, `12` case 13 |
| APM target mismatch (profile's harness ≠ package target) | validation error on the draft/publish screen, not at run time only | `04` "APM preparation", gap G1 |
| No repositories yet | Starter clone is still allowed (draft is org-owned), but "Start run" is disabled with "Add at least one repository" | `05` workspace design |
| Duplicate create (no `Idempotency-Key` yet) | button disabled while pending; on a second submit the `409` explains it is a duplicate name, not a lost save | gap G24, ADR-0014 Consequences |

---

## J2 — New consultant assigned five projects

*Lands on attention dashboard; identifies two stalled runs, one human approval, three conversations;
opens the relevant client project without finding locally installed skills; takes control of a blocked
session, prompts, returns control.*

```mermaid
flowchart TD
  A["/ Attention (inbox)"] --> B["Read grouped-by-project list:<br/>waiting_human runs · open approvals ·<br/>interrupted runs · unanswered permission prompts ·<br/>conversations with an open turn"]
  B -->|no aggregate route| B1["gap G16: build GET /api/v1/attention<br/>or compose per-project lists server-filtered"]
  B --> C["✓ '2 stalled · 1 approval · 3 conversations'<br/>is legible in one screen, no clicking"]
  C --> D["Open stalled run ▸ Run Inspector"]
  D --> E["Why stalled? run.status=waiting_human<br/>+ approval.requested 3d 4h ago ⟨gap G7⟩<br/>OR node.attempt.interrupted (worker api-b lease expired)"]
  E -->|interrupted| E1["Honest panel: 'Stopped. Nobody reported an outcome.'<br/>Checkpoint: node test passed at 14:02 · work after that<br/>will be repeated. No 'resumed without loss'."]
  E --> F["Open the linked conversation<br/>(controller = run_attempt)"]
  F --> G["Take control<br/>POST /api/v1/conversations/:id/take-control ⟨version⟩"]
  G -->|409 with live control row| G1["Adopt the returned control:<br/>'Ana took control 6 seconds ago.'<br/>Button flips to viewer state. Never retried over."]
  G -->|200| H["✓ Composer enabled (was disabled + explained)<br/>Send prompt ⟨server: one active turn⟩"]
  H -->|turn already open| H1["inline: 'A turn is already open (status: …).<br/>Wait, or press Stop — a second prompt is refused.'"]
  H --> I["Return control<br/>POST …/return-control ⟨version⟩"]
  I -->|kind=run_attempt| I1["gap G8: what continuation is queued, and what<br/>summary the factory sees, must be stated by M4"]
  I --> J["✓ Badge: 'Controlled by a pipeline run'<br/>+ evidence row 'human intervention at 14:21 by Ana'"]
  D --> K["Skills question: 'no locally installed skills'<br/>→ profile's APM package is shown as a reference +<br/>lock digest, never as a filesystem listing"]
  K --> K1["04: 'APM preparation is not itself isolation' —<br/>the screen says staged, not isolated"]
```

Designed detail: the consultant's screen never shows a path like `/var/lib/communication/…` (M3
contract forbids it) and never shows a skill list implying tenant isolation (D-025 **Open**).

---

## J3 — Pipeline author creates a workflow

*Selects sample Plan→Approve→Implement→Review; changes agent profiles/inputs; adds a bounded review
loop; validates; previews YAML/diff; publishes a new revision; promotes it to one Project only.*

> Issue #2 note: the canvas steps below now live in the **Workflow Studio**
> (`/library/:pipelineId/drafts/:draftId`) — the full authoring journey is J10; J3 keeps the
> publish/promote contract, which is unchanged.

```mermaid
flowchart TD
  A["/pipelines ▸ Starter gallery<br/>'Feature Delivery' (07's example #1)"] --> B["Clone to organization ▸ draft<br/>⟨gap G1: needs a clone/create-draft route⟩"]
  B --> C["/drafts/:draftId ▸ Canvas<br/>definition graph only (03: layout metadata is non-semantic)"]
  C --> D["Inspector ▸ change profile / inputs<br/>form rendered from JSON Schema (03 bindings)"]
  D --> E["Add bounded review loop:<br/>until ⟨ maxIterations, passWhen ⟩ ⟨03 catalogue⟩"]
  E -->|missing bound| E1["Validation error: 'until requires a maximum<br/>iteration count' — publish stays disabled"]
  E --> F["Validations panel<br/>POST /api/v1/drafts/:id/validate ⟨gap G1⟩"]
  F -->|invalid: orphan port / bad secret ref / secret literal /<br/>unreachable terminal outcome| F1["List of findings, each clicking to the offending node;<br/>state stays draft (01 revision state machine)"]
  F --> G["YAML view (read-only render of canonical doc + digest)<br/>⟨gap G14⟩"]
  G --> H["Diff view: draft vs source revision<br/>⟨gap G13⟩"]
  H --> I["Publish ▸ POST /api/v1/drafts/:id/publish ⟨gap G1⟩"]
  I -->|needs change approval| I1["gap G21: approval is its own durable request;<br/>draft is not silently published"]
  I --> J["✓ Revision <digest> published · assignments unchanged<br/>(09: 'returns immutable revision and non-mutated assignments')"]
  J --> K["Project A ▸ Pipelines ▸ Assignments ▸ Promote<br/>preview FIRST ⟨gap G1/G21⟩"]
  K --> L["Preview says exactly: target project, channel,<br/>old→new digest, affected assignments,<br/>N running attempts stay pinned ⟨12 case 11⟩"]
  L --> M["Confirm promote ⟨server⟩ assignment.promoted"]
  M --> N["✓ Project B assignment still shows the old digest.<br/>No bulk-by-accident."]
```

Error/abort paths:

| Condition | Behaviour |
|---|---|
| Draft edited in another tab | draft `version` mismatch → "This draft changed elsewhere. Reload / keep my edits" (gap G12); never a silent overwrite |
| Graph edited after a run started | run screen header keeps the pinned digest and links the *revision*, not the draft (`03` edge case, `12` case 11) |
| Bindings reference a node that was deleted | validation finding with node id, not an index or canvas coordinate (`01` invariant 6) |
| Secret literal pasted into a node field | rejected by validation; message points to SecretRef picker (invariant 5, `03` step 1) |
| Review loop "never passes" | published graph is fine; the *run* fails at the declared bound with full evidence (`12` case 7) — the editor warns about unbounded loops before publish |
| Author lacks library role | Publish absent + explanation (`01` matrix "only with library role") |

---

## J4 — Natural-language authoring ("Use Gemini as reviewer for the beta of project A")

```mermaid
flowchart TD
  A["Assistant panel: typed or spoken request<br/>(speech is an input modality only — 08)"] --> B["assistant.message.delta · planning"]
  B --> C["Read-only tools within scope:<br/>project.list · pipeline.inspect · assignment reads"]
  C --> D["assistant.ui.navigate → /pipelines/:id<br/>+ ui.focus/highlight on the reviewer node<br/>(target = data-focus-target, never a DOM path)"]
  D --> E["Draft mutation: pipeline.cloneRevision →<br/>pipeline.updateNode(parallel + until scope, params)"]
  E --> F["Highlight changed nodes + assistant.diff.ready<br/>before/after YAML, node-level, digest noted"]
  F --> G["assistant.question with phrase buttons:<br/>'new issues only' | 'also replace queued runs' |<br/>'show me the diff first' + free text"]
  G -->|the chosen phrase is the answer| H["assistant.tool.proposed: assignment.previewPromotion"]
  H --> I["Rollout preview: Project A only;<br/>running attempts pinned"]
  I --> J["Publish needs approval — same permission path<br/>as the manual UI (06 edge case, D-023)"]
  J -->|user approves| K["⟨server⟩ pipeline.revision.published +<br/>assignment.promoted · audit row · assistant.tool.completed"]
  J -->|declined| K1["Draft kept · nothing effective · trace records the refusal"]
  K --> L["✓ '/assistant/history' answers 'who changed this<br/>and why?' with the diff and the actor"]
  C -->|scope violation| M["⛔ assistant cannot name Project B at all<br/>(06, 12 case 15) — it says 'I can only see<br/>projects you belong to.'"]
  B -->|long action| N["Intermediate progress line; privileged ops ask first<br/>(08 'Long-running assistant actions')"]
```

Rules the flow enforces: read-only inspection may proceed; draft edits may be applied with undo
history; publish/promote/secrets/security always ask (`08` "Tool action policy"). The assistant
creates drafts and **never deploys a workflow autonomously** (`08`).

---

## J5 — Live complex run (6 nodes → 25 children, hundreds of attempts)

```mermaid
flowchart TD
  A["Run Inspector default mode"] --> B["Stage strip: 6 definition nodes,<br/>each with counts (3/12 done · 2 running · 1 waiting)<br/>— compact, from run rollups ⟨gap G1/G15⟩"]
  B --> C{mode}
  C -->|Definition| D["The published 6-node graph.<br/>Never expands."]
  C -->|Execution| E["Runtime tree, collapsed to depth 1:<br/>for_each ▸ 25 children (page 1 of 3) ⟨gap G15⟩"]
  E --> F["Expand one child ▸ its node executions ▸ attempts.<br/>Sibling counts stay visible."]
  F --> G["Attempt detail: outputs, evidence,<br/>artifacts, agent session, diagnostics"]
  G --> H["Conversation of that attempt<br/>(full transcript, controller shown)"]
  E -->|one child failed, 24 passed| I["Failure aggregation row: 'child 3 of 25 failed'<br/>sibling results preserved (12 case 8)"]
  E -->|parent cancelled with 12 children| J["Cascade vs detach shown per child;<br/>a detached child stays visible and labelled<br/>'detached — still running' (03 edge case)"]
  B -->|no 150-node maze| K["✓ Expansion is opt-in per branch;<br/>a run's canvas is never a copy of its definition"]
  A --> L["Stream: project SSE filtered by run id,<br/>or GET /runs/:id/events ⟨gap G2/G3⟩"]
  L -->|reconnect| M["Last-Event-ID resume from global_seq:<br/>no gap, no duplicate row (ADR-0014 §9)"]
```

---

## J6 — Permission request / handoff

```mermaid
flowchart TD
  A["Agent inside a run asks a permission<br/>conversation.permission.requested ⟨server⟩"] --> B["Card appears in transcript, role=status, aria-live<br/>tool title + kind + every offered option + deadline"]
  B --> C{"Am I the controller"}
  C -->|no| C1["Read-only card:<br/>'Ana Rivera has control and must answer this.'"]
  C -->|role=viewer| C2["Card read-only, composer disabled,<br/>explainer names the contributor role needed<br/>(copy already shipped in Conversation.tsx)"]
  C -->|yes| D["Decide with an option_id the agent actually offered<br/>POST …/permissions/:requestId ⟨ADR-0016 §8⟩"]
  D -->|409| D1["Adopt returned control/turn state"]
  D --> E["Card closes on conversation.permission.decided<br/>with label + who + when (already rendered)"]
  A --> F["Separate human wants to drive"]
  F --> G["Take control · ⟨version⟩"]
  G -->|turn running| H["Same transaction sets cancel_requested on the turn;<br/>control moves immediately ⟨09⟩. UI shows:<br/>'Factory is yielding — waiting for the harness to acknowledge.'"]
  H -->|acknowledged| I["turn.cancelled lands · badge shows me as controller<br/>· factory run enters waiting_human"]
  G -->|two humans click simultaneously| J["Exactly one wins CAS;<br/>loser sees the winner, never guesses ⟨06, 12 case 10⟩"]
  I --> K["Prompts + workspace edits append to the durable conversation"]
  K --> L["Return control"]
  L --> M["✓ 'Controlled by a pipeline run' +<br/>conversation.control.transferred row with<br/>from/to/reason and evidence (06 step 3)"]
  M -->|per the profile resume policy| N["next turn shows: resumed session · new session with<br/>context · or fail — per 04 resume_mode, never implied"]
```

---

## J7 — Failure / recovery (worker disappears)

```mermaid
flowchart TD
  A["Worker api-b stops heartbeating"] --> B["⟨server⟩ reconciler: lease expired →<br/>node execution interrupted · run.interrupted"]
  B --> C["Run Inspector banner (never colour-only):<br/>'Interrupted — stopped, outcome unknown.'<br/>+ reason: lease_expired / worker_gone / shutdown"]
  C --> D["Checkpoint panel ⟨gap G5⟩: last completed boundary,<br/>per-repo base+head refs, modified-path manifest,<br/>artifact refs, conversation pointer"]
  D --> E{"Same worker and same volume"}
  E -->|yes| F["Retry from previous completed boundary is offered:<br/>'Work after 14:02 will be repeated.' ⟨02, 05⟩"]
  E -->|no — different host, no portable checkpoint| G["workspace.recovery_lost with<br/>reason=volume_changed ⟨M3 §3⟩<br/>⛔ 'Edits on that volume are not recoverable.<br/>Cross-host recovery is not supported in this build.'<br/>(D-024 Open — no promise invented)"]
  F --> H["Retry ▸ POST /api/v1/runs/:id:retry ⟨gap G1/G5⟩<br/>target node execution/attempt + optional override"]
  H -->|override applied| I["run.override.applied row in timeline:<br/>actor, before/after, reason ⟨03, gap G6⟩"]
  H -->|stale fencing token| J["409: 'This attempt was already closed by another worker.'<br/>Timeline refreshes ⟨01 invariant 3, 12 case 3⟩"]
  I --> K["New attempt appended; the failed one stays visible<br/>(01: attempts append, never overwrite)"]
  G --> L["Stop is the other offered action;<br/>both are explicit, neither is automatic"]
  A --> M["Mid-turn transcript is NOT promised intact (02 table);<br/>partial agent output is shown as truncated, labelled"]
```

Anti-patterns explicitly designed out: no "resumed without loss" copy, no auto-retry spinner that
hides a redo, no green check inherited from the killed attempt.

---

## J8 — Secret settings

```mermaid
flowchart TD
  A["/projects/:id/settings ▸ Secrets"] --> B["List: slug · scope · purpose · delivery_mode ·<br/>current_version · allowed profiles · revoked_at<br/>(metadata only, M3 contract)"]
  B --> C["Create: write-only value field<br/>POST …/secrets · value in no response/event/log"]
  C --> D["No reveal, no masked echo beyond a password input,<br/>no 'last 4': no such endpoint exists ⇒ nothing to render"]
  D --> E["Declare a secret mount:<br/>repository ▸ relative_path ▸ key ▸ lifecycle<br/>(05's shape, validated server-side)"]
  E -->|path escape / tracked target / exists| E1["⛔ named rejection with the reason enum from<br/>secret.materialization_failed:<br/>path_escape · tracked_target · exists · …"]
  E --> F["Policy facts shown next to the mount:<br/>'0600 · owner-only · removed at attempt end ·<br/>excluded from git/diff/artifacts'<br/>+ honest warning: an agent that can read the file<br/>can copy it (05 threat-model clarification)"]
  F --> G["Rotation: append immutable version<br/>POST …/secrets/:id/versions · old version stays<br/>for in-flight units ⟨M3⟩"]
  G --> H["Revoke: :revoke · later materializations refuse it"]
  H --> I["Audit: …/secrets/:id/materializations — which unit,<br/>which target, when cleaned (reference only)"]
  B --> J["Run Inspector / transcript / diff never show a value:<br/>secret.materialized is metadata-only by construction"]
```

---

## J9 — Publication

*Code review passes; branch/draft PR created as an explicit step; PR/status/commit linked; user can
identify what remains unmerged.*

```mermaid
flowchart TD
  A["Reviewer gate: execution_status=success<br/>business_outcome=pass ⟨03 envelope⟩"] --> B["Run shows 'Acceptance passed — nothing published yet.'<br/>completed ≠ merged (01)"]
  B --> C["Publication is a node the author added:<br/>git.commit → git.publish (draft PR) ⟨03, 18 D-018⟩"]
  C --> D["integration.action intent recorded<br/>external_action.intent · operation id"]
  D --> E{"Response lost"}
  E -->|yes| F["Reconcile: 'PR already exists for this operation —<br/>matched by operation id, not duplicated'<br/>external_action.reconciled (12 case 6)"]
  E -->|no| G["external_action.reconciled + artifact/ref recorded"]
  G --> H["Run ▸ Publication panel:<br/>branch · commit sha · PR # + canonical URL ·<br/>check status · merge state"]
  H --> I["✓ 'What remains unmerged' is a listed state:<br/>'Draft PR #412 open · 2 checks pending · not merged'"]
  C -->|worker died mid-action| J["Attempt interrupted + intent still open:<br/>'Unconfirmed external action — will reconcile'<br/>(never claims success from exit status alone,<br/>cf. ADR-0019's post-commit ref read)"]
  B -->|no publication node configured| K["Says so plainly:<br/>'This revision has no publication step. Changes live<br/>in the run workspace only.'"]
```

---

## J10–J13 — Issue #2 walkthroughs (Studio, Workbench, conversations, assistant proposals)

These four are issue #2's acceptance journeys (design checkpoint `studio-workbench.md`;
ADR-0042/0043/0044), in the same notation as J1–J9. `⟨T:…⟩` names a shipped `data-testid`.

### J10 — Author a workflow visually (Workflow Studio)

*Opens a draft, inserts a step on an edge, configures it, wraps a node in a Repeat-until scope,
validates, reads the diff, publishes.*

```mermaid
flowchart TD
  A["Open draft ▸ /library/:pipelineId/drafts/:draftId<br/>⟨T:studio-page⟩ · old shapes redirect here"] --> B["Palette: search + kind list ⟨T:studio-palette⟩<br/>click adds after the selected step<br/>⟨T:palette-item-<kind>⟩"]
  B --> C["Insert on an edge: + button on the edge<br/>⟨T:edge-add-<from>-<to>⟩ ▸ StepPicker<br/>⟨T:step-picker⟩ · ⟨T:step-picker-item-<kind>⟩"]
  C -->|guarded / condition / error-route edge| C1["⟨T:studio-ambiguity-dialog⟩: the §4 reasons, verbatim<br/>[Insert anyway] keeps the target's guard + bindings<br/>[Cancel] — never a silent rewrite of `when`"]
  C --> D["Configure the node in the Inspector<br/>⟨T:insp-node⟩ · fields ⟨T:insp-<field>⟩, schema-driven<br/>validate-only kinds show 'not runnable yet' ⟨T:insp-deferred⟩"]
  D --> E["Wrap in Repeat until: scope box on the canvas<br/>⟨T:canvas-scope-<id>⟩ · add inside ⟨T:add-inside-<id>⟩<br/>bound (maxIterations) visible, not in a tooltip"]
  E --> F["Validate ⟨T:studio-validate⟩<br/>⟨T:studio-validate-drawer⟩ · verdict + findings<br/>each finding jumps to its node ⟨T:studio-goto-node-<i>⟩"]
  F --> G["Diff vs source revision ⟨T:studio-diff⟩<br/>⟨T:diff-panel⟩ · per-node rows ⟨T:diff-node-<id>⟩<br/>unparseable YAML ⇒ ⟨T:diff-invalid⟩, publish gated"]
  G --> H["Save = version-checked PUT /drafts/:id<br/>⟨T:studio-save⟩; 409 ⇒ conflict banner, reload or overwrite<br/>⟨T:studio-conflict-banner⟩ — never a silent clobber"]
  H --> I["Publish ⟨T:studio-publish⟩; disabled reason in text<br/>⟨T:studio-publish-reason⟩ · same contract as J3<br/>⟨server⟩ immutable revision, assignments unchanged"]
  B --> J["Undo/redo ⟨T:studio-undo⟩ / ⟨T:studio-redo⟩ never cross<br/>the saved version — unsaved edits marked ⟨T:studio-dirty⟩"]
```

Error/abort paths designed: invalid YAML keeps the last-good graph and greys the canvas
(⟨T:canvas-stale-banner⟩ + `staleMessage`); a refused connection names the reason
(⟨T:connect-refused⟩); leaving with unsaved edits asks first (⟨T:studio-leave-guard⟩).

### J11 — Watch a run and intervene (Run Workbench)

*Opens the run, the default view is the live graph; selects the ACP node, reads its real
conversation beside the graph, takes control, prompts, returns to the factory.*

```mermaid
flowchart TD
  A["/projects/:projectId/runs/:runId<br/>default ?view=graph · tabs ⟨T:run-tab-graph|timeline|tree|diagnostics⟩"] --> B["Live graph = pinned definition topology with status overlays<br/>⟨T:run-pinned-revision⟩ in the header — editing is impossible by design"]
  B --> C["Select the ACP node ⟨T:canvas-step-<id>⟩<br/>instance chosen through selectors, never extra graph nodes:<br/>⟨T:instance-picker-<scopeId>⟩ (iteration chips / paged items) ·<br/>attempt tabs ⟨T:dock-attempt-<n>⟩"]
  C --> D["Right dock: AgentConversationPanel for agent.acp<br/>⟨T:workbench-dock⟩ · ⟨T:dock-conversation⟩ — the same panel<br/>the Conversation page renders, not a fork"]
  D --> E["Take control ⟨T:take-control⟩ ⟨version⟩"]
  E -->|409 with live control row| E1["Adopt the returned control, re-label<br/>(J6 rule — never retried over.)"]
  E -->|200| F["Prompt in the composer ⟨T:composer-input⟩ /<br/>⟨T:composer-send⟩; one active turn, Stop ⟨T:stop-turn⟩"]
  F --> G["Return to factory ⟨T:return-control⟩<br/>badge back to 'Controlled by a pipeline run'<br/>⟨T:controller-badge⟩ · stream ⟨T:run-stream-status⟩"]
  D -->|viewer, no write access| H["No composer, no Take control — disabled + explained<br/>⟨T:composer-explainer⟩ (ADR-0016 controller lock, never widened)"]
  D -->|process.exec / human.approval / failure| I["Dock is kind-keyed: stdout tail · ApprovalCard ·<br/>error + attempt n of m + retry verdict ⟨T:dock-failure⟩"]
```

Rule: the view never moves the user's selection — SSE updates badges and counts only
(ADR-0043 §4); the full journal tree stays one tab away (`?view=tree`).

### J12 — Start a one-off conversation

*No pipeline involved: three entries open the same dialog, and the result is labelled Manual.*

```mermaid
flowchart TD
  A["Global New ▾ ⟨T:new-menu⟩ ⟨T:new-menu-conversation⟩<br/>project header ⟨T:project-new-conversation⟩<br/>Conversations tab ⟨T:conversations-new-open⟩"] --> B["NewConversationDialog ⟨T:new-conversation-dialog⟩<br/>project picker (fixed when opened from a project)<br/>⟨T:new-conversation-dialog-project⟩"]
  B -->|no project yet| B1["⛔ 'Create a project first' ⟨T:new-conversation-dialog-need-project⟩ —<br/>a one-off conversation still needs a project (01)"]
  B --> C["Title · profile · first prompt<br/>⟨T:conversation-new-title⟩ / -profile / -prompt<br/>⟨T:conversation-new-submit⟩"]
  C --> D["⟨server⟩ conversation created, origin=manual"]
  D --> E["List shows the badge: 'Manual' ⟨T:conversation-origin-manual⟩<br/>vs 'From run' ⟨T:conversation-origin-run⟩ (deep-link to the run);<br/>filter All/Manual/From-runs + search ride ?q= & origin="]
  C -->|no launchable profile| F["Disabled + explained (G18): 'No agent profile<br/>you can launch. Ask an admin to register one.'"]
```

### J13 — Assistant proposes a draft change

*In the Studio, the human asks in words; the assistant returns one reviewable op; applying it is
the normal version-checked PUT — the assistant never publishes (ADR-0044).*

```mermaid
flowchart TD
  A["Studio header: 'Ask to change this draft…'<br/>⟨T:assistant-proposal-box⟩"] --> B["Type the instruction ⟨T:assistant-proposal-input⟩<br/>⟨T:assistant-proposal-submit⟩"]
  B --> C["POST /api/v1/assistant/draft-proposals<br/>{draft_id, version, instruction}<br/>authorization = 'may PUT this draft' — no wider"]
  C -->|wrong version / no write access| C1["409 / 403 — same problem+json as the draft PUT;<br/>no proposal, nothing to review"]
  C -->|structurally invalid / guarded edge| C2["422 assistant_proposal_invalid — refused, not re-asked;<br/>⟨T:assistant-proposal-error⟩ names it"]
  C --> D["Exactly one op from the closed set:<br/>insert_after · insert_on_edge · update_prompt"]
  D --> E["Canvas rings the touched nodes + caption<br/>⟨T:assistant-proposal-caption⟩ — same code path a human<br/>gesture uses (graphDoc ops)"]
  E --> F{"Apply or discard"}
  F -->|Apply ⟨T:assistant-proposal-apply⟩| G["Adopt the previewed text and Save with the<br/>normal version-checked PUT — same 409 rules as J10"]
  F -->|Discard ⟨T:assistant-proposal-discard⟩| H["Restore the pre-proposal text, clear the highlight;<br/>nothing was ever written server-side"]
  E -->|unsaved human edits present| I["Blocked with the reason ⟨T:assistant-proposal-reason⟩:<br/>applying to saved text would lose them"]
  G --> J["✓ Publish is still a separate human decision —<br/>the assistant only proposed; no autonomous publish (08)"]
```

---

## Cross-cutting error paths (every screen)

`10` "Empty and error states" lists these; each has one owned screen so the message is not written
twice in three dialects:

| Condition | Where surfaced | Copy rule |
|---|---|---|
| No repositories | Project Overview ▸ Repositories | names the next action (Add repository), not "empty" |
| No agent account / no profile | New-conversation form + Attention | "No agent profile you can launch. Ask an admin to register one." (gap G18) |
| nono kernel unavailable | `/ops`, run inspector banner, J1 checklist | stage + reason from the event; "no unprotected execution" (`05` gate) |
| APM target mismatch | draft validations + profile editor | "Package targets `codex`; this profile launches `claude`." |
| Disconnected worker | run inspector + `/ops/workers/:id` | "Worker api-b stopped reporting at 14:20. Nobody reported an outcome." |
| Missing portable checkpoint | retry dialog | "Cross-host recovery is not supported in this build." (D-024) |
| Expired worker lease | attempt detail + timeline | names the attempt and that its writes were rejected (12 case 3) |
| Missing permission | everywhere | 404-shaped: "not found or you do not have access" (ADR-0014 §3) — no 403 that leaks existence |
| Stream reconnecting | every live screen (`stream-status`) | "reconnecting — replaying from event 152007", plus replica name |
| Two prompts into one turn | composer | already-shipped explainer; button disabled, reason stated |
