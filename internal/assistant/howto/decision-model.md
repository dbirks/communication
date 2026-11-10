# Set up the decision model

The decision model is the judge behind the assistant's default trust level,
*Ask when it looks risky*. It sees one tool call at a time and answers
`allow` or `ask`; anything it flags waits for you on a confirm card.

Configure it on the `serve` process (restart to apply):

- `COMMUNICATION_DECISION_BASE_URL` — an OpenAI-compatible server root.
- `COMMUNICATION_DECISION_API_KEY` — or `COMMUNICATION_DECISION_API_KEY_FILE`.
- `COMMUNICATION_DECISION_MODEL` — the model id to send.
- `COMMUNICATION_DECISION_TIMEOUT` — per-decision deadline, default `4s`.

It counts as configured when the base URL **and** the model are set. Without
it the fixed tool table decides instead, which asks *more*, never less, so
leaving it unset is safe. A judge that is slow, down or malformed is treated
as down: the change waits for you, and reads still run.

Approving a gate and granting an agent permission always ask, whatever the
judge says. Your own level is **Settings → Assistant**. `system.status`
(and the setup checklist on a fresh thread) reports whether a judge is
configured; every judged call shows what it did.
