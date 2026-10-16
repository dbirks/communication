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
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { BASE_URL } from "./env.js";
import {
  expectRunStatus,
  gotoApp,
  openProjectBySlug,
  selectByOptionText,
  shot,
  shortRefOf,
  signIn,
  testidOf,
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
const PLAN_LINE = "Document add() with a docstring";
const stamp = process.env.E2E_M5_STAMP ?? new Date().toISOString().slice(11, 19).replace(/:/g, "");
const SLUG = `m5-journey-${stamp}`;

const M5_ENABLED = process.env.COMMUNICATION_E2E_M5 === "1";

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
  let pipelinePath = ""; // /library/{pipelineId}
  let projectPath = ""; // /projects/{M4 Exit id}
  let runPath = ""; // /projects/{id}/runs/{runId}
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

  test("step 1 — admin clones the Plan with approval sample", async () => {
    await test.step("Library → New pipeline → Start from: Plan with approval", async () => {
      await gotoApp(admin, "/library");
      await expect(admin.getByTestId("library-page")).toBeVisible();
      await admin.getByTestId("library-new-slug-input").fill(SLUG);
      await admin.getByTestId("library-new-name-input").fill(SLUG);
      await selectByOptionText(admin, "library-new-template-select", "Plan with approval");
      await admin.getByTestId("library-new-submit").click();
      // A template is not a revision: the click path lands on the draft it
      // seeded, at /library/:id?draft=:draftId.
      await admin.waitForURL(/\/library\/[0-9a-f-]{36}\?draft=[0-9a-f-]{36}$/);
      pipelinePath = new URL(admin.url()).pathname;
      await expect(admin.getByTestId("draft-editor-input")).toHaveValue(new RegExp(SLUG));
      // The sample as shipped — the node the journey must later replace.
      await expect(admin.getByTestId("draft-editor-input")).toHaveValue(/kind: model\.chat/);
      await shot(admin, "m5-01-template-draft");
    });
  });

  test("step 2 — customize the draft, validate it, publish r1", async () => {
    await test.step("make it the process.exec twin (no model endpoint on this lab)", async () => {
      await admin
        .getByTestId("draft-editor-input")
        .fill(DETERMINISTIC_TWIN.replace("__SLUG__", SLUG));
      // The sample's model node is gone as a *node*: nothing here needs
      // credentials (the header comment still names the kind it replaced).
      await expect(admin.getByTestId("draft-editor-input")).not.toHaveValue(/kind: model\.chat/);
      await expect(admin.getByTestId("draft-editor-input")).toHaveValue(/kind: process\.exec/);
      await expect(admin.getByTestId("draft-editor-input")).toHaveValue(/kind: human\.approval/);
    });
    await test.step("the step form changes one field: the survey node's timeout", async () => {
      await admin.getByTestId("draft-editor-node-0").click();
      const timeout = admin.getByTestId("draft-editor-field-timeoutSeconds");
      await expect(timeout).toHaveValue("300");
      await timeout.fill("420");
      await expect(admin.getByTestId("draft-editor-input")).toHaveValue(/timeoutSeconds: 420/);
      await expect(admin.getByTestId("draft-editor-dirty")).toHaveText("unsaved changes");
    });
    await test.step("Save → Validate → the server says valid", async () => {
      await admin.getByTestId("draft-editor-save").click();
      await expect(admin.getByTestId("draft-editor-dirty")).toHaveCount(0, { timeout: 30_000 });
      await admin.getByTestId("draft-editor-validate").click();
      // Publish is gated on the stored verdict, so the verdict is the gate.
      await expect(admin.getByTestId("draft-editor-verdict")).toHaveText("valid", {
        timeout: 30_000,
      });
      await expect(admin.getByTestId("draft-editor-publish")).toBeEnabled();
    });
    await test.step("Publish → r1 is immutable and listed", async () => {
      await admin.getByTestId("draft-editor-publish").click();
      await expect(admin.getByTestId("draft-editor-published")).toContainText("published r1", {
        timeout: 30_000,
      });
      await gotoApp(admin, pipelinePath);
      await expect(admin.getByTestId("revision-row-1")).toContainText("r1");
      await shot(admin, "m5-02-published-r1");
    });
  });

  test("step 3 — assign r1 to a project alice maintains", async () => {
    await test.step("the library's Assign to a project panel", async () => {
      await gotoApp(admin, pipelinePath);
      const assign = admin.getByTestId("assign-open");
      if (await assign.isVisible().catch(() => false)) {
        // The happy path: the viewer maintains a project, so the library can
        // pin the revision and hand straight over to a run.
        await assign.click();
        await selectByOptionText(admin, "assign-project-select", ALICE.projectName);
        await admin.getByTestId("assign-confirm").click();
        await expect(admin.getByTestId("assign-success-panel")).toContainText("Assigned to", {
          timeout: 30_000,
        });
        const runsHref = await admin.getByTestId("assign-start-run-link").getAttribute("href");
        projectPath = (runsHref ?? "").replace(/\/runs$/, "");
        await admin.getByTestId("assign-start-run-link").click();
        await admin.waitForURL(/\/projects\/[0-9a-f-]{36}\/runs$/);
        await shot(admin, "m5-03-assigned");
      } else {
        // The lab's arm: `admin` is the org admin with no project membership,
        // so the panel says so honestly and the maintainer does the pinning —
        // `01`: assignment.create is Maintainer+.
        await expect(admin.getByTestId("assign-no-maintainer")).toBeVisible();
        projectPath = await openProjectBySlug(alice, ALICE.projectSlug);
        await gotoApp(alice, `${projectPath}/pipelines`);
        await expect(alice.getByTestId("project-pipelines")).toBeVisible();
        await alice.getByTestId(`assign-open-${SLUG}`).click();
        await expect(alice.getByTestId(`assign-pinning-${SLUG}`)).toContainText("r1", {
          timeout: 30_000,
        });
        await alice.getByTestId(`assign-confirm-${SLUG}`).click();
        // Assigned: the row leaves the assignable list and the project names
        // the revision its runs are pinned to.
        await expect(alice.getByTestId(`assign-form-${SLUG}`)).toHaveCount(0, {
          timeout: 30_000,
        });
        await expect(alice.getByTestId("project-pipeline-pin")).toContainText(
          "pinned revision r1",
          {
            timeout: 30_000,
          },
        );
        await gotoApp(alice, `${projectPath}/runs`);
        await shot(alice, "m5-03-assigned");
      }
    });
  });

  test("step 4 — start a run of the pinned revision", async () => {
    await test.step("the New run form offers exactly the revision's spec.inputs", async () => {
      // Whichever identity pinned the assignment, the run belongs to the
      // project's maintainer — alice is the one the seed put there.
      await gotoApp(alice, `${projectPath}/runs`);
      await expect(alice.getByTestId("project-runs")).toBeVisible();
      await alice.getByTestId("runs-new").click();
      await expect(alice.getByTestId("new-run-form")).toBeVisible();
      await selectByOptionText(alice, "new-run-assignment", SLUG);
      await alice.getByTestId("new-run-input-goal").fill(GOAL);
      // `repository` is a project binding name, offered as the project's own
      // list — not a URL a user has to remember.
      await selectByOptionText(alice, "new-run-input-repository", REPO_BINDING);
      await alice.getByTestId("new-run-submit").click();
      await alice.waitForURL(/\/projects\/[0-9a-f-]{36}\/runs\/[0-9a-f-]{36}$/);
      runPath = new URL(alice.url()).pathname;
      runId = runPath.split("/").pop() ?? "";
      expect(runId).toMatch(/^[0-9a-f-]{36}$/);
      await shot(alice, "m5-04-run-started");
    });
  });

  test("step 5 — the run stalls at its approval gate, and both screens say so", async () => {
    await test.step("the run reaches waiting_human on its own", async () => {
      // Two process.exec nodes first (a clone and a printed plan), then the
      // gate: the wait is for the worker, not for a model.
      await expectRunStatus(alice, /waiting human/, RUN_TIMEOUT_MS);
    });
    await test.step("the Inbox shows it under NEEDS YOUR DECISION", async () => {
      await gotoApp(alice, "/inbox");
      await expect(alice.getByTestId("inbox-decisions")).toBeVisible({ timeout: 60_000 });
      const row = alice
        .getByTestId("inbox-decisions")
        .locator('[data-testid^="inbox-decision-"]')
        .filter({ hasText: `run ${shortRefOf(runId)}` });
      await expect(row).toHaveCount(1);
      await expect(row).toContainText("approve");
      await shot(alice, "m5-05-inbox-needs-your-decision");
    });
    await test.step("the gate card carries a plan a person can read", async () => {
      await gotoApp(alice, runPath);
      await alice.getByTestId("run-stage-cell-approve").click();
      await expect(alice.getByTestId("approval-state")).toHaveText("needs your decision", {
        timeout: 30_000,
      });
      // The key is the compiled one: the root scope renders as `/approve`.
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
      await alice
        .getByTestId("approval-comment")
        .fill("Plan accepted — the run may proceed to its own check.");
      await alice.getByTestId("approval-approve").click();
      await expect(alice.getByTestId("approval-decided")).toBeVisible({
        timeout: DECISION_TIMEOUT_MS,
      });
      await shot(alice, "m5-06-decided");
    });
    await test.step("the run's own check fails it, and the Inbox calls that stalled", async () => {
      // `verify` exits 1 on purpose (the plan describes a test suite the
      // fixture repository does not have) and declares `exit_code: 0` as the
      // only envelope that node accepts, so the boundary turns that business
      // verdict into an `invalid_output` execution failure. The failure is a
      // fact of the definition rather than a flake waiting to be retried: a
      // bare exit 1 lands in the 1..125 business band and COMPLETES the run.
      await expectRunStatus(alice, /failed/, RUN_TIMEOUT_MS);
      await gotoApp(alice, "/inbox");
      const id = testidOf(runId);
      await expect(alice.getByTestId(`inbox-stalled-${id}`)).toBeVisible({
        timeout: DECISION_TIMEOUT_MS,
      });
      await expect(alice.getByTestId(`inbox-stalled-status-${id}`)).toContainText("failed");
      await shot(alice, "m5-06-stalled-inbox");
    });
    await test.step("the retry is accepted: a run.retried frame and a second attempt", async () => {
      const id = testidOf(runId);
      await alice.getByTestId(`inbox-retry-${id}`).click();
      // The retry is refused loudly if it fails — a silent no-op is not allowed
      // to pass as a retry.
      await expect(alice.getByTestId(`inbox-retry-error-${id}`)).toHaveCount(0, {
        timeout: DECISION_TIMEOUT_MS,
      });
      await gotoApp(alice, runPath);
      await alice.getByTestId("run-tab-timeline").click();
      await expect(alice.getByTestId("run-timeline")).toContainText("run.retried", {
        timeout: DECISION_TIMEOUT_MS,
      });
      // The retried node grew a real second attempt — maxAttempts is 1, so no
      // automatic retry could have produced it.
      await alice.getByTestId("run-stage-cell-verify").click();
      await expect(alice.getByTestId("node-pane-crumb")).toContainText("verify", {
        timeout: DECISION_TIMEOUT_MS,
      });
      await expect(alice.getByTestId("node-pane-crumb")).toContainText("attempt 2", {
        timeout: DECISION_TIMEOUT_MS,
      });
      await shot(alice, "m5-06-retried");
    });
    await test.step("the run page offers the same way back, and it is armed", async () => {
      // `/verify` is `failed`, so route 31 has a target and the button is live
      // (no reason line). The rejected-gate case is the opposite arm: nothing
      // failed, so the page says why Retry is disabled instead of 409ing.
      await gotoApp(alice, runPath);
      await expect(alice.getByTestId("run-retry")).toBeVisible();
      await expect(alice.getByTestId("run-retry")).toBeEnabled();
      await expect(alice.getByTestId("run-retry")).toHaveAttribute("title", /\/verify/);
      await expect(alice.getByTestId("run-retry-reason")).toHaveCount(0);
      await shot(alice, "m5-06-run-page-retry");
    });
  });

  test("step 7 — view the evidence: the run's journal and the attempt's own record", async () => {
    await test.step("the Timeline tab renders journal rows", async () => {
      await gotoApp(alice, runPath);
      await alice.getByTestId("run-tab-timeline").click();
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
      await alice.getByTestId("run-stage-cell-survey").click();
      await expect(alice.getByTestId("attempt-process-facts")).toBeVisible({ timeout: 30_000 });
      await expect(alice.getByTestId("attempt-exit-code")).toHaveText("0");
      await expect(alice.getByTestId("attempt-stdout")).toContainText("== files ==");
      await expect(alice.getByTestId("attempt-events")).toBeVisible();
      await shot(alice, "m5-07-attempt-evidence");
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

  test("a retried run whose retriable node is a gate comes back", async () => {
    // The gate arm of the retry question, kept separate from step 6 on purpose:
    // only a gate that FAILED (the `approval_expired` timeout, § 5.4 pass 2) is
    // a retry target at all; a gate that answered `rejected` is `succeeded` and
    // route 31 has nothing to re-arm (see step 6's contract note).
    //
    // FINDING, observed while building this journey: retrying a run whose only
    // retriable node execution is a `human.approval` gate answers 500 —
    //   postgres: insert approval … (pending): duplicate key value violates
    //   unique constraint "approval_requests_node_execution_id_key"
    // (api-a request_id 4128cffa494a6f9f8ced9cc23f86e538, 2026-10-16): the
    // reopened gate wants a fresh approval row and the table allows one per
    // node execution, so an unanswered-then-expired gate is a dead end — the
    // run stays `failed` and the Inbox shows `inbox-retry-error-*`. The journey
    // therefore retries a run that failed on a worker node, which does work.
    test.fixme(
      true,
      "product bug: POST /runs/{id}/retry of a run whose retriable node is a human.approval gate 500s on approval_requests_node_execution_id_key (unique per node execution)",
    );
    await gotoApp(alice, "/inbox");
    await expect(alice.getByTestId(`inbox-retry-error-${testidOf(runId)}`)).toHaveCount(0);
  });

  /**
   * The rejection arm, answered against the contract rather than the card:
   * rejecting a gate is a business outcome (M4 contract § 5.3 / C9e), the run
   * terminates per the graph's `when`, and Retry does NOT re-open the gate — it
   * answers `409 run_not_retriable` unless some other node genuinely failed. In
   * THIS twin `publish_plan`/`verify` carry no `when` guard, so a rejection
   * still runs `verify`, whose `exit_code: 1` envelope its own outputs schema
   * refuses: the failed run is then legitimately retriable *at `/verify`*,
   * never at `/approve`, and retrying it lands back at
   * `failed` because the node is deterministic. "Back to waiting_human with the
   * gate live again" is not what the spec asks for.
   */
  test("a rejected gate fails the run, as its own card promises", async () => {
    // FINDING: `ApprovalCard` says “rejecting fails this run · version N” and
    // links the claim to `01` invariant 10, but `closeGate`
    // (internal/pipelines/runtime/advancer.go) succeeds the node with outcome
    // `rejected` (docs/m4-contract.md § 5.3: “a rejection is a BUSINESS
    // outcome, not an execution failure”) — observed in this lab: the gate node
    // `succeeded` with outcome `rejected` and `publish_plan` published anyway.
    // (The `run completed after a rejection` half of that evidence belongs to
    // the pre-schema twin, where `verify`'s bare exit 1 was a business verdict;
    // with `verify` now declaring `exit_code: 0`, this run ends `failed` at
    // `/verify` for its own reason, so the card's claim must be judged by the
    // gate row, not by the run status.)
    // One of the two sentences is wrong; the journey keeps the check so the
    // contradiction cannot be forgotten.
    test.fixme(
      true,
      "product contradiction: the gate card promises that rejecting fails the run; the engine records a business outcome and the run completes (M4 contract § 5.3 vs ApprovalCard.tsx)",
    );
    await gotoApp(alice, runPath);
    await expectRunStatus(alice, /failed/, DECISION_TIMEOUT_MS);
  });

  test("the run page itself offers a Retry control, and explains when it cannot", async () => {
    // The gap is closed: `RunActions` (ui/src/pages/RunInspector.tsx) now reads
    // route 31's own target set off `/runs/{id}/nodes` and either arms the
    // button or disables it with the reason (`run-retry-reason`) — a rejected
    // gate is a business outcome, so nothing failed and there is nothing to
    // retry. Proven per-arm in `ui/src/pages/RunInspector.test.tsx`; this is the
    // live arm for a run with a genuinely failed node.
    await gotoApp(alice, runPath);
    await expect(alice.getByTestId("run-retry")).toBeVisible();
    await expect(alice.getByTestId("run-retry")).toBeEnabled();
  });
});
