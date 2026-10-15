# ADR-0016 — Conversations, controller lock, turn leases and fencing tokens

- **Date:** 2026-10-15
- **Status:** Accepted for M2. D-004 (ACP as the agent protocol) and ADR-0015 (the Go SDK) are unchanged; this record adds the persistence schema, the public API surface and the event vocabulary for M2, all three of which are ADR-triggering under `13-decisions-and-adrs.md`.
- **Owners:** M2 contract implementers (control plane, worker runtime, UI)
- **Related decisions / contracts:** `communication-spec/01-domain-model.md` (Conversation, ACP Session Binding, Agent Instance, invariants 2 and 3), `06-collaboration-identity.md` ("Shared conversation model", human takeover sequence), `02-system-architecture.md` ("Scheduling and recovery", "Execution recovery semantics"), `04-agent-runtime.md` (session reuse, permission policy), `09-api-events-data.md` (Conversations routes, event types, `conversation_control` CAS), `10-ui-design-handoff.md` (J2, J6), `11-build-roadmap.md` (M2 exit), ADR-0013 (forward-only migrations, journal), ADR-0014 (HTTP/SSE conventions and §9 gap-safety), ADR-0015 (ACP SDK), ADR-0012 (sessions/CSRF)

## Context

M2's exit gate (`11-build-roadmap.md`) is: *user A starts a Claude or Codex conversation, user B observes it live, takes over and returns control, and restarting the API pods loses no transcript.* That sentence contains four separate hard problems, and the three M2 implementation workers cannot each invent their own answer to them:

- **One controller, many viewers.** `01` invariant 2 is "a conversation can never have two simultaneously valid exclusive controllers", and `06`'s edge case is "two people click Take Control simultaneously: exactly one wins CAS; loser sees current owner". The controller may also be a run attempt (`01`: `controller={factory_run, human:user_id, none}`), which does not exist until M4 but must not need renaming.
- **Work ownership across processes.** The API replicas are stateless and interchangeable; the agent subprocess lives on one worker's filesystem and stdio pipe. A turn must be claimed by exactly one worker, and a worker that has been declared dead must be *provably* stale before its writes are rejected — `02` ("writes with fencing token; stale owners' writes are rejected") and `01` invariant 3 ("fencing token must monotonically increase per … ownership transfer").
- **Honest failure reporting.** `02` refuses to guarantee an in-flight ACP session survives anything, and `10-ui-design-handoff.md` J7 forbids displaying "resumed without loss". Whatever this record chooses, the DB must be able to say "nobody reported an outcome" distinctly from "the agent reported a stop reason".
- **No second journal.** M1 already owns a gap-safe, replayable `domain_events` stream (ADR-0014 §9). `09`'s table family list proposes a separate `conversation_events` table. Two journals means two replay cursors, two gap arguments and two SSE mechanisms, and `09` itself labels the table list as *families*, not a schema.

The contract had to be fixed **before** three workers started (`IMPLEMENTATION_AGENT_BRIEF.md` rule 11), because column names, event payload shapes and CAS semantics are exactly the things that cannot drift once a React component and a worker loop both read them.

## Options considered

| Option | Advantages | Disadvantages | Evidence |
|---|---|---|---|
| **Transcript in `domain_events` scoped by `conversation_id`; control in a one-row-per-conversation table; work in a `conversation_turns` claim table (chosen)** | One journal, one `global_seq` cursor, one gap-safety argument (ADR-0014 §9) reused verbatim by the conversation stream; "API restart loses nothing" is inherited from machinery M1 already tests instead of newly promised; `FOR UPDATE SKIP LOCKED` over `conversation_turns` is the claim pattern `02` already specifies; a separate control row keeps CAS cost off the hot conversation row that transcript writes touch | Two logical streams over one physical table (needs a `(conversation_id, global_seq)` index and a rule that conversation events also carry `project_id`); payload shapes must be typed in Go or three implementations diverge | `migrations/00001_m1_core.sql` already has an unused `conversation_id` column on `domain_events`; `internal/store/postgres/events.go` (`evtJournalSQL`, `AppendEvent`, advisory append lock); `02` "Scheduling and recovery" |
| A dedicated `conversation_events` table, as `09`'s bullet literally lists | Transcript reads are a single-table scan; token/stream locality; easy per-conversation retention | A second append path, a second `Last-Event-ID` cursor and a second copy of the ADR-0014 §9 commit-order argument (which is subtle enough that duplicating it invites a divergence bug); project timeline would need to union two tables to show activity at all | Rejected: `09` labels the list "Database table families"; `02` says "Event rows and state transitions commit atomically; SSE consumers reconnect with `Last-Event-ID`" about the one journal |
| Optimistic row-level lock on `conversations` (`SELECT … FOR UPDATE` as the "controller lock") | No extra table; control state cannot diverge from the conversation | The lock is held by transcript writers, so every append contends with control changes; no `version` to hand a browser for CAS, so the loser of a take-control race cannot learn the winner's state; `09` explicitly names `conversation_control` with "version CAS" | Rejected on `09`/`06` grounds: the CAS token is a named contract, not an implementation detail |
| Lease the *conversation* to a worker (one lease covering all its turns) | Fewer claims; affinity is implicit | A long-lived agent process outlives any sane lease; renewal would be a heartbeat masquerading as a lock; a turn's outcome, cancel-request and stop reason have nowhere to live; nothing stops a second *prompt* racing the first | Rejected: `02` leases *work items* ("transitions attempt to leased", "checks capacity", "unique job keys"); M2's work item is the turn |
| Redis/queue-backed claim instead of Postgres | Lower claim latency at high fan-out | Adds a second authoritative store, which `02` ("Postgres is the source of truth") and ADR-0013 rule out; recovery, fencing and gap-safety would need re-solving | Compared; rejected |

## Decision

### 1. Model (migration `00003_m2_conversations.sql`)

Six tables, plus one sequence, all forward-only per ADR-0013:

| Table | Purpose | Invariants held in the DB |
|---|---|---|
| `agent_profiles` | Org-scoped launch config: `name`, `launcher_id`, `permission_mode` (`ask` \| `preapproved_within_sandbox` \| `deny`), `created_at` | `UNIQUE (organization_id, name)`; `permission_mode` CHECK. Seeds: **"Claude Code" → launcher `claude`**, **"Codex" → launcher `codex`**, both `permission_mode = 'ask'` |
| `conversations` | Project-scoped durable conversation: `title`, `agent_profile_id`, `status` (`active` \| `idle` \| `disconnected` \| `archived`), `created_by`, `created_at`, `updated_at` | `status` CHECK; indexes `(project_id, created_at DESC, id DESC)` and `(project_id, status)` |
| `conversation_control` | **One row per conversation** (`PRIMARY KEY conversation_id`): `controller_kind` (`human` \| `run_attempt` \| `none`), `controller_user_id`, `controller_run_attempt_id`, `previous_controller_user_id`, `version` (CAS), `acquired_at`, `updated_at` | `conversation_control_single_controller` CHECK: the kind decides which single pointer is populated, so "two controllers" is unrepresentable; `version >= 1` |
| `conversation_turns` | One prompt plus the agent's whole answer for it: `prompt`, `submitted_by`, `status` (`queued` \| `leased` \| `running` \| `completed` \| `cancelled` \| `failed` \| `interrupted`), `worker_id`, `lease_expires_at`, `fencing_token`, `cancel_requested_at`, `stop_reason`, `created_at`/`started_at`/`finished_at` | `conversation_turns_one_active_idx` **UNIQUE partial** `(conversation_id) WHERE status IN ('queued','leased','running')` = "never two prompts into one running turn"; `conversation_turn_queued_unowned`; `conversation_turn_lease_is_a_triple` (owner+deadline+token or it is not a lease); `conversation_turn_terminal_is_timestamped`; `conversation_turn_interrupted_unreasoned`; claim index on `(created_at, id) WHERE status='queued'`, reconciler index on `(lease_expires_at, id) WHERE status IN ('leased','running')` |
| `acp_session_bindings` | The agent instance: `worker_id`, `acp_session_id`, `protocol_version`, `agent_capabilities jsonb`, `launcher_id`, `launcher_version`, `session_origin` (`new` \| `resumed`), `status` (`connected` \| `disconnected` \| `closed`), `connected_at`, `last_seen_at`, `disconnected_at` | `acp_session_bindings_one_live_per_conversation_idx` **UNIQUE partial** `(conversation_id) WHERE status='connected'` = one live agent instance per conversation *and* the affinity anchor; `acp_session_binding_liveness` CHECK `connected ⇔ disconnected_at IS NULL` |
| `permission_requests` | Durable ACP prompt: `acp_request_id`, `tool_call_id`, `tool_title`, `tool_kind`, `options jsonb`, `status` (`pending` \| `decided` \| `expired` \| `cancelled`), `decided_by`, `decision_option_id`, `deadline_at`, `decided_at` | `permission_request_decision_is_answered` CHECK: `decided` ⇔ (`decided_by` and `decision_option_id`), and unanswered closes carry neither; `UNIQUE (turn_id, acp_request_id)`; pending scan and deadline scan indexes |
| `conversation_turn_fencing_seq` | The fencing token source | `bigint` sequence, drawn with `nextval()` **at claim time**, never generated per row |

`domain_events` gains `domain_events_conversation_seq_idx (conversation_id, global_seq)` — the same `(scope, cursor)` key the project stream relies on, which is what lets the conversation stream reuse ADR-0014 §9 unchanged.

`conversations` deliberately carries **no** `organization_id` column: the project is the only tenant anchor, and a writer reads the organization from the project row in the same transaction (as the M1 project paths already do). Adding a denormalized org column would create a second, drift-prone answer to "whose is this" for a query that is already joined.

Mapping to `09`'s "Agent" table family (recorded there too, so the spec and the schema stop disagreeing): `conversation_events` **is** `domain_events` with `conversation_id` set; `approval_requests` **is** `permission_requests`; `agent_instances` and `agent_capability_snapshots` are **collapsed into** `acp_session_bindings` (one row per launched session, capabilities as observed JSON); `conversation_turns` is new (it is `02`'s attempt-equivalent for ad-hoc conversations).

### 2. Controller CAS (`conversation_control.version`)

- `createConversation` inserts the conversation and its control row in one transaction with `controller_kind='human'`, `controller_user_id=caller`, `version=1`, and appends `conversation.created` whose payload carries `control_version` — so a viewer's first control mutation has a token without a second round trip.
- `take-control` / `return-control` bodies carry `{version}`. The update is `WHERE conversation_id = $1 AND version = $3`; zero rows matched ⇒ `409` whose problem detail includes the **current** `control` (`{kind, user_id, display_name, previous_user_id, version}`). A successful mutation sets `previous_controller_user_id` from the holder it displaced and increments `version`, and appends `conversation.control.transferred` `{conversation_id, turn_id?, from_kind, from_user_id, to_kind, to_user_id, reason, control_version}` in the same transaction.
- Taking control while already the controller is an idempotent `200` with an unchanged `version` (double-clicking must not burn a token). Returning control when not the controller is `409`.
- `controller_kind='run_attempt'` exists in the CHECK and the API enum but **no M2 transition may set it**: there is no `attempts` table yet. M4 fills `controller_run_attempt_id` without renaming anything.

### 3. Turn claim, lease and fencing

- **Claim** (`FOR UPDATE SKIP LOCKED`, one statement, FIFO on `created_at`), pinned verbatim in `internal/store/postgres/migrate_test.go` as `migClaimSQL` and exercised there:

  ```sql
  UPDATE conversation_turns t
  SET status = 'leased', worker_id = w.worker_id,
      lease_expires_at = now() + make_interval(secs => 30),
      fencing_token = nextval('conversation_turn_fencing_seq')
  FROM (  SELECT t2.id AS turn_id, $1::uuid AS worker_id
          FROM conversation_turns t2
          JOIN conversations c ON c.id = t2.conversation_id
          LEFT JOIN acp_session_bindings b
                 ON b.conversation_id = c.id AND b.status = 'connected'
          WHERE t2.status = 'queued' AND c.status <> 'archived'
            AND (b.worker_id IS NULL OR b.worker_id = $1::uuid)
          ORDER BY t2.created_at, t2.id
          FOR UPDATE OF t2 SKIP LOCKED
          LIMIT 1 ) w
  WHERE t.id = w.turn_id
  RETURNING t.id, t.conversation_id, t.worker_id, t.fencing_token;
  ```

- **Affinity is read, not duplicated.** A conversation with a live binding on worker W has its turns claimed by W alone (`b.worker_id = $worker`); a conversation with no live binding may be claimed by any worker, which is what makes a worker restart recoverable without a scheduler. There is deliberately no `bound_worker_id` column on `conversations`: two sources of affinity agree only by accident.
- **Lease timing:** 30 s lease, renewed every 10 s (matching M1's `DefaultHeartbeat`). Renewal is itself fenced — `WHERE id = $1 AND worker_id = $2 AND fencing_token = $3 AND status IN ('leased','running')`. Zero rows means the worker lost the turn and must stop writing, not renew harder.
- **Fencing:** every turn state update **and every journal append made on behalf of a turn** is conditional on that triple. The store helper for a worker's turn event takes `FOR UPDATE` on the turn row first and fails `ErrStaleLease` if the token is not the current one; the append is in the same transaction, so a dead owner's write cannot land even partially. `SKIP LOCKED` is a queue mechanism, not exactly-once execution (`02`) — the fencing token, not the lock, is what makes a stale write rejectable.
- **Prompting is queued work, never a blocking call.** `POST …/messages` returns `202` with the `ConversationTurn` as `queued`; the agent's answer arrives only over the SSE stream. A second message while a turn is non-terminal is `409` (backed by the partial unique index, so it cannot be raced).

### 4. Reconciler (in `serve`, one at a time)

One goroutine per API replica, tick 5 s, guarded by `pg_try_advisory_lock(hashtextextended('communication.reconciler.turn_leases', 0))` held for the duration of the pass — a replica that cannot take it simply skips the tick, so many replicas are safe and zero replicas only delays detection (it never loses data). Each pass, in one transaction per affected turn:

1. `leased`/`running` turns with `lease_expires_at < now()` → `status='interrupted'`, `finished_at=now()`, `stop_reason` left NULL, and append `conversation.turn.interrupted` `{reason: "lease_expired", turn_id, worker_id, fencing_token}`.
2. `connected` bindings whose worker heartbeat is stale beyond 3 intervals (the same liveness rule `internal/store/postgres/worker_registry.go` applies to reads) → `status='disconnected'`, `disconnected_at=now()`, append `agent.session.disconnected` `{reason: "worker_gone"}`, and set the conversation's `status='disconnected'`.
3. `pending` permission prompts with `deadline_at < now()` → `status='expired'`, append `conversation.permission.decided` `{status: "expired"}` (no `decided_by`: nobody answered).

The reconciler never marks anything `completed`, never retries a turn, and never re-attaches a session. Re-attaching is what the *next* turn does, visibly.

### 5. Takeover semantics (`06` "Human takeover sequence")

- `take-control` by a contributor+ while someone else holds the lock: within one transaction — CAS the control row (bumping `version`, recording the displaced holder in `previous_controller_user_id`), and if the conversation has a `leased`/`running` turn, set `cancel_requested_at = now()` on it. Then append `conversation.control.transferred {reason: "taken", …}`.
- The worker notices the cancel request (it re-reads its own turn between updates, and immediately when its renewal returns), sends ACP `session/cancel`, waits for the turn to be acknowledged, and closes it with `conversation.turn.cancelled {stop_reason: "cancelled", requested_by}` under its fencing token. Control transferred *immediately*; the turn ends when the harness agrees. Nobody may send a second prompt before that terminal event, and the DB will not allow one (one-active-turn index) — `06`'s "do not send competing prompts to a running turn" is enforced, not advised.
- `return-control` gives control to `previous_controller_user_id` **if** that user is still a contributor/maintainer of the project; otherwise control goes to `none`. It never cancels a turn — stopping work is `cancel`'s job, so "I stopped the agent" and "I stopped driving" remain distinguishable in the transcript. Reason: `returned`.
- Permission prompts go to the **current controller only** (`06`); another member watching sees the prompt and sees who must act, and `POST …/permissions/{requestId}` from a non-controller is `409` with the current `control`. The decision is durable before it is live: the API writes `decided` + the `conversation.permission.decided` event, and only the worker (the sole ACP speaker) translates it into the JSON-RPC response. If the decision cannot reach the agent (turn already terminal), the row still reads `decided` and the event says so; the reconciler expires anything nobody will answer.

### 6. Honest restart behaviour

| Event | What is recorded | What is *not* claimed |
|---|---|---|
| API replica restart | Nothing changes in the schema: the transcript is `domain_events` rows, control/turns are rows. The browser reconnects with `Last-Event-ID` and replays. | That any in-flight browser POST succeeded — a retried `…/messages` is a `409` against the live turn, and `Idempotency-Key` stays unimplemented (ADR-0014) |
| Worker graceful drain / SIGTERM | Before exiting: each of its `running` turns → `interrupted` + `conversation.turn.interrupted {reason: "shutdown"}`; each of its `connected` bindings → `closed` + `agent.session.disconnected {reason: "shutdown"}`; conversation → `idle`. | A transparent transfer of the stdio connection (`02` says explicitly this does not exist) |
| Worker crash / heartbeat stale | The reconciler's §4 pass, i.e. `interrupted {reason: "lease_expired"}` / `worker_gone` — written by somebody who can prove the deadline passed, not by the dead process | That the turn's partial output was ever complete; `stop_reason` stays NULL because nothing reported one |
| Next turn after a loss | If the conversation has no live binding, the claiming worker starts a fresh process + `session/new` and writes a binding with `session_origin='new'`; only if the agent advertised `loadSession` **and** `session/load` succeeds is `session_origin='resumed'` written, with the ACP session id it restored. `conversation.turn.started` carries `session_origin`, so the UI shows which happened. | That Communication's transcript was reconstructed inside the harness — it never is; the durable conversation stays authoritative (`01`) |

### 7. Event vocabulary (types + payload structs in `internal/events/events.go`)

`conversation.created`, `conversation.message.user`, `conversation.message.agent`, `conversation.thought`, `conversation.tool.call`, `conversation.tool.update`, `conversation.permission.requested`, `conversation.permission.decided`, `conversation.turn.started|completed|cancelled|failed|interrupted`, `conversation.control.transferred`, `agent.session.connected`, `agent.session.disconnected`. Names follow `09`'s dotted style (`conversation.message.*`, `conversation.tool.*`, `conversation.control.transferred`, `agent.session.connected`) and all satisfy the envelope schema's existing `^[a-z]+(\.[a-z_]+)+$` pattern, so no envelope change was needed.

Rules:
- Every conversation event sets `organization_id`, **`project_id`** and `conversation_id`. The project is the authorization scope and the append-lock key (ADR-0014 §9); `conversation_id` narrows a stream. Consequently the project stream is a strict superset of every conversation stream — one gap argument, not two.
- Payload types are Go structs in `internal/events`, so the control plane and the worker emit identical shapes; `events_test.go` pins every payload's JSON member set and asserts each type is documented in `api/openapi.yaml`.
- `conversation.message.agent` is the worker's **coalesced** readable chunk (`chunk_seq` orders within a turn, `final` ends it, `truncated` flags a cut), per `09`: "worker may batch/coalesce to reduce DB costs, while preserving readable transcript order".
- Timestamps inside payloads (`deadline_at`) are RFC 3339 strings, omitted when there is no deadline; the envelope's own `occurred_at` remains the authoritative event time.
- Tool payloads carry `input_preview` / `output_preview` only, bounded by the worker, always with `truncated`. Prompts are stored on the turn and echoed as `conversation.message.user` (the transcript is the product); raw secrets, `.env` contents, ACP raw frames and full tool inputs are never payload material (ADR-0013 Security).

### 8. Authorization and API shape

`GET /api/v1/agent-profiles`; `GET|POST /api/v1/projects/{projectId}/conversations`; `GET /api/v1/conversations/{conversationId}`; `POST …/messages`; `POST …/take-control`; `POST …/return-control`; `POST …/cancel`; `POST …/permissions/{requestId}`; `GET …/events` (SSE). Visibility of a conversation — including its SSE stream and its transcript — is its project's membership, answered `404` from outside (`06`: existence is project-scoped information), and *re-checked* before each delivery and each heartbeat on an open stream, exactly as ADR-0014 §5 does for projects. Writes require `contributor`+ and the `X-CSRF-Token`/`Origin` pair (ADR-0012/0014); controller-only writes additionally answer `409` with the live `control`. `fencing_token`, `lease_expires_at` and `worker_id`-as-arbiter never appear in a browser-facing body: `getConversation` exposes `agent_session` (what is attached) and the turn's `status`/`worker_id` for display, and never a token a client could use to pretend it owns work.

### 9. Obligations this contract places on the three M2 implementations

These are the points where a worker could satisfy its own tests and still break the whole; each is checkable from the other side:

1. **Control plane (`internal/api`, `internal/store/postgres`)** — `AppendEvent`/`events.New` must persist `ConversationID` into `domain_events.conversation_id` (the journal INSERT does not list the column today, so an append that sets the field but not the column produces a conversation event that is invisible to the conversation stream). The conversation stream's read must filter `conversation_id` **and** keep the `tx_id < pg_snapshot_xmin(pg_current_snapshot())` clause, and must be authorized through the conversation's project on every delivery and heartbeat.
2. **Worker (`internal/worker`, `internal/agent/acp`)** — every turn-state write and every turn-scoped append must carry `(turn_id, worker_id, fencing_token)` and must fail closed when the token is not the current one. Before exiting (drain, SIGTERM, or ACP process death) it must write the honest terminal state for its own turns rather than leaving them for the reconciler to guess at.
3. **UI (`ui/`)** — `control.version` is read from `getConversation` and echoed on every control mutation; on `409` it must adopt the returned `control` rather than retrying blindly; `interrupted` must render as "stopped, outcome unknown" (J7), never as resumed.

### 10. Explicitly deferred past M2

- **Multi-worker scheduling and placement.** One live agent instance per conversation and affinity-by-binding are specified; capacity accounting, worker selection policy, draining-aware placement and *choosing* another worker for an existing conversation are M4's scheduler's problem (`02`: one worker stays the execution single point of failure).
- **Cross-host recovery.** No workspace portability, no checkpoint rehydration, no claim migration of a live ACP subprocess (`02`: "Cross-host rehydration is a separate implementation gate; do not advertise it").
- **Presence / liveness of viewers.** Who is watching a conversation is not modeled; only the single controller is.
- **Run-attempt control handoff.** The `run_attempt` kind and `controller_run_attempt_id` column exist so `06`'s factory↔human handoff needs no rename in M4; M2 never writes them.
- **`conversation.archived` transitions, `Idempotency-Key`, `If-Match`/etag, prompt editing, transcript pagination, WebSocket control channel, and APM-profile revisions** (with pinned `apm_lock_digest`): extension points preserved, nothing built.
- **`permission_mode = 'preapproved_within_sandbox'` is available in schema but unused by both seeds**, because no launcher has a verified enforced sandbox (ADR-0009, `docs/compatibility/SANDBOX.md`). Flipping a seed is a compatibility-lab result, not a config change.

## Consequences

- Positive: the transcript inherits M1's tested replay/gap-safety rather than duplicating it; `communication serve` can roll (the M2 exit gate) with zero new guarantees to verify.
- Positive: the two most dangerous M2 races — two controllers, two prompts into one turn — are DB errors (`23505`/`23514`), not handler discipline. `internal/store/postgres/migrate_test.go` asserts them as constraint behaviour on a database that actually ran `00003`.
- Positive: control (`conversation_control`) and work (`conversation_turns`) are separate rows, so a takeover cancels without pretending the turn finished.
- Limitation: one journal for transcript and operational events means a chatty agent competes with project activity for the same per-project append lock (ADR-0014). M2's coalescing is the mitigation and the thing to measure — D-012 stays **Proposed** for exactly this reason.
- Limitation: the one-active-turn index means a wedged worker blocks a *new* prompt for up to one lease interval (30 s) plus one reconciler tick (5 s) until the turn is `interrupted`. That is the honest cost of not letting two writers into one agent; the UI is required to show `cancel_requested`/`interrupted` rather than papering over it (`10` J7).
- Limitation: fencing rejects stale writes only for writers that *include* the token. A future code path that appends events for a turn without going through the fenced store helper bypasses the invariant; the fenced append is therefore an *obligation* of the store API, not a suggestion (see Verification).
- Limitation: `sessions` of a removed member keep an open SSE stream until the next delivery or heartbeat check, matching ADR-0014's existing behaviour rather than improving it.
- Ops: adding `00003` raises `ExpectedSchemaVersion()` to 3, so every replica and worker must be migrated before it reports ready (ADR-0013 §6); the compose `migrate` one-shot runs before `api-a`/`api-b`/`worker` start.

## Security/privacy

- Prompt text and agent text are transcript data visible to project members; ACP raw frames, tool inputs/outputs (beyond bounded previews), and anything from `.env` never enter payloads or `audit_events.detail` (ADR-0013).
- Permission prompts are the security boundary's human edge: they are surfaced to the *controller* only, they carry a `deadline_at` so nothing hangs forever, and `permission_request_decision_is_answered` makes a fabricated approval unrepresentable in SQL — a `decided` row without `decided_by` is a constraint violation, not a bug.
- Fencing tokens are execution-internal and never serialized to browsers; a leaked `conversationId` grants reading, not driving.
- Every controller-only refusal, and every non-member probe of a conversation (which answers `404`), writes an `audit_events` row with `outcome='denied'`, consistent with ADR-0014 §3.
- Conversation events are project-filtered in SQL (`WHERE conversation_id = $1` resolved through the conversation's own project), so a forged cursor cannot walk another project's transcript, and `09`'s "no event stream leaks inaccessible projects" holds for the new route the same way it does for the project route.
- Seeded profiles record launcher ids only. Nothing here claims Claude or Codex works under an enforced sandbox; `permission_mode='ask'` is the fail-closed default (`04`).

## Verification

Observed 2026-10-15 on the lab database (`communication-lab-pg`, `postgres:18.6`), fresh `m2_contract` DB:

- `go test -race -p 1 -count=1 ./internal/store/postgres/ ./internal/events/` → `ok` for both packages. The M2 assertions that matter are not "goose reported 3":
  - `TestMigrate0003ControlSingleController` — a second `conversation_control` row for one conversation is `23505`; `human`-without-user, `none`-with-user, both pointers populated, unknown kind and `version=0` are each `23514`; the `none`/`human`/`run_attempt` legal shapes all insert.
  - `TestMigrate0003ControlCAS` — two callers both reading `version=1`: the first `UPDATE … WHERE version = $3` matches one row, the second matches none (`pgx.ErrNoRows`), and the loser's write changes nothing (holder and version re-read).
  - `TestMigrate0003OneActiveTurnPerConversation` — a second turn is `23505` while the first is `queued`, `leased` **or** `running`; after `completed` the next turn inserts, and the completed row survives (history is not displaced).
  - `TestMigrate0003ClaimQuery` — runs `migClaimSQL` itself: an unbound conversation's turn is claimed; a conversation with a live binding on another worker is **not**; a leased turn cannot lose its deadline or drop to `fencing_token=0`; a re-claim draws a strictly greater token; `interrupted` with `stop_reason` is `23514`; `completed` without `finished_at` is `23514`.
  - `TestMigrate0003OneLiveBindingPerConversation` — second `connected` binding is `23505`; after `closed` a new one inserts and both rows remain; `disconnected` without `disconnected_at` is `23514`.
  - `TestMigrate0003PermissionDecisionShape` — `decided` without `decided_by`/`decision_option_id` (each alone) and `expired` *with* a decider are `23514`; the answered shape and the unanswered `expired` close both write; duplicate `acp_request_id` per turn is `23505`.
  - `TestMigrate0003TranscriptJournal` — conversation rows appended to `domain_events` replay through the conversation stream in `global_seq` order under the `tx_id < pg_snapshot_xmin(pg_current_snapshot())` filter, an unrelated conversation replays 0 rows, and all three rows remain visible on the project scope (superset property).
  - `psql -c '\d conversation_turns'` lists the four named M2 CHECKs, the partial UNIQUE `conversation_turns_one_active_idx` and both partial scan indexes.
- `internal/events`: `TestM2TypeConstants` (every M2 type against the envelope schema's own `type` pattern), `TestM2TypesDocumentedInOpenAPI` (each type is named in `api/openapi.yaml`), `TestM2PayloadFieldNames` (JSON member set of all 16 payloads + `PermissionOption`), `TestM2PayloadFieldsMatchOpenAPITable` (reflective cross-check: the field list in `api/openapi.yaml`'s stream description and the marshalled Go structs must be the same set — it caught four real drifts while this contract was being written), `TestM2PayloadsAreObjects` (each payload is an object carrying `conversation_id`), and the enum validator tests for controller kinds, turn/permission/binding statuses, transfer and interrupt reasons.
- Contract gate: `npx @redocly/cli@2.63.0 lint api/openapi.yaml` → valid, 6 warnings, all six pre-existing and individually justified in `api/README.md` (`no-server-example.com`, `operation-2xx-response` ×2 on the OIDC redirects, `operation-4xx-response` ×3 on health/readiness/login). No new warnings from the M2 surface.
- **Not yet exercised** (M2 exit run, not this contract): driving the claims/leases/cancel/reconciler paths against a real worker with a real Claude/Codex subprocess, killing API replicas mid-stream to prove transcript continuity in a browser, and the two-user take-control race observed through the UI (J2/J6). No row of `docs/compatibility/ACP.md` changes because of this record.

## Migration/rollback

Forward-only (ADR-0013). `communication migrate up` applies `00003_m2_conversations.sql` on top of `00002`; nothing rewrites an `00001`/`00002` row, and `goose_db_version` advances to 3, which is what makes `readiness` report `schema_version 3` and an un-migrated replica answer `503` instead of serving a conversation surface it cannot back.

Deploy order: `migrate` → `worker` (must not claim turns it cannot fence) → `serve` replicas. Because the API handlers can be rolled independently and nothing in `00003` alters an existing column, replicas running `0.1.0-m1` code keep working against schema 3 (the new tables are simply unread); the reverse (new code against schema 2) is refused by readiness.

There is no down-migration. If the M2 conversation surface had to be abandoned, the recovery is a *forward* `00004` that drops the new tables and sequence — data loss by explicit choice, reviewed like any other migration; the transcript rows themselves stay in `domain_events`, which is exactly why the journal was reused rather than duplicated. The `-- +goose Down` block exists solely so the test suite can reset a scratch database.

## 6. Implementation notes (M2 control plane, 2026-10-15)

Landed in `internal/api/conversations.go`, `internal/store/postgres/conversations*.go`,
`internal/store/postgres/reconciler.go` and `cmd/communication/serve.go`, against
the rows of `00003_m2_conversations.sql`. The §2 table, the §3 conflict shapes,
the §4 reconciliation rules and the §5 authz model are implemented as written.
What follows records details that text leaves open, and states which cancel
behaviour has actually been observed.

### What repeated `return-control` actually settles — recorded because §2 and §5 compose

§5: control goes to `previous_controller_user_id` **if** that user is still a
contributor/maintainer, else to `none`. §2: a successful mutation sets
`previous_controller_user_id` from *the holder it displaced* — which for a return
is the returning controller. Composed, a hand-back is reversible in the worst
sense: A holds, B takes (previous=A), B returns (control→A, previous=B), A returns
(control→**B**). Two people returning the lock to each other ping-pong it
indefinitely rather than ever reaching `none`, and both readings of "the previous
controller" are defensible.

This implementation follows the letter of both clauses, because it is the letter
of an Accepted record and because the alternative (return also clears
`previous`) quietly deletes the audit-relevant fact of who just gave it up. Every
leg is a one-hop CAS with a `conversation.control.transferred` event naming both
ends, so the transcript never claims something it did not do — the lock just does
not come to rest on its own. Two consequences for whoever builds J6 next:

- The UI must render `control.kind`/`user_id` as delivered, never "the person who
  last clicked Return" — the two differ one step after a hand-back.
- If the ping-pong turns out to be wrong in practice, the fix is one line in the
  return target (clear `previous` on `returned`) plus an ADR amendment. It is not
  a data-model problem, and nothing else has to move.

The `none` branch is reached and proven: `previous` is NULL for a creator who
never lost the lock, so a first `return-control` on a fresh conversation lands on
`kind='none'`, `controller_user_id` NULL — not "the creator owns it again", which
would be a fabricated holder. A take from `none` clears `previous` again, so a
chain that has once gone empty cannot refill itself.

### A cancel request is not a cancelled turn

There is no `conversation.turn.cancel_requested` event type and none is added:
appending one would reserve the journal for an outcome the server cannot yet
know. A cancel that stops at a queue (a `queued` turn) is terminal *here*, so
this implementation moves the row to `cancelled` and appends
`conversation.turn.cancelled` itself; one that lands on a `leased`/`running` turn
with a worker still standing only sets `cancel_requested_at` and appends nothing,
because the worker's `cancelled` or `failed` is the event. An API response
therefore cannot be read as a turn outcome, and the turn body is a snapshot, not
a receipt. `cancel_requested_at` is the field the UI polls.

### Reconciler facts are written as `actor_kind = 'system'`

The §4 `interrupted` fact is a determination the control plane makes about a
worker it has stopped trusting — so the journal names its author as `system`
(`domain_events.actor_kind = 'system'`, `actor_id = 'system'`, the one place
`actor_id` is not a UUID — the only actor constraint the column family carries
is `domain_events_actor_kind_check`, which checks the kind alone),
never as the human who last touched the conversation, and never as the dead
worker. Attribution is what makes "why did my turn die" answerable from the
transcript alone. §5's audit trail is unchanged: it has no row for a reconcile.

### The lock is one pass, the queue is bounded, the tick is not one pass

`Run` is deliberately not a loop that owns the advisory lock: `Pass` takes the
session-scoped lock with `pg_try_advisory_lock`, runs its three passes and
releases it, every tick. Per expired turn, the row update, the
`conversation.turn.interrupted` append and the conversation's
`active → disconnected` move share one transaction on one connection, so they are
atomic against a claim landing beside them; closing the *session binding* is the
separate stale-binding pass (§4.2), not part of that transaction, because the
binding is proved dead by the worker's heartbeat, not by the lease deadline. The
batch cap (`Batch`, default 50) bounds
one pass's work; the tick is not, so a backlog drains over consecutive ticks and
one pass never holds Postgres or the lock across the whole set.

`Run` does **not** exit on a failed pass. An expired lease is a permanent
condition: a pass that fails on a connection blip would otherwise leave turns
undeathable until the process restarts, so the tick retries and the log counts
consecutive failures rather than pretending silence means health. It does not
count a *shutdown* as a failure either: a pass cut short because its context was
cancelled, or because the pool closed under it, returns the reconciler's exit
status rather than a failing-pass report. That distinction is not cosmetic — the
first whole-suite `-race` run of the M2 integrated lab failed
`TestReconcilerTickInterruptsWhatTheClockFound` with "gave up after 1 failing
passes" for nothing but its own `cancel()`, while the same test focused and
re-run passed; `TestReconcilerShutdownIsNotAFailingPass` now pins both halves
(a stopped reconciler reports nothing, a reconciler with a live context and a
dead pool still reports the count).

### Cancel evidence: what has actually been observed, and where

§4 justifies `interrupted` over `failed` partly with "M0's probe found both
adapters answer cancel, so a lost worker is not a cancelled turn." That premise
stands as recorded: `docs/compatibility/ACP.md` shows both adapters answering
`session/cancel` with `stopReason=cancelled` (5/5 at a 2 s delay), and the M2
worker row of the same file shows a live Claude turn closing
`conversation.turn.cancelled` / `stop_reason=cancelled` from inside the container.
The *timing-dependent* caveat is recorded there too — Claude sometimes
auto-backgrounds a long shell call and closes the turn `end_turn` before a later
cancel lands — which is exactly why cancel is a request rather than an outcome
above. What this record does **not** claim is any behaviour it has not seen: no
cancel row is asserted here, and `docs/compatibility/ACP.md` stays the only place
capability evidence lives.

### Who appends `conversation.message.user` is not optional (integrated run, 2026-10-15)

§3 assigns the user-message append to the *control plane's* enqueue transaction,
and `internal/store/postgres/conversations.go` `PostMessage` does exactly that.
The worker's `BeginTurn` appended a second copy of the same event, and the
transcript proved it: every prompt reached the stream twice, the duplicate last,
so a client replaying `Last-Event-ID: 0` saw the user say the same thing out of
order. The worker sends the prompt to the agent, it does not journal it. Nothing
in the schema or a constraint makes a double append impossible — the journal is
append-only and has no idempotency key on prompt text — so the ordering rule in
§3 is the only thing holding the transcript together, and the integrated lab run
(`e2e_m2_integrate.py`, step b: "the user's message arrives once") is now the test
that says so.
