// Journey: the approval gate and the artifact (design Run workbench).
//
// Starts the pass's "Emu sched <passId>" plan-with-approval workflow from
// the repo page's `Run` button (repo-triggers.spec.ts pinned it to M4 Exit /
// app in this same pass AND decided the gate of the run its own schedule
// fired, so this pin's single concurrent-run slot is free — an assignment
// allows `max_concurrent_runs` = 1 run, and a run parked at a gate holds it:
// the refusal below is therefore a journey-ordering failure, not a product
// bug). Then: wait (≤ 10 min, model calls are real) until the approval gate
// waits for a decision → approve it in the UI → wait for the run to complete
// → open plan.md and prove the content renders. Polling everywhere; model
// calls can take minutes.
import { expect, test } from "./fixtures.js";
import { collectPlanNumbering, judgePlanNumbering } from "./plan-steps.js";
import { collectDocumentProse, escapedMarkdownFault } from "./markdown-ink.js";
import { EMU_ALICE_STATE, EMU_BASE_URL, EMU_PASS_ID } from "./env.js";

const SCHED_NAME = `Emu sched ${EMU_PASS_ID}`;

type Json = Record<string, unknown>;

/** `lib/format.ts`'s `testidOf`: the run rows on the repo page are keyed on the
 * compacted uuid's first 13 characters, which is a test id and NOT a run id. */
function testidOf(id: string): string {
  return id.replace(/[^A-Za-z0-9]/g, "").slice(0, 13);
}

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
      // Remember the runs that already exist, by FULL id from the API: the
      // repo page's rows are keyed `repo-run-<testidOf(id)>` — a 13-character
      // compacted test id, not an id `GET /runs/{id}` knows (the 2026-10-25
      // pass read that form back as a run id and polled a 404 forever).
      const runIds = async (): Promise<string[]> => {
        const res = await page.request.get(`${EMU_BASE_URL}/api/v1/projects/${projectId}/runs`);
        expect(res.status(), "GET /projects/{id}/runs answers").toBe(200);
        const body = (await res.json()) as { runs?: { id: string; depth?: number }[] };
        return (body.runs ?? []).filter((r) => (r.depth ?? 0) === 0).map((r) => String(r.id));
      };
      runIdsBefore = await runIds();
      await wfRow().locator('[data-testid^="repo-workflow-run-"]').click({ timeout: 20_000 });
      const form = page.getByTestId("new-run-form");
      await expect(form, "the row's `Run` opens the new-run form").toBeVisible({ timeout: 20_000 });
      const assignment = form.getByTestId("new-run-assignment");
      if (await assignment.isVisible().catch(() => false)) {
        // Pick the pass's own pin: both its name and its slug carry the
        // pass id; the seeded options do not.
        const opt = assignment.locator("option").filter({ hasText: EMU_PASS_ID }).first();
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
        } else if (await repoInput.evaluate((el) => (el as HTMLInputElement).readOnly)) {
          // e211688: run-by-hand opened FROM a repo carries that repo — the
          // field arrives prefilled and read-only (never an empty free-text
          // box). Prove the carry rather than typing over it.
          await expect(
            repoInput,
            "design 1k (e211688): a repo-page run carries its repository, prefilled",
          ).toHaveValue("app");
        } else {
          // design 1k: an unannotated `repository` string is a plain text
          // field (ADR-0066 types are github_issue/branch/agent_profile/
          // text/long_text — there is no repository picker in the typed form)
          // and it is REQUIRED by the pinned plan-with-approval document, so
          // the journey must type the binding name or `Start run` stays
          // disabled and nothing starts.
          await repoInput.fill("app");
        }
      }
      // design 1k (commit 2e5c648) raised the form into RunFormDialog: the
      // fields stay inside `new-run-form` but `Start run` moved to the
      // dialog's FOOTER band — a sibling of the field column, not a member of
      // it (RunFormDialog.tsx puts `submit` beside `new-run-cancel`, outside
      // the children slot). Scoping the verb inside the form is what timed
      // out on Actions run 41447122534 (run-gate pass-6, fingerprint
      // 1e834db816afb354). Ask for it at page level, exactly like rcn-1k
      // (repo-chat-nav.spec.ts) does, and prove it renders before clicking.
      const submit = page.getByTestId("new-run-submit");
      await expect(submit, "design 1k: the dialog's footer carries the Start run verb").toBeVisible(
        { timeout: 20_000 },
      );
      await submit.click({ timeout: 20_000 });
      // A start the ceiling refuses must say so on screen — the form answers
      // the `409` with the reason AND a link to the run that holds the slot.
      // Reaching this branch means the journey before this one left its own
      // run parked at a gate, so it is a red with two halves: the honest
      // message is proven, and the ordering defect is named.
      const refused = page.getByTestId("new-run-error-reason");
      const outcome = await Promise.race([
        page
          .waitForURL(/runs\/[0-9a-f-]{36}/, { timeout: 60_000 })
          .then(() => "started" as const)
          .catch(() => "pending" as const),
        refused.waitFor({ state: "visible", timeout: 60_000 }).then(() => "refused" as const),
      ]);
      if (outcome === "refused") {
        const why = ((await refused.textContent({ timeout: 5_000 })) ?? "").trim();
        const holder = page.locator('[data-testid^="new-run-error-holder-"]').first();
        await expect(
          holder,
          "design: a ceiling refusal links to the run that holds the slot: " + JSON.stringify(why),
        ).toBeVisible({ timeout: 10_000 });
        await emu.screen("run-gate", "start-refused-by-the-ceiling");
        expect(
          why,
          "the hand-started run was refused by max_concurrent_runs — repo-triggers must " +
            `approve the gate of the run its schedule fired before it ends: ${JSON.stringify(why)} ` +
            `(linked run: ${((await holder.getAttribute("href", { timeout: 5_000 })) ?? "").trim()})`,
        ).toBe("");
      }
      await Promise.race([
        page.waitForURL(/runs\/[0-9a-f-]{36}/, { timeout: 60_000 }),
        page.getByTestId("new-run-form").waitFor({ state: "hidden", timeout: 60_000 }),
      ]).catch(() => undefined);
      // The form navigates to the run it created; that URL is the run's real
      // id. Only when it did not navigate does the journey diff the run list.
      if (/\/runs\/[0-9a-f-]{36}$/.test(new URL(page.url()).pathname)) {
        runId = new URL(page.url()).pathname.split("/")[2] ?? "";
      } else {
        const beforeIds = new Set<string>(runIdsBefore);
        await expect
          .poll(
            async () => {
              runId = (await runIds()).find((id) => !beforeIds.has(id)) ?? "";
              return runId;
            },
            { message: "the new run lands as a run of this project", timeout: 60_000 },
          )
          .toMatch(/^[0-9a-f-]{36}$/);
      }
      expect(runId, "the started run has a full run id").toMatch(/^[0-9a-f-]{36}$/);
      // design 2e: the run the person just started is on the repo page too.
      await page.goto(`/p/${projectId}/app`);
      await expect(
        page.getByTestId(`repo-run-${testidOf(runId)}`),
        "design 2e: the started run shows under RECENT RUNS",
      ).toBeVisible({ timeout: 30_000 });
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
      // Pass-1 design review item 2 (`run-gate-waiting-1280.png`): the plan runs
      // ~1800px tall and Approve/Reject sat at the bottom of it with nothing
      // pinned. The card is not clamped (round-2 review item 3 forbids that) — it
      // carries a Decide verb at its TOP instead, above the plan.
      const jump = page.getByTestId("approval-decide-jump");
      await expect(jump, "the gate card offers the decision from its top").toBeVisible({
        timeout: 30_000,
      });
      const [jumpBox, summaryBox, approveBox] = await Promise.all([
        jump.boundingBox(),
        page.getByTestId("approval-summary").boundingBox(),
        page.getByTestId("approval-approve").boundingBox(),
      ]);
      expect(jumpBox, "the Decide verb is on screen").not.toBeNull();
      expect(summaryBox, "the plan is on screen").not.toBeNull();
      expect(approveBox, "the decision form is on screen").not.toBeNull();
      // The jump sits above the plan, and the plan is what pushes the verbs down:
      // the gap the reader used to have to scroll is the gap these two measure.
      expect(jumpBox!.y).toBeLessThan(summaryBox!.y);
      expect(approveBox!.y - summaryBox!.y).toBeGreaterThan(0);
      // …and taking it moves the reader to the form (jsdom cannot measure a
      // scroll; the live page can).
      await jump.click();
      expect(
        await page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? ""),
        "the jump lands the reader in the decision form",
      ).toBe("approval-comment");
      // Pass-1 review item 1: the plan's steps are numbered so the reader can
      // count them — the renderer used to print “1.” for every step. The plan
      // is LIVE model output, so the check holds for the SHAPE-INDEPENDENT
      // rule (e2e/emulator/plan-steps.ts), not for one document structure: in
      // `out/pass-1-20261101102509` the planner wrote its steps as bold
      // paragraphs (“**1. Confirm …**”, “**2. Execute …**”) with bullet lists
      // under each, there was no ordered list at all, and a locator on
      // `markdown-list-ordered` returned nothing on a plan that reads 1…5.
      // Now: every ordered list numbers its own items consecutively from its
      // start, AND the numbers a reader sees in reading order rise by one — a
      // fresh 1 opens a new sequence (steps 1…5 then an acceptance 1…3 is what
      // a live plan looks like), while “1. 1. 1.”, a repeat (1, 2, 2) or a fall
      // that is not a restart (1, 2, 3, 2) is the defect this line exists for.
      // The rule's own unit tests (both shapes, the two-sequence plan and the
      // “1. 1. 1.” / “1, 2, 2” fixtures) are in `reflow-target.spec.ts`.
      const numbering = await page.evaluate(collectPlanNumbering);
      const numberingVerdict = judgePlanNumbering(numbering);
      expect(
        numberingVerdict.reason,
        `the plan's steps are numbered in order (numbers read: ${numberingVerdict.steps.join(", ")}; lists: ${JSON.stringify(numbering.lists)})`,
      ).toBe("");
      // The run's own title is never the thing that gives way (item 3) —
      // measured ON the element, after waiting for it. A null
      // `document.querySelector` used to fold into a magic `9999`; the
      // `toBeVisible` below is what a missing title now fails with, in
      // words, and the overflow number only ever comes from a real box.
      // (The live lab shows exactly one `[data-testid="run-title"]` on this
      // view — the workbench H1 — before AND after the Decide jump.)
      const gateTitle = page.getByTestId("run-title");
      await expect(
        gateTitle,
        "the run page at the gate renders its run title (a missing title is the defect this waits for)",
      ).toBeVisible({ timeout: 30_000 });
      expect(
        await gateTitle.evaluate((el: HTMLElement) => el.scrollWidth - el.clientWidth),
        "the run's own title gives way horizontally inside its box (item 3)",
      ).toBeLessThanOrEqual(0);
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
      // Pass-1 design review item 3 (`run-gate-completed-1280.png`): a finished
      // run showed a disabled `Retry` plus a ~100-character sentence beside it,
      // and that sentence was wide enough to truncate the run's H1 to `pr…`. The
      // changed contract: no dead verb on a run that ended clean, and the title
      // whole at 1280. Pass-2 review (this brief, item 3) finished the job: a
      // run that ENDED WELL shows no retry note at all — the old short
      // `× nothing to retry` read as a failure verdict on the happy end.
      //
      // The header is waited for FIRST because the reload answers with the
      // page's designed loading skeleton (`RunHeaderLoading`, gh-69) while the
      // run's reads and the workbench chunk arrive. The pass-1/20261101173601
      // trace names the frame: its `page.reload()` (call zwir@4015) left the
      // page on the “Loading run…” line; the two `toHaveCount(0)` verbs below
      // passed VACUOUSLY on that skeleton (it holds no Retry row), and the
      // title check at old L329 then measured nothing — the `9999` fallback of
      // a null `querySelector`, not an overflowing title (the same check at
      // the gate had already returned 0 on the real header, call zwir@3982).
      // So the header was not dropped by the finished-run view — the read just
      // landed before it mounted. Waiting for the title keeps the contract
      // whole and a header that never mounts fails HERE, saying it is missing,
      // instead of through a magic number.
      const finishedTitle = page.getByTestId("run-title");
      await expect(
        finishedTitle,
        "the reloaded finished-run page renders its run title (a missing title is the defect this waits for)",
      ).toBeVisible({ timeout: 60_000 });
      await expect(page.getByTestId("run-retry"), "no Retry verb on a finished run").toHaveCount(
        0,
        {
          timeout: 30_000,
        },
      );
      await expect(
        page.getByTestId("run-retry-reason"),
        "a clean completed run says nothing about Retry",
      ).toHaveCount(0);
      expect(
        await finishedTitle.evaluate((el: HTMLElement) => el.scrollWidth - el.clientWidth),
        "the run's own title gives way horizontally inside its box on the finished run",
      ).toBeLessThanOrEqual(0);
      await emu.screen("run-gate", "completed");
    });

    await test.step("open plan.md and prove it renders", async () => {
      await page.goto(`${new URL(page.url()).pathname}?view=artifacts`);
      const list = page.getByTestId("workbench-artifacts-list");
      const link = list.getByText(/plan\.md/).first();
      await expect(link, "design: the completed run's Artifacts view lists plan.md").toBeVisible({
        timeout: 60_000,
      });
      await link.click();
      await page.waitForURL(/artifacts\/[0-9a-f-]{36}/, { timeout: 30_000 }).catch(() => undefined);
      await expect(page.getByTestId("artifact-not-found")).toHaveCount(0);
      await expect(
        page.getByTestId("artifact-page-title"),
        "the artifact page names plan.md",
      ).toContainText(/plan\.md/i, { timeout: 30_000 });
      // a29d3ed (round-2 review item 4): a small Markdown artifact is now READ
      // on the page (`artifact-preview-markdown`), so the model's own words
      // ride in `body.innerText` — and a plan sentence like “if the build
      // failed to load …” would trip the error scan for a page state that did
      // not happen. The scan is about the PAGE (its chrome, its failure
      // sentences), so the preview's own text is cut out of the scanned body;
      // the screenshot below still proves the preview itself rendered.
      const body = await page.evaluate(() => {
        const preview = document.querySelector('[data-testid="artifact-preview-markdown"]');
        const own = preview instanceof HTMLElement ? preview.innerText : "";
        // Media type now reads `Markdown` (`artifact-media-type`), never the
        // wire's `text/markdown` — nothing here asserts either string, and the
        // wire value only survives in the value's `title`.
        return own ? document.body.innerText.split(own).join(" ") : document.body.innerText;
      });
      expect(
        body.replace(/\s+/g, "").length,
        "the artifact page renders real content (non-empty, no error state)",
      ).toBeGreaterThan(300);
      expect(body, "no error state on the artifact page").not.toMatch(
        /could not be (read|shown)|failed to load|artifact not found/i,
      );
      // Pass-1 design review item 4 (`artifact-plan-md-1280.png`): the page used
      // to print what was stored — the `model.chat` envelope's `{endpoint, model,
      // text}` with the plan escaped inside a string — under a byline written for
      // whoever runs the worker. The document reads as the document now, the
      // payload is behind “show raw”, and the byline names the step and the run.
      const prose = page.getByTestId("artifact-preview-prose");
      await expect(prose, "the preview holds the plan, not its envelope").toBeVisible();
      // Pass-1 (`out/pass-1-20261101113830`, `run-gate completed`) red-passed
      // here on `expect(firstHeading.textContent()).toMatch(/^Plan[:\s]/i)`. That
      // line pinned the MODEL's wording: the plan is live `model.chat` output, and
      // pass-1's plan led with “Implementation Plan: emu gate journey …”, which
      // says the same thing in the planner's own words.
      //
      // The document's contract changed with the plan template (c38956a): the
      // plan is ONE numbered plain-markdown list and a step is NEVER a heading
      // line, so a plan that carries no `#` line at all is the contract, not a
      // defect — and Actions run 41566844565's passes 5 and 6 red-passed on the
      // old "the document has a heading" line (fingerprint 07a4ef790e42d801):
      // the model wrote exactly the list the prompt asked for and the heading
      // locator waited out the whole timeout on a document that was correct.
      // What the PRODUCT controls now is that the numbered steps render as an
      // ordered list (not as `1.` paragraphs) and that the markup the author
      // wrote does not survive as ink — never a phrase, and never a heading
      // the contract no longer promises.
      const ordered = prose.locator('[data-testid="markdown-list-ordered"]');
      await expect(
        ordered.first(),
        "the markdown read: the plan's numbered steps render as an ordered list",
      ).toBeVisible();
      const firstStep = ordered.locator('[data-testid="markdown-list-item"]').first();
      await expect(firstStep, "the list carries a step").toBeVisible();
      const stepText = ((await firstStep.textContent()) ?? "").replace(/\s+/g, " ").trim();
      expect(stepText, "a step carries words").not.toBe("");
      // A marker that reaches the screen is an UNPARSED line: `##` kept its hashes,
      // `**bold**` its asterisks, `` `code` `` its backticks.
      for (const marker of ["#", "**", "`"]) {
        expect(stepText, `the step carries no raw ${marker} markup`).not.toContain(marker);
      }
      expect(
        await prose.evaluate((el) => (el.textContent ?? "").replace(/\s+/g, " ").trim().length),
        "the preview is a non-empty document",
      ).toBeGreaterThan(0);
      await expect(
        prose.locator(
          '[data-testid="markdown-paragraph"], [data-testid="markdown-list"], [data-testid="markdown-list-ordered"], [data-testid="markdown-code"]',
        ),
        "the markdown read: the document is structure, not one unbroken paragraph",
      ).not.toHaveCount(0);
      await expect(prose, "no API field in the document").not.toContainText("endpoint");
      // Pass-1 design review item 4 is the defect this line exists for: the
      // page printed the `model.chat` envelope with the plan escaped INSIDE
      // it, so the reader saw `\n` where the document's line breaks were.
      // The escape signature lives in the document's PROSE: CommonMark
      // renders a code span exactly as the author typed it, and a plan that
      // quotes `printf 'README.md\nhello.py\n…\n'` carries `\n` there as
      // SHELL, not as escaping. Pass-3 of Actions run 41542324484
      // (fingerprint 5b0127b528fd724f) reds on exactly that — its plan
      // numbered 1…6, rendered its code spans, and had no escape anywhere in
      // its prose. The rule, and the fixtures that hold both halves (a
      // quoted shell command passes; an escaped sentence does not), are in
      // `markdown-ink.ts` / `reflow-markdown-ink.spec.ts`.
      const documentProse = await prose.evaluate(collectDocumentProse);
      expect(escapedMarkdownFault(documentProse), "no escaped markdown in the document").toBe("");
      await expect(
        page.getByTestId("artifact-published-by"),
        "the byline is plain words",
      ).toContainText(/Published by the .*publish_plan.* step of run/i);
      await expect(page.getByTestId("artifact-published-by")).not.toContainText("artifact.publish");
      const raw = page.getByTestId("artifact-preview-raw");
      await expect(raw, "the stored payload starts hidden").toBeHidden();
      await page.getByTestId("artifact-raw-toggle").click();
      await expect(raw, "one click shows the stored payload").toBeVisible();
      await expect(raw).toContainText("endpoint");
      // The payload's long lines scroll inside their box at phone width instead of
      // pushing the page sideways off the screen.
      await page.setViewportSize({ width: 390, height: 844 });
      await expect
        .poll(async () =>
          page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
        )
        .toBeLessThanOrEqual(0);
      expect(
        await page.evaluate(() => {
          const box = document.querySelector('[data-testid="artifact-preview-raw"]');
          if (!(box instanceof HTMLElement)) return 9999;
          return box.getBoundingClientRect().right - document.documentElement.clientWidth;
        }),
      ).toBeLessThanOrEqual(0);
      await page.setViewportSize({ width: 1280, height: 900 });
      await emu.screen("artifact", "plan-md");
    });
  });
});
