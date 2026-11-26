// projects.spec.ts — Manage -> Projects, Repositories, People, Runners,
// Secrets, Project Home (/p/:id), Repository (/p/:id/:repo), Chats empty
// selection, and honest not-found/refusal states.
import { test, expect, apiMutate } from "./fixtures";
import { EMU_ADMIN_STATE, EMU_ALICE_STATE, EMU_BASE_URL } from "./env";

const MISSING_PROJECT_ID = "00000000-0000-0000-0000-000000000000";

test.describe("admin project & manage journeys", () => {
  test.use({ storageState: EMU_ADMIN_STATE });

  test("create project, add repository, inspect Manage sections and Project Home / Repo", async ({
    page,
    emu,
  }) => {
    test.setTimeout(90_000);
    const ts = Date.now().toString(36);
    const projectName = `Emu Project ${ts}`;
    const repoName = `emu-repo-${ts}`;

    // Manage -> Projects
    await page.goto(`${EMU_BASE_URL}/manage/projects`);
    await expect(page.getByTestId("manage-projects")).toBeVisible();
    await emu.screen("manage", "projects");

    // Create project via New project dialog
    await page.getByTestId("manage-new-project").click();
    await expect(page.getByTestId("create-project-dialog")).toBeVisible();
    await page.getByTestId("create-project-name").fill(projectName);
    await page.getByTestId("create-project-description").fill("Managed by emulator verification");
    await page.getByTestId("create-project-submit").click();

    await expect(page).toHaveURL(/\/manage\/projects\/[^/]+$/);
    await expect(page.getByTestId("manage-project-detail")).toBeVisible();
    await expect(page.getByTestId("detail-name")).toHaveText(projectName);
    await emu.screen("manage", "project-detail");

    const projectId = page.url().split("/manage/projects/")[1];

    // Add repository on Project Detail
    await page.getByTestId("detail-add-repository").click();
    await page.getByTestId("repo-name").fill(repoName);
    await page.getByTestId("repo-git-url").fill("file:///tmp/nonexistent-emu-repo");
    await page.getByTestId("repo-default-branch").fill("main");
    await page.getByTestId("repo-submit").click();

    await expect(page.getByTestId(`detail-repo-${repoName}`)).toBeVisible();

    // Check remaining Manage sections (Repositories, People, Runners, Secrets)
    await page.getByTestId("manage-nav-repositories").click();
    await expect(page.getByTestId("manage-repositories")).toBeVisible();
    await emu.screen("manage", "repositories");

    await page.getByTestId("manage-nav-people").click();
    await expect(page.getByTestId("manage-people")).toBeVisible();
    await emu.screen("manage", "people");

    await page.getByTestId("manage-nav-runners").click();
    await expect(page.getByTestId("manage-runners")).toBeVisible();
    await emu.screen("manage", "runners");

    await page.getByTestId("manage-nav-secrets").click();
    await expect(page.getByTestId("manage-secrets")).toBeVisible();
    await emu.screen("manage", "secrets");

    // Duplicate project name conflict returns 409 inline note
    emu.expectFailure(/\/api\/v1\/projects$/, 409);
    await page.getByTestId("manage-nav-projects").click();
    await page.getByTestId("manage-new-project").click();
    await page.getByTestId("create-project-name").fill(projectName);
    await page.getByTestId("create-project-submit").click();
    await expect(page.getByTestId("create-project-conflict")).toBeVisible();
    await page.getByTestId("create-project-cancel").click();

    // Visit Project Home and Repository page
    await page.goto(`${EMU_BASE_URL}/p/${projectId}`);
    await expect(page.getByTestId("project-home")).toBeVisible();
    await expect(page.getByTestId(`repo-row-${repoName}`)).toBeVisible();
    await emu.screen("project", "home");

    await page.getByTestId(`repo-row-${repoName}`).getByRole("link").click();
    await expect(page).toHaveURL(new RegExp(`/p/${projectId}/${repoName}$`));
    await expect(page.getByTestId("repo-page")).toBeVisible();
    await emu.screen("repo", "detail");

    // Not-found repo inside real project
    await page.goto(`${EMU_BASE_URL}/p/${projectId}/does-not-exist-${ts}`);
    await expect(page.getByTestId("repo-not-found")).toBeVisible();
    await page.getByTestId("repo-back-to-project").click();
    await expect(page).toHaveURL(new RegExp(`/p/${projectId}$`));

    // Missing project UUID
    emu.expectFailure(new RegExp(MISSING_PROJECT_ID), 404);
    await page.goto(`${EMU_BASE_URL}/p/${MISSING_PROJECT_ID}`);
    await expect(page.getByTestId("project-not-found")).toBeVisible();
    await emu.screen("project", "not-found");
  });
});

test.describe("non-member refusal on scoped project home", () => {
  test("alice sees honest refusal on an admin-only project", async ({ browser, emu }) => {
    const adminCtx = await browser.newContext({ storageState: EMU_ADMIN_STATE });
    const adminPage = await adminCtx.newPage();
    const res = await apiMutate(adminPage, "POST", `${EMU_BASE_URL}/api/v1/projects`, {
      name: `Emu Private ${Date.now().toString(36)}`,
    });
    expect(res.status()).toBe(201);
    const project = (await res.json()) as { id: string };
    await adminCtx.close();

    const aliceCtx = await browser.newContext({ storageState: EMU_ALICE_STATE });
    const alicePage = await aliceCtx.newPage();
    await alicePage.goto(`${EMU_BASE_URL}/p/${project.id}`);
    await expect(alicePage.getByTestId("project-home-refused")).toBeVisible();
    await aliceCtx.close();
    void emu;
  });
});
