// Journey: the honest empty and error states (design 1b, 2a, 2e; plus the
// workflow-page 404 and Today's finding-12 server-version note).
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
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, apiMutate } from "./fixtures.js";
import {
  EMU_ALICE_STATE,
  EMU_ADMIN_STATE,
  EMU_BASE_URL,
  EMU_PASS_ID,
  EMU_REPO_ROOT,
} from "./env.js";

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

  // Acceptance T9 (finding 12): the TODAY string the copy pass rewrote was
  // only proven by the unit test reading f12.txt against the rendered
  // component. This is the browser proof: `page.route` answers the cross-
  // project approvals read the way a server older than ADR-0047 does — a
  // 404 problem+json, the same emulated-answer tool server-error.spec.ts
  // uses for 500s — and Today must say finding 12's sentence EXACTLY, the
  // four rewrites' Today one, printed from the finding's own REWRITE line
  // (never retyped here, the same rule `finding12.copy.test.tsx` follows).
  // The 404 the page provokes is the state under test — declared, not a
  // defect — and unrouting + reloading must take the note away again,
  // proving the note answers the server's version, not a stuck render.
  test("T9 — Today's server-version note reads finding 12 word for word", async ({ page, emu }) => {
    test.setTimeout(180_000);

    // The finding's own Today rewrite, marker stripped, whitespace the file
    // wraps on collapsed — zero or several matches kill the proof loudly.
    const finding = readFileSync(
      path.join(EMU_REPO_ROOT, "docs", "design", "handoff-redesign", "findings", "f12.txt"),
      "utf8",
    );
    const rewrites = finding
      .split(/\r?\n/)
      .map((line) => /^\s*REWRITE\s+(.+?)\s*$/.exec(line)?.[1] ?? "")
      .filter((line) => line !== "");
    const todayRewrite = rewrites.filter((line) =>
      line.startsWith("Approvals from other projects"),
    );
    expect(
      todayRewrite.length,
      `f12.txt must carry exactly one Today REWRITE line (found ${todayRewrite.length})`,
    ).toBe(1);
    const wanted = (todayRewrite[0] ?? "").replace(/\s+/g, " ").trim();
    // The brief's shape check: the sentence answers all three rulebook
    // questions, so the assertion can never pass against a truncated line.
    expect(wanted).toContain("Ask an admin to update");

    // The old server: GET /api/v1/approvals?status=pending (the cross-
    // project read Home's note names — ui/src/pages/Home.tsx files the note
    // for exactly this 404, see `notYet`) answers a 404 problem, the shape
    // api/client.ts turns into an ApiError whose status is 404. GET only;
    // anything else on that path continues to the lab.
    emu.expectFailure(/\/api\/v1\/approvals\b/, 404);
    const oldServer = /\/api\/v1\/approvals\?status=pending(?:&|$)/;
    await page.route(oldServer, (route) => {
      if (route.request().method() !== "GET") {
        void route.continue();
        return;
      }
      void route.fulfill({
        status: 404,
        contentType: "application/problem+json",
        body: JSON.stringify({
          type: "about:blank",
          title: "Not Found",
          status: 404,
          detail: "this replica predates the cross-project approvals read",
        }),
      });
    });

    try {
      await page.goto("/");
      await expect(page.getByTestId("home-page"), "design 2a: Today renders").toBeVisible({
        timeout: 30_000,
      });
      const note = page.getByTestId("home-not-available");
      await expect(
        note,
        "finding 12: the cross-project read this server cannot answer is the honest note, not a silent hole",
      ).toBeVisible({ timeout: 30_000 });
      await expect(note).toHaveAttribute("role", "note");
      // Word for word: the finding's sentence, whitespace-collapsed as
      // `toHaveText` reads the rendered one.
      await expect(note, "finding 12: Today's note is the rewrite verbatim").toHaveText(wanted, {
        timeout: 15_000,
      });
      // The note is a note, not a takeover: the count line the 404 did not
      // break still reads ("The rest of Today is up to date").
      await expect(
        page.getByTestId("home-count-line"),
        "finding 12: with one read 404 the rest of the briefing still speaks",
      ).toBeVisible({ timeout: 30_000 });
    } finally {
      // The route never survives into another screen (the lab's real answer
      // must be what the pass sees afterwards — and the check below reads
      // it). The page fixture dies with the test either way; this is the
      // brief's explicit unroute.
      await page.unroute(oldServer).catch(() => undefined);
    }

    // And the note came from the server's version, not a stuck render: back
    // on the lab's real answer, Today is plain again. (A lab whose image
    // genuinely predates C3 would keep the note — the lab image serves the
    // cross-project reads, proven by Home's own live callout proofs, so the
    // disappearance is a real claim here, not luck.)
    await page.reload();
    await expect(
      page.getByTestId("home-page"),
      "the briefing is back on the lab's own reads",
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByTestId("home-not-available"),
      "unrouting took the note away: it answers the server's version, nothing else",
    ).toHaveCount(0, { timeout: 30_000 });
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

  // Acceptance T9 (finding 12's copy pass): the run surface's ONE answer for a
  // run the reader cannot read used to be a note to the reviewer — it named the
  // control plane and quoted the status code. The rewrite states what happened
  // and the way out, and the box was only proven by unit tests on the component
  // plus the m4 exit driver reading the wire copy. This is the browser proof: a
  // random UUID on the project-less deep link, the exact sentence, the two exits.
  test("T9 — /runs/<random uuid> shows the RunNotFound copy with its two exits", async ({
    page,
    emu,
  }) => {
    test.setTimeout(180_000);
    const missing = randomUUID();
    // The 404 this page provokes IS the state under test — declared so it is not
    // counted as a defect. The `$` bounds it to the run read itself: a page that
    // fanned out to `/nodes` or `/events` for a run the run read already refused
    // would be real noise the pass must catch.
    emu.expectFailure(/\/api\/v1\/runs\/[0-9a-f-]{36}$/, 404);
    await page.goto(`/runs/${missing}`);

    const notFound = page.getByTestId("run-not-found");
    await expect(
      notFound,
      "finding 12: a run read that came back 404 renders the not-found state, not an empty workbench",
    ).toBeVisible({ timeout: 30_000 });

    // The sentence, verbatim. `RunNotFound.tsx` writes the apostrophes as
    // `&apos;`, which renders as the ASCII ' — so the assertion asks for exactly
    // that rather than a typographic ’ it does not print.
    await expect(
      page.getByTestId("run-not-found-summary"),
      "finding 12: the exact RunNotFound copy",
    ).toHaveText("This run doesn't exist or you don't have access to it.", {
      timeout: 30_000,
    });
    // The id the reader followed stays quotable on its own muted line.
    await expect(
      page.getByTestId("run-not-found-id"),
      "finding 12: the id the reader followed is printed for them to quote",
    ).toHaveText(`run ${missing}`);

    // Both exits, and on this project-less deep link "Back to Runs" is the way
    // out of the dead page (the briefing's home). The access affordance carries
    // the `run-not-found-access` id in both shapes; here there is no project to
    // name, so it is the honest sentence naming who to ask rather than a link to
    // a members page that may not exist for this reader.
    const back = page.getByTestId("run-not-found-runs");
    await expect(back, "finding 12: every error ends in an action — Back to Runs").toBeVisible();
    await expect(back).toHaveText("Back to Runs");
    const access = page.getByTestId("run-not-found-access");
    await expect(access, "finding 12: and the way to ask for access").toBeVisible();
    await expect(access).toContainText(/ask\b.*access/i);
    // No retry affordance: a 404 is a refusal, not a break.
    await expect(
      page.getByRole("button", { name: /retry/i }),
      "finding 12: a 404 offers no Retry — re-asking answers the same",
    ).toHaveCount(0);
    await emu.screen("run-not-found", "t9");
  });
});
