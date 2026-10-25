// Journey: repo triggers (design 2e → 2c) — the schedule that fires.
//
// Self-contained per pass:
//   admin publishes a fresh "Emu sched <passId>" from the plan-with-approval
//   template (nothing else in the pass guarantees a gated workflow on a repo
//   before this file runs);
//   alice pins it to M4 Exit / app (`Use in a repo…`), adds an issue trigger
//   (labeled, label `emu-<passId>`) and a schedule trigger on `* * * * *`
//   (the API accepts minute-granular cron — internal/pipelines/schedule
//   ticks every 30 s, defaultScheduleTick, ADR-0032), waits up to ~4 minutes
//   for a run to appear on the repo page, opens it, then PAUSES the schedule
//   trigger so later passes and the lab stay quiet.
import { expect, test } from "./fixtures.js";
import { EMU_ALICE_STATE, EMU_ADMIN_STATE, EMU_BASE_URL, EMU_PASS_ID } from "./env.js";

const SCHED_NAME = `Emu sched ${EMU_PASS_ID}`;
const EMU_LABEL = `emu-${EMU_PASS_ID}`;

/** GET /api/v1/projects → the id of the seeded m4-exit project. */
async function m4ExitId(page: import("@playwright/test").Page): Promise<string> {
  const res = await page.request.get(`${EMU_BASE_URL}/api/v1/projects`);
  expect(res.status(), "the lab answers GET /api/v1/projects").toBe(200);
  const body = (await res.json()) as { items?: { id: string; slug: string }[] };
  const id = body.items?.find((p) => p.slug === "m4-exit")?.id ?? "";
  expect(id, "the seeded 'M4 Exit' project exists").toMatch(/^[0-9a-f-]{36}$/);
  return id;
}

test.describe("repo-triggers (admin pre-publishes the gated workflow)", () => {
  test.describe.configure({ mode: "serial", timeout: 10 * 60_000 });
  test.use({ storageState: EMU_ADMIN_STATE });

  test("publish 'Emu sched <pass>' from the plan-with-approval template", async ({
    page,
    emu,
  }) => {
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
    await expect(
      model,
      "design 1g: the plan step's inspector exposes its model field",
    ).toBeVisible({ timeout: 20_000 });
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
    await expect(page.getByTestId("studio-validate-verdict")).toContainText(
      /(^|[^a-z])valid/i,
      { timeout: 30_000 },
    );
    await page.getByTestId("studio-publish").click({ timeout: 20_000 });
    await expect(page.getByTestId("studio-published")).toBeVisible({ timeout: 60_000 });
  });
});

test.describe("repo-triggers (alice drives the repo page)", () => {
  test.describe.configure({ mode: "serial", timeout: 15 * 60_000 });
  test.use({ storageState: EMU_ALICE_STATE });

  test("pin it to M4 Exit / app, add an issue + schedule trigger, watch the schedule fire", async ({
    page,
    emu,
  }) => {
    emu.expectFailure(/\/api\/v1\/pipelines$/, 409);
    const projectId = await m4ExitId(page);
    // The deployed repo panel keys its workflow rows `repo-workflow-row-<key>`
    // (the key is the compacted assignment id). .last(): if the panel ever
    // shows the pin twice (optimistic insert + refetch), act on the freshest.
    const wfRow = () =>
      page
        .locator('[data-testid^="repo-workflow-row-"]')
        .filter({ hasText: SCHED_NAME })
        .last();
    // The repo panel's trigger queries cache hard (reloadTime off): after a
    // trigger POST lands, the journey reloads the page to re-read the truth.
    const reloadRepo = async () => {
      await page.reload();
      const row = wfRow();
      await expect(row).toBeVisible({ timeout: 30_000 });
      const expand = row.getByRole("button", { name: "Expand triggers" });
      if (await expand.isVisible().catch(() => false)) {
        await expand.click({ timeout: 10_000 }).catch(() => undefined);
      }
      await expect(row.getByText(/STARTS WHEN/i)).toBeVisible({ timeout: 20_000 });
    };

    let pipelineId = "";
    const issueBlocked: { value: string | null } = { value: null };
    await test.step("pin 'Emu sched' to the app repo", async () => {
      // The admin publish test left the studio URL; recover the pipeline id
      // from the index row link instead (cross-test globals do not survive
      // the file boundary in Playwright).
      await page.goto("/workflows");
      await expect(page.getByTestId("workflows-search")).toBeVisible({ timeout: 30_000 });
      await page.getByTestId("workflows-search").fill(SCHED_NAME);
      const row = page.getByRole("link", { name: new RegExp(SCHED_NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) });
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
      await dialog.getByTestId("assign-repo-select").selectOption({ label: "app" }, { timeout: 20_000 });
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
      await expect(page.getByTestId("repo-page"), "design 2e: the repository page renders").toBeVisible({
        timeout: 30_000,
      });
      await expect(
        wfRow(),
        "design 2e: the pinned workflow shows on the repo panel (repo-workflow-row-*)",
      ).toBeVisible({ timeout: 30_000 });
      await emu.screen("2e", "repo");
    });

    await test.step("2c — add an issue trigger (labeled, label emu-<passId>)", async () => {
      const row = wfRow();
      await row.getByRole("button", { name: "Expand triggers" }).click({ timeout: 15_000 });
      // The deployed row shows `+ Add trigger` only in the expanded
      // STARTS WHEN strip — expand first (idempotent).
      const expand = row.getByRole("button", { name: "Expand triggers" });
      if (await expand.isVisible().catch(() => false)) {
        await expand.click({ timeout: 10_000 }).catch(() => undefined);
      }
      await row.getByRole("button", { name: "+ Add trigger" }).first().click({ timeout: 15_000 });
      const dialog = page.getByTestId("trigger-dialog");
      await expect(dialog, "design 2c: '+ Add trigger' opens the trigger dialog").toBeVisible();
      // The dialog is focus-trapped and closes on outside interaction — the
      // screen is taken AFTER filling the form (the resize + click in
      // emu.screen() otherwise dismisses it).
      await dialog.getByTestId("trigger-dialog-mode-issue").click({ timeout: 15_000 });
      await dialog.getByTestId("trigger-dialog-event").selectOption("labeled", { timeout: 15_000 });
      await dialog.getByTestId("trigger-dialog-labels").fill(EMU_LABEL);
      await dialog.getByTestId("trigger-dialog-labels").press("Enter");
      await expect(
        dialog.locator('[data-testid^="trigger-dialog-label-chip-"]'),
        "the label chip lands in the dialog",
      ).toContainText(EMU_LABEL);
      // THE RUN GETS: the template's required `goal` input must carry a value
      // — the dialog offers the issue placeholders as a one-click fill.
      const quickfill = dialog.getByTestId("trigger-dialog-quickfill-goal");
      if (await quickfill.isVisible().catch(() => false)) {
        await quickfill.click({ timeout: 10_000 });
      } else {
        await dialog.getByTestId("new-run-input-goal").fill("emu goal from the trigger dialog").catch(() => undefined);
      }
      await emu.screen("2c", "add-trigger");
      // The submit enables only once the label chip lands; the screen above
      // may dismiss the trapped dialog — if it is gone, reopen and refill.
      if (!(await dialog.isVisible().catch(() => false))) {
        await row.getByRole("button", { name: "+ Add trigger" }).first().click({ timeout: 15_000 });
        await expect(dialog).toBeVisible({ timeout: 15_000 });
        await dialog.getByTestId("trigger-dialog-event").selectOption("labeled", { timeout: 15_000 });
        await dialog.getByTestId("trigger-dialog-labels").fill(EMU_LABEL);
        await dialog.getByTestId("trigger-dialog-labels").press("Enter");
      }
      // The dialog may honestly refuse: an issue trigger on a repository
      // that is not GitHub has no issues to watch. Record the refusal and
      // finish the journey's cleanup before failing on it.
      let issueRefusal: string | null = null;
      const submit = dialog.getByTestId("trigger-dialog-submit");
      if (!(await submit.isEnabled().catch(() => false))) {
        issueRefusal =
          (await dialog.getByTestId("trigger-dialog-error").textContent().catch(() => null)) ??
          (await page.getByRole("alert").first().textContent().catch(() => "submit disabled")) ??
          "submit disabled";
      } else {
        await submit.click({ timeout: 15_000 });
        if (!(await dialog.waitFor({ state: "hidden", timeout: 15_000 }).then(() => true).catch(() => false))) {
          issueRefusal =
            (await dialog.getByTestId("trigger-dialog-error").textContent().catch(() => null)) ??
            (await page.getByRole("alert").first().textContent().catch(() => "dialog stayed open")) ??
            "dialog stayed open";
        }
        await page.keyboard.press("Escape");
      }
      await reloadRepo();
      if (issueRefusal === null) {
        await expect(
          row.locator('[data-testid^="trigger-issue-row-"], [data-testid^="repo-workflow-trigger-"]')
            .filter({ hasText: EMU_LABEL }),
          "design 2c: the issue trigger shows under STARTS WHEN with its label",
        ).toBeVisible({ timeout: 30_000 });
      }
      issueBlocked.value = issueRefusal;
    });

    let scheduleRow = "";
    await test.step("2c — add a schedule trigger on `* * * * *`", async () => {
      const row = wfRow();
      const before = await row
        .locator('[data-testid^="repo-workflow-trigger-"]')
        .evaluateAll((els: Element[]) => els.map((el) => el.getAttribute("data-testid") ?? ""));
      await row.getByRole("button", { name: "+ Add trigger" }).first().click({ timeout: 15_000 });
      const dialog = page.getByTestId("trigger-dialog");
      await expect(dialog).toBeVisible();
      await dialog.getByTestId("trigger-dialog-mode-schedule").click({ timeout: 15_000 });
      await dialog.getByTestId("trigger-dialog-cron").fill("* * * * *");
      // THE RUN GETS: the template's required `goal` input must carry a
      // value for a schedule fire (no issue to borrow placeholders from).
      const scheduleGoal = dialog.getByTestId("new-run-input-goal");
      await expect(
        scheduleGoal,
        "design 2c: the schedule form exposes the run's `goal` input",
      ).toBeVisible({ timeout: 15_000 });
      await scheduleGoal.fill(`emu schedule ${EMU_PASS_ID}: prove the schedule trigger fires a run`);
      await dialog.getByTestId("trigger-dialog-submit").click({ timeout: 15_000 });
      // A validation problem keeps the dialog open — read it before failing.
      if (await dialog.isVisible().catch(() => false)) {
        const err = await dialog.getByTestId("trigger-dialog-error").textContent().catch(() => "");
        expect(
          err,
          `the schedule trigger submits cleanly (dialog error: ${JSON.stringify((err ?? "").slice(0, 200))})`,
        ).toBe("");
      }
      await expect(dialog).toBeHidden({ timeout: 30_000 });
      await expect
        .poll(
          async () => {
            await reloadRepo();
            const now = await row
              .locator('[data-testid^="repo-workflow-trigger-"]')
              .evaluateAll((els: Element[]) =>
                els.map((el) => el.getAttribute("data-testid") ?? ""),
              );
            scheduleRow = now.find((t: string) => !before.includes(t)) ?? "";
            return scheduleRow !== "";
          },
          {
            message: "design 2c: the schedule trigger appears under STARTS WHEN",
            timeout: 60_000,
            intervals: [3_000],
          },
        )
        .toBe(true);
    });

    await test.step("wait for the schedule to fire a run (≤ 4 min)", async () => {
      const runs = page.getByTestId("repo-runs");
      const beforeIds = await runs
        .locator('[data-testid^="repo-run-"]:not([data-testid*="status"])')
        .evaluateAll((els: Element[]) => els.map((el) => el.getAttribute("data-testid") ?? ""));
      const firstBefore = beforeIds[0] ?? "";
      await expect.poll(
        async () => {
          await page.reload();
          await page.getByTestId("repo-runs").waitFor({ state: "visible", timeout: 15_000 });
          const now = await page
            .getByTestId("repo-runs")
            .locator('[data-testid^="repo-run-"]:not([data-testid*="status"])')
            .evaluateAll((els: Element[]) => els.map((el) => el.getAttribute("data-testid") ?? ""));
          return now[0] && now[0] !== firstBefore ? now[0] : "";
        },
        {
          message:
            "the `* * * * *` schedule (30 s tick, ADR-0032) started a run within 4 minutes",
          timeout: 4 * 60_000,
          intervals: [5_000],
        },
      ).not.toBe("");

      const newest = page
        .getByTestId("repo-runs")
        .locator('[data-testid^="repo-run-"]:not([data-testid*="status"])')
        .first();
      const runTestid = (await newest.getAttribute("data-testid")) ?? "";
      await newest.click({ timeout: 15_000 });
      await page.waitForURL(/\/runs\/[0-9a-f-]{36}$/, { timeout: 30_000 });
      await emu.screen("2e", `schedule-run-${runTestid.replace(/^repo-run-/, "")}`);
    });

    await test.step("pause the schedule trigger (keep the lab quiet for later passes)", async () => {
      await page.goto(`/p/${projectId}/app`);
      const row = wfRow();
      await expect(row).toBeVisible({ timeout: 30_000 });
      // Rows render collapsed: expand, and re-expand if a background refetch
      // re-renders the panel mid-click (the trigger rows mount with the
      // disclosure).
      const schedRow = page.getByTestId(scheduleRow);
      let opened = false;
      for (let attempt = 0; attempt < 4 && !opened; attempt += 1) {
        if (await schedRow.isVisible().catch(() => false)) {
          opened = true;
          break;
        }
        const expand = row.getByRole("button", { name: "Expand triggers" });
        if (await expand.isVisible().catch(() => false)) {
          await expand.click({ timeout: 5_000 }).catch(() => undefined);
        }
        opened = await schedRow
          .waitFor({ state: "visible", timeout: 8_000 })
          .then(() => true)
          .catch(() => false);
      }
      await expect(
        schedRow,
        "the schedule trigger row is back on the repo page",
      ).toBeVisible({ timeout: 15_000 });
      // A `Run ready` toast can hover the row after the schedule fires —
      // dismiss it, and force the toggle if anything still overlays.
      await page
        .getByRole("button", { name: /close|dismiss/i })
        .first()
        .click({ timeout: 3_000 })
        .catch(() => undefined);
      const toggle = schedRow.getByRole("switch", { name: /pause this trigger/i });
      await toggle.first().click({ timeout: 10_000, force: true });
      await expect(
        schedRow.getByText(/paused/i),
        "the schedule trigger reads `paused` after the journey ends",
      ).toBeVisible({ timeout: 30_000 });
    });

    await test.step("2c — the issue trigger is exercised (honest refusal fails here, after cleanup)", async () => {
      expect(
        issueBlocked.value,
        "design 2c: an issue trigger (labeled, label emu-<passId>) can be created on this repo; " +
          `the dialog refused with: ${JSON.stringify((issueBlocked.value ?? "").slice(0, 300))} — ` +
          "the seeded M4 lab repository is file://, not GitHub, so the lab cannot prove this design line",
      ).toBeNull();
    });
  });
});
