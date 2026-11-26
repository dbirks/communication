// empty-error.spec.ts — honest empty states, T9 approvals-404 on Home All, and
// honest not-found states for /factory/<missing> and /runs/<missing>.
import { test, expect, apiMutate } from "./fixtures";
import { EMU_ADMIN_STATE, EMU_BASE_URL } from "./env";

test.use({ storageState: EMU_ADMIN_STATE });

const MISSING_ID = "00000000-0000-0000-0000-000000000000";

test.describe("empty and not-found states on the redesigned UI", () => {
  test("scoped project home, factory, chats, and repo render clean empty states", async ({
    page,
    emu,
  }) => {
    const ts = Date.now().toString(36);
    const projRes = await apiMutate(page, "POST", `${EMU_BASE_URL}/api/v1/projects`, {
      name: `Emu Empty ${ts}`,
    });
    expect(projRes.status()).toBe(201);
    const project = (await projRes.json()) as { id: string };

    // Fresh project home: no workflows, no repos, nothing happening now.
    await page.goto(`${EMU_BASE_URL}/p/${project.id}`);
    await expect(page.getByTestId("project-home")).toBeVisible();
    await expect(page.getByTestId("happening-now-empty")).toBeVisible();
    await expect(page.getByTestId("repo-list-empty")).toBeVisible();
    await expect(page.getByTestId("workflows-here-empty")).toBeVisible();
    await emu.screen("project", "home");

    // Scoped Factory with zero assigned workflows -> factory-empty card.
    await page.goto(`${EMU_BASE_URL}/p/${project.id}/factory`);
    await expect(page.getByTestId("factory-index")).toBeVisible();
    await expect(page.getByTestId("factory-empty")).toBeVisible();
    await emu.screen("factory", "empty");

    // Chats list filtered with no matches.
    await page.goto(`${EMU_BASE_URL}/p/${project.id}/chats`);
    await expect(page.getByTestId("chats")).toBeVisible();
    await expect(page.getByTestId("chat-list-empty")).toBeVisible();
    await emu.screen("chats", "list");
  });

  test("T9 approvals 404 on Home All shows honest unavailability note", async ({ page, emu }) => {
    emu.expectFailure(/\/api\/v1\/approvals/, 404);
    await page.route("**/api/v1/approvals**", (route) =>
      route.fulfill({
        status: 404,
        contentType: "application/problem+json",
        body: JSON.stringify({ title: "Not Found", status: 404 }),
      }),
    );

    await page.goto(`${EMU_BASE_URL}/`);
    await expect(page.getByTestId("home-all")).toBeVisible();
    await expect(page.getByTestId("home-not-available")).toBeVisible();
    await emu.screen("home", "not-available");
  });

  test("missing workflow and missing run render honest not-found states", async ({ page, emu }) => {
    emu.expectFailure(new RegExp(MISSING_ID), 404);
    await page.goto(`${EMU_BASE_URL}/factory/${MISSING_ID}`);
    await expect(page.getByTestId("studio-error-page")).toBeVisible();
    await emu.screen("editor", "error");

    await page.goto(`${EMU_BASE_URL}/runs/${MISSING_ID}`);
    await expect(page.getByTestId("run-not-found")).toBeVisible();
    await expect(page.getByTestId("run-not-found")).not.toContainText(
      /scaffold|control plane|404/i,
    );
  });
});
