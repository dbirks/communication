# M4 exit status — an honest scoreboard from the live evidence

Contract authority: `docs/m4-contract.md` § 7.1 (gates C1–C14, sub-cases named by letter) and § 7.2
(Playwright legs W1–W11). Evidence root: `$HOME/.cache/communication-lab/m4-exit/` — each
`<GATE>.out` is the driver's (`e2e/m4/e2e_m4_exit.py`) full output for one gate in one pass.

| pass | directory | lab commit | coverage |
|---|---|---|---|
| pass 1 | `live/` | `4245c48` | C1–C14, W1, W3, W7 |
| pass 2 | `live2/` | `9134319` | C1–C14, W1, W3, W7 |
| pass 3 | `live3/` | `fbf4fd5` | C6, C7, C10, C12, W3 |
| pass 4 | `live4/` | `854b2ef` | C1–C14, W1, W3, W4, W7, W8, W9 |
| pass 5 | `live5/` | `42187e7` | C1, C4, C5, C12, W4 (reruns after the driver fixes in `a2233fd`/`42187e7`) |

A fresh lab reset + seed ran before EACH gate of passes 4 and 5 (`_seed-<GATE>.out` is that gate's seed
manifest and `_build.out` the lab commit it was built from), so no pass-4/5 verdict inherits another
gate's stack state. RC4's concurrency caveat still bites inside a gate wherever a foreign run happened
to hold a lease — that is precisely why C9a's restart arm GAPs (`live4/C9.out:40`) instead of proceeding.

Reading rules. The row takes the **newest pass in which the item ran**. Verdicts come from
`grep -nE '^\s*(PASS|FAIL|GAP)\b' <file>` and nothing is quoted that was not read.

- **PASS** — every arm of the item that ran emitted a literal `PASS`, and no arm emitted `FAIL`.
  Where a secondary arm emitted `GAP`, the row names it.
- **FAIL** — at least one arm emitted a literal `FAIL` line.
- **GAP** — the item's core arm emitted `GAP`: the lab could not produce the state, so it is unmeasured,
  not passing.
- **NOT RUN** — no verdict line exists for the item (blocked behind an upstream GAP/crash, or the driver
  has no leg).

A `PASS` line never substitutes for the item as a whole: where only part of a sub-case ran, the row's
note says which arm produced the verdict and which never did. Gate-level `FAIL=n GAP=m` summary lines
count driver verdicts, of which a sub-case often has several; the totals below count § 7 items.
Fixes that landed **after** the pass that produced a verdict are named inline as
"fixed in `<sha>`, not re-run" (`git log --oneline 854b2ef..42187e7` and `42187e7..HEAD`).

## § 7.1 scripted gates + § 7.2 playwright legs

| Item | What it proves | Verdict | Measured at | Evidence |
|---|---|---|---|---|
| C1a | run POST returns 201 queued | PASS — the agent arm and the replay twin | pass 5 @ 42187e7 | live5/C1.out:24, :146 |
| C1b | designated approver's decide posts 200 | PASS | pass 5 @ 42187e7 | live5/C1.out:61, :149 |
| C1c | run reaches terminal `completed` | FAIL — the agent arm ended `failed` (`node_execution_failed:/plan`, live5/C1.out:29); both twin arms completed — the agent arm is the unattended-permission-prompt limit below | pass 5 @ 42187e7 | live5/C1.out:27 (agent), :62, :150 (twins) |
| C1d | full node key set, statuses, execution locations | PASS — 14 keys, exact, control_plane/worker split correct, both twins | pass 5 @ 42187e7 | live5/C1.out:78-80, :166-168 |
| C1e | digests, checkpoint count, attempt_count=1 | PASS — 5 run_inputs, digests match the manifest, 8 checkpoints == 8 succeeded worker nodes, `attempt_count = 1` | pass 5 @ 42187e7 | live5/C1.out:81-85 |
| C1f | artifact bytes readable, redaction_count 0 | FAIL — driver probe, not the product: the row it wants is printed one line above (`markdown / text/markdown / redaction 0 / ready`) but the check splits the psql row into 7 fields while the SELECT emits 8, so it reads `[]`; every C1f arm after it (redaction, GET /artifacts/{id}/content, artifact.created) never ran | pass 5 @ 42187e7 | live5/C1.out:88 (the row: :87) |
| C1g | run.completed carries result_bindings | PASS — summary non-empty, review_approved true, iterations 2 == ledger | pass 5 @ 42187e7 | live5/C1.out:91-94 |
| C1h | journal sequence contiguous for the run | FAIL — driver probe: contiguity, open/close, attempt-correlation all PASSed; the one failing arm demands a FIXED first-occurrence order, and the engine journals `/plan`'s `run.checkpoint_saved` one seq BEFORE `approval.requested` (visible in live5/C4.out:41-42) | pass 5 @ 42187e7 | live5/C1.out:99, :187 (arms that passed: :95-98, :100-102, :110) |
| C1i | replay reproduces the key set and plan_digest | PASS — both twins completed at last, so identity is finally assertable: identical 14-key set, `plan_digest` seed == replay == manifest; the cross-variant comparison still FAILs (live5/C1.out:236) because its agent leg is C1c's | pass 5 @ 42187e7 | live5/C1.out:234-235 |
| C2a | secret reaches only the live authorized process | GAP — the gate WAS approved and `/implement` ran (run status `'completed'`), but no attempt was still worker-held when the poll looked, so "exactly one place" was unmeasurable | pass 4 @ 854b2ef | live4/C2.out:63 (approval arm :30) |
| C2b | worker unmounts the env at the node boundary | NOT RUN — blocked behind C2a's GAP | — | live4/C2.out:63 |
| C2c | sentinel absent from every durable surface | GAP — only the encrypted-store arm ran (the value lives in `secret_versions.content_sha256`, no plaintext); the live-surface sweep needs C2a's held attempt | pass 4 @ 854b2ef | live4/C2.out:63 (arm that ran: :26) |
| C2d | reviewer prompt and tool output carry no secret | NOT RUN — blocked behind C2a's GAP | — | live4/C2.out:63 |
| C3a | two workers contend on a deep queue | GAP — both workers online, but the 25-attempt queue is authored on C8's fan-out, which produces no children in this build; `pipeline.invoke` child runs are fixed in `21656f6`, not yet re-run | pass 4 @ 854b2ef | live4/C3.out:29 (workers online: :28) |
| C3b | never two live claims of one attempt | PASS — held=1, one distinct worker, on both inspected runs | pass 4 @ 854b2ef | live4/C3.out:32-33, :36-37 |
| C3c | one /implement claim, one fencing token drawn | GAP — no `/implement` attempt row carries a worker_id in any inspected run; the `attempt_fencing_seq` arm PASSed | pass 4 @ 854b2ef | live4/C3.out:38 (arm that passed: :39) |
| C3d | negative control sentence recorded | NOT RUN — a report line, not an assertion (C4 is the proof) | — | live4/C3.out:44 |
| C4a | a live lease exists to freeze | GAP — the run parked at `/approve` (`waiting_human`) and `/plan` finished inside the driver's 2s claim-poll interval, so no lease was ever held to freeze; the pass-4 crash (`psql rc=1`) was fixed in `a2233fd` and this is the honest verdict behind it | pass 5 @ 42187e7 | live5/C4.out:49 (state dumped: :29-42) |
| C4b | frozen lease becomes interrupted with a retry | NOT RUN — blocked behind C4a | — | live5/C4.out:49 |
| C4c | a stale owner cannot publish success | NOT RUN — blocked behind C4a | — | live5/C4.out:49 |
| C4d | replacement attempt succeeds, run completes | NOT RUN — blocked behind C4a | — | live5/C4.out:49 |
| C4e | fenced turn appends no transcript rows | NOT RUN — blocked behind C4a | — | live5/C4.out:49 |
| C5a | a live attempt exists to SIGKILL | GAP — pass 5 caught nothing worker-held in 300s (the twin parked `waiting_human`), so `42187e7`'s race-free SIGSTOP→prove-live→SIGKILL arm has still never executed. Pass 4 is the last pass that produced a live attempt and killed it (owner `worker-b`, `/plan`, fencing token 2 — dumped, not verdicted), so the newest pass is a step back in reach, not in outcome | pass 5 @ 42187e7 | live5/C5.out:49 (pass-4 kill: live4/C5.out:29-38) |
| C5b | kill reads interrupted, never completed | FAIL — the pass-4 kill landed after the attempt had already written `succeeded` + `node.attempt.completed`, so all five arms read the dead process's own success instead of a reconciler `interrupted{lease_expired}` — exactly the race `42187e7`'s SIGSTOP-first arm removes: **fixed in `42187e7`, not re-run** (pass 5 GAPped at C5a before reaching it) | pass 4 @ 854b2ef | live4/C5.out:41-47 |
| C5c | checkpoints and artifacts survive the kill | PASS — `run_checkpoints` identical before/after the kill, last completed boundary still queryable, ready artifact count unchanged, nothing left `uploading` | pass 4 @ 854b2ef | live4/C5.out:52-55 |
| C5d | same-volume workspace is reclaimed, not rebuilt | PASS — workspace `ready`, `volume_id` byte-identical across the kill (ADR-0017's reclaim rule), no `workspace.recovery_lost` event | pass 4 @ 854b2ef | live4/C5.out:66-68 |
| C5e | retry posts from the last checkpoint | FAIL — `POST /runs/{id}/retry` → 409 `no failed, interrupted or cancelled node execution to retry` (`run_status='waiting_human'`), and the killed attempt still read `succeeded`; the retry-row arm GAPped for want of a second attempt. Both follow from C5b's race, and RC1's halved budget (`0a0e6bb`) is separately proven dead at live5/C1.out:85 | pass 4 @ 854b2ef | live4/C5.out:71, :80 (GAP: :81) |
| C5f | continue_workspace is the observed default | GAP — git HEAD was unreadable across the restart in the retry window (`before='' after=''`), so the not-reset claim is unmeasured | pass 4 @ 854b2ef | live4/C5.out:82 |
| C5g | retry appends, never rewrites history | FAIL — 7 of 8 node keys read `attempts=0` (that killed run's remaining nodes were cancelled/skipped, not attempted), while `/plan` appended exactly 1 attempt and the run reached `completed` after the checkpointed retry; the key-set-vs-C1 identity arm GAPped because C1 crashed in that pass and had no key set to compare | pass 4 @ 854b2ef | live4/C5.out:85-92 (PASS arms: :89, :95; GAP: :96) |
| C5h | exhausted budget fails the run honestly | GAP — every node the worker can be killed mid-way through is authored `maxAttempts: 3`; the lab ships no long-running `maxAttempts: 1` twin node, so the refusal arm has nothing to measure | pass 4 @ 854b2ef | live4/C5.out:99 |
| C6a | revision carrying retry.workspacePolicy | PASS — the restore_checkpoint twin published as its own immutable revision with exactly one policy line changed (the pass-3 `metadata.name` refusal was fixed in `350d644`/`f53cfff`) | pass 4 @ 854b2ef | live4/C6.out:27, :28, :37 |
| C6b | restore_checkpoint really resets the worktree | GAP — the authored revision's run parked at `/approve` (`waiting_human`) with nothing worker-held in 300s, so there was no mid-node kill to restore from | pass 4 @ 854b2ef | live4/C6.out:63 |
| C6c | restore-mode retry completes the run | NOT RUN — blocked behind C6b | — | live4/C6.out:63 |
| C6d | dirty boundary refuses, resets nothing | NOT RUN — blocked behind C6b | — | live4/C6.out:63 |
| C6e | cross-volume loss says recovery_lost | NOT RUN — blocked behind C6b | — | live4/C6.out:63 |
| C7a | until_exhausted ends the run after 3 iterations | PASS — `failed`/`until_exhausted` (P3's cause fix, `94f0ce3`), exactly 3 iterations, 9 terminal body rows, the exhausted loop's descendants cancelled with no route taken; the until scope's own `iterations == 3` row GAPs (:70) | pass 4 @ 854b2ef | live4/C7.out:46-48, :66-69 |
| C7b | per-iteration evidence stays readable | PASS — one row per iteration key, outputs preserved, 3 `node.scope.iteration` with `pass_when_result=false`, evidence attached to both scope and run failures; the "3 distinct `test-*` artifact rows" arm GAPs (no artifact rows for the exhausted run) | pass 4 @ 854b2ef | live4/C7.out:49-58 (GAP arm: :59) |
| C7c | indeterminate predicate is predicate_error | GAP — the schema-declared field is refused at publish (`unknown_field` PASS), so no published document reaches the eval-time `predicate_error` arm; that half is only proven offline (`e2e/m4/test_c7_logic.py`) | pass 4 @ 854b2ef | live4/C7.out:124 (schema arm: :123) |
| C7d | carryForward observed across iterations | PASS — `previous` empty on iteration 1 (probe skipped), non-empty on 2 and 3 (probe succeeded), over a real exhaustion run; the prompt-echo half of the sentence GAPs because the twin is `process.exec` with no transcript | pass 4 @ 854b2ef | live4/C7.out:76 (transcript GAP: :77) |
| C8a | zero-item fan-out succeeds and completes | FAIL — with 0 items `/fan_out` went `cancelled`, `outputs.children` was absent and the run ended `failed`; the POST arm PASSed. Child runs could not start at all in this build — `pipeline.invoke` resolving its target by name and writing one invocation row is fixed in `21656f6`, **not yet re-run** | pass 4 @ 854b2ef | live4/C8.out:11, :13, :14 (POST arm: :9; journal arm GAP: :12) |
| C8b | 25 children, one run each, depth 1 | FAIL — 0 invoke rows under `/fan_out` and 0 `pipeline_invocations` joined to child runs (the depth/project/ledger arms GAPped for want of rows). Same fix pending: `21656f6`, not re-run | pass 4 @ 854b2ef | live4/C8.out:23-24 (GAPs: :25-27) |
| C8c | maxConcurrency 3 measured from the journal | GAP — the for_each scope produced no measurable commit point (no invoke rows to count concurrently). Needs `21656f6`'s children to exist first | pass 4 @ 854b2ef | live4/C8.out:28 |
| C8d | one failing child, siblings preserved | FAIL — `collect_and_continue` left the scope `cancelled` with nothing collected ("all 25 children ran" GAPped: none ran). Same fix pending: `21656f6` | pass 4 @ 854b2ef | live4/C8.out:29 (GAP: :30) |
| C8e | stop / fail_after_all child policies | NOT RUN — the gate aborted on `TypeError: 'NoneType' object is not iterable`; `42187e7` armed C8's twin and stops crashing on an absent children list — **fixed in `42187e7`, not yet re-run** | — | live4/C8.out:31, :38 |
| C8f | depth guard refuses self-invocation | NOT RUN — gate aborted | — | live4/C8.out:38 |
| C8g | parent cancel cascades to every child | NOT RUN — gate aborted (and `21656f6`'s cascade path is unmeasured here) | — | live4/C8.out:38 |
| C8h | detach cancel policy is refused at validate | NOT RUN — gate aborted | — | live4/C8.out:38 |
| C9a | gate waits as a row with zero attempts | PASS — `/approve` `waiting` with 0 attempts, `waiting_human`, no lease, seen by the ops counters and by both API replicas at the same version; the restart arm GAPped because a foreign run held a live lease (§ 7.0: disturb only what you created) | pass 4 @ 854b2ef | live4/C9.out:32-36, :46 (restart GAP: :40, :43) |
| C9b | non-approver refused, gate unmoved | PASS — bob: 403 `approval-denied`, `approval.denied{not_a_designated_approver}` journaled, version unmoved, still `waiting_human` | pass 4 @ 854b2ef | live4/C9.out:55-61 |
| C9c | approver removed from project cannot decide | PASS — alice after removal: 403, `approver_lost_access` journaled, no decision written | pass 4 @ 854b2ef | live4/C9.out:76-81 |
| C9d | two simultaneous decides, exactly one winner | PASS — one 200, loser 409 `approval_already_decided` carrying the winner's decision, one row, version 2 | pass 4 @ 854b2ef | live4/C9.out:94-97 |
| C9e | rejection is a business outcome, not an error | PASS — rejection accepted (200), `/approve` `succeeded`/`rejected`, no `error_class`, dependants skipped `condition_default`/`dependency_skipped`, run `completed`; the causal arm (skips *because* of the rejection) GAPs — the seeded graph gates nothing on `nodes.approve.outputs.decision` | pass 4 @ 854b2ef | live4/C9.out:100, :107-110 (causal GAP: :111) |
| C9f | on_timeout arms expire, re-request, cancel | GAP — only "the deadline is ARMED" PASSes; the § 7.0 seed authors `deadlineSeconds: 86400` and `on_timeout: fail`, so expire/cancel_run rows do not exist and pulling `deadline_at` forward by SQL would fake the clock | pass 4 @ 854b2ef | live4/C9.out:112-114 (armed arm: :39) |
| C9g | human takeover pauses and resumes the run | GAP — the C9 runs' attempts carry no `conversation_id` (the twin is `process.exec`), so `POST /conversations/{cid}/take-control` has no run conversation; this arm needs a live `agent.acp` turn, i.e. the permission-prompt limit below | pass 4 @ 854b2ef | live4/C9.out:132 |
| C10a | malformed reply fails as invalid_output | PASS — the type-switched reviewer published as its own revision (the pass-3 splice blocker is gone), both attempts `failed`/`invalid_output`, `output_errors` carries the JSON-Schema location, no `node.attempt.completed` | pass 4 @ 854b2ef | live4/C10.out:48-51, :62 |
| C10b | routing never changes during that failure | FAIL — one arm is the probe, not the product: "no `node.execution_skipped{condition_default}` may appear" is unfalsifiable on the seeded graph, which skips `/emit_items` on `inputs.fanout` by design (the same pair C9e counts at live4/C9.out:109; `/emit_items skipped` is dumped at live4/C10.out:76). Everything that ran passed: outputs NULL, scope `failed`/`child_failed`, run never completed, retry per policy. Two arms GAP: no mid-failure sample of the scope (:54) and the fixture cannot answer valid-then-malformed, so the retry's success is unproducible (:64) | pass 4 @ 854b2ef | live4/C10.out:58 (arms that passed: :52-57, :59-61, :63) |
| C10c | model.chat variant fails identically | GAP — no model.chat node ran (`COMMUNICATION_MODEL_PROVIDER_BASE_URL configured=False`); ADR-0024 declares model.chat M4's first sacrifice, so the boundary-vs-adapter claim is unproven, not satisfied by the `process.exec` arm | pass 4 @ 854b2ef | live4/C10.out:67 |
| C11a | collector sink is real, injected run starts | PASS — sink answers the liveness probe and logs it; injected-body twin POSTed 201 | pass 4 @ 854b2ef | live4/C11.out:24-25 |
| C11b | injection verbatim, nothing egresses | PASS — the injected line reaches the downstream prompt verbatim, ZERO collector requests carry the sentinel (digest-compared), zero carry a fencing token, and the twin run recorded NOTHING at the sink (`--block-net`); the report-honesty probe (D3) and the verbatim probe (D2) both PASS now that `554092a` reads the right surfaces. The `sandbox.verified` truthfulness arm GAPs (7 rows, 0 false to check) | pass 4 @ 854b2ef | live4/C11.out:33, :36-38, :40 (GAP: :39) |
| C11c | structural mitigation holds | NOT RUN — the gate prints its deferral instead of claiming: the structural claims (scoped/capped/validated/redacted outputs, own permission profiles, allowlist no-escape) are left to C12b and spec § 6/04, and no verdict line exists for C11c. The evidence it defers to now exists — C12b PASSes at pass 5 (`live5/C12.out:72`) — but the row itself was never measured | — | live4/C11.out:41 (the deferral it points at: live5/C12.out:72) |
| C12a | CEL subset cannot be widened by authoring | PASS — `exists()`, `now()`, `matches()` refused `cel_function_not_allowed`, `workspace.*` refused `undeclared_root` | pass 5 @ 42187e7 | live5/C12.out:43-46 |
| C12b | expression and fan-out budgets refuse | PASS — 65 expressions `expression_budget_exceeded`, 64 validate (no off-by-one), 1001 literal items refused by schema, and the 1001 **evaluated** items now fail the run with `failed_cause='fanout_items_exceeded'` (pass 3's generic cause was fixed in `e0ee333`; pass 4's 422 idempotency-key crash was fixed in `42187e7`) | pass 5 @ 42187e7 | live5/C12.out:55, :56, :61, :72 |
| C12c | a running run stays pinned to its revision | PASS — revision/plan digests and revision id unchanged by a new publish, `/nodes` plan view byte-identical, later nodes still execute the pinned plan, re-pin moves the assignment and only NEW runs (pass 3's FAIL was fixed in `554092a`) | pass 5 @ 42187e7 | live5/C12.out:96-102, :107-110 |
| C12d | byte-identical republish is 409 | PASS — 409 `revision_already_published` naming the existing revision; a changed budget number publishes 201 | pass 5 @ 42187e7 | live5/C12.out:130-132 |
| C12e | revision and plan digests separate correctly | PASS — whitespace-only wording moves revision only; a `passWhen` operator moves both | pass 5 @ 42187e7 | live5/C12.out:151-152 |
| C13a | seven deferred kinds refused, naming M5/M6 | PASS — 7 `kind_not_implemented` at the kind locations, each naming M5 or M6, draft recorded `invalid` | pass 4 @ 854b2ef | live4/C13.out:35-44 |
| C13b | config typos refused at highlightable locations | PASS — typo/maxConcurrency/carryForward/escape/cwd/unquoted-date/negative-cap each refused at its own `instance_location` | pass 4 @ 854b2ef | live4/C13.out:49-79 |
| C13c | secret literal blocks publish, value redacted | PASS — `secret_literal_detected` at the env key, response redacted, publish refused 422; the "the detector itself is what blocked" arm GAPs (the draft was already invalid, so the 422 spelling is unobservable) | pass 4 @ 854b2ef | live4/C13.out:86-88 (GAP: :89) |
| C13d | declared CEL roots compile, reserved root refused | PASS — all seven roots compile in scope, `loop` refused as reserved, out-of-scope `item`/`items`/`previous`/`iteration`/`parameters` refused `undeclared_root` | pass 4 @ 854b2ef | live4/C13.out:102-115 |
| C13e | continue_live and run.override refused | PASS — `unsupported_session_mode`, no route for `/runs/:id/override` (404), `run.override.applied` never emitted | pass 4 @ 854b2ef | live4/C13.out:120-123 |
| C13f | no resource-limit columns anywhere | GAP — the API half PASSes (`/system/scheduler` carries no cpu/memory/disk field); the ops page's wording was never rendered in this gate, and the page copy that says resource limits are not implemented shipped in `09411da`, **after** pass 4's lab commit — not yet re-run (W7 is the browser leg that would read it, and it does not assert that line) | pass 4 @ 854b2ef | live4/C13.out:128 (API arm: :127) |
| C14a | API replicas roll, the stream continues | PASS — both replicas restarted one at a time under load, LB answered every probe, Last-Event-ID resume with 1 reconnect, no duplicate/gap/foreign frame, the approval decided mid-roll landed exactly once, and the run reached `completed` (pass 2's `failed` is gone) | pass 4 @ 854b2ef | live4/C14.out:34, :43, :55-67 |
| C14b | two replicas cannot commit one transition twice | PASS — the safety proof § 7.1 itself names: no journal seq duplicated or lost, run slice ascending, `run.completed` once, ZERO node keys with two `succeeded` rows. Two observation arms GAP by design: the advisory-lock handover is unobservable (the log mark is released every tick — D6's unfalsifiable probe now GAPs instead of FAILing) and forcing a simultaneous advance needs a store seam § 7.1 disclaims | pass 4 @ 854b2ef | live4/C14.out:48-50, :53-54 (GAPs: :59, :68) |
| C14c | SCHEDULER=off leaves a run queued | GAP — the flag is no longer inert (`9af17dc` makes it stop a replica's engine, so P2 is fixed, and the run never even got to compare), but `compose.m4.yml` feeds api-a and api-b from ONE shell variable, so there is no single off-replica to compare against without a container recreate § 7.0 keeps out of the gates | pass 4 @ 854b2ef | live4/C14.out:69 |
| W1 | New run form comes from spec.inputs | PASS — fields, required-ness, declared default and repository list all rendered from the pinned revision; double-click Submit → one run + one stored `X-Idempotency-Key` | pass 4 @ 854b2ef | live4/W1.out:37-46 |
| W2 | live stream renders iterations, not duplicate nodes | NOT RUN — no driver leg (`_playwright_stub`) | — | e2e/m4/e2e_m4_exit.py (w2 stub) |
| W3 | gate card: roles, countdown, approve, bob has no button | GAP — W3 starts the **agent** variant to reach a gate, and that run never parked on a pending approval (`status 'failed'` after 420s): its `/plan` attempt dies on the unattended permission prompt (the limit below), so the card had nothing to render. This is the newest pass; pass 3's PASS is superseded | pass 4 @ 854b2ef | live4/W3.out:59 (run arm: :24; permission trail dumped: :58) |
| W4 | pinned-digest notice after a mid-run publish | PASS — the run page renders the pinned r1 digest before and after a live r2 publish, does not move onto r2, keeps "pinned r1" (not r2), and the notice "revision 2 published since this run started — this run is pinned to 1" renders. The leg exists since `d1bbcc3`, and the pinned-digest/notice copy it asserts is `3654c18`'s — both are already ancestors of pass 4's `854b2ef`, so neither is an unrun fix. Pass 4's crash was the exit stack not being up at all (`live4/_seed-W4.out:2 SEED FAIL stack not ready`) — an environment failure, not a leg failure; pass 5 is the rerun that measures it | pass 5 @ 42187e7 | live5/W4.out:30, :46-52 (pass-4 crash: live4/W4.out:23) |
| W5 | kill renders honest interrupted wording | NOT RUN — no driver leg (`_playwright_stub`); no scripted substitute — C5b–C5h are blocked above | — | e2e/m4/e2e_m4_exit.py (w5 stub) |
| W6 | cross-volume run says "prior edits lost" | NOT RUN — no driver leg (`_playwright_stub`); no scripted substitute — C6e is blocked above | — | e2e/m4/e2e_m4_exit.py (w6 stub) |
| W7 | ops page counters and per-worker load | FAIL — every counter and both per-worker load rows render, and the offline→restored arms PASS, but `queued_unbindable_runs` stayed 0 while the affinity-bound run went `running`: the driver writes the affinity by SQL (the public API exposes placement as a view only) and the advancer moves every queued run on its first pass, bindable or not (§ 5.2's `queued` state never existed — its own "waiting for its worker" arm GAPped for the same reason) | pass 4 @ 854b2ef | live4/W7.out:51 (counters PASS: :29-38; GAP: :52) |
| W8 | validate panel renders located errors by source | PASS — all 7 `kind_not_implemented` rows render at their `/spec/nodes/N/kind` location naming M5/M6, the schema/loader/compiler findings render with source + hint, and the secret-literal finding renders redacted | pass 4 @ 854b2ef | live4/W8.out:40-53, :68-72, :87, :102, :119-120 |
| W9 | cross-project deep links 404 with zero leakage | PASS — outsider session gets 404 + not-found copy on run, `/nodes` and the SSE URL, SSE never opens, and no project name / node name / digest value appears in the DOM, console clean. Two arms GAP: the row names carol but § 7.1 C9d needs carol as an M4 maintainer, so the outsider is the seeded `erin`; and the `/approvals/{id}` deep link had no approval to link to | pass 4 @ 854b2ef | live4/W9.out:35, :43-44, :46-51 (GAPs: :26, :45) |
| W10 | stream continuity across a replica roll | NOT RUN — no driver leg (`_playwright_stub`); C14a's scripted SSE arm covers the mechanism, not the browser | — | e2e/m4/e2e_m4_exit.py (w10 stub) |
| W11 | child tree renders, internals absent from the DOM | NOT RUN — no driver leg (`_playwright_stub`); and it has no scripted substitute until C8b's children exist (pending `21656f6`) | — | e2e/m4/e2e_m4_exit.py (w11 stub) |

Totals: 85 items (74 § 7.1 sub-cases + 11 § 7.2 legs) — PASS 37, FAIL 11, GAP 17, NOT RUN 20.

For comparison, the same scoreboard at pass 3 (commit `8f58157`) read PASS 20, FAIL 9, GAP 13,
NOT RUN 43. Passes 4–5 promoted 18 items to PASS — C1e, C1g, C1i, C5c, C5d, C6a, C7a, C7b, C7d, C10a,
C11b (from FAIL), C12b, C12c (both from FAIL), C14a, C14b (both from FAIL) and W4, W8, W9 (off the stub
list; W4's leg landed in `d1bbcc3` and the pinned-digest copy it asserts in `3654c18`, both already
ancestors of pass 4's lab, so neither is an unrun fix). C1e's PASS is RC1's double `attempt_count`
proven dead in a live run. Ten more items traded "never ran" for a FAIL and three for a GAP (C1f, C1h,
C5b, C5e, C5g, C8b, C8d, C10b FAIL; C6b, C7c, C8c, C10c GAP) — the count of unmeasured items is down
from 43 to 20, and every remaining FAIL names either `21656f6`/`42187e7` pending a rerun or a broken
probe below. One item moved backwards: W3, PASS at pass 3, GAP at pass 4, because that leg reaches its
gate through the agent variant (C1c has been the same FAIL all along; passes 4–5 only identify why).

## What blocks the M4 exit

Finding ids (`P*`, `D*`, `RC*`) are `docs/m4-live-findings.md` (written from pass 1); "fixed in
`<sha>`, not re-run" names a commit that landed after the pass behind the verdict.

**Product bugs — open**

- C8a–C8d `live4/C8.out:11, :23-24, :29` — `pipeline.invoke` could not start a child run at all: an
  authored invoke names its target pipeline by name while `CreateChild` demanded a uuid, and the
  invocation row was inserted twice, so `/fan_out` cancelled, no `pipeline_invocations` existed and the
  parent failed. **Fixed in `21656f6`, not yet re-run** — C8 last ran at `854b2ef`, before it. That one
  rerun is also what unblocks C3a, C3c, C8e–C8h and W11.
- W7 `live4/W7.out:51` — `queued_unbindable_runs` stayed 0 because the affinity-bound run left `queued`
  on the advancer's first pass, so § 5.2's "queued but unbindable" state is not reachable on the path the
  leg takes (the affinity is written by SQL; the public API exposes placement as a view only).
  Unclassified in `docs/m4-live-findings.md`, and no fix commit since — it needs a rerun (or a placement
  seam) before it is called a product bug rather than a driver shortcut.
- No longer blocking: C12b (`e0ee333` named the cap failure) and C12c (`554092a`'s corrected probe) both
  PASS at pass 5 (`live5/C12.out:72`, `:102`); RC1/P1's double `attempt_count` is dead — C1e reads
  `attempt_count = 1` live at `live5/C1.out:85` (`0a0e6bb`), so C5e's retry-from-checkpoint row is
  reachable once C5a gets a live attempt; and P2 (the inert scheduler flag) died in `9af17dc`, already an
  ancestor of pass 4's lab, which is why C14c's GAP changed wording rather than staying a `FAIL`.

**Driver bugs — open (the probes are broken, not the product)**

- C1f `live5/C1.out:88` — the check splits its psql row into 7 fields while the SELECT emits 8
  (`sensitivity` was added), so it reads `[]` and FAILs on a run whose artifact row is printed correct
  one line above (`:87` — `review-evidence.md markdown text/markdown … redaction 0 ready`). Everything
  after it in C1f (redaction/state, `GET /artifacts/{id}` + `/content` hashing to the row's sha256,
  `artifact.created` journaled) is NOT RUN behind that parse. No committed fix as of `21656f6`.
- C1h `live5/C1.out:99, :187` — the milestone-chain arm demands a fixed first-occurrence order and
  `present == JOURNAL_MILESTONES`; the engine legitimately journals `/plan`'s `run.checkpoint_saved`
  before `approval.requested` (that order is literal at `live5/C4.out:41-42`), so only the ordering
  conjunct fails. Contiguity, open/close and attempt correlation PASS (`:95-98`, `:100-102`, `:110`).
  No committed fix as of `21656f6`.
- C4a / C5a `live5/C4.out:49`, `live5/C5.out:49` — both legs wait for a worker-held attempt on the twin
  run, but the twin parks at `/approve` (neither leg decides that gate) after a `/plan` attempt that
  finishes inside the 2s claim-poll interval, so no lease exists to freeze and nothing exists to kill.
  C4b–C4e are unreachable for a reason the driver controls. The pass-4 FAILs on C5b, C5e and C5g
  (`live4/C5.out:41-47, :71, :85-92`) are the same race's output — the worker was killed after its node
  had already completed, so nothing was interrupted and nothing was there to retry — and `42187e7`'s
  race-free SIGSTOP→SIGKILL arm has still never executed: the pass-5 rerun GAPped at C5a before it.
- C10b `live4/C10.out:58` — "no `node.execution_skipped{reason:'condition_default'}` may appear" is
  unsatisfiable on the seeded graph, which skips `/emit_items` on `inputs.fanout` by design (`:76`; C9e
  counts the same pair at `live4/C9.out:109`). Unclassified in the findings file.
- Fixed and re-proved, listed so nobody re-files them: C1's and C4's `psql rc=1` crashes
  (`live4/C1.out:75`, `live4/C4.out:29`) were `a2233fd`; C12b's 422 idempotency key (`live4/C12.out:70`)
  and C5's kill race (`live4/C5.out`) were `42187e7`; C8's `NameError: c8_sql` and the C11/C14 probes
  (D2, D3, D4, D6) were `554092a` — all visible in the pass-4/pass-5 verdict lines above.
- W4's pass-4 crash (`live4/W4.out:23`) was the exit stack not being up
  (`live4/_seed-W4.out:2 SEED FAIL stack not ready`), not the leg. `77d46ba`/`0a20a8f` (CI data race,
  lazy-route UI determinism) landed after pass 4 and are not what makes W4 pass — the pass-5 rerun is
  (`live5/W4.out:52`).

**Known design limit — unattended permission prompts (accepted behaviour, not a bug)**

Five items are blocked by the same mechanism, so they are grouped rather than counted as product bugs:
under `permission_mode: ask`, a run attempt's prompt is journalled
`conversation.permission.requested` → `conversation.permission.decided{status:'cancelled',
decided_by:'node_policy:ask_unattended'}`, the agent's tool call gets the ACP cancelled outcome, and
`execute` fails. C1's agent run shows the trail three times, one per attempt (`live5/C1.out:55-60`, the
titles are the agent's own `find …`/`cat hello.py` calls), and the run ends
`node_execution_failed:/plan` (`live5/C1.out:27`).

- C1c `live5/C1.out:27` and the cross-variant key set `live5/C1.out:236` — the agent leg cannot reach
  terminal `completed`, so C1's twin-vs-agent identity claim has one leg missing.
- W3 `live4/W3.out:59` — the gate card leg starts the agent variant to reach a gate and the run `failed`
  after 420s, so nothing parked to render.
- C9g `live4/C9.out:132` — take-control needs a live `agent.acp` turn; the twin's attempts carry no
  `conversation_id`.
- C11's agent arm `live4/C11.out:43` — the injected-body claim against a real ACP turn is exactly the
  profile whose `network_enforced=false`, so it is not sandbox-provable here; the engine claim
  (`--block-net`, zero sink traffic) is proven by the twin arm.

`docs/design/attempt-permissions.md` records why this is the accepted design: ADR-0016 § 5 routes
prompts to the controller only, and during an attempt the controller *is* the run; the spec's answer
path is take-control (§ 5.3), not mid-run answering. The two ways out are measured, not assumed:
`docs/compatibility/SANDBOX.md`'s `preapproved_within_sandbox` lab evaluation (`76efccd`) shows the
filesystem boundary holds (a read outside the grants → `EACCES`, row 7 PASS) while egress does **not**
(`network_enforced: false`, row 8 FAIL, and the mode never reached the preapproval code path), and
`docs/design/agent-egress.md` (`4aaee1c`) spikes the fix — nono 0.80's domain-allowlist proxy — under
D-021, still in progress. Until agent-turn egress is enforceable, no gate may claim an unattended agent
arm as proof.

**Honest lab GAPs — the state does not exist to measure**

- C2a, C2c `live4/C2.out:63` — the gate is approved, `/implement` runs and the run completes, but no
  attempt is still worker-held when the poll looks, so "the secret lives in exactly one place, live" and
  the durable-surface sweep stay unmeasured (only the encrypted-store commitment PASSes, `:26`);
  C2b/C2d ride on it.
- C4a `live5/C4.out:49`, C5a `live5/C5.out:49`, C6b `live4/C6.out:63` — the fault-injection legs need a
  worker-held attempt and the twin parks at its own undecided `/approve`. These three are the
  milestone's exit sentence: they need a leg that decides its own gate (the way C11 does at
  `live4/C11.out:27`) over a node long enough to freeze or kill, run sequentially.
- C3a, C3c `live4/C3.out:29, :38` — the 25-attempt queue is authored on C8's fan-out (pending `21656f6`),
  and no `/implement` attempt row carries a worker_id in any inspected run.
- C5f `live4/C5.out:82` (git HEAD unreadable across the restart) and C5h `live4/C5.out:99` (no
  long-running `maxAttempts: 1` twin node exists to exhaust) GAPped on their own arms; C6c–C6e, C8e–C8h
  and C4b–C4e are simply downstream — of the three fault-injection rows above and of C8's crash.
- C7b's artifact arm `live4/C7.out:59` (no artifact rows on the exhausted run), C7a's scope-iterations
  row `:70`, C7c's eval-time arm `:124` (the schema refuses the undeclared field first, so the
  `predicate_error` half is only proven offline), C7d's transcript half `:77` (a `process.exec` twin has
  no prompt to echo `previous`).
- C9f `live4/C9.out:112-114` — the seed authors `deadlineSeconds: 86400` and `on_timeout: fail`, so
  expire / re-request / cancel_run rows cannot exist without publishing a short-deadline revision, and
  pulling `deadline_at` forward by SQL would fake the clock (§ 7.0 keeps SQL as evidence only).
- C10b's mid-failure sample `live4/C10.out:54` and its "retry answers validly the second time" arm `:64`
  — the shipped fixture helper cannot answer malformed-then-valid and `make_fixture_repo.sh` must not be
  edited; C10c `:67` — no model.chat provider endpoint (ADR-0024's first sacrifice).
- C11b's `sandbox.verified` truthfulness arm `live4/C11.out:39` — 7 rows, all `verified=true`, so there is
  no false row to catch reporting wrongly.
- C13c's "the detector itself is what blocked publish" arm `live4/C13.out:89` — the draft was already
  invalid, so the publish gate short-circuits before re-deriving the finding.
- C13f `live4/C13.out:128` — the ops page's resource-limits wording was never rendered in a browser: that
  copy shipped in `09411da`, **after** pass 4's lab commit, and neither C13's API arm (`:127`, PASS) nor
  W7's counter list asserts it. Needs a W7/C13f rerun.
- C14b's advisory-lock handover `live4/C14.out:59` (the log mark is released every tick, so no
  cross-restart acquisition is observable — an unfalsifiable probe now GAPs instead of FAILing) and the
  forced simultaneous two-replica advance `:68` (needs a store seam § 7.1 disclaims). C14c `:69` — the
  flag exists now, but `compose.m4.yml` feeds both replicas from one shell variable, so there is no
  single off-replica to compare against without a `compose up -d` § 7.0 keeps out of the gates; ADR-0023's
  rollback story stays unproven until that pair exists.
- W9's two arms `live4/W9.out:26, :45` — carol cannot be both the M4 maintainer C9d needs and the
  project-B-only outsider, so the seeded `erin` plays the outsider (the row's copy says so), and the run
  the deep link needed had no approval to link.

**No driver leg — W2, W5, W6, W10, W11**

`w1`, `w3`, `w4`, `w7`, `w8` and `w9` are implemented Playwright legs; the remaining five are
`_playwright_stub` placeholders in `e2e/m4/e2e_m4_exit.py`, so they are NOT RUN, not GAPs. W5 (a kill
seen in the browser), W6 (cross-volume loss wording) and W11 (no fencing token in the DOM) have no
scripted substitute either — C5b–C5h, C6e and C8b's arms are themselves blocked above.
