// Issue #2 acceptance journeys for the graph-first Workflow Studio:
// A0 (open the deterministic twin in the Studio), A1 (insert an ACP reviewer
// on the test → review edge inside the until scope), A2 (add three steps,
// multi-select them, wrap them in a Repeat until from the selection toolbar,
// validate, diff, publish and reopen the revision), A3 (drag-to-insert with
// undo/redo and the ambiguity dialog on a guarded edge) and A8 (assistant
// drafting proposal), plus the narrow (390x844) layout.
//
// It runs against the M4 lab ONLY when COMMUNICATION_E2E_ISSUE2=1 — skipped
// everywhere else, the same env-gate idiom as the sibling issue2 spec:
//   COMMUNICATION_E2E_ISSUE2=1 E2E_BASE_URL=http://localhost:15173 \
//     pnpm exec playwright test tests/issue2-studio.spec.ts
// (15173 is the Vite dev server serving the live working-tree UI against the
// lab backend; the lab's own :18091 UI is an older build.)
// The seeded pipeline `feature-development-deterministic` drives everything:
// process.exec nodes only, so no real agent turns happen and no
// AGENT_TURN_TIMEOUT_MS waits are needed.
//
// Every journey step calls the local `evidence()`: a full-page screenshot
// into ${E2E_EVIDENCE_DIR ?? "test-results/issue2"}/<name>.png plus one
// console line `EVIDENCE <name>: <what it proves>`.
//
// Re-run safety: A2 PUBLISHES a customized revision (code_review + a
// trailing until scope), and a published draft becomes read-only. So
// (a) whenever a previous run already did that, A0 first restores the seeded
// twin as the newest published revision — the seeded document plus ONE
// metadata line (a stamped description; the node graph stays byte-identical),
// because a bare republish of the pristine document is a 409 (its digest is
// already published) — and (b) A3 works in its own fresh draft cloned after
// A2's publish.
//
// Accessibility: each main screen (Studio desktop + narrow) runs a real axe
// audit via `checkA11y` (tests/a11y.ts) with the wcag2a + wcag2aa tags; the
// run fails only on serious/critical impact and the full result JSON is
// attached to the test report.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { AGENT_TURN_TIMEOUT_MS } from "./env.js";
import { checkA11y } from "./a11y.js";
import { gotoApp, signIn } from "./helpers.js";

const ISSUE2_ENABLED = process.env.COMMUNICATION_E2E_ISSUE2 === "1";
/** Unique per run so re-runs never collide with their own earlier rows. */
const STAMP = process.env.E2E_ISSUE2_STAMP ?? Date.now().toString(36);
const PIPELINE_SLUG = "feature-development-deterministic";
const EVIDENCE_DIR = process.env.E2E_EVIDENCE_DIR ?? "test-results/issue2";

/** One piece of journey evidence: a screenshot plus a single log line. */
async function evidence(page: Page, name: string, what: string): Promise<void> {
  await mkdir(EVIDENCE_DIR, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCE_DIR, `${name}.png`), fullPage: true });
  console.log(`EVIDENCE ${name}: ${what}`);
}

/** Resolve a pipeline in the org library by slug (no list UI: `/library` is the create form). */
async function pipelineInfo(
  page: Page,
  slug: string,
): Promise<{ id: string; revision_count: number }> {
  const res = await page.request.get("/api/v1/pipelines");
  expect(res.status(), "the org library must be readable").toBe(200);
  const body = (await res.json()) as Record<string, unknown>;
  const list = (Array.isArray(body.pipelines) ? body.pipelines : body.items) as
    | Array<Record<string, unknown>>
    | undefined;
  const pipeline = list?.find((p) => p.slug === slug) as
    | { id: string; slug: string; revision_count: number }
    | undefined;
  expect(pipeline, `pipeline ${slug} must exist in the library`).toBeTruthy();
  return pipeline as { id: string; revision_count: number };
}

/** The server-side draft version — what the version-checked contract counts. */
async function draftVersion(page: Page, draftId: string): Promise<number> {
  const res = await page.request.get(`/api/v1/drafts/${draftId}`);
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { version: number };
  return body.version;
}

/** The Studio's own YAML textarea (the draft text exactly as the Studio holds it). */
async function readYaml(page: Page): Promise<string> {
  await page.getByTestId("studio-view-yaml").click();
  return page.getByTestId("studio-yaml").inputValue();
}

/** `GET /api/v1/revisions/{digestOrId}/document?format=yaml` — a revision's canonical YAML. */
async function revisionDocument(page: Page, digestOrId: string): Promise<string> {
  const res = await page.request.get(`/api/v1/revisions/${digestOrId}/document?format=yaml`);
  expect(res.status()).toBe(200);
  return res.text();
}

/** True when some `dependsOn` list (flow `[a, b]` or block `- a`) names `dep`. */
function yamlDependsOn(yaml: string, dep: string): boolean {
  if (new RegExp(`dependsOn:\\s*\\[[^\\]]*\\b${dep}\\b[^\\]]*\\]`).test(yaml)) return true;
  const blocks = yaml.match(/dependsOn:\s*\n((?:[ \t]*- [^\n]+\n?)+)/g) ?? [];
  const item = new RegExp(`^[ \\t]*- ${dep}[ \\t]*$`, "m");
  return blocks.some((b) => item.test(b));
}

async function backToCanvas(page: Page): Promise<void> {
  await page.getByTestId("studio-view-canvas").click();
  await expect(page.getByTestId("studio-canvas")).toBeVisible();
}

/** State passed between the serial journey steps (one browser, one session). */
const state: {
  pipelineId: string;
  draftId: string;
  draftUrl: string;
  /** A3's own fresh draft (A2's publish locks the journey draft read-only). */
  draftA3: string;
  untilId: string;
  revisionNumber: number;
} = { pipelineId: "", draftId: "", draftUrl: "", draftA3: "", untilId: "", revisionNumber: 0 };

test.describe.serial("issue2 studio (A0 A1 A2 A3 A8 + narrow)", () => {
  test.skip(
    !ISSUE2_ENABLED,
    "requires the M4 lab (COMMUNICATION_E2E_ISSUE2=1, E2E_BASE_URL=http://localhost:15173)",
  );
  test.use({ viewport: { width: 1500, height: 950 } });

  test("A0: open the deterministic twin draft in the Studio", async ({ page }) => {
    console.log(`issue2-studio: run stamp ${STAMP}`);
    await signIn(page, "admin");
    await gotoApp(page, "/library");
    const pipeline = await pipelineInfo(page, PIPELINE_SLUG);
    state.pipelineId = pipeline.id;

    await page.goto(`/library/${pipeline.id}`);
    await expect(page.getByTestId("pipeline-page")).toBeVisible();
    await expect(page.getByTestId("pipeline-header-meta")).toContainText(PIPELINE_SLUG);

    // Re-run safety: a previous run of this journey published a customized
    // revision (code_review + the trailing until scope). The newest revision
    // is the diff's base, so when it already carries code_review, restore the
    // seeded twin first. The pristine document cannot be republished bare —
    // its digest is already a published revision, and the publish gate
    // answers 409 — so the restored document is the seeded one plus ONE
    // metadata line: the description carries this run's stamp. The node
    // graph stays byte-identical, and the new digest makes the restoration
    // publishable. Done through the Studio's own YAML view.
    const revRes = await page.request.get(`/api/v1/pipelines/${pipeline.id}/revisions`);
    expect(revRes.status()).toBe(200);
    const revBody = (await revRes.json()) as {
      revisions?: Array<{ revision_digest: string }>; // summaries carry the digest, not an id
    };
    const revisions = revBody.revisions ?? [];
    expect(revisions.length, "the seeded twin must have at least one revision").toBeGreaterThan(0);
    const newestDoc = await revisionDocument(page, revisions[0].revision_digest);
    if (newestDoc.includes("id: code_review")) {
      const seededDocRaw = await revisionDocument(
        page,
        revisions[revisions.length - 1].revision_digest,
      );
      const seededDoc = seededDocRaw.replace(
        /^([ \t]*description: .*)$/m,
        (line) => `${line} (re-stored ${STAMP})`,
      );
      expect(seededDoc, "the stamp must land on the description line").not.toBe(seededDocRaw);
      await page.getByTestId("pipeline-new-draft").click();
      await expect(page).toHaveURL(new RegExp(`/library/${pipeline.id}/drafts/`));
      await expect(page.getByTestId("studio-canvas")).toBeVisible();
      await page.getByTestId("studio-view-yaml").click();
      await page.getByTestId("studio-yaml").fill(seededDoc);
      await page.getByTestId("studio-save").click();
      await expect(page.getByTestId("studio-dirty")).toHaveCount(0, { timeout: 30_000 });
      await page.getByTestId("studio-validate").click();
      const restoreVerdict = page.getByTestId("studio-validate-verdict");
      await expect(restoreVerdict).toBeVisible();
      expect((await restoreVerdict.textContent()) ?? "").toMatch(/^valid/);
      await page.getByTestId("studio-publish").click();
      await expect(page.getByTestId("studio-published")).toBeVisible();
      await evidence(
        page,
        "studio-rerun-restored",
        `a previous journey run had published a customized revision — the seeded twin (oldest revision's document, description stamped "re-stored ${STAMP}" so the digest is fresh) was restored through the Studio and republished as the newest revision, so the journey runs on the pristine twin again`,
      );
      await page.goto(`/library/${pipeline.id}`);
      await expect(page.getByTestId("pipeline-page")).toBeVisible();
    }

    // New draft: the pipeline page's clone control, built from the newest revision.
    await page.getByTestId("pipeline-new-draft").click();
    await expect(page).toHaveURL(new RegExp(`/library/${pipeline.id}/drafts/`));
    state.draftUrl = new URL(page.url()).href;
    state.draftId = state.draftUrl.split("/").pop() as string;

    // The Studio opens on the graph canvas — not a YAML textarea.
    await expect(page.getByTestId("studio-canvas")).toBeVisible();
    expect(await page.locator(".react-flow").count()).toBeGreaterThan(0);
    expect(await page.getByTestId("studio-yaml").count()).toBe(0);
    // The seeded until scope is on the canvas as its own box.
    await expect(page.getByTestId("canvas-scope-build_until_verified")).toBeVisible();
    await checkA11y(page, "studio (A0)");
    await evidence(
      page,
      "studio-loaded",
      `Studio opened on a fresh draft of ${PIPELINE_SLUG} cloned from its newest revision — the graph canvas (with the seeded build_until_verified scope) is on stage, not a YAML textarea`,
    );
  });

  test("A1: insert an ACP reviewer between test and review on the edge", async ({ page }) => {
    await signIn(page, "admin");
    await gotoApp(page, state.draftUrl);
    await expect(page.getByTestId("studio-canvas")).toBeVisible();

    // The "+" on the test → review edge (inside the until scope) opens the step picker.
    await page.getByTestId("edge-add-test-review").click();
    const picker = page.getByTestId("step-picker");
    await expect(picker).toBeVisible();
    await page.getByTestId("step-picker-item-agent.acp").click();

    // The new node is selected between them: the inspector now names it.
    const nodeIdField = page.getByTestId("insp-node-id");
    await expect(nodeIdField).toBeVisible();
    const autoId = await nodeIdField.inputValue();
    expect(autoId, "the inserted node is auto-named, not code_review yet").not.toBe("code_review");
    await expect(page.getByTestId("canvas-step-test")).toBeVisible();
    await expect(page.getByTestId("canvas-step-review")).toBeVisible();

    // Inspector-only configuration: profile, prompt, on-failure, then the id
    // rename LAST — the rename commit drops the node selection (the inspector
    // falls back to the pipeline level), so no further field may follow it.
    await page.getByTestId("insp-profile").selectOption("m4-reviewer");
    // A DETERMINISTIC long turn: the A5 takeover journey takes control WHILE a
    // code_review attempt is running, and a turn that settles in ~20 s is
    // already over by the time bob signs in and clicks — racing the window
    // fails. m4-reviewer runs preapproved_within_sandbox, so an explicit wait
    // runs without a permission prompt. A plain `sleep 90` is BLOCKED by the
    // sandbox's Bash guardrail ("Blocked: standalone sleep 90 … do not chain
    // shorter sleeps"), and the agent then either skips it (turn ~20 s) or
    // backgrounds it (turn ~10 s, INVALID_OUTPUT). The guardrail's own
    // sanctioned wait is a foreground Monitor until-loop (`until <check>; do
    // sleep 2; done`), so the prompt uses exactly that: a time-bounded until
    // loop that blocks the turn for ~90 s. Every code_review turn therefore
    // stays in flight for at least 90 s, and A5's poll (ledger, not wall
    // clock) plus bob's select + Take control land comfortably inside the
    // window instead of racing the turn's remaining seconds.
    const prompt =
      'First wait about 90 seconds before you review, so this turn stays open: run this exact shell command in the FOREGROUND and wait for it to finish — end=$(( $(date +%s) + 90 )); until [ $(date +%s) -ge $end ]; do sleep 2; done — this is the allowed Monitor until-loop (a standalone `sleep 90` is blocked, so do not use one and do not run the loop in the background). Once it completes, review the diff for the add() fix and answer JSON {"approved": true|false, "evidence": "…"}';
    await page.getByTestId("insp-config-prompt").fill(prompt);
    await page.getByTestId("insp-config-prompt").blur();
    // The "following route" is configurable: on failure → continue.
    await page.getByTestId("insp-onFailure-onExecutionError").selectOption("continue");
    await nodeIdField.fill("code_review");
    await nodeIdField.press("Enter");
    await page.waitForTimeout(300);
    await evidence(
      page,
      "studio-a1-inserted",
      `agent.acp node ${autoId} inserted on the test → review edge and configured entirely in the inspector: profile m4-reviewer, review prompt, id code_review, on-failure continue`,
    );

    // Save so the insertion persists: the Studio keeps edits in memory until
    // saved (no autosave), and the next journey reloads the draft from the
    // server. Wait for the dirty marker to clear before leaving the page.
    await page.getByTestId("studio-save").click();
    await expect(page.getByTestId("studio-dirty")).toHaveCount(0, { timeout: 30_000 });

    const yaml = await readYaml(page);
    expect(yaml).toContain("id: code_review");
    expect(yaml).toContain("kind: agent.acp");
    expect(yaml).toContain("profile: m4-reviewer");
    expect(yamlDependsOn(yaml, "code_review"), "review must now depend on code_review").toBe(true);
    expect(yaml).toContain("onExecutionError: continue");
    await evidence(
      page,
      "studio-a1-yaml",
      "YAML view proves the inspector's work: id: code_review (kind agent.acp, profile m4-reviewer), review's dependsOn now names code_review, on-failure continue — untouched by any YAML editing",
    );
  });

  test("A1b: desktop inspector a11y with an agent.acp and a process.exec node selected", async ({
    page,
  }) => {
    await signIn(page, "admin");
    await gotoApp(page, state.draftUrl);
    await expect(page.getByTestId("studio-canvas")).toBeVisible();

    // The agent.acp node A1 inserted (code_review) and its process.exec
    // sibling (review): audit the inspector for each, so the generated
    // field widgets (profile/prompt for agent.acp, args/env/retry for
    // process.exec) are both covered by the axe pass.
    await page.getByTestId("canvas-step-code_review").click();
    await expect(page.getByTestId("insp-node")).toBeVisible();
    await expect(page.getByTestId("insp-node-id")).toHaveValue("code_review");
    await checkA11y(page, "studio inspector (agent.acp)");

    await page.getByTestId("canvas-step-review").click();
    await expect(page.getByTestId("insp-node-id")).toHaveValue("review");
    await checkA11y(page, "studio inspector (process.exec)");
    await evidence(
      page,
      "studio-a1b-inspector-a11y",
      "desktop inspector audited by axe with the agent.acp node (code_review) and the process.exec node (review) selected one at a time — zero serious/critical on both",
    );
  });

  test("A2: wrap steps in Repeat until, validate, diff, publish, reopen", async ({ page }) => {
    await signIn(page, "admin");
    await gotoApp(page, state.draftUrl);
    await expect(page.getByTestId("studio-canvas")).toBeVisible();

    const lastTerminal = "publish_needs_attention";
    // Canvas step nodes are `canvas-step-<id>`; the step-list panel adds
    // `canvas-step-row-<id>` and a `canvas-step-list` wrapper, which are
    // filtered out in-page (a CSS `:not()` with nested quotes is rejected by
    // Playwright's selector parser).
    const stepIds = (): Promise<string[]> =>
      page.evaluate(() => {
        const out: string[] = [];
        for (const el of document.querySelectorAll<HTMLElement>("[data-testid]")) {
          const t = el.dataset.testid ?? "";
          if (
            t.startsWith("canvas-step-") &&
            !t.startsWith("canvas-step-row-") &&
            t !== "canvas-step-list"
          ) {
            out.push(t.slice("canvas-step-".length));
          }
        }
        return out;
      });

    /** Add one step of `kind` after `afterId` via the canvas "+" and return its auto id. */
    const addStep = async (afterId: string, kind: string): Promise<string> => {
      const before = new Set(await stepIds());
      await page.getByTestId(`add-after-${afterId}`).click();
      await page.getByTestId(`step-picker-item-${kind}`).click();
      const added = (await stepIds()).filter((id) => !before.has(id));
      expect(added.length, `the ${kind} picker item must create exactly one new step`).toBe(1);
      return added[0];
    };

    // 1) Three steps after the last terminal step: implementation and check
    // (Run command / tests — a single-token executable, per the schema
    // pattern) plus a review Coding agent (m4-reviewer, with a prompt —
    // the agent config requires one).
    const implId = await addStep(lastTerminal, "process.exec");
    await page.getByTestId(`canvas-step-${implId}`).click();
    await page.getByTestId("insp-config-executable").fill("echo");
    await page.getByTestId("insp-config-executable").blur();

    const checkId = await addStep(implId, "process.exec");
    await page.getByTestId(`canvas-step-${checkId}`).click();
    await page.getByTestId("insp-config-executable").fill("echo");
    await page.getByTestId("insp-config-executable").blur();

    const reviewId = await addStep(checkId, "agent.acp");
    await page.getByTestId(`canvas-step-${reviewId}`).click();
    await page.getByTestId("insp-profile").selectOption("m4-reviewer");
    const reviewPrompt = page.getByTestId("insp-config-prompt");
    await reviewPrompt.fill("Review the implementation for the add() fix and cite the evidence");
    await reviewPrompt.blur();

    // 2) Multi-select the three steps: clear the single selection first (the
    // "+" insert leaves the fresh node selected, which would toggle the first
    // shift-click OFF instead of starting the selection), then Shift+click
    // each step with Shift held BEFORE the mousedown — exactly how a human
    // shift-clicks (React Flow arms multi-select on keydown).
    await page
      .locator(".react-flow__pane")
      .first()
      .click({ position: { x: 30, y: 30 } });
    await page.waitForTimeout(300);
    for (const id of [implId, checkId, reviewId]) {
      await page.keyboard.down("Shift");
      await page.getByTestId(`canvas-step-${id}`).click();
      await page.waitForTimeout(150);
    }
    await page.keyboard.up("Shift");
    await expect(page.getByTestId("selection-toolbar")).toBeVisible();
    await expect(page.getByTestId("selection-count")).toHaveText("3 steps selected");

    // 3) Wrap the selection in a Repeat until scope from the selection
    // toolbar; the wrap lands as a new scope box on the canvas.
    const scopeIds = (): Promise<string[]> =>
      page.evaluate(() => {
        const out: string[] = [];
        for (const el of document.querySelectorAll<HTMLElement>("[data-testid]")) {
          const t = el.dataset.testid ?? "";
          if (t.startsWith("canvas-scope-")) out.push(t.slice("canvas-scope-".length));
        }
        return out;
      });
    const scopesBefore = new Set(await scopeIds());
    await page.getByTestId("wrap-until").click();
    await expect
      .poll(async () => (await scopeIds()).length, { timeout: 5_000 })
      .toBeGreaterThan(scopesBefore.size);
    const scopesAfter = await scopeIds();
    state.untilId = scopesAfter.find((id) => id !== "" && !scopesBefore.has(id)) ?? "";
    expect(state.untilId, "the wrap must create a visible scope on the canvas").toBeTruthy();

    // 4) The scope inspector: Pass when `true`, Max iterations 2. Click the
    // scope's HEADER bar (top-left) — the box centre overlaps its child
    // steps, whose nodes intercept the click.
    await page.getByTestId(`canvas-scope-${state.untilId}`).click({ position: { x: 14, y: 9 } });
    const passWhen = page.getByTestId("insp-config-passWhen");
    await passWhen.fill("true");
    await passWhen.blur();
    const maxIt = page.getByTestId("insp-config-maxIterations");
    await maxIt.fill("2");
    await maxIt.blur();

    // The canvas shows the Repeat until group; the YAML carries the config.
    await expect(page.getByTestId(`canvas-scope-${state.untilId}`)).toBeVisible();
    const yaml = await readYaml(page);
    expect(yaml).toContain("kind: until");
    // passWhen is a string expression, so the YAML quotes the boolean.
    expect(/passWhen:\s*['"]?true['"]?/.test(yaml), "the wrapped scope must pass when `true`").toBe(
      true,
    );
    expect(yaml).toContain("maxIterations: 2");
    await backToCanvas(page);
    await evidence(
      page,
      "studio-a2-wrapped",
      `three steps added at the root tail (two echo Run-command steps → the m4-reviewer agent), multi-selected by shift+click and wrapped in a Repeat until scope (${state.untilId}) from the selection toolbar — the YAML carries kind: until with passWhen true and maxIterations: 2`,
    );

    // Save, then Validate: the server's verdict must say valid. (The save is
    // fire-and-forget from the button, so wait for the dirty marker to clear
    // before the validate click can race a second PUT.)
    await page.getByTestId("studio-save").click();
    await expect(page.getByTestId("studio-dirty")).toHaveCount(0, { timeout: 30_000 });
    await page.getByTestId("studio-validate").click();
    const verdict = page.getByTestId("studio-validate-verdict");
    await expect(verdict).toBeVisible();
    const verdictText = (await verdict.textContent()) ?? "";
    if (!verdictText.startsWith("valid")) {
      // Findings surface in the panel and are fixed through the inspector —
      // fail loudly with the server's own words instead.
      throw new Error(`validation not valid: ${verdictText}`);
    }

    // The diff against the newest published revision lists code_review and
    // the new until scope as added.
    await page.getByTestId("studio-diff").click();
    await expect(page.getByTestId("studio-diff-drawer")).toBeVisible();
    await expect(page.getByTestId("diff-node-code_review")).toBeVisible();
    await expect(page.getByTestId("studio-diff-drawer")).toContainText(/until/);

    // Publish, then prove the revision landed.
    await page.getByTestId("studio-publish").click();
    const publishedNote = page.getByTestId("studio-published");
    await expect(publishedNote).toBeVisible();
    const noteText = (await publishedNote.textContent()) ?? "";
    const numberMatch = /r(\d+)/.exec(noteText);
    expect(numberMatch, `publish note must name the revision number: ${noteText}`).toBeTruthy();
    state.revisionNumber = Number(numberMatch?.[1]);
    await evidence(
      page,
      "studio-a2-published",
      `the draft was saved, validated (server verdict: ${verdictText.trim()}) and published — ${noteText.trim()}; the diff listed code_review and the ${state.untilId} until scope before publish`,
    );

    const revRes = await page.request.get(`/api/v1/pipelines/${state.pipelineId}/revisions`);
    expect(revRes.status()).toBe(200);
    const revBody = (await revRes.json()) as {
      revisions?: Array<{ revision_digest: string; revision_number: number }>;
    };
    const newest = revBody.revisions?.[0];
    expect(newest?.revision_number).toBe(state.revisionNumber);
    await writeFile(
      path.join(EVIDENCE_DIR, "published.json"),
      JSON.stringify(
        {
          pipelineId: state.pipelineId,
          revisionDigest: newest?.revision_digest,
          pipelineSlug: PIPELINE_SLUG,
        },
        null,
        2,
      ),
    );

    // Reopen the published revision from the pipeline page.
    await page.goto(`/library/${state.pipelineId}`);
    await expect(page.getByTestId("pipeline-page")).toBeVisible();
    await page.getByTestId(`revision-row-${state.revisionNumber}`).click();
    await expect(page.getByTestId("definition-graph")).toBeVisible();
    await expect(page.getByTestId(`definition-graph-scope-${state.untilId}`)).toBeVisible();
    const revisionYaml = page.getByTestId("yaml-view");
    // The read-only YAML view renders in 220-line windows (a "show more" button
    // extends the window) — the until scope sits past the first window, so
    // expand until the whole document is on the page.
    const more = page.getByTestId("yaml-view-more");
    for (let guard = 0; guard < 10 && (await more.count()) > 0; guard++) {
      await more.click();
    }
    await expect(revisionYaml).toContainText("kind: until");
    await expect(revisionYaml).toContainText("maxIterations: 2");
    await evidence(
      page,
      "studio-a2-reopened",
      `reopened r${state.revisionNumber} from the pipeline page: the definition graph shows the new ${state.untilId} Repeat until scope and the regenerated YAML shows kind: until with maxIterations: 2`,
    );
  });

  test("A3: drag-to-insert with undo/redo and the guarded-edge ambiguity", async ({ page }) => {
    await signIn(page, "admin");
    // A fresh draft: A2's publish locked the journey draft (a published draft
    // is read-only — revisions are immutable), so A3 works in its own clone
    // of the newest revision. The plan → approve and verdict → publish edges
    // it exercises exist in that clone too.
    await gotoApp(page, `/library/${state.pipelineId}`);
    await page.getByTestId("pipeline-new-draft").click();
    await expect(page).toHaveURL(new RegExp(`/library/${state.pipelineId}/drafts/`));
    state.draftA3 = new URL(page.url()).href;
    await gotoApp(page, state.draftA3);
    await backToCanvas(page);

    const before = await readYaml(page);
    await backToCanvas(page);

    // Real HTML5 drag, driven the way a real browser fires it: a
    // DataTransfer carrying the palette's kind string, a dragstart on the
    // palette item (the canvas mirrors that registry into its drag state),
    // then dragover/drop on the canvas at the edge's centre. Playwright's
    // mouse events cannot carry a DataTransfer, so the DragEvents are
    // dispatched in-page (the technique proven in e2e/.studio-drive.mjs).
    const PALETTE_KIND = "human.approval";
    const DRAG_TYPE = "application/x-communication-kind";
    type DragArgs = [string, string, string, string, { x: number; y: number } | undefined];
    const dispatchDrag = async (
      selector: string,
      type: "dragstart" | "dragover" | "drop" | "dragend",
      point?: { x: number; y: number },
    ) =>
      page.evaluate(
        ([sel, eventType, kind, dtType, pt]: DragArgs) => {
          const el = document.querySelector(sel);
          if (!el) return false;
          const dataTransfer = new DataTransfer();
          dataTransfer.setData(dtType, kind);
          el.dispatchEvent(
            new DragEvent(eventType, {
              bubbles: true,
              cancelable: true,
              dataTransfer,
              clientX: pt?.x ?? 0,
              clientY: pt?.y ?? 0,
            }),
          );
          return true;
        },
        [selector, type, PALETTE_KIND, DRAG_TYPE, point] as DragArgs,
      );

    // Drag the palette's Human approval over the plan → approve edge: while
    // the drag hovers the edge the canvas shows the insert preview, and the
    // drop lands the node between them.
    const edgeAdd = page.getByTestId("edge-add-plan-approve");
    await page.getByTestId("palette-item-human.approval").hover();
    const box = (await edgeAdd.boundingBox()) ?? { x: 100, y: 100, width: 10, height: 10 };
    const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await dispatchDrag('[data-testid="palette-item-human.approval"]', "dragstart");
    await dispatchDrag('[data-testid="studio-canvas"]', "dragover", centre);
    await expect(page.getByTestId("insert-preview")).toBeVisible();
    await evidence(
      page,
      "studio-a3-preview",
      "dragging 'Human approval' over the plan → approve edge shows the insert-preview on that edge",
    );
    await dispatchDrag('[data-testid="studio-canvas"]', "drop", centre);
    await dispatchDrag('[data-testid="palette-item-human.approval"]', "dragend");

    // The plan → approve edge is guarded (approve carries a `when`), so the
    // drop stops at the AmbiguityDialog; confirming it inserts the node.
    if ((await page.getByTestId("studio-ambiguity-dialog").count()) > 0) {
      await page.getByTestId("studio-ambiguity-insert").click();
    }
    const approvalNode = page.locator('[data-testid^="canvas-step-human"]').first();
    await expect(approvalNode).toBeVisible();

    // Undo (Ctrl+Z): the node is gone and the YAML is byte-identical to
    // before. (Focus the pane first — keystrokes aimed at a text field go
    // to the field, not the Studio.)
    await page
      .locator(".react-flow__pane")
      .first()
      .click({ position: { x: 30, y: 30 } });
    await page.keyboard.press("Control+z");
    await expect(page.locator('[data-testid^="canvas-step-human"]')).toHaveCount(0, {
      timeout: 5_000,
    });
    const afterUndo = await readYaml(page);
    expect(afterUndo, "undo must restore the exact YAML").toBe(before);

    // Redo (Ctrl+Shift+Z): the node is back, with the same YAML as after
    // insert.
    await backToCanvas(page);
    await page
      .locator(".react-flow__pane")
      .first()
      .click({ position: { x: 30, y: 30 } });
    await page.keyboard.press("Control+Shift+z");
    await expect(approvalNode).toBeVisible();
    const afterRedo = await readYaml(page);
    expect(afterRedo, "redo must re-apply the exact YAML").not.toBe(before);
    expect(afterRedo).toContain("kind: human.approval");
    await backToCanvas(page);
    await evidence(
      page,
      "studio-a3-undo",
      "drag-to-insert of a Human approval step on the plan → approve edge (insert preview, drop, guard confirm): inserted, undone (YAML byte-identical to before) and redone (YAML restored with kind: human.approval)",
    );

    // Guarded edge: the verdict → publish edge's own "+" must stop at the
    // AmbiguityDialog naming the condition before anything changes. (The
    // two publish branches fan out of verdict and their "+" buttons
    // overlap; the needs_attention one is the topmost and the one a real
    // click lands on — it is guarded exactly like the other.)
    const beforeAmbiguity = afterRedo;
    await page.getByTestId("edge-add-verdict-publish_needs_attention").click();
    await page.getByTestId("step-picker-item-human.approval").click();
    const dialog = page.getByTestId("studio-ambiguity-dialog");
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId("studio-ambiguity-reasons")).toContainText(
      /condition|when|guard/i,
    );
    await evidence(
      page,
      "studio-a3-ambiguity",
      "the guarded verdict → publish edge's own + raised the AmbiguityDialog naming the condition (when) guard before anything changed",
    );
    await page.getByTestId("studio-ambiguity-cancel").click();
    await expect(dialog).toHaveCount(0);
    const afterCancel = await readYaml(page);
    expect(afterCancel, "cancel must leave the YAML byte-identical").toBe(beforeAmbiguity);
    // Leave the draft unsaved on purpose — these A3 edits never reach the server.
    await backToCanvas(page);
  });

  test("A8: assistant drafting proposal", async ({ page }) => {
    await signIn(page, "admin");
    // A fresh draft: proposals are made against the saved version, and a dirty
    // draft blocks the assistant box entirely.
    await gotoApp(page, `/library/${state.pipelineId}`);
    await page.getByTestId("pipeline-new-draft").click();
    await expect(page).toHaveURL(new RegExp(`/library/${state.pipelineId}/drafts/`));
    const draft2Id = new URL(page.url()).pathname.split("/").pop() as string;

    const versionBefore = await draftVersion(page, draft2Id);
    const pipelineBefore = await pipelineInfo(page, PIPELINE_SLUG);

    await page
      .getByTestId("assistant-proposal-input")
      .fill("Insert a code reviewer agent step after the tests");
    await page.getByTestId("assistant-proposal-submit").click();

    const caption = page.getByTestId("assistant-proposal-caption");
    const error = page.getByTestId("assistant-proposal-error");
    await expect(
      caption.or(error),
      "the assistant must either propose or report an error",
    ).toBeVisible({ timeout: AGENT_TURN_TIMEOUT_MS });

    if ((await error.isVisible().catch(() => false)) && (await caption.count()) === 0) {
      // The lab's assistant is configured: an error here — a 503
      // assistant_not_configured among them — is a FAIL, not a skip.
      throw new Error(`assistant proposal failed: ${((await error.textContent()) ?? "").trim()}`);
    }

    // The proposal previews: caption + the highlighted node(s) on the canvas
    // (the proposed step plus the steps it reasons about), while the
    // server-side draft version is untouched.
    await expect(caption).toBeVisible();
    const highlighted = page.locator('[data-highlight="assistant-proposed"]');
    expect(
      await highlighted.count(),
      "the proposal must highlight the step(s) it touches",
    ).toBeGreaterThan(0);
    await expect(highlighted.first()).toBeVisible();
    await expect(page.getByTestId("studio-proposal-caption")).toBeVisible();
    const versionPreview = await draftVersion(page, draft2Id);
    expect(versionPreview, "a proposal must not bump the server draft version").toBe(versionBefore);
    await evidence(
      page,
      "studio-a8-proposed",
      `the assistant's proposal previews on the canvas (highlighted node + caption) with the draft still at version ${versionBefore} on the server — nothing saved, nothing published`,
    );

    // Apply: the saved version increments (the save is async, so poll the
    // server); no publish happened.
    await page.getByTestId("assistant-proposal-apply").click();
    await expect
      .poll(async () => draftVersion(page, draft2Id), { timeout: 30_000 })
      .toBeGreaterThan(versionBefore);
    const versionAfter = await draftVersion(page, draft2Id);
    expect(versionAfter, "Apply must save (version increments)").toBeGreaterThan(versionBefore);
    const pipelineAfter = await pipelineInfo(page, PIPELINE_SLUG);
    expect(pipelineAfter.revision_count, "Apply must not publish a revision").toBe(
      pipelineBefore.revision_count,
    );
    await evidence(
      page,
      "studio-a8-applied",
      `Apply saved the assistant's edit: draft version ${versionBefore} → ${versionAfter}, while the pipeline's revision count stayed at ${pipelineAfter.revision_count} (no publish)`,
    );
  });

  test("narrow: the Studio collapses to a step outline at 390x844", async ({ page }) => {
    await signIn(page, "admin");
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoApp(page, state.draftA3);
    await expect(page.getByTestId("studio-page")).toBeVisible();

    // No React Flow canvas at this width — the step outline is the surface.
    expect(await page.locator(".react-flow").count(), "no canvas below 1024px").toBe(0);
    const outline = page.getByTestId("step-outline");
    await expect(outline).toBeVisible();

    // Selecting a step opens the inspector for it.
    await page.getByTestId("step-outline-plan").click();
    await expect(page.getByTestId("insp-node")).toBeVisible();
    await expect(page.getByTestId("insp-node-id")).toHaveValue("plan");

    // No horizontal page scroll.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow, "the page must not scroll horizontally").toBeLessThanOrEqual(1);
    // Real axe audit on the narrow screen (wcag2a/wcag2aa): the inspector's
    // generated inputs (list rows, kv key/value, checkboxes) all carry
    // accessible names now, so this passes with zero serious/critical.
    await checkA11y(page, "studio narrow");
    await evidence(
      page,
      "studio-narrow",
      "at 390x844 the Studio drops the React Flow canvas for the step outline; selecting 'plan' opens the inspector and the page does not scroll horizontally",
    );
  });
});
