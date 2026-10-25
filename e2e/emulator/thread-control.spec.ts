// Journey: thread control handoff (the composer belongs to the controller).
//
// Alice starts a thread (like journeys.spec.ts' thread, name-stamped
// `Emu ctrl <passId>`), returns control to the agent — the composer then
// honestly refuses her ("Only the controller can prompt.") — and takes
// control back: the composer is enabled for her again. Screenshots at each
// beat.
import { expect, test } from "./fixtures.js";
import { EMU_ALICE_STATE, EMU_PASS_ID } from "./env.js";

test.describe("thread-control (alice)", () => {
  test.describe.configure({ mode: "serial", timeout: 8 * 60_000 });
  test.use({ storageState: EMU_ALICE_STATE });

  test("return control, then take it back — the composer follows the controller", async ({
    page,
    emu,
  }) => {
    await test.step("start a thread", async () => {
      await page.goto("/threads");
      await expect(page.getByTestId("threads-page")).toBeVisible({ timeout: 30_000 });
      await page.getByTestId("threads-new-open").click();
      const dialog = page.getByTestId("new-conversation-dialog");
      await expect(dialog).toBeVisible();
      const projectSelect = dialog.getByTestId("new-conversation-dialog-project");
      const firstProject = projectSelect.locator("option").nth(1);
      await expect(firstProject, "a writable project is offered for a new thread").toBeAttached();
      await projectSelect.selectOption({ label: (await firstProject.textContent())?.trim() ?? "" });
      await page.getByTestId("conversation-new-title").fill(`Emu ctrl ${EMU_PASS_ID}`);
      const profileSelect = page.getByTestId("conversation-new-profile");
      const firstProfile = profileSelect.locator("option").nth(1);
      await expect(firstProfile, "an agent profile is offered for the new thread").toBeAttached();
      await profileSelect.selectOption({ label: (await firstProfile.textContent())?.trim() ?? "" });
      await page.getByTestId("conversation-new-submit").click();
      await page.waitForURL(/\/threads\/[0-9a-f-]{36}$/, { timeout: 30_000 });
      await expect(page.getByTestId("conversation-title")).toBeVisible({ timeout: 30_000 });
    });

    await test.step("the starter is the controller: composer enabled", async () => {
      await expect(
        page.getByTestId("composer-input"),
        "the thread starter controls the agent: the composer is enabled",
      ).toBeEnabled({ timeout: 30_000 });
    });

    await test.step("return control — the composer honestly locks", async () => {
      const give = page.getByTestId("return-control");
      await expect(
        give,
        "design 4f: the controller can hand control back with `Return control`",
      ).toBeVisible({ timeout: 30_000 });
      await give.click({ timeout: 20_000 });
      await expect(
        page.getByTestId("take-control"),
        "design 4f: after returning control, `Take control` appears",
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        page.getByTestId("composer-input"),
        "a non-controller cannot prompt: the composer is disabled",
      ).toBeDisabled({ timeout: 30_000 });
      await emu.screen("threads-1g", "not-controller");
    });

    await test.step("take control back — composer enabled for this user", async () => {
      await page.getByTestId("take-control").click({ timeout: 20_000 });
      await expect(
        page.getByTestId("composer-input"),
        "design 4f: after `Take control`, the composer is enabled for this user",
      ).toBeEnabled({ timeout: 30_000 });
      await expect(
        page.getByTestId("controller-badge"),
        "design 4f: the controller line says this user is in control",
      ).toContainText(/control/i, { timeout: 30_000 });
      await emu.screen("threads-1g", "took-control");
    });
  });
});
