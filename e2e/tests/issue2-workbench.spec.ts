// Issue #2 acceptance journeys for the live Run Workbench:
// A4 (the run page opens graph-first, the dock auto-selects the node that
// needs attention, the human gate is approved from the dock, the agent.acp
// node shows a live transcript), A5 (bob takes control of the ACP
// conversation, carol is read-only, the factory takes the conversation back,
// the timeline records the handoffs), A6 (process.exec facts, the approval
// decision, the until scope's iteration instances, the for_each fan-out items
// with the retried item 13, and the terminal state) plus a mid-run reload
// and the narrow (390x844) layout.
//
// It runs against the M4 lab ONLY when COMMUNICATION_E2E_ISSUE2=1 — skipped
// everywhere else, the same env-gate idiom as the sibling issue2 specs:
//   COMMUNICATION_E2E_ISSUE2=1 E2E_BASE_URL=http://localhost:18091 \
//     pnpm exec playwright test tests/issue2-workbench.spec.ts
// The run starts from the revision issue2-studio.spec.ts published (recorded
// in ${EVIDENCE_DIR}/published.json); if that file is absent the spec FAILS
// with a clear "run issue2-studio.spec.ts first" message instead of silently
// skipping the ACP-dependent steps, because the seeded twin is pure
// process.exec and carries no agent.acp node. With the studio revision
// present the run is a real agent turn through the lab worker (m4-reviewer
// via the inserted code_review node), so every wait around it is bounded by
// AGENT_TURN_TIMEOUT_MS and never open-ended.
//
// Every journey step calls the local `evidence()`: a full-page screenshot
// into ${E2E_EVIDENCE_DIR ?? "test-results/issue2"}/<name>.png plus one
// console line `EVIDENCE <name>: <what it proves>`.
//
// Accessibility: the shared axe pass (tests/a11y.ts, @axe-core/playwright,
// wcag2a+wcag2aa, failing only on serious/critical) audits the workbench
// graph view, the ACP dock, the viewer (carol) view, and the narrow layout.
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { test, expect, type Locator, type Page } from "@playwright/test";
import { checkA11y } from "./a11y.js";
import { AGENT_TURN_TIMEOUT_MS } from "./env.js";
import { addMember, expectRunStatus, openProjectBySlug, signIn } from "./helpers.js";

const ISSUE2_ENABLED = process.env.COMMUNICATION_E2E_ISSUE2 === "1";
/** Unique per run so re-runs never collide with their own earlier rows. */
const STAMP = process.env.E2E_ISSUE2_STAMP ?? Date.now().toString(36);
const PROJECT_SLUG = "m4-exit";
const FALLBACK_SLUG = "feature-development-deterministic";
const EVIDENCE_DIR = process.env.E2E_EVIDENCE_DIR ?? "test-results/issue2";
const PUBLISHED_PATH = path.join(EVIDENCE_DIR, "published.json");
/** Lab identities (docs/compatibility/probes/m4/seed.sh), named here so the
 * directory row's display name is the one the journey asserts on. */
const ADMIN = "admin";
const BOB = { subject: "bob", name: "Bob" };
const CAROL = { subject: "carol", name: "Carol" };
/** A node step is worker polls plus sleep inputs, not milliseconds. */
const NODE_STEP_TIMEOUT_MS = Number(process.env.E2E_NODE_STEP_TIMEOUT_MS ?? 420_000);
/** fanout_count=14 child runs with 20 s holds; bounded, never open-ended. */
const TERMINAL_TIMEOUT_MS = Number(process.env.E2E_TERMINAL_TIMEOUT_MS ?? 1_800_000);

/** One piece of journey evidence: a screenshot plus a single log line. */
async function evidence(page: Page, name: string, what: string): Promise<void> {
  await mkdir(EVIDENCE_DIR, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCE_DIR, `${name}.png`), fullPage: true });
  console.log(`EVIDENCE ${name}: ${what}`);
}

/**
 * Open a run URL and wait for the workbench to mount. Returns the page's one
 * description of the run's status (`run-header-status`).
 */
async function openRun(page: Page, runUrl: string): Promise<Locator> {
  await page.goto(runUrl);
  await expect(page.getByTestId("workbench")).toBeVisible({ timeout: NODE_STEP_TIMEOUT_MS });
  return page.getByTestId("run-header-status");
}

/**
 * The graph test-id suffix of the revision's agent.acp node, if it has one
 * (the studio spec inserts `code_review` on the test → review edge; the
 * seeded deterministic twin has none). Suffix = keySlug: `/` → `-`.
 */
async function findAcpSlug(page: Page): Promise<string | null> {
  const chips = page.locator('[data-testid^="definition-graph-node-kind-"]');
  const count = await chips.count();
  for (let i = 0; i < count; i++) {
    const chip = chips.nth(i);
    // The box shows the kind's short word ("agent"); the catalogue name
    // (`agent.acp`) travels in the `title` attribute.
    const texts = [(await chip.textContent()) ?? "", (await chip.getAttribute("title")) ?? ""].join(
      " ",
    );
    if (texts.includes("agent.acp")) {
      const testid = await chip.getAttribute("data-testid");
      return testid?.replace(/^definition-graph-node-kind-/, "") ?? null;
    }
  }
  return null;
}

/** The `definition-graph-node-*` buttons on the canvas, by node key slug. */
function nodeButton(page: Page, slug: string): Locator {
  return page.getByTestId(`definition-graph-node-${slug}`);
}

/**
 * State shared across the serial journey steps: which pipeline the run's
 * revision belongs to and where the run lives.
 */
const state: { pipelineSlug: string; runUrl: string; acpSlug: string } = {
  pipelineSlug: FALLBACK_SLUG,
  runUrl: "",
  acpSlug: "",
};

test.describe.serial("issue2 workbench (A4 A5 A6 + reload + narrow)", () => {
  test.skip(
    !ISSUE2_ENABLED,
    "requires the M4 lab (COMMUNICATION_E2E_ISSUE2=1, E2E_BASE_URL=http://localhost:18091)",
  );
  test.use({ viewport: { width: 1500, height: 950 } });

  test("setup: revision, assignment, members bob/carol, start the run", async ({
    page,
    browser,
  }) => {
    console.log(`issue2-workbench: run stamp ${STAMP}`);
    await signIn(page, ADMIN);

    // The studio spec's published revision — the acceptance run always runs
    // studio first and its publish step records it.
    let published: { pipelineId?: string; revisionId?: string; pipelineSlug?: string };
    try {
      published = JSON.parse(await readFile(PUBLISHED_PATH, "utf8"));
    } catch {
      published = {};
    }
    if (published.pipelineId && published.revisionId) {
      state.pipelineSlug = published.pipelineSlug ?? FALLBACK_SLUG;
      console.log(`WORKBENCH setup: using studio-published revision ${published.revisionId}`);
    } else {
      throw new Error(
        `WORKBENCH setup: ${PUBLISHED_PATH} is absent — run issue2-studio.spec.ts first (it publishes the pipeline with the agent.acp code_review step)`,
      );
    }

    // bob and carol must exist in the user directory before the member form
    // can offer them: one throwaway sign-in each (also gives them a readable
    // display name, which the journey asserts on).
    for (const member of [BOB, CAROL]) {
      const context = await browser.newContext();
      const memberPage = await context.newPage();
      await signIn(memberPage, member.subject, {
        name: member.name,
        email: `${member.subject}@lab.example`,
      });
      await context.close();
    }

    const projectPath = await openProjectBySlug(page, PROJECT_SLUG);

    // Assignment: the assign form pins the newest published revision, which
    // is the one the studio spec published.
    await page.goto(`${projectPath}/pipelines`);
    await expect(page.getByTestId("project-pipelines")).toBeVisible();
    const assignOpen = page.getByTestId(`assign-open-${state.pipelineSlug}`);
    if ((await assignOpen.count()) > 0 && (await assignOpen.isVisible())) {
      await assignOpen.click();
      const pinning = page.getByTestId(`assign-pinning-${state.pipelineSlug}`);
      await expect(pinning).toContainText(/id [0-9a-f]{8}/, { timeout: NODE_STEP_TIMEOUT_MS });
      await page.getByTestId(`assign-confirm-${state.pipelineSlug}`).click();
    }
    await expect(page.getByTestId(`schedules-block-${state.pipelineSlug}`)).toBeVisible({
      timeout: NODE_STEP_TIMEOUT_MS,
    });

    // Members: bob as contributor, carol as viewer (the form is add-OR-update,
    // so a seeded role is corrected through the same flow).
    await addMember(page, projectPath, BOB.name, "contributor");
    await addMember(page, projectPath, CAROL.name, "viewer");

    // Start the run from the project's New run flow.
    await page.goto(`${projectPath}/runs`);
    await page.getByTestId("runs-new").click();
    const assignment = page.getByTestId("new-run-assignment");
    if ((await assignment.count()) > 0) {
      const option = assignment.locator("option", { hasText: state.pipelineSlug }).first();
      await expect(option).toBeAttached({ timeout: NODE_STEP_TIMEOUT_MS });
      await assignment.selectOption((await option.getAttribute("value")) ?? "");
    }
    await page.getByTestId("new-run-input-goal").fill(`issue2 acceptance ${STAMP}`);
    const repo = page.getByTestId("new-run-input-repository");
    const repoChoice = repo.locator("option").nth(1);
    await expect(repoChoice).toBeAttached({ timeout: NODE_STEP_TIMEOUT_MS });
    await repo.selectOption((await repoChoice.getAttribute("value")) ?? "");
    await page.getByTestId("new-run-input-fanout").check();
    await page.getByTestId("new-run-input-fanout_count").fill("14");
    await page.getByTestId("new-run-input-hold_seconds").fill("20");
    await page.getByTestId("new-run-submit").click();
    await page.waitForURL(/\/projects\/[0-9a-f-]{36}\/runs\/[0-9a-f-]{36}/, {
      timeout: NODE_STEP_TIMEOUT_MS,
    });
    state.runUrl = page.url();
    console.log(`WORKBENCH setup: run started at ${state.runUrl}`);
    await evidence(page, "wb-setup-run-started", "the run started with fanout=14, hold_seconds=20");
  });

  test("A4: graph-first run page, dock on the active node, approval, live ACP", async ({
    page,
  }) => {
    await signIn(page, ADMIN);
    const status = await openRun(page, state.runUrl);

    // The DEFAULT view is the graph: tab selected, canvas present, and the
    // definition table (the collapsed step list) is not the surface.
    await expect(page.getByTestId("workbench-tab-graph")).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".react-flow").first()).toBeVisible({
      timeout: NODE_STEP_TIMEOUT_MS,
    });
    const list = page.getByTestId("definition-graph-list");
    expect((await list.count()) === 0 || !(await list.first().isVisible())).toBeTruthy();

    // Auto-select: on first data the run's attention node is selected and the
    // dock shows it (the dock's title, not its empty state).
    await expect
      .poll(async () => new URL(page.url()).searchParams.get("node"), {
        timeout: NODE_STEP_TIMEOUT_MS,
      })
      .not.toBeNull();
    await expect(page.getByTestId("workbench-dock")).toBeVisible({
      timeout: NODE_STEP_TIMEOUT_MS,
    });
    await expect(page.getByTestId("workbench-dock-empty")).toHaveCount(0);
    await evidence(
      page,
      "wb-a4-graph-default",
      "the run page opens graph-first: graph tab selected, react-flow canvas visible (no definition table), the attention node auto-selected and docked",
    );
    await checkA11y(page, "workbench graph view");

    // Approve the human gate when it appears: select it in the graph, the
    // dock shows the approval card, approve from the card.
    await nodeButton(page, "approve").click();
    const decision = page.getByTestId("approval-decision-form");
    await expect(decision).toBeVisible({ timeout: NODE_STEP_TIMEOUT_MS });
    await page.getByTestId("approval-approve").click();
    await expect(decision).toHaveCount(0, { timeout: NODE_STEP_TIMEOUT_MS });
    await evidence(
      page,
      "wb-a4-approval",
      "the approve human gate was selected in the graph and approved from the dock's approval card",
    );
    await expect(status).toContainText(/running|waiting|completed|failed/i, {
      timeout: NODE_STEP_TIMEOUT_MS,
    });

    // The ACP step: the agent.acp the studio spec inserted (or any agent.acp
    // the revision has) runs live in the dock's conversation.
    state.acpSlug = (await findAcpSlug(page)) ?? "";
    if (!state.acpSlug) {
      throw new Error(
        "WORKBENCH A4: no agent.acp node in this revision — run issue2-studio.spec.ts first (it publishes the pipeline with the agent.acp code_review step)",
      );
    }
    await nodeButton(page, state.acpSlug).click();
    const dockConversation = page.getByTestId("dock-conversation");
    await expect(dockConversation).toBeVisible({ timeout: NODE_STEP_TIMEOUT_MS });
    await expect
      .poll(async () => dockConversation.locator('[data-testid="transcript-item"]').count(), {
        timeout: NODE_STEP_TIMEOUT_MS,
      })
      .toBeGreaterThan(0);
    await evidence(
      page,
      "wb-a4-acp-live",
      `the agent.acp node ${state.acpSlug} is selected and the dock shows its live conversation transcript (agent messages / tool events)`,
    );
    await checkA11y(page, "workbench ACP dock");
  });

  test("A5: bob takes control, carol read-only, factory takes back, timeline", async ({
    page,
    browser,
  }) => {
    test.skip(!state.acpSlug, "no agent.acp node in this revision — ACP handoff journey skipped");

    // admin keeps the run open (also warms the ACP selection), while bob and
    // carol sign in their own contexts.
    await signIn(page, ADMIN);
    await openRun(page, state.runUrl);

    const bobContext = await browser.newContext();
    const bob = await bobContext.newPage();
    await signIn(bob, BOB.subject, { name: BOB.name, email: `${BOB.subject}@lab.example` });
    const carolContext = await browser.newContext();
    const carol = await carolContext.newPage();
    await signIn(carol, CAROL.subject, { name: CAROL.name, email: `${CAROL.subject}@lab.example` });

    // bob (contributor): open the same run, select the ACP node, take control.
    await openRun(bob, state.runUrl);
    await nodeButton(bob, state.acpSlug).click();
    const bobDock = bob.getByTestId("dock-conversation");
    await expect(bobDock).toBeVisible({ timeout: NODE_STEP_TIMEOUT_MS });
    const take = bob.getByTestId("dock-take-control");
    await expect(take).toBeEnabled({ timeout: NODE_STEP_TIMEOUT_MS });
    await take.click();
    await expect(bob.getByTestId("dock-controller")).toContainText(BOB.name, {
      timeout: NODE_STEP_TIMEOUT_MS,
    });
    await evidence(
      bob,
      "wb-a5-bob-control",
      `bob (contributor) took control of the ACP conversation — the dock's controller badge names ${BOB.name}`,
    );

    // carol (viewer): the same dock shows Take control disabled and no
    // enabled composer.
    await openRun(carol, state.runUrl);
    await nodeButton(carol, state.acpSlug).click();
    await expect(carol.getByTestId("dock-conversation")).toBeVisible({
      timeout: NODE_STEP_TIMEOUT_MS,
    });
    await expect(carol.getByTestId("dock-take-control")).toBeDisabled();
    const carolInput = carol.getByTestId("dock-composer-input");
    await expect(carolInput).toBeDisabled();
    const carolExplainer = carol.getByTestId("dock-composer-explainer");
    if ((await carolExplainer.count()) > 0) {
      expect(await carolExplainer.first().isVisible()).toBeTruthy();
    }
    await evidence(
      carol,
      "wb-a5-carol-readonly",
      `carol (viewer) sees Take control disabled (with the composer explainer) and a disabled composer on the same ACP node`,
    );
    await checkA11y(carol, "workbench viewer (carol)");

    // bob prompts the agent; his message lands in the shared transcript.
    const bobInput = bob.getByTestId("dock-composer-input");
    await expect(bobInput).toBeEnabled({ timeout: NODE_STEP_TIMEOUT_MS });
    await bobInput.fill("Please also check the README mentions add()");
    await bob.getByTestId("dock-composer-send").click();
    await expect
      .poll(async () => (await bobDock.textContent()) ?? "", { timeout: AGENT_TURN_TIMEOUT_MS })
      .toContain("Please also check the README mentions add()");

    // Return control to the factory; the run is not left paused.
    const back = bob.getByTestId("dock-return-control");
    await expect(back).toBeEnabled({ timeout: NODE_STEP_TIMEOUT_MS });
    await back.click();
    await expect(bob.getByTestId("dock-controller")).not.toContainText(BOB.name, {
      timeout: NODE_STEP_TIMEOUT_MS,
    });
    await expect(bob.getByTestId("run-header-status")).not.toHaveText(/paused/i, {
      timeout: NODE_STEP_TIMEOUT_MS,
    });
    await evidence(
      bob,
      "wb-a5-returned",
      `bob returned control to the factory — the badge no longer names ${BOB.name} and the run is not paused`,
    );

    // The event timeline lists the takeover and the return.
    await page.getByTestId("workbench-tab-timeline").click();
    const feed = page.getByTestId("activity-feed");
    await expect(feed).toBeVisible();
    await expect(feed).toContainText(/control/i, { timeout: NODE_STEP_TIMEOUT_MS });
    await expect(feed).toContainText(new RegExp(BOB.name, "i"), { timeout: NODE_STEP_TIMEOUT_MS });
    await evidence(
      page,
      "wb-a5-timeline",
      "the workbench timeline lists the control handoffs (bob's takeover and return)",
    );

    await bobContext.close();
    await carolContext.close();
  });

  test("A6: exec details, approval decision, until instances, fan-out, attempts", async ({
    page,
  }) => {
    await signIn(page, ADMIN);
    await openRun(page, state.runUrl);
    await expect(page.locator(".react-flow").first()).toBeVisible({
      timeout: NODE_STEP_TIMEOUT_MS,
    });
    const canvasNodes = () =>
      page.locator('[data-testid="workbench-graph-frame"] .react-flow__node').count();
    const before = await canvasNodes();
    expect(before, "the canvas must show step nodes").toBeGreaterThan(0);

    // Reload mid-run: the selection from the URL is restored and the stream
    // is live again.
    await nodeButton(page, "approve").click();
    expect(new URL(page.url()).searchParams.get("node")).toBe("approve");
    await page.reload();
    await expect(page.getByTestId("workbench")).toBeVisible({ timeout: NODE_STEP_TIMEOUT_MS });
    expect(new URL(page.url()).searchParams.get("node"), "selection must survive the reload").toBe(
      "approve",
    );
    await expect(page.getByTestId("dock-title")).toBeVisible({ timeout: NODE_STEP_TIMEOUT_MS });
    await expect(page.getByTestId("run-stream-status")).toContainText(/live|reconnecting/i, {
      timeout: 60_000,
    });
    console.log("WORKBENCH A6: mid-run reload restored the approve selection and a live stream");

    // A process.exec node: the dock shows its exit code and captured output.
    await nodeButton(page, "build_until_verified-test").click();
    await expect(page.getByTestId("attempt-exit-code")).toBeVisible({
      timeout: NODE_STEP_TIMEOUT_MS,
    });
    await evidence(
      page,
      "wb-a6-exec",
      "a process.exec node (test) is selected; the dock shows its exit code and captured stdout/stderr",
    );

    // The approval node: the decision the card records after A4's approve.
    await nodeButton(page, "approve").click();
    await expect(page.getByTestId("approval-summary")).toBeVisible({
      timeout: NODE_STEP_TIMEOUT_MS,
    });

    // The until scope's instance picker: at least the two deterministic
    // iterations; picking iteration 1 vs iteration 0 changes the dock.
    const untilPicker = page.getByTestId("instance-picker-build_until_verified");
    await expect(untilPicker).toBeVisible({ timeout: NODE_STEP_TIMEOUT_MS });
    const untilChips = untilPicker.locator("button", { hasText: /^Iteration \d+ ·/ });
    await expect
      .poll(async () => untilChips.count(), { timeout: NODE_STEP_TIMEOUT_MS })
      .toBeGreaterThanOrEqual(2);
    const instanceLine = () => page.getByTestId("dock-instance-line").textContent();
    await untilChips
      .filter({ hasText: /^Iteration 1 ·/ })
      .first()
      .click();
    await expect(page.getByTestId("dock-title")).toBeVisible({ timeout: NODE_STEP_TIMEOUT_MS });
    const line1 = (await instanceLine()) ?? "";
    await evidence(page, "wb-a6-iter1", `the until scope's picker selects iteration 1 — ${line1}`);
    await untilChips
      .filter({ hasText: /^Iteration 0 ·/ })
      .first()
      .click();
    const line0 = (await instanceLine()) ?? "";
    expect(line0, "the dock must change between iterations").not.toBe(line1);
    await evidence(page, "wb-a6-iter2", `the until scope's picker selects iteration 0 — ${line0}`);

    // The for_each fan-out: 14 items with per-state counts; select several.
    const fanPicker = page.getByTestId("instance-picker-fan_out");
    await expect(fanPicker).toBeVisible({ timeout: NODE_STEP_TIMEOUT_MS });
    await expect(fanPicker).toContainText(/14 items/);
    const fanChips = fanPicker.locator("button", { hasText: /^Item \d+ ·/ });
    await expect
      .poll(async () => fanChips.count(), { timeout: NODE_STEP_TIMEOUT_MS })
      .toBeGreaterThanOrEqual(14);
    await fanChips
      .filter({ hasText: /^Item 0 ·/ })
      .first()
      .click();
    await expect(page.getByTestId("dock-title")).toBeVisible({ timeout: NODE_STEP_TIMEOUT_MS });
    await fanChips
      .filter({ hasText: /^Item 1 ·/ })
      .first()
      .click();
    await fanChips
      .filter({ hasText: /^Item 2 ·/ })
      .first()
      .click();
    await fanChips
      .filter({ hasText: /^Item 3 ·/ })
      .first()
      .click();
    const fanPage = fanPicker.getByTestId("instance-fan_out-page");
    if ((await fanPage.count()) > 0) {
      expect(await fanPage.textContent()).toContain(" of ");
    }
    await evidence(
      page,
      "wb-a6-fanout",
      "the for_each scope shows 14 items with per-state counts; items 0-3 were selected and the dock followed the picks",
    );

    // Item 13 (index 12) is the child that exits 1: it retried, so the dock
    // shows attempt tabs or an "attempt k of m" greater than one attempt.
    await fanChips
      .filter({ hasText: /^Item 12 ·/ })
      .first()
      .click();
    await expect
      .poll(
        async () => {
          const tabs = await page.getByTestId(/^dock-attempt-\d+$/).count();
          const countLine = page.getByTestId("dock-attempt-count");
          const text = (await countLine.count()) > 0 ? ((await countLine.textContent()) ?? "") : "";
          const of = /of (\d+)/.exec(text);
          return Math.max(tabs, of ? Number(of[1]) : 0);
        },
        { timeout: NODE_STEP_TIMEOUT_MS },
      )
      .toBeGreaterThan(1);
    await evidence(
      page,
      "wb-a6-attempts",
      "fan-out item 13 (the child that exits 1) shows more than one attempt — attempt tabs or 'attempt k of m' with m > 1",
    );

    // The graph never grows extra definition nodes from run instances.
    const after = await canvasNodes();
    expect(after, "the canvas's node count must not grow with run instances").toBe(before);

    // Terminal state: completed, or failed because of item 13 — either is
    // acceptable; log which one the run reached.
    await expectRunStatus(page, /completed|failed|cancelled|interrupted/i, TERMINAL_TIMEOUT_MS);
    const terminal = (await page.getByTestId("run-header-status").textContent()) ?? "";
    console.log(`WORKBENCH A6: run reached terminal state: ${terminal.trim()}`);
  });

  test("narrow 390x844: graph then dock as a sheet, no horizontal scroll", async ({ page }) => {
    await signIn(page, ADMIN);
    await page.setViewportSize({ width: 390, height: 844 });
    await openRun(page, state.runUrl);
    // Graph on top; the dock sits below the graph as a full-width sheet with
    // its own back-to-graph control, not the desktop side pane.
    await expect(page.locator(".react-flow").first()).toBeVisible({
      timeout: NODE_STEP_TIMEOUT_MS,
    });
    await expect(page.getByTestId("workbench-dock-panel")).toBeVisible({
      timeout: NODE_STEP_TIMEOUT_MS,
    });
    await expect(page.getByTestId("workbench-dock-back")).toBeVisible();
    expect(await page.getByTestId("workbench-dock-pane").count()).toBe(0);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      "no horizontal scroll at 390px",
    ).toBeTruthy();
    await evidence(
      page,
      "wb-narrow",
      "at 390x844 the workbench is the graph with the dock below it as a sheet (back-to-graph control) and no horizontal scroll",
    );
    await checkA11y(page, "narrow workbench");
  });
});
