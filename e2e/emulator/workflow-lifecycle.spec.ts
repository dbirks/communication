// Journey: the workflow lifecycle (design 1c → 1g → 1e → 2d → 2a).
//
//   admin (library role): create "Emu lc <passId>" from the "Plan with
//   approval" template → Studio: edit one step's prompt in the inspector,
//   Validate, Save, Publish.
//   alice (maintainer of the seeded "M4 Exit" project — the org admin has no
//   project membership, so the `Use in a repo…` dialog would honestly show
//   "no projects" for admin): open the workflow page → YAML tab (block
//   style) → Used in tab (empty state) → `Use in a repo…` → pick the
//   project + repo → the repo now lists under Used in.
//
// Names are pass-stamped; created workflows stay in the library (they are
// pass-stamped and cannot collide).
import { expect, test } from "./fixtures.js";
import { EMU_ALICE_STATE, EMU_ADMIN_STATE, EMU_PASS_ID } from "./env.js";

const NAME = `Emu lc ${EMU_PASS_ID}`;

/** Hand-off from the admin authoring test to the alice use-in-repo test. */
let pipelineId = "";

test.describe("workflow-lifecycle (admin authors)", () => {
  test.describe.configure({ mode: "serial", timeout: 10 * 60_000 });
  test.use({ storageState: EMU_ADMIN_STATE });

  test("create from the plan-with-approval template, edit, validate, save, publish", async ({
    page,
    emu,
  }) => {
    await test.step("1c — create from 'Plan with approval'", async () => {
      await page.goto("/workflows");
      await expect(page.getByTestId("workflows-new-workflow")).toBeVisible({ timeout: 30_000 });
      await page.getByTestId("workflows-new-workflow").click();
      await expect(page.getByTestId("new-workflow-dialog")).toBeVisible();
      // A duplicated slug would 409 inline (declared, not a defect); the
      // name is pass-stamped so it should not fire.
      emu.expectFailure(/\/api\/v1\/pipelines$/, 409);
      await page.getByTestId("library-new-name-input").fill(NAME);
      await page.getByTestId("new-workflow-template-plan-with-approval").click();
      await page.getByTestId("library-new-submit").click();
      await page.waitForURL(/\/workflows\/[0-9a-f-]{36}\/drafts\/[0-9a-f-]{36}$/, {
        timeout: 30_000,
      });
      const match = new URL(page.url()).pathname.match(/\/workflows\/([0-9a-f-]{36})\//);
      pipelineId = match?.[1] ?? "";
      expect(pipelineId, "the studio route carries the new pipeline's id").toMatch(
        /^[0-9a-f-]{36}$/,
      );
      await expect(page.getByTestId("studio-page")).toBeVisible({ timeout: 30_000 });
    });

    await test.step("1g — edit one step's prompt in the inspector", async () => {
      // Click the plan node on the canvas (falls back to other flow nodes);
      // its inspector opens on the node card. "What should it do?" is
      // insp-config-task on a model.chat step and insp-config-prompt on an
      // agent.acp step — either counts as the step's prompt text.
      const promptText = page
        .getByTestId("insp-config-task")
        .or(page.getByTestId("insp-config-prompt"))
        .first();
      for (const id of ["plan", "survey", "approve", "publish_plan"]) {
        const node = page.getByTestId(`canvas-step-${id}`);
        if (!(await node.isVisible().catch(() => false))) continue;
        await node.click();
        await expect(page.getByTestId("insp-node")).toBeVisible({ timeout: 10_000 });
        if (await promptText.isVisible({ timeout: 1_000 }).catch(() => false)) break;
      }
      const prompt = promptText;
      await expect(
        prompt,
        "design 1g: some step of the plan-with-approval template exposes its prompt text (insp-config-task / insp-config-prompt)",
      ).toBeVisible({ timeout: 10_000 });
      const before = await prompt.inputValue();
      await prompt.fill(`${before}\n\n(emu edit ${EMU_PASS_ID})`);
      await prompt.blur().catch(() => undefined);
      await expect(
        page.getByTestId("studio-dirty"),
        "design 1g: editing the inspector marks the draft dirty",
      ).toBeVisible({ timeout: 10_000 });
      await emu.screen("1g", "inspector-edit");
    });

    await test.step("1g — Save, Validate, Publish", async () => {
      // The publish gate is `saved bytes + the server's valid verdict` on the
      // CURRENT revision (Studio.tsx): save first, then validate, then
      // publish — validating before saving leaves the verdict stale.
      await page.getByTestId("studio-save").click({ timeout: 20_000 });
      await expect(
        page.getByTestId("studio-dirty"),
        "design 1g: Save clears the dirty flag",
      ).toHaveCount(0, { timeout: 30_000 });
      await page.getByTestId("studio-validate").click({ timeout: 20_000 });
      const verdict = page.getByTestId("studio-validate-verdict");
      await expect(
        verdict,
        "design 1g: Validate reports a server verdict",
      ).toBeVisible({ timeout: 30_000 });
      await expect(verdict, "design 1g: the template + one prompt edit is valid").toContainText(
        /(^|[^a-z])valid/i,
        { timeout: 30_000 },
      );
      await page.getByTestId("studio-publish").click({ timeout: 20_000 });
      // Publish lands the workflow: the studio shows the published state.
      await expect(
        page.getByTestId("studio-published"),
        "design 1g: Publish succeeds and the studio shows the published state",
      ).toBeVisible({ timeout: 60_000 });
    });
  });
});

test.describe("workflow-lifecycle (alice uses it in a repo)", () => {
  test.describe.configure({ mode: "serial", timeout: 20 * 60_000 });
  test.use({ storageState: EMU_ALICE_STATE });

  test("workflow page 1e, YAML 2d, Used in 2a, Use in a repo…", async ({ page, emu }) => {
    test.skip(!pipelineId, "the authoring step did not produce a pipeline id");

    await test.step("1e — the workflow page", async () => {
      await page.goto(`/workflows/${pipelineId}`);
      await expect(
        page.getByTestId("pipeline-page"),
        "design 1e: the workflow page renders (pipeline-page)",
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        page.getByRole("heading", { name: NAME, exact: true }).first(),
        "design 1e: the page header names the workflow",
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        page.getByTestId("workflow-tab-used-in"),
        "design 1e: the tab row is Overview / YAML / Used in / History",
      ).toBeVisible();
      await emu.screen("1e", "workflow");
    });

    await test.step("2d — the YAML tab renders block style", async () => {
      await page.getByTestId("workflow-tab-yaml").click();
      const yaml = page.getByTestId("workflow-yaml-tab");
      await expect(yaml).toBeVisible({ timeout: 30_000 });
      const text = await yaml.innerText();
      expect(text.length, "design 2d: the YAML tab renders the revision text").toBeGreaterThan(
        200,
      );
      expect(text, "design 2d: the YAML is multi-line").toContain("\n");
      expect(
        text,
        "design 2d: block style — no inline `{ … }` maps in the rendered YAML",
      ).not.toMatch(/:\s*\{/);
      expect(text, "design 2d: the emu prompt edit is in the published YAML").toContain(
        `emu edit ${EMU_PASS_ID}`,
      );
      await emu.screen("2d", "yaml");
    });

    await test.step("2a — Used in starts empty, honestly", async () => {
      await page.getByTestId("workflow-tab-used-in").click();
      const empty = page.getByTestId("used-in-empty");
      await expect(empty, "design 2a: a fresh workflow has an honest empty state").toBeVisible({
        timeout: 30_000,
      });
      await expect(
        empty,
        "design 2a: the empty line reads 'Not used in any repo yet'",
      ).toContainText(/Not used in any repo yet/i);
      await emu.screen("2a", "used-in-empty");
    });

    await test.step("2a — Use in a repo… pins it to M4 Exit / app", async () => {
      await page.getByTestId("assign-open").click();
      const dialog = page.getByTestId("use-in-repo-dialog");
      await expect(dialog, "design: 'Use in a repo…' opens a dialog").toBeVisible();
      await emu.screen("2a", "use-dialog");
      const projectSelect = dialog.getByTestId("assign-project-select");
      await expect(projectSelect, "the dialog offers a project you maintain").toBeVisible();
      await projectSelect.selectOption({ label: "M4 Exit" }, { timeout: 20_000 });
      const repoSelect = dialog.getByTestId("assign-repo-select");
      await expect(repoSelect).toBeVisible();
      await repoSelect.selectOption({ label: "app" }, { timeout: 20_000 });
      await dialog.getByTestId("assign-confirm").click({ timeout: 20_000 });
      // The success panel is transient — the dialog may close on its own.
      await Promise.race([
        page
          .getByTestId("assign-success-panel")
          .waitFor({ state: "visible", timeout: 30_000 })
          .then(() =>
            expect(
              page.getByTestId("assign-success-panel"),
              "design: the dialog confirms the pin",
            ).toBeVisible(),
          ),
        dialog.waitFor({ state: "hidden", timeout: 30_000 }),
      ]);
      // Re-read the Used in tab from its own route.
      await page.keyboard.press("Escape");
      await expect(dialog, "the dialog closes after the pin").toBeHidden({ timeout: 15_000 });
      await page.goto(`/workflows/${pipelineId}/used-in`);
      const list = page.getByTestId("used-in-list");
      await expect(
        list,
        "design 2a: after pinning, the repo shows under Used in",
      ).toContainText(/app/i, { timeout: 30_000 });
      await emu.screen("2a", "used-in-assigned");
    });
  });
});
