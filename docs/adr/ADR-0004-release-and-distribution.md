# ADR-0004 — GoReleaser, GitHub Actions and ghcr.io for release and distribution

- **Date:** 2026-10-14
- **Status:** Proposed
- **Owners:** project owner
- **Related decisions / contracts:** D-002 (one Go binary with `serve`/`worker`/`dev`/`migrate`/`doctor`),
  D-014 (artifact store with dev local fallback), ADR-0001 (control and execution modes in one Go
  program), `communication-spec/02-system-architecture.md`

## Context

The spec fixes the *shape* of what ships — a single Go binary built from `cmd/communication` with
`serve`, `worker`, `dev`, `migrate` and `doctor` modes, plus a React web UI, PostgreSQL as the
authoritative store — but it does **not** mandate any delivery toolchain. Nothing in
`communication-spec/` requires GoReleaser, GitHub Actions, ghcr.io or Docker Compose.

We still need repeatable answers to four questions before M0 can be demonstrated by anyone other
than the author: how versioned binaries for more than one architecture are produced, how build/test/
lint gate every change, where container images live, and how an evaluator stands the whole stack
(Postgres + API + worker + UI) up in one command. This ADR records the project owner's preferred
toolchain as a **preference**, so contributors do not re-litigate it in passing or assume it is a
spec requirement.

## Options considered

| Option | Advantages | Disadvantages | Evidence |
|---|---|---|---|
| **GoReleaser + GitHub Actions + ghcr.io + `compose.yml` (chosen)** | One config drives archives, checksums, changelog and multi-arch images; ghcr authenticates with the workflow-scoped `GITHUB_TOKEN`, so no extra secret; same pipeline runs on every push/PR | Extra YAML surface that is part of the build contract; GoReleaser and Action refs must be version-pinned; image layers must be checked for secrets | Not yet exercised — the CI workflow run on the first `v*` tag will show whether publish and multi-arch steps work |
| Plain `go build` + hand-written release scripts | Zero third-party tooling, fully transparent, no pinning burden | Re-implements checksums, changelog, cross-compile and registry login by hand; local and CI release paths drift | Compared as the manual baseline; no release artefacts exist in the tree today |
| Docker Hub instead of ghcr.io | Familiar default, no `docker login ghcr.io` step for newcomers | Separate credential and org setup, no native `GITHUB_TOKEN` permission scoping, images separated from source | Owner preference only; the spec names no registry |
| Make/justfile only, no `compose.yml` | Cheapest to write, no container build at all | Every evaluator hand-wires Postgres plus four processes; no portable artefact for the "run the whole stack" demo | `communication dev` is explicitly a convenience mode, not a stack recipe, so it is not a substitute |

## Decision

The project owner chooses the following, as preference rather than spec requirement:

1. **GoReleaser** builds and releases the single Go binary as *the* release artefact, cross-compiled
   for at least `linux/amd64` and `linux/arm64`, with checksums and a generated changelog.
2. **GitHub Actions** runs CI — Go build, Go tests, Go lint, and UI install/lint/typecheck/build —
   on every push and every pull request.
3. **Container images** are published to `ghcr.io/dbirks/communication` on every version tag and on
   every merge to `main` (`main` builds tagged `latest`/`main`, tags built as `vX.Y.Z`).
4. A **`compose.yml` at the repository root** lets a human run the whole stack — PostgreSQL, API,
   worker and UI — with `docker compose up`.

Release tags are semver `vX.Y.Z` and are the only trigger for publishable binaries and images.

## Consequences

Positive: one pipeline produces identical artefacts, multi-arch builds are deterministic, evaluation
is one command, and images share the repository's permission boundary. Limitations:
`.goreleaser.yaml` and the workflow files become build contract and must be version-pinned; arm64 CI
runner strategy is still an open operations question; the release path now has two owners (Go and UI
jobs) that must stay green together. Backwards compatibility: image name and `docker compose up`
behaviour become an informal public contract once advertised, so renames need a deprecation note in
the release changelog.

## Security/privacy

Publish jobs are the only jobs granted `packages: write` on `GITHUB_TOKEN`; all other jobs keep
read-only default permissions. No long-lived PAT is stored — the workflow token is the sole
credential. No secret, token or `.env` file is baked into an image layer: builds copy built
binaries and static UI assets only. Worker and sandbox credentials arrive at run time via env or
secret mounts, never at build time. Fail-closed: a publish job whose permissions are missing or
broader than expected fails rather than falling back to a manual local push.

## Verification

No toolchain run is claimed here; the following tests will prove the assumptions.

- CI workflow run on the first `v*` tag: both architectures produced, checksums verify, changelog rendered.
- `docker compose up` smoke test on a clean machine reaches a healthy `communication doctor` and a UI
  request served through the API.
- Image inspection (`docker history`, layer diff or an image scan job) shows no `.env`, no key
  material and no build cache in any published layer.
- A UI-only pull request shows the lint/typecheck/build job gating independently of the Go jobs.
- An unauthenticated push to `ghcr.io/dbirks/communication` is confirmed rejected.

## Migration/rollback

Rollback is additive. Deleting `.goreleaser.yaml` and the workflow files leaves the manual
`go build ./...` path working, because GoReleaser wraps `go build` rather than replacing it. To move
registries, change the image repository in the publish job and in `compose.yml`, re-tag the current
release once, and keep ghcr images readable for one release cycle. To drop GoReleaser, port its
matrix (arch, ldflags, version stamp) into a release script and keep tag names unchanged so
`compose.yml` and docs need no edit.
