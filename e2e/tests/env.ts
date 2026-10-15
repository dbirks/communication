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
/** A permission card should appear while the turn is being built, not at the end. */
export const PERMISSION_TIMEOUT_MS = Number(process.env.E2E_PERMISSION_TIMEOUT_MS ?? 180_000);
