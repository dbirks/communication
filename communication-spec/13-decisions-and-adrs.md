# 13 — Architecture Decisions, Risks and ADR Governance

## Decision register as of 2026-10-14

| ID | Decision | Status | Why / next step |
|---|---|---|---|
| D-001 | Product is an open-source AI-assisted software team operating environment | Accepted | Factory recipes are organization-owned |
| D-002 | Go binary with `serve`, `worker`, optional `dev` | Accepted | API replicas rollout independently from agent processes |
| D-003 | Postgres authoritative DB; event history durable | Accepted | Multi-replica control plane and recovery |
| D-004 | Project logical boundary with multiple repositories; run workspace is concrete filesystem | Accepted | Avoid repo=project conflation |
| D-005 | Versioned pipelines, project assignments, controlled promotions | Accepted | Experiment safely across projects |
| D-006 | ACP primary coding agent protocol, APM profile packaging | Accepted | Use adapters; test real clients |
| D-007 | Resume conversations outside pipeline, human takeover | Accepted | Collaboration first-class |
| D-008 | Per-run worktree by default; shared writable explicitly optional | Accepted | Avoid agent file races |
| D-009 | Node-boundary checkpoints, honest worker restart | Accepted | No continuous snapshots or magic failover |
| D-010 | OIDC mapping, project-level RBAC, scoped secrets | Accepted | Central company execution |
| D-011 | nono first Linux sandbox prototype, interchangeable provider | Provisional | Validate enforcement and alpha risk; fail closed in required mode |
| D-012 | REST + SSE for initial browser APIs, Postgres transactional outbox | Proposed | Measure high-volume streaming before committing |
| D-013 | CEL subset + JSON Schema + YAML as canonical authorable format | Proposed | Build parser/validation spike; freeze versioned contract |
| D-014 | Artifact store with S3-compatible production backend and dev local fallback | Proposed | Multi-replica access; retention policy |
| D-015 | Initial hosted OIDC provider / exact Go auth library | Spike required | Verify deployment and identity mapping |
| D-016 | ACP Go SDK choice / supported protocol versions | Spike required | Real compatibility test incl. resume |
| D-017 | APM profile layout and preparation staging | Spike required | Harness-native path support varies |
| D-018 | Separate publication/merge pipeline, no hidden auto-merge | Accepted | Org controls quality gates and branch policy |
| D-019 | Node template parameterization / child-pipeline invoke | Accepted | Composable organizational secret sauce |
| D-020 | No default MCP/CLI privileges for ordinary coding agents | Accepted | Future opt-in app tool access |
| D-021 | Strict network egress controls per execution | Provisional | nono capability, proxy options, safe defaults require test |
| D-022 | GitOps import/export no dual mutable truth | Proposed | Validate conflict/merge UX |
| D-023 | Assistant tools share backend authz; publish needs approval | Accepted | User agency and audit |
| D-024 | Object store vs worker-local portable Git checkpoint strategy | Open | First version can retry incomplete nodes; define cross-host guarantees |
| D-025 | Exact Project/organization trust model for separate clients | Open | App RBAC != OS isolation; threat model before production |

## Highest risks and mitigations

**R1—Shared credentials expose other projects:** separate OS/OCI identity and secret mounts by trust boundary; nono defense-in-depth, no production tenant guarantee until pen test/architecture proof. **R2—ACP resume variance:** adapter capability matrix, fallback fresh session with full prior evidence. **R3—Worker lost local changes:** meaningful node checkpoints and explicit portability policy. **R4—External action duplicate:** intent IDs and reconciliation. **R5—Complex graphs become impossible to debug:** versioned scopes, runtime expansion tree and stable event lineage. **R6—APM managed profile config collides with other agents:** staging and harness-specific integration tests. **R7—Unbounded cost:** quota layers, retry bounds and scheduling fairness. **R8—Assistant gains excess power:** app tool authorization + draft/publish separation + approval gates.

## ADR process

Folder: `docs/adr/`. Decisions require ADR when they affect protocol version, persistence schema, security boundary, deployment model, public API contract, licensing, or change-recovery semantics. Small local refactors do not need ADRs. Use identifiers `ADR-0001-...` and status `Proposed → Accepted → Superseded`.

Required template in [`adr/ADR-TEMPLATE.md`](adr/ADR-TEMPLATE.md). Each ADR includes context, decision drivers, alternatives, decision, positive and negative consequences, security considerations, test evidence, migration/rollback plan and external citations. New contradictions with this register require ADR plus explicit register update.
