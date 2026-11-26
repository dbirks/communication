// server-error.spec.ts — 500 primary-read error states across redesigned
// routes: Home All, Project Home, Factory index, Studio editor, Chats list,
// Repository page, and Manage sections.
import { test, expect, apiMutate } from "./fixtures";
import { EMU_ADMIN_STATE, EMU_BASE_URL } from "./env";

test.use({ storageState: EMU_ADMIN_STATE });

const problem500 = {
  status: 500,
  contentType: "application/problem+json",
  body: JSON.stringify({
    title: "Internal Server Error",
    status: 500,
    detail: "synthetic upstream read failure for emulator verification",
  }),
};

test.describe("500 primary-read error handling across the redesigned UI", () => {
  test("Factory index, Chats list, Manage runners render honest ProblemBanners on 500", async ({
    page,
    emu,
  }) => {
    emu.expectFailure(/\/api\/v1\/pipelines/, 500);
    emu.expectFailure(/\/api\/v1\/conversations/, 500);
    emu.expectFailure(/\/api\/v1\/workers/, 500);

    await page.route("**/api/v1/pipelines**", (route) => route.fulfill(problem500));
    await page.goto(`${EMU_BASE_URL}/factory`);
    await expect(page.getByTestId("factory-load-error")).toBeVisible();
    await emu.screen("factory", "error");
    await page.unroute("**/api/v1/pipelines**");

    await page.route("**/api/v1/conversations**", (route) => route.fulfill(problem500));
    await page.goto(`${EMU_BASE_URL}/chats`);
    await expect(page.getByTestId("chat-list-error")).toBeVisible();
    await emu.screen("chats", "error");
    await page.unroute("**/api/v1/conversations**");

    await page.route("**/api/v1/workers**", (route) => route.fulfill(problem500));
    await page.goto(`${EMU_BASE_URL}/manage/runners`);
    await expect(page.getByRole("alert").first()).toBeVisible();
    await emu.screen("manage", "error");
  });

  test("Project Home, Repository, and Studio editor stay structured when reads fail", async ({
    page,
    emu,
  }) => {
    const ts = Date.now().toString(36);
    const projRes = await apiMutate(page, "POST", `${EMU_BASE_URL}/api/v1/projects`, {
      name: `Emu Server Err ${ts}`,
    });
    expect(projRes.status()).toBe(201);
    const project = (await projRes.json()) as { id: string };

    emu.expectFailure(new RegExp(`/api/v1/projects/${project.id}`), 500);
    emu.expectFailure(/\/api\/v1\/pipelines\/00000000-0000-0000-0000-000000000001/, 500);

    // Project Home 500
    await page.route(`**/api/v1/projects/${project.id}`, (route) => route.fulfill(problem500));
    await page.goto(`${EMU_BASE_URL}/p/${project.id}`);
    await expect(page.getByTestId("project-home-error")).toBeVisible();
    await emu.screen("project", "error");
    await page.unroute(`**/api/v1/projects/${project.id}`);

    // Repository read 500 keeps page chrome + alert
    await page.route(`**/api/v1/projects/${project.id}/repos**`, (route) =>
      route.fulfill(problem500),
    );
    await page.goto(`${EMU_BASE_URL}/p/${project.id}/some-repo`);
    await expect(page.getByTestId("repo-error-page")).toBeVisible();
    await emu.screen("repo", "error");
    await page.unroute(`**/api/v1/projects/${project.id}/repos**`);

    // Studio pipeline read 500
    await page.route(`**/api/v1/pipelines/00000000-0000-0000-0000-000000000001**`, (route) =>
      route.fulfill(problem500),
    );
    await page.goto(`${EMU_BASE_URL}/factory/00000000-0000-0000-0000-000000000001`);
    await expect(page.getByTestId("studio-error-page")).toBeVisible();
    await emu.screen("editor", "error");
  });
});
