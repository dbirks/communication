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
