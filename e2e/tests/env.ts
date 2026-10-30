// Ports for the isolated e2e stack (e2e/compose.e2e.yml). Overridable for CI
// runners; defaults match the compose override file exactly.
export const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:28080";
export const API_A_URL = process.env.E2E_API_A_URL ?? "http://localhost:28081";
export const API_B_URL = process.env.E2E_API_B_URL ?? "http://localhost:28082";

/** The compose project the suite restarts replicas through (ADR-0006). */
export const COMPOSE_PROJECT = process.env.E2E_COMPOSE_PROJECT ?? "communication-e2e";

/**
 * The `-f` layers the stack under test was started with, in order. Defaults to
 * the CI/M1 invocation; the local M2 harness run passes its four-file list
 * (compose.yml, compose.harness.yml, e2e/compose.e2e.yml,
 * e2e/compose.e2e-harness.yml) so a restart here recreates nothing differently
 * from the `up` that created the containers.
 */
export const COMPOSE_FILES = (process.env.E2E_COMPOSE_FILES ?? "compose.yml,e2e/compose.e2e.yml")
  .split(",")
  .map((file) => file.trim())
  .filter(Boolean);

/**
 * Real-agent suites (M2) need the harness stack — a worker with a working
 * Claude login — which CI does not have. They skip unless this is set to `1`,
 * so `pnpm --dir e2e test` in CI stays exactly what it was.
 */
export const HARNESS_ENABLED = process.env.COMMUNICATION_E2E_HARNESS === "1";

/**
 * Timeouts for turns driven by a real agent process. A local run pays for
 * container start, a shallow git clone, a live Claude session and a model that
 * thinks out loud; a bounded wait that is too short turns a working journey
 * into a red suite. Generous, but never open-ended.
 */
export const AGENT_TURN_TIMEOUT_MS = Number(process.env.E2E_TURN_TIMEOUT_MS ?? 300_000);
/**
 * Ceiling for an agent-permission card to appear (issue #28). A card appears
 * when the LIVE agent asks, and the agent's own behaviour sets that floor: the
 * upstream model stream can stall on a tool call and the agent can retry it.
 *
 * Measured evidence for the budget (lab journal, m2-journey "bob prompts a file
 * write" on the run that failed once in acceptance): prompt accepted 07:29:12;
 * Claude Code's first `Write` tool call opened 07:29:17 and streamed NO input
 * for ~3 minutes (upstream stream stall); the agent retried with a second
 * `Write` at 07:32:20 and `conversation.permission.requested` was published
 * 20ms later — 188s after the prompt, i.e. 8s past the old 180s budget, which
 * is exactly why that assertion went red with the product behaving correctly.
 * The request then expired unanswered at 07:34:21 and the turn ended.
 *
 * So the budget must exceed ONE stalled tool call PLUS the agent's retry of it
 * (≥ 3 min stall + a normal turn's work), not merely "the turn is being
 * built". 420s is one ~3-minute stall, the retry, and a normal turn's answer
 * on top. Helpers never sit this whole budget out on a dead turn: see
 * `waitForOpenPermission` in helpers.ts, which fails as soon as the turn has
 * reached a terminal status with no card to come. Overridable for a runner
 * facing a slower upstream.
 */
export const PERMISSION_TIMEOUT_MS = Number(process.env.E2E_PERMISSION_TIMEOUT_MS ?? 420_000);

/**
 * How long a turn must be seen TERMINAL (`completed`/`cancelled`/`failed`/
 * `stopped — outcome unknown`) with no open permission card before
 * `waitForOpenPermission` gives up on the card. Not instantaneous because the
 * `turn-status` chip can still describe the PREVIOUS turn for a moment after a
 * prompt is accepted (observed: the chip reads `cancelled`/`completed` until
 * the new turn's first event lands), and a stale read must not be reported as
 * a dead turn. Well inside {@link PERMISSION_TIMEOUT_MS}.
 */
export const PERMISSION_TERMINAL_CONFIRM_MS = Number(
  process.env.E2E_PERMISSION_TERMINAL_CONFIRM_MS ?? 30_000,
);
