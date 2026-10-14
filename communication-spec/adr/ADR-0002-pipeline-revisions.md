# ADR-0002 — Published pipeline definitions are immutable and run-pinned

- **Date:** 2026-10-14
- **Status:** Accepted (architecture intent)
- **Related:** D-005, D-019, D-022

## Context
Companies need reusable configurable workflows, beta variants, project-specific rollouts and auditability while work is running.

## Options considered
A. Mutate one live graph: simple editor but impossible to reconstruct runs. B. Git-only config: reviewable, but restrictive for in-app natural-language edits. C. Canonical validated revisions in PostgreSQL, optional YAML/Git import-export, explicit promotion.

## Decision
Use option C. Every run pins one published revision digest. Drafts can be edited by UI, assistant or YAML import. Publish/assignment promotion are distinct authorized operations. Dynamic work uses bounded scopes and invoked child pipelines, not graph rewriting.

## Consequences / verification
Database/Git conflict policy required; revision storage immutable; effective assignment version resolved at run start. Test mid-run publish and controlled rollout to one project.
