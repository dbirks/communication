# M4 exit status — an honest scoreboard from the live evidence

Contract authority: `docs/m4-contract.md` § 7.1 (gates C1–C14, sub-cases named by letter) and § 7.2
(Playwright legs W1–W11). Evidence root: `$HOME/.cache/communication-lab/m4-exit/` — each
`<GATE>.out` is the driver's (`e2e/m4/e2e_m4_exit.py`) full output for one gate in one pass.

| pass | directory | lab commit | coverage |
|---|---|---|---|
| pass 1 | `live/` | `4245c48` | C1–C14, W1, W3, W7 |
| pass 2 | `live2/` | `9134319` | C1–C14, W1, W3, W7 |
| pass 3 | `live3/` | `fbf4fd5` | C6, C7, C10, C12, W3 |

Reading rules. The row takes the **newest pass in which the item ran**. Verdicts come from
`grep -nE '^\s*(PASS|FAIL|GAP)\b' <file>` and nothing is quoted that was not read.

- **PASS** — every arm of the item that ran emitted a literal `PASS`, and no arm emitted `FAIL`.
- **FAIL** — at least one arm emitted a literal `FAIL` line.
- **GAP** — the item's core arm emitted `GAP`: the lab could not produce the state, so it is unmeasured, not passing.
- **NOT RUN** — no verdict line exists for the item (blocked behind an upstream GAP/crash, or the driver has no leg).

A `PASS` line never substitutes for the item as a whole: where only part of a sub-case ran, the row's
note says which arm produced the verdict and which never did. Gate-level `FAIL=n GAP=m` summary lines
count driver verdicts, of which a sub-case often has several; the totals below count § 7 items.

## § 7.1 scripted gates + § 7.2 playwright legs

| Item | What it proves | Verdict | Measured at | Evidence |
|---|---|---|---|---|
| C1a | run POST returns 201 queued | PASS | pass 2 @ 9134319 | live2/C1.out:24 |
| C1b | designated approver's decide posts 200 | PASS | pass 2 @ 9134319 | live2/C1.out:27 |
| C1c | run reaches terminal `completed` | FAIL — agent arm ended `failed`; twin arm completed (live2/C1.out:67) | pass 2 @ 9134319 | live2/C1.out:28 |
| C1d | full node key set, statuses, execution locations | PASS | pass 2 @ 9134319 | live2/C1.out:83 |
| C1e | digests, checkpoint count, attempt_count=1 | FAIL — crashed on `runs.digest_scope`; run_inputs arm PASSed (live2/C1.out:86) | pass 2 @ 9134319 | live2/C1.out:87 |
| C1f | artifact bytes readable, redaction_count 0 | NOT RUN — checks after the crash never ran | — | live2/C1.out:97 |
| C1g | run.completed carries result_bindings | NOT RUN — never emitted a verdict | — | live2/C1.out:97 |
| C1h | journal sequence contiguous for the run | NOT RUN — never emitted a verdict | — | live2/C1.out:97 |
| C1i | replay reproduces the key set and plan_digest | GAP — neither twin leg reached `completed` to compare | pass 1 @ 4245c48 | live/C1.out:134 |
| C2a | secret reaches only the live authorized process | GAP — no /implement attempt was ever held | pass 2 @ 9134319 | live2/C2.out:63 |
| C2b | worker unmounts the env at the node boundary | NOT RUN — blocked behind C2a's GAP | — | live2/C2.out:63 |
| C2c | sentinel absent from every durable surface | GAP — only the encrypted-store arm ran (live2/C2.out:26) | pass 2 @ 9134319 | live2/C2.out:63 |
| C2d | reviewer prompt and tool output carry no secret | NOT RUN — blocked behind C2a's GAP | — | live2/C2.out:63 |
| C3a | two workers contend on a deep queue | GAP — needs the C8 fan-out run, no driver leg | pass 2 @ 9134319 | live2/C3.out:29 |
| C3b | never two live claims of one attempt | PASS | pass 2 @ 9134319 | live2/C3.out:32 |
| C3c | one /implement claim, one fencing token drawn | GAP — no claimed /implement row exists; sequence arm PASSed (live2/C3.out:39) | pass 2 @ 9134319 | live2/C3.out:38 |
| C3d | negative control sentence recorded | NOT RUN — a report line, not an assertion (C4 is the proof) | — | live2/C3.out:44 |
| C4a | a live lease exists to freeze | GAP — no attempt held a lease in 300s | pass 2 @ 9134319 | live2/C4.out:48 |
| C4b | frozen lease becomes interrupted with a retry | NOT RUN — blocked behind C4a | — | live2/C4.out:48 |
| C4c | a stale owner cannot publish success | NOT RUN — blocked behind C4a | — | live2/C4.out:48 |
| C4d | replacement attempt succeeds, run completes | NOT RUN — blocked behind C4a | — | live2/C4.out:48 |
| C4e | fenced turn appends no transcript rows | NOT RUN — blocked behind C4a | — | live2/C4.out:48 |
| C5a | a live attempt exists to SIGKILL | GAP — nothing running within 300s | pass 2 @ 9134319 | live2/C5.out:48 |
| C5b | kill reads interrupted, never completed | NOT RUN — blocked behind C5a | — | live2/C5.out:48 |
| C5c | checkpoints and artifacts survive the kill | NOT RUN — blocked behind C5a | — | live2/C5.out:48 |
| C5d | same-volume workspace is reclaimed, not rebuilt | NOT RUN — blocked behind C5a | — | live2/C5.out:48 |
| C5e | retry posts from the last checkpoint | NOT RUN — blocked behind C5a | — | live2/C5.out:48 |
| C5f | continue_workspace is the observed default | NOT RUN — blocked behind C5a | — | live2/C5.out:48 |
| C5g | retry appends, never rewrites history | NOT RUN — blocked behind C5a | — | live2/C5.out:48 |
| C5h | exhausted budget fails the run honestly | NOT RUN — blocked behind C5a | — | live2/C5.out:48 |
| C6a | revision carrying retry.workspacePolicy | GAP — splices PASSed (live3/C6.out:27) but the doc was refused at validate | pass 3 @ fbf4fd5 | live3/C6.out:37 |
| C6b | restore_checkpoint really resets the worktree | NOT RUN — blocked behind C6a | — | live3/C6.out:37 |
| C6c | restore-mode retry completes the run | NOT RUN — blocked behind C6a | — | live3/C6.out:37 |
| C6d | dirty boundary refuses, resets nothing | NOT RUN — blocked behind C6a | — | live3/C6.out:37 |
| C6e | cross-volume loss says recovery_lost | NOT RUN — blocked behind C6a | — | live3/C6.out:37 |
| C7a | until_exhausted ends the run after 3 iterations | NOT RUN — re-authored doc never validated, no exhaustion run | — | live3/C7.out:41 |
| C7b | per-iteration evidence stays readable | NOT RUN — blocked behind C7a | — | live3/C7.out:41 |
| C7c | indeterminate predicate is predicate_error | NOT RUN — no exhaustion run to grade | — | live3/C7.out:41 |
| C7d | carryForward observed across iterations | NOT RUN — only the authored witness PASSed (live3/C7.out:32) | — | live3/C7.out:41 |
| C8a | zero-item fan-out succeeds and completes | FAIL — gate crashed (NameError c8_sql); POST arm PASSed (live2/C8.out:9) | pass 2 @ 9134319 | live2/C8.out:11 |
| C8b | 25 children, one run each, depth 1 | NOT RUN — gate aborted, later checks never ran | — | live2/C8.out:18 |
| C8c | maxConcurrency 3 measured from the journal | NOT RUN — gate aborted | — | live2/C8.out:18 |
| C8d | one failing child, siblings preserved | NOT RUN — gate aborted | — | live2/C8.out:18 |
| C8e | stop / fail_after_all child policies | NOT RUN — gate aborted | — | live2/C8.out:18 |
| C8f | depth guard refuses self-invocation | NOT RUN — gate aborted | — | live2/C8.out:18 |
| C8g | parent cancel cascades to every child | NOT RUN — gate aborted | — | live2/C8.out:18 |
| C8h | detach cancel policy is refused at validate | NOT RUN — gate aborted | — | live2/C8.out:18 |
| C9a | gate waits as a row with zero attempts | PASS — restart arm GAPped (live2/C9.out:43) | pass 2 @ 9134319 | live2/C9.out:32 |
| C9b | non-approver refused, gate unmoved | PASS | pass 2 @ 9134319 | live2/C9.out:55 |
| C9c | approver removed from project cannot decide | PASS | pass 2 @ 9134319 | live2/C9.out:76 |
| C9d | two simultaneous decides, exactly one winner | PASS | pass 2 @ 9134319 | live2/C9.out:94 |
| C9e | rejection is a business outcome, not an error | PASS — causal skip arm GAPped (live2/C9.out:111) | pass 2 @ 9134319 | live2/C9.out:107 |
| C9f | on_timeout arms expire, re-request, cancel | GAP — seed authors deadlineSeconds 86400; only "armed" PASSed (live2/C9.out:39) | pass 2 @ 9134319 | live2/C9.out:112 |
| C9g | human takeover pauses and resumes the run | GAP — no live mid-turn attempt to take over | pass 2 @ 9134319 | live2/C9.out:132 |
| C10a | malformed reply fails as invalid_output | GAP — authored doc never validated (type switch PASSed, live3/C10.out:27) | pass 3 @ fbf4fd5 | live3/C10.out:39 |
| C10b | routing never changes during that failure | NOT RUN — blocked behind C10a | — | live3/C10.out:39 |
| C10c | model.chat variant fails identically | NOT RUN — blocked behind C10a | — | live3/C10.out:39 |
| C11a | collector sink is real, injected run starts | PASS | pass 2 @ 9134319 | live2/C11.out:24 |
| C11b | injection verbatim, nothing egresses | FAIL — both failures are broken probes; the egress-zero arms PASSed (live2/C11.out:34) | pass 2 @ 9134319 | live2/C11.out:31 |
| C11c | structural mitigation holds | NOT RUN — C11 defers the claim to C12b's evidence | — | live3/C12.out:43 |
| C12a | CEL subset cannot be widened by authoring | PASS | pass 3 @ fbf4fd5 | live3/C12.out:43 |
| C12b | expression and fan-out budgets refuse | FAIL — evaluated 1001-item cause is generic, not fanout_items_exceeded; compiler arms PASSed (live3/C12.out:55) | pass 3 @ fbf4fd5 | live3/C12.out:70 |
| C12c | a running run stays pinned to its revision | FAIL — a node after the publish moved off the pinned plan; digest/re-pin arms PASSed (live3/C12.out:94) | pass 3 @ fbf4fd5 | live3/C12.out:100 |
| C12d | byte-identical republish is 409 | PASS | pass 3 @ fbf4fd5 | live3/C12.out:128 |
| C12e | revision and plan digests separate correctly | PASS | pass 3 @ fbf4fd5 | live3/C12.out:149 |
| C13a | seven deferred kinds refused, naming M5/M6 | PASS | pass 2 @ 9134319 | live2/C13.out:35 |
| C13b | config typos refused at highlightable locations | PASS | pass 2 @ 9134319 | live2/C13.out:49 |
| C13c | secret literal blocks publish, value redacted | PASS — "the detector itself blocks" arm GAPped (live2/C13.out:89) | pass 2 @ 9134319 | live2/C13.out:86 |
| C13d | declared CEL roots compile, reserved root refused | PASS | pass 2 @ 9134319 | live2/C13.out:102 |
| C13e | continue_live and run.override refused | PASS | pass 2 @ 9134319 | live2/C13.out:120 |
| C13f | no resource-limit columns anywhere | GAP — API arm PASSed (live2/C13.out:127); the ops page's wording is unproven | pass 2 @ 9134319 | live2/C13.out:128 |
| C14a | API replicas roll, the stream continues | FAIL — SSE/roll arms PASSed (live2/C14.out:64) but the run ended 'failed', not completed | pass 2 @ 9134319 | live2/C14.out:71 |
| C14b | two replicas cannot commit one transition twice | FAIL — advisory-lock probe unfalsifiable; ledger arms PASSed (live2/C14.out:58), terminal group-by GAPped (live2/C14.out:57) | pass 2 @ 9134319 | live2/C14.out:63 |
| C14c | SCHEDULER=off leaves a run queued | GAP — the flag is inert in the server (findings P2) | pass 2 @ 9134319 | live2/C14.out:73 |
| W1 | New run form comes from spec.inputs | PASS | pass 2 @ 9134319 | live2/W1.out:37 |
| W2 | live stream renders iterations, not duplicate nodes | NOT RUN — no driver leg (`_playwright_stub`) | — | e2e/m4/e2e_m4_exit.py (w2 stub) |
| W3 | gate card: roles, countdown, approve, bob has no button | PASS | pass 3 @ fbf4fd5 | live3/W3.out:48 |
| W4 | pinned-digest notice after a mid-run publish | NOT RUN — no driver leg (`_playwright_stub`) | — | e2e/m4/e2e_m4_exit.py (w4 stub) |
| W5 | kill renders honest interrupted wording | NOT RUN — no driver leg (`_playwright_stub`) | — | e2e/m4/e2e_m4_exit.py (w5 stub) |
| W6 | cross-volume run says "prior edits lost" | NOT RUN — no driver leg (`_playwright_stub`) | — | e2e/m4/e2e_m4_exit.py (w6 stub) |
| W7 | ops page counters and per-worker load | FAIL — queued_unbindable_runs never counted the bound run; every counter arm PASSed (live2/W7.out:29) | pass 2 @ 9134319 | live2/W7.out:51 |
| W8 | validate panel renders located errors by source | NOT RUN — no driver leg (`_playwright_stub`) | — | e2e/m4/e2e_m4_exit.py (w8 stub) |
| W9 | cross-project deep links 404 with zero leakage | NOT RUN — no driver leg (`_playwright_stub`) | — | e2e/m4/e2e_m4_exit.py (w9 stub) |
| W10 | stream continuity across a replica roll | NOT RUN — no driver leg (`_playwright_stub`) | — | e2e/m4/e2e_m4_exit.py (w10 stub) |
| W11 | child tree renders, internals absent from the DOM | NOT RUN — no driver leg (`_playwright_stub`) | — | e2e/m4/e2e_m4_exit.py (w11 stub) |

Totals: 85 items (74 § 7.1 sub-cases + 11 § 7.2 legs) — PASS 20, FAIL 9, GAP 13, NOT RUN 43.

## What blocks the M4 exit

Finding ids (`P*`, `D*`, `RC*`) are `docs/m4-live-findings.md`; "fixed in `<sha>`, not re-run" means the
commit landed after the pass that produced the verdict above.

**Product bugs — open**

- C12b `live3/C12.out:70` — a 1001-item evaluated fan-out fails with `node_execution_failed:/emit`, not
  `fanout_items_exceeded`. Named as a product finding in `4cdedca`; no fix commit since.
- C12c `live3/C12.out:100` — a node after the mid-run publish moved off the pinned plan. Same status:
  named in `4cdedca`, no fix commit.
- C1c `live2/C1.out:28` — the agent-arm run's exhausted `until` escalates as `node_execution_failed:/build_until_verified`;
  P3 (`failScope` cause) is unfixed and is what C7a will hit first.
- C14c `live2/C14.out:73` — `COMMUNICATION_PIPELINE_SCHEDULER` is inert (P2: no Go reads it). C14c stays
  GAP until the flag exists, so ADR-0023's rollback story is unproven.
- C1e `live2/C1.out:87` — the RC1/P1 double `attempt_count` (which halved every retry budget and made
  C5e's retry unreachable) is **fixed in `0a0e6bb`, not re-run**: C1 last ran at `9134319`, before it.

**Driver bugs — open (the probes are broken, not the product)**

- C6a / C7a / C10a `live3/C6.out:37`, `live3/C7.out:41`, `live3/C10.out:39` — the splices were fixed in
  `f53cfff` (the PASS lines above prove it), but the stamped `metadata.name` (`m4x-c6-restore-T083004Z`)
  still violates `^[a-z][a-z0-9.-]{0,127}$`, so C6b–C6e, C7a–C7d and C10a–C10c have no run at all. No
  committed fix as of `87baaa2`.
- C8a `live2/C8.out:11` — `NameError: name 'c8_sql' is not defined` killed the whole gate: C8b–C8h never
  ran, and C3a/C3c depend on C8's deep queue. Not re-run since.
- C11b `live2/C11.out:31` — D2: the verbatim-vector probe scans digested `approval%` event payloads; still
  reads them at the current driver.
- C11b `live2/C11.out:38` — D3: the report-honesty probe opens only `docs/compatibility/SANDBOX.md`.
- C14b `live2/C14.out:57` and `:63` — D4 (invalid terminal-event group-by) and D6 (advisory-lock probe
  nothing can satisfy). C14b's real safety proof (the ledger arms) already PASSes.
- W7 `live2/W7.out:51` — `queued_unbindable_runs` stayed 0 because the driver wrote the affinity by SQL and
  the run was claimed anyway; `docs/m4-live-findings.md` does not classify this FAIL. Needs a re-run
  before it is called either a product or a driver bug.

**Honest lab GAPs — the state does not exist to measure**

- C2a, C2c, C4a, C5a `live2/C2.out:63`, `live2/C4.out:48`, `live2/C5.out:48` — no attempt was ever held by a
  worker inside the poll window (RC4: gates ran concurrently on one stack). These are the milestone's
  exit sentence, so they need a quiet, sequential re-run — C4b–C4e and C5b–C5h ride on them.
- C3a, C3c `live2/C3.out:29`, `live2/C3.out:38` — contention is authored on the C8 fan-out run.
- C9f `live2/C9.out:112` — the seeded gate's 86400 s deadline cannot expire; C9g `live2/C9.out:132` — no
  live mid-turn attempt exists to take over.
- C11b `live2/C11.out:37` (sandbox.verified labels) and C11's agent arm `live2/C11.out:41` — a real Claude
  turn is outside the deterministic lab.
- C13f `live2/C13.out:128` — the ops page's "resource limits: not implemented" wording is unrendered.
- C14b's forced simultaneous two-replica advance `live2/C14.out:72` — needs a store seam § 7.1 disclaims.
- C1i `live/C1.out:134` and the cross-variant key set `live/C1.out:135` — derived: identity is only
  assertable over two runs that both reached `completed`.

**No driver leg — W2, W4, W5, W6, W8, W9, W10, W11**

`w1`, `w3` and `w7` are the only implemented Playwright legs; the other eight are `_playwright_stub`
placeholders in `e2e/m4/e2e_m4_exit.py`, so they are NOT RUN, not GAPs. W5 (kill seen in the browser),
W6 (cross-volume loss wording) and W11 (no fencing token in the DOM) have no scripted substitute — C5,
C6e and C8's scripted arms are themselves blocked above.
