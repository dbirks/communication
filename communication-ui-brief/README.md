# Communication — Architecture & Implementation Package

**Baseline:** 2026-10-14 · **Status:** proposed implementation baseline, not a claim of completed software · **Product working name:** Communication.

Communication is an open-source operating environment for AI-assisted software engineering teams. It is **not** a single prescribed coding methodology: organizations assemble versioned pipelines, shared agent profiles and skills, and project-specific assignments using Communication's execution and collaboration substrate.

## Reading order

1. [`00-product-vision.md`](00-product-vision.md) — goals, personas, boundaries, user journeys.
2. [`01-domain-model.md`](01-domain-model.md) — entities, permissions, state ownership, vocabulary.
3. [`02-system-architecture.md`](02-system-architecture.md) — API/worker topology, persistence, recovery.
4. [`03-pipeline-engine.md`](03-pipeline-engine.md) — nodes, graph semantics, versioning, runtime behavior.
5. [`04-agent-runtime.md`](04-agent-runtime.md) — ACP, APM, profiles, sessions, compatibility.
6. [`05-workspaces-security-secrets.md`](05-workspaces-security-secrets.md) — git, nono, client isolation, `.env` support.
7. [`06-collaboration-identity.md`](06-collaboration-identity.md) — OIDC, authorization, handoff, audit.
8. [`07-config-integrations.md`](07-config-integrations.md) — YAML, GitOps, GitHub, adapters, templates.
9. [`08-assistant.md`](08-assistant.md) — app-operating assistant and structured questions.
10. [`09-api-events-data.md`](09-api-events-data.md) — API resources, state transitions, event envelope, storage tables.
11. [`10-ui-design-handoff.md`](10-ui-design-handoff.md) — separate design agent's functional brief.
12. [`11-build-roadmap.md`](11-build-roadmap.md) — milestones, dependency ordering and acceptance gates.
13. [`12-test-strategy.md`](12-test-strategy.md) — lab, security, failure and end-to-end matrices.
14. [`13-decisions-and-adrs.md`](13-decisions-and-adrs.md) — accepted, provisional, open and ADR policy.
15. [`14-research-notes.md`](14-research-notes.md) — research as of baseline, source links, limitations.
16. [`DESIGN_AGENT_BRIEF.md`](DESIGN_AGENT_BRIEF.md) and [`IMPLEMENTATION_AGENT_BRIEF.md`](IMPLEMENTATION_AGENT_BRIEF.md) — copyable agent handoffs.

Examples in [`examples/`](examples/) and a **provisional** JSON Schema in [`schemas/`](schemas/) illustrate the proposed contracts. They are deliberately labeled draft and must be validated by an implementation spike before freezing.

## Foundational agreements

- **Centralized managed execution:** browsers connect to API replicas; workers run ACP agents and own workspaces. Single Go source/binary supports `serve`, `worker`, and developer convenience `dev` modes.
- **PostgreSQL as authoritative operational store**; API replicas are replaceable. Worker lifetime is decoupled from API pod lifetime.
- **Projects contain one or more repositories**, project members and pipeline assignments; **Run Workspaces** are filesystem materializations assigned to executions.
- **Pipelines** are reusable, immutable once published, and pin individual runs to a specific revision. **Assignments** bind pipelines to projects and triggers.
- **Node result + artifacts + workspace** are separate. A durable Communication conversation is **not** identical to a harness's ACP session.
- **ACP** is the control protocol for coding agents; **APM** packages skill/instruction/MCP contexts; both sit behind adapters.
- **nono** is the **first sandbox prototype**, not a verified high-assurance tenant boundary. Fail closed where isolation is required.
- **Agent prompts, deployment YAML, graph UI and natural-language assistant** all operate against one canonical validated definition.
- **Checkpoint at node boundaries**; no promise of lossless mid-turn recovery or live subprocess migration.
- **Secrets** are scoped and materialized on demand; raw secret values never belong in pipeline definitions or durable events.
- **Curated, runnable example factories** make the open-ended system approachable.

## Status labels used in these documents

- **Accepted**: product/architecture intent explicitly supported in discovery conversation.
- **Proposed**: preferred implementation design to validate through tests/ADR.
- **Spike required**: external compatibility/security claim must be tested before production reliance.
- **Later**: preserve the extension point but do not require full initial implementation.

## Non-goals for initial complete milestone

A multi-cloud execution fabric, hot migration of live ACP processes, an internal issue tracker, automatic self-modifying pipelines, strong cross-client isolation based on nono alone, a full Python pipeline SDK, and fully autonomous merging to protected branches. We still design interfaces so these can be added safely.

## Safety of examples

Illustrative YAML schemas, CLI invocations, and API routes describe a **proposed Communication contract**, not an existing released API. Do not execute example pipelines against production repositories or credentials until sandbox and integration compatibility tests pass.
