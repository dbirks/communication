# 14 — External Research and Integration Notes

**Research snapshot: October 14, 2026.** Sources may evolve. Each vendor/project capability must be revalidated at implementation time and pinned to tested versions in compatibility matrix/ADRs. This is a source map, not a claim of completed lab verification.

## ACP — first-party protocol and Go SDK

- [Official Agent Client Protocol overview (v1)](https://agentclientprotocol.com/protocol/v1/overview) — JSON-RPC, initialize, session/new, v1 optional session/load, session/prompt/update, cancellation, client permissions/file/terminal and elicitation. The official docs label v1 latest and v2 draft as of research.
- [Official ACP v2 draft session setup](https://agentclientprotocol.com/protocol/v2/session-setup) — changed/new resume semantics and additional directory capability negotiation. Treat as draft, not universal.
- [ACP schema/source repository](https://github.com/agentclientprotocol/agent-client-protocol) — normative documents/testing.
- [coder/acp-go-sdk](https://github.com/coder/acp-go-sdk) — candidate Go SDK with client examples and typed protocol; version and schema alignment must be checked before adoption.

**Finding:** Communication maintains a distinct durable conversation and ACP instance binding. `session/load`/`session/resume` cannot be promised for all launchers. Test tool/permission/terminal behavior for each adapter.

## APM — agent package manager

- [Microsoft APM repository](https://github.com/microsoft/apm) — package manager for skills, prompts, instructions, hooks, MCP and agent config; `apm.yml`, `apm.lock.yaml`, multi-harness targets.
- [APM manifest schema working draft](https://github.com/microsoft/apm/blob/main/docs/src/content/docs/reference/manifest-schema.md) — YAML 1.2 manifest and version/target behavior, evolving draft.
- [APM package installation](https://github.com/microsoft/apm/blob/main/docs/src/content/docs/consumer/install-packages.md) — target selection, `--frozen`, lock-based resolution and deployment of harness-native config.
- [APM first package guide](https://github.com/microsoft/apm/blob/main/docs/src/content/docs/getting-started/first-package.md) — project targets and generated layouts.

**Finding:** APM is the preparation/dependency plane and NOT an isolation or ACP control protocol. Project/user config path differences require per-harness staging tests. Do not hardcode APM schema into Communication pipeline schema.

## Linux isolation

- [nono GitHub](https://github.com/nolabs-ai/nono) — process sandbox designed for coding agents; Landlock-based Linux policy; CLI and library bindings.
- [nono security policy](https://github.com/nolabs-ai/nono/blob/main/SECURITY.md) — explicitly no separate kernel boundary, security guarantees still developing; production use not recommended at research date.
- [nono Landlock implementation note](https://github.com/nolabs-ai/nono/blob/main/docs/cli/internals/landlock.mdx) — ABI negotiation and kernel policy basics.
- [Landlock kernel documentation](https://docs.kernel.org/userspace-api/landlock.html) — kernel restricts process and descendants without granting new permissions; may not be enabled on every host.
- [Bubblewrap](https://github.com/containers/bubblewrap) — namespace/mount sandbox toolkit; useful fallback/reference for stronger filesystem namespace arrangements but nested-in-container behavior must be tested.
- [Anthropic sandbox-runtime](https://github.com/anthropic-experimental/sandbox-runtime) — Bubblewrap/Seatbelt policy reference; do not assume it is available or secure in all nested configurations.

**Finding:** Start with nono as explicitly provisional prototype; verify actual enforcement and reject required-mode runs if unsupported. For mutually untrusted client projects, separate outer identities/containers and tighten credential scope. Do not mistake application Project RBAC for Linux isolation.

## Workspaces / persistent state

- [Git worktree docs](https://git-scm.com/docs/git-worktree) — linked worktrees share common repository administration/object state; copying directory alone does not make portable snapshot.
- [PostgreSQL SELECT locking and SKIP LOCKED](https://www.postgresql.org/docs/current/sql-select.html) — skip locked rows helpful for multiple consumers of queue-like tables but offers inconsistent view, not exactly-once side-effect semantics.
- [React Flow / sub-flows](https://reactflow.dev/learn/layouting/sub-flows) — candidate graph UI rendering/editing library; not a workflow execution engine. Check license and accessibility/graph performance during design spike.

**Finding:** DB-driven scheduler/leases/outbox and workspaces are separate concerns. Worker-local disk restarts are recoverable, host-loss recovery needs portable checkpoint design. Running graph must be separately represented from static definition.

## Gas Town — inspiration only

- [Gas Town repository](https://github.com/gastownhall/gastown) — multi-agent workspace manager and Beads work tracking with persistent agent state.
- [Gas Town architecture design](https://github.com/gastownhall/gastown/blob/main/docs/design/architecture.md) — merge queue / **Refinery**: batch candidates, verification gates, bisect on failure.
- [Gas Town patrol details](https://github.com/gastownhall/gastown/blob/main/.claude/commands/patrol.md) — reviewer/merge workflow mechanics.

**Finding:** The user remembered “Refiner”; correct in Gas Town terminology is **Refinery**. Borrow its failure isolation and gates as a pipeline/template inspiration, not copyrighted prompt text or wholesale implementation. Validate license and attribution if copying code/templates; otherwise implement independently.

## To research before final package choices

- OIDC Go middleware and reverse-proxy identity flow; go module maintenance and session security.
- CEL Go evaluation library, JSON Schema validation library, YAML strict parsing and semantic-version migrations.
- `pgx`/database migrations, SQL job/lease patterns, outbox/event SSE design.
- GitHub App permissions and webhook signature/dedupe; idempotent PR creation.
- Actual ACP launchers and organization credential terms/compatibility of Claude Code, Codex, Gemini and Pi.
- Artifact store encryption/retention, HTML iframe sandbox threat model, APM network package supply-chain verification.

## Source-vs-decision rule

Each proposed technology in these documents is either user-accepted, a research-backed candidate, or a spike item. External references describe source capabilities, **not** proof they meet Communication's intended use and security requirements. Implementation agent must write ADRs with reproducible local tests before converting provisional choices into production claims.
