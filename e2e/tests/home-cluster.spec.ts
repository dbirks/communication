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
  clickRunAction,
  expectRunStatus,
  rowFor,
  selectByOptionText,
  shot,
  signIn,
  shortRefOf,
} from "./helpers.js";
import {
  classifyTransientModelFailure,
  type TransientModelFailure,
} from "./transient-model-failure.js";
import {
  IS_PI_LAUNCHER,
  LAB_LAUNCHER,
  newProfileCardTestid,
  seedLabPiProfile,
} from "./lab-launcher.js";

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
 * of the tsidp redirect loop. Unset on a remote target: the unchanged tsidp
 * behaviour. On a LOOPBACK target the tsidp chain can never close — there is
 * no tailnet provider session in a local browser, only the lab's mock IdP —
 * so an unset subject defaults to the seeded `admin` (the identity every
 * other lab spec signs in with) rather than timing out on /me for 120 s.
 */
const HOME_TARGET_HOST = new URL(HOME_BASE_URL).hostname;
const HOME_LOGIN_SUBJECT =
  process.env.E2E_HOME_LOGIN_SUBJECT ??
  (HOME_TARGET_HOST === "localhost" ||
  HOME_TARGET_HOST === "127.0.0.1" ||
  HOME_TARGET_HOST === "::1"
    ? "admin"
    : "");
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
/** Bounded retries for transient live-model failures (deadline or provider
 * 5xx) on the home cluster: the plan node's model.chat has its own 2-minute
 * provider deadline (llm-collective-engineering.com) and the gateway itself
 * can answer 502/503/504 or refuse/reset the connection; a run that fails on
 * either transient shape is retried through the UI's own Retry button — the
 * product's own recovery path — not a spec change. A run that fails WITHOUT
 * a transient live-model signature is a genuine product finding and stops
 * the suite. */
const PLAN_RETRY_MAX = Number(process.env.E2E_HOME_PLAN_RETRY_MAX ?? 3);
/** Bounded budget for waiting out a provider outage before a Retry click.
 * The lab exposes no model-reachability endpoint (GET /api/v1/system/
 * readiness reports the datastore only, internal/api/health.go) and the
 * suite must never hit the gateway directly with secrets, so recovery is
 * proven by spacing the retries with growing waits (30s/60s/120s) under a
 * hard 5-minute total budget — the observed outages cleared within minutes.
 * Only provider-unavailable shapes wait; a deadline failure retries
 * immediately, exactly as before. */
const PROVIDER_RECOVERY_BUDGET_MS = Number(
  process.env.E2E_HOME_PROVIDER_RECOVERY_BUDGET_MS ?? 300_000,
);
const PROVIDER_RECOVERY_BACKOFF_MS = [30_000, 60_000, 120_000];

/** The suite's own test budget: gate + post-gate run + agent run, plus slack. */
const TEST_TIMEOUT_MS = GATE_TIMEOUT_MS + RUN_TIMEOUT_MS + 1_800_000;
/**
 * A bounded wait for a post-write navigation. A write that the API refuses
 * never navigates; every such wait carries this bound (or fails faster
 * through waitForNavAfterWrite) so a 422 can never burn the test's own
 * timeout — which is how the earlier uppercase-stamp 422 hung ~45 minutes.
 */
const NAV_TIMEOUT_MS = Number(process.env.E2E_HOME_NAV_TIMEOUT_MS ?? 60_000);

/**
 * The bound for a plain UI interaction (click, fill) and for waiting on an
 * element the page draws from data it already has. Playwright gives an
 * UNBOUNDED locator action the whole test budget, so a selector for something
 * the current page never renders — not something slow — burns an hour before
 * it says so: that is exactly how the home lab proof at `176462e` spent 1h on
 * a `run-stage-cell-*` click while the run sat parked at its gate with the
 * approval card already open. Two minutes is slack for a rendered app; anything
 * that has not appeared by then is missing.
 */
const UI_TIMEOUT_MS = Number(process.env.E2E_HOME_UI_TIMEOUT_MS ?? 120_000);

/**
 * The gate's definition-node id in the vetted sample this proof runs
 * (`docs/samples/home/plan-with-approval.yaml:156`). The run page selects a
 * node by that id (ADR-0043's URL/selection state), so the id is the suite's
 * own expectation about the sample, not a guess read off a page.
 */
const GATE_NODE_ID = "approve";

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
    conversation_id: string | null;
    turn_id: string | null;
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
 * The attempt list of one node, rendered for a failure message: every
 * attempt with its own verdict, each detail cut to 240 characters. A node
 * with a retry block can carry failed attempts AND still complete, so the
 * list — not just the newest row — is what names the shape.
 */
function attemptList(attempts: NodeExecutionDetailView["attempts"]): string {
  if (attempts.length === 0) return "(no attempt rows)";
  const byNumber = [...attempts].sort((a, b) => a.attempt_number - b.attempt_number);
  return (
    byNumber
      .map(
        (a) =>
          `att ${a.attempt_number} ${a.status}${a.error_class ? `/${a.error_class}` : ""}: ${(
            a.detail ?? "(no detail)"
          )
            .replace(/\s+/g, " ")
            .slice(0, 240)}`,
      )
      .join(" | ") + ` (${byNumber.length} attempt row(s) served)`
  );
}

/** The agent's streamed text cut to a bounded first/last window, so a
 * failure message names the reply's shape without dumping a whole turn. */
function boundedReply(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat === "") return "(no agent text on this turn's transcript)";
  if (flat.length <= 800) return flat;
  return `${flat.slice(0, 400)} … [${flat.length - 800} chars omitted] … ${flat.slice(-400)}`;
}

/**
 * The agent's own last words, read the way the UI reads them: the
 * conversation transcript IS the journal, so
 * GET /api/v1/conversations/{id}/events replays every committed
 * `conversation.message.agent` row from the start (ADR-0014 § 9) before it
 * goes live. One bounded replay: collect rows, stop 1.5 s after the last one
 * (the live tail is a 15 s heartbeat, not data) and never past the 8 s budget,
 * so the diagnostics cannot extend a failing step by minutes. It runs in the
 * page (the app's own origin and cookies) and refuses loudly: a missing
 * transcript is reported as such, it never fails the step by itself.
 */
async function agentReplyText(
  page: Page,
  conversationId: string,
  budgetMs = 8_000,
): Promise<string> {
  const path = `/api/v1/conversations/${conversationId}/events`;
  const url = `${HOME_BASE_URL}${path}`;
  try {
    return await page.evaluate(
      async ({ streamUrl, budget }: { streamUrl: string; budget: number }) => {
        const rows: { turn: string; text: string }[] = [];
        let refused = false;
        await new Promise<void>((resolve) => {
          const source = new EventSource(streamUrl);
          let quiet: ReturnType<typeof setTimeout> | undefined;
          let done = false;
          const hard = setTimeout(stop, budget);
          function stop() {
            if (done) return;
            done = true;
            if (quiet) clearTimeout(quiet);
            clearTimeout(hard);
            source.close();
            resolve();
          }
          source.addEventListener("conversation.message.agent", (event) => {
            try {
              const frame = JSON.parse((event as MessageEvent).data as string) as {
                payload?: { turn_id?: unknown; text?: unknown };
              };
              const text = frame?.payload?.text;
              if (typeof text === "string" && text.length > 0) {
                rows.push({
                  turn: typeof frame?.payload?.turn_id === "string" ? frame.payload.turn_id : "",
                  text,
                });
                if (quiet) clearTimeout(quiet);
                quiet = setTimeout(stop, 1_500);
              }
            } catch {
              // A frame this reader cannot parse is not worth failing a report.
            }
          });
          source.onerror = () => {
            refused = rows.length === 0;
            stop();
          };
        });
        if (refused) return "(the transcript stream refused the connection)";
        // The LAST turn's rows: the attempt asked once, and a conversation
        // replay carries every row the journal holds.
        const lastTurn = rows.length > 0 ? rows[rows.length - 1].turn : "";
        return rows
          .filter((row) => row.turn === lastTurn)
          .map((row) => row.text)
          .join("");
      },
      { streamUrl: url, budget: budgetMs },
    );
  } catch (error) {
    return `(the transcript at GET ${path} was not readable: ${String(error)})`;
  }
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
    # The per-attempt deadline, sized for the retry ladder below: two attempts
    # of 360 s plus the backoff fit inside the suite's bounded 15-minute wait
    # (AGENT_TIMEOUT_MS, 900 s — clone included), which a 900 s single-attempt
    # budget cannot once the node retries.
    timeoutSeconds: 360
    # The node only READS README.md, so a second attempt is the same promise.
    # Without it one bad gateway answer fails the whole proof: Actions run
    # 42126595292 lost step 5 on attempt 1 (15 s, error_class invalid_output,
    # "agent reply is not a JSON object") and the identical job passed on run
    # 42114732911. The block is the bundled agent nodes' own shape
    # (docs/compatibility/probes/m4/pipeline.yaml, docs/samples/home/*.yaml):
    # maxAttempts + jittered backoff + retriableErrors; invalid_output is the
    # refusal this node can flake on and infra is the provider outage
    # (internal/worker/agentturn_silence.go reports a silent turn as infra).
    retry:
      maxAttempts: 2
      backoff: {baseSeconds: 5, multiplier: 2, maxSeconds: 60, jitter: true}
      retriableErrors: [invalid_output, infra]
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
  let projectPath = ""; // /p/{id} (canonical C1 route)
  let projectId = "";
  let planPipelinePath = ""; // /workflows/{pipelineId}
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
      // The projects index (create form + cards) lives at /projects since the
      // app-shell redesign; `/` is the Home briefing and carries neither.
      await gotoApp(page, "/projects");
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
        await page.waitForURL(/\/p\/[0-9a-f-]{36}\/?$/, { timeout: NAV_TIMEOUT_MS });
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
          await waitForNavAfterWrite(page, /\/p\/[0-9a-f-]{36}\/?$/, "create the project");
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
    await test.step("Workflows → the plan pipeline (created once, reused on re-runs)", async () => {
      await gotoApp(page, "/workflows");
      await expect(page.getByTestId("library-page")).toBeVisible();
      await expect(
        page.getByTestId("workflows-list").or(page.getByTestId("workflows-empty")).first(),
      ).toBeVisible({ timeout: 30_000 });
      const existing = page.getByTestId(`workflow-name-${PLAN_SLUG}`);
      if (await existing.isVisible().catch(() => false)) {
        await existing.click();
        await page.waitForURL(/\/workflows\/[0-9a-f-]{36}$/, { timeout: NAV_TIMEOUT_MS });
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
        // Design 1c: the New workflow dialog is the index's only creation
        // surface — a name, the id derived from it (changed here to the
        // suite's own slug), and the starter chosen as a card.
        await page.getByTestId("workflows-new-workflow").click();
        await expect(page.getByTestId("new-workflow-dialog")).toBeVisible();
        await page.getByTestId("library-new-name-input").fill(PLAN_SLUG);
        await page.getByTestId("new-workflow-id-change").click();
        await page.getByTestId("library-new-slug-input").fill(PLAN_SLUG);
        await page.getByTestId("new-workflow-template-plan-with-approval").click();
        await page.getByTestId("library-new-submit").click();
        // A template is not a revision: the click path lands on the seeded
        // draft's Workflow Studio, at /workflows/:id/drafts/:draftId. A 422
        // (e.g. an illegal slug) never navigates and fails the wait with
        // the API's status and body.
        await waitForNavAfterWrite(
          page,
          /\/workflows\/[0-9a-f-]{36}\/drafts\/[0-9a-f-]{36}$/,
          "create the plan pipeline",
        );
        planPipelinePath = `/workflows/${new URL(page.url()).pathname.split("/")[2]}`;
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
      // Design 1b (project-1b-workflows): the tab is ONE panel of 2e rows; the
      // inline assign form is gone and its one way in is the
      // `+ use a library workflow` picker, whose single `Use` verb resolves the
      // newest published revision and posts the whole-project pin.
      await gotoApp(page, `${projectPath}/workflows`);
      await expect(page.getByTestId("project-pipelines")).toBeVisible();
      await expect(
        page
          .getByTestId("project-workflows-list")
          .or(page.getByTestId("project-workflows-empty"))
          .first(),
      ).toBeVisible({ timeout: 30_000 });
      await page.getByTestId("project-workflow-library").click();
      await expect(page.getByTestId("project-library-dialog")).toBeVisible();
      const use = page.getByTestId(`project-library-use-${PLAN_SLUG}`);
      const used = page.getByTestId(`project-library-used-${PLAN_SLUG}`);
      // The picker names each workflow and its latest rN; one click resolves
      // and posts, so the pin's revision is the newest published r1.
      await expect(page.getByTestId(`project-library-row-${PLAN_SLUG}`)).toContainText(
        /latest r1(?!\d)/,
        { timeout: 30_000 },
      );
      await expect(use.or(used).first()).toBeVisible({ timeout: 30_000 });
      if (await use.isVisible().catch(() => false)) {
        await use.click();
        // The dialog closes only on the create's success — a refusal stays
        // open with the reason inline (project-library-error).
        await expect(page.getByTestId("project-library-dialog")).toHaveCount(0, {
          timeout: 30_000,
        });
      } else {
        // One whole-project assignment per pipeline is the store's UNIQUE, so
        // the picker prints `used in the project` instead of a `Use` button
        // that could only ever 409 — the already-assigned state (re-run).
        await expect(used).toBeVisible({ timeout: 30_000 });
        await page.getByTestId("project-library-cancel").click();
        console.log(`already assigned to the project: ${PLAN_SLUG}`);
        evidence.push(`assignment (reused): ${PLAN_SLUG} r1 pinned to the project`);
      }
      // Either way the panel itself now carries the workflow as a 2e row
      // (name link to its page) pinned to r1 — the tab's whole revision story.
      const planPipelineId = planPipelinePath.replace(/^\/(?:library|workflows)\//, "");
      const pinnedRow = page
        .locator('[data-testid^="project-workflow-row-"]')
        .filter({ has: page.locator(`a[href$="${planPipelineId}"]`) });
      await expect(pinnedRow).toBeVisible({ timeout: 30_000 });
      await expect(pinnedRow.locator('[data-testid^="project-workflow-revision-"]')).toContainText(
        /\br1\b/,
        { timeout: 30_000 },
      );
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

  /** GET the pipeline's stored revisions (route 13) behind its /workflows path. */
  async function pipelineRevisions(
    path: string,
  ): Promise<{ revision_number: number; revision_digest: string; status: string }[]> {
    const pipelineId = path.replace(/^\/(?:library|workflows)\//, "");
    const body = await getJson<{
      revisions: { revision_number: number; revision_digest: string; status: string }[];
    }>(context, `/api/v1/pipelines/${pipelineId}/revisions`);
    return body.revisions;
  }

  /**
   * Take the one-node claude document through the Workflow Studio's YAML
   * view: fill → save → validate → publish r1. The caller is either already
   * on the Studio route `/workflows/:pipelineId/drafts/:draftId` (the Blank
   * create navigates straight there) or on the pipeline page's Overview, in
   * which case the History tab (design 1e — commit a5b3f64 moved the drafts
   * and the clone control there) is opened first: an existing `draft-row-*`
   * is selected when the tab lists one (the resume of an interrupted run),
   * otherwise the tab's "New draft" control (`pipeline-new-draft`) is the
   * click —
   * with zero published revisions it posts the blank skeleton named for
   * the slug, so the control is enabled by construction. Every wait is
   * bounded; the only failure left is the page's own query settling on
   * neither a row nor an enabled control.
   */
  async function authorFirstRevision(slug: string): Promise<void> {
    if (!/\/workflows\/[0-9a-f-]{36}\/drafts\/[0-9a-f-]{36}$/.test(page.url())) {
      // Drafts and the clone control are the History tab's surface now; the
      // page opens on the read-only Overview graph.
      const historyTab = page.getByTestId("workflow-tab-history");
      await expect(historyTab).toBeVisible({ timeout: 30_000 });
      await historyTab.click({ timeout: 30_000 });
      const draftRow = page.getByTestId(/^draft-row-.+$/).first();
      // Settle the drafts list first: it shows either a row or its own
      // `drafts-empty` line, and the decision below must not race the query.
      await expect(draftRow.or(page.getByTestId("drafts-empty")).first()).toBeVisible({
        timeout: 30_000,
      });
      if (await draftRow.isVisible()) {
        // An interrupted run left the draft: select it and finish the
        // publish from wherever it stopped.
        await draftRow.click({ timeout: 30_000 });
      } else {
        // No row: "New draft" posts the skeleton (nothing to clone at zero
        // revisions) and the Studio route opens.
        const newDraft = page.getByTestId("pipeline-new-draft");
        await expect(newDraft).toBeEnabled({ timeout: 30_000 });
        await newDraft.click({ timeout: 30_000 });
      }
      await page.waitForURL(/\/workflows\/[0-9a-f-]{36}\/drafts\/[0-9a-f-]{36}$/, {
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
   * A failed run's nodes re-read, classified per tests/transient-model-
   * failure.ts: the live model's own deadline ("no completion from … within
   * 2m0s (the attempt's deadline arm, § 4 step 8)") and a provider that was
   * temporarily unavailable (model.chat infra failure whose detail says the
   * provider returned http 502/503/504 or refused/reset the connection) are
   * the transient live-model failures (deadline or provider 5xx) this suite
   * may retry through the UI's Retry button. Every failed node must carry one
   * of those signatures; anything else is a product finding the caller must
   * report, not paper over. When the nodes carry different shapes, the
   * provider-unavailable shape wins — it is the one that needs a wait first.
   */
  async function transientModelFailureOfRun(
    ctx: BrowserContext,
    runId: string,
  ): Promise<TransientModelFailure> {
    const nodes = await getJson<{ node_executions: NodeExecutionView[] }>(
      ctx,
      `/api/v1/runs/${runId}/nodes`,
    );
    const failed = nodes.node_executions.filter((n) => n.status === "failed");
    if (failed.length === 0) return null;
    let shape: TransientModelFailure = null;
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
      const classified = classifyTransientModelFailure(
        node.kind,
        node.error_class ?? newest?.error_class,
        newest?.detail,
      );
      if (!classified) return null;
      if (classified === "provider-unavailable") shape = classified;
      else shape ??= classified;
    }
    return shape;
  }

  test(`step 4 — start the run, approve the gate, terminal, ${TARGET_TITLE.toLowerCase()}-worker proof`, async () => {
    refusedWrites.length = 0;
    await test.step("New run: the revision's inputs (goal + the repository binding)", async () => {
      await gotoApp(page, `${projectPath}/runs`);
      await expect(page.getByTestId("project-runs")).toBeVisible({ timeout: UI_TIMEOUT_MS });
      // Design 1b: the RUNS panel carries no "New run" button of its own — the
      // header band's `Start run` is the page's one door, landing here with
      // ?new=1 and opening the form above the list.
      await page.getByTestId("project-start-run").click({ timeout: UI_TIMEOUT_MS });
      await expect(page).toHaveURL(/[?&]new=1/, { timeout: UI_TIMEOUT_MS });
      await expect(page.getByTestId("new-run-form")).toBeVisible({ timeout: UI_TIMEOUT_MS });
      // The form names the pinned revision two ways, and both are the page's
      // own fact (ADR-0066 typed mode): with more than one assignment the
      // select is shown and the plan is chosen in it; with this project's
      // single assignment the dialog opens straight on it — its heading
      // carries the pipeline's slug, which is the pin named as data.
      const assignmentSelect = page.getByTestId("new-run-assignment");
      // The form settles only once the pinned revision has loaded. While it
      // is still in flight the free-form shape is on screen WITH its select
      // but WITHOUT its declared fields — a transient shape that the typed
      // run-by-hand dialog replaces the moment `input_specs` arrive (the
      // plan sample declares goal + repository, so this project settles
      // typed, and its single-assignment dialog carries no select). Branching
      // on the select's presence inside that window is what failed run
      // 41754108482: the option was read from a select the form was about to
      // unmount, so it never attached. The goal field exists in BOTH settled
      // shapes (free-form and typed, `new-run-input-${name}`), so wait for it
      // before deciding which shape is final.
      await expect(page.getByTestId("new-run-input-goal")).toBeVisible({
        timeout: UI_TIMEOUT_MS,
      });
      if (await assignmentSelect.isVisible()) {
        await selectByOptionText(page, "new-run-assignment", PLAN_SLUG);
      } else {
        await expect(page.getByRole("heading", { name: new RegExp(PLAN_SLUG) })).toBeVisible({
          timeout: UI_TIMEOUT_MS,
        });
      }
      await page.getByTestId("new-run-input-goal").fill(GOAL, { timeout: UI_TIMEOUT_MS });
      // `repository` is the project binding name, offered as the project's
      // own list — not a URL a user has to remember. Typed mode declares this
      // revision's `repository` input as plain text, so the same testid is a
      // text box there; both shapes take the binding name.
      const repoField = page.getByTestId("new-run-input-repository");
      const repoTag = await repoField.evaluate((el) => el.tagName, { timeout: UI_TIMEOUT_MS });
      if (repoTag === "SELECT") {
        await selectByOptionText(page, "new-run-input-repository", REPO_BINDING);
      } else {
        await repoField.fill(REPO_BINDING, { timeout: UI_TIMEOUT_MS });
      }
      await page.getByTestId("new-run-submit").click({ timeout: UI_TIMEOUT_MS });
      await waitForNavAfterWrite(page, /\/runs\/[0-9a-f-]{36}$/, "start the plan run");
      planRunId = new URL(page.url()).pathname.split("/").pop() ?? "";
      expect(planRunId).toMatch(/^[0-9a-f-]{36}$/);
      console.log(`plan run started: ${planRunId}`);
      await shot(page, "home-05-run-started");
    });
    // The live model's own 2-minute provider deadline, or a provider that
    // briefly answers 502/503/504 (or refuses/resets the connection), can
    // fail a plan attempt transiently (run 5: model.chat TIMEOUT on both
    // attempts; acceptance 37: http 503 on both attempts, gateway answering
    // again minutes later — in both, Retry in the UI recovered). Each leg of
    // the run is bounded: before the gate the leg ends when the run parks
    // (the served status `waiting_human`), after the gate it ends when the
    // run is terminal. A leg that fails with a transient live-model failure
    // (deadline or provider 5xx) signature is retried through the UI's own
    // Retry button — waiting out the provider first for the 5xx shape; any
    // other failure is a product finding the suite surfaces.
    let afterGate = false;
    let providerWaitsUsed = 0;
    let providerRecoveryWaitedMs = 0;
    for (let retry = 0; ; retry++) {
      const leg = await pollAnyStatus(
        context,
        planRunId,
        ["waiting_human", "completed", "failed"],
        afterGate ? RUN_TIMEOUT_MS : GATE_TIMEOUT_MS,
      );
      if (leg === "completed") break;
      if (leg === "failed") {
        const transient = await transientModelFailureOfRun(context, planRunId);
        if (!transient) {
          // transientModelFailureOfRun logged every failed node's error_class
          // and newest-attempt detail; that evidence is the product finding.
          throw new Error(
            `plan run ${shortRefOf(planRunId)} failed without a transient live-model ` +
              `failure (deadline or provider 5xx) signature — reporting it as a product ` +
              `finding (node/attempt evidence in the log above)`,
          );
        }
        if (retry >= PLAN_RETRY_MAX) {
          throw new Error(
            `plan run ${shortRefOf(planRunId)} still transiently failing after ` +
              `${PLAN_RETRY_MAX} retries (transient live-model failure: deadline or ` +
              `provider 5xx)`,
          );
        }
        console.log(
          `plan run ${shortRefOf(planRunId)} hit a transient live-model failure ` +
            `(${transient}) — retrying through the UI's Retry (${retry + 1}/${PLAN_RETRY_MAX})`,
        );
        evidence.push(
          `plan run ${shortRefOf(planRunId)}: transient live-model failure ` +
            `(deadline or provider 5xx, shape=${transient}), UI retry ${retry + 1}`,
        );
        if (transient === "provider-unavailable") {
          // The provider was down when the attempt ran (the observed outages
          // cleared within minutes). Space the retries with growing waits —
          // 30s, then 60s, then 120s — under a hard budget, so the Retry
          // click lands after the gateway plausibly answers again. No direct
          // gateway probe from the test: it would need secrets (see the
          // PROVIDER_RECOVERY_BUDGET_MS comment for why there is no cheap
          // readiness signal to poll instead).
          const stepMs =
            PROVIDER_RECOVERY_BACKOFF_MS[
              Math.min(providerWaitsUsed, PROVIDER_RECOVERY_BACKOFF_MS.length - 1)
            ];
          const waitMs = Math.max(
            0,
            Math.min(stepMs, PROVIDER_RECOVERY_BUDGET_MS - providerRecoveryWaitedMs),
          );
          providerWaitsUsed += 1;
          if (waitMs > 0) {
            providerRecoveryWaitedMs += waitMs;
            console.log(
              `  provider unavailable — waiting ${waitMs / 1000}s before the Retry click ` +
                `(provider recovery budget ${providerRecoveryWaitedMs}/${PROVIDER_RECOVERY_BUDGET_MS} ms used)`,
            );
            evidence.push(
              `plan run ${shortRefOf(planRunId)}: provider unavailable — waited ` +
                `${waitMs / 1000}s before UI retry ${retry + 1} ` +
                `(recovery budget ${providerRecoveryWaitedMs}/${PROVIDER_RECOVERY_BUDGET_MS} ms)`,
            );
            await new Promise((resolve) => setTimeout(resolve, waitMs));
          }
        }
        const retryButton = page.getByTestId("run-retry");
        // A failed run's ONE primary action is `run-retry` ("Retry step") —
        // the redesigned header (finding 11) keeps it inline; every other
        // verb rides the ⋯ menu, so the click goes through clickRunAction.
        await expect(retryButton).toBeVisible({ timeout: UI_TIMEOUT_MS });
        await expect(retryButton).toBeEnabled({ timeout: UI_TIMEOUT_MS });
        await clickRunAction(page, "run-retry");
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
        // ADR-0043 / docs/design/studio-workbench.md § 6: the run page IS the
        // graph-first Run Workbench. Its split view carries the tab row and the
        // live graph — the stage strip is not part of it (the old inspector,
        // strip included, survives as the Diagnostics tab; full screen swaps the
        // tab row for the step strip). So the user opens a gate by clicking its
        // box on the graph, and the dock answers with the ApprovalCard
        // (§ 6's `human.approval` → ApprovalCard rule). Selecting the gate by
        // its stage cell was the pre-ADR-0043 inspector page's path.
        const gateBox = page.getByTestId(`canvas-step-${GATE_NODE_ID}`);
        await expect(gateBox).toBeVisible({ timeout: UI_TIMEOUT_MS });
        await gateBox.click({ timeout: UI_TIMEOUT_MS });
        const approvalState = page.getByTestId("approval-state");
        await expect(approvalState).toHaveText("needs your decision", {
          timeout: UI_TIMEOUT_MS,
        });
        await expect(page.getByTestId("approval-node")).toContainText(GATE_NODE_ID, {
          timeout: UI_TIMEOUT_MS,
        });
        const comment = page.getByTestId("approval-comment");
        await expect(comment).toBeVisible({ timeout: UI_TIMEOUT_MS });
        await comment.fill(`${TARGET_TITLE} proof — approved.`, { timeout: UI_TIMEOUT_MS });
        const approveButton = page.getByTestId("approval-approve");
        await expect(approveButton).toBeVisible({ timeout: UI_TIMEOUT_MS });
        await approveButton.click({ timeout: UI_TIMEOUT_MS });
        await expect(page.getByTestId("approval-decided")).toBeVisible({
          timeout: DECISION_TIMEOUT_MS,
        });
        await shot(page, "home-07-approved");
      });
      afterGate = true;
      await shot(page, "home-06-gate");
    }
    await test.step("the run completes and every node succeeded", async () => {
      await expectRunStatus(page, /done/, RUN_TIMEOUT_MS);
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

  test(`step 5 — one agent.acp node on the ${LAB_LAUNCHER} launcher profile`, async () => {
    refusedWrites.length = 0;
    await test.step(`the ${LAB_LAUNCHER}-launcher profile exists (created through the dialog when absent)`, async () => {
      await gotoApp(page, "/profiles");
      await expect(page.getByTestId("agents-page")).toBeVisible();
      const rows = page
        .getByTestId("agent-list")
        .locator('[data-testid^="agent-item-"]')
        .filter({ hasText: PROFILE_NAME });
      if ((await rows.count()) === 0) {
        // The redesigned /profiles creates through the New profile dialog with
        // a LAUNCHER CARD (shell-p5's proven flow) — there is no longer a
        // launcher `<select>` on the list page itself. The card is the lab's
        // launcher (COMMUNICATION_LAB_LAUNCHER; unset = claude, unchanged).
        await page.getByTestId("agents-new-open").click();
        const dialog = page.getByTestId("new-profile-dialog");
        await expect(dialog).toBeVisible();
        await page.getByTestId(newProfileCardTestid()).click();
        await page.getByTestId("agents-new-name-input").fill(PROFILE_NAME);
        await page.getByTestId("agents-new-submit").click();
        // The dialog closes and the journey lands on the new profile's detail
        // (the caller acts on onCreated — shell-p5's evidence); return to the
        // list so the row read below is the API's own row.
        await expect(dialog).toBeHidden({ timeout: 30_000 });
        await gotoApp(page, "/profiles");
        await expect(rows.first()).toBeVisible({ timeout: 30_000 });
        console.log(`created agent profile ${PROFILE_NAME} (${LAB_LAUNCHER} launcher)`);
      } else {
        console.log(`reusing agent profile ${PROFILE_NAME}`);
      }
      if (IS_PI_LAUNCHER) {
        // ADR-0030 leaves every product create at `ask`, and `ask` fails
        // closed on the never-asks launcher (ADR-0019 D6). The honest mode —
        // autonomous_within_sandbox beside sandbox `required` — arrives the
        // seed.sh way: the stack's own postgres, idempotent on re-runs. The
        // seed lands behind the API's back, so reload the page: the chip
        // read below must be the served row, not the pre-seed cache.
        seedLabPiProfile(PROFILE_NAME);
        await gotoApp(page, "/profiles");
        await expect(page.getByTestId("agents-page")).toBeVisible();
        await expect(rows.first()).toBeVisible({ timeout: 30_000 });
      }
      const testid = (await rows.first().getAttribute("data-testid")) ?? "";
      profileId = testid.replace(/^agent-item-/, "");
      expect(profileId).toMatch(/^[0-9a-f-]{36}$/);
      await expect(page.getByTestId(`agent-launcher-${profileId}`)).toHaveText(
        new RegExp(`^launcher: ${LAB_LAUNCHER}$`),
      );
      // The permission chip renders on the profile DETAIL page, so open the
      // row. Under claude a product-created profile can only ever be `ask`
      // (ADR-0030: permission_mode has no write field) — the § 3 caveat's
      // precondition, recorded as evidence. Under pi it reads
      // `autonomous_within_sandbox`, the never-asks launcher's only honest
      // mode (ADR-0069): no prompt, the sandbox is the boundary.
      await page.getByTestId(`agent-row-${profileId}`).click();
      await expect(page.getByTestId("profile-version")).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId(`agent-permission-${profileId}`)).toHaveText(
        new RegExp(`^permission: ${IS_PI_LAUNCHER ? "autonomous_within_sandbox" : "ask"}$`),
      );
      await gotoApp(page, "/profiles");
      await expect(page.getByTestId(`agent-item-${profileId}`)).toBeVisible();
      evidence.push(
        `agent profile ${PROFILE_NAME}: launcher ${LAB_LAUNCHER}, permission ${
          IS_PI_LAUNCHER ? "autonomous_within_sandbox" : "ask"
        }`,
      );
      await shot(page, "home-09-profile");
    });
    await test.step("the one-node pipeline (Blank): r1 published (created once, reused)", async () => {
      await gotoApp(page, "/workflows");
      await expect(page.getByTestId("library-page")).toBeVisible();
      await expect(
        page.getByTestId("workflows-list").or(page.getByTestId("workflows-empty")).first(),
      ).toBeVisible({ timeout: 30_000 });
      const existing = page.getByTestId(`workflow-name-${CLAUDE_SLUG}`);
      if (await existing.isVisible().catch(() => false)) {
        // Re-run: the server would 409 the duplicate slug, so the existing
        // definition is opened and its stored state decides.
        await existing.click();
        await page.waitForURL(/\/workflows\/[0-9a-f-]{36}$/, { timeout: NAV_TIMEOUT_MS });
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
      // create click straight to the Studio route with it selected — the
      // navigation is the fact (`waitForNavAfterWrite` semantics: a
      // non-2xx on the write rejects before the wait burns its timeout).
      // Design 1c: the starter card opens the New workflow dialog with Blank
      // already selected; the id is the suite's own slug.
      await page.getByTestId("workflow-starter-blank").click();
      await expect(page.getByTestId("new-workflow-dialog")).toBeVisible();
      await page.getByTestId("library-new-name-input").fill(CLAUDE_SLUG);
      await page.getByTestId("new-workflow-id-change").click();
      await page.getByTestId("library-new-slug-input").fill(CLAUDE_SLUG);
      const created = waitForNavAfterWrite(
        page,
        /\/workflows\/[0-9a-f-]{36}\/drafts\/[0-9a-f-]{36}$/,
        "create the claude pipeline",
      );
      await page.getByTestId("library-new-submit").click();
      await created;
      await authorFirstRevision(CLAUDE_SLUG);
      await shot(page, "home-10-claude-published");
    });
    await test.step("assign it and start a run on the repository binding", async () => {
      // Same picker the plan pipeline used: the tab's one way in is
      // `+ use a library workflow`; `Use` resolves r1 and posts.
      await gotoApp(page, `${projectPath}/workflows`);
      await expect(page.getByTestId("project-pipelines")).toBeVisible();
      await expect(
        page
          .getByTestId("project-workflows-list")
          .or(page.getByTestId("project-workflows-empty"))
          .first(),
      ).toBeVisible({ timeout: 30_000 });
      await page.getByTestId("project-workflow-library").click();
      await expect(page.getByTestId("project-library-dialog")).toBeVisible();
      const use = page.getByTestId(`project-library-use-${CLAUDE_SLUG}`);
      const used = page.getByTestId(`project-library-used-${CLAUDE_SLUG}`);
      await expect(page.getByTestId(`project-library-row-${CLAUDE_SLUG}`)).toContainText(
        /latest r1(?!\d)/,
        { timeout: 30_000 },
      );
      // Same assign/already-assigned race as the plan pipeline: settle on
      // either branch's marker before deciding which one is present.
      await expect(use.or(used).first()).toBeVisible({ timeout: 30_000 });
      if (await use.isVisible().catch(() => false)) {
        await use.click();
        await expect(page.getByTestId("project-library-dialog")).toHaveCount(0, {
          timeout: 30_000,
        });
      } else {
        // Re-run: the picker prints `used in the project` only while the
        // UNIQUE whole-project assignment exists.
        await expect(used).toBeVisible({ timeout: 30_000 });
        await page.getByTestId("project-library-cancel").click();
        console.log(`already assigned to the project: ${CLAUDE_SLUG}`);
        evidence.push(`assignment (reused): ${CLAUDE_SLUG} r1 pinned to the project`);
      }
      // The claude workflow's row answers on the panel — named by the slug it
      // was created with — before the run form is opened for it.
      const claudeRow = page
        .locator('[data-testid^="project-workflow-row-"]')
        .filter({ has: page.getByTestId(/^project-workflow-name-/) })
        .filter({ hasText: CLAUDE_SLUG });
      await expect(claudeRow).toBeVisible({ timeout: 30_000 });
      await gotoApp(page, `${projectPath}/runs`);
      await page.getByTestId("project-start-run").click();
      await expect(page.getByTestId("new-run-form")).toBeVisible();
      await selectByOptionText(page, "new-run-assignment", CLAUDE_SLUG);
      // Same two shapes as step 4's binding field: a repo picker when the
      // form offers one, a text box when the revision types it as plain text.
      const claudeRepo = page.getByTestId("new-run-input-repository");
      const claudeRepoTag = await claudeRepo.evaluate((el) => el.tagName, {
        timeout: UI_TIMEOUT_MS,
      });
      if (claudeRepoTag === "SELECT") {
        await selectByOptionText(page, "new-run-input-repository", REPO_BINDING);
      } else {
        await claudeRepo.fill(REPO_BINDING, { timeout: UI_TIMEOUT_MS });
      }
      await page.getByTestId("new-run-submit").click();
      await waitForNavAfterWrite(page, /\/runs\/[0-9a-f-]{36}$/, "start the claude run");
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
          // The outcome is what this suite asserts; the attempt list is what it
          // reports, so a run that needed its retry says so in the evidence
          // instead of looking like it never flaked at all.
          console.log(`read_readme attempts: ${attemptList(detail.attempts)}`);
          evidence.push(
            `claude run ${shortRefOf(claudeRunId)}: completed; summary ${summary.slice(0, 200)}; ` +
              `attempts ${detail.attempt_count} (${attempt.attempt_number} succeeded)`,
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
          const attempts = detail
            ? [...detail.attempts].sort((a, b) => b.attempt_number - a.attempt_number)
            : [];
          const attempt = attempts[0] ?? null;
          const errorClass = attempt?.error_class ?? node?.error_class ?? "unknown";
          const detailText = attempt?.detail ?? "";
          // § 3's evidence lives in the run's own journal: the page's Timeline
          // renders it, and the unattended ask is journalled as decided with
          // decided_by `node_policy:ask_unattended`. The page loads FIRST:
          // the transcript read below runs in it (same origin, same session
          // cookies), and a run page that never renders is itself a failure
          // the two bounded waits below name.
          const runPath = `/runs/${claudeRunId}`;
          await gotoApp(page, runPath);
          // The diagnostics § 5 owes the next reader: every attempt's own
          // verdict and the AGENT's last reply text, read from the transcript
          // the product itself serves (GET /runs/{id}/nodes/{node} for the
          // rows, GET /api/v1/conversations/{id}/events for the agent rows —
          // the journal replay, no internals). Read BEFORE the Timeline walk,
          // so the message below carries the shape even when the page's own
          // text comes back empty, and bounded (first/last 400 chars of the
          // reply) so a long model turn cannot bloat the report.
          const replyText = attempt?.conversation_id
            ? await agentReplyText(page, attempt.conversation_id)
            : "(the newest attempt carries no conversation row)";
          const diagnostics =
            `\n  conversation: ${attempt?.conversation_id ?? "(none)"} turn: ${attempt?.turn_id ?? "(none)"}` +
            `\n  attempts: ${attemptList(detail?.attempts ?? [])}` +
            `\n  agent reply (bounded): ${boundedReply(replyText)}`;
          console.log(
            `claude run ${shortRefOf(claudeRunId)} ${status} — last attempt ${errorClass}: ${detailText}${diagnostics}`,
          );
          // The same ADR-0043 surface as step 4: on the Workbench the Timeline
          // tab is `workbench-tab-timeline` (`run-tab-*` is the inspector, now
          // hosted by Diagnostics). Bounded, so a missing tab is a two-minute
          // failure with the page's own testids, not the test budget.
          const timelineTab = page.getByTestId("workbench-tab-timeline");
          await expect(timelineTab).toBeVisible({ timeout: UI_TIMEOUT_MS });
          await timelineTab.click({ timeout: UI_TIMEOUT_MS });
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
              `error_class ${errorClass}, detail: ${detailText || "(none)"}${diagnostics}`;
            console.log(finding);
            test.info().annotations.push({ type: "finding", description: finding });
            evidence.push(`claude run ${shortRefOf(claudeRunId)}: ${status}; ${finding}`);
            await shot(page, "home-13-claude-unattended-finding");
          } else {
            throw new Error(
              `claude run ${shortRefOf(claudeRunId)} reached ${status} without the recorded ` +
                `unattended-ask evidence (error_class ${errorClass}; detail: ${detailText}; ` +
                `timeline: ${timelineText.slice(0, 400) || "(empty)"})` +
                `${diagnostics}\n  — a retried node reaches this line only when EVERY attempt it was ` +
                `allowed failed (read_readme declares retry.maxAttempts 2 over ` +
                `[invalid_output, infra]), so the shape above is the shape to fix.` +
                (IS_PI_LAUNCHER
                  ? "\n  launcher pi runs autonomous_within_sandbox (ADR-0069): nothing is " +
                    "asked and nothing can be left unattended, so this run must simply complete"
                  : ""),
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
