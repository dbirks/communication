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
| pass 6 | `live6/` | `382d42b` | C1, C3, C4, C5, C6, C8, W3, W7 (sequential live pass, fresh reset+seed per gate) |

A fresh lab reset + seed ran before EACH gate of passes 4, 5 and 6 (`_seed-<GATE>.out` is that gate's seed
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
| C1a | run POST returns 201 queued | PASS — the agent arm and the replay twin | pass 6 @ 382d42b | live6/C1.out:24, :113 |
| C1b | designated approver's decide posts 200 | PASS | pass 6 @ 382d42b | live6/C1.out:55, :116 |
| C1c | run reaches terminal `completed` | FAIL — the agent arm ended `failed` (`node_execution_failed:/plan`); both twin arms completed. Under `382d42b`'s ADR-0036 lab profiles the real-Claude `/plan` attempt now fails with **no permission prompt at all** — the journal runs `conversation.message.agent` → `agent.session.disconnected` → `node.attempt.failed` (`:119-123`, same trail at live6/W3.out:50) — under diagnosis, not the old `ask_unattended` mechanism | pass 6 @ 382d42b | live6/C1.out:54 (twins: :56, :117) |
| C1d | full node key set, statuses, execution locations | PASS — 14 keys, exact, control_plane/worker split correct, both twins | pass 6 @ 382d42b | live6/C1.out:72-74, :133-135 |
| C1e | digests, checkpoint count, attempt_count=1 | PASS — 5 run_inputs, digests match the manifest, 8 checkpoints == 8 succeeded worker nodes, `attempt_count = 1` | pass 6 @ 382d42b | live6/C1.out:75-79, :136-140 |
| C1f | artifact bytes readable, redaction_count 0 | PASS — every arm ran and passed on both twins: published exactly once, `redaction_count=0`/`ready`, `GET /artifacts/{id}` + `/content` bytes hash to the row's sha256, `artifact.created` journaled (pass 5's FAIL was `dfff98e`'s 7-field parse of an 8-column psql row — the driver, now fixed) | pass 6 @ 382d42b | live6/C1.out:82-84, :87 (replay arms: :143-148) |
| C1g | run.completed carries result_bindings | PASS — summary non-empty, review_approved true, iterations 2 == ledger, both twins | pass 6 @ 382d42b | live6/C1.out:90-93, :151-154 |
| C1h | journal sequence contiguous for the run | PASS — every arm passes on both twins, the milestone chain included: `dfff98e` matches the chain as an in-order subsequence instead of demanding the fixed first-occurrence order that FAILed at pass 5 | pass 6 @ 382d42b | live6/C1.out:94-102, :110 (replay: :155-171) |
| C1i | replay reproduces the key set and plan_digest | PASS — identical 14-key set, `plan_digest` seed == replay == manifest; the cross-variant comparison still FAILs (`:176`) because its agent leg is C1c's | pass 6 @ 382d42b | live6/C1.out:174-175 (FAIL arm: :176) |
| C2a | secret reaches only the live authorized process | GAP — the gate WAS approved and `/implement` ran (run status `'completed'`), but no attempt was still worker-held when the poll looked, so "exactly one place" was unmeasurable | pass 4 @ 854b2ef | live4/C2.out:63 (approval arm :30) |
| C2b | worker unmounts the env at the node boundary | NOT RUN — blocked behind C2a's GAP | — | live4/C2.out:63 |
| C2c | sentinel absent from every durable surface | GAP — only the encrypted-store arm ran (the value lives in `secret_versions.content_sha256`, no plaintext); the live-surface sweep needs C2a's held attempt | pass 4 @ 854b2ef | live4/C2.out:63 (arm that ran: :26) |
| C2d | reviewer prompt and tool output carry no secret | NOT RUN — blocked behind C2a's GAP | — | live4/C2.out:63 |
| C3a | two workers contend on a deep queue | GAP — both workers online (`:28`), but the C3 leg still does not build the 25-attempt queue: its text waits on a C8 fan-out it never consumes ("C8 prints SKIP", `:29`) even though C8's children are real now (live6/C8.out:48-50); every assertion below is measured over the seed/C1 runs — test setup, rerun pending | pass 6 @ 382d42b | live6/C3.out:29 (children that exist now: live6/C8.out:48-50) |
| C3b | never two live claims of one attempt | PASS — held=1, one distinct worker, on both inspected runs | pass 6 @ 382d42b | live6/C3.out:32-33, :36-37 |
| C3c | one /implement claim, one fencing token drawn | GAP — no `/implement` attempt row carries a worker_id in any inspected run: the twin's steps finish in <1s, so no claim is ever worker-held to count over — test setup, not product; the hold-open fixture is in progress, rerun pending. The `attempt_fencing_seq` arm PASSed | pass 6 @ 382d42b | live6/C3.out:38 (arm that passed: :39) |
| C3d | negative control sentence recorded | NOT RUN — a report line, not an assertion (C4 is the proof) | — | live4/C3.out:44 |
| C4a | a live lease exists to freeze | PASS — `0cbe14b` lets the leg decide its own gate: the run left `waiting_human` via C1b's route and worker-a's lease was frozen through 45s of renewals — a live lease existed to freeze | pass 6 @ 382d42b | live6/C4.out:27, :33 |
| C4b | frozen lease becomes interrupted with a retry | FAIL — the journal carries `node.attempt.completed`, never `node.attempt.interrupted`: the twin's steps finish in <1s, so the fence lands after the attempt already succeeded — test setup, not product; the hold-open fixture is in progress, rerun pending | pass 6 @ 382d42b | live6/C4.out:41-44 |
| C4c | a stale owner cannot publish success | FAIL — the "fenced" attempt read `succeeded` and published outputs, a checkpoint and a `node.attempt.completed` (`:45-49`), the stale owner's refusal never appeared in its own log (`:53`), API and ledger disagreed (`:56-57`), and no replacement attempt with a greater fencing token exists (`:59-60`) — the same <1s race (test setup, rerun pending). Arms that PASSed: zero ready artifacts (`:47`), no lease machinery in the API body (`:58`). One arm GAPs: `finished_at IS NULL` is unrepresentable under 00005's `attempts_terminal_timestamped` CHECK, so § 7.1's literal expectation cannot be met by any terminal row (`:50`) | pass 6 @ 382d42b | live6/C4.out:45-50, :53, :56-60 (PASS arms: :47, :58) |
| C4d | replacement attempt succeeds, run completes | FAIL — the run reached `completed` (`:61`) but no replacement attempt exists — "ownership moved, no process died" (`:62`) — same <1s race, test setup, rerun pending | pass 6 @ 382d42b | live6/C4.out:61-62 |
| C4e | fenced turn appends no transcript rows | GAP — the fenced attempt is `/build_until_verified[1]/review`, a `process.exec` node with `attempts.turn_id` NULL: no ACP turn exists whose transcript timing is measurable (needs an `agent.acp` attempt) | pass 6 @ 382d42b | live6/C4.out:63 |
| C5a | a live attempt exists to SIGKILL | GAP — pass 6 decided the gate (`:27`) and still caught nothing worker-held in 300s (the run ended `completed`, `:61`): the twin's steps finish in <1s, so the kill never finds a live attempt — test setup, not product; the hold-open fixture is in progress, rerun pending. `42187e7`'s race-free SIGSTOP→prove-live→SIGKILL arm has still never executed | pass 6 @ 382d42b | live6/C5.out:27, :61 |
| C5b | kill reads interrupted, never completed | FAIL — pass 6 reproduced the race inside C6's leg: the killed attempt read `succeeded` with no `error_class` (live6/C6.out:51-52) — the kill lands after the attempt's own success write, so the reconciler's `interrupted{lease_expired}` stays unmeasured. Test setup, not product (hold-open fixture in progress); rerun pending | pass 6 @ 382d42b | live6/C6.out:51-52 (pass-4 original: live4/C5.out:41-47) |
| C5c | checkpoints and artifacts survive the kill | PASS — `run_checkpoints` identical before/after the kill, last completed boundary still queryable, ready artifact count unchanged, nothing left `uploading` | pass 4 @ 854b2ef | live4/C5.out:52-55 |
| C5d | same-volume workspace is reclaimed, not rebuilt | PASS — workspace `ready`, `volume_id` byte-identical across the kill (ADR-0017's reclaim rule), no `workspace.recovery_lost` event | pass 4 @ 854b2ef | live4/C5.out:66-68 |
| C5e | retry posts from the last checkpoint | FAIL — pass 6 reran the same race: `POST /runs/{id}/retry` → 409 `a running run is not retriable` (`run_status='running'`) because the killed attempt had already written `succeeded` and the run sailed on — test setup, not product, rerun pending with the hold-open fixture. RC1's halved budget (`0a0e6bb`) is separately proven dead at live6/C1.out:79 | pass 6 @ 382d42b | live6/C6.out:69 (pass-4 original: live4/C5.out:71, :80) |
| C5f | continue_workspace is the observed default | GAP — git HEAD was unreadable across the restart in the retry window (`before='' after=''`), so the not-reset claim is unmeasured | pass 4 @ 854b2ef | live4/C5.out:82 |
| C5g | retry appends, never rewrites history | FAIL — 7 of 8 node keys read `attempts=0` (that killed run's remaining nodes were cancelled/skipped, not attempted), while `/plan` appended exactly 1 attempt and the run reached `completed` after the checkpointed retry; the key-set-vs-C1 identity arm GAPped because C1 crashed in that pass and had no key set to compare | pass 4 @ 854b2ef | live4/C5.out:85-92 (PASS arms: :89, :95; GAP: :96) |
| C5h | exhausted budget fails the run honestly | GAP — every node the worker can be killed mid-way through is authored `maxAttempts: 3`; the lab ships no long-running `maxAttempts: 1` twin node, so the refusal arm has nothing to measure | pass 4 @ 854b2ef | live4/C5.out:99 |
| C6a | revision carrying retry.workspacePolicy | PASS — the restore_checkpoint twin published as its own immutable revision with exactly one policy line changed | pass 6 @ 382d42b | live6/C6.out:27, :28, :37 |
| C6b | restore_checkpoint really resets the worktree | GAP — pass 6 decided the gate (`:42`) and killed, but the kill landed after the node completed (`:51-52`), HEAD/dirty were unreadable across the retry window (`:64`), no `run.checkpoint_restored` row exists, and the driver reports the authored policy did not reach the compiled plan — there is no restore to measure. Test setup (hold-open fixture in progress), rerun pending | pass 6 @ 382d42b | live6/C6.out:74 (kill that landed late: :51-52; gate arm: :42) |
| C6c | restore-mode retry completes the run | FAIL — the run reached `completed` (`:83`), but `run.retried`'s `workspace_policies` named nothing for the `/implement` node (`:84`) and the key-set-vs-C1 identity arm FAILed (`:85`; the CTX comparison GAPped because C1 did not run inside this gate, `:86`) — downstream of the same too-fast twin; test setup, rerun pending | pass 6 @ 382d42b | live6/C6.out:84-85 (PASS arm: :83; GAP arm: :86) |
| C6d | dirty boundary refuses, resets nothing | FAIL — the 409 refusal fired (`:62`), reset nothing (`:64`), journaled no restore (`:65`) and appended no attempt (`:66`), but its problem+json code came back empty instead of `checkpoint_unavailable` (`:63`) and its uncommitted-boundary precondition GAPped (no readable `run_checkpoints.repo_states` rows, `:59`) — the refusal was measured against missing fixture state; test setup, rerun pending | pass 6 @ 382d42b | live6/C6.out:63 (PASS arms: :62, :64-66; GAP: :59) |
| C6e | cross-volume loss says recovery_lost | FAIL — the throwaway worker started on its own named volume (`:94`, `:116`) and the no-auto-retry / never-`resumed` arms PASS (`:113`, `:115`), but the run `completed` with no `workspace.recovery_lost` event, no `error_class` and an empty refusal detail (`:111-112`, `:114`) — the run finished before the loss could bite (same <1s twin race); test setup, rerun pending | pass 6 @ 382d42b | live6/C6.out:111-112, :114 (PASS arms: :113, :115, :116) |
| C7a | until_exhausted ends the run after 3 iterations | PASS — `failed`/`until_exhausted` (P3's cause fix, `94f0ce3`), exactly 3 iterations, 9 terminal body rows, the exhausted loop's descendants cancelled with no route taken; the until scope's own `iterations == 3` row GAPs (:70) | pass 4 @ 854b2ef | live4/C7.out:46-48, :66-69 |
| C7b | per-iteration evidence stays readable | PASS — one row per iteration key, outputs preserved, 3 `node.scope.iteration` with `pass_when_result=false`, evidence attached to both scope and run failures; the "3 distinct `test-*` artifact rows" arm GAPs (no artifact rows for the exhausted run) | pass 4 @ 854b2ef | live4/C7.out:49-58 (GAP arm: :59) |
| C7c | indeterminate predicate is predicate_error | GAP — the schema-declared field is refused at publish (`unknown_field` PASS), so no published document reaches the eval-time `predicate_error` arm; that half is only proven offline (`e2e/m4/test_c7_logic.py`) | pass 4 @ 854b2ef | live4/C7.out:124 (schema arm: :123) |
| C7d | carryForward observed across iterations | PASS — `previous` empty on iteration 1 (probe skipped), non-empty on 2 and 3 (probe succeeded), over a real exhaustion run; the prompt-echo half of the sentence GAPs because the twin is `process.exec` with no transcript | pass 4 @ 854b2ef | live4/C7.out:76 (transcript GAP: :77) |
| C8a | zero-item fan-out succeeds and completes | FAIL — narrowed to one arm: `/fan_out` `succeeded`, `node.scope.completed {items:0}` journaled, the run `completed` (`:11-12, :14`); only `outputs.children` read `'[[]]'` where the check wants the empty array (`:13`) — the driver's children read is fixed in `04f53fd`, after this lab build, rerun pending. `21656f6`'s children are real now | pass 6 @ 382d42b | live6/C8.out:13 (PASS arms: :9, :11-12, :14) |
| C8b | 25 children, one run each, depth 1 | FAIL — the substance all PASSes: 25 invoke keys, 25 `pipeline_invocations` joined to child runs, 24+1 by status, distinct child depth 1 (`:48-50, :53`) — `21656f6` confirmed live. The sole FAIL is the project-inheritance comparison, which got `['true']` where it wanted uuids (`:54`) — driver bug fixed in `04f53fd`, rerun pending | pass 6 @ 382d42b | live6/C8.out:54 (PASS arms: :48-50, :53) |
| C8c | maxConcurrency 3 measured from the journal | GAP — the journal exposes no `seq\|count` commit points for the for_each scope (`:55`); `04f53fd` re-measures invoke concurrency from `node_executions` instead — after this lab build, rerun pending | pass 6 @ 382d42b | live6/C8.out:55 |
| C8d | one failing child, siblings preserved | FAIL — the policy behaviour all PASSes: scope `succeeded` with the failure collected, all 25 children ran, the tree shows 25 distinct children each keyed under `/fan_out` (`:56-57, :62-67`); both FAILs are the `outputs.children` read (1 entry, no `child_run_id`s, `:58-59`) — driver fix `04f53fd`, rerun pending | pass 6 @ 382d42b | live6/C8.out:58-59 (PASS arms: :51-52, :56-57, :62-67) |
| C8e | stop / fail_after_all child policies | GAP — the published § 7.0 revision authors `collect_and_continue` and pipeline revisions are immutable, so a stop/fail_after_all measurement needs a second published parent revision plus its assignment, which the seed contract does not create (`:67`); the verdict algebra over canned rows is proven offline (`e2e/m4/test_c8_logic.py`) | pass 6 @ 382d42b | live6/C8.out:67 |
| C8f | depth guard refuses self-invocation | FAIL — the self-invoke draft died at validate as `invalid_yaml` (`:73`): the driver built the document wrong (fixed in `04f53fd`) and the compiler's `child_depth_exceeded` refusal for self-invoking pipelines only exists since `b977ee4`, after this lab's `382d42b` — both fixes **not yet re-run**; the third-level `runs_depth_check` arms GAPped (POST → None) | pass 6 @ 382d42b | live6/C8.out:73 (GAP arms: :74-76) |
| C8g | parent cancel cascades to every child | PASS — `run.cancel_requested{cascade:true}` names the children, every child reaches `cancelled`, the run ends `cancelled` with `cancelled_attempts[]` populated | pass 6 @ 382d42b | live6/C8.out:86-88 |
| C8h | detach cancel policy is refused at validate | PASS — `cancelPolicy: detach` refused `unsupported_policy` at `/spec/policies/cancelPolicy` | pass 6 @ 382d42b | live6/C8.out:81 |
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
| W2 | live stream renders iterations, not duplicate nodes | NOT RUN — the driver leg exists since `d91f4fc`/`74ea274` (count timeline rows, not string hits) but has never run live on HEAD | — | e2e/m4/e2e_m4_exit.py (w2 leg, not run) |
| W3 | gate card: roles, countdown, approve, bob has no button | GAP — pass 6: the run started (`:24`) but never parked on a pending approval (`status 'failed'` after 420s, `:53`) — its real-Claude `/plan` attempt fails `conversation.message.agent` → `agent.session.disconnected` → `node.attempt.failed` with **no permission prompt** (same mechanism as C1c, under diagnosis), so the card had nothing to render from. Pass 3's PASS stays superseded | pass 6 @ 382d42b | live6/W3.out:53 (run arm: :24; trail: :50) |
| W4 | pinned-digest notice after a mid-run publish | PASS — the run page renders the pinned r1 digest before and after a live r2 publish, does not move onto r2, keeps "pinned r1" (not r2), and the notice "revision 2 published since this run started — this run is pinned to 1" renders. The leg exists since `d1bbcc3`, and the pinned-digest/notice copy it asserts is `3654c18`'s — both are already ancestors of pass 4's `854b2ef`, so neither is an unrun fix. Pass 4's crash was the exit stack not being up at all (`live4/_seed-W4.out:2 SEED FAIL stack not ready`) — an environment failure, not a leg failure; pass 5 is the rerun that measures it | pass 5 @ 42187e7 | live5/W4.out:30, :46-52 (pass-4 crash: live4/W4.out:23) |
| W5 | kill renders honest interrupted wording | NOT RUN — the driver leg exists since `2d58c4b` but has never run live on HEAD; no scripted substitute — C5b–C5h are blocked above | — | e2e/m4/e2e_m4_exit.py (w5 leg, not run) |
| W6 | cross-volume run says "prior edits lost" | NOT RUN — the driver leg exists since `2d58c4b` but has never run live on HEAD; no scripted substitute — C6e is blocked above | — | e2e/m4/e2e_m4_exit.py (w6 leg, not run) |
| W7 | ops page counters and per-worker load | PASS — 30/0/0: every counter, both per-worker load rows and the offline→restored arms render, and the arm that FAILed at pass 4 now PASSes — `queued_unbindable_runs` counts the affinity-bound run (`counter=1`) and the Ops page says 'waiting for its worker' in those words: `5ade2c5`'s fix confirmed live | pass 6 @ 382d42b | live6/W7.out:29-38, :51-52 (rerender arms: :53-62; restored: :71, :80) |
| W8 | validate panel renders located errors by source | PASS — all 7 `kind_not_implemented` rows render at their `/spec/nodes/N/kind` location naming M5/M6, the schema/loader/compiler findings render with source + hint, and the secret-literal finding renders redacted | pass 4 @ 854b2ef | live4/W8.out:40-53, :68-72, :87, :102, :119-120 |
| W9 | cross-project deep links 404 with zero leakage | PASS — outsider session gets 404 + not-found copy on run, `/nodes` and the SSE URL, SSE never opens, and no project name / node name / digest value appears in the DOM, console clean. Two arms GAP: the row names carol but § 7.1 C9d needs carol as an M4 maintainer, so the outsider is the seeded `erin`; and the `/approvals/{id}` deep link had no approval to link to | pass 4 @ 854b2ef | live4/W9.out:35, :43-44, :46-51 (GAPs: :26, :45) |
| W10 | stream continuity across a replica roll | NOT RUN — the driver leg exists since `d91f4fc`/`74ea274` (SSE resumes with `?after=` and dedupes) but has never run live on HEAD; C14a's scripted SSE arm covers the mechanism, not the browser | — | e2e/m4/e2e_m4_exit.py (w10 leg, not run) |
| W11 | child tree renders, internals absent from the DOM | NOT RUN — the driver leg exists since `d91f4fc`/`74ea274` (RunTree renders `/tree` children under run) but has never run live on HEAD; its scripted precondition now exists — C8's tree renders 25 distinct children at live6/C8.out:62-67 | — | e2e/m4/e2e_m4_exit.py (w11 leg, not run) |

Totals: 85 items (74 § 7.1 sub-cases + 11 § 7.2 legs) — PASS 43, FAIL 15, GAP 18, NOT RUN 9.

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

Pass 6 (`382d42b`) promoted six items to PASS — C1f and C1h (driver probes fixed in `dfff98e`), C4a
(`0cbe14b` let the leg decide its own gate, then it froze a real 45s lease), C8g and C8h (`21656f6`'s
children finally exist to cascade and be refused) and W7 (`5ade2c5` confirmed live). Eleven items left
NOT RUN: seven to a FAIL (C4b, C4c, C4d, C6c, C6d, C6e, C8f), two to a GAP (C4e, C8e) and two straight
to PASS (C8g, C8h). C1c's failure mechanism changed: under `382d42b`'s ADR-0036 preapproved lab
profile the agent attempt now dies at `agent.session.disconnected` with no permission prompt at all —
under diagnosis. Every other C4/C5/C6 FAIL and the C3c/C5a GAPs from this pass are one test-setup
race, not product: the twin's steps finish in <1s, so the freeze/kill lands after the attempt already
succeeded; a hold-open fixture input is in progress and those legs need a rerun.

## What blocks the M4 exit

Finding ids (`P*`, `D*`, `RC*`) are `docs/m4-live-findings.md` (written from pass 1); "fixed in
`<sha>`, not re-run" names a commit that landed after the pass behind the verdict.

**Product bugs — open**

- C8 `live6/C8.out:13, :54, :58-59, :73` — `21656f6`'s child runs are confirmed live: 25 invoke rows, 25
  `pipeline_invocations` joined to child runs, depth 1, the tree renders and the cancel cascade works
  (C8g PASSes at `:86-88`). What still FAILs is the driver, not the engine: the `outputs.children`
  reads and the project-id comparison (`:54` got `['true']` where it wanted uuids), all fixed in
  `04f53fd`, and C8f's malformed self-invoke document meeting a compiler `child_depth_exceeded`
  refusal that only exists since `b977ee4` — both fixes landed **after this pass's lab commit
  (`382d42b`); a C8 rerun is pending**. C8c GAPs (no journal commit points; `04f53fd` re-measures from
  `node_executions`) and C8e GAPs (immutable published revision authors only `collect_and_continue`;
  the stop/fail_after_all algebra is offline-only, `e2e/m4/test_c8_logic.py`).
- No longer blocking: **W7 is dead** — `5ade2c5` counts runs whose ready attempt cannot be bound, and
  pass 6 reads `queued_unbindable_runs=1` for the affinity-bound run with the Ops page saying
  'waiting for its worker' in those words (`live6/W7.out:51-52`, W7 PASS 30/0). C12b (`e0ee333` named
  the cap failure) and C12c (`554092a`'s corrected probe) both
  PASS at pass 5 (`live5/C12.out:72`, `:102`); RC1/P1's double `attempt_count` is dead — C1e reads
  `attempt_count = 1` live at `live5/C1.out:85` (`0a0e6bb`), so C5e's retry-from-checkpoint row is
  reachable once C5a gets a live attempt; and P2 (the inert scheduler flag) died in `9af17dc`, already an
  ancestor of pass 4's lab, which is why C14c's GAP changed wording rather than staying a `FAIL`.

**Driver bugs — open (the probes are broken, not the product)**

- ~~C1f~~ and ~~C1h~~ PASS at pass 6 — `dfff98e` fixed the 7-field parse of the 8-column artifact row
  and replaced the fixed-order milestone-chain conjunct with an in-order-subsequence match
  (`live6/C1.out:82-84, :87`; `:94-102, :110`).
- ~~C4a / C5a~~ — `0cbe14b` let C4/C6 decide their own gate and pass 6 proves the sequencing (C4a PASS:
  the run left `waiting_human` and worker-a's lease was frozen through 45s of renewals,
  `live6/C4.out:27, :33`). What remains is speed, not sequencing: the twin's steps finish in <1s, so
  the freeze (`live6/C4.out:41-49`) and the kill (`live6/C5.out:61`, `live6/C6.out:51-52, :69`) land
  after the attempt has already written `succeeded`. All C4b–C4d, the rerun C5b/C5e and the C6c–C6e
  FAILs, and the C3c/C5a GAPs, are that one race — **test setup, not product; a hold-open fixture
  input is in progress and those legs need a rerun**, not a product fix.
- C10b `live4/C10.out:58` — "no `node.execution_skipped{reason:'condition_default'}` may appear" is
  unsatisfiable on the seeded graph, which skips `/emit_items` on `inputs.fanout` by design (`:76`; C9e
  counts the same pair at `live4/C9.out:109`). Unclassified in the findings file.
- Fixed and re-proved, listed so nobody re-files them: C1's and C4's `psql rc=1` crashes
  (`live4/C1.out:75`, `live4/C4.out:29`) were `a2233fd`; C12b's 422 idempotency key (`live4/C12.out:70`)
  and C5's kill race (`live4/C5.out`) were `42187e7`; C8's `NameError: c8_sql` and the C11/C14 probes
  (D2, D3, D4, D6) were `554092a`; C1f's column count and C1h's chain match were `dfff98e`, and the
  C4/C6 gate sequencing was `0cbe14b` — the last two are visible as pass-6 PASSes above.
- W4's pass-4 crash (`live4/W4.out:23`) was the exit stack not being up
  (`live4/_seed-W4.out:2 SEED FAIL stack not ready`), not the leg. `77d46ba`/`0a20a8f` (CI data race,
  lazy-route UI determinism) landed after pass 4 and are not what makes W4 pass — the pass-5 rerun is
  (`live5/W4.out:52`).

**Known design limit — unattended permission prompts (accepted behaviour, not a bug)**

At passes 4–5 five items were blocked by the same mechanism, so they are grouped rather than counted
as product bugs (C1c and W3 moved to a new failure mode at pass 6, below):
under `permission_mode: ask`, a run attempt's prompt is journalled
`conversation.permission.requested` → `conversation.permission.decided{status:'cancelled',
decided_by:'node_policy:ask_unattended'}`, the agent's tool call gets the ACP cancelled outcome, and
`execute` fails. C1's agent run shows the trail three times, one per attempt (`live5/C1.out:55-60`, the
titles are the agent's own `find …`/`cat hello.py` calls), and the run ends
`node_execution_failed:/plan` (`live5/C1.out:27`).

- C1c `live6/C1.out:54` and the cross-variant key set `live6/C1.out:176` — the agent leg still cannot
  reach terminal `completed`, but since `382d42b` flipped the lab's agent profiles to
  `preapproved_within_sandbox` (ADR-0036) it no longer dies on the prompt: the real-Claude `/plan`
  attempt fails `conversation.message.agent` → `agent.session.disconnected` → `node.attempt.failed`
  with **no permission prompt** (`:119-123`) — under diagnosis. The `ask_unattended` trail below
  predates that flip and stands for C9g/C11.
- W3 `live6/W3.out:53` — the gate card leg still cannot park a run: the same `session disconnected`
  failure after 420s (`:50`), so nothing rendered — under diagnosis.
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
- C5a `live6/C5.out:61`, C6b `live6/C6.out:74` — the fault-injection legs now decide their own gate
  (`0cbe14b`; C4a PASSes with a real 45s frozen lease at `live6/C4.out:27, :33`), but the twin's steps
  finish in <1s so there is still nothing worker-held to kill or restore from. These remain the
  milestone's exit sentence: the hold-open fixture input that keeps a node long enough to freeze or
  kill is in progress; rerun pending.
- C3a `live6/C3.out:29` — C8's queue exists now (`21656f6` confirmed live: 25 invoke rows at
  `live6/C8.out:48-50`), but the C3 leg still does not consume it ("C8 prints SKIP" in its own text);
  C3c `live6/C3.out:38` — no `/implement` attempt row carries a worker_id (the <1s twin race). Both
  are test setup, rerun pending.
- C5f `live4/C5.out:82` (git HEAD unreadable across the restart) and C5h `live4/C5.out:99` (no
  long-running `maxAttempts: 1` twin node exists to exhaust) stay pass-4 GAPs — C5 has not got past
  C5a since. C4b–C4e and C6c–C6e now carry live6 verdicts (FAIL/GAP) from the same fixture-speed
  race, and C8e/C8f are rows above, no longer downstream of a crash.
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

**Driver legs exist, not yet run live — W2, W5, W6, W10, W11**

`w1`, `w3`, `w4`, `w7`, `w8` and `w9` are implemented Playwright legs that have run. The remaining five
now have implemented legs too — W2/W10/W11 since `d91f4fc`/`74ea274` (timeline-row counting, shared
mid-lease probe, `/tree` children under run, SSE resume with `?after=`) and W5/W6 since `2d58c4b` —
but none of them has run live on HEAD, so they are NOT RUN, not GAPs. W5 (a kill seen in the browser)
and W6 (cross-volume loss wording) still have no scripted substitute either — C5b–C5h and C6e's arms
are themselves blocked on the hold-open fixture above. W11's scripted precondition now exists: C8's
tree renders 25 distinct children at `live6/C8.out:62-67`.
