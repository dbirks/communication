// Playwright config for the "play the user" emulator (e2e/emulator).
//
// Runs against the M4 lab (compose project `communication-m4`, app at
// http://localhost:18091) — NEVER the dev stack's 1808x ports. Shares the
// parent e2e package's node_modules; run from `e2e/` as:
//   pnpm exec playwright test -c emulator/playwright.config.ts
//
// The suite is one shared mutable lab, exactly like the M1 journey: one
// worker, serial, no retries — a replay would hit the state the previous
// attempt created.
import { defineConfig } from "@playwright/test";
import { EMU_BASE_URL } from "./env.js";

export default defineConfig({
  testDir: "./",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  // Artifacts (traces/failure screenshots) go to the parent suite's
  // gitignored test-results/ — nothing new to ignore in the repo.
  outputDir: "../test-results/emulator",
  reporter: [["list"]],
  use: {
    baseURL: EMU_BASE_URL,
    // The journey's acting viewport; emu.screen() drops to 390×844 for its
    // capture and restores this.
    viewport: { width: 1280, height: 900 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "off",
  },
  projects: [
    // Signs in once per pass and saves the storage states the journeys load.
    { name: "setup", testMatch: "setup.spec.ts" },
    {
      name: "journeys",
      // Every journey spec except the setup one (one shared lab: serial,
      // one worker, no retries — see the header).
      testMatch: /.*\.spec\.ts/,
      testIgnore: "setup.spec.ts",
      dependencies: ["setup"],
    },
  ],
});
