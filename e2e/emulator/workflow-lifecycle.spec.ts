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

    await test.step("1g — the studio speaks of a WORKFLOW, not a pipeline", async () => {
      // Design 1g copy: the authoring surface is the workflow's YAML, so that
      // is what its editor is named. The YAML view is the one place the studio
      // spelled this object out, so the journey opens it, reads the name, and
      // confirms the view toggle carried the edit across.
      await page.getByTestId("studio-view-yaml").click({ timeout: 20_000 });
      const editor = page.getByLabel("Workflow YAML");
      await expect(
        editor,
        "design 1g: the studio's YAML editor is labelled 'Workflow YAML'",
      ).toBeVisible({ timeout: 20_000 });
      await expect(
        page.getByLabel("Pipeline YAML"),
        "design 1g: the old 'Pipeline YAML' label is gone",
      ).toHaveCount(0);
      expect(
        await editor.inputValue(),
        "design 1g: switching to the YAML view shows the bytes just edited",
      ).toContain(`emu edit ${EMU_PASS_ID}`);
      await page.getByTestId("studio-view-canvas").click({ timeout: 20_000 });
      await expect(
        page.getByTestId("studio-canvas"),
        "design 1g: and the canvas comes back with its node",
      ).toBeVisible({ timeout: 20_000 });
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
      // Design 2d copy (the 390 check): the export button reads the plain word
      // `download` — the filename moved to its title/accessible name, where it
      // can no longer be cut to `…-r1.ya…` on the bar.
      await expect(
        page.getByTestId("yaml-view-download"),
        "design 2d: the export button's label is 'download'",
      ).toHaveText("download", { timeout: 30_000 });
      await expect(
        page.getByRole("button", { name: /^download .*\.yaml$/ }),
        "design 2d: the button still names the file it writes, in its accessible name",
      ).toBeVisible({ timeout: 30_000 });
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
      // The read SUCCEEDED, so a zero is a true answer and the tab may carry
      // it (`Overview YAML Used in 0 History` is the design's tab row). What it
      // must never do is show `0` over a broken read — server-error.spec.ts
      // proves the tab says `?` there instead.
      await expect(
        page.getByTestId("workflow-used-in-count"),
        "design 1e/2a: a completed read lets the tab count honestly (`Used in 0`)",
      ).toHaveText("0", { timeout: 30_000 });
      await expect(
        page.getByTestId("workflow-tab-used-in"),
        "design 1e: the tab row reads `Used in 0` when nothing uses the workflow",
      ).toContainText(/Used in 0/);
      await emu.screen("2a", "used-in-empty");
    });

    await test.step("2a — Use in a repo… pins it to M4 Exit / app", async () => {
      await page.getByTestId("assign-open").click();
      const dialog = page.getByTestId("use-in-repo-dialog");
      await expect(dialog, "design: 'Use in a repo…' opens a dialog").toBeVisible();
      const title = dialog.getByTestId("use-in-repo-title");
      await expect(
        title,
        "design 2a: before anything is chosen the dialog is still the plain question",
      ).toHaveText("Use in a repo…", { timeout: 20_000 });
      // The projects list is READ-ONLY bookkeeping: it says where the workflow
      // is already pinned and nothing else. The pass-2 review retired the
      // per-row `Use here` button, so the project select below is the ONE way
      // to choose — assert no row offers a second way.
      const states = dialog.getByTestId("assign-project-states");
      await expect(
        states,
        "design 2a: the dialog shows where each project stands (read-only bookkeeping)",
      ).toBeVisible({ timeout: 30_000 });
      const m4Row = states.locator("li").filter({ hasText: "M4 Exit" });
      await expect(
        m4Row,
        "design 2a: 'M4 Exit' is named there, with its pin line",
      ).toHaveCount(1);
      await expect(
        m4Row.getByTestId(/^assign-project-pin-/),
        "design 2a: the state is honest words — 'not used yet' / 'pins r<n>'",
      ).toContainText(/not used yet|pins r/i, { timeout: 30_000 });
      await expect(
        states.locator("button"),
        "design 2a: that list is read-only — no `Use here` button anywhere; the project select is the ONE way to choose",
      ).toHaveCount(0);
      await expect(
        dialog.getByTestId(/^assign-pick-/),
        "design 2a: the retired per-row `assign-pick-*` affordance does not come back",
      ).toHaveCount(0);
      // Choose the project — the repo select appears — and record the dialog
      // in the state a person actually acts on (design 2a's one project+repo
      // select, not the empty question).
      const projectSelect = dialog.getByTestId("assign-project-select");
      await expect(projectSelect, "the dialog offers a project you maintain").toBeVisible();
      await projectSelect.selectOption({ label: "M4 Exit" }, { timeout: 20_000 });
      const repoSelect = dialog.getByTestId("assign-repo-select");
      await expect(
        repoSelect,
        "design 2a: the project select reveals the repository select (the one way to name a repo)",
      ).toBeVisible({ timeout: 30_000 });
      await emu.screen("2a", "use-dialog");
      await repoSelect.selectOption({ label: "app" }, { timeout: 20_000 });
      await expect(
        title,
        "design 2a (1c rule): once a repo is chosen the dialog is named for what it will do",
      ).toHaveText("Use in app", { timeout: 20_000 });
      // The 1c footer: Cancel first, the primary verb last, both on the right.
      await expect
        .poll(
          async () =>
            (
              await dialog
                .locator('[data-testid="assign-cancel"], [data-testid="assign-confirm"]')
                .allInnerTexts()
            )
              .map((text) => text.trim())
              .join(" | "),
          {
            message: "the dialog's footer reads Cancel then Confirm (in that order)",
            timeout: 20_000,
          },
        )
        .toBe("Cancel | Confirm");
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
      // The count the panel header and the tab carry is now the truth the read
      // answered, and this workflow is pinned in exactly one repo.
      await expect(
        page.locator("#used-in-heading"),
        "design 2a: the panel header counts the use it just made",
      ).toHaveText("USED IN 1 REPOS", { timeout: 30_000 });
      await expect(
        page.getByTestId("workflow-used-in-count"),
        "design 1e/2a: the tab carries the same count",
      ).toHaveText("1", { timeout: 30_000 });
      await emu.screen("2a", "used-in-assigned");
    });
  });
});
