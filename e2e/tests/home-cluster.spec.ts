// Home proof (docs/home-cluster.md § 2 click path, § 5 read-only verify
// checks): sign in through the UI against the target — the live cluster by
// default (tsidp OIDC, no credentials in this file, ever) or the local M4
// lab on opt-in (mock OIDC IdP, E2E_HOME_LOGIN_SUBJECT) — create a project
// with the public https://github.com/dbirks/communication repository,
// publish and run the vetted "Plan with approval" sample, approve its gate
// as the owner, and prove the attempts ran on the target's workers through § 5's reads
// (GET /api/v1/workers, /api/v1/runs/{id}/checkpoints,
// /api/v1/system/scheduler). Then author a one-node agent.acp pipeline on
// the claude launcher profile, run it, and read its summary — or record the
// § 3 finding (unattended permission_mode:ask cancels, does not answer) with
// the evidence.
//
// Skipped unless COMMUNICATION_E2E_HOME=1 (the orchestrator sets it once the
// new image is deployed):
//   COMMUNICATION_E2E_HOME=1 \
//     E2E_HOME_URL=https://communication.beluga-wyvern.ts.net \
//     pnpm exec playwright test tests/home-cluster.spec.ts
//
// The same six-step proof runs unchanged against the local M4 lab (mock OIDC
// IdP, http://localhost:18091): set E2E_HOME_LOGIN_SUBJECT to a seeded
// subject (e.g. admin) to sign in through the lab's interactive form
// instead of tsidp, and point E2E_BASE_URL at the lab too — the shared
// signIn helper resolves relative navigation against the playwright
// config's baseURL (e2e/tests/env.ts). Worker identity is read from the
// API (GET /api/v1/workers, the attempts' checkpoints), so the same checks
// are real on both targets:
//   COMMUNICATION_E2E_HOME=1 \
//     E2E_HOME_URL=http://localhost:18091 E2E_BASE_URL=http://localhost:18091 \
//     E2E_HOME_LOGIN_SUBJECT=admin \
//     pnpm exec playwright test tests/home-cluster.spec.ts
//
// This suite WRITES (project, repository, two pipelines, two runs, one agent
// profile) and resets nothing. Names carry a timestamp stamp (overridable
// through E2E_HOME_STAMP); a project with the exact name an interrupted
// earlier run created is reused instead of recreated, and its repository
// binding is added only when absent. Every API call below is a GET — the
// cluster's CSRF middleware passes GET/HEAD untouched and the suite makes no
// API POST at all (every write goes through the UI), so no CSRF token or
// Origin juggling is needed here. Every wait is bounded: a run that never
// reaches its gate fails the suite rather than hanging it.

import {
  test,
  expect,
  type BrowserContext,
  type Page,
  type Response as PWResponse,
} from "@playwright/test";
import {
  addRepository,
  expectRunStatus,
  rowFor,
  selectByOptionText,
  shot,
  signIn,
  shortRefOf,
} from "./helpers.js";

const HOME_ENABLED = process.env.COMMUNICATION_E2E_HOME === "1";
/** The target (default: the live cluster, docs/home-cluster.md § 1); overridable for the proof. */
const HOME_BASE_URL = process.env.E2E_HOME_URL ?? "https://communication.beluga-wyvern.ts.net";
const HOME_ORIGIN = new URL(HOME_BASE_URL).origin;

/** Whether a browser response is a refused write to the APP's own API. Only
 * non-GET/HEAD answers from the target's origin on a /api/ path count, and
 * only 4xx/5xx verdicts — a 3xx redirect is a navigation, not a refusal.
 * That excludes the lab's mock-IdP login-form POST (a redirect to a
 * different origin, e.g. localhost:18095), which is sign-in plumbing made
 * by the shared signIn helper, not an app write the suite depends on. */
function isRefusedWriteResponse(response: PWResponse): boolean {
  const method = response.request().method();
  if (method === "GET" || method === "HEAD") return false;
  const status = response.status();
  if (status < 400) return false; // 2xx accepted, 3xx redirect — not a refusal
  let url: URL;
  try {
    url = new URL(response.url());
  } catch {
    return false;
  }
  return url.origin === HOME_ORIGIN && url.pathname.startsWith("/api/");
}

/**
 * The mock-IdP subject to sign in as through the lab's interactive form
 * (the seeded identities; e2e/tests/helpers.ts' signIn — the subject plus a
 * derived email claim, exactly as m5-inbox.spec.ts does, no invented name
 * claim). Set for the local M4 lab run: step 1 then takes that path instead
 * of the tsidp redirect loop. Unset: the unchanged tsidp behaviour.
 */
const HOME_LOGIN_SUBJECT = process.env.E2E_HOME_LOGIN_SUBJECT ?? "";
/** Lab mode: mock-OIDC sign-in through the lab's form, not tsidp. */
const LAB_MODE = HOME_LOGIN_SUBJECT !== "";
/** The target's report title: the lab when opted in, the cluster by default. */
const TARGET_TITLE = LAB_MODE ? "Home lab" : "Home cluster";

/**
 * The timestamp stamp. The generated default is lowercased and slug-safe by
 * construction: PLAN_SLUG and CLAUDE_SLUG travel into the library's slug
 * field and must match the API's pipeline rule m4SlugPattern
 * `^[a-z][a-z0-9.-]{0,127}$` (internal/api/pipelines.go) — the earlier
 * uppercase `T` from toISOString() made POST /api/v1/pipelines answer 422
 * and the create step hang ~45 minutes behind an unbounded waitForURL.
 */
const stamp =
  process.env.E2E_HOME_STAMP ??
  new Date().toISOString().slice(0, 19).replace(/[-:]/g, "").toLowerCase();
const PROJECT_NAME = `Home proof ${stamp}`;
const PLAN_SLUG = `home-plan-${stamp}`;
const CLAUDE_SLUG = `home-claude-${stamp}`;
const PROFILE_NAME = `home-profile-${stamp}`;
const REPO_URL = "https://github.com/dbirks/communication";
/** The binding name this suite types into the Add repository form (§ 2 step
 * 2); recorded in the summary, never assumed. */
const REPO_BINDING = "communication";
const GOAL = "Summarize how the worker claims attempts";

/**
 * The API's slug rules, mirrored here so a bad stamp (or E2E_HOME_STAMP)
 * fails at suite load with the rule in the error — not as a 422 on the
 * live cluster: PLAN_SLUG and CLAUDE_SLUG must match m4SlugPattern
 * (internal/api/pipelines.go); the server derives the project slug from
 * PROJECT_NAME via prjDeriveSlug and checks prjSlugPattern
 * (internal/api/projects.go); PROFILE_NAME is free text capped at 200
 * (internal/api/agent_profiles.go).
 */
const PIPELINE_SLUG_PATTERN = /^[a-z][a-z0-9.-]{0,127}$/; // m4SlugPattern
const PROJECT_SLUG_PATTERN = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/; // prjSlugPattern

/** prjDeriveSlug (internal/api/projects.go), mirrored: lowercase, runs of
 * non-alphanumerics collapsed to one '-', trimmed, at most 40 characters. */
function deriveProjectSlug(name: string): string {
  const slashed = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slashed.length > 40 ? slashed.slice(0, 40).replace(/-+$/, "") : slashed;
}

for (const slug of [PLAN_SLUG, CLAUDE_SLUG]) {
  if (!PIPELINE_SLUG_PATTERN.test(slug)) {
    throw new Error(
      `${slug} does not match the pipeline slug rule ${PIPELINE_SLUG_PATTERN.source} ` +
        `(internal/api/pipelines.go m4SlugPattern) — fix the stamp or E2E_HOME_STAMP`,
    );
  }
}
{
  const derived = deriveProjectSlug(PROJECT_NAME);
  if (!PROJECT_SLUG_PATTERN.test(derived)) {
    throw new Error(
      `project name ${PROJECT_NAME} derives the slug "${derived}", which does not match ` +
        `the project slug rule ${PROJECT_SLUG_PATTERN.source} (internal/api/projects.go prjSlugPattern)`,
    );
  }
  if (PROFILE_NAME.length > 200) {
    throw new Error(`profile name ${PROFILE_NAME} exceeds the 200-character agent profile cap`);
  }
}

/**
 * The one-paragraph README summary. The first sentence is the brief's
 * verbatim prompt; the JSON instruction is the probe plan node's shape
 * (docs/compatibility/probes/m4/pipeline.yaml): structuredOutput extraction
 * (internal/worker/agentturn.go § 4 step 6) only accepts a JSON object, so a
 * prose-only reply is `invalid_output`, not a summary.
 */
const AGENT_PROMPT = [
  "Read README.md and reply with a one-paragraph summary.",
  "Reply with JSON of exactly this shape:",
  '{"summary": "<the one-paragraph summary>"}',
  "summary is one non-empty plain-text string and nothing else.",
].join("\n");

/** A bounded wait for the worker to clone, survey and model-plan before the gate. */
const GATE_TIMEOUT_MS = Number(process.env.E2E_HOME_GATE_TIMEOUT_MS ?? 900_000);
/** A bounded wait for the post-gate leg (clone, model, artifact). */
const RUN_TIMEOUT_MS = Number(process.env.E2E_HOME_RUN_TIMEOUT_MS ?? 900_000);
/** The Claude ACP turn is measured in model round-trips, not milliseconds. */
const AGENT_TIMEOUT_MS = Number(process.env.E2E_HOME_AGENT_TIMEOUT_MS ?? 900_000);
/** A control-plane status change after a human decision is an advancer tick. */
const DECISION_TIMEOUT_MS = Number(process.env.E2E_HOME_DECISION_TIMEOUT_MS ?? 180_000);
/** Bounded retries for transient live-model failures on the home cluster: the
 * plan node's model.chat has its own 2-minute provider deadline
 * (llm-collective-engineering.com), and a run that timed out there is retried
 * through the UI's own Retry button — the product's own recovery path — not
 * a spec change. A run that fails WITHOUT that transient error class is a
 * genuine product finding and stops the suite. */
const PLAN_RETRY_MAX = Number(process.env.E2E_HOME_PLAN_RETRY_MAX ?? 3);
const TRANSIENT_MODEL_FAILURE = /no completion from .* within .* the attempt's deadline/;

/** The suite's own test budget: gate + post-gate run + agent run, plus slack. */
const TEST_TIMEOUT_MS = GATE_TIMEOUT_MS + RUN_TIMEOUT_MS + 1_800_000;
/**
 * A bounded wait for a post-write navigation. A write that the API refuses
 * never navigates; every such wait carries this bound (or fails faster
 * through waitForNavAfterWrite) so a 422 can never burn the test's own
 * timeout — which is how the earlier uppercase-stamp 422 hung ~45 minutes.
 */
const NAV_TIMEOUT_MS = Number(process.env.E2E_HOME_NAV_TIMEOUT_MS ?? 60_000);

// § 5(c)'s served shapes — read-only, no worker internals (AttemptView has no
// worker_id by construction; the checkpoint row is the attempt's identity).
interface WorkerView {
  id: string;
  name: string;
  hostname: string;
  version: string;
  status: string;
}
interface RunView {
  id: string;
  status: string;
  revision_digest: string;
  plan_digest: string;
}
interface NodeExecutionView {
  id: string;
  node_id: string;
  kind: string;
  status: string;
  outcome: string | null;
  error_class: string | null;
  attempt_count: number;
}
interface NodeExecutionDetailView extends NodeExecutionView {
  attempts: {
    id: string;
    attempt_number: number;
    status: string;
    error_class: string | null;
    detail: string | null;
    outputs: unknown;
  }[];
}
interface CheckpointView {
  node_execution_id: string;
  node_instance_key: string;
  worker_id: string;
}
interface WorkerList {
  items: WorkerView[];
}
interface SchedulerView {
  workers: { worker_id: string; name: string; capacity: number }[];
}

/** A GET through the signed-in browser context's request context (its
 * cookies, no CSRF — GET/HEAD pass the middleware untouched). */
async function getJson<T>(context: BrowserContext, path: string): Promise<T> {
  const response = await context.request.get(`${HOME_BASE_URL}${path}`);
  expect(response.status(), `GET ${path} must answer 200, got ${response.status()}`).toBe(200);
  return (await response.json()) as T;
}

/**
 * Navigate inside the home app. The helpers' gotoApp resolves relative paths
 * against the playwright config's baseURL (the lab stack), so the home suite
 * roots every navigation at HOME_BASE_URL itself, keeping the 502-retry loop.
 */
async function gotoApp(page: Page, path = "/"): Promise<void> {
  const url = `${HOME_BASE_URL}${path.startsWith("/") ? path : `/${path}`}`;
  for (let attempt = 1; attempt <= 10; attempt++) {
    const response = await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => null);
    if (response && response.ok()) return;
    await page.waitForTimeout(1_000);
  }
  throw new Error(`the home app never answered 200 for ${path} at ${url}`);
}

/**
 * A bounded wait for the navigation a UI write must produce. The write's
 * own API response is the fact: a non-2xx on the POST/PUT/PATCH/DELETE
 * behind the navigation rejects the wait immediately — with the API's
 * status and body — instead of burning NAV_TIMEOUT_MS on a page that will
 * never navigate (the 422'd template submit that hung the earlier run).
 */
async function waitForNavAfterWrite(
  page: Page,
  matcher: RegExp,
  what: string,
  timeoutMs: number = NAV_TIMEOUT_MS,
): Promise<void> {
  let refuse: (error: Error) => void = () => {};
  const refusal = new Promise<never>((_, reject) => {
    refuse = reject;
  });
  const onResponse = (response: PWResponse): void => {
    if (!isRefusedWriteResponse(response)) return;
    void response.text().then(
      (body) =>
        refuse(
          new Error(
            `${what}: the API refused the write with ${response.status()} ` +
              `${response.url()}: ${body.slice(0, 1_500)}`,
          ),
        ),
      () =>
        refuse(
          new Error(
            `${what}: the API refused the write with ${response.status()} ${response.url()}`,
          ),
        ),
    );
  };
  page.on("response", onResponse);
  try {
    await Promise.race([page.waitForURL(matcher, { timeout: timeoutMs }), refusal]);
  } finally {
    page.off("response", onResponse);
  }
}

/** A bounded poll of a GET that resolves to the first accepted body. */
async function pollGet<T>(
  context: BrowserContext,
  path: string,
  accept: (body: T) => boolean,
  timeoutMs: number,
  what: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await context.request.get(`${HOME_BASE_URL}${path}`);
    if (response.status() === 200) {
      const body = (await response.json()) as T;
      if (accept(body)) return body;
    }
    if (Date.now() >= deadline)
      throw new Error(
        `timed out waiting for ${what} via GET ${path} (last status ${response.status()})`,
      );
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

/**
 * The Claude proof pipeline: ONE agent.acp node, copied in shape from the
 * probe's plan node (repository input, a prompt, a single string output the
 * file declares as `{summary: string}` — the probe's own `summary` output).
 * `workspace: run_workspace` carries the repository checkout the prompt
 * reads, exactly as the probe's implement node does. `__SLUG__` /
 * `__PROFILE__` / `__PROMPT__` are rewritten on the way into the draft
 * editor, the way the library's own template picker rewrites metadata.name.
 */
const CLAUDE_PIPELINE = `# home-cluster Claude proof: one agent.acp step with the claude launcher
# profile — the probe plan node (docs/compatibility/probes/m4/pipeline.yaml)
# reduced to the shape this suite asserts: repository input, a README prompt
# and {summary: string} outputs.
apiVersion: communication.dev/v1alpha1
kind: Pipeline
metadata:
  name: __SLUG__
  description: >-
    One Claude ACP step that reads the repository README.md and replies with
    a one-paragraph summary.
spec:
  inputs:
    type: object
    required: [repository]
    properties:
      repository:
        type: string
        minLength: 1
        description: Project repository binding name, e.g. ${REPO_BINDING}.
  outputs:
    type: object
    required: [summary]
    properties:
      summary: {type: string}
  policies:
    maxConcurrentNodes: 1
    maxDurationSeconds: 7200
    maxNodeExecutions: 20
    maxChildDepth: 0
    workspaceMode: worktree
    cancelPolicy: cascade
  nodes:
  - id: read_readme
    kind: agent.acp
    timeoutSeconds: 900
    config:
      profile: __PROFILE__
      sessionMode: new
      workspace:
        mode: run_workspace
        repositories: ['\${{ inputs.repository }}']
      prompt: |
__PROMPT__
    outputs:
      type: object
      required: [summary]
      properties:
        summary: {type: string}
  resultBindings:
    summary: \${{ nodes.read_readme.outputs.summary }}
`;

/** The prompt as the editor must hold it: a YAML block scalar, 8-column indent. */
const CLAUDE_PROMPT_BLOCK = AGENT_PROMPT.split("\n")
  .map((line) => `        ${line}`)
  .join("\n");

test.describe(`${TARGET_TITLE} proof — § 2 click path, § 5 read-only verify`, () => {
  test.describe.configure({ mode: "serial", timeout: TEST_TIMEOUT_MS });
  test.skip(
    !HOME_ENABLED,
    LAB_MODE
      ? "Needs the local M4 lab — run with COMMUNICATION_E2E_HOME=1 (E2E_HOME_URL, E2E_BASE_URL, E2E_HOME_LOGIN_SUBJECT)"
      : "Needs the live home cluster — run with COMMUNICATION_E2E_HOME=1 (E2E_HOME_URL)",
  );

  let context: BrowserContext;
  let page: Page;
  let displayName = "";
  let projectPath = ""; // /projects/{id}
  let projectId = "";
  let planPipelinePath = ""; // /library/{pipelineId}
  let planRunId = "";
  let claudeRunId = "";
  let profileId = "";
  /** § 5 evidence gathered as the proof unfolds; the last test prints it. */
  const evidence: string[] = [];
  /** API write responses that were refused (non-2xx); any one is a step failure. */
  const refusedWrites: { method: string; url: string; status: number; body: string }[] = [];
  /** A recorded finding (the § 3 unattended-ask cancellation), if it happened. */
  let finding = "";

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext();
    page = await context.newPage();
    // Every UI write here is a POST/PUT/PATCH/DELETE to the app's own API:
    // record a refused (4xx/5xx) answer (status + body) so the owning step
    // fails with the server's own verdict instead of a bare timeout.
    // isRefusedWriteResponse keeps sign-in plumbing (the mock-IdP form POST)
    // and other-origin traffic out of the record.
    page.on("response", (response) => {
      if (!isRefusedWriteResponse(response)) return;
      const method = response.request().method();
      void response.text().then(
        (body) =>
          refusedWrites.push({
            method,
            url: response.url(),
            status: response.status(),
            body: body.slice(0, 1_500),
          }),
        () =>
          refusedWrites.push({
            method,
            url: response.url(),
            status: response.status(),
            body: "(body unreadable)",
          }),
      );
    });
  });

  test.afterAll(async () => {
    if (context) await context.close();
  });

  test(
    LAB_MODE
      ? `step 1 — sign in through the UI (lab mock OIDC as ${HOME_LOGIN_SUBJECT})`
      : "step 1 — sign in through the UI (tsidp OIDC, no credentials here)",
    async () => {
      await test.step(`the target (${HOME_BASE_URL}) answers readiness`, async () => {
        await expect
          .poll(
            async () => {
              try {
                return (await context.request.get(`${HOME_BASE_URL}/api/v1/system/readiness`)).ok();
              } catch {
                return false;
              }
            },
            { timeout: 120_000, intervals: [2_000] },
          )
          .toBe(true);
      });
      if (LAB_MODE) {
        await test.step(`sign in through the lab's mock-IdP form as ${HOME_LOGIN_SUBJECT}`, async () => {
          // The shared signIn helper (e2e/tests/helpers.ts) navigates
          // relative to the playwright config's baseURL (E2E_BASE_URL,
          // e2e/tests/env.ts), so a lab run must point that base at the
          // same target the rest of the suite reads. The helper fills the
          // IdP's interactive form (no real credentials) and waits for the
          // signed-in badge itself.
          const configBase = (process.env.E2E_BASE_URL ?? "http://localhost:28080").replace(
            /\/+$/,
            "",
          );
          if (configBase !== HOME_BASE_URL.replace(/\/+$/, "")) {
            throw new Error(
              `E2E_HOME_LOGIN_SUBJECT=${HOME_LOGIN_SUBJECT} needs E2E_BASE_URL to match ` +
                `the target (${HOME_BASE_URL}): the shared signIn helper resolves ` +
                `relative navigation against the config's baseURL`,
            );
          }
          // Exactly as m5-inbox.spec.ts: the seeded subject plus the derived
          // email claim — no invented name claim.
          await signIn(page, HOME_LOGIN_SUBJECT, { email: `${HOME_LOGIN_SUBJECT}@example.test` });
          await expect(page.getByTestId("user-badge")).toHaveText(HOME_LOGIN_SUBJECT);
          displayName = HOME_LOGIN_SUBJECT;
          console.log(`signed in as: ${displayName} (via ${HOME_BASE_URL}, lab mock OIDC)`);
        });
      } else {
        await test.step("follow the login redirects until /api/v1/me answers 200", async () => {
          // The browser on this tailnet machine is already signed in to tsidp, so
          // the OIDC redirect chain closes on its own — no password, no form.
          // /api/v1/me is the session's own fact; the display name is read from
          // the served /me body, and tokens/cookies are never read or stored.
          await page.goto(`${HOME_BASE_URL}/`, { waitUntil: "domcontentloaded" }).catch(() => {});
          // The app may land on /login with the provider link instead of the
          // signed-in badge: click it and let the redirect chain close. The
          // browser on this tailnet machine is already signed in to tsidp, so no
          // password or form is ever filled. Loop: /me decides; the link is
          // re-clicked only when the flow failed and /login shows it again.
          const providerLink = page.getByRole("link", {
            name: /Sign in with OIDC/,
          });
          const meDeadline = Date.now() + 120_000;
          let me: { display_name?: string; name?: string } | undefined;
          for (;;) {
            const response = await context.request
              .get(`${HOME_BASE_URL}/api/v1/me`)
              .catch(() => null);
            if (response && response.status() === 200) {
              const body = (await response.json()) as { display_name?: string; name?: string };
              if (body.display_name ?? body.name) {
                me = body;
                break;
              }
            }
            if (Date.now() >= meDeadline) break;
            if (await providerLink.isVisible().catch(() => false)) {
              await page
                .goto(`${HOME_BASE_URL}/login`, { waitUntil: "domcontentloaded" })
                .catch(() => {});
              await providerLink.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
              if (await providerLink.isVisible().catch(() => false)) {
                await providerLink.click();
              }
              // The OIDC round trip closes on its own; give it room before the
              // next /me probe so a mid-flight 401 never triggers a re-click.
              await new Promise((resolve) => setTimeout(resolve, 15_000));
              continue;
            }
            await new Promise((resolve) => setTimeout(resolve, 2_000));
          }
          expect(me, "the signed-in /api/v1/me body after the provider redirect").toBeDefined();
          displayName = me!.display_name ?? me!.name ?? "";
          expect(displayName, "the signed-in /me body must carry a display name").not.toBe("");
          console.log(`signed in as: ${displayName} (via ${HOME_BASE_URL}, tsidp OIDC)`);
        });
      }
      await test.step("the app shows the signed-in badge", async () => {
        await gotoApp(page, "/");
        await expect(page.getByTestId("user-badge")).toBeVisible({ timeout: 60_000 });
        await shot(page, "home-00-signed-in");
      });
    },
  );

  test("step 2 — create the project (or reuse it) and add the repository", async () => {
    // Sign-in (step 1) traffic is already excluded by isRefusedWriteResponse;
    // still start from a clean record so only this step's writes are judged.
    refusedWrites.length = 0;
    await test.step("an earlier run's same-named project is reused, never duplicated", async () => {
      await gotoApp(page, "/");
      // A fresh target (or account) has the empty message instead of the
      // list; wait for whichever the served state is.
      await expect(
        page.getByTestId("project-list").or(page.getByTestId("project-list-empty")).first(),
      ).toBeVisible({ timeout: 30_000 });
      const existing = page
        .locator('[data-testid^="project-card-"]')
        .filter({ hasText: PROJECT_NAME });
      if ((await existing.count()) > 0) {
        await existing.first().locator('[data-testid^="project-link-"]').click();
        await page.waitForURL(/\/projects\/[0-9a-f-]{36}\/?$/, { timeout: NAV_TIMEOUT_MS });
        console.log(`reusing existing project: ${PROJECT_NAME}`);
      } else {
        await test.step("New project through the form (§ 2 step 2)", async () => {
          // The form starts open only on an empty account; otherwise the
          // toggle reveals it.
          const nameField = page.getByTestId("create-project-name");
          if (!(await nameField.isVisible().catch(() => false))) {
            await page.getByTestId("new-project-toggle").click();
          }
          await nameField.fill(PROJECT_NAME);
          await page.getByTestId("create-project-submit").click();
          await waitForNavAfterWrite(page, /\/projects\/[0-9a-f-]{36}\/?$/, "create the project");
        });
      }
      projectPath = new URL(page.url()).pathname;
      projectId = projectPath.split("/").pop() ?? "";
      expect(projectId).toMatch(/^[0-9a-f-]{36}$/);
      evidence.push(`project: ${PROJECT_NAME} (${shortRefOf(projectId)})`);
    });
    await test.step("add the public repository; the binding name is the form's name", async () => {
      // The binding row and the empty list are both rendered only after the
      // repositories fetch resolves; settle on one of them before branching.
      await expect(
        rowFor(page, REPO_BINDING).or(page.getByTestId("repo-list-empty")).first(),
      ).toBeVisible({ timeout: 30_000 });
      if (
        await rowFor(page, REPO_BINDING)
          .isVisible()
          .catch(() => false)
      ) {
        console.log(`repository binding already present: ${REPO_BINDING}`);
      } else {
        await addRepository(page, `${HOME_BASE_URL}${projectPath}`, REPO_BINDING, REPO_URL);
      }
      evidence.push(`repository binding: ${REPO_BINDING} -> ${REPO_URL}`);
      assertNoRefusedWrites("step 2 — project and repository setup");
      await shot(page, "home-01-project-repo");
    });
  });

  test("step 3 — Plan with approval: validate, publish r1, assign", async () => {
    refusedWrites.length = 0;
    // A re-run must not re-POST a definition under an already-used slug (the
    // server 409s the duplicate): a same-slug pipeline row is reused instead,
    // and when its r1 is already published the Validate/Publish steps are
    // skipped because the stored revision is the fact.
    let publishedAlready = false;
    await test.step("Library → the plan pipeline (created once, reused on re-runs)", async () => {
      await gotoApp(page, "/library");
      await expect(page.getByTestId("library-page")).toBeVisible();
      await expect(
        page.getByTestId("pipeline-library").or(page.getByTestId("pipeline-library-empty")).first(),
      ).toBeVisible({ timeout: 30_000 });
      const existing = page.getByTestId(`pipeline-name-${PLAN_SLUG}`);
      if (await existing.isVisible().catch(() => false)) {
        await existing.click();
        await page.waitForURL(/\/library\/[0-9a-f-]{36}$/, { timeout: NAV_TIMEOUT_MS });
        planPipelinePath = new URL(page.url()).pathname;
        const revisions = await pipelineRevisions(planPipelinePath);
        const r1 = revisions.find((row) => row.revision_number === 1);
        if (r1?.status !== "published") {
          throw new Error(
            `reused pipeline ${PLAN_SLUG} has no published r1 ` +
              `(status: ${r1?.status ?? "absent"}) — an interrupted earlier run left it ` +
              `half-published; delete the pipeline from the library and re-run`,
          );
        }
        expect(r1.revision_digest, "the reused pipeline's r1 digest").toMatch(
          /^sha256:[0-9a-f]{64}$/,
        );
        console.log(`reusing plan pipeline r1: ${r1.revision_digest}`);
        evidence.push(`plan r1 revision_digest (reused): ${r1.revision_digest}`);
        publishedAlready = true;
        await shot(page, "home-02-reused-pipeline");
      } else {
        await page.getByTestId("library-new-slug-input").fill(PLAN_SLUG);
        await page.getByTestId("library-new-name-input").fill(PLAN_SLUG);
        await selectByOptionText(page, "library-new-template-select", "Plan with approval");
        await page.getByTestId("library-new-submit").click();
        // A template is not a revision: the click path lands on the seeded
        // draft's Workflow Studio, at /library/:id/drafts/:draftId. A 422
        // (e.g. an illegal slug) never navigates and fails the wait with
        // the API's status and body.
        await waitForNavAfterWrite(
          page,
          /\/library\/[0-9a-f-]{36}\/drafts\/[0-9a-f-]{36}$/,
          "create the plan pipeline",
        );
        planPipelinePath = `/library/${new URL(page.url()).pathname.split("/")[2]}`;
        // The Studio's YAML view is the same authoring surface the old
        // editor exposed as its textarea.
        await page.getByTestId("studio-view-yaml").click();
        await expect(page.getByTestId("studio-yaml")).toHaveValue(new RegExp(PLAN_SLUG));
        await shot(page, "home-02-template-draft");
      }
    });
    if (!publishedAlready) {
      await test.step("Validate → the server's stored verdict is valid", async () => {
        await page.getByTestId("studio-validate").click();
        // Publish is gated on the stored verdict, so the verdict is the gate.
        await expect(page.getByTestId("studio-validate-verdict")).toContainText(/^valid —/, {
          timeout: 30_000,
        });
        await expect(page.getByTestId("studio-publish")).toBeEnabled();
      });
      await test.step("Publish → r1 carries the revision digest", async () => {
        await page.getByTestId("studio-publish").click();
        await expect(page.getByTestId("studio-published")).toContainText("published as r1", {
          timeout: 30_000,
        });
        const revisions = await pipelineRevisions(planPipelinePath);
        const r1 = revisions.find((row) => row.revision_number === 1);
        expect(r1?.revision_digest, "published r1 must carry a revision digest").toMatch(
          /^sha256:[0-9a-f]{64}$/,
        );
        console.log(`plan pipeline r1 revision_digest: ${r1?.revision_digest}`);
        evidence.push(`plan r1 revision_digest: ${r1?.revision_digest}`);
        await shot(page, "home-03-published-r1");
      });
    }
    await test.step("assign r1 to the project (Maintainer+ on the project)", async () => {
      await gotoApp(page, `${projectPath}/pipelines`);
      await expect(page.getByTestId("project-pipelines")).toBeVisible();
      const open = page.getByTestId(`assign-open-${PLAN_SLUG}`);
      const assignment = page.getByTestId(`pipeline-assignment-${PLAN_SLUG}`);
      // The assign button and the pin chip are both rendered by the
      // project-pipelines list once its fetch settles; settle on either
      // branch's marker before deciding which one is present.
      await expect(open.or(assignment).first()).toBeVisible({ timeout: 30_000 });
      if (await open.isVisible().catch(() => false)) {
        await open.click();
        await expect(page.getByTestId(`assign-pinning-${PLAN_SLUG}`)).toContainText("r1", {
          timeout: 30_000,
        });
        await page.getByTestId(`assign-confirm-${PLAN_SLUG}`).click();
        await expect(page.getByTestId(`assign-form-${PLAN_SLUG}`)).toHaveCount(0, {
          timeout: 30_000,
        });
      } else {
        // One assignment per pipeline is the store's UNIQUE, so the assign
        // button renders only while the assignment is absent: its absence plus
        // the project's own pin chip is the already-assigned state (re-run).
        await expect(assignment).toBeVisible({ timeout: 30_000 });
        console.log(`already assigned to the project: ${PLAN_SLUG}`);
        evidence.push(`assignment (reused): ${PLAN_SLUG} r1 pinned to the project`);
      }
      assertNoRefusedWrites("step 3 — plan pipeline publish and assign");
      await shot(page, "home-04-assigned");
    });
  });

  /** Print and record the refused-write state: a non-2xx API answer on a
   * write fails the calling step with the server's status and body. */
  function assertNoRefusedWrites(what: string): void {
    const refused = refusedWrites.map(
      (write) => `${write.method} ${write.url} -> ${write.status}: ${write.body}`,
    );
    expect(
      refused,
      `${what}: the API refused a write the suite depends on — ${refused.join(" | ")}`,
    ).toEqual([]);
  }

  /** GET the pipeline's stored revisions (route 13) behind a /library path. */
  async function pipelineRevisions(
    path: string,
  ): Promise<{ revision_number: number; revision_digest: string; status: string }[]> {
    const pipelineId = path.slice("/library/".length);
    const body = await getJson<{
      revisions: { revision_number: number; revision_digest: string; status: string }[];
    }>(context, `/api/v1/pipelines/${pipelineId}/revisions`);
    return body.revisions;
  }

  /**
   * Take the one-node claude document through the Workflow Studio's YAML
   * view: fill → save → validate → publish r1. The caller is either already
   * on the Studio route `/library/:pipelineId/drafts/:draftId` (the Blank
   * create navigates straight there) or on the pipeline page, where the
   * draft is the page's own state: an existing `draft-row-*` is selected
   * when the page lists one (the resume of an interrupted run), otherwise
   * the page's "New draft" control (`pipeline-new-draft`) is the click —
   * with zero published revisions it posts the blank skeleton named for
   * the slug, so the control is enabled by construction. Every wait is
   * bounded; the only failure left is the page's own query settling on
   * neither a row nor an enabled control.
   */
  async function authorFirstRevision(slug: string): Promise<void> {
    if (!/\/library\/[0-9a-f-]{36}\/drafts\/[0-9a-f-]{36}$/.test(page.url())) {
      const draftRow = page.getByTestId(/^draft-row-.+$/).first();
      // Settle the drafts list first: it shows either a row or its own
      // `drafts-empty` line, and the decision below must not race the query.
      await expect(draftRow.or(page.getByTestId("drafts-empty")).first()).toBeVisible({
        timeout: 30_000,
      });
      if (await draftRow.isVisible()) {
        // An interrupted run left the draft: select it and finish the
        // publish from wherever it stopped.
        await draftRow.click();
      } else {
        // No row: "New draft" posts the skeleton (nothing to clone at zero
        // revisions) and the Studio route opens.
        const newDraft = page.getByTestId("pipeline-new-draft");
        await expect(newDraft).toBeEnabled({ timeout: 30_000 });
        await newDraft.click();
      }
      await page.waitForURL(/\/library\/[0-9a-f-]{36}\/drafts\/[0-9a-f-]{36}$/, {
        timeout: 30_000,
      });
    }
    await page.getByTestId("studio-view-yaml").click();
    const editor = page.getByTestId("studio-yaml");
    await expect(editor).toBeVisible({ timeout: 30_000 });
    const document = CLAUDE_PIPELINE.replace("__SLUG__", slug)
      .replace("__PROFILE__", PROFILE_NAME)
      .replace("__PROMPT__", CLAUDE_PROMPT_BLOCK);
    await editor.fill(document);
    await page.getByTestId("studio-save").click();
    await expect(page.getByTestId("studio-dirty")).toHaveCount(0, {
      timeout: 30_000,
    });
    await page.getByTestId("studio-validate").click();
    await expect(page.getByTestId("studio-validate-verdict")).toContainText(/^valid —/, {
      timeout: 30_000,
    });
    await page.getByTestId("studio-publish").click();
    await expect(page.getByTestId("studio-published")).toContainText("published as r1", {
      timeout: 30_000,
    });
  }

  /**
   * The § 5(c) reads that pin a run's attempts to a named worker: the attempt
   * view carries NO worker id by construction, so the identity travels through
   * the checkpoint row's worker_id, which must name a worker GET /api/v1/
   * workers serves (its `name` is COMMUNICATION_WORKER_NAME: the pod name
   * on the cluster, the lab's own worker name on the local lab).
   * Returns the worker names the run's checkpoints pin.
   */
  async function workerNamesForRun(runId: string): Promise<string[]> {
    const workers = (await getJson<WorkerList>(context, `/api/v1/workers`)).items;
    const byId = new Map(workers.map((worker) => [worker.id, worker.name]));
    const checkpoints = await getJson<{
      checkpoints: CheckpointView[];
    }>(context, `/api/v1/runs/${runId}/checkpoints`);
    const bound = checkpoints.checkpoints.map((checkpoint) => checkpoint.worker_id);
    const unknown = bound.filter((id) => !byId.has(id));
    expect(
      unknown,
      `checkpoint worker_ids not served by GET /api/v1/workers: ${unknown.join(", ")}`,
    ).toEqual([]);
    const names = [...new Set(bound.map((id) => byId.get(id) ?? ""))];
    return names.filter((name) => name.length > 0);
  }

  /** Print and record § 5(c)'s worker evidence for one run. */
  async function recordWorkerEvidence(label: string, runId: string): Promise<void> {
    const names = await workerNamesForRun(runId);
    expect(
      names.length,
      `${label}: the run's checkpoints must pin at least one worker`,
    ).toBeGreaterThan(0);
    console.log(`${label} ran on worker(s) of ${HOME_BASE_URL}: ${names.join(", ")}`);
    evidence.push(`${label} checkpoints -> worker(s): ${names.join(", ")}`);
    const workers = (await getJson<WorkerList>(context, `/api/v1/workers`)).items;
    const online = workers.filter((worker) => worker.status === "online").map((w) => w.name);
    evidence.push(`GET /api/v1/workers online: [${online.join(", ")}]`);
    console.log(`GET /api/v1/workers online: [${online.join(", ")}]`);
    const scheduler = await getJson<SchedulerView>(context, `/api/v1/system/scheduler`);
    const loads = scheduler.workers
      .map((worker) => `${worker.name} (capacity ${worker.capacity})`)
      .join(", ");
    evidence.push(`GET /api/v1/system/scheduler workers: [${loads}]`);
    console.log(`GET /api/v1/system/scheduler workers: [${loads}]`);
  }

  /**
   * Bounded poll of the served run status until it leaves the running states
   * for one of `targets`. Terminal statuses are stable; a run that is still
   * past the bounded window throws with its last served status.
   */
  async function pollAnyStatus(
    ctx: BrowserContext,
    runId: string,
    targets: string[],
    timeoutMs: number,
  ): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let last = "";
    for (;;) {
      const run = await getJson<RunView>(ctx, `/api/v1/runs/${runId}`);
      last = run.status;
      if (targets.includes(last)) return last;
      if (Date.now() >= deadline) {
        throw new Error(
          `run ${shortRefOf(runId)} never reached ${targets.join(" | ")} ` +
            `(last served status: ${last}) within the bounded wait`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  }

  /**
   * A failed run's nodes re-read: the live model's own deadline ("no
   * completion from … within 2m0s (the attempt's deadline arm, § 4 step 8)")
   * is the one transient this suite may retry through the UI's Retry button.
   * Every failed node must carry that signature; anything else is a product
   * finding the caller must report, not paper over.
   */
  async function isTransientModelFailure(ctx: BrowserContext, runId: string): Promise<boolean> {
    const nodes = await getJson<{ node_executions: NodeExecutionView[] }>(
      ctx,
      `/api/v1/runs/${runId}/nodes`,
    );
    const failed = nodes.node_executions.filter((n) => n.status === "failed");
    if (failed.length === 0) return false;
    for (const node of failed) {
      const detail = await getJson<NodeExecutionDetailView>(
        ctx,
        `/api/v1/runs/${runId}/nodes/${node.id}`,
      );
      const newest = [...detail.attempts].sort((a, b) => b.attempt_number - a.attempt_number)[0];
      const text = [node.error_class, newest?.error_class, newest?.detail]
        .filter(Boolean)
        .join(" ");
      console.log(`  ${node.node_id} (${node.kind}): ${text}`);
      if (!TRANSIENT_MODEL_FAILURE.test(text)) return false;
    }
    return true;
  }

  test(`step 4 — start the run, approve the gate, terminal, ${TARGET_TITLE.toLowerCase()}-worker proof`, async () => {
    refusedWrites.length = 0;
    await test.step("New run: the revision's inputs (goal + the repository binding)", async () => {
      await gotoApp(page, `${projectPath}/runs`);
      await expect(page.getByTestId("project-runs")).toBeVisible();
      await page.getByTestId("runs-new").click();
      await expect(page.getByTestId("new-run-form")).toBeVisible();
      await selectByOptionText(page, "new-run-assignment", PLAN_SLUG);
      await page.getByTestId("new-run-input-goal").fill(GOAL);
      // `repository` is the project binding name, offered as the project's
      // own list — not a URL a user has to remember.
      await selectByOptionText(page, "new-run-input-repository", REPO_BINDING);
      await page.getByTestId("new-run-submit").click();
      await waitForNavAfterWrite(
        page,
        /\/projects\/[0-9a-f-]{36}\/runs\/[0-9a-f-]{36}$/,
        "start the plan run",
      );
      planRunId = new URL(page.url()).pathname.split("/").pop() ?? "";
      expect(planRunId).toMatch(/^[0-9a-f-]{36}$/);
      console.log(`plan run started: ${planRunId}`);
      await shot(page, "home-05-run-started");
    });
    // The live model's own 2-minute provider deadline can fail a plan attempt
    // transiently (run 5: model.chat TIMEOUT on both attempts, then Retry in
    // the UI recovered). Each leg of the run is bounded: before the gate the
    // leg ends when the run parks (the served status `waiting_human`), after
    // the gate it ends when the run is terminal. A leg that fails with the
    // transient live-model signature is retried through the UI's own Retry
    // button; any other failure is a product finding the suite surfaces.
    let afterGate = false;
    for (let retry = 0; ; retry++) {
      const leg = await pollAnyStatus(
        context,
        planRunId,
        ["waiting_human", "completed", "failed"],
        afterGate ? RUN_TIMEOUT_MS : GATE_TIMEOUT_MS,
      );
      if (leg === "completed") break;
      if (leg === "failed") {
        if (!(await isTransientModelFailure(context, planRunId))) {
          // isTransientModelFailure logged every failed node's error_class
          // and newest-attempt detail; that evidence is the product finding.
          throw new Error(
            `plan run ${shortRefOf(planRunId)} failed without the transient live-model ` +
              `deadline signature — reporting it as a product finding (node/attempt ` +
              `evidence in the log above)`,
          );
        }
        if (retry >= PLAN_RETRY_MAX) {
          throw new Error(
            `plan run ${shortRefOf(planRunId)} still transiently failing after ` +
              `${PLAN_RETRY_MAX} retries (live model provider deadline)`,
          );
        }
        console.log(
          `plan run ${shortRefOf(planRunId)} hit the live model's deadline — retrying through the UI's Retry (${retry + 1}/${PLAN_RETRY_MAX})`,
        );
        evidence.push(
          `plan run ${shortRefOf(planRunId)}: transient model.chat deadline failure, UI retry ${retry + 1}`,
        );
        const retryButton = page.getByTestId("run-retry");
        await expect(retryButton).toBeVisible({ timeout: 30_000 });
        await expect(retryButton).toBeEnabled({ timeout: 30_000 });
        await retryButton.click();
        // The advancer re-schedules the failed node; the run leaves the
        // failed state. If it failed again before the next leg read, the loop
        // sees it and counts it as the next retry.
        await pollAnyStatus(
          context,
          planRunId,
          ["queued", "preparing", "running", "waiting_human", "completed"],
          DECISION_TIMEOUT_MS,
        );
        continue;
      }
      // waiting_human — the gate parks the run; approve it as the owner.
      await test.step(`approve the gate in the UI as the owner [${retry ? `retry ${retry}` : "first attempt"}]`, async () => {
        await page.getByTestId("run-stage-cell-approve").click();
        await expect(page.getByTestId("approval-state")).toHaveText("needs your decision", {
          timeout: 30_000,
        });
        await expect(page.getByTestId("approval-node")).toContainText("approve");
        await page.getByTestId("approval-comment").fill(`${TARGET_TITLE} proof — approved.`);
        await page.getByTestId("approval-approve").click();
        await expect(page.getByTestId("approval-decided")).toBeVisible({
          timeout: DECISION_TIMEOUT_MS,
        });
        await shot(page, "home-07-approved");
      });
      afterGate = true;
      await shot(page, "home-06-gate");
    }
    await test.step("the run completes and every node succeeded", async () => {
      await expectRunStatus(page, /completed/, RUN_TIMEOUT_MS);
      const run = await getJson<RunView>(context, `/api/v1/runs/${planRunId}`);
      expect(run.status, "the run's served status").toBe("completed");
      // Both digests: the pinned revision's and the compiled plan's.
      expect(run.revision_digest, "the run's revision_digest").toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(run.plan_digest, "the run's plan_digest").toMatch(/^sha256:[0-9a-f]{64}$/);
      console.log(
        `plan run ${shortRefOf(planRunId)}: revision_digest ${run.revision_digest} / plan_digest ${run.plan_digest}`,
      );
      evidence.push(
        `plan run ${shortRefOf(planRunId)}: completed; revision_digest ${run.revision_digest} / plan_digest ${run.plan_digest}`,
      );
      const nodes = await getJson<{ node_executions: NodeExecutionView[] }>(
        context,
        `/api/v1/runs/${planRunId}/nodes`,
      );
      for (const node of nodes.node_executions) {
        console.log(`  node ${node.node_id} (${node.kind}): ${node.status} ${node.outcome ?? ""}`);
        expect(node.status, `node ${node.node_id} must have succeeded`).toBe("succeeded");
      }
      evidence.push(
        `plan run nodes: ${nodes.node_executions.map((n) => `${n.node_id}=${n.status}`).join(", ")}`,
      );
      assertNoRefusedWrites("step 4 — run approval and completion");
      await shot(page, "home-08-completed");
    });
    await test.step("§ 5(c): the checkpoints pin the attempts to a named worker", async () => {
      await recordWorkerEvidence("plan run", planRunId);
    });
  });

  test("step 5 — one agent.acp node on the claude launcher profile", async () => {
    refusedWrites.length = 0;
    await test.step("the claude-launcher profile exists (created on /agents when absent)", async () => {
      await gotoApp(page, "/agents");
      await expect(page.getByTestId("agents-page")).toBeVisible();
      const rows = page
        .getByTestId("agent-list")
        .locator('[data-testid^="agent-item-"]')
        .filter({ hasText: PROFILE_NAME });
      if ((await rows.count()) === 0) {
        await page.getByTestId("agents-new-name-input").fill(PROFILE_NAME);
        await page.getByTestId("agents-new-launcher-select").selectOption("claude");
        await page.getByTestId("agents-new-submit").click();
        await expect(rows.first()).toBeVisible({ timeout: 30_000 });
        console.log(`created agent profile ${PROFILE_NAME} (claude launcher)`);
      } else {
        console.log(`reusing agent profile ${PROFILE_NAME}`);
      }
      const testid = (await rows.first().getAttribute("data-testid")) ?? "";
      profileId = testid.replace(/^agent-item-/, "");
      expect(profileId).toMatch(/^[0-9a-f-]{36}$/);
      // A profile created through the product can only ever be `ask`
      // (ADR-0030: permission_mode has no write field) — the § 3 caveat's
      // precondition, recorded as evidence.
      await expect(page.getByTestId(`agent-permission-${profileId}`)).toHaveText(
        /^permission: ask$/,
      );
      await expect(page.getByTestId(`agent-launcher-${profileId}`)).toHaveText(
        /^launcher: claude$/,
      );
      evidence.push(`agent profile ${PROFILE_NAME}: launcher claude, permission ask`);
      await shot(page, "home-09-profile");
    });
    await test.step("the one-node pipeline (Blank): r1 published (created once, reused)", async () => {
      await gotoApp(page, "/library");
      await expect(page.getByTestId("library-page")).toBeVisible();
      await expect(
        page.getByTestId("pipeline-library").or(page.getByTestId("pipeline-library-empty")).first(),
      ).toBeVisible({ timeout: 30_000 });
      const existing = page.getByTestId(`pipeline-name-${CLAUDE_SLUG}`);
      if (await existing.isVisible().catch(() => false)) {
        // Re-run: the server would 409 the duplicate slug, so the existing
        // definition is opened and its stored state decides.
        await existing.click();
        await page.waitForURL(/\/library\/[0-9a-f-]{36}$/, { timeout: NAV_TIMEOUT_MS });
        const revisions = await pipelineRevisions(new URL(page.url()).pathname);
        const r1 = revisions.find((row) => row.revision_number === 1);
        if (r1?.status === "published") {
          console.log(`reusing claude pipeline r1: ${r1.revision_digest}`);
          evidence.push(`claude r1 revision_digest (reused): ${r1.revision_digest}`);
          await shot(page, "home-10-claude-reused");
          return;
        }
        if (revisions.length > 0) {
          throw new Error(
            `reused pipeline ${CLAUDE_SLUG} has no published r1 ` +
              `(status: ${r1?.status ?? "absent"}) — an interrupted earlier run left it ` +
              `half-published; delete the pipeline from the library and re-run`,
          );
        }
        // Zero revisions: the legitimate leftover of the Blank path — the
        // definition POST can land with the draft write still to come, so
        // an interrupted run can stop right after the definition. Resume
        // through a draft instead of throwing.
        console.log(`resuming the zero-revision claude pipeline through a draft`);
        await authorFirstRevision(CLAUDE_SLUG);
        await shot(page, "home-10-claude-published");
        return;
      }
      // Blank posts the skeleton as the first draft and navigates the
      // create click straight to the pipeline page with it selected — the
      // navigation is the fact (`waitForNavAfterWrite` semantics: a
      // non-2xx on the write rejects before the wait burns its timeout).
      await page.getByTestId("library-new-slug-input").fill(CLAUDE_SLUG);
      await page.getByTestId("library-new-name-input").fill(CLAUDE_SLUG);
      await selectByOptionText(page, "library-new-template-select", "Blank");
      const created = waitForNavAfterWrite(
        page,
        /\/library\/[0-9a-f-]{36}\/drafts\/[0-9a-f-]{36}$/,
        "create the claude pipeline",
      );
      await page.getByTestId("library-new-submit").click();
      await created;
      await authorFirstRevision(CLAUDE_SLUG);
      await shot(page, "home-10-claude-published");
    });
    await test.step("assign it and start a run on the repository binding", async () => {
      await gotoApp(page, `${projectPath}/pipelines`);
      await expect(page.getByTestId("project-pipelines")).toBeVisible();
      const open = page.getByTestId(`assign-open-${CLAUDE_SLUG}`);
      const assignment = page.getByTestId(`pipeline-assignment-${CLAUDE_SLUG}`);
      // Same assign/already-assigned race as the plan pipeline: settle on
      // either branch's marker before deciding which one is present.
      await expect(open.or(assignment).first()).toBeVisible({ timeout: 30_000 });
      if (await open.isVisible().catch(() => false)) {
        await open.click();
        await expect(page.getByTestId(`assign-pinning-${CLAUDE_SLUG}`)).toContainText("r1", {
          timeout: 30_000,
        });
        await page.getByTestId(`assign-confirm-${CLAUDE_SLUG}`).click();
        await expect(page.getByTestId(`assign-form-${CLAUDE_SLUG}`)).toHaveCount(0, {
          timeout: 30_000,
        });
      } else {
        // Re-run: the assign button renders only while the UNIQUE assignment
        // is absent; its absence plus the project's pin chip is assigned.
        await expect(assignment).toBeVisible({ timeout: 30_000 });
        console.log(`already assigned to the project: ${CLAUDE_SLUG}`);
        evidence.push(`assignment (reused): ${CLAUDE_SLUG} r1 pinned to the project`);
      }
      await gotoApp(page, `${projectPath}/runs`);
      await page.getByTestId("runs-new").click();
      await expect(page.getByTestId("new-run-form")).toBeVisible();
      await selectByOptionText(page, "new-run-assignment", CLAUDE_SLUG);
      await selectByOptionText(page, "new-run-input-repository", REPO_BINDING);
      await page.getByTestId("new-run-submit").click();
      await waitForNavAfterWrite(
        page,
        /\/projects\/[0-9a-f-]{36}\/runs\/[0-9a-f-]{36}$/,
        "start the claude run",
      );
      claudeRunId = new URL(page.url()).pathname.split("/").pop() ?? "";
      expect(claudeRunId).toMatch(/^[0-9a-f-]{36}$/);
      console.log(`claude run started: ${claudeRunId}`);
      await shot(page, "home-11-claude-run-started");
    });
    await test.step("wait for terminal (bounded 15 min) and read the outcome", async () => {
      // Bounded wait for the terminal state (m5 idiom): terminal is stable,
      // so the status is re-read once the matcher has resolved.
      await expect
        .poll(async () => (await getJson<RunView>(context, `/api/v1/runs/${claudeRunId}`)).status, {
          timeout: AGENT_TIMEOUT_MS,
          intervals: [5_000],
          message: `claude run ${shortRefOf(claudeRunId)} never reached a terminal status`,
        })
        .toMatch(/^(completed|failed|cancelled)$/);
      const status = (await getJson<RunView>(context, `/api/v1/runs/${claudeRunId}`)).status;
      console.log(`claude run ${shortRefOf(claudeRunId)} terminal status: ${status}`);
      if (status === "completed") {
        await test.step("the attempt's outputs carry a non-empty summary", async () => {
          const nodes = await getJson<{ node_executions: NodeExecutionView[] }>(
            context,
            `/api/v1/runs/${claudeRunId}/nodes`,
          );
          const node = nodes.node_executions.find((n) => n.kind === "agent.acp");
          expect(node, "the run must carry its agent.acp node execution").toBeDefined();
          expect(node?.status).toBe("succeeded");
          const detail = await getJson<NodeExecutionDetailView>(
            context,
            `/api/v1/runs/${claudeRunId}/nodes/${node?.id}`,
          );
          const attempts = [...detail.attempts].sort((a, b) => b.attempt_number - a.attempt_number);
          const attempt = attempts[0];
          expect(attempt.status, "the newest attempt must have succeeded").toBe("succeeded");
          const outputs = (attempt.outputs ?? {}) as { summary?: unknown };
          const summary = typeof outputs.summary === "string" ? outputs.summary : "";
          expect(summary, "the attempt's outputs must carry a non-empty summary").not.toBe("");
          console.log(`agent summary (first 200 chars): ${summary.slice(0, 200)}`);
          evidence.push(
            `claude run ${shortRefOf(claudeRunId)}: completed; summary ${summary.slice(0, 200)}`,
          );
          await recordWorkerEvidence("claude run", claudeRunId);
          await shot(page, "home-12-claude-completed");
        });
        assertNoRefusedWrites("step 5 — claude pipeline, profile and run");
      } else {
        await test.step("a non-completed outcome is either the recorded § 3 finding or a failure", async () => {
          const nodes = await getJson<{ node_executions: NodeExecutionView[] }>(
            context,
            `/api/v1/runs/${claudeRunId}/nodes`,
          );
          const node = nodes.node_executions.find((n) => n.kind === "agent.acp");
          const detail = node
            ? await getJson<NodeExecutionDetailView>(
                context,
                `/api/v1/runs/${claudeRunId}/nodes/${node.id}`,
              )
            : null;
          const attempt = detail
            ? [...detail.attempts].sort((a, b) => b.attempt_number - a.attempt_number)[0]
            : null;
          const errorClass = attempt?.error_class ?? node?.error_class ?? "unknown";
          const detailText = attempt?.detail ?? "";
          // § 3's evidence lives in the run's own journal: the page's Timeline
          // renders it, and the unattended ask is journalled as decided with
          // decided_by `node_policy:ask_unattended`.
          const runPath = `/projects/${projectId}/runs/${claudeRunId}`;
          await gotoApp(page, runPath);
          await page.getByTestId("run-tab-timeline").click();
          const timelineText = await page
            .getByTestId("run-timeline")
            .innerText()
            .catch(() => "");
          const unattended =
            timelineText.includes("ask_unattended") || detailText.includes("ask_unattended");
          if (unattended) {
            // docs/home-cluster.md § 3: unattended permission prompts are
            // cancelled, not answered. Record it — do not change product
            // settings from the spec.
            finding =
              `FINDING (docs/home-cluster.md § 3): the unattended agent.acp attempt ` +
              `was cancelled by permission_mode:ask — status ${status}, ` +
              `error_class ${errorClass}, detail: ${detailText || "(none)"}`;
            console.log(finding);
            test.info().annotations.push({ type: "finding", description: finding });
            evidence.push(`claude run ${shortRefOf(claudeRunId)}: ${status}; ${finding}`);
            await shot(page, "home-13-claude-unattended-finding");
          } else {
            throw new Error(
              `claude run ${shortRefOf(claudeRunId)} reached ${status} without the recorded ` +
                `unattended-ask evidence (error_class ${errorClass}; detail: ${detailText}; ` +
                `timeline: ${timelineText.slice(0, 400) || "(empty)"})`,
            );
          }
        });
      }
    });
  });

  test("final summary — run ids and the § 5 check results", async () => {
    const lines = [
      `================ ${TARGET_TITLE.toUpperCase().replace(" ", "-")} PROOF ================`,
      `target: ${HOME_BASE_URL}`,
      `signed in as: ${displayName} (${
        LAB_MODE
          ? `lab mock OIDC subject ${HOME_LOGIN_SUBJECT}, no credentials read or stored`
          : "tsidp OIDC, no credentials read or stored"
      })`,
      ...evidence,
      finding ? finding : "finding: none recorded",
      "====================================================",
    ];
    const summary = lines.join("\n");
    console.log(summary);
    test.info().annotations.push({ type: "summary", description: summary });
    expect(displayName).not.toBe("");
    expect(planRunId).toMatch(/^[0-9a-f-]{36}$/);
    expect(claudeRunId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
