# 06 — Identity, Collaboration and Audit

## Identity architecture

Use OIDC Authorization Code + PKCE through a well-maintained Go/OIDC library. Store internal `user_id` mapped to immutable `(issuer, subject)` identity, not email address as key. Optionally map IdP groups to roles through explicit policy. Initial simple hierarchy: organization admin; project maintainer/contributor/viewer; library publisher; approver. People may be members of multiple Projects; Client is not a role.

API authentication: secure HttpOnly same-site cookie, CSRF protection for browser mutations, strict origin checks for event transports. Worker authenticates as machine/service identity and can access only its assigned secret refs and jobs, never rely on end-user browser tokens for background work.

Authorization MUST be checked at application service boundaries for read/write, WebSocket/SSE subscriptions, artifact downloads, assistant tools, and external integrations. Project-scoped identity claims cannot be trusted just because an ID is present in a URL or node input. Consider row-level security in Postgres as defense-in-depth after query scoping is established.

## Shared conversation model

A conversation is a durable object consisting of human messages, assistant streams, tool calls, approval prompts, event links and annotations. It has exactly one **active controller** while automation/humans can be multiple viewers. The controller is acquired via compare-and-swap against `conversation_control.version` and is owned by `run_attempt`, `user`, or `none`. A second human cannot prompt an actively factory-controlled ACP session until control is explicitly transferred.

**Human takeover sequence**

1. Authorized user selects `Take control`; API checks project membership and active controller.
2. Running factory node enters `waiting_human` at a safe boundary; if needed sends ACP cancellation and waits for turn acknowledgement. Do not send competing prompts to a running turn.
3. Controller changes atomically to user, emits `conversation.control.transferred` with actor, reason, previous owner, target owner.
4. Human prompts, edits workspace (if permitted); Communication appends events to durable conversation and associates workspace changes.
5. `Return to factory` releases user control, records summary/evidence and queues continuation according to declared profile `resume_if_supported | new_with_context | fail`. Agent sees exactly the human change summary and current workspace state.

**Human gate** is different from takeover: it may simply request approval/rejection and release worker resources until the decision arrives. Deadlines and escalations are policies.

## Permission and secrecy

Permission prompts arriving from ACP are surfaced to **authorized current controller** or designated approvers. Default sample workflows may auto-approve agent edits only *within an enforced sandbox*, never universally grant file/network access. Sensitive transcripts and artifacts may be further labeled `internal`, `restricted` or `secret` and filtered from viewers without corresponding access; plain project membership does not imply viewing raw secrets (no raw secret UI ever).

Session shares are internal links under RBAC; do not expose unauthenticated public share URLs by default. Every action is audit logged: attempts to view out-of-scope resources, handoffs, approvals, agent profile changes, secret materializations (reference only), sandbox bypass policy changes, integration token use, releases and pipeline promotions.

## OIDC edge cases

- User removed from project while observing an SSE stream: stream should cease delivery and connection terminate or reauthorize on short-lived window.
- Identity provider unreachable: existing sessions follow configured short-lived grace for read-only views; no new privileged sessions.
- Two people click Take Control simultaneously: exactly one wins CAS; loser sees current owner.
- Admin publishing shared pipeline from assistant: must use identical permissions/approval path as manual UI.
- Worker running with organization-managed credentials cannot be treated as the browser user's personal login; record initiating actor separately from effective execution identity.

## Audit and retention

All significant events append with actor (`human`, `system`, `agent`, `integration`), effective authorization context, correlation IDs and timestamp. Operational events are tamper-evident through permissions + optional chained digests; do not assert cryptographic tamper proof if not implemented. Provide retention/deletion strategy for transcripts, artifacts, client data, credentials, OIDC PII and compliance requests. Allow project administrators to set event redaction/retention within system minimums for security audit.
