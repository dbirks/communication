# ADR-0001 — Separate control and execution modes in one Go program

- **Date:** 2026-10-14
- **Status:** Accepted (architecture intent, implementation unverified)
- **Related:** D-002, D-003

## Context
Multiple API replicas are desired for web/control-plane rollouts, but ACP stdio subprocesses belong to a worker process and cannot be migrated to another replica by persisting their session ID.

## Options considered
A. Every API replica starts subprocesses: fewer deployment roles but request lifetime entanglement, unsafe rollouts and difficult ownership. B. One Go binary with `serve` and `worker` modes: explicit lifecycle, separate horizontal scale, easier persistent volumes. C. Kubernetes Jobs only: adds cluster dependency to first deployment.

## Decision
Use option B. Same source/build artifact, independently deployed API pods and persistent worker. A convenience `dev` mode may run both in one process for local development, clearly not offering HA.

## Consequences / verification
Workers own processes/workspaces; API nodes are stateless-ish and can roll. One worker remains single point of execution. Test API rolling deploy during active streaming and worker drain/recovery separately. Worker host failover requires portable checkpoints, not merely Postgres.
