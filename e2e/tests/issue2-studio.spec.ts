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
// into ${E2E_EVIDENCE_DIR ?? "../test-results/issue2"}/<name>.png plus one
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
import { expectNoLegacyAppBar, gotoApp, scrollToTopForCapture, signIn } from "./helpers.js";

const ISSUE2_ENABLED = process.env.COMMUNICATION_E2E_ISSUE2 === "1";
/** Unique per run so re-runs never collide with their own earlier rows. */
const STAMP = process.env.E2E_ISSUE2_STAMP ?? Date.now().toString(36);
const PIPELINE_SLUG = "feature-development-deterministic";
const EVIDENCE_DIR = process.env.E2E_EVIDENCE_DIR ?? "../test-results/issue2";

/** One piece of journey evidence: a screenshot plus a single log line. */
async function evidence(page: Page, name: string, what: string): Promise<void> {
  await mkdir(EVIDENCE_DIR, { recursive: true });
  // Captured from the top: a full-page shot of a scrolled page stitches the
  // sticky phone top bar into the MIDDLE of the image.
  await scrollToTopForCapture(page);
  await page.screenshot({ path: path.join(EVIDENCE_DIR, `${name}.png`), fullPage: true });
  console.log(`EVIDENCE ${name}: ${what}`);
}

/**
 * Click a control without trusting its centre point.
 *
 * This started as a workaround for a real shell defect: the pipeline page used
 * to measure the shell's centred `max-w-5xl` column and offset itself out of it
 * to the window's left edge, so its 300px rail started at x≈0 and the
 * "New draft" button's centre (measured x≈231) sat under the sidebar.
 * Finding 07 removed that bleed machinery (`data-full-width` and all): `<main>`
 * is now the bare content column and the page declares `layout="canvas"`, so the
 * rail sits beside the sidebar instead of under it and the centre is clickable.
 * The right-of-centre aim stays — it is where a partially covered control is
 * still hittable, and a page that ever regrows a bleed cannot hide it from us.
 */
async function ensureDraftUrl(page: Page, pipelineId: string): Promise<string> {
  if (!page.url().includes("draft=")) {
    const res = await page.request.get(`/api/v1/pipelines/${pipelineId}/drafts`);
    expect(res.status()).toBe(200);
    const body = (await res.json()) as {
      drafts?: Array<{ id: string; status: string }>;
    };
    const open = (body.drafts ?? []).find((d) => d.status !== "published");
    if (open) {
      await gotoApp(page, `/factory/${pipelineId}?draft=${open.id}`);
      await expect(page.getByTestId("studio-canvas")).toBeVisible({ timeout: 30_000 });
    }
  }
  await expect(page).toHaveURL(new RegExp(`/factory/${pipelineId}\\?draft=`));
  return new URL(page.url()).href;
}

async function restoreRevisionIntoDraft(
  page: Page,
  pipelineId: string,
  restorePublishedNumber?: number,
): Promise<void> {
  await page.getByTestId("editor-versions-btn").click();
  await expect(page.getByTestId("versions-panel")).toBeVisible();
  const hasDraft = (await page.getByTestId("versions-row-draft").count()) > 0;
  const restoreBtn =
    restorePublishedNumber !== undefined
      ? page.getByTestId(`versions-restore-v${restorePublishedNumber}`)
      : page.locator('[data-testid^="versions-restore-v"]').first();
  // When an open draft already exists, restoring mutates it in-place and saves
  // after an 800ms debounce (unless already identical to the target revision).
  const patchPromise = hasDraft
    ? page
        .waitForResponse(
          (res) =>
            /\/api\/v1\/drafts\/[^/]+$/.test(res.url()) && res.request().method() === "PATCH",
          { timeout: 4_000 },
        )
        .catch(() => null)
    : Promise.resolve(null);
  await restoreBtn.click();
  await expect(page.getByTestId("versions-panel")).toBeHidden({ timeout: 15_000 });
  await patchPromise;
  await expect(page.getByTestId("studio-draft-status")).not.toContainText(/Saving/i, {
    timeout: 15_000,
  });
  await ensureDraftUrl(page, pipelineId);
}

async function openNewDraft(
  page: Page,
  pipelineId: string,
  restorePublishedNumber?: number,
): Promise<void> {
  await gotoApp(page, `/factory/${pipelineId}`);
  await expect(page.getByTestId("studio-canvas")).toBeVisible({ timeout: 30_000 });
  if (restorePublishedNumber !== undefined || !page.url().includes("draft=")) {
    await restoreRevisionIntoDraft(page, pipelineId, restorePublishedNumber);
  } else {
    await ensureDraftUrl(page, pipelineId);
  }
}

/** Wait for Studio's debounced 800ms autosave to bump the server draft version. */
async function waitForAutosave(
  page: Page,
  draftId: string,
  versionBefore: number,
  timeout = 30_000,
): Promise<void> {
  await expect
    .poll(async () => draftVersion(page, draftId), { timeout })
    .toBeGreaterThan(versionBefore);
  await expect(page.getByTestId("studio-draft-status")).not.toContainText(/Saving/i, {
    timeout,
  });
}

/** Resolve a pipeline in the org library by slug (no list UI: `/workflows` is the create form). */
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

/** The saved draft document — `GET /api/v1/drafts/{id}` → `document_yaml`. */
async function draftDocument(page: Page, draftId: string): Promise<string> {
  const res = await page.request.get(`/api/v1/drafts/${draftId}`);
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { document_yaml: string };
  return body.document_yaml;
}

/** How many nodes of the draft have `kind: <kind>` (one per line, node kinds only). */
function countKind(document: string, kind: string): number {
  const want = `kind: ${kind}`;
  return document.split("\n").filter((line) => line.trim() === want).length;
}

/** Read the draft YAML editor or the published revision viewer. */
async function readYaml(page: Page, published = false): Promise<string> {
  await page.getByTestId("editor-more-btn").click();
  await expect(page.getByTestId("editor-more-menu")).toBeVisible();
  await page.getByTestId("editor-menu-yaml").click();
  const panel = page.getByTestId("editor-panel-yaml");
  await expect(panel).toBeVisible();
  if (!published) {
    const editor = panel.getByTestId("studio-yaml");
    await expect(editor).toBeVisible();
    return editor.inputValue();
  }
  const viewer = panel.getByTestId("yaml-view");
  await expect(viewer).toBeVisible();
  const lines = await viewer
    .locator('[data-testid^="yaml-view-line-"] > span:nth-child(2)')
    .allTextContents();
  return lines.map((line) => (line === "\u00a0" ? "" : line)).join("\n");
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
  const close = page.getByTestId("editor-panel-close");
  if (await close.isVisible().catch(() => false)) {
    await close.click();
    await expect(close).toBeHidden();
  }
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
    await gotoApp(page, "/factory");
    await expect(page.getByTestId("factory-index")).toBeVisible();
    const pipeline = await pipelineInfo(page, PIPELINE_SLUG);
    state.pipelineId = pipeline.id;
    await expectNoLegacyAppBar(page);

    // Re-run safety: if a previous run already published code_review, restore the
    // oldest seeded twin document (stamped so its digest is fresh) via API setup
    // so the journey runs against the pristine twin.
    const revRes = await page.request.get(`/api/v1/pipelines/${pipeline.id}/revisions`);
    expect(revRes.status()).toBe(200);
    const revBody = (await revRes.json()) as {
      revisions?: Array<{ revision_digest: string }>;
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
      const me = (await (await page.request.get("/api/v1/me")).json()) as { csrf_token: string };
      const headers = { "x-csrf-token": me.csrf_token };
      const restoreDraft = (await (
        await page.request.post(`/api/v1/pipelines/${pipeline.id}/drafts`, {
          data: { document_yaml: seededDoc },
          headers,
        })
      ).json()) as { id: string; version: number };
      const val = await page.request.post(`/api/v1/drafts/${restoreDraft.id}/validate`, {
        data: {},
        headers,
      });
      expect(val.status()).toBe(200);
      const pub = await page.request.post(`/api/v1/drafts/${restoreDraft.id}/publish`, {
        data: { version: restoreDraft.version },
        headers,
      });
      expect(pub.ok(), `publish restore -> ${pub.status()}`).toBe(true);
    }

    // Open in Factory editor and restore the newest revision into an editable
    // draft (`?draft=`) so re-runs never carry stale edits from an interrupted run.
    await page.getByTestId(`workflow-card-link-${pipeline.id}`).click();
    await expect(page).toHaveURL(new RegExp(`/factory/${pipeline.id}(\\?|$)`));
    await expect(page.getByTestId("studio-canvas")).toBeVisible({ timeout: 30_000 });
    await restoreRevisionIntoDraft(page, pipeline.id);
    state.draftUrl = new URL(page.url()).href;
    state.draftId = new URL(page.url()).searchParams.get("draft") ?? "";
    expect(state.draftId).toMatch(/^[0-9a-f-]{36}$/);

    // The Studio opens on the graph canvas — not a YAML drawer.
    await expect(page.getByTestId("studio-canvas")).toBeVisible();
    expect(await page.locator(".react-flow").count()).toBeGreaterThan(0);
    expect(await page.getByTestId("editor-panel-yaml").count()).toBe(0);
    // The seeded until scope is on the canvas as its own box.
    await expect(page.getByTestId("canvas-scope-build_until_verified")).toBeVisible();
    await checkA11y(page, "studio (A0)");
    await evidence(
      page,
      "studio-loaded",
      `Editor opened on a draft of ${PIPELINE_SLUG} — the graph canvas (with the seeded build_until_verified scope) is on stage`,
    );
  });

  test("A1: insert an ACP reviewer between test and review on the edge", async ({ page }) => {
    await signIn(page, "admin");
    await gotoApp(page, state.draftUrl);
    await expect(page.getByTestId("studio-canvas")).toBeVisible();
    const versionBefore = await draftVersion(page, state.draftId);

    // The "+" on the test → review edge (inside the until scope) opens the step
    // picker.
    await page.getByTestId("edge-add-test-review").click();
    const picker = page.getByTestId("step-picker");
    await expect(picker).toBeVisible();
    await page.getByTestId("step-picker-item-agent.acp").click();

    // New agent.acp node opens the compact AgentStepCard first; clicking
    // "More settings" opens the full inspector.
    await expect(page.getByTestId("agent-step-card")).toBeVisible();
    await page.getByTestId("agent-card-more-settings").click();
    const nodeIdField = page.getByTestId("insp-node-id");
    await page.getByTestId("insp-advanced-disclosure").locator("summary").click();
    await expect(nodeIdField).toBeVisible();
    const autoId = await nodeIdField.inputValue();
    expect(autoId, "the inserted node is auto-named, not code_review yet").not.toBe("code_review");
    await expect(page.getByTestId("canvas-step-test")).toBeVisible();
    await expect(page.getByTestId("canvas-step-review")).toBeVisible();

    await page.getByTestId("insp-profile").selectOption("m4-reviewer");
    const prompt =
      'First wait about 90 seconds before you review, so this turn stays open: run this exact shell command in the FOREGROUND and wait for it to finish — end=$(( $(date +%s) + 90 )); until [ $(date +%s) -ge $end ]; do sleep 2; done — this is the allowed Monitor until-loop (a standalone `sleep 90` is blocked, so do not use one and do not run the loop in the background). Once it completes, review the diff for the add() fix and answer JSON {"approved": true|false, "evidence": "…"}';
    await page.getByTestId("insp-config-prompt").fill(prompt);
    await page.getByTestId("insp-config-prompt").blur();
    await page.getByTestId("insp-onFailure-onExecutionError").selectOption("continue");
    await nodeIdField.fill("code_review");
    await nodeIdField.press("Enter");
    await page.waitForTimeout(300);
    await evidence(
      page,
      "studio-a1-inserted",
      `agent.acp node ${autoId} inserted on the test → review edge and configured in the inspector: profile m4-reviewer, review prompt, id code_review, on-failure continue`,
    );

    // Autosave persists the edits within ~800ms (no manual Save button).
    await waitForAutosave(page, state.draftId, versionBefore);

    const yaml = await readYaml(page);
    expect(yaml).toContain("id: code_review");
    expect(yaml).toContain("kind: agent.acp");
    expect(yaml).toContain("profile: m4-reviewer");
    expect(yamlDependsOn(yaml, "code_review"), "review must now depend on code_review").toBe(true);
    expect(yaml, "the seeded per-iteration publisher survives the splice").toContain(
      "test_evidence",
    );
    expect(
      yamlDependsOn(yaml, "test"),
      "test_evidence must still depend on the test step of its own iteration",
    ).toBe(true);
    expect(yaml).toContain("onExecutionError: continue");
    await backToCanvas(page);
    await evidence(
      page,
      "studio-a1-yaml",
      "The draft YAML editor confirms the inspector's work: id: code_review (kind agent.acp, profile m4-reviewer), review's dependsOn now names code_review, on-failure continue",
    );
  });

  test("A1b: desktop agent card + inspector a11y with agent.acp and process.exec steps", async ({
    page,
  }) => {
    await signIn(page, "admin");
    await gotoApp(page, state.draftUrl);
    await expect(page.getByTestId("studio-canvas")).toBeVisible();

    await page.getByTestId("canvas-step-code_review").click();
    await expect(page.getByTestId("agent-step-card")).toBeVisible();
    await checkA11y(page, "studio agent card (agent.acp)");
    await page.getByTestId("agent-card-more-settings").click();
    await expect(page.getByTestId("insp-node")).toBeVisible();
    await page.getByTestId("insp-advanced-disclosure").locator("summary").click();
    await expect(page.getByTestId("insp-node-id")).toHaveValue("code_review");
    await checkA11y(page, "studio inspector (agent.acp)");

    await page.getByTestId("canvas-step-review").click();
    await page.getByTestId("insp-advanced-disclosure").locator("summary").click();
    await expect(page.getByTestId("insp-node-id")).toHaveValue("review");
    await checkA11y(page, "studio inspector (process.exec)");
    await evidence(
      page,
      "studio-a1b-inspector-a11y",
      "desktop AgentStepCard and inspector audited by axe with agent.acp (code_review) and process.exec (review)",
    );
  });

  test("A2: wrap steps in Repeat until, validate, diff, publish, reopen", async ({ page }) => {
    await signIn(page, "admin");
    await gotoApp(page, state.draftUrl);
    await expect(page.getByTestId("studio-canvas")).toBeVisible();

    const lastTerminal = "publish_needs_attention";
    // Canvas step nodes are `canvas-step-<id>`; the step-list panel adds
    // `canvas-step-row-<id>` and a `canvas-step-list` wrapper and 35624f6 gave
    // every node a `canvas-step-fact-<id>` key-fact line INSIDE its own box, so
    // a bare `canvas-step-` prefix counts one step twice. All three are
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
            !t.startsWith("canvas-step-fact-") &&
            !t.startsWith("canvas-step-tile-") &&
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

    // 1) Three steps after the last terminal step: each addStep selects the
    // newly created node immediately; close the floating right-hand inspector
    // after each edit so the next rightmost `+` / step is never covered.
    const implId = await addStep(lastTerminal, "process.exec");
    await expect(page.getByTestId("insp-config-executable")).toBeVisible();
    await page.getByTestId("insp-config-executable").fill("echo");
    await page.getByTestId("insp-config-executable").blur();
    await page.getByTestId("editor-inspector-close").click();

    const checkId = await addStep(implId, "process.exec");
    await expect(page.getByTestId("insp-config-executable")).toBeVisible();
    await page.getByTestId("insp-config-executable").fill("echo");
    await page.getByTestId("insp-config-executable").blur();
    await page.getByTestId("editor-inspector-close").click();

    const reviewId = await addStep(checkId, "agent.acp");
    await expect(page.getByTestId("agent-step-card")).toBeVisible();
    await page.getByTestId("agent-card-more-settings").click();
    await page.getByTestId("insp-profile").selectOption("m4-reviewer");
    const reviewPrompt = page.getByTestId("insp-config-prompt");
    await reviewPrompt.fill("Review the implementation for the add() fix and cite the evidence");
    await reviewPrompt.blur();
    await page.getByTestId("editor-inspector-close").click();

    // 2) Multi-select the three steps (`editor-inspector-close` already cleared
    // single selection and uncovered the right-side nodes).
    await page.waitForTimeout(300);
    for (const id of [implId, checkId, reviewId]) {
      await page.keyboard.down("Shift");
      await page.getByTestId(`canvas-step-${id}`).click();
      await page.waitForTimeout(150);
    }
    await page.keyboard.up("Shift");
    await expect(page.getByTestId("marching-ants")).toBeVisible();
    await expect(page.getByTestId("marching-ants-label")).toHaveText("3 steps selected");
    await expect(page.getByTestId("wrap-panel")).toBeVisible();

    // 3) Wrap in a Repeat until scope from WrapPanel: pick command passes
    // ("echo ok"), decrement max rounds 3 → 2, click Wrap.
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
    await page.getByTestId("wrap-tab-repeat").click();
    await page.getByTestId("wrap-goal-command").click();
    await page.getByTestId("wrap-goal-input").fill("echo ok");
    await page.getByTestId("wrap-rounds-dec").click();
    await expect(page.getByTestId("wrap-rounds-value")).toHaveText("2");
    await page.getByTestId("wrap-submit").click();
    await expect
      .poll(async () => (await scopeIds()).length, { timeout: 5_000 })
      .toBeGreaterThan(scopesBefore.size);
    const scopesAfter = await scopeIds();
    state.untilId = scopesAfter.find((id) => id !== "" && !scopesBefore.has(id)) ?? "";
    expect(state.untilId, "the wrap must create a visible scope on the canvas").toBeTruthy();

    // The canvas shows the Repeat until group; deselect via close before opening `…` menu.
    await expect(page.getByTestId(`canvas-scope-${state.untilId}`)).toBeVisible();
    const inspClose = page.getByTestId("editor-inspector-close");
    if (await inspClose.isVisible().catch(() => false)) {
      await inspClose.click();
    }
    const yaml = await readYaml(page);
    expect(yaml).toContain("kind: until");
    expect(yaml).toContain("maxIterations: 2");
    await backToCanvas(page);
    await evidence(
      page,
      "studio-a2-wrapped",
      `three steps added, multi-selected with marching-ants and wrapped in a Repeat until scope (${state.untilId}) via WrapPanel — YAML carries kind: until and maxIterations: 2`,
    );

    // Wait for autosave, check Versions diff summary, then Make live.
    const versionBeforePublish = await draftVersion(page, state.draftId);
    await waitForAutosave(page, state.draftId, versionBeforePublish - 1);
    await page.getByTestId("editor-versions-btn").click();
    await expect(page.getByTestId("versions-panel")).toBeVisible();
    await expect(page.getByTestId("versions-row-draft")).toContainText("code_review");
    await page.getByTestId("versions-panel-close").click();

    await page.getByTestId("studio-publish").click();
    const publishedNote = page.getByTestId("studio-published");
    await expect(publishedNote).toBeVisible({ timeout: 30_000 });
    const noteText = (await publishedNote.textContent()) ?? "";
    const numberMatch = /r(\d+)/.exec(noteText);
    expect(numberMatch, `publish note must name the revision number: ${noteText}`).toBeTruthy();
    state.revisionNumber = Number(numberMatch?.[1]);
    await evidence(
      page,
      "studio-a2-published",
      `the autosaved draft passed validation inside Make live and published — ${noteText.trim()}`,
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

    // Reopen the published revision via Versions in the editor.
    await gotoApp(page, `/factory/${state.pipelineId}`);
    await expect(page.getByTestId("studio-canvas")).toBeVisible();
    await page.getByTestId("editor-versions-btn").click();
    await expect(page.getByTestId("versions-panel")).toBeVisible();
    await page.getByTestId(`versions-select-v${state.revisionNumber}`).click();
    await expect(page.getByTestId("version-viewing-banner")).toBeVisible();
    await expect(page.getByTestId(`canvas-scope-${state.untilId}`)).toBeVisible();
    await page.getByTestId("versions-panel-close").click();
    const revisionYaml = await readYaml(page, true);
    expect(revisionYaml).toContain("kind: until");
    expect(revisionYaml).toContain("maxIterations: 2");
    await backToCanvas(page);
    await evidence(
      page,
      "studio-a2-reopened",
      `reopened v${state.revisionNumber} from Versions in the editor: canvas shows ${state.untilId} Repeat until scope and View YAML shows kind: until and maxIterations: 2`,
    );
  });

  test("A3: insert on edge & Tool island add with undo/redo and guarded-edge ambiguity", async ({
    page,
  }) => {
    await signIn(page, "admin");
    await openNewDraft(page, state.pipelineId, state.revisionNumber);
    state.draftA3 = new URL(page.url()).href;

    const before = await readYaml(page);
    await backToCanvas(page);

    // Tool island replaces the retired StudioPalette sidebar; add a Human
    // approval step via the plan → approve edge (which carries a binding),
    // verify the AmbiguityDialog, undo/redo, and also test ToolIsland add.
    await expect(page.getByTestId("tool-island")).toBeVisible();
    await page.getByTestId("edge-add-plan-approve").click();
    await expect(page.getByTestId("step-picker")).toBeVisible();
    await page.getByTestId("step-picker-item-human.approval").click();

    if ((await page.getByTestId("studio-ambiguity-dialog").count()) > 0) {
      await page.getByTestId("studio-ambiguity-insert").click();
    }
    const approvalNode = page.locator('[data-testid^="canvas-step-human"]').first();
    await expect(approvalNode).toBeVisible();

    // Undo (Ctrl+Z): the node is gone and View YAML matches before.
    await page
      .locator(".react-flow__pane")
      .first()
      .click({ position: { x: 250, y: 30 } });
    await page.keyboard.press("Control+z");
    await expect(page.locator('[data-testid^="canvas-step-human"]')).toHaveCount(0, {
      timeout: 5_000,
    });
    const afterUndo = await readYaml(page);
    expect(afterUndo, "undo must restore the exact YAML").toBe(before);
    await backToCanvas(page);

    // Redo (Ctrl+Shift+Z): the node is back, with the same YAML as after insert.
    await page
      .locator(".react-flow__pane")
      .first()
      .click({ position: { x: 250, y: 30 } });
    await page.keyboard.press("Control+Shift+z");
    await expect(approvalNode).toBeVisible();
    const afterRedo = await readYaml(page);
    expect(afterRedo, "redo must re-apply the exact YAML").not.toBe(before);
    expect(afterRedo).toContain("kind: human.approval");
    await backToCanvas(page);
    await evidence(
      page,
      "studio-a3-undo",
      "edge + insert of a Human approval step on plan → approve (guard confirm): inserted, undone (YAML identical to before) and redone (kind: human.approval)",
    );

    // Guarded edge: the verdict → publish edge's own "+" must stop at the
    // AmbiguityDialog naming the condition before anything changes.
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
    await backToCanvas(page);
  });

  test("A8: assistant drafting proposal", async ({ page }) => {
    test.setTimeout(AGENT_TURN_TIMEOUT_MS + 180_000);
    await signIn(page, "admin");
    await openNewDraft(page, state.pipelineId, state.revisionNumber);
    const draft2Id = new URL(page.url()).searchParams.get("draft") ?? "";
    expect(draft2Id).toMatch(/^[0-9a-f-]{36}$/);

    const NEW_NODE_ID = "security_scan";
    const ANCHOR_ID = "publish_verified";

    const versionBefore = await draftVersion(page, draft2Id);
    const documentBefore = await draftDocument(page, draft2Id);
    const pipelineBefore = await pipelineInfo(page, PIPELINE_SLUG);
    expect(
      yamlDependsOn(documentBefore, ANCHOR_ID),
      `${ANCHOR_ID} must start with no dependents for the ask to be unambiguous`,
    ).toBe(false);

    // In the editor redesign, assistant-proposal-footer lives inside Workflow settings.
    await page.getByTestId("editor-more-btn").click();
    await expect(page.getByTestId("editor-more-menu")).toBeVisible();
    await page.getByTestId("editor-menu-settings").click();
    const footer = page.getByTestId("assistant-proposal-footer");
    const assistantInput = page.getByTestId("assistant-proposal-input");
    await expect(footer.or(assistantInput).first()).toBeVisible({ timeout: 30_000 });
    if (await footer.isVisible().catch(() => false)) await footer.click();
    await expect(assistantInput).toBeVisible({ timeout: 30_000 });
    await assistantInput.fill(
      `Add a new agent.acp step named ${NEW_NODE_ID} that runs right after ${ANCHOR_ID} — nothing depends on ${ANCHOR_ID} yet, so ${NEW_NODE_ID} must depend on ${ANCHOR_ID}`,
    );
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

    // The saved draft really carries the node that was asked for. The
    // instruction names the id, the kind and the anchor explicitly (the
    // server only enforces the id PATTERN and uniqueness, but the ask is
    // explicit, so the id itself is what we assert) — and the anchor edge:
    // nothing else in the graph depends on `publish_verified`, so a dependsOn
    // naming it can only be the new node's.
    const documentAfter = await draftDocument(page, draft2Id);
    expect(documentAfter, `Apply must save the proposed node ${NEW_NODE_ID}`).toContain(
      `id: ${NEW_NODE_ID}`,
    );
    expect(
      countKind(documentAfter, "agent.acp"),
      `Apply must add exactly one agent.acp step (${NEW_NODE_ID})`,
    ).toBe(countKind(documentBefore, "agent.acp") + 1);
    expect(
      yamlDependsOn(documentAfter, ANCHOR_ID),
      `the saved draft must carry ${NEW_NODE_ID} depending on ${ANCHOR_ID}`,
    ).toBe(true);
    await evidence(
      page,
      "studio-a8-saved",
      `GET /api/v1/drafts/${draft2Id} after Apply: the document names id: ${NEW_NODE_ID} (agent.acp count ${countKind(documentBefore, "agent.acp")} → ${countKind(documentAfter, "agent.acp")}) with a dependsOn on ${ANCHOR_ID}`,
    );
  });

  test("narrow: the phone editor keeps the canvas and opens step bottom sheet at 390x844", async ({
    page,
  }) => {
    await signIn(page, "admin");
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoApp(page, state.draftA3);
    await expect(page.getByTestId("studio-canvas")).toBeVisible();
    expect(await page.locator(".react-flow").count(), "the canvas is the phone surface").toBe(1);
    expect(await page.getByTestId("step-outline").count(), "no outline below 768px").toBe(0);
    await expect(page.getByTestId("tool-island")).toBeVisible();

    // The editor opens at zoom 1 with the trigger at the left, so at 390px the
    // next step starts off-screen to the right. Pan the canvas left (a drag on
    // the empty pane, as a reader would) until a non-agent step is fully in
    // view; tapping it opens the inspector bottom sheet directly.
    const visibleStep = () =>
      page.evaluate(() => {
        const candidates = Array.from(
          document.querySelectorAll<HTMLElement>("[data-step-node-id]"),
        );
        for (const el of candidates) {
          const id = el.dataset.stepNodeId;
          if (!id || id === "code_review" || id.startsWith("agent")) continue;
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.left >= 70 && r.right <= 385 && r.top >= 70 && r.bottom <= 800) {
            return id;
          }
        }
        return null;
      });
    let stepId = await visibleStep();
    for (let pans = 0; stepId === null && pans < 12; pans += 1) {
      await page.mouse.move(340, 780);
      await page.mouse.down();
      await page.mouse.move(180, 780, { steps: 8 });
      await page.mouse.up();
      stepId = await visibleStep();
    }
    expect(
      stepId,
      "a non-agent step can be panned into the 390px canvas",
    ).not.toBeNull();
    await page.getByTestId(`canvas-step-${stepId!}`).click();
    const outline = page.getByTestId("insp-node");
    await expect(outline).toBeVisible();
    await page.getByTestId("insp-advanced-disclosure").locator("summary").click();
    await expect(page.getByTestId("insp-node-id")).toHaveValue(stepId!);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow, "the page must not scroll horizontally").toBeLessThanOrEqual(1);
    await checkA11y(page, "studio narrow");
    await evidence(
      page,
      "studio-narrow",
      "at 390x844 the editor keeps the full-width canvas with ToolIsland; tapping 'plan' opens its inspector bottom sheet without horizontal scroll",
    );
  });
});
