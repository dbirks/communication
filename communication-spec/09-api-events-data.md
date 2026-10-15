# 09 — API, Event and Persistence Contracts

This document specifies **proposed** public API conventions, not an already deployed server. Freeze details after the first vertical slice and ADR.

## HTTP APIs (suggested)

Use versioned `/api/v1` JSON endpoints. Authorization always project/org scoped. Operations creating work accept `Idempotency-Key`; resources include `etag/version` for conditional updates; adopt problem+json-compatible errors.

| Resource | Examples |
|---|---|
| Identity/project | `GET /me`, `GET/POST /projects`, `GET /projects/{id}/repos`, `PUT /projects/{id}/members/{uid}` |
| Pipelines | `GET/POST /pipelines`, `POST /pipelines/{id}/drafts`, `POST /drafts/{id}/validate`, `POST /drafts/{id}/publish`, `GET /revisions/{digest}` |
| Assignments | `GET/POST /projects/{id}/assignments`, `POST /assignments/{id}/promote`, `POST /assignments/{id}/preview` |
| Runs | `POST /runs`, `GET /runs/{id}`, `POST /runs/{id}:pause`, `:resume`, `:cancel`, `:retry`, `GET /runs/{id}/nodes` |
| Conversations | `GET /projects/{id}/conversations`, `POST /projects/{id}/conversations`, `GET /conversations/{id}`, `POST /conversations/{id}/messages`, `/take-control`, `/return-control`, `/cancel`, `POST /conversations/{id}/permissions/{requestId}`, `GET /conversations/{id}/events` (SSE) |
| Profiles/assets | `GET/POST /agent-profiles`, `/node-templates`, `/secrets` (metadata-only) |
| Artifacts | `GET /artifacts/{id}` with signed controlled download; HTML previews through separate sandbox origin |
| Assistant | `POST /assistant/conversations`, `POST /assistant/{id}/messages`, typed tool and question response APIs |
| Ops | `GET /system/health`, `/system/readiness`, `/workers`, `/compatibility`, `/audit` |

Do not make browser API accidentally expose worker internal service endpoints. Worker claims through DB in the initial implementation; direct worker API, if added, requires mutual authentication and short-lived authorization.

## Durable event envelope

```json
{
  "event_id": "evt_01...",
  "global_seq": 152007,
  "type": "node.attempt.completed",
  "schema_version": 1,
  "occurred_at": "2026-10-14T18:00:00Z",
  "organization_id": "org_1",
  "project_id": "project_4",
  "run_id": "run_482",
  "node_execution_id": "ne_5",
  "attempt_id": "attempt_2",
  "conversation_id": "conv_19",
  "actor": {"kind": "worker", "id": "worker_a"},
  "trace_id": "...",
  "payload": {"status": "succeeded", "result_ref": "result_42"}
}
```

Event types include `run.started`, `run.paused`, `run.interrupted`, `run.completed`, `node.attempt.started`, `node.attempt.failed`, `node.attempt.completed`, `agent.session.connected`, `conversation.message.*`, `conversation.tool.*`, `conversation.control.transferred`, `approval.requested/decided`, `secret.materialized` (**metadata only**), `sandbox.enforcement_failed`, `artifact.created`, `external_action.intent/reconciled`, `pipeline.revision.published`, `assignment.promoted`.

M2 (ADR-0016) fixes the conversation half of that list, emitted with typed payload structs from `internal/events/events.go`: `conversation.created`, `conversation.message.user`, `conversation.message.agent` (worker-coalesced readable chunks), `conversation.thought`, `conversation.tool.call`, `conversation.tool.update`, `conversation.permission.requested`, `conversation.permission.decided` (the `approval.requested/decided` pair, named for the ACP harness), `conversation.turn.started|completed|cancelled|failed|interrupted`, `conversation.control.transferred`, `agent.session.connected`, `agent.session.disconnected`. Conversation-scoped rows carry `conversation_id` **and** `project_id`, so the project stream stays a superset and replay uses one `global_seq` mechanism. `conversation.turn.interrupted` carries a `reason` and never a `stop_reason`: nobody reported an outcome, and the transcript says so.

The event journal is **durable operational history**, not a mandate to reconstruct every read model from events (full event sourcing unnecessary). For each significant state transition: one SQL transaction updates authoritative state, appends event and outbox notification. Event retention/export supported.

## Database table families

- Auth: `organizations`, `users`, `oidc_identities`, `memberships`, `project_grants`, `service_identities`.
- Project: `projects`, `repositories`, `repository_credentials` (secret ref only), `project_settings`.
- Config: `pipelines`, `pipeline_drafts`, `pipeline_revisions`, `node_templates`, `agent_profiles`, `assignments`, `assignment_versions`, `config_git_sources`.
- Execution: `runs`, `run_inputs`, `node_executions`, `attempts`, `worker_leases`, `workers`, `run_checkpoints`, `pipeline_invocations`, `trigger_deliveries`, `external_action_intents`.
- Agent: `conversations`, `conversation_events`, `conversation_control`, `agent_instances`, `acp_session_bindings`, `agent_capability_snapshots`, `approval_requests`.
  - M2 implements this family as (ADR-0016): `conversations`, `conversation_control`, `conversation_turns`, `acp_session_bindings`, `permission_requests`, plus org-scoped `agent_profiles` in the Config family. `conversation_events` is **not** a second table — the transcript is `domain_events` scoped by `conversation_id`, so one journal carries one gap-safe replay cursor. `approval_requests` is named `permission_requests`. `agent_instances` and `agent_capability_snapshots` are collapsed into `acp_session_bindings` (one row per launched session, with the capabilities the agent reported); reintroduce them as separate tables only when an ADR needs instance history beyond bindings.
- Storage: `artifacts`, `secret_metadata`, `credential_grants`.
- Operations: `domain_events`, `outbox`, `audit_events`, `schedule_cursors`, `integration_credentials`.

### Constraints / indexes to prioritize

- `UNIQUE (issuer, subject)` for OIDC identity.
- Published revision hash unique in organization.
- `UNIQUE (run_id, node_instance_key, attempt_number)`; monotonic fencing token for attempt owner.
- External trigger dedupe `(assignment_id, provider, delivery_id)` and action op-id unique.
- `conversation_control` exactly one current owner with version CAS.
- One non-terminal `conversation_turns` row per conversation (`UNIQUE (conversation_id) WHERE status IN ('queued','leased','running')`): two prompts into one running turn must be a constraint violation, not a handler convention. A live lease is owner + `lease_expires_at` + monotonically increasing `fencing_token` together, or it is not a lease.
- Exactly one live (`connected`) `acp_session_bindings` row per conversation — also the read that gives a conversation's turns worker affinity.
- Ordered `domain_events (project_id, global_seq)` pagination plus retention partitioning when needed. Conversation-scoped streaming adds `(conversation_id, global_seq)` and reuses the same commit-order guarantee, never a second cursor.
- Every sensitive query includes project permission predicate, not a client-controlled header.

## Event streaming to browser

Recommend SSE initially for append-only events; interactive mutations remain HTTP POST. SSE reconnects from monotonically increasing durable `global_seq` / `Last-Event-ID` and catches up from DB. For high-frequency token deltas, worker may batch/coalesce to reduce DB costs, while preserving readable transcript order. Add WebSocket only for features truly requiring bidirectional low-latency channel. Ensure no event stream leaks inaccessible projects across subscriptions.

## Example interaction contracts

`POST /runs` accepts `pipeline_revision_id` or project assignment ref (resolved and pinned by API), typed inputs, workspace policy, idempotency key; returns `run_id`, `status=queued`, UI route.

`POST /conversations/{id}/take-control` requires current `version` and authorization, returns new controller/version or conflict. If a turn is running, the same transaction sets `cancel_requested` on it (the worker sends ACP `session/cancel`); control moves immediately and the turn ends when the harness acknowledges — never two competing prompts. `return-control` hands control to the previous controller, or to `none`. A `409` on either carries the current control row, so the loser of a simultaneous click learns who won instead of guessing (06 edge cases). `POST …/permissions/{requestId}` accepts only an `option_id` the agent actually offered.

`POST /drafts/{id}/publish` requires validated graph digest, publish permission and optional change approval, returns immutable revision and non-mutated assignments; promotion is separate.

`POST /runs/{id}:retry` takes target node execution/attempt and optional run-local input override, enforces checkpoint availability and explicit downstream invalidation, returns new attempt reference.
