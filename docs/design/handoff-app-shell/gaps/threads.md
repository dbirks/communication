# Gap analysis — one-off threads & hand-to-workflow (artboards 4f, 5d)

Area: the "Six Directions" handoff's one-off thread (4f) and hand-to-a-workflow (5d).
Scope: `ui/src/pages/Conversation.tsx`, `ProjectConversations.tsx`, `NewConversationDialog.tsx`,
`ui/src/components/conversation/*`, backend conversations (issue #2), permission requests,
per-conversation workspaces/branches, conversation artifacts, GitHub draft-PR integration,
and "start a run from a thread branch with seeded first-step input".

## 1. Design asks

- **4f** — Thread page header: title, `thread · repo · profile · age` meta line, "You're in control" pill, `Stop` (danger) button.
- **4f** — Conversation column (max 820px): user bubble, tool-call rows, agent prose, **inline permission card** (amber; `Deny` danger / `Allow once` primary). Composer with ink border, hard shadow, mic, `Send`.
- **4f** — Right rail (300px): **WORKSPACE** (repo, branch `thread/<slug>`, base, changed files, sandbox status), **ARTIFACTS**, **NEXT** (`Open a draft PR from this branch`, `Hand to a workflow…`).
- **5d** — "Hand to a workflow" dialog: pick workflow (e.g. `Bug Fix · stable r4`); a **CARRIES OVER** panel showing the branch (thread branch becomes run base, including the committed edits), a `plan input` summary (model-written, editable via `Edit summary`), `artifacts` (attached to plan), `thread stays open and links to the run`; note that the run starts fresh agent sessions (no replay); `Cancel` / `Start <Workflow> run`.

## 2. Exists today

**The one-off thread page is already built and accepted** (issue #2, all-pass record in
`docs/design/issue2-acceptance.md`; e2e `e2e/tests/issue2-conversations.spec.ts`). UI vocabulary is
"conversations"; the design calls them "threads".

- **Thread page**: `ui/src/pages/Conversation.tsx` at route
  `/projects/:projectId/conversations/:conversationId` (`ui/src/App.tsx:181`). Header has testid
  `conversation-title` (L130) and a meta line `profile: … · status: … · stream: … · turn: …`
  (`data-testid="conversation-meta"`, L134). A `conversation-manual-label` chip marks one-off
  threads (origin `manual`, L165) — origin exists in the API (`origin=manual|run` filter,
  `api/openapi.yaml:996-1001`, ADR-0043).
- **List + new thread**: `ui/src/pages/ProjectConversations.tsx` (title `Conversations — <project>`,
  L81) and `ui/src/components/NewConversationDialog.tsx` (testids `conversation-new-title/-profile/
  -prompt/-submit`, L243-295; copy at L128: "A one-off agent conversation in a project workspace —
  no workflow needed.").
- **"You're in control"**: `AgentConversationControls` renders a controller badge + take/return/
  stop buttons (testids `controller-badge`, `take-control`, `return-control`, `stop-turn` —
  `ui/src/components/conversation/AgentConversationPanel.tsx:66`, wired at `Conversation.tsx:310-316`).
  Backend: `POST /conversations/{id}/take-control|return-control|cancel`
  (`api/openapi.yaml:1261,1320,1368`; ADR-0016). **Design "Stop" = existing `stop-turn`**
  (stop the current turn, `api/openapi.yaml:1372`).
- **Inline permission cards**: in the transcript with option buttons, testids `permission-card`,
  `permission-allow`, `permission-reject`, `permission-readonly`
  (`ui/src/components/Transcript.tsx:220-344`); events `conversation.permission.requested/decided`
  (`api/openapi.yaml:1201-1202`); `GET /conversations/{id}` exposes `pending_permissions`
  (`api/openapi.yaml:2429-2430`); answer via `POST /conversations/{id}/permissions/{requestId}`
  (`api/openapi.yaml:1413`, ADR-0039). `permission_mode` defaults to `ask` (ADR-0039).
  `docs/design/attempt-permissions.md`: inside a *run* an `ask` prompt is auto-cancelled and the
  human path is take-control — one-off threads are where human-answered prompts apply.
- **Workspace per thread**: each conversation gets a mirror branch
  `refs/heads/<conversation>/<repo>` (`internal/workspace/git/workspace.go:350`) and a `workspaces`
  row (`internal/store/postgres/workspaces.go:175`). UI `WorkspaceWidget`
  (`ui/src/components/Workspaces.tsx:252`) shows repo name, `ref: <run_ref>`,
  `base <c> → head <c>`, `dirty: N paths` / `clean`, expandable manifest
  (`GET /workspaces/{id}/repos/{rid}/status`, `api/openapi.yaml:1893`). Shown in the rail
  (`data-testid="workspace-widget"`, `Conversation.tsx:271`).
- **Sandbox rail**: "Sandbox" section, `sandbox-verdict` (honest empty copy when no turn yet) +
  `TurnSandboxPanel` from `GET /turns/{turnId}/sandbox` (`api/openapi.yaml:1929`; ADR-0009),
  `Conversation.tsx:275-300`.
- **Artifacts**: `GET /projects/{id}/artifacts` (`api/openapi.yaml:2001`); the `Artifact` schema
  carries `conversation_id`, `run_id`, `attempt_id` (`api/openapi.yaml:6434-6449`). **But** the list
  route has no `conversation_id` filter param and no UI section lists a thread's artifacts.
- **Run inputs**: `POST /projects/{id}/runs` accepts `inputs` validated against the pinned
  revision's `spec.inputs`, recorded with origin (`run_inputs`, `api/openapi.yaml:7494-7514`);
  bindings `${{ inputs.x }}` (`communication-spec/03-pipeline-engine.md:45`). The existing mechanism
  a "plan input" rides on.
- **Conversation↔run link (run → thread only)**: run-origin conversations render "part of run"
  links (`data-testid="part-of-run-link"`, `Conversation.tsx:219-249`); no API field links a
  manual thread *to* a run it seeded.
- **GitHub**: `internal/integrations/github/` is a **read-only issue lister** (ADR-0031;
  `client.go:95` `ListIssues` only). **No push, no PR creation, no GitHub token in the sandbox
  anywhere**: no push in `internal/workspace/git/` or `internal/worker/` (grep); ADR-0040 is the
  Claude OAuth token, not GitHub. Egress is allowlisted per turn (ADR-0035).

## 3. Gap table

| item | kind | evidence or spec ref | size |
|---|---|---|---|
| Wording "conversations" → "Threads" in UI copy | UI-only | `ProjectConversations.tsx:81`, `NewConversationDialog.tsx:128`, `Conversation.tsx:127`; owner decision (API stays "conversations") | S |
| Header meta `thread · repo · profile · age` (repo + age missing today) | UI on existing API | `Conversation.tsx:134`; repo via `useWorkspaces`, age via `created_at` | S |
| "You're in control" pill + `Stop` in header (today in rail Controller section) | UI-only | `Conversation.tsx:302-316`; `stop-turn` testid exists | S |
| Permission card restyle (amber, "waiting for you") — feature already works | UI-only | `Transcript.tsx:270`; ADR-0039 | S |
| WORKSPACE panel: branch label `thread/<slug>`, "changed N files" row | UI-only label / ADR if ref naming changes | `Workspaces.tsx:52-60`; `workspace.go:350` | S |
| ARTIFACTS rail section (this thread's artifacts) | needs backend (filter param) + UI | no `conversation_id` param on `openapi.yaml:2001`; schema has the field (`openapi.yaml:6441`) | M |
| NEXT panel (actions strip in rail) | UI-only | new section in `Conversation.tsx` rail | S |
| "Open a draft PR from this branch" | needs ADR (spec 05) + backend (push, token, egress) | no PR/push code (§4); ADR-0031, ADR-0035, ADR-0018 | L+ |
| "Hand to a workflow…" dialog (5d) | UI on new API + needs ADR | no such UI; `RunCreate` (`openapi.yaml:7494`) has inputs but no base override / source conversation | M UI + L API |
| Run starts from the thread branch (base = thread head commit) | needs ADR + backend | runs base off mirror default-branch head: `workspace.go:483-499`; `RunCreate` has no `base` (`openapi.yaml:7504-7514`) | L |
| Run ↔ thread link (`source_conversation_id`, back-link chip) | needs ADR + backend | no field; reverse links exist (`Conversation.tsx:219`) | M |
| "Plan input" seeding of first step | UI-only, reuses `RunCreate.inputs` | `openapi.yaml:7511-7514`; spec 03:45 (workflow must declare the input) | S |
| Model-written thread summary for plan input | UI + existing model chat | `internal/worker/modelchat.go`, ADR-0034; fallback = last agent message | M |
| "thread stays open and links to the run" | UI-only once backend link exists | back-link chip like `part-of-run-link` | S |
| Mic in thread composer | out of scope here (assistant phase 2a) | assistant popover task | — |
| Cross-project "Threads" sidebar nav / Home "recent threads" | shell area; needs aggregation or UI fan-out | list route is project-scoped (`openapi.yaml:984`) | note |

## 4. Spec / design conflicts

1. **GitHub token in the sandbox** (product decision) vs `communication-spec/05-workspaces-security-secrets.md:66`:
   "For third-party credentials prefer a restricted broker/token over long-lived raw secrets where
   feasible." A personal GitHub PAT handed to the agent in-sandbox is exactly a long-lived raw
   secret in the agent's reach. Also `:45` classifies "GitHub Apps/PATs/SSH deploy keys" as
   *project/organization integration credentials*, not harness credentials. **Needs an ADR.**
   The ADR must also amend the spec 05 **Publish/merge responsibilities** section
   (`05-workspaces-security-secrets.md:68-70`): "Configure separate commands/nodes for commit,
   push, draft PR, human review and merge… External publication operations need idempotent tokens
   and post-crash reconciliation" — the decision drops the Publish step from the picker and lets
   the agent push/PR itself. Related constraints the ADR must address: token delivery without
   argv/journal exposure (same class of problem as ADR-0040's nono argv audit) and egress
   allowlist entries for the GitHub API (ADR-0035; spec 05:38 lists "network allowlist and DNS
   bypass" and "Git credential helpers" as security test cases).
2. **Vocabulary**: design uses "Threads", "Steps", "Workflows"; spec/API use "conversations",
   "node templates", "pipelines". Settled as UI-only renames; **no ADR** as long as routes,
   schemas and event names are untouched. Do not rename `data-testid`s or API paths.
3. **Immutability**: no conflict found for the hand-to-workflow feature — a run pins its revision
   at creation (`openapi.yaml:3000-3056`, `12` case 11) and the thread branch is just another
   commit identity the run could snapshot; published revisions are not modified. But the new
   persisted state (`run.source_conversation_id`, base-override snapshot) and the new API surface
   still need an ADR per the owner's standing rule.
4. **Permission answering semantics**: 4f shows a human answering an agent prompt *inside* the
   thread — consistent with ADR-0039 / ADR-0016 § 5 (controller-answered) for `origin=manual`
   threads. No conflict; the `docs/design/attempt-permissions.md` run behaviour (auto-cancel +
   take-control) is deliberately different and must not be changed.
5. **Branch visibility**: the design shows `thread/ci-speed` as the branch name; the actual
   per-scope ref is `refs/heads/<conversation>/<repo>` (`workspace.go:350`), a **local mirror
   branch** (not on the remote). Displaying a prettier label is fine; claiming the branch exists
   upstream would contradict the current push-free design (no push anywhere, §2).

## 5. Honest empty states

- **WORKSPACE before first checkout**: `WorkspaceWidget` already says "No workspace for this
  conversation yet — one is prepared when the agent first needs a checkout"
  (`Workspaces.tsx:281-284`). The 5d dialog must handle this: if the thread has no workspace or
  the branch is clean/absent, the CARRIES OVER panel shows "branch has no commits yet — the run
  starts from the repository's default branch" instead of pretending the branch carries anything.
- **Sandbox chip**: design shows `✓ required · verified`; keep the existing honest empty copy
  ("No turn yet… no enforcement to report", `Conversation.tsx:294`) until a real verdict exists.
  Never render "verified" without a probe/verdict (README 4c rule applies here).
- **ARTIFACTS**: empty → "No artifacts yet — files the agent saves appear here." Requires the
  `conversation_id` filter param first, otherwise the rail cannot distinguish "none" from
  "other threads' artifacts".
- **Plan summary**: model chat may be unavailable (assistant broker is read-only and optional).
  Fallback: prefill the editable textarea with the thread's last agent message; label it
  "summary (editable)" and never claim it was model-written unless the model produced it.
- **Draft PR button**: until the ADR + backend land, the NEXT panel must not offer "Open a draft
  PR" (it would 404/fake). Hide the entry entirely rather than disable it, per the honest-UI rule
  elsewhere in this repo.

## 6. Proposed work units

Ordered; ⚡ = can run in parallel with the previous, ⛓ = serializes (same file).

1. **W1 — Thread wording + header restyle (UI-only, S).** "Conversations" → "Threads" copy in
   `ProjectConversations.tsx`, `NewConversationDialog.tsx`, `Conversation.tsx` breadcrumb/rail
   headings; meta line gains repo + age; "You're in control" pill and `Stop` move to (or duplicate
   in) the page header, keeping the `stop-turn`/`controller-badge` testids. Owns:
   `ui/src/pages/Conversation.tsx`, `ProjectConversations.tsx`, `ui/src/components/NewConversationDialog.tsx`.
2. **W2 — Right rail restyle (UI-only, M).** ⛓ after W1 (same file). Rebuild the rail as
   WORKSPACE / ARTIFACTS / NEXT: restyle `WorkspaceWidget` rows (branch label, changed-files row),
   ARTIFACTS stub with the empty state from §5, NEXT panel with only `Hand to a workflow…`
   (stub action) — no draft-PR entry. Owns: `ui/src/pages/Conversation.tsx`,
   `ui/src/components/Workspaces.tsx` (label only).
3. **W3 — Artifact conversation filter (backend M + UI).** ⚡ parallel with W1. Add
   `conversation_id` query param to `GET /projects/{id}/artifacts` + store filter + OpenAPI;
   UI hook `useConversationArtifacts` and the rail list (name, size, age, link to
   `/artifacts/{id}`). Owns: `internal/api/artifacts.go`, `internal/store/postgres/artifacts*.go`,
   `api/openapi.yaml` (+ `ui/src/api/schema.d.ts`), `ui/src/api/queries.ts`; the rail wiring lands
   with W2 (⛓ on `Conversation.tsx`).
4. **W4 — Two ADRs (docs, M).** ⚡ parallel with W1. (a) *Agent-held GitHub credentials in the
   sandbox*: amends spec 05:45, 66, 68-70; interacts with ADR-0018 (delivery without journal
   exposure), ADR-0035 (egress allowlist incl. GitHub API), ADR-0031 (integration surface),
   ADR-0009/0036 (sandbox + lab preapproval). (b) *Thread→run handoff*: `RunCreate` gains
   `source: {conversation_id, base[{repository_id, base_commit}]}`, `runs.source_conversation_id`,
   base validated against the mirror (commit identity, `openapi.yaml` RunRepoSnapshot style),
   `run.created` event gains the link; authorization = run-creation (contributor+). Owns:
   `docs/adr/ADR-004x-*.md`, `docs/adr/ADR-004y-*.md`.
5. **W5 — Handoff backend (L, split 2 units).** ⛓ after W4(b) accepted. W5a: migration +
   `runs.source_conversation_id` + store (creation transaction validates conversation exists in
   project, base commit exists in the mirror, writes snapshot + event). W5b: `RunCreate` API
   surface + validation errors (404 unknown conversation/base, 422 base not in mirror) +
   OpenAPI/`schema.d.ts`. Owns: `internal/api/runs.go`, `internal/store/postgres/runs*.go`,
   migrations, `api/openapi.yaml`.
6. **W6 — "Hand to a workflow" dialog (UI M).** ⛓ after W2 + W3 + W5b.
   `ui/src/components/HandToWorkflowDialog.tsx`: workflow picker (stable revisions via
   `GET /projects/{id}/assignments` / `GET /pipelines/{id}/revisions`, `openapi.yaml:2729,2294`),
   CARRIES OVER panel (branch row from `useWorkspaces` head commit + dirty count; plan-input
   textarea prefilled from last agent message, assistant-refined if available; artifact check-boxes
   from W3), submit → `POST /projects/{id}/runs` with `source` + `inputs`; then the thread page
   shows the back-link chip ("started run #id · open ›") from `source_conversation_id`. Owns:
   dialog file, `ui/src/api/queries.ts`, `Conversation.tsx` (trigger + chip).
7. **W7 — Draft PR (L+, blocked).** ⛓ strictly after W4(a) accepted; out of phase 6 scope.
   Push integration + token-in-sandbox delivery + `NEXT` entry. Owns (later):
   `internal/integrations/github/`, `internal/workspace/git/`, worker launcher.

## 7. Acceptance checks

Browser checks against the real lab (real Claude agent, `pnpm dlx @playwright/cli`), with API
state before/after where marked.

1. **Thread rename**: on `/projects/<p>/conversations`, the h1 (`project-conversations-title`)
   text is `Threads — <project>`, not "Conversations"; the new-thread dialog
   (`new-conversation-dialog`) title still mentions "thread" copy; zero elements on the list or
   detail pages contain the visible word "conversation".
2. **Header (4f)**: on a manual thread with ≥1 turn, `conversation-meta` contains the repo name
   and an age (`<n>m`/`<n>h`); the controller badge (`controller-badge`) shows the
   "you're in control" state while the user holds control; a `stop-turn` button exists in the
   header. While a turn is active: click `stop-turn` → `turn-status` chip moves to cancelled/
   interrupted within the turn deadline (API: `GET /conversations/{id}` `turn` status changes
   from `running` → `cancelled`/`interrupted`).
3. **Permission card (4f)**: with a `permission_mode: ask` profile, start a turn that triggers a
   prompt (e.g. "edit this file and run it"); the transcript shows exactly 1 `permission-card`
   with ≥2 option buttons (`permission-allow` / `permission-reject` present); API before:
   `GET /conversations/{id}` `pending_permissions` length = 1. Click allow → the card renders the
   decided state and `pending_permissions` length = 0; event
   `conversation.permission.decided` appears on the stream with `status: decided`.
4. **Workspace rail (4f)**: after the agent edits a file in the thread, the rail's workspace
   section shows the repo name, the branch row, `changed ≥ 1` (or `dirty: N paths`), and
   base→head short commits; the head commit in the UI equals `head_commit` from
   `GET /projects/{p}/workspaces` for the row with `conversation_id` = the thread. Sandbox row
   shows a recorded verdict (not the empty-state copy) after the turn.
5. **Artifacts rail (4f)**: with an artifact created in the thread, the rail lists exactly the
   rows returned by `GET /projects/{p}/artifacts?conversation_id=<id>` (count equality, name +
   size visible); a sibling thread's rail shows 0 rows for its own id.
6. **Hand-to-workflow (5d)**: open the dialog from NEXT on a thread whose branch has ≥1 commit:
   the workflow picker lists only stable/published revisions; the branch row shows the workspace
   head commit; the plan textarea is prefilled (non-empty). After `Start <Workflow> run`:
   `GET /runs/{id}` → `status: queued`, `source_conversation_id` == thread id,
   `repo_snapshot[].base_commit` == the thread branch head commit (API evidence), `inputs`
   includes the plan value with `origin: submitted`; the thread page now shows a back-link to the
   run; the thread's transcript and status are unchanged (run starts fresh — no replay).
7. **Honest states**: a fresh thread with no turn shows the workspace empty-state copy and the
   sandbox empty-state copy; the NEXT panel contains no "draft PR" entry; the dialog with a clean
   branch shows the "starts from the default branch" copy.
8. **Regressions**: `issue2-conversations.spec.ts` and the M5 conversation suites still pass
   unchanged (testids `conversation-title`, `permission-allow`, `stop-turn`, `controller-badge`
   still present).

## 8. Open questions for the product owner

1. **Branch display name**: design says `thread/<slug>`; the real ref is
   `refs/heads/<conversation>/<repo>` (local mirror branch, `workspace.go:350`). Display-only
   relabel, or rename the actual ref (a persisted-state change → its own ADR)?
   *Default: display label only, keep the ref.*
2. **Plan summary source**: model-written via the assistant broker (costs a model call, may be
   unavailable) vs last-agent-message prefill? *Default: prefill from the last agent message,
   always editable; offer "ask assistant to summarize" as an enhancement.*
3. **Draft PR delivery**: worker-side push (server holds the token) vs agent-side push (token
   mounted in the sandbox, per the settled decision)? The settled decision implies agent-side,
   but the server-side broker is the spec 05:66-preferred path. *Default: follow the settled
   decision (agent-side) but have the ADR weigh the broker option explicitly.*
4. **Cross-project Threads view**: the sidebar nav item needs a cross-project thread list; add a
   backend aggregation endpoint now, or fan out project listings in the UI? *Default: UI fan-out
   (users belong to few projects); endpoint later.*
5. **Handoff authorization**: who may hand a thread to a workflow — any contributor+ (matching
   run creation), or must the thread's controller/approver act? *Default: contributor+ (same as
   starting a run); record actor + source conversation on the run.*
