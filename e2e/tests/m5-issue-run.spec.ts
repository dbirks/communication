// Wishlist W3, e2e half: "start a run from a GitHub issue"
// (docs/design/wishlist-gap.md, ADR-0031). The journey this proves:
//
//   1. alice's project holds a repository row whose remote is a PUBLIC GitHub
//      repo with open issues — the one docs/compatibility/GITHUB.md records as
//      really called (mattpocock/skills, anonymous `GET /repos/{o}/{r}/issues`,
//      2026-10-16). The row is added through the API the seed adds its `app`
//      row through (`POST /api/v1/projects/{id}/repos`), idempotently, and
//      never reset afterwards.
//   2. a pipeline whose `spec.inputs` declares the ADR-0066 `github_issue`
//      input (`issue`, `type: object`, annotated `x-communication-input`) plus
//      the `repository` and `goal` strings that travel with it is authored and
//      published through the library's own draft path, the way the M5 exit
//      journey authors its pipeline.
//   3. the repository page's workflow-row `Run` opens the 1k run form carrying
//      that repo (design 1k: the `repository` input is prefilled and
//      read-only) and its searchable issue picker (ADR-0066's `github_issue`
//      widget) lists the live tracker; the chosen issue rides the form as the
//      ADR's runtime shape `{number, title, body, url, repo}`.
//   4. the started run's `run_inputs` (read back through `GET /runs/{runId}`'s
//      validated `inputs`, per api/openapi.yaml) carry that issue (and the
//      carried `repository`) with `origin: submitted` — the record the control
//      plane keeps, not the
//      UI's own echo.
//
// It runs against the M4 lab by env override only, the same gate idiom as
// tests/m5-journey.spec.ts:
//   COMMUNICATION_E2E_M5=1 \
//   E2E_BASE_URL=http://localhost:18091 E2E_API_A_URL=http://localhost:18092 \
//   E2E_API_B_URL=http://localhost:18093 pnpm exec playwright test tests/m5-issue-run.spec.ts
//
// The picker's list is a LIVE read of api.github.com. When
// E2E_GITHUB_READ_TOKEN_FILE names a token file the suite gives the
// repository row an ADR-0061 `integration_broker` credential, so the lab
// reads GitHub AUTHENTICATED (5000 requests/hour — what acceptance.yml's
// lab-e2e job does with the run's GITHUB_TOKEN, which makes the leg
// deterministic on shared CI egress IPs); without it the read stays
// anonymous (ADR-0031, 60 requests/hour per egress IP — fine locally).
// Either way the suite never skips on GitHub's account: a leg that cannot
// list and pick a real issue FAILS, naming the cause. Every wait is bounded.
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { BASE_URL } from "./env.js";
import { gotoApp, openProjectBySlug, shot, signIn } from "./helpers.js";

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
// the only remote this suite ever calls — anonymously, or authenticated
// through the row's ADR-0061 credential when E2E_GITHUB_READ_TOKEN_FILE is set.
const GITHUB_REPO = "mattpocock/skills";
const GITHUB_URL = `https://github.com/${GITHUB_REPO}`;

// Stamped, so a re-run of the suite on the same lab adds its own definitions
// (like m5-journey's) instead of colliding with the previous run's rows.
const stamp = process.env.E2E_M5_STAMP ?? new Date().toISOString().slice(11, 19).replace(/:/g, "");
const SLUG = `m5-issue-${stamp}`;
const REPO_NAME = `m5gh-${stamp}`;
/** The ADR-0061 credential secret carrying the GitHub read token. */
const CREDENTIAL_SLUG = `m5gh-read-${stamp}`;

/** A bounded wait for the live GitHub read the issue picker depends on. */
const GITHUB_TIMEOUT_MS = Number(process.env.E2E_M5_GITHUB_TIMEOUT_MS ?? 60_000);
/** `run_inputs` are recorded in the creating transaction — a short bound. */
const RUN_READ_TIMEOUT_MS = 30_000;

/** Escape a live issue title for use inside a RegExp assertion. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The ADR-0061 GitHub read token, or null for today's anonymous behaviour.
 * Set E2E_GITHUB_READ_TOKEN_FILE (a 0600 file the acceptance workflow
 * writes from the run's GITHUB_TOKEN) and the suite attaches the token to
 * its repository row as an integration_broker credential, so the picker's
 * read is authenticated. The token value never enters argv, a log line or
 * the repository row — it goes only into the secret's create/rotate body.
 */
function githubReadToken(): string | null {
  const file = process.env.E2E_GITHUB_READ_TOKEN_FILE;
  if (!file) return null;
  const token = readFileSync(file, "utf8").trim();
  if (token === "") {
    throw new Error(
      `E2E_GITHUB_READ_TOKEN_FILE=${file} is empty — the m5 GitHub read needs a non-empty token (ADR-0061 credential)`,
    );
  }
  return token;
}

/**
 * The session's CSRF token: mutations ride X-CSRF-Token + an Origin naming
 * this server (internal/api/middleware.go), the exact shape the seed's
 * lib.sh `req` replays (GET /api/v1/me, then the token + Origin on the
 * mutation). A bare POST answers 403 without them.
 */
async function csrfHeaders(page: Page): Promise<Record<string, string>> {
  const me = await page.request.get(`${BASE_URL}/api/v1/me`);
  expect(me.status(), "read the session's csrf token (GET /api/v1/me)").toBe(200);
  const { csrf_token: csrf } = (await me.json()) as { csrf_token: string };
  return { Origin: BASE_URL, "X-CSRF-Token": csrf };
}

/**
 * Ensure the project holds the integration_broker secret (ADR-0061) whose
 * token the control plane sends as `Authorization: Bearer` on this
 * repository's issue reads, and return its id. A stamped slug under a
 * stable E2E_M5_STAMP can predate this run — and a workflow's GITHUB_TOKEN
 * dies with its run — so a pre-existing row is rotated to the current
 * token rather than trusted to still be live.
 */
async function ensureGitHubReadCredential(
  page: Page,
  projectId: string,
  headers: Record<string, string>,
  token: string,
): Promise<string> {
  const list = await page.request.get(`${BASE_URL}/api/v1/projects/${projectId}/secrets`);
  expect(list.status(), "list the project's secrets").toBe(200);
  const body = (await list.json()) as {
    secrets?: { id: string; slug: string; delivery_mode: string }[];
  };
  const existing = (body.secrets ?? []).find((row) => row.slug === CREDENTIAL_SLUG);
  if (existing) {
    expect(
      existing.delivery_mode,
      `${CREDENTIAL_SLUG} already exists but is ${existing.delivery_mode}, not integration_broker`,
    ).toBe("integration_broker");
    const rotated = await page.request.post(
      `${BASE_URL}/api/v1/projects/${projectId}/secrets/${existing.id}/versions`,
      { data: { value: token }, headers },
    );
    expect(
      rotated.status(),
      `rotate ${CREDENTIAL_SLUG} to this run's token (POST /secrets/${existing.id}/versions)`,
    ).toBe(201);
    return existing.id;
  }
  const created = await page.request.post(`${BASE_URL}/api/v1/projects/${projectId}/secrets`, {
    data: {
      slug: CREDENTIAL_SLUG,
      purpose: "github_repo",
      delivery_mode: "integration_broker",
      scope: "project",
      value: token,
    },
    headers,
  });
  expect(
    created.status(),
    `create the ${CREDENTIAL_SLUG} integration_broker secret (POST /projects/${projectId}/secrets)`,
  ).toBe(201);
  const { id } = (await created.json()) as { id: string };
  return id;
}

/**
 * The pipeline the journey publishes: one deterministic `process.exec` node
 * (no model endpoint on the lab) whose only job is to prove the authoring
 * path, and `spec.inputs` that declare the ADR-0066 typed issue input
 * (`issue`, `type: object` annotated `github_issue` — the shape the searchable
 * picker writes) plus the required `repository` and `goal` strings. The
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
    Run started from a GitHub issue: the searchable issue picker reads the
    live tracker, and the run records the picked issue in run_inputs.
spec:
  inputs:
    type: object
    required: [repository, issue, goal]
    properties:
      repository:
        type: string
        minLength: 1
        description: Project repository binding name, e.g. app.
      issue:
        type: object
        x-communication-input: {type: github_issue, label: Issue, help: The tracker issue this run starts from}
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
 * With a GitHub read token (E2E_GITHUB_READ_TOKEN_FILE) the row is created
 * with, or patched to, the ADR-0061 credential so the picker's issue read
 * is authenticated; without one the row stays anonymous, exactly as before.
 */
async function ensureGitHubRepository(
  page: Page,
  projectId: string,
  readToken: string | null,
): Promise<string> {
  const list = await page.request.get(`${BASE_URL}/api/v1/projects/${projectId}/repos`);
  expect(list.status(), "list the project's repositories").toBe(200);
  const body = (await list.json()) as {
    items?: { id: string; name: string; git_url: string; credential?: string }[];
  };
  const existing = (body.items ?? []).find((row) => row.name === REPO_NAME);
  const headers = await csrfHeaders(page);
  const credentialSecretId =
    readToken === null
      ? null
      : await ensureGitHubReadCredential(page, projectId, headers, readToken);
  if (existing) {
    expect(
      existing.git_url,
      `${REPO_NAME} already exists but points at ${existing.git_url}, not ${GITHUB_URL}`,
    ).toContain(GITHUB_REPO);
    if (credentialSecretId !== null) {
      // Patch even when a credential already reads `configured`: under a
      // stable stamp it may be a dead workflow run's expired GITHUB_TOKEN.
      // The credential is the ADR-0061 patch's one field.
      const patched = await page.request.patch(
        `${BASE_URL}/api/v1/projects/${projectId}/repos/${existing.id}`,
        { data: { credential_secret_id: credentialSecretId }, headers },
      );
      expect(
        patched.status(),
        `attach ${CREDENTIAL_SLUG} to ${REPO_NAME} (PATCH /repos/${existing.id})`,
      ).toBe(200);
    }
    return existing.name;
  }
  const created = await page.request.post(`${BASE_URL}/api/v1/projects/${projectId}/repos`, {
    data: {
      name: REPO_NAME,
      git_url: GITHUB_URL,
      default_branch: "main",
      ...(credentialSecretId === null ? {} : { credential_secret_id: credentialSecretId }),
    },
    headers,
  });
  expect(
    created.status(),
    `add repository ${REPO_NAME} -> ${GITHUB_URL} (POST /projects/${projectId}/repos)`,
  ).toBe(201);
  if (credentialSecretId !== null) {
    const repo = (await created.json()) as { credential?: string };
    expect(
      repo.credential,
      `${REPO_NAME} was created without the ADR-0061 credential attached`,
    ).toBe("configured");
  }
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
  let goalText = "";

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
      await expect(admin.getByTestId("studio-yaml")).toHaveValue(/github_issue/);
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
      // Design 1e: the revision rows list on the workflow page's History tab.
      await gotoApp(admin, `${pipelinePath}/history`);
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
      // never asserted — run_inputs are recorded at creation, before any
      // clone. With E2E_GITHUB_READ_TOKEN_FILE the row carries the ADR-0061
      // credential, so the picker's read is authenticated (5000/hr); without
      // it the read stays anonymous (60/hr per egress IP).
      const projectId = projectPath.split("/").pop() ?? "";
      await ensureGitHubRepository(alice, projectId, githubReadToken());
    });
    await test.step("the project's Workflows tab uses r1 (the picker's one verb)", async () => {
      // Design project-1b-workflows: the tab is ONE panel of 2e rows — the
      // inline assign form is gone and the tab's one way in is the
      // `+ use a library workflow` picker, whose single `Use` verb resolves
      // the newest published revision and posts the whole-project pin.
      await gotoApp(alice, `${projectPath}/pipelines`);
      await expect(alice.getByTestId("project-pipelines")).toBeVisible();
      await expect(
        alice
          .getByTestId("project-workflows-list")
          .or(alice.getByTestId("project-workflows-empty"))
          .first(),
      ).toBeVisible({ timeout: 30_000 });
      await alice.getByTestId("project-workflow-library").click();
      await expect(alice.getByTestId("project-library-dialog")).toBeVisible();
      // The picker names the workflow with the revision it pins — the newest
      // published, r1 (the reading that replaces the retired inline pin line).
      await expect(alice.getByTestId(`project-library-row-${SLUG}`)).toContainText(
        /latest r1(?!\d)/,
        {
          timeout: 30_000,
        },
      );
      const use = alice.getByTestId(`project-library-use-${SLUG}`);
      const used = alice.getByTestId(`project-library-used-${SLUG}`);
      await expect(use.or(used).first()).toBeVisible({ timeout: 30_000 });
      if (await use.isVisible().catch(() => false)) {
        await use.click();
        // The picker closes only on the create's success — a refusal stays
        // open with the reason inline (project-library-error). This exit is
        // the successor of the form leaving the assignable list.
        await expect(alice.getByTestId("project-library-dialog")).toHaveCount(0, {
          timeout: 30_000,
        });
      } else {
        // One whole-project assignment per pipeline is the store's UNIQUE:
        // the picker prints `used in the project` instead of a `Use` button
        // that could only ever 409 (a re-run's already-assigned state).
        await expect(used).toBeVisible({ timeout: 30_000 });
        await alice.getByTestId("project-library-cancel").click();
      }
      // Assigned: the panel itself now carries the workflow as its own 2e
      // row pinned to r1 — the `✓ rN` chip is the tab's whole revision story.
      const pipelineId = pipelinePath.split("/").pop() ?? "";
      const pinnedRow = alice
        .locator('[data-testid^="project-workflow-row-"]')
        .filter({ has: alice.locator(`a[href$="${pipelineId}"]`) });
      await expect(pinnedRow).toBeVisible({ timeout: 30_000 });
      await expect(pinnedRow.locator('[data-testid^="project-workflow-revision-"]')).toContainText(
        /\br1\b/,
        { timeout: 30_000 },
      );
      await shot(alice, "m5w3-04-assigned");
    });
  });

  test("the repo row's Run opens the issue picker over the live tracker and the picked issue rides the form", async () => {
    // The live GitHub read inside this test can hold the bounded wait, so
    // the test's own timeout covers it plus the rest of its steps.
    test.setTimeout(GITHUB_TIMEOUT_MS + 120_000);
    const pipelineId = pipelinePath.split("/").pop() ?? "";
    await test.step("the repo row's Run opens the form carrying that repository", async () => {
      // Design 1k: `Run` on the repository page's workflow row opens the ONE
      // run dialog carrying that repo (subtitle + read-only repository
      // field), and the issue picker scopes to the repo it carries.
      await gotoApp(alice, `${projectPath}/${REPO_NAME}`);
      await expect(alice.getByTestId("repo-page")).toBeVisible({ timeout: 30_000 });
      const row = alice
        .locator('[data-testid^="repo-workflow-row-"]')
        .filter({ has: alice.locator(`a[href$="${pipelineId}"]`) });
      await expect(row).toBeVisible({ timeout: 30_000 });
      await row.locator('[data-testid^="repo-workflow-run-"]').first().click();
      await expect(alice.getByTestId("run-form-dialog")).toBeVisible({ timeout: 15_000 });
      await expect(alice.getByTestId("new-run-form")).toBeVisible();
      // The carried repo: the subtitle names it, the declared `repository`
      // input arrives prefilled and read-only (1k) — never retyped.
      await expect(alice.getByTestId("run-form-subtitle")).toContainText(
        new RegExp(`^${escapeRegExp(REPO_NAME)} · pinned r1`),
      );
      const repository = alice.getByTestId("new-run-input-repository");
      await expect(repository).toHaveValue(REPO_NAME);
      await expect(repository).toHaveAttribute("aria-readonly", "true");
      // The three declared inputs, one control each: the ADR-0066 searchable
      // picker for `issue` and the goal text field.
      await expect(alice.getByTestId("new-run-input-issue-picker")).toBeVisible();
      await expect(alice.getByTestId("new-run-input-goal")).toBeVisible();
    });
    await test.step("the first listed issue is a real row from the tracker", async () => {
      const list = alice.getByTestId("new-run-input-issue-options");
      const rows = list.locator('[data-testid^="new-run-input-issue-option-"]');
      const deadline = Date.now() + GITHUB_TIMEOUT_MS;
      let sawUpstreamError = false;
      let sawEmptyList = false;
      // The picker reads the tracker ONCE per mount (ui/src/api/issues.ts:
      // `retry: false`, so one refusal is not retried into a second read).
      // On Actions this read is AUTHENTICATED (the row's ADR-0061 credential,
      // 5000 requests/hour) and the first mount answers; the bounded remount
      // loop (close the dialog, open it again — a fresh mount asks the
      // tracker again) is the local anonymous arm's only grace (60 requests/
      // hour per shared egress IP). When the window is spent the leg FAILS,
      // naming the cause — never skips. An empty list is final either way:
      // there is nothing to pick and the leg cannot be proven.
      for (let attempt = 1; ; attempt++) {
        sawUpstreamError = false;
        sawEmptyList = false;
        await alice.getByTestId("new-run-input-issue").click({ timeout: 15_000 });
        await expect(list).toBeVisible({ timeout: 15_000 });
        const attemptWindowMs = Math.max(5_000, Math.min(20_000, deadline - Date.now()));
        try {
          await expect
            .poll(
              async () => {
                // The picker's own failure surface: its problem row (upstream
                // error / budget / no network) or its honest no-match line.
                // Either one means the GitHub arm cannot be proven here.
                if ((await alice.getByTestId("new-run-input-issue-error").count()) > 0)
                  sawUpstreamError = true;
                if ((await alice.getByTestId("new-run-input-issue-empty").count()) > 0)
                  sawEmptyList = true;
                return rows.count();
              },
              { timeout: attemptWindowMs, intervals: [2_000] },
            )
            .toBeGreaterThan(0);
          break;
        } catch {
          if (sawEmptyList) {
            throw new Error(
              `GitHub answered with no open issues for ${GITHUB_REPO} after ${attempt} read(s) — ` +
                "the picker has nothing to pick and this leg cannot be proven (a FAILURE by design: " +
                "this suite never skips on GitHub's account)",
            );
          }
          if (Date.now() >= deadline) {
            if (sawUpstreamError) {
              throw new Error(
                `GitHub could not be read from the lab after ${attempt} read(s) over ` +
                  `${GITHUB_TIMEOUT_MS} ms — the picker's issue list only ever answered with its ` +
                  "upstream-error row. On Actions the repository row's ADR-0061 credential is the " +
                  "cause to check (lab-e2e writes E2E_GITHUB_READ_TOKEN_FILE from the run's " +
                  "GITHUB_TOKEN and this spec attaches it to " +
                  `${REPO_NAME}); locally an unset E2E_GITHUB_READ_TOKEN_FILE means the anonymous ` +
                  "60 requests/hour budget per egress IP is spent or api.github.com is unreachable " +
                  "from the lab. Failing with a named cause, never skipping.",
              );
            }
            throw new Error(
              `the issue picker listed nothing for ${GITHUB_REPO} over ${attempt} read(s) ` +
                `without naming a reason (neither GitHub's upstream-error row nor the honest ` +
                "empty row ever appeared) — failing, never skipping",
            );
          }
          // Close this dialog and open a fresh one: the remount is the retry.
          await alice.keyboard.press("Escape");
          await expect(alice.getByTestId("run-form-dialog")).toHaveCount(0, { timeout: 10_000 });
          const row = alice
            .locator('[data-testid^="repo-workflow-row-"]')
            .filter({ has: alice.locator(`a[href$="${pipelineId}"]`) });
          await row.locator('[data-testid^="repo-workflow-run-"]').first().click();
          await expect(alice.getByTestId("run-form-dialog")).toBeVisible({ timeout: 15_000 });
          await expect(alice.getByTestId("new-run-form")).toBeVisible();
        }
      }
      const firstTestid = (await rows.first().getAttribute("data-testid")) ?? "";
      const number = Number(firstTestid.replace(/^new-run-input-issue-option-/, ""));
      expect(
        Number.isInteger(number) && number > 0,
        `issue row ${firstTestid} names a number`,
      ).toBe(true);
      issueNumber = number;
      issueTitle = (await rows.first().locator("span[title]").first().getAttribute("title")) ?? "";
      expect(issueTitle.length > 0, `issue #${number} has a title`).toBe(true);
    });
    await test.step("picking it puts the issue on the form", async () => {
      await alice.getByTestId(`new-run-input-issue-option-${issueNumber}`).click();
      // The picker settles on the picked issue (`#<number>` in the field),
      // and goal carries the heading the person is signing up to deliver.
      await expect(alice.getByTestId("new-run-input-issue")).toHaveValue(`#${issueNumber}`);
      goalText = `#${issueNumber} ${issueTitle} — W3 journey`;
      await alice.getByTestId("new-run-input-goal").fill(goalText);
      await shot(alice, "m5w3-05-issue-prefilled");
    });
  });

  test("the started run records the issue in its run_inputs", async () => {
    // This leg starts the run the leg above filled in. If that leg could not
    // read the tracker it FAILED there, naming the cause — this suite never
    // skips, and in serial mode this leg never runs after that failure.
    await test.step("start the run from the prefilled form", async () => {
      // Bounded so a form that cannot submit says so here instead of spending
      // the leg's whole budget inside one click.
      await alice.getByTestId("new-run-submit").click({ timeout: 15_000 });
      // Route contract C1: the workbench is the project-less `/runs/:runId`.
      await alice.waitForURL(/\/runs\/[0-9a-f-]{36}$/);
      runId = new URL(alice.url()).pathname.split("/").pop() ?? "";
      expect(runId).toMatch(/^[0-9a-f-]{36}$/);
      await shot(alice, "m5w3-06-run-started");
    });
    await test.step("run_inputs carry the issue as ADR-0066's shape, with the carried repository", async () => {
      // run_inputs are recorded in the creating transaction, so the read is
      // bounded and short — the bound exists for the read model, not for a worker.
      await expect
        .poll(
          async () => {
            const inputs = await runInputsOf(alice, runId);
            return inputs.find((input) => input.name === "issue")?.value;
          },
          {
            timeout: RUN_READ_TIMEOUT_MS,
            message: "the run never recorded its issue input",
          },
        )
        .toBeTruthy();
      const inputs = await runInputsOf(alice, runId);
      const issue = inputs.find((input) => input.name === "issue");
      const repository = inputs.find((input) => input.name === "repository");
      const goal = inputs.find((input) => input.name === "goal");
      // The picked issue rides the ADR's runtime shape: the number the
      // tracker named, the title it carries, and the owner/repo it came from.
      const value = (issue?.value ?? {}) as Record<string, unknown>;
      expect(value.number, "issue.number is the picked row's number").toBe(issueNumber);
      expect(value.title, "issue.title is the picked row's title").toBe(issueTitle);
      expect(value.repo, "issue.repo names the GitHub tracker read").toBe(GITHUB_REPO);
      expect(
        typeof goal?.value === "string" &&
          new RegExp(`^#${issueNumber} ${escapeRegExp(issueTitle)}`).test(goal.value),
        `goal run_input ${JSON.stringify(goal?.value)} starts with the issue heading`,
      ).toBe(true);
      // What the form carries is a submitted value, not a default the server
      // filled in behind the form's back.
      for (const input of [issue, repository, goal] as (RunInput | undefined)[]) {
        if (!input) continue;
        expect(input.origin, `${input.name} origin`).toBe("submitted");
      }
      expect(repository?.value, "the carried repo names the repository row").toBe(REPO_NAME);
      await shot(alice, "m5w3-07-run-inputs");
    });
    // The run itself (a worker cloning the public repo and running one printf
    // node) is out of scope for this suite's assertion — run_inputs are the
    // W3 record — and is left to settle on its own, added and never reset.
  });
});
