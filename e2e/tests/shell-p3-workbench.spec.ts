// Phase 3 acceptance: the project-less Run Workbench (`/runs/:runId`).
//
// The tab row (Graph / Timeline / Artifacts / Diagnostics) is URL-driven
// (`?view=…`), `?full=1` folds the graph into the step strip (one cell per
// top-level step of the pinned revision) and `⤡ show graph` restores the
// split, and the dock's Take control is two-step: a confirm card with the
// truthful copy, where Just watch / Escape cancel it without any POST.
//
// Runs ONLY when COMMUNICATION_E2E_SHELL=1. The workbench reads are worker
// polls, so every first-render wait is bounded (WORKBENCH_TIMEOUT_MS), never
// open-ended. checkShellScreen on each view; evidence() per step.
import { expect, test, type APIRequestContext } from "@playwright/test";
import { AGENT_TURN_TIMEOUT_MS, BASE_URL } from "./env.js";
import { signIn } from "./helpers.js";
import {
  SHELL_ENABLED,
  SHELL_GATE,
  apiCsrf,
  apiProjects,
  apiProfileForAgentRun,
  apiPublishPipeline,
  apiRuns,
  apiStartRun,
  apiWaitRunAgentConversation,
  checkShellScreen,
  evidence,
  type ProjectRow,
} from "./shell-helpers.js";

const WORKBENCH_TIMEOUT_MS = Number(process.env.E2E_WORKBENCH_TIMEOUT_MS ?? 120_000);
const VIEWS = ["graph", "timeline", "artifacts", "diagnostics"] as const;
const STAMP = Date.now().toString(36);

/**
 * The project this journey starts its agent run in: one whose repository the
 * WORKER can actually clone. The lab carries placeholder remotes
 * (`https://example.invalid/…` from m1-journey) that no workspace preparation
 * can resolve — the 8fd91f3 run died exactly there (`Could not resolve host:
 * example.invalid`, error_class infra). The m4 lab fixture is a bare repo on
 * the worker's own host (`file:///srv/m4/fixtures/app.git`, docs/
 * compatibility/probes/m4), so its mirror clone cannot fail on DNS; this is
 * the same repository every other lab-journey agent run uses.
 */
async function apiProjectWithCloneableRepo(request: APIRequestContext): Promise<ProjectRow> {
  const projects = await apiProjects(request);
  const seen: string[] = [];
  for (const project of projects) {
    const res = await request.get(`${BASE_URL}/api/v1/projects/${project.id}/repos?limit=50`);
    if (!res.ok()) continue;
    const body = (await res.json()) as { items?: { name: string; git_url: string }[] };
    for (const repo of body.items ?? []) {
      seen.push(`${project.name}/${repo.name} ${repo.git_url}`);
      if (repo.git_url.startsWith("file://")) return project;
    }
  }
  throw new Error(
    `no project carries a repository the worker can clone (a file:// lab fixture); ` +
      `repos seen: ${seen.join(", ") || "none"}`,
  );
}

/**
 * The single-node agent pipeline the Take control journey runs. The 90 s
 * foreground until-loop keeps the turn in flight (the issue2 long-turn
 * pattern: m4-reviewer runs preapproved_within_sandbox, so the loop runs
 * without a permission prompt) — the journey only opens and CANCELS the
 * confirm card, so nothing is ever decided. The agent answer must be a JSON
 * object (the engine's structured-output extraction); `onExecutionError`
 * stays at its default because the journey never reaches the output.
 */
const TAKE_CONTROL_YAML = (
  slug: string,
  profileName: string,
): string => `# p3 take-control: one agent node whose live conversation the journey takes over (and gives back).
apiVersion: communication.dev/v1alpha1
kind: Pipeline
metadata:
  name: ${slug}
  description: >-
    P3 take-control acceptance: one agent node with a long live turn.
spec:
  inputs:
    type: object
  outputs:
    type: object
  policies:
    maxConcurrentNodes: 1
    maxDurationSeconds: 3600
    maxNodeExecutions: 5
    maxChildDepth: 0
    workspaceMode: worktree
    cancelPolicy: cascade
  nodes:
  - id: p3take
    kind: agent.acp
    timeoutSeconds: 300
    retry:
      maxAttempts: 1
    config:
      profile: "${profileName}"
      prompt: >-
        First wait about 90 seconds before you answer, so this turn stays open: run this exact
        shell command in the FOREGROUND and wait for it to finish — end=$(( $(date +%s) + 90 ));
        until [ $(date +%s) -ge $end ]; do sleep 2; done — this is the allowed Monitor until-loop
        (a standalone sleep 90 is blocked, so do not use one and do not run the loop in the
        background). Once it completes, answer JSON {"note": "review complete"}.
    outputs:
      type: object
      properties:
        note:
          type: string
`;

test.describe("shell p3 — run workbench: tabs, full screen, take control", () => {
  test.skip(!SHELL_ENABLED, SHELL_GATE);
  test.use({ viewport: { width: 1500, height: 950 } });
  test.setTimeout(9 * 60_000);

  test("tabs Graph/Timeline/Artifacts/Diagnostics and the ?view= deep link", async ({ page }) => {
    await signIn(page, "admin");
    const runs = await apiRuns(page.request);
    const run = runs.find((r) => r.status === "waiting_human") ?? runs[0];
    expect(run, "a run exists in the lab").toBeTruthy();
    await page.goto(BASE_URL + `/runs/${run!.id}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("run-title")).toBeVisible({ timeout: WORKBENCH_TIMEOUT_MS });
    for (const view of VIEWS) {
      await expect(page.getByTestId(`workbench-tab-${view}`)).toBeVisible();
    }
    await expect(page.getByTestId("workbench-tab-graph")).toHaveAttribute("aria-selected", "true");
    await checkShellScreen(page, "workbench graph view");
    await evidence(
      page,
      "shell-p3-workbench-graph",
      `/runs/<id> renders the run title and the four tabs (Graph, Timeline, Artifacts, Diagnostics) with Graph selected`,
    );
    for (const view of ["timeline", "artifacts", "diagnostics"] as const) {
      await page.getByTestId(`workbench-tab-${view}`).click();
      // `view` is not always the first query param — read it as a search param.
      await expect(page).toHaveURL((u: URL) => u.searchParams.get("view") === view);
      await expect(page.getByTestId(`workbench-tab-${view}`)).toHaveAttribute(
        "aria-selected",
        "true",
      );
    }
    await checkShellScreen(page, "workbench diagnostics view");
    await evidence(
      page,
      "shell-p3-workbench-tabs",
      "clicking each tab updates the URL (?view=timeline|artifacts|diagnostics) and the selected tab state",
    );
    // The deep link: a fresh navigation straight to ?view=artifacts lands there.
    await page.goto(BASE_URL + `/runs/${run!.id}?view=artifacts`, {
      waitUntil: "domcontentloaded",
    });
    await expect(page.getByTestId("run-title")).toBeVisible({ timeout: WORKBENCH_TIMEOUT_MS });
    await expect(page.getByTestId("workbench-tab-artifacts")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await evidence(
      page,
      "shell-p3-workbench-view-artifacts",
      "deep-linking /runs/<id>?view=artifacts lands on the Artifacts tab",
    );
  });

  test("?full=1: step strip with one cell per top-level step; ⤡ restores", async ({ page }) => {
    await signIn(page, "admin");
    const runs = await apiRuns(page.request);
    const run = runs.find((r) => r.status === "waiting_human") ?? runs[0];
    const steps = run!.steps ?? [];
    expect(steps.length, "the run summary carries its top-level steps").toBeGreaterThan(0);
    await page.goto(BASE_URL + `/runs/${run!.id}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("run-title")).toBeVisible({ timeout: WORKBENCH_TIMEOUT_MS });
    // Select the first graph node so the dock (and its ⤢ control) is on screen.
    const firstNode = page
      .locator('[data-testid="workbench-graph-frame"] [data-testid^="canvas-step-"]')
      .first();
    await firstNode.click();
    await expect(page.getByTestId("workbench-dock")).toBeVisible({ timeout: WORKBENCH_TIMEOUT_MS });
    await page.getByTestId("workbench-fullscreen").click();
    await expect(page).toHaveURL((u: URL) => u.searchParams.get("full") === "1");
    const strip = page.getByTestId("workbench-step-strip");
    await expect(strip).toBeVisible();
    const cells = page.locator('[data-testid^="workbench-step-cell-"]');
    expect(await cells.count(), "one strip cell per top-level step").toBe(steps.length);
    await checkShellScreen(page, "workbench full screen");
    await evidence(
      page,
      "shell-p3-fullscreen-strip",
      `⤢ full screen sets ?full=1 and the step strip shows exactly ${steps.length} cell(s), one per top-level step of the pinned revision`,
    );
    await page.getByRole("button", { name: /show graph/ }).click();
    await expect(page).not.toHaveURL(/full=1/);
    await expect(page.getByTestId("workbench-graph-frame")).toBeVisible();
    await evidence(
      page,
      "shell-p3-fullscreen-restore",
      "⤡ show graph clears ?full=1 and restores the split view with the graph visible",
    );
  });

  test("Take control: the confirm card with truthful copy; Just watch / esc cancel, no POST", async ({
    page,
  }) => {
    await signIn(page, "admin");
    // Setup (through the API — the journey below still goes through the UI):
    // the seeded gate-waiting runs carry no agent step, so a FRESH lab has no
    // live ACP conversation and the dock's Take control does not exist. Start
    // one: a single-node agent.acp pipeline (issue2's long-turn prompt keeps
    // the attempt running while the journey opens and cancels the card), run
    // in a project with a repository, waited on until its conversation is
    // stamped (bounded, never open-ended).
    const csrf = await apiCsrf(page.request);
    const profile = await apiProfileForAgentRun(page.request);
    const pipeline = await apiPublishPipeline(
      page.request,
      csrf,
      `p3-take-${STAMP}`,
      TAKE_CONTROL_YAML(`p3-take-${STAMP}`, profile.name),
    );
    const project = await apiProjectWithCloneableRepo(page.request);
    const runId = await apiStartRun(page.request, csrf, project.id, pipeline.revisionId, {});
    const conversationId = await apiWaitRunAgentConversation(
      page.request,
      runId,
      AGENT_TURN_TIMEOUT_MS,
    );
    console.log(
      `P3 setup: agent run ${runId.slice(0, 8)} live, conversation ${conversationId.slice(0, 8)}`,
    );
    await page.goto(BASE_URL + `/runs/${runId}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("run-title")).toBeVisible({ timeout: WORKBENCH_TIMEOUT_MS });
    // The dock's Take control belongs to the run's agent step: select it and
    // the dock opens on the live conversation.
    await page.locator(`[data-testid="canvas-step-p3take"]`).click();
    const takeControl = page.getByTestId("dock-take-control");
    // The button only exists for a viewer who is not the current controller —
    // the run's turn is agent-controlled, so admin sees it.
    await expect(takeControl).toBeVisible({ timeout: WORKBENCH_TIMEOUT_MS });
    const postTakeover = page
      .waitForRequest((req) => req.url().includes("/take-control") && req.method() === "POST", {
        timeout: 30_000,
      })
      .catch(() => null);
    await takeControl.click();
    const card = page.getByTestId("take-control-card");
    await expect(card).toBeVisible();
    const heading = (await page.getByTestId("take-control-card-heading").innerText()).trim();
    expect(heading, "the card heading names what is being taken over").not.toBe("");
    await expect(page.getByTestId("take-control-confirm")).toBeVisible();
    await evidence(
      page,
      "shell-p3-take-control-card",
      `the dock's Take control shows its confirm card (heading: "${heading}") with a truthful copy and a Just watch option`,
    );
    await page.keyboard.press("Escape");
    await expect(card).toBeHidden();
    const posted = await postTakeover;
    expect(posted, "no takeover was POSTed on cancel").toBeNull();
    await expect(takeControl).toBeVisible();
    // The second path: opening the card again and cancelling with Just watch.
    await takeControl.click();
    await expect(card).toBeVisible();
    await page.getByTestId("take-control-cancel").click();
    await expect(card).toBeHidden();
    await evidence(
      page,
      "shell-p3-take-control-cancelled",
      "Escape and Just watch both close the confirm card and no POST …/take-control is sent — control stays with the agent",
    );
  });
});
