# Wishlist gap — what the product owner can click today

Maps the product owner's nine wishlist items (W1–W9) onto this repo at HEAD
(`09411da`): evidence per item plus one smallest-next-step brief. Status vocabulary
(`AGENTS.md`): `works end-to-end` (clickable on the real stack) / `backend only` /
`UI only` / `spec only` / `nothing`. A mocked-green unit test never counts as
end-to-end (`communication-spec/12-test-strategy.md`); **CHECKED LIVE** is claimed
only where a commit message or a `docs/compatibility/*.md` row records the literal
observed output. Since the previous version of this file (`6049308`, lab baseline
`e82a23b`) landed, among others: GitHub issue listing + start-from-issue (ADR-0031,
`4085f07`/`d777165`), writable APM profiles + Agents page + git-tag spike + live PASS
(ADR-0030, `fd7d2a4`/`e013cfd`/`fbf4fd5`, `docs/compatibility/APM.md:223`), `model.chat`
bindings (ADR-0029, `4c4ea6a`), scheduled runs end to end (ADR-0032, `2adf593`/`016f11e`),
the assign button (`3377934`), the draft-editor per-step form (`8706c9a`), pipeline
templates (`5fa3d52`), attempt transcripts (`231fc7a`), the conversation 6d layout +
Projects board (`854b2ef`), Inbox conversations/permission prompts (`da2aa31`), the
Overview dashboard (`fe39876`), the Ctrl K palette + read-only assistant (ADR-0034,
`9e03244`/`3cbf2a3`), sandbox shell startup files (ADR-0033, `9d2b907`), a home-cluster
worker (`faf9711`, `docs/samples/home/README.md`), and the attempt-permissions design
note (`docs/design/attempt-permissions.md`, `62a149c`).

## Summary

| Item | Status | Smallest next step |
|---|---|---|
| W1 Browse projects + repositories | works end-to-end (CHECKED LIVE: `e2e/tests/m1-journey.spec.ts`, M4 W1 leg) | Record one real `https://github.com/…` mirror clone in `docs/compatibility/WORKSPACES.md` |
| W2 Plan workflow with a human gate | works end-to-end (gate card CHECKED LIVE pass 3: "W3 21 PASS / 0 FAIL", `4cdedca`; assign button unit-tested, never clicked live) | Click Assign on a fresh project in the browser |
| W3 GitHub-issue run, fan out + join | issue list works end-to-end on public repos (real call observed, `docs/compatibility/GITHUB.md`); prefill wired, not clicked live; triggers/join spec only | Webhook/poll triggers: `triggers`+`invocations` tables + ADR (M6) |
| W4 Edit step prompts, drafts → publish | works end-to-end (YAML, per-step form, and templates — templates CHECKED LIVE, `5fa3d52`) | Re-run the driver's W4/W8 legs live since the `3654c18` fixes |
| W5 Scheduled security workflow | works end-to-end (schedule firing OBSERVED LIVE in the lab, 2026-10-16, `016f11e`; schedule UI CHECKED LIVE, `854b2ef`) | Home-cluster weekly `security-review` on a schedule (lab fire already observed) |
| W6 APM skills, tag pin, cross-agent | works end-to-end for the claude target (CHECKED LIVE, `docs/compatibility/APM.md:223-246`); codex target NOT RUN live | Run the same live probe with `target=codex` |
| W7 ACP agents in the worker image | works end-to-end (conversation path; run-attempt transcripts now journalled, `231fc7a`, but driver leg W2 is still a stub) | Implement `gate_w2` in `e2e/m4/e2e_m4_exit.py` |
| W8 Shared one-off conversations | works end-to-end (CHECKED LIVE: m2-journey browser; W8 leg `d1bbcc3`; 6d layout `854b2ef`) | Decide the attempt-permissions question (`docs/design/attempt-permissions.md`) |
| W9 In-UI assistant | backend + UI built and unit-tested (ADR-0034, `3cbf2a3`, `854b2ef`); NOT answered live — no model endpoint configured in the lab; write tools spec only | Configure `COMMUNICATION_ASSISTANT_*` on the home cluster's serve (the collective) and ask one question live |

## W1 — Browse projects; see a project's repositories

**Spec.** `01-domain-model.md` (project → repositories), journey C0 in
`docs/design/acceptance-checklist.md`; milestone M1.

**Backend + UI (unchanged shape, still mounted).** Projects/repos/members routes at
`internal/api/projects.go:121-127`; UI pages `Projects.tsx` (now a board with
attention counts and needs-me-first sorting, `854b2ef`), `Project.tsx` (REPOSITORIES
panel), one section nav + dashboard Overview (`fe39876`). Accepted remotes include
https, so a real GitHub URL is in contract; the clone happens at run-prepare in the
worker (`internal/workspace/git`).

**Live evidence.** Browser journey `e2e/tests/m1-journey.spec.ts` (add two repos,
two replicas agree, SSE propagation, restart keeps data, non-member 404); M4 driver
W1 leg (New-run form arms) ran live in passes 1–2 (`docs/m4-exit-status.md`).

**Status: works end-to-end** (CHECKED LIVE in the browser).

**Next step.** The honest gap is unchanged: no recorded proof of an `https://` clone
— `docs/compatibility/WORKSPACES.md` has zero `https://` rows (all harness-local
bare repos). Register a public GitHub repo in the lab, run a `process.exec` node
against it, and append the literal mirror/prepare output naming that URL to
`docs/compatibility/WORKSPACES.md`. If outbound git is unavailable in the lab, the
home cluster (which has egress) is the cheaper place to record it.

## W2 — "Plan" workflow with several steps, one needing human input

**Spec.** `03-pipeline-engine.md` (`human.approval`, run.waiting_human), M4 exit
"Plan→Approve→Implement→Test→Review→Loop", acceptance C5.

**Backend.** Unchanged and real: `human.approval` is a control-plane kind settled in
the advancer (`internal/pipelines/compiler/compiler.go:55-60` controlPlaneKinds);
approve/reject routes → `internal/api/approvals.go`, resume-on-decision since `52685c1`.

**UI.** `ApprovalCard.tsx` in the run inspector (plan rendered as a readable plan, not
raw JSON, `8e43ff6`; real agent plan step shapes rendered, `2b1d5d7`); cross-project
`/inbox`; the run page now says when a newer revision was published (`3654c18`);
inspector gained an always-on stage strip, attention filter and node crumb — CHECKED
LIVE on a running pipeline (`ae57b23`). The previously orphaned assign hook is wired:
a maintainer assigns a library pipeline from the project Pipelines page (`3377934`;
`useCreateAssignment` now called in `ui/src/pages/ProjectRunsPipelines.tsx:37`), and
`e0ee333`/`faf9711`/`5fa3d52` make it possible to have an unassigned pipeline to test
on (samples + templates).

**Live evidence.** Gate click-through ran in the M4 driver's W3 browser leg: pass 3
on lab `fbf4fd5` recorded "W3 21 PASS / 0 FAIL" (`4cdedca`). The assign button itself
is "unit-tested; not yet clicked live (every lab pipeline is already assigned)" —
verbatim from `3377934`'s commit message.

**Status: works end-to-end** — the gate path is CHECKED LIVE in the browser; the
assign click is not yet.

**Next step.** One Playwright arm (or a manual pass): fresh project → Pipelines →
Assign → Runs → New run, no curl. Then implement the still-stubbed run-page leg
`_playwright_stub("W2", …)` (`e2e/m4/e2e_m4_exit.py:10165` at HEAD) — see W7.

## W3 — "Build" workflow driven by GitHub issues, fanning out and joining back

**Spec.** `07-config-integrations.md` (trigger = manual/cron/webhook/polling; query =
"list GitHub issues matching label"), `03-pipeline-engine.md` (`for_each`, `parallel`,
`join`); milestone M6.

**Issue read half: landed.** ADR-0031 (`4085f07`) added `internal/integrations/github`
(`client.go`, `issues.go`, `repo.go`) and the read-only anonymous route
`GET /api/v1/projects/{projectId}/repos/{repositoryId}/issues`
(`internal/api/github_issues.go:90`). The real call is recorded with literal output in
`docs/compatibility/GITHUB.md` (HTTP 200, 3 open issues for `mattpocock/skills`,
2026-10-16) — the table there also records authenticated/private listing and webhooks
as **not verified / not built**. `d777165` put it in the New run form: for a GitHub
repo the form lists open issues and "Use this issue" fills the revision's declared
`goal`/`issue_number`/`issue_url` inputs (`ui/src/components/m4/NewRunForm.tsx:28,
238-249`); `87baaa2` shows issue titles in the picker. Non-GitHub remotes hide the
section. **Prefill itself has no recorded live click** — no commit or compatibility
row says it was clicked in a browser.

**Fan-out: backend works; explicit join still refused.** `for_each` executes and joins
branch results into the parent scope (`internal/pipelines/runtime/advancer.go`, proven
by `runtime/testdata/fanout_*.yaml` + `scenario2_test.go`); `parallel`/`join`/
`integration.query`/`integration.action` remain in `deferredKinds`
(`internal/pipelines/compiler/compiler.go:43-51`). Fan-out is visible in the run tree
(`RunTree.tsx`, `BranchGrid.tsx`). `e0ee333` named `fanout_items_exceeded` on the run.

**Trigger half: still nothing.** No webhook receiver, no `triggers`/`invocations`
tables, no polling reconciler; runs start manually, from a parent node, or (since
ADR-0032, W5) from a schedule.

**Tests.** `internal/api/github_issues_test.go`, `internal/integrations/github/client_test.go`
(httptest, pull_request skipping), `ui/src/pages/ProjectRunsPipelines.test.tsx`,
driver W3 leg (that's the gate leg — no issue arm).

**Status.** Issue listing: **works end-to-end** on public repos (CHECKED LIVE via the
real curl recorded in `GITHUB.md`; the route served the same shape in tests only).
Issue→run prefill: **backend + UI wired, no live click recorded**. Webhook-triggered
runs, dedupe, `parallel`/`join`: **spec only**.

**Next step.** No migration for the cheap half: one Playwright arm — open New run on a
project with a public GitHub repo, pick an issue, require the prefilled goal + number
to reach `POST /runs` and land in `run_inputs`. The expensive half (webhook trigger +
dedupe) needs a `triggers`/`invocations` schema and an ADR — keep it M6.

## W4 — Edit each step's prompt / system prompt; save, publish drafts, start from a template

**Spec.** `03-pipeline-engine.md` (canonical document & schema), M5 draft editor,
acceptance E3.

**Backend.** Unchanged and complete for YAML: draft/validate/publish routes
(`internal/api/pipelines.go`) over `api/openapi.yaml`, revisions + digests via
ADR-0021, schema served at `GET /api/v1/schemas/pipeline-v1alpha1`. `agent.acp` still
has **no system-prompt member** — system instructions belong to the profile revision
(`04:26`), and that remains undecided (the same call `docs/design/attempt-permissions.md`
waits on). `model.chat` bindings landed (ADR-0029, `4c4ea6a`): `config.messages` is
`{role, content}` with `content` a bindingText slot, resolved at claim time like
`agent.acp` prompts (`internal/pipelines/runtime/modelchat_config_test.go`,
`testdata/model_chat_bindings.yaml`) — this is what makes the home-cluster samples'
prompts interpolate.

**UI.** Three additions since `e82a23b`: the **per-step form** (`8706c9a`) — pick a
node, edit the fields its kind has (`config.profile`, `config.prompt`,
`timeoutSeconds` for `agent.acp`), each edit written back into the YAML text in place
so the textarea stays authoritative (`ui/src/lib/pipeline/nodeFields.ts:15-68`,
`DraftEditor.tsx:254` `NodeForm`); **templates** (`5fa3d52`) — New pipeline offers
Blank or the two vetted `docs/samples/home/` pipelines, with a drift test pinning the
UI copies byte-for-byte, CHECKED LIVE ("created from 'Plan with approval', the server
validated the draft as valid"); and Validate working right after pasting (`3654c18`).

**Live evidence.** Templates CHECKED LIVE (`5fa3d52`). The W4 browser leg ran at
`d1bbcc3` ("61 PASS, 2 FAIL, 1 GAP" — the W4 FAIL was the missing newer-revision
notice, fixed in `3654c18`); **no commit records a W4 re-run after that fix**, so the
leg's current verdict is unrecorded. The per-step form itself has unit tests
(`nodeFields.test.tsx`, `DraftEditor.test.tsx`) but no recorded live click.

**Status: works end-to-end** for YAML edit→validate→publish and for template-start
(CHECKED LIVE); the per-step form is **UI wired** (unit-tested, not clicked live);
system prompts stay **spec only** until an ADR decides node vs profile.

**Next step.** Re-run the driver's W4/W8 legs on a lab at HEAD and record the verdict
(they passed 61/63 before the fixes; `554092a` also fixed driver bugs since). Then one
Playwright arm editing an `agent.acp` step's `prompt` through the form and publishing.

## W5 — A security workflow that runs on a schedule

**Spec.** `07-config-integrations.md` ("cron-like schedule"), M6 "Schedule triggers".

**Backend: landed end to end.** ADR-0032 (`2adf593`): `schedules` table
(`internal/store/postgres/migrations/00006_m6_schedules.sql`), a 5-field UTC cron
parser, and a tick that fires an assignment's pinned revision with fixed inputs —
`FOR UPDATE SKIP LOCKED`, keyed per slot so a second tick cannot double-fire; missed
slots fire once, never backfill; real-Postgres tests cover concurrent ticks
(`internal/store/postgres/schedules{,_api}.go`). Wired into serve (`016f11e`): 30 s
tick where the pipeline scheduler is on, plus
`GET/POST /api/v1/projects/{projectId}/schedules` and `PATCH /api/v1/schedules/{id}`
(`internal/api/schedules.go:116-118`, `invalid_cron` named).

**UI.** Per-assignment "When to run" block on the project Pipelines page — schedules
with next run, toggle, last run, and maintainer-added hourly/daily/weekly presets from
the revision's declared inputs (`016f11e`; `ui/src/pages/ProjectRunsPipelines.tsx:445-480`,
`ui/src/api/pipelines.ts:330-349`). `854b2ef` CHECKED LIVE in the browser: "Schedules
show on/paused correctly".

**Live cron fire OBSERVED.** 2026-10-16 in the lab at `016f11e` (serve wiring): an
every-minute schedule (`* * * * *`) on the assignment of
`feature-development-deterministic` fired at `09:20:00Z` and `09:21:00Z` UTC —
exactly 2 `schedule.fired` events over two minutes with **two serve replicas**
ticking (no double fire) — each fire creating a run that advanced to
`waiting_human` at the approval gate; `PATCH enabled=false` then stopped it.

**What is NOT recorded.** The security-review sample
(`docs/samples/home/security-review.yaml`) has never been shown on a schedule.

**Status: works end-to-end** — schedule firing OBSERVED LIVE in the lab
(2026-10-16, `016f11e`, deduped across two replicas); schedule display CHECKED LIVE
(`854b2ef`); the concurrency semantics also covered by real-Postgres tests
(`2adf593`).

**Next step.** On the home cluster, schedule `security-review` weekly and paste the
`run.created` row with `triggered_by` NULL plus the schedule's `last_run_at`
before/after. No migration, no new code expected.
## W6 — APM skills from a library, pinned at a git tag, portable across agents

**Spec.** `04-agent-runtime.md` (launcher registry, `apm_package_ref` +
`apm_lock_digest`, "APM preparation is **not** itself isolation"); milestone M3.

**Backend: writable profiles landed.** ADR-0030 (`fd7d2a4`): org admins
`POST /api/v1/agent-profiles` and `PATCH /api/v1/agent-profiles/{profileId}`
(`internal/api/agent_profiles.go:70-76`, `api/openapi.yaml:838,922`), writing the
`apm_package_ref`/`apm_target`/`apm_lock_digest` triple together (ref without digest
refused). The ref grammar is the one the git-tag spike proved
(`mattpocock/skills#v1.3.1`). Staging was fixed live-forward: the first end-to-end
probe FAILed ("No apm.yml found", `aa5f59e`, Findings F1/F2 in
`docs/compatibility/APM.md:162-220`), and ADR-0030 amendment 1 (`fbf4fd5`) made
`Stage` materialize the manifest from the ref, run `apm lock`, install `--frozen`,
refuse on digest mismatch, and git-exclude the generated files.

**Git-tag pinning: spiked and recorded.** `4e367ee` + `docs/compatibility/APM.md:112-160`:
T-tag-1..5 all PASS in the worker image — the lock records `resolved_commit`, a frozen
reinstall (even offline) is byte-identical, a different tag moves the digest, and
`--skill` selects one of 27 skills with the subset persisted in the lock. Conclusion
recorded there: `sha256(apm.lock.yaml)` pins a tag's content; keep `--frozen`.

**Live PASS.** `docs/compatibility/APM.md:223-246` ("Re-run after ADR-0030 Amendment 1
— PASS", `4951c0f`): profile `skills-demo` pins `mattpocock/skills#v1.3.1`/claude; a
live conversation turn completed and the agent listed all 27 pinned skill names
(including `grill-me`, which the host `~/.claude` does not contain). **Codex target NOT
RUN** live; the checkout-cleanliness property is unit-test-only
(`internal/agent/apm/stage_test.go`), recorded honestly.

**UI.** `ui/src/pages/Agents.tsx` at `/agents` (`e013cfd`, nav in
`ui/src/components/Shell.tsx:15`): rows with each profile's APM ref/target/digest and
a form that sets or clears the triple together. "Rendered live against the lab; the
write path awaits a lab rebuilt past fd7d2a4" per the commit message — the write path
itself was exercised via API in the PASS re-run ("created via POST + PATCH, 201/200").

**Status: works end-to-end for the claude target**, CHECKED LIVE per
`docs/compatibility/APM.md:223-246`; cross-agent portability is **observed for skills
on two targets in the offline probes only** (claude+codex PASS T1/T2/T6; T4 HOME FAIL
→ per-run HOME required), **not** an isolation claim.

**Next step.** Run the same live probe with `target=codex` and append the row to
`docs/compatibility/APM.md`; then click the profile create + APM attach through
`/agents` in a browser (the form's write path has only been proven via API and unit
tests). Skill-library browsing (search a registry) stays Later.

## W7 — ACP talks to coding agents installed in the worker image

**Spec.** `04-agent-runtime.md` (protocol baseline, launcher registry, permission
policy); milestone M2.

**Backend.** Unchanged shape: launchers compiled in at `claude-agent-acp@0.90.0` /
`codex-acp@2.2.2` (`internal/agent/acp/launchers.go`), adapters shipped in the worker
image (`worker/Dockerfile`), `nono`+`apm` sha-pinned. New since the baseline: attempt
transcripts (`231fc7a`) — a run's agent-attempt session now feeds the same M2 turn
sink, so the attempt's conversation carries the real transcript (found live: it
carried only `turn.completed` before). Sandbox shells can now read their two startup
files read-only (`9d2b907`, ADR-0033) — before/after repro recorded in
`docs/compatibility/SANDBOX.md:131-145`; the denial was seen live in a pipeline
agent's transcript (`/etc/bash.bashrc: Permission denied` on every Bash call).

**Cluster worker.** A second worker runs on the home k8s cluster and executes
`process.exec`, `model.chat`, `artifact.publish` — but its `agent.acp` waits on an
owner-provided Claude credentials secret that is not mounted yet
(`docs/samples/home/README.md`: the samples are built "without ACP credentials").

**Live evidence.** Conversation path: `docs/compatibility/ACP.md:22-23` (both adapters
PASS turn/permission/cancel/`loadSession` rows), browser `e2e/tests/m2-journey.spec.ts`,
operator check `communication doctor --acp claude`. Run path: the transcript is
journalled (found live) but the contract's browser leg is still a stub —
`_playwright_stub("W2", …)` at `e2e/m4/e2e_m4_exit.py:10165` (HEAD).

**Status: works end-to-end** for Claude Code + Codex conversations (CHECKED LIVE);
the run-attempt transcript is **backend wired**, its browser proof outstanding. Gemini
and Pi stay GAP rows in `docs/compatibility/ACP.md`.

**Next step.** Implement `gate_w2` (run page: `run.created` → `node.attempt.started`
→ `conversation.turn.*` inline → checkpoint, in order) and paste the literal PASS.
On the cluster, mounting the owner's Claude secret turns the samples into full-agent
pipelines — a credentials decision, not code.

## W8 — One-off agent conversations, shared, grouped under a project

**Spec.** `06-collaboration-identity.md` (shared conversation model: controller lock,
observer, takeover/return); milestone M2 exit.

**Backend.** Unchanged and real: project-scoped conversation routes, controller-only
take/return with 409s, durable store + SSE (`internal/api/conversations.go`,
`internal/store/postgres/conversations.go`, `internal/worker/{agentturn,turnloop*}.go`).

**UI.** Conversations now surface **across projects on `/inbox`** — active
conversations and pending permission prompts, "who is waiting on me" (the previous
version's Next step, shipped in `da2aa31`; `ui/src/pages/Inbox.tsx:68-133`). The
conversation page got the 6d layout (`854b2ef`, CHECKED LIVE in the browser):
transcript centre, compact tool rows, context column (part of run / workspace /
sandbox / controller), JSON plans rendered as plans, and honest wording when no
sandbox verdict was recorded. Permission prompts inside runs are the open design
question — `docs/design/attempt-permissions.md` (`62a149c`) documents the accepted
behaviour (unattended `ask` prompts are cancelled, not hung) and the owner's options.

**Live evidence.** `e2e/tests/m2-journey.spec.ts` (start/observe/take/return/restart);
driver W8 leg ran live at `d1bbcc3` (its one FAIL — Validate disabled until the select
was touched — was fixed the same day in `3654c18`, re-run unrecorded).

**Status: works end-to-end**, CHECKED LIVE (m2-journey browser; 6d layout `854b2ef`).

**Next step.** Nothing blocks clicking. The real gap is product: choose an
attempt-permissions option (`docs/design/attempt-permissions.md` — recommendation:
`process.exec` for test steps now, lab-evaluate `preapproved_within_sandbox`); until
then an agent step that needs a write dies its run and the Inbox shows a prompt nobody
can answer.

## W9 — In-UI assistant that helps the user operate the app

**Spec.** `08-assistant.md` (application agent, tool list, UI non-negotiables);
milestone M7.

**Backend: the read-only half landed.** ADR-0034 (`3cbf2a3`): `internal/assistant/`
(`broker.go`, `exec.go`, `loop.go`, `model.go`, `routes.go`) +
`POST /api/v1/assistant/ask` (`api/openapi.yaml:3783`, `internal/api/assistant.go`).
A bounded tool loop over existing store reads **with the caller's permissions**; tool
output is treated as untrusted data; links survive only if they match the app-route
allowlist (`internal/assistant/routes.go:12-50`); nothing is stored; without
`COMMUNICATION_ASSISTANT_*` the route answers 503 `assistant_not_configured`
(`internal/api/assistant.go:161`) so the palette degrades honestly. Write tools
(`pipeline.createDraft/validate/publish`, `question.ask`, `approval.request`) are
unbuilt; `source_kind: assistant` remains a reserved slot.

**UI.** Ctrl K / Ask box as a quick-jump palette over pages, projects, pipelines,
recent runs and agents (`9e03244`, CHECKED LIVE); the Ask row backed by
`POST /assistant/ask` (`854b2ef`; `ui/src/api/assistant.ts`,
`ui/src/components/CommandPalette.tsx`). What was CHECKED LIVE in the browser is the
**rendering** of the Ask row in the palette — no live model has answered through it,
because no `COMMUNICATION_ASSISTANT_*` endpoint is configured in the lab. It says
"jump only" until an assistant model is configured.

**Live evidence beyond the browser.** The W9 driver legs ran with 61 PASS overall
(`d1bbcc3`), and after the erin seed "every W9 arm PASSes (404s, no project/node/digest
in the DOM, SSE never opens); the carol-literal arm stays an honest GAP" (`763c3c4`) —
that proves the authz/privacy side live. An actual answered question depends on an
assistant model being configured in the lab; no compatibility row claims one.

**Status: backend + UI built and unit-tested** as a **read-only** ask/navigate
assistant (ADR-0034, `3cbf2a3`, `854b2ef`; outsider privacy CHECKED LIVE `763c3c4`);
**NOT answered live — no model endpoint configured in the lab**. Write tools and the
phrase-button navigation flow: **spec only** (`docs/design/assistant-v1.md`).

**Next step.** Configure `COMMUNICATION_ASSISTANT_*` on the home cluster's serve (the
collective) and ask one question live, recording the question→answer→route-link click in
the browser (append to the W9 driver leg). Write tools need the ADR `08:38` names (new
external dependency + security boundary) before the first one ships, publish staying
behind an approval card.

## What still blocks a click-through on the home cluster

1. **Claude credentials secret.** The cluster worker runs `process.exec`, `model.chat`
   and `artifact.publish` today; `agent.acp` needs the owner-provided Claude secret
   mounted (none exists in the repo or the samples — `docs/samples/home/README.md`,
   `faf9711`). Until then no W7/W8 flow is clickable there, only the model.chat
   samples.
2. **The permission-prompt decision.** Inside a run, an `ask`-mode prompt with no
   human controller is cancelled (`ask_unattended`), so an agent step that needs a
   write fails its run; options and recommendation are in
   `docs/design/attempt-permissions.md` (`62a149c`). Option 1 (test steps as
   `process.exec`) needs no code — the samples already follow it.
3. **Assistant model.** Without `COMMUNICATION_ASSISTANT_*` on serve, Ask answers 503
   `assistant_not_configured` (`internal/api/assistant.go:161`) — the palette jumps,
   it does not answer.
4. **One model on the chat allowlist.** The cluster worker's
   `COMMUNICATION_MODEL_CHAT_MODELS` allowlists a single model today
   (`docs/samples/home/README.md`); anything else is refused at execution
   (`internal/worker/modelchat.go:308`).
5. **No resource limits.** The Operations page now says so openly (C13f, `09411da`);
   a noisy `process.exec` step is unbounded on the cluster.
6. **Run-attempt transcript leg unproven.** The behaviour shipped (`231fc7a`) but the
   browser proof is still `_playwright_stub("W2", …)` (`e2e/m4/e2e_m4_exit.py:10165`).
