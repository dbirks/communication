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
import { EMU_ALICE_STATE, EMU_ADMIN_STATE, EMU_OUT_DIR, EMU_PASS_ID } from "./env.js";
import path from "node:path";

/** Escape a pass-scoped value before matching it as page text. */
const reEscape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * 1b — the /workflows index: H1 "Workflows", the starter cards, the list.
 * 1b folders — the same index with a workflow filed in a folder (ADR-0049
 *      § 8): one panel per folder, the header carries the folder name and the
 *      group's own count. Driven through the row's `⋯` menu → `Move to
 *      folder…`, exactly as a user files a workflow; the workflow is filed
 *      back to Unfiled at the end of the step.
 * 1c — the New workflow dialog: name field, START FROM cards, Cancel +
 *      "Create and open canvas".
 * 1g — Workflow Studio: the canvas view after creating from the
 *      "Plan with approval" template.
 */
test.describe("workflows-index", () => {
  test.describe.configure({ mode: "serial", timeout: 5 * 60_000 });
  test.use({ storageState: EMU_ADMIN_STATE });

  test("index, the new-workflow dialog, and Studio from a template", async ({ page, emu }) => {
    // This pass's own workflow, created by the 1g step and filed into a
    // folder by the 1b folders step: both names carry the pass id, so a
    // replay never collides with an earlier pass's rows.
    const workflowName = `Emu plan ${EMU_PASS_ID}`;
    const folderName = `emu-${EMU_PASS_ID}`;

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
      await page.getByTestId("library-new-name-input").fill(workflowName);
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

    // Design 1b groups workflows into folder panels and offers `Move to
    // folder…` in each row's menu (ADR-0049 § 8). Nothing else in the suite
    // ever files a workflow, so without this step the folder view is
    // unproven. The workflow moved here is the one THIS pass just created,
    // and it is filed back to Unfiled before the step ends: the folder dies
    // with the pass and no later screen (or journey) sees it.
    await test.step("1b folders — file it in a folder through the row menu", async () => {
      await page.goto("/workflows");
      const row = page
        .locator('[data-testid^="workflow-row-"]')
        .filter({ hasText: workflowName })
        .first();
      await expect(
        row,
        "design 1b: the workflow this pass created is a row in the index",
      ).toBeVisible({ timeout: 30_000 });
      const slug = ((await row.getAttribute("data-testid")) ?? "").replace(/^workflow-row-/, "");
      expect(slug.length, "the row's testid carries its slug (the menu's hook)").toBeGreaterThan(0);

      // The user's path: the row's `⋯` menu, never a PATCH behind its back.
      await row.getByTestId(`workflow-menu-${slug}`).click();
      const moveToFolder = page.getByRole("menuitem", { name: /move to folder/i });
      await expect(
        moveToFolder,
        "design 1b: the row's menu offers 'Move to folder…'",
      ).toBeVisible();
      await moveToFolder.click();

      const dialog = page.getByTestId("move-folder-dialog");
      await expect(dialog, "'Move to folder…' opens a dialog with a folder field").toBeVisible();
      await page.getByTestId("move-folder-input").fill(folderName);
      await page.getByTestId("move-folder-submit").click();
      await expect(dialog, "the dialog closes once the move is written").toBeHidden({
        timeout: 30_000,
      });

      // The folder is a panel of its own, headed by its name and its count,
      // and the moved row is inside it — not in the unfiled list beside it.
      const folderHeader = page
        .locator('[data-testid^="workflow-folder-header-"]')
        .filter({ hasText: new RegExp(reEscape(folderName), "i") });
      await expect(
        folderHeader,
        "design 1b: the folder renders as a panel whose header names it",
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        folderHeader,
        "design 1b: the header is the group's collapse toggle, and this group is open",
      ).toHaveAttribute("aria-expanded", "true");
      await expect(
        folderHeader,
        `design 1b: the folder header counts its own workflows (one: ${folderName})`,
      ).toHaveText(new RegExp(`^${reEscape(folderName)}\\D*1$`, "i"));

      const folderPanel = page.locator("section").filter({ has: folderHeader });
      await expect(
        folderPanel.locator('[data-testid^="workflow-row-"]'),
        "the folder panel holds exactly the one workflow filed in it",
      ).toHaveCount(1);
      await expect(
        folderPanel,
        `the moved workflow sits inside its folder panel (${folderName})`,
      ).toContainText(workflowName);
      await expect(
        page.getByTestId("workflow-unfiled-group").getByTestId(`workflow-row-${slug}`),
        "the moved row is gone from the unfiled list below the panels",
      ).toHaveCount(0);

      await emu.screen("1b", "folders");
    });

    await test.step("1b folders — file it back so the pass leaves the index as it found it", async () => {
      const row = page
        .locator('[data-testid^="workflow-row-"]')
        .filter({ hasText: workflowName })
        .first();
      const slug = ((await row.getAttribute("data-testid")) ?? "").replace(/^workflow-row-/, "");
      await row.getByTestId(`workflow-menu-${slug}`).click();
      await page.getByRole("menuitem", { name: /move to folder/i }).click();
      const dialog = page.getByTestId("move-folder-dialog");
      await expect(dialog, "the dialog opens again to unfile").toBeVisible();

      // The dialog's way back is its `Unfiled` quick-pick, and one chip per
      // folder is the contract. The index hands the dialog a folder list that
      // already ends in `Unfiled` (`folderNames` in ui/src/pages/Workflows.tsx,
      // line 578) while the dialog always renders its own `Unfiled` chip after
      // the list (WorkflowRow.tsx) — so the chip is drawn twice, same label and
      // same data-testid. Not cosmetic: the LEFT one is an ordinary folder chip,
      // so clicking it types the word "Unfiled" into the folder field and files
      // the row in a folder literally named Unfiled; only the dialog's own chip
      // (rendered last) clears. Soft, because the blocking defect is a few lines
      // below and the pass should record both.
      const unfiledChips = page.getByTestId("move-folder-option-unfiled");
      const chipCount = await unfiledChips.count();
      const chipRow = (
        await dialog.locator('[data-testid^="move-folder-option-"]').allTextContents()
      ).join(" | ");
      if (chipCount !== 1) {
        await dialog.screenshot({
          path: path.join(EMU_OUT_DIR, "move-folder-dialog-defect.png"),
        });
      }
      expect
        .soft(
          chipCount,
          `'Move to folder…' offers one Unfiled quick-pick; this dialog drew ${chipCount} ` +
            `("${chipRow.slice(0, 90)}"): the index's folder list already ends in Unfiled and the ` +
            "dialog adds its own, so the left-hand one files the row in a folder NAMED " +
            "'Unfiled' instead of unfileing it; both carry " +
            "data-testid=move-folder-option-unfiled. " +
            `Evidence: out/${EMU_PASS_ID}/move-folder-dialog-defect.png`,
        )
        .toBe(1);

      await unfiledChips.last().click();
      await expect(
        page.getByTestId("move-folder-input"),
        "the dialog's own Unfiled chip clears the folder field",
      ).toHaveValue("");
      await page.getByTestId("move-folder-submit").click();
      // An empty folder is the dialog's documented unfile ("leave it empty to
      // unfile"), so the write is `PATCH {folder: null}` — PipelineUpdate says
      // `folder: [string, "null"]`, `null` clears it. The dialog closes only if
      // the server took it; if it stays open it is showing the rejection inline
      // (Playwright's failure screenshot catches that).
      await expect(
        dialog,
        "filing a workflow back as unfiled closes the dialog — an empty folder is the " +
          "dialog's own unfile path (PATCH {folder:null}); if it stayed open the write was " +
          "rejected (see the api defect: PATCH /api/v1/pipelines/{id} -> 4xx)",
      ).toBeHidden({ timeout: 30_000 });
      await expect(
        page
          .locator('[data-testid^="workflow-folder-header-"]')
          .filter({ hasText: new RegExp(reEscape(folderName), "i") }),
        "the empty folder is gone — no panel, no stale group",
      ).toHaveCount(0);
      await expect(
        page.getByTestId("workflow-unfiled-group").getByTestId(`workflow-row-${slug}`),
        "the workflow is back in the unfiled list, where the rest of the suite finds it",
      ).toBeVisible({ timeout: 30_000 });
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
