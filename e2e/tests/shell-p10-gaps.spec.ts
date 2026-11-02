// The round's E2E gaps — one acceptance spec per feature the working tree
// landed this round: Workflow Triggers, the Repository page, Usage and
// Thread artifacts. The design handoff's acceptance.md still marked these
// NOT COVERED; the round's features closed the gaps, and this spec proves
// each one against the lab.
//
// Runs ONLY when COMMUNICATION_E2E_SHELL=1. checkShellScreen on every page;
// evidence() per step; zero page errors. Scratch schedules / threads / steps
// are created through the API where the journey needs them and are left clean.

import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";

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
  apiProfileId,
  apiScratchProject,
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
  assignment_id: string;
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

/**
 * ADR-0060 moved trigger authoring onto the repository page: a workflow is
 * a library template, a repository *uses* it through an assignment, and the
 * triggers belong to that use (design 2e/2c). The panel keys its rows by the
 * assignment id stripped like the UI's own `testidOf` — so the journey
 * resolves the workflow's row from the API instead of guessing position.
 */
async function openRepoWorkflowRow(
  page: Page,
  slug: string,
): Promise<{
  projectId: string;
  repoName: string;
  key: string;
  assignmentId: string;
  pipelineId: string;
}> {
  const projectPath = await openProjectBySlug(page, "m4-exit");
  const projectId = projectPath.split("/").pop() ?? "";
  expect(projectId, "the opened project answers with its uuid").toMatch(/^[0-9a-f-]{36}$/);
  const pipelines = await apiPipelines(page.request);
  const pipeline = pipelines.find((row) => row.slug === slug);
  if (!pipeline) throw new Error(`the seeded ${slug} pipeline must be in the library`);
  const reposRes = await page.request.get(`${BASE_URL}/api/v1/projects/${projectId}/repos`);
  expect(reposRes.status(), `GET repos -> ${reposRes.status()}`).toBe(200);
  const repos = (await reposRes.json()) as { items?: { name: string }[] };
  const repoName = repos.items?.[0]?.name ?? "";
  expect(repoName, "the lab project holds a repository").toBeTruthy();
  const assignsRes = await page.request.get(`${BASE_URL}/api/v1/projects/${projectId}/assignments`);
  expect(assignsRes.status(), `GET assignments -> ${assignsRes.status()}`).toBe(200);
  const assigns = (await assignsRes.json()) as {
    assignments?: { id: string; pipeline_id: string; repository_id?: string | null }[];
  };
  // The row the panel lists: this pipeline's use that covers the repository
  // (the repo's own pin, or a whole-project one).
  const assignment = (assigns.assignments ?? []).find(
    (row) => row.pipeline_id === pipeline.id && !row.repository_id,
  );
  expect(assignment, `${slug} is assigned to the lab project (whole-project pin)`).toBeTruthy();
  const key = (assignment?.id ?? "").replace(/[^A-Za-z0-9]/g, "").slice(0, 13);
  await page.goto(`${BASE_URL}${projectPath}/${repoName}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("repo-page")).toBeVisible({ timeout: 30_000 });
  await ensureRepoListView(page);
  await expect(page.getByTestId("repo-workflows")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId(`repo-workflow-row-${key}`)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId(`repo-workflow-name-${key}`)).toContainText(slug, {
    timeout: 30_000,
  });
  return { projectId, repoName, key, assignmentId: assignment?.id ?? "", pipelineId: pipeline.id };
}

/**
 * Put the repository page in its LIST view (design 3a) and wait for it.
 *
 * The List | Lanes choice (2e5c648, design 3b) is a SERVER-saved per-user
 * layout preference (`repo-view:<repo>` in the prefs' expanded map), and this
 * lab shares one admin across every journey — an earlier screen (or an
 * emulator pass that clicked Lanes) can leave the page opening on Lanes,
 * where the WORKFLOWS panel and the chat box this journey reads do not
 * exist. A journey that names one view must choose it, not inherit it.
 */
async function ensureRepoListView(page: Page): Promise<void> {
  const toggle = page.getByTestId("repo-view-toggle");
  await expect(toggle, "design 3b: the List | Lanes toggle stands in the header").toBeVisible({
    timeout: 30_000,
  });
  const list = page.getByTestId("repo-view-list");
  if ((await list.getAttribute("aria-pressed")) !== "true") {
    await list.click({ timeout: 10_000 });
  }
  await expect(list).toHaveAttribute("aria-pressed", "true", { timeout: 15_000 });
}

/**
 * Open a repo workflow row's `⋯` menu and its `Add trigger…` item, returning
 * the trigger dialog (design 3a/cf699ce, handoff-repo-chat-nav: the inline
 * STARTS WHEN box and its `+ Add trigger` left the repository page — the
 * row's `⋯` menu is the row's only door to the 2c dialog, with one
 * `Edit <trigger>` item per existing trigger). A background refetch can
 * re-render the panel mid-click (the emulator learned this), so opening is a
 * bounded loop rather than one click.
 */
async function openTriggerMenu(page: Page, key: string): Promise<Locator> {
  const menu = page.getByTestId("repo-workflow-row-menu");
  const row = page.getByTestId(`repo-workflow-row-${key}`);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (await menu.isVisible().catch(() => false)) break;
    await row
      .locator(`[data-testid="repo-workflow-menu-${key}"]`)
      .click({ timeout: 15_000 })
      .catch(() => undefined);
    await page.waitForTimeout(400);
  }
  await expect(menu, "design 3a: the row's ⋯ menu opens").toBeVisible({ timeout: 15_000 });
  return menu;
}

/** ⋯ → `Add trigger…` → the 2c dialog. */
async function addTriggerViaRowMenu(page: Page, key: string): Promise<Locator> {
  const menu = await openTriggerMenu(page, key);
  const add = menu.getByTestId(`repo-workflow-menu-add-${key}`);
  await expect(add, "design 3a: the row's ⋯ menu offers `Add trigger…`").toBeVisible({
    timeout: 15_000,
  });
  await add.click({ timeout: 15_000 });
  const dialog = page.getByTestId("trigger-dialog");
  await expect(
    dialog,
    "design 3a: the row's ⋯ → Add trigger… opens the trigger dialog",
  ).toBeVisible({ timeout: 30_000 });
  return dialog;
}

/** The repo page's row trigger line (`Schedule · every weekday at 09:00
 * UTC`, a paused one ending in ` · paused`) reads from the trigger queries,
 * which the panel caches hard (reloadTime off) — so the journey reloads and
 * waits for the line to stop saying `· loading` (design 3a, same path the
 * emulator's repo-triggers journey reads).
 */
async function reloadRowTriggerLine(page: Page, key: string): Promise<string> {
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByTestId(`repo-workflow-row-${key}`)).toBeVisible({ timeout: 30_000 });
  const line = page.getByTestId(`repo-workflow-triggers-${key}`);
  await expect
    .poll(
      async () => ((await line.textContent().catch(() => null)) ?? "").replace(/\s+/g, " ").trim(),
      { message: "the row's trigger line has read its triggers", timeout: 30_000 },
    )
    .not.toBe("· loading");
  return String(await line.textContent());
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
    // ADR-0060/2e: triggers are authored where the workflow is USED — the
    // repository page's WORKFLOWS panel — never on the library page.
    // cf699ce (design 3a, handoff-repo-chat-nav): the inline STARTS WHEN box
    // and its `+ Add trigger` left the page; the row's `⋯` menu is now the
    // row's only door to the 2c dialog, and the row's ONE trigger line is
    // where its triggers are read back.
    const { repoName, key } = await openRepoWorkflowRow(page, "feature-development");
    const dialog = await addTriggerViaRowMenu(page, key);
    // The dialog is opened FROM a repository row: no repo select — the
    // repository is fixed by the page and echoed back in THE RUN GETS.
    await expect(page.getByTestId("trigger-dialog-context")).toContainText(repoName, {
      timeout: 30_000,
    });
    await expect(page.getByTestId("trigger-dialog-run-gets-repository")).toContainText(repoName, {
      timeout: 30_000,
    });
    await page.getByTestId("trigger-dialog-mode-schedule").click();
    const goal = page.getByTestId("new-run-input-goal");
    await expect(goal).toBeVisible({ timeout: 30_000 });
    await goal.fill(`P10 weekdays schedule ${STAMP}`);
    // "weekdays 09:00 UTC" is the cadence, typed in the grammar the server
    // owns; the dialog reads it back in plain English as the author watches.
    await page.getByTestId("trigger-dialog-cron").fill("0 9 * * 1-5");
    await expect(page.getByTestId("trigger-dialog-cron-words")).toContainText(
      "every weekday at 09:00 UTC",
      { timeout: 30_000 },
    );
    const confirm = page.getByTestId("trigger-dialog-submit");
    await expect(confirm).toBeEnabled({ timeout: 30_000 });
    // Design 2c copy (pass-2 review): ONE verb for both arms — the schedule
    // arm's primary button reads `Add trigger`, not `Add schedule`.
    await expect(confirm).toHaveText("Add trigger");
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

    const rowKey = scheduleId.replace(/[^A-Za-z0-9]/g, "").slice(0, 13);
    // Design 3a: the trigger is read back on the row's ONE trigger line
    // (`Schedule · every weekday at 09:00 UTC`), not an inline STARTS WHEN
    // row — and the panel caches the trigger queries hard, so the journey
    // reloads to re-read the truth. The cron itself stays proven by the API.
    const schedules = await apiSchedules(request, projectId);
    const createdRow = schedules.find((schedule) => schedule.id === scheduleId);
    expect(
      createdRow,
      "the created schedule is served by GET /projects/{id}/schedules",
    ).toBeTruthy();
    expect(createdRow?.cron_expr).toBe("0 9 * * 1-5");
    expect(createdRow?.enabled).toBe(true);

    const line0 = await reloadRowTriggerLine(page, key);
    expect(line0.replace(/\s+/g, " ")).toContain("every weekday at 09:00 UTC");

    // The 3a pause path: ⋯ → `Edit <trigger>` → the dialog's Active/Paused
    // switch → `Save trigger`. The flip rides the same PATCH every other
    // answer spends; it replaces the retired inline enabled checkbox.
    const menu = await openTriggerMenu(page, key);
    const editItem = menu.getByTestId(`repo-workflow-menu-schedule-${rowKey}`);
    await expect(
      editItem,
      "design 3a: the ⋯ menu lists one Edit item per trigger, named by its words",
    ).toContainText("every weekday at 09:00 UTC", { timeout: 15_000 });
    await editItem.click({ timeout: 15_000 });
    const editDialog = page.getByTestId("trigger-dialog");
    await expect(editDialog, "the edit dialog opens on the schedule").toBeVisible({
      timeout: 30_000,
    });
    // The cron the dialog read back is the cron the server stored — the same
    // proof the retired `repo-workflow-trigger-detail` row carried.
    await expect(page.getByTestId("trigger-dialog-cron")).toHaveValue("0 9 * * 1-5", {
      timeout: 30_000,
    });
    const pauseSwitch = editDialog.getByRole("switch", { name: /pause this trigger/i });
    await expect(pauseSwitch, "design 3a: the edit dialog exposes the pause switch").toBeChecked({
      timeout: 30_000,
    });
    await pauseSwitch.click({ timeout: 10_000 });
    await expect(
      editDialog.getByTestId("trigger-dialog-enabled-state"),
      "the switch reads Paused before the save",
    ).toHaveText("Paused", { timeout: 10_000 });
    const patch = page.waitForResponse(
      (response) =>
        response.url().includes("/schedules") && response.request().method() === "PATCH",
      { timeout: 30_000 },
    );
    const save = editDialog.getByTestId("trigger-dialog-submit");
    // Design 3a (cf699ce): an existing trigger's verb is `Save trigger`.
    await expect(save).toHaveText("Save trigger", { timeout: 10_000 });
    await save.click({ timeout: 10_000 });
    expect((await patch).status(), "the pause saves through PATCH").toBeLessThan(300);
    await expect(editDialog, "the saved pause closes the dialog").toBeHidden({ timeout: 30_000 });

    // Proof after the pause: the row's line says `· paused` and the server
    // agrees.
    const line1 = await reloadRowTriggerLine(page, key);
    expect(line1.replace(/\s+/g, " ")).toMatch(/·\s*paused/i);
    const pausedRow = (await apiSchedules(request, projectId)).find(
      (schedule) => schedule.id === scheduleId,
    );
    expect(pausedRow?.enabled).toBe(false);

    await checkShellScreen(page, "workflow triggers", stopWatching);
    await evidence(
      page,
      "shell-p10-gaps-triggers-add",
      `the repository page's WORKFLOWS row for ${repoName} added a "weekdays 09:00 UTC" schedule through the row's ⋯ → Add trigger… 2c dialog: the row's trigger line reads "every weekday at 09:00 UTC" and GET /api/v1/projects/{id}/schedules echoes the cron "0 9 * * 1-5"`,
    );

    // Clean up: ADR-0032 exposes no DELETE — the off-switch for a scratch
    // schedule is the enabled flag, and the dialog pause this journey just
    // performed IS the cleanup: the scratch schedule ends disabled.
    const endRow = (await apiSchedules(request, projectId)).find(
      (schedule) => schedule.id === scheduleId,
    );
    expect(endRow?.enabled).toBe(false);

    await evidence(
      page,
      "shell-p10-gaps-triggers-pause",
      `pausing through ⋯ → Edit <trigger> → the Active/Paused switch flipped the server's enabled flag to false (GET /api/v1/projects/{id}/schedules: enabled=false, the row's trigger line ends \"· paused\") and the scratch schedule was cleaned up disabled`,
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

    // Design 1b: `repo-row-<name>` is the <li> row and the only link inside it
    // is the repository name, so the navigation click targets that link rather
    // than the row's centre (which hits no anchor).
    const repoRow = page.getByTestId(`repo-row-${repoName}`);
    await expect(repoRow).toBeVisible({ timeout: 30_000 });
    await repoRow.getByRole("link", { name: repoName }).click();
    await expect(page).toHaveURL(new RegExp(`/p/${projectId}/${repoName}$`));
    await expect(page.getByTestId("repo-page")).toBeVisible({ timeout: 30_000 });
    // The sections below are design 3a's LIST view — the choice is a saved
    // preference, so the journey presses List rather than inheriting one.
    await ensureRepoListView(page);
    // Design 3a (handoff-repo-chat-nav): the page's sections are the header,
    // the chat box, the activity feed (runs and chats mixed — the successor
    // of WORK IN THIS REPO and RECENT RUNS), and the side column's WORKFLOWS
    // and OPEN ISSUES panels.
    for (const testid of [
      "repo-header",
      "repo-chat-box",
      "repo-activity",
      "repo-runs",
      "repo-workflows",
      "repo-issues",
    ]) {
      await expect(page.getByTestId(testid)).toBeVisible({ timeout: 30_000 });
    }
    await checkShellScreen(page, "repository page", stopWatching);
    await evidence(
      page,
      "shell-p10-gaps-repository",
      `from the project page the repo link "${repoName}" opened /p/${projectId}/${repoName} and the repository page renders its header, chat box, ACTIVITY (runs and chats), WORKFLOWS and OPEN ISSUES sections`,
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
      const project = await apiScratchProject(request);
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
    // The rail is not an always-open column: ARTIFACTS sits behind the "Thread
    // details" disclosure under the transcript (the same door
    // shell-p6-threads.spec.ts opens), so the arm opens it before reading the
    // section inside — asserting the rail without opening the door tests the
    // summary's text, not the rail.
    const context = page.getByTestId("thread-context-block");
    await expect(context, "the thread's context block stands under the transcript").toBeVisible();
    await context.locator("summary").click();
    await expect(context).toHaveAttribute("open", "");
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
    // Same move as the schedule arm (ADR-0060/2e): the issue trigger is
    // added from the repository page's row, where the repository is fixed —
    // the lab's one repository is a file:// remote, so this is exactly the
    // surface that must answer the server's not-a-GitHub 422 inline.
    // cf699ce (design 3a): the row's `⋯` menu → `Add trigger…` is the door
    // (the STARTS WHEN header's `+ Add trigger` left the page).
    const { repoName, key } = await openRepoWorkflowRow(page, "feature-development");
    const dialog = await addTriggerViaRowMenu(page, key);
    // A fresh dialog starts on the issue arm, bound to THIS repository.
    await expect(page.getByTestId("trigger-dialog-mode-issue")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.getByTestId("trigger-dialog-context")).toContainText(repoName, {
      timeout: 30_000,
    });
    const goal = page.getByTestId("new-run-input-goal");
    await expect(goal).toBeVisible({ timeout: 30_000 });
    await goal.fill(`P10 issue trigger ${STAMP}`);
    const confirm = page.getByTestId("trigger-dialog-submit");
    await expect(confirm).toBeEnabled({ timeout: 30_000 });
    // Same verb on the issue arm (design 2c): one `Add trigger`, whichever arm
    // the reader is on — the row it creates is named by the mode, not by a
    // second primary label.
    await expect(confirm).toHaveText("Add trigger");
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
    const alert = page.getByTestId("trigger-dialog-error");
    await expect(alert).toContainText("Not A GitHub Repository");

    await checkShellScreen(page, "workflow issue triggers", stopWatching);
    await evidence(
      page,
      "shell-p10-gaps-issue-trigger-422",
      `the repository page's issue-trigger dialog POSTed to /api/v1/projects/{id}/issue-triggers against the lab's file:// repository ${repoName} and answered the server's 422 not_a_github_repository inline, dialog still open`,
    );
  });
});
