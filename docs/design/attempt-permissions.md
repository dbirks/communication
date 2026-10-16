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
