# Wishlist gap — what the product owner can click today

Maps the product owner's nine wishlist items (W1–W9) onto this repo at HEAD (`e82a23b`): evidence per
item plus one smallest-next-step brief. Status vocabulary (`AGENTS.md`): `works end-to-end` (clickable
on the real compose stack) / `backend only` / `UI only` / `spec only` / `nothing`. A mocked-green unit
test never counts as end-to-end (`communication-spec/12-test-strategy.md`); where a claim rests on the
M4 exit driver the gate label is named.

## Summary

| Item | Status | Milestone | Smallest next step |
|---|---|---|---|
| W1 Browse projects + repositories | works end-to-end | M1 / M5 | Prove one `https://github.com/…` clone in the M4 driver |
| W2 Plan workflow with a human gate | works end-to-end (needs an existing assignment) | M4 / M5 | Add "Assign to project" button on the pipelines page |
| W3 GitHub-issue build run, fan out + join | spec only (trigger); fan-out backend only | M6 | Read-only GitHub issue query feeding run inputs |
| W4 Edit step prompts, drafts → publish | works end-to-end (YAML); per-step form spec only | M5 | Schema-driven node form pane in the draft editor |
| W5 Scheduled security workflow | nothing | M6 | New `schedules` table + driver tick (**migration needed**) |
| W6 APM skills, tag pin, cross-agent | backend only | M3 | `PATCH /agent-profiles` over the existing `apm_*` columns |
| W7 ACP agents in the worker image | works end-to-end (claude, codex) | M2 | Prove the ACP transcript inside a run attempt (gate W2) |
| W8 Shared one-off conversations | works end-to-end | M2 | Surface conversations on `/inbox` across projects |
| W9 In-UI assistant | spec only | M7 | Navigation-only assistant broker + Shell dock |

## W1 — Browse projects; see a project's repositories

**Spec.** `01-domain-model.md:42` (project → repositories), `05-workspaces-security-secrets.md:3`
(`repos/<name>` per run workspace), journey C0 in `docs/design/acceptance-checklist.md`. Milestone:
`11-build-roadmap.md:33` (M1 — "add two repositories, see consistent state across two API replicas").

**Backend.** `api/openapi.yaml:387,447,474` mounted at `internal/api/projects.go:121-127`; store
`internal/store/postgres/projects.go`. Accepted remotes are https/ssh, `file:///` or scp-style
(`projects.go:109-112`), so a **real GitHub URL is in contract**; the clone happens at run-prepare in
the worker — `internal/workspace/git/workspace.go:317` (`git clone --mirror` into the per-worker mirror)
and `:406-408` (worktree / clone-mode checkout). "Mocked" repos today = harness-local bare repos:
`e2e/m4/make_fixture_repo.sh` (`file:///srv/m4/fixtures/app.git`) behind the `.harness/repos:/repos`
mount (`compose.harness.yml:76`).

**UI.** `ui/src/pages/Projects.tsx` (route `/`), `ui/src/pages/Project.tsx:27-125` (REPOSITORIES panel +
add-repo form), `ui/src/components/Workspaces.tsx` (repo/ref/ dirty status on the same page),
`ActivityFeed.tsx`.

**Tests.** `internal/api/projects_test.go`, `internal/store/postgres/projects_test.go`,
`ui/src/pages/{Projects,Project}.test.tsx`; browser: `e2e/tests/m1-journey.spec.ts:52` (add
frontend+backend), `:60` (replicas agree), `:80` (SSE propagates a repo added on B), `:103` (restart
keeps data), `:131` (non-member 404).

**Status: works end-to-end.**

**Next step.** Nothing blocks clicking; the honest gap is that no proof has ever cloned over `https://`.
Add one arm to the M4 driver's W1 leg (`e2e/m4/e2e_m4_exit.py:8979`): register a public GitHub
`https://` repo, start a run, require the literal mirror/prepare output naming that URL plus the
`…/repos/{repositoryId}/status` body, and record it in `docs/compatibility/WORKSPACES.md`. No migration,
no UI change; if outbound git is unavailable in the lab the leg prints GAP, never PASS.

## W2 — "Plan" workflow with several steps, one needing human input

**Spec.** `03-pipeline-engine.md:15` (node catalogue: `human.approval`), `:51`, `01-domain-model.md:78`
(`run.waiting_human`), M4 exit "Plan→Approve→Implement→Test→Review→Loop" (`11-build-roadmap.md:59`),
acceptance C5 (`docs/design/acceptance-checklist.md`).

**Backend.** `human.approval` executes as a control-plane kind
(`internal/pipelines/runtime/advancer.go:542`; control-plane set `compiler/compiler.go:56-60`); config
`configHumanApproval` (summary, approverRoles, deadlineSeconds, onTimeout) in
`internal/pipelines/schema/assets/pipeline-v1alpha1.schema.json`; routes
`api/openapi.yaml:3299,3330,3359` → `internal/api/approvals.go:136-138`; store
`internal/store/postgres/{approvals,m4api_approvals}.go`, resume-on-decision (`52685c1`). Sample
plan+gate: `internal/pipelines/testdata/feature-development-contract.yaml:40,59`.

**UI.** `ui/src/components/m4/ApprovalCard.tsx` (inside `ui/src/pages/RunInspector.tsx`), cross-project
`/inbox` (`ui/src/pages/Inbox.tsx:109-217`, nav entry `ui/src/components/Shell.tsx:10`),
`ui/src/pages/ProjectRuns.tsx`.

**Tests.** `internal/pipelines/runtime/scenario2_test.go:159` (rejected = business outcome),
`runtime/testdata/gate_expire.yaml`, `internal/store/postgres/m4api_approval_resume_test.go`,
`ui/src/components/m4/ApprovalCard.test.tsx`, `ui/src/pages/Inbox.test.tsx:63`,
`ui/src/pages/RunInspector.test.tsx:175,209`; browser leg W3 (`docs/m4-contract.md:1337`,
`e2e/m4/e2e_m4_exit.py:9105-9216`: approver roles, non-approver sees no button, Approve posts
`/approvals/{id}/decide`).

**Status: works end-to-end — for a project that already has an assignment.** `NewRunForm` lists *enabled
assignments* (`ui/src/components/m4/NewRunForm.tsx:245-263`) and the pipelines page says "no pipeline
assignment is enabled for this project — there is nothing to run"
(`ui/src/pages/ProjectRunsPipelines.tsx:122`). The mutation hook `useCreateAssignment`
(`ui/src/api/pipelines.ts:249`) and the route (`internal/api/runs.go:533`) both exist, but **no page
calls the hook**: assigning a published revision is a curl/SQL step today.

**Next step.** Wire the orphan hook — no migration (`assignments` exists since
`migrations/00005_m4_pipelines.sql:134`). On `ui/src/pages/ProjectRunsPipelines.tsx`, add a
Maintainer-gated "Assign to this project" action per pipeline row calling
`useCreateAssignment(projectId)` with the newest revision id, then invalidate
`queryKeys.assignments(projectId)` so the runs page and `NewRunForm` pick it up without reload; reuse
the 409/version handling in `ui/src/api/pipelines.ts`. Verify: a new `it(...)` mirroring
`ui/src/pages/Library.test.tsx:119`, then `pnpm --dir ui test` + `pnpm --dir ui exec oxlint`.

## W3 — "Build" workflow driven by GitHub issues, fanning out and joining back

**Spec.** `07-config-integrations.md:23` ("Trigger/query/action provider contract": trigger = manual,
cron-like, **webhook, polling**; query = "list GitHub issues matching label"; action =
comment/close/PR), `03-pipeline-engine.md:15` (`for_each`, `parallel`, `join`, `pipeline.invoke`).
Milestone M6 (`11-build-roadmap.md:75` — "GitHub issue query/trigger/action adapter, webhook
verification/poll reconciliation"; exit "3 ready issues produce at most N in-flight child runs;
duplicate webhook does not duplicate logical work").

**Backend — fan-out: yes.** `for_each` executes (`internal/pipelines/runtime/advancer.go:546`, scope
rules `:997-1033`, `runtime/scope.go:17-64`, `onChildFailure` `:1315`) and joins the branch results back
into the parent scope's outputs (`advancer.go:1033,1157`) — which is what the sample contract uses.
Proven by `runtime/testdata/fanout_{collect,single,stop}.yaml` and
`runtime/scenario2_test.go:194,268,329`; child runs readable via `api/openapi.yaml:2862`
`/runs/{runId}/tree`.

**Backend — explicit join and issues: no.** `parallel`/`join`, `integration.query`/`integration.action`
are validated-but-refused in `deferredKinds` (`internal/pipelines/compiler/compiler.go:41-51`, "planned
for M5/M6"). There is **no `internal/integrations/` package at all** (`ls internal/integrations` → no
such file), no GitHub adapter, no webhook receiver, no invocation backlog:
`migrations/00005_m4_pipelines.sql:134` records the decision ("NO triggers, NO stable/beta channels")
and `runs.triggered_by` (`:175`, "NULL for a child or a system start") is the only trigger-adjacent
column.

**UI.** Fan-out is visible: `ui/src/components/m4/RunTree.tsx:2` ("node executions, iterations, fan-out
children and child runs"), `BranchGrid.tsx`, `RunStageStrip.tsx` — all mounted by
`ui/src/pages/RunInspector.tsx`. Runs start **manually** only: `NewRunForm.tsx:242-263` →
`POST /projects/{projectId}/runs` (`api/openapi.yaml:2661`, `internal/api/runs.go:538`). No UI mentions
issues, labels or webhooks (the `github` hits in `ui/src/**` are `git_url`).

**Tests.** Runtime tests above, `e2e/m4/test_c8_logic.py` (25-child tree logic), tree leg
`docs/m4-contract.md:1345`. Nothing drives a GitHub issue because there is nothing to drive.

**Status: spec only** for issue→run; fan-out + collect is `backend only` (clickable through the API/UI
once W2's assignment gap closes).

**Next step.** Do the read half only, **no migration**: `internal/integrations/github/query.go` with a
small `IssueQuery` interface (`List(ctx, repo, label, state)` over `GET /repos/{owner}/{repo}/issues`),
token from the existing `internal/secrets` scoped materialization (never env scraping), `httptest` unit
tests plus one `//go:build github_integration` test whose literal output is recorded in a new
`docs/compatibility/GITHUB.md` row. Expose it as read-only
`GET /api/v1/projects/{projectId}/repos/{repositoryId}/issues` next to
`internal/api/workspaces.go:102` and
let `NewRunForm` prefill inputs from the chosen issue. Keep `integration.query` in `deferredKinds` (the
node kind needs probe/reconcile semantics, `docs/m4-contract.md` § 7 case 6); webhook-triggered runs +
dedupe need a `triggers`/`invocations` table and an ADR.

## W4 — Edit each step's prompt / system prompt; save and publish drafts

**Spec.** `03-pipeline-engine.md:35` (canonical document & schema), `04-agent-runtime.md:26`
(`AgentProfileRevision.system_instructions` — the *profile*, not the node), M5 "draft editor"
(`11-build-roadmap.md:67`), E3 in `docs/design/acceptance-checklist.md` ("changes an agent profile **and
a prompt** … form fields come from the schema").

**Backend (complete for YAML).** `api/openapi.yaml:2111,2186,2287,2334` (create/get/put/delete draft,
`/validate`, `/publish`) → `internal/api/pipelines.go:374-380`; revisions/digests via
`internal/pipelines/canon` + ADR-0021; schema served at `GET /api/v1/schemas/pipeline-v1alpha1`
(`pipelines.go:384`). `agent.acp` requires `profile` + `prompt`
(`internal/pipelines/schema/assets/pipeline-v1alpha1.schema.json:581-593`) and `prompt` is a binding
template — the sample interpolates an upstream output at
`testdata/feature-development-contract.yaml:67`. The only `agent.acp` members are `profile, prompt,
sessionMode, fallback, context, workspace, secretRefs, structuredOutput`; **no
`systemPrompt`/`system_instructions` exists in Go, the schema or the UI** (the sole match is spec text
`04:26`).

**UI (YAML-level only).** `ui/src/components/m4/DraftEditor.tsx` is a monospace textarea plus
Save/Validate/Publish with server-owned validity (header rules, lines 1-19), mounted from
`ui/src/pages/Library.tsx` (`/library`, `/library/:pipelineId`). No per-node form exists;
`DefinitionGraph.tsx` is read-only and `ValidatePanel.tsx` renders findings.

**Tests.** `internal/api/m4routes_test.go`, `internal/pipelines/schema/schema_test.go`,
`ui/src/pages/Library.test.tsx:146,156,165,180` (editor opens with the served document; Publish strictly
gated on server `status: valid`; new draft seeded from the newest revision),
`ui/src/api/pipelines.test.tsx`; driver leg W8 (`docs/m4-contract.md:1342`) proves findings render with
location + milestone hint. No test edits a prompt through a form because there is no form.

**Status: works end-to-end** for "edit prompt text in YAML → validate → publish"; **spec only** for a
per-step prompt form and for any system-prompt concept (which `04:26` places on the profile,
unimplemented).

**Next step.** No migration, no new routes: a schema-driven node form pane in the draft editor. Add
`ui/src/lib/pipeline/nodeFields.ts` taking the served `GET /api/v1/schemas/pipeline-v1alpha1` document
plus the selected node's `kind`, selecting the matching `oneOf` branch (the discrimination the backend
already reports in `ValidatePanel` findings) and projecting `configAgentAcp` into labelled fields; each
edit writes back into the YAML text via `ui/src/lib/pipeline/yamlPointer.ts`, so the textarea stays
authoritative and `PUT /drafts/{id}` still carries the whole document. Mount as a right pane in
`DraftEditor.tsx`. Verify with a new `DraftEditor.test.tsx`: editing `prompt` moves the textarea; an
unknown `kind` renders "no editable fields"; the `409 stale_draft_version` path
(`DraftEditor.tsx:12-15`) still re-reads server text — then `pnpm --dir ui test`, `pnpm --dir ui exec
tsc --noEmit`. System prompts stay out of scope until an ADR decides node vs profile (`04:26`).

## W5 — A security workflow that runs on a schedule

**Spec.** `07-config-integrations.md:23` ("Trigger … cron-like schedule"), `03-pipeline-engine.md:51`,
M6 (`11-build-roadmap.md:79`: "Schedule triggers and lightweight invocation backlog").

**Backend: nothing.** `grep -rni "schedule\|cron" internal/store/postgres/migrations/*.sql` returns only
`attempts.scheduled_at` (a computed **retry backoff** landing time, `00005_m4_pipelines.sql:273`), the
outbox `CREATE TRIGGER` (`00001_m1_core.sql:125`) and index names — no `schedules`, `triggers` or
`invocations` table. `GET /api/v1/system/scheduler` (`api/openapi.yaml:3428`,
`internal/api/scheduler.go:10-24`) is **queue observability** (ADR-0023 counters), not a scheduler of
new work; the only Go tickers are the reconciler (`reconciler.go:157`) and the M4 driver
(`m4driver.go:242`), which advance existing runs. Every run is created by a user
(`internal/api/runs.go:538`) or a parent node.

**UI / tests: nothing.** `ui/src/pages/Operations.tsx` shows those counters and sandbox verdicts;
`schedule` strings in `ui/src/lib/pipeline/runEvents.ts` are `retry_scheduled` wording; there is no
behaviour to test. The absence is recorded in `compiler.go:41-51` and `00005_m4_pipelines.sql:134`.

**Status: nothing.**

**Next step (needs a migration — the only item that does).** Add
`internal/store/postgres/migrations/00006_schedules.sql`: `schedules(id, project_id, assignment_id,
cron_expr, enabled, next_run_at, last_run_at, version)` + partial index `(next_run_at) WHERE enabled`,
firing into `runs` with `triggered_by = NULL` (already nullable for "system start",
`00005_m4_pipelines.sql:175`). Tick it with the driver idiom (`m4driver.go:242`: `FOR UPDATE SKIP
LOCKED`, bounded by the assignment's in-flight limit) so a wedged replica cannot double-fire. Routes
`GET/POST /api/v1/projects/{projectId}/schedules` + `PUT /api/v1/schedules/{id}` in `internal/api/` and
`api/openapi.yaml` (public API + persistence ⇒ ADR). UI: a "When to run" block per assignment row in
`ui/src/pages/ProjectRunsPipelines.tsx` (next fire in words, toggle, last-run link). Verify: `go test
./internal/store/postgres -run Schedule` on real Postgres, a two-replica no-double-fire proof, a
Playwright leg toggling it. Until then the honest answer to "weekly scan" is a manual run plus external
`curl`.

## W6 — APM skills from a library, pinned at a git tag, portable across agents

**Spec.** `04-agent-runtime.md:16` (launcher registry incl. APM target), `:24-30` (`apm_package_ref` +
`apm_lock_digest`, per-run staging, "APM preparation is **not** itself isolation"), `:60` (lab item 7).
Milestone: M3 (`11-build-roadmap.md:50`).

**Backend (worker side, real).** `internal/agent/apm/stage.go` runs `apm install --frozen --target <t>`
in the checkout and **refuses the launch** when `sha256(apm.lock.yaml)` ≠ the profile's digest — the
documented answer to probe A5 (`--frozen` proves presence, not bytes; header `:1-25`), `PinnedVersion =
"0.33.0"` (`:51`), targets `claude`/`codex` only (`:62-67`); the store refuses unverifiable pins
outright (`internal/store/postgres/workspaces.go:559`), and `apm` itself is sha256-pinned into the
worker image (`worker/Dockerfile:77,90-96`).

**Backend (missing).** Profiles are **read-only over HTTP**: `api/openapi.yaml:752-767` ("Profiles are
read-only in M2; creating and publishing them (with APM refs and pinned revisions) is a later"
milestone); the only route is `GET /api/v1/agent-profiles` (`internal/api/conversations.go:270`), seeded
with two rows and no APM columns (`migrations/00003_m2_conversations.sql:68`) — the `apm_*` columns
arrived as bare `ALTER TABLE`s (`00004_m3_workspaces_secrets_artifacts.sql:459-464`) with no API to fill
them. No skill library, no browse, no tag→digest resolution: every probe package is a **local path**
(`docs/compatibility/probes/apm/fixtures/pkg-alpha/apm.yml`) and `docs/compatibility/APM.md:75-78` lists
git/registry-sourced dependencies as **still untested**. **UI: nothing** — `ui/src/pages/Library.tsx` is
the *pipeline* library, and profiles surface only as a launcher picker
(`ui/src/components/Conversations.tsx` via `useAgentProfiles`).

**Tests.** `internal/agent/apm` has **no `_test.go`**; evidence is observational:
`docs/compatibility/APM.md:19-27` — claude and codex both PASS T1 (generated paths), T2 (reproducible),
T6 (harness picks it up: "`claude -p` reported `alpha-skill`", "`codex exec` reported `alpha-skill`"),
and **FAIL T3 (isolation) / T4 (HOME untouched)**; M3 exit-run notes at `:81-96` (digest moves with
content; a tracked `apm.lock.yaml` cannot be git-excluded). Refusal behaviour is covered by
`internal/store/postgres` tests and `e2e/m3/e2e_m3_exit.py`.

**Status: backend only.** Portability is *observed for skills on two targets*, not an isolation claim
(`04:28-30`).

**Next step — no migration.** Expose the existing columns: add
`PATCH /api/v1/agent-profiles/{profileId}` (Maintainer+, optimistic `version`) setting
`apm_package_ref`/`apm_target`/`apm_lock_digest`, rejecting a ref with no digest as 422 using the rule
already enforced at `workspaces.go:559`; mount beside `internal/api/conversations.go:270`, mirror in
`api/openapi.yaml` (public API + profile identity ⇒ ADR, `04:24`). Then `ui/src/pages/Profiles.tsx` at
`/profiles`: rows with an APM section (ref, target, digest) plus "APM staging is not isolation"
(`04:28`). Git-tag pinning comes *after* and must be probed first — pin a public skills repo by tag in
`apm.yml`, confirm the lock records the resolved commit, and add that row to `docs/compatibility/APM.md`
before any UI offers a tag. Verify: new `internal/agent/apm/stage_test.go` (digest mismatch ⇒ refusal),
`go test ./internal/api ./internal/store/postgres -run Profile`, `pnpm --dir ui test`, a Playwright leg
on `/profiles`.

## W7 — ACP talks to coding agents installed in the worker image

**Spec.** `04-agent-runtime.md:7` (protocol baseline), `:16` (launcher registry: executable + argv, no
shell expansion, adapter version, compatibility status), `:42` (permission policy). Milestone M2
(`11-build-roadmap.md:42`), spiked in M0 (`:22`).

**Backend.** Launchers are compiled in — `worker/launchers.yaml` does not exist:
`internal/agent/acp/launchers.go:56-76` pins `claude` → `@agentclientprotocol/claude-agent-acp@0.90.0`
and `codex` → `@agentclientprotocol/codex-acp@2.2.2` with observed `protocolVersion 1` / `loadSession`
facts; runtime, permission bridge, cancel, preview, launch env in
`internal/agent/acp/{runtime,permission,preview,launchenv,sandbox}.go`. The adapters ship **in the
worker image** at those pins (`worker/Dockerfile:49-54`, symlinked entrypoints `:137-138`,
bundled-harness reasoning `:12-25`); `nono` and `apm` are version+sha pinned (`:75-77`).

**UI.** `ui/src/pages/Conversation.tsx` (413 lines) + `ui/src/components/Transcript.tsx` at
`/projects/:projectId/conversations/:conversationId` (`ui/src/App.tsx`).

**Tests.** `internal/agent/acp/{acp,factory,session,launchers}_test.go`; the real-adapter test is
build-tagged (`internal/agent/acp/integration_test.go:1`). Container evidence —
`docs/compatibility/ACP.md:81-93`: `acp:claude ok … protocol=1 loadSession=true` from *inside* the
worker image, live turns, session reuse, the `ask`-mode permission bridge, cancel mid-stream, SIGTERM →
`turn.interrupted` (never a false `completed`), resume-after-`docker-kill` via `session/load`. Browser:
`e2e/tests/m2-journey.spec.ts:122-226`. Operator check: `communication doctor --acp claude`
(`cmd/communication/doctor_acp.go`); image published by CI (ADR-0028, `9d92d32`).

**Status: works end-to-end** for Claude Code + Codex on linux/amd64; Gemini and Pi stay GAP rows
(`docs/compatibility/ACP.md:24-25`) until observed.

**Next step.** The conversation path is proven; the **run** path has no browser proof. Implement M4 leg
**W2** (`docs/m4-contract.md:1336`; today `_playwright_stub("W2", …)` at `e2e/m4/e2e_m4_exit.py:9098`):
open a live run page and require `run.created` → `node.attempt.started` → `conversation.turn.*` (the
agent node's ACP transcript inline) → `run.checkpoint_saved`, in order, with
`/build_until_verified[1]`/`[2]` rendered as iterations. Files: `gate_w2` in `e2e/m4/e2e_m4_exit.py` +
assertions in `e2e/m4/test_w_logic.py` (pattern from `4245c48`); no migration. Verify by running the
driver on `compose.m4.yml` and pasting the literal PASS line.

## W8 — One-off agent conversations, shared, grouped under a project

**Spec.** `06-collaboration-identity.md:11` ("Shared conversation model": controller lock, observer,
takeover/return), `01-domain-model.md:78` (turn state machines), `04-agent-runtime.md:24`. Milestone M2
(`11-build-roadmap.md:42`, exit: "user A starts Claude or Codex, user B observes permitted conversation
and takes over/returns control; restart API pods without losing transcript").

**Backend.** Routes `api/openapi.yaml:784,858,891,953,1049,1108,1156,1201` (list/create under the
**project**, get, messages, SSE, `take-control`, `return-control`, `cancel`, `permissions/{requestId}`)
→ `internal/api/conversations.go` (authz shape — non-member 404, viewer 403, controller-only 409, header
lines 19-36; profiles `:270`), durable store `internal/store/postgres/conversations.go` (2089 lines;
`ListAgentProfiles:225`, `AuthorizeConversation:273`, `CnvConflict:73`, `CnvTurn.IsActive:129`), stream
`internal/api/conversation_events.go`, worker loop `internal/worker/{agentturn.go,turnloop*.go}`.

**UI.** `ui/src/components/Conversations.tsx:43,144` (create + list) mounted on
`ui/src/pages/Project.tsx:394-403` under `#conversations`, i.e. grouped under the project;
`ui/src/pages/Conversation.tsx` (transcript, composer, permission prompt, take/return control);
`ui/src/api/transcript.ts`, live invalidation `ui/src/api/events.ts`.

**Tests.** `internal/api/{conversations,conversation_events}_test.go`,
`internal/store/postgres/{conversations,conversations_turns}_test.go`,
`internal/worker/agentturn_test.go`; UI `Conversation.test.tsx` (560 lines),
`ConversationNames.test.tsx`, `ProjectConversations.test.tsx`; browser
`e2e/tests/m2-journey.spec.ts:122` (alice starts a Claude conversation), `:146` (bob watches live on
replica B, read-only), `:160` (permission actionable vs read-only), `:181`/`:215` (take / return
control), `:226` (both replicas restart, transcripts identical).

**Status: works end-to-end.**

**Next step.** Nothing blocks it; cheapest deepening, no migration: list conversations **across**
projects on `/inbox` (today decisions / stalled / active only — `ui/src/pages/Inbox.tsx`), reusing
`useConversations` (`ui/src/api/queries.ts`) per readable project and the row from
`ui/src/components/Conversations.tsx`, so "who is waiting on me" is one click from login. Verify with an
`it(...)` in `ui/src/pages/Inbox.test.tsx` (style of `:63`) and a two-context Playwright arm from
`e2e/tests/m2-journey.spec.ts:89`.

## W9 — In-UI assistant that helps the user operate the app

**Spec.** `08-assistant.md:3` ("an **application agent**, not merely a chat pane"), `:38` (model
backing), `:42` (UI non-negotiables) and its tool list (`project.open`,
`pipeline.createDraft/updateNode/validate/publish`, `ui.navigate`, `ui.focus`, `ui.highlight`,
`question.ask`, `approval.request`), plus `09-api-events-data.md:77`. Milestone M7
(`11-build-roadmap.md:83`; edge `M5 --> M7` at `:17`). So far only a design artifact:
`docs/design/assistant-flow.md`.

**Backend: nothing.** `ls internal/assistant` → No such file or directory (the directory is promised in
`AGENTS.md`'s layout). No assistant routes exist; in `api/openapi.yaml` "assistant" is prose (`:120`
"assistant and GitOps sync are [later]", `:2302`) plus `source_kind: [manual, yaml_import, assistant,
clone]` on a **draft** (`:6093`) — the slot reserved for assistant-authored drafts, which nothing
writes. What M7 would broker is real: drafts/validate/publish, approvals, conversations, events,
`internal/authz/authz.go`.

**UI: nothing** (`grep -rn -i assistant ui/src --include=*.tsx` matches nothing; no route in
`ui/src/App.tsx`). **Tests.** None.

**Status: spec only.**

**Next step.** Build the **navigation** arm only — no migration, no new model contract. Create
`internal/assistant` with a `Broker` whose tools are exactly `project.list/open`, `pipeline.list`,
`run.inspect`, `conversation.open`, `ui.navigate`, `ui.focus` — read-only, each resolved through the
same `Caller` authz the HTTP routes use (a non-member gets the 404 rule of
`internal/api/conversations.go:31-36`), exposed as one conversation-style channel
(`POST /api/v1/assistant/messages` + SSE) using the `RegisterScheduler` idiom (`internal/api/scheduler.go:55`).
UI: a dock in `ui/src/components/Shell.tsx` (nav list `:10`) rendering answers as phrase buttons that
each call `navigate()`. Write tools come next (`createDraft`/`validate` reusing
`ui/src/api/pipelines.ts`, `source_kind: assistant` at `api/openapi.yaml:6093`), publish staying behind
an approval card. Verify: `go test ./internal/assistant` for the authz matrix (no tool may reach a
project the caller cannot read) and a Playwright leg — "how do I retry the failed run?" → phrase button
→ `/projects/:id/runs/:runId` with the failing node selected (`?node=`,
`ui/src/pages/RunInspector.test.tsx:314`). The assistant's model backend is a new external dependency +
security boundary (`08:38`) and needs an ADR before the first write tool.



