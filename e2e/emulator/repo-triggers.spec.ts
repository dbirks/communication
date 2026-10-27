// Journey: repo triggers (design 2e → 2c) — the two triggers, and the run the
// schedule fires.
//
// Self-contained per pass, and it LEAVES THE LAB AS IT FOUND IT:
//   admin publishes a fresh "Emu sched <passId>" from the plan-with-approval
//   template (nothing else in the pass guarantees a gated workflow on a repo
//   before this file runs);
//   alice pins it to M4 Exit / app (`Use in a repo…`) and adds a schedule
//   trigger on `* * * * *` (the API accepts minute-granular cron —
//   internal/pipelines/schedule ticks every 30 s, defaultScheduleTick,
//   ADR-0032); then, because the seeded M4 repository is a `file://` remote and
//   the server honestly refuses an issue trigger on it
//   (`not_a_github_repository`), she creates a scratch project whose one
//   repository IS a github.com remote — outside M4 Exit, because the worker
//   mirrors every repository of a run's project when it prepares a run
//   workspace, so an unreachable remote there would fail the runs this journey
//   exists to prove — pins the same workflow on its repo page
//   (`+ use a library workflow`), authors the issue trigger there (labeled,
//   label `emu-<passId>`), proves the row and pauses it on the spot;
//   she waits ≤ 4 min for the schedule to start a run and opens it.
//
// Then the cleanup, because an assignment allows ONE run at a time
// (`assignments.max_concurrent_runs`, and the create-run refusal is a 409 —
// correct product behaviour) and every later journey of this pass starts its
// run on this same pin: she PAUSES both triggers she created, DECIDES the gate
// of the run her schedule fired (Approve, in the run view, as the maintainer
// she is) and waits for that run to reach a terminal status, so the workflow's
// single slot is free again for run-gate-artifacts — and says so at the end by
// reading the pin's runs back.
//
// Every read of a dialog's inline error is BOUNDED: the 2026-10-25 pass burned
// its whole 15-minute budget waiting for the text of an error node that never
// attached, because the create had SUCCEEDED and the dialog had correctly
// closed. A node that is not there is an answer, not a hang.
import { apiMutate, expect, test } from "./fixtures.js";
import type { Locator, Page } from "@playwright/test";
import { EMU_ALICE_STATE, EMU_ADMIN_STATE, EMU_BASE_URL, EMU_PASS_ID } from "./env.js";

const SCHED_NAME = `Emu sched ${EMU_PASS_ID}`;
const EMU_LABEL = `emu-${EMU_PASS_ID}`;
/** The cadence the journey authors: every minute, so the 30 s tick gets it. */
const SCHEDULE_CRON = "* * * * *";
/** A repository whose remote really is github.com, so the issue arm is
 * provable. The owner/repo deliberately does not exist there: a poll can only
 * fail, so this journey can never start a run off somebody's live issue. */
const GH_REPO = `emu-gh-${EMU_PASS_ID}`;
const GH_PROJECT_SLUG = `emu-gh-${EMU_PASS_ID}`;
const GH_URL = `https://github.com/communication-lab/missing-${EMU_PASS_ID}.git`;

/** `lib/format.ts`'s `testidOf`: the ids a row is keyed on are the compacted
 * uuid's first 13 characters — reproduced here so a trigger row is named by
 * the trigger the server created, not guessed from DOM order. */
function testidOf(id: string): string {
  return id.replace(/[^A-Za-z0-9]/g, "").slice(0, 13);
}

/** GET /api/v1/projects → the id of the seeded m4-exit project. */
async function m4ExitId(page: import("@playwright/test").Page): Promise<string> {
  const res = await page.request.get(`${EMU_BASE_URL}/api/v1/projects`);
  expect(res.status(), "the lab answers GET /api/v1/projects").toBe(200);
  const body = (await res.json()) as { items?: { id: string; slug: string }[] };
  const id = body.items?.find((p) => p.slug === "m4-exit")?.id ?? "";
  expect(id, "the seeded 'M4 Exit' project exists").toMatch(/^[0-9a-f-]{36}$/);
  return id;
}

/** Bounded read of the dialog's inline error ("" when it shows none). */
async function dialogErrorText(dialog: Locator): Promise<string> {
  const node = dialog.getByTestId("trigger-dialog-error");
  if ((await node.count()) === 0) return "";
  return ((await node.textContent({ timeout: 5_000 })) ?? "").trim();
}

/**
 * Press the dialog's submit and wait for it to close. Returns "" when it closed
 * — the 2c contract for a trigger the server accepted — and the inline error
 * when it stayed open, which is what a refusal is FOR.
 */
async function submitTrigger(dialog: Locator): Promise<string> {
  const submit = dialog.getByTestId("trigger-dialog-submit");
  await expect(submit, "the trigger form completes and enables submit").toBeEnabled({
    timeout: 20_000,
  });
  await submit.click({ timeout: 15_000 });
  const closed = await dialog
    .waitFor({ state: "hidden", timeout: 30_000 })
    .then(() => true)
    .catch(() => false);
  return closed ? "" : dialogErrorText(dialog);
}

/** A project-scoped list read through the page's own session. */
async function listJson(page: Page, path: string): Promise<Record<string, unknown>[]> {
  const res = await page.request.get(`${EMU_BASE_URL}/api/v1/${path}`);
  expect(res.status(), `GET /api/v1/${path} answers`).toBe(200);
  const body = (await res.json()) as Record<string, Record<string, unknown>[]>;
  const key = Object.keys(body).find((k) => Array.isArray(body[k])) ?? "";
  return key === "" ? [] : body[key];
}

test.describe("repo-triggers (admin pre-publishes the gated workflow)", () => {
  test.describe.configure({ mode: "serial", timeout: 10 * 60_000 });
  test.use({ storageState: EMU_ADMIN_STATE });

  test("publish 'Emu sched <pass>' from the plan-with-approval template", async ({ page, emu }) => {
    // A duplicated slug would 409 inline (declared); the name is pass-stamped.
    emu.expectFailure(/\/api\/v1\/pipelines$/, 409);
    await page.goto("/workflows");
    await expect(page.getByTestId("workflows-new-workflow")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("workflows-new-workflow").click();
    await expect(page.getByTestId("new-workflow-dialog")).toBeVisible();
    await page.getByTestId("library-new-name-input").fill(SCHED_NAME);
    await page.getByTestId("new-workflow-template-plan-with-approval").click();
    await page.getByTestId("library-new-submit").click();
    await page.waitForURL(/\/workflows\/[0-9a-f-]{36}\/drafts\/[0-9a-f-]{36}$/, {
      timeout: 30_000,
    });
    await expect(page.getByTestId("studio-page")).toBeVisible({ timeout: 30_000 });
    // The plan step must name a model THIS worker allowlists
    // (COMMUNICATION_MODEL_CHAT_MODELS) — a model.chat outside the allowlist
    // fails with binding_error before the gate. Pick the allowed
    // flash-next option; the select itself lists only what may be called.
    await page.getByTestId("canvas-step-plan").click({ timeout: 20_000 });
    const model = page.getByTestId("insp-config-model");
    await expect(model, "design 1g: the plan step's inspector exposes its model field").toBeVisible(
      { timeout: 20_000 },
    );
    // The lab worker's allowlist names the endpoint's real model
    // (docs/samples/home/plan-with-approval.yaml runs it live).
    const ALLOWED_MODEL = "david-birks/qwen3-8-flash-next";
    const option = model.locator("option").filter({ hasText: /flash/i }).first();
    const isSelect = (await model.evaluate((el) => el.tagName)) === "SELECT";
    if (isSelect) {
      const label = (await option.count())
        ? ((await option.textContent()) ?? "").trim()
        : ((await model.locator("option").nth(1).textContent()) ?? "").trim();
      await model.selectOption({ label }, { timeout: 15_000 });
    } else {
      await model.fill(ALLOWED_MODEL, { timeout: 15_000 });
      await model.press("Tab");
    }
    await page.getByTestId("studio-save").click({ timeout: 20_000 });
    await expect(page.getByTestId("studio-dirty")).toHaveCount(0, { timeout: 30_000 });
    await page.getByTestId("studio-validate").click({ timeout: 20_000 });
    await expect(page.getByTestId("studio-validate-verdict")).toContainText(/(^|[^a-z])valid/i, {
      timeout: 30_000,
    });
    await page.getByTestId("studio-publish").click({ timeout: 20_000 });
    await expect(page.getByTestId("studio-published")).toBeVisible({ timeout: 60_000 });
  });
});

test.describe("repo-triggers (alice drives the repo page)", () => {
  // The budget covers the two waits that are real work, not UI: ≤ 4 min for the
  // schedule to start a run and ≤ 10 min each for that run to reach the gate
  // and to finish after the approval (the model legs are real).
  test.describe.configure({ mode: "serial", timeout: 35 * 60_000 });
  test.use({ storageState: EMU_ALICE_STATE });

  test("pin it, add an issue + schedule trigger, watch the schedule fire, then decide the gate", async ({
    page,
    emu,
  }) => {
    // A re-created repository name would 409 inline (declared); the name is
    // pass-stamped. The GitHub repository's issue list is expected to fail —
    // the remote names a repository that does not exist, which is the point.
    emu.expectFailure(/\/api\/v1\/pipelines$/, 409);
    emu.expectFailure(/\/api\/v1\/projects$/, 409);
    emu.expectFailure(new RegExp(`/api/v1/projects/[0-9a-f-]{36}/repos$`), 409);

    const projectId = await m4ExitId(page);
    // The repo panel keys its workflow rows `repo-workflow-row-<key>` (the key
    // is the compacted assignment id). .last(): if the panel ever shows the pin
    // twice (optimistic insert + refetch), act on the freshest.
    const wfRow = (name = SCHED_NAME) =>
      page.locator('[data-testid^="repo-workflow-row-"]').filter({ hasText: name }).last();
    // The repo panel's trigger queries cache hard (reloadTime off): after a
    // trigger POST lands, the journey reloads the page to re-read the truth.
    const reloadRepo = async (expectName = SCHED_NAME) => {
      await page.reload();
      const row = wfRow(expectName);
      await expect(row, `the '${expectName}' row is on the repo page after the reload`).toBeVisible(
        { timeout: 30_000 },
      );
      await expandTriggers(row);
      await expect(row.getByText(/STARTS WHEN/i)).toBeVisible({ timeout: 20_000 });
      return row;
    };
    // Rows render collapsed and a background refetch can re-render the panel
    // mid-click, so expanding is a loop, not a single click.
    const expandTriggers = async (row: Locator) => {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const box = row.locator('[data-testid^="repo-workflow-starts-"]');
        if (await box.isVisible().catch(() => false)) return;
        const expand = row.getByRole("button", { name: "Expand triggers" });
        if (await expand.isVisible().catch(() => false)) {
          await expand.click({ timeout: 10_000 }).catch(() => undefined);
        }
        await page.waitForTimeout(500);
      }
    };

    let pipelineId = "";
    let ghProjectId = "";
    let ghRepoId = "";
    let scheduleId = "";
    let issueTriggerId = "";
    let firedRunId = "";

    await test.step("pin 'Emu sched' to the app repo", async () => {
      // The admin publish test left the studio URL; recover the pipeline id
      // from the index row link instead (cross-test globals do not survive
      // the file boundary in Playwright).
      await page.goto("/workflows");
      await expect(page.getByTestId("workflows-search")).toBeVisible({ timeout: 30_000 });
      await page.getByTestId("workflows-search").fill(SCHED_NAME);
      const row = page.getByRole("link", {
        name: new RegExp(SCHED_NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      });
      await expect(
        row,
        `the freshly published '${SCHED_NAME}' shows on the workflows index`,
      ).toBeVisible({ timeout: 30_000 });
      await row.click();
      await expect(page.getByTestId("pipeline-page")).toBeVisible({ timeout: 30_000 });
      pipelineId = new URL(page.url()).pathname.split("/")[2] ?? "";
      expect(pipelineId, "the workflow page carries the pipeline id").toMatch(/^[0-9a-f-]{36}$/);
      await page.getByTestId("assign-open").click();
      const dialog = page.getByTestId("use-in-repo-dialog");
      await expect(dialog).toBeVisible();
      // The deployed dialog picks the project with the row's `Use here`
      // button, then the repository in the form below it.
      const projectRow = dialog.locator("li").filter({ hasText: "M4 Exit" });
      await projectRow.getByTestId(/^assign-pick-/).click({ timeout: 20_000 });
      await dialog
        .getByTestId("assign-repo-select")
        .selectOption({ label: "app" }, { timeout: 20_000 });
      await dialog.getByTestId("assign-confirm").click({ timeout: 20_000 });
      // The deployed dialog confirms and closes on its own; the durable
      // proof is the assignment the pin created (the rail refetches late,
      // so poll the assignment API, not the cached page).
      await Promise.race([
        page.getByTestId("assign-success-panel").waitFor({ state: "visible", timeout: 30_000 }),
        dialog.waitFor({ state: "hidden", timeout: 30_000 }),
      ]).catch(() => undefined);
      await page.keyboard.press("Escape");
      await expect(dialog, "the dialog closes after the pin").toBeHidden({ timeout: 15_000 });
      await expect
        .poll(
          async () => {
            const res = await page.request.get(
              `${EMU_BASE_URL}/api/v1/projects/${projectId}/assignments`,
            );
            if (res.status() !== 200) return `http-${res.status()}`;
            const body = (await res.json()) as {
              assignments?: { pipeline_id: string; repository_id: string | null }[];
            };
            return (body.assignments ?? []).some((a) => a.pipeline_id === pipelineId)
              ? "pinned"
              : "absent";
          },
          { message: "the pin lands as an assignment on the project", timeout: 60_000 },
        )
        .toBe("pinned");
    });

    await test.step("2e — the repo page lists the workflow", async () => {
      await page.goto(`/p/${projectId}/app`);
      await expect(
        page.getByTestId("repo-page"),
        "design 2e: the repository page renders",
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        wfRow(),
        "design 2e: the pinned workflow shows on the repo panel (repo-workflow-row-*)",
      ).toBeVisible({ timeout: 30_000 });
      await emu.screen("2e", "repo");
    });

    await test.step("2c — add a schedule trigger on `* * * * *` (the dialog closes when it saves)", async () => {
      const row = await reloadRepo();
      // The ids that exist BEFORE the write: the new trigger is the row that
      // is not in this set (the list is the server's, not the page's cache).
      const before = new Set(
        (await listJson(page, `projects/${projectId}/schedules`)).map((s) => String(s.id)),
      );
      await row.getByRole("button", { name: "+ Add trigger" }).first().click({ timeout: 15_000 });
      const dialog = page.getByTestId("trigger-dialog");
      await expect(dialog, "design 2c: '+ Add trigger' opens the trigger dialog").toBeVisible();
      await dialog.getByTestId("trigger-dialog-mode-schedule").click({ timeout: 15_000 });
      await dialog.getByTestId("trigger-dialog-cron").fill(SCHEDULE_CRON);
      // THE RUN GETS: the template's required `goal` input must carry a
      // value for a schedule fire (no issue to borrow placeholders from).
      const scheduleGoal = dialog.getByTestId("new-run-input-goal");
      await expect(
        scheduleGoal,
        "design 2c: the schedule form exposes the run's `goal` input",
      ).toBeVisible({ timeout: 15_000 });
      await scheduleGoal.fill(
        `emu schedule ${EMU_PASS_ID}: prove the schedule trigger fires a run`,
      );
      // The OPEN dialog is design 2c's subject (the schedule arm): recorded
      // before the save closes it, so the report pairs the dialog itself
      // with 2c.png, not the repo page that follows. The saved-state shots
      // below stay — they prove the row the write produced.
      await emu.screen("2c", "dialog-schedule");
      // A save closes the dialog; only a refusal keeps it open, and then with
      // the server's own words in it.
      const error = await submitTrigger(dialog);
      expect(
        error,
        `the schedule trigger saved cleanly (dialog error: ${JSON.stringify(error)})`,
      ).toBe("");
      await expect(dialog, "a saved trigger closes the 2c dialog").toBeHidden({ timeout: 15_000 });

      await expect
        .poll(
          async () => {
            const now = await listJson(page, `projects/${projectId}/schedules`);
            const fresh = now.find((s) => !before.has(String(s.id)));
            scheduleId = fresh ? String(fresh.id) : "";
            return scheduleId;
          },
          {
            message: "the server recorded the schedule trigger",
            timeout: 30_000,
            intervals: [2_000],
          },
        )
        .toMatch(/^[0-9a-f-]{36}$/);

      await reloadRepo();
      await expect(
        row.getByTestId(`repo-workflow-trigger-${testidOf(scheduleId)}`),
        "design 2c: the schedule trigger shows under STARTS WHEN",
      ).toBeVisible({ timeout: 30_000 });
      await emu.screen("2c", "schedule-trigger-saved");
    });

    await test.step("2c — a GitHub-remote repository, in a project of its own", async () => {
      // The seeded M4 `app` remote is file://, and the server honestly refuses
      // an issue trigger on it (`not_a_github_repository`: a trigger that can
      // never poll is mis-authored intent). Design 2c's issue arm is real, so
      // the journey needs a github.com remote — and it needs one OUTSIDE M4
      // Exit: the worker mirrors EVERY repository of a run's project when it
      // prepares a run workspace (observed in the lab: a run whose input names
      // `app` failed `infra` at its first node with `create mirror
      // …/emu-gh-….git from https://… failed`), so an unreachable remote in M4
      // Exit would poison the very runs the schedule arm has to prove. The
      // project, the repository and the membership are this journey's own
      // setup — every design line below is still clicked through the UI.
      const ghProject = await apiMutate(page, "POST", `${EMU_BASE_URL}/api/v1/projects`, {
        name: `Emu gh ${EMU_PASS_ID}`,
        slug: GH_PROJECT_SLUG,
        description: "emulator issue-trigger arm scratch project (a github.com remote)",
      });
      const ghProjectBody = await ghProject.text();
      expect(
        ghProject.status(),
        `the scratch project is created (got ${ghProject.status()}: ${ghProjectBody.slice(0, 240)})`,
      ).toBe(201);
      ghProjectId = ((await ghProject.json()) as { id: string }).id;
      expect(ghProjectId, "the scratch project has an id").toMatch(/^[0-9a-f-]{36}$/);
      const ghRepoRes = await apiMutate(
        page,
        "POST",
        `${EMU_BASE_URL}/api/v1/projects/${ghProjectId}/repos`,
        { name: GH_REPO, git_url: GH_URL, default_branch: "main" },
      );
      const ghRepoBody = await ghRepoRes.text();
      expect(
        ghRepoRes.status(),
        `the github.com repository is added (got ${ghRepoRes.status()}: ${ghRepoBody.slice(0, 240)})`,
      ).toBe(201);
      ghRepoId = ((await ghRepoRes.json()) as { id: string }).id;
      // Its issue list is a GitHub call against a repository that does not
      // exist: a failure there is this journey's own setup, not a product bug.
      emu.expectFailure(new RegExp(`/api/v1/projects/${ghProjectId}/repos/${ghRepoId}/issues`));
    });

    await test.step("2c — add the issue trigger there (labeled, label emu-<passId>)", async () => {
      // The trigger belongs to the USE: pin the same workflow to the GitHub
      // repository too (the picker pins it to THIS project and THIS repo), then
      // author the trigger on that repository's page — a trigger watching a
      // different repository than its assignment pins is a `422
      // repository_mismatch`, and the dialog is right to refuse it.
      await page.goto(`/p/${ghProjectId}/${GH_REPO}`);
      await expect(
        page.getByTestId("repo-page"),
        "design 2e: the GitHub repo page renders",
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        page.locator('[data-testid^="repo-workflow-row-"]').filter({ hasText: SCHED_NAME }),
        "the new repository does not use this workflow yet",
      ).toHaveCount(0);
      await page.getByTestId("repo-workflow-library").click({ timeout: 15_000 });
      const picker = page.getByTestId("repo-library-dialog");
      await expect(picker, "'+ use a library workflow' opens the picker").toBeVisible();
      await picker.getByTestId("repo-library-search").fill(SCHED_NAME, { timeout: 15_000 });
      await picker.locator('[data-testid^="repo-library-use-"]').first().click({ timeout: 20_000 });
      await expect(picker, "the picker closes once the assignment is created").toBeHidden({
        timeout: 30_000,
      });
      const row = await reloadRepo();
      await expect(row, `the workflow is pinned to ${GH_REPO} and shows on its page`).toBeVisible({
        timeout: 30_000,
      });

      const before = new Set(
        (await listJson(page, `projects/${ghProjectId}/issue-triggers`)).map((t) => String(t.id)),
      );
      await row.getByRole("button", { name: "+ Add trigger" }).first().click({ timeout: 15_000 });
      const dialog = page.getByTestId("trigger-dialog");
      await expect(dialog).toBeVisible();
      // The dialog inherits the project AND the repository it was opened from —
      // the watched repo is this one, so there is nothing to pick.
      await expect(dialog.getByTestId("trigger-dialog-context")).toContainText(
        `${SCHED_NAME} · Emu gh ${EMU_PASS_ID} / ${GH_REPO}`,
        { timeout: 15_000 },
      );
      await dialog.getByTestId("trigger-dialog-mode-issue").click({ timeout: 15_000 });
      await dialog.getByTestId("trigger-dialog-event").selectOption("labeled", { timeout: 15_000 });
      await dialog.getByTestId("trigger-dialog-labels").fill(EMU_LABEL);
      await dialog.getByTestId("trigger-dialog-labels").press("Enter");
      await expect(
        dialog.locator('[data-testid^="trigger-dialog-label-chip-"]'),
        "the label chip lands in the dialog",
      ).toContainText(EMU_LABEL);
      // THE RUN GETS: the required `goal` rides the placeholders the fire fills.
      const quickfill = dialog.getByTestId("trigger-dialog-quickfill-goal");
      if (await quickfill.isVisible().catch(() => false)) {
        await quickfill.click({ timeout: 10_000 });
      } else {
        await dialog
          .getByTestId("new-run-input-goal")
          .fill("emu goal from the trigger dialog", { timeout: 10_000 });
      }
      // The OPEN dialog with the label chip filled is design 2c's issue arm —
      // recorded before the save closes it (see the schedule arm above).
      await emu.screen("2c", "dialog-issue");
      const error = await submitTrigger(dialog);
      expect(
        error,
        "design 2c: an issue trigger (labeled, label emu-<passId>) saves on a GitHub repository — " +
          `the dialog answered: ${JSON.stringify(error)}`,
      ).toBe("");
      await expect(dialog, "a saved trigger closes the 2c dialog").toBeHidden({ timeout: 15_000 });

      await expect
        .poll(
          async () => {
            const now = await listJson(page, `projects/${ghProjectId}/issue-triggers`);
            const fresh = now.find((t) => !before.has(String(t.id)));
            issueTriggerId = fresh ? String(fresh.id) : "";
            return issueTriggerId;
          },
          { message: "the server recorded the issue trigger", timeout: 30_000, intervals: [2_000] },
        )
        .toMatch(/^[0-9a-f-]{36}$/);

      await reloadRepo();
      const issueRow = row.getByTestId(`repo-workflow-trigger-${testidOf(issueTriggerId)}`);
      await expect(issueRow, "design 2c: the issue trigger shows under STARTS WHEN").toBeVisible({
        timeout: 30_000,
      });
      await expect(
        issueRow.getByTestId(`repo-workflow-trigger-label-${testidOf(issueTriggerId)}`),
        "design 2c: the row carries its label",
      ).toContainText(EMU_LABEL);
      await emu.screen("2c", "issue-trigger-saved");

      // Pause it HERE, not at the end: its remote cannot be polled, so an
      // enabled trigger would log a failed poll every minute for the rest of
      // the lab's life — and every failed poll holds the project's journal
      // lock for its 30 s bound, which is time the schedule tick cannot use.
      await issueRow.getByRole("switch", { name: /pause this trigger/i }).click({
        timeout: 10_000,
        force: true,
      });
      await expect(
        issueRow.getByTestId(`repo-workflow-trigger-enabled-${testidOf(issueTriggerId)}-state`),
        "the issue trigger is paused once its design line is proven",
      ).toHaveText("paused", { timeout: 30_000 });
    });

    await test.step("wait for the schedule to fire a run (≤ 4 min)", async () => {
      // The schedule's own row names the run it started — that is the proof the
      // trigger fired, and it is a FULL run id. (The repo page's run rows are
      // keyed `repo-run-<testidOf(id)>`, the 13-character compacted form: it is
      // a test id, not an id the API knows, and `GET /runs/<that>` is a 404.)
      await expect
        .poll(
          async () => {
            const rows = await listJson(page, `projects/${projectId}/schedules`);
            firedRunId = String(rows.find((s) => String(s.id) === scheduleId)?.last_run_id ?? "");
            return firedRunId;
          },
          {
            message:
              "the `* * * * *` schedule (30 s tick, ADR-0032) started a run within 4 minutes",
            timeout: 4 * 60_000,
            intervals: [5_000],
          },
        )
        .toMatch(/^[0-9a-f-]{36}$/);

      // design 2e: the run the schedule started is on the repo page, and
      // clicking it is how a person gets to the gate that waits for them.
      await page.goto(`/p/${projectId}/app`);
      const runRow = page.getByTestId(`repo-run-${testidOf(firedRunId)}`);
      await expect(
        runRow,
        `design 2e: the run the schedule fired (${firedRunId.slice(-8)}) shows under RECENT RUNS`,
      ).toBeVisible({ timeout: 30_000 });
      await emu.screen("2e", `schedule-run-${firedRunId.slice(-8)}`);
      await runRow.click({ timeout: 15_000 });
      await page.waitForURL(new RegExp(`/runs/${firedRunId}`), { timeout: 30_000 });
    });

    await test.step("pause the schedule trigger (keep the lab quiet and the slot single)", async () => {
      // Pause FIRST: every later fire would take the slot this run holds, and
      // a second gated run would make the pass's own cleanup ambiguous. (The
      // issue trigger was already paused when its design line was proven.)
      await page.goto(`/p/${projectId}/app`);
      const appRow = wfRow();
      await expect(appRow).toBeVisible({ timeout: 30_000 });
      await expandTriggers(appRow);
      const schedRow = appRow.getByTestId(`repo-workflow-trigger-${testidOf(scheduleId)}`);
      await expect(schedRow, "the schedule trigger row is on the repo page").toBeVisible({
        timeout: 20_000,
      });
      // A `Run ready` toast can hover the row after the schedule fires.
      await page
        .getByRole("button", { name: /close|dismiss/i })
        .first()
        .click({ timeout: 3_000 })
        .catch(() => undefined);
      await schedRow.getByRole("switch", { name: /pause this trigger/i }).click({
        timeout: 10_000,
        force: true,
      });
      await expect(
        schedRow.getByTestId(`repo-workflow-trigger-enabled-${testidOf(scheduleId)}-state`),
        "the schedule trigger reads `paused` after the journey ends",
      ).toHaveText("paused", { timeout: 30_000 });
      await emu.screen("2e", "triggers-paused");
    });

    await test.step("decide the gate of the run the schedule fired (≤ 10 min to the gate)", async () => {
      // The run a schedule started is now the assignment's ONE allowed run:
      // until it is decided it holds the slot, and every hand-started `Run`
      // against this pin answers 409 — correct product behaviour, which is why
      // the journey finishes the run it started instead of leaving it parked.
      const runStatus = async (): Promise<string> => {
        const res = await page.request.get(`${EMU_BASE_URL}/api/v1/runs/${firedRunId}`);
        if (res.status() !== 200) return `http-${res.status()}`;
        const run = (await res.json()) as { status?: string };
        return typeof run.status === "string" ? run.status : "unknown";
      };
      await expect
        .poll(
          async () => {
            const st = await runStatus();
            // A run that died before the gate has already freed the slot; the
            // approval step below refuses the case honestly rather than waiting.
            return st === "waiting_human" || ["completed", "failed", "cancelled"].includes(st)
              ? st
              : "";
          },
          {
            message: "the schedule-fired run reaches its approval gate within 10 min",
            timeout: 10 * 60_000,
            intervals: [5_000],
          },
        )
        .toBe("waiting_human");

      // The run view keys the gate card on its node execution: `?node=<id>`
      // selects the approve node and the detail pane offers the decision.
      const nodes = (await (
        await page.request.get(`${EMU_BASE_URL}/api/v1/runs/${firedRunId}/nodes`)
      ).json()) as { node_executions?: { node_id: string; id: string }[] };
      const gateNode = (nodes.node_executions ?? []).find((n) => n.node_id === "approve");
      expect(gateNode, "the fired run has an approve node execution").toBeTruthy();
      await page.goto(`/runs/${firedRunId}?node=${gateNode?.id}`);
      await expect(
        page.getByTestId("approval-node"),
        "design: the run view opens the gate card for the waiting approve node",
      ).toBeVisible({ timeout: 30_000 });
      const approve = page.getByTestId("approval-approve");
      const drawerApprove = page.getByTestId("run-drawer-approve");
      const offer = (await approve.isVisible().catch(() => false)) ? approve : drawerApprove;
      await expect(
        offer,
        "design: the waiting gate offers Approve to alice — in the run view or its drawer",
      ).toBeVisible({ timeout: 30_000 });
      await offer.click({ timeout: 20_000 });
      const confirm = page.getByTestId("run-drawer-approve-confirm");
      if (await confirm.isVisible().catch(() => false)) {
        await confirm.click({ timeout: 15_000 }).catch(() => undefined);
      }
      await expect(
        page.getByTestId("approval-decided"),
        "the gate reads as decided after the approval",
      ).toBeVisible({ timeout: 60_000 });
      await emu.screen("2e", "schedule-run-approved");

      await expect
        .poll(
          async () => {
            const st = await runStatus();
            return ["completed", "failed", "cancelled"].includes(st) ? st : "";
          },
          {
            message:
              "the run the schedule fired REACHES A TERMINAL STATUS, so the workflow's single " +
              "concurrent-run slot is free for the journeys that follow",
            timeout: 10 * 60_000,
            intervals: [5_000],
          },
        )
        .toBeTruthy();
      const last = await runStatus();
      expect(
        ["completed", "failed", "cancelled"],
        `the fired run ended (${last}) — the slot is free`,
      ).toContain(last);
    });

    await test.step("the journey left this pin's slot free", async () => {
      const assignments = await listJson(page, `projects/${projectId}/assignments`);
      const mine = assignments.filter((a) => a.pipeline_id === pipelineId);
      expect(mine.length, "this pass's workflow is pinned (app + the GitHub repo)").toBeGreaterThan(
        0,
      );
      for (const assignment of mine) {
        const runs = await listJson(
          page,
          `projects/${projectId}/runs?assignment_id=${String(assignment.id)}`,
        );
        const active = runs.filter((run) =>
          ["queued", "preparing", "running", "waiting_human", "paused"].includes(
            String(run.status),
          ),
        );
        expect(
          active.length,
          `assignment ${String(assignment.id).slice(0, 8)} holds no active run at the journey's end (${
            active.map((run) => `${String(run.id).slice(0, 8)}=${String(run.status)}`).join(", ") ||
            "none"
          })`,
        ).toBe(0);
      }
    });
  });
});
