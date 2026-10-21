# syntax=docker/dockerfile:1
# Worker execution image (ADR-0007): Go control-plane binary in worker mode
# plus the Node runtime and pinned ACP adapters the launchers spawn
# (worker/launchers.yaml, internal/agent/acp/launchers.go), and — from M3 —
# the two execution-plane binaries a unit needs before it can launch anything:
# the nono sandbox and the APM package manager.
#
# Version pinning rule (04-agent-runtime compatibility): every dependency here
# is an exact version *and* a verified digest. Upgrades are deliberate, reviewed
# changes to this file, never floating tags.
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
#
# Base image: trixie, not bookworm, because of one measured dependency. APM
# 0.33.0 bundles libpython3.12, which needs GLIBC_2.38; bookworm ships 2.36 and
# the binary dies at import with
#   Failed to load Python shared library ... version `GLIBC_2.38' not found
# trixie ships 2.41. This was verified by running the actual binary in both
# images, not by reading a release note. nono 0.80.0 needs only GLIBC_2.34 and
# would have run on bookworm; the base is chosen by the stricter requirement.

# Stage 1: build the Go binary. No toolchain survives into the final image.
FROM golang:1.27.3-trixie AS gobuild
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
FROM node:22-trixie-slim AS npmdeps
ARG CLAUDE_ACP_VERSION=0.90.0
ARG CODEX_ACP_VERSION=2.2.2
RUN --mount=type=cache,target=/root/.npm \
    npm install -g --omit=dev --no-update-check --no-fund --no-audit \
      "@agentclientprotocol/claude-agent-acp@${CLAUDE_ACP_VERSION}" \
      "@agentclientprotocol/codex-acp@${CODEX_ACP_VERSION}"

# Stage 2b: fetch and verify the execution-plane binaries.
#
# Both digests are checked against what the project observed, and the check is
# `sha256sum -c` rather than a visual comparison: a worker image whose sandbox
# binary is not the binary that was probed would make every
# docs/compatibility/SANDBOX.md row a claim about some other build.
#
#   nono v0.80.0  — matches the published SHA256SUMS.txt for that release and the
#                   value recorded in docs/compatibility/SANDBOX.md ("nono tarball
#                   sha256"), which is the build the probe matrix ran on.
#   apm v0.33.0   — matches the release's own apm-linux-x86_64.tar.gz.sha256 and
#                   docs/compatibility/APM.md's provenance line.
#
# The musl nono build is deliberately NOT used even though it would have no glibc
# dependency at all: the probe matrix ran against the gnu build, and ADR-0019's
# contract is about the binary that was tested. Swapping the libc flavor of a
# sandbox to make a Dockerfile tidier is exactly the kind of unverified
# substitution the compatibility tables exist to prevent.
FROM node:22-trixie-slim AS executionbin
ARG NONO_VERSION=0.80.0
ARG NONO_SHA256=6da665b61999570c10dffc7da78828fe1fb7f3cac53319e505cebecaef17037f
ARG APM_VERSION=0.33.0
ARG APM_SHA256=e6374402c74318f7c8bef97a90d8572d049fdab0dc3871492c6b0647ae9e881f
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
    mkdir -p /out; \
    cd /tmp; \
    curl -fsSL -o nono.tgz \
      "https://github.com/nolabs-ai/nono/releases/download/v${NONO_VERSION}/nono-v${NONO_VERSION}-x86_64-unknown-linux-gnu.tar.gz"; \
    printf '%s  nono.tgz\n' "${NONO_SHA256}" | sha256sum -c -; \
    tar -xzf nono.tgz; \
    install -m 0755 "$(find . -type f -name nono | head -n1)" /out/nono; \
    curl -fsSL -o apm.tgz \
      "https://github.com/microsoft/apm/releases/download/v${APM_VERSION}/apm-linux-x86_64.tar.gz"; \
    printf '%s  apm.tgz\n' "${APM_SHA256}" | sha256sum -c -; \
    # The apm tarball carries a top-level directory (apm-linux-x86_64/), so it is
    # extracted with that component stripped: /opt/apm/apm and /opt/apm/_internal,
    # not /opt/apm/apm-linux-x86_64/apm. A PyInstaller bundle is only relocatable
    # as a unit — `apm` finds `_internal/` as its own sibling, and a symlink to a
    # nested copy would look for templates one level too deep.
    mkdir -p /out/apm && tar -xzf apm.tgz -C /out/apm --strip-components=1; \
    test -x /out/apm/apm; test -d /out/apm/_internal; \
    ls -l /out /out/apm

# Stage 3: runtime only. The node image's own layers (base OS, node binary,
# npm, corepack) are re-emitted as one squashed filesystem layer with the
# package managers removed — an upper-layer `rm` cannot shrink immutable
# lower layers, so the 3.82 GB image measured 1.1 GB of actual files.
FROM node:22-trixie-slim AS nodebase
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

FROM scratch AS runtime
COPY --from=nodebase / /
ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# ca-certificates: HTTPS to model APIs; git: worktrees and mirror fetches;
# openssh-client: private remotes over ssh (the keys are a runtime mount,
# never baked in).
#
# libffi8 is here for exactly one reason and it is not tidiness: APM 0.33.0's
# bundled Python imports ctypes, which dlopens libffi.so.8. Without the package
# `apm --version` fails with
#   ImportError: libffi.so.8: cannot open shared object file
# and every unit whose profile pins packaged context refuses to launch. git is
# in the same class: APM imports GitPython at startup and aborts with "Bad git
# executable" if it cannot find one, so git is a dependency of the *staging*
# step, not only of the workspace step.
#
# curl is deliberately absent: it was only ever used by an old image smoke check.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates git openssh-client libffi8 \
 && rm -rf /var/lib/apt/lists/*

# Adapter tree + launcher entry points only; no caches, no logs. COPY
# dereferences symlinks, so the npm bin links are recreated (relative, as
# npm writes them) rather than copied.
COPY --from=npmdeps /usr/local/lib/node_modules/@agentclientprotocol /usr/local/lib/node_modules/@agentclientprotocol
RUN ln -s ../lib/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js /usr/local/bin/claude-agent-acp \
 && ln -s ../lib/node_modules/@agentclientprotocol/codex-acp/dist/index.js /usr/local/bin/codex-acp

# The sandbox and the package manager. nono goes on PATH because
# internal/agent/acp resolves it with exec.LookPath, and because a
# `required`-mode worker that could not find it must fail at startup rather
# than launch an unisolated agent (ADR-0019 D6).
#
# The worker runs as uid 10001 and nono is a *user* sandbox: it applies Landlock
# rules to the calling process's descendants and needs no setuid, no capability
# and no privileged mount. It must not be made setuid-root to "work more
# reliably" — ADR-0009's chain never asks for privilege, and a privileged
# sandbox binary in an execution image is a larger attack surface than the
# problem it solves.
COPY --from=executionbin /out/nono /usr/local/bin/nono
# APM is a PyInstaller bundle: `apm` and `_internal/` are one unit, and the
# extraction directory must be read-only-writable-free for the launcher's own
# integrity — the worker never writes here, and a checkout-time `apm install`
# writes into the checkout, not into the tool tree.
COPY --from=executionbin /out/apm /opt/apm
RUN ln -s /opt/apm/apm /usr/local/bin/apm

# Non-root: workspaces, mounted credentials and .env materialization all
# need a stable uid (the dev harness mounts host configs readable by it).
#
# The three M3 storage roots below are separate directories, not one nested
# tree, and that is a security property rather than layout taste:
#   * nono derives its protected state root from HOME and then permanently
#     refuses any grant overlapping it (probe C-H1). A launcher home under
#     /workspaces would poison every workspace created on this worker, so
#     COMMUNICATION_SANDBOX_HOME defaults to a sibling.
#   * The mirror tree outlives every conversation that used it, and
#     AssertNothingBut rejects foreign entries inside a workspace root
#     (ADR-0017 D4), which nesting would guarantee.
# Mode 0700: these hold other tenants' checkouts and other tenants' secrets.
RUN useradd --uid 10001 --create-home --shell /usr/sbin/nologin worker \
 && mkdir -p /workspaces /repos /sandbox-home /sandbox-policy /sandbox-selftest \
 && chown worker:worker /workspaces /repos /sandbox-home /sandbox-policy /sandbox-selftest \
 && chmod 0700 /workspaces /repos /sandbox-home /sandbox-policy /sandbox-selftest

COPY --from=gobuild /out/communication /usr/local/bin/communication

# Launcher definitions are built into the binary (internal/agent/acp/
# launchers.go, pinned to the npm versions below); a YAML catalog override
# under worker/ is the documented M3 extension point, not implemented yet.
ENV COMMUNICATION_WORKSPACE_ROOT=/workspaces \
    COMMUNICATION_REPOS_ROOT=/repos \
    COMMUNICATION_SANDBOX_HOME=/sandbox-home \
    COMMUNICATION_SANDBOX_POLICY_DIR=/sandbox-policy \
    COMMUNICATION_SANDBOX_ENFORCEMENT=required

USER worker
WORKDIR /workspaces

# Smoke: both adapter entry points resolve, the harness runtimes the adapters
# actually spawn (their bundled binaries) are present, and — new for M3 — both
# execution-plane binaries *run* under this image's glibc and library set.
#
# The `nono run` leg is not decoration: `--version` proves the binary loads, and
# only an actual sandboxed exec proves Landlock mediation works in a container
# (a seccomp profile can make the ruleset setup fail in ways a version check
# cannot see). It runs the image's own `true` under a one-path policy, so it
# depends on nothing but the sandbox itself.
#
# `communication doctor` is the fuller check and is deliberately *not* in the
# build: it reads /sys/kernel/security/lsm, which a build container need not
# share with the host that runs the image.
RUN communication --help >/dev/null \
 && command -v claude-agent-acp \
 && command -v codex-acp \
 && nono --version \
 && apm --version \
 \
 && mkdir -p /workspaces/.smoke \
 && (cd /workspaces/.smoke && nono run -s --allow /workspaces/.smoke -- /bin/true) \
 && (cd /workspaces/.smoke && nono run -s --allow /workspaces/.smoke -- sh -c 'test ! -w /etc/passwd && echo denied-ok') \
 && node -e 'const{createRequire}=require("module"),{accessSync,constants}=require("fs"),b="/usr/local/lib/node_modules/";createRequire(b+"@agentclientprotocol/claude-agent-acp/package.json").resolve("@anthropic-ai/claude-agent-sdk-linux-x64/claude")&&accessSync(createRequire(b+"@agentclientprotocol/claude-agent-acp/package.json").resolve("@anthropic-ai/claude-agent-sdk-linux-x64/claude"),constants.X_OK);createRequire(b+"@agentclientprotocol/codex-acp/package.json")&&accessSync(createRequire(b+"@agentclientprotocol/codex-acp/package.json").resolve("@openai/codex/bin/codex.js"),constants.R_OK)'

ENTRYPOINT ["/usr/local/bin/communication"]
CMD ["worker"]
