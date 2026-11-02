# ADR-0068 — Per-turn agent profiles in conversations

- **Date:** 2026-11-02
- **Status:** Accepted (implemented and tested; see Verification)
- **Owners:** control-plane + worker conversation surface
- **Related decisions / contracts:** ADR-0016 (conversations, control, turn leases),
  ADR-0058 (versioned agent profiles — the `agent_profile_version` pin),
  ADR-0030/0054 (profile writes), `communication-spec/01-domain-model.md`
  (invariant 2: one controller), `communication-spec/04-agent-runtime.md`
  ("Session reuse semantics", `model_preference` in `AgentProfileRevision`),
  `communication-spec/06-collaboration-identity.md` ("Shared conversation model"),
  `communication-spec/09-api-events-data.md` (conversation event family),
  migration `00023_per_turn_agent_profile.sql`, `api/openapi.yaml`,
  design handoff `docs/design/handoff-repo-chat-nav/` (2e + 1h: "NEXT TURN
  RUNS ON", "AGENTS IN THIS CHAT", the switch divider).

## Context

The design lets the people driving a chat switch which agent runs the next
turn without leaving the thread: the composer's agent chip opens "NEXT TURN
RUNS ON", switching inserts the transcript divider "`<person>` switched to
`<agent>` · `<model>` · transcript and branch carried over", and the side
panel lists "AGENTS IN THIS CHAT" with turn ranges.

Today the model says one agent per conversation for life:
`conversations.agent_profile_id` is written once at create, every turn claim
resolves its launcher through it, and `internal/domain`/`09` never named a
switch. This changes the persistence schema and the public API, so it needs a
record: what moves, who may move it, when, and what "carried over" actually
means for the ACP session.

## Options considered

| Option | Advantages | Disadvantages | Evidence |
|---|---|---|---|
| One `agent_profile_id` column on `conversations`, moved in place; turns record nothing | No schema change at all; simplest read | The transcript cannot say which agent wrote which answer after a switch — the divider, "agents in this chat" ranges and honest attribution all need per-turn facts; `04`'s session-boundary claim would be unauditable | rejected on design + `09` grounds |
| Per-turn profile stamped at enqueue; the conversation column keeps its name and gains the meaning "the profile the NEXT turn runs on" (chosen) | Turns are immutable facts; every existing reader (claim, list, detail, the worker's `ProfileFor` resolution root) keeps pointing at exactly one authoritative "what runs next"; the ADR-0058 version pin has one place to move; a switch is one UPDATE plus one journal row in one transaction | `conversations.agent_profile_id` changes meaning (it was write-once); unstamped historical rows resolve through the COALESCE rule below | `conversation_turns` already snapshots `prompt`/`submitted_by` at enqueue — the profile joins that stamped-at-enqueue family |
| A separate `conversations.next_agent_profile_id` column | Old column keeps its "created-with" meaning | Two profile columns that are equal except between a switch and the next turn — every existing reader must be audited to pick the right one, and "which is current?" becomes a question with two answers; rejected for the same reason `00014` pinned at one root | — |
| A full per-turn profile revision history table | Maximum forensic fidelity | `agent_profile_versions` (ADR-0058) already freezes what a profile *was*; a turn needs only the id it ran on, and `00014`'s pin answers the version question at the resolution root | — |

## Decision

1. **Schema (migration `00023`, forward-only per ADR-0013).**
   `conversation_turns.agent_profile_id` (FK `agent_profiles`) — the profile a
   turn ran on, stamped by every turn writer (API `PostMessage`,
   `CreateConversation`'s first turn, the attempt seam) from the
   conversation's current pointer at enqueue. Nullable so pre-migration rows
   and any writer predating this change keep working; **every read resolves
   the effective profile as `COALESCE(t.agent_profile_id,
   c.agent_profile_id)`**, which for a historical row *is* the recorded answer
   because nothing could move the conversation column before this ADR.
   `acp_session_bindings.agent_profile_id` records which profile launched a
   session (backfilled from the conversation: a binding's launcher always was
   its conversation's profile's launcher). `agent_profiles.model` (nullable
   text, ≤ 200) carries `04`'s `model_preference` as a display pin — the
   divider's "`· gpt-5`"; it is settable through the existing profile create
   and PATCH routes and travels in the ADR-0058 version snapshots; a model-only
   PATCH moves the model column alone (it cannot stage down an APM pin), and
   restoring a pre-0068 version clears the pin (a version is a state — the
   state named no model).

2. **The controller rule.** `conversations.agent_profile_id` is now the
   **next-turn profile**, and only the human controller may change it, only
   **between turns**. `POST /api/v1/conversations/{conversationId}/switch-agent`
   with `{"agent_profile_id": uuid}` answers: `200` + the fresh conversation
   view on a landed (or idempotent already-on-that-profile) switch; `404` to a
   non-member; `403` to a caller who is not the controller (identity,
   including a viewer role and a run-attempt-controlled thread) — deliberately
   `403`, not the prompt route's `not_controller` `409`, because a caller that
   never held the wheel lost no race; `409` `turn_in_progress` carrying the
   live control row and the queued/leased/running turn in the way (timing);
   `409` archived; `400` `invalid_agent_profile` for a profile outside the
   project's organization's profiles (the same set `createConversation` may
   launch — profiles are organization-scoped per ADR-0016 §1) or a malformed
   id. Switching to the profile already set is an idempotent `200`: no write,
   no event, no CAS-token burn — the double-click rule taking control follows.

3. **The journal event is the divider.** A landed switch appends
   `conversation.agent.switched` in the same transaction as the UPDATE, with
   the envelope actor = the switching human and payload
   `{conversation_id, actor_user_id, from_agent_profile_id, from_profile_name,
   to_agent_profile_id, to_profile_name, to_launcher_id, model,
   transcript_carried_over: true}`. The transcript renders
   "`Dana` switched to `Codex` · `gpt-5` · transcript and branch carried over"
   from this row and nothing else; a switch a viewer cannot replay did not
   happen.

4. **The session boundary.** The next turn after a switch starts a **new ACP
   session** on the new profile — never a continuation, never `session/load`:
   `TurnStore.ResumableSession` only offers a live binding whose recorded
   `agent_profile_id` equals the claiming turn's (the attempt path passes the
   empty profile id and keeps the pre-ADR filter — a run pins its profile in
   its plan and nothing switches it; the switch route refuses a
   run-attempt-controlled thread before the profile read anyway). In the loop,
   the live-process map is keyed per conversation but *owned* per profile:
   a claim whose profile differs closes the live session honestly (binding
   closed, `agent.session.disconnected{reason: "agent_switched"}` journalled,
   conversation reported idle) before launching. The claim itself resolves
   launcher and permission mode through the **turn's** profile row, so what a
   worker launches is what the turn recorded.

5. **What "carried over" means.** The *transcript* is the durable journal
   (`domain_events` scoped by `conversation_id`, ADR-0016) and it never moves
   or gets rewritten — the new session's harness does not inherit the old
   harness's private context (there is today no cross-harness context seeding,
   and pretending otherwise would be a capability claim with no test behind
   it); the divider says the *thread* carried over, which is exactly true.
   The *branch* carries over literally: the conversation keeps its workspace —
   `UnitService.ProfileFor` resolves the axes from the conversation's (new)
   profile and workspace preparation is per-conversation, so the new session
   launches in the same worktree on the same run refs.

6. **The reads.** `ConversationTurn` gains `agent_profile_id`,
   `agent_profile_name` and `model` (explicit null = the profile names none).
   `Conversation` gains `agent_profile_model` (the next-turn profile's, for the
   composer chip) and the derived `agents` list: one entry per maximal run of
   consecutive turns on one profile, `{agent_profile_id, agent_profile_name,
   model, first_turn, last_turn, turn_count}`, ordinals 1-based in turn
   creation order (gaps-and-segments over a `row_number()`; read, never
   stored, bounded by `conversation_turns_agent_profile_idx`). A profile that
   is switched away from and back appears twice — the ranges describe the
   transcript, not a per-profile rollup. `AgentProfile` gains `model`, and
   `POST /agent-profiles` / `PATCH /agent-profiles/{id}` accept it.

## Consequences

Positive: attribution survives every switch, the divider and side panel render
from replayable facts, and every existing "what does this conversation run
on" reader keeps exactly one answer. Cost: `conversations.agent_profile_id`
got a documented second meaning (next-turn), and the effective-profile read
rule (COALESCE) persists as long as unstamped turn rows can exist.
Backwards-compatible: every wire addition is optional-on-read; no field moved
or changed type; `agent.session.disconnected` gains one machine reason value
(`agent_switched`) in the prose enumeration. `runs.agent_profile_version` and
the run-attempt path are untouched.

## Security/privacy

The switch is a controller-only, between-turns mutation enforced in the
database transaction, not by handler discipline: the control row predicate,
the active-turn probe and the journal append share one transaction, so a
non-controller or mid-turn refusal leaves neither a moved pointer nor a
divider row. `403` on identity does not leak who the controller is beyond the
display name the conversation surface already serves to every project member.
Profile ids outside the caller's organization answer 400 without confirming
their existence either way (the org filter is the same one ADR-0016 §1's
listing uses). A switched profile launches under its *own* sandbox, permission
and secret axes (the unit path reads them fresh per prepare) — switching can
never silently widen or narrow what runs compared to a conversation *created*
with that profile.

## Verification

Real PostgreSQL (`COMMUNICATION_TEST_DATABASE_URL`):
`internal/store/postgres/conversations_switch_test.go` — controller switch
lands (pointer, version re-pin, stamp on the next turn's row, divider payload
with actor/from/to/model), non-controller/viewer 403 + non-member 404 with
nothing moved or journalled, mid-turn 409 in all three active statuses with
the blocking turn named, foreign/malformed profile 400, idempotent re-switch
writes nothing, and the agents list proves the ranges (`1–1`, `2–3`, `4–4`
across switch-away-and-back); the same file proves the claim resolves the new
profile's launcher and that `ResumableSession` refuses the old profile's
binding to the new profile's turn. Worker:
`internal/worker/turns_switch_test.go` drives the real `TurnLoop` over two
claims and proves the live process is closed (`agent_switched`), a new session
launches with no `LoadSessionID` and the same work dir. API contract:
`internal/api/conversation_switch_test.go` pins the route's statuses (200/400/
403/409/404 + CSRF) and the detail read's new members against a policy fake.
`go build ./... && go vet ./internal/...`, `redocly lint api/openapi.yaml`.

## Notes

### The 2e lab pass: what the switch really did (note, 2026-11-02)

Design review round 4 read the switched Codex turn's failure line — *"This chat
couldn't start its workspace: the repository's git address could not be read
from this worker"* — as evidence that a switched turn prepares its workspace
differently, or lands on a worker without the file:// mirror. The journal of
that pass (`rcn-rev4-1793649032`, lab at `45d40ea`) says the switch did exactly
what Decision 1-3 promise, and that the sentence was a lie about something else:

- `conversation.agent.switched` at `19:51:01`, then the next turn's
  `workspace.prepared` at `19:51:02` with the **same `volume_id`**
  (`sha256:247ea68…`), the **same conversation-scoped `run_ref`s**
  (`01a19dd0-848e-74a0-a1ad-5caa7f2abfc2/{server,web}`) and the same worker
  (`worker-a`, `01a19dd0-1b4c-…`) as the Claude Code turn before it; then
  `sandbox.verified`. ADR-0016 §3's claim pins a conversation's turns to the
  worker holding its live binding, and the binding is still `connected` when
  the switched turn is claimed (Decision 3 closes it *inside* the new
  session's path, not before), so the switched turn cannot drift to another
  worker's mirror while the conversation has a session to return to.
- The turn then closed `conversation.turn.failed` with
  `acp: session/new: {"code":-32000,"message":"Authentication required"}` — the
  Codex adapter refusing to start because that launcher's harness sign-in does
  not reach the worker. Nothing on the git path failed. The chat rendered it as
  a repository fault because the UI's failure-copy table matches the bare
  phrase `authentication required` (case-insensitively) in its *mirror-creation*
  arm, which is armed before the ACP arm; git and the ACP adapters use those
  two words for different things.
- The worker now owns its half of that sentence. `internal/worker/launchfailure.go`
  recognises a session-path authentication refusal and journals who refused and
  what to look at — the launcher and its credential directory, with the
  JSON-RPC code — instead of relaying an error string that reads like a
  repository fault. The adapter's raw line still reaches the worker's log.
  Proven by `launchfailure_internal_test.go` and
  `turns_launch_failure_test.go`. A launcher that has no usable sign-in on the
  worker running the turn stays an environment fact: which launcher a journey or
  a deployment switches *to* is the same choice ADR-0072 § 10 records for the
  chain's start, and the compatibility table owns its rows.
- *"AGENTS IN THIS CHAT lists Codex turn 2 though the turn failed"* is not a
  wrong fact either: the `agents` ranges are derived from the turn rows and say
  which profile ran which turns, and turn 2 really did run on Codex. The
  terminal state of those turns is already in the same transcript the panel is
  drawn from (`conversation.turn.failed` carries `turn_id`), so the range's
  failed glyph is a rendering of frames the client holds; the server invents no
  second, drift-prone copy of them. Drawing it is the UI rail's work (design
  handoff 2e), not a schema change.

## Migration/rollback

Forward-only migration `00023` (backfills turn/binding profile ids from the
conversation — the recorded answer for those rows, see Decision 1); the Down
section exists for test resets only. No API removal: an old client keeps
reading the same `agent_profile_id` field, now documented as the next-turn
pointer; `agents`, `agent_profile_model`, the turn triple and `model` are
additive members with explicit nulls where meaningful. Rolling back the code
without dropping the columns is safe: the columns are unused by the old code
and the backfilled values were already implied by `conversations.agent_profile_id`.
