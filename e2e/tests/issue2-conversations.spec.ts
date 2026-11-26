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
import { AGENT_TURN_TIMEOUT_MS, BASE_URL } from "./env.js";
import { checkA11y } from "./a11y.js";
import {
  expectTurnStatus,
  expectNoLegacyAppBar,
  gotoApp,
  openProjectBySlug,
  scrollToTopForCapture,
  signIn,
} from "./helpers.js";
import { signInNarrowClosed } from "./shell-helpers.js";

const ISSUE2_ENABLED = process.env.COMMUNICATION_E2E_ISSUE2 === "1";
/** Unique per run so re-runs never collide with their own earlier rows. */
const STAMP = process.env.E2E_ISSUE2_STAMP ?? Date.now().toString(36);
const PROMPT = `issue2 one-off ${STAMP} — Reply with exactly the word: pong`;
const rowTestid = (conversationId: string): string => `chat-row-${conversationId}`;
/** A seeded lab profile that is a real claude-launcher agent. */
const PROFILE = "m4-implementer";
const PROJECT_NAME = "M4 Exit";
const PROJECT_SLUG = "m4-exit";
/** A workbench read is worker polls plus the revision graph, not milliseconds. */
const WORKBENCH_TIMEOUT_MS = Number(process.env.E2E_WORKBENCH_TIMEOUT_MS ?? 120_000);
const EVIDENCE_DIR = process.env.E2E_EVIDENCE_DIR ?? "test-results/issue2";

/** One piece of journey evidence: a screenshot plus a single log line. */
async function evidence(page: Page, name: string, what: string): Promise<void> {
  await mkdir(EVIDENCE_DIR, { recursive: true });
  // Captured from the top: a full-page shot of a scrolled page stitches the
  // sticky phone top bar into the MIDDLE of the image.
  await scrollToTopForCapture(page);
  await page.screenshot({ path: path.join(EVIDENCE_DIR, `${name}.png`), fullPage: true });
  console.log(`EVIDENCE ${name}: ${what}`);
}

/** A transcript item that is an AGENT message (has its speaker line). */
function agentItem(page: Page, text: string): Locator {
  return page
    .getByTestId("transcript-item")
    .filter({ has: page.getByTestId("agent-speaker") })
    .filter({ hasText: text });
}

/* ---- fail-fast reply wait with the turn's own diagnostics ---------------- */

/** The turn statuses with no future for a reply still to come, read off the
 * page's own words (`turnStatusText` in `ui/src/api/transcript.ts`). */
const TERMINAL_TURN_STATUS =
  /done|completed|cancelled|failed|interrupted|stopped — outcome unknown/i;
/** Statuses that prove the wait is watching a LIVE turn (not a stale chip). */
const LIVE_TURN_STATUS = /idle|queued|starting|running/i;
/** How long a terminal chip must hold (with no reply landing) before the
 * wait calls the turn dead — room for the transcript's own SSE/refetch lag. */
const REPLY_TERMINAL_CONFIRM_MS = 15_000;

/** One locator's text, whitespace-flattened, or "" when it is not on the page. */
async function flatText(target: Locator): Promise<string> {
  const raw = await target.innerText().catch(() => "");
  return (raw ?? "").replace(/\s+/g, " ").trim();
}

/** The last AGENT transcript line, flattened and clipped — what the agent
 * DID say when the expected reply never landed. */
async function readLastAgentLine(page: Page): Promise<string> {
  const items = page
    .getByTestId("transcript-item")
    .filter({ has: page.getByTestId("agent-speaker") });
  const count = await items.count().catch(() => 0);
  if (count === 0) return "(no agent lines)";
  const text = await flatText(items.nth(count - 1));
  if (!text) return "(last agent line empty)";
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

/** The wire's account of the thread, read only on the failure path: the
 * conversation's status plus its active turn's status/stop_reason/worker —
 * the facts behind a silent turn (a refused file:// prepare, say, lands as a
 * failed turn with a stop_reason the page's chip alone does not name). */
async function readTurnWire(page: Page): Promise<string> {
  const id = new URL(page.url()).pathname.split("/").pop() ?? "";
  try {
    const res = await page.request.get(`${BASE_URL}/api/v1/conversations/${id}`);
    if (!res.ok()) return `wire: GET /api/v1/conversations/${id} answered ${res.status()}`;
    const body = (await res.json()) as {
      status?: string;
      active_turn?: {
        status?: string;
        stop_reason?: string | null;
        worker_id?: string | null;
      } | null;
    };
    const t = body.active_turn;
    return (
      `wire: conversation ${body.status ?? "?"}, ` +
      (t
        ? `active turn ${t.status ?? "?"}${t.stop_reason ? ` (stop_reason ${t.stop_reason})` : ""}${t.worker_id ? ` on ${t.worker_id}` : " (no worker)"}`
        : "no active turn")
    );
  } catch (err) {
    return `wire: the conversation read failed (${String(err)})`;
  }
}

/**
 * Wait for an agent transcript item containing `text`, and fail FAST — with
 * the turn's whole account — once a LIVE turn reaches a terminal status with
 * no reply. Acceptance 42343957937 waited the full 300 s budget for a
 * missing "pong" and printed nothing about WHY the turn stayed silent; this
 * wait reads the page's own `turn-status` chip while it polls and, when the
 * chip has gone terminal and stays there, throws naming the chip, the wire's
 * `active_turn` (status / stop_reason / worker) and the last agent line. No
 * assertion is softened: a reply that never lands still fails the journey —
 * the terminal read is confirmed for {@link REPLY_TERMINAL_CONFIRM_MS} so a
 * fast chip can never cut off a reply still rendering.
 */
async function expectLiveAgentReply(
  page: Page,
  reply: Locator,
  text: string,
  timeout: number,
): Promise<void> {
  const deadline = Date.now() + timeout;
  let sawLiveTurn = false;
  let terminalSince = 0;
  let lastStatus = "";
  const die = async (reason: string): Promise<never> => {
    const status =
      lastStatus || (await flatText(page.getByTestId("turn-status").first())) || "(no turn-status)";
    throw new Error(
      `no agent reply containing "${text}" on ${page.url()} ${reason} ` +
        `(turn status chip: "${status}"; ${await readTurnWire(page)}; ` +
        `last agent line: ${await readLastAgentLine(page)})`,
    );
  };
  for (;;) {
    if (await reply.isVisible().catch(() => false)) return;
    lastStatus = await flatText(page.getByTestId("turn-status").first());
    if (LIVE_TURN_STATUS.test(lastStatus)) sawLiveTurn = true;
    if (sawLiveTurn && lastStatus && TERMINAL_TURN_STATUS.test(lastStatus)) {
      if (terminalSince === 0) terminalSince = Date.now();
      else if (Date.now() - terminalSince >= REPLY_TERMINAL_CONFIRM_MS) {
        await die(`ended on "${lastStatus}" with no reply`);
      }
    } else {
      terminalSince = 0;
    }
    if (Date.now() >= deadline) await die("within the bounded wait");
    await page.waitForTimeout(500);
  }
}

/**
 * The workbench draws its pinned revision on the shared Studio canvas
 * (React Flow) inside `workbench-graph-frame`. Scoped nodes carry a
 * QUALIFIED React Flow id (`build_until_verified/code_review`), so an exact
 * `data-id="<def id>"` match never lands for them; the canvas node box's
 * own `canvas-step-<definition id>` testid (plain definition id, the same
 * id the URL's `node` param names) is the stable selector.
 */
function canvasNode(page: Page, defId: string): Locator {
  return page.locator(`[data-testid="workbench-graph-frame"] [data-testid="canvas-step-${defId}"]`);
}

/** The `?node=` param of the current URL — the workbench's selected node. */
function nodeFromUrl(page: Page): string | null {
  return new URL(page.url()).searchParams.get("node");
}

test.describe("issue2 conversations (A7 + run link-backs)", () => {
  test.skip(
    !ISSUE2_ENABLED,
    "requires the M4 lab (COMMUNICATION_E2E_ISSUE2=1, E2E_BASE_URL=http://localhost:18091)",
  );
  test.use({ viewport: { width: 1440, height: 900 } });

  test("A7: one-off chat from project Chats and global New chat, plus list search/filter", async ({
    page,
  }) => {
    test.setTimeout(AGENT_TURN_TIMEOUT_MS + 90_000);
    await signIn(page, "alice");
    const projectUrl = await openProjectBySlug(page, PROJECT_SLUG);
    await expectNoLegacyAppBar(page);

    // --- Entry 1: project-scoped New chat pane (`/p/:id/chats/new`). ---
    await gotoApp(page, `${projectUrl}/chats`);
    await page.getByTestId("chat-new").click();
    await expect(page.getByTestId("chat-new-pane")).toBeVisible();
    // In project scope the project chip is omitted (already pinned to the scope).
    await expect(page.getByTestId("new-chat-project-chip")).toHaveCount(0);
    await page.getByTestId("new-chat-agent-picker").click();
    await expect(page.getByTestId("agent-picker-popover")).toBeVisible();
    await page
      .getByTestId("agent-picker-popover")
      .getByRole("option")
      .filter({ hasText: PROFILE })
      .first()
      .click();
    await page.getByTestId("new-chat-prompt-input").fill(PROMPT);
    await checkA11y(page, "new chat pane (A7)");
    await evidence(
      page,
      "conv-a7-dialog",
      `New chat pane opened in ${PROJECT_SLUG} with profile ${PROFILE} and prompt filled`,
    );
    await page.getByTestId("new-chat-prompt-send").click();
    await expect(page).toHaveURL(/\/p\/[^/]+\/chats\/[0-9a-f-]{36}$/);

    // Wait for the real agent turn reply AND turn status.
    await expectLiveAgentReply(
      page,
      agentItem(page, "pong").first(),
      "pong",
      AGENT_TURN_TIMEOUT_MS,
    );
    await expectTurnStatus(page, /done/, AGENT_TURN_TIMEOUT_MS);
    await evidence(
      page,
      "conv-a7-reply",
      `chat landed and the m4-implementer turn completed with an agent reply containing "pong"`,
    );

    // Details sheet: a manual thread links to no run.
    expect(await page.getByTestId("conversation-manual-label").count()).toBe(0);
    await page.getByTestId("chat-menu").click();
    await page.getByTestId("chat-menu-details").click();
    const sheet = page.getByTestId("chat-details-sheet");
    await expect(sheet).toBeVisible();
    await expect(
      sheet.locator('[data-testid="part-of-run-link"]'),
      "with Details open, a manual chat links to no run",
    ).toHaveCount(0);
    await checkA11y(page, "chat page (A7)");
    await page.getByTestId("chat-details-close").click();
    await evidence(
      page,
      "conv-a7-manual-label",
      "chat Details sheet shows no part-of-run-link for a manual chat",
    );

    // --- Entry 2: unscoped `/chats/new` offers the project picker chip. ---
    await gotoApp(page, "/chats/new");
    await expect(page.getByTestId("chat-new-pane")).toBeVisible();
    await page.getByTestId("new-chat-project-chip").click();
    await expect(page.getByTestId("new-chat-project-menu")).toBeVisible();
    await page
      .getByTestId("new-chat-project-menu")
      .getByRole("menuitem")
      .filter({ hasText: PROJECT_NAME })
      .first()
      .click();
    await checkA11y(page, "global New-chat pane (A7)");
    await evidence(
      page,
      "conv-a7-global-menu",
      "unscoped New chat pane offers the project picker chip set to M4 Exit",
    );

    // --- The chat list: search and filter. ---
    const conversationId = await (async () => {
      await gotoApp(page, `${projectUrl}/chats`);
      await expect(page.getByTestId("chat-list")).toBeVisible({ timeout: 15_000 });
      await page.getByTestId("chat-search").fill(`issue2 one-off ${STAMP}`);
      const firstRow = page
        .locator('[data-testid^="chat-row-"]:not([data-testid^="chat-row-status-"])')
        .first();
      await expect(firstRow).toBeVisible({ timeout: 15_000 });
      return ((await firstRow.getAttribute("data-testid")) ?? "").replace(/^chat-row-/, "");
    })();
    expect(conversationId).toMatch(/^[0-9a-f-]{36}$/);
    const row = page.getByTestId(rowTestid(conversationId));
    await expect(row).toBeVisible({ timeout: 15_000 });
    const wire = await page.request.get(`${BASE_URL}/api/v1/conversations/${conversationId}`);
    expect(wire.status(), "the thread read answers").toBe(200);
    expect(
      (await wire.json()) as { origin?: string },
      "the thread this journey created is a manual one-off on the wire",
    ).toMatchObject({ origin: "manual" });
    await checkA11y(page, "chats list (A7)");
    await evidence(
      page,
      "conv-a7-list-manual",
      `searching lists chat-row-${conversationId} in the project's chat list, on a manual origin confirmed on the wire`,
    );
    await page.getByTestId("threads-filter-runs").click();
    await expect
      .poll(
        async () =>
          (await row.isVisible().catch(() => false)) ||
          (await page
            .getByTestId("chat-list-empty")
            .isVisible()
            .catch(() => false)),
        { timeout: 15_000 },
      )
      .toBe(true);
    expect(await row.isVisible().catch(() => false)).toBe(false);
  });

  test("run-linked chat: list filter and Details sheet deep-link to the workbench", async ({
    page,
  }) => {
    test.setTimeout(300_000);
    await signIn(page, "alice");
    const listUrl = await openProjectBySlug(page, PROJECT_SLUG);
    await page.goto(`${listUrl}/chats`);
    await expect(page.getByTestId("chat-list")).toBeVisible({ timeout: 15_000 });

    await page.getByTestId("threads-filter-runs").click();
    await expect
      .poll(
        async () =>
          (await page
            .locator('[data-testid^="chat-row-"]:not([data-testid^="chat-row-status-"])')
            .first()
            .isVisible()
            .catch(() => false)) ||
          (await page
            .getByTestId("chat-list-empty")
            .isVisible()
            .catch(() => false)),
        { timeout: 15_000 },
      )
      .toBe(true);
    if (
      await page
        .getByTestId("chat-list-empty")
        .isVisible()
        .catch(() => false)
    ) {
      test.skip(
        true,
        "no run-linked conversation exists in m4-exit yet — nothing to link back from",
      );
      return;
    }
    const row = page
      .locator('[data-testid^="chat-row-"]:not([data-testid^="chat-row-status-"])')
      .first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    const rowHref = (await row.getAttribute("href")) ?? "";
    expect(rowHref).toMatch(/\/chats\/[0-9a-f-]{36}$/);
    const conversationId = rowHref.split("/").pop() ?? "";
    await checkA11y(page, "chats list (run-linked)");
    const wire = await page.request.get(`${BASE_URL}/api/v1/conversations/${conversationId}`);
    expect(wire.status(), "the thread read answers").toBe(200);
    const linked = (await wire.json()) as {
      origin?: string;
      run_link?: {
        run_id?: string;
        node_execution_id?: string;
        node_id?: string | null;
        attempt_number?: number;
      } | null;
    };
    expect(linked.origin, "the `from runs` chip answered with a run-origin thread").toBe("run");
    const runLink = linked.run_link ?? {};
    expect(String(runLink.run_id ?? ""), "the wire carries the run link").toMatch(
      /^[0-9a-f-]{36}$/,
    );
    expect(
      runLink.node_id ?? "",
      "the node execution stored a definition id (the deep link's `node` param)",
    ).not.toBe("");
    await evidence(page, "conv-run-badge", `run-linked chat row chat-row-${conversationId} opened`);

    // Chat Details sheet should carry part-of-run-link with ?node=&instance=&attempt=.
    await page.goto(rowHref);
    await expect(page.getByTestId("chat-title")).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("chat-menu").click();
    await page.getByTestId("chat-menu-details").click();
    const sheet = page.getByTestId("chat-details-sheet");
    await expect(sheet).toBeVisible({ timeout: 15_000 });
    const partOfRun = sheet.getByTestId("part-of-run-link");
    await expect(partOfRun.first()).toBeVisible({ timeout: 15_000 });
    const linkHref = (await partOfRun.first().getAttribute("href")) ?? "";
    const deep = new URL(linkHref, "http://x");
    expect(deep.pathname, "the panel links the run the wire named").toBe(`/runs/${runLink.run_id}`);
    expect(deep.searchParams.get("node")).toBe(String(runLink.node_id));
    expect(deep.searchParams.get("instance")).toBe(String(runLink.node_execution_id ?? ""));
    expect(deep.searchParams.get("attempt")).toBe(String(runLink.attempt_number ?? ""));
    await checkA11y(page, "run-linked conversation page");
    await evidence(
      page,
      "conv-run-conversation-page",
      `with Chat Details opened, part-of-run-link is ${linkHref}`,
    );

    await partOfRun.first().click();
    await expect(page).toHaveURL(/\/runs\/[0-9a-f-]{36}\?node=/);
    const selectedDef = nodeFromUrl(page);
    expect(selectedDef, "the workbench URL keeps the source node").not.toBeNull();
    expect(selectedDef, "and it is the node the wire named").toBe(runLink.node_id ?? "");
    await expect(page.getByTestId("run-title")).toBeVisible({ timeout: WORKBENCH_TIMEOUT_MS });
    await expect(canvasNode(page, selectedDef!)).toBeVisible({ timeout: WORKBENCH_TIMEOUT_MS });
    await expect(page.getByTestId("dock-conversation")).toBeVisible({
      timeout: WORKBENCH_TIMEOUT_MS,
    });
    await evidence(
      page,
      "conv-run-linkback",
      "part-of-run link landed on the Run Workbench with the source node selected",
    );
  });

  test.describe("narrow 390x844", () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test("the new-chat pane fits without horizontal scroll", async ({ page }) => {
      await signInNarrowClosed(page, "alice");
      const projectUrl = await openProjectBySlug(page, PROJECT_SLUG);
      await gotoApp(page, `${projectUrl}/chats/new`);
      const pane = page.getByTestId("chat-new-pane");
      await expect(pane).toBeVisible();
      const promptBox = page.getByTestId("new-chat-prompt");
      await expect(promptBox).toBeVisible();
      const box = await promptBox.boundingBox();
      expect(box, "the prompt box is on screen at 390px").not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.width).toBeLessThanOrEqual(390);
      const fits = await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      );
      expect(fits, "the page does not scroll sideways with the new chat pane open").toBe(true);
      await evidence(
        page,
        "conv-narrow-dialog",
        "at 390x844 the new-chat composer sits inside the viewport and the document does not scroll horizontally",
      );
    });
  });
});
