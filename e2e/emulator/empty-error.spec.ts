// Journey: the honest empty and error states (design 1b, 2a, 2e; plus the
// workflow-page 404).
//
//   1b — a no-match search on /workflows says so plainly, no fake rows.
//   2e — a repository that uses no workflow shows the
//        `+ use a library workflow` call to action. Project-wide pins
//        (ADR-0060) cover every repo of a project, so alice creates a
//        pass-stamped project + repo via the API to stand on; both are
//        pass-stamped, so passes never collide, and — like pass-stamped
//        workflows — they are left behind rather than deleted.
//   1e — loading a workflow page for a random UUID shows an honest
//        not-found state; the 404 the page provokes is declared via
//        emu.expectFailure so it is not counted as a defect.
//
// 2a's empty state is covered in workflow-lifecycle.spec.ts.
import { randomUUID } from "node:crypto";
import { expect, test, apiMutate } from "./fixtures.js";
import { EMU_ALICE_STATE, EMU_ADMIN_STATE, EMU_BASE_URL, EMU_PASS_ID } from "./env.js";

const EMPTY_REPO = `emu-empty-${EMU_PASS_ID}`;
const EMPTY_PROJECT_SLUG = `emu-proj-${EMU_PASS_ID}`.toLowerCase();

test.describe("empty-and-error (alice: 2e)", () => {
  test.describe.configure({ mode: "serial", timeout: 5 * 60_000 });
  test.use({ storageState: EMU_ALICE_STATE });

  test("a repo that uses no workflow says so and offers the library", async ({ page, emu }) => {
    let projectId = "";
    await test.step("create a pass-stamped project + repo that use nothing", async () => {
      // A project-wide pin covers every repo of its project (ADR-0060), so
      // the empty 2e state needs a project of its own. A collision is
      // declared — it is an inline form error, not a harness defect.
      emu.expectFailure(/\/api\/v1\/projects$/, 409);
      emu.expectFailure(/\/api\/v1\/projects$/, 422);
      const project = await apiMutate(page, "POST", `${EMU_BASE_URL}/api/v1/projects`, {
        name: `Emu proj ${EMU_PASS_ID}`,
        slug: EMPTY_PROJECT_SLUG,
        description: "emulator empty-state journey scratch project",
      });
      const projectBody = await project.text();
      expect(
        project.status(),
        `creating the pass-stamped project answers 201 (got ${project.status()}: ${projectBody.slice(0, 300)})`,
      ).toBe(201);
      projectId = ((await project.json()) as { id: string }).id;
      expect(projectId, "the new project has an id").toMatch(/^[0-9a-f-]{36}$/);
      emu.expectFailure(new RegExp(`/api/v1/projects/${projectId}/repos$`), 409);
      emu.expectFailure(new RegExp(`/api/v1/projects/${projectId}/repos$`), 422);
      const created = await apiMutate(
        page,
        "POST",
        `${EMU_BASE_URL}/api/v1/projects/${projectId}/repos`,
        {
          name: EMPTY_REPO,
          git_url: "file:///srv/m4/fixtures/app.git",
          default_branch: "main",
        },
      );
      expect(
        created.status(),
        "creating the pass-stamped empty repo answers 201",
      ).toBe(201);
    });

    await test.step("2e — the empty workflow panel with its call to action", async () => {
      await page.goto(`/p/${projectId}/${EMPTY_REPO}`);
      await expect(
        page.getByTestId("repo-page"),
        "design 2e: the repository page renders",
      ).toBeVisible({ timeout: 30_000 });
      const empty = page.getByTestId("repo-workflows-empty");
      await expect(
        empty,
        "design 2e: a repo using no workflow states it honestly",
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        empty,
        "design 2e: the empty line reads 'uses no workflow yet'",
      ).toContainText(/uses no workflow yet/i);
      await expect(
        page.getByTestId("repo-workflow-library"),
        "design 2e: the panel offers `+ use a library workflow`",
      ).toBeVisible();
      await emu.screen("2e", "repo-empty");
    });
  });
});

test.describe("empty-and-error (admin: 1b no-match, 1e not-found)", () => {
  test.describe.configure({ mode: "serial", timeout: 5 * 60_000 });
  test.use({ storageState: EMU_ADMIN_STATE });

  test("no-match search and a random-UUID workflow page", async ({ page, emu }) => {
    await test.step("1b — a search nothing matches", async () => {
      await page.goto("/workflows");
      await expect(page.getByTestId("workflows-search")).toBeVisible({ timeout: 30_000 });
      await page.getByTestId("workflows-search").fill(`zzz no such workflow ${EMU_PASS_ID}`);
      const empty = page.getByTestId("workflows-empty");
      await expect(
        empty,
        "design 1b: a no-match search shows an honest empty line",
      ).toBeVisible({ timeout: 15_000 });
      await expect(
        empty,
        "design 1b: the empty line reads 'No workflow matches the current filter'",
      ).toContainText(/no workflow matches/i);
      await emu.screen("1b", "no-match");
    });

    await test.step("1e — a workflow page for a random UUID", async () => {
      const missing = randomUUID();
      // The 404 the page provokes is the journey exercising an inline error
      // state — declared, not a defect. The `$` says ONLY the pipeline read
      // itself may 404: the page must not fan out to `/revisions` or
      // `/drafts` for an id the pipeline read already refused, and any such
      // extra 404 is real noise the pass must catch.
      emu.expectFailure(/\/api\/v1\/pipelines\/[0-9a-f-]{36}$/, 404);
      await page.goto(`/workflows/${missing}`);
      const banner = page.getByTestId("pipeline-page-failure");
      const bannerShown = await banner
        .waitFor({ state: "visible", timeout: 30_000 })
        .then(() => true)
        .catch(() => false);
      if (!bannerShown) {
        const text = ((await page.getByTestId("pipeline-page").textContent().catch(() => "")) ?? "")
          .replace(/\s+/g, " ")
          .slice(0, 160);
        expect(
          false,
          "design 1e: a workflow page for a missing id must show an honest not-found state " +
            `(a page-level failure banner, e.g. pipeline-page-failure); the page instead rendered the id as a title: ${JSON.stringify(text)}`,
        ).toBe(true);
      }
      const text = (await banner.textContent()) ?? "";
      expect(
        /couldn|could not|not be|not found|no such|missing|404|unknown|gone/i.test(text),
        `design 1e: the not-found state says so honestly (banner read: ${JSON.stringify(text)})`,
      ).toBe(true);
      await emu.screen("1e", "not-found");
    });
  });
});
