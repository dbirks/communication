// Shared fixtures for the e2e journey specs. Subjects are throwaway identities
// handed to the mock OIDC provider's interactive login form (ADR-0012) — they
// are not credentials and nothing secret crosses this code.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Locator, type Page } from "@playwright/test";
import { AGENT_TURN_TIMEOUT_MS, COMPOSE_FILES, COMPOSE_PROJECT } from "./env.js";

/** Throwaway mock-IdP subjects used across the suite. */
export const ADMIN_SUBJECT = "admin";
export const OUTSIDER_SUBJECT = "mallory";

/**
 * Navigate inside the app, tolerating the one window where the load balancer
 * has no healthy upstream: right after a replica restart, caddy can answer 502
 * for a few seconds (observed in the M1 restart → next-test handoff), and a
 * blank error page is what makes a later locator hang instead of fail.
 */
export async function gotoApp(page: Page, path = "/"): Promise<void> {
  for (let attempt = 1; attempt <= 10; attempt++) {
    const response = await page.goto(path, { waitUntil: "domcontentloaded" });
    if (response && response.ok()) return;
    await page.waitForTimeout(1_000);
  }
  throw new Error(`the app never answered 200 for ${path} on ${page.url()}`);
}

/**
 * Sign in through the mock OIDC provider: the app's `sign-in` link leaves the
 * SPA for `/auth/login`, which redirects to the IdP's interactive form
 * (`Enter any user/subject` + optional claims JSON — no real credentials).
 *
 * `claims` are written into the IdP's "Optional claims JSON" box, which is how
 * a journey gets a readable profile (`name`, `email`) instead of the bare
 * subject — the app derives a display name from the id token (ADR-0012 §4).
 */
export async function signIn(
  page: Page,
  subject: string,
  claims?: Record<string, unknown>,
): Promise<void> {
  await gotoApp(page, "/");
  await page.getByTestId("sign-in").click();
  const subjectField = page.getByPlaceholder("Enter any user/subject");
  await expect(subjectField).toBeVisible();
  await subjectField.fill(subject);
  if (claims) {
    const claimsField = page.getByPlaceholder(/Optional claims JSON/);
    await expect(claimsField).toBeVisible();
    await claimsField.fill(JSON.stringify(claims));
  }
  await page.getByRole("button", { name: "Sign-in" }).click();
  // The redirect chain lands back on the SPA with a session cookie set.
  await expect(page.getByTestId("user-badge")).toBeVisible();
}

/** Add a repository through the project page form and wait for its row. */
export async function addRepository(
  page: Page,
  projectUrl: string,
  name: string,
  gitUrl: string,
): Promise<void> {
  await page.goto(projectUrl);
  await revealAddForm(page, "repo-add-toggle", page.getByTestId("repo-name"));
  await page.getByTestId("repo-name").fill(name);
  await page.getByTestId("repo-git-url").fill(gitUrl);
  await page.getByTestId("repo-submit").click();
  await expect(rowFor(page, name)).toBeVisible();
}

/**
 * The overview's add-forms are collapsed behind a toggle (open by default only
 * on an empty project), so a helper must open the form before filling it.
 */
async function revealAddForm(page: Page, toggleTestid: string, firstField: Locator): Promise<void> {
  const toggle = page.getByTestId(toggleTestid);
  // The toggle renders as soon as the panel knows the viewer is a maintainer;
  // waiting on it avoids racing the SPA's first data fetch.
  await expect(toggle.or(firstField).first()).toBeVisible();
  if (!(await firstField.isVisible())) {
    await toggle.click();
  }
  await expect(firstField).toBeVisible();
}

/** The repo table row for a given repository name. */
export function rowFor(page: Page, name: string) {
  return page.getByTestId(`repo-row-${name}`);
}

/** Select the `<select>` whose option text mentions `text`, by that option's value. */
export async function selectByOptionText(page: Page, testid: string, text: string): Promise<void> {
  const select = page.getByTestId(testid);
  const option = select.locator("option", { hasText: text });
  await expect(option.first()).toBeAttached();
  const value = await option.first().getAttribute("value");
  await select.selectOption(value ?? "");
}

/** Add `displayName` to the project as a member with `role`. */
export async function addMember(
  page: Page,
  projectUrl: string,
  displayName: string,
  role: string,
): Promise<void> {
  await page.goto(projectUrl);
  await revealAddForm(page, "member-add-toggle", page.getByTestId("member-user"));
  await selectByOptionText(page, "member-user", displayName);
  await page.getByTestId("member-role").selectOption(role);
  await page.getByTestId("member-submit").click();
  await expect(page.getByTestId(`member-row-${displayName}`)).toContainText(`role: ${role}`);
}

/** Start a conversation from the project page; resolves to its app path. */
export async function startConversation(
  page: Page,
  projectUrl: string,
  options: { title: string; profile: string; prompt: string },
): Promise<string> {
  await page.goto(projectUrl);
  await page.getByTestId("conversation-new-title").fill(options.title);
  await selectByOptionText(page, "conversation-new-profile", options.profile);
  await page.getByTestId("conversation-new-prompt").fill(options.prompt);
  await page.getByTestId("conversation-new-submit").click();
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}\/conversations\/[0-9a-f-]{36}$/);
  return new URL(page.url()).pathname;
}

/** Send a prompt from an open conversation page (the controller's composer). */
export async function sendPrompt(page: Page, prompt: string): Promise<void> {
  const composer = page.getByTestId("composer-input");
  await expect(composer).toBeEnabled();
  await composer.fill(prompt);
  await page.getByTestId("composer-send").click();
  // The prompt is accepted into the journal, not echoed by the response body.
  await expect(page.getByTestId("composer-input")).toHaveValue("");
}

/**
 * Wait for the newest turn to reach a terminal status. `turn-status` is the
 * page's one description of the turn (`describeTurn`), and a real agent turn is
 * measured in model round-trips, not milliseconds.
 */
export async function expectTurnStatus(
  page: Page,
  status: RegExp,
  timeout = AGENT_TURN_TIMEOUT_MS,
): Promise<void> {
  await expect(page.getByTestId("turn-status")).toContainText(status, { timeout });
}

/** The permission card that is still waiting for a human, if any. */
export function openPermissionCard(page: Page): Locator {
  return page.getByTestId("permission-card").filter({ hasText: "awaiting a decision" });
}

/**
 * Allow the open permission request as the controller, preferring the
 * allow-once option (Claude's `"Yes"`) over an "always allow" that would stop
 * the journey from ever asking again. Resolves once that exact request is
 * journalled as decided with the chosen option, and returns the option label.
 *
 * Note the trap this avoids: `openPermissionCard` filters on "awaiting a
 * decision", so a decided card stops matching it — asserting "says decided"
 * through that filter can never be true. The closed state is read from an
 * unfiltered card instead.
 */
export async function allowOpenPermission(page: Page, timeout = AGENT_TURN_TIMEOUT_MS) {
  const pending = openPermissionCard(page);
  await expect(pending).toHaveCount(1, { timeout });
  const yes = pending.getByRole("button", { name: "Yes", exact: true });
  const chosen = (await yes.count()) > 0 ? yes.first() : pending.getByTestId("permission-allow");
  const label = (await chosen.textContent())?.trim() ?? "";
  await chosen.click();
  const decided = label
    ? page.getByTestId("permission-card").filter({ hasText: `answered "${label}"` })
    : page.getByTestId("permission-card").filter({ hasText: "status: decided" });
  await expect(decided).toHaveCount(1, { timeout });
  return label;
}

/** Become the controller, retrying a read that went stale mid-flight (§9 CAS). */
export async function takeControl(page: Page, timeout = 120_000): Promise<void> {
  await expect
    .poll(
      async () => {
        const back = page.getByTestId("return-control");
        if (await back.isVisible().catch(() => false)) return true;
        const btn = page.getByTestId("take-control");
        if (await btn.isEnabled().catch(() => false))
          await btn.click({ timeout: 5_000 }).catch(() => {});
        return false;
      },
      { timeout, intervals: [1_000] },
    )
    .toBe(true);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Restart services through the same compose invocation the suite runs against
 * (`E2E_COMPOSE_FILES`), never a raw container id, so the e2e project's own
 * layers decide what a restart means.
 */
export function restartComposeServices(...services: string[]): void {
  const args = ["compose", "-p", COMPOSE_PROJECT];
  for (const file of COMPOSE_FILES) args.push("-f", file);
  execFileSync("docker", [...args, "restart", ...services], {
    cwd: repoRoot,
    stdio: "pipe",
    timeout: 180_000,
  });
}
