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
  selectByOptionText,
  signIn,
} from "./helpers.js";

const ISSUE2_ENABLED = process.env.COMMUNICATION_E2E_ISSUE2 === "1";
/** Unique per run so re-runs never collide with their own earlier rows. */
const STAMP = process.env.E2E_ISSUE2_STAMP ?? Date.now().toString(36);
const TITLE = `issue2 one-off ${STAMP}`;
/**
 * A thread row's own test id. Design 1g (project-tabs-2 review): the project's
 * Threads tab IS the shared 1g list pane — its own card list, and the
 * title-slugged row ids it keyed its rows by, were retired with it.
 * One thread list, one row shape, everywhere: `thread-row-<conversation id>`.
 */
const rowTestid = (conversationId: string): string => `thread-row-${conversationId}`;
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
  // Captured from the top: a full-page shot of a scrolled page stitches the
  // sticky phone top bar into the MIDDLE of the image.
  await scrollToTopForCapture(page);
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

/* ---- fail-fast reply wait with the turn's own diagnostics ---------------- */

/** The turn statuses with no future for a reply still to come, read off the
 * page's own words (`turnStatusText` in `ui/src/api/transcript.ts`). */
const TERMINAL_TURN_STATUS = /completed|cancelled|failed|stopped — outcome unknown/i;
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

/**
 * A sign-in variant that does NOT rely on the `user-badge` span: that span
 * (and the user menu the footer opens) live in the sidebar footer, and at the
 * 390px viewport the sidebar is the drawer behind the phone top strip's menu
 * button — both are `display:none` until the drawer opens. The sign-in chain
 * ends on the lab's own embedded UI origin (where the menu button does not
 * exist at all), so the variant navigates back to the app under test first,
 * then opens the drawer and its user menu; the menu's `sign-out` is the
 * "signed in" signal at phone width.
 */
async function signInNarrow(page: Page, subject: string): Promise<void> {
  await gotoApp(page, "/");
  await page.getByTestId("sign-in").click();
  await page.getByPlaceholder("Enter any user/subject").fill(subject);
  await page.getByRole("button", { name: "Sign-in" }).click();
  // Back to the app under test (baseURL), where the session cookie — shared
  // per host across the lab's ports — is valid.
  await gotoApp(page, "/");
  // At 390px the sidebar (and its footer) sits behind the menu button:
  // open the drawer, then open the footer's user menu to reach the sign-out.
  await page.getByTestId("sidebar-open").click();
  const drawer = page.getByTestId("sidebar").last();
  await expect(drawer).toBeVisible();
  await drawer.getByTestId("user-menu").click();
  await expect(drawer.getByTestId("user-menu-list")).toBeVisible();
  await expect(drawer.getByTestId("sign-out")).toBeVisible();
}

test.describe("issue2 conversations (A7 + run link-backs)", () => {
  test.skip(
    !ISSUE2_ENABLED,
    "requires the M4 lab (COMMUNICATION_E2E_ISSUE2=1, E2E_BASE_URL=http://localhost:18091)",
  );
  test.use({ viewport: { width: 1440, height: 900 } });

  test("A7: one-off conversation from the header and the sidebar's New thread", async ({ page }) => {
    // One real agent turn plus four axe passes, bounded. The ceiling sits
    // ABOVE the reply wait so that wait's own deadline can fire first and
    // print the turn's diagnostics (a raw playwright hard-timeout aborts the
    // helper mid-poll and prints nothing but the locator it was waiting on).
    test.setTimeout(AGENT_TURN_TIMEOUT_MS + 90_000);
    await signIn(page, "alice");
    const projectUrl = await openProjectBySlug(page, PROJECT_SLUG);
    // The app shell is the new sidebar frame: the old top app bar's
    // `aria-label="Primary"` header is gone (Sidebar v3 regression gate).
    await expectNoLegacyAppBar(page);

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
      `New thread dialog opened from the ${PROJECT_SLUG} overview header with the project pinned, profile ${PROFILE} and the first prompt filled — no pipeline field exists`,
    );
    await page.getByTestId("conversation-new-submit").click();
    // The one-off conversation lands on its standalone thread page
    // (`/threads/:conversationId` — route contract C1).
    await page.waitForURL(/\/threads\/[0-9a-f-]{36}$/);

    // The real agent turn: a bounded wait for the "pong" reply AND a terminal
    // turn status — the page's own `turn-status` chip says the turn completed.
    // The reply wait fails fast on a dead turn and prints its whole account
    // (chip, wire active_turn, last agent line) — see expectLiveAgentReply.
    await expectLiveAgentReply(
      page,
      agentItem(page, "pong").first(),
      "pong",
      AGENT_TURN_TIMEOUT_MS,
    );
    await expectTurnStatus(page, /completed/, AGENT_TURN_TIMEOUT_MS);
    await evidence(
      page,
      "conv-a7-reply",
      `conversation "${TITLE}" landed on its page and the m4-implementer turn completed with an agent reply containing "pong"`,
    );

    // Design 1g: the pane header shows only the title, the mono meta line and
    // the control pill — the "One-off thread" chip is gone with the "one-off
    // only" default. What stays honest: a manual thread links to no run. The
    // rail that would carry such a link is behind the thread's details
    // disclosure now, so the disclosure is OPENED and the absence proved inside
    // it — a closed door would make any absence assertion trivially true.
    expect(await page.getByTestId("conversation-manual-label").count()).toBe(0);
    const a7Context = page.getByTestId("thread-context-block");
    await expect(
      a7Context.locator('[data-testid="part-of-run-link"]'),
      "a manual thread has no PART OF panel to open",
    ).toHaveCount(0);
    await a7Context.locator("summary").click();
    await expect(a7Context).toHaveAttribute("open", "");
    await expect(
      a7Context.locator('[data-testid="part-of-run-link"]'),
      "with the details open, a manual thread still links to no run",
    ).toHaveCount(0);
    expect(await page.getByTestId("part-of-run-link").count()).toBe(0);
    await checkA11y(page, "conversation page (A7)");
    await evidence(
      page,
      "conv-a7-manual-label",
      "the /threads page header carries no 'One-off thread' chip (design 1g drops it) and, with " +
        "its Thread-details disclosure opened, no part-of-run-link or node reference",
    );

    // --- Entry 2: the sidebar's `New thread` opens the SAME dialog with a picker. ---
    // Handoff 2c/3c (finding 01): the shell's cross-project row is one thread-starting
    // button (`new-chat`); the global "New" menu it replaced is gone from the column.
    await page.getByTestId("new-chat").click();
    await expect(dialog).toBeVisible();
    // No project was passed in, so the dialog offers the project picker.
    const picker = page.locator('select[data-testid="new-conversation-dialog-project"]');
    await expect(picker).toBeVisible();
    const projectOption = picker.locator("option", { hasText: PROJECT_NAME });
    await picker.selectOption((await projectOption.first().getAttribute("value")) ?? "");
    await expect(page.getByTestId("conversation-new-title")).toBeVisible();
    await checkA11y(page, "sidebar New-thread dialog (A7)");
    await evidence(
      page,
      "conv-a7-global-menu",
      "the sidebar's New thread (new-chat) opened the same dialog with a working project picker set to M4 Exit",
    );
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();

    // --- The thread list: searched, listed as the project's own, and hidden
    // by "from runs". ---
    // Design 1b moved the list off the project overview onto its Threads tab;
    // the project-tabs-2 review made that tab the SAME 1g pane `/threads` draws
    // (search field, `all` / `mine` / `from runs` chips, id-keyed rows), so the
    // thread this test just created is found there by its own id.
    const conversationId = new URL(page.url()).pathname.split("/").pop() ?? "";
    expect(conversationId, "the thread page names the conversation it opened").toMatch(
      /^[0-9a-f-]{36}$/,
    );
    await page.goto(`${projectUrl}/threads`);
    await expect(
      page.getByTestId("threads-page"),
      "design 1g: the Threads tab is the shared list pane",
    ).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("threads-search").fill("issue2 one-off");
    const row = page.getByTestId(rowTestid(conversationId));
    await expect(row).toBeVisible({ timeout: 15_000 });
    // The row says which project it belongs to (1g's mono `project · agent`
    // line) — the row's own claim of scope, since the tab is filtered to it.
    await expect(row).toContainText(PROJECT_NAME);
    // The Manual badge is retired with the old card list, so the ORIGIN fact it
    // printed is read from the wire the row came from (ADR-0043: the list
    // carries `origin`), and the sentence "this thread was not opened by a run"
    // is the SAME fact one assertion below: the `from runs` chip hides it.
    const wire = await page.request.get(`${BASE_URL}/api/v1/conversations/${conversationId}`);
    expect(wire.status(), "the thread read answers").toBe(200);
    expect(
      (await wire.json()) as { origin?: string },
      "the thread this journey created is a manual one-off on the wire",
    ).toMatchObject({ origin: "manual" });
    await checkA11y(page, "conversations list (A7)");
    await evidence(
      page,
      "conv-a7-list-manual",
      `searching "issue2 one-off" lists this thread's own row (thread-row-${conversationId}) in the project's 1g list pane, on a manual origin the wire confirms`,
    );
    await page.getByTestId("threads-filter-runs").click();
    await expect
      .poll(
        async () =>
          (await row.isVisible().catch(() => false)) ||
          (await page
            .getByTestId("threads-nomatch")
            .isVisible()
            .catch(() => false)),
        { timeout: 15_000 },
      )
      .toBe(true);
    expect(await row.isVisible().catch(() => false)).toBe(false);
    await evidence(
      page,
      "conv-a7-filter-run-hides-manual",
      "the `from runs` chip hides the manual conversation (threads-filter-runs → threads-nomatch)",
    );
  });

  test("run-linked thread: the list finds it and its Thread details deep-link to the workbench", async ({
    page,
  }) => {
    test.setTimeout(300_000); // the workbench deep-link waits are WORKBENCH_TIMEOUT_MS each
    await signIn(page, "alice");
    const listUrl = await openProjectBySlug(page, PROJECT_SLUG);
    // Design 1b + the project-tabs-2 review: the project's Threads tab IS the
    // shared 1g pane, filtered to the project. There is no second card list and
    // no origin badge on it — the `from runs` chip is the way to a run-origin
    // thread, and the thread's own PART OF panel is the deep link.
    await page.goto(`${listUrl}/threads`);
    await expect(
      page.getByTestId("threads-page"),
      "design 1g: the Threads tab is the shared list pane",
    ).toBeVisible({ timeout: 15_000 });

    // Find a run-linked conversation: the pane's `from runs` chip (ADR-0043's
    // `origin` query on the project's own list route). The M4 seed's exit runs
    // and the workbench journeys create agent conversations; if none exists yet
    // there is nothing to prove.
    await page.getByTestId("threads-filter-runs").click();
    await expect
      .poll(
        async () =>
          (await page
            .getByTestId("threads-list")
            .isVisible()
            .catch(() => false)) ||
          (await page
            .getByTestId("threads-nomatch")
            .isVisible()
            .catch(() => false)),
        { timeout: 15_000 },
      )
      .toBe(true);
    if (
      await page
        .getByTestId("threads-nomatch")
        .isVisible()
        .catch(() => false)
    ) {
      test.skip(
        true,
        "no run-linked conversation exists in m4-exit yet — nothing to link back from",
      );
      return;
    }
    // The row is the thread: 1g keys it by the conversation's own id and the
    // row anchor is the thread page (route contract C1).
    const row = page.locator('[data-testid^="thread-row-"]').first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    const rowHref = (await row.getAttribute("href")) ?? "";
    expect(rowHref).toMatch(/^\/threads\/[0-9a-f-]{36}$/);
    const conversationId = rowHref.split("/").pop() ?? "";
    await checkA11y(page, "conversations list (run-linked)");
    // The deep link this journey will follow must be the wire's own `run_link`
    // (ADR-0043) — the page may speak only from that, so it is read here and
    // compared with the rendered href below (the retired list badge used to
    // carry the same href in its `title`).
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
    await evidence(
      page,
      "conv-run-badge",
      `the project's Threads tab (the 1g pane) filtered with \`from runs\` lists a run-origin thread row (thread-row-${conversationId}) whose wire row names the run_link the thread page must link to`,
    );

    // --- The thread page: PART OF is behind the details disclosure now. ---
    await page.goto(rowHref);
    await expect(page.getByTestId("conversation-title")).toBeVisible({ timeout: 15_000 });
    const context = page.getByTestId("thread-context-block");
    await expect(
      context,
      "design thread view: the rail sits under the transcript behind one disclosure",
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      context.locator('[data-testid="part-of-run-link"]'),
      "the rail is collapsed by default — the deep link is not on screen until it is opened",
    ).toBeHidden();
    await context.locator("summary").click();
    await expect(context).toHaveAttribute("open", "");
    const partOfRun = page.getByTestId("part-of-run-link");
    await expect(partOfRun.first()).toBeVisible({ timeout: 15_000 });
    const linkHref = (await partOfRun.first().getAttribute("href")) ?? "";
    const deep = new URL(linkHref, "http://x");
    // Route contract C1: the workbench deep link is the project-less
    // `/runs/:runId`, and its ADR-0043 params are the wire's own.
    expect(deep.pathname, "the panel links the run the wire named").toBe(`/runs/${runLink.run_id}`);
    expect(deep.searchParams.get("node")).toBe(String(runLink.node_id));
    expect(deep.searchParams.get("instance")).toBe(String(runLink.node_execution_id ?? ""));
    expect(deep.searchParams.get("attempt")).toBe(String(runLink.attempt_number ?? ""));
    await checkA11y(page, "run-linked conversation page");
    await evidence(
      page,
      "conv-run-conversation-page",
      `with the Thread details disclosure opened, the thread page's part-of-run-link is the workbench deep link the wire's run_link names (${linkHref})`,
    );

    // --- Click it: the workbench opens with that node selected. ---
    await partOfRun.first().click();
    // SPA navigation (react-router) fires no "load" event, so waitForURL
    // would hang; toHaveURL polls the URL until the ?node= deep link lands.
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
      "the part-of-run link landed on the Run Workbench with the source node selected in the graph and the conversation open in the dock",
    );
  });

  test.describe("narrow 390x844", () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test("the new-conversation dialog fits without horizontal scroll", async ({ page }) => {
      await signInNarrow(page, "alice");
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
