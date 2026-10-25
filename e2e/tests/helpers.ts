// Shared fixtures for the e2e journey specs. Subjects are throwaway identities
// handed to the mock OIDC provider's interactive login form (ADR-0012) — they
// are not credentials and nothing secret crosses this code.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
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
  // The IdP redirect chain ends on the lab's own embedded UI origin (the
  // OIDC callback is registered there); the session cookie is shared per
  // host, so a fresh navigation to the app under test (baseURL) is signed in.
  // Every later relative `page.goto` in the suite resolves against baseURL,
  // so the suite works on the dev server's live tree from here on.
  await gotoApp(page, "/");
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

/**
 * Open the overview's collapsed add-form, retrying the toggle. Under heavy
 * live churn (workspace rows updating, parallel members saving) the toggle
 * click can land on a re-rendering header and be lost, leaving the form
 * closed. The reveal is therefore retried — bounded, and each retry re-reads
 * the page — before giving up.
 */
export async function revealAddFormRetrying(
  page: Page,
  toggleTestid: string,
  firstField: Locator,
  attempts = 4,
): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (await firstField.isVisible().catch(() => false)) return;
    const toggle = page.getByTestId(toggleTestid);
    await expect(toggle).toBeVisible();
    await toggle.click();
    const opened = await firstField
      .waitFor({ state: "visible", timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    if (opened) return;
    // The click was lost: reload the overview and try the toggle again.
    await page.reload();
  }
  throw new Error(`the ${toggleTestid} form never opened after ${attempts} attempts`);
}

/** `addMember`, but the form reveal survives a lost toggle click. */
export async function addMemberRetrying(
  page: Page,
  projectUrl: string,
  displayName: string,
  role: string,
): Promise<void> {
  await page.goto(projectUrl);
  await revealAddFormRetrying(page, "member-add-toggle", page.getByTestId("member-user"));
  await selectByOptionText(page, "member-user", displayName);
  await page.getByTestId("member-role").selectOption(role);
  await page.getByTestId("member-submit").click();
  await expect(page.getByTestId(`member-row-${displayName}`)).toContainText(`role: ${role}`);
}

/**
 * Idempotent member setup. The overview's add form is collapsed behind the
 * "Add member" toggle, and a single click can lose a race with the panel's
 * live re-render — the toggle's click lands but the field never mounts, so the
 * shared `revealAddForm`'s one-shot click times out. This helper first takes
 * the fast path (the row already carries the target role — true once a prior
 * run added the member) and only otherwise opens the form, RE-CLICKING the
 * toggle in a bounded loop until the user select is actually present. The add
 * flow is add-OR-update (PUT), so a seeded role is corrected through it.
 */
export async function setMember(
  page: Page,
  projectUrl: string,
  displayName: string,
  role: string,
): Promise<void> {
  await page.goto(projectUrl);
  const row = page.getByTestId(`member-row-${displayName}`);
  if ((await row.count()) > 0 && ((await row.textContent()) ?? "").includes(`role: ${role}`)) {
    return;
  }
  const toggle = page.getByTestId("member-add-toggle");
  const field = page.getByTestId("member-user");
  await expect(toggle).toBeVisible({ timeout: 30_000 });
  for (let attempt = 0; attempt < 6 && (await field.count()) === 0; attempt += 1) {
    if (!(await toggle.isVisible().catch(() => false))) continue;
    await toggle.click();
    await field.waitFor({ state: "visible", timeout: 5_000 }).catch(() => {});
  }
  await expect(field).toBeVisible();
  await selectByOptionText(page, "member-user", displayName);
  await page.getByTestId("member-role").selectOption(role);
  await page.getByTestId("member-submit").click();
  await expect(row).toContainText(`role: ${role}`);
}

/** Start a conversation from the project page; resolves to its app path. */
export async function startConversation(
  page: Page,
  projectUrl: string,
  options: { title: string; profile: string; prompt: string },
): Promise<string> {
  await page.goto(projectUrl);
  // The create form lives in a dialog; open it before the fields exist.
  await page.getByTestId("conversations-new-open").click();
  await page.getByTestId("new-conversation-dialog").waitFor();
  await page.getByTestId("conversation-new-title").fill(options.title);
  await selectByOptionText(page, "conversation-new-profile", options.profile);
  await page.getByTestId("conversation-new-prompt").fill(options.prompt);
  await page.getByTestId("conversation-new-submit").click();
  // The standalone thread page (route contract C1: conversations live at
  // `/threads/:conversationId`; the old `/projects/…/conversations/…` URL
  // redirects to it, but the canonical target is what is asserted).
  await page.waitForURL(/\/threads\/[0-9a-f-]{36}$/);
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

/**
 * A screenshot of the current screen into the repo's gitignored browser
 * output directory (`.playwright-cli/`) — never into the working tree, and
 * never a build artifact a human has to clean up afterwards.
 */
export async function shot(page: Page, name: string): Promise<string> {
  const dir = path.join(repoRoot, ".playwright-cli");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

/**
 * The `data-testid` suffix the app itself computes for an id
 * (`ui/src/lib/format.ts`'s `testidOf`: first 13 alphanumeric characters, so
 * UUIDs that differ only in their fourth group cannot collide). A journey that
 * must name one row out of a list has to spell the id the same way the page
 * does.
 */
export function testidOf(id: string): string {
  return id.replace(/[^A-Za-z0-9]/g, "").slice(0, 13);
}

/** The tail an id is *shown* by (`shortId` in the same file): last 8 characters. */
export function shortRefOf(id: string): string {
  return id.slice(-8);
}

/**
 * Pin a project's pipeline assignment to an exact published revision so that
 * NEW runs start from that revision (re-pinning is effective at new-run
 * creation only; running runs keep their snapshot). A SETUP call — the journey
 * that follows starts the run through the UI. `page.request` shares the
 * signed-in browser session, and the CSRF token is echoed exactly the way the
 * app's `apiFetch` does it (from `GET /api/v1/me`).
 *
 * Creates the assignment when the pipeline has none yet, otherwise re-pins the
 * existing row. Resolves the revision's uuid from its `sha256:…` digest (route
 * 13 accepts a digest as its id, ADR-0021 § 5).
 */
export async function repinAssignment(
  page: Page,
  projectId: string,
  pipelineId: string,
  revisionDigest: string,
): Promise<void> {
  const me = (await (await page.request.get("/api/v1/me")).json()) as { csrf_token: string };
  const headers = { "x-csrf-token": me.csrf_token };
  const revision = (await (
    await page.request.get(`/api/v1/revisions/${revisionDigest}`)
  ).json()) as { id: string };
  const list = (await (
    await page.request.get(`/api/v1/projects/${projectId}/assignments`)
  ).json()) as { assignments: { id: string; pipeline_id: string }[] };
  const existing = (list.assignments ?? []).find((entry) => entry.pipeline_id === pipelineId);
  if (existing) {
    const response = await page.request.patch(`/api/v1/assignments/${existing.id}`, {
      data: { pinned_revision_id: revision.id },
      headers,
    });
    if (!response.ok())
      throw new Error(`re-pin failed (${response.status()}): ${await response.text()}`);
    return;
  }
  const response = await page.request.post(`/api/v1/projects/${projectId}/assignments`, {
    data: { pipeline_id: pipelineId, pinned_revision_id: revision.id },
    headers,
  });
  if (!response.ok()) {
    throw new Error(`create assignment failed (${response.status()}): ${await response.text()}`);
  }
}

/**
 * Open a project from the project list by its slug; resolves to its app path
 * (`/p/<uuid>`, route contract C1), which every section link is built from.
 */
export async function openProjectBySlug(page: Page, slug: string): Promise<string> {
  // The project list is its own page now (route contract C1: `/projects`);
  // the home briefing no longer renders the project cards.
  await gotoApp(page, "/projects");
  await page.getByTestId(`project-link-${slug}`).click();
  await expect(page.getByTestId("project-name")).toBeVisible();
  return new URL(page.url()).pathname;
}

/**
 * Wait for the run inspector's own statement of the run's status. The chip is
 * the page's single description of it (`RunStatusChip`), and a real run is
 * measured in worker polls, not milliseconds — so the wait is bounded here and
 * nowhere else.
 */
export async function expectRunStatus(page: Page, status: RegExp, timeout: number): Promise<void> {
  await expect(page.getByTestId("run-header-status")).toContainText(status, { timeout });
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Regression gate for the app-shell redesign: the old top app bar is gone —
 * Sidebar v3 replaced it, so no `header` or `nav` may carry the old bar's
 * `aria-label="Primary"` any more. The sidebar's own `aside` (a complementary
 * region, not a header or nav) may keep the label; that is not the app bar.
 */
export async function expectNoLegacyAppBar(page: Page): Promise<void> {
  await expect(page.locator('header[aria-label="Primary"]')).toHaveCount(0);
  await expect(page.locator('nav[aria-label="Primary"]')).toHaveCount(0);
}

/**
 * Restart services through the same compose invocation the suite runs against
 * (`E2E_COMPOSE_FILES`), never a raw container id, so the e2e project's own
 * layers decide what a restart means.
 */
export function restartComposeServices(...services: string[]): void {
  const args = ["compose", "-p", COMPOSE_PROJECT];
  for (const file of COMPOSE_FILES) args.push("-f", file);
  args.push("restart", ...services);
  execDocker(args);
}

/**
 * The env the compose layers interpolate against. `compose.real.yml` marks
 * the gateway key vars REQUIRED (`:?`) — docker compose resolves them on
 * EVERY subcommand, `restart` included, even though a restart never applies
 * new config. A runner that started the lab with these exported does not
 * hand them to the Playwright process, so fall back to the documented host
 * file (the file form compose.real.yml itself names): only the variables
 * that are absent get filled, and the key's contents never leave the child
 * environment (nothing here prints them).
 */
function composeInterpolationEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const keyFile =
    env.COMMUNICATION_LLM_API_KEY_HOST_FILE ??
    path.join(process.env.HOME ?? "", ".config", "communication", "llmc-api-key");
  if (!env.COMMUNICATION_LLM_API_KEY_HOST_FILE && existsSync(keyFile)) {
    env.COMMUNICATION_LLM_API_KEY_HOST_FILE = keyFile;
  }
  if (!env.LLMC_API_KEY && existsSync(keyFile)) {
    env.LLMC_API_KEY = readFileSync(keyFile, "utf8").trim();
  }
  return env;
}

/**
 * Run one docker command against the daemon. On this host the runner user
 * is not in the `docker` group — the socket refuses it (`permission denied
 * … docker.sock`) — while passwordless sudo is available, so the first
 * permission-denied answer falls back to `sudo -n -E docker` and every later
 * call goes straight there.
 */
let dockerNeedsSudo = false;
function execDocker(args: string[]): Buffer {
  const env = composeInterpolationEnv();
  const run = (prefix: string[]) =>
    execFileSync(prefix[0], [...prefix.slice(1), ...args], {
      cwd: repoRoot,
      env,
      stdio: "pipe",
      timeout: 180_000,
    });
  if (dockerNeedsSudo) return run(["sudo", "-n", "-E", "docker"]);
  try {
    return run(["docker"]);
  } catch (error) {
    const message = `${(error as { stderr?: Buffer | string }).stderr ?? error}`;
    if (!/permission denied.*docker\.sock/i.test(message)) throw error;
    dockerNeedsSudo = true;
    return run(["sudo", "-n", "-E", "docker"]);
  }
}
