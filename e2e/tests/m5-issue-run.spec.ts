// Wishlist W3, e2e half: "start a run from a GitHub issue"
// (docs/design/wishlist-gap.md, ADR-0031). The journey this proves:
//
//   1. alice's project holds a repository row whose remote is a PUBLIC GitHub
//      repo with open issues — the one docs/compatibility/GITHUB.md records as
//      really called (mattpocock/skills, anonymous `GET /repos/{o}/{r}/issues`,
//      2026-10-16). The row is added through the API the seed adds its `app`
//      row through (`POST /api/v1/projects/{id}/repos`), idempotently, and
//      never reset afterwards.
//   2. a pipeline whose `spec.inputs` declares `issue_number` (integer) and
//      `goal` (string) — the two names `issueValuesFor` in
//      `ui/src/components/m4/NewRunForm.tsx` writes issue data into — is
//      authored and published through the library's own draft path, the way
//      the M5 exit journey authors its pipeline.
//   3. the New run form's issue picker lists the live tracker; picking the
//      first issue prefills `issue_number` with the number and `goal` with the
//      `#<number> <title>` heading, exactly as `issueValuesFor` promises.
//   4. the started run's `run_inputs` (read back through `GET /runs/{runId}`'s
//      validated `inputs`, per api/openapi.yaml) carry that number and heading
//      with `origin: submitted` — the record the control plane keeps, not the
//      UI's own echo.
//
// It runs against the M4 lab by env override only, the same gate idiom as
// tests/m5-journey.spec.ts:
//   COMMUNICATION_E2E_M5=1 \
//   E2E_BASE_URL=http://localhost:18091 E2E_API_A_URL=http://localhost:18092 \
//   E2E_API_B_URL=http://localhost:18093 pnpm exec playwright test tests/m5-issue-run.spec.ts
//
// The picker's list is a LIVE read of api.github.com (ADR-0031's one
// anonymous budget, no token), so the suite is honest about the two arms it
// cannot prove: if the issue list never loads (upstream error, budget, or no
// network from the lab) or comes back empty, the test skips with an explicit
// reason rather than passing without a real issue. Every wait is bounded.
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { BASE_URL } from "./env.js";
import { gotoApp, openProjectBySlug, selectByOptionText, shot, signIn } from "./helpers.js";

const M5_ENABLED = process.env.COMMUNICATION_E2E_M5 === "1";

// The lab's seeded identities: display names are the bare subjects (seed.sh
// posts only an `email` claim, so no `name` to read off the id token).
const ADMIN = { subject: "admin", name: "admin" };
const ALICE = {
  subject: "alice",
  name: "alice",
  projectSlug: "m4-exit",
  projectName: "M4 Exit",
};

// The public repository whose issue list GITHUB.md records a real 200 for —
// the only remote this suite ever calls, inside the anonymous budget.
const GITHUB_REPO = "mattpocock/skills";
const GITHUB_URL = `https://github.com/${GITHUB_REPO}`;

// Stamped, so a re-run of the suite on the same lab adds its own definitions
// (like m5-journey's) instead of colliding with the previous run's rows.
const stamp = process.env.E2E_M5_STAMP ?? new Date().toISOString().slice(11, 19).replace(/:/g, "");
const SLUG = `m5-issue-${stamp}`;
const REPO_NAME = `m5gh-${stamp}`;

/** A bounded wait for the live GitHub read the issue picker depends on. */
const GITHUB_TIMEOUT_MS = Number(process.env.E2E_M5_GITHUB_TIMEOUT_MS ?? 60_000);
/** `run_inputs` are recorded in the creating transaction — a short bound. */
const RUN_READ_TIMEOUT_MS = 30_000;

/** Escape a live issue title for use inside a RegExp assertion. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The pipeline the journey publishes: one deterministic `process.exec` node
 * (no model endpoint on the lab) whose only job is to prove the authoring
 * path, and `spec.inputs` that declare exactly the two names `issueValuesFor`
 * writes — `issue_number` (integer) and `goal` (string) — plus the
 * `repository` input whose chosen value is what the issue picker reads. The
 * assertion target is the run's recorded inputs, so the node's content is
 * deliberately trivial.
 */
const ISSUE_PIPELINE_YAML = `# W3 e2e twin: a run started from a GitHub issue. One deterministic
# process.exec node so no model endpoint is needed; the recorded run_inputs
# are what the journey actually asserts.
apiVersion: communication.dev/v1alpha1
kind: Pipeline
metadata:
  name: __SLUG__
  description: >-
    Run started from a GitHub issue: the issue picker seeds issue_number and
    goal from the live tracker, and the run records both in run_inputs.
spec:
  inputs:
    type: object
    required: [repository, issue_number, goal]
    properties:
      repository:
        type: string
        minLength: 1
        description: Project repository binding name, e.g. app.
      issue_number:
        type: integer
        minimum: 1
        description: The GitHub issue number this run started from.
      goal:
        type: string
        minLength: 1
        description: What the run should do, seeded from the issue when it is used.
  outputs:
    type: object
    required: [note]
    properties:
      note: {type: string}
  policies:
    maxConcurrentNodes: 1
    maxDurationSeconds: 3600
    maxNodeExecutions: 5
    maxChildDepth: 0
    workspaceMode: worktree
    cancelPolicy: cascade
  nodes:
  - id: note
    kind: process.exec
    timeoutSeconds: 120
    retry:
      maxAttempts: 1
    config:
      executable: printf
      args:
      - '%s\\n'
      - '{"note":"run started from a GitHub issue"}'
      outputExtraction: {mode: json_from_stdout}
    outputs:
      type: object
      required: [note]
      properties:
        note: {type: string}
  resultBindings:
    note: \${{ nodes.note.outputs.note }}
`;

/**
 * Ensure the project holds a repository row pointing at the public GitHub
 * repo, added through the same API the seed adds its `app` row through
 * (seed.sh `create_repo`: `POST /api/v1/projects/{id}/repos`). Idempotent:
 * a same-named row with the same remote is reused; a same-named row with a
 * different remote is left alone and the suite fails honestly instead of
 * overwriting someone else's row.
 */
async function ensureGitHubRepository(page: Page, projectId: string): Promise<string> {
  const list = await page.request.get(`${BASE_URL}/api/v1/projects/${projectId}/repos`);
  expect(list.status(), "list the project's repositories").toBe(200);
  const body = (await list.json()) as {
    items?: { id: string; name: string; git_url: string }[];
  };
  const existing = (body.items ?? []).find((row) => row.name === REPO_NAME);
  if (existing) {
    expect(
      existing.git_url,
      `${REPO_NAME} already exists but points at ${existing.git_url}, not ${GITHUB_URL}`,
    ).toContain(GITHUB_REPO);
    return existing.name;
  }
  // Mutations are CSRF-guarded (internal/api/middleware.go): the session's
  // csrf_token must ride X-CSRF-Token and an Origin naming this server, the
  // exact shape the seed's lib.sh `req` replays (GET /api/v1/me, then the
  // token + Origin on the mutation). A bare POST answers 403 without them.
  const me = await page.request.get(`${BASE_URL}/api/v1/me`);
  expect(me.status(), "read the session's csrf token (GET /api/v1/me)").toBe(200);
  const { csrf_token: csrf } = (await me.json()) as { csrf_token: string };
  const created = await page.request.post(`${BASE_URL}/api/v1/projects/${projectId}/repos`, {
    data: { name: REPO_NAME, git_url: GITHUB_URL, default_branch: "main" },
    headers: { Origin: BASE_URL, "X-CSRF-Token": csrf },
  });
  expect(
    created.status(),
    `add repository ${REPO_NAME} -> ${GITHUB_URL} (POST /projects/${projectId}/repos)`,
  ).toBe(201);
  return REPO_NAME;
}

/** One validated run input as `GET /runs/{runId}` reports it (RunInputValue). */
interface RunInput {
  name: string;
  value: unknown;
  origin: string;
}

/**
 * The run's `run_inputs` through the API the openapi names for it: `GET
 * /api/v1/runs/{runId}` answers with the validated `inputs` — one row per
 * declared input, value plus `origin` (`submitted`/`default`/`override`).
 */
async function runInputsOf(page: Page, runId: string): Promise<RunInput[]> {
  const response = await page.request.get(`${BASE_URL}/api/v1/runs/${runId}`);
  expect(
    response.status(),
    `GET /api/v1/runs/${runId} answered ${response.status()} (want 200)`,
  ).toBe(200);
  const body = (await response.json()) as { inputs?: unknown };
  if (!Array.isArray(body.inputs)) {
    throw new Error(`run ${runId} answered without an inputs array`);
  }
  return body.inputs as RunInput[];
}

test.describe("W3 start a run from a GitHub issue", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(
    !M5_ENABLED,
    "Needs the M4 lab stack (ports 18091-18093) — run with COMMUNICATION_E2E_M5=1",
  );

  let adminContext: BrowserContext;
  let aliceContext: BrowserContext;
  let admin: Page;
  let alice: Page;
  let pipelinePath = ""; // /workflows/{pipelineId}
  let projectPath = ""; // /p/{M4 Exit id}
  let runId = "";
  let issueNumber = 0;
  let issueTitle = "";

  test.beforeAll(async ({ browser }) => {
    adminContext = await browser.newContext();
    aliceContext = await browser.newContext();
    admin = await adminContext.newPage();
    alice = await aliceContext.newPage();
  });

  test.afterAll(async () => {
    for (const context of [adminContext, aliceContext]) {
      if (context) await context.close();
    }
  });

  test("the lab is seeded and both identities sign in", async ({ request }) => {
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
    await test.step("admin (org admin) and alice (project maintainer) sign in", async () => {
      // The seed's claim shape exactly: a re-login must not rewrite the lab's
      // stored profiles, so no `name` claim is invented here.
      await signIn(alice, ALICE.subject, { email: `${ALICE.subject}@example.test` });
      await expect(alice.getByTestId("user-badge")).toHaveText(ALICE.name);
      await signIn(admin, ADMIN.subject, { email: `${ADMIN.subject}@example.test` });
      await expect(admin.getByTestId("user-badge")).toHaveText(ADMIN.name);
    });
  });

  test("admin authors and publishes the issue-run pipeline", async () => {
    await test.step(`Workflows → New workflow ${SLUG} → its draft`, async () => {
      // Any template only seeds a draft to replace: the editor is then filled
      // with the issue-run document whole, the way m5-journey replaces its
      // clone with the process.exec twin.
      await gotoApp(admin, "/workflows");
      await expect(admin.getByTestId("library-page")).toBeVisible();
      // Design 1c: the New workflow dialog is the index's only creation
      // surface — a name, the id derived from it (changed here to the
      // suite's own slug), and the starter as a card.
      await admin.getByTestId("workflows-new-workflow").click();
      await expect(admin.getByTestId("new-workflow-dialog")).toBeVisible();
      await admin.getByTestId("library-new-name-input").fill(SLUG);
      await admin.getByTestId("new-workflow-id-change").click();
      await admin.getByTestId("library-new-slug-input").fill(SLUG);
      await admin.getByTestId("new-workflow-template-plan-with-approval").click();
      await admin.getByTestId("library-new-submit").click();
      await admin.waitForURL(/\/workflows\/[0-9a-f-]{36}\/drafts\/[0-9a-f-]{36}$/);
      pipelinePath = `/workflows/${new URL(admin.url()).pathname.split("/")[2]}`;
      // The Studio's YAML view is the same authoring surface the old editor
      // exposed as its textarea.
      await admin.getByTestId("studio-view-yaml").click();
      await admin.getByTestId("studio-yaml").fill(ISSUE_PIPELINE_YAML.replace("__SLUG__", SLUG));
      await expect(admin.getByTestId("studio-yaml")).toHaveValue(/issue_number/);
      await expect(admin.getByTestId("studio-yaml")).toHaveValue(/kind: process\.exec/);
      await shot(admin, "m5w3-01-issue-draft");
    });
    await test.step("Save → Validate → the server says valid", async () => {
      await admin.getByTestId("studio-save").click();
      await expect(admin.getByTestId("studio-dirty")).toHaveCount(0, { timeout: 30_000 });
      await admin.getByTestId("studio-validate").click();
      // Publish is gated on the stored verdict, so the verdict is the gate.
      await expect(admin.getByTestId("studio-validate-verdict")).toContainText(/^valid —/, {
        timeout: 30_000,
      });
      await expect(admin.getByTestId("studio-publish")).toBeEnabled();
    });
    await test.step("Publish → r1 is immutable and listed", async () => {
      await admin.getByTestId("studio-publish").click();
      await expect(admin.getByTestId("studio-published")).toContainText("published as r1", {
        timeout: 30_000,
      });
      await gotoApp(admin, pipelinePath);
      await expect(admin.getByTestId("revision-row-1")).toContainText("r1");
      await shot(admin, "m5w3-02-published-r1");
    });
  });

  test("alice pins a GitHub repository row and assigns the pipeline", async () => {
    await test.step("the M4 Exit project is visible to its maintainer", async () => {
      projectPath = await openProjectBySlug(alice, ALICE.projectSlug);
      await shot(alice, "m5w3-03-project");
    });
    await test.step(`repository ${REPO_NAME} -> ${GITHUB_REPO} (via the API)`, async () => {
      // The row the picker will read; the run's own worker-side checkout is
      // never asserted — run_inputs are recorded at creation, before any clone.
      const projectId = projectPath.split("/").pop() ?? "";
      await ensureGitHubRepository(alice, projectId);
    });
    await test.step("the project's pipelines page assigns r1", async () => {
      await gotoApp(alice, `${projectPath}/pipelines`);
      await expect(alice.getByTestId("project-pipelines")).toBeVisible();
      await alice.getByTestId(`assign-open-${SLUG}`).click();
      await expect(alice.getByTestId(`assign-pinning-${SLUG}`)).toContainText("r1", {
        timeout: 30_000,
      });
      await alice.getByTestId(`assign-confirm-${SLUG}`).click();
      // Assigned: the form leaves the assignable list.
      await expect(alice.getByTestId(`assign-form-${SLUG}`)).toHaveCount(0, {
        timeout: 30_000,
      });
      await shot(alice, "m5w3-04-assigned");
    });
  });

  test("the issue picker lists the live tracker and prefills the declared inputs", async () => {
    // The live GitHub read inside this test can hold the bounded wait, so
    // the test's own timeout covers it plus the rest of its steps.
    test.setTimeout(GITHUB_TIMEOUT_MS + 120_000);
    await test.step("the New run form offers exactly the revision's spec.inputs", async () => {
      await gotoApp(alice, `${projectPath}/runs`);
      await expect(alice.getByTestId("project-runs")).toBeVisible();
      await alice.getByTestId("runs-new").click();
      await expect(alice.getByTestId("new-run-form")).toBeVisible();
      await selectByOptionText(alice, "new-run-assignment", SLUG);
      // The three declared inputs, one control each.
      await expect(alice.getByTestId("new-run-input-repository")).toBeVisible();
      // The form's testid is `new-run-input-${field.name}` and the field name
      // is the spec.inputs property key, which keeps its underscore.
      await expect(alice.getByTestId("new-run-input-issue_number")).toBeVisible();
      await expect(alice.getByTestId("new-run-input-goal")).toBeVisible();
    });
    await test.step("choosing the GitHub repository opens the issue picker", async () => {
      await selectByOptionText(alice, "new-run-input-repository", REPO_NAME);
      await expect(alice.getByTestId("issue-section")).toBeVisible();
      await alice.getByTestId("issue-section-toggle").click();
    });
    await test.step("the first listed issue is a real row from the tracker", async () => {
      const body = alice.locator("#issue-section-body");
      const rows = body.locator('[data-testid^="issue-row-"]');
      let sawUpstreamError = false;
      let sawEmptyList = false;
      try {
        await expect
          .poll(
            async () => {
              // The picker's own failure surface: a problem alert (upstream
              // error / budget / no network) or its honest "no open issues"
              // line. Either one means the GitHub arm cannot be proven here.
              if ((await body.locator('[role="alert"]').count()) > 0) sawUpstreamError = true;
              if ((await body.getByTestId("issue-list-empty").count()) > 0) sawEmptyList = true;
              return rows.count();
            },
            { timeout: GITHUB_TIMEOUT_MS, intervals: [2_000] },
          )
          .toBeGreaterThan(0);
      } catch (error) {
        if (sawUpstreamError) {
          test.skip(
            true,
            "GitHub could not be read from the lab (upstream error in the issue list) — W3's " +
              "live-picker arm is unproven here; never passing without a real issue",
          );
        }
        if (sawEmptyList) {
          test.skip(
            true,
            `GitHub answered with no open issues for ${GITHUB_REPO} — nothing to pick; not passing`,
          );
        }
        throw error;
      }
      const firstTestid = (await rows.first().getAttribute("data-testid")) ?? "";
      const number = Number(firstTestid.replace(/^issue-row-/, ""));
      expect(
        Number.isInteger(number) && number > 0,
        `issue row ${firstTestid} names a number`,
      ).toBe(true);
      issueNumber = number;
      issueTitle = (await rows.first().getByTestId(`issue-title-${number}`).innerText()).trim();
      expect(issueTitle.length > 0, `issue #${number} has a title`).toBe(true);
    });
    await test.step("using it prefills exactly what issueValuesFor promises", async () => {
      await alice.getByTestId(`issue-use-${issueNumber}`).click();
      // The number into the integer input, the `#N <title>` heading into goal
      // (`issueValuesFor`: goal gets the heading plus the body when there is
      // one, so the heading is asserted as a prefix, not an exact value).
      await expect(alice.getByTestId("new-run-input-issue_number")).toHaveValue(
        String(issueNumber),
      );
      await expect(alice.getByTestId("new-run-input-goal")).toHaveValue(
        new RegExp(`^#${issueNumber} ${escapeRegExp(issueTitle)}`),
      );
      // The note names the filled inputs in the canonical spec.inputs order
      // (goal, issue_number), not the spec's, so assert the names and the
      // `from #N` suffix separately.
      const fillNote = await alice.getByTestId("issue-fill-note").innerText();
      expect(fillNote).toContain(`from #${issueNumber}`);
      expect(fillNote).toContain("issue_number");
      expect(fillNote).toContain("goal");
      await shot(alice, "m5w3-05-issue-prefilled");
    });
  });

  test("the started run records the issue in its run_inputs", async () => {
    await test.step("start the run from the prefilled form", async () => {
      await alice.getByTestId("new-run-submit").click();
      // Route contract C1: the workbench is the project-less `/runs/:runId`.
      await alice.waitForURL(/\/runs\/[0-9a-f-]{36}$/);
      runId = new URL(alice.url()).pathname.split("/").pop() ?? "";
      expect(runId).toMatch(/^[0-9a-f-]{36}$/);
      await shot(alice, "m5w3-06-run-started");
    });
    await test.step("run_inputs carry the issue number and the #N <title> heading", async () => {
      const heading = new RegExp(`^#${issueNumber} ${escapeRegExp(issueTitle)}`);
      // run_inputs are recorded in the creating transaction, so the read is
      // bounded and short — the bound exists for the read model, not for a worker.
      await expect
        .poll(
          async () => {
            const inputs = await runInputsOf(alice, runId);
            return inputs.find((input) => input.name === "issue_number")?.value;
          },
          {
            timeout: RUN_READ_TIMEOUT_MS,
            message: "the run never recorded issue_number in its inputs",
          },
        )
        .toBe(issueNumber);
      const inputs = await runInputsOf(alice, runId);
      const number = inputs.find((input) => input.name === "issue_number");
      const goal = inputs.find((input) => input.name === "goal");
      expect(goal, "the run recorded its goal input").toBeTruthy();
      expect(
        typeof goal?.value === "string" && heading.test(goal.value),
        `goal run_input ${JSON.stringify(goal?.value)} starts with the issue heading`,
      ).toBe(true);
      // What the picker wrote is a submitted value, not a default the server
      // filled in behind the form's back.
      for (const input of [number, goal] as (RunInput | undefined)[]) {
        if (!input) continue;
        expect(input.origin, `${input.name} origin`).toBe("submitted");
      }
      await shot(alice, "m5w3-07-run-inputs");
    });
    // The run itself (a worker cloning the public repo and running one printf
    // node) is out of scope for this suite's assertion — run_inputs are the
    // W3 record — and is left to settle on its own, added and never reset.
  });
});
