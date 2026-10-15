// Playwright Test project for the M1 journey (ADR-0006, 12-test-strategy E2E).
//
// The suite runs against the real compose stack on the isolated 2808x port
// range (e2e/compose.e2e.yml, project name `communication-e2e`) — never
// against mocks, and never against the dev stack's 1808x ports.
import { defineConfig, devices } from "@playwright/test";
import { BASE_URL } from "./tests/env.js";

export default defineConfig({
  testDir: "./tests",
  // The stack is shared mutable state (one Postgres, restarts in-flight):
  // run the serial journey as one chain, one worker, no retries — a retry
  // would replay against the state the earlier attempts mutated.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  outputDir: "test-results",
  reporter: [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]],
  use: {
    baseURL: BASE_URL,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
