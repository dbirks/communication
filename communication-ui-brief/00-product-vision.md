# 00 — Product Definition & Product Requirements

## Vision

Communication is a self-hostable, open-source **operating environment for AI-assisted software engineering teams**. It helps organizations codify their development philosophy, run agent-powered work with human oversight, share live context, and improve reusable processes based on execution evidence.

### Product principles

1. **Organizations own the recipes.** Do not prescribe a planning methodology, issue tracker, judge, vendor or merge process.
2. **Batteries included, not hard-coded.** Ship curated example pipelines for onboarding, feature implementation, bug fixing and dependency upgrades; each can be copied and edited.
3. **Conversation-first access; pipeline-powered work.** A user can start a one-off ACP conversation without creating a pipeline, or build recurring workflows and monitor many runs.
4. **Human and automation cooperate.** Inspect, pause, take control, correct, approve, return to automation, audit.
5. **Durability is honest.** User-visible progress and event history survive API restarts. Active agent process and uncheckpointed edits do not automatically migrate between hosts.
6. **Extensible by configuration.** Agent profiles, APM packages, node templates and reusable child pipelines should be authorable without rebuilding Go.
7. **Least authority.** Project authorization, scoped credentials and run sandbox limits; integration and assistant actions are permission checked.
8. **Open source interoperability.** Prefer mature protocols/SDKs (ACP, APM, OIDC, Git, OCI, JSON Schema) over proprietary replications; maintain adapter boundaries.

## Users / journeys

- **Factory maintainer** maintains agent launchers, APM packages, node templates, sandbox policies, pipeline revisions, limits; tests beta pipeline against one project before promotion.
- **Consultant / developer** oversees several projects, watches implementation/review runs, takes over a blocked agent conversation, returns control, files follow-up work.
- **Project lead** supplies broad planning input (text, uploaded document, speech transcript), initiates planning pipeline, reviews a draft spec, chooses task publication behavior.
- **Operator** manages broken workers, reclaims interrupted steps, investigates failed external actions, rotates credentials, verifies sandbox enforcement.
- **Personal user** runs the same software in a small environment, starts ad hoc conversations, schedules dependency-maintenance pipelines on own repositories.

## Illustrative lifecycle

1. Organization installs Communication and configures OIDC plus organization-managed agent credentials.
2. Operator creates a **Project** with frontend/backend repositories, authorized users, project secrets and workspace policy.
3. Factory maintainer chooses a sample `Feature Delivery` pipeline, copies it into a draft, assigns agent profiles/skills, tests, publishes revision `r1`.
4. Project assignment binds `r1` to manual starts, a schedule, or a GitHub issue filter, using project-specific inputs and concurrency.
5. A run begins with a multi-repo Run Workspace; planner produces a Markdown spec and structured `plan` output; human approves.
6. A `ForEach`/`InvokePipeline` step fans out implementation tasks with bounded concurrency. Each child run is independently inspectable/retriable.
7. Implementers modify isolated worktrees. Command checks and Codex/other review agents evaluate results; failures loop with feedback to the implementer.
8. A configurable publication stage commits/branches/pushes/opens PRs or merely leaves artifacts. Merge conflict work is its **own** reviewable pipeline (see Gas Town Refinery research).
9. User reviews live conversation, takes control, sends prompt, returns control; the run resumes under the published revision with a recorded intervention.
10. Factory maintainer asks Communication assistant to compare beta/stable performance and propose a **draft revision**. The assistant demonstrates edits in the UI; a human publishes/promotes it.

## Functional requirements (F = must for full v1 target, P = progressive)

| ID | Requirement | Priority |
|---|---|---|
| F-01 | Single trusted API control-plane server with multiple replicas behind a load balancer | F |
| F-02 | Long-lived Go worker mode that launches locally authenticated ACP agent subprocesses | F |
| F-03 | Project model with multiple repositories and project-scoped users/secrets/runs | F |
| F-04 | OIDC login and application RBAC with auditable authorization checks | F |
| F-05 | Human and pipeline-created durable conversations with ACP event streaming/history | F |
| F-06 | Take-control/return-control and explicit pause/cancel semantics | F |
| F-07 | Versioned pipeline graph, input schemas, node templates, failure routes, and child pipelines | F |
| F-08 | Manual runs, scheduled triggers, webhook/poll adapter foundation, bounded concurrency | F |
| F-09 | Agent node with ACP launcher and optional APM profile; command/LLM/condition/human gates | F |
| F-10 | Worktrees, per-run isolated writable workspaces, multi-repo layout | F |
| F-11 | PostgreSQL durable state, append-only operational event journal, artifact store | F |
| F-12 | Secrets injection including temporary `.env` generation, scoped use and cleanup | F |
| F-13 | Sandbox adapter with nono prototype, capability diagnostics and required-isolation failure | F |
| F-14 | Natural-language app assistant with typed tools, UI navigation and user-choice questions | F |
| F-15 | Example workflow gallery; clone/edit/validate/run; visual definition/live-run views | F |
| F-16 | YAML import/export and optional Git-backed workflow deployment | F |
| P-01 | First-party GitHub Issues/PR adapter with webhook/polling and idempotency | P (early) |
| P-02 | Object-store-backed cross-host workspace checkpoint recovery | P (later) |
| P-03 | Distributed Kubernetes pod workers and autoscaling | P (later) |
| P-04 | Communication MCP server/CLI made available to arbitrary agents | P (later; opt-in) |
| P-05 | Dynamic self-rewriting of an active pipeline | Explicitly not required |
| P-06 | Full visual analytics / pipeline A/B experiment suite | P (later) |

## Nonfunctional requirements

- Auditable, deterministic schedule choices; exactly one **current owner** for node attempt, not exactly-once external side effects.
- Capability-aware ACP integration (without uniform-resume assumptions); worker registration and heartbeat.
- No secrets or raw provider credentials in UI logs, events, config exports, or sample fixtures.
- Avoid a dependency on Kubernetes to run local development or a single-worker deployment.
- New setup: dev convenience mode starts Postgres (via compose), API, worker and embedded React app; production permits multiple independent API replicas.
- All consequential design choices documented as ADRs; compat/security smoke tests run against real providers in a controlled environment.

## Explicit design trade-offs

- No internal replacement for GitHub Issues/Beads/Linear: work item adapters expose external identity while Communication tracks **execution**.
- A completed agent session is not equivalent to feature delivered: success criteria and **publication** are configurable steps.
- Graphs are an authoring/execution view, not the sole navigation metaphor. Users also work from projects, conversations, run timelines and a backlog.
