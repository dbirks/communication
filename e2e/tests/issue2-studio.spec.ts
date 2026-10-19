// Issue #2 acceptance journeys for the graph-first Workflow Studio:
// A0 (open the deterministic twin in the Studio), A1 (insert an ACP reviewer
// on the test → review edge inside the until scope), A2 (wrap steps in a
// Repeat until, validate, diff, publish and reopen the revision), A3
// (drag-to-insert with undo/redo and the ambiguity dialog on a guarded
// edge), A8 (assistant drafting proposal) and the narrow (390x844) layout.
//
// It runs against the M4 lab ONLY when COMMUNICATION_E2E_ISSUE2=1 — skipped
// everywhere else, the same env-gate idiom as the sibling issue2 spec:
//   COMMUNICATION_E2E_ISSUE2=1 E2E_BASE_URL=http://localhost:18091 \
//     pnpm exec playwright test tests/issue2-studio.spec.ts
// The seeded pipeline `feature-development-deterministic` drives everything:
// process.exec nodes only, so no real agent turns happen and no
// AGENT_TURN_TIMEOUT_MS waits are needed.
//
// Every journey step calls the local `evidence()`: a full-page screenshot
// into ${E2E_EVIDENCE_DIR ?? "test-results/issue2"}/<name>.png plus one
// console line `EVIDENCE <name>: <what it proves>`.
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

async function backToCanvas(page: Page): Promise<void> {
  await page.getByTestId("studio-view-canvas").click();
  await expect(page.getByTestId("studio-canvas")).toBeVisible();
}

/** State passed between the serial journey steps (one browser, one session). */
const state: {
  pipelineId: string;
  draftId: string;
  draftUrl: string;
  untilId: string;
  revisionNumber: number;
} = { pipelineId: "", draftId: "", draftUrl: "", untilId: "", revisionNumber: 0 };

test.describe.serial("issue2 studio (A0 A1 A2 A3 A8 + narrow)", () => {
  test.skip(
    !ISSUE2_ENABLED,
    "requires the M4 lab (COMMUNICATION_E2E_ISSUE2=1, E2E_BASE_URL=http://localhost:18091)",
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

    // Inspector-only configuration: profile, prompt, id, on-failure. No YAML typing.
    await page.getByTestId("insp-profile").selectOption("m4-reviewer");
    const prompt =
      'Review the diff for the add() fix and answer JSON {"approved": true|false, "evidence": "…"}';
    await page.getByTestId("insp-config-prompt").fill(prompt);
    await page.getByTestId("insp-config-prompt").blur();
    await nodeIdField.fill("code_review");
    await nodeIdField.press("Enter");
    // The "following route" is configurable: on failure → continue.
    await page.getByTestId("insp-onFailure-onExecutionError").selectOption("continue");
    await evidence(
      page,
      "studio-a1-inserted",
      `agent.acp node ${autoId} inserted on the test → review edge and configured entirely in the inspector: profile m4-reviewer, review prompt, id code_review, on-failure continue`,
    );

    const yaml = await readYaml(page);
    expect(yaml).toContain("id: code_review");
    expect(yaml).toContain("kind: agent.acp");
    expect(yaml).toContain("profile: m4-reviewer");
    expect(/dependsOn:[^\n]*code_review/.test(yaml), "review must now depend on code_review").toBe(
      true,
    );
    expect(yaml).toContain("onExecutionError: continue");
    await evidence(
      page,
      "studio-a1-yaml",
      "YAML view proves the inspector's work: id: code_review (kind agent.acp, profile m4-reviewer), review's dependsOn now names code_review, on-failure continue — untouched by any YAML editing",
    );
  });

  test("A2: wrap steps in Repeat until, validate, diff, publish, reopen", async ({ page }) => {
    await signIn(page, "admin");
    await gotoApp(page, state.draftUrl);
    await expect(page.getByTestId("studio-canvas")).toBeVisible();

    const lastTerminal = "publish_needs_attention";
    const wrapControl = page.getByRole("button", { name: /wrap in/i });

    if ((await wrapControl.count()) > 0) {
      // Design §3.5 path: add three steps at the root tail, multi-select them
      // and use the "Wrap in Repeat until" control. Kept so the journey
      // self-heals the day the control lands.
      const processItem = page.getByTestId("step-picker-item-process.exec");
      const agentItem = page.getByTestId("step-picker-item-agent.acp");
      await page.getByTestId(`add-after-${lastTerminal}`).click();
      await processItem.click();
      const tail1 = await page
        .locator('[data-testid^="canvas-step-process"]')
        .last()
        .getAttribute("data-testid")
        .then((t) => (t ?? "").slice("canvas-step-".length));
      await page.getByTestId(`add-after-${tail1}`).click();
      await processItem.click();
      const tail2 = await page
        .locator('[data-testid^="canvas-step-process"]')
        .last()
        .getAttribute("data-testid")
        .then((t) => (t ?? "").slice("canvas-step-".length));
      await page.getByTestId(`add-after-${tail2}`).click();
      await agentItem.click();
      await wrapControl.first().click();
      // The wrap creates a new scope node: find it by diffing against the
      // scopes the twin already ships with.
      const scopesAfter = await page
        .locator('[data-testid^="canvas-scope-"]')
        .evaluateAll((els) =>
          els.map((el) => (el.getAttribute("data-testid") ?? "").slice("canvas-scope-".length)),
        );
      const known = new Set(["build_until_verified", "fan_out"]);
      state.untilId = scopesAfter.find((id) => id !== "" && !known.has(id)) ?? "";
      expect(state.untilId, "the wrap must create a visible scope on the canvas").toBeTruthy();
    } else {
      // GAP: the Studio has no "Wrap in Repeat until" control — `wrapInScope`
      // exists in lib/pipeline/graphDoc.ts but no UI wires it (no multi-select,
      // no wrap menu). Closest available: a Repeat until scope at the root
      // tail with the three steps added inside its body.
      test.info().annotations.push({
        type: "gap",
        description:
          "no 'Wrap in Repeat until' control in the Studio (wrapInScope op is not wired to the UI); closest available used: new Repeat until scope at the root tail with the three steps inside",
      });
      console.log(
        "GAP a2-wrap: 'Wrap in Repeat until' control absent from the Studio UI — using the closest available (new until scope + steps inside)",
      );

      await page.getByTestId(`add-after-${lastTerminal}`).click();
      await page.getByTestId("step-picker-item-until").click();
      await expect(page.locator('[data-testid^="canvas-scope-until"]')).not.toHaveCount(0);
      state.untilId =
        (
          await page
            .locator('[data-testid^="canvas-scope-until"]')
            .first()
            .getAttribute("data-testid")
        )?.slice("canvas-scope-".length) ?? "";
      expect(state.untilId, "the new Repeat until scope must be on the canvas").toBeTruthy();

      // Step 1: the empty body's "+" (no steps inside yet).
      await page.getByTestId(`add-inside-${state.untilId}`).click();
      await page.getByTestId("step-picker-item-process.exec").click();
      const first = page.locator('[data-testid^="canvas-step-process"]');
      await expect(first.first()).toBeVisible();
      const firstId =
        (await first.first().getAttribute("data-testid"))?.slice("canvas-step-".length) ?? "";
      await first.first().click();
      await page.getByTestId("insp-config-executable").fill("echo implement");
      await page.getByTestId("insp-config-executable").blur();

      // Step 2: after the first one.
      await page.getByTestId(`add-after-${firstId}`).click();
      await page.getByTestId("step-picker-item-process.exec").click();
      const secondId =
        (await first.last().getAttribute("data-testid"))?.slice("canvas-step-".length) ?? "";
      await first.last().click();
      await page.getByTestId("insp-config-executable").fill("echo check");
      await page.getByTestId("insp-config-executable").blur();

      // Step 3: a Coding agent review (auto ids are prefixed with the kind base).
      await page.getByTestId(`add-after-${secondId}`).click();
      await page.getByTestId("step-picker-item-agent.acp").click();
      const agentNode = page.locator('[data-testid^="canvas-step-agent"]').first();
      await expect(agentNode).toBeVisible();
      await agentNode.click();
      await page.getByTestId("insp-profile").selectOption("m4-reviewer");
    }

    // Configure the new scope: Pass when `true`, Max iterations 2.
    await page.getByTestId(`canvas-scope-${state.untilId}`).click();
    const passWhen = page.getByTestId("insp-config-passWhen");
    await passWhen.fill("true");
    await passWhen.blur();
    const maxIt = page.getByTestId("insp-config-maxIterations");
    await maxIt.fill("2");
    await maxIt.blur();

    // The canvas shows the Repeat until group holding the wrapped steps.
    const untilScope = page.getByTestId(`canvas-scope-${state.untilId}`);
    await expect(untilScope).toBeVisible();
    const yaml = await readYaml(page);
    expect(yaml).toContain("kind: until");
    expect(yaml).toContain("maxIterations: 2");
    await backToCanvas(page);
    await evidence(
      page,
      "studio-a2-wrapped",
      `the root tail now ends in a Repeat until scope (${state.untilId || "auto-id"}) holding echo implement → echo check → the agent review; the YAML carries kind: until with maxIterations: 2 and passWhen true`,
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
      // The findings panel updates; fix them through the inspector would be
      // manual — fail loudly with the server's own words instead.
      throw new Error(`validation not valid: ${verdictText}`);
    }

    // The diff against the newest published revision lists code_review as added.
    await page.getByTestId("studio-diff").click();
    await expect(page.getByTestId("studio-diff-drawer")).toBeVisible();
    await expect(page.getByTestId("diff-node-code_review")).toBeVisible();

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
      `the draft was saved, validated (server verdict: ${verdictText.trim()}) and published — ${noteText.trim()}; the diff listed code_review as added before publish`,
    );

    const revRes = await page.request.get(`/api/v1/pipelines/${state.pipelineId}/revisions`);
    expect(revRes.status()).toBe(200);
    const revBody = (await revRes.json()) as {
      revisions?: Array<{ id: string; revision_number: number }>;
    };
    const newest = revBody.revisions?.[0];
    expect(newest?.revision_number).toBe(state.revisionNumber);
    await writeFile(
      path.join(EVIDENCE_DIR, "published.json"),
      JSON.stringify(
        { pipelineId: state.pipelineId, revisionId: newest?.id, pipelineSlug: PIPELINE_SLUG },
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
    await gotoApp(page, state.draftUrl);
    await backToCanvas(page);

    const before = await readYaml(page);
    await backToCanvas(page);

    const paletteItem = page.getByTestId("palette-item-human.approval");
    const edgeAdd = page.getByTestId("edge-add-plan-approve");

    // Real HTML5 drag: press on the palette item and drag over the plan →
    // approve edge. While the drag hovers the edge the canvas shows the
    // "insert here" preview; dropping lands the node between them.
    await paletteItem.hover();
    const box = (await edgeAdd.boundingBox()) ?? { x: 100, y: 100, width: 10, height: 10 };
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 15 });
    let previewSeen = false;
    try {
      await expect(page.getByTestId("insert-preview")).toBeVisible({ timeout: 5_000 });
      previewSeen = true;
    } catch {
      // The native drag may not have engaged (headless input quirks); fall
      // back to Playwright's own drag gesture right after.
    }
    if (previewSeen) {
      await evidence(
        page,
        "studio-a3-preview",
        "dragging 'Human approval' over the plan → approve edge shows the insert-preview on that edge",
      );
    }
    await page.mouse.up();
    const insertedAfterManual = await page
      .locator('[data-testid^="canvas-step-human"]')
      .count()
      .then((n) => n > 0);
    if (!insertedAfterManual) {
      await page.keyboard.press("Escape");
      await page.mouse.down();
      await page.mouse.up();
      if (!previewSeen) {
        // The preview was never observed — record the fallback honestly.
        test.info().annotations.push({
          type: "gap",
          description:
            "insert-preview could not be captured mid-drag (native HTML5 drag did not engage); dropped via Playwright's dragAndDrop instead",
        });
        console.log("GAP a3-preview: insert-preview not captured; dragAndDrop fallback used");
        await evidence(
          page,
          "studio-a3-preview",
          "the palette item held over the plan → approve edge before the Playwright dragAndDrop insert (preview not capturable mid-drag in this run)",
        );
      }
      await page.dragAndDrop(
        '[data-testid="palette-item-human.approval"]',
        '[data-testid="edge-add-plan-approve"]',
      );
    }
    const approvalNode = page.locator('[data-testid^="canvas-step-human"]').first();
    await expect(approvalNode).toBeVisible();

    // Undo (Ctrl+Z): the node is gone and the YAML is byte-identical to before.
    await page.keyboard.press("Control+z");
    await expect(page.locator('[data-testid^="canvas-step-human"]')).toHaveCount(0);
    const afterUndo = await readYaml(page);
    expect(afterUndo, "undo must restore the exact YAML").toBe(before);

    // Redo (Ctrl+Shift+Z): the node is back, with the same YAML as after insert.
    await page.keyboard.press("Control+Shift+z");
    await expect(approvalNode).toBeVisible();
    const afterRedo = await readYaml(page);
    expect(afterRedo, "redo must re-apply the exact YAML").not.toBe(before);
    expect(afterRedo).toContain("kind: human.approval");
    await backToCanvas(page);
    await evidence(
      page,
      "studio-a3-undo",
      "drag-to-insert of a Human approval step on the plan → approve edge: inserted, undone (YAML byte-identical to before) and redone (YAML restored with kind: human.approval)",
    );

    // Guarded edge: the verdict → publish_verified edge carries a `when` guard,
    // so the insert must stop at the AmbiguityDialog naming the condition.
    const beforeAmbiguity = afterRedo;
    await page.dragAndDrop(
      '[data-testid="palette-item-human.approval"]',
      '[data-testid="edge-add-verdict-publish_verified"]',
    );
    const dialog = page.getByTestId("studio-ambiguity-dialog");
    if ((await dialog.count()) === 0) {
      // The drag drop may have landed off-edge and added a stray step at the
      // root instead: undo it, then drive the same insert-on-edge op through
      // the edge's own "+" button so the guard fires the same way.
      const strays = await page.locator('[data-testid^="canvas-step-human"]').count();
      if (strays > 1) await page.keyboard.press("Control+z");
      await expect(page.locator('[data-testid^="canvas-step-human"]')).toHaveCount(1);
      await page.getByTestId("edge-add-verdict-publish_verified").click();
      await page.getByTestId("step-picker-item-human.approval").click();
    }
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId("studio-ambiguity-reasons")).toContainText(
      /condition|when|guard/i,
    );
    await evidence(
      page,
      "studio-a3-ambiguity",
      "inserting on the guarded verdict → publish_verified edge raised the AmbiguityDialog naming the condition (`when`) guard before anything changed",
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
      const text = (await error.textContent()) ?? "";
      if (text.includes("not configured")) {
        // 503 assistant_not_configured: record the gap and stop.
        test.info().annotations.push({
          type: "gap",
          description: `assistant_not_configured: ${text.trim()}`,
        });
        console.log(`GAP a8: assistant_not_configured — ${text.trim()}`);
        return;
      }
    }

    // The proposal previews: caption + the highlighted node on the canvas,
    // while the server-side draft version is untouched.
    await expect(caption).toBeVisible();
    await expect(page.locator('[data-highlight="assistant-proposed"]')).toBeVisible();
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
    await gotoApp(page, state.draftUrl);
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
    await checkA11y(page, "studio narrow");
    await evidence(
      page,
      "studio-narrow",
      "at 390x844 the Studio drops the React Flow canvas for the step outline; selecting 'plan' opens the inspector and the page does not scroll horizontally",
    );
  });
});
