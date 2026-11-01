// Journey: the SERVER-ERROR state of every reviewed screen (design 1b, 1c,
// 1e, 1g, 2a, 2c, 2d, 2e; Projects Review project-1b, repo-1e, threads-1g).
//
// The loop already proves the empty and not-found states (empty-error.spec.ts,
// projects.spec.ts); this file proves what happens when a screen's PRIMARY
// read FAILS outright: `page.route` answers the one GET the page cannot
// render without with `500 application/problem+json`
// (`{"type":"about:blank","title":"Internal Server Error","status":500,
//   "detail":"emulated failure"}`), the failure is DECLARED through
// `emu.expectFailure(re, 500)` (react-query retries 5xx twice — every
// response is declared, none is harness noise), and the screen must answer
// with an honest error state: a ProblemBanner/alert quoting the server's own
// problem title — never a blank page, never a spinner forever, never fake
// rows. Screens that fail that bar are real product defects; today every
// reviewed screen already carries an error branch (asserted per screen
// below), so nothing here weakens the fixture's pageerror/sidescroll/undeclared-API
// checks and nothing renders invented data.
//
// The primary read of each screen, as the page source states it:
//   1b /workflows                GET /api/v1/pipelines           (usePipelines)
//   1c New workflow dialog       GET /api/v1/pipelines           (the dialog stands on the index read)
//   1e /workflows/{id}           GET /api/v1/pipelines/{id}      (usePipeline — a random uuid works: the route answers, the server never sees it)
//   1g Studio (draft)            GET /api/v1/drafts/{draftId}    (useDraft)
//   2a Used in tab               GET /api/v1/projects/{id}/assignments (useUsedIn's fan)
//   2c trigger dialog            GET /api/v1/revisions/{uuid}    (TriggerDialog's pinned-revision read — the uuid-keyed one, not the row's digest read)
//   2d YAML tab                  GET /api/v1/revisions/…         (useRevision + the regenerated document)
//   2e repo page (workflows)     GET /api/v1/projects/{id}/assignments (RepoWorkflows' panel read)
//   project-1b /p/{id}           GET /api/v1/projects/{id}       (useProject)
//   repo-1e /p/{id}/{repo}       GET /api/v1/projects/{id}/repos (the page finds the repo in this list)
//   threads-1g /threads          GET /api/v1/conversations       (useThreadList)
//
// Scratch: the 1g/2a/2c/2d screens need a real workflow (1g a real draft, 2c
// a real pin) for the failing read to be about. The pass creates ONE
// pass-stamped workflow — `Emu srvfail <passId>` — drafted, validated and
// published over the API through admin's session, and alice pins it to M4
// Exit / app for 2c. Like every other pass-stamped scratch it is left behind,
// it starts no runs and creates no triggers; nothing shared is mutated
// otherwise.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, apiMutate } from "./fixtures.js";
import type { Emu } from "./fixtures.js";
import type { Page, Route } from "@playwright/test";
import {
  EMU_ADMIN_STATE,
  EMU_ALICE_STATE,
  EMU_BASE_URL,
  EMU_PASS_ID,
  EMU_REPO_ROOT,
} from "./env.js";

/** The problem+json every failed read answers — the spec's exact body. */
const SERVER_PROBLEM = {
  type: "about:blank",
  title: "Internal Server Error",
  status: 500,
  detail: "emulated failure",
};

/** The banner the screens must show: the server's own words, quoted. */
const PROBLEM_LINE = /Internal Server Error: emulated failure/i;

const SCRATCH_SLUG = `emu-srvfail-${EMU_PASS_ID}-${randomUUID().slice(0, 8)}`.toLowerCase();
const SCRATCH_NAME = `Emu srvfail ${EMU_PASS_ID}`;

/** The plan-with-approval template verbatim from the UI's own starter file —
 * the document the emulator's create-from-template journeys seed, with its
 * metadata name rewritten to this pass's unique slug (the slug is what makes
 * the revision digest this scratch's own; publish gate 4 refuses a digest the
 * org already carries). */
function scratchYaml(slug: string): string {
  const template = readFileSync(
    path.join(
      EMU_REPO_ROOT,
      "ui",
      "src",
      "lib",
      "pipeline",
      "templates",
      "plan-with-approval.yaml.txt",
    ),
    "utf8",
  );
  const rewritten = template.replace(/^(\s*name:\s*)plan-with-approval\s*$/m, `$1${slug}`);
  expect(rewritten, `the template carries its metadata name to rewrite (slug ${slug})`).not.toBe(
    template,
  );
  return rewritten;
}

interface Scratch {
  pipelineId: string;
  draftId: string;
  revisionId: string;
}

/** Created once per pass by admin (the library role); the module cache is
 * safe because the suite runs one worker, serially, over this file. */
let scratch: Scratch | null = null;

/** The pass's published scratch workflow — pipeline + draft + revision. */
async function ensureScratchPublished(page: Page): Promise<Scratch> {
  if (scratch) return scratch;
  const pipeline = await apiMutate(page, "POST", `${EMU_BASE_URL}/api/v1/pipelines`, {
    slug: SCRATCH_SLUG,
    display_name: SCRATCH_NAME,
    description: "emulator server-error journey scratch workflow",
  });
  const pipelineBody = await pipeline.text();
  expect(
    pipeline.status(),
    `creating the scratch workflow answers 201 (got ${pipeline.status()}: ${pipelineBody.slice(0, 240)})`,
  ).toBe(201);
  const pipelineId = (JSON.parse(pipelineBody) as { id: string }).id;
  expect(pipelineId, "the scratch workflow has an id").toMatch(/^[0-9a-f-]{36}$/);
  const draft = await apiMutate(
    page,
    "POST",
    `${EMU_BASE_URL}/api/v1/pipelines/${pipelineId}/drafts`,
    {
      document_yaml: scratchYaml(SCRATCH_SLUG),
    },
  );
  const draftBody = await draft.text();
  expect(
    draft.status(),
    `seeding the scratch draft answers 201 (got ${draft.status()}: ${draftBody.slice(0, 240)})`,
  ).toBe(201);
  const draftJson = JSON.parse(draftBody) as { id: string; version: number };
  const validated = await apiMutate(
    page,
    "POST",
    `${EMU_BASE_URL}/api/v1/drafts/${draftJson.id}/validate`,
  );
  const validBody = await validated.text();
  expect(
    (JSON.parse(validBody) as { valid?: boolean }).valid,
    `the scratch draft validates (${validBody.slice(0, 300)})`,
  ).toBe(true);
  const published = await apiMutate(
    page,
    "POST",
    `${EMU_BASE_URL}/api/v1/drafts/${draftJson.id}/publish`,
    {
      version: draftJson.version,
    },
  );
  const publishedBody = await published.text();
  expect(
    published.status(),
    `publishing the scratch draft succeeds (got ${published.status()}: ${publishedBody.slice(0, 300)})`,
  ).toBeLessThan(300);
  const revisionId = (JSON.parse(publishedBody) as { id: string }).id;
  expect(revisionId, "the publish answers with the revision").toMatch(/^[0-9a-f-]{36}$/);
  scratch = { pipelineId, draftId: draftJson.id, revisionId };
  return scratch;
}

/**
 * Fail one read with 500 problem+json: declare it (the fixture must not
 * count it — or the browser's own console error for it — as a defect) and
 * route it. Only GETs whose PATHNAME matches are answered; the same path
 * reached by another method (a POST /pipelines, say) continues to the lab.
 */
function armServerFailure(page: Page, emu: Emu, re: RegExp): void {
  emu.expectFailure(re, 500);
  void page.route(re, (route: Route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (request.method() !== "GET" || !re.test(pathname)) {
      void route.continue();
      return;
    }
    void route.fulfill({
      status: 500,
      contentType: "application/problem+json",
      body: JSON.stringify(SERVER_PROBLEM),
    });
  });
}

/** The 5xx spinner's text (the Spinner component renders `· label…`). */
function expectNoSpinner(page: Page, label: string): Promise<unknown> {
  return expect(
    page.getByText(label, { exact: false }),
    `the 'Loading ${label.replace(/^Loading /, "")}' state gave up — a failed read never spins forever`,
  ).toHaveCount(0);
}

/** GET /api/v1/projects → the id of the seeded m4-exit project (the pattern
 * from projects.spec.ts — every project-scoped screen stands on it). */
async function m4ExitId(page: Page): Promise<string> {
  const res = await page.request.get(`${EMU_BASE_URL}/api/v1/projects`);
  expect(res.status(), "the lab answers GET /api/v1/projects").toBe(200);
  const body = (await res.json()) as { items?: { id: string; slug: string }[] };
  const id = body.items?.find((p) => p.slug === "m4-exit")?.id ?? "";
  expect(id, "the seeded 'M4 Exit' project exists").toMatch(/^[0-9a-f-]{36}$/);
  return id;
}

/* ------------------------------------------------------------------ admin */

test.describe("server-error (admin: the scratch workflow)", () => {
  test.describe.configure({ mode: "serial", timeout: 5 * 60_000 });
  test.use({ storageState: EMU_ADMIN_STATE });

  test("create + publish the pass-stamped scratch workflow", async ({ page }) => {
    const made = await ensureScratchPublished(page);
    expect(made.pipelineId, "the scratch workflow exists").toMatch(/^[0-9a-f-]{36}$/);
  });
});

test.describe("server-error (admin: 1b, 1c, 1e, 1g, 2d)", () => {
  test.describe.configure({ mode: "serial", timeout: 5 * 60_000 });
  test.use({ storageState: EMU_ADMIN_STATE });

  test("1b — the workflows index when the library read fails", async ({ page, emu }) => {
    armServerFailure(page, emu, /\/api\/v1\/pipelines$/);
    await page.goto("/workflows");
    await expect(page.getByTestId("library-page"), "design 1b: the page frame renders").toBeVisible(
      {
        timeout: 30_000,
      },
    );
    await expect(
      page.getByRole("alert").filter({ hasText: PROBLEM_LINE }).first(),
      "design 1b: a failed library read is a ProblemBanner quoting the server's problem, not a blank list",
    ).toBeVisible({ timeout: 30_000 });
    // The shared load-failure block (2026-10-30 copy review): the page's own
    // sentence leads and the server's problem document sits under it as muted
    // evidence — so the problem IS still quoted (asserted above), but it is no
    // longer the headline and the bar no longer borrows the run-status word.
    await expect(
      page.getByTestId("workflows-load-error"),
      "design 1b: the banner leads with `Couldn't load the workflow library.`",
    ).toContainText("Couldn't load the workflow library.", { timeout: 30_000 });
    await expect(
      page.getByTestId("workflows-list"),
      "design 1b: no list is invented over a failed read",
    ).toHaveCount(0);
    await expect(
      page.getByTestId("workflows-empty"),
      "design 1b: a failed read is never dressed as the empty state",
    ).toHaveCount(0);
    await expectNoSpinner(page, "Loading the workflow library");
    await emu.screen("1b", "server-error");
  });

  test("1c — the New workflow dialog with the index read failed", async ({ page, emu }) => {
    armServerFailure(page, emu, /\/api\/v1\/pipelines$/);
    await page.goto("/workflows");
    const banner = page.getByRole("alert").filter({ hasText: PROBLEM_LINE }).first();
    await expect(
      banner,
      "design 1c: with the dialog still closed the index states the failure",
    ).toBeVisible({
      timeout: 30_000,
    });
    // The dialog is the same page's own surface, and it is the one thing the
    // author is looking at: the list read's failure moves INSIDE it (a banner
    // behind the overlay is a failure nobody can read), and the page's own
    // banner steps aside rather than repeating it (design 1c review).
    await page.getByTestId("workflows-new-workflow").click({ timeout: 15_000 });
    const dialog = page.getByTestId("new-workflow-dialog");
    await expect(dialog, "design 1c: the dialog renders").toBeVisible();
    await expect(
      dialog.getByTestId("new-workflow-list-failure"),
      "design 1c: the list read's failure renders INSIDE the open dialog, not behind it",
    ).toBeVisible();
    await expect(dialog.getByTestId("new-workflow-list-failure")).toContainText(PROBLEM_LINE);
    await expect(
      page.getByRole("alert").filter({ hasText: PROBLEM_LINE }),
      "design 1c: exactly one failure is on screen, and it is the dialog's — the page does " +
        "not leave a second banner behind the overlay",
    ).toHaveCount(1);
    await expect(
      page.getByTestId("workflows-list"),
      "design 1c: still no invented rows",
    ).toHaveCount(0);
    await emu.screen("1c", "server-error");
  });

  test("1e — the workflow page when its pipeline read fails", async ({ page, emu }) => {
    // A random uuid: the browser never learns the id is not there — the
    // route answers 500 before the request reaches the lab, which is exactly
    // what the screen must be honest about.
    const doomed = randomUUID();
    armServerFailure(page, emu, new RegExp(`/api/v1/pipelines/${doomed}$`));
    await page.goto(`/workflows/${doomed}`);
    await expect(
      page.getByTestId("pipeline-page-failure"),
      "design 1e: the failed read lands on the page-level failure banner",
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("pipeline-page-failure")).toContainText(PROBLEM_LINE);
    // The shared block: a plain `Couldn't load <what the page read>` heading
    // with the server's problem as the muted evidence quoted just above, then
    // Retry and the way back — `FAILED` is a run's status word, not this
    // page's story (2026-10-30 copy review).
    await expect(
      page.getByTestId("pipeline-page-failure"),
      "design 1e: the failure says `Couldn't load the workflow.` in its own words",
    ).toContainText("Couldn't load the workflow.");
    await expect(
      page.getByTestId("workflow-load-retry"),
      "design 1e: a server error (unlike a 404) offers the way back — Retry",
    ).toBeVisible();
    await expectNoSpinner(page, "Loading workflow");
    await emu.screen("1e", "server-error");
  });

  test("1g — the Studio when the draft read fails", async ({ page, emu }) => {
    const made = await ensureScratchPublished(page);
    armServerFailure(page, emu, new RegExp(`/api/v1/drafts/${made.draftId}$`));
    await page.goto(`/workflows/${made.pipelineId}/drafts/${made.draftId}`);
    await expect(
      page.getByTestId("studio-draft-error"),
      "design 1g: a draft that cannot be read says so — the canvas is never drawn from invented bytes",
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("studio-draft-error")).toContainText(PROBLEM_LINE);
    await expect(
      page.getByTestId("studio-draft-error"),
      "design 1g: the failed draft read says `Couldn't load the draft.` — the shared block, not the bare run word",
    ).toContainText("Couldn't load the draft.");
    await expect(
      page.getByTestId("studio-page"),
      "design 1g: no canvas mounts over the failed read",
    ).toHaveCount(0);
    await expectNoSpinner(page, "Loading the draft");
    await emu.screen("1g", "server-error");
  });

  test("2d — the YAML tab when the revision read fails", async ({ page, emu }) => {
    const made = await ensureScratchPublished(page);
    // Everything the tab reads hangs on the revision endpoint: the record
    // and the regenerated document alike.
    armServerFailure(page, emu, /\/api\/v1\/revisions\//);
    await page.goto(`/workflows/${made.pipelineId}/yaml`);
    await expect(
      page.getByTestId("workflow-yaml-tab"),
      "design 2d: the tab frame renders",
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByRole("alert").filter({ hasText: PROBLEM_LINE }).first(),
      "design 2d: a revision that cannot be read is a ProblemBanner, not an empty editor",
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByTestId("yaml-view"),
      "design 2d: no YAML is shown that did not come from the server",
    ).toHaveCount(0);
    await expectNoSpinner(page, "Loading the revision document");
    await emu.screen("2d", "server-error");
  });
});

/* ------------------------------------------------------------------ alice */

test.describe("server-error (alice: 2a, 2e, 2c, repo-1e, project-1b, threads-1g)", () => {
  test.describe.configure({ mode: "serial", timeout: 10 * 60_000 });
  test.use({ storageState: EMU_ALICE_STATE });

  test("2a — the Used in tab when the assignments fan fails", async ({ page, emu }) => {
    const made = await ensureScratchPublished(page);
    // The fan reads every project the caller belongs to; alice is a member
    // of at least M4 Exit, so the fan fires and every leg answers 500.
    armServerFailure(page, emu, /\/api\/v1\/projects\/[0-9a-f-]{36}\/assignments$/);
    await page.goto(`/workflows/${made.pipelineId}/used-in`);
    await expect(
      page.getByTestId("pipeline-page"),
      "design 2a: the page itself renders",
    ).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByTestId("used-in"), "design 2a: the Used in panel renders").toBeVisible({
      timeout: 30_000,
    });
    // A failed read is NOT a count (pass-2 review at 390, and pass-7 review on
    // the `?` the first fix left behind): the panel header says the bare
    // `USED IN` with NO number, the tab beside it drops its count the same way,
    // and the app's ONE load-failure treatment — the shared `Couldn't load …`
    // block with its `Retry`, the same every other server-error state shows —
    // says what broke. A `?` would still be a value standing in a number's
    // seat, so neither surface may print one (pass-8 review item 4 retired the
    // bare `FAILED` callout here: that is a run's status word).
    await expect(
      page.locator("#used-in-heading"),
      "design 2a: the broken fan reads `USED IN` with no count, never `USED IN 0 REPOS`",
    ).toHaveText("USED IN", { timeout: 30_000 });
    // The tab's badge is not rendered at all on a broken read — the tab says the
    // plain word `Used in` — so the assertion is the ABSENCE of the count
    // element, which is also what proves no `?` and no `0` came back.
    await expect(
      page.getByTestId("workflow-used-in-count"),
      "design 2a: the tab carries no count element where a read would have to lie",
    ).toHaveCount(0, { timeout: 30_000 });
    await expect(
      page.getByTestId("workflow-tab-used-in"),
      "design 2a: the tab itself says `Used in`, with no number and no `?`",
    ).toHaveText(/^Used in$/);
    const banner = page.getByTestId("used-in-error");
    await expect(
      banner,
      "design 2a: the failure is the shared load-failure alert, not red mono text passing as data",
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByRole("alert").filter({ hasText: /could not all be read/i }),
      "design 2a: it is the shared block (role=alert), the same one every other server-error state shows",
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      banner,
      "design 2a: the block leads with its own sentence — `Couldn't load the list of repos …`, not the bare run word FAILED",
    ).toContainText("Couldn't load the list of repos", { timeout: 30_000 });
    await expect(
      page.getByTestId("used-in-retry"),
      "design 2a: a server error offers the one thing it supports — ask again",
    ).toHaveText("Retry", { timeout: 30_000 });
    await expect(
      banner,
      "design 2a: a failed assignments fan is stated, not counted as 'not used'",
    ).toContainText(/could not/i);
    await expect(
      page.getByTestId("used-in-empty"),
      "design 2a: the honest empty line never speaks over a failed read",
    ).toHaveCount(0);
    await expect(
      page.getByTestId("used-in-loading"),
      "design 2a: the checking line does not stay forever",
    ).toHaveCount(0);
    await emu.screen("2a", "server-error");
  });

  test("2e — the repository page when the assignments read fails", async ({ page, emu }) => {
    const projectId = await m4ExitId(page);
    armServerFailure(page, emu, new RegExp(`/api/v1/projects/${projectId}/assignments$`));
    await page.goto(`/p/${projectId}/app`);
    await expect(
      page.getByTestId("repo-page"),
      "design 2e: the repository page renders",
    ).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      page.getByTestId("repo-workflows").getByRole("alert").filter({ hasText: PROBLEM_LINE }),
      "design 2e: the workflows panel quotes the failure (its assignments read is the one that broke)",
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByTestId("repo-workflows-empty"),
      "design 2e: a failed read is never dressed as 'uses no workflow yet'",
    ).toHaveCount(0);
    await expect(
      page.getByTestId(/^repo-workflow-row-/),
      "design 2e: no workflow rows are invented",
    ).toHaveCount(0);
    await emu.screen("2e", "server-error");
  });

  test("2c — the trigger dialog when the pinned-revision read fails", async ({ page, emu }) => {
    const made = await ensureScratchPublished(page);
    const projectId = await m4ExitId(page);
    let assignmentId = "";
    await test.step("pin the scratch workflow to M4 Exit / app", async () => {
      const repos = await page.request.get(`${EMU_BASE_URL}/api/v1/projects/${projectId}/repos`);
      expect(repos.status(), "the lab answers the repository list").toBe(200);
      const items =
        ((await repos.json()) as { items?: { id: string; name: string }[] }).items ?? [];
      const app = items.find((row) => row.name === "app");
      expect(app, "the seeded M4 Exit project carries the 'app' repository").toBeTruthy();
      const created = await apiMutate(
        page,
        "POST",
        `${EMU_BASE_URL}/api/v1/projects/${projectId}/assignments`,
        {
          pipeline_id: made.pipelineId,
          pinned_revision_id: made.revisionId,
          repository_id: app?.id,
        },
      );
      const body = await created.text();
      expect(
        created.status(),
        `pinning the scratch workflow answers 201 (got ${created.status()}: ${body.slice(0, 240)})`,
      ).toBe(201);
      assignmentId = (JSON.parse(body) as { id: string }).id;
      expect(assignmentId, "the pin has an id").toMatch(/^[0-9a-f-]{36}$/);
    });

    // `lib/format.ts`'s testidOf: the row (and its `+ Add trigger`) carry the
    // assignment id's first 13 alphanumeric characters.
    const rowKey = assignmentId.replace(/[^A-Za-z0-9]/g, "").slice(0, 13);
    armServerFailure(page, emu, new RegExp(`/api/v1/revisions/${made.revisionId}$`));
    await page.goto(`/p/${projectId}/app`);
    const add = page.getByTestId(`repo-workflow-add-${rowKey}`);
    await expect(add, "design 2c: the pinned workflow row offers `+ Add trigger`").toBeVisible({
      timeout: 30_000,
    });
    await add.click({ timeout: 15_000 });
    const dialog = page.getByTestId("trigger-dialog");
    await expect(dialog, "design 2c: the dialog opens").toBeVisible();
    await expect(
      dialog.getByRole("alert").filter({ hasText: PROBLEM_LINE }).first(),
      "design 2c: the dialog whose pinned-revision read failed quotes the server instead of hiding the break",
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      dialog.getByTestId("trigger-dialog-run-gets"),
      "design 2c: the run-input table is only drawn from the revision the server served — never invented",
    ).toHaveCount(0);
    await expect(
      dialog.getByTestId("trigger-dialog-mode"),
      "design 2c: the dialog is still the dialog (its own fields stay)",
    ).toBeVisible();
    await emu.screen("2c", "server-error");
  });

  test("repo-1e — the repository page when the repositories read fails", async ({ page, emu }) => {
    const projectId = await m4ExitId(page);
    armServerFailure(page, emu, new RegExp(`/api/v1/projects/${projectId}/repos$`));
    await page.goto(`/p/${projectId}/app`);
    await expect(
      page.getByRole("alert").filter({ hasText: PROBLEM_LINE }).first(),
      "design 1e: a failed repositories read is the ProblemBanner, not a spinner",
    ).toBeVisible({ timeout: 30_000 });
    await expectNoSpinner(page, "Loading repositories");
    await expect(
      page.getByTestId("repo-page"),
      "design 1e: no repository page is mounted over the failed read",
    ).toHaveCount(0);
    await emu.screen("repo-1e", "server-error");
  });

  test("project-1b — the project overview when the project read fails", async ({ page, emu }) => {
    const projectId = await m4ExitId(page);
    // `$`-anchored: only the project read itself may 500 — a page that fans
    // out to /repos or /runs for a project it cannot read stays undeclared
    // noise this pass must catch.
    armServerFailure(page, emu, new RegExp(`/api/v1/projects/${projectId}$`));
    await page.goto(`/p/${projectId}`);
    await expect(
      page.getByTestId("project-page-error"),
      "design 1b: the failed read lands on the error shell, not the overview",
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByTestId("project-page-error").getByRole("alert").filter({ hasText: PROBLEM_LINE }),
      "design 1b: the shell quotes the server's own problem",
    ).toBeVisible();
    await expect(
      page.getByTestId("project-page-error").getByRole("alert").first(),
      "design 1b: and it leads with its own sentence — the shared `Couldn't load …` block",
    ).toContainText("Couldn't load the project.");
    await expect(
      page.getByTestId("project-page"),
      "design 1b: no overview is assembled from parts",
    ).toHaveCount(0);
    await expectNoSpinner(page, "Loading project");
    await emu.screen("project-1b", "server-error");
  });

  test("threads-1g — the thread list when the conversations read fails", async ({ page, emu }) => {
    armServerFailure(page, emu, /\/api\/v1\/conversations(\?.*)?$/);
    await page.goto("/threads");
    await expect(page.getByTestId("threads-view"), "design 1g: the page frame renders").toBeVisible(
      {
        timeout: 30_000,
      },
    );
    await expect(
      page.getByTestId("threads-list-error"),
      "design 1g: the list pane says the read could not be made",
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByTestId("threads-list-error"),
      "design 1g: it is the shared load-failure block — `Couldn't load the thread list.",
    ).toContainText("Couldn't load the thread list.", { timeout: 30_000 });
    await expect(
      page.getByRole("alert").filter({ hasText: PROBLEM_LINE }).first(),
      "design 1g: the thread column carries the loud banner",
    ).toBeVisible();
    // Pass review 1g defect 5: hiding the thread column on a failed read left a
    // BLANK pane beside the banner at 1280, and an empty screen reads as a
    // broken app. The column's at-rest truth is still "No thread selected" —
    // none is — so the failed read KEEPS the prompt, and the refusal stays the
    // ONE loud banner in the list column above (asserted just here). Below `lg`
    // the phone's path to a thread is tapping a row, so the column is
    // allowlisted as the documented 390 collapse (reflow.ts).
    await expect(
      page.getByTestId("threads-no-selection"),
      "design 1g: at 1280 the thread column keeps its honest at-rest prompt beside the banner",
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByTestId("threads-no-selection").getByRole("alert"),
      "design 1g: the refusal is said ONCE — the at-rest prompt draws no second banner",
    ).toHaveCount(0);
    await expect(
      page.getByTestId(/^thread-row-/),
      "design 1g: no thread rows are invented",
    ).toHaveCount(0);
    await emu.screen("threads-1g", "server-error");
  });
});
