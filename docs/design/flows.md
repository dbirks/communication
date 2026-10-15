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
