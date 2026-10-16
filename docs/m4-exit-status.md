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
| pass 10 | `live10/` | `b2bfe62` | C1, C8 (C8's stop/fail_after_all revisions published by the gate itself; C8e's stop arm FAILed and is fixed in `d8b927c`) |
| pass 11 | `live11/` | `9be68fd` | C1, C4, C5, C6, C8, W2, W5, W6, W11 (first pass with `13dd742`'s container resolver: the fault legs finally read and kill real containers; W6 crashed in the driver, W11 ran live for the first time) |
| pass 12 | `live12/` | `5820aab` | C1, W3 (the rerun after `5820aab`'s review-prompt fix — **C1 98 PASS / 0 FAIL / 0 GAP**, the real-Claude agent run completing end to end) |
| pass 13 | `live13/` | `a06bd6a` | C5, C6, W6 (first pass that measures the engine's **automatic** retry after a kill instead of racing it with a manual POST; W6's `show()` crash fixed) |
| pass 14 | `live14/` | `87b8f08` (UI fixes held in the worktree, committed as `f010fe2`/`19175b3`) | C1, C2, C5, C6, W5, W10, W11 (C2 on the held attempt; **W10 live for the first time**; W5/W11 on the UI fixes that make them pass) |
| pass 15 | `live15/` | `599e4f9` | C1, C5 (**C5 38 PASS / 0 FAIL / 4 GAP** — `12cb433`'s `repo_states` fix lands the retry's `head_commit`); C6 and C2 still running as this was written |
| pass 16 | `live16/` | `059d132` | C1, C5, C6, W6 (**C5h's scratch `maxAttempts: 1` arm runs live for the first time** — 10 PASS lines; W6's loss still classed `infra`, `efb82bd` is not in this build) |
| pass 17 | `live17/` | `320c6fe` (contains `efb82bd` workspace_lost classification, `320c6fe` ACP-disconnect → infra, `04fb651` driver: C2 process tree, C10b routing scope, worker-c on its own `/workspaces`) | C1, **C2**, C6, W6, C10, C5 (**C2 29 PASS / 0 FAIL / 0 GAP** — secret delivery finally measured on a real agent attempt; **C10b no longer FAILs**; W6's loss classed `workspace_lost` and never auto-retried) |

A fresh lab reset + seed ran before EACH gate of passes 4–17 (`_seed-<GATE>.out` is that gate's seed
manifest and `_build.out` the lab commit it was built from), so no pass-4/…/17 verdict inherits another
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
| C1a | run POST returns 201 queued | PASS — all three legs | pass 17 @ 320c6fe | live17/C1.out:24, :26, :143, :145 |
| C1b | designated approver's decide posts 200 | PASS — all three legs | pass 17 @ 320c6fe | live17/C1.out:27, :85, :146 (also `live11/C4.out:62`) |
| C1c | @@run reaches terminal `completed` | PASS — the real-Claude agent run completes, and keeps completing: the agent leg ends `completed` (`:28`) after 2 iterations with `result_bindings.review_approved == true` and an SSE stream that saw the opening and closing frames (118 frames, `:83`); both twins complete as before (`:86, :147`). History of this row: pass 9 died at `/build_until_verified[3]/review` attempt 2 (`failed node_execution_failed:/build_until_verified`), live10 the same (`live10/C1.out:67`), and live11's agent arm ended `failed cause=until_exhausted` (`live11/C1.out:73`) because the reviewer could not see the plan the implementer published — **fixed in `5820aab`** (the review prompt approves on the goal, criteria and this iteration's implement/test results); pass 12 (`live12/C1.out` 98/0/0), passes 14–17 all reproduce a clean gate | pass 17 @ 320c6fe | live17/C1.out:28 (SSE: :83; twins: :86, :147; live11 FAIL: live11/C1.out:73) |
| C1d | full node key set, statuses, execution locations | PASS — on all three legs, and the agent leg's own key-set probe runs for the first time (it had died before it at passes 4–11): 14 keys exact (`ledger_only=[] expected_only=[]`), every node terminal at its expected status, `/approve`,`/verdict` control_plane vs loop bodies worker (ADR-0023 § 3), no unexpected node kinds with the loop spending 2 iterations | pass 17 @ 320c6fe | live17/C1.out:44-46, :84 (twin seed: :102-104, :142; replay: :163-165, :203) |
| C1e | digests, checkpoint count, attempt_count=1 | PASS — on all three legs: the input arm counts what the pinned revision DECLARES (agent leg `5 declared` — the twin adds `hold_seconds=default` as a 6th, `:47, :105, :166`), digests match the manifest verbatim (`:48, :106, :167`), API agrees with the ledger (`:49, :107, :168`), 8 checkpoints == 8 succeeded worker nodes (`:50, :108, :169`), `attempt_count = 1` (`:51, :109, :170` — RC1's double-count proven dead again) | pass 17 @ 320c6fe | live17/C1.out:47-51 (twin seed: :105-109; replay: :166-170) |
| C1f | artifact bytes readable, redaction_count 0 | PASS — every arm on all three legs: published exactly once, `redaction_count=0`/`ready`, `GET /artifacts/{id}` + `/content` bytes hash to the row's sha256, `artifact.created` journaled | pass 17 @ 320c6fe | live17/C1.out:54-56, :59 (twin seed: :112-114, :117; replay: :173-175, :178) |
| C1g | @@run.completed carries result_bindings | PASS — agent leg: summary non-empty (the agent's own words — "app/hello.py already had the requested change: add(a, b) has the docstring 'Return the sum of a and b.'", `:62`), `review_approved == true` (`:63`), `iterations 2` == the ledger's last suffix (`:64, :65`); both twins likewise | pass 17 @ 320c6fe | live17/C1.out:62-65 (twin seed: :120-123; replay: :181-184) |
| C1h | @@journal sequence contiguous for the run | PASS — every arm on every leg, the milestone chain included (in-order subsequence match, `dfff98e`): the **agent run's 118-row slice** opens `run.created` / closes `run.completed`, strictly ascending, 16 attempt rows carrying `node_execution_id` + `attempt_id`, gate rows NULL `attempt_id`, 8 `run.checkpoint_saved` == 8 worker nodes, and its SSE stream saw the opening and closing frames; the 46-row twin slices likewise | pass 17 @ 320c6fe | live17/C1.out:66-74, :82-83 (twin seed: :124-132, :140-141; replay: :185-193, :201-202) |
| C1i | replay reproduces the key set and plan_digest | PASS — identical 14-key set (`seed_only=[] replay_only=[]`), `plan_digest` seed == replay == manifest, **and the cross-variant comparison PASSes on both spellings now (`agent_only=[] twin_only=[]`)** — that arm FAILed at live10/C1.out:189 and live11/C1.out:195 only because its agent leg was C1c's | pass 17 @ 320c6fe | live17/C1.out:204-207 |
| C2a | secret reaches only the live authorized process | PASS — **GAP → PASS, promoted by `04fb651`'s process-tree probe driven on the `agent.acp` variant**: the sentinel sits in EXACTLY ONE live process environment — the authorized attempt's process tree, matched by digest, the value never printed, the adapter's children inheriting the launch env per ADR-0018 (`:54`) — and the holder is the process the attempt launched, not the worker daemon: `argv0='node /usr/local/bin/claude-agent-acp'` (`:55`). Delivery is env, not a file: the workspace has NO `.env.test.local` (`test -e .env.test.local -> 1`, `:56`) and every materialization row is `delivery_mode=env` with `target=DATABASE_URL` (`:57`). The window is real — the gate decided and the held attempt is the post-gate `/build_until_verified[1]/implement` (`:31`), the model's turn held it long enough to read inside the attempt (`:64`) — on top of the encrypted-store commitment (`:26`). Pass 14's "no `process.exec` attempt can ever be authorized to hold a secret" is exactly what the variant switch answers | pass 17 @ 320c6fe | live17/C2.out:54-:57 (window: :31, :64; store: :26; the dead GAP: live14/C2.out:42) |
| C2b | worker unmounts the env at the node boundary | PASS — **GAP → PASS**: the materialization row is stamped `attempt_id` = the attempt it was applied for (`1/1 rows carry attempt_id=96075635…`, `:60` — "01 invariant 5: the unit of work is the attempt, not the turn"), its lifecycle is `node_attempt` (`:61`), no row is keyed on a turn while naming a different attempt (`:62`), and **after the node boundary the worker UNMOUNTED it** — `cleaned_at` set with `cleaned_by='worker'` on 1/1 rows (`:63`, § 7.1's literal `t \| worker`). The state the claim needs now exists, so there is something to measure it against | pass 17 @ 320c6fe | live17/C2.out:60-:63 (the dead GAP: live14/C2.out:47) |
| C2c | sentinel absent from every durable surface | PASS — re-confirmed with **no GAP arm left**: the durable sweep runs while a worker really holds an attempt and comes back empty on every surface — 158 operational text columns across 158 readable places in Postgres, the encrypted store excluded (`:66`), the attempt's workspace tree on worker-a (`:67`), api-a's and worker-a's `/artifacts` (`:68, :69`), the compose logs of both workers and both API replicas (`:70`), and `git grep -I` over every ref of the mirror (`:71`). Pass 14's lone GAP arm — `conversation_turns` with no agent attempt to join (`live14/C2.out:58`) — is gone: five agent attempts own their `conversation_turns` row via `node_attempt_id` (`:74-:78`, the transcript text is inside the Postgres sweep at `:66`) and M3's human-initiated turns keep `node_attempt_id IS NULL` (`:79`) | pass 17 @ 320c6fe | live17/C2.out:66-:71 (turn arms: :74-:79; store: :26) |
| C2d | reviewer prompt and tool output carry no secret | PASS — re-confirmed on the agent variant: `GET /api/v1/attempts/f0fd52d9` names neither `DATABASE_URL` nor the sentinel (`:72`) and the reviewer attempt materialized NOTHING — 0 materialization rows on it, the allowlist naming only `m4-implementer` (`:73`). Pass 14's GAP ("the agent-leg half of the sentence — a profile-less `process.exec` node has no tool output", `live14/C2.out:59`) is closed by the variant switch: the run's five `agent.acp` attempts each own a `conversation_turns` row under the implement/review profiles (`:74-:78`) and the sweep reads those columns clean (`:66`) | pass 17 @ 320c6fe | live17/C2.out:72-:73 (turn/tool-output arms: :66, :74-:79) |
| C3a | two workers contend on a deep queue | GAP — both workers online (`:28`), but the C3 leg still does not build the 25-attempt queue: its text waits on a C8 fan-out it never consumes ("C8 prints SKIP", `:29`) even though C8's children are real now (live6/C8.out:48-50); every assertion below is measured over the seed/C1 runs — test setup, rerun pending | pass 6 @ 382d42b | live6/C3.out:29 (children that exist now: live6/C8.out:48-50) |
| C3b | never two live claims of one attempt | PASS — held=1, one distinct worker, on both inspected runs | pass 6 @ 382d42b | live6/C3.out:32-33, :36-37 |
| C3c | one /implement claim, one fencing token drawn | GAP — no `/implement` attempt row carries a worker_id in any inspected run: the twin's steps finish in <1s, so no claim is ever worker-held to count over — test setup, not product; the hold-open input now exists (`cefe995`, driven by `522a82b`, proven on C4's lease at `live8/C4.out:41-44`) but C3 did not rerun with it, rerun pending. The `attempt_fencing_seq` arm PASSed | pass 6 @ 382d42b | live6/C3.out:38 (arm that passed: :39) |
| C3d | negative control sentence recorded | NOT RUN — a report line, not an assertion (C4 is the proof) | — | live4/C3.out:44 |
| C4a | a live lease exists to freeze | PASS — the leg decides its own gate (`:24, :26`), the claim is attempt 1 of `/plan` on **worker-a** at token=2 (`:28`), `compose pause` freezes `communication-m4-worker-a-1` for 45s of stopped renewals and unpauses it (`:31-:33`), and the fenced attempt is still held when it wakes (`interrupted` in both ledger and Postgres, `:34-:35`) | pass 11 @ 9be68fd | live11/C4.out:32 (gate arms: :24, :26; the pick: :28; row after the wake: :34-35) |
| C4b | frozen lease becomes interrupted with a retry | PASS — on the re-frozen lease: `node.attempt.interrupted` with `reason=lease_expired` and `actor_kind=system`, followed by `node.attempt.retry_scheduled`, in the fenced attempt's own journal slice | pass 11 @ 9be68fd | live11/C4.out:41-44 (journal slice: :38-40) |
| C4c | a stale owner cannot publish success | PASS — **promoted**: `13dd742`'s container resolver makes the observation arm real — `docker logs communication-m4-worker-a-1 matched 2 lines` (`:54`), i.e. `ef33f8d`'s once-per-attempt refusal is now actually read from the right container. Everything else PASSes too: the fenced attempt reads `interrupted` with NULL outputs, zero ready artifacts, zero `run_checkpoints`, zero `node.attempt.completed` (`:45-:49`), API and ledger agree (`:57-:58`), no lease machinery in the API body (`:59`), and a replacement attempt exists with a strictly greater fencing token (`:60-:61`). One arm still GAPs: `finished_at IS NULL` is unrepresentable under 00005's `attempts_terminal_timestamped` CHECK, so § 7.1's literal expectation cannot be met by any terminal row (`:50`) | pass 11 @ 9be68fd | live11/C4.out:45-49, :54, :57-61 (GAP arm: :50) |
| C4d | replacement attempt succeeds, run completes | PASS — "the retry (attempt N+1) succeeded and the run completed — ownership moved, no process died" (`:64`), the run `completed` (`:63`) | pass 11 @ 9be68fd | live11/C4.out:63-64 |
| C4e | fenced turn appends no transcript rows | GAP — unchanged in kind: the fenced attempt is `/plan` with `attempts.turn_id` NULL — a `process.exec` node owns no ACP turn, so `conversation.turn.interrupted` and the transcript-timing arm are unmeasurable on it (needs an `agent.acp` attempt — C6/C7's territory). **Driver fix landed after this pass, never re-run:** `2f0fe1f` rewrites the leg to fence a live `agent.acp` implement attempt and check `conversation.turn.interrupted` plus no post-unpause transcript (guarded offline by `e2e/m4/test_c4e_logic.py`); C4 has not run since pass 11 | pass 11 @ 9be68fd | live11/C4.out:65 |
| C5a | a live attempt exists to SIGKILL | PASS — the leg releases the run from its gate (`:27`) and captures the pick and the checkpoint boundary BEFORE the fault: `attempt=1 worker=worker-a token=3 node=/build_until_verified[1]/implement` (`:29`), `CKPT_BEFORE` naming the one boundary (`:31`), `HEAD_BEFORE=3c697fedc483 dirty=0` (`:33`). § 7.1 names worker-a and the live claim landed on worker-a, so the leg kills its owner with no substitution. The freeze proves the lease stayed live: `docker kill -s STOP` with `status@stop=running status+3s=running proved=True` (`:37`) | pass 17 @ 320c6fe | live17/C5.out:27, :29, :31, :33, :37 |
| C5b | kill reads interrupted, never completed | PASS — re-proven on the same-volume leg: the worker died holding a live lease (`kill #1`: the reconciler wrote `interrupted` while the lease was still live 3s after SIGSTOP, `:38`), the killed attempt reads `interrupted` (`:41`) with `error_class='interrupted'` (§ 7.1's literal ask, `:42`), `node.attempt.interrupted{reason:lease_expired} actor=system` plus `node.attempt.retry_scheduled` journaled (`:46`), no `node.attempt.completed` for it (`:47`), run still `running` with the retry armed (`:48`) | pass 17 @ 320c6fe | live17/C5.out:38, :41-:42, :46-:48 |
| C5c | checkpoints and artifacts survive the kill | PASS — `run_checkpoints` identical before/after the kill (`before=1 after=1 diff=[]`, `:53`), the last completed boundary still queryable (`:54`), ready artifact count unchanged (`:55`), nothing left `uploading` (`:56`) | pass 17 @ 320c6fe | live17/C5.out:53-:56 |
| C5d | same-volume workspace is reclaimed, not rebuilt | PASS — workspace `ready` after the worker came back (`:67`), `volume_id` byte-identical across the kill (`sha256:90bd076dc2e63be2…` on both sides — ADR-0017's reclaim rule, `:68`), no `workspace.recovery_lost` event (`:69`) | pass 17 @ 320c6fe | live17/C5.out:67-:69 |
| C5e | retry posts from the last checkpoint | PASS — re-proven on the live17 build: the automatic retry carries the checkpoint's HEAD — `retry_context.head_commit` equals the HEAD read BEFORE the kill (`:88`, `'3c697fedc483'` == `'3c697fedc483'`); the `12cb433` fix that made this readable holds on a second independent kill. The engine arms the retry itself (`node.attempt.retry_scheduled actor=system` → attempt 2, `:76`), attempt 1 `interrupted` (`:84`), attempt 2 `running` (`:85`), `retry_context.attempt=1` (`:86`), `retry_context.error_class=interrupted` (`:87`). Two arms GAP and both are reported instead of forced: § 7.1's literal `POST /runs/{id}/retry -> 200` reads 409 (`:75` — the run is `running (retry armed)` per C5b's own sentence, a running run is not retriable, and with `attempt_limit=2` the ENGINE owns this retry, so the route only applies to the budget-refused case C5h's scratch arm measures) and `retry_context.modified_path_count` (`:89` — the engine omits the key for a zero count and the shipped twin holds its sleep BEFORE its edit, so the killed node had written nothing) | pass 17 @ 320c6fe | live17/C5.out:76, :84-:88 (GAP arms: :75, :89; the FAIL this replaces: live13/C5.out:88, live14/C5.out:88) |
| C5f | continue_workspace is the observed default | PASS — re-proven: git HEAD is readable across the restart and it does not move — `HEAD_AFTER_RETRY_START = HEAD_BEFORE` (`:90`, `before='3c697fedc483' after='3c697fedc483'`), the interrupted attempt's dirty path count did not shrink (`:91`), and zero `run.checkpoint_restored` events fire — continue_workspace, NOT restore_checkpoint (C6's policy, and C6b's live refusal below) (`:92`) | pass 17 @ 320c6fe | live17/C5.out:90-:92 |
| C5g | retry appends, never rewrites history | PASS — all 11 node keys check their own append rule with no FAIL (`:95-:105`): control-plane/gate rows 0 attempts (`/approve`, `/fan_out`, `/verdict`, `/build_until_verified`), `/plan` 1, `/build_until_verified[1]/implement` 2 (the killed attempt + the automatic retry, `:97`), unreached worker nodes 0, and the killed run reaches `completed` after the checkpointed retry (`:106-:107`). One arm GAPs — the key-set-vs-C1 identity comparison had "no C1 key set in this pass (`CTX['c1']` empty, `:108`)". **That GAP is a run-planning artifact, not a lab limit:** each gate ran in its own driver process with its own reset + seed, so no C5/C6 pass can ever hold C1's key set; the comparison needs the driver to carry the set across gates | pass 17 @ 320c6fe | live17/C5.out:95-:107 (GAP arm: :108) |
| C5h | exhausted budget fails the run honestly | GAP — **the substance is now measured live and the row still prints a GAP.** The `059d132` scratch-pipeline arm ran in both live16 and live17: it copies the twin's held node to top level (`:115-:116`, 1455 bytes, one node, no other retry budget, `:117`), publishes it through draft → validate → publish as its own scratch pipeline (`:128`), and then proves the whole § 7.1 C5h sentence live: the node is authored `attempt_limit='1'` (`:149`), the killed attempt reads `interrupted`/`interrupted` (`:150`), the retry is REFUSED with zero `node.attempt.retry_scheduled` rows and no attempt 2 (`:151`), the run fails honestly `failed \| node_execution_failed:/implement` (`:152`), the manual `POST /runs/{id}/retry` is ACCEPTED on that failed run (`:153`) and appends attempt 2 with a retry_context (`:154`). The GAP at `:111` is the leg's own **stale precondition** — "the killed node is authored with attempt_limit=2 in the § 7.0 twin", which is true of the seed twin and is exactly why the scratch arm exists — and the driver still counts it (`:159` `GAP=4`), so by the reading rule the row stays GAP until that precondition is dropped. Repeated identically at pass 16 (`live16/C5.out:111, :115-:154`) | pass 17 @ 320c6fe | live17/C5.out:149-:154 (the stale precondition: :111; gate summary: :159) |
| C6a | revision carrying retry.workspacePolicy | PASS — re-confirmed: the restore_checkpoint twin publishes as its own immutable revision with exactly one policy line changed (8853 bytes, `:27-:28`), and the seed's revision is untouched (`:37`) | pass 17 @ 320c6fe | live17/C6.out:27, :28, :37 |
| C6b | restore_checkpoint really resets the worktree | GAP — **still GAP, but the restore path is now live and what is measurable is its refusal.** `5c03d6c`'s wiring and `c652f43`'s compiled-plan read are in this build, and they show: BOTH `/build_until_verified[1]/implement` attempts die with `checkpoint_unavailable: ADR-0023 § 6 allows restore_checkpoint only when every repository in the run is at a committed state at the last completed boundary; the boundary was not provably committed, so no worktree was reset: repository 01a14693-866c-7a5e… was not captured at the boundary: its committed state is unrecorded` (journal seqs 64 and 67, `live17/_events-C6.txt`). The authored policy therefore reaches the worker and the § 6 rule fires — pass 14's "the policy never reached the compiled plan" (`live14/C6.out:69-:73`) is dead — but the boundary carries no `repo_states` for the repository, so nothing is ever reset. The leg then has nothing to kill: the hold was honoured (posted 45s, longest held 46s) and "the target node was simply never leased" (`:87-:88`) with the run already `failed` (`cause=node_execution_failed:/build_until_verified`, `:51`), so the restore itself stays unmeasured (`:89`). Identical at pass 16 (`live16/C6.out:89`) | pass 17 @ 320c6fe | live17/C6.out:89 (refusal text: live17/_events-C6.txt seqs 64, 67; run row: :51; hold probe: :87-:88; the superseded read: live14/C6.out:69-:73) |
| C6c | restore-mode retry completes the run | GAP — **FAIL → GAP: nothing FAILs any more, and the claim still is not measured.** The run reaches `completed` (`:82`), but `run.retried`'s `workspace_policies` cannot name the mode because there is no `run.retried` row at all — it is what the MANUAL `POST /runs/{id}/retry` writes, and that POST read 409 `run-not-retriable` (`:65-:67`) because the engine's own budget had already armed attempt 2 (`:68`). The key-set-vs-C1 arms GAP for needing two measured sets (`:84`) with C1 absent from this gate (`:85`); pass 11's FAIL on that comparison (`live11/C6.out:83`) is dead. C6d/C6e ride on the same sequencing — **not reached in passes 16–17**: the C6 leg stops at C6b's GAP, so this verdict is still pass 14's | pass 14 @ 87b8f08 | live14/C6.out:82 (GAP arms: :83, :84, :85; POST read: :65-:67) |
| C6d | dirty boundary refuses, resets nothing | GAP — **FAIL → GAP.** The refusal is still a 409 (`:60`), nothing is reset on the refusal path (`:62`) and zero `run.checkpoint_restored` events follow it (`:63`), but the checkpoint door is never reached: the run-status door fires first (`run-not-retriable`, `run_status='running'`, `:61`) because the ENGINE owns the auto-retry, so `code=checkpoint_unavailable` is unmeasurable — and the precondition underneath it GAPs too: `no readable run_checkpoints.repo_states rows` (`:57`), which is `12cb433`'s wire-key fix waiting on a rerun, and "the refusal appended no new attempt" GAPs rather than counting the engine's attempt as this refusal's append (`:64`). Pass 11's FAIL (`live11/C6.out:61, :64`) is the driver having graded the wrong 409; it now reports the contradiction instead — **not reached in passes 16–17**: the C6 leg stops at C6b's GAP, so this verdict is still pass 14's | pass 14 @ 87b8f08 | live14/C6.out:60, :62-:63 (GAP arms: :57, :61, :64) |
| C6e | cross-volume loss says recovery_lost | GAP — **FAIL → GAP.** The leg now runs end to end without crashing: a run is started (`:88`), released from its gate (`:90`), the owning worker is frozen with the lease proved live and killed (`:97`, worker-b this time — § 7.1 names worker-a, the leg kills the OWNER and says so), the owning worker is drained, and the throwaway required worker `communication-m4-worker-c` starts on its own volume (`:102`). The loss still never bit: the run carries no affinity to the owning worker (`:107-:108`), the forced affinity write is re-issued unguarded (`:109-:110`), the automatic retry lands before any operator POST can (`:111-:112`, 409 `run-not-retriable`), and no attempt of `/build_until_verified[1]/implement` ever carries `error_class='workspace_lost'` — ledger reads `('1','interrupted','interrupted')`, `('2','failed','infra')` (`:113`), so the produce arm GAPs too (`:123`). Pass 11's `operator does not exist: uuid = text` crash is dead. **Driver fix in progress** — `a06bd6a` added the cross-volume forcing write and `599e4f9` the W6 auto-retry helpers (not yet wired); rerun pending — **not reached in passes 16–17**: the C6 leg stops at C6b's GAP, so this verdict is still pass 14's | pass 14 @ 87b8f08 | live14/C6.out:113, :123 (PASS arms: :88, :90, :97, :102; POST read: :111-:112) |
| C7a | until_exhausted ends the run after 3 iterations | PASS — `failed`/`until_exhausted` (P3's cause fix, `94f0ce3`), exactly 3 iterations, 9 terminal body rows, the exhausted loop's descendants cancelled with no route taken; the until scope's own `iterations == 3` row GAPs (:70) | pass 4 @ 854b2ef | live4/C7.out:46-48, :66-69 |
| C7b | per-iteration evidence stays readable | PASS — one row per iteration key, outputs preserved, 3 `node.scope.iteration` with `pass_when_result=false`, evidence attached to both scope and run failures; the "3 distinct `test-*` artifact rows" arm GAPs (no artifact rows for the exhausted run) | pass 4 @ 854b2ef | live4/C7.out:49-58 (GAP arm: :59) |
| C7c | indeterminate predicate is predicate_error | GAP — the schema-declared field is refused at publish (`unknown_field` PASS), so no published document reaches the eval-time `predicate_error` arm; that half is only proven offline (`e2e/m4/test_c7_logic.py`) | pass 4 @ 854b2ef | live4/C7.out:124 (schema arm: :123) |
| C7d | carryForward observed across iterations | PASS — `previous` empty on iteration 1 (probe skipped), non-empty on 2 and 3 (probe succeeded), over a real exhaustion run; the prompt-echo half of the sentence GAPs because the twin is `process.exec` with no transcript | pass 4 @ 854b2ef | live4/C7.out:76 (transcript GAP: :77) |
| C8a | zero-item fan-out succeeds and completes | PASS — `/fan_out` with 0 items `succeeded`, `node.scope.completed {scope:'/fan_out', items:0}` journaled, `outputs.children` reads the EMPTY array `[]`, the run `completed` | pass 11 @ 9be68fd | live11/C8.out:11-14 (POST arm: :9) |
| C8b | 25 children, one run each, depth 1 | PASS — 25 invoke keys, 25 `pipeline_invocations` joined to child runs, 25 terminal rows split 24 succeeded + 1 failed, distinct child depth 1, children inherit the parent's project | pass 11 @ 9be68fd | live11/C8.out:48-50, :53, :54 |
| C8c | maxConcurrency 3 measured | PASS — invoke concurrency measured over `node_executions` commit points: peak=3 at seqs [1, 3, 26], the sample really saw parallelism (>1 in flight), over 3 sampled commit points | pass 11 @ 9be68fd | live11/C8.out:55-57 |
| C8d | one failing child, siblings preserved | PASS — exactly 1 failed child of 25 with 24 non-failed preserved, `collect_and_continue` scope `succeeded` with the failure collected, all 25 children ran, `outputs.children` carries 25 entries each naming its own `child_run_id`, and `/tree` shows 25 DISTINCT children keyed under `/fan_out` at depth 1 with the parent as root | pass 11 @ 9be68fd | live11/C8.out:51-52, :58-61, :64-68 |
| C8e | stop / fail_after_all child policies | PASS — **promoted**: `b2bfe62` publishes each mode as its own parent revision (revisions immutable, § 7.0) and `d8b927c` gives the stop leg its siblings, so both modes are measured live. **stop**: scope `failed{child_failed}` (`:80`), 10 queued siblings cancelled via `node.execution_cancelled{reason:'on_child_failure_stop'}` (`:81, :83`), the 14 already-`succeeded` siblings preserved (`:82`); pass 10's FAIL there (0 such journal rows, `live10/C8.out:83`) is what `d8b927c` fixed. **fail_after_all**: all 25 children run, then the scope fails (`:92`) | pass 11 @ 9be68fd | live11/C8.out:78, :80-83, :90, :92 (pass-10 FAIL: live10/C8.out:83) |
| C8f | depth guard refuses self-invocation | PASS — the self-invoking pipeline is refused at validate with `child_depth_exceeded` (`:111`): `04f53fd`'s corrected document meeting `b977ee4`'s compiler guard, both confirmed live again. Two arms GAP: the leg's new 3-level chain never published — the l3 draft was refused by the schema (`schema_shape: got number, want string` at `/spec/nodes/0/config/in…`, `:105-:110`) — so the two-level "root completes" arm has no root (`:112`) and the third-level `runs_depth_check` arm has no depth-3 booking to refuse (`:113`). Driver fixture fix, rerun pending | pass 11 @ 9be68fd | live11/C8.out:111 (GAP arms: :112, :113; the fixture refusal: :105-110) |
| C8g | parent cancel cascades to every child | PASS — `run.cancel_requested{cascade:true}` journaled with the child ids, every child reached a terminal state (`cancelled`), the run ends `cancelled` with `cancelled_attempts[]` populated | pass 11 @ 9be68fd | live11/C8.out:123-125 (POST arm: :119) |
| C8h | detach cancel policy is refused at validate | PASS — `cancelPolicy: detach` refused `unsupported_policy` at `/spec/policies/cancelPolicy` | pass 11 @ 9be68fd | live11/C8.out:118 |
| C9a | gate waits as a row with zero attempts | PASS — `/approve` `waiting` with 0 attempts, `waiting_human`, no lease, seen by the ops counters and by both API replicas at the same version; the restart arm GAPped because a foreign run held a live lease (§ 7.0: disturb only what you created) | pass 4 @ 854b2ef | live4/C9.out:32-36, :46 (restart GAP: :40, :43) |
| C9b | non-approver refused, gate unmoved | PASS — bob: 403 `approval-denied`, `approval.denied{not_a_designated_approver}` journaled, version unmoved, still `waiting_human` | pass 4 @ 854b2ef | live4/C9.out:55-61 |
| C9c | approver removed from project cannot decide | PASS — alice after removal: 403, `approver_lost_access` journaled, no decision written | pass 4 @ 854b2ef | live4/C9.out:76-81 |
| C9d | two simultaneous decides, exactly one winner | PASS — one 200, loser 409 `approval_already_decided` carrying the winner's decision, one row, version 2 | pass 4 @ 854b2ef | live4/C9.out:94-97 |
| C9e | rejection is a business outcome, not an error | PASS — rejection accepted (200), `/approve` `succeeded`/`rejected`, no `error_class`, dependants skipped `condition_default`/`dependency_skipped`, run `completed`; the causal arm (skips *because* of the rejection) GAPs — the seeded graph gates nothing on `nodes.approve.outputs.decision` | pass 4 @ 854b2ef | live4/C9.out:100, :107-110 (causal GAP: :111) |
| C9f | on_timeout arms expire, re-request, cancel | GAP — only "the deadline is ARMED" PASSes; the § 7.0 seed authors `deadlineSeconds: 86400` and `on_timeout: fail`, so expire/cancel_run rows do not exist and pulling `deadline_at` forward by SQL would fake the clock | pass 4 @ 854b2ef | live4/C9.out:112-114 (armed arm: :39) |
| C9g | human takeover pauses and resumes the run | GAP — the C9 runs' attempts carry no `conversation_id` (the twin is `process.exec`), so `POST /conversations/{cid}/take-control` has no run conversation; this arm needs a live `agent.acp` turn, i.e. the permission-prompt limit below | pass 4 @ 854b2ef | live4/C9.out:132 |
| C10a | malformed reply fails as invalid_output | PASS — re-confirmed: the type-switched reviewer publishes as its own immutable revision (`:39`, the seed's revision untouched) and its attempt closes `status='failed' error_class='invalid_output'` — an EXECUTION error, not "not approved" (`:50, :51`), with `attempts.output_errors` carrying the JSON-Schema location (`entries=1`, `#/properties/evidence/type`, `:52`), NO `node.attempt.completed` for it (`:53`), and EVERY failed reviewer attempt carrying `invalid_output` — never `agent_error`, `infra`, or a business close (`:73`) | pass 17 @ 320c6fe | live17/C10.out:50-:53, :73 (publish: :39, the authored switch: :27-:30) |
| C10b | routing never changes during that failure | PASS — **FAIL → PASS, promoted by `04fb651`'s routing scope.** The unfalsifiable negative arm is dead: the leg watches the failing scope's `dependsOn` closure ("the failing scope and everything downstream of it", `watched=['/build_until_verified', '/publish_n…']`) and finds **no `condition_default` skip on any node the rejected reply could have routed** (`business skips on watched nodes=(none)`, `:68`), while **every other `condition_default` skip is one the run's own inputs explain** — `explained=["/emit_items: when='inputs.fanout …"]`, `unexplained=(none) unreadable=(none)` (`:69`). Pass 4's FAIL was exactly that pair counted against the claim (`live4/C10.out:58, :76`) — answered by scoping the assertion, not by weakening it. Everything else holds: the rejected attempt carries no outputs (`:54`), the reviewer node_execution's outputs stay NULL so the `approved:'yes' == true` coercion was never reachable (`:55`), the until scope never succeeded and its close is `child_failed`, not a business termination (`:65, :66`), the run never completed (`:67`), no iteration's review row reports `succeeded` (`:70`), the reply was retried within budget 2 (`:71, :72`) with the retry journaled as the `invalid_output` retry (`:74`). Two arms GAP, both honest limits: the scope row could not be sampled **mid**-failure (`:64`), and the shipped fixture has no valid-then-malformed mode, so the retry's success is unproducible (`:75`) | pass 17 @ 320c6fe | live17/C10.out:68, :69 (arms: :54, :55, :65-:67, :70-:72, :74; GAPs: :64, :75; the dead FAIL: live4/C10.out:58) |
| C10c | model.chat variant fails identically | GAP — unchanged in kind, re-measured: no `model.chat` node ran in this lab (`COMMUNICATION_MODEL_PROVIDER_BASE_URL configured=False`, `:78`), and ADR-0024 declares model.chat M4's first sacrifice, so the boundary-owns-the-guarantee claim stays unproven and is not satisfied by the `process.exec` arm | pass 17 @ 320c6fe | live17/C10.out:78 |
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
| W2 | live stream renders iterations, not duplicate nodes | PASS — 17 PASS / 0 FAIL / 2 GAP, and its **core mid-lease arm PASSes again**: the poll caught attempt `a65a8dec…` of `/build_until_verified[1]/implement` leased to worker-a (`:31`), so the page watched real in-flight work — journal panel rendered (`:29`), 21 samples of one document with no reload (`:74`), `run.created` → `node.attempt.started` → `run.checkpoint_saved` drawn in journal order (`:75-:79`), all 38 journalled run-vocabulary rows drawn at least once and never more often than written (`:81-:82`), and both `/build_until_verified[1]` and `[2]` under ONE stage cell for the loop (`:85-:89`). The two remaining GAPs are both `conversation.turn.*` on a `process.exec` twin that owns no ACP turn (`:77, :80`) — that arm additionally sits outside `M4_RUN_EVENT_TYPES`, so the Timeline tab drops it (`RunInspector.tsx:720`) | pass 11 @ 9be68fd | live11/W2.out:31 (rendering arms: :29, :74-82, :85-89; turn GAPs: :77, :80) |
| W3 | gate card: roles, countdown, approve, bob has no button | PASS — **21 PASS / 0 FAIL / 0 GAP** (`:55`) re-confirmed on pass 12's build: the run parks on a pending approval (`:26`) with roles + deadline exposed (`:27`), the control-plane card mounts with no attempt (`:37`), bob sees `approver_roles='maintainer'`, the countdown, the evidence list, NO Approve button and the not-a-designated-approver copy (`:30-:35`), alice's Approve click posts `/approvals/{id}/decide` (`:48`) and the card then reads decided (`:49-:52`). `4b4bfb8`'s schema fix plus `35a9acf`'s plan-card rendering are what unblocked it | pass 12 @ 5820aab | live12/W3.out:26-27, :31-35, :37, :38-42, :48-52 (summary: :55) |
| W4 | pinned-digest notice after a mid-run publish | PASS — the run page renders the pinned r1 digest before and after a live r2 publish, does not move onto r2, keeps "pinned r1" (not r2), and the notice "revision 2 published since this run started — this run is pinned to 1" renders. The leg exists since `d1bbcc3`, and the pinned-digest/notice copy it asserts is `3654c18`'s — both are already ancestors of pass 4's `854b2ef`, so neither is an unrun fix. Pass 4's crash was the exit stack not being up at all (`live4/_seed-W4.out:2 SEED FAIL stack not ready`) — an environment failure, not a leg failure; pass 5 is the rerun that measures it | pass 5 @ 42187e7 | live5/W4.out:30, :46-52 (pass-4 crash: live4/W4.out:23) |
| W5 | kill renders honest interrupted wording | PASS — **FAIL → PASS, promoted by `f010fe2`** (the run page lists every attempt and says "interrupted — the worker disappeared mid-node" with the retry time): 11 PASS / 0 FAIL / 0 GAP (`:60`). The run started (`:24`), alice signed in (`:26`), the page was open BEFORE the kill with status `running` (`:27`), the gate decided (`:30`), the worker was frozen and killed holding a live lease (`:45`) — and § 7.1's literal ask now renders: `node.attempt.interrupted` appears on screen as 'interrupted' (`:46`), the retry countdown is drawn from `scheduled_at` (`:49`), attempt 2 renders after the countdown (`:52`), 'resumed'/'restored'/'no data lost' appear nowhere in 17391 lines of rendered text (`:53`), no spinner remains at the terminal state (`:54`), console clean (`:55`) | pass 14 @ 87b8f08 (UI `f010fe2`) | live14/W5.out:46 (arms: :24, :26-:27, :30, :45, :49, :52-:55; summary :60) |
| W6 | cross-volume run says "prior edits lost" | FAIL — **GAP → FAIL: the loss is finally produced and classed, and what fails now is the operator-facing copy and control.** `efb82bd` + `320c6fe` + `04fb651` (worker-c on its own `/workspaces`) make the loss real: the throwaway `communication-m4-worker-c` starts (`:40`), takes the ENGINE's own retry (`:60` — attempt 2 on worker-c, "W6 graded the engine's own attempt 2, never a retry it posted itself"), and reads `error_class='workspace_lost'` (`:61`), with `workspace.recovery_lost{reason:volume_changed}` journalled (`:62`) and **zero** `node.attempt.retry_scheduled` rows carrying the loss — never auto-retried, ADR-0023 § 7 (`:64`). The browser half PASSes: the lost run's page opens on the node that lost its workspace (`:66`), says 'prior edits lost' / 'rerun required' (`:67`) and draws the `workspace_lost` chip (`:68`, 5 elements). Two FAILs remain, both named as fix-in-progress: the refusal's `detail` is the raw internal sentence rather than M3 W8's unchanged wording (`:63`, `workspace.recovery_lost/volume_changed: … (ADR-0023 § 7 — never retried automatically): postgres: run workspace volume`), and **a Retry control is offered ENABLED for a loss the engine refuses to retry** (`:71`, `1 retry control(s) offered ENABLED: [('Retry', False, …)]` while the on-screen copy says 'No automatic retry is offered'). Pass 16 catches the same leg one step earlier — `efb82bd` not in that build, so the loss read `error_class='infra'` and the classification itself FAILed (`live16/W6.out:63, :65`, its page arm GAPing at `:69`, summary `:72` 2 FAIL / 1 GAP) | pass 17 @ 320c6fe | live17/W6.out:63, :71 (PASS arms: :26, :28, :35, :40, :60-:62, :64-:68; summary :74 2 FAIL / 0 GAP; pass-16 build: live16/W6.out:63, :65, :69, :72) |
| W7 | ops page counters and per-worker load | PASS — 30/0/0: every counter, both per-worker load rows and the offline→restored arms render, and the arm that FAILed at pass 4 now PASSes — `queued_unbindable_runs` counts the affinity-bound run (`counter=1`) and the Ops page says 'waiting for its worker' in those words: `5ade2c5`'s fix confirmed live | pass 6 @ 382d42b | live6/W7.out:29-38, :51-52 (rerender arms: :53-62; restored: :71, :80) |
| W8 | validate panel renders located errors by source | PASS — all 7 `kind_not_implemented` rows render at their `/spec/nodes/N/kind` location naming M5/M6, the schema/loader/compiler findings render with source + hint, and the secret-literal finding renders redacted | pass 4 @ 854b2ef | live4/W8.out:40-53, :68-72, :87, :102, :119-120 |
| W9 | cross-project deep links 404 with zero leakage | PASS — outsider session gets 404 + not-found copy on run, `/nodes` and the SSE URL, SSE never opens, and no project name / node name / digest value appears in the DOM, console clean. Two arms GAP: the row names carol but § 7.1 C9d needs carol as an M4 maintainer, so the outsider is the seeded `erin`; and the `/approvals/{id}` deep link had no approval to link to | pass 4 @ 854b2ef | live4/W9.out:35, :43-44, :46-51 (GAPs: :26, :45) |
| W10 | stream continuity across a replica roll | PASS — **NOT RUN → PASS on its first live run** (`d91f4fc`/`74ea274`'s leg, finally executed): 15 PASS / 0 FAIL / 0 GAP (`:73`). The run exists (`:24`), alice signs in (`:29`), the journal panel renders before the reload (`:32`), the poll caught a real mid-lease attempt (`/build_until_verified[1]/review` leased to worker-a, `:49`), both API replicas answer again after `restart api-a` (`:43`), the app reloads mid-run and re-opens the stream (`:60`), the reconnect carries `?after=` (`:61`), the rendered timeline never shortens across either the reload or the roll (`:62`), frames keep arriving on the same document after the roll (tally (6,6) → (38,38), `:63`), the advancer-written types survive it (`:64`), all 38 journalled run-vocabulary rows draw at least once (`:65`) and none more often than written (`:66`), and no foreign project name (`:67`) or attempt id (`:68`) reaches the page | pass 14 @ 87b8f08 | live14/W10.out:49, :60-:68 (arms: :24, :29, :32, :43; summary :73) |
| W11 | child tree renders, internals absent from the DOM | PASS — **FAIL → PASS, promoted by `19175b3`** (child-run rows carry their status word): 11 PASS / 0 FAIL / 2 GAP (`:52`). The execution tab renders the `/fan_out` tree (`:33`) and § 7.1's own claim now holds — 25 of 25 child rows rendered with their own statuses, depth right for all, none naming a foreign child and **none carrying no status word** (`:36`, the FAIL at `live11/W11.out:36`), every child reachable in the DOM (`:37`), the node pane opens on `?node=…` with attempt copy (`:42`) and the correct crumb (`:44`), and no fencing token (`:47`), lease expiry (`:48`) or worker id (`:49`) appears anywhere. Two arms still GAP: the leg sampled no mid-lease attempt (`:27`), so the "attempt 1 interrupted + attempt 2 succeeded" pair had only `#1 succeeded` to read (`:43`) | pass 14 @ 87b8f08 (UI `19175b3`) | live14/W11.out:36 (PASS arms: :24, :26, :32-:33, :37, :42, :44, :47-:49; GAPs: :27, :43; summary :52) |

Totals: 85 items (74 § 7.1 sub-cases + 11 § 7.2 legs) — **PASS 68, FAIL 1, GAP 14, NOT RUN 2** (counted mechanically over the Verdict column above: 68 + 1 + 14 + 2 = 85). The single remaining FAIL is W6, and it is a copy/control bug, not a missing state (`live17/W6.out:63, :71`); C10b left the FAIL list at pass 17. The two NOT RUN rows (C3d, C11c) are a report line and an explicit deferral, not unmeasured legs.

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

Pass 10 (`b2bfe62`) ran C1 and C8. C8 came back **36 PASS / 1 FAIL / 6 GAP**: the gate now publishes its own
stop and fail_after_all parent revisions and asserts each mode (`live10/C8.out:78-:92`), which took C8e out of
its long GAP — but the stop arm FAILed there: 0 `node.execution_cancelled{reason:'on_child_failure_stop'}` rows
(`live10/C8.out:83`), **fixed in `d8b927c`** (queued siblings get cancelled rows plus the journal event) and
proven at pass 11. C8f's new 3-level chain never published, so its two depth arms GAP (`live10/C8.out:112-:113`).
C1 was 67 PASS / 2 FAIL: the agent arm still ended `failed`
(`node_execution_failed:/build_until_verified`, `live10/C1.out:67`) and took the cross-variant key-set arm with
it (`:189`).

Pass 11 (`9be68fd`) is the first pass with `13dd742`'s container resolver (compose service → real container
`…-worker-a-1`), i.e. the fix pass 9 called "in progress", and it moved six items: **C4c FAIL → PASS** — the
stale owner's refusal is finally *observed*, `docker logs communication-m4-worker-a-1 matched 2 lines`
(`live11/C4.out:54`), leaving only the `finished_at IS NULL` schema GAP (`:50`); **C5b PASS on C5's own leg**
(freeze proves the lease live at the signal and 3s later `:35`, then SIGKILL `:38`); **C5c and C5d re-PASS**
there (`:53-:56, :67-:69`); **C5g FAIL → PASS** — all 11 node keys check their own append rule and the killed
run completes after the checkpointed retry (`:91-:103`); **C8e GAP → PASS** with `d8b927c` proven live (10
siblings cancelled via `node.execution_cancelled{on_child_failure_stop}`, `live11/C8.out:81, :83`); and **W5 /
W6 GAP → FAIL** because the kills now land — W5 loses only § 7.1's literal interrupted wording
(`live11/W5.out:46`, **UI fix in progress**) and W6 died mid-leg on a driver `TypeError: show() missing 1
required positional argument: 'out'` (`live11/W6.out:35`, **fix in progress**). **W11 NOT RUN → FAIL** on its
first live run: the tree renders all 25 children and leaks no fencing token / lease / worker id
(`live11/W11.out:33, :37, :47-:49`), but every child row carries no status word (`:36`, **UI fix queued**).
C1 again read 67/2: the agent arm ended `failed cause=until_exhausted` (`live11/C1.out:73`) — the reviewer could
not see the plan the implementer published, fixed in `5820aab`. What did *not* move is the retry sequencing:
C5e (`live11/C5.out:72`), C6c/C6d/C6e (`live11/C6.out:61, :64, :67, :99-:112`) still FAIL because the retry
POSTs land after the reconciler has restarted the run, C6e's `recovery_lost` read still crashes on
`operator does not exist: uuid = text` (`live11/C6.out:101-:106`), and C6b still GAPs because the authored
`restore_checkpoint` never reaches the compiled plan (`live11/C6.out:39-:40, :72`) — every one of those is
superseded by passes 13–15 below (`f010fe2`/`19175b3` for the two UI fixes, `a06bd6a` for W6's crash, `12cb433`
for C5e, and the `uuid = text` read dead by pass 13).

Pass 12 (`5820aab`) reran C1 and W3 and is the milestone's turning point: **C1 98 PASS / 0 FAIL / 0 GAP**
(`live12/C1.out:210` summary). The agent arm — FAILing since pass 1 — reached `completed` (`live12/C1.out:28`)
after 2 iterations with `result_bindings.review_approved == true` (`:63`), a 128-row journal that opens with
`run.created` and closes with `run.completed` (`:66-:74`), and an SSE stream that saw the opening and closing
frames (128 frames, `:83`). That promotes **C1c FAIL → PASS**, completes **C1d** (the agent leg's own key-set
probe has never executed before, `:44-:46`), cleans **C1i**'s cross-variant arm (`:206-:207`) and leaves the
gate with no FAIL and no GAP at all. W3 re-confirmed **21 PASS / 0 FAIL / 0 GAP** on that build
(`live12/W3.out:55`).


Pass 13 (`a06bd6a`) stopped racing the reconciler: the fault legs now measure **the engine's own automatic
retry** after a kill instead of trying to beat it with a manual `POST /runs/{id}/retry`. That re-casts one
arm and one verdict. § 7.1's literal `POST -> 200` arm now **GAPs by contradiction** rather than FAILing —
C5b's own sentence keeps the run `running (retry armed)` when the budget survives, a running run is not
retriable, and with the shipped twin's `attempt_limit=2` the engine owns the retry (the driver reports the
contradiction instead of forcing it, `live13/C5.out:75`) — and the substance of C5e moved to the auto-retry
arms (`:76, :84-:87`). C5 came back **37 PASS / 1 FAIL / 4 GAP** (verdict lines; the summary at `:114` reads
`FAIL=1 GAP=4`, and the raw grep's 8 GAP lines are those four reprinted): the one FAIL is
`retry_context.head_commit = None` on the retry (`:88`), i.e. the automatic retry carried no checkpoint HEAD
to resume from, fixed in `12cb433` and proven at pass 15. C5f's HEAD read finally works (`:90-:92`, GAP →
PASS) and C5g keeps its 11-key append rule with the killed run completing (`:95-:107`). C6 came back
**16 PASS / 0 FAIL / 10 GAP** (`live13/C6.out:128`) — every C6 FAIL became a GAP as the driver stopped
grading the wrong refusal — and W6 finally ran its whole leg after `a06bd6a` killed its `show()` crash:
**4 PASS / 0 FAIL / 1 GAP** (`live13/W6.out:61`), the GAP being the loss case itself (`:51`).

Pass 14 (`87b8f08`, with the W5/W11 UI fixes held in the worktree during the run and committed as
`f010fe2`/`19175b3`) is the biggest single promotion pass since pass 6: **8 items moved**. **W5 FAIL →
PASS** (11/0/0, `live14/W5.out:60`) — the run page now renders 'interrupted — the worker disappeared
mid-node' with the retry time (`:46`); **W11 FAIL → PASS** (11/0/2, `live14/W11.out:52`) — all 25 child
rows carry their status word (`:36`); **W10 NOT RUN → PASS** on its first live run (15/0/0,
`live14/W10.out:73`), catching a real mid-lease attempt (`:49`) and holding the timeline whole across both
a reload and an api-replica roll (`:62-:63`), which takes the last never-executed browser leg off the
board. **C2c and C2d GAP/NOT-RUN → PASS** — the durable sweep ran over a genuinely held attempt (46s,
`live14/C2.out:48`) and found the sentinel on none of the six surfaces (`:50-:55`), and the reviewer
attempt materialized nothing at all (`:56-:57`) — while **C2a/C2b re-diagnosed**: no `process.exec` attempt
can ever be authorized to hold a secret, because secrets are agent-profile-keyed (ADR-0018 § D3), which is
why `599e4f9` switches C2 to the agent variant. C1 re-ran clean (**98 PASS / 0 FAIL / 0 GAP**,
`live14/C1.out:210`). In C6, **C6c/C6d/C6e all moved FAIL → GAP** — pass 11's "wrong 409" is now reported as
a contradiction (`:61`), the `operator does not exist: uuid = text` crash is gone, and the cross-volume loss
simply never materializes because the engine's automatic retry takes the node before the forced affinity
does (`:113`). C5 repeated pass 13 exactly (37 PASS / 1 FAIL / 4 GAP, `live14/C5.out:114`), the head_commit FAIL still there
(`:88`) because `12cb433` had not landed yet.

Pass 15 (`599e4f9`) promotes the two C5 items that `12cb433` was written for: **C5 38 PASS / 0 FAIL / 4
GAP** (verdict lines; the gate's own summary at `live15/C5.out:116` reads `FAIL=0 GAP=4`, and a raw grep's 8
GAP lines are those four reprinted) — `retry_context.head_commit` now equals the HEAD read before the kill
(`:90`, `retry_context='8dbabef3538f' before='8dbabef3538f'`), so **C5e FAIL → PASS** with the
checkpoint-resume claim proven on the automatic retry, and C5f holds (`:92-:94`). The 4 GAPs are the two
`retry_context` arms reported rather than forced (`:77, :91`), the C1 key-set comparison C5g cannot make
across gates (`:110`), and C5h's missing `maxAttempts: 1` node (`:113` — the scratch-pipeline arm that
authors one is in the driver's working tree, **not yet run live**). C1 is **98 PASS / 0 FAIL / 0 GAP** again
(`live15/C1.out:210`). `e2de8fa`/`5c03d6c` (worker-side `restore_checkpoint`, then wired) and `82902b4`
(the overview's SSE refetch storm, 962 → 22 requests) are in this build; **C6 and C2 were still running
when this file was written** and keep their pass-14/pass-13 verdicts until their `.out` files finish.
**M5 browser legs (not § 7 items, recorded for continuity).** `e2e/tests/m5-journey.spec.ts` ran
12 passed / 1 failed / 4 not run on the lab — the single failure is step 6, whose assumption (exit 1 is
a failure) is wrong for the engine, since exit 1 alone is a business outcome that completes the run;
fixed in `ef470a0`, rerun pending. `e2e/tests/m5-inbox.spec.ts` PASSED 6/6 live on the lab.

Pass 16 (`059d132`) re-ran C1, C5, C6 and W6. **C1 98 PASS / 0 FAIL / 0 GAP** again (`live16/C1.out:210`),
C5 came back **48 PASS / 0 FAIL / 8 GAP lines** (`live16/C5.out:159` reads `FAIL=0 GAP=4`; the raw grep's
eight GAP lines are those four reprinted) — the ten extra PASS lines over pass 15 are **C5h's scratch
`maxAttempts: 1` arm running live for the first time**: budget 1 authored (`live16/C5.out:149`), the killed
attempt `interrupted` (`:150`), the automatic retry refused (`:151`), the run `failed` honestly (`:152`), the
manual retry accepted and appended as attempt 2 (`:153, :154`) — while the leg's stale precondition still
prints its GAP at `:111`. C6 was **5 PASS / 0 FAIL / 2 GAP lines** with the leg stopping at C6b (`:89`), and
W6 read **9 PASS / 2 FAIL / 1 GAP**: `efb82bd`'s `workspace_lost` classification is not in this build, so the
loss read `error_class='infra'` and the classification arm itself FAILed (`live16/W6.out:63, :65`, GAP `:69`).

Pass 17 (`320c6fe` — `efb82bd`'s `workspace_lost` classing, `320c6fe`'s "a mid-turn ACP disconnect is infra,
not `invalid_output`", and `04fb651`'s driver: C2 grades one attempt's real process tree, C10b grades routing
against the failing scope's `dependsOn` closure with input-explained skips, worker-c gets its own
`/workspaces` so `volume_changed` is measurable) promotes **five items**: **C2a and C2b GAP → PASS**
(**C2 29 PASS / 0 FAIL / 0 GAP**, `live17/C2.out:82`) — the sentinel is found in exactly one live process,
the ACP adapter the authorized attempt launched (`:54, :55`), delivered as `env`/`DATABASE_URL` with no
`.env.test.local` (`:56, :57`), stamped with the attempt id (`:60`) and **unmounted by the worker at the node
boundary** (`cleaned_by='worker'`, `:63`), which is the state pass 14 said did not exist; **C2c**'s last GAP
arm is closed by the same switch (`:74-:79`); **C10b FAIL → PASS** (`live17/C10.out:68, :69`, gate 22 PASS /
0 FAIL / 6 GAP lines = 3 GAPs reprinted, `:118`); and **W6 GAP → FAIL** — the cross-volume loss is finally
produced and classed (`error_class='workspace_lost'`, `live17/W6.out:61`, `workspace.recovery_lost` journalled
`:62`, **no** auto-retry `:64`), so what is left is the raw refusal detail (`:63`) and an **enabled Retry
control** on a run the engine refuses to retry (`:71`), both with a fix in progress. C1 repeats clean
(`live17/C1.out:210`), C5 repeats pass 16 (`live17/C5.out:159`), and C6 repeats pass 16's stop at C6b
(`live17/C6.out:89`) — with the new finding that `5c03d6c`'s restore path now runs and **refuses** with
`checkpoint_unavailable: … its committed state is unrecorded` (`live17/_events-C6.txt` seqs 64, 67), killing
both attempts before any kill, which is what C6b still needs fixed. **One run-planning artifact is worth
naming once:** the `C5g`/`C6c` "no C1 key set in this pass" GAPs (`live17/C5.out:108`) are not lab limits —
each gate ran in its own driver process after its own reset + seed, so no C5/C6 pass can hold C1's key set;
carrying it across gates is a driver change.

## What blocks the M4 exit

Finding ids (`P*`, `D*`, `RC*`) are `docs/m4-live-findings.md` (written from pass 1); "fixed in
`<sha>`, not re-run" names a commit that landed after the pass behind the verdict.

**Product bugs — open**

- No longer open: **the real-Claude agent run reaches `completed`** — the failure that has chased C1c since
  pass 1 (`/plan` permission prompts → `invalid_output` → `node_execution_failed:/build_until_verified` on the
  third iteration → `until_exhausted`) is closed. `5820aab` made the review prompt approve on the goal, the
  criteria and *this iteration's* implement/test results (so the reviewer is no longer blind to what the
  implementer published), and pass 12 proves it live: the agent run `completed` (`live12/C1.out:28`) with
  `review_approved == true` (`:63`), a 128-row journal (`:66-:74`) and an SSE stream that
  saw both frames (`:83`) — **C1 98 PASS / 0 FAIL / 0 GAP** (`:210`). That promotes C1c, completes C1d's agent
  probe and cleans C1i's cross-variant arm. Re-run clean at pass 14 (`live14/C1.out:210`) and pass 15
  (`live15/C1.out:210`, 116-row agent journal at `live15/C1.out:66`).
- No longer open: **both UI copy bugs are fixed and proven live.** **W5** — the run page now renders § 7.1's
  `interrupted — the worker disappeared mid-node` line after a real kill (`live14/W5.out:46`, with the countdown
  `:49`, attempt 2 `:52` and the honesty rule `:53` all still rendering) — fixed in `f010fe2`; and **W11** — all
  25 fan-out child rows now carry their status word (`live14/W11.out:36`, where `live11/W11.out:36` reported
  none) — fixed in `19175b3`. Both were run on a `87b8f08` lab with the fixes held in the worktree, then
  committed.
- No longer open: **an automatic retry carries its checkpoint's HEAD.** `retry_context.head_commit` read
  `None` on the engine's own retry at pass 13 and pass 14 (`live13/C5.out:88`, `live14/C5.out:88`) because
  `repo_states` rows were written with Go field names and hydrated empty; `12cb433` writes and reads them
  with their wire keys and moves the retry context onto the automatic path, and pass 15 reads
  `retry_context='8dbabef3538f' before='8dbabef3538f'` (`live15/C5.out:90`) — **C5e FAIL → PASS**.
- **Closed at pass 17: a refused workspace recovery is classed a loss and never auto-retried.** `efb82bd`
  plus `04fb651`'s worker-c-on-its-own-`/workspaces` finally produce the state W6 and C6e name: the throwaway
  worker takes the engine's own retry and reads `error_class='workspace_lost'` (`live17/W6.out:61`),
  `workspace.recovery_lost{reason:volume_changed}` is journalled (`:62`), **zero** `node.attempt.retry_scheduled`
  rows carry the loss (`:64`), and the page's `workspace_lost` chip and 'prior edits lost' / 'rerun required'
  copy render (`:67, :68`). Pass 16 shows the same leg without `efb82bd` in its build: `error_class='infra'`
  and the classification FAILing (`live16/W6.out:63`). **What W6 still holds open** is two product bugs with
  a fix in progress: the operator-facing `detail` is the raw internal sentence instead of M3 W8's unchanged
  wording (`live17/W6.out:63`), and the page hands out an **enabled Retry control** for a loss the engine
  refuses to retry (`:71`) while its own copy says 'No automatic retry is offered'.
- No longer open as a product question: **C10b is PASS.** "routing never changes during that failure" was
  measured on a graph that skips `/emit_items` by design (`live4/C10.out:58, :76`); `04fb651` scopes the
  assertion to the failing scope's `dependsOn` closure and explains every skip outside it from the run's own
  inputs, and pass 17 proves it — `(none)` route changes on watched nodes (`live17/C10.out:68`),
  `unexplained=(none) unreadable=(none)` beyond them (`:69`). **No scripted § 7.1 item is open as a product
  bug any more**; the single FAIL left is W6's copy/control pair above.
- **No longer open: the retry 500 is dead** — pass 8's `POST /runs/{id}/retry` → **500** `about:blank`
  (`live8/C6.out:61-62, :66`) is fixed in `13b81fb` (ADR-0037): a retry naming a node execution the run
  lacks now answers **404** `node-execution-not-found`. Pass 9 never reached that arm — its retries read
  409 `run-not-retriable` because the run was already `running` (or, by C6e, `completed`) again
  (`live9/C6.out:60, :67, :99-100`), which is the driver-sequencing bug below rather than a product
  defect. No product retry bug is currently open; C5e/C6c/C6d/C6e stay FAIL on the driver side.
- C8 is closed as a product question — pass 11 re-ran the gate and it came back **38 PASS / 0 FAIL / 2 GAP**
  (`live11/C8.out:128`), improving on pass 7's 31/0/2 (`live7/C8.out:91`). `21656f6`'s children are proven end to
  end: 25 invoke rows, 25 `pipeline_invocations`, depth 1, 25 `child_run_id`s in `outputs.children`, 25 distinct
  `/tree` children (`live11/C8.out:48-50, :53-:54, :60-:68`), the cancel cascade works (C8g `:123-:125`) and
  `b977ee4`'s `child_depth_exceeded` guard fires live (C8f `:111`). **C8e's long GAP is closed** — `b2bfe62`
  publishes a parent revision per child policy instead of asking an immutable one for a mode it never authored,
  and `d8b927c` makes the stop mode cancel its queued siblings with `node.execution_cancelled{on_child_failure_stop}`
  (10 cancelled rows, `live11/C8.out:81, :83`; pass 10's FAIL at `live10/C8.out:83` is what that commit fixed).
  The two GAPs that remain are C8f's unpublished depth chain (`:112, :113` — a driver fixture bug, not the guard).
- No longer blocking: **W7 is dead** — `5ade2c5` counts runs whose ready attempt cannot be bound, and
  pass 6 reads `queued_unbindable_runs=1` for the affinity-bound run with the Ops page saying
  'waiting for its worker' in those words (`live6/W7.out:51-52`, W7 PASS 30/0). C12b (`e0ee333` named
  the cap failure) and C12c (`554092a`'s corrected probe) both
  PASS at pass 5 (`live5/C12.out:72`, `:102`); RC1/P1's double `attempt_count` is dead — C1e reads
  `attempt_count = 1` live at `live5/C1.out:85` (`0a0e6bb`), so C5e's retry-from-checkpoint row is
  reachable once C5a gets a live attempt; and P2 (the inert scheduler flag) died in `9af17dc`, already an
  ancestor of pass 4's lab, which is why C14c's GAP changed wording rather than staying a `FAIL`.

**Driver bugs — open (the probes are broken, not the product)**

- ~~C1f~~ and ~~C1h~~ PASS at pass 6 (`dfff98e`'s fixes re-confirmed live at passes 9 and 12,
  `live12/C1.out:54-:59; :66-:74, :82-:83`) — on pass 12 they PASS on the **agent** leg too, which had never
  reached them `dfff98e` fixed the 7-field parse of the 8-column artifact row
  and replaced the fixed-order milestone-chain conjunct with an in-order-subsequence match
  (`live6/C1.out:82-84, :87`; `:94-102, :110`).
- ~~C4a / C4b / C4d~~ PASS again at pass 11 (`live11/C4.out:32, :41-:44, :63-:65`) on the re-run fence, having
  first PASSed at pass 8 and pass 9 — `cefe995`'s `hold_seconds` input, driven by `522a82b` and proven-before-
  faulting since `1e75c23`, held the twin open and the fence landed on a live lease
  (`node.attempt.interrupted{lease_expired,system}` + `node.attempt.retry_scheduled`, `live11/C4.out:38-:44`) and
  the replacement attempt succeeded with "ownership moved, no process died" (`:64`). C4c left this list at pass
  11 — the observation arm is now real (`:54`) and only the `finished_at IS NULL` schema GAP (`:50`) remains.
- ~~The remaining fault-injection legs pick the wrong attempt~~ — **fixed in `1e75c23` and proven live at
  pass 9**: C5's kill pick, C6's kill and W2's mid-lease sample all name `/build_until_verified[1]/implement`
  (`live9/C5.out:29`, `live9/C6.out:43`, `live9/W2.out:31`) — no more pre-gate `/plan` deaths — and W2, W3,
  C5b and C1e moved on the strength of it.
- ~~**New, open: raw `docker` calls address compose's PREFIX, not the container.**~~ **Fixed in `13dd742` and
  proven live at pass 11** — this is what moved C4c, C5b, C5c, C5d, C5g, W5 and W6. The lab's containers are
  `communication-m4-worker-a-1` / `…-worker-b-1`, while the legs named the compose PREFIX
  `communication-m4-worker-a`, so the command read or killed nothing: C4c's stale-owner log arm matched 0 lines
  (`live9/C4.out:53-:55`) even though `ef33f8d` makes the worker log the refusal once per attempt; C5's SIGSTOP
  answered `No such container` (`live9/C5.out:34`); W5 and W6 refused to kill anything at all because § 7.0 only
  lets them kill a container they can prove belongs to the project (`live9/W5.out:31`, `live9/W6.out:29-:31`).
  The rule and the resolver live at `e2e/m4/e2e_m4_exit.py`, guarded offline by
  `e2e/m4/test_container_names_logic.py`. Pass 11 observes `docker logs communication-m4-worker-a-1` matching
  **2 lines** (`live11/C4.out:54`), freezes and kills `communication-m4-worker-a-1` with the lease proved live at
  the signal (`live11/C5.out:34-:38`), and kills the same container in W5 and W6 (`live11/W5.out:35-:45`,
  `live11/W6.out:29-:32`).
- ~~**The fault legs name the right container but crash on their own helper.**~~ **Fixed in `a06bd6a` and
  proven live at pass 13**: W6's `TypeError: show() missing 1 required positional argument: 'out'`
  (`live11/W6.out:35`) is gone, the leg runs to its last line and the worker-c throwaway comes up
  (`live13/W6.out:40`). W6 is now a GAP on the substance (below), not a crash.
- **Still open: C8f's depth-chain fixture does not publish.** The leg builds a real l1→l2→l3 chain, but the l3
  draft is refused by the schema (`schema_shape: got number, want string` at `/spec/nodes/0/config/…`,
  `live11/C8.out:105-:108`), so `l3: draft/publish gave no revision` (`:110`) and the two arms that need a live
  chain — the two-level root completing, and the third level refused by `runs_depth_check` — have nothing to
  measure (`:112, :113`). Fixture fix, rerun pending; the `child_depth_exceeded` guard itself still PASSes (`:111`).
- ~~**Still open: the retry POSTs race the reconciler.**~~ **Re-cast in `a06bd6a`, and mostly closed**: the
  legs no longer race the reconciler — they measure the engine's **automatic** retry and report § 7.1's manual
  `POST -> 200` arm as a contradiction instead of forcing it (`live13/C5.out:75`, `live15/C5.out:77`); C6d's
  wrong-409 is reported rather than graded (`live14/C6.out:61`); C6c/C6e no longer FAIL on it; and C6e's
  `operator does not exist: uuid = text` read crash is dead. What stays open in this family is the
  **cross-volume loss**: the automatic retry takes the node before the forced affinity can leave a workspace
  behind, so C6e/W6 have no `error_class='workspace_lost'` attempt to read (`live13/W6.out:51`,
  `live14/C6.out:113`). **Closed at pass 17** — `599e4f9`'s helpers are wired, `04fb651` gives worker-c its
  own `/workspaces` so `volume_changed` is measurable, and `efb82bd` classes the refusal: W6 reads
  `error_class='workspace_lost'` on the engine's own attempt 2 (`live17/W6.out:61`) with zero loss-carrying
  `retry_scheduled` rows (`:64`). C6e stays unmeasured only because its own gate never reaches it: the C6 leg
  stops at C6b's GAP (`live17/C6.out:89`). C5e's `retry_context.modified_path_count` is a fixture limit
  rather than a race: the shipped twin sleeps BEFORE it edits, so the killed node had written nothing
  (`live17/C5.out:89`).
- ~~C1e's stale input count~~ — **fixed in `1e75c23` and PASS at pass 9**: the arm scores `run_inputs`
  against what the pinned revision DECLARES, so `hold_seconds=default` is one of the six rather than an
  extra row (`live9/C1.out:91, :152`).
- C3a/C3c `live6/C3.out:29, :38` — unchanged (C3 did not run at pass 7 or 8): the leg still does not
  consume C8's 25-attempt queue, and no `/implement` row carries a worker_id to count claims over.
- ~~C10b's routing assertion~~ — **fixed in `04fb651` and PASS at pass 17**: "no
  `node.execution_skipped{reason:'condition_default'}` may appear" was unsatisfiable on the seeded graph,
  which skips `/emit_items` on `inputs.fanout` by design (`live4/C10.out:58, :76`; C9e counts the same pair at
  `live4/C9.out:109`). The leg now watches the failing scope's `dependsOn` closure (`live17/C10.out:68`) and
  requires every other skip to be explained by the run's own inputs (`:69`) — the same evidence, scoped so it
  can actually be falsified.
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

- ~~C1c `live9/C1.out:70` and the cross-variant key set `live9/C1.out:192`~~ — **closed at pass 12, and it was
  never this design limit.** The agent leg reaches terminal `completed` (`live12/C1.out:28`) with
  `review_approved == true` (`:63`), 2 iterations (`:64`), a 128-row journal (`:66-:74`) and SSE open+close
  (`:83`), and the cross-variant key set now PASSes (`live12/C1.out:206-:207`). The trail through passes 8–11 —
  `4b4bfb8`'s schema fix letting `/plan` succeed, then iteration 3's `review` (`node_execution_failed`,
  `live10/C1.out:67`) and finally `failed cause=until_exhausted` (`live11/C1.out:73`) — was the reviewer being
  blind to the plan and this iteration's results, fixed in `5820aab`; `ask_unattended` was not involved (the
  ADR-0016 permission trail printed nothing, `live9/C1.out:69`). The `ask_unattended` trail below predates the
  ADR-0036 flip and stands for C9g/C11.
- ~~W3 `live6/W3.out:53`~~ — **PASS at pass 9 (21/0/0, `live9/W3.out:55`) and re-confirmed at pass 12 (21/0/0,
  `live12/W3.out:55`)**: the leg parks its run on a real pending gate off a real Claude plan and the card renders
  for both users (`:26-:52`). It left this group for good.
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

- ~~C2a, C2b, C2c, C2d~~ — **all four left this group at pass 17.** C2c/C2d left it at pass 14 (the sweep
  running while a worker really holds the attempt, `live14/C2.out:48`); what kept C2a/C2b GAPing was
  structural — **no `process.exec` attempt can ever be authorized to hold a secret**, secrets being keyed to
  the agent profile (ADR-0018 § D3). `599e4f9`'s variant switch plus `04fb651`'s process-tree probe measure
  it live: one live holder, the ACP adapter the attempt launched (`live17/C2.out:54, :55`), `env`/
  `DATABASE_URL` delivery with no `.env.test.local` (`:56, :57`), the row stamped with its attempt and
  `cleaned_by='worker'` at the boundary (`:60, :63`), and the agent `conversation_turns` rows now present for
  the sweep to read (`:74-:79`). C2 is **29 PASS / 0 FAIL / 0 GAP** (`:82`); the only C2 claim left standing
  behind the egress design limit above is none of the four.
- C6b/C6c/C6d/C6e — the restore arm moved from "the policy never reaches the plan" to "the wired restore
  refuses for want of a recorded boundary". Passes 16–17 show `e2de8fa`+`5c03d6c`+`c652f43` in a build that
  runs them: both `/build_until_verified[1]/implement` attempts of the `restore_checkpoint` twin die with
  `checkpoint_unavailable: ADR-0023 § 6 allows restore_checkpoint only when every repository in the run is at
  a committed state at the last completed boundary … repository 01a14693-866c-7a5e… was not captured at the
  boundary: its committed state is unrecorded` (`live17/_events-C6.txt` seqs 64, 67), the run reaches `failed`
  (`live17/C6.out:51`), and with nothing leased at the target the leg GAPs (`:89`, "the target node was simply
  never leased", hold honoured `:87-:88`). So the § 6 refusal rule is proven live and the reset itself is
  still unmeasured; the precondition underneath is the `run_checkpoints.repo_states` story (`12cb433` wrote
  the wire keys, but nothing captures a committed state for the repository at this boundary), and C6c/C6d/C6e
  ride behind it — none of them was reached in passes 16–17, so their verdicts are still pass 14's
  (`live14/C6.out:83, :60, :113`).
- ~~W5 `live9/W5.out:31`, W6 `live9/W6.out:29-31`~~ — W5 left this group for good at **pass 14**: the kill
  lands and § 7.1's interrupted wording renders (`live14/W5.out:46`, `f010fe2`). **W6 left this group at pass
  17 as a FAIL, not a PASS** — the state exists now (`error_class='workspace_lost'`, `live17/W6.out:61`; chip
  and copy rendering `:67, :68`), so the leg grades product copy and a control instead (`:63, :71`).
  W2 left this group at pass 9 and holds: its mid-lease core arm PASSes again (`live11/W2.out:31`) and its two
  remaining `conversation.turn.*` GAPs (`:77, :80`) are fixture shape — a `process.exec` twin owns no ACP turn,
  and `conversation.*` sits outside `M4_RUN_EVENT_TYPES` (`RunInspector.tsx:720`, ADR-0014 § 8).
- C3a `live6/C3.out:29` — C8's queue exists and is proven (`21656f6` + `04f53fd`: 25 invoke rows at
  `live11/C8.out:48-50`), but the C3 leg still does not consume it ("C8 prints SKIP" in its own text);
  C3c `live6/C3.out:38` — no `/implement` attempt row carries a worker_id (the <1s twin race C4's leg
  has since been fixed around, so both are re-testable with `hold_seconds`). Both are test setup, rerun
  pending — C3 has not run since pass 6.
- ~~C5f~~ left this group at **pass 13/15** — HEAD is readable across the restart again and does not move
  (`live15/C5.out:92-:94`, PASS, re-proven `live17/C5.out:90-:92`). **C5h is a different animal now**: the
  scratch pipeline that authors a `maxAttempts: 1` held node is committed (`059d132`) and ran live at passes
  16–17, every arm of the § 7.1 claim PASSing — budget 1 (`live17/C5.out:149`), attempt `interrupted` (`:150`),
  the automatic retry refused with zero `retry_scheduled` rows (`:151`), the run `failed | node_execution_failed:/implement`
  (`:152`), the manual retry accepted (`:153`) and appended as attempt 2 (`:154`). The row still counts as a GAP
  only because the leg prints its **stale precondition** first ("the killed node is authored with
  attempt_limit=2 in the § 7.0 twin", `:111`) and the gate summary counts it (`:159` `GAP=4`) — drop that line
  and C5h promotes. The same pass-planning artifact is behind the `C5g`/`C6c` "no C1 key set in this pass"
  GAPs (`live17/C5.out:108`): each gate runs in its own driver process after its own reset + seed, so nothing
  downstream of C1 can hold C1's key set until the driver carries it across gates. C4e `live11/C4.out:65`
  still GAPs (the fenced attempt is `/plan`, `turn_id` NULL) with `2f0fe1f`'s agent.acp rewrite **never
  re-run**; C6d's uncommitted-boundary precondition `live14/C6.out:57` still GAPs. C8 is
  now **38 PASS / 0 FAIL / 2 GAP** (`live11/C8.out:128`): C8e's stop/fail_after_all GAP is closed (`:78-:92`,
  `b2bfe62` + `d8b927c`) and the two that remain are C8f's unpublished depth chain (`:112, :113`, fixture bug
  above).
- C7b's artifact arm `live4/C7.out:59` (no artifact rows on the exhausted run), C7a's scope-iterations
  row `:70`, C7c's eval-time arm `:124` (the schema refuses the undeclared field first, so the
  `predicate_error` half is only proven offline), C7d's transcript half `:77` (a `process.exec` twin has
  no prompt to echo `previous`).
- C9f `live4/C9.out:112-114` — the seed authors `deadlineSeconds: 86400` and `on_timeout: fail`, so
  expire / re-request / cancel_run rows cannot exist without publishing a short-deadline revision, and
  pulling `deadline_at` forward by SQL would fake the clock (§ 7.0 keeps SQL as evidence only).
- C10b's two GAP arms `live17/C10.out:64` (no **mid**-failure sample of the until scope's routing) and `:75`
  ("retry answers validly the second time") — the shipped fixture helper cannot answer malformed-then-valid and
  `make_fixture_repo.sh` must not be edited; C10c `:78` — no model.chat provider endpoint (ADR-0024's first
  sacrifice). The item's core claim PASSed at pass 17.
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

**Browser legs — all eleven have now run live**

`w1`, `w3`, `w4`, `w7`, `w8` and `w9` are implemented Playwright legs that ran early, pass 8
added W2, W5 and W6 to that list, pass 9 re-ran all three (W2 **PASS**, W5/W6 GAP on the
container-name bug), pass 11 re-ran them on the resolver (W2 **PASS**; W5 and W6 then **FAIL**, and **W11**
ran live for the first time — FAIL on its child status word, `live11/W11.out:36`), and **pass 14 ran W10 live
for the first time** — 15 PASS / 0 FAIL / 0 GAP (`live14/W10.out:73`), catching a real mid-lease attempt
(`:49`) and holding the timeline whole across a reload and an api-replica roll (`:62-:63`). The last
never-executed leg is off the board: **no § 7.2 row is NOT RUN any more**, with W5 (`f010fe2`, `live14/W5.out:46`)
and W11 (`19175b3`, `live14/W11.out:36`) turned to PASS. **Pass 17 moved W6 from GAP to FAIL** —
`efb82bd`+`04fb651` finally produce the cross-volume loss and class it (`live17/W6.out:61, :62, :64`), the page's
chip and loss copy render (`:67, :68`), and the two FAILs are the raw refusal detail (`:63`) and an enabled Retry
control on a run that must not be retried (`:71`), with the fix in progress. W11's scripted precondition stays
proven: C8's tree renders 25 distinct children at
`live11/C8.out:64-68`. W6's scripted substitute (C6e) is still blocked behind C6b's recorded-boundary GAP
named above.
