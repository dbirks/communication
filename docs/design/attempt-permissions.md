# Attempt permissions: what should happen to an `ask` prompt inside a pipeline run?

## The observed behaviour (not a bug — an accepted design)

Under `permission_mode: ask`, an attempt's prompt is journalled as
`conversation.permission.requested` then immediately
`conversation.permission.decided{status:'cancelled', decided_by:'node_policy:ask_unattended'}`
(internal/worker/agentturn.go:1007-1051, internal/store/postgres/agentturn_seams.go:464-484).
The agent's tool call gets the ACP cancelled outcome, so `execute` fails.

## Why the spec says this is correct

- `04-agent-runtime.md:44`: modes are `ask | preapproved_within_sandbox | deny`; requests
  "create events and durable prompts to authorized users; no hanging forever without deadline/fallback".
- `06-collaboration-identity.md:27`: ACP prompts surface to the **authorized current controller**
  or designated approvers.
- ADR-0016 § 5 (line 101): prompts go to the **controller only**; `POST /conversations/{id}/permissions/{requestId}`
  from a non-controller is `409`. During an attempt the controller **is the run attempt**
  (ADR-0016 § 2 line 56; m4-contract § 4 step 6, line 686) — no human holds the lock.
- m4-contract § 5.3 (lines 804-819): "a human who wants to answer takes over" — take-control
  cancels the turn, the attempt closes `interrupted{human_takeover}`, the run pauses, and
  return-control resumes with the human's intervention as retry context. That is the spec's
  answer path (`03-pipeline-engine.md:64`), not mid-run permission answering.
- m4-contract D3 (line 1704): ACP prompts (controller-answered) and pipeline gates
  (`human.approval`, maintainer-answered) are deliberately separate; surfacing an `ask` prompt
  to "any maintainer" via the gate route would collapse that separation.

No code change is warranted; changing this requires an ADR superseding ADR-0016 § 5's
controller-only rule.

## Options for the product owner

1. **Use `process.exec` nodes for tests** (no ADR needed). pytest/build steps belong in
   `process.exec` attempts (m4-contract § 4 step 7): argv, sandboxed, no ACP prompt at all.
   Cheapest honest fix for the crippled test steps.
2. **`preapproved_within_sandbox` profile** (no code, needs lab evidence). The policy exists
   and the sandbox is verified per launch (`sandbox.verified`, ADR-0019). ADR-0016 line 142
   says flipping a seed is "a compatibility-lab result, not a config change" — run the lab
   for the planner's launcher, then set the profile row.
3. **Pending-prompt-with-deadline (option (a))**: attempt prompts stay pending until a
   maintainer answers or the attempt deadline expires. Needs an ADR: it weakens the
   single-controller invariant at the authorization edge, and needs `decided_by` semantics
   for non-controller consent plus reconciler expiry UX.
4. **Per-node pre-answer policy**: node/pipeline YAML declares which tool kinds auto-allow
   inside the verified sandbox (partial option (b), `04:44` "also configurable by tool/action").
   Smaller ADR than 3; risks policy sprawl.

Recommendation: adopt 1 now, evaluate 2 in the compatibility lab, park 3/4 until a real
workflow needs an unattended `ask` to survive.

## Decision for the lab (ADR-0036)

Option 2 has since been evaluated and **adopted for the M4 lab only**: the three seeded profiles in
`docs/compatibility/probes/m4/seed.sh` (`m4-planner`, `m4-implementer`, `m4-reviewer`) now run
`preapproved_within_sandbox`, on the evidence in `docs/compatibility/SANDBOX.md` §
"preapproved_within_sandbox lab evaluation (2026-10-16)" (in-grant compute/writes allowed;
`/etc/shadow`, an outside-grant read and an outside-grant write all `EACCES` from the kernel with no
human involved) and § "Egress allowlist lab evaluation (rows 8a/8b)" (egress limited to the ADR-0035
allowlist, `example.com` refused with a `host_denied` audit record, and real `claude-agent-acp` turns
completing on `api.anthropic.com` alone). This document's analysis stands unchanged for everything
else: the product's seeds (migration 00003) and any deployment stay `ask`, attended conversations keep
answering prompts as before, `process.exec` stays the recommendation for deterministic test/build
steps, and the journal still records no verdict for a preapproved tool call — condition (a) of that
evaluation, still open, and the reason the mode was not shipped as a product default. See
[`../adr/ADR-0036-lab-agent-profiles-preapproved-within-sandbox.md`](../adr/ADR-0036-lab-agent-profiles-preapproved-within-sandbox.md).

## Why attempts journal no verdict (2026-10-16 finding)

Condition (a) was investigated against the live M4 lab (13 attempts, 34 tool calls, 0
`conversation.permission.*` rows). It is not a broken bridge — **no prompt ever arrives**.

**1. The cause is mode selection, not the worker's decider.** The attempt path only asks the
harness to prompt for `ask`: `internal/worker/agentturn.go:405-416` sets `modeID` for
`"ask"` and falls into `case "", "deny", "preapproved_within_sandbox":` with `modeID = ""`.
`internal/agent/acp/handle.go:200-211` calls `session/set_mode` **only when `ModeID != ""`**, so a
preapproved attempt never leaves `claude-agent-acp`'s shipped default `auto` —
`internal/agent/acp/launchers.go:60-65`: "adapter default mode auto never sends
`session/request_permission`" (`docs/compatibility/ACP.md:35,45,50`). `permissionBridge`
(`internal/worker/agentturn.go:1053-1097`) and
`PermissionPolicyFor("preapproved_within_sandbox")` → `allow_once`,
`decided_by='node_policy:preapproved_within_sandbox'` (`internal/store/postgres/agentturn_seams.go:464-474`)
are correct and simply never invoked. Lab check:
`select type,count(*) from domain_events where type like 'conversation.permission%' group by 1;` →
**(0 rows)**; `select count(*) from permission_requests;` → **0**; `agent.session.connected`
payload keys are `acp_session_id, agent_capabilities, binding_id, conversation_id, launcher_id,
launcher_version, protocol_version, session_origin, worker_id` — no mode is recorded at all.
Nothing else steers it: `acp.LaunchEnv` passes only PATH/HOME/XDG_*/TMPDIR/git identity
(`internal/agent/acp/launchenv.go:154-190`, `internal/worker/agentturn.go:472-498`) and the worker
writes **no** `.claude/settings.json` (repo-wide grep for `settings.json` hits only probe fixtures
and harness-generated transcripts). The harness's own state in the attempt home reads
`"permissionMode":"default"` while our client saw zero prompts — the approval happened inside
Claude Code, invisibly. So the harness *is* auto-allowing: preapproval is delegated to the agent,
which is what `preapproved_within_sandbox` says, but silently.

**2. `conversation.tool.call` records no permission answer.** Keys observed
(`internal/events/events.go:479-488`): `conversation_id, turn_id, tool_call_id, title, kind,
status, input_preview, truncated`. Lab sample: `execute|Terminal|31`, `edit|Preparing file…|2`,
`edit|Edit|1`. There is no `decided_by`, `allowed_by`, `permission_mode` or `requested` field —
nothing in the journal attributes the call's approval to anything.

**3. An `ask` conversation does ask on the same harness** — prompting is a mode property, not a
path property: `docs/compatibility/ACP.md:90` (worker container, mode `default`): `tool.call →
tool.update → permission.requested` (durable `pending`) → decision → `completed` → **PASS**; and
`docs/compatibility/SANDBOX.md:296-297` in this same lab shows seq 163 `requested` + seq 164
`decided` with a real user id. Attempts under `ask` journal both halves too (this doc's opening).

**4. Smallest fix (proposal only — not implemented).** Give `preapproved_within_sandbox` the same
prompting mode `ask` already uses: in `agentturn.go:414` set `modeID = a.askMode(prof.LauncherID)`
for it (fail closed if the launcher has no verified prompting mode, as `ask` does). The harness
then prompts, and the existing bridge + `PermissionPolicyFor` journal `requested` + `decided
{decided_by:'node_policy:preapproved_within_sandbox'}` with **no new event type and no new
payload field** — the two types and `decided_by` already ship and are already exercised by the
`ask` path, so this needs no API ADR, only a lab row (a `session/set_mode` round-trip per call)
amending ADR-0036's condition (a). Alternative — stamping `tool.call` with the attempt's policy and
`not_requested` — is the cheaper runtime but is a **public event payload change** (`api/openapi.yaml`,
`internal/events`), so it needs an ADR, and it journals an absence instead of a decision. Both keep
the `auto`-mode caveat: with `default` mode Claude prompts per edit/bash, so attempt latency rises.

**Implemented and measured (2026-10-16).** The proposal above was implemented in `a0fd9e7` (attempts) and
`1b93069` (conversation turns) — both policies now request the launcher's verified prompting mode and fail
closed without one — and measured in pass 27 (`live27/`, lab `1b93069`): **C1+C2 127 PASS / 0 FAIL / 0 GAP**
(`live27/C1,C2.out:280`), with the lab journal after the pass reading `conversation.permission.requested`
**23**, `conversation.permission.decided` **23** (every row `status=decided`,
`decided_by=node_policy:preapproved_within_sandbox`) against **31** `conversation.tool.call` rows — the
`(0 rows)` read of section 1 is dead while its diagnosis is exactly what shipped (it named
`agentturn.go:414` as the change point and both commits make that change). The finding that grew out of
the same fall-through — **`deny` was unenforced**, because `deny` also reached `auto` and let every tool
through — is fixed by the same two commits: `deny` now prompts and is answered by policy instead of by the
harness's silent default. Whether the mode becomes a product default is a separate owner decision;
ADR-0036 stays lab-only (see its 2026-10-16 addendum), and driver check C1j (`7e6eda3`) asserts the
requested/decided pairing from the live side — first run pass 28, pending.

**Correction (2026-10-17, passes 28–30).** The 23/23 rows above are **attempt** rows (request ids
`attempt-…-permission-N`): C1j crashed its first run at pass 28 on a bug in its own query
(`live28/C1.out:84`, fixed in `c11d01f`) and measures PASS at pass 29 (`live29/C1.out:97-:100`: 8
requested / 8 decided, every one `decided_by=node_policy:preapproved_within_sandbox`, no orphans) —
attempt-path evidence. On the **conversation** path `1b93069` had turned `deny` into `ask` (a live deny
prompt waited for a human and closed `expired`); `c1c7c19` opens then immediately closes deny
conversation prompts `cancelled` by policy — enforced live at pass 30 (`live30/deny_probe.out`: 1
requested / 1 decided (cancelled) / 0 allow / 0 preapproved, `deny-probe.txt` in no workspace) — and
returns preapproved conversations to the harness's `auto` mode, where no per-call verdict is journalled.
The open follow-up: giving the conversation path policy verdicts needs a decider column on
`permission_requests` (its `decided_by` is a user uuid) plus an ADR.


