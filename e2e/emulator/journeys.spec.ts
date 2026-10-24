// The emulator's first journeys — the screens the design already has.
// Journeys are added as screens land; each step name matches its screen
// (test.step), and every screen goes through `emu.screen(badge, name)`.
//
// The journeys play the DESIGN, not whatever the UI happens to show today:
// if a design element is missing, the journey FAILS with a clear assertion
// message and the fixture records it as a kind=assertion defect — the loop
// is supposed to turn the design into a clean pass, not walk around the
// old UI.
//
// Screen badges pair with docs/design/handoff-workflows/png/<badge>.png
// (1b 1c 1e 1g 2a 2c 2d 2e); the Projects Review badges will land later
// under docs/design/handoff-projects/png/.
import { expect, test } from "./fixtures.js";
import { EMU_ALICE_STATE, EMU_ADMIN_STATE, EMU_PASS_ID } from "./env.js";

/**
 * 1b — the /workflows index: H1 "Workflows", the starter cards, the list.
 * 1c — the New workflow dialog: name field, START FROM cards, Cancel +
 *      "Create and open canvas".
 * 1g — Workflow Studio: the canvas view after creating from the
 *      "Plan with approval" template.
 */
test.describe("workflows-index", () => {
  test.describe.configure({ mode: "serial", timeout: 5 * 60_000 });
  test.use({ storageState: EMU_ADMIN_STATE });

  test("index, the new-workflow dialog, and Studio from a template", async ({ page, emu }) => {
    await test.step("1b — the workflows index", async () => {
      await page.goto("/workflows");
      await expect(
        page.getByRole("heading", { name: "Workflows", level: 1 }),
        "design 1b: the H1 reads 'Workflows' (not 'Pipeline library' or similar)",
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        page.getByTestId("workflow-starters"),
        "design 1b: the starter cards sit above the list (START BLANK + one card per template)",
      ).toBeVisible();
      await expect(
        page.getByTestId("workflows-new-workflow"),
        "design 1b: one primary 'New workflow' button in the header",
      ).toBeVisible();
      await emu.screen("1b", "index");
    });

    await test.step("1c — the New workflow dialog", async () => {
      await page.getByTestId("workflows-new-workflow").click();
      const dialog = page.getByTestId("new-workflow-dialog");
      await expect(
        dialog,
        "design 1c: 'New workflow' opens a dialog, not an inline form",
      ).toBeVisible();
      await expect(dialog.getByRole("heading", { name: "New workflow" })).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Create and open canvas" }),
        "design 1c: the primary action is 'Create and open canvas'",
      ).toBeVisible();
      await emu.screen("1c", "new-workflow");
    });

    await test.step("1g — create from 'Plan with approval' and land in Studio", async () => {
      // A duplicated slug would 409 inline in the dialog (an expected,
      // declared failure — the journey reads the error and fixes the name);
      // the names are pass-stamped, so this should not fire.
      emu.expectFailure(/\/api\/v1\/pipelines$/, 409);
      await page.getByTestId("library-new-name-input").fill(`Emu plan ${EMU_PASS_ID}`);
      const plan = page.getByTestId("new-workflow-template-plan-with-approval");
      await expect(
        plan,
        "design 1c: 'Plan with approval' is one of the START FROM cards in the dialog",
      ).toBeVisible();
      await plan.click();
      await page.getByTestId("library-new-submit").click();
      // Creation lands on the draft's Studio route — the template's canvas,
      // not a raw YAML dump (design 1g).
      await page.waitForURL(/\/workflows\/[0-9a-f-]{36}\/drafts\/[0-9a-f-]{36}$/, {
        timeout: 30_000,
      });
      await expect(
        page.getByTestId("studio-page"),
        "design 1g: creating from the template lands on the Workflow Studio",
      ).toBeVisible({ timeout: 30_000 });
      await emu.screen("1g", "studio");
    });
  });
});

/**
 * The cross-project thread: start one from /threads (the page's own New
 * thread dialog), send one message, and read the thread page.
 *
 * The journey is alice's — the seeded M4 lab gives the org admin (admin) no
 * project membership, and a thread starts in a project workspace, so the
 * org admin would hit the dialog's honest "No projects where you can start
 * a thread" instead of the design.
 */
test.describe("thread", () => {
  test.describe.configure({ mode: "serial", timeout: 5 * 60_000 });
  test.use({ storageState: EMU_ALICE_STATE });

  test("start a thread from /threads and send one message", async ({ page, emu }) => {
    await test.step("the thread list", async () => {
      await page.goto("/threads");
      await expect(
        page.getByTestId("threads-page"),
        "the /threads page renders its cross-project list",
      ).toBeVisible({ timeout: 30_000 });
    });

    await test.step("start a thread", async () => {
      await page.getByTestId("threads-new-open").click();
      const dialog = page.getByTestId("new-conversation-dialog");
      await expect(dialog).toBeVisible();
      const projectSelect = dialog.getByTestId("new-conversation-dialog-project");
      const firstProject = projectSelect.locator("option").nth(1);
      await expect(firstProject, "a writable project is offered for a new thread").toBeAttached();
      await projectSelect.selectOption({ label: (await firstProject.textContent())?.trim() ?? "" });
      await page.getByTestId("conversation-new-title").fill(`Emu thread ${EMU_PASS_ID}`);
      const profileSelect = page.getByTestId("conversation-new-profile");
      const firstProfile = profileSelect.locator("option").nth(1);
      await expect(firstProfile, "an agent profile is offered for the new thread").toBeAttached();
      await profileSelect.selectOption({ label: (await firstProfile.textContent())?.trim() ?? "" });
      await page.getByTestId("conversation-new-submit").click();
      await page.waitForURL(/\/threads\/[0-9a-f-]{36}$/, { timeout: 30_000 });
      await expect(page.getByTestId("conversation-title")).toBeVisible({ timeout: 30_000 });
    });

    await test.step("send one message", async () => {
      const composer = page.getByTestId("composer-input");
      await expect(composer, "the controller's composer is enabled").toBeEnabled({
        timeout: 30_000,
      });
      await composer.fill("Hello from the emulator — this pass is scripted, not human.");
      await page.getByTestId("composer-send").click();
      // The prompt is accepted into the journal (the composer clears); the
      // turn itself is not waited for — the screen is the claim.
      await expect(page.getByTestId("composer-input")).toHaveValue("");
      await emu.screen("threads-1g", "thread");
    });
  });
});
