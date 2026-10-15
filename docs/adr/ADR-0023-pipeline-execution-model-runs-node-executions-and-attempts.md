# ADR-0023 — Pipeline execution model: runs, node executions and attempts on M2's leases

- **Date:** 2026-10-15
- **Status:** Proposed
- **Amendment (2026-10-15):** two engineering corrections, no semantics changed. (a) § 1's
  `pipeline_invocations` row keyed `UNIQUE (attempt_id)` contradicted this record's own § 3/§ 10
  (a control-plane `pipeline.invoke` never creates an attempt) — the row now reads
  `UNIQUE (node_execution_id)` + `UNIQUE (child_run_id)`, which is what contract `00005` DDL
  already built (contract § 9.1 row 20, § 11.6). (b) This record spelled action routes in the
  spec's colon form (`/runs/{id}:retry`); they are restated in the path-segment form ADR-0014's mux
  supports and the contract ships (contract D1). Status stays **Proposed**.
- **Owners:** M4 contract implementers (control plane scheduler, worker runtime, UI)
- **Related decisions / contracts:** D-009 (Accepted: node-boundary checkpoints, honest worker
  restart), D-018 (Accepted: publication is explicit), D-019 (Accepted), D-024 (**Open**: portable
  checkpoints), D-012; ADR-0002 (run-pinned revisions), ADR-0013 (forward-only migrations, one
  transaction per state change), ADR-0014 (HTTP/SSE conventions), ADR-0016 (turn leases, fencing,
  reconciler pattern, `conversation_control` reserved `run_attempt` kind), ADR-0017 (run workspaces,
  volume identity, per-scope refs), ADR-0018 (`lifecycle: node_attempt`, reserved until now),
  ADR-0020 (checkpoint artifacts), ADR-0021/ADR-0022 (what a revision and an expression are);
  `communication-spec/02` § "Scheduling and recovery", "Execution recovery semantics",
  `03` § "Scheduling semantics", "Runtime edge cases", `01` state machines + invariants 1/3/4/6,
  `12-test-strategy.md` cases 1, 2, 3, 5, 7, 8, 11; contract `docs/m4-contract.md`

## Context

M2 built a working claim/lease/fence/reconcile loop for exactly one kind of work — a conversation
turn — and M3 built the workspace, secret, sandbox and artifact machinery around it, with
`workspaces.run_id` left nullable and unpopulated "until M4 fills" (M3 contract D1). M4 now has to
run the Plan→Approve→Implement→Test→Review→Loop sample on that substrate, and the constraints that
make it non-trivial are all Accepted or measured:

- **Three runtime levels, one claim mechanism.** `01` defines Run → Node Execution → Attempt with
  "a node execution may occur many times in loop/fan-out", "repeated attempts append, not
  overwrite", and invariant 3 ("fencing token must monotonically increase per node attempt
  ownership transfer"). `09` indexes `UNIQUE (run_id, node_instance_key, attempt_number)` — which
  presupposes a `node_instance_key` nobody has defined, because `03`'s loop/`for_each`/child scopes
  are the first thing that needs one.
- **Some "nodes" must not occupy a worker.** `human.approval` is a durable wait with "no worker slot
  held" (`03`); `condition` is "bounded, deterministic expression, no filesystem access", and
  ADR-0022 puts expression evaluation in the control plane. Both are `01` NodeExecution states that
  ADR-0016's machinery has no notion of.
- **Checkpoints are a contract, not a feature.** D-009 is Accepted: node boundaries only, honest
  about loss, no continuous snapshots. `02`: "For an interrupted active step, retry from previous
  completed boundary", while ADR-0017 gives the run a *live worktree with the interrupted agent's
  edits still in it*. Those two sentences collide the moment a retry is requested, and the worker
  cannot be both reverted and not reverted.
- **A retry is not a resume.** `04`'s `resume_if_supported` is about the *ACP session*; a retry is
  about the *workspace and the boundary*. The spec's own example sets `sessionMode:
  resume_if_supported` with `fallback: new`, and `03`'s edge-case list asks what happens when the
  provider has no capability.
- **Idempotency is now load-bearing.** `12` case 1 ("start the same logical run twice with the same
  idempotency key; only one logical run exists") cannot pass, because ADR-0014 left
  `Idempotency-Key` unimplemented and `09` only suggests it.
- **Cancellation has to reach children.** `03`: "Parent cancelled with 12 children; policy chooses
  cascade or detach; detached child is still visible"; `12` case 8 is a 25-child fan-out.

## Options considered

| Option | Advantages | Disadvantages | Evidence |
|---|---|---|---|
| **A. `attempts` as the single claim unit for worker work; control-plane work bypasses claiming; one transaction per boundary write; turns nested *under* an agent attempt with the lease copied, renewed together (chosen)** | Reuses the ADR-0016 machinery that is already tested (fencing triple, `FOR UPDATE SKIP LOCKED`, advisory-locked reconciler) instead of re-solving it; one job key per logical work item, which is what case 1/2 need; `waiting`/`ready` become plain row states with no worker attached | Two leases exist for an agent attempt (attempt + turn), so the renewal rule must be explicit or a wedged worker keeps writing transcript rows; `attempts` and `conversation_turns` need a join column | ADR-0016 § 3 claim SQL pinned in `migrate_test.go`; ADR-0016 § 4 reconciler; M2's `internal/worker/turnloop.go` renewal loop |
| B. Reuse `conversation_turns` as the attempt table (an attempt *is* a turn) | One table, one lease, no new claim SQL | Turns are conversation-scoped with "one live turn per conversation" — a `for_each` of 25 items needs 25 live turns in one conversation, or 25 conversations per node, and a `process.exec` node has no conversation at all; the transcript would be the execution log | rejected: `01` separates Conversation (human-visible) from Attempt (execution evidence) |
| C. One generic `work_items` table with a `kind` discriminator, replacing turns | Scheduler-shaped, exactly `02`'s language ("unique job keys") | Migrations rewrite M2's proven hot path for cosmetic unity; turns already carry ACP-specific columns (`stop_reason`, `cancel_requested_at`) that a generic table would dilute; M2 is Accepted and shipped | compared; rejected — same shape, additive name (`attempts`), zero rewrite |
| D. Worker-side scheduling: hand the whole run graph to one worker, which drives its own DAG locally | One claim per run; no per-node DB round trips; trivial loop semantics | A worker crash loses 24 in-flight nodes with no per-node durable state, which contradicts D-009 and `02`'s "worker host lost → retry from last portable checkpoint"; `waiting_human` would hold a worker slot; capacity accounting becomes per-worker guesswork | rejected on `02`/D-009 grounds |
| E. Retry reverts the workspace to the last checkpoint (`git reset --hard <checkpoint>`) then re-runs the node | Literal reading of `03`'s "retry from previous completed boundary"; deterministic | Destroys an agent's partial edits that D-009 says users accept redoing *incrementally*, and an ACP agent's own commit history in the worktree; `git reset` in a sandboxed attempt is a mirror write outside the granted ref namespace unless the worker does it unsandboxed (which makes retry a worker-privileged operation with no policy attached) | compared; recorded as the `restore_checkpoint` mode but **not** the default (§ 6) |

## Decision

### 1. Rows and keys

| Table | Key/identity | Notes |
|---|---|---|
| `runs` | `id`; pins `pipeline_revision_id`, `revision_digest`, `plan_digest`, `assignment_id`, `project_id`, `inputs` jsonb, `policies_snapshot` jsonb, `status`, `cancel_requested_at`, `paused_reason`, `depth`, `parent_run_id`, `worker_volume_id` | `09` invariant 1: exactly one published revision + project; `depth` bounds recursion (hard max 2) |
| `run_inputs` | `(run_id, name)` | validated against the revision's `spec.inputs` at creation; the validated/coerced value is what bindings read |
| `node_executions` | `id`; `UNIQUE (run_id, node_instance_key)` | one row per *runtime* node occurrence: `plan[0]`, `build_until_verified[2]/review`, `fan_out[3]/implement_one`; `status` per `01` plus `waiting`; `execution_location` ∈ `worker` \| `control_plane`; `outputs` jsonb; `outcome` text; `in_flight` bookkeeping for fan-out |
| `attempts` | `id`; `UNIQUE (node_execution_id, attempt_number)`; index on `(status, scheduled_at, id) WHERE status='queued'` | `09`'s `UNIQUE (run_id, node_instance_key, attempt_number)` is enforced transitively through the two uniques; `worker_id`, `lease_expires_at`, `fencing_token` (from `attempt_fencing_seq`), `deadline_at`, `error_class`, `conversation_id`, `turn_id`, `overrides` jsonb |
| `run_checkpoints` | `(run_id, node_execution_id)` | the durable boundary record (§ 6) |
| `approval_requests` | `id`, `UNIQUE (node_execution_id)` | pipeline gates (§ 9); **not** `permission_requests` — see § 9 for why both exist |
| `pipeline_invocations` | `id`; `UNIQUE (node_execution_id)`, `UNIQUE (child_run_id)` | child-run bookkeeping (§ 10) — **not** `attempt_id`: § 3 and § 10 make `pipeline.invoke` control-plane work with no attempt row, so the invocation is keyed by the node execution that owns it (contract § 9.1 row 20; contract § 1's DDL comment points here) |
| `run_idempotency_keys` | `UNIQUE (project_id, key)` → `run_id`, `created_at`, `request_sha256` | case 1 (§ 12) |
| `attempt_fencing_seq` | bigint sequence | drawn at claim time only, never per row (ADR-0016's rule) |

`node_instance_key` is a **text path, not a position index**: `/<node-id>` for graph nodes,
`/<node-id>[<iteration>]` for `until` iterations, `/<node-id>[<index>]` for `for_each` elements,
`/…/<child-node-id>` for nested scopes, joined by `/`. It is stable under a re-dispatch and
insufficient alone to identify a row (hence the composite uniques), so it satisfies invariant 6.

### 2. Planning happens once, at publish; the run stores the plan

`POST /drafts/{id}/publish` compiles the graph into a **plan**: scopes, entry/exit nodes, per-node
reference lists (ADR-0022 § 5), compiled `when`/`passWhen` predicates, budget ceilings, topological
order and cycle results, output-schema validators. The plan's canonical bytes are stored with the
revision (`compiled_plan` jsonb) and digested as `plan_digest`; a run copies both into
`runs.plan_snapshot`. Consequence: the runtime never recompiles, a scheduler bug cannot disagree
with the validator, and `03`'s "pipeline may create child runs but may not rewrite its own
published graph" is structural — the graph the run executes is a snapshot of a snapshot.

### 3. Two executors, one state machine

`execution_location = 'control_plane'` (in M4: `condition`, gate *evaluation* after its decision
arrives, `until`/`for_each` scope advance, `pipeline.invoke`'s status polling, run output
evaluation) moves `pending → ready → succeeded` **inside the advancer's transaction** with `actor
kind=system` and no `attempts` row. `execution_location = 'worker'` (`agent.acp`, `process.exec`,
`model.chat`, `artifact.publish`) uses the full `01` sequence
`pending → ready → leased → running → {succeeded, failed, skipped, waiting, cancelled,
interrupted}`, with attempts appended per retry. `01`'s machine is refined, not changed:
control-plane nodes simply never enter `leased`, and the CHECK that makes that unrepresentable is
listed in contract § 1.

Rationale: evaluating a predicate on a worker costs a claim, a lease, a fencing token and a
sandbox decision for an expression with no I/O (ADR-0022 § 3), and it would let a compromised worker
choose the route. Cost: two paths through one state machine, which is why the paths are named in
the row rather than inferred from the node kind at read time.

### 4. Claim, lease, fencing (worker work)

```sql
UPDATE attempts a
SET status = 'leased', worker_id = w.worker_id,
    lease_expires_at = now() + make_interval(secs => 30),
    fencing_token = nextval('attempt_fencing_seq')
FROM (  SELECT a2.id AS attempt_id, $1::uuid AS worker_id
        FROM attempts a2
        JOIN node_executions ne ON ne.id = a2.node_execution_id
        JOIN runs r            ON r.id = ne.run_id
        JOIN workers wr        ON wr.id = $1::uuid
        WHERE a2.status = 'queued' AND a2.scheduled_at <= now()
          AND r.status = 'running'
          AND wr.status = 'online' AND wr.active_attempts < wr.capacity
          AND (r.worker_affinity IS NULL OR r.worker_affinity = $1::uuid)
        ORDER BY r.priority DESC, a2.scheduled_at, a2.id
        FOR UPDATE OF a2 SKIP LOCKED
        LIMIT $2 ) w
WHERE a.id = w.attempt_id
RETURNING a.*, ne.node_instance_key, r.revision_digest, r.plan_digest;
```

Same shape, same guarantees, same honest caveat as ADR-0016 § 3: `SKIP LOCKED` is a queue, not
exactly-once execution — the fencing triple is what makes a stale write rejectable, and every
attempt-state write, every attempt-scoped journal append, every artifact publish and every
checkpoint write goes through it (`01` invariant 3). Lease 30 s, renewed every 10 s by the
worker's existing loop.

**Affinity** is `runs.worker_affinity`, set when the run's workspace becomes `ready`
(ADR-0017: the workspace lives on one worker's `volume_id`): the first worker to prepare it is the
run's affinity for its lifetime. Unlike M2 there is no "unbound means any worker" phase after that
point, because a run workspace is not relocatable; an unbindable run stays `queued` and the API
says so (`contract § 5`), which is `02`'s "one worker remains the execution single point of
failure" made visible instead of guessed.

**Agent attempts hold two leases.** An `agent.acp` attempt creates (or resumes) a conversation and
enqueues a `conversation_turns` row **in the same transaction as the claim**, copying
`worker_id`/`fencing_token` from the attempt and stamping `turns.node_attempt_id`. The rule that
keeps the two honest: the attempt renewal renews the turn in the *same* statement, so a turn lease
can never expire while its attempt is alive; and every turn write still goes through ADR-0016's
fenced helper. The alternative (turn renews itself) would let the two deadlines drift and produce
exactly the "reconciler interrupted a turn whose worker was fine" bug M2 was careful to avoid.
`attempts.conversation_id` + `acp_session_bindings` give the session, so `04`'s
`resume_if_supported` is an ACP-level question answered by the binding's existence, never by the
attempt row.

### 5. Readiness, skipping and joins (advancer)

One transaction, driven by the event that changed a node's terminal state (attempt fenced write,
approval decision, scope advance, run pause/resume):

1. collect the run's node executions in the affected scope;
2. a node is `ready` when every `dependsOn` is `succeeded` **or** `skipped`, and its `when`
   evaluates true; every `dependsOn` `skipped` or `failed-continue` ⇒ the node is `skipped` too
   (this is what makes `condition` routing work without route edges, ADR-0021 § 6);
3. a skipped node still gets an envelope (ADR-0022 § 3) so downstream predicates see `"skipped"`;
4. a node whose `dependsOn` failed with `onExecutionError: stop` fails the run
   (`failed_cause = "node_execution_failed:<key>"`) and cancels its queued descendants;
5. no joins in M4: a scope ends when its terminal nodes are all terminal (`parallel`/`join` are
   deferred, ADR-0024), and `for_each` ends when every index key is terminal;
6. write state + events + outbox atomically; loop until no node changes; the whole advance is
   idempotent, because the transaction re-derives readiness from row state rather than from a
   queue's memory (this is what makes the crash-during-advance case recoverable).

Concurrency: `policies.maxConcurrentNodes` per run, the assignment's limit, and
`workers.capacity`/`active_attempts` are the enforced layers; the scheduler's tie-break is
`(r.priority DESC, a2.scheduled_at, a2.id)`, so one project's 25-child fan-out cannot starve
another project's single node except by priority, and priority is admin-set, not inferred
(`03`'s fairness requirement, narrowly read). Org/installation-level quotas stay **Later** —
measuring them requires the usage telemetry `07` refuses to assume.

### 6. Node-boundary checkpoints, and what a retry actually restores

An attempt's success transaction writes, in one fenced transaction: validated `outputs`,
`artifact_refs`, `run_checkpoints` row, downstream `ready` rows, events. The checkpoint row is
`{node_execution_id, attempt_id, inputs_digest, outputs_digest, artifact_refs[],
repo_states[{repository_id, base_commit, head_commit, modified_paths_artifact}],
workspace_id, volume_id, worker_id, plan_digest, created_at}` — the same capture ADR-0017 D8/
ADR-0020 D8 already produce for a turn, now attached to a node boundary. `02`'s "manifest of
changed paths, optional internal refs/bundles, policy-controlled, must exclude ignored secrets" is
that artifact, with ADR-0018's exclusion list applied *before* capture.

Retry policy, one column on the node (`retry.workspacePolicy`), default `continue_workspace`:

- `continue_workspace` (**M4 default**, and the exit test's mode): the worktree is left exactly as
  the interrupted attempt left it; the retry's prompt gains a recorded
  `retry_context {attempt, error_class, head_commit, modified_path_count}` block. Justification:
  D-009 says users accept *redoing the incomplete node*, not *losing the incomplete node*, and
  `03`'s checkpoint sentence is about **where the durable record boundary is**, which `continue_workspace`
  honours fully (the checkpoint of the last completed node is intact and queryable).
- `restore_checkpoint`: the worker, unsandboxed and *before* launching anything, resets the
  worktree branch to `checkpoint.head_commit` for the last completed boundary. Allowed only when
  every repo in the run is at a committed state at that boundary (an uncommitted diff would be
  destroyed), and it emits `run.checkpoint_restored {from_commit, discarded_paths[]}`. M4
  implements it because the exit test must show the engine *knows* the difference; D-024 stays
  **Open** since neither mode is portable across volumes.
- A retry after `interrupted` never re-runs a node that succeeded; a retry of a *run*
  (`POST /runs/{id}/retry`) targets failed/interrupted node executions and re-queues them with the
  scope bookkeeping recomputed, so an `until` whose iteration 2 died restarts iteration 2, not the
  loop.

### 7. Failure classes, retry and budgets

`error_class` enum, because backoff and reporting both key on it:
`infra` (claim/DB/store fault), `interrupted` (lease lost, worker died, shutdown — written by the
reconciler, never by the dead process), `timeout` (node `timeoutSeconds` or run budget),
`agent_error` (ACP turn `failed`), `invalid_output` (output failed its JSON Schema — ADR-0022 § 4
rule 2), `predicate_error` (CEL eval error, ADR-0022 § 3), `sandbox_enforcement_failed`
(ADR-0019 D6), `workspace_lost` (`workspace.recovery_lost`, case 20), `binding_error`,
`approval_expired`, `cancelled`.

`retry {maxAttempts, backoff {baseSeconds, multiplier, maxSeconds, jitter}, retriableErrors}`
(compiled by ADR-0021's schema). The delay is
`min(maxSeconds, baseSeconds * multiplier^attempt_number)` with ±20 % jitter; the *computed*
`scheduled_at` is persisted on the attempt, so an API restart mid-backoff does not restart the
backoff. Non-retriable classes (`workspace_lost`, `predicate_error`, `approval_expired`,
`cancelled`, `sandbox_enforcement_failed` unless reconfigured) fail the node immediately.
`attempts.max_attempts` is clamped to the effective assignment budget, and `03`'s "avoid infinite
automatic retries of external side effects" is structural: no node kind that performs an external
side effect is schedulable in M4 (ADR-0024), so the only repeated side effects are agent prompts and
commands inside a run workspace.

Budgets enforced, with named causes of failure: `maxDurationSeconds` (run), per-node
`timeoutSeconds`, `maxNodeExecutions` (the loop/fan-out runaway guard), `maxChildDepth` ≤ 2,
`maxConcurrentNodes`, and the ADR-0022 per-run expression cap. Exceeding one fails the run with
`failed_cause` naming the budget — never silently truncating a scope.

### 8. `until`, `for_each`, and their outputs

- `until`: iteration `i` runs the body as a fresh set of node executions keyed
  `/<until-node-id>[i]/<child>` (the `until` node's own id — § 1's key grammar, not a literal
  `loop` segment; contract § 1's constraint table shows `/build_until_verified[2]/review`); after the body's terminal nodes settle, the control plane evaluates
  `passWhen` over the iteration envelope. `true` → scope succeeded with `resultBindings` evaluated
  over that iteration; `false` → next iteration if `i < maxIterations`, else the scope **fails**
  with `failed_cause = "until_exhausted"` and the full per-iteration evidence preserved (case 7:
  "no infinite loop", and the bound is mandatory in the schema); an eval error →
  `predicate_error`, failing the scope at once rather than counting as false. `previous` (an object,
  empty on iteration 1) exposes the prior iteration's `resultBindings` and `iteration` (an `int`) is
  the counter — `carryForward`, which is how the spec's "address previous review feedback" works
  without a back-edge. These are two roots, not one `loop` object: cel-go v0.31.0 reserves `loop` as
  an identifier and compiles no expression through it (ADR-0022 § 2's amendment; observed in
  `docs/compatibility/m4-spike/results-contract-probes.txt`). `iterations` and the child keys are
  engine-provided outputs.
- `for_each`: `items` must evaluate to an array; `0` items ⇒ the scope succeeds immediately with an
  empty result list and one `node.scope.completed {scope, items: 0}` event (`03`'s zero-item edge
  case, asserted as a test, not a comment). Elements are keyed by index; `maxConcurrency` is
  literal (ADR-0021 Decision 4) and enforced by counting in-flight child executions in the
  advancer. `onChildFailure ∈ {stop, collect_and_continue, fail_after_all}`: `stop` cancels queued
  siblings and succeeds/fails the scope per policy while **preserving** completed sibling results
  (case 8); results are exposed as `outputs.children = [{index, key, status, outcome, outputs,
  artifact_refs}]`.

### 9. Human gates are approvals, and they are not permission requests

`human.approval` is a node execution that holds neither a worker nor a lease: the row goes `ready → waiting`, an `approval_requests` row is inserted
(`{scope: project, kind: 'pipeline_gate', node_execution_id, summary, artifact_refs, approver_roles,
approver_user_ids, deadline_at, state: pending|decided|expired|cancelled|denied, decided_by,
decision, comments, version}`) and the run flips to `waiting_human`. A decision comes from
`POST /api/v1/approvals/{id}/decide` (or the UI's button) and is authorized **at decision time**
against the project role and the approver set — `12` case 9 (approver lost access between request
and decision) is a `403`/`409` + `approval.denied` event, not a silent accept. `onTimeout` is
`fail | cancel_run | expire` (expire re-requests once, then fails), evaluated by the reconciler's
approval pass. Nothing is claimed while waiting, and the run's other branches keep running —
which is what makes `03`'s "wait for human" a scope control rather than a pause.

`approval_requests` and ADR-0016's `permission_requests` are **different things and stay
separate**: the latter is an ACP tool prompt answered by the conversation's *current controller*,
the former is a pipeline gate answered by anyone the project authorizes. `09` names both
(`approval_requests` in the Agent family, and `permission_requests` is what M2 renamed it to);
collapsing them would put ACP option-id semantics on a pipeline gate and CAS versioning on a tool
prompt. The contract keeps ADR-0016's mapping note intact and adds this one beside it.

`controller_kind = 'run_attempt'` finally gets written: while an agent attempt's turn is live, the
attempt holds the conversation's control row (version CAS, ADR-0016 § 2 — no rename needed). A
human taking control of a run conversation cancels the turn (ADR-0016 § 5), the attempt closes
`interrupted {reason: "control_taken"}`, and the run moves to `paused` with
`paused_reason = 'human_takeover'`; `return-control` resumes it and the recorded human
intervention becomes the retry context (`03`'s "continuation with recorded human intervention
context"). No control handoff happens without an event naming both ends.

### 10. Child pipelines, cancellation, pause

`pipeline.invoke` (M4 minimal, ADR-0024) resolves its target **at run start**, never later:
`revisionDigest` literal, or the assignment's pinned revision resolved once and stored on the
invocation. The parent's `waitFor` is `completion` only. Child runs get `parent_run_id`,
`depth = parent.depth + 1`, a fresh workspace (ADR-0017: run scope, its own refs) and their own
attempts; the parent's node execution polls in the advancer (no worker) and exposes
`outputs.child_run_id`/`status`/`outputs`. Bookkeeping is `pipeline_invocations` — not a hidden
second run.

Cancellation is a cascade, and only a cascade: `POST /runs/{id}/cancel` sets
`cancel_requested_at`; the advancer (i) moves `queued`/`ready` rows to `cancelled`, (ii) marks live
worker attempts `cancel_requested` — the worker sends ACP `session/cancel` and, on timeout,
terminates the **process group** (ADR-0019's launch owns it), then writes the honest terminal
itself (`cancelled`), falling back to the reconciler's `interrupted` if it dies first, and (iii)
recursively cancels child runs, writing `run.cancel_requested {cascade: true, children: [...]}`.
`cancelPolicy: detach` is **not implemented** in M4: the column exists on `runs.policies_snapshot`,
the compiler rejects it with `unsupported_policy`, and a detached child's visibility requirement is
already met by `GET /runs/{id}/tree`. Pause stops scheduling only; "ask the agent to yield" is
Later.

### 11. Reconciler extensions (serve, advisory-locked, one pass)

`02`: a reconciler detects expired leases, marks attempts `interrupted`, inspects persisted
checkpoints and decides retry/backoff/escalation. Concretely, one transaction per row, capped
batch, `pg_try_advisory_lock` per pass (the ADR-0016 pattern reused verbatim):

| Pass | Condition | Action |
|---|---|---|
| 1 | `leased`/`running` attempt past `lease_expires_at` | → `interrupted`, `run.attempt.interrupted {reason: "lease_expired"}`, then § 7 retry decision (`scheduled_at` or node failure) |
| 2 | `waiting_human`/`waiting` approval past `deadline_at` | → `expired`, `approval.expired`, node per `onTimeout` |
| 3 | `running` attempt past `deadline_at` with the worker's heartbeat still fresh | leave the row; set `cancel_requested_at` and let the worker close it (a worker that is answering is not dead) |
| 4 | run past `policies.maxDurationSeconds` | cascade § 10 with `failed_cause = "run_duration_exceeded"` |
| 5 | `runs.status IN ('queued','preparing')` whose workspace is `lost`/absent for > 1 pass | `interrupted` → `workspace_lost`, no auto-retry (case 20's honest arm) |
| 6 | stale `run_idempotency_keys` | delete (§ 12's TTL) |

The reconciler never marks anything `succeeded`, never evaluates a `passWhen`, never invents an
output, and its rows are attributed `actor_kind='system'` (ADR-0016's implementation note).

### 12. `Idempotency-Key` for `POST /runs`, and nothing else

`run_idempotency_keys {project_id, key, run_id, request_sha256, created_at}` with
`UNIQUE (project_id, key)`: same key + same `request_sha256` → the *stored* `run_id` and `200`; same
key, different body → `409` problem detail (case 1 is about one logical run, not about silently
accepting a different request). TTL 24 h, swept by pass 6. ADR-0014's "unimplemented" note is
narrowed to this route and no other; publishing drafts and deciding approvals stay
ordinary versioned CAS mutations.

## Consequences

- Positive: `02`'s recovery table becomes testable per row — each failure class has a writer
  (worker or reconciler), an event, and a defined retry consequence, and the two dangerous cases
  (stale write after lease loss, worker killed mid-node) are constraint-and-fence behaviour rather
  than handler discipline.
- Positive: `waiting_human` costs nothing, so a pipeline with a three-day approval is not a
  three-day worker reservation — the single most important property for a "factory" product.
- Positive: `plan_digest` + `plan_snapshot` mean a run executes a compiled artifact, so `12` case 11
  (revision changed mid-run) is unrepresentable rather than merely avoided.
- Negative: `continue_workspace` means a retry can inherit an interrupted agent's half-finished
  edits. This is a real semantic choice (`03` reads the other way at first glance) and it must be
  reported as such in every M4 artifact; `retry_context` and `run.checkpoint_restored` are the
  visible half.
- Negative: two leases per agent attempt; the mitigation (single renewal statement, shared token
  lineage) is one place to get wrong, and a wrongness there shows up as spurious `interrupted`
  turns.
- Negative: affinity-by-workspace pins a run to a worker for its life; with one worker this is
  invisible, with two it is a placement policy M4 does not have (no rebind, no drain-aware
  migration; ADR-0016 § 10 already deferred this).
- Negative: control-plane execution paths (`condition`, scope advance) are new code in `serve` that
  ADR-0014's replica-scaling story now has to cover: the advancer is a *writer*, so it needs the
  same advisory-lock discipline as the reconciler or two replicas can advance the same scope (the
  transaction's row locks make the loser a no-op, which is the actual safety argument — the lock is
  an optimization).
- Negative: `maxConcurrentNodes` enforcement in the advancer is a count query, so very large
  fan-outs make each advance expensive; the `for_each` cap is the bound.
- Ops: `workers.capacity` becomes load-bearing (a wedged worker is now a stalled queue, visible as
  `attempts` stuck `queued` with an online-but-full worker); metrics from `02`'s list
  (queued/running/waiting attempts, lease expiry, retry loops) become real counters.

## Security/privacy

- Authorization for a run mutation is the project predicate, on every route, answered `404` from
  outside (ADR-0014 § 3); approval decisions re-check the role **at decision time** (case 9).
- Fencing tokens, `worker_id`-as-arbiter and `lease_expires_at` never reach a browser body
  (ADR-0016 § 8, unchanged); the run API exposes attempt *status*, not ownership internals.
- Node outputs are attacker-influenced (an agent's JSON): outputs are size-capped, schema-validated,
  redaction-scanned before they become bindings, and never rendered as HTML. A prompt built from
  another node's output is the injection surface ADR-0022 names; a `condition` expression over that
  output cannot escape its allowlist.
- No secret material in a checkpoint, an event payload, or `attempts.overrides` (invariant 5;
  ADR-0018's `node_attempt` lifecycle becomes real here: mounts exist for the duration of one
  attempt and the materialization row references `attempt_id`).
- Cancellation is not a security boundary: an interrupted agent process keeps its grants until the
  worker's process-group kill lands; a worker that cannot be trusted to kill its own children is
  the failure ADR-0019 already documents as unsolved at the tenant level (D-025 Open).
- Child runs inherit the *project*, never elevated authorization: a child's assignment resolution
  is validated against the parent's project membership snapshot, so a pipeline cannot launder a
  cross-project read by invoking another pipeline.

## Verification

This record is a design contract; what has been *observed* is the substrate it stands on, and what
remains is listed honestly.

Observed already (M2, ADR-0016 Verification): the claim SQL shape
(`FOR UPDATE SKIP LOCKED`, monotonic `nextval` token, `interrupted` without `stop_reason`,
`completed` without `finished_at` → `23514`), single-owner CAS with a `409` carrying the winner,
reconciler one-pass advisory-lock behaviour, and a real worker closing a live ACP turn
(`docs/compatibility/ACP.md`). Observed in M3 (ADR-0017/0020): workspace reclaim keyed on
`volume_id`, per-scope ref write bounding, and the checkpoint *capture* as an artifact.

Required before M4 is called done (contract § 7, `12-test-strategy.md` cases 1, 2, 3, 5, 7, 8, 11):
constraint-behaviour tests on a database that ran the migration (`UNIQUE (run_id,
node_instance_key, attempt_number)` via the join, `attempts` lease triple, control-plane rows never
`leased`, one live approval per node execution, idempotency uniqueness); a real two-worker claim
race; a real `docker kill` of the worker mid-`agent.acp` with the checkpoint/retry route asserted
from Postgres and the UI; `until_exhausted` at `maxIterations`; a `for_each` of 0 and of 25 with one
child failing; the idempotent double-`POST /runs`; and revision-pin-while-running-changed.
No claim here is made about portable cross-host recovery (D-024 Open), `join` semantics, detached
cancellation, or org-level quotas, and none of them may be inferred from this record.

## Migration/rollback

Forward-only `00005_m4_pipelines.sql` (ADR-0013; `ExpectedSchemaVersion()` → 5). Nothing rewrites
`00001`–`00004`; `conversation_turns` gains a nullable `node_attempt_id` (M2 rows stay NULL and keep
claiming as before, because the M2 claim SQL is unchanged — M4's claim is a different statement over
`attempts`), and `workspaces.run_id` finally gets populated (M3 contract D1 closes). Deploy order:
`migrate` → worker (new claims) → serve replicas (advancer + reconciler). An un-migrated replica
answers `503` from readiness; a new API against an old worker merely sees no queued attempts, which
is the safe direction.

Rollback of the engine is a *feature flag in configuration*, not a schema revert: with
`COMMUNICATION_PIPELINE_SCHEDULER=off` the advancer and the attempt claimer do not start, runs stay
`queued`, and conversations keep working — every M2/M3 guarantee survives M4's absence. Abandoning
M4 outright means a forward `00006` dropping the new tables, with `domain_events` rows preserved
(the journal is not the engine's property, ADR-0016's migration argument repeated).
