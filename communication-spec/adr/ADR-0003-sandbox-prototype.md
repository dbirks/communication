# ADR-0003 — Prototype nono behind a fail-closed sandbox adapter

- **Date:** 2026-10-14
- **Status:** Proposed; acceptance requires M0 security testing
- **Related:** D-011, D-021, D-025

## Context
Communication runs autonomous coding agent subprocesses in multi-repository workspaces, sometimes inside Docker/Podman. Linux Landlock may avoid namespace nesting but is not a separate kernel boundary. nono's own SECURITY.md cautions against production reliance while guarantees are evolving.

## Alternatives
A. Raw Landlock: low-level, maintain our security layer. B. Bubblewrap: mature low-level namespace primitive but more host/container config. C. nono: agent-centered policies and Landlock integration, alpha risk. D. OCI per-run isolation: better outer trust boundary but heavier operational model.

## Proposed decision
Use nono for initial Linux sandbox prototyping via child process/CLI adapter. Require capability probe and fail closed if enforcement is mandatory. Preserve a path to OCI outer isolation for mutually untrusted projects and stronger boundaries.

## Before acceptance
Verify filesystem deny, network rules, inherited sockets/FDs, secrets, NPM/ACP launch compatibility, host/Docker/rootless Podman conditions. Record exact nono release/commit/kernel ABI and limitations. Do not market production-safe cross-client tenant isolation merely because nono is enabled.

## Sources
- https://github.com/nolabs-ai/nono/blob/main/SECURITY.md
- https://docs.kernel.org/userspace-api/landlock.html
- https://github.com/containers/bubblewrap
