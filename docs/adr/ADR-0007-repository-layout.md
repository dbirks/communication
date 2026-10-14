# ADR-0007 — Repository layout: api/, worker/, ui/ within one Go module

- **Date:** 2026-10-14
- **Status:** Proposed (awaiting project-owner sign-off)
- **Owners:** project owner
- **Related decisions / contracts:** D-002, ADR-0001, `communication-spec/02-system-architecture.md`

## Context

D-002 is **Accepted**, as recorded in ADR-0001: one Go program built from one source tree,
with run modes `serve`, `worker` and a convenience `dev` (plus `migrate`, `doctor`), entered
from the single `cmd/communication` entry point, with packages under `internal/…`.
`communication-spec/02-system-architecture.md` § "Go package boundaries — proposal" lists the
frontend as `web/` and names no `api/` or `worker/` directory.

The project owner wants three top-level directories that mirror how the product is actually
worked on — `api/`, `worker/`, `ui/` — with `ui/` replacing the spec's `web/`. Those directories
cannot become additional Go modules or binaries without reopening D-002/ADR-0001, and Go's
`internal/` rule already forbids importing `internal/domain`, `internal/api` or `internal/worker`
across a module boundary. The decision is therefore about **what `api/` and `worker/` contain**
if not Go entry points, and where the embedded UI lives.

## Options considered

| Option | Advantages | Disadvantages | Evidence |
|---|---|---|---|
| **A (recommended).** One Go module at the repo root (`go.mod` at root, module path `github.com/dbirks/communication`); Go code stays exactly where the spec lists it; `api/`, `worker/`, `ui/` hold non-Go-entrypoint assets | Honors D-002 (one source, one binary) and the owner's layout in one move; `go build ./...` / `go test ./...` work from the root; dependency-direction rule is enforced unchanged by `internal/`; contracts and runtime assets get a first-class home | Spec text says `web/`, so an amendment is required; two layout vocabularies ("Go packages" vs "asset directories") must be documented so newcomers do not expect Go code in `api/` | 02 § "Go package boundaries"; 13 D-002 Accepted |
| B. Go module rooted in `api/`, with `cmd/` and `internal/` beneath it | Superficially matches the owner's directory names | Worker code lives under `api/`, which misrepresents ownership and makes `internal/worker` read as an API detail; `go build ./...` from the repo root fails because there is no module at the root | Go module resolution: `./...` walks from the working directory's module only |
| C. `go.work` workspace with separate `api/` and `worker/` modules | Independent module versioning; strict compile-time isolation | Violates D-002's single source/binary intent; `internal/` packages cannot be shared across modules, so domain types, event envelope and authz interfaces must be made public or duplicated; two module graphs to keep in lockstep | Go `internal/` visibility rule; 13 D-002 |
| D. Keep the spec layout (`web/`, no `api/`/`worker/`) | Zero spec drift, zero new conventions | Does not meet the owner's stated preference; contracts and worker runtime assets stay implicit inside `internal/` | 02 as written |

## Decision

Option **A**. One Go module at the repo root; `go.mod` stays at the root with module path
`github.com/dbirks/communication`, and Go code remains in `cmd/communication/` and `internal/…`
exactly as the spec lists them. The three directories hold assets, not Go entry points:

- `ui/` — the Vite + React + TypeScript SPA (replaces the spec's `web/`). It contains one tiny Go
  package, `ui/embed.go` (package `ui`), declaring `//go:embed all:dist` so `serve` and `dev` can
  serve the built SPA from the single binary (00 § "embedded React app"). `ui/dist/` is build
  output and is gitignored; a committed placeholder file keeps `go build ./...` working before the
  UI has ever been built.
- `api/` — the API and event **contracts** shared by both tracks: the OpenAPI document for the
  REST resources in 09 § "HTTP APIs", plus JSON Schemas for the durable event envelope in
  09 § "Durable event envelope", plus the `serve`-mode container/compose fragment. Go request
  handlers stay in `internal/api`.
- `worker/` — `worker`-mode runtime assets: the worker container image definition (harnesses,
  sandbox helper), sandbox policy files, the agent launcher registry YAML, and the worker compose
  fragment. Go worker code stays in `internal/worker`.

Accepting this ADR **requires** amending `communication-spec/02-system-architecture.md`
§ "Go package boundaries — proposal" so that `web/` reads `ui/` and the roles of `api/` and
`worker/` (asset/contract directories, not Go modules) are stated. That amendment is a separate
follow-up task performed **after** sign-off, so the spec is never ahead of the code.

## Consequences

- Positive: single `go build ./...` and `go test ./...` at the root; no `go.work`, no duplicate
  domain types; Docker build contexts can stay at the repo root and share one cache.
- Positive: event/API contracts have one reviewable home, which helps the 09 freeze gate.
- Limitation: contributors must learn that `api/` and `worker/` are not where Go logic goes;
  `CONTRIBUTING` and the spec amendment must say so.
- Operational: because the `ui` Go package embeds `ui/dist`, a UI build must **precede** a release
  build — a GoReleaser `before` hook (`pnpm --dir ui build`) is required, and a stale `dist`
  silently ships a stale UI unless the hook fails loudly.

## Security/privacy

`ui/dist` is public static content — no tokens, no internal endpoints, nothing that must stay
secret; build it from source that assumes anonymity. Contracts in `api/` and policy files in
`worker/` carry no secret values: `SecretRef` indirection only (`secret_id`, `version`, scope,
allowed profiles per 05), so a committed sandbox policy can never leak a credential. Worker assets
must not be mounted into API containers — 02 § "Data / infrastructure plan" requires the worker
volume be on a dedicated volume and "do not mount it into API pods"; `worker/` image and policy
files belong to the worker deployment role only. Sandbox policy files are inputs to a fail-closed
launcher (D-011), so they are reviewed as code, not as configuration.

## Verification

To be proven by tests, not asserted here:

1. `go build ./...` succeeds at the repo root with only the committed placeholder in `ui/dist`
   (no prior UI build).
2. `go list -m -f '{{.Path}}' all` plus `find . -name go.mod -not -path './node_modules/*'`
   report no module other than the root.
3. `communication dev` serves the embedded SPA at `/` and the API on the same origin (ADR-0001
   `dev` mode), and `serve` serves the same bytes from the release binary.
4. CI asserts the release pipeline builds `ui/` before `goreleaser`, and fails if `ui/dist` is
   missing rather than embedding the placeholder.
5. `internal/...` import graph check confirms `domain` still has no SDK types (02 dependency rule).

## Migration/rollback

Rolling back to the spec layout is a rename: `git mv ui web`, update the embed directive path and
the `//go:embed all:dist` package location, and the GoReleaser hook path. `api/` and `worker/`
contents are inert to the Go build, so removing or merging them changes no compiled code and no
runtime behaviour. No data migration, no wire-format change, no DB migration. Superseded by a
future ADR only if D-002 itself is revisited.
