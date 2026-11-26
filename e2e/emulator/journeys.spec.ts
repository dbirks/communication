// journeys.spec.ts — end-to-end redesign walkthrough: Home (all + project) →
// Factory index & New workflow sheet → Studio editor (canvas, Box select +
// WrapPanel + GoalFrame, Versions, Make live) → Chats (list, new chat,
// thread) → Manage (Projects, Runners, Agents & models).
import { test, expect, apiMutate } from "./fixtures";
import { EMU_ADMIN_STATE, EMU_BASE_URL } from "./env";

test.use({ storageState: EMU_ADMIN_STATE });

test("redesign journey: Home, Factory, Studio editor, Chats, Manage", async ({
  page,
  request,
  emu,
}) => {
  test.setTimeout(120_000);
  const ts = Date.now().toString(36);
  const projectName = `Emu Journey ${ts}`;

  // Ensure at least one project and agent profile exist for scoped/chat steps.
  const projRes = await apiMutate(page, "POST", `${EMU_BASE_URL}/api/v1/projects`, {
    name: projectName,
    description: "Emulator redesign walkthrough project",
  });
  expect(projRes.status()).toBe(201);
  const project = (await projRes.json()) as { id: string; name: string };

  const profilesRes = await request.get(`${EMU_BASE_URL}/api/v1/agent-profiles`);
  expect(profilesRes.ok()).toBe(true);
  const profilesBody = (await profilesRes.json()) as {
    items?: { id: string; name: string }[];
  };
  const firstProfile = profilesBody.items?.[0];
  expect(firstProfile, "at least one agent profile is seeded").toBeTruthy();

  // 1. Home (All projects)
  await page.goto(`${EMU_BASE_URL}/`);
  await expect(page.getByTestId("home-all")).toBeVisible();
  await expect(page.getByTestId("home-prompt")).toBeVisible();
  await emu.screen("home", "all");

  // 2. Project Home
  await page.goto(`${EMU_BASE_URL}/p/${project.id}`);
  await expect(page.getByTestId("project-home")).toBeVisible();
  await expect(page.getByTestId("starter-pills")).toBeVisible();
  await emu.screen("project", "home");

  // 3. Factory index + New workflow sheet
  await page.getByTestId("pill-factory").click();
  await expect(page).toHaveURL(/\/factory$/);
  await expect(page.getByTestId("factory-index")).toBeVisible();
  await emu.screen("factory", "index");

  await page.getByTestId("factory-new").click();
  await expect(page.getByTestId("new-workflow-sheet")).toBeVisible();
  await emu.screen("factory", "sheet");

  // Create via Describe it -> Sketch it -> Studio editor
  await page.getByTestId("new-workflow-description").fill(`Emu journey flow ${ts}`);
  await page.getByTestId("new-workflow-sketch").click();
  await expect(page).toHaveURL(/\/factory\/[^/]+\?draft=/);
  await expect(page.getByTestId("studio-page")).toBeVisible();
  await expect(page.getByTestId("studio-canvas")).toBeVisible();
  await emu.screen("editor", "canvas");

  // 4. Editor: Box select -> WrapPanel -> Repeat until -> GoalFrame
  const toolbar = page.getByRole("toolbar", { name: "Canvas tools" });
  await toolbar.getByRole("button", { name: "Box select (B)" }).click();

  const firstCard = page
    .locator(
      '[data-testid^="canvas-step-"]:not([data-testid^="canvas-step-tile-"]):not([data-testid^="canvas-step-fact-"]):not([data-testid^="canvas-step-row-"]) > [role="button"]',
    )
    .first();
  await expect(firstCard).toBeVisible();
  await firstCard.click();

  await expect(page.getByTestId("wrap-panel")).toBeVisible();
  await emu.screen("editor", "wrap");

  await page.getByTestId("wrap-tab-repeat").click();
  await page.getByTestId("wrap-goal-input").fill("Tests pass and the change is verified.");
  await page.getByTestId("wrap-submit").click();
  await expect(page.getByTestId("goal-frame")).toBeVisible();
  await emu.screen("editor", "goal");

  // 5. Versions panel + Make live
  await page.getByTestId("editor-versions-btn").click();
  await expect(page.getByTestId("versions-panel")).toBeVisible();
  await emu.screen("editor", "versions");
  await page.getByTestId("versions-panel-close").click();
  await expect(page.getByTestId("versions-panel")).toBeHidden();

  await page.getByTestId("studio-publish").click();
  await expect(page.getByTestId("studio-publish")).toBeDisabled();

  // 6. Chats: reset scope to All via rail -> Chats list -> new chat -> thread
  await page.goto(`${EMU_BASE_URL}/chats`);
  await expect(page).toHaveURL(/\/chats$/);
  await expect(page.getByTestId("chats")).toBeVisible();
  await emu.screen("chats", "list");

  await page.getByTestId("chat-new").click();
  await expect(page).toHaveURL(/\/chats\/new$/);
  await expect(page.getByTestId("chat-new-pane")).toBeVisible();
  await emu.screen("chats", "new");

  await page.getByTestId("new-chat-project-chip").click();
  await page.getByTestId(`new-chat-project-${project.id}`).click();
  await page.getByTestId("new-chat-agent-picker").click();
  await page.getByTestId(`agent-option-${firstProfile!.id}`).click();
  await page.getByTestId("new-chat-prompt-input").fill(`Emu journey chat ${ts}`);
  await page.getByTestId("new-chat-prompt-send").click();

  await expect(page).toHaveURL(/\/chats\/[^/]+$/);
  await expect(page.getByTestId("chat-thread")).toBeVisible();
  await emu.screen("chats", "thread");

  // 7. Manage: Projects -> Runners -> Agents & models
  await page.goto(`${EMU_BASE_URL}/manage/projects`);
  await expect(page.getByTestId("manage-projects")).toBeVisible();
  await emu.screen("manage", "projects");

  await page.getByTestId("manage-nav-runners").click();
  await expect(page.getByTestId("manage-runners")).toBeVisible();
  await emu.screen("manage", "runners");

  await page.getByTestId("manage-nav-agents").click();
  await expect(page.getByTestId("manage-agents")).toBeVisible();
  await emu.screen("manage", "agents");
});
