// M1 exit journey (11-build-roadmap.md, proven manually before ADR-0006 asked
// for it in CI): sign in through the mock OIDC provider, create a project,
// add repositories, see identical state served by both API replicas, watch a
// repository added on replica B appear live on replica A's open page over SSE,
// restart a replica without losing the session or data, and confirm a
// non-member cannot see the project.
//
// Runs against the isolated compose stack (e2e/compose.e2e.yml, project
// `communication-e2e`, ports 28080-28082/28090). Serial by design: every step
// mutates the one shared stack.
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { API_A_URL, API_B_URL, BASE_URL } from "./env.js";
import {
  ADMIN_SUBJECT,
  OUTSIDER_SUBJECT,
  addRepository,
  gotoApp,
  restartComposeServices,
  rowFor,
  signIn,
} from "./helpers.js";

test.describe.configure({ mode: "serial" });

/**
 * Idempotent re-run stamp (the home-cluster suite's rule): a second journey
 * run against a lab that already carries this suite's writes must not fail —
 * an existing project is reused (its slug conflict names it), and the live-
 * update repository gets a run-unique name so "added on B, seen on A" is
 * always a fresh fact, never a leftover row.
 */
const RUN_STAMP = Date.now().toString(36);
const MOBILE_REPO = `mobile-${RUN_STAMP}`;
const MOBILE_URL = `https://example.invalid/${MOBILE_REPO}.git`;

let context: BrowserContext;
let page: Page;
let projectId = ""; // {uuid}, filled by the create step
let projectPath = ""; // /manage/projects/{uuid}

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext();
  page = await context.newPage();
});

test.afterAll(async () => {
  // beforeAll may have failed before the context existed.
  if (context) await context.close();
});

test("sign in through the mock OIDC provider", async () => {
  await signIn(page, ADMIN_SUBJECT);
  await expect(page.getByTestId("user-badge")).toContainText(ADMIN_SUBJECT);
});

test("create the Customer Platform project", async () => {
  // Projects live under Manage → Projects (`/manage/projects`). The create
  // dialog opens automatically on an empty account or via `manage-new-project`.
  await gotoApp(page, "/manage/projects");
  const nameField = page.getByTestId("create-project-name");
  const toggle = page.getByTestId("manage-new-project");
  await expect(nameField.or(toggle).first()).toBeVisible();
  if (!(await nameField.isVisible())) await toggle.click();
  await nameField.fill("Customer Platform");
  await page.getByTestId("create-project-submit").click();
  // Idempotent re-run: on an existing project the 409 shows `create-project-conflict`;
  // close the dialog and open the existing Customer Platform row instead.
  const conflict = page.getByTestId("create-project-conflict");
  if (
    await conflict
      .waitFor({ timeout: 5_000 })
      .then(() => true)
      .catch(() => false)
  ) {
    await page.getByTestId("create-project-cancel").click();
    const repoCell = page.getByTestId("project-repos-customer-platform");
    await expect(repoCell).toBeVisible();
    await repoCell
      .locator('xpath=ancestor::*[starts-with(@data-testid, "manage-projects-table-row-")][1]//a')
      .click();
  }
  await expect(page.getByTestId("detail-name")).toHaveText("Customer Platform");
  projectPath = new URL(page.url()).pathname;
  expect(projectPath).toMatch(/^\/manage\/projects\/[0-9a-f-]{36}$/);
  projectId = projectPath.split("/").pop() ?? "";
});

test("add the frontend and backend repositories", async () => {
  const projectUrl = `${BASE_URL}${projectPath}`;
  for (const [name, gitUrl] of [
    ["frontend", "https://example.invalid/frontend.git"],
    ["backend", "https://example.invalid/backend.git"],
  ] as const) {
    await page.goto(projectUrl);
    await expect(page.getByTestId("detail-repositories")).toBeVisible();
    if ((await rowFor(page, name).count()) > 0) continue;
    await addRepository(page, projectUrl, name, gitUrl);
  }
  await expect(page.getByTestId("detail-repo-list")).toContainText("frontend");
  await expect(page.getByTestId("detail-repo-list")).toContainText("backend");
});

test("both API replicas serve identical state", async ({ request }) => {
  for (const [url, replica] of [
    [API_A_URL, "api-a"],
    [API_B_URL, "api-b"],
  ] as const) {
    const health = (await (await request.get(`${url}/api/v1/system/health`)).json()) as {
      replica?: string;
    };
    expect(health.replica).toBe(replica);
    const direct = await context.newPage();
    await direct.goto(`${url}/manage/projects`);
    await expect(direct.getByTestId("manage-projects-table")).toContainText("Customer Platform");
    await direct.goto(`${url}${projectPath}`);
    await expect(direct.getByTestId("detail-name")).toHaveText("Customer Platform");
    await expect(rowFor(direct, "frontend")).toBeVisible();
    await expect(rowFor(direct, "backend")).toBeVisible();
    await direct.close();
  }
});

test("a repository added on replica B appears live on replica A's open page", async ({
  request,
}) => {
  const healthA = (await (await request.get(`${API_A_URL}/api/v1/system/health`)).json()) as {
    replica?: string;
  };
  expect(healthA.replica).toBe("api-a");
  const pageA = await context.newPage();
  const pageB = await context.newPage();
  try {
    await pageA.goto(`${API_A_URL}${projectPath}`);
    await expect(pageA.getByTestId("detail-name")).toHaveText("Customer Platform");
    await expect(rowFor(pageA, MOBILE_REPO)).toHaveCount(0);

    await addRepository(pageB, `${API_B_URL}${projectPath}`, MOBILE_REPO, MOBILE_URL);
    // No reload on A: the project SSE stream must invalidate the repos query.
    await expect(rowFor(pageA, MOBILE_REPO)).toBeVisible();
  } finally {
    await pageB.close();
    // pageA stays open: the restart step resumes on it.
  }
});

test("restarting api-a keeps the session and the data", async ({ request }) => {
  const pageA = context.pages().find((p) => p.url().startsWith(API_A_URL));
  expect(pageA, "pageA from the SSE step is still open").toBeDefined();

  restartComposeServices("api-a");

  // Readiness (schema current + datastore reachable), not just liveness.
  await expect
    .poll(
      async () => {
        try {
          return (await request.get(`${API_A_URL}/api/v1/system/readiness`)).ok();
        } catch {
          return false;
        }
      },
      { timeout: 60_000, intervals: [1_000] },
    )
    .toBe(true);

  await pageA!.reload();
  await expect(pageA!.getByTestId("user-badge")).toContainText(ADMIN_SUBJECT);
  await expect(pageA!.getByTestId("detail-name")).toHaveText("Customer Platform");
  for (const repo of ["frontend", "backend", MOBILE_REPO]) {
    await expect(rowFor(pageA!, repo)).toBeVisible();
  }
});

test("a non-member gets not found for the project", async ({ browser }) => {
  // A fresh context: no cookies from the admin session.
  const outsiderContext = await browser.newContext();
  const outsider = await outsiderContext.newPage();
  await signIn(outsider, OUTSIDER_SUBJECT);
  await gotoApp(outsider, "/manage/projects");
  await expect(outsider.getByTestId("manage-projects-table-empty")).toBeVisible();
  await expect(
    outsider.getByTestId("manage-projects-table-empty").getByText("No projects yet"),
  ).toBeVisible();
  await gotoApp(outsider, `/manage/projects/${projectId}`);
  await expect(outsider.getByTestId("detail-not-found")).toBeVisible();
  await outsiderContext.close();
});
