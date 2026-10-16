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
| pass 7 | `live7/` | `04f53fd` | C8 (rerun on a build that finally contains the `04f53fd` driver fixes) |
| pass 8 | `live8/` | `522a82b` | C1, C4, C5, C6, W2, W5, W6 (first pass with the `hold_seconds` hold-open fixture) |
| pass 9 | `live9/` | `1e75c23` | C1, C4, C5, C6, W2, W3, W5, W6 (first pass on a build containing `4b4bfb8`/`35a9acf`/`13b81fb`/`1e75c23`; the fixture regenerated so `hold_seconds` really holds) |

A fresh lab reset + seed ran before EACH gate of passes 4–9 (`_seed-<GATE>.out` is that gate's seed
manifest and `_build.out` the lab commit it was built from), so no pass-4/5/6/7/8/9 verdict inherits another
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
| C1a | run POST returns 201 queued | PASS — the agent arm and both twins | pass 9 @ 1e75c23 | live9/C1.out:24, :26, :129, :131 |
| C1b | designated approver's decide posts 200 | PASS — all three legs | pass 9 @ 1e75c23 | live9/C1.out:27, :71, :132 (also `live9/C4.out:63`) |
| C1c | run reaches terminal `completed` | FAIL — the agent arm ends `failed` `node_execution_failed:/build_until_verified` (`:70`); both twin arms completed (`:72, :133`). **`4b4bfb8` + `35a9acf` killed the old mechanism and the run got far further this time**: `/plan` `succeeded` (`:50`), `/approve` `succeeded` (`:37`), then three real iterations — `[1]` and `[2]` implement/review/test all `succeeded` (`:39-44`) — and the death is **`/build_until_verified[3]/review` at attempt 2** (`:46`), with `[3]/implement` and `[3]/test` `succeeded` around it (`:45, :47`) and `/verdict` + both publishes cancelled (`:51-53`). The attempt's own trail is `conversation.message.agent` → `agent.session.disconnected` → `sandbox.egress_observed` → `node.attempt.failed` (seqs 276/277/278/280, `:62-65`) and the ADR-0016 permission trail printed nothing (`:69`) — **the cause is still under capture, not diagnosed in this pass** | pass 9 @ 1e75c23 | live9/C1.out:70 (tree: :46; trail: :62-65; twins: :72, :133) |
| C1d | full node key set, statuses, execution locations | PASS — on both twins: 14 keys exact (`ledger_only=[] expected_only=[]`), every node terminal at its expected status, `/approve`,`/verdict` control_plane vs loop bodies worker (ADR-0023 § 3), no unexpected node kinds with the loop spending 2 iterations. The agent leg's own key-set probe never ran — it died at C1c and only its ledger tree is printed (`:36-53`) | pass 9 @ 1e75c23 | live9/C1.out:88-90, :128 (replay: :149-151, :189; agent tree printed: :36-53) |
| C1e | digests, checkpoint count, attempt_count=1 | PASS — **promoted this pass**: the input-count arm now counts what the pinned revision DECLARES (`1e75c23`), so `count=6 declared=6` with `hold_seconds=default` named among the origins instead of being scored as an extra row (`:91, :152`) — pass 8's FAIL was a stale driver expectation. All substantive arms PASS on both twins: digests match the manifest verbatim (`:92, :153`), API agrees with the ledger (`:93, :154`), 8 checkpoints == 8 succeeded worker nodes (`:94, :155`), `attempt_count = 1` (`:95, :156` — RC1's double-count proven dead again) | pass 9 @ 1e75c23 | live9/C1.out:91-95 (replay: :152-156) |
| C1f | artifact bytes readable, redaction_count 0 | PASS — every arm ran and passed on both twins: published exactly once, `redaction_count=0`/`ready`, `GET /artifacts/{id}` + `/content` bytes hash to the row's sha256, `artifact.created` journaled | pass 9 @ 1e75c23 | live9/C1.out:98-100, :103 (replay arms: :159-161, :164) |
| C1g | run.completed carries result_bindings | PASS — summary non-empty, review_approved true, iterations 2 == ledger, both twins | pass 9 @ 1e75c23 | live9/C1.out:106-109, :167-170 |
| C1h | journal sequence contiguous for the run | PASS — every arm passes on both twins, the milestone chain included (in-order subsequence match, `dfff98e`): 46 rows, `run.created` first / `run.completed` last, run slice strictly ascending, attempt rows carry `node_execution_id` + `attempt_id`, gate rows carry NULL `attempt_id`, 8 `run.checkpoint_saved` == 8 worker nodes, and the SSE stream saw the opening and closing frames | pass 9 @ 1e75c23 | live9/C1.out:110-118, :126-127 (replay: :171-179, :187-188) |
| C1i | replay reproduces the key set and plan_digest | PASS — identical 14-key set (`seed_only=[] replay_only=[]`), `plan_digest` seed == replay == manifest; the cross-variant comparison still FAILs (`:192` "a leg failed") because its agent leg is C1c's | pass 9 @ 1e75c23 | live9/C1.out:190-191 (FAIL arm: :192) |
| C2a | secret reaches only the live authorized process | GAP — the gate WAS approved and `/implement` ran (run status `'completed'`), but no attempt was still worker-held when the poll looked, so "exactly one place" was unmeasurable | pass 4 @ 854b2ef | live4/C2.out:63 (approval arm :30) |
| C2b | worker unmounts the env at the node boundary | NOT RUN — blocked behind C2a's GAP | — | live4/C2.out:63 |
| C2c | sentinel absent from every durable surface | GAP — only the encrypted-store arm ran (the value lives in `secret_versions.content_sha256`, no plaintext); the live-surface sweep needs C2a's held attempt | pass 4 @ 854b2ef | live4/C2.out:63 (arm that ran: :26) |
| C2d | reviewer prompt and tool output carry no secret | NOT RUN — blocked behind C2a's GAP | — | live4/C2.out:63 |
| C3a | two workers contend on a deep queue | GAP — both workers online (`:28`), but the C3 leg still does not build the 25-attempt queue: its text waits on a C8 fan-out it never consumes ("C8 prints SKIP", `:29`) even though C8's children are real now (live6/C8.out:48-50); every assertion below is measured over the seed/C1 runs — test setup, rerun pending | pass 6 @ 382d42b | live6/C3.out:29 (children that exist now: live6/C8.out:48-50) |
| C3b | never two live claims of one attempt | PASS — held=1, one distinct worker, on both inspected runs | pass 6 @ 382d42b | live6/C3.out:32-33, :36-37 |
| C3c | one /implement claim, one fencing token drawn | GAP — no `/implement` attempt row carries a worker_id in any inspected run: the twin's steps finish in <1s, so no claim is ever worker-held to count over — test setup, not product; the hold-open input now exists (`cefe995`, driven by `522a82b`, proven on C4's lease at `live8/C4.out:41-44`) but C3 did not rerun with it, rerun pending. The `attempt_fencing_seq` arm PASSed | pass 6 @ 382d42b | live6/C3.out:38 (arm that passed: :39) |
| C3d | negative control sentence recorded | NOT RUN — a report line, not an assertion (C4 is the proof) | — | live4/C3.out:44 |
| C4a | a live lease exists to freeze | PASS — `1e75c23` proves the fixture honours `hold_seconds` before faulting: the leg decided its own gate, the live claim landed on **worker-b** so worker-b (not worker-a) was paused for 45s of frozen renewals and unpaused — and the report says so (`:27-30`) — with the fenced attempt still held when it woke (`:36-38`) | pass 9 @ 1e75c23 | live9/C4.out:34 (gate arms: :24, :26; which-container note: :27-30) |
| C4b | frozen lease becomes interrupted with a retry | PASS — on the re-frozen lease: `node.attempt.interrupted` with `reason=lease_expired` and `actor_kind=system`, followed by `node.attempt.retry_scheduled`, in the fenced attempt's own journal slice | pass 9 @ 1e75c23 | live9/C4.out:43-46 (journal slice: :40-42) |
| C4c | a stale owner cannot publish success | FAIL — thirteen arms PASS on the real fence: the fenced attempt reads `interrupted` with NULL outputs, zero ready artifacts, zero `run_checkpoints`, zero `node.attempt.completed` (`:47-51`), API and ledger agree (`interrupted` in both, `error_class` matching, `:58-59`), no lease machinery in the API body (`:60`), and a replacement attempt exists with a strictly greater fencing token (`:61-62`). The one FAIL is the observation arm (matched 0 lines, `:55`) and **this pass it is a DRIVER bug, not the worker**: the leg greps `docker logs communication-m4-worker-a`, which is compose's PREFIX — the container is `communication-m4-worker-a-1`, so `docker logs` reads nothing (`e2e/m4/e2e_m4_exit.py:92-93`), even though `ef33f8d` (an ancestor of `1e75c23`) makes the worker log the refusal once per attempt. **Container-name driver fix in progress** (guarded offline by `e2e/m4/test_container_names_logic.py`). One arm GAPs: `finished_at IS NULL` is unrepresentable under 00005's `attempts_terminal_timestamped` CHECK, so § 7.1's literal expectation cannot be met by any terminal row (`:52`) | pass 9 @ 1e75c23 | live9/C4.out:55 (PASS arms: :47-51, :58-62; GAP: :52) |
| C4d | replacement attempt succeeds, run completes | PASS — "the retry (attempt N+1) succeeded and the run completed — ownership moved, no process died" (`:65`), the run `completed` (`:64`) | pass 9 @ 1e75c23 | live9/C4.out:64-65 |
| C4e | fenced turn appends no transcript rows | GAP — unchanged in kind: the fenced attempt is `/plan` with `attempts.turn_id` NULL — a `process.exec` node owns no ACP turn, so `conversation.turn.interrupted` and the transcript-timing arm are unmeasurable on it (needs an `agent.acp` attempt — C6/C7's territory) | pass 9 @ 1e75c23 | live9/C4.out:66 |
| C5a | a live attempt exists to SIGKILL | PASS (the arm that ran) — pass 9 released the run from the gate (`:27`) and the pick is finally on the node § 7.1 names: attempt 1 of `/build_until_verified[1]/implement` leased to **worker-a at token=4** (`:29`), with the `/plan` checkpoint boundary captured BEFORE the fault (`:31`). What is not proven is that it stayed held: the SIGSTOP freeze GAPs below on the container-name driver bug (`:34`), so pass 8's "nothing worker-held in 300s" (`live8/C5.out:61`) is dead, but `42187e7`'s race-free SIGSTOP→prove-live→SIGKILL arm has still never executed | pass 9 @ 1e75c23 | live9/C5.out:27, :29 (boundary: :31; freeze GAP: :34) |
| C5b | kill reads interrupted, never completed | PASS where the kill really landed — C6's leg killed the owning worker with `compose kill worker-a`, which does reach the container (`Container communication-m4-worker-a-1 Killed`, live9/C6.out:46-47), and the killed attempt reads `interrupted`, the write coming from the reconciler and never the dead process (`:49`), with `error_class='interrupted'` (§ 7.1's literal ask, `:50`) and the recorded checkpoint boundary identical before/after (`:52`). In C5's own leg the same sub-case still GAPs because there the freeze never happened (`live9/C5.out:34, :36` — the same container-name driver bug) | pass 9 @ 1e75c23 | live9/C6.out:49-50 (kill: :46-47; boundary: :52; C5's own GAP: live9/C5.out:34, :36) |
| C5c | checkpoints and artifacts survive the kill | PASS — `run_checkpoints` identical before/after the kill, last completed boundary still queryable, ready artifact count unchanged, nothing left `uploading` | pass 4 @ 854b2ef | live4/C5.out:52-55 |
| C5d | same-volume workspace is reclaimed, not rebuilt | PASS — workspace `ready`, `volume_id` byte-identical across the kill (ADR-0017's reclaim rule), no `workspace.recovery_lost` event | pass 4 @ 854b2ef | live4/C5.out:66-68 |
| C5e | retry posts from the last checkpoint | FAIL — the retry never gets its 200: `POST /runs/{id}/retry` reads **409** `{"detail":"a running run is not retriable…","run_status":"running"}` (`live9/C6.out:67`) — the killed attempt's replacement (attempt 2 with `retry_scheduled='1'`, `:111`) had already moved the run back to `running` before the leg POSTed, so the leg is racing the reconciler rather than the API. Pass 8's **500** is gone: `13b81fb` (ADR-0037) makes a retry naming a node execution the run lacks answer **404** `node-execution-not-found`. The remaining blocker is driver sequencing — **driver fix in progress**. RC1's halved budget (`0a0e6bb`) is separately proven dead again at live9/C1.out:95 | pass 9 @ 1e75c23 | live9/C6.out:67 (replacement already scheduled: :111; pass-4 original: live4/C5.out:71, :80) |
| C5f | continue_workspace is the observed default | GAP — git HEAD was unreadable across the restart in the retry window (`before='' after=''`), so the not-reset claim is unmeasured | pass 4 @ 854b2ef | live4/C5.out:82 |
| C5g | retry appends, never rewrites history | FAIL — 7 of 8 node keys read `attempts=0` (that killed run's remaining nodes were cancelled/skipped, not attempted), while `/plan` appended exactly 1 attempt and the run reached `completed` after the checkpointed retry; the key-set-vs-C1 identity arm GAPped because C1 crashed in that pass and had no key set to compare | pass 4 @ 854b2ef | live4/C5.out:85-92 (PASS arms: :89, :95; GAP: :96) |
| C5h | exhausted budget fails the run honestly | GAP — every node the worker can be killed mid-way through is authored `maxAttempts: 3`; the lab ships no long-running `maxAttempts: 1` twin node, so the refusal arm has nothing to measure | pass 4 @ 854b2ef | live4/C5.out:99 |
| C6a | revision carrying retry.workspacePolicy | PASS — the restore_checkpoint twin published as its own immutable revision with exactly one policy line changed (8853 bytes), the seed's revision untouched | pass 9 @ 1e75c23 | live9/C6.out:27, :28, :37 |
| C6b | restore_checkpoint really resets the worktree | GAP — pass 9's kill finally landed on the right node (`940e09e6… attempt=1 worker=worker-a node=/build_until_verified[1]/implement`, `:43`), but there was still no restore to measure: the compiled plan the validate returned carries no `restore_checkpoint` string at all (`:38-39`), so the arm GAPs by design (`:72`), the retry 409'd before any restore could post (`:67`, C5e), no `run.checkpoint_restored` row exists (`:68-69`) and HEAD/dirty were unreadable across both the kill and the retry windows (`:55-56, :70-71`) | pass 9 @ 1e75c23 | live9/C6.out:72 (kill on the right node: :43; plan note: :38-39; restored row: :68-69) |
| C6c | restore-mode retry completes the run | FAIL — the run reached `completed` (`:81`), but `run.retried`'s `workspace_policies` named nothing for `/build_until_verified[1]/implement` (`:82`, `{}`) and the key-set-vs-C1 identity arm FAILed (`:83`, `only_c1` = the four pre-fan-out keys, `only_c6=[]`) — both downstream of the retry never posting (`:67`, C5e's race); the CTX comparison GAPped because C1 did not run inside this gate (`:84`). Driver sequencing fix in progress, rerun pending | pass 9 @ 1e75c23 | live9/C6.out:82-83 (PASS arm: :81; GAP arm: :84) |
| C6d | dirty boundary refuses, resets nothing | FAIL — the refusal is 409 again (`:60`) instead of pass 8's 500, but it is the WRONG 409: `run-not-retriable` ("a running run is not retriable", `run_status='running'`, `:59`) where § 7.1 wants `checkpoint_unavailable`, so the problem+json `code` came back empty (`:61`) and "the refusal appended no new attempt" FAILed with attempts=2 (`:64`) — the leg measured a run that the reconciler had already restarted, not a checkpoint refusal. The arms on the refusal path PASS (nothing reset `:62`, zero `run.checkpoint_restored` `:63`), and the uncommitted-boundary precondition still GAPs (no readable `run_checkpoints.repo_states` rows, `:57`) | pass 9 @ 1e75c23 | live9/C6.out:61, :64 (PASS arms: :60, :62-63; GAP: :57) |
| C6e | cross-volume loss says recovery_lost | FAIL — the throwaway worker started on its own named volume (`:92`, `:114`) and the never-`resumed` arm PASSes (`:113`), but the loss never bit: the run had already reached `completed` (`:81`, `:86`) so the cross-volume retry read 409 "a completed run is not retriable" (`:99-100`), there is no `workspace.recovery_lost` event (`:109`), the run carries `error_class='interrupted'` not `workspace_lost` (`:110`), a later attempt 2 with `retry_scheduled='1'` exists where § 7.1 wants no auto-retry (`:111`) and the operator refusal detail is empty (`:112`). The leg's own `recovery_lost` read also crashed — `psql rc=1: operator does not exist: uuid = text` (`:101-105`) — a driver read bug on top of the sequencing one | pass 9 @ 1e75c23 | live9/C6.out:109-112 (PASS arms: :113, :114; retry read: :99-100; psql crash: :101-105) |
| C7a | until_exhausted ends the run after 3 iterations | PASS — `failed`/`until_exhausted` (P3's cause fix, `94f0ce3`), exactly 3 iterations, 9 terminal body rows, the exhausted loop's descendants cancelled with no route taken; the until scope's own `iterations == 3` row GAPs (:70) | pass 4 @ 854b2ef | live4/C7.out:46-48, :66-69 |
| C7b | per-iteration evidence stays readable | PASS — one row per iteration key, outputs preserved, 3 `node.scope.iteration` with `pass_when_result=false`, evidence attached to both scope and run failures; the "3 distinct `test-*` artifact rows" arm GAPs (no artifact rows for the exhausted run) | pass 4 @ 854b2ef | live4/C7.out:49-58 (GAP arm: :59) |
| C7c | indeterminate predicate is predicate_error | GAP — the schema-declared field is refused at publish (`unknown_field` PASS), so no published document reaches the eval-time `predicate_error` arm; that half is only proven offline (`e2e/m4/test_c7_logic.py`) | pass 4 @ 854b2ef | live4/C7.out:124 (schema arm: :123) |
| C7d | carryForward observed across iterations | PASS — `previous` empty on iteration 1 (probe skipped), non-empty on 2 and 3 (probe succeeded), over a real exhaustion run; the prompt-echo half of the sentence GAPs because the twin is `process.exec` with no transcript | pass 4 @ 854b2ef | live4/C7.out:76 (transcript GAP: :77) |
| C8a | zero-item fan-out succeeds and completes | PASS — every arm PASSes on a build that contains `04f53fd`: `/fan_out` with 0 items `succeeded`, `node.scope.completed {scope:'/fan_out', items:0}` journaled, `outputs.children` reads the EMPTY array `[]` (pass 6's `'[[]]'` was the driver's read, fixed in `04f53fd`), the run `completed` | pass 7 @ 04f53fd | live7/C8.out:11-14 (POST arm: :9) |
| C8b | 25 children, one run each, depth 1 | PASS — 25 invoke keys, 25 `pipeline_invocations` joined to child runs, 25 terminal rows split 24 succeeded + 1 failed, distinct child depth 1, and the project-inheritance comparison now matches (`:54` observed `['t']` — pass 6's uuid mismatch was the driver's read, fixed in `04f53fd`) | pass 7 @ 04f53fd | live7/C8.out:48-50, :53, :54 |
| C8c | maxConcurrency 3 measured | PASS — `04f53fd` re-measures invoke concurrency over `node_executions` commit points instead of the journal: peak=3 at seqs [1, 3, 26], the sample really saw parallelism (>1 in flight), over 3 sampled commit points | pass 7 @ 04f53fd | live7/C8.out:55-57 |
| C8d | one failing child, siblings preserved | PASS — exactly 1 failed child of 25 with 24 non-failed preserved, `collect_and_continue` scope `succeeded` with the failure collected, all 25 children ran, `outputs.children` carries 25 entries each naming its own `child_run_id`, and `/tree` shows 25 distinct children keyed under `/fan_out` at depth 1 with the parent as root | pass 7 @ 04f53fd | live7/C8.out:51-52, :58-61, :64-68 |
| C8e | stop / fail_after_all child policies | GAP — unchanged in kind: the published § 7.0 revision authors `collect_and_continue` on `/fan_out` and pipeline revisions are immutable, so a stop/fail_after_all measurement needs a second published parent revision plus its assignment, which the seed contract does not create (`:69`); the verdict algebra over canned rows is proven offline (`e2e/m4/test_c8_logic.py`) | pass 7 @ 04f53fd | live7/C8.out:69 |
| C8f | depth guard refuses self-invocation | PASS — the self-invoking pipeline is refused at validate with `child_depth_exceeded` (`:75`): `04f53fd`'s corrected document meeting `b977ee4`'s compiler guard, both confirmed live (pass 6's `invalid_yaml` was the driver's malformed document). One arm GAPs: the third-level `runs_depth_check` refusal (a 2-level chain is the ceiling) POSTed → None (`:76`) | pass 7 @ 04f53fd | live7/C8.out:75 (GAP arm: :76) |
| C8g | parent cancel cascades to every child | PASS — `run.cancel_requested{cascade:true}` journaled, every child reached a terminal state, the run ends `cancelled` with `cancelled_attempts[]` populated | pass 7 @ 04f53fd | live7/C8.out:86-88 |
| C8h | detach cancel policy is refused at validate | PASS — `cancelPolicy: detach` refused `unsupported_policy` at `/spec/policies/cancelPolicy` | pass 7 @ 04f53fd | live7/C8.out:81 |
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
| W2 | live stream renders iterations, not duplicate nodes | PASS — **promoted** (`1e75c23` holds the twin open 10s for this leg): 17 PASS / 0 FAIL / 2 GAP, and its **core mid-lease arm now PASSes** — the poll caught attempt `d207d20c…` of `/build_until_verified[1]/implement` leased to worker-a (`:31`), so the page watched real in-flight work: journal panel rendered (`:29`), 7 samples of one document with no reload (`:46`), `run.created` → `node.attempt.started` → `run.checkpoint_saved` drawn in journal order (`:47-51`), all 38 journalled run-vocabulary rows drawn at least once and never more often than written (`:53-54`), and both `/build_until_verified[1]` and `[2]` under ONE stage cell for the loop (`:57-61`). The two remaining GAPs are both `conversation.turn.*` on a `process.exec` twin that owns no ACP turn (`:49, :52`) — that arm additionally sits outside `M4_RUN_EVENT_TYPES`, so the Timeline tab drops it (`RunInspector.tsx:720`) | pass 9 @ 1e75c23 | live9/W2.out:31 (rendering arms: :29, :46-54, :57-61; turn GAPs: :49, :52) |
| W3 | gate card: roles, countdown, approve, bob has no button | PASS — **21 PASS / 0 FAIL / 0 GAP** (`:55`), the whole card rendered off a real Claude plan for the first time: the run parked on a pending approval (`:26`) with roles + deadline exposed (`:27`), the control-plane card mounts with no attempt (`:37`), bob sees `approver_roles='maintainer'`, the countdown, the evidence list, NO Approve button and the not-a-designated-approver copy (`:31-35`), alice's Approve click posts `/approvals/{id}/decide` (`:48`) and the card then reads decided (`:49-52`). The `4b4bfb8` schema fix plus `35a9acf`'s plan-card rendering are what unblocked it — pass 6's GAP and pass 3's PASS are both superseded | pass 9 @ 1e75c23 | live9/W3.out:26-27, :31-35, :37, :38-42, :48-52 (summary: :55) |
| W4 | pinned-digest notice after a mid-run publish | PASS — the run page renders the pinned r1 digest before and after a live r2 publish, does not move onto r2, keeps "pinned r1" (not r2), and the notice "revision 2 published since this run started — this run is pinned to 1" renders. The leg exists since `d1bbcc3`, and the pinned-digest/notice copy it asserts is `3654c18`'s — both are already ancestors of pass 4's `854b2ef`, so neither is an unrun fix. Pass 4's crash was the exit stack not being up at all (`live4/_seed-W4.out:2 SEED FAIL stack not ready`) — an environment failure, not a leg failure; pass 5 is the rerun that measures it | pass 5 @ 42187e7 | live5/W4.out:30, :46-52 (pass-4 crash: live4/W4.out:23) |
| W5 | kill renders honest interrupted wording | GAP — ran again on pass 9 with the same four arms PASSing (run started `:24`, alice signed in `:26`, the run page open BEFORE the kill with status `running` `:27`, gate decided `:30`), but the kill is blocked by a newly named **driver bug**: the live claim belongs to worker row `worker-a`, whose container the leg reads as `communication-m4-worker-a` — a compose PREFIX, not a container (`…-worker-a-1` is) — so per § 7.0 it refuses to kill anything (`:31`). Interrupted wording, countdown and attempt 2 stay unmeasured; **container-name driver fix in progress**, rerun pending | pass 9 @ 1e75c23 | live9/W5.out:31 (arms that ran: :24, :26-27, :30) |
| W6 | cross-volume run says "prior edits lost" | GAP — same container-name driver bug on pass 9: the run started (`:26`) and the gate was decided (`:28`), but nothing was killed because the owning worker's container could not be resolved to this compose project (`:29`), so no workspace was ever left behind (`:30`) and there is no provable mid-node death at `/build_until_verified[1]/implement` (`:31`); the throwaway worker-c was created and removed cleanly (`:32-33`). **Driver fix in progress**, rerun pending. Still no scripted substitute — C6e is blocked above | pass 9 @ 1e75c23 | live9/W6.out:29-31 (run/gate arms: :26, :28) |
| W7 | ops page counters and per-worker load | PASS — 30/0/0: every counter, both per-worker load rows and the offline→restored arms render, and the arm that FAILed at pass 4 now PASSes — `queued_unbindable_runs` counts the affinity-bound run (`counter=1`) and the Ops page says 'waiting for its worker' in those words: `5ade2c5`'s fix confirmed live | pass 6 @ 382d42b | live6/W7.out:29-38, :51-52 (rerender arms: :53-62; restored: :71, :80) |
| W8 | validate panel renders located errors by source | PASS — all 7 `kind_not_implemented` rows render at their `/spec/nodes/N/kind` location naming M5/M6, the schema/loader/compiler findings render with source + hint, and the secret-literal finding renders redacted | pass 4 @ 854b2ef | live4/W8.out:40-53, :68-72, :87, :102, :119-120 |
| W9 | cross-project deep links 404 with zero leakage | PASS — outsider session gets 404 + not-found copy on run, `/nodes` and the SSE URL, SSE never opens, and no project name / node name / digest value appears in the DOM, console clean. Two arms GAP: the row names carol but § 7.1 C9d needs carol as an M4 maintainer, so the outsider is the seeded `erin`; and the `/approvals/{id}` deep link had no approval to link to | pass 4 @ 854b2ef | live4/W9.out:35, :43-44, :46-51 (GAPs: :26, :45) |
| W10 | stream continuity across a replica roll | NOT RUN — the driver leg exists since `d91f4fc`/`74ea274` (SSE resumes with `?after=` and dedupes) but has never run live on HEAD; C14a's scripted SSE arm covers the mechanism, not the browser | — | e2e/m4/e2e_m4_exit.py (w10 leg, not run) |
| W11 | child tree renders, internals absent from the DOM | NOT RUN — the driver leg exists since `d91f4fc`/`74ea274` (RunTree renders `/tree` children under run) but has never run live on HEAD; its scripted precondition now exists — C8's tree renders 25 distinct children at live7/C8.out:64-68 | — | e2e/m4/e2e_m4_exit.py (w11 leg, not run) |

Totals: 85 items (74 § 7.1 sub-cases + 11 § 7.2 legs) — **PASS 54, FAIL 8, GAP 17, NOT RUN 6** (counted mechanically over the Verdict column above: 54 + 8 + 17 + 6 = 85).

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

Pass 7 (`04f53fd`) was the C8 rerun on a build that finally contains that commit's driver fixes, and it
came back **31 PASS / 0 FAIL / 2 GAP** for the whole gate. Five items moved to PASS: C8a
(`outputs.children` reads `[]`, `live7/C8.out:13`), C8b (the project-inheritance comparison matches,
`:54`), C8c (`maxConcurrency` measured over `node_executions` commit points, peak=3, `:55-57`), C8d
(25 `child_run_id`s and 25 distinct `/tree` children, `:60-68`) and C8f (`child_depth_exceeded` for
the self-invoking pipeline, `:75` — `b977ee4`'s compiler guard confirmed live). C8e still GAPs (the
immutable published revision authors only `collect_and_continue`, `:69`) and C8f's third-level
`runs_depth_check` arm GAPs (`:76`). Nothing in the gate FAILs.

Pass 8 (`522a82b`) is the first pass with the hold-open fixture (`cefe995`'s `hold_seconds` input,
`522a82b` running C4/C5/C6/W5/W6 with `hold_seconds=45`). It promoted C4b and C4d to PASS — the frozen
lease really did become `node.attempt.interrupted{lease_expired}` + `node.attempt.retry_scheduled`
(`live8/C4.out:41-44`) and the replacement attempt succeeded with "ownership moved, no process died"
(`:63`) — and C4c is down to one FAIL (the stale owner's refusal log line, `:53`, fixed in `ef33f8d`,
rerun pending) with twelve PASS arms. Two items moved backwards or newly measured badly: **C1e PASS →
FAIL** because the fixture's new `hold_seconds` default input makes `run_inputs` 6 rows where the probe
wants 5 (`live8/C1.out:75` — driver expectation stale), and C5e/C6d's retry now reads **500** instead
of 409 (`live8/C6.out:61, :66`) — a product bug with a fix in progress, not the pass-6 twin race. C5a
and C6b stay GAPs and C5b/C6c/C6e stay FAILs for a new reason: the driver's kill/mid-node pick landed
on `/plan`, pre-gate, where § 7.1 names `/build_until_verified[1]/implement` (`live8/C6.out:42-43`) —
targeting fix queued. C1c's long-standing mystery was root-caused in this pass (`invalid_output`: an
object reply vs a declared `plan: string`) and fixed in `4b4bfb8`, rerun pending. W2, W5 and W6 ran
live for the first time: W2's rendering arms all PASS but its mid-lease core arm GAPs
(`live8/W2.out:31`), and W5/W6 GAP for the same mis-picked kill (`live8/W5.out:31-32`,
`live8/W6.out:29-30`). W10/W11 have still never run.

Pass 9 (`1e75c23`) is the first pass on a build containing `4b4bfb8` (declare `/plan`'s output as the
object Claude returns), `35a9acf` (the plan card renders the objective + summary), `13b81fb` (a retry
naming a node execution the run lacks answers **404** `node-execution-not-found`, ADR-0037) and
`1e75c23` (fault legs aim at a held POST-GATE attempt, prove `hold_seconds` before faulting, W2 holds
10s, C1e counts declared inputs), on a regenerated fixture so the hold actually applies. It promoted
five items: **W3 GAP → PASS**, 21 PASS / 0 FAIL / 0 GAP (`live9/W3.out:55`) — the card renders a
real-Claude plan end to end, bob has no Approve button, alice's click decides (`:26-52`); **W2 GAP →
PASS** — its mid-lease core arm caught `/build_until_verified[1]/implement` leased to worker-a
(`live9/W2.out:31`); **C1e FAIL → PASS** — the input arm counts declared inputs (`live9/C1.out:91,
:152`); **C5a GAP → PASS (arm that ran)** — the pick is finally the node § 7.1 names (`live9/C5.out:29`);
and **C5b FAIL → PASS** on the leg whose kill really reached the container (`live9/C6.out:46-50`).
C1c is still FAIL and the failure moved again: the agent arm plans, is approved and runs three
iterations, dying at `/build_until_verified[3]/review` attempt 2 (`live9/C1.out:46`) with the run
`failed node_execution_failed:/build_until_verified` (`:70`) — **cause under capture, not diagnosed in
this pass**. What still FAILs or GAPs in C4/C5/C6/W5/W6 is now two named **driver** bugs, not product:
raw `docker` calls address compose's PREFIX (`communication-m4-worker-a`) where the container is
`…-worker-a-1`, so `docker logs` reads nothing (C4c, `live9/C4.out:55`), the SIGSTOP answers `No such
container` (C5b's freeze, `live9/C5.out:34`) and W5/W6 refuse to kill anything at all
(`live9/W5.out:31`, `live9/W6.out:29`); and the retry POSTs land after the reconciler has already
restarted the run, so § 7.1's 200/checkpoint refusals read `run-not-retriable` instead
(`live9/C6.out:61, :64, :67, :99-100, :111`). Both fixes are in progress — the name resolution is
already guarded offline by `e2e/m4/test_container_names_logic.py`. `5145bcb` (non-members get the same
404 as an unknown project on project runs/schedules routes) also landed after pass 8's lab commit and
has not been re-run live.

**M5 browser legs (not § 7 items, recorded for continuity).** `e2e/tests/m5-journey.spec.ts` ran
12 passed / 1 failed / 4 not run on the lab — the single failure is step 6, whose assumption (exit 1 is
a failure) is wrong for the engine, since exit 1 alone is a business outcome that completes the run;
fixed in `ef470a0`, rerun pending. `e2e/tests/m5-inbox.spec.ts` PASSED 6/6 live on the lab.

## What blocks the M4 exit

Finding ids (`P*`, `D*`, `RC*`) are `docs/m4-live-findings.md` (written from pass 1); "fixed in
`<sha>`, not re-run" names a commit that landed after the pass behind the verdict.

**Product bugs — open**

- **No longer open: the retry 500 is dead** — pass 8's `POST /runs/{id}/retry` → **500** `about:blank`
  (`live8/C6.out:61-62, :66`) is fixed in `13b81fb` (ADR-0037): a retry naming a node execution the run
  lacks now answers **404** `node-execution-not-found`. Pass 9 never reached that arm — its retries read
  409 `run-not-retriable` because the run was already `running` (or, by C6e, `completed`) again
  (`live9/C6.out:60, :67, :99-100`), which is the driver-sequencing bug below rather than a product
  defect. No product retry bug is currently open; C5e/C6c/C6d/C6e stay FAIL on the driver side.
- C8 is closed as a product question — pass 7 ran the gate on a build containing `04f53fd` and came back
  **31 PASS / 0 FAIL / 2 GAP** (`live7/C8.out:91`). `21656f6`'s children are proven end to end: 25 invoke
  rows, 25 `pipeline_invocations`, depth 1, 25 `child_run_id`s in `outputs.children`, 25 distinct `/tree`
  children (`live7/C8.out:48-50, :53-54, :60-68`), the cancel cascade works (C8g `:86-88`) and
  `b977ee4`'s `child_depth_exceeded` guard fires live (C8f `:75`). Two GAPs remain and neither is a bug:
  C8e (the immutable published revision authors only `collect_and_continue`, so stop/fail_after_all is
  offline-only algebra in `e2e/m4/test_c8_logic.py`, `:69`) and C8f's third-level `runs_depth_check` arm
  (`:76`).
- No longer blocking: **W7 is dead** — `5ade2c5` counts runs whose ready attempt cannot be bound, and
  pass 6 reads `queued_unbindable_runs=1` for the affinity-bound run with the Ops page saying
  'waiting for its worker' in those words (`live6/W7.out:51-52`, W7 PASS 30/0). C12b (`e0ee333` named
  the cap failure) and C12c (`554092a`'s corrected probe) both
  PASS at pass 5 (`live5/C12.out:72`, `:102`); RC1/P1's double `attempt_count` is dead — C1e reads
  `attempt_count = 1` live at `live5/C1.out:85` (`0a0e6bb`), so C5e's retry-from-checkpoint row is
  reachable once C5a gets a live attempt; and P2 (the inert scheduler flag) died in `9af17dc`, already an
  ancestor of pass 4's lab, which is why C14c's GAP changed wording rather than staying a `FAIL`.

**Driver bugs — open (the probes are broken, not the product)**

- ~~C1f~~ and ~~C1h~~ PASS at pass 6 (`dfff98e`'s fixes re-confirmed live at pass 9, `live9/C1.out:98-100, :103; :110-118, :126`)
  — `dfff98e` fixed the 7-field parse of the 8-column artifact row
  and replaced the fixed-order milestone-chain conjunct with an in-order-subsequence match
  (`live6/C1.out:82-84, :87`; `:94-102, :110`).
- ~~C4a / C4b / C4d~~ PASS again at pass 9 (`live9/C4.out:34, :43-46, :64-65`) on the re-run fence, having
  first PASSed at pass 8 — `cefe995`'s `hold_seconds` input, driven by `522a82b` and proven-before-faulting
  since `1e75c23`, held the twin open and the fence landed on a live lease (`node.attempt.interrupted{lease_expired,system}` + `node.attempt.retry_scheduled`, `live9/C4.out:40-46`) and the replacement attempt succeeded with "ownership moved, no process died" (`:65`). C4c is down to the one observation arm — the stale owner's refusal matched 0 lines in its own log (`:55`) — and that arm is the container-name driver bug below, **not** the worker (`ef33f8d`'s log line is in the pass-9 build).
- ~~The remaining fault-injection legs pick the wrong attempt~~ — **fixed in `1e75c23` and proven live at
  pass 9**: C5's kill pick, C6's kill and W2's mid-lease sample all name `/build_until_verified[1]/implement`
  (`live9/C5.out:29`, `live9/C6.out:43`, `live9/W2.out:31`) — no more pre-gate `/plan` deaths — and W2, W3,
  C5b and C1e moved on the strength of it.
- **New, open: raw `docker` calls address compose's PREFIX, not the container.** The lab's containers are
  `communication-m4-worker-a-1` / `…-worker-b-1`, but the legs name `communication-m4-worker-a`, so the
  command reads or kills nothing: C4c's stale-owner log arm matched 0 lines (`live9/C4.out:53-55`) even
  though `ef33f8d` makes the worker log the refusal once per attempt; C5b's SIGSTOP answered `cannot kill
  container: communication-m4-worker-a: No such container` (`live9/C5.out:34`) and the rest of C5 GAPed
  behind it (`:36-37`); W5 and W6 refused to kill anything at all because § 7.0 only lets them kill a
  container they can prove belongs to the project (`live9/W5.out:31`, `live9/W6.out:29-31`). The rule and
  the resolver are written down at `e2e/m4/e2e_m4_exit.py:90-95` and guarded offline by
  `e2e/m4/test_container_names_logic.py` — **driver fix in progress, rerun pending**.
- **New, open: the retry POSTs race the reconciler.** C5e FAILs at 409 "a running run is not retriable"
  (`live9/C6.out:67`) because the killed attempt's replacement (attempt 2, `retry_scheduled='1'`, `:111`)
  had already restarted the run; C6d therefore measured the wrong refusal (`code=''` where § 7.1 wants
  `checkpoint_unavailable`, `:61`) and its "appended no new attempt" arm saw attempt 2 (`:64`); C6e's
  cross-volume retry read "a completed run is not retriable" (`:99-100`) and its `workspace.recovery_lost`
  read crashed on `operator does not exist: uuid = text` (`:101-105`) — a second driver read bug in the
  same leg. **Driver fix in progress, rerun pending**.
- ~~C1e's stale input count~~ — **fixed in `1e75c23` and PASS at pass 9**: the arm scores `run_inputs`
  against what the pinned revision DECLARES, so `hold_seconds=default` is one of the six rather than an
  extra row (`live9/C1.out:91, :152`).
- C3a/C3c `live6/C3.out:29, :38` — unchanged (C3 did not run at pass 7 or 8): the leg still does not
  consume C8's 25-attempt queue, and no `/implement` row carries a worker_id to count claims over.
- C10b `live4/C10.out:58` — "no `node.execution_skipped{reason:'condition_default'}` may appear" is
  unsatisfiable on the seeded graph, which skips `/emit_items` on `inputs.fanout` by design (`:76`; C9e
  counts the same pair at `live4/C9.out:109`). Unclassified in the findings file.
- Fixed and re-proved, listed so nobody re-files them: C1's and C4's `psql rc=1` crashes
  (`live4/C1.out:75`, `live4/C4.out:29`) were `a2233fd`; C12b's 422 idempotency key (`live4/C12.out:70`)
  and C5's kill race (`live4/C5.out`) were `42187e7`; C8's `NameError: c8_sql` and the C11/C14 probes
  (D2, D3, D4, D6) were `554092a`; C1f's column count and C1h's chain match were `dfff98e`, and the
  C4/C6 gate sequencing was `0cbe14b`, C8's children/project reads were `04f53fd` (visible as pass-7
  PASSes), and the C4 fence/kill targeting on a held lease was `cefe995`+`522a82b` (pass-8 C4a/C4b/C4d).
- W4's pass-4 crash (`live4/W4.out:23`) was the exit stack not being up
  (`live4/_seed-W4.out:2 SEED FAIL stack not ready`), not the leg. `77d46ba`/`0a20a8f` (CI data race,
  lazy-route UI determinism) landed after pass 4 and are not what makes W4 pass — the pass-5 rerun is
  (`live5/W4.out:52`).

**Known design limit — unattended permission prompts (accepted behaviour, not a bug)**

At passes 4–5 five items were blocked by the same mechanism, so they are grouped rather than counted
as product bugs (C1c and W3 left this group at pass 6, and pass 8 root-caused them somewhere else
entirely — below):
under `permission_mode: ask`, a run attempt's prompt is journalled
`conversation.permission.requested` → `conversation.permission.decided{status:'cancelled',
decided_by:'node_policy:ask_unattended'}`, the agent's tool call gets the ACP cancelled outcome, and
`execute` fails. C1's agent run shows the trail three times, one per attempt (`live5/C1.out:55-60`, the
titles are the agent's own `find …`/`cat hello.py` calls), and the run ends
`node_execution_failed:/plan` (`live5/C1.out:27`).

- C1c `live9/C1.out:70` and the cross-variant key set `live9/C1.out:192` — the agent leg still cannot
  reach terminal `completed`, and it is still **not this design limit**: `4b4bfb8`'s schema fix worked —
  `/plan` `succeeded` (`:50`), `/approve` `succeeded` (`:37`) and iterations 1–2 of implement/review/test
  all `succeeded` (`:39-44`) — before `/build_until_verified[3]/review` failed at attempt 2 (`:46`). The
  attempt's trail is the same shape as pass 8's (`conversation.message.agent` → `agent.session.disconnected`
  → `sandbox.egress_observed` → `node.attempt.failed`, seqs 276/277/278/280, `:62-65`) with an empty ADR-0016
  permission trail (`:69`), so `ask_unattended` is not involved; **the cause is under capture — this pass
  records only where it died.** The `ask_unattended` trail below predates the ADR-0036 flip and stands for
  C9g/C11.
- ~~W3 `live6/W3.out:53`~~ — **PASS at pass 9, 21/0/0** (`live9/W3.out:55`): the leg parks its run on a
  real pending gate off a real Claude plan and the card renders for both users (`:26-52`). It left this
  group for good.
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
- C6b `live9/C6.out:72` — targeting is fixed and proven (`1e75c23`: C5's pick names
  `/build_until_verified[1]/implement` at `live9/C5.out:29`, C6's kill the same node at `live9/C6.out:43`
  and C5b PASSes there, `:49-50`), but the legs stop one step later: C5's own SIGSTOP names a container
  that does not exist (`live9/C5.out:34`) so its kill arms GAP (`:36-37`), and on C6 the compiled plan the
  validate returned carries no `restore_checkpoint` string at all (`:38-39`), so there is no restore to
  measure, no `run.checkpoint_restored` row (`:68-69`) and no readable HEAD/dirty across the kill or the
  retry (`:55-56, :70-71`). These remain the milestone's exit sentence: **the container-name driver fix is
  in progress and those legs need a rerun**; C5e/C6c/C6d/C6e ride on the retry-sequencing bug above.
- W5 `live9/W5.out:31`, W6 `live9/W6.out:29-31` — both still GAP, now for the container-name reason
  above: the legs name `communication-m4-worker-a`, cannot prove a container belongs to the project, and
  § 7.0 forbids the kill, so nothing is ever left behind for W5's interrupted wording or W6's "prior edits
  lost" copy to describe. W2 left this group at pass 9 — its mid-lease core arm PASSes
  (`live9/W2.out:31`) — and its two remaining `conversation.turn.*` GAPs (`:49, :52`) are fixture shape: a
  `process.exec` twin owns no ACP turn, and `conversation.*` sits outside `M4_RUN_EVENT_TYPES`
  (`RunInspector.tsx:720`, ADR-0014 § 8).
- C3a `live6/C3.out:29` — C8's queue exists and is proven (`21656f6` + `04f53fd`: 25 invoke rows at
  `live7/C8.out:48-50`), but the C3 leg still does not consume it ("C8 prints SKIP" in its own text);
  C3c `live6/C3.out:38` — no `/implement` attempt row carries a worker_id (the <1s twin race C4's leg
  has since been fixed around, so both are re-testable with `hold_seconds`). Both are test setup, rerun
  pending.
- C5f `live4/C5.out:82` (git HEAD unreadable across the restart) and C5h `live4/C5.out:99` (no
  long-running `maxAttempts: 1` twin node exists to exhaust) stay pass-4 GAPs — C5 has not got past its
  freeze since. C4e `live9/C4.out:66` still GAPs (the fenced attempt is `/plan`, `turn_id` NULL, so no ACP
  transcript exists to time); C6d's uncommitted-boundary precondition `live9/C6.out:57` still GAPs. C8's
  two GAPs (`live7/C8.out:69, :76`) are rows above, no longer downstream of a crash.
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

**Driver legs exist, not yet run live — W10, W11**

`w1`, `w3`, `w4`, `w7`, `w8` and `w9` are implemented Playwright legs that have run, pass 8
added W2, W5 and W6 to that list, and pass 9 re-ran all three (W2 **PASS**, W5/W6 GAP on the
container-name bug above, none FAILs). Only **W10 and W11** remain NOT RUN: their legs landed in
`d91f4fc`/`74ea274` (SSE resume with `?after=` and dedupe, `/tree` children rendered under run) but
have never executed live on HEAD, so they are NOT RUN, not GAPs. W11's scripted precondition is
proven: C8's tree renders 25 distinct children at `live7/C8.out:64-68`. W5's and W6's scripted
substitutes (C5b/C6e) are still blocked on the driver fixes above.
`live7/C8.out:64-68`. W5's and W6's scripted substitutes are still blocked on the same pick.
