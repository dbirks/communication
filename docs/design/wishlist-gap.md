# Wishlist gap — what the product owner can click today

Maps the product owner's nine wishlist items (W1–W9) onto this repo at HEAD
(`320c6fe`): evidence + one smallest next step each. Status vocabulary
(`AGENTS.md`): `works end-to-end` (clickable on the real stack) / `backend only` /
`UI only` / `spec only` / `nothing`. A mocked-green unit test never counts as
end-to-end; **CHECKED LIVE** is claimed only where a commit message or a
`docs/compatibility/*.md`, `docs/m4-live-findings.md` or `docs/m4-exit-status.md`
row records the literal observed output (`communication-spec/12-test-strategy.md`).
Landed since the previous refresh (`6b60d1a`), all cited with shas below: **the
real-Claude agent pipeline now completes end to end live** — C1 98/0/0 at passes
12/14/15 after `5820aab`'s review-prompt fix; scoreboard after pass 30 **PASS 84 / FAIL 0 / GAP 2 / NOT RUN 0** over 86
items (`c1c7c19`, `docs/m4-exit-status.md`), with pass 29 (`d4cd945`) promoting C1j new →
PASS and pass 30's deny probe proving `deny` on the conversation path
(`live30/deny_probe.out`) — C7c stays the only GAP (C10c GAP → PASS at pass 39, `1b872b8`,
`live39/C10.out:110-:116`). M5 lab specs passed: agents+schedules **3/3**
(`be97fd1`), layout 18/20 with both real 390px overflows then fixed (`ef0d848`,
`19175b3`), two-user Inbox **6/6** (`docs/m4-exit-status.md:299`). The run page
lists every attempt with honest interrupted wording (W5 11/0, `f010fe2`), child
runs carry status words (W11 11/0, `19175b3`), and SSE survives a reload and an
api-replica roll (W10 15/0, pass 14). Also: overview refetch storm fixed
(962→22 requests, browser-checked, `82902b4`); `/projects/:id/conversations` its
own page (browser-checked, `059d132`); `restore_checkpoint` implemented + wired
(`e2de8fa`, `5c03d6c`; its C6 legs now PASS at passes 20/25 — `3f35115`,
`fa0c0e0`); refused recovery classed
`workspace_lost` (`efb82bd`); mid-turn ACP disconnect classed infra (`320c6fe`).
The assistant now answers live (2026-10-17, on the lab's LLM collective `qwen3-8-27b` — an
uncommitted, owner-approved lab-only compose override; no key is in the repo — `e2e/tests/m5-assistant.spec.ts`
**3/3**, `37b66a6`, first live answer `6eb0392`); the home cluster's click-through is not done yet
(its model env must be set to `qwen3-8-27b` and its image predates these fixes until CI runs)
— as of 2026-10-18 its steps 1–4 (plan-with-approval on the cluster worker) PASS and step 5
(Claude `agent.acp`) is a GAP on credential rotation (`docs/home-cluster.md` § 5, Proof record
2026-10-18).

## Summary

| Item | Status | Smallest next step |
|---|---|---|
| W1 Browse projects + repositories | works end-to-end (CHECKED LIVE: `e2e/tests/m1-journey.spec.ts`, M4 W1 leg; the overview's SSE refetch storm fixed — browser-checked 962→22 requests, `82902b4`) | Record one real `https://github.com/…` mirror clone in `docs/compatibility/WORKSPACES.md` |
| W2 Plan workflow with a human gate | works end-to-end (gate card CHECKED LIVE 21/0/0 **on a real Claude plan**, re-confirmed pass 12 `live12/W3.out:55`; the real-Claude loop **completes end to end** — C1 98/0/0 at passes 12/14/15, `5820aab`; M5 journey is now **live-green 10 passed / 0 failed / 1 fixme** on `14e8ff5` after the step-6 fix `ef470a0` re-ran — the one `fixme` is a recorded product contradiction at `:965`, `docs/m4-exit-status.md:320`) | Decide the `:965` contradiction the `fixme` records (the rejected-gate card's "fails the run" promise vs a BUSINESS outcome) and re-arm that arm as a test |
| W3 GitHub-issue run, fan out + join | issue list works end-to-end on public repos (real call observed, `docs/compatibility/GITHUB.md`); `pipeline.invoke` children **CHECKED LIVE** and C8e stop/`fail_after_all` are now **PASS** (C8 38/0/2 at pass 11, `d8b927c`+`b2bfe62`, `live11/C8.out:78-92`); issue→prefill→`run_inputs` **CHECKED LIVE** (`4a72d31`, m5-issue-run 5/5 live on `1c1733b`, `live33/m5-suite.out`); triggers/join spec only | Webhook/poll triggers need `triggers`+`invocations` tables + ADR (M6) |
| W4 Edit step prompts, drafts → publish | works end-to-end (YAML edit→validate→publish; the **step form was clicked live** — m5-journey step 2 edits `timeoutSeconds`, saves, validates and publishes r1 (`e2e/tests/m5-journey.spec.ts:292-330`; 12 passed incl. step 2, `docs/m4-exit-status.md:296-299`); read-only templates + assign panel CHECKED LIVE `9be68fd`; editing an `agent.acp` `prompt` through the form is now **CHECKED LIVE** (`1879714`, m5-prompt-edit 6/6 live on `1c1733b` — the spec also found and fixed in `1c1733b` the valid-draft validate response missing its required `revision_digest`/`plan_digest`)) | None for W4's journey (system prompts stay spec-only until an ADR decides node vs profile) |
| W5 Scheduled security workflow | works end-to-end (schedule firing OBSERVED LIVE, 2026-10-16, `016f11e`; the cron clock + pause clicked live — agents+schedules spec **3/3 on the lab**, `be97fd1`) | Home-cluster weekly `security-review` on a schedule; record `run.created` plus the schedule's `last_run_at` before/after (the home-cluster click-through's steps 1–4 now PASS there — 2026-10-18, `docs/home-cluster.md` § 5; the scheduled leg is still not recorded) |
| W6 APM skills, tag pin, cross-agent | works end-to-end for the claude target (CHECKED LIVE, `docs/compatibility/APM.md:223-246`; profile create + skill pin + digest help now clicked through `/agents` — **3/3 live**, `be97fd1`); codex target NOT RUN live | Run the same live probe with `target=codex`; append the row to `docs/compatibility/APM.md` |
| W7 ACP agents in the worker image | works end-to-end (the real-Claude run completes live — C1 98/0/0, `5820aab`, passes 12/14/15; run-page legs live: W5 11/0 attempts + interrupted wording `f010fe2`, W10 15/0 across a replica roll, W11 11/0 child statuses `19175b3`; egress CHECKED LIVE, `docs/compatibility/SANDBOX.md:429-481`; `restore_checkpoint` (`e2de8fa`+`5c03d6c`), `workspace_lost` (`efb82bd`) and disconnect→infra (`320c6fe`) now have **PASS legs** — C6 restore b/c/e at pass 20 + C6d at pass 25 (`3f35115`, `fa0c0e0`), C2a/C2b's agent variant at pass 17 (`320c6fe`, `599e4f9`), C4e at pass 18 (`cc0bff8`), W6 14/0/0 at pass 19 (`2b24738`+`6e57274`); agents now run git in their worktree (`e83913a`, pass 26 `76a9e64`) and every permission prompt in attempts closes as one journaled policy verdict (`a0fd9e7`, pass 27's 23/23 journal read; C1j PASS at pass 29, `d4cd945`)) | Claude secret now mounted on the home-cluster worker (2026-10-18): steps 1–4 of the home-cluster click-through PASS, but step 5 (Claude `agent.acp`) is a **GAP** — the Secret is a snapshot of the owner's `~/.claude/.credentials.json` whose access token expired and whose refresh token is rotated by the owner's local sessions, so a copied interactive login cannot stay valid; next is a long-lived `claude setup-token` credential, then the real-agent legs run there (`docs/home-cluster.md` § 5, Proof record 2026-10-18); record the Gemini/Pi rows in `docs/compatibility/ACP.md` |
| W8 Shared one-off conversations | works end-to-end (CHECKED LIVE: m2-journey browser; two-user Inbox **6/6 live**, `docs/m4-exit-status.md:299`; the per-project conversations page browser-checked, `059d132`; permission mode decided for the **lab only** — ADR-0036, `382d42b`; **`deny` is now enforced on the conversation path** (`c1c7c19`, pass 30 deny probe: 1 requested / 1 decided (cancelled) / 0 allow / 0 preapproved, `live30/deny_probe.out`); per-call verdicts for preapproved conversations (ADR-0039) in implementation, not done) | Record one live conversation turn whose `sandbox.egress_observed` proves the `382d42b` journalling; then the product-mode decision |
| W9 In-UI assistant | **CHECKED LIVE** (2026-10-17, on the lab's LLM collective `qwen3-8-27b` via an uncommitted, owner-approved lab-only compose override — no key is in the repo): `e2e/tests/m5-assistant.spec.ts` **3/3 live** — Ctrl K → Ask, a real collective answer with its tool calls, every link a real page (`37b66a6`); the first live answer needed `6eb0392` (the tool names were illegal OpenAI function names and the collective 400'd every ask) and `37b66a6` fixed the dead `/approvals` link; write tools spec only | Home cluster: set `COMMUNICATION_ASSISTANT_MODEL` / `COMMUNICATION_MODEL_CHAT_MODELS` to `qwen3-8-27b` and re-run the assistant spec once CI publishes an image newer than `1b872b8` |

## W1 — Browse projects; see a project's repositories

**Spec.** `01-domain-model.md`; journey C0 in `docs/design/acceptance-checklist.md`; M1.

**Backend + UI.** Projects/repos/members routes at `internal/api/projects.go:121-127`;
UI pages `Projects.tsx` (board with attention counts, needs-me-first sorting; the
card fits 390px — layout spec `ef0d848`, fix `19175b3`), `Project.tsx`
(REPOSITORIES panel), one section nav + dashboard Overview (`fe39876`). The
Overview's SSE-driven refetch storm (~950 project reads in 6 s on journal replay)
is coalesced away — browser-checked **962 → 22 requests, 0 errors** (`82902b4`).
Non-members get the unknown-project 404 on the runs/schedules/conversations routes
(`internal/api/runs.go`, `internal/api/schedules.go`) — "not found or no access"
(`ui/src/components/ProjectUnavailable.tsx`); the conversations arm is
browser-checked (`059d132`), the `5145bcb` runs/schedules arms await a browser
re-run. Accepted remotes include https; the clone happens at run-prepare in the
worker (`internal/workspace/git`).

**Live evidence + status.** Browser journey `e2e/tests/m1-journey.spec.ts` (add
two repos, two replicas agree, SSE propagation, restart keeps data, non-member
404); M4 driver W1 leg ran live in passes 1–2 (`docs/m4-exit-status.md`).
**Status: works end-to-end** (CHECKED LIVE in the browser).

**Next step.** `docs/compatibility/WORKSPACES.md` still has zero `https://` rows
(all harness-local bare repos) — register a public GitHub repo, run a
`process.exec` node against it, append the literal mirror/prepare output there
(home cluster is the cheaper place).

## W2 — "Plan" workflow with several steps, one needing human input

**Spec.** `03-pipeline-engine.md` (`human.approval`, run.waiting_human), M4 exit
"Plan→Approve→Implement→Test→Review→Loop", acceptance C5.

**Backend.** Real and unchanged: `human.approval` is a control-plane kind settled
in the advancer (`internal/pipelines/compiler/compiler.go:55-60`);
approve/reject → `internal/api/approvals.go`, resume-on-decision since `52685c1`.
`5820aab` also proved body nodes cannot bind the parent-scope plan
(`internal/pipelines/compiler/body_scope_test.go`).

**UI.** `ApprovalCard.tsx` in the run inspector (readable plan, not raw JSON,
`8e43ff6`/`2b1d5d7`; objective + short Claude-written summary, `35a9acf`);
cross-project `/inbox`; newer-revision notice (`3654c18`); stage strip /
attention filter / node crumb CHECKED LIVE (`ae57b23`). The Retry control arms
only when a target exists (rejected gate is final, 409 `run_not_retriable`,
`a3004c0`); a retry naming a missing node execution answers 404, not 500
(ADR-0037, `13b81fb`). The runs list opens on the first non-empty filter and
keeps the selected run visible (browser-checked, `0e7f8b3`).

**Live evidence.** Gate click-through: the M4 W3 browser leg recorded **21 PASS /
0 FAIL / 0 GAP** off a real Claude plan — bob has no Approve button, alice's click
decides — first at live9 (`4a248d8`), re-confirmed on pass 12's build
(`live12/W3.out:26-52, :55`). **Behind the gate the loop now completes**: the death
that chased C1c (`node_execution_failed` at `/build_until_verified[3]/review`,
`live9/C1.out:70` + `live10/C1.out:67`; then `until_exhausted`, `live11/C1.out:73`)
was the reviewer being blind to the plan and this iteration's results — fixed in
`5820aab` (the review prompt approves on the goal, the criteria and *this
iteration's* implement/test results, `docs/compatibility/probes/m4/README.md`).
Passes 12/14/15 all came back **C1 98 PASS / 0 FAIL / 0 GAP** (`live12/C1.out:210`,
`live14/C1.out:210`, `live15/C1.out:210`) — agent run terminal `completed`,
`review_approved == true`, 2 iterations, contiguous journal, SSE saw both frames
(`live15/C1.out:28, :63-66, :66-74, :83`). The M5 exit journey ran live **12
passed / 1 failed / 4 not run** — the failure is step 6's wrong assumption (exit 1
alone is a business outcome, not a failure), fixed in `ef470a0` — and the re-run
has landed live-green: **10 passed / 0 failed / 1 fixme** on `14e8ff5`
(`docs/m4-exit-status.md:320`), where the one `fixme` is the recorded product
contradiction at `:965`, not a broken test.

**Status: works end-to-end** — gate card CHECKED LIVE and the full real-Claude
loop plan→approve→iterations→`completed` CHECKED LIVE at passes 12/14/15
(`5820aab`); the prior "still fails before exhaustion" line is closed, the M5
journey re-run landed live-green (10/0/1 fixme, `14e8ff5`).

**Next step.** Decide the `:965` product contradiction the journey's one `fixme`
records (the rejected-gate card's "fails the run" promise vs a BUSINESS outcome)
and re-arm that arm as a test; the C1c exhaustion diagnosis is no longer needed.

## W3 — "Build" workflow driven by GitHub issues, fanning out and joining back

**Spec.** `07-config-integrations.md` (trigger = manual/cron/webhook/polling; query
= "GitHub issues matching label"), `03-pipeline-engine.md` (`for_each`, `parallel`,
`join`); milestone M6.

**Issue read half: landed.** ADR-0031 (`4085f07`) added `internal/integrations/github`
and the read-only route `GET /api/v1/projects/{projectId}/repos/{repositoryId}/issues`
(`internal/api/github_issues.go:90`). `docs/compatibility/GITHUB.md` records the real
call with literal output (HTTP 200, 3 open issues for `mattpocock/skills`, 2026-10-16);
authenticated/private listing and webhooks stay **not verified / not built** there.
`d777165` put it in the New run form: "Use this issue" fills the revision's declared
`goal`/`issue_number`/`issue_url` inputs (`ui/src/components/m4/NewRunForm.tsx:28,
238-249`). **Prefill is now CHECKED LIVE:** m5-issue-run (`4a72d31`) clicks a live issue, picks it, and requires the prefilled `goal`/`issue_number` to reach `POST /runs` and land in `run_inputs` — **5/5 live** on a `1c1733b` lab (`live33/m5-suite.out`).

**Fan-out: proven live, stop policy included.** `for_each` executes and joins
branch results into the parent scope (`internal/pipelines/runtime/advancer.go`);
`parallel`/`join`/`integration.query`/`integration.action` remain in `deferredKinds`
(`internal/pipelines/compiler/compiler.go:43-51`). `pipeline.invoke` children are
CHECKED LIVE — C8 31/0/2 at pass 7 (`9d50da0`), re-run **38 PASS / 0 FAIL / 2
GAP** at pass 11 (`live11/C8.out:128`): 25 child runs, peak concurrency 3, cancel
cascade, depth guard at validate. C8e — the `for_each` **stop** and
`fail_after_all` policies — is now **PASS** (`d8b927c`'s sibling-cancel rows +
`b2bfe62`'s per-mode parent revisions): pass 11 measured stop failing the scope,
cancelling 10 queued siblings and preserving the succeeded ones
(`live11/C8.out:80-83`), then `fail_after_all` running all 25 before failing
(`:92`). C8's two GAPs are C8f's depth-chain fixture bug (`live11/C8.out:112-113`).
In the browser the tree renders with each child's own status word — **W11 11/0
live** (`19175b3`, `live14/W11.out:36`).

**Status.** No webhook receiver, no `triggers`/`invocations` tables, no polling
reconciler — runs start manually, from a parent node, or (ADR-0032) a schedule.
Issue listing: **works end-to-end** on public repos (CHECKED LIVE,
`GITHUB.md`). Prefill: **CHECKED LIVE** (m5-issue-run, `4a72d31`, on `1c1733b`). Child runs
+ stop/`fail_after_all`: **works end-to-end, CHECKED LIVE** (C8 38/0/2, pass 11).
Webhook triggers, dedupe, `parallel`/`join`: **spec only**.

**Next step.** Webhook trigger + dedupe needs `triggers`+`invocations` tables and an ADR — keep it M6. (The issue→prefill→`run_inputs` arm is done: m5-issue-run, `4a72d31`.)

## W4 — Edit each step's prompt / system prompt; save, publish drafts, start from a template

**Spec.** `03-pipeline-engine.md` (canonical document & schema), M5 draft editor,
acceptance E3.

**Backend.** Unchanged and complete for YAML: draft/validate/publish routes
(`internal/api/pipelines.go`) over `api/openapi.yaml`, revisions + digests via
ADR-0021. `agent.acp` still has **no system-prompt member** — undecided (`04:26`);
`model.chat` bindings landed (ADR-0029, `4c4ea6a`).

**UI.** The **per-step form** (`8706c9a`, `ui/src/lib/pipeline/nodeFields.ts`) —
pick a node, edit the fields its kind has, each edit written back into the YAML
in place; **templates** (`5fa3d52`) — Blank or the two vetted
`docs/samples/home/` pipelines, drift-tested byte-for-byte; Validate right after
pasting (`3654c18`); the editor is **read-only without the library role, refuses
to lose unsaved edits, has per-step fields for every kind** (`8f28cb3`); templates
are **visible read-only to everyone** and the assign panel lists each maintained
project's state (`9be68fd`).

**Live evidence.** Templates CHECKED LIVE (`5fa3d52`); read-only templates view +
assign panel browser-checked (`9be68fd`). The **form itself has now been clicked
live**: m5-journey step 2 edits the survey node's `timeoutSeconds` field through
the step form, watches it land in the YAML, then Save → Validate ("valid") →
Publish ("published r1") (`e2e/tests/m5-journey.spec.ts:292-330`); the journey ran
live **12 passed / 1 failed / 4 not run** with step 2 in the passed set
(`docs/m4-exit-status.md:296-299`). The § 7.2 W4 leg (pinned-digest notice) PASSed
at pass 5 (`live5/W4.out:30, :46-52`). **A prompt field is now clicked live through
the form**: m5-prompt-edit (`1879714`) edits an `agent.acp` step's `prompt` through the
step form, saves, validates and publishes; the `revision_digest`/`plan_digest` move and
the served YAML carries the new prompt — **6/6 live** on a `1c1733b` lab
(`live33/m5-suite.out`). Writing that spec found a product bug, fixed in `1c1733b`: a
valid draft's validate response omitted `revision_digest`/`plan_digest`, which the
OpenAPI `ValidateResponse` requires. `8f28cb3`'s guards are unit-tested only.

**Status: works end-to-end** for YAML edit→validate→publish, template-start, and
now the step form itself (live-clicked via m5-journey step 2) and **now the prompt-field
edit too** (m5-prompt-edit, `1879714`, CHECKED LIVE on `1c1733b`); the `8f28cb3` guards
stay **UI wired**; system prompts stay **spec only** until an ADR decides node vs
profile.

**Next step.** None for W4's journey: YAML edit→validate→publish, template-start, the
step form (m5-journey step 2) and the `agent.acp` `prompt` edit (m5-prompt-edit, `1879714`)
are all CHECKED LIVE; only the guards are unit-tested and system prompts await the
node-vs-profile ADR.

## W5 — A security workflow that runs on a schedule

**Spec.** `07-config-integrations.md` ("cron-like schedule"), M6 "Schedule triggers".

**Backend: landed end to end.** ADR-0032 (`2adf593`): `schedules` table
(migration `00006_m6_schedules.sql`), a 5-field UTC cron parser, and a tick that
fires an assignment's pinned revision with fixed inputs — `FOR UPDATE SKIP LOCKED`,
keyed per slot so a second tick cannot double-fire; missed slots fire once, never
backfill; real-Postgres concurrency tests. Wired into serve (`016f11e`): 30 s tick
+ routes (`internal/api/schedules.go:116-118`).

**UI.** Per-assignment "When to run" block (`016f11e`,
`ui/src/pages/ProjectRunsPipelines.tsx:445-480`) — next run, toggle, last run,
hourly/daily/weekly presets; on/paused display CHECKED LIVE (`854b2ef`). Now
clicked end to end: the lab-gated agents+schedules spec adds a far-future cadence
to an assignment, reads its cron clock and pauses it — **3/3 passed live**
(`be97fd1`, `e2e/tests/m5-agents-schedules.spec.ts:288`), with erin's deep link to
a foreign project's pipelines refused (`ProjectUnavailable`).

**Live cron fire OBSERVED.** 2026-10-16 in the lab at `016f11e`: an every-minute
schedule fired twice (`09:20:00Z`, `09:21:00Z`) — exactly 2 `schedule.fired` events
with **two serve replicas** ticking (no double fire), each creating a run that
advanced to `waiting_human`; `PATCH enabled=false` stopped it. **Not recorded:** the
security-review sample (`docs/samples/home/security-review.yaml`) on a schedule.

**Status: works end-to-end** — firing OBSERVED LIVE (`016f11e`, deduped across
two replicas); display CHECKED LIVE (`854b2ef`); add-clock + pause clicked live
(`be97fd1`, 3/3); concurrency covered by real-Postgres tests (`2adf593`).

**Next step.** On the home cluster, schedule `security-review` weekly and paste the
`run.created` row plus the schedule's `last_run_at` before/after.

## W6 — APM skills from a library, pinned at a git tag, portable across agents

**Spec.** `04-agent-runtime.md` (launcher registry, `apm_package_ref` +
`apm_lock_digest`, "APM preparation is **not** itself isolation"); milestone M3.

**Backend: writable profiles landed.** ADR-0030 (`fd7d2a4`): org admins
`POST`/`PATCH /api/v1/agent-profiles` (`internal/api/agent_profiles.go:70-76`),
writing the `apm_package_ref`/`apm_target`/`apm_lock_digest` triple together (ref
without digest refused). After the first probe FAILed ("No apm.yml found",
`aa5f59e`), amendment 1 (`fbf4fd5`) made `Stage` materialize the manifest from the
ref, run `apm lock`, install `--frozen`, refuse on digest mismatch.

**Git-tag pinning + live PASS.** `4e367ee` + `docs/compatibility/APM.md:112-160`:
T-tag-1..5 all PASS in the worker image — the lock records `resolved_commit`, a
frozen reinstall (even offline) is byte-identical, a different tag moves the
digest. `docs/compatibility/APM.md:223-246` (Amendment-1 re-run, `4951c0f`):
profile `skills-demo` pins `mattpocock/skills#v1.3.1`/claude, a live conversation
turn completed and the agent listed all 27 pinned skill names. **Codex target NOT
RUN** live; checkout-cleanliness is unit-test-only (`internal/agent/apm/stage_test.go`).

**UI — now clicked.** `ui/src/pages/Agents.tsx` at `/agents`: rows with each
profile's APM ref/target/digest and "How do I get this?" printing the digest
recipe (`e013cfd`, `bb43fcc`). The lab-gated agents+schedules spec creates a
profile **through the product's own `/agents` form**, attaches a skill pin, opens
the digest help, and proves a maintainer without the library role reads the same
row with no write control — **3/3 passed live** (`be97fd1`,
`e2e/tests/m5-agents-schedules.spec.ts:159`).

**Status: works end-to-end for the claude target**, CHECKED LIVE per
`docs/compatibility/APM.md:223-246`, browser write path now clicked (`be97fd1`);
cross-agent portability is **observed for skills on two targets in the offline
probes only** — **not** an isolation claim.

**Next step.** Run the same live probe with `target=codex` and append the row to
`docs/compatibility/APM.md`. Skill-library browsing stays Later.

## W7 — ACP talks to coding agents installed in the worker image

**Spec.** `04-agent-runtime.md` (protocol baseline, launchers, permission policy); M2.

**Backend.** Launchers compiled in at `claude-agent-acp@0.90.0` / `codex-acp@2.2.2`
(`internal/agent/acp/launchers.go`), adapters in the worker image, `nono`+`apm`
sha-pinned; attempt transcripts journalled (`231fc7a`); sandbox shells read
startup files read-only (`9d2b907`, ADR-0033). New since the last refresh:
`repo_states` written with their wire keys (were Go field names, so every read
hydrated empty) + automatic retries carrying `retry_context` from the last
boundary (`12cb433` — CHECKED LIVE at C5e, below); worker-side
**`restore_checkpoint`** per ADR-0023 § 6 (reset to the boundary commit, report
discarded paths, emit `run.checkpoint_restored`, refuse submodules — `e2de8fa`)
**wired** so only restore_checkpoint retries restore (`5c03d6c`;
`continue_workspace` unchanged); refused workspace recovery classed
`workspace_lost`, never infra, never auto-retried (`efb82bd`); mid-turn ACP
disconnect classed infra, retried per policy, not `invalid_output` (`320c6fe`, a
C2 live finding) — the last three now have their legs measured (all PASS at
passes 17–25, below). The home-cluster worker's Claude secret is now mounted (2026-10-18) and
its plan-with-approval flow (click-through steps 1–4) completed live on that worker;
`agent.acp` there is a GAP, not a pass: the worker self-tests TCP reachability at startup and
withholds `agent.acp` if it fails (`5fad0d5` — nono's seccomp-notify AF_UNIX mediation could
not open `/proc/<pid>/mem` under Talos `kernel.yama.ptrace_scope=2`, since fixed by the
owner's `ptrace_scope=1`, home-k8s `4f6cbdf`), and the mounted Secret is a snapshot of the
owner's `~/.claude/.credentials.json` whose tokens rotate, so a long-lived
`claude setup-token` credential is the next step (`docs/home-cluster.md` § 5, Proof record
2026-10-18); `c5c7888` added read-only checks proving a
run executed on that worker.

**Live evidence.** Conversation path unchanged: `docs/compatibility/ACP.md:22-23`
(both adapters PASS turn/permission/cancel/`loadSession`), `m2-journey.spec.ts`,
`communication doctor --acp claude`. **The run path now closes:** the real-Claude
agent run completes end to end (C1 98/0/0, W2 above; 14-key node set exact and
journal + SSE both frames, `live15/C1.out:44-46, :66-74, :83, :84`; C5e's
retry-resume-from-HEAD PASS at `live15/C5.out:90` proves the `12cb433` fix).
Run-page browser legs: W2 17/0/2 mid-lease PASS (pass 11, `live11/W2.out:31`;
its two GAPs are `conversation.turn.*` arms on a `process.exec` twin, fixture
shape); **W5 11/0** — the page lists every attempt and renders 'interrupted — the
worker disappeared mid-node' with the retry time after a real kill (`f010fe2`,
`live14/W5.out:46, :60`); **W10 15/0 on its first live run** — timeline whole
across a reload and an api-replica roll (`live14/W10.out:60-68, :73`); **W11
11/0** — 25 of 25 child rows carry their status word, no fencing token or worker
id in the DOM (`19175b3`, `live14/W11.out:36`). Egress CHECKED LIVE: two real
`claude-agent-acp` turns completed behind nono's domain-allowlist proxy
(ADR-0035, `b058d08`), `example.com` denied by a `host_denied` audit record,
`docs/compatibility/SANDBOX.md:429-481` (`9e83e12`).

**All previously pending legs are now recorded:** C4e's fenced-`agent.acp`-turn
rewrite (`2f0fe1f`) **PASS at pass 18** (`cc0bff8`, `live18/C4.out:76, :86-:88`);
C6's restore leg on a `5c03d6c`+ build — C6b/C6c/C6e **PASS at pass 20**
(`3f35115`, `live20/C1,C5,C6.out:422-:428, :431-:434, :473-:477`) and C6d
**PASS at pass 25** (`fa0c0e0`, `live25/C1,C5,C6.out:481, :484-:488`); C2a/C2b
on the agent variant (`599e4f9`) **PASS at pass 17** (`320c6fe`,
`live17/C2.out:54-:63`); W6's cross-volume `workspace_lost` **PASS 14/0/0 at
pass 19** (`2b24738`+`6e57274`, `live19/W6.out:74`); C5h's scratch
`maxAttempts: 1` arm **PASS at pass 20** (`3f35115`,
`live20/C1,C5,C6.out:304-:343`). Gemini and Pi stay GAP rows in
`docs/compatibility/ACP.md`.

**Status: works end-to-end** — conversations CHECKED LIVE; the real-Claude
pipeline completing CHECKED LIVE (C1 98/0/0, three passes); run-page stream,
interrupted wording and child statuses CHECKED LIVE (W2/W5/W10/W11, passes
11/14); agent-turn egress CHECKED LIVE (rows 8a/8b). `restore_checkpoint`,
`workspace_lost` and disconnect→infra now have PASS legs (passes 17–25, above).

**Next step.** The five formerly pending legs are all recorded PASS above (passes 17–25);
on the cluster, the owner's Claude secret turns the samples into full-agent pipelines.

## W8 — One-off agent conversations, shared, grouped under a project

**Spec.** `06-collaboration-identity.md` (shared conversation model: controller lock,
observer, takeover/return); milestone M2 exit.

**Backend.** Real and project-scoped: conversation routes, controller-only
take/return with 409s, durable store + SSE (`internal/api/conversations.go`,
`internal/worker/{agentturn,turnloop*}.go`). New: mid-turn ACP disconnect is
classed infra and retried per policy, not `invalid_output` (`320c6fe`,
`internal/agent/acp/disconnect.go`, unit-tested; C2 re-ran 29/0/0 on this
build at pass 17 (`320c6fe`)).

**UI.** `/projects/:id/conversations` is its own page — members see the list,
non-members "not found or no access" — **browser-checked** (`059d132`).
Conversations also surface **across projects on `/inbox`** — active conversations,
pending permission prompts, "who is waiting on me" (`da2aa31`,
`ui/src/pages/Inbox.tsx:68-133`), self-refreshing every 7.5 s (`699c3ff`). The
conversation page carries the 6d layout (`854b2ef`, CHECKED LIVE).

**Live evidence.** `e2e/tests/m2-journey.spec.ts` (start/observe/take/return/
restart); `e2e/tests/m5-inbox.spec.ts` — a pending permission prompt reaches
**another member's** Inbox — **PASSED 6/6 live** (`docs/m4-exit-status.md:299`).
Conversation QA watched a real Claude turn stream into an open browser, no reload,
~6 s to completion — unrecorded by any commit or `.out`, so no CHECKED LIVE row.

**Status: works end-to-end**, CHECKED LIVE (m2-journey; 6d layout `854b2ef`;
two-user prompt→Inbox 6/6, `docs/m4-exit-status.md:299`; conversations page
browser-checked `059d132`).

**Next step.** ADR-0036 (`382d42b`) decided the lab half of the permission
question (`preapproved_within_sandbox` for the three M4 seed profiles); every
product default and deployment stays `ask`. Condition (a) is closed **for
pipeline attempts** — the journal reads 23/23
`node_policy:preapproved_within_sandbox` decisions (`a0fd9e7`, pass 27
`1b93069`; C1j PASS at pass 29, `d4cd945`) — but stays open **on the
conversation path**: after `c1c7c19` preapproved conversations run in the
harness's auto mode with no per-call journaled verdict (`live30/deny_probe.out`
proves `deny` there; ADR-0039 is in implementation, not done). Turns now
journal their own
`sandbox.egress_observed` via a per-turn marker (`382d42b`, unit-tested — no live
turn has re-observed it yet); record one that does.

## W9 — In-UI assistant that helps the user operate the app

**Spec.** `08-assistant.md` (application agent, tool list, UI non-negotiables); M7.

**Backend: the read-only half landed.** ADR-0034 (`3cbf2a3`): `internal/assistant/`
+ `POST /api/v1/assistant/ask` (`internal/api/assistant.go`). A bounded tool loop
over existing store reads **with the caller's permissions**; tool output is
untrusted; links survive only from the app-route allowlist
(`internal/assistant/routes.go:12-50`); nothing is stored; without
`COMMUNICATION_ASSISTANT_*` the route 503s `assistant_not_configured`
(`internal/api/assistant.go:161`). Write tools (`pipeline.createDraft/validate/publish`,
`question.ask`, `approval.request`) are unbuilt.

**UI.** Ctrl K / Ask box: a quick-jump palette over pages, projects, pipelines,
recent runs and agents (`9e03244`, CHECKED LIVE); the Ask row backed by
`POST /assistant/ask` (`854b2ef`, `ui/src/components/CommandPalette.tsx`). The Ask row now
**answers live**: on 2026-10-17 the owner allowed the lab to use the LLM collective
(`qwen3-8-27b`) via a lab-only compose override (uncommitted and owner-approved; no key is in
the repo), and `e2e/tests/m5-assistant.spec.ts` reads **3/3 live** (`37b66a6`) — Ctrl K → Ask,
a real collective answer with a collapsed list of the tools it looked at, and every link the
answer carries landing on a real page rather than "Not found". The first live answer needed
`6eb0392` (the tool names were illegal OpenAI function names and the collective 400'd every
ask), and the dead `/approvals` link was fixed in `37b66a6` (the link allowlist mirrors
`App.tsx`, with a test failing on drift; approval links go to the run page or `/inbox`). The
home cluster sets its own `COMMUNICATION_ASSISTANT_*` (`docs/home-cluster.md`, `0ae8c43`), but
its image predates these fixes until CI runs.

**Live evidence beyond the browser.** "Every W9 arm PASSes (404s, no
project/node/digest in the DOM, SSE never opens)" (`763c3c4`) — authz/privacy
proven live; the carol-literal arm stays an honest GAP; no row claims an answer.

**Status: CHECKED LIVE** as a **read-only** ask/navigate assistant (ADR-0034, `3cbf2a3`,
`854b2ef`; outsider privacy CHECKED LIVE `763c3c4`; **the answer leg is live** —
`e2e/tests/m5-assistant.spec.ts` 3/3, `37b66a6`, first live answer `6eb0392`, on the lab's
owner-approved collective override). Write tools and phrase-button navigation: **spec only**
(`docs/design/assistant-v1.md`).

**Next step.** Home cluster: set `COMMUNICATION_ASSISTANT_MODEL` /
`COMMUNICATION_MODEL_CHAT_MODELS` to `qwen3-8-27b` and re-run
`e2e/tests/m5-assistant.spec.ts` once CI publishes a cluster image newer than `1b872b8` (it
predates the assistant and model.chat fixes). Write tools need the ADR `08:38`
names before the first ships, publish staying behind an approval card.

## What still blocks a click-through on the home cluster

`docs/home-cluster.md` (click path + limits guide, now with read-only "did this run
on the cluster worker?" checks, `c5c7888`) has these open blockers as of `5fad0d5`;
the owner's click-through is now partly done and recorded — **steps 1–4 PASS on the
cluster worker, step 5 (Claude `agent.acp`) is a GAP** (`docs/home-cluster.md` § 5,
Proof record 2026-10-18).

1. **Claude credentials secret — mounted, but the copied login cannot stay valid.** The
   `communication-worker-claude` secret now exists (mounted 2026-10-18) but is a snapshot of
   the owner's `~/.claude/.credentials.json`: its access token expired 03:28Z and its refresh
   token is rotated by the owner's local sessions, so run `4d8fe087` failed in 4 s with
   `{"code":-32000,"message":"Authentication required"}` — `agent.acp` (and so W7/W8) stays a
   GAP on the cluster until a long-lived `claude setup-token` credential lands (shared-login
   warning, ADR-0019 D4, in `docs/home-cluster.md` § 1); the identical flows complete in the
   lab and home-cluster steps 1–4 already PASS (§ 5, Proof record 2026-10-18). The TCP
   prerequisite that blocked the agent sandbox on Talos is fixed: the worker now self-tests
   TCP reachability at startup and withholds `agent.acp` if it fails (`5fad0d5`), and the
   owner set `ptrace_scope=1` on both nodes (home-k8s `4f6cbdf`, no reboot) — the cluster
   self-test logs "agent-turn TCP reachability observed".
2. **The permission-prompt decision — narrowed, not closed.** In a run, an
   `ask`-mode prompt with no human controller is cancelled (`ask_unattended`); the
   lab adopted `preapproved_within_sandbox` (ADR-0036, `382d42b`), but product
   defaults and this cluster stay `ask` until condition (a) closes — no per-call
   verdict in the journal (`docs/design/attempt-permissions.md`).
3. **The cluster's assistant model env must point at the collective, and its image is
   stale.** The assistant now answers live in the lab (`e2e/tests/m5-assistant.spec.ts` 3/3,
   `37b66a6`; first live answer `6eb0392`, on the lab's owner-approved collective override —
   no key is in the repo). The cluster's `COMMUNICATION_ASSISTANT_MODEL` /
   `COMMUNICATION_MODEL_CHAT_MODELS` must be set to `qwen3-8-27b`, and the cluster image
   predates these fixes until CI runs (blocker 9).
4. **One model on the chat allowlist.** `COMMUNICATION_MODEL_CHAT_MODELS` on the
   cluster worker allowlists one model (`docs/home-cluster.md` names
   `qwen3-8-27b`); anything else is refused at execution
   (`internal/worker/modelchat.go:308`).
5. **No resource limits.** The Operations page says so openly (C13f, `09411da`);
   its copy has never been rendered in a gate (GAP, `docs/m4-exit-status.md`).
   A noisy `process.exec` step is unbounded.
6. **The pending reruns have run.** Every rerun this list carried has a verdict row in
   `docs/m4-exit-status.md` now — C6 (`C6d GAP → PASS` at pass 25, `fa0c0e0`), C2a/C2b on
   the agent variant (`599e4f9`, `04fb651`), C6e/W6's cross-volume `workspace_lost`
   (`efb82bd`+`0a0d6a9`), C5h's scratch `maxAttempts: 1` arm, C4e (`2f0fe1f`), the C10b
   FAIL (`04fb651`'s grading fix) and the m5-journey browser legs — and the one item still
   without a live verdict there is the `5145bcb` non-member 404 legs, recorded as not
   re-run.
7. **Attempt agents could not run git in their own worktree.** In live25's agent run the
   agent reported "Git commands also failed because the repo's worktree link is broken"
   (`docs/m4-exit-status.md`, C1g's live25 note): the attempt launch plan omitted ADR-0017's
   `mirror_read` grant, without which every git command in the worktree dies. **Fixed in
   `e83913a`, measured in pass 26** (`live26/`, lab `76a9e64`): C1 re-ran **98 PASS / 0 FAIL / 0 GAP**
   (`live26/C1.out:211`) and the agent runs git in its worktree now — `live26/_events-C1.txt` carries
   zero `not a git repository` / `worktree link` / `backing repo` strings where live25 carried them,
   and the reviewer's own messages cite a `git diff` against HEAD (`:14, :16`).
8. **A `deny` profile was not enforced in an attempt.** The attempt path asked the harness to
   prompt only for `ask` — `deny` and `preapproved_within_sandbox` both fell through with
   `modeID = ""` (`internal/worker/agentturn.go:405-416`) and `session/set_mode` is sent
   only when a mode is set (`internal/agent/acp/handle.go:200-211`) — so the attempt never
   left `claude-agent-acp`'s shipped `auto` mode: no prompt arrived, nothing was
   journalled, and the lab's 34 tool calls produced 0 `conversation.permission.*` rows
   (`docs/design/attempt-permissions.md` § "Why attempts journal no verdict"). **Fixed in
   `a0fd9e7` + `1b93069`, measured in pass 27** (`live27/`, lab `1b93069`): C1+C2 **127 PASS / 0 FAIL /
   0 GAP** (`live27/C1,C2.out:280`), and the lab journal after the pass reads
   `conversation.permission.requested` 23 / `conversation.permission.decided` 23 (all `status=decided`,
   `decided_by=node_policy:preapproved_within_sandbox`) over 31 `conversation.tool.call` rows — so
   `deny` prompts and is answered by policy. Condition (a) of the 2026-10-16 evaluation — the one item
   blocker 2 above waits on — is thereby closed **in the lab for pipeline attempts** (ADR-0036's addendum,
   corrected 2026-10-17); what blocker 2 still waits on is the owner's separate decision to make the mode a
   product default. **Update (passes 28–30):** `deny` is now enforced on **both** paths — `c1c7c19` opens
   then immediately closes deny conversation prompts `cancelled` by policy (a `1b93069` live deny prompt had
   waited for a human and closed `expired`), proven at pass 30 (`live30/deny_probe.out`: 1 requested / 1
   decided (cancelled) / 0 allow / 0 preapproved, `deny-probe.txt` in no workspace); the remaining gap is
   that preapproved **conversations** run in the harness's auto mode with no per-call journaled verdict —
   attempts still journal policy verdicts (C1j PASS at pass 29, `live29/C1.out:97-:100`).
9. **The cluster runs a build older than every fix above.** GitHub Actions has not run
   since `c5c7888` (account billing), so no `main` image has been published for Flux image
   automation to pin (`docs/home-cluster.md` § 4) — the cluster worker predates `d9928d9`,
   `fa0c0e0` and everything between.
