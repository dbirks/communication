# ADR-0028 — Publish the worker image from CI on main

- **Date:** 2026-10-16
- **Status:** Accepted
- **Owners:** release/distribution maintainer; home-cluster deployment owner
- **Related decisions / contracts:** ADR-0004 (GoReleaser + GitHub Actions + ghcr.io),
  ADR-0007 (`worker/` holds the worker image's own Dockerfile and compose fragment), ADR-0019
  (the worker container is where nono runs the agent), ADR-0009/ADR-0003 (nono `required` mode;
  the pinned build is the one the probe matrix measured), `docs/compatibility/{SANDBOX,APM}.md`

## Context

ADR-0004 publishes one image, `ghcr.io/dbirks/communication`, built by GoReleaser in the
`image (main)` CI job. ADR-0007 gave the worker its own build input in `worker/Dockerfile` —
the Go binary in worker mode plus the Node runtime, pinned ACP adapters and the nono/apm
binaries a unit needs to launch anything (~1.1 GB). It existed only as a local `docker build`,
so nothing on the cluster could pull it: a deployment needs both images published.

## Options considered

| Option | Advantages | Disadvantages | Evidence |
|---|---|---|---|
| A — publish serve and worker as one image | One artifact, one pull | ~1.1 GB of Node/adapter/sandbox layers pushed onto every API replica that never executes a unit; also contradicts ADR-0007's split | `worker/Dockerfile` runtime stage vs `cmd/communication` serve image |
| B — build the worker image in GoReleaser with the serve image | One publish path, one config file | GoReleaser would have to own the npm/nono/apm downloads and their digest pins, which are compatibility-table evidence, not release packaging; and its `dockers:` blocks are multi-arch by default | `.goreleaser.yaml` builds only the serve image today |
| C — separate `worker-image` CI job running plain `docker buildx build` (chosen) | `worker/Dockerfile` stays the single, unchanged authority for pins; no new third-party action; arch is explicit in `--platform` | Tag logic (`:main`, `:sha-<7>`) is hand-written shell, not metadata-action; one more job | new `worker-image` job in `ci.yml`, `needs: [go, audit]` |

## Decision

**Option C.** A new `worker-image` job ("worker image (main)") runs on push to `main` only,
with the same `if:`/`needs: [go, audit]` and `permissions: contents: read, packages: write` as
the existing image job. It logs in to ghcr.io and pushes `worker/Dockerfile`, unmodified, as
**`ghcr.io/dbirks/communication-worker`** `:main` + `:sha-<short7 of HEAD>`, with
`--platform linux/amd64` and `--cache-from/--cache-to type=gha,mode=max`.

amd64-only is a scope decision, not an oversight: `worker/Dockerfile`'s `executionbin` stage
downloads `nono-v0.80.0-x86_64-unknown-linux-gnu.tar.gz` and `apm-linux-x86_64.tar.gz` by name,
with sha256 pins matching the builds the compatibility matrices observed. arm64 needs per-arch
pins *and* an arm64 probe run before a row can be called PASS, so no arm64 layer and no
multi-arch manifest are published until that evidence exists. No `v*` (release) tag either —
the worker image is pinned by SHA for now.

## Consequences

- Positive: the cluster can run real workers (`:sha-<7>` for reproducibility, `:main` as the
  rolling label), and a worker deploy is a digest bump reviewable in one line.
- Positive: the pins stay in one place; this job cannot drift the sandbox/adapters away from
  what `docs/compatibility/` claims.
- Limitation: amd64 nodes only — an arm64 node pulling `:main` may not satisfy it, so workers
  stay off arm64 until per-arch pins land.
- Limitation: main-only, so `worker/Dockerfile` changes are proven by the local build plus the
  merge-to-main publish, not by CI.
- Cost: layers push on every main commit that invalidates them; the GHA cache bounds it to
  changed stages. No `v*` worker tags, attestation, or Flux policy yet.

## Security/privacy

`packages: write` is scoped to this job and only `GITHUB_TOKEN` is used (AGENTS.md / ADR-0004).
The image is the security-relevant artifact — it carries nono and the ACP adapters — so its
contents change only by reviewed edits to `worker/Dockerfile`, each pinning an exact version
*and* a verified digest, never a floating tag. Landlock stays in the child processes the worker
launches, not its own. Fail-closed: a failed build/push leaves the previous `:main`/`:sha-*`.

## Verification

- `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ci.yml'))"` → ok. Lint
  is that parse plus review: `actionlint` is not installed on the lab host.
- The exact build command was run locally with `--load` and no push:
  `docker buildx build --platform linux/amd64 -f worker/Dockerfile -t communication-worker:ci-check --load .`
  completed (`writing image sha256:26eb96d4ff5e… done` / `naming to …ci-check done`); the image
  was removed after the check.
- Not yet verified: the push path (ghcr login, the `--push` build, the GHA cache) and a cluster
  node pulling and starting `:sha-<7>` — the first main run of this job is that evidence.

## Migration/rollback

- Rollback: revert the commit / delete the job; nothing references `communication-worker` yet.
- Forward, each needing its own change: arm64 pins + probe rows → multi-arch build and an
  `imagetools` manifest (mirroring `image (main)`); `v*` tags tied to GoReleaser releases; an
  in-cluster Deployment/Flux manifest pinned by digest.
