// The M6 screens of the M5 exit suite: `/profiles` (ADR-0030 — a launch
// descriptor, its permission mode, and the APM skill-package pin with its
// "How do I get this?" digest recipe) and the project's Workflows tab
// (`/p/:id/pipelines`, design project-1b-workflows: ONE panel of 2e rows whose
// STARTS WHEN box carries the ADR-0032 schedules — a schedule belongs to a
// project ASSIGNMENT and fires its pinned revision on a UTC cron cadence,
// authored through the shared 2c `TriggerDialog`). There is no `/schedules`
// route to visit: `ui/src/App.tsx` mounts `/profiles` and
// `/p/:projectId/pipelines`, and the schedule UI lives in the row's own
// STARTS WHEN box (`ProjectWorkflowsPanel`, rows shared with
// `components/workflows/RepoWorkflows`).
//
// It runs against the M4 lab by env override only, exactly like m5-journey and
// m5-inbox — no second compose project:
//   COMMUNICATION_E2E_M5=1 E2E_BASE_URL=http://localhost:18091 \
//     pnpm exec playwright test tests/m5-agents-schedules.spec.ts --reporter=line
// The lab's mock IdP identities and the "M4 Exit" project (alice = maintainer,
// erin = maintainer of `m4-project-b` ONLY, admin = org admin with the library
// role) come from docs/compatibility/probes/m4/seed.sh.
//
// WHO DOES WHAT, and why the brief's "as a maintainer" splits in two:
// `/profiles` list-visible is organization-wide (`api/openapi.yaml`
// listAgentProfiles: "the listing stays available to every member of the
// organization"), but BOTH write surfaces — `POST /api/v1/agent-profiles` and
// `PATCH /api/v1/agent-profiles/{id}` — are the library role's (`me.is_org_admin
// === true`, the same fail-closed predicate `ui/src/pages/Agents.tsx` uses to
// render `NewAgentForm` and the row's `Attach skill package` button). The
// "How do I get this?" block lives inside that form (`DigestHelp`), so the
// digest help is only reachable by the identity the server lets pin a package:
// admin performs the attach and opens the help; alice (project maintainer, no
// library role) then reads the SAME row — its `permission_mode` and its skill
// package — read-only, which is the arm that proves a maintainer sees the
// organization's launch descriptors without being able to rewrite them.
//
// WHERE THE PROJECT SCOPING IS ACTUALLY PROVED: the brief asks that erin not see
// "a project-scoped profile of project A". Profiles have no project scope to
// hide — `agent_profiles.organization_id` is the only owner column
// (ADR-0030 § 3, migration 00003), and the route description says a member of
// the same organization sees the row because "role is not existence
// information here". So this spec asserts the org-wide visibility positively
// (erin reads the same row, with no write control) and proves the project
// boundary where the domain really draws it: project A's assignments and their
// triggers. Erin deep-linked to `/p/<A>/pipelines` gets the one
// refusal sentence (`ProjectUnavailable`, ADR-0014 § 3) and zero
// assignment rows (the panel's `project-workflow-row-*` and the STARTS WHEN
// rows under them), while alice's identical URL lists the 2e rows whose
// STARTS WHEN box she can edit.
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { BASE_URL } from "./env.js";
import { gotoApp, openProjectBySlug, selectByOptionText, shot, signIn } from "./helpers.js";

const M5_ENABLED = process.env.COMMUNICATION_E2E_M5 === "1";

// The lab's seeded identities (seed.sh posts only an `email` claim, so display
// names are the bare subjects — the same rule m5-journey/m5-inbox follow).
const ADMIN = { subject: "admin" };
const ALICE = { subject: "alice", projectSlug: "m4-exit" };
const ERIN = { subject: "erin" };

const stamp =
  process.env.E2E_M5_AGENTS_STAMP ?? new Date().toISOString().slice(11, 19).replace(/:/g, "");
/** The profile this run creates through the product's own /profiles form. */
const PROFILE_NAME = `m5-agents-${stamp}`;
/** A syntactically valid pin that resolves to nothing: no launch ever stages it,
 * because the only conversation this suite starts on it is none. */
const APM_REF = "example-org/example-skills#v0.1.0";
const APM_TARGET = "claude";
const APM_DIGEST = `sha256:${"0123456789abcdef".repeat(4)}`;
/** The digest as the row prints it (`shortDigest`: the 12 chars after the
 * `sha256:` prefix — `ui/src/lib/pipeline/yamlPointer.ts`). */
const APM_DIGEST_SHORT = APM_DIGEST.slice(7, 19);

/**
 * The cadence this run schedules: Jan 1 00:00:00 UTC, once a year. It is the
 * far-future half of the brief's "far-future or disabled" — no matter when the
 * suite runs, the next slot is months away, so a fire during the test is not a
 * race the assertion can lose. The parser in `internal/pipelines/schedule`
 * accepts it (5 fields, UTC). The 2c dialog offers no cadence presets at all,
 * so what the row says afterwards is what was typed.
 */
const CRON_FAR_FUTURE = "0 0 1 1 *";
/** Preferred assignment: the deterministic twin needs no model endpoint even in
 * the pathological case where a slot arrived mid-run. */
const PREFERRED_SLUGS = ["feature-development-deterministic", "feature-development"];
const GOAL = "Scheduled by the M5 agents/schedules arm — never fired";
/** The M4 lab's seeded repository binding (seed.sh `create_repo`). */
const REPO_BINDING = "app";

const M5_TIMEOUT_MS = Number(process.env.E2E_M5_AGENTS_TIMEOUT_MS ?? 600_000);

test.describe("M5 agents + schedules: profiles, skill pins and the cron clock", () => {
  test.describe.configure({ mode: "serial", timeout: M5_TIMEOUT_MS });
  test.skip(!M5_ENABLED, "Needs the M4 lab stack (port 18091) — run with COMMUNICATION_E2E_M5=1");

  let adminContext: BrowserContext;
  let aliceContext: BrowserContext;
  let erinContext: BrowserContext;
  let admin: Page;
  let alice: Page;
  let erin: Page;
  let projectPath = ""; // /p/{M4 Exit id}
  let projectId = "";
  /** The profile this run created; empty when nothing was created. */
  let profileId = "";
  /** The `project-workflow-row-*` key whose assignment got a schedule; empty
   * when nothing was created. The rows are keyed by the served assignment id
   * (`testidOf(assignment.id)`), never by a guessed slug. */
  let scheduledRowKey = "";

  test.beforeAll(async ({ browser }) => {
    adminContext = await browser.newContext();
    aliceContext = await browser.newContext();
    erinContext = await browser.newContext();
    admin = await adminContext.newPage();
    alice = await aliceContext.newPage();
    erin = await erinContext.newPage();
  });

  // Cleanup even on failure, and cleanup through the product too: the pin is
  // removed with the form's own `Remove package`, the schedule is paused with
  // the row's own checkbox. Neither is an assertion — both are try/catch, so a
  // broken page reports the test that measured it, not this.
  test.afterAll(async () => {
    if (admin) await removePinQuietly(admin, profileId);
    if (alice && scheduledRowKey) await pauseScheduleQuietly(alice, projectPath, scheduledRowKey);
    for (const context of [adminContext, aliceContext, erinContext]) {
      if (context) await context.close();
    }
  });

  test("the lab answers readiness and the three identities sign in", async ({ request }) => {
    await test.step("the M4 lab answers readiness", async () => {
      await expect
        .poll(
          async () => {
            try {
              return (await request.get(`${BASE_URL}/api/v1/system/readiness`)).ok();
            } catch {
              return false;
            }
          },
          { timeout: 120_000, intervals: [2_000] },
        )
        .toBe(true);
    });
    await test.step("alice (maintainer), erin (other project only) and admin sign in", async () => {
      for (const [page, who] of [
        [alice, ALICE],
        [erin, ERIN],
        [admin, ADMIN],
      ] as const) {
        await signIn(page, who.subject, { email: `${who.subject}@example.test` });
        await expect(page.getByTestId("user-badge")).toHaveText(who.subject);
      }
    });
    await test.step("project A is found by slug, never by a hard-coded id", async () => {
      // The id every later deep link is built from, read off the served list.
      projectPath = await openProjectBySlug(alice, ALICE.projectSlug);
      projectId = projectPath.split("/").pop() ?? "";
      expect(projectId).toMatch(/^[0-9a-f-]{36}$/);
      await shot(alice, "m5-agents-00-project-a");
    });
  });

  test("agents: a skill pin, its digest help, and who may not see the controls", async () => {
    await test.step("admin (the library role) creates the profile the arm pins", async () => {
      await gotoApp(admin, "/profiles");
      await expect(admin.getByTestId("agents-page")).toBeVisible();
      // The New profile button is the library role's gate (ADR-0030); the
      // form itself now lives in the dialog it opens.
      await expect(admin.getByTestId("agents-new-open")).toBeVisible();
      await admin.getByTestId("agents-new-open").click();
      await expect(admin.getByTestId("agents-new-form")).toBeVisible();
      await admin.getByTestId("agents-new-name-input").fill(PROFILE_NAME);
      // The new dialog picks the launcher by agent card (radio), not a select;
      // `agents-new-launcher-select` is the disabled "Other ACP agent" catch-all.
      await admin.getByTestId("new-profile-card-claude").click();
      await admin.getByTestId("agents-new-submit").click();
      profileId = await profileIdOf(admin, PROFILE_NAME);
      expect(profileId).toMatch(/^[0-9a-f-]{36}$/);
      // The row opens the profile's detail panel — the disclaimer is the
      // page's own honesty rule (ADR-0030 § 6): staging is not isolation, and
      // the page says it out loud to every reader.
      await admin.getByTestId(`agent-row-${profileId}`).click();
      await expect(admin.getByTestId("agents-disclaimer")).toContainText(
        /staging is not isolation/i,
      );
    });
    await test.step("the new row serves its permission mode (ask — nothing else is writable)", async () => {
      // `permission_mode` has no field on POST (ADR-0030), so `ask` is what a
      // profile created through the product can only ever be.
      await expect(admin.getByTestId(`agent-permission-${profileId}`)).toHaveText(
        /^permission: ask$/,
      );
      await expect(admin.getByTestId(`agent-launcher-${profileId}`)).toHaveText(
        /^launcher: claude$/,
      );
      await expect(admin.getByTestId(`agent-apm-none-${profileId}`)).toHaveText(/no skill package/);
    });
    await test.step("the pin is attached as one triple through the row's own form", async () => {
      await admin.getByTestId(`agent-edit-${profileId}`).click();
      const form = admin.getByTestId(`agent-apm-form-${profileId}`);
      await expect(form).toBeVisible();
      await form.getByTestId(`agents-ref-input-${profileId}`).fill(APM_REF);
      await form.getByTestId(`agents-target-select-${profileId}`).selectOption(APM_TARGET);
      await form.getByTestId(`agents-digest-input-${profileId}`).fill(APM_DIGEST);
      await form.getByTestId(`agents-apm-save-${profileId}`).click();
      // A save closes the form; the row re-renders from the served profile. A
      // refusal keeps it open with the server's `code`, so that is what a
      // failure quotes rather than "the form would not close".
      const closed = await form
        .waitFor({ state: "detached", timeout: 30_000 })
        .then(() => true)
        .catch(() => false);
      if (!closed) {
        const refusal = await form
          .getByTestId(`agents-apm-problem-${profileId}`)
          .textContent()
          .catch(() => null);
        throw new Error(
          `PATCH /api/v1/agent-profiles/${profileId} did not land for ${APM_REF}: the form is ` +
            `still open${refusal ? ` quoting "${refusal.trim()}"` : " with no problem rendered"}.`,
        );
      }
      await expect(admin.getByTestId(`agent-apm-ref-${profileId}`)).toHaveText(APM_REF);
      await expect(admin.getByTestId(`agent-apm-target-${profileId}`)).toHaveText(
        `target: ${APM_TARGET}`,
      );
      await expect(admin.getByTestId(`agent-apm-digest-${profileId}`)).toHaveText(APM_DIGEST_SHORT);
      await expect(admin.getByTestId(`agent-apm-none-${profileId}`)).toHaveCount(0);
      await shot(admin, "m5-agents-01-pinned-row");
    });
    await test.step('"How do I get this?" says where the digest comes from', async () => {
      // Re-open the form: the help lives inside the pin form, which only the
      // identity allowed to write the triple can reach.
      await admin.getByTestId(`agent-edit-${profileId}`).click();
      await expect(admin.getByTestId(`agent-apm-form-${profileId}`)).toBeVisible();
      const block = admin.getByTestId(`agents-digest-help-block-${profileId}`);
      await expect(block).toBeHidden();
      await admin.getByTestId(`agents-digest-help-toggle-${profileId}`).click();
      await expect(block).toBeVisible();
      // The two commands from docs/compatibility/APM.md, with this form's own
      // values filled in — copy-paste runnable, not a placeholder.
      await expect(block).toContainText(`apm install --target ${APM_TARGET}`);
      await expect(block).toContainText("sha256sum apm.lock.yaml");
      await expect(block).toContainText(APM_REF);
      await expect(block).toContainText("communication-worker");
      await shot(admin, "m5-agents-02-digest-help");
    });
    await test.step("alice (project maintainer, no library role) reads the SAME row read-only", async () => {
      await gotoApp(alice, "/profiles");
      await expect(alice.getByTestId(`agent-item-${profileId}`)).toBeVisible();
      // The row opens the detail panel that serves the permission mode and
      // the skill package triple.
      await alice.getByTestId(`agent-row-${profileId}`).click();
      // What the brief asks a maintainer to see, served to her own session:
      // the permission mode, and the skill package triple pinned above.
      await expect(alice.getByTestId(`agent-permission-${profileId}`)).toHaveText(
        /^permission: ask$/,
      );
      await expect(alice.getByTestId(`agent-apm-ref-${profileId}`)).toHaveText(APM_REF);
      await expect(alice.getByTestId(`agent-apm-digest-${profileId}`)).toHaveText(APM_DIGEST_SHORT);
      // And the controls she may not have are absent — the page's own
      // fail-closed predicate (`me.is_org_admin`), not a hidden button.
      await expect(alice.getByTestId("agents-new-open")).toHaveCount(0);
      await expect(alice.getByTestId(`agent-edit-${profileId}`)).toHaveCount(0);
      await expect(alice.getByTestId(`agent-apm-form-${profileId}`)).toHaveCount(0);
      // The panel's own words about this reader's role (plain list header
      // text in the new profile list, not an id).
      await expect(alice.getByTestId("profiles-list")).toContainText(/AGENT PROFILES/i);
      await expect(alice.getByText(/read-only for your role/)).toBeVisible();
      await shot(alice, "m5-agents-03-maintainer-readonly");
    });
    await test.step("erin sees the org list but none of project A's schedule surface", async () => {
      // Profiles carry NO project scope (ADR-0030 § 3: the only owner column is
      // `organization_id`, and the listing "stays available to every member of
      // the organization"), so erin reads the org-wide row — the honest form of
      // the brief's isolation arm. What IS project-scoped is the assignment and
      // its schedules, and those are the things she cannot list.
      await gotoApp(erin, "/profiles");
      await expect(erin.getByTestId(`agent-item-${profileId}`)).toBeVisible();
      await expect(erin.getByTestId("agents-new-open")).toHaveCount(0);
      await expect(erin.getByTestId(`agent-edit-${profileId}`)).toHaveCount(0);
      // Erin holds no membership row on project A (§ 7.2 W9), so every project
      // surface answers the one refusal sentence (ADR-0014 § 3). The surface
      // that could leak is the Workflows panel's own rows — each 2e row and
      // its STARTS WHEN box is where schedules live now — and she is served
      // zero of each, so there is nothing to leak.
      await gotoApp(erin, `${projectPath}/pipelines`);
      await expect(erin.getByTestId("project-pipelines-not-found")).toBeVisible();
      await expect(erin.locator('[data-testid^="project-workflow-row-"]')).toHaveCount(0);
      await expect(erin.locator('[data-testid^="project-workflow-starts-"]')).toHaveCount(0);
      await shot(erin, "m5-agents-04-erin-project-a-refused");
    });
  });

  /** The `agent_profiles` id the page itself put on the row named `name`. */
  async function profileIdOf(page: Page, name: string): Promise<string> {
    const row = page
      .getByTestId("agent-list")
      .locator('[data-testid^="agent-item-"]')
      .filter({ hasText: name });
    await expect(row).toHaveCount(1, { timeout: 30_000 });
    const testid = await row.getAttribute("data-testid");
    return (testid ?? "").replace(/^agent-item-/, "");
  }

  test("schedules: a far-future cadence on an assignment, its clock, and its pause", async () => {
    // The schedule rows are the 2e rows of the panel's STARTS WHEN box
    // (`repo-workflow-trigger-*`, exported from `components/workflows/
    // RepoWorkflows`); they are keyed by the served schedule/trigger id, so
    // the arm locates them inside its own row's box rather than by slug.
    const boxOf = (key: string) => alice.getByTestId(`project-workflow-starts-${key}`);
    /** The STARTS WHEN box's schedule rows: the shared 2e row for a cron is
     * the one whose mono detail line is NOT the issue arm's reading. */
    const scheduleRows = (key: string) =>
      boxOf(key)
        .locator('div[data-testid^="repo-workflow-trigger-"]')
        .filter({ hasNotText: "checked every minute" });
    await test.step("the panel's 2e rows, found by served test id", async () => {
      await gotoApp(alice, `${projectPath}/pipelines`);
      await expect(alice.getByTestId("project-pipelines")).toBeVisible();
      // No hard-coded id: read the rows the served assignments produced and
      // keep the first one the lab is known to fire. A row names itself with
      // the workflow's display name (the seed's equals its slug) once its
      // definition read lands — `· loading` presses no choice.
      const rows = alice.locator('[data-testid^="project-workflow-row-"]');
      await expect(rows.first()).toBeVisible({ timeout: 30_000 });
      const nameByKey = new Map<string, string>();
      await expect
        .poll(
          async () => {
            nameByKey.clear();
            for (const row of await rows.all()) {
              const testid = (await row.getAttribute("data-testid")) ?? "";
              const key = testid.replace(/^project-workflow-row-/, "");
              const name = (
                (await row
                  .locator('[data-testid^="project-workflow-name-"]')
                  .first()
                  .textContent()) ?? ""
              ).trim();
              if (!name || name.includes("loading")) return 0;
              nameByKey.set(key, name);
            }
            return nameByKey.size;
          },
          { timeout: 30_000 },
        )
        .toBeGreaterThan(0);
      const keys = [...nameByKey.keys()];
      scheduledRowKey =
        keys.find((key) => PREFERRED_SLUGS.includes(nameByKey.get(key) ?? "")) ?? keys[0] ?? "";
      expect(scheduledRowKey.length).toBeGreaterThan(0);
      // The row opens on its STARTS WHEN box — the 2e expanded row is the
      // default — and the + Add trigger verb is maintainer-only (`canManage`);
      // alice holds the project's `my_role === "maintainer"` — same predicate, served.
      await expect(boxOf(scheduledRowKey)).toBeVisible();
      await expect(alice.getByTestId(`project-workflow-add-${scheduledRowKey}`)).toBeVisible();
    });
    await test.step("a far-future yearly cadence is created through the 2c dialog", async () => {
      // The trigger reads must have landed before the count is worth +1'ing:
      // a row still reading its triggers shows its loading line, not rows.
      await expect(alice.getByTestId(`project-workflow-loading-${scheduledRowKey}`)).toHaveCount(
        0,
        { timeout: 30_000 },
      );
      const rows = scheduleRows(scheduledRowKey);
      const before = await rows.count();
      // The 2c dialog is repo-anchored by design. From a whole-project row of
      // a multi-repository project the STARTS WHEN header asks which
      // repository it speaks for (a one-repository project opens it directly);
      // the repository the schedule fires is the dialog's own context line.
      const repoChoice = boxOf(scheduledRowKey).getByTestId(
        `project-workflow-repo-choice-${scheduledRowKey}`,
      );
      if (await repoChoice.count()) {
        await selectByOptionText(
          alice,
          `project-workflow-repo-choice-${scheduledRowKey}`,
          REPO_BINDING,
        );
      }
      await alice.getByTestId(`project-workflow-add-${scheduledRowKey}`).click();
      await expect(alice.getByTestId("trigger-dialog")).toBeVisible();
      await expect(alice.getByTestId("trigger-dialog-context")).toContainText(REPO_BINDING, {
        timeout: 30_000,
      });
      // NOT a preset echo: the dialog opens on the issue arm; the cadence
      // lives on the schedule arm, and what the row says afterwards is what
      // was typed (the dialog's reading line replaces the retired inline
      // cron-preset buttons).
      await alice.getByTestId("trigger-dialog-mode-schedule").click();
      await alice.getByTestId("trigger-dialog-cron").fill(CRON_FAR_FUTURE);
      await expect(alice.getByTestId("trigger-dialog-cron-words")).toHaveText(
        /yearly on Jan 1 at 00:00 UTC/,
      );
      // The schedule fires the assignment's pinned revision with THESE inputs
      // (ADR-0032), so the dialog renders the revision's declared inputs —
      // the same controls `NewRunForm` builds, shared on purpose. A
      // `repository`-typed input is NOT a control here (the dialog fixes the
      // repository it opened for — named on its context line above) and rides
      // in the inputs as that repository.
      await expect(alice.getByTestId("trigger-dialog-run-gets")).toBeVisible({ timeout: 30_000 });
      const goal = alice.getByTestId("new-run-input-goal");
      if (await goal.count()) {
        await goal.fill(GOAL);
      }
      await alice.getByTestId("trigger-dialog-submit").click();
      // A create closes the dialog; a refusal keeps it open quoting the
      // server's problem (invalid_cron, an input refusal, or
      // `assignment_not_fireable` on an assignment that cannot run), which is
      // the message worth having.
      const added = await alice
        .getByTestId("trigger-dialog")
        .waitFor({ state: "detached", timeout: 30_000 })
        .then(() => true)
        .catch(() => false);
      if (!added) {
        const refusal = await alice
          .getByTestId("trigger-dialog-error")
          .textContent()
          .catch(() => null);
        throw new Error(
          `POST /api/v1/projects/${projectId}/schedules did not land for ${scheduledRowKey} ` +
            `on ${CRON_FAR_FUTURE}: the dialog is still open` +
            `${refusal ? ` quoting "${refusal.trim()}"` : " with no problem rendered"}.`,
        );
      }
      // The list refetched; our row is the newest (the route is oldest-first).
      await expect(rows).toHaveCount(before + 1, { timeout: 30_000 });
      const row = rows.last();
      // The row's own words for the cadence: the plain-English reading over
      // the raw expression the author typed (the mono detail line).
      await expect(row).toContainText(/yearly on Jan 1 at 00:00 UTC/, { timeout: 30_000 });
      await expect(row.locator('[data-testid^="repo-workflow-trigger-detail-"]')).toContainText(
        CRON_FAR_FUTURE,
      );
      await expect(
        row.locator('[data-testid^="repo-workflow-trigger-enabled-"][data-testid$="-state"]'),
      ).toHaveText("on");
      await shot(alice, "m5-schedules-01-created");
    });
    await test.step("the row answers the one question a schedule screen is for", async () => {
      const row = scheduleRows(scheduledRowKey).last();
      // "next in 214d" — a countdown, never "due now"/"passed": the whole
      // point of a far-future slot is that nothing fires while this runs. The
      // bookkeeping column (scheduleNextText) carries it, and with no
      // `· last <id>` link beside it nothing has fired — the row's own words
      // for the retired `never run` line. (2026-10-30 copy review, 2c item 5:
      // the countdown used to read `next 214d left`, which said the same thing
      // twice; the ` left` suffix is gone.)
      await expect(row.locator('[data-testid^="repo-workflow-trigger-meta-"]')).toHaveText(
        /^next in [0-9]+[smhd]$/,
      );
    });
    await test.step("disabling it is served, not just clicked — and survives a reload", async () => {
      // ADR-0032 exposes no DELETE route, so the product's "take it off the
      // clock" is the 2e row's switch; the arm therefore pauses EVERY schedule
      // of the assignment — including ones an earlier, harder-failed run left
      // enabled — and asserts none is left promising a fire. See DEVIATIONS.
      const rows = scheduleRows(scheduledRowKey);
      const total = await rows.count();
      for (let index = 0; index < total; index++) {
        const box = rows.nth(index).locator('input[data-testid^="repo-workflow-trigger-enabled-"]');
        if (await box.isChecked().catch(() => false)) await box.click();
      }
      const row = rows.last();
      await expect(
        row.locator('[data-testid^="repo-workflow-trigger-enabled-"][data-testid$="-state"]'),
      ).toHaveText("paused", { timeout: 30_000 });
      // A paused row's `next_run_at` is a stale number, so the clock must stop
      // promising a fire (ADR-0032: re-enabling re-derives it from now). The
      // 2026-10-30 copy review (2c item 5) took the repeated state word out of
      // the bookkeeping cell — the switch's own `paused` word above already
      // says it — so a paused row's meta cell now carries only the run fact:
      // `last <id>` when the schedule has fired, `never run` when it has not.
      // Nothing in the row may still promise a `next …`.
      const meta = row.locator('[data-testid^="repo-workflow-trigger-meta-"]');
      await expect(meta).toHaveText(/^(never run|last [0-9a-z-]{4,})$/i);
      const pausedText = ((await row.textContent()) ?? "").toLowerCase();
      expect(
        pausedText,
        `a paused row promises no fire (row read: "${pausedText.trim()}")`,
      ).not.toMatch(/next [0-9]/);
      expect(
        pausedText,
        `a paused row promises no fire (row read: "${pausedText.trim()}")`,
      ).not.toMatch(/next in [0-9]/);
      // Read the served state back from a fresh navigation, not the client's
      // cache: the pause is the database's, not the page's.
      await gotoApp(alice, `${projectPath}/pipelines`);
      const fresh = scheduleRows(scheduledRowKey);
      await expect(fresh.first()).toBeVisible({ timeout: 30_000 });
      const remaining = await fresh.count();
      for (let index = 0; index < remaining; index++) {
        // Nothing this suite put on the clock is left promising a fire.
        await expect(
          fresh.nth(index).locator('input[data-testid^="repo-workflow-trigger-enabled-"]'),
        ).not.toBeChecked({ timeout: 30_000 });
      }
      await expect(
        fresh
          .last()
          .locator('[data-testid^="repo-workflow-trigger-enabled-"][data-testid$="-state"]'),
      ).toHaveText("paused");
      // The served pause drops the countdown too — a fresh navigation reads
      // the same contract the click produced, not a client-side flourish. The
      // meta cell keeps only the run fact (`never run`, or `last <id>` once the
      // schedule has fired); the state word belongs to the switch alone.
      await expect(fresh.last().locator('[data-testid^="repo-workflow-trigger-meta-"]')).toHaveText(
        /^(never run|last [0-9a-z-]{4,})$/i,
      );
      await expect(
        fresh.last().locator('[data-testid^="repo-workflow-trigger-meta-"]'),
      ).not.toContainText(/next/i);
      scheduledRowKey = ""; // nothing is left on the clock for afterAll to pause
      await shot(alice, "m5-schedules-02-paused");
    });
  });
});

/** Best-effort: clear this run's APM pin through the row's own form. */
async function removePinQuietly(page: Page, id: string): Promise<void> {
  if (!id) return;
  try {
    await gotoApp(page, "/profiles");
    await page.getByTestId(`agent-edit-${id}`).click({ timeout: 10_000 });
    await page.getByTestId(`agents-apm-remove-${id}`).click({ timeout: 10_000 });
  } catch {
    // The pin is inert without a launch; a cleanup failure must not mask a test.
  }
}

/** Best-effort: uncheck every schedule row of the assignment this run used. */
async function pauseScheduleQuietly(page: Page, path: string, rowKey: string): Promise<void> {
  if (!path || !rowKey) return;
  try {
    await gotoApp(page, `${path}/pipelines`);
    const rows = page
      .getByTestId(`project-workflow-starts-${rowKey}`)
      .locator('div[data-testid^="repo-workflow-trigger-"]')
      .filter({ hasNotText: "checked every minute" });
    const total = await rows.count();
    for (let index = 0; index < total; index++) {
      const box = rows.nth(index).locator('input[data-testid^="repo-workflow-trigger-enabled-"]');
      if (await box.isChecked().catch(() => false)) await box.click({ timeout: 10_000 });
    }
  } catch {
    // A paused schedule fires nothing; see the comment above.
  }
}
