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
// EXECUTION ORDER: e runs before d. journey_step's deterministic long turn
// (its instruction, STEP_INSTRUCTION) settles before the approve gate can
// open, so the takeover must land during that turn — the gate is then
// approved (d) after the hand-back's re-queued attempt 2 has run.
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
/** The draft instruction for the new Agent step (harmless: read-only).
 *
 * A DETERMINISTIC long turn — the step e takeover must land WHILE
 * journey_step is in flight, and a turn that settles in a few seconds is
 * already over by the time Take control is confirmed (issue2 A5 had the
 * exact race and solved it with a shell wait — impossible here: the dialog
 * profile is always permission_mode=ask, which the ACP harness treats as
 * deny, internal/agent/acp/permission.go, so any shell wait is rejected).
 * A long generation keeps the turn open instead: at the lab model's
 * ~80 tok/s, a 2500–4000 word essay stays in flight for well over the
 * ~30 s the workbench UI needs between the API catch and the confirm click.
 *
 * The reply must still extract to a JSON object (§ 4 step 6 / 01 invariant
 * 4): the essay is brace-free prose (the extractor falls back to the reply's
 * first `{` … last `}`), and the listing travels as the final fenced json
 * block, which extractStructuredOutput prefers over the brace span.
 */
const STEP_INSTRUCTION =
  "Do not modify anything in the repository. Write a long essay of at least " +
  "2500 words and at most 4000 words about the history of programming " +
  "languages, from early assembly languages and FORTRAN to modern languages " +
  "such as Go and Rust, with a separate section for each major language and " +
  "concrete historical examples. Strict formatting rules: plain prose only — " +
  "do not use any curly brace characters and do not use any fenced code " +
  "blocks anywhere in the essay. After the essay, on a final separate line, " +
  'reply with the result as a fenced json code block: a JSON object {"files": ...} ' +
  "where files is the array of the file and directory names at the repository " +
  "root (you may read the root listing to answer this).";
/** The node id the new step is renamed to (renamed LAST — the rename commit
 * drops the node selection, so no other field may follow it). */
const NEW_NODE_ID = "journey_step";
/** The assistant's change target (step f), asserted through the draft YAML. */
const ASSISTANT_STEP_NAME = "journey_check";
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

interface DocNode {
  id: string;
  dependsOn: string[];
  block: string;
}

/** Line-level read of a document YAML: the top-level node list (the one
 * holding `plan`), each node's dependsOn and its raw block. The server
 * marshals documents with alphabetized keys and 4-space indents (a node
 * item starts `- config:` and its `id:` sorts later), so the node list is
 * found structurally: the first `nodes:` key, then the first sequence dash
 * below it. Enough to see which successors bind a node's outputs — the
 * guarded-edge rule. */
function parseTopLevelNodes(yaml: string): DocNode[] {
  const lines = yaml.split("\n");
  const ni = lines.findIndex((l) => /^\s*nodes:\s*$/.test(l));
  if (ni < 0) return [];
  let dash = -1;
  for (let i = ni + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)- /);
    if (m) {
      dash = m[1].length;
      break;
    }
  }
  if (dash < 0) return [];
  const starts: number[] = [];
  for (let i = ni + 1; i < lines.length; i++) {
    if (/^\s*\S/.test(lines[i]) && lines[i].match(/^(\s*)/)![1].length < dash) break;
    if (lines[i].startsWith(" ".repeat(dash) + "- ")) starts.push(i);
  }
  return starts
    .map((s, k) => {
      const end = k + 1 < starts.length ? starts[k + 1] : lines.length;
      const block = lines.slice(s, end).join("\n");
      const id = block.match(new RegExp(`^ {${dash + 2}}id: ([A-Za-z0-9_.-]+)$`, "m"))?.[1];
      if (!id) return null;
      const dependsOn: string[] = [];
      const flow = block.match(new RegExp(`^ {${dash + 2}}dependsOn:\s*\\[([^\\]]*)\\]`, "m"));
      if (flow) {
        flow[1].split(",").forEach((s) => {
          const v = s.trim().replace(/^['"]|['"]$/g, "");
          if (v) dependsOn.push(v);
        });
      } else {
        const dl = lines.slice(s, end);
        const bi = dl.findIndex((l) => l === " ".repeat(dash + 2) + "dependsOn:");
        for (let i = bi + 1; bi >= 0 && i < dl.length; i++) {
          const dm = dl[i].match(new RegExp(`^ {${dash + 4}}- ([A-Za-z0-9_.-]+)\s*$`));
          if (dm) dependsOn.push(dm[1]);
          else if (dl[i].trim() !== "") break;
        }
      }
      return { id, dependsOn, block } satisfies DocNode;
    })
    .filter((n): n is DocNode => n !== null);
}

/** The step-f anchor: a node with an outgoing edge no successor guards —
 * the successor's config binds no `nodes.<x>.*` output of the node and the
 * edge carries no `when` guard naming it. The journey's own journey_step
 * is preferred when its journey_step→approve edge is open (approve binds
 * nodes.plan.*, not journey_step's outputs). */
function unguardedAnchor(nodes: DocNode[]): { anchor: string; successor: string } | null {
  const edgesOf = (id: string) => nodes.filter((n) => n.dependsOn.includes(id));
  const openOf = (x: DocNode) =>
    edgesOf(x.id).filter(
      (s) => !s.block.includes(`nodes.${x.id}.`) && !/when[^\n]*\b${x.id}\b/.test(s.block),
    );
  const pick = (x: DocNode) => {
    const open = openOf(x);
    return open.length ? { anchor: x.id, successor: open[0].id } : null;
  };
  const journey = nodes.find((n) => n.id === NEW_NODE_ID);
  if (journey) {
    const p = pick(journey);
    if (p) return p;
  }
  for (const n of nodes) {
    const p = pick(n);
    if (p) return p;
  }
  return null;
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
  const body = (await res.json()) as { node_executions?: NodeRow[] };
  return body.node_executions ?? [];
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

/** Poll until the run's journey_step agent.acp node execution is in flight.
 *
 * The node's own status is the live signal: a worker-leased agent step sits
 * at `leased` for its ENTIRE turn (BeginTurn flips only the conversation turn
 * to `running`, never the node execution — ADR-0023 § 3's two-path node
 * machine), and only the terminal write moves it on. `running` is kept as an
 * accepted in-flight state so the poll cannot miss a build where the node does
 * carry it.
 *
 * The node is targeted BY ID, not "any agent step": plan and implement are
 * short turns (a few seconds) — catching one of them is the very race that
 * made the pre-fix step e flaky (its turn settled before the confirm click).
 * journey_step's instruction holds the lab model for about a minute or more,
 * so that window is deterministic. Poll fast: one second between reads.
 */
const IN_FLIGHT = new Set(["leased", "running"]);
async function waitForAgentRunning(request: APIRequestContext, runId: string): Promise<NodeRow> {
  const deadline = Date.now() + NODE_STEP_TIMEOUT_MS;
  for (;;) {
    const nodes = await runNodes(request, runId);
    const live = nodes.find(
      (n) => n.node_id === NEW_NODE_ID && n.kind === "agent.acp" && IN_FLIGHT.has(n.status),
    );
    if (live) return live;
    if (Date.now() > deadline) {
      throw new Error(
        `journey_step (${NEW_NODE_ID}) never went in-flight (leased/running) in run ${runId} within the window (nodes: ${
          nodes.map((n) => `${n.node_id}:${n.status}`).join(" ") || "none"
        })`,
      );
    }
    await sleep(1_000);
  }
}

/**
 * Wait for an assistant turn to reach its own completion: the popover's
 * in-flight indicator (`assistant-thinking`) clears, or a new assistant
 * message appears — whichever the turn's state settles in — with a ceiling
 * of 240 s (the lab's per-completion deadline is COMMUNICATION_ASSISTANT_TIMEOUT=180s;
 * this bound is generous but finite). Every wait for an assistant turn in
 * this journey goes through here instead of a fixed window.
 */
async function waitForAssistantTurn(page: Page, timeoutMs = 240_000): Promise<void> {
  const thinking = page.getByTestId("assistant-thinking");
  const assistantMsg = page.getByTestId("assistant-msg-assistant");
  await expect
    .poll(
      async () => {
        const inFlight = await thinking.isVisible().catch(() => false);
        const messages = await assistantMsg.count();
        const latest = messages > 0 ? ((await assistantMsg.last().textContent()) ?? "").trim() : "";
        const settled = !inFlight && (messages > 0 ? latest.length > 0 : true);
        return settled;
      },
      { timeout: timeoutMs, intervals: [1_000] },
    )
    .toBe(true);
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

    // The new node is selected: the inspector names it — the id field lives
    // inside the design's collapsed "Retries, timeout and outputs"
    // disclosure (1g pass 2 #2), so open it first.
    await page.getByTestId("insp-advanced-disclosure").locator("summary").click();
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
    // Every serial step gets a fresh browser context (a fresh cookie jar),
    // so the session must be re-established with the SAME subject before
    // touching the state the previous step created (house style, like
    // issue2-workbench.spec.ts re-signing per step).
    await signIn(page, "admin");
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
    await signIn(page, "admin"); // fresh context: re-establish the session (same subject)
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
      if ((await repo.evaluate((el) => el.tagName)) === "SELECT") {
        // index 0 is the empty “— choose —” placeholder; pick the first real
        // option by its value (selecting the placeholder leaves the required
        // field empty and the submit stays disabled forever).
        const options = await repo.locator("option").all();
        const value = await Promise.all(
          options.map(async (option) => await option.getAttribute("value")),
        ).then((values) => values.find((v) => v !== null && v !== ""));
        if (!value)
          throw new Error("the new-run form offers no selectable repository for the project");
        await repo.selectOption({ value });
      } else {
        const res = await page.request.get(`${BASE_URL}/api/v1/projects/${state.projectId}/repos`);
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
    // The run is pinned to the revision just published. The header renders
    // it as `r{number} {shortDigest(digest).slice(0,6)}` (shortDigest strips
    // the `sha256:` prefix), so assert that exact shape: the published
    // number plus the digest's first six hex chars.
    const expectedPinned = `r${state.revisionBefore + 1} ${state.revisionDigest
      .replace(/^sha256:/, "")
      .slice(0, 6)}`;
    await expect(page.getByTestId("run-pinned-revision")).toContainText(expectedPinned);
    await evidence(
      page,
      `journey-c-run-${STAMP}`,
      `run ${state.runId} started from the new revision ${expectedPinned} (${state.revisionDigest.slice(0, 19)}…) and the workbench opened on it`,
    );
  });

  test("e — workbench: watch a live agent step, take control, prompt, hand back", async ({
    page,
  }) => {
    await signIn(page, "admin"); // fresh context: re-establish the session (same subject)
    // This test deliberately runs BEFORE step d: journey_step's long turn
    // settles before the approve gate can open, so the deterministic takeover
    // window is its attempt 1 — right after the run's short plan turn.
    // Poll the API until journey_step is in flight, then load the workbench
    // deep-linked to it (below) — the catch lands seconds after the lease,
    // inside the ~2-minute long turn.
    const agentPromise = waitForAgentRunning(page.request, state.runId);

    // A live agent step (leased = the worker holds it and the agent is
    // working; running = the turn is open) — its live status is what the
    // workbench shows.
    const node = await agentPromise;
    state.agentNodeId = node.node_id;

    // Load the workbench DEEP-LINKED to journey_step's node execution.
    // `?node=<execution id>` is the workbench's own deep-link form: it is
    // remapped to the definition node + instance on the first data, and a
    // `?node=` present on page load suppresses the dock's attention
    // auto-select for the life of the page. That suppression is what makes
    // the takeover deterministic: without it the dock parks on the plan's
    // just-finished conversation (whose completed attempt still offers a
    // Take control button — the pre-fix run took over that WRONG step), and
    // when the run then parked at the approval gate the auto-select moved
    // the dock to the gate, the confirm card unmounted, and the confirm
    // click waited out the 30-minute test timeout. With the deep link the
    // dock shows journey_step from first paint and never moves (ADR-0043
    // decision 4: the reader's pick wins).
    await gotoApp(page, `/runs/${state.runId}?node=${node.id}`);
    await expect(page.getByTestId("workbench")).toBeVisible({ timeout: NODE_STEP_TIMEOUT_MS });

    // The dock shows journey_step's live conversation (its attempt's
    // conversation is stamped at claim, so the dock shows it as soon as the
    // worker's ACP session opens) and its Take control button.
    const dockControl = page.getByTestId("dock-take-control");
    await expect(dockControl).toBeVisible({ timeout: NODE_STEP_TIMEOUT_MS });
    await expect(page.getByTestId("dock-conversation")).toBeVisible({ timeout: 30_000 });
    await checkShellScreen(page, "workbench", stopWatching ?? undefined);
    await evidence(
      page,
      `journey-e-live-${STAMP}`,
      `the workbench is pinned to agent step ${node.node_id} (status ${node.status} via the API) with its live conversation in the dock`,
    );

    // Take control: the first click opens the confirm card with its truthful
    // copy — and the card names journey_step itself (the heading carries the
    // step's instance key), so a card for any other step cannot pass.
    await dockControl.click();
    const takeCard = page.getByTestId("take-control-card");
    await expect(takeCard).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("take-control-card-heading")).toContainText(NEW_NODE_ID);
    const copy = (await takeCard.textContent()) ?? "";
    expect(copy, "the card states what a takeover does").toMatch(/stops and the run pauses/);
    expect(copy, "the card states what a hand-back does").toMatch(/new attempt/i);
    await evidence(
      page,
      `journey-e-confirm-${STAMP}`,
      `the take-control confirm card names ${node.node_id} and says the attempt stops, the run pauses, and the hand-back re-runs the step as a new attempt (ADR-0043)`,
    );
    // Bounded: the card is transient in-DOM state. A missed click must fail
    // fast (and re-open it), not ride the 30-minute test timeout — the exact
    // pre-fix failure mode.
    for (let round = 0; ; round += 1) {
      try {
        await page.getByTestId("take-control-confirm").click({ timeout: 20_000 });
        break;
      } catch (err) {
        const badge =
          (await page
            .getByTestId("dock-controller")
            .textContent()
            .catch(() => "")) ?? "";
        if (/you are in control/i.test(badge)) break; // the click landed after all
        if (round >= 1)
          throw new Error(
            `the take-control confirm click for ${NEW_NODE_ID} missed twice (the card closed?) — ${String(
              err,
            )}`,
          );
        await dockControl.click({ timeout: 20_000 });
        await expect(takeCard).toBeVisible({ timeout: 15_000 });
        await expect(page.getByTestId("take-control-card-heading")).toContainText(NEW_NODE_ID);
      }
    }

    // The controller line names you.
    await expect
      .poll(async () => (await page.getByTestId("dock-controller").textContent()) ?? "", {
        timeout: 60_000,
      })
      .toMatch(/you are in control/i);

    // One prompt in the composer; the agent replies.
    const before = await page.getByTestId("transcript-item").count();
    await page
      .getByTestId("dock-composer-input")
      .fill("Say hello to acknowledge, then carry on with your original task.");
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
      `admin is in control of ${node.node_id}: one prompt (“Say hello to acknowledge, then carry on with your original task.”) got a live agent reply in the dock`,
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

  test("d — approve the run's human gate from the Inbox at 390x844", async ({ page }) => {
    await signIn(page, "admin"); // fresh context: re-establish the session (same subject)
    // The run's plan step and journey_step's re-queued attempt 2 (the step e
    // hand-back runs it again) precede the gate, so the approval may take the
    // whole gate window.
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

  test("f — assistant via ⌘K: add a step to the draft, then undo all", async ({ page }) => {
    await signIn(page, "admin"); // fresh context: re-establish the session (same subject)
    await gotoApp(page, `/workflows/${state.pipeline.id}`);
    await expect(page.getByTestId("pipeline-page")).toBeVisible();

    // ⌘K opens the assistant popover (the app's own shortcut; Ctrl-K on a
    // headless browser where Meta is not delivered).
    await page.keyboard.press("Meta+k");
    const popover = page.getByTestId("assistant-popover");
    if (!(await popover.isVisible().catch(() => false))) await page.keyboard.press("Control+k");
    await expect(popover).toBeVisible({ timeout: 10_000 });

    // Fresh context: the popover auto-loads the user's LATEST conversation —
    // the run shared with earlier specs (the lab's 78-message conversation)
    // confuses the model. The header's New-conversation control clears it
    // (p7-wire); with an empty conversation the body is also not scrollable,
    // so the a11y pass that follows stays meaningful.
    const fresh = page.getByTestId("assistant-new-conversation");
    if (!(await fresh.isVisible().catch(() => false)))
      throw new Error(
        "the popover header has no New-conversation control (assistant-new-conversation) — the lab build predates the p7-wire fix; the reused conversation would poison the ask",
      );
    await fresh.click();
    await checkShellScreen(page, "assistant-popover", stopWatching ?? undefined);

    // The marker must not predate the ask (a crashed earlier journey run).
    const stale = await draftsContaining(page.request, ASSISTANT_STEP_NAME);
    if (stale.length > 0)
      throw new Error(
        `pre-existing lab state: draft(s) ${stale
          .map((d) => d.id)
          .join(
            ", ",
          )} already contain ${ASSISTANT_STEP_NAME} — the marker would not be this ask's proof`,
      );

    // Compute the anchor from the NEWEST published document (the draft the
    // assistant edits is built from it): a node whose outgoing edge no
    // successor guards — no `nodes.<x>.*` binding in the successor's config,
    // no `when` guard naming it. (plan→approve is guarded: approve reads
    // nodes.plan.*)
    const doc = await revisionDocument(page, state.revisionDigest);
    const anchor = unguardedAnchor(parseTopLevelNodes(doc));
    if (!anchor)
      throw new Error(
        `no unguarded outgoing edge among the newest revision's nodes: ${
          parseTopLevelNodes(doc)
            .map((n) => n.id)
            .join(", ") || "none parsed"
        } — cannot pick a safe insert position`,
      );
    console.log(`journey f: anchor ${anchor.anchor} → ${anchor.successor} (unguarded)`);
    const ask = `Add a human approval step named ${ASSISTANT_STEP_NAME} after ${anchor.anchor} in ${PIPELINE_SLUG}'s draft`;
    await page.getByTestId("assistant-composer-input").fill(ask);
    await page.getByTestId("assistant-send").click();

    // Follow the assistant's bounded loop, at most 3 assistant turns: the ask
    // is turn 1 and every follow-up (a plain “make that change now”, a
    // completion-cap nudge, an answered question, a retried approval) is the
    // next turn. A question card is answered by clicking the model-written
    // option that best matches the ask (preferring the anchor's name) — and
    // the next user message must carry the option's label VERBATIM as plain
    // text (spec 08 / ADR-0050). An approval card gets Retry: at trust
    // ask_risky a draft edit should not be approval-gated. The loop breaks
    // only when the change is REAL — a draft's YAML carries journey_check
    // (via API). The change chip is asserted afterwards, not as the gate: a
    // previous run's chip would otherwise look like success. e2e-jf2: a turn
    // that ends WITHOUT acting (no error, no question card, no approval card,
    // draft lacks the marker) gets ONE plain user follow-up — “Please make that
    // change now.” — a real user would.
    let followUps = 0;
    let capRetried = false;
    const deadline = Date.now() + AGENT_TURN_TIMEOUT_MS;
    for (;;) {
      const error = page.getByTestId("assistant-error");
      if (await error.isVisible().catch(() => false)) {
        const errorText = ((await error.textContent()) ?? "(no text)").trim();
        // Model variance: a turn can end at its completion cap without
        // landing the change. A user would simply say "continue" — bounded to
        // ONE such follow-up, and it counts against the same 3-turn budget
        // (never more than 3 assistant turns total).
        if (!capRetried && /completion cap/i.test(errorText) && followUps < 3) {
          capRetried = true;
          followUps += 1;
          console.log(
            `journey f: turn hit the completion cap — one plain follow-up (turn ${followUps}/3)`,
          );
          await page
            .getByTestId("assistant-composer-input")
            .fill("Please continue and make the change.");
          await page.getByTestId("assistant-send").click();
          // The retry is a NEW turn — bound the wait on its own completion.
          await waitForAssistantTurn(page);
          continue;
        }
        throw new Error(
          `the assistant errored: ${errorText} — is the assistant tool loop (be-as-loop) / popover wiring (p7-wire) live in this lab?`,
        );
      }
      if (followUps >= 3)
        throw new Error(
          `the assistant still has not landed ${ASSISTANT_STEP_NAME} after 3 follow-up turns`,
        );
      if (
        await page
          .getByTestId("assistant-question")
          .isVisible()
          .catch(() => false)
      ) {
        const options = page.getByTestId("assistant-question-option");
        const count = await options.count();
        if (count === 0) throw new Error("the question card rendered no options to click");
        const labels = await Promise.all(
          Array.from({ length: count }, async (_, i) =>
            ((await options.nth(i).textContent()) ?? "").trim(),
          ),
        );
        const idx = labels.findIndex((l) => l.toLowerCase().includes(anchor.anchor.toLowerCase()));
        const best = idx >= 0 ? idx : 0;
        const label = labels[best];
        const userBefore = await page.getByTestId("assistant-msg-user").count();
        await options.nth(best).click();
        // The reply travels as a plain-text user message equal to the label, and
        // the answer turn lands that row only when it completes — so the wait is
        // bounded by the turn's own completion, then the label asserts verbatim.
        await waitForAssistantTurn(page);
        await expect
          .poll(
            async () => {
              const msgs = page.getByTestId("assistant-msg-user");
              return (await msgs.count()) === userBefore + 1
                ? ((await msgs.nth(userBefore).textContent()) ?? "").trim()
                : "";
            },
            { timeout: 15_000 },
          )
          .toBe(label);
        followUps += 1;
        console.log(`journey f: question answered with "${label}" (turn ${followUps}/3)`);
        continue;
      }
      if (
        await page
          .getByTestId("assistant-approval")
          .isVisible()
          .catch(() => false)
      ) {
        await page.getByTestId("assistant-approval-confirm").click(); // Retry
        // The Retry re-runs the turn — bound the wait on its own completion.
        await waitForAssistantTurn(page);
        followUps += 1;
        console.log(`journey f: approval card retried (turn ${followUps}/3)`);
        continue;
      }
      const landed = (await draftsContaining(page.request, ASSISTANT_STEP_NAME)).length > 0;
      if (landed) {
        console.log(`journey f: the assistant landed ${ASSISTANT_STEP_NAME} — loop done`);
        break;
      }
      // e2e-jf2: the turn ended WITHOUT acting — no error, no question card and
      // no approval card (all handled above) and the draft still lacks the
      // marker. Lab evidence (model flint): a turn can end by describing what
      // it found WITHOUT changing anything and without a question/approval
      // card. A real user would simply say “please make that change now”: send
      // ONE plain user follow-up.
      const composer = page.getByTestId("assistant-composer-input");
      // The turn that produced this state has settled (no error / card above):
      // wait for the turn's own completion — the popover's in-flight indicator
      // clears / a new assistant message appears — before following up.
      await waitForAssistantTurn(page);
      // The turn may have landed while we waited; the draft is the gate.
      if ((await draftsContaining(page.request, ASSISTANT_STEP_NAME)).length > 0) break;
      followUps += 1;
      console.log(
        `journey f: turn ended without acting — one plain follow-up (turn ${followUps}/3)`,
      );
      await composer.fill("Please make that change now.");
      await page.getByTestId("assistant-send").click();
      if (Date.now() > deadline)
        throw new Error(
          `no draft of ${PIPELINE_SLUG} carries ${ASSISTANT_STEP_NAME} after the ask — the assistant never landed the change (assistant tool loop be-as-loop?)`,
        );
      await waitForAssistantTurn(page);
    }

    // The change chip counts its change(s) — expanded, so its rows show
    // (the chip collapses by default and renders no rows closed).
    const chip = page.getByTestId("assistant-change-chip");
    await expect(chip).toBeVisible();
    expect((await chip.textContent()) ?? "", "the change chip counts its changes").toMatch(
      /\d+\s+changes?/,
    );
    const chipRow = page.getByTestId("assistant-change-row").first();
    if (!(await chipRow.isVisible().catch(() => false)))
      await page.getByTestId("assistant-change-chip-toggle").click();
    await expect(chipRow).toBeVisible();

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
