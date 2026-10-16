# Architecture Decision Records

ADRs record decisions that change a protocol version, persistence schema, security boundary,
deployment model, public API contract, licensing or change-recovery semantics; small local refactors
do not need one. The process is defined in
[`communication-spec/13-decisions-and-adrs.md`](../../communication-spec/13-decisions-and-adrs.md)
("ADR process"): identifiers are `ADR-NNNN-<slug>.md`, statuses move
**Proposed → Accepted → Superseded**, and the required section layout comes from
[`communication-spec/adr/ADR-TEMPLATE.md`](../../communication-spec/adr/ADR-TEMPLATE.md). A new
contradiction with the decision register (D-001…D-0xx) requires both an ADR and an explicit register
update. The spec's own seed records (ADR-0001…ADR-0003) live in `communication-spec/adr/`; records
written by implementers live in this directory and start at ADR-0004.

Where an ADR below records a toolchain choice that the spec does not mandate, it is the **project
owner's preference** and is deliberately left at `Proposed` until the verification section has been
exercised — an ADR is not Accepted on the strength of a written intention.

## Index

| ID | Title | Status | Location |
|---|---|---|---|
| ADR-0001 | Separate control and execution modes in one Go program | Accepted (architecture intent, implementation unverified) | [`../../communication-spec/adr/ADR-0001-control-and-worker-modes.md`](../../communication-spec/adr/ADR-0001-control-and-worker-modes.md) |
| ADR-0002 | Published pipeline definitions are immutable and run-pinned | Accepted (architecture intent) | [`../../communication-spec/adr/ADR-0002-pipeline-revisions.md`](../../communication-spec/adr/ADR-0002-pipeline-revisions.md) |
| ADR-0003 | Prototype nono behind a fail-closed sandbox adapter | Proposed; acceptance requires M0 security testing | [`../../communication-spec/adr/ADR-0003-sandbox-prototype.md`](../../communication-spec/adr/ADR-0003-sandbox-prototype.md) |
| ADR-0004 | GoReleaser, GitHub Actions and ghcr.io for release and distribution | Proposed | [`ADR-0004-release-and-distribution.md`](ADR-0004-release-and-distribution.md) |
| ADR-0005 | Frontend toolchain: Vite + React + TypeScript, Tailwind, pnpm, oxlint/oxfmt | Proposed | [`ADR-0005-frontend-toolchain.md`](ADR-0005-frontend-toolchain.md) |
| ADR-0006 | Browser verification of UI work with Playwright | Proposed | [`ADR-0006-browser-verification-playwright.md`](ADR-0006-browser-verification-playwright.md) |
| ADR-0007 | Repository layout: `api/`, `worker/`, `ui/` within one Go module | Accepted | [`ADR-0007-repository-layout.md`](ADR-0007-repository-layout.md) |
| ADR-0008 | APM profile staging: pinned CLI, per-run checkout, isolated HOME | Proposed | [`ADR-0008-apm-profile-staging.md`](ADR-0008-apm-profile-staging.md) |
| ADR-0009 | nono `required` mode is verify-then-run, never policy delegation | Proposed | [`ADR-0009-nono-required-mode-verification.md`](ADR-0009-nono-required-mode-verification.md) |
| ADR-0010 | Worker-managed mirrors are per-project; runs get linked worktrees | Proposed | [`ADR-0010-workspace-mirrors-and-worktrees.md`](ADR-0010-workspace-mirrors-and-worktrees.md) |
| ADR-0011 | License: Apache-2.0 | Accepted | [`ADR-0011-license-apache-2.md`](ADR-0011-license-apache-2.md) |
| ADR-0012 | Dev identity (OIDC + PKCE, mock IdP) and Postgres-backed sessions | Accepted (dev scope) | [`ADR-0012-dev-identity-and-sessions.md`](ADR-0012-dev-identity-and-sessions.md) |
| ADR-0013 | PostgreSQL 18, pgx, goose forward-only migrations | Accepted | [`ADR-0013-postgres-persistence-and-migrations.md`](ADR-0013-postgres-persistence-and-migrations.md) |
| ADR-0014 | HTTP /api/v1, problem+json, SSE event stream conventions | Accepted (M1) | [`ADR-0014-http-api-and-event-stream-conventions.md`](ADR-0014-http-api-and-event-stream-conventions.md) |
| ADR-0015 | ACP Go SDK: coder/acp-go-sdk v0.13.5 | Accepted | [`ADR-0015-acp-go-sdk.md`](ADR-0015-acp-go-sdk.md) |
| ADR-0016 | Conversations, controller lock, turn leases and fencing tokens | Accepted (M2) | [`ADR-0016-conversations-control-and-turn-leases.md`](ADR-0016-conversations-control-and-turn-leases.md) |
| ADR-0017 | Run workspaces: per-project mirrors, per-run worktrees, proven commit grants, worker volume identity | Proposed | [`ADR-0017-run-workspaces-mirrors-worktrees-and-volume-identity.md`](ADR-0017-run-workspaces-mirrors-worktrees-and-volume-identity.md) |
| ADR-0018 | SecretRef: envelope encryption outside the API surface, `.env` materialization | Proposed | [`ADR-0018-secretref-materialization-and-envelope-encryption.md`](ADR-0018-secretref-materialization-and-envelope-encryption.md) |
| ADR-0019 | Launching the agent under nono in `required` mode from inside the worker container | Proposed | [`ADR-0019-agent-launch-under-nono-in-required-mode.md`](ADR-0019-agent-launch-under-nono-in-required-mode.md) |
| ADR-0020 | Artifact store: local backend, S3 contract, sandboxed HTML preview origin | Proposed | [`ADR-0020-artifact-store-and-sandboxed-html-preview.md`](ADR-0020-artifact-store-and-sandboxed-html-preview.md) |
| ADR-0021 | Pipeline v1alpha1: strict schema, canonicalization and revision digests | Proposed; acceptance requires the M4 exit run and the § 9 correction list in the M4 contract | [`ADR-0021-pipeline-schema-canonicalization-and-revision-digests.md`](ADR-0021-pipeline-schema-canonicalization-and-revision-digests.md) |
| ADR-0022 | The CEL binding subset: syntax, allowed roots, and resource limits | Proposed; acceptance requires the M4 exit run, and § 2's `loop` root needs the rename contract § 9.1 row 17 records (cel-go reserves the name) | [`ADR-0022-cel-binding-subset-and-resource-limits.md`](ADR-0022-cel-binding-subset-and-resource-limits.md) |
| ADR-0023 | Pipeline execution model: runs, node executions and attempts on M2's leases | Proposed; acceptance requires the M4 exit run, and § 1's `pipeline_invocations` row needs contract § 9.1 row 20's one-line fix | [`ADR-0023-pipeline-execution-model-runs-node-executions-and-attempts.md`](ADR-0023-pipeline-execution-model-runs-node-executions-and-attempts.md) |
| ADR-0024 | Node kinds: what M4 must ship to pass its exit, and what stays deferred | Proposed; acceptance requires the M4 exit run, and its prose needs contract § 9.1 row 21's nine/seven counts | [`ADR-0024-node-kind-scope-for-m4.md`](ADR-0024-node-kind-scope-for-m4.md) |
| ADR-0025 | Definition graph: dagre compound layout, edges to leaf nodes, HTML nodes over an SVG edge layer | Proposed; the layout rules are exercised by `ui/src/lib/pipeline/layout.test.ts` and a browser pass, and the surface is dev-only until the M4 routes land | [`ADR-0025-definition-graph-layout-and-rendering.md`](ADR-0025-definition-graph-layout-and-rendering.md) |
| ADR-0026 | The command sandbox grants read+exec on the program it launches and its `#!` interpreter | Accepted (implemented in `4fe3f68`; recorded after the fact — a paperwork deviation, not a proposed one) | [`ADR-0026-command-sandbox-read-grant-on-the-launched-program.md`](ADR-0026-command-sandbox-read-grant-on-the-launched-program.md) |
| ADR-0027 | Node config bindings resolve at claim time, in the control plane, not at enqueue time | Accepted (implemented in `3479fd9`; recorded after the fact — a paperwork deviation, not a design one) | [`ADR-0027-node-config-bindings-resolve-at-claim-time.md`](ADR-0027-node-config-bindings-resolve-at-claim-time.md) |
| ADR-0028 | Publish the worker image from CI on main: `ghcr.io/dbirks/communication-worker`, `:main` + `:sha-<7>`, amd64-only | Accepted (the build command is proven locally; the publish path stays unverified until this job first runs on `main`) | [`ADR-0028-publish-the-worker-image.md`](ADR-0028-publish-the-worker-image.md) |

The M3 build contract that ADR-0017…ADR-0020 share — tables, routes, events, worker duties and the
exit test — is [`docs/m3-contract.md`](../m3-contract.md). The M4 build contract that
ADR-0021…ADR-0024 share is [`docs/m4-contract.md`](../m4-contract.md), whose schema/CEL/
canonicalization claims rest on the checked-in spike evidence in
[`docs/compatibility/m4-spike/`](../compatibility/m4-spike/README.md).
