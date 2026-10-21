# syntax=docker/dockerfile:1
# Source build of the `communication` API/worker image for local dev and CI
# (compose: context = repo root, dockerfile = api/Dockerfile).
#
# This is distinct from the release Dockerfile at the repo root, which copies a
# GoReleaser-built binary (ADR-0004). Here both the UI bundle and the Go binary
# are compiled from source, because ADR-0007 requires the UI to be built
# *before* the Go build (ui/embed.go embeds ui/dist) and a stale dist would
# otherwise silently ship a stale UI.
#
# Base images are pinned by tag; the same image must never be rebuilt from a
# moving tag in CI.

# ---------------------------------------------------------------- UI bundle
FROM node:24.22.0-trixie-slim AS ui

WORKDIR /src

# pnpm is pinned by ui/package.json's packageManager field; prepare it
# explicitly so the install does not depend on corepack's network resolution
# policy at an unexpected moment.
RUN corepack enable && corepack prepare pnpm@11.28.5 --activate

# Manifest layer first, so dependency install is cached until the lockfile
# changes.
COPY ui/package.json ui/pnpm-lock.yaml ui/pnpm-workspace.yaml ui/.npmrc ./ui/
RUN pnpm --dir ui install --frozen-lockfile

# The UI codegen reads the OpenAPI contract from api/, so it is part of the UI
# build context even though no Go code lives there (ADR-0007).
COPY ui/ ./ui/
COPY api/openapi.yaml ./api/openapi.yaml
# The UI imports the pipeline JSON Schema from internal/ (single source of
# truth shared with the Go compiler), so the asset must exist in the build
# context too.
COPY internal/pipelines/schema/assets/ ./internal/pipelines/schema/assets/
RUN pnpm --dir ui build

# ---------------------------------------------------------------- Go binary
FROM golang:1.27.3-trixie AS build

WORKDIR /src

# Module graph first: `go mod download` is cached until go.mod/go.sum change.
COPY go.mod go.sum ./
RUN go mod download

COPY cmd/ ./cmd/
COPY internal/ ./internal/
COPY ui/embed.go ./ui/embed.go
COPY --from=ui /src/ui/dist ./ui/dist

# CGO off: the binary must run in a slim image with no libc guarantee, and a
# static binary keeps the runtime layer minimal. Version is stamped by
# GoReleaser for releases; dev builds say dev.
ENV CGO_ENABLED=0
RUN go build -trimpath -ldflags "-s -w -X main.version=dev" \
    -o /out/communication ./cmd/communication

# ---------------------------------------------------------------- runtime
# The worker shells out to git for worktrees/checkpoints
# (communication-spec/05) and the control plane speaks OIDC over TLS; curl
# backs the compose healthchecks. Nothing else is installed.
FROM debian:trixie-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /out/communication /usr/local/bin/communication

# Non-root runtime user: uid/gid 10001 matches the worker workspace ownership
# convention so mounted volumes stay writable without chmod.
RUN groupadd --gid 10001 communication \
    && useradd --uid 10001 --gid 10001 --no-create-home \
        --home /nonexistent --shell /usr/sbin/nologin communication

USER 10001:10001

# No secrets, no .env, no tokens: configuration arrives at run time through
# environment and mounted secret material.
ENTRYPOINT ["/usr/local/bin/communication"]
CMD ["serve"]
