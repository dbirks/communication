// Journey: the approval gate and the artifact (design Run workbench).
//
// Starts the pass's "Emu sched <passId>" plan-with-approval workflow from
// the repo page's `Run` button (repo-triggers.spec.ts pinned it to M4 Exit /
// app in this same pass; a schedule-fired run from that file may also be
// around — this journey starts its own so it owns the run it approves).
// Then: wait (≤ 10 min, model calls are real) until the approval gate waits
// for a decision → approve it in the UI → wait for the run to complete →
// open plan.md and prove the content renders. Polling everywhere; model
// calls can take minutes.
import { expect, test } from "./fixtures.js";
import { EMU_ALICE_STATE, EMU_BASE_URL, EMU_PASS_ID } from "./env.js";

const SCHED_NAME = `Emu sched ${EMU_PASS_ID}`;

type Json = Record<string, unknown>;

test.describe("run-gate-artifacts (alice)", () => {
  test.describe.configure({ mode: "serial", timeout: 25 * 60_000 });
  test.use({ storageState: EMU_ALICE_STATE });

  test("start the gated workflow, approve the gate, read plan.md", async ({ page, emu }) => {
    let projectId = "";
    let runId = "";

    const wfRow = () =>
      page.locator('[data-testid^="repo-workflow-row-"]').filter({ hasText: SCHED_NAME });

    await test.step("find the pass's pinned workflow on M4 Exit / app", async () => {
      const projects = await page.request.get(`${EMU_BASE_URL}/api/v1/projects`);
      expect(projects.status(), "the lab answers GET /api/v1/projects").toBe(200);
      const body = (await projects.json()) as { items?: { id: string; slug: string }[] };
      projectId = body.items?.find((p) => p.slug === "m4-exit")?.id ?? "";
      expect(projectId, "the seeded 'M4 Exit' project exists").toMatch(/^[0-9a-f-]{36}$/);
      await page.goto(`/p/${projectId}/app`);
      await expect(
        wfRow(),
        `repo-triggers.spec.ts must have pinned '${SCHED_NAME}' to this repo before this journey can run`,
      ).toBeVisible({ timeout: 30_000 });
    });

    let runIdsBefore: string[] = [];
    await test.step("start the run from the dialog", async () => {
      runIdsBefore = await page
        .getByTestId("repo-runs")
        .locator('[data-testid^="repo-run-"]:not([data-testid*="status"])')
        .evaluateAll((els: Element[]) =>
          els.map((el) => (el.getAttribute("data-testid") ?? "").replace(/^repo-run-/, "")),
        );
      await wfRow().locator('[data-testid^="repo-workflow-run-"]').click({ timeout: 20_000 });
      const form = page.getByTestId("new-run-form");
      await expect(form, "the row's `Run` opens the new-run form").toBeVisible({ timeout: 20_000 });
      const assignment = form.getByTestId("new-run-assignment");
      if (await assignment.isVisible().catch(() => false)) {
        // Pick the pass's own pin: both its name and its slug carry the
        // pass id; the seeded options do not.
        const opt = assignment
          .locator("option")
          .filter({ hasText: EMU_PASS_ID })
          .first();
        await assignment.selectOption({ label: ((await opt.textContent()) ?? "").trim() });
      }
      const goal = form.getByTestId("new-run-input-goal");
      if (await goal.isVisible().catch(() => false)) {
        await goal.fill(`emu gate journey ${EMU_PASS_ID} — prove the gate and the plan artifact`);
      }
      const repoInput = form.getByTestId("new-run-input-repository");
      if (await repoInput.isVisible().catch(() => false)) {
        const appOption = repoInput.locator("option").filter({ hasText: /^app$/ }).first();
        if (await appOption.count()) {
          await repoInput.selectOption({ label: (await appOption.textContent())?.trim() ?? "app" });
        }
      }
      // Remember the run rows that already exist — the newest NEW row (by
      // id, not by list position: other agents share this lab) is ours.
      const runIds = async (): Promise<string[]> => {
        await page.goto(`/p/${projectId}/app`);
        await page.getByTestId("repo-runs").waitFor({ state: "visible", timeout: 20_000 });
        return page
          .getByTestId("repo-runs")
          .locator('[data-testid^="repo-run-"]:not([data-testid*="status"])')
          .evaluateAll((els) =>
            els.map((el) => (el.getAttribute("data-testid") ?? "").replace(/^repo-run-/, "")),
          );
      };
      await form.getByTestId("new-run-submit").click({ timeout: 20_000 });
      await Promise.race([
        page.waitForURL(/runs\/[0-9a-f-]{36}/, { timeout: 60_000 }),
        page.getByTestId("new-run-form").waitFor({ state: "hidden", timeout: 60_000 }),
      ]).catch(() => undefined);
      const beforeIds = new Set<string>(runIdsBefore);
      await expect
        .poll(
          async () => {
            const now = await runIds();
            runId = now.find((id) => !beforeIds.has(id)) ?? "";
            return runId;
          },
          { message: "the new run shows on the repo page's Recent runs", timeout: 60_000 },
        )
        .toBeTruthy();
      await page.goto(`/runs/${runId}`);
    });

    const runStatus = async (): Promise<string> => {
      const res = await page.request.get(`${EMU_BASE_URL}/api/v1/runs/${runId}`);
      if (res.status() !== 200) return `http-${res.status()}`;
      const run = (await res.json()) as Json;
      return typeof run.status === "string" ? run.status : "unknown";
    };

    await test.step("wait for the approval gate to wait for a decision (≤ 10 min)", async () => {
      // The real model endpoint can blow a leg transiently (home-cluster saw
      // model.chat TIMEOUT recover on a UI Retry). One Retry is budgeted; a
      // second failure is the honest red. The 409 `run_not_retriable` just
      // means the run already moved on — declared, then re-read.
      emu.expectFailure(/\/api\/v1\/runs\/[0-9a-f-]{36}\/retry$/, 409);
      let retried = false;
      await expect
        .poll(
          async () => {
            const st = await runStatus();
            if (st === "failed" && !retried) {
              retried = true;
              await page.reload().catch(() => undefined);
              const retry = page.getByTestId("run-retry");
              if (await retry.isVisible().catch(() => false)) {
                await retry.click({ timeout: 10_000 }).catch(() => undefined);
                const reason = page.getByTestId("run-retry-reason");
                if (await reason.isVisible().catch(() => false)) {
                  await reason
                    .fill(`emu ${EMU_PASS_ID}: transient model failure — retry`)
                    .catch(() => undefined);
                }
                await page
                  .getByRole("button", { name: /^retry/i })
                  .last()
                  .click({ timeout: 10_000 })
                  .catch(() => undefined);
              }
              return "retrying-after-failed";
            }
            return st;
          },
          {
          message:
            "the plan-with-approval run parks in waiting_human within 10 min (the model legs are real)",
            timeout: 10 * 60_000,
            intervals: [5_000],
          },
        )
        .toBe("waiting_human");
      await emu.screen("run-gate", "waiting");
    });

    await test.step("approve the gate in the UI", async () => {
      // The deployed run view keys the gate card on its node execution:
      // `?node=<nodeExecutionId>` selects the approve node and the detail
      // pane renders the ApprovalCard.
      const nodes = (await (
        await page.request.get(`${EMU_BASE_URL}/api/v1/runs/${runId}/nodes`)
      ).json()) as { node_executions?: { node_id: string; id: string }[] };
      const gateNode = (nodes.node_executions ?? []).find((n) => n.node_id === "approve");
      expect(gateNode, "the run has an approve node execution").toBeTruthy();
      await page.goto(`/runs/${runId}?node=${gateNode?.id}`);
      await expect(
        page.getByTestId("approval-node"),
        "design: the run view opens the gate card for the waiting approve node",
      ).toBeVisible({ timeout: 30_000 });
      // The run page offers the decision from the gate card itself or from
      // its attention drawer — whichever this build wires up.
      const approve = page.getByTestId("approval-approve");
      const drawerApprove = page.getByTestId("run-drawer-approve");
      const offer = (await approve.isVisible().catch(() => false)) ? approve : drawerApprove;
      await expect(
        offer,
        "design: the waiting gate offers Approve to alice (maintainer of the project) — in the run view or its drawer",
      ).toBeVisible({ timeout: 30_000 });
      await expect(offer, "the Approve action is enabled for the approver").toBeEnabled({
        timeout: 15_000,
      });
      const comment = page.getByTestId("approval-comment");
      if (await comment.isVisible().catch(() => false)) {
        await comment.fill(`emu ${EMU_PASS_ID}: approved from the emulator.`);
      }
      await offer.click({ timeout: 20_000 });
      const confirm = page.getByTestId("run-drawer-approve-confirm");
      if (await confirm.isVisible().catch(() => false)) {
        await confirm.click({ timeout: 15_000 }).catch(() => undefined);
      }
      await expect(
        page.getByTestId("approval-decided"),
        "the gate reads as decided after the approval",
      ).toBeVisible({ timeout: 60_000 });
    });

    await test.step("wait for the run to complete (≤ 10 min)", async () => {
      await expect
        .poll(runStatus, {
          message: "the run reaches a terminal status",
          timeout: 10 * 60_000,
          intervals: [5_000],
        })
        .toMatch(/completed|failed|cancelled/);
      expect(
        await runStatus(),
        "the run COMPLETES (not fails) after the approval — plan-with-approval with a real model.chat",
      ).toBe("completed");
      await page.reload();
      await emu.screen("run-gate", "completed");
    });

    await test.step("open plan.md and prove it renders", async () => {
      await page.goto(`${new URL(page.url()).pathname}?view=artifacts`);
      const list = page.getByTestId("workbench-artifacts-list");
      const link = list.getByText(/plan\.md/).first();
      await expect(
        link,
        "design: the completed run's Artifacts view lists plan.md",
      ).toBeVisible({ timeout: 60_000 });
      await link.click();
      await page.waitForURL(/artifacts\/[0-9a-f-]{36}/, { timeout: 30_000 }).catch(() => undefined);
      await expect(page.getByTestId("artifact-not-found")).toHaveCount(0);
      await expect(
        page.getByTestId("artifact-page-title"),
        "the artifact page names plan.md",
      ).toContainText(/plan\.md/i, { timeout: 30_000 });
      const body = await page.evaluate(() => document.body.innerText);
      expect(
        body.replace(/\s+/g, "").length,
        "the artifact page renders real content (non-empty, no error state)",
      ).toBeGreaterThan(300);
      expect(body, "no error state on the artifact page").not.toMatch(
        /could not be (read|shown)|failed to load|artifact not found/i,
      );
      await emu.screen("artifact", "plan-md");
    });
  });
});
