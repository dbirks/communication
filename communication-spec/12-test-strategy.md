# 12 — Verification and Acceptance Plan

## Testing pyramid

- **Unit:** schema canonicalization, expression evaluation limits, DAG/scope compiler, state machines, quotas, RBAC policy, idempotency and lease fencing.
- **Property/fuzz:** YAML/JSON input parser, references, graph recursion/cycle check, secret path materialization, ACP event decoding, CEL/resource limits.
- **Integration:** Postgres transactions/outbox claims, artifact store, Git worktrees, OIDC test provider, webhook HMAC, APM install and nono launch.
- **Contract:** actual supported ACP adapters, v1/v2 capability fixture, agent profile effective environment, assistant typed tool schema.
- **E2E:** all user journeys, especially fresh team onboarding, shared sessions, human handoff, child runs and interruption.
- **Operational/security:** Linux sandbox escapes, worker kill/restart, multiple replicas, DB failover/reconciliation and backups.

## Protocol compatibility table (record test results, don't prefill PASS)

| Candidate | New session | Streaming/tool calls | Permission | Cancel | Native restore | APM target | Nono |
|---|---|---|---|---|---|---|---|
| Claude Code ACP adapter/version TBD | Test | Test | Test | Test | Test | Test | Test |
| Codex ACP adapter/version TBD | Test | Test | Test | Test | Test | Test | Test |
| Gemini ACP/version TBD | Test | Test | Test | Test | Test | Test | Test |
| Pi ACP adapter/version TBD | Test | Test | Test | Test | Test | Test | Test |

Each row requires exact executable version, commit/registry ref, OS, auth mode, protocol negotiated, logs (redacted), known limits and sign-off. Keep compatibility suite in CI where credentials available, with a gated integration nightly separate from hermetic unit suite.

## Failure and concurrency test cases

1. Start same logical run twice with same idempotency key; only one logical run exists.
2. Two workers simultaneously claim one ready attempt; only one valid fencing token can commit state.
3. Worker loses lease but process keeps running; stale attempt cannot publish success; reconciler determines cleanup.
4. API replica rolls during streaming; new connection resumes from event sequence with no unauthorized events.
5. Worker killed during ACP tool call; persist `interrupted`, determine retry route; redo incomplete node from prior valid checkpoint.
6. External create-PR succeeds then response lost; retries reconcile and never create a second PR for same operation.
7. `until` never passes: reaches declared bound, marks failed with full evidence; no infinite loop.
8. Child pipeline 3 of 25 fails; sibling results preserved; aggregate failure policy works; bounded fanout.
9. Human approval requested, approver loses project access, unauthorized approval denied.
10. Two humans take control simultaneously; exactly one wins, prior prompt turn is safely paused/cancelled.
11. Changed pipeline revision while existing run executes; run remains pinned to original graph.
12. `.env` file present in specified checkout path only during authorized attempt; not in Git changes, logs or artifact export.
13. Sandbox restriction unavailable in required mode; process does not start and event records enforcement reason.
14. APM package changes on remote; lock digest on existing attempt remains stable.
15. User not assigned Project B probes API/SSE/artifact/assistant search: all denied without metadata leak.
16. HTML artifact with script payload rendered in restricted sandboxed viewer, cannot access Communication origin/cookies.
17. Run across frontend + backend; modifying one checkout doesn't mutate another run's worktree unexpectedly.
18. Trigger webhook duplicate/out-of-order event and scheduled polling overlap; no duplicate child executions.
19. Migration rolling deploy (old and new API) preserves compatibility in supported migration window.
20. Worker restart on same volume recovers workspace; restart on different host without portable checkpoint clearly reports loss/redo.

## First complete acceptance scenario

Administrator creates `Customer Platform` Project with two repos, configures shared agent profiles (APM planner, implementer, reviewer), adds scoped test secret, imports sample feature pipeline, validates sandbox. Another user starts work from goal. Planner emits spec and request; authorized human approves. `for_each` generates at least three child tasks and launches at most two concurrent agents into separate worktrees. Tests and second-agent review fail once and succeed on retry. One person takes over a conversation and returns to factory. Publication creates draft PR/branch or configured artifact. After API rollout, history remains. Assistant clones pipeline beta and changes reviewer, previews diff, user confirms promotion **only to this Project**. Cross-project unauthorized viewer cannot read events/artifacts.

## Release gate criteria

- All required integration/security assertions have evidence and pass in declared supported deployment environment.
- No production “sandboxed tenant isolation” claim based solely on alpha nono.
- All critical ADRs accepted and current as implemented.
- API and worker graceful rolling deployment test passes without silently losing completed node state.
- Documentation states precisely which failure classes require rerun of interrupted node and what checkpoint recoverability is supported.
