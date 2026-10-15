# syntax=docker/dockerfile:1
# Worker execution image (ADR-0007): Go control-plane binary in worker mode
# plus the Node runtime and pinned agent adapters the ACP launchers need
# (worker/launchers.yaml). The API image (api/Dockerfile) deliberately
# contains none of this — workers are separately rolled execution machines
# (02-system-architecture, D-002).
#
# Version pinning rule (04-agent-runtime compatibility): every npm package
# here is an exact version; upgrades are deliberate, reviewed changes to
# this file, never floating tags. The pinned adapter versions match
# internal/agent/acp/launchers.go and docs/compatibility/ACP.md evidence.

FROM golang:1.27.2-trixie AS gobuild
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
# .dockerignore excludes ui/dist; the worker never serves the UI, but
# ui/embed.go still needs a file to satisfy //go:embed all:dist.
RUN mkdir -p ui/dist && touch ui/dist/.gitkeep
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o /out/communication ./cmd/communication

FROM node:22-bookworm-slim

# ca-certificates: HTTPS to model APIs; git: workspace clones; curl: the
# image's own smoke check; openssh-client: private remotes over ssh (the
# keys are a runtime mount, never baked in).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git curl openssh-client \
 && rm -rf /var/lib/apt/lists/*

# Pinned adapters + the agent CLIs they drive. npm installs as root into a
# shared prefix; the worker itself runs unprivileged.
ARG CLAUDE_ACP_VERSION=0.90.0
ARG CODEX_ACP_VERSION=2.2.2
ARG CLAUDE_CODE_VERSION=2.1.300
ARG CODEX_VERSION=0.162.1
RUN npm install -g --omit=dev --no-update-check --no-fund --no-audit \
      "@agentclientprotocol/claude-agent-acp@${CLAUDE_ACP_VERSION}" \
      "@agentclientprotocol/codex-acp@${CODEX_ACP_VERSION}" \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
      "@openai/codex@${CODEX_VERSION}" \
 && claude --version \
 && codex --version

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

# Smoke: both adapter entry points resolve and the binary prints its usage.
# (A real `doctor --acp` handshake needs user credentials, which by design
# are never in the image — see compose.harness.yml.)
RUN communication --help >/dev/null \
 && command -v claude-agent-acp \
 && command -v codex-acp

ENTRYPOINT ["/usr/local/bin/communication"]
CMD ["worker"]
