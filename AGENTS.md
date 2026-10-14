# AGENTS.md — rules for coding agents working in this repository

## What this repository is

Communication is an open-source operating environment for AI-assisted software
engineering teams: a Go control plane (`serve`), a Go execution worker
(`worker`) that drives coding agents over ACP, PostgreSQL as the authoritative
operational store, and a React web UI. Browsers connect to replaceable API
replicas while workers own workspaces and agent processes. Projects contain
repositories, members and pipeline assignments; pipelines are immutable once
published and each run pins a specific revision. ACP is the control protocol
for coding agents and APM packages skill/instruction/MCP contexts, both behind
adapters; nono is the first sandbox prototype, not a verified tenant boundary.
No application code exists yet — the specification in `communication-spec/` is
the only authority.

## Read the spec first

1. `communication-spec/00-product-vision.md` — goals, personas, boundaries, user journeys.
2. `communication-spec/01-domain-model.md` — entities, permissions, state ownership, vocabulary.
3. `communication-spec/02-system-architecture.md` — API/worker topology, persistence, recovery.
4. `communication-spec/03-pipeline-engine.md` — nodes, graph semantics, versioning, runtime behavior.
5. `communication-spec/04-agent-runtime.md` — ACP, APM, profiles, sessions, compatibility.
6. `communication-spec/05-workspaces-security-secrets.md` — git, nono, client isolation, `.env` support.
7. `communication-spec/06-collaboration-identity.md` — OIDC, authorization, handoff, audit.
8. `communication-spec/07-config-integrations.md` — YAML, GitOps, GitHub, adapters, templates.
9. `communication-spec/08-assistant.md` — app-operating assistant and structured questions.
10. `communication-spec/09-api-events-data.md` — API resources, state transitions, event envelope, storage tables.
11. `communication-spec/10-ui-design-handoff.md` — separate design agent's functional brief.
12. `communication-spec/11-build-roadmap.md` — milestones, dependency ordering and acceptance gates.
13. `communication-spec/12-test-strategy.md` — lab, security, failure and end-to-end matrices.
14. `communication-spec/13-decisions-and-adrs.md` — accepted, provisional, open and ADR policy.
15. `communication-spec/14-research-notes.md` — research as of baseline, source links, limitations.
16. `communication-spec/DESIGN_AGENT_BRIEF.md` and `communication-spec/IMPLEMENTATION_AGENT_BRIEF.md` — copyable agent handoffs.

The numbered files in `communication-spec/` are canonical.
`COMMUNICATION_MASTER_SPEC.md` is a consolidated read-only copy for searching.
`communication-ui-brief/` is a byte-identical duplicate that must never be
treated as authority or edited.

Status labels: **Accepted** — never deviate without an ADR; **Proposed** —
preferred design to validate through tests/ADR; **Spike required** — must be
proven by a real test before anything depends on it; **Later** — preserve the
extension point, do not build it yet.

## Repository layout

```
cmd/communication/          single Go binary; modes: serve, worker, dev, migrate, doctor
internal/
  domain/                   entities, state machines, no SDK types
  authz/                    per-project authorization
  pipelines/schema/         canonical validation
  pipelines/compiler/       DAG/scope compilation
  pipelines/runtime/        node execution semantics
  scheduler/                fenced claims, leases
  worker/                   execution worker loop
  agent/acp/                ACP adapters
  agent/apm/                APM packaging adapters
  sandbox/                  nono and other sandbox adapters
  workspace/git/            worktrees, checkpoints
  secrets/                  scoped materialization
  integrations/             GitHub and other adapters
  events/                   durable event log
  api/                      HTTP/typed API
  assistant/                app-operating assistant
  artifacts/                artifact store
api/                        role pending ADR in docs/adr/ (single Go module per D-002)
worker/                     role pending ADR in docs/adr/ (single Go module per D-002)
ui/                         role pending ADR in docs/adr/ (single Go module per D-002)
docs/adr/                   Architecture Decision Records
docs/compatibility/         ACP/APM/sandbox matrices
communication-spec/         specification (read-only)
```

Dependency rule: `internal/domain` and public interfaces contain no runtime
SDK types; adapters depend on those interfaces, never the reverse.

## Build, test and lint

```bash
go build ./...                          # compile all Go packages
go test ./...                           # run Go unit tests
go vet ./...                            # static analysis
pnpm --dir ui install --frozen-lockfile # install UI dependencies
pnpm --dir ui build                     # build the React UI
pnpm --dir ui test                      # run UI tests
pnpm --dir ui exec oxlint               # lint UI
pnpm --dir ui exec oxfmt --check        # format check UI
pnpm --dir ui exec tsc --noEmit         # typecheck UI
docker compose up --build               # full local stack (control plane + worker + Postgres)
```

Commands for a module that does not exist yet are expected to fail; say so in
your report rather than inventing output.

## Verification

"Done" means proven running, as defined in
`communication-spec/12-test-strategy.md`. The six test layers are: unit,
property/fuzz, integration, contract, E2E, and operational/security.

A mocked green test never substitutes for a real protocol or sandbox
integration test. The protocol compatibility table must never be prefilled
with PASS — every row needs observed evidence.

For UI work, drive the browser with `pnpm dlx @playwright/cli` (open, snapshot,
screenshot, console). Screenshots land in `.playwright-cli/`, which is
gitignored.

## Forbidden

- No `git add/commit/push/checkout/reset/stash/clean` — the orchestrator commits.
- Never edit files outside your brief's Boundaries.
- Never edit `communication-spec/`, `COMMUNICATION_MASTER_SPEC.md` or
  `communication-ui-brief/` unless your brief names the file.
- No new dependencies without flagging them.
- No secrets, `.env` files, tokens or credentials in code, fixtures, tests or logs.
- Never commit `*.zip`, browser screenshots or build output.
- Never install Landlock/sandbox restrictions in the main Go process — sandbox
  only child processes.
- Never claim a capability (ACP support, sandbox enforcement, APM isolation)
  without a real test showing it.

## Report contract

The agent's final message must use this exact block:

```
STATUS: done|blocked|failed
FILES: <every file created or modified>
VERIFIED: <command> + <literal output>
DEVIATIONS: <differences from the brief, or "none">
NEXT: <one line>
```

Not verified with literal output = not done. Keep the report under ~200 words.

## Decisions

ADRs live in `docs/adr/`; the seed ADRs ADR-0001..0003 live in
`communication-spec/adr/`; use `communication-spec/adr/ADR-TEMPLATE.md`.
Any change to protocol version, persistence schema, security boundary,
deployment model, public API, licensing or recovery semantics needs an ADR
(see `communication-spec/13-decisions-and-adrs.md`).
