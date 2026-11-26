// workflow-lifecycle.spec.ts — workflow authoring lifecycle in the redesigned
// Factory + Studio editor: describe, edit YAML, validate, Make live, view
// published revision + Download YAML, Use in project, and Used-in drawer.
import { test, expect, apiMutate } from "./fixtures";
import { EMU_ADMIN_STATE, EMU_BASE_URL } from "./env";

test.use({ storageState: EMU_ADMIN_STATE });

test("workflow lifecycle: describe, edit YAML, validate, Make live, Use in project", async ({
  page,
  emu,
}) => {
  test.setTimeout(120_000);
  const ts = Date.now().toString(36);
  const projectName = `Emu WF Life ${ts}`;

  const projRes = await apiMutate(page, "POST", `${EMU_BASE_URL}/api/v1/projects`, {
    name: projectName,
    description: "Workflow lifecycle verification project",
  });
  expect(projRes.status()).toBe(201);
  const project = (await projRes.json()) as { id: string; name: string };

  // Start in Factory and open New workflow sheet -> Describe it -> Sketch it.
  await page.goto(`${EMU_BASE_URL}/factory`);
  await expect(page.getByTestId("factory-index")).toBeVisible();
  await page.getByTestId("factory-new").click();
  await expect(page.getByTestId("new-workflow-sheet")).toBeVisible();

  await page.getByTestId("new-workflow-description").fill(`Verify repo changes ${ts}`);
  await page.getByTestId("new-workflow-sketch").click();

  await expect(page).toHaveURL(/\/factory\/([^/?]+)\?draft=([^&]+)/);
  await expect(page.getByTestId("studio-page")).toBeVisible();
  const match = page.url().match(/\/factory\/([^/?]+)/);
  const pipelineId = match![1];

  // Open YAML drawer via ⋯ menu -> author valid step config -> validate.
  await page.getByTestId("editor-more-btn").click();
  await page.getByTestId("editor-menu-yaml").click();
  await expect(page.getByTestId("editor-panel-yaml")).toBeVisible();
  const yamlBox = page.getByTestId("studio-yaml");
  await expect(yamlBox).toBeVisible();

  const currentYaml = await yamlBox.inputValue();
  const slugMatch = currentYaml.match(/^  name: (.+)$/m);
  const slug = slugMatch ? slugMatch[1].trim() : `verify-repo-changes-${ts}`;
  const validYaml = [
    "apiVersion: communication.dev/v1alpha1",
    "kind: Pipeline",
    "metadata:",
    `  name: ${slug}`,
    "spec:",
    "  inputs:",
    "    type: object",
    "  outputs:",
    "    type: object",
    "  nodes:",
    "    - id: first",
    "      kind: process.exec",
    "      config:",
    "        executable: echo",
    '        args: ["ok"]',
    "",
  ].join("\n");
  await yamlBox.fill(validYaml);
  await page.getByTestId("studio-yaml-validate").click();
  await expect(page.getByTestId("studio-yaml-verdict")).toHaveText("valid", { timeout: 15_000 });
  await expect(page.getByTestId("studio-yaml-findings")).toHaveCount(0);
  await emu.screen("editor", "yaml");

  await page.getByTestId("editor-panel-close").click();
  await expect(page.getByTestId("editor-panel-yaml")).toBeHidden();

  // Make live -> creates r1 revision.
  await page.getByTestId("studio-publish").click();
  await expect(page.getByTestId("studio-published")).toBeVisible({ timeout: 20_000 });

  // View the published r1 revision via Versions -> open YAML drawer -> Download ("Download").
  await page.getByTestId("editor-versions-btn").click();
  await expect(page.getByTestId("versions-select-v1")).toBeVisible();
  await page.getByTestId("versions-select-v1").click();
  await page.getByTestId("versions-panel-close").click();

  await page.getByTestId("editor-more-btn").click();
  await page.getByTestId("editor-menu-yaml").click();
  await expect(page.getByTestId("editor-panel-yaml")).toBeVisible();
  await expect(
    page.getByTestId("editor-panel-yaml").getByRole("button", { name: /^Download\b/ }),
  ).toBeVisible();
  await page.getByTestId("editor-panel-close").click();

  // Exit historical view if active ("Back to your draft" or "Back to live"), then Use in project.
  const backBtn = page.getByTestId("version-back-to-draft");
  if (await backBtn.isVisible().catch(() => false)) {
    await backBtn.click();
  }
  await page.getByTestId("editor-more-btn").click();
  await page.getByTestId("editor-menu-use").click();
  await expect(page.getByTestId("assign-form")).toBeVisible();
  await page.getByTestId("assign-project-select").selectOption(project.id);
  await page.getByTestId("assign-repo-select").selectOption("__whole__");
  await page.getByTestId("assign-confirm").click();
  await expect(page.getByTestId("assign-success-panel")).toBeVisible();
  await page.getByTestId("assign-start-run-link").click();

  await expect(page.getByTestId("editor-panel-used-in")).toBeVisible();
  await expect(page.getByTestId("editor-panel-used-in")).toContainText(/pinned.*r1/i);
  await emu.screen("editor", "used-in");

  // Scoped Factory & Project home both reflect the pinned workflow.
  await page.goto(`${EMU_BASE_URL}/p/${project.id}/factory`);
  await expect(page.getByTestId(`workflow-card-${pipelineId}`)).toBeVisible();
  await page.goto(`${EMU_BASE_URL}/p/${project.id}`);
  await expect(page.getByTestId("workflows-here")).toBeVisible();
});
