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
| pass 18 | `live18/` | `cc0bff8` | C1, C5, C6 — now one combined `.out` (`C1,C5,C6.out`, 166 PASS / 7 FAIL / 6 GAP) — and **C4** (**C4 32 PASS / 0 FAIL / 4 GAP lines** = 32 verdicts + the gate's own `GAP=2` reprinted at `:102, :103`; **C4e's `agent.acp` arm ran live for the first time**) |
| pass 19 | `live19/` | `2b24738` (W6's UI fix held in the worktree — `AttemptDetail.tsx`/`RunInspector.tsx` + their tests — and committed after the pass as `6e57274`) | C1, C5, C6 (175/4/6), **C3** (**C3 33 PASS / 0 FAIL / 2 GAP lines** — its 25-child queue finally built, `13dd742`-era driver: `6f06bb0`+`2b24738`), **C9** (**C9 89 PASS / 2 FAIL / 14 GAP lines** — C9f's deadline arms and C9g's takeover ran live for the first time, `817fcd0`; both FAILs fixed in `fc8b464` after this build), **W6** (**W6 14 PASS / 0 FAIL / 0 GAP**, `:74`) |
| pass 20 | `live20/` | `3f35115` (restore fixes `20c079b`/`3f35115`, `8cc0cf2`'s `process.exec` boundary capture, `14e8ff5`'s gate re-arm, `fc8b464`, `6e57274`) | C1, C5, C6 (**179 PASS / 0 FAIL / 6 GAP** — C5/C6's key sets compared against C1's own in-gate set), **C13** (**C13 47 PASS / 0 FAIL / 1 GAP** — `28d25ba`'s C13f ops-page browser arm ran) |
| pass 21 | `live21/` | `6ddd576` (contains `fc8b464`'s cancel_run journal row and `6ddd576`'s takeover stamping `attempts.cancel_requested_at` so the worker sends ACP `session/cancel`) | **C9 rerun** (**C9 91 PASS / 0 FAIL / 16 GAP lines** = 8 verdicts + the gate's own `GAP=8` reprinted at `:294-:301`; **both pass-19 FAILs are gone**: `run.cancel_requested` journalled first `:199`, the takeover's cancel reaching its honest terminal `:287`) |
| pass 22 | `live22/` | `cc52e9a`, lab brought up with api-b's scheduler off | **C14 rerun** after 18 passes dormant (**C14 21 PASS / 0 FAIL / 6 GAP lines** = 3 verdicts + 3 reprints at `:75-:77`) — C14a/C14b re-confirmed; **C14c still GAPs only because the env probe's log parser missed compose's `api-b-1` instance prefix and read both replicas as `on`** (`:71`) — fixed in `555eed0` |
| pass 23 | `live23/` | `555eed0`, lab brought up with api-b's scheduler off | **C14 rerun** (**C14 28 PASS / 0 FAIL / 4 GAP lines** = 2 verdicts + 2 reprints at `:102-:103`; **C14c GAP → PASS** at `:81-:97`: api-a stopped, api-b serves reads, a run POSTed to api-b stays `queued` ×6, api-a picks it up → `waiting_human`) |
| pass 24 | `live24/` | `d9928d9` (ADR-0038: the publish 422 for a recorded secret finding carries `code=secret_literal_detected`, documented in OpenAPI) | **C13 rerun** (**C13 48 PASS / 0 FAIL / 0 GAP** — `:156`; **C13c's sub-arm GAP `422 code=None` → PASS** — the secret finding itself now reads as what blocked publish, `:86-:89`) |
| pass 25 | `live25/` | `fa0c0e0` | C1, C5, C6 in one process (**182 PASS / 0 FAIL / 16 GAP lines** — **C6d GAP → PASS**: the new dirty-boundary scratch pipeline, driven by the opt-in `leave_dirty` fixture input, makes the state § 7.1 names and the 409 finally carries `code=checkpoint_unavailable`), C3 + C4 (**70 PASS / 0 FAIL / 8 GAP lines** — **C3d NOT RUN → PASS**: the negative-control sentence graded on all four arms, its last arm regraded once C4 printed), C1, C2, C7, C8, C10, C12, C13, C14, C11 in one process (**324 PASS / 1 FAIL / 36 GAP lines** — **C11c NOT RUN → PASS**: every structural claim graded from the gates that measure it in the same process; the single FAIL is C1g's agent-iteration bound, an over-claim corrected in `90a29c2`) |
| pass 26 | `live26/` | `76a9e64` (contains `e83913a`'s attempt mirror grants and `90a29c2`'s C1g bound correction) | **C1 rerun** (**C1 98 PASS / 0 FAIL / 0 GAP** — `live26/C1.out:211`; **C1g PASS on the new 1..4 agent bound** at `:64` with the agent's count on the NOTE line `:65`, and the agent can run git in its own worktree now: `live26/_events-C1.txt` carries ZERO `not a git repository` / `worktree link` / `backing repo` strings where live25 carried them, and the reviewer's own messages cite a `git diff` against HEAD (`:14, :16`)) |
| pass 27 | `live27/` | `1b93069` (contains `a0fd9e7` + `1b93069`: `deny` and `preapproved_within_sandbox` put `claude-agent-acp` in the launcher's prompting mode, in attempts AND conversations) | **C1 + C2 in one process** (**127 PASS / 0 FAIL / 0 GAP** = C1's 98 (`:7-:209`) + C2's 29 (`:210-:278`); summary `live27/C1,C2.out:280`) — and the ADR-0036 condition (a) gap closed in the lab journal read after the pass: `conversation.permission.requested` **23**, `conversation.permission.decided` **23** (every row `status=decided`, `decided_by=node_policy:preapproved_within_sandbox`) against **31** `conversation.tool.call` rows. The same query on live25 read **0** permission rows against 34 tool calls (`docs/design/attempt-permissions.md` § "Why attempts journal no verdict") |
| pass 28 | `live28/` | `7e6eda3` | **C1 rerun — crashed in the driver, no verdict recorded:** the new C1j journal query died mid-gate — `live28/C1.out:84` `ERROR: operator does not exist: text ->> unknown` (in Postgres `||` binds tighter than `->>`, so the un-parenthesised join is a syntax-level bug in the check itself, not in the product) — after **30 PASS** lines; fixed in `c11d01f` and re-run at pass 29 |
| pass 29 | `live29/` | `d4cd945` (contains `c11d01f`'s C1j parenthesisation fix) | **C1 rerun** (**C1 101 PASS / 0 FAIL / 0 GAP** — `grep -c '^  PASS' live29/C1.out` = 101, summary `live29/C1.out:228` `FAIL=0 GAP=0`; **C1j measured live for the first time**: all four arms PASS at `live29/C1.out:97-:100` — **8** permission requests / **8** decisions, every decided row `status=decided` with `decided_by=node_policy:preapproved_within_sandbox`, none unanswered, none doubled, no orphans) |
| pass 30 | `live30/` | `c1c7c19` (conversation deny prompts closed `cancelled` by policy; preapproved conversations back to the harness's auto mode) | **deny probe** (`docs/compatibility/probes/m4/deny_probe.sh`, added in `14b110f`) — `live30/deny_probe.out`: a live `deny`-profile conversation, **every verdict PASS** — `1 requested / 1 decided (cancelled) / 0 allow / 0 preapproved` and `deny-probe.txt` in no workspace: deny is enforced on the conversation path. **Correction (pass 32):** that filesystem check was vacuous — the conversation workspace is released at turn end (the journal carries a `workspace.released` row for the conversation, so `/workspaces/conversation/<id>/` no longer exists) — and the journal shows the write ended `failed` with "User refused permission to run tool"; re-measured at pass 32 with the journal verdict, `live32/policy_probe3-deny.out`, every verdict PASS |
| pass 31 | `live31/` | `c9b0a49` (the final M4 build — contains every fix through pass 30: `e83913a`'s mirror grants, `a0fd9e7`/`1b93069`/`c1c7c19`'s permission modes, `90a29c2`'s C1g bound, `7e6eda3`/`c11d01f`'s C1j) | **full regression sweep on the final M4 build: every gate group, 0 FAIL** — four driver processes, all rc=0: C1, C5, C6 (**186 PASS / 0 FAIL / 16 GAP lines** — summary `live31/C1,C5,C6.out:525` `FAIL=0 GAP=8`), C3, C4 (**70 PASS / 0 FAIL / 8 GAP lines** — `:193`), C1, C2, C7, C8, C10, C12, C13, C14, C11 (**329 PASS / 0 FAIL / 36 GAP lines** — `:1044`), C9 (**92 PASS / 0 FAIL / 14 GAP lines** — `:257`): 677 PASS / 0 FAIL across the sweep, and every GAP line is a row-named arm re-emitted (the C9 group, dormant since pass 21, re-emits the C9a/C9e/C9f/C9 arms recorded at passes 19/21) |
| pass 33 | `live33/` | `1c1733b` | **M5 browser suite, outside the gate driver — 50 passed / 0 failed / 1 deliberate skip** (`live33/m5-suite.out`): m5-inbox **6**, m5-agents-schedules **3**, m5-layout **20**, m5-journey **10 passed + 1 skipped** (the deliberate rejected-gate fixme), plus two new specs: m5-issue-run **5** (`4a72d31`: a live GitHub issue is clicked, the prefilled `goal`/`issue_number`/`issue_url` are required to reach `POST /runs` and land in `run_inputs`) and m5-prompt-edit **6** (`1879714`: an `agent.acp` step's `prompt` is edited through the step form, saved, validated and published; the digests move and the served YAML carries the new prompt). The W4 spec found a product bug fixed in `1c1733b`: a valid draft's validate response omitted `revision_digest`/`plan_digest`, which the OpenAPI `ValidateResponse` requires |
| pass 34 | `live34/` | `cf01a11` | **C10 first runs C10c's model.chat arm live** (28 PASS / 1 FAIL / 6 GAP lines, `live34/C10.out:147`): the owner allowed the lab to use the LLM collective (`qwen3-8-27b`) for the assistant + model.chat env on 2026-10-17 — the lab's collective wiring is an uncommitted, owner-approved lab-only compose override; no key is in the repo. The arm FAILed on the product, not the model: the worker refused the node's own `temperature: 0` — `config.temperature must be a number between 0 and 2` (`live34/C10.out:100`) — an int64-vs-float64 loader bug, **fixed in `3905f39`** | 
| pass 35 | `live35/` | `3905f39` | **C10** (26 PASS / 1 FAIL / 4 GAP lines): the model.chat attempt closed `interrupted` (`live35/C10.out:98`) — the store refused the completion "completed without a checkpoint volume" because the model.chat node captured no boundary; every successful model.chat step in a workspace run was lost until **`269de46`** made model.chat capture its node boundary like `process.exec` |
| pass 36 | `live36/` | `269de46` | **C10** (31 PASS / 0 FAIL / 4 GAP lines): the attempt now fails `invalid_output` — but the refusal is of the model.chat **envelope**, not the reply: the reviewer schema was graded at `/`, `missing properties 'approved', 'evidence'` (`live36/C10.out:101`). The driver is redesigned in `cabade3`: permissive `responseSchema`, envelope outputs, the `/json` location rule, and a valid-reply control |
| pass 37 | `live37/` | `cabade3` | **C10** (29 PASS / 1 FAIL / 8 GAP lines): the control failed `invalid_output`, `missing property 'json'` (`live37/_events-C10.txt:10`) — the compiler **dropped `config.responseSchema` from the compiled plan**, so no model.chat node ever validated or parsed its reply (`outputs.json` never existed); **fixed in `330af07`** |
| pass 38 | `live38/` | `330af07` | **C10** (29 PASS / 1 FAIL / 8 GAP lines): the control now fails on **infra** — the collective refuses a constrained `response_format` (http 400 `response_format_not_supported`, `live38/_events-C10.txt:10`); **fixed in `1b872b8`** (validate the completion locally only; ADR-0024 note appended) |
| pass 39 | `live39/` | `1b872b8` | **C10 36 PASS / 0 FAIL** (`live39/C10.out:157` `FAIL=0`) — **C10c all PASS**: the instructed malformed reply `{"approved": "yes", "evidence": 42}` is refused `invalid_output` at `/json/approved, /json/evidence` with NO `node.attempt.completed` (`:110-:114`), and the valid control reply succeeded with `outputs.json.approved == true` (`:115-:116`). **C10c GAP → PASS after four product fixes** (`3905f39`, `269de46`, `330af07`, `1b872b8`) |

**M5 browser journeys are recorded here too, but they are not § 7 items** and ran outside the gate
driver: `e2e/tests/m5-journey.spec.ts` 10 passed / 0 failed / 1 fixme live on `14e8ff5` (the expired-gate
retry fixme became a real test in `6eafa45`) — see “M5 browser legs” below.

From pass 18 the driver runs C1, C5 and C6 as ONE group writing a single `C1,C5,C6.out` (`2b24738`/
`925c692` carry C1's key set into C5g's and C6c's comparisons), so those three verdicts share a seed and a
stack state; every other gate still gets its own reset + seed.

A fresh lab reset + seed ran before EACH gate of passes 4–20 (`_seed-<GATE>.out` is that gate's seed
manifest and `_build.out` the lab commit it was built from), so no pass-4/…/20 verdict inherits another
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
| C1a | run POST returns 201 queued | PASS — all three legs | pass 20 @ 3f35115 | live20/C1,C5,C6.out:24, :26, :143, :145 |
| C1b | designated approver's decide posts 200 | PASS — all three legs | pass 20 @ 3f35115 | live20/C1,C5,C6.out:27, :85, :146 (also `live11/C4.out:62`) |
| C1c | @@run reaches terminal `completed` | PASS — the real-Claude agent run completes, and keeps completing: the agent leg ends `completed` (`:28`) after 2 iterations with `result_bindings.review_approved == true` and an SSE stream that saw the opening and closing frames (126 frames, `:83`); both twins complete as before (`:86, :147`). History of this row: pass 9 died at `/build_until_verified[3]/review` attempt 2 (`failed node_execution_failed:/build_until_verified`), live10 the same (`live10/C1.out:67`), and live11's agent arm ended `failed cause=until_exhausted` (`live11/C1.out:73`) because the reviewer could not see the plan the implementer published — **fixed in `5820aab`** (the review prompt approves on the goal, criteria and this iteration's implement/test results); pass 12 (`live12/C1.out` 98/0/0), passes 14–20 all reproduce a clean gate (the C1/C5/C6 group reads 166 PASS / 7 FAIL / 6 GAP at pass 18, 175/4/6 at pass 19 and **179 PASS / 0 FAIL / 6 GAP** at pass 20, `live20/C1,C5,C6.out:480` — and every one of those FAILs sits in C5/C6, never in C1) | pass 20 @ 3f35115 | live20/C1,C5,C6.out:28 (SSE: :83; twins: :86, :147; live11 FAIL: live11/C1.out:73) |
| C1d | full node key set, statuses, execution locations | PASS — on all three legs, and the agent leg's own key-set probe runs for the first time (it had died before it at passes 4–11): 14 keys exact (`ledger_only=[] expected_only=[]`), every node terminal at its expected status, `/approve`,`/verdict` control_plane vs loop bodies worker (ADR-0023 § 3), no unexpected node kinds with the loop spending 2 iterations | pass 20 @ 3f35115 | live20/C1,C5,C6.out:44-46, :84 (twin seed: :102-104, :142; replay: :163-165, :203) |
| C1e | digests, checkpoint count, attempt_count=1 | PASS — on all three legs: the input arm counts what the pinned revision DECLARES (agent leg `5 declared` — the twin adds `hold_seconds=default` as a 6th, `:47, :105, :166`), digests match the manifest verbatim (`:48, :106, :167`), API agrees with the ledger (`:49, :107, :168`), 8 checkpoints == 8 succeeded worker nodes (`:50, :108, :169`), `attempt_count = 1` (`:51, :109, :170` — RC1's double-count proven dead again) | pass 20 @ 3f35115 | live20/C1,C5,C6.out:47-51 (twin seed: :105-109; replay: :166-170) |
| C1f | artifact bytes readable, redaction_count 0 | PASS — every arm on all three legs: published exactly once, `redaction_count=0`/`ready`, `GET /artifacts/{id}` + `/content` bytes hash to the row's sha256, `artifact.created` journaled | pass 20 @ 3f35115 | live20/C1,C5,C6.out:54-56, :59 (twin seed: :112-114, :117; replay: :173-175, :178) |
| C1g | @@run.completed carries result_bindings | PASS — agent leg: summary non-empty (the agent's own words — "app/hello.py already had the requested change: add(a, b) has the docstring 'Return the sum of a and b.'", `:62`), `review_approved == true` (`:63`), `iterations 2` == the ledger's last suffix (`:64, :65`); both twins likewise. **live25 note (row stays PASS, with a recorded agent-leg FAIL):** live25's first process read the agent leg `iterations=2` PASS (`live25/C1,C5,C6.out:64`); its third process **FAILed** the same arm — `FAIL C1g agent: result_bindings.iterations >= 2 (agent, § 7.1 C1g) — 1` (`live25/C1,C2,C7,C8,C10,C12,C13,C14,C11.out:60`) — because the real agent read the planted test, fixed it and the docstring in iteration 1, the test passed and the reviewer approved (`:57`). That is legitimate model behaviour: `>= 2` was an over-claim, so commit `90a29c2` sets § 7.1 C1g's **agent** bound to 1..4 (the twin keeps the deterministic `== 2`) and prints a NOTE line with the count. The FAIL was observed and is recorded; the row stays PASS because the bound was wrong, **not** because the run was retried — and it is **not yet re-run on `90a29c2`**. In that same agent run (`:57`) the agent reported git failing in its worktree (“Git commands also failed because the repo's worktree link is broken”): the attempt launch plan omits ADR-0017's `mirror_read` grant and a fix is in progress — no verdict is changed for it. **Pass-26 note (both halves of that note are now measured):** on `76a9e64` the gate re-ran with `90a29c2`'s bound and the agent leg PASSes — `PASS C1g agent: result_bindings.iterations in [1, 4] … — 2` (`live26/C1.out:64`) with the count on the new NOTE line (`:65`), gate **98 PASS / 0 FAIL / 0 GAP** (`:211`) — and `e83913a`'s mirror grants are in the build: `live26/_events-C1.txt` contains ZERO `not a git repository` / `worktree link` / `backing repo` strings where live25 carried them, and the reviewer's own messages read the change set — "git diff against HEAD shows the docstring was added to hello.py" (`:14`, again `:16`) — so the agent really can run git in its worktree | pass 26 @ 76a9e64 (first proof pass 20 @ 3f35115; live25 note @ fa0c0e0) | live26/C1.out:64-:65 (gate summary :211; reviewer's git diff: live26/_events-C1.txt:14, :16); live20/C1,C5,C6.out:62-65 (twin seed: :120-123; replay: :181-184); live25/C1,C5,C6.out:64; live25/C1,C2,C7,C8,C10,C12,C13,C14,C11.out:60 (the agent's own words: :57) |
| C1h | @@journal sequence contiguous for the run | PASS — every arm on every leg, the milestone chain included (in-order subsequence match, `dfff98e`): the **agent run's 126-row slice** opens `run.created` / closes `run.completed`, strictly ascending, 16 attempt rows carrying `node_execution_id` + `attempt_id`, gate rows NULL `attempt_id`, 8 `run.checkpoint_saved` == 8 worker nodes, and its SSE stream saw the opening and closing frames; the 46-row twin slices likewise | pass 20 @ 3f35115 | live20/C1,C5,C6.out:66-74, :82-83 (twin seed: :124-132, :140-141; replay: :185-193, :201-202) |
| C1i | replay reproduces the key set and plan_digest | PASS — identical 14-key set (`seed_only=[] replay_only=[]`), `plan_digest` seed == replay == manifest, **and the cross-variant comparison PASSes on both spellings now (`agent_only=[] twin_only=[]`)** — that arm FAILed at live10/C1.out:189 and live11/C1.out:195 only because its agent leg was C1c's | pass 20 @ 3f35115 | live20/C1,C5,C6.out:204-207 |
| C1j | every agent permission prompt closes as exactly one journaled policy verdict | PASS — **new at pass 29** (check added by `7e6eda3`, driver crash `c11d01f`): all four arms PASS on the agent leg — at least one `conversation.permission.requested` (**8 requests / 8 decisions**), every requested id has exactly one decided row (`unanswered=[] doubled=[]`), every decided row is `status=decided` + `decided_by=node_policy:preapproved_within_sandbox` (`offenders=[]`), no decided row without a request (`orphans=[]`). Attempt-path verdicts only: after `c1c7c19` preapproved conversations return to the harness's auto mode with no per-call verdict (ADR-0036 addendum, corrected) | pass 29 @ d4cd945 | live29/C1.out:97-:100 (crash recorded at live28/C1.out:84) |
| C2a | secret reaches only the live authorized process | PASS — **GAP → PASS, promoted by `04fb651`'s process-tree probe driven on the `agent.acp` variant**: the sentinel sits in EXACTLY ONE live process environment — the authorized attempt's process tree, matched by digest, the value never printed, the adapter's children inheriting the launch env per ADR-0018 (`:54`) — and the holder is the process the attempt launched, not the worker daemon: `argv0='node /usr/local/bin/claude-agent-acp'` (`:55`). Delivery is env, not a file: the workspace has NO `.env.test.local` (`test -e .env.test.local -> 1`, `:56`) and every materialization row is `delivery_mode=env` with `target=DATABASE_URL` (`:57`). The window is real — the gate decided and the held attempt is the post-gate `/build_until_verified[1]/implement` (`:31`), the model's turn held it long enough to read inside the attempt (`:64`) — on top of the encrypted-store commitment (`:26`). Pass 14's "no `process.exec` attempt can ever be authorized to hold a secret" is exactly what the variant switch answers | pass 17 @ 320c6fe | live17/C2.out:54-:57 (window: :31, :64; store: :26; the dead GAP: live14/C2.out:42) |
| C2b | worker unmounts the env at the node boundary | PASS — **GAP → PASS**: the materialization row is stamped `attempt_id` = the attempt it was applied for (`1/1 rows carry attempt_id=96075635…`, `:60` — "01 invariant 5: the unit of work is the attempt, not the turn"), its lifecycle is `node_attempt` (`:61`), no row is keyed on a turn while naming a different attempt (`:62`), and **after the node boundary the worker UNMOUNTED it** — `cleaned_at` set with `cleaned_by='worker'` on 1/1 rows (`:63`, § 7.1's literal `t \| worker`). The state the claim needs now exists, so there is something to measure it against | pass 17 @ 320c6fe | live17/C2.out:60-:63 (the dead GAP: live14/C2.out:47) |
| C2c | sentinel absent from every durable surface | PASS — re-confirmed with **no GAP arm left**: the durable sweep runs while a worker really holds an attempt and comes back empty on every surface — 158 operational text columns across 158 readable places in Postgres, the encrypted store excluded (`:66`), the attempt's workspace tree on worker-a (`:67`), api-a's and worker-a's `/artifacts` (`:68, :69`), the compose logs of both workers and both API replicas (`:70`), and `git grep -I` over every ref of the mirror (`:71`). Pass 14's lone GAP arm — `conversation_turns` with no agent attempt to join (`live14/C2.out:58`) — is gone: five agent attempts own their `conversation_turns` row via `node_attempt_id` (`:74-:78`, the transcript text is inside the Postgres sweep at `:66`) and M3's human-initiated turns keep `node_attempt_id IS NULL` (`:79`) | pass 17 @ 320c6fe | live17/C2.out:66-:71 (turn arms: :74-:79; store: :26) |
| C2d | reviewer prompt and tool output carry no secret | PASS — re-confirmed on the agent variant: `GET /api/v1/attempts/f0fd52d9` names neither `DATABASE_URL` nor the sentinel (`:72`) and the reviewer attempt materialized NOTHING — 0 materialization rows on it, the allowlist naming only `m4-implementer` (`:73`). Pass 14's GAP ("the agent-leg half of the sentence — a profile-less `process.exec` node has no tool output", `live14/C2.out:59`) is closed by the variant switch: the run's five `agent.acp` attempts each own a `conversation_turns` row under the implement/review profiles (`:74-:78`) and the sweep reads those columns clean (`:66`) | pass 17 @ 320c6fe | live17/C2.out:72-:73 (turn/tool-output arms: :66, :74-:79) |
| C3a | two workers contend on a deep queue | PASS — **GAP → PASS, promoted by `6f06bb0`'s leg that builds its own queue.** Both lab workers are online (`:26`), the leg POSTs a `fanout_count=25` + `hold_seconds=15` run of its own (`:28`) and releases it from the gate (`:30`), and then measures real contention: **claims overlapped — peak in-flight=2 over 50 commit points** (`:54`), i.e. two workers held child attempts at the same moment. Pass 6's GAP (“its text waits on a C8 fan-out it never consumes”, `live6/C3.out:29`) is gone. One arm still GAPs and is reported: the leg read no `worker\|count` hand-out rows for the fan-out's children (`:53`), so the hand-out itself is unmeasured even though the overlap is | pass 19 @ 2b24738 | live19/C3.out:26, :28, :30, :54 (GAP arm: :53; the dead GAP: live6/C3.out:29) |
| C3b | never two live claims of one attempt | PASS — re-proven over a REAL 25-child queue: **0 violations over 25 attempt groups** for both halves of the claim — at most one live claim per attempt and never two distinct workers on one attempt (`:64, :65`) — and the same two assertions PASS per node key for all 10 inspected keys (`:70-:95`), the `distinct worker_id = 1` arm reading 1 wherever a claim exists | pass 19 @ 2b24738 | live19/C3.out:64-:65 (per-key arms: :70-:95; gate summary: :105 0 FAIL / 1 GAP) |
| C3c | one /implement claim, one fencing token drawn | PASS — **GAP → PASS**: `/build_until_verified[1]/implement` is claimed exactly once (`count(distinct worker_id)=1`, status `succeeded`, `:96`) with `fencing_token = 3 > 0` on the claimed row (`:97`), `[2]/implement` likewise at token 21 (`:98, :99`), and **`max(fencing_token) = claim count`** — 25 = 25 against `attempt_fencing_seq.last_value` (one draw per claim, ADR-0016 § 3, `:100`). Pass 6's GAP (“no `/implement` row carries a worker_id — the twin's steps finish in <1s”, `live6/C3.out:38`) is answered by `hold_seconds` on this leg | pass 19 @ 2b24738 | live19/C3.out:96-:100 (the dead GAP: live6/C3.out:38; token arm that passed then: :39) |
| C3d | negative control sentence recorded | PASS — **NOT RUN → PASS, promoted at pass 25.** The line is no longer just printed, it is graded: the sentence is in the leg's own printed report (`live25/C3,C4.out:108`), recorded **verbatim** against the contract text (`:109`), carries § 7.1 C3d's elements — the claim, the denial of exactly-once, the fence and C4 (`:110`) — and does not itself claim exactly-once execution (`:111`). Its fourth arm GAPed on `:112` (C4 had printed no verdict yet in that process) and was regraded PASS once C4 ran in the same driver process — `PASS … [regraded after C4]` (`:200`). Earlier passes' “emits no verdict” deferral is dead | pass 25 @ fa0c0e0 | live25/C3,C4.out:108-:111 (regrade: :200; first-pass GAP: :112; the dead deferral: live19/C3.out:101) |
| C4a | a live lease exists to freeze | PASS — re-proven at pass 18: the leg decides its own gate (`:24, :26`), the claim is attempt 1 of `/plan` on **worker-a** at token=2 (`:27-:28`), `compose pause` freezes `communication-m4-worker-a-1` for 45s of stopped renewals and unpauses it (`:31-:32`), and the fenced attempt is still held when it wakes (`:34`) | pass 18 @ cc0bff8 | live18/C4.out:32 (gate arms: :24, :26; the pick: :27-:28; row after the wake: :34) |
| C4b | frozen lease becomes interrupted with a retry | PASS — re-proven: `node.attempt.interrupted` with `reason=lease_expired` and `actor_kind=system`, followed by `node.attempt.retry_scheduled`, in the fenced attempt's own journal slice | pass 18 @ cc0bff8 | live18/C4.out:41-:44 (journal slice read at :38-:40) |
| C4c | a stale owner cannot publish success | PASS — re-proven with the same single GAP arm: the fenced attempt reads `interrupted` with NULL outputs, zero ready artifacts, zero `run_checkpoints`, zero `node.attempt.completed` (`:45-:49`), the stale owner's refusal is OBSERVED in its own container log (`docker logs communication-m4-worker-a-1 matched 2 lines`, `:54`), API and ledger agree (`:57-:58`), no lease machinery in the API body (`:59`), and a replacement attempt exists with a strictly greater fencing token (`:60-:61`). `finished_at IS NULL` remains unrepresentable under 00005's `attempts_terminal_timestamped` CHECK, so § 7.1's literal expectation cannot be met by any terminal row (`:50`) | pass 18 @ cc0bff8 | live18/C4.out:45-:49, :54, :57-:61 (GAP arm: :50) |
| C4d | replacement attempt succeeds, run completes | PASS — re-proven: the run `completed` (`:63`) and "the retry (attempt N+1) succeeded and the run completed — ownership moved, no process died" (`:64`) | pass 18 @ cc0bff8 | live18/C4.out:63-:64 (gate decision arm: :62) |
| C4e | fenced turn appends no transcript rows | PASS — **GAP → PASS, promoted by `2f0fe1f`'s rewrite running live for the first time at pass 18.** The leg now fences a real `agent.acp` attempt: the gate is decided (`:71`), the caught attempt is `/build_until_verified[1]/implement` on **worker-b** at token=12 with `turn=01a146b8-eeb2-79f5-…` (`:73`), and it is confirmed to be an `agent.acp` attempt owning an ACP turn (`:76`). After 45s of frozen renewals on `communication-m4-worker-b-1` (`:80`): the turn row is `interrupted` (`:86`), carries NO `stop_reason` (00003's `conversation_turn_interrupted_unreasoned`, `:87`), its attempt is interrupted too (ADR-0023 § 4's one renewal statement, `:88`), and **`conversation.turn.interrupted{reason:lease_expired}` is journalled for that turn, written by `system`** (`:91, :92, :93`). Pass 11's GAP ("the fenced attempt is `/plan` with `attempts.turn_id` NULL", `live11/C4.out:65`) is dead. One arm GAPs and is reported rather than forced: the fenced turn had **no transcript to keep quiet** — `max(global_seq)` of its agent messages before the unpause is 0 (`:96`), so "appends no transcript rows" has nothing to bound | pass 18 @ cc0bff8 | live18/C4.out:76, :86-:88, :91-:93 (GAP arm: :96; the dead GAP: live11/C4.out:65; gate summary :101 0 FAIL / 2 GAP) |
| C5a | a live attempt exists to SIGKILL | PASS — re-proven at pass 20: the leg releases the run from its gate (`:214`) and captures everything BEFORE the fault — `attempt=1 worker=worker-b token=27 node=/build_until_verified[1]/implement` (`:217-:218`), one `CKPT_BEFORE` boundary (`:219-:220`), `HEAD_BEFORE=d112bbbe8f9f dirty=0 ready=0 uploading=0` (`:221-:222`). § 7.1 names worker-a; the live claim landed on worker-b, so the leg kills the OWNER and prints that contradiction (`:215-:216`). The freeze proves the lease stayed live: `status@stop=running status+3s=running proved=True` (`:223-:224`) | pass 20 @ 3f35115 | live20/C1,C5,C6.out:214 (pick: :217-:218; boundary: :219-:222; freeze proof: :223-:224) |
| C5b | kill reads interrupted, never completed | PASS — re-proven: the worker died holding a live lease (kill #1 — the reconciler wrote `interrupted` while the lease was still live 3s after SIGSTOP, `:227`), the killed attempt reads `interrupted` (`:230`) with `error_class='interrupted'` (§ 7.1's literal, `:231`), `node.attempt.interrupted{reason:lease_expired} actor=system` plus `node.attempt.retry_scheduled` are its whole journal slice (`:235`), NO `node.attempt.completed` exists for it (`:236`), run still `running` with the retry armed (`:237`) | pass 20 @ 3f35115 | live20/C1,C5,C6.out:227, :230-:231, :235-:237 |
| C5c | checkpoints and artifacts survive the kill | PASS — re-proven: `run_checkpoints` identical before/after the kill (`before=1 after=1 diff=[]`, `:242`), the last completed boundary still queryable (`:243`), ready artifact count unchanged (`:244`), nothing left `uploading` (`:245`) | pass 20 @ 3f35115 | live20/C1,C5,C6.out:242-:245 |
| C5d | same-volume workspace is reclaimed, not rebuilt | PASS — re-proven: workspace `ready` after the worker came back (`:256`), `volume_id` byte-identical across the kill (`sha256:90bd076dc2e63be2…` on both sides — ADR-0017's reclaim rule, `:257`), no `workspace.recovery_lost` event (`:258`) | pass 20 @ 3f35115 | live20/C1,C5,C6.out:256-:258 |
| C5e | retry posts from the last checkpoint | PASS — re-proven on the third independent kill, and **the arm that GAPs is only the route's spelling**: the engine arms the retry itself (`node.attempt.retry_scheduled actor=system` → attempt 2, `:265`), attempt 1 `interrupted` (`:273`), attempt 2 `running` (`:274`), `retry_context.attempt=1` (`:275`), `retry_context.error_class=interrupted` (`:276`), **`retry_context.head_commit` equals the HEAD read BEFORE the kill** — retry resumed FROM the checkpoint, not from scratch (`:277`, `'d112bbbe8f9f'` == `'d112bbbe8f9f'`) — and `retry_context.modified_path_count` is now CARRIED (`:278`, `=0` vs the dirty lines): that is `8cc0cf2`'s `process.exec` boundary capture landing the count pass 17 could not read (`live17/C5.out:89`). § 7.1's literal `POST /runs/{id}/retry -> 200` still reads 409 `run-not-retriable` and the leg reports the contradiction instead of forcing it (`:264` — the run is `running (retry armed)` per C5b's own sentence, the ENGINE owns this retry at `attempt_limit=2`, and the route only applies to the budget-refused case C5h measures) | pass 20 @ 3f35115 | live20/C1,C5,C6.out:265, :273-:278 (GAP arm: :264; the GAP this replaces: live17/C5.out:89) |
| C5f | continue_workspace is the observed default | PASS — re-proven: HEAD does not move across the retry — `HEAD_AFTER_RETRY_START = HEAD_BEFORE` (`:279`, `before='d112bbbe8f9f' after='d112bbbe8f9f'`), the interrupted attempt's dirty path count did not shrink (`:280`, `DIRTY_BEFORE=0 DIRTY_AFTER=0`), and zero `run.checkpoint_restored` events fire — continue_workspace, NOT restore_checkpoint (C6's policy) (`:281`) | pass 20 @ 3f35115 | live20/C1,C5,C6.out:279-:281 |
| C5g | retry appends, never rewrites history | PASS — all 11 node keys check their own append rule with no FAIL (`:284-:294`): control-plane/gate rows 0 attempts (`/approve`, `/fan_out`, `/verdict`, `/build_until_verified`), `/plan` 1, `/build_until_verified[1]/implement` 2 (the killed attempt + the automatic retry, `:286`), unreached worker nodes 0, and the killed run reaches `completed` after the checkpointed retry (`:296`). **Pass 17's lone GAP arm is gone** — “no C1 key set in this pass” (`live17/C5.out:108`) — because the driver now runs C1, C5 and C6 as one group and carries the set across them: the retried run's key set equals C1's twin set, iteration-normalized (`:297`) and **with no hole in the until-loop history** (every body node's suffixes run 1..N contiguous, `:298`) — the append-only claim stays falsifiable. `2b24738` is that driver change | pass 20 @ 3f35115 | live20/C1,C5,C6.out:284-:294, :296-:298 (the dead GAP: live17/C5.out:108) |
| C5h | exhausted budget fails the run honestly | PASS — **GAP → PASS: the stale precondition that held this row down is now a NOTE, not a GAP** (`13f0e0f`, re-confirmed `:346`). The scratch-pipeline arm ran end to end: it copies the twin's held node to top level (`:304`), replaces `retry` with `maxAttempts: 1` — the budget § 7.1 names, and the one variable (`:305`) — with ONE node and no other retry budget anywhere (1455 bytes, `:306`), publishes it through draft → validate → publish as its own scratch pipeline leaving the § 7.0 twin untouched (revision `01a14721…`, `:317`), and then proves the whole sentence live: the node is authored `attempt_limit='1'` (`:338`), the killed attempt reads `interrupted \| interrupted` (`:339`), the retry is REFUSED with zero `node.attempt.retry_scheduled` rows and no attempt 2 (`:340`), the run fails honestly `failed \| node_execution_failed:/implement` (`:341`), the manual `POST /runs/{id}/retry` is ACCEPTED on that failed run (route 31, `:342`) and appends attempt 2 with a retry_context (`:343`) | pass 20 @ 3f35115 | live20/C1,C5,C6.out:304-:306, :317, :338-:343 (the precondition demoted to a NOTE: :346; the dead GAP: live17/C5.out:111) |
| C6a | revision carrying retry.workspacePolicy | PASS — re-confirmed: the restore_checkpoint twin publishes as its own immutable revision with exactly one policy line changed (8853 bytes, `:368-:369`) and the seed's revision is untouched (`:378`) | pass 20 @ 3f35115 | live20/C1,C5,C6.out:368, :369, :378 |
| C6b | restore_checkpoint really resets the worktree | PASS — **GAP → PASS, the restore has now actually happened.** `8cc0cf2` captures repo state at `process.exec` boundaries too, so the § 6 door opens, and the reset is measured rather than refused: `run.checkpoint_restored` names the killed node `/build_until_verified[1]/implement` (`:422`), `from_commit` is the recorded boundary commit VERBATIM (`:423`, `'d112bbbe8f9f'`), **`discarded_paths` names the uncommitted file the reset destroyed** (`:424`, `['m4-c6-uncommitted.txt']` — the `[]` that FAILed at `live19/C6…:414`), the worktree's HEAD equals the boundary after the reset (`:425`, `HEAD='d112bbbe8f9f'` where `live19` read `HEAD=''`), **`git status --porcelain` is EMPTY — the reset really happened** (`:426`, `dirty='0'`), the boundary restored TO is the `/plan` checkpoint on the run's own volume (D-024: commits, same-volume, never paths, `:427`), and the restore rode the retry's own attempt 2 (`:428`). The kill half holds too (`:383`, `:392-:393`). Passes 16–17's refusal ("its committed state is unrecorded", `live17/_events-C6.txt` seqs 64, 67) is dead | pass 20 @ 3f35115 (fixes `8cc0cf2`+`20c079b`+`3f35115`) | live20/C1,C5,C6.out:422-:428 (kill arms: :383, :392-:393; the FAILs this replaces: live19/C6…:414, :415; the dead GAP: live17/C6.out:89) |
| C6c | restore-mode retry completes the run | PASS — **FAIL → GAP → PASS.** The restored run reaches `completed` (`:431` — `failed` at `live18/C6…:423` and `live19/C6…:427`), and the append-only half is now measured, not deferred: the restored run's key set equals C1's (iteration-normalized, `:433`) **with no hole in the until-loop history** (`:434`) — `2b24738` carries C1's set into this comparison, killing pass 14's "needs two measured sets" GAP (`live14/C6.out:84, :85`). One arm GAPs and is named: `run.retried`'s `workspace_policies` cannot name the mode for THIS run because no `run.retried` row exists — that row is what the MANUAL `POST /runs/{id}/retry` writes (`runtime/retry.go`), and the manual POST was refused 409 because the engine's own budget had already armed attempt 2 (`:432`). `3f35115` makes a QUEUED restore retry record that policy; C9's re-run is what reads it back | pass 20 @ 3f35115 | live20/C1,C5,C6.out:431, :433, :434 (GAP arm: :432; the FAILs this replaces: live19/C6…:427, live18/C6…:423) |
| C6d | dirty boundary refuses, resets nothing | PASS — **GAP → PASS, promoted by `fa0c0e0`'s dirty-boundary scratch pipeline.** The scratch is driven by the opt-in `leave_dirty` fixture input (the § 7.0 seed twin is byte-identical without it) and is published as its own revision (`:453-:466`); it produces exactly the state the row names, so every arm of the sentence is now measured in one process: the precondition holds — **dirty boundary nodes=['/dirty_seed']** (`:481`), the retry on that uncommitted boundary is refused with **409** (`:484`) whose body is `application/problem+json` with **`code=checkpoint_unavailable`** (`:485`), **NOTHING is reset on the refusal path** — HEAD and the dirty set untouched (`:486`), **zero `run.checkpoint_restored` events** follow the refusal (`:487`), and **the refusal appended no new attempt** (`:488`, before=1 after=1). Not this row's verdict: the twin-run arm's GAP lines at `:370-:377` and their reprints at `:497-:499` are the OLD twin arm the scratch pipeline replaces (that run had no dirty boundary to refuse on). History — pass 20's `GAP` stood on those three unmeasurable arms. Pass-20 wording of the behavioural arms: the retry refused 409, nothing reset, no restore event — `live20/C1,C5,C6.out:403, :405, :406` | pass 25 @ fa0c0e0 | live25/C1,C5,C6.out:481, :484-:488 (scratch publish: :453-:466; superseded twin arm: :370-:377, reprints :497-:499; the GAP arms pass 20 could not measure: `live20/C1,C5,C6.out:400, :404, :407`) |
| C6e | cross-volume loss says recovery_lost | PASS — **GAP → PASS: the cross-volume loss is finally produced and read inside the scripted gate.** The leg starts its own run (`:437`), releases it from the gate (`:439`), freezes worker-a with the lease proved live (`:440-:441`) and kills it holding that lease (`:446`), drains the owner (`:447`) so only the other volume can serve the retry (`:444-:445`), starts the throwaway required worker `communication-m4-worker-c` on its own volume (`:451`) and points the run at it (the § 7.1 "affinity forced" write, no public route touching affinity, `:454-:457`) — then the loss is the ledger's own: `workspace.recovery_lost{reason: volume_changed}` names the expected and found volume digests (`:473`), the attempt carries `error_class='workspace_lost'` with the run `failed` (`:474`), **NO automatic retry** (zero `retry_scheduled` rows above base 2 — ADR-0023 § 7/§ 11 pass 5, `:475`), the refusal tells the operator 'prior edits lost, rerun required' (`:476`) and is never described as 'resumed' (`:477`). Pass 14's reads (`('2','failed','infra')`, `live14/C6.out:113, :123`) are dead | pass 20 @ 3f35115 (`04fb651`+`599e4f9` wiring, `efb82bd` classing) | live20/C1,C5,C6.out:437, :439, :446, :451, :454-:457, :473-:477 (the dead GAP: live14/C6.out:113, :123) |
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
| C9a | gate waits as a row with zero attempts | PASS — re-confirmed: `/approve` `waiting` with 0 attempts behind it (`:32`), `waiting_human` (`:33`), no leased/running attempt (`:34`), the ops counters see it as a `waiting_approval` (`:35`), and no worker's `active_attempts` names the gated run (`:36`). The restart arm still GAPs because a foreign run holds a live lease at that moment (§ 7.0: disturb only what you created, `:40, :43`) | pass 21 @ 6ddd576 | live21/C9.out:32-:36 (restart GAP: :40, :43) |
| C9b | non-approver refused, gate unmoved | PASS — re-confirmed: bob gets 403 `application/problem+json` (`:55`), `approval.denied{not_a_designated_approver}` journaled (`:56`), the gate is STILL pending (`:57`), the CAS version unmoved (`:58`), no decision or decider written (`:59`), the run still `waiting_human` (`:60`) — with the lab's seeded truth checked so the refusal is the approver rule and not a missing membership (`:61`) | pass 21 @ 6ddd576 | live21/C9.out:55-:61 |
| C9c | approver removed from project cannot decide | PASS — re-confirmed: alice after removal gets 403 problem+json (`:76`), `approval.denied{approver_lost_access}` journaled (`:77`), gate still pending (`:78`), version unmoved (`:79`), no decision written (`:80`), run still `waiting_human` (`:81`) | pass 21 @ 6ddd576 | live21/C9.out:76-:81 |
| C9d | two simultaneous decides, exactly one winner | PASS — re-confirmed: exactly one 200 of 2 (`carol`/`dan`, `:94`), the loser gets 409 `approval_already_decided` (`:95`) carrying the WINNER's decision and version (`:96`), and one row with one decider at version 2 (`approvals_decided_consistency`, `:97`) | pass 21 @ 6ddd576 | live21/C9.out:94-:97 |
| C9e | rejection is a business outcome, not an error | PASS — re-confirmed: rejection accepted 200 (`:100`), `/approve` `succeeded` with outcome `rejected` (`:107`), no execution `error_class` on the gate (`:108`), the when-gated dependant skipped `condition_default` and its dependants `dependency_skipped` with nothing failed (`:109`), the run terminating on the graph's terms rather than `approval_expired` (`:110`). The causal arm GAPs unchanged — the seeded graph guards nothing on `nodes.approve.outputs.decision` (`:111`) | pass 21 @ 6ddd576 | live21/C9.out:100, :107-:110 (causal GAP: :111) |
| C9f | on_timeout arms expire, re-request, cancel | PASS — **FAIL → PASS, promoted by the pass-21 rerun on `fc8b464`'s journal row.** All three modes are authored and run live again: the sub-floor deadline (20s < minimum 60) is refused at validate by the schema's floor (`:120`), each mode publishes its own 60s revision moving only the `/approve` deadline pair (fail `:121-:122`, expire `:146-:147`, cancel_run `:175-:176`), and while each gate waits ZERO attempts are claimed behind `/approve` with the deadline unexpired and `/plan`'s outputs still readable (`:133-:135, :158-:160, :187-:189`). **fail** journals `approval.expired` (`:141`), every row names its mode (`:142`), the gate is terminal (`:143`), and `run.failed` carries `error_class='approval_expired'` on both the run and the gate row (`:144`) while the sibling C8 run progresses (`:145`); **expire** re-requests on the SAME `approval_requests` row (`re_requested=t`, `:166`) with exactly one `approval.expired` carrying it (`:167`), gate still pending holding no attempt (`:169`), journalled by the reconciler (`:170`), terminal not hung (`:172`), `run.failed{approval_expired}` when the second deadline lands (`:173`); **cancel_run — pass 19's FAIL — now journals `run.cancel_requested` FIRST** (`:199`, `fc8b464` routes the advancer through C8g's own cascade path), then `approval.expired` naming its mode (`:195-:196`), gate terminal (`:197`), run `cancelled` never `failed` (`:198`), no masquerade as a business outcome (`:200`), no re-request (`:201`). Four arms GAP honestly and are reported: the twin's `/plan` publishes outputs, not bytes, so "the sample's artifact is still readable" has no artifact to read (`:136, :161, :190`) and the re-request's moved deadline reads `deadline_moved=None` (`:168`) | pass 21 @ 6ddd576 | live21/C9.out:199 (PASS arms: :39, :120-:122, :129, :133-:135, :141-:145, :146-:147, :154, :158-:160, :166-:167, :169-:174, :175-:176, :183, :187-:189, :195-:198, :200-:201; GAPs: :136, :161, :168, :190; gate summary :293 0 FAIL / 8 GAP; the dead FAIL: live19/C9.out:199) |
| C9g | human takeover pauses and resumes the run | PASS — **FAIL → PASS, promoted by the pass-21 rerun on `6ddd576`.** The takeover runs end to end on a live `agent.acp` turn: its gate is decided so there is an attempt to act on (`:226`), `POST /conversations/{cid}/take-control` with the version the caller read answers 200 (ADR-0016's CAS, not a claim, `:238`), the control row moves to the second member with the version bumped (`:239` — bob), the attempt closes `interrupted`/`interrupted` (§ 7.1's literal — interrupted is never a business outcome, `:241`), `node.attempt.interrupted{reason:'human_takeover'}` is journalled (`:242`) and the RUN parks `paused` with `paused_reason='human_takeover'` rather than silently retrying (§ 5.3, `:243`). `return-control` 200 (`:246`), the run resumes **on its own with no manual resume POST** (`:247`), `run.resumed` names the reason it cleared (`:248`), the next attempt's `retry_context` names the human intervention for the agent (`:249`), M1/M2's replay route still answers (`:250`) in the same journal whose max `global_seq` only grows (`:285`), the takeover appends its own `conversation.control.transferred` row (`:286`), and **pass 19's FAIL is dead: the cancel the takeover REQUESTED reached its honest terminal in the same journal — `conversation.turn.interrupted`, the worker having sent ACP `session/cancel` because `6ddd576` stamps `attempts.cancel_requested_at` in the takeover transaction (`:287`; the arm accepts the worker's `turn.cancelled` ack OR the reconciler's lease arm per ADR-0016 § 5)** and no second transcript cursor appears (`:288`). One arm GAPs and is reported: the cancel-requested-in-the-same-transaction read caught the turn row as `turn=None` (`:240`), so the marker is unobserved at commit time even though the terminal arm proves the cancel was real and honoured | pass 21 @ 6ddd576 | live21/C9.out:287 (PASS arms: :226, :238-:239, :241-:243, :246-:250, :285-:286, :288; GAP arm: :240; gate summary :293 0 FAIL / 8 GAP; the dead FAIL: live19/C9.out:248) |
| C10a | malformed reply fails as invalid_output | PASS — re-confirmed: the type-switched reviewer publishes as its own immutable revision (`:39`, the seed's revision untouched) and its attempt closes `status='failed' error_class='invalid_output'` — an EXECUTION error, not "not approved" (`:50, :51`), with `attempts.output_errors` carrying the JSON-Schema location (`entries=1`, `#/properties/evidence/type`, `:52`), NO `node.attempt.completed` for it (`:53`), and EVERY failed reviewer attempt carrying `invalid_output` — never `agent_error`, `infra`, or a business close (`:73`) | pass 17 @ 320c6fe | live17/C10.out:50-:53, :73 (publish: :39, the authored switch: :27-:30) |
| C10b | routing never changes during that failure | PASS — **FAIL → PASS, promoted by `04fb651`'s routing scope.** The unfalsifiable negative arm is dead: the leg watches the failing scope's `dependsOn` closure ("the failing scope and everything downstream of it", `watched=['/build_until_verified', '/publish_n…']`) and finds **no `condition_default` skip on any node the rejected reply could have routed** (`business skips on watched nodes=(none)`, `:68`), while **every other `condition_default` skip is one the run's own inputs explain** — `explained=["/emit_items: when='inputs.fanout …"]`, `unexplained=(none) unreadable=(none)` (`:69`). Pass 4's FAIL was exactly that pair counted against the claim (`live4/C10.out:58, :76`) — answered by scoping the assertion, not by weakening it. Everything else holds: the rejected attempt carries no outputs (`:54`), the reviewer node_execution's outputs stay NULL so the `approved:'yes' == true` coercion was never reachable (`:55`), the until scope never succeeded and its close is `child_failed`, not a business termination (`:65, :66`), the run never completed (`:67`), no iteration's review row reports `succeeded` (`:70`), the reply was retried within budget 2 (`:71, :72`) with the retry journaled as the `invalid_output` retry (`:74`). Two arms GAP, both honest limits: the scope row could not be sampled **mid**-failure (`:64`), and the shipped fixture has no valid-then-malformed mode, so the retry's success is unproducible (`:75`) | pass 17 @ 320c6fe | live17/C10.out:68, :69 (arms: :54, :55, :65-:67, :70-:72, :74; GAPs: :64, :75; the dead FAIL: live4/C10.out:58) |
| C10c | model.chat variant fails identically | PASS — **GAP → PASS, promoted at pass 39 after four product fixes.** The boundary refuses the model.chat reply's CONTENT the same way it refuses the `process.exec` arm: the instructed malformed reply `{"approved": "yes", "evidence": 42}` closes `status='failed' error_class='invalid_output'` (`:110, :111`), `attempts.output_errors` carries the JSON-Schema locations **`/json/approved` and `/json/evidence` — the reply's content, never the envelope** (`:112-:114`), and NO `node.attempt.completed` fires (`:113`); the same declarations' valid control reply `{"approved": true, "evidence": "ok"}` SUCCEEDS in the same scratch run with `outputs.json.approved == true` (`:115-:116`). Getting there cost four product fixes found live by the arm: `3905f39` (the loader emits `temperature: 0` as int64 but the worker only took float64, so the node failed before calling the model, `live34/C10.out:100`), `269de46` (the store refused the model.chat completion "completed without a checkpoint volume" because the node captured no boundary; the attempt sat until lease expiry — every successful model.chat step in a workspace run was lost, `live35/C10.out:98`), `330af07` (the compiler dropped `config.responseSchema`, so no model.chat node ever validated or parsed its reply — the valid control failed `missing property 'json'`, `live37/_events-C10.txt:10`) and `1b872b8` (the collective refuses a constrained `response_format`, http 400 `response_format_not_supported`, `live38/_events-C10.txt:10` — validation is local only, ADR-0024 note). Pass 36's PASS was the refusal of the envelope, not the reply (`live36/C10.out:101`), which is why `cabade3` re-armed the driver (permissive `responseSchema`, envelope outputs, the `/json` location rule, the valid-reply control). The lab's collective wiring (`qwen3-8-27b` for the assistant + model.chat env) is an uncommitted, owner-approved lab-only compose override; no key is in the repo | pass 39 @ 1b872b8 | live39/C10.out:110-:116 (the passes 34–38 FAILs: live34/C10.out:100, live35/C10.out:98, live36/C10.out:101, live37/_events-C10.txt:10, live38/_events-C10.txt:10; the dead GAP: live17/C10.out:78) |
| C11a | collector sink is real, injected run starts | PASS — sink answers the liveness probe and logs it; injected-body twin POSTed 201 | pass 4 @ 854b2ef | live4/C11.out:24-25 |
| C11b | injection verbatim, nothing egresses | PASS — the injected line reaches the downstream prompt verbatim, ZERO collector requests carry the sentinel (digest-compared), zero carry a fencing token, and the twin run recorded NOTHING at the sink (`--block-net`); the report-honesty probe (D3) and the verbatim probe (D2) both PASS now that `554092a` reads the right surfaces. The `sandbox.verified` truthfulness arm GAPs (7 rows, 0 false to check) | pass 4 @ 854b2ef | live4/C11.out:33, :36-38, :40 (GAP: :39) |
| C11c | structural mitigation holds | PASS — **NOT RUN → PASS, promoted at pass 25 by `fa0c0e0`'s exit-timed regrade, which runs C11 in the same driver process as the gates that measure its claims.** Every structural claim in the sentence is graded from those witnesses: `outputs are schema-validated` PASSes on C10a/C10b/C7c’s verdict lines (`live25/C1,C2,C7,C8,C10,C12,C13,C14,C11.out:696`) and `the reviewer’s permission mode is its own profile (04)` PASSes on C2d (`:698`); the four claims whose witnesses print after C11 in GATES — project-scoped, size-capped, redaction-scanned, and “an expression over injected output cannot escape ADR-0022’s allowlist” — are regraded PASS at `:1082-:1085` (C8b+C14a, C12b, C1f+C2c+C13c, C12a+C12b+C13b). Their first-pass GAPs at `:694-:699` and the reprints at `:1072-:1075` are the pre-regrade lines, not this row’s verdict. The pass-4 deferral (“no verdict line exists for C11c”) is dead | pass 25 @ fa0c0e0 | live25/C1,C2,C7,C8,C10,C12,C13,C14,C11.out:696, :698, :1082-:1085 (pre-regrade GAPs: :694-:699, reprints :1072-:1075; the dead deferral: live4/C11.out:41, and what it pointed at: live5/C12.out:72) |
| C12a | CEL subset cannot be widened by authoring | PASS — `exists()`, `now()`, `matches()` refused `cel_function_not_allowed`, `workspace.*` refused `undeclared_root` | pass 5 @ 42187e7 | live5/C12.out:43-46 |
| C12b | expression and fan-out budgets refuse | PASS — 65 expressions `expression_budget_exceeded`, 64 validate (no off-by-one), 1001 literal items refused by schema, and the 1001 **evaluated** items now fail the run with `failed_cause='fanout_items_exceeded'` (pass 3's generic cause was fixed in `e0ee333`; pass 4's 422 idempotency-key crash was fixed in `42187e7`) | pass 5 @ 42187e7 | live5/C12.out:55, :56, :61, :72 |
| C12c | a running run stays pinned to its revision | PASS — revision/plan digests and revision id unchanged by a new publish, `/nodes` plan view byte-identical, later nodes still execute the pinned plan, re-pin moves the assignment and only NEW runs (pass 3's FAIL was fixed in `554092a`) | pass 5 @ 42187e7 | live5/C12.out:96-102, :107-110 |
| C12d | byte-identical republish is 409 | PASS — 409 `revision_already_published` naming the existing revision; a changed budget number publishes 201 | pass 5 @ 42187e7 | live5/C12.out:130-132 |
| C12e | revision and plan digests separate correctly | PASS — whitespace-only wording moves revision only; a `passWhen` operator moves both | pass 5 @ 42187e7 | live5/C12.out:151-152 |
| C13a | seven deferred kinds refused, naming M5/M6 | PASS — re-confirmed: 7 `kind_not_implemented` findings at their own `/spec/nodes/N/kind` locations, 3 naming M5 and 4 naming M6 (`:35-:42`), **exactly seven** of them (`:43`), draft recorded `invalid` (`:44`) | pass 20 @ 3f35115 | live20/C13.out:35-:44 |
| C13b | config typos refused at highlightable locations | PASS — re-confirmed: typo (`:49`), `maxConcurrency` binding (`:54`), unquoted `carryForward` (`:59`), `$${{` escape (`:64`), `cwd` binding (`:69`), unquoted date (`:74`) and `maxConcurrentNodes: -1` (`:79`) each refused at its own `instance_location` | pass 20 @ 3f35115 | live20/C13.out:49, :54, :59, :64, :69, :74, :79 |
| C13c | secret literal blocks publish, value redacted | PASS — **re-run with NO GAP arm left**: `compiler/secret_literal_detected` at `/spec/nodes/0/config/env/DATABASE_URL` (`:86`), the validate response redacted (840 bytes scanned, no plaintext occurrence, `:87`), publish refused 422 (`:88`). The "the detector itself is what blocked" arm — GAP at passes 1–20 because the publish gate short-circuited on the draft's recorded validation and the 422's `code` read `None` (`live20/C13.out:88, :89`) — now PASSes: `d9928d9` (ADR-0038) makes the publish 422 for a recorded secret finding carry `code=secret_literal_detected` — the response body names it verbatim (`:85`) and `:88` reads `422 code=secret_literal_detected` — so `:89` PASSes, "the secret finding itself blocks publish — 422 secret_literal_detected — § 2.2's letter exactly". Gate: **48 PASS / 0 FAIL / 0 GAP** (`:156`), the gate's first zero-GAP run | pass 24 @ d9928d9 (ADR-0038) | live24/C13.out:86-:89 (422 body: :85; gate summary :156; the dead GAP: live20/C13.out:89) |
| C13d | declared CEL roots compile, reserved root refused | PASS — re-confirmed: all seven declared roots (`inputs`, `nodes`, `run`, `item`, `items`, `iteration`, `previous`) compile in scope (`:102-:108`), `loop` refused as reserved (`:109`), out-of-scope `item`/`items`/`previous`/`iteration`/`parameters` refused `undeclared_root` (`:110-:114`), and `parameters` compiles in `NodeTemplate` scope with publish refused as `template_publish_deferred` (ADR-0024 § 2, `:115`) | pass 20 @ 3f35115 | live20/C13.out:102-:115 |
| C13e | continue_live and run.override refused | PASS — re-confirmed: `sessionMode: continue_live` refused `unsupported_session_mode` at its own location (`:120`), no route for `/runs/:id/override` (404, `:123`), `run.override.applied` never emitted across 17 observed journal types (`:124`) | pass 20 @ 3f35115 | live20/C13.out:120, :123, :124 |
| C13f | no resource-limit columns anywhere | PASS — **GAP → PASS, promoted by `28d25ba`'s browser arm running live at pass 20.** Both halves now exist: the API says it — `/system/scheduler` carries no cpu/memory/disk field at all (`:127`, the fields read back are `attempts_by_status`, `lease_expirations`, `max_retry_loop_depth`, `oldest_queued_age_seconds`, `queued_unbindable_runs`, `waiting_approvals`, `workers`) — and **the ops page says it in a browser**: admin signs in (`:128`) and the rendered line reads 'Resource limits: not implemented — runs have no cpu, memory or disk caps in this release.' (`:129`), with **no** cpu/memory/disk limit column anywhere (`:130`, "the only line naming a resource is the honest one"). Pass 4's GAP ("the ops page's wording was never rendered in this gate", `live4/C13.out:128`) is dead, and the copy it asserts (`09411da`) is an ancestor of this build. (The same gate's C13g — revisions immutable: PUT/PATCH/DELETE 404 `:135, :138, :141`, `deprecate` setting status without touching a single `runs` row `:152-:153` — has no § 7.1 row of its own.) Gate: **47 PASS / 0 FAIL / 1 GAP** (`:156`, the one GAP being C13c's `:89`) | pass 20 @ 3f35115 (UI `09411da`, arm `28d25ba`) | live20/C13.out:127, :129, :130 (API arm: :127; gate summary :156; the dead GAP: live4/C13.out:128) |
| C14a | API replicas roll, the stream continues | PASS — both replicas restarted one at a time under load, LB answered every probe, Last-Event-ID resume with 1 reconnect, no duplicate/gap/foreign frame, the approval decided mid-roll landed exactly once, and the run reached `completed` (pass 2's `failed` is gone) — **re-proven twice at passes 22–23** after 18 passes dormant: every arm again clean on `cc52e9a` and `555eed0` (restarts `live22/C14.out:34, :43`, probes `:55-:58`, stream `:60-:64`, mid-roll approval once `:65-:66`, `completed` `:67`; live23 identical at `live23/C14.out:34-:67`) | pass 23 @ 555eed0 | live23/C14.out:34, :43, :55-:67 (live22: live22/C14.out:34, :43, :55-:67; first proof: live4/C14.out:34, :43, :55-67) |
| C14b | two replicas cannot commit one transition twice | PASS — the safety proof § 7.1 itself names: no journal seq duplicated or lost, run slice ascending, `run.completed` once, ZERO node keys with two `succeeded` rows — re-proven at passes 22–23 (55 seqs no duplicate, 59 seqs contiguous 33..91, 0 duplicated keys — `live22/C14.out:48-:54`, `live23/C14.out:48-:54`). Two observation arms GAP by design: the advisory-lock handover is unobservable (live22 read `before={api-a:0, api-b:0}` — the log mark is released every tick, D6's unfalsifiable probe GAPs instead of FAILing, `live22/C14.out:59`; live23 could not read the serve logs at all — an unobserved log never PASSes, `live23/C14.out:59`) and forcing a simultaneous advance needs a store seam § 7.1 disclaims (`live22/C14.out:68`, `live23/C14.out:68`) | pass 23 @ 555eed0 | live23/C14.out:48-:50, :53-:54 (GAPs: :59, :68; live22 GAPs: live22/C14.out:59, :68; first proof: live4/C14.out:48-50, :53-54) |
| C14c | SCHEDULER=off leaves a run queued | PASS — **GAP → PASS, promoted by the pass-23 rerun** on a lab built with api-b's scheduler off (`555eed0`). With api-a stopped (`:81`) api-b serves READS with its engine off — readiness, `/system/scheduler`, `/projects/{id}/runs` and the lone run's GET all 200 (`:94`) — yet advances NOTHING: a run POSTed to api-b is accepted (`201`, `:95`) and stays `queued` across all six polls (`:96`), and when api-a is back on `:89` its engine picks the run up to `waiting_human` (`:97`) while the acquire marks prove api-b never held the driver's advisory lock (`{'api-a': 1, 'api-b': 0}`, `:98`). Pass 22's GAP was a probe bug, not the lab's truth: the env reader's log parser missed compose's `api-b-1` instance prefix and read both replicas as `on` (`live22/C14.out:71`) — fixed in `555eed0`. ADR-0023's rollback story now has its off-replica measurement | pass 23 @ 555eed0 | live23/C14.out:81, :89, :94-:98 (the probe bug this fixes: live22/C14.out:71; the dead GAP: live4/C14.out:69) |
| W1 | New run form comes from spec.inputs | PASS — fields, required-ness, declared default and repository list all rendered from the pinned revision; double-click Submit → one run + one stored `X-Idempotency-Key` | pass 4 @ 854b2ef | live4/W1.out:37-46 |
| W2 | live stream renders iterations, not duplicate nodes | PASS — 17 PASS / 0 FAIL / 2 GAP, and its **core mid-lease arm PASSes again**: the poll caught attempt `a65a8dec…` of `/build_until_verified[1]/implement` leased to worker-a (`:31`), so the page watched real in-flight work — journal panel rendered (`:29`), 21 samples of one document with no reload (`:74`), `run.created` → `node.attempt.started` → `run.checkpoint_saved` drawn in journal order (`:75-:79`), all 38 journalled run-vocabulary rows drawn at least once and never more often than written (`:81-:82`), and both `/build_until_verified[1]` and `[2]` under ONE stage cell for the loop (`:85-:89`). The two remaining GAPs are both `conversation.turn.*` on a `process.exec` twin that owns no ACP turn (`:77, :80`) — that arm additionally sits outside `M4_RUN_EVENT_TYPES`, so the Timeline tab drops it (`RunInspector.tsx:720`) | pass 11 @ 9be68fd | live11/W2.out:31 (rendering arms: :29, :74-82, :85-89; turn GAPs: :77, :80) |
| W3 | gate card: roles, countdown, approve, bob has no button | PASS — **21 PASS / 0 FAIL / 0 GAP** (`:55`) re-confirmed on pass 12's build: the run parks on a pending approval (`:26`) with roles + deadline exposed (`:27`), the control-plane card mounts with no attempt (`:37`), bob sees `approver_roles='maintainer'`, the countdown, the evidence list, NO Approve button and the not-a-designated-approver copy (`:30-:35`), alice's Approve click posts `/approvals/{id}/decide` (`:48`) and the card then reads decided (`:49-:52`). `4b4bfb8`'s schema fix plus `35a9acf`'s plan-card rendering are what unblocked it | pass 12 @ 5820aab | live12/W3.out:26-27, :31-35, :37, :38-42, :48-52 (summary: :55) |
| W4 | pinned-digest notice after a mid-run publish | PASS — the run page renders the pinned r1 digest before and after a live r2 publish, does not move onto r2, keeps "pinned r1" (not r2), and the notice "revision 2 published since this run started — this run is pinned to 1" renders. The leg exists since `d1bbcc3`, and the pinned-digest/notice copy it asserts is `3654c18`'s — both are already ancestors of pass 4's `854b2ef`, so neither is an unrun fix. Pass 4's crash was the exit stack not being up at all (`live4/_seed-W4.out:2 SEED FAIL stack not ready`) — an environment failure, not a leg failure; pass 5 is the rerun that measures it | pass 5 @ 42187e7 | live5/W4.out:30, :46-52 (pass-4 crash: live4/W4.out:23) |
| W5 | kill renders honest interrupted wording | PASS — **FAIL → PASS, promoted by `f010fe2`** (the run page lists every attempt and says "interrupted — the worker disappeared mid-node" with the retry time): 11 PASS / 0 FAIL / 0 GAP (`:60`). The run started (`:24`), alice signed in (`:26`), the page was open BEFORE the kill with status `running` (`:27`), the gate decided (`:30`), the worker was frozen and killed holding a live lease (`:45`) — and § 7.1's literal ask now renders: `node.attempt.interrupted` appears on screen as 'interrupted' (`:46`), the retry countdown is drawn from `scheduled_at` (`:49`), attempt 2 renders after the countdown (`:52`), 'resumed'/'restored'/'no data lost' appear nowhere in 17391 lines of rendered text (`:53`), no spinner remains at the terminal state (`:54`), console clean (`:55`) | pass 14 @ 87b8f08 (UI `f010fe2`) | live14/W5.out:46 (arms: :24, :26-:27, :30, :45, :49, :52-:55; summary :60) |
| W6 | cross-volume run says "prior edits lost" | PASS — **FAIL → PASS, promoted by `6e57274`** (the loss-led copy + a Retry control that says it is a manual rerun): **14 PASS / 0 FAIL / 0 GAP** (`:74`), the first § 7.2 leg to close without a GAP arm on a loss path. The scripted half still produces the state: the run starts (`:26`) and clears its gate (`:28`), worker-a dies holding a live lease (`:35`), the throwaway `communication-m4-worker-c` starts on its own volume (`:40`) and takes the ENGINE's own retry — "W6 graded the engine's own attempt 2, never a retry it posted itself" (`:60`) — reading `error_class='workspace_lost'` (`:61`) with `workspace.recovery_lost{reason:volume_changed}` journalled (`:62`) and **zero** `node.attempt.retry_scheduled` rows carrying the loss (ADR-0023 § 7, `:64`). Both pass-17 FAILs are gone: the refusal now leads with the operator's own sentence — 'this run's workspace is not on a volume this worker can serve; its prior edits are lost, rerun required' (`:63`, where `live17/W6.out:63` FAILed on the raw `postgres: run workspace volume` tail) — and the Retry control is honest (`:71`: "1 enabled retry control(s) and NONE of them offers an automatic retry… 1/1 describe themselves as the operator's rerun", with the ledger reading 0 auto-retry rows behind it). The browser half re-confirms: alice signs in (`:65`), the lost run's page opens on the node that lost its workspace (`:66`), says 'prior edits lost' / 'rerun required' (`:67`), draws the `workspace_lost` chip (`:68`, 5 elements) and the on-screen copy says 'No automatic retry is offered: there is no workspace to continue in…' | pass 19 @ 2b24738 + held UI (committed `6e57274`) | live19/W6.out:63, :71 (PASS arms: :26, :28, :35, :40, :60-:62, :64-:68; summary :74 0 FAIL / 0 GAP; the dead FAILs: live17/W6.out:63, :71) |
| W7 | ops page counters and per-worker load | PASS — 30/0/0: every counter, both per-worker load rows and the offline→restored arms render, and the arm that FAILed at pass 4 now PASSes — `queued_unbindable_runs` counts the affinity-bound run (`counter=1`) and the Ops page says 'waiting for its worker' in those words: `5ade2c5`'s fix confirmed live | pass 6 @ 382d42b | live6/W7.out:29-38, :51-52 (rerender arms: :53-62; restored: :71, :80) |
| W8 | validate panel renders located errors by source | PASS — all 7 `kind_not_implemented` rows render at their `/spec/nodes/N/kind` location naming M5/M6, the schema/loader/compiler findings render with source + hint, and the secret-literal finding renders redacted | pass 4 @ 854b2ef | live4/W8.out:40-53, :68-72, :87, :102, :119-120 |
| W9 | cross-project deep links 404 with zero leakage | PASS — outsider session gets 404 + not-found copy on run, `/nodes` and the SSE URL, SSE never opens, and no project name / node name / digest value appears in the DOM, console clean. Two arms GAP: the row names carol but § 7.1 C9d needs carol as an M4 maintainer, so the outsider is the seeded `erin`; and the `/approvals/{id}` deep link had no approval to link to | pass 4 @ 854b2ef | live4/W9.out:35, :43-44, :46-51 (GAPs: :26, :45) |
| W10 | stream continuity across a replica roll | PASS — **NOT RUN → PASS on its first live run** (`d91f4fc`/`74ea274`'s leg, finally executed): 15 PASS / 0 FAIL / 0 GAP (`:73`). The run exists (`:24`), alice signs in (`:29`), the journal panel renders before the reload (`:32`), the poll caught a real mid-lease attempt (`/build_until_verified[1]/review` leased to worker-a, `:49`), both API replicas answer again after `restart api-a` (`:43`), the app reloads mid-run and re-opens the stream (`:60`), the reconnect carries `?after=` (`:61`), the rendered timeline never shortens across either the reload or the roll (`:62`), frames keep arriving on the same document after the roll (tally (6,6) → (38,38), `:63`), the advancer-written types survive it (`:64`), all 38 journalled run-vocabulary rows draw at least once (`:65`) and none more often than written (`:66`), and no foreign project name (`:67`) or attempt id (`:68`) reaches the page | pass 14 @ 87b8f08 | live14/W10.out:49, :60-:68 (arms: :24, :29, :32, :43; summary :73) |
| W11 | child tree renders, internals absent from the DOM | PASS — **FAIL → PASS, promoted by `19175b3`** (child-run rows carry their status word): 11 PASS / 0 FAIL / 2 GAP (`:52`). The execution tab renders the `/fan_out` tree (`:33`) and § 7.1's own claim now holds — 25 of 25 child rows rendered with their own statuses, depth right for all, none naming a foreign child and **none carrying no status word** (`:36`, the FAIL at `live11/W11.out:36`), every child reachable in the DOM (`:37`), the node pane opens on `?node=…` with attempt copy (`:42`) and the correct crumb (`:44`), and no fencing token (`:47`), lease expiry (`:48`) or worker id (`:49`) appears anywhere. Two arms still GAP: the leg sampled no mid-lease attempt (`:27`), so the "attempt 1 interrupted + attempt 2 succeeded" pair had only `#1 succeeded` to read (`:43`) | pass 14 @ 87b8f08 (UI `19175b3`) | live14/W11.out:36 (PASS arms: :24, :26, :32-:33, :37, :42, :44, :47-:49; GAPs: :27, :43; summary :52) |

Totals: 86 items (75 § 7.1 sub-cases + 11 § 7.2 legs) — **PASS 85, FAIL 0, GAP 1, NOT RUN 0** (counted mechanically over the Verdict column above: 85 + 0 + 1 + 0 = 86). Pass 19's two FAILs are dead: the pass-21 rerun promoted **C9f and C9g FAIL → PASS** — `fc8b464`'s `run.cancel_requested` row journalled before the cancel_run cascade (`live21/C9.out:199`) and `6ddd576`'s takeover reaching an honest turn terminal (`:287`) — and the scoreboard's oldest GAP closed too: **C14c GAP → PASS** at pass 23 (`live23/C14.out:81-:98`). Pass 24 reran C13 on `d9928d9` (ADR-0038) — **C13 48 PASS / 0 FAIL / 0 GAP** (`live24/C13.out:156`) — closing C13c's last sub-arm GAP (`:86-:89` all PASS); that row's verdict was and stays PASS, so the mechanical recount is unchanged. The only GAP left is the one the lab cannot produce: C7c (the schema refuses the undeclared field before the eval-time arm). C10c's GAP (no `model.chat` endpoint — ADR-0024's first sacrifice) closed at pass 39: the owner allowed the lab to use the LLM collective (`qwen3-8-27b`) as the model.chat endpoint (an uncommitted, owner-approved lab-only compose override; no key is in the repo) and, after four product fixes (`3905f39`, `269de46`, `330af07`, `1b872b8`), the boundary refused the instructed malformed reply's content at `/json/approved, /json/evidence` while the valid control succeeded in the same scratch run (`live39/C10.out:110-:116`). No NOT RUN rows remain: pass 25 promoted **C6d GAP → PASS** (`live25/C1,C5,C6.out:481, :484-:488`) and the two deferrals **C3d / C11c NOT RUN → PASS** (`live25/C3,C4.out:108-:111, :200`; `live25/C1,C2,C7,C8,C10,C12,C13,C14,C11.out:696, :698, :1082-:1085`). **PASS-with-a-named-GAP-arm is its own state and is called out in each row:** C5e's `POST /runs/{id}/retry -> 200` (`:264`) and C6c's `run.retried.workspace_policies` (`:432`) both GAP because the ENGINE still owns the retry on a run the leg is not allowed to force into a retriable state; C9's restart arm (`live21/C9.out:40, :43`), its causal-rejection arm (`:111`), its no-artifact twin (`:136, :161, :168, :190`) and its same-transaction cancel marker (`:240`), and C14b's two observation arms (`live23/C14.out:59, :68`) each carry their reason; nothing in any of those rows FAILs.

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
**M5 browser legs (not § 7 items, recorded for continuity).** `e2e/tests/m5-journey.spec.ts` is live-green:
**10 passed / 0 failed / 1 fixme** on a `14e8ff5` lab. Its history: 12 passed / 1 failed / 4 not run (the
failure being step 6's wrong assumption that exit 1 alone is a failure — fixed in `ef470a0`), then 9 passed /
0 failed / 2 fixme at `ca33d49`, then **the gate-retry fixme became a real test** in `6eafa45`: “a retried run
whose retriable node is an expired gate comes back live” (`e2e/tests/m5-journey.spec.ts:771`) now drives the
Inbox retry of an expired gate and asks the SAME `approval_requests` row again, which is the browser half of
`14e8ff5` (retrying a run whose retriable node is an expired/cancelled approval gate re-arms its own approval
row, one per node execution; a gate already closed by a decision answers 409 `run_not_retriable`, never 500).
The one remaining `fixme` is the recorded product contradiction, not a broken test:
`:965` “a rejected gate fails the run, as its own card promises” — `ApprovalCard` promises rejection fails the
run while `closeGate` (internal/pipelines/runtime/advancer.go) records a BUSINESS outcome (`docs/m4-contract.md`
§ 5.3, and C9e measures exactly that at `live19/C9.out:107-:110`); the check is kept so the contradiction
cannot be forgotten. `e2e/tests/m5-inbox.spec.ts` PASSED 6/6 live on the lab. The **full M5 browser suite has now run live on `1c1733b`** (pass 33, `live33/m5-suite.out`): **50 passed / 0 failed / 1 deliberate skip** — m5-inbox 6, m5-agents-schedules 3, m5-layout 20, m5-journey 10 + 1 skipped (the fixme above), and the two new specs m5-issue-run 5 (`4a72d31`, live issue → prefill → `run_inputs`) and m5-prompt-edit 6 (`1879714`, an `agent.acp` `prompt` edited through the step form, saved, validated, published; digests move, served YAML carries it) — the latter having found the valid-draft validate response missing its required `revision_digest`/`plan_digest`, fixed in `1c1733b`.

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

Pass 18 (`cc0bff8`) ran C1+C5+C6 as one group for the first time (**166 PASS / 7 FAIL / 6 GAP**, `:471`) and
re-ran **C4**: **32 PASS / 0 FAIL / 4 GAP lines** (`live18/C4.out:101` counts `GAP=2`; the raw grep's four lines
are those two reprinted at `:102, :103`). Its value is **C4e running live for the first time** — `2f0fe1f`'s
rewrite fences a real `agent.acp` implement attempt on worker-b (`live18/C4.out:73, :76`), interrupts the turn
with `conversation.turn.interrupted{reason:lease_expired}` written by `system` (`:91-:93`) and proves the
turn and its attempt fence as one statement (`:86-:88`) — so **C4e GAP → PASS**, with the one honest GAP being
that the fenced turn had no transcript rows to keep quiet (`:96`). The 7 FAILs in the C1/C5/C6 group are all
C5/C6 legs still landing on the restore path (`live18/C1,C5,C6.out:297, :390-:391, :408-:409, :423, :425`:
`error_class='infra'` where C5b wants `interrupted`, a 409 naming an uncaptured boundary, and C6c's run
ending `failed`) — all addressed by `5528836`/`8cc0cf2`/`20c079b`/`3f35115`, and all gone by pass 20.

Pass 19 (`2b24738`, with `6e57274`'s UI fix held in the worktree — `_build.out` names the four held files)
promotes **five items and files two honest FAILs**. **C3 33 PASS / 0 FAIL / 2 GAP lines** (`:105` `GAP=1`) —
`6f06bb0` gives the leg its own 25-child held queue, so **C3a GAP → PASS** (claims overlapped, peak in-flight=2
over 50 commit points, `live19/C3.out:54`) and **C3c GAP → PASS** (`count(distinct worker_id)=1` on
`/build_until_verified[1]/implement` at fencing_token 3, `:96-:99`, and `max(fencing_token)=25 =
attempt_fencing_seq.last_value`, `:100`); C3b re-proves itself over 25 groups with 0 violations (`:64-:65`).
**W6 14 PASS / 0 FAIL / 0 GAP** (`live19/W6.out:74`) — `6e57274`'s loss-led copy and a Retry control that
admits it is a manual rerun turn both pass-17 FAILs into PASSes (`:63, :71`), so **W6 FAIL → PASS** and
**no § 7.2 leg is FAIL, GAP or NOT RUN any more**. **C9 89 PASS / 2 FAIL / 14 GAP lines** (`:254` counts
`FAIL=2 GAP=7`) is the first pass in which C9f's three timeout modes and C9g's takeover actually execute
(`817fcd0`): fail, expire and cancel_run each publish their own 60s revision and reach their own honest
terminal (`:144-:173, :195-:202`), and the takeover pauses/resumes a live `agent.acp` turn end to end
(`:234-:247`). Two journal rows still come back wrong — no `run.cancel_requested` before the cancel cascade
(`:199`) and no `conversation.turn.cancelled` behind the takeover (`:248`) — so **C9f and C9g move GAP → FAIL**
(running beats not running, even when it loses); both are fixed in `fc8b464`, **not re-run**. In the same
pass C5/C6 read **175 PASS / 4 FAIL / 6 GAP** (`:476`): the restore now runs and the four FAILs are the last
seams of it — `discarded_paths=[]` and `HEAD='' want '81428eefa3f4'` (`:414, :415`), a `run.checkpoint_restored`
event firing on a *refusal* (`:402`), and C6c's run ending `failed` (`:427`).

Pass 20 (`3f35115` — `20c079b`/`3f35115`'s restore fixes, `8cc0cf2`'s `process.exec` boundary capture,
`14e8ff5`'s gate re-arm) promotes **five more**. C1+C5+C6 come back **179 PASS / 0 FAIL / 6 GAP** (`:480`) —
**zero FAILs in the engine's own recovery gates for the first time** — and C1 repeats clean. **C6b GAP → PASS**:
`run.checkpoint_restored` names the killed node, `from_commit` is the boundary VERBATIM, `discarded_paths`
names the uncommitted file the reset destroyed, the worktree's HEAD equals the boundary and
`git status --porcelain` is EMPTY (`live20/C1,C5,C6.out:422-:426`) — the reset is measured, not refused.
**C6c FAIL → PASS** (the restored run `completed`, `:431`, with its key set equal to C1's and no hole in the
until-loop history, `:433-:434` — `2b24738` carries C1's set into the comparison, which also closes **C5g**'s
last GAP arm, `:297-:298`). **C6e GAP → PASS**: the cross-volume loss is produced inside the scripted gate —
worker-c started (`:451`), affinity forced (`:454-:457`), `workspace.recovery_lost{volume_changed}` and
`error_class='workspace_lost'` (`:473-:474`), zero auto-retries (`:475`), the operator's sentence and never
'resumed' (`:476-:477`). **C5h GAP → PASS**: `13f0e0f` demotes the twin-budget precondition to a NOTE (`:346`)
and every arm of the claim PASSes (`:338-:343`), and C5e's `modified_path_count` finally reads (`:278`, the
`8cc0cf2` capture). **C13 47 PASS / 0 FAIL / 1 GAP** (`live20/C13.out:156`) promotes **C13f GAP → PASS** —
`28d25ba` renders `/ops` in a browser and reads 'Resource limits: not implemented — runs have no cpu, memory
or disk caps in this release.' with no limit column anywhere (`:129, :130`), the API half holding too
(`:127`). The six remaining GAP lines (three verdicts, each reprinted) are the honest ones the task named:
C5e's `POST /runs/{id}/retry -> 200` and C6c's `run.retried.workspace_policies` both need a MANUAL retry of a
run the ENGINE is still auto-retrying (`:264, :432`), and C6d's refusal needs an uncommitted recorded boundary
the lab cannot produce without forging ledger rows (`:400, :404, :407`) — reported, not forced.

**Totals after pass 20: PASS 77, FAIL 2, GAP 4, NOT RUN 2** — nine items promoted since pass 17 (C3a, C3c,
C4e, C5h, C6b, C6c, C6e, C13f, W6) and two filed as FAILs (C9f, C9g) for journal rows `fc8b464` already
fixes. The M5 journey went live-green in the same window (`14e8ff5`, 10 passed / 0 failed / 1 fixme,
`6eafa45` turning the gate-retry fixme into a real test).

Passes 21–23 (`6ddd576`, `cc52e9a`, `555eed0`) are the reruns. **Pass 21 reran C9 on a build that finally
contains both fixes: C9 91 PASS / 0 FAIL / 16 GAP lines** (`live21/C9.out:293` counts `FAIL=0 GAP=8`; the
eight verdicts reprint at `:294-:301`). **C9f FAIL → PASS**: cancel_run journalled `run.cancel_requested`
FIRST (`:199`, `fc8b464`'s advancer routing), the run `cancelled` never `failed` (`:198`), the timeout
no masquerade (`:200-:201`), fail and expire modes re-proven alongside (`:141-:145, :166-:174`).
**C9g FAIL → PASS**: `6ddd576` stamps `attempts.cancel_requested_at` in the takeover transaction so the
worker sends ACP `session/cancel`, and the cancel reached its honest terminal in the same journal —
`conversation.turn.interrupted` (`:287`), with paused/resumed/replay arms all PASSing (`:241-:250,
:285-:288`). C9's eight GAP verdicts all carry reasons: the restart arm refuses to break a foreign run's
live lease (`:40, :43`), the seeded graph gates nothing on `approve.outputs.decision` (`:111`), the twin's
`/plan` publishes outputs not bytes (`:136, :161, :190`), `deadline_moved=None` on the re-request
(`:168`), and the same-transaction cancel read caught `turn=None` (`:240`) — reported, never forced.
**Pass 22 reran C14 for the first time since pass 4 on a lab built with api-b's scheduler off** —
**C14 21 PASS / 0 FAIL / 6 GAP lines** (`live22/C14.out:74`): C14a and C14b's ledger safety proofs
re-passed clean (`:34-:67`), and C14c GAPed on a PROBE BUG, not the lab — the env reader's log parser
missed compose's `api-b-1` instance prefix and read both replicas as `on` (`:71`). `555eed0` fixed the
parser, and **pass 23 closed the leg: C14 28 PASS / 0 FAIL / 4 GAP lines** (`live23/C14.out:101`),
**C14c GAP → PASS** (`:81-:97`): api-a stopped, api-b served reads only, a run POSTed to api-b stayed
`queued` across six polls while api-a's returning engine picked it up to `waiting_human`, and the
acquire marks showed api-b never held the driver lock (`:98`). C14b's two observation arms kept GAPing
with live reasons (`:59, :68`).

**Totals after pass 23: PASS 80, FAIL 0, GAP 3, NOT RUN 2** — three items promoted since pass 20 (C9f,
C9g, C14c) and **no scripted § 7.1 item FAILs**. The three GAPs are the lab's honest limits (C6d, C7c,
C10c), the two NOT RUNs are a report line and a deferral (C3d, C11c), and every PASS with a GAP arm
carries its reason in the row.

Pass 24 (`d9928d9`, ADR-0038) reran C13: **C13 48 PASS / 0 FAIL / 0 GAP** (`live24/C13.out:156`) — the
scoreboard's first zero-GAP C13 pass. What closed is C13c's fourth arm, the `:89` GAP that had read 422
`code=None` at every pass since pass 1 (the publish gate short-circuited on the draft's recorded validation
before re-deriving the finding, `live20/C13.out:88, :89`): `d9928d9` makes that 422 carry
`code=secret_literal_detected`, the response body spells it verbatim (`live24/C13.out:85`, `:88`), and the
arm PASSes as the contract words it — 'the secret finding itself blocks publish — 422
secret_literal_detected — § 2.2's letter exactly' (`:89`). **No row's Verdict column changed** — C13c was
already PASS with that named GAP arm — so the totals recount byte-identically.

**Totals after pass 24: PASS 80, FAIL 0, GAP 3, NOT RUN 2** — unchanged from pass 23: no row promoted, no
new FAIL, and one named GAP arm (C13c's `:89`) closed for good.

**Totals after pass 25: PASS 83, FAIL 0, GAP 2, NOT RUN 0** — three items promoted since pass 24:
**C6d GAP → PASS** (`fa0c0e0`'s dirty-boundary scratch pipeline, driven by the opt-in `leave_dirty`
fixture input, produces the state § 7.1 names — `dirty_seed`'s boundary records `committed=false`, the
retry is refused 409 `code=checkpoint_unavailable`, nothing is reset, zero restore events, no new
attempt), **C3d NOT RUN → PASS** (the negative-control sentence graded on four arms and regraded once
C4 printed in the same process), and **C11c NOT RUN → PASS** (all six structural claims graded from
gates that ran in that one driver process). Three combined processes read **182 PASS / 0 FAIL / 16 GAP
lines**, **70 PASS / 0 FAIL / 8 GAP lines** and **324 PASS / 1 FAIL / 36 GAP lines**; the single FAIL is
C1g's agent-iteration bound (`iterations >= 2` read `1` — the agent fixed the planted test and the
docstring in one iteration), which `90a29c2` corrects to 1..4 for the agent leg: that row stays PASS on
an over-claim correction, not on a retry, and is not yet re-run on `90a29c2`. The two GAPs left (C7c,
C10c) are the ones the lab cannot produce; no NOT RUN rows remain.

**Totals after pass 27: PASS 83, FAIL 0, GAP 2, NOT RUN 0** — unchanged on the Verdict column (recounted
mechanically over it: PASS 83 / FAIL 0 / GAP 2 / NOT RUN 0 over 85 items). Passes 26–27 changed no row's
verdict: pass 26 re-ran C1 on `76a9e64` and read **98 PASS / 0 FAIL / 0 GAP** (`live26/C1.out:211`), which
discharged pass 25's two open notes without promoting anything — C1g was already PASS on `90a29c2`'s
bound correction and is now re-run on it (`live26/C1.out:64-:65`), and `e83913a`'s attempt mirror grants
made the live agent's git work (`live26/_events-C1.txt:14, :16` cite a `git diff` against HEAD where
live25 reported a broken worktree link). Pass 27 ran C1+C2 together on `1b93069` and read
**127 PASS / 0 FAIL / 0 GAP** (C1 98 / C2 29; `live27/C1,C2.out:280`); its weight is off the scoreboard —
the lab journal
after the pass reads 23 `conversation.permission.requested` against 23 `conversation.permission.decided`
(all `status=decided`, `decided_by=node_policy:preapproved_within_sandbox`) over 31
`conversation.tool.call` rows, where the same query on live25 read 0 permission rows against 34 tool
calls — which closes ADR-0036's condition (a) in the lab (see that ADR's addendum) without promoting any
row. `7e6eda3`'s new C1j driver check (every prompt closes with exactly one policy verdict) first ran at
pass 28, where the un-parenthesised query crashed the driver (`live28/C1.out:84`, fixed in `c11d01f`), and
measured PASS at pass 29 — see the pass-30 totals below. The 23/23 read above is later corrected to
attempt-path rows only (`c1c7c19`'s addendum correction).

**Totals after pass 30: PASS 84, FAIL 0, GAP 2, NOT RUN 0** — one item added and promoted since pass 27:
**C1j new → PASS** (pass 29 ran the C1j check — `7e6eda3`, driver fixed in `c11d01f` — live on `d4cd945`:
**C1 101 PASS / 0 FAIL / 0 GAP** (`live29/C1.out:228`), all four C1j arms PASS at `live29/C1.out:97-:100`:
8 permission requests / 8 decisions, every one `status=decided`,
`decided_by=node_policy:preapproved_within_sandbox`, no orphans). Pass 28 died first — C1j's
un-parenthesised `payload->>` crashed the query 30 PASS lines in (`||` binds tighter than `->>`,
`live28/C1.out:84`) — a driver bug fixed in `c11d01f`; no product verdict rides on it. Pass 30 added
off-scoreboard evidence on `c1c7c19`: `deny_probe.sh` (`14b110f`) proves `deny` is enforced live on the
**conversation** path — `live30/deny_probe.out` reads **1 requested / 1 decided (cancelled) / 0 allow /
0 preapproved** and `deny-probe.txt` lands in no workspace, every verdict PASS. (Corrected at pass
32: that filesystem check was vacuous — the conversation workspace is released at turn end, the
journal carries a `workspace.released` row — and the journal shows the write ended `failed`,
"User refused permission to run tool"; re-measured with the journal verdict in
`live32/policy_probe3-deny.out`, every verdict PASS.) After `c1c7c19` the
policy verdict C1j asserts is an **attempt-path** fact: preapproved conversations run in the harness's
auto mode with no per-call verdict (recording a policy decider on that path needs a
`permission_requests.decided_by` schema change + ADR), so ADR-0036 condition (a) is closed **for pipeline
attempts only** (see that ADR's corrected addendum). The two GAPs left (C7c, C10c) are unchanged; no
NOT RUN rows remain.

**Totals after pass 31: PASS 84, FAIL 0, GAP 2, NOT RUN 0** — unchanged from pass 30: the recount
(186 + 70 + 329 + 92 = **677 PASS / 0 FAIL** verdict lines across the four files, zero `FAIL` lines)
promotes no row and moves no verdict. Pass 31 is the first single-build sweep of all 14 gate groups
since the permission and grant fixes: one lab (`c9b0a49`) carrying every fix through pass 30 —
`e83913a`'s mirror grants, `a0fd9e7`/`1b93069`/`c1c7c19`'s conversation permission modes, `90a29c2`'s
C1g bound, `7e6eda3`/`c11d01f`'s C1j — in every driver process at once. The 74 GAP lines reduce to
the arms the rows already name: the two scoreboard GAPs (C7c, C10c), the pre-regrade C3d/C11c lines,
the superseded twin C6d arms, the named GAP arms C5e, C6c, C9 and C14b, and the other row-named
secondary arms (C3a, C4c, C4e, C5h, C7a, C7b, C7d, C8f, C9a, C9e, C9f, C10b, C11, C11b, C14c) —
nothing new is unmeasured; the C9 group's arms simply re-appear because C9 ran again. The two GAPs
left (C7c, C10c) are unchanged; no NOT RUN rows remain.

**Pass 32 (off-scoreboard, ADR-0039 policy decisions measured live on both modes):** lab `324818c`
plus the held UI (committed as `6685f58`). `deny_probe.sh`'s verdict (f) now reads the journal,
not the filesystem: the conversation workspace is released when the turn ends (a
`workspace.released` row for the conversation), so the pass-30 "in no workspace" check was
vacuous and "in exactly one workspace" could never pass (live: `worker matches=0` although the
agent wrote the file). The re-measure (`live32/policy_probe3-deny.out`,
`live32/policy_probe3-preapproved_within_sandbox.out`, both under
`$HOME/.cache/communication-lab/m4-exit/`) is **every verdict PASS** on both modes — deny:
the tool update for `deny-probe.txt` ended `failed` ("User refused permission to run tool")
and no update says "created successfully" for it; preapproved: a tool update says "File
created successfully" naming `preapproved-probe.txt`. No scoreboard row changes.

**Totals after pass 39: PASS 85, FAIL 0, GAP 1, NOT RUN 0** — one item promoted since pass 31:
**C10c GAP → PASS** (the only change to the Verdict column in passes 34–39). Pass 33 ran the M5
browser suite off-scoreboard (`1c1733b`, `live33/m5-suite.out`, 50 passed / 0 failed / 1 deliberate
skip) and moved no row. On 2026-10-17 the owner allowed the M4 lab to use the LLM collective
(`qwen3-8-27b`) for the assistant + model.chat env — the lab's collective wiring is an uncommitted,
owner-approved lab-only compose override; no key is in the repo. Pass 34 (`cf01a11`) ran C10c's
model.chat arm live for the first time, and passes 34–38 read product bugs, not the model: pass 34
FAILed on the worker refusing `temperature: 0` as a non-number (`live34/C10.out:100`, fixed in
`3905f39`); pass 35's attempt closed `interrupted` because the store refused the completion
"completed without a checkpoint volume" — the model.chat node captured no boundary, so every
successful model.chat step in a workspace run was lost (`live35/C10.out:98`, fixed in `269de46`);
pass 36's `invalid_output` was a refusal of the model.chat envelope at `/`, not of the reply
(`live36/C10.out:101`, driver redesigned in `cabade3`); pass 37's valid control failed
`missing property 'json'` because the compiler dropped `config.responseSchema` from the compiled
plan, so no model.chat node ever validated or parsed its reply (`live37/_events-C10.txt:10`, fixed
in `330af07`); pass 38's control failed infra — the collective refuses a constrained
`response_format` (http 400 `response_format_not_supported`, `live38/_events-C10.txt:10`, fixed in
`1b872b8`: local validation only, ADR-0024 note). Pass 39 (`1b872b8`) closes it: **C10
36 PASS / 0 FAIL** (`live39/C10.out:157`) — the malformed reply refused `invalid_output` at
`/json/approved, /json/evidence` with NO `node.attempt.completed`, and the valid control succeeded
with `outputs.json.approved == true` (`:110-:116`). Off-scoreboard evidence from the same lab
window: the W9 assistant answered live for the first time (`6eb0392` made the tool names legal
OpenAI function names — the collective had 400'd every ask — and `37b66a6` fixed the dead
`/approvals` link), and `e2e/tests/m5-assistant.spec.ts` reads **3/3 live**: Ctrl K → Ask, a real
collective answer with its tool calls, every link a real page. Mechanical recount over the Verdict
column: 85 + 0 + 1 + 0 = 86. The only GAP left is C7c (the schema refuses the undeclared field
before the eval-time arm); no NOT RUN rows remain.

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
  and the classification FAILing (`live16/W6.out:63`). **Closed at pass 19: the two product bugs that made W6
  FAIL are gone** — `6e57274` makes the refusal lead with 'prior edits lost, rerun required' (the raw detail
  secondary) and makes the Retry control say it is the operator's manual rerun, and pass 19 measures both
  (`live19/W6.out:63, :71`, gate 14 PASS / 0 FAIL / 0 GAP `:74`). **W6 is PASS.**
- **Closed at pass 20: the scripted restore path works.** `8cc0cf2` captures repo state at `process.exec`
  boundaries too, `20c079b` restores only retried attempts of restore-policy nodes and records modified paths
  even when HEAD stands still, and `3f35115` emits `run.checkpoint_restored` only from the worker that really
  reset the worktree — C6b's reset is measured (`live20/C1,C5,C6.out:422-:426`) and C6c's restored run
  completes (`:431`).
- No longer open as a product question: **C10b is PASS.** "routing never changes during that failure" was
  measured on a graph that skips `/emit_items` by design (`live4/C10.out:58, :76`); `04fb651` scopes the
  assertion to the failing scope's `dependsOn` closure and explains every skip outside it from the run's own
  inputs, and pass 17 proves it — `(none)` route changes on watched nodes (`live17/C10.out:68`),
  `unexplained=(none) unreadable=(none)` beyond them (`:69`). **No scripted § 7.1 item is open as a product
  bug any more** — and the two FAILs the scoreboard then carried are dead: the pass-21 C9 re-run promoted
  both, `run.cancel_requested` journalled before the cancel_run cascade (`live21/C9.out:199`, `fc8b464`)
  and an honest turn terminal behind the takeover (`:287`, `6ddd576`).
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
- ~~C3a/C3c~~ — **both left this group at pass 19** (`6f06bb0` + `2b24738`): the leg builds and consumes its
  OWN 25-child held queue (`live19/C3.out:28, :30`), sees two workers holding attempts at once
  (`:54`), and counts one claim per `/implement` with `max(fencing_token) = claim count` (`:96-:100`).
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
- ~~C9g~~ — **left this group at pass 19 as a FAIL, not a PASS**: `817fcd0` runs the takeover on a live
  `agent.acp` turn (`live19/C9.out:223-:247` — take-control 200, the turn cancel-requested in the same
  transaction, the run `paused{human_takeover}` then resuming on its own), and the one thing that FAILs is the
  turn's terminal journal row (`:248`), fixed in `fc8b464`, not re-run.
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
- ~~C6b/C6c/C6e~~ — **three of the four left this group at pass 20; only C6d stays.** The history is worth
  keeping: passes 16–17 showed `e2de8fa`+`5c03d6c`+`c652f43` running the restore and REFUSING it — both
  `/build_until_verified[1]/implement` attempts dying with `checkpoint_unavailable: ADR-0023 § 6 … repository
  01a14693-866c-7a5e… was not captured at the boundary: its committed state is unrecorded`
  (`live17/_events-C6.txt` seqs 64, 67), the run `failed` (`live17/C6.out:51`) and the leg GAPing because
  nothing was ever leased (`:89`). `8cc0cf2` is what was missing: **`process.exec` boundaries captured no repo
  state at all**, so a deterministic twin could never present a provably-committed boundary. With it in the
  build, pass 20 measures the reset itself (`live20/C1,C5,C6.out:422-:428`), the restored run completing
  (`:431`), and the cross-volume loss inside the scripted gate (`:473-:477`). **What is still open** is C6d
  alone: the lab cannot make a COMMITTED boundary dirty from outside without forging `run_checkpoints.repo_states`
  rows — every row reads `committed=true` (`:400`) — so the `code=checkpoint_unavailable` refusal the contract
  names is never reached (`:404`, the 409 that fires is the run-status door while the ENGINE owns the retry) and
  "the refusal appended no new attempt" is unattributable (`:407`). Its behavioural arms PASS: 409 + nothing
  reset + zero restore events (`:403, :405, :406`).
- ~~W5 `live9/W5.out:31`, W6 `live9/W6.out:29-31`~~ — W5 left this group for good at **pass 14**: the kill
  lands and § 7.1's interrupted wording renders (`live14/W5.out:46`, `f010fe2`). **W6 left this group at pass
  17 as a FAIL, not a PASS** — the state exists now (`error_class='workspace_lost'`, `live17/W6.out:61`; chip
  and copy rendering `:67, :68`), so the leg grades product copy and a control instead (`:63, :71`) — and
  `6e57274` turned those two into PASSes at **pass 19** (`live19/W6.out:63, :71`, gate 14/0/0 at `:74`).
  W2 left this group at pass 9 and holds: its mid-lease core arm PASSes again (`live11/W2.out:31`) and its two
  remaining `conversation.turn.*` GAPs (`:77, :80`) are fixture shape — a `process.exec` twin owns no ACP turn,
  and `conversation.*` sits outside `M4_RUN_EVENT_TYPES` (`RunInspector.tsx:720`, ADR-0014 § 8).
- ~~C3a~~ `live6/C3.out:29` — promoted at **pass 19**: `6f06bb0` gave the leg its own 25-child `hold_seconds`
  queue instead of pointing at C8's (`live19/C3.out:28, :30`), and contention is measured — peak in-flight=2
  over 50 commit points (`:54`). Its one remaining GAP arm is the hand-out read (`:53`, no `worker\|count` rows
  for the fan-out's children).
- ~~C5f~~ left this group at **pass 13/15** — HEAD is readable across the restart again and does not move
  (`live15/C5.out:92-:94`, PASS, re-proven `live17/C5.out:90-:92`). **C5h is a different animal now**: the
  scratch pipeline that authors a `maxAttempts: 1` held node is committed (`059d132`) and ran live at passes
  16–17, every arm of the § 7.1 claim PASSing — budget 1 (`live17/C5.out:149`), attempt `interrupted` (`:150`),
  the automatic retry refused with zero `retry_scheduled` rows (`:151`), the run `failed | node_execution_failed:/implement`
  (`:152`), the manual retry accepted (`:153`) and appended as attempt 2 (`:154`). The row still counts as a GAP
  only because the leg prints its **stale precondition** first ("the killed node is authored with
  attempt_limit=2 in the § 7.0 twin", `:111`) and the gate summary counts it (`:159` `GAP=4`) — drop that line
  and C5h promotes. **`13f0e0f` dropped that line and pass 20 promoted C5h** (`live20/C1,C5,C6.out:338-:343`,
  the precondition now a NOTE at `:346`). The same pass-planning artifact is behind the `C5g`/`C6c` "no C1 key
  set in this pass" GAPs (`live17/C5.out:108`): each gate ran in its own driver process after its own reset +
  seed, so nothing downstream of C1 could hold C1's key set until the driver carried it across gates —
  **`2b24738` did exactly that and both arms PASS at pass 20** (`:297-:298`, `:433-:434`).
  ~~C4e~~ left at **pass 18** (`2f0fe1f`'s `agent.acp` fence finally ran: `live18/C4.out:76, :86-:93`, its one
  GAP being the missing pre-unpause transcript at `:96`); C6d's uncommitted-boundary precondition still GAPs,
  now over readable `repo_states` that all say `committed=true` (`live20/C1,C5,C6.out:400`). C8 is
  now **38 PASS / 0 FAIL / 2 GAP** (`live11/C8.out:128`): C8e's stop/fail_after_all GAP is closed (`:78-:92`,
  `b2bfe62` + `d8b927c`) and the two that remain are C8f's unpublished depth chain (`:112, :113`, fixture bug
  above).
- C7b's artifact arm `live4/C7.out:59` (no artifact rows on the exhausted run), C7a's scope-iterations
  row `:70`, C7c's eval-time arm `:124` (the schema refuses the undeclared field first, so the
  `predicate_error` half is only proven offline), C7d's transcript half `:77` (a `process.exec` twin has
  no prompt to echo `previous`).
- ~~C9f~~ `live4/C9.out:112-114` — **left this group at pass 19 as a FAIL, not a PASS**: `13f0e0f`+`817fcd0`
  publish a short-deadline (60s) revision per mode rather than faking the clock in SQL, and all three modes run
  (`live19/C9.out:144-:173, :195-:202`). What FAILs is one journal row: no `run.cancel_requested` ahead of the
  cancel_run cascade (`:199`) — fixed in `fc8b464` (advancer + `advancer_test.go` + `gate_cancel_run.yaml` +
  `m4_gate_cancel_run_test.go`), **not re-run**. Its GAP arms are fixture shape: the deterministic twin's `/plan`
  has outputs, not artifacts (`:161, :190`), and the re-request's moved deadline read `None` (`:168`).
- C10b's two GAP arms `live17/C10.out:64` (no **mid**-failure sample of the until scope's routing) and `:75`
  ("retry answers validly the second time") — the shipped fixture helper cannot answer malformed-then-valid and
  `make_fixture_repo.sh` must not be edited; ~~C10c `:78` — no model.chat provider endpoint
  (ADR-0024's first sacrifice)~~ — **left this group at pass 39**: the owner allowed the lab to use
  the LLM collective (`qwen3-8-27b`) as the model.chat endpoint (an uncommitted, owner-approved
  lab-only compose override; no key is in the repo), and after four product fixes (`3905f39`,
  `269de46`, `330af07`, `1b872b8`) the model.chat arm ran live — the boundary refused the instructed
  malformed reply's content at `/json/approved, /json/evidence` with the valid control succeeding in
  the same scratch run (`live39/C10.out:110-:116`). The item's core claim PASSed at pass 17.
- C11b's `sandbox.verified` truthfulness arm `live4/C11.out:39` — 7 rows, all `verified=true`, so there is
  no false row to catch reporting wrongly.
- ~~C13c's "the detector itself is what blocked publish" arm `live4/C13.out:89`~~ — **left this group at
  pass 24.** `d9928d9` (ADR-0038) makes the publish 422 for a recorded secret finding carry
  `code=secret_literal_detected` instead of reading `code=None` off the draft's short-circuited validation,
  so the finding itself is finally observable as what blocked publish (`live24/C13.out:88-:89`).
- ~~C13f~~ `live4/C13.out:128` — **left this group at pass 20.** `28d25ba` gives the gate its own browser arm:
  admin signs in and `/ops` renders 'Resource limits: not implemented — runs have no cpu, memory or disk caps in
  this release.' (`live20/C13.out:129`) with no limit column anywhere (`:130`), while the API half keeps
  PASSing (`:127`).
- C14b's advisory-lock handover (`live22/C14.out:59`, `live23/C14.out:59` — the log mark is released every
  tick so no cross-restart acquisition is observable, and pass 23 could not read the serve logs at all — an
  unfalsifiable or unobserved probe GAPs instead of FAILing) and the
  forced simultaneous two-replica advance (`live22/C14.out:68`, `live23/C14.out:68`; needs a store seam § 7.1
  disclaims). ~~C14c~~ — **left this group at pass 23 as a PASS**: `9af17dc`'s per-replica variables were
  finally set at bring-up (`COMMUNICATION_PIPELINE_SCHEDULER_B=off`), `555eed0` fixed the log parser that had
  misread api-b as `on` at pass 22, and the off replica provably accepted runs and advanced nothing until
  api-a's engine picked them up (`live23/C14.out:81, :94-:98`) — ADR-0023's rollback story is measured.
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
and W11 (`19175b3`, `live14/W11.out:36`) turned to PASS. **Pass 17 moved W6 from GAP to FAIL and pass 19 moved
it to PASS** — `efb82bd`+`04fb651` produced the cross-volume loss and classed it (`live17/W6.out:61, :62, :64`),
and `6e57274` fixed the two copy/control bugs that FAILed (`live19/W6.out:63, :71`), the leg ending
**14 PASS / 0 FAIL / 0 GAP** (`:74`). **All eleven § 7.2 legs are now PASS.** W11's scripted precondition stays
proven: C8's tree renders 25 distinct children at
`live11/C8.out:64-68`. W6's scripted substitute (C6e) is proven too — pass 20 produces the same loss inside the
scripted gate (`live20/C1,C5,C6.out:473-:477`).
