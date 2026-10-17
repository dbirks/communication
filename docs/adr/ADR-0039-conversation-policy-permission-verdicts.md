# ADR-0039 — Policy permission verdicts on the conversation path: a schema decider, journal-only, or status quo

- **Date:** 2026-10-16 · **Status:** Proposed · **Owners:** persistence schema maintainer; worker runtime maintainer
- **Related:** ADR-0016 § 5 (prompts to the controller), ADR-0036 Addendum 2026-10-16 (condition (a) closed
  **for attempts only**), ADR-0009/ADR-0019 (sandbox-verified preapproval);
  `docs/design/attempt-permissions.md`; migration `00003_m2_conversations.sql` `permission_requests`

## Context

A profile's `permission_mode` has three values (`agent_profiles` :57-58), but the **conversation** path
records policy answers in three different shapes:

- `ask` — the human bridge: a `permission_requests` row is opened, answered, and closed `decided`
  with `decided_by` = the answering user (`internal/worker/runner.go:312-365`, `decidePermission`).
- `deny` — since `c1c7c19` the prompt is opened then closed immediately `cancelled` with **no option**
  (`runner.go:344-360`; live: `docs/compatibility/probes/m4/deny_probe.sh`, all PASS on `c1c7c19`).
  `cancelled` is the same close a turn-end cancel produces — an enforced deny and an abandoned prompt
  are hard to tell apart from the row alone.
- `preapproved_within_sandbox` — the turn stays on the harness's own `auto` mode
  (`internal/worker/turnloop.go:458-476`): **no prompt is ever sent, so no per-call verdict exists
  anywhere**. This is precisely the shape ADR-0036 diagnosed as "deny unenforced" on live25 — no
  permission rows over N tool calls; here it is deliberate, but the journal cannot distinguish it
  from a broken sandbox story without a bespoke probe.

The row cannot currently hold a policy answer at all: `permission_requests.decided_by` is
`uuid REFERENCES users (id)` (:249) and `CHECK permission_request_decision_is_answered` (:253-256)
requires `decided_by` + `decision_option_id` for `decided` — so `cancelled`-without-option was the
honest close (`runner.go:346-351`). **Attempts already solved this differently**
(`internal/worker/agentturn.go:1145-1193`, `permissionBridge`; decider strings
`node_policy:<mode>` at `internal/store/postgres/agentturn_seams.go:480-499`): they journal
`decided` with the chosen option **in the event payload only** — no `permission_requests` row
exists for an attempt. So the two paths record the same policy decision differently today, and
ADR-0036's addendum names the remaining gap: closing conversation-preapproved "needs a schema
change plus an ADR". This is that record.

## Options considered

| Option | Advantages | Disadvantages | Evidence |
|---|---|---|---|
| **A — schema decider**: migration adds `decided_by_kind text CHECK (decided_by_kind IN ('user','policy'))` + `decided_by_policy text` to `permission_requests`, relaxes the answered CHECK to accept `(decided, kind='policy', decided_by_policy, option)`; preapproved conversations move to the verified prompting mode and journal every call as `decided` with the chosen option; deny records `reject_once` as `decided` by policy | one durable shape for all three modes on this path; Inbox/audit see who (or what) said yes and which option; deny becomes distinguishable from an abandoned prompt; matches `04-agent-runtime.md:44` "events **and durable prompts**" | a migration + CHECK rewrite (schema change), new members on the permissions GET (public-API change), and preapproved conversations start sending real prompts — needs the launcher's verified prompting mode and fails closed without one (`turnloop.go:466-472`, `errNoAskMode`), a behavior change | `00003:249,253-256`; `runner.go:346-351` names the column as the blocker |
| **B — journal-only, like attempts**: no row for policy-answered prompts; the `decided` event carries `decided_by: 'profile_policy:<mode>'` + option | no migration; mirrors the attempt path exactly; preapproved can stay in auto mode if prompts are skipped wholesale | the Inbox never sees policy calls — a preapproved conversation is a silent zone in the authoritative store while events say otherwise; widens the row/event divergence the two paths already have; event-only `decided_by` is already how attempts work and ADR-0036 kept calling that *not* the conversation fix | `agentturn.go:1183-1191` (event payload only); ADR-0036 Addendum correction (attempt rows were `attempt-…-permission-N`, never conversation rows) |
| **C — status quo, documented**: deny = `cancelled` no-option; preapproved = auto mode, no per-call verdict; this ADR just records it | zero code, zero migration; live evidence already exists for deny (`live30/deny_probe.out`: 1 requested / 1 decided(cancelled) / file never lands) | the preapproved conversation path stays unverifiable from the journal alone — "did the sandbox or an absent prompt allow that write?" is unanswerable post-hoc; contradicts the durability 04 asks for; ADR-0036 had to write a probe (`deny_probe.sh`) because the store can't answer | `turnloop.go:458-463` states the gap in-code |

## Decision

**Proposed (drafter's recommendation — pending the owner's decision): Option A.**

1. **Schema** — new migration (after `00006`): `permission_requests` gains
   `decided_by_kind text NOT NULL DEFAULT 'user' CHECK (decided_by_kind IN ('user','policy'))` and
   `decided_by_policy text` (NULL unless kind=`policy`; values `preapproved_within_sandbox`,
   `deny`), and `permission_request_decision_is_answered` becomes
   `(status='decided' AND ((kind='user' AND decided_by IS NOT NULL) OR (kind='policy' AND
   decided_by_policy IS NOT NULL)) AND decision_option_id IS NOT NULL)` or
   `(status<>'decided' AND all three NULL)`. Existing rows keep working (backfilled `kind='user'`).
2. **Worker** — `decidePermission`'s non-`ask` branch closes `decided` with the policy's option
   (deny → the harness's `reject_once`, preapproved → `allow_once`/`allow_always` by kind, reusing
   the `PermissionVerdict` mapper from `agentturn_seams.go`); `turnloop.go` puts
   `preapproved_within_sandbox` conversations on the verified prompting mode like deny, failing
   closed via `errNoAskMode` without one. The event pair already written around the row is unchanged
   except `decided_by` now names the policy for policy closes.
3. **API** — the permissions resource gains the two nullable members; additive per ADR-0014/§ 2.2
   rules (adding members is additive; the `decided_by_kind` enum is a public contract).

If the owner prefers B or C, this record should be superseded, not amended: B/C are live behaviors
today and each would need its own "why not A" reasoning on the record.

## Consequences

Positive: every permission verdict on every path lands in the authoritative store with a named
decider and a chosen option; the Inbox, audit, and `docs/compatibility/SANDBOX.md` evidence rows all
read one shape. Costs: one migration; preapproved conversations change behavior (real prompts on a
verified mode instead of silent auto) and refuse to launch where no prompting mode is verified —
fail-closed, but a new failure mode for operators; the compatibility matrix (`docs/compatibility/ACP.md`)
needs a prompting-mode row per launcher before preapproved conversations work at all. The attempt
path is deliberately **not** unified here — giving attempts durable rows is its own decision
(`docs/design/attempt-permissions.md` options 3/4).

## Security/privacy

This strengthens the boundary: a policy "allow" becomes attributable evidence (kind+name+option+
timestamp), which ADR-0009/ADR-0019 need to keep `preapproved_within_sandbox` honest per launch, and
fail-closed prompting replaces silence. It does not widen who can answer: policy closes are written
only by the fenced worker under the turn's lease (ADR-0016 § 5); the HTTP answer route still
requires a user and still only accepts `ask` prompts. Fail-closed on every arm: unknown mode,
unverified prompting mode, or missing option → refusal, never a default allow.

## Verification

- Unit: the new CHECK admits `(policy, option)` and rejects `decided` with neither or both deciders;
  `decidePermission` closes deny as `decided`+`reject_once` and preapproved as `decided`+`allow_once`
  (mirrors `agentturn_seams_test.go:620-627` table cases); API contract test that the permissions
  GET carries the two members and honors the enum.
- Live lab (the gate, like `deny_probe.sh`): extend it — a `deny` conversation must show ≥1
  `requested` + 1 `decided (kind=policy, deny, reject_once)` row and no file landing; new
  `preapproved_probe.sh` — a `preapproved_within_sandbox` conversation must show N `requested` / N
  `decided (kind=policy, preapproved_within_sandbox, allow_*)` rows matching N tool calls, plus the
  in-workspace file the sandbox grants. No PASS without observed rows (AGENTS.md).

## Migration/rollback

Upgrade: one additive migration with backfill (`decided_by_kind='user'` where `decided_by IS NOT NULL`
else `'policy'` is impossible pre-change — every existing decided row is a user's); deploy worker after
migration so old workers keep writing `cancelled` closes that still satisfy the new CHECK. Rollback:
the worker alone (new rows keep `kind='user'` defaults readable by the old CHECK — the dropped CHECK
was a superset), then `DROP` the two columns; event payloads never changed shape (`decided_by` was
already a free string, `internal/events/events.go:527`), so no consumer is stranded either way.
