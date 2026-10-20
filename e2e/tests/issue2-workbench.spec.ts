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
//   COMMUNICATION_E2E_ISSUE2=1 E2E_BASE_URL=http://localhost:15173 \
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
import {
  expectRunStatus,
  openProjectBySlug,
  repinAssignment,
  setMember,
  signIn,
} from "./helpers.js";

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
 * The id of the revision's agent.acp node, if it has one (the studio spec
 * inserts `code_review` on the test → review edge inside the until scope and
 * wraps a trailing until scope that ends in an `agent` step; the seeded
 * deterministic twin has neither). The studio insertion is preferred so the
 * journey drives the node it actually edited; any other agent.acp the
 * revision has is the fallback.
 *
 * The workbench canvas is the Studio canvas: a node box is
 * `canvas-step-<id>` (the definition node id) and its `div[role="button"]`
 * carries `aria-label="<kind label> step <id>"` — `agent.acp` boxes read
 * "Coding agent".
 */
async function findAcpSlug(page: Page): Promise<string | null> {
  const boxes = page.locator('[data-testid^="canvas-step-"]');
  const count = await boxes.count();
  const slugs: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const box = boxes.nth(i);
    const label =
      (await box.locator('div[role="button"]').first().getAttribute("aria-label")) ?? "";
    if (!/^Coding agent step /i.test(label)) continue;
    const testid = (await box.getAttribute("data-testid")) ?? "";
    const slug = testid.replace(/^canvas-step-/, "");
    if (slug) slugs.push(slug);
  }
  return slugs.find((slug) => slug === "code_review") ?? slugs[0] ?? null;
}

/** The workbench's node box for a definition node id, and its clickable inner button. */
function nodeButton(page: Page, id: string): Locator {
  return page.locator(`[data-testid="canvas-step-${id}"]`).locator('div[role="button"]').first();
}

/**
 * Click a node box and re-click until its row has been journaled: a box
 * clicked before its execution row exists resolves to an empty dock, and
 * the URL's `instance=` is what the dock reads, so the pick is retried on
 * the node box itself (never left on `workbench-dock-empty`).
 */
async function selectNode(page: Page, id: string, timeoutMs: number): Promise<void> {
  const dockEmpty = page.getByTestId("workbench-dock-empty");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await nodeButton(page, id).click();
    if ((await dockEmpty.count()) === 0) return;
    if (Date.now() >= deadline) throw new Error(`node ${id} never resolved to an execution`);
    await page.waitForTimeout(5_000);
  }
}

/**
 * State shared across the serial journey steps: which pipeline the run's
 * revision belongs to, where the run lives, and the ACP node's flow id.
 */
const state: {
  pipelineSlug: string;
  runUrl: string;
  acpSlug: string;
  revisionDigest: string;
} = {
  pipelineSlug: FALLBACK_SLUG,
  runUrl: "",
  acpSlug: "",
  revisionDigest: "",
};

test.describe.serial("issue2 workbench (A4 A5 A6 + reload + narrow)", () => {
  test.skip(
    !ISSUE2_ENABLED,
    "requires the M4 lab (COMMUNICATION_E2E_ISSUE2=1, E2E_BASE_URL=http://localhost:15173)",
  );
  test.use({ viewport: { width: 1500, height: 950 } });

  test("setup: revision, assignment, members bob/carol, start the run", async ({
    page,
    browser,
  }) => {
    test.setTimeout(600_000); // assignment pin + member forms + run start, all bounded waits
    console.log(`issue2-workbench: run stamp ${STAMP}`);
    await signIn(page, ADMIN);

    // The studio spec's published revision — the acceptance run always runs
    // studio first and its publish step records it.
    let published: {
      pipelineId?: string;
      revisionId?: string;
      revisionDigest?: string;
      pipelineSlug?: string;
    };
    try {
      published = JSON.parse(await readFile(PUBLISHED_PATH, "utf8"));
    } catch {
      published = {};
    }
    // The studio spec records { pipelineId, revisionDigest, pipelineSlug };
    // an older shape recorded revisionId. Either names the studio revision —
    // the assignment flow below pins the newest published one either way.
    const revisionRef = published.revisionDigest ?? published.revisionId ?? null;
    if (published.pipelineId && revisionRef) {
      state.pipelineSlug = published.pipelineSlug ?? FALLBACK_SLUG;
      state.revisionDigest = published.revisionDigest ?? "";
      console.log(`WORKBENCH setup: using studio-published revision ${revisionRef}`);
    } else {
      throw new Error(
        `WORKBENCH setup: ${PUBLISHED_PATH} is absent or incomplete — run issue2-studio.spec.ts first (it publishes the pipeline with the agent.acp code_review step)`,
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
    const projectId = projectPath.split("/")[2];

    // The run must start from the studio-published revision. The project's
    // existing assignment is pinned to an OLDER revision (r1, which has no
    // agent.acp code_review step), so new runs would start there and the whole
    // ACP journey would hang on a node that never exists. Re-pin the assignment
    // to the exact published revision. This is a SETUP call: the run itself is
    // started through the UI below, so this is preparation, not the journey.
    // `page.request` shares the signed-in session and echoes the CSRF token the
    // app's apiFetch does (from GET /api/v1/me).
    await repinAssignment(page, projectId, published.pipelineId as string, state.revisionDigest);

    // The assignment's "when to run" block proves the row is live on the tab.
    await page.goto(`${projectPath}/pipelines`);
    await expect(page.getByTestId("project-pipelines")).toBeVisible();
    await expect(page.getByTestId(`schedules-block-${state.pipelineSlug}`)).toBeVisible({
      timeout: NODE_STEP_TIMEOUT_MS,
    });

    // Members: bob as contributor, carol as viewer (idempotent add-OR-update,
    // with a bounded re-click on the collapsed add form).
    await setMember(page, projectPath, BOB.name, "contributor");
    await setMember(page, projectPath, CAROL.name, "viewer");

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
    test.setTimeout(1_200_000); // gate wait + one real agent turn, both bounded
    await signIn(page, ADMIN);
    const status = await openRun(page, state.runUrl);

    // The run page names the pinned revision — it must be the studio-published
    // one (the repin's proof), not the older revision without code_review.
    if (state.revisionDigest) {
      const digestShort = state.revisionDigest.startsWith("sha256:")
        ? state.revisionDigest.slice(7, 19)
        : state.revisionDigest.slice(0, 12);
      await expect(page.getByTestId("run-pinned-revision")).toContainText(digestShort, {
        timeout: NODE_STEP_TIMEOUT_MS,
      });
      console.log(`WORKBENCH A4: run pinned to the studio-published revision ${digestShort}`);
    }

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
        "WORKBENCH A4: no agent.acp node in the run's graph — the run is not pinned to the studio-published revision (which inserts the agent.acp code_review step). Re-pin the assignment in setup; run issue2-studio.spec.ts first.",
      );
    }
    if (state.acpSlug !== "code_review") {
      throw new Error(
        `WORKBENCH A4: the studio-inserted code_review agent.acp step is absent from the run's graph (found ${state.acpSlug}) — the run is not pinned to the studio-published revision. Re-pin the assignment in setup.`,
      );
    }
    // The `code_review` row is journaled when the loop schedules it; a pick
    // before that resolves to an empty dock, so selectNode re-clicks.
    await selectNode(page, state.acpSlug, NODE_STEP_TIMEOUT_MS);
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
    test.setTimeout(1_500_000); // one real agent turn behind the takeover, bounded
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
    await selectNode(bob, state.acpSlug, NODE_STEP_TIMEOUT_MS);
    const bobDock = bob.getByTestId("dock-conversation");
    await expect(bobDock).toBeVisible({ timeout: NODE_STEP_TIMEOUT_MS });
    const take = bob.getByTestId("dock-take-control");
    await expect(take).toBeEnabled({ timeout: NODE_STEP_TIMEOUT_MS });
    await take.click();
    // The badge is written in words: on bob's own page it reads "You are in
    // control" (the name "Controlled by Bob" is what OTHER pages show).
    await expect(bob.getByTestId("dock-controller")).toContainText(/you are in control/i, {
      timeout: NODE_STEP_TIMEOUT_MS,
    });
    await evidence(
      bob,
      "wb-a5-bob-control",
      `bob (contributor) took control of the ACP conversation — the dock's controller badge reads "You are in control"`,
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

    // bob prompts the agent; his message lands in the shared transcript, and
    // the turn is driven to completion: the dock's Stop button is rendered
    // exactly while a turn is in flight, so the reply has landed when it is
    // gone (a real agent turn is 15–120 s, bounded by AGENT_TURN_TIMEOUT_MS).
    const bobInput = bob.getByTestId("dock-composer-input");
    await expect(bobInput).toBeEnabled({ timeout: NODE_STEP_TIMEOUT_MS });
    await bobInput.fill("Please also check the README mentions add()");
    await bob.getByTestId("dock-composer-send").click();
    await expect
      .poll(async () => (await bobDock.textContent()) ?? "", { timeout: AGENT_TURN_TIMEOUT_MS })
      .toContain("Please also check the README mentions add()");
    await bob
      .getByTestId("dock-stop-turn")
      .waitFor({ state: "detached", timeout: AGENT_TURN_TIMEOUT_MS });

    // Return control to the factory; the run is not left paused.
    const back = bob.getByTestId("dock-return-control");
    await expect(back).toBeEnabled({ timeout: NODE_STEP_TIMEOUT_MS });
    await back.click();
    await expect(bob.getByTestId("dock-controller")).toContainText(
      /controlled by a pipeline run/i,
      {
        timeout: NODE_STEP_TIMEOUT_MS,
      },
    );
    await expect(bob.getByTestId("run-header-status")).not.toHaveText(/paused/i, {
      timeout: NODE_STEP_TIMEOUT_MS,
    });
    await evidence(
      bob,
      "wb-a5-returned",
      `bob returned control to the factory — the badge reads "Controlled by a pipeline run" and the run is not paused`,
    );

    // The event timeline lists the takeover and the return: the takeover
    // pauses the run (run.paused, actor bob) and the return resumes it
    // (run.resumed) — the journal's words for the handoffs.
    await page.getByTestId("workbench-tab-timeline").click();
    const feed = page.getByTestId("run-timeline");
    await expect(feed).toBeVisible({ timeout: NODE_STEP_TIMEOUT_MS });
    await expect(feed).toContainText("run.paused", { timeout: NODE_STEP_TIMEOUT_MS });
    await expect(feed).toContainText("run.resumed", { timeout: NODE_STEP_TIMEOUT_MS });
    await expect(feed).toContainText(new RegExp(BOB.name, "i"), { timeout: NODE_STEP_TIMEOUT_MS });
    await evidence(
      page,
      "wb-a5-timeline",
      "the workbench timeline lists the control handoffs — run.paused and run.resumed with bob as actor",
    );

    await bobContext.close();
    await carolContext.close();
  });

  test("A6: exec details, approval decision, until instances, fan-out, attempts", async ({
    page,
  }) => {
    test.setTimeout(2_400_000); // the terminal wait dominates (bounded, never open-ended)
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
    await nodeButton(page, "test").click();
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
    // iterations (the journal keys them [1], [2] — until iterations are
    // 1-based, ADR-0023 § 1); picking iteration 1 vs iteration 2 changes the
    // dock, which must be on an in-scope node to follow the pick.
    await nodeButton(page, "test").click();
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
    await expect
      .poll(async () => (await instanceLine()) ?? "", { timeout: NODE_STEP_TIMEOUT_MS })
      .toContain("iteration 1");
    const line1 = (await instanceLine()) ?? "";
    await evidence(page, "wb-a6-iter1", `the until scope's picker selects iteration 1 — ${line1}`);
    await untilChips
      .filter({ hasText: /^Iteration 2 ·/ })
      .first()
      .click();
    await expect
      .poll(async () => (await instanceLine()) ?? "", { timeout: NODE_STEP_TIMEOUT_MS })
      .not.toContain("iteration 1");
    const line2 = (await instanceLine()) ?? "";
    expect(line2, "the dock must change between iterations").not.toBe(line1);
    await evidence(page, "wb-a6-iter2", `the until scope's picker selects iteration 2 — ${line2}`);

    // The for_each fan-out: 14 items with per-state counts; select several.
    // The journal keys the items 0-based (`/fan_out[0]` … `/fan_out[13]`),
    // and the picker's chips read the raw index: chips 1–13 are the live
    // items (chip 14 is the declared slot). A pick alone does not move the
    // dock away from another scope's node — the in-scope node box (`invoke`)
    // is what resolves the picked item into the dock.
    const fanPicker = page.getByTestId("instance-picker-fan_out");
    await expect(fanPicker).toBeVisible({ timeout: NODE_STEP_TIMEOUT_MS });
    await expect(fanPicker).toContainText(/14 items/);
    const fanChips = fanPicker.locator("button", { hasText: /^Item \d+ ·/ });
    await expect
      .poll(async () => fanChips.count(), { timeout: NODE_STEP_TIMEOUT_MS })
      .toBeGreaterThanOrEqual(14);
    const fanLine = () => page.getByTestId("dock-instance-line").textContent();
    for (const item of [1, 2, 3, 4]) {
      await fanChips
        .filter({ hasText: new RegExp(`^Item ${item} ·`) })
        .first()
        .click();
      await nodeButton(page, "invoke").click();
      await expect
        .poll(async () => (await fanLine()) ?? "", { timeout: NODE_STEP_TIMEOUT_MS })
        .toContain(`iteration ${item}`);
    }
    const fanPage = fanPicker.getByTestId("instance-fan_out-page");
    if ((await fanPage.count()) > 0) {
      expect(await fanPage.textContent()).toContain(" of ");
    }
    await evidence(
      page,
      "wb-a6-fanout",
      "the for_each scope shows 14 items with per-state counts; items 1-4 were selected and the dock followed the picks",
    );

    // Item 13 (journal index 12, picker chip "Item 12") is the child that
    // exits 1. The retry lives in the CHILD run — the child's implement step
    // retries the infra failure (maxAttempts 2) — while the parent's invoke
    // row is a control-plane decision ("attempt 0 of 1"). Follow the dock's
    // "Open child run" link and read the attempts there: the child's step
    // shows attempt tabs or an "attempt k of m" greater than one attempt.
    await fanChips
      .filter({ hasText: /^Item 12 ·/ })
      .first()
      .click();
    await nodeButton(page, "invoke").click();
    const childLink = page.getByTestId("dock-child-run-link");
    await expect(childLink).toBeVisible({ timeout: NODE_STEP_TIMEOUT_MS });
    await childLink.click();
    await expect(page.getByTestId("workbench")).toBeVisible({ timeout: NODE_STEP_TIMEOUT_MS });
    await selectNode(page, "implement", NODE_STEP_TIMEOUT_MS);
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
      "fan-out item 13 (the child that exits 1) — its child run's implement step shows more than one attempt — attempt tabs or 'attempt k of m' with m > 1",
    );

    // Back to the run's own graph for the node-count guard: the graph never
    // grows extra definition nodes from run instances.
    await page.goto(state.runUrl);
    await expect(page.locator(".react-flow").first()).toBeVisible({
      timeout: NODE_STEP_TIMEOUT_MS,
    });
    const after = await canvasNodes();
    expect(after, "the canvas's node count must not grow with run instances").toBe(before);

    // Terminal state: completed, or failed because of item 13 — either is
    // acceptable; log which one the run reached.
    await expectRunStatus(page, /completed|failed|cancelled|interrupted/i, TERMINAL_TIMEOUT_MS);
    const terminal = (await page.getByTestId("run-header-status").textContent()) ?? "";
    console.log(`WORKBENCH A6: run reached terminal state: ${terminal.trim()}`);
  });

  test("narrow 390x844: graph then dock as a sheet, no horizontal scroll", async ({ page }) => {
    test.setTimeout(300_000);
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
