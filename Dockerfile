# Runtime image for the GoReleaser-built `communication` binary (ADR-0004).
#
# This image never compiles Go: .goreleaser.yaml builds the binary for the
# target platform and copies it into the build context root, so the only thing
# this Dockerfile does is install runtime dependencies and drop privileges.
#
# Base pinned by tag. The dated tag below is the same content and can be
# substituted for byte-reproducible rebuilds: debian:trixie-20261005-slim
# (the moving trixie-slim tag is re-pointed by every debian upload).
FROM debian:trixie-slim

# The worker shells out to git for worktrees/checkpoints
# (communication-spec/05-workspaces-security-secrets.md), and the control plane
# talks OIDC/GitHub over TLS. Nothing else is installed at runtime.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        git \
    && rm -rf /var/lib/apt/lists/*

COPY communication /usr/local/bin/communication

# Non-root runtime user: uid/gid 10001 matches the worker workspace ownership
# convention so mounted volumes stay writable without chmod.
RUN groupadd --gid 10001 communication \
    && useradd --uid 10001 --gid 10001 --no-create-home \
        --home /nonexistent --shell /usr/sbin/nologin communication

USER 10001:10001

# No secrets, no .env, no tokens: configuration arrives at run time through
# flags, environment and mounted secret material.
ENTRYPOINT ["/usr/local/bin/communication"]
CMD ["serve"]
