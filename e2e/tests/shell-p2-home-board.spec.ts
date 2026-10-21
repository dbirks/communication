// Phase 2 acceptance: the Home briefing and the cross-project Board.
//
// Home's count line and its decision callouts must equal the cross-project
// reads (contract C3: GET /api/v1/runs + GET /api/v1/approvals) — no invented
// numbers. The Board's five columns carry the same per-status counts, the
// repo / workflow groupings re-group the same cards, a card click opens the
// 440px drawer on `?run=`, the drawer traps focus and Escape closes it, and
// the drawer's Approve always shows a confirm step (cancelled here — the
// journey never decides a gate).
//
// Runs ONLY when COMMUNICATION_E2E_SHELL=1. checkShellScreen on every page;
// evidence() per step.
import { expect, test } from "@playwright/test";
import { BASE_URL } from "./env.js";
import { signIn, testidOf } from "./helpers.js";
import {
  SHELL_ENABLED,
  SHELL_GATE,
  apiPendingApprovals,
  apiRuns,
  checkShellScreen,
  evidence,
  signInNarrow,
  watchPageErrors,
  type RunRow,
} from "./shell-helpers.js";

/** The board's status → column mapping (ui/src/components/board/columns.ts). */
const STATUS_COLUMN: Record<string, string> = {
  queued: "queued",
  preparing: "queued",
  running: "running",
  waiting_human: "needs-you",
  paused: "needs-you",
  failed: "failed",
  interrupted: "failed",
  cancelled: "failed",
  completed: "done",
};
const COLUMNS = ["queued", "running", "needs-you", "failed", "done"] as const;

function perColumn(runs: RunRow[]): Record<string, number> {
  const counts: Record<string, number> = {
    queued: 0,
    running: 0,
    "needs-you": 0,
    failed: 0,
    done: 0,
  };
  for (const run of runs) counts[STATUS_COLUMN[run.status] ?? "queued"] += 1;
  return counts;
}

/** The card ROOT only — the inner testids (open/step/actions/retry) share the
    `board-card-` prefix, so a bare `[data-testid^="board-card-"]` counts children too. */
const CARD_ROOT =
  '[data-testid^="board-card-"]' +
  ':not([data-testid^="board-card-open-"])' +
  ':not([data-testid^="board-card-step-"])' +
  ':not([data-testid^="board-card-actions-"])' +
  ':not([data-testid^="board-card-retry-"])';

/** The number a column header prints (its trailing mono span). */
async function columnCount(page: import("@playwright/test").Page, column: string): Promise<number> {
  const header = page.locator(`[data-testid="board-col-${column}"] > button`);
  const text = (await header.innerText()).trim();
  const match = text.match(/(\d+)\s*$/);
  expect(match, `column ${column} header shows a count`).toBeTruthy();
  return Number(match![1]);
}

test.describe("shell p2 — Home briefing + cross-project board", () => {
  test.skip(!SHELL_ENABLED, SHELL_GATE);
  test.use({ viewport: { width: 1500, height: 950 } });
  test.setTimeout(10 * 60_000);

  test("Home: count line and a decision callout per pending approval", async ({ page }) => {
    await signIn(page, "admin");
    const stopWatching = watchPageErrors(page);
    await page.goto(BASE_URL + "/", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("home-count-line")).toBeVisible({ timeout: 20_000 });
    const runs = await apiRuns(page.request);
    const approvals = await apiPendingApprovals(page.request);
    const counts = perColumn(runs);

    // Count line: every segment printed must equal the API's column count;
    // zero-count segments are omitted entirely (the page's own rule).
    const line = await page.getByTestId("home-count-line").innerText();
    const expectedWords: Record<string, string> = {
      "needs-you": "need you",
      failed: "failed",
      running: "running",
      queued: "queued",
    };
    for (const key of ["needyou", "failed", "running", "queued"] as const) {
      const column = key === "needyou" ? "needs-you" : key;
      if (counts[column] > 0) {
        expect(line, `count line must say ${counts[column]} ${expectedWords[column]}`).toContain(
          `${counts[column]} ${expectedWords[column]}`,
        );
      } else {
        await expect(page.getByTestId(`home-count-${key}`)).toHaveCount(0);
      }
    }
    await checkShellScreen(page, "home briefing", stopWatching);
    await evidence(
      page,
      "shell-p2-home-count-line",
      `home count line equals GET /api/v1/runs per-column counts (${counts["needs-you"]} need you, ${counts.failed} failed, ${counts.running} running, ${counts.queued} queued); zero segments are omitted`,
    );

    // One callout per pending approval, keyed by the approval's testid.
    expect(approvals.length).toBeGreaterThan(0); // the lab seeds pending gates
    for (const approval of approvals) {
      await expect(page.getByTestId(`home-callout-${testidOf(approval.id)}`)).toBeVisible();
    }
    stopWatching();
    await evidence(
      page,
      "shell-p2-home-callouts",
      `home shows one decision callout per pending approval from GET /api/v1/approvals?status=pending (${approvals.length} callout(s))`,
    );
  });

  test("Board: column counts equal the API; repo and workflow groupings", async ({ page }) => {
    await signIn(page, "admin");
    const stopWatching = watchPageErrors(page);
    await page.goto(BASE_URL + "/board", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("board-loading")).toBeHidden({ timeout: 30_000 });
    const runs = await apiRuns(page.request);
    const counts = perColumn(runs);
    for (const column of COLUMNS) {
      expect(await columnCount(page, column), `column ${column}`).toBe(counts[column]);
    }
    await checkShellScreen(page, "board (state columns)", stopWatching);
    await evidence(
      page,
      "shell-p2-board-columns",
      `board column counts equal the API's per-status counts (${COLUMNS.map((c) => `${c}=${counts[c]}`).join(", ")} of ${runs.length} runs)`,
    );

    // Group by repo: one group row per distinct repo label, each labelled
    // "<label> (N)" with N the group size — the same cards, re-grouped.
    await page.getByTestId("board-group-by-repo").check();
    await expect(page.getByTestId("board-col-queued")).toBeHidden();
    const repoGroups = page.locator('section[aria-label$=")"]');
    const groupCount = await repoGroups.count();
    expect(groupCount, "repo grouping renders one row per group").toBeGreaterThan(0);
    for (let i = 0; i < groupCount; i += 1) {
      const label = (await repoGroups.nth(i).getAttribute("aria-label")) ?? "";
      const shown = Number(label.match(/\((\d+)\)$/)![1]);
      const cards = await repoGroups.nth(i).locator(CARD_ROOT).count();
      expect(cards, `group "${label}" card count`).toBe(shown);
    }
    await evidence(
      page,
      "shell-p2-board-group-repo",
      `grouping by repo re-groups the same ${runs.length} cards into ${groupCount} group row(s), each labelled with its count`,
    );
    await page.getByTestId("board-group-by-workflow").check();
    const workflowGroups = page.locator('section[aria-label$=")"]');
    const workflowCount = await workflowGroups.count();
    expect(workflowCount, "workflow grouping renders groups").toBeGreaterThan(0);
    const total = await page.locator(`section[aria-label$=")"] ${CARD_ROOT}`).count();
    expect(total, "workflow grouping keeps every card").toBe(runs.length);
    stopWatching();
    await evidence(
      page,
      "shell-p2-board-group-workflow",
      `grouping by workflow re-groups all ${runs.length} cards into ${workflowCount} group row(s)`,
    );
  });

  test("card click opens the drawer on ?run=; focus stays in the drawer; esc closes", async ({
    page,
  }) => {
    await signIn(page, "admin");
    const stopWatching = watchPageErrors(page);
    const runs = await apiRuns(page.request);
    expect(runs.length).toBeGreaterThan(0);
    await page.goto(BASE_URL + "/board", { waitUntil: "domcontentloaded" });
    const card = page.getByTestId(`board-card-open-${runs[0].id}`);
    await expect(card).toBeVisible({ timeout: 30_000 });
    await card.click();
    const drawer = page.getByTestId("run-drawer");
    await expect(drawer).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`\\?run=${runs[0].id}`));
    await checkShellScreen(page, "board with drawer", stopWatching);
    await evidence(
      page,
      "shell-p2-drawer-open",
      `clicking the run card opens the 440px drawer and the URL carries ?run=${runs[0].id.slice(0, 8)}…`,
    );

    // Focus trap: the drawer owns focus and Tab cycles never escape it.
    const drawerEl = await drawer.elementHandle();
    const focusedInDrawer = async () => {
      const active = await page.evaluateHandle(() => document.activeElement);
      return await drawerEl.evaluate((el, a) => el.contains(a as Node), active);
    };
    expect(await focusedInDrawer(), "focus starts inside the drawer").toBe(true);
    for (let i = 0; i < 25; i += 1) {
      await page.keyboard.press("Tab");
      expect(await focusedInDrawer(), `focus escapes after Tab ${i + 1}`).toBe(true);
    }
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    expect(page.url().includes(`?run=${runs[0].id}`), "esc clears ?run=").toBe(false);
    stopWatching();
    await evidence(
      page,
      "shell-p2-drawer-focus-esc",
      "focus starts inside the drawer and 25 Tab presses never escape it; Escape closes the drawer and drops ?run=",
    );
  });

  test("drawer Approve shows a confirm step; the journey cancels it", async ({ page }) => {
    await signIn(page, "admin");
    const runs = await apiRuns(page.request);
    const waiting = runs.find((r) => r.status === "waiting_human");
    expect(waiting, "a waiting run exists in the lab").toBeTruthy();
    const approvals = await apiPendingApprovals(page.request);
    expect(
      approvals.some((a) => a.run_id === waiting!.id),
      "the waiting run has a pending gate",
    ).toBeTruthy();
    await page.goto(BASE_URL + `/board?run=${waiting!.id}`, { waitUntil: "domcontentloaded" });
    const drawer = page.getByTestId("run-drawer");
    await expect(drawer).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("run-drawer-approve")).toBeVisible();
    // Count approval POSTs across the confirm + cancel journey. (An unbounded
    // `page.waitForRequest` only rejects after the whole test timeout in the
    // correct case — no POST ever happens — and hangs the journey.)
    let approvalPosts = 0;
    const onRequest = (req: import("@playwright/test").Request) => {
      if (req.url().includes("/api/v1/approvals") && req.method() === "POST") approvalPosts += 1;
    };
    page.on("request", onRequest);
    await page.getByTestId("run-drawer-approve").click();
    await expect(page.getByTestId("run-drawer-approve-confirm")).toBeVisible();
    await evidence(
      page,
      "shell-p2-drawer-approve-confirm",
      "the drawer's Approve button shows a confirm step before any decision is recorded",
    );
    await drawer.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByTestId("run-drawer-approve")).toBeVisible();
    // A short settle window: the decision would POST in the click's own tick.
    await page.waitForTimeout(1_000);
    page.off("request", onRequest);
    expect(approvalPosts, "no approval was POSTed").toBe(0);
    await evidence(
      page,
      "shell-p2-drawer-approve-cancelled",
      "cancelling the confirm step returns to the Approve button without any POST /api/v1/approvals — the gate is still pending",
    );
  });

  test.describe("narrow 390x844", () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test("phone: drawer fits, esc closes, approve confirm cancels", async ({ page }) => {
      await signInNarrow(page, "admin");
      const runs = await apiRuns(page.request);
      const waiting = runs.find((r) => r.status === "waiting_human") ?? runs[0];
      const stopWatching = watchPageErrors(page);
      await page.goto(BASE_URL + `/board?run=${waiting.id}`, { waitUntil: "domcontentloaded" });
      const drawer = page.getByTestId("run-drawer");
      await expect(drawer).toBeVisible({ timeout: 30_000 });
      const box = await drawer.boundingBox();
      expect(box, "the drawer is on screen at 390px").not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.width).toBeLessThanOrEqual(390);
      await checkShellScreen(page, "board drawer at phone width", stopWatching);
      await evidence(
        page,
        "shell-p2-drawer-phone",
        "at 390x844 the run drawer fits the viewport and the page does not scroll sideways",
      );
      if (waiting.status === "waiting_human") {
        await expect(page.getByTestId("run-drawer-approve")).toBeVisible();
        await page.getByTestId("run-drawer-approve").click();
        await expect(page.getByTestId("run-drawer-approve-confirm")).toBeVisible();
        await drawer.getByRole("button", { name: "Cancel" }).click();
        await evidence(
          page,
          "shell-p2-drawer-phone-approve-confirm",
          "at 390x844 the drawer's Approve shows its confirm step, and the journey cancels it",
        );
      }
      await page.keyboard.press("Escape");
      await expect(drawer).toBeHidden();
      stopWatching();
    });
  });
});
