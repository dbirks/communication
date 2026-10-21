# ADR-0050 — Assistant v2: per-user persisted conversations, multi-turn questions, change log with undo, server-side trust gating

- **Date:** 2026-10-20 · **Status:** Accepted (product owner decision, design only —
  implementation evidence required before the routes are claimed as working) · **Owners:**
  assistant/API maintainers; UI maintainer (popover, Settings → Assistant)
- **Related:** ADR-0034 (read-only assistant broker — its storage clause is amended here),
  ADR-0044 (closed draft-proposal op set; apply through the version-checked draft PUT),
  ADR-0046 (`user_preferences.assistant.trust_level` — its client-side enforcement is
  amended here), ADR-0018 (no secret-shaped data in a prompt), ADR-0014 (HTTP/problem
  conventions), ADR-0013 (forward-only migrations), `communication-spec/08-assistant.md`
  (application agent, tool action policy, "Persist assistant transcript and action
  trace"), `communication-spec/09-api-events-data.md:18` (names the assistant resource
  family), design brief `docs/design/handoff-app-shell/` (artboards 2a/2c/3d/4d; gap
  `gaps/assistant.md` §6 unit W0)

## Context

ADR-0034's broker is implemented and live: `POST /api/v1/assistant/ask` runs one bounded
model turn through six read-only store methods called with the caller's own `Caller`, and
then discards the turn. Its storage clause reads, verbatim:

> **v1 stores nothing.** No table, no `assistant_*` rows, no conversation: the palette
> keeps the turn in memory for the session and a reload loses it. `08`'s "persist
> assistant transcript and action trace" lands with the first write tool, when there is
> an action to audit.

and its Supersede note: "persistence + write tools + the `08` event protocol need their
own ADR, which must decide the transcript table." This ADR is that ADR. The app-shell
redesign (artboard 2a/2c/3d/4d) requires: a global assistant whose **conversation
survives navigation and reload**; **follow-up questions** the model writes (2–4 option
buttons + free text, reply always plain text); a per-user **trust level** checked in the
tool loop before risky actions, surfaced as an approval card with Retry / Not now; and a
**change log** with per-item and undo-all, where draft edits are reversible and
runs/approvals are logged but not undoable. Spec 08 sides with the redesign: "Persist
assistant transcript and action trace; redact privileged data", "Validation includes
project scope, actor authorization, version preconditions, confirmations and auditable
mutation records", "Who changed this and why?" must be answerable.

Constraints that pin the design:

- **Per-user, self-scoped.** A conversation belongs to the signed-in user, like
  `user_preferences` (ADR-0046); it is not project state and is not another member's.
- **Server-side gate, server-side record.** The design brief says the trust level "doesn't
  need its own server-side enforcement"; that is wrong for a gate and for a log: a
  `no_ask` client must not be the only control, and a change log must survive a reload.
  The trust level is therefore consulted **server-side in the tool loop** (amending
  ADR-0046 item 6) and the change record is a table, not browser memory. It still
  **authorizes nothing** — every action executes as the caller through the same
  permission-checked services the routes use (ADR-0034 rule (a), spec 08 "one control
  source").
- **The model is not trusted.** Draft edits travel as ADR-0044's closed op set; undo
  travels as the closed inverse of one such op; nothing free-form touches a draft.
- **Trust level lives in `user_preferences.assistant.trust_level`** (ADR-0046,
  contract C2: `GET/PATCH /api/v1/me/preferences` → `assistant.trust_level`
  `ask_all|ask_risky|no_ask`). This ADR does not define a second preference route.

## Decision

1. **Tables**, migration `00010_assistant_v2.sql` (00009 is ADR-0049's step registry),
   forward-only per ADR-0013:

```sql
CREATE TABLE assistant_conversations (
    id              uuid        PRIMARY KEY DEFAULT uuidv7(),
    user_id         uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    title           text,                                   -- set from first user message, ≤ 80 chars
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    last_message_at timestamptz
);
CREATE INDEX assistant_conversations_user_recent_idx
    ON assistant_conversations (user_id, last_message_at DESC NULLS LAST);

CREATE TABLE assistant_messages (
    id              uuid        PRIMARY KEY DEFAULT uuidv7(),
    conversation_id uuid        NOT NULL REFERENCES assistant_conversations (id) ON DELETE CASCADE,
    kind            text        NOT NULL
                    CHECK (kind IN ('user','assistant','question','change','approval_request')),
    payload         jsonb       NOT NULL DEFAULT '{}'::jsonb
                    CHECK (jsonb_typeof(payload) = 'object'),
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX assistant_messages_conversation_idx
    ON assistant_messages (conversation_id, created_at, id);

CREATE TABLE assistant_changes (
    id              uuid        PRIMARY KEY DEFAULT uuidv7(),
    conversation_id uuid        NOT NULL REFERENCES assistant_conversations (id) ON DELETE CASCADE,
    user_id         uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    project_id      uuid,                                    -- NULL for org-level actions
    kind            text        NOT NULL
                    CHECK (kind IN ('draft_edit','navigate','run_start','run_retry',
                                    'approval_decision','publish')),
    target_ref      text        NOT NULL,                    -- e.g. "draft:01K…", "run:01K…/test"
    summary         text        NOT NULL,
    undo_payload    jsonb,                                    -- NULL when not undoable
    undone_at       timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CHECK (undone_at IS NULL OR undo_payload IS NOT NULL),
    CHECK (kind <> 'navigate' OR undo_payload IS NULL)
);
CREATE INDEX assistant_changes_conversation_idx ON assistant_changes (conversation_id, id);
```

Deliberate invariants: `assistant_messages` is an **append-only transcript** ordered by
`(created_at, id)` (uuidv7 is time-ordered; the only in-place updates allowed are an
`approval_request` row's `state` and a `question` row's `answered_by` — decisions on
that row, not transcript rewriting); a user's deletion cascades all three tables (the durable audit for a
*mutation* itself is the event the underlying route already journals — draft PUT, run
retry, approval decision — and `assistant_changes` is the assistant-scoped trace the UI
renders); the kind CHECK makes the non-undoable kinds explicit so a future tool has to
name its kind here, and `undo_payload` is never exposed on any read route.

2. **Routes** — session-authenticated, per principal, same CSRF/auth guards as the
   other mutations (ADR-0014); a conversation that exists but belongs to another user
   returns the api not-found sentinel (404), never 403. All under `/api/v1/assistant`:

| Route | Semantics |
|---|---|
| `POST /assistant/conversations` | create; 201 `{"id","title":null,"created_at","updated_at","last_message_at":null}` |
| `GET /assistant/conversations?limit=&cursor=` | caller's own, newest `last_message_at` first → `{"conversations":[Conversation],"next_cursor"}`; `Conversation = {id,title,created_at,updated_at,last_message_at}` |
| `POST /assistant/conversations/{id}/messages` | run **one server-side turn**; 200 `{"messages":[Message]}` = the rows appended by this request (always the `user` row first, then the turn's output) |
| `GET /assistant/conversations/{id}/messages?limit=&cursor=` | transcript, oldest-first paging → `{"messages":[Message],"next_cursor"}` |
| `GET /assistant/conversations/{id}/changes?state=open\|undone\|all` | → `{"changes":[Change]}`, `Change = {id,kind,target_ref,summary,undoable,undone_at,created_at}` (`undoable = undo_payload IS NOT NULL`; the payload itself is never returned) |
| `POST /assistant/changes/{id}/undo` | apply the inverse op; 200 the updated `Change` (with `undone_at`); 409 `change_not_undoable` |
| `POST /assistant/conversations/{id}/undo-all` | undo every still-open undoable change, newest first → 200 `{"results":[{"change_id","status":"undone\|already_undone\|not_undoable\|failed","error"?}]}`; items are independent — one failure never blocks the next |

The messages POST body:

```json
{ "text": "add a code reviewer after the tests node",
  "context": { "route": "/p/01J…/pipelines", "project_id": "01J…",
               "entity": { "kind": "draft", "id": "01K…" } },
  "confirm": null, "dismiss": null }
```

- `text` is 1–2000 chars (required unless `confirm` or `dismiss` is set), secret-scanned
  with ADR-0018's refusal **before any model egress**; `context` (Decision 6) is
  optional. `confirm` names a pending `approval_request` message id in this
  conversation; `dismiss` names one for Not now; the two are mutually exclusive, and an
  unknown id or a non-pending state is `409 approval_request_not_pending`. A
  confirm/dismiss request carries no model call of its own: the decision row updates,
  the action (if confirmed) executes through the underlying service, and one short
  assistant acknowledgement message is appended.
- A plain `text` turn: the server loads the caller's `trust_level`, sends the last 20
  transcript messages (≤12 KB total, oldest dropped) plus `context` to the model with
  the ADR-0034 tool registry extended per Decision 4, and appends the rows below. Caps,
  egress rules and refusal behaviour are ADR-0034's. `updated_at`/`last_message_at` are
  refreshed in the same transaction as the appended rows; the first user message sets
  `title`.

3. **Message payloads** — one JSON object per `assistant_messages.payload`:

```json
{ "kind": "user", "text": "…",
  "context": { "route": "/p/01J…/pipelines", "project_id": "01J…",
               "entity": { "kind": "draft", "id": "01K…" } } }

{ "kind": "assistant", "turn_id": "01K…",
  "answer_markdown": "I added `review` after `tests`…",
  "links": [{ "label": "Open the draft", "route": "/p/01J…/pipelines" }],
  "tool_calls": [{ "name": "draft.apply", "summary": "inserted node `review`", "ok": true }],
  "degraded": null }

{ "kind": "question", "turn_id": "01K…",
  "prompt": "Use this beta for new issues only, or also replace pending ones?",
  "options": [{ "label": "New issues only", "value": "new_only" },
              { "label": "New + pending", "value": "both" }],
  "allow_free_text": true, "answered_by": null }

{ "kind": "change", "change_id": "01K…", "change_kind": "draft_edit",
  "target_ref": "draft:01K…", "summary": "Inserted node `review` after `tests`",
  "undoable": true }

{ "kind": "approval_request", "turn_id": "01K…", "action": "run.retry",
  "summary": "Retry node `test` on run 9c1e (attempt 2)",
  "risk": "re-runs the failed node with its recorded retry context",
  "state": "pending" }
```

- `assistant` rows: `links` are server-validated exactly as ADR-0034 validates them
  (same-origin, route allowlist, dropped-and-recorded otherwise) and use the real
  route vocabulary (`route`, not `href`); `tool_calls[].summary` is a short server-
  supplied sentence, never raw tool output. A turn appends at most one `assistant`,
  one `question` and one `approval_request` row, in that order, after the `user` row.
- **Questions.** 2–4 options; `allow_free_text` is always `true` in this version.
  Whatever the user taps, types or dictates, the client posts the **label verbatim**
  (or the free text) as an ordinary `user` message — replies are always plain text,
  so history stays understandable (spec 08 "selecting `Run both reviewers in
  parallel` becomes that literal semantic answer"). On the next turn's completion the
  `question` row's `answered_by` is set to the replying user message's id (the
  in-place update Decision 1 allows, with the `approval_request` `state`).
- **Approval requests.** `state` is `pending → confirmed | dismissed`; Retry posts
  `{"confirm": "<id>", "text": ""}`, Not now posts `{"dismiss": "<id>"}`. Only
  `pending` requests in the same conversation of the same user are actable.

4. **Tool classes and trust gating.** The ADR-0034 registry is extended; every tool is
   exactly one class, and `user_preferences.assistant.trust_level` (read server-side at
   the start of each turn and each confirm) decides gating *before execution*:

| Class | Tools | ask_all | ask_risky (default) | no_ask |
|---|---|---|---|---|
| `read` | `project.list`, `run.list`, `run.nodes`, `approval.pending`, `pipeline.revisions`, `palette.search`, `draft.get` | never gated | never | never |
| `navigate` | `ui.navigate` (Decision 7) | never gated — client-side presentation, the server executes nothing | never | never |
| `draft_edit` | `draft.propose` + `draft.apply` — ADR-0044's closed op set, applied by the server through the version-checked `PUT /api/v1/drafts/{id}` path (ADR-0034's "no write entry" is amended for the conversation loop only; `POST /assistant/draft-proposals` keeps its own human-Apply contract untouched) | gated | not | not |
| `risky` | `run.retry`, `run.start`, `approval.decide`, `permission.allow`, `pipeline.publish` / promote | gated | gated | not |

Gate mechanics: when a tool is gated and the model calls it, the turn **stops without
executing**: the server appends an `assistant` row naming the proposed action and an
`approval_request` row (`state: pending`), and the client renders the amber NEEDS
APPROVAL card. Confirming (`confirm: <id>`) re-checks authorization **as the caller**
(the action executes through the same permission-checked service the route uses — e.g.
`run.retry` goes through `internal/api/runs.go`'s retry path with the caller's role
check), executes once, and appends the acknowledgement plus a `change` row; the
trust level at confirm time does not re-gate an explicitly confirmed action. `no_ask`
executes gated tools directly but writes the same `change` rows — "every action logged
with undo where possible" is a server property, so a `no_ask` client and a tampered
client cannot hide an action. A denied action (authz failure inside the service) is
reported as `tool_calls[].ok: false` with the stable reason and, per ADR-0034's 404
rule, names no project facts the caller could not already read.

5. **Undo.** `assistant_changes` is written in the same transaction as the mutation:

| kind | `undo_payload` | undo does |
|---|---|---|
| `draft_edit` | `{"draft_id","inverse":{…}}` where `inverse` is the closed inverse of the applied op: `insert_after`/`insert_on_edge` → `{"op":"delete_node","node":"<id>"}`; `update_prompt` → `{"op":"update_prompt","node":"<id>","prompt":"<previous text>"}` (the inverse is the server's own record, never model text) | apply `inverse` to the draft's **current** version through the same server-side canonicalize/validate + version-checked PUT path the edit used; set `undone_at` in one transaction |
| `navigate` | `NULL` (forced by CHECK) | UI shows "not undoable" |
| `run_start`, `run_retry`, `approval_decision`, `publish` | `NULL` | UI shows "not undoable" — a started run or made approval has no inverse op; the row is the audit trail the UI *must* render (gap §8 Q3) |

`POST /assistant/changes/{id}/undo`: 404 (not the caller's change); 409
`change_not_undoable` when `undo_payload` is NULL, `undone_at` is set, the draft no
longer exists or the caller no longer has draft-write right, or the inverse op does not
structurally apply to the draft's current version (e.g. the inserted node gained
dependents after the edit) — in the structural case the draft is left untouched and the
detail says so. Undo-all is the same rule per row, newest first, collected into the
`results` array (Decision 2).

6. **Page context.** `context` is per message (Decision 2), not per conversation: it
   captures the page the user was on when they asked. `route` is a client-asserted
   same-origin path (validated against the same allowlist as links, dropped if it
   fails); `project_id` and `entity {kind, id}` (kinds: `pipeline`, `draft`, `run`,
   `node_template`, `profile`) are entity refs the tools may use as a *starting
   point* — every ref is still re-authorized with the caller's `Caller` and an
   invisible resource yields the 404-rule emptiness, never data. The model prompt gets
   the route + refs as plain context text; the refs grant nothing.

7. **Navigation.** `ui.navigate` takes a server-validated route (same-origin allowlist,
   ADR-0034) and the turn's `assistant` row carries it as a link; **the client performs
   the navigation** (presentation of an already-authorized state, per spec 08 — never
   DOM automation). The server still logs it as an `assistant_changes` row with
   `kind: 'navigate'`, `undo_payload NULL`, `target_ref` = the route — so navigation
   appears in the change list as a logged, no-undo-needed row.

8. **Journaling.** No new `domain_events` types in this ADR: every mutation the
   assistant performs goes through the existing service (draft PUT, run retry, approval
   decision) and writes that route's existing event; `assistant_changes` is the
   assistant-scoped "who changed this and why" record (spec 08 "auditable mutation
   records"). Spec 08's `assistant.*` SSE event protocol (`assistant.message.delta`,
   `assistant.tool.executing`, …) stays deferred exactly as ADR-0034 deferred it — the
   conversation REST routes are the transcript source and the org stream carries the
   mutation events a turn already produces.

9. **Amendments.** This ADR amends ADR-0034's storage clause, quoted above: v1's
   `POST /assistant/ask` continues to store nothing, but the conversation routes of
   Decision 2 **are** the transcript and action trace spec 08 requires, and the
   registry's "no write entry" holds only for the v1 ask path and the ADR-0044
   draft-proposals path, both of which keep human-Apply semantics. It amends ADR-0046
   Decision 6: the trust level is consulted **server-side in the assistant tool loop**
   (Decisions 4), not merely client-side — the clause that it authorizes nothing and
   never widens which store calls the broker may make is unchanged. ADR-0034's status
   moves to Accepted-with-amendment: its mechanism (broker, egress, six read tools,
   authz matrix) is implemented and verified as its test plan specifies, and its
   Supersede note is satisfied by this ADR.

## Consequences

- Migration `00010_assistant_v2.sql`; three small per-user tables; `api/openapi.yaml`
  gains the seven routes and the `AssistantConversation*` / `AssistantMessage` /
  `AssistantChange` schemas (the `AssistantQuestion` schema gaps/assistant.md §3 names)
  — `pnpm --dir ui gen:api` regenerates the client the popover consumes.
- `internal/assistant` grows the conversation store, the turn runner (history +
  context), the classification table and the undo path; the v1 ask route is untouched
  and can be retired once the popover replaces the palette's Ask row.
- The UI gets the popover shell (artboard 2a/3d), question cards, the change chip and
  the amber approval card, and Settings → Assistant reads/writes
  `assistant.trust_level` through the existing `PATCH /api/v1/me/preferences`
  (ADR-0046/C2 — no second preference route).
- "Don't ask" is now a server-audited posture: every `no_ask` action lands in
  `assistant_changes` whether or not the client ever renders it.

## Verification

Design only — nothing here is claimed as working. Before the routes may be reported as
implemented: real-PostgreSQL store tests (per-user isolation and 404 across users,
append-only ordering, undo CHECKs, cascade on user delete); handler tests for the seven
routes (401/404/409 shapes, CSRF before the handler, secret-shaped `text` refused with
zero model egress, confirm on a dismissed request → `409 approval_request_not_pending`);
authz legs (non-member's turn cannot produce Project B facts; `run.retry` confirm as a
viewer is refused by the underlying service); and the undo round-trip: apply an
ADR-0044 op, undo, draft bytes identical to pre-edit, second undo → 409. The gap
analysis's browser checks (gaps/assistant.md §7) cover the UI side.

## Migration/rollback

Additive only: new tables, new routes, one extended tool registry; v1 `ask` and
ADR-0044 proposals behave byte-identically. Rollback: unmount the new routes; the
00010 tables are inert (nothing else reads them) and stay in place per ADR-0013 — no
down-migration, no transcript loss at risk because only the new routes write them.

## Amendment 1 (2026-10-21) — per-turn caps for the conversation runner

Accepted. The runner kept reusing the v1 one-shot broker's caps
(`MaxModelCalls = 4`, `MaxToolCalls = 8` — deliberately constants in
`docs/design/assistant-v1.md` § Tools, because "the bounded turn is the
safety property"). On the lab (acceptance journey step f, real model) a
multi-step draft edit — `palette.search` → `draft.get` → `draft.apply` →
a retry after a refused proposal → the answer — needs 4–6 model calls and
refused with "the turn reached the 4 completion cap without an answer".

The v2 conversation runner now keeps its own constants, `MaxRunnerModelCalls
= 8` and `MaxRunnerToolCalls = 16` (`internal/assistant/assistant.go`), used
only by `runner.go`. Why v1's 4 is too small: one honest draft-edit turn is a
chain of four tool rounds plus the answer, and a single refused proposal adds
a retry — 4 completions cannot finish it. The turn is still bounded (a
hard cap on completions and on tool results per turn; the refusal names the
v2 number, and a tool result past the budget is a visible
`tool_cap_exceeded` row that makes zero store calls, the v1 rule at the v2
budget). They remain constants, not configuration, with the same rationale
as v1: widening them is a design change that comes back through this ADR,
not an operator knob. The v1 `POST /assistant/ask` route is untouched and
still refuses at 4.

Relies on this ADR's decision 2 (bounded model loop) and the v1 design's
Tools section; amends only the caps the runner applies — no API,
persistence, security boundary or recovery change. Verified: `go test -race
./internal/assistant/...` — a scripted turn needing six completions
succeeds, the ninth is refused with the v2 message, `/assistant/ask`
still refuses at 4.
