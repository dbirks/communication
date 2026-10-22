// The round's E2E gaps — one acceptance spec per feature the working tree
// landed this round: Workflow Triggers, the Repository page, Usage and
// Thread artifacts. The design handoff's acceptance.md still marked these
// NOT COVERED; the round's features closed the gaps, and this spec proves
// each one against the lab.
//
// Runs ONLY when COMMUNICATION_E2E_SHELL=1. checkShellScreen on every page;
// evidence() per step; zero page errors. Scratch schedules / threads / steps
// are created through the API where the journey needs them and are left clean.

import { expect, test, type APIRequestContext } from "@playwright/test";

import { BASE_URL } from "./env.js";
import { openProjectBySlug, signIn } from "./helpers.js";
import {
  SHELL_ENABLED,
  SHELL_GATE,
  apiConversations,
  apiCreateConversation,
  apiCsrf,
  apiPipelines,
  apiProfileForAgentRun,
  apiProjects,
  apiProfileId,
  checkShellScreen,
  evidence,
  noSidewaysScroll,
  watchPageErrors,
} from "./shell-helpers.js";

const STAMP = Date.now().toString(36);

/** One schedule row of GET /api/v1/projects/{projectId}/schedules. */
interface ScheduleRow {
  id: string;
  project_id: string;
  cron_expr: string;
  enabled: boolean;
}

/** GET /api/v1/projects/{projectId}/schedules — the list the Triggers
 * section groups by project assignment. */
async function apiSchedules(request: APIRequestContext, projectId: string): Promise<ScheduleRow[]> {
  const res = await request.get(`${BASE_URL}/api/v1/projects/${projectId}/schedules`);
  expect(res.status(), `GET /api/v1/projects/${projectId}/schedules -> ${res.status()}`).toBe(200);
  const body = (await res.json()) as { schedules?: ScheduleRow[] };
  return body.schedules ?? [];
}

/** The session's CSRF token + one JSON POST through the API the UI uses. */
async function apiPost(
  request: APIRequestContext,
  csrf: { token: string; origin: string },
  path: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const res = await request.post(BASE_URL + path, {
    data: body,
    headers: { Origin: csrf.origin, "X-CSRF-Token": csrf.token },
  });
  expect(res.ok(), `POST ${path} -> ${res.status()}`).toBe(true);
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

test.describe("shell p10 gaps — workflow triggers, repository page, usage, thread artifacts", () => {
  test.skip(!SHELL_ENABLED, SHELL_GATE);
  test.use({ viewport: { width: 1500, height: 950 } });

  test("workflow triggers: add a weekdays 09:00 UTC schedule, pause it, clean up", async ({
    page,
  }) => {
    test.setTimeout(10 * 60_000);
    await signIn(page, "admin");
    const stopWatching = watchPageErrors(page);
    const request = page.request;
    const pipelines = await apiPipelines(request);
    const pipeline = pipelines.find((row) => row.slug === "feature-development");
    if (!pipeline)
      throw new Error("the seeded feature-development pipeline must be in the library");

    await page.goto(BASE_URL + `/workflows/${pipeline.id}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("pipeline-page")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("workflow-triggers")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("trigger-add-schedule")).toBeVisible({ timeout: 30_000 });

    await page.getByTestId("trigger-add-schedule").click();
    const dialog = page.getByTestId("trigger-add-schedule-dialog");
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    const goal = page.getByTestId("new-run-input-goal");
    await expect(goal).toBeVisible({ timeout: 30_000 });
    await goal.fill(`P10 weekdays schedule ${STAMP}`);
    const repoSelect = page.getByTestId("new-run-input-repository");
    await expect(repoSelect).toBeVisible();
    const optionValues = await repoSelect
      .locator("option")
      .evaluateAll((els: HTMLOptionElement[]) => els.map((e) => e.value));
    const repoValue = optionValues.find((value) => value && value !== "");
    expect(repoValue, "the dialog's run-input repository offers a repository").toBeTruthy();
    await repoSelect.selectOption(repoValue ?? "");
    const confirm = page.getByTestId("trigger-add-confirm");
    await expect(confirm).toBeEnabled({ timeout: 30_000 });
    await page.getByRole("button", { name: "weekdays 09:00 UTC", exact: true }).click();
    await expect(page.getByTestId("trigger-add-cron")).toHaveValue("0 9 * * 1-5");
    await confirm.click();
    const post = page.waitForResponse(
      (response) =>
        response.url().includes("/api/v1/projects/") &&
        response.url().includes("/schedules") &&
        response.request().method() === "POST",
      { timeout: 30_000 },
    );
    const postResponse = await post;
    expect(
      postResponse.status(),
      `POST /api/v1/projects/{id}/schedules -> ${postResponse.status()}`,
    ).toBeLessThan(300);
    const created = (await postResponse.json()) as {
      id: string;
      project_id: string;
      cron_expr?: string;
      enabled?: boolean;
    };
    const scheduleId = created.id;
    const projectId = created.project_id;
    await expect(dialog).toBeHidden({ timeout: 30_000 });

    const row = page.getByTestId(`trigger-row-${scheduleId}`);
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId(`trigger-cron-${scheduleId}`)).toHaveText("0 9 * * 1-5");
    await expect(page.getByTestId(`trigger-cron-words-${scheduleId}`)).toContainText(
      "every weekday at 09:00 UTC",
    );

    const schedules = await apiSchedules(request, projectId);
    const createdRow = schedules.find((schedule) => schedule.id === scheduleId);
    expect(
      createdRow,
      "the created schedule is served by GET /projects/{id}/schedules",
    ).toBeTruthy();
    expect(createdRow?.cron_expr).toBe("0 9 * * 1-5");
    expect(createdRow?.enabled).toBe(true);

    const enabledBox = page.getByTestId(`trigger-enabled-${scheduleId}`);
    await expect(enabledBox).toBeChecked();
    await enabledBox.click();
    await expect(page.getByTestId(`trigger-state-${scheduleId}`)).toHaveText("paused", {
      timeout: 30_000,
    });
    const pausedRow = (await apiSchedules(request, projectId)).find(
      (schedule) => schedule.id === scheduleId,
    );
    expect(pausedRow?.enabled).toBe(false);

    await checkShellScreen(page, "workflow triggers", stopWatching);
    await evidence(
      page,
      "shell-p10-gaps-triggers-add",
      `the ${pipeline.slug} page's Triggers section added a "weekdays 09:00 UTC" schedule: the row shows the cron "0 9 * * 1-5" and the plain-English reading "every weekday at 09:00 UTC", and GET /api/v1/projects/{id}/schedules echoes the same cron`,
    );

    // Clean up: ADR-0032 exposes no DELETE — the off-switch for a scratch
    // schedule is the enabled flag, so the journey disables what it added.
    const cleanupBox = page.getByTestId(`trigger-enabled-${scheduleId}`);
    if (await cleanupBox.isChecked().catch(() => false)) await cleanupBox.click();
    await expect(page.getByTestId(`trigger-state-${scheduleId}`)).toHaveText("paused");
    const endRow = (await apiSchedules(request, projectId)).find(
      (schedule) => schedule.id === scheduleId,
    );
    expect(endRow?.enabled).toBe(false);

    await evidence(
      page,
      "shell-p10-gaps-triggers-pause",
      `toggling the schedule's pause flipped the server's enabled flag to false (GET /api/v1/projects/{id}/schedules: enabled=false, state "paused") and the scratch schedule was cleaned up disabled`,
    );
  });

  test("repository page: /p/<id>/<repo> sections render, unknown repo not-found, fits at 390px", async ({
    page,
  }) => {
    test.setTimeout(10 * 60_000);
    await signIn(page, "admin");
    const stopWatching = watchPageErrors(page);
    const projectPath = await openProjectBySlug(page, "m4-exit");
    const projectId = projectPath.split("/").pop() ?? "";
    expect(projectId, "the opened project answers with its uuid").toMatch(/^[0-9a-f-]{36}$/);
    const reposRes = await page.request.get(`${BASE_URL}/api/v1/projects/${projectId}/repos`);
    expect(
      reposRes.status(),
      `GET /api/v1/projects/${projectId}/repos -> ${reposRes.status()}`,
    ).toBe(200);
    const reposBody = (await reposRes.json()) as { items?: { name: string }[] };
    const repoName = reposBody.items?.[0]?.name ?? "";
    expect(repoName, "the lab project holds a repository").toBeTruthy();

    const repoLink = page.getByTestId(`repo-row-${repoName}`);
    await expect(repoLink).toBeVisible({ timeout: 30_000 });
    await repoLink.click();
    await expect(page).toHaveURL(new RegExp(`/p/${projectId}/${repoName}$`));
    await expect(page.getByTestId("repo-page")).toBeVisible({ timeout: 30_000 });
    for (const testid of ["repo-header", "repo-workspaces", "repo-issues", "repo-runs"]) {
      await expect(page.getByTestId(testid)).toBeVisible({ timeout: 30_000 });
    }
    await checkShellScreen(page, "repository page", stopWatching);
    await evidence(
      page,
      "shell-p10-gaps-repository",
      `from the project page the repo link "${repoName}" opened /p/${projectId}/${repoName} and the repository page renders its header, STATUS, ISSUES and RECENT RUNS sections`,
    );

    await page.goto(`${BASE_URL}/p/${projectId}/nope`, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("repo-not-found")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("repo-page")).toBeVisible({ timeout: 30_000 });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${BASE_URL}/p/${projectId}/${repoName}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("repo-page")).toBeVisible({ timeout: 30_000 });
    await noSidewaysScroll(page);
    await checkShellScreen(page, "repository page at phone width", stopWatching);
    await evidence(
      page,
      "shell-p10-gaps-repository-narrow",
      `at 390px the repository page renders its sections without sideways scroll`,
    );
  });

  test("usage: the USED BY count equals the profile usage report; tracking is not unavailable", async ({
    page,
  }) => {
    test.setTimeout(10 * 60_000);
    await signIn(page, "admin");
    const stopWatching = watchPageErrors(page);
    const request = page.request;
    const profile = await apiProfileForAgentRun(request);
    const usageRes = await request.get(`${BASE_URL}/api/v1/agent-profiles/${profile.id}/usage`);
    expect(
      usageRes.status(),
      `GET /api/v1/agent-profiles/${profile.id}/usage -> ${usageRes.status()}`,
    ).toBe(200);
    const usage = (await usageRes.json()) as {
      workflow_count: number;
      step_count: number;
      uses?: unknown[];
      truncated?: boolean;
    };
    await page.goto(`${BASE_URL}/profiles/${profile.id}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId(`profile-detail-${profile.id}`)).toBeVisible({ timeout: 30_000 });
    const summary = page.getByTestId("profile-usage-summary");
    await expect(summary).toContainText(
      `Used by ${usage.workflow_count} workflows · ${usage.step_count} steps`,
    );
    await expect(page.getByTestId("profiles-usage-unavailable")).toHaveCount(0);
    const profileRows = page.getByTestId("profile-usage-row");
    await expect(profileRows).toHaveCount(usage.uses?.length ?? 0);

    const csrf = await apiCsrf(request);
    const template = (await apiPost(request, csrf, "/api/v1/node-templates", {
      slug: `p10usage${STAMP}`,
      display_name: `p10 usage scratch step ${STAMP}`,
      kind: "process.exec",
      parameters: {},
      config: {},
    })) as { id?: string };
    const templateId = template.id ?? "";
    expect(templateId, "POST /api/v1/node-templates answered the template id").toBeTruthy();
    const stepUsageRes = await request.get(`${BASE_URL}/api/v1/node-templates/${templateId}/usage`);
    expect(
      stepUsageRes.status(),
      `GET /api/v1/node-templates/${templateId}/usage -> ${stepUsageRes.status()}`,
    ).toBe(200);
    const stepUsage = (await stepUsageRes.json()) as { workflow_count: number; uses?: unknown[] };
    await page.goto(`${BASE_URL}/steps/${templateId}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("step-usage")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("step-usage")).toContainText(
      `USED IN ${stepUsage.workflow_count} WORKFLOW${stepUsage.workflow_count === 1 ? "" : "S"}`,
    );
    await expect(page.getByTestId("step-usage-row")).toHaveCount(stepUsage.uses?.length ?? 0);

    await checkShellScreen(page, "usage", stopWatching);
    await evidence(
      page,
      "shell-p10-gaps-usage",
      `the profile ${profile.name}'s USED BY panel reads "Used by ${usage.workflow_count} workflows · ${usage.step_count} steps" from GET /api/v1/agent-profiles/${profile.id}/usage, with no "usage unavailable" state, and the step's USED IN panel answers GET /api/v1/node-templates/${templateId}/usage`,
    );
  });

  test("thread artifacts: the thread rail lists the thread's artifacts", async ({ page }) => {
    test.setTimeout(10 * 60_000);
    await signIn(page, "admin");
    const stopWatching = watchPageErrors(page);
    const request = page.request;
    const conversations = await apiConversations(request);
    let conversation = conversations.find((row) => row.origin === "manual") ?? conversations[0];
    if (!conversation) {
      const csrf = await apiCsrf(request);
      const profileId = await apiProfileId(request);
      const [project] = await apiProjects(request);
      if (!project) throw new Error("no project available to seed the one-off thread");
      const conversationId = await apiCreateConversation(
        request,
        csrf,
        project.id,
        profileId,
        `P10 thread ${STAMP}`,
      );
      conversation = {
        id: conversationId,
        title: `P10 thread ${STAMP}`,
        project_id: project.id,
        origin: "manual",
      };
    }
    const artifactsRes = await request.get(
      `${BASE_URL}/api/v1/projects/${conversation.project_id}/artifacts?conversation_id=${conversation.id}`,
    );
    expect(
      artifactsRes.status(),
      `GET /api/v1/projects/{id}/artifacts -> ${artifactsRes.status()}`,
    ).toBe(200);
    const artifactsBody = (await artifactsRes.json()) as { artifacts?: { id: string }[] };
    const apiCount = artifactsBody.artifacts?.length ?? 0;

    await page.goto(`${BASE_URL}/threads/${conversation.id}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("conversation-title")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("artifacts-rail")).toBeVisible({ timeout: 30_000 });
    const rows = page.getByTestId("thread-artifact-row");
    await expect(rows).toHaveCount(Math.min(apiCount, 5));

    await checkShellScreen(page, "thread artifacts", stopWatching);
    await evidence(
      page,
      "shell-p10-gaps-thread-artifacts",
      `the thread ${conversation.id.slice(0, 8)}'s artifacts rail renders its section and lists ${apiCount} artifact row(s) == GET /api/v1/projects/{id}/artifacts?conversation_id=<id> (capped at 5)`,
    );
  });

  test("workflow issue triggers: add one on the lab repo, and answer the not-a-GitHub 422", async ({
    page,
  }) => {
    test.setTimeout(10 * 60_000);
    await signIn(page, "admin");
    const stopWatching = watchPageErrors(page);
    const request = page.request;
    const pipelines = await apiPipelines(request);
    const pipeline = pipelines.find((row) => row.slug === "feature-development");
    if (!pipeline)
      throw new Error("the seeded feature-development pipeline must be in the library");

    await page.goto(BASE_URL + `/workflows/${pipeline.id}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("pipeline-page")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("workflow-triggers")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("trigger-add-issue")).toBeVisible({ timeout: 30_000 });

    await page.getByTestId("trigger-add-issue").click();
    const dialog = page.getByTestId("trigger-add-issue-dialog");
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    const repoSelect = page.getByTestId("trigger-add-issue-repository");
    await expect(repoSelect).toBeVisible({ timeout: 30_000 });
    const optionValues = await repoSelect
      .locator("option")
      .evaluateAll((els: HTMLOptionElement[]) => els.map((e) => e.value));
    const repoValue = optionValues.find((value) => value && value !== "");
    expect(repoValue, "the dialog's repository offers a repository").toBeTruthy();
    await repoSelect.selectOption(repoValue ?? "");
    const goal = page.getByTestId("trigger-add-issue-input-goal");
    await expect(goal).toBeVisible({ timeout: 30_000 });
    await goal.fill(`P10 issue trigger ${STAMP}`);
    const confirm = page.getByTestId("trigger-add-issue-confirm");
    await expect(confirm).toBeEnabled({ timeout: 30_000 });
    const post = page.waitForResponse(
      (response) =>
        response.url().includes("/api/v1/projects/") &&
        response.url().includes("/issue-triggers") &&
        response.request().method() === "POST",
      { timeout: 30_000 },
    );
    await confirm.click();
    const postResponse = await post;
    expect(
      postResponse.status(),
      `POST /api/v1/projects/{id}/issue-triggers -> ${postResponse.status()}`,
    ).toBe(422);
    const problem = (await postResponse.json()) as { detail?: string };
    expect(problem.detail).toContain("not a GitHub repository");
    await expect(dialog).toBeVisible();
    const alert = page.getByTestId("trigger-add-issue-error");
    await expect(alert).toContainText("Not A GitHub Repository");

    await checkShellScreen(page, "workflow issue triggers", stopWatching);
    await evidence(
      page,
      "shell-p10-gaps-issue-trigger-422",
      `the issue-trigger dialog POSTed to /api/v1/projects/{id}/issue-triggers against the lab's file:// repository and answered the server's 422 not_a_github_repository inline`,
    );
  });
});
