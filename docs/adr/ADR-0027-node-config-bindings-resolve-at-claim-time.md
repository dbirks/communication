# ADR-0027 — Node config bindings resolve at claim time, in the control plane, not at enqueue time

- **Date:** 2026-10-16
- **Status:** Accepted (implemented on `main` in commit `3479fd9`, 2026-10-15; recorded after the fact —
  a paperwork deviation, not a design one. It changes no schema, no protocol version and no public API,
  but it changes *when* the authoritative evaluator runs, which is recovery-adjacent semantics under
  `13-decisions-and-adrs.md`, so it is written down here rather than left in a commit message)
- **Owners:** pipeline runtime maintainers; M4 exit-gate owner (§ 4 step 6 / step 14 depend on it)
- **Related decisions / contracts:** ADR-0022 (the CEL binding subset, one evaluator, expression
  budgets and caps), ADR-0023 (runs / node_executions / attempts, `node_instance_key`, "re-derive,
  never trust a memory"), ADR-0021 (pinned immutable `plan_snapshot` + revision digests), ADR-0013
  (migrations: this decision exists *because* `attempts` has no `config` column),
  `docs/m4-contract.md` § 4 step 6 (control plane resolves bindings) and step 14 (workers never
  evaluate), `03` § 3 (scope bodies, `until`/`for_each` iteration variables), `internal/worker` (the
  consumer that must never see `${{`)

## Context

The first agent node of the sample pipeline failed **every** attempt with `binding_error`. The cause
was not the expression, the inputs, or the worker:

- the plan snapshot (ADR-0021) stores node config with its `${{ }}` bindings *as written*;
- the claim path read that config straight out of the snapshot and handed it to the worker verbatim;
- workers are forbidden to evaluate expressions (§ 4 step 14 — the evaluator is one implementation
  in the control plane, ADR-0022 § 3), so the executor's only honest answer to a config containing
  an unresolved marker (`{"$unresolved": true, …}`, `internal/store/postgres/attempt_worker.go`) was
  `binding_error`.

So a binding had to be evaluated *somewhere* between "the snapshot carries an expression" and "the
claim carries a literal". The two candidate moments are enqueue time (persist the resolved config on
the attempt) and claim time (resolve when the attempt is handed to a worker). Enqueue time is the
textbook choice — resolve once, store the bytes, ship them — and it was blocked by exactly one fact:
**`attempts` has no `config` column** (`00005_m4_pipelines.sql`: it carries `overrides`,
`retry_context`, `outputs`, `outputs_digest`, never a resolved config). Adding one is a migration,
which per ADR-0013 and `13` needs an ADR of its own plus a schema decision about what a replayed
attempt's config *is* (see Options).

## Options considered

| Option | Advantages | Disadvantages | Evidence |
|---|---|---|---|
| **A — resolve at enqueue time and persist resolved config on the attempt row** | One evaluation per attempt ever; a claim becomes a byte-for-byte replay of what was decided; `09`'s API could then show exactly what a worker was told | Needs a new `attempts.config` column = migration + digest/authority questions (is the stored config authoritative over the snapshot? what does a retry inherit? what does `overrides` interact with?) — i.e. ADR-0013 + ADR-0023 + ADR-0021 amendments before M4 can pass a gate | `CREATE TABLE attempts` in `internal/store/postgres/migrations/00005_m4_pipelines.sql` (no config column); attempts already has UNIQUE `(node_execution_id, attempt_number)` so an enqueue-resolved row is per-retry, not per-node |
| **B — let the worker evaluate** | Zero control-plane work; the worker has the run rows nearby anyway | Rejected on contract, not on effort: § 4 step 14, and ADR-0022's one-evaluator rule exist so expression semantics, budgets and caps have a single owner. Two evaluators is how a binding starts meaning two things | `docs/m4-contract.md` § 4 step 14; ADR-0022 § 3 |
| **C — resolve at claim time in the control plane (chosen)** | No migration, no new column, no new authority: the snapshot stays the single source of node config and the run's rows stay the single source of state; reuses the *same* `Evaluator`/`ConfigTree`/vars assembly the advancer decided the node with; the worker's contract ("config is literals") is enforced by construction | Re-evaluation on every claim, so retries and re-claims after a lease expiry each pay the expression budget again; and the resolution must reproduce per-iteration scope state from rows, because no scope-state column exists either | implemented in `3479fd9`: `runtime.ResolveNodeConfig` (`internal/pipelines/runtime/attempt_config.go`) called from `hydrateConfigs`/`resolveBindings` (`internal/store/postgres/attempt_worker.go`) |
| **D — forbid bindings in node config entirely (M4 scope reduction)** | The problem disappears; configs become literals by schema rule | Not available: `03`/`09` define config bindings as the mechanism that carries run inputs and upstream outputs into a node, and § 9.3's sample pipeline (the M4 acceptance artefact) uses them | ADR-0022's binding subset exists precisely because config bindings are load-bearing |

## Decision

**Option C.** When an attempt is claimed, the control plane resolves that node's compiled config
through `runtime.ResolveNodeConfig` — the same evaluator, the same `ConfigTree`, the same variable
assembly the advancer used — against the run's inputs and its upstream outputs, and hands the worker
the interpolated result.

The rules that make this a decision rather than a bug fix:

1. **Claim time equals enqueue time for `dependsOn` outputs, and that equivalence is load-bearing.**
   A binding reads run inputs (fixed when the run is created, pinned revision) and upstream node
   outputs. An upstream node execution's `outputs` are written once, at `succeeded`, and a
   `succeeded` node execution never re-runs (ADR-0023's state machine, `09` § 4); a node is only
   eligible for claiming once its dependencies are in that terminal, immutable state. So the value
   set an enqueue-time evaluation would have seen is the value set the claim sees — the resolution is
   the same function over the same frozen inputs, moved later, not made nondeterministic.
2. **Iteration variables are re-derived, not remembered.** `until`'s `iteration`/`previous` and
   `for_each`'s `item`/`items` roots come from `scopeActivation`, which rebuilds the activation from
   the node's **PLAN** scope key plus `indicesOf(pn.Path, row.InstanceKey)` — the iteration index
   parsed out of `node_instance_key`'s `[n]` suffix (ADR-0023 § 1) — and `previous` from the sibling
   rows that already succeeded. This is deliberate: no scope-state column exists in `00005`, and the
   advancer already re-derives scope state from rows after a restart (ADR-0023 § 6, "re-derive,
   never trust a memory"). Consequences worth naming: a **retry inside the same iteration resolves
   identically** (same instance key, same index, same succeeded upstream rows), and **the next
   iteration's node execution resolves its own** `iteration`/`item` because its instance key carries
   that index. Nothing resolves "the current loop counter" out of process memory, so a claim served
   by a different control-plane replica — or after a leader flip — resolves the same config.
3. **Expression-position leaves are evaluated too** (`finishConfigLeaves`). Inside a config tree the
   condition/gate kinds' expression leaves are normally owned by the advancer's handlers; a claim
   carries no handler that could own them, so they are resolved here for the same reason as the
   bindings — the worker must never be handed a `${{`.
4. **Failure is honest and stays honest.** Resolution never half-resolves: an evaluation error is
   returned and the attempt closes `binding_error` (predicate failures `predicate_error`) with the
   offending expression annotated onto the marker (`markBindingDetail`), rather than shipping an
   unevaluated binding. Equally, when a config cannot be hydrated at all (no programmable snapshot,
   a row this read cannot reach), the `$unresolved` markers **stay**: the lease is already committed
   at that point, so the correct outcome is the executor's visible `binding_error` closing through the
   retry loop, not a silently dropped claim. Degradation is "no config", never "lost claim".
5. **Cost is counted, not hidden.** Every expression this resolves is added to
   `runs.expression_evaluations` — the same counter, and therefore the same cap, the advancer pays
   (ADR-0022's budget). A claim whose config is already all literals costs one map walk and no
   evaluation, so the steady-state overhead is proportional to actual binding use.

## Consequences

- Positive: the M4 sample pipeline's agent nodes run. Claims arrive with `goal` interpolated from the
  run's own inputs and no `${{` anywhere in `Config`, which is what § 4 step 6 asserts.
- Positive: one evaluator, one owner of expression semantics, budgets and caps — the property
  ADR-0022 exists to protect, kept intact by *calling* the runtime rather than reimplementing it.
- Positive: no migration, no new column, no new authority. `plan_snapshot` remains the only stored
  node config and the run's rows the only stored state, so ADR-0021's digest story and ADR-0023's
  re-derivation rule are unchanged.
- **Cost (the price of C, stated in units):** a binding is re-evaluated on every claim, so a retry
  (backoff, infra failure, worker lease expiry/re-claim) pays again. Evaluations land on
  `runs.expression_evaluations`, whose per-run cap is ≤ 10 000 (ADR-0022's aggregate cap, enforced in
  `Evaluator` "so no caller can forget it", `internal/pipelines/runtime/program.go`), and exhaustion
  is `predicate_cost_exceeded`, an execution error. A `for_each`/`until` fan-out × a retry storm is
  therefore a *run-level* way to spend the loop budget on re-resolution rather than on routing — the
  counter is the mitigation (it is visible and bounded, fail-closed, not silent), but an operator
  reading a stalled run should know claim-time resolution is part of that number.
- Limitation: resolved config is not retrievable after the fact. The API can report *what the worker
  was handed* only while that claim's log/attempt detail carries it; there is no stored
  "config as resolved for attempt N" to audit against. Option A's auditability is the real thing
  given up here, and it is what a future migration should buy.
- Limitation: a claim-time failure is discovered *after* the lease, so it costs a worker round-trip
  and one attempt number before the loop closes it visibly. Accepted deliberately (rule 4) — the
  alternative at that point is losing a committed claim, which is worse than a `binding_error`.
- Interaction worth naming: because resolution reads live rows, a run whose upstream output row were
  ever rewritten after `succeeded` would resolve differently per claim. Nothing in `09`/ADR-0023
  permits that rewrite; if a future feature (rerun-from-node, output patching, an M5 editor
  backfill) allows it, this ADR's rule 1 has to be revisited with it.
- Backwards compatibility: nothing public changes. Wire `AttemptClaim.Config` was already specified
  as resolved config; what changed is that the server now honours that spec instead of forwarding
  the snapshot's expression.

## Security/privacy

- **Authority, not secrecy:** the change narrows who can evaluate. Before, the only escape from
  "worker never evaluates" was the control plane; a config with a binding reached a worker at all.
  Now the worker receives literals or a marker it must refuse, so a compromised worker cannot
  persuade a *second* evaluator into existing, and expression semantics (ADR-0022's deny list,
  undeclared `now()`, no I/O) stay enforced in one process.
- **Injection surface moves, and shrinks:** an author's `${{ }}` string is no longer transmitted to
  the worker side, so worker-side config parsing sees data, not source. Run inputs and upstream
  outputs interpolated into a prompt are still author-controlled content reaching an agent, which is
  ADR-0022/ADR-0024's problem, unchanged by this ADR.
- **Budget as a control:** because claim-time evaluation pays the same per-run cap, a pipeline
  cannot launder extra evaluation (and therefore extra engine work) through retries without spending
  the run's declared budget. Fail-closed at the cap: the run stops with `predicate_cost_exceeded`
  rather than the evaluator going uncapped.
- **Multi-replica safety:** resolution reads Postgres and re-derives scope state from rows, so two
  API replicas claiming concurrently cannot disagree about a config; the lease/fence (ADR-0023)
  still decides who gets the attempt at all.
- No secrets enter this path any differently than before: `${{ }}` bindings resolve from run inputs
  and node outputs, and `09`/ADR-0018 keep secret material on `secretRef` delivery, never in
  interpolated config (unresolved secret material is a delivery failure, not an expression).

## Verification

- `internal/store/postgres/m4api_run_lifecycle_test.go` →
  **`TestM4RunLifecycleBindingsClaimResolvesConfig`** (added in `3479fd9`): the § 4 step 6 / § 5.1
  step 3 gate. It claims an attempt whose snapshot config carries bindings and asserts (a) the
  claimed `Config`'s serialized form contains **no `${{`**, (b) the `plan` node's prompt carries the
  run's own `goal` input, and (c) `runs.expression_evaluations > 0` **after claim resolution** — i.e.
  the cost accounting of rule 5 is pinned by the same test that pins the behaviour, so it cannot be
  quietly made free.
- `internal/pipelines/runtime` unit coverage for the evaluator/`ConfigTree` path this reuses
  (ADR-0022's suite), plus advancer tests confirming the extraction in `3479fd9` left the advancer's
  own resolution behaviour unchanged (the commit is a move, not a fork: 55 lines out of
  `advancer.go`, 327 into `attempt_config.go`).
- Live lab: with `3479fd9` the sample pipeline's first agent node stops failing `binding_error` on
  every attempt, which was its only observed behaviour before (M4 lab, 2026-10-15); the run advances
  to the gate/iteration semantics the later C-series gates (`e2e/m4/test_c*_logic.py`) assert.
- Negative control to add when Option A is taken (or sooner): a test that a **retry of the same
  node execution resolves byte-identically** — the claim of rule 1/2 that two evaluations of the
  same frozen inputs agree. It is currently argued, not measured; the pieces (`indicesOf`,
  `scopeActivation`, `previous`) are pure enough that it should be cheap.

## Migration/rollback

- **Upgrade:** deploy. No migration, no backfill; nothing stored changes shape, so an in-flight run
  across the deploy resolves its remaining claims the new way and its finished attempts are
  unaffected.
- **Rollback:** revert `3479fd9`; claims go back to carrying snapshot config and the sample
  pipeline's bound nodes go back to uniform `binding_error`. This is why the revert is visible rather
  than silently wrong: workers refuse markers instead of evaluating them, so the failure is loud.
- **Supersede (the intended future, and the reason this ADR is written at this length):** add
  `attempts.config jsonb` (or a `resolved_config` alongside `overrides`) in a new migration, resolve
  once at enqueue, and have the claim path read the stored value — at which point this ADR becomes
  "Superseded by ADR-00NN", keeping rule 1's immutability argument as the justification that the
  stored value *is* the value a claim would have computed. When that happens, the per-claim
  evaluation cost disappears, `expression_evaluations` stops counting re-resolution, and the
  auditability limitation above closes. The `runtime.ResolveNodeConfig` signature should stay as
  stable as it is today so that migration moves the *caller*, not the evaluator.
