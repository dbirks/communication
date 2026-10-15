# syntax=docker/dockerfile:1
# Worker execution image (ADR-0007): Go control-plane binary in worker mode
# plus the Node runtime and pinned ACP adapters the launchers spawn
# (worker/launchers.yaml, internal/agent/acp/launchers.go). The API image
# (api/Dockerfile) deliberately contains none of this — workers are
# separately rolled execution machines (02-system-architecture, D-002).
#
# Version pinning rule (04-agent-runtime compatibility): every npm package
# here is an exact version; upgrades are deliberate, reviewed changes to
# this file, never floating tags. The pinned adapter versions match
# internal/agent/acp/launchers.go and docs/compatibility/ACP.md evidence.
#
# The standalone harness CLIs (@anthropic-ai/claude-code, @openai/codex)
# that this file used to install globally are deliberately gone: both
# adapters spawn their *own* bundled harness runtimes, not PATH binaries —
# observed in the adapter sources at these pins: claude-agent-acp 0.90.0
# resolves `CLAUDE_CODE_EXECUTABLE ?? claudeCliPath()`, and claudeCliPath()
# resolves the platform binary bundled inside @anthropic-ai/claude-agent-sdk
# (never a PATH lookup); codex-acp 2.2.2 spawns `CODEX_PATH` only when set
# and otherwise `require.resolve("@openai/codex/bin/codex.js")` from its own
# node_modules. Keeping the global CLIs shipped ~690 MB of duplicate native
# binaries that no process ever executed. Harness *authentication* is
# unaffected: it rides CLAUDE_CONFIG_DIR / CODEX_HOME (compose.harness.yml),
# which the bundled runtimes read the same way. The real-agent proof
# (communication doctor --acp claude plus a live two-turn conversation) was
# re-run against this image before shipping it.

# Stage 1: build the Go binary. No toolchain survives into the final image.
FROM golang:1.27.2-trixie AS gobuild
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
# .dockerignore excludes ui/dist; the worker never serves the UI, but
# ui/embed.go still needs a file to satisfy //go:embed all:dist.
RUN mkdir -p ui/dist && touch ui/dist/.gitkeep
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o /out/communication ./cmd/communication

# Stage 2: install the pinned adapters off-line from the final image, so the
# npm cache (~600 MB at these pins) never lands in any shipped layer.
FROM node:22-bookworm-slim AS npmdeps
ARG CLAUDE_ACP_VERSION=0.90.0
ARG CODEX_ACP_VERSION=2.2.2
RUN --mount=type=cache,target=/root/.npm \
    npm install -g --omit=dev --no-update-check --no-fund --no-audit \
      "@agentclientprotocol/claude-agent-acp@${CLAUDE_ACP_VERSION}" \
      "@agentclientprotocol/codex-acp@${CODEX_ACP_VERSION}"

# Stage 3: runtime only. The node image's own layers (base OS, node binary,
# npm, corepack) are re-emitted as one squashed filesystem layer with the
# package managers removed — an upper-layer `rm` cannot shrink immutable
# lower layers, so the 3.82 GB image measured 1.1 GB of actual files.
FROM node:22-bookworm-slim AS nodebase
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

FROM scratch AS runtime
COPY --from=nodebase / /
ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# ca-certificates: HTTPS to model APIs; git: workspace clones;
# openssh-client: private remotes over ssh (the keys are a runtime mount,
# never baked in). curl was only ever used by an old image smoke check and
# is gone; the smoke below uses tools already in the image.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git openssh-client \
 && rm -rf /var/lib/apt/lists/*

# Adapter tree + launcher entry points only; no caches, no logs. COPY
# dereferences symlinks, so the npm bin links are recreated (relative, as
# npm writes them) rather than copied.
COPY --from=npmdeps /usr/local/lib/node_modules/@agentclientprotocol /usr/local/lib/node_modules/@agentclientprotocol
RUN ln -s ../lib/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js /usr/local/bin/claude-agent-acp \
 && ln -s ../lib/node_modules/@agentclientprotocol/codex-acp/dist/index.js /usr/local/bin/codex-acp

# Non-root: workspaces, mounted credentials and .env materialization all
# need a stable uid (the dev harness mounts host configs readable by it).
RUN useradd --uid 10001 --create-home --shell /usr/sbin/nologin worker \
 && mkdir -p /workspaces \
 && chown worker:worker /workspaces

COPY --from=gobuild /out/communication /usr/local/bin/communication

# Launcher definitions are built into the binary (internal/agent/acp/
# launchers.go, pinned to the npm versions below); a YAML catalog override
# under worker/ is the documented M3 extension point, not implemented yet.
ENV COMMUNICATION_WORKSPACE_ROOT=/workspaces

USER worker
WORKDIR /workspaces

# Smoke: both adapter entry points resolve, and the harness runtimes the
# adapters actually spawn (their bundled binaries) are present — the honest
# replacement for the old `claude --version` / `codex --version` checks of
# binaries nothing executed.
RUN communication --help >/dev/null \
 && command -v claude-agent-acp \
 && command -v codex-acp \
 && node -e 'const{createRequire}=require("module"),{accessSync,constants}=require("fs"),b="/usr/local/lib/node_modules/";createRequire(b+"@agentclientprotocol/claude-agent-acp/package.json").resolve("@anthropic-ai/claude-agent-sdk-linux-x64/claude")&&accessSync(createRequire(b+"@agentclientprotocol/claude-agent-acp/package.json").resolve("@anthropic-ai/claude-agent-sdk-linux-x64/claude"),constants.X_OK);createRequire(b+"@agentclientprotocol/codex-acp/package.json")&&accessSync(createRequire(b+"@agentclientprotocol/codex-acp/package.json").resolve("@openai/codex/bin/codex.js"),constants.R_OK)'

ENTRYPOINT ["/usr/local/bin/communication"]
CMD ["worker"]
