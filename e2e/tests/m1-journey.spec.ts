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

let context: BrowserContext;
let page: Page;
let projectPath = ""; // /projects/{uuid}, filled by the create step

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
  // The projects index (with the create form) moved from `/` to `/projects`
  // with the app-shell redesign; `/` is now the Home briefing. The form
  // starts open on an empty account (CI's fresh stack); on an account that
  // already has projects it is collapsed behind the toggle.
  await gotoApp(page, "/projects");
  const nameField = page.getByTestId("create-project-name");
  const toggle = page.getByTestId("new-project-toggle");
  // On a fresh account the form is already open, so both the field and the
  // ("Close") toggle are visible: take the first match to satisfy strict mode.
  await expect(nameField.or(toggle).first()).toBeVisible();
  if (!(await nameField.isVisible())) await toggle.click();
  await nameField.fill("Customer Platform");
  await page.getByTestId("create-project-submit").click();
  await expect(page.getByTestId("project-name")).toHaveText("Customer Platform");
  projectPath = new URL(page.url()).pathname;
  expect(projectPath).toMatch(/^\/p\/[0-9a-f-]{36}$/);
});

test("add the frontend and backend repositories", async () => {
  const projectUrl = `${BASE_URL}${projectPath}`;
  await addRepository(page, projectUrl, "frontend", "https://example.invalid/frontend.git");
  await addRepository(page, projectUrl, "backend", "https://example.invalid/backend.git");
  await expect(page.getByTestId("repo-list")).toContainText("frontend");
  await expect(page.getByTestId("repo-list")).toContainText("backend");
});

test("both API replicas serve identical state", async () => {
  // The session cookie is host-only (cookies ignore ports), so pages opened
  // directly on :28081/:28082 reuse the sign-in that completed via the load
  // balancer — proof the session lives in the shared database, not a replica.
  for (const [url, replica] of [
    [API_A_URL, "api-a"],
    [API_B_URL, "api-b"],
  ] as const) {
    const direct = await context.newPage();
    await direct.goto(`${url}/projects`);
    await expect(direct.getByTestId("project-list")).toContainText("Customer Platform");
    await direct.goto(`${url}${projectPath}`);
    await expect(direct.getByTestId("project-name")).toHaveText("Customer Platform");
    await expect(direct.getByTestId(`repo-row-frontend`)).toBeVisible();
    await expect(direct.getByTestId(`repo-row-backend`)).toBeVisible();
    await expect(direct.getByTestId("replica-badge")).toHaveText(`replica: ${replica}`);
    await direct.close();
  }
});

test("a repository added on replica B appears live on replica A's open page", async () => {
  const pageA = await context.newPage();
  const pageB = await context.newPage();
  try {
    await pageA.goto(`${API_A_URL}${projectPath}`);
    await expect(pageA.getByTestId("replica-badge")).toHaveText("replica: api-a");
    await expect(rowFor(pageA, "mobile")).toHaveCount(0);

    await addRepository(
      pageB,
      `${API_B_URL}${projectPath}`,
      "mobile",
      "https://example.invalid/mobile.git",
    );
    // No reload on A: the project SSE stream must invalidate the repos query.
    await expect(rowFor(pageA, "mobile")).toBeVisible();
    await expect(rowFor(pageA, "mobile")).toContainText("https://example.invalid/mobile.git");
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
  await expect(pageA!.getByTestId("project-name")).toHaveText("Customer Platform");
  for (const repo of ["frontend", "backend", "mobile"]) {
    await expect(rowFor(pageA!, repo)).toBeVisible();
  }
});

test("a non-member gets not found for the project", async ({ browser }) => {
  // A fresh context: no cookies from the admin session.
  const outsiderContext = await browser.newContext();
  const outsider = await outsiderContext.newPage();
  await signIn(outsider, OUTSIDER_SUBJECT);
  await gotoApp(outsider, "/projects");
  // The project list card grid is absent; the index shows its empty state.
  // Scope the text check inside the empty state: the sidebar's projects
  // section renders the same phrase ("no projects yet") on every page, so a
  // page-level getByText matches both (strict mode).
  await expect(outsider.getByTestId("project-list-empty")).toBeVisible();
  await expect(
    outsider.getByTestId("project-list-empty").getByText("No projects yet"),
  ).toBeVisible();
  await gotoApp(outsider, projectPath);
  await expect(outsider.getByTestId("project-not-found")).toBeVisible();
  await outsiderContext.close();
});
