# Claude Code "Tool use aborted" under permission `ask` — 2026-11-11

Symptom (deployed thread `01a1cb61-a0a0-7be3-a48e-977724baf370`, launcher
`claude` 0.90.x, profile permission mode `ask`): three Bash calls came back as

```
Tool permission request failed: Error: Tool use aborted
```

and the agent's closing message blamed itself ("The Bash tool failed three times
with 'Tool use aborted'"). No approval prompt was answered.

## Verdict

Not a UI defect and not a lost prompt. The permission bridge did exactly what
`ask` specifies: it opened three prompts, journalled each one, waited the
worker's fixed **2-minute** permission TTL for the conversation's controller,
nobody answered, each prompt expired, and the agent got the honest "cancelled"
ACP outcome — which is what Claude Code renders as `Tool use aborted`. The gap
is that nothing outside the transcript scroll told anyone a turn was blocked on
them, and two minutes is not a human-scale window. No worker semantics changed.

## Evidence (deployed, read-only)

`domain_events` for that conversation, permission rows only (times UTC):

| requested | decided (status `expired`) | open for | request id |
| --- | --- | --- | --- |
| 16:12:20.406 | 16:14:20.497 | 120.09 s | `01a1cb61-b437-7100-b014-85c08dcb25ef` |
| 16:16:24.393 | 16:18:24.493 | 120.10 s | `01a1cb65-6d49-7eea-9e7a-162609d54864` |
| 16:14:21.678 | 16:16:21.808 | 120.13 s | `01a1cb63-8dee-7f40-84d0-11421f05276b` |

The `permission_requests` rows agree (`status = expired`, `decided_by_kind =
user`, `decided_by` empty, deadline = requested + 120 s exactly), and the
`conversation.permission.requested` payload is complete and answerable — options
and deadline included:

```json
{"kind":"execute","title":"git ls-files; echo ---; cat README*",
 "options":[{"kind":"allow_once","label":"Yes","option_id":"allow-once"},
            {"kind":"allow_always","label":"Yes, and don't ask again for git ls-files * commands","option_id":"allow-with-updates"},
            {"kind":"reject_once","label":"No","option_id":"reject"}],
 "deadline_at":"2026-11-11T16:14:20Z","permission_request_id":"01a1cb61-b437-7100-b014-85c08dcb25ef",
 "tool_call_id":"toolu_01My9JREGpYW44wGBJvtNmvM","turn_id":"01a1cb61-a0a1-7987-838c-cf171ff6ee42"}
```

Between the prompts the read-only tools worked: the `Read README` call completed
(`output_preview: 1\tHello World!`), so the session, sandbox and ACP channel were
healthy. The turn ended `stop_reason: end_turn` at 16:18:28 with the agent's
partial answer. Nothing was truncated, refused or mis- journalled.

The three `conversation.tool.update … status: failed` rows naming `Tool use
aborted` are Claude's own words arriving over `session/update` — the harness
reporting what it did with our cancelled outcome, not our text.

## The chain, with file:line

1. Claude Code asks; the ACP client handler answers `session/request_permission`
   through the worker's decider — `internal/agent/acp/handle.go:661`
   (`RequestPermission`; `cancelledPermission()` at `handle.go:776`).
2. The durable human bridge for a conversation turn is
   `internal/worker/runner.go:402` (`decidePermission`): it opens the prompt at
   `internal/worker/runner.go:409-421` with
   `deadline = now + cfg.PermissionTTL`, and `cfg.PermissionTTL` defaults to
   `DefaultPermissionTTL = 2 * time.Minute` —
   `internal/worker/turnloop.go:30`, applied at `internal/worker/turnloop.go:81`.
   There is no operator-facing knob for it.
3. The insert plus the `conversation.permission.requested` journal row, fenced on
   the turn, is `internal/store/postgres/turns.go:421` (`OpenPermission`, event
   payload `internal/events/events.go:693`).
4. `ask` with a controller on the conversation waits the whole TTL in
   `internal/worker/runner.go:494-551`. Because these rows expired rather than
   closing as `policy`, `someoneIsDriving` (`internal/worker/runner.go:569`) was
   true: the conversation had a controller — the person who sent the message — and
   the worker was right to wait for them. (The ADR-0072 no-controller arm
   (`internal/worker/runner.go:465-492`) would have refused with
   `ask_without_controller` in milliseconds; that is not what happened here.)
5. At the deadline the worker closes the row `expired`
   (`internal/worker/runner.go:534-548`) and answers the agent with no option —
   `internal/worker/runner.go:548` returning `domain.PermissionChoice{}` with a nil
   error, which `handle.go:724` (`if !ok { return cancelledPermission() }`) turns
   into the ACP `outcome: cancelled`. Claude Code's Bash tool surfaces that as
   `Tool use aborted`. The worker's comment on that line is the intent:
   "the cancelled outcome is the honest 'nobody said yes'".
6. On the read side the prompt *is* visible: `ui/src/api/transcript.ts:774` folds
   `conversation.permission.requested` into a `permission` transcript item with its
   options and `deadline_at`, `ui/src/components/Transcript.tsx:282` (`PermissionCard`)
   renders it with Allow/Reject buttons while pending (`canDecide` = the caller is
   the controller), and `ui/src/pages/Conversation.test.tsx:629` proves that card
   posts `POST /api/v1/conversations/{id}/permissions/{requestId}`
   (`internal/api/conversations.go:625`). Once `decided` arrives the card becomes a
   closed gray record with a `status: expired` chip
   (`ui/src/components/Transcript.tsx:305-339`) — which is what a person who
   arrived late saw, three times, after the tools had already failed.

## Why it read as "nobody saw a prompt"

* The only place the ask appears is one card inside the transcript scroll, below
  the agent's own streaming text, with no signal in the thread header, the sidebar,
  the browser title or any notification. `ui/src/lib/attention.ts:201` counts
  `pending_permissions` — but only for a project's "Needs you" list, and only while
  someone is looking at that list.
* The window is 120 s. A person who is at lunch has not declined a `git ls-files`;
  the product recorded them as having declined it, three times, and the agent
  wrote that down as its own failure.
* After expiry the card's wording (`status: expired`) and the tool row's
  (`Tool use aborted`) point at Claude, not at the unanswered ask.

## Proposal (product decision, not applied here)

Ordered cheapest-first; none of these change worker semantics.

1. **Name the blocked state where the person already looks.** While
   `GET /api/v1/conversations/{id}` carries a `pending` permission, the thread
   header shows `Waiting for your approval — <tool title> · expires 16:14:20 UTC`,
   the same data `PermissionCard` already renders. The row is already in
   `RESOURCE_TYPES` (`ui/src/api/events.ts:127-128`), so the read is live;
   `permission_requests` is already part of the conversation resource
   (`pending_permissions`).
2. **Make it findable from outside the thread.** Fold the count into the existing
   unread/pending badge (sidebar + document title, then a browser notification for
   an opted-in user) using the same `pending_permissions` read
   `ui/src/lib/attention.ts:201` already makes. A prompt nobody can see is the bug;
   a prompt nobody answered is a decision.
3. **Give the expiry a fair window and say what it means.** Two minutes is a
   reasonable machine timeout and an unreasonable human one. Either raise the
   default and expose it (`COMMUNICATION_WORKER_PERMISSION_TTL`, alongside the
   other worker turn-loop knobs — `internal/worker/turnloop.go:48`), or keep 2 min
   and make the transcript say the rule out loud on the expired card: "Nobody
   answered within 2 minutes, so the tool call was refused. Ask again and answer
   promptly, or take control before sending." One sentence turns a mystery into a
   policy the reader can act on.
4. **Let the answer arrive before the card is read.** The ADR-0016 §5 rule that
   only the controller may answer is right; the friction is that a person who
   wants to approve must first take control and then notice the ask. A
   "take control and answer" single action on the pending card (takeover +
   decision, both already authorized routes) removes the ordering trap.
5. **Prefer a mode that does not need a human for read-only commands.** This
   thread ran `git ls-files` and `cat README*` under `ask`. `preapproved_within_sandbox`
   (ADR-0039/ADR-0069) answers those from policy with the verdict still journalled
   — the profile author, not the runtime, should decide which commands are worth a
   person's attention. Worth a line in the profile editor's help text.

## Follow-ups worth a ticket

* `PermissionTTL` is a compile-time default with no config face, so an operator
  cannot lengthen the approval window without a rebuild
  (`internal/worker/turnloop.go:30`).
* The worker logs the wait but the thread UI never distinguishes "the agent asked
  and you did not answer" from "the agent's tool failed"; the tool row shows the
  harness's text verbatim (`Tool use aborted`), which misattributes the cause.
