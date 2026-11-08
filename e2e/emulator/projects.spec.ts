// Journey: the Projects Review screens — the project overview (badge
// project-1b), the repository page (badge repo-1e) and the cross-project
// thread list with nothing selected (badge threads-1g).
//
// The badges pair with docs/design/handoff-projects/png/<badge>.png, picked up
// by `designPngFor` on the file name — the same mechanism the Workflows Review
// screens use. Every screen goes through `emu.screen(badge, name)`, which
// captures 1280×900 AND 390×844 and proves zero page errors, zero undeclared
// ≥ 400 API reads and no sideways scroll (fixtures.ts); nothing here weakens
// those checks, and the one refusal this journey exercises (the missing
// project's 404) is DECLARED, exactly like the 1e not-found in
// empty-error.spec.ts: the `$`-anchored pattern says ONLY the project read
// itself may 404, so a page that fans out to `/repos` or `/runs` for an id the
// project read already refused is noise this pass must catch.
//
// Alice plays every screen: the lab's org admin (admin) holds no project
// membership (setup.spec.ts' header), and these three screens are all
// project-scoped.
//
// What the seeded lab gives this file, and what it must not depend on:
//   M4 Exit (slug `m4-exit`, docs/compatibility/probes/m4/seed.sh) is the
//   project — its `app` repository's remote is `file:///srv/m4/fixtures/app.git`,
//   so design 1e's OPEN ISSUES panel honestly refuses (issue triggers need a
//   GitHub repository) and the journey proves THAT line rather than a fabricated
//   issue list;
//   runs are not seeded. The pass's later files (repo-triggers,
//   run-gate-artifacts) are what start them, so whether M4 Exit has any run when
//   this file plays depends on the pass. The overview therefore asserts the
//   panel's honesty against the server's own answer (the two different nothings
//   `RunningNow` prints), instead of pretending a fresh lab has a busy project.
import { randomUUID } from "node:crypto";
import { expect, test, apiMutate } from "./fixtures.js";
import type { Page } from "@playwright/test";
import { EMU_ALICE_STATE, EMU_BASE_URL, EMU_PASS_ID } from "./env.js";

/** The pass's own empty project (a name no other journey takes: `empty-and-error`
 * owns `emu-proj-*`, `repo-triggers` owns `emu-gh-*`). */
const BARE_SLUG = `emu-bare-${EMU_PASS_ID}`.toLowerCase();
const BARE_NAME = `Emu bare ${EMU_PASS_ID}`;

/** GET /api/v1/projects → the id of the seeded m4-exit project. */
async function m4ExitId(page: Page): Promise<string> {
  const res = await page.request.get(`${EMU_BASE_URL}/api/v1/projects`);
  expect(res.status(), "the lab answers GET /api/v1/projects").toBe(200);
  const body = (await res.json()) as { items?: { id: string; slug: string }[] };
  const id = body.items?.find((p) => p.slug === "m4-exit")?.id ?? "";
  expect(id, "the seeded 'M4 Exit' project exists").toMatch(/^[0-9a-f-]{36}$/);
  return id;
}

/** The id of a project the pass created, read from the list the page reads. */
async function projectBySlug(page: Page, slug: string): Promise<string> {
  const items = await listJson(page, "projects");
  const id = String(items.find((item) => item.slug === slug)?.id ?? "");
  expect(id, `the pass's own project ${slug} is listed`).toMatch(/^[0-9a-f-]{36}$/);
  return id;
}

/** A project-scoped list read through the page's own session. */
async function listJson(page: Page, path: string): Promise<Record<string, unknown>[]> {
  const res = await page.request.get(`${EMU_BASE_URL}/api/v1/${path}`);
  expect(res.status(), `GET /api/v1/${path} answers`).toBe(200);
  const body = (await res.json()) as Record<string, Record<string, unknown>[]>;
  const key = Object.keys(body).find((k) => Array.isArray(body[k])) ?? "";
  return key === "" ? [] : body[key];
}

test.describe("projects (alice: 1b overview, tabs, empty and not-found)", () => {
  test.describe.configure({ mode: "serial", timeout: 10 * 60_000 });
  test.use({ storageState: EMU_ALICE_STATE });

  test("the overview, its three tabs, an empty project and a missing one", async ({
    page,
    emu,
  }) => {
    const projectId = await m4ExitId(page);

    await test.step("project-1b — the overview of the seeded project", async () => {
      await page.goto(`/p/${projectId}`);
      await expect(page.getByTestId("project-page"), "design 1b: the page renders").toBeVisible({
        timeout: 30_000,
      });
      await expect(
        page.getByTestId("project-header"),
        "design 1b: the header band carries the title, not the old section rail",
      ).toBeVisible();
      await expect(page.getByTestId("project-name")).toHaveText("M4 Exit");
      await expect(
        page.getByTestId("project-new-conversation"),
        "design 1b: the secondary verb is `New thread`",
      ).toHaveText("New thread");
      // Design 1b (project-tabs-2 review): `Start run` is the RUNS tab's ONE
      // door into the run form — the panel's own `New run` button was that verb
      // duplicated, so it is retired and this link now carries `?new=1`, the
      // state that opens `NewRunForm` above the list. The URL is the claim: a
      // reloaded `/runs` is the plain list, a reloaded `/runs?new=1` is the form.
      await expect(
        page.getByTestId("project-start-run"),
        "design 1b: the primary verb is `Start run`, and it opens the Runs tab's form",
      ).toHaveAttribute("href", `/p/${projectId}/runs?new=1`);
      await expect(
        page.getByTestId("project-attention"),
        "design 1b: what asks something of you leads the left column",
      ).toBeVisible();
      await expect(
        page.getByTestId("repo-list"),
        "design 1b: the repositories sit in the right-hand inventory column",
      ).toBeVisible();
      // Runs: the panel prints one of TWO different nothings, and which one is
      // honest depends on the server, not on the design — a project that has
      // never run, versus one whose runs have all finished. This pass's later
      // files start the runs, so both answers are correct at this point.
      const runs = await listJson(page, `projects/${projectId}/runs`);
      if (runs.length === 0) {
        await expect(
          page.getByTestId("recent-runs-empty"),
          "design 1b: a project that has never run says so, without a fake row",
        ).toContainText(/never started a workflow/i);
      } else {
        const panel = page.locator("#running-now");
        await expect(panel, "design 1b: RUNNING NOW is its own panel").toBeVisible();
        await expect(
          panel,
          "design 1b: a project WITH runs never claims it has never started one",
        ).not.toContainText(/never started a workflow/i);
      }
      await emu.screen("project-1b", "overview");
    });

    // The tabs are ROUTES (design 1b): one click, one navigation, and the URL
    // stays the honest answer to "where am I". Each tab is opened FROM the
    // overview, because only the overview and the members page carry the band.
    for (const [tab, route, landing, surface] of [
      ["runs", "/runs", "project-runs", "runs-list"],
      ["threads", "/threads", "project-conversations", "threads-search"],
      ["workflows", "/workflows", "project-pipelines", "project-workflows"],
    ] as const) {
      await test.step(`project-1b — the ${tab} tab opens ${route}`, async () => {
        await page.goto(`/p/${projectId}`);
        const link = page.getByTestId(`project-tab-${tab}`);
        await expect(link).toBeVisible({ timeout: 30_000 });
        await expect(link).toHaveAttribute("href", `/p/${projectId}${route}`);
        await link.click();
        await page.waitForURL(new RegExp(`/p/${projectId}${route}$`), { timeout: 30_000 });
        await expect(
          page.getByTestId(landing),
          `design 1b: the ${tab} tab lands on its own route, not a fragment of the overview`,
        ).toBeVisible({ timeout: 30_000 });
        // The tab's own body, not just its frame: the Runs tab is the runs list,
        // the Threads tab is the shared 1g pane (its card list is retired), and
        // the Workflows tab is the ONE panel of 2e rows (its LIBRARY list is
        // retired). A tab that navigated to an empty frame would pass the
        // landing assertion and fail this one.
        // Exact id, not the substring Playwright's getByTestId would match:
        // `project-workflows` must be the panel itself, not its row list or its
        // empty line.
        await expect(
          page.locator(`[data-testid="${surface}"]`).first(),
          `design 1b: the ${tab} tab mounts its own body (${surface})`,
        ).toBeVisible({ timeout: 30_000 });
        if (tab === "workflows") {
          // The tab is ONE panel of 2e-shaped rows (project-workflows-tab): it
          // names itself, it offers the library picker as its only way in, and
          // the legacy panels the pass review removed do NOT come back — the
          // library list's own heading is the one that would return.
          await expect(
            page.locator("#project-workflows-page-heading"),
            "design 1b: the panel is WORKFLOWS IN THIS PROJECT",
          ).toContainText(/WORKFLOWS IN THIS PROJECT/i);
          await expect(
            page.getByTestId("project-workflow-library"),
            "design 1b: `+ use a library workflow` is the maintainer's one way in",
          ).toBeVisible();
          await expect(
            page.getByRole("heading", { name: /^LIBRARY$/i }),
            "design 1b: the retired LIBRARY list is not on this tab",
          ).toHaveCount(0);
        }
        if (tab === "threads") {
          // The tab IS the 1g pane: search + the three chips, and NO origin
          // badges (they belong to the retired card list; the thread page's own
          // PART OF panel is where a run link is said).
          await expect(
            page.getByTestId("threads-filter-runs"),
            "design 1g: the tab carries the `from runs` chip",
          ).toBeVisible();
          await expect(
            page.locator('[data-testid^="conversation-origin-"]'),
            "design 1g: origin badges are not drawn on this page",
          ).toHaveCount(0);
        }
        // The screen is captured as the design draws it — the plain tab — before
        // anything opens over it.
        await emu.screen("project-1b", tab);
        if (tab === "runs") {
          // The one door, walked: the band's verb lands here with `?new=1` and
          // the run form stands above the list (design 1b, project-tabs-2 — the
          // panel's own `New run` button was this verb duplicated).
          await page.getByTestId("project-start-run").click();
          await expect(page).toHaveURL(new RegExp(`/p/${projectId}/runs[?]new=1$`));
          await expect(
            page.getByTestId("new-run-form"),
            "design 1b: `Start run` is the Runs tab's only way into the form",
          ).toBeVisible({ timeout: 30_000 });
          await expect(
            page.getByTestId("runs-list"),
            "design 1b: the form opens ABOVE the list, not instead of it",
          ).toBeVisible();
        }
      });
    }

    await test.step("project-1b — the empty state (a pass project with nothing in it)", async () => {
      // A colliding slug is an inline form error, not a harness defect.
      emu.expectFailure(/\/api\/v1\/projects$/, 409);
      const created = await apiMutate(page, "POST", `${EMU_BASE_URL}/api/v1/projects`, {
        name: BARE_NAME,
        slug: BARE_SLUG,
        description: "emulator 1b empty-state project — no runs, no workflows",
      });
      const body = await created.text();
      expect(
        created.status(),
        `the pass-stamped empty project is created (got ${created.status()}: ${body.slice(0, 240)})`,
      ).toBe(201);
      const bareId = ((await created.json()) as { id: string }).id;
      expect(bareId, "the new project has an id").toMatch(/^[0-9a-f-]{36}$/);

      await page.goto(`/p/${bareId}`);
      await expect(page.getByTestId("project-page")).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId("project-name")).toHaveText(BARE_NAME);
      await expect(
        page.getByTestId("project-attention-empty"),
        "design 1b: nothing needs attention is said, not drawn as an empty callout",
      ).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId("recent-runs-empty"), "design 1b: no runs yet").toContainText(
        /no runs yet/i,
      );
      await expect(
        page.getByTestId("project-threads-empty"),
        "design 1b: no threads yet",
      ).toContainText(/no threads in this project yet/i);
      await expect(
        page.getByTestId("repo-list-empty"),
        "design 1b: no repositories yet",
      ).toContainText(/no repositories yet/i);
      await expect(
        page.getByTestId("project-workflows-empty"),
        "design 1b: no workflows assigned yet",
      ).toContainText(/no workflows are used in this project yet/i);
      await emu.screen("project-1b", "empty");
    });

    await test.step("project-1b — the empty project's Workflows tab is ONE panel", async () => {
      // Design 1b (project-workflows-tab pass review): the tab used to gather a
      // LIBRARY list, an inline assign shelf, a YAML dump and a definition graph
      // around the project's own rows. All of that has its own surface now; what
      // is left is ONE panel of 2e-shaped rows, whose honest absence is this
      // project's line — not a list of everything the org has.
      const empty = await projectBySlug(page, BARE_SLUG);
      await page.goto(`/p/${empty}/workflows`);
      await expect(
        page.getByTestId("project-pipelines"),
        "design 1b: the Workflows tab renders for a project with nothing in it",
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        page.locator("#project-workflows-page-heading"),
        "design 1b: the one panel names itself WORKFLOWS IN THIS PROJECT",
      ).toContainText(/WORKFLOWS IN THIS PROJECT/i);
      await expect(
        page.locator('[data-testid="project-workflows-empty"]'),
        "design 1b: the absence is the panel's own honest line",
      ).toContainText(/no workflows are used in this project yet/i);
      await expect(
        page.locator('[data-testid="project-workflows"]'),
        "design 1b: the tab is ONE panel, not a library table plus rows",
      ).toHaveCount(1);
      await expect(
        page.getByRole("heading", { name: /^LIBRARY$/i }),
        "design 1b: the retired LIBRARY list did not come back on this tab",
      ).toHaveCount(0);
    });

    await test.step("project-1b — a project the reader cannot open", async () => {
      const missing = randomUUID();
      // Only the project read may 404 (`$`-anchored): `GET /projects/{id}` hides
      // existence with a 404 (ADR-0014 § 3), and the page must stop at that one
      // sentence rather than fanning out to sub-resources of an id it knows
      // nothing about. Any other 404 on this screen is undeclared noise.
      emu.expectFailure(/\/api\/v1\/projects\/[0-9a-f-]{36}$/, 404);
      await page.goto(`/p/${missing}`);
      const refusal = page.getByTestId("project-not-found");
      await expect(
        refusal,
        "design 1b: a random-UUID project reads the same one sentence every screen under it gives",
      ).toBeVisible({ timeout: 30_000 });
      await expect(refusal).toHaveText("Project not found or you do not have access");
      // Pass-1 review, item 5: the H1 NAMES what was missing (`Project not
      // found`, not the generic `Project`) and the way back is a BUTTON beside
      // the sentence, not only the mono breadcrumb above it.
      await expect(
        page.getByRole("heading", { level: 1, name: "Project not found" }),
        "design 1b: the refusal's H1 names the project that is not there",
      ).toBeVisible({ timeout: 30_000 });
      const backToProjects = page.getByTestId("project-page-back-to-projects-action");
      await expect(
        backToProjects,
        "design 1b: `← Projects` is an act beside the message",
      ).toHaveText("← Projects");
      await expect(backToProjects).toHaveAttribute("href", "/projects");
      await expect(
        page.getByTestId("project-tabs"),
        "the refusal mounts no shell around a project the reader cannot open",
      ).toHaveCount(0);
      // The refusal is a page, not a strip of text welded to the sidebar: on
      // this full-bleed route the shell hands the column over unpadded, so the
      // branch carries the header band's padding itself (the loop's 2026-10-27
      // report saw this line at x=240, y=0). Handoff 2c/3c narrowed the column
      // to 220px, so the padded start is the band's own 28px past that.
      const box = await refusal.boundingBox();
      expect(box, "the not-found line is laid out").not.toBeNull();
      expect(
        (box?.x ?? 0) > 240 && (box?.y ?? 0) > 0,
        `the not-found page is padded off the sidebar (got x=${box?.x}, y=${box?.y}; ` +
          "the sidebar ends at x=220, so a padded page starts past 240)",
      ).toBe(true);
      await emu.screen("project-1b", "not-found");
    });
  });
});

test.describe("projects (alice: repo-1e the repository page)", () => {
  test.describe.configure({ mode: "serial", timeout: 8 * 60_000 });
  test.use({ storageState: EMU_ALICE_STATE });

  test("the repo page of the lab's repository, and a repository that is not there", async ({
    page,
    emu,
  }) => {
    const projectId = await m4ExitId(page);

    await test.step("repo-1e — chat box, workflows on this repo, issues, activity, runs", async () => {
      await page.goto(`/p/${projectId}/app`);
      await expect(
        page.getByTestId("repo-page"),
        "design 1e: the repository page renders",
      ).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId("repo-name")).toHaveText("app");
      await expect(
        page.getByTestId("repo-breadcrumb"),
        "design 1e: the breadcrumb says which project this repository is in",
      ).toContainText("M4 Exit");
      await expect(
        page.getByTestId("repo-default-branch"),
        "design 1e: the mono line carries the default branch",
      ).toHaveText("main");
      await expect(
        page.getByTestId("repo-chat-box"),
        "design 3a: the header's `New thread here`/`Start run` pair retired into the chat box — the page's one line to start work",
      ).toBeVisible();
      await expect(
        page.getByTestId("repo-chat-start"),
        "design 3a: `Start` in the chat box is the page's chat-starting verb (repo-chat-start)",
      ).toBeVisible();
      await expect(
        page.getByTestId("repo-chat-input"),
        "design 3a: the chat line names the repository in its placeholder",
      ).toHaveAttribute("placeholder", /^Thread in app…/);

      await expect(
        page.getByTestId("repo-workflows"),
        "design 3a: the WORKFLOWS panel leads the side column",
      ).toBeVisible({ timeout: 30_000 });
      const pins = await listJson(page, `projects/${projectId}/assignments`);
      if (pins.length > 0) {
        // ADR-0060: a project-wide pin covers every repository of the project,
        // so the seeded assignment must show on this repository's panel.
        await expect(
          page.getByTestId("repo-workflows-list"),
          "design 1e: the workflows this repository uses are listed",
        ).toBeVisible();
        await expect(
          page.getByTestId("repo-workflow-library"),
          "design 1e: the panel header offers `+ use a library workflow`",
        ).toBeVisible();
      } else {
        await expect(
          page.getByTestId("repo-workflows-empty"),
          "design 2e: a repository using no workflow says so honestly",
        ).toContainText(/uses no workflow yet/i);
      }

      await expect(
        page.getByTestId("repo-issues"),
        "design 3a: OPEN ISSUES sits under WORKFLOWS in the side column",
      ).toBeVisible();
      // The lab's `app` remote is `file:///srv/m4/fixtures/app.git`. There is no
      // issue list to show, and the honest line is the EXPECTED state — design
      // 1e's issue arm belongs to a GitHub repository, not to this fixture.
      await expect(
        page.getByTestId("repo-issues-not-github"),
        "design 1e: a non-GitHub remote says plainly that issue triggers need a GitHub repository " +
          "(never a fabricated issue list — AGENTS.md honesty)",
      ).toContainText(/need a GitHub repository/i);

      await expect(
        page.getByTestId("repo-activity"),
        "design 3a: the activity feed (runs and chats mixed) replaced WORK IN THIS REPO — workspace info moved to the chat/run panels",
      ).toBeVisible();
      await expect(
        page.getByTestId("repo-runs"),
        "design 3a: the feed's runs panel is the successor of RECENT RUNS",
      ).toBeVisible();
      const runs = await listJson(page, `projects/${projectId}/runs`);
      if (runs.length === 0) {
        await expect(
          page.getByTestId("repo-runs-empty"),
          "design 3a: a repository with no runs or threads yet says so in words",
        ).toContainText(/no runs or threads in .* yet/i);
      }
      await emu.screen("repo-1e", "repo");
    });

    await test.step("repo-1e — a repository the project does not have", async () => {
      // No 404 is declared here on purpose: the repository list is the page's
      // own read and it answers 200, so the not-found is a client-side absence.
      // A 404 from this route would mean the page invented a repository id and
      // went looking for it.
      await page.goto(`/p/${projectId}/no-such-repo`);
      const refusal = page.getByTestId("repo-not-found");
      await expect(
        refusal,
        "design 1e: a missing repository gets the same one-sentence refusal",
      ).toBeVisible({ timeout: 30_000 });
      await expect(refusal).toHaveText("Repository not found or you do not have access");
      // Pass-1 review, item 5: same two fixes on the repository's refusal —
      // the H1 names what was missing, and the project it belongs to is a
      // button (the project read DID answer, so the button can name it).
      await expect(
        page.getByRole("heading", { level: 1, name: "Repository not found" }),
        "design 1e: the refusal's H1 names the repository that is not there",
      ).toBeVisible({ timeout: 30_000 });
      const backToProject = page.getByTestId("repo-back-to-project");
      await expect(backToProject, "design 1e: the way back is the project's own name").toHaveText(
        /^← /,
      );
      await expect(backToProject).toHaveAttribute("href", new RegExp(`^/p/${projectId}$`));
      await expect(
        page.getByTestId("repo-workflows"),
        "the refusal mounts no repository panels around a repository that is not there",
      ).toHaveCount(0);
      // Not a full-bleed route: the shell's own column pads it. Handoff 2c/3c
      // narrowed the column to 220px (and the page is capped and centred), so
      // a padded start clears 236.
      const box = await refusal.boundingBox();
      expect(box, "the missing-repository line is laid out").not.toBeNull();
      expect(
        (box?.x ?? 0) > 236 && (box?.y ?? 0) > 0,
        `the missing-repository page is padded off the sidebar (got x=${box?.x}, y=${box?.y}; ` +
          "the sidebar ends at x=220, so a padded page starts past 236)",
      ).toBe(true);
      await emu.screen("repo-1e", "not-found");
    });
  });
});

test.describe("projects (alice: threads-1g the list with nothing selected)", () => {
  test.describe.configure({ mode: "serial", timeout: 5 * 60_000 });
  test.use({ storageState: EMU_ALICE_STATE });

  test("the /threads list, with no thread open", async ({ page, emu }) => {
    await test.step("threads-1g — the list pane and its empty right column", async () => {
      await page.goto("/threads");
      await expect(
        page.getByTestId("threads-page"),
        "design 1g: the thread list pane renders",
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        page.getByTestId("threads-new-open"),
        "design 1g: `New thread` is the pane's primary action",
      ).toBeVisible();
      // Nothing selected: the thread column says so instead of showing a
      // placeholder transcript (design 1g pairs the list with an OPEN thread).
      await expect(
        page.getByTestId("threads-no-selection"),
        "design 1g: with no thread chosen the right column says 'No thread selected'",
      ).toBeVisible({ timeout: 30_000 });
      await emu.screen("threads-1g", "list");
    });
  });
});
