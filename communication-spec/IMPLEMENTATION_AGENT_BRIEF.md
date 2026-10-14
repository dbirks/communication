# Handoff Prompt — Coding / Architecture Agent

Implement **Communication**, an open-source operating environment for AI-assisted software engineering teams, from the attached architecture package. Treat `README.md` as index. The documents give the target contracts; **do not assume any sample API/YAML is preexisting production behavior**.

## Working rules

1. Begin by reading *all* technical specs, design brief contracts, decision register and research notes. Produce an implementation issue/PR breakdown with critical dependencies and vertical acceptance tests.
2. Start with **M0 research/compatibility spikes**. Validate real ACP and APM behavior and nono sandbox security in test Linux environments before claiming success. Pin versions and document limits. Build SDK adapters, do not reimplement ACP/APM protocols where a tested SDK exists.
3. Maintain `docs/adr/` Architecture Decision Records for consequential decisions. Never silently deviate from an **Accepted** product invariant; propose ADR if reality conflicts with it.
4. Use Go `serve`/`worker` modes, PostgreSQL, immutable published pipeline revisions and durable event log. Frontend consumes typed authenticated APIs; multiple API pods must be possible without moving active stdio processes.
5. Start with reusable domain interfaces: scheduler, agent, sandbox, workspace, secrets, artifacts, integrations. Avoid coupling persisted schema directly to `nono`, SDK structs, YAML library or one ACP provider.
6. Security: per-project authz, OIDC, encrypted scoped credentials, process and workspace restrictions; `required` sandbox mode must fail closed. APM does not sandbox. Treat nono as alpha; never assert secure multi-tenant production isolation solely on nono.
7. Keep user-configurable workflows generic but ergonomic: ACP agent, OpenAI-compatible model call, command, condition, human gate, loop, foreach, parallel, child pipeline, explicit publication. Ship documented sample pipelines.
8. Every run and conversation survives API restart. Do not promise worker-host-failure filesystem restoration without a portable checkpoint. At node boundaries store durable results and checkpoint metadata. Retries and external side effects require fencing/idempotency/reconciliation.
9. Agent profiles can differ per pipeline node. APM target-native files must be staged/isolated per runner insofar as adapter compatibility permits. Record effective config/lock digests.
10. The Communication assistant must use the same permission-checked application tools as the UI; supports typed UI focus/navigation, structured phrase-choice questions and approval before publication or privileged actions. Ordinary coding agents have **no** Communication admin tools by default.
11. Follow design agent's functional UX handoff; keep visual decisions out of core engine. Align schema, API, events and UI states explicitly before parallel coding efforts.
12. Tests as specified in `12-test-strategy.md`; no mocked “green” test as substitute for real protocol/sandbox integration gate. Test code and docs must accompany every PR.

## Delivery sequence

Complete milestones M0–M8 from `11-build-roadmap.md`; each should be demonstrable independently. Track exact supported ACP launchers, APM targets, nono capabilities, deployment constraints and known issues. Add migrations, examples, dev compose and operator guide. Keep an ongoing decision register and ensure all high-risk ADRs are addressed before promising production isolation.

## Definition of done

The end-to-end consulting-team scenario in `12-test-strategy.md` passes in a supported test deployment; two API replicas share durable state; real ACP sessions and APM profile prep work; worker restart recoverability is accurately represented; sample pipelines demonstrate human review/parallelism/loop/PR creation; scoped secrets and sandbox policies are demonstrably enforced in tested environments; assistant can propose and publish authorized draft changes with visible confirmation; docs and compatibility tables match observed behavior.
