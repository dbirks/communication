// Issue #2 acceptance journeys for the live Run Workbench:
// A4 (the run page opens graph-first, the dock auto-selects the node that
// needs attention, the human gate is approved from the dock, the agent.acp
// node shows a live transcript), A5 (bob takes control of the ACP
// conversation, carol is read-only, the factory takes the conversation back,
// the timeline records the handoffs), A6 (process.exec facts, the approval
// decision, the until scope's iteration instances, the for_each fan-out items
// with the retried item 13, and the terminal state) plus a mid-run reload
// and the narrow (390x844) layout.
//
// It runs against the M4 lab ONLY when COMMUNICATION_E2E_ISSUE2=1 — skipped
// everywhere else, the same env-gate idiom as the sibling issue2 specs:
//   COMMUNICATION_E2E_ISSUE2=1 E2E_BASE_URL=http://localhost:15173 \
//     pnpm exec playwright test tests/issue2-workbench.spec.ts
// The run starts from the revision issue2-studio.spec.ts published (recorded
// in ${EVIDENCE_DIR}/published.json); if that file is absent the spec FAILS
// with a clear "run issue2-studio.spec.ts first" message instead of silently
// skipping the ACP-dependent steps, because the seeded twin is pure
// process.exec and carries no agent.acp node. With the studio revision
// present the run is a real agent turn through the lab worker (m4-reviewer
// via the inserted code_review node), so every wait around it is bounded by
// AGENT_TURN_TIMEOUT_MS and never open-ended.
//
// Every journey step calls the local `evidence()`: a full-page screenshot
// into ${E2E_EVIDENCE_DIR ?? "test-results/issue2"}/<name>.png plus one
// console line `EVIDENCE <name>: <what it proves>`.
//
// Accessibility: the shared axe pass (tests/a11y.ts, @axe-core/playwright,
// wcag2a+wcag2aa, failing only on serious/critical) audits the workbench
// graph view, the ACP dock, the viewer (carol) view, and the narrow layout.
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { test, expect, type Locator, type Page } from "@playwright/test";
import { checkA11y } from "./a11y.js";
import { AGENT_TURN_TIMEOUT_MS } from "./env.js";
import {
  expectRunStatus,
  openProjectBySlug,
  repinAssignment,
  setMember,
  signIn,
} from "./helpers.js";

const ISSUE2_ENABLED = process.env.COMMUNICATION_E2E_ISSUE2 === "1";
/** Unique per run so re-runs never collide with their own earlier rows. */
const STAMP = process.env.E2E_ISSUE2_STAMP ?? Date.now().toString(36);
const PROJECT_SLUG = "m4-exit";
const FALLBACK_SLUG = "feature-development-deterministic";
const EVIDENCE_DIR = process.env.E2E_EVIDENCE_DIR ?? "test-results/issue2";
const PUBLISHED_PATH = path.join(EVIDENCE_DIR, "published.json");
/** Lab identities (docs/compatibility/probes/m4/seed.sh), named here so the
 * directory row's display name is the one the journey asserts on. */
const ADMIN = "admin";
const BOB = { subject: "bob", name: "Bob" };
const CAROL = { subject: "carol", name: "Carol" };
/** A node step is worker polls plus sleep inputs, not milliseconds. */
const NODE_STEP_TIMEOUT_MS = Number(process.env.E2E_NODE_STEP_TIMEOUT_MS ?? 420_000);
/** fanout_count=14 child runs with 20 s holds; bounded, never open-ended. */
const TERMINAL_TIMEOUT_MS = Number(process.env.E2E_TERMINAL_TIMEOUT_MS ?? 1_800_000);

/** One piece of journey evidence: a screenshot plus a single log line. */
async function evidence(page: Page, name: string, what: string): Promise<void> {
  await mkdir(EVIDENCE_DIR, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCE_DIR, `${name}.png`), fullPage: true });
  console.log(`EVIDENCE ${name}: ${what}`);
}

/**
 * Open a run URL and wait for the workbench to mount. Returns the page's one
 * description of the run's status (`run-header-status`).
 */
async function openRun(page: Page, runUrl: string): Promise<Locator> {
  await page.goto(runUrl);
  await expect(page.getByTestId("workbench")).toBeVisible({ timeout: NODE_STEP_TIMEOUT_MS });
  return page.getByTestId("run-header-status");
}

/**
 * Select the New-run assignment whose option text starts with "<slug> · "
 * (the form renders "<pipelineSlug> · <versionLabel> · max N concurrent").
 * Matching the slug as the WHOLE first token keeps "feature-development" from
 * shadowing "feature-development-deterministic", and matching by the rendered
 * text — not a guessed value — keeps the pick in sync with what the form
 * really offers. It logs every option's text and value, re-asserts the pick
 * while the controlled select snaps back to its default (first) assignment
 * during its re-render, and fails fast — with the full option list — if the
 * goal input never appears.
 */
async function selectPipelineAssignment(page: Page, slug: string): Promise<void> {
  const select = page.getByTestId("new-run-assignment");
  await expect(select).toBeAttached({ timeout: NODE_STEP_TIMEOUT_MS });
  const optionRows = async (): Promise<string[]> => {
    const options = await select.locator("option").all();
    const rows: string[] = [];
    for (const option of options)
      rows.push(
        `value=${(await option.getAttribute("value")) ?? "?"} ` +
          `text=${JSON.stringify((await option.textContent()) ?? "")}`,
      );
    return rows;
  };
  const rows = await optionRows();
  console.log(`WORKBENCH setup: assignment options — ${rows.join(" | ")}`);
  const target = rows.find((row) => row.includes(`text="${slug} · `));
  if (!target)
    throw new Error(
      `WORKBENCH setup: no assignment option for pipeline ${slug} (options: ${rows.join(" | ")})`,
    );
  const targetValue = target.match(/^value=([^ ]+)/)?.[1] ?? "";
  const goal = page.getByTestId("new-run-input-goal");
  const deadline = Date.now() + 60_000; // fail fast, with the option list, not on the test timeout
  for (;;) {
    const selected = await select.inputValue();
    if (selected !== targetValue) {
      // The select is controlled: a re-render racing the change can snap it
      // back to the default (first) assignment — re-assert the pick.
      await select.selectOption(targetValue);
    } else if (await goal.isVisible()) {
      console.log(`WORKBENCH setup: assignment for ${slug} selected (value ${targetValue})`);
      return;
    }
    if (Date.now() >= deadline)
      throw new Error(
        `WORKBENCH setup: the ${slug} assignment is selected (value ${targetValue}) but the ` +
          `goal input never appeared (options: ${(await optionRows()).join(" | ")})`,
      );
    await page.waitForTimeout(2_000);
  }
}

/**
 * The id of the revision's agent.acp node, if it has one (the studio spec
 * inserts `code_review` on the test → review edge inside the until scope and
 * wraps a trailing until scope that ends in an `agent` step; the seeded
 * deterministic twin has neither). The studio insertion is preferred so the
 * journey drives the node it actually edited; any other agent.acp the
 * revision has is the fallback.
 *
 * The workbench canvas is the Studio canvas: a node box is
 * `canvas-step-<id>` (the definition node id) and its `div[role="button"]`
 * carries `aria-label="<kind label> step <id>"` — `agent.acp` boxes read
 * "Coding agent".
 */
async function findAcpSlug(page: Page): Promise<string | null> {
  // The `^canvas-step-` prefix ALSO matches the collapsed definition table's
  // `canvas-step-list` section and its `canvas-step-row-<id>` buttons
  // (StudioCanvas) — only the flow's node boxes carry the clickable inner
  // div[role="button"], so a non-box match would hang the aria-label read
  // forever; skip the table matches.
  const candidates = page.locator('[data-testid^="canvas-step-"]');
  const count = await candidates.count();
  const slugs: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const candidate = candidates.nth(i);
    const testid = (await candidate.getAttribute("data-testid")) ?? "";
    if (testid === "canvas-step-list" || testid.startsWith("canvas-step-row-")) continue;
    // Guard with count() first: getAttribute auto-waits for the element, and a
    // box without its inner button would otherwise hang the read for the full
    // action timeout (observed: ~3 min of 30 s hangs once, which ate both
    // code_review windows of the takeover journey).
    const button = candidate.locator('div[role="button"]');
    if ((await button.count()) === 0) continue;
    const label = (await button.first().getAttribute("aria-label")) ?? "";
    if (!/^Coding agent step /i.test(label)) continue;
    const slug = testid.replace(/^canvas-step-/, "");
    if (slug) slugs.push(slug);
  }
  return slugs.find((slug) => slug === "code_review") ?? slugs[0] ?? null;
}

/** The workbench's node box for a definition node id, and its clickable inner button. */
function nodeButton(page: Page, id: string): Locator {
  return page.locator(`[data-testid="canvas-step-${id}"]`).locator('div[role="button"]').first();
}

/**
 * Click a node box through the canvas's own viewport: the live run's graph
 * can drift off-viewport (the canvas refits on mount and pane resize only —
 * observed live: a blank canvas, every node box off-pan, after minutes with
 * the run page open). An off-viewport box never becomes actionable, so a
 * bare click waits until the test deadline. Fitting with the React Flow
 * "Fit View" control is the canvas's own user affordance for exactly this
 * state — every functional assertion after the click is unchanged.
 */
async function clickNodeBox(page: Page, id: string): Promise<void> {
  const fit = page.getByRole("button", { name: "Fit View" });
  if ((await fit.count()) > 0) await fit.click().catch(() => undefined);
  await page.waitForTimeout(300); // the fit settles (duration 0 in the canvas)
  await nodeButton(page, id).click();
}

/**
 * Click a node box and re-click until its row has been journaled: a box
 * clicked before its execution row exists resolves to an empty dock, and
 * the URL's `instance=` is what the dock reads, so the pick is retried on
 * the node box itself (never left on `workbench-dock-empty`).
 */
async function selectNode(page: Page, id: string, timeoutMs: number): Promise<void> {
  const dockEmpty = page.getByTestId("workbench-dock-empty");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await clickNodeBox(page, id);
    if ((await dockEmpty.count()) === 0) return;
    if (Date.now() >= deadline) throw new Error(`node ${id} never resolved to an execution`);
    await page.waitForTimeout(5_000);
  }
}

/** The run id embedded in the journey's run URL. */
function runIdOf(runUrl: string): string {
  return runUrl.split("/").pop() ?? "";
}

/**
 * The ledger's in-flight vocabulary: a node execution whose attempt is
 * executing on a worker reports `leased` (its row only goes `running` when
 * the attempt reports in), so `leased` and `running` are BOTH "in flight".
 * The takeover journey keys off the ATTEMPT (the thing that gets interrupted),
 * not the node row's status field, so it is the attempt's own status that is
 * authoritative here.
 */
const IN_FLIGHT_ATTEMPT_STATUSES = new Set(["leased", "running"]);
/** Terminal node rows have no in-flight attempt to find. */
const TERMINAL_NODE_STATUSES = new Set([
  "succeeded",
  "failed",
  "skipped",
  "cancelled",
  "interrupted",
]);

/**
 * Poll `GET /api/v1/runs/:id/nodes` (+ the per-execution detail route) until
 * an execution of `nodeId` has an ATTEMPT that is `leased`/`running` WITH A
 * LIVE `conversation_id`, and return that execution's `node_instance_key`.
 * The takeover journey must take control while an attempt is ACTUALLY running
 * — a takeover after the turn settled changes no run row (no
 * `run.paused`/`human_takeover`), so this poll is what keeps the A5 journey
 * honest. The until scope runs the node in two iterations, so the poll scans
 * every non-terminal execution and accepts whichever attempt is live. The
 * conversation is what makes the dock's Take control button exist at all (a
 * leased-but-pre-session attempt renders "The agent has not started yet"),
 * so a running attempt without one is not yet takeable. The list row's
 * identity is its `id` (the detail route's `{nodeExecutionId}` path param) —
 * rows carry no separate `node_execution_id` field. `page.request` shares
 * the signed-in session (GET needs no CSRF token).
 */
async function expectRunningExecution(
  page: Page,
  runId: string,
  nodeId: string,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  const stamp = () => new Date().toISOString().slice(11, 19);
  console.log(`WORKBENCH poll start: ${nodeId} on run ${runId.slice(0, 8)} at ${stamp()}`);
  let last = `no ${nodeId} execution yet`;
  let lastLogged = "";
  for (;;) {
    const response = await page.request.get(`/api/v1/runs/${runId}/nodes`);
    if (!response.ok())
      throw new Error(`nodes API answered ${response.status()} — ${await response.text()}`);
    const body = (await response.json()) as {
      node_executions: Array<{
        id: string;
        node_id: string;
        node_instance_key: string;
        status: string;
        attempt_count: number;
      }>;
    };
    const rows = body.node_executions.filter(
      (node) => node.node_id === nodeId && !TERMINAL_NODE_STATUSES.has(node.status),
    );
    const summary = () =>
      body.node_executions
        .filter((node) => node.node_id === nodeId)
        .map((node) => `${node.node_instance_key}:${node.status}`)
        .join(" ") || "none";
    last = summary();
    // Log each distinct ledger state (deduped) so the run's log shows the
    // poll's live view of the node's rows without one line per 3 s tick.
    if (last !== lastLogged) {
      console.log(`WORKBENCH poll ${stamp()}: ${last} (non-terminal: ${rows.length})`);
      lastLogged = last;
    }
    let liveKey: string | null = null;
    let liveNote = "";
    for (const row of rows) {
      const detailResponse = await page.request.get(`/api/v1/runs/${runId}/nodes/${row.id}`);
      if (!detailResponse.ok()) {
        last += ` | ${row.node_instance_key} detail ${detailResponse.status()}`;
        continue;
      }
      const detail = (await detailResponse.json()) as {
        attempts?: Array<{ status: string; conversation_id: string | null }>;
      };
      const attempts = detail.attempts ?? [];
      const note = attempts
        .map((attempt) => `${attempt.status}${attempt.conversation_id ? "+conv" : ""}`)
        .join(", ");
      last += ` | ${row.node_instance_key}[${row.status}] attempts: ${note}`;
      const live = attempts.some(
        (attempt) =>
          IN_FLIGHT_ATTEMPT_STATUSES.has(attempt.status) && attempt.conversation_id != null,
      );
      if (live) {
        liveKey = row.node_instance_key;
        liveNote = note;
        break;
      }
    }
    if (liveKey) {
      console.log(`WORKBENCH: ${nodeId} in flight at ${liveKey} (attempt rows: ${liveNote})`);
      return liveKey;
    }
    if (Date.now() >= deadline)
      throw new Error(
        `no ${nodeId} execution went in flight with a live conversation within ${timeoutMs}ms ` +
          `(ledger: ${last})`,
      );
    await page.waitForTimeout(3_000);
  }
}

/**
 * Poll `GET /api/v1/runs/:id` until the run is `paused` for `reason` — the
 * ledger's word that the takeover interrupted an in-flight attempt (the
 * attempt closes `interrupted{human_takeover}` and the run pauses for that
 * reason, contract § 5.3). A takeover on a settled attempt never writes it.
 */
async function expectPausedFor(
  page: Page,
  runId: string,
  reason: string,
  timeoutMs: number,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const body = (await (await page.request.get(`/api/v1/runs/${runId}`)).json()) as {
          status?: string;
          paused_reason?: string | null;
        };
        return body.status === "paused" && body.paused_reason === reason;
      },
      { timeout: timeoutMs },
    )
    .toBeTruthy();
}

/**
 * Poll the nodes API until some execution of `nodeId` has `attempt_count >= n`
 * — the factory's re-run of the node after a returned takeover (attempt 2 of
 * the same node execution, its `retry_context` the recorded intervention).
 */
async function expectAttemptCountAtLeast(
  page: Page,
  runId: string,
  nodeId: string,
  n: number,
  timeoutMs: number,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const body = (await (await page.request.get(`/api/v1/runs/${runId}/nodes`)).json()) as {
          node_executions: Array<{ node_id: string; attempt_count: number }>;
        };
        return body.node_executions.some(
          (node) => node.node_id === nodeId && node.attempt_count >= n,
        );
      },
      { timeout: timeoutMs },
    )
    .toBeTruthy();
}

/**
 * Poll the nodes API until the execution named by `instanceKey` has attempt
 * `n` reach a TERMINAL status — the completion of the factory's re-run
 * (attempt 2 after a returned takeover). Returns the terminal status it
 * observed, so the evidence line can say the run's own word (succeeded or
 * failed on the review's verdict — both are the re-run having run).
 */
async function expectAttemptTerminal(
  page: Page,
  runId: string,
  instanceKey: string,
  n: number,
  timeoutMs: number,
): Promise<string> {
  const TERMINAL = new Set(["succeeded", "failed", "cancelled", "interrupted"]);
  const deadline = Date.now() + timeoutMs;
  let last = "";
  for (;;) {
    try {
      const body = (await (await page.request.get(`/api/v1/runs/${runId}/nodes`)).json()) as {
        node_executions: Array<{ id: string; node_instance_key: string }>;
      };
      const row_ = body.node_executions.find((node) => node.node_instance_key === instanceKey);
      if (row_) {
        const detail = (await (
          await page.request.get(`/api/v1/runs/${runId}/nodes/${row_.id}`)
        ).json()) as {
          attempts?: Array<{ attempt_number: number; status: string }>;
        };
        const target = (detail.attempts ?? []).find((attempt) => attempt.attempt_number === n);
        if (target && TERMINAL.has(target.status)) return target.status;
        last = `${instanceKey} attempt ${n}: ${target ? target.status : "not queued yet"}`;
      } else {
        last = `no execution ${instanceKey} yet`;
      }
    } catch (error) {
      last = `poll error: ${error}`;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `attempt ${n} of ${instanceKey} never went terminal within ${timeoutMs}ms (last: ${last})`,
      );
    }
    await page.waitForTimeout(3_000);
  }
}

/**
 * Close a context, tolerating Playwright's own trace-copy race on close:
 * with `trace: "retain-on-failure"` the close copies the recorded
 * `.network` files, and a long-lived context can lose the copy to its own
 * cleanup (ENOENT copyfile …-pwnetcopy-…) — a harness artifact race, not a
 * journey failure. Anything else is rethrown.
 */
async function closeContext(context: { close: () => Promise<void> }): Promise<void> {
  try {
    await context.close();
  } catch (error) {
    if (/_wrapApiCall: ENOENT.*copyfile.*\.network/.test(String(error))) {
      console.log(
        `WORKBENCH: context close raced its own trace copy — ${String(error).split("\n")[0]}`,
      );
      return;
    }
    throw error;
  }
}

/**
 * State shared across the serial journey steps: which pipeline the run's
 * revision belongs to, where the run lives, and the ACP node's flow id.
 */
const state: {
  pipelineSlug: string;
  runUrl: string;
  acpSlug: string;
  revisionDigest: string;
} = {
  pipelineSlug: FALLBACK_SLUG,
  runUrl: "",
  acpSlug: "",
  revisionDigest: "",
};

test.describe.serial("issue2 workbench (A4 A5 A6 + reload + narrow)", () => {
  test.skip(
    !ISSUE2_ENABLED,
    "requires the M4 lab (COMMUNICATION_E2E_ISSUE2=1, E2E_BASE_URL=http://localhost:15173)",
  );
  test.use({ viewport: { width: 1500, height: 950 } });

  test("setup: revision, assignment, members bob/carol, start the run", async ({
    page,
    browser,
  }) => {
    test.setTimeout(600_000); // assignment pin + member forms + run start, all bounded waits
    console.log(`issue2-workbench: run stamp ${STAMP}`);
    await signIn(page, ADMIN);

    // The studio spec's published revision — the acceptance run always runs
    // studio first and its publish step records it.
    let published: {
      pipelineId?: string;
      revisionId?: string;
      revisionDigest?: string;
      pipelineSlug?: string;
    };
    try {
      published = JSON.parse(await readFile(PUBLISHED_PATH, "utf8"));
    } catch {
      published = {};
    }
    // The studio spec records { pipelineId, revisionDigest, pipelineSlug };
    // an older shape recorded revisionId. Either names the studio revision —
    // the assignment flow below pins the newest published one either way.
    const revisionRef = published.revisionDigest ?? published.revisionId ?? null;
    if (published.pipelineId && revisionRef) {
      state.pipelineSlug = published.pipelineSlug ?? FALLBACK_SLUG;
      state.revisionDigest = published.revisionDigest ?? "";
      console.log(`WORKBENCH setup: using studio-published revision ${revisionRef}`);
    } else {
      throw new Error(
        `WORKBENCH setup: ${PUBLISHED_PATH} is absent or incomplete — run issue2-studio.spec.ts first (it publishes the pipeline with the agent.acp code_review step)`,
      );
    }

    // bob and carol must exist in the user directory before the member form
    // can offer them: one throwaway sign-in each (also gives them a readable
    // display name, which the journey asserts on).
    for (const member of [BOB, CAROL]) {
      const context = await browser.newContext();
      const memberPage = await context.newPage();
      await signIn(memberPage, member.subject, {
        name: member.name,
        email: `${member.subject}@lab.example`,
      });
      await context.close();
    }

    const projectPath = await openProjectBySlug(page, PROJECT_SLUG);
    const projectId = projectPath.split("/")[2];

    // The run must start from the studio-published revision. The project's
    // existing assignment is pinned to an OLDER revision (r1, which has no
    // agent.acp code_review step), so new runs would start there and the whole
    // ACP journey would hang on a node that never exists. Re-pin the assignment
    // to the exact published revision. This is a SETUP call: the run itself is
    // started through the UI below, so this is preparation, not the journey.
    // `page.request` shares the signed-in session and echoes the CSRF token the
    // app's apiFetch does (from GET /api/v1/me).
    await repinAssignment(page, projectId, published.pipelineId as string, state.revisionDigest);

    // The assignment's "when to run" block proves the row is live on the tab.
    await page.goto(`${projectPath}/pipelines`);
    await expect(page.getByTestId("project-pipelines")).toBeVisible();
    await expect(page.getByTestId(`schedules-block-${state.pipelineSlug}`)).toBeVisible({
      timeout: NODE_STEP_TIMEOUT_MS,
    });

    // Members: bob as contributor, carol as viewer (idempotent add-OR-update,
    // with a bounded re-click on the collapsed add form). The shared helper's
    // one-shot toggle click can lose a re-render race on a heavy project page
    // (many runs / attention items from repeated acceptance runs), so the
    // setup wraps each call in a bounded reload-retry — the helper is
    // idempotent, so a reload + retry is safe and stays inside this spec.
    for (const [name, role] of [
      [BOB.name, "contributor"],
      [CAROL.name, "viewer"],
    ] as const) {
      for (let attempt = 0; ; attempt += 1) {
        try {
          await setMember(page, projectPath, name, role);
          break;
        } catch (error) {
          if (attempt >= 2) throw error;
          console.log(
            `WORKBENCH setup: setMember(${name}, ${role}) flaked (attempt ${attempt + 1}) — reloading and retrying: ${String(error).split("\n")[0]}`,
          );
          await page.goto(projectPath);
          await page.waitForTimeout(1_500);
        }
      }
    }

    // Start the run from the project's New run flow. The form defaults to its
    // FIRST assignment, so the studio-pinned one must be picked explicitly —
    // robustly, and proven by the goal input the deterministic revision shows.
    await page.goto(`${projectPath}/runs`);
    await page.getByTestId("runs-new").click();
    await selectPipelineAssignment(page, state.pipelineSlug);
    await page.getByTestId("new-run-input-goal").fill(`issue2 acceptance ${STAMP}`);
    const repo = page.getByTestId("new-run-input-repository");
    const repoChoice = repo.locator("option").nth(1);
    await expect(repoChoice).toBeAttached({ timeout: NODE_STEP_TIMEOUT_MS });
    await repo.selectOption((await repoChoice.getAttribute("value")) ?? "");
    await page.getByTestId("new-run-input-fanout").check();
    await page.getByTestId("new-run-input-fanout_count").fill("14");
    await page.getByTestId("new-run-input-hold_seconds").fill("20");
    await page.getByTestId("new-run-submit").click();
    await page.waitForURL(/\/projects\/[0-9a-f-]{36}\/runs\/[0-9a-f-]{36}/, {
      timeout: NODE_STEP_TIMEOUT_MS,
    });
    state.runUrl = page.url();
    console.log(`WORKBENCH setup: run started at ${state.runUrl}`);
    await evidence(page, "wb-setup-run-started", "the run started with fanout=14, hold_seconds=20");
  });

  test("A4: graph-first run page, dock on the active node, approval, live ACP", async ({
    page,
  }) => {
    test.setTimeout(1_200_000); // gate wait + one real agent turn, both bounded
    await signIn(page, ADMIN);
    await openRun(page, state.runUrl);

    // The run page names the pinned revision — it must be the studio-published
    // one (the repin's proof), not the older revision without code_review.
    if (state.revisionDigest) {
      const digestShort = state.revisionDigest.startsWith("sha256:")
        ? state.revisionDigest.slice(7, 19)
        : state.revisionDigest.slice(0, 12);
      await expect(page.getByTestId("run-pinned-revision")).toContainText(digestShort, {
        timeout: NODE_STEP_TIMEOUT_MS,
      });
      console.log(`WORKBENCH A4: run pinned to the studio-published revision ${digestShort}`);
    }

    // The DEFAULT view is the graph: tab selected, canvas present, and the
    // definition table (the collapsed step list) is not the surface.
    await expect(page.getByTestId("workbench-tab-graph")).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".react-flow").first()).toBeVisible({
      timeout: NODE_STEP_TIMEOUT_MS,
    });
    const list = page.getByTestId("definition-graph-list");
    expect((await list.count()) === 0 || !(await list.first().isVisible())).toBeTruthy();

    // Auto-select: on first data the run's attention node is selected and the
    // dock shows it (the dock's title, not its empty state).
    await expect
      .poll(async () => new URL(page.url()).searchParams.get("node"), {
        timeout: NODE_STEP_TIMEOUT_MS,
      })
      .not.toBeNull();
    await expect(page.getByTestId("workbench-dock")).toBeVisible({
      timeout: NODE_STEP_TIMEOUT_MS,
    });
    await expect(page.getByTestId("workbench-dock-empty")).toHaveCount(0);
    await evidence(
      page,
      "wb-a4-graph-default",
      "the run page opens graph-first: graph tab selected, react-flow canvas visible (no definition table), the attention node auto-selected and docked",
    );
    await checkA11y(page, "workbench graph view");

    await clickNodeBox(page, "approve");
    const decision = page.getByTestId("approval-decision-form");
    await expect(decision).toBeVisible({ timeout: NODE_STEP_TIMEOUT_MS });
    await page.getByTestId("approval-approve").click();
    await expect(decision).toHaveCount(0, { timeout: NODE_STEP_TIMEOUT_MS });
    await evidence(
      page,
      "wb-a4-approval",
      "the approve human gate was selected in the graph and approved from the dock's approval card",
    );
    // The ACP step: the agent.acp the studio spec inserted (or any agent.acp
    // the revision has) runs live in the dock's conversation. Resolve the
    // slug NOW — before the poll — because the poll must start the moment the
    // gate clears: the code_review turn's running window is the only time A5's
    // takeover can interrupt a live attempt, and every second spent on
    // unrelated waits before the poll burns that window.
    state.acpSlug = (await findAcpSlug(page)) ?? "";
    console.log(
      `WORKBENCH A4: acpSlug=${state.acpSlug} at ${new Date().toISOString().slice(11, 19)}`,
    );
    if (!state.acpSlug) {
      throw new Error(
        "WORKBENCH A4: no agent.acp node in the run's graph — the run is not pinned to the studio-published revision (which inserts the agent.acp code_review step). Re-pin the assignment in setup; run issue2-studio.spec.ts first.",
      );
    }
    if (state.acpSlug !== "code_review") {
      throw new Error(
        `WORKBENCH A4: the studio-inserted code_review agent.acp step is absent from the run's graph (found ${state.acpSlug}) — the run is not pinned to the studio-published revision. Re-pin the assignment in setup.`,
      );
    }
    // Select the node only once its attempt is actually RUNNING. A click while
    // the attempt is still queued resolves to the dock's "agent has not started
    // yet" (the attempt has no conversation_id yet), and the node-detail query
    // refetches only on an SSE invalidation — so a queued pick can block until
    // the run moves on. Waiting on the ledger for a `running` attempt guarantees
    // the dock opens on the LIVE conversation (A4's transcript populates fast),
    // and — crucially for A5 — leaves the turn's running window open for the
    // takeover instead of A4 consuming it to completion.
    await expectRunningExecution(page, runIdOf(state.runUrl), state.acpSlug, NODE_STEP_TIMEOUT_MS);
    // NO assertion on the run-header status chip here: it is known-stale
    // (stuck on "queued" while the run is live; another worker is fixing it)
    // and waiting on it burned the code_review in-flight window the A5
    // takeover needs — the ledger's expectRunningExecution above is the
    // authoritative "in flight" signal.
    // The `code_review` row is journaled when the loop schedules it; a pick
    // before that resolves to an empty dock, so selectNode re-clicks.
    const tMark = (what: string) =>
      console.log(`WORKBENCH A4 step ${what} at ${new Date().toISOString().slice(11, 19)}`);
    tMark("before selectNode");
    await selectNode(page, state.acpSlug, NODE_STEP_TIMEOUT_MS);
    const dockConversation = page.getByTestId("dock-conversation");
    await expect(dockConversation).toBeVisible({ timeout: NODE_STEP_TIMEOUT_MS });
    tMark("dock visible, before transcript poll");
    await expect
      .poll(async () => dockConversation.locator('[data-testid="transcript-item"]').count(), {
        timeout: NODE_STEP_TIMEOUT_MS,
      })
      .toBeGreaterThan(0);
    tMark("transcript populated");
    await evidence(
      page,
      "wb-a4-acp-live",
      `the agent.acp node ${state.acpSlug} is selected and the dock shows its live conversation transcript (agent messages / tool events)`,
    );
    tMark("before a11y");
    await checkA11y(page, "workbench ACP dock");
    tMark("a11y done");
  });

  test("A5: bob takes control, carol read-only, factory takes back, timeline", async ({
    page,
    browser,
  }) => {
    test.setTimeout(1_800_000); // two real agent turns behind the takeover (bob's
    // prompt, then the factory's re-run), bounded
    test.skip(!state.acpSlug, "no agent.acp node in this revision — ACP handoff journey skipped");
    const runId = runIdOf(state.runUrl);

    // bob (contributor) is the one who takes control, so his sign-in +
    // open-run + poll run FIRST: the poll starts the moment bob's page is up,
    // not after admin/carol overhead. A code_review attempt is `running` for
    // the length of a real agent turn, so the poll waits for one that is
    // actually running (the ledger, not the wall clock) and only then does bob
    // select the node and take control immediately.
    const bobContext = await browser.newContext();
    const bob = await bobContext.newPage();
    await signIn(bob, BOB.subject, { name: BOB.name, email: `${BOB.subject}@lab.example` });
    await openRun(bob, state.runUrl);
    const runningKey = await expectRunningExecution(
      bob,
      runId,
      state.acpSlug,
      NODE_STEP_TIMEOUT_MS,
    );
    await selectNode(bob, state.acpSlug, NODE_STEP_TIMEOUT_MS);
    const bobDock = bob.getByTestId("dock-conversation");
    await expect(bobDock).toBeVisible({ timeout: NODE_STEP_TIMEOUT_MS });
    const take = bob.getByTestId("dock-take-control");
    await expect(take).toBeEnabled({ timeout: NODE_STEP_TIMEOUT_MS });
    await take.click();
    // The badge is written in words: on bob's own page it reads "You are in
    // control" (the name "Controlled by Bob" is what OTHER pages show).
    await expect(bob.getByTestId("dock-controller")).toContainText(/you are in control/i, {
      timeout: NODE_STEP_TIMEOUT_MS,
    });
    // The takeover interrupted the in-flight attempt: it closed
    // interrupted{human_takeover} and the run paused for exactly that reason
    // (contract § 5.3) — a takeover on a settled attempt would never pause.
    await expectPausedFor(bob, runId, "human_takeover", NODE_STEP_TIMEOUT_MS);
    // (No run-header-status chip assertion: the chip is known-stale while the
    // run is live — the ledger's paused_reason above and the timeline's
    // run.paused below are the authoritative words for the pause.)
    await evidence(
      bob,
      "wb-a5-bob-control",
      `bob (contributor) took control while ${runningKey} was running — the badge reads "You are in control" and the run is paused for human_takeover (the attempt was interrupted)`,
    );

    // carol (viewer): the same dock shows Take control disabled and no
    // enabled composer.
    const carolContext = await browser.newContext();
    const carol = await carolContext.newPage();
    await signIn(carol, CAROL.subject, { name: CAROL.name, email: `${CAROL.subject}@lab.example` });
    await openRun(carol, state.runUrl);
    await clickNodeBox(carol, state.acpSlug);
    await expect(carol.getByTestId("dock-conversation")).toBeVisible({
      timeout: NODE_STEP_TIMEOUT_MS,
    });
    await expect(carol.getByTestId("dock-take-control")).toBeDisabled();
    const carolInput = carol.getByTestId("dock-composer-input");
    await expect(carolInput).toBeDisabled();
    const carolExplainer = carol.getByTestId("dock-composer-explainer");
    if ((await carolExplainer.count()) > 0) {
      expect(await carolExplainer.first().isVisible()).toBeTruthy();
    }
    await evidence(
      carol,
      "wb-a5-carol-readonly",
      `carol (viewer) sees Take control disabled (with the composer explainer) and a disabled composer on the same ACP node`,
    );
    await checkA11y(carol, "workbench viewer (carol)");

    // bob prompts the agent; his message lands in the shared transcript, and
    // the turn is driven to completion: the takeover cancelled the attempt's
    // own turn (the dock shows its Stop button exactly while a turn is in
    // flight), so bob's composer enables once that turn has closed — then his
    // prompt starts the human's turn, and the Stop button's removal is the
    // word that the reply has landed (a real agent turn is 15–120 s, bounded
    // by AGENT_TURN_TIMEOUT_MS).
    const bobInput = bob.getByTestId("dock-composer-input");
    await expect(bobInput).toBeEnabled({ timeout: NODE_STEP_TIMEOUT_MS });
    await bobInput.fill("Please also check the README mentions add()");
    await bob.getByTestId("dock-composer-send").click();
    await expect
      .poll(async () => (await bobDock.textContent()) ?? "", { timeout: AGENT_TURN_TIMEOUT_MS })
      .toContain("Please also check the README mentions add()");
    // Count the transcript once bob's own prompt item is in: the reply is
    // whatever new item the agent appends after that (a real turn, not an
    // echo of the prompt).
    const transcriptAfterPrompt = await bob.getByTestId("transcript-item").count();
    await bob
      .getByTestId("dock-stop-turn")
      .waitFor({ state: "detached", timeout: AGENT_TURN_TIMEOUT_MS });
    // The agent's reply landed as a new transcript item in the shared dock.
    await expect
      .poll(async () => bob.getByTestId("transcript-item").count(), {
        timeout: AGENT_TURN_TIMEOUT_MS,
      })
      .toBeGreaterThan(transcriptAfterPrompt);

    // Return control to the factory. The return does the run's leg of the
    // handoff (contract § 5.3 / ADR-0016 § 5) in one transaction: it resumes
    // the paused run (run.resumed, clearing the human_takeover reason),
    // re-queues attempt 2 of the SAME node execution with the recorded
    // intervention as its retry_context, and hands the conversation's
    // control row back to the run — controller_kind='run_attempt', repointed
    // at the newly queued attempt. The SAME conversation carries on: a
    // re-run of the node execution rides the conversation attempt 1 opened.
    const back = bob.getByTestId("dock-return-control");
    await expect(back).toBeEnabled({ timeout: NODE_STEP_TIMEOUT_MS });
    await back.click();
    // The factory re-runs the node: the same execution gains attempt 2 (the
    // dock's attempt tabs read it straight off the node detail). Until the
    // worker claims it, attempt 2 holds no conversation of its own — the
    // stamp lands in the claim's transaction — so the badge assertion reads
    // the attempt 1 tab: the conversation bob actually drove, whose control
    // row the return just handed back to the run.
    await expect(bob.getByTestId("dock-attempt-2")).toBeVisible({
      timeout: NODE_STEP_TIMEOUT_MS,
    });
    await bob.getByTestId("dock-attempt-1").click();
    await expect(bob.getByTestId("dock-conversation")).toBeVisible({
      timeout: NODE_STEP_TIMEOUT_MS,
    });
    await expect(bob.getByTestId("dock-controller")).toContainText(
      /controlled by a pipeline run/i,
      {
        timeout: NODE_STEP_TIMEOUT_MS,
      },
    );
    // (No run-header-status chip assertion after the return either — same
    // stale-chip reason; run.resumed lands in the timeline read below.)
    // The re-run's own completion is the honest word that the factory took
    // the node back: attempt 2 of the execution bob took over is queued and
    // runs to its terminal. (Deliberately no in-flight-with-a-live-conversation
    // assertion here: the lab's claim path can race the earlier attempt's
    // turn terminal — "conversation still carries a non-terminal turn ...
    // contract § 4 step 12's pairing" — and fail the re-run's claim with an
    // infra error before it ever goes in flight. The terminal wait absorbs
    // that backend flake: a fast infra-failed attempt 2 is still the terminal
    // the re-run reached.)
    await expectAttemptCountAtLeast(bob, runId, state.acpSlug, 2, NODE_STEP_TIMEOUT_MS);
    const settled = await expectAttemptTerminal(bob, runId, runningKey, 2, NODE_STEP_TIMEOUT_MS);
    await evidence(
      bob,
      "wb-a5-returned",
      `bob returned control to the factory — on the conversation he drove (attempt 1 tab) the badge names the pipeline run, the run resumed (not paused), and a NEW attempt (attempt 2) of ${state.acpSlug} was queued and reached ${settled} (attempt tabs: 1 + 2)`,
    );

    // The event timeline lists the takeover and the return: the takeover
    // paused the run (run.paused, paused_reason human_takeover, actor bob)
    // and the return resumed it (run.resumed) — the journal's words for the
    // handoffs. admin keeps the run open on the main page for the read.
    await signIn(page, ADMIN);
    await openRun(page, state.runUrl);
    await page.getByTestId("workbench-tab-timeline").click();
    const feed = page.getByTestId("run-timeline");
    await expect(feed).toBeVisible({ timeout: NODE_STEP_TIMEOUT_MS });
    await expect(feed).toContainText("run.paused", { timeout: NODE_STEP_TIMEOUT_MS });
    await expect(feed).toContainText("run.resumed", { timeout: NODE_STEP_TIMEOUT_MS });
    await expect(feed).toContainText(new RegExp(BOB.name, "i"), { timeout: NODE_STEP_TIMEOUT_MS });
    await evidence(
      page,
      "wb-a5-timeline",
      "the workbench timeline lists the control handoffs — run.paused (human_takeover) and run.resumed with bob as actor",
    );

    await closeContext(bobContext);
    await closeContext(carolContext);
  });

  test("A6: exec details, approval decision, until instances, fan-out, attempts", async ({
    page,
  }) => {
    test.setTimeout(2_400_000); // the terminal wait dominates (bounded, never open-ended)
    await signIn(page, ADMIN);
    await openRun(page, state.runUrl);
    await expect(page.locator(".react-flow").first()).toBeVisible({
      timeout: NODE_STEP_TIMEOUT_MS,
    });
    const canvasNodes = () =>
      page.locator('[data-testid="workbench-graph-frame"] .react-flow__node').count();
    const before = await canvasNodes();
    expect(before, "the canvas must show step nodes").toBeGreaterThan(0);

    // Reload mid-run: the selection from the URL is restored and the stream
    // is live again.
    await clickNodeBox(page, "approve");
    expect(new URL(page.url()).searchParams.get("node")).toBe("approve");
    await page.reload();
    await expect(page.getByTestId("workbench")).toBeVisible({ timeout: NODE_STEP_TIMEOUT_MS });
    expect(new URL(page.url()).searchParams.get("node"), "selection must survive the reload").toBe(
      "approve",
    );
    await expect(page.getByTestId("dock-title")).toBeVisible({ timeout: NODE_STEP_TIMEOUT_MS });
    await expect(page.getByTestId("run-stream-status")).toContainText(/live|reconnecting/i, {
      timeout: 60_000,
    });
    console.log("WORKBENCH A6: mid-run reload restored the approve selection and a live stream");

    // A process.exec node: the dock shows its exit code and captured output.
    await clickNodeBox(page, "test");
    await expect(page.getByTestId("attempt-exit-code")).toBeVisible({
      timeout: NODE_STEP_TIMEOUT_MS,
    });
    await evidence(
      page,
      "wb-a6-exec",
      "a process.exec node (test) is selected; the dock shows its exit code and captured stdout/stderr",
    );

    // The approval node: the decision the card records after A4's approve.
    await clickNodeBox(page, "approve");
    await expect(page.getByTestId("approval-summary")).toBeVisible({
      timeout: NODE_STEP_TIMEOUT_MS,
    });

    // The until scope's instance picker: at least the two deterministic
    // iterations (the journal keys them [1], [2] — until iterations are
    // 1-based, ADR-0023 § 1); picking iteration 1 vs iteration 2 changes the
    // dock, which must be on an in-scope node to follow the pick.
    await clickNodeBox(page, "test");
    const untilPicker = page.getByTestId("instance-picker-build_until_verified");
    await expect(untilPicker).toBeVisible({ timeout: NODE_STEP_TIMEOUT_MS });
    const untilChips = untilPicker.locator("button", { hasText: /^Iteration \d+ ·/ });
    await expect
      .poll(async () => untilChips.count(), { timeout: NODE_STEP_TIMEOUT_MS })
      .toBeGreaterThanOrEqual(2);
    const instanceLine = () => page.getByTestId("dock-instance-line").textContent();
    await untilChips
      .filter({ hasText: /^Iteration 1 ·/ })
      .first()
      .click();
    await expect
      .poll(async () => (await instanceLine()) ?? "", { timeout: NODE_STEP_TIMEOUT_MS })
      .toContain("iteration 1");
    const line1 = (await instanceLine()) ?? "";
    await evidence(page, "wb-a6-iter1", `the until scope's picker selects iteration 1 — ${line1}`);
    await untilChips
      .filter({ hasText: /^Iteration 2 ·/ })
      .first()
      .click();
    await expect
      .poll(async () => (await instanceLine()) ?? "", { timeout: NODE_STEP_TIMEOUT_MS })
      .not.toContain("iteration 1");
    const line2 = (await instanceLine()) ?? "";
    expect(line2, "the dock must change between iterations").not.toBe(line1);
    await evidence(page, "wb-a6-iter2", `the until scope's picker selects iteration 2 — ${line2}`);

    // The for_each fan-out: 14 items with per-state counts; select several.
    // The journal keys the items 0-based (`/fan_out[0]` … `/fan_out[13]`),
    // and the picker's chips read the raw index: chips 1–13 are the live
    // items (chip 14 is the declared slot). A pick alone does not move the
    // dock away from another scope's node — the in-scope node box (`invoke`)
    // is what resolves the picked item into the dock.
    const fanPicker = page.getByTestId("instance-picker-fan_out");
    await expect(fanPicker).toBeVisible({ timeout: NODE_STEP_TIMEOUT_MS });
    await expect(fanPicker).toContainText(/14 items/);
    const fanChips = fanPicker.locator("button", { hasText: /^Item \d+ ·/ });
    await expect
      .poll(async () => fanChips.count(), { timeout: NODE_STEP_TIMEOUT_MS })
      .toBeGreaterThanOrEqual(14);
    const fanLine = () => page.getByTestId("dock-instance-line").textContent();
    for (const item of [1, 2, 3, 4]) {
      await fanChips
        .filter({ hasText: new RegExp(`^Item ${item} ·`) })
        .first()
        .click();
      await clickNodeBox(page, "invoke");
      await expect
        .poll(async () => (await fanLine()) ?? "", { timeout: NODE_STEP_TIMEOUT_MS })
        .toContain(`iteration ${item}`);
    }
    const fanPage = fanPicker.getByTestId("instance-fan_out-page");
    if ((await fanPage.count()) > 0) {
      expect(await fanPage.textContent()).toContain(" of ");
    }
    await evidence(
      page,
      "wb-a6-fanout",
      "the for_each scope shows 14 items with per-state counts; items 1-4 were selected and the dock followed the picks",
    );

    // Item 13 (journal index 12, picker chip "Item 12") is the child that
    // exits 1. The retry lives in the CHILD run — the child's implement step
    // retries the infra failure (maxAttempts 2) — while the parent's invoke
    // row is a control-plane decision ("attempt 0 of 1"). Follow the dock's
    // "Open child run" link and read the attempts there: the child's step
    // shows attempt tabs or an "attempt k of m" greater than one attempt.
    await fanChips
      .filter({ hasText: /^Item 12 ·/ })
      .first()
      .click();
    await clickNodeBox(page, "invoke");
    const childLink = page.getByTestId("dock-child-run-link");
    await expect(childLink).toBeVisible({ timeout: NODE_STEP_TIMEOUT_MS });
    await childLink.click();
    await expect(page.getByTestId("workbench")).toBeVisible({ timeout: NODE_STEP_TIMEOUT_MS });
    await selectNode(page, "implement", NODE_STEP_TIMEOUT_MS);
    await expect
      .poll(
        async () => {
          const tabs = await page.getByTestId(/^dock-attempt-\d+$/).count();
          const countLine = page.getByTestId("dock-attempt-count");
          const text = (await countLine.count()) > 0 ? ((await countLine.textContent()) ?? "") : "";
          const of = /of (\d+)/.exec(text);
          return Math.max(tabs, of ? Number(of[1]) : 0);
        },
        { timeout: NODE_STEP_TIMEOUT_MS },
      )
      .toBeGreaterThan(1);
    await evidence(
      page,
      "wb-a6-attempts",
      "fan-out item 13 (the child that exits 1) — its child run's implement step shows more than one attempt — attempt tabs or 'attempt k of m' with m > 1",
    );

    // Back to the run's own graph for the node-count guard: the graph never
    // grows extra definition nodes from run instances.
    await page.goto(state.runUrl);
    await expect(page.locator(".react-flow").first()).toBeVisible({
      timeout: NODE_STEP_TIMEOUT_MS,
    });
    const after = await canvasNodes();
    expect(after, "the canvas's node count must not grow with run instances").toBe(before);

    // Terminal state: completed, or failed because of item 13 — either is
    // acceptable; log which one the run reached.
    await expectRunStatus(page, /completed|failed|cancelled|interrupted/i, TERMINAL_TIMEOUT_MS);
    const terminal = (await page.getByTestId("run-header-status").textContent()) ?? "";
    console.log(`WORKBENCH A6: run reached terminal state: ${terminal.trim()}`);
  });

  test("narrow 390x844: graph then dock as a sheet, no horizontal scroll", async ({ page }) => {
    test.setTimeout(300_000);
    await signIn(page, ADMIN);
    await page.setViewportSize({ width: 390, height: 844 });
    await openRun(page, state.runUrl);
    // Graph on top; the dock sits below the graph as a full-width sheet with
    // its own back-to-graph control, not the desktop side pane.
    await expect(page.locator(".react-flow").first()).toBeVisible({
      timeout: NODE_STEP_TIMEOUT_MS,
    });
    await expect(page.getByTestId("workbench-dock-panel")).toBeVisible({
      timeout: NODE_STEP_TIMEOUT_MS,
    });
    await expect(page.getByTestId("workbench-dock-back")).toBeVisible();
    expect(await page.getByTestId("workbench-dock-pane").count()).toBe(0);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      "no horizontal scroll at 390px",
    ).toBeTruthy();
    await evidence(
      page,
      "wb-narrow",
      "at 390x844 the workbench is the graph with the dock below it as a sheet (back-to-graph control) and no horizontal scroll",
    );
    await checkA11y(page, "narrow workbench");
  });
});
