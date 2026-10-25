// Phase 6 acceptance: Threads — the cross-project thread list and the
// thread page itself.
//
// /threads lists exactly the cross-project conversation summaries
// (contract C3: GET /api/v1/conversations); the thread page carries its
// header and its rail (the honest "not available yet" artifacts note, the
// "Hand to a workflow…" follow-up — shown, or disabled with its reason);
// and the ADR-0045 "Open a draft PR" NEXT entry is controller-only: clicking
// it shows the confirm card, and cancelling the card sends nothing.
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

  test("/threads lists exactly the API's cross-project conversations", async ({ page }) => {
    await signIn(page, "admin");
    const stopWatching = watchPageErrors(page);
    const conversations = await apiConversationsWithManual(page.request);
    expect(conversations.length).toBeGreaterThan(0);
    const manual = conversations.filter((c) => c.origin === "manual");
    await page.goto(BASE_URL + "/threads", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("threads-page")).toBeVisible({ timeout: 30_000 });
    const rows = page.locator('[data-testid^="thread-row-"]');
    // Default view is "one-off only" (manual origin), filtered client-side.
    await expect(rows.first()).toBeVisible({ timeout: 30_000 });
    expect(await rows.count(), "one row per one-off conversation").toBe(manual.length);
    for (const conversation of manual) {
      await expect(page.getByTestId(`thread-row-${conversation.id}`)).toBeVisible();
    }
    // Lifting the one-off filter shows the full cross-project list.
    await page.getByTestId("threads-one-off-filter").click();
    expect(await rows.count(), "one row per conversation summary").toBe(conversations.length);
    for (const conversation of conversations) {
      await expect(page.getByTestId(`thread-row-${conversation.id}`)).toBeVisible();
    }
    await checkShellScreen(page, "threads list", stopWatching);
    await evidence(
      page,
      "shell-p6-threads-list",
      `/threads shows the ${manual.length} one-off threads by default and, with the one-off filter lifted, exactly the ${conversations.length} cross-project summaries from GET /api/v1/conversations`,
    );
  });

  test("thread page: header and rail; hand-to-workflow honest; draft-PR controller-only with confirm", async ({
    page,
  }) => {
    await signIn(page, "admin");
    const stopWatching = watchPageErrors(page);
    const conversations = await apiConversations(page.request);
    const conversation = conversations[0];
    await page.goto(BASE_URL + `/threads/${conversation.id}`, { waitUntil: "domcontentloaded" });
    const title = page.getByTestId("conversation-title");
    await expect(title).toBeVisible({ timeout: 30_000 });
    await expect(title).toHaveText(conversation.title);
    await expect(page.getByTestId("conversation-meta")).toBeVisible();
    await checkShellScreen(page, "thread page", stopWatching);
    await evidence(
      page,
      "shell-p6-thread-header",
      `the /threads/<id> page header shows the conversation title "${conversation.title}" and its meta line`,
    );

    // The rail: the artifacts section says the honest "not available yet"
    // (the API cannot list one thread's files) with its escape hatch.
    await expect(page.getByTestId("artifacts-rail")).toBeVisible();
    const handToWorkflow = page.getByTestId("hand-to-workflow");
    await expect(handToWorkflow).toBeVisible();
    const note = page.getByTestId("hand-to-workflow-note");
    await expect(note).toBeVisible();
    const isDisabled = await handToWorkflow.isDisabled();
    if (isDisabled) {
      expect((await note.innerText()).trim(), "a disabled offer carries its reason").not.toBe("");
    }
    await evidence(
      page,
      "shell-p6-thread-rail",
      `the thread rail shows the honest artifacts note and the "Hand to a workflow…" follow-up ${isDisabled ? "disabled with its reason" : "offered"} (never fake state)`,
    );
    // ADR-0045: the draft-PR entry is controller-only. If we are not the
    // controller yet, only the honest note is rendered — take control first
    // and the entry appears. The thread page's Take control button commits
    // directly (the two-step confirm card belongs to the workbench dock), so
    // the badge flips to the controller copy once the takeover lands.
    const takeControl = page.getByTestId("take-control");
    if (await takeControl.count()) {
      expect(
        await page.getByTestId("thread-draft-pr-open").count(),
        "no open button before take control",
      ).toBe(0);
      expect(await page.getByTestId("thread-draft-pr").count(), "the honest note entry").toBe(1);
      await takeControl.click({ timeout: 30_000 });
      await expect(page.getByTestId("controller-badge")).toContainText(/You are in control/i, {
        timeout: 30_000,
      });
    }
    const draftPrOpen = page.getByTestId("thread-draft-pr-open");
    await expect(draftPrOpen, "the draft-PR entry for the controller").toBeVisible({
      timeout: 30_000,
    });
    await draftPrOpen.click({ timeout: 30_000 });
    await expect(page.getByTestId("thread-draft-pr-confirm")).toBeVisible();
    await page.getByTestId("thread-draft-pr-cancel").click({ timeout: 30_000 });
    await expect(page.getByTestId("thread-draft-pr-confirm")).toBeHidden();
    expect(await page.getByTestId("thread-draft-pr-sent").count(), "cancel sent nothing").toBe(0);
    expect(await page.getByTestId("thread-draft-pr-error").count(), "cancel sent nothing").toBe(0);
    stopWatching();
    await evidence(
      page,
      "shell-p6-draft-pr",
      "the 'Open a draft PR' NEXT entry is controller-only; clicking shows the confirm card and cancelling it sends nothing (ADR-0045)",
    );
  });

  test("narrow 390x844: the thread page fits without sideways scroll", async ({ page }) => {
    // This test alone runs at the phone width — set the viewport before
    // signing in (signInNarrow drives the drawer that only exists there).
    await page.setViewportSize({ width: 390, height: 844 });
    await signInNarrow(page, "admin");
    const stopWatching = watchPageErrors(page);
    const conversations = await apiConversations(page.request);
    const conversation = conversations[0];
    await page.goto(BASE_URL + `/threads/${conversation.id}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("conversation-title")).toBeVisible({ timeout: 30_000 });
    await checkShellScreen(page, "thread page at phone width", stopWatching);
    await evidence(
      page,
      "shell-p6-thread-phone",
      "at 390x844 the thread page renders its header without sideways scroll",
    );
  });
});
