// Shared configuration for the "play the user" emulator (e2e/emulator).
//
// The emulator plays a real user in a real browser against the lab
// (compose project `communication-m4`, app at http://localhost:18091).
// `localhost`, not 127.0.0.1 — the session cookie is set for `localhost`.
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The lab the emulator plays against (env-overridable for other labs). */
export const EMU_BASE_URL = process.env.EMU_BASE_URL ?? "http://localhost:18091";

/**
 * Which pass this run is. `loop.sh` sets `EMU_PASS_ID=pass-<n>-<timestamp>`;
 * a one-off run derives a stable id from the test runner's PID — the
 * setup and journey projects run in separate worker processes, so the
 * default must be identical in both (their parent is the same runner).
 * The id names the output directory and the journey's created resources.
 */
export const EMU_PASS_ID = process.env.EMU_PASS_ID ?? `emu-p${process.ppid}`;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
/** e2e/emulator — the harness's home. */
const emulatorDir = path.resolve(repoRoot, "e2e", "emulator");

/** e2e/emulator/out/<passId> — screenshots, results.json, report, storage state. */
export const EMU_OUT_DIR = path.join(emulatorDir, "out", EMU_PASS_ID);

/** The pass's signed-in browser states (written once by the setup project). */
export const EMU_ADMIN_STATE = path.join(EMU_OUT_DIR, "admin.json");
export const EMU_ALICE_STATE = path.join(EMU_OUT_DIR, "alice.json");

/**
 * The design render directories the report pairs app screenshots with. The
 * Workflows Review renders live today; Projects Review badges will arrive
 * under docs/design/handoff-projects/png/ and are picked up automatically.
 */
export const EMU_DESIGN_DIRS = [
  path.join(repoRoot, "docs", "design", "handoff-workflows", "png"),
  path.join(repoRoot, "docs", "design", "handoff-projects", "png"),
];

/** Repo root, for reports. */
export const EMU_REPO_ROOT = repoRoot;
