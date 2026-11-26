// Phase 2 acceptance, redesigned (R8): `/` is the all-projects Home — the
// greeting and the ask prompt on top, "Since you left" on the left, and NEEDS
// YOU / RUNNING / FACTORY HEALTH down the right column
// (ui/src/pages/Home.tsx; docs/design/redesign/CONTRACT.md, section
// "① Home — the one place you start"). The retired cross-project Board is still
// retired: `/inbox` and `/board` redirect here (proven in shell-p1-shell.spec).
//
// What the old page's job was, and who does it now:
//   * the count line (`home-count-line`, "1 need you · 2 failed …") is retired
//     with the Board column counts — FACTORY HEALTH is the redesigned sentence
//     that carries numbers, and it is its OWN labelled section, not a line
//     borrowed from a heading (test: "FACTORY HEALTH is a section of its own").
//   * the decision callouts (`home-callout-…`, `home-show-more`) are retired;
//     NEEDS YOU is the replacement and it caps nothing: one card per gate
//     waiting on the reader, in the approvals read's own order (test: "the
//     gates waiting on me are the waiting list, in the API's order").
//   * the "Running now" cards (`home-run-…`) are retired; RUNNING is the
//     replacement — a run row per running run, newest first, each opening its
//     workbench (test: "RUNNING lists exactly the running runs, newest first").
//   * `Ask the factory in your own words` (custom quick replies, `home-prompt`)
//     has no replacement anywhere in the redesign — the ask box is one sentence
//     into a run and the quick-action row is fixed. RETIRED, see the worker's
//     report.
// Every number and every row is checked against the same reads the page itself
// answers to: `GET /api/v1/runs` on the Board's query (ADR-0047 — Home and the
// Board can never disagree) and `GET /api/v1/approvals?status=pending`.
//
// Runs ONLY when COMMUNICATION_E2E_SHELL=1. checkShellScreen on every page;
// evidence() per step. Scratch gates and scratch runs are seeded through the
// API; nothing seeded here is decided, cancelled or deleted.
import { expect, test, type Page } from "@playwright/test";
import { BASE_URL } from "./env.js";
import { signIn } from "./helpers.js";
import {
  SHELL_ENABLED,
  SHELL_GATE,
  apiBoardRuns,
  apiCsrf,
  apiPendingApprovals,
  apiProjectWithRepo,
  apiPublishPipeline,
  apiScratchProject,
  apiStartRun,
  checkShellScreen,
  evidence,
  noSidewaysScrollInShell,
  watchPageErrors,
} from "./shell-helpers.js";

/**
 * A `human.approval` ROOT node: the run enters `waiting_human` the moment it
 * exists — no worker turn — and its gate stays pending (the m5-journey /
 * shell-p789 pattern). The 24 h deadline keeps the seeded gate pending for the
 * whole suite; the journey never decides it.
 */
const GATE_YAML = (
  slug: string,
): string => `# shell-p2 needs-you gate: one maintainer approval at the root.
apiVersion: communication.dev/v1alpha1
kind: Pipeline
metadata:
  name: ${slug}
  description: >-
    Shell-p2 scratch gate for acceptance: a pending gate the journey never decides.
spec:
  inputs:
    type: object
    required: [goal]
    properties:
      goal:
        type: string
        minLength: 1
        description: What the gate is asking about.
  outputs:
    type: object
    required: [after]
    properties:
      after: {type: string}
  policies:
    maxConcurrentNodes: 1
    maxDurationSeconds: 604800
    maxNodeExecutions: 20
    maxChildDepth: 0
    workspaceMode: worktree
    cancelPolicy: cascade
  nodes:
  - id: approve
    kind: human.approval
    retry:
      maxAttempts: 1
    config:
      summary: |-
        Shell-p2 needs-you gate for \${{ inputs.goal }} — pending, never decided.
      approverRoles: [maintainer]
      deadlineSeconds: 86400
      onTimeout: fail
  - id: after_gate
    kind: process.exec
    dependsOn: [approve]
    timeoutSeconds: 120
    retry:
      maxAttempts: 1
    config:
      executable: printf
      args:
      - '%s\\n'
      - '{"after":"ran off the needs-you gate"}'
      outputExtraction: {mode: json_from_stdout}
    outputs:
      type: object
      required: [after]
      properties:
        after: {type: string}
  resultBindings:
    after: \${{ nodes.after_gate.outputs.after }}
`;

/** One long-running `process.exec` node: the run sits in `running` for ~2 min,
 * which is the window RUNNING and FACTORY HEALTH are read inside. */
const SLEEP_YAML = (slug: string): string => `# shell-p2 running probe: one long process.exec node.
apiVersion: communication.dev/v1alpha1
kind: Pipeline
metadata:
  name: ${slug}
  description: >-
    Shell-p2 scratch probe for acceptance: a run that sits in running.
spec:
  inputs:
    type: object
    required: [goal]
    properties:
      goal:
        type: string
        minLength: 1
        description: What the run is about.
  outputs:
    type: object
    required: [after]
    properties:
      after: {type: string}
  policies:
    maxConcurrentNodes: 1
    maxDurationSeconds: 604800
    maxNodeExecutions: 20
    maxChildDepth: 0
    workspaceMode: worktree
    cancelPolicy: cascade
  nodes:
  - id: nap
    kind: process.exec
    retry:
      maxAttempts: 1
    timeoutSeconds: 600
    config:
      executable: sleep
      args:
      - '150'
  - id: after_nap
    kind: process.exec
    dependsOn: [nap]
    timeoutSeconds: 120
    retry:
      maxAttempts: 1
    config:
      executable: printf
      args:
      - '%s\\n'
      - '{"after":"woke up"}'
      outputExtraction: {mode: json_from_stdout}
    outputs:
      type: object
      required: [after]
      properties:
        after: {type: string}
  resultBindings:
    after: \${{ nodes.after_nap.outputs.after }}
`;

/** Seed one pending gate and wait for it to reach the cross-project read. */
async function seedGate(page: Page, goal: string): Promise<string> {
  const request = page.request;
  const csrf = await apiCsrf(request);
  const project = await apiScratchProject(request);
  const slug = `p2-needs-${Date.now().toString(36)}-${goal.replace(/\s+/g, "-").toLowerCase()}`;
  const { revisionId } = await apiPublishPipeline(request, csrf, slug, GATE_YAML(slug));
  const runId = await apiStartRun(request, csrf, project.id, revisionId, { goal });
  await expect
    .poll(
      async () =>
        (await apiPendingApprovals(request)).some((row) => row.run_id === runId) ? 1 : 0,
      { message: `the seeded gate for run ${runId} reaches the pending approvals read` },
    )
    .toBe(1);
  return runId;
}

/** Seed `count` runs that sit in `running` and wait for the Board read to say
 * so. Returns their ids in start order (oldest first). */
async function seedRunning(page: Page, count: number): Promise<string[]> {
  const request = page.request;
  const csrf = await apiCsrf(request);
  const project = await apiProjectWithRepo(request);
  const slug = `p2-running-${Date.now().toString(36)}`;
  const { revisionId } = await apiPublishPipeline(request, csrf, slug, SLEEP_YAML(slug));
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    ids.push(await apiStartRun(request, csrf, project.id, revisionId, { goal: `probe ${i}` }));
  }
  await expect
    .poll(
      async () =>
        (await apiBoardRuns(request)).filter(
          (row) => ids.includes(row.id) && row.status === "running",
        ).length,
      {
        message: `the ${count} probe runs must be claimed and running on the Board's own read`,
        timeout: 180_000,
      },
    )
    .toBe(count);
  return ids;
}

/** The run ids RUNNING lists, top to bottom. */
const runningRowIds = (page: Page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid^="running-row-"]')).map((el) =>
      (el.getAttribute("data-testid") ?? "").replace("running-row-", ""),
    ),
  );

test.describe("shell p2 — Home: needs you, running, factory health", () => {
  test.skip(!SHELL_ENABLED, SHELL_GATE);
  test.use({ viewport: { width: 1500, height: 950 } });
  test.setTimeout(12 * 60_000);

  test("an empty home says so plainly, in the redesigned blocks, with nothing left over from the Board", async ({
    page,
  }) => {
    // A brand-new reader: the lab's own projects are not theirs, so every
    // section is read in its empty state.
    const subject = `e2e-shell-p2-empty-${Date.now().toString(36)}`;
    await signIn(page, subject);
    const stopWatching = watchPageErrors(page);
    await page.goto(BASE_URL + "/", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("home-all")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("home-greeting")).toContainText(/./);

    // The three blocks of CONTRACT "① Home", each with its own empty sentence.
    await expect(page.getByRole("heading", { name: "Needs you", exact: true })).toBeVisible();
    await expect(page.getByTestId("needs-you-empty")).toHaveText("Nothing is waiting on you.");
    await expect(page.getByRole("heading", { name: "Running", exact: true })).toBeVisible();
    await expect(page.getByTestId("running-list-empty")).toHaveText("Nothing is running.");
    await expect(page.getByTestId("factory-health")).toBeVisible();
    // Every count is zero, so the block says the one true sentence left to it
    // (ui/src/components/home/FactoryHealth.tsx).
    await expect(page.getByTestId("factory-health-sentence")).toHaveText("All quiet.");

    // The ask prompt is the section's own door (the floating Ask button is
    // gone, so Home must carry a place to type).
    await expect(page.getByTestId("home-prompt")).toBeVisible();
    await expect(page.getByTestId("quick-chat")).toHaveCount(0);

    // Nothing is left over from the Board-era briefing: no page shell, no
    // column grid, no count line, no callouts, no per-project skeletons.
    for (const gone of [
      "home-page",
      "home-board",
      "home-column",
      "home-count-line",
      "home-count-needyou",
      "home-callouts",
      "home-show-more",
      "running-now",
      "ask-fab",
    ]) {
      await expect(page.getByTestId(gone), `${gone} retires with the Board`).toHaveCount(0);
    }
    expect(
      await page.locator('[data-testid^="home-project-skeleton"]').count(),
      "a redesigned block never shows a column of bones",
    ).toBe(0);
    expect(
      await page.locator('[data-testid^="home-project-board-"]').count(),
      "the all-projects home draws no per-project board column",
    ).toBe(0);
    await noSidewaysScrollInShell(page);
    await checkShellScreen(page, "empty home", stopWatching);
    await evidence(
      page,
      "shell-p2-home-empty",
      "an empty all-projects home says 'Nothing is waiting on you.', 'Nothing is running.' and 'All quiet.' in its own sections, shows the ask prompt, and mounts none of the retired Board-era briefing parts",
    );
  });

  test("the gates waiting on me are the whole waiting list, in the API's order, each opening its gate", async ({
    page,
  }) => {
    await signIn(page, "admin");
    const stopWatching = watchPageErrors(page);
    // Seed past any cap the design might still impose: with four gates pending,
    // a capped preview would drop a row we can see in the API.
    const seeded = [
      await seedGate(page, "first card"),
      await seedGate(page, "second card"),
      await seedGate(page, "third card"),
    ];
    await page.goto(BASE_URL + "/", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("needs-you")).toBeVisible({ timeout: 20_000 });

    // Same rows, same order as the approvals read — the card list is the
    // briefing now, and it caps nothing.
    const pending = await apiPendingApprovals(page.request);
    const cards = page.locator('[data-testid^="needs-you-card-"]');
    await expect(cards).toHaveCount(pending.length);
    expect(
      await cards.evaluateAll((nodes) =>
        nodes.map((node) =>
          (node.getAttribute("data-testid") ?? "").replace("needs-you-card-", ""),
        ),
      ),
      "NEEDS YOU lists the pending gates in the approvals read's own order",
    ).toEqual(pending.map((row) => row.id));
    await expect(
      page.getByTestId("home-show-more"),
      "NEEDS YOU caps nothing, so there is nothing to expand",
    ).toHaveCount(0);
    await expect(
      page.getByTestId("home-callouts"),
      "the decision-callout list retires; NEEDS YOU is its replacement",
    ).toHaveCount(0);

    // A card is the gate's own title plus project · age, and links to the gate
    // page itself — no duplicate `Read plan` / `View run` pair any more.
    const mine = pending.filter((row) => seeded.includes(row.run_id ?? ""));
    expect(mine.length, "the seeded gates are listed for the reader").toBeGreaterThanOrEqual(1);
    const card = page.getByTestId(`needs-you-card-${mine[0].id}`);
    await expect(card).toHaveAttribute("href", new RegExp(`^/approvals/${mine[0].id}$`));
    await expect(card).toContainText("Shell-p2 needs-you gate for");
    const seededRun = (await apiBoardRuns(page.request)).find((row) => row.id === mine[0].run_id);
    expect(seededRun, "the gated run is on the Board read Home reads").toBeTruthy();
    await expect(card).toContainText(seededRun!.project_name ?? "run #");
    expect(
      await card.getByText(/Read plan|View run/i).count(),
      "the gate cards drop the duplicate Read plan / View run links",
    ).toBe(0);

    // The card goes to the gate itself, and the gate is decided there.
    await card.click();
    await expect(page).toHaveURL(new URL(`/approvals/${mine[0].id}`, BASE_URL).href, {
      timeout: 20_000,
    });
    // The gate is decided here: the DecisionBar (approve / request changes /
    // reject) is the page's own surface, and deciding is never one click.
    await expect(page.getByTestId("decision-bar")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("decision-approve")).toBeVisible();
    // The gate page is one of the routes the redesign kept as they are, and its
    // URL carries no scope, so the bar says the truth it can say: "All
    // projects". (PRODUCT: nothing on this page names which project the gate
    // belongs to — the card's project line is left behind at the door.)
    await expect(page.getByTestId("top-bar-context")).toHaveText("All projects");
    await checkShellScreen(page, "the gate page opened from a NEEDS YOU card", stopWatching);
    await evidence(
      page,
      "shell-p2-needs-you",
      `NEEDS YOU lists all ${pending.length} pending gates in the approvals read's order (no 3-row cap, no Show n more), a card names its gate and project and links /approvals/<id>, and the gate page opens there`,
    );
  });

  test("RUNNING lists exactly the running runs, newest first, and each row opens its workbench", async ({
    page,
  }) => {
    await signIn(page, "admin");
    const seeded = await seedRunning(page, 2);
    const stopWatching = watchPageErrors(page);
    await page.goto(BASE_URL + "/", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("running-list")).toBeVisible({ timeout: 20_000 });

    // The section lists exactly the running rows of the Board read — not the
    // queued, waiting or failed ones FACTORY HEALTH counts instead.
    const board = await apiBoardRuns(page.request);
    const running = board.filter((row) => row.status === "running");
    expect(running.length, "the lab has running work to list").toBeGreaterThanOrEqual(2);
    const expected = [...running]
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .map((row) => row.id);
    await expect
      .poll(() => runningRowIds(page), {
        message: "RUNNING lists the Board read's running rows, newest first",
        timeout: 30_000,
      })
      .toEqual(expected);
    for (const id of seeded) {
      await expect(
        page.getByTestId(`running-row-${id}`),
        `the seeded run ${id} is listed`,
      ).toBeVisible();
    }
    // A row says what a run is: its workflow, then project · step · age.
    const first = page.getByTestId(`running-row-${seeded[1]}`);
    const meta = first.locator("span").nth(1);
    const seededRow = running.find((row) => row.id === seeded[1])!;
    await expect(meta).toContainText(seededRow.project_name ?? "project");
    expect(
      await first.getByText(/Read plan|View run/i).count(),
      "the run row is one link, not a card with a link pair",
    ).toBe(0);
    // The row goes to the run's workbench.
    await first.click();
    await expect(page).toHaveURL(new URL(`/runs/${seeded[1]}`, BASE_URL).href, { timeout: 20_000 });
    await expect(page.getByTestId("workbench")).toBeVisible({ timeout: 20_000 });
    await checkShellScreen(page, "the workbench opened from a RUNNING row", stopWatching);
    await evidence(
      page,
      "shell-p2-running",
      `RUNNING lists exactly the ${running.length} running rows of GET /api/v1/runs newest-first (the two seeded probes included), a row names its run and project and links /runs/<id>, and the workbench opens there`,
    );
  });

  test("a decision started from Home is never one click: Approve holds behind a 5 s Undo and undoing posts nothing", async ({
    page,
  }) => {
    // Finding 04's ONE DecisionBar lives on the gate's own page now (the NEEDS
    // YOU card drops the duplicate Read plan / View run verbs and links
    // straight there). A verb click still holds the POST ~5 s behind an Undo
    // link, and this journey never decides a gate.
    await signIn(page, "admin");
    const runId = await seedGate(page, "undo me");
    const pending = await apiPendingApprovals(page.request);
    const gate = pending.find((row) => row.run_id === runId);
    expect(gate, "the seeded gate is pending").toBeTruthy();
    const stopWatching = watchPageErrors(page);
    await page.goto(BASE_URL + "/", { waitUntil: "domcontentloaded" });
    await page.getByTestId(`needs-you-card-${gate!.id}`).click();
    await expect(page).toHaveURL(new RegExp(`/approvals/${gate!.id}$`), { timeout: 20_000 });
    await expect(page.getByTestId("decision-bar")).toBeVisible({ timeout: 20_000 });
    // Count approval POSTs across the hold + undo journey. (An unbounded
    // `page.waitForRequest` only rejects after the whole test timeout in the
    // correct case — no POST ever happens — and hangs the journey.)
    let approvalPosts = 0;
    const onRequest = (req: import("@playwright/test").Request) => {
      if (req.url().includes("/api/v1/approvals") && req.method() === "POST") approvalPosts += 1;
    };
    page.on("request", onRequest);
    await page.getByTestId("decision-approve").click();
    await expect(page.getByTestId("decision-status")).toContainText(
      /Approved\. The run continues in \d+s\./,
    );
    await expect(page.getByTestId("decision-undo")).toBeVisible();
    await evidence(
      page,
      "shell-p2-gate-hold",
      "the gate page's Approve verb holds the decision behind a counting-down Undo window instead of POSTing on the click (finding 04's one DecisionBar, now reached from a NEEDS YOU card)",
    );
    await page.getByTestId("decision-undo").click();
    await expect(page.getByTestId("decision-approve")).toBeVisible();
    // The hold is 5 s (DecisionBar.tsx's DECISION_HOLD_SECONDS): wait past the
    // instant a not-really-cancelled hold would post, and only then read the
    // count — one second later would only prove the timer had not fired yet.
    await page.waitForTimeout(7_000);
    page.off("request", onRequest);
    expect(approvalPosts, "no approval was POSTed").toBe(0);
    const stillPending = await apiPendingApprovals(page.request);
    expect(
      stillPending.some((row) => row.id === gate!.id),
      "the gate is still pending after the undo",
    ).toBe(true);
    stopWatching();
    await evidence(
      page,
      "shell-p2-gate-undone",
      "Undo cancels the hold with zero POST /api/v1/approvals and the gate still serves as pending — the journey never decides a gate",
    );
  });

  test("at 390x844 a gate card fits and opens the gate it waits on", async ({ page }) => {
    // The old callout's phone claim, carried by NEEDS YOU: the card is a plain
    // block in the stacked column, its text wraps, and the gate it opens is
    // reachable with one tap.
    await signIn(page, "admin");
    const runId = await seedGate(page, "phone card");
    const pending = await apiPendingApprovals(page.request);
    const gate = pending.find((row) => row.run_id === runId);
    expect(gate, "the seeded gate is pending").toBeTruthy();
    const stopWatching = watchPageErrors(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(BASE_URL + "/", { waitUntil: "domcontentloaded" });
    const card = page.getByTestId(`needs-you-card-${gate!.id}`);
    await expect(card).toBeVisible({ timeout: 20_000 });
    await noSidewaysScrollInShell(page);
    const box = await card.boundingBox();
    expect(box, "the card is laid out").toBeTruthy();
    expect(box!.width, "the card stays inside the phone column").toBeLessThanOrEqual(390);
    await card.click();
    await expect(page).toHaveURL(new RegExp(`/approvals/${gate!.id}$`), { timeout: 20_000 });
    await expect(page.getByTestId("decision-bar")).toBeVisible({ timeout: 20_000 });
    await noSidewaysScrollInShell(page);
    stopWatching();
    await evidence(
      page,
      "shell-p2-needs-you-phone",
      "at 390x844 the NEEDS YOU card fits the stacked column without sideways scroll and one tap opens the gate's own page with its DecisionBar",
    );
  });

  test("FACTORY HEALTH is a section of its own and its numbers are the board's", async ({
    page,
  }) => {
    await signIn(page, "admin");
    // A live run makes the sentence say something the API can be checked
    // against; the empty lab only ever proves the fallback sentence.
    const seeded = await seedRunning(page, 1);
    const stopWatching = watchPageErrors(page);
    await page.goto(BASE_URL + "/", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("factory-health")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("factory-health")).toContainText("Factory health");

    // It is its own section — not a line hung off another block's heading.
    const nesting = await page.evaluate(() => {
      const health = document.querySelector('[data-testid="factory-health"]');
      if (!health) return "missing";
      if (health.tagName !== "SECTION") return health.tagName;
      return health.closest(
        '[data-testid="running-list"], [data-testid="needs-you"], [data-testid="since-you-left"]',
      )
        ? "nested"
        : "own";
    });
    expect(nesting, "FACTORY HEALTH is its own labelled section").toBe("own");

    // The running number in the sentence is the number of running rows Home
    // lists from the same read — the two blocks on screen can never disagree
    // about what the factory is doing.
    const board = await apiBoardRuns(page.request);
    const sentence = await page.getByTestId("factory-health-sentence").innerText();
    const runningRows = await runningRowIds(page);
    expect(runningRows.length, "the seeded probe is listed under RUNNING").toBeGreaterThanOrEqual(
      1,
    );
    const named = sentence.match(/(\d+) running/);
    expect(named, `"${sentence}" names the running count`).toBeTruthy();
    expect(Number(named![1]), `"${sentence}" agrees with the rows`).toBe(runningRows.length);
    expect(
      board.filter((row) => row.status === "running").length,
      "the rows on screen are the Board read's running rows",
    ).toBe(runningRows.length);
    expect(
      /\d+ waiting on a person, \d+ failed in the last day\.$/.test(sentence),
      `"${sentence}" is the sentence the design writes, not a paraphrase`,
    ).toBe(true);
    // And Home states numbers in exactly one place: the Board-era count line
    // that used to sit under the heading is gone for good.
    await expect(page.getByTestId("home-count-line")).toHaveCount(0);
    expect(seeded.length, "the probe run was seeded").toBe(1);
    await noSidewaysScrollInShell(page);
    await checkShellScreen(page, "home with its FACTORY HEALTH section", stopWatching);
    await evidence(
      page,
      "shell-p2-factory-health",
      `FACTORY HEALTH is its own labelled section whose sentence ("${sentence}") agrees with the RUNNING rows (${runningRows.length}) and the Board read; the retired Board count line mounts nowhere on Home`,
    );
  });
});
