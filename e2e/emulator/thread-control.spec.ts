// thread-control.spec.ts — Chats controller handoff in the redesigned Chats UI:
// create chat from NewChatPane, Return control / Take control via ChatHeader's
// ⋯ menu, verifying controller-badge and composer state at both widths.
import { test, expect, apiMutate } from "./fixtures";
import { EMU_ADMIN_STATE, EMU_BASE_URL } from "./env";

test.use({ storageState: EMU_ADMIN_STATE });

test("chat controller handoff: create, return control, take control", async ({
  page,
  request,
  emu,
}) => {
  test.setTimeout(90_000);
  const ts = Date.now().toString(36);
  const projRes = await apiMutate(page, "POST", `${EMU_BASE_URL}/api/v1/projects`, {
    name: `Emu Ctrl ${ts}`,
  });
  expect(projRes.status()).toBe(201);
  const project = (await projRes.json()) as { id: string; name: string };

  const profilesRes = await request.get(`${EMU_BASE_URL}/api/v1/agent-profiles`);
  expect(profilesRes.ok()).toBe(true);
  const profiles = ((await profilesRes.json()) as { items?: { id: string }[] }).items ?? [];
  expect(profiles.length).toBeGreaterThan(0);

  await page.goto(`${EMU_BASE_URL}/p/${project.id}/chats/new`);
  await expect(page.getByTestId("chat-new-pane")).toBeVisible();
  await emu.screen("chats", "new");

  await page.getByTestId("new-chat-agent-picker").click();
  await page.getByTestId(`agent-option-${profiles[0].id}`).click();
  await page.getByTestId("new-chat-prompt-input").fill(`Control handoff probe ${ts}`);
  await page.getByTestId("new-chat-prompt-send").click();

  await expect(page).toHaveURL(new RegExp(`/p/${project.id}/chats/[^/]+$`));
  await expect(page.getByTestId("chat-thread")).toBeVisible();
  await expect(page.getByTestId("controller-badge")).toContainText("you control");
  await emu.screen("chats", "thread");

  // Open header ⋯ menu and Return control.
  await page.getByTestId("chat-menu").click();
  await expect(page.getByTestId("return-control")).toBeVisible();
  await page.getByTestId("return-control").click();

  await expect(page.getByTestId("controller-badge")).toContainText("no controller");

  // Open ⋯ menu again and Take control back.
  await page.getByTestId("chat-menu").click();
  await expect(page.getByTestId("take-control")).toBeVisible();
  await page.getByTestId("take-control").click();

  await expect(page.getByTestId("controller-badge")).toContainText("you control");
  await expect(page.getByTestId("composer-input")).toBeEnabled();
});
