// Phase 2 acceptance: the Home briefing (finding 03 retired the cross-project
// Board as a destination — `/inbox` and `/board` redirect to Today; the
// decision callouts with the shared DecisionBar and the Running now rows are
// the briefing now, and the per-repository work lives in each repository's
// Lanes view).
//
// Home's count line and its decision callouts must equal the cross-project
// reads (contract C3: GET /api/v1/runs + GET /api/v1/approvals) — no invented
// numbers. The callouts are the same list under the briefing's designed cap:
// at most three, in the API's order (ui/src/components/home/DecisionCallout.tsx
// CALLOUT_PREVIEW); while more gates are pending a `Show n more` button
// (testid `home-show-more`) expands the panel IN PLACE to EVERY pending gate,
// still in the API's order — nothing on Today links to the Inbox any more. The
// spec seeds scratch gates through the API when the lab holds ≤ 3 pending so
// the cap path is proven whether 1 or 12 gates were pending at entry.
// The old board's per-status kanban columns and repo/workflow groupings were
// retired with the page and have no carrier any more; what the board cards
// carried that still exists — a run card opens its run page, and deciding a
// gate is never a one-click commit (finding 04: the DecisionBar holds the
// POST behind a 5 s Undo window) — is proven here on Today.
//
// Runs ONLY when COMMUNICATION_E2E_SHELL=1. checkShellScreen on every page;
// evidence() per step.
import { expect, test, type APIRequestContext } from "@playwright/test";
import { BASE_URL } from "./env.js";
import { signIn, testidOf } from "./helpers.js";
import {
  SHELL_ENABLED,
  SHELL_GATE,
  apiBoardRuns,
  apiCsrf,
  apiPendingApprovals,
  apiPublishPipeline,
  apiRuns,
  apiScratchProject,
  apiStartRun,
  boardColumnCounts,
  checkShellScreen,
  evidence,
  signInNarrow,
  watchPageErrors,
} from "./shell-helpers.js";

/** How many callouts the briefing previews before offering the rest
 * (ui/src/components/home/DecisionCallout.tsx: `CALLOUT_PREVIEW`) — the first
 * gates of GET /approvals?status=pending get a callout; the rest appear only
 * after the `Show n more` expansion, in place. */
const CALLOUT_MAX = 3;

/**
 * The scratch gate (the m5-journey GATE_TWIN / shell-p789 GATE_YAML pattern):
 * a `human.approval` ROOT node, so the run enters `waiting_human` the moment
 * it exists — no worker turn — and its gate stays pending. The 24 h deadline
 * keeps the seeded gates pending across the three verification runs; the
 * journey never decides them.
 */
const GATE_YAML = (slug: string): string => `# home-cap scratch gate: one maintainer approval at the root.
apiVersion: communication.dev/v1alpha1
kind: Pipeline
metadata:
  name: ${slug}
  description: >-
    Home-cap scratch gate for acceptance: a pending gate the journey never decides.
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
        Home cap acceptance gate for \${{ inputs.goal }} — pending, never decided.
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
      - '{"after":"ran off the home-cap gate"}'
      outputExtraction: {mode: json_from_stdout}
    outputs:
      type: object
      required: [after]
      properties:
        after: {type: string}
  resultBindings:
    after: \${{ nodes.after_gate.outputs.after }}
`;

/** Grow the lab's pending list past the cap (≥ CALLOUT_MAX + 1 gates) so the
 * briefing always renders the capped path. Gates already beyond the cap are
 * used as they are; nothing is decided or deleted. */
async function ensureMoreGatesThanCap(request: APIRequestContext): Promise<void> {
  const before = await apiPendingApprovals(request);
  if (before.length > CALLOUT_MAX) return;
  const csrf = await apiCsrf(request);
  const project = await apiScratchProject(request);
  const slug = `home-cap-${Date.now()}`;
  const { revisionId } = await apiPublishPipeline(request, csrf, slug, GATE_YAML(slug));
  for (let i = before.length + 1; i <= CALLOUT_MAX + 1; i += 1) {
    await apiStartRun(request, csrf, project.id, revisionId, {
      goal: `Home cap acceptance gate ${i}`,
    });
  }
  await expect
    .poll(async () => (await apiPendingApprovals(request)).length, {
      message: "the scratch gates must reach the cross-project pending list",
      timeout: 60_000,
    })
    .toBeGreaterThan(CALLOUT_MAX);
}

/** The Running-now card ROOT only — `home-run-step-`/`home-run-progress-`
    share the `home-run-` prefix, so a bare `[data-testid^="home-run-"]`
    counts children too. */
const RUN_CARD_ROOT =
  '[data-testid^="home-run-"]' +
  ':not([data-testid^="home-run-step-"])' +
  ':not([data-testid^="home-run-progress-"])';

test.describe("shell p2 — Home briefing (counts, callouts, run cards, decisions)", () => {
  test.skip(!SHELL_ENABLED, SHELL_GATE);
  test.use({ viewport: { width: 1500, height: 950 } });
  test.setTimeout(10 * 60_000);

  test("Home: count line, callouts for the first three pending approvals, the rest expanded in place by Show n more", async ({
    page,
  }) => {
    await signIn(page, "admin");
    const stopWatching = watchPageErrors(page);
    // Prove the cap path on any lab: with ≤ 3 pending the cap could hide a
    // missing row, so seed scratch gates past it first (the m5-gate pattern —
    // a root human.approval parks the run the moment it exists).
    await ensureMoreGatesThanCap(page.request);
    await page.goto(BASE_URL + "/", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("home-count-line")).toBeVisible({ timeout: 20_000 });
    // The briefing reuses the BOARD's read (ui/src/api/home.ts — “the run list
    // itself reuses the board's useBoardRuns”), so compare against that one
    // page, not a paginated walk of every run. The count line has no DONE
    // TODAY segment, so no clock is needed here.
    const runs = await apiBoardRuns(page.request);
    const counts = boardColumnCounts(runs, new Date());

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

    // The briefing renders the SAME list the API returns, under the designed
    // cap: a callout for each of the first CALLOUT_MAX gates in the API's
    // order, none for the rest, and a `Show n more` button naming their count.
    // Polled so the page's own SSE-driven refetch (≤1 s coalescing) settles
    // against the API read it is being compared to; exact once settled —
    // every id, in order, plus the absence of every overflow id.
    const calloutProblems = async (): Promise<string[]> => {
      const list = await apiPendingApprovals(page.request);
      const problems: string[] = [];
      if (list.length === 0) return ["the API returned no pending approvals"];
      const shown = list.slice(0, CALLOUT_MAX);
      const rest = list.slice(CALLOUT_MAX);
      for (const approval of shown) {
        if (!(await page.getByTestId(`home-callout-${testidOf(approval.id)}`).isVisible())) {
          problems.push(`callout for ${approval.id.slice(0, 8)}… is not visible`);
        }
      }
      for (const approval of rest) {
        const hidden = page.getByTestId(`home-callout-${testidOf(approval.id)}`);
        if ((await hidden.count()) > 0) {
          problems.push(`overflow gate ${approval.id.slice(0, 8)}… still renders a callout`);
        }
      }
      // DOM order equals the API order for the rendered callouts.
      const rendered = await page
        .locator('[data-testid="home-callouts"] > div[data-testid^="home-callout-"]')
        .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-testid") ?? ""));
      const want = shown.map((approval) => `home-callout-${testidOf(approval.id)}`);
      if (JSON.stringify(rendered) !== JSON.stringify(want)) {
        problems.push(`callout rows are [${rendered.join(", ")}], want [${want.join(", ")}]`);
      }
      // The overflow button names the rest — present exactly when there is a
      // rest, with the exact `Show n more` text.
      const more = page.getByTestId("home-show-more");
      if (rest.length > 0) {
        if (!(await more.isVisible())) {
          problems.push("the 'Show n more' button is missing while gates overflow");
        } else {
          const text = (await more.innerText()).trim();
          const wantText = `Show ${rest.length} more`;
          if (text !== wantText) {
            problems.push(`overflow button says "${text}", want "${wantText}"`);
          }
        }
      } else if ((await more.count()) > 0) {
        problems.push(
          "the 'Show n more' button rendered although every pending gate has a callout",
        );
      }
      return problems;
    };
    await expect
      .poll(calloutProblems, {
        message:
          "home renders the first three gates of GET /api/v1/approvals?status=pending as callouts and offers the rest behind a Show n more button",
        timeout: 30_000,
      })
      .toEqual([]);

    // Clicking the button expands the panel IN PLACE: every pending gate now
    // renders a callout, still in the API's order (so the DOM-equals-API check
    // below covers both presence and order), and the button is gone.
    const showMore = page.getByTestId("home-show-more");
    if ((await showMore.count()) > 0) {
      await showMore.click();
    }
    const expandedProblems = async (): Promise<string[]> => {
      const list = await apiPendingApprovals(page.request);
      const problems: string[] = [];
      const rendered = await page
        .locator('[data-testid="home-callouts"] > div[data-testid^="home-callout-"]')
        .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-testid") ?? ""));
      const want = list.map((approval) => `home-callout-${testidOf(approval.id)}`);
      if (JSON.stringify(rendered) !== JSON.stringify(want)) {
        problems.push(`expanded callout rows are [${rendered.join(", ")}], want [${want.join(", ")}]`);
      }
      if ((await page.getByTestId("home-show-more").count()) > 0) {
        problems.push("the 'Show n more' button is still offered after expanding");
      }
      return problems;
    };
    await expect
      .poll(expandedProblems, {
        message:
          "after clicking Show n more, home renders EVERY pending approval of GET /api/v1/approvals?status=pending as a callout, in API order",
        timeout: 30_000,
      })
      .toEqual([]);
    const finalList = await apiPendingApprovals(page.request);
    stopWatching();
    await evidence(
      page,
      "shell-p2-home-callouts",
      `home renders a callout for the first ${Math.min(CALLOUT_MAX, finalList.length)} of the ${finalList.length} pending approvals from GET /api/v1/approvals?status=pending (the briefing's preview cap of ${CALLOUT_MAX}); the other ${Math.max(finalList.length - CALLOUT_MAX, 0)} appear only after clicking 'Show n more', which expands the panel in place to every pending gate in API order`,
    );
  });

  test("Today: every Running now card links its run page, equal to the board read's active set", async ({
    page,
  }) => {
    // The retired board's cards carried this claim; Today's Running now is the
    // briefing's carrier: ui/src/pages/Home.tsx mounts the SAME board read
    // (`useBoardRuns({})`) and lists every row whose status is not
    // `completed`, capped at the panel's 8 rows — no DONE TODAY clock any
    // more, so no pinned clock is needed here either.
    await signIn(page, "admin");
    const stopWatching = watchPageErrors(page);
    await page.goto(BASE_URL + "/", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("home-page")).toBeVisible({ timeout: 30_000 });
    const runs = await apiBoardRuns(page.request);
    const active = runs.filter((run) => run.status !== "completed").slice(0, 8);
    expect(active.length, "the lab has at least one active run").toBeGreaterThan(0);
    for (const run of active) {
      const card = page.getByTestId(`home-run-${testidOf(run.id)}`);
      await expect(card, `Running now card for run ${run.id.slice(0, 8)}…`).toBeVisible({
        timeout: 30_000,
      });
      expect(
        await card.getAttribute("href"),
        `the card for run ${run.id.slice(0, 8)}… links its own run page`,
      ).toBe(`/runs/${run.id}`);
    }
    // No invented rows and none missing: the panel shows exactly the active
    // page slice it was handed.
    await expect(page.locator(RUN_CARD_ROOT)).toHaveCount(active.length);
    // A card click opens the run — the board drawer's `?run=` was retired with
    // the page; the run page itself is the destination now.
    await page.getByTestId(`home-run-${testidOf(active[0].id)}`).click();
    await expect(page).toHaveURL(new RegExp(`/runs/${active[0].id}$`), { timeout: 30_000 });
    await checkShellScreen(page, "run page from a Running now card", stopWatching);
    await evidence(
      page,
      "shell-p2-running-now-cards",
      `Today's Running now shows exactly the first ${active.length} of the ${runs.length} rows of the board read that are not completed, every card links /runs/<id> and the click landed there (the retired board's card→run claim)`,
    );
  });

  test("a decision on Today is never one-click: Approve holds behind a 5 s Undo, and undoing posts nothing", async ({
    page,
  }) => {
    // Finding 04 replaced the drawer's confirm step with the ONE DecisionBar:
    // a verb click holds the POST ~5 s behind an Undo link, which is the same
    // safety the old confirm step bought — the journey still never decides a
    // gate.
    await signIn(page, "admin");
    const runs = await apiRuns(page.request);
    const waiting = runs.find((r) => r.status === "waiting_human");
    expect(waiting, "a waiting run exists in the lab").toBeTruthy();
    const approvals = await apiPendingApprovals(page.request);
    const gate = approvals.find((a) => a.run_id === waiting!.id);
    expect(gate, "the waiting run has a pending gate").toBeTruthy();
    const stopWatching = watchPageErrors(page);
    await page.goto(BASE_URL + "/", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("home-callouts")).toBeVisible({ timeout: 30_000 });
    const callout = page.getByTestId(`home-callout-${testidOf(gate!.id)}`);
    // The preview cap can hide the gate's own callout: `Show n more` then
    // expands the panel in place (the assertion above proved the cap path).
    if ((await callout.count()) === 0) {
      await page.getByTestId("home-show-more").click();
    }
    await expect(callout).toBeVisible({ timeout: 30_000 });
    // Count approval POSTs across the hold + undo journey. (An unbounded
    // `page.waitForRequest` only rejects after the whole test timeout in the
    // correct case — no POST ever happens — and hangs the journey.)
    let approvalPosts = 0;
    const onRequest = (req: import("@playwright/test").Request) => {
      if (req.url().includes("/api/v1/approvals") && req.method() === "POST") approvalPosts += 1;
    };
    page.on("request", onRequest);
    await callout.getByTestId("decision-approve").click();
    await expect(callout.getByTestId("decision-status")).toContainText(
      /Approved\. The run continues in \d+s\./,
    );
    await expect(callout.getByTestId("decision-undo")).toBeVisible();
    await evidence(
      page,
      "shell-p2-home-approve-hold",
      "the callout's Approve verb holds the decision behind a counting-down Undo window instead of POSTing on the click (finding 04's replacement for the confirm step)",
    );
    await callout.getByTestId("decision-undo").click();
    await expect(callout.getByTestId("decision-approve")).toBeVisible();
    // A short settle window: a decided gate would POST in the hold's own tick.
    await page.waitForTimeout(1_000);
    page.off("request", onRequest);
    expect(approvalPosts, "no approval was POSTed").toBe(0);
    const stillPending = await apiPendingApprovals(page.request);
    expect(
      stillPending.some((a) => a.id === gate!.id),
      "the gate is still pending after the undo",
    ).toBe(true);
    stopWatching();
    await evidence(
      page,
      "shell-p2-home-approve-undone",
      "Undo cancels the hold with zero POST /api/v1/approvals and the gate still serves as pending — the journey never decides a gate",
    );
  });

  test.describe("narrow 390x844", () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test("phone: a decision callout fits 390px and its Approve can be undone", async ({ page }) => {
      await signInNarrow(page, "admin");
      const runs = await apiRuns(page.request);
      const waiting = runs.find((r) => r.status === "waiting_human");
      expect(waiting, "a waiting run exists in the lab").toBeTruthy();
      const approvals = await apiPendingApprovals(page.request);
      const gate = approvals.find((a) => a.run_id === waiting!.id);
      expect(gate, "the waiting run has a pending gate").toBeTruthy();
      const stopWatching = watchPageErrors(page);
      await page.goto(BASE_URL + "/", { waitUntil: "domcontentloaded" });
      await page.keyboard.press("Escape"); // close the drawer signInNarrow left open
      await expect(page.getByTestId("home-callouts")).toBeVisible({ timeout: 30_000 });
      const callout = page.getByTestId(`home-callout-${testidOf(gate!.id)}`);
      if ((await callout.count()) === 0) {
        await page.getByTestId("home-show-more").click();
      }
      await expect(callout).toBeVisible({ timeout: 30_000 });
      // The drawer's "fits the viewport" claim, carried by the callout that
      // replaced it: on screen at 390px, no sideways scroll.
      const box = await callout.boundingBox();
      expect(box, "the decision callout is on screen at 390px").not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.width).toBeLessThanOrEqual(390);
      await callout.getByTestId("decision-approve").click();
      await expect(callout.getByTestId("decision-status")).toContainText(
        /Approved\. The run continues in \d+s\./,
      );
      await callout.getByTestId("decision-undo").click();
      await expect(callout.getByTestId("decision-approve")).toBeVisible();
      await checkShellScreen(page, "today with the callout at phone width", stopWatching);
      await evidence(
        page,
        "shell-p2-phone-callout-undo",
        "at 390x844 the run's decision callout fits the viewport, its Approve holds behind the Undo window and the journey undoes it — the page never scrolls sideways",
      );
    });
  });
});
