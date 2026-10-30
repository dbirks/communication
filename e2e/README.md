# e2e — Playwright suites for the Communication compose stack

Two journeys, one isolated stack. The suite never runs against mocks and never
against the dev stack's `1808x` ports: it uses compose project
`communication-e2e` on `28080` (lb) / `28081` (api-a) / `28082` (api-b) /
`28090` (mock IdP), so a run cannot collide with the dev stack or with the
lab host's model gateway on `8080/8081/8090` (ADR-0006).

| Suite                      | Proves                                                                                                                       | Needs a worker + agent login | Runs in CI                                   |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | -------------------------------------------- |
| `tests/m1-journey.spec.ts` | M1: OIDC sign-in, projects, repos, both replicas, SSE live update, replica restart, non-member isolation                     | No                           | Yes (always)                                 |
| `tests/m2-journey.spec.ts` | M2: shared live conversation, permission card, CAS takeover cancelling the open turn, handoff back, restart-safe transcripts | **Yes**                      | Skipped unless `COMMUNICATION_E2E_HARNESS=1` |

Tests are serial by design (`workers: 1`, `retries: 0` in
`playwright.config.ts`): the stack is one shared mutable database, and a retry
would replay a journey against the state the first attempt already mutated.

## Prerequisites

```bash
pnpm --dir e2e install --frozen-lockfile
pnpm --dir e2e exec playwright install chromium   # + --with-deps on a clean runner
```

## M1 — the CI journey (no credentials needed)

```bash
docker compose -p communication-e2e -f compose.yml -f e2e/compose.e2e.yml up -d --build
pnpm --dir e2e test                       # m2-journey.spec.ts reports as skipped
docker compose -p communication-e2e -f compose.yml -f e2e/compose.e2e.yml down -v
```

This is exactly the `e2e` job in `.github/workflows/ci.yml`. `compose.e2e.yml`
puts the worker behind a `worker` profile, so a CI `up` never builds the heavy
worker image (ADR-0007).

## M2 — the real-agent journey (local, opt-in)

M2 drives a real Claude session through the worker, so it needs the developer's
own harness login — the same override the dev stack uses
(`compose.harness.yml`, which bind-mounts `~/.claude` / `~/.codex` and sets
`CLAUDE_CONFIG_DIR` / `CODEX_HOME`) — plus `e2e/compose.e2e-harness.yml`, which
un-profiles the worker on the e2e ports and gives it the name `worker-e2e` and
the workspace root `/workspaces/e2e`.

```bash
mkdir -p .harness/workspaces .harness/home          # host prep, lab only
HOST_UID=$(id -u) HOST_GID=$(id -g) \
  docker compose -p communication-e2e \
    -f compose.yml -f compose.harness.yml \
    -f e2e/compose.e2e.yml -f e2e/compose.e2e-harness.yml \
    up -d
```

Both services name explicit images (`communication:dev`,
`communication-worker:dev`, built by the dev stack), so `up -d` reuses them; add
`--build` to run the journey against the working tree instead. The images carry
no credentials — only the bind mounts do.

`HOST_UID`/`HOST_GID` are not optional. The image's user is uid 10001; the host
agent configs are `0600`/`0700` and owned by you, and a worker recreated without
those variables closes its turn `conversation.turn.failed` with the adapter's
own "Authentication required" text (observed, `docs/compatibility/ACP.md`).

Then run the suite against that stack, telling it which compose layers to
restart replicas through:

```bash
HOST_UID=$(id -u) HOST_GID=$(id -g) COMMUNICATION_E2E_HARNESS=1 \
  E2E_COMPOSE_FILES=compose.yml,compose.harness.yml,e2e/compose.e2e.yml,e2e/compose.e2e-harness.yml \
  pnpm --dir e2e test tests/m2-journey.spec.ts
```

Teardown (the suite leaves a cloned repo and an agent-written file behind):

```bash
docker compose -p communication-e2e -f compose.yml -f compose.harness.yml \
  -f e2e/compose.e2e.yml -f e2e/compose.e2e-harness.yml down -v
rm -rf .harness/workspaces/e2e           # the worker's e2e workspaces (bind mount)
```

What it proves, in order: bob and alice sign in through the mock IdP with real
profile claims; alice creates a project holding `https://github.com/octocat/Hello-World.git`
(default branch `master`) and makes bob a contributor; alice starts a "Claude
Code" conversation whose first turn clones and reads the repo; bob watches it
live on replica B (composer disabled, "Take control" offered); alice's long
shell turn raises a permission card that is actionable for her and read-only
for bob; bob takes control and her turn ends `cancelled`, not silently; bob
prompts a file write, approves it himself, and the turn completes; bob returns
control; both API replicas restart and both members' transcripts are identical.

## Configuration

| Variable                                         | Default                              | Meaning                                                                       |
| ------------------------------------------------ | ------------------------------------ | ----------------------------------------------------------------------------- |
| `COMMUNICATION_E2E_HARNESS`                      | unset                                | `1` un-skips the M2 real-agent suite                                          |
| `E2E_BASE_URL`, `E2E_API_A_URL`, `E2E_API_B_URL` | `http://localhost:28080/28081/28082` | stack endpoints                                                               |
| `E2E_COMPOSE_PROJECT`                            | `communication-e2e`                  | compose project used by the restart steps                                     |
| `E2E_COMPOSE_FILES`                              | `compose.yml,e2e/compose.e2e.yml`    | `-f` layers the restart steps address (pass the harness layers for an M2 run) |
| `E2E_TURN_TIMEOUT_MS`                            | `300000`                             | ceiling for one real agent turn                                               |
| `E2E_PERMISSION_TIMEOUT_MS`                      | `420000`                             | ceiling for a permission request to appear / a controller change to land      |

Model output is not scriptable, so the prompts name the tool and the exact
content ("use the Write tool to create `repos/hello-world/NOTES.md` containing
exactly: handoff ok") and the assertions read the transcript, controller badge
and turn status rather than the agent's prose. Nothing here needs a network
model beyond GitHub: the only clone is a public repository.

## Lint / format / types

```bash
pnpm --dir e2e lint          # oxlint
pnpm --dir e2e fmt:check     # oxfmt --check
pnpm --dir e2e typecheck     # tsc --noEmit
```

## Hygiene

Session cookies live in Playwright traces, and traces/screenshots are retained
on failure only (`playwright.config.ts`); CI uploads them with a 7-day
retention (ADR-0006 Security/privacy). Do not commit `playwright-report/` or
`test-results/`, and bring the project down with `down -v` when finished — the
e2e volumes (Postgres, workspaces, keyring) are disposable by design.
