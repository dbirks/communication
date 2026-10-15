# Wireframes (low-fidelity)

ASCII, desktop-first, annotated. These fix **information priority and state coverage**, not pixels:
spacing, radius and colour come from [`design-system.md`](design-system.md); behaviour comes from
[`components.md`](components.md); the data behind each region is in [`data-dependencies.md`](data-dependencies.md).
Region labels like `⟨T:project-list⟩` are the `data-testid`s that already exist or that this brief
proposes (proposed ones are prefixed `⟨T+⟩`).

Priority order on every page: **(1) what is broken or waiting for me, (2) what is happening now,
(3) history/evidence, (4) configuration.** Screens never bury a blocked run under a chart.

---

## 1. `/` — Attention (inbox)

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ Communication  [Attention] [Projects] [Library]                     default · Ana ▾    │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ Attention                                                            assistant ▸ [⌘K]   │
│                                                                                        │
│ ┌─ Needs a decision ─────────────────────────────────────────────────────────────────┐ │
│ │ ▸ Approve plan: "Split billing by tenant"        Customer Platform · waiting 3d 4h │ │
│ │   run r-482 · node approve · you are a designated approver            [Review ▸]   │ │
│ │ ▸ Permission: write to src/billing/ledger.go     Customer Platform · exp 00:41     │ │
│ │   conv c-19 · controlled by you                                                    │ │
│ └────────────────────────────────────────────────────────────────────────────────────┘ │
│ ┌─ Stuck ─────────────────────────────────────────────────────────────────────────────┐ │
│ │ ✗ Interrupted — outcome unknown        Payments Sync · run r-501 · 14:20 UTC        │ │
│ │   worker api-b stopped reporting · last good boundary: node test ✓ 14:02  [Inspect]  │ │
│ │ ✗ Failed at review (attempt 3 of 3)    Customer Platform · run r-497      [Inspect] │ │
│ │ ⚠ Waiting for an approver who lost access  Website Revamp · r-455  [Reassign/Cancel]│ │
│ └────────────────────────────────────────────────────────────────────────────────────┘ │
│ ┌─ Conversations with an open turn (3) ────────────────────────────────────────────────┐ │
│ │ c-19 Ledger refactor      Claude Code · controlled by Ana Rivera      prompt open   │ │
│ │ c-21 Flaky test triage    Codex · nobody is driving      [Take control]             │ │
│ │ c-24 Dependency sweep     Claude Code · controlled by a pipeline run                │ │
│ └────────────────────────────────────────────────────────────────────────────────────┘ │
│ ┌─ Quiet (5 projects, last 24 h) ──────────────────────────────────────────────────────┐ │
│ │ Customer Platform ✓12 ⚠1 · Payments Sync ✓4 ✗1 · Website Revamp ✓0 · …              │ │
│ └────────────────────────────────────────────────────────────────────────────────────┘ │
│ replica: api-b · schema v4                                                              │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

Annotations
- "Needs a decision" first — J2's exit is *legibility in one screen*, and it is the only group whose
  rows disappear because of something the user does.
- Every row states **the reason and the age in words** ("waiting 3d 4h", "outcome unknown"); no
  traffic-light-only signalling (`10` Accessibility; `Operations.tsx` precedent).
- Group order is fixed, not user-sortable by default; sorting is per-group (`age | project | actor`).
- Counts must come from a permission-filtered source (gaps **G7/G16/G23**); when the aggregate
  route is absent, the group renders "—" and links into each project rather than estimating locally.
- `⟨T+attention-group-decision⟩`, `⟨T+attention-item-<id>⟩`; keyboard: `j/k` move rows, `Enter`
  opens, `a` opens the approval, `t` takes control of a focused conversation.
- Not a chat window, not a dashboard of charts: `00` explicitly says graphs are not the sole
  navigation metaphor.

---

## 2. `/projects/:projectId` — Project Overview

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ Customer Platform                        role: maintainer · slug: customer-platform    │
│ [Overview] [Work] [Runs 14] [Conversations 3] [Repos 2] [Pipelines 2] [Artifacts] [⚙]  │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ ┌ Blocked (1) ─────────────────────────┐ ┌ Now (2) ─────────────────────────────────┐ │
│ │ r-482 waiting_human 3d 4h [Inspect]  │ │ implement · iteration 2/4 · 3 workers    │ │
│ │   approve node · you can approve     │ │ test · running · attempt 1 · 4m 12s      │ │
│ └──────────────────────────────────────┘ └──────────────────────────────────────────┘ │
│ ┌ Assignments ────────────────────────────────────────────────────────────────────────┐ │
│ │ Feature Delivery  channel stable · pinned rev 8f2c1a…  manual + schedule            │ │
│ │   last run 12 min ago ✓ · 1 running                                    [Assignments]│ │
│ │ Dependency Maintenance  beta rev 41d0b7… (Project A only)                           │ │
│ └──────────────────────────────────────────────────────────────────────────────────────┘├
│ ┌ Repositories & workspaces ──────────────────────────────────────────────────────────┐ │
│ │ frontend  main @ a91f2c  · worktree ws-77 dirty: 6 paths     [Inspect workspace]    │ │
│ │ backend   main @ 4d0e11  · worktree ws-77 clean                                     │ │
│ │ (no absolute host paths are ever shown here — M3 contract §2)                       │ │
│ └────────────────────────────────────────────────────────────────────────────────────┘ │
│ ┌ Activity  feed: live ⟨T:activity-list⟩ ─────────────────┐ ┌ Recent artifacts ──────┐ │
│ │ 14:20:11 run.interrupted      worker api-b              │ │ plan.md   markdown     │ │
│ │ 14:18:02 node.attempt.completed test ✓                  │ │ report.html [Preview]  │ │
│ │ 14:11:55 conversation.control.transferred  Ana → factory │ │ diff.patch (excludes   │ │
│ │ …                                             [Load more]│ │   materialized .env)   │ │
│ └──────────────────────────────────────────────────────────┘ └───────────────────────┘ │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

- Everything to the right of "Blocked"/"Now" is the existing ActivityFeed component reused, not
  rewritten (`⟨T:activity-list⟩`, `⟨T:activity-item⟩`, `⟨T:activity-status⟩` unchanged).
- Repositories tab keeps `⟨T:repo-list⟩`, `⟨T:repo-name⟩`, `⟨T:repo-git-url⟩`,
  `⟨T:repo-default-branch⟩`, `⟨T:repo-submit⟩` and the maintainer-only form as shipped
  (`Project.tsx`); M5 adds the workspace row beside it.
- "Dirty: 6 paths" links to workspace inspection; there is deliberately **no** `git restore` /
  "discard changes" affordance anywhere in this widget (`10` Workspace widget).

---

## 3. `/projects/:projectId/runs/:runId` — Run Inspector (execution mode)

The defining screen of M5. Two named modes; the default is the compact one, per J5.

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ ← Runs / r-482   Feature Delivery · revision 8f2c1a… (pinned)   Assignment: Project A   │
│ status: waiting_human · goal: "Split billing by tenant" · started 13:58 · 3h 22m        │
│ mode: (●) Execution  ( ) Definition          [Pause] [Cancel] [Retry ▾]  assistant ▸    │
│ ┌ Stage strip ─────────────────────────────────────────────────────────────────────────┐│
│ │ plan ✓ │ approve ⚠ waiting 3d │ build_until_verified ⟳ 2/4 │ test ✓ 12/25 │ review ✗3││
│ └──────────────────────────────────────────────────────────────────────────────────────┘│
│ ┌ Execution tree (depth 1) ────────────────┐ ┌ Detail: test ▸ child 3/25 ──────────────┐│
│ │ ▼ approve            waiting_human       │ │ attempt 3 · running 4m12s · worker api-b││
│ │ ▼ build_until_verified   iter 2 of 4     │ │ kind: process.exec                      ││
│ │   ▼ implement (for_each 25) 22 ✓ 2 ⟳ 1 ✗ │ │ outputs   raw   bindings                ││
│ │     · child 1  ✓ 1m12s      [expand]     │ │  {"passed": false, "n": 41}             ││
│ │     · child 2  ✓ 58s        [expand]     │ │ evidence: test-output.txt · diff.patch  ││
│ │     ▶ child 3  ✗ failed → review routed  │ │ workspace ws-77: frontend@a91f2c +6 paths││
│ │       └ implement ✓ · review ✗ (routed)  │ │ conversation c-19 (factory) [open]      ││
│ │     · … 22 more   [page 2 ▸] [filter ▾]  │ │ sandbox: verified · policy 2b71 · af_unix││
│ │ ▶ publish_draft_pr  not reachable yet    │ │ limits: 45m timeout · 3 retries used    ││
│ └──────────────────────────────────────────┘ └─────────────────────────────────────────┘│
│ ┌ Timeline (correlated by node/attempt · search + filter by failure/actor/stage) ───────┐│
│ │ 13:58 run.started ▸ 13:59 plan ✓ ▸ 14:02 approve requested ▸ 14:20 attempt#2 ✗ (exit 1)││
│ │ 14:21 run.override.applied — Ana: retries 3→5 "flaky seed"  [diff]                    ││
│ └──────────────────────────────────────────────────────────────────────────────────────┘│
└────────────────────────────────────────────────────────────────────────────────────────┘
```

Annotations
- **Definition mode** renders the published 6-node graph read-only with a banner: "This run is pinned
  to `8f2c1a…`. Editing the draft does not change this run." No expansion happens in this mode.
- **Execution mode** is a tree of node executions/attempts; a definition node can appear thousands of
  times as executions and they are never merged into the canvas (`03` "Definition versus runtime
  graph", `10` Run inspector).
- Fan-out list is paginated (gap **G15**) with counts always visible; expansion is per-branch so
  depth-first reading survives.
- `execution_status` vs `business_outcome` are two columns of text: a node can read
  "ran fine · check failed" (`03` result envelope) — one badge would lie.
- Interrupted banner replaces the strip header:
  `✗ Interrupted — stopped, outcome unknown. Last completed boundary: test ✓ 14:02. Anything after
  this will be repeated. [Retry from boundary] [Stop]` (J7, `02`, `10` J7 anti-"resumed without loss").
- `⟨T+run-status⟩`, `⟨T+run-mode-toggle⟩`, `⟨T+run-tree⟩`, `⟨T+run-tree-row-<nodeExecutionId>⟩`,
  `⟨T+run-timeline⟩`, `⟨T+run-attempt-detail⟩`, `⟨T+run-retry-button⟩`.
- Retry opens a dialog (gap **G4/G5**): target attempt, checkpoint boundary, downstream invalidation
  list, optional run-local override with a required reason, and the sentence "This appends a new
  attempt; the failed one stays in history."

## 3b. Attempt detail (drill-down)

```
Attempt #3 · ne-114 · test ▸ child 3/25          started 14:18:02 · finished 14:18:56 (54s)
execution_status: failed · business_outcome: fail · exit code 1 · error code: test_failed
worker api-b · fencing token 8812 (current owner) · attempt limit 3 reached
outputs (validated against schema) · raw · diagnostics
  ▸ failures: 2 · "TestTenantIsolation: expected 404, got 200"
evidence: test-output.txt (internal) · diff.patch (internal) · screenshot.png (restricted: metadata only)
conversation c-19 ▸ full transcript [open]
session: claude v0.9.1 · protocol v1 · new session (resume unavailable for this launcher)
[sibling: run r-483's identical node succeeded — compare]
```
`restricted` artifact rows show name/kind/size/sensitivity and no content or preview (ADR-0020 §3).
A stale-token attempt shows the rejection reason rather than disappearing (12 case 3).

## 3c. Definition mode

```
 ┌ plan ──── approve ────┬─ build_until_verified (max 4) ─┐──── test ──── review ──── publish_draft_pr
 │ agent.acp  human.approval │  ⟲ until: passWhen review.approved │  process.exec  gate(agent) │ git.publish
 └ error routes: review ──✗──▶ implement (inside loop)  ·  approve ──timeout──▶ fail
 banner: read-only · digest 8f2c1a… · "layout only — non-semantic metadata"
```
Edges render as named scopes (`until`, `for_each`, `parallel`/`join`, `pipeline.invoke`,
`condition`, human approval, error route) — never as free-drawn arrows without semantics (`03`).

---

## 4. `/projects/:id/conversations/:conversationId` — Conversation (extended, URL unchanged)

Current page (`ui/src/pages/Conversation.tsx`) already satisfies most of `10`'s conversation brief;
M5 adds the right rail and the run link without moving anything.

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ Project / Conversations                                                                │
│ Ledger refactor            [Controlled by Ana Rivera — you]  ← ⟨T:controller-badge⟩    │
│ profile: Claude Code · status: active · stream: live · turn: running · agent: claude   │
│ (new session) · run r-482 ▸ implement child 3 ▸ attempt#3 [open]  ← new: factory link  │
│ [Return control] [Stop] ⟨T:return-control⟩ ⟨T:stop-turn⟩  control version: 7           │
│ ┌ Transcript ⟨T:transcript⟩ ──────────────────────┐ ┌ Context rail (collapsible) ─────┐│
│ │ ▸ user (Ana) 14:11  "Re-run only the failing…"  │ │ Workspace ws-77                  ││
│ │ ▸ thought (agent, truncated)                    │ │  frontend@a91f2c  dirty 6 paths ││
│ │ ▸ tool: edit src/billing/ledger.tsx  running    │ │  backend@4d0e11   clean         ││
│ │ ▸ ⚠ Permission request — write /etc/hosts       │ │ Associated conversations: c-19  ││
│ │   kind: read · expires 00:41                    │ │ Artifacts: plan.md, diff.patch  ││
│ │   [Allow once] [Always allow in sandbox]        │ │ Agent capabilities:             ││
│ │   status: awaiting a decision ⟨T:permission-card⟩│ │  resume ✗ · cancel ✓ · perms ✓  ││
│ │ ▸ agent chunk stream (rate: normal ▾)           │ │  [why some buttons are off]     ││
│ └─────────────────────────────────────────────────┘ └─────────────────────────────────┘│
│ Prompt ⟨T:composer-input⟩ [Send ⟨T:composer-send⟩]  ⟵ disabled + explained if not      │
│ "A turn is already open (status: running). Wait for it to finish, or press Stop."       │
└────────────────────────────────────────────────────────────────────────────────────────┘
```
- Capability-awareness lives in the rail: if the agent reported no `loadSession`, the resume-related
  affordances are absent and the rail says which capability is missing (`04`, `10`).
- Transcript streaming-rate control (`slow | normal | full`) with **reduced motion** defaulting to
  static-per-turn: `10` "transcript streaming rate".
- Human-initiated and factory-initiated conversations share this exact presentation; the only
  difference is the badge text plus the run link (`10` "share a common presentation, but show
  controller/ownership clearly").
- Pausing the *pipeline*, interrupting a *turn*, and *taking control* are three different controls
  with three different labels; never reused for each other (`10` backend rules).

---

## 5. `/pipelines` — Pipeline Library

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ Pipeline Library        [Starters] [Organization 12] [Drafts 3] [Revisions]             │
│ search: [ billing        ]  channel: (all · stable · beta)   owner: ▾  profile: ▾      │
│ ┌ Starter gallery (read-only, bundled) ────────────────────────────────────────────────┐│
│ │ ┌ Feature Delivery ──────────────────┐ ┌ Process ready GitHub issues ──────────────┐ ││
│ │ │ What it does: plan → approve →     │ │ What it does: query issues, fan out ≤N…   │ ││
│ │ │ implement → test → review → loop → │ │ Prerequisites: GitHub integration (M6) ·  │ ││
│ │ │ draft PR (07 example #1)           │ │ 1 repo · label 'agent-ready'              │ ││
│ │ │ Nodes: 6 · scopes: until, for_each │ │ Nodes: 4 · scopes: for_each, invoke       │ ││
│ │ │ [Clone to organization] [Inspect]  │ │ [Clone] — disabled: "Needs M6 triggers"   │ ││
│ │ └────────────────────────────────────┘ └───────────────────────────────────────────┘ ││
│ └──────────────────────────────────────────────────────────────────────────────────────┘│
│ ┌ Organization definitions ────────────────────────────────────────────────────────────┐│
│ │ Feature Delivery      stable 8f2c1a… · beta 41d0b7… · 3 drafts · 2 projects          ││
│ │   ▸ revisions: r7 ✓published · r8 (draft) · r6 deprecated        [Open] [New draft]  ││
│ │ Dependency Maintenance  stable 0a11bc… · schedule weekly                            ││
│ └──────────────────────────────────────────────────────────────────────────────────────┘│
│ ┌ Node templates ⟨T+template-list⟩ ──────────────┐ ┌ Agent profiles ⟨T+profile-list⟩ ──┐│
│ │ Security Reviewer 2.0.0 · wraps agent.acp      │ │ Claude Code (launcher claude · ask)││
│ │ owner org · compat: codex ✓ claude ✓ · [Clone] │ │ Codex (launcher codex · ask)       ││
│ │ example outputs: {approved, evidence, findings}│ │ APM: org/review-kit@1.4 · digest…  ││
│ └────────────────────────────────────────────────┘ └────────────────────────────────────┘│
└────────────────────────────────────────────────────────────────────────────────────────┘
```
- Every starter names **prerequisites** up front (`07` "minimum prerequisites"); a starter that needs
  an unavailable capability is shown disabled with the reason, never hidden (`10` J1).
- Stable/beta are *labels on the assignment target*, resolved to a pinned revision at run creation
  (`07` "Version rollout") — the card never implies beta is "loose".
- Search is server-side and permission-filtered (gap **G23**): results can never name an
  inaccessible project or definition (12 case 15).

---

## 6. `/drafts/:draftId` — Pipeline Editor

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ Draft: Feature Delivery (r8)              draft v12 · validated ✗ 2 findings · [⌘K]     │
│ [Canvas] [Parameters] [Validations 2] [YAML] [Diff]        [Save draft] [Validate] [Publish]│
├───────────────┬───────────────────────────────────────────────────┬────────────────────┤
│ Palette       │  Canvas (definition graph, zoom/pan, no runtime)   │ Inspector          │
│ ▸ agent.acp   │   ┌──────┐   ┌────────┐   ┌───────────────────┐    │ node: review       │
│ ▸ model.chat  │   │ plan │──▶│ approve│──▶│ until (max 4)     │    │ kind gate(agent)   │
│ ▸ process.exec│   └──────┘   └────────┘   │  ┌─────────────┐  │    │ ── schema form ──  │
│ ▸ condition   │                           │  │ implement   │  │    │ profile ▾ Claude…  │
│ ▸ gate        │                           │  │ review      │  │    │ prompt  [multiline]│
│ ▸ human.appr. │                           │  └─────────────┘  │    │ sessionMode resume │
│ ▸ until       │                           │        │          │    │  ⓘ launcher has no │
│ ▸ for_each    │                           │        ▼          │    │    loadSession →   │
│ ▸ parallel    │                           │   publish_draft_pr │    │    fallback: new   │
│ ▸ join        │                           └───────────────────┴────┤    session         │
│ ▸ invoke      │   selected: review (id review · stable)            │ outputs: approved, │
│ ▸ artifact    │                                                    │   evidence         │
│ ▸ git.commit  │                                                    │ bindings: ${{nodes │
│ ▸ git.publish │                                                    │   .plan.outputs…}} │
│               │                                                    │ failure: route ▾   │
│               │                                                    │ limits: 45m · 3×   │
│               │                                                    │ secrets: test-db   │
└───────────────┴───────────────────────────────────────────────────┴────────────────────┘
┌ Validations drawer ─────────────────────────────────────────────────────────────────────┐
│ ✗ until 'build_until_verified' has no maxIterations — [go to node]                      │
│ ✗ secret literal in implement.prompt (invariant 5) — replace with a SecretRef [fix]     │
│ ✓ DAG scopes valid · ✓ terminal outcomes reachable · ✓ schemas valid                    │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```
- Inspector renders **from JSON Schema** with sensible widgets (`03` bindings); unknown schema shapes
  fall back to a JSON editor with a warning rather than silently hiding a field.
- `${{ nodes.plan.outputs.plan }}` is presented as a picker over real upstream outputs, with the
  underlying binding text visible; internally the AST is the server's concern (gap **G12**).
- Raw/output view, retry/failure routing, timeout and resource limits are per-node fields, and the
  error-route edge is drawn from the node it belongs to (`10` Components list).
- `pipeline.invoke` shows the target **revision id** with bounded-depth validation, never "latest"
  (`03` step 1 validation).
- Diff tab: node-level added/removed/changed + YAML side-by-side + digest delta (gap **G13**).
- Publish is disabled while validations fail, with the reason on hover/focus *and* in text.
- Assistant highlight overlay: `data-highlight="assistant-proposed"` ring with an explicit
  "assistant proposed this change" caption; never a silent animation (`08`, reduced-motion).
- Keyboard: `Tab` reaches palette → canvas nodes → inspector; canvas nodes are focusable with arrow
  navigation and `Enter` to inspect (see `components.md` GraphCanvas); `Ctrl/Cmd+K` opens assistant;
  `Ctrl/Cmd+S` saves draft; `?` shows the shortcut sheet.

---

## 7. Assistant panel (global, right-docked; bottom sheet <1280px)

```
┌ Assistant ─ what you can ask ▾ ──────────────────┐
│ Context: Project Customer Platform · run r-482   │  ← derived from the route, stated as such
│ ───────────────────────────────────────────────  │
│ planning ▸ inspected assignment + revision 8f2c  │
│                                                    │
│ Proposal · typed action                            │
│  pipeline.updateNode  draft d-19 · node review     │
│  profile: Claude Code → Gemini (beta)              │
│  scope: Project A only                             │
│  consequences: 1 assignment target changes;        │
│  2 running attempts stay pinned                    │
│  [Show diff]  [Ask what this changes]  [Apply draft]│
│                                                    │
│ Question: Which beta should apply to?              │
│  ○ new issues only    ○ also replace queued runs   │
│  ○ show me the diff first   free text: [________]  │
│                                                    │
│ history ▾  14:22 pipeline.cloneRevision ✓ (undo)   │
│            14:22 pipeline.updateNode ✓ (undo)      │
│            14:23 assignment.previewPromotion ✓     │
│            14:24 awaiting your approval            │
│ status: awaiting approval       [Cancel turn]      │
└────────────────────────────────────────────────────┘
```
States rendered 1:1 with `08`: planning · asking · proposing typed action · executing · completed ·
failed · awaiting approval. Route-target highlight is a labelled ring, not a spotlight animation, and
it collapses to a text line under reduced motion. See [`assistant-flow.md`](assistant-flow.md).

---

## 8. `/ops` — Operations (existing prefix, extended)

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ Operations            [Workers] [Sandbox] [Compatibility] [Identities] [Audit]         │
│ ┌ Health ⟨T:health-card⟩ ────────┐ ┌ Readiness ⟨T:readiness-card⟩ ───────────────────┐ │
│ │ ✓ ok · replica api-b · v0.3.1  │ │ ✓ ready · schema v4 (expected v4)               │ │
│ └────────────────────────────────┘ └─────────────────────────────────────────────────┘ │
│ ┌ Workers ⟨T:workers-table⟩ ───────────────────────────────────────────────────────────┐│
│ │ name  status   version  hb        volume            sandbox  enforcement  verified   ││
│ │ api-b online   v0.3.1  12s ago   vol-7c1 (known)   nono 0.2  required     ✓ (M3)    ││
│ │ api-c draining v0.3.0  30s ago   vol-9f2           none     disabled     ✗ not verified │
│ │ api-d offline  v0.3.1  3h ago    unknown ⚠         —        —            —           ││
│ │   ⚠ "unknown volume: no M3 workspace may bind here" (ADR-0017 D2 as words)          ││
│ └──────────────────────────────────────────────────────────────────────────────────────┘│
│ ┌ Queues: 3 queued · 2 leased · 1 waiting_human · 0 lease-expired awaiting reconcile ──┐│
│ ┌ Compatibility ⟨T+compat-table⟩ ──────────────────────────────────────────────────────┐│
│ │ Claude Code ACP adapter TBD: New session Test · Streaming Test · Permission Test ·   ││
│ │ Cancel Test · Restore Test · APM Test · Nono Test    ← never prefilled PASS (12)     ││
│ └──────────────────────────────────────────────────────────────────────────────────────┘│
│ ┌ Credentials (metadata only) ─────────────────────────────────────────────────────────┐│
│ │ github-app: integration · last used 2m · rotated 12d · scopes: issues, pull_requests ││
│ └──────────────────────────────────────────────────────────────────────────────────────┘│
└────────────────────────────────────────────────────────────────────────────────────────┘
```
- The compatibility table renders the **evidence record**, including "Test" rows, because `12`
  forbids prefilling PASS; the source of truth is `docs/compatibility/*.md`, surfaced read-only
  (gap **G19**).
- `volume: unknown` is rendered as a warning state because no M3 workspace may bind to it.
- Audit rows show actor kind + id, action, outcome (`allowed|denied`), and correlation ids; no secret
  body (`06`).

---

## 9. `/projects/:id/settings` — Secrets (J8)

```
┌ Secrets — Customer Platform ───────────────────────────────────────────────────────────┐
│ slug                 scope   delivery     version  profiles            revoked          │
│ test-database-url    project env_file    v3       Claude Code, Codex   —      [Manage]  │
│ github-token         project env         v1       —                    —               │
│ (no column of values exists; no reveal control is offered)                              │
│ + Add secret: slug [__] purpose [__] delivery [env ▾] profiles [▾] value [••••• write- │
│   only — never shown again, never in events or logs]                                    │
├ Secret mounts ─────────────────────────────────────────────────────────────────────────┤
│ test-database-url → backend / .env.test.local · key DATABASE_URL · lifecycle node_attempt│
│ policy: 0600 owner-only · created atomically · refuses a tracked target · excluded from │
│ git status/diff/artifacts · removed at attempt end · rotated on retry                   │
│ warning (always visible): an agent that can read this file can copy it; scoping and     │
│ egress control matter more than file permissions (05)                                   │
├ Materializations (audit, metadata only) ───────────────────────────────────────────────┤
│ 14:18 run r-482 attempt a-114 · backend/.env.test.local · cleaned 14:19                 │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

## 10. Artifact detail + sandboxed preview

```
┌ report.html — run r-482 · child 3 ─────────────────────────────────────────────────────┐
│ kind: report · media: text/html · sha256 7c1f… · 84 KB · sensitivity: internal · state ready│
│ created 14:19 by worker api-b (attempt a-114) · [Download] [Copy link (internal)]       │
│ ┌ Preview (separate origin · sandboxed) ───────────────────────────────────────────────┐│
│ │ ⚠ Rendered in an isolated frame on another origin. It cannot read this app's cookies ││
│ │   or storage. Content is untrusted agent output. Token expires in 4m32s. [Re-open]   ││
│ │ ⟨iframe src=https://preview.localhost:18084/preview/<token> sandbox="" …⟩            ││
│ └──────────────────────────────────────────────────────────────────────────────────────┘│
│ (restricted artifacts: this frame is never rendered — metadata only, per ADR-0020 §3)   │
└────────────────────────────────────────────────────────────────────────────────────────┘
```
`src` is always the server-provided absolute `preview_url` (gap **G22**); the app never
concatenates a path onto its own origin, and `…/content` for `text/html` is a download
(`docs/m3-contract.md` §2), so the UI has no inline-HTML-on-app-origin state at all.

## 11. Approval detail (human gate, gap G7)

```
┌ Approve plan: "Split billing by tenant" — run r-482 · node approve ────────────────────┐
│ status: awaiting a decision · requested 3d 4h ago · deadline in 20h (escalates to: org admins) │
│ requested by: pipeline (agent.acp plan output) · approvers: project maintainers + designated │
│ context: plan.md [open artifact] · goal input · workspace refs · 2 downstream nodes waiting  │
│ your decision: [Approve] [Reject]  comment [____________________]                       │
│ consequence line: Approve starts build_until_verified (up to 4 iterations, ≤3 concurrent agents) │
│ history: (none)                                                                         │
│ ⚠ If you no longer hold access here, this decision is refused and re-routed — approving │
│   is authorized per decision, not per link (12 case 9)                                  │
└────────────────────────────────────────────────────────────────────────────────────────┘
```
Contrast with the conversation permission card (J6): a **human gate** is durable, holds no worker
slot, and can escalate; a **permission prompt** belongs to a live ACP turn and is answered by the
current controller. Different objects, different screens, different verbs — never merged (`06`).

## 12. Empty states (all of them, in one place)

| Screen | Empty state copy rule | Primary action |
|---|---|---|
| `/` Attention | "Nothing needs you. 5 projects, 0 blocked runs, 0 open approvals." | [Browse runs] [Library] |
| `/projects` | "No projects yet" (shipped) | [New project] |
| Project ▸ Runs | "No runs yet — this project has 1 assignment." | [Start a run] / [Edit assignment] |
| Project ▸ Repositories | "No repositories yet." | inline form (shipped) |
| Library ▸ Organization | "No organization pipelines yet. Start from a sample." | [Starters] |
| Draft canvas | starter nodes suggested; empty canvas is *allowed* but the palette stays visible | — |
| Run inspector, 0 children | "for_each received 0 items — the run completed with an empty result list" (`03` edge case) | [inspect plan output] |
| Conversation, no transcript | "No messages yet." (shipped `⟨T:transcript-empty⟩`) | composer |
| `/ops` no workers | "No worker has registered. Start `communication worker`." | doctor hint |
| Artifacts | "No artifacts. Publication is not configured in this revision." | — |

## 13. Responsive rules (per screen family)

| Family | ≥1280px | 768–1279px | <768px (mobile) |
|---|---|---|---|
| Attention | full grouped list | grouped list, one column | grouped list; counts collapse to a filter chip row |
| Project overview | 2 columns (content + activity/artifacts) | stacked | stacked; Runs/Conversations first |
| Run inspector | stage strip + tree + detail | stage strip + tree; detail becomes a bottom sheet | **lists only**: stage counts → flat attempt list → detail page. No graph canvas |
| Pipeline editor | 3-pane (palette/canvas/inspector) | palette drawer + canvas + inspector drawer | read-only graph image + **YAML/Parameters tabs** (real editing is desktop; `10` "on mobile favor status/lists/conversation rather than forcing full graph editing") |
| Conversation | transcript + context rail | transcript; rail behind a button | transcript, controller badge pinned in a sticky header, composer above keyboard |
| Assistant | right dock, persistent | right dock behind toggle | bottom sheet, opened explicitly, never auto-covering content |
| Operations | tables | tables with horizontal scroll | cards (`dl` pairs), status words first |

Mobile rules that are not layout opinions but contract: a stalled run must be **actionable** on
mobile (approve, take control, retry-from-boundary with its dialog) — approval and control are the
things people do away from a desk; graph authoring is not (`10` responsive).
