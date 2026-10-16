# Wishlist gap — what the product owner can click today

Maps the product owner's nine wishlist items (W1–W9) onto this repo at HEAD
(`2f0fe1f`): evidence per item plus one smallest-next-step brief. Status vocabulary
(`AGENTS.md`): `works end-to-end` (clickable on the real stack) / `backend only` /
`UI only` / `spec only` / `nothing`. A mocked-green unit test never counts as
end-to-end; **CHECKED LIVE** is claimed only where a commit message or a
`docs/compatibility/*.md`, `docs/m4-live-findings.md` or `docs/m4-exit-status.md`
row records the literal observed output (`communication-spec/12-test-strategy.md`). Landed since the previous
refresh (`0e95e03`) — all cited with shas below: real-Claude plan → approve →
iterations live (still failing before `until_exhausted`, under investigation); W3
gate card 21/0/0 on a real Claude plan; Inbox auto-refresh + two-user Inbox spec 6/6
live; Library guards, all-kind step form, read-only templates, per-project assign
panel (browser-checked); run-page fixes at 390px (browser-checked); non-member 404s;
retry-404 (ADR-0037); `for_each` stop cancels queued siblings. Scoreboard at live9: PASS 54 / FAIL 8 / GAP 17 / NOT RUN 6 (`4a248d8`).

## Summary

| Item | Status | Smallest next step |
|---|---|---|
| W1 Browse projects + repositories | works end-to-end (CHECKED LIVE: `e2e/tests/m1-journey.spec.ts`, M4 W1 leg) | Record one real `https://github.com/…` mirror clone in `docs/compatibility/WORKSPACES.md` |
| W2 Plan workflow with a human gate | works end-to-end (gate card CHECKED LIVE 21/0/0 **on a real Claude plan**, live9 `4a248d8`; the real-Claude loop reaches plan→approve→iterations but still dies before exhaustion — under investigation, `4b4bfb8`/`35a9acf`/`d32a66f`; Retry 404 semantics ADR-0037 `13b81fb`; M5 journey step-6 fix `ef470a0` awaiting re-run) | Re-run `e2e/tests/m5-journey.spec.ts` live (COMMUNICATION_E2E_M5=1) and diagnose the `[3]/review` death |
| W3 GitHub-issue run, fan out + join | issue list works end-to-end on public repos (real call observed, `docs/compatibility/GITHUB.md`); prefill wired, not clicked live; `pipeline.invoke` children **CHECKED LIVE** at live7 (C8 31 PASS / 0 FAIL / 2 GAP, `9d50da0`); `for_each` stop-cancels-siblings backend landed (`d8b927c`), its C8e re-run pending; triggers/join spec only | One Playwright arm clicking issue→prefill→`run_inputs`; re-run C8e on a lab at `d8b927c`+; webhook/poll triggers need `triggers`+`invocations` tables + ADR (M6) |
| W4 Edit step prompts, drafts → publish | works end-to-end (YAML edit→validate→publish; templates visible read-only to everyone + per-project assign panel CHECKED LIVE on the lab, `9be68fd`; role-gated read-only editor, unsaved guard, per-step fields for all kinds `8f28cb3` — unit-tested, form itself never clicked live) | One Playwright arm editing an `agent.acp` step's `prompt` through the form and publishing |
| W5 Scheduled security workflow | works end-to-end (schedule firing OBSERVED LIVE in the lab, 2026-10-16, `016f11e`; schedule UI CHECKED LIVE, `854b2ef`) | Home-cluster weekly `security-review` on a schedule (lab fire already observed) |
| W6 APM skills, tag pin, cross-agent | works end-to-end for the claude target (CHECKED LIVE, `docs/compatibility/APM.md:223-246`); codex target NOT RUN live | Run the same live probe with `target=codex` |
| W7 ACP agents in the worker image | works end-to-end (conversation path; agent-turn egress allowlist CHECKED LIVE, `docs/compatibility/SANDBOX.md:429-481`, `9e83e12`; run-attempt transcripts journalled, `231fc7a`; the W2 run-page leg **PASSed live9** — 17/0/2, mid-lease arm caught a real leased attempt, `1e75c23`/`4a248d8`; run page browser-checked at 390px, `e609b00`) | Run the agent-arm legs (C1c to exhaustion, C4e's `agent.acp` fence `2f0fe1f`) in a fresh pass once the `[3]/review` death is captured |
| W8 Shared one-off conversations | works end-to-end (CHECKED LIVE: m2-journey browser; 6d layout `854b2ef`; two-user pending-prompt→Inbox spec **6/6 live**, `7dbc8d2`/`docs/m4-exit-status.md:208`; Inbox self-refreshes every 7.5 s, `699c3ff`); permission mode decided for the **lab only** (ADR-0036, `382d42b`) — product default still `ask` | Record one live conversation turn whose `sandbox.egress_observed` proves the `382d42b` journalling; then the product-mode decision |
| W9 In-UI assistant | backend + UI built and unit-tested (ADR-0034, `3cbf2a3`, `854b2ef`); NOT answered live — the home cluster now sets `COMMUNICATION_ASSISTANT_*` (`docs/home-cluster.md`) but no answer is recorded there, and the lab has no model; write tools spec only | Ask one question live on the home cluster and record question→answer→route-link click |

## W1 — Browse projects; see a project's repositories

**Spec.** `01-domain-model.md` (project → repositories), journey C0 in
`docs/design/acceptance-checklist.md`; milestone M1.

**Backend + UI (unchanged shape, still mounted).** Projects/repos/members routes at
`internal/api/projects.go:121-127`; UI pages `Projects.tsx` (now a board with
attention counts and needs-me-first sorting, `854b2ef`), `Project.tsx` (REPOSITORIES
panel), one section nav + dashboard Overview (`fe39876`). `5145bcb` hardened the
outsider view (unit-tested, landed after pass 9, not re-run live): non-members get
the same 404 as an unknown project on the project runs/schedules routes
(`internal/api/runs.go`, `internal/api/schedules.go`), pages show "not found or no
access" instead of a half-rendered shell
(`ui/src/components/ProjectUnavailable.tsx`), unknown actors read "a member".
Accepted remotes include https, so a real GitHub URL is in contract; the clone
happens at run-prepare in the worker (`internal/workspace/git`).

**Live evidence.** Browser journey `e2e/tests/m1-journey.spec.ts` (add two repos,
two replicas agree, SSE propagation, restart keeps data, non-member 404); M4 driver
W1 leg ran live in passes 1–2 (`docs/m4-exit-status.md`).

**Status: works end-to-end** (CHECKED LIVE in the browser).

**Next step.** No recorded proof of an `https://` clone —
`docs/compatibility/WORKSPACES.md` has zero `https://` rows (all harness-local bare
repos). Register a public GitHub repo, run a `process.exec` node against it, append
the literal mirror/prepare output there (home cluster is the cheaper place).

## W2 — "Plan" workflow with several steps, one needing human input

**Spec.** `03-pipeline-engine.md` (`human.approval`, run.waiting_human), M4 exit
"Plan→Approve→Implement→Test→Review→Loop", acceptance C5.

**Backend.** Unchanged and real: `human.approval` is a control-plane kind settled in
the advancer (`internal/pipelines/compiler/compiler.go:55-60` controlPlaneKinds);
approve/reject routes → `internal/api/approvals.go`, resume-on-decision since `52685c1`.

**UI.** `ApprovalCard.tsx` in the run inspector (readable plan, not raw JSON,
`8e43ff6`/`2b1d5d7`); cross-project `/inbox`; newer-revision notice on the run page
(`3654c18`); the inspector's stage strip / attention filter / node crumb — CHECKED
LIVE on a running pipeline (`ae57b23`). The pipeline page offers the maintainer's
projects lacking a just-published pipeline (`bb43fcc`); the run page's Retry control
arms only when a target exists — a rejected gate is final, 409 `run_not_retriable`
(`internal/api/runs.go:71`, `a3004c0`) — and since `13b81fb` a retry naming a node
execution the run lacks answers 404 `node-execution-not-found`, not 500 (ADR-0037).
Since `35a9acf` the plan gate shows the objective and a short summary Claude writes,
not the raw `findings`/`steps` arrays (`docs/compatibility/probes/m4/README.md`).

**Live evidence.** Gate click-through ran in the M4 driver's W3 browser leg: pass 9
recorded **21 PASS / 0 FAIL / 0 GAP** — "the whole card rendered off a real Claude
plan for the first time", bob has no Approve button, alice's click decides
(`4a248d8`, `live9/W3.out:26-55`, `docs/m4-exit-status.md:121`; pass 3's PASS
`4cdedca` superseded). Behind the gate the real-Claude agent arm now gets `/plan`
succeeded → `/approve` succeeded → iterations `[1]` and `[2]` implement/review/test
all succeeded, dying at `/build_until_verified[3]/review` attempt 2 — **cause under
capture, not diagnosed in that pass** (`4b4bfb8`+`35a9acf` build, `4a248d8`,
`live9/C1.out:46, :70`); `d32a66f` tightened review/implement outputs afterwards.
The pipeline-page assign panel was clicked live (`8c4377c`). The M5 exit journey ran
**12 passed / 1 failed / 4 not run** on the lab — step 6's assumption (exit 1 is a
failure) is wrong for the engine; fixed in `ef470a0`, re-run pending
(`docs/m4-exit-status.md:205-208`).

**Status: works end-to-end** — gate card on a real Claude plan CHECKED LIVE
(live9, `4a248d8`); the full agent loop plan→approve→iterations is observed live but
**still fails before exhaustion — under investigation**. The Retry control is UI
built + unit-tested with the 404 semantics live-checked (`13b81fb`); M5 journey
re-run pending.

**Next step.** Diagnose the `[3]/review` attempt-2 death (`live9/C1.out:62-65`),
then re-run C1c to a real `until_exhausted` verdict; re-run
`e2e/tests/m5-journey.spec.ts` live (`COMMUNICATION_E2E_M5=1`) since `ef470a0`.

## W3 — "Build" workflow driven by GitHub issues, fanning out and joining back

**Spec.** `07-config-integrations.md` (trigger = manual/cron/webhook/polling; query =
"list GitHub issues matching label"), `03-pipeline-engine.md` (`for_each`, `parallel`,
`join`); milestone M6.

**Issue read half: landed.** ADR-0031 (`4085f07`) added `internal/integrations/github`
(`client.go`, `issues.go`, `repo.go`) and the read-only anonymous route
`GET /api/v1/projects/{projectId}/repos/{repositoryId}/issues`
(`internal/api/github_issues.go:90`). `docs/compatibility/GITHUB.md` records the real
call with literal output (HTTP 200, 3 open issues for `mattpocock/skills`, 2026-10-16);
the table there also records authenticated/private listing and webhooks as **not
verified / not built**. `d777165` put it in the New run form: for a GitHub
repo the form lists open issues and "Use this issue" fills the revision's declared
`goal`/`issue_number`/`issue_url` inputs (`ui/src/components/m4/NewRunForm.tsx:28,
238-249`; titles in the picker from `87baaa2`). **Prefill itself has no recorded live
click** — no commit or compatibility row says it was clicked.

**Fan-out: backend works; explicit join still refused.** `for_each` executes and joins
branch results into the parent scope (`internal/pipelines/runtime/advancer.go`, proven
by `runtime/testdata/fanout_*.yaml` + `scenario2_test.go`); `parallel`/`join`/
`integration.query`/`integration.action` remain in `deferredKinds`
(`internal/pipelines/compiler/compiler.go:43-51`). Fan-out is visible in the run tree
(`RunTree.tsx`, `BranchGrid.tsx`). `pipeline.invoke` child runs (name-or-id resolution
in the org, `21656f6`) are **now proven live**: the C8 rerun at pass 7 came back
**31 PASS / 0 FAIL / 2 GAP** — 25 invoke keys, 25 child runs, `outputs.children`
real, peak concurrency 3 measured over `node_executions`, cancel cascade works,
`child_depth_exceeded` refused at validate (`b977ee4` compiler guard confirmed live)
(`04f53fd` build, recorded `9d50da0`, `docs/m4-exit-status.md:84-91`). C8e (stop /
`fail_after_all` child policies) was the GAP needing a second published parent
revision: the advancer now gives queued siblings cancelled rows and journals
`node.execution_cancelled{on_child_failure_stop}` (`d8b927c`), and the driver
publishes its own stop/fail_after_all parents (`b2bfe62`) — **not yet re-run live**.

**Trigger half: still nothing.** No webhook receiver, no `triggers`/`invocations`
tables, no polling reconciler; runs start manually, from a parent node, or (since
ADR-0032, W5) from a schedule. Unit tests: `internal/api/github_issues_test.go`,
`internal/integrations/github/client_test.go` (httptest).

**Status.** Issue listing: **works end-to-end** on public repos (CHECKED LIVE via the
real curl in `GITHUB.md`). Issue→run prefill: **backend + UI wired, no live click
recorded**. Child runs via `pipeline.invoke`: **works end-to-end, CHECKED LIVE** at
pass 7 C8 31/0/2 (`9d50da0`); the `for_each` stop policy is **backend landed
(`d8b927c`), live proof pending the C8e re-run**. Webhook triggers, dedupe,
`parallel`/`join`: **spec only**.

**Next step.** The cheap half, no migration: one Playwright arm — open New run
on a project with a public GitHub repo, pick an issue, require the prefilled goal +
number to reach `POST /runs` and land in `run_inputs`. Then re-run C8e on a lab at
`d8b927c`+ (`b2bfe62`'s driver leg exists). The expensive half (webhook
trigger + dedupe) needs a `triggers`/`invocations` schema and an ADR — keep it M6.

## W4 — Edit each step's prompt / system prompt; save, publish drafts, start from a template

**Spec.** `03-pipeline-engine.md` (canonical document & schema), M5 draft editor,
acceptance E3.

**Backend.** Unchanged and complete for YAML: draft/validate/publish routes
(`internal/api/pipelines.go`) over `api/openapi.yaml`, revisions + digests via
ADR-0021. `agent.acp` still has **no system-prompt member** — undecided (`04:26`);
`model.chat` bindings landed (ADR-0029, `4c4ea6a`) with bindingText `content`.

**UI.** The **per-step form** (`8706c9a`) — pick a node, edit the fields its kind has,
each edit written back into the YAML text in place so the textarea stays
authoritative (`ui/src/lib/pipeline/nodeFields.ts`); **templates** (`5fa3d52`) — New
pipeline offers Blank or the two vetted `docs/samples/home/` pipelines, with a drift
test pinning the UI copies byte-for-byte; Validate working right after pasting
(`3654c18`); and since `0e95e03` the editor is **read-only without the library role,
refuses to lose unsaved edits, carries per-step form fields for every kind** —
approval, until, `for_each`, condition, publish — and refuses duplicate names
(`8f28cb3`, `ui/src/lib/pipeline/unsavedGuard.ts`, `DraftEditor.tsx`); templates are
now **visible read-only to everyone** and the assign panel lists each maintained
project's state (`9be68fd`, `ui/src/pages/Library.tsx`).

**Live evidence.** Templates CHECKED LIVE (`5fa3d52`); `9be68fd` is "browser-checked
on the lab" for the read-only templates view and the per-project assign panel;
`8f28cb3`'s role guard, unsaved guard and all-kind form fields are unit-tested
(`nodeFields.test.ts`, `DraftEditor.test.tsx`, `Library.test.tsx`) with no recorded
click-through of the form itself. The W4 browser leg ran at `d1bbcc3` ("61 PASS, 2
FAIL, 1 GAP" — the W4 FAIL was fixed in `3654c18`; **no re-run is recorded since**).

**Status: works end-to-end** for YAML edit→validate→publish and for template-start
(CHECKED LIVE, `5fa3d52`; read-only template browsing + assign panel CHECKED LIVE,
`9be68fd`); the per-step form for all kinds is **UI wired** (unit-tested, not clicked
live); system prompts stay **spec only** until an ADR decides node vs profile.

**Next step.** One Playwright arm editing an `agent.acp` step's `prompt` through the
form and publishing; re-run the driver's W4/W8 legs on a lab at HEAD (they passed
61/63 before the `3654c18`/`554092a` fixes; verdict since is unrecorded).

## W5 — A security workflow that runs on a schedule

**Spec.** `07-config-integrations.md` ("cron-like schedule"), M6 "Schedule triggers".

**Backend: landed end to end.** ADR-0032 (`2adf593`): `schedules` table
(`internal/store/postgres/migrations/00006_m6_schedules.sql`), a 5-field UTC cron
parser, and a tick that fires an assignment's pinned revision with fixed inputs —
`FOR UPDATE SKIP LOCKED`, keyed per slot so a second tick cannot double-fire; missed
slots fire once, never backfill; concurrent ticks covered by real-Postgres tests.
Wired into serve (`016f11e`): 30 s tick, plus `GET/POST /api/v1/projects/{projectId}/schedules`
and `PATCH /api/v1/schedules/{id}` (`internal/api/schedules.go:116-118`).

**UI.** Per-assignment "When to run" block on the project Pipelines page — schedules
with next run, toggle, last run, and maintainer-added hourly/daily/weekly presets from
the revision's declared inputs (`016f11e`; `ui/src/pages/ProjectRunsPipelines.tsx:445-480`).
`854b2ef` CHECKED LIVE in the browser: "Schedules show on/paused correctly".

**Live cron fire OBSERVED.** 2026-10-16 in the lab at `016f11e`: an every-minute
schedule fired twice (`09:20:00Z`, `09:21:00Z`) — exactly 2 `schedule.fired` events
with **two serve replicas** ticking (no double fire), each fire creating a run that
advanced to `waiting_human`; `PATCH enabled=false` stopped it. **Not recorded:** the
security-review sample (`docs/samples/home/security-review.yaml`) on a schedule.

**Status: works end-to-end** — schedule firing OBSERVED LIVE in the lab
(`016f11e`, deduped across two replicas); schedule display CHECKED LIVE (`854b2ef`);
concurrency also covered by real-Postgres tests (`2adf593`).

**Next step.** On the home cluster, schedule `security-review` weekly and paste the
`run.created` row plus the schedule's `last_run_at` before/after. No migration or
new code expected.

## W6 — APM skills from a library, pinned at a git tag, portable across agents

**Spec.** `04-agent-runtime.md` (launcher registry, `apm_package_ref` +
`apm_lock_digest`, "APM preparation is **not** itself isolation"); milestone M3.

**Backend: writable profiles landed.** ADR-0030 (`fd7d2a4`): org admins
`POST /api/v1/agent-profiles` and `PATCH /api/v1/agent-profiles/{profileId}`
(`internal/api/agent_profiles.go:70-76`, `api/openapi.yaml:838,922`), writing the
`apm_package_ref`/`apm_target`/`apm_lock_digest` triple together (ref without digest
refused), the ref grammar being the one the git-tag spike proved
(`mattpocock/skills#v1.3.1`). Staging was fixed live-forward after the first
end-to-end probe FAILed ("No apm.yml found", `aa5f59e`, F1/F2 in
`docs/compatibility/APM.md:162-220`): ADR-0030 amendment 1 (`fbf4fd5`) made `Stage`
materialize the manifest from the ref, run `apm lock`, install `--frozen`, refuse on
digest mismatch.

**Git-tag pinning: spiked and recorded.** `4e367ee` + `docs/compatibility/APM.md:112-160`:
T-tag-1..5 all PASS in the worker image — the lock records `resolved_commit`, a frozen
reinstall (even offline) is byte-identical, a different tag moves the digest;
conclusion: `sha256(apm.lock.yaml)` pins a tag's content, keep `--frozen`.

**Live PASS.** `docs/compatibility/APM.md:223-246` ("Re-run after ADR-0030 Amendment 1
— PASS", `4951c0f`): profile `skills-demo` pins `mattpocock/skills#v1.3.1`/claude; a
live conversation turn completed and the agent listed all 27 pinned skill names
(including `grill-me`, absent from the host `~/.claude`). **Codex target NOT RUN**
live; checkout-cleanliness is unit-test-only (`internal/agent/apm/stage_test.go`).

**UI.** `ui/src/pages/Agents.tsx` at `/agents` (`e013cfd`, nav in
`ui/src/components/Shell.tsx:15`): rows with each profile's APM ref/target/digest and
a form that sets or clears the triple together; "How do I get this?" prints the two
worker-image commands that compute the lock digest (`bb43fcc`). The write path was
exercised via API in the PASS re-run ("created via POST + PATCH, 201/200") — not yet
clicked through in a browser.

**Status: works end-to-end for the claude target**, CHECKED LIVE per
`docs/compatibility/APM.md:223-246`; cross-agent portability is **observed for skills
on two targets in the offline probes only** (T4 HOME FAIL → per-run HOME required),
**not** an isolation claim.

**Next step.** Run the same live probe with `target=codex` and append the row to
`docs/compatibility/APM.md`; then click the profile create + APM attach through
`/agents` in a browser (the write path is only proven via API and unit tests).
Skill-library browsing stays Later.

## W7 — ACP talks to coding agents installed in the worker image

**Spec.** `04-agent-runtime.md` (protocol baseline, launcher registry, permission
policy); milestone M2.

**Backend.** Unchanged shape: launchers compiled in at `claude-agent-acp@0.90.0` /
`codex-acp@2.2.2` (`internal/agent/acp/launchers.go`), adapters shipped in the worker
image (`worker/Dockerfile`), `nono`+`apm` sha-pinned. New since the baseline: attempt
transcripts (`231fc7a`) — a run's agent-attempt session feeds the M2 turn sink, so the
attempt's conversation carries the real transcript (found live). Sandbox shells read
their startup files read-only (`9d2b907`, ADR-0033, `docs/compatibility/SANDBOX.md:131-145`;
the denial was seen live in a pipeline agent's transcript).

**Cluster worker.** A second worker runs on the home k8s cluster executing
`process.exec`, `model.chat`, `artifact.publish`; its `agent.acp` waits on the
owner-provided Claude secret (`docs/home-cluster.md` § 1).

**Live evidence.** Conversation path: `docs/compatibility/ACP.md:22-23` (both adapters
PASS turn/permission/cancel/`loadSession` rows), browser `e2e/tests/m2-journey.spec.ts`,
operator check `communication doctor --acp claude`. Run path: the driver's W2 leg (run
page: journal renders live, iterations not duplicate nodes, on the deterministic twin)
**PASSED at pass 9 — 17 PASS / 0 FAIL / 2 GAP**, its mid-lease arm catching
`/build_until_verified[1]/implement` leased to worker-a — the page watched real
in-flight work (recorded `4a248d8`, `docs/m4-exit-status.md:120`); the two GAPs are
`conversation.turn.*` arms on a `process.exec` twin that owns no ACP turn — for those,
C4e now fences a live `agent.acp` implement attempt and checks
`conversation.turn.interrupted` plus no post-unpause transcript (`2f0fe1f`, driver
only, never run live). The run page itself was browser-checked on the lab
(`e609b00`). Egress: agent turns run behind nono's domain-allowlist proxy (ADR-0035,
`b058d08`; audit reader `1e1a93f`) and the lab observed two real `claude-agent-acp`
turns completing on the default list alone with `example.com` denied by a
`host_denied` audit record — CHECKED LIVE,
`docs/compatibility/SANDBOX.md:429-481` (`9e83e12`).

**Status: works end-to-end** for Claude Code + Codex conversations (CHECKED LIVE);
agent-turn egress enforcement CHECKED LIVE (rows 8a/8b); the run-page live-stream leg
CHECKED LIVE (PASS at live9, `4a248d8`) and the run page browser-checked at 390px
(`e609b00`); the `agent.acp`-turn arms (transcript inline, C4e fence) remain
**unrecorded** — the only remaining GAPs. Gemini and Pi stay GAP rows in
`docs/compatibility/ACP.md`.

**Next step.** Run the agent-arm legs in a fresh pass (C1c to a real exhaustion,
C4e's `agent.acp` fence from `2f0fe1f`) and paste the literal PASS. On the cluster,
mounting the owner's Claude secret turns the samples into full-agent pipelines.

## W8 — One-off agent conversations, shared, grouped under a project

**Spec.** `06-collaboration-identity.md` (shared conversation model: controller lock,
observer, takeover/return); milestone M2 exit.

**Backend.** Unchanged and real: project-scoped conversation routes, controller-only
take/return with 409s, durable store + SSE (`internal/api/conversations.go`,
`internal/worker/{agentturn,turnloop*}.go`).

**UI.** Conversations surface **across projects on `/inbox`** — active conversations
and pending permission prompts, "who is waiting on me" (`da2aa31`;
`ui/src/pages/Inbox.tsx:68-133`). The conversation page got the 6d layout (`854b2ef`,
CHECKED LIVE in the browser): transcript centre, compact tool rows, context column,
JSON plans rendered as plans, honest wording when no sandbox verdict was recorded.
Since `0e95e03` the Inbox **refreshes its own reads every 7.5 s while visible**
(`699c3ff`, `ui/src/api/queries.ts` — unit-tested), and a lab-gated two-user spec
proves a pending permission prompt reaches **another member's** Inbox (`7dbc8d2`).
Permission prompts inside runs are decided for the lab (`62a149c`; ADR-0036 below).

**Live evidence.** `e2e/tests/m2-journey.spec.ts` (start/observe/take/return/restart);
`e2e/tests/m5-inbox.spec.ts` **PASSED 6/6 live on the lab**
(`docs/m4-exit-status.md:208`); driver W8 leg ran live at `d1bbcc3` (its one FAIL was
fixed the same day in `3654c18`, re-run unrecorded).

**Status: works end-to-end**, CHECKED LIVE (m2-journey browser; 6d layout `854b2ef`;
two-user prompt→Inbox 6/6 live, `docs/m4-exit-status.md:208`).

**Next step.** The lab half of the permission question is decided: ADR-0036
(`382d42b`) adopts `preapproved_within_sandbox` for the three M4 seed profiles; every
product default and deployment stays `ask` — condition (a) is open, the journal
records no verdict for a preapproved tool call (`docs/design/attempt-permissions.md`).
Conversation turns now journal their own `sandbox.egress_observed` via a per-turn
marker (`382d42b`, unit-tested — no live turn has re-observed it yet).

## W9 — In-UI assistant that helps the user operate the app

**Spec.** `08-assistant.md` (application agent, tool list, UI non-negotiables);
milestone M7.

**Backend: the read-only half landed.** ADR-0034 (`3cbf2a3`): `internal/assistant/`
+ `POST /api/v1/assistant/ask` (`api/openapi.yaml:3783`, `internal/api/assistant.go`).
A bounded tool loop over existing store reads **with the caller's permissions**; tool
output is untrusted data; links survive only from the app-route allowlist
(`internal/assistant/routes.go:12-50`); nothing is stored; without
`COMMUNICATION_ASSISTANT_*` the route 503s `assistant_not_configured`
(`internal/api/assistant.go:161`). Write tools (`pipeline.createDraft/validate/publish`,
`question.ask`, `approval.request`) are unbuilt.

**UI.** Ctrl K / Ask box as a quick-jump palette over pages, projects, pipelines,
recent runs and agents (`9e03244`, CHECKED LIVE); the Ask row backed by
`POST /assistant/ask` (`854b2ef`; `ui/src/components/CommandPalette.tsx`). What is
CHECKED LIVE is the **rendering** of the Ask row — no live model has answered through
it: the lab has no `COMMUNICATION_ASSISTANT_*` endpoint, and the home cluster sets it
(`docs/home-cluster.md` § 1, `0ae8c43`) with no answer recorded there either.

**Live evidence beyond the browser.** After the erin seed "every W9 arm PASSes (404s,
no project/node/digest in the DOM, SSE never opens); the carol-literal arm stays an
honest GAP" (`763c3c4`) — authz/privacy proven live; no row claims an answered
question.

**Status: backend + UI built and unit-tested** as a **read-only** ask/navigate
assistant (ADR-0034, `3cbf2a3`, `854b2ef`; outsider privacy CHECKED LIVE `763c3c4`);
**NOT answered live anywhere** — no model endpoint in the lab, and the configured
home cluster has no recorded answer. Write tools and the phrase-button navigation
flow: **spec only** (`docs/design/assistant-v1.md`).

**Next step.** Nothing to configure — the home cluster already sets
`COMMUNICATION_ASSISTANT_*` (`docs/home-cluster.md`): ask one question live there and
record the question→answer→route-link click in the browser. Write tools need the ADR
`08:38` names (new external dependency + security boundary) before the first one
ships, publish staying behind an approval card.

## What still blocks a click-through on the home cluster

`docs/home-cluster.md` (click path + limits guide, refreshed to the shipped UI by
`387e072`) has these open blockers as of `2f0fe1f`; **the owner's one click-through
has still not been done or recorded.**

1. **Claude credentials secret — still absent.** The cluster worker runs
   `process.exec`, `model.chat` and `artifact.publish` today; `agent.acp` fails
   closed until the owner creates the optional `communication-worker-claude` secret
   (`faf9711`, `docs/samples/home/README.md`) — the kubectl+sops command and the
   shared-login warning (ADR-0019 D4) are in `docs/home-cluster.md` § 1. Until then
   no W7/W8 flow is clickable there.
2. **The permission-prompt decision — narrowed, not closed.** Inside a run, an
   `ask`-mode prompt with no human controller is cancelled (`ask_unattended`); the
   lab adopted `preapproved_within_sandbox` for its three seed profiles (ADR-0036,
   `382d42b`), but product defaults and this cluster stay `ask` until condition (a)
   closes — no per-call verdict in the journal (`docs/design/attempt-permissions.md`).
3. **Assistant answer never recorded.** The cluster *does* set
   `COMMUNICATION_ASSISTANT_*` (`docs/home-cluster.md` § 1); the lab still has none
   (503 `assistant_not_configured`, `internal/api/assistant.go:161`). The first
   question→answer→link click is a click, not code.
4. **One model on the chat allowlist.** The cluster worker's
   `COMMUNICATION_MODEL_CHAT_MODELS` allowlists a single model today
   (`docs/samples/home/README.md`; `docs/home-cluster.md` names `qwen3-8-flash-next`);
   anything else is refused at execution (`internal/worker/modelchat.go:308`).
5. **No resource limits.** The Operations page says so openly (C13f, `09411da`);
   the pass-4 re-check GAPped on that copy never being rendered in the gate
   (`docs/m4-exit-status.md:111`). A noisy `process.exec` step is unbounded.
6. **Browser proofs pending, not code missing.** The W2 run-page leg PASSed at
   live9 (`4a248d8`); what still has no verdict: the M5 journey step-6 re-run after
   `ef470a0`; the C1c agent arm (dies at `[3]/review` attempt 2 before exhaustion —
   **cause under capture**, `live9/C1.out:46, :70`); the C4c/C5b/C5e/C6/W5/W6 fault
   legs (pass 9's container-name driver bug fixed in `13dd742` *after* the pass-9
   build; C4e's `agent.acp` fence `2f0fe1f` never run); C8e after `d8b927c`+`b2bfe62`;
   the `5145bcb` non-member 404s; and the W7 counter re-run after `5ade2c5`. All need
   a lab pass, not code.
