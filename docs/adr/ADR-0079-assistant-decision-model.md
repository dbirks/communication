# ADR-0079 — The assistant's "ask when it looks risky" level consults a decision model on every tool call; a fixed always-ask set and the closed class table stay the floor

- **Date:** 2026-11-10
- **Status:** Proposed (the endpoint shape is provisional until the decision model's id and API are confirmed — Assistant handoff §4 "Open")
- **Owners:** assistant maintainers
- **Related decisions / contracts:** ADR-0050 decision 4 (the closed tool-class table and server-side trust gate this extends), ADR-0046 (the stored trust preference), ADR-0034 (the bounded model loop and secret-scanned egress), `docs/design/assistant-handoff/HANDOFF.md` §4 and `CONTRACT.md` §3.

## Context

ADR-0050 gates assistant tool calls with a fixed table: every tool is read, navigate, draft edit or risky, and the trust level decides which classes wait for a confirm. It's predictable, but it's blunt. "Ask for risky" asks before *every* run start, even an obviously routine one, and it can't notice an odd read. The design handoff asks for the middle level to become "Ask when it looks risky": a second, small model looks at each call and says allow or ask, with a one-line reason the person sees.

This moves part of a security-relevant decision (whether an action needs a human) onto a model. So it needs an ADR, and it needs a floor the model can't lower.

## Decision

1. **Where the judge sits.** Only the `ask_risky` level (the default) consults the judge, and only when it is configured (`COMMUNICATION_DECISION_BASE_URL` and `COMMUNICATION_DECISION_MODEL`, key via `COMMUNICATION_DECISION_API_KEY[_FILE]`, timeout `COMMUNICATION_DECISION_TIMEOUT`, default 4s). `ask_all` and `no_ask` behave exactly as ADR-0050 says.
2. **What it sees.** It sees every call, reads included: the tool name, its class, the bounded args (the same bounds as the transcript), the caller's project role, and the page line. It never sees secret values, transcript history or tool results.
3. **What it can do.** It can only answer `allow` or `ask` with a reason. It can't run anything, and authorization stays in the permission-checked services (gating authorizes nothing, as before). An unknown tool is still refused by the closed table before the judge is asked.
4. **The floor.**
   - `approval.decide` and `permission.allow` always ask, whatever the judge says.
   - If the judge is down, slow or malformed, draft edits and risky calls ask. Reads and navigation fall back to the fixed table and run, so the assistant can still look things up.
   - With no judge configured, the fixed table decides as today, and `system.status` / the setup checklist report "No decision model".
5. **Visible reason.** The approval card's "Why it asks" row carries the judge's reason or a server-written one (fixed table, ask_all, always-ask). Each tool call records whether the judge allowed it, asked, or was unavailable.
6. **Provisional wire shape.** An OpenAI-compatible `POST {base}/chat/completions` (temperature 0, fixed system prompt, one JSON user message). The first JSON object of the reply must be `{"decision":"allow"|"ask","reason":"…"}`. Any OpenAI-compatible model can serve it today. When the dedicated decision model (a `/v1/system-one`-style classify call) is confirmed, a second adapter behind the same interface replaces this without touching the gate.

## Consequences

- Routine actions at the default level stop interrupting people when the judge is confident, and odd reads can now ask.
- A judge outage degrades to "asks more", never to "asks less".
- The judge is another egress of tool args. They are already bounded and secret-scanned, and the endpoint is operator-configured like the chat model.
- The "undo" promise is removed from the trust copy. Only draft edits store an inverse, and every other change says it can't be undone.

## Migration / rollback

There's no schema change. Unsetting the decision env vars returns every caller to the ADR-0050 table.
