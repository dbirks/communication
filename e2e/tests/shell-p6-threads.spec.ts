// Phase 6 acceptance: Threads — the cross-project thread list and the
// thread page itself (design 1g: the list is a 320px pane beside the open
// thread; opening a thread no longer leaves the page).
//
// /threads lists exactly the cross-project conversation summaries
// (contract C3: GET /api/v1/conversations) grouped LIVE / EARLIER with no
// filter applied by default; the thread pane carries its header (title, the
// mono repo/branch/agent line, the shared control line) and its rail (the
// honest "not available yet" artifacts note, the "Hand to a workflow…"
// follow-up — shown, or disabled with its reason); and the ADR-0045 "Open a
// draft PR" NEXT entry is controller-only: clicking it shows the confirm
// card, and cancelling the card sends nothing.
//
// Runs ONLY when COMMUNICATION_E2E_SHELL=1. evidence() per step;
// checkShellScreen on each page.
import { expect, test } from "@playwright/test";
import { BASE_URL } from "./env.js";
import { signIn } from "./helpers.js";
import {
  SHELL_ENABLED,
  SHELL_GATE,
  apiConversations,
  apiCreateConversation,
  apiCsrf,
  apiProfileId,
  apiScratchProject,
  checkShellScreen,
  evidence,
  signInNarrow,
  watchPageErrors,
} from "./shell-helpers.js";

const STAMP = Date.now().toString(36);

/**
 * The cross-project conversation list with a guaranteed one-off (manual) row:
 * a FRESH lab seeds no threads, so when none exists one is created through
 * the API (setup — the thread journeys still go through the UI). No prompt is
 * sent, so no turn is queued and no agent is launched by the seed.
 */
async function apiConversationsWithManual(
  request: import("@playwright/test").APIRequestContext,
): Promise<ReturnType<typeof apiConversations>> {
  let conversations = await apiConversations(request);
  if (conversations.some((c) => c.origin === "manual")) return conversations;
  const csrf = await apiCsrf(request);
  const project = await apiScratchProject(request);
  if (!project) throw new Error("no project available to seed the one-off thread");
  const profileId = await apiProfileId(request);
  await apiCreateConversation(request, csrf, project.id, profileId, `P6 one-off thread ${STAMP}`);
  console.log(
    `P6 setup: seeded one-off thread "P6 one-off thread ${STAMP}" (the fresh lab had none)`,
  );
  conversations = await apiConversations(request);
  return conversations;
}

test.describe("shell p6 — threads: cross-project list and thread page", () => {
  test.skip(!SHELL_ENABLED, SHELL_GATE);
  test.use({ viewport: { width: 1500, height: 950 } });
  test.setTimeout(8 * 60_000);

  test("/chats lists exactly the API's cross-project conversations", async ({ page }) => {
    await signIn(page, "admin");
    const stopWatching = watchPageErrors(page);
    const conversations = await apiConversationsWithManual(page.request);
    expect(conversations.length).toBeGreaterThan(0);
    await page.goto(BASE_URL + "/threads", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(/\/chats$/);
    await expect(page.getByTestId("chats")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("chat-list")).toBeVisible({ timeout: 30_000 });
    const rows = page.locator('[data-testid^="chat-row-"]:not([data-testid^="chat-row-status-"])');
    await expect(rows.first()).toBeVisible({ timeout: 30_000 });
    expect(await rows.count(), "one row per conversation summary").toBe(conversations.length);
    for (const conversation of conversations) {
      await expect(page.getByTestId(`chat-row-${conversation.id}`)).toBeVisible();
    }
    await checkShellScreen(page, "chats list", stopWatching);
    await evidence(
      page,
      "shell-p6-threads-list",
      `/chats shows exactly the ${conversations.length} cross-project summaries from GET /api/v1/conversations grouped by project in the 300px list pane`,
    );
  });

  test("chat page: header and Details sheet; hand-to-workflow; draft-PR controller-only with confirm", async ({
    page,
  }) => {
    await signIn(page, "admin");
    const stopWatching = watchPageErrors(page);
    const conversations = await apiConversations(page.request);
    const conversation = conversations[0];
    await page.goto(BASE_URL + `/chats/${conversation.id}`, { waitUntil: "domcontentloaded" });
    const title = page.getByTestId("chat-title");
    await expect(title).toBeVisible({ timeout: 30_000 });
    await expect(title).toHaveText(conversation.title);
    await expect(page.getByTestId("chat-people")).toBeVisible();
    await checkShellScreen(page, "chat page", stopWatching);
    await evidence(
      page,
      "shell-p6-thread-header",
      `the /chats/<id> page header shows the conversation title "${conversation.title}" and its participants line`,
    );

    // Details sheet behind the header's "…" menu holds the side panel,
    // artifacts, workspace, handoff and Open a draft PR actions.
    await page.getByTestId("chat-menu").click();
    await expect(page.getByTestId("chat-menu-details")).toBeVisible();
    const menuHasTakeControl = (await page.getByTestId("take-control").count()) > 0;
    await page.getByTestId("chat-menu-details").click();
    const sheet = page.getByTestId("chat-details-sheet");
    await expect(sheet, "the chat Details sheet opens from the … menu").toBeVisible();

    await expect(sheet.getByTestId("artifacts-rail")).toBeVisible();
    const handToWorkflow = sheet.getByTestId("hand-to-workflow");
    await expect(handToWorkflow).toBeVisible();
    await evidence(
      page,
      "shell-p6-thread-rail",
      "the chat Details sheet shows the honest artifacts note and the 'Hand to a workflow…' follow-up",
    );

    // ADR-0045: the draft-PR entry is controller-only. If we are not the
    // controller yet, only the honest note is shown — take control from the
    // header "…" menu first and the entry appears.
    if (menuHasTakeControl) {
      expect(
        await sheet.getByTestId("thread-draft-pr-open").count(),
        "no open button before take control",
      ).toBe(0);
      await expect(sheet.getByText(/Take control to ask the agent/i)).toBeVisible();
      await page.getByTestId("chat-details-close").click();
      await expect(sheet).toBeHidden();
      await page.getByTestId("chat-menu").click();
      await page.getByTestId("take-control").click({ timeout: 30_000 });
      await expect(page.getByTestId("composer-input")).toBeEnabled({ timeout: 30_000 });
      await page.getByTestId("chat-menu").click();
      await page.getByTestId("chat-menu-details").click();
      await expect(sheet).toBeVisible();
    }
    const draftPrOpen = sheet.getByTestId("thread-draft-pr-open");
    await expect(draftPrOpen, "the draft-PR entry for the controller").toBeVisible({
      timeout: 30_000,
    });
    await draftPrOpen.click({ timeout: 30_000 });
    const confirm = sheet.getByTestId("thread-draft-pr-confirm");
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: "Cancel" }).click({ timeout: 30_000 });
    await expect(confirm).toBeHidden();
    expect(
      await sheet.getByTestId("thread-draft-pr").locator('[role="status"]').count(),
      "cancel sent nothing",
    ).toBe(0);
    expect(
      await sheet.getByTestId("thread-draft-pr").locator('[role="alert"]').count(),
      "cancel sent nothing",
    ).toBe(0);
    stopWatching();
    await evidence(
      page,
      "shell-p6-draft-pr",
      "the 'Open a draft PR' NEXT entry is controller-only; clicking shows the confirm card and cancelling it sends nothing (ADR-0045)",
    );
  });

  test("narrow 390x844: the chat page fits without sideways scroll", async ({ page }) => {
    // This test alone runs at the phone width — set the viewport before
    // signing in (signInNarrow opens the phone scope sheet).
    await page.setViewportSize({ width: 390, height: 844 });
    await signInNarrow(page, "admin");
    const stopWatching = watchPageErrors(page);
    const conversations = await apiConversations(page.request);
    const conversation = conversations[0];
    await page.goto(BASE_URL + `/chats/${conversation.id}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("chat-title")).toBeVisible({ timeout: 30_000 });
    await checkShellScreen(page, "chat page at phone width", stopWatching);
    await evidence(
      page,
      "shell-p6-thread-phone",
      "at 390x844 the chat page renders its header without sideways scroll",
    );
  });
});
