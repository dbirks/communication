# 10 — Functional UI/UX Design Handoff

**Audience:** separate product/design agent. This is not a request to code UI visuals. Design information architecture, interaction architecture, low/high fidelity screens, responsive layouts, states and design tokens; use backend contracts below without inventing engine semantics.

## Product positioning to communicate

“Communication is where a software team runs, supervises, shares, and improves AI-agent software workflows.” Avoid marketing it as merely a node graph editor. Prioritize **work awareness** (“what needs my attention?”), clear agent control and readable execution history.

## Navigation / information architecture (proposal, not visual mandate)

- Organization switcher / account / operational health.
- Projects index: activity, blocked runs, assigned users, repository list, active pipeline assignments, recent artifacts.
- Project detail: `Overview`, `Work/Queue`, `Runs`, `Conversations`, `Repositories`, `Pipelines`, `Artifacts`, `Settings`.
- Pipeline Library: searchable examples, organization-owned pipelines, drafts, stable/beta versions; node-template library, agent profile library.
- Pipeline editor: canvas, node palette, detail inspector, parameters, validations, revision diff, publish/promotion controls.
- Run inspector: definition graph view **vs** expanded runtime execution tree; timeline, attempts, loops, child runs, statuses, artifacts, source revision, human interactions.
- Conversation: messages/tool progress/permissions, participant presence, controller identity, takeover/return-control, workspace/diff, relevant run node.
- Assistant: global context-aware panel with typed action previews, UI focus/highlights, interactive phrase buttons, text follow-ups, approvals, undo drafts.
- Admin/Operations: workers, sandbox health, ACP/APM compatibility, project identities, credentials metadata, audit and rate limits.

## Key user journeys to design completely

**J1 — First-run onboarding:** admin connects OIDC (or approved dev auth), creates Project, adds two repositories, registers a managed Claude/Codex launcher/profile, imports starter pipeline, configures secrets, checks sandbox status, launches first run. Errors and prerequisites should not be hidden.

**J2 — New consultant assigned five projects:** lands on attention dashboard; identifies two stalled runs, one human approval, three conversations; opens relevant client project without finding locally installed skills; takes control of blocked session, prompts, returns control.

**J3 — Pipeline author creates workflow:** selects sample Plan→Approve→Implement→Review; changes agent profiles/inputs, adds a bounded review loop, validates; previews YAML/diff; publishes a new revision; promotes it to one Project only.

**J4 — Natural-language authoring:** user says “Use Gemini as reviewer for the beta of project A”; assistant inspects, navigates to correct canvas, highlights proposed nodes, asks meaningful option question; produces draft diff and rollout preview; user confirms publication.

**J5 — Live complex run:** pipeline definition has six nodes, `ForEach` expands to 25 children and hundreds of attempts. Show compact progress by stage and expandable child run tree. No visually tangled 150-node canvas by default.

**J6 — Permission request / handoff:** active ACP agent asks permission; current authorized controller sees decision with consequence; separate human takes control while factory waits; control returns with evidence.

**J7 — Failure/recovery:** worker disappears; run marks interrupted; user can see surviving checkpoint and what work may need to be repeated; choose retry or stop; don't display spurious “resumed without loss.”

**J8 — Secret settings:** configure secret by reference/masked input and target `.env` destination; show path/permission policy and warnings; never display raw secret in run inspector.

**J9 — Publication:** code review passes; branch/draft PR created as explicit step; PR/status/commit linked; user can identify what remains unmerged.

## Components/UX states to cover

- Pipeline node inspector inputs/outputs/schema bindings (`${{ nodes.plan.outputs.plan }}`), raw/output view, retry/failure routing and resource limits.
- Node templates browser (owner, version, compatibility, example outputs, clone/edit).
- Graph edges and nested scopes: until, foreach, parallel, invoke pipeline, human approvals, conditions, error routes.
- Agent profile settings: default harness, managed APM package, overrides, auth readiness, capabilities, sandbox and secret selection.
- Deployment status: assignment selects exact published revision / stable / beta with explicit preview before changing target Project.
- Workspace widget: repos, base refs, dirty changes, worktree identity, associated conversations, outputs/artifacts; no misleading “git restore” affordance.
- Activity timeline: events correlated by run/node/attempt; search/filter by failure, actor and stage.
- Assistant states: planning, asking, proposing typed tool action, executing, completed, failed, awaiting approval; show history of actions and route-target highlights.
- Empty and error states: no repos, no agent account, nono kernel unavailable, APM target mismatch, disconnected worker, missing portable checkpoint, expired worker lease, missing permission.
- Responsive behavior: desktop graph canvas; on mobile favor status/lists/conversation rather than forcing full graph editing.
- Accessibility: keyboard navigation/focus, screen-reader run hierarchy, transcript streaming rate, statuses never color-only, reduced-motion assistant highlighting.

## Interaction and backend rules the design MUST respect

- UI cannot decide scheduling/branch outcomes independently of server.
- Draft edits are not published until authorized; changing a Project assignment is a distinct action from publishing.
- Human conversation and pipeline-driven ACP conversation share a common presentation, but show controller/ownership clearly.
- Pausing the *pipeline* is different from interrupting an *agent turn* or taking control.
- A project's membership controls visibility; no cross-project data leakage through autocomplete/assistant.
- ACP capabilities vary per agent; buttons disabled/explained when resume/permissions/etc. unsupported.
- Secret values never displayed in transcript/diffs; generated untrusted HTML artifacts open in sandboxed preview, separate origin.
- Long-running assistant actions show meaningful intermediate progress and seek confirmation for privileged operations.

## Requested output from design agent

1. Sitemap, entity-navigation model and rationales.
2. User-flow diagrams J1–J9 and alternate/error paths.
3. Wireframes for project dashboard, conversation, pipeline library, editor, run inspector, assistant and operations.
4. Component inventory + interaction specs with keyboard/accessibility states.
5. Proposed design system (tokens/typography/layout) and responsive behavior.
6. Exact frontend/backend data dependencies for each screen/action and event subscriptions.
7. A small clickable prototype or annotated flows illustrating assistant “navigate, edit, ask question, apply” behavior.
8. UX acceptance checklist tied to the realistic consulting-team scenario.

## Independence boundary

The designer owns layout, branding, copy, progressive disclosure and navigation choices. The engineer owns state machines, protocol negotiation, sandbox policy, API auth, scheduling and durable storage. Design conflicts should be documented and resolved through a contract review, not silently worked around in frontend code.
