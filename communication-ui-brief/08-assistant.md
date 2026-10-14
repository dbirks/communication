# 08 — Communication Assistant and Agent-Native Interaction

## Product behavior

Communication's built-in assistant can inspect project/runs/conversations, explain failures, construct draft pipelines, configure node templates and agent profiles, navigate users through UI, and ask structured open-ended questions. It is an **application agent**, not merely a chat pane. Its authority is derived from the authenticated user's permissions and policy approvals.

**Open-ended user choices:** allow `assistant.question` responses composed of explanatory text, meaningful phrase-option buttons, free text, optional file selection, and follow-up. Selecting `Run both reviewers in parallel` becomes that literal semantic answer, not an opaque button index. Questions are persisted as conversation events and remain understandable in history.

### Structured application tools

`project.list`, `project.open`, `pipeline.list`, `pipeline.inspect`, `pipeline.createDraft`, `pipeline.cloneRevision`, `pipeline.addNode`, `pipeline.updateNode`, `pipeline.connect`, `pipeline.validate`, `pipeline.diff`, `pipeline.publish`, `assignment.previewPromotion`, `run.inspect`, `run.pause`, `run.retry`, `conversation.open`, `conversation.takeControl`, `artifact.inspect`, `nodeTemplate.createDraft`, `agentProfile.inspect`, `ui.navigate`, `ui.focus`, `ui.highlight`, `question.ask`, `approval.request`.

Functions above are **proposed domain action names**, not currently implemented API routes. App assistant and human UI must invoke the same permission-checked application services; tools should never manipulate raw Postgres tables. Validation includes project scope, actor authorization, version preconditions, confirmations and auditable mutation records.

### Tool action policy

- Read-only inspection may proceed within user's authorized scope.
- Draft modifications can be applied with real-time visual highlighting and undo/history.
- Publishing, changing project access, starting high-cost runs, changing secrets/security policy, destructive actions or pushing/merging code require explicit confirmation and elevated permission as appropriate.
- Agent must never possess Communication administration tools by default **inside ordinary coding ACP sessions**. An optional future Communication MCP server/CLI may expose project-scoped capabilities to explicitly opted-in agent profiles.
- UI navigation is **presentation** of an already authorized state/API operation, not brittle DOM-click automation.
- Interactive workflow: propose → show diff + relevant consequences → user approves → mutate/publish → audit event; UI should distinguish draft changes from published effective behavior.

### Example interaction

User: “For Project A only, try the Codex reviewer in parallel with Claude and cap each issue at four review loops.”

Assistant: inspects the assignment and current revision, clones draft, updates parallel and until scopes and parameters, renders visualization highlighting changed nodes, asks: **“Do you want this beta used for new issues only, or also replace pending queued invocations?”** with phrase buttons, validates and shows rollout preview. Publishing still requires approval.

### Event protocol to UI

Structured assistant events include `assistant.message.delta`, `assistant.tool.proposed`, `assistant.tool.executing`, `assistant.tool.completed`, `assistant.question`, `assistant.ui.navigate`, `assistant.ui.focus`, `assistant.diff.ready`, `assistant.approval.required` (all correlated to assistant conversation/turn ID). UI handles them as typed commands with safe targets, not arbitrary executable frontend scripts.

### Reasoning / improvement analytics

Assistant may analyze event history from last 30 implementation runs to identify review loops, bottlenecks, flaky tests and high manual intervention. Recommendations should cite internal run/event IDs and separate observed facts from LLM interpretation. It creates drafts, **never autonomously deploys a new workflow** absent explicit policy/user approval.

## Model backing

Use configurable OpenAI-compatible endpoint for direct chat/model calls, or dedicated ACP runtime if selected. Separate application assistant role/credentials from project coding agent profiles. Persist assistant transcript and action trace; redact privileged data. Speech-to-text is a client input modality, not a new assistant backend contract.

## UI design non-negotiables

- Show what agent is changing (node highlight, diff, affected projects) without requiring a fancy cinematic animation.
- One control source for actions (UI and assistant call same API).
- Structured choice prompts may contain user-defined phrase buttons, multi-selection where appropriate and free text.
- Render artifacts (Markdown, HTML preview, images) in a sandboxed viewer with sanitization and restrictive iframe `sandbox`/CSP; never execute untrusted HTML as the app's origin.
- “Who changed this and why?” must be answerable for every assistant mutation.
