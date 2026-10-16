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

A fresh lab reset + seed ran before EACH gate of passes 4–8 (`_seed-<GATE>.out` is that gate's seed
manifest and `_build.out` the lab commit it was built from), so no pass-4/5/6/7/8 verdict inherits another
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
| C1a | run POST returns 201 queued | PASS — the agent arm and both twins | pass 8 @ 522a82b | live8/C1.out:24, :26, :146, :148 |
| C1b | designated approver's decide posts 200 | PASS | pass 8 @ 522a82b | live8/C1.out:55, :149 (also `live8/C4.out:61`) |
| C1c | run reaches terminal `completed` | FAIL — the agent arm ended `failed` (`node_execution_failed:/plan`); both twin arms completed (`:56, :150`). Pass 8 **root-caused it**: the real-Claude `/plan` reply is an object (`goal`/`findings`/`steps`) while the pipeline declared `plan: string`, so the attempt dies `invalid_output` — the journal trail is `conversation.message.agent` → `agent.session.disconnected` → `sandbox.egress_observed` → `node.attempt.failed` (`:119-123`), i.e. not the old `ask_unattended` mechanism and not a prompt problem. **Fixed in `4b4bfb8` (the schema now declares the object Claude returns), rerun pending** | pass 8 @ 522a82b | live8/C1.out:54 (twins: :56, :150; trail: :119-123) |
| C1d | full node key set, statuses, execution locations | PASS — 14 keys, exact, control_plane/worker split correct, both twins, no unexpected node kinds (loop spent 2 iterations) | pass 8 @ 522a82b | live8/C1.out:72-74, :112 (replay: :166-168, :206) |
| C1e | digests, checkpoint count, attempt_count=1 | FAIL — one arm, and it is the fixture moving under the check: `run_inputs` now reads **6** validated rows where the probe wants 5, because `cefe995`/`522a82b`'s new hold-open input arrives as a second `default`-origin row (`origins=[… 'hold_seconds=default' …]`) — driver expectation stale, rerun pending. The substantive arms PASS on both twins: digests match the manifest verbatim (`:76, :170`), API agrees with the ledger (`:77, :171`), 8 checkpoints == 8 succeeded worker nodes (`:78, :172`), `attempt_count = 1` (`:79, :173` — RC1's double-count proven dead again) | pass 8 @ 522a82b | live8/C1.out:75 (replay: :169; PASS arms: :76-79, :170-173) |
| C1f | artifact bytes readable, redaction_count 0 | PASS — every arm ran and passed on both twins: published exactly once, `redaction_count=0`/`ready`, `GET /artifacts/{id}` + `/content` bytes hash to the row's sha256, `artifact.created` journaled | pass 8 @ 522a82b | live8/C1.out:82-84, :87 (replay arms: :176-181) |
| C1g | run.completed carries result_bindings | PASS — summary non-empty, review_approved true, iterations 2 == ledger, both twins | pass 8 @ 522a82b | live8/C1.out:90-93, :184-187 |
| C1h | journal sequence contiguous for the run | PASS — every arm passes on both twins, the milestone chain included (in-order subsequence match, `dfff98e`): 46 rows, `run.created` first / `run.completed` last, run slice strictly ascending, attempt rows carry `node_execution_id` + `attempt_id`, gate rows carry NULL `attempt_id`, 8 `run.checkpoint_saved` == 8 worker nodes | pass 8 @ 522a82b | live8/C1.out:94-102, :110 (replay: :188-204) |
| C1i | replay reproduces the key set and plan_digest | PASS — identical 14-key set (`seed_only=[] replay_only=[]`), `plan_digest` seed == replay == manifest; the cross-variant comparison still FAILs (`:242`) because its agent leg is C1c's | pass 8 @ 522a82b | live8/C1.out:240-241 (FAIL arm: :242) |
| C2a | secret reaches only the live authorized process | GAP — the gate WAS approved and `/implement` ran (run status `'completed'`), but no attempt was still worker-held when the poll looked, so "exactly one place" was unmeasurable | pass 4 @ 854b2ef | live4/C2.out:63 (approval arm :30) |
| C2b | worker unmounts the env at the node boundary | NOT RUN — blocked behind C2a's GAP | — | live4/C2.out:63 |
| C2c | sentinel absent from every durable surface | GAP — only the encrypted-store arm ran (the value lives in `secret_versions.content_sha256`, no plaintext); the live-surface sweep needs C2a's held attempt | pass 4 @ 854b2ef | live4/C2.out:63 (arm that ran: :26) |
| C2d | reviewer prompt and tool output carry no secret | NOT RUN — blocked behind C2a's GAP | — | live4/C2.out:63 |
| C3a | two workers contend on a deep queue | GAP — both workers online (`:28`), but the C3 leg still does not build the 25-attempt queue: its text waits on a C8 fan-out it never consumes ("C8 prints SKIP", `:29`) even though C8's children are real now (live6/C8.out:48-50); every assertion below is measured over the seed/C1 runs — test setup, rerun pending | pass 6 @ 382d42b | live6/C3.out:29 (children that exist now: live6/C8.out:48-50) |
| C3b | never two live claims of one attempt | PASS — held=1, one distinct worker, on both inspected runs | pass 6 @ 382d42b | live6/C3.out:32-33, :36-37 |
| C3c | one /implement claim, one fencing token drawn | GAP — no `/implement` attempt row carries a worker_id in any inspected run: the twin's steps finish in <1s, so no claim is ever worker-held to count over — test setup, not product; the hold-open input now exists (`cefe995`, driven by `522a82b`, proven on C4's lease at `live8/C4.out:41-44`) but C3 did not rerun with it, rerun pending. The `attempt_fencing_seq` arm PASSed | pass 6 @ 382d42b | live6/C3.out:38 (arm that passed: :39) |
| C3d | negative control sentence recorded | NOT RUN — a report line, not an assertion (C4 is the proof) | — | live4/C3.out:44 |
| C4a | a live lease exists to freeze | PASS — the leg decided its own gate and worker-a's lease was held open, frozen through 45s of renewals and then unpaused — `522a82b` running the twin with `cefe995`'s `hold_seconds=45` input | pass 8 @ 522a82b | live8/C4.out:32 (gate arms: :24, :26) |
| C4b | frozen lease becomes interrupted with a retry | PASS — the hold-open fixture worked: the journal carries `node.attempt.interrupted` with `reason=lease_expired` and `actor_kind=system`, followed by `node.attempt.retry_scheduled`. Pass 6's <1s race ("the fence lands after the attempt already succeeded") is gone | pass 8 @ 522a82b | live8/C4.out:41-44 |
| C4c | a stale owner cannot publish success | FAIL — twelve arms PASS now that the attempt is really held open: the fenced attempt reads `interrupted` with NULL outputs, zero ready artifacts, zero `run_checkpoints`, zero `node.attempt.completed` (`:45-49`), API and ledger agree (`interrupted` in both, `error_class` matching, `:56-57`), no lease machinery in the API body (`:58`), and a replacement attempt exists with a strictly greater fencing token (`:59-60`). The one remaining FAIL is the observation arm — the stale owner's refusal matched 0 lines in its own log (`:53`) — **fixed in `ef33f8d` (the worker logs the fenced write refusal once per attempt), rerun pending**. One arm GAPs: `finished_at IS NULL` is unrepresentable under 00005's `attempts_terminal_timestamped` CHECK, so § 7.1's literal expectation cannot be met by any terminal row (`:50`) | pass 8 @ 522a82b | live8/C4.out:53 (PASS arms: :45-49, :56-60; GAP: :50) |
| C4d | replacement attempt succeeds, run completes | PASS — "the retry (attempt N+1) succeeded and the run completed — ownership moved, no process died" (`:63`), the run `completed` (`:62`) | pass 8 @ 522a82b | live8/C4.out:62-63 |
| C4e | fenced turn appends no transcript rows | GAP — the fenced attempt is `/plan` with `attempts.turn_id` NULL: a `process.exec` node owns no ACP turn, so `conversation.turn.interrupted` and the transcript-timing arm are unmeasurable on it (needs an `agent.acp` attempt — C6/C7's territory) | pass 8 @ 522a82b | live8/C4.out:64 |
| C5a | a live attempt exists to SIGKILL | GAP — pass 8 decided the gate (`:27`) and still caught nothing worker-held in 300s: the run ended `completed` with all 14 nodes terminal (`:61`). `522a82b`'s `hold_seconds` fixture took on C4's leg but not this one — **the driver's mid-node pick targets the wrong attempt; driver targeting fix queued**, rerun pending. `42187e7`'s race-free SIGSTOP→prove-live→SIGKILL arm has still never executed | pass 8 @ 522a82b | live8/C5.out:27, :61 |
| C5b | kill reads interrupted, never completed | FAIL — pass 8 reran the kill inside C6's leg and the killed attempt still read `succeeded` with no `error_class` (live8/C6.out:50-51): the leg's kill landed on `/plan`, **before** the gate node § 7.1 names (`/build_until_verified[1]/implement`, `:42-43`) — a pre-gate attempt that had already written its own success. Driver targeting fix queued; the reconciler's `interrupted{lease_expired}` stays unmeasured | pass 8 @ 522a82b | live8/C6.out:50-51 (wrong node picked: :42-43; pass-4 original: live4/C5.out:41-47) |
| C5c | checkpoints and artifacts survive the kill | PASS — `run_checkpoints` identical before/after the kill, last completed boundary still queryable, ready artifact count unchanged, nothing left `uploading` | pass 4 @ 854b2ef | live4/C5.out:52-55 |
| C5d | same-volume workspace is reclaimed, not rebuilt | PASS — workspace `ready`, `volume_id` byte-identical across the kill (ADR-0017's reclaim rule), no `workspace.recovery_lost` event | pass 4 @ 854b2ef | live4/C5.out:66-68 |
| C5e | retry posts from the last checkpoint | FAIL — pass 8's retry no longer 409s, it 500s: `POST /runs/{id}/retry` → **500** `about:blank` "The server could not complete the request" (`live8/C6.out:66`) when the request's `workspacePolicy` names a node that is not yet in the run (the kill landed on `/plan`, so `run.retried` names nothing for `/implement`) — **product fix in progress**; the driver's mis-placed kill is the queued trigger. RC1's halved budget (`0a0e6bb`) is separately proven dead again at live8/C1.out:79 | pass 8 @ 522a82b | live8/C6.out:66 (pass-4 original: live4/C5.out:71, :80) |
| C5f | continue_workspace is the observed default | GAP — git HEAD was unreadable across the restart in the retry window (`before='' after=''`), so the not-reset claim is unmeasured | pass 4 @ 854b2ef | live4/C5.out:82 |
| C5g | retry appends, never rewrites history | FAIL — 7 of 8 node keys read `attempts=0` (that killed run's remaining nodes were cancelled/skipped, not attempted), while `/plan` appended exactly 1 attempt and the run reached `completed` after the checkpointed retry; the key-set-vs-C1 identity arm GAPped because C1 crashed in that pass and had no key set to compare | pass 4 @ 854b2ef | live4/C5.out:85-92 (PASS arms: :89, :95; GAP: :96) |
| C5h | exhausted budget fails the run honestly | GAP — every node the worker can be killed mid-way through is authored `maxAttempts: 3`; the lab ships no long-running `maxAttempts: 1` twin node, so the refusal arm has nothing to measure | pass 4 @ 854b2ef | live4/C5.out:99 |
| C6a | revision carrying retry.workspacePolicy | PASS — the restore_checkpoint twin published as its own immutable revision with exactly one policy line changed (8853 bytes), the seed's revision untouched | pass 8 @ 522a82b | live8/C6.out:27, :28, :37 |
| C6b | restore_checkpoint really resets the worktree | GAP — pass 8 decided the gate and ran the restore twin (`:40`) and killed worker-a (`:48-49`), but **the driver's kill landed on `/plan`, pre-gate**, where § 7.1 names `/build_until_verified[1]/implement` (`:42-43`), the killed attempt had already written `succeeded` (`:50-51`), HEAD/dirty were unreadable across the kill and retry windows (`:56, :73`), no `run.checkpoint_restored` row exists (`:70`) and the authored policy did not reach the compiled plan (`:72`) — there is no restore to measure. Driver targeting fix queued, rerun pending | pass 8 @ 522a82b | live8/C6.out:72 (kill on the wrong node: :42-43, :50-51; gate arm: :40) |
| C6c | restore-mode retry completes the run | FAIL — the run reached `completed` (`:81`), but `run.retried`'s `workspace_policies` named nothing for the `/build_until_verified[1]/implement` node (`:82`) and the key-set-vs-C1 identity arm FAILed (`:83`, `only_c1` = the four pre-fan-out keys) — downstream of the same pre-gate kill, with the retry itself 500ing (`:66`, product fix in progress); the CTX comparison GAPped because C1 did not run inside this gate (`:84`). Driver targeting fix queued, rerun pending | pass 8 @ 522a82b | live8/C6.out:82-83 (PASS arm: :81; GAP arm: :84) |
| C6d | dirty boundary refuses, resets nothing | FAIL — the refusal is now a **500** where § 7.1 wants 409 (`:61`) and its problem+json code came back empty instead of `checkpoint_unavailable` (`:62`) — retry 500s whenever the policy names a node not yet in the run: **product fix in progress**. The arms that ran on the refusal path PASS (nothing reset `:63`, zero `run.checkpoint_restored` `:64`, no appended attempt `:65`), and the uncommitted-boundary precondition still GAPs (no readable `run_checkpoints.repo_states` rows, `:58`) — the refusal is measured against missing fixture state | pass 8 @ 522a82b | live8/C6.out:61-62 (PASS arms: :63-65; GAP: :58) |
| C6e | cross-volume loss says recovery_lost | FAIL — the throwaway worker started on its own named volume (`:92`, `:114`) and the no-auto-retry / never-`resumed` arms PASS (`:111`, `:113`), but the run `completed` with no `workspace.recovery_lost` event (`:109`), no `error_class='workspace_lost'` (`:110`) and an empty operator refusal detail (`:112`) — the loss never bit: the mid-node attempt the leg needed was never picked (same driver targeting fix, queued), rerun pending | pass 8 @ 522a82b | live8/C6.out:109-110, :112 (PASS arms: :111, :113, :114) |
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
| W2 | live stream renders iterations, not duplicate nodes | GAP — the leg ran live for the first time and every rendering arm PASSes: the journal panel rendered (`:29`), the page updated live with no reload — 2 samples of one document (`:36`), `run.created` → `node.attempt.started` → `run.checkpoint_saved` drawn in journal order (`:37-41`), all 38 journalled run-vocabulary rows drawn at least once and never more often than written (no gap, no foreign frame, `:43-44`), both `/build_until_verified[1]` and `[2]` shown under ONE stage cell for the loop (`:47-51`). Its **core arm GAPped — no attempt was sampled MID-LEASE** (`:31`): the leg makes no claim about a live lease, driver targeting fix queued; two further GAPs cover `conversation.turn.*` on a `process.exec` twin that owns no ACP turn (`:39, :42` — the arm also sits outside `M4_RUN_EVENT_TYPES`, `RunInspector.tsx:720`) | pass 8 @ 522a82b | live8/W2.out:31 (rendering arms: :29, :36-44, :47-51; turn GAPs: :39, :42) |
| W3 | gate card: roles, countdown, approve, bob has no button | GAP — pass 6: the run started (`:24`) but never parked on a pending approval (`status 'failed'` after 420s, `:53`) — its real-Claude `/plan` attempt died `conversation.message.agent` → `agent.session.disconnected` → `node.attempt.failed` with no permission prompt (`:50`), so the card had nothing to render from. Pass 8 root-caused that trail as C1c's `invalid_output` (the `/plan` reply is an object vs the declared `plan: string`) — **fixed in `4b4bfb8`, rerun pending**; W3 has not re-run since pass 6. Pass 3's PASS stays superseded | pass 6 @ 382d42b | live6/W3.out:53 (run arm: :24; trail: :50; fix pending in `4b4bfb8`) |
| W4 | pinned-digest notice after a mid-run publish | PASS — the run page renders the pinned r1 digest before and after a live r2 publish, does not move onto r2, keeps "pinned r1" (not r2), and the notice "revision 2 published since this run started — this run is pinned to 1" renders. The leg exists since `d1bbcc3`, and the pinned-digest/notice copy it asserts is `3654c18`'s — both are already ancestors of pass 4's `854b2ef`, so neither is an unrun fix. Pass 4's crash was the exit stack not being up at all (`live4/_seed-W4.out:2 SEED FAIL stack not ready`) — an environment failure, not a leg failure; pass 5 is the rerun that measures it | pass 5 @ 42187e7 | live5/W4.out:30, :46-52 (pass-4 crash: live4/W4.out:23) |
| W5 | kill renders honest interrupted wording | GAP — ran live for the first time on pass 8: the run started (`:24`), alice signed in (`:26`) and the run page was open BEFORE the kill (`:27`), the gate was decided (`:30`) — but the kill picked no attempt row at all (`:31`), so the interrupted wording, the countdown and attempt 2 are unmeasurable (`:32`): the mid-node pick is the driver's, targeting fix queued, rerun pending. Still no scripted substitute — C5b–C5h are blocked above | pass 8 @ 522a82b | live8/W5.out:31-32 (page-open arm: :27) |
| W6 | cross-volume run says "prior edits lost" | GAP — ran live for the first time on pass 8: the run started (`:26`) and the gate was decided (`:28`), but again there is no provable mid-node death — no attempt row readable after 0 kill pick(s) (`:29`) — so the different-volume arm has no workspace really left behind on another worker's volume to report on (`:30`); driver targeting fix queued, rerun pending. Still no scripted substitute — C6e is blocked above | pass 8 @ 522a82b | live8/W6.out:29-30 (run/gate arms: :26, :28) |
| W7 | ops page counters and per-worker load | PASS — 30/0/0: every counter, both per-worker load rows and the offline→restored arms render, and the arm that FAILed at pass 4 now PASSes — `queued_unbindable_runs` counts the affinity-bound run (`counter=1`) and the Ops page says 'waiting for its worker' in those words: `5ade2c5`'s fix confirmed live | pass 6 @ 382d42b | live6/W7.out:29-38, :51-52 (rerender arms: :53-62; restored: :71, :80) |
| W8 | validate panel renders located errors by source | PASS — all 7 `kind_not_implemented` rows render at their `/spec/nodes/N/kind` location naming M5/M6, the schema/loader/compiler findings render with source + hint, and the secret-literal finding renders redacted | pass 4 @ 854b2ef | live4/W8.out:40-53, :68-72, :87, :102, :119-120 |
| W9 | cross-project deep links 404 with zero leakage | PASS — outsider session gets 404 + not-found copy on run, `/nodes` and the SSE URL, SSE never opens, and no project name / node name / digest value appears in the DOM, console clean. Two arms GAP: the row names carol but § 7.1 C9d needs carol as an M4 maintainer, so the outsider is the seeded `erin`; and the `/approvals/{id}` deep link had no approval to link to | pass 4 @ 854b2ef | live4/W9.out:35, :43-44, :46-51 (GAPs: :26, :45) |
| W10 | stream continuity across a replica roll | NOT RUN — the driver leg exists since `d91f4fc`/`74ea274` (SSE resumes with `?after=` and dedupes) but has never run live on HEAD; C14a's scripted SSE arm covers the mechanism, not the browser | — | e2e/m4/e2e_m4_exit.py (w10 leg, not run) |
| W11 | child tree renders, internals absent from the DOM | NOT RUN — the driver leg exists since `d91f4fc`/`74ea274` (RunTree renders `/tree` children under run) but has never run live on HEAD; its scripted precondition now exists — C8's tree renders 25 distinct children at live7/C8.out:64-68 | — | e2e/m4/e2e_m4_exit.py (w11 leg, not run) |

Totals: 85 items (74 § 7.1 sub-cases + 11 § 7.2 legs) — PASS 49, FAIL 10, GAP 20, NOT RUN 6.

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

**M5 browser legs (not § 7 items, recorded for continuity).** `e2e/tests/m5-journey.spec.ts` ran
12 passed / 1 failed / 4 not run on the lab — the single failure is step 6, whose assumption (exit 1 is
a failure) is wrong for the engine, since exit 1 alone is a business outcome that completes the run;
fixed in `ef470a0`, rerun pending. `e2e/tests/m5-inbox.spec.ts` PASSED 6/6 live on the lab.

## What blocks the M4 exit

Finding ids (`P*`, `D*`, `RC*`) are `docs/m4-live-findings.md` (written from pass 1); "fixed in
`<sha>`, not re-run" names a commit that landed after the pass behind the verdict.

**Product bugs — open**

- **New, open: retry 500s instead of refusing cleanly** — `live8/C6.out:61-62, :66` — `POST /runs/{id}/retry`
  with a `workspacePolicy` naming a node that is not yet in the run returns **500** `about:blank`
  ("The server could not complete the request") where § 7.1 wants 409 `checkpoint_unavailable`; the
  same 500 is what C5e's retry arm now reads. **Product fix in progress.** Until it lands, C5e stays
  FAIL and C6d/C6c cannot be measured even with a correctly placed kill.
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

- ~~C1f~~ and ~~C1h~~ PASS at pass 6 (`dfff98e`'s fixes re-confirmed live at pass 8, `live8/C1.out:82-84, :87;
  :94-102, :110`) — `dfff98e` fixed the 7-field parse of the 8-column artifact row
  and replaced the fixed-order milestone-chain conjunct with an in-order-subsequence match
  (`live6/C1.out:82-84, :87`; `:94-102, :110`).
- ~~C4a / C4b / C4d~~ PASS at pass 8 — `cefe995`'s `hold_seconds` input, driven by `522a82b`, held the
  twin open and the fence landed on a live lease: `node.attempt.interrupted{lease_expired,system}` +
  `node.attempt.retry_scheduled` (`live8/C4.out:41-44`) and the replacement attempt succeeded with
  "ownership moved, no process died" (`:63`). C4c is down to the one observation arm — the stale owner's
  refusal matched 0 lines in its own log (`:53`) — fixed in `ef33f8d`, **rerun pending**.
- **The remaining fault-injection legs pick the wrong attempt.** C5a and C6b GAP and C5b/C6c/C6e FAIL
  (`live8/C5.out:61`, `live8/C6.out:42-43, :50-51, :72, :82-83, :109-112`) because the driver's kill
  lands on `/plan` — before the gate node § 7.1 names (`/build_until_verified[1]/implement`) — even
  though the same fixture keeps C4's lease live. W2's mid-lease core arm (`live8/W2.out:31`), W5's
  kill (`live8/W5.out:31-32`) and W6's loss arm (`live8/W6.out:29-30`) fail the same way: 0 kill pick(s),
  nothing worker-held. **Driver targeting fix queued, rerun pending** — not a product gap.
- C1e `live8/C1.out:75, :169` — the probe still wants `5 validated rows`; the fixture's own
  `hold_seconds` default makes it 6 (`origins=[… 'hold_seconds=default' …]`). Driver expectation, stale
  since `cefe995` — rerun pending. (This is why C1e reads FAIL while all its substantive arms PASS.)
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

- C1c `live8/C1.out:54` and the cross-variant key set `live8/C1.out:242` — the agent leg still cannot
  reach terminal `completed`, but pass 8 **found the cause and it is not this design limit**: since
  `382d42b` flipped the lab's agent profiles to `preapproved_within_sandbox` (ADR-0036) the attempt no
  longer dies on the prompt — it dies `conversation.message.agent` → `agent.session.disconnected` →
  `sandbox.egress_observed` → `node.attempt.failed` (`live8/C1.out:119-123`) because the real Claude
  `/plan` reply is an object (`goal`/`findings`/`steps`) against a declared `plan: string` —
  `invalid_output`. **Fixed in `4b4bfb8` (the schema now declares the object Claude returns), rerun
  pending.** The `ask_unattended` trail below predates that flip and stands for C9g/C11.
- W3 `live6/W3.out:53` — the gate card leg still cannot park a run: the same `session disconnected`
  failure after 420s (`:50`), so nothing rendered. That trail is C1c's `invalid_output` above, fixed in
  `4b4bfb8`; W3 has not re-run since pass 6.
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
- C5a `live8/C5.out:61`, C6b `live8/C6.out:72` — the hold-open fixture exists and works (`cefe995`'s
  `hold_seconds`, driven by `522a82b`: C4a/C4b/C4d PASS over a real frozen lease at `live8/C4.out:32,
  :41-44, :63`), but on C5/C6 the driver still aims its kill at `/plan`, pre-gate (`live8/C6.out:42-43`),
  so nothing is worker-held where the leg looks and there is no restore or loss to measure. These remain
  the milestone's exit sentence: **the driver's targeting fix is queued and those legs need a rerun**;
  C5b/C5e/C6c/C6d/C6e ride on the same pick plus the retry 500 above.
- W2 `live8/W2.out:31`, W5 `live8/W5.out:31-32`, W6 `live8/W6.out:29-30` — all three browser legs ran
  live for the first time on pass 8 and GAP on the same mid-node pick ("0 kill pick(s)", no attempt
  sampled MID-LEASE), so W5's interrupted wording and W6's "prior edits lost" copy stay unmeasured; the
  page itself drew everything it was given (W2's rendering arms PASS, `live8/W2.out:29, :36-44, :47-51`).
  W2's two `conversation.turn.*` GAPs (`:39, :42`) are fixture shape: a `process.exec` twin owns no ACP
  turn, and `conversation.*` sits outside `M4_RUN_EVENT_TYPES` (`RunInspector.tsx:720`, ADR-0014 § 8).
- C3a `live6/C3.out:29` — C8's queue exists and is proven (`21656f6` + `04f53fd`: 25 invoke rows at
  `live7/C8.out:48-50`), but the C3 leg still does not consume it ("C8 prints SKIP" in its own text);
  C3c `live6/C3.out:38` — no `/implement` attempt row carries a worker_id (the <1s twin race C4's leg
  has since been fixed around, so both are re-testable with `hold_seconds`). Both are test setup, rerun
  pending.
- C5f `live4/C5.out:82` (git HEAD unreadable across the restart) and C5h `live4/C5.out:99` (no
  long-running `maxAttempts: 1` twin node exists to exhaust) stay pass-4 GAPs — C5 has not got past
  C5a since. C4e `live8/C4.out:64` still GAPs (the fenced attempt is `/plan`, `turn_id` NULL, so no ACP
  transcript exists to time); C6d's uncommitted-boundary precondition `live8/C6.out:58` still GAPs. C8's
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

`w1`, `w3`, `w4`, `w7`, `w8` and `w9` are implemented Playwright legs that have run, and pass 8 added
W2, W5 and W6 to that list (all three GAP on the mid-node pick above, none FAILs). Only **W10 and W11**
remain NOT RUN: their legs landed in `d91f4fc`/`74ea274` (SSE resume with `?after=` and dedupe,
`/tree` children rendered under run) but have never executed live on HEAD, so they are NOT RUN, not
GAPs. W11's scripted precondition is proven: C8's tree renders 25 distinct children at
`live7/C8.out:64-68`. W5's and W6's scripted substitutes are still blocked on the same pick.
