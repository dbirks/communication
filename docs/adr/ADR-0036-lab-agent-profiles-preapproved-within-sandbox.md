# ADR-0036 — The M4 lab's seeded agent profiles run `preapproved_within_sandbox`; the product's seeds stay `ask`

- **Date:** 2026-10-18 · **Status:** Accepted · **Owners:** M4 lab operator; worker runtime maintainer
- **Related:** ADR-0016 § 10 (flipping a seed is a lab result, not a config change), ADR-0019 D3/D6,
  ADR-0035 (egress allowlist, amends D-021), `04-agent-runtime.md` § "Permission policy", option 2 of
  `docs/design/attempt-permissions.md`, both lab sections of `docs/compatibility/SANDBOX.md`.

## Context

Under `ask` an unattended attempt prompt is answered `node_policy:ask_unattended` and its tool call
fails, so no `agent.acp` node completes a real run. ADR-0016 § 10 left `preapproved_within_sandbox`
unused pending lab evidence; the 2026-10-16 evaluation refused it on two conditions, and the second —
per-launcher network enforcement — is now observed.

## Options considered
| Option | Advantages | Disadvantages | Evidence |
|---|---|---|---|
| Lab seeds stay `ask` | no change | every `agent.acp` node dies on its first tool call | SANDBOX.md row 10 vs the `ask` control (seq 163/164) |
| **Lab seeds only** → preapproved | unattended turns complete; the sandbox, not a human, is the boundary | zero `conversation.permission.*` rows: no journalled verdict | rows 1/2/3/6/7 (in-grant ok; `/etc/shadow` and outside-grant read/write → `EACCES`), 8a/8b (`api.anthropic.com` allowed; `example.com` denied with a `host_denied` audit row), 8-sufficiency (two real claude-agent-acp turns `completed`/`end_turn` on the default list) |
| Flip the product seeds too | one setting everywhere | ships silent auto-approval on one launcher's evidence | migration 00003 seeds `Claude Code`/`Codex` at `ask` |

## Decision

`docs/compatibility/probes/m4/seed.sh` seeds **`m4-planner`, `m4-implementer`, `m4-reviewer` only**
with `permission_mode='preapproved_within_sandbox'` (launcher `claude`, `sandbox_enforcement=required`).
That file is the whole scope: migration 00003's `"Claude Code"`/`"Codex"`, the profile write API (which
still journals `agent.profile.created` as `ask`) and every deployment stay `ask`. Consequence: a
preapproved transcript claims no approval at all, so `ask` stays the honest setting for attended
conversations, and `process.exec` for deterministic steps (`docs/design/attempt-permissions.md` 1).

## Security/privacy — conditions that keep this valid

Revert when any holds: ADR-0035's agent egress allowlist is off (`COMMUNICATION_AGENT_EGRESS_ALLOW=open`
removes the evidence); enforcement is not `required`; the launcher is not `claude`, the only one
evaluated; or a lab row shows an outside-grant read or write allowed. Condition (a) of 2026-10-16 — a
journalled verdict for a policy decision — stays **open**, which is why this is lab-only; the
credential axis is unproven (an rw `harness_credentials` grant, and an allowed host is allowed for
*content*, ADR-0035). Fail-closed is unchanged: an unverified launch runs no agent (ADR-0019 D6).

## Verification

SANDBOX.md § "preapproved_within_sandbox lab evaluation (2026-10-16)" + § "Egress allowlist lab
evaluation (rows 8a/8b)", profile 3.4.0 on `nono 0.80.0`. Its one FAIL row — conversation turns never
journalling `sandbox.egress_observed` — is closed by this change's worker work (`internal/worker`:
`TestConversationTurnEarnsItsOwnEgressLabel`).

## Migration/rollback

Pass `ask` as the fourth argument at the three call sites in `docs/compatibility/probes/m4/seed.sh`
and re-run it: the upsert re-affirms `permission_mode` in place. No migration, no API change.
