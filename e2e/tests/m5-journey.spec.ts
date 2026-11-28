// M5 exit journey (communication-spec/11-build-roadmap.md "### M5"): an
// untrained user clones a sample pipeline, customizes it, publishes it, runs it,
// sees a stalled run, takes control, retries and views evidence.
//
// It runs against the M4 lab by env override only — no second compose project:
//   COMMUNICATION_E2E_M5=1 \
//   E2E_BASE_URL=http://localhost:18091 E2E_API_A_URL=http://localhost:18092 \
//   E2E_API_B_URL=http://localhost:18093 pnpm exec playwright test tests/m5-journey.spec.ts
// The lab's mock IdP identities and the "M4 Exit" project (alice = maintainer,
// admin = org admin with no project membership) are seeded by
// docs/compatibility/probes/m4/seed.sh; this suite adds pipelines and runs and
// resets nothing.
//
// DETERMINISTIC BY CONSTRUCTION: the cloned sample's `model.chat` node is
// rewritten to a `process.exec` node that prints the plan (the same twin trick
// the M4 seed uses for its `agent.acp` nodes), so the approval gate is reached
// with no model endpoint on the worker and no real Claude turn anywhere. The
// template copy itself is proof of the authoring path, and the step form's
// timeout edit is proof of customization. The run's own failure comes from the
// `verify` node: its command exits 1 AND its declared outputs schema admits only
// `exit_code: 0`, so the boundary closes the attempt `invalid_output`, the node
// goes `failed` and the run fails for real. A bare `exit 1` would NOT: 1..125 is
// the business-outcome band (`execution_status=success` / `business_outcome=fail`
// — spec 03:49, `internal/worker/procexec.go`'s classify), which only an `until`
// node's `passWhen` reads and which settles the run `completed`. Either way the
// retry the journey must perform is the product's own retry, not a fixture trick.
//
// Skipped unless COMMUNICATION_E2E_M5=1, so CI (which has no M4 lab) is
// unaffected — the same gate idiom as M2's harness flag. Every wait is bounded:
// a run that never reaches its gate fails the suite rather than hanging it.
// One test needs a gate whose deadline PASSES (the gate arm of route 31), so it
// authors and assigns a second, scratch pipeline (`GATE_SLUG`) with the schema's
// 60-second deadline floor and one deterministic node behind it. That is a
// second definition this suite authors and a second run it starts — added, like
// everything here, never reset.
import { test, expect, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { BASE_URL } from "./env.js";
import {
  decideGate,
  expectRunActionAbsent,
  expectRunStatus,
  gotoApp,
  openProjectBySlug,
  selectByOptionText,
  shot,
  signIn,
  testidOf,
  openFullStepPanel,
} from "./helpers.js";

/** A bounded wait for a real worker to prepare a workspace and run two nodes. */
const RUN_TIMEOUT_MS = Number(process.env.E2E_M5_RUN_TIMEOUT_MS ?? 600_000);
/** A control-plane status change after a human decision is an advancer tick. */
const DECISION_TIMEOUT_MS = Number(process.env.E2E_M5_DECISION_TIMEOUT_MS ?? 180_000);

// The lab's seeded identities: display names are the bare subjects (seed.sh
// posts only an `email` claim, so no `name` to read off the id token).
const ADMIN = { subject: "admin", name: "admin" };
const ALICE = { subject: "alice", name: "alice", projectSlug: "m4-exit", projectName: "M4 Exit" };

const REPO_BINDING = "app";
const GOAL = "Document and fix add() in hello.py";
/** The scratch pipeline's own goal, so its gate summary is identifiable. */
const GATE_GOAL = "Let the scratch gate's deadline pass, then retry the run";
/** The rejection twin's goal, so its gate summary is identifiable too. */
const REJECT_GOAL = "Reject the scratch gate and settle the run as a business outcome";
const PLAN_LINE = "Document add() with a docstring";
const stamp = process.env.E2E_M5_STAMP ?? new Date().toISOString().slice(11, 19).replace(/:/g, "");
const SLUG = `m5-journey-${stamp}`;
// Deliberately NOT `${SLUG}-gate`: the library picker's rows are keyed by slug
// (`project-library-use-<slug>`) and Playwright matches test ids by substring,
// so a prefixed child would collide with the journey's own rows.
const GATE_SLUG = `m5-gate-${stamp}`;
// Same rule for the rejection twin: `m5-reject-` shares no prefix with any
// other slug in this suite.
const REJECT_SLUG = `m5-reject-${stamp}`;

const M5_ENABLED = process.env.COMMUNICATION_E2E_M5 === "1";

/**
 * The Run Workbench's dock opens ONE attempt of the selected node at a time
 * (`ui/src/components/workbench/WorkbenchDock.tsx`): the `AttemptDetail`
 * panel's heading id is `workbench-attempt-heading-<attempt_number>` for the
 * attempt the dock is serving, and every attempt the node ran is a
 * `dock-attempt-<n>` tab that switches which panel the dock draws. The crumb
 * above the panel (`node-pane-crumb`) names the attempt the dock serves, so
 * the pane is still scoped to ONE attempt rather than "whichever the dock
 * happened to draw" — the same claim the old node pane made.
 */
function attemptPane(page: Page, attemptNumber: number): Locator {
  return page.locator(`section[aria-labelledby="workbench-attempt-heading-${attemptNumber}"]`);
}

/** The dock's attempt tabs: one button per attempt the selected node ran —
 * the dock draws them only from a second attempt on, so a one-attempt node
 * has none and the served panel is the whole record. */
function dockAttemptTabs(page: Page): Locator {
  return page.locator('button[role="tab"][data-testid^="dock-attempt-"]');
}

/**
 * Pin a library workflow to the project from `/p/:projectId/factory`
 * (`ProjectWorkflowsPanel`). Returns the new assignment's id and asserts its
 * `r1` chip.
 */
async function pinWorkflowOnProject(
  page: Page,
  projectPath: string,
  slug: string,
): Promise<string> {
  await gotoApp(page, `${projectPath}/factory`);
  await expect(page.getByTestId("project-pipelines")).toBeVisible();
  await page.getByTestId("project-workflow-library").click();
  await expect(page.getByTestId("project-library-dialog")).toBeVisible();
  await page.getByTestId("project-library-search").fill(slug);
  const pinned = page.waitForResponse(
    (response) =>
      response.url().includes("/api/v1/projects/") &&
      response.url().includes("/assignments") &&
      response.request().method() === "POST",
    { timeout: 30_000 },
  );
  await page.getByTestId(`project-library-use-${slug}`).click();
  const pinId = ((await (await pinned).json()) as { id?: string }).id ?? "";
  expect(pinId, "the picker's `Use` posted the pin").toMatch(/^[0-9a-f-]{36}$/);
  // Assigned: the picker closes over the pin it just posted.
  await expect(page.getByTestId("project-library-dialog")).toHaveCount(0, { timeout: 30_000 });
  const row = page.getByTestId(`project-workflow-row-${testidOf(pinId)}`);
  await expect(row, "design 1b: the pinned workflow is a row of the one panel").toBeVisible({
    timeout: 30_000,
  });
  await expect(
    row.getByTestId(`project-workflow-revision-${testidOf(pinId)}`),
    "design 1b: the row's `r<N>` chip names the revision this project's runs pin",
  ).toHaveText("r1", { timeout: 30_000 });
  return pinId;
}

/**
 * Open the New run form through Project Home's `or run a workflow` chip (`StartRunDialog`).
 */
async function openRunForm(page: Page, projectPath: string): Promise<void> {
  const projectId = projectPath.split("/").pop() ?? "";
  await gotoApp(page, projectPath);
  await expect(page.getByTestId("project-home")).toBeVisible();
  await page.getByTestId("home-prompt-run").click();
  await expect(page.getByTestId("run-form-dialog")).toBeVisible();
  const projectSelect = page.getByTestId("home-start-run-project");
  if (await projectSelect.isVisible().catch(() => false)) {
    await projectSelect.selectOption({ value: projectId });
  }
  await expect(page.getByText(/Loading (projects|assignments|pinned revision)/i)).toHaveCount(0, {
    timeout: 20_000,
  });
  await expect(page.getByTestId("new-run-form")).toBeVisible();
}

/**
 * Create a workflow + initial draft via Factory → New workflow → Import YAML,
 * landing on `/factory/:pipelineId?draft=:draftId`.
 */
async function importWorkflowInFactory(
  page: Page,
  slug: string,
  yamlDoc: string,
): Promise<{ pipelinePath: string; draftId: string }> {
  await gotoApp(page, "/factory");
  await expect(page.getByTestId("factory-index")).toBeVisible();
  await page.getByTestId("factory-new").click();
  await expect(page.getByTestId("new-workflow-sheet")).toBeVisible();
  await page.getByTestId("new-workflow-import").click();
  await expect(page.getByTestId("import-yaml-dialog")).toBeVisible();
  await page.getByTestId("import-yaml-doc").fill(yamlDoc);
  await page.getByTestId("import-yaml-slug").fill(slug);
  await page.getByTestId("import-yaml-name").fill(slug);
  await page.getByTestId("import-yaml-submit").click();
  await page.waitForURL(/\/factory\/[0-9a-f-]{36}\?draft=[0-9a-f-]{36}$/);
  await expect(page.getByTestId("studio-canvas")).toBeVisible({ timeout: 30_000 });
  const url = new URL(page.url());
  return {
    pipelinePath: url.pathname,
    draftId: url.searchParams.get("draft") ?? "",
  };
}

/**
 * The pending gate row for `runId`, read from the API instead of the page:
 * the decision callouts (`ui/src/components/project/NeedsYou.tsx` on the
 * project overview, `ui/src/components/home/DecisionCallout.tsx` on Today) no
 * longer print "run <short>", so a card cannot be picked by that text. The
 * cross-project list (`GET /api/v1/approvals?status=pending`, ADR-0047)
 * carries a `run_id` on every row, and `approval_requests` admits one pending
 * row per node execution (ADR-0023 § 9) — exactly one row for the run is
 * exactly one decision callout. Polls the API (bounded) so a row
 * still being written is waited for, not failed.
 */
async function pendingGateFor(page: Page, runId: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await page.request.get("/api/v1/approvals", { params: { status: "pending" } });
    if (res.status() !== 200) {
      throw new Error(`GET /api/v1/approvals (pending) answered ${res.status()}`);
    }
    const body = (await res.json()) as { approvals: { id: string; run_id: string }[] };
    const mine = body.approvals.filter((a) => a.run_id === runId);
    if (mine.length === 1) return mine[0].id;
    if (Date.now() > deadline)
      throw new Error(
        `expected exactly one pending gate for run ${runId.slice(0, 8)}…, found ${mine.length}`,
      );
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
}

/**
 * The workbench draws its pinned revision on the shared Studio canvas: the
 * definition node is `canvas-step-<def id>` and its inner
 * `div[role="button"]` is what the page's single-select listens for —
 * clicking it puts the node in the URL (`?node=&instance=`) and opens it in
 * the dock, replacing the old stage strip's cell as the way a reader picks a
 * node.
 */
function canvasNode(page: Page, defId: string): Locator {
  return page.locator(`[data-testid="canvas-step-${defId}"]`).locator('div[role="button"]').first();
}

/**
 * The newest attempt number the pane's crumb itself serves — `NodePaneHeader`
 * prints `<node_id> · attempt N` for the node's LAST attempt. Read, not
 * assumed: a node whose first attempt hit a retriable `infra`/`interrupted`
 * error really does have an attempt 2, and then "the attempt that ran the
 * survey" is the newest one. Returns 0-safe by failing the poll if the pane
 * never names an attempt.
 */
async function newestAttemptNumber(page: Page, timeout: number): Promise<number> {
  let newest = 0;
  await expect
    .poll(
      async () => {
        const match = /attempt (\d+)/.exec(await page.getByTestId("node-pane-crumb").innerText());
        newest = match ? Number(match[1]) : 0;
        return newest;
      },
      { timeout, message: "the node pane never named an attempt in its crumb" },
    )
    .toBeGreaterThan(0);
  return newest;
}

/**
 * What gets typed into the draft editor: `docs/samples/home/plan-with-approval
 * .yaml` with its `model.chat` node replaced by a `process.exec` node that
 * prints the plan as the JSON the node's `outputs` schema declares. Everything
 * else — node ids, bindings, the approval's summary interpolation, the
 * artifact-publish node — is the sample's, byte for byte in shape. `__SLUG__`
 * is rewritten the way the library's own template picker rewrites
 * `metadata.name`, because a document whose name disagrees with the definition
 * the server created is a document the author did not clone.
 */
const DETERMINISTIC_TWIN = `# docs/samples/home/plan-with-approval.yaml — a plan-on-a-real-repo pipeline the
# home-cluster worker can actually execute, with the sample's model.chat node
# replaced by a process.exec node that prints a fixed plan: the same twin trick
# the M4 seed uses, so the approval gate is reached with no model endpoint.
apiVersion: communication.dev/v1alpha1
kind: Pipeline
metadata:
  name: __SLUG__
  description: >-
    Survey a repository checkout, draft an implementation plan for a goal, hold
    it behind a maintainer approval, and publish the approved-shape plan.
spec:
  inputs:
    type: object
    required: [goal, repository]
    properties:
      goal:
        type: string
        minLength: 1
        description: What the plan should accomplish.
      repository:
        type: string
        minLength: 1
        description: Project repository binding name, e.g. app.
  outputs:
    type: object
    required: [plan]
    properties:
      plan: {type: string}
  policies:
    maxConcurrentNodes: 1
    maxDurationSeconds: 7200
    maxNodeExecutions: 20
    maxChildDepth: 0
    workspaceMode: worktree
    cancelPolicy: cascade
  nodes:
  - id: survey
    kind: process.exec
    timeoutSeconds: 300
    retry:
      maxAttempts: 2
      backoff: {baseSeconds: 5, multiplier: 2, maxSeconds: 60, jitter: false}
      retriableErrors: [infra, interrupted]
    config:
      executable: sh
      args:
      - -c
      - |
        for d in "repos/$REPO" "../repos/$REPO"; do
          test -d "$d" && { REPO_DIR="$d"; break; }
        done
        test -n "$REPO_DIR" || { echo "no checkout for $REPO in the run workspace" >&2; exit 1; }
        cd "$REPO_DIR" || exit 1
        echo "== files =="
        LIST=$(git ls-files 2>/dev/null)
        test -n "$LIST" || LIST=$(find . -path './.git' -prune -o -type f -print | head -200)
        printf '%s\\n' "$LIST" | head -200
        echo
        echo "== README.md =="
        head -80 README.md 2>/dev/null || echo '(no README.md)'
      env:
        REPO: \${{ inputs.repository }}
      workspace:
        mode: read_only
        repositories: ['\${{ inputs.repository }}']
      outputExtraction: {mode: none}
    outputs:
      type: object
      required: [exit_code, stdout_preview]
      properties:
        exit_code: {type: integer}
        stdout_preview: {type: string}
  - id: plan
    kind: process.exec
    dependsOn: [survey]
    timeoutSeconds: 600
    config:
      executable: printf
      args:
      - '%s\\n'
      - '{"text":"1. Read hello.py and its tests before touching anything. 2. ${PLAN_LINE} that states its types. 3. Fix the failing comparison and re-run the tests."}'
      outputExtraction: {mode: json_from_stdout}
    outputs:
      type: object
      required: [text]
      properties:
        text: {type: string, minLength: 1}
  - id: approve
    kind: human.approval
    dependsOn: [plan]
    retry:
      maxAttempts: 1
    config:
      summary: |
        Plan for \${{ inputs.goal }} in repository \${{ inputs.repository }}
        \${{ nodes.plan.outputs.text }}
      approverRoles: [maintainer]
      # Generous, not the sample's day: the decision below is made by the
      # person, and an unanswered gate must not fail the run behind its back.
      deadlineSeconds: 600
      onTimeout: fail
  - id: publish_plan
    kind: artifact.publish
    dependsOn: [approve]
    config:
      name: plan.md
      kind: markdown
      mediaType: text/markdown
      sensitivity: standard
      from:
        mode: output_json
        value: \${{ nodes.plan.outputs }}
  # The run's own check, and it fails on purpose: the plan describes a test
  # suite this fixture repository does not have. The command's exit 1 alone is
  # only a BUSINESS verdict (spec 03:49; procexec.go's classify maps 1..125 to
  # succeeded/outcome 'failed', which completes the run), so the node also
  # declares exit_code 0 as the only envelope it accepts: the boundary
  # refuses a success its plan would not accept (docs/m4-contract.md § 4 step 8,
  # the rule m4_c10 proves) and the attempt closes invalid_output. maxAttempts 1
  # means a second attempt of this node can only ever come from a human retry.
  - id: verify
    kind: process.exec
    dependsOn: [publish_plan]
    timeoutSeconds: 120
    retry:
      maxAttempts: 1
    config:
      executable: sh
      args:
      - -c
      - |
        echo 'no test suite in this checkout — the plan cannot be verified' >&2
        exit 1
      outputExtraction: {mode: none}
    outputs:
      type: object
      required: [exit_code]
      properties:
        exit_code: {type: integer, const: 0}
  resultBindings:
    plan: \${{ nodes.plan.outputs.text }}
`;

/**
 * The scratch copy the gate-retry test needs and the journey's own run cannot
 * give it: a `human.approval` gate whose deadline actually PASSES inside the
 * suite's time budget. `deadlineSeconds: 60` is the schema's floor
 * (`internal/pipelines/schema/assets/pipeline-v1alpha1.schema.json`,
 * `deadlineSeconds.minimum`); the journey's own gate is 600s precisely so the
 * person decides it rather than the clock. `onTimeout: fail` is the arm that
 * closes the gate `expired` on the FIRST deadline — `expire` re-requests
 * exactly once before it expires (§ 5.4 pass 2, `Expire` in
 * internal/pipelines/runtime/state.go), which would need two windows.
 *
 * The gate is the ROOT node, so `waiting_human` costs no worker turn and the
 * 60s window starts the moment the run is created; the single `process.exec`
 * node behind it is the same `printf` twin trick, and it is what makes
 * "approving let the run proceed" an observed fact rather than a chip colour.
 * Authored and published through the library's own draft path (the way the
 * journey authors its pipeline), and used by no other test — a 60-second
 * deadline would be spent by anything slower than this one.
 */
const GATE_TWIN = `# scratch gate: plan-with-approval's approval node at the schema's shortest
# deadline, plus the one process.exec node it holds back.
apiVersion: communication.dev/v1alpha1
kind: Pipeline
metadata:
  name: __GATE_SLUG__
  description: >-
    Scratch: one maintainer approval gate with the shortest deadline the schema
    admits, and the process.exec node that runs only once it is answered.
spec:
  inputs:
    type: object
    required: [goal]
    properties:
      goal:
        type: string
        minLength: 1
        description: What the gate is asking about.
  outputs:
    type: object
    required: [after]
    properties:
      after: {type: string}
  policies:
    maxConcurrentNodes: 1
    maxDurationSeconds: 7200
    maxNodeExecutions: 20
    maxChildDepth: 0
    workspaceMode: worktree
    cancelPolicy: cascade
  nodes:
  - id: approve
    kind: human.approval
    retry:
      maxAttempts: 1
    config:
      summary: |
        Scratch gate for \${{ inputs.goal }} — let this deadline pass, then retry the run.
      approverRoles: [maintainer]
      # The schema floor, and the point of this document: the deadline has to
      # pass while the test is watching it.
      deadlineSeconds: 60
      onTimeout: fail
  - id: after_gate
    kind: process.exec
    dependsOn: [approve]
    timeoutSeconds: 120
    retry:
      maxAttempts: 1
    config:
      executable: printf
      args:
      - '%s\\n'
      - '{"after":"ran off the re-armed gate"}'
      outputExtraction: {mode: json_from_stdout}
    outputs:
      type: object
      required: [after]
      properties:
        after: {type: string, minLength: 1}
  resultBindings:
    after: \${{ nodes.after_gate.outputs.after }}
`;

/**
 * The scratch copy the rejection arm needs, which neither existing twin can
 * give: the journey's run answered its gate back in step 6, and `GATE_TWIN`
 * races a 60 s schema-floor deadline that a person could lose. This document
 * is `internal/pipelines/runtime/testdata/gate_sibling.yaml`'s shape driven
 * through the real product: the gate is the ROOT node (so `waiting_human`
 * and the decision cost no worker turn), its deadline is the journey's
 * generous 600 s (the POINT is the human answer, not the clock), and its one
 * dependant carries the guard the contract describes —
 * `when: nodes.approve.outputs.decision == 'approved'`. Rejected, the
 * dependant must come back `skipped` and the run `completed`: exactly C9e
 * (`docs/m4-contract.md` § 5.3 / § 8) on a live lab instead of a runtime
 * test. Authored through the library's own draft path like the other two.
 */
const REJECT_TWIN = `# scratch rejection arm: plan-with-approval's gate at the root, generous
# deadline, and the one node behind it guarded by the decision itself.
apiVersion: communication.dev/v1alpha1
kind: Pipeline
metadata:
  name: __REJECT_SLUG__
  description: >-
    Scratch: one maintainer approval gate whose dependant runs only when the
    decision is approved, so a rejection settles the run as a business
    outcome instead of an execution failure.
spec:
  inputs:
    type: object
    required: [goal]
    properties:
      goal:
        type: string
        minLength: 1
        description: What the gate is asking about.
  outputs:
    type: object
    required: [gate_decision]
    properties:
      gate_decision: {type: string}
  policies:
    maxConcurrentNodes: 1
    maxDurationSeconds: 7200
    maxNodeExecutions: 20
    maxChildDepth: 0
    workspaceMode: worktree
    cancelPolicy: cascade
  nodes:
  - id: approve
    kind: human.approval
    retry:
      maxAttempts: 1
    config:
      summary: |
        Scratch rejection arm for \${{ inputs.goal }} — say no, and the guarded step must stay unrun.
      approverRoles: [maintainer]
      # Generous like the journey's gate and for the opposite reason of
      # GATE_TWIN's 60 s: this deadline must NEVER pass before the person
      # answers — the decision, not the clock, is the subject of this twin.
      deadlineSeconds: 600
      onTimeout: fail
  - id: guarded
    kind: process.exec
    dependsOn: [approve]
    when: nodes.approve.outputs.decision == 'approved'
    timeoutSeconds: 120
    retry:
      maxAttempts: 1
    config:
      executable: printf
      args:
      - '%s\\n'
      - '{"after":"only an approval runs this"}'
      outputExtraction: {mode: json_from_stdout}
    outputs:
      type: object
      required: [after]
      properties:
        after: {type: string, minLength: 1}
  resultBindings:
    gate_decision: \${{ nodes.approve.outputs.decision }}
`;

test.describe("M5 clone, customize, stall, take control, retry, evidence", () => {
  test.describe.configure({ mode: "serial", timeout: RUN_TIMEOUT_MS + 2 * DECISION_TIMEOUT_MS });
  test.skip(
    !M5_ENABLED,
    "Needs the M4 lab stack (ports 18091-18093) — run with COMMUNICATION_E2E_M5=1",
  );

  let adminContext: BrowserContext;
  let aliceContext: BrowserContext;
  let admin: Page;
  let alice: Page;
  let pipelinePath = ""; // /factory/{pipelineId}
  let draftId = "";
  let projectPath = ""; // /p/{M4 Exit id}
  let runPath = ""; // /runs/{runId} (route contract C1)
  let runId = "";

  test.beforeAll(async ({ browser }) => {
    // Two contexts, two signed-in identities, one shared lab (ADR-0006: the
    // browser is never the only proof — every step below reads a served fact).
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
      await shot(admin, "m5-00-signed-in");
    });
  });

  test("step 1 — admin creates the workflow via Factory New workflow → Import YAML", async () => {
    await test.step("Factory → New workflow → Import YAML", async () => {
      const created = await importWorkflowInFactory(
        admin,
        SLUG,
        DETERMINISTIC_TWIN.replace("__SLUG__", SLUG),
      );
      pipelinePath = created.pipelinePath;
      draftId = created.draftId;
      await admin.getByTestId("editor-more-btn").click();
      await admin.getByTestId("editor-menu-yaml").click();
      const yaml = admin.getByTestId("studio-yaml");
      await expect(yaml).toHaveValue(new RegExp(SLUG));
      await expect(yaml).not.toHaveValue(/kind: model\.chat/);
      await expect(yaml).toHaveValue(/kind: process\.exec/);
      await expect(yaml).toHaveValue(/kind: human\.approval/);
      await admin.getByTestId("editor-panel-close").click();
      await shot(admin, "m5-01-template-draft");
    });
  });

  test("step 2 — customize the draft, autosave, Make live as r1", async () => {
    await test.step("the step form changes one field: the survey node's timeout", async () => {
      // The canvas steps are addressed by node id: the survey node's timeout.
      await admin.getByTestId("canvas-step-survey").click();
      // 1a: the step's beside card opens first; "More settings" opens the panel.
      await openFullStepPanel(admin);
      // The node's timeout lives inside the collapsed "Retries, timeout and
      // outputs" disclosure — open it before touching the field.
      await admin.getByTestId("insp-advanced-disclosure").locator("summary").click();
      const timeout = admin.getByTestId("insp-timeoutSeconds");
      await expect(timeout).toHaveValue("300");
      await timeout.fill("420");
      // Number fields commit on blur/Enter; the write lands on the document,
      // which the YAML panel then shows.
      await timeout.press("Enter");
      await admin.getByTestId("editor-more-btn").click();
      await admin.getByTestId("editor-menu-yaml").click();
      await expect(admin.getByTestId("studio-yaml")).toHaveValue(/timeoutSeconds: 420/);
      await admin.getByTestId("editor-panel-close").click();
    });
    await test.step("Autosave settles on the server", async () => {
      await expect
        .poll(
          async () => {
            const res = await admin.request.get(`/api/v1/drafts/${draftId}`);
            if (!res.ok()) return "";
            return ((await res.json()) as { document_yaml?: string }).document_yaml ?? "";
          },
          { timeout: 30_000, message: "draft autosaved timeoutSeconds: 420" },
        )
        .toContain("timeoutSeconds: 420");
      await expect(admin.getByTestId("studio-draft-status")).not.toContainText(/Saving/i, {
        timeout: 30_000,
      });
      await expect(admin.getByTestId("studio-publish")).toBeEnabled();
    });
    await test.step("Make live → r1 is immutable and listed in Versions", async () => {
      await admin.getByTestId("studio-publish").click();
      await expect(admin.getByTestId("studio-published")).toContainText("published as r1", {
        timeout: 30_000,
      });
      // Versions panel replaces the old workflow History tab.
      await admin.getByTestId("editor-versions-btn").click();
      await expect(admin.getByTestId("versions-row-v1")).toContainText("v1", { timeout: 30_000 });
      await admin.getByTestId("versions-panel-close").click();
      await shot(admin, "m5-02-published-r1");
    });
  });

  test("step 3 — assign r1 to a project alice maintains", async () => {
    await test.step("Studio More → Use in a repo…", async () => {
      await gotoApp(admin, pipelinePath);
      await expect(admin.getByTestId("studio-canvas")).toBeVisible({ timeout: 30_000 });
      await admin.getByTestId("editor-more-btn").click();
      await admin.getByTestId("editor-menu-use").click();
      await expect(admin.getByTestId("use-in-repo-dialog")).toBeVisible({ timeout: 15_000 });
      const assign = admin.getByTestId("assign-project-select");
      const deadEnd = admin.getByTestId("assign-no-maintainer");
      const arm = await Promise.race([
        assign
          .waitFor({ state: "visible", timeout: 15_000 })
          .then(() => "maintainer" as const)
          .catch(() => null),
        deadEnd
          .waitFor({ state: "visible", timeout: 15_000 })
          .then(() => "dead-end" as const)
          .catch(() => null),
      ]);
      if (arm !== "maintainer" && arm !== "dead-end") {
        throw new Error(
          "no assign arm rendered in UseInRepoDialog — neither assign-project-select nor assign-no-maintainer within 15 s",
        );
      }
      if (arm === "maintainer") {
        const assignTitle = admin.getByTestId("use-in-repo-title");
        await expect(assignTitle, "the dialog names the workflow and the action").toHaveText(
          `Use ${SLUG} in a repo…`,
        );
        await selectByOptionText(admin, "assign-project-select", ALICE.projectName);
        await expect(
          admin.getByTestId("assign-project-states"),
          "design 2a: nothing pins this workflow yet, so the bookkeeping list renders nothing",
        ).toHaveCount(0);
        await expect(
          admin.getByTestId("assign-project-states").locator("button"),
          "the project-state rows are read-only — no `Use here` button anywhere (one way to choose)",
        ).toHaveCount(0);
        await selectByOptionText(admin, "assign-repo-select", "whole project");
        await expect(
          assignTitle,
          "whole-project choice: the title says which repos the pin covers",
        ).toHaveText(`Use ${SLUG} in every repo of ${ALICE.projectName}`);
        const created = admin.waitForResponse(
          (response) =>
            response.url().includes("/api/v1/projects/") &&
            response.url().includes("/assignments") &&
            response.request().method() === "POST",
          { timeout: 30_000 },
        );
        await admin.getByTestId("assign-confirm").click();
        const createdBody = (await (await created).json()) as { id?: string };
        await expect(admin.getByTestId("assign-success-panel")).toContainText("Used in", {
          timeout: 30_000,
        });
        const assignmentId = createdBody.id ?? "";
        expect(assignmentId, "the POST answered the assignment").toMatch(/^[0-9a-f-]{36}$/);
        await admin.getByTestId("assign-start-run-link").click();
        await admin.waitForURL(/\/factory\/[0-9a-f-]{36}.*[?&]panel=used-in/);
        await expect(admin.getByTestId(`used-in-row-${assignmentId}`)).toBeVisible({
          timeout: 30_000,
        });
        projectPath = await openProjectBySlug(alice, ALICE.projectSlug);
        await gotoApp(alice, `${projectPath}/factory`);
        await shot(admin, "m5-03-assigned");
      } else {
        await expect(deadEnd).toBeVisible();
        projectPath = await openProjectBySlug(alice, ALICE.projectSlug);
        await pinWorkflowOnProject(alice, projectPath, SLUG);
        await gotoApp(alice, `${projectPath}/factory`);
        await shot(alice, "m5-03-assigned");
      }
    });
  });

  test("step 4 — start a run of the pinned revision", async () => {
    await test.step("the New run form offers exactly the revision's spec.inputs", async () => {
      // Whichever identity pinned the assignment, the run belongs to the
      // project's maintainer — alice is the one the seed put there.
      // Design 1b (project-tabs-2): the RUNS panel carries no `New run` of its
      // own — the header band's `Start run` is the page's one door into the form.
      await openRunForm(alice, projectPath);
      await selectByOptionText(alice, "new-run-assignment", SLUG);
      await alice.getByTestId("new-run-input-goal").fill(GOAL);
      // 1k (run by hand): the typed form renders this revision's un-annotated
      // `repository: {type: string}` as a mono text field — the run-by-hand
      // form carries a repo only when it was opened FROM a repo row (this one
      // opens from the project header), so the binding name is typed, never a
      // URL a user has to remember.
      await alice.getByTestId("new-run-input-repository").fill(REPO_BINDING);
      await alice.getByTestId("new-run-submit").click();
      // Route contract C1: the workbench is the project-less `/runs/:runId`.
      await alice.waitForURL(/\/runs\/[0-9a-f-]{36}$/);
      runPath = new URL(alice.url()).pathname;
      runId = runPath.split("/").pop() ?? "";
      expect(runId).toMatch(/^[0-9a-f-]{36}$/);
      await shot(alice, "m5-04-run-started");
    });
  });

  test("step 5 — the run stalls at its approval gate, and both screens say so", async () => {
    await test.step("the run reaches waiting_human on its own", async () => {
      // Two process.exec nodes first (a clone and a printed plan), then the
      // gate: the wait is for the worker, not for a model. The chip's word is
      // the app's SHORT_WORD for the wire's `waiting_human` — `need you`, the
      // same word the Runs tab's chip and the stage strip print (the run page
      // no longer spells `waiting_human` out).
      await expectRunStatus(alice, /need you/, RUN_TIMEOUT_MS);
    });
    await test.step("Home shows it under NEEDS YOU", async () => {
      // Redesign: Needs-you decision cards live on Home (`/`).
      await gotoApp(alice, "/");
      await expect(alice.getByTestId("needs-you")).toBeVisible({ timeout: 60_000 });
      const gateId = await pendingGateFor(alice, runId, 60_000);
      const row = alice.getByTestId(`needs-you-card-${gateId}`);
      await expect(row).toBeVisible({ timeout: 15_000 });
      await expect(row).toContainText(GOAL);
      await shot(alice, "m5-05-overview-needs-your-decision");
    });
    await test.step("the gate card carries a plan a person can read", async () => {
      await gotoApp(alice, runPath);
      // The workbench's graph IS the run page: the approve node wears the
      // waiting overlay on the canvas itself, and selecting it opens the gate
      // in the dock, which leads a `human.approval` with the gate card.
      await expect(canvasNode(alice, "approve")).toBeVisible({ timeout: 30_000 });
      await expect(alice.getByTestId("step-status-approve")).toBeVisible({ timeout: 30_000 });
      // Design run view (10): the run page's graph is a READING surface. The
      // authoring affordances the same canvas draws in the Studio — an edge's
      // `+` (edge-add-*) and the terminal's `Add a step after` (add-after-*) —
      // are rendered only on an editable canvas, so none of them may exist
      // inside the workbench's graph frame. (The node itself stays clickable:
      // selecting is reading, and the assertions below depend on it.)
      const graphFrame = alice.locator('[data-testid="workbench-graph-frame"]');
      await expect(
        graphFrame,
        "the node being read is drawn in the workbench's graph frame",
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        graphFrame.locator('[data-testid^="edge-add-"]'),
        "the run page's graph adds no edges",
      ).toHaveCount(0);
      await expect(
        graphFrame.locator('[data-testid^="add-after-"]'),
        "the run page's graph adds no steps",
      ).toHaveCount(0);
      await canvasNode(alice, "approve").click();
      await expect(alice.getByTestId("approval-state")).toHaveText("needs your decision", {
        timeout: 30_000,
      });
      // a29d3ed (round-2 review item 3): the card prints the step LEAF
      // (`stepWordOf`), not the compiled key — the root scope's `/approve`
      // renders as `approve`, with the full key moved to the value's `title`.
      // The leaf check holds under either reading.
      await expect(alice.getByTestId("approval-node")).toContainText("approve");
      await expect(alice.getByTestId("approval-roles")).toContainText("maintainer");
      const summary = alice.getByTestId("approval-summary");
      await expect(summary.getByTestId("plan-plain-text")).toContainText(`Plan for ${GOAL}`, {
        timeout: 30_000,
      });
      await expect(summary.getByTestId("plan-plain-text")).toContainText(PLAN_LINE);
      // Decoded, not dumped: the reader is never handed the node's JSON.
      await expect(summary).not.toContainText("{");
      await expect(alice.getByTestId("approval-decision-form")).toBeVisible();
      await shot(alice, "m5-05-gate-card");
    });
  });

  /**
   * Step 6 retries the run at its `verify` `process.exec` node — the ONE path
   * route 31 makes retriable here. `POST /runs/{runId}/retry` "targets
   * failed/interrupted/cancelled node executions" (`docs/m4-contract.md:536`),
   * and `/verify` is `failed` (its `exit_code: 1` envelope is refused by its
   * own outputs schema, `maxAttempts: 1`, so attempt 2 can only be a human
   * retry). A **rejected gate is not a retriable thing**: the gate
   * row goes `succeeded` with `outcome: rejected` and dependants skip via
   * `when` (§ 5.3 `docs/m4-contract.md:810`, C9e `:1204`; the engine refuses a
   * named `succeeded` target in `internal/pipelines/runtime/retry.go` and the
   * API answers `409 run_not_retriable` in
   * `internal/store/postgres/m4api_runs_write.go`). So the run is NOT expected
   * to come back to `waiting_human` — a rejection is final by design, and only
   * an `approval_expired` **timeout** is an execution failure (§ 5.4 pass 2).
   */
  test("step 6 — take control: approve, watch the run fail, and retry the node that failed", async () => {
    await test.step("the maintainer decides the gate herself", async () => {
      // This template has no `agent.acp` node, so there is no attempt
      // conversation to take control of; the human half of control is the
      // gate, and the decision is made here, not by the deadline.
      // Finding 04: the card's own comment box is gone — the ONE DecisionBar
      // carries the fixed verbs, and a note belongs to `Request changes`, which
      // records a REJECTION. This leg approves the plan, so it decides with the
      // bar's Approve verb and carries no note; the hold + exactly-one-POST
      // checks live in `decideGate`.
      await decideGate(alice.getByTestId("approval-decision-form"), "approve", undefined, {
        timeoutMs: DECISION_TIMEOUT_MS,
      });
      await expect(alice.getByTestId("approval-decided")).toBeVisible({
        timeout: DECISION_TIMEOUT_MS,
      });
      await shot(alice, "m5-06-decided");
    });
    await test.step("the run's own check fails it, and Home factory health reports attention", async () => {
      await expectRunStatus(alice, /failed/, RUN_TIMEOUT_MS);
      await gotoApp(alice, "/");
      const healthSentence = alice.getByTestId("factory-health-sentence");
      await expect(healthSentence).toBeVisible({ timeout: DECISION_TIMEOUT_MS });
      await expect(healthSentence).not.toHaveText("All quiet.");
      await shot(alice, "m5-06-stalled-overview");
    });
    await test.step("the retry is accepted from the run page: a run.retried frame and a second attempt", async () => {
      await gotoApp(alice, runPath);
      await expect(alice.getByTestId("run-retry")).toBeVisible();
      await expect(alice.getByTestId("run-retry")).toBeEnabled();
      await expect(alice.getByTestId("run-retry")).toHaveAttribute("title", /\/verify/);
      await expect(alice.getByTestId("run-retry-reason")).toHaveCount(0);
      await alice.getByTestId("run-retry").click();
      await alice.getByTestId("workbench-tab-timeline").click();
      await expect(alice.getByTestId("run-timeline")).toContainText("run.retried", {
        timeout: DECISION_TIMEOUT_MS,
      });
      await alice.getByTestId("workbench-tab-graph").click();
      await canvasNode(alice, "verify").click();
      await expect(alice.getByTestId("node-pane-crumb")).toContainText("verify", {
        timeout: DECISION_TIMEOUT_MS,
      });
      await expect(alice.getByTestId("node-pane-crumb")).toContainText("attempt 2", {
        timeout: DECISION_TIMEOUT_MS,
      });
      await expect(dockAttemptTabs(alice)).toHaveCount(2);
      await expect(attemptPane(alice, 2)).toBeVisible({ timeout: DECISION_TIMEOUT_MS });
      await alice.getByTestId("dock-attempt-1").click();
      await expect(attemptPane(alice, 1)).toBeVisible();
      await shot(alice, "m5-06-retried");
    });
    await test.step("once attempt 2 settles failed, Retry is armed again in header and dock", async () => {
      await expectRunStatus(alice, /failed/, RUN_TIMEOUT_MS);
      await expect(alice.getByTestId("run-retry")).toBeVisible();
      await expect(alice.getByTestId("run-retry")).toBeEnabled();
      await expect(alice.getByTestId("run-retry")).toHaveAttribute("title", /\/verify/);
      await expect(alice.getByTestId("run-retry-reason")).toHaveCount(0);
      await canvasNode(alice, "verify").click();
      await expect(alice.getByTestId("dock-failure")).toBeVisible({ timeout: 30_000 });
      await expect(alice.getByTestId("dock-error-class")).toContainText("invalid_output");
      await expect(alice.getByTestId("dock-retry-verdict")).toContainText("Re-runs 1 node");
      await expect(alice.getByTestId("dock-retry-verdict")).toContainText("/verify");
      await shot(alice, "m5-06-run-page-retry");
    });
  });

  test("step 7 — view the evidence: the run's journal and the attempt's own record", async () => {
    await test.step("the Timeline tab renders journal rows", async () => {
      await gotoApp(alice, runPath);
      await alice.getByTestId("workbench-tab-timeline").click();
      await expect(alice.getByTestId("run-timeline")).toBeVisible({ timeout: 30_000 });
      await expect(alice.locator('[data-testid^="run-timeline-item-"]').first()).toBeVisible();
      await expect(alice.getByTestId("run-timeline-count")).toBeVisible();
      // The whole story of the last two steps is in the journal the page draws.
      for (const type of ["run.waiting_human", "run.failed", "run.retried"]) {
        await expect(alice.getByTestId("run-timeline")).toContainText(type, { timeout: 30_000 });
      }
      await shot(alice, "m5-07-timeline");
    });
    await test.step("the deterministic survey attempt reports what it actually ran", async () => {
      // Back on the graph: the node is picked where it is drawn, and the
      // dock serves its attempt.
      await alice.getByTestId("workbench-tab-graph").click();
      await canvasNode(alice, "survey").click();
      await expect(alice.getByTestId("node-pane-crumb")).toContainText("survey", {
        timeout: DECISION_TIMEOUT_MS,
      });
      // Which attempt: the NEWEST one the crumb serves, scoped to its own
      // panel. The newest is the attempt whose envelope the boundary
      // accepted — the only attempt whose exit code can be a fact about this
      // run — and the number has to be read rather than assumed to be 1.
      const newest = await newestAttemptNumber(alice, DECISION_TIMEOUT_MS);
      const att = attemptPane(alice, newest);
      await expect(att.getByTestId("attempt-process-facts")).toBeVisible({ timeout: 30_000 });
      await expect(att.getByTestId("attempt-exit-code")).toHaveText("0");
      await expect(att.getByTestId("attempt-stdout")).toContainText("== files ==");
      await expect(att.getByTestId("attempt-events")).toBeVisible();
      // The dock names every attempt the node ran as a tab (one per attempt,
      // each drawn once) and serves the newest by default — that is what
      // makes the scoping above a claim about attempts instead of a locator
      // workaround.
      await expect(dockAttemptTabs(alice)).toHaveCount(newest > 1 ? newest : 0);
      await shot(alice, "m5-07-attempt-evidence");
    });
    await test.step("the retried verify node shows both attempts, the failure and the retry", async () => {
      // This step's claim is about TWO attempts, so both are addressed by
      // number: attempt 1 is the one the boundary refused, attempt 2 is the
      // human retry step 6 asked for. A pane that kept only its newest row
      // would hide the failure the journal recorded (`10` J7's honesty rule).
      // The dock serves one attempt at a time, so each is selected before
      // what it says is read.
      await alice.getByTestId("workbench-tab-graph").click();
      await canvasNode(alice, "verify").click();
      await expect(alice.getByTestId("node-pane-crumb")).toContainText("verify", {
        timeout: DECISION_TIMEOUT_MS,
      });
      // Both attempts are real tabs — the count, not a replacement.
      await expect(dockAttemptTabs(alice)).toHaveCount(2);
      await alice.getByTestId("dock-attempt-1").click();
      await expect(alice.getByTestId("node-pane-crumb")).toContainText("attempt 1");
      const first = attemptPane(alice, 1);
      await expect(first.getByTestId("attempt-status")).toContainText("failed", {
        timeout: DECISION_TIMEOUT_MS,
      });
      // invalid_output is the class, and the schema's own locations are the
      // evidence: the node's exit 1 was refused by its plan, not reported as a
      // business verdict.
      await expect(first.getByTestId("error-class-invalid_output")).toBeVisible();
      await expect(first.getByTestId("attempt-output-errors")).toBeVisible();
      // `rejectOutputs` (internal/store/postgres/attempt_worker.go) serves NO
      // outputs for a refused envelope, so the facts block reads "not served"
      // rather than lending the attempt the exit code it was refused for.
      await expect(first.getByTestId("attempt-exit-code")).toHaveText("not served");
      // Attempt 2 — the same deterministic command, run again because a person
      // asked. Its verdict is only a fact once the worker closes it, so this
      // wait is the run's budget, not the advancer's.
      await alice.getByTestId("dock-attempt-2").click();
      await expect(alice.getByTestId("node-pane-crumb")).toContainText("attempt 2");
      const second = attemptPane(alice, 2);
      await expect(second.getByTestId("error-class-invalid_output")).toBeVisible({
        timeout: RUN_TIMEOUT_MS,
      });
      await expect(second.getByTestId("attempt-output-errors")).toBeVisible();
      await expect(second.getByTestId("attempt-exit-code")).toHaveText("not served");
      await shot(alice, "m5-07-both-attempts");
    });
    await test.step("the artifact the approved plan published renders", async () => {
      // `publish_plan` ran because the gate was approved: the evidence a person
      // can point at is a real artifact row, not a placeholder.
      await gotoApp(alice, `${projectPath}/artifacts`);
      await expect(alice.getByTestId("artifacts-title")).toBeVisible({ timeout: 30_000 });
      await expect(alice.getByTestId(/^artifact-row-/).first()).toBeVisible({
        timeout: DECISION_TIMEOUT_MS,
      });
      await shot(alice, "m5-07-artifacts");
    });
  });

  /**
   * The gate arm of the retry question, kept separate from step 6 on purpose:
   * only a gate that FAILED (the `approval_expired` timeout, § 5.4 pass 2) is a
   * retry target at all; a gate that answered `rejected` is `succeeded` and
   * route 31 has nothing to re-arm (see step 6's contract note and the
   * rejection arm below, which 14e8ff5 leaves untouched — a decided row is one
   * of the states `checkGateRetry` refuses to re-ask, now with the typed
   * `run_not_retriable` instead of the unique-violation 500).
   *
   * FINDING, observed while building this journey, and now the bug that is
   * fixed rather than the one that is open: retrying a run whose only retriable
   * node execution is a `human.approval` gate used to answer 500 —
   *   postgres: insert approval … (pending): duplicate key value violates
   *   unique constraint "approval_requests_node_execution_id_key"
   * (api-a request_id 4128cffa494a6f9f8ced9cc23f86e538, 2026-10-16). The
   * reopened gate asked for a FRESH approval row and ADR-0023 § 9 admits ONE
   * per node execution, so an unanswered-then-expired gate was a dead end.
   * 14e8ff5 re-arms that same row instead (`Rearm` in
   * internal/pipelines/runtime/state.go): state back to `pending`, a new
   * deadline, the CAS `version` bumped so a decide posted against the expired
   * gate cannot land, `created_at` kept, and `re_requested` marking the re-ask
   * — which is the ONLY re-request marker the table carries, and the one thing
   * the card can show to prove the ask is new while the row is not. Proven at
   * engine level by internal/pipelines/runtime/retry_gate_test.go; this is the
   * same claim driven through the browser, on a gate whose deadline can pass
   * inside the suite's own budget (the 60s schema floor, `GATE_TWIN`).
   */
  test("a retried run whose retriable node is an expired gate comes back live", async () => {
    let gatePath = ""; // /runs/{scratch run id}
    let gateRunId = "";
    let askedRow = ""; // the decision callout's own testid, id and all
    const gateId = () => testidOf(gateRunId);

    await test.step("publish a scratch copy whose gate deadline is the schema floor", async () => {
      const created = await importWorkflowInFactory(
        admin,
        GATE_SLUG,
        GATE_TWIN.replace("__GATE_SLUG__", GATE_SLUG),
      );
      await expect(admin.getByTestId("studio-draft-status")).not.toContainText(/Saving/i, {
        timeout: 30_000,
      });
      await expect
        .poll(
          async () => {
            const res = await admin.request.get(`/api/v1/drafts/${created.draftId}`);
            return res.ok()
              ? (((await res.json()) as { document_yaml?: string }).document_yaml ?? "")
              : "";
          },
          { timeout: 30_000 },
        )
        .toContain("deadlineSeconds: 60");
      await admin.getByTestId("studio-publish").click();
      await expect(admin.getByTestId("studio-published")).toContainText("published as r1", {
        timeout: 30_000,
      });
      await shot(admin, "m5-08-scratch-gate-published");
    });

    await test.step("run it: the gate is the root node, so waiting_human needs no worker", async () => {
      await pinWorkflowOnProject(alice, projectPath, GATE_SLUG);
      await openRunForm(alice, projectPath);
      await selectByOptionText(alice, "new-run-assignment", GATE_SLUG);
      await alice.getByTestId("new-run-input-goal").fill(GATE_GOAL);
      await alice.getByTestId("new-run-submit").click();
      await alice.waitForURL(/\/runs\/[0-9a-f-]{36}$/);
      gatePath = new URL(alice.url()).pathname;
      gateRunId = gatePath.split("/").pop() ?? "";
      expect(gateRunId).toMatch(/^[0-9a-f-]{36}$/);
      await expectRunStatus(alice, /need you/, RUN_TIMEOUT_MS);
      await canvasNode(alice, "approve").click();
      await expect(alice.getByTestId("approval-state")).toHaveText("needs your decision", {
        timeout: 30_000,
      });
      await gotoApp(alice, "/");
      const gateId = await pendingGateFor(alice, gateRunId, DECISION_TIMEOUT_MS);
      askedRow = `needs-you-card-${gateId}`;
      await expect(
        alice.getByTestId("needs-you").locator(`[data-testid="${askedRow}"]`),
      ).toBeVisible({ timeout: DECISION_TIMEOUT_MS });
      await shot(alice, "m5-08-scratch-gate-open");
    });

    await test.step("nobody answers: the deadline passes and the gate fails the run", async () => {
      await gotoApp(alice, gatePath);
      // The wait is bounded by the run budget, and it is a real 60s: the
      // driver's own tick (~5s, internal/store/postgres/m4driver.go) is what
      // reads the deadline, so expiry lands seconds after it, not a cadence away.
      await expectRunStatus(alice, /failed/, RUN_TIMEOUT_MS);
      await canvasNode(alice, "approve").click();
      // The card's state chip is the app's SHORT_WORD (identity rule 06), so an
      // expired gate wears `failed` — the wire's `expired` token is no longer
      // spelled out in a chip. WHY it failed is the sentence beside it, which is
      // the assertion that still distinguishes an expired gate from a refused
      // one (and the chip alone never could).
      await expect(alice.getByTestId("approval-state")).toHaveText("failed", {
        timeout: DECISION_TIMEOUT_MS,
      });
      await expect(alice.getByTestId("approval-expired-reason")).toContainText("deadline passed");
      // Not yet marked as a re-ask: on_timeout is `fail`, so this window is the
      // gate's first and only ask so far. Whatever sets `re_requested` later is
      // therefore the retry, not the deadline.
      await expect(alice.getByTestId("approval-re-requested")).toHaveCount(0);
      // The closed gate is NOT decidable — so "live again" below cannot be the
      // old card having simply stayed open.
      await expect(alice.getByTestId("approval-decision-form")).toHaveCount(0);
      await shot(alice, "m5-08-scratch-gate-expired");
    });

    await test.step("route 31 names the gate as its target, so the page arms Retry", async () => {
      await gotoApp(alice, gatePath);
      // Header arm: the workbench's `RunActions` button reads `retryVerdict`'
      // target set off `/runs/{id}/nodes` — the expired gate's node execution
      // is `failed`, so the button is live and names the node it will re-run,
      // with no reason line.
      await expect(alice.getByTestId("run-retry")).toBeVisible();
      await expect(alice.getByTestId("run-retry")).toBeEnabled();
      await expect(alice.getByTestId("run-retry")).toHaveAttribute("title", /\/approve/);
      await expect(alice.getByTestId("run-retry-reason")).toHaveCount(0);
      // The workbench's own arm: the dock's failure block on the gate reads
      // the same target set and arms the same way. The gate is a
      // control-plane failure, so the block carries no worker attempt.
      await canvasNode(alice, "approve").click();
      await expect(alice.getByTestId("dock-failure")).toBeVisible({ timeout: 30_000 });
      await expect(alice.getByTestId("dock-no-attempt")).toBeVisible();
      // The gate's own row is a target — the interrupted `/after_gate` may
      // join the verdict (its dependency died), exactly as the old button's
      // title named `/approve` among whatever else route 31 targeted.
      await expect(alice.getByTestId("dock-retry-verdict")).toContainText("/approve");
      await shot(alice, "m5-08-retry-armed-on-a-gate");
    });

    await test.step("the retry is accepted — the dead end is gone", async () => {
      // Retry directly from the run workbench header (`run-retry`), then verify
      // the SAME gate card (`askedRow`) re-appears in Needs you on Home.
      await expect(alice.getByTestId("run-retry")).toBeEnabled();
      await alice.getByTestId("run-retry").click();
      await expect(alice.getByTestId("run-action-error")).toHaveCount(0, {
        timeout: DECISION_TIMEOUT_MS,
      });
      await expectRunStatus(alice, /need you/, DECISION_TIMEOUT_MS);
      await gotoApp(alice, "/");
      const reAsk = alice.getByTestId("needs-you").locator(`[data-testid="${askedRow}"]`);
      await expect(reAsk).toHaveCount(1, { timeout: DECISION_TIMEOUT_MS });
      await shot(alice, "m5-08-overview-re-asked");
    });

    await test.step("the gate card is live again: the same ask, re-armed", async () => {
      await gotoApp(alice, gatePath);
      // Back to the human, in the header chip's short word: `need you`.
      await expectRunStatus(alice, /need you/, DECISION_TIMEOUT_MS);
      await canvasNode(alice, "approve").click();
      await expect(alice.getByTestId("approval-state")).toHaveText("needs your decision", {
        timeout: DECISION_TIMEOUT_MS,
      });
      await expect(alice.getByTestId("approval-decided")).toHaveCount(0);
      await expect(alice.getByTestId("approval-decision-form")).toBeVisible();
      // re_requested is the mark `Rearm` leaves on the row, and this card is
      // the only place a person can learn the ask is a second one.
      await expect(alice.getByTestId("approval-re-requested")).toContainText("asked for again");
      // The deadline moved with it: a gate counting down is a live wait, not a
      // reopened-looking row whose window had already passed.
      await expect(alice.getByTestId("approval-countdown")).toContainText(/left/, {
        timeout: DECISION_TIMEOUT_MS,
      });
      // The ask survived the reopen: the summary is still the row's own text.
      await expect(alice.getByTestId("approval-summary")).toContainText(GATE_GOAL);
      await shot(alice, "m5-08-gate-re-armed");
    });

    await test.step("approving the re-armed gate lets the run proceed", async () => {
      // Same rule as step 6: the note field that used to ride an Approve is
      // gone, so the re-armed gate is approved by verb alone.
      await decideGate(alice.getByTestId("approval-decision-form"), "approve", undefined, {
        timeoutMs: DECISION_TIMEOUT_MS,
      });
      await expect(alice.getByTestId("approval-decided")).toBeVisible({
        timeout: DECISION_TIMEOUT_MS,
      });
      // Not just an unblocked gate: the node behind it RAN, so the decision is
      // what carried the run to `completed`. That attempt is worker work, so
      // the wait is the run's budget rather than the advancer's.
      // The chip's short word for the wire's `completed` is `done`.
      await expectRunStatus(alice, /done/, RUN_TIMEOUT_MS);
      await canvasNode(alice, "after_gate").click();
      await expect(alice.getByTestId("node-pane-crumb")).toContainText("after_gate", {
        timeout: DECISION_TIMEOUT_MS,
      });
      const att = attemptPane(alice, await newestAttemptNumber(alice, DECISION_TIMEOUT_MS));
      await expect(att.getByTestId("attempt-exit-code")).toHaveText("0", {
        timeout: RUN_TIMEOUT_MS,
      });
      // The journal tells the whole arc in one pane: asked, expired, retried,
      // asked again.
      await alice.getByTestId("workbench-tab-timeline").click();
      for (const type of ["approval.requested", "approval.expired", "run.retried"]) {
        await expect(alice.getByTestId("run-timeline")).toContainText(type, {
          timeout: DECISION_TIMEOUT_MS,
        });
      }
      await shot(alice, "m5-08-gate-approved-run-completed");
    });
  });

  /**
   * The rejection arm, decided the way the spec decides it: `03`:49's
   * `execution_status=success` / `business_outcome=fail` split applied to
   * gates — `docs/m4-contract.md` § 5.3 and its C9e — rejecting a gate is a
   * BUSINESS outcome: the gate row closes `succeeded` with outcome `rejected`,
   * a dependant guarded by `when: nodes.approve.outputs.decision ==
   * 'approved'` comes back `skipped` (`node.execution_skipped` /
   * `condition_default`), and the run ends `completed`. Only a timeout is the
   * execution-side failure (`approval_expired` — the expired-gate arm above).
   *
   * This test used to `test.fixme` a real product contradiction: the
   * `ApprovalCard` promised “rejecting fails this run” while the engine
   * recorded a business outcome. The spec/contract side won (the engine, the
   * M4 contract § 5.3/C9e, the OpenAPI approval schema and
   * `retryVerdict`' honest disabled arm all agree; the numbered spec has no
   * Accepted statement that a rejection fails a run), so the card copy was
   * fixed instead. The lab image still serves the OLD pending-card sentence
   * until the orchestrator rebuilds — the fixed copy is proven by
   * `ui/src/components/m4/ApprovalCard.test.tsx` and
   * `ui/src/pages/Approval.test.tsx`; everything asserted below is a live
   * engine fact or copy that already shipped. The journey's own run cannot
   * carry this arm (its gate was approved in step 6, and its dependants are
   * unguarded, so a rejection there would say nothing about the guard),
   * `GATE_TWIN`'s 60 s floor races the person, and a rejection answered
   * `409 run_not_retriable` never re-opens a gate — hence REJECT_TWIN, this
   * test's third scratch pipeline.
   */
  test("a rejected gate is a business outcome: gate succeeded/rejected, guarded step skipped, run completed", async () => {
    let rejectPath = ""; // /runs/{rejection twin's run id}
    let rejectRunId = "";

    await test.step("publish the scratch rejection twin: root gate + one guarded step", async () => {
      const created = await importWorkflowInFactory(
        admin,
        REJECT_SLUG,
        REJECT_TWIN.replace("__REJECT_SLUG__", REJECT_SLUG),
      );
      await expect(admin.getByTestId("studio-draft-status")).not.toContainText(/Saving/i, {
        timeout: 30_000,
      });
      await expect
        .poll(
          async () => {
            const res = await admin.request.get(`/api/v1/drafts/${created.draftId}`);
            return res.ok()
              ? (((await res.json()) as { document_yaml?: string }).document_yaml ?? "")
              : "";
          },
          { timeout: 30_000 },
        )
        .toContain("approve");
      await admin.getByTestId("studio-publish").click();
      await expect(admin.getByTestId("studio-published")).toContainText("published as r1", {
        timeout: 30_000,
      });
      await shot(admin, "m5-09-reject-twin-published");
    });

    await test.step("a person rejects the gate from its card", async () => {
      // Design 1b: the Workflows tab's one library picker is the pin, and the
      // header band's `Start run` is the Runs tab's one door into the form.
      await pinWorkflowOnProject(alice, projectPath, REJECT_SLUG);
      await openRunForm(alice, projectPath);
      await selectByOptionText(alice, "new-run-assignment", REJECT_SLUG);
      await alice.getByTestId("new-run-input-goal").fill(REJECT_GOAL);
      await alice.getByTestId("new-run-submit").click();
      await alice.waitForURL(/\/runs\/[0-9a-f-]{36}$/);
      rejectPath = new URL(alice.url()).pathname;
      rejectRunId = rejectPath.split("/").pop() ?? "";
      expect(rejectRunId).toMatch(/^[0-9a-f-]{36}$/);
      // The gate is the root node: waiting_human costs no worker turn — and the
      // header chip says that state as `need you`, the SHORT_WORD the whole app
      // shares, never the wire's token spelled out.
      await expectRunStatus(alice, /need you/, DECISION_TIMEOUT_MS);
      await canvasNode(alice, "approve").click();
      await expect(alice.getByTestId("approval-state")).toHaveText("needs your decision", {
        timeout: 30_000,
      });
      // The row identity BEFORE the decision: one pending approval row per
      // node execution (ADR-0023 § 9), so this id IS the gate's row.
      const gateId = await pendingGateFor(alice, rejectRunId, DECISION_TIMEOUT_MS);
      // A rejection WITH the person's note is the bar's `Request changes` verb
      // (finding 04): the wire still records `rejected` and the comments. The
      // card no longer prints its CAS version — the token rides the POST now,
      // so the "still version 1, nobody decided first" claim is read off the
      // request body, which is the stronger place for it anyway.
      await decideGate(
        alice.getByTestId("approval-decision-form"),
        "changes",
        "No — this path is not taken.",
        {
          timeoutMs: DECISION_TIMEOUT_MS,
          expectedVersion: 1,
        },
      );
      // The decided card says `rejected` and nothing else failed it: the row
      // closed with a decision, not an error.
      await expect(alice.getByTestId("approval-decided")).toBeVisible({
        timeout: DECISION_TIMEOUT_MS,
      });
      await expect(alice.getByTestId("approval-decided")).toContainText("rejected");
      // The note rode the rejection: Request changes is a `rejected` decision
      // WITH the person's words, and the card is where they read back.
      await expect(alice.getByTestId("approval-decision-comments")).toContainText(
        "No — this path is not taken.",
      );
      // The row's own truth, from the API rather than the chip colour.
      const row = (await (await alice.request.get(`/api/v1/approvals/${gateId}`)).json()) as {
        state: string;
        decision: string | null;
        comments?: string | null;
      };
      expect(row.state, "the gate closed as DECIDED, not expired/denied").toBe("decided");
      expect(row.decision).toBe("rejected");
      expect(row.comments, "the wire keeps the note that Request changes wrote").toBe(
        "No — this path is not taken.",
      );
      await shot(alice, "m5-09-gate-rejected");
    });

    await test.step("the gate row is a SUCCESS with outcome rejected; the guarded step never ran; the run completed", async () => {
      // Nothing here waits on a worker: the guarded node is skipped without
      // ever being scheduled, so this settles on the advancer's ticks.
      // The chip's short word for the wire's `completed` is `done`.
      await expectRunStatus(alice, /done/, DECISION_TIMEOUT_MS);
      const nodes = (await (
        await alice.request.get(`/api/v1/runs/${rejectRunId}/nodes`)
      ).json()) as {
        node_executions: {
          node_instance_key: string;
          kind: string;
          status: string;
          outcome?: string | null;
        }[];
      };
      const gate = nodes.node_executions.find((n) => n.node_instance_key === "/approve");
      expect(gate, "the gate row exists").toBeTruthy();
      // C9e, observed: a rejection is NOT an execution failure.
      expect(gate?.status, "a rejected gate is a succeeded execution").toBe("succeeded");
      expect(gate?.outcome, "the business fact rides beside the execution fact").toBe("rejected");
      const guarded = nodes.node_executions.find((n) => n.node_instance_key === "/guarded");
      expect(guarded, "the guarded row exists").toBeTruthy();
      expect(guarded?.status, "a step that needed approval never ran").toBe("skipped");
      // The workbench tells the same story on the canvas itself. The card's own
      // chip is now the app's SHORT_WORD for the closed gate — `done`, because
      // the execution succeeded — and the lifecycle difference the wire calls
      // `decided` lives where the human reads it: inside the DECISION record, on
      // its own `rejected` chip. (The old assertion read the wire token off the
      // state chip, which is exactly the spelling the short-word table retired.)
      await canvasNode(alice, "approve").click();
      await expect(alice.getByTestId("approval-state")).toHaveText("done", {
        timeout: 30_000,
      });
      await expect(alice.getByTestId("approval-decided")).toContainText("rejected");
      await expect(alice.getByTestId("approval-decided")).not.toContainText(/expired|denied/i);
      await shot(alice, "m5-09-rejected-run-completed");
    });

    await test.step("and the finished run offers no Retry — the rejection was final, and says so", async () => {
      // The UI arm, per the brief's CHANGED CONTRACT (pass-1 design review item
      // 3): a rejected gate is a business outcome and leaves no retry target, so
      // the header shows no `Retry` verb at all. With the redesigned header
      // (finding 11) that means NEITHER the inline primary row NOR the ⋯ menu
      // carries `run-retry` — a closed-menu count(0) would pass vacuously for a
      // verb that merely rode the menu, so expectRunActionAbsent opens ⋯ and
      // looks inside before calling it absent. The note that replaces the verb
      // says the same fact in the header's measure, with the full sentence one
      // hover away (and in the dock beside a node that really failed).
      await expectRunActionAbsent(alice, "run-retry", 30_000);
      await expect(alice.getByTestId("run-retry-reason")).toContainText("answered rejected");
      await expect(alice.getByTestId("run-retry-reason")).toHaveAttribute(
        "title",
        /business outcome/,
      );
      // The run's own sentence is whole at 1280 — the thing the disabled verb cost.
      expect(
        await alice.evaluate(() => {
          const title = document.querySelector('[data-testid="run-title"]');
          return title instanceof HTMLElement ? title.scrollWidth - title.clientWidth : 9999;
        }),
      ).toBeLessThanOrEqual(0);
      // And the API agrees, so the UI is not the only truth: route 31
      // refuses the completed run with a 409 whose problem type is
      // `run-not-retriable`; a rejection never re-opens the gate. (The
      // served body is RFC 7807 — the `run_not_retriable` code of the
      // contract's spelling travels as the type URI, not a `code` field.)
      const me = (await (await alice.request.get("/api/v1/me")).json()) as { csrf_token: string };
      const refusal = await alice.request.post(`/api/v1/runs/${rejectRunId}/retry`, {
        data: {},
        headers: { "x-csrf-token": me.csrf_token },
      });
      expect(refusal.status()).toBe(409);
      const problem = (await refusal.json()) as { type?: string; run_status?: string };
      expect(problem.type).toBe("https://communication.dev/errors/run-not-retriable");
      expect(problem.run_status, "the refusal names the run's current status").toBe("completed");
    });
  });

  test("the run page itself offers a Retry control, and explains when it cannot", async () => {
    // The workbench header renders the same `RunActions` control the old run
    // page had — it reads route 31's own target set and either arms the verb or
    // shows none (a finished run with no target gets no button and no sentence:
    // pass-1 review item 3). The dock's failure block below keeps
    // `retryVerdict`'s target logic where the node is read: it either names the
    // nodes a retry would re-run or says why it has no target. Proven per-arm in
    // `ui/src/pages/RunInspector.test.tsx`; this is the live arm for a run
    // with a genuinely failed node.
    await gotoApp(alice, runPath);
    await expect(alice.getByTestId("run-retry")).toBeVisible();
    await expect(alice.getByTestId("run-retry")).toBeEnabled();
    await canvasNode(alice, "verify").click();
    await expect(alice.getByTestId("dock-failure")).toBeVisible({ timeout: 30_000 });
    await expect(alice.getByTestId("dock-retry-verdict")).toContainText("Re-runs 1 node");
    await expect(alice.getByTestId("dock-retry-verdict")).toContainText("/verify");
  });
});
