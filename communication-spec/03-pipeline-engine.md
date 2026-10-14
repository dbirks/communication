# 03 — Pipeline Definition Language and Execution Engine

## Design requirements

A visual graph, YAML file, and assistant-created draft are **three authoring surfaces for one canonical versioned pipeline representation**. Pipeline logic is organization-defined; the scheduler only knows execution state/dependencies/capacity. The published definition remains immutable for the duration of a run. A pipeline may create child pipeline runs, but it may not arbitrarily rewrite its own published graph.

### Definition versus runtime graph

- **Definition graph:** unique node IDs, explicit directed dependencies, typed JSON inputs/outputs, parameter expressions, policy, node templates, UI layout metadata (non-semantic).
- **Runtime graph:** a tree/DAG of node executions, loop iterations and spawned child pipeline runs. One definition node can produce thousands of execution attempts. Never replicate them into the published definition.
- **Loops:** explicit `until`/`for_each` composite scopes with limits and nested acyclic graphs; do not allow unrestricted back-edges. `parallel` and `join` are scopes/controls.
- **Composite outputs:** `until`, `for_each`, and `pipeline.invoke` expose declared result bindings scoped to their child executions; for example an `until` result may map the successful last-iteration reviewer evidence to its `summary` output.
- **Publish result:** pipeline output bindings evaluated at successful terminal state; failures include error envelope and partial artifacts.

## Standard node catalogue

| Node kind | Inputs / outputs | Notes |
|---|---|---|
| `agent.acp` | prompt, profile, context, workspace → structured output, conversation ref, artifacts | Start fresh or resume existing session by declared policy; ACP capabilities negotiated |
| `model.chat` | messages, model/provider, JSON schema → text/JSON | OpenAI-compatible endpoint, no ACP process |
| `process.exec` | executable, argv, cwd, environment references → exit, stdout/stderr artifact, JSON extraction | No free-form shell expansion by default |
| `condition` | CEL expression over outputs/run context → route key | Evaluate bounded, deterministic expression, no filesystem access |
| `gate` | judge/check/human decision → `pass|fail|indeterminate` + evidence | Convenience template over agent/model/command/human; distinguish execution error |
| `human.approval` | artifact/context, approvers, deadline → decision, comments | Durable wait; no worker slot held |
| `until` | nested subgraph + termination predicate → final result/iterations | Maximum iterations/duration mandatory; failures not implicitly “false” |
| `for_each` | array + nested subgraph → indexed result list | Configurable max in-flight and failure aggregation |
| `parallel` / `join` | branch scopes → collected results | Join modes `all`, `any`, `quorum` (quorum later if untested) |
| `pipeline.invoke` | pipeline revision + mapped inputs → child run ref/results | Child run has own lifecycle and retries; parent defines wait policy |
| `artifact.publish` | content/path → artifact ref | MIME, sensitivity, hash, retention |
| `git.commit`/`git.publish` | workspace/repo refs → commit/branch/PR refs | Explicit, idempotent/reconciled side effects |
| `integration.query` / `integration.action` | adapter and typed arguments → JSON | GitHub first; other backends follow provider contract |

**Reusable node templates** are authored wrappers over built-in node kinds, parameterized and versioned. E.g. `Security Reviewer` is `agent.acp` plus APM review profile, prompt, schema, workspace read-only policy, accepted error handling. Templates must not silently bypass sandbox/credential policies.

## Canonical document & schema

Provisional API version: `communication.dev/v1alpha1` (name to settle in ADR). YAML is the **portable text representation**; server stores parsed canonical JSON with normalized ordering and content hash. JSON Schema governs shape and user-defined data contracts; hash excludes purely visual layout metadata only if a stable canonicalization ADR says so. No embedded Python or arbitrary executable JS in YAML.

Sample in `examples/feature-development.yaml`. A simple draft schema is in `schemas/pipeline.schema.json`. It is **illustrative, not frozen**.

### Bindings and expressions

- Inputs are declared as JSON Schema. UI renders form fields from schema and sensible widgets.
- Outputs from nodes are arbitrary JSON objects with optional JSON Schema. Built-in examples: `plan`, `review_result`, `test_result`.
- Binding syntax: `${{ inputs.goal }}` and `${{ nodes.plan.outputs.plan }}` as ergonomic presentation; internally compile to a structured expression AST.
- For routing/expression evaluation, use a deliberately restricted **CEL** subset (e.g., `nodes.review.outputs.approved == true`), with allowlisted functions and budgeted evaluation; never evaluate Go templates with method access or arbitrary code.
- JSON Schema validation runs on inputs and produced outputs before downstream readiness; errors can route via node-level failure edges.
- Binary content travels by `artifact_id`; filesystem content by `workspace_ref + relative_path`, never path strings outside an authorized workspace.
- Status result envelope per node: `{execution_status, business_outcome, outputs, artifact_refs, workspace_ref, conversation_ref, diagnostics}`. `execution_status=success` with `business_outcome=fail` is common for tests/reviewers; engine exceptions are different.

## Scheduling semantics

1. Compile and validate revision: unique IDs, DAG scopes, no orphan/invalid ports, no recursive child invocation without bounded depth, valid secret refs, no secret literals, valid resource limits, valid schemas, reachable terminal outcomes.
2. Start run: persist immutable revision digest, effective assignment inputs, policy snapshot, resource budget, starting repository refs.
3. Determine ready nodes from dependency satisfaction; claim using Postgres scheduler and workspace affinity.
4. Materialize minimum required workspace/secret/agent package context; execute attempt; append stream events.
5. Validate results and checkpoint at node boundary. Evaluate routes and queue downstream nodes, wait for human, or advance loop/child scopes.
6. When all required terminal branches resolve, compute pipeline outputs, collect artifacts, mark completed/failed/cancelled.

**Concurrency:** limits layered `installation → organization → project → pipeline assignment → run → node/fanout`. User-selected 10-way fan-out is supported if resource quotas allow; sensible default proposed 3. Fairness should avoid one project monopolizing workers.

**Failure policy per node:** `stop`, `retry` (max count, backoff/jitter, retriable codes), `continue` (explicit failed envelope), `route` to named error branch; timeout and cancellation treated separately. An invalid condition is an execution error, not a business fail. Avoid infinite automatic retries of external side effects.

**Pause/Cancel/Take control:** pause stops future scheduling (and optionally asks agent to yield); cancel sends ACP cancellation if available followed by process-group termination on timeout; human takeover relinquishes factory session controller lock while the factory run waits, and return-control queues a continuation with recorded human intervention context.

**Checkpoint rules:** after success of each step preserve durable outputs/events, artifacts, repository base + resulting refs and relevant portable checkpoint metadata. For an interrupted active step, retry from previous completed boundary. Avoid snapshotting on every token/tool call.

## Runtime edge cases to test

- `for_each` of zero items; maximum fan-out; one child fails while siblings pass.
- Parent cancelled with 12 children; policy chooses cascade or detach; detached child is still visible.
- `until` reaches max iterations or accepts a condition that always returns indeterminate.
- Review agent returns malformed JSON; do not silently interpret as pass.
- Retry node uses `resume_session` but provider has no capability; configured fallback is `new_session` or fail.
- Shared writable workspace explicit option races with concurrent writers; require warning and workspace-exclusive lock for unsafe node kinds.
- UI graph edited after run start: existing run remains pinned to original revision.
- Run-local node override changes only that retry; emits `run.override.applied` event with actor, before/after and reason.

## Publication and merge

`Implement` produces code in workspace; **not automatically a PR/merge**. Ship optional sample pipelines: `Commit Branch`, `Create Draft PR`, `Verify Merge Candidate`, `Resolve Conflict`, `Merge With Approval`. Gas Town's Refinery (verification gates, batch-and-bisect merge queue) is **research inspiration**, not a required feature in initial scheduler. Prefer PR-based protected branch workflows as the default example; orgs choose alternatives.
