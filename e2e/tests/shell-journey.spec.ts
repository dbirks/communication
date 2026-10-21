// THE app-shell + IA redesign acceptance journey: one continuous pass through
// the shipped UI with real agents and no top bar —
//   a. Studio: insert a NEW agent step after plan, created with a brand-new
//      profile through the New-profile dialog (contract C6);
//   b. Validate + Publish, and the published revision number increments;
//   c. start a run of the new revision from the project's new-run form;
//   d. approve the run's human gate from the Inbox at PHONE width (390x844);
//   e. the Run Workbench: a live agent step, Take control (confirm card with
//      its truthful copy, ADR-0043), one prompt, hand back — a new attempt of
//      the step is queued (ADR-0043/ADR-0055 semantics, asserted via API);
//   f. the assistant via ⌘K: add a human approval step to a draft of
//      feature-development, then undo all.
//
// Runs ONLY against the app-shell lab when COMMUNICATION_E2E_SHELL_JOURNEY=1:
//   cd e2e && COMMUNICATION_E2E_SHELL_JOURNEY=1 E2E_BASE_URL=http://localhost:15173 \
//     E2E_EVIDENCE_DIR=$HOME/.cache/pi-orch/communication/logs/e2e-journey/ev \
//     E2E_SHELL_STAMP=j$RANDOM pnpm exec playwright test tests/shell-journey.spec.ts \
//     --reporter=line --workers=1
// Serial tests share one page and a module-level state object (the
// issue2-workbench idiom). Every step calls evidence() (screenshot + one
// `EVIDENCE <name>: <what it proves>` line) and checkShellScreen() (axe via
// tests/a11y.ts, no sideways scroll, no uncaught page errors).
//
// If a step fails only because another worker's piece is not wired yet
// (assistant popover p7-wire, inbox cards p8-wire, assistant tool loop
// be-as-loop), the failing message names that piece — the assertions stay
// honest and are never weakened.
import { test, expect, type Locator, type Page, type APIRequestContext } from "@playwright/test";
import { BASE_URL, AGENT_TURN_TIMEOUT_MS } from "./env.js";
import { expectNoLegacyAppBar, gotoApp, repinAssignment, signIn, testidOf } from "./helpers.js";
import {
  apiPipelines,
  apiProjects,
  checkShellScreen,
  evidence,
  watchPageErrors,
  type PipelineRow,
} from "./shell-helpers.js";

/** The shared gate for this journey only. */
const JOURNEY_ENABLED = process.env.COMMUNICATION_E2E_SHELL_JOURNEY === "1";
const JOURNEY_GATE =
  "requires the app-shell journey lab (COMMUNICATION_E2E_SHELL_JOURNEY=1, E2E_BASE_URL=http://localhost:15173)";

/** E2E_SHELL_STAMP is the runner's per-run tag (j$RANDOM); time is the fallback. */
const STAMP = process.env.E2E_SHELL_STAMP ?? Date.now().toString(36);
/** The seeded pipeline the journey mutates: plan → approve → implement… */
const PIPELINE_SLUG = "feature-development";
const PROFILE_NAME = `journey-${STAMP}`;
/** The draft instruction for the new Agent step (short, harmless). */
const STEP_INSTRUCTION =
  "List the files in the repository root and report their names. Do not modify anything.";
/** The node id the new step is renamed to (renamed LAST — the rename commit
 * drops the node selection, so no other field may follow it). */
const NEW_NODE_ID = "journey_step";
/** The assistant's change target (step f), asserted through the draft YAML. */
const ASSISTANT_STEP_NAME = "journey_check";
const ASSISTANT_ASK = `Add a human approval step named ${ASSISTANT_STEP_NAME} after plan in feature-development's draft`;
/** One node step is worker polls plus sleep inputs, not milliseconds. */
const NODE_STEP_TIMEOUT_MS = Number(process.env.E2E_NODE_STEP_TIMEOUT_MS ?? 420_000);
/** Two real agent turns (plan, then the new journey step) precede the gate. */
const GATE_TIMEOUT_MS = 2 * NODE_STEP_TIMEOUT_MS;

/** Shared across the serial steps of this one-page journey. */
interface JourneyState {
  pipeline: PipelineRow;
  revisionBefore: number;
  revisionDigest: string;
  draftId: string;
  draftUrl: string;
  projectId: string;
  runId: string;
  approvalId: string;
  agentNodeId: string;
}
const state: JourneyState = {
  pipeline: undefined as unknown as PipelineRow,
  revisionBefore: 0,
  revisionDigest: "",
  draftId: "",
  draftUrl: "",
  projectId: "",
  runId: "",
  approvalId: "",
  agentNodeId: "",
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Find the seeded pipeline row by slug; it must already be published once. */
async function seededPipeline(request: APIRequestContext): Promise<PipelineRow> {
  const rows = await apiPipelines(request);
  const row = rows.find((p) => p.slug === PIPELINE_SLUG);
  if (!row) throw new Error(`the seeded pipeline ${PIPELINE_SLUG} is not in GET /pipelines`);
  if (!row.latest_revision_number)
    throw new Error(`pipeline ${PIPELINE_SLUG} has no published revision yet`);
  state.pipeline = row;
  state.revisionBefore = row.latest_revision_number;
  return row;
}

/** GET /pipelines/{id}/revisions, newest first; the head carries the digest. */
async function newestRevisionDigest(
  request: APIRequestContext,
  pipelineId: string,
): Promise<string> {
  const res = await request.get(`${BASE_URL}/api/v1/pipelines/${pipelineId}/revisions`);
  if (!res.ok()) throw new Error(`GET /pipelines revisions -> ${res.status()}`);
  const body = (await res.json()) as { revisions?: { revision_digest: string }[] };
  const head = (body.revisions ?? [])[0];
  if (!head?.revision_digest) throw new Error(`no revision with a digest for ${pipelineId}`);
  return head.revision_digest;
}

/** The first project holding an assignment for the pipeline (run start needs one). */
async function projectWithAssignment(
  request: APIRequestContext,
  pipelineId: string,
): Promise<string> {
  const projects = await apiProjects(request);
  for (const project of projects) {
    const res = await request.get(`${BASE_URL}/api/v1/projects/${project.id}/assignments`);
    if (!res.ok()) throw new Error(`GET /projects/${project.id}/assignments -> ${res.status()}`);
    const body = (await res.json()) as { assignments?: { pipeline_id: string }[] };
    if ((body.assignments ?? []).some((a) => a.pipeline_id === pipelineId)) return project.id;
  }
  throw new Error(
    `no project assignment for pipeline ${PIPELINE_SLUG} — the lab seed is missing it`,
  );
}

/** The newest drafts of a pipeline with their document YAML. */
async function recentDrafts(
  request: APIRequestContext,
  pipelineId: string,
): Promise<{ id: string; yaml: string }[]> {
  const res = await request.get(`${BASE_URL}/api/v1/pipelines/${pipelineId}/drafts`);
  if (!res.ok()) throw new Error(`GET /pipelines drafts -> ${res.status()}`);
  const body = (await res.json()) as { drafts?: { id: string; updated_at: string }[] };
  const drafts = [...(body.drafts ?? [])]
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .slice(0, 6);
  const out: { id: string; yaml: string }[] = [];
  for (const draft of drafts) {
    const d = await request.get(`${BASE_URL}/api/v1/drafts/${draft.id}`);
    if (!d.ok()) throw new Error(`GET /drafts/${draft.id} -> ${d.status()}`);
    const row = (await d.json()) as { document_yaml: string };
    out.push({ id: draft.id, yaml: row.document_yaml });
  }
  return out;
}

/** The newest drafts of the pipeline whose YAML contains the marker. */
async function draftsContaining(
  request: APIRequestContext,
  marker: string,
): Promise<{ id: string; yaml: string }[]> {
  return (await recentDrafts(request, state.pipeline.id)).filter((d) => d.yaml.includes(marker));
}

/** Raw YAML of a revision's document (the Studio's own fetch). */
async function revisionDocument(page: Page, digestOrId: string): Promise<string> {
  const res = await page.request.get(`/api/v1/revisions/${digestOrId}/document?format=yaml`);
  expect(res.status()).toBe(200);
  return res.text();
}

interface NodeRow {
  id: string;
  node_id: string;
  kind: string;
  status: string;
  attempt_count: number;
}

/** GET /runs/{id}/nodes — every node execution of the run. */
async function runNodes(request: APIRequestContext, runId: string): Promise<NodeRow[]> {
  const res = await request.get(`${BASE_URL}/api/v1/runs/${runId}/nodes`);
  if (!res.ok()) throw new Error(`GET /runs/${runId}/nodes -> ${res.status()}`);
  const body = (await res.json()) as { nodes?: NodeRow[] };
  return body.nodes ?? [];
}

/** Project-scoped gate list — the lab's core surface (the C3 cross-project
 * list is built in parallel; this one exists since M4). */
interface ApprovalRow {
  id: string;
  run_id: string;
  state: string;
  decision?: string | null;
}
async function pendingProjectApprovals(request: APIRequestContext): Promise<ApprovalRow[]> {
  const res = await request.get(`${BASE_URL}/api/v1/projects/${state.projectId}/approvals`);
  if (!res.ok()) throw new Error(`GET /projects/${state.projectId}/approvals -> ${res.status()}`);
  const body = (await res.json()) as { approvals?: ApprovalRow[] };
  return (body.approvals ?? []).filter((a) => a.state === "pending");
}

/** The run's status as the project's own run list reports it. */
async function projectRunStatus(
  request: APIRequestContext,
  runId: string,
): Promise<string | undefined> {
  const res = await request.get(`${BASE_URL}/api/v1/projects/${state.projectId}/runs`);
  if (!res.ok()) throw new Error(`GET /projects/${state.projectId}/runs -> ${res.status()}`);
  const body = (await res.json()) as { runs?: { id: string; status: string }[] };
  return (body.runs ?? []).find((r) => r.id === runId)?.status;
}

/** Poll until a pending approval exists for the run (plan + journey step first). */
async function waitForApproval(request: APIRequestContext, runId: string): Promise<string> {
  const deadline = Date.now() + GATE_TIMEOUT_MS;
  for (;;) {
    const approvals = await pendingProjectApprovals(request);
    const row = approvals.find((a) => a.run_id === runId);
    if (row) return row.id;
    if (Date.now() > deadline) {
      const nodes = await runNodes(request, runId);
      throw new Error(
        `no pending approval for run ${runId} after the gate window (nodes: ${
          nodes.map((n) => `${n.node_id}:${n.status}`).join(" ") || "none"
        })`,
      );
    }
    await sleep(3_000);
  }
}

/**
 * Poll until the gate is decided approved, then until the run moves on:
 * the approve step is succeeded (the C3 cross-project `steps` field, when
 * this API build carries it) or — the core truth — the run's own status left
 * `waiting_human` and did not fail.
 */
async function waitForApprovalDecided(request: APIRequestContext, runId: string): Promise<void> {
  const deadline = Date.now() + NODE_STEP_TIMEOUT_MS;
  for (;;) {
    const res = await request.get(`${BASE_URL}/api/v1/approvals/${state.approvalId}`);
    if (res.ok()) {
      const row = (await res.json()) as ApprovalRow;
      if (row.state === "decided") {
        if (row.decision && row.decision !== "approved")
          throw new Error(`the gate was decided ${row.decision}, not approved`);
        break;
      }
    }
    if (Date.now() > deadline)
      throw new Error(`approval …${state.approvalId.slice(-8)} never reached decided`);
    await sleep(3_000);
  }
  const movesOnDeadline = Date.now() + 120_000;
  for (;;) {
    const runs = await crossRunRow(request, runId).catch(() => undefined);
    if (runs?.steps?.some((s) => s.node_id === "approve" && s.state === "succeeded")) return;
    const status = await projectRunStatus(request, runId);
    if (status !== undefined && status !== "waiting_human") {
      if (status === "failed" || status === "cancelled")
        throw new Error(`the run went ${status} instead of moving on past the gate`);
      return;
    }
    if (Date.now() > movesOnDeadline)
      throw new Error(
        `the run never left waiting_human (status: ${status ?? "unreadable"}) — is the cross-project run list (C3) wired in this lab?`,
      );
    await sleep(3_000);
  }
}

/** The cross-project run row (C3) — used only for its top-level `steps`. */
async function crossRunRow(
  request: APIRequestContext,
  runId: string,
): Promise<{ steps?: { node_id: string; state: string }[] } | undefined> {
  const res = await request.get(`${BASE_URL}/api/v1/runs?limit=100`);
  if (!res.ok()) throw new Error(`GET /runs -> ${res.status()}`);
  const body = (await res.json()) as {
    runs?: { id: string; steps?: { node_id: string; state: string }[] }[];
  };
  return (body.runs ?? []).find((r) => r.id === runId);
}

/** Poll until an agent.acp node execution of the run is running. */
async function waitForAgentRunning(request: APIRequestContext, runId: string): Promise<NodeRow> {
  const deadline = Date.now() + NODE_STEP_TIMEOUT_MS;
  for (;;) {
    const nodes = await runNodes(request, runId);
    const running = nodes.find((n) => n.kind === "agent.acp" && n.status === "running");
    if (running) return running;
    if (Date.now() > deadline) {
      throw new Error(
        `no agent.acp step went running in run ${runId} within the window (nodes: ${
          nodes.map((n) => `${n.node_id}:${n.status}`).join(" ") || "none"
        })`,
      );
    }
    await sleep(3_000);
  }
}

test.describe.serial("shell journey — the app-shell acceptance journey end to end", () => {
  test.skip(!JOURNEY_ENABLED, JOURNEY_GATE);
  test.use({ viewport: { width: 1500, height: 950 } });
  test.setTimeout(30 * 60_000);

  let stopWatching: (() => void) | null = null;

  test.afterAll(async () => {
    stopWatching?.();
  });

  /** The Inbox card's Approve action button — matched by its label, never guessed. */
  async function findApproveAction(page: Page, tid: string): Promise<Locator> {
    const buttons = page.locator(`[data-testid^="inbox-card-action-${tid}-"]`);
    await expect(buttons.first()).toBeVisible({ timeout: 30_000 });
    const count = await buttons.count();
    for (let i = 0; i < count; i += 1) {
      if (/approve/i.test((await buttons.nth(i).textContent()) ?? "")) return buttons.nth(i);
    }
    const labels = await Promise.all(
      Array.from({ length: count }, (_, i) => buttons.nth(i).textContent()),
    );
    throw new Error(
      `the Inbox decision card ${tid} has no Approve action (buttons: ${labels
        .map((label) => JSON.stringify(label ?? ""))
        .join(" | ")}) — are the inbox cards wired (p8-wire)?`,
    );
  }

  test("a — Studio: add an Agent step after plan with a brand-new profile", async ({ page }) => {
    // Step 0 (the serial journey shares one page; the first test owns setup):
    // sign in, and the shell is a sidebar app — no top bar anywhere.
    await signIn(page, "admin");
    stopWatching = watchPageErrors(page);
    await gotoApp(page, "/");
    await expect(page.getByTestId("sidebar")).toBeVisible();
    await expectNoLegacyAppBar(page);
    await evidence(
      page,
      `journey-0-shell-${STAMP}`,
      "signed in; the sidebar exists and no header[aria-label=Primary] top bar is present",
    );

    await seededPipeline(page.request);
    console.log(`journey a: pipeline ${PIPELINE_SLUG} at revision ${state.revisionBefore}`);

    // Re-run safety: a previous run of this journey published a revision that
    // carries journey_step, so restore the seeded twin first (the oldest
    // revision's document plus ONE stamped metadata line for a fresh digest)
    // through the Studio's own YAML view — the node graph stays pristine and
    // the new digest makes the restoration publishable.
    const revRes = await page.request.get(`/api/v1/pipelines/${state.pipeline.id}/revisions`);
    expect(revRes.status()).toBe(200);
    const revBody = (await revRes.json()) as { revisions?: { revision_digest: string }[] };
    const revisions = revBody.revisions ?? [];
    const newestDoc = await revisionDocument(page, revisions[0]?.revision_digest ?? "");
    if (newestDoc.includes(`id: ${NEW_NODE_ID}`)) {
      const seedDoc = await revisionDocument(
        page,
        revisions[revisions.length - 1]?.revision_digest ?? "",
      );
      const restored = seedDoc.replace(
        /^([ \t]*description: .*)$/m,
        (line) => `${line} (re-stored ${STAMP})`,
      );
      expect(restored, "the stamp must land on the description line").not.toBe(seedDoc);
      await page.goto(BASE_URL + `/workflows/${state.pipeline.id}`);
      await expect(page.getByTestId("pipeline-page")).toBeVisible();
      await page.getByTestId("pipeline-new-draft").click();
      await expect(page).toHaveURL(new RegExp(`/workflows/${state.pipeline.id}/drafts/`));
      await expect(page.getByTestId("studio-canvas")).toBeVisible({ timeout: 30_000 });
      await page.getByTestId("studio-view-yaml").click();
      await page.getByTestId("studio-yaml").fill(restored);
      await page.getByTestId("studio-save").click();
      await expect(page.getByTestId("studio-dirty")).toHaveCount(0, { timeout: 30_000 });
      await page.getByTestId("studio-validate").click();
      const verdict = page.getByTestId("studio-validate-verdict");
      await expect(verdict).toBeVisible({ timeout: 60_000 });
      expect((await verdict.textContent()) ?? "").toMatch(/^valid/i);
      await page.getByTestId("studio-publish").click();
      await expect(page.getByTestId("studio-published")).toBeVisible({ timeout: 60_000 });
      await evidence(
        page,
        `journey-a-rerun-restored-${STAMP}`,
        `a previous journey run had published a revision carrying ${NEW_NODE_ID} — the seeded twin (oldest revision's document, description stamped “re-stored ${STAMP}” for a fresh digest) was restored through the Studio and republished`,
      );
      // The latest revision moved; re-read the baseline for step b's increment check.
      await seededPipeline(page.request);
    }

    await gotoApp(page, "/workflows");
    console.log("journey a: /workflows answered");
    await expect(page.getByTestId("workflows-list")).toBeVisible({ timeout: 30_000 });
    await gotoApp(page, `/workflows/${state.pipeline.id}`);
    console.log("journey a: pipeline page answered");
    await expect(page.getByTestId("pipeline-page")).toBeVisible();
    await expect(page.getByTestId("pipeline-header-meta")).toContainText(PIPELINE_SLUG);

    // New draft: the pipeline page's clone control (built from the newest revision).
    await page.getByTestId("pipeline-new-draft").click();
    await expect(page).toHaveURL(new RegExp(`/workflows/${state.pipeline.id}/drafts/`));
    state.draftId = new URL(page.url()).pathname.split("/").pop() as string;
    state.draftUrl = page.url();
    console.log(`journey a: new draft ${state.draftId}`);
    await expect(page.getByTestId("studio-canvas")).toBeVisible({ timeout: 30_000 });
    console.log("journey a: studio canvas shown — a11y pass");
    await checkShellScreen(page, "studio", stopWatching ?? undefined);
    console.log("journey a: studio a11y pass done");

    // The `+` on the plan → approve edge (revealed on hover) starts a new step.
    const edgeAdd = page.getByTestId("edge-add-plan-approve");
    await edgeAdd.hover();
    await edgeAdd.click();
    console.log("journey a: edge + clicked");
    await expect(page.getByTestId("step-picker")).toBeVisible();
    await page.getByTestId("step-picker-item-agent.acp").click();

    // §4 ambiguity rule (issue #2 A3): the approve step is guarded (it reads
    // nodes.plan.*), so the insert op refuses to rewire silently — the dialog
    // names the reasons verbatim. Assert them, then accept.
    const ambiguity = page.getByTestId("studio-ambiguity-dialog");
    await expect(ambiguity)
      .toBeVisible({ timeout: 5_000 })
      .catch(() => undefined);
    if (await ambiguity.isVisible()) {
      await expect(page.getByTestId("studio-ambiguity-title")).toHaveText(
        /insert a step between plan and approve/i,
      );
      const reasons = page.locator('[data-testid^="studio-ambiguity-reason-"]');
      const reasonCount = await reasons.count();
      expect(reasonCount, "the guarded-edge dialog names at least one reason").toBeGreaterThan(0);
      const reasonText = (
        await Promise.all(
          Array.from({ length: reasonCount }, (_, i) => reasons.nth(i).textContent()),
        )
      ).join(" | ");
      await checkShellScreen(page, "ambiguity-dialog", stopWatching ?? undefined);
      await evidence(
        page,
        `journey-a-ambiguity-${STAMP}`,
        `guarded-edge dialog before the insert: “${reasonText}” — the insert is accepted with the target's guard kept (issue #2 A3)`,
      );
      await page.getByTestId("studio-ambiguity-insert").click();
      await expect(ambiguity).toBeHidden();
    }

    // The new node is selected: the inspector names it.
    await expect(page.getByTestId("insp-node-id")).toBeVisible();
    console.log("journey a: agent step inserted, inspector open");

    // Profile select → “+ New profile…”: the New-profile dialog (contract C6).
    await page.getByTestId("insp-profile").selectOption({ label: "+ New profile…" });
    const dialog = page.getByTestId("new-profile-dialog");
    await expect(dialog).toBeVisible();
    console.log("journey a: new-profile dialog open — a11y pass");
    await checkShellScreen(page, "new-profile-dialog", stopWatching ?? undefined);
    console.log("journey a: dialog a11y pass done");
    await page.getByTestId("new-profile-card-claude").click();
    await page.getByTestId("agents-new-name-input").fill(PROFILE_NAME);
    await expect(page.getByTestId("agents-new-submit")).toContainText("Create and use in");
    await evidence(
      page,
      `journey-a-dialog-${STAMP}`,
      `New-profile dialog open: the Claude Code card, name ${PROFILE_NAME}, and the footer reads “Create and use in <step>” (contract C6)`,
    );
    await page.getByTestId("agents-new-submit").click();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId("insp-profile")).toHaveValue(PROFILE_NAME);
    console.log(`journey a: profile ${PROFILE_NAME} created and selected`);

    // “What should it do?” — a short, harmless instruction.
    await page.getByTestId("insp-config-prompt").fill(STEP_INSTRUCTION);
    await page.getByTestId("insp-config-prompt").blur();

    // The id rename LAST: the rename commit drops the node selection.
    const nodeIdField = page.getByTestId("insp-node-id");
    await nodeIdField.fill(NEW_NODE_ID);
    await nodeIdField.press("Enter");

    // Save so the insertion persists (the Studio keeps edits in memory until saved).
    await page.getByTestId("studio-save").click();
    await expect(page.getByTestId("studio-dirty")).toHaveCount(0, { timeout: 30_000 });
    await evidence(
      page,
      `journey-a-step-${STAMP}`,
      `agent.acp step ${NEW_NODE_ID} inserted after plan, profile ${PROFILE_NAME} created through the dialog and now selected, instruction set, draft saved`,
    );
  });

  test("b — publish: Validate then Publish, and the revision number increments", async ({
    page,
  }) => {
    await gotoApp(page, state.draftUrl);
    await expect(page.getByTestId("studio-canvas")).toBeVisible({ timeout: 30_000 });

    await page.getByTestId("studio-validate").click();
    const verdict = page.getByTestId("studio-validate-verdict");
    await expect(verdict).toBeVisible({ timeout: 60_000 });
    const verdictText = ((await verdict.textContent()) ?? "").trim();
    expect(verdictText, "the draft must validate before publishing").toMatch(/^valid/i);

    await page.getByTestId("studio-publish").click();
    const published = page.getByTestId("studio-published");
    await expect(published).toBeVisible({ timeout: 60_000 });

    // The published revision number increments (asserted through the API).
    const rows = await apiPipelines(page.request);
    const row = rows.find((p) => p.id === state.pipeline.id);
    expect(row?.latest_revision_number, "the published revision number must increment").toBe(
      state.revisionBefore + 1,
    );
    expect(row?.revision_count, "the revision count must increment").toBe(
      (state.pipeline.revision_count ?? 0) + 1,
    );
    state.revisionDigest = await newestRevisionDigest(page.request, state.pipeline.id);
    await evidence(
      page,
      `journey-b-published-${STAMP}`,
      `draft validated (“${verdictText}”) and published — revision ${state.revisionBefore} → ${row?.latest_revision_number} (${state.revisionDigest.slice(0, 19)}…), asserted via the API`,
    );
  });

  test("c — start a run of the new revision and land on it", async ({ page }) => {
    // Setup via API: the run must start from the NEW revision, so the project's
    // assignment is repinned to it (re-pinning is effective at new-run creation
    // only; the run itself starts through the UI, per the journey).
    state.projectId = await projectWithAssignment(page.request, state.pipeline.id);
    await repinAssignment(page, state.projectId, state.pipeline.id, state.revisionDigest);

    // The project's new-run form (where the Board's “Start run” lands too).
    await gotoApp(page, `/p/${state.projectId}/runs`);
    await page.getByTestId("runs-new").click();
    await expect(page.getByTestId("new-run-form")).toBeVisible();
    const select = page.getByTestId("new-run-assignment");
    await expect(select).toBeAttached();
    const optionRows = await Promise.all(
      (await select.locator("option").all()).map(
        async (option) =>
          `value=${await option.getAttribute("value")} text=${JSON.stringify(
            (await option.textContent()) ?? "",
          )}`,
      ),
    );
    const target = optionRows.find((row) => row.includes(`text="${PIPELINE_SLUG} · `));
    if (!target)
      throw new Error(
        `the new-run form has no assignment for ${PIPELINE_SLUG} (options: ${optionRows.join(" | ")})`,
      );
    await select.selectOption({ value: target.match(/^value=(.+) text=/)?.[1] ?? "" });

    await page.getByTestId("new-run-input-goal").fill(`shell journey ${STAMP}`);
    const repo = page.getByTestId("new-run-input-repository");
    if ((await repo.count()) > 0) {
      if ((await repo.evaluate((el) => el.tagName)) === "SELECT")
        await repo.selectOption({ index: 0 });
      else {
        const res = await page.request.get(
          `${BASE_URL}/api/v1/projects/${state.projectId}/repositories`,
        );
        if (res.ok()) {
          const body = (await res.json()) as { items?: { name: string }[] };
          const first = (body.items ?? [])[0]?.name;
          if (first) await repo.fill(first);
        }
      }
    }

    await page.getByTestId("new-run-submit").click();
    await page.waitForURL(/\/runs\/[0-9a-fA-F-]+/);
    state.runId = new URL(page.url()).pathname.split("/").pop() as string;
    await expect(page.getByTestId("workbench")).toBeVisible({ timeout: NODE_STEP_TIMEOUT_MS });
    // The run is pinned to the revision just published.
    await expect(page.getByTestId("run-pinned-revision")).toContainText(
      state.revisionDigest.slice(0, 19),
    );
    await evidence(
      page,
      `journey-c-run-${STAMP}`,
      `run ${state.runId} started from the new revision ${state.revisionDigest.slice(0, 19)}… and the workbench opened on it`,
    );
  });

  test("d — approve the run's human gate from the Inbox at 390x844", async ({ page }) => {
    // The run's plan step (a real agent turn) and the new journey step run
    // before the gate, so the approval may take the whole gate window.
    state.approvalId = await waitForApproval(page.request, state.runId);

    // PHONE width: 390x844, as the journey demands.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(BASE_URL + "/inbox");
    await expect(page.getByTestId("inbox-decisions")).toBeVisible({ timeout: 30_000 });
    const tid = testidOf(state.approvalId);
    const card = page.getByTestId(`inbox-decision-${tid}`);
    await expect(card).toBeVisible({ timeout: 30_000 });

    // The card's Approve action, then its confirm step.
    const action = await findApproveAction(page, tid);
    await action.click();
    const confirm = page.getByTestId(`inbox-card-confirm-${tid}`);
    await expect(confirm).toBeVisible();
    await checkShellScreen(page, "inbox-phone-approval", stopWatching ?? undefined);
    await evidence(
      page,
      `journey-d-inbox-${STAMP}`,
      `at 390x844 the Inbox decision card for the run's gate is open with its confirm step armed (approval …${state.approvalId.slice(-8)})`,
    );

    // The label is a decision word → “Confirm approve”; otherwise the card
    // offers the Approve / Reject pair — either records the approval.
    const go = page.getByTestId(`inbox-card-confirm-go-${tid}`);
    if ((await go.count()) > 0) await go.click();
    else await page.getByTestId(`inbox-card-confirm-approved-${tid}`).click();

    // Asserted via the API: the approval is decided and the run moves on.
    await waitForApprovalDecided(page.request, state.runId);
    await expect(card).toBeHidden({ timeout: 60_000 });
    await evidence(
      page,
      `journey-d-decided-${STAMP}`,
      `the gate was approved from the phone-width Inbox; the run's approve step is succeeded via the API and the card left the Inbox`,
    );
    await page.setViewportSize({ width: 1500, height: 950 });
  });

  test("e — workbench: watch a live agent step, take control, prompt, hand back", async ({
    page,
  }) => {
    await gotoApp(page, `/runs/${state.runId}`);
    await expect(page.getByTestId("workbench")).toBeVisible({ timeout: NODE_STEP_TIMEOUT_MS });

    // Watch until an agent step runs — its live status is what the workbench shows.
    const node = await waitForAgentRunning(page.request, state.runId);
    state.agentNodeId = node.node_id;
    const dockControl = page.getByTestId("dock-take-control");
    if (!(await dockControl.isVisible().catch(() => false))) {
      // The dock auto-selects the node needing attention; if it is elsewhere,
      // select the running step from the strip and the dock follows.
      const cell = page
        .locator('[data-testid^="workbench-step-cell-"]')
        .filter({ hasText: node.node_id })
        .first();
      if ((await cell.count()) > 0) await cell.click();
    }
    await expect(dockControl).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("dock-conversation")).toBeVisible();
    await checkShellScreen(page, "workbench", stopWatching ?? undefined);
    await evidence(
      page,
      `journey-e-live-${STAMP}`,
      `the workbench shows agent step ${node.node_id} live (status running via the API) with its conversation in the dock`,
    );

    // Take control: the first click opens the confirm card with its truthful copy.
    await dockControl.click();
    const takeCard = page.getByTestId("take-control-card");
    await expect(takeCard).toBeVisible();
    await expect(page.getByTestId("take-control-card-heading")).toContainText(/take control of/i);
    const copy = (await takeCard.textContent()) ?? "";
    expect(copy, "the card states what a takeover does").toMatch(/stops and the run pauses/);
    expect(copy, "the card states what a hand-back does").toMatch(/new attempt/i);
    await evidence(
      page,
      `journey-e-confirm-${STAMP}`,
      `the take-control confirm card for ${node.node_id} says the attempt stops, the run pauses, and the hand-back re-runs the step as a new attempt (ADR-0043)`,
    );
    await page.getByTestId("take-control-confirm").click();

    // The controller line names you.
    await expect
      .poll(async () => (await page.getByTestId("dock-controller").textContent()) ?? "", {
        timeout: 60_000,
      })
      .toMatch(/you are in control/i);

    // One prompt in the composer; the agent replies.
    const before = await page.getByTestId("transcript-item").count();
    await page.getByTestId("dock-composer-input").fill("Say hello and stop.");
    await page.getByTestId("dock-composer-send").click();
    await expect
      .poll(async () => page.getByTestId("transcript-item").count(), {
        timeout: AGENT_TURN_TIMEOUT_MS,
      })
      .toBeGreaterThan(before);
    await expect
      .poll(async () => (await page.getByTestId("transcript-item").last().textContent()) ?? "", {
        timeout: AGENT_TURN_TIMEOUT_MS,
      })
      .toMatch(/hello/i);
    await evidence(
      page,
      `journey-e-prompt-${STAMP}`,
      `admin is in control of ${node.node_id}: one prompt (“Say hello and stop.”) got a live agent reply in the dock`,
    );

    // Hand back: the accepted takeover semantics — a new attempt of the step is
    // queued (ADR-0043/ADR-0055), asserted through the API.
    await page.getByTestId("dock-return-control").click();
    const deadline = Date.now() + NODE_STEP_TIMEOUT_MS;
    for (;;) {
      const rows = await runNodes(page.request, state.runId);
      const row = rows.find((n) => n.node_id === state.agentNodeId);
      if (row && row.attempt_count >= 2) break;
      if (Date.now() > deadline)
        throw new Error(
          `no new attempt of ${state.agentNodeId} after the hand-back (attempt_count: ${
            row?.attempt_count ?? "absent"
          }) — ADR-0043/ADR-0055 semantics unmet`,
        );
      await sleep(3_000);
    }
    await evidence(
      page,
      `journey-e-handed-back-${STAMP}`,
      `control returned to the factory: a new attempt of ${state.agentNodeId} is queued (attempt_count ≥ 2 via the API) — the accepted takeover semantics (ADR-0043/ADR-0055)`,
    );
    await checkShellScreen(page, "workbench-after-takeover", stopWatching ?? undefined);
  });

  test("f — assistant via ⌘K: add a step to the draft, then undo all", async ({ page }) => {
    await gotoApp(page, `/workflows/${state.pipeline.id}`);
    await expect(page.getByTestId("pipeline-page")).toBeVisible();

    // ⌘K opens the assistant popover (the app's own shortcut; Ctrl-K on a
    // headless browser where Meta is not delivered).
    await page.keyboard.press("Meta+k");
    const popover = page.getByTestId("assistant-popover");
    if (!(await popover.isVisible().catch(() => false))) await page.keyboard.press("Control+k");
    await expect(popover).toBeVisible({ timeout: 10_000 });
    await checkShellScreen(page, "assistant-popover", stopWatching ?? undefined);

    await page.getByTestId("assistant-composer-input").fill(ASSISTANT_ASK);
    await page.getByTestId("assistant-send").click();

    // Follow the assistant: answer questions with a model-written option,
    // confirm any approval card, until the change chip lands.
    const deadline = Date.now() + AGENT_TURN_TIMEOUT_MS;
    for (;;) {
      const error = page.getByTestId("assistant-error");
      if (await error.isVisible().catch(() => false))
        throw new Error(
          `the assistant errored: ${
            (await error.textContent()) ?? "(no text)"
          } — is the assistant tool loop (be-as-loop) / popover wiring (p7-wire) live in this lab?`,
        );
      if (
        await page
          .getByTestId("assistant-question")
          .isVisible()
          .catch(() => false)
      ) {
        await page.getByTestId("assistant-question-option").first().click();
        continue;
      }
      if (
        await page
          .getByTestId("assistant-approval")
          .isVisible()
          .catch(() => false)
      ) {
        await page.getByTestId("assistant-approval-confirm").click();
        continue;
      }
      if (
        await page
          .getByTestId("assistant-change-chip")
          .isVisible()
          .catch(() => false)
      )
        break;
      if (Date.now() > deadline)
        throw new Error(
          `the assistant never produced a change chip for ${ASSISTANT_STEP_NAME} (assistant tool loop be-as-loop?)`,
        );
      await sleep(3_000);
    }
    const chip = page.getByTestId("assistant-change-chip");
    await expect(chip).toBeVisible();
    expect((await chip.textContent()) ?? "", "the change chip counts its changes").toMatch(
      /\d+\s+changes?/,
    );
    await expect(page.getByTestId("assistant-change-row").first()).toBeVisible();

    // The change is real: a draft's YAML now contains journey_check (via API).
    await expect
      .poll(async () => (await draftsContaining(page.request, ASSISTANT_STEP_NAME)).length, {
        timeout: 30_000,
      })
      .toBeGreaterThan(0);
    const withMarker = await draftsContaining(page.request, ASSISTANT_STEP_NAME);
    await evidence(
      page,
      `journey-f-changed-${STAMP}`,
      `the assistant's change chip counts its change(s), and the draft …${withMarker[0].id.slice(-8)}'s YAML now contains ${ASSISTANT_STEP_NAME} (via the API)`,
    );

    // Undo all — the draft no longer contains it (via API).
    await page.getByTestId("assistant-change-undo-all").click();
    await expect
      .poll(async () => (await draftsContaining(page.request, ASSISTANT_STEP_NAME)).length, {
        timeout: 60_000,
      })
      .toBe(0);
    await evidence(
      page,
      `journey-f-undone-${STAMP}`,
      `undo all: no draft of ${PIPELINE_SLUG} contains ${ASSISTANT_STEP_NAME} any more (via the API)`,
    );
  });
});
