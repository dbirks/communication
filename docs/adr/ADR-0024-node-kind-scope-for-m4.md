# ADR-0024 — Node kinds: what M4 must ship to pass its exit, and what stays deferred

- **Date:** 2026-10-15
- **Status:** Proposed
- **Amendment (2026-10-15):** the prose counts now match this record's own tables — **nine** executed
  kinds (§ 1) and **seven** deferred kinds (§ 2) of the sixteen-name catalogue, where Option A said
  "eight", Consequences said "six deferred" and Verification said "eight executing" (contract
  § 9.1 row 21, § 11.6; the observable version is contract § 7 C13a's seven `kind_not_implemented`
  refusals). Also § 1's `until` row and § 3's retry route follow ADR-0022 § 2's root rename and
  contract D1's path-segment verbs. Status stays **Proposed**.
- **Owners:** M4 contract implementers; M5/M6 owners for the deferred half
- **Related decisions / contracts:** D-006 (Accepted), D-018 (Accepted: publication is explicit),
  D-019 (Accepted: node templates / child invoke), D-011/D-021, D-024 (Open);
  `communication-spec/11-build-roadmap.md` M3/M4/M5/M6 bullets, `03` § "Standard node catalogue" and
  "Publication and merge", `04` § "Profile → environment → instance", `07` § "Trigger/query/action
  provider contract" and "Example library to ship", `05`, `12` cases 7, 8, 9, 12–17;
  ADR-0008/0009/0016/0017/0018/0019/0020 (what M3 actually proved), ADR-0021 (schema owns
  structure), ADR-0022 (expressions), ADR-0023 (execution semantics), M3 contract § 0 ("will NOT
  prove"); contract `docs/m4-contract.md`

## Context

`11-build-roadmap.md` lists thirteen node capabilities under M4 — "ACP agent / command / model /
condition / human gate / until / for_each / parallel / child pipeline / explicit artifact and
publication" — and one exit sentence: *sample
Plan→Approve→Implement→Test→Review→Loop completes on a disposable repo with validated state after
crash/retry*. The list and the exit do not have the same length, and M4 is three implementation
workers who must not each resolve that gap differently. The pressure is real in both directions:

- **Under-shipping** breaks M5/M6: the editor (`M5`) cannot render a node kind whose runtime does
  not exist, and GitHub triggers/PR publication (`M6`) are exactly `integration.*` and `git.publish`.
- **Over-shipping** breaks the milestone's evidence rule. `03`'s own catalogue row for
  `parallel`/`join` says "quorum later if untested"; `13` lists R4 (duplicate external effects) and
  R7 (unbounded cost) as top risks; AGENTS.md forbids claiming a capability without a real test;
  and M3's contract already establishes the genre of an explicit "will NOT prove" list, which came
  out of measured gaps (`docs/m3-contract.md` § 0), not preference.

The decision has to name, per kind, whether M4 **runs** it, **validates** it (schema + compiler
without an executor), or **refuses** it, and tie each answer to a gate.

## Options considered

| Option | Advantages | Disadvantages | Evidence |
|---|---|---|---|
| **A. Ship the nine kinds § 1 enumerates (what the exit sentence and `12`'s cases 7/8/9/11 require) and defer the seven § 2 enumerates — together the sixteen catalogue names — as validate-and-refuse (chosen)** | Exit is provable end-to-end; every deferred kind has a compiler error that says so, so a draft fails at `validate` and not at attempt 6; the deferred extension points (schema branches, `node_executions.kind`, event types) exist so M5/M6 add executors without renaming anything | `pipeline.invoke` without `parallel`/`join` is an odd-looking set, and the reason ("child runs are `12` case 8; joins are not in any exit") is a milestone argument, not a semantic one | roadmap M4 bullet + M4 exit sentence; `12` case 8 (25 children, aggregate failure, bounded fan-out) is a `for_each` + `pipeline.invoke` case, not a `parallel` case |
| B. Ship all thirteen | Roadmap fidelity; M6 has nothing to add to the engine | The `for_each`-of-`pipeline.invoke` case and `parallel`+`join`+`quorum` are two different concurrency models to fence, checkpoint and cancel in one milestone; publication (`git.publish`) drags `07`'s action-intent/reconciliation design (R4) into M4, where nothing in the lab has a GitHub credential by design (M3 setup: local `file://` fixtures, no network) | compared; rejected — the exit gate would be proved by whatever the last worker finished testing |
| C. Ship five kinds (agent, exec, condition, approval, until) and defer `for_each`, `pipeline.invoke`, `artifact.publish` | Smallest surface that reaches "loop completes" | `12` case 8 has no host; `03`'s composite-outputs rule ("`for_each` and `pipeline.invoke` expose declared result bindings") stays untested; `12` case 16's artifact evidence and M3's artifact exit gain no pipeline producer, so the run's only evidence is JSON in a column | rejected on `12` grounds |
| D. Implement everything but gate the unproven kinds behind a runtime flag | Nothing is refused in principle | A flag nobody can exercise is an untested path presented as supported — the exact thing AGENTS.md forbids ("never prefilled PASS") | rejected |

## Decision

### 1. Kinds M4 **executes** (the nine that must really run)

| Kind | M4 semantics | Which exit/case needs it | What M4 does **not** claim |
|---|---|---|---|
| `agent.acp` | conversation + turn per node execution (ADR-0023 § 4), ACP launch under the profile's sandbox mode exactly as M2/M3 do it; `sessionMode: new` and `resume_if_supported` with `fallback: new \| fail`; prompt from `bindingText`; `structuredOutput` validated against the node's `outputs` schema | the exit's Plan/Implement/Review nodes; `12` 5 (kill mid tool-call) | that any *new* adapter works — the compatibility rows stay `docs/compatibility/ACP.md`'s, and `continue_live` is **not** wired in M4 (§ 3) |
| `process.exec` | argv array, no shell, `cwd` relative to the run workspace root, `outputExtraction` (`none \| json_from_path \| json_from_stdout`), stdout/stderr as artifacts; runs under ADR-0019's command profile | the exit's Test node; the loop's failure signal | network access, "sandboxed command isolation on any host", or that `go test` is the sample — the executable list is lab-fixture-local |
| `model.chat` | OpenAI-compatible chat completion, JSON-schema-constrained response, no ACP process, control-plane side call from the *worker* (it holds the launch env) | the exit's reviewer-fallback experiment; `condition`'s cheap alternative | provider coverage beyond the one endpoint the lab already reaches, token-cost accounting (R7 stays unbudgeted), or streaming into the transcript (a `model.chat` emits one message, not a conversation) |
| `condition` | ordered `cases` of bare CEL, first true wins, `default` route; runs in the advancer (ADR-0023 § 3); emits `outputs.route` | `12` case 11's branch invalidation, gate-shaped routing without a worker | route-typed edges (`ADR-0021` § 6 chose `when`+`skipped` instead), or `gate`'s judge semantics |
| `human.approval` | durable `approval_requests` row, no worker, deadline, `onTimeout`, project-scoped authorization checked at decision time | the exit's Approve step; `12` case 9 | that it is an ACP permission prompt (it is not — ADR-0023 § 9 keeps the two tables apart), or delegation/re-assignment of approvers |
| `until` | bounded iterations, `passWhen`/`failWhen`, `carryForward` via the `previous`/`iteration` roots (ADR-0022 § 2, amended: cel-go v0.31.0 reserves `loop` as an identifier), `resultBindings` over the passing iteration, `until_exhausted` failure with evidence | the exit's Loop; `12` case 7 | indeterminate-as-false (ADR-0022 § 3), or iteration-level parallelism |
| `for_each` | literal `maxConcurrency`, index-keyed children, `onChildFailure` ∈ `stop \| collect_and_continue \| fail_after_all`, `0`-item success, result list output | `12` case 8 (bounded fan-out, one child failing, siblings preserved) | dynamic fan-out budgets (`07`'s quota reconciliation is M6), and *ordering* guarantees beyond stable keys |
| `pipeline.invoke` | resolve target revision **at run start**, create a child run with `parent_run_id`/`depth`, `waitFor: completion` only, cascade cancel, child outputs as `outputs` | `12` case 8 with real children; the child-run tree the exit run must show | `detach` policy (§ 3), recursion beyond `depth ≤ 2`, and cross-project invocation (project is inherited, ADR-0023 Security) |
| `artifact.publish` | capture from a workspace path or a node output, ADR-0020's exclusion + redaction scan + `Put` + fenced row/event, `sensitivity` and retention | the exit's evidence requirement; M3's artifact surface gains a pipeline producer | that publication (`git.*`) happened — an artifact is not a PR (D-018) |

### 2. Kinds M4 **validates but refuses to execute** (the seven deferred), with the reason recorded here so the compiler error is not folklore

Each of these has an ADR-0021 schema branch and a compiler pass, and each produces
`{code: "kind_not_implemented", kind, message: "…, planned for <milestone>"}` at `validate` — the
draft is `invalid`, not "valid but broken at runtime".

| Kind | Deferred to | Why M4 is the wrong place |
|---|---|---|
| `parallel`, `join` | **M5** | `03` names join modes `all \| any \| quorum` and marks quorum "later if untested"; joins need a *scope-level* completion rule distinct from `for_each`'s index set, and cancellation semantics for a partially-joined branch. `12` has no case for them; the exit has no use. Building them means two concurrent-scope implementations in one milestone (Option B's cost). |
| `gate` | **M5** | `03` calls it "convenience template over agent/model/command/human" with `pass \| fail \| indeterminate`. That is a *composition* of kinds M4 executes plus a template expansion mechanism (`node_templates` table + `NodeTemplate` documents), which M5 owns. M4 executes `human.approval` and `condition` directly, which is what the exit needs. |
| `git.commit`, `git.publish` | **M6** | D-018 already separates publication; `07` requires idempotency keys + probe/reconcile (`external_action_intents`) because "exactly-once effects cannot be assumed" (R4), and `12` case 6 is a **case-6** test with a real remote. The lab's fixtures are `file://` remotes with no credentials by design (M3 § 6 setup), so an M4 "PR publication works" claim would be a claim about a local bare repo, which is not the feature. `git.commit` **to the run's own ref** stays available to agents through ADR-0017's `commit_granted` profile axis — which is a *capability of the agent*, not a pipeline node, and M4 does not pretend otherwise. |
| `integration.query`, `integration.action` | **M6** | Same provider-contract argument: trigger dedupe, webhook verification, polling reconciliation and per-action operation ids are M6's own exit ("duplicate webhook does not duplicate logical work"). An M4 adapter would be a GitHub client without any of the machinery that makes its retries safe. |

### 3. Features *inside* shipped kinds that M4 also defers

`continue_live` session reuse (needs a worker-held session across node executions; `04`'s
`session_origin` bookkeeping exists, the scheduling does not); `cancelPolicy: detach`;
`join`-based waits; `gate`'s `judge: agent` template expansion; run-local **config** overrides
beyond inputs (only `POST /runs/{id}/retry` with input overrides exists — `03`'s
`run.override.applied` edge case is therefore an M5 item, and the event type is reserved, not
emitted); `retry.workspacePolicy: restore_checkpoint` across volumes (D-024 **Open**,
ADR-0023 § 6); APM profile revisions with pinned `apm_lock_digest` per attempt (still a column,
ADR-0016 § 10 deferred it, M3 kept it as a profile field); node-level resource limits
(CPU/memory/disk — `07`'s budget layers are unimplemented and named as unimplemented, exactly as
M3 contract D10 does); `integration_broker` secret delivery (ADR-0018 reserves it); `join`/`quorum`
counting.

### 4. Extension points this decision must not close

- The schema's `kind` enum keeps all sixteen names (ADR-0021 § 2): deferral is an executor fact,
  not a vocabulary change, so M6 adds executors without a schema-version bump.
- `node_executions` keys are text paths (ADR-0023 § 1), so `parallel`'s branch keys
  (`/scope:branch/node`) need no new column.
- `pipeline_invocations.wait_policy`, `runs.policies_snapshot.cancel_policy`,
  `attempts.overrides` and `approval_requests.kind` exist with CHECK-constrained enums that include
  the deferred values, so the deferred half is an unimplemented enum member rather than a future
  migration of a hot column.
- `external_action_intents` is **not** created early: M6 creates it with its own semantics rather
  than inheriting an M4 stub that never had a reconcile test.

## Consequences

- Positive: the exit sentence is executable by nine kinds, and the seven deferred kinds fail loudly
  where a user can act on it (a validate error naming the milestone) instead of at attempt 3 of a
  4-iteration loop.
- Positive: M5 gets `parallel`/`join`/`gate` as *its own* compiler+UI problem with the concurrency
  substrate already tested by `for_each`, rather than as a rider on M4.
- Positive: M6's publication and integration work keeps its idempotency/reconciliation design intact
  instead of shipping a half-version of it in the engine milestone.
- Negative: M4's delivered vocabulary (`invoke` without `join`) looks inconsistent to anyone reading
  only the node enum. Mitigation: `kind_not_implemented` messages name the milestone, and this
  record is linked from `docs/adr/README.md`.
- Negative: `model.chat` in M4 is the one kind whose inclusion is a judgement call — it is cheap,
  it is `03`'s second row, and nothing in the exit strictly needs it. Recorded as a risk to the
  milestone rather than as a capability claim: if the M4 exit run has to drop anything to prove the
  crash/retry gate, `model.chat` is the declared first sacrifice, and dropping it must be reported
  as a deviation, not discovered.
- Negative: with `git.*` deferred, an M4 run cannot publish its own result, so the sample pipeline
  ends in an artifact plus a `patch` (ADR-0020's `kind=patch`) that a human applies — which is
  precisely `03`'s "Implement produces code in workspace; not automatically a PR/merge", now
  enforced by a milestone boundary rather than by politeness.

## Security/privacy

- Deferring publication removes M4's largest external-side-effect surface, and with it R4's
  duplicate-effect exposure; what remains is ACP agents and local commands inside an ADR-0019
  sandbox profile whose limits M3 already documents (`network_enforced=false` on the agent-turn
  profile — the honest label stays).
- `model.chat` sends node-selected content to a model endpoint: that is a new egress path, so its
  endpoint configuration is operator-level (`07`'s provider contract), it inherits ADR-0018's
  "no secret in a prompt" rule, its request body is redaction-scanned like an artifact, and no
  secret material may be interpolated into `messages`. A project that must not let content leave
  the host must not use `model.chat` — a configuration decision the ops page has to state plainly
  (the M3 exit criterion's honesty rule again: no capability claim that the sandbox cannot back).
- `pipeline.invoke`'s revision resolution at run start is an authorization point: it must resolve
  within the parent's project and organization scope, or it is a cross-tenant read of another
  team's graph (`01`'s project boundary).
- Refusing a kind at `validate` is fail-closed and cheap; a `kind_not_implemented` *runtime*
  fallback (e.g. treating `gate` as `human.approval`) would be a silent semantic substitution and is
  forbidden.

## Verification

Observed, in service of a *scope* decision rather than a capability claim:

- M3's exit contract (`docs/m3-contract.md` § 0) enumerates what the lab could not prove — enforced
  egress on a real model turn, portable checkpoints, tenant isolation, the S3 backend — and each
  deferred kind in § 2 collides with one of those gaps or with `07`'s provider machinery.
- ADR-0017 (per-scope refs, `commit_granted`) and ADR-0019 (launch under nono, `required` mode) show
  a *commit* is reachable from inside a sandbox for the run's own ref, which is why `git.commit` as
  a **node** adds governance, not capability — and governance without `07`'s intent/reconcile record
  is the wrong first version.
- The spike (ADR-0021 § Verification) confirms the composite kinds are schema-expressible today
  (`for_each`/`until` bodies validate recursively against `#/$defs/node`), so deferral is an
  executor decision and not blocked by structure; it also confirms the provisional schema cannot
  express retry/timeout at all, which is why the nine executing kinds are only schedulable after
  ADR-0021 lands.
- **Not observed** (and this record therefore claims nothing about them): `pipeline.invoke` child
  cancellation, `for_each` at 25 children, `model.chat` against any endpoint, `join` semantics,
  publication idempotency. The M4 exit run (`docs/m4-contract.md` § 7) supplies the first two;
  the third has its own scripted case; the last two are M5/M6 evidence.

## Migration/rollback

Adding an executor later is additive: the kind name, its schema branch and its `node_executions`
key space already exist, so M5/M6 turn `kind_not_implemented` off for one kind at a time behind its
own acceptance gate. Removing a kind from M4's executing set (the declared `model.chat` sacrifice)
is a one-line registry change that returns it to `kind_not_implemented`; any run already executing
it is unaffected because the plan and revision digest are pinned (ADR-0002, ADR-0023 § 2), and the
change must appear in the M4 report as a deviation. Reordering the milestone boundary the other way
— promoting `git.publish` into M4 — requires `07`'s `external_action_intents` table, a credentialed
remote in the lab, and an ADR that supersedes § 2's `git.*` row (D-018 stays Accepted either way; it
is the *milestone scoping* that would change, which is still ADR-worthy because it moves a
side-effect boundary into the engine).
