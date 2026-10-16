# M4 live findings — classifying every remaining FAIL/GAP from the first full pass

Evidence: `$HOME/.cache/communication-lab/m4-exit/live/<GATE>.out`, produced by
`e2e/m4/e2e_m4_exit.py` against a lab built from commit `4245c48`. Contract authority:
`docs/m4-contract.md` § 7.1. Fixes already landed after the lab commit (`git log --oneline
4245c48..HEAD`): `e82a23b` validator oneOf branches, `ac2faa3` worker claim-slot release,
`8d05235` gate card with no attempts, `4c4ea6a` `model.chat` bindings.

## Root causes (read before the table)

- **RC1 — `node_executions.attempt_count` is counted twice per attempt.** The engine bumps it
  when it queues the attempt (`internal/pipelines/runtime/advancer.go:654`, `retry.go:214`) and
  persists that value (`internal/store/postgres/runtimestore.go:822`); `ClaimAttempts` then bumps
  it again (`internal/store/postgres/attempts.go:314`). Every single-attempt worker node in the
  pass therefore reads `att=2` (`W7`-era evidence: `C1.out:34-45`, `C2.out:34-47`, `C11.out:34-44`,
  `C9.out:128`), while an attempt that was queued but never claimed reads `att=1`
  (`C5.out:34`, `C14.out:76`). Violates § 7.1 C1e line 958 (`attempt_count … # 1`) and halves every
  retry budget: `advancer.go:578` refuses a retry once `AttemptCount >= AttemptLimit`, so a node
  authored `maxAttempts: 2` gets **one** real try and `C5`'s "retry from the last checkpoint"
  becomes unreachable.
- **RC2 — worker claim slots leaked (fixed since).** `ac2faa3`'s own message describes exactly the
  ledger state the pass ended in: `W7.out:25` — `queued:6, leased:0, running:0`, `worker-a
  active_attempts 3/3`, `worker-b 1/1`, `oldest_queued_age_seconds 4567`. With the counters leaked,
  `wr.active_attempts < wr.capacity` is false forever, so ready attempts are never claimed. This
  is the stall behind `C1 twin(seed)`, `C14a`, `C8` and the `C4`/`C5` "no live attempt" GAPs.
- **RC3 — the document the gates splice is the API's regenerated YAML, not the fixture's authored
  bytes.** Route 14 regenerates from `canonical_document` (§ 7 line 135, 519) through
  `go.yaml.in/yaml/v3` (`internal/store/postgres/m4api.go:1069`): 4-space indent, sequence bullets
  indented under their key, and **keys alphabetical**, so `metadata.name` is never at two spaces and
  `- id: implement` / `- id: review` never exist as a bullet's first key. The C6/C7/C10 splice
  regexes assume the fixture formatting, so every re-authored revision refuses to build.
- **RC4 — gates ran concurrently against one stack** (`C6/C7/C10/C11` all finished within the same
  minute; `C1` while `C4`/`C9` restarted workers), so fault-injection gates and worker capacity are
  shared. Any verdict that needs a *quiet* cluster or a live lease is suspect until re-run
  sequentially.

## Table

| gate | label (≤60) | class | evidence | fix owner |
|---|---|---|---|---|
| C1 | agent: terminal status completed (C1c) | ENVIRONMENT | `C1.out:28` | re-run; then agent-profile owner |
| C1 | twin(seed): terminal within 600s cap | FIXED SINCE (RC2, `ac2faa3`) | `C1.out:96` | re-run |
| C1 | twin(replay): terminal status completed | PRODUCT (RC1) | `C1.out:101` | `internal/store/postgres/attempts.go` |
| C1 | cross-variant key set identical | cascade of the two above | `C1.out:135` | — |
| C1 | C1i twin replay identity | HONEST GAP (derived) | `C1.out:134` | re-run |
| C6 | C6a restore_checkpoint spliced onto /implement | DRIVER BUG (RC3) | `C6.out:30` | `e2e/m4/e2e_m4_exit.py` |
| C6 | C6a the single splice applied cleanly | DRIVER BUG (RC3) | `C6.out:31` | driver |
| C6 | seed twin document is not the shape C6 splices | DRIVER BUG (RC3) | `C6.out:34` | driver |
| C7 | implementer is the fixture's no-op step | DRIVER BUG (RC3) | `C7.out:33` | driver |
| C7 | every required splice applied | DRIVER BUG (RC3) | `C7.out:34` | driver |
| C7 | seed twin document is not the shape C7 splices | DRIVER BUG (RC3) | `C7.out:37` | driver |
| C8 | (no verdicts: cut at 1500 s with 1 PASS) | DRIVER BUG + ENVIRONMENT | `C8.out:9-10` | driver caps + RC2 |
| C10 | reviewer's declared output type was switched | DRIVER BUG (RC3) | `C10.out:30` | driver |
| C10 | every required splice applied | DRIVER BUG (RC3) | `C10.out:31` | driver |
| C10 | twin document is not the shape C10 splices | DRIVER BUG (RC3) | `C10.out:34` | driver |
| C11 | injected-body twin run: terminal completed | PRODUCT (RC1) | `C11.out:28` | `attempts.go` |
| C11 | injected line reaches the downstream prompt verbatim | DRIVER BUG | `C11.out:63` | driver |
| C11 | report spells network_enforced=false | DRIVER BUG | `C11.out:70` | driver |
| C11 | sandbox.verified rows report enforcement truthfully | HONEST GAP | `C11.out:69` | re-run |
| C11 | agent arm (live Claude turn) | HONEST GAP | `C11.out:73` | later |
| C14 | journal slice stays strictly ascending | DRIVER BUG | `C14.out:48` | driver SQL |
| C14 | no duplicated terminal event (group-by) | DRIVER BUG | `C14.out:50-57` | driver SQL |
| C14 | advisory lock moves to a surviving replica | DRIVER BUG | `C14.out:63` | driver |
| C14 | run terminal within the 900s cap | FIXED SINCE (RC2) | `C14.out:100` | re-run |
| C14 | run reaches 'completed' | FIXED SINCE (RC2) | `C14.out:101` | re-run |
| C14 | the two-replica race is NOT forced | HONEST GAP | `C14.out:102` | later |
| C14 | C14c SCHEDULER=off on one replica | PRODUCT BUG (flag inert) | `C14.out:103` | `cmd/communication/serve.go` |
| C1* | run.failed_cause for an exhausted until | PRODUCT BUG (latent) | `C1.out:30` | `internal/pipelines/runtime/advancer.go` |

## PRODUCT bugs

### P1 — `attempt_count` is bumped twice per attempt (`C1 twin(replay)`, `C11`, and latent in every gate)

```
  FAIL  twin(replay): terminal status completed (§ 7.1 C1c) — observed 'failed'
    failed cause=node_execution_failed:/publish_verified …
    /publish_verified artifact.publish worker interrupted - att=2
    4532 node.attempt.started 18625635-… 4533 artifact.created 18625635-… 4596 node.attempt.interrupted 18625635-…
```

One attempt id appears in the journal (`18625635…` start → created → interrupted), yet the ledger
row reads `att=2`. Same shape in `C2.out:46` and `C11.out:44/89`. Contract § 7.1 C1d/C1e
(lines 949-958) requires `attempt_count` to be the number of attempts — `/build_until_verified[2]/test`
must read `1`, and every successful worker node in this pass read `2` while an unclaimed queued
node read `1` (`C5.out:34`, `C14.out:76`) — the exact signature of `queue +1, claim +1`.

Consequence beyond the ledger: `advancer.go:578` gates the retry on
`row.AttemptCount < row.AttemptLimit`, so with the inflation a `maxAttempts: 2` node has already
spent its budget after one attempt. An interrupted `artifact.publish` therefore fails the run
instead of arming the retry the exit sentence ("validated state after crash/retry") is about —
`C5e`'s retry row is unreachable while this stands.

**Fix brief.** In `internal/store/postgres/attempts.go` `ClaimAttempts` (~line 314) drop
`attempt_count = attempt_count + 1` from the `UPDATE node_executions SET status = 'leased' …`
statement: the engine already counted the attempt when it queued it and persisted the count through
`updateNodeTx` (`runtimestore.go:822`), and `runtime_read.go:367` hydrates that same column, so the
claim's bump is a pure double count. Keep `status`/`ready_at`. Also correct the comment in
`internal/store/postgres/m4_takeover_test.go:490-492`, which documents the inflation as intended.
**Proves it:** a new store test next to `m4_active_release_test.go` — queue one worker node, claim,
begin, finish — asserting `node_executions.attempt_count = 1` and
`max(attempts.attempt_number) = 1`; then a second case that interrupts attempt 1 on a
`maxAttempts: 2` node and asserts a *second* attempt row appears (today the advance refuses it). A
live re-run of `C1` must print `att=1` on every single-attempt node and satisfy `C1e`.

### P2 — the engine never reads `COMMUNICATION_PIPELINE_SCHEDULER` (`C14c`)

```
  GAP   C14c COMMUNICATION_PIPELINE_SCHEDULER=off on one replica — compose.m4.yml reads the flag
        from ONE shell variable shared by api-a and api-b …
```

The stated reason is not the blocker: `grep -rn "PIPELINE_SCHEDULER" --include=*.go .` returns
**nothing** — the variable exists only in `compose.m4.yml:72,82`. `cmd/communication/serve.go:570-578`
starts the M4 driver unconditionally, so `off` is inert and § 7.1 C14c (line 1322) plus ADR-0023's
rollback story ("with `COMMUNICATION_PIPELINE_SCHEDULER=off` the advancer and the attempt claimer do
not start, runs stay `queued`") are unimplemented, not unmeasurable.

**Fix brief.** Read the flag in `cmd/communication/serve.go` alongside `COMMUNICATION_REPLICA_NAME`
(accept `on|off`, default `on`, refuse anything else at startup); with `off`, do not start
`m4Driver.Run`, and make the run/approval routes skip `Trigger`. Owner: `cmd/communication`,
`internal/store/postgres/m4driver.go` (a `Disabled` constructor guard is the honest seam).
**Proves it:** an integration test that boots `serveStack` with the flag off and asserts a posted run
stays `queued` with no claim, then that a second stack with the flag on advances it — and the `C14c`
arm of the driver, which needs a per-container `up -d` (a lab step § 7.0 permits once the flag works).

### P3 — an exhausted `until` fails the run with a generic cause (latent, will break `C7a`)

```
  FAIL  agent: terminal status completed (§ 7.1 C1c) — observed 'failed'
    failed cause=node_execution_failed:/build_until_verified
```

All four iterations' `implement`/`test`/`review` rows are `succeeded` (`C1.out:34-45`), so the only
way the scope fails is `until_exhausted` — yet `runs.failed_cause` says
`node_execution_failed:/build_until_verified`. § 7.1 C7a (line 1130) requires
`select status,failed_cause from runs` → `failed | until_exhausted`. The cause name is produced at
`internal/pipelines/runtime/advancer.go:1500-1501`: `failScope` stores the named cause on the node
row and then escalates with the generic string.
**Fix brief.** In `failScope`, escalate with the scope's own cause when one exists
(`ac.escalateStop(row, cause, class)`) and keep `node_execution_failed:<key>` only for the
unnamed/child-failure arms; the run-completion arm at `advancer.go:1673` keeps its own wording.
**Proves it:** a runtime test (`advancer_test.go`/`scenario_test.go` shape) driving an `until` to
exhaustion and asserting `st.Run.FailedCause == "until_exhausted"`; live, the `C7a` verdict itself.

## DRIVER bugs (`e2e/m4/e2e_m4_exit.py` — probes, not the product)

### D1 — the C6/C7/C10 splices parse the wrong YAML shape (6 FAILs + 3 GAPs: whole gates blocked)

```
  FAIL  C6a own revision: the single splice applied cleanly — missing=['metadata.name', "the until body's implement node"]
  FAIL  C7 re-authored twin: every required splice applied — missing=['metadata.name', "the until body's implement node"]
  FAIL  C10 authored twin: every required splice applied — missing=['metadata.name', "exactly one `review` node in the twin document (found 0 …)"]
```

The probes read `GET /revisions/{id}/document?format=yaml` (which the contract defines as the
*regenerated* textual form, § 2 route 14) and then apply `^  name: ` (`c6_restore_doc`,
`c7_exhaustion_doc:3646`, `c10_malformed_doc:5720`) and `c7_node_block`'s
`s.strip() == f"- id: {node_id}"` (line 3610). Rendering the canonical JSON through
`go.yaml.in/yaml/v3` (`internal/store/postgres/m4api.go:1069`) produces 4-space indents, bullets
indented under their key, and **alphabetical** keys, i.e.:

```yaml
metadata:
    description: …
    name: "feature-development"
spec:
    nodes:
        - config:
            …
          id: implement
```

so `^  name:` never matches, `id:` is never the bullet's first key, and `text.count("- id: review")`
is 0. The `C7` run proved the mixed behaviour: the three indent-tolerant splices
(`maxIterations`, `resultBindings`, the `prev_probe` node) applied while the two shape-assuming ones
failed. Also note the printer quotes short strings (`name: "n"`), which the `metadata.name` splice
does not expect.

**Fix brief (driver only).** Make the three `c*_doc` helpers shape-agnostic: match
`(?m)^(\s+)name: (.*)$` under `metadata:` with any indent and re-emit with the captured indent;
locate a node block by scanning for `^(\s*)(?:- )?id: <node>$` and deriving the block indent and
the `- ` column from the match rather than assuming `id` leads the bullet; count reviewer/implement
nodes with the same key-line regex instead of `"- id: review"`. (The alternative — authoring through
`POST /drafts` from `docs/compatibility/probes/m4/pipeline.yaml` bytes — is allowed but must not
change the digests the gates compare against, so prefer the tolerant parser.) Then `C6a/C7/C10`
re-run their legs end to end.

### D2 — `C11b` looks for the injection in a journal surface that is digested by design

```
  FAIL  C11b the injected line reaches the downstream unit's prompt/env verbatim (the vector this
        contract creates is REAL) — attacker line present verbatim=False (marker probe=False); 6031 chars scanned
```

The probe (`e2e_m4_exit.py:6347-6360`) scans `domain_events` payloads `LIKE 'approval%'` plus node
and attempt outputs. `approval.requested` carries `summary_digest`, never the summary
(`internal/events/events.go:1546-1557`, § 3 row 26 — "the summary is digested, never copied"), and
in the twin the interpolated text is not echoed into any node output. The engine *does* materialise
`Plan for ${{ inputs.goal }}` (`pipeline.yaml:84,336`) into `approval_requests.summary`
(migration `00005:345`), which is exactly what `C9a` read back:
`GET /api/v1/approvals/{id} → "summary":"Plan for Document and fix add() in hello.py…` (`C9.out:43`).
So the vector is real and measurable; the probe reads the wrong surface and can never pass.

**Fix brief (driver).** In `c11()`, replace the `approval%` event scan with
`SELECT summary FROM approval_requests WHERE run_id='…'` (plus the `GET /approvals/{id}` body as
second evidence), keep the node/attempt scan as extra text, and print the matched line redacted via
the existing `c11_redact`. § 7.1 C11b's verbatim-presence claim is then measured where the engine
actually writes it.

### D3 — `C11b` report-honesty probe reads one file but names two

```
  FAIL  C11b the ops/sandbox report spells network_enforced=false on the agent-turn profile …
        — 'network_enforced=false' spelled in the report: False
```

`c11_report_honesty_verdicts`' docstring says the report is "docs/compatibility/SANDBOX.md +
M3-PROBES.md", but the code (`6399-6406`) opens only `SANDBOX.md`, which never spells the label; it
lives in `docs/compatibility/M3-PROBES.md:142,395`. `claims_true` is likewise False, so nothing is
being hidden — the probe just greps the wrong file.

**Fix brief (driver).** Read both files (and secondarily `GET /api/v1/system/sandbox`, which carries
the live `network_enforced` bool — `internal/api/sandbox.go:63`). Optional product-side follow-up:
give `SANDBOX.md` the agent-turn row that spells `network_enforced=false`, which is what § 7.3 asks
the M4 report to state.

### D4 — `C14b` terminal-event group-by is invalid SQL

```
  ERROR:  aggregate functions are not allowed in GROUP BY
  LINE 1: SELECT type || '|' || count(*)::text FROM domain_events WHER…
```

`GROUP BY 1` refers to the selected expression, which contains the aggregate (`8627-8631`). Fix:
`SELECT type, count(*)::text … GROUP BY type` (parse `type|count` after the fetch, or use
`SELECT type || '|' || count(*)::text … GROUP BY type`). This is the only reason `C14b`'s
duplicated-terminal-event verdict is a GAP.

### D5 — `C14b` slice-order probe sorts global_seq as text

```
  FAIL  C14b the live run's journal slice stays strictly ascending across the roll — 1816 rows, out of order: ['11809>8181'], duplicated: none
```

The slice is read with `SELECT global_seq::text … ORDER BY global_seq` (line 8610-8612), and
PostgreSQL resolves a bare `ORDER BY` name to the **output** column first — so the rows come back in
*lexicographic* order. The evidence is the shape of the failure: the printed head starts at `10001`
(all five-digit strings sort before `8…`) and the single inversion is exactly `11809>8181`, i.e. the
last 5-digit value followed by the first 4-digit one. Nothing in the journal is out of order — the
same read PASSes the duplicate and contiguity verdicts (`3629 seqs, 8181..11809, no hole`), and the
SSE stream verdicts PASS independently.

**Fix brief (driver).** Alias the projection (`SELECT global_seq::text AS seq … ORDER BY
seq::bigint`) or order by `global_seq::bigint` explicitly at lines 8610 and 8613, and apply the same
review to every other `::text … ORDER BY <same name>` idiom in the driver.

### D6 — `C14b` advisory-lock probe asserts something the server cannot show

```
  FAIL  C14b the m4 driver's advisory lock moves to a surviving replica (serve logs 'm4 driver acquired the advisory lock') — no replica logged a NEW acquisition after the roll: {'api-a': 0, 'api-b': 0}
```

`noteLeadership` (`internal/store/postgres/m4driver.go:259-269`) logs only on a not-held→held
transition *inside one process*, and the driver releases the session lock at the end of every tick
(`m4driver.go:150-168`), so a handover across a restart is not observable as a new line; a `0/0`
count is also what a log-prefix filter that matches nothing produces (`c14_lock_marks:8368-8371`
requires `l.startswith(s + " ")`). The probe is unfalsifiable, and § 7.1 C14b says the opposite of
what it asserts: "the advisory lock is an optimization and its absence must not corrupt anything"
(line 1321) — the ledger verdicts (`no duplicated succeeded key`, `approval.decided` once, contiguous
journal) are the contract's actual safety proof.

**Fix brief (driver).** Either drop the verdict, or bound it honestly: snapshot the count with
`compose logs --since <roll-start ISO> api-a api-b` per service, and GAP (never FAIL) when the
before-count is 0 — "no acquisition line in the whole history means the probe cannot see the log, not
that the lock never moved".

### D7 — `C8` cannot fit the wall clock it was given, and arms the agent variant

`C8.out` is 10 lines: one PASS (`C8 zero items: POST runs … -> 201`, line 9), then silence until the
harness cut the gate at 1500 s. It stalled inside `c8_watch(alice, facts, run0, 1800, "zero items")`
(line 4508), which polls the ledger every 4 s and would not print its own "terminal within 1800s"
FAIL until 1800 s had passed — so the gate died mid-poll without even a GAP. Two faults:

1. **Caps exceed the budget:** `c8_watch` is called with 1800 s and then 3000 s (line 4524). A 4800 s
   gate under a 1500 s wall clock can only be truncated; the arms need caps under the per-gate budget
   (or the 25-item arm needs its own `--only C8` invocation).
2. **Wrong variant:** `c8_seed_facts` (4294-4307) posts through the `feature-development`
   assignment, i.e. the **agent** revision with real `agent.acp` turns, while § 7.1 C1 says the twin
   exists "so C4–C9 have a run that always takes the same branch … about the engine, not about the
   model". C8 should arm `feature-development-deterministic`'s assignment (child unchanged).

The run was also starved by RC2 — an attempt queued and never claimed is what the neighbouring gates
measured — so the re-run must be sequential and on `HEAD`.

## ENVIRONMENT / HONEST GAPs

- **`C1 agent: terminal status completed` — ENVIRONMENT.** The run failed honestly after spending all
  four `maxIterations` with every body node `succeeded` (`C1.out:28-45`); the *identical* `passWhen`
  (`pipeline.yaml:95` vs `:349`) turned the twin green at iteration 2 (`C11.out:34-39`), so the
  binding machinery works and the difference is the live model's answer. The probe dumps only the last
  12 journal rows, so `pass_when_result` and the reviewer's `approved` are unrecoverable from these
  artefacts: a re-run must dump the `node.scope.iteration` payloads and the `test`/`review` outputs
  before this row is attributed either way. See P3 for the cause string the same run exposes.
- **`C1 twin(seed)` 600 s and `C14a` 900 s caps — FIXED SINCE (`ac2faa3`).** Both froze in the same
  shape: `/build_until_verified[1]/implement process.exec worker ready - att=1`, until row `ready`
  (`C1.out:71-72`, `C14.out:75-76`), journal repeating `node.scope.started` for one
  `node_execution_id` (`C1.out:84-95`, `C14.out:88-99`) — the backstop tick spinning on a run no
  worker could claim for. `W7.out:25` proves the mechanism (`queued:6, leased:0, running:0`,
  `worker-a 3/3`, `worker-b 1/1`, `oldest_queued_age_seconds:4567`), `W7.out:37-38` is its UI arm, and
  `C9.out:31` ("sum(active_attempts)=1 ledger(all runs)=0") is the same leak one tick earlier. If the
  duplicate `node.scope.started` storm survives the fix it is a separate engine-side bug.
- **`C1i` (`C1.out:134`) and the cross-variant key set (`C1.out:135`) — derived:** both compare ledgers
  of runs that must reach `completed`. `C1i` says GAP; the key-set verdict should GAP too rather than
  FAIL when a leg never completed.
- **`C11b` sandbox.verified rows (`C11.out:69`) / agent arm (`C11.out:73`) / `C14b` forced race
  (`C14.out:102`) — HONEST GAP.** The twin arm runs only the egress-denied command profile (no
  `network_enforced=false` row exists to grade), a live Claude turn is out of the lab's deterministic
  reach, and forcing a simultaneous advance needs a store seam § 7.1 C14b itself disclaims.

## Verification for this report

Read-only only: the `.out` evidence, `grep -n`/`sed -n` over `e2e/m4/e2e_m4_exit.py` and
`docs/m4-contract.md`, `git log --oneline 4245c48..HEAD`, plus one throwaway program **outside** the
repo (`/tmp/ychk`) that rendered canonical JSON through the repo's own `go.yaml.in/yaml/v3` to
establish RC3's literal output shape. No lab, no docker, no code change beyond this file.
