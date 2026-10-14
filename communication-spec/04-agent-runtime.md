# 04 — Agent Runtime, ACP and APM

## Responsibilities

Communication is an ACP **client** that owns the subprocess environment, prompts, permission UX, cancellation, and durable event capture. The ACP agent owns its own native session implementation. Do not equate its session with Communication's persisted conversation record.

## ACP protocol baseline

- Start against **documented v1 behavior**; v2 is a draft and should be behind explicit adapter/feature flags.
- JSON-RPC 2.0 over declared transport; stdio first. `initialize` capability negotiation, optional authentication, `session/new`, optional `session/load` in v1, `session/prompt` plus streamed `session/update`, `session/cancel`, permission requests; v2 session resume semantics are different. See official sources in research notes.
- Browser never talks directly to ACP subprocess. Worker translates protocol events into canonical `ConversationEvent` and can serve raw debug protocol capture only to authorized operators, subject to redaction.
- Implement `Client` methods for permission resolution, optional files/terminal hooks if negotiated, and structured elicitation where negotiated. Capability matrix is specific to launcher and version.
- Retain raw-ish protocol content for diagnosis only when allowed by privacy policy; normalized event history is durable primary record. Tool call IDs and update order must be stable and deduplicated.
- Stop reasons, streaming chunks, tool calls, plan updates, rate/usage signals where available map to typed events. Unknown extensions remain opaque and do not crash the client.

## Agent launcher registry

Registry entry: `id`, display name, executable + argv (no shell expansion), supported platform, ACP protocol version(s), process env policy, per-harness auth requirements, APM target, known limitations, health-check procedure, compatibility test status.

Examples **not guaranteed launch commands** until verified by probe: Codex ACP adapter, Claude Code ACP adapter, Gemini ACP. A launcher may call an npm/npx command pinned to an exact version; `npx latest` at runtime is prohibited in reproducible worker profiles. Verify availability and licensing/subscription support as part of the compatibility lab.

Credential source should be **organization-managed and terms-compliant** (API key, supported token, or correctly provisioned harness login). Don't assume personal interactive CLI subscriptions permit multi-user shared service usage. Auth must be distinguishable from application OIDC.

## Profile → environment → instance

**AgentProfileRevision** contains `launcher_ref`, `apm_package_ref`, `apm_lock_digest`, `system_instructions`, `model_preference`, `workspace_mode`, `sandbox_policy_ref`, `secret_refs`, `limits`, `permission_mode`, `resume_mode`, `failure_fallback`. Distinguish `harness_default`, `managed`, and `managed+overrides` modes.

The worker creates a prepared staging directory to install/compile APM **before** agent launch, pins dependency versions, targets the selected harness, and records manifest/lock digest. Generated skills/MCP/config files must be visible to the agent as required by that harness. APM preparation is **not itself isolation**, and target-native config semantics are not uniform.

Avoid modifying shared user home or source repo by default. Some harnesses can read only config from standard user/repo paths: probe for compatibility; if necessary, copy generated files into the **per-run checkout** with explicit cleanup and exclusion or isolated HOME. Do not promise strong per-session APM isolation until tested per launcher.

### Session reuse semantics

`new`: launch fresh agent/session on current workspace; pass goal and prior evidence.

`resume_if_supported`: if compatible version/cwd/session ID and agent advertises `loadSession` (v1) or appropriate v2 capability, attempt restore; on failure follow explicit `fallback: new | fail` policy.

`continue_live`: loop targets still-connected ACP session; one exclusive controller at a time; feedback prompt sent only after prior turn ends.

A completed pipeline node may leave conversation `idle` and **release to a human**, even after the originating run finishes; reattachment creates a new agent instance/binding if old process exited.

## Permission policy

Configurable per profile: `ask`, `preapproved_within_sandbox`, `deny` (also configurable by tool/action). Agent can be given broad freedom inside a constrained sandbox, but **auto-approving ACP prompts is not a substitute for sandbox isolation**. Permission requests create events and durable prompts to authorized users; no hanging forever without deadline/fallback.

## Go library adoption

Candidate: `github.com/coder/acp-go-sdk` for typed Go ACP, but evaluate current schema version alignment, streaming cancellation, and helper lifecycle in `M0 ACP compatibility spike`; avoid committing to specific library APIs in persisted domain schemas. Prefer SDK over reimplementing JSON-RPC and maintain an `AgentRuntime` interface.

## Agent compatibility lab

Test each candidate with real harness and disposable repo:

1. Installed launch and authentication preflight (non-interactive scenario where possible).
2. `initialize` and capability matrix; v1/v2 negotiation.
3. New session; prompt; token/tool/permission streaming; terminate.
4. Two consecutive prompt turns; cancellation during tool call.
5. Session reload/resume after process restart, with same and different workspace paths.
6. Read/write behavior in multi-repository checkout; optional additional directories.
7. APM package prepare with two different skills/MCP sets; isolation between sessions.
8. Restart with interrupted output; malformed ACP data and broken pipes.
9. Sandbox and credential operation; verify no secret leak in normalized events.

Publish a generated matrix (`docs/compatibility/ACP.md`) per adapter version. An agent may be `launchable`, `streaming`, `resumable`, `permission-capable`, etc. Never claim universal support on the basis of ACP branding alone.
