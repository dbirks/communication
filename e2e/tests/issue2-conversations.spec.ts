// Issue #2 acceptance journeys for integrated agent conversations:
// A7 (a one-off manual conversation started without any pipeline) and the
// run-link backs between a run-linked conversation and the Run Workbench.
//
// It runs against the M4 lab ONLY when COMMUNICATION_E2E_ISSUE2=1 — skipped
// everywhere else, the same env-gate idiom as the M2/M5 suites:
//   COMMUNICATION_E2E_ISSUE2=1 E2E_BASE_URL=http://localhost:18091 \
//     pnpm exec playwright test tests/issue2-conversations.spec.ts
// Lab identities come from docs/compatibility/probes/m4/seed.sh: alice is the
// maintainer of `m4-exit`. A7 drives a REAL agent turn through the lab
// worker (m4-implementer, a claude-launcher profile), so every wait around
// it is bounded by AGENT_TURN_TIMEOUT_MS and never open-ended.
//
// Every journey step calls the local `evidence()` helper: a full-page
// screenshot into ${E2E_EVIDENCE_DIR ?? "test-results/issue2"}/<name>.png and
// one console line `EVIDENCE <name>: <what it proves>`.
//
// Accessibility: each main screen (conversation dialog, conversation page,
// the conversations list) runs a real axe audit via `checkA11y`
// (tests/a11y.ts) with the wcag2a + wcag2aa tags; the run fails only on
// serious/critical impact and the full result JSON is attached to the test
// report.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { test, expect, type Locator, type Page } from "@playwright/test";
import { AGENT_TURN_TIMEOUT_MS } from "./env.js";
import { checkA11y } from "./a11y.js";
import { expectTurnStatus, openProjectBySlug, selectByOptionText, signIn } from "./helpers.js";

const ISSUE2_ENABLED = process.env.COMMUNICATION_E2E_ISSUE2 === "1";
/** Unique per run so re-runs never collide with their own earlier rows. */
const STAMP = process.env.E2E_ISSUE2_STAMP ?? Date.now().toString(36);
const TITLE = `issue2 one-off ${STAMP}`;
/**
 * The list row's own test id (`titleSlug` in ui/src/components/Conversations.tsx:
 * lowercased title with non-alphanumerics collapsed to "-").
 */
const ROW_TESTID = `conversation-row-${TITLE.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
/** A seeded lab profile that is a real claude-launcher agent. */
const PROFILE = "m4-implementer";
const PROMPT = "Reply with exactly the word: pong";
const PROJECT_NAME = "M4 Exit";
const PROJECT_SLUG = "m4-exit";
/** A workbench read is worker polls plus the revision graph, not milliseconds. */
const WORKBENCH_TIMEOUT_MS = Number(process.env.E2E_WORKBENCH_TIMEOUT_MS ?? 120_000);
const EVIDENCE_DIR = process.env.E2E_EVIDENCE_DIR ?? "test-results/issue2";

/** One piece of journey evidence: a screenshot plus a single log line. */
async function evidence(page: Page, name: string, what: string): Promise<void> {
  await mkdir(EVIDENCE_DIR, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCE_DIR, `${name}.png`), fullPage: true });
  console.log(`EVIDENCE ${name}: ${what}`);
}

/** Fill the shared New-conversation dialog's three fields (project untouched). */
async function fillDialog(page: Page): Promise<void> {
  await page.getByTestId("conversation-new-title").fill(TITLE);
  await selectByOptionText(page, "conversation-new-profile", PROFILE);
  await page.getByTestId("conversation-new-prompt").fill(PROMPT);
}

/** A transcript item that is an AGENT message (has its speaker line). */
function agentItem(page: Page, text: string): Locator {
  return page
    .getByTestId("transcript-item")
    .filter({ has: page.getByTestId("agent-speaker") })
    .filter({ hasText: text });
}

/** The workbench node button the graph has selected, if any. */
function selectedGraphNode(page: Page): Locator {
  return page.locator('button[data-testid^="definition-graph-node-"][aria-pressed="true"]');
}

test.describe("issue2 conversations (A7 + run link-backs)", () => {
  test.skip(
    !ISSUE2_ENABLED,
    "requires the M4 lab (COMMUNICATION_E2E_ISSUE2=1, E2E_BASE_URL=http://localhost:18091)",
  );
  test.use({ viewport: { width: 1440, height: 900 } });

  test("A7: one-off conversation from the header and the global New menu", async ({ page }) => {
    await signIn(page, "alice");
    const projectUrl = await openProjectBySlug(page, PROJECT_SLUG);

    // --- Entry 1: the project overview header button (project fixed). ---
    await page.getByTestId("project-new-conversation").click();
    const dialog = page.getByTestId("new-conversation-dialog");
    await expect(dialog).toBeVisible();
    // The header entry pins the project: a printed name, not a picker select.
    await expect(page.getByTestId("new-conversation-dialog-project")).toContainText(PROJECT_NAME);
    expect(
      await page.locator('select[data-testid="new-conversation-dialog-project"]').count(),
    ).toBe(0);
    await fillDialog(page);
    await evidence(
      page,
      "conv-a7-dialog",
      `New conversation dialog opened from the ${PROJECT_SLUG} overview header with the project pinned, profile ${PROFILE} and the first prompt filled — no pipeline field exists`,
    );
    await page.getByTestId("conversation-new-submit").click();
    await page.waitForURL(/\/projects\/[0-9a-f-]{36}\/conversations\/[0-9a-f-]{36}$/);

    // The real agent turn: a bounded wait for the "pong" reply AND a terminal
    // turn status — the page's own `turn-status` chip says the turn completed.
    await expect(agentItem(page, "pong").first()).toBeVisible({ timeout: AGENT_TURN_TIMEOUT_MS });
    await expectTurnStatus(page, /completed/, AGENT_TURN_TIMEOUT_MS);
    await evidence(
      page,
      "conv-a7-reply",
      `conversation "${TITLE}" landed on its page and the m4-implementer turn completed with an agent reply containing "pong"`,
    );

    // The manual conversation says it is manual and links to no run or node.
    await expect(page.getByTestId("conversation-manual-label")).toBeVisible();
    expect(await page.getByTestId("part-of-run-link").count()).toBe(0);
    await checkA11y(page, "conversation page (A7)");
    await evidence(
      page,
      "conv-a7-manual-label",
      `the conversation page shows the "Manual conversation" label and has no part-of-run-link or node reference`,
    );

    // --- Entry 2: the global New menu opens the SAME dialog with a picker. ---
    await page.getByTestId("new-menu").click();
    await page.getByTestId("new-menu-conversation").click();
    await expect(dialog).toBeVisible();
    // No project was passed in, so the dialog offers the project picker.
    const picker = page.locator('select[data-testid="new-conversation-dialog-project"]');
    await expect(picker).toBeVisible();
    const projectOption = picker.locator("option", { hasText: PROJECT_NAME });
    await picker.selectOption((await projectOption.first().getAttribute("value")) ?? "");
    await expect(page.getByTestId("conversation-new-title")).toBeVisible();
    await checkA11y(page, "global New-menu dialog (A7)");
    await evidence(
      page,
      "conv-a7-global-menu",
      "the global New menu (new-menu → new-menu-conversation) opened the same dialog with a working project picker set to M4 Exit",
    );
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();

    // --- The Conversations list: searched, badged Manual, hidden by "From runs". ---
    await page.goto(projectUrl);
    await page.getByTestId("conversation-search").fill("issue2 one-off");
    const row = page.getByTestId(ROW_TESTID);
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row.getByTestId("conversation-origin-manual")).toContainText("Manual");
    await checkA11y(page, "conversations list (A7)");
    await evidence(
      page,
      "conv-a7-list-manual",
      `searching "issue2 one-off" lists the row with the Manual badge (conversation-origin-manual)`,
    );
    await page.getByTestId("conversation-filter-run").click();
    await expect
      .poll(
        async () =>
          (await row.isVisible().catch(() => false)) ||
          (await page
            .getByTestId("conversation-list-nomatch")
            .isVisible()
            .catch(() => false)),
        { timeout: 15_000 },
      )
      .toBe(true);
    expect(await row.isVisible().catch(() => false)).toBe(false);
    await evidence(
      page,
      "conv-a7-filter-run-hides-manual",
      'filtering the list to "From runs" hides the manual conversation',
    );
  });

  test("run-linked conversation: the badge deep-links into the Run Workbench", async ({ page }) => {
    await signIn(page, "alice");
    await openProjectBySlug(page, PROJECT_SLUG);

    // Find a run-linked conversation: the list filtered to "From runs". The
    // M4 seed's exit runs and the workbench journeys create agent
    // conversations; if none exists yet there is nothing to prove.
    await page.getByTestId("conversation-filter-run").click();
    await expect
      .poll(
        async () =>
          (await page
            .getByTestId("conversation-list")
            .isVisible()
            .catch(() => false)) ||
          (await page
            .getByTestId("conversation-list-nomatch")
            .isVisible()
            .catch(() => false)),
        { timeout: 15_000 },
      )
      .toBe(true);
    const badge = page.locator('a[data-testid="conversation-origin-run"]').first();
    if (
      await page
        .getByTestId("conversation-list-nomatch")
        .isVisible()
        .catch(() => false)
    ) {
      test.skip(
        true,
        "no run-linked conversation exists in m4-exit yet — nothing to link back from",
      );
      return;
    }
    await expect(badge).toBeVisible({ timeout: 15_000 });
    const badgeHref = (await badge.getAttribute("href")) ?? "";
    expect(badgeHref).toMatch(/\/projects\/[0-9a-f-]{36}\/runs\/[0-9a-f-]{36}\?/);
    expect(new URL(badgeHref, "http://x").searchParams.get("node")).not.toBeNull();
    await checkA11y(page, "conversations list (run-linked)");
    await evidence(
      page,
      "conv-run-badge",
      `a run-linked conversation row's "From run" badge is a deep link into the Run Workbench with a ?node= parameter (${badgeHref})`,
    );

    // --- Badge click: the workbench opens with that node selected. ---
    await badge.click();
    await page.waitForURL(/\/projects\/[0-9a-f-]{36}\/runs\/[0-9a-f-]{36}\?/);
    await expect(page.getByTestId("run-title")).toBeVisible({ timeout: WORKBENCH_TIMEOUT_MS });
    await expect(selectedGraphNode(page).first()).toBeVisible({ timeout: WORKBENCH_TIMEOUT_MS });
    await expect(page.getByTestId("dock-conversation")).toBeVisible({
      timeout: WORKBENCH_TIMEOUT_MS,
    });

    // --- From the conversation page, part-of-run-link goes to the SAME place. ---
    await page.goBack();
    await expect(page.getByTestId("conversation-filter-run")).toBeVisible({ timeout: 15_000 });
    const badgeAgain = page.locator('a[data-testid="conversation-origin-run"]').first();
    await expect(badgeAgain).toBeVisible({ timeout: 15_000 });
    // The badge sits inside the row link: read the row's own href to open the
    // conversation page without racing a click on the nested badge anchor.
    const row = badgeAgain.locator(
      'xpath=ancestor::*[starts-with(@data-testid, "conversation-row-")][1]',
    );
    const rowHref = (await row.getAttribute("href")) ?? "";
    expect(rowHref).toMatch(/\/conversations\/[0-9a-f-]{36}$/);
    await page.goto(rowHref);
    const partOfRun = page.getByTestId("part-of-run-link");
    await expect(partOfRun.first()).toBeVisible({ timeout: 15_000 });
    const linkHref = (await partOfRun.first().getAttribute("href")) ?? "";
    expect(new URL(linkHref, "http://x").toString()).toBe(
      new URL(badgeHref, "http://x").toString(),
    );
    await checkA11y(page, "run-linked conversation page");
    await evidence(
      page,
      "conv-run-conversation-page",
      `the conversation page's part-of-run-link points at the same workbench deep link as the list badge (${linkHref})`,
    );
    await partOfRun.first().click();
    await page.waitForURL(/\/projects\/[0-9a-f-]{36}\/runs\/[0-9a-f-]{36}\?/);
    await expect(page.getByTestId("run-title")).toBeVisible({ timeout: WORKBENCH_TIMEOUT_MS });
    await expect(selectedGraphNode(page).first()).toBeVisible({ timeout: WORKBENCH_TIMEOUT_MS });
    await expect(page.getByTestId("dock-conversation")).toBeVisible({
      timeout: WORKBENCH_TIMEOUT_MS,
    });
    await evidence(
      page,
      "conv-run-linkback",
      "the part-of-run link landed on the Run Workbench with the source node selected in the graph and the conversation open in the dock",
    );
  });

  test.describe("narrow 390x844", () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test("the new-conversation dialog fits without horizontal scroll", async ({ page }) => {
      await signIn(page, "alice");
      await openProjectBySlug(page, PROJECT_SLUG);
      await page.getByTestId("project-new-conversation").click();
      const dialog = page.getByTestId("new-conversation-dialog");
      await expect(dialog).toBeVisible();
      const box = await dialog.boundingBox();
      expect(box, "the dialog is on screen at 390px").not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.width).toBeLessThanOrEqual(390);
      const fits = await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      );
      expect(fits, "the page does not scroll sideways with the dialog open").toBe(true);
      await evidence(
        page,
        "conv-narrow-dialog",
        "at 390x844 the new-conversation dialog sits inside the viewport and the document does not scroll horizontally",
      );
    });
  });
});
