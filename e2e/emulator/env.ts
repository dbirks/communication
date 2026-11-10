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
 * One design render directory plus the badge namespace it owns (see
 * `EMU_DESIGN_DIRS`). A badge resolves inside a directory only when it
 * carries that directory's prefix, and the file looked up is the badge with
 * the prefix cut off.
 */
export interface EmuDesignDir {
  dir: string;
  /**
   * The badge prefix this directory answers, "" when the badge IS the file
   * name (the older handoffs, which use the bare 1a…3e badges).
   */
  prefix: string;
}

/**
 * The design render directories the report pairs app screenshots with. The
 * Workflows Review renders live under docs/design/handoff-workflows/png/ and
 * the Projects Review ones under docs/design/handoff-projects/png/, both by
 * bare badge. handoff-repo-chat-nav reuses the SAME badge range (1a…3e) for
 * different screens, so its badges are namespaced with the `rcn-` prefix:
 * `rcn-3a` loads docs/design/handoff-repo-chat-nav/png/3a.png while `3a`'s
 * absence (and every older badge's identity) is untouched — the namespace is
 * the loader's, the render files are never renamed.
 */
export const EMU_DESIGN_DIRS: EmuDesignDir[] = [
  { dir: path.join(repoRoot, "docs", "design", "handoff-workflows", "png"), prefix: "" },
  { dir: path.join(repoRoot, "docs", "design", "handoff-projects", "png"), prefix: "" },
  { dir: path.join(repoRoot, "docs", "design", "handoff-repo-chat-nav", "png"), prefix: "rcn-" },
  // The Assistant handoff (docs/design/assistant-handoff): popover.png,
  // dock.png and page.png are the prototype's 1280 renders of as-popover,
  // as-dock and as-page; as-settings has no render (exempt).
  { dir: path.join(repoRoot, "docs", "design", "assistant-handoff", "png"), prefix: "as-" },
];

/** Repo root, for reports. */
export const EMU_REPO_ROOT = repoRoot;
