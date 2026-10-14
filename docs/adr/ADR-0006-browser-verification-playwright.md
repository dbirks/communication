# ADR-0006 — Browser verification of UI work with Playwright

- **Date:** 2026-10-14
- **Status:** Proposed
- **Owners:** project owner
- **Related decisions / contracts:** `communication-spec/12-test-strategy.md` (E2E layer, release gate
  criteria), `communication-spec/10-ui-design-handoff.md`, ADR-0004 (CI), ADR-0005 (frontend toolchain)

## Context

`communication-spec/12-test-strategy.md` defines six layers — unit, property/fuzz, integration,
contract, E2E and operational/security — and states that done means *proven running*. The E2E layer
covers "all user journeys, especially fresh team onboarding, shared sessions, human handoff, child
runs and interruption". The repository rule that follows from this is strict: a mocked green test is
never a substitute for a real integration test, and nothing may be claimed as working without
evidence.

For a React SPA that renders run state, SSE streams and approval prompts, "evidence" has to include
what a real browser actually painted and what it logged, not only a component test. This ADR records
how UI work is driven and evidenced. The spec names no browser tool, so this is the project owner's
preference, not a spec requirement.

## Options considered

| Option | Advantages | Disadvantages | Evidence |
|---|---|---|---|
| **Playwright CLI for interactive verification + Playwright tests in CI (chosen)** | One ad-hoc command surface (`open`, `snapshot`, `click`, `screenshot`, `console`) lets an agent or human inspect the live stack without writing a spec first; the same engine then hosts the committed E2E journeys; accessible snapshots give a text diff of the a11y tree | Downloads a browser per environment; CI needs the stack running (ADR-0004 `compose.yml`); flake management for timing-sensitive streams | Not yet exercised — the first CLI session against `docker compose up` and the first CI E2E run will prove both |
| Cypress | Batteries-included runner, good time-travel debugging, built-in network stubbing | Test-authoring-first: no cheap ad-hoc "look at this page" loop for an agent; browser matrix narrower; runner model differs from the CLI flow used today | Compared as the mainstream alternative for the interactive loop |
| Selenium / WebDriver | Broadest browser coverage, the long-standing standard | Verbose setup and explicit waits; no snapshot/console ergonomics; agent-driven inspection is slow to script | Compared as the generic baseline |
| Unit / component tests only (no real browser) | Fast, hermetic, no browser download | Cannot satisfy "proven running" — cannot observe SSE rendering, layout, focus order or console errors, so E2E journeys in 12 stay unverified | Rejected for the E2E layer by the test strategy's own rule about mocked greens |

## Decision

The project owner chooses:

1. **Interactive verification** of UI work is done by driving a **real browser** against the running
   stack with the Playwright CLI: `pnpm dlx @playwright/cli open|snapshot|click|screenshot|console`.
   The stack under test is the real one (API + worker + Postgres + UI, per ADR-0004), not a mock server.
2. **Committed E2E journeys** from `communication-spec/12-test-strategy.md` are written as Playwright
   tests and run in CI, gated on the same jobs that build the UI.
3. **Artifacts land in `.playwright-cli/` and `verify-*.png`**, both gitignored, so screenshots and
   traces are evidence for the current change and never enter the repository or an image.

`communication-spec/12-test-strategy.md` stays the authority on *which* journeys exist; this ADR only
chooses the tool that observes them.

## Consequences

Positive: every UI claim carries browser evidence (snapshot text, screenshot, console output); agents
can self-verify without a human; one tool covers ad-hoc inspection and CI regression. Limitations:
browser binaries must be provisioned in CI and on dev machines; tests that wait on SSE streams and
worker activity need explicit wait strategies or they will flake; screenshot evidence is local-only,
so CI must upload the failing artifact rather than rely on a committed PNG. Backwards compatibility:
no public contract is affected — this is a verification tool, not a runtime dependency.

## Security/privacy

The browser drives the UI as an ordinary authenticated user; it holds no privileged access. Test
credentials are throwaway accounts created by the test fixture, never real user identities, and are
supplied through CI secrets or generated at run time — never committed and never written into
screenshots or traces. Because traces and screenshots can capture session cookies, project tokens and
repository content, artifacts stay inside the gitignored `.playwright-cli/` / `verify-*.png` scope and
CI retention is kept short. No HTML artifact rendered by the UI viewer (test case 16 in 12) is given
access to the Communication origin during these runs.

## Verification

Nothing is claimed as run here — `ui/` does not exist yet. The following will prove the assumptions:
a Playwright CLI session against `docker compose up` that opens the app, snapshots the accessibility
tree, and captures clean `console` output; the first CI E2E run executing at least the onboarding and
human-handoff journeys green; a deliberately broken UI commit showing the CI E2E job goes red with an
uploadable trace/screenshot; a check that `git status --porcelain` stays clean after a verification
session, confirming the ignore rules hold; and a run proving the E2E job fails closed when the stack
is unreachable rather than skipping silently.

## Migration/rollback

Rollback is contained in the test toolchain. If Playwright proves unusable in the CI environment, the
E2E specs move to another driver while the interactive loop degrades to manual screenshots plus
console logs, and the release gate in `communication-spec/12-test-strategy.md` is then met by
operational evidence instead. Removing the tool means deleting the E2E job and the two gitignore
entries; no application code depends on it. Switching to Cypress or WebDriver keeps the same journey
inventory, so the migration cost is spec syntax only.
